import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ApplicationAnswers = {
  text: Record<string, string>;
  select: Record<string, string>;
  radio: Record<string, string>;
  checkbox: Record<string, string>;
};

export const APPLICATION_ANSWER_BUCKETS = ["text", "select", "radio", "checkbox"] as const;

export type ApplicationAnswerBucket = (typeof APPLICATION_ANSWER_BUCKETS)[number];

const applicationAnswersPath = path.join(process.cwd(), "data", "application-answers.json");

const defaultApplicationAnswers: ApplicationAnswers = {
  text: {},
  select: {},
  radio: {},
  checkbox: {},
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const APPLICATION_ANSWER_ALIASES = [
  ["github", "github url", "github profile", "git link", "git profile"],
  ["linkedin", "linkedin url", "linkedin profile", "linkedln", "linkedln url", "linked in"],
  ["website", "portfolio", "personal website", "portfolio url", "website url"],
  ["how did you hear", "how did you hear about this job", "how did you hear about us", "source"],
  ["current company", "current or most recent company", "most recent company", "current employer", "most recent employer"],
];

function matchesEquivalentPattern(normalizedLabel: string, normalizedPattern: string): boolean {
  for (const group of APPLICATION_ANSWER_ALIASES) {
    const labelMatches = group.some((entry) => normalizedLabel.includes(entry));
    const patternMatches = group.some((entry) => normalizedPattern.includes(entry));
    if (labelMatches && patternMatches) {
      return true;
    }
  }

  return false;
}

export function normalizeApplicationAnswerPattern(value: string): string {
  return normalize(value);
}

async function ensureAnswersDir(): Promise<void> {
  await mkdir(path.dirname(applicationAnswersPath), { recursive: true });
}

export async function loadApplicationAnswers(): Promise<ApplicationAnswers> {
  await ensureAnswersDir();

  try {
    const raw = await readFile(applicationAnswersPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ApplicationAnswers>;
    return {
      text: parsed.text && typeof parsed.text === "object" ? parsed.text : {},
      select: parsed.select && typeof parsed.select === "object" ? parsed.select : {},
      radio: parsed.radio && typeof parsed.radio === "object" ? parsed.radio : {},
      checkbox: parsed.checkbox && typeof parsed.checkbox === "object" ? parsed.checkbox : {},
    };
  } catch {
    await writeFile(
      applicationAnswersPath,
      `${JSON.stringify(defaultApplicationAnswers, null, 2)}\n`,
      "utf8",
    ).catch(() => undefined);
    return defaultApplicationAnswers;
  }
}

export async function saveApplicationAnswers(answers: ApplicationAnswers): Promise<void> {
  await ensureAnswersDir();
  await writeFile(applicationAnswersPath, `${JSON.stringify(answers, null, 2)}\n`, "utf8");
}

export async function upsertApplicationAnswer(
  bucket: ApplicationAnswerBucket,
  pattern: string,
  answer: string,
): Promise<ApplicationAnswers> {
  const normalizedPattern = normalizeApplicationAnswerPattern(pattern);
  const normalizedAnswer = answer.trim();

  if (!normalizedPattern) {
    throw new Error("Application answer pattern cannot be empty.");
  }
  if (!normalizedAnswer) {
    throw new Error("Application answer value cannot be empty.");
  }

  const answers = await loadApplicationAnswers();
  answers[bucket][normalizedPattern] = normalizedAnswer;
  await saveApplicationAnswers(answers);
  return answers;
}

export function lookupApplicationAnswer(
  answers: ApplicationAnswers,
  label: string,
  type: string,
): string | null {
  const normalizedLabel = normalize(label);
  const normalizedType = normalize(type);
  const buckets = [
    normalizedType.includes("radio") ? answers.radio : null,
    normalizedType.includes("select") || normalizedType.includes("dropdown") || normalizedType.includes("combobox")
      ? answers.select
      : null,
    normalizedType.includes("checkbox") ? answers.checkbox : null,
    answers.text,
    answers.select,
    answers.radio,
    answers.checkbox,
  ].filter((bucket): bucket is Record<string, string> => Boolean(bucket));

  for (const bucket of buckets) {
    for (const [pattern, answer] of Object.entries(bucket)) {
      const normalizedPattern = normalize(pattern);
      if (!normalizedPattern || !answer?.trim()) {
        continue;
      }

      if (
        normalizedLabel.includes(normalizedPattern) ||
        normalizedPattern.includes(normalizedLabel) ||
        matchesEquivalentPattern(normalizedLabel, normalizedPattern)
      ) {
        return answer.trim();
      }
    }
  }

  return null;
}
