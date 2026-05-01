import "./lib/loadEnv.js";
import readline from "node:readline/promises";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { promisify } from "node:util";
import { answerChat, buildApplicationPlan, buildLinkedInDraft } from "./lib/assistant.js";
import {
  APPLICATION_ANSWER_BUCKETS,
  loadApplicationAnswers,
  lookupApplicationAnswer,
  normalizeApplicationAnswerPattern,
  type ApplicationAnswerBucket,
  upsertApplicationAnswer,
} from "./lib/applicationAnswers.js";
import {
  applyAttachedTrackerJob,
  advanceAttachedLinkedInCollectionPage,
  attachedBrowserHasLinkedInPage,
  autoApplyAttachedCurrentForm,
  autoApplyAttachedLinkedInApplication,
  autoApplyLinkedInJobUrlDirect,
  autoApplySiteFormUrl,
  autofillAttachedLinkedInApplication,
  autofillAttachedCurrentForm,
  autofillCurrentSiteForm,
  autofillSiteFormUrl,
  captureAttachedCurrentPage,
  captureAttachedCurrentPageContext,
  captureAttachedCurrentFormPageContext,
  captureCurrentLinkedInDraft,
  captureJobPosting,
  clickAttachedLinkedInPreview,
  collectAttachedLinkedInJobs,
  enrichAttachedJobPostings,
  enrichPersistentJobPostings,
  isAttachedBrowserAvailable,
  openAttachedUrl,
  openAttachedJob,
  processAttachedExternalJob,
  processAttachedExternalJobFromPreview,
  pruneAttachedApplicationTabs,
  getDebugChromeLaunchCommand,
  openBrowser,
  reviewAttachedLinkedInApplication,
  reviewAttachedCurrentForm,
  reviewCurrentSiteForm,
  reviewSiteFormUrl,
  reviewCurrentLinkedInApplication,
  scanAttachedGmailFollowUpEmails,
  screenPersistentLinkedInJobs,
  screenAttachedLinkedInJobs,
  triageAttachedVisibleJobs,
} from "./lib/browser.js";
import { suggestFormAnswer } from "./lib/formAnswers.js";
import {
  applyFollowUpActionsToJobs,
  reconcileFollowUpActions,
  sortFollowUpActions,
} from "./lib/followUps.js";
import {
  evaluateJobAgainstProfile,
  getJobEvaluationProfile,
  jobEvaluationProfilePath,
  summarizeJobEvaluationProfile,
} from "./lib/jobEvaluation.js";
import { formatJobMatchSummary, rankJobsByResume } from "./lib/matching.js";
import {
  applyApplicationAnswersToQuestionBank,
  loadQuestionBank,
  type QuestionBankEntry,
} from "./lib/questionBank.js";
import { ensureDashboardPublicTunnel, ensureDashboardServer } from "./lib/dashboard.js";
import {
  addJobFromDraft,
  addJobsFromCollection,
  appendConversation,
  dedupeSavedJobs,
  getFollowUpActions,
  getJobs,
  recordHighPayingCompany,
  recordJobEvaluationDecision,
  getProfile,
  saveFollowUpActions,
  saveJobs,
  saveProfile,
} from "./lib/store.js";
import type { FollowUpAction, Job, JobCollectionItem, JobEnrichmentResult, Profile } from "./lib/types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function localIsoDate(): string {
  const now = new Date();
  const localTime = now.getTime() - now.getTimezoneOffset() * 60_000;
  return new Date(localTime).toISOString().slice(0, 10);
}

function print(message: string): void {
  output.write(`${message}\n`);
}

const execFileAsync = promisify(execFile);

type AnswerBucket = ApplicationAnswerBucket;
const ANSWER_BUCKETS = [...APPLICATION_ANSWER_BUCKETS];
const DEFAULT_LINKEDIN_COLLECTION_URL = "https://www.linkedin.com/jobs/collections/remote-jobs/";
const DEFAULT_LINKEDIN_TRACKER_URL = "https://www.linkedin.com/jobs-tracker/";

function getLinkedInCollectionUrl(): string {
  return process.env.JAA_LINKEDIN_COLLECTION_URL?.trim() || DEFAULT_LINKEDIN_COLLECTION_URL;
}

function normalizeAnswerKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mapQuestionTypeToAnswerBucket(type: string): AnswerBucket {
  const normalized = type.toLowerCase();
  if (normalized.includes("radio")) {
    return "radio";
  }
  if (normalized.includes("checkbox")) {
    return "checkbox";
  }
  if (normalized.includes("select") || normalized.includes("dropdown") || normalized.includes("combobox")) {
    return "select";
  }
  return "text";
}

function isAnswerBucket(value: string): value is AnswerBucket {
  return ANSWER_BUCKETS.includes(value as AnswerBucket);
}

function summarizeChoices(choices: string[]): string {
  const cleaned = choices.map((choice) => choice.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return "none detected";
  }
  if (cleaned.length <= 8) {
    return cleaned.join(" | ");
  }
  return `${cleaned.slice(0, 8).join(" | ")} | ... (${cleaned.length} choices)`;
}

function sortQuestionBankEntries(left: QuestionBankEntry, right: QuestionBankEntry): number {
  return (
    right.seenCount - left.seenCount ||
    right.lastSeenAt.localeCompare(left.lastSeenAt) ||
    left.label.localeCompare(right.label)
  );
}

async function saveExternalBatchUrls(
  jobs: Array<{
    index: number;
    title: string;
    company?: string;
    sourceUrl: string;
    destinationUrl: string;
    compensationText?: string;
  }>,
): Promise<{ jsonPath: string; textPath: string }> {
  const outputDir = path.join(process.cwd(), "data", "browser");
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const normalized = jobs
    .map((job) => ({
      ...job,
      title: cleanRepeatedText(job.title),
      company: cleanRepeatedText(job.company ?? ""),
      sourceUrl: normalizeLinkedInJobUrl(job.sourceUrl),
      destinationUrl: tidyUrl(job.destinationUrl),
    }))
    .filter((job) => job.sourceUrl && job.destinationUrl);

  const deduped = normalized.filter(
    (job, index, array) =>
      array.findIndex(
        (entry) =>
          entry.sourceUrl === job.sourceUrl || entry.destinationUrl === job.destinationUrl,
      ) === index,
  );

  const jsonPath = path.join(outputDir, `external-apply-urls-${stamp}.json`);
  const textPath = path.join(outputDir, `external-apply-urls-${stamp}.txt`);
  await writeFile(`${jsonPath}`, `${JSON.stringify(deduped, null, 2)}\n`, "utf8");

  const lines = [
    `Employer apply URLs captured on ${new Date().toISOString()}`,
    "",
    ...deduped.flatMap((job, index) => [
      `${index + 1}. ${job.title}`,
      `Company: ${job.company || "Unknown company"}`,
      `LinkedIn URL: ${job.sourceUrl}`,
      `Employer Apply URL: ${job.destinationUrl}`,
      ...(job.compensationText ? [`Compensation: ${job.compensationText}`] : []),
      "",
    ]),
  ];
  await writeFile(textPath, `${lines.join("\n").trimEnd()}\n`, "utf8");
  return { jsonPath, textPath };
}

function normalizeLinkedInJobUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("linkedin.com")) {
      return tidyUrl(url);
    }

    const match = parsed.pathname.match(/\/jobs\/view\/(\d+)/);
    if (!match) {
      return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
    }

    return `${parsed.origin}/jobs/view/${match[1]}/`;
  } catch {
    return tidyUrl(url);
  }
}

function tidyUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function normalizeJobUrlForComparison(url: string): string {
  return url.includes("linkedin.com") ? normalizeLinkedInJobUrl(url) : tidyUrl(url);
}

function isLinkedInJobUrl(url: string): boolean {
  return /https?:\/\/(?:[\w.-]+\.)?linkedin\.com\/jobs\//i.test(url);
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value || "").trim());
}

function shouldDeferApplyStatusWrites(): boolean {
  return isTruthyEnv(process.env.JAA_DEFER_APPLY_STATUS_WRITES);
}

function shouldSkipApplyCapture(): boolean {
  return isTruthyEnv(process.env.JAA_BATCH_APPLY_CHILD);
}

function shouldSkipTrackerApply(): boolean {
  return isTruthyEnv(process.env.JAA_SKIP_TRACKER_APPLY) || isTruthyEnv(process.env.JAA_BATCH_APPLY_CHILD);
}

function shouldIncludeDismissedApplyQueue(): boolean {
  return isTruthyEnv(process.env.JAA_INCLUDE_DISMISSED_APPLY_QUEUE);
}

function shouldApplyScreenedOutJobs(): boolean {
  return isTruthyEnv(process.env.JAA_APPLY_SCREENED_OUT_JOBS) || shouldIncludeDismissedApplyQueue();
}

function shouldAllowNonRemoteApply(): boolean {
  return isTruthyEnv(process.env.JAA_ALLOW_NON_REMOTE_APPLY);
}

function shouldAllowUnenrichedLinkedInApply(): boolean {
  return (
    isTruthyEnv(process.env.JAA_ALLOW_UNENRICHED_LINKEDIN_APPLY) ||
    (shouldSkipTrackerApply() && isTruthyEnv(process.env.JAA_SKIP_AUTO_ENRICH))
  );
}

function isQueuedApplyJob(job: Job): boolean {
  const status = job.status as string;
  return status === "saved" || (shouldIncludeDismissedApplyQueue() && status === "dismissed");
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value || "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveApplyConcurrency(targetCount: number): number {
  const requested = readPositiveInteger(process.env.JAA_APPLY_CONCURRENCY, 3);
  return Math.max(1, Math.min(requested, 6, Math.max(targetCount, 1)));
}

const US_STATE_ABBREVIATION_PATTERN =
  /\b(?:AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/;

function getRemoteApplySignalText(job: Job): string {
  return [job.title, job.company, job.description, job.notes].map((part) => part || "").join("\n");
}

function hasRemoteApplySignal(job: Job): boolean {
  return /\b(?:remote|remote-first|fully remote|work from home|wfh|distributed team)\b|anywhere in (?:the )?(?:u\.?s\.?|united states)/i.test(
    getRemoteApplySignalText(job),
  );
}

function hasExplicitNonRemoteApplySignal(job: Job): boolean {
  return /\b(?:hybrid|onsite|on-site|in office|in-office|commutable|relocate|relocation)\b/i.test(
    getRemoteApplySignalText(job),
  );
}

function noteLooksLikeLocalLinkedInLocation(value: string): boolean {
  const note = cleanRepeatedText(value || "");
  if (!note || note.length > 160) {
    return false;
  }

  if (/\b(?:applied|application|blocked|closed|draft|resume|screening|submitted|required)\b/i.test(note)) {
    return false;
  }

  return /,\s*[A-Z]{2}\b/.test(note) && US_STATE_ABBREVIATION_PATTERN.test(note);
}

function getNonRemoteApplySkipReason(job: Job): string | null {
  if (shouldAllowNonRemoteApply() || hasRemoteApplySignal(job)) {
    return null;
  }

  if (hasExplicitNonRemoteApplySignal(job)) {
    return "not remote";
  }

  if (noteLooksLikeLocalLinkedInLocation(job.notes)) {
    return "location is not remote";
  }

  return null;
}

const STALE_APPLIED_NOTE_PATTERNS = [
  /^apply attempt timed out\.?$/i,
  /^required fields still missing:/i,
  /^reached the linkedin automation step limit/i,
  /^no primary employer-form action was detected after autofill\.?$/i,
  /^tracker apply opened linkedin, but no second apply action reached an external employer site\.?$/i,
];

function mergeAppliedNotes(existingNotes: string, appliedNote?: string): string {
  const cleanedLines = existingNotes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !STALE_APPLIED_NOTE_PATTERNS.some((pattern) => pattern.test(line)));
  const nextNote = appliedNote?.trim();
  if (nextNote && !cleanedLines.includes(nextNote)) {
    cleanedLines.push(nextNote);
  }

  return cleanedLines.join("\n");
}

async function markJobAppliedByUrl(url: string, appliedNote?: string): Promise<boolean> {
  if (shouldDeferApplyStatusWrites()) {
    return false;
  }

  const targetUrl = normalizeJobUrlForComparison(url);
  if (!targetUrl) {
    return false;
  }

  const jobs = await getJobs();
  let changed = false;

  const updatedJobs = jobs.map((job) => {
    if (normalizeJobUrlForComparison(job.url) !== targetUrl) {
      return job;
    }

    const nextNotes = mergeAppliedNotes(job.notes, appliedNote);
    if (job.status === "applied" && nextNotes === job.notes) {
      return job;
    }

    changed = true;
    return {
      ...job,
      status: "applied" as Job["status"],
      notes: nextNotes,
    };
  });

  if (changed) {
    await saveJobs(updatedJobs);
  }

  return changed;
}

async function markJobBlockedByUrl(url: string, note: string): Promise<boolean> {
  if (shouldDeferApplyStatusWrites()) {
    return false;
  }

  const targetUrl = normalizeJobUrlForComparison(url);
  const nextNote = note.trim();
  if (!targetUrl || !nextNote) {
    return false;
  }

  const jobs = await getJobs();
  let changed = false;

  const updatedJobs = jobs.map((job) => {
    if (normalizeJobUrlForComparison(job.url) !== targetUrl) {
      return job;
    }

    const existingNotes = job.notes.trim();
    const mergedNotes = existingNotes.includes(nextNote)
      ? existingNotes
      : [existingNotes, nextNote].filter(Boolean).join("\n");
    if (job.status === "blocked" && mergedNotes === existingNotes) {
      return job;
    }

    changed = true;
    return {
      ...job,
      status: "blocked" as Job["status"],
      notes: mergedNotes,
    };
  });

  if (changed) {
    await saveJobs(updatedJobs);
  }

  return changed;
}

async function closeNonRemoteSavedJobs(candidates: Job[]): Promise<number> {
  if (shouldDeferApplyStatusWrites() || candidates.length === 0) {
    return 0;
  }

  const reasonByUrl = new Map(
    candidates
      .map((job) => {
        const normalizedUrl = normalizeJobUrlForComparison(job.url);
        const reason = getNonRemoteApplySkipReason(job);
        return normalizedUrl && reason ? [normalizedUrl, reason] : null;
      })
      .filter((entry): entry is [string, string] => Boolean(entry)),
  );

  if (reasonByUrl.size === 0) {
    return 0;
  }

  const jobs = await getJobs();
  const closedAt = new Date().toISOString();
  let closedCount = 0;

  const updatedJobs = jobs.map((job) => {
    const normalizedUrl = normalizeJobUrlForComparison(job.url);
    const reason = reasonByUrl.get(normalizedUrl);
    if (!reason || job.status !== "saved") {
      return job;
    }

    const locationNote = noteLooksLikeLocalLinkedInLocation(job.notes)
      ? ` LinkedIn location: ${cleanRepeatedText(job.notes)}.`
      : "";
    const closeNote = `Closed on ${closedAt}: Skipped before applying because ${reason}; this run is remote-only.${locationNote}`;
    const nextNotes = job.notes.includes(closeNote)
      ? job.notes
      : [job.notes.trim(), closeNote].filter(Boolean).join("\n");

    closedCount += 1;
    return {
      ...job,
      status: "closed" as Job["status"],
      notes: nextNotes,
    };
  });

  if (closedCount > 0) {
    await saveJobs(updatedJobs);
  }

  return closedCount;
}

