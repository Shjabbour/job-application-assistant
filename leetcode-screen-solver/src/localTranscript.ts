import type { ObservationResult, QuestionKind, QuestionState } from "./types.js";

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function cleanTitle(value: string): string {
  return normalize(value)
    .replace(/^(\d+\s+)+/, "")
    .replace(/\b(leetcode|ask gemini|description|editorial|solutions|submissions|code|premium)\b.*$/i, "")
    .replace(/[|:;,.\-]+$/g, "")
    .trim();
}

function extractLikelyTitle(text: string): string | null {
  const slugMatch = text.match(/problems[\/\\]([a-z0-9-]{3,80})[\/\\](?:description|editorial|solutions|submissions)/i);
  if (slugMatch?.[1]) {
    const fromSlug = cleanTitle(titleFromSlug(slugMatch[1]));
    if (fromSlug) {
      return fromSlug;
    }
  }

  const numberedMatch = text.match(/\b\d{1,4}\.\s*([A-Za-z][A-Za-z0-9'()\-]*(?:\s+[A-Za-z][A-Za-z0-9'()\-]*){0,8})/);
  if (numberedMatch?.[1]) {
    const fromNumbered = cleanTitle(numberedMatch[1]);
    if (fromNumbered) {
      return fromNumbered;
    }
  }

  const leetcodeMatch = text.match(/\b([A-Za-z][A-Za-z0-9'()\-]*(?:\s+[A-Za-z][A-Za-z0-9'()\-]*){0,8})\s*-\s*LeetCode\b/i);
  if (leetcodeMatch?.[1]) {
    const fromLeetcode = cleanTitle(leetcodeMatch[1]);
    if (fromLeetcode) {
      return fromLeetcode;
    }
  }

  return null;
}

function compactTitle(value: string): string {
  const cleaned = normalize(value)
    .replace(/^(okay|so|um|uh|please|can you|could you|would you)\s+/i, "")
    .replace(/[?.!,;:]+$/g, "");
  return cleaned.length <= 70 ? cleaned : `${cleaned.slice(0, 67).trim()}...`;
}

function classify(text: string): QuestionKind {
  const value = text.toLowerCase();

  if (
    /\b(leetcode|algorithm|data structure|array|string|linked list|tree|graph|dynamic programming|binary search|hash map|stack|queue|heap|complexity|big o|write (a )?(function|method|program)|implement|solve)\b/.test(
      value,
    )
  ) {
    return "coding";
  }

  if (/\b(tell me about a time|behavioral|conflict|leadership|failure|mistake|challenge|weakness|strength|proud|difficult teammate)\b/.test(value)) {
    return "behavioral";
  }

  if (/\b(system design|design (a|an|the)|architecture|scale|scalable|distributed|cache|database|load balancer|throughput|latency)\b/.test(value)) {
    return "system-design";
  }

  if (/\b(debug|bug|error|exception|failing|broken|fix|root cause|stack trace)\b/.test(value)) {
    return "debugging";
  }

  if (/\b(product|user|customers|metric|prioritize|roadmap|feature|experiment|a\/b test)\b/.test(value)) {
    return "product";
  }

  if (/\b(explain|what is|what are|how does|why does|difference between|tradeoff|database|api|http|react|node|python|typescript|sql|cloud)\b/.test(value)) {
    return "technical";
  }

  return "other";
}

function looksLikeQuestionText(text: string): boolean {
  const normalized = text.toLowerCase();

  if (normalized.length < 30) {
    return false;
  }

  const hasQuestionLexicon =
    /\b(given|input|output|example|examples|constraint|constraints|leetcode|coding|implement|write|find|count|compute|determine|max(?:imum)?|min(?:imum)?|longest|shortest|class\s+solution|function|method|class|def)\b/i.test(
      text,
    ) || /\b(easy|medium|hard)\b/i.test(normalized);

  const hasProgrammingShape =
    /\b(function|class|def|public|private|const|let|var|return|for|while|if|loop)\b/i.test(normalized) ||
    /\{|\}|\(|\)|\[|\]|=>|==|!=|<=|>=|=/.test(text) ||
    /\b(array|string|integer|number|list|matrix|graph|tree|node|substring|subsequence|window|sum)\b/i.test(normalized);

  const hasQuestionCue =
    /\b(tell me|describe|explain|walk me through|how would|how do|what is|what are|why|can you|could you|would you|design|implement|solve|debug|write|return)\b/i.test(
      text,
    );

  const hasSentences = /\b\w+\b/.test(text) && normalized.split(/\s+/).length >= 10;

  return hasQuestionCue || (hasQuestionLexicon && hasProgrammingShape) || hasSentences;
}

