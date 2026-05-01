import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadApplicationAnswers,
  lookupApplicationAnswer,
  saveApplicationAnswers as saveSharedApplicationAnswers,
  type ApplicationAnswers,
} from "./applicationAnswers.js";
import {
  getJobEvaluationDecisions,
  getFollowUpActions,
  getJobs,
  getProfile,
  updateJob,
} from "./store.js";
import {
  getJobEvaluationProfiles,
  saveJobEvaluationProfiles,
  setActiveJobEvaluationProfile,
} from "./jobEvaluation.js";
import { sortFollowUpActions } from "./followUps.js";
import {
  applyApplicationAnswersToQuestionBank,
  loadQuestionBank,
  type QuestionBankEntry,
} from "./questionBank.js";
import {
  JOB_STATUSES,
  type FollowUpAction,
  type Job,
  type JobEvaluationDecision,
  type JobEvaluationDecisionRecord,
  type JobEvaluationProfile,
  type JobEvaluationProfilesState,
  type JobStatus,
  type Profile,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const dataDir = path.join(repoRoot, "data");
const dashboardDir = path.join(repoRoot, "src", "dashboard");
const browserDataDir = path.join(repoRoot, "data", "browser");
const dashboardConfigPath = path.join(dataDir, "dashboard-config.json");
const applicationAnswersPath = path.join(dataDir, "application-answers.json");
const questionBankPath = path.join(dataDir, "question-bank.json");
const dashboardHost = "127.0.0.1";
const defaultDashboardPort = 3030;

const BOARD_STAGES = ["enrich", "ready", "external", "filed"] as const;
const FILED_STATUSES = new Set<JobStatus>(["applied", "interviewing", "closed"]);

const KNOWN_ARTIFACT_PREFIXES = [
  "linkedin-saved-external-apply-urls-unresolved",
  "linkedin-saved-external-apply-urls-resolved",
  "linkedin-saved-external-apply-urls-cleaned-by-jobid",
  "linkedin-saved-external-apply-urls-cleaned",
  "linkedin-saved-external-apply-urls-removed",
  "linkedin-saved-external-apply-urls-active",
  "linkedin-saved-external-apply-urls-final",
  "linkedin-saved-session-external-apply-urls",
  "linkedin-saved-external-apply-urls",
  "external-apply-preview-result",
  "external-apply-result",
  "external-apply-urls",
  "linkedin-apply-review-attached",
  "linkedin-apply-review",
  "linkedin-autofill",
  "site-form-autofill",
  "site-form-review",
  "gmail-follow-up-scan",
  "linkedin-job-descriptions",
  "persistent-job-enrichment",
  "linkedin-triage-results",
  "linkedin-saved-jobs",
  "linkedin-collection",
  "capture-attached",
  "capture",
];

const AUTOMATION_MODULES = [
  {
    key: "collection",
    label: "Collection",
    description: "Captures LinkedIn result cards from the visible collection/search page.",
  },
  {
    key: "capture",
    label: "Capture",
    description: "Captures a visible job page into a local draft entry.",
  },
  {
    key: "enrichment",
    label: "Enrichment",
    description: "Adds missing descriptions and metadata to saved jobs.",
  },
  {
    key: "triage",
    label: "Triage",
    description: "Screens visible jobs on the collection/search page before they move further into the workflow.",
  },
  {
    key: "linkedin",
    label: "Easy Apply Review",
    description: "Inspects LinkedIn Easy Apply flows and prepares autofill stops.",
  },
  {
    key: "external",
    label: "External Apply Extraction",
    description: "Finds employer apply URLs from LinkedIn jobs and records the route.",
  },
  {
    key: "employerForm",
    label: "Employer Form Review",
    description: "Reviews or autofills employer-hosted application forms.",
  },
  {
    key: "followUp",
    label: "Follow-up Review",
    description: "Reads post-application Gmail results and records next actions.",
  },
  {
    key: "other",
    label: "Other Artifacts",
    description: "Saved browser outputs that do not map to a named automation module.",
  },
] as const;

type DashboardActionDefinitionInput = {
  id: string;
  group: string;
  label: string;
  description: string;
  commandPreview: string;
  requiresUrl?: boolean;
  usesEnrichLimit?: boolean;
  usesBatchLimit?: boolean;
  usesPageLimit?: boolean;
};

const ACTION_DEFINITIONS = [
  {
    id: "start-debug-browser",
    group: "Setup",
    label: "Open LinkedIn Session",
    description: "Launch Chrome with remote debugging so the save and apply flows can run.",
    commandPreview: "powershell -ExecutionPolicy Bypass -File .\\start-debug-chrome.ps1",
  },
  {
    id: "browser-save-remote-jobs",
    group: "Remote Jobs",
    label: "Save Remote Jobs",
    description: "Screen LinkedIn Remote Jobs across multiple pages and save or dismiss by criteria.",
    commandPreview: "npm run cli -- browser save-remote-jobs",
  },
  {
    id: "browser-apply-job-url",
    group: "Jobs Tracker",
    label: "Apply Saved Job in Jobs Tracker",
    description: "Open a specific LinkedIn Jobs Tracker job URL and submit the LinkedIn or employer flow when answerable.",
    commandPreview: "npm run cli -- browser apply-job-url <url>",
    requiresUrl: true,
  },
  {
    id: "browser-review-linkedin-attached",
    group: "Jobs Tracker",
    label: "Review Current LinkedIn",
    description: "Inspect the current LinkedIn Easy Apply flow in the attached Chrome window after you open a tracker item.",
    commandPreview: "npm run cli -- browser review-linkedin-attached",
  },
  {
    id: "browser-auto-apply-attached-current",
    group: "Jobs Tracker",
    label: "Auto Apply Current Job",
    description: "Run the current LinkedIn Easy Apply flow in the attached Chrome window.",
    commandPreview: "npm run cli -- browser auto-apply-attached-current",
  },
  {
    id: "browser-start-autopilot",
    group: "Remote Jobs",
    label: "Save Remote Jobs",
    description: "Start the LinkedIn Remote Jobs save automation from the remote-jobs collection.",
    commandPreview: "npm run cli -- browser start-autopilot",
  },
  {
    id: "browser-start-full-autopilot",
    group: "Jobs Tracker",
    label: "Apply Saved Jobs",
    description: "Apply the saved local queue with parallel subprocesses, using visible Jobs Tracker items first and falling back to direct job pages.",
    commandPreview: "npm run cli -- browser start-full-autopilot",
  },
  {
    id: "browser-review-follow-ups",
    group: "Follow Up",
    label: "Review Follow-up Emails",
    description: "Scan Gmail for employer replies, classify each message, and update the local follow-up queue.",
    commandPreview: "npm run cli -- browser review-follow-ups",
  },
] as const satisfies readonly DashboardActionDefinitionInput[];

type AutomationStage = (typeof BOARD_STAGES)[number];
type AutomationModuleKey = (typeof AUTOMATION_MODULES)[number]["key"];
type DashboardActionId = (typeof ACTION_DEFINITIONS)[number]["id"];
type DashboardActionDefinition = DashboardActionDefinitionInput & { id: DashboardActionId };

type DashboardActionOptions = {
  url?: string;
  enrichLimit?: number;
  batchLimit?: number;
  pageLimit?: number;
};

type DashboardActionRunStatus = "running" | "completed" | "failed" | "stopped";

type DashboardActionRun = {
  runId: string;
  actionId: DashboardActionId;
  label: string;
  commandPreview: string;
  status: DashboardActionRunStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  pid: number | null;
  options: DashboardActionOptions;
  targetJobId: string;
  targetJobTitle: string;
  targetJobCompany: string;
  producedArtifacts: BrowserArtifactSummary[];
  logs: string[];
};

type DashboardJobActionState = {
  activeRun: DashboardActionRun | null;
  lastRun: DashboardActionRun | null;
  recentRuns: DashboardActionRun[];
};

type DashboardActionRunnerSnapshot = {
  activeRun: DashboardActionRun | null;
  recentRuns: DashboardActionRun[];
  jobStates: Record<string, DashboardJobActionState>;
  actions: DashboardActionDefinition[];
  defaults: {
    url: string;
    enrichLimit: number;
    batchLimit: number;
    pageLimit: number;
  };
};

type DashboardTunnelMode = "quick" | "named";
type DashboardTunnelStatus =
  | "unavailable"
  | "idle"
  | "starting"
  | "running"
  | "stopped"
  | "error";

type DashboardTunnelConfigSource = "none" | "file" | "env";

type DashboardTunnelConfig = {
  preferredMode: DashboardTunnelMode;
  token: string;
  publicHostname: string;
  tunnelName: string;
};

type DashboardConfig = {
  tunnel: DashboardTunnelConfig;
};

type DashboardTunnelSnapshot = {
  available: boolean;
  status: DashboardTunnelStatus;
  mode: DashboardTunnelMode;
  preferredMode: DashboardTunnelMode;
  namedTunnelConfigured: boolean;
  tokenConfigured: boolean;
  publicHostname: string;
  tunnelName: string;
  configSource: DashboardTunnelConfigSource;
  binaryPath: string;
  targetUrl: string;
  publicUrl: string;
  startedAt: string | null;
  endedAt: string | null;
  pid: number | null;
  note: string;
  error: string;
  logs: string[];
};

type ProfileSummary = {
  data: Profile;
  completionScore: number;
  completedFields: number;
  totalFields: number;
  missingFields: string[];
};

type ApplicationAnswerBucket = keyof ApplicationAnswers;

type QuestionReviewEntry = QuestionBankEntry & {
  bucket: ApplicationAnswerBucket;
  suggestedAnswer: string;
  currentAnswer: string;
};

type QuestionReviewSnapshot = {
  totalQuestions: number;
  unresolvedCount: number;
  answeredCount: number;
  bucketCounts: Record<ApplicationAnswerBucket, number>;
  unresolvedQuestions: QuestionReviewEntry[];
  answeredQuestions: QuestionReviewEntry[];
};

type BrowserArtifactSummary = {
  name: string;
  prefix: string;
  category: string;
  moduleKey: AutomationModuleKey;
  extension: string;
  size: number;
  updatedAt: string;
};

type ExternalApplySignal = {
  externalApplyFound: boolean;
  destinationUrl: string;
  destinationTitle: string;
  workloadFiltered: boolean;
  workloadScore: number | null;
  workloadReasons: string[];
  updatedAt: string;
};

type LinkedInReviewSignal = {
  hasEasyApply: boolean;
  stage: string;
  primaryAction: string;
  fieldCount: number;
  updatedAt: string;
};

type DashboardEvaluationSnapshot = {
  profiles: JobEvaluationProfilesState;
  activeProfile: JobEvaluationProfile;
  stats: {
    trackedCount: number;
    savedCount: number;
    dismissedCount: number;
    skippedCount: number;
  };
  decisions: JobEvaluationDecisionRecord[];
  recentDecisions: JobEvaluationDecisionRecord[];
  savedDecisions: JobEvaluationDecisionRecord[];
  dismissedDecisions: JobEvaluationDecisionRecord[];
  skippedDecisions: JobEvaluationDecisionRecord[];
};

type DashboardJob = Job & {
  displayTitle: string;
  displayCompany: string;
  descriptionSnippet: string;
  normalizedUrl: string;
  hasDescription: boolean;
  hasUnknownCompany: boolean;
  isDuplicateUrl: boolean;
  ageInDays: number;
  automationStage: AutomationStage;
  automationSummary: string;
  nextAutomationStep: string;
  attentionReasons: string[];
  externalApplyFound: boolean;
  externalApplyDestinationUrl: string;
  externalApplyDestinationTitle: string;
  linkedInApplyReviewed: boolean;
  linkedInReviewStage: string;
  linkedInPrimaryAction: string;
  linkedInFieldCount: number;
  workloadFiltered: boolean;
  workloadReasons: string[];
  evaluationDecision: JobEvaluationDecision | "";
  evaluationScore: number | null;
  evaluationReasons: string[];
  evaluationProfileName: string;
  evaluationProfileSummary: string;
  evaluationTrackedAt: string;
  evaluationTrackedBy: string;
  evaluationAlreadySaved: boolean;
  latestAutomationEventAt: string;
};

type ActivityItem = {
  id: string;
  kind: "job" | "artifact" | "external";
  title: string;
  detail: string;
  timestamp: string;
  targetJobId?: string;
};

type AutomationModuleSummary = {
  key: AutomationModuleKey;
  label: string;
  description: string;
  fileCount: number;
  latestAt: string | null;
  status: string;
};

type DashboardFollowUpSnapshot = {
  totalCount: number;
  openCount: number;
  waitingCount: number;
  highPriorityCount: number;
  dueCount: number;
  latestDetectedAt: string;
  actions: FollowUpAction[];
  openActions: FollowUpAction[];
  waitingActions: FollowUpAction[];
};

type DashboardSnapshot = {
  generatedAt: string;
  autofillProfile: ProfileSummary;
  evaluation: DashboardEvaluationSnapshot;
  answerCapture: QuestionReviewSnapshot;
  stats: {
    totalJobs: number;
    enrichedJobs: number;
    readyToFileJobs: number;
    externalApplyJobs: number;
    filedJobs: number;
    missingMetadataCount: number;
    duplicateUrlCount: number;
    workloadFilteredCount: number;
    browserArtifactCount: number;
    unresolvedQuestionCount: number;
    openFollowUpCount: number;
  };
  followUps: DashboardFollowUpSnapshot;
  automationBoardCounts: Record<AutomationStage, number>;
  sourceCounts: Array<{ source: string; count: number }>;
  jobs: DashboardJob[];
  attentionJobs: DashboardJob[];
  recentAutomationActivity: ActivityItem[];
  recentBrowserArtifacts: BrowserArtifactSummary[];
  automationModules: AutomationModuleSummary[];
  externalApplyJobs: DashboardJob[];
  actionRunner: DashboardActionRunnerSnapshot;
  tunnel: DashboardTunnelSnapshot;
};

type DashboardServerOptions = {
  port?: number;
  open?: boolean;
};

type AutomationSignals = {
  externalApplyByJob: Map<string, ExternalApplySignal>;
  linkedInReviewByJob: Map<string, LinkedInReviewSignal>;
};

type DashboardRunTarget = {
  id: string;
  title: string;
  company: string;
};

type ActionRunInternal = {
  run: DashboardActionRun;
  child: ChildProcess;
  stopRequested: boolean;
  baselineArtifacts: Map<string, string>;
};

type TunnelRunInternal = {
  child: ChildProcess;
  stopRequested: boolean;
  mode: DashboardTunnelMode;
};

let activeServer: Server | null = null;
let activeServerUrl = "";
let activeActionRun: ActionRunInternal | null = null;
let actionRunHistory: DashboardActionRun[] = [];
let activeTunnelRun: TunnelRunInternal | null = null;
let dashboardConfigState: DashboardConfig = createDefaultDashboardConfig();
let tunnelSnapshotState: DashboardTunnelSnapshot = createTunnelSnapshotState();

export async function ensureDashboardServer(
  options: DashboardServerOptions = {},
): Promise<{ url: string; alreadyRunning: boolean }> {
  const envPort = Number(process.env.JAA_DASHBOARD_PORT || defaultDashboardPort.toString());
  const requestedPort = options.port ?? envPort;
  const safePort =
    Number.isFinite(requestedPort) && requestedPort > 0 ? Math.floor(requestedPort) : defaultDashboardPort;

  if (activeServer && activeServerUrl) {
    if (options.open !== false) {
      openUrl(activeServerUrl);
    }

    return {
      url: activeServerUrl,
      alreadyRunning: true,
    };
  }

  await loadDashboardConfig();
  tunnelSnapshotState = createTunnelSnapshotState();

  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(safePort, dashboardHost, () => resolve());
  });

  server.on("close", () => {
    activeServer = null;
    activeServerUrl = "";
    if (activeTunnelRun) {
      activeTunnelRun.stopRequested = true;
      void stopChildProcess(activeTunnelRun.child);
    }
  });

  activeServer = server;
  activeServerUrl = `http://${dashboardHost}:${safePort}`;

  if (options.open !== false) {
    openUrl(activeServerUrl);
  }

  return {
    url: activeServerUrl,
    alreadyRunning: false,
  };
}

