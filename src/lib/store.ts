import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildJobDedupKey,
  canonicalizeJob,
  cleanRepeatedText,
  dedupeJobs,
  normalizeLinkedInJobUrl,
} from "./job-normalization.js";
import type {
  ChatMessage,
  ExtractedJobDraft,
  FollowUpAction,
  FollowUpCategory,
  FollowUpPriority,
  FollowUpSource,
  FollowUpStatus,
  HighPayingCompanyRecord,
  Job,
  JobEvaluationDecision,
  JobEvaluationDecisionRecord,
  JobEvaluationSnapshot,
  Profile,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const dataDir = path.join(repoRoot, "data");

const profilePath = path.join(dataDir, "profile.json");
const jobsPath = path.join(dataDir, "jobs.json");
const conversationPath = path.join(dataDir, "conversation.json");
const highPayingCompaniesPath = path.join(dataDir, "high-paying-companies.json");
const jobEvaluationDecisionsPath = path.join(dataDir, "job-evaluation-decisions.json");
const followUpsPath = path.join(dataDir, "follow-ups.json");

const defaultProfile: Profile = {
  name: "",
  email: "",
  phone: "",
  location: "",
  city: "",
  state: "",
  postalCode: "",
  streetAddress: "",
  addressLine2: "",
  linkedinUrl: "",
  resumeFilePath: "",
  coverLetterFilePath: "",
  resumeTextPath: "",
  resumeSummary: "",
  skills: [],
  targetRoles: [],
  workAuthorization: "",
  yearsOfExperience: "",
};

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  await ensureDataDir();

  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    await writeJsonFile(filePath, fallback);
    return fallback;
  }
}

async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
  await ensureDataDir();
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeJobUrl(url: string): string {
  const trimmed = (url || "").trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.includes("linkedin.com/jobs/view/")) {
    return normalizeLinkedInJobUrl(trimmed);
  }

  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.map((value) => (typeof value === "string" ? cleanRepeatedText(value) : "")).filter(Boolean))];
}

function normalizeFollowUpCategory(value: unknown): FollowUpCategory {
  return [
    "confirmation",
    "status_update",
    "action_required",
    "assessment",
    "interview",
    "recruiter_reply",
    "rejection",
    "manual_follow_up",
    "unknown",
  ].includes(String(value))
    ? (value as FollowUpCategory)
    : "unknown";
}

function normalizeFollowUpStatus(value: unknown): FollowUpStatus {
  return ["open", "waiting", "done", "closed"].includes(String(value))
    ? (value as FollowUpStatus)
    : "open";
}

