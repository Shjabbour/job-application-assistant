import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AnswerHandoff, QuestionState } from "../types.js";

export interface UiServerOptions {
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

export interface RunSummary {
  id: string;
  updatedAt: string | null;
  title: string;
  kind: string;
  completenessScore: number;
  readyToAnswer: boolean;
  hasAnswer: boolean;
  hasHints: boolean;
}

export interface RunDetail extends RunSummary {
  state: QuestionState | null;
  answerMarkdown: string;
  hintsMarkdown: string;
  turns: RunTurnDetail[];
  latestScreenshotUrl: string | null;
  screenshotUrls: string[];
  screenshots: ScreenshotDetail[];
  screenshotCount: number;
}

export interface ScreenshotDetail {
  index: number;
  url: string;
  status: "pending" | "sent";
  canDelete: boolean;
}

export interface RunTurnDetail {
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

export interface RunTurnArtifact extends RunTurnDetail {
  state: QuestionState | null;
}

export interface MonitorStatus {
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

export interface MonitorProcess {
  child: ChildProcessWithoutNullStreams;
  screenId: number;
  activeRunId: string | null;
  startedAt: string;
  stoppedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  log: string[];
}

export interface ScreenshotRecord {
  path: string;
  updatedAt: number;
  status: "pending" | "sent";
}
