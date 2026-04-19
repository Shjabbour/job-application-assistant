import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Job, Profile } from "./types.js";

type ResumeContext = {
  text: string;
  source: string;
};

export type ResumeJobMatch = {
  job: Job;
  score: number;
  matchedRoles: string[];
  matchedSkills: string[];
  matchedTerms: string[];
  notes: string[];
  resumeSource: string;
};

const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "this",
  "to",
  "with",
  "you",
  "your",
]);

const defaultResumeTextPaths = [
  "resume-general.txt",
  "resume-backend.txt",
  "resume-fullstack.txt",
  "resume-fullstack-alt.txt",
];

function cleanRepeatedText(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  const half = Math.floor(trimmed.length / 2);
  if (trimmed.length > 8 && trimmed.length % 2 === 0) {
    const first = trimmed.slice(0, half).trim();
    const second = trimmed.slice(half).trim();
    if (first && second && first === second) {
      return first;
    }
  }
  return trimmed;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bc\+\+\b/g, " cpp ")
    .replace(/\bc#\b/g, " csharp ")
    .replace(/\bnode\.js\b/g, " nodejs ")
    .replace(/\bnext\.js\b/g, " nextjs ")
    .replace(/\bexpress\.js\b/g, " expressjs ")
    .replace(/\b\.net\b/g, " dotnet ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopWords.has(token));
}

function addWeightedTokens(vector: Map<string, number>, value: string, weight: number): void {
  for (const token of tokenize(value)) {
    vector.set(token, (vector.get(token) ?? 0) + weight);
  }
}

function buildResumeVector(profile: Profile, context: ResumeContext): Map<string, number> {
  const vector = new Map<string, number>();
  addWeightedTokens(vector, context.text, 1);
  addWeightedTokens(vector, profile.resumeSummary, 1.5);
  addWeightedTokens(vector, profile.skills.join(" "), 2.5);
  addWeightedTokens(vector, profile.targetRoles.join(" "), 3);
  return vector;
}

function buildJobVector(job: Job): Map<string, number> {
  const vector = new Map<string, number>();
  addWeightedTokens(vector, cleanRepeatedText(job.title), 3.5);
  addWeightedTokens(vector, cleanRepeatedText(job.company), 0.75);
  addWeightedTokens(vector, job.description, 1.5);
  addWeightedTokens(vector, job.notes, 0.5);
  return vector;
}

function cosineSimilarity(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (const value of left.values()) {
    leftMagnitude += value * value;
  }

  for (const value of right.values()) {
    rightMagnitude += value * value;
  }

  for (const [term, value] of left.entries()) {
    dot += value * (right.get(term) ?? 0);
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function uniquePhraseMatches(haystack: string, phrases: string[]): string[] {
  const normalizedHaystack = normalizeText(haystack);
  const matches = phrases.filter((phrase) => {
    const normalizedPhrase = normalizeText(phrase);
    return normalizedPhrase.length > 0 && normalizedHaystack.includes(normalizedPhrase);
  });

  return [...new Set(matches.map((match) => match.trim()).filter(Boolean))];
}

function collectMatchedTerms(
  resumeVector: Map<string, number>,
  jobVector: Map<string, number>,
): string[] {
  return [...resumeVector.keys()]
    .filter((term) => jobVector.has(term))
    .sort((left, right) => {
      const leftScore = Math.min(resumeVector.get(left) ?? 0, jobVector.get(left) ?? 0);
      const rightScore = Math.min(resumeVector.get(right) ?? 0, jobVector.get(right) ?? 0);
      return rightScore - leftScore;
    })
    .slice(0, 12);
}

function scoreJob(
  profile: Profile,
  context: ResumeContext,
  resumeVector: Map<string, number>,
  job: Job,
): ResumeJobMatch {
  const jobVector = buildJobVector(job);
  const role = cleanRepeatedText(job.title);
  const company = cleanRepeatedText(job.company) || "Unknown company";
  const jobText = `${role}\n${company}\n${job.description}\n${job.notes}`;
  const cosine = cosineSimilarity(resumeVector, jobVector);
  const matchedRoles = uniquePhraseMatches(jobText, profile.targetRoles);
  const matchedSkills = uniquePhraseMatches(jobText, profile.skills);
  const matchedTerms = collectMatchedTerms(resumeVector, jobVector);
  const notes: string[] = [];

  if (!job.description.trim()) {
    notes.push("Job description is empty, so the score leans on the title and notes only.");
  }

  if (!context.text.trim()) {
    notes.push(
      "No resume text was found. Add `profile.resumeTextPath`, set `JAA_RESUME_TEXT_PATH`, or populate your profile summary and skills.",
    );
  }

  if (matchedRoles.length === 0 && matchedSkills.length === 0 && matchedTerms.length === 0) {
    notes.push("No strong overlap surfaced yet between the job text and your saved resume/profile.");
  }

  const rawScore =
    cosine * 70 +
    matchedRoles.length * 8 +
    matchedSkills.length * 4 +
    matchedTerms.length * 1.5 +
    (job.description.trim() ? 8 : 0);
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  return {
    job,
    score,
    matchedRoles,
    matchedSkills,
    matchedTerms,
    notes,
    resumeSource: context.source,
  };
}

async function readTextFileIfPresent(candidatePath: string): Promise<string> {
  const resolved = path.isAbsolute(candidatePath)
    ? candidatePath
    : path.join(process.cwd(), candidatePath);

  try {
    const raw = await readFile(resolved, "utf8");
    return raw.trim();
  } catch {
    return "";
  }
}

export async function loadResumeContext(profile: Profile): Promise<ResumeContext> {
  const profileText = [profile.resumeSummary, profile.skills.join(" "), profile.targetRoles.join(" ")]
    .join("\n")
    .trim();
  const candidatePaths = [
    process.env.JAA_RESUME_TEXT_PATH,
    profile.resumeTextPath,
    ...defaultResumeTextPaths,
  ].filter((value): value is string => Boolean(value?.trim()));

  for (const candidatePath of [...new Set(candidatePaths)]) {
    const text = await readTextFileIfPresent(candidatePath);
    if (text) {
      return {
        text: [text, profileText].filter(Boolean).join("\n\n"),
        source: path.normalize(candidatePath),
      };
    }
  }

  return {
    text: profileText,
    source: profileText ? "profile summary/skills/target roles" : "not configured",
  };
}

export async function matchJobToResume(profile: Profile, job: Job): Promise<ResumeJobMatch> {
  const context = await loadResumeContext(profile);
  const resumeVector = buildResumeVector(profile, context);
  return scoreJob(profile, context, resumeVector, job);
}

export async function rankJobsByResume(
  profile: Profile,
  jobs: Job[],
  limit = 10,
): Promise<ResumeJobMatch[]> {
  const context = await loadResumeContext(profile);
  const resumeVector = buildResumeVector(profile, context);

  return jobs
    .map((job) => scoreJob(profile, context, resumeVector, job))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, limit));
}

function summarizeDescription(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) {
    return "No description saved yet. Capture the job page to improve scoring and tailoring.";
  }

  return trimmed.length > 320 ? `${trimmed.slice(0, 317)}...` : trimmed;
}

export async function formatJobMatchSummary(profile: Profile, job: Job): Promise<string> {
  const match = await matchJobToResume(profile, job);

  return [
    `Resume match score: ${match.score}/100`,
    `Role: ${cleanRepeatedText(job.title)} at ${cleanRepeatedText(job.company) || "Unknown company"}`,
    `Resume source: ${match.resumeSource}`,
    `Matched target roles: ${match.matchedRoles.join(", ") || "none"}`,
    `Matched skills: ${match.matchedSkills.join(", ") || "none"}`,
    `Matched terms: ${match.matchedTerms.join(", ") || "none"}`,
    ...match.notes.map((note) => `Note: ${note}`),
    `Summary: ${summarizeDescription(job.description)}`,
  ].join("\n");
}
