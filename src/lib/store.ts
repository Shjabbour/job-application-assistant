import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChatMessage,
  ExtractedJobDraft,
  HighPayingCompanyRecord,
  Job,
  Profile,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const dataDir = path.join(repoRoot, "data");

const profilePath = path.join(dataDir, "profile.json");
const jobsPath = path.join(dataDir, "jobs.json");
const conversationPath = path.join(dataDir, "conversation.json");
const highPayingCompaniesPath = path.join(dataDir, "high-paying-companies.json");

const defaultProfile: Profile = {
  name: "",
  email: "",
  phone: "",
  location: "",
  city: "",
  state: "",
  linkedinUrl: "",
  resumeSummary: "",
  skills: [],
  targetRoles: [],
  workAuthorization: "",
  yearsOfExperience: "",
};

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  await ensureDataDir();

  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    await writeJsonFile(filePath, fallback);
    return fallback;
  }
}

async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
  await ensureDataDir();
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function getProfile(): Promise<Profile> {
  return readJsonFile(profilePath, defaultProfile);
}

export async function saveProfile(profile: Profile): Promise<void> {
  await writeJsonFile(profilePath, profile);
}

export async function getJobs(): Promise<Job[]> {
  return readJsonFile(jobsPath, []);
}

export async function saveJobs(jobs: Job[]): Promise<void> {
  await writeJsonFile(jobsPath, jobs);
}

export async function addJobFromDraft(draft: ExtractedJobDraft): Promise<Job> {
  const jobs = await getJobs();
  const slug = `${draft.company}-${draft.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);

  const job: Job = {
    id: `${slug}-${Date.now().toString().slice(-6)}`,
    title: draft.title,
    company: draft.company,
    url: draft.url,
    source: draft.source,
    status: "saved",
    description: draft.description,
    notes: "",
    createdAt: new Date().toISOString(),
  };

  jobs.push(job);
  await saveJobs(jobs);
  return job;
}

export async function addJobsFromCollection(
  drafts: Array<{ title: string; company: string; url: string; location: string }>,
): Promise<Job[]> {
  const jobs = await getJobs();
  const existingUrls = new Set(jobs.map((job) => job.url));
  const added: Job[] = [];

  for (const draft of drafts) {
    if (!draft.url || existingUrls.has(draft.url)) {
      continue;
    }

    const slug = `${draft.company}-${draft.title}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 36);

    const job: Job = {
      id: `${slug}-${Date.now().toString().slice(-6)}-${added.length + 1}`,
      title: draft.title,
      company: draft.company || "Unknown company",
      url: draft.url,
      source: "linkedin.com",
      status: "saved",
      description: "",
      notes: draft.location || "",
      createdAt: new Date().toISOString(),
    };

    jobs.push(job);
    added.push(job);
    existingUrls.add(job.url);
  }

  await saveJobs(jobs);
  return added;
}

export async function getConversation(): Promise<ChatMessage[]> {
  return readJsonFile(conversationPath, []);
}

export async function appendConversation(message: ChatMessage): Promise<void> {
  const messages = await getConversation();
  messages.push(message);
  await writeJsonFile(conversationPath, messages);
}

export async function getHighPayingCompanies(): Promise<HighPayingCompanyRecord[]> {
  return readJsonFile(highPayingCompaniesPath, []);
}

export async function saveHighPayingCompanies(
  records: HighPayingCompanyRecord[],
): Promise<void> {
  await writeJsonFile(highPayingCompaniesPath, records);
}

export async function recordHighPayingCompany(
  record: HighPayingCompanyRecord,
): Promise<boolean> {
  const records = await getHighPayingCompanies();
  const exists = records.some(
    (entry) =>
      entry.company.toLowerCase() === record.company.toLowerCase() &&
      entry.sourceJobUrl === record.sourceJobUrl,
  );

  if (exists) {
    return false;
  }

  records.push(record);
  await saveHighPayingCompanies(records);
  return true;
}
