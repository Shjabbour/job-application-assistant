import type { QuestionState } from "./types.js";

function stateForPrompt(state: QuestionState): string {
  return JSON.stringify(
    {
      question: state.question,
      missingInformation: state.missingInformation,
      completenessScore: state.completenessScore,
      readyToAnswer: state.readyToAnswer,
      observations: state.observations,
    },
    null,
    2,
  );
}

export function buildObservationPrompt(state: QuestionState): string {
  return [
    "You are helping read a coding interview question from a screenshot.",
    "The user may scroll manually. Your job is to accumulate only information visible in screenshots and decide whether enough context has been captured to build a robust interview-ready solution.",
    "",
    "Allowed use boundary:",
    "- Treat this as a practice or explicitly authorized coaching tool.",
    "- Do not create covert-exam behavior or instructions for hiding assistance.",
    "",
    "Extraction rules:",
    "- Use the screenshot and the previous captured state only.",
    "- Do not fill in missing question text from memory, even if a coding title looks familiar.",
    "- If a required section is not visible yet, say exactly what the user should screenshot or scroll to next.",
    "- For coding questions, require the statement, examples or input/output behavior, constraints when visible, and signature/starter code when relevant.",
    "- For debugging or implementation-style prompts, capture the failing input, expected behavior, key functions, and environment details when visible.",
    "- Return JSON only. Do not wrap it in markdown.",
    "",
    "Classify question.kind as one of: coding, debugging, technical, other.",
    "",
    "Previous captured state:",
    stateForPrompt(state),
    "",
    "Return this exact JSON shape:",
    JSON.stringify(
      {
        screenHasQuestion: true,
        visibleQuestionText: "OCR-like transcription or concise summary of visible question text",
        question: {
          kind: "coding",
          title: "string or null",
          difficulty: "Easy, Medium, Hard, or null",
          prompt: "cumulative prompt or statement text",
          inputOutput: "cumulative input/output description or null",
          examples: ["cumulative examples"],
          constraints: ["cumulative constraints or requirements"],
          functionSignature: "starter function signature or null",
          starterCode: "starter code if visible or null",
          visibleCode: "any relevant code shown on screen or null",
          followUp: "follow-up text if visible or null",
          interviewerContext: "role/company context if visible or null",
          notes: ["other useful captured details"],
        },
        newInformation: ["new details visible in this screenshot"],
        missingInformation: ["specific missing sections, or empty when complete"],
        completenessScore: 0.0,
        readyToAnswer: false,
        userInstruction: "short instruction for the user, usually what to screenshot or scroll to next",
      },
      null,
      2,
    ),
  ].join("\n");
}

export function buildAnswerPrompt(
  state: QuestionState,
  language: string,
  candidateContext: string | null,
  screenshotPaths: string[] = [],
): string {
  const screenshotSection = screenshotPaths.length
    ? [
        "Attached screenshot files:",
        ...screenshotPaths.map((item) => `- ${item}`),
        "",
        "Read the attached screenshot image(s) as the source of truth. OCR-derived prompt text may be absent or noisy.",
      ].join("\n")
    : "None attached.";

  return [
    "Prepare a concise interviewer-ready solution for the captured coding prompt.",
    "",
    "Use only the captured question context below, plus the optional candidate context if provided.",
    "If critical details are missing, start with 'Cannot answer yet' and list the missing details instead of guessing.",
    "For coding answers, solve in the requested language and match the captured function signature or starter code when present.",
    "Prioritize correctness, readability, and practical explanation for whiteboard/live-coding interviews.",
    "",
    "Return clean Markdown only.",
    "Make it scannable while giving enough spoken wording:",
    "- Use short section headings with ##.",
    "- Use compact bullets and short paragraphs, but do not make the walkthroughs too terse.",
    "- Include concrete interview phrasing: write words the candidate can say out loud, not only abstract notes.",
    "- Put code in a fenced code block with the requested language.",
    "- Avoid dense walls of text and avoid tables unless they are clearly useful.",
    "- Start with ## Say This First as a short spoken opening.",
    "- Include ## Hints immediately after ## Say This First. Make hints progressive: first nudge, useful pattern, edge cases, then final direction.",
    "- Include ## Naive First Try immediately after ## Hints. This is the first answer tab: give the simple answer many candidates reach for, with enough context to walk through it.",
    "- In ## Naive First Try, include ### What to Say, ### Walkthrough, and ### Where It Breaks. Keep it plausible and useful, not intentionally broken.",
    "- Include ## Robust Walkthrough immediately after ## Naive First Try. This is the second answer tab: give the correct approach with words to say before showing code.",
    "- In ## Robust Walkthrough, include ### What to Say, ### Walkthrough, and ### Key Details. Explain the reasoning step by step before the Code section.",
    "- If the prompt looks like a trick question or has a hidden catch, do not jump straight to the final correct answer in ## Say This First.",
    "- For trick questions, make ## Say This First a careful surface-level read, use ## Hints to walk toward the catch, use ## Naive First Try to show the tempting answer, then reveal the catch in ## Robust Walkthrough.",
    "- Include ## Follow-Ups with 2-4 likely follow-up points.",
    "- Include ## Watch-Outs for assumptions, edge cases, or claims the candidate should avoid.",
    "",
    "Use these section rules by question kind:",
    "- coding: Say This First, Hints, Naive First Try, Robust Walkthrough, Clarify, Approach, Code, Complexity, Quick Tests, Follow-Ups, Watch-Outs.",
    "- debugging: Say This First, Hints, Naive First Try, Robust Walkthrough, First Checks, Likely Cause, Fix, Verification, Follow-Ups, Watch-Outs.",
    "- technical/other: Say This First, Hints, Naive First Try, Robust Walkthrough, Clarify, Approach, Code, Complexity, Follow-Ups, Watch-Outs.",
    "",
    `Requested coding language: ${language}`,
    "",
    "Candidate context:",
    candidateContext?.trim() || "None provided.",
    "",
    "Screenshots:",
    screenshotSection,
    "",
    "Captured question context:",
    stateForPrompt(state),
  ].join("\n");
}