export async function ensureDashboardPublicTunnel(
  options: { timeoutMs?: number } = {},
): Promise<DashboardTunnelSnapshot> {
  if (!activeServerUrl) {
    throw new Error("Dashboard server is not running.");
  }

  if (!activeTunnelRun) {
    startDashboardTunnel();
  }

  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 20_000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snapshot = buildTunnelSnapshot();
    if (snapshot.status === "error") {
      throw new Error(snapshot.error || "Cloudflare Tunnel failed to start.");
    }

    if (snapshot.status === "running") {
      return snapshot;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return buildTunnelSnapshot();
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      response.end();
      return;
    }

    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      await serveStaticAsset(response, "index.html", "text/html; charset=utf-8");
      return;
    }

    if (method === "GET" && pathname === "/styles.css") {
      await serveStaticAsset(response, "styles.css", "text/css; charset=utf-8");
      return;
    }

    if (method === "GET" && pathname === "/app.js") {
      await serveStaticAsset(response, "app.js", "text/javascript; charset=utf-8");
      return;
    }

    if (method === "GET" && pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (method === "GET" && pathname === "/api/dashboard") {
      sendJson(response, 200, await buildDashboardSnapshot());
      return;
    }

    if (method === "GET" && pathname === "/api/evaluation-profiles") {
      sendJson(response, 200, await getJobEvaluationProfiles());
      return;
    }

    if (method === "PUT" && pathname === "/api/evaluation-profiles") {
      await handleEvaluationProfilesUpdate(request, response);
      return;
    }

    if (method === "PUT" && pathname === "/api/evaluation-profiles/active") {
      await handleActiveEvaluationProfileUpdate(request, response);
      return;
    }

    if (method === "POST" && pathname === "/api/actions/run") {
      await handleActionRun(request, response);
      return;
    }

    if (method === "POST" && pathname === "/api/actions/stop") {
      await handleActionStop(response);
      return;
    }

    if (method === "POST" && pathname === "/api/tunnel/start") {
      await handleTunnelStart(response);
      return;
    }

    if (method === "POST" && pathname === "/api/tunnel/stop") {
      await handleTunnelStop(response);
      return;
    }

    if (method === "PUT" && pathname === "/api/tunnel/config") {
      await handleTunnelConfigUpdate(request, response);
      return;
    }

    if (method === "PUT" && pathname === "/api/application-answers") {
      await handleApplicationAnswerUpdate(request, response);
      return;
    }

    if (method === "PUT" && pathname.startsWith("/api/jobs/")) {
      const jobId = decodeURIComponent(pathname.replace("/api/jobs/", "").trim());
      await handleJobUpdate(request, response, jobId);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown server error",
    });
  }
}

async function handleJobUpdate(
  request: IncomingMessage,
  response: ServerResponse,
  jobId: string,
): Promise<void> {
  if (!jobId) {
    sendJson(response, 400, { error: "Missing job id" });
    return;
  }

  const payload = await readJsonBody<{ status?: string; notes?: string }>(request);
  const nextStatus = payload.status;
  const nextNotes = payload.notes;

  if (!nextStatus && typeof nextNotes !== "string") {
    sendJson(response, 400, { error: "Nothing to update" });
    return;
  }

  if (nextStatus && !isJobStatus(nextStatus)) {
    sendJson(response, 400, { error: "Invalid job status" });
    return;
  }

  const updated = await updateJob(jobId, {
    ...(nextStatus ? { status: nextStatus as JobStatus } : {}),
    ...(typeof nextNotes === "string" ? { notes: nextNotes } : {}),
  });

  if (!updated) {
    sendJson(response, 404, { error: "Job not found" });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    job: updated,
  });
}

