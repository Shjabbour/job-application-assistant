import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askCodexCliAgent, askOpenClawAgent } from "./agentHandoff.js";
import { extractMarkdownSection } from "./markdown.js";
import { buildAnswerPrompt, buildAnswerRetryPrompt, hasUsableQuestionContext, isMissingDetailsAnswer } from "./prompts.js";
import { captureScreen, captureWindow, captureWindowPreview, listDisplays, listWindows, makeRunId } from "./screen.js";
import { observeScreenshotLocally } from "./screenshotObservation.js";
import { readImageText } from "./localOcr.js";
import { observeTranscriptLocally } from "./localTranscript.js";
import { createEmptyState, mergeObservation } from "./state.js";
import type { AnswerHandoff, DisplayInfo, QuestionState, WindowInfo } from "./types.js";
import { JS } from "./ui/client.js";
import { HTML } from "./ui/page.js";
import { CSS } from "./ui/styles.js";

interface UiServerOptions {
  outDir: string;
  port: number;
  handoff: AnswerHandoff;
  intervalMs?: number;
  language?: string;
  profilePath?: string | null;
}

export interface UiServerHandle {
  url: string;
  close: () => Promise<void>;
}

interface RunSummary {
  id: string;
  updatedAt: string | null;
  title: string;
  kind: string;
  completenessScore: number;
  readyToAnswer: boolean;
  hasAnswer: boolean;
  hasHints: boolean;
}

interface RunDetail extends RunSummary {
  state: QuestionState | null;
  answerMarkdown: string;
  hintsMarkdown: string;
  turns: RunTurnDetail[];
  latestScreenshotUrl: string | null;
  screenshotUrls: string[];
  screenshots: ScreenshotDetail[];
  screenshotCount: number;
}

interface ScreenshotDetail {
  index: number;
  url: string;
  status: "pending" | "sent";
  canDelete: boolean;
}

interface RunTurnDetail {
  id: string;
  kind: "original" | "followup";
  title: string;
  questionMarkdown: string;
  answerMarkdown: string;
  hintsMarkdown: string;
  hasAnswer: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RunTurnArtifact extends RunTurnDetail {
  state: QuestionState | null;
}

interface MonitorStatus {
  running: boolean;
  screenId: number | null;
  activeRunId: string | null;
  pid: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  log: string[];
}

interface MonitorProcess {
  child: ChildProcessWithoutNullStreams;
  screenId: number;
  activeRunId: string | null;
  startedAt: string;
  stoppedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  log: string[];
}

interface ScreenshotRecord {
  path: string;
  updatedAt: number;
  status: "pending" | "sent";
}







function pageHtml(): string {
  return HTML.replace("__CSS__", CSS).replace("__JS__", JS);
}

function sendText(res: ServerResponse, statusCode: number, body: string, contentType: string): void {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  sendText(res, statusCode, `${JSON.stringify(body)}\n`, "application/json; charset=utf-8");
}

function packageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..");
}

function makeMonitorSpawnArgs(
  outDir: string,
  screenId: number,
  language: string,
  intervalMs: number,
  profilePath?: string | null,
  handoff?: AnswerHandoff,
): string[] {
  const intervalSeconds = Math.max(1, Math.round(intervalMs / 1000));
  const args = [
    "run",
    "watch",
    "--",
    "--screen",
    String(screenId),
    "--language",
    language,
    "--manual",
    "--out",
    outDir,
    "--interval",
    String(intervalSeconds),
    "--keep-all-screens",
  ];

  if (profilePath) {
    args.push("--profile", path.resolve(profilePath));
  }
  args.push("--handoff", handoff ?? "codex");

  return args;
}

function stopMonitorTree(pid: number): void {
  const taskkill = spawn("cmd", ["/c", "taskkill", "/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  taskkill.unref();
}

function runIdFromMonitorLog(line: string): string | null {
  const match = line.match(/^Run directory:\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const runId = match[1].trim().split(/[\\/]/).filter(Boolean).pop() ?? "";
  return /^[a-zA-Z0-9._-]+$/.test(runId) ? runId : null;
}

function appendMonitorLog(monitor: MonitorProcess, chunk: Buffer): void {
  const lines = chunk
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const runId = runIdFromMonitorLog(line);
    if (runId) {
      monitor.activeRunId = runId;
    }
  }

  monitor.log.push(...lines);
  if (monitor.log.length > 120) {
    monitor.log.splice(0, monitor.log.length - 120);
  }
}

function monitorStatus(monitor: MonitorProcess | null): MonitorStatus {
  return {
    running: Boolean(monitor && monitor.exitCode === null),
    screenId: monitor?.screenId ?? null,
    activeRunId: monitor?.activeRunId ?? null,
    pid: monitor?.child.pid ?? null,
    startedAt: monitor?.startedAt ?? null,
    stoppedAt: monitor?.stoppedAt ?? null,
    exitCode: monitor?.exitCode ?? null,
    lastError: monitor?.lastError ?? null,
    log: monitor?.log ?? [],
  };
}

function stopMonitorProcess(monitor: MonitorProcess | null): void {
  if (!monitor || monitor.exitCode !== null) {
    return;
  }

  monitor.stoppedAt = new Date().toISOString();
  monitor.lastError = null;
  monitor.exitCode = 0;
  if (process.platform === "win32" && monitor.child.pid) {
    stopMonitorTree(monitor.child.pid);
    return;
  }

  monitor.child.kill();
}

async function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }

  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }

  return parsed as Record<string, unknown>;
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  const text = await readOptionalText(filePath);
  if (!text) {
    return null;
  }

  return JSON.parse(text) as T;
}

