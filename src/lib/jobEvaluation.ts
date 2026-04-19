import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  JobEvaluationProfile,
  JobEvaluationProfilesState,
  JobEvaluationSignal,
  WorkloadScreening,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const dataDir = path.join(repoRoot, "data");

export const jobEvaluationProfilesPath = path.join(dataDir, "job-evaluation-profiles.json");
export const legacyJobEvaluationProfilePath = path.join(dataDir, "job-evaluation-profile.json");
export const jobEvaluationProfilePath = jobEvaluationProfilesPath;

const defaultJobEvaluationProfile: JobEvaluationProfile = {
  name: "low-stress-remote-software",
  summary:
    "Keep remote software jobs that sound stable, scoped, async-friendly, and low-drama. Skip roles that sound startup-heavy, meeting-heavy, leadership-heavy, travel-heavy, or after-hours.",
  saveWhen: [
    "Remote or remote-first software work with clear individual-contributor scope",
    "Async or written communication norms instead of constant meetings",
    "Stable product work with predictable workload and fewer priority swings",
    "Maintenance, internal tools, or narrow sustaining work on existing systems",
    "Little or no travel, on-call, incident response, or customer-facing pressure",
  ],
  avoidWhen: [
    "Hybrid, onsite, relocation, or travel-heavy expectations",
    "Fast-paced, high-ownership, high-impact, wear-many-hats language",
    "Early-stage startup, founding engineer, hypergrowth, or zero-to-one work",
    "On-call, pager, 24/7 support, incident-heavy operations, or crisis language",
    "Heavy cross-functional, stakeholder, customer-facing, or leadership overhead",
    "Broad platform or infrastructure roles framed around strategy, architecture ownership, or org-wide enablement",
    "Contract, hourly, project-based, or AI-evaluation work instead of a normal full-time software role",
  ],
  maxScore: 3,
  positiveSignals: [
    { phrase: "fully remote", score: -4, reason: "explicitly fully remote" },
    { phrase: "remote-first", score: -4, reason: "signals a remote-first workflow" },
    { phrase: "distributed team", score: -2, reason: "signals a distributed team setup" },
    { phrase: "async-first", score: -4, reason: "signals lower meeting overhead" },
    { phrase: "async communication", score: -3, reason: "signals async communication" },
    { phrase: "asynchronous communication", score: -3, reason: "signals async communication" },
    { phrase: "written communication", score: -2, reason: "signals async communication" },
    { phrase: "clear scope", score: -2, reason: "signals defined scope" },
    { phrase: "internal tools", score: -3, reason: "signals lower-visibility product work" },
    { phrase: "maintenance", score: -3, reason: "signals lower-intensity sustaining work" },
    {
      phrase: "scaling existing systems",
      score: -4,
      reason: "signals sustaining work over greenfield pressure",
    },
    { phrase: "existing systems", score: -2, reason: "signals less greenfield pressure" },
    { phrase: "stable", score: -2, reason: "signals a steadier environment" },
    { phrase: "predictable", score: -2, reason: "signals a steadier workload" },
    { phrase: "established product", score: -3, reason: "signals a mature product environment" },
    { phrase: "mature company", score: -2, reason: "signals a more established company" },
  ],
  negativeSignals: [
    { phrase: "hybrid", score: 6, reason: "signals the role is not fully remote", hardReject: true },
    { phrase: "onsite", score: 6, reason: "signals the role is not remote", hardReject: true },
    { phrase: "on-site", score: 6, reason: "signals the role is not remote", hardReject: true },
    { phrase: "in office", score: 6, reason: "signals in-office expectations", hardReject: true },
    { phrase: "relocation", score: 5, reason: "signals relocation expectations", hardReject: true },
    { phrase: "travel", score: 4, reason: "signals travel expectations" },
    { phrase: "fast-paced", score: 5, reason: "mentions a fast-paced environment", hardReject: true },
    { phrase: "wear many hats", score: 5, reason: "signals broad unbounded scope", hardReject: true },
    { phrase: "wearing many hats", score: 5, reason: "signals broad unbounded scope", hardReject: true },
    { phrase: "high ownership", score: 5, reason: "emphasizes high-ownership expectations", hardReject: true },
    { phrase: "high impact", score: 5, reason: "emphasizes high-pressure impact language", hardReject: true },
    { phrase: "mission-driven", score: 2, reason: "signals culture-driven extra effort expectations" },
    { phrase: "passionate", score: 4, reason: "signals extra-effort culture language" },
    { phrase: "hardworking", score: 4, reason: "signals extra-effort culture language" },
    { phrase: "team player", score: 3, reason: "signals collaboration-heavy expectations" },
    { phrase: "move fast", score: 4, reason: "signals sustained urgency", hardReject: true },
    {
      phrase: "thrive in ambiguity",
      score: 3,
      reason: "signals unclear scope and shifting priorities",
    },
    { phrase: "ambiguity", score: 2, reason: "signals unclear scope" },
    { phrase: "dynamic environment", score: 2, reason: "signals changing priorities" },
    { phrase: "changing priorities", score: 2, reason: "signals unstable workload" },
    { phrase: "cross-functional", score: 5, reason: "signals heavy coordination", hardReject: true },
    { phrase: "stakeholder", score: 2, reason: "signals ongoing alignment work" },
    { phrase: "stakeholder management", score: 4, reason: "signals heavy coordination" },
    { phrase: "customer-facing", score: 4, reason: "signals client-facing overhead" },
    { phrase: "client-facing", score: 4, reason: "signals client-facing overhead" },
    { phrase: "mentor", score: 2, reason: "signals leadership overhead" },
    { phrase: "mentorship", score: 2, reason: "signals leadership overhead" },
    { phrase: "leadership", score: 2, reason: "signals leadership expectations" },
    {
      phrase: "architecture decisions",
      score: 5,
      reason: "signals broad technical ownership",
      hardReject: true,
    },
    {
      phrase: "technical and business teams",
      score: 5,
      reason: "signals heavy business alignment work",
      hardReject: true,
    },
    {
      phrase: "business teams",
      score: 3,
      reason: "signals cross-org alignment overhead",
    },
    {
      phrase: "organizational capability",
      score: 4,
      reason: "signals org-level scope instead of bounded IC work",
      hardReject: true,
    },
    {
      phrase: "roadmap priorities",
      score: 3,
      reason: "signals broader planning overhead",
    },
    {
      phrase: "impactful projects",
      score: 3,
      reason: "signals higher-pressure delivery expectations",
    },
    {
      phrase: "contract work",
      score: 6,
      reason: "signals contract work instead of a normal employee role",
      hardReject: true,
    },
    {
      phrase: "contract position",
      score: 6,
      reason: "signals contract work instead of a normal employee role",
      hardReject: true,
    },
    {
      phrase: "type contractor",
      score: 6,
      reason: "signals contractor work instead of a normal employee role",
      hardReject: true,
    },
    {
      phrase: "not a full time employee role",
      score: 6,
      reason: "signals contractor work instead of a normal employee role",
      hardReject: true,
    },
    {
      phrase: "independent contract position",
      score: 6,
      reason: "signals contractor work instead of a normal employee role",
      hardReject: true,
    },
    {
      phrase: "project based opportunity",
      score: 5,
      reason: "signals project-based contract work",
      hardReject: true,
    },
    {
      phrase: "projects are paid hourly",
      score: 6,
      reason: "signals hourly contract work",
      hardReject: true,
    },
    {
      phrase: "ai trainer",
      score: 6,
      reason: "signals AI training work instead of product engineering",
      hardReject: true,
      appliesTo: "all",
    },
    {
      phrase: "data annotation",
      score: 6,
      reason: "signals annotation work instead of product engineering",
      hardReject: true,
    },
    {
      phrase: "model evaluation",
      score: 6,
      reason: "signals evaluation work instead of product engineering",
      hardReject: true,
    },
    {
      phrase: "evaluate ai generated",
      score: 6,
      reason: "signals AI evaluation work instead of product engineering",
      hardReject: true,
    },
    {
      phrase: "evaluate llm generated responses",
      score: 6,
      reason: "signals AI evaluation work instead of product engineering",
      hardReject: true,
    },
    {
      phrase: "annotate model responses",
      score: 6,
      reason: "signals AI evaluation work instead of product engineering",
      hardReject: true,
    },
    {
      phrase: "support ai research",
      score: 6,
      reason: "signals AI research contract work instead of product engineering",
      hardReject: true,
    },
    {
      phrase: "rlhf",
      score: 6,
      reason: "signals model-tuning contract work instead of product engineering",
      hardReject: true,
    },
    {
      phrase: "manager",
      score: 6,
      reason: "title signals management responsibility",
      hardReject: true,
      appliesTo: "title",
    },
    {
      phrase: "director",
      score: 6,
      reason: "title signals management responsibility",
      hardReject: true,
      appliesTo: "title",
    },
    {
      phrase: "architect",
      score: 4,
      reason: "title signals broader system ownership",
      hardReject: true,
      appliesTo: "title",
    },
    {
      phrase: "tech lead",
      score: 4,
      reason: "title signals leadership responsibility",
      hardReject: true,
      appliesTo: "title",
    },
    { phrase: "on-call", score: 4, reason: "signals after-hours operational load", hardReject: true },
    { phrase: "pager", score: 4, reason: "signals after-hours operational load", hardReject: true },
    { phrase: "incident", score: 2, reason: "signals reactive production work" },
    { phrase: "24/7", score: 4, reason: "signals always-on support expectations", hardReject: true },
    { phrase: "startup", score: 4, reason: "signals startup-style workload", hardReject: true },
    { phrase: "stealth startup", score: 6, reason: "signals a stealth-startup environment", hardReject: true },
    { phrase: "early-stage", score: 5, reason: "signals startup-style workload", hardReject: true },
    { phrase: "seed stage", score: 5, reason: "signals startup-style workload", hardReject: true },
    { phrase: "series a", score: 4, reason: "signals startup-style workload", hardReject: true },
    { phrase: "series b", score: 3, reason: "signals startup-style workload" },
    { phrase: "founding engineer", score: 5, reason: "signals startup-style workload", hardReject: true },
    { phrase: "high-growth", score: 4, reason: "signals scaling pressure" },
    { phrase: "hypergrowth", score: 5, reason: "signals scaling pressure", hardReject: true },
    { phrase: "zero-to-one", score: 3, reason: "signals heavy greenfield pressure" },
    { phrase: "0 to 1", score: 3, reason: "signals heavy greenfield pressure" },
    { phrase: "player-coach", score: 2, reason: "signals mixed IC and management work" },
    { phrase: "long hours", score: 6, reason: "explicitly expects long hours", hardReject: true },
    { phrase: "high agency", score: 5, reason: "signals ambiguous high-agency ownership", hardReject: true },
    {
      phrase: "system-level ownership",
      score: 5,
      reason: "signals broad system ownership pressure",
      hardReject: true,
    },
    { phrase: "strict boundaries", score: 5, reason: "signals anti-boundary culture", hardReject: true },
    {
      phrase: "category-defining company",
      score: 5,
      reason: "signals founder-style company-building pressure",
      hardReject: true,
    },
    {
      phrase: "category defining company",
      score: 5,
      reason: "signals founder-style company-building pressure",
      hardReject: true,
    },
  ],
};

