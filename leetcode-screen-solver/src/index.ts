import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { askCodexCliAgent, askOpenClawAgent } from "./agentHandoff.js";
import { parseArgs, helpText } from "./args.js";
import { loadEnvFiles } from "./env.js";
import { startListenServer, type ListenStatus } from "./listenServer.js";
import { readImageText, shutdownOcrWorker } from "./localOcr.js";
import { observeTranscriptLocally } from "./localTranscript.js";
import { extractMarkdownSection } from "./markdown.js";
import { buildAnswerPrompt, buildAnswerRetryPrompt, hasUsableQuestionContext, isMissingDetailsAnswer } from "./prompts.js";
import { captureClipboardImage, captureScreen, listDisplays, makeRunId } from "./screen.js";
import { observeScreenshotLocally } from "./screenshotObservation.js";
import {
  createEmptyState,
  mergeObservation,
  statusLine,
} from "./state.js";
import { startUiServer, type UiServerHandle } from "./ui.js";
import type { CliOptions, QuestionState } from "./types.js";
import type { DisplayInfo } from "./types.js";

interface ControlState {
  solveRequested: boolean;
  resetRequested: boolean;
  quitRequested: boolean;
}

interface AnswerResult {
  answered: boolean;
  answerMarkdown: string | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };

    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}

function setupControls(control: ControlState): () => void {
  if (!process.stdin.isTTY) {
    return () => undefined;
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);

  const onKeypress = (_value: string, key: readline.Key) => {
    if (key.ctrl && key.name === "c") {
      control.quitRequested = true;
      return;
    }

    if (key.name === "q") {
      control.quitRequested = true;
      return;
    }

    if (key.name === "s" || key.name === "a") {
      control.solveRequested = true;
      return;
    }

    if (key.name === "r") {
      control.resetRequested = true;
    }
  };

  process.stdin.on("keypress", onKeypress);

  return () => {
    process.stdin.off("keypress", onKeypress);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  };
}

function formatMissing(state: QuestionState): string {
  if (state.missingInformation.length === 0) {
    return "none";
  }

  return state.missingInformation.join("; ");
}

async function keepUiOpen(ui: UiServerHandle | null): Promise<void> {
  if (!ui) {
    return;
  }

  console.log("");
  console.log(`UI is still running at ${ui.url}. Press Ctrl+C here when finished.`);
  await waitForShutdownSignal();
}

function displayLabel(display: DisplayInfo): string {
  return `${display.id}. ${display.label}`;
}

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function chooseDisplay(displays: DisplayInfo[], requestedScreen: number | null): Promise<DisplayInfo> {
  const defaultDisplay = displays.find((display) => display.primary) ?? displays[0];

  if (requestedScreen !== null) {
    const requested = displays.find((display) => display.id === requestedScreen);
    if (!requested) {
      throw new Error(`Screen ${requestedScreen} was not found. Available screens:\n${displays.map(displayLabel).join("\n")}`);
    }

    return requested;
  }

  if (!process.stdin.isTTY) {
    return defaultDisplay;
  }

  console.log("Which screen has the interview question?");
  for (const display of displays) {
    console.log(`  ${displayLabel(display)}`);
  }

  while (true) {
    const answer = (await promptLine(`Screen number [${defaultDisplay.id}]: `)).trim();
    const selectedId = answer.length === 0 ? defaultDisplay.id : Number(answer);
    const selected = displays.find((display) => display.id === selectedId);

    if (selected) {
      return selected;
    }

    console.log("Enter one of the listed screen numbers.");
  }
}

async function configureCaptureScreen(options: CliOptions): Promise<void> {
  if (options.command !== "watch" && options.command !== "once") {
    return;
  }

  if (options.region) {
    return;
  }

  const displays = await listDisplays();
  if (displays.length === 0) {
    console.log("Could not list screens on this system. Capturing the full virtual screen.");
    return;
  }

  const selected = await chooseDisplay(displays, options.screenIndex);
  options.region = {
    x: selected.x,
    y: selected.y,
    width: selected.width,
    height: selected.height,
  };

  console.log(`Monitoring screen ${displayLabel(selected)}.`);
  console.log("");
}

