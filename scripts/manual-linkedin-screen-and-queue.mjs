import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { evaluateJobScreening } from "../dist/lib/jobEvaluation.js";
import {
  addJobFromDraft,
  getJobs,
  recordJobEvaluationDecision,
} from "../dist/lib/store.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cdpUrl = process.env.JAA_CDP_URL || "http://127.0.0.1:9222";
const maxPages = Math.max(1, Number.parseInt(process.env.JAA_MANUAL_QUEUE_PAGES || "3", 10) || 3);
const maxJobs = Math.max(1, Number.parseInt(process.env.JAA_MANUAL_QUEUE_LIMIT || "24", 10) || 24);
const outputPath = path.join(
  repoRoot,
  "data",
  "browser",
  `manual-linkedin-queue-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);

function tidy(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeLinkedInJobUrl(url) {
  const match = String(url || "").match(/linkedin\.com\/jobs\/view\/(\d+)/i);
  return match ? `https://www.linkedin.com/jobs/view/${match[1]}/` : String(url || "");
}

function jobIdFromUrl(url) {
  return normalizeLinkedInJobUrl(url).match(/\/jobs\/view\/(\d+)\//)?.[1] || "";
}

function sameJob(left, right) {
  const leftId = jobIdFromUrl(left);
  const rightId = jobIdFromUrl(right);
  return Boolean(leftId && rightId && leftId === rightId) || normalizeLinkedInJobUrl(left) === normalizeLinkedInJobUrl(right);
}

function getStartOffset(url) {
  try {
    const value = new URL(url).searchParams.get("start");
    const parsed = Number.parseInt(value || "0", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function buildStartUrl(currentUrl, start) {
  const url = new URL(currentUrl);
  url.pathname = "/jobs/collections/remote-jobs/";
  url.searchParams.set("start", String(start));
  return url.toString();
}

async function getCollectionState(page) {
  const pageLabel = tidy(await page.locator(".jobs-search-pagination__page-state").first().innerText().catch(() => ""));
  const targetIds = (await getVisibleTargets(page)).map((target) => target.jobId).join(",");
  return {
    pageLabel,
    start: getStartOffset(page.url()),
    targetIds,
  };
}

function sameCollectionState(left, right) {
  return left.pageLabel === right.pageLabel && left.start === right.start && left.targetIds === right.targetIds;
}

async function waitForCollectionChange(page, before, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500).catch(() => undefined);
    const after = await getCollectionState(page);
    if (!sameCollectionState(before, after)) return true;
  }
  return false;
}

async function getVisibleTargets(page) {
  return page.evaluate(() => {
    const tidy = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const cards = Array.from(
      document.querySelectorAll(
        "li.jobs-search-results__list-item, li.scaffold-layout__list-item, .job-card-container, .jobs-search-results__list-item",
      ),
    );
    const targets = [];
    const seen = new Set();
    for (const card of cards) {
      const anchor = card.querySelector('a[href*="/jobs/view/"]');
      if (!anchor) continue;
      const match = anchor.href.match(/\/jobs\/view\/(\d+)/);
      const jobId = match?.[1] || "";
      if (!jobId || seen.has(jobId)) continue;
      seen.add(jobId);
      const lines = tidy(card.textContent).split(/(?=[A-Z][A-Za-z0-9 .,&()/-]{2,})/).map(tidy).filter(Boolean);
      targets.push({
        jobId,
        url: `https://www.linkedin.com/jobs/view/${jobId}/`,
        cardText: tidy(card.textContent),
        title: tidy(anchor.textContent) || lines[0] || "Untitled role",
      });
    }
    return targets;
  });
}

async function extractCurrentDetail(page, fallback) {
  await page.getByRole("button", { name: /^show more$/i }).click({ timeout: 1500 }).catch(() => undefined);
  await page.waitForTimeout(600).catch(() => undefined);
  return page.evaluate((fallbackTarget) => {
    const tidy = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const root =
      document.querySelector(".jobs-search__job-details--container") ||
      document.querySelector(".jobs-details") ||
      document.querySelector("main") ||
      document.body;
    const title =
      tidy(root.querySelector("h1")?.textContent) ||
      tidy(document.querySelector(".job-details-jobs-unified-top-card__job-title")?.textContent) ||
      fallbackTarget.title;
    const company =
      tidy(document.querySelector(".job-details-jobs-unified-top-card__company-name")?.textContent) ||
      tidy(root.querySelector('a[href*="/company/"]')?.textContent) ||
      "Unknown company";
    const description =
      tidy(document.querySelector(".jobs-description-content__text")?.textContent) ||
      tidy(root.textContent);
    return {
      title,
      company,
      description,
      pageText: tidy(root.textContent),
    };
  }, fallback);
}

async function clickTarget(page, target) {
  const selector = `a[href*="/jobs/view/${target.jobId}"]`;
  const candidates = page.locator(selector);
  const count = Math.min(await candidates.count().catch(() => 0), 8);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const clicked = await candidate
      .scrollIntoViewIfNeeded({ timeout: 2000 })
      .then(() => candidate.click({ timeout: 4000 }))
      .then(() => true)
      .catch(() => false);
    if (clicked) {
      await page.waitForTimeout(1800).catch(() => undefined);
      return true;
    }
  }

  const fallbackUrl = new URL(page.url());
  fallbackUrl.pathname = "/jobs/collections/remote-jobs/";
  fallbackUrl.searchParams.set("currentJobId", target.jobId);
  await page.goto(fallbackUrl.toString(), { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(1800).catch(() => undefined);
  return page.url().includes(target.jobId);
}

async function advancePage(page) {
  const before = await getCollectionState(page);
  const next = page.locator(".jobs-search-pagination__button--next").first();
  const nextStart = before.start + 25;
  if (!(await next.isVisible().catch(() => false))) {
    const fallbackUrl = buildStartUrl(page.url(), nextStart);
    await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(1800).catch(() => undefined);
    const after = await getCollectionState(page);
    return !sameCollectionState(before, after);
  }
  const disabled = await next.getAttribute("disabled").catch(() => null);
  const ariaDisabled = await next.getAttribute("aria-disabled").catch(() => null);
  if (disabled !== null || ariaDisabled === "true") return false;
  await next.click({ timeout: 8000 }).catch(() => undefined);
  if (await waitForCollectionChange(page, before)) return true;

  const fallbackUrl = buildStartUrl(page.url(), nextStart);
  await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(1800).catch(() => undefined);
  const after = await getCollectionState(page);
  return !sameCollectionState(before, after);
}

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().includes("linkedin.com/jobs/collections/remote-jobs"));
  if (!page) {
    throw new Error("No LinkedIn Remote Jobs collection page is open in the attached browser.");
  }
  await page.bringToFront().catch(() => undefined);

  const initialJobs = await getJobs();
  const results = [];
  const seen = new Set();
  const seenPageIdentities = new Set();
  let queuedCount = 0;

  for (let pageIndex = 0; pageIndex < maxPages && queuedCount < maxJobs; pageIndex += 1) {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(800).catch(() => undefined);
    const pageLabel = tidy(await page.locator(".jobs-search-pagination__page-state").first().innerText().catch(() => ""));
    const targets = await getVisibleTargets(page);
    const pageIdentity = `${getStartOffset(page.url())}|${pageLabel}|${targets.map((target) => target.jobId).join(",")}`;
    if (seenPageIdentities.has(pageIdentity)) {
      console.log(`STOP repeated LinkedIn page: ${pageLabel || page.url()}`);
      break;
    }
    seenPageIdentities.add(pageIdentity);
    console.log(`Scanning ${pageLabel || `collection page ${pageIndex + 1}`}: ${targets.length} visible jobs`);

    for (const target of targets) {
      if (queuedCount >= maxJobs) break;
      if (seen.has(target.jobId)) continue;
      seen.add(target.jobId);

      const existing = initialJobs.find((job) => sameJob(job.url, target.url));
      if (existing && ["applied", "blocked", "closed"].includes(existing.status)) {
        results.push({
          url: target.url,
          title: existing.title,
          company: existing.company,
          action: "skipped-existing",
          status: existing.status,
          reasons: [`Already ${existing.status} locally.`],
        });
        console.log(`SKIP ${existing.status}: ${existing.title} @ ${existing.company}`);
        continue;
      }

      if (!(await clickTarget(page, target))) {
        results.push({
          url: target.url,
          title: target.title,
          company: "Unknown company",
          action: "skipped",
          reasons: ["Could not open LinkedIn preview."],
        });
        console.log(`SKIP open failed: ${target.title}`);
        continue;
      }

      const detail = await extractCurrentDetail(page, target);
      const title = tidy(detail.title) || target.title;
      const company = tidy(detail.company) || "Unknown company";
      const description = tidy(detail.description).slice(0, 7000);
      const screening = await evaluateJobScreening({ title, company, description });
      const decisionId = target.url;

      if (!description) {
        results.push({
          url: target.url,
          title,
          company,
          action: "skipped",
          score: screening.score,
          reasons: ["Missing description."],
        });
        console.log(`SKIP no description: ${title} @ ${company}`);
        continue;
      }

      if (!screening.pass) {
        await recordJobEvaluationDecision({
          id: decisionId,
          title,
          company,
          url: target.url,
          normalizedUrl: target.url,
          source: "linkedin.com",
          descriptionSnippet: description,
          decision: "dismissed",
          pass: false,
          score: screening.score,
          reasons: screening.reasons,
          matchedPositiveSignals: [],
          matchedNegativeSignals: [],
          profileName: "low-stress-remote-software",
          profileSummary: "Manual CDP queue pass",
          evaluatedAt: new Date().toISOString(),
          trackedBy: "manual-linkedin-screen-and-queue",
          alreadySaved: false,
        });
        results.push({
          url: target.url,
          title,
          company,
          action: "dismissed",
          score: screening.score,
          reasons: screening.reasons,
        });
        console.log(`DISMISS ${screening.score}: ${title} @ ${company} | ${screening.reasons.join("; ")}`);
        continue;
      }

      const saved = await addJobFromDraft({
        title,
        company,
        description,
        source: "linkedin.com",
        url: target.url,
      });
      queuedCount += saved.status === "saved" ? 1 : 0;
      await recordJobEvaluationDecision({
        id: decisionId,
        title,
        company,
        url: target.url,
        normalizedUrl: target.url,
        source: "linkedin.com",
        descriptionSnippet: description,
        decision: "saved",
        jobId: saved.id,
        pass: true,
        score: screening.score,
        reasons: screening.reasons,
        matchedPositiveSignals: [],
        matchedNegativeSignals: [],
        profileName: "low-stress-remote-software",
        profileSummary: "Manual CDP queue pass",
        evaluatedAt: new Date().toISOString(),
        trackedBy: "manual-linkedin-screen-and-queue",
        alreadySaved: Boolean(existing),
      });
      results.push({
        url: target.url,
        title,
        company,
        action: saved.status === "saved" ? "queued" : `existing-${saved.status}`,
        jobId: saved.id,
        score: screening.score,
        reasons: screening.reasons,
      });
      console.log(`${saved.status === "saved" ? "QUEUE" : `EXISTING ${saved.status}`}: ${title} @ ${company}`);
    }

    if (pageIndex + 1 >= maxPages || queuedCount >= maxJobs) break;
    if (!(await advancePage(page))) break;
  }

  await writeFile(outputPath, `${JSON.stringify({ queuedCount, results }, null, 2)}\n`, "utf8");
  console.log(`Queued saved jobs: ${queuedCount}`);
  console.log(`Artifact: ${outputPath}`);
} finally {
  await browser.close().catch(() => undefined);
}