type JobEvaluationInput = {
  title: string;
  company: string;
  description: string;
};

function cloneDefaultJobEvaluationProfile(): JobEvaluationProfile {
  return JSON.parse(JSON.stringify(defaultJobEvaluationProfile)) as JobEvaluationProfile;
}

function createDefaultJobEvaluationProfilesState(): JobEvaluationProfilesState {
  const profile = cloneDefaultJobEvaluationProfile();
  return {
    activeProfileName: profile.name,
    profiles: [profile],
  };
}

async function ensureDataDir(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
}

function sanitizeSignal(input: unknown, fallback: JobEvaluationSignal): JobEvaluationSignal | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const candidate = input as Record<string, unknown>;
  const phrase = typeof candidate.phrase === "string" ? candidate.phrase.trim() : "";
  const score = typeof candidate.score === "number" && Number.isFinite(candidate.score) ? candidate.score : NaN;
  const reason = typeof candidate.reason === "string" ? candidate.reason.trim() : "";

  if (!phrase || !Number.isFinite(score) || !reason) {
    return null;
  }

  const appliesTo =
    candidate.appliesTo === "title" ||
    candidate.appliesTo === "company" ||
    candidate.appliesTo === "description" ||
    candidate.appliesTo === "all"
      ? candidate.appliesTo
      : fallback.appliesTo || "all";

  return {
    phrase,
    score,
    reason,
    hardReject: Boolean(candidate.hardReject),
    appliesTo,
  };
}