async function handleEvaluationProfilesUpdate(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const payload = await readJsonBody<{
    profiles?: JobEvaluationProfile[];
    activeProfileName?: string;
  }>(request);

  if (!Array.isArray(payload.profiles) || payload.profiles.length === 0) {
    sendJson(response, 400, { error: "At least one evaluation profile is required." });
    return;
  }

  try {
    const profileNames = payload.profiles
      .map((profile) => (typeof profile?.name === "string" ? profile.name.trim().toLowerCase() : ""))
      .filter(Boolean);
    const uniqueNames = new Set(profileNames);
    if (uniqueNames.size !== profileNames.length) {
      sendJson(response, 400, { error: "Evaluation profile names must be unique." });
      return;
    }

    const saved = await saveJobEvaluationProfiles({
      activeProfileName: typeof payload.activeProfileName === "string" ? payload.activeProfileName : "",
      profiles: payload.profiles,
    });

    sendJson(response, 200, {
      ok: true,
      profiles: saved,
    });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Could not save evaluation profiles",
    });
  }
}

async function handleActiveEvaluationProfileUpdate(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const payload = await readJsonBody<{ activeProfileName?: string; name?: string }>(request);
  const requestedName =
    typeof payload.activeProfileName === "string" && payload.activeProfileName.trim()
      ? payload.activeProfileName.trim()
      : typeof payload.name === "string"
        ? payload.name.trim()
        : "";

  if (!requestedName) {
    sendJson(response, 400, { error: "Missing active evaluation profile name" });
    return;
  }

  try {
    const saved = await setActiveJobEvaluationProfile(requestedName);
    sendJson(response, 200, {
      ok: true,
      profiles: saved,
    });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Could not switch the active evaluation profile",
    });
  }
}

async function handleApplicationAnswerUpdate(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const payload = await readJsonBody<{
    key?: string;
    label?: string;
    type?: string;
    answer?: string;
    bucket?: string;
    choices?: string[];
  }>(request);

  const label = cleanRepeatedText(typeof payload.label === "string" ? payload.label : "");
  const type = cleanRepeatedText(typeof payload.type === "string" ? payload.type : "");
  const answer = typeof payload.answer === "string" ? payload.answer.trim() : "";
  const key = typeof payload.key === "string" && payload.key.trim()
    ? payload.key.trim()
    : buildQuestionKey(label, type, Array.isArray(payload.choices) ? payload.choices : []);
  const bucket = normalizeAnswerBucket(payload.bucket, type);
  const targetBuckets = resolveAnswerBuckets(bucket, type);

  if (!label || !type) {
    sendJson(response, 400, { error: "Missing question label or type" });
    return;
  }

  if (!key.trim()) {
    sendJson(response, 400, { error: "Missing question key" });
    return;
  }

  const choices = Array.isArray(payload.choices)
    ? payload.choices.filter((choice): choice is string => typeof choice === "string" && choice.trim().length > 0)
    : [];

  const questionBank = await loadQuestionBank();
  const existingEntry = questionBank.entries.find((entry) => entry.key === key);
  const seenAt = existingEntry?.lastSeenAt || new Date().toISOString();
  const answers = await loadApplicationAnswers();
  applyApplicationAnswerUpdate(answers, targetBuckets, label, answer);
  await saveSharedApplicationAnswers(answers);

  if (answer) {
    await applyApplicationAnswersToQuestionBank(answers);
  } else {
    await persistUnansweredQuestion(questionBank.entries, {
      key,
      label,
      type,
      choices,
      seenAt,
    });
  }

  const updatedBank = await loadQuestionBank();
  const updatedEntry =
    updatedBank.entries.find((entry) => entry.key === key) ||
    ({
      key,
      label,
      type,
      choices,
      answer,
      status: answer ? "answered" : "unanswered",
      source: answer ? "application-answers" : "unanswered",
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      seenCount: existingEntry?.seenCount ?? 1,
    } satisfies QuestionBankEntry);

  sendJson(response, 200, {
    ok: true,
    question: buildQuestionReviewEntry(updatedEntry, answers),
  });
}

async function handleActionRun(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (activeActionRun) {
    sendJson(response, 409, {
      error: `Another action is already running: ${activeActionRun.run.label}`,
    });
    return;
  }

  const payload = await readJsonBody<{
    actionId?: string;
    url?: string;
    enrichLimit?: number;
    batchLimit?: number;
    pageLimit?: number;
    jobId?: string;
  }>(request);

  if (!payload.actionId || !isDashboardActionId(payload.actionId)) {
    sendJson(response, 400, { error: "Unknown dashboard action" });
    return;
  }

  try {
    const started = await startDashboardAction(
      payload.actionId,
      {
        url: typeof payload.url === "string" ? payload.url : undefined,
        enrichLimit: coercePositiveInteger(payload.enrichLimit),
        batchLimit: coercePositiveInteger(payload.batchLimit),
        pageLimit: coercePositiveInteger(payload.pageLimit),
      },
      typeof payload.jobId === "string" ? payload.jobId : undefined,
    );

    sendJson(response, 200, {
      ok: true,
      run: cloneActionRun(started.run),
    });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Action failed to start",
    });
  }
}

async function handleActionStop(response: ServerResponse): Promise<void> {
  if (!activeActionRun) {
    sendJson(response, 404, { error: "No dashboard action is currently running" });
    return;
  }

  const run = activeActionRun.run;
  activeActionRun.stopRequested = true;
  appendActionLog(activeActionRun, "Stop requested from dashboard UI.");

  await stopChildProcess(activeActionRun.child);

  sendJson(response, 200, {
    ok: true,
    run: cloneActionRun(run),
  });
}

async function handleTunnelStart(response: ServerResponse): Promise<void> {
  if (activeTunnelRun) {
    sendJson(response, 200, {
      ok: true,
      tunnel: cloneTunnelSnapshot(tunnelSnapshotState),
    });
    return;
  }

  try {
    startDashboardTunnel();
    sendJson(response, 200, {
      ok: true,
      tunnel: cloneTunnelSnapshot(tunnelSnapshotState),
    });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Tunnel failed to start",
    });
  }
}

async function handleTunnelStop(response: ServerResponse): Promise<void> {
  if (!activeTunnelRun) {
    sendJson(response, 404, { error: "No Cloudflare Tunnel is currently running" });
    return;
  }

  activeTunnelRun.stopRequested = true;
  appendTunnelLog("Stop requested from dashboard UI.");
  await stopChildProcess(activeTunnelRun.child);

  sendJson(response, 200, {
    ok: true,
    tunnel: cloneTunnelSnapshot(tunnelSnapshotState),
  });
}

async function handleTunnelConfigUpdate(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const payload = await readJsonBody<{
    preferredMode?: string;
    publicHostname?: string;
    tunnelName?: string;
    token?: string;
    clearToken?: boolean;
  }>(request);

  const current = dashboardConfigState.tunnel;
  const nextToken =
    payload.clearToken
      ? ""
      : typeof payload.token === "string" && payload.token.trim()
        ? payload.token.trim()
        : current.token;

  const nextConfig = normalizeDashboardConfig({
    tunnel: {
      preferredMode: payload.preferredMode ?? current.preferredMode,
      publicHostname: payload.publicHostname ?? current.publicHostname,
      tunnelName: payload.tunnelName ?? current.tunnelName,
      token: nextToken,
    },
  });

  await saveDashboardConfig(nextConfig);
  tunnelSnapshotState = {
    ...buildTunnelSnapshot(),
    logs: [...tunnelSnapshotState.logs],
  };

  sendJson(response, 200, {
    ok: true,
    tunnel: cloneTunnelSnapshot(tunnelSnapshotState),
  });
}