function cleanRepeatedText(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  const half = Math.floor(trimmed.length / 2);
  if (trimmed.length > 8 && trimmed.length % 2 === 0) {
    const first = trimmed.slice(0, half).trim();
    const second = trimmed.slice(half).trim();
    if (first && second && first === second) {
      return first;
    }
  }
  return trimmed;
}

function normalizeMatchText(value: string): string {
  return cleanRepeatedText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMeaningfulTextOverlap(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 12 && longer.includes(shorter);
}

type AttachedPageContext = {
  url: string;
  title: string;
  headings: string[];
  bodyText?: string;
  siteKind: string;
};

function scoreJobAgainstAttachedContext(job: Job, context: AttachedPageContext): number {
  const normalizedTitle = normalizeMatchText(job.title);
  if (!normalizedTitle || normalizedTitle === "untitled role") {
    return 0;
  }

  const contextTexts = [context.title, ...context.headings, context.bodyText ?? ""]
    .map(normalizeMatchText)
    .filter(Boolean);
  let score = 0;

  if (contextTexts.some((text) => text === normalizedTitle)) {
    score = 180;
  } else if (contextTexts.some((text) => hasMeaningfulTextOverlap(text, normalizedTitle))) {
    score = 140;
  } else {
    return 0;
  }

  const normalizedCompany = normalizeMatchText(job.company);
  const inferredCompany = normalizeMatchText(inferCompanyName(undefined, context.url, context.title));
  if (normalizedCompany && normalizedCompany !== "unknown company") {
    if (inferredCompany && inferredCompany === normalizedCompany) {
      score += 40;
    } else if (contextTexts.some((text) => hasMeaningfulTextOverlap(text, normalizedCompany))) {
      score += 25;
    }
  }

  if (context.siteKind === "workday" && /workdayjobs\.com/i.test(context.url) && inferredCompany) {
    score += 5;
  }

  return score;
}

async function markLikelyAppliedJobFromAttachedContext(
  context: AttachedPageContext,
  appliedNote?: string,
): Promise<Job | null> {
  const jobs = await getJobs();
  const scored = jobs
    .filter((job) => job.status !== "applied" && job.status !== "closed")
    .map((job) => ({
      job,
      score: scoreJobAgainstAttachedContext(job, context),
    }))
    .filter((entry) => entry.score >= 140)
    .sort(
      (left, right) =>
        right.score - left.score ||
        new Date(right.job.createdAt).getTime() - new Date(left.job.createdAt).getTime(),
    );

  if (scored.length === 0) {
    return null;
  }

  if (scored[1] && scored[1].score === scored[0].score) {
    return null;
  }

  const target = scored[0].job;
  const changed = await markJobAppliedByUrl(target.url, appliedNote);
  if (!changed) {
    return null;
  }

  const updatedJobs = await getJobs();
  return (
    updatedJobs.find(
      (job) => normalizeJobUrlForComparison(job.url) === normalizeJobUrlForComparison(target.url),
    ) ?? {
      ...target,
      status: "applied" as Job["status"],
      notes: mergeAppliedNotes(target.notes, appliedNote),
    }
  );
}

type ExternalUrlArtifact = {
  sourceJobUrl: string;
  sourceJobTitle: string;
  sourceCompany?: string;
  compensationText?: string;
  destinationUrl: string;
  destinationTitle?: string;
  externalApplyFound: boolean;
  workloadScreening?: {
    pass: boolean;
    score: number;
    reasons: string[];
    matchedPositiveSignals: string[];
    matchedNegativeSignals: string[];
  };
};

function inferCompanyName(company: string | undefined, destinationUrl: string, destinationTitle?: string): string {
  const cleaned = cleanRepeatedText(company ?? "");
  if (cleaned) {
    return cleaned;
  }

  const title = cleanRepeatedText(destinationTitle ?? "");
  const titleMatch =
    title.match(/\bat\s+([A-Z][\w&.\- ]+)$/i) ||
    title.match(/^([A-Z][\w&.\- ]+)\s+-\s+/);
  if (titleMatch?.[1]) {
    return cleanRepeatedText(titleMatch[1]);
  }

  try {
    const parsed = new URL(destinationUrl);
    const host = parsed.hostname.replace(/^www\./, "");
    const greenhouse = host.match(/^job-boards\.greenhouse\.io$/i);
    if (greenhouse) {
      const segment = parsed.pathname.split("/").filter(Boolean)[0];
      if (segment) {
        return segment.charAt(0).toUpperCase() + segment.slice(1);
      }
    }

    const lever = host.match(/^jobs\.lever\.co$/i);
    if (lever) {
      const segment = parsed.pathname.split("/").filter(Boolean)[0];
      if (segment) {
        return segment.charAt(0).toUpperCase() + segment.slice(1);
      }
    }

    const root = host.split(".")[0];
    if (root) {
      return root.charAt(0).toUpperCase() + root.slice(1);
    }
  } catch {
    return "";
  }

  return "";
}

async function exportExternalApplyUrlsFromArtifacts(): Promise<void> {
  const browserDir = path.join(process.cwd(), "data", "browser");
  const entries = await readdir(browserDir).catch(() => []);
  const previewFiles = entries
    .filter((name) => name.startsWith("external-apply-preview-result-") && name.endsWith(".json"))
    .sort();

  if (previewFiles.length === 0) {
    print("No external apply preview artifacts were found.");
    return;
  }

  const collected: Array<{
    index: number;
    title: string;
    company?: string;
    sourceUrl: string;
    destinationUrl: string;
    compensationText?: string;
  }> = [];
  const filteredOut: Array<{ title: string; company: string; reasons: string[]; score: number }> = [];

  for (const [index, fileName] of previewFiles.entries()) {
    const fullPath = path.join(browserDir, fileName);
    const raw = await readFile(fullPath, "utf8").catch(() => "");
    if (!raw) continue;

    const parsed = JSON.parse(raw) as ExternalUrlArtifact;
    if (!parsed.externalApplyFound) continue;
    const company = inferCompanyName(parsed.sourceCompany, parsed.destinationUrl, parsed.destinationTitle);
    if (parsed.workloadScreening && !parsed.workloadScreening.pass) {
      filteredOut.push({
        title: parsed.sourceJobTitle,
        company,
        reasons: parsed.workloadScreening.reasons,
        score: parsed.workloadScreening.score,
      });
      continue;
    }

    collected.push({
      index: index + 1,
      title: parsed.sourceJobTitle,
      company,
      sourceUrl: parsed.sourceJobUrl,
      destinationUrl: parsed.destinationUrl,
      compensationText: parsed.compensationText,
    });
  }

  if (collected.length === 0) {
    print("No external employer URLs were found in saved preview artifacts.");
    return;
  }

  const paths = await saveExternalBatchUrls(collected);
  print(`Saved employer URLs JSON: ${paths.jsonPath}`);
  print(`Saved employer URLs TXT: ${paths.textPath}`);
  if (filteredOut.length > 0) {
    print(`Filtered out ${filteredOut.length} higher-overhead roles based on workload signals.`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCliSelfExecution(args: string[]): {
  command: string;
  args: string[];
  commandPreview: string;
} {
  const compiledEntry = path.join(process.cwd(), "dist", "index.js");
  if (existsSync(compiledEntry)) {
    return {
      command: process.execPath,
      args: [compiledEntry, ...args],
      commandPreview: `${path.basename(process.execPath)} dist/index.js ${args.join(" ")}`.trim(),
    };
  }

  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  return {
    command: process.execPath,
    args: [tsxCli, path.join(process.cwd(), "src", "index.ts"), ...args],
    commandPreview: `${path.basename(process.execPath)} node_modules/tsx/dist/cli.mjs src/index.ts ${args.join(" ")}`.trim(),
  };
}

function printChildOutput(stdout: string, stderr: string): void {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) {
      print(trimmed);
    }
  }

  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) {
      print(`ERR: ${trimmed}`);
    }
  }
}

function isLinkedInAuthErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("linkedin redirected to login") ||
    normalized.includes("authwall") ||
    normalized.includes("checkpoint challenge") ||
    normalized.includes("/checkpoint")
  );
}

function isTransientBrowserConnectionError(message: string): boolean {
  return /connectOverCDP|Detached from attached Chrome CDP session|browser has been closed|target page, context or browser has been closed/i.test(
    message,
  );
}

async function killLingeringApplySubprocess(targetUrl: string): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }

  const jobId = normalizeJobUrlForComparison(targetUrl).match(/\/jobs\/view\/(\d+)\//)?.[1];
  if (!jobId) {
    return;
  }

  const script = [
    `$jobId = '${jobId}'`,
    "$targets = Get-CimInstance Win32_Process | Where-Object {",
    "  $_.CommandLine -match [regex]::Escape($jobId) -and",
    "  $_.CommandLine -match 'browser apply-job-url'",
    "}",
    "$targets | ForEach-Object {",
    "  taskkill.exe /PID $_.ProcessId /T /F | Out-Null",
    "}",
  ].join("; ");

  await execFileAsync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd: process.cwd(),
    timeout: 10_000,
    maxBuffer: 128 * 1024,
  }).catch(() => undefined);
}

