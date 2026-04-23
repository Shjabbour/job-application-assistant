export type Command = "watch" | "once" | "image" | "clipboard" | "listen" | "ui";

export type AnswerHandoff = "codex" | "openclaw" | "clipboard";

export type QuestionKind =
  | "coding"
  | "behavioral"
  | "system-design"
  | "debugging"
  | "technical"
  | "product"
  | "other";

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo extends ScreenRegion {
  id: number;
  name: string;
  primary: boolean;
  relativePosition: string;
  shortLabel: string;
  label: string;
}

export interface CliOptions {
  command: Command;
  intervalMs: number;
  language: string;
  outDir: string;
  region: ScreenRegion | null;
  screenIndex: number | null;
  uiEnabled: boolean;
  port: number;
  autoSolve: boolean;
  keepAllScreens: boolean;
  maxScreens: number | null;
  handoff: AnswerHandoff;
  imagePaths: string[];
  profilePath: string | null;
  help: boolean;
}

export interface CapturedQuestion {
  kind: QuestionKind | null;
  title: string | null;
  difficulty: string | null;
  prompt: string | null;
  inputOutput: string | null;
  examples: string[];
  constraints: string[];
  functionSignature: string | null;
  starterCode: string | null;
  visibleCode: string | null;
  followUp: string | null;
  interviewerContext: string | null;
  notes: string[];
}

export interface ObservationResult {
  screenHasQuestion: boolean;
  visibleQuestionText: string;
  question: CapturedQuestion;
  newInformation: string[];
  missingInformation: string[];
  completenessScore: number;
  readyToAnswer: boolean;
  userInstruction: string;
}

export interface QuestionState {
  question: CapturedQuestion;
  missingInformation: string[];
  completenessScore: number;
  readyToAnswer: boolean;
  observations: number;
  screenshotPaths: string[];
  transcriptPaths: string[];
  transcriptText: string | null;
  lastUpdatedAt: string | null;
}