async function serveStaticAsset(
  response: ServerResponse,
  assetName: string,
  contentType: string,
): Promise<void> {
  const assetPath = path.join(dashboardDir, assetName);
  const contents = await readFile(assetPath, "utf8");
  response.writeHead(200, { "Content-Type": contentType });
  response.end(contents);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(nextChunk);

    if (Buffer.concat(chunks).byteLength > 1_000_000) {
      throw new Error("Request body too large");
    }
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function startDashboardAction(
  actionId: DashboardActionId,
  options: DashboardActionOptions,
  targetJobId?: string,
): Promise<ActionRunInternal> {
  const definition = ACTION_DEFINITIONS.find((action) => action.id === actionId) as
    | DashboardActionDefinition
    | undefined;
  if (!definition) {
    throw new Error("Unknown dashboard action");
  }

  if (definition.requiresUrl && !options.url?.trim()) {
    throw new Error("This action requires a URL.");
  }

  const [baselineArtifacts, targetJob] = await Promise.all([
    listBrowserArtifacts(),
    resolveRunTargetJob(targetJobId),
  ]);
  const execution = buildActionExecution(definition, options);
  const run: DashboardActionRun = {
    runId: `${actionId}-${Date.now()}`,
    actionId,
    label: definition.label,
    commandPreview: execution.commandPreview,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    pid: null,
    options: execution.sanitizedOptions,
    targetJobId: targetJob?.id ?? "",
    targetJobTitle: targetJob?.title ?? "",
    targetJobCompany: targetJob?.company ?? "",
    producedArtifacts: [],
    logs: [],
  };

  const child = spawn(execution.command, execution.args, {
    cwd: execution.cwd,
    env: execution.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  run.pid = child.pid ?? null;

  const internal: ActionRunInternal = {
    run,
    child,
    stopRequested: false,
    baselineArtifacts: indexArtifacts(baselineArtifacts),
  };

  activeActionRun = internal;
  appendActionLog(internal, `Starting ${definition.label}.`);
  if (targetJob) {
    appendActionLog(internal, `Focused job: ${targetJob.title} @ ${targetJob.company}.`);
  }
  appendActionLog(internal, execution.commandPreview);
  pipeChildOutput(internal, child.stdout, "OUT");
  pipeChildOutput(internal, child.stderr, "ERR");

  child.on("error", (error) => {
    appendActionLog(internal, `Process error: ${error.message}`);
  });

  child.on("close", (code, signal) => {
    void finalizeActionRun(internal, code, signal);
  });

  return internal;
}

async function resolveRunTargetJob(jobId?: string): Promise<DashboardRunTarget | null> {
  if (!jobId?.trim()) {
    return null;
  }

  const jobs = await getJobs();
  const match = jobs.find((job) => job.id === jobId.trim());

  if (!match) {
    return null;
  }

  return {
    id: match.id,
    title: cleanRepeatedText(match.title) || "Untitled role",
    company: cleanRepeatedText(match.company) || "Unknown company",
  };
}

function buildActionExecution(
  definition: DashboardActionDefinition,
  options: DashboardActionOptions,
): {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  commandPreview: string;
  sanitizedOptions: DashboardActionOptions;
} {
  if (definition.id === "start-debug-browser") {
    const scriptPath = path.join(repoRoot, "start-debug-chrome.ps1");
    return {
      command: "powershell",
      args: ["-ExecutionPolicy", "Bypass", "-File", scriptPath],
      cwd: repoRoot,
      env: { ...process.env },
      commandPreview: definition.commandPreview,
      sanitizedOptions: {},
    };
  }

  const browserArgs = buildBrowserCliArgs(definition.id, options);
  const env: NodeJS.ProcessEnv = { ...process.env };
  const cliExecution = resolveCliExecution(browserArgs);

  if (definition.usesBatchLimit && options.batchLimit) {
    env.JAA_BATCH_LIMIT = String(options.batchLimit);
  }

  if (definition.usesPageLimit && options.pageLimit) {
    env.JAA_PAGE_LIMIT = String(options.pageLimit);
  }

  return {
    command: cliExecution.command,
    args: cliExecution.args,
    cwd: repoRoot,
    env,
    commandPreview: cliExecution.commandPreview,
    sanitizedOptions: {
      ...(options.url?.trim() ? { url: options.url.trim() } : {}),
      ...(definition.usesEnrichLimit && options.enrichLimit ? { enrichLimit: options.enrichLimit } : {}),
      ...(definition.usesBatchLimit && options.batchLimit ? { batchLimit: options.batchLimit } : {}),
      ...(definition.usesPageLimit && options.pageLimit ? { pageLimit: options.pageLimit } : {}),
    },
  };
}

function resolveCliExecution(browserArgs: string[]): {
  command: string;
  args: string[];
  commandPreview: string;
} {
  const compiledEntry = path.join(repoRoot, "dist", "index.js");
  if (existsSync(compiledEntry)) {
    return {
      command: process.execPath,
      args: [compiledEntry, ...browserArgs],
      commandPreview: `${path.basename(process.execPath)} dist/index.js ${browserArgs.join(" ")}`.trim(),
    };
  }

  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  return {
    command: process.execPath,
    args: [tsxCli, path.join(repoRoot, "src", "index.ts"), ...browserArgs],
    commandPreview: `${path.basename(process.execPath)} node_modules/tsx/dist/cli.mjs src/index.ts ${browserArgs.join(" ")}`.trim(),
  };
}

function buildBrowserCliArgs(
  actionId: DashboardActionId,
  options: DashboardActionOptions,
): string[] {
  switch (actionId) {
    case "browser-save-remote-jobs":
      return ["browser", "save-remote-jobs"];
    case "browser-apply-job-url":
      return ["browser", "apply-job-url", options.url!.trim()];
    case "browser-review-linkedin-attached":
      return ["browser", "review-linkedin-attached"];
    case "browser-auto-apply-attached-current":
      return ["browser", "auto-apply-attached-current"];
    case "browser-start-autopilot":
      return ["browser", "start-autopilot"];
    case "browser-start-full-autopilot":
      return ["browser", "start-full-autopilot"];
    case "browser-review-follow-ups":
      return ["browser", "review-follow-ups"];
    case "start-debug-browser":
      return [];
  }
}

function pipeChildOutput(
  actionRun: ActionRunInternal,
  stream: NodeJS.ReadableStream | null,
  prefix: "OUT" | "ERR",
): void {
  if (!stream) {
    return;
  }

  let buffer = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        appendActionLog(actionRun, `${prefix}: ${trimmed}`);
      }
    }
  });

  stream.on("end", () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      appendActionLog(actionRun, `${prefix}: ${trimmed}`);
    }
  });
}

function appendActionLog(actionRun: ActionRunInternal, message: string): void {
  const timestamp = new Date().toISOString();
  actionRun.run.logs.push(`[${timestamp}] ${message}`);

  if (actionRun.run.logs.length > 250) {
    actionRun.run.logs.splice(0, actionRun.run.logs.length - 250);
  }
}

