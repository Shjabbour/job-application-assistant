import type {
  FollowUpAction,
  FollowUpCategory,
  FollowUpEmailCandidate,
  FollowUpPriority,
  Job,
  JobStatus,
} from "./types.js";

type EmailClassification = {
  category: FollowUpCategory;
  priority: FollowUpPriority;
  nextAction: string;
  evidence: string[];
};

type JobMatch = {
  job: Job;
  confidence: number;
};

export type FollowUpReconciliationResult = {
  actions: FollowUpAction[];
  incomingActions: FollowUpAction[];
  createdCount: number;
  updatedCount: number;
  staleApplicationCount: number;
};

export type FollowUpJobUpdate = {
  jobId: string;
  title: string;
  company: string;
  previousStatus: JobStatus;
  nextStatus: JobStatus;
  note: string;
};

export type FollowUpJobUpdateResult = {
  jobs: Job[];
  updates: FollowUpJobUpdate[];
};

const STOPWORDS = new Set([
  "and",
  "are",
  "backend",
  "developer",
  "engineer",
  "full",
  "job",
  "remote",
  "role",
  "senior",
  "software",
  "stack",
  "the",
  "usa",
  "with",
]);

const STATUS_RANK: Record<FollowUpAction["status"], number> = {
  open: 0,
  waiting: 1,
  done: 2,
  closed: 3,
};

const PRIORITY_RANK: Record<FollowUpPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function reconcileFollowUpActions(params: {
  existingActions: FollowUpAction[];
  emails: FollowUpEmailCandidate[];
  jobs: Job[];
  includeStaleApplications?: boolean;
  staleApplicationLimit?: number;
  followUpAfterDays?: number;
  now?: Date;
}): FollowUpReconciliationResult {
  const now = params.now ?? new Date();
  const existingById = new Map(params.existingActions.map((action) => [action.id, action]));
  const incomingEmailActions = params.emails
    .map((email) => buildFollowUpActionFromEmail(email, params.jobs, now))
    .filter((action): action is FollowUpAction => Boolean(action));

  const staleActions = params.includeStaleApplications === false
    ? []
    : buildManualFollowUpsForAppliedJobs(params.jobs, [...params.existingActions, ...incomingEmailActions], {
        limit: params.staleApplicationLimit ?? 12,
        followUpAfterDays: params.followUpAfterDays ?? 7,
        now,
      });

  const incomingActions = [...incomingEmailActions, ...staleActions];
  const mergedById = new Map(params.existingActions.map((action) => [action.id, action]));
  let createdCount = 0;
  let updatedCount = 0;

  for (const incoming of incomingActions) {
    const existing = existingById.get(incoming.id);

    if (!existing) {
      mergedById.set(incoming.id, incoming);
      createdCount += 1;
      continue;
    }

    const merged: FollowUpAction = {
      ...existing,
      ...incoming,
      status: existing.status === "done" || existing.status === "closed" ? existing.status : incoming.status,
      detectedAt: existing.detectedAt || incoming.detectedAt,
      updatedAt: now.toISOString(),
      evidence: dedupeStrings([...existing.evidence, ...incoming.evidence]),
    };

    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
      updatedCount += 1;
    }

    mergedById.set(incoming.id, merged);
  }

  const actions = [...mergedById.values()].sort(sortFollowUpActions);

  return {
    actions,
    incomingActions,
    createdCount,
    updatedCount,
    staleApplicationCount: staleActions.length,
  };
}