function buildJobId(title: string, company: string): string {
  const slug = `${company}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);

  return `${slug}-${Date.now().toString().slice(-6)}`;
}

function findJob(jobs: Job[], id: string): Job | undefined {
  return jobs.find((job) => job.id === id);
}

function needsJobEnrichment(job: Job): boolean {
  const title = cleanRepeatedText(job.title);
  const company = cleanRepeatedText(job.company);
  return (
    !job.description.trim() ||
    !company ||
    company === "Unknown company" ||
    title === "Untitled role" ||
    title !== job.title
  );
}

function getApplyPriority(job: Job): number {
  const title = cleanRepeatedText(job.title);
  const company = cleanRepeatedText(job.company);
  const descriptionLength = job.description.trim().length;

  let score = 0;
  if (title && title !== "Untitled role") {
    score += 100;
  }
  if (company && company !== "Unknown company") {
    score += 90;
  }
  if (descriptionLength >= 400) {
    score += 60;
  } else if (descriptionLength >= 120) {
    score += 30;
  }
  if (job.evaluation?.pass) {
    score += 25;
  }
  if (job.url.includes("linkedin.com/jobs/view/")) {
    score += 10;
  }

  return score;
}

function getPrioritizedSavedJobs(jobs: Job[], visibleTrackerUrls: Set<string>): Job[] {
  const sorted = [...jobs].sort((left, right) => {
    const priorityDelta = getApplyPriority(right) - getApplyPriority(left);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });

  const prioritized = [
    ...sorted.filter((job) => visibleTrackerUrls.has(normalizeJobUrlForComparison(job.url))),
    ...sorted.filter((job) => !visibleTrackerUrls.has(normalizeJobUrlForComparison(job.url))),
  ];
  const seenUrls = new Set<string>();

  return prioritized.filter((job) => {
    const normalizedUrl = normalizeJobUrlForComparison(job.url);
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
      return false;
    }

    seenUrls.add(normalizedUrl);
    return true;
  });
}

function getSavedJobSkipReason(job: Job, visibleTrackerUrls = new Set<string>()): string | null {
  const normalizedUrl = normalizeJobUrlForComparison(job.url);
  const visibleInTracker = visibleTrackerUrls.has(normalizedUrl);
  const title = cleanRepeatedText(job.title);
  const company = cleanRepeatedText(job.company);
  const descriptionLength = job.description.trim().length;

  if (!normalizedUrl) {
    return "missing URL";
  }

  if (/example\.com/i.test(normalizedUrl) || /^example domain$/i.test(title)) {
    return "placeholder entry";
  }

  if (job.evaluation && job.evaluation.pass === false && !shouldApplyScreenedOutJobs()) {
    return "screened out";
  }

  const nonRemoteReason = getNonRemoteApplySkipReason(job);
  if (nonRemoteReason) {
    return nonRemoteReason;
  }

  if (title === "Untitled role" && !visibleInTracker) {
    return "missing title";
  }

  if (
    job.url.includes("linkedin.com/jobs/view/") &&
    needsJobEnrichment(job) &&
    !visibleInTracker &&
    !shouldAllowUnenrichedLinkedInApply()
  ) {
    return "needs enrichment";
  }

  if (company === "Unknown company" && descriptionLength < 120 && !visibleInTracker) {
    return "missing company/details";
  }

  return null;
}

function summarizeSkipReasons(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([reason, count]) => `${count} ${reason}`)
    .join(", ");
}

async function applyJobEnrichmentResults(results: JobEnrichmentResult[]): Promise<{
  successfulCount: number;
  updatedCount: number;
  failed: JobEnrichmentResult[];
  dedupeRemovedCount: number;
  dedupeMergedGroups: number;
}> {
  const jobs = await getJobs();
  const successful = results.filter((result) => result.success && result.draft);
  const draftByUrl = new Map(successful.map((result) => [result.normalizedUrl, result.draft!]));
  let updatedCount = 0;

  const updatedJobs = jobs.map((job) => {
    const normalizedUrl = normalizeLinkedInJobUrl(job.url);
    const draft = draftByUrl.get(normalizedUrl);
    if (!draft) {
      return job;
    }

    const nextTitle = cleanRepeatedText(draft.title) || job.title;
    const nextCompany =
      cleanRepeatedText(draft.company) === "Unknown company" && job.company.trim()
        ? job.company
        : cleanRepeatedText(draft.company) || job.company;
    const nextDescription =
      draft.description.trim().length >= job.description.trim().length
        ? draft.description.trim()
        : job.description;
    const nextUrl = normalizeLinkedInJobUrl(draft.url || job.url);
    const nextJob: Job = {
      ...job,
      title: nextTitle,
      company: nextCompany,
      description: nextDescription,
      source: draft.source || job.source,
      url: nextUrl,
    };

    if (
      nextJob.title !== job.title ||
      nextJob.company !== job.company ||
      nextJob.description !== job.description ||
      nextJob.source !== job.source ||
      nextJob.url !== job.url
    ) {
      updatedCount += 1;
      return nextJob;
    }

    return job;
  });

  let dedupeRemovedCount = 0;
  let dedupeMergedGroups = 0;

  if (updatedCount > 0) {
    await saveJobs(updatedJobs);
    const dedupeResult = await dedupeSavedJobs();
    dedupeRemovedCount = dedupeResult.removedCount;
    dedupeMergedGroups = dedupeResult.mergedGroups;
  }

  return {
    successfulCount: successful.length,
    updatedCount,
    failed: results.filter((result) => !result.success),
    dedupeRemovedCount,
    dedupeMergedGroups,
  };
}

async function enrichSavedLinkedInJobsBeforeApply(
  jobs: Job[],
  visibleTrackerUrls: Set<string>,
  batchLimit: number,
): Promise<{
  attempted: number;
  successfulCount: number;
  updatedCount: number;
  failedCount: number;
  dedupeRemovedCount: number;
  dedupeMergedGroups: number;
}> {
  const candidates = getPrioritizedSavedJobs(
    jobs.filter((job) => job.status === "saved" && job.url.includes("linkedin.com/jobs/view/") && needsJobEnrichment(job)),
    visibleTrackerUrls,
  );
  const enrichmentLimit = Math.min(
    candidates.length,
    Math.max(batchLimit * 2, visibleTrackerUrls.size, 8),
  );
  const targetUrls = candidates.slice(0, enrichmentLimit).map((job) => normalizeLinkedInJobUrl(job.url));

  if (targetUrls.length === 0) {
    return {
      attempted: 0,
      successfulCount: 0,
      updatedCount: 0,
      failedCount: 0,
      dedupeRemovedCount: 0,
      dedupeMergedGroups: 0,
    };
  }

  const results = await enrichAttachedJobPostings(targetUrls);
  const applied = await applyJobEnrichmentResults(results);
  return {
    attempted: targetUrls.length,
    successfulCount: applied.successfulCount,
    updatedCount: applied.updatedCount,
    failedCount: applied.failed.length,
    dedupeRemovedCount: applied.dedupeRemovedCount,
    dedupeMergedGroups: applied.dedupeMergedGroups,
  };
}

async function askList(rl: readline.Interface, label: string): Promise<string[]> {
  const answer = (await rl.question(`${label} (comma separated): `)).trim();
  return answer
    .split(",")
    .map((item: string) => item.trim())
    .filter(Boolean);
}

async function editProfile(rl: readline.Interface): Promise<void> {
  const current = await getProfile();
  const nextSkills = await askList(rl, `Skills [${current.skills.join(", ")}]`);
  const nextTargetRoles = await askList(rl, `Target roles [${current.targetRoles.join(", ")}]`);

  const profile: Profile = {
    name: (await rl.question(`Name [${current.name}]: `)).trim() || current.name,
    email: (await rl.question(`Email [${current.email}]: `)).trim() || current.email,
    phone: (await rl.question(`Phone [${current.phone}]: `)).trim() || current.phone,
    location: (await rl.question(`Location [${current.location}]: `)).trim() || current.location,
    city: (await rl.question(`City [${current.city}]: `)).trim() || current.city,
    state: (await rl.question(`State [${current.state}]: `)).trim() || current.state,
    postalCode:
      (await rl.question(`Postal code [${current.postalCode}]: `)).trim() || current.postalCode,
    streetAddress:
      (await rl.question(`Street address [${current.streetAddress}]: `)).trim() ||
      current.streetAddress,
    addressLine2:
      (await rl.question(`Address line 2 [${current.addressLine2}]: `)).trim() ||
      current.addressLine2,
    linkedinUrl:
      (await rl.question(`LinkedIn URL [${current.linkedinUrl}]: `)).trim() || current.linkedinUrl,
    resumeFilePath:
      (await rl.question(`Resume file path [${current.resumeFilePath}]: `)).trim() ||
      current.resumeFilePath,
    coverLetterFilePath:
      (await rl.question(`Cover letter path [${current.coverLetterFilePath}]: `)).trim() ||
      current.coverLetterFilePath,
    resumeTextPath:
      (await rl.question(`Resume text path [${current.resumeTextPath}]: `)).trim() ||
      current.resumeTextPath,
    resumeSummary:
      (await rl.question(`Resume summary [${current.resumeSummary}]: `)).trim() ||
      current.resumeSummary,
    skills: nextSkills.length > 0 ? nextSkills : current.skills,
    targetRoles: nextTargetRoles.length > 0 ? nextTargetRoles : current.targetRoles,
    workAuthorization:
      (await rl.question(`Work authorization [${current.workAuthorization}]: `)).trim() ||
      current.workAuthorization,
    yearsOfExperience:
      (await rl.question(`Years of experience [${current.yearsOfExperience}]: `)).trim() ||
      current.yearsOfExperience,
  };

  await saveProfile(profile);
  print("Profile saved.");
}

async function addJob(rl: readline.Interface): Promise<void> {
  const jobs = await getJobs();

  const title = (await rl.question("Job title: ")).trim();
  const company = (await rl.question("Company: ")).trim();
  const url = (await rl.question("Job URL: ")).trim();
  const source = (await rl.question("Source [LinkedIn]: ")).trim() || "LinkedIn";
  const status = ((await rl.question("Status [saved]: ")).trim() || "saved") as Job["status"];
  const description = (await rl.question("Paste a short job description: ")).trim();
  const notes = (await rl.question("Notes: ")).trim();

  const job: Job = {
    id: buildJobId(title, company),
    title,
    company,
    url,
    source,
    status,
    description,
    notes,
    createdAt: nowIso(),
  };

  jobs.push(job);
  await saveJobs(jobs);
  print(`Saved job ${job.id}`);
}

async function listJobs(): Promise<void> {
  const jobs = await getJobs();

  if (jobs.length === 0) {
    print("No saved jobs.");
    return;
  }

  for (const job of jobs) {
    print(`${job.id} | ${job.status} | ${job.title} @ ${job.company}`);
  }
}

async function viewJob(id: string): Promise<void> {
  const jobs = await getJobs();
  const profile = await getProfile();
  const job = findJob(jobs, id);

  if (!job) {
    print(`Job not found: ${id}`);
    return;
  }

  print(await formatJobMatchSummary(profile, job));
}

async function rankJobs(limitArg?: string): Promise<void> {
  const jobs = await getJobs();
  const profile = await getProfile();

  if (jobs.length === 0) {
    print("No saved jobs.");
    return;
  }

  const parsedLimit = Number(limitArg || "10");
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 10;
  const ranked = await rankJobsByResume(profile, jobs, limit);

  for (const [index, match] of ranked.entries()) {
    print(
      [
        `${index + 1}. ${match.score}/100 | ${match.job.id}`,
        `${match.job.title} @ ${match.job.company || "Unknown company"}`,
        `Matched roles: ${match.matchedRoles.join(", ") || "none"}`,
        `Matched skills: ${match.matchedSkills.join(", ") || "none"}`,
        `Matched terms: ${match.matchedTerms.join(", ") || "none"}`,
        ...match.notes.map((note) => `Note: ${note}`),
      ].join("\n"),
    );
  }
}

async function jobMatch(id: string): Promise<void> {
  await viewJob(id);
}

async function jobDedupe(): Promise<void> {
  const result = await dedupeSavedJobs();
  print(`Deduped jobs: removed ${result.removedCount} duplicates across ${result.mergedGroups} groups.`);
  print(`Saved jobs remaining: ${result.jobs.length}`);
}

async function jobPlan(id: string): Promise<void> {
  const jobs = await getJobs();
  const profile = await getProfile();
  const job = findJob(jobs, id);

  if (!job) {
    print(`Job not found: ${id}`);
    return;
  }

  print(buildApplicationPlan(profile, job));
}

async function jobLinkedIn(id: string): Promise<void> {
  const jobs = await getJobs();
  const profile = await getProfile();
  const job = findJob(jobs, id);

  if (!job) {
    print(`Job not found: ${id}`);
    return;
  }

  print(buildLinkedInDraft(profile, job));
}

async function browserOpen(url: string): Promise<void> {
  await openBrowser(url, true);
}

async function browserCapture(url: string): Promise<void> {
  const draft = await captureJobPosting(url, false);
  const job = await addJobFromDraft(draft);
  print(`Saved ${job.id} | ${job.title} @ ${job.company}`);
}

async function browserCaptureLinkedInCurrent(): Promise<void> {
  const draft = await captureCurrentLinkedInDraft(true);
  const job = await addJobFromDraft(draft);
  print(`Saved ${job.id} | ${job.title} @ ${job.company}`);
}

async function browserReviewLinkedInCurrent(): Promise<void> {
  const review = await reviewCurrentLinkedInApplication(true);
  print(
    [
      `Title: ${review.title}`,
      `Company: ${review.company}`,
      `URL: ${review.url}`,
      `Easy Apply: ${review.hasEasyApply ? "yes" : "no"}`,
      `Stage: ${review.stage}`,
      `Primary action: ${review.primaryAction}`,
      `Fields detected: ${review.fields.length}`,
      ...review.fields.map(
        (field, index) =>
          `${index + 1}. ${field.label} | ${field.type} | ${field.required ? "required" : "optional"}`,
      ),
      ...review.notes.map((note) => `Note: ${note}`),
    ].join("\n"),
  );
}

async function browserReviewLinkedInAttached(): Promise<void> {
  const review = await reviewAttachedLinkedInApplication();
  print(
    [
      `Title: ${review.title}`,
      `Company: ${review.company}`,
      `URL: ${review.url}`,
      `Easy Apply: ${review.hasEasyApply ? "yes" : "no"}`,
      `Stage: ${review.stage}`,
      `Primary action: ${review.primaryAction}`,
      `Fields detected: ${review.fields.length}`,
      ...review.fields.map(
        (field, index) =>
          `${index + 1}. ${field.label} | ${field.type} | ${field.required ? "required" : "optional"}`,
      ),
      ...review.notes.map((note) => `Note: ${note}`),
    ].join("\n"),
  );
}

async function browserCaptureAttachedCurrent(): Promise<void> {
  const draft = await captureAttachedCurrentPage();
  const job = await addJobFromDraft(draft);
  print(`Saved ${job.id} | ${job.title} @ ${job.company}`);
}

async function browserCollectAttachedJobs(): Promise<void> {
  const jobs = await collectAttachedLinkedInJobs();
  if (jobs.length === 0) {
    print("No visible LinkedIn job cards were collected from the current page.");
    return;
  }

  for (const [index, job] of jobs.entries()) {
    print(`${index + 1}. ${job.title} | ${job.company} | ${job.location} | ${job.url}`);
  }
}

function printAutofillResult(result: {
  filled: string[];
  skipped: string[];
  nextAction: string;
  stoppedBeforeSubmit: boolean;
  submitted?: boolean;
  stopReason?: string;
  debugSteps?: Array<{
    step: number;
    url: string;
    stage: string;
    nextAction: string;
    fieldCount: number;
    fieldPreview: string[];
  }>;
}): void {
  const lines = [
    `Filled: ${result.filled.join(", ") || "none"}`,
    `Skipped: ${result.skipped.join(", ") || "none"}`,
    `Next action: ${result.nextAction}`,
    `Stopped before submit: ${result.stoppedBeforeSubmit ? "yes" : "no"}`,
  ];

  if (typeof result.submitted === "boolean") {
    lines.push(`Submitted: ${result.submitted ? "yes" : "no"}`);
  }
  if (result.stopReason) {
    lines.push(`Reason: ${result.stopReason}`);
  }
  if (result.debugSteps?.length) {
    lines.push("Debug steps:");
    for (const step of result.debugSteps) {
      lines.push(
        `  ${step.step}. ${step.stage} | ${step.nextAction} | fields=${step.fieldCount} | ${step.url}`,
      );
      if (step.fieldPreview.length) {
        lines.push(`     ${step.fieldPreview.join(", ")}`);
      }
    }
  }

  print(lines.join("\n"));
}

async function browserAutofillAttached(): Promise<void> {
  const profile = await getProfile();
  const result = await autofillAttachedLinkedInApplication(profile);
  printAutofillResult(result);
}

async function browserAutoApplyAttached(): Promise<void> {
  const profile = await getProfile();
  const result = await autoApplyAttachedLinkedInApplication(profile);
  printAutofillResult(result);
}

async function tryLinkedInDirectJobApply(targetUrl: string, profile: Profile, intro?: string): Promise<boolean> {
  if (intro) {
    print(intro);
  }

  const linkedInDirect = await autoApplyLinkedInJobUrlDirect(targetUrl, profile).catch((error) => {
    print(`LinkedIn direct apply failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return null;
  });
  if (!linkedInDirect) {
    print("LinkedIn direct apply did not produce an Easy Apply or external employer result.");
    return false;
  }

  print(`Easy Apply: ${linkedInDirect.review.hasEasyApply ? "yes" : "no"} | Action: ${linkedInDirect.review.primaryAction}`);
  if (linkedInDirect.autofill) {
    printAutofillResult(linkedInDirect.autofill);
    if (linkedInDirect.autofill.submitted) {
      await markJobAppliedByUrl(targetUrl).catch(() => undefined);
    }
    return true;
  }

  if (linkedInDirect.external) {
    const { external } = linkedInDirect;
    print(`External apply found: ${external.externalApplyFound ? "yes" : "no"}`);
    print(`Destination: ${external.destinationUrl}`);
    if (external.review) {
      print(`Site: ${external.review.siteKind}`);
      print(`Stage: ${external.review.stage}`);
      print(`Primary action: ${external.review.primaryAction}`);
    }
    if (external.autofill) {
      printAutofillResult(external.autofill);
      if (external.autofill.submitted) {
        await markJobAppliedByUrl(targetUrl).catch(() => undefined);
      }
    }
    for (const note of external.notes) {
      print(`Note: ${note}`);
    }
    return true;
  }

  print("LinkedIn direct apply did not produce an Easy Apply or external employer result.");
  return false;
}

