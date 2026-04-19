import type { Job, JobStatus } from "./types.js";

const statusRank: Record<JobStatus, number> = {
  saved: 0,
  researching: 1,
  applying: 2,
  blocked: 3,
  applied: 4,
  interviewing: 5,
  closed: 6,
};

function tidy(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function cleanRepeatedText(value: string): string {
  const trimmed = tidy(value);
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

export function normalizeLinkedInJobUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("linkedin.com")) {
      return tidy(url).replace(/\/+$/, "");
    }

    const match = parsed.pathname.match(/\/jobs\/view\/(\d+)/);
    if (!match) {
      return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
    }

    return `${parsed.origin}/jobs/view/${match[1]}/`;
  } catch {
    return tidy(url).replace(/\/+$/, "");
  }
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseLinkedInPageTitle(
  title: string,
): {
  title: string;
  company: string;
} | null {
  const match = cleanRepeatedText(title).match(/^(.*?)\s+\|\s+(.*?)\s+\|\s+LinkedIn$/i);
  if (!match) {
    return null;
  }

  return {
    title: tidy(match[1]),
    company: tidy(match[2]),
  };
}

function isUnknownCompany(value: string): boolean {
  return !value || value.toLowerCase() === "unknown company";
}

export function canonicalizeJob(job: Job): Job {
  const source = tidy(job.source);
  let title = cleanRepeatedText(job.title);
  let company = cleanRepeatedText(job.company);
  let url = tidy(job.url).replace(/\/+$/, "");

  if (url.includes("linkedin.com/jobs/view/")) {
    url = normalizeLinkedInJobUrl(url);
  }

  const linkedInTitle = parseLinkedInPageTitle(title);
  if (linkedInTitle) {
    title = linkedInTitle.title;
    if (isUnknownCompany(company)) {
      company = linkedInTitle.company;
    }
  }

  return {
    ...job,
    title: title || job.title,
    company: company || job.company,
    url,
    source: source || job.source,
    description: tidy(job.description),
    notes: job.notes.replace(/\r\n/g, "\n").trim(),
  };
}

function isLinkedInJob(job: Job): boolean {
  const source = tidy(job.source).toLowerCase();
  return source.includes("linkedin") || job.url.includes("linkedin.com/jobs");
}

function buildFallbackLinkedInKey(job: Job): string {
  const canonical = canonicalizeJob(job);
  const title = sanitizeSlug(canonical.title);
  const company = sanitizeSlug(canonical.company);
  if (!title || !company || company === "unknown-company") {
    return "";
  }
  return `linkedin-fallback:${title}|${company}`;
}

export function buildJobDedupKey(job: Job): string {
  const canonical = canonicalizeJob(job);
  if (canonical.url.includes("linkedin.com/jobs/view/")) {
    return `linkedin:${normalizeLinkedInJobUrl(canonical.url)}`;
  }

  if (isLinkedInJob(canonical)) {
    const fallback = buildFallbackLinkedInKey(canonical);
    if (fallback) {
      return fallback;
    }
  }

  if (canonical.url) {
    return `url:${canonical.url}`;
  }

  return `content:${sanitizeSlug(canonical.title)}|${sanitizeSlug(canonical.company)}`;
}

function getLinkedInContentKey(job: Job): string {
  if (!isLinkedInJob(job)) {
    return "";
  }

  return buildFallbackLinkedInKey(job);
}

function qualityScore(job: Job): number {
  const canonical = canonicalizeJob(job);
  let score = canonical.description.length;
  score += canonical.notes.length;
  score += statusRank[canonical.status] * 10;

  if (!isUnknownCompany(canonical.company)) {
    score += 200;
  }

  if (canonical.url.includes("linkedin.com/jobs/view/")) {
    score += 300;
  } else if (canonical.url && !canonical.url.includes("maintenance-page")) {
    score += 50;
  }

  if (!/\|\s+LinkedIn$/i.test(canonical.title)) {
    score += 75;
  }

  if (canonical.source.toLowerCase().includes("linkedin")) {
    score += 25;
  }

  return score;
}

function chooseBetterString(current: string, candidate: string, preferLonger = false): string {
  const left = tidy(current);
  const right = tidy(candidate);

  if (!left) return right;
  if (!right) return left;
  if (preferLonger) {
    return right.length > left.length ? right : left;
  }
  return left;
}

function mergeJobGroup(group: Job[]): Job {
  const canonicalGroup = group.map(canonicalizeJob);
  const sorted = [...canonicalGroup].sort((left, right) => {
    const scoreDiff = qualityScore(right) - qualityScore(left);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });

  const base = { ...sorted[0] };
  for (const candidate of sorted.slice(1)) {
    const candidateLinkedInUrl = candidate.url.includes("linkedin.com/jobs/view/");
    const baseLinkedInUrl = base.url.includes("linkedin.com/jobs/view/");

    base.title = chooseBetterString(base.title, candidate.title);
    if (isUnknownCompany(base.company)) {
      base.company = chooseBetterString(base.company, candidate.company);
    }
    base.description = chooseBetterString(base.description, candidate.description, true);
    base.notes = chooseBetterString(base.notes, candidate.notes, true);
    if (!baseLinkedInUrl && candidateLinkedInUrl) {
      base.url = candidate.url;
    }
    if (!base.source && candidate.source) {
      base.source = candidate.source;
    }
    if (statusRank[candidate.status] > statusRank[base.status]) {
      base.status = candidate.status;
    }
    if (new Date(candidate.createdAt).getTime() < new Date(base.createdAt).getTime()) {
      base.createdAt = candidate.createdAt;
    }
  }

  return canonicalizeJob(base);
}

export function dedupeJobs(
  jobs: Job[],
): {
  dedupedJobs: Job[];
  removedCount: number;
  mergedGroups: number;
} {
  const groups = new Map<string, Job[]>();
  for (const job of jobs) {
    const key = buildJobDedupKey(job);
    const list = groups.get(key) ?? [];
    list.push(job);
    groups.set(key, list);
  }

  let dedupedJobs = [...groups.values()]
    .map((group) => mergeJobGroup(group))
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());

  const secondary: Job[] = [];
  const linkedInGroups = new Map<
    string,
    {
      canonicals: Job[];
      broken: Job[];
    }
  >();

  for (const job of dedupedJobs) {
    const contentKey = getLinkedInContentKey(job);
    if (!contentKey) {
      secondary.push(job);
      continue;
    }

    const entry = linkedInGroups.get(contentKey) ?? { canonicals: [], broken: [] };
    if (job.url.includes("linkedin.com/jobs/view/")) {
      entry.canonicals.push(job);
    } else {
      entry.broken.push(job);
    }
    linkedInGroups.set(contentKey, entry);
  }

  for (const entry of linkedInGroups.values()) {
    if (entry.canonicals.length === 0) {
      secondary.push(...entry.broken);
      continue;
    }

    const sortedCanonicals = [...entry.canonicals].sort((left, right) => qualityScore(right) - qualityScore(left));
    const [primary, ...rest] = sortedCanonicals;
    secondary.push(entry.broken.length > 0 ? mergeJobGroup([primary, ...entry.broken]) : primary);
    secondary.push(...rest);
  }

  dedupedJobs = secondary.sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );

  const mergedGroups = [...groups.values()].filter((group) => group.length > 1).length;
  return {
    dedupedJobs,
    removedCount: jobs.length - dedupedJobs.length,
    mergedGroups,
  };
}
