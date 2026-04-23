import type { ObservationResult, QuestionState } from "./types.js";

export function observeScreenshotLocally(state: QuestionState, screenshotPath: string): ObservationResult {
  const screenshotNumber = (state.screenshotPaths?.length ?? 0) + 1;
  const prompt = state.question.prompt ?? "See the attached screenshot for the full prompt.";

  return {
    screenHasQuestion: true,
    visibleQuestionText: `Captured screenshot: ${screenshotPath}`,
    question: {
      kind: state.question.kind ?? "coding",
      title: state.question.title ?? "Captured Screenshot",
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
      notes: [`Screenshot ${screenshotNumber} is attached for answer generation.`],
    },
    newInformation: [`Screenshot ${screenshotNumber} captured.`],
    missingInformation: [],
    completenessScore: 1,
    readyToAnswer: true,
    userInstruction: "Click Answer.",
  };
}