export function buildFollowUpActionFromEmail(
  email: FollowUpEmailCandidate,
  jobs: Job[],
  now = new Date(),
): FollowUpAction | null {
  const classification = classifyFollowUpEmail(email);
  const match = matchEmailToJob(email, jobs);

  if (classification.category === "unknown" && (!match || match.confidence < 30)) {
    return null;
  }

  const company = match?.job.company || inferCompanyFromEmail(email) || "Unknown company";
  const jobTitle = match?.job.title || inferRoleFromEmail(email) || "Unknown role";
  const receivedAt = normalizeDateLike(email.receivedAt, now);
  const dueAt = resolveDueAt(classification.category, classification.priority, receivedAt, now);
  const confidence = match?.confidence ?? (classification.category === "unknown" ? 0 : 18);
  const id = buildFollowUpId([
    "email",
    email.accountIndex,
    email.sender,
    email.subject,
    email.receivedAt,
    match?.job.id ?? company,
  ]);

  return {
    id,
    source: "email",
    status: classification.category === "confirmation" || classification.category === "status_update" ? "waiting" : "open",
    category: classification.category,
    priority: classification.priority,
    ...(match?.job.id ? { jobId: match.job.id } : {}),
    jobTitle,
    company,
    sender: cleanText(email.sender) || "Unknown sender",
    subject: cleanText(email.subject) || "No subject",
    snippet: cleanText(email.snippet || email.bodyText || "").slice(0, 700),
    receivedAt: receivedAt.toISOString(),
    detectedAt: email.detectedAt || now.toISOString(),
    updatedAt: now.toISOString(),
    dueAt: dueAt.toISOString(),
    nextAction: classification.nextAction,
    evidence: classification.evidence,
    sourceUrl: email.sourceUrl,
    searchQuery: email.searchQuery,
    confidence,
  };
}

export function classifyFollowUpEmail(email: FollowUpEmailCandidate): EmailClassification {
  const text = normalizeText([email.sender, email.subject, email.snippet, email.bodyText].filter(Boolean).join(" "));
  const evidence: string[] = [];

  const has = (pattern: RegExp, label: string): boolean => {
    if (!pattern.test(text)) {
      return false;
    }
    evidence.push(label);
    return true;
  };

  if (
    has(
      /\b(unfortunately|not selected|not be moving forward|unable to move forward|pursue other candidates|other candidates|position has been filled|role has been filled|no longer under consideration|not proceeding)\b/i,
      "rejection language",
    )
  ) {
    return {
      category: "rejection",
      priority: "low",
      nextAction: "No reply needed. Mark the matching job closed and keep the email as evidence.",
      evidence,
    };
  }

  if (
    has(
      /\b(assessment|coding challenge|code challenge|hackerrank|codility|coderpad|technical exercise|take home|take-home|skills test|complete.*test)\b/i,
      "assessment request",
    )
  ) {
    return {
      category: "assessment",
      priority: "high",
      nextAction: "Complete the assessment or schedule time for it today.",
      evidence,
    };
  }

  if (
    has(
      /\b(interview|phone screen|recruiter screen|technical screen|availability|calendly|schedule|meet with|speak with|intro call|conversation with|next steps call)\b/i,
      "interview or scheduling request",
    )
  ) {
    return {
      category: "interview",
      priority: "high",
      nextAction: "Reply with availability or book the interview slot.",
      evidence,
    };
  }

  if (
    has(
      /\b(action required|complete your application|finish your application|verify your email|confirm your email|email verification|additional information|required information|missing information|log in to|login to|candidate home|candidate portal|task pending|please complete)\b/i,
      "action required language",
    )
  ) {
    return {
      category: "action_required",
      priority: "high",
      nextAction: "Open the employer link and complete the requested application step.",
      evidence,
    };
  }

  if (
    has(
      /\b(recruiter|talent acquisition|sourcer|hiring team|hiring manager|would like to connect|following up|touch base)\b/i,
      "recruiter follow-up language",
    )
  ) {
    return {
      category: "recruiter_reply",
      priority: "medium",
      nextAction: "Review the recruiter message and reply if the role is still relevant.",
      evidence,
    };
  }

  if (
    has(
      /\b(thank you for applying|thanks for applying|application received|we received your application|has been received|successfully submitted|application submitted|submission received)\b/i,
      "application confirmation",
    )
  ) {
    return {
      category: "confirmation",
      priority: "low",
      nextAction: "No immediate action. Wait for a recruiter response, then follow up if there is no movement.",
      evidence,
    };
  }

  if (
    has(
      /\b(under review|under consideration|application status|status update|reviewing your application|in process|still reviewing|next steps)\b/i,
      "application status update",
    )
  ) {
    return {
      category: "status_update",
      priority: "low",
      nextAction: "No immediate action. Keep the status note and wait unless the message asks for a response.",
      evidence,
    };
  }

  return {
    category: "unknown",
    priority: "medium",
    nextAction: "Review this email manually and decide whether the job tracker needs an update.",
    evidence,
  };
}