function normalizeFollowUpPriority(value: unknown): FollowUpPriority {
  return value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function normalizeFollowUpSource(value: unknown): FollowUpSource {
  return value === "tracker" ? "tracker" : "email";
}

function normalizeIsoLikeString(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  return value.trim();
}

function normalizeFollowUpAction(record: FollowUpAction): FollowUpAction {
  const now = new Date().toISOString();
  const source = normalizeFollowUpSource(record.source);
  const category = normalizeFollowUpCategory(record.category);
  const company = cleanRepeatedText(record.company) || "Unknown company";
  const jobTitle = cleanRepeatedText(record.jobTitle) || "Unknown role";
  const subject = cleanRepeatedText(record.subject) || "No subject";
  const receivedAt = normalizeIsoLikeString(record.receivedAt, now);
  const rawId = cleanRepeatedText(record.id);
  const fallbackId = `${source}:${category}:${company}:${jobTitle}:${subject}:${receivedAt}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);

  return {
    id: rawId || fallbackId || `follow-up-${Date.now()}`,
    source,
    status: normalizeFollowUpStatus(record.status),
    category,
    priority: normalizeFollowUpPriority(record.priority),
    ...(typeof record.jobId === "string" && record.jobId.trim() ? { jobId: record.jobId.trim() } : {}),
    jobTitle,
    company,
    sender: cleanRepeatedText(record.sender) || "Unknown sender",
    subject,
    snippet: cleanRepeatedText(record.snippet),
    receivedAt,
    detectedAt: normalizeIsoLikeString(record.detectedAt, now),
    updatedAt: normalizeIsoLikeString(record.updatedAt, now),
    dueAt: normalizeIsoLikeString(record.dueAt, receivedAt),
    nextAction: cleanRepeatedText(record.nextAction) || "Review this follow-up manually.",
    evidence: normalizeStringList(record.evidence),
    ...(typeof record.sourceUrl === "string" && record.sourceUrl.trim()
      ? { sourceUrl: record.sourceUrl.trim() }
      : {}),
    ...(typeof record.searchQuery === "string" && record.searchQuery.trim()
      ? { searchQuery: record.searchQuery.trim() }
      : {}),
    confidence:
      typeof record.confidence === "number" && Number.isFinite(record.confidence)
        ? Math.max(0, Math.min(100, Math.round(record.confidence)))
        : 0,
  };
}

function normalizeJobEvaluationDecision(
  value: unknown,
): JobEvaluationDecision | undefined {
  return value === "saved" || value === "dismissed" || value === "skipped" ? value : undefined;
}

function normalizeJobEvaluationSnapshot(
  value: JobEvaluationSnapshot | null | undefined,
): JobEvaluationSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const normalized: JobEvaluationSnapshot = {
    pass: Boolean(value.pass),
    score: typeof value.score === "number" && Number.isFinite(value.score) ? value.score : 0,
    reasons: normalizeStringList(value.reasons),
    matchedPositiveSignals: normalizeStringList(value.matchedPositiveSignals),
    matchedNegativeSignals: normalizeStringList(value.matchedNegativeSignals),
  };

  const decision = normalizeJobEvaluationDecision(value.decision);
  if (decision) {
    normalized.decision = decision;
  }

  if (typeof value.profileName === "string" && value.profileName.trim()) {
    normalized.profileName = value.profileName.trim();
  }

  if (typeof value.profileSummary === "string" && value.profileSummary.trim()) {
    normalized.profileSummary = value.profileSummary.trim();
  }

  if (typeof value.evaluatedAt === "string" && value.evaluatedAt.trim()) {
    normalized.evaluatedAt = value.evaluatedAt.trim();
  }

  if (typeof value.trackedBy === "string" && value.trackedBy.trim()) {
    normalized.trackedBy = value.trackedBy.trim();
  }

  if (typeof value.alreadySaved === "boolean") {
    normalized.alreadySaved = value.alreadySaved;
  }

  return normalized;
}

function summarizeDescriptionSnippet(value: string): string {
  const normalized = cleanRepeatedText(value).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.length <= 280 ? normalized : `${normalized.slice(0, 279)}...`;
}

function buildJobEvaluationDecisionId(
  normalizedUrl: string,
  title: string,
  company: string,
): string {
  if (normalizedUrl) {
    return normalizedUrl;
  }

  const slug = `${company}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return slug || `decision-${Date.now()}`;
}

function normalizeJobEvaluationDecisionRecord(
  record: JobEvaluationDecisionRecord,
): JobEvaluationDecisionRecord {
  const snapshot = normalizeJobEvaluationSnapshot(record);
  const title = cleanRepeatedText(record.title) || "Untitled role";
  const company = cleanRepeatedText(record.company) || "Unknown company";
  const url = normalizeJobUrl(record.url);
  const normalizedUrl = normalizeJobUrl(record.normalizedUrl || record.url);
  const decision = normalizeJobEvaluationDecision(record.decision) ?? "skipped";

  return {
    id: buildJobEvaluationDecisionId(normalizedUrl || url, title, company),
    title,
    company,
    url: url || normalizedUrl,
    normalizedUrl: normalizedUrl || url,
    source: cleanRepeatedText(record.source) || "unknown",
    descriptionSnippet: summarizeDescriptionSnippet(record.descriptionSnippet),
    decision,
    jobId: typeof record.jobId === "string" && record.jobId.trim() ? record.jobId.trim() : undefined,
    pass: snapshot?.pass ?? decision === "saved",
    score: snapshot?.score ?? 0,
    reasons: snapshot?.reasons ?? [],
    matchedPositiveSignals: snapshot?.matchedPositiveSignals ?? [],
    matchedNegativeSignals: snapshot?.matchedNegativeSignals ?? [],
    profileName: snapshot?.profileName,
    profileSummary: snapshot?.profileSummary,
    evaluatedAt: snapshot?.evaluatedAt || new Date().toISOString(),
    trackedBy: snapshot?.trackedBy,
    alreadySaved: snapshot?.alreadySaved,
  };
}

function buildEvaluationSnapshotFromDecision(
  decision: JobEvaluationDecisionRecord,
): JobEvaluationSnapshot {
  return {
    pass: decision.pass,
    score: decision.score,
    reasons: [...decision.reasons],
    matchedPositiveSignals: [...decision.matchedPositiveSignals],
    matchedNegativeSignals: [...decision.matchedNegativeSignals],
    profileName: decision.profileName,
    profileSummary: decision.profileSummary,
    decision: decision.decision,
    evaluatedAt: decision.evaluatedAt,
    trackedBy: decision.trackedBy,
    alreadySaved: decision.alreadySaved,
  };
}

export async function getProfile(): Promise<Profile> {
  const saved = await readJsonFile<Partial<Profile>>(profilePath, defaultProfile);
  return {
    ...defaultProfile,
    ...saved,
    skills: Array.isArray(saved.skills) ? saved.skills : defaultProfile.skills,
    targetRoles: Array.isArray(saved.targetRoles) ? saved.targetRoles : defaultProfile.targetRoles,
  };
}

export async function saveProfile(profile: Profile): Promise<void> {
  await writeJsonFile(profilePath, profile);
}

export async function getJobs(): Promise<Job[]> {
  const saved = await readJsonFile<Job[]>(jobsPath, []);
  return saved
    .filter((job): job is Job => Boolean(job && typeof job === "object"))
    .map((job) =>
      canonicalizeJob({
        ...job,
        evaluation: normalizeJobEvaluationSnapshot(job.evaluation),
      }),
    );
}

export async function saveJobs(jobs: Job[]): Promise<void> {
  await writeJsonFile(
    jobsPath,
    jobs.map((job) =>
      canonicalizeJob({
        ...job,
        evaluation: normalizeJobEvaluationSnapshot(job.evaluation),
      }),
    ),
  );
}

export async function getJobEvaluationDecisions(): Promise<JobEvaluationDecisionRecord[]> {
  const saved = await readJsonFile<JobEvaluationDecisionRecord[]>(jobEvaluationDecisionsPath, []);
  return saved
    .filter((record): record is JobEvaluationDecisionRecord => Boolean(record && typeof record === "object"))
    .map((record) => normalizeJobEvaluationDecisionRecord(record))
    .sort(
      (left, right) =>
        new Date(right.evaluatedAt || 0).getTime() - new Date(left.evaluatedAt || 0).getTime(),
    );
}

export async function saveJobEvaluationDecisions(
  records: JobEvaluationDecisionRecord[],
): Promise<void> {
  const normalized = records
    .map((record) => normalizeJobEvaluationDecisionRecord(record))
    .sort(
      (left, right) =>
        new Date(right.evaluatedAt || 0).getTime() - new Date(left.evaluatedAt || 0).getTime(),
    );
  await writeJsonFile(jobEvaluationDecisionsPath, normalized);
}

export async function dedupeSavedJobs(): Promise<{
  jobs: Job[];
  removedCount: number;
  mergedGroups: number;
}> {
  const current = await getJobs();
  const result = dedupeJobs(current);
  await saveJobs(result.dedupedJobs);
  return {
    jobs: result.dedupedJobs,
    removedCount: result.removedCount,
    mergedGroups: result.mergedGroups,
  };
}

export async function updateJob(
  jobId: string,
  updates: Partial<Pick<Job, "status" | "notes">>,
): Promise<Job | null> {
  const jobs = await getJobs();
  const index = jobs.findIndex((job) => job.id === jobId);

  if (index < 0) {
    return null;
  }

  const existing = jobs[index];
  const updated: Job = {
    ...existing,
    ...(updates.status ? { status: updates.status } : {}),
    ...(typeof updates.notes === "string"
      ? { notes: updates.notes.replace(/\r\n/g, "\n").trim() }
      : {}),
  };

  jobs[index] = updated;
  await saveJobs(jobs);
  return updated;
}

export async function updateJobEvaluation(
  jobId: string,
  evaluation: JobEvaluationSnapshot,
): Promise<Job | null> {
  const jobs = await getJobs();
  const index = jobs.findIndex((job) => job.id === jobId);

  if (index < 0) {
    return null;
  }

  const normalizedEvaluation = normalizeJobEvaluationSnapshot(evaluation);
  if (!normalizedEvaluation) {
    return jobs[index];
  }

  const updated = canonicalizeJob({
    ...jobs[index],
    evaluation: normalizedEvaluation,
  });

  jobs[index] = updated;
  await saveJobs(jobs);
  return updated;
}

export async function recordJobEvaluationDecision(
  record: JobEvaluationDecisionRecord,
): Promise<JobEvaluationDecisionRecord> {
  const normalizedRecord = normalizeJobEvaluationDecisionRecord(record);
  const decisions = await getJobEvaluationDecisions();
  const index = decisions.findIndex(
    (entry) =>
      entry.normalizedUrl === normalizedRecord.normalizedUrl ||
      (entry.url && entry.url === normalizedRecord.url),
  );

  if (index >= 0) {
    decisions[index] = {
      ...decisions[index],
      ...normalizedRecord,
      reasons: normalizedRecord.reasons,
      matchedPositiveSignals: normalizedRecord.matchedPositiveSignals,
      matchedNegativeSignals: normalizedRecord.matchedNegativeSignals,
    };
  } else {
    decisions.push(normalizedRecord);
  }

  await saveJobEvaluationDecisions(decisions);

  if (normalizedRecord.jobId) {
    await updateJobEvaluation(normalizedRecord.jobId, buildEvaluationSnapshotFromDecision(normalizedRecord));
  }

  return normalizedRecord;
}

export async function addJobFromDraft(draft: ExtractedJobDraft): Promise<Job> {
  const jobs = await getJobs();
  const candidate: Job = canonicalizeJob({
    id: "",
    title: draft.title,
    company: draft.company,
    url: draft.url,
    source: draft.source,
    status: "saved",
    description: draft.description,
    notes: "",
    createdAt: new Date().toISOString(),
  });
  const candidateKey = buildJobDedupKey(candidate);
  const existingIndex = jobs.findIndex((job) => buildJobDedupKey(job) === candidateKey);

  if (existingIndex >= 0) {
    const existing = canonicalizeJob(jobs[existingIndex]);
    const merged: Job = {
      ...existing,
      title: candidate.title || existing.title,
      company:
        candidate.company && candidate.company !== "Unknown company" ? candidate.company : existing.company,
      url: candidate.url.includes("linkedin.com/jobs/view/") ? candidate.url : existing.url,
      source: candidate.source || existing.source,
      description:
        candidate.description.length > existing.description.length
          ? candidate.description
          : existing.description,
    };
    jobs[existingIndex] = merged;
    await saveJobs(jobs);
    return merged;
  }

  const slug = `${candidate.company}-${candidate.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);

  const job: Job = {
    id: `${slug}-${Date.now().toString().slice(-6)}`,
    title: candidate.title,
    company: candidate.company,
    url: candidate.url,
    source: candidate.source,
    status: "saved",
    description: candidate.description,
    notes: "",
    createdAt: new Date().toISOString(),
  };

  jobs.push(job);
  await saveJobs(jobs);
  return job;
}

export async function addJobsFromCollection(
  drafts: Array<{ title: string; company: string; url: string; location: string }>,
): Promise<Job[]> {
  const jobs = await getJobs();
  const existingKeys = new Set(jobs.map((job) => buildJobDedupKey(job)));
  const added: Job[] = [];

  for (const draft of drafts) {
    if (!draft.url) {
      continue;
    }

    const candidate = canonicalizeJob({
      id: "",
      title: draft.title,
      company: draft.company || "Unknown company",
      url: draft.url,
      source: "linkedin.com",
      status: "saved",
      description: "",
      notes: draft.location || "",
      createdAt: new Date().toISOString(),
    });
    const candidateKey = buildJobDedupKey(candidate);
    if (existingKeys.has(candidateKey)) {
      continue;
    }

    const slug = `${candidate.company}-${candidate.title}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 36);

    const job: Job = {
      id: `${slug}-${Date.now().toString().slice(-6)}-${added.length + 1}`,
      title: candidate.title,
      company: candidate.company,
      url: candidate.url,
      source: candidate.source,
      status: "saved",
      description: "",
      notes: candidate.notes,
      createdAt: new Date().toISOString(),
    };

    jobs.push(job);
    added.push(job);
    existingKeys.add(candidateKey);
  }

  await saveJobs(jobs);
  return added;
}