async function clearRunState(runDir: string): Promise<void> {
  const state = createEmptyState();
  state.lastUpdatedAt = new Date().toISOString();
  await writeFile(path.join(runDir, "question-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await clearAnswerArtifacts(runDir);
  await rm(path.join(runDir, "turns.json"), { force: true }).catch(() => undefined);
}

async function clearAnswerArtifacts(runDir: string): Promise<void> {
  await Promise.all([
    rm(path.join(runDir, "answer.md"), { force: true }).catch(() => undefined),
    rm(path.join(runDir, "hints.md"), { force: true }).catch(() => undefined),
    rm(path.join(runDir, "agent-prompt.md"), { force: true }).catch(() => undefined),
    rm(path.join(runDir, "question.txt"), { force: true }).catch(() => undefined),
  ]);
}

async function writeQuestionState(runDir: string, state: QuestionState): Promise<void> {
  await writeFile(path.join(runDir, "question-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function markdownFromQuestionState(state: QuestionState | null): string {
  if (!state?.question) {
    return "";
  }

  const question = state.question;
  const parts: string[] = [];
  if (question.prompt) {
    parts.push(`## Prompt\n\n${question.prompt}`);
  }
  if (question.inputOutput) {
    parts.push(`## Input / Output\n\n${question.inputOutput}`);
  }
  if (question.examples.length) {
    parts.push(`## Examples\n\n${question.examples.map((item) => `- ${item}`).join("\n")}`);
  }
  if (question.constraints.length) {
    parts.push(`## Constraints\n\n${question.constraints.map((item) => `- ${item}`).join("\n")}`);
  }
  if (question.functionSignature) {
    parts.push(`## Signature\n\n\`${question.functionSignature}\``);
  }
  if (question.notes.length) {
    parts.push(`## Notes\n\n${question.notes.map((item) => `- ${item}`).join("\n")}`);
  }
  if (state.transcriptText) {
    parts.push(`## Transcript\n\n${state.transcriptText}`);
  }
  return parts.join("\n\n");
}

function makeTurnId(index: number): string {
  return index === 0 ? "original" : `followup-${index}`;
}

function makeTurnTitle(index: number): string {
  return index === 0 ? "Original" : `Follow-up ${index}`;
}

function turnDetail(turn: RunTurnArtifact): RunTurnDetail {
  return {
    id: turn.id,
    kind: turn.kind,
    title: turn.title,
    questionMarkdown: turn.questionMarkdown,
    answerMarkdown: turn.answerMarkdown,
    hintsMarkdown: turn.hintsMarkdown,
    hasAnswer: Boolean(turn.answerMarkdown.trim()),
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
  };
}

async function readTurnArtifacts(runDir: string): Promise<RunTurnArtifact[]> {
  const turns = await readOptionalJson<RunTurnArtifact[]>(path.join(runDir, "turns.json"));
  if (!Array.isArray(turns)) {
    return [];
  }

  return turns
    .filter((turn) => turn && typeof turn.id === "string")
    .map((turn, index) => {
      const now = new Date().toISOString();
      return {
        id: turn.id || makeTurnId(index),
        kind: turn.kind === "followup" ? "followup" : "original",
        title: turn.title || makeTurnTitle(index),
        questionMarkdown: typeof turn.questionMarkdown === "string" ? turn.questionMarkdown : "",
        answerMarkdown: typeof turn.answerMarkdown === "string" ? turn.answerMarkdown : "",
        hintsMarkdown: typeof turn.hintsMarkdown === "string" ? turn.hintsMarkdown : "",
        hasAnswer: Boolean(turn.answerMarkdown?.trim()),
        createdAt: turn.createdAt || now,
        updatedAt: turn.updatedAt || turn.createdAt || now,
        state: turn.state ?? null,
      };
    });
}

async function writeTurnArtifacts(runDir: string, turns: RunTurnArtifact[]): Promise<void> {
  await writeFile(path.join(runDir, "turns.json"), `${JSON.stringify(turns, null, 2)}\n`, "utf8");
}

async function ensureOriginalTurn(runDir: string, state: QuestionState | null): Promise<RunTurnArtifact[]> {
  const turns = await readTurnArtifacts(runDir);
  if (turns.length) {
    return turns;
  }

  const answerMarkdown = (await readOptionalText(path.join(runDir, "answer.md")))?.trim() ?? "";
  const hintsMarkdown = (await readOptionalText(path.join(runDir, "hints.md")))?.trim() ?? "";
  if (!state && !answerMarkdown) {
    return [];
  }

  const now = new Date().toISOString();
  const original: RunTurnArtifact = {
    id: "original",
    kind: "original",
    title: "Original",
    questionMarkdown: markdownFromQuestionState(state),
    answerMarkdown,
    hintsMarkdown,
    hasAnswer: Boolean(answerMarkdown),
    createdAt: state?.lastUpdatedAt ?? now,
    updatedAt: now,
    state,
  };
  await writeTurnArtifacts(runDir, [original]);
  return [original];
}

function followUpQuestionMarkdown(text: string): string {
  const clean = text.trim();
  return clean ? `## Follow-up\n\n${clean}` : "## Follow-up\n\nAdditional context captured.";
}

async function recordFollowUpTurn(
  runDir: string,
  previousState: QuestionState,
  nextState: QuestionState,
  questionText: string,
): Promise<void> {
  const turns = await ensureOriginalTurn(runDir, previousState);
  if (!turns.length || !turns.some((turn) => turn.answerMarkdown.trim())) {
    return;
  }

  const now = new Date().toISOString();
  const latest = turns.at(-1);
  const nextQuestionMarkdown = followUpQuestionMarkdown(questionText);
  if (latest && latest.kind === "followup" && !latest.answerMarkdown.trim()) {
    latest.questionMarkdown = latest.questionMarkdown.trim()
      ? `${latest.questionMarkdown.trim()}\n\n${nextQuestionMarkdown}`
      : nextQuestionMarkdown;
    latest.updatedAt = now;
    latest.state = nextState;
    await writeTurnArtifacts(runDir, turns);
    return;
  }

  const index = turns.length;
  turns.push({
    id: makeTurnId(index),
    kind: "followup",
    title: makeTurnTitle(index),
    questionMarkdown: nextQuestionMarkdown,
    answerMarkdown: "",
    hintsMarkdown: "",
    hasAnswer: false,
    createdAt: now,
    updatedAt: now,
    state: nextState,
  });
  await writeTurnArtifacts(runDir, turns);
}

async function writeTranscriptChunk(runDir: string, transcript: string, index: number): Promise<string> {
  const transcriptDir = path.join(runDir, "transcripts");
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, `chunk-${String(index).padStart(3, "0")}.txt`);
  await writeFile(transcriptPath, `${transcript.trim()}\n`, "utf8");
  return transcriptPath;
}

async function addTranscriptToRun(
  outDir: string,
  runId: string,
  transcript: string,
): Promise<RunDetail> {
  const runPath = resolveRunPath(outDir, runId);
  if (!runPath) {
    throw new Error("Invalid run id.");
  }

  const cleanTranscript = transcript.trim();
  if (!cleanTranscript) {
    throw new Error("Transcript text is required.");
  }

  await mkdir(runPath, { recursive: true });
  const statePath = path.join(runPath, "question-state.json");
  const currentState = await readOptionalJson<QuestionState>(statePath);
  const normalizedState = currentState ?? (() => {
    const created = createEmptyState();
    created.lastUpdatedAt = new Date().toISOString();
    return created;
  })();
  const transcriptPath = await writeTranscriptChunk(
    runPath,
    cleanTranscript,
    (normalizedState.transcriptPaths?.length ?? 0) + 1,
  );
  const observation = observeTranscriptLocally(normalizedState, cleanTranscript);
  const nextState = mergeObservation(normalizedState, observation, {
    kind: "transcript",
    path: transcriptPath,
    transcriptText: cleanTranscript,
  });

  await writeQuestionState(runPath, nextState);
  await recordFollowUpTurn(runPath, normalizedState, nextState, cleanTranscript);

  const detail = await readRunDetail(outDir, runId);
  if (!detail) {
    throw new Error("Failed to read transcript artifacts.");
  }
  return detail;
}

async function captureScreenshotForRun(
  outDir: string,
  runId: string,
  source: { screenId?: number; windowId?: number },
): Promise<RunDetail> {
  const runPath = resolveRunPath(outDir, runId);
  if (!runPath) {
    throw new Error("Invalid run id.");
  }

  let region: { x: number; y: number; width: number; height: number } | null = null;
  let windowCaptureId: number | null = null;
  if (source.windowId) {
    const windows = await listWindows();
    const windowInfo = windows.find((item) => item.id === source.windowId);
    if (!windowInfo) {
      throw new Error(`Window ${source.windowId} was not found. Make sure it is visible, not minimized, then refresh the window list.`);
    }
    region = {
      x: windowInfo.x,
      y: windowInfo.y,
      width: windowInfo.width,
      height: windowInfo.height,
    };
    windowCaptureId = windowInfo.id;
  } else if (source.screenId) {
    const displays = await listDisplays();
    const screen = displays.find((item) => item.id === source.screenId);
    if (!screen) {
      throw new Error(`Screen ${source.screenId} was not found.`);
    }
    region = {
      x: screen.x,
      y: screen.y,
      width: screen.width,
      height: screen.height,
    };
  }

  if (!region) {
    throw new Error("Choose a screen or app window first.");
  }

  await mkdir(runPath, { recursive: true });
  const statePath = path.join(runPath, "question-state.json");
  const currentState = await readOptionalJson<QuestionState>(statePath);
  const normalizedState = currentState ?? (() => {
    const created = createEmptyState();
    created.lastUpdatedAt = new Date().toISOString();
    return created;
  })();

  const screenshotPath = windowCaptureId
    ? await captureWindow(runPath, windowCaptureId)
    : await captureScreen(runPath, region);

  const visibleText = await readImageTextSafely(screenshotPath);
  const observation = observeScreenshotLocally(normalizedState, screenshotPath, visibleText);
  const nextState = mergeObservation(normalizedState, observation, {
    kind: "screenshot",
    path: screenshotPath,
  });

  await writeQuestionState(runPath, nextState);
  await recordFollowUpTurn(
    runPath,
    normalizedState,
    nextState,
    `Screenshot ${(normalizedState.screenshotPaths?.length ?? 0) + 1} captured. See the screenshot gallery for the follow-up prompt.`,
  );

  const detail = await readRunDetail(outDir, runId);
  if (!detail) {
    throw new Error("Failed to read answer artifacts.");
  }
  return detail;
}

function pngBufferFromDataUrl(imageData: unknown): Buffer {
  if (typeof imageData !== "string") {
    throw new Error("imageData is required.");
  }

  const match = imageData.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match?.[1]) {
    throw new Error("imageData must be a PNG data URL.");
  }

  return Buffer.from(match[1], "base64");
}

async function captureUploadedImageForRun(
  outDir: string,
  runId: string,
  imageData: unknown,
): Promise<RunDetail> {
  const runPath = resolveRunPath(outDir, runId);
  if (!runPath) {
    throw new Error("Invalid run id.");
  }

  await mkdir(runPath, { recursive: true });
  const screenDir = path.join(runPath, "screens");
  await mkdir(screenDir, { recursive: true });

  const statePath = path.join(runPath, "question-state.json");
  const currentState = await readOptionalJson<QuestionState>(statePath);
  const normalizedState = currentState ?? (() => {
    const created = createEmptyState();
    created.lastUpdatedAt = new Date().toISOString();
    return created;
  })();

  const screenshotPath = path.join(screenDir, `browser-${Date.now()}.png`);
  await writeFile(screenshotPath, pngBufferFromDataUrl(imageData));

  const visibleText = await readImageTextSafely(screenshotPath);
  const observation = observeScreenshotLocally(normalizedState, screenshotPath, visibleText);
  const nextState = mergeObservation(normalizedState, observation, {
    kind: "screenshot",
    path: screenshotPath,
  });

  await writeQuestionState(runPath, nextState);
  await recordFollowUpTurn(
    runPath,
    normalizedState,
    nextState,
    `Screenshot ${(normalizedState.screenshotPaths?.length ?? 0) + 1} captured from browser source. See the screenshot gallery for the follow-up prompt.`,
  );

  const detail = await readRunDetail(outDir, runId);
  if (!detail) {
    throw new Error("Failed to read answer artifacts.");
  }
  return detail;
}

function normalizeCaptureRunId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const runId = value.trim();
  return runId.length > 0 && /^[a-zA-Z0-9._-]+$/.test(runId) ? runId : null;
}

function withinPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveRunPath(outDir: string, runId: string): string | null {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) {
    return null;
  }

  const root = path.resolve(outDir);
  const runPath = path.resolve(root, runId);
  return withinPath(root, runPath) ? runPath : null;
}