async function finalizeActionRun(
  actionRun: ActionRunInternal,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  const sameRunIsActive = activeActionRun?.run.runId === actionRun.run.runId;
  actionRun.run.endedAt = new Date().toISOString();
  actionRun.run.exitCode = code;

  try {
    const browserArtifacts = await listBrowserArtifacts();
    actionRun.run.producedArtifacts = collectRunArtifacts(actionRun, browserArtifacts);

    if (actionRun.run.producedArtifacts.length > 0) {
      appendActionLog(
        actionRun,
        `Captured ${actionRun.run.producedArtifacts.length} artifact${actionRun.run.producedArtifacts.length === 1 ? "" : "s"} during this run.`,
      );
    }
  } catch (error) {
    appendActionLog(
      actionRun,
      `Artifact scan failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  if (actionRun.stopRequested) {
    actionRun.run.status = "stopped";
    appendActionLog(actionRun, "Action stopped from dashboard UI.");
  } else if (code === 0) {
    actionRun.run.status = "completed";
    appendActionLog(actionRun, "Action completed successfully.");
  } else {
    actionRun.run.status = "failed";
    appendActionLog(
      actionRun,
      `Action failed${code !== null ? ` with exit code ${code}` : ""}${signal ? ` (${signal})` : ""}.`,
    );
  }

  actionRunHistory.unshift(cloneActionRun(actionRun.run));
  actionRunHistory = actionRunHistory.slice(0, 12);

  if (sameRunIsActive) {
    activeActionRun = null;
  }
}

function buildActionRunnerSnapshot(browserArtifacts: BrowserArtifactSummary[]): DashboardActionRunnerSnapshot {
  const activeRun = activeActionRun ? cloneActionRun(activeActionRun.run) : null;

  if (activeRun && activeActionRun) {
    activeRun.producedArtifacts = collectRunArtifacts(activeActionRun, browserArtifacts).map(cloneBrowserArtifact);
  }

  const recentRuns = actionRunHistory.map((run) => cloneActionRun(run));

  return {
    activeRun,
    recentRuns,
    jobStates: buildJobActionStates(activeRun, recentRuns),
    actions: ACTION_DEFINITIONS.map((action) => ({ ...action }) as DashboardActionDefinition),
    defaults: {
      url: "https://www.linkedin.com/jobs-tracker/",
      enrichLimit: 10,
      batchLimit: 25,
      pageLimit: 3,
    },
  };
}

function cloneActionRun(run: DashboardActionRun): DashboardActionRun {
  return {
    ...run,
    options: { ...run.options },
    producedArtifacts: run.producedArtifacts.map(cloneBrowserArtifact),
    logs: [...run.logs],
  };
}

function cloneBrowserArtifact(artifact: BrowserArtifactSummary): BrowserArtifactSummary {
  return {
    ...artifact,
  };
}

function buildJobActionStates(
  activeRun: DashboardActionRun | null,
  recentRuns: DashboardActionRun[],
): Record<string, DashboardJobActionState> {
  const grouped = new Map<string, DashboardActionRun[]>();

  for (const run of recentRuns) {
    if (!run.targetJobId) {
      continue;
    }

    const matches = grouped.get(run.targetJobId) ?? [];
    matches.push(run);
    grouped.set(run.targetJobId, matches);
  }

  const jobIds = new Set<string>();
  if (activeRun?.targetJobId) {
    jobIds.add(activeRun.targetJobId);
  }
  for (const jobId of grouped.keys()) {
    jobIds.add(jobId);
  }

  const states: Record<string, DashboardJobActionState> = {};

  for (const jobId of jobIds) {
    const jobRuns = grouped.get(jobId) ?? [];
    states[jobId] = {
      activeRun: activeRun?.targetJobId === jobId ? cloneActionRun(activeRun) : null,
      lastRun: jobRuns[0] ? cloneActionRun(jobRuns[0]) : null,
      recentRuns: jobRuns.slice(0, 3).map((run) => cloneActionRun(run)),
    };
  }

  return states;
}

function collectRunArtifacts(
  actionRun: ActionRunInternal,
  browserArtifacts: BrowserArtifactSummary[],
): BrowserArtifactSummary[] {
  return browserArtifacts
    .filter((artifact) => actionRun.baselineArtifacts.get(artifact.name) !== artifactSignature(artifact))
    .map(cloneBrowserArtifact);
}

function indexArtifacts(artifacts: BrowserArtifactSummary[]): Map<string, string> {
  return new Map(artifacts.map((artifact) => [artifact.name, artifactSignature(artifact)]));
}

function artifactSignature(artifact: Pick<BrowserArtifactSummary, "name" | "size" | "updatedAt">): string {
  return `${artifact.name}:${artifact.size}:${artifact.updatedAt}`;
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("close", () => resolve());
      killer.on("error", () => resolve());
    });
    return;
  }

  child.kill("SIGTERM");
}

function isDashboardActionId(value: string): value is DashboardActionId {
  return ACTION_DEFINITIONS.some((action) => action.id === value);
}

function coercePositiveInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

function createDefaultDashboardConfig(): DashboardConfig {
  return {
    tunnel: {
      preferredMode: "quick",
      token: "",
      publicHostname: "",
      tunnelName: "job-assistant-dashboard",
    },
  };
}

async function loadDashboardConfig(): Promise<void> {
  try {
    const contents = await readFile(dashboardConfigPath, "utf8");
    const parsed = JSON.parse(contents) as unknown;
    dashboardConfigState = normalizeDashboardConfig(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      dashboardConfigState = createDefaultDashboardConfig();
      return;
    }

    dashboardConfigState = createDefaultDashboardConfig();
  }
}

async function saveDashboardConfig(config: DashboardConfig): Promise<void> {
  const normalized = normalizeDashboardConfig(config);
  await mkdir(dataDir, { recursive: true });
  await writeFile(dashboardConfigPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  dashboardConfigState = normalized;
}

async function persistUnansweredQuestion(
  entries: QuestionBankEntry[],
  question: {
    key: string;
    label: string;
    type: string;
    choices: string[];
    seenAt: string;
  },
): Promise<void> {
  const existing = entries.find((entry) => entry.key === question.key);

  if (existing) {
    existing.label = question.label;
    existing.type = question.type;
    existing.choices = question.choices;
    existing.lastSeenAt = question.seenAt;
    existing.seenCount += 1;
    existing.answer = "";
    existing.status = "unanswered";
    existing.source = "unanswered";
  } else {
    entries.push({
      key: question.key,
      label: question.label,
      type: question.type,
      choices: question.choices,
      answer: "",
      status: "unanswered",
      source: "unanswered",
      firstSeenAt: question.seenAt,
      lastSeenAt: question.seenAt,
      seenCount: 1,
    });
  }

  entries.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  await mkdir(dataDir, { recursive: true });
  await writeFile(questionBankPath, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
}

function normalizeDashboardConfig(value: unknown): DashboardConfig {
  const fallback = createDefaultDashboardConfig();
  const tunnel =
    typeof value === "object" && value !== null && "tunnel" in value
      ? (value as { tunnel?: Record<string, unknown> }).tunnel
      : undefined;

  return {
    tunnel: {
      preferredMode: normalizeTunnelMode(tunnel?.preferredMode ?? fallback.tunnel.preferredMode),
      token: normalizeSecret(tunnel?.token),
      publicHostname: normalizeHostname(tunnel?.publicHostname),
      tunnelName: normalizeTunnelName(tunnel?.tunnelName),
    },
  };
}

function normalizeTunnelMode(value: unknown): DashboardTunnelMode {
  return value === "named" ? "named" : "quick";
}

function normalizeSecret(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHostname(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "";
  }

  const withoutProtocol = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return withoutProtocol.toLowerCase();
}

function normalizeTunnelName(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw || "job-assistant-dashboard";
}

function buildQuestionKey(label: string, type: string, choices: string[] = []): string {
  const normalizedChoices = choices.map((choice) => normalizeQuestionText(choice)).filter(Boolean).sort().join("|");
  return [normalizeQuestionText(label), normalizeQuestionText(type), normalizedChoices].join("::");
}

function normalizeQuestionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveAnswerBucket(type: string): ApplicationAnswerBucket {
  const normalizedType = normalizeQuestionText(type);

  if (normalizedType.includes("checkbox")) {
    return "checkbox";
  }

  if (normalizedType.includes("radio")) {
    return "radio";
  }

  if (
    normalizedType.includes("select") ||
    normalizedType.includes("dropdown") ||
    normalizedType.includes("combobox")
  ) {
    return "select";
  }

  return "text";
}

function normalizeAnswerBucket(bucket: unknown, type: string): ApplicationAnswerBucket {
  if (bucket === "text" || bucket === "select" || bucket === "radio" || bucket === "checkbox") {
    return bucket;
  }

  return resolveAnswerBucket(type);
}

function resolveAnswerBuckets(
  bucket: string,
  type: string,
): ApplicationAnswerBucket[] {
  if (bucket === "all") {
    return ["text", "select", "radio", "checkbox"];
  }

  const resolvedBucket = normalizeAnswerBucket(bucket, type);
  return resolvedBucket === "text" ? ["text"] : [resolvedBucket, "text"];
}

function applyApplicationAnswerUpdate(
  answers: ApplicationAnswers,
  buckets: ApplicationAnswerBucket[],
  label: string,
  answer: string,
): void {
  for (const bucket of buckets) {
    const records = answers[bucket];
    const existingKey = Object.keys(records).find((key) => normalizeQuestionText(key) === normalizeQuestionText(label));

    if (!answer) {
      if (existingKey) {
        delete records[existingKey];
      }
      continue;
    }

    if (existingKey && existingKey !== label.trim()) {
      delete records[existingKey];
    }

    records[cleanRepeatedText(label) || label.trim()] = answer;
  }
}

function toHttpsUrl(hostname: string): string {
  if (!hostname) {
    return "";
  }

  return hostname.startsWith("http://") || hostname.startsWith("https://")
    ? hostname.replace(/\/+$/, "")
    : `https://${hostname}`;
}

function getEffectiveTunnelConfig(): DashboardTunnelConfig & { configSource: DashboardTunnelConfigSource } {
  const envToken = normalizeSecret(process.env.JAA_CLOUDFLARE_TUNNEL_TOKEN);
  const envHostname = normalizeHostname(process.env.JAA_CLOUDFLARE_PUBLIC_HOSTNAME);
  const envTunnelName = normalizeTunnelName(process.env.JAA_CLOUDFLARE_TUNNEL_NAME);
  const envModeRaw = process.env.JAA_CLOUDFLARE_TUNNEL_MODE;
  const hasEnvOverrides = Boolean(envToken || envHostname || envModeRaw || process.env.JAA_CLOUDFLARE_TUNNEL_NAME);

  if (hasEnvOverrides) {
    const preferredMode =
      envModeRaw !== undefined
        ? normalizeTunnelMode(envModeRaw)
        : envToken && envHostname
          ? "named"
          : dashboardConfigState.tunnel.preferredMode;

    return {
      preferredMode,
      token: envToken || dashboardConfigState.tunnel.token,
      publicHostname: envHostname || dashboardConfigState.tunnel.publicHostname,
      tunnelName: envTunnelName || dashboardConfigState.tunnel.tunnelName,
      configSource: "env",
    };
  }

  const fileConfig = dashboardConfigState.tunnel;
  const hasFileConfig = Boolean(fileConfig.token || fileConfig.publicHostname || fileConfig.preferredMode !== "quick");

  return {
    ...fileConfig,
    configSource: hasFileConfig ? "file" : "none",
  };
}

function startDashboardTunnel(): void {
  const resolvedBinary = resolveCloudflaredBinary();
  if (!resolvedBinary) {
    tunnelSnapshotState = {
      ...createTunnelSnapshotState(),
      status: "unavailable",
      error: "cloudflared was not found on this machine.",
    };
    throw new Error("cloudflared was not found on this machine.");
  }

  const tunnelConfig = getEffectiveTunnelConfig();
  const namedTunnelConfigured = Boolean(tunnelConfig.token && tunnelConfig.publicHostname);
  if (tunnelConfig.preferredMode === "named" && !namedTunnelConfigured) {
    tunnelSnapshotState = {
      ...createTunnelSnapshotState(),
      status: "error",
      error: "Named tunnel mode requires a Cloudflare tunnel token and public hostname.",
    };
    throw new Error("Named tunnel mode requires a Cloudflare tunnel token and public hostname.");
  }

  const mode: DashboardTunnelMode = tunnelConfig.preferredMode === "named" ? "named" : "quick";
  const targetUrl = activeServerUrl || `http://${dashboardHost}:${defaultDashboardPort}`;
  tunnelSnapshotState = {
    ...createTunnelSnapshotState(),
    available: true,
    status: "starting",
    mode,
    preferredMode: tunnelConfig.preferredMode,
    namedTunnelConfigured,
    tokenConfigured: Boolean(tunnelConfig.token),
    publicHostname: tunnelConfig.publicHostname,
    tunnelName: tunnelConfig.tunnelName,
    configSource: tunnelConfig.configSource,
    binaryPath: resolvedBinary,
    targetUrl,
    publicUrl: mode === "named" ? toHttpsUrl(tunnelConfig.publicHostname) : "",
    startedAt: new Date().toISOString(),
    endedAt: null,
    pid: null,
    note:
      mode === "named"
        ? "Named tunnel requested. Cloudflare will route traffic to the configured hostname after the connection registers."
        : "Quick tunnel requested. The public URL will appear here once Cloudflare assigns it.",
    error: "",
    logs: [],
  };

  const args =
    mode === "named"
      ? ["tunnel", "--no-autoupdate", "--metrics", "localhost:0", "run", "--token", tunnelConfig.token]
      : ["tunnel", "--url", targetUrl, "--no-autoupdate", "--metrics", "localhost:0", "--output", "json"];

  const child = spawn(
    resolvedBinary,
    args,
    {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  tunnelSnapshotState.pid = child.pid ?? null;
  activeTunnelRun = {
    child,
    stopRequested: false,
    mode,
  };

  appendTunnelLog(
    mode === "named"
      ? `Starting named Cloudflare Tunnel for ${targetUrl} at ${toHttpsUrl(tunnelConfig.publicHostname)}.`
      : `Starting Cloudflare quick tunnel for ${targetUrl}.`,
  );
  pipeTunnelOutput(child.stdout);
  pipeTunnelOutput(child.stderr);

  child.on("error", (error) => {
    tunnelSnapshotState.status = "error";
    tunnelSnapshotState.error = error.message;
    appendTunnelLog(`Tunnel process error: ${error.message}`);
  });

  child.on("close", (code, signal) => {
    finalizeTunnelRun(code, signal);
  });
}

function buildTunnelSnapshot(): DashboardTunnelSnapshot {
  const resolvedBinary = resolveCloudflaredBinary();
  const tunnelConfig = getEffectiveTunnelConfig();
  const targetUrl = activeServerUrl || tunnelSnapshotState.targetUrl || `http://${dashboardHost}:${defaultDashboardPort}`;
  const namedTunnelConfigured = Boolean(tunnelConfig.token && tunnelConfig.publicHostname);
  const configuredUrl = toHttpsUrl(tunnelConfig.publicHostname);

  if (!resolvedBinary && !activeTunnelRun) {
    return {
      ...createTunnelSnapshotState(),
      status: "unavailable",
      error: "cloudflared was not found on this machine.",
      targetUrl,
    };
  }

  return {
    ...cloneTunnelSnapshot(tunnelSnapshotState),
    available: Boolean(resolvedBinary),
    preferredMode: tunnelConfig.preferredMode,
    namedTunnelConfigured,
    tokenConfigured: Boolean(tunnelConfig.token),
    publicHostname: tunnelConfig.publicHostname,
    tunnelName: tunnelConfig.tunnelName,
    configSource: tunnelConfig.configSource,
    binaryPath: resolvedBinary ?? tunnelSnapshotState.binaryPath,
    targetUrl,
    publicUrl:
      tunnelSnapshotState.publicUrl ||
      (tunnelSnapshotState.mode === "named" || tunnelConfig.preferredMode === "named" ? configuredUrl : ""),
  };
}

function createTunnelSnapshotState(): DashboardTunnelSnapshot {
  const binaryPath = resolveCloudflaredBinary() ?? "";
  const tunnelConfig = getEffectiveTunnelConfig();
  const namedTunnelConfigured = Boolean(tunnelConfig.token && tunnelConfig.publicHostname);
  return {
    available: Boolean(binaryPath),
    status: binaryPath ? "idle" : "unavailable",
    mode: tunnelConfig.preferredMode === "named" && namedTunnelConfigured ? "named" : "quick",
    preferredMode: tunnelConfig.preferredMode,
    namedTunnelConfigured,
    tokenConfigured: Boolean(tunnelConfig.token),
    publicHostname: tunnelConfig.publicHostname,
    tunnelName: tunnelConfig.tunnelName,
    configSource: tunnelConfig.configSource,
    binaryPath,
    targetUrl: activeServerUrl || `http://${dashboardHost}:${defaultDashboardPort}`,
    publicUrl: tunnelConfig.preferredMode === "named" ? toHttpsUrl(tunnelConfig.publicHostname) : "",
    startedAt: null,
    endedAt: null,
    pid: null,
    note: binaryPath
      ? tunnelConfig.preferredMode === "named"
        ? namedTunnelConfigured
          ? "Start the saved named tunnel to use the stable dashboard hostname."
          : "Named tunnel mode is selected. Save a Cloudflare tunnel token and public hostname to use a stable link."
        : "Start a quick Cloudflare Tunnel to open this dashboard from anywhere."
      : "Install cloudflared to publish the dashboard outside your local network.",
    error: "",
    logs: [],
  };
}

function cloneTunnelSnapshot(snapshot: DashboardTunnelSnapshot): DashboardTunnelSnapshot {
  return {
    ...snapshot,
    logs: [...snapshot.logs],
  };
}

function resolveCloudflaredBinary(): string | null {
  const envPath = process.env.JAA_CLOUDFLARED_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  const candidates = process.platform === "win32"
    ? [
        path.join(path.dirname(process.execPath), "node_modules", "cloudflared", "bin", "cloudflared.exe"),
        path.join(repoRoot, "node_modules", ".bin", "cloudflared.cmd"),
      ]
    : [
        path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "cloudflared", "bin", "cloudflared"),
        path.join(repoRoot, "node_modules", ".bin", "cloudflared"),
      ];

  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? null;
}

function pipeTunnelOutput(stream: NodeJS.ReadableStream | null): void {
  if (!stream) {
    return;
  }

  let buffer = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      handleTunnelLogLine(line);
    }
  });

  stream.on("end", () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      handleTunnelLogLine(trimmed);
    }
  });
}

function handleTunnelLogLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  appendTunnelLog(trimmed);

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message = typeof parsed.message === "string" ? parsed.message : "";
    const level = typeof parsed.level === "string" ? parsed.level : "info";
    const publicUrlMatch = extractQuickTunnelUrl(message);

    if (publicUrlMatch) {
      tunnelSnapshotState.publicUrl = publicUrlMatch;
      tunnelSnapshotState.status = "running";
      tunnelSnapshotState.note = "Public dashboard link is live.";
      tunnelSnapshotState.error = "";
    }

    if (
      activeTunnelRun?.mode === "named" &&
      /registered tunnel connection/i.test(message)
    ) {
      tunnelSnapshotState.status = "running";
      tunnelSnapshotState.note = "Stable public dashboard link is live.";
      tunnelSnapshotState.error = "";
    }

    if (level === "error" && !/origin certificate path/i.test(message)) {
      tunnelSnapshotState.error = message;
      if (tunnelSnapshotState.status !== "running") {
        tunnelSnapshotState.status = "error";
      }
    }
  } catch {
    const publicUrlMatch = extractQuickTunnelUrl(trimmed);
    if (publicUrlMatch) {
      tunnelSnapshotState.publicUrl = publicUrlMatch;
      tunnelSnapshotState.status = "running";
      tunnelSnapshotState.note = "Public dashboard link is live.";
      tunnelSnapshotState.error = "";
    }

    if (
      activeTunnelRun?.mode === "named" &&
      /registered tunnel connection/i.test(trimmed)
    ) {
      tunnelSnapshotState.status = "running";
      tunnelSnapshotState.note = "Stable public dashboard link is live.";
      tunnelSnapshotState.error = "";
    }
  }
}

function extractQuickTunnelUrl(value: string): string | null {
  const match = value.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  return match ? match[0] : null;
}

function appendTunnelLog(message: string): void {
  const timestamp = new Date().toISOString();
  tunnelSnapshotState.logs.push(`[${timestamp}] ${message}`);

  if (tunnelSnapshotState.logs.length > 250) {
    tunnelSnapshotState.logs.splice(0, tunnelSnapshotState.logs.length - 250);
  }
}

function finalizeTunnelRun(code: number | null, signal: NodeJS.Signals | null): void {
  const stopRequested = activeTunnelRun?.stopRequested ?? false;
  tunnelSnapshotState.endedAt = new Date().toISOString();
  tunnelSnapshotState.pid = null;

  if (stopRequested) {
    tunnelSnapshotState.status = "stopped";
    tunnelSnapshotState.note =
      tunnelSnapshotState.mode === "named" ? "Named Cloudflare Tunnel stopped." : "Cloudflare Tunnel stopped.";
    appendTunnelLog("Cloudflare Tunnel stopped from dashboard UI.");
  } else if (code === 0 || signal === "SIGTERM") {
    tunnelSnapshotState.status = "stopped";
    tunnelSnapshotState.note =
      tunnelSnapshotState.mode === "named" ? "Named Cloudflare Tunnel exited." : "Cloudflare Tunnel exited.";
    appendTunnelLog("Cloudflare Tunnel exited.");
  } else {
    tunnelSnapshotState.status = tunnelSnapshotState.publicUrl ? "stopped" : "error";
    tunnelSnapshotState.error =
      tunnelSnapshotState.error ||
      `Cloudflare Tunnel exited${code !== null ? ` with exit code ${code}` : ""}${signal ? ` (${signal})` : ""}.`;
    appendTunnelLog(tunnelSnapshotState.error);
  }

  activeTunnelRun = null;
}

async function buildDashboardSnapshot(): Promise<DashboardSnapshot> {
  const [
    profile,
    rawJobs,
    browserArtifacts,
    applicationAnswers,
    questionBank,
    evaluationProfiles,
    evaluationDecisions,
    followUpActions,
  ] = await Promise.all([
    getProfile(),
    getJobs(),
    listBrowserArtifacts(),
    loadApplicationAnswers(),
    loadQuestionBank(),
    getJobEvaluationProfiles(),
    getJobEvaluationDecisions(),
    getFollowUpActions(),
  ]);

  const duplicateUrlCounts = rawJobs.reduce((counts, job) => {
    const key = normalizeJobUrl(job.url);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());

  const automationSignals = await buildAutomationSignals(browserArtifacts);
  const autofillProfile = summarizeAutofillProfile(profile);
  const answerCapture = buildQuestionReviewSnapshot(questionBank.entries, applicationAnswers);
  const evaluationSnapshot = buildDashboardEvaluationSnapshot(
    evaluationProfiles,
    evaluationDecisions,
  );
  const followUps = buildDashboardFollowUpSnapshot(followUpActions);
  const evaluationDecisionsByUrl = evaluationDecisions.reduce((map, decision) => {
    if (decision.normalizedUrl) {
      map.set(decision.normalizedUrl, decision);
    }
    return map;
  }, new Map<string, JobEvaluationDecisionRecord>());

  const jobs = [...rawJobs]
    .sort((left, right) => toTimestamp(right.createdAt) - toTimestamp(left.createdAt))
    .map((job) =>
      buildDashboardJob(
        job,
        duplicateUrlCounts,
        automationSignals,
        evaluationDecisionsByUrl.get(normalizeJobUrl(job.url)),
      ),
    );

  const automationBoardCounts = BOARD_STAGES.reduce(
    (counts, stage) => {
      counts[stage] = 0;
      return counts;
    },
    {} as Record<AutomationStage, number>,
  );

  const sourceCountsMap = new Map<string, number>();

  for (const job of jobs) {
    automationBoardCounts[job.automationStage] += 1;
    const source = cleanRepeatedText(job.source) || "Unknown source";
    sourceCountsMap.set(source, (sourceCountsMap.get(source) ?? 0) + 1);
  }

  return {
    generatedAt: new Date().toISOString(),
    autofillProfile,
    evaluation: evaluationSnapshot,
    stats: {
      totalJobs: jobs.length,
      enrichedJobs: jobs.filter((job) => job.hasDescription && !job.hasUnknownCompany).length,
      readyToFileJobs: jobs.filter((job) => job.automationStage === "ready").length,
      externalApplyJobs: jobs.filter((job) => job.automationStage === "external").length,
      filedJobs: jobs.filter((job) => job.automationStage === "filed").length,
      missingMetadataCount: jobs.filter((job) => !job.hasDescription || job.hasUnknownCompany).length,
      duplicateUrlCount: jobs.filter((job) => job.isDuplicateUrl).length,
      workloadFilteredCount: jobs.filter((job) => job.workloadFiltered).length,
      browserArtifactCount: browserArtifacts.length,
      unresolvedQuestionCount: answerCapture.unresolvedCount,
      openFollowUpCount: followUps.openCount,
    },
    answerCapture,
    followUps,
    automationBoardCounts,
    sourceCounts: [...sourceCountsMap.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source))
      .slice(0, 8),
    jobs,
    attentionJobs: [...jobs]
      .filter((job) => job.attentionReasons.length > 0)
      .sort(
        (left, right) =>
          right.attentionReasons.length - left.attentionReasons.length ||
          toTimestamp(right.latestAutomationEventAt) - toTimestamp(left.latestAutomationEventAt),
      )
      .slice(0, 8),
    recentAutomationActivity: buildActivityFeed(jobs, browserArtifacts),
    recentBrowserArtifacts: browserArtifacts.slice(0, 12),
    automationModules: summarizeAutomationModules(browserArtifacts),
    externalApplyJobs: [...jobs]
      .filter((job) => job.externalApplyFound || job.workloadFiltered)
      .sort(
        (left, right) =>
          toTimestamp(right.latestAutomationEventAt) - toTimestamp(left.latestAutomationEventAt),
      )
      .slice(0, 8),
    actionRunner: buildActionRunnerSnapshot(browserArtifacts),
    tunnel: buildTunnelSnapshot(),
  };
}

