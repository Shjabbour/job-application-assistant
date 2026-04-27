import type { ObservationResult, QuestionState } from "./types.js";

function cleanVisibleText(value: string | null | undefined): string | null {
  const trimmed = value
    ?.replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return trimmed ? trimmed : null;
}

function extractTitle(text: string | null): string | null {
  if (!text) {
    return null;
  }

  const titleLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^\d+\.\s+\S/.test(line));

  return titleLine ?? null;
}

export function observeScreenshotLocally(
  state: QuestionState,
  screenshotPath: string,
  visibleText?: string | null,
): ObservationResult {
  const screenshotNumber = (state.screenshotPaths?.length ?? 0) + 1;
  const capturedText = cleanVisibleText(visibleText);
  const prompt = capturedText ?? state.question.prompt ?? "See the attached screenshot for the full prompt.";
  const title = state.question.title ?? extractTitle(capturedText) ?? "Captured Screenshot";

  return {
    screenHasQuestion: true,
    visibleQuestionText: capturedText ?? `Captured screenshot: ${screenshotPath}`,
    question: {
      kind: state.question.kind ?? "coding",
      title,
      difficulty: state.question.difficulty,
      prompt,
      inputOutput: state.question.inputOutput,
      examples: state.question.examples,
      constraints: state.question.constraints,
      functionSignature: state.question.functionSignature,
      starterCode: state.question.starterCode,
      visibleCode: state.question.visibleCode,
      followUp: state.question.followUp,
      interviewerContext: state.question.interviewerContext,
      notes: capturedText
        ? [`Screenshot ${screenshotNumber} OCR text was captured and the image is attached for answer generation.`]
        : [`Screenshot ${screenshotNumber} is attached for answer generation.`],
    },
    newInformation: capturedText
      ? [`Screenshot ${screenshotNumber} captured with OCR text.`]
      : [`Screenshot ${screenshotNumber} captured.`],
    missingInformation: [],
    completenessScore: 1,
    readyToAnswer: true,
    userInstruction: "Click Answer.",
  };
}