function sanitizeSignalList(
  input: unknown,
  fallback: JobEvaluationSignal[],
): JobEvaluationSignal[] {
  if (!Array.isArray(input)) {
    return fallback.map((signal) => ({ ...signal }));
  }

  return input
    .map((entry, index) => sanitizeSignal(entry, fallback[index] ?? fallback[0] ?? { phrase: "", score: 0, reason: "" }))
    .filter((entry): entry is JobEvaluationSignal => Boolean(entry));
}

function normalizeProfile(input: unknown): JobEvaluationProfile {
  if (!input || typeof input !== "object") {
    return cloneDefaultJobEvaluationProfile();
  }

  const candidate = input as Record<string, unknown>;
  const fallback = cloneDefaultJobEvaluationProfile();

  return {
    name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : fallback.name,
    summary:
      typeof candidate.summary === "string" && candidate.summary.trim()
        ? candidate.summary.trim()
        : fallback.summary,
    saveWhen: Array.isArray(candidate.saveWhen)
      ? candidate.saveWhen
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .map((entry) => entry.trim())
      : fallback.saveWhen,
    avoidWhen: Array.isArray(candidate.avoidWhen)
      ? candidate.avoidWhen
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .map((entry) => entry.trim())
      : fallback.avoidWhen,
    maxScore:
      typeof candidate.maxScore === "number" && Number.isFinite(candidate.maxScore)
        ? candidate.maxScore
        : fallback.maxScore,
    positiveSignals: sanitizeSignalList(candidate.positiveSignals, fallback.positiveSignals),
    negativeSignals: sanitizeSignalList(candidate.negativeSignals, fallback.negativeSignals),
  };
}

