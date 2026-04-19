import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { lookupApplicationAnswer, type ApplicationAnswers } from "./applicationAnswers.js";

export type QuestionDecision = {
  label: string;
  type: string;
  choices: string[];
  answer: string;
  status: "answered" | "unanswered";
  source: "application-answers" | "question-bank" | "profile-heuristic" | "unanswered";
  seenAt: string;
};

export type QuestionBankEntry = {
  key: string;
  label: string;
  type: string;
  choices: string[];
  answer: string;
  status: "answered" | "unanswered";
  source: "application-answers" | "question-bank" | "profile-heuristic" | "unanswered";
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
};

export type QuestionBank = {
  entries: QuestionBankEntry[];
};

const questionBankPath = path.join(process.cwd(), "data", "question-bank.json");

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildQuestionKey(label: string, type: string, choices: string[]): string {
  const normalizedChoices = choices.map((choice) => normalize(choice)).filter(Boolean).sort().join("|");
  return [normalize(label), normalize(type), normalizedChoices].join("::");
}

async function ensureQuestionBankDir(): Promise<void> {
  await mkdir(path.dirname(questionBankPath), { recursive: true });
}

export async function loadQuestionBank(): Promise<QuestionBank> {
  await ensureQuestionBankDir();

  try {
    const raw = await readFile(questionBankPath, "utf8");
    const parsed = JSON.parse(raw) as QuestionBank;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    return { entries: [] };
  }
}

export function lookupQuestionBankAnswer(
  bank: QuestionBank,
  label: string,
  type: string,
  choices: string[],
): string | null {
  const key = buildQuestionKey(label, type, choices);
  const match = bank.entries.find((entry) => entry.key === key && entry.status === "answered");
  return match?.answer?.trim() ? match.answer : null;
}

export async function persistQuestionDecisions(decisions: QuestionDecision[]): Promise<void> {
  if (decisions.length === 0) {
    return;
  }

  const bank = await loadQuestionBank();

  for (const decision of decisions) {
    const key = buildQuestionKey(decision.label, decision.type, decision.choices);
    const existing = bank.entries.find((entry) => entry.key === key);

    if (existing) {
      existing.label = decision.label;
      existing.type = decision.type;
      existing.choices = decision.choices;
      existing.lastSeenAt = decision.seenAt;
      existing.seenCount += 1;

      if (decision.status === "answered") {
        existing.answer = decision.answer;
        existing.status = decision.status;
        existing.source = decision.source;
      }
      continue;
    }

    bank.entries.push({
      key,
      label: decision.label,
      type: decision.type,
      choices: decision.choices,
      answer: decision.answer,
      status: decision.status,
      source: decision.source,
      firstSeenAt: decision.seenAt,
      lastSeenAt: decision.seenAt,
      seenCount: 1,
    });
  }

  bank.entries.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  await ensureQuestionBankDir();
  await writeFile(questionBankPath, `${JSON.stringify(bank, null, 2)}\n`, "utf8");
}

export async function applyApplicationAnswersToQuestionBank(
  answers: ApplicationAnswers,
): Promise<{ updatedCount: number }> {
  const bank = await loadQuestionBank();
  let updatedCount = 0;
  const seenAt = new Date().toISOString();

  for (const entry of bank.entries) {
    const explicitAnswer = lookupApplicationAnswer(answers, entry.label, entry.type);
    if (!explicitAnswer) {
      continue;
    }

    const needsUpdate =
      entry.status !== "answered" ||
      entry.source !== "application-answers" ||
      entry.answer.trim() !== explicitAnswer;

    if (!needsUpdate) {
      continue;
    }

    entry.answer = explicitAnswer;
    entry.status = "answered";
    entry.source = "application-answers";
    entry.lastSeenAt = seenAt;
    updatedCount += 1;
  }

  if (updatedCount > 0) {
    bank.entries.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    await ensureQuestionBankDir();
    await writeFile(questionBankPath, `${JSON.stringify(bank, null, 2)}\n`, "utf8");
  }

  return { updatedCount };
}