async function browserApplyJobUrl(url: string): Promise<void> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error("Usage: npm run cli -- browser apply-job-url <url>");
  }
  const targetUrl = normalizeJobUrlForComparison(trimmedUrl);
  const profile = await getProfile();

  if (!isLinkedInJobUrl(targetUrl)) {
    print("Direct employer URL detected. Starting employer-site apply.");
    const result = await autoApplySiteFormUrl(targetUrl, profile);
    printAutofillResult(result);
    if (result.submitted) {
      await markJobAppliedByUrl(targetUrl).catch(() => undefined);
    }
    return;
  }

  if (!(await isAttachedBrowserAvailable())) {
    throw new Error(
      "Attached browser not detected. Start it with: powershell -ExecutionPolicy Bypass -File .\\start-debug-chrome.ps1",
    );
  }

  if (!/^(1|true|yes)$/i.test(process.env.JAA_SKIP_ATTACHED_TAB_PRUNE || "")) {
    const closedTabs = await pruneAttachedApplicationTabs({
      keepUrls: [targetUrl, DEFAULT_LINKEDIN_TRACKER_URL],
    }).catch((error) => {
      print(`Attached tab cleanup skipped: ${getErrorMessage(error)}`);
      return 0;
    });
    if (closedTabs > 0) {
      print(`Closed ${closedTabs} stale attached browser tab${closedTabs === 1 ? "" : "s"} before applying.`);
    }
  }

  const trackerResult = isLinkedInJobUrl(targetUrl) && !shouldSkipTrackerApply()
    ? await applyAttachedTrackerJob(targetUrl, profile, {
        submit: true,
        startUrl: DEFAULT_LINKEDIN_TRACKER_URL,
      }).catch((error) => {
        const message = error instanceof Error ? error.message : "unknown error";
        if (isLinkedInAuthErrorMessage(message)) {
          throw error;
        }

        print(`Jobs Tracker flow failed: ${message}`);
        return null;
      })
    : null;

  if (trackerResult) {
    print(`Jobs Tracker action: ${trackerResult.trackerAction}`);
    print(`Landing URL: ${trackerResult.firstLandingUrl}`);

    if (trackerResult.linkedInAutofill) {
      printAutofillResult(trackerResult.linkedInAutofill);
      if (trackerResult.linkedInAutofill.submitted) {
        await markJobAppliedByUrl(targetUrl).catch(() => undefined);
      }
    }

    if (trackerResult.externalResult) {
      print(`External apply found: ${trackerResult.externalResult.externalApplyFound ? "yes" : "no"}`);
      print(`Destination: ${trackerResult.externalResult.destinationUrl}`);
      if (trackerResult.externalResult.review) {
        print(`Site: ${trackerResult.externalResult.review.siteKind}`);
        print(`Stage: ${trackerResult.externalResult.review.stage}`);
        print(`Primary action: ${trackerResult.externalResult.review.primaryAction}`);
      }
      if (trackerResult.externalResult.autofill) {
        printAutofillResult(trackerResult.externalResult.autofill);
        if (trackerResult.externalResult.autofill.submitted) {
          await markJobAppliedByUrl(targetUrl).catch(() => undefined);
        }
      }
    }

    for (const note of trackerResult.notes) {
      print(`Note: ${note}`);
    }
    const trackerMismatch = trackerResult.notes.some((note) => /does not match requested job/i.test(note));
    if (!trackerMismatch) {
      return;
    }

    print("Tracker opened the wrong job; falling back to direct job-page automation.");
  }

  print(
    isLinkedInJobUrl(targetUrl)
      ? "Target job was not visible in LinkedIn Jobs Tracker. Falling back to direct job-page automation."
      : "Direct employer URL detected. Starting employer-site apply.",
  );

  if (shouldSkipTrackerApply() && isLinkedInJobUrl(targetUrl)) {
    await tryLinkedInDirectJobApply(targetUrl, profile, "LinkedIn Jobs Tracker skipped; checking the LinkedIn job page directly.");
    return;
  }

  if (isLinkedInJobUrl(targetUrl)) {
    const directHandled = await tryLinkedInDirectJobApply(
      targetUrl,
      profile,
      "Checking the LinkedIn job page directly before opening an attached fallback tab.",
    );
    if (directHandled) {
      return;
    }
  }

  await openAttachedJob(targetUrl);

  const captured = shouldSkipApplyCapture()
    ? null
    : await captureAttachedCurrentPage()
        .then(async (draft) => {
          const capturedUrl = normalizeJobUrlForComparison(draft.url);
          if (targetUrl.includes("linkedin.com/jobs/view/") && capturedUrl && capturedUrl !== targetUrl) {
            print(`Capture skipped: current LinkedIn page ${capturedUrl} did not match target ${targetUrl}.`);
            return null;
          }
          const saved = await addJobFromDraft(draft);
          print(`Saved: ${saved.id} | ${saved.title} @ ${saved.company}`);
          return saved;
        })
        .catch((error) => {
          print(`Capture failed: ${error instanceof Error ? error.message : "unknown error"}`);
          return null;
        });

  const review = await reviewAttachedLinkedInApplication().catch((error) => {
    print(`Review failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return null;
  });

  if (review?.hasEasyApply) {
    print(`Easy Apply: yes | Action: ${review.primaryAction}`);
    const result = await autoApplyAttachedLinkedInApplication(profile);
    printAutofillResult(result);
    if (result.submitted) {
      await markJobAppliedByUrl(captured?.url || targetUrl).catch(() => undefined);
      return;
    }

    if ((result.stopReason || "").includes("Easy Apply dialog was not detected")) {
      print("Easy Apply handoff did not open a LinkedIn modal. Falling back to employer-site apply.");
      const externalFallback = await processAttachedExternalJob(targetUrl, profile, { submit: true });
      print(`External apply found: ${externalFallback.externalApplyFound ? "yes" : "no"}`);
      print(`Destination: ${externalFallback.destinationUrl}`);
      if (externalFallback.review) {
        print(`Site: ${externalFallback.review.siteKind}`);
        print(`Stage: ${externalFallback.review.stage}`);
        print(`Primary action: ${externalFallback.review.primaryAction}`);
      }
      if (externalFallback.autofill) {
        printAutofillResult(externalFallback.autofill);
        if (externalFallback.autofill.submitted) {
          await markJobAppliedByUrl(captured?.url || targetUrl).catch(() => undefined);
        }
      }
      for (const note of externalFallback.notes) {
        print(`Note: ${note}`);
      }
    }
    return;
  }

  const external = await processAttachedExternalJob(targetUrl, profile, { submit: true });
  print(`External apply found: ${external.externalApplyFound ? "yes" : "no"}`);
  print(`Destination: ${external.destinationUrl}`);
  if (external.review) {
    print(`Site: ${external.review.siteKind}`);
    print(`Stage: ${external.review.stage}`);
    print(`Primary action: ${external.review.primaryAction}`);
  }
  if (external.autofill) {
    printAutofillResult(external.autofill);
    if (external.autofill.submitted) {
      await markJobAppliedByUrl(captured?.url || targetUrl).catch(() => undefined);
    }
  }
  for (const note of external.notes) {
    print(`Note: ${note}`);
  }
}

async function collectVisibleTrackerJobs(): Promise<JobCollectionItem[]> {
  const collection = await collectAttachedLinkedInJobs(DEFAULT_LINKEDIN_TRACKER_URL);
  return collection.filter(
    (job, index, array) =>
      array.findIndex(
        (entry) => normalizeJobUrlForComparison(entry.url) === normalizeJobUrlForComparison(job.url),
      ) === index,
  );
}

async function syncVisibleTrackerJobs(): Promise<{
  collection: JobCollectionItem[];
  queued: Job[];
  addedCount: number;
}> {
  const collection = await collectVisibleTrackerJobs();
  if (collection.length === 0) {
    return {
      collection,
      queued: [],
      addedCount: 0,
    };
  }

  const added = await addJobsFromCollection(collection);
  const jobs = await getJobs();
  const queued: Job[] = [];
  const seenJobIds = new Set<string>();

  for (const item of collection) {
    const normalizedUrl = normalizeJobUrlForComparison(item.url);
    const match = jobs.find(
      (job) =>
        job.status === "saved" &&
        !seenJobIds.has(job.id) &&
        normalizeJobUrlForComparison(job.url) === normalizedUrl,
    );
    if (!match) {
      continue;
    }

    queued.push(match);
    seenJobIds.add(match.id);
  }

  return {
    collection,
    queued,
    addedCount: added.length,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function syncVisibleTrackerJobsWithRetry(maxAttempts = 2): Promise<{
  collection: JobCollectionItem[];
  queued: Job[];
  addedCount: number;
} | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await syncVisibleTrackerJobs();
    } catch (error) {
      print(`Jobs Tracker sync failed on attempt ${attempt}/${maxAttempts}: ${getErrorMessage(error)}`);
      if (attempt < maxAttempts) {
        await sleep(1500);
      }
    }
  }

  return null;
}

async function browserSaveRemoteJobs(): Promise<void> {
  const evaluationProfile = await getJobEvaluationProfile();
  const requestedLimit = Number(process.env.JAA_BATCH_LIMIT || "25");
  const safeLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 25;
  const requestedPages = Number(process.env.JAA_PAGE_LIMIT || "1");
  const pageLimit = Number.isFinite(requestedPages) && requestedPages > 0 ? Math.floor(requestedPages) : 1;
  const collectionUrl = getLinkedInCollectionUrl();

  print("Opening LinkedIn jobs and screening visible jobs by criteria...");
  print(`Collection URL: ${collectionUrl}`);
  print(`Evaluation profile: ${summarizeJobEvaluationProfile(evaluationProfile)}`);
  print(`Edit this file to change what gets saved or dismissed: ${jobEvaluationProfilePath}`);

  let results;
  if (await isAttachedBrowserAvailable()) {
    const attachedReady = await ensureAttachedLinkedInAutomationReady(collectionUrl);
    if (attachedReady) {
      print("Using the attached Chrome session so the save flow stays visible in your debug browser.");
      results = await screenAttachedLinkedInJobs(safeLimit, {
        startUrl: collectionUrl,
        pageLimit,
      });
    } else {
      print("Attached Chrome could not be prepared. Falling back to the managed Playwright browser session.");
      results = await screenPersistentLinkedInJobs(safeLimit, {
        startUrl: collectionUrl,
        pageLimit,
        headed: true,
      });
    }
  } else {
    print("Attached Chrome was not detected. Falling back to the managed Playwright browser session.");
    results = await screenPersistentLinkedInJobs(safeLimit, {
      startUrl: collectionUrl,
      pageLimit,
      headed: true,
    });
  }

  if (results.length === 0) {
    print("No visible jobs were found on LinkedIn Remote Jobs.");
    return;
  }

  print(`Reviewed ${results.length} visible job${results.length === 1 ? "" : "s"} from LinkedIn Remote Jobs.`);

  let savedOnLinkedInCount = 0;
  let dismissedCount = 0;
  let localQueueCount = 0;
  let alreadySavedCount = 0;

  for (const [index, result] of results.entries()) {
    const evaluatedAt = new Date().toISOString();
    let savedJob: Job | null = null;

    if (result.action === "saved") {
      savedOnLinkedInCount += 1;
    } else if (result.action === "dismissed") {
      dismissedCount += 1;
    }

    if (result.alreadySaved) {
      alreadySavedCount += 1;
    }

    print(
      [
        `${index + 1}. ${result.action.toUpperCase()} | ${result.title} @ ${result.company}`,
        `URL: ${result.url}`,
        `Score: ${result.score}`,
        `Reasons: ${result.reasons.join("; ") || "none"}`,
      ].join("\n"),
    );

    if (result.draft) {
      savedJob = await addJobFromDraft(result.draft);
      localQueueCount += 1;
      print(`Queued locally: ${savedJob.id} | ${savedJob.title} @ ${savedJob.company}`);
    }

    await recordJobEvaluationDecision({
      id: result.url,
      title: result.title,
      company: result.company,
      url: result.url,
      normalizedUrl: result.url,
      source: result.draft?.source || "linkedin.com",
      descriptionSnippet: result.draft?.description || "",
      decision: result.action,
      jobId: savedJob?.id,
      pass: result.action !== "dismissed",
      score: result.score,
      reasons: result.reasons,
      matchedPositiveSignals: [],
      matchedNegativeSignals: [],
      profileName: evaluationProfile.name,
      profileSummary: evaluationProfile.summary,
      evaluatedAt,
      trackedBy: "browser save-remote-jobs",
      alreadySaved: result.alreadySaved,
    });
  }

  print("");
  print(`Reviewed: ${results.length}`);
  print(`Saved on LinkedIn: ${savedOnLinkedInCount}`);
  print(`Dismissed on LinkedIn: ${dismissedCount}`);
  print(`Queued locally with descriptions: ${localQueueCount}`);
  if (alreadySavedCount > 0) {
    print(`Already saved on LinkedIn: ${alreadySavedCount}`);
  }
}

async function browserSaveAttachedJobs(): Promise<void> {
  await browserSaveRemoteJobs();
}

async function browserEnrichSavedJobs(limitArg?: string): Promise<void> {
  const jobs = await getJobs();
  const linkedInJobs = jobs.filter((job) => job.url.includes("linkedin.com/jobs/view/"));
  const candidates = linkedInJobs.filter(needsJobEnrichment);

  if (linkedInJobs.length === 0) {
    print("No saved LinkedIn jobs were found.");
    return;
  }

  if (candidates.length === 0) {
    print("Saved LinkedIn jobs already have descriptions and basic metadata.");
    return;
  }

  const requestedLimit = Number(limitArg || process.env.JAA_BATCH_LIMIT || "10");
  const safeLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 10;
  const groupedCandidates = new Map<string, Job[]>();
  for (const job of candidates) {
    const normalizedUrl = normalizeLinkedInJobUrl(job.url);
    const list = groupedCandidates.get(normalizedUrl) ?? [];
    list.push(job);
    groupedCandidates.set(normalizedUrl, list);
  }

  const targets = [...groupedCandidates.keys()].slice(0, safeLimit);
  if (targets.length === 0) {
    print("No saved LinkedIn jobs qualified for enrichment.");
    return;
  }

  let results;
  if (await isAttachedBrowserAvailable()) {
    print(
      `Enriching ${targets.length} unique LinkedIn job pages from ${candidates.length} saved jobs using the attached browser.`,
    );
    results = await enrichAttachedJobPostings(targets);
  } else {
    print(
      `Attached browser not detected. Trying the persistent Playwright profile for ${targets.length} LinkedIn job pages instead.`,
    );
    print(
      "If LinkedIn redirects to login or authwall, run `npm run cli -- browser open https://www.linkedin.com/jobs/`, log in there once, then rerun this command.",
    );
    results = await enrichPersistentJobPostings(targets, true);
  }

  const applied = await applyJobEnrichmentResults(results);
  const updatedCount = applied.updatedCount;
  const successful = applied.successfulCount;

  print(`Fetched: ${successful}/${results.length} job pages`);
  print(`Updated saved jobs: ${updatedCount}`);
  if (applied.dedupeRemovedCount > 0) {
    print(
      `Deduped after enrichment: removed ${applied.dedupeRemovedCount} duplicates across ${applied.dedupeMergedGroups} groups.`,
    );
  }

  const failed = applied.failed;
  for (const [index, result] of failed.slice(0, 5).entries()) {
    print(`${index + 1}. Failed ${result.normalizedUrl} | ${result.error || "unknown error"}`);
  }
  if (failed.length > 5) {
    print(`Additional failures not shown: ${failed.length - 5}`);
  }

  const redirectedFailures = failed.filter((result) =>
    (result.error || "").toLowerCase().includes("redirected away from the job page"),
  );
  if (redirectedFailures.length > 0) {
    print(
      "LinkedIn blocked this browser session. Log into LinkedIn in `npm run cli -- browser open https://www.linkedin.com/jobs/` or use `powershell -ExecutionPolicy Bypass -File .\\start-debug-chrome.ps1`, then rerun enrichment.",
    );
  }

  if (updatedCount > 0) {
    print("Re-run `npm run cli -- job rank 10` to rank the enriched jobs.");
  }
}

async function browserProcessVisibleJobs(): Promise<void> {
  print("Compatibility alias only: `browser process-visible-jobs` -> `browser save-remote-jobs`.");
  await browserSaveRemoteJobs();
}

async function browserAutoApplyVisibleJobs(): Promise<void> {
  print("Compatibility alias only: `browser auto-apply-visible-jobs` -> `browser apply-saved-jobs`.");
  await browserAutoApplySavedJobs();
}