function hasQuestionSignal(text: string): boolean {
  if (
    /[?]|\b(tell me|describe|explain|walk me through|how would|how do|what is|what are|why|can you|could you|would you|design|implement|solve|debug|write|given|input|output|example|constraint|return|class\s+solution|function|method)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  if (
    /\b(leetcode|easy|medium|hard|examples?|constraints?|follow[-\s]?up|acceptance|submissions?|topics?|companies)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  return (
    (/\b(given|find|count|compute|determine|max(?:imum)?|min(?:imum)?|longest|shortest)\b/i.test(text) &&
      /\b(array|string|integer|number|list|matrix|graph|tree|node|substring|subsequence|window|sum)\b/i.test(text)) ||
    looksLikeQuestionText(text)
  );
}

function isSelfCaptureNoise(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized) {
    return false;
  }
  const digitsOnly = normalized.replace(/\D+/g, "");
  const hasLocalhostArtifact = digitsOnly.includes("1270014386") || digitsOnly.includes("127001");

  const cues = [
    /\binterview\s*coder\b/i,
    /\b127\.0\.0\.1(?::\d+)?\b/i,
    /\bwatch\s*controls?\b/i,
    /\bshortcuts?\s+are\s+active\b/i,
    /\bnothing\s+generated\s+yet\b/i,
    /\bnew\s*question\b/i,
    /\bmonitoring\s*screen\b/i,
    /\bcapturing\b.*\bcaptured\b/i,
    /\bready\b.*\bcaptured\b/i,
    /\ba\s*\/\s*s\s*answer\b/i,
    /\br\s+reset\b/i,
    /\bq\s+quit\b/i,
    /\banswer\s+question\b/i,
    /\bstop\s+refresh\b/i,
    /\blive\b.*\bmonitoring\b/i,
    /\bscreen\s+\d+\s*\|\s*\d+x\d+\b/i,
  ];

  let score = 0;
  for (const cue of cues) {
    if (cue.test(text)) {
      score += 1;
    }
  }

  const hasStrongIdentity =
    /\binterview\s*coder\b/i.test(text) ||
    /\b127\.0\.0\.1(?::\d+)?\b/i.test(text) ||
    hasLocalhostArtifact;
  return (hasStrongIdentity && score >= 2) || score >= 4;
}

function missingDetails(kind: QuestionKind, prompt: string): string[] {
  const normalized = prompt.toLowerCase();
  if (!prompt || prompt.split(/\s+/).length < 5) {
    return ["clear interviewer question"];
  }

  if (
    kind === "coding" &&
    /\b(implement|design|build|create|write)\b/.test(normalized) &&
    /\b(class|function|method|stack|queue|cache|tree|graph|array|string|list|matrix|node|object)\b/.test(normalized)
  ) {
    return [];
  }

  if (
    kind === "coding" &&
    /\b(push|pop|top|getmin|insert|remove|delete|search|traverse)\b/.test(normalized)
  ) {
    return [];
  }

  if (
    kind === "coding" &&
    /\b(that|this|it|thing|problem)\b/i.test(prompt) &&
    !/\b(array|string|tree)\b/i.test(prompt)
  ) {
    return ["specific coding task details"];
  }

  if (kind === "coding" && /\binput|output|return|given|array|string|tree|graph|number|list|matrix|object|function|method\b/.test(normalized)) {
    return [];
  }

  if (kind === "coding" && prompt.split(/\s+/).length < 10) {
    return ["input/output behavior"];
  }

  return [];
}

function appendPrompt(previous: string | null, transcript: string): string {
  const cleanPrevious = normalize(previous ?? "");
  const cleanTranscript = normalize(transcript);
  if (!cleanPrevious) {
    return cleanTranscript;
  }
  if (cleanPrevious.toLowerCase().includes(cleanTranscript.toLowerCase())) {
    return cleanPrevious;
  }
  return `${cleanPrevious}\n\n${cleanTranscript}`;
}

export function observeTranscriptLocally(state: QuestionState, transcript: string): ObservationResult {
  const cleanTranscript = normalize(transcript);
  if (isSelfCaptureNoise(cleanTranscript)) {
    return {
      screenHasQuestion: false,
      visibleQuestionText: cleanTranscript,
      question: state.question,
      newInformation: [],
      missingInformation: ["selected screen is showing Interview Coder UI"],
      completenessScore: state.completenessScore,
      readyToAnswer: state.readyToAnswer,
      userInstruction: "You're capturing Interview Coder itself. Put LeetCode/interviewer window on the selected screen, then click New Question.",
    };
  }

  const cumulativePrompt = appendPrompt(state.question.prompt, cleanTranscript);
  const kind = state.question.kind ?? classify(cumulativePrompt);
  const extractedTitle = extractLikelyTitle(`${cleanTranscript} ${cumulativePrompt}`) ?? null;
  const missingInformation = missingDetails(kind, cumulativePrompt);
  const hasSignal = hasQuestionSignal(cleanTranscript) || Boolean(state.question.prompt);
  const readyToAnswer = kind !== "other" && hasSignal && missingInformation.length === 0;

  return {
    screenHasQuestion: hasSignal,
    visibleQuestionText: cleanTranscript,
    question: {
      kind,
      title: extractedTitle ?? state.question.title ?? compactTitle(cleanTranscript || cumulativePrompt),
      difficulty: state.question.difficulty,
      prompt: cumulativePrompt,
      inputOutput: state.question.inputOutput,
      examples: state.question.examples,
      constraints: state.question.constraints,
      functionSignature: state.question.functionSignature,
      starterCode: state.question.starterCode,
      visibleCode: state.question.visibleCode,
      followUp: state.question.prompt ? cleanTranscript : state.question.followUp,
      interviewerContext: state.question.interviewerContext,
      notes: state.question.notes,
    },
    newInformation: cleanTranscript ? [cleanTranscript] : [],
    missingInformation,
    completenessScore: readyToAnswer ? 0.95 : hasSignal ? 0.55 : 0,
    readyToAnswer,
    userInstruction: readyToAnswer ? "Click Answer." : "Keep listening or paste the full question.",
  };
}