export function buildManualFollowUpsForAppliedJobs(
  jobs: Job[],
  existingActions: FollowUpAction[],
  options: {
    limit?: number;
    followUpAfterDays?: number;
    now?: Date;
  } = {},
): FollowUpAction[] {
  const now = options.now ?? new Date();
  const limit = Math.max(0, options.limit ?? 12);
  const followUpAfterDays = Math.max(1, options.followUpAfterDays ?? 7);
  const blockedJobIds = new Set(
    existingActions
      .filter((action) => action.jobId && action.status !== "closed" && action.status !== "done")
      .map((action) => action.jobId as string),
  );

  return jobs
    .filter((job) => job.status === "applied" && !blockedJobIds.has(job.id))
    .map((job) => ({ job, appliedAt: extractAppliedAt(job, now) }))
    .filter(({ appliedAt }) => daysBetween(appliedAt, now) >= followUpAfterDays)
    .sort((left, right) => left.appliedAt.getTime() - right.appliedAt.getTime())
    .slice(0, limit)
    .map(({ job, appliedAt }) => {
      const dueAt = addDays(appliedAt, followUpAfterDays);
      return {
        id: buildFollowUpId(["tracker", job.id, "manual-follow-up", appliedAt.toISOString()]),
        source: "tracker" as const,
        status: "open" as const,
        category: "manual_follow_up" as const,
        priority: "medium" as const,
        jobId: job.id,
        jobTitle: cleanText(job.title) || "Unknown role",
        company: cleanText(job.company) || "Unknown company",
        sender: "Local tracker",
        subject: `Manual follow-up due for ${cleanText(job.title) || "application"}`,
        snippet: cleanText(job.notes).slice(0, 700),
        receivedAt: appliedAt.toISOString(),
        detectedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        dueAt: dueAt.toISOString(),
        nextAction: "Send a short follow-up or check the employer portal for status.",
        evidence: [`Applied ${daysBetween(appliedAt, now)} days ago`],
        sourceUrl: job.url,
        confidence: 100,
      };
    });
}

export function applyFollowUpActionsToJobs(
  jobs: Job[],
  actions: FollowUpAction[],
): FollowUpJobUpdateResult {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const updates: FollowUpJobUpdate[] = [];
  const actionable = actions
    .filter((action) => action.jobId && action.source === "email" && action.confidence >= 24)
    .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt));

  for (const action of actionable) {
    const job = jobsById.get(action.jobId as string);
    if (!job) {
      continue;
    }

    const nextStatus = nextStatusForFollowUp(job.status, action.category);
    if (!nextStatus) {
      continue;
    }

    const note = buildFollowUpJobNote(action);
    const currentNotes = job.notes.trim();
    const nextNotes = currentNotes.includes(note)
      ? currentNotes
      : [currentNotes, note].filter(Boolean).join("\n");

    if (job.status === nextStatus && nextNotes === currentNotes) {
      continue;
    }

    updates.push({
      jobId: job.id,
      title: job.title,
      company: job.company,
      previousStatus: job.status,
      nextStatus,
      note,
    });

    jobsById.set(job.id, {
      ...job,
      status: nextStatus,
      notes: nextNotes,
    });
  }

  return {
    jobs: jobs.map((job) => jobsById.get(job.id) ?? job),
    updates,
  };
}

export function sortFollowUpActions(left: FollowUpAction, right: FollowUpAction): number {
  return (
    STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
    PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
    Date.parse(left.dueAt || left.receivedAt) - Date.parse(right.dueAt || right.receivedAt) ||
    Date.parse(right.receivedAt) - Date.parse(left.receivedAt)
  );
}

function nextStatusForFollowUp(currentStatus: JobStatus, category: FollowUpCategory): JobStatus | null {
  if (category === "rejection") {
    return "closed";
  }

  if (currentStatus === "closed") {
    return null;
  }

  if (category === "interview" || category === "assessment" || category === "recruiter_reply") {
    return "interviewing";
  }

  if (category === "action_required") {
    return currentStatus === "interviewing" ? "interviewing" : "blocked";
  }

  if (category === "confirmation" || category === "status_update") {
    return currentStatus === "saved" || currentStatus === "applying" || currentStatus === "blocked"
      ? "applied"
      : null;
  }

  return null;
}