async function applySavedJobTarget(
  targetUrl: string,
  profile: Profile,
  options: {
    preferTracker?: boolean;
  } = {},
): Promise<{
  submitted: boolean;
  usedTracker: boolean;
}> {
  const normalizedUrl = normalizeJobUrlForComparison(targetUrl);

  if (!isLinkedInJobUrl(normalizedUrl)) {
    print("Direct employer URL detected. Starting employer-site apply.");
    const result = await autoApplySiteFormUrl(normalizedUrl, profile);
    printAutofillResult(result);
    if (result.submitted) {
      await markJobAppliedByUrl(normalizedUrl).catch(() => undefined);
    }
    return {
      submitted: result.submitted === true,
      usedTracker: false,
    };
  }

  if (options.preferTracker && !shouldSkipTrackerApply()) {
    const trackerResult = await applyAttachedTrackerJob(normalizedUrl, profile, {
      submit: true,
      startUrl: DEFAULT_LINKEDIN_TRACKER_URL,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown error";
      if (isLinkedInAuthErrorMessage(message)) {
        throw error;
      }

      print(`Jobs Tracker flow failed: ${message}`);
      return null;
    });

    if (trackerResult) {
      let submitted = false;
      print(`Jobs Tracker action: ${trackerResult.trackerAction}`);
      print(`Landing URL: ${trackerResult.firstLandingUrl}`);

      if (trackerResult.linkedInAutofill) {
        printAutofillResult(trackerResult.linkedInAutofill);
        if (trackerResult.linkedInAutofill.submitted) {
          submitted = true;
          await markJobAppliedByUrl(normalizedUrl).catch(() => undefined);
        }
      }

      if (trackerResult.externalResult) {
        print(`External apply found: ${trackerResult.externalResult.externalApplyFound ? "yes" : "no"}`);
        print(`Destination: ${trackerResult.externalResult.destinationUrl}`);
        if (trackerResult.externalResult.review) {
          print(`Site: ${trackerResult.externalResult.review.siteKind}`);
          print(`Stage: ${trackerResult.externalResult.review.stage}`);
          print(`Primary action: ${trackerResult.externalResult.review.primaryAction}`);
        }
        if (trackerResult.externalResult.autofill) {
          printAutofillResult(trackerResult.externalResult.autofill);
          if (trackerResult.externalResult.autofill.submitted) {
            submitted = true;
            await markJobAppliedByUrl(normalizedUrl).catch(() => undefined);
          }
        }
      }

      for (const note of trackerResult.notes) {
        print(`Note: ${note}`);
      }

      const trackerMismatch = trackerResult.notes.some((note) => /does not match requested job/i.test(note));
      if (!trackerMismatch) {
        return {
          submitted,
          usedTracker: true,
        };
      }

      print("Tracker opened the wrong job; falling back to direct job-page automation.");
    }

    print("Target job was not visible in LinkedIn Jobs Tracker. Falling back to direct job-page automation.");
  }

  if (shouldSkipTrackerApply() && isLinkedInJobUrl(normalizedUrl)) {
    const external = await processAttachedExternalJob(normalizedUrl, profile, {
      submit: true,
      isolatedPage: true,
    });
    print(`External apply found: ${external.externalApplyFound ? "yes" : "no"}`);
    print(`Destination: ${external.destinationUrl}`);
    if (external.review) {
      print(`Site: ${external.review.siteKind}`);
      print(`Stage: ${external.review.stage}`);
      print(`Primary action: ${external.review.primaryAction}`);
    }
    if (external.autofill) {
      printAutofillResult(external.autofill);
      if (external.autofill.submitted) {
        await markJobAppliedByUrl(normalizedUrl).catch(() => undefined);
        return {
          submitted: true,
          usedTracker: false,
        };
      }
    }
    for (const note of external.notes) {
      print(`Note: ${note}`);
    }

    return {
      submitted: false,
      usedTracker: false,
    };
  }

  await openAttachedJob(normalizedUrl);

  const captured = shouldSkipApplyCapture()
    ? null
    : await captureAttachedCurrentPage()
        .then(async (draft) => {
          const capturedUrl = normalizeJobUrlForComparison(draft.url);
          if (normalizedUrl.includes("linkedin.com/jobs/view/") && capturedUrl && capturedUrl !== normalizedUrl) {
            print(`Capture skipped: current LinkedIn page ${capturedUrl} did not match target ${normalizedUrl}.`);
            return null;
          }
          const saved = await addJobFromDraft(draft);
          print(`Saved: ${saved.id} | ${saved.title} @ ${saved.company}`);
          return saved;
        })
        .catch((error) => {
          print(`Capture failed: ${error instanceof Error ? error.message : "unknown error"}`);
          return null;
        });

  const review = await reviewAttachedLinkedInApplication().catch((error) => {
    print(`Review failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return null;
  });

  if (review?.hasEasyApply) {
    print(`Easy Apply: yes | Action: ${review.primaryAction}`);
    const result = await autoApplyAttachedLinkedInApplication(profile);
    printAutofillResult(result);
    if (result.submitted) {
      await markJobAppliedByUrl(captured?.url || normalizedUrl).catch(() => undefined);
      return {
        submitted: true,
        usedTracker: false,
      };
    }

    if ((result.stopReason || "").includes("Easy Apply dialog was not detected")) {
      print("Easy Apply handoff did not open a LinkedIn modal. Falling back to employer-site apply.");
      const externalFallback = await processAttachedExternalJob(normalizedUrl, profile, { submit: true });
      print(`External apply found: ${externalFallback.externalApplyFound ? "yes" : "no"}`);
      print(`Destination: ${externalFallback.destinationUrl}`);
      if (externalFallback.review) {
        print(`Site: ${externalFallback.review.siteKind}`);
        print(`Stage: ${externalFallback.review.stage}`);
        print(`Primary action: ${externalFallback.review.primaryAction}`);
      }
      if (externalFallback.autofill) {
        printAutofillResult(externalFallback.autofill);
        if (externalFallback.autofill.submitted) {
          await markJobAppliedByUrl(captured?.url || normalizedUrl).catch(() => undefined);
          return {
            submitted: true,
            usedTracker: false,
          };
        }
      }
      for (const note of externalFallback.notes) {
        print(`Note: ${note}`);
      }
    }

    return {
      submitted: false,
      usedTracker: false,
    };
  }

  const external = await processAttachedExternalJob(normalizedUrl, profile, { submit: true });
  print(`External apply found: ${external.externalApplyFound ? "yes" : "no"}`);
  print(`Destination: ${external.destinationUrl}`);
  if (external.review) {
    print(`Site: ${external.review.siteKind}`);
    print(`Stage: ${external.review.stage}`);
    print(`Primary action: ${external.review.primaryAction}`);
  }
  if (external.autofill) {
    printAutofillResult(external.autofill);
    if (external.autofill.submitted) {
      await markJobAppliedByUrl(captured?.url || normalizedUrl).catch(() => undefined);
      return {
        submitted: true,
        usedTracker: false,
      };
    }
  }
  for (const note of external.notes) {
    print(`Note: ${note}`);
  }

  return {
    submitted: false,
    usedTracker: false,
  };
}

type BatchApplyResult = {
  submitted: boolean;
  usedTracker: boolean;
  timedOut: boolean;
  blockedByLinkedInAuth: boolean;
  needsReview: boolean;
  reviewReason: string;
  transientFailure: boolean;
};

type BatchApplyJobOutcome = {
  index: number;
  job: Job;
  result: BatchApplyResult;
};

function isAutomatedReviewBlocker(text: string): boolean {
  return /required fields still missing|step limit|no primary .* after autofill|authentication blocked|manual verification required|captcha|verify your account before you sign in|employer page blocked|page blocked|strictblock|final action clicked|easy apply daily limit|workday planned maintenance/i.test(
    text,
  );
}

async function runBatchApplyJobSubprocess(
  targetUrl: string,
  timeoutMs: number,
): Promise<BatchApplyResult> {
  const execution = resolveCliSelfExecution(["browser", "apply-job-url", targetUrl]);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    JAA_BATCH_APPLY_CHILD: "1",
    JAA_DEFER_APPLY_STATUS_WRITES: "1",
    JAA_SKIP_ATTACHED_TAB_PRUNE: "1",
  };

  try {
    const { stdout, stderr } = await execFileAsync(execution.command, execution.args, {
      cwd: process.cwd(),
      env: childEnv,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });

    printChildOutput(stdout, stderr);
    const combinedOutput = `${stdout}\n${stderr}`;
    const blockedByLinkedInAuth = isLinkedInAuthErrorMessage(combinedOutput);
    const transientFailure = isTransientBrowserConnectionError(combinedOutput);
    const reviewReason = (stdout.match(/\bReason:\s+([^\r\n]+)/i)?.[1] || "").trim();
    const noteText = (stdout.match(/\bNote:\s+([^\r\n]+)/i)?.[1] || "").trim();
    const reviewText = [reviewReason, noteText, combinedOutput].filter(Boolean).join("\n");
    const needsReview =
      !transientFailure &&
      (isAutomatedReviewBlocker(reviewText) ||
        /no second apply action reached an external employer site|no external employer application URL was found/i.test(
          noteText,
        ));
    return {
      submitted: /\bSubmitted:\s+yes\b/i.test(stdout),
      usedTracker: /\bJobs Tracker action:/i.test(stdout),
      timedOut: false,
      blockedByLinkedInAuth,
      needsReview,
      reviewReason: reviewReason || noteText,
      transientFailure,
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
    };
    const stdout =
      typeof failure.stdout === "string" ? failure.stdout : Buffer.isBuffer(failure.stdout) ? failure.stdout.toString("utf8") : "";
    const stderr =
      typeof failure.stderr === "string" ? failure.stderr : Buffer.isBuffer(failure.stderr) ? failure.stderr.toString("utf8") : "";

    printChildOutput(stdout, stderr);

    const timedOut = Boolean(failure.killed) || /timed out/i.test(failure.message || "");
    const combinedOutput = `${stdout}\n${stderr}\n${failure.message || ""}`;
    const blockedByLinkedInAuth = isLinkedInAuthErrorMessage(combinedOutput);
    const transientFailure = isTransientBrowserConnectionError(combinedOutput);
    const reviewReason = (stdout.match(/\bReason:\s+([^\r\n]+)/i)?.[1] || "").trim();
    const noteText = (stdout.match(/\bNote:\s+([^\r\n]+)/i)?.[1] || "").trim();
    const failureMessage = (failure.message || "").split(/\r?\n/)[0].trim();
    const reviewText = [reviewReason, noteText, combinedOutput].filter(Boolean).join("\n");
    const needsReview =
      !transientFailure &&
      (isAutomatedReviewBlocker(reviewText) ||
        /no second apply action reached an external employer site|no external employer application URL was found/i.test(
          noteText,
        ) ||
        timedOut ||
        Boolean(failureMessage && !blockedByLinkedInAuth));
    if (timedOut) {
      print(`Apply attempt timed out after ${Math.round(timeoutMs / 1000)}s.`);
      await killLingeringApplySubprocess(targetUrl);
    } else if (failure.message) {
      print(`Apply subprocess failed: ${failure.message}`);
    }

    return {
      submitted: /\bSubmitted:\s+yes\b/i.test(stdout),
      usedTracker: /\bJobs Tracker action:/i.test(stdout),
      timedOut,
      blockedByLinkedInAuth,
      needsReview,
      reviewReason:
        reviewReason ||
        noteText ||
        (timedOut ? "Apply attempt timed out." : failureMessage ? `Apply subprocess failed: ${failureMessage}` : ""),
      transientFailure,
    };
  }
}

async function runBatchApplyJobSubprocesses(
  targets: Job[],
  timeoutMs: number,
  concurrency: number,
): Promise<BatchApplyJobOutcome[]> {
  const workerCount = Math.min(Math.max(concurrency, 1), targets.length);
  const outcomes: BatchApplyJobOutcome[] = [];
  let nextIndex = 0;
  let stopLaunching = false;

  async function worker(workerIndex: number): Promise<void> {
    while (!stopLaunching) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= targets.length) {
        return;
      }

      const job = targets[index];
      print(`\n[${index + 1}/${targets.length}] ${job.title} @ ${job.company} | worker ${workerIndex + 1}/${workerCount}`);
      const result = await runBatchApplyJobSubprocess(job.url, timeoutMs);
      outcomes.push({ index, job, result });

      if (result.blockedByLinkedInAuth) {
        stopLaunching = true;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, index) => worker(index)));
  return outcomes.sort((left, right) => left.index - right.index);
}

async function browserAutoApplySavedJobs(): Promise<void> {
  const initialSavedJobs = (await getJobs()).filter(isQueuedApplyJob);
  const skipTrackerApply = shouldSkipTrackerApply();
  const hasLinkedInSavedJobs =
    !skipTrackerApply &&
    (initialSavedJobs.length === 0 || initialSavedJobs.some((job) => isLinkedInJobUrl(job.url)));
  let linkedInTrackerReady = false;
  let collection: JobCollectionItem[] = [];
  let visibleQueued: Job[] = [];
  let addedCount = 0;

  if (hasLinkedInSavedJobs) {
    linkedInTrackerReady = await ensureAttachedLinkedInAutomationReady(DEFAULT_LINKEDIN_TRACKER_URL);
    if (linkedInTrackerReady) {
      print("Opening LinkedIn Jobs Tracker and syncing whatever is currently visible there...");
      const synced = await syncVisibleTrackerJobsWithRetry(2);
      if (synced) {
        collection = synced.collection;
        visibleQueued = synced.queued;
        addedCount = synced.addedCount;
        print(`Visible tracker jobs: ${collection.length}`);
        print(`New tracker jobs synced into data/jobs.json: ${addedCount}`);
        print(`Visible tracker jobs still marked saved locally: ${visibleQueued.length}`);
      } else {
        linkedInTrackerReady = false;
        print("LinkedIn Jobs Tracker sync failed; continuing with direct employer URLs only.");
      }
    } else {
      print("LinkedIn Jobs Tracker was not ready; continuing with direct employer URLs only.");
    }
  } else {
    print(
      skipTrackerApply
        ? "LinkedIn Jobs Tracker sync skipped by configuration; applying saved LinkedIn URLs directly."
        : "Saved queue contains direct employer URLs only; skipping LinkedIn Jobs Tracker sync.",
    );
  }

  const visibleTrackerUrls = new Set(collection.map((job) => normalizeJobUrlForComparison(job.url)));
  const savedJobs = (await getJobs()).filter(
    (job) => isQueuedApplyJob(job) && (linkedInTrackerReady || skipTrackerApply || !isLinkedInJobUrl(job.url)),
  );
  if (savedJobs.length === 0) {
    print(
      linkedInTrackerReady
        ? "No saved local jobs are queued for application."
        : "No direct employer saved jobs are queued for application.",
    );
    return;
  }

  const requestedLimit = Number(process.env.JAA_BATCH_LIMIT || `${savedJobs.length}`);
  const safeLimit =
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : savedJobs.length;
  const requestedApplyTimeoutMs = Number(process.env.JAA_APPLY_TIMEOUT_MS || "300000");
  const applyTimeoutMs =
    Number.isFinite(requestedApplyTimeoutMs) && requestedApplyTimeoutMs > 0
      ? Math.floor(requestedApplyTimeoutMs)
      : 300000;
  const autoEnrichDisabled = /^(1|true|yes)$/i.test(process.env.JAA_SKIP_AUTO_ENRICH || "");

  if (!autoEnrichDisabled) {
    try {
      const enrichment = await enrichSavedLinkedInJobsBeforeApply(savedJobs, visibleTrackerUrls, safeLimit);
      if (enrichment.attempted > 0) {
        print(
          `Auto-enriched ${enrichment.successfulCount}/${enrichment.attempted} saved LinkedIn job pages before applying.`,
        );
        print(`Updated saved jobs after enrichment: ${enrichment.updatedCount}`);
        if (enrichment.dedupeRemovedCount > 0) {
          print(
            `Deduped after auto-enrichment: removed ${enrichment.dedupeRemovedCount} duplicates across ${enrichment.dedupeMergedGroups} groups.`,
          );
        }
        if (enrichment.failedCount > 0) {
          print(`Auto-enrichment failures: ${enrichment.failedCount}`);
        }
      }
    } catch (error) {
      print(`Auto-enrichment failed; continuing with visible tracker jobs: ${getErrorMessage(error)}`);
    }
  }

  let refreshedSavedJobs = (await getJobs()).filter(
    (job) => isQueuedApplyJob(job) && (linkedInTrackerReady || skipTrackerApply || !isLinkedInJobUrl(job.url)),
  );
  const nonRemoteSavedJobs = refreshedSavedJobs.filter((job) => Boolean(getNonRemoteApplySkipReason(job)));
  const closedNonRemoteCount = await closeNonRemoteSavedJobs(nonRemoteSavedJobs);
  if (closedNonRemoteCount > 0) {
    print(
      `Closed ${closedNonRemoteCount} saved job${closedNonRemoteCount === 1 ? "" : "s"} before applying because they do not look remote.`,
    );
    refreshedSavedJobs = (await getJobs()).filter(
      (job) => isQueuedApplyJob(job) && (linkedInTrackerReady || skipTrackerApply || !isLinkedInJobUrl(job.url)),
    );
  }

  const skippedReasons = refreshedSavedJobs
    .map((job) => getSavedJobSkipReason(job, visibleTrackerUrls))
    .filter((reason): reason is string => Boolean(reason));
  const queued = getPrioritizedSavedJobs(
    refreshedSavedJobs.filter((job) => !getSavedJobSkipReason(job, visibleTrackerUrls)),
    visibleTrackerUrls,
  );

  if (queued.length === 0) {
    print("No saved local jobs are ready for application.");
    if (skippedReasons.length > 0) {
      print(`Skipped saved jobs: ${summarizeSkipReasons(skippedReasons)}`);
    }
    return;
  }

  if (skippedReasons.length > 0) {
    print(`Skipped saved jobs that are not ready yet: ${summarizeSkipReasons(skippedReasons)}`);
  }

  const targets = queued.slice(0, Math.min(queued.length, safeLimit));

  if (linkedInTrackerReady && !/^(1|true|yes)$/i.test(process.env.JAA_SKIP_ATTACHED_TAB_PRUNE || "")) {
    const closedTabs = await pruneAttachedApplicationTabs({
      keepUrls: [DEFAULT_LINKEDIN_TRACKER_URL],
    }).catch((error) => {
      print(`Attached tab cleanup skipped: ${getErrorMessage(error)}`);
      return 0;
    });
    if (closedTabs > 0) {
      print(`Closed ${closedTabs} stale attached browser tab${closedTabs === 1 ? "" : "s"} before batch apply.`);
    }
  }

  print(`Applying ${targets.length} saved job${targets.length === 1 ? "" : "s"} from the local queue.`);
  if (visibleTrackerUrls.size > 0) {
    print(
      `Jobs Tracker assist is available for ${Math.min(visibleTrackerUrls.size, targets.length)} visible queued job${visibleTrackerUrls.size === 1 ? "" : "s"} on the current page.`,
    );
  }

  let submittedCount = 0;
  let trackerAssistCount = 0;
  const applyConcurrency = resolveApplyConcurrency(targets.length);
  print(`Apply subprocess concurrency: ${applyConcurrency}`);
  let outcomes = await runBatchApplyJobSubprocesses(targets, applyTimeoutMs, applyConcurrency);

  const transientFailures = outcomes.filter((outcome) => outcome.result.transientFailure);
  if (applyConcurrency > 1 && transientFailures.length > 0) {
    print(
      `Retrying ${transientFailures.length} browser-connection failure${transientFailures.length === 1 ? "" : "s"} sequentially.`,
    );
    const retryOutcomes = await runBatchApplyJobSubprocesses(
      transientFailures.map((outcome) => outcome.job),
      applyTimeoutMs,
      1,
    );
    const retriedUrls = new Set(transientFailures.map((outcome) => normalizeJobUrlForComparison(outcome.job.url)));
    outcomes = [
      ...outcomes.filter((outcome) => !retriedUrls.has(normalizeJobUrlForComparison(outcome.job.url))),
      ...retryOutcomes,
    ].sort((left, right) => left.index - right.index);
  }

  for (const { job, result } of outcomes) {
    if (result.usedTracker) {
      trackerAssistCount += 1;
    }
    if (result.submitted) {
      submittedCount += 1;
      const appliedNote = `Submitted by automated batch on ${localIsoDate()}.`;
      if (await markJobAppliedByUrl(job.url, appliedNote)) {
        print(`Marked applied after submitted attempt: ${job.title} @ ${job.company}`);
      }
    } else if (result.needsReview && result.reviewReason) {
      if (await markJobBlockedByUrl(job.url, result.reviewReason)) {
        print(`Blocked after automated attempt: ${result.reviewReason}`);
      }
    }
    if (result.blockedByLinkedInAuth) {
      print("Stopped starting new batch apply jobs because LinkedIn requires login or a checkpoint challenge in the attached browser.");
    }
  }

  print("");
  print(`Queued local jobs considered: ${queued.length}`);
  print(`Application attempts: ${outcomes.length}`);
  print(`Tracker-assisted attempts: ${trackerAssistCount}`);
  print(`Submitted applications: ${submittedCount}`);
  if (outcomes.length < targets.length) {
    print(`Skipped after stop signal: ${targets.length - outcomes.length}`);
  }
}

async function browserApplySavedJobs(): Promise<void> {
  await browserAutoApplySavedJobs();
}

async function browserProcessVisibleExternalJobs(): Promise<void> {
  await exportExternalApplyUrlsFromArtifacts().catch(() => undefined);
  const requestedLimit = Number(process.env.JAA_BATCH_LIMIT || "10");
  const safeLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 10;
  const requestedPages = Number(process.env.JAA_PAGE_LIMIT || "1");
  const pageLimit = Number.isFinite(requestedPages) && requestedPages > 0 ? requestedPages : 1;
  const capturedUrls: Array<{
    index: number;
    title: string;
    company?: string;
    sourceUrl: string;
    destinationUrl: string;
    compensationText?: string;
  }> = [];
  let processedCount = 0;

  try {
    for (let pageNumber = 1; pageNumber <= pageLimit && processedCount < safeLimit; pageNumber += 1) {
      const collection = await collectAttachedLinkedInJobs();
      const unique = collection.filter(
        (job, index, array) => array.findIndex((entry) => entry.url === job.url) === index,
      );

      if (unique.length === 0) {
        print(`No visible jobs were found on page ${pageNumber}.`);
        break;
      }

      const remaining = safeLimit - processedCount;
      const limit = Math.min(unique.length, remaining);
      print(`Processing page ${pageNumber}/${pageLimit}, ${limit} jobs from LinkedIn previews.`);

      for (let index = 0; index < limit; index += 1) {
        const job = unique[index];
        print(`\n[${processedCount + 1}/${safeLimit}] ${job.title}`);
        await clickAttachedLinkedInPreview(index).catch(() => undefined);
        const result = await processAttachedExternalJobFromPreview(index).catch((error) => {
          print(`Failed: ${error instanceof Error ? error.message : "unknown error"}`);
          return null;
        });

        processedCount += 1;

        if (!result) {
          continue;
        }

        print(`External apply found: ${result.externalApplyFound ? "yes" : "no"}`);
        print(`Destination: ${result.destinationUrl}`);
        if (result.siteKind) {
          print(`Site: ${result.siteKind}`);
        }
        if (result.review) {
          print(`Stage: ${result.review.stage}`);
          print(`Primary action: ${result.review.primaryAction}`);
        }
        if (result.compensationText) {
          print(`Compensation: ${result.compensationText}`);
        }
        if (result.sourceCompany && (result.estimatedMaxAnnualCompensation ?? 0) >= 250000) {
          const saved = await recordHighPayingCompany({
            company: result.sourceCompany,
            title: result.sourceJobTitle,
            sourceJobUrl: result.sourceJobUrl,
            compensationText:
              result.compensationText || `$${result.estimatedMaxAnnualCompensation?.toLocaleString()}`,
            estimatedMaxAnnualCompensation: result.estimatedMaxAnnualCompensation ?? 0,
            capturedAt: nowIso(),
          });
          print(
            saved
              ? `Saved high-paying company: ${result.sourceCompany}`
              : `High-paying company already saved: ${result.sourceCompany}`,
          );
        }
        if (result.externalApplyFound) {
          if (result.workloadScreening && !result.workloadScreening.pass) {
            print(
              `Filtered out by workload screen (score ${result.workloadScreening.score}): ${result.workloadScreening.reasons.join("; ")}`,
            );
            continue;
          }
          capturedUrls.push({
            index: processedCount,
            title: result.sourceJobTitle,
            company: result.sourceCompany,
            sourceUrl: result.sourceJobUrl,
            destinationUrl: result.destinationUrl,
            compensationText: result.compensationText,
          });
          const paths = await saveExternalBatchUrls(capturedUrls);
          print(`Saved employer URLs so far: ${paths.textPath}`);
        }
        for (const note of result.notes) {
          print(`Note: ${note}`);
        }
      }

      if (processedCount >= safeLimit || pageNumber >= pageLimit) {
        break;
      }

      const advanced = await advanceAttachedLinkedInCollectionPage().catch(() => false);
      if (!advanced) {
        print("Could not advance to the next LinkedIn jobs page.");
        break;
      }
    }
  } finally {
    await exportExternalApplyUrlsFromArtifacts().catch(() => undefined);
  }

  if (capturedUrls.length > 0) {
    const paths = await saveExternalBatchUrls(capturedUrls);
    print(`Saved employer URLs JSON: ${paths.jsonPath}`);
    print(`Saved employer URLs TXT: ${paths.textPath}`);
  } else {
    print("No employer application URLs were captured.");
  }
}

async function browserTriageVisibleJobs(): Promise<void> {
  const evaluationProfile = await getJobEvaluationProfile();
  const requestedLimit = Number(process.env.JAA_BATCH_LIMIT || "5");
  const safeLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 5;
  print(`Evaluation profile: ${summarizeJobEvaluationProfile(evaluationProfile)}`);
  print(`Edit this file to change what gets saved or dismissed: ${jobEvaluationProfilePath}`);
  const results = await triageAttachedVisibleJobs(safeLimit);

  if (results.length === 0) {
    print("No visible LinkedIn jobs were triaged.");
    return;
  }

  for (const [index, result] of results.entries()) {
    print(
      [
        `${index + 1}. ${result.action.toUpperCase()} | ${result.title} @ ${result.company}`,
        `URL: ${result.url}`,
        `Score: ${result.score}`,
        `Reasons: ${result.reasons.join("; ") || "none"}`,
      ].join("\n"),
    );
  }
}

async function ensureAttachedLinkedInAutomationReady(startUrl = DEFAULT_LINKEDIN_COLLECTION_URL): Promise<boolean> {
  const chromeCandidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
  const debugProfileDir = path.join(process.cwd(), ".chrome-debug-profile");

  if (!(await isAttachedBrowserAvailable())) {
    print("Starting debug Chrome...");
    if (!chromePath) {
      print("Chrome was not found in standard locations.");
      return false;
    }

    spawn(
      chromePath,
      [
        "--remote-debugging-port=9222",
        `--user-data-dir=${debugProfileDir}`,
        startUrl,
      ],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
      },
    ).unref();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await isAttachedBrowserAvailable()) {
        break;
      }
      await sleep(1000);
    }
  }

  if (!(await isAttachedBrowserAvailable())) {
    print("Could not connect to the attached browser at http://127.0.0.1:9222");
    print("Start it manually with: powershell -ExecutionPolicy Bypass -File .\\start-debug-chrome.ps1");
    return false;
  }

  if (!(await attachedBrowserHasLinkedInPage())) {
    print("Attached browser is available, but no LinkedIn jobs page is open yet. Opening the automation page now.");
    await openAttachedUrl(startUrl).catch(() => undefined);
    await sleep(1500);
  }

  if (!(await attachedBrowserHasLinkedInPage())) {
    print(`Could not open a LinkedIn jobs page in the attached browser. Open this URL manually: ${startUrl}`);
    return false;
  }

  return true;
}

async function browserStartAutopilot(): Promise<void> {
  print("Starting the Remote Jobs save autopilot...");
  await browserSaveRemoteJobs();
}

async function browserStartFullAutopilot(): Promise<void> {
  print("Starting the Jobs Tracker apply autopilot...");
  await browserApplySavedJobs();
}

async function browserReviewAttachedForm(): Promise<void> {
  const review = await reviewAttachedCurrentForm();
  print(
    [
      `Title: ${review.title}`,
      `URL: ${review.url}`,
      `Site: ${review.siteKind}`,
      `Stage: ${review.stage}`,
      `Primary action: ${review.primaryAction}`,
      `Fields detected: ${review.fields.length}`,
      ...review.fields.map(
        (field, index) =>
          `${index + 1}. ${field.label} | ${field.type} | ${field.required ? "required" : "optional"}`,
      ),
      ...review.notes.map((note) => `Note: ${note}`),
    ].join("\n"),
  );
}

async function browserReviewCurrentForm(): Promise<void> {
  const review = await reviewCurrentSiteForm();
  print(
    [
      `Title: ${review.title}`,
      `URL: ${review.url}`,
      `Site: ${review.siteKind}`,
      `Stage: ${review.stage}`,
      `Primary action: ${review.primaryAction}`,
      `Fields detected: ${review.fields.length}`,
      ...review.fields.map(
        (field, index) =>
          `${index + 1}. ${field.label} | ${field.type} | ${field.required ? "required" : "optional"}`,
      ),
      ...review.notes.map((note) => `Note: ${note}`),
    ].join("\n"),
  );
}

async function browserAutofillAttachedForm(): Promise<void> {
  const profile = await getProfile();
  const result = await autofillAttachedCurrentForm(profile);
  printAutofillResult(result);
}

async function browserAutoApplyAttachedForm(): Promise<void> {
  const profile = await getProfile();
  const currentContext = await captureAttachedCurrentFormPageContext().catch(() => null);
  const result = await autoApplyAttachedCurrentForm(profile);
  printAutofillResult(result);
  if (!result.submitted) {
    return;
  }

  const trackedJob = currentContext ? await markLikelyAppliedJobFromAttachedContext(currentContext) : null;
  if (trackedJob) {
    print(`Tracked applied job: ${trackedJob.title} @ ${trackedJob.company}`);
    return;
  }

  print("Submitted, but no unique local job match was found to mark as applied.");
}

async function browserAutofillCurrentForm(): Promise<void> {
  const profile = await getProfile();
  const result = await autofillCurrentSiteForm(profile);
  printAutofillResult(result);
}

async function browserReviewFormUrl(url: string): Promise<void> {
  const review = await reviewSiteFormUrl(url);
  print(
    [
      `Title: ${review.title}`,
      `URL: ${review.url}`,
      `Site: ${review.siteKind}`,
      `Stage: ${review.stage}`,
      `Primary action: ${review.primaryAction}`,
      `Fields detected: ${review.fields.length}`,
      ...review.fields.map(
        (field, index) =>
          `${index + 1}. ${field.label} | ${field.type} | ${field.required ? "required" : "optional"}`,
      ),
      ...review.notes.map((note) => `Note: ${note}`),
    ].join("\n"),
  );
}

async function browserAutofillFormUrl(url: string): Promise<void> {
  const profile = await getProfile();
  const result = await autofillSiteFormUrl(url, profile);
  printAutofillResult(result);
}

async function browserAutoApplyFormUrl(url: string): Promise<void> {
  const profile = await getProfile();
  const result = await autoApplySiteFormUrl(url, profile);
  printAutofillResult(result);
}

async function browserReviewUnansweredQuestions(limitArg?: string): Promise<void> {
  const parsedLimit = Number(limitArg || "10");
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 10;
  const profile = await getProfile();
  const explicitAnswers = await loadApplicationAnswers();
  const bank = await loadQuestionBank();
  const unanswered = bank.entries
    .filter((entry) => entry.status === "unanswered")
    .sort(sortQuestionBankEntries);

  if (unanswered.length === 0) {
    print("No unanswered form questions were found in data/question-bank.json.");
    return;
  }

  const evaluated = unanswered.map((entry) => {
    const bucket = mapQuestionTypeToAnswerBucket(entry.type);
    const explicitAnswer = lookupApplicationAnswer(explicitAnswers, entry.label, entry.type);
    const suggestion = suggestFormAnswer(
      {
        label: entry.label,
        type: entry.type,
        required: false,
        choices: entry.choices,
      },
      profile,
      explicitAnswer,
      "application-answers",
    );

    return {
      entry,
      bucket,
      key: normalizeAnswerKey(entry.label),
      suggestion,
    };
  });

  const needsExplicit = evaluated.filter((row) => !row.suggestion);
  const nowAnswerable = evaluated.filter((row) => row.suggestion);
  const visibleNeedsExplicit = needsExplicit.slice(0, limit);
  const visibleNowAnswerable = nowAnswerable.slice(0, Math.min(limit, 5));
  const snippetGroups = new Map<AnswerBucket, string[]>();

  for (const row of visibleNeedsExplicit) {
    const keys = snippetGroups.get(row.bucket) ?? [];
    if (!keys.includes(row.key)) {
      keys.push(row.key);
      snippetGroups.set(row.bucket, keys);
    }
  }

  const lines = [
    `Question bank entries still marked unanswered: ${unanswered.length}`,
    `Still need explicit answers: ${needsExplicit.length}`,
    `Now answerable with current profile/rules: ${nowAnswerable.length}`,
    `Answer file: ${path.join(process.cwd(), "data", "application-answers.json")}`,
  ];

  if (visibleNeedsExplicit.length > 0) {
    lines.push("", `Top unresolved questions (${visibleNeedsExplicit.length} shown):`);
    for (const [index, row] of visibleNeedsExplicit.entries()) {
      lines.push(`${index + 1}. ${row.entry.label}`);
      lines.push(
        `Type: ${row.entry.type} | Bucket: ${row.bucket} | Seen: ${row.entry.seenCount} | Last seen: ${row.entry.lastSeenAt}`,
      );
      lines.push(`Suggested key: "${row.key}"`);
      if (row.entry.choices.length > 0) {
        lines.push(`Choices: ${summarizeChoices(row.entry.choices)}`);
      }
      lines.push("");
    }

    lines.push("Suggested JSON additions:");
    for (const bucket of ["text", "select", "radio", "checkbox"] as const) {
      const keys = snippetGroups.get(bucket);
      if (!keys || keys.length === 0) {
        continue;
      }
      lines.push(`${bucket}:`);
      for (const key of keys) {
        lines.push(`  "${key}": ""`);
      }
    }
  }

  if (visibleNowAnswerable.length > 0) {
    lines.push("", `Now answerable on the next autofill run (${visibleNowAnswerable.length} shown):`);
    for (const [index, row] of visibleNowAnswerable.entries()) {
      lines.push(`${index + 1}. ${row.entry.label} -> ${row.suggestion?.value} (${row.suggestion?.source})`);
      lines.push(
        `Type: ${row.entry.type} | Bucket: ${row.bucket} | Seen: ${row.entry.seenCount} | Last seen: ${row.entry.lastSeenAt}`,
      );
      if (row.entry.choices.length > 0) {
        lines.push(`Choices: ${summarizeChoices(row.entry.choices)}`);
      }
      lines.push("");
    }
  }

  lines.push("Use `browser save-application-answer` to capture a new explicit answer, then rerun this review.");
  print(lines.join("\n").trimEnd());
}

async function saveApplicationAnswer(bucket: AnswerBucket, pattern: string, value: string): Promise<void> {
  const normalizedPattern = normalizeApplicationAnswerPattern(pattern);
  const normalizedValue = value.trim();

  if (!normalizedPattern) {
    throw new Error("Application answer pattern cannot be empty.");
  }
  if (!normalizedValue) {
    throw new Error("Application answer value cannot be empty.");
  }

  const answers = await upsertApplicationAnswer(bucket, normalizedPattern, normalizedValue);
  const sync = await applyApplicationAnswersToQuestionBank(answers);

  print(
    [
      `Saved application answer: ${bucket}.${normalizedPattern} = ${normalizedValue}`,
      `Answer file: ${path.join(process.cwd(), "data", "application-answers.json")}`,
      `Question bank entries updated: ${sync.updatedCount}`,
    ].join("\n"),
  );
}

async function browserSaveApplicationAnswerInteractive(rl: readline.Interface): Promise<void> {
  const bucketInput = (await rl.question(`Bucket [${ANSWER_BUCKETS.join("/")}]: `)).trim().toLowerCase();
  if (!isAnswerBucket(bucketInput)) {
    throw new Error(`Invalid bucket. Use one of: ${ANSWER_BUCKETS.join(", ")}`);
  }

  const pattern = (await rl.question("Question pattern: ")).trim();
  const value = (await rl.question("Answer value: ")).trim();
  await saveApplicationAnswer(bucketInput, pattern, value);
}

type FollowUpReviewOptions = {
  days: number;
  limit: number;
  accountCount: number;
  query: string;
  readBodies: boolean;
  updateStatuses: boolean;
  includeStaleApplications: boolean;
  staleApplicationLimit: number;
  followUpAfterDays: number;
};

function parseFollowUpReviewOptions(args: string[] = []): FollowUpReviewOptions {
  const options: FollowUpReviewOptions = {
    days: readPositiveInteger(process.env.JAA_FOLLOW_UP_EMAIL_DAYS, 21),
    limit: readPositiveInteger(process.env.JAA_FOLLOW_UP_EMAIL_LIMIT, 30),
    accountCount: readPositiveInteger(process.env.JAA_GMAIL_ACCOUNT_COUNT, 2),
    query: process.env.JAA_FOLLOW_UP_GMAIL_QUERY?.trim() || "",
    readBodies: isTruthyEnv(process.env.JAA_FOLLOW_UP_READ_BODIES),
    updateStatuses: !isTruthyEnv(process.env.JAA_FOLLOW_UP_NO_STATUS_UPDATE),
    includeStaleApplications: !isTruthyEnv(process.env.JAA_FOLLOW_UP_NO_STALE_APPLICATIONS),
    staleApplicationLimit: readPositiveInteger(process.env.JAA_FOLLOW_UP_STALE_LIMIT, 12),
    followUpAfterDays: readPositiveInteger(process.env.JAA_FOLLOW_UP_AFTER_DAYS, 7),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--days" && next) {
      options.days = readPositiveInteger(next, options.days);
      index += 1;
    } else if (arg.startsWith("--days=")) {
      options.days = readPositiveInteger(arg.slice("--days=".length), options.days);
    } else if (arg === "--limit" && next) {
      options.limit = readPositiveInteger(next, options.limit);
      index += 1;
    } else if (arg.startsWith("--limit=")) {
      options.limit = readPositiveInteger(arg.slice("--limit=".length), options.limit);
    } else if (arg === "--accounts" && next) {
      options.accountCount = readPositiveInteger(next, options.accountCount);
      index += 1;
    } else if (arg.startsWith("--accounts=")) {
      options.accountCount = readPositiveInteger(arg.slice("--accounts=".length), options.accountCount);
    } else if (arg === "--query" && next) {
      options.query = next.trim();
      index += 1;
    } else if (arg.startsWith("--query=")) {
      options.query = arg.slice("--query=".length).trim();
    } else if (arg === "--read-bodies") {
      options.readBodies = true;
    } else if (arg === "--no-status-update") {
      options.updateStatuses = false;
    } else if (arg === "--no-stale") {
      options.includeStaleApplications = false;
    } else if (arg === "--stale-limit" && next) {
      options.staleApplicationLimit = readPositiveInteger(next, options.staleApplicationLimit);
      index += 1;
    } else if (arg.startsWith("--stale-limit=")) {
      options.staleApplicationLimit = readPositiveInteger(arg.slice("--stale-limit=".length), options.staleApplicationLimit);
    } else if (arg === "--follow-up-after-days" && next) {
      options.followUpAfterDays = readPositiveInteger(next, options.followUpAfterDays);
      index += 1;
    } else if (arg.startsWith("--follow-up-after-days=")) {
      options.followUpAfterDays = readPositiveInteger(
        arg.slice("--follow-up-after-days=".length),
        options.followUpAfterDays,
      );
    }
  }

  options.days = Math.max(1, Math.min(options.days, 90));
  options.limit = Math.max(1, Math.min(options.limit, 100));
  options.accountCount = Math.max(1, Math.min(options.accountCount, 5));
  options.staleApplicationLimit = Math.max(0, Math.min(options.staleApplicationLimit, 100));
  options.followUpAfterDays = Math.max(1, Math.min(options.followUpAfterDays, 60));

  return options;
}

async function browserReviewFollowUps(args: string[] = []): Promise<void> {
  const options = parseFollowUpReviewOptions(args);
  const jobs = await getJobs();
  const existingActions = await getFollowUpActions();

  print(
    `Scanning Gmail follow-ups from the attached Chrome session (${options.days} days, ${options.accountCount} account${options.accountCount === 1 ? "" : "s"}).`,
  );

  const emails = await scanAttachedGmailFollowUpEmails({
    days: options.days,
    limit: options.limit,
    accountCount: options.accountCount,
    query: options.query,
    readBodies: options.readBodies,
  });

  const reconciled = reconcileFollowUpActions({
    existingActions,
    emails,
    jobs,
    includeStaleApplications: options.includeStaleApplications,
    staleApplicationLimit: options.staleApplicationLimit,
    followUpAfterDays: options.followUpAfterDays,
  });

  await saveFollowUpActions(reconciled.actions);

  let jobUpdateCount = 0;
  if (options.updateStatuses) {
    const jobUpdateResult = applyFollowUpActionsToJobs(jobs, reconciled.incomingActions);
    if (jobUpdateResult.updates.length > 0) {
      await saveJobs(jobUpdateResult.jobs);
      jobUpdateCount = jobUpdateResult.updates.length;
    }
  }

  printFollowUpReviewResult({
    emailsScanned: emails.length,
    createdCount: reconciled.createdCount,
    updatedCount: reconciled.updatedCount,
    staleApplicationCount: reconciled.staleApplicationCount,
    jobUpdateCount,
    actions: reconciled.actions,
  });
}

function printFollowUpReviewResult(result: {
  emailsScanned: number;
  createdCount: number;
  updatedCount: number;
  staleApplicationCount: number;
  jobUpdateCount: number;
  actions: FollowUpAction[];
}): void {
  const openActions = result.actions
    .filter((action) => action.status === "open")
    .sort(sortFollowUpActions)
    .slice(0, 12);

  const lines = [
    `Emails scanned: ${result.emailsScanned}`,
    `Follow-up actions created: ${result.createdCount}`,
    `Follow-up actions updated: ${result.updatedCount}`,
    `Stale applied-job follow-ups added: ${result.staleApplicationCount}`,
    `Job statuses updated: ${result.jobUpdateCount}`,
    `Open follow-ups: ${result.actions.filter((action) => action.status === "open").length}`,
  ];

  if (openActions.length > 0) {
    lines.push("", "Next actions:");
    for (const [index, action] of openActions.entries()) {
      lines.push(
        `${index + 1}. ${action.priority.toUpperCase()} | ${formatFollowUpCategory(action.category)} | ${action.jobTitle} @ ${action.company}`,
      );
      lines.push(`   ${action.nextAction}`);
      lines.push(`   Due: ${action.dueAt.slice(0, 10)} | Subject: ${action.subject}`);
    }
  }

  print(lines.join("\n"));
}

function formatFollowUpCategory(value: string): string {
  return value
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function browserAttachHelp(): void {
  print(
    [
      "Start real Chrome in debug mode with:",
      "powershell -ExecutionPolicy Bypass -File .\\start-debug-chrome.ps1",
      "",
      "Then log in manually in that Chrome window.",
      "",
      "After login, use:",
      "Canonical commands:",
      "npm run cli -- browser save-remote-jobs   Save or dismiss jobs from LinkedIn Remote Jobs",
      "npm run cli -- browser apply-saved-jobs   Apply the visible tracker jobs from LinkedIn Jobs Tracker",
      "npm run cli -- browser apply-job-url <url>   Apply one tracker job by URL",
      "npm run cli -- browser review-follow-ups   Read Gmail follow-up emails and update next actions",
      "npm run cli -- browser start-autopilot   Batch save Remote Jobs",
      "npm run cli -- browser start-full-autopilot   Batch apply Jobs Tracker jobs",
      "npm run cli -- browser attach-help   Setup instructions for browser automation",
      "",
      "Compatibility aliases only:",
      "npm run cli -- browser save-attached-jobs   Compatibility alias for browser save-remote-jobs",
      "npm run cli -- browser process-visible-jobs   Compatibility alias for browser save-remote-jobs",
      "npm run cli -- browser auto-apply-visible-jobs   Compatibility alias for browser apply-saved-jobs",
      "npm run cli -- browser auto-apply-saved-jobs   Compatibility alias for browser apply-saved-jobs",
      "",
      "Other browser tools:",
      "npm run cli -- browser review-linkedin-attached",
      "npm run cli -- browser capture-attached-current",
      "npm run cli -- browser collect-attached-jobs",
      "npm run cli -- browser enrich-saved-jobs",
      "npm run cli -- browser autofill-attached-current",
      "npm run cli -- browser auto-apply-attached-current",
      "npm run cli -- browser review-attached-form",
      "npm run cli -- browser autofill-attached-form",
      "npm run cli -- browser auto-apply-attached-form",
      "npm run cli -- browser process-visible-external-jobs",
      "",
      `CDP URL: ${process.env.JAA_CDP_URL || "http://127.0.0.1:9222"}`,
      `Launch command: ${getDebugChromeLaunchCommand("https://www.linkedin.com/login")}`,
    ].join("\n"),
  );
}

async function startDashboard(port?: number, open = true, publicTunnel = false): Promise<void> {
  const result = await ensureDashboardServer({ port, open });
  print(result.alreadyRunning ? `Dashboard already running: ${result.url}` : `Dashboard ready: ${result.url}`);

  if (!publicTunnel) {
    return;
  }

  const tunnel = await ensureDashboardPublicTunnel({ timeoutMs: 20_000 });
  if (tunnel.status === "running" && tunnel.publicUrl) {
    print(`Public URL: ${tunnel.publicUrl}`);
    return;
  }

  print(`Tunnel status: ${tunnel.status}`);
  if (tunnel.publicUrl) {
    print(`Public URL: ${tunnel.publicUrl}`);
  }
  if (tunnel.note) {
    print(tunnel.note);
  }
}

function printHelp(): void {
  print(
    [
      "Commands:",
      "/help",
      "/dashboard",
      "/profile show",
      "/profile edit",
      "/jobs",
      "/job add",
      "/job view <id>",
      "/job match <id>",
      "/job dedupe",
      "/job rank [limit]",
      "/job plan <id>",
      "/job linkedin <id>",
      "",
      "Canonical commands:",
      "/browser save-remote-jobs   Save or dismiss jobs from LinkedIn Remote Jobs",
      "/browser apply-saved-jobs   Apply the visible tracker jobs from LinkedIn Jobs Tracker",
      "/browser apply-job-url <url>   Apply one tracker job by URL",
      "/browser review-follow-ups   Read Gmail follow-up emails and update next actions",
      "/browser start-autopilot   Batch save Remote Jobs",
      "/browser start-full-autopilot   Batch apply Jobs Tracker jobs",
      "/browser attach-help   Setup instructions for browser automation",
      "",
      "Compatibility aliases only:",
      "/browser save-attached-jobs   Compatibility alias for browser save-remote-jobs",
      "/browser process-visible-jobs   Compatibility alias for browser save-remote-jobs",
      "/browser auto-apply-visible-jobs   Compatibility alias for browser apply-saved-jobs",
      "/browser auto-apply-saved-jobs   Compatibility alias for browser apply-saved-jobs",
      "/browser open <url>",
      "/browser review-current-form",
      "/browser autofill-current-form",
      "/browser review-form-url <url>",
      "/browser autofill-form-url <url>",
      "/browser auto-apply-form-url <url>",
      "/browser review-unanswered-questions [limit]",
      "/browser save-application-answer",
      "/browser capture <url>",
      "/browser capture-linkedin-current",
      "/browser review-linkedin-current",
      "/browser review-linkedin-attached",
      "/browser capture-attached-current",
      "/browser collect-attached-jobs",
      "/browser enrich-saved-jobs [limit]",
      "/browser autofill-attached-current",
      "/browser auto-apply-attached-current",
      "/browser review-attached-form",
      "/browser autofill-attached-form",
      "/browser auto-apply-attached-form",
      "/browser process-visible-external-jobs",
      "/browser export-external-apply-urls",
      "/browser triage-visible-jobs",
      "/browser review-follow-ups [--days 21] [--limit 30] [--read-bodies]",
      "/quit",
    ].join("\n"),
  );
}

async function chatMode(): Promise<void> {
  const rl = readline.createInterface({ input, output });

  print("Job Application Assistant");
  print("Type /help for commands.");

  while (true) {
    const line = (await rl.question("> ")).trim();

    if (!line) {
      continue;
    }

    if (line === "/quit") {
      rl.close();
      return;
    }

    if (line === "/help") {
      printHelp();
      continue;
    }

    if (line === "/dashboard") {
      await startDashboard();
      continue;
    }

    if (line === "/profile show") {
      print(JSON.stringify(await getProfile(), null, 2));
      continue;
    }

    if (line === "/profile edit") {
      await editProfile(rl);
      continue;
    }

    if (line === "/jobs") {
      await listJobs();
      continue;
    }

    if (line === "/job add") {
      await addJob(rl);
      continue;
    }

    if (line.startsWith("/job view ")) {
      await viewJob(line.replace("/job view ", "").trim());
      continue;
    }

    if (line.startsWith("/job match ")) {
      await jobMatch(line.replace("/job match ", "").trim());
      continue;
    }

    if (line === "/job dedupe") {
      await jobDedupe();
      continue;
    }

    if (line === "/job rank" || line.startsWith("/job rank ")) {
      await rankJobs(line.replace("/job rank", "").trim());
      continue;
    }

    if (line.startsWith("/job plan ")) {
      await jobPlan(line.replace("/job plan ", "").trim());
      continue;
    }

    if (line.startsWith("/job linkedin ")) {
      await jobLinkedIn(line.replace("/job linkedin ", "").trim());
      continue;
    }

    if (line.startsWith("/browser open ")) {
      await browserOpen(line.replace("/browser open ", "").trim());
      continue;
    }

    if (line === "/browser review-current-form") {
      await browserReviewCurrentForm();
      continue;
    }

    if (line === "/browser autofill-current-form") {
      await browserAutofillCurrentForm();
      continue;
    }

    if (line.startsWith("/browser review-form-url ")) {
      await browserReviewFormUrl(line.replace("/browser review-form-url ", "").trim());
      continue;
    }

    if (line.startsWith("/browser autofill-form-url ")) {
      await browserAutofillFormUrl(line.replace("/browser autofill-form-url ", "").trim());
      continue;
    }

    if (line.startsWith("/browser auto-apply-form-url ")) {
      await browserAutoApplyFormUrl(line.replace("/browser auto-apply-form-url ", "").trim());
      continue;
    }

    if (line === "/browser review-unanswered-questions" || line.startsWith("/browser review-unanswered-questions ")) {
      await browserReviewUnansweredQuestions(line.replace("/browser review-unanswered-questions", "").trim());
      continue;
    }

    if (line === "/browser save-application-answer") {
      await browserSaveApplicationAnswerInteractive(rl);
      continue;
    }

    if (line.startsWith("/browser capture ")) {
      await browserCapture(line.replace("/browser capture ", "").trim());
      continue;
    }

    if (line === "/browser capture-linkedin-current") {
      await browserCaptureLinkedInCurrent();
      continue;
    }

    if (line === "/browser review-linkedin-current") {
      await browserReviewLinkedInCurrent();
      continue;
    }

    if (line === "/browser attach-help") {
      browserAttachHelp();
      continue;
    }

    if (line === "/browser review-linkedin-attached") {
      await browserReviewLinkedInAttached();
      continue;
    }

    if (line === "/browser capture-attached-current") {
      await browserCaptureAttachedCurrent();
      continue;
    }

    if (line === "/browser collect-attached-jobs") {
      await browserCollectAttachedJobs();
      continue;
    }

    if (line === "/browser autofill-attached-current") {
      await browserAutofillAttached();
      continue;
    }

    if (line === "/browser auto-apply-attached-current") {
      await browserAutoApplyAttached();
      continue;
    }

    if (line === "/browser save-remote-jobs" || line === "/browser save-attached-jobs") {
      await browserSaveAttachedJobs();
      continue;
    }

    if (line.startsWith("/browser apply-job-url ")) {
      await browserApplyJobUrl(line.replace("/browser apply-job-url ", "").trim());
      continue;
    }

    if (line === "/browser apply-saved-jobs" || line === "/browser auto-apply-saved-jobs") {
      await browserApplySavedJobs();
      continue;
    }

    if (line === "/browser review-follow-ups" || line.startsWith("/browser review-follow-ups ")) {
      await browserReviewFollowUps(line.replace("/browser review-follow-ups", "").trim().split(/\s+/).filter(Boolean));
      continue;
    }

    if (line === "/browser enrich-saved-jobs" || line.startsWith("/browser enrich-saved-jobs ")) {
      await browserEnrichSavedJobs(line.replace("/browser enrich-saved-jobs", "").trim());
      continue;
    }

    if (line === "/browser process-visible-jobs") {
      await browserProcessVisibleJobs();
      continue;
    }

    if (line === "/browser auto-apply-visible-jobs") {
      await browserAutoApplyVisibleJobs();
      continue;
    }

    if (line === "/browser review-attached-form") {
      await browserReviewAttachedForm();
      continue;
    }

    if (line === "/browser autofill-attached-form") {
      await browserAutofillAttachedForm();
      continue;
    }

    if (line === "/browser auto-apply-attached-form") {
      await browserAutoApplyAttachedForm();
      continue;
    }

    if (line === "/browser process-visible-external-jobs") {
      await browserProcessVisibleExternalJobs();
      continue;
    }

    if (line === "/browser export-external-apply-urls") {
      await exportExternalApplyUrlsFromArtifacts();
      continue;
    }

    if (line === "/browser triage-visible-jobs") {
      await browserTriageVisibleJobs();
      continue;
    }

    if (line === "/browser start-autopilot") {
      await browserStartAutopilot();
      continue;
    }

    if (line === "/browser start-full-autopilot") {
      await browserStartFullAutopilot();
      continue;
    }

    const profile = await getProfile();
    const jobs = await getJobs();
    const reply = answerChat(line, profile, jobs);

    await appendConversation({ role: "user", content: line, createdAt: nowIso() });
    await appendConversation({ role: "assistant", content: reply, createdAt: nowIso() });

    print(reply);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [scope, action, ...rest] = args;
  const id = rest[0];
  const dashboardPortArg = args.find((value) => /^\d+$/.test(value));
  const dashboardPort =
    dashboardPortArg && Number.isFinite(Number(dashboardPortArg)) ? Number(dashboardPortArg) : undefined;
  const shouldOpenDashboard = !args.includes("--no-open");
  const shouldStartPublicTunnel = args.includes("--public");
  const rl = readline.createInterface({ input, output });

  try {
    if (!scope || scope === "chat") {
      rl.close();
      await chatMode();
      return;
    }

    if (scope === "dashboard") {
      rl.close();
      await startDashboard(dashboardPort, shouldOpenDashboard, shouldStartPublicTunnel);
      return;
    }

    if (scope === "profile" && action === "show") {
      rl.close();
      print(JSON.stringify(await getProfile(), null, 2));
      return;
    }

    if (scope === "profile" && action === "edit") {
      await editProfile(rl);
      rl.close();
      return;
    }

    if (scope === "job" && action === "add") {
      await addJob(rl);
      rl.close();
      return;
    }

    if (scope === "job" && action === "list") {
      rl.close();
      await listJobs();
      return;
    }

    if (scope === "job" && action === "view" && id) {
      rl.close();
      await viewJob(id);
      return;
    }

    if (scope === "job" && action === "match" && id) {
      rl.close();
      await jobMatch(id);
      return;
    }

    if (scope === "job" && action === "dedupe") {
      rl.close();
      await jobDedupe();
      return;
    }

    if (scope === "job" && action === "rank") {
      rl.close();
      await rankJobs(id);
      return;
    }

    if (scope === "job" && action === "plan" && id) {
      rl.close();
      await jobPlan(id);
      return;
    }

    if (scope === "job" && action === "linkedin" && id) {
      rl.close();
      await jobLinkedIn(id);
      return;
    }

    if (scope === "browser" && action === "open" && id) {
      rl.close();
      await browserOpen(id);
      return;
    }

    if (scope === "browser" && action === "review-current-form") {
      rl.close();
      await browserReviewCurrentForm();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "autofill-current-form") {
      rl.close();
      await browserAutofillCurrentForm();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "review-form-url" && id) {
      rl.close();
      await browserReviewFormUrl(id);
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "autofill-form-url" && id) {
      rl.close();
      await browserAutofillFormUrl(id);
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "auto-apply-form-url" && id) {
      rl.close();
      await browserAutoApplyFormUrl(id);
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "review-unanswered-questions") {
      rl.close();
      await browserReviewUnansweredQuestions(id);
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "save-application-answer") {
      if (!rest[0]) {
        await browserSaveApplicationAnswerInteractive(rl);
        rl.close();
        return;
      }

      const [bucketInput, patternArg, ...valueParts] = rest;
      const valueArg = valueParts.join(" ").trim();
      if (!bucketInput || !isAnswerBucket(bucketInput.toLowerCase()) || !patternArg || !valueArg) {
        rl.close();
        throw new Error(
          `Usage: npm run cli -- browser save-application-answer <${ANSWER_BUCKETS.join("|")}> "<pattern>" "<value>"`,
        );
      }

      rl.close();
      await saveApplicationAnswer(bucketInput.toLowerCase() as AnswerBucket, patternArg, valueArg);
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "capture" && id) {
      rl.close();
      await browserCapture(id);
      return;
    }

    if (scope === "browser" && action === "capture-linkedin-current") {
      rl.close();
      await browserCaptureLinkedInCurrent();
      return;
    }

    if (scope === "browser" && action === "review-linkedin-current") {
      rl.close();
      await browserReviewLinkedInCurrent();
      return;
    }

    if (scope === "browser" && action === "attach-help") {
      rl.close();
      browserAttachHelp();
      return;
    }

    if (scope === "browser" && action === "review-linkedin-attached") {
      rl.close();
      await browserReviewLinkedInAttached();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "capture-attached-current") {
      rl.close();
      await browserCaptureAttachedCurrent();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "collect-attached-jobs") {
      rl.close();
      await browserCollectAttachedJobs();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "autofill-attached-current") {
      rl.close();
      await browserAutofillAttached();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "auto-apply-attached-current") {
      rl.close();
      await browserAutoApplyAttached();
      process.exit(0);
      return;
    }

    if (scope === "browser" && (action === "save-remote-jobs" || action === "save-attached-jobs")) {
      rl.close();
      await browserSaveAttachedJobs();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "apply-job-url" && id) {
      rl.close();
      await browserApplyJobUrl(id);
      process.exit(0);
      return;
    }

    if (scope === "browser" && (action === "apply-saved-jobs" || action === "auto-apply-saved-jobs")) {
      rl.close();
      await browserApplySavedJobs();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "review-follow-ups") {
      rl.close();
      await browserReviewFollowUps(rest);
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "enrich-saved-jobs") {
      rl.close();
      await browserEnrichSavedJobs(id);
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "process-visible-jobs") {
      rl.close();
      await browserProcessVisibleJobs();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "auto-apply-visible-jobs") {
      rl.close();
      await browserAutoApplyVisibleJobs();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "review-attached-form") {
      rl.close();
      await browserReviewAttachedForm();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "autofill-attached-form") {
      rl.close();
      await browserAutofillAttachedForm();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "auto-apply-attached-form") {
      rl.close();
      await browserAutoApplyAttachedForm();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "process-visible-external-jobs") {
      rl.close();
      await browserProcessVisibleExternalJobs();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "export-external-apply-urls") {
      rl.close();
      await exportExternalApplyUrlsFromArtifacts();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "triage-visible-jobs") {
      rl.close();
      await browserTriageVisibleJobs();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "start-autopilot") {
      rl.close();
      await browserStartAutopilot();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "start-full-autopilot") {
      rl.close();
      await browserStartFullAutopilot();
      process.exit(0);
      return;
    }

    rl.close();
    print("Unknown command. Run `npm run chat`, `npm run dashboard`, or see README.md.");
  } catch (error) {
    rl.close();
    print(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
    process.exit(1);
  }
}

void main();
