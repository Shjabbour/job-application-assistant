import type { CapturedQuestion, ObservationResult, QuestionKind, QuestionState } from "./types.js";

const QUESTION_KINDS: QuestionKind[] = [
  "coding",
  "behavioral",
  "system-design",
  "debugging",
  "technical",
  "product",
  "other",
];

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function cleanQuestionKind(value: unknown): QuestionKind | null {
  const cleaned = cleanString(value);
  if (!cleaned) {
    return null;
  }

  return QUESTION_KINDS.includes(cleaned as QuestionKind) ? (cleaned as QuestionKind) : "other";
}

function cleanArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function cleanNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function cleanBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

export function emptyQuestion(): CapturedQuestion {
  return {
    kind: null,
    title: null,
    difficulty: null,
    prompt: null,
    inputOutput: null,
    examples: [],
    constraints: [],
    functionSignature: null,
    starterCode: null,
    visibleCode: null,
    followUp: null,
    interviewerContext: null,
    notes: [],
  };
}

export function createEmptyState(): QuestionState {
  return {
    question: emptyQuestion(),
    missingInformation: [],
    completenessScore: 0,
    readyToAnswer: false,
    observations: 0,
    screenshotPaths: [],
    transcriptPaths: [],
    transcriptText: null,
    lastUpdatedAt: null,
  };
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return extractJsonObject(fenced[1]);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error("Model did not return a JSON object.");
}

export function parseObservation(text: string): ObservationResult {
  const raw = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  const rawQuestion =
    typeof raw.question === "object" && raw.question !== null ? (raw.question as Record<string, unknown>) : {};

  return {
    screenHasQuestion: cleanBoolean(raw.screenHasQuestion),
    visibleQuestionText: cleanString(raw.visibleQuestionText) ?? "",
    question: {
      kind: cleanQuestionKind(rawQuestion.kind),
      title: cleanString(rawQuestion.title),
      difficulty: cleanString(rawQuestion.difficulty),
      prompt: cleanString(rawQuestion.prompt),
      inputOutput: cleanString(rawQuestion.inputOutput),
      examples: cleanArray(rawQuestion.examples),
      constraints: cleanArray(rawQuestion.constraints),
      functionSignature: cleanString(rawQuestion.functionSignature),
      starterCode: cleanString(rawQuestion.starterCode),
      visibleCode: cleanString(rawQuestion.visibleCode),
      followUp: cleanString(rawQuestion.followUp),
      interviewerContext: cleanString(rawQuestion.interviewerContext),
      notes: cleanArray(rawQuestion.notes),
    },
    newInformation: cleanArray(raw.newInformation),
    missingInformation: cleanArray(raw.missingInformation),
    completenessScore: cleanNumber(raw.completenessScore),
    readyToAnswer: cleanBoolean(raw.readyToAnswer),
    userInstruction: cleanString(raw.userInstruction) ?? "",
  };
}

function normalizeIdentity(value: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/^\d+\.\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isNewQuestion(previous: QuestionState, observation: ObservationResult): boolean {
  const previousTitle = normalizeIdentity(previous.question.title);
  const nextTitle = normalizeIdentity(observation.question.title);
  return previousTitle.length > 0 && nextTitle.length > 0 && previousTitle !== nextTitle;
}

function mergeString(previous: string | null, next: string | null): string | null {
  if (!next) {
    return previous;
  }

  if (!previous) {
    return next;
  }

  return next.length >= previous.length ? next : previous;
}

function mergeArray(previous: string[], next: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of [...previous, ...next]) {
    const normalized = item.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(item);
  }

  return result;
}

function appendTranscript(previous: string | null | undefined, next: string | null | undefined): string | null {
  const cleanNext = cleanString(next);
  if (!cleanNext) {
    return previous ?? null;
  }

  const cleanPrevious = cleanString(previous);
  if (!cleanPrevious) {
    return cleanNext;
  }

  return `${cleanPrevious}\n\n${cleanNext}`;
}

export interface ObservationSource {
  kind: "screenshot" | "transcript";
  path: string;
  transcriptText?: string | null;
  storeScreenshot?: boolean;
}

export function mergeObservation(
  state: QuestionState,
  observation: ObservationResult,
  source: ObservationSource,
): QuestionState {
  const question = state.question;
  const screenshotPaths = state.screenshotPaths ?? [];
  const transcriptPaths = state.transcriptPaths ?? [];

  return {
    question: {
      kind: observation.question.kind ?? question.kind,
      title: mergeString(question.title, observation.question.title),
      difficulty: mergeString(question.difficulty, observation.question.difficulty),
      prompt: mergeString(question.prompt, observation.question.prompt),
      inputOutput: mergeString(question.inputOutput, observation.question.inputOutput),
      examples: mergeArray(question.examples, observation.question.examples),
      constraints: mergeArray(question.constraints, observation.question.constraints),
      functionSignature: mergeString(question.functionSignature, observation.question.functionSignature),
      starterCode: mergeString(question.starterCode, observation.question.starterCode),
      visibleCode: mergeString(question.visibleCode, observation.question.visibleCode),
      followUp: mergeString(question.followUp, observation.question.followUp),
      interviewerContext: mergeString(question.interviewerContext, observation.question.interviewerContext),
      notes: mergeArray(question.notes, observation.question.notes),
    },
    missingInformation: observation.missingInformation,
    completenessScore: observation.completenessScore,
    readyToAnswer: observation.readyToAnswer,
    observations: state.observations + 1,
    // Keep a screenshot path only when explicitly requested. This avoids storing
    // deleted temp frames when the capture is still uncertain.
    screenshotPaths:
      source.kind === "screenshot" && source.storeScreenshot !== false
        ? [...screenshotPaths, source.path]
        : screenshotPaths,
    transcriptPaths: source.kind === "transcript" ? [...transcriptPaths, source.path] : transcriptPaths,
    transcriptText:
      source.kind === "transcript"
        ? appendTranscript(state.transcriptText, source.transcriptText)
        : state.transcriptText ?? null,
    lastUpdatedAt: new Date().toISOString(),
  };
}

export function statusLine(state: QuestionState): string {
  const kind = state.question.kind ?? "question";
  const title = state.question.title ?? state.question.prompt?.slice(0, 80) ?? "Untitled question";
  const difficulty = state.question.difficulty ? ` (${state.question.difficulty})` : "";
  const percent = Math.round(state.completenessScore * 100);
  return `${kind}: ${title}${difficulty} - ${percent}% captured`;
}