function buildFollowUpJobNote(action: FollowUpAction): string {
  const date = action.receivedAt.slice(0, 10);
  return `Follow-up email on ${date}: ${labelForCategory(action.category)} - ${action.subject}. Next action: ${action.nextAction}`;
}

function matchEmailToJob(email: FollowUpEmailCandidate, jobs: Job[]): JobMatch | null {
  const emailText = normalizeText([email.sender, email.subject, email.snippet, email.bodyText].filter(Boolean).join(" "));
  const senderDomain = normalizeText(extractSenderDomain(email.sender));
  let best: JobMatch | null = null;

  for (const job of jobs) {
    const score = scoreJobMatch(job, emailText, senderDomain);
    if (!best || score > best.confidence) {
      best = { job, confidence: score };
    }
  }

  return best && best.confidence >= 18 ? best : null;
}

function scoreJobMatch(job: Job, emailText: string, senderDomain: string): number {
  let score = 0;
  const company = normalizeText(job.company);
  const companyTokens = significantTokens(job.company).filter((token) => token !== "company" && token !== "unknown");
  const titleTokens = significantTokens(job.title);

  if (company && company !== "unknown company" && emailText.includes(company)) {
    score += 34;
  }

  for (const token of companyTokens) {
    if (emailText.includes(token)) {
      score += 8;
    }
    if (senderDomain.includes(token)) {
      score += 16;
    }
  }

  const matchedTitleTokens = titleTokens.filter((token) => emailText.includes(token));
  if (matchedTitleTokens.length >= 2) {
    score += Math.min(24, matchedTitleTokens.length * 6);
  }

  if (job.status === "applied" || job.status === "interviewing" || job.status === "blocked") {
    score += 6;
  }

  if (companyTokens.length === 0 && matchedTitleTokens.length < 3) {
    score = Math.min(score, 12);
  }

  return Math.min(100, score);
}

function inferCompanyFromEmail(email: FollowUpEmailCandidate): string {
  const sender = cleanText(email.sender);
  const senderName = sender
    .replace(/<[^>]+>/g, "")
    .replace(/\b(no.?reply|noreply|careers?|jobs?|talent|recruiting|notifications?|workday|greenhouse)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (senderName && !/@/.test(senderName)) {
    return senderName;
  }

  const domain = extractSenderDomain(sender);
  const companyToken = domain
    .split(".")
    .filter((part) => !["mail", "email", "greenhouse", "workday", "myworkdayjobs", "linkedin", "oraclecloud"].includes(part))
    .at(0);

  return companyToken ? titleCase(companyToken.replace(/-/g, " ")) : "";
}

function inferRoleFromEmail(email: FollowUpEmailCandidate): string {
  return cleanText(email.subject)
    .replace(/\b(application|status|update|thank you|thanks|received|interview|assessment|action required)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveDueAt(
  category: FollowUpCategory,
  priority: FollowUpPriority,
  receivedAt: Date,
  now: Date,
): Date {
  if (priority === "high") {
    return now;
  }

  if (category === "confirmation" || category === "status_update") {
    return addDays(receivedAt, 7);
  }

  if (priority === "medium") {
    return addDays(now, 1);
  }

  return addDays(now, 7);
}

function extractAppliedAt(job: Job, now: Date): Date {
  const noteMatch = job.notes.match(/\bApplied on\s+([0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9:.+-]+Z?)?)/i);
  if (noteMatch?.[1]) {
    return normalizeDateLike(noteMatch[1], now);
  }

  return normalizeDateLike(job.createdAt, now);
}

function normalizeDateLike(value: string, fallback = new Date()): Date {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return new Date(parsed);
  }

  return fallback;
}

function daysBetween(left: Date, right: Date): number {
  return Math.floor((startOfDay(right).getTime() - startOfDay(left).getTime()) / 86_400_000);
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function buildFollowUpId(parts: Array<string | number | undefined>): string {
  const raw = parts.map((part) => String(part ?? "")).join("|");
  return `follow-up-${hashString(raw)}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function significantTokens(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function extractSenderDomain(sender: string): string {
  const match = sender.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return match?.[1] ?? "";
}

function labelForCategory(category: FollowUpCategory): string {
  return category
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function normalizeText(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9@.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}