function normalizeProfilesState(input: unknown): JobEvaluationProfilesState {
  if (!input || typeof input !== "object") {
    return createDefaultJobEvaluationProfilesState();
  }

  const candidate = input as Record<string, unknown>;
  const fallback = createDefaultJobEvaluationProfilesState();
  const rawProfiles =
    Array.isArray(candidate.profiles) ? candidate.profiles : candidate.name ? [candidate] : fallback.profiles;
  const seenNames = new Set<string>();
  const profiles = rawProfiles
    .map((profile) => normalizeProfile(profile))
    .filter((profile) => {
      const normalizedName = profile.name.trim().toLowerCase();
      if (!normalizedName || seenNames.has(normalizedName)) {
        return false;
      }

      seenNames.add(normalizedName);
      return true;
    });

  if (profiles.length === 0) {
    return fallback;
  }

  const requestedActiveName =
    typeof candidate.activeProfileName === "string" && candidate.activeProfileName.trim()
      ? candidate.activeProfileName.trim()
      : profiles[0].name;
  const activeProfile =
    profiles.find((profile) => profile.name.toLowerCase() === requestedActiveName.toLowerCase()) ?? profiles[0];

  return {
    activeProfileName: activeProfile.name,
    profiles,
  };
}

function getSignalText(input: JobEvaluationInput, appliesTo: JobEvaluationSignal["appliesTo"]): string {
  const title = normalizeEvaluationText(input.title);
  const company = normalizeEvaluationText(input.company);
  const description = normalizeEvaluationText(input.description);

  switch (appliesTo) {
    case "title":
      return title;
    case "company":
      return company;
    case "description":
      return description;
    default:
      return `${title} ${company} ${description}`;
  }
}

function normalizeEvaluationText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function readLegacyJobEvaluationProfiles(): Promise<JobEvaluationProfilesState | null> {
  try {
    const raw = await readFile(legacyJobEvaluationProfilePath, "utf8");
    return normalizeProfilesState(JSON.parse(raw));
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return null;
    }

    throw new Error(
      `Could not read ${legacyJobEvaluationProfilePath}. Check that it contains valid JSON.`,
    );
  }
}

export async function getJobEvaluationProfiles(): Promise<JobEvaluationProfilesState> {
  await ensureDataDir();

  try {
    const raw = await readFile(jobEvaluationProfilesPath, "utf8");
    return normalizeProfilesState(JSON.parse(raw));
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") {
      throw new Error(`Could not read ${jobEvaluationProfilesPath}. Check that it contains valid JSON.`);
    }

    const legacy = await readLegacyJobEvaluationProfiles();
    if (legacy) {
      return saveJobEvaluationProfiles(legacy);
    }

    const fallback = createDefaultJobEvaluationProfilesState();
    return saveJobEvaluationProfiles(fallback);
  }
}