function buildDashboardEvaluationSnapshot(
  profiles: JobEvaluationProfilesState,
  decisions: JobEvaluationDecisionRecord[],
): DashboardEvaluationSnapshot {
  const activeProfile =
    profiles.profiles.find((profile) => profile.name === profiles.activeProfileName) ?? profiles.profiles[0];
  const sortedDecisions = [...decisions].sort(
    (left, right) => toTimestamp(right.evaluatedAt || "") - toTimestamp(left.evaluatedAt || ""),
  );

  return {
    profiles,
    activeProfile,
    stats: {
      trackedCount: sortedDecisions.length,
      savedCount: sortedDecisions.filter((decision) => decision.decision === "saved").length,
      dismissedCount: sortedDecisions.filter((decision) => decision.decision === "dismissed").length,
      skippedCount: sortedDecisions.filter((decision) => decision.decision === "skipped").length,
    },
    decisions: sortedDecisions,
    recentDecisions: sortedDecisions.slice(0, 24),
    savedDecisions: sortedDecisions.filter((decision) => decision.decision === "saved"),
    dismissedDecisions: sortedDecisions.filter((decision) => decision.decision === "dismissed"),
    skippedDecisions: sortedDecisions.filter((decision) => decision.decision === "skipped"),
  };
}

function buildDashboardFollowUpSnapshot(actions: FollowUpAction[]): DashboardFollowUpSnapshot {
  const sortedActions = [...actions].sort(sortFollowUpActions);
  const openActions = sortedActions.filter((action) => action.status === "open");
  const waitingActions = sortedActions.filter((action) => action.status === "waiting");
  const now = Date.now();

  return {
    totalCount: sortedActions.length,
    openCount: openActions.length,
    waitingCount: waitingActions.length,
    highPriorityCount: openActions.filter((action) => action.priority === "high").length,
    dueCount: openActions.filter((action) => toTimestamp(action.dueAt) <= now).length,
    latestDetectedAt: sortedActions
      .map((action) => action.detectedAt || action.updatedAt || action.receivedAt)
      .sort((left, right) => toTimestamp(right) - toTimestamp(left))[0] ?? "",
    actions: sortedActions.slice(0, 80),
    openActions: openActions.slice(0, 20),
    waitingActions: waitingActions.slice(0, 12),
  };
}

function buildQuestionReviewSnapshot(
  entries: QuestionBankEntry[],
  answers: ApplicationAnswers,
): QuestionReviewSnapshot {
  const reviewEntries = entries.map((entry) => buildQuestionReviewEntry(entry, answers));
  const unresolvedQuestions = reviewEntries
    .filter((entry) => entry.status === "unanswered")
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  const answeredQuestions = reviewEntries
    .filter((entry) => entry.status === "answered")
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
    .slice(0, 8);

  return {
    totalQuestions: reviewEntries.length,
    unresolvedCount: reviewEntries.filter((entry) => entry.status === "unanswered").length,
    answeredCount: reviewEntries.filter((entry) => entry.status === "answered").length,
    bucketCounts: reviewEntries.reduce(
      (counts, entry) => {
        counts[entry.bucket] += 1;
        return counts;
      },
      { text: 0, select: 0, radio: 0, checkbox: 0 } as Record<ApplicationAnswerBucket, number>,
    ),
    unresolvedQuestions,
    answeredQuestions,
  };
}

function buildQuestionReviewEntry(
  entry: QuestionBankEntry,
  answers: ApplicationAnswers,
): QuestionReviewEntry {
  const bucket = resolveAnswerBucket(entry.type);
  const suggestedAnswer = lookupApplicationAnswer(answers, entry.label, entry.type) || "";

  return {
    ...entry,
    bucket,
    suggestedAnswer,
    currentAnswer: cleanRepeatedText(entry.answer || ""),
  };
}

function summarizeAutofillProfile(profile: Profile): ProfileSummary {
  const fields: Array<{ label: string; filled: boolean }> = [
    { label: "Name", filled: Boolean(profile.name.trim()) },
    { label: "Email", filled: Boolean(profile.email.trim()) },
    { label: "Phone", filled: Boolean(profile.phone.trim()) },
    {
      label: "Location",
      filled: Boolean(profile.location.trim() || profile.city.trim() || profile.state.trim() || profile.postalCode.trim()),
    },
    { label: "LinkedIn URL", filled: Boolean(profile.linkedinUrl.trim()) },
    { label: "Resume Summary", filled: Boolean(profile.resumeSummary.trim()) },
    { label: "Work Authorization", filled: Boolean(profile.workAuthorization.trim()) },
    { label: "Years of Experience", filled: Boolean(profile.yearsOfExperience.trim()) },
  ];

  const completedFields = fields.filter((field) => field.filled).length;

  return {
    data: profile,
    completionScore: Math.round((completedFields / fields.length) * 100),
    completedFields,
    totalFields: fields.length,
    missingFields: fields.filter((field) => !field.filled).map((field) => field.label),
  };
}

async function listBrowserArtifacts(): Promise<BrowserArtifactSummary[]> {
  const entries = await readdir(browserDataDir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile());

  const artifacts = await Promise.all(
    files.map(async (entry) => {
      const fullPath = path.join(browserDataDir, entry.name);
      const details = await stat(fullPath);
      const extension = path.extname(entry.name).replace(/^\./, "") || "file";
      const prefix = resolveArtifactPrefix(entry.name);
      const moduleKey = resolveArtifactModule(prefix);

      return {
        name: entry.name,
        prefix,
        category: AUTOMATION_MODULES.find((module) => module.key === moduleKey)?.label || "Other Artifacts",
        moduleKey,
        extension,
        size: details.size,
        updatedAt: details.mtime.toISOString(),
      } satisfies BrowserArtifactSummary;
    }),
  );

  return artifacts.sort((left, right) => toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt));
}

async function buildAutomationSignals(
  browserArtifacts: BrowserArtifactSummary[],
): Promise<AutomationSignals> {
  const externalApplyByJob = new Map<string, ExternalApplySignal>();
  const linkedInReviewByJob = new Map<string, LinkedInReviewSignal>();

  const relevantArtifacts = browserArtifacts.filter(
    (artifact) =>
      artifact.extension === "json" &&
      (artifact.prefix === "external-apply-preview-result" ||
        artifact.prefix === "external-apply-result" ||
        artifact.prefix === "linkedin-apply-review" ||
        artifact.prefix === "linkedin-apply-review-attached"),
  );

  await Promise.all(
    relevantArtifacts.map(async (artifact) => {
      const fullPath = path.join(browserDataDir, artifact.name);
      const raw = await readFile(fullPath, "utf8").catch(() => "");
      if (!raw.trim()) {
        return;
      }

      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;

        if (
          (artifact.prefix === "external-apply-preview-result" ||
            artifact.prefix === "external-apply-result") &&
          typeof parsed.sourceJobUrl === "string"
        ) {
          const jobKey = normalizeJobUrl(parsed.sourceJobUrl);
          const existing = externalApplyByJob.get(jobKey);

          if (!existing || toTimestamp(artifact.updatedAt) >= toTimestamp(existing.updatedAt)) {
            const workload = asRecord(parsed.workloadScreening);
            externalApplyByJob.set(jobKey, {
              externalApplyFound: Boolean(parsed.externalApplyFound),
              destinationUrl: typeof parsed.destinationUrl === "string" ? parsed.destinationUrl : "",
              destinationTitle: typeof parsed.destinationTitle === "string" ? parsed.destinationTitle : "",
              workloadFiltered: Boolean(workload?.pass === false),
              workloadScore: typeof workload?.score === "number" ? workload.score : null,
              workloadReasons: Array.isArray(workload?.reasons)
                ? workload.reasons.filter((reason): reason is string => typeof reason === "string")
                : [],
              updatedAt: artifact.updatedAt,
            });
          }

          return;
        }

        if (
          (artifact.prefix === "linkedin-apply-review" ||
            artifact.prefix === "linkedin-apply-review-attached") &&
          typeof parsed.url === "string"
        ) {
          const jobKey = normalizeJobUrl(parsed.url);
          const existing = linkedInReviewByJob.get(jobKey);

          if (!existing || toTimestamp(artifact.updatedAt) >= toTimestamp(existing.updatedAt)) {
            const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
            linkedInReviewByJob.set(jobKey, {
              hasEasyApply: Boolean(parsed.hasEasyApply),
              stage: typeof parsed.stage === "string" ? parsed.stage : "Application modal inspected",
              primaryAction:
                typeof parsed.primaryAction === "string"
                  ? parsed.primaryAction
                  : "No primary action detected",
              fieldCount: fields.length,
              updatedAt: artifact.updatedAt,
            });
          }
        }
      } catch {
        // Ignore invalid artifact payloads.
      }
    }),
  );

  return {
    externalApplyByJob,
    linkedInReviewByJob,
  };
}