export async function getConversation(): Promise<ChatMessage[]> {
  return readJsonFile(conversationPath, []);
}

export async function appendConversation(message: ChatMessage): Promise<void> {
  const messages = await getConversation();
  messages.push(message);
  await writeJsonFile(conversationPath, messages);
}

export async function getFollowUpActions(): Promise<FollowUpAction[]> {
  const saved = await readJsonFile<FollowUpAction[]>(followUpsPath, []);
  return saved
    .filter((action): action is FollowUpAction => Boolean(action && typeof action === "object"))
    .map((action) => normalizeFollowUpAction(action))
    .sort(
      (left, right) =>
        followUpStatusSort(left.status) - followUpStatusSort(right.status) ||
        followUpPrioritySort(left.priority) - followUpPrioritySort(right.priority) ||
        new Date(left.dueAt || left.receivedAt || 0).getTime() -
          new Date(right.dueAt || right.receivedAt || 0).getTime(),
    );
}

export async function saveFollowUpActions(actions: FollowUpAction[]): Promise<void> {
  const normalized = actions
    .map((action) => normalizeFollowUpAction(action))
    .sort(
      (left, right) =>
        followUpStatusSort(left.status) - followUpStatusSort(right.status) ||
        followUpPrioritySort(left.priority) - followUpPrioritySort(right.priority) ||
        new Date(left.dueAt || left.receivedAt || 0).getTime() -
          new Date(right.dueAt || right.receivedAt || 0).getTime(),
    );
  await writeJsonFile(followUpsPath, normalized);
}

function followUpStatusSort(status: FollowUpStatus): number {
  switch (status) {
    case "open":
      return 0;
    case "waiting":
      return 1;
    case "done":
      return 2;
    case "closed":
      return 3;
  }
}

function followUpPrioritySort(priority: FollowUpPriority): number {
  switch (priority) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
  }
}

export async function getHighPayingCompanies(): Promise<HighPayingCompanyRecord[]> {
  return readJsonFile(highPayingCompaniesPath, []);
}

export async function saveHighPayingCompanies(
  records: HighPayingCompanyRecord[],
): Promise<void> {
  await writeJsonFile(highPayingCompaniesPath, records);
}

export async function recordHighPayingCompany(
  record: HighPayingCompanyRecord,
): Promise<boolean> {
  const records = await getHighPayingCompanies();
  const exists = records.some(
    (entry) =>
      entry.company.toLowerCase() === record.company.toLowerCase() &&
      entry.sourceJobUrl === record.sourceJobUrl,
  );

  if (exists) {
    return false;
  }

  records.push(record);
  await saveHighPayingCompanies(records);
  return true;
}