async function readCandidateProfile(profilePath: string | null): Promise<string | null> {
  if (!profilePath) {
    return null;
  }

  try {
    const profile = await readFile(path.resolve(profilePath), "utf8");
    const trimmed = profile.trim();
    return trimmed.length ? trimmed : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeUiAnswerArtifacts(
  runDir: string,
  answer: string,
): Promise<{ answerPath: string; hintsPath: string }> {
  const answerPath = path.join(runDir, "answer.md");
  const hintsPath = path.join(runDir, "hints.md");
  const hints = extractMarkdownSection(answer, "Hints") ?? "## Hints\n\nNo separate hints were generated.";
  await writeFile(answerPath, `${answer.trim()}\n`, "utf8");
  await writeFile(hintsPath, `${hints.trim()}\n`, "utf8");
  return { answerPath, hintsPath };
}

async function writeUiFallbackArtifacts(runDir: string, answer: string): Promise<void> {
  const answerPath = path.join(runDir, "answer.md");
  const hintsPath = path.join(runDir, "hints.md");
  const trimmed = answer.trim();
  await writeFile(answerPath, `${trimmed}\n`, "utf8");
  await writeFile(hintsPath, "## Hints\n\nNo separate hints were generated.\n", "utf8");
}

function buildTurnAnswerPrompt(basePrompt: string, turn: RunTurnArtifact): string {
  if (turn.kind !== "followup") {
    return basePrompt;
  }

  return [
    basePrompt,
    "",
    "Current follow-up turn:",
    turn.questionMarkdown.trim() || "Follow-up context was captured, but no separate text was available.",
    "",
    "Answer this follow-up directly while preserving the original question and answer as context. Do not rewrite the original answer unless the follow-up asks for a correction.",
  ].join("\n");
}

async function saveAnswerForTurn(
  runDir: string,
  turns: RunTurnArtifact[],
  turnIndex: number,
  answer: string,
  fallback = false,
): Promise<void> {
  const trimmed = answer.trim();
  const hints = fallback
    ? "## Hints\n\nNo separate hints were generated."
    : extractMarkdownSection(trimmed, "Hints") ?? "## Hints\n\nNo separate hints were generated.";
  const now = new Date().toISOString();
  turns[turnIndex] = {
    ...turns[turnIndex],
    answerMarkdown: trimmed,
    hintsMarkdown: hints.trim(),
    hasAnswer: Boolean(trimmed),
    updatedAt: now,
  };
  await writeTurnArtifacts(runDir, turns);
  if (turns[turnIndex].kind !== "original") {
    return;
  }
  if (fallback) {
    await writeUiFallbackArtifacts(runDir, trimmed);
  } else {
    await writeUiAnswerArtifacts(runDir, trimmed);
  }
}

function guardedAnswerMarkdown(answer: string, state: QuestionState): string | null {
  const trimmed = answer.trim();
  if (isMissingDetailsAnswer(trimmed) && hasUsableQuestionContext(state)) {
    return null;
  }
  return trimmed;
}

async function saveSuccessfulTurnAnswer(
  runPath: string,
  state: QuestionState,
  turns: RunTurnArtifact[],
  turnIndex: number,
  answer: string,
  sentScreenshotPaths: string[],
): Promise<void> {
  const sentState = await markScreenshotsSent(runPath, state, sentScreenshotPaths);
  if (turnIndex === turns.length - 1) {
    turns[turnIndex] = { ...turns[turnIndex], state: sentState };
  }
  await saveAnswerForTurn(runPath, turns, turnIndex, answer);
}

async function answerRun(
  outDir: string,
  runId: string,
  language: string,
  handoff: AnswerHandoff,
  profilePath: string | null,
  requestedTurnId: string | null = null,
): Promise<void> {
  const runPath = resolveRunPath(outDir, runId);
  if (!runPath) {
    throw new Error("Run not found.");
  }

  const state = await readOptionalJson<QuestionState>(path.join(runPath, "question-state.json"));
  if (!state) {
    throw new Error("Question state is missing.");
  }
  let turns = await ensureOriginalTurn(runPath, state);
  if (!turns.length) {
    throw new Error("Question state is missing.");
  }

  let turnIndex = requestedTurnId ? turns.findIndex((turn) => turn.id === requestedTurnId) : -1;
  if (turnIndex < 0) {
    const pendingIndex = turns.findIndex((turn) => !turn.answerMarkdown.trim());
    turnIndex = pendingIndex >= 0 ? pendingIndex : turns.length - 1;
  }

  const targetTurn = turns[turnIndex];
  const answerState = targetTurn.state ?? state;
  const pendingScreenshotPaths = pendingScreenshotPathsForState(runPath, answerState);
  const baseAnswerPrompt = buildAnswerPrompt(
    answerState,
    language,
    await readCandidateProfile(profilePath),
    pendingScreenshotPaths,
  );
  const answerPrompt = buildTurnAnswerPrompt(baseAnswerPrompt, targetTurn);
  const promptPath = path.join(runPath, "agent-prompt.md");
  const questionPath = path.join(runPath, "question.txt");
  await writeFile(promptPath, `${answerPrompt.trim()}\n`, "utf8");
  await writeFile(questionPath, `${targetTurn.questionMarkdown.trim() || answerState.question.prompt?.trim() || ""}\n`, "utf8");

  const repoRoot = path.resolve(packageRoot(), "..");

  if (handoff === "codex") {
    const agentResult = await askCodexCliAgent(repoRoot, promptPath, runPath, pendingScreenshotPaths);
    if (agentResult.answered) {
      const guarded = guardedAnswerMarkdown(agentResult.answer, answerState);
      if (guarded) {
        await saveSuccessfulTurnAnswer(runPath, state, turns, turnIndex, guarded, pendingScreenshotPaths);
        return;
      }

      const retryPrompt = buildAnswerRetryPrompt(answerPrompt);
      await writeFile(promptPath, `${retryPrompt.trim()}\n`, "utf8");
      const retryResult = await askCodexCliAgent(repoRoot, promptPath, runPath, pendingScreenshotPaths);
      const retryAnswer = retryResult.answered ? guardedAnswerMarkdown(retryResult.answer, answerState) : null;
      if (retryAnswer) {
        await saveSuccessfulTurnAnswer(runPath, state, turns, turnIndex, retryAnswer, pendingScreenshotPaths);
        return;
      }
    }

    const fallback = [
      "## Agent Handoff Ready",
      "",
      "Codex CLI did not return an answer in time, so the prompt is ready to paste manually.",
      "",
      `Prompt file: ${promptPath}`,
      "",
      agentResult.error ? `Codex error: ${agentResult.error}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await saveAnswerForTurn(runPath, turns, turnIndex, fallback, true);
    return;
  }

  if (handoff === "openclaw") {
    const agentResult = await askOpenClawAgent(repoRoot, promptPath);
    if (agentResult.answered) {
      const guarded = guardedAnswerMarkdown(agentResult.answer, answerState);
      if (guarded) {
        await saveSuccessfulTurnAnswer(runPath, state, turns, turnIndex, guarded, pendingScreenshotPaths);
        return;
      }

      const retryPrompt = buildAnswerRetryPrompt(answerPrompt);
      await writeFile(promptPath, `${retryPrompt.trim()}\n`, "utf8");
      const retryResult = await askOpenClawAgent(repoRoot, promptPath);
      const retryAnswer = retryResult.answered ? guardedAnswerMarkdown(retryResult.answer, answerState) : null;
      if (retryAnswer) {
        await saveSuccessfulTurnAnswer(runPath, state, turns, turnIndex, retryAnswer, pendingScreenshotPaths);
        return;
      }
    }

    const fallback = [
      "## Agent Handoff Ready",
      "",
      "OpenClaw did not return an answer from the CLI call, so the prompt is ready to paste manually.",
      "",
      `Prompt file: ${promptPath}`,
      "",
      agentResult.error ? `OpenClaw error: ${agentResult.error}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await saveAnswerForTurn(runPath, turns, turnIndex, fallback, true);
    return;
  }

  const fallback = [
    "## Prompt Ready",
    "",
    "The prompt is ready to paste into Codex, ChatGPT, or OpenClaw.",
    "",
    `Prompt file: ${promptPath}`,
  ].join("\n");
  await saveAnswerForTurn(runPath, turns, turnIndex, fallback, true);
}

function runTitle(state: QuestionState | null, runId: string): string {
  return state?.question.title ?? state?.question.prompt?.slice(0, 80) ?? runId;
}

function runKind(state: QuestionState | null): string {
  return state?.question.kind ?? "question";
}

async function optionalMtime(filePath: string): Promise<string | null> {
  try {
    return (await stat(filePath)).mtime.toISOString();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function summarizeRun(outDir: string, runId: string): Promise<RunSummary | null> {
  const runPath = resolveRunPath(outDir, runId);
  if (!runPath) {
    return null;
  }

  const answerPath = path.join(runPath, "answer.md");
  const hintsPath = path.join(runPath, "hints.md");
  const state = await readOptionalJson<QuestionState>(path.join(runPath, "question-state.json"));
  const answer = await readOptionalText(answerPath);
  const hints = await readOptionalText(hintsPath);
  const turns = await readTurnArtifacts(runPath);
  const hasTurnAnswer = turns.some((turn) => turn.answerMarkdown.trim());
  const runStat = await stat(runPath);
  const updatedAt = [
    runStat.mtime.toISOString(),
    state?.lastUpdatedAt ?? null,
    await optionalMtime(answerPath),
    await optionalMtime(hintsPath),
    await optionalMtime(path.join(runPath, "turns.json")),
  ]
    .filter((item): item is string => Boolean(item))
    .sort()
    .at(-1) ?? runStat.mtime.toISOString();

  return {
    id: runId,
    updatedAt,
    title: runTitle(state, runId),
    kind: runKind(state),
    completenessScore: state?.completenessScore ?? 0,
    readyToAnswer: state?.readyToAnswer ?? false,
    hasAnswer: Boolean(answer?.trim()) || hasTurnAnswer,
    hasHints: Boolean(hints?.trim()) || turns.some((turn) => turn.hintsMarkdown.trim()),
  };
}

async function readRunDetail(outDir: string, runId: string): Promise<RunDetail | null> {
  const summary = await summarizeRun(outDir, runId);
  const runPath = resolveRunPath(outDir, runId);
  if (!summary || !runPath) {
    return null;
  }

  const state = await readOptionalJson<QuestionState>(path.join(runPath, "question-state.json"));
  const answer = (await readOptionalText(path.join(runPath, "answer.md")))?.trim() ?? "";
  const hints = (await readOptionalText(path.join(runPath, "hints.md")))?.trim() ?? "";
  const storedTurns = await readTurnArtifacts(runPath);
  const turns = storedTurns.length
    ? storedTurns
    : answer
      ? await ensureOriginalTurn(runPath, state)
      : [];
  const screenshotFiles = await listScreenshotFiles(outDir, runId);
  const latestScreenshotFile = screenshotFiles.at(-1)?.path ?? null;
  const latestScreenshot = latestScreenshotFile
    ? `/api/runs/${encodeURIComponent(runId)}/latest-screen?updated=${encodeURIComponent(summary.updatedAt ?? "")}`
    : null;
  const screenshotUrls = screenshotFiles.map(
    (item, index) => `/api/runs/${encodeURIComponent(runId)}/screens/${index}?updated=${encodeURIComponent(item.updatedAt.toString())}`,
  );
  const screenshots = screenshotFiles.map((item, index) => ({
    index,
    url: screenshotUrls[index],
    status: item.status,
    canDelete: item.status === "pending",
  }));

  return {
    ...summary,
    state,
    answerMarkdown: answer,
    hintsMarkdown: hints,
    turns: turns.map(turnDetail),
    latestScreenshotUrl: latestScreenshot,
    screenshotUrls,
    screenshots,
    screenshotCount: screenshotFiles.length,
  };
}

async function listRuns(outDir: string): Promise<RunSummary[]> {
  await mkdir(outDir, { recursive: true });
  const entries = await readdir(outDir, { withFileTypes: true });
  const summaries = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => summarizeRun(outDir, entry.name)),
  );

  return summaries
    .filter((item): item is RunSummary => item !== null)
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
}

function normalizeScreenshotPath(runPath: string, item: string): string {
  return path.isAbsolute(item) ? path.resolve(item) : path.resolve(runPath, item);
}

function screenshotPathKey(runPath: string, item: string): string {
  return normalizeScreenshotPath(runPath, item).toLowerCase();
}

function pendingScreenshotPathsForState(runPath: string, state: QuestionState): string[] {
  const sent = new Set((state.sentScreenshotPaths ?? []).map((item) => screenshotPathKey(runPath, item)));
  const excluded = new Set((state.excludedScreenshotPaths ?? []).map((item) => screenshotPathKey(runPath, item)));
  return (state.screenshotPaths ?? []).filter((item) => {
    const key = screenshotPathKey(runPath, item);
    return !sent.has(key) && !excluded.has(key);
  });
}

async function writeStateWithScreenshotUpdates(
  runPath: string,
  state: QuestionState,
  updates: Partial<Pick<QuestionState, "screenshotPaths" | "sentScreenshotPaths" | "excludedScreenshotPaths">>,
): Promise<QuestionState> {
  const nextState: QuestionState = {
    ...state,
    screenshotPaths: updates.screenshotPaths ?? state.screenshotPaths ?? [],
    sentScreenshotPaths: updates.sentScreenshotPaths ?? state.sentScreenshotPaths ?? [],
    excludedScreenshotPaths: updates.excludedScreenshotPaths ?? state.excludedScreenshotPaths ?? [],
    lastUpdatedAt: new Date().toISOString(),
  };
  await writeQuestionState(runPath, nextState);
  return nextState;
}

async function markScreenshotsSent(runPath: string, state: QuestionState, sentPaths: string[]): Promise<QuestionState> {
  if (!sentPaths.length) {
    return state;
  }

  const seen = new Set<string>();
  const sentScreenshotPaths: string[] = [];
  for (const item of [...(state.sentScreenshotPaths ?? []), ...sentPaths]) {
    const key = screenshotPathKey(runPath, item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    sentScreenshotPaths.push(item);
  }

  return writeStateWithScreenshotUpdates(runPath, state, { sentScreenshotPaths });
}

async function listScreenshotFiles(outDir: string, runId: string): Promise<ScreenshotRecord[]> {
  const runPath = resolveRunPath(outDir, runId);
  if (!runPath) {
    return [];
  }

  const state = await readOptionalJson<QuestionState>(path.join(runPath, "question-state.json"));
  const orderedPaths: string[] = [];
  const seen = new Set<string>();
  const sent = new Set((state?.sentScreenshotPaths ?? []).map((item) => screenshotPathKey(runPath, item)));
  const excluded = new Set((state?.excludedScreenshotPaths ?? []).map((item) => screenshotPathKey(runPath, item)));

  if (state?.screenshotPaths && state.screenshotPaths.length > 0) {
    for (const item of state.screenshotPaths) {
      if (!item) {
        continue;
      }
      const absolutePath = normalizeScreenshotPath(runPath, item);
      const key = absolutePath.toLowerCase();
      if (!withinPath(runPath, absolutePath) || seen.has(key) || excluded.has(key)) {
        continue;
      }
      orderedPaths.push(absolutePath);
      seen.add(key);
    }
  }

  const screensDir = path.join(runPath, "screens");
  const dirFiles = await listScreenshotFilesInDir(screensDir);
  for (const file of dirFiles) {
    const key = file.path.toLowerCase();
    if (!seen.has(key) && !excluded.has(key)) {
      orderedPaths.push(file.path);
      seen.add(key);
    }
  }

  const results: ScreenshotRecord[] = [];
  for (const candidatePath of orderedPaths) {
    const updatedAt = await fileUpdatedAtMs(candidatePath);
    if (updatedAt === null) {
      continue;
    }
    const key = candidatePath.toLowerCase();
    results.push({ path: candidatePath, updatedAt, status: sent.has(key) ? "sent" : "pending" });
  }

  return results;
}

async function screenshotPathAtIndex(outDir: string, runId: string, index: number): Promise<string | null> {
  if (!Number.isFinite(index) || index < 0) {
    return null;
  }

  const screenshots = await listScreenshotFiles(outDir, runId);
  const target = screenshots[index];
  if (!target) {
    return null;
  }

  return target.path;
}

async function excludeScreenshotAtIndex(outDir: string, runId: string, index: number): Promise<RunDetail> {
  const runPath = resolveRunPath(outDir, runId);
  if (!runPath) {
    throw new Error("Invalid run id.");
  }

  const screenshots = await listScreenshotFiles(outDir, runId);
  const target = screenshots[index];
  if (!target) {
    throw new Error("Screenshot not found.");
  }

  const statePath = path.join(runPath, "question-state.json");
  const state = await readOptionalJson<QuestionState>(statePath);
  if (!state) {
    throw new Error("Question state is missing.");
  }

  const targetKey = target.path.toLowerCase();
  const screenshotPaths = (state.screenshotPaths ?? []).filter((item) => screenshotPathKey(runPath, item) !== targetKey);
  const excludedScreenshotPaths = [...(state.excludedScreenshotPaths ?? [])];
  if (!excludedScreenshotPaths.some((item) => screenshotPathKey(runPath, item) === targetKey)) {
    excludedScreenshotPaths.push(target.path);
  }

  await writeStateWithScreenshotUpdates(runPath, state, {
    screenshotPaths,
    excludedScreenshotPaths,
  });

  if (target.status === "pending") {
    await rm(target.path, { force: true });
  }

  const detail = await readRunDetail(outDir, runId);
  if (!detail) {
    throw new Error("Failed to read answer artifacts.");
  }
  return detail;
}

async function latestScreenshotPath(outDir: string, runId: string): Promise<string | null> {
  const screenshots = await listScreenshotFiles(outDir, runId);
  return screenshots.at(-1)?.path ?? null;
}

async function listScreenshotFilesInDir(dirPath: string): Promise<ScreenshotRecord[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name))
      .map((entry) => path.join(dirPath, entry.name));

    const records: ScreenshotRecord[] = [];
    for (const filePath of files) {
      const updatedAt = await fileUpdatedAtMs(filePath);
      if (updatedAt === null) {
        continue;
      }
      records.push({ path: filePath, updatedAt, status: "pending" });
    }

    return records.sort((left, right) => left.updatedAt - right.updatedAt);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function fileUpdatedAtMs(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function serveScreenshot(res: ServerResponse, filePath: string): void {
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

async function readImageTextSafely(imagePath: string): Promise<string | null> {
  try {
    const text = await readImageText(imagePath);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

async function serveDisplayPreview(res: ServerResponse, outDir: string, displayId: number): Promise<void> {
  const displays = await listDisplays();
  const display = displays.find((item) => item.id === displayId);
  if (!display) {
    sendJson(res, 404, { error: "Screen not found." });
    return;
  }

  const previewDir = path.join(outDir, ".previews");
  await mkdir(previewDir, { recursive: true });
  const previewPath = await captureScreen(previewDir, {
    x: display.x,
    y: display.y,
    width: display.width,
    height: display.height,
  });
  serveScreenshot(res, previewPath);
}

async function serveWindowPreview(res: ServerResponse, outDir: string, windowId: number): Promise<void> {
  const windows = await listWindows();
  const windowInfo = windows.find((item) => item.id === windowId);
  if (!windowInfo) {
    sendJson(res, 404, { error: "Window not found." });
    return;
  }

  const previewDir = path.join(outDir, ".previews");
  await mkdir(previewDir, { recursive: true });
  try {
    serveScreenshot(res, await captureWindowPreview(previewDir, windowInfo.id));
  } catch (_error) {
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
  }
}

function createMonitorController(options: UiServerOptions, outDir: string): {
  status: () => MonitorStatus;
  start: (screenId: number) => Promise<MonitorStatus>;
  stop: () => MonitorStatus;
  close: () => void;
} {
  let monitor: MonitorProcess | null = null;

  return {
    status: () => monitorStatus(monitor),
    start: async (screenId: number) => {
      const displays = await listDisplays();
      const display = displays.find((item) => item.id === screenId);
      if (!display) {
        throw new Error(`Screen ${screenId} was not found.`);
      }

      stopMonitorProcess(monitor);

      const spawnArgs = makeMonitorSpawnArgs(
        outDir,
        display.id,
        options.language ?? "python",
        options.intervalMs ?? 8000,
        options.profilePath,
        options.handoff,
      );
      const child = spawn("npm", spawnArgs, {
        cwd: packageRoot(),
        env: process.env,
        windowsHide: true,
        shell: process.platform === "win32",
      });

      monitor = {
        child,
        screenId: display.id,
        activeRunId: null,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        exitCode: null,
        lastError: null,
        log: [],
      };
      const activeMonitor = monitor;

      child.stdout.on("data", (chunk: Buffer) => {
        if (monitor === activeMonitor) {
          appendMonitorLog(activeMonitor, chunk);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (monitor === activeMonitor) {
          appendMonitorLog(activeMonitor, chunk);
        }
      });

      child.on("error", (error) => {
        if (monitor !== activeMonitor) {
          return;
        }
        activeMonitor.lastError = error.message;
        activeMonitor.stoppedAt = new Date().toISOString();
        activeMonitor.exitCode = -1;
      });

      child.on("close", (code) => {
        if (monitor !== activeMonitor) {
          return;
        }
        if (activeMonitor.exitCode !== null) {
          return;
        }
        activeMonitor.exitCode = code ?? 0;
        activeMonitor.stoppedAt = new Date().toISOString();
        if (code && code !== 0) {
          activeMonitor.lastError = `Watcher exited with code ${code}.`;
        }
      });

      return monitorStatus(monitor);
    },
    stop: () => {
      stopMonitorProcess(monitor);
      return monitorStatus(monitor);
    },
    close: () => {
      stopMonitorProcess(monitor);
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  outDir: string,
  monitorController: ReturnType<typeof createMonitorController>,
  options: UiServerOptions,
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const pathname = requestUrl.pathname;

  if (pathname === "/") {
    sendText(res, 200, pageHtml(), "text/html; charset=utf-8");
    return;
  }

  if (pathname === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (pathname === "/api/runs") {
    sendJson(res, 200, { runs: await listRuns(outDir) });
    return;
  }

  if (pathname === "/api/displays") {
    sendJson(res, 200, { displays: await listDisplays() });
    return;
  }

  if (pathname === "/api/windows") {
    sendJson(res, 200, { windows: await listWindows() });
    return;
  }

  const displayPreviewMatch = pathname.match(/^\/api\/displays\/(\d+)\/preview$/);
  if (displayPreviewMatch?.[1]) {
    await serveDisplayPreview(res, outDir, Number(displayPreviewMatch[1]));
    return;
  }

  const windowPreviewMatch = pathname.match(/^\/api\/windows\/(\d+)\/preview$/);
  if (windowPreviewMatch?.[1]) {
    await serveWindowPreview(res, outDir, Number(windowPreviewMatch[1]));
    return;
  }

  if (pathname === "/api/monitor/status") {
    sendJson(res, 200, monitorController.status());
    return;
  }

  if (pathname === "/api/monitor/start" && req.method === "POST") {
    const body = await readRequestJson(req);
    const screenId = Number(body.screenId);
    if (!Number.isInteger(screenId) || screenId <= 0) {
      sendJson(res, 400, { error: "screenId must be a positive integer." });
      return;
    }

    sendJson(res, 200, await monitorController.start(screenId));
    return;
  }

  if (pathname === "/api/monitor/stop" && req.method === "POST") {
    sendJson(res, 200, monitorController.stop());
    return;
  }

  const resetRunMatch = pathname.match(/^\/api\/runs\/([^/]+)\/reset$/);
  if (resetRunMatch?.[1] && req.method === "POST") {
    const runId = decodeURIComponent(resetRunMatch[1]);
    const runPath = resolveRunPath(outDir, runId);
    if (!runPath) {
      sendJson(res, 400, { error: "Invalid run id." });
      return;
    }

    const statePath = path.join(runPath, "question-state.json");
    const currentState = await readOptionalJson<QuestionState>(statePath);
    if (!currentState) {
      sendJson(res, 404, { error: "Run not found." });
      return;
    }
    await clearRunState(runPath);
    const detail = await readRunDetail(outDir, runId);
    if (!detail) {
      sendJson(res, 500, { error: "Failed to read answer artifacts." });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  const captureRunMatch = pathname.match(/^\/api\/runs\/([^/]+)\/capture$/);
  if (captureRunMatch?.[1] && req.method === "POST") {
    const runId = decodeURIComponent(captureRunMatch[1]);
    const body = await readRequestJson(req);
    const screenId = Number(body.screenId);
    const windowId = Number(body.windowId);
    if ((!Number.isInteger(screenId) || screenId <= 0) && (!Number.isInteger(windowId) || windowId <= 0)) {
      sendJson(res, 400, { error: "screenId or windowId must be a positive integer." });
      return;
    }

    const detail = await captureScreenshotForRun(outDir, runId, Number.isInteger(windowId) && windowId > 0 ? { windowId } : { screenId });
    sendJson(res, 200, detail);
    return;
  }

  const captureImageRunMatch = pathname.match(/^\/api\/runs\/([^/]+)\/capture-image$/);
  if (captureImageRunMatch?.[1] && req.method === "POST") {
    const runId = decodeURIComponent(captureImageRunMatch[1]);
    const body = await readRequestJson(req);
    const detail = await captureUploadedImageForRun(outDir, runId, body.imageData);
    sendJson(res, 200, detail);
    return;
  }

  if (pathname === "/api/capture" && req.method === "POST") {
    const body = await readRequestJson(req);
    const requestedRunId = normalizeCaptureRunId(body.runId);
    const runId = requestedRunId ?? makeRunId();
    const screenId = Number(body.screenId);
    const windowId = Number(body.windowId);
    if ((!Number.isInteger(screenId) || screenId <= 0) && (!Number.isInteger(windowId) || windowId <= 0)) {
      sendJson(res, 400, { error: "screenId or windowId must be a positive integer." });
      return;
    }

    const detail = await captureScreenshotForRun(outDir, runId, Number.isInteger(windowId) && windowId > 0 ? { windowId } : { screenId });
    sendJson(res, 200, detail);
    return;
  }

  if (pathname === "/api/capture-image" && req.method === "POST") {
    const body = await readRequestJson(req);
    const requestedRunId = normalizeCaptureRunId(body.runId);
    const runId = requestedRunId ?? makeRunId();
    const detail = await captureUploadedImageForRun(outDir, runId, body.imageData);
    sendJson(res, 200, detail);
    return;
  }

  const transcriptRunMatch = pathname.match(/^\/api\/runs\/([^/]+)\/transcript$/);
  if (transcriptRunMatch?.[1] && req.method === "POST") {
    const runId = decodeURIComponent(transcriptRunMatch[1]);
    const body = await readRequestJson(req);
    const transcript = typeof body.text === "string" ? body.text.trim() : "";
    if (!transcript) {
      sendJson(res, 400, { error: "text is required." });
      return;
    }

    const detail = await addTranscriptToRun(outDir, runId, transcript);
    sendJson(res, 200, detail);
    return;
  }

  if (pathname === "/api/transcript" && req.method === "POST") {
    const body = await readRequestJson(req);
    const requestedRunId = normalizeCaptureRunId(body.runId);
    const runId = requestedRunId ?? makeRunId();
    const transcript = typeof body.text === "string" ? body.text.trim() : "";
    if (!transcript) {
      sendJson(res, 400, { error: "text is required." });
      return;
    }

    const detail = await addTranscriptToRun(outDir, runId, transcript);
    sendJson(res, 200, detail);
    return;
  }

  const answerRunMatch = pathname.match(/^\/api\/runs\/([^/]+)\/answer$/);
  if (answerRunMatch?.[1] && req.method === "POST") {
    const runId = decodeURIComponent(answerRunMatch[1]);
    const body = await readRequestJson(req);
    const requestedTurnId = typeof body.turnId === "string" && /^[a-zA-Z0-9._-]+$/.test(body.turnId)
      ? body.turnId
      : null;
    const runPath = resolveRunPath(outDir, runId);
    if (!runPath) {
      sendJson(res, 400, { error: "Invalid run id." });
      return;
    }

    const runState = await readOptionalJson<QuestionState>(path.join(runPath, "question-state.json"));
    if (!runState) {
      sendJson(res, 404, { error: "Run not found." });
      return;
    }

    await answerRun(
      outDir,
      runId,
      options.language ?? "python",
      options.handoff,
      options.profilePath ?? null,
      requestedTurnId,
    );
    const detail = await readRunDetail(outDir, runId);
    if (!detail) {
      sendJson(res, 500, { error: "Failed to read answer artifacts." });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch?.[1]) {
    const detail = await readRunDetail(outDir, decodeURIComponent(runMatch[1]));
    if (!detail) {
      sendJson(res, 404, { error: "Run not found." });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  const screenshotMatch = pathname.match(/^\/api\/runs\/([^/]+)\/latest-screen$/);
  if (screenshotMatch?.[1]) {
    const filePath = await latestScreenshotPath(outDir, decodeURIComponent(screenshotMatch[1]));
    if (!filePath) {
      sendJson(res, 404, { error: "Screenshot not found." });
      return;
    }
    serveScreenshot(res, filePath);
    return;
  }

  const screenshotIndexMatch = pathname.match(/^\/api\/runs\/([^/]+)\/screens\/(\d+)$/);
  if (screenshotIndexMatch?.[1] && screenshotIndexMatch[2]) {
    const runId = decodeURIComponent(screenshotIndexMatch[1]);
    const screenshotIndex = Number(screenshotIndexMatch[2]);
    if (req.method === "DELETE") {
      const detail = await excludeScreenshotAtIndex(outDir, runId, screenshotIndex);
      sendJson(res, 200, detail);
      return;
    }

    const filePath = await screenshotPathAtIndex(outDir, runId, screenshotIndex);
    if (!filePath) {
      sendJson(res, 404, { error: "Screenshot not found." });
      return;
    }
    serveScreenshot(res, filePath);
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const monitorController = createMonitorController(options, outDir);

  const server = createServer((req, res) => {
    handleRequest(req, res, outDir, monitorController, options).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "127.0.0.1");
  });

  return {
    url: `http://127.0.0.1:${options.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        monitorController.close();
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
