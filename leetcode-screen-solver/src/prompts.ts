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

const PLACEHOLDER_PROMPTS = new Set([
  "see the attached screenshot for the full prompt.",
]);

export function hasUsableQuestionContext(state: QuestionState): boolean {
  const prompt = state.question.prompt?.trim() ?? "";
  const normalizedPrompt = prompt.toLowerCase();
  const hasPromptText = prompt.length >= 40 && !PLACEHOLDER_PROMPTS.has(normalizedPrompt);
  return (
    hasPromptText ||
    Boolean(state.question.title?.trim()) ||
    Boolean(state.question.functionSignature?.trim()) ||
    Boolean(state.question.starterCode?.trim()) ||
    Boolean(state.question.visibleCode?.trim()) ||
    state.question.examples.length > 0 ||
    state.question.constraints.length > 0 ||
    (state.screenshotPaths?.length ?? 0) > 0
  );
}

export function isMissingDetailsAnswer(answer: string): boolean {
  return /^\s*(?:#+\s*)?Cannot answer yet\b/i.test(answer) || /\bMissing Details\b/i.test(answer);
}

export function buildAnswerRetryPrompt(answerPrompt: string): string {
  return [
    answerPrompt,
    "",
    "Important retry instruction:",
    "Your previous response refused with missing-details text. Do not return 'Cannot answer yet' for this retry.",
    "If the screenshots or captured text contain any recognizable coding problem, solve it from that evidence now.",
    "Use reasonable assumptions for minor missing details and state those assumptions briefly.",
    "Return the candidate-facing Markdown answer only.",
  ].join("\n");
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
    "If screenshot files are attached, inspect them directly and use the OCR/captured text only as supporting context.",
    "Do not ask for more information when an attached screenshot or OCR text contains a recognizable coding problem, visible examples, or starter code. Answer from the visible material and state any minor assumptions briefly.",
    "Only start with 'Cannot answer yet' when there is no usable problem statement in either the attached screenshots or the captured text.",
    "For coding answers, solve in the requested language and match the captured function signature or starter code when present.",
    "Prioritize correctness, readability, and practical explanation for whiteboard/live-coding interviews.",
    "",
    "Return clean Markdown only.",
    "Make it scannable while clearly separating what to say from reference notes:",
    "- Use short section headings with ##.",
    "- Use compact bullets and short paragraphs, but give enough wording for the candidate to speak naturally.",
    "- Prefer direct interview phrasing over abstract notes.",
    "- Clearly mark spoken content with ### Say Out Loud.",
    "- Clearly mark typing guidance with ### While Typing.",
    "- Clearly mark private/reference material with ### Keep In Mind or ## If Asked.",
    "- Only ### Say Out Loud content is meant to be said directly. Keep other sections short and clearly supportive.",
    "- Put code in a fenced code block with the requested language.",
    "- In every code block, including first-try code, include visible comments using the requested language's normal comment syntax.",
    "- Use more comments than normal live code: the candidate will be looking at the code while speaking, so comments should create a natural talk track.",
    "- Make code comments spoken-friendly: each comment should explain the next step, invariant, edge case, or reason for a data structure in words the candidate can say while typing.",
    "- For simple LeetCode classes/functions, comment setup, each public method, key conditional branches, duplicate/negative/empty edge cases, and the final return.",
    "- Avoid useless restatements like 'increment i'. Comments should explain why that line or block matters.",
    "- Avoid dense walls of text and avoid tables unless they are clearly useful.",
    "- Start with ## Say This First as a practical opening script before solving.",
    "- In ## Say This First, include ### Restate, ### Ask, and ### Transition. Restate the task, ask 2-3 useful clarifying questions or confirm assumptions, then give one sentence that moves into the approach.",
    "- The opening should help the candidate talk through the problem before coding, not reveal the whole final answer immediately.",
    "- Include ## Hints immediately after ## Say This First. Make hints progressive: first nudge, useful pattern, edge cases, then final direction.",
    "- Include ## Naive First Try immediately after ## Hints. This is the first answer tab: give the complete simple solution many candidates reach for.",
    "- In ## Naive First Try, include ### Say Out Loud, ### First Try Code, ### First Try Complexity, and ### Why This May Not Be Enough.",
    "- ### First Try Code must include a complete implementation when the simple approach is logically valid, even if it is not optimal or misses a follow-up requirement.",
    "- ### First Try Code should look like something the candidate can type while thinking: clear names, straightforward control flow, and enough comments to narrate the code.",
    "- If the first try is actually wrong, include the smallest useful code or pseudocode that shows the tempting mistake, then clearly explain the failure.",
    "- Include ## Robust Answer immediately after ## Naive First Try. This is the second answer tab: give the correct approach with words to say before showing code.",
    "- In ## Robust Answer, include ### Say Out Loud, ### While Typing, and ### Keep In Mind. Do not add separate top-level Clarify or Approach sections.",
    "- ### While Typing should mention what each cluster of comments in the final code is helping the candidate say.",
    "- If the prompt looks like a trick question or has a hidden catch, do not jump straight to the final correct answer in ## Say This First.",
    "- For trick questions, make ## Say This First a careful surface-level read, use ## Hints to walk toward the catch, use ## Naive First Try to show the tempting answer, then reveal the catch in ## Robust Answer.",
    "- Include ## Complexity after ## Code. Keep it short and spoken-ready because interviewers often ask for it.",
    "- In ## Complexity, include ### Say Out Loud and optionally one short ### Why line.",
    "- Include ## If Asked near the end. Put quick tests, follow-ups, watch-outs, and extra edge cases there instead of as separate top-level sections.",
    "",
    "Use these section rules by question kind:",
    "- coding: Say This First, Hints, Naive First Try, Robust Answer, Code, Complexity, If Asked.",
    "- debugging: Say This First, Hints, Naive First Try, Robust Answer, Fix, Complexity, If Asked.",
    "- technical/other: Say This First, Hints, Naive First Try, Robust Answer, Complexity, If Asked.",
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