function buildDashboardJob(
  job: Job,
  duplicateUrlCounts: Map<string, number>,
  automationSignals: AutomationSignals,
  evaluationDecision?: JobEvaluationDecisionRecord,
): DashboardJob {
  const displayTitle = cleanRepeatedText(job.title) || "Untitled role";
  const displayCompany = cleanRepeatedText(job.company) || "Unknown company";
  const normalizedUrl = normalizeJobUrl(job.url);
  const externalApply = automationSignals.externalApplyByJob.get(normalizedUrl);
  const linkedInReview = automationSignals.linkedInReviewByJob.get(normalizedUrl);
  const evaluationTimestamp = Math.max(
    toTimestamp(job.evaluation?.evaluatedAt ?? ""),
    toTimestamp(evaluationDecision?.evaluatedAt ?? ""),
  );
  const latestEvaluation =
    evaluationDecision && toTimestamp(evaluationDecision.evaluatedAt || "") >= toTimestamp(job.evaluation?.evaluatedAt || "")
      ? evaluationDecision
      : job.evaluation;
  const hasDescription = Boolean(job.description.trim());
  const hasUnknownCompany = !displayCompany || displayCompany.toLowerCase() === "unknown company";
  const isDuplicateUrl = (duplicateUrlCounts.get(normalizedUrl) ?? 0) > 1;
  const attentionReasons: string[] = [];

  if (!hasDescription) {
    attentionReasons.push("Missing description");
  }

  if (hasUnknownCompany) {
    attentionReasons.push("Unknown company");
  }

  if (isDuplicateUrl) {
    attentionReasons.push("Duplicate source URL");
  }

  if (externalApply?.workloadFiltered) {
    attentionReasons.push("Workload screen flagged");
  }

  const automationStage = deriveAutomationStage(job, {
    hasDescription,
    hasUnknownCompany,
    isDuplicateUrl,
    externalApplyFound: Boolean(externalApply?.externalApplyFound),
  });

  return {
    ...job,
    displayTitle,
    displayCompany,
    descriptionSnippet: summarizeText(job.description, 180),
    normalizedUrl,
    hasDescription,
    hasUnknownCompany,
    isDuplicateUrl,
    ageInDays: daysSince(job.createdAt),
    automationStage,
    automationSummary: buildAutomationSummary(automationStage, linkedInReview, externalApply),
    nextAutomationStep: buildNextAutomationStep(automationStage, externalApply),
    attentionReasons,
    externalApplyFound: Boolean(externalApply?.externalApplyFound),
    externalApplyDestinationUrl: externalApply?.destinationUrl ?? "",
    externalApplyDestinationTitle: externalApply?.destinationTitle ?? "",
    linkedInApplyReviewed: Boolean(linkedInReview),
    linkedInReviewStage: linkedInReview?.stage ?? "",
    linkedInPrimaryAction: linkedInReview?.primaryAction ?? "",
    linkedInFieldCount: linkedInReview?.fieldCount ?? 0,
    workloadFiltered: Boolean(externalApply?.workloadFiltered),
    workloadReasons: externalApply?.workloadReasons ?? [],
    evaluationDecision: latestEvaluation?.decision ?? "",
    evaluationScore: typeof latestEvaluation?.score === "number" ? latestEvaluation.score : null,
    evaluationReasons: Array.isArray(latestEvaluation?.reasons) ? latestEvaluation.reasons : [],
    evaluationProfileName: latestEvaluation?.profileName ?? "",
    evaluationProfileSummary: latestEvaluation?.profileSummary ?? "",
    evaluationTrackedAt: latestEvaluation?.evaluatedAt ?? "",
    evaluationTrackedBy: latestEvaluation?.trackedBy ?? "",
    evaluationAlreadySaved: Boolean(latestEvaluation?.alreadySaved),
    latestAutomationEventAt:
      maxTimestampIso(
        job.createdAt,
        externalApply?.updatedAt,
        linkedInReview?.updatedAt,
        evaluationTimestamp > 0 ? new Date(evaluationTimestamp).toISOString() : undefined,
      ) || job.createdAt,
  };
}

function deriveAutomationStage(
  job: Job,
  options: {
    hasDescription: boolean;
    hasUnknownCompany: boolean;
    isDuplicateUrl: boolean;
    externalApplyFound: boolean;
  },
): AutomationStage {
  if (FILED_STATUSES.has(job.status)) {
    return "filed";
  }

  if (options.externalApplyFound) {
    return "external";
  }

  if (!options.hasDescription || options.hasUnknownCompany || options.isDuplicateUrl) {
    return "enrich";
  }

  return "ready";
}

function buildAutomationSummary(
  stage: AutomationStage,
  linkedInReview?: LinkedInReviewSignal,
  externalApply?: ExternalApplySignal,
): string {
  if (stage === "external") {
    return externalApply?.workloadFiltered
      ? "External apply URL was found, but the workload screen flagged the role."
      : "External employer application URL has been captured.";
  }

  if (stage === "filed") {
    return "Application has already been filed or moved beyond the automation scope.";
  }

  if (stage === "enrich") {
    return "This job still needs cleaner metadata before the filing flow is worth running.";
  }

  if (linkedInReview) {
    return `Easy Apply was reviewed. Next visible action: ${linkedInReview.primaryAction}.`;
  }

  return "This job has enough captured metadata to move into form review or autofill.";
}

function buildNextAutomationStep(
  stage: AutomationStage,
  externalApply?: ExternalApplySignal,
): string {
  if (stage === "external") {
    return externalApply?.workloadFiltered
      ? "Review the workload screen before spending time on the employer form."
      : "Open the employer URL and run form review or autofill.";
  }

  if (stage === "filed") {
    return "No further filing automation is tracked here.";
  }

  if (stage === "enrich") {
    return "Capture or enrich the job page so the tracker has a clean company and description.";
  }

  return "Review the current application flow and stop before submit.";
}

function buildActivityFeed(
  jobs: DashboardJob[],
  browserArtifacts: BrowserArtifactSummary[],
): ActivityItem[] {
  const jobActivity = jobs.slice(0, 10).map((job) => ({
    id: `job:${job.id}`,
    kind: job.externalApplyFound ? ("external" as const) : ("job" as const),
    title: stageLabel(job.automationStage),
    detail: `${job.displayTitle} @ ${job.displayCompany}`,
    timestamp: job.latestAutomationEventAt,
    targetJobId: job.id,
  }));

  const artifactActivity = browserArtifacts.slice(0, 10).map((artifact) => ({
    id: `artifact:${artifact.name}`,
    kind: "artifact" as const,
    title: artifact.category,
    detail: artifact.name,
    timestamp: artifact.updatedAt,
  }));

  return [...jobActivity, ...artifactActivity]
    .sort((left, right) => toTimestamp(right.timestamp) - toTimestamp(left.timestamp))
    .slice(0, 16);
}

function summarizeAutomationModules(
  browserArtifacts: BrowserArtifactSummary[],
): AutomationModuleSummary[] {
  return AUTOMATION_MODULES.map((module) => {
    const matches = browserArtifacts.filter((artifact) => artifact.moduleKey === module.key);
    const latestAt = matches[0]?.updatedAt ?? null;

    return {
      key: module.key,
      label: module.label,
      description: module.description,
      fileCount: matches.length,
      latestAt,
      status:
        matches.length === 0
          ? "No tracker runs yet"
          : latestAt && daysSince(latestAt) <= 1
            ? "Artifacts updated recently"
            : "Artifacts available",
    };
  });
}

function resolveArtifactPrefix(fileName: string): string {
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const knownPrefix = KNOWN_ARTIFACT_PREFIXES.find(
    (prefix) => baseName === prefix || baseName.startsWith(`${prefix}-`),
  );

  if (knownPrefix) {
    return knownPrefix;
  }

  return baseName.replace(/-\d{4}-\d{2}-\d{2}(t\d{2}[-:]\d{2}[-:]\d{2}(?:-\d+)?z?)?.*$/i, "");
}

function resolveArtifactModule(prefix: string): AutomationModuleKey {
  if (prefix === "linkedin-collection" || prefix === "linkedin-saved-jobs") {
    return "collection";
  }

  if (prefix === "capture" || prefix === "capture-attached") {
    return "capture";
  }

  if (prefix === "linkedin-job-descriptions" || prefix === "persistent-job-enrichment") {
    return "enrichment";
  }

  if (prefix === "linkedin-triage-results") {
    return "triage";
  }

  if (
    prefix === "linkedin-apply-review" ||
    prefix === "linkedin-apply-review-attached" ||
    prefix === "linkedin-autofill"
  ) {
    return "linkedin";
  }

  if (prefix === "site-form-review" || prefix === "site-form-autofill") {
    return "employerForm";
  }

  if (prefix === "gmail-follow-up-scan") {
    return "followUp";
  }

  if (
    prefix.startsWith("external-apply") ||
    prefix.startsWith("linkedin-saved-external-apply-urls") ||
    prefix === "linkedin-saved-session-external-apply-urls"
  ) {
    return "external";
  }

  return "other";
}

function stageLabel(stage: AutomationStage): string {
  switch (stage) {
    case "enrich":
      return "Needs enrichment";
    case "ready":
      return "Ready to file";
    case "external":
      return "External apply";
    case "filed":
      return "Filed";
  }
}

function cleanRepeatedText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const half = Math.floor(normalized.length / 2);

  if (normalized.length > 8 && normalized.length % 2 === 0) {
    const firstHalf = normalized.slice(0, half).trim();
    const secondHalf = normalized.slice(half).trim();

    if (firstHalf && secondHalf && firstHalf === secondHalf) {
      return firstHalf;
    }
  }

  return normalized;
}

function summarizeText(value: string, maxLength: number): string {
  const normalized = cleanRepeatedText(value).replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "No description captured yet.";
  }

  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

function normalizeJobUrl(url: string): string {
  try {
    const parsed = new URL(url);

    if (parsed.hostname.includes("linkedin.com")) {
      const match = parsed.pathname.match(/\/jobs\/view\/(\d+)/);
      if (match) {
        return `${parsed.origin}/jobs/view/${match[1]}/`;
      }
    }

    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

function daysSince(isoValue: string): number {
  const timestamp = toTimestamp(isoValue);

  if (timestamp <= 0) {
    return 999;
  }

  return Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
}

function toTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function maxTimestampIso(...values: Array<string | undefined>): string {
  const sorted = values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => toTimestamp(right) - toTimestamp(left));

  return sorted[0] ?? "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isJobStatus(value: string): value is JobStatus {
  return JOB_STATUSES.includes(value as JobStatus);
}

function openUrl(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
      return;
    }

    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      return;
    }

    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Best-effort only.
  }
}