async function writeState(runDir: string, state: QuestionState): Promise<void> {
  await writeFile(path.join(runDir, "question-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function clearAnswerArtifacts(runDir: string): Promise<void> {
  await Promise.all([
    rm(path.join(runDir, "answer.md"), { force: true }).catch(() => undefined),
    rm(path.join(runDir, "hints.md"), { force: true }).catch(() => undefined),
    rm(path.join(runDir, "agent-prompt.md"), { force: true }).catch(() => undefined),
    rm(path.join(runDir, "question.txt"), { force: true }).catch(() => undefined),
  ]);
}

async function readCandidateContext(profilePath: string | null): Promise<string | null> {
  if (!profilePath) {
    return null;
  }

  return readFile(path.resolve(profilePath), "utf8");
}

async function writeAnswerArtifacts(
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

async function writePromptFile(promptPath: string, answerPrompt: string): Promise<void> {
  await writeFile(promptPath, `${answerPrompt.trim()}\n`, "utf8");
}

function guardedAnswerMarkdown(answer: string, state: QuestionState): string | null {
  const trimmed = answer.trim();
  if (isMissingDetailsAnswer(trimmed) && hasUsableQuestionContext(state)) {
    return null;
  }
  return trimmed;
}

function screenshotPathKey(runDir: string, item: string): string {
  return (path.isAbsolute(item) ? path.resolve(item) : path.resolve(runDir, item)).toLowerCase();
}

function pendingScreenshotPathsForState(runDir: string, state: QuestionState): string[] {
  const sent = new Set((state.sentScreenshotPaths ?? []).map((item) => screenshotPathKey(runDir, item)));
  const excluded = new Set((state.excludedScreenshotPaths ?? []).map((item) => screenshotPathKey(runDir, item)));
  return (state.screenshotPaths ?? []).filter((item) => {
    const key = screenshotPathKey(runDir, item);
    return !sent.has(key) && !excluded.has(key);
  });
}

async function markScreenshotsSent(runDir: string, state: QuestionState, sentPaths: string[]): Promise<QuestionState> {
  if (!sentPaths.length) {
    return state;
  }

  const seen = new Set<string>();
  const sentScreenshotPaths: string[] = [];
  for (const item of [...(state.sentScreenshotPaths ?? []), ...sentPaths]) {
    const key = screenshotPathKey(runDir, item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    sentScreenshotPaths.push(item);
  }

  const nextState = { ...state, sentScreenshotPaths, lastUpdatedAt: new Date().toISOString() };
  await writeState(runDir, nextState);
  return nextState;
}

async function produceAgentHandoffAnswer(
  options: CliOptions,
  repoRoot: string,
  runDir: string,
  state: QuestionState,
  candidateContext: string | null,
): Promise<AnswerResult & { answerPrompt: string }> {
  if (!state.readyToAnswer) {
    console.log(`Not answering yet. Missing: ${formatMissing(state)}`);
    return { answered: false, answerMarkdown: null, answerPrompt: "" };
  }

  const pendingScreenshotPaths = pendingScreenshotPathsForState(runDir, state);
  const answerPrompt = buildAnswerPrompt(state, options.language, candidateContext, pendingScreenshotPaths);
  const promptPath = path.join(runDir, "agent-prompt.md");
  const questionPath = path.join(runDir, "question.txt");
  await writePromptFile(promptPath, answerPrompt);
  await writeFile(questionPath, `${state.question.prompt?.trim() ?? ""}\n`, "utf8");

  if (options.handoff === "codex") {
    console.log(`Asking Codex CLI to answer: ${promptPath}`);
    const agentResult = await askCodexCliAgent(repoRoot, promptPath, runDir, pendingScreenshotPaths);
    if (agentResult.answered) {
      const guarded = guardedAnswerMarkdown(agentResult.answer, state);
      if (guarded) {
        await markScreenshotsSent(runDir, state, pendingScreenshotPaths);
        const { answerPath, hintsPath } = await writeAnswerArtifacts(runDir, guarded);
        console.log(`Saved Codex answer: ${answerPath}`);
        console.log(`Saved hints: ${hintsPath}`);
        return {
          answered: true,
          answerMarkdown: guarded,
          answerPrompt,
        };
      }

      const retryPrompt = buildAnswerRetryPrompt(answerPrompt);
      await writePromptFile(promptPath, retryPrompt);
      const retryResult = await askCodexCliAgent(repoRoot, promptPath, runDir, pendingScreenshotPaths);
      const retryAnswer = retryResult.answered ? guardedAnswerMarkdown(retryResult.answer, state) : null;
      if (retryAnswer) {
        await markScreenshotsSent(runDir, state, pendingScreenshotPaths);
        const { answerPath, hintsPath } = await writeAnswerArtifacts(runDir, retryAnswer);
        console.log(`Saved Codex retry answer: ${answerPath}`);
        console.log(`Saved hints: ${hintsPath}`);
        return {
          answered: true,
          answerMarkdown: retryAnswer,
          answerPrompt: retryPrompt,
        };
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
    await writeAnswerArtifacts(runDir, fallback);
    return { answered: true, answerMarkdown: fallback, answerPrompt };
  }

  if (options.handoff === "openclaw") {
    console.log(`Asking OpenClaw to answer: ${promptPath}`);
    const agentResult = await askOpenClawAgent(repoRoot, promptPath);
    if (agentResult.answered) {
      const guarded = guardedAnswerMarkdown(agentResult.answer, state);
      if (guarded) {
        await markScreenshotsSent(runDir, state, pendingScreenshotPaths);
        const { answerPath, hintsPath } = await writeAnswerArtifacts(runDir, guarded);
        console.log(`Saved OpenClaw answer: ${answerPath}`);
        console.log(`Saved hints: ${hintsPath}`);
        return {
          answered: true,
          answerMarkdown: guarded,
          answerPrompt,
        };
      }

      const retryPrompt = buildAnswerRetryPrompt(answerPrompt);
      await writePromptFile(promptPath, retryPrompt);
      const retryResult = await askOpenClawAgent(repoRoot, promptPath);
      const retryAnswer = retryResult.answered ? guardedAnswerMarkdown(retryResult.answer, state) : null;
      if (retryAnswer) {
        await markScreenshotsSent(runDir, state, pendingScreenshotPaths);
        const { answerPath, hintsPath } = await writeAnswerArtifacts(runDir, retryAnswer);
        console.log(`Saved OpenClaw retry answer: ${answerPath}`);
        console.log(`Saved hints: ${hintsPath}`);
        return {
          answered: true,
          answerMarkdown: retryAnswer,
          answerPrompt: retryPrompt,
        };
      }
    }

    const fallback = [
      "## Agent Handoff Ready",
      "",
      "OpenClaw did not return an answer from the CLI call, so the prompt is ready to paste into Codex, ChatGPT, or OpenClaw manually.",
      "",
      `Prompt file: ${promptPath}`,
      "",
      agentResult.error ? `OpenClaw error: ${agentResult.error}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    await writeAnswerArtifacts(runDir, fallback);
    return { answered: true, answerMarkdown: fallback, answerPrompt };
  }

  const fallback = [
    "## Prompt Ready",
    "",
    "The prompt is ready to paste into Codex, ChatGPT, or OpenClaw.",
    "",
    `Prompt file: ${promptPath}`,
  ].join("\n");
  await writeAnswerArtifacts(runDir, fallback);
  return { answered: true, answerMarkdown: fallback, answerPrompt };
}

async function stageInputImage(runDir: string, inputPath: string, index: number): Promise<string> {
  const absoluteInput = path.resolve(inputPath);
  const ext = path.extname(absoluteInput) || ".png";
  const screenDir = path.join(runDir, "screens");
  await mkdir(screenDir, { recursive: true });

  const stagedPath = path.join(screenDir, `input-${String(index + 1).padStart(2, "0")}${ext}`);
  await copyFile(absoluteInput, stagedPath);
  return stagedPath;
}

async function observeImage(
  runDir: string,
  state: QuestionState,
  imagePath: string,
  storeScreenshot = true,
): Promise<{ state: QuestionState; hasQuestion: boolean; userInstruction: string; resetForNewQuestion: boolean }> {
  let visibleText: string | null = null;
  try {
    const text = await readImageText(imagePath);
    visibleText = text.trim() ? text : null;
  } catch {
    visibleText = null;
  }

  const observation = observeScreenshotLocally(state, imagePath, visibleText);
  const nextState = mergeObservation(state, observation, {
    kind: "screenshot",
    path: imagePath,
    storeScreenshot,
  });
  await writeState(runDir, nextState);

  return {
    state: nextState,
    hasQuestion: true,
    userInstruction: observation.userInstruction,
    resetForNewQuestion: false,
  };
}

async function writeTranscriptChunk(runDir: string, transcript: string, index: number): Promise<string> {
  const transcriptDir = path.join(runDir, "transcripts");
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, `chunk-${String(index).padStart(3, "0")}.txt`);
  await writeFile(transcriptPath, `${transcript.trim()}\n`, "utf8");
  return transcriptPath;
}

async function observeTranscript(
  runDir: string,
  state: QuestionState,
  transcript: string,
  transcriptPath: string,
): Promise<{ state: QuestionState; hasQuestion: boolean; userInstruction: string; resetForNewQuestion: boolean }> {
  const observation = observeTranscriptLocally(state, transcript);

  if (!observation.screenHasQuestion) {
    return { state, hasQuestion: false, userInstruction: observation.userInstruction, resetForNewQuestion: false };
  }

  const nextState = mergeObservation(state, observation, {
    kind: "transcript",
    path: transcriptPath,
    transcriptText: transcript,
  });
  await writeState(runDir, nextState);

  return { state: nextState, hasQuestion: true, userInstruction: observation.userInstruction, resetForNewQuestion: false };
}

function printObservationStatus(state: QuestionState, userInstruction: string): void {
  console.log(statusLine(state));
  if (state.readyToAnswer) {
    console.log("Ready to answer. Press a or s to prepare an answer, or keep scrolling if you want more context.");
    return;
  }

  console.log(`Missing: ${formatMissing(state)}`);
  if (userInstruction) {
    console.log(`Next: ${userInstruction}`);
  }
}

async function runListenMode(
  options: CliOptions,
  repoRoot: string,
  runDir: string,
  candidateContext: string | null,
): Promise<void> {
  let state = createEmptyState();
  let transcriptChunks = 0;
  let transcriptText = "";
  let answerMarkdown = "";
  let answerPrompt = "";
  let lastTranscript: string | null = null;
  let lastError: string | null = null;
  let processing = false;

  await writeState(runDir, state);

  const getStatus = (): ListenStatus => ({
    runDir,
    state,
    transcriptText: transcriptText.trim(),
    answerMarkdown,
    answerPrompt,
    processing,
    lastTranscript,
    lastError,
  });

  const rememberAnswer = (result: AnswerResult & { answerPrompt?: string }): void => {
    answerMarkdown = result.answerMarkdown ?? "";
    answerPrompt = result.answerPrompt ?? answerPrompt;
  };

  const server = await startListenServer({
    port: options.port,
    autoAnswerDefault: options.autoSolve,
    getStatus,
    onTranscript: async ({ text }) => {
      processing = true;
      lastError = null;
      try {
        const transcript = text.trim();
        lastTranscript = transcript || null;

        if (!transcript) {
          return;
        }

        transcriptChunks += 1;
        transcriptText = transcriptText ? `${transcriptText}\n\n${transcript}` : transcript;
        const transcriptPath = await writeTranscriptChunk(runDir, transcript, transcriptChunks);
        console.log(`Transcript ${transcriptChunks}: ${transcript}`);

        const result = await observeTranscript(runDir, state, transcript, transcriptPath);
        state = result.state;

        if (!result.hasQuestion) {
          console.log("No interview question detected in that transcript chunk.");
          return;
        }

        if (result.resetForNewQuestion) {
          answerMarkdown = "";
          answerPrompt = "";
          await clearAnswerArtifacts(runDir);
          console.log("Detected a different question. Started a fresh capture.");
        }

        printObservationStatus(state, result.userInstruction);

        if (options.autoSolve && state.readyToAnswer) {
          rememberAnswer(await produceAgentHandoffAnswer(options, repoRoot, runDir, state, candidateContext));
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.error(lastError);
        throw error;
      } finally {
        processing = false;
      }
    },
    onAnswerRequest: async () => {
      processing = true;
      lastError = null;
      try {
        rememberAnswer(await produceAgentHandoffAnswer(options, repoRoot, runDir, state, candidateContext));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.error(lastError);
        throw error;
      } finally {
        processing = false;
      }
    },
    onResetRequest: async () => {
      state = createEmptyState();
      transcriptText = "";
      answerMarkdown = "";
      answerPrompt = "";
      lastTranscript = null;
      lastError = null;
      await clearAnswerArtifacts(runDir);
      await writeState(runDir, state);
      console.log("Reset captured question context.");
    },
  });

  try {
    console.log(`Listen UI: ${server.url}`);
    console.log(`Run directory: ${runDir}`);
    console.log(`Handoff: ${options.handoff}`);
    console.log("Open the URL in Chrome or Edge, start listening, then keep this terminal open.");
    console.log("Press Ctrl+C here when finished.");
    await waitForShutdownSignal();
  } finally {
    await server.close();
  }
}

async function run(options: CliOptions): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const packageRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(packageRoot, "..");

  loadEnvFiles([path.join(repoRoot, ".env"), path.join(packageRoot, ".env"), path.join(process.cwd(), ".env")]);

  if (options.command === "ui") {
    const ui = await startUiServer({
      outDir: options.outDir,
      port: options.port,
      intervalMs: options.intervalMs,
      handoff: options.handoff,
      language: options.language,
      profilePath: options.profilePath,
    });
    console.log(`Answer UI: ${ui.url}`);
    console.log(`Reading runs from: ${path.resolve(options.outDir)}`);
    console.log("Press Ctrl+C to stop.");
    await waitForShutdownSignal();
    await ui.close();
    return;
  }

  if (options.command === "listen") {
    const candidateContext = await readCandidateContext(options.profilePath);
    const runDir = path.resolve(options.outDir, makeRunId());
    await mkdir(runDir, { recursive: true });

    console.log("Listen mode uses browser speech recognition and Codex/OpenClaw/clipboard handoff. OPENAI_API_KEY is not required.");
    if (options.profilePath) {
      console.log(`Candidate context: ${path.resolve(options.profilePath)}`);
    }
    await runListenMode(options, repoRoot, runDir, candidateContext);
    return;
  }

  let ui: UiServerHandle | null = null;
  if (options.uiEnabled) {
    ui = await startUiServer({
      outDir: options.outDir,
      port: options.port,
      intervalMs: options.intervalMs,
      handoff: options.handoff,
      language: options.language,
      profilePath: options.profilePath,
    });
    console.log(`Answer UI: ${ui.url}`);
    console.log("");
  }

  await configureCaptureScreen(options);

  const candidateContext = await readCandidateContext(options.profilePath);
  const runDir = path.resolve(options.outDir, makeRunId());
  await mkdir(runDir, { recursive: true });

  let state = createEmptyState();
  const control: ControlState = {
    solveRequested: false,
    resetRequested: false,
    quitRequested: false,
  };
  const cleanupControls = options.command === "watch" ? setupControls(control) : () => undefined;

  console.log("Mode: screenshot handoff + Codex/OpenClaw/clipboard. OPENAI_API_KEY is not required.");
  console.log(`Run directory: ${runDir}`);
  if (options.command === "watch" || options.command === "once") {
    if (options.region) {
      console.log(
        `Capturing region: ${options.region.x},${options.region.y},${options.region.width},${options.region.height}`,
      );
    } else {
      console.log("Capturing the full virtual screen.");
    }
  }
  if (options.command === "watch") {
    console.log("Watch mode monitors the selected screen and can produce answers when the question is ready.");
    console.log("Controls: a/s answer, r reset, q quit.");
    if (!options.autoSolve) {
      console.log("Tip: add --auto to answer as soon as capture is complete.");
    }
  }
  if (options.profilePath) {
    console.log(`Candidate context: ${path.resolve(options.profilePath)}`);
  }
  console.log("");

  let observations = 0;
  let solvedForCurrentQuestion = false;

  try {
    if (options.command === "image" || options.command === "clipboard") {
      const imagePaths =
        options.command === "clipboard"
          ? [await captureClipboardImage(runDir)]
          : await Promise.all(options.imagePaths.map((item, itemIndex) => stageInputImage(runDir, item, itemIndex)));

      for (const imagePath of imagePaths) {
        observations += 1;
        console.log(`Reading screenshot ${observations}: ${imagePath}`);
        const result = await observeImage(runDir, state, imagePath, true);
        state = result.state;

        if (!result.hasQuestion) {
          console.log("No interview question detected in that screenshot.");
          continue;
        }

        if (result.resetForNewQuestion) {
          await clearAnswerArtifacts(runDir);
          console.log("Detected a different question. Started a fresh capture.");
        }
        printObservationStatus(state, result.userInstruction);
      }

      if (state.observations > 0) {
        const answerResult = await produceAgentHandoffAnswer(options, repoRoot, runDir, state, candidateContext);
        solvedForCurrentQuestion = answerResult.answered;
      }
      await keepUiOpen(ui);
      return;
    }

    while (!control.quitRequested) {
      if (options.maxScreens !== null && observations >= options.maxScreens) {
        console.log("Reached --max-screens.");
        break;
      }

      if (control.resetRequested) {
        state = createEmptyState();
        solvedForCurrentQuestion = false;
        control.resetRequested = false;
        await clearAnswerArtifacts(runDir);
        console.log("Reset captured question context.");
      }

      observations += 1;
      const screenshotPath = await captureScreen(runDir, options.region);
      console.log(`Observed screen ${observations}: ${path.basename(screenshotPath)}`);

      const result = await observeImage(runDir, state, screenshotPath, options.keepAllScreens);
      state = result.state;

      if (!result.hasQuestion) {
        console.log("No interview question detected yet.");
        if (!options.keepAllScreens) {
          await rm(screenshotPath, { force: true });
        }

        if (options.command === "once") {
          break;
        }

        await delay(options.intervalMs);
        continue;
      }

      if (result.resetForNewQuestion) {
        console.log("Detected a different question. Started a fresh capture.");
        solvedForCurrentQuestion = false;
        await clearAnswerArtifacts(runDir);
      }
      printObservationStatus(state, result.userInstruction);

      const shouldAttemptAnswer =
        !solvedForCurrentQuestion &&
        state.readyToAnswer &&
        (control.solveRequested || options.autoSolve || options.command === "once");

      if (shouldAttemptAnswer) {
        control.solveRequested = false;
        const answerResult = await produceAgentHandoffAnswer(options, repoRoot, runDir, state, candidateContext);
        solvedForCurrentQuestion = answerResult.answered;

        if (solvedForCurrentQuestion && (options.command === "once" || (options.command === "watch" && !options.uiEnabled))) {
          break;
        }
      }

      console.log("");
      await delay(options.intervalMs);
    }

    if (!solvedForCurrentQuestion && state.observations > 0) {
      console.log("");
      console.log(`Final status: ${statusLine(state)}`);
      if (!state.readyToAnswer) {
        console.log(`Still missing: ${formatMissing(state)}`);
      }
      console.log(`Saved captured state: ${path.join(runDir, "question-state.json")}`);
    }

    if (options.command !== "watch") {
      await keepUiOpen(ui);
    }
  } finally {
    cleanupControls();
    if (ui) {
      await ui.close();
    }
    await shutdownOcrWorker();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }

  await run(options);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
