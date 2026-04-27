import type { AnswerHandoff, CliOptions, Command, ScreenRegion } from "./types.js";

const DEFAULT_INTERVAL_MS = 8000;
const DEFAULT_UI_PORT = 4378;

function parsePositiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return parsed;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parseRegion(value: string): ScreenRegion {
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isFinite(part)) ||
    parts[2] <= 0 ||
    parts[3] <= 0
  ) {
    throw new Error("region must be formatted as x,y,width,height.");
  }

  return {
    x: Math.round(parts[0]),
    y: Math.round(parts[1]),
    width: Math.round(parts[2]),
    height: Math.round(parts[3]),
  };
}

function parseHandoff(value: string): AnswerHandoff {
  const cleaned = value.trim().toLowerCase();
  if (cleaned === "codex" || cleaned === "openclaw" || cleaned === "clipboard") {
    return cleaned;
  }

  throw new Error("--handoff must be codex, openclaw, or clipboard.");
}

function readFlagValue(args: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const current = args[index];
  const prefix = `${flag}=`;
  if (current.startsWith(prefix)) {
    return { value: current.slice(prefix.length), nextIndex: index };
  }

  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return { value: next, nextIndex: index + 1 };
}

export function parseArgs(argv: string[]): CliOptions {
  let command: Command = "watch";
  let index = 0;
  let autoSolveExplicit = false;

  if (
    argv[0] === "watch" ||
    argv[0] === "once" ||
    argv[0] === "image" ||
    argv[0] === "clipboard" ||
    argv[0] === "listen" ||
    argv[0] === "ui"
  ) {
    command = argv[0] as Command;
    index = 1;
  }

  const options: CliOptions = {
    command,
    intervalMs: DEFAULT_INTERVAL_MS,
    language: "python",
    outDir: "runs",
    region: null,
    screenIndex: null,
    uiEnabled: false,
    port: DEFAULT_UI_PORT,
    autoSolve: command === "watch",
    keepAllScreens: false,
    maxScreens: null,
    handoff: "codex",
    imagePaths: [],
    profilePath: null,
    help: false,
  };

  for (; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--auto") {
      autoSolveExplicit = true;
      options.autoSolve = true;
      continue;
    }

    if (arg === "--manual") {
      autoSolveExplicit = true;
      options.autoSolve = false;
      continue;
    }

    if (arg === "--once") {
      command = "once";
      options.command = command;
      continue;
    }

    if (arg === "--listen") {
      command = "listen";
      options.command = command;
      continue;
    }

    if (arg === "--clipboard") {
      command = "clipboard";
      options.command = command;
      continue;
    }

    if (arg === "--keep-all-screens") {
      options.keepAllScreens = true;
      continue;
    }

    if (arg === "--ui") {
      options.uiEnabled = true;
      continue;
    }

    if (arg === "--interval" || arg.startsWith("--interval=")) {
      const { value, nextIndex } = readFlagValue(argv, index, "--interval");
      options.intervalMs = Math.round(parsePositiveNumber(value, "--interval") * 1000);
      index = nextIndex;
      continue;
    }

    if (arg === "--language" || arg.startsWith("--language=")) {
      const { value, nextIndex } = readFlagValue(argv, index, "--language");
      options.language = value.trim() || options.language;
      index = nextIndex;
      continue;
    }

    if (arg === "--out" || arg.startsWith("--out=")) {
      const { value, nextIndex } = readFlagValue(argv, index, "--out");
      options.outDir = value.trim() || options.outDir;
      index = nextIndex;
      continue;
    }

    if (arg === "--region" || arg.startsWith("--region=")) {
      const { value, nextIndex } = readFlagValue(argv, index, "--region");
      options.region = parseRegion(value);
      index = nextIndex;
      continue;
    }

    if (arg === "--screen" || arg.startsWith("--screen=")) {
      const { value, nextIndex } = readFlagValue(argv, index, "--screen");
      options.screenIndex = parsePositiveInteger(value, "--screen");
      index = nextIndex;
      continue;
    }

    if (arg === "--port" || arg.startsWith("--port=")) {
      const { value, nextIndex } = readFlagValue(argv, index, "--port");
      options.port = parsePositiveInteger(value, "--port");
      index = nextIndex;
      continue;
    }

    if (arg === "--max-screens" || arg.startsWith("--max-screens=")) {
      const { value, nextIndex } = readFlagValue(argv, index, "--max-screens");
      options.maxScreens = parsePositiveInteger(value, "--max-screens");
      index = nextIndex;
      continue;
    }

    if (arg === "--handoff" || arg.startsWith("--handoff=")) {
      const { value, nextIndex } = readFlagValue(argv, index, "--handoff");
      options.handoff = parseHandoff(value);
      index = nextIndex;
      continue;
    }

    if (arg === "--profile" || arg.startsWith("--profile=")) {
      const { value, nextIndex } = readFlagValue(argv, index, "--profile");
      options.profilePath = value.trim() || null;
      index = nextIndex;
      continue;
    }

    if (!arg.startsWith("--")) {
      if (options.command === "listen" || options.command === "ui" || options.command === "clipboard") {
        throw new Error(`Command mode ${options.command} does not accept positional arguments: ${arg}`);
      }

      options.command = "image";
      options.imagePaths.push(arg);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.command === "image" && options.imagePaths.length === 0 && !options.help) {
    throw new Error("image mode requires at least one screenshot path.");
  }

  if (options.command === "watch" && options.uiEnabled && !autoSolveExplicit) {
    options.autoSolve = false;
  }

  return options;
}

export function helpText(): string {
  return [
    "Interview Coder",
    "",
    "Usage:",
    "  npm run watch -- [options] [screenshot1 screenshot2 ...]",
    "",
    "Options:",
    "  [screenshot files]        Add one or more local screenshots as input",
    "  --language <name>         Solution language. Default: python",
    "  --interval <seconds>      Watch interval. Default: 8",
    "  --region x,y,w,h          Capture only a screen rectangle",
    "  --screen <number>         Use a detected screen without prompting",
    "  --ui                      Start the coding-solution UI (works with watch and input modes)",
    "  --once                    Capture one screen and stop",
    "  --listen                  Listen mode for spoken prompts",
    "  --clipboard               Capture from clipboard instead of selecting a file",
    "  --port <number>           UI/listen port. Default: 4378",
    "  --auto                    Enable automatic answering when context is complete",
    "  --manual                  Disable automatic answering (watch mode defaults to auto unless --ui is used)",
    "  --max-screens <count>     Stop after this many observations",
    "  --handoff <mode>          Answer handoff: codex, openclaw, or clipboard. Default: codex",
    "  --profile <file>          Candidate context for tailored communication style and examples",
    "  --out <dir>               Output directory. Default: runs",
    "  --keep-all-screens        Keep screenshots even when no question is visible",
    "  --help                    Show this help",
    "",
    "Controls (watch mode):",
    "  a or s                    Prepare an answer once context is complete",
    "  r                         Reset captured question context",
    "  q                         Quit",
    "",
    "Listen mode:",
    "  Open the printed local URL, start browser speech recognition, then click Answer when ready.",
  ].join("\n");
}