export async function saveJobEvaluationProfiles(
  profilesState: JobEvaluationProfilesState,
): Promise<JobEvaluationProfilesState> {
  await ensureDataDir();
  const normalized = normalizeProfilesState(profilesState);
  await writeFile(jobEvaluationProfilesPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export async function upsertJobEvaluationProfile(
  profile: JobEvaluationProfile,
  options: { makeActive?: boolean } = {},
): Promise<JobEvaluationProfilesState> {
  const current = await getJobEvaluationProfiles();
  const normalizedProfile = normalizeProfile(profile);
  const nextProfiles = [
    ...current.profiles.filter(
      (entry) => entry.name.trim().toLowerCase() !== normalizedProfile.name.trim().toLowerCase(),
    ),
    normalizedProfile,
  ];

  return saveJobEvaluationProfiles({
    activeProfileName: options.makeActive === false ? current.activeProfileName : normalizedProfile.name,
    profiles: nextProfiles,
  });
}

export async function setActiveJobEvaluationProfile(name: string): Promise<JobEvaluationProfilesState> {
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error("Active evaluation profile name is required.");
  }

  const current = await getJobEvaluationProfiles();
  const match = current.profiles.find(
    (profile) => profile.name.trim().toLowerCase() === normalizedName.toLowerCase(),
  );

  if (!match) {
    throw new Error(`No evaluation profile named "${normalizedName}" was found.`);
  }

  return saveJobEvaluationProfiles({
    ...current,
    activeProfileName: match.name,
  });
}

export async function getJobEvaluationProfile(profileName?: string): Promise<JobEvaluationProfile> {
  const state = await getJobEvaluationProfiles();
  const requestedName = profileName?.trim();

  if (!requestedName) {
    return state.profiles.find((profile) => profile.name === state.activeProfileName) ?? state.profiles[0];
  }

  const match = state.profiles.find(
    (profile) => profile.name.trim().toLowerCase() === requestedName.toLowerCase(),
  );
  if (!match) {
    throw new Error(`No evaluation profile named "${requestedName}" was found.`);
  }

  return match;
}

export async function saveJobEvaluationProfile(profile: JobEvaluationProfile): Promise<void> {
  await upsertJobEvaluationProfile(profile);
}

export function summarizeJobEvaluationProfile(profile: JobEvaluationProfile): string {
  return `${profile.name}: ${profile.summary}`;
}

export function evaluateJobAgainstProfile(
  input: JobEvaluationInput,
  profile: JobEvaluationProfile,
): WorkloadScreening {
  const matchesSignal = (signal: JobEvaluationSignal): boolean => {
    const haystack = getSignalText(input, signal.appliesTo);
    const needle = normalizeEvaluationText(signal.phrase);
    return needle.length > 0 && haystack.includes(needle);
  };

  const matchedNegativeSignals = profile.negativeSignals.filter(matchesSignal);
  const matchedPositiveSignals = profile.positiveSignals.filter(matchesSignal);
  const score =
    matchedNegativeSignals.reduce((sum, entry) => sum + entry.score, 0) +
    matchedPositiveSignals.reduce((sum, entry) => sum + entry.score, 0);
  const hardReject = matchedNegativeSignals.some((entry) => entry.hardReject);

  return {
    pass: !hardReject && score <= profile.maxScore,
    score,
    reasons: dedupeStrings([
      ...matchedNegativeSignals.map((entry) => entry.reason),
      ...matchedPositiveSignals.map((entry) => entry.reason),
    ]),
    matchedPositiveSignals: matchedPositiveSignals.map((entry) => entry.phrase),
    matchedNegativeSignals: matchedNegativeSignals.map((entry) => entry.phrase),
    profileName: profile.name,
    profileSummary: profile.summary,
  };
}

export async function evaluateJobScreening(input: JobEvaluationInput): Promise<WorkloadScreening> {
  const profile = await getJobEvaluationProfile();
  return evaluateJobAgainstProfile(input, profile);
}
