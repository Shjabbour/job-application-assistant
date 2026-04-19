import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext, type Frame, type FrameLocator, type Locator, type Page } from "playwright";
import { suggestFormAnswer, type FormQuestion } from "./formAnswers.js";
import { loadApplicationAnswers, lookupApplicationAnswer } from "./applicationAnswers.js";
import { evaluateJobScreening } from "./jobEvaluation.js";
import {
  loadQuestionBank,
  lookupQuestionBankAnswer,
  persistQuestionDecisions,
  type QuestionDecision,
} from "./questionBank.js";
import type {
  ApplicationField,
  ApplicationSiteKind,
  AutofillResult,
  ExternalApplyResult,
  ExtractedJobDraft,
  JobEnrichmentResult,
  JobCollectionItem,
  LinkedInApplyReview,
  Profile,
  SiteFormReview,
  WorkloadScreening,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const browserProfileDir = path.join(repoRoot, ".browser-profile");
const browserOutputDir = path.join(repoRoot, "data", "browser");
const attachedChromeProfileDir = path.join(repoRoot, ".chrome-debug-profile");
const attachedHostedGreenhouseWorkerPath = path.join(repoRoot, "scripts", "attached-hosted-greenhouse.mjs");
const browserChannel = process.env.JAA_BROWSER_CHANNEL || "chrome";
const cdpUrl = process.env.JAA_CDP_URL || "http://127.0.0.1:9222";
const execFileAsync = promisify(execFile);
const preferredAttachedPagePatterns = [
  "linkedin.com/jobs-tracker",
  "linkedin.com/jobs/collections/remote-jobs",
  "linkedin.com/jobs/collections/recommended",
  "linkedin.com/jobs/view/",
  "linkedin.com/jobs/",
];
let preferredAttachedPageUrl = "";
if (process.env.JAA_ATTACHED_PAGE_URL?.trim()) {
  preferredAttachedPageUrl = process.env.JAA_ATTACHED_PAGE_URL.trim();
}
let dialogRaceGuardInstalled = false;

type LocatorScope = Page | Locator;

export type AttachedLinkedInScreeningResult = {
  title: string;
  company: string;
  url: string;
  action: "saved" | "dismissed" | "skipped";
  reasons: string[];
  score: number;
  draft: ExtractedJobDraft | null;
  alreadySaved: boolean;
};

export type AttachedTrackerApplyResult = {
  sourceJobUrl: string;
  sourceJobTitle: string;
  sourceCompany: string;
  trackerAction: string;
  firstLandingUrl: string;
  openedTrackerApplyInNewPage: boolean;
  mode: "linkedin" | "external" | "none";
  linkedInAutofill: AutofillResult | null;
  externalResult: ExternalApplyResult | null;
  notes: string[];
};

type LinkedInPreviewTarget = {
  jobId: string;
  url: string;
  anchor: Locator;
  container: Locator;
  title: string;
  company: string;
  location: string;
};

async function ensureBrowserDirs(): Promise<void> {
  await mkdir(browserProfileDir, { recursive: true });
  await mkdir(browserOutputDir, { recursive: true });
}

function isNoDialogShowingRace(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /Page\.handleJavaScriptDialog|No dialog is showing/i.test(message);
}

function installDialogRaceGuard(): void {
  if (dialogRaceGuardInstalled) {
    return;
  }
  dialogRaceGuardInstalled = true;
  process.on("uncaughtException", (error) => {
    if (isNoDialogShowingRace(error)) {
      return;
    }
    throw error;
  });
  process.on("unhandledRejection", (reason) => {
    if (isNoDialogShowingRace(reason)) {
      return;
    }
    throw reason;
  });
}

function installSafeDialogHandler(page: Page): void {
  installDialogRaceGuard();
  const markedPage = page as Page & { __jaaSafeDialogHandlerInstalled?: boolean };
  if (markedPage.__jaaSafeDialogHandlerInstalled) {
    return;
  }
  markedPage.__jaaSafeDialogHandlerInstalled = true;
  page.on("dialog", async (dialog) => {
    await dialog.dismiss().catch(() => undefined);
  });
}

function installSafeDialogHandlers(context: BrowserContext): void {
  for (const page of context.pages()) {
    installSafeDialogHandler(page);
  }
  context.on("page", (page) => installSafeDialogHandler(page));
}

async function withPersistentPage<T>(
  headed: boolean,
  callback: (page: Page, context: BrowserContext) => Promise<T>,
): Promise<T> {
  await ensureBrowserDirs();
  const context = await chromium.launchPersistentContext(browserProfileDir, {
    channel: browserChannel as "chrome" | "msedge",
    headless: !headed,
    timeout: 30000,
    viewport: { width: 1440, height: 900 },
  });
  installSafeDialogHandlers(context);

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    return await callback(page, context);
  } finally {
    await context.close();
  }
}

async function withEphemeralPage<T>(
  headed: boolean,
  callback: (page: Page) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch({
    channel: browserChannel as "chrome" | "msedge",
    headless: !headed,
    timeout: 30000,
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    installSafeDialogHandler(page);
    return await callback(page);
  } finally {
    await browser.close();
  }
}

async function getTargetUrlsFromCdp(): Promise<string[]> {
  const response = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/list`);
  const payload = (await response.json()) as Array<{ type?: string; url?: string }>;

  return payload
    .filter((entry) => entry.type === "page" && typeof entry.url === "string")
    .map((entry) => entry.url ?? "");
}

async function getAttachedPage(browser: Browser): Promise<Page> {
  const urls = await getTargetUrlsFromCdp().catch(() => []);
  const pages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => !page.isClosed() && page.url() && page.url() !== "about:blank");

  if (preferredAttachedPageUrl) {
    const normalizedPreferred = preferredAttachedPageUrl.includes("linkedin.com/jobs/view/")
      ? normalizeLinkedInJobUrl(preferredAttachedPageUrl)
      : preferredAttachedPageUrl;
    const preferredPage = pages.find((page) => {
      const currentUrl = page.url();
      const normalizedCurrent = currentUrl.includes("linkedin.com/jobs/view/")
        ? normalizeLinkedInJobUrl(currentUrl)
        : currentUrl;
      return normalizedCurrent === normalizedPreferred;
    });
    if (preferredPage) {
      return preferredPage;
    }
  }

  for (const pattern of preferredAttachedPagePatterns) {
    const targetUrl = urls.find((url) => url.includes(pattern));
    if (!targetUrl) continue;

    const matchedPage = pages.find((page) => page.url() === targetUrl || page.url().includes(pattern));
    if (matchedPage) {
      return matchedPage;
    }
  }

  for (const page of pages) {
    if (page.url().includes("linkedin.com")) {
      return page;
    }
  }

  const fallbackPage = pages.find((page) => page.url() && page.url() !== "about:blank");
  if (fallbackPage) {
    return fallbackPage;
  }

  const [context] = browser.contexts();
  if (!context) {
    throw new Error("No browser contexts were found on the attached Chrome session.");
  }

  return context.newPage();
}

function isLikelyApplicationFormUrl(url: string): boolean {
  if (!url || url === "about:blank" || isLinkedInUrl(url)) {
    return false;
  }

  return (
    inferApplicationSiteKind(url) !== "generic" ||
    /\/apply\b|jobapply|flow\.jsf|careersection|careers?|jobs?/i.test(url)
  );
}

function isOracleHcmCandidateExperienceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.toLowerCase().includes("oraclecloud.com") &&
      /\/hcmUI\/CandidateExperience\//i.test(parsed.pathname)
    );
  } catch {
    return /oraclecloud\.com\/hcmUI\/CandidateExperience\//i.test(url);
  }
}

function scoreApplicationFormUrl(url: string): number {
  if (!isLikelyApplicationFormUrl(url)) {
    return 0;
  }

  let score = 10;
  const siteKind = inferApplicationSiteKind(url);
  if (siteKind === "taleo") {
    score += 50;
  } else if (siteKind !== "generic") {
    score += 25;
  }

  if (/flow\.jsf/i.test(url)) {
    score += 50;
  }
  if (/jobapply/i.test(url)) {
    score += 30;
  }
  if (/careersection/i.test(url)) {
    score += 20;
  }
  if (/\/apply\b|application/i.test(url)) {
    score += 15;
  }
  if (/login|signin|sign-in|privacy|statement|notice|register/i.test(url)) {
    score -= 15;
  }

  return Math.max(score, 1);
}

async function scoreAttachedFormPageState(page: Page, title: string): Promise<number> {
  const url = page.url();
  const bodyText = normalizeQuestionText(await page.locator("body").innerText({ timeout: 2_000 }).catch(() => ""));
  const pageText = `${normalizeQuestionText(title)} ${bodyText}`;
  let score = 0;

  if (/\bcurrent step \d+ of \d+\b/.test(bodyText)) {
    score += 100;
  }
  if (/\bcompleted step \d+ of \d+\b/.test(bodyText)) {
    score += 30;
  }
  if (/\bmy information\b|\bmy experience\b|\bapplication questions\b|\bvoluntary disclosures\b|\bself identify\b|\breview\b/.test(bodyText)) {
    score += 25;
  }
  if (/\bsave and continue\b|\bsubmit\b/.test(bodyText)) {
    score += 15;
  }
  if (/\bsign in\b|\bcreate account\b/.test(pageText)) {
    score -= 20;
  }
  if (
    /\bcandidate home\b|\bapplication submitted\b|\byou have no tasks\b|\bunder consideration\b|\bdate submitted\b|\bthanks for applying\b/.test(
      pageText,
    ) ||
    /\/jobTasks\/completed\/application/i.test(url)
  ) {
    score -= 150;
  }

  return score;
}

async function getAttachedFormPage(browser: Browser): Promise<Page> {
  const urls = await getTargetUrlsFromCdp().catch(() => []);
  const cdpOrder = new Map(urls.map((url, index) => [url, index]));
  const pages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => !page.isClosed() && page.url() && page.url() !== "about:blank");

  const activeTaleoFlowPage = pages.find((page) =>
    /taleo\.net\/careersection\/careersection\/candidateacquisition\/flow\.jsf/i.test(page.url()),
  );
  if (preferredAttachedPageUrl && isLikelyApplicationFormUrl(preferredAttachedPageUrl)) {
    const preferredPage = pages.find((page) => page.url() === preferredAttachedPageUrl);
    const preferredIsStaleTaleoAuth =
      /taleo\.net\/careersection\/iam\/accessmanagement\/login\.jsf/i.test(preferredAttachedPageUrl) &&
      activeTaleoFlowPage;
    if (preferredPage && !preferredIsStaleTaleoAuth) return preferredPage;
  }

  if (activeTaleoFlowPage) {
    const hasActiveFlowControls = await activeTaleoFlowPage
      .locator('input[id*="saveContinueCmd"], input[type="radio"], input[type="checkbox"], select, textarea')
      .count()
      .then((count) => count > 0)
      .catch(() => false);
    if (hasActiveFlowControls) {
      return activeTaleoFlowPage;
    }
  }

  const rankedPages: Array<{ page: Page; score: number; order: number }> = [];
  for (const page of pages) {
    let score = scoreApplicationFormUrl(page.url());
    if (score <= 0) {
      continue;
    }

    const title = tidy(await page.title().catch(() => ""));
    if (/thank you|confirmation|application received|process completed/i.test(`${title} ${page.url()}`)) {
      score -= 120;
    }
    score += await scoreAttachedFormPageState(page, title);

    if (score > 0) {
      rankedPages.push({
        page,
        score,
        order: cdpOrder.get(page.url()) ?? Number.MAX_SAFE_INTEGER,
      });
    }
  }
  rankedPages.sort((left, right) => right.score - left.score || left.order - right.order);

  if (rankedPages[0]) {
    return rankedPages[0].page;
  }

  return getAttachedPage(browser);
}

function normalizeAttachedTabKeepUrl(value: string): string {
  const raw = tidy(value);
  if (!raw) {
    return "";
  }

  if (raw.includes("linkedin.com/jobs/view/")) {
    return normalizeLinkedInJobUrl(raw);
  }

  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase().endsWith("linkedin.com") && /\/jobs(?:-tracker)?\/?|\/jobs\/collections\//i.test(parsed.pathname)) {
      parsed.search = "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw;
  }
}

function isProtectedAttachedTabUrl(value: string): boolean {
  if (!value || value === "about:blank") {
    return false;
  }

  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "mail.google.com" ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      parsed.protocol === "chrome:" ||
      parsed.protocol === "chrome-extension:"
    );
  } catch {
    return /mail\.google\.com|localhost|127\.0\.0\.1|chrome:|chrome-extension:/i.test(value);
  }
}

function shouldCloseAttachedAutomationTab(url: string, keepUrls: Set<string>): boolean {
  const normalized = normalizeAttachedTabKeepUrl(url);
  if (normalized && keepUrls.has(normalized)) {
    return false;
  }

  if (!url || url === "about:blank" || /^chrome:\/\/omnibox-popup/i.test(url)) {
    return true;
  }

  if (/^https:\/\/accounts\.google\.com\/.*(?:signin|oauth|accountchooser)/i.test(url)) {
    return true;
  }

  if (isProtectedAttachedTabUrl(url)) {
    return false;
  }

  if (isLinkedInUrl(url)) {
    if (/\/jobs-tracker\/?|\/jobs\/collections\//i.test(url)) {
      return true;
    }

    return /\/jobs\/view\/|\/safety\/go\/?|\/jobs\//i.test(url);
  }

  return (
    isLikelyApplicationFormUrl(url) ||
    /successfactors|workdayjobs|myworkdayjobs|greenhouse|ashbyhq|lever\.co|taleo|icims|smartrecruiters|jobvite|oraclecloud|phenompeople|pinpointhq|jobs\.aa\.com/i.test(
      url,
    )
  );
}

export async function pruneAttachedApplicationTabs(options: { keepUrls?: string[] } = {}): Promise<number> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const keepUrls = new Set(
      (options.keepUrls ?? [])
        .map((url) => normalizeAttachedTabKeepUrl(url))
        .filter((url): url is string => Boolean(url)),
    );
    const [context] = browser.contexts();
    const firstKeepUrl = [...keepUrls].find((url) => /^https?:\/\//i.test(url));
    if (context && firstKeepUrl) {
      const hasKeepPage = context
        .pages()
        .some((page) => !page.isClosed() && keepUrls.has(normalizeAttachedTabKeepUrl(safePageUrl(page))));
      if (!hasKeepPage) {
        const keepPage = await context.newPage();
        await keepPage.goto(firstKeepUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
      }
    }

    let closedCount = 0;
    const keptNormalizedUrls = new Set<string>();

    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.isClosed()) {
          continue;
        }

        const url = safePageUrl(page);
        const normalized = normalizeAttachedTabKeepUrl(url);
        if (normalized && keepUrls.has(normalized) && !keptNormalizedUrls.has(normalized)) {
          keptNormalizedUrls.add(normalized);
          continue;
        }

        const isDuplicateKeptTab = Boolean(normalized && keepUrls.has(normalized));
        if (!isDuplicateKeptTab && !shouldCloseAttachedAutomationTab(url, keepUrls)) {
          continue;
        }

        const closed = await Promise.race([
          page
            .close({ runBeforeUnload: false })
            .then(() => true)
            .catch(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500)),
        ]);
        if (closed) {
          closedCount += 1;
        }
      }
    }

    return closedCount;
  } finally {
    await disconnectAttachedBrowser(browser);
  }
}

async function withAttachedPage<T>(callback: (page: Page, browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    for (const context of browser.contexts()) {
      installSafeDialogHandlers(context);
    }
    const page = await getAttachedPage(browser);
    installSafeDialogHandler(page);
    return await callback(page, browser);
  } finally {
    await disconnectAttachedBrowser(browser);
  }
}

async function withNewAttachedPage<T>(callback: (page: Page, browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    for (const context of browser.contexts()) {
      installSafeDialogHandlers(context);
    }
    const [context] = browser.contexts();
    if (!context) {
      throw new Error("No browser contexts were found on the attached Chrome session.");
    }

    const page = await context.newPage();
    installSafeDialogHandler(page);
    return await callback(page, browser);
  } finally {
    await disconnectAttachedBrowser(browser);
  }
}

async function withAttachedFormPage<T>(callback: (page: Page, browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    for (const context of browser.contexts()) {
      installSafeDialogHandlers(context);
    }
    const page = await getAttachedFormPage(browser);
    installSafeDialogHandler(page);
    return await callback(page, browser);
  } finally {
    await disconnectAttachedBrowser(browser);
  }
}

async function disconnectAttachedBrowser(browser: Browser): Promise<void> {
  await Promise.race([
    browser.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

function tidy(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function safePageUrl(page: Page, fallback = ""): string {
  try {
    return page.isClosed() ? fallback : page.url();
  } catch {
    return fallback;
  }
}

function isLinkedInUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
  } catch {
    return /linkedin\.com/i.test(value);
  }
}

function isWorkdayApplicationUrl(value: string): boolean {
  return /\/apply(?:\/|$)|\/applyManually(?:\/|$)/i.test(value);
}

function isHostedGreenhouseUrl(value: string): boolean {
  const raw = tidy(value);
  if (!raw) {
    return false;
  }

  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname.includes("greenhouse") ||
      hostname.includes("toasttab.com") ||
      parsed.searchParams.has("gh_jid") ||
      parsed.searchParams.has("gh_src")
    );
  } catch {
    return /greenhouse|gh_jid=|gh_src=|toasttab\.com\/jobs\//i.test(raw);
  }
}

async function resolveHostedGreenhouseWorkerUrl(page: Page): Promise<string> {
  const currentUrl = page.url();
  try {
    const parsed = new URL(currentUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname.includes("greenhouse.io") || hostname.includes("greenhouse.com")) {
      return currentUrl;
    }
  } catch {
    if (/greenhouse/i.test(currentUrl)) {
      return currentUrl;
    }
  }

  const iframeSrc = tidy(
    await page
      .locator('iframe#grnhse_iframe, iframe[src*="job-boards.greenhouse.io/embed/job_app"], iframe[src*="boards.greenhouse.io"]')
      .first()
      .getAttribute("src", { timeout: 1500 })
      .catch(() => ""),
  );
  if (iframeSrc) {
    return new URL(iframeSrc, currentUrl).toString();
  }

  return "";
}

async function runResolvedSiteFormAutofill(
  page: Page,
  profile: Profile,
  options: AutofillExecutionOptions = {},
): Promise<AutofillResult> {
  const aaManualApply = await activateAmericanAirlinesManualApplyIfPresent(page);
  if (aaManualApply.advanced) {
    const nextAction = aaManualApply.filled[0] || "American Airlines manual apply";
    return buildAutofillResult(aaManualApply.filled, aaManualApply.skipped, nextAction, {
      stoppedBeforeSubmit: false,
      submitted: false,
      stopReason: nextAction,
    });
  }

  const siteKind = await detectApplicationSiteKind(page);
  if (siteKind === "greenhouse" || isHostedGreenhouseUrl(page.url())) {
    const greenhouseWorkerUrl = await resolveHostedGreenhouseWorkerUrl(page);
    if (greenhouseWorkerUrl) {
      return runAttachedHostedGreenhouseWorker(greenhouseWorkerUrl, profile, options).catch(() =>
        runCurrentSiteFormAutofill(page, profile, options),
      );
    }
  }

  return runCurrentSiteFormAutofill(page, profile, options);
}

function isAshbyUrl(value: string): boolean {
  const raw = tidy(value);
  if (!raw) {
    return false;
  }

  try {
    const parsed = new URL(raw);
    return parsed.hostname.toLowerCase().includes("ashbyhq.com");
  } catch {
    return /ashbyhq\.com/i.test(raw);
  }
}

async function runAttachedHostedGreenhouseWorker(
  url: string,
  profile: Profile,
  options: AutofillExecutionOptions = {},
): Promise<AutofillResult> {
  const payload = {
    repoRoot,
    cdpUrl,
    url,
    profile,
    submit: options.submit === true,
  };

  const { stdout } = await execFileAsync(
    process.execPath,
    [attachedHostedGreenhouseWorkerPath, JSON.stringify(payload)],
    {
      cwd: repoRoot,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    throw new Error("Hosted Greenhouse worker returned no output.");
  }

  return JSON.parse(lastLine) as AutofillResult;
}

function extractExternalApplyDestination(value: string, base = ""): string {
  const raw = tidy(value);
  if (!raw) {
    return "";
  }

  let current = raw;
  for (let index = 0; index < 3; index += 1) {
    let resolved: URL;
    try {
      resolved = base && index === 0 ? new URL(current, base) : new URL(current);
    } catch {
      return "";
    }

    const resolvedUrl = resolved.toString();
    if (!isLinkedInUrl(resolvedUrl)) {
      return resolvedUrl;
    }

    const embeddedUrl = tidy(
      resolved.searchParams.get("url") ||
        resolved.searchParams.get("dest") ||
        resolved.searchParams.get("destination") ||
        "",
    );
    if (!embeddedUrl) {
      return "";
    }

    current = embeddedUrl;
  }

  return "";
}

async function safePageTitle(page: Page): Promise<string> {
  if (page.isClosed()) {
    return "";
  }

  return tidy(await page.title().catch(() => ""));
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value || "").trim());
}

function shouldSkipLinkedInEasyApply(): boolean {
  return (
    isTruthyEnv(process.env.JAA_SKIP_LINKEDIN_EASY_APPLY) ||
    isTruthyEnv(process.env.JAA_LINKEDIN_EASY_APPLY_LIMIT_REACHED)
  );
}

function looksLikeMachineGeneratedFieldIdentifier(value: string): boolean {
  const cleaned = tidy(value);
  if (!cleaned) {
    return false;
  }

  return (
    cleaned.includes("[") ||
    /^[a-f0-9]{8,}$/i.test(cleaned) ||
    /^question[_-]/i.test(cleaned) ||
    /^form[_-]/i.test(cleaned) ||
    /^authenticity_token$/i.test(cleaned) ||
    /^container_id$/i.test(cleaned) ||
    /^pass_through/i.test(cleaned) ||
    /^iti-\d+__/i.test(cleaned)
  );
}

function cleanExtractedLabel(label: string): string {
  let cleaned = tidy(label)
    .replace(/\s*\*+\s*$/, "")
    .replace(/\(\s*(required|optional)\s*\)/gi, "")
    .replace(/\b[a-f0-9]{8,}\b/gi, "");
  if (/^(required|optional|mandatory)$/i.test(cleaned)) {
    return "";
  }
  if (cleaned.length >= 16 && cleaned.length % 2 === 0) {
    const midpoint = cleaned.length / 2;
    const firstHalf = cleaned.slice(0, midpoint);
    if (firstHalf === cleaned.slice(midpoint)) {
      cleaned = firstHalf;
    }
  }
  const splitters = ["Select...", "Choose...", "Choose one", "Please select"];

  for (const splitter of splitters) {
    const index = cleaned.indexOf(splitter);
    if (index <= 0) {
      continue;
    }

    const prefix = tidy(cleaned.slice(0, index));
    if (prefix) {
      cleaned = prefix;
      break;
    }
  }

  return tidy(cleaned);
}

function labelFromKnownFieldIdentifier(value: string): string {
  const raw = value.toLowerCase();
  const normalized = normalizeQuestionText(value);
  if (!normalized) {
    return "";
  }

  if (/\bresidence location 0\b/.test(normalized)) {
    return "Place of Residence Country . Required";
  }
  if (/\bresidence location 1\b/.test(normalized)) {
    return "Place of Residence State/Province/County . Required";
  }
  if (/\bresidence location 2\b/.test(normalized)) {
    return "Place of Residence Region";
  }
  if (/candidate_personal_info_address2\b/i.test(value)) {
    return "Address (line 2)";
  }
  if (/candidate_personal_info_address\b/i.test(value)) {
    return "Street Address (line 1) . Required";
  }
  if (/candidate_personal_info_firstname\b/i.test(value)) {
    return "First Name . Required";
  }
  if (/candidate_personal_info_middleinitial\b/i.test(value)) {
    return "Middle Name";
  }
  if (/candidate_personal_info_lastname\b/i.test(value)) {
    return "Last Name . Required";
  }
  if (/candidate_personal_info_city\b/i.test(value)) {
    return "City . Required";
  }
  if (/candidate_personal_info_zipcode\b/i.test(value)) {
    return "Zip/Postal Code . Required";
  }
  if (/candidate_personal_info_mobilephone\b/i.test(value)) {
    return "Primary Contact Number . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_c_previously_employed")) {
    return "Previously employed by Cognizant? . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_c_employee_id")) {
    return "If yes, Employee ID";
  }
  if (raw.includes("udfcandidatepersonalinfo_c_cpi_education_lvl")) {
    return "Highest Level of Education . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_willing_32_to_32_travel")) {
    return "Willing to travel short- and/or long-term? . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_willing_32_relocate_32_1")) {
    return "Would you be willing to relocate after your initial assignment ends?";
  }
  if (raw.includes("udfcandidatepersonalinfo_willing_32to_32relocate") || raw.includes("udfcandidatepersonalinfo_willing_32_to_32_relocate")) {
    return "Willing to relocate?";
  }
  if (raw.includes("udfcandidatepersonalinfo_possess_32_valid_32_work_32_visa")) {
    return "Are you legally authorized to work in United States of America ? . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_will_32_you_32_now_32_or_32_in_32_the_32_future_32_require_32_sponsorship")) {
    return "Will you now or in the future require sponsorship to work for Cognizant in the U.S.? . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_us_additional")) {
    return "Have you participated or managed projects involving Cognizant or interacted directly with Cognizant associates in their performance of services in the last 24 months of your employment? . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_employed_by_any_government_agency")) {
    return "Have you been employed by any government agency or department within the past 12 months (excluding military service)? . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_name_of_the_government_department")) {
    return "1. What is the name of the government department or agency that employed you? (enter N/A, if not applicable) . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_what_was_your_role")) {
    return "2. What was your role? (enter N/A, if not applicable) . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_post_government_employment")) {
    return "3. By virtue of this role, are there any restrictions on your post-government employment? . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_nature_and_length")) {
    return "3(a). If yes, please describe the nature and length of these restrictions. (enter N/A, if not applicable) . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_conceivable_intersection")) {
    return "4. Is there any conceivable intersection between this government department or agency and the Cognizant role for which you are applying, including any Cognizant clients you may support? . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_please_describe")) {
    return "4(a). If yes, please describe. (enter N/A, if not applicable) . Required";
  }
  if (raw.includes("udfcandidatepersonalinfo_candidate_consent")) {
    return "I provide my consent to receiving information about future job opportunities, recruitment activities, business developments and events from Cognizant via email and SMS, from which I can unsubscribe at any time . Required";
  }
  if (raw.includes("dv_cs_education_institution")) {
    return "Institution . Required";
  }
  if (raw.includes("dv_cs_education_program")) {
    return "Program . Required";
  }
  if (raw.includes("udfeducation_c_education_lvl")) {
    return "Education Level . Required";
  }
  if (raw.includes("dv_cs_experience_currentemployer")) {
    return "Current Job";
  }
  if (raw.includes("dv_cs_experience_employer")) {
    return "Employer . Required";
  }
  if (raw.includes("udfexperience_c_wkexp_job_title")) {
    return "Job Title . Required";
  }
  if (raw.includes("dv_cs_experience_begindate")) {
    return "Start Date . Required";
  }
  if (raw.includes("dv_cs_experience_enddate")) {
    return "End Date . Required";
  }
  if (raw.includes("diversityblock") && /-0-questionsinglelist$/i.test(value)) {
    return "Ethnicity/Race . Required";
  }
  if (raw.includes("diversityblock") && /-1-questionsinglelist$/i.test(value)) {
    return "Gender . Required";
  }
  if (raw.includes("diversityblock") && /-2-questionsinglelist$/i.test(value)) {
    return "Veteran Status . Required";
  }
  if (/\blogin name\d*\b|\buser name\b|\busername\b/.test(normalized)) {
    return "User Name";
  }
  if (/\bpassword confirm\b|\bconfirm password\b|\bre enter password\b/.test(normalized)) {
    return "Re-enter Password";
  }
  if (/\blogin password\b|\bpassword\b/.test(normalized)) {
    return "Password";
  }
  if (/\bemail confirm\b|\bconfirm email\b|\bre enter email\b/.test(normalized)) {
    return "Re-enter Email Address";
  }
  if (/\bemail\b/.test(normalized)) {
    return "Email Address";
  }

  return "";
}

function shouldDeferRequiredValidation(question: FormQuestion): boolean {
  const normalized = normalizeQuestionText(question.label);
  return (
    /\bplace of residence\b/.test(normalized) ||
    /\b(text entity list form component|easy apply form element|multiple choice)\b/.test(normalized) ||
    /\bsection 503 disability status\b/.test(normalized) ||
    /\bself attestation is required\b/.test(normalized)
  );
}

function refineFieldLabelFromIdentifier(label: string, identifier: string): string {
  const knownIdentifierLabel = labelFromKnownFieldIdentifier(identifier);
  if (
    knownIdentifierLabel &&
    (/residence.?location.?[012]/i.test(identifier) ||
      /candidate_personal_info|udfcandidatepersonalinfo|dv_cs_education|dv_cs_experience|udfeducation|udfexperience|diversityblock|questionsinglelist/i.test(identifier) ||
      /candidate_personal_info|udfcandidatepersonalinfo|dv_cs_education|dv_cs_experience|udfeducation|udfexperience|diversityblock|questionsinglelist|_32_|_45_|_46_|_47_|_63_/i.test(label))
  ) {
    return knownIdentifierLabel;
  }

  return label || knownIdentifierLabel;
}

function isKnownRequiredFieldIdentifier(value: string): boolean {
  return (
    /dialogTemplate-dialogForm/i.test(value) &&
    /(login-name\d*|login-password|userName|passwordConfirm|emailConfirm|(?:^|-)password(?:$|-)|(?:^|-)email(?:$|-))/i.test(
      value,
    )
  );
}

function resolveRepoPath(candidatePath: string): string {
  return path.isAbsolute(candidatePath) ? candidatePath : path.resolve(repoRoot, candidatePath);
}

async function canReadFile(candidatePath: string): Promise<boolean> {
  const normalized = candidatePath.trim();
  if (!normalized) {
    return false;
  }

  try {
    await access(resolveRepoPath(normalized), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExistingFilePath(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (await canReadFile(candidate)) {
      return resolveRepoPath(candidate);
    }
  }

  return "";
}

async function findDocumentFallback(kind: "resume" | "coverLetter"): Promise<string> {
  const searchRoots = [repoRoot, path.join(repoRoot, "data")];
  const filePattern = kind === "resume" ? /(resume|cv)/i : /(cover|motivation)/i;
  const allowedExtensions = new Set([".pdf", ".doc", ".docx", ".txt"]);
  const matches: string[] = [];

  for (const searchRoot of searchRoots) {
    const entries = await readdir(searchRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(extension) || !filePattern.test(entry.name)) {
        continue;
      }

      matches.push(path.join(searchRoot, entry.name));
    }
  }

  return matches[0] ?? "";
}

async function resolveResumeFilePath(profile: Profile): Promise<string> {
  const explicit = await resolveExistingFilePath([
    profile.resumeFilePath,
    process.env.JAA_RESUME_FILE_PATH || "",
  ]);
  if (explicit) {
    return explicit;
  }

  return findDocumentFallback("resume");
}

async function resolveCoverLetterFilePath(profile: Profile): Promise<string> {
  const explicit = await resolveExistingFilePath([
    profile.coverLetterFilePath,
    process.env.JAA_COVER_LETTER_FILE_PATH || "",
  ]);
  if (explicit) {
    return explicit;
  }

  return findDocumentFallback("coverLetter");
}

function inferApplicationSiteKind(url: string): ApplicationSiteKind {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (
      hostname.includes("workday") ||
      hostname.includes("myworkdayjobs.com") ||
      hostname.includes("wd1.") ||
      hostname.includes("wd3.") ||
      hostname.includes("wd5.")
    ) {
      return "workday";
    }
    if (hostname.includes("greenhouse")) {
      return "greenhouse";
    }
    if (hostname.includes("lever.co")) {
      return "lever";
    }
    if (hostname.includes("ashbyhq.com")) {
      return "ashby";
    }
    if (hostname.includes("taleo.net")) {
      return "taleo";
    }
    if (hostname.includes("hirebridge.com")) {
      return "hirebridge";
    }
    if (hostname.includes("talemetry.com")) {
      return "talemetry";
    }
    if (hostname.includes("smartrecruiters.com") || hostname.includes("smartr.me")) {
      return "smartrecruiters";
    }
    if (hostname.includes("workable.com")) {
      return "workable";
    }
    if (hostname.includes("recruitingbypaycor.com") || hostname.includes("paycor.com")) {
      return "paycor";
    }
    if (hostname.includes("ats.rippling.com")) {
      return "rippling";
    }
    if (
      hostname.includes("ultipro.com") ||
      hostname.includes("ukg.com") ||
      hostname.includes("ukgpro.com")
    ) {
      return "ukg";
    }
    if (hostname.includes("successfactors")) {
      return "successfactors";
    }
    if (
      hostname.includes("phenompeople") ||
      hostname === "careers.humana.com" ||
      hostname === "jobs.bnsf.com" ||
      hostname === "jobs.sutterhealth.org"
    ) {
      return "phenom";
    }
    if (hostname.includes("oraclecloud.com") && /\/hcmUI\/CandidateExperience\//i.test(new URL(url).pathname)) {
      return "oraclehcm";
    }
  } catch {
    return "generic";
  }

  return "generic";
}

async function detectApplicationSiteKind(page: Page): Promise<ApplicationSiteKind> {
  const fromUrl = inferApplicationSiteKind(page.url());
  if (fromUrl !== "generic") {
    return fromUrl;
  }

  const workdaySignals = [
    '[data-automation-id="jobApplication"]',
    '[data-automation-id="bottom-navigation-next-button"]',
    '[data-automation-id="formField"]',
  ];
  for (const selector of workdaySignals) {
    if ((await page.locator(selector).count().catch(() => 0)) > 0) {
      return "workday";
    }
  }

  if (
    (await page
      .locator(
        '#rcmJobApplicationCtr, input[name="career_ns"][value="job_application"], .RCMFormField.rcmFormQuestionElement, .rcmFormQuestionLabel, [id$="_submitBtn"], [id$="_expandAll"]',
      )
      .count()
      .catch(() => 0)) > 0 ||
    (await page.evaluate(() => Boolean((window as Window & { juic?: unknown }).juic)).catch(() => false))
  ) {
    return "successfactors";
  }

  if (
    page.url().includes("gh_jid=") ||
    (await page
      .locator(
        '#application, form[action*="greenhouse"], form[action*="form_submissions"], input[name^="form_submission[fields_attributes]"], textarea[name^="form_submission[fields_attributes]"], select[name^="form_submission[fields_attributes]"]',
      )
      .count()
      .catch(() => 0)) > 0
  ) {
    return "greenhouse";
  }

  if ((await page.locator('form[data-qa="application-form"], [data-qa="application-form"]').count().catch(() => 0)) > 0) {
    return "lever";
  }

  if (
    isAshbyUrl(page.url()) ||
    (await page
      .locator(
        '.ashby-application-form-field-entry, [class*="ashby-application-form-field-entry"], [class*="ashby-application-form-question-title"], a[href*="ashbyhq.com"], img[alt="Ashby"]',
      )
      .count()
      .catch(() => 0)) > 0
  ) {
    return "ashby";
  }

  if (
    (await page
      .locator('form[action*="rippling"], [data-testid^="checkbox-label-"], [data-testid="radio-label-sms_opt_in"]')
      .count()
      .catch(() => 0)) > 0
  ) {
    return "rippling";
  }

  if (
    (await page
      .locator(
        'input[id*="saveContinueCmd"], input[id*="StatementBeforeAuthentificationContent-ContinueButton"], input[id*="login-register"], input[id*="dialogTemplate-dialogForm-userName"], input[id*="ResumeUploadInputFile"]',
      )
      .count()
      .catch(() => 0)) > 0
  ) {
    return "taleo";
  }

  if (
    (await page
      .locator('form[action*="hirebridge" i], input[id*="quickapply" i], input[name*="quickapply" i], input[value*="Profile Submission" i]')
      .count()
      .catch(() => 0)) > 0
  ) {
    return "hirebridge";
  }

  if (
    (await page
      .locator(
        'button[name^="worklet_button"], #upload_resume_btn, input[id^="question_item"], input[id^="fieldV29ya2xld"]',
      )
      .count()
      .catch(() => 0)) > 0
  ) {
    return "talemetry";
  }

  if (
    (await page
      .locator('a#st-apply, oc-personal-information, oc-apply-with-resume, spl-input, spl-form-field')
      .count()
      .catch(() => 0)) > 0
  ) {
    return "smartrecruiters";
  }

  if (
    (await page
      .locator('form[data-ui="application-form"], button[data-ui="apply-button"], input[name="firstname"][required], input[name="lastname"][required]')
      .count()
      .catch(() => 0)) > 0
  ) {
    return "workable";
  }

  if (
    (await page
      .locator('iframe#gnewtonIframe, iframe[src*="recruitingbypaycor.com"], .gnewtonApplyBtn, #gnewotn_input_43')
      .count()
      .catch(() => 0)) > 0
  ) {
    return "paycor";
  }

  if (
    (await page
      .locator(
        'ukg-button[data-automation="btn-submit"], [data-automation="available-start-date-datepicker"], [data-automation="upload-file-input"], #ApplicantSource, #FirstName, #FamilyName',
      )
      .count()
      .catch(() => 0)) > 0
  ) {
    return "ukg";
  }

  if (
    isOracleHcmCandidateExperienceUrl(page.url()) ||
    (await page
      .locator(
        '.apply-flow-block, .apply-flow-navigation-train, button.cx-select-pill-section, input[name="lastName"][aria-required="true"]',
      )
      .count()
      .catch(() => 0)) > 0
  ) {
    return "oraclehcm";
  }

  if (
    /\/apply(?:thankyou)?\b/i.test(page.url()) ||
    (await page
      .locator(
        '#applicantSource, [id="cntryFields.firstName"], [id^="jsqData.ExternalApplication"], [id^="supplementaryJsqData."], [data-ph-at-id], [class^="phw-"], [class*=" phw-"]',
      )
      .count()
      .catch(() => 0)) > 0
  ) {
    return "phenom";
  }

  return "generic";
}

type ActionHandle = {
  label: string;
  locator: Locator;
};

type AutofillExecutionOptions = {
  submit?: boolean;
  maxSteps?: number;
  startUrl?: string;
  isolatedPage?: boolean;
};

function getPrimaryActionSelectors(siteKind: ApplicationSiteKind): string[] {
  return siteKind === "workday"
    ? [
        '[data-automation-id="click_filter"][aria-label="Create Account"]',
        '[data-automation-id="click_filter"][aria-label="Sign In"]',
        'button[data-automation-id="createAccountSubmitButton"]',
        'button[data-automation-id="signInSubmitButton"]',
        '[data-automation-id="pageFooterNextButton"]',
        '[data-automation-id="pageFooterContinueButton"]',
        '[data-automation-id="bottom-navigation-next-button"]',
        '[data-automation-id="bottom-navigation-save-button"]',
        '[data-automation-id="useMyLastApplication"]',
        'a[data-automation-id="useMyLastApplication"]',
        'button:has-text("Take Assessment")',
        'a:has-text("Take Assessment")',
        'button[data-automation-id="saveAndContinue"]',
        'button[data-automation-id="applyManually"]',
        'button:has-text("Create Account")',
        'button:has-text("Next")',
        'button:has-text("Continue")',
        'button:has-text("Review")',
        'button:has-text("Submit")',
        'button:has-text("Apply")',
      ]
    : siteKind === "lever"
      ? [
          'a:has-text("APPLY FOR THIS JOB")',
          'button:has-text("APPLY FOR THIS JOB")',
          'button:has-text("Submit your application")',
          'button:has-text("Submit application")',
          'button:has-text("Submit")',
        ]
      : siteKind === "ashby"
        ? [
            'button:has-text("Submit Application")',
            'button:has-text("Submit")',
            '[role="tab"]:has-text("Application")',
            'button:has-text("Apply for this job")',
            'button:has-text("Apply")',
          ]
        : siteKind === "taleo"
          ? [
              'input[type="button" i][value*="I Confirm" i]',
              'button:has-text("I Confirm")',
              'input[type="button" i][value*="New User" i]',
              'button:has-text("New User")',
              'input[type="button" i][value*="Register" i]',
              'button:has-text("Register")',
              'input[type="button" i][value*="Login" i]',
              'button:has-text("Login")',
              'input[type="button" i][value*="Save and Continue" i]',
              'button:has-text("Save and Continue")',
              'input[type="button" i][value*="Continue" i]',
              'button:has-text("Continue")',
              'input[type="button" i][value*="Review" i]',
              'button:has-text("Review")',
              'input[type="button" i][value*="Submit" i]',
              'button:has-text("Submit")',
            ]
          : siteKind === "talemetry"
            ? [
                'button[name="worklet_button_force_next"]',
                'button[name="worklet_button_next"]',
                'button:has-text("Next")',
                'button:has-text("Submit")',
              ]
            : siteKind === "hirebridge"
              ? [
                  'input[type="submit" i][value*="Next" i]',
                  'input[type="button" i][value*="Next" i]',
                  'button:has-text("Next")',
                  'input[type="submit" i][value*="Continue" i]',
                  'input[type="button" i][value*="Continue" i]',
                  'button:has-text("Continue")',
                  'input[type="submit" i][value*="Submit" i]',
                  'input[type="button" i][value*="Submit" i]',
                  'button:has-text("Submit")',
                  'input[type="submit" i][value*="Apply" i]',
                  'input[type="button" i][value*="Apply" i]',
                  'a:has-text("Apply")',
                  'button:has-text("Apply")',
                ]
              : siteKind === "smartrecruiters"
                ? [
                    'a#st-apply',
                    'a:has-text("I\'m interested")',
                    'a[href*="/oneclick-ui/"]',
                    'button.c-spl-button--primary',
                    'button:has-text("Next")',
                    'button:has-text("Continue")',
                    'button:has-text("Submit")',
                    'button:has-text("Submit application")',
                    'button:has-text("Apply")',
                  ]
                : siteKind === "workable"
                  ? [
                      'button[data-ui="apply-button"]',
                      'button[type="submit"]:has-text("Submit application")',
                      'button:has-text("Submit application")',
                    ]
                  : siteKind === "paycor"
                    ? [
                        "iframe#gnewtonIframe",
                        ".gnewtonApplyBtn",
                        "#gnewotn_input_43",
                        'input[type="button" i][value*="Next" i]',
                        'input[type="submit" i][value*="Next" i]',
                        'button:has-text("Next")',
                        'button:has-text("Submit")',
                      ]
                      : siteKind === "rippling"
                        ? [
                            'button:has-text("Apply now")',
                            'button[type="submit"]:has-text("Apply")',
                            'button:has-text("Apply")',
                          ]
                        : siteKind === "phenom"
                          ? [
                              'button[type="submit"]:has-text("Continue")',
                              'button[aria-label*="continue" i]',
                              'button:has-text("Continue")',
                              'a:has-text("Continue")',
                              'button:has-text("Next")',
                              'button:has-text("Review")',
                              'a[data-ph-at-id="apply-link"][href]',
                              'a[phw-tk="apply_click"][href]',
                              'a[href*="myworkdayjobs.com"]:has-text("Apply")',
                              'a[href*="/apply"]:has-text("Apply")',
                              'button:has-text("Apply Now")',
                              'a:has-text("Apply Now")',
                              'button:has-text("Submit")',
                              'button:has-text("Apply")',
                              'a:has-text("Apply")',
                            ]
                          : siteKind === "successfactors"
                            ? [
                                'span[role="button"][id$="_submitBtn"]:has-text("Submit")',
                                'button:has-text("Submit")',
                                'input[type="submit" i][value*="Submit" i]',
                                'a[role="button"]:has-text("Expand all sections")',
                                '[id$="_expandAll"]',
                                '#applyOption-top-manual',
                                'a[href*="portalcareer"]:has-text("Apply")',
                                'a[href*="sfcareer/jobreqcareer"]:has-text("Apply")',
                                'a.button.job-apply.top',
                                'a.job-apply',
                              ]
                          : siteKind === "ukg"
                            ? [
                                'ukg-button[data-automation="apply-now-button"]',
                                'ukg-button[data-automation="btn-submit"]',
                                'ukg-button:has-text("Save and continue")',
                                'button[data-automation="save-button"]:has-text("Save and continue")',
                                'button:has-text("Save and continue")',
                                'ukg-button:has-text("Submit")',
                              'button:has-text("Submit")',
                              'ukg-button:has-text("Continue")',
                              'button:has-text("Continue")',
                              'ukg-button#button-sign-in',
                              '#button-sign-in',
                              'ukg-button:has-text("Sign In")',
                              'ukg-button:has-text("Sign in")',
                              'button:has-text("Sign In")',
                              'button:has-text("Sign in")',
                              'ukg-button:has-text("Register")',
                              'button:has-text("Register")',
                              'ukg-button:has-text("Apply now")',
                              'button:has-text("Apply now")',
                                'ukg-button:has-text("Apply")',
                                'button:has-text("Apply")',
                              ]
                            : siteKind === "oraclehcm"
                              ? [
                                  'button.apply-flow-pagination__submit-button:has-text("Submit")',
                                  'button:has-text("Submit")',
                                  'button:has-text("Next")',
                                  'button:has-text("Apply Now")',
                                  'a:has-text("Apply Now")',
                                  'button:has-text("Apply")',
                                  'a:has-text("Apply")',
                                ]
      : [
          'button[aria-label*="next" i]',
          'button[aria-label*="continue" i]',
          'button[aria-label*="review" i]',
          'button[aria-label*="submit" i]',
          'button[aria-label*="apply" i]',
          'input[type="button" i][value*="next" i]',
          'input[type="button" i][value*="continue" i]',
          'input[type="button" i][value*="review" i]',
          'input[type="button" i][value*="submit" i]',
          'input[type="button" i][value*="apply" i]',
          'a[aria-label*="next" i]',
          'a[aria-label*="continue" i]',
          'a[aria-label*="review" i]',
          'a[aria-label*="submit" i]',
          'a[aria-label*="apply" i]',
          'button[aria-label*="save" i]',
          'input[type="button" i][value*="save" i]',
          'button:has-text("Next")',
          'button:has-text("Continue")',
          'button:has-text("Review")',
          'button:has-text("Send My Profile")',
          'button:has-text("SEND MY PROFILE")',
          'button:has-text("Submit")',
          'button:has-text("Apply")',
          'a:has-text("Next")',
          'a:has-text("Continue")',
          'a:has-text("Review")',
          'a:has-text("Submit")',
          'a:has-text("Apply")',
          'button:has-text("Save")',
          'a:has-text("Save")',
        ];
}

async function getActionLabel(locator: Locator): Promise<string> {
  return (
    tidy(await locator.textContent().catch(() => "")) ||
    tidy(await locator.getAttribute("value").catch(() => "")) ||
    tidy(await locator.getAttribute("aria-label").catch(() => "")) ||
    tidy(await locator.getAttribute("data-automation-id").catch(() => "")) ||
    tidy(await locator.getAttribute("name").catch(() => "")) ||
    tidy(await locator.getAttribute("id").catch(() => "")) ||
    "Action"
  );
}

function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function clickActionHandle(page: Page, action: ActionHandle): Promise<boolean> {
  const startingUrl = page.url();
  await action.locator.scrollIntoViewIfNeeded().catch(() => undefined);

  const attempts: Array<() => Promise<boolean>> = [
    async () => {
      const href = tidy(await action.locator.getAttribute("href").catch(() => ""));
      if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) {
        return false;
      }

      const targetUrl = new URL(href, page.url()).toString();
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return true;
    },
    () => action.locator.click({ timeout: 10_000 }).then(() => true).catch(() => false),
    () => action.locator.click({ timeout: 10_000, force: true }).then(() => true).catch(() => false),
    () =>
      action.locator
        .evaluate((node) => {
          (node as HTMLElement).click();
          return true;
        })
        .catch(() => false),
  ];

  const normalizedLabel = tidy(action.label);
  if (normalizedLabel) {
    const overlaySelector = `[data-automation-id="click_filter"][aria-label="${escapeCssAttributeValue(normalizedLabel)}"]`;
    attempts.splice(
      2,
      0,
      async () => {
        const overlay = page.locator(overlaySelector).first();
        if (!(await overlay.isVisible().catch(() => false))) {
          return false;
        }

        return (
          (await overlay.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
          (await overlay.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false))
        );
      },
    );
  }

  attempts.splice(
    3,
    0,
    async () => {
      const overlays = page.locator('[data-automation-id="click_filter"]');
      const count = await overlays.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const overlay = overlays.nth(index);
        if (!(await overlay.isVisible().catch(() => false))) {
          continue;
        }

        const clicked =
          (await overlay.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
          (await overlay.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
        if (clicked) {
          return true;
        }
      }

      return false;
    },
  );

  for (const attempt of attempts) {
    if (await attempt()) {
      return true;
    }
  }

  await page.waitForTimeout(1_000).catch(() => undefined);
  return page.url() !== startingUrl;
}

async function isLikelyJobAlertSignupAction(locator: Locator): Promise<boolean> {
  return locator
    .evaluate((node) => {
      const element = node as HTMLElement;
      const read = (value: unknown) =>
        String(value ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const attrs = (target: Element) =>
        [
          target.getAttribute("id"),
          target.getAttribute("class"),
          target.getAttribute("name"),
          target.getAttribute("aria-label"),
          target.getAttribute("data-ph-at-id"),
          target.getAttribute("action"),
          target.getAttribute("placeholder"),
          (target as HTMLInputElement).value,
        ]
          .map(read)
          .filter(Boolean)
          .join(" ");
      const descendantInputText = (target: Element) =>
        Array.from(target.querySelectorAll("input, textarea, button"))
          .map((input) => attrs(input))
          .filter(Boolean)
          .join(" ");
      const alertPattern =
        /\b(?:notifiedemail|notified email|job alerts?|job-alert|jobalert|job_alert|get notified|similar jobs?|set alert|talent community|talent network|email me jobs?|job notification)\b/i;
      const applicationPattern =
        /\b(?:submit application|application questions?|my information|my experience|resume|cover letter|voluntary disclosures?|self identify|work experience|education)\b/i;

      let current: HTMLElement | null = element;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const context = read([attrs(current), current.textContent, descendantInputText(current)].join(" "));
        if (!alertPattern.test(context)) {
          continue;
        }
        if (applicationPattern.test(context)) {
          continue;
        }
        return true;
      }

      return false;
    })
    .catch(() => false);
}

async function findVisibleAction(scope: LocatorScope, selectors: string[]): Promise<ActionHandle | null> {
  for (const selector of selectors) {
    const matches = scope.locator(selector);
    const count = await matches.count().catch(() => 0);

    for (let index = 0; index < Math.min(count, 3); index += 1) {
      const locator = matches.nth(index);
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      if (await isLikelyJobAlertSignupAction(locator)) {
        continue;
      }

      return {
        label: await getActionLabel(locator),
        locator,
      };
    }
  }

  return null;
}

async function getPrimaryActionText(page: Page, siteKind: ApplicationSiteKind): Promise<string> {
  const action = await findVisibleAction(page, getPrimaryActionSelectors(siteKind));
  return action?.label || "No primary action detected";
}

async function getApplicationStageText(page: Page, siteKind: ApplicationSiteKind): Promise<string> {
  const selectors =
    siteKind === "workday"
      ? [
          '[data-automation-id="pageHeader"]',
          '[data-automation-id="progressBar"] [aria-current="true"]',
          '[data-automation-id="progressBar"] [aria-current="step"]',
          '[aria-current="step"]',
          'h2[data-automation-id]',
          'h2',
          'h1',
        ]
      : siteKind === "lever"
        ? [
            ".main-header-text",
            ".posting-headline h2",
            ".posting-categories",
            "h2",
            "h1",
          ]
        : siteKind === "ashby"
          ? [
              '[role="tab"][aria-selected="true"]',
              '.ashby-application-form-question-title',
              'h2',
              'h1',
            ]
          : siteKind === "taleo"
            ? [
                "h1",
                ".pageTitle",
                "#mainContent h1",
                '[id*="progress"] [class*="current"]',
              ]
            : siteKind === "talemetry"
              ? [
                  "h1",
                  '[class*="worklet"] h1',
                  '[class*="Worklet"] h1',
                  "main h1",
                ]
              : siteKind === "phenom"
                ? [
                    '[aria-current="step"]',
                    '.active',
                    '[class*="step"] [class*="active"]',
                    "main h1",
                    "main h2",
                    "h1",
                    "h2",
                  ]
                : siteKind === "successfactors"
                  ? [
                      "#rcmJobApplicationCtr h1",
                      "#rcmJobApplicationCtr h2",
                      ".rcmFormQuestionLabel",
                      '[aria-live="polite"]',
                      "h1",
                      "h2",
                    ]
                : siteKind === "oraclehcm"
                  ? [
                      ".apply-flow-navigation-train__block-link--active",
                      ".apply-flow-block__title",
                      "h1",
                      "h2",
                    ]
      : [
          '[aria-live="polite"]',
          '.jobs-easy-apply-content p',
          'h2',
          'h1',
        ];

  for (const selector of selectors) {
    const text = tidy(await page.locator(selector).first().textContent({ timeout: 750 }).catch(() => ""));
    if (text) {
      return text;
    }
  }

  return siteKind === "workday"
    ? "Workday page inspected"
    : siteKind === "ashby"
      ? "Ashby page inspected"
      : siteKind === "taleo"
        ? "Taleo page inspected"
        : siteKind === "talemetry"
          ? "Talemetry page inspected"
          : siteKind === "phenom"
            ? "Phenom page inspected"
            : siteKind === "successfactors"
              ? "SuccessFactors page inspected"
            : siteKind === "oraclehcm"
              ? "Oracle HCM page inspected"
        : "Application page inspected";
}

async function countVisibleApplicationFields(page: Page): Promise<number> {
  const selectors = [
    'input:not([type="hidden"])',
    "textarea",
    "select",
    '[role="combobox"]',
    'input[role="combobox"]',
    'fieldset, [role="radiogroup"], [data-automation-id="radioGroup"]',
  ];

  let total = 0;
  for (const selector of selectors) {
    const visibleCount = await page
      .locator(selector)
      .evaluateAll((nodes) => {
        let count = 0;
        for (const node of nodes) {
          const element = node as HTMLElement;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
            continue;
          }

          count += 1;
          if (count >= 10) {
            break;
          }
        }
        return count;
      })
      .catch(() => 0);
    total += visibleCount;
    if (total > 0) {
      return total;
    }
  }
  return total;
}

async function countVisiblePasswordFields(page: Page): Promise<number> {
  const fields = page.locator('input[type="password"]');
  const count = await fields.count().catch(() => 0);
  let visibleCount = 0;

  for (let index = 0; index < count; index += 1) {
    if (await fields.nth(index).isVisible().catch(() => false)) {
      visibleCount += 1;
    }
  }

  return visibleCount;
}

async function waitForLinkedInJobPageReady(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);

  if (isLinkedInAuthRedirect(page)) {
    throw new Error(
      "LinkedIn redirected to login, authwall, or a checkpoint challenge. Resolve it in the attached Chrome window, then rerun the command.",
    );
  }

  if (await detectLinkedInSubmittedStatusText(page)) {
    return;
  }

  const readySelectors = [
    "h1",
    ".jobs-details-top-card__job-title",
    ".job-details-jobs-unified-top-card__job-title",
    "button.jobs-apply-button",
    'a[aria-label*="apply" i]',
    'button[aria-label*="easy apply" i]',
  ];

  for (let attempt = 0; attempt < 12; attempt += 1) {
    for (const selector of readySelectors) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      const text =
        tidy(await locator.textContent().catch(() => "")) ||
        tidy(await locator.getAttribute("aria-label").catch(() => ""));
      if (text) {
        await page.waitForTimeout(600).catch(() => undefined);
        await expandLinkedInDescription(page).catch(() => undefined);
        return;
      }
    }

    if (isLinkedInAuthRedirect(page)) {
      throw new Error(
        "LinkedIn redirected to login, authwall, or a checkpoint challenge. Resolve it in the attached Chrome window, then rerun the command.",
      );
    }

    await page.waitForTimeout(500).catch(() => undefined);
  }

  await expandLinkedInDescription(page).catch(() => undefined);
}

async function waitForLinkedInApplyControls(page: Page): Promise<void> {
  if (isLinkedInAuthRedirect(page)) {
    throw new Error(
      "LinkedIn redirected to login, authwall, or a checkpoint challenge. Resolve it in the attached Chrome window, then rerun the command.",
    );
  }

  const selectors = [
    'button[aria-label*="easy apply" i]',
    "button.jobs-apply-button",
    'a[aria-label*="on company website" i]',
    'a[aria-label*="on employer website" i]',
    'a[href]:has-text("Apply")',
    'button:has-text("Apply")',
  ];

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await detectLinkedInSubmittedStatusText(page)) {
      return;
    }

    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        return;
      }
    }

    if (isLinkedInAuthRedirect(page)) {
      throw new Error(
        "LinkedIn redirected to login, authwall, or a checkpoint challenge. Resolve it in the attached Chrome window, then rerun the command.",
      );
    }

    await page.waitForTimeout(500).catch(() => undefined);
  }
}

async function isWorkdayCreateAccountGate(page: Page): Promise<boolean> {
  const header = tidy(
    await page
      .locator('[data-automation-id="pageHeader"], h1, h2')
      .first()
      .textContent({ timeout: 750 })
      .catch(() => ""),
  );
  const primaryAction = await getPrimaryActionText(page, "workday");
  const passwordCount = await countVisiblePasswordFields(page);

  return /create account/i.test(header) || /create account/i.test(primaryAction) || passwordCount >= 2;
}

async function isWorkdaySignInGate(page: Page): Promise<boolean> {
  const header = tidy(
    await page
      .locator('[data-automation-id="pageHeader"], h1, h2')
      .first()
      .textContent({ timeout: 750 })
      .catch(() => ""),
  );
  const primaryAction = await getPrimaryActionText(page, "workday");
  const passwordCount = await countVisiblePasswordFields(page);
  const currentPasswordFieldVisible = await page
    .locator('input[autocomplete="current-password"], input[data-automation-id="password"]')
    .evaluateAll((nodes) =>
      nodes.some((node) => {
        const element = node as HTMLElement;
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      }),
    )
    .catch(() => false);

  return (
    /sign in/i.test(header) ||
    /sign in/i.test(primaryAction) ||
    currentPasswordFieldVisible ||
    (passwordCount >= 1 && passwordCount < 2)
  );
}

async function triggerActionOrFollowHref(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      continue;
    }

    const beforeUrl = page.url();
    const href = tidy(await locator.getAttribute("href").catch(() => ""));
    const targetUrl = href ? new URL(href, beforeUrl).toString() : "";
    const clicked = await locator.click({ timeout: 10000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(1200).catch(() => undefined);

    if (page.url() !== beforeUrl) {
      return true;
    }

    if (targetUrl && targetUrl !== beforeUrl) {
      const navigated = await page
        .goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
        .then(() => true)
        .catch(() => false);
      if (navigated) {
        await page.waitForTimeout(1500).catch(() => undefined);
        return true;
      }
    }

    if (clicked && (await countVisibleApplicationFields(page)) > 0) {
      return true;
    }
  }

  return false;
}

function getPhenomApplyActionSelectors(): string[] {
  return [
    'a[data-ph-at-id="apply-link"][href]',
    'a[phw-tk="apply_click"][href]',
    'a[href*="myworkdayjobs.com"]:has-text("Apply")',
    'a[href*="/apply"]:has-text("Apply")',
    'button:has-text("Apply Now")',
    'a:has-text("Apply Now")',
    'button:has-text("Apply")',
    'a:has-text("Apply")',
  ];
}

async function hasPhenomApplicationFormSignals(page: Page): Promise<boolean> {
  return (
    (await page
      .locator(
        '#applicantSource, [id="cntryFields.firstName"], [id="privacyPolicy"], [id^="jsqData.ExternalApplication"], [name^="jsqData.ExternalApplication"], [id^="supplementaryJsqData."], [name^="supplementaryJsqData."], [id^="personalData."], [name^="personalData."]',
      )
      .count()
      .catch(() => 0)) > 0
  );
}

async function continueWorkdayWithExistingSessionIfAvailable(page: Page): Promise<boolean> {
  if (!isTruthyEnv(process.env.JAA_WORKDAY_REUSE_SESSION)) {
    return false;
  }

  if (!(await isWorkdayCreateAccountGate(page))) {
    return false;
  }

  const beforeUrl = page.url();
  const moved = await triggerActionOrFollowHref(page, [
    'a[data-automation-id*="signIn"]',
    'button[data-automation-id*="signIn"]',
    'a:has-text("Sign In")',
    'button:has-text("Sign In")',
  ]);
  if (!moved) {
    return false;
  }

  await page.waitForTimeout(1800).catch(() => undefined);
  const landedOnAuthGate =
    (await isWorkdayCreateAccountGate(page)) || (await isWorkdaySignInGate(page));

  if (landedOnAuthGate) {
    await page.goto(beforeUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
    await page.waitForTimeout(1200).catch(() => undefined);
    return false;
  }

  return true;
}

async function openWorkdayCreateAccountPane(page: Page): Promise<boolean> {
  const createAccountFieldsVisible =
    (await page.locator('input[data-automation-id="verifyPassword"]').first().isVisible().catch(() => false)) ||
    (await page.locator('input[data-automation-id="createAccountCheckbox"]').first().isVisible().catch(() => false));
  if (createAccountFieldsVisible) {
    return true;
  }

  const selectors = [
    'button[data-automation-id="createAccountLink"]',
    'a[data-automation-id="createAccountLink"]',
    'button:has-text("Create Account")',
    'a:has-text("Create Account")',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible().catch(() => false))) {
      continue;
    }

    const clicked =
      (await locator.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
      (await locator.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
    if (!clicked) {
      continue;
    }

    await page.waitForTimeout(1_000).catch(() => undefined);
    if (
      (await page.locator('input[data-automation-id="verifyPassword"]').first().isVisible().catch(() => false)) ||
      (await page.locator('input[data-automation-id="createAccountCheckbox"]').first().isVisible().catch(() => false))
    ) {
      return true;
    }
  }

  return false;
}

async function enterWorkdayApplicationFlowIfNeeded(page: Page): Promise<boolean> {
  let advanced = false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await acceptCookieBannerIfPresent(page).catch(() => undefined);
    const visibleFields = await countVisibleApplicationFields(page);
    if (visibleFields > 0) {
      if (await continueWorkdayWithExistingSessionIfAvailable(page)) {
        advanced = true;
        continue;
      }
      return advanced;
    }

    const currentUrl = page.url().replace(/\/+$/, "");
    const directTargets = currentUrl.includes("/apply")
      ? currentUrl.includes("/applyManually") || currentUrl.includes("/apply/useMyLastApplication")
        ? []
        : [`${currentUrl}/useMyLastApplication`, `${currentUrl}/applyManually`]
      : [`${currentUrl}/apply/useMyLastApplication`, `${currentUrl}/applyManually`, `${currentUrl}/apply`];
    for (const targetUrl of directTargets) {
      const navigated = await page
        .goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
        .then(() => true)
        .catch(() => false);
      if (!navigated) {
        continue;
      }

      advanced = true;
      await page.waitForTimeout(1800).catch(() => undefined);
      break;
    }

    if ((await countVisibleApplicationFields(page)) > 0) {
      if (await continueWorkdayWithExistingSessionIfAvailable(page)) {
        advanced = true;
        continue;
      }
      return true;
    }

    const selectors = page.url().includes("/apply")
      ? [
          'a[data-automation-id="useMyLastApplication"]',
          '[data-automation-id="useMyLastApplication"]',
          'a[data-automation-id="applyManually"]',
          '[data-automation-id="applyManually"]',
          'button:has-text("Apply")',
          'a:has-text("Apply")',
          'button:has-text("Apply Manually")',
          'a:has-text("Apply Manually")',
          'button:has-text("Continue")',
          'a:has-text("Continue")',
        ]
      : [
          'a[data-automation-id="adventureButton"]',
          '[data-automation-id="adventureButton"]',
          'button:has-text("Apply")',
          'a:has-text("Apply")',
          'button:has-text("Continue")',
          'a:has-text("Continue")',
        ];

    const moved = await triggerActionOrFollowHref(page, selectors);
    if (!moved) {
      return advanced;
    }

    advanced = true;
    await page.waitForTimeout(1800).catch(() => undefined);
  }

  return advanced;
}

async function acceptCookieBannerIfPresent(page: Page): Promise<boolean> {
  const acceptors = [
    "#cookie-acknowledge",
    "#truste-consent-button",
    'button[id*="truste-consent" i]:has-text("Ok")',
    'button:has-text("Accept Cookies")',
    '[role="button"]:has-text("Accept Cookies")',
    'button:has-text("Accept")',
    'button:has-text("I accept")',
    'button:has-text("I Accept")',
    'button:has-text("OK")',
    'button:has-text("Ok")',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    '[role="button"]:has-text("I accept")',
    '[role="button"]:has-text("I Accept")',
    '[role="button"]:has-text("Accept")',
  ];

  const locator = await findFirstVisibleAction(page, acceptors);
  if (!locator) {
    return false;
  }

  const clicked = await locator
    .click({ timeout: 5000, force: true })
    .then(() => true)
    .catch(() => false);
  if (clicked) {
    await page.waitForTimeout(1000);
  }
  return clicked;
}

async function enterLeverApplicationFlowIfNeeded(page: Page): Promise<boolean> {
  const visibleFields = await countVisibleApplicationFields(page);
  if (visibleFields > 0) {
    return false;
  }

  await acceptCookieBannerIfPresent(page).catch(() => undefined);
  const locator = await findFirstVisibleAction(page, [
    'a:has-text("APPLY FOR THIS JOB")',
    'button:has-text("APPLY FOR THIS JOB")',
    'a:has-text("Apply for this job")',
    'button:has-text("Apply for this job")',
  ]);
  if (!locator) {
    return false;
  }

  const clicked = await locator.click({ timeout: 10000 }).then(() => true).catch(() => false);
  if (!clicked) {
    return false;
  }

  await page.waitForTimeout(1800);
  return true;
}

async function enterAshbyApplicationFlowIfNeeded(page: Page): Promise<boolean> {
  const visibleFields = await countVisibleApplicationFields(page);
  if (visibleFields > 0) {
    return false;
  }

  await acceptCookieBannerIfPresent(page).catch(() => undefined);
  const moved = await triggerActionOrFollowHref(page, [
    '[role="tab"]:has-text("Application")',
    'button:has-text("Application")',
    'a:has-text("Application")',
    'button:has-text("Apply for this job")',
    'a:has-text("Apply for this job")',
    'button:has-text("Apply")',
    'a:has-text("Apply")',
  ]);
  if (!moved) {
    return false;
  }

  await page.waitForTimeout(1800).catch(() => undefined);
  return true;
}

function isCargillJobDetailUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return (
      (hostname === "careers.cargill.com" || hostname === "jobs.cargill.com") &&
      (/\/job\//i.test(parsed.pathname) || /\/en\/job\//i.test(parsed.pathname))
    );
  } catch {
    return /(?:careers|jobs)\.cargill\.com\/.*\/job\//i.test(value);
  }
}

async function enterCargillApplicationFlowIfNeeded(page: Page): Promise<boolean> {
  if (!isCargillJobDetailUrl(page.url())) {
    return false;
  }

  await acceptCookieBannerIfPresent(page).catch(() => undefined);
  const startingUrl = page.url();
  const movedFromDirectApply = await triggerActionOrFollowHref(page, [
    'a.button.job-apply.top[href]',
    'a.job-apply[href]',
    'a[href*="sfcareer/jobreqcareer"]',
    'a[href*="portalcareer"]',
    'a:has-text("Apply now")',
    'a:has-text("Apply Now")',
  ]);
  if (movedFromDirectApply) {
    return true;
  }

  const dropdownClicked = await clickFirstVisible(page, [
    'button.dropdown-toggle:has-text("Apply")',
    '.job-apply button.dropdown-toggle',
    'button:has-text("Apply now")',
    'button:has-text("Apply Now")',
  ]);
  if (dropdownClicked) {
    await page.waitForTimeout(800).catch(() => undefined);
  }

  const manualApply = page.locator('#applyOption-top-manual, a:has-text("Apply manually"), a:has-text("Apply Manually")').first();
  if (await manualApply.isVisible().catch(() => false)) {
    const href = tidy(await manualApply.getAttribute("href").catch(() => ""));
    const clicked = await manualApply.click({ timeout: 10_000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(1_200).catch(() => undefined);
    if (page.url() !== startingUrl) {
      return true;
    }
    if (href) {
      const navigated = await page
        .goto(new URL(href, startingUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (navigated) {
        await page.waitForTimeout(1_500).catch(() => undefined);
        return true;
      }
    }
    return clicked;
  }

  return page.url() !== startingUrl;
}

async function enterGenericApplicationFlowIfNeeded(page: Page): Promise<boolean> {
  const enteredCargill = await enterCargillApplicationFlowIfNeeded(page);
  if (enteredCargill) {
    return true;
  }

  const visibleFields = await countVisibleApplicationFields(page);
  if (visibleFields > 0) {
    return false;
  }

  await acceptCookieBannerIfPresent(page).catch(() => undefined);
  const moved = await triggerActionOrFollowHref(page, [
    'a:has-text("Apply for this Job")',
    'button:has-text("Apply for this Job")',
    'a:has-text("Apply for this job")',
    'button:has-text("Apply for this job")',
    'a:has-text("Start application")',
    'button:has-text("Start application")',
    'a:has-text("Start your application")',
    'button:has-text("Start your application")',
    'a:has-text("Continue application")',
    'button:has-text("Continue application")',
    'a:has-text("Apply")',
    'button:has-text("Apply")',
  ]);
  if (!moved) {
    return false;
  }

  await page.waitForTimeout(1800).catch(() => undefined);
  return true;
}

async function enterPhenomApplicationFlowIfNeeded(page: Page): Promise<boolean> {
  if (/\/apply(?:thankyou)?\b/i.test(page.url())) {
    return false;
  }

  if (await hasPhenomApplicationFormSignals(page)) {
    return false;
  }

  await acceptCookieBannerIfPresent(page).catch(() => undefined);
  const moved = await triggerActionOrFollowHref(page, getPhenomApplyActionSelectors());
  if (!moved) {
    return false;
  }

  await page.waitForTimeout(1800).catch(() => undefined);
  return true;
}

async function isTaleoPrivacyGate(page: Page): Promise<boolean> {
  if ((await detectApplicationSiteKind(page)) !== "taleo") {
    return false;
  }

  const confirmVisible = await page
    .locator('input[type="button" i][value*="I Confirm" i], button:has-text("I Confirm")')
    .first()
    .isVisible()
    .catch(() => false);
  if (confirmVisible) {
    return true;
  }

  const title = tidy(await page.title().catch(() => ""));
  return /privacy notice|privacy agreement/i.test(title) || /privacyagreement/i.test(page.url());
}

async function acceptTaleoPrivacyNotice(page: Page): Promise<boolean> {
  if (!(await isTaleoPrivacyGate(page))) {
    return false;
  }

  const clicked = await clickFirstVisible(page, [
    'input[type="button" i][value*="I Confirm" i]',
    'input[id*="StatementBeforeAuthentificationContent-ContinueButton"]',
    'button:has-text("I Confirm")',
  ]);
  if (clicked) {
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(1500).catch(() => undefined);
  }

  return clicked;
}

async function waitForTaleoPageReady(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ready = await page
      .locator(
        'h1, label[for], input[type="button" i][value], input:not([type="hidden"]), textarea, select',
      )
      .first()
      .isVisible()
      .catch(() => false);
    if (ready) {
      await page.waitForTimeout(300).catch(() => undefined);
      return;
    }

    await page.waitForTimeout(500).catch(() => undefined);
  }
}

async function isFrameElementVisible(frame: Frame): Promise<boolean> {
  if (frame.parentFrame() === null) {
    return true;
  }

  const element = await frame.frameElement().catch(() => null);
  if (!element) {
    return false;
  }

  return element
    .evaluate((node) => {
      const element = node as HTMLElement;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    })
    .catch(() => false);
}

async function detectEmployerCaptchaChallenge(page: Page): Promise<string> {
  const frameInfos = await Promise.all(
    page.frames().map(async (frame) => ({
      url: frame.url(),
      visible: await isFrameElementVisible(frame),
      text: await frame.locator("body").innerText({ timeout: 1000 }).catch(() => ""),
    })),
  );
  const visibleFrameUrls = frameInfos.filter((frame) => frame.visible).map((frame) => frame.url);
  const frameTexts = frameInfos.map((frame) => frame.text);
  const hasVisibleHcaptchaChallenge = visibleFrameUrls.some((url) =>
    /hcaptcha\.com\/captcha\/.*(?:frame=(?:challenge|checkbox|enclave)|hcaptcha(?:-enclave)?\.html#frame=(?:challenge|checkbox|enclave))/i.test(
      url,
    ),
  );
  if (hasVisibleHcaptchaChallenge) {
    return "Manual CAPTCHA verification is required.";
  }

  const bodyText = normalizeQuestionText(
    [await page.locator("body").innerText().catch(() => ""), ...frameTexts].join(" "),
  );
  if (
    /verify you are human|human verification|security verification|security check|complete the captcha|captcha challenge|protected by hcaptcha/.test(
      bodyText,
    ) &&
    (visibleFrameUrls.some((url) => /hcaptcha\.com/i.test(url)) ||
      bodyText.includes("protected by hcaptcha") ||
      /\bverify\b.*\ben\b/.test(bodyText))
  ) {
    return "Manual CAPTCHA verification is required.";
  }

  return "";
}

async function isTaleoRegistrationGate(page: Page): Promise<boolean> {
  if ((await detectApplicationSiteKind(page)) !== "taleo") {
    return false;
  }

  const passwordConfirmVisible = await page
    .locator('input[id*="passwordConfirm"], input[name*="passwordConfirm"]')
    .first()
    .isVisible()
    .catch(() => false);
  const emailConfirmVisible = await page
    .locator('input[id*="emailConfirm"], input[name*="emailConfirm"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (passwordConfirmVisible && emailConfirmVisible) {
    return true;
  }

  const title = tidy(await page.title().catch(() => ""));
  return /new user registration/i.test(title);
}

async function isTaleoLoginGate(page: Page): Promise<boolean> {
  if ((await detectApplicationSiteKind(page)) !== "taleo" || (await isTaleoRegistrationGate(page))) {
    return false;
  }

  const usernameVisible = await page
    .locator('input[id*="login-name"], input[name*="login-name"], input[id*="login"][id*="name"]')
    .first()
    .isVisible()
    .catch(() => false);
  const passwordVisible = await page
    .locator('input[type="password"][id*="login"], input[type="password"][name*="login"], input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
  return usernameVisible && passwordVisible;
}

function getTaleoUsername(profile: Profile): string {
  return (process.env.JAA_TALEO_USERNAME || profile.email).trim();
}

function getTaleoPassword(): string {
  return (
    process.env.JAA_TALEO_PASSWORD ||
    process.env.JAA_EMPLOYER_ACCOUNT_PASSWORD ||
    process.env.JAA_WORKDAY_PASSWORD ||
    ""
  ).trim();
}

async function fillTaleoField(page: Page, selectors: string[], value: string): Promise<boolean> {
  const field = await findFirstVisibleField(page, selectors);
  const nextValue = value.trim();
  if (!field || !nextValue) {
    return false;
  }

  const currentValue = await field.inputValue().catch(() => "");
  if (isMeaningfulValue(currentValue)) {
    return true;
  }

  return setEditableFieldValue(page, field, "input", nextValue);
}

async function clickTaleoAction(page: Page, selectors: string[]): Promise<boolean> {
  const action = await findVisibleAction(page, selectors);
  if (!action) {
    return false;
  }

  const clicked = await clickActionHandle(page, action);
  if (clicked) {
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(1500).catch(() => undefined);
  }

  return clicked;
}

async function submitTaleoLogin(page: Page, profile: Profile): Promise<boolean> {
  const username = getTaleoUsername(profile);
  const password = getTaleoPassword();
  if (!username || !password) {
    return false;
  }

  const filledUsername = await fillTaleoField(
    page,
    [
      'input[id*="login-name"]',
      'input[name*="login-name"]',
      'input[id*="login"][id*="name"]',
      'input[type="text"][id*="name"]',
    ],
    username,
  );
  const filledPassword = await fillTaleoField(
    page,
    [
      'input[type="password"][id*="login"]',
      'input[type="password"][name*="login"]',
      'input[type="password"]',
    ],
    password,
  );
  if (!filledUsername || !filledPassword) {
    return false;
  }

  return clickTaleoAction(page, [
    'input[type="button" i][value*="Login" i]',
    'input[type="button" i][value*="Sign In" i]',
    'input[id*="login-defaultCmd"]',
    'button:has-text("Login")',
    'button:has-text("Sign In")',
  ]);
}

async function openTaleoRegistrationGate(page: Page): Promise<boolean> {
  return clickTaleoAction(page, [
    'input[type="button" i][value*="New User" i]',
    'input[id*="login-register"]',
    'button:has-text("New User")',
  ]);
}

async function openTaleoGuestApply(page: Page): Promise<boolean> {
  return clickTaleoAction(page, [
    'input[type="button" i][value*="Apply as Guest" i]',
    'input[id*="login-guestapply"]',
    'button:has-text("Apply as Guest")',
  ]);
}

async function submitTaleoRegistration(page: Page, profile: Profile): Promise<boolean> {
  const username = getTaleoUsername(profile);
  const password = getTaleoPassword();
  if (!username || !password || !profile.email.trim()) {
    return false;
  }

  const filled = await Promise.all([
    fillTaleoField(page, ['input[id$="-userName"], input[id*="dialogTemplate-dialogForm-userName"]'], username),
    fillTaleoField(page, ['input[id$="-password"]:not([id*="Confirm"])', 'input[id*="dialogTemplate-dialogForm-password"]:not([id*="Confirm"])'], password),
    fillTaleoField(page, ['input[id*="passwordConfirm"]', 'input[name*="passwordConfirm"]'], password),
    fillTaleoField(page, ['input[id$="-email"]', 'input[id*="dialogTemplate-dialogForm-email"]:not([id*="Confirm"])'], profile.email),
    fillTaleoField(page, ['input[id*="emailConfirm"]', 'input[name*="emailConfirm"]'], profile.email),
  ]);
  if (filled.some((result) => !result)) {
    return false;
  }

  return clickTaleoAction(page, [
    'input[type="button" i][value*="Register" i]',
    'input[id*="defaultCmd"]',
    'button:has-text("Register")',
  ]);
}

async function readTaleoAuthBlocker(page: Page): Promise<string> {
  if ((await detectApplicationSiteKind(page)) !== "taleo") {
    return "";
  }

  const onAuthGate = (await isTaleoLoginGate(page)) || (await isTaleoRegistrationGate(page));
  if (onAuthGate && !getTaleoPassword()) {
    return "Taleo authentication requires JAA_TALEO_PASSWORD, JAA_EMPLOYER_ACCOUNT_PASSWORD, or JAA_WORKDAY_PASSWORD.";
  }
  if (!onAuthGate) {
    return "";
  }

  const bodyText = tidy(await page.locator("body").innerText().catch(() => ""));
  const authError = bodyText.match(
    /(invalid user name or password|user name or password.*incorrect|already exists|already registered|unable to register|password.*invalid)/i,
  );
  return authError?.[0] ? cleanRepeatedText(authError[0]) : "";
}

async function readTaleoPageValidationErrors(page: Page): Promise<string[]> {
  if ((await detectApplicationSiteKind(page)) !== "taleo") {
    return [];
  }

  const errors = await page
    .locator('.message-error [role="listitem"], .message-error .error-label, [id*="errorMessages"] [role="listitem"]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean),
    )
    .catch(() => [] as string[]);

  return dedupeText(errors.map((error) => cleanRepeatedText(error)));
}

async function advanceTaleoAuthentication(page: Page, profile: Profile, submit: boolean): Promise<boolean> {
  if ((await detectApplicationSiteKind(page)) !== "taleo" || !submit) {
    return false;
  }

  let advanced = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await acceptTaleoPrivacyNotice(page)) {
      advanced = true;
      continue;
    }

    if (await isTaleoRegistrationGate(page)) {
      const registered = await submitTaleoRegistration(page, profile);
      return registered || advanced;
    }

    if (await isTaleoLoginGate(page)) {
      const loggedIn = await submitTaleoLogin(page, profile);
      advanced = loggedIn || advanced;
      if (loggedIn && !(await isTaleoLoginGate(page))) {
        return true;
      }

      const openedGuestApply = await openTaleoGuestApply(page);
      if (openedGuestApply) {
        advanced = true;
        continue;
      }

      const openedRegistration = await openTaleoRegistrationGate(page);
      if (openedRegistration) {
        advanced = true;
        continue;
      }

      return advanced;
    }

    return advanced;
  }

  return advanced;
}

async function runTaleoDirectAutofill(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  if ((await detectApplicationSiteKind(page)) !== "taleo") {
    return { filled: [], skipped: [] };
  }

  const explicitAnswers = await loadApplicationAnswers();
  const filled: string[] = [];
  const skipped: string[] = [];

  if (await dismissTaleoAttachmentOverwriteDialog(page)) {
    filled.push("Taleo attachment overwrite cancellation");
  }
  if (await clearTaleoAttachmentFileInputs(page)) {
    filled.push("Taleo attachment file input reset");
  }

  const fillTextByIdentifier = async (
    label: string,
    identifier: string,
    value: string | null,
    options: { overwriteSuspiciousNumeric?: boolean } = {},
  ): Promise<void> => {
    const desiredValue = tidy(value || "");
    if (!desiredValue) {
      skipped.push(label);
      return;
    }

    const field = page
      .locator(`input:not([type="hidden"])[id*="${identifier}"], textarea[id*="${identifier}"]`)
      .first();
    if (!(await field.isVisible().catch(() => false))) {
      skipped.push(label);
      return;
    }

    const currentValue = tidy(await field.inputValue().catch(() => ""));
    const shouldOverwrite =
      !isMeaningfulValue(currentValue) ||
      (options.overwriteSuspiciousNumeric === true && /^\d+$/.test(currentValue) && !/^\d+$/.test(desiredValue));
    if (!shouldOverwrite) {
      filled.push(label);
      return;
    }

    await field.fill(desiredValue).catch(() => undefined);
    const appliedValue = tidy(await field.inputValue().catch(() => ""));
    if (matchesDesiredChoice(appliedValue, desiredValue)) {
      filled.push(label);
    } else {
      skipped.push(label);
    }
  };

  const selectByIdentifier = async (label: string, identifier: string, value: string | null): Promise<void> => {
    const desiredValue = tidy(value || "");
    if (!desiredValue) {
      skipped.push(label);
      return;
    }

    const field = page.locator(`select[id*="${identifier}"], select[name*="${identifier}"]`).first();
    if (!(await field.isVisible().catch(() => false))) {
      skipped.push(label);
      return;
    }

    const currentValue = await readFieldCurrentValue(field, "select").catch(() => "");
    if (matchesDesiredChoice(currentValue, desiredValue)) {
      filled.push(label);
      return;
    }

    if (await setEditableFieldValue(page, field, "select", desiredValue)) {
      filled.push(label);
    } else {
      skipped.push(label);
    }
  };

  const selectByIdentifierFromCandidates = async (
    label: string,
    identifier: string,
    values: string[],
  ): Promise<void> => {
    const desiredValues = dedupeText(values);
    if (desiredValues.length === 0) {
      skipped.push(label);
      return;
    }

    const field = page.locator(`select[id*="${identifier}"], select[name*="${identifier}"]`).first();
    if (!(await field.isVisible().catch(() => false))) {
      skipped.push(label);
      return;
    }

    const currentValue = await readFieldCurrentValue(field, "select").catch(() => "");
    if (currentValue && !/^(select|select one|not specified|choose|choose one)$/i.test(currentValue)) {
      filled.push(label);
      return;
    }

    if (await selectNativeOption(field, desiredValues)) {
      filled.push(label);
    } else {
      skipped.push(label);
    }
  };

  const setCheckboxOptionByIdentifier = async (
    label: string,
    identifier: string,
    optionPattern: RegExp,
  ): Promise<void> => {
    const checkboxes = page.locator(`input[type="checkbox"][id*="${identifier}"], input[type="checkbox"][name*="${identifier}"]`);
    const count = await checkboxes.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const checkbox = checkboxes.nth(index);
      if (!(await checkbox.isVisible().catch(() => false))) {
        continue;
      }

      const optionText = tidy(
        (await checkbox.evaluate((node) => {
          const input = node as HTMLInputElement;
          return (
            input.closest("label")?.textContent ||
            document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent ||
            input.parentElement?.textContent ||
            ""
          );
        }).catch(() => "")) as string,
      );
      if (!optionPattern.test(optionText)) {
        continue;
      }

      if (await setCheckboxValue(checkbox, "Yes")) {
        filled.push(label);
      } else {
        skipped.push(label);
      }
      return;
    }

    skipped.push(label);
  };

  const formatTaleoPhone = (value: string): string => {
    const digits = value.replace(/\D/g, "");
    const tenDigit = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    if (tenDigit.length === 10) {
      return `${tenDigit.slice(0, 3)}-${tenDigit.slice(3, 6)}-${tenDigit.slice(6)}`;
    }

    return tidy(value);
  };

  const selectTaleoSourceTracking = async (): Promise<void> => {
    const sourceType = page.locator('select[id*="sourceTrackingBlock-recruitmentSourceType"], select[name*="sourceTrackingBlock-recruitmentSourceType"]').first();
    if (await sourceType.isVisible().catch(() => false)) {
      const currentSourceType = await readFieldCurrentValue(sourceType, "select").catch(() => "");
      if (!matchesDesiredChoice(currentSourceType, "Job Board")) {
        const selected = await selectNativeOption(sourceType, ["Job Board"]);
        if (selected) {
          filled.push("Taleo source type");
          await page.waitForTimeout(900).catch(() => undefined);
        } else {
          skipped.push("Taleo source type");
        }
      } else {
        filled.push("Taleo source type");
      }
    }

    const source = page.locator('select[id*="recruitmentSourceDP"], select[name*="recruitmentSourceDP"]').first();
    if (!(await source.isVisible().catch(() => false))) {
      skipped.push("Taleo source");
      return;
    }

    const currentSource = await readFieldCurrentValue(source, "select").catch(() => "");
    if (currentSource) {
      filled.push("Taleo source");
      return;
    }

    const selected = await selectNativeOption(source, [
      "LinkedIn",
      "Indeed Apply",
      "ZTM_ENT_Organic Job Post_Indeed Apply",
      "Career Section",
      "Company Sites",
      "Career Arc",
      "Other",
    ]);
    if (selected) {
      filled.push("Taleo source");
    } else {
      skipped.push("Taleo source");
    }
  };

  const answerTaleoRadioByQuestion = async (
    label: string,
    questionPattern: RegExp,
    optionPatterns: RegExp[],
  ): Promise<void> => {
    const applied = await page
      .evaluate(
        ({ questionPatternSource, questionPatternFlags, optionPatternSources, optionPatternFlags }) => {
          const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
          const questionRe = new RegExp(questionPatternSource, questionPatternFlags);
          const optionRes = optionPatternSources.map((source, index) => new RegExp(source, optionPatternFlags[index] || ""));
          const inputs = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
          const questionBlocks = (() => {
            const text = read(document.body?.innerText);
            const blocks: string[] = [];
            const blockPattern = /(?:^|\s)(\d{1,2})\.\s+(.*?)(?=\s+\d{1,2}\.\s+|Social Responsibility|Fraudulent Activity|Privacy Policy|$)/g;
            let match: RegExpExecArray | null;
            while ((match = blockPattern.exec(text)) !== null) {
              blocks[Number(match[1]) - 1] = read(match[2]);
            }
            return blocks;
          })();
          const groups = new Map<string, HTMLInputElement[]>();
          for (const input of inputs) {
            const groupKey = input.name || input.id;
            if (!groupKey) continue;
            const inputsForGroup = groups.get(groupKey) || [];
            inputsForGroup.push(input);
            groups.set(groupKey, inputsForGroup);
          }
          const sortedGroups = Array.from(groups.entries()).sort(([left], [right]) => {
            const leftIndex = Number(left.match(/-(\d+)-qr(?:_|$)/)?.[1] ?? Number.MAX_SAFE_INTEGER);
            const rightIndex = Number(right.match(/-(\d+)-qr(?:_|$)/)?.[1] ?? Number.MAX_SAFE_INTEGER);
            return leftIndex - rightIndex;
          });
          for (const optionRe of optionRes) {
            for (const [groupKey, groupInputs] of sortedGroups) {
              const groupIndex = Number(groupKey.match(/-(\d+)-qr(?:_|$)/)?.[1] ?? -1);
              const firstInput = groupInputs[0];
              const fieldset = firstInput?.closest("fieldset");
              const question = read(
                (groupIndex >= 0 ? questionBlocks[groupIndex] : "") ||
                  fieldset?.querySelector(".description")?.textContent ||
                  fieldset?.querySelector("legend")?.textContent ||
                  fieldset?.textContent,
              );
              if (!questionRe.test(question)) {
                continue;
              }

              const match = groupInputs.find((input) => {
                const option = read(
                  document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent ||
                    input.closest("label")?.textContent ||
                    input.parentElement?.textContent,
                );
                return optionRe.test(option);
              });
              if (!match) {
                continue;
              }

              match.checked = true;
              match.click();
              match.dispatchEvent(new Event("input", { bubbles: true }));
              match.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }
          }

          return false;
        },
        {
          questionPatternSource: questionPattern.source,
          questionPatternFlags: questionPattern.flags,
          optionPatternSources: optionPatterns.map((pattern) => pattern.source),
          optionPatternFlags: optionPatterns.map((pattern) => pattern.flags),
        },
      )
      .catch(() => false);

    if (applied) {
      filled.push(label);
    } else {
      skipped.push(label);
    }
  };

  const answerTaleoCheckboxesByQuestion = async (
    label: string,
    questionPattern: RegExp,
    optionPatterns: RegExp[],
  ): Promise<void> => {
    const appliedCount = await page
      .evaluate(
        ({ questionPatternSource, questionPatternFlags, optionPatternSources, optionPatternFlags }) => {
          const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
          const questionRe = new RegExp(questionPatternSource, questionPatternFlags);
          const optionRes = optionPatternSources.map((source, index) => new RegExp(source, optionPatternFlags[index] || ""));
          const inputs = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
          const questionBlocks = (() => {
            const text = read(document.body?.innerText);
            const blocks: string[] = [];
            const blockPattern = /(?:^|\s)(\d{1,2})\.\s+(.*?)(?=\s+\d{1,2}\.\s+|Social Responsibility|Fraudulent Activity|Privacy Policy|$)/g;
            let match: RegExpExecArray | null;
            while ((match = blockPattern.exec(text)) !== null) {
              blocks[Number(match[1]) - 1] = read(match[2]);
            }
            return blocks;
          })();
          const groups = new Map<string, HTMLInputElement[]>();
          for (const input of inputs) {
            const groupKey = input.name || input.id;
            if (!groupKey) continue;
            const inputsForGroup = groups.get(groupKey) || [];
            inputsForGroup.push(input);
            groups.set(groupKey, inputsForGroup);
          }
          let changed = 0;
          for (const [groupKey, groupInputs] of groups.entries()) {
            const groupIndex = Number(groupKey.match(/-(\d+)-qc(?:_|$)/)?.[1] ?? -1);
            const firstInput = groupInputs[0];
            const fieldset = firstInput?.closest("fieldset");
            const question = read(
              (groupIndex >= 0 ? questionBlocks[groupIndex] : "") ||
                fieldset?.querySelector(".description")?.textContent ||
                fieldset?.querySelector("legend")?.textContent ||
                fieldset?.textContent,
            );
            if (!questionRe.test(question)) {
              continue;
            }

            for (const input of groupInputs) {
              const option = read(
                document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent ||
                  input.closest("label")?.textContent ||
                  input.parentElement?.textContent,
              );
              const shouldCheck = optionRes.some((optionRe) => optionRe.test(option));
              if (/none of the above/i.test(option) && input.checked && !shouldCheck) {
                input.click();
              }
              if (!shouldCheck) {
                continue;
              }

              if (!input.checked) {
                input.click();
                changed += 1;
              } else {
                changed += 1;
              }
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }

          return changed;
        },
        {
          questionPatternSource: questionPattern.source,
          questionPatternFlags: questionPattern.flags,
          optionPatternSources: optionPatterns.map((pattern) => pattern.source),
          optionPatternFlags: optionPatterns.map((pattern) => pattern.flags),
        },
      )
      .catch(() => 0);

    if (appliedCount > 0) {
      filled.push(label);
    } else {
      skipped.push(label);
    }
  };

  const setCheckboxByIdentifier = async (label: string, identifier: string, value: string | null): Promise<boolean> => {
    const desiredValue = tidy(value || "");
    if (!desiredValue) {
      skipped.push(label);
      return false;
    }

    const field = page.locator(`input[type="checkbox"][id*="${identifier}"], input[type="checkbox"][name*="${identifier}"]`).first();
    if (!(await field.isVisible().catch(() => false))) {
      skipped.push(label);
      return false;
    }

    const applied = await setCheckboxValue(field, desiredValue);
    if (applied) {
      filled.push(label);
      await page.waitForTimeout(200).catch(() => undefined);
      return isAffirmativeAnswer(desiredValue);
    }

    skipped.push(label);
    return false;
  };

  const normalizeDateAnswer = (value: string | null): string => {
    const raw = tidy(value || "");
    if (!raw) {
      return "";
    }

    const iso = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (iso) {
      return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
    }

    const monthNames: Record<string, string> = {
      jan: "01",
      january: "01",
      feb: "02",
      february: "02",
      mar: "03",
      march: "03",
      apr: "04",
      april: "04",
      may: "05",
      jun: "06",
      june: "06",
      jul: "07",
      july: "07",
      aug: "08",
      august: "08",
      sep: "09",
      sept: "09",
      september: "09",
      oct: "10",
      october: "10",
      nov: "11",
      november: "11",
      dec: "12",
      december: "12",
    };
    const monthYear = raw.match(/\b([A-Za-z]+)\s+(\d{4})\b/);
    if (monthYear) {
      const month = monthNames[monthYear[1].toLowerCase()];
      if (month) {
        return `${monthYear[2]}-${month}-01`;
      }
    }

    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
    }

    return "";
  };

  const displayIsoDate = (isoDate: string): string => {
    const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      return isoDate;
    }

    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const setCalendarDateByIdentifier = async (
    label: string,
    identifier: string,
    value: string | null,
  ): Promise<void> => {
    const isoDate = normalizeDateAnswer(value);
    if (!isoDate) {
      skipped.push(label);
      return;
    }

    const displayValue = displayIsoDate(isoDate);
    const field = page
      .locator(
        `input[type="hidden"][id*="${identifier}"][id$=".inputrelevant"], input[type="hidden"][name*="${identifier}"][name$=".inputrelevant"]`,
      )
      .first();
    if ((await field.count().catch(() => 0)) === 0) {
      skipped.push(label);
      return;
    }

    const applied = await field
      .evaluate(
        (node, { nextValue, nextDisplay }) => {
          const input = node as HTMLInputElement;
          input.value = nextValue;
          input.setAttribute("value", nextValue);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));

          const rootId = input.id.replace(/\.inputrelevant$/, "");
          const display = document.getElementById(`${rootId}.display`);
          if (display) {
            display.textContent = nextDisplay;
            display.setAttribute("title", nextDisplay);
          }

          const emptyFacet = document.getElementById(`${rootId}.emptyFacet`) as HTMLElement | null;
          if (emptyFacet) {
            emptyFacet.style.display = "none";
          }

          return input.value;
        },
        { nextValue: isoDate, nextDisplay: displayValue },
      )
      .then((currentValue) => tidy(currentValue) === isoDate)
      .catch(() => false);

    if (applied) {
      filled.push(label);
    } else {
      skipped.push(label);
    }
  };

  const inferProfileCountry = (): string => {
    const normalizedLocation = normalizeQuestionText(profile.location);
    if (/\bunited states\b|\busa\b|\bu s a\b|\bus\b/.test(normalizedLocation)) {
      return "United States";
    }

    return tidy(profile.location.split(",").at(-1));
  };

  const [firstName = "", ...lastNameParts] = profile.name.trim().split(/\s+/);
  const lastName = lastNameParts.join(" ");
  const smsAnswer =
    lookupApplicationAnswer(explicitAnswers, "receive text messages", "select") ||
    lookupApplicationAnswer(explicitAnswers, "text notification", "select") ||
    "No";
  const smsChoice = isAffirmativeAnswer(smsAnswer) ? "Yes Opt In" : "Not at this time";

  await selectTaleoSourceTracking();
  await fillTextByIdentifier("Taleo first name", "FirstName", firstName);
  await fillTextByIdentifier("Taleo last name", "LastName", lastName);
  await selectByIdentifier("Taleo primary phone", "PreferredPhone", "Cellular Phone");
  await fillTextByIdentifier("Taleo cellular phone", "MobilePhone", formatTaleoPhone(profile.phone));
  await selectByIdentifier("Taleo SMS opt-in", "Opt_32_In_32_SMS", smsChoice);
  await fillTextByIdentifier("Taleo street address", "dv_cs_candidate_personal_info_Address", profile.streetAddress);
  await fillTextByIdentifier("Taleo address line 2", "dv_cs_candidate_personal_info_Address2", profile.addressLine2);
  await fillTextByIdentifier("Taleo city", "dv_cs_candidate_personal_info_City", profile.city);
  await fillTextByIdentifier("Taleo postal code", "dv_cs_candidate_personal_info_ZipCode", profile.postalCode);
  await selectByIdentifier("Taleo email alerts", "Pipe_32_Email_32_Alerts", "Not at this time");

  await selectByIdentifier("Taleo residence country", "ResidenceLocation-0", inferProfileCountry());
  await page.waitForTimeout(500).catch(() => undefined);
  await selectByIdentifier("Taleo residence state", "ResidenceLocation-1", profile.state || profile.location);
  await page.waitForTimeout(500).catch(() => undefined);
  await selectByIdentifier("Taleo residence region", "ResidenceLocation-2", profile.city || profile.location);

  await selectByIdentifier("Taleo COI restrictive covenant", "COI_1_A", "No");
  await selectByIdentifier("Taleo COI board service", "COI_2_A", "No");
  await fillTextByIdentifier("Taleo COI board service details", "COI_2_B", "NA");
  await selectByIdentifier("Taleo COI government employment", "COI_3_A", "No");
  await fillTextByIdentifier("Taleo COI government details", "COI_3_B", "NA");
  await selectByIdentifier("Taleo COI Deloitte Baker Tilly KPMG", "COI_4_A", "No");
  await fillTextByIdentifier("Taleo COI Deloitte Baker Tilly KPMG details", "COI_4_B", "NA");
  await setCheckboxOptionByIdentifier("Taleo COI firm none", "COI_4_C", /none of the above/i);
  await selectByIdentifier("Taleo COI firm employment acknowledgement", "COI_4_D", "Not Employed by Deloitte, Baker Tilly or KPMG");
  await selectByIdentifier("Taleo COI government exclusion", "COI_5_A", "No");
  await fillTextByIdentifier("Taleo COI government exclusion details", "COI_5_B", "NO");
  await selectByIdentifier("Taleo COI UHG prior work", "COI_6_A", "No");
  await fillTextByIdentifier("Taleo COI UHG prior work details", "COI_6_B", "NO");
  await selectByIdentifier("Taleo legal security clearance", "LEGAL_1", "No");
  await selectByIdentifier("Taleo legal work authorization", "LEGAL_2", "Yes");
  await selectByIdentifier("Taleo legal sponsorship", "LEGAL_3", "No");

  const resumeUploadRadio = page
    .locator('input[type="radio"][id*="resumeUploadRadio"], input[type="radio"][name*="resumeUploadRadio"]')
    .first();
  if (await resumeUploadRadio.isVisible().catch(() => false)) {
    const checked = await resumeUploadRadio.isChecked().catch(() => false);
    const applied =
      checked ||
      (await resumeUploadRadio.check({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
      (await resumeUploadRadio.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
    if (applied) {
      filled.push("Taleo resume upload selection");
    } else {
      skipped.push("Taleo resume upload selection");
    }
  }

  const resumeSelectionCheckbox = page
    .locator('input[type="checkbox"][id*="resumeselectionid"], input[type="checkbox"][name*="resumeselectionid"]')
    .first();
  if (await resumeSelectionCheckbox.isVisible().catch(() => false)) {
    const checked = await resumeSelectionCheckbox.isChecked().catch(() => false);
    const applied =
      checked ||
      (await resumeSelectionCheckbox.check({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
      (await resumeSelectionCheckbox.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
    if (applied) {
      filled.push("Taleo resume document selection");
    } else {
      skipped.push("Taleo resume document selection");
    }
  }

  const institution = lookupApplicationAnswer(explicitAnswers, "Institution . Required", "text");
  const program = lookupApplicationAnswer(explicitAnswers, "Program . Required", "text");
  const educationLevel = lookupApplicationAnswer(explicitAnswers, "Education Level . Required", "select");
  const currentJob = lookupApplicationAnswer(explicitAnswers, "Current Job", "checkbox");
  const employer =
    lookupApplicationAnswer(explicitAnswers, "Employer . Required", "text") ||
    lookupApplicationAnswer(explicitAnswers, "Current Company", "text");
  const jobTitle =
    lookupApplicationAnswer(explicitAnswers, "Job Title . Required", "text") ||
    lookupApplicationAnswer(explicitAnswers, "Current Job Title", "text");
  const startDate =
    lookupApplicationAnswer(explicitAnswers, "Start Date . Required", "text") ||
    lookupApplicationAnswer(explicitAnswers, "Current Job Start Date", "text");
  const endDate =
    lookupApplicationAnswer(explicitAnswers, "End Date . Required", "text") ||
    lookupApplicationAnswer(explicitAnswers, "Current Job End Date", "text");

  await fillTextByIdentifier("Taleo education institution", "dv_cs_education_Institution", institution);
  await fillTextByIdentifier("Taleo education program", "dv_cs_education_Program", program);
  await selectByIdentifier("Taleo education level", "UDFEducation_C_EDUCATION_LVL", educationLevel);
  await selectByIdentifier("Taleo education level", "dv_cs_education_StudyLevel", educationLevel || "Bachelor's Degree");
  await selectByIdentifier("Taleo education completed", "UDFEducation_Did_32_you_32_receive", "Yes");
  const currentJobChecked = await setCheckboxByIdentifier("Taleo current job", "dv_cs_experience_CurrentEmployer", currentJob);
  await fillTextByIdentifier("Taleo employer", "dv_cs_experience_Employer", employer, {
    overwriteSuspiciousNumeric: true,
  });
  await fillTextByIdentifier("Taleo job title", "UDFExperience_C_WKEXP_JOB_TITLE", jobTitle, {
    overwriteSuspiciousNumeric: true,
  });
  await setCalendarDateByIdentifier("Taleo start date", "dv_cs_experience_BeginDate", startDate);
  if (!currentJobChecked) {
    await setCalendarDateByIdentifier("Taleo end date", "dv_cs_experience_EndDate", endDate);
  }

  const yearsOfExperience = Number.parseFloat(profile.yearsOfExperience);
  const broadSoftwareYearsPatterns =
    Number.isFinite(yearsOfExperience) && yearsOfExperience >= 10
      ? [/10 or more years/i]
      : Number.isFinite(yearsOfExperience) && yearsOfExperience >= 8
        ? [/8 or more years but less than 10 years/i, /7 or more years but less than 10 years/i]
        : Number.isFinite(yearsOfExperience) && yearsOfExperience >= 7
          ? [/7 or more years but less than 10 years/i, /6 or more years but less than 8 years/i]
          : Number.isFinite(yearsOfExperience) && yearsOfExperience >= 5
            ? [/5 or more years but less than 7 years/i, /4 or more years but less than 6 years/i]
            : Number.isFinite(yearsOfExperience) && yearsOfExperience >= 3
              ? [/3 or more years but less than 5 years/i, /2 or more years but less than 4 years/i]
              : Number.isFinite(yearsOfExperience) && yearsOfExperience >= 1
                ? [/1 or more years but less than 3 years/i, /1 year or more but less than 2 years/i]
                : [/less than 1 year/i, /less than 6 months/i];
  const sixToEightYearsPatterns = [/6 or more years but less than 8 years/i, /5 or more years/i, /4 or more years but less than 6 years/i];
  const fourToSixYearsPatterns = [/4 or more years but less than 6 years/i, /4 or more years but less than 5 years/i, /3 or more years but less than 4 years/i];
  const threeToFourYearsPatterns = [/3 or more years but less than 4 years/i, /2 or more years but less than 3 years/i, /2 or more years but less than 4 years/i];
  const twoToFourYearsPatterns = [/2 or more years but less than 4 years/i, /2 or more years but less than 3 years/i, /1 year or more but less than 2 years/i];
  const lessThanSixMonthsPatterns = [/less than 6 months/i, /less than 1 year/i, /No experience/i, /None/i];
  const fivePlusYearsPatterns = [/5 or more years/i, /6 or more years but less than 8 years/i, /4 or more years but less than 5 years/i];

  await answerTaleoRadioByQuestion("Taleo screening education completed", /highest level of education|level of education.*completed/i, [
    /Bachelor'?s degree/i,
  ]);
  await answerTaleoRadioByQuestion("Taleo screening IT related work", /IT-related work/i, broadSoftwareYearsPatterns);
  await answerTaleoRadioByQuestion("Taleo screening development lifecycle", /development of life cycle/i, broadSoftwareYearsPatterns);
  await answerTaleoRadioByQuestion(
    "Taleo screening professional language development",
    /development experience.*(?:\.NET|Java|JavaScript|Python).*professional environment/i,
    broadSoftwareYearsPatterns,
  );
  await answerTaleoRadioByQuestion(
    "Taleo screening hands-on software development",
    /hands-on software development/i,
    broadSoftwareYearsPatterns,
  );
  await answerTaleoRadioByQuestion("Taleo screening SQL development", /development experience with SQL/i, sixToEightYearsPatterns);
  await answerTaleoRadioByQuestion("Taleo screening MySQL NoSQL", /MySQL and NoSQL/i, fivePlusYearsPatterns);
  await answerTaleoRadioByQuestion("Taleo screening Web APIs REST", /Web APIs.*REST|REST.*Web APIs/i, broadSoftwareYearsPatterns);
  await answerTaleoRadioByQuestion("Taleo screening API streaming", /API development.*(?:Streaming|Kafka|event hubs)/i, fourToSixYearsPatterns);
  await answerTaleoRadioByQuestion("Taleo screening Git source control", /Git, Team Foundation Server or similar source control/i, broadSoftwareYearsPatterns);
  await answerTaleoRadioByQuestion("Taleo screening SQL Management Studio source control", /SQL Management Studio.*source control/i, sixToEightYearsPatterns);
  await answerTaleoRadioByQuestion("Taleo screening CI/CD pipelines", /CI\/CD pipelines/i, fourToSixYearsPatterns);
  await answerTaleoRadioByQuestion("Taleo screening Airflow Jenkins", /Airflow.*Jenkins/i, twoToFourYearsPatterns);
  await answerTaleoRadioByQuestion("Taleo screening Visual Studio VB.NET SQL Server", /Visual Studio.*VB\.NET.*SQL Server/i, lessThanSixMonthsPatterns);
  await answerTaleoRadioByQuestion("Taleo screening Azure cloud services", /Azure cloud platform.*cloud services/i, threeToFourYearsPatterns);
  await answerTaleoRadioByQuestion(
    "Taleo screening Python Pandas Spark",
    /Python using Pandas, and Spark|development using Python, Spark/i,
    twoToFourYearsPatterns,
  );
  await answerTaleoRadioByQuestion("Taleo screening data platform tools", /Databricks|Snowflake|Pyspark|AKS/i, twoToFourYearsPatterns);

  await answerTaleoRadioByQuestion("Taleo screening cloud platforms", /cloud platforms/i, [/^Yes$/i]);
  await answerTaleoRadioByQuestion("Taleo screening big data tools", /Bigdata tools/i, [/^No$/i]);
  await answerTaleoRadioByQuestion("Taleo screening containerization data pipelines", /containerization.*performance tuning/i, [/^Yes$/i]);
  await answerTaleoRadioByQuestion("Taleo screening minimal supervision", /minimal supervision/i, [/^Yes$/i]);
  await answerTaleoRadioByQuestion("Taleo screening assigned deadlines", /assigned deadlines/i, [/^Yes$/i]);
  await answerTaleoRadioByQuestion("Taleo screening analytical problem solving", /analytical and problem-solving/i, [/^Yes$/i]);
  await answerTaleoRadioByQuestion("Taleo screening Oracle PL/SQL", /Oracle databases and PL\/SQL/i, [/No experience/i]);
  await answerTaleoCheckboxesByQuestion("Taleo screening professional qualifications", /professional qualifications/i, [
    /Agile\/Scrum methodology/i,
    /Data analysis experience/i,
    /Functional testing experience/i,
    /SOA \(service-oriented architecture\)/i,
    /Solution Architecting experience/i,
    /mentoring and leading other engineers/i,
    /Excellent Team Player/i,
    /independence and ownership/i,
    /analysis, process, problem solving and critical thinking/i,
  ]);

  return {
    filled,
    skipped,
  };
}

function formatTaleoDocumentDate(date = new Date()): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(date.getDate()).padStart(2, "0")}/${months[date.getMonth()]}/${date.getFullYear()}`;
}

async function runTaleoDocumentFrameAutofill(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  if ((await detectApplicationSiteKind(page)) !== "taleo") {
    return { filled: [], skipped: [] };
  }

  const explicitAnswers = await loadApplicationAnswers();
  const filled: string[] = [];
  const skipped: string[] = [];
  const frames = page.frames().filter((frame) => /htmlResourceViewer|document-html-viewer/i.test(`${frame.name()} ${frame.url()}`));
  const disabilityAnswer = lookupApplicationAnswer(explicitAnswers, "Disability Status", "checkbox") || "No";

  for (const frame of frames) {
    const nameField = frame.locator('input[aria-label="Name"], input[title="Name"]').first();
    if (await nameField.isVisible().catch(() => false)) {
      const currentValue = tidy(await nameField.inputValue().catch(() => ""));
      if (!isMeaningfulValue(currentValue)) {
        await nameField.fill(profile.name).catch(() => undefined);
      }
      if (isMeaningfulValue(await nameField.inputValue().catch(() => ""))) {
        filled.push("Taleo document name");
      } else {
        skipped.push("Taleo document name");
      }
    }

    const dateField = frame.locator('input[aria-label="Date"], input[title*="Date format" i], input.dateField').first();
    if (await dateField.isVisible().catch(() => false)) {
      const currentValue = tidy(await dateField.inputValue().catch(() => ""));
      if (!isMeaningfulValue(currentValue)) {
        await dateField.fill(formatTaleoDocumentDate()).catch(() => undefined);
      }
      if (isMeaningfulValue(await dateField.inputValue().catch(() => ""))) {
        filled.push("Taleo document date");
      } else {
        skipped.push("Taleo document date");
      }
    }

    const desiredDisabilityChoice =
      isNegativeAnswer(disabilityAnswer)
        ? 'input[aria-label*="No, I do not have a disability" i]'
        : isNonDisclosureOption(disabilityAnswer)
          ? 'input[aria-label*="do not want to answer" i]'
          : isAffirmativeAnswer(disabilityAnswer)
            ? 'input[aria-label*="Yes, I have a disability" i]'
            : "";
    if (desiredDisabilityChoice) {
      const choice = frame.locator(desiredDisabilityChoice).first();
      if (await choice.isVisible().catch(() => false)) {
        const checked = await choice.isChecked().catch(() => false);
        const applied = checked || (await choice.check({ timeout: 5_000 }).then(() => true).catch(() => false));
        if (applied) {
          filled.push("Taleo disability status");
        } else {
          skipped.push("Taleo disability status");
        }
      }
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function enterTaleoApplicationFlowIfNeeded(page: Page): Promise<void> {
  await acceptTaleoPrivacyNotice(page).catch(() => undefined);
  await waitForTaleoPageReady(page).catch(() => undefined);
}

async function enterSiteApplicationFlowIfNeeded(page: Page, siteKind: ApplicationSiteKind): Promise<void> {
  if (siteKind === "workday") {
    if (isWorkdayApplicationUrl(page.url())) {
      await page.waitForTimeout(300).catch(() => undefined);
      return;
    }
    await enterWorkdayApplicationFlowIfNeeded(page).catch(() => undefined);
    await page.waitForTimeout(800).catch(() => undefined);
    return;
  }

  if (siteKind === "lever") {
    await enterLeverApplicationFlowIfNeeded(page).catch(() => undefined);
    await page.waitForTimeout(800).catch(() => undefined);
    return;
  }

  if (siteKind === "ashby") {
    await enterAshbyApplicationFlowIfNeeded(page).catch(() => undefined);
    await page.waitForTimeout(800).catch(() => undefined);
    return;
  }

  if (siteKind === "taleo") {
    await enterTaleoApplicationFlowIfNeeded(page).catch(() => undefined);
    await page.waitForTimeout(800).catch(() => undefined);
    return;
  }

  if (siteKind === "phenom") {
    await enterPhenomApplicationFlowIfNeeded(page).catch(() => undefined);
    await page.waitForTimeout(800).catch(() => undefined);
    return;
  }

  if (siteKind === "successfactors") {
    await expandSuccessFactorsSections(page).catch(() => undefined);
    await page.waitForTimeout(800).catch(() => undefined);
    return;
  }

  await enterGenericApplicationFlowIfNeeded(page).catch(() => undefined);
  await page.waitForTimeout(800).catch(() => undefined);
}

async function findFirstVisibleAction(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }
  return null;
}

function normalizeLinkedInJobUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("linkedin.com")) {
      return parsed.toString();
    }

    const match = parsed.pathname.match(/\/jobs\/view\/(\d+)/);
    if (!match) {
      return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
    }

    return `${parsed.origin}/jobs/view/${match[1]}/`;
  } catch {
    return url.trim();
  }
}

function isLinkedInApplyLikeAnchor(text: string, ariaLabel: string, href: string): boolean {
  const normalized = tidy([text, ariaLabel, href].filter(Boolean).join(" ")).toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    /\/apply\//i.test(href) ||
    /easy apply/i.test(normalized) ||
    /quick apply/i.test(normalized) ||
    /apply now/i.test(normalized) ||
    /apply on company site/i.test(normalized) ||
    /apply on employer site/i.test(normalized) ||
    /submit application/i.test(normalized) ||
    /\bapply\b/i.test(normalized) && normalized.length < 120
  );
}

async function readFirstLinkedInText(scope: Locator, selectors: string[]): Promise<string> {
  for (const selector of selectors) {
    const value = cleanRepeatedText((await scope.locator(selector).first().textContent().catch(() => "")) ?? "");
    if (value) {
      return value;
    }
  }

  return "";
}

async function waitForLinkedInCollectionPageReady(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const links = page.locator('a[href*="/jobs/view/"]');
    const count = Math.min(await links.count().catch(() => 0), 30);

    for (let index = 0; index < count; index += 1) {
      if (await links.nth(index).isVisible().catch(() => false)) {
        return;
      }
    }

    await page.waitForTimeout(500).catch(() => undefined);
  }
}

async function waitForLinkedInPreviewPaneReady(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);

  const readySelectors = [
    ".jobs-details-top-card__job-title",
    ".job-details-jobs-unified-top-card__job-title",
    "button.jobs-save-button",
    'button[aria-label*="save" i]',
    'a[aria-label*="save" i]',
    ".jobs-description-content__text",
    ".show-more-less-html__markup",
    "[data-job-description]",
  ];

  for (let attempt = 0; attempt < 12; attempt += 1) {
    for (const selector of readySelectors) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await page.waitForTimeout(500).catch(() => undefined);
      await expandLinkedInDescription(page).catch(() => undefined);
      return;
    }

    await page.waitForTimeout(500).catch(() => undefined);
  }

  await expandLinkedInDescription(page).catch(() => undefined);
}

function isLinkedInNavigationAbortError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /ERR_ABORTED|net::ERR_ABORTED|navigation failed because page was closed|navigation to .* was interrupted/i.test(
    message,
  );
}

async function gotoAttachedUrl(page: Page, url: string): Promise<void> {
  const targetUrl = url.trim();
  if (!targetUrl) {
    return;
  }

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (error) {
    if (!isLinkedInNavigationAbortError(error)) {
      throw error;
    }
  }

  await page.waitForTimeout(1200).catch(() => undefined);
}

async function getAttachedLinkedInPreviewTargets(page: Page): Promise<LinkedInPreviewTarget[]> {
  await waitForLinkedInCollectionPageReady(page);
  const previews = await page.locator('a[href*="/jobs/view/"]').evaluateAll((elements) => {
    const targets = [];
    const seen = new Set();

    for (const rawElement of elements) {
      const element = rawElement;
      if (!(element instanceof HTMLAnchorElement)) {
        continue;
      }

      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        continue;
      }

      const href = (element.getAttribute("href") || "").trim();
      let absoluteUrl = "";
      try {
        absoluteUrl = new URL(href, window.location.href).toString();
      } catch {
        absoluteUrl = "";
      }

      const match = absoluteUrl.match(/\/jobs\/view\/(\d+)/);
      const jobId = match?.[1];
      if (!jobId || seen.has(jobId)) {
        continue;
      }

      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      const ariaLabel = (element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      const normalizedAnchorText = [text, ariaLabel, href].join(" ").toLowerCase();
      const isApplyLike =
        /\/apply\//i.test(href) ||
        normalizedAnchorText.includes("easy apply") ||
        normalizedAnchorText.includes("quick apply") ||
        normalizedAnchorText.includes("apply on company website") ||
        normalizedAnchorText.includes("apply on employer website") ||
        normalizedAnchorText.includes("apply now") ||
        normalizedAnchorText.includes("submit application") ||
        (/\bapply\b/i.test(normalizedAnchorText) && normalizedAnchorText.length < 120);

      if (isApplyLike) {
        continue;
      }

      const container =
        element.closest(
          ".job-card-container, .jobs-search-results__list-item, .job-card-list, .artdeco-list__item, .scaffold-layout__list-item, li",
        ) || element.parentElement || element;

      let title = "";
      for (const selector of [
        ".job-card-list__title",
        ".job-card-container__link",
        ".job-card-square__title",
        ".artdeco-entity-lockup__title a",
        ".artdeco-entity-lockup__title",
      ]) {
        const value = (container.querySelector(selector)?.textContent || "").replace(/\s+/g, " ").trim();
        if (value) {
          title = value;
          break;
        }
      }

      let company = "";
      for (const selector of [
        ".job-card-container__primary-description",
        ".job-card-container__company-name",
        ".job-card-list__company-name",
        ".artdeco-entity-lockup__subtitle",
      ]) {
        const value = (container.querySelector(selector)?.textContent || "").replace(/\s+/g, " ").trim();
        if (value) {
          company = value;
          break;
        }
      }

      let location = "";
      for (const selector of [
        ".job-card-container__metadata-item",
        ".job-card-container__metadata-wrapper",
        ".job-card-list__footer-wrapper",
        ".artdeco-entity-lockup__caption",
      ]) {
        const value = (container.querySelector(selector)?.textContent || "").replace(/\s+/g, " ").trim();
        if (value) {
          location = value;
          break;
        }
      }

      seen.add(jobId);
      targets.push({
        jobId,
        url: absoluteUrl,
        title,
        company,
        location,
      });
    }

    return targets;
  });

  return previews.map((preview) => {
    const anchor = page.locator(`a[href*="/jobs/view/${preview.jobId}"]`).first();
    const container = anchor.locator(
      "xpath=ancestor::*[" +
        "contains(@class, 'job-card-container') or " +
        "contains(@class, 'jobs-search-results__list-item') or " +
        "contains(@class, 'job-card-list') or " +
        "contains(@class, 'artdeco-list__item') or " +
        "contains(@class, 'scaffold-layout__list-item') or " +
        "self::li" +
      "][1]",
    );

    return {
      jobId: preview.jobId,
      url: normalizeLinkedInJobUrl(preview.url),
      anchor,
      container,
      title: cleanRepeatedText(preview.title) || "Untitled role",
      company: cleanRepeatedText(preview.company) || "Unknown company",
      location: cleanRepeatedText(preview.location),
    };
  });
}

async function findAttachedLinkedInPreviewTarget(page: Page, url: string): Promise<LinkedInPreviewTarget | null> {
  const normalizedUrl = normalizeLinkedInJobUrl(url);
  const jobId = normalizedUrl.match(/\/jobs\/view\/(\d+)/)?.[1];
  const targets = await getAttachedLinkedInPreviewTargets(page);
  return (
    targets.find((target) => target.jobId === jobId) ??
    targets.find((target) => target.url === normalizedUrl) ??
    null
  );
}

const linkedInPreviewSaveSelectors = [
  "button.jobs-save-button",
  'button[aria-label*="save" i]',
  'a[aria-label*="save" i]',
  'button:has-text("Save")',
  'a:has-text("Save")',
];

const linkedInPreviewDismissSelectors = [
  'button[aria-label*="dismiss" i]',
  'button:has-text("Dismiss")',
  'button:has-text("Not interested")',
];

async function openAttachedLinkedInPreviewTarget(page: Page, target: LinkedInPreviewTarget): Promise<ExtractedJobDraft> {
  await target.anchor.scrollIntoViewIfNeeded().catch(() => undefined);
  const clicked = await target.anchor.click({ timeout: 10000 }).then(() => true).catch(() => false);
  if (!clicked) {
    throw new Error(`Could not open the LinkedIn preview for ${target.url}.`);
  }

  await waitForLinkedInPreviewPaneReady(page);
  const extracted = await extractFromPage(page, "linkedin");
  return {
    ...extracted,
    title: cleanRepeatedText(extracted.title) || target.title,
    company: cleanRepeatedText(extracted.company) || target.company,
    url: target.url,
  };
}

async function screenLinkedInJobsOnPage(page: Page, limit: number): Promise<AttachedLinkedInScreeningResult[]> {
  const targets = (await getAttachedLinkedInPreviewTargets(page)).slice(0, Math.max(limit, 0));
  const results: AttachedLinkedInScreeningResult[] = [];

  for (const target of targets) {
    let inspected:
      | {
          title: string;
          company: string;
          description: string;
          draft: ExtractedJobDraft;
          screening: WorkloadScreening;
        }
      | null = null;
    try {
      inspected = await inspectAttachedLinkedInPreviewTarget(page, target);
    } catch {
      results.push({
        title: target.title,
        company: target.company,
        url: target.url,
        action: "skipped",
        reasons: ["Could not open the LinkedIn job preview."],
        score: 0,
        draft: null,
        alreadySaved: false,
      });
      continue;
    }

    const { title, company, description, draft, screening } = inspected;

    if (!description) {
      results.push({
        title,
        company,
        url: draft.url,
        action: "skipped",
        reasons: ["Could not retrieve the LinkedIn job description from the preview pane."],
        score: screening.score,
        draft: null,
        alreadySaved: false,
      });
      continue;
    }

    if (!screening.pass) {
      const dismissed = await clickLinkedInPreviewDismissButton(page, target);

      results.push({
        title,
        company,
        url: draft.url,
        action: dismissed ? "dismissed" : "skipped",
        reasons: screening.reasons,
        score: screening.score,
        draft: null,
        alreadySaved: false,
      });
      await page.waitForTimeout(800);
      continue;
    }

    const saveButton = page.locator(linkedInPreviewSaveSelectors.join(", ")).first();
    const saveText =
      tidy(await saveButton.textContent().catch(() => "")) ||
      tidy(await saveButton.getAttribute("aria-label").catch(() => ""));
    const canSave = await saveButton.isVisible().catch(() => false);
    const alreadySaved = !canSave || /unsave|saved/i.test(saveText);
    const saved = alreadySaved || (await clickLinkedInPreviewSaveButton(page));

    results.push({
      title,
      company,
      url: draft.url,
      action: saved ? "saved" : "skipped",
      reasons: saved
        ? screening.reasons
        : [...screening.reasons, "Role passed the screen but the LinkedIn save button could not be clicked."],
      score: screening.score,
      draft: saved ? draft : null,
      alreadySaved,
    });
    await page.waitForTimeout(800);
  }

  return results;
}

async function inspectAttachedLinkedInPreviewTarget(
  page: Page,
  target: LinkedInPreviewTarget,
): Promise<{
  title: string;
  company: string;
  description: string;
  draft: ExtractedJobDraft;
  screening: WorkloadScreening;
}> {
  const draft = await openAttachedLinkedInPreviewTarget(page, target);
  const title = cleanRepeatedText(draft.title) || "Untitled role";
  const company = cleanRepeatedText(draft.company) || "Unknown company";
  const description = tidy(draft.description).slice(0, 6000);
  const screening = await evaluateJobScreening({
    title,
    company,
    description,
  });

  return {
    title,
    company,
    description,
    draft: {
      ...draft,
      title,
      company,
      description,
      url: normalizeLinkedInJobUrl(draft.url || target.url),
    },
    screening,
  };
}

async function clickLinkedInPreviewSaveButton(page: Page): Promise<boolean> {
  return clickFirstVisible(page, linkedInPreviewSaveSelectors);
}

async function clickLinkedInPreviewDismissButton(page: Page, target: LinkedInPreviewTarget): Promise<boolean> {
  return (
    (await clickFirstVisible(page, linkedInPreviewDismissSelectors).catch(() => false)) ||
    (await clickFirstVisible(target.container, linkedInPreviewDismissSelectors).catch(() => false))
  );
}

function cleanRepeatedText(value: string): string {
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

function extractCompensation(text: string): {
  compensationText: string;
  estimatedMaxAnnualCompensation: number | null;
} {
  const normalized = tidy(text);
  if (!normalized) {
    return { compensationText: "", estimatedMaxAnnualCompensation: null };
  }

  const rangeMatch = normalized.match(
    /\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m)?\s*(?:-|to)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m)?/i,
  );
  if (rangeMatch) {
    const maxValue = normalizeCompensationValue(rangeMatch[3], rangeMatch[4]);
    return {
      compensationText: rangeMatch[0],
      estimatedMaxAnnualCompensation: maxValue,
    };
  }

  const singleMatches = Array.from(normalized.matchAll(/\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m)\b/gi));
  if (singleMatches.length > 0) {
    const last = singleMatches[singleMatches.length - 1];
    return {
      compensationText: last[0],
      estimatedMaxAnnualCompensation: normalizeCompensationValue(last[1], last[2]),
    };
  }

  return { compensationText: "", estimatedMaxAnnualCompensation: null };
}

function normalizeCompensationValue(raw: string, suffix: string | undefined): number | null {
  const numeric = Number.parseFloat(raw.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const unit = (suffix ?? "").toLowerCase();
  if (unit === "m") {
    return Math.round(numeric * 1_000_000);
  }
  if (unit === "k") {
    return Math.round(numeric * 1_000);
  }
  return Math.round(numeric);
}

async function extractLinkedInCompensation(page: Page): Promise<{
  compensationText: string;
  estimatedMaxAnnualCompensation: number | null;
}> {
  const candidates = [
    ".job-details-fit-level-preferences",
    ".job-details-preferences-and-skills",
    ".jobs-unified-top-card__job-insight",
    ".jobs-unified-top-card__subtitle-secondary-grouping",
    ".job-details-jobs-unified-top-card__primary-description-container",
    "main",
  ];

  for (const selector of candidates) {
    const text = tidy(await page.locator(selector).first().textContent().catch(() => ""));
    const compensation = extractCompensation(text);
    if (compensation.estimatedMaxAnnualCompensation) {
      return compensation;
    }
  }

  const pageText = tidy(await page.locator("body").innerText().catch(() => ""));
  const bodyCompensation = extractCompensation(pageText);
  if (bodyCompensation.estimatedMaxAnnualCompensation) {
    return bodyCompensation;
  }

  return { compensationText: "", estimatedMaxAnnualCompensation: null };
}

async function extractFromPage(page: Page, source: string): Promise<ExtractedJobDraft> {
  const firstText = async (selectors: string[]): Promise<string> => {
    for (const selector of selectors) {
      const value = tidy(
        await page.locator(selector).first().textContent({ timeout: 1000 }).catch(() => ""),
      );
      if (value) return value;
    }
    return "";
  };

  const firstMeta = async (selectors: string[]): Promise<string> => {
    for (const selector of selectors) {
      const value = tidy(
        await page
          .locator(selector)
          .first()
          .getAttribute("content", { timeout: 1000 })
          .catch(() => ""),
      );
      if (value) return value;
    }
    return "";
  };

  const pageTitle = tidy(await page.title());
  let title =
    (await firstText(["h1"])) ||
    (await firstMeta(['meta[property="og:title"]', 'meta[name="og:title"]'])) ||
    pageTitle;

  let company =
    (await firstText([
      "[data-test-company-name]",
      ".job-details-jobs-unified-top-card__company-name",
      ".topcard__org-name-link",
      ".jobsearch-CompanyInfoWithoutHeaderImage a",
    ])) ||
    (await firstMeta(['meta[property="og:site_name"]', 'meta[name="og:site_name"]']));

  if (
    (!company || company === "LinkedIn") &&
    (source.includes("linkedin") || page.url().includes("linkedin.com/jobs"))
  ) {
    const linkedInTitleMatch = pageTitle.match(/^(.*?)\s+\|\s+(.*?)\s+\|\s+LinkedIn$/i);
    if (linkedInTitleMatch) {
      title = title && title !== pageTitle ? title : tidy(linkedInTitleMatch[1]);
      company = tidy(linkedInTitleMatch[2]);
    }
  }

  const description =
    (await firstText([
      "[data-job-description]",
      ".jobs-description-content__text",
      ".show-more-less-html__markup",
      "#job-details",
      "main",
      "body",
    ])).slice(0, 6000);

  return {
    title: title || "Untitled role",
    company: company || "Unknown company",
    description,
    source,
    url: page.url(),
  };
}

async function expandLinkedInDescription(page: Page): Promise<void> {
  const selectors = [
    'button[aria-label*="description" i]',
    'button[aria-label*="see more" i]',
    ".jobs-description__footer-button",
    '.inline-show-more-text__button[aria-expanded="false"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    await locator.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
}

export async function openBrowser(url: string, headed = true): Promise<void> {
  await ensureBrowserDirs();
  const context = await chromium.launchPersistentContext(browserProfileDir, {
    channel: browserChannel as "chrome" | "msedge",
    headless: !headed,
    timeout: 30000,
    viewport: { width: 1440, height: 900 },
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1000);

  if (!headed) {
    await context.close();
    return;
  }

  process.stdout.write("Browser opened. Press Ctrl+C when you are done.\n");
  await new Promise<void>((resolve) => {
    const handleSigint = () => {
      process.off("SIGINT", handleSigint);
      resolve();
    };

    process.on("SIGINT", handleSigint);
  });
  await context.close();
}

export async function captureJobPosting(url: string, headed = false): Promise<ExtractedJobDraft> {
  return withEphemeralPage(headed, async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const source = new URL(url).hostname;
    const extracted = await extractFromPage(page, source);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(
      path.join(browserOutputDir, `capture-${stamp}.json`),
      `${JSON.stringify(extracted, null, 2)}\n`,
      "utf8",
    );
    return extracted;
  });
}

export async function captureCurrentLinkedInDraft(headed = true): Promise<ExtractedJobDraft> {
  return withPersistentPage(headed, async (page) => {
    if (!page.url() || page.url() === "about:blank") {
      throw new Error("No active page found in the persistent browser profile.");
    }

    await page.waitForTimeout(1000);
    return extractFromPage(page, "linkedin");
  });
}

export function getDebugChromeLaunchCommand(url: string): string {
  const escapedProfile = attachedChromeProfileDir.replace(/\\/g, "\\\\");
  return `& "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="${escapedProfile}" "${url}"`;
}

export async function isAttachedBrowserAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function attachedBrowserHasLinkedInPage(): Promise<boolean> {
  try {
    const urls = await getTargetUrlsFromCdp();
    return urls.some((url) => url.includes("linkedin.com/jobs"));
  } catch {
    return false;
  }
}

async function saveBrowserArtifact(prefix: string, value: unknown): Promise<void> {
  await ensureBrowserDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(
    path.join(browserOutputDir, `${prefix}-${stamp}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function saveBrowserDebugArtifact(filename: string, value: unknown): Promise<void> {
  await ensureBrowserDirs();
  await writeFile(path.join(browserOutputDir, filename), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readPageAndFrameText(page: Page, maxFrames = 8): Promise<string> {
  const parts: string[] = [];
  for (const frame of page.frames().slice(0, maxFrames)) {
    const text = tidy(await frame.locator("body").innerText().catch(() => ""));
    if (text) {
      parts.push(text);
    }
  }

  return cleanRepeatedText(parts.join(" "));
}

async function readSiteAutomationBlocker(page: Page): Promise<string> {
  const captchaChallenge = await detectEmployerCaptchaChallenge(page);
  if (captchaChallenge) {
    return captchaChallenge;
  }

  const text = normalizeQuestionText(await readPageAndFrameText(page));
  if (/couldn t submit your application|flagged as possible spam|possible spam/.test(text)) {
    return "Employer anti-spam rejected the submission.";
  }

  if (
    /verify you are human|human verification|complete (?:a )?security check|security challenge|complete the captcha|captcha challenge|protected by hcaptcha|verify en\b/.test(
      text,
    )
  ) {
    return "Captcha or anti-bot verification requires manual verification.";
  }

  if (/icims/.test(page.url().toLowerCase()) && /privacy notice|candidate privacy|consent to the processing/.test(text)) {
    return "iCIMS privacy consent gate requires manual verification.";
  }

  return "";
}

async function extractLocatorLabel(field: Locator): Promise<string> {
  const name = tidy(await field.getAttribute("name").catch(() => ""));
  const id = tidy(await field.getAttribute("id").catch(() => ""));
  const identifier = `${name} ${id}`;
  const labelledBy = tidy(await field.getAttribute("aria-labelledby").catch(() => ""));
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/).filter(Boolean)) {
      const text = tidy(
        await field
          .page()
          .locator(`[id="${escapeAttributeValue(id)}"]`)
          .first()
          .textContent({ timeout: 500 })
          .catch(() => ""),
      );
      if (text) {
        return refineFieldLabelFromIdentifier(cleanExtractedLabel(text), identifier);
      }
    }
  }

  const fieldsetLegend = tidy(
    await field
      .evaluate((node) => {
        const legend = (node as HTMLElement).closest("fieldset")?.querySelector("legend");
        return (legend?.textContent || "").replace(/\s+/g, " ").trim();
      })
      .catch(() => ""),
  );
  if (fieldsetLegend) {
    return refineFieldLabelFromIdentifier(cleanExtractedLabel(fieldsetLegend), identifier);
  }

  const evaluated = tidy(
    await field
      .evaluate((node) => {
        const element = node as HTMLElement;
        const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

        const id = element.getAttribute("id");
        if (id) {
          for (const candidate of Array.from(document.querySelectorAll("label"))) {
            if ((candidate.getAttribute("for") || "").trim() === id) {
              const text = read(candidate.textContent);
              if (text) {
                return text;
              }
            }
          }
        }

        const wrapped = read(element.closest("label")?.textContent);
        if (wrapped) {
          return wrapped;
        }

        const describedBy = (element.getAttribute("aria-describedby") || "").trim();
        if (describedBy) {
          for (const describedId of describedBy.split(/\s+/).filter(Boolean)) {
            const text = read(document.getElementById(describedId)?.textContent);
            if (text && !/^(required|optional|mandatory)$/i.test(text)) {
              return text;
            }
          }
        }

        const cleanAdjacentLabel = (value: string) =>
          read(value)
            .replace(/^the field\s+/i, "")
            .replace(/\s*\.\s*$/g, "")
            .replace(/\s+/g, " ")
            .trim();
        let previous = element.previousElementSibling;
        for (let index = 0; previous && index < 6; index += 1, previous = previous.previousElementSibling) {
          const text = cleanAdjacentLabel(previous.textContent || "");
          if (text && text.length <= 160) {
            return text;
          }
        }

        const cell = element.closest("td, th");
        const row = element.closest("tr");
        if (cell && row) {
          const cells = Array.from(row.children);
          const cellIndex = cells.indexOf(cell);
          for (let index = cellIndex - 1; index >= 0; index -= 1) {
            const text = cleanAdjacentLabel(cells[index]?.textContent || "");
            if (text && text.length <= 320) {
              return text;
            }
          }
        }

        const containers = [
          element.closest(".ashby-application-form-field-entry"),
          element.closest('[class*="fieldEntry"]'),
          element.closest("spl-internal-form-field"),
          element.closest("spl-form-field"),
          element.closest("oc-input"),
          element.closest("oc-phone-number"),
          element.closest("oc-apply-with-resume"),
          element.closest('[data-automation-id="formField"]'),
          element.closest('[data-automation-id="multiselectInput"]'),
          element.closest("fieldset"),
          element.closest('[role="group"]'),
          element.closest(".application-question"),
          element.closest(".select"),
          element.closest(".select__container"),
          element.closest(".select-shell"),
          element.closest(".input-wrapper"),
          element.closest(".text-input-wrapper"),
          element.closest(".checkbox"),
          element.closest(".checkbox__wrapper"),
          element.closest(".form-field"),
          element.closest(".field"),
          element.closest('[class*="question"]'),
          element.closest('[class*="field"]'),
        ].filter(Boolean) as HTMLElement[];

        for (const container of containers) {
          const candidates = container.querySelectorAll(
            'label, legend, .ashby-application-form-question-title, [class*="question-title"], [class*="questionTitle"], [data-automation-id="formLabel"], [data-automation-id="fieldLabel"], [data-automation-id="prompt"], .application-label, .field-label, .question-label, [class*="label"], [class*="Label"]',
          );
          for (const candidate of Array.from(candidates)) {
            const text = read(candidate.textContent);
            if (text && text.length <= 320) {
              return text;
            }
          }
        }

        return "";
      })
      .catch(() => ""),
  );
  const ariaLabel = tidy(await field.getAttribute("aria-label").catch(() => ""));
  const placeholder = tidy(await field.getAttribute("placeholder").catch(() => ""));
  const knownIdentifierLabel = labelFromKnownFieldIdentifier(identifier);

  const rawCandidates = [
    evaluated,
    ariaLabel,
    placeholder,
    knownIdentifierLabel,
    !looksLikeMachineGeneratedFieldIdentifier(name) ? name : "",
    !looksLikeMachineGeneratedFieldIdentifier(id) ? id : "",
  ];
  const rawLabel = rawCandidates.map((candidate) => cleanExtractedLabel(candidate)).find(Boolean) || "";
  return refineFieldLabelFromIdentifier(rawLabel, identifier);
}

async function hasRequiredMarker(target: Locator): Promise<boolean> {
  return target
    .evaluate((node) => {
      const element = node as HTMLElement;
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const hasMarker = (candidate: Element | null | undefined) => {
        if (!candidate) {
          return false;
        }

        const htmlElement = candidate as HTMLElement;
        const className = `${htmlElement.className || ""}`.toLowerCase();
        const text = read(htmlElement.textContent);
        return className.includes("required") || /\*/.test(text);
      };

      if (element.getAttribute("required") !== null || element.getAttribute("aria-required") === "true") {
        return true;
      }

      const id = element.getAttribute("id");
      const name = element.getAttribute("name") || "";
      const identifier = `${id || ""} ${name}`;
      if (
        /dialogTemplate-dialogForm/i.test(identifier) &&
        /(login-name|login-password|userName|passwordConfirm|emailConfirm|\bpassword\b|\bemail\b)/i.test(identifier)
      ) {
        return true;
      }

      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (hasMarker(label)) {
          return true;
        }
      }

      if (hasMarker(element.closest("label"))) {
        return true;
      }

      let previous = element.previousElementSibling;
      for (let index = 0; previous && index < 6; index += 1, previous = previous.previousElementSibling) {
        if (hasMarker(previous)) {
          return true;
        }
      }

      const containers = [
        element.closest(".ashby-application-form-field-entry"),
        element.closest('[class*="fieldEntry"]'),
        element.closest('[data-automation-id="formField"]'),
        element.closest("fieldset"),
        element.closest('[role="group"]'),
        element.closest('[role="radiogroup"]'),
        element.closest(".application-question"),
        element.closest(".form-field"),
        element.closest(".field"),
      ].filter((candidate): candidate is HTMLElement => Boolean(candidate));

      for (const container of containers) {
        if (hasMarker(container)) {
          return true;
        }

        const labelLike = container.querySelector(
          'label, legend, .ashby-application-form-question-title, [class*="question-title"], [class*="questionTitle"], [data-automation-id="formLabel"], [data-automation-id="fieldLabel"], [data-automation-id="prompt"], .application-label, .field-label, .question-label, [class*="label"], [class*="Label"]',
        );
        if (hasMarker(labelLike)) {
          return true;
        }
      }

      return false;
    })
    .catch(() => false);
}

function labelHasRequiredMarker(label: string): boolean {
  return /\b(required|mandatory)\b/i.test(label) || /\*/.test(label);
}

function pushUniqueApplicationField(fields: ApplicationField[], candidate: ApplicationField): void {
  const key = `${candidate.label.toLowerCase()}::${candidate.type.toLowerCase()}::${candidate.required ? "required" : "optional"}`;
  const exists = fields.some(
    (field) =>
      `${field.label.toLowerCase()}::${field.type.toLowerCase()}::${field.required ? "required" : "optional"}` ===
      key,
  );
  if (!exists) {
    fields.push(candidate);
  }
}

async function inspectApplicationFields(scope: LocatorScope): Promise<ApplicationField[]> {
  const fieldLocator = scope.locator(
    'input, textarea, select, [contenteditable="true"], [role="combobox"], button[aria-haspopup="listbox"]',
  );
  const count = await fieldLocator.count();
  const fields: ApplicationField[] = [];

  for (let index = 0; index < count; index += 1) {
    const field = fieldLocator.nth(index);
    const isVisible = await field.isVisible().catch(() => false);
    if (!isVisible) continue;

    const role = tidy(await field.getAttribute("role").catch(() => ""));
    const popup = tidy(await field.getAttribute("aria-haspopup").catch(() => ""));
    const label = await extractLocatorLabel(field);

    const type =
      (role === "combobox" || popup === "listbox" ? "combobox" : "") ||
      tidy(await field.getAttribute("type").catch(() => "")) ||
      (await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "unknown"));
    if (["hidden", "submit", "button", "reset"].includes(type.toLowerCase())) {
      continue;
    }

    const fieldName =
      tidy(await field.getAttribute("name").catch(() => "")) ||
      tidy(await field.getAttribute("id").catch(() => ""));
    const accept = tidy(await field.getAttribute("accept").catch(() => ""));
    const displayLabel = type === "file" ? deriveFileFieldLabel(label, fieldName, accept) : label;
    const required =
      (await hasRequiredMarker(field)) ||
      labelHasRequiredMarker(displayLabel) ||
      isKnownRequiredFieldIdentifier(fieldName);

    pushUniqueApplicationField(fields, {
      label: displayLabel || "Unlabeled field",
      type,
      required,
    });
  }

  const radioGroups = scope.locator(
    'fieldset, [role="radiogroup"], [role="group"], [data-automation-id="radioGroup"], .application-question, .ashby-application-form-field-entry, [class*="ashby-application-form-field-entry"], [class*="fieldEntry"]',
  );
  const radioCount = await radioGroups.count();
  for (let index = 0; index < radioCount; index += 1) {
    const group = radioGroups.nth(index);
    const visible = await group.isVisible().catch(() => false);
    if (!visible) continue;

    const radioControlCount = await group.locator('input[type="radio"], [role="radio"]').count().catch(() => 0);
    if (radioControlCount < 2) continue;

    const label =
      tidy(await group.locator("legend").first().textContent({ timeout: 500 }).catch(() => "")) ||
      tidy(await group.getAttribute("aria-label").catch(() => "")) ||
      tidy(
        await group
          .locator(
            'label, .ashby-application-form-question-title, [class*="question-title"], [class*="questionTitle"], [data-automation-id="formLabel"], [data-automation-id="fieldLabel"], [data-automation-id="prompt"]',
          )
          .first()
          .textContent({ timeout: 500 })
          .catch(() => ""),
      );
    const required = (await hasRequiredMarker(group)) || labelHasRequiredMarker(label);

    const optionCount = await group.locator('label, [role="radio"]').count().catch(() => 0);
    if (optionCount < 2) continue;

    pushUniqueApplicationField(fields, {
      label: label || "Unlabeled radio group",
      type: "radio",
      required,
    });
  }

  return fields;
}

async function inspectWorkdayApplicationFields(page: Page): Promise<ApplicationField[]> {
  const fields = await page.evaluate(() => {
    function __name<T>(target: T): T {
      return target;
    }

    const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const visible = (element: Element) => {
      const html = element as HTMLElement;
      const style = window.getComputedStyle(html);
      const rect = html.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const isMeaningful = (value: string) =>
      Boolean(value) && !/^(select|select one|select an option|choose|choose one|please select|not specified|not selected)$/i.test(value);
    const labelFromIdentifier = (identifier: string) =>
      identifier
        .replace(/^.*--/, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const cleanLabel = (label: string) =>
      read(label)
        .replace(/\bRequired\b/gi, "")
        .replace(/\*/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const results: ApplicationField[] = [];
    const push = (label: string, type: string, required: boolean) => {
      const clean = cleanLabel(label) || "Unlabeled field";
      const key = `${clean.toLowerCase()}::${type.toLowerCase()}::${required ? "required" : "optional"}`;
      if (!results.some((field) => `${field.label.toLowerCase()}::${field.type.toLowerCase()}::${field.required ? "required" : "optional"}` === key)) {
        results.push({ label: clean, type, required });
      }
    };

    for (const element of Array.from(
      document.querySelectorAll('input:not([type="hidden"]), textarea, select, [role="combobox"], input[role="combobox"], button[aria-haspopup="listbox"]'),
    )) {
      if (!visible(element)) continue;
      const html = element as HTMLElement;
      const tag = html.tagName.toLowerCase();
      const type =
        html.getAttribute("role") === "combobox" || html.getAttribute("aria-haspopup") === "listbox"
          ? "combobox"
          : html.getAttribute("type") || tag;
      if (/^(hidden|submit|button|reset|password)$/i.test(type)) continue;
      if (html.getAttribute("data-automation-id") === "beecatcher") continue;
      if (/utilityMenuButton|navigationItem|backToJobPosting|socialIcon|privacyLink/i.test(html.getAttribute("data-automation-id") || "")) continue;

      const id = html.getAttribute("id") || "";
      const name = html.getAttribute("name") || "";
      const aria = html.getAttribute("aria-label") || "";
      const text = read(html.textContent);
      const value = read((element as HTMLInputElement).value);
      const label =
        aria ||
        read(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) ||
        labelFromIdentifier(name || id) ||
        text ||
        value;
      const required =
        /\bRequired\b/i.test(aria) ||
        html.hasAttribute("required") ||
        html.getAttribute("aria-required") === "true" ||
        Boolean(html.closest('[data-automation-id="formField"]')?.textContent?.includes("*"));
      push(label, type, required);
    }

    for (const group of Array.from(document.querySelectorAll("fieldset, [role='radiogroup']"))) {
      if (!visible(group)) continue;
      const radios = Array.from(group.querySelectorAll('input[type="radio"], [role="radio"]'));
      if (radios.length < 2) continue;
      const label =
        read(group.querySelector("legend")?.textContent) ||
        read(group.getAttribute("aria-label")) ||
        read(group.textContent).replace(/\bYes\b.*\bNo\b.*/i, "").trim();
      const required = /\*/.test(read(group.textContent)) || /\bRequired\b/i.test(read(group.textContent));
      push(label || "Unlabeled radio group", "radio", required);
    }

    return results.filter((field) => {
      if (/^(settings|search|candidate home|job alerts|back to job posting)$/i.test(field.label)) return false;
      if (/^phone extension$/i.test(field.label)) return true;
      return isMeaningful(field.label);
    });
  });

  return fields;
}

async function resolvePrimaryApplicationScope(page: Page, siteKind: ApplicationSiteKind): Promise<LocatorScope> {
  const preferredSelectors =
    siteKind === "workday"
      ? ['[data-automation-id="jobApplication"]']
      : siteKind === "lever"
        ? [".application-page", 'form[data-qa="application-form"]', '[data-qa="application-form"]']
        : siteKind === "greenhouse"
          ? ['#application', 'form[action*="form_submissions"]', 'form[action*="greenhouse"]']
          : siteKind === "ashby"
            ? ['[role="tabpanel"]', '.ashby-application-form-section-container', '[class*="ashby-application-form-field-entry"]']
            : siteKind === "taleo"
              ? ['form[id*="dialogTemplate-dialogForm"]', 'form[name*="dialogTemplate-dialogForm"]', "form"]
              : siteKind === "talemetry"
                ? ["main", "form", "#root"]
                : siteKind === "phenom"
                  ? ["main", "form", "#root", "#apply", "#content"]
                  : siteKind === "oraclehcm"
                    ? [".apply-flow", "main", "form"]
          : [];

  for (const selector of preferredSelectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const relevantCount = await locator
      .locator('input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="combobox"], button[aria-haspopup="listbox"]')
      .count()
      .catch(() => 0);
    if (relevantCount > 0) {
      return locator;
    }
  }

  const forms = page.locator("form");
  const count = Math.min(await forms.count().catch(() => 0), 10);
  let best: { score: number; locator: Locator } | null = null;

  for (let index = 0; index < count; index += 1) {
    const locator = forms.nth(index);
    const relevantCount = await locator
      .locator('input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="combobox"], button[aria-haspopup="listbox"]')
      .count()
      .catch(() => 0);
    if (relevantCount === 0) {
      continue;
    }

    const requiredCount = await locator.locator('[required], [aria-required="true"]').count().catch(() => 0);
    const fileCount = await locator.locator('input[type="file"]').count().catch(() => 0);
    const score = requiredCount * 10 + fileCount * 5 + relevantCount;

    if (!best || score > best.score) {
      best = { score, locator };
    }
  }

  return best?.locator ?? page;
}

type AutofillPassResult = {
  filled: string[];
  skipped: string[];
  decisions: QuestionDecision[];
};

function normalizeQuestionText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNonDisclosureOption(value: string): boolean {
  return /prefer not|decline|self identify|wish to answer|do not wish|do not want|choose not|rather not|no answer|not say|not declar|not disclos/.test(
    normalizeQuestionText(value),
  );
}

function matchesDesiredChoice(actualValue: string, desiredValue: string): boolean {
  const normalizedActual = normalizeQuestionText(actualValue);
  const normalizedDesired = normalizeQuestionText(desiredValue);
  if (!normalizedActual || !normalizedDesired) {
    return false;
  }

  return (
    normalizedActual === normalizedDesired ||
    normalizedActual.includes(normalizedDesired) ||
    normalizedDesired.includes(normalizedActual) ||
    (isNonDisclosureOption(actualValue) && isNonDisclosureOption(desiredValue))
  );
}

function dedupeText(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildAutofillResult(
  filled: string[],
  skipped: string[],
  nextAction: string,
  options: {
    stoppedBeforeSubmit: boolean;
    submitted?: boolean;
    stopReason?: string;
    debugSteps?: AutofillResult["debugSteps"];
  },
): AutofillResult {
  const result: AutofillResult = {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    nextAction,
    stoppedBeforeSubmit: options.stoppedBeforeSubmit,
  };

  if (typeof options.submitted === "boolean") {
    result.submitted = options.submitted;
  }
  if (options.stopReason) {
    result.stopReason = options.stopReason;
  }
  if (options.debugSteps?.length) {
    result.debugSteps = options.debugSteps;
  }

  return result;
}

async function annotateAutofillResultWithPageState(page: Page, result: AutofillResult): Promise<AutofillResult> {
  result.finalUrl = page.url();
  result.finalTitle = tidy(await page.title().catch(() => ""));

  if (!result.submitted) {
    return result;
  }

  const bodyText = tidy(await page.locator("body").innerText().catch(() => "")).slice(0, 3000);
  const sessionStorageApplySuccess = await page
    .evaluate(() => sessionStorage.getItem("applySuccess") || "")
    .catch(() => "");
  let candidateInterviewUrl = "";
  if (sessionStorageApplySuccess) {
    try {
      const parsed = JSON.parse(sessionStorageApplySuccess) as { candidateInterviewUrl?: string };
      candidateInterviewUrl = parsed.candidateInterviewUrl || "";
    } catch {
      candidateInterviewUrl = "";
    }
  }
  if (!candidateInterviewUrl) {
    candidateInterviewUrl =
      (await page
        .locator('a[href*="interview.micro1.ai"], a[href*="interview"]')
        .first()
        .getAttribute("href")
        .catch(() => "")) || "";
  }

  result.postSubmitDetails = {
    bodyText,
    sessionStorageApplySuccess,
    candidateInterviewUrl,
  };
  return result;
}

function isLinkedInSubmitAction(label: string): boolean {
  return /submit/i.test(label);
}

function isSiteFinalAction(label: string): boolean {
  return /submit|send|finish|complete|confirm/i.test(label.trim());
}

function makeQuestionFingerprint(question: FormQuestion): string {
  return [
    normalizeQuestionText(question.label),
    normalizeQuestionText(question.type),
    question.choices.map((choice) => normalizeQuestionText(choice)).sort().join("|"),
  ].join("::");
}

function isMeaningfulValue(value: string): boolean {
  if (value.trim() === "-1000") {
    return false;
  }

  const normalized = normalizeQuestionText(value);
  return (
    Boolean(normalized) &&
    !/^(select|select an option|select option|choose|choose one|please select|not specified|not selected)$/.test(
      normalized,
    )
  );
}

function inferFileUploadPurpose(label: string, fieldName: string, accept: string): "resume" | "coverLetter" | null {
  const normalized = normalizeQuestionText([label, fieldName, accept].join(" "));
  if (isImageLikeFileUpload(label, fieldName, accept)) {
    return null;
  }
  if (/\b(cover letter|motivation|supporting statement)\b/.test(normalized)) {
    return "coverLetter";
  }
  if (/\b(resume|cv|curriculum vitae)\b/.test(normalized)) {
    return "resume";
  }
  if (/\battach|upload|drop files?\b/.test(normalized)) {
    return "resume";
  }

  return null;
}

function isImageLikeFileUpload(label: string, fieldName: string, accept: string): boolean {
  const normalized = normalizeQuestionText([label, fieldName, accept].join(" "));
  if (/\b(resume|cv|curriculum vitae|cover letter)\b/.test(normalized)) {
    return false;
  }

  return /\b(photo|avatar|headshot|profile picture|portrait|image|png|jpg|jpeg|gif|webp)\b/.test(normalized);
}

function isGenericFileLabel(label: string): boolean {
  const normalized = normalizeQuestionText(label);
  return normalized === "attach" || normalized === "upload" || normalized === "file";
}

function titleCaseWords(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatFieldNameLabel(fieldName: string): string {
  const normalized = tidy(fieldName)
    .replace(/\[[^\]]+\]/g, (match) => ` ${match.slice(1, -1)} `)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  return titleCaseWords(normalized);
}

function deriveFileFieldLabel(label: string, fieldName: string, accept: string): string {
  const purpose = inferFileUploadPurpose(label, fieldName, accept);
  if (purpose === "resume") {
    return "Resume/CV";
  }
  if (purpose === "coverLetter") {
    return "Cover Letter";
  }

  if (!label || isGenericFileLabel(label)) {
    const fallback = formatFieldNameLabel(fieldName);
    if (fallback) {
      return fallback;
    }
  }

  return label || formatFieldNameLabel(fieldName) || "File Upload";
}

async function uploadFile(page: Page, field: Locator, filePath: string): Promise<boolean> {
  if (!filePath.trim()) {
    return false;
  }

  const disabled = await field.isDisabled().catch(() => false);
  if (disabled) {
    return false;
  }

  await field.setInputFiles(filePath).catch(() => undefined);
  const filename = path.basename(filePath);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const uploadCount = await field.evaluate((node) => (node as HTMLInputElement).files?.length ?? 0).catch(() => 0);
    if (uploadCount > 0) {
      if (isAshbyUrl(page.url())) {
        for (let ashbyAttempt = 0; ashbyAttempt < 8; ashbyAttempt += 1) {
          const bodyText = await page.locator("body").innerText().catch(() => "");
          if (bodyText.includes(filename)) {
            return true;
          }
          if (ashbyAttempt >= 3 && !/uploading|processing/i.test(bodyText)) {
            return true;
          }
          await page.waitForTimeout(500);
        }
      }
      return true;
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (bodyText.includes(filename)) {
      return true;
    }

    await page.waitForTimeout(500);
  }

  return false;
}

async function dismissTaleoAttachmentOverwriteDialog(page: Page): Promise<boolean> {
  const cancelButton = page
    .locator(
      [
        'input[type="button"][id*="NoOverwriteFileCommand"]',
        'input[type="button"][name*="NoOverwriteFileCommand"]',
        'input[type="button"][value="No"][title*="Cancel"]',
        'button:has-text("No")',
      ].join(", "),
    )
    .first();

  if (await cancelButton.isVisible().catch(() => false)) {
    await cancelButton.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(800).catch(() => undefined);
    await clearTaleoAttachmentFileInputs(page).catch(() => undefined);
    return true;
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (!/this file has already been attached/i.test(bodyText)) {
    return false;
  }

  const roleButton = page.getByRole("button", { name: /^No$/i }).first();
  if (await roleButton.isVisible().catch(() => false)) {
    await roleButton.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(800).catch(() => undefined);
    await clearTaleoAttachmentFileInputs(page).catch(() => undefined);
    return true;
  }

  return false;
}

async function clearTaleoAttachmentFileInputs(page: Page): Promise<boolean> {
  if ((await detectApplicationSiteKind(page)) !== "taleo") {
    return false;
  }

  return page
    .evaluate(() => {
      const inputs = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          [
            'input[type="file"][id*="AttachedFilesBlock"]',
            'input[type="file"][name*="AttachedFilesBlock"]',
            'input[type="file"][id*="uploadedFile"]',
            'input[type="file"][name*="uploadedFile"]',
          ].join(", "),
        ),
      );
      let cleared = false;

      for (const input of inputs) {
        if (!input.value && (input.files?.length ?? 0) === 0) {
          continue;
        }

        try {
          input.value = "";
        } catch {
          continue;
        }

        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        cleared = true;
      }

      return cleared;
    })
    .catch(() => false);
}

async function isTaleoAttachmentAlreadyPresent(
  page: Page,
  filePath: string,
  purpose: "resume" | "coverLetter",
): Promise<boolean> {
  if ((await detectApplicationSiteKind(page)) !== "taleo") {
    return false;
  }

  const normalizedFileName = normalizeQuestionText(path.basename(filePath));
  if (!normalizedFileName) {
    return false;
  }

  return page
    .evaluate(
      ({ normalizedFileName: expectedFileName, purpose: expectedPurpose }) => {
        const normalize = (value: string): string =>
          value
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[_-]+/g, " ")
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const isVisible = (element: Element): boolean => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const readElementText = (element: Element): string =>
          [
            element.textContent || "",
            element.getAttribute("title") || "",
            element.getAttribute("aria-label") || "",
            element instanceof HTMLInputElement ? element.value : "",
          ].join(" ");
        const attachmentSelectors = [
          'a[href*="viewAttachedFile"]',
          'a[href*="attachment"]',
          'a[href*="download"]',
          '[id*="Attachment"]',
          '[id*="attachment"]',
          '[id*="file"]',
          '[class*="attachment"]',
          '[class*="file"]',
          "td",
          "li",
        ];
        const attachmentText = attachmentSelectors
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          .filter((element) => isVisible(element))
          .map((element) => readElementText(element))
          .join(" ");
        const normalizedAttachmentText = normalize(attachmentText);
        if (expectedFileName && normalizedAttachmentText.includes(expectedFileName)) {
          return true;
        }

        const rawBodyText = document.body?.innerText || "";
        if (/this file has already been attached/i.test(rawBodyText)) {
          return true;
        }

        if (expectedPurpose === "resume") {
          const resumeSelection = Array.from(
            document.querySelectorAll(
              'input[type="checkbox"][id*="resumeselectionid"], input[type="checkbox"][name*="resumeselectionid"]',
            ),
          ).filter((element) => isVisible(element));
          if (resumeSelection.length > 0) {
            const normalizedBodyText = normalize(rawBodyText);
            return /\b(resume|cv|document|attached|file)\b/.test(normalizedBodyText);
          }
        }

        return false;
      },
      { normalizedFileName, purpose },
    )
    .catch(() => false);
}

async function runFileAutofill(page: Page, profile: Profile): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  return runFileAutofillWithinScope(page, page, profile);
}

async function runFileAutofillWithinScope(
  page: Page,
  scope: LocatorScope,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const resumeFilePath = await resolveResumeFilePath(profile);
  const coverLetterFilePath = await resolveCoverLetterFilePath(profile);
  const fileInputs = scope.locator('input[type="file"]');
  const count = await fileInputs.count().catch(() => 0);
  const filled: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let resumeUsed = false;
  let coverLetterUsed = false;

  for (let index = 0; index < count; index += 1) {
    const field = fileInputs.nth(index);
    const label = await extractLocatorLabel(field);
    const fieldName =
      tidy(await field.getAttribute("name").catch(() => "")) ||
      tidy(await field.getAttribute("id").catch(() => ""));
    const accept = tidy(await field.getAttribute("accept").catch(() => ""));
    const displayLabel = deriveFileFieldLabel(label, fieldName, accept);

    let purpose = inferFileUploadPurpose(label, fieldName, accept);
    if (!purpose && !resumeUsed && !isImageLikeFileUpload(label, fieldName, accept)) {
      purpose = "resume";
    }

    if (!purpose) {
      skipped.push(displayLabel || `file upload ${index + 1}`);
      continue;
    }

    const key = `${purpose}::${label || fieldName || index}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const filePath = purpose === "coverLetter" ? coverLetterFilePath : resumeFilePath;
    const resultLabel =
      !label || isGenericFileLabel(label)
        ? purpose === "coverLetter"
          ? "cover letter upload"
          : "resume upload"
        : displayLabel;
    if (!filePath) {
      skipped.push(resultLabel);
      continue;
    }

    if (await isTaleoAttachmentAlreadyPresent(page, filePath, purpose)) {
      await clearTaleoAttachmentFileInputs(page).catch(() => undefined);
      filled.push(resultLabel);
      if (purpose === "coverLetter") {
        coverLetterUsed = true;
      } else {
        resumeUsed = true;
      }
      continue;
    }

    const uploaded = await uploadFile(page, field, filePath);
    const duplicateAttachmentCancelled = await dismissTaleoAttachmentOverwriteDialog(page);
    if (duplicateAttachmentCancelled) {
      await clearTaleoAttachmentFileInputs(page).catch(() => undefined);
    }
    if (uploaded || duplicateAttachmentCancelled) {
      filled.push(resultLabel);
      if (purpose === "coverLetter") {
        coverLetterUsed = true;
      } else {
        resumeUsed = true;
      }
    } else {
      skipped.push(resultLabel);
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function findFirstVisibleField(scope: LocatorScope, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const matches = scope.locator(selector);
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const locator = matches.nth(index);
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
  }

  return null;
}

async function findVisibleFieldByQuestionPatterns(
  scope: LocatorScope,
  patterns: string[],
): Promise<{ field: Locator; question: FormQuestion & { tag: string } } | null> {
  const normalizedPatterns = patterns.map((pattern) => normalizeQuestionText(pattern)).filter(Boolean);
  const fields = scope.locator(
    'input, textarea, select, [contenteditable="true"], [role="combobox"], input[role="combobox"], button[aria-haspopup="listbox"]',
  );
  const count = await fields.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const field = fields.nth(index);
    const question = await describeVisibleField(field);
    if (!question || ["hidden", "submit", "button"].includes(question.type)) {
      continue;
    }

    const haystack = normalizeQuestionText(question.label);
    if (!haystack) {
      continue;
    }
    if (
      normalizedPatterns.some((pattern) => haystack.includes(pattern))
    ) {
      return { field, question };
    }
  }

  return null;
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function findHostedFieldByLabelPatterns(
  scope: LocatorScope,
  patterns: string[],
): Promise<{ field: Locator; label: string; type: string; tag: string } | null> {
  const normalizedPatterns = patterns.map((pattern) => normalizeQuestionText(pattern)).filter(Boolean);
  const candidates = await scope
    .locator('input, textarea, select, [role="combobox"], button[aria-haspopup="listbox"]')
    .evaluateAll((nodes, rawPatterns) => {
      const normalize = (value: string) =>
        value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const weakLabel = (value: string) => /^(select|select\.\.|required|optional)$/i.test(read(value));
      const nearbyLabel = (element: HTMLElement) => {
        const containers = [
          element.closest(".field"),
          element.closest(".application-question"),
          element.closest('[class*="field"]'),
          element.closest('[class*="question"]'),
          element.parentElement?.parentElement,
          element.parentElement,
        ].filter((candidate): candidate is HTMLElement => Boolean(candidate));
        for (const container of containers) {
          const candidates = container.querySelectorAll(
            'label, legend, [class*="label"], [class*="Label"]',
          );
          for (const candidate of Array.from(candidates)) {
            const text = read(candidate.textContent);
            if (text && !weakLabel(text)) {
              return text;
            }
          }
        }
        return "";
      };
      const patterns = (rawPatterns as string[]).map(normalize).filter(Boolean);

      return nodes
        .map((node) => {
          const element = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            return null;
          }

          const id = element.getAttribute("id") || "";
          const name = element.getAttribute("name") || "";
          let label = "";
          if (id) {
            label = read(document.querySelector(`label[for="${id}"]`)?.textContent);
          }
          if (!label) {
            label = read(element.closest("label")?.textContent);
          }
          if (!label) {
            label = read(element.getAttribute("aria-label")) || read(element.getAttribute("placeholder"));
          }
          if (!label || weakLabel(label)) {
            label = nearbyLabel(element) || label;
          }

          const normalizedLabel = normalize(label);
          if (!normalizedLabel || !patterns.some((pattern) => normalizedLabel.includes(pattern))) {
            return null;
          }

          const type =
            element.getAttribute("role") === "combobox" || element.getAttribute("aria-haspopup") === "listbox"
              ? "combobox"
              : element.getAttribute("type") || element.tagName.toLowerCase();
          return {
            id,
            name,
            label,
            tag: type === "combobox" ? "combobox" : element.tagName.toLowerCase(),
            type,
          };
        })
        .filter(Boolean);
    }, normalizedPatterns)
    .catch(() => []);

  const [candidate] = candidates as Array<{
    id: string;
    name: string;
    label: string;
    tag: string;
    type: string;
  }>;
  if (!candidate) {
    return null;
  }

  let field: Locator | null = null;
  if (candidate.id) {
    field = scope.locator(`[id="${escapeAttributeValue(candidate.id)}"]`).first();
  } else if (candidate.name) {
    field = scope.locator(`[name="${escapeAttributeValue(candidate.name)}"]`).first();
  }

  if (!field || !(await field.isVisible().catch(() => false))) {
    return null;
  }

  return {
    field,
    label: cleanExtractedLabel(candidate.label) || candidate.label,
    type: candidate.type,
    tag: candidate.tag,
  };
}

type DirectSiteAutofillResult = Pick<AutofillPassResult, "filled" | "skipped"> & {
  handled?: boolean;
  advanced?: boolean;
  submitted?: boolean;
};

type SuccessFactorsDomResult = {
  ok: boolean;
  changed?: boolean;
  reason?: string;
  value?: string;
};

function recordSuccessFactorsResult(
  result: SuccessFactorsDomResult,
  label: string,
  filled: string[],
  skipped: string[],
): void {
  if (result.ok) {
    filled.push(label);
    return;
  }
  if (result.reason && result.reason !== "missing") {
    skipped.push(`${label}: ${result.reason}`);
  }
}

async function hasSuccessFactorsApplicationSignals(page: Page): Promise<boolean> {
  if ((await detectApplicationSiteKind(page)) === "successfactors") {
    return true;
  }

  return (
    (await page
      .locator(
        '#rcmJobApplicationCtr, input[name="career_ns"][value="job_application"], .RCMFormField.rcmFormQuestionElement, .rcmFormQuestionLabel, [id$="_submitBtn"]',
      )
      .count()
      .catch(() => 0)) > 0
  );
}

async function activateAmericanAirlinesManualApplyIfPresent(page: Page): Promise<DirectSiteAutofillResult> {
  if (!/jobs\.aa\.com\/job\//i.test(page.url())) {
    return { filled: [], skipped: [], handled: false };
  }

  const clicked = await page
    .evaluate(() => {
      const visible = (element: Element) => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const dispatchClick = (element: Element) => {
        const html = element as HTMLElement;
        html.scrollIntoView({ block: "center", inline: "nearest" });
        for (const type of ["mousedown", "mouseup", "click"]) {
          html.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      };
      const applyButton =
        Array.from(document.querySelectorAll<HTMLElement>("#unifyApplyNowTopButton, button, a")).find((candidate) => {
          const text = (candidate.textContent || candidate.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
          return visible(candidate) && /^apply now$/i.test(text);
        }) ?? null;
      if (!applyButton) {
        return false;
      }
      dispatchClick(applyButton);
      return true;
    })
    .catch(() => false);

  if (!clicked) {
    return { filled: [], skipped: ["American Airlines Apply now"], handled: false };
  }

  await page.waitForTimeout(800).catch(() => undefined);
  const manualClicked = await page
    .evaluate(() => {
      const visible = (element: Element) => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const manual =
        Array.from(document.querySelectorAll<HTMLElement>("#applyOption--manual")).find(visible) ??
        document.querySelector<HTMLElement>("#applyOption--manual");
      if (!manual) {
        return false;
      }
      manual.scrollIntoView({ block: "center", inline: "nearest" });
      for (const type of ["mousedown", "mouseup", "click"]) {
        manual.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })
    .catch(() => false);

  if (!manualClicked) {
    return { filled: ["American Airlines Apply now"], skipped: ["American Airlines manual apply option"], handled: true };
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(4_000).catch(() => undefined);
  return { filled: ["American Airlines manual apply"], skipped: [], handled: true, advanced: true };
}

async function expandSuccessFactorsSections(page: Page): Promise<boolean> {
  const clicked = await clickFirstVisible(page, [
    'a[role="button"]:has-text("Expand all sections")',
    'button:has-text("Expand all sections")',
    '[id$="_expandAll"]',
  ]);
  if (clicked) {
    await page.waitForTimeout(900).catch(() => undefined);
    return true;
  }

  return page
    .evaluate(() => {
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const buttons = Array.from(document.querySelectorAll<HTMLElement>('a[role="button"], button, [role="button"]'));
      let expanded = false;
      for (const button of buttons) {
        const text = read([button.textContent, button.getAttribute("aria-label"), button.getAttribute("title")].join(" "));
        if (!/expand/.test(text) || /collapse/.test(text)) {
          continue;
        }
        button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        button.click();
        expanded = true;
      }
      return expanded;
    })
    .catch(() => false);
}

async function signInSuccessFactorsIfPresent(
  page: Page,
  profile: Profile,
): Promise<DirectSiteAutofillResult | null> {
  const passwordField = page.locator('input[type="password"]').first();
  if (!(await passwordField.isVisible().catch(() => false))) {
    return null;
  }

  const password = (process.env.JAA_SUCCESSFACTORS_PASSWORD || process.env.JAA_WORKDAY_PASSWORD || "").trim();
  if (!password) {
    return {
      filled: [],
      skipped: ["SuccessFactors sign-in password not configured"],
      handled: true,
    };
  }

  const userField = page
    .locator(
      'input[type="email"], input[name*="email" i], input[id*="email" i], input[name*="user" i], input[id*="user" i], input[type="text"]',
    )
    .first();
  const filled: string[] = [];
  const skipped: string[] = [];
  const userApplied = await userField.fill(profile.email, { timeout: 5_000 }).then(() => true).catch(() => false);
  if (userApplied) filled.push("SuccessFactors username");
  else skipped.push("SuccessFactors username");
  const passwordApplied = await passwordField.fill(password, { timeout: 5_000 }).then(() => true).catch(() => false);
  if (passwordApplied) filled.push("SuccessFactors password");
  else skipped.push("SuccessFactors password");

  const clicked = await clickFirstVisible(page, [
    'button:has-text("Sign In")',
    'button:has-text("Log In")',
    'button:has-text("Login")',
    'input[type="submit" i][value*="Sign" i]',
    'input[type="submit" i][value*="Log" i]',
  ]);
  if (clicked) {
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000).catch(() => undefined);
    return { filled, skipped, handled: true, advanced: true };
  }

  skipped.push("SuccessFactors sign in");
  return { filled, skipped, handled: true };
}

async function fillSuccessFactorsTextByNames(
  page: Page,
  names: string[],
  value: string,
): Promise<SuccessFactorsDomResult> {
  if (!value.trim()) {
    return { ok: false, reason: "empty value" };
  }

  for (const name of names) {
    const selectors = [
      `input[name="${escapeAttributeValue(name)}"]:not([type="hidden"]):not([type="file"])`,
      `textarea[name="${escapeAttributeValue(name)}"]`,
      `input[id*="${escapeAttributeValue(name)}"]:not([type="hidden"]):not([type="file"])`,
      `textarea[id*="${escapeAttributeValue(name)}"]`,
    ];
    for (const selector of selectors) {
      const fields = page.locator(selector);
      const count = Math.min(await fields.count().catch(() => 0), 4);
      for (let index = 0; index < count; index += 1) {
        const field = fields.nth(index);
        if (!(await field.isVisible().catch(() => false))) {
          continue;
        }
        const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "input");
        const current = tidy(await readFieldCurrentValue(field, tag, "").catch(() => ""));
        if (matchesDesiredChoice(current, value)) {
          return { ok: true, changed: false, value: current };
        }
        const applied = await setEditableFieldValue(page, field, tag, value).catch(() => false);
        const next = tidy(await readFieldCurrentValue(field, tag, "").catch(() => ""));
        if (applied || matchesDesiredChoice(next, value)) {
          return { ok: true, changed: true, value: next || value };
        }
      }
    }
  }

  return { ok: false, reason: "missing" };
}

async function setSuccessFactorsCheckboxByNames(
  page: Page,
  names: string[],
  checked: boolean,
): Promise<SuccessFactorsDomResult> {
  return page
    .evaluate(
      ({ names: rawNames, checked: desired }) => {
        const normalize = (value: string | null | undefined) =>
          (value ?? "")
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const wanted = rawNames.map(normalize).filter(Boolean);
        const readContext = (element: HTMLElement) =>
          [
            element.getAttribute("name"),
            element.getAttribute("id"),
            element.getAttribute("aria-label"),
            element.closest(".RCMFormField")?.textContent,
            element.closest("label")?.textContent,
          ]
            .map((part) => part ?? "")
            .join(" ");
        const field = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((input) => {
          const normalizedContext = normalize(readContext(input));
          return wanted.some((name) => normalizedContext.includes(name));
        });
        if (!field) {
          return { ok: false, reason: "missing" };
        }
        if (field.disabled) {
          return { ok: false, reason: "disabled" };
        }
        const win = window as Window & {
          juic?: { fire?: (id: string, eventName: string, eventObject?: Event) => unknown };
        };
        const applyDesired = () => {
          field.checked = desired;
          if (desired) field.setAttribute("checked", "checked");
          else field.removeAttribute("checked");
          field.dispatchEvent(new Event("input", { bubbles: true }));
          field.dispatchEvent(new Event("change", { bubbles: true }));
        };
        applyDesired();
        if (field.id && win.juic?.fire) {
          try {
            win.juic.fire(field.id, "_click", new MouseEvent("click", { bubbles: true, cancelable: true }));
          } catch {
            // SuccessFactors' JUIC bridge is best-effort; DOM events above are still useful.
          }
        }
        if (field.checked !== desired) {
          applyDesired();
        }
        return { ok: field.checked === desired, changed: true, value: field.checked ? "checked" : "unchecked" };
      },
      { names, checked },
    )
    .catch(() => ({ ok: false, reason: "script failed" }));
}

async function selectSuccessFactorsPicklistByLabel(
  page: Page,
  labelPatterns: RegExp[],
  candidates: string[],
): Promise<SuccessFactorsDomResult> {
  return page
    .evaluate(
      async ({ patternSources, candidates: desiredValues }) => {
        const normalize = (value: string | null | undefined) =>
          (value ?? "")
            .toLowerCase()
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[_-]+/g, " ")
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
        const visible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const regexes = patternSources.map((source) => new RegExp(source, "i"));
        const matchesLabel = (text: string) => {
          const normalized = normalize(text);
          return regexes.some((regex) => regex.test(normalized));
        };
        const choiceMatches = (actual: string, desired: string) => {
          const normalizedActual = normalize(actual);
          const normalizedDesired = normalize(desired);
          if (!normalizedActual || !normalizedDesired) return false;
          if (normalizedActual === normalizedDesired) return true;
          if (normalizedDesired === "no") {
            return normalizedActual === "no" || /^no\s/.test(normalizedActual);
          }
          return normalizedActual.includes(normalizedDesired) || normalizedDesired.includes(normalizedActual);
        };
        const scoreOption = (text: string) => {
          const normalizedText = normalize(text);
          for (let index = 0; index < desiredValues.length; index += 1) {
            if (normalizedText === normalize(desiredValues[index])) return index;
          }
          for (let index = 0; index < desiredValues.length; index += 1) {
            if (choiceMatches(text, desiredValues[index])) return index + desiredValues.length;
          }
          return Number.POSITIVE_INFINITY;
        };
        const contextText = (input: HTMLInputElement) => {
          const root = input.getRootNode() as Document | ShadowRoot;
          const label =
            input.id && "querySelector" in root
              ? (root.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent ?? "")
              : "";
          return [
            input.getAttribute("aria-label"),
            input.getAttribute("title"),
            input.getAttribute("name"),
            input.getAttribute("id"),
            input.getAttribute("placeholder"),
            label,
            input.closest(".RCMFormField")?.textContent,
            input.parentElement?.textContent,
          ]
            .map(read)
            .filter(Boolean)
            .join(" ");
        };
        const fields = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[aria-owns], input[role="combobox"], input[id$="_input"]'),
        );
        const field = fields.find((input) => visible(input) && matchesLabel(contextText(input)));
        if (!field) {
          return { ok: false, reason: "missing" };
        }
        if (desiredValues.some((candidate) => choiceMatches(field.value, candidate))) {
          return { ok: true, changed: false, value: field.value };
        }

        const win = window as Window & {
          juic?: { fire?: (id: string, eventName: string, eventObject?: Event) => unknown };
        };
        const hideLists = () => {
          for (const list of Array.from(document.querySelectorAll<HTMLElement>(".globalMenu.sf-combo-listselect"))) {
            list.style.display = "none";
          }
        };
        const fire = (id: string, eventName: string) => {
          if (!id || !win.juic?.fire) return;
          try {
            win.juic.fire(id, eventName, new MouseEvent("click", { bubbles: true, cancelable: true }));
          } catch {
            // Ignore stale JUIC controls; direct DOM clicks below are the fallback.
          }
        };
        hideLists();
        field.scrollIntoView({ block: "center", inline: "nearest" });
        field.focus();
        field.click();
        fire(field.id.replace(/_input$/, ""), "_click");

        const listId = field.getAttribute("aria-owns") || "";
        let list: HTMLElement | null = null;
        for (let attempt = 0; attempt < 25; attempt += 1) {
          list = listId ? document.getElementById(listId) : null;
          if (list && visible(list)) break;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
        }
        if (!list) {
          list = Array.from(document.querySelectorAll<HTMLElement>(".globalMenu.sf-combo-listselect")).find(visible) ?? null;
        }
        if (!list) {
          return { ok: false, reason: "options not visible" };
        }

        const options = Array.from(list.querySelectorAll<HTMLElement>('[role="option"], li, div[id], span[id], a[id]'))
          .map((option) => ({ option, text: read(option.textContent), score: scoreOption(read(option.textContent)) }))
          .filter((candidate) => candidate.text && Number.isFinite(candidate.score))
          .sort((left, right) => left.score - right.score);
        const selected = options[0]?.option;
        if (!selected) {
          return { ok: false, reason: "option missing" };
        }

        selected.scrollIntoView({ block: "nearest", inline: "nearest" });
        selected.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        selected.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        selected.click();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        hideLists();

        if (!desiredValues.some((candidate) => choiceMatches(field.value, candidate))) {
          return { ok: false, reason: `selection did not stick (${field.value || "blank"})` };
        }

        return { ok: true, changed: true, value: field.value };
      },
      { patternSources: labelPatterns.map((pattern) => pattern.source), candidates },
    )
    .catch(() => ({ ok: false, reason: "script failed" }));
}

async function selectAllSuccessFactorsPicklistsByLabel(
  page: Page,
  labelPatterns: RegExp[],
  candidates: string[],
): Promise<SuccessFactorsDomResult> {
  return page
    .evaluate(
      async ({ patternSources, candidates: desiredValues }) => {
        const normalize = (value: string | null | undefined) =>
          (value ?? "")
            .toLowerCase()
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[_-]+/g, " ")
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
        const visible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const regexes = patternSources.map((source) => new RegExp(source, "i"));
        const matchesLabel = (text: string) => {
          const normalized = normalize(text);
          return regexes.some((regex) => regex.test(normalized));
        };
        const choiceMatches = (actual: string, desired: string) => {
          const normalizedActual = normalize(actual);
          const normalizedDesired = normalize(desired);
          if (!normalizedActual || !normalizedDesired) return false;
          if (normalizedActual === normalizedDesired) return true;
          if (normalizedDesired === "no") {
            return normalizedActual === "no" || /^no\s/.test(normalizedActual);
          }
          return normalizedActual.includes(normalizedDesired) || normalizedDesired.includes(normalizedActual);
        };
        const scoreOption = (text: string) => {
          const normalizedText = normalize(text);
          for (let index = 0; index < desiredValues.length; index += 1) {
            if (normalizedText === normalize(desiredValues[index])) return index;
          }
          for (let index = 0; index < desiredValues.length; index += 1) {
            if (choiceMatches(text, desiredValues[index])) return index + desiredValues.length;
          }
          return Number.POSITIVE_INFINITY;
        };
        const contextText = (input: HTMLInputElement) => {
          const root = input.getRootNode() as Document | ShadowRoot;
          const label =
            input.id && "querySelector" in root
              ? (root.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent ?? "")
              : "";
          return [
            input.getAttribute("aria-label"),
            input.getAttribute("title"),
            input.getAttribute("name"),
            input.getAttribute("id"),
            input.getAttribute("placeholder"),
            label,
            input.closest(".RCMFormField")?.textContent,
            input.parentElement?.textContent,
          ]
            .map(read)
            .filter(Boolean)
            .join(" ");
        };
        const fields = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[aria-owns], input[role="combobox"], input[id$="_input"]'),
        ).filter((input) => visible(input) && matchesLabel(contextText(input)));
        if (fields.length === 0) {
          return { ok: false, reason: "missing" };
        }

        const win = window as Window & {
          juic?: { fire?: (id: string, eventName: string, eventObject?: Event) => unknown };
        };
        const hideLists = () => {
          for (const list of Array.from(document.querySelectorAll<HTMLElement>(".globalMenu.sf-combo-listselect"))) {
            list.style.display = "none";
          }
        };
        let changed = 0;
        let failed = 0;
        const values: string[] = [];

        for (const field of fields) {
          if (desiredValues.some((candidate) => choiceMatches(field.value, candidate))) {
            values.push(field.value);
            continue;
          }
          hideLists();
          field.scrollIntoView({ block: "center", inline: "nearest" });
          field.focus();
          field.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          field.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          field.click();
          try {
            win.juic?.fire?.(field.id.replace(/_input$/, ""), "_click", new MouseEvent("click", { bubbles: true }));
          } catch {
            // DOM click is the fallback.
          }
          const listId = field.getAttribute("aria-owns") || "";
          let list: HTMLElement | null = null;
          for (let attempt = 0; attempt < 25; attempt += 1) {
            list = listId ? document.getElementById(listId) : null;
            if (list && visible(list)) break;
            await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
          }
          if (!list) {
            list = Array.from(document.querySelectorAll<HTMLElement>(".globalMenu.sf-combo-listselect")).find(visible) ?? null;
          }
          const options = list
            ? Array.from(list.querySelectorAll<HTMLElement>('[role="option"], li, div[id], span[id], a[id]'))
                .map((option) => ({ option, text: read(option.textContent), score: scoreOption(read(option.textContent)) }))
                .filter((candidate) => candidate.text && Number.isFinite(candidate.score))
                .sort((left, right) => left.score - right.score)
            : [];
          const selected = options[0]?.option;
          if (!selected) {
            failed += 1;
            continue;
          }
          selected.scrollIntoView({ block: "nearest", inline: "nearest" });
          selected.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          selected.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          selected.click();
          await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
          if (desiredValues.some((candidate) => choiceMatches(field.value, candidate))) {
            changed += 1;
            values.push(field.value);
          } else {
            failed += 1;
          }
        }
        hideLists();
        if (failed > 0) {
          return { ok: false, reason: `${failed} of ${fields.length} selections failed`, value: values.join(", ") };
        }
        return { ok: true, changed: changed > 0, value: values.join(", ") };
      },
      { patternSources: labelPatterns.map((pattern) => pattern.source), candidates },
    )
    .catch(() => ({ ok: false, reason: "script failed" }));
}

async function chooseSuccessFactorsRadioByQuestion(
  page: Page,
  questionPatterns: RegExp[],
  answerCandidates: string[],
): Promise<SuccessFactorsDomResult> {
  return page
    .evaluate(
      ({ patternSources, answerCandidates: desiredValues }) => {
        const normalize = (value: string | null | undefined) =>
          (value ?? "")
            .toLowerCase()
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[_-]+/g, " ")
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
        const regexes = patternSources.map((source) => new RegExp(source, "i"));
        const matchesQuestion = (text: string) => regexes.some((regex) => regex.test(normalize(text)));
        const choiceMatches = (actual: string, desired: string) => {
          const normalizedActual = normalize(actual);
          const normalizedDesired = normalize(desired);
          if (!normalizedActual || !normalizedDesired) return false;
          if (normalizedActual === normalizedDesired) return true;
          if (normalizedDesired === "no") {
            return normalizedActual === "no" || /^no\s/.test(normalizedActual);
          }
          return normalizedActual.includes(normalizedDesired) || normalizedDesired.includes(normalizedActual);
        };
        const scoreOption = (text: string) => {
          const normalizedText = normalize(text);
          for (let index = 0; index < desiredValues.length; index += 1) {
            if (normalizedText === normalize(desiredValues[index])) return index;
          }
          for (let index = 0; index < desiredValues.length; index += 1) {
            if (choiceMatches(text, desiredValues[index])) return index + desiredValues.length;
          }
          return Number.POSITIVE_INFINITY;
        };
        const roots = Array.from(
          document.querySelectorAll<HTMLElement>(".RCMFormField.rcmFormQuestionElement, .RCMFormField, [role='radiogroup']"),
        );
        const root = roots.find((candidate) => matchesQuestion(candidate.textContent || ""));
        if (!root) {
          return { ok: false, reason: "missing" };
        }
        const group = root.matches("[role='radiogroup']")
          ? root
          : root.querySelector<HTMLElement>("[role='radiogroup']");
        if (!group) {
          return { ok: false, reason: "radio group missing" };
        }
        const options = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"], .globalRadio, input[type="radio"]'))
          .map((option) => {
            const labelId = option.getAttribute("aria-labelledby") || "";
            const explicitLabel = labelId ? document.getElementById(labelId)?.textContent ?? "" : "";
            const text = read(
              [
                option.getAttribute("aria-label"),
                explicitLabel,
                option.closest("label")?.textContent,
                option.parentElement?.textContent,
                option.textContent,
              ].join(" "),
            );
            const selected =
              option.getAttribute("aria-checked") === "true" ||
              (option instanceof HTMLInputElement && option.checked);
            return { option, text, selected, score: scoreOption(text) };
          })
          .filter((candidate) => candidate.text && Number.isFinite(candidate.score))
          .sort((left, right) => left.score - right.score);
        const existing = options.find((option) => option.selected);
        if (existing && desiredValues.some((candidate) => choiceMatches(existing.text, candidate))) {
          return { ok: true, changed: false, value: existing.text };
        }
        const selected = options[0];
        if (!selected) {
          return { ok: false, reason: "option missing" };
        }
        const win = window as Window & {
          juic?: { fire?: (id: string, eventName: string, eventObject?: Event) => unknown };
        };
        selected.option.scrollIntoView({ block: "center", inline: "nearest" });
        if (selected.option.id && win.juic?.fire) {
          try {
            win.juic.fire(selected.option.id, "_itemSelect", new MouseEvent("click", { bubbles: true, cancelable: true }));
          } catch {
            // Fall back to DOM click below.
          }
        }
        selected.option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        selected.option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        selected.option.click();
        if (selected.option instanceof HTMLInputElement) {
          selected.option.checked = true;
          selected.option.dispatchEvent(new Event("input", { bubbles: true }));
          selected.option.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { ok: true, changed: true, value: selected.text };
      },
      { patternSources: questionPatterns.map((pattern) => pattern.source), answerCandidates },
    )
    .catch(() => ({ ok: false, reason: "script failed" }));
}

async function fillSuccessFactorsTextareaByQuestion(
  page: Page,
  questionPatterns: RegExp[],
  value: string,
): Promise<SuccessFactorsDomResult> {
  return page
    .evaluate(
      ({ patternSources, value: desiredValue }) => {
        const normalize = (text: string | null | undefined) =>
          (text ?? "")
            .toLowerCase()
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[_-]+/g, " ")
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const regexes = patternSources.map((source) => new RegExp(source, "i"));
        const roots = Array.from(document.querySelectorAll<HTMLElement>(".RCMFormField.rcmFormQuestionElement, .RCMFormField"));
        const root = roots.find((candidate) => {
          const normalized = normalize(candidate.textContent || "");
          return regexes.some((regex) => regex.test(normalized));
        });
        const field = root?.querySelector<HTMLTextAreaElement>("textarea");
        if (!field) {
          return { ok: false, reason: "missing" };
        }
        if (field.value.trim() === desiredValue.trim()) {
          return { ok: true, changed: false, value: field.value };
        }
        field.focus();
        field.value = desiredValue;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        field.blur();
        return { ok: field.value.trim() === desiredValue.trim(), changed: true, value: field.value };
      },
      { patternSources: questionPatterns.map((pattern) => pattern.source), value },
    )
    .catch(() => ({ ok: false, reason: "script failed" }));
}

async function uploadSuccessFactorsResumeIfNeeded(page: Page, profile: Profile): Promise<SuccessFactorsDomResult> {
  const resumePath = await resolveResumeFilePath(profile).catch(() => "");
  if (!resumePath) {
    return { ok: false, reason: "missing resume" };
  }
  const filename = path.basename(resumePath);
  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (bodyText.includes(filename)) {
    return { ok: false, reason: "already attached" };
  }

  await expandSuccessFactorsSections(page).catch(() => undefined);
  const clickedResumeTile = await page
    .evaluate(() => {
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const visible = (element: Element) => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const wrappers = Array.from(document.querySelectorAll<HTMLElement>('[id$="_attachWrapper"], .attachWrapper'));
      const wrapper =
        wrappers.find((candidate) => /resume|cv/i.test(read(candidate.textContent)) && visible(candidate)) ??
        wrappers.find(visible);
      const icon = wrapper?.querySelector<HTMLElement>('[id$="_attachIcon"], [role="button"]');
      if (!icon) {
        return false;
      }
      icon.scrollIntoView({ block: "center", inline: "nearest" });
      for (const type of ["mousedown", "mouseup", "click"]) {
        icon.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    })
    .catch(() => false);
  if (!clickedResumeTile) {
    await clickFirstVisible(page, [
      '[id$="_attachIcon"]',
      'a:has-text("Upload Resume")',
      'button:has-text("Upload Resume")',
      'a:has-text("Attach")',
      'button:has-text("Attach")',
    ]).catch(() => false);
  }
  await page.waitForFunction(() => document.querySelectorAll('input[type="file"]').length > 0, null, {
    timeout: 4_000,
  }).catch(() => undefined);

  const field = page.locator('input[type="file"]:visible, input[type="file"]').first();
  if ((await field.count().catch(() => 0)) === 0) {
    return { ok: false, reason: "file input missing" };
  }
  const uploaded = await field.setInputFiles(resumePath).then(() => true).catch(() => false);
  if (!uploaded) {
    return { ok: false, reason: "upload failed" };
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const text = await page.locator("body").innerText().catch(() => "");
    if (text.includes(filename) || !/uploading|processing/i.test(text)) {
      break;
    }
    await page.waitForTimeout(500).catch(() => undefined);
  }
  await page.waitForTimeout(2_000).catch(() => undefined);
  await expandSuccessFactorsSections(page).catch(() => undefined);
  return { ok: true, changed: true, value: filename };
}

function inferSuccessFactorsSalary(pageText: string): string {
  return /associate|junior|entry level|early career/i.test(pageText) ? "120000" : "150000";
}

async function fillCargillSuccessFactorsBaseFields(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const pageText = [await page.title().catch(() => ""), await page.locator("body").innerText().catch(() => "")]
    .join(" ")
    .slice(0, 20_000);

  const textFields: Array<[string, string[], string]> = [
    ["SuccessFactors cell phone", ["cellPhone"], profile.phone],
    ["SuccessFactors home phone", ["homePhone"], profile.phone],
    ["SuccessFactors address line 1", ["addressLine1"], profile.streetAddress],
    ["SuccessFactors city", ["city"], profile.city || "Raleigh"],
    ["SuccessFactors postal code", ["zip", "postalCode"], profile.postalCode],
    ["SuccessFactors salary expectation", ["cust_salaryExpect"], inferSuccessFactorsSalary(pageText)],
    ["SuccessFactors notice period", ["cust_noticePeriod"], "Two weeks"],
    ["SuccessFactors previous employer detail", ["cust_previousEmp2"], "Not Applicable"],
    ["SuccessFactors source name", ["cust_sourceName"], "LinkedIn"],
    ["SuccessFactors disability name", ["cust_name"], profile.name],
    ["SuccessFactors disclosure signature", ["cust_disclaimer2"], profile.name],
  ];
  for (const [label, names, value] of textFields) {
    recordSuccessFactorsResult(await fillSuccessFactorsTextByNames(page, names, value), label, filled, skipped);
  }

  const picklists: Array<[string, RegExp[], string[]]> = [
    ["SuccessFactors state", [/state\s+province|province|state/], [expandUsStateName(profile.state), profile.state, "North Carolina"].filter(Boolean)],
    ["SuccessFactors previously worked for Cargill", [/previously worked for cargill/], ["No"]],
    ["SuccessFactors source", [/how did you hear|source/], ["Social Network", "LinkedIn"]],
    ["SuccessFactors non-solicitation", [/non solicitation|non solicitation us canada/], ["No"]],
    ["SuccessFactors harassment history", [/sexual harassment/], ["No"]],
    ["SuccessFactors rule violation", [/violating rules|violate rules|company rules/], ["No"]],
    ["SuccessFactors subsidiaries", [/subsidiaries.*us.*canada|subsidiaries/], ["Not Applicable"]],
    ["SuccessFactors former intern", [/current or former cargill intern|co op|summer student/], ["No"]],
    ["SuccessFactors preferred language", [/preferred language/], ["English"]],
    ["SuccessFactors SMS opt in", [/sms opt in|text message|mobile message/], ["No"]],
    ["SuccessFactors race ethnicity", [/race ethnicity|ethnicity/], ["Not Applicable", "I do not wish to answer"]],
    ["SuccessFactors gender", [/gender/], ["Prefers not to disclose", "I prefer not to disclose", "Decline to State"]],
    ["SuccessFactors veteran status", [/protected veteran status|veteran/], ["I AM NOT A VETERAN", "I am not a protected veteran", "Not a Veteran"]],
    ["SuccessFactors disability status", [/disability|please select one of the options below/], ["I do not want to answer", "Decline to Answer"]],
  ];
  for (const [label, patterns, values] of picklists) {
    recordSuccessFactorsResult(await selectSuccessFactorsPicklistByLabel(page, patterns, values), label, filled, skipped);
  }

  const checkboxes: Array<[string, string[], boolean]> = [
    ["SuccessFactors criminal conviction acknowledgment", ["rcm_criminalConvictionAcknowledgement"], true],
    ["SuccessFactors WOTC apply acknowledgment", ["cust_WOTCapply1"], true],
    ["SuccessFactors WOTC opt out", ["cust_WOTCapply"], false],
    ["SuccessFactors disclaimer acknowledgment", ["cust_disclaimer3"], true],
  ];
  for (const [label, names, checked] of checkboxes) {
    recordSuccessFactorsResult(await setSuccessFactorsCheckboxByNames(page, names, checked), label, filled, skipped);
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function answerCargillSuccessFactorsScreening(
  page: Page,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const radioAnswers: Array<[string, RegExp[], string[]]> = [
    ["SuccessFactors right to work", [/right to work.*united states|legally authorized.*united states/], ["Yes"]],
    [
      "SuccessFactors sponsorship or third-party employer",
      [/student visa|third party employer|visa sponsored|solely based|sponsorship/],
      ["No or Does Not Apply", "Does Not Apply", "No"],
    ],
    ["SuccessFactors four years experience", [/minimum.*4 years|4 years.*related work/], ["Yes"]],
    ["SuccessFactors B2B platform engineering", [/b2b platform engineering|x12|edifact/], ["No"]],
    ["SuccessFactors integration platform experience", [/boomi|tibco|sap btp|sap pi|sap po|pi po/], ["No"]],
    [
      "SuccessFactors engineering principles",
      [/core engineering principles|solution design|scalability|performance optimization/],
      ["Yes"],
    ],
    ["SuccessFactors modern toolsets", [/github|ci cd|cloud scripting|backlog management|modern engineering toolsets/], ["Yes"]],
    [
      "SuccessFactors product collaboration",
      [/collaborate.*product teams|enterprise architecture|platform strategy|diverse b2b domains/],
      ["Yes"],
    ],
  ];

  for (const [label, patterns, values] of radioAnswers) {
    recordSuccessFactorsResult(await chooseSuccessFactorsRadioByQuestion(page, patterns, values), label, filled, skipped);
  }

  const pageText = [await page.title().catch(() => ""), await page.locator("body").innerText().catch(() => "")]
    .join(" ")
    .slice(0, 20_000);
  recordSuccessFactorsResult(
    await fillSuccessFactorsTextareaByQuestion(
      page,
      [/minimum salary requirements|minimum salary requirement|salary requirements/],
      /associate|junior|entry level|early career/i.test(pageText) ? "100000" : "150000",
    ),
    "SuccessFactors minimum salary requirement",
    filled,
    skipped,
  );

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function isAmericanAirlinesSuccessFactorsApplication(page: Page): Promise<boolean> {
  if (!/successfactors\.com/i.test(page.url())) {
    return false;
  }
  const text = [await page.title().catch(() => ""), await page.locator("body").innerText().catch(() => "")]
    .join(" ")
    .slice(0, 10_000);
  return /American Airlines|mainline American Airlines|Envoy|Piedmont|US Airways/i.test(text);
}

async function fillAmericanAirlinesSuccessFactorsFields(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const firstName = profile.name.split(/\s+/)[0] || profile.name;

  const textFields: Array<[string, string[], string]> = [
    ["American Airlines preferred name", ["preferredName"], firstName],
    ["American Airlines address", ["address"], profile.streetAddress],
    ["American Airlines city", ["city"], profile.city || "Raleigh"],
    ["American Airlines zip", ["zip"], profile.postalCode],
    ["American Airlines email", ["contactEmail"], profile.email],
    ["American Airlines phone", ["cellPhone"], profile.phone],
    ["American Airlines full name", ["custFullName"], profile.name],
  ];
  for (const [label, names, value] of textFields) {
    recordSuccessFactorsResult(await fillSuccessFactorsTextByNames(page, names, value), label, filled, skipped);
  }

  const picklists: Array<[string, RegExp[], string[]]> = [
    ["American Airlines state", [/state.*region.*province|state/], [expandUsStateName(profile.state), profile.state, "North Carolina"].filter(Boolean)],
    ["American Airlines travel", [/willingness.*travel/], ["Up to 25%"]],
    ["American Airlines text messages", [/authorize text messages|sms|text messages/], ["No"]],
    ["American Airlines degree", [/^degree$/], ["BS - Bach Science", "BA - Bach Arts", "Bachelor"]],
    ["American Airlines major", [/program.*major|major/], ["Computer Science", "Computer/Info Science", "Information Systems"]],
    ["American Airlines age", [/at least 18 years of age/], ["Yes"]],
    ["American Airlines work authorization", [/legally authorized.*work.*country|authorized.*work/], ["Yes"]],
    ["American Airlines sponsorship", [/future require sponsorship|employment visa status/], ["No"]],
    ["American Airlines prior employment", [/previously employed.*american airlines|former employee/], ["No"]],
    ["American Airlines commercial airline", [/currently work.*commercial airline/], ["No"]],
    ["American Airlines commercial airline name", [/which one.*commercial airline/], ["Not applicable", "Not Applicable", "-N/A", "N/A"]],
    ["American Airlines events", [/following events|connect with us.*events/], ["Not Applicable", "Not applicable", "N/A"]],
    ["American Airlines partners", [/active member.*partners/], ["Not Applicable", "Not applicable", "N/A"]],
    ["American Airlines source", [/first hear.*job opening|how did you.*hear|source/], ["LinkedIn"]],
    ["American Airlines preferred location", [/preferred location|multilocation/], ["-N/A", "N/A"]],
    ["American Airlines veteran", [/veteran status/], ["Non veteran", "Non Veteran"]],
    ["American Airlines ethnicity", [/ethnicity/], ["I do not wish to provide this information", "I do not wish to disclose"]],
    ["American Airlines race", [/^race$/], ["I do not wish to provide this information", "I do not wish to disclose"]],
    ["American Airlines disability", [/disability status/], ["I do not want to answer", "I do not wish to answer"]],
    ["American Airlines family employee", [/family member.*active employee.*american airlines/], ["No"]],
  ];
  for (const [label, patterns, values] of picklists) {
    recordSuccessFactorsResult(await selectSuccessFactorsPicklistByLabel(page, patterns, values), label, filled, skipped);
  }
  recordSuccessFactorsResult(
    await selectAllSuccessFactorsPicklistsByLabel(page, [/^industry$/], ["Info Technology Sys", "Computer & Tech"]),
    "American Airlines work history industries",
    filled,
    skipped,
  );

  const radioAnswers: Array<[string, RegExp[], string[]]> = [
    ["American Airlines English language", [/read.*write.*speak.*english/], ["Yes"]],
    ["American Airlines age radio", [/at least 18 years of age/], ["Yes"]],
    ["American Airlines US work authorization radio", [/legally authorized.*work.*u s/], ["Yes"]],
    ["American Airlines background check", [/drug screen|background check|fingerprinting/], ["Yes"]],
    ["American Airlines diploma", [/high school diploma|ged|international equivalent/], ["Yes"]],
    ["American Airlines sponsorship radio", [/future require sponsorship.*visa/], ["No"]],
    ["American Airlines airline experience", [/airline experience/], ["No"]],
  ];
  for (const [label, patterns, values] of radioAnswers) {
    recordSuccessFactorsResult(await chooseSuccessFactorsRadioByQuestion(page, patterns, values), label, filled, skipped);
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function submitSuccessFactorsApplication(page: Page): Promise<boolean> {
  const clickedByJuic = await page
    .evaluate(() => {
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const visible = (element: HTMLElement) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>('span[role="button"], button, input[type="submit"], a[role="button"]'),
      );
      const button = buttons.find((candidate) => {
        if (!visible(candidate)) return false;
        const text = read(
          [
            candidate.textContent,
            candidate.getAttribute("aria-label"),
            candidate.getAttribute("value"),
            candidate.getAttribute("title"),
          ].join(" "),
        );
        return /\bsubmit\b/i.test(text);
      });
      if (!button) {
        return false;
      }
      const win = window as Window & {
        juic?: { fire?: (id: string, eventName: string, eventObject?: Event) => unknown };
      };
      button.scrollIntoView({ block: "center", inline: "nearest" });
      const id = button.id || "";
      if (id && win.juic?.fire) {
        const baseId = id.replace(/_submitBtn$/, "");
        try {
          win.juic.fire(baseId, "_submit", new MouseEvent("click", { bubbles: true, cancelable: true }));
          return true;
        } catch {
          // Fall through to DOM click.
        }
      }
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      button.click();
      return true;
    })
    .catch(() => false);
  if (clickedByJuic) {
    return true;
  }

  return clickFirstVisible(page, [
    'span[role="button"][id$="_submitBtn"]:has-text("Submit")',
    'button:has-text("Submit")',
    'input[type="submit" i][value*="Submit" i]',
  ]);
}

async function runSuccessFactorsDirectAutofill(
  page: Page,
  profile: Profile,
  submit: boolean,
): Promise<DirectSiteAutofillResult> {
  if (!(await hasSuccessFactorsApplicationSignals(page))) {
    return { filled: [], skipped: [], handled: false };
  }
  if (await detectSiteSubmissionSuccess(page)) {
    return { filled: [], skipped: [], handled: true, submitted: true };
  }

  const signIn = await signInSuccessFactorsIfPresent(page, profile);
  if (signIn) {
    return signIn;
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  const merge = (result: Pick<AutofillPassResult, "filled" | "skipped">) => {
    filled.push(...result.filled);
    skipped.push(...result.skipped);
  };

  await expandSuccessFactorsSections(page).catch(() => undefined);
  const upload = await uploadSuccessFactorsResumeIfNeeded(page, profile);
  if (upload.ok) {
    filled.push("SuccessFactors resume upload");
  } else if (upload.reason && !["already attached", "missing"].includes(upload.reason)) {
    skipped.push(`SuccessFactors resume upload: ${upload.reason}`);
  }
  await expandSuccessFactorsSections(page).catch(() => undefined);
  if (await isAmericanAirlinesSuccessFactorsApplication(page)) {
    merge(await fillAmericanAirlinesSuccessFactorsFields(page, profile));
  }
  merge(await fillCargillSuccessFactorsBaseFields(page, profile));
  merge(await answerCargillSuccessFactorsScreening(page));

  if (!submit) {
    return {
      filled: dedupeText(filled),
      skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
      handled: true,
    };
  }

  const firstSubmit = await submitSuccessFactorsApplication(page);
  if (!firstSubmit) {
    return {
      filled: dedupeText(filled),
      skipped: dedupeText([...skipped, "SuccessFactors submit button"].filter((label) => !filled.includes(label))),
      handled: true,
    };
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(10_000).catch(() => undefined);
  if (await detectSiteSubmissionSuccess(page)) {
    return {
      filled: dedupeText(filled),
      skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
      handled: true,
      submitted: true,
    };
  }

  await expandSuccessFactorsSections(page).catch(() => undefined);
  if (await isAmericanAirlinesSuccessFactorsApplication(page)) {
    merge(await fillAmericanAirlinesSuccessFactorsFields(page, profile));
  }
  merge(await fillCargillSuccessFactorsBaseFields(page, profile));
  merge(await answerCargillSuccessFactorsScreening(page));
  const secondSubmit = await submitSuccessFactorsApplication(page);
  if (secondSubmit) {
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(10_000).catch(() => undefined);
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    handled: true,
    advanced: secondSubmit || firstSubmit,
    submitted: await detectSiteSubmissionSuccess(page),
  };
}

async function readNearbyFieldLabel(field: Locator): Promise<string> {
  const label = tidy(
    await field
      .evaluate((node) => {
        const element = node as HTMLElement;
        const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
        const id = element.getAttribute("id") || "";
        const root = element.getRootNode() as Document | ShadowRoot;

        if (id) {
          const explicit = root.querySelector(`label[for="${CSS.escape(id)}"]`);
          const text = read(explicit?.textContent);
          if (text) {
            return text;
          }
        }

        const wrapped = read(element.closest("label")?.textContent);
        if (wrapped) {
          return wrapped;
        }

        let previous = element.previousElementSibling;
        for (let index = 0; previous && index < 4; index += 1, previous = previous.previousElementSibling) {
          const text = read(previous.textContent);
          if (text && text.length <= 220) {
            return text;
          }
        }

        const containers = [
          element.parentElement,
          element.closest(".u-mb-6"),
          element.closest("spl-internal-form-field"),
          element.closest("spl-form-field"),
          element.closest("oc-input"),
          element.closest('[class*="field"]'),
          element.closest('[class*="question"]'),
        ].filter((candidate): candidate is HTMLElement => Boolean(candidate));

        for (const container of containers) {
          const candidates = container.querySelectorAll(
            'label, legend, [class*="label"], [class*="Label"], spl-typography-label',
          );
          for (const candidate of Array.from(candidates)) {
            const text = read(candidate.textContent);
            if (text && text.length <= 220) {
              return text;
            }
          }
        }

        return "";
      })
      .catch(() => ""),
  );

  return cleanExtractedLabel(label) || (await extractLocatorLabel(field).catch(() => ""));
}

async function readNativeSelectChoices(field: Locator): Promise<string[]> {
  return field
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean),
    )
    .catch(() => []);
}

function pickChoice(choices: string[], desiredValues: string[], fallback = ""): string {
  for (const desiredValue of desiredValues) {
    const match = choices.find((choice) => matchesDesiredChoice(choice, desiredValue));
    if (match) {
      return match;
    }
  }

  return fallback;
}

function pickNonDisclosureChoice(choices: string[], fallback = "Prefer not to disclose"): string {
  return choices.find((choice) => isNonDisclosureOption(choice)) || fallback;
}

async function setNativeSelectByBestChoice(
  field: Locator,
  choices: string[],
  desiredValues: string[],
): Promise<boolean> {
  const chosen = pickChoice(choices, desiredValues, desiredValues[0] || "");
  return chosen ? selectNativeOption(field, [chosen, ...desiredValues]) : false;
}

function getCustomGreenhouseAnswer(
  label: string,
  fieldName: string,
  type: string,
  choices: string[],
  profile: Profile,
  explicitAnswers: Awaited<ReturnType<typeof loadApplicationAnswers>>,
): string {
  const normalized = normalizeQuestionText(`${label} ${fieldName}`);
  const first = profile.name.split(/\s+/)[0] || "";
  const last = profile.name.split(/\s+/).slice(1).join(" ") || "";
  const website =
    lookupApplicationAnswer(explicitAnswers, label, type) ||
    lookupApplicationAnswer(explicitAnswers, "website", "text") ||
    lookupApplicationAnswer(explicitAnswers, "portfolio", "text") ||
    "";

  if (/\bfirst name\b|first_name/.test(normalized) && !/preferred/.test(normalized)) return first;
  if (/\blast name\b|last_name/.test(normalized)) return last;
  if (/\bemail\b/.test(normalized)) return profile.email;
  if (/\bphone\b/.test(normalized)) return profile.phone;
  if (/preferred first name/.test(normalized)) return first;
  if (/middle name/.test(normalized)) return "";
  if (/mailing address 2|address line 2/.test(normalized)) return profile.addressLine2;
  if (/mailing address|address line 1|street address/.test(normalized)) return profile.streetAddress;
  if (/visa|work permit|sponsor|immigration/.test(normalized)) {
    if (choices.length > 0 || /select|combobox/.test(type)) {
      return pickChoice(choices, ["No"], "No");
    }
    return "No, I am authorized to work in the United States and do not require employer sponsorship.";
  }
  if (/from where do you intend to work|intend to work|preferred work location|work location/.test(normalized)) {
    return [profile.city, expandUsStateName(profile.state) || profile.state].filter(Boolean).join(", ") || profile.location;
  }
  if (/\bcity\b/.test(normalized)) return profile.city;
  if (/\bstate\b/.test(normalized)) return pickChoice(choices, ["North Carolina", profile.state, "NC"], "North Carolina");
  if (/\bzip\b|postal/.test(normalized)) return profile.postalCode;
  if (/\bcounty\b/.test(normalized)) return lookupApplicationAnswer(explicitAnswers, "county", "text") || "Wake";
  if (/your authorization to work|work authorization|authorized to work|right to work|eligible to work|eligibility to work/.test(normalized)) {
    return pickChoice(
      choices,
      [
        "I am authorized to work in the country due to my nationality",
        "Authorized to work",
        "Yes",
      ],
      "I am authorized to work in the country due to my nationality",
    );
  }
  if (/currently based.*countries|based in any of these countries|currently based.*country/.test(normalized)) {
    return pickChoice(choices, ["United States", "US", "USA"], "United States");
  }
  if (/one of the following states|do you live in one of|alabama.*alaska.*delaware/.test(normalized)) return "No";
  if (/\bcountry\b/.test(normalized)) return pickChoice(choices, ["United States", "US", "USA"], "United States");
  if (/current .*employee|employee or contractor|former .*employee|previous .*employee|currently.*worked|previously.*worked|worked at/.test(normalized)) return "No";
  if (/how did you hear|where did you hear|where did you learn|source/.test(normalized)) return "LinkedIn";
  if (
    /relative|first degree|family.*employed|employed.*family|know anyone.*currently at|know someone.*currently at|know anyone.*work(?:ing)? at|know someone.*work(?:ing)? at/.test(
      normalized,
    )
  ) {
    return "No";
  }
  if (/built.*ai agents|ai agents.*built|built.*agentic|agentic.*built/.test(normalized)) {
    if (choices.length > 0 || /select|combobox/.test(type)) {
      return pickChoice(choices, ["Yes"], "Yes");
    }
    return "Yes - I have built agentic automation workflows using TypeScript, Playwright, LLM-assisted tooling, structured browser inspection, form handling, and retry logic to complete multi-step tasks with a clear audit trail.";
  }
  if (/salary|compensation|pay requirement|pay expectation/.test(normalized)) return getPhenomSalaryExpectation();
  if (/commutable distance|soho|nyc office|willing to relocate|relocat/.test(normalized)) {
    return pickChoice(
      choices,
      [
        "No - I am not located in NYC, and I am not willing to relocate",
        "No",
      ],
      "No - I am not located in NYC, and I am not willing to relocate",
    );
  }
  if (/interviews?.*video|camera on|keep your camera/.test(normalized)) return "Yes";
  if (/cracked the code|hidden code|what did you get.*code/.test(normalized)) return "42";
  if (/most complex technical challenges|technical challenges.*lithic/.test(normalized)) {
    return "From the outside, Lithic's hardest technical problems look like correctness and reliability at financial scale: keeping a ledger/source of truth consistent across card network events, ACH/wire settlement, reconciliation, webhooks, retries, and customer-facing APIs while maintaining low-latency developer workflows, auditability, idempotency, and strong operational controls. The team likely has to evolve systems quickly without introducing double-spend, drift, or reconciliation gaps.";
  }
  if (/linkedin/.test(normalized)) return profile.linkedinUrl;
  if (/github|git hub/.test(normalized)) return lookupApplicationAnswer(explicitAnswers, "github", "text") || "";
  if (/website|portfolio/.test(normalized)) return website;
  if (/acknowledge.*privacy notice|read and understand.*privacy notice|privacy notice/.test(normalized)) {
    return pickChoice(choices, ["Acknowledge/Confirm", "I agree", "Yes"], "Acknowledge/Confirm");
  }
  if (/double check|double-check|reviewed and confirmed|information provided.*accurate|accuracy is crucial/.test(normalized)) {
    return pickChoice(
      choices,
      ["I have reviewed and confirmed that all the information provided is accurate and complete.", "Yes"],
      "I have reviewed and confirmed that all the information provided is accurate and complete.",
    );
  }
  if (/pronoun/.test(normalized)) return "";
  if (/lgbt|sexual orientation|transgender|gender identity/.test(normalized)) {
    return pickNonDisclosureChoice(choices, "I don't wish to answer");
  }
  if (/disability/.test(normalized)) return pickNonDisclosureChoice(choices, "I do not want to answer");
  if (/\brace\b|ethnic|hispanic|latino|latina|latine/.test(normalized)) return pickNonDisclosureChoice(choices, "Decline To Self Identify");
  if (/gender/.test(normalized)) return pickNonDisclosureChoice(choices, "Decline To Self Identify");
  if (/veteran/.test(normalized)) {
    return pickChoice(
      choices,
      ["I am not a protected Veteran", "I am not a U.S. military protected veteran", "No"],
      "I am not a protected Veteran",
    );
  }

  return lookupApplicationAnswer(explicitAnswers, label, type) || "";
}

async function isGreenhouseReactSelectInput(field: Locator): Promise<boolean> {
  return field
    .evaluate((node) => {
      const element = node as HTMLInputElement;
      return (
        element.tagName.toLowerCase() === "input" &&
        element.getAttribute("role") === "combobox" &&
        Boolean(element.closest(".select"))
      );
    })
    .catch(() => false);
}

async function readGreenhouseReactSelectDisplay(field: Locator): Promise<string> {
  return tidy(
    await field
      .evaluate((node) => {
        const select = (node as HTMLElement).closest(".select");
        if (!select) return "";
        const selectedValues = Array.from(
          select.querySelectorAll(".select__single-value, .select__multi-value__label"),
        )
          .map((element) => element.textContent || "")
          .join(" ");
        return selectedValues || (node as HTMLInputElement).value || "";
      })
      .catch(() => ""),
  );
}

async function setGreenhouseReactSelectValue(page: Page, field: Locator, value: string): Promise<boolean> {
  const candidates = buildComboboxCandidateValues(value);
  for (const candidate of candidates) {
    await field.scrollIntoViewIfNeeded().catch(() => undefined);
    await field.click({ timeout: 5000, force: true }).catch(() => undefined);
    await field.press("Control+A").catch(() => undefined);
    await field.fill(candidate).catch(async () => {
      await page.keyboard.type(candidate).catch(() => undefined);
    });
    await page.waitForTimeout(650).catch(() => undefined);

    const option = await page
      .locator('.select__menu [role="option"]')
      .evaluateAll(
        (nodes, desired) => {
          const normalize = (value: string) =>
            value
              .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
              .replace(/[_-]+/g, " ")
              .toLowerCase()
              .replace(/[^a-z0-9\s]/g, " ")
              .replace(/\s+/g, " ")
              .trim();
          const normalizedDesired = normalize(desired as string);
          const isNonDisclosure = (value: string) =>
            /prefer not|decline|self identify|wish to answer|do not wish|do not want|choose not|rather not|no answer|not say|not declar|not disclos/.test(
              normalize(value),
            );
          const desiredIsNonDisclosure = isNonDisclosure(desired as string);
          const visible = nodes
            .map((node) => {
              const element = node as HTMLElement;
              const rect = element.getBoundingClientRect();
              const style = window.getComputedStyle(element);
              const text = (element.textContent || "").replace(/\s+/g, " ").trim();
              return {
                id: element.id,
                text,
                visible:
                  rect.width > 0 &&
                  rect.height > 0 &&
                  style.display !== "none" &&
                  style.visibility !== "hidden",
              };
            })
            .filter((entry) => entry.visible && entry.text);

          return (
            visible.find((entry) => {
              const normalizedText = normalize(entry.text);
              return (
                normalizedText === normalizedDesired ||
                normalizedText.includes(normalizedDesired) ||
                normalizedDesired.includes(normalizedText) ||
                (desiredIsNonDisclosure && isNonDisclosure(entry.text))
              );
            }) ||
            (visible.length === 1 ? visible[0] : null)
          );
        },
        candidate,
      )
      .catch(() => null as { id: string; text: string } | null);

    if (option?.id) {
      await page.locator(`[id="${escapeAttributeValue(option.id)}"]`).click({ timeout: 5000, force: true }).catch(
        () => undefined,
      );
      await page.waitForTimeout(500).catch(() => undefined);
    } else {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(150).catch(() => undefined);
      continue;
    }

    const selected = await readGreenhouseReactSelectDisplay(field);
    if (
      isMeaningfulValue(selected) &&
      (matchesDesiredChoice(selected, candidate) ||
        candidates.some((candidateValue) => matchesDesiredChoice(selected, candidateValue)) ||
        (isNonDisclosureOption(selected) && candidates.some((candidateValue) => isNonDisclosureOption(candidateValue))))
    ) {
      return true;
    }
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  const selected = await readGreenhouseReactSelectDisplay(field);
  return isMeaningfulValue(selected) && candidates.some((candidate) => matchesDesiredChoice(selected, candidate));
}

async function runGreenhouseCustomReactAutofill(
  page: Page,
  profile: Profile,
): Promise<DirectSiteAutofillResult> {
  const hasCustomForm =
    (await page.locator('form input[name="jobId"], form input[name="boardToken"]').count().catch(() => 0)) > 0;
  if (!hasCustomForm) {
    return { filled: [], skipped: [], handled: false };
  }

  const explicitAnswers = await loadApplicationAnswers();
  const resumePath = await resolveResumeFilePath(profile).catch(() => "");
  const fields = page.locator("form input, form textarea, form select");
  const count = await fields.count().catch(() => 0);
  const filled: string[] = [];
  const skipped: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const field = fields.nth(index);
    const visible = await field.isVisible().catch(() => false);
    const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
    const type = tidy(await field.getAttribute("type").catch(() => ""));
    const name = tidy(await field.getAttribute("name").catch(() => ""));
    if (!visible || ["hidden", "submit", "button", "reset"].includes(type)) {
      continue;
    }

    const label = await readNearbyFieldLabel(field);
    const displayLabel = cleanExtractedLabel(label) || name || "Custom Greenhouse field";
    const isReactSelect = await isGreenhouseReactSelectInput(field);
    if (type === "file") {
      if (name === "cover_letter" || /cover letter/i.test(displayLabel)) {
        skipped.push(displayLabel);
        continue;
      }
      if (!resumePath) {
        skipped.push(displayLabel);
        continue;
      }
      const uploaded = await uploadFile(page, field, resumePath);
      if (uploaded) {
        filled.push(displayLabel);
      } else {
        skipped.push(displayLabel);
      }
      continue;
    }

    const currentValue = isReactSelect
      ? await readGreenhouseReactSelectDisplay(field)
      : await readFieldCurrentValue(field, tag, type).catch(() => "");
    if (isMeaningfulValue(currentValue)) {
      filled.push(displayLabel);
      continue;
    }

    const choices = tag === "select" ? await readNativeSelectChoices(field) : [];
    const answer = getCustomGreenhouseAnswer(
      displayLabel,
      name,
      isReactSelect ? "combobox" : tag || type,
      choices,
      profile,
      explicitAnswers,
    );
    if (!answer) {
      skipped.push(displayLabel);
      continue;
    }

    const applied =
      isReactSelect
        ? await setGreenhouseReactSelectValue(page, field, answer)
        : tag === "select"
        ? await setNativeSelectByBestChoice(field, choices, [answer])
        : await setEditableFieldValue(page, field, tag, answer);
    if (applied) {
      filled.push(displayLabel);
    } else {
      skipped.push(displayLabel);
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    handled: true,
  };
}

function isDoverApplicationUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.hostname.toLowerCase() === "app.dover.com" && /\/apply\//i.test(parsed.pathname);
  } catch {
    return /app\.dover\.com\/apply\//i.test(value);
  }
}

async function fillFirstLocatorValue(
  page: Page,
  selector: string,
  value: string,
  label: string,
  filled: string[],
  skipped: string[],
): Promise<void> {
  const field = page.locator(selector).first();
  if (!(await field.isVisible().catch(() => false)) || !value.trim()) {
    skipped.push(label);
    return;
  }

  const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "input");
  if (await setEditableFieldValue(page, field, tag, value)) {
    filled.push(label);
  } else {
    skipped.push(label);
  }
}

async function uploadAllMatchingFiles(
  page: Page,
  selector: string,
  filePath: string,
  label: string,
  filled: string[],
  skipped: string[],
): Promise<void> {
  if (!filePath) {
    skipped.push(label);
    return;
  }

  const fields = page.locator(selector);
  const count = await fields.count().catch(() => 0);
  let uploaded = false;
  for (let index = 0; index < count; index += 1) {
    const field = fields.nth(index);
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }
    const aria = tidy(await field.getAttribute("aria-label").catch(() => ""));
    if (/profile image|avatar|photo/i.test(aria)) {
      continue;
    }
    uploaded = (await uploadFile(page, field, filePath)) || uploaded;
  }

  if (uploaded) {
    filled.push(label);
  } else {
    skipped.push(label);
  }
}

async function chooseDoverRadioByContext(page: Page, contextPattern: RegExp, desiredValue: string): Promise<boolean> {
  const names = await page
    .locator('input[type="radio"]')
    .evaluateAll((nodes, rawPattern) => {
      const pattern = new RegExp(String(rawPattern), "i");
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const results: string[] = [];
      for (const node of nodes) {
        const input = node as HTMLInputElement;
        const name = input.getAttribute("name") || "";
        if (!name || results.includes(name)) {
          continue;
        }
        let current: HTMLElement | null = input;
        let context = "";
        for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
          context = `${read(current.textContent)} ${context}`;
          if (pattern.test(context)) {
            results.push(name);
            break;
          }
        }
      }
      return results;
    }, contextPattern.source)
    .catch(() => []);

  for (const name of names) {
    const radio = page
      .locator(`input[type="radio"][name="${escapeAttributeValue(name)}"][value="${escapeAttributeValue(desiredValue)}"]`)
      .first();
    if (await radio.isVisible().catch(() => false)) {
      await radio.check({ force: true }).catch(() => undefined);
      await radio.dispatchEvent("change").catch(() => undefined);
      if (await radio.isChecked().catch(() => false)) {
        return true;
      }
    }
  }

  return false;
}

async function runDoverDirectAutofill(page: Page, profile: Profile): Promise<DirectSiteAutofillResult> {
  if (!isDoverApplicationUrl(page.url())) {
    return { filled: [], skipped: [], handled: false };
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  const first = profile.name.split(/\s+/)[0] || "";
  const last = profile.name.split(/\s+/).slice(1).join(" ") || "";
  const currentLocation = [profile.city, profile.state].filter(Boolean).join(", ") || profile.location;

  await fillFirstLocatorValue(page, 'input[name="firstName"]', first, "first name", filled, skipped);
  await fillFirstLocatorValue(page, 'input[name="lastName"]', last, "last name", filled, skipped);
  await fillFirstLocatorValue(page, 'input[name="email"]', profile.email, "email", filled, skipped);
  await fillFirstLocatorValue(page, 'input[name="linkedinUrl"]', profile.linkedinUrl, "linkedin", filled, skipped);
  await fillFirstLocatorValue(page, 'input[name="phoneNumber"]', profile.phone, "phone", filled, skipped);

  if (await chooseDoverRadioByContext(page, /sponsorship|work authorization|authorization/i, "No")) {
    filled.push("work authorization sponsorship");
  } else {
    skipped.push("work authorization sponsorship");
  }
  if (await chooseDoverRadioByContext(page, /currently located|current location|where are you/i, "Other")) {
    filled.push("current location choice");
  } else {
    skipped.push("current location choice");
  }

  const locationField = page
    .locator(
      'input[type="text"]:not([name="firstName"]):not([name="lastName"]):not([name="linkedinUrl"]):not([name="phoneNumber"])',
    )
    .last();
  if (await locationField.isVisible().catch(() => false)) {
    if (await setEditableFieldValue(page, locationField, "input", currentLocation)) {
      filled.push("current location");
    } else {
      skipped.push("current location");
    }
  }

  const resumePath = await resolveResumeFilePath(profile).catch(() => "");
  await uploadAllMatchingFiles(page, 'input[type="file"]', resumePath, "resume upload", filled, skipped);

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    handled: true,
  };
}

async function findWorkableEditableFieldByContext(page: Page, pattern: RegExp): Promise<Locator | null> {
  const selector =
    'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea';
  const match = await page
    .locator(selector)
    .evaluateAll(
      (nodes, rawPattern) => {
        const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
        const pattern = new RegExp((rawPattern as { source: string; flags: string }).source, (rawPattern as { source: string; flags: string }).flags);

        for (let index = 0; index < nodes.length; index += 1) {
          const element = nodes[index] as HTMLInputElement | HTMLTextAreaElement;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") {
            continue;
          }

          const id = element.getAttribute("id") || "";
          const labelText = id ? read(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) : "";
          const parts = [
            labelText,
            read(element.closest("label")?.textContent),
            read(element.getAttribute("aria-label")),
            read(element.getAttribute("placeholder")),
            read(element.getAttribute("name")),
          ];
          let current: HTMLElement | null = element;
          for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
            parts.push(read(current.textContent));
          }

          if (pattern.test(parts.join(" "))) {
            return { index };
          }
        }

        return null;
      },
      { source: pattern.source, flags: pattern.flags },
    )
    .catch(() => null);

  return match ? page.locator(selector).nth(match.index) : null;
}

async function runWorkableDirectAutofill(page: Page, profile: Profile): Promise<DirectSiteAutofillResult> {
  if (!/workable\.com/i.test(page.url()) && (await page.locator('form[data-ui="application-form"]').count().catch(() => 0)) === 0) {
    return { filled: [], skipped: [], handled: false };
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  const first = profile.name.split(/\s+/)[0] || "";
  const last = profile.name.split(/\s+/).slice(1).join(" ") || "";
  const phoneDigits = profile.phone.replace(/\D/g, "");
  const localPhone = phoneDigits.length === 11 && phoneDigits.startsWith("1") ? phoneDigits.slice(1) : phoneDigits;

  await fillFirstLocatorValue(page, 'input[name="firstname"]', first, "first name", filled, skipped);
  await fillFirstLocatorValue(page, 'input[name="lastname"]', last, "last name", filled, skipped);
  await fillFirstLocatorValue(page, 'input[name="email"]', profile.email, "email", filled, skipped);
  await fillFirstLocatorValue(page, 'input[name="phone"]', localPhone || profile.phone, "phone", filled, skipped);

  const salaryField = await findWorkableEditableFieldByContext(page, /salary|compensation|desired pay|pay expectation/i);
  if (salaryField) {
    const tag = await salaryField.evaluate((node) => node.tagName.toLowerCase()).catch(() => "input");
    if (await setEditableFieldValue(page, salaryField, tag, "150000")) {
      filled.push("salary expectation");
    } else {
      skipped.push("salary expectation");
    }
  }

  const addressField = page.locator('input[name="address"]').first();
  const addressValue = tidy(await addressField.inputValue().catch(() => ""));
  if (/i do not wish|prefer not|yes|no/i.test(addressValue)) {
    await addressField.fill("").catch(() => undefined);
    await addressField.dispatchEvent("input").catch(() => undefined);
    await addressField.dispatchEvent("change").catch(() => undefined);
    filled.push("clear malformed optional address");
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    handled: true,
  };
}

async function readRipplingComboboxText(field: Locator): Promise<string> {
  return tidy(
    await field
      .evaluate((node) => {
        const element = node as HTMLInputElement | HTMLElement;
        return (
          (element instanceof HTMLInputElement ? element.value : "") ||
          element.textContent ||
          element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          ""
        ).replace(/\s+/g, " ");
      })
      .catch(() => ""),
  );
}

async function getRipplingSelectableComboboxes(page: Page): Promise<Locator[]> {
  const selector = '[role="combobox"]';
  const indices = await page
    .locator(selector)
    .evaluateAll((nodes) => {
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      return nodes
        .map((node, index) => {
          const element = node as HTMLInputElement | HTMLElement;
          const rect = element.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
          const value = element instanceof HTMLInputElement ? read(element.value) : "";
          const text = read(element.textContent);
          const placeholder = element instanceof HTMLInputElement ? read(element.placeholder) : "";
          const aria = read(element.getAttribute("aria-label"));
          const combined = `${value} ${text} ${placeholder} ${aria}`;
          const selectLike = /\bselect\b/i.test(combined);
          const skip = /\+\d|pronouns?|search/i.test(combined) && !selectLike;
          return { index, visible, selectLike, skip };
        })
        .filter((candidate) => candidate.visible && candidate.selectLike && !candidate.skip)
        .map((candidate) => candidate.index);
    })
    .catch(() => [] as number[]);

  return indices.map((index) => page.locator(selector).nth(index));
}

async function selectRipplingComboboxValue(page: Page, field: Locator, candidates: string[]): Promise<boolean> {
  await field.scrollIntoViewIfNeeded().catch(() => undefined);
  await field.click({ timeout: 5_000, force: true }).catch(() => undefined);
  await page.waitForTimeout(400).catch(() => undefined);

  const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
  for (const candidate of candidates) {
    if (tag === "input") {
      await field.fill(candidate).catch(() => undefined);
      await page.waitForTimeout(500).catch(() => undefined);
    }

    if (await clickVisibleOptionByText(page, candidate)) {
      await page.waitForTimeout(350).catch(() => undefined);
      const selected = await readRipplingComboboxText(field);
      if (matchesDesiredChoice(selected, candidate) || isMeaningfulValue(selected)) {
        return true;
      }
    }
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  return false;
}

async function runRipplingDirectAutofill(page: Page, profile: Profile): Promise<DirectSiteAutofillResult> {
  if ((await detectApplicationSiteKind(page)) !== "rippling") {
    return { filled: [], skipped: [], handled: false };
  }

  const filled: string[] = [];
  const skipped: string[] = [];

  if (!/\/apply\b/i.test(page.url())) {
    const applyButton = page.locator('button:has-text("Apply now"), button:has-text("Apply")').first();
    if (await applyButton.isVisible().catch(() => false)) {
      const clicked =
        (await applyButton.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
        (await applyButton.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
      if (clicked) {
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await page.waitForTimeout(1_200).catch(() => undefined);
        return { filled: ["Rippling Apply Now"], skipped: [], handled: true, advanced: true };
      }
    }

    return { filled: [], skipped: ["Rippling Apply Now"], handled: false };
  }

  const [firstName, ...lastNameParts] = profile.name.split(/\s+/).filter(Boolean);
  await fillFirstLocatorValue(page, 'input[placeholder="First name"]', firstName || "", "Rippling First Name", filled, skipped);
  await fillFirstLocatorValue(
    page,
    'input[placeholder="Last name"]',
    lastNameParts.join(" "),
    "Rippling Last Name",
    filled,
    skipped,
  );
  await fillFirstLocatorValue(page, 'input[placeholder="Email"]', profile.email, "Rippling Email", filled, skipped);
  await fillFirstLocatorValue(
    page,
    'input[placeholder="Phone number"]',
    profile.phone.replace(/\D/g, ""),
    "Rippling Phone",
    filled,
    skipped,
  );
  await fillFirstLocatorValue(
    page,
    'input[placeholder="LinkedIn Link"]',
    profile.linkedinUrl,
    "Rippling LinkedIn",
    filled,
    skipped,
  );

  const locationField = page.locator('input[aria-label="textbox"], input[placeholder*="Location" i]').first();
  if (await locationField.isVisible().catch(() => false)) {
    await locationField.fill([profile.city, profile.state].filter(Boolean).join(", ")).catch(() => undefined);
    await page.waitForTimeout(600).catch(() => undefined);
    const selected = await clickVisibleOptionByText(page, `${profile.city}, ${profile.state}, USA`);
    if (selected || isMeaningfulValue(await locationField.inputValue().catch(() => ""))) {
      filled.push("Rippling Location");
    } else {
      skipped.push("Rippling Location");
    }
  }

  const sourceField = await findWorkableEditableFieldByContext(page, /how did you hear|source|job board/i);
  if (sourceField) {
    const applied = await setEditableFieldValue(page, sourceField, "input", "LinkedIn");
    if (applied) filled.push("Rippling Source");
    else skipped.push("Rippling Source");
  }

  const salaryField = await findWorkableEditableFieldByContext(page, /salary|compensation|desired salary|desired pay/i);
  if (salaryField) {
    const applied = await setEditableFieldValue(page, salaryField, "input", "$150,000 - $175,000");
    if (applied) filled.push("Rippling Salary");
    else skipped.push("Rippling Salary");
  }

  const resumePath = await resolveResumeFilePath(profile).catch(() => "");
  await uploadAllMatchingFiles(page, 'input[type="file"]', resumePath, "Rippling Resume Upload", filled, skipped);

  const selectComboboxes = await getRipplingSelectableComboboxes(page);
  const selections: Array<{ index: number; values: string[]; label: string }> = [
    { index: 0, values: ["No"], label: "Rippling Sponsorship" },
    { index: 1, values: ["Choose not to disclose", "Not declared", "Decline to state"], label: "Rippling Gender" },
    { index: 2, values: ["Choose not to disclose", "Decline to state"], label: "Rippling Race" },
    { index: 3, values: ["Choose not to disclose", "No"], label: "Rippling Hispanic/Latino" },
    { index: 4, values: ["I am not a protected veteran", "I AM NOT A VETERAN"], label: "Rippling Veteran" },
    { index: 5, values: ["I don't wish to answer", "I do not wish to answer"], label: "Rippling Disability" },
  ];
  for (const selection of selections) {
    const field = selectComboboxes[selection.index];
    if (!field) {
      continue;
    }
    const current = await readRipplingComboboxText(field);
    if (isMeaningfulValue(current) && !/select/i.test(current)) {
      filled.push(selection.label);
      continue;
    }
    const applied = await selectRipplingComboboxValue(page, field, selection.values);
    if (applied) filled.push(selection.label);
    else skipped.push(selection.label);
  }

  const noChoices = page.locator('[role="checkbox"][data-value="No"], [role="radio"][data-value="false"]');
  const noChoiceCount = await noChoices.count().catch(() => 0);
  for (let index = 0; index < noChoiceCount; index += 1) {
    const choice = noChoices.nth(index);
    if (!(await choice.isVisible().catch(() => false))) {
      continue;
    }
    const checked = (await choice.getAttribute("aria-checked").catch(() => "")) === "true";
    if (!checked) {
      await choice.click({ timeout: 5_000, force: true }).catch(() => undefined);
      await page.waitForTimeout(150).catch(() => undefined);
    }
  }
  if (noChoiceCount > 0) {
    filled.push("Rippling No choices");
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    handled: true,
  };
}

async function fillSmartRecruitersTextBySelectors(
  page: Page,
  selectors: string[],
  value: string,
  label: string,
  filled: string[],
  skipped: string[],
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const field = await findFirstVisibleField(page, selectors);
  if (!field || !value.trim()) {
    skipped.push(label);
    return;
  }

  const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "input");
  const currentValue = await readFieldCurrentValue(field, tag).catch(() => "");
  if (!options.overwrite && isAcceptableEditableValue(currentValue, value)) {
    filled.push(label);
    return;
  }

  const applied = await setEditableFieldValue(page, field, tag, value);
  if (applied) {
    filled.push(label);
  } else {
    skipped.push(label);
  }
}

async function clickSmartRecruitersVisibleOption(page: Page, pattern: RegExp): Promise<boolean> {
  const optionBox = await page
    .locator('spl-select-option, [role="option"], [class*="option" i]')
    .evaluateAll((nodes, source) => {
      const regex = new RegExp(source, "i");
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      for (const node of nodes) {
        const element = node as HTMLElement;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") {
          continue;
        }
        if (regex.test(read(element.textContent))) {
          return {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
          };
        }
      }
      return null;
    }, pattern.source)
    .catch(() => null as { x: number; y: number } | null);

  if (!optionBox) {
    return false;
  }

  await page.mouse.click(optionBox.x, optionBox.y).catch(() => undefined);
  await page.waitForTimeout(500).catch(() => undefined);
  return true;
}

async function selectSmartRecruitersPhoneCountryCode(page: Page): Promise<boolean> {
  const trigger = page.locator('button[aria-label="Country code"], button#spl-form-element_12').first();
  if (!(await trigger.isVisible().catch(() => false))) {
    return false;
  }

  await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
  const box = await trigger.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
  } else {
    await trigger.click({ timeout: 3_000, force: true }).catch(() => undefined);
  }

  await page.waitForTimeout(500).catch(() => undefined);
  const search = page.locator('input[placeholder="Search by country/region or code"]:visible').first();
  if (await search.isVisible().catch(() => false)) {
    await search.fill("United States", { timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(500).catch(() => undefined);
  }

  return clickSmartRecruitersVisibleOption(page, /United States\s*\+1/);
}

async function selectSmartRecruitersAutocompleteValue(
  page: Page,
  selectors: string[],
  value: string,
): Promise<boolean> {
  const field = await findFirstVisibleField(page, selectors);
  if (!field) {
    return false;
  }

  await field.scrollIntoViewIfNeeded().catch(() => undefined);
  await field.click({ timeout: 3_000 }).catch(() => undefined);
  await field.fill("", { timeout: 3_000 }).catch(() => undefined);
  await field.fill(value, { timeout: 5_000 }).catch(() => undefined);
  await field.dispatchEvent("input").catch(() => undefined);
  await field.dispatchEvent("change").catch(() => undefined);
  await page.waitForTimeout(700).catch(() => undefined);
  const clicked = await clickSmartRecruitersVisibleOption(page, new RegExp(`^${escapeRegExp(value)}$|${escapeRegExp(value)}`));
  if (!clicked) {
    await field.press("ArrowDown").catch(() => undefined);
    await field.press("Enter").catch(() => undefined);
    await page.waitForTimeout(300).catch(() => undefined);
  }

  const currentValue = await field.inputValue().catch(() => "");
  return isAcceptableEditableValue(currentValue, value);
}

async function uploadSmartRecruitersResume(page: Page, profile: Profile): Promise<boolean> {
  const resumePath = await resolveResumeFilePath(profile).catch(() => "");
  if (!resumePath) {
    return false;
  }

  const candidates = await page
    .locator('input[type="file"]')
    .evaluateAll((nodes) => {
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      return nodes
        .map((node, index) => {
          const input = node as HTMLInputElement;
          const rect = input.getBoundingClientRect();
          const accept = read(input.getAttribute("accept")).toLowerCase();
          const aria = read(input.getAttribute("aria-label")).toLowerCase();
          const container = input.closest("oc-upload-file, oc-profile-image, spl-form-field, label, div");
          const context = read(container?.textContent).toLowerCase();
          const imageOnly = /image|avatar|photo|profile/.test(`${accept} ${aria} ${context}`) && !/resume|cv/.test(context);
          const resumeLike =
            /resume|cv|curriculum/.test(`${aria} ${context}`) ||
            /pdf|doc|docx|rtf|txt|msword|wordprocessingml/.test(accept);
          return {
            index,
            y: rect.y,
            imageOnly,
            score: (resumeLike ? 10 : 0) + (rect.y > 300 ? 2 : 0) + (rect.width > 0 && rect.height > 0 ? 1 : 0),
          };
        })
        .filter((candidate) => !candidate.imageOnly)
        .sort((left, right) => right.score - left.score || right.y - left.y);
    })
    .catch(() => [] as Array<{ index: number; score: number }>);

  for (const candidate of candidates) {
    const field = page.locator('input[type="file"]').nth(candidate.index);
    if (await uploadFile(page, field, resumePath)) {
      return true;
    }
  }

  return false;
}

async function runSmartRecruitersDirectAutofill(page: Page, profile: Profile): Promise<DirectSiteAutofillResult> {
  if ((await detectApplicationSiteKind(page)) !== "smartrecruiters") {
    return { filled: [], skipped: [], handled: false };
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  const first = profile.name.split(/\s+/)[0] || "";
  const last = profile.name.split(/\s+/).slice(1).join(" ") || "";
  const websiteAnswers = await loadApplicationAnswers();
  const website =
    lookupApplicationAnswer(websiteAnswers, "website", "text") ||
    lookupApplicationAnswer(websiteAnswers, "portfolio", "text") ||
    "";

  await fillSmartRecruitersTextBySelectors(page, ['input#first-name-input'], first, "first name", filled, skipped);
  await fillSmartRecruitersTextBySelectors(page, ['input#last-name-input'], last, "last name", filled, skipped);
  await fillSmartRecruitersTextBySelectors(page, ['input#email-input'], profile.email, "email", filled, skipped);
  await fillSmartRecruitersTextBySelectors(
    page,
    ['input#confirm-email-input'],
    profile.email,
    "confirm email",
    filled,
    skipped,
  );
  const phoneCodeSelected = await selectSmartRecruitersPhoneCountryCode(page);
  if (phoneCodeSelected) {
    filled.push("phone country code");
  } else {
    skipped.push("phone country code");
  }
  await fillSmartRecruitersTextBySelectors(
    page,
    ['input#spl-form-element_5', 'input[type="tel"][aria-label*="phone" i]'],
    profile.phone.replace(/\D/g, ""),
    "phone",
    filled,
    skipped,
    { overwrite: true },
  );
  await fillSmartRecruitersTextBySelectors(page, ['input#linkedin-input'], profile.linkedinUrl, "linkedin", filled, skipped);
  if (website) {
    await fillSmartRecruitersTextBySelectors(page, ['input#website-input'], website, "website", filled, skipped);
  }
  await fillSmartRecruitersTextBySelectors(
    page,
    ['textarea#hiring-manager-message-input'],
    profile.resumeSummary,
    "message",
    filled,
    skipped,
  );

  const countrySelected = await selectSmartRecruitersAutocompleteValue(
    page,
    ['input[placeholder="Country/Region"]', 'input#spl-form-element_15'],
    "United States",
  );
  if (countrySelected) {
    filled.push("country");
  } else {
    skipped.push("country");
  }

  await fillSmartRecruitersTextBySelectors(
    page,
    ['input[placeholder="City"]', 'input#spl-form-element_14', 'input#spl-form-element_10'],
    profile.city || profile.location,
    "city",
    filled,
    skipped,
    { overwrite: true },
  );

  const uploaded = await uploadSmartRecruitersResume(page, profile);
  if (uploaded) {
    filled.push("resume upload");
  } else {
    skipped.push("resume upload");
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    handled: filled.length > 0 || skipped.length > 0,
  };
}

type LocatorHost = Pick<Page, "locator"> | FrameLocator;

async function resolvePaycorScope(page: Page): Promise<LocatorHost | null> {
  const iframe = page.locator('iframe#gnewtonIframe, iframe[src*="recruitingbypaycor.com"]').first();
  if (await iframe.isVisible().catch(() => false)) {
    return page.frameLocator('iframe#gnewtonIframe, iframe[src*="recruitingbypaycor.com"]');
  }

  if (inferApplicationSiteKind(page.url()) === "paycor") {
    return page;
  }

  return null;
}

async function paycorFill(scope: LocatorHost, selector: string, value: string): Promise<boolean> {
  const field = scope.locator(selector).first();
  if (!(await field.isVisible().catch(() => false)) || !value.trim()) {
    return false;
  }

  await field.scrollIntoViewIfNeeded().catch(() => undefined);
  await field.fill(value, { timeout: 5_000 }).catch(() => undefined);
  await field
    .evaluate((node, nextValue) => {
      const element = node as HTMLInputElement | HTMLTextAreaElement;
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      descriptor?.set?.call(element, nextValue as string);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
    }, value)
    .catch(() => undefined);

  const currentValue = await field.inputValue().catch(() => "");
  return isAcceptableEditableValue(currentValue, value);
}

async function paycorSelect(scope: LocatorHost, selector: string, values: string[]): Promise<boolean> {
  const field = scope.locator(selector).first();
  if (!(await field.isVisible().catch(() => false))) {
    return false;
  }
  await field.scrollIntoViewIfNeeded().catch(() => undefined);
  return selectNativeOption(field, values);
}

async function paycorCheck(scope: LocatorHost, selector: string): Promise<boolean> {
  const field = scope.locator(selector).first();
  if (!(await field.isVisible().catch(() => false))) {
    return false;
  }

  await field.scrollIntoViewIfNeeded().catch(() => undefined);
  const checked =
    (await field.isChecked().catch(() => false)) ||
    (await field.check({ timeout: 5_000, force: true }).then(() => true).catch(() => false)) ||
    (await field
      .evaluate((node) => {
        const input = node as HTMLInputElement;
        input.checked = true;
        input.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        input.checked = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return input.checked;
      })
      .catch(() => false));
  return checked;
}

function inferPaycorScreenerAnswer(context: string): "yes" | "no" | "" {
  const normalized = normalizeQuestionText(context);
  if (!normalized) {
    return "";
  }
  if (/sponsor|sponsorship|work visa|employment visa/.test(normalized)) return "no";
  if (/kafka|similar streaming/.test(normalized)) return "no";
  if (/human applicant|completing.*application.*yourself|without automation/.test(normalized)) return "no";
  if (/python|sql|kubernetes|core hours|authorized|work in the united states|own behalf|accurate identity|confirm.*identity|truthful|complete and accurate/.test(normalized)) {
    return "yes";
  }
  return "";
}

async function answerPaycorScreenerRadios(scope: LocatorHost): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const groups = await scope
    .locator('input[type="radio"]')
    .evaluateAll((nodes) => {
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const byName = new Map<string, { name: string; context: string; options: Array<{ id: string; value: string; label: string }> }>();
      for (const node of nodes) {
        const input = node as HTMLInputElement;
        const name = input.name || input.getAttribute("name") || input.id;
        if (!name) continue;
        const optionLabel =
          read(input.labels?.[0]?.textContent) ||
          read(document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent) ||
          read(input.closest("label")?.textContent);
        const container = input.closest("li, tr, fieldset, .form-group, div");
        const context = read(container?.textContent);
        const existing = byName.get(name) ?? { name, context: "", options: [] };
        existing.context = `${existing.context} ${context}`.trim();
        existing.options.push({ id: input.id, value: input.value, label: optionLabel });
        byName.set(name, existing);
      }
      return Array.from(byName.values());
    })
    .catch(() => [] as Array<{ name: string; context: string; options: Array<{ id: string; value: string; label: string }> }>);

  for (const group of groups) {
    const answer = inferPaycorScreenerAnswer(group.context);
    if (!answer) {
      continue;
    }
    const option = group.options.find((candidate) =>
      answer === "yes"
        ? /^(yes|true|1)$/i.test(`${candidate.label || candidate.value}`.trim())
        : /^(no|false|0)$/i.test(`${candidate.label || candidate.value}`.trim()),
    );
    if (!option?.id) {
      skipped.push(cleanExtractedLabel(group.context) || group.name);
      continue;
    }
    const applied = await paycorCheck(scope, `input[id="${escapeCssAttributeValue(option.id)}"]`);
    if (applied) {
      filled.push(cleanExtractedLabel(group.context) || group.name);
    } else {
      skipped.push(cleanExtractedLabel(group.context) || group.name);
    }
  }

  return { filled: dedupeText(filled), skipped: dedupeText(skipped.filter((label) => !filled.includes(label))) };
}

async function runPaycorNewtonDirectAutofill(page: Page, profile: Profile): Promise<DirectSiteAutofillResult> {
  const scope = await resolvePaycorScope(page);
  if (!scope) {
    return { filled: [], skipped: [], handled: false };
  }

  await scope.locator("body").waitFor({ timeout: 10_000 }).catch(() => undefined);
  const bodyText = normalizeQuestionText(await scope.locator("body").innerText().catch(() => ""));
  if (/your information has been uploaded successfully|thank you for applying|application submitted/.test(bodyText)) {
    return { filled: [], skipped: [], handled: true, submitted: true };
  }

  const filled: string[] = [];
  const skipped: string[] = [];

  const applyButton = scope.locator(".gnewtonApplyBtn").first();
  if (await applyButton.isVisible().catch(() => false)) {
    const clicked = await applyButton.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    if (clicked) {
      await page.waitForTimeout(1_500).catch(() => undefined);
      return { filled: ["paycor apply"], skipped: [], handled: true, advanced: true };
    }
  }

  const screeners = await answerPaycorScreenerRadios(scope);
  filled.push(...screeners.filled);
  skipped.push(...screeners.skipped);

  const pageTwoPresent = await scope.locator("#firstName, #gnewotn_input_9, #your-name").first().isVisible().catch(() => false);
  if (!pageTwoPresent) {
    const nextAction = scope
      .locator('input[type="button" i][value*="Next" i], input[type="submit" i][value*="Next" i], button:has-text("Next")')
      .first();
    if (await nextAction.isVisible().catch(() => false)) {
      const clicked = await nextAction.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (clicked) {
        await page.waitForTimeout(2_000).catch(() => undefined);
        return { filled: dedupeText(filled), skipped: dedupeText(skipped), handled: true, advanced: true };
      }
    }
    return { filled: dedupeText(filled), skipped: dedupeText(skipped), handled: filled.length > 0 || skipped.length > 0 };
  }

  const resumePath = await resolveResumeFilePath(profile).catch(() => "");
  if (resumePath && (await uploadFile(page, scope.locator("#uploadResumeInput").first(), resumePath))) {
    filled.push("paycor resume upload");
  } else {
    skipped.push("paycor resume upload");
  }

  const [firstName, ...lastNameParts] = profile.name.split(/\s+/).filter(Boolean);
  const paycorFields: Array<[string, string, string]> = [
    ["#firstName", firstName || "", "paycor first name"],
    ["#preferredName", firstName || profile.name, "paycor preferred name"],
    ["#lastName", lastNameParts.join(" "), "paycor last name"],
    ["#email", profile.email, "paycor email"],
    ["#mobile", profile.phone, "paycor mobile"],
    ["#address1", profile.streetAddress, "paycor address"],
    ["#city", profile.city, "paycor city"],
    ["#zipCode", profile.postalCode, "paycor zip"],
    ["#gnewotn_input_9", "North Carolina State University", "paycor school"],
    ["#gnewotn_input_11", "Computer Information Systems", "paycor major"],
    ["#gnewotn_input_14", "2017-08-01", "paycor education start"],
    ["#gnewotn_input_15", "2021-05-01", "paycor education end"],
    ["#gnewotn_input_17", profile.linkedinUrl, "paycor linkedin"],
    [
      "#gnewotn_input_18",
      "Data engineering, backend/platform engineering, cloud infrastructure, and production data workflow roles in fast-moving cross-functional environments.",
      "paycor role interests",
    ],
    [
      "#gnewotn_input_19",
      "I have built backend services, data pipelines, APIs, and cloud-deployed systems using Python, SQL, TypeScript, AWS, Docker, and Kubernetes.",
      "paycor relevant experience",
    ],
    ["#originalComments", "I am authorized to work in the United States and do not require sponsorship.", "paycor comments"],
    ["#your-name", profile.name, "paycor disability signature"],
    ["#today-date", new Date().toISOString().slice(0, 10), "paycor disability date"],
  ];

  for (const [selector, value, label] of paycorFields) {
    const applied = await paycorFill(scope, selector, value);
    if (applied) filled.push(label);
    else skipped.push(label);
  }

  const selects: Array<[string, string[], string]> = [
    ["#state", [profile.state, expandUsStateName(profile.state)], "paycor state"],
    ["#gnewton_section_40_question_50_answer", ["Bachelor of Science", "Bachelor's Degree - Other"], "paycor degree"],
    ["#gnewton_section_40_question_70_answer", ["Completed / Graduated"], "paycor education status"],
  ];
  for (const [selector, values, label] of selects) {
    const applied = await paycorSelect(scope, selector, values);
    if (applied) filled.push(label);
    else skipped.push(label);
  }

  const checks: Array<[string, string]> = [
    ["#gnewotn_input_22", "paycor sms opt out"],
    ["#genderUnknown", "paycor gender decline"],
    ["#race-8", "paycor race decline"],
    ["#not-identify", "paycor veteran not protected"],
    ["#declined_disability", "paycor disability decline"],
    ["#gnewotn_input_42", "paycor ccpa"],
  ];
  for (const [selector, label] of checks) {
    const applied = await paycorCheck(scope, selector);
    if (applied) filled.push(label);
    else skipped.push(label);
  }

  const invalidRequired = await scope
    .locator("input[required], select[required], textarea[required]")
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
          const value = input instanceof HTMLInputElement && ["checkbox", "radio"].includes(input.type) ? String(input.checked) : input.value;
          return { id: input.id, valid: input.checkValidity?.() ?? true, value };
        })
        .filter((field) => !field.valid),
    )
    .catch(() => [] as Array<{ id: string; valid: boolean; value: string }>);
  if (invalidRequired.length > 0) {
    skipped.push(...invalidRequired.map((field) => `paycor required ${field.id}`));
    return { filled: dedupeText(filled), skipped: dedupeText(skipped), handled: true };
  }

  const submit = scope.locator("#gnewotn_input_43").first();
  if (await submit.isVisible().catch(() => false)) {
    const clicked = await submit.click({ timeout: 8_000 }).then(() => true).catch(() => false);
    if (clicked) {
      await page.waitForTimeout(8_000).catch(() => undefined);
      const afterText = normalizeQuestionText(await scope.locator("body").innerText().catch(() => ""));
      return {
        filled: dedupeText(filled),
        skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
        handled: true,
        submitted: /your information has been uploaded successfully|thank you for applying|application submitted/.test(afterText),
      };
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    handled: true,
  };
}

async function runGreenhouseHostedAutofill(
  page: Page,
  _scope: LocatorScope,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const explicitAnswers = await loadApplicationAnswers();
  const bank = await loadQuestionBank();
  const filled: string[] = [];
  const skipped: string[] = [];
  const usedFieldKeys = new Set<string>();
  const expandedProfileState = expandUsStateName(profile.state) || profile.state;
  const preferredLocation =
    [profile.city, expandedProfileState, "United States"].filter(Boolean).join(", ") ||
    [profile.city, profile.state].filter(Boolean).join(", ") ||
    profile.location;
  const shortPreferredLocation = [profile.city, profile.state].filter(Boolean).join(", ") || profile.location;
  const attempts: Array<{
    name: string;
    patterns: string[];
    fallbackLabel: string;
    value?: string;
    values?: string[];
  }> = [
    {
      name: "first name",
      patterns: ["legal first name", "first name", "given name"],
      fallbackLabel: "Legal First Name",
      value: profile.name.split(/\s+/)[0] || "",
    },
    {
      name: "last name",
      patterns: ["legal last name", "last name", "surname", "family name"],
      fallbackLabel: "Legal Last Name",
      value: profile.name.split(/\s+/).slice(1).join(" "),
    },
    {
      name: "email",
      patterns: ["email"],
      fallbackLabel: "Email",
      value: profile.email,
    },
    {
      name: "phone",
      patterns: ["phone"],
      fallbackLabel: "Phone",
      value: profile.phone,
    },
    {
      name: "preferred first name",
      patterns: ["preferred first name"],
      fallbackLabel: "Preferred First Name",
      value: profile.name.split(/\s+/)[0] || "",
    },
    {
      name: "location",
      patterns: ["location"],
      fallbackLabel: "Location",
      values: [preferredLocation, shortPreferredLocation],
    },
    {
      name: "linkedin",
      patterns: ["linkedin profile"],
      fallbackLabel: "LinkedIn Profile",
      value: profile.linkedinUrl,
    },
    {
      name: "website",
      patterns: ["website", "portfolio"],
      fallbackLabel: "Website",
    },
    {
      name: "github",
      patterns: ["github", "git hub"],
      fallbackLabel: "GitHub",
    },
    {
      name: "how did you hear",
      patterns: ["how did you hear about this job", "how did you hear about", "where did you hear", "where did you learn"],
      fallbackLabel: "How did you hear about this job?",
      value: "LinkedIn",
    },
    {
      name: "employee referral",
      patterns: ["did an employee refer you", "employee referral", "employee refer", "referred you"],
      fallbackLabel: "Did an employee refer you to apply?",
      value: "No",
    },
    {
      name: "knows current employee",
      patterns: ["know anyone currently at", "know someone currently at", "know anyone working at", "know someone working at"],
      fallbackLabel: "Do you know anyone currently at this company?",
      value: "No",
    },
    {
      name: "authorized to work",
      patterns: [
        "your authorization to work",
        "work authorization",
        "legally authorized to work in the country where this job is located",
        "authorized to work",
        "right to work",
      ],
      fallbackLabel: "Are you legally authorized to work in the country where this job is located?",
      values: ["I am authorized to work in the country due to my nationality", "Yes"],
    },
    {
      name: "employment sponsorship",
      patterns: ["require employment sponsorship"],
      fallbackLabel: "Do you now, or will you ever, require employment sponsorship to work in the country where this job is located?",
    },
    {
      name: "currently reside in united states",
      patterns: ["currently reside in the united states", "reside in the united states", "currently live in the united states"],
      fallbackLabel: "I currently reside in the United States.",
      value: "Yes",
    },
    {
      name: "excluded states residency",
      patterns: ["one of the following states", "do you live in one of", "alabama alaska delaware"],
      fallbackLabel: "Do you live in one of the following states?",
      value: "No",
    },
    {
      name: "privacy acknowledgement",
      patterns: ["job applicant privacy notice", "privacy notice", "applicant privacy statement"],
      fallbackLabel:
        'By selecting "I agree", I understand that the information I have provided as part of this job application will be processed in accordance with Toast\'s Applicant Privacy Statement.',
      values: ["Acknowledge/Confirm", "I agree", "Yes"],
    },
    {
      name: "information accuracy confirmation",
      patterns: ["double-check all the information", "reviewed and confirmed", "accuracy is crucial"],
      fallbackLabel: "Please double-check all the information provided above.",
      value: "I have reviewed and confirmed that all the information provided is accurate and complete.",
    },
    {
      name: "built ai agents",
      patterns: ["built ai agents", "built any ai agents", "have you built ai agents", "agentic automation"],
      fallbackLabel: "Have you built AI agents?",
      value: "Yes",
    },
    {
      name: "data transfer consent",
      patterns: [
        "data transfer",
        "privacy notice candidates",
        "candidate privacy notice",
        "personal information retained",
        "information retained",
      ],
      fallbackLabel: "Data Transfer",
      values: ["I consent", "I agree", "Yes"],
    },
    {
      name: "gender",
      patterns: ["gender identity"],
      fallbackLabel: "Gender Identity",
      values: ["I don't wish to answer", "Decline To Self Identify", "Prefer not to disclose"],
    },
    {
      name: "race/ethnicity",
      patterns: ["racial/ethnic background", "racial ethnic background", "race", "ethnic"],
      fallbackLabel: "Racial/Ethnic Background",
      values: ["I don't wish to answer", "Decline To Self Identify", "Prefer not to disclose"],
    },
    {
      name: "sexual orientation",
      patterns: ["sexual orientation"],
      fallbackLabel: "Sexual Orientation",
      values: ["I don't wish to answer", "Decline To Self Identify", "Prefer not to disclose"],
    },
    {
      name: "transgender",
      patterns: ["identify as transgender", "transgender"],
      fallbackLabel: "Do you identify as transgender?",
      values: ["I don't wish to answer", "Decline To Self Identify", "Prefer not to disclose"],
    },
    {
      name: "disability status",
      patterns: ["disability status"],
      fallbackLabel: "Disability Status",
      values: ["I don't wish to answer", "Decline To Self Identify", "Prefer not to disclose"],
    },
    {
      name: "veteran status",
      patterns: ["veteran status"],
      fallbackLabel: "Veteran Status",
      values: ["No, I am not a veteran or active member", "I am not a protected Veteran", "No"],
    },
  ];

  for (const attempt of attempts) {
    const located = await findHostedFieldByLabelPatterns(page, attempt.patterns);
    if (!located) {
      continue;
    }

    const { field, label, type, tag } = located;
    const fieldKey =
      tidy(await field.getAttribute("id").catch(() => "")) ||
      tidy(await field.getAttribute("name").catch(() => "")) ||
      `${label}::${type}`;
    if (usedFieldKeys.has(fieldKey)) {
      continue;
    }
    const displayLabel = label || attempt.fallbackLabel;
    const required =
      (await field.getAttribute("required").catch(() => null)) !== null ||
      (await field.getAttribute("aria-required").catch(() => "")) === "true";
    if (attempt.name === "phone" && !required) {
      skipped.push("optional phone");
      continue;
    }
    const choices =
      tag === "select"
        ? await field.locator("option").evaluateAll((options) =>
            options
              .map((option) => (option.textContent || "").replace(/\s+/g, " ").trim())
              .filter(Boolean),
          )
        : [];

    let desiredValues = dedupeText([...(attempt.values ?? []), attempt.value ?? ""].map((value) => value.trim()).filter(Boolean));
    if (desiredValues.length === 0) {
      const explicitAnswer = lookupApplicationAnswer(explicitAnswers, displayLabel, type);
      const savedAnswer = lookupQuestionBankAnswer(bank, displayLabel, type, choices);
      const desiredValue =
        suggestFormAnswer({ label: displayLabel, type, required, choices }, profile, explicitAnswer, "application-answers")?.value ||
        suggestFormAnswer({ label: displayLabel, type, required, choices }, profile, savedAnswer)?.value ||
        "";
      desiredValues = desiredValue ? [desiredValue] : [];
    }

    if (desiredValues.length === 0) {
      skipped.push(attempt.name);
      continue;
    }

    const currentValue = await readFieldCurrentValue(field, tag, type).catch(() => "");
    if (isMeaningfulValue(currentValue)) {
      filled.push(attempt.name);
      continue;
    }

    let applied = false;
    for (const desiredValue of desiredValues) {
      applied = await setEditableFieldValue(page, field, tag, desiredValue);
      if (applied) {
        break;
      }
    }
    if (applied) {
      filled.push(attempt.name);
      usedFieldKeys.add(fieldKey);
    } else {
      skipped.push(attempt.name);
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function findPageFieldByLabelContains(page: Page, text: string): Promise<Locator | null> {
  const candidate = await page
    .locator("input, textarea, select")
    .evaluateAll((nodes, needle) => {
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const normalize = (value: string) => read(value).toLowerCase();
      const target = normalize(String(needle));

      for (const node of nodes) {
        const element = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }

        const id = element.getAttribute("id") || "";
        let label = "";
        if (id) {
          label = read(document.querySelector(`label[for="${id}"]`)?.textContent);
        }
        if (!label) {
          label = read(element.closest("label")?.textContent);
        }
        if (!label) {
          label = read(element.getAttribute("aria-label")) || read(element.getAttribute("placeholder"));
        }

        if (label && normalize(label).includes(target)) {
          return {
            id,
            name: element.getAttribute("name") || "",
          };
        }
      }

      return null;
    }, text)
    .catch(() => null);

  if (!candidate) {
    return null;
  }

  if (candidate.id) {
    return page.locator(`[id="${escapeAttributeValue(candidate.id)}"]`).first();
  }
  if (candidate.name) {
    return page.locator(`[name="${escapeAttributeValue(candidate.name)}"]`).first();
  }

  return null;
}

async function waitForToastCareersFields(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const phone = await findPageFieldByLabelContains(page, "Phone");
    const postalCode = await findPageFieldByLabelContains(page, "postal code");
    if (phone && postalCode) {
      return;
    }
    await page.waitForTimeout(500);
  }
}

async function runToastCareersDirectAutofill(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const explicitAnswers = await loadApplicationAnswers();
  const first = profile.name.split(/\s+/)[0] || "";
  const last = profile.name.split(/\s+/).slice(1).join(" ") || "";
  const location = [profile.city, profile.state].filter(Boolean).join(", ") || profile.location;
  const website =
    lookupApplicationAnswer(explicitAnswers, "Website", "text") ||
    lookupApplicationAnswer(explicitAnswers, "Portfolio", "text") ||
    "";

  const actions: Array<{
    name: string;
    label: string;
    kind: "text" | "select";
    value: string;
  }> = [
    { name: "first name", label: "Legal First Name", kind: "text", value: first },
    { name: "last name", label: "Legal Last Name", kind: "text", value: last },
    { name: "email", label: "Email", kind: "text", value: profile.email },
    { name: "phone", label: "Phone", kind: "text", value: profile.phone },
    { name: "preferred first name", label: "Preferred First Name", kind: "text", value: first },
    { name: "location", label: "Location", kind: "text", value: location },
    { name: "postal code", label: "postal code", kind: "text", value: profile.postalCode },
    { name: "linkedin", label: "LinkedIn Profile", kind: "text", value: profile.linkedinUrl },
    { name: "website", label: "Website", kind: "text", value: website },
    { name: "authorized to work", label: "legally authorized to work", kind: "select", value: "Yes" },
    { name: "employment sponsorship", label: "require employment sponsorship", kind: "select", value: "No" },
    { name: "privacy acknowledgement", label: "Applicant Privacy Statement", kind: "select", value: "I agree" },
    { name: "gender", label: "Gender Identity", kind: "select", value: "Man" },
    {
      name: "disability status",
      label: "Disability Status",
      kind: "select",
      value: "No, I don't have a disability",
    },
    {
      name: "veteran status",
      label: "Veteran Status",
      kind: "select",
      value: "I am not a protected Veteran",
    },
  ];

  const filled: string[] = [];
  const skipped: string[] = [];

  for (const action of actions) {
    if (!action.value.trim()) {
      skipped.push(action.name);
      continue;
    }

    const field = await findPageFieldByLabelContains(page, action.label);
    if (!field || !(await field.isVisible().catch(() => false))) {
      skipped.push(action.name);
      continue;
    }

    let applied = false;
    if (action.kind === "select") {
      applied = (await field.selectOption({ label: action.value }).catch(() => [] as string[])).length > 0;
    } else {
      applied = await field.fill(action.value).then(() => true).catch(() => false);
      if (applied) {
        await page.waitForTimeout(100);
      }
    }

    if (applied) {
      filled.push(action.name);
    } else {
      skipped.push(action.name);
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function runToastResumeUpload(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  if (!profile.resumeFilePath.trim()) {
    return { filled: [], skipped: ["resume upload"] };
  }

  const field = page.locator('input[type="file"]').first();
  if (!(await field.isVisible().catch(() => false))) {
    return { filled: [], skipped: ["resume upload"] };
  }

  const uploaded = await field.setInputFiles(profile.resumeFilePath).then(() => true).catch(() => false);
  if (!uploaded) {
    return { filled: [], skipped: ["resume upload"] };
  }

  await page.waitForTimeout(4000);
  return { filled: ["resume upload"], skipped: [] };
}

async function selectNativeOption(field: Locator, values: string[]): Promise<boolean> {
  const desiredValues = dedupeText(values);
  if (desiredValues.length === 0) {
    return false;
  }

  const current = await readFieldCurrentValue(field, "select").catch(() => "");
  if (desiredValues.some((value) => matchesDesiredChoice(current, value))) {
    return true;
  }

  for (const value of desiredValues) {
    const byLabel = (await field.selectOption({ label: value }).catch(() => [] as string[])).length > 0;
    if (byLabel) {
      return true;
    }

    const byValue = (await field.selectOption({ value }).catch(() => [] as string[])).length > 0;
    if (byValue) {
      return true;
    }
  }

  const options = await field
    .locator("option")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const option = node as HTMLOptionElement;
        return {
          value: option.value,
          text: (option.textContent || "").replace(/\s+/g, " ").trim(),
        };
      }),
    )
    .catch(() => [] as Array<{ value: string; text: string }>);

  for (const desiredValue of desiredValues) {
    const match = options.find(
      (option) => matchesDesiredChoice(option.text, desiredValue) || matchesDesiredChoice(option.value, desiredValue),
    );
    if (!match) {
      continue;
    }

    const selected = (await field.selectOption({ value: match.value }).catch(() => [] as string[])).length > 0;
    if (selected) {
      return true;
    }
  }

  const scriptedSelection = await field
    .evaluate((node, desired) => {
      const select = node as HTMLSelectElement;
      if (select.tagName.toLowerCase() !== "select") {
        return false;
      }
      const normalize = (value: string) =>
        value
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const desiredValues = desired.map(normalize).filter(Boolean);
      const option = Array.from(select.options).find((candidate) => {
        const text = normalize(candidate.textContent || "");
        const value = normalize(candidate.value || "");
        return desiredValues.some((target) => text === target || value === target || text.includes(target));
      });
      if (!option) {
        return false;
      }
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, desiredValues)
    .catch(() => false);
  if (scriptedSelection) {
    await field.page().waitForTimeout(250).catch(() => undefined);
    const updated = await readFieldCurrentValue(field, "select").catch(() => "");
    if (desiredValues.some((value) => matchesDesiredChoice(updated, value))) {
      return true;
    }
  }

  return desiredValues.some((value) => matchesDesiredChoice(current, value));
}

async function replaceEditableFieldValueByTyping(page: Page, field: Locator, value: string): Promise<boolean> {
  const nextValue = tidy(value);
  if (!nextValue) {
    return false;
  }

  const disabled = await field.isDisabled().catch(() => false);
  if (disabled) {
    return false;
  }

  await field.scrollIntoViewIfNeeded().catch(() => undefined);
  const clicked =
    (await field.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
    (await field.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
  if (!clicked) {
    return false;
  }

  await field.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
  await field.press("Backspace").catch(() => undefined);
  await field.type(nextValue, { delay: 15 }).catch(() => undefined);
  await field.press("Tab").catch(() => undefined);
  await page.waitForTimeout(150).catch(() => undefined);

  const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "input");
  return isMeaningfulValue(await readFieldCurrentValue(field, tag).catch(() => ""));
}

async function fillTalemetryTextByPatterns(
  page: Page,
  patterns: string[],
  value: string,
  resultLabel: string,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const located = await findVisibleFieldByQuestionPatterns(page, patterns);
  if (!located || !["input", "textarea"].includes(located.question.tag)) {
    return { filled: [], skipped: [resultLabel] };
  }

  const applied = await replaceEditableFieldValueByTyping(page, located.field, value);
  return applied ? { filled: [resultLabel], skipped: [] } : { filled: [], skipped: [resultLabel] };
}

async function clickTalemetryLabeledControl(page: Page, labelText: string): Promise<boolean> {
  const normalizedTarget = normalizeQuestionText(labelText);
  const labels = page.locator("label");
  const count = await labels.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    if (!(await label.isVisible().catch(() => false))) {
      continue;
    }

    const text = tidy(await label.textContent().catch(() => ""));
    if (normalizeQuestionText(text) !== normalizedTarget) {
      continue;
    }

    const inputId = tidy(await label.getAttribute("for").catch(() => ""));
    if (inputId) {
      const input = page.locator(`[id="${escapeAttributeValue(inputId)}"]`).first();
      const type = tidy(await input.getAttribute("type").catch(() => "")).toLowerCase();
      if (type === "checkbox" || type === "radio") {
        const checked = await input.check({ timeout: 5_000 }).then(() => true).catch(() => false);
        if (checked) {
          return true;
        }
      }

      const clicked =
        (await input.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
        (await input.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
      if (clicked) {
        return true;
      }
    }

    const labelClicked =
      (await label.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
      (await label.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
    if (labelClicked) {
      return true;
    }
  }

  const byAccessibleName = page.getByLabel(new RegExp(`^${escapeRegExp(labelText)}$`, "i")).first();
  if (await byAccessibleName.isVisible().catch(() => false)) {
    return (
      (await byAccessibleName.check({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
      (await byAccessibleName.click({ timeout: 5_000 }).then(() => true).catch(() => false))
    );
  }

  return false;
}

async function selectTalemetryVisibleSelectByIndex(page: Page, index: number, answer: string): Promise<boolean> {
  const field = page.locator("select:visible").nth(index);
  if (!(await field.isVisible().catch(() => false))) {
    return false;
  }

  return selectNativeOption(field, [answer]);
}

async function runTalemetryResumeUpload(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped"> & { advanced: boolean }> {
  const uploadButton = page.getByRole("button", { name: /upload a resume\/cv/i }).first();
  if (!(await uploadButton.isVisible().catch(() => false))) {
    return { filled: [], skipped: [], advanced: false };
  }

  const resumeFilePath = await resolveResumeFilePath(profile);
  if (!resumeFilePath) {
    return { filled: [], skipped: ["resume upload"], advanced: false };
  }

  const previousTitle = await page.title().catch(() => "");
  const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 8_000 }).catch(() => null);
  const clicked =
    (await uploadButton.click({ timeout: 8_000 }).then(() => true).catch(() => false)) ||
    (await uploadButton.click({ timeout: 8_000, force: true }).then(() => true).catch(() => false));
  if (!clicked) {
    return { filled: [], skipped: ["resume upload"], advanced: false };
  }

  const chooser = await fileChooserPromise;
  if (chooser) {
    await chooser.setFiles(resumeFilePath);
  } else {
    const fileInput = page.locator('input[type="file"]').first();
    if (!(await fileInput.count().catch(() => 0))) {
      return { filled: [], skipped: ["resume upload"], advanced: false };
    }
    await fileInput.setInputFiles(resumeFilePath);
  }

  await page.waitForTimeout(6_000).catch(() => undefined);
  const nextTitle = await page.title().catch(() => "");
  const uploadStillVisible = await uploadButton.isVisible().catch(() => false);
  return { filled: ["resume upload"], skipped: [], advanced: Boolean(nextTitle && nextTitle !== previousTitle) || !uploadStillVisible };
}

function buildInitialsAndZip(profile: Profile): string {
  const initials = profile.name
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return `${initials}${profile.postalCode.trim()}`;
}

async function runTalemetryDirectAutofill(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped"> & { advanced: boolean }> {
  if ((await detectApplicationSiteKind(page)) !== "talemetry") {
    return { filled: [], skipped: [], advanced: false };
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  let advanced = false;
  const title = await page.title().catch(() => "");
  const bodyText = tidy(await page.locator("body").innerText().catch(() => ""));
  const normalizedBody = normalizeQuestionText(bodyText);
  const firstName = profile.name.trim().split(/\s+/)[0] || "";
  const lastName = profile.name.trim().split(/\s+/).slice(1).join(" ");
  const phoneDigits = profile.phone.replace(/\D/g, "") || profile.phone;

  const merge = (result: Pick<AutofillPassResult, "filled" | "skipped">) => {
    filled.push(...result.filled);
    skipped.push(...result.skipped);
  };

  if (/welcome/i.test(title) || /\bpreviously worked\b/.test(normalizedBody)) {
    merge(await fillTalemetryTextByPatterns(page, ["first name"], firstName, "first name"));
    merge(await fillTalemetryTextByPatterns(page, ["last name"], lastName, "last name"));
    merge(await fillTalemetryTextByPatterns(page, ["email"], profile.email, "email"));
    merge(await fillTalemetryTextByPatterns(page, ["mobile phone", "phone"], phoneDigits, "mobile phone"));

    if (await clickTalemetryLabeledControl(page, "None of the above")) {
      filled.push("previous employment: None of the above");
    }

    if (/\breceive text messages\b|\bemployment opportunities\b/.test(normalizedBody)) {
      const noRadio = page.locator('input[type="radio"][id$="-No"]:visible').last();
      const selected = await noRadio.check({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (selected || (await clickTalemetryLabeledControl(page, "No"))) {
        filled.push("text messages: No");
      } else {
        skipped.push("text messages");
      }
    }
  }

  if (/resume/i.test(title) && /upload a resume\/cv/i.test(bodyText)) {
    const result = await runTalemetryResumeUpload(page, profile);
    merge(result);
    advanced = result.advanced;
  }

  if (/\bcontact details\b/.test(normalizedBody)) {
    merge(await fillTalemetryTextByPatterns(page, ["first name"], firstName, "first name"));
    merge(await fillTalemetryTextByPatterns(page, ["last name"], lastName, "last name"));
    merge(await fillTalemetryTextByPatterns(page, ["street address"], profile.streetAddress, "street address"));
    merge(await fillTalemetryTextByPatterns(page, ["city"], profile.city, "city"));

    const country = await findVisibleFieldByQuestionPatterns(page, ["country"]);
    if (country?.question.tag === "select" && (await selectNativeOption(country.field, ["United States"]))) {
      filled.push("country");
      await page.waitForTimeout(1_200).catch(() => undefined);
    } else {
      skipped.push("country");
    }

    const state = await findVisibleFieldByQuestionPatterns(page, ["state", "region"]);
    if (state?.question.tag === "select" && (await selectNativeOption(state.field, [expandUsStateName(profile.state), profile.state]))) {
      filled.push("state");
    } else {
      skipped.push("state");
    }

    merge(await fillTalemetryTextByPatterns(page, ["postal", "zip"], profile.postalCode, "postal code"));
    merge(await fillTalemetryTextByPatterns(page, ["email"], profile.email, "email"));
    merge(await fillTalemetryTextByPatterns(page, ["mobile phone"], phoneDigits, "mobile phone"));
  }

  if (/highest education level/i.test(title) || /\bhighest level education achieved\b/.test(normalizedBody)) {
    if (await clickTalemetryLabeledControl(page, "Bachelor's Degree")) {
      filled.push("highest education level");
    } else {
      skipped.push("highest education level");
    }
  }

  if (/mutual arbitration/i.test(title) || /\bmutual arbitration agreement\b/.test(normalizedBody)) {
    if (await clickTalemetryLabeledControl(page, "I agree")) {
      filled.push("mutual arbitration agreement");
    } else {
      skipped.push("mutual arbitration agreement");
    }
  }

  if (/demographic information/i.test(title)) {
    const answers = ["Decline to Self Identify", "Decline To Self Identify", "Not a Veteran"];
    const labels = ["race", "gender", "veteran status"];
    for (let index = 0; index < answers.length; index += 1) {
      if (await selectTalemetryVisibleSelectByIndex(page, index, answers[index])) {
        filled.push(labels[index]);
      } else {
        skipped.push(labels[index]);
      }
    }
  }

  if (/job-related questions/i.test(title)) {
    const answers = ["No", "No", "Yes", "No", "No"];
    const labels = [
      "felony breach of trust or dishonesty",
      "restrictive employment agreement",
      "authorized to work",
      "visa sponsorship",
      "F-1 visa status",
    ];
    for (let index = 0; index < answers.length; index += 1) {
      if (await selectTalemetryVisibleSelectByIndex(page, index, answers[index])) {
        filled.push(labels[index]);
      } else {
        skipped.push(labels[index]);
      }
    }
  }

  if (/electronic signature/i.test(title) || /\besignature\b/.test(normalizedBody)) {
    const textInputs = page.locator('input[type="text"]:visible');
    const inputCount = await textInputs.count().catch(() => 0);
    if (inputCount >= 1 && (await replaceEditableFieldValueByTyping(page, textInputs.nth(0), profile.name))) {
      filled.push("electronic signature full name");
    } else {
      skipped.push("electronic signature full name");
    }

    if (inputCount >= 2 && (await replaceEditableFieldValueByTyping(page, textInputs.nth(1), buildInitialsAndZip(profile)))) {
      filled.push("electronic signature initials and ZIP");
    } else {
      skipped.push("electronic signature initials and ZIP");
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    advanced,
  };
}

async function findPhenomFieldBySelectors(
  page: Page,
  selectors: string[],
  requireVisible = true,
): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) {
      continue;
    }
    if (requireVisible && !(await locator.isVisible().catch(() => false))) {
      continue;
    }
    return locator;
  }

  return null;
}

async function findPhenomField(
  page: Page,
  selectors: string[],
  patterns: string[] = [],
): Promise<Locator | null> {
  const direct = await findPhenomFieldBySelectors(page, selectors);
  if (direct) {
    return direct;
  }

  const located = patterns.length > 0 ? await findVisibleFieldByQuestionPatterns(page, patterns) : null;
  return located?.field ?? null;
}

async function readPhenomFieldContext(field: Locator): Promise<string> {
  return field
    .evaluate((node) => {
      const element = node as HTMLElement;
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const id = element.getAttribute("id") || "";
      const containers = [
        element.closest(".form-group"),
        element.closest(".form-field"),
        element.closest(".question"),
        element.closest('[class*="question"]'),
        element.closest('[class*="Question"]'),
        element.closest('[class*="field"]'),
        element.closest('[class*="Field"]'),
        element.closest("fieldset"),
        element.parentElement?.parentElement,
        element.parentElement,
      ].filter((candidate): candidate is HTMLElement => Boolean(candidate));

      const label = id ? read(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) : "";
      return [label, ...containers.map((container) => read(container.textContent))]
        .filter(Boolean)
        .join(" ");
    })
    .catch(() => "");
}

async function fillPhenomTextField(
  page: Page,
  selectors: string[],
  patterns: string[],
  value: string,
  label: string,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const field = await findPhenomField(page, selectors, patterns);
  if (!field || !value.trim()) {
    return { filled: [], skipped: [label] };
  }

  const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "input");
  const currentValue = await readFieldCurrentValue(field, tag).catch(() => "");
  if (isMeaningfulValue(currentValue) && matchesDesiredChoice(currentValue, value)) {
    return { filled: [label], skipped: [] };
  }

  const applied =
    ["input", "textarea"].includes(tag) && (await replaceEditableFieldValueByTyping(page, field, value))
      ? true
      : await setEditableFieldValue(page, field, tag, value);
  return applied ? { filled: [label], skipped: [] } : { filled: [], skipped: [label] };
}

async function selectPhenomField(
  page: Page,
  selectors: string[],
  patterns: string[],
  values: string[],
  label: string,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const field = await findPhenomField(page, selectors, patterns);
  if (!field || values.length === 0) {
    return { filled: [], skipped: [label] };
  }

  const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "select");
  const currentValue = await readFieldCurrentValue(field, tag).catch(() => "");
  if (values.some((value) => matchesDesiredChoice(currentValue, value))) {
    return { filled: [label], skipped: [] };
  }

  const applied =
    tag === "select"
      ? await selectNativeOption(field, values)
      : await setEditableFieldValue(page, field, tag === "button" ? "combobox" : tag, values[0] || "");
  return applied ? { filled: [label], skipped: [] } : { filled: [], skipped: [label] };
}

async function findPhenomCheckboxByContext(page: Page, patterns: RegExp[]): Promise<Locator | null> {
  const checkboxes = page.locator('input[type="checkbox"], [role="checkbox"]');
  const count = await checkboxes.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const checkbox = checkboxes.nth(index);
    const context = `${await extractLocatorLabel(checkbox).catch(() => "")} ${await readPhenomFieldContext(checkbox)}`;
    if (patterns.some((pattern) => pattern.test(context))) {
      return checkbox;
    }
  }

  return null;
}

async function setPhenomCheckboxState(page: Page, field: Locator, checked: boolean): Promise<boolean> {
  await field.scrollIntoViewIfNeeded().catch(() => undefined);
  await field
    .evaluate((node, desired) => {
      const input = node as HTMLInputElement;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
      descriptor?.set?.call(input, desired as boolean);
      input.checked = desired as boolean;
      input.value = desired ? "Yes" : "";
      input.setAttribute("ischecked", desired ? "true" : "false");
      if (desired) {
        input.setAttribute("checked", "");
      } else {
        input.removeAttribute("checked");
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.checked;
    }, checked)
    .catch(() => undefined);
  await page.waitForTimeout(150).catch(() => undefined);

  if ((await isCheckboxChecked(field).catch(() => false)) === checked) {
    return true;
  }

  const toggled =
    checked
      ? await field.check({ timeout: 5_000, force: true }).then(() => true).catch(() => false)
      : await field.uncheck({ timeout: 5_000, force: true }).then(() => true).catch(() => false);
  await page.waitForTimeout(150).catch(() => undefined);
  return toggled && (await isCheckboxChecked(field).catch(() => false)) === checked;
}

async function setPhenomCheckbox(
  page: Page,
  selectors: string[],
  patterns: RegExp[],
  checked: boolean,
  label: string,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const field =
    (await findPhenomFieldBySelectors(page, selectors, false)) ||
    (patterns.length > 0 ? await findPhenomCheckboxByContext(page, patterns) : null);
  if (!field) {
    return { filled: [], skipped: [label] };
  }

  const applied = await setPhenomCheckboxState(page, field, checked);
  return applied ? { filled: [label], skipped: [] } : { filled: [], skipped: [label] };
}

async function choosePhenomRadio(
  page: Page,
  selectors: string[],
  groupPatterns: RegExp[],
  values: string[],
  label: string,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const direct = await findPhenomFieldBySelectors(page, selectors, false);
  if (direct) {
    const alreadySelected = await direct
      .evaluate((node) => (node as HTMLInputElement).checked)
      .catch(() => false);
    if (alreadySelected) {
      return { filled: [label], skipped: [] };
    }

    const selected =
      (await direct.check({ timeout: 5_000, force: true }).then(() => true).catch(() => false)) ||
      (await direct.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
    if (selected) {
      return { filled: [label], skipped: [] };
    }
  }

  const groups = page.locator('fieldset, [role="radiogroup"], [class*="radio"], [class*="question"]');
  const count = await groups.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const group = groups.nth(index);
    if (!(await group.isVisible().catch(() => false))) {
      continue;
    }
    const text = await group.textContent().catch(() => "");
    if (!groupPatterns.some((pattern) => pattern.test(text || ""))) {
      continue;
    }

    for (const value of values) {
      if (await clickRadioChoice(group, value)) {
        return { filled: [label], skipped: [] };
      }
    }
  }

  return { filled: [], skipped: [label] };
}

function formatPhenomDate(date = new Date()): string {
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`;
}

function parsePhenomDate(value: string): { month: number; day: number; year: number } | null {
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) {
    return null;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) {
    return null;
  }
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return { month, day, year };
}

function formatOrdinalDay(day: number): string {
  if (day >= 11 && day <= 13) {
    return `${day}th`;
  }
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

function formatReactDatePickerAriaLabel(value: string): string | null {
  const parsed = parsePhenomDate(value);
  if (!parsed) {
    return null;
  }
  const date = new Date(parsed.year, parsed.month - 1, parsed.day);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(date);
  const month = new Intl.DateTimeFormat("en-US", { month: "long" }).format(date);
  return `Choose ${weekday}, ${month} ${formatOrdinalDay(parsed.day)}, ${parsed.year}`;
}

function getPhenomAvailabilityDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 14);
  return formatPhenomDate(date);
}

function getPhenomSalaryExpectation(): string {
  return (process.env.JAA_SALARY_EXPECTATION || "$160K - $175K").trim();
}

function getPhenomReasonForLeaving(): string {
  return (
    process.env.JAA_REASON_FOR_LEAVING ||
    "I am seeking a role aligned with long-term cloud platform engineering work, stable production systems, and continued growth across infrastructure, automation, and reliability."
  ).trim();
}

function normalizeUsPhoneDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function extractUsPhoneDigits(value: string): string[] {
  const matches = value.matchAll(/(?:\+?1[\s.-]*)?\(?([2-9]\d{2})\)?[\s.-]*([2-9]\d{2})[\s.-]*(\d{4})\b/g);
  return Array.from(matches)
    .map((match) => `${match[1]}${match[2]}${match[3]}`)
    .filter((digits) => digits.length === 10);
}

async function getPhenomPhoneCandidates(profile: Profile): Promise<string[]> {
  const values = [profile.phone, process.env.JAA_PHONE_FALLBACK || ""];
  if (profile.resumeTextPath.trim()) {
    const resumeText = await readFile(profile.resumeTextPath, "utf8").catch(() => "");
    values.push(...extractUsPhoneDigits(resumeText));
  }

  const candidates = dedupeText(values.map(normalizeUsPhoneDigits).filter((value) => value.length === 10));
  const primary = normalizeUsPhoneDigits(profile.phone);
  return candidates.length > 0 ? candidates : primary ? [primary] : [];
}

async function isPhenomPhoneNumberAccepted(field: Locator): Promise<boolean> {
  const state = await field
    .evaluate((node) => {
      const input = node as HTMLInputElement;
      return {
        value: input.value || input.getAttribute("value") || "",
        ariaInvalid: input.getAttribute("aria-invalid") || "",
        validationMessage: input.validationMessage || "",
        valid: input.validity?.valid ?? true,
      };
    })
    .catch(() => ({ value: "", ariaInvalid: "", validationMessage: "", valid: true }));
  const digits = normalizeUsPhoneDigits(state.value);
  return (
    digits.length === 10 &&
    state.ariaInvalid !== "true" &&
    state.valid !== false &&
    !/\binvalid\b|enter a valid|required/i.test(state.validationMessage)
  );
}

async function fillPhenomPhoneNumberField(
  page: Page,
  profile: Profile,
  selectors: string[],
  patterns: string[],
  label: string,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const field = await findPhenomField(page, selectors, patterns);
  if (!field) {
    return { filled: [], skipped: [label] };
  }
  if (await isPhenomPhoneNumberAccepted(field)) {
    return { filled: [label], skipped: [] };
  }

  for (const candidate of await getPhenomPhoneCandidates(profile)) {
    const typed = await replaceEditableFieldValueByTyping(page, field, candidate).catch(() => false);
    if (!typed) {
      await setEditableFieldValue(page, field, "input", candidate).catch(() => false);
    }
    await field.evaluate((node) => (node as HTMLInputElement).blur()).catch(() => undefined);
    await page.waitForTimeout(600).catch(() => undefined);
    if (await isPhenomPhoneNumberAccepted(field)) {
      return { filled: [label], skipped: [] };
    }
  }

  return { filled: [], skipped: [label] };
}

async function fillPhenomExactTextField(page: Page, selector: string, value: string): Promise<boolean> {
  const field = page.locator(selector).first();
  if ((await field.count().catch(() => 0)) === 0 || !(await field.isVisible().catch(() => false))) {
    return false;
  }

  const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "input");
  return ["input", "textarea"].includes(tag) && (await replaceEditableFieldValueByTyping(page, field, value))
    ? true
    : await setEditableFieldValue(page, field, tag, value).catch(() => false);
}

async function setPhenomDateField(page: Page, selector: string, value: string): Promise<boolean> {
  const field = page.locator(selector).first();
  if ((await field.count().catch(() => 0)) === 0 || !(await field.isVisible().catch(() => false))) {
    return false;
  }

  const typed = await replaceEditableFieldValueByTyping(page, field, value).catch(() => false);
  await page.keyboard.press("Escape").catch(() => undefined);
  const typedValue = await readFieldCurrentValue(field, "input").catch(() => "");
  if (typed && matchesDesiredChoice(typedValue, value)) {
    return true;
  }

  const selectedFromPicker = await selectPhenomReactDatePickerDate(page, field, value);
  const pickerValue = await readFieldCurrentValue(field, "input").catch(() => "");
  if (selectedFromPicker && matchesDesiredChoice(pickerValue, value)) {
    return true;
  }

  const scriptedValue = await field
    .evaluate((node, nextValue) => {
      const input = node as HTMLInputElement;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor?.set?.call(input, nextValue);
      input.value = nextValue;
      input.setAttribute("value", nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      return input.value;
    }, value)
    .catch(() => "");
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(250).catch(() => undefined);

  const currentValue = (await readFieldCurrentValue(field, "input").catch(() => "")) || scriptedValue;
  return matchesDesiredChoice(currentValue, value);
}

async function selectPhenomReactDatePickerDate(page: Page, field: Locator, value: string): Promise<boolean> {
  const parsed = parsePhenomDate(value);
  const ariaLabel = formatReactDatePickerAriaLabel(value);
  if (!parsed || !ariaLabel) {
    return false;
  }

  await field.scrollIntoViewIfNeeded().catch(() => undefined);
  const opened = await field.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  if (!opened) {
    return false;
  }
  await page.waitForTimeout(250).catch(() => undefined);

  const monthSelect = page.locator(".react-datepicker__month-select").first();
  if ((await monthSelect.count().catch(() => 0)) > 0) {
    await monthSelect.selectOption(String(parsed.month - 1)).catch(() => undefined);
  }
  const yearSelect = page.locator(".react-datepicker__year-select").first();
  if ((await yearSelect.count().catch(() => 0)) > 0) {
    await yearSelect.selectOption(String(parsed.year)).catch(() => undefined);
  }
  await page.waitForTimeout(250).catch(() => undefined);

  const day = page.getByLabel(ariaLabel, { exact: true }).first();
  if ((await day.count().catch(() => 0)) === 0 || !(await day.isVisible().catch(() => false))) {
    return false;
  }
  const clicked = await day.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(350).catch(() => undefined);
  return clicked;
}

async function selectPhenomExactField(page: Page, selector: string, values: string[]): Promise<boolean> {
  const field = page.locator(selector).first();
  if ((await field.count().catch(() => 0)) === 0 || !(await field.isVisible().catch(() => false))) {
    return false;
  }

  const selected = await selectNativeOption(field, values).catch(() => false);
  if (selected) {
    await page.waitForTimeout(500).catch(() => undefined);
  }
  return selected;
}

async function checkPhenomExactCheckbox(page: Page, selector: string, checked: boolean): Promise<boolean> {
  const field = page.locator(selector).first();
  if ((await field.count().catch(() => 0)) === 0 || !(await field.isVisible().catch(() => false))) {
    return false;
  }

  return setPhenomCheckboxState(page, field, checked);
}

async function choosePhenomExactRadio(page: Page, id: string): Promise<boolean> {
  const field = page.locator(`[id="${id.replace(/"/g, '\\"')}"]`).first();
  if ((await field.count().catch(() => 0)) === 0) {
    return false;
  }
  if (await field.evaluate((node) => (node as HTMLInputElement).checked).catch(() => false)) {
    return true;
  }

  const selected =
    (await field.check({ timeout: 5_000, force: true }).then(() => true).catch(() => false)) ||
    (await field.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
  if (selected) {
    await page.waitForTimeout(100).catch(() => undefined);
  }
  return selected;
}

async function chooseBnsfScreeningRadio(page: Page, index: number, answer: "Yes" | "No"): Promise<boolean> {
  const selectors = [
    `input[type="radio"][name="jsqData.jsqData.${index}_par"][value="${answer}"]`,
    `input[type="radio"][id="jsqData.jsqData.${index}_par.${answer}"]`,
    `input[type="radio"][id="jsqData.jsqData.${index}_par.${answer.toUpperCase()}"]`,
  ];

  for (const selector of selectors) {
    const field = page.locator(selector).first();
    if ((await field.count().catch(() => 0)) === 0) {
      continue;
    }
    if (await field.evaluate((node) => (node as HTMLInputElement).checked).catch(() => false)) {
      return true;
    }
    const selected =
      (await field.check({ timeout: 5_000, force: true }).then(() => true).catch(() => false)) ||
      (await field.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
    if (selected) {
      await page.waitForTimeout(100).catch(() => undefined);
      return true;
    }
  }

  return false;
}

async function readBnsfScreeningQuestionText(page: Page, index: number): Promise<string> {
  return page
    .locator(`input[type="radio"][name="jsqData.jsqData.${index}_par"]`)
    .first()
    .evaluate((node) => {
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
      let current: Element | null = node.parentElement;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const text = normalize(current.textContent || "");
        if (text.length > 20 && /\bYes\b/i.test(text) && /\bNo\b/i.test(text)) {
          return text.replace(/\bYes\b\s*\bNo\b/gi, "").trim();
        }
      }
      return "";
    })
    .catch(() => "");
}

function inferBnsfScreeningAnswer(questionText: string, index: number): "Yes" | "No" {
  const normalized = normalizeQuestionText(questionText);
  if (/sponsorship|h\s*1b|stem opt|cpt|tn nonimmigrant|employment authorization.*assistance/.test(normalized)) {
    return "No";
  }
  if (/authorized to work|currently authorized|work in the us|work in the united states/.test(normalized)) {
    return "Yes";
  }
  if (/bachelor.*(information systems|computer science|engineering|related field)/.test(normalized)) {
    return "Yes";
  }
  if (/cross module integration|third party platforms/.test(normalized)) {
    return "Yes";
  }
  if (/containerization|docker|kubernetes|agile|infrastructure as code|terraform|ansible|ci\/?cd/.test(normalized)) {
    return "Yes";
  }
  if (/regulated environment|compliance requirement/.test(normalized)) {
    return "Yes";
  }
  if (/rail|shipping|airline|logistics|warehousing|supply chain|transportation/.test(normalized)) {
    return "No";
  }
  if (
    /sap|sapui5|abap|s\/?4hana|hana|maxdb|btp|integration suite|po\/?pi|cpi|sap security|sap grc|fiori|ui5|bw|odata|ecc/.test(
      normalized,
    )
  ) {
    return "No";
  }
  if (/certification|certifications/.test(normalized)) {
    return "No";
  }
  if (/complete and accurate|truthful|certify|acknowledge|understand/.test(normalized)) {
    return "Yes";
  }

  return index <= 14 ? "Yes" : "No";
}

async function selectPhenomQuestionnaireSelect(
  page: Page,
  questionPatterns: RegExp[],
  values: string[],
  label: string,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const selects = page.locator('select[id^="jsqData.QUESTIONNAIRE"], select[name^="jsqData.QUESTIONNAIRE"]');
  const count = await selects.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const field = selects.nth(index);
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }
    const context = normalizeQuestionText(
      `${await extractLocatorLabel(field).catch(() => "")} ${await readPhenomFieldContext(field).catch(() => "")}`,
    );
    if (!questionPatterns.some((pattern) => pattern.test(context))) {
      continue;
    }

    const currentValue = await readFieldCurrentValue(field, "select").catch(() => "");
    if (values.some((value) => matchesDesiredChoice(currentValue, value))) {
      return { filled: [label], skipped: [] };
    }
    if (await selectNativeOption(field, values).catch(() => false)) {
      await page.waitForTimeout(250).catch(() => undefined);
      return { filled: [label], skipped: [] };
    }
  }

  return { filled: [], skipped: [label] };
}

async function setPhenomCheckboxByValue(
  page: Page,
  valuePatterns: RegExp[],
  checked: boolean,
  label: string,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const checkboxes = page.locator('input[type="checkbox"]');
  const count = await checkboxes.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const field = checkboxes.nth(index);
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }
    const value = tidy(await field.getAttribute("value").catch(() => ""));
    if (!valuePatterns.some((pattern) => pattern.test(value))) {
      continue;
    }

    const applied = await setPhenomCheckboxState(page, field, checked);
    return applied ? { filled: [label], skipped: [] } : { filled: [], skipped: [label] };
  }

  return { filled: [], skipped: [label] };
}

async function runSutterPhenomQuestionnaireAutofill(
  page: Page,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const hasSutterQuestionnaire =
    (await page.locator('select[id^="jsqData.QUESTIONNAIRE"], input[value^="REC_ANSR_Status_"], input[value^="REC_ANSR_Shift_"]').count().catch(() => 0)) >
    0;
  if (!hasSutterQuestionnaire) {
    return { filled: [], skipped: [] };
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  const merge = (result: Pick<AutofillPassResult, "filled" | "skipped">) => {
    filled.push(...result.filled);
    skipped.push(...result.skipped);
  };

  merge(await selectPhenomQuestionnaireSelect(page, [/\beighteen\b|\b18\b.*years? of age/], ["Yes"], "age 18"));
  merge(await selectPhenomQuestionnaireSelect(page, [/authorized.*work.*united states|work.*authorization/], ["Yes"], "work authorization"));
  merge(await selectPhenomQuestionnaireSelect(page, [/sponsorship|h\s*1b|visa/], ["No"], "sponsorship"));
  merge(await selectPhenomQuestionnaireSelect(page, [/debarred|excluded|ineligible.*federal|state funded/], ["No"], "debarment"));
  merge(
    await selectPhenomQuestionnaireSelect(
      page,
      [/highest.*level.*education|education.*completed/],
      ["Bachelor's Degree", "Bachelor Degree", "Bachelors Degree"],
      "highest education",
    ),
  );
  merge(await selectPhenomQuestionnaireSelect(page, [/relative.*employed|family.*department/], ["No"], "relative employed"));
  merge(await setPhenomCheckboxByValue(page, [/REC_ANSR_Status_Full_Time/i], true, "full-time status"));
  merge(await setPhenomCheckboxByValue(page, [/REC_ANSR_Status_Limited/i], true, "limited-term status"));
  merge(await setPhenomCheckboxByValue(page, [/REC_ANSR_Shift_Day/i], true, "days shift"));

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function selectBnsfStateAfterCountry(
  page: Page,
  countrySelector: string,
  stateSelector: string,
  stateValues: string[],
): Promise<boolean> {
  const selectedCountry = await selectPhenomExactField(page, countrySelector, ["United States"]);
  if (!selectedCountry) {
    return false;
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await selectPhenomExactField(page, stateSelector, stateValues)) {
      return true;
    }
    await page.waitForTimeout(900).catch(() => undefined);
  }
  return false;
}

async function runPhenomContactAutofill(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const merge = (result: Pick<AutofillPassResult, "filled" | "skipped">) => {
    filled.push(...result.filled);
    skipped.push(...result.skipped);
  };

  merge(await runFileAutofillWithinScope(page, page, profile));
  merge(
    await selectPhenomField(
      page,
      ['[id="applicantSource"]', '[name="applicantSource"]'],
      ["source"],
      ["Job Search Site", "Web - LinkedIn", "LinkedIn", "Social Media"],
      "source",
    ),
  );
  merge(
    await selectPhenomField(
      page,
      ['[id="country"]', '[name="country"]', '[id="cntryFields.country"]', '[name="cntryFields.country"]'],
      ["country"],
      ["USA", "United States", "United States of America"],
      "country",
    ),
  );
  await page.waitForTimeout(600).catch(() => undefined);

  const firstName = profile.name.trim().split(/\s+/)[0] || "";
  const lastName = profile.name.trim().split(/\s+/).slice(1).join(" ");
  merge(
    await fillPhenomTextField(
      page,
      ['[id="cntryFields.firstName"]', '[name="cntryFields.firstName"]', 'input[id*="firstName" i]'],
      ["first name", "given name"],
      firstName,
      "first name",
    ),
  );
  merge(
    await fillPhenomTextField(
      page,
      ['[id="cntryFields.lastName"]', '[name="cntryFields.lastName"]', 'input[id*="lastName" i]'],
      ["last name", "family name", "surname"],
      lastName,
      "last name",
    ),
  );
  merge(
    await selectPhenomField(
      page,
      ['[id*="preferredName" i]', '[name*="preferredName" i]'],
      ["preferred name"],
      ["No"],
      "preferred name",
    ),
  );
  merge(
    await fillPhenomTextField(
      page,
      [
        '[id="cntryFields.address"]',
        '[id="cntryFields.addressLine1"]',
        '[id="cntryFields.addressLine"]',
        '[name="cntryFields.address"]',
        '[name="cntryFields.addressLine1"]',
        '[id="address"]',
        '[name="address"]',
      ],
      ["address line 1", "street address"],
      profile.streetAddress,
      "street address",
    ),
  );
  merge(
    await fillPhenomTextField(
      page,
      ['[id="cntryFields.city"]', '[name="cntryFields.city"]', '[id="city"]', '[name="city"]'],
      ["city"],
      profile.city || profile.location,
      "city",
    ),
  );
  merge(
    await selectPhenomField(
      page,
      [
        '[id="cntryFields.region"]',
        '[name="cntryFields.region"]',
        '[id="cntryFields.state"]',
        '[name="cntryFields.state"]',
        '[id="region"]',
      ],
      ["state", "province"],
      [expandUsStateName(profile.state), profile.state],
      "state",
    ),
  );
  merge(
    await fillPhenomTextField(
      page,
      [
        '[id="cntryFields.postalCode"]',
        '[name="cntryFields.postalCode"]',
        '[id="postalCode"]',
        '[name="postalCode"]',
        'input[id*="postal" i]',
        'input[id*="zip" i]',
      ],
      ["postal", "zip"],
      profile.postalCode,
      "postal code",
    ),
  );
  merge(
    await fillPhenomTextField(
      page,
      ['[id="email"]', '[name="email"]', '[id="cntryFields.email"]', '[name="cntryFields.email"]', 'input[type="email"]'],
      ["email"],
      profile.email,
      "email",
    ),
  );
  merge(
    await selectPhenomField(
      page,
      ['[id*="deviceType" i]', '[name*="deviceType" i]', '[id*="phoneType" i]', '[name*="phoneType" i]'],
      ["device type", "phone type"],
      ["Mobile"],
      "phone device type",
    ),
  );
  merge(
    await selectPhenomField(
      page,
      ['[id*="phoneCountry" i]', '[name*="phoneCountry" i]', '[id*="countryPhoneCode" i]', '[name*="countryPhoneCode" i]'],
      ["phone country", "country phone code"],
      ["USA (+1)", "United States (+1)", "USA", "United States"],
      "phone country code",
    ),
  );
  merge(
    await fillPhenomPhoneNumberField(
      page,
      profile,
      ['[id*="phoneNumber" i]', '[name*="phoneNumber" i]', '[id="cellPhone"]', '[name="cellPhone"]', 'input[type="tel"]'],
      ["phone number", "mobile phone", "telephone"],
      "phone number",
    ),
  );
  if (await setPhenomDateField(page, 'input[name="app_availability"]', getPhenomAvailabilityDate())) {
    filled.push("available start date");
  } else {
    skipped.push("available start date");
  }
  if (await selectPhenomExactField(page, '[id="app_BNSFRelatives"]', ["No"])) {
    filled.push("BNSF relatives");
  } else {
    skipped.push("BNSF relatives");
  }
  if (await checkPhenomExactCheckbox(page, '[id="app_recievetext"]', true)) {
    filled.push("text-message opt-out");
  } else {
    skipped.push("text-message opt-out");
  }
  merge(
    await setPhenomCheckbox(
      page,
      ['[id="privacyPolicy"]', '[name="privacyPolicy"]'],
      [/privacy/i, /application acknowledgement/i],
      true,
      "privacy acknowledgement",
    ),
  );

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function runPhenomEducationAutofill(
  page: Page,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const merge = (result: Pick<AutofillPassResult, "filled" | "skipped">) => {
    filled.push(...result.filled);
    skipped.push(...result.skipped);
  };

  merge(
    await selectPhenomField(
      page,
      ['[id="educationData[0].degree"]', '[name="educationData[0].degree"]', 'select[id*="degree" i]'],
      ["degree", "education"],
      ["Bachelor's Degree", "Bachelor Degree", "Bachelors Degree"],
      "education degree",
    ),
  );
  merge(
    await fillPhenomTextField(
      page,
      ['[id="educationData[0].fieldOfStudy"]', '[name="educationData[0].fieldOfStudy"]', 'input[id*="fieldOfStudy" i]'],
      ["field of study", "major"],
      "Computer Information Systems",
      "field of study",
    ),
  );
  merge(
    await fillPhenomTextField(
      page,
      ['[id="educationData[0].gradeAverage"]', '[name="educationData[0].gradeAverage"]', 'input[id*="gradeAverage" i]'],
      ["gpa", "overall result"],
      "3.7",
      "education GPA",
    ),
  );
  merge(
    await fillPhenomTextField(
      page,
      ['[id="educationData[0].fromTo.startDate"]', '[name="educationData[0].fromTo.startDate"]'],
      ["education start"],
      "08/2016",
      "education start date",
    ),
  );
  merge(
    await fillPhenomTextField(
      page,
      ['[id="educationData[0].fromTo.endDate"]', '[name="educationData[0].fromTo.endDate"]'],
      ["education end"],
      "01/2021",
      "education end date",
    ),
  );

  if (await selectPhenomExactField(page, '[id="app_HighSchoolType"]', ["Yes - I have received my High School Diploma"])) {
    filled.push("high school diploma");
  } else {
    skipped.push("high school diploma");
  }
  if (
    await selectBnsfStateAfterCountry(page, '[id="app_HighSchoolCountry"]', '[id="app_HighSchoolState"]', [
      "North Carolina",
      "NC",
    ])
  ) {
    filled.push("high school location");
  } else {
    skipped.push("high school location");
  }
  if (await fillPhenomExactTextField(page, '[id="app_HighSchoolCity"]', "Raleigh")) {
    filled.push("high school city");
  } else {
    skipped.push("high school city");
  }
  if (await fillPhenomExactTextField(page, '[id="app_HighSchoolNameOther"]', "High School")) {
    filled.push("high school name");
  } else {
    skipped.push("high school name");
  }
  if (await selectPhenomExactField(page, '[id="degreeAchieved"]', ["Bachelors", "Bachelor's Degree"])) {
    filled.push("highest degree");
  } else {
    skipped.push("highest degree");
  }
  if (await selectPhenomExactField(page, '[id="app_HighestEdDiscipline1"]', ["Computer Science", "Computer Information Systems"])) {
    filled.push("highest education discipline");
  } else {
    skipped.push("highest education discipline");
  }
  if (
    await selectBnsfStateAfterCountry(page, '[id="app_HighestEdCountry"]', '[id="app_HighestEdState"]', [
      "North Carolina",
      "NC",
    ])
  ) {
    filled.push("highest education state");
  } else {
    skipped.push("highest education state");
  }
  if (await fillPhenomExactTextField(page, '[id="app_HighestEdCity"]', "Raleigh")) {
    filled.push("highest education city");
  } else {
    skipped.push("highest education city");
  }
  await page.waitForTimeout(1200).catch(() => undefined);
  if (await selectPhenomExactField(page, '[id="nameOfTheSchool"]', ["North Carolina State University", "Other"])) {
    filled.push("highest education school");
  } else {
    skipped.push("highest education school");
  }
  if (await fillPhenomExactTextField(page, '[id="app_HighestEdNameOther"]', "North Carolina State University")) {
    filled.push("highest education other school");
  } else {
    skipped.push("highest education other school");
  }
  if (await selectPhenomExactField(page, '[id="app_DegreeCompletedMTEFLS"]', ["Yes Completed", "Completed"])) {
    filled.push("degree completed");
  } else {
    skipped.push("degree completed");
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function runPhenomWorkExperienceAutofill(
  page: Page,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];

  const firstTitle = page.locator('[id="experienceData[0].title"]').first();
  if (await firstTitle.isVisible().catch(() => false)) {
    const currentTitle = tidy(await firstTitle.inputValue().catch(() => ""));
    if (/^cto$/i.test(currentTitle)) {
      const applied = await replaceEditableFieldValueByTyping(page, firstTitle, "Lead Software Engineer");
      (applied ? filled : skipped).push("current job title");
    }
  }

  const locations = page.locator('input[id^="experienceData"][id$=".location"], input[name="location"]');
  const locationCount = await locations.count().catch(() => 0);
  let locationFilled = 0;
  for (let index = 0; index < locationCount; index += 1) {
    const field = locations.nth(index);
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }
    const current = tidy(await field.inputValue().catch(() => ""));
    if (current) {
      continue;
    }
    const applied = await replaceEditableFieldValueByTyping(page, field, "Raleigh, NC");
    if (applied) {
      locationFilled += 1;
    }
  }
  if (locationFilled > 0) {
    filled.push(`work location (${locationFilled})`);
  } else {
    skipped.push("work location");
  }

  const bnsfExperienceDefaults = [
    {
      industry: ["Information Technology"],
      type: ["Employee"],
      reason: ["Currently Employed"],
      phone: "9197100993",
    },
    {
      industry: ["Consultant", "Information Technology"],
      type: ["Contractor", "Employee"],
      reason: ["Currently Employed"],
      phone: "9197100993",
    },
    {
      industry: ["Information Technology"],
      type: ["Employee"],
      reason: ["Resigned"],
      phone: "8004264968",
    },
    {
      industry: ["Information Technology"],
      type: ["Employee"],
      reason: ["Resigned"],
      phone: "9197543700",
    },
    {
      industry: ["Education"],
      type: ["Employee"],
      reason: ["End of Commitment", "Resigned"],
      phone: "9195152011",
    },
  ];
  let bnsfExperienceFilled = 0;
  for (const [index, defaults] of bnsfExperienceDefaults.entries()) {
    const prefix = `[id^="experienceData[${index}]"]`;
    const hasBlock = (await page.locator(prefix).count().catch(() => 0)) > 0;
    if (!hasBlock) {
      continue;
    }

    if (await selectPhenomExactField(page, `[id="experienceData[${index}].prevEmployerIndustry"]`, defaults.industry)) {
      bnsfExperienceFilled += 1;
    }
    if (await selectPhenomExactField(page, `[id="experienceData[${index}].app_PrevEmp1EmpType"]`, defaults.type)) {
      bnsfExperienceFilled += 1;
    }
    if (await selectPhenomExactField(page, `[id="experienceData[${index}].app_PrevEmp1RforLeaving"]`, defaults.reason)) {
      bnsfExperienceFilled += 1;
    }
    if (
      await selectBnsfStateAfterCountry(
        page,
        `[id="experienceData[${index}].parent_key"]`,
        `[id="experienceData[${index}].app_PrevEmp1State"]`,
        ["North Carolina", "NC"],
      )
    ) {
      bnsfExperienceFilled += 1;
    }
    if (await fillPhenomExactTextField(page, `[id="experienceData[${index}].app_PrevEmp1City"]`, "Raleigh")) {
      bnsfExperienceFilled += 1;
    }
    if (await fillPhenomExactTextField(page, `[id="experienceData[${index}].app_PrevEmp1Phone"]`, defaults.phone)) {
      bnsfExperienceFilled += 1;
    }
  }
  if (bnsfExperienceFilled > 0) {
    filled.push(`BNSF experience details (${bnsfExperienceFilled})`);
  } else {
    skipped.push("BNSF experience details");
  }
  if (await selectPhenomExactField(page, '[id="app_PrevEmp1Contact"]', ["You may contact them later in the process with my approval"])) {
    filled.push("current employer contact permission");
  } else {
    skipped.push("current employer contact permission");
  }
  for (const [selector, label] of [
    ['[id="isPreviouslyWorkedForBNSF"]', "previous railroad employment"],
    ['[id="app_BNSFinterview"]', "previous BNSF interview"],
    ['[id="app_fiveYearFired"]', "five-year termination history"],
    ['[id="app_fiveYearDiscipline"]', "five-year discipline history"],
  ] as const) {
    if (await selectPhenomExactField(page, selector, ["No"])) {
      filled.push(label);
    } else {
      skipped.push(label);
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function runPhenomApplicationQuestionsAutofill(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const merge = (result: Pick<AutofillPassResult, "filled" | "skipped">) => {
    filled.push(...result.filled);
    skipped.push(...result.skipped);
  };

  merge(
    await selectPhenomField(
      page,
      ['[id="jsqData.ExternalApplication_V4.a"]', '[name="jsqData.ExternalApplication_V4.a"]'],
      ["worked for humana", "previously worked", "previous employee"],
      ["No"],
      "previous worker",
    ),
  );
  merge(
    await selectPhenomField(
      page,
      ['[id="jsqData.ExternalApplication_V4.b"]', '[name="jsqData.ExternalApplication_V4.b"]'],
      ["legally authorized", "authorized to work"],
      ["Yes"],
      "work authorization",
    ),
  );
  merge(
    await selectPhenomField(
      page,
      ['[id="jsqData.ExternalApplication_V4.c"]', '[name="jsqData.ExternalApplication_V4.c"]'],
      ["sponsorship", "visa"],
      ["No"],
      "sponsorship",
    ),
  );
  merge(
    await selectPhenomField(
      page,
      ['[id="jsqData.ExternalApplication_V4.d"]', '[name="jsqData.ExternalApplication_V4.d"]'],
      ["reside", "commutable", "work location"],
      ["Yes"],
      "location eligibility",
    ),
  );
  merge(
    await fillPhenomTextField(
      page,
      ['[id="jsqData.ExternalApplication_V4.e"]', '[name="jsqData.ExternalApplication_V4.e"]'],
      ["salary", "compensation"],
      getPhenomSalaryExpectation(),
      "salary expectation",
    ),
  );
  merge(
    await fillPhenomTextField(
      page,
      ['[id="jsqData.ExternalApplication_V4.f"]', '[name="jsqData.ExternalApplication_V4.f"]'],
      ["reason for leaving", "why are you leaving"],
      getPhenomReasonForLeaving(),
      "reason for leaving",
    ),
  );
  merge(
    await setPhenomCheckbox(
      page,
      ['[id="jsqData.ExternalApplication_V4.g_4"]', '[name="jsqData.ExternalApplication_V4.g_4"]'],
      [/none of the above/i, /\bno\b/i],
      true,
      "federal employment answer",
    ),
  );
  merge(await runSutterPhenomQuestionnaireAutofill(page));

  if (await selectPhenomExactField(page, '[id="militaryExperience"]', ["No"])) {
    filled.push("military service");
  } else {
    skipped.push("military service");
  }

  const bnsfScreeningIndices = await page
    .locator('input[type="radio"][name^="jsqData.jsqData."]')
    .evaluateAll((nodes) =>
      Array.from(
        new Set(
          nodes
            .map((node) => (node as HTMLInputElement).name.match(/jsqData\.jsqData\.(\d+)_par/)?.[1])
            .filter((value): value is string => Boolean(value))
            .map(Number),
        ),
      ).sort((left, right) => left - right),
    )
    .catch(() => [] as number[]);
  let bnsfAnswered = 0;
  for (const index of bnsfScreeningIndices) {
    const questionText = await readBnsfScreeningQuestionText(page, index);
    const answer = inferBnsfScreeningAnswer(questionText, index);
    if (await chooseBnsfScreeningRadio(page, index, answer)) {
      bnsfAnswered += 1;
    }
  }
  if (bnsfAnswered > 0) {
    filled.push(`BNSF screening questions (${bnsfAnswered})`);
  } else {
    skipped.push("BNSF screening questions");
  }

  if (await selectPhenomExactField(page, '[id="app_ApplicantStatementConfirmationInt"]', ["I Understand"])) {
    filled.push("applicant statement acknowledgement");
  } else {
    skipped.push("applicant statement acknowledgement");
  }
  if (await fillPhenomExactTextField(page, '[id="app_ApplicantStatementSignatureInt"]', profile.name)) {
    filled.push("applicant statement signature");
  } else {
    skipped.push("applicant statement signature");
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

function inferPhenomSupplementaryAnswers(context: string, index: number): string[] {
  const normalized = normalizeQuestionText(context);
  if (/\b(kubernetes|k8s|container)\b/.test(normalized)) {
    return ["0-4 years", "0 - 4 years", "0 to 4 years"];
  }
  if (/\b(aws|amazon web services|cloud solution)\b/.test(normalized)) {
    return ["5-9 years", "5 - 9 years", "5 to 9 years"];
  }
  if (
    /\b(progressive it|hands on|engineering experience|software application|overall|technical leadership|senior engineer)\b/.test(
      normalized,
    )
  ) {
    return ["5-9 years", "5 - 9 years", "5 to 9 years"];
  }
  if (/\b(windows forms|dot net|net framework|c sharp|c#)\b/.test(normalized)) {
    return ["0-4 years", "0 - 4 years", "0 to 4 years"];
  }

  return index === 2 ? ["0-4 years", "0 - 4 years", "0 to 4 years"] : ["5-9 years", "5 - 9 years", "5 to 9 years"];
}

async function runPhenomSupplementaryQuestionsAutofill(
  page: Page,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const selects = page.locator('select[id^="supplementaryJsqData."], select[name^="supplementaryJsqData."]');
  const count = await selects.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const field = selects.nth(index);
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }

    const id = tidy(await field.getAttribute("id").catch(() => ""));
    const label = cleanExtractedLabel(await extractLocatorLabel(field).catch(() => ""));
    const context = tidy(`${label} ${await readPhenomFieldContext(field)} ${id}`);
    const displayLabel = label || `supplementary question ${index + 1}`;
    const currentValue = await readFieldCurrentValue(field, "select").catch(() => "");
    if (isMeaningfulValue(currentValue)) {
      filled.push(displayLabel);
      continue;
    }

    const applied = await selectNativeOption(field, inferPhenomSupplementaryAnswers(context, index));
    if (applied) {
      filled.push(displayLabel);
    } else {
      skipped.push(displayLabel);
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function runPhenomVoluntaryDisclosuresAutofill(
  page: Page,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const merge = (result: Pick<AutofillPassResult, "filled" | "skipped">) => {
    filled.push(...result.filled);
    skipped.push(...result.skipped);
  };

  merge(
    await selectPhenomField(
      page,
      ['[id="personalData.ethnicity"]', '[name="personalData.ethnicity"]', '[id="eeoUSA.ethnicity"]', '[name="eeoUSA.ethnicity"]'],
      ["ethnicity", "race"],
      ["I do not wish to answer (United States of America)", "I do not wish to answer", "Decline to Self Identify"],
      "ethnicity",
    ),
  );
  merge(
    await selectPhenomField(
      page,
      ['[id="personalData.gender"]', '[name="personalData.gender"]', '[id="eeoUSA.gender"]', '[name="eeoUSA.gender"]'],
      ["gender"],
      ["I do not wish to answer", "I do not wish to self-identify", "Decline to Self Identify", "No Selection"],
      "gender",
    ),
  );
  merge(
    await selectPhenomField(
      page,
      ['[id="personalData.veteranStatus"]', '[name="personalData.veteranStatus"]', '[id="eeoUSA.veteranStatus"]', '[name="eeoUSA.veteranStatus"]'],
      ["veteran"],
      ["I am not a veteran", "Not a Veteran", "I am not a protected veteran"],
      "veteran status",
    ),
  );
  merge(await setPhenomCheckbox(page, ['[id="agreementCheck"]', '[name="agreementCheck"]'], [/certify|read.*understand|accept.*terms/i], true, "disclosure certification"));
  if (await choosePhenomExactRadio(page, "gender.No Selection")) {
    filled.push("gender");
  } else {
    skipped.push("gender");
  }
  if (await selectPhenomExactField(page, '[id="disabilityStatus"]', ["I do not want to answer"])) {
    filled.push("disability status");
  } else {
    skipped.push("disability status");
  }
  if (await selectPhenomExactField(page, '[id="preVetStatus"]', ["I am not a protected veteran", "I do not wish to answer"])) {
    filled.push("veteran status");
  } else {
    skipped.push("veteran status");
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function runPhenomDisabilityAutofill(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const merge = (result: Pick<AutofillPassResult, "filled" | "skipped">) => {
    filled.push(...result.filled);
    skipped.push(...result.skipped);
  };

  merge(
    await selectPhenomField(
      page,
      ['select[id*="language" i]', 'select[name*="language" i]'],
      ["language"],
      ["English"],
      "disability language",
    ),
  );
  merge(
    await fillPhenomTextField(
      page,
      ['[id*="disability" i][id*="name" i]', '[name*="disability" i][name*="name" i]', 'input[id*="self_identity" i][id*="name" i]'],
      ["name"],
      profile.name,
      "disability name",
    ),
  );
  merge(
    await fillPhenomTextField(
      page,
      ['input[id*="disability" i][id*="date" i]', 'input[name*="disability" i][name*="date" i]', 'input[id*="date" i]'],
      ["date"],
      formatPhenomDate(),
      "disability date",
    ),
  );
  merge(
    await choosePhenomRadio(
      page,
      [
        '[id="disability_heading_self_identity1.disabilityStatus.DECLINE_REV_2026"]',
        'input[id*="DECLINE_REV_2026"]',
        'input[value*="DECLINE_REV_2026"]',
      ],
      [/disability/i],
      ["I do not want to answer", "Decline"],
      "disability status",
    ),
  );

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function runPhenomDirectAutofill(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped"> & { submitted: boolean }> {
  if ((await detectApplicationSiteKind(page)) !== "phenom") {
    return { filled: [], skipped: [], submitted: false };
  }
  if (await detectSiteSubmissionSuccess(page)) {
    return { filled: [], skipped: [], submitted: true };
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  const merge = (result: Pick<AutofillPassResult, "filled" | "skipped">) => {
    filled.push(...result.filled);
    skipped.push(...result.skipped);
  };

  const bodyText = normalizeQuestionText(await page.locator("body").innerText().catch(() => ""));
  const hasContactFields =
    (await page
      .locator('#applicantSource, [id="cntryFields.firstName"], [id="firstName"], [id="app_BNSFRelatives"], [id="privacyPolicy"]')
      .count()
      .catch(() => 0)) >
    0;
  const hasExperienceFields =
    (await page.locator('[id^="experienceData"], [name^="experienceData"]').count().catch(() => 0)) > 0;
  const hasEducationFields =
    (await page
      .locator('[id^="educationData"], [name^="educationData"], [id="app_HighSchoolType"], [id="degreeAchieved"], [id="app_HighestEdDiscipline1"]')
      .count()
      .catch(() => 0)) > 0;
  const hasApplicationQuestionFields =
    (await page
      .locator(
        '[id^="jsqData.ExternalApplication"], [name^="jsqData.ExternalApplication"], [id^="jsqData.QUESTIONNAIRE"], [name^="jsqData.QUESTIONNAIRE"], input[value^="REC_ANSR_"], [id="militaryExperience"], input[name^="jsqData.jsqData"], [id="app_ApplicantStatementConfirmationInt"]',
      )
      .count()
      .catch(() => 0)) >
    0;
  const hasSupplementaryFields =
    (await page.locator('[id^="supplementaryJsqData."], [name^="supplementaryJsqData."]').count().catch(() => 0)) >
    0;
  const hasVoluntaryFields =
    (await page
      .locator('[id^="personalData."], [name^="personalData."], [id^="eeoUSA."], [name^="eeoUSA."], [id="agreementCheck"], [id="ethnicity"], [id="disabilityStatus"], [id="preVetStatus"], input[name="gender"]')
      .count()
      .catch(() => 0)) > 0;
  const hasDisabilityFields = /\bdisability\b/.test(bodyText) && /\bvoluntary self/.test(bodyText);

  if (hasContactFields || /\bmy information\b/.test(bodyText)) {
    merge(await runPhenomContactAutofill(page, profile));
  }
  if (hasExperienceFields || /\bmy experience\b/.test(bodyText)) {
    merge(await runPhenomWorkExperienceAutofill(page));
  }
  if (hasEducationFields || /\bmy education\b/.test(bodyText)) {
    merge(await runPhenomEducationAutofill(page));
  }
  if (hasApplicationQuestionFields || /\bapplication questions\b/.test(bodyText)) {
    merge(await runPhenomApplicationQuestionsAutofill(page, profile));
  }
  if (hasSupplementaryFields || /\bsupplementary questions\b/.test(bodyText)) {
    merge(await runPhenomSupplementaryQuestionsAutofill(page));
  }
  if (hasVoluntaryFields || /\bvoluntary disclosures\b/.test(bodyText)) {
    merge(await runPhenomVoluntaryDisclosuresAutofill(page));
  }
  if (hasDisabilityFields) {
    merge(await runPhenomDisabilityAutofill(page, profile));
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    submitted: false,
  };
}

function formatUkgIsoDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatUkgDisplayDate(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

function getUkgAvailabilityDate(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 14);
  return date;
}

function inferUkgSalaryExpectation(pageText: string): string {
  const ranges = [...pageText.matchAll(/\$\s*([0-9][0-9,]*(?:\.\d+)?)\s*(?:usd)?\s*[-–]\s*\$?\s*([0-9][0-9,]*(?:\.\d+)?)/gi)]
    .map((match) => {
      const min = Number(match[1].replace(/,/g, ""));
      const max = Number(match[2].replace(/,/g, ""));
      return { min, max };
    })
    .filter(({ min, max }) => Number.isFinite(min) && Number.isFinite(max) && min >= 30_000 && max > min);

  if (ranges.length > 0) {
    const { min, max } = ranges[0];
    const target = min + (max - min) * 0.4;
    return String(Math.round(target / 1000) * 1000);
  }

  return "150000";
}

function inferUkgNumericResponse(label: string, pageText: string): string {
  const normalized = normalizeQuestionText(label);
  if (/salary|compensation|pay expectation|expected pay|desired pay/.test(normalized)) {
    return inferUkgSalaryExpectation(pageText);
  }
  if (/playwright|selenium|sdet|test automation|automation framework|quality engineer/.test(normalized)) {
    return "2";
  }
  if (/healthcare|health care|clinical|medical domain/.test(normalized)) {
    return "0";
  }
  if (/cloud|aws|gcp|azure|devops|infrastructure|linux|kubernetes|terraform|ansible|container/.test(normalized)) {
    return "4";
  }
  if (/years|yrs|experience/.test(normalized)) {
    return "5";
  }

  return "1";
}

function inferUkgTextResponse(label: string, profile: Profile): string {
  const normalized = normalizeQuestionText(label);
  if (/salary|compensation|pay expectation/.test(normalized)) {
    return "$150,000 - $175,000 base salary, depending on scope and total compensation.";
  }
  if (/0 to 2 years|ai and machine learning|software development.*ai/.test(normalized)) {
    return "Yes. I have built production software that integrates AI and LLM APIs into full-stack workflows, including backend services, prompt and response handling, evaluation checks, and operational dashboards. I have also built data pipelines, analytics workflows, and cloud deployments using Python, JavaScript/TypeScript, SQL, and cloud services. My focus is making AI-assisted features reliable, observable, and maintainable rather than just prototyping them.";
  }
  if (/challenging project|technical challenging|tradeoffs/.test(normalized)) {
    return "At IBM I re-architected a web application with backend APIs, document storage, queues, and deployment pipelines while addressing memory and database performance issues. The challenge was improving reliability without disrupting active users. I decomposed the system into clearer service boundaries, added queue-based request handling, optimized database access, and introduced CI/CD checks. The tradeoff was shipping incremental changes instead of a big rewrite, which reduced risk and still cut server resource usage by more than 50%.";
  }
  if (/20 adoption|more features|mandates/.test(normalized)) {
    return "I would not start with more features or mandates. I would segment the users who adopted it, compare their workflow to non-adopters, review task completion data, and interview users to identify the friction. Then I would improve the highest-friction path, add in-product guidance or defaults, and define an adoption metric tied to successful outcomes, not raw usage.";
  }
  if (/production bug|critical client demo|200 line refactor/.test(normalized)) {
    return "No. I would not ship a broad refactor right before a critical demo unless the current bug made the demo impossible and the change was isolated and well understood. I would first find the smallest safe fix, add a targeted regression test, and verify the demo path. If the refactor is the right long-term fix, I would branch it for review after the demo.";
  }
  if (/500 line pull request|subtle logic|lazy patterns|reviewing this code/.test(normalized)) {
    return "I would review it against intent, not just tests: restate the requirement, trace data flow and edge cases, inspect invariants, error handling, auth and permissions, performance, and rollback behavior. I would add or request tests for boundary conditions and failure modes the existing suite misses, compare generated code to local patterns, and look for unnecessary abstraction or duplicated logic.";
  }
  if (/mental model|same mistake|future iterations/.test(normalized)) {
    return "I would turn the mistake into feedback the agent can use: write a failing test or lint check that captures the error, add a short rule or example to the prompt or repo guidance, and update the task template to require the relevant verification. If the mistake comes from missing context, I would provide the correct local pattern and a counterexample.";
  }
  if (/shipped ai feature|owned end to end|last 24 months/.test(normalized)) {
    return "In the last 24 months I owned an AI-assisted workflow in a full-stack product for extracting structured signals from operational and business data and presenting them through a web dashboard. My scope covered backend ingestion, prompt/API integration, data storage, UI review flows, deployment, and monitoring. The stack included Python/TypeScript, SQL, cloud services, and CI/CD. After launch, edge-case inputs exposed inconsistent model outputs, so I added validation, fallback handling, and clearer human review states.";
  }
  if (/systemic bloat|codebase grows|human can understand/.test(normalized)) {
    return "I keep the architecture human-sized: clear ownership boundaries, small PRs, aggressive deletion of unused code, documented interfaces, and tests that describe behavior. AI-generated code still has to pass design review, complexity thresholds, and local conventions. I track module size, dependency growth, duplication, and operational incidents as leading indicators.";
  }
  if (/technically working.*not defensible|detect it|document it|prevent recurrence/.test(normalized)) {
    return "A defensible issue is when an AI output produces a plausible answer without traceable evidence or with a hidden assumption. I detect that by checking source data, invariants, and examples where the output should be constrained. I document the failure with the input, expected behavior, actual output, and root cause category. To prevent recurrence, I add validation, grounding checks, regression tests, and UI language that makes uncertainty explicit.";
  }
  if (/why.*interested|why.*role|additional information|anything else/.test(normalized)) {
    return profile.resumeSummary;
  }

  return profile.resumeSummary;
}

async function selectUkgNativeOption(page: Page, selector: string, values: string[]): Promise<boolean> {
  const field = page.locator(selector).first();
  if ((await field.count().catch(() => 0)) === 0) {
    return false;
  }
  const selected = await selectNativeOption(field, values).catch(() => false);
  if (selected) {
    await page.waitForTimeout(300).catch(() => undefined);
  }
  return selected;
}

async function fillUkgText(page: Page, selector: string, value: string): Promise<boolean> {
  const field = page.locator(selector).first();
  if ((await field.count().catch(() => 0)) === 0 || !value.trim()) {
    return false;
  }
  const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "input");
  return setEditableFieldValue(page, field, tag, value).catch(() => false);
}

async function readUkgQuestionText(field: Locator): Promise<string> {
  const nearby = cleanExtractedLabel(await readNearbyFieldLabel(field).catch(() => ""));
  if (nearby && !/^please enter a whole number$/i.test(nearby)) {
    return nearby;
  }

  return field
    .evaluate((node) => {
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
      let current: Element | null = node.parentElement;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const text = normalize(current.textContent || "");
        if (
          text.length >= 20 &&
          !/^please enter a whole number\.?$/i.test(text) &&
          !/^choose\.\.\.$/i.test(text)
        ) {
          return text;
        }
      }
      return "";
    })
    .catch(() => "");
}

async function clearUkgNonApplicableRequiredFields(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const isVisible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };

      for (const selector of [
        'input[data-automation="gender-decline-checkbox"]',
        'input[data-automation="ethnic-origin-decline-checkbox"]',
        'input[data-automation="race-decline-checkbox"]',
      ]) {
        const input = document.querySelector<HTMLInputElement>(selector);
        if (input && !input.checked) {
          input.checked = true;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }

      for (const element of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input[required], textarea[required], select[required]"))) {
        if (!isVisible(element) || ["Gender", "HispanicOrigin", "EthnicOrigin"].includes(element.id)) {
          element.required = false;
          element.removeAttribute("required");
          element.setCustomValidity("");
        }
      }
    })
    .catch(() => undefined);
}

async function applyUkgKnockoutAnswers(page: Page, profile: Profile): Promise<boolean> {
  const availabilityDate = getUkgAvailabilityDate();
  return page
    .evaluate(
      ({ name, displayDate, isoDate }) => {
        const ko = (window as unknown as { ko?: any }).ko;
        if (!ko) {
          return false;
        }
        const submitButton = document.querySelector('ukg-button[data-automation="btn-submit"]');
        const context = submitButton ? ko.contextFor(submitButton) : ko.contextFor(document.body);
        const root = context?.$root || context?.$data;
        const application = root?.application?.();
        if (!application) {
          return false;
        }

        const setObservable = (target: unknown, value: unknown) => {
          if (ko.isObservable(target)) {
            (target as (nextValue: unknown) => void)(value);
          }
        };
        const normalize = (value: string) =>
          (value || "")
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const matches = (value: string, pattern: RegExp) => pattern.test(normalize(value));
        const getQuestionText = (question: any, index: number) => {
          const direct = ko.unwrap(question?.Question) || "";
          if (direct) {
            return String(direct);
          }
          const staticQuestion = root?.opportunity?.ApplicationQuestions?.[index]?.Question || "";
          return String(staticQuestion);
        };
        const chooseValue = (questionText: string, choices: Array<{ value: string; text: string }>) => {
          const normalized = normalize(questionText);
          const pick = (patterns: RegExp[]) => {
            const choice = choices.find((candidate) =>
              patterns.some((pattern) => pattern.test(normalize(candidate.text)) || pattern.test(normalize(candidate.value))),
            );
            const numeric = Number(choice?.value);
            return Number.isFinite(numeric) ? numeric : null;
          };
          if (/related to.*employee|current.*employee|employee referral|refer/.test(normalized)) return pick([/^no$/]);
          if (/sponsor|sponsorship|immigration support|work visa|employment visa/.test(normalized)) return pick([/^no$/]);
          if (/confirm|certify|truth|accurate|complete/.test(normalized)) return pick([/confirm|agree|yes/]);
          if (/citizen|lawful permanent resident|asylum|refugee|legally eligible|authorized to work|work in the united states/.test(normalized)) return pick([/^yes$/]);
          if (/degree|bachelor|education|experience|0 to 2 years|minimum qualification/.test(normalized)) return pick([/^yes$/]);
          return pick([/^yes$/]) ?? pick([/^no$/]);
        };

        setObservable(application.HasEmployeeReferral, false);
        setObservable(application.AvailableStartDate, isoDate);

        const responses = ko.unwrap(application.ApplicationQuestionResponses) || [];
        for (const [index, response] of responses.entries()) {
          const type = ko.unwrap(response.ResponseType);
          if (type !== "MultipleChoice") {
            continue;
          }
          const radios = Array.from(
            document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="MultipleChoiceResponse${index}"]`),
          );
          const choices = radios.map((radio) => ({
            value: radio.value,
            text: (radio.closest("label")?.textContent || radio.value).replace(/\s+/g, " ").trim(),
          }));
          const numeric = chooseValue(getQuestionText(response, index), choices);
          if (numeric === null) {
            continue;
          }
          setObservable(response.NumericResponse, numeric);
          setObservable(response.uiErrors, {});
          const radio = radios.find((candidate) => Number(candidate.value) === numeric);
          if (radio) {
            radio.checked = true;
            radio.dispatchEvent(new Event("input", { bubbles: true }));
            radio.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }

        const countryQuestions = ko.unwrap(application.CountryQuestions) || [];
        const setCountryQuestion = (questionPattern: RegExp, answer: string) => {
          const question = countryQuestions.find((candidate: any) => matches(String(ko.unwrap(candidate.Question) || ""), questionPattern));
          if (!question) {
            return;
          }
          setObservable(question.Answer, answer);
          setObservable(question.uiErrors, {});
          if (questionPattern.test("disability")) {
            setObservable(question.Name, name);
            setObservable(question.Date, displayDate);
          }
        };
        setCountryQuestion(/veteran/, "No");
        setCountryQuestion(/disability/, "Decline");
        setCountryQuestion(/gender/, "Decline");
        setCountryQuestion(/ethnic origin|race|hispanic/, "Decline");

        const disabilityQuestion = root.countryQuestionsViewModel?.disabilityOptions?.question;
        if (disabilityQuestion) {
          setObservable(disabilityQuestion.Answer, "Decline");
          setObservable(disabilityQuestion.Name, name);
          setObservable(disabilityQuestion.Date, displayDate);
          setObservable(disabilityQuestion.uiErrors, {});
        }
        const veteranQuestion = root.countryQuestionsViewModel?.veteranStatusOptions?.question;
        if (veteranQuestion) {
          setObservable(veteranQuestion.Answer, "No");
          setObservable(veteranQuestion.uiErrors, {});
        }

        for (const selector of [
          'input[data-automation="gender-decline-checkbox"]',
          'input[data-automation="ethnic-origin-decline-checkbox"]',
          'input[name="AreYouDisabled"][value="Decline"]',
          'input[name="employeereferral"][value="false"]',
        ]) {
          const element = document.querySelector<HTMLInputElement>(selector);
          if (element) {
            element.checked = true;
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }

        const serverErrors = ko.unwrap(application.serverErrors);
        if (serverErrors) {
          serverErrors.uiErrors = {};
          serverErrors.domainErrors = [];
          setObservable(application.serverErrors, serverErrors);
        }

        return true;
      },
      { name: profile.name, displayDate: formatUkgDisplayDate(availabilityDate), isoDate: formatUkgIsoDate(availabilityDate) },
    )
    .catch(() => false);
}

async function clickUkgSaveAndContinueIfVisible(page: Page): Promise<boolean> {
  const buttons = page.locator('button[data-automation="save-button"], ukg-button, button');
  const count = await buttons.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const label = tidy(await button.textContent().catch(() => ""));
    if (!/save and continue/i.test(label) || !(await button.isVisible().catch(() => false))) {
      continue;
    }
    const clicked =
      (await button.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
      (await button.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
    if (clicked) {
      await page.waitForTimeout(5_000).catch(() => undefined);
      return true;
    }
  }

  return false;
}

async function handleUkgAttachmentChangedModal(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const isVisible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '#AttachmentsChangedModal [data-automation="attachments-modal-yes"], #AttachmentsChangedModal [data-automation="attachments-modal-no"]',
        ),
      );
      const button = buttons.find((candidate) => isVisible(candidate) && /^no$/i.test((candidate.textContent || "").trim())) ||
        buttons.find((candidate) => isVisible(candidate));
      if (!button) {
        return false;
      }
      button.click();
      return true;
    })
    .catch(() => false);
}

async function runUkgDirectAutofill(page: Page, profile: Profile): Promise<DirectSiteAutofillResult> {
  if ((await detectApplicationSiteKind(page)) !== "ukg") {
    return { filled: [], skipped: [], handled: false };
  }
  if (await detectSiteSubmissionSuccess(page)) {
    return { filled: [], skipped: [], handled: true, submitted: true };
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  const [firstName = "", ...lastNameParts] = profile.name.split(/\s+/).filter(Boolean);
  const lastName = lastNameParts.join(" ");
  const pageText = await page.locator("body").innerText().catch(() => "");

  if (await clickUkgSaveAndContinueIfVisible(page)) {
    return { filled: ["UKG resume parse save and continue"], skipped: [], handled: true, advanced: true };
  }

  const textFields: Array<[string, string, string]> = [
    ["#FirstName", firstName, "UKG first name"],
    ["#FamilyName", lastName, "UKG last name"],
    ["#Phone", profile.phone.replace(/\D/g, ""), "UKG phone"],
    ["#AddressLine1", profile.streetAddress, "UKG address"],
    ["#City", profile.city || profile.location, "UKG city"],
    ["#PostalCode", profile.postalCode, "UKG postal code"],
    ["#YourName", profile.name, "UKG disability name"],
  ];
  for (const [selector, value, label] of textFields) {
    const applied = await fillUkgText(page, selector, value);
    if (applied) filled.push(label);
    else skipped.push(label);
  }

  const selections: Array<[string, string[], string]> = [
    ["#Country", ["United States", "US", "USA"], "UKG country"],
    ["#State", [expandUsStateName(profile.state), profile.state], "UKG state"],
    ["#ApplicantSource", ["LinkedIn"], "UKG source"],
    ["#USFederalContractor", ["No"], "UKG veteran status"],
  ];
  for (const [selector, values, label] of selections) {
    if (selector === "#State") {
      await page
        .waitForFunction(
          () => Array.from(document.querySelectorAll("#State option")).some((option) => /North Carolina|NC/i.test(option.textContent || "")),
          null,
          { timeout: 8_000 },
        )
        .catch(() => undefined);
    }
    const applied = await selectUkgNativeOption(page, selector, values);
    if (applied) filled.push(label);
    else skipped.push(label);
  }

  const availabilityDate = getUkgAvailabilityDate();
  const startDateApplied = await page
    .evaluate((isoDate) => {
      const host = document.querySelector<HTMLElement>('[data-automation="available-start-date-datepicker"] ukg-input');
      if (!host) {
        return false;
      }
      host.setAttribute("value", isoDate);
      host.setAttribute("default-value", isoDate);
      host.setAttribute("data-date-value", isoDate);
      (host as unknown as { value?: string }).value = isoDate;
      host.dispatchEvent(new Event("input", { bubbles: true }));
      host.dispatchEvent(new Event("change", { bubbles: true }));
      const text = host.querySelector<HTMLElement>("ukg-date-input-text");
      if (text) {
        text.setAttribute("value", isoDate);
        (text as unknown as { value?: string }).value = isoDate;
        text.dispatchEvent(new Event("input", { bubbles: true }));
        text.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    }, formatUkgIsoDate(availabilityDate))
    .catch(() => false);
  if (startDateApplied) filled.push("UKG start date");
  else skipped.push("UKG start date");

  const numericFields = page.locator('input[id^="NumericResponse"]');
  const numericCount = await numericFields.count().catch(() => 0);
  for (let index = 0; index < numericCount; index += 1) {
    const field = numericFields.nth(index);
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }
    const label = await readUkgQuestionText(field);
    const answer = inferUkgNumericResponse(label, pageText);
    const applied = await setEditableFieldValue(page, field, "input", answer).catch(() => false);
    if (applied) filled.push(`UKG numeric question ${index + 1}`);
    else skipped.push(cleanExtractedLabel(label) || `UKG numeric question ${index + 1}`);
  }

  const questionFields = page.locator('textarea[id^="TextResponse"]');
  const questionCount = await questionFields.count().catch(() => 0);
  for (let index = 0; index < questionCount; index += 1) {
    const field = questionFields.nth(index);
    const label = await readNearbyFieldLabel(field).catch(() => "");
    const answer = inferUkgTextResponse(label, profile);
    const applied = await setEditableFieldValue(page, field, "textarea", answer).catch(() => false);
    if (applied) filled.push(`UKG text question ${index + 1}`);
    else skipped.push(cleanExtractedLabel(label) || `UKG text question ${index + 1}`);
  }

  const modelApplied = await applyUkgKnockoutAnswers(page, profile);
  if (modelApplied) filled.push("UKG application question model");
  else skipped.push("UKG application question model");
  await clearUkgNonApplicableRequiredFields(page);

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    handled: true,
  };
}

type OracleHcmDirectAutofillResult = Pick<AutofillPassResult, "filled" | "skipped"> & {
  handled: boolean;
  advanced?: boolean;
  submitted?: boolean;
};

function oracleAnswerMatches(actual: string, expected: string | RegExp): boolean {
  if (expected instanceof RegExp) {
    return expected.test(actual);
  }

  return matchesDesiredChoice(actual, expected);
}

async function oracleReadPillButtons(row: Locator): Promise<Array<{ text: string; selected: boolean }>> {
  return row
    .locator("button.cx-select-pill-section")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const element = button as HTMLElement;
        const className = `${element.className || ""}`;
        return {
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
          selected: className.includes("cx-select-pill-section--selected") || element.getAttribute("aria-pressed") === "true",
        };
      }),
    )
    .catch(() => []);
}

async function oraclePillSelected(row: Locator, expected: string | RegExp): Promise<boolean> {
  const buttons = await oracleReadPillButtons(row);
  return buttons.some((button) => button.selected && oracleAnswerMatches(button.text, expected));
}

async function findOraclePillButton(row: Locator, expected: string | RegExp): Promise<Locator | null> {
  const buttons = row.locator("button.cx-select-pill-section");
  const count = await buttons.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const text = tidy(await button.textContent().catch(() => ""));
    if (text && oracleAnswerMatches(text, expected)) {
      return button;
    }
  }

  return null;
}

async function clickOraclePillByQuestion(
  page: Page,
  questionPattern: RegExp,
  answer: string | RegExp,
): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = page.locator(".input-row").filter({ hasText: questionPattern }).first();
    if (!(await row.isVisible().catch(() => false))) {
      return false;
    }

    if (await oraclePillSelected(row, answer)) {
      return true;
    }

    const button = await findOraclePillButton(row, answer);
    if (!button) {
      return false;
    }

    await button.scrollIntoViewIfNeeded().catch(() => undefined);
    const clicked =
      (await button.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
      (await button.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
    await page.waitForTimeout(500).catch(() => undefined);
    if (clicked && (await oraclePillSelected(row, answer))) {
      return true;
    }

    const box = await button.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
      await page.waitForTimeout(650).catch(() => undefined);
      if (await oraclePillSelected(row, answer)) {
        return true;
      }
    }
  }

  const row = page.locator(".input-row").filter({ hasText: questionPattern }).first();
  return oraclePillSelected(row, answer);
}

async function findVisibleOracleOption(page: Page, expected: string): Promise<Locator | null> {
  const options = page.locator('[role="row"], [role="gridcell"], [role="option"], [id*="listitem"], li[id*="listitem"]');
  const normalizedExpected = normalizeQuestionText(expected);
  const count = Math.min(await options.count().catch(() => 0), 140);
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    if (!(await option.isVisible().catch(() => false))) {
      continue;
    }

    const text = tidy(await option.textContent().catch(() => ""));
    const normalizedText = normalizeQuestionText(text);
    if (
      text &&
      (matchesDesiredChoice(text, expected) ||
        (Boolean(normalizedText) &&
          Boolean(normalizedExpected) &&
          (normalizedText.startsWith(normalizedExpected) ||
            normalizedText.includes(normalizedExpected) ||
            normalizedExpected.includes(normalizedText))))
    ) {
      return option;
    }
  }

  return null;
}

async function clickOracleLocator(page: Page, locator: Locator): Promise<boolean> {
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  const clicked =
    (await locator.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
    (await locator.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
  if (clicked) {
    return true;
  }

  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    return false;
  }

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
  return true;
}

async function selectOracleComboboxValue(
  page: Page,
  field: Locator,
  candidates: string[],
): Promise<boolean> {
  if (!(await field.isVisible().catch(() => false))) {
    return false;
  }

  const current = tidy(await field.inputValue().catch(() => ""));
  const invalid = tidy(await field.getAttribute("aria-invalid").catch(() => ""));
  if (isMeaningfulValue(current) && invalid !== "true" && candidates.some((candidate) => matchesDesiredChoice(current, candidate))) {
    return true;
  }

  for (const candidate of candidates) {
    await field.scrollIntoViewIfNeeded().catch(() => undefined);
    await field.click({ timeout: 5_000 }).catch(() => field.click({ timeout: 5_000, force: true }).catch(() => undefined));
    await field.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
    await field.press("Backspace").catch(() => undefined);
    await field.fill(candidate).catch(() => undefined);
    await field.dispatchEvent("input").catch(() => undefined);
    await page.waitForTimeout(900).catch(() => undefined);

    const option = await findVisibleOracleOption(page, candidate);
    if (!option) {
      await field.press("Escape").catch(() => undefined);
      await page.waitForTimeout(150).catch(() => undefined);
      continue;
    }

    await clickOracleLocator(page, option);
    await page.waitForTimeout(700).catch(() => undefined);
    const nextValue = tidy(await field.inputValue().catch(() => ""));
    const nextInvalid = tidy(await field.getAttribute("aria-invalid").catch(() => ""));
    if (isMeaningfulValue(nextValue) && nextInvalid !== "true") {
      return true;
    }
  }

  return false;
}

async function setOracleTextFieldValue(page: Page, field: Locator, value: string): Promise<boolean> {
  if (!(await field.isVisible().catch(() => false))) {
    return false;
  }

  const current = tidy(await field.inputValue().catch(() => ""));
  if (isAcceptableEditableValue(current, value)) {
    return true;
  }

  const applied = await replaceEditableFieldValueByTyping(page, field, value);
  if (applied) {
    return true;
  }

  await field.scrollIntoViewIfNeeded().catch(() => undefined);
  await field.click({ timeout: 5_000, force: true }).catch(() => undefined);
  await field.fill("").catch(() => undefined);
  await field.fill(value).catch(() => undefined);
  await field.dispatchEvent("input").catch(() => undefined);
  await field.dispatchEvent("change").catch(() => undefined);
  await field.press("Tab").catch(() => undefined);
  await page.waitForTimeout(300).catch(() => undefined);
  return isAcceptableEditableValue(await field.inputValue().catch(() => ""), value);
}

async function checkOracleCheckboxByLabel(page: Page, pattern: RegExp): Promise<boolean> {
  const labels = page.locator("label");
  const count = Math.min(await labels.count().catch(() => 0), 120);
  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    if (!(await label.isVisible().catch(() => false))) {
      continue;
    }

    const text = tidy(await label.textContent().catch(() => ""));
    if (!pattern.test(text)) {
      continue;
    }

    const clicked =
      (await label.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
      (await label.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
    await page.waitForTimeout(300).catch(() => undefined);
    return clicked;
  }

  return false;
}

async function clickOracleVisibleButtonByText(page: Page, pattern: RegExp): Promise<boolean> {
  const buttons = page.locator('button, input[type="button" i], input[type="submit" i], a[role="button"], [role="button"]');
  const count = Math.min(await buttons.count().catch(() => 0), 120);
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible().catch(() => false))) {
      continue;
    }
    if (await button.isDisabled().catch(() => false)) {
      continue;
    }

    const text = tidy(
      [
        await button.textContent().catch(() => ""),
        await button.getAttribute("value").catch(() => ""),
        await button.getAttribute("aria-label").catch(() => ""),
      ].join(" "),
    );
    if (!pattern.test(text)) {
      continue;
    }

    if (await clickOracleLocator(page, button)) {
      await page.waitForTimeout(900).catch(() => undefined);
      return true;
    }
  }

  const clicked = await page
    .evaluate(
      ({ source, flags }) => {
        const regex = new RegExp(source, flags);
        const isVisible = (element: HTMLElement): boolean => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>('button, input[type="button" i], input[type="submit" i], a[role="button"], [role="button"]'),
        );
        const target = candidates.find((element) => {
          if (!isVisible(element)) return false;
          if ((element as HTMLButtonElement).disabled) return false;
          const label = [
            element.textContent || "",
            element.getAttribute("value") || "",
            element.getAttribute("aria-label") || "",
          ]
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          return regex.test(label);
        });
        if (!target) {
          return false;
        }
        target.scrollIntoView({ block: "center", inline: "center" });
        target.click();
        return true;
      },
      { source: pattern.source, flags: pattern.flags },
    )
    .catch(() => false);
  if (clicked) {
    await page.waitForTimeout(900).catch(() => undefined);
  }

  return clicked;
}

function getOracleVerificationCode(): string {
  const raw = tidy(
    process.env.JAA_ORACLE_VERIFICATION_CODE ||
      process.env.JAA_VERIFICATION_CODE ||
      process.env.JAA_LAST_VERIFICATION_CODE ||
      "",
  );
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 6 ? digits.slice(0, 6) : "";
}

async function fillOraclePinCode(page: Page, code: string): Promise<boolean> {
  const digits = code.replace(/\D/g, "").slice(0, 6);
  if (digits.length < 6) {
    return false;
  }

  const pinFields = page.locator('input[id^="pin-code-"], input[name^="pin-code"], input[autocomplete="one-time-code"]');
  const count = await pinFields.count().catch(() => 0);
  if (count >= 6) {
    for (let index = 0; index < 6; index += 1) {
      const field = pinFields.nth(index);
      await field.fill(digits[index]).catch(() => undefined);
      await field.dispatchEvent("input").catch(() => undefined);
    }
    await page.waitForTimeout(300).catch(() => undefined);
    return true;
  }

  const field = pinFields.first();
  if (!(await field.isVisible().catch(() => false))) {
    return false;
  }
  await field.fill(digits).catch(() => undefined);
  await field.dispatchEvent("input").catch(() => undefined);
  await page.waitForTimeout(300).catch(() => undefined);
  return true;
}

async function runOracleHcmEducationFixes(page: Page): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const educationSection = page.locator(".apply-flow-block--tile-profile-items").filter({ hasText: /Education/i }).first();
  if (!(await educationSection.isVisible().catch(() => false))) {
    return { filled, skipped };
  }

  const sectionText = tidy(await educationSection.textContent().catch(() => ""));
  const editorOpen = await educationSection.locator(".profile-item-content input").first().isVisible().catch(() => false);
  if (!editorOpen && /fields? to fix/i.test(sectionText)) {
    const editButton = educationSection.locator('button[aria-label="Edit"]').first();
    if (await editButton.isVisible().catch(() => false)) {
      await editButton.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(1_200).catch(() => undefined);
    }
  }

  const editor = educationSection.locator(".profile-item-content").first();
  if (!(await editor.isVisible().catch(() => false))) {
    return { filled, skipped };
  }

  const major = editor.locator('input[name="major"][role="combobox"]').first();
  if (await major.isVisible().catch(() => false)) {
    const ok = await selectOracleComboboxValue(page, major, [
      "Computer Information Systems",
      "Information Systems",
      "Management Information Systems",
      "Computer Science",
      "NOT IN LIST",
    ]);
    if (ok) filled.push("Oracle HCM education major");
    else skipped.push("Oracle HCM education major");
  }

  const country = editor.locator('input[name="countryCode"][role="combobox"]').first();
  if (await country.isVisible().catch(() => false)) {
    const ok = await selectOracleComboboxValue(page, country, ["United States"]);
    if (ok) filled.push("Oracle HCM education country");
    else skipped.push("Oracle HCM education country");
  }

  const state = editor.locator('input[name="stateProvinceCode"][role="combobox"]').first();
  if (await state.isVisible().catch(() => false)) {
    await selectOracleComboboxValue(page, state, [expandUsStateName("NC"), "NC", "North Carolina"]).catch(() => false);
  }

  const city = editor.locator('input[name="city"]:not([role="combobox"]), input[name="city"][role="combobox"]').first();
  if (await city.isVisible().catch(() => false)) {
    const ok = await setOracleTextFieldValue(page, city, "Raleigh");
    if (ok) filled.push("Oracle HCM education city");
    else skipped.push("Oracle HCM education city");
  }

  const saveButton = educationSection.locator('.profile-item-footer button:has-text("Save")').first();
  if (await saveButton.isVisible().catch(() => false)) {
    const clicked = await saveButton.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(2_000).catch(() => undefined);
    if (clicked) filled.push("Oracle HCM education save");
    else skipped.push("Oracle HCM education save");
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function runOracleHcmDirectAutofill(
  page: Page,
  profile: Profile,
  submit = false,
): Promise<OracleHcmDirectAutofillResult> {
  if ((await detectApplicationSiteKind(page)) !== "oraclehcm") {
    return { filled: [], skipped: [], handled: false };
  }

  if (await detectSiteSubmissionSuccess(page)) {
    return { filled: [], skipped: [], handled: true, submitted: true };
  }

  const hasApplyForm =
    /\/apply\//i.test(page.url()) ||
    /\/easy-apply(?:\/|$)/i.test(page.url()) ||
    (await page
      .locator(".apply-flow-block, button.cx-select-pill-section, input[name='lastName'], input[id^='pin-code-']")
      .count()
      .catch(() => 0)) > 0;
  if (!hasApplyForm) {
    return { filled: [], skipped: [], handled: false };
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  const firstName = profile.name.trim().split(/\s+/)[0] || "";
  const lastName = profile.name.trim().split(/\s+/).slice(1).join(" ");
  const mark = (label: string, ok: boolean): void => {
    if (ok) filled.push(label);
    else skipped.push(label);
  };
  const fillText = async (selector: string, value: string, label: string): Promise<void> => {
    const field = page.locator(selector).first();
    if (!(await field.isVisible().catch(() => false))) {
      return;
    }
    mark(label, await setOracleTextFieldValue(page, field, value));
  };
  const fillCombo = async (selector: string, candidates: string[], label: string): Promise<void> => {
    const field = page.locator(selector).first();
    if (!(await field.isVisible().catch(() => false))) {
      return;
    }
    mark(label, await selectOracleComboboxValue(page, field, candidates));
  };
  const clickPill = async (question: RegExp, answer: string | RegExp, label: string): Promise<void> => {
    const row = page.locator(".input-row").filter({ hasText: question }).first();
    if (!(await row.isVisible().catch(() => false))) {
      return;
    }
    mark(label, await clickOraclePillByQuestion(page, question, answer));
  };

  if (submit && (await page.locator('input[id^="pin-code-"], input[name^="pin-code"]').first().isVisible().catch(() => false))) {
    const verificationCode = getOracleVerificationCode();
    if (!verificationCode) {
      skipped.push("Oracle HCM verification code");
      return {
        filled: dedupeText(filled),
        skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
        handled: true,
        submitted: false,
      };
    }

    mark("Oracle HCM verification code", await fillOraclePinCode(page, verificationCode));
    mark("Oracle HCM verify button", await clickOracleVisibleButtonByText(page, /^verify$/i));
    await page.waitForTimeout(6_000).catch(() => undefined);
    const submittedAfterVerify = await detectSiteSubmissionSuccess(page);
    return {
      filled: dedupeText(filled),
      skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
      handled: true,
      advanced: !submittedAfterVerify,
      submitted: submittedAfterVerify,
    };
  }

  await fillText('input[name="email"][type="email"], input[type="email"]', profile.email, "Oracle HCM email");
  await fillText('input[name="firstName"]', firstName, "Oracle HCM first name");
  await fillText('input[name="lastName"]', lastName, "Oracle HCM last name");
  await fillText('input[type="tel"]', profile.phone, "Oracle HCM phone");
  await fillCombo('input[name="country"][role="combobox"]', ["United States"], "Oracle HCM country");
  await fillText(
    '.apply-flow-block--personal-information-address-v2 input[name="addressLine1"]',
    profile.streetAddress,
    "Oracle HCM address line 1",
  );
  await fillText(
    '.apply-flow-block--personal-information-address-v2 input[name="addressLine2"]',
    profile.addressLine2,
    "Oracle HCM address line 2",
  );
  await fillCombo(
    '.apply-flow-block--personal-information-address-v2 input[name="postalCode"][role="combobox"]',
    [`${profile.postalCode}, ${profile.city}, Wake, ${profile.state}`, profile.postalCode],
    "Oracle HCM postal code",
  );
  await fillCombo(
    '.apply-flow-block--personal-information-address-v2 input[name="city"][role="combobox"]',
    [profile.city, "Raleigh"],
    "Oracle HCM city",
  );
  await fillCombo(
    '.apply-flow-block--personal-information-address-v2 input[name="region2"][role="combobox"]',
    [profile.state, expandUsStateName(profile.state), "NC"],
    "Oracle HCM state",
  );
  await fillCombo(
    '.apply-flow-block--personal-information-address-v2 input[name="region1"][role="combobox"]',
    ["Wake", "Wake County"],
    "Oracle HCM county",
  );
  await fillText('input[name="siteLink-1"]', profile.linkedinUrl, "Oracle HCM LinkedIn");

  const resumeAlreadyPresent = /profile successfully imported|resume\.pdf|resume\.doc|resume\.docx|Shadi_Jabbour_Resume/i.test(
    await page.locator("body").innerText().catch(() => ""),
  );
  const fileField = page.locator('input[type="file"]').first();
  if (!resumeAlreadyPresent && (await fileField.count().catch(() => 0)) > 0) {
    const resumePath = await resolveResumeFilePath(profile);
    mark("Oracle HCM resume upload", await uploadFile(page, fileField, resumePath));
    await page.waitForTimeout(2_500).catch(() => undefined);
  }

  const education = await runOracleHcmEducationFixes(page);
  filled.push(...education.filled);
  skipped.push(...education.skipped);

  await clickPill(/legally authorized to work/i, "Yes", "Oracle HCM work authorization");
  await clickPill(/18 years or older/i, "Yes", "Oracle HCM age confirmation");
  mark("Oracle HCM privacy acknowledgment", await checkOracleCheckboxByLabel(page, /privacy policy/i));
  mark("Oracle HCM age acknowledgment", await checkOracleCheckboxByLabel(page, /18 years/i));
  await clickPill(/How did you hear about us/i, "Job Board", "Oracle HCM source");
  await clickPill(/Please specify job board/i, "LinkedIn Jobs", "Oracle HCM source detail");
  await clickPill(/currently reside in California/i, "No", "Oracle HCM California residence");
  await clickPill(/relocate to California/i, "No", "Oracle HCM relocation");
  await fillCombo('input[name="300000154877660"][role="combobox"]', ["Technology"], "Oracle HCM industry");
  await clickPill(/require sponsorship/i, "No", "Oracle HCM sponsorship");
  await clickPill(/employment visa|visa sponsorship|immigration sponsorship/i, "No", "Oracle HCM employment visa");
  await clickPill(/right to work/i, "Yes", "Oracle HCM right to work");
  await clickPill(/willing to relocate/i, "No", "Oracle HCM relocation willingness");
  await clickPill(/previous Blue Shield/i, "No", "Oracle HCM previous employer");
  await clickPill(/related to a current employee/i, "No", "Oracle HCM related employee");
  await clickPill(/relatives?.*(?:working|employed)|currently employed by.*(?:company|business|verisk)|family member/i, "No", "Oracle HCM relatives");
  await clickPill(/ever been employed by.*(?:company|business|verisk)|previous(?:ly)? employed by.*(?:company|business|verisk)/i, "No", "Oracle HCM previous company employment");
  await clickPill(/non[- ]compete|employment agreement/i, "No", "Oracle HCM non-compete");
  await clickPill(/deloitte.*current or former employee|current or former.*deloitte/i, "No", "Oracle HCM Deloitte relationship");
  await clickPill(/contractor.*(?:company|business|verisk)|(?:company|business|verisk).*contractor/i, "No", "Oracle HCM contractor relationship");
  await clickPill(/salary expectations/i, "No", "Oracle HCM salary preference");
  await fillText(
    'textarea[name="300001693653352"]',
    "I bring hands-on software engineering, automation, cloud, and data experience across Python, TypeScript, SQL, APIs, CI/CD, and production support, with a track record of improving reliability and delivery speed.",
    "Oracle HCM qualification highlight",
  );
  mark("Oracle HCM race non-disclosure", await checkOracleCheckboxByLabel(page, /I choose not to disclose/i));
  await fillCombo('input[name="US-STANDARD-ORA_GENDER-STANDARD"][role="combobox"]', ["Decline to State"], "Oracle HCM gender");
  await clickPill(/Diversity, Equity, Inclusion and Belonging/i, /I hereby understand and acknowledge/i, "Oracle HCM DEI acknowledgment");
  await clickPill(/recorded interviews|digital communication/i, /I hereby understand and acknowledge/i, "Oracle HCM recording acknowledgment");
  await clickPill(/preferred pronouns/i, "Decline to State", "Oracle HCM pronouns");
  await clickPill(/sexual orientation/i, "Decline to State", "Oracle HCM sexual orientation");
  await clickPill(/veteran status/i, /do not wish to self-identify/i, "Oracle HCM veteran status");
  await clickPill(/military partner/i, "No", "Oracle HCM military partner");
  await fillText('input[name="fullName"], input[id^="fullName"]', profile.name, "Oracle HCM e-signature");

  if (submit) {
    const bodyText = normalizeQuestionText(await page.locator("body").innerText().catch(() => ""));
    if (/what s your email|enter your email|confirm your email/.test(bodyText)) {
      const advanced = await clickOracleVisibleButtonByText(page, /^next$/i);
      return {
        filled: dedupeText(filled),
        skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
        handled: true,
        advanced,
        submitted: false,
      };
    }

    const fullNameVisible = await page.locator('input[name="fullName"], input[id^="fullName"]').first().isVisible().catch(() => false);
    if (fullNameVisible) {
      const clickedSubmit = await clickOracleVisibleButtonByText(page, /^submit$/i);
      if (clickedSubmit) {
        await page.waitForTimeout(8_000).catch(() => undefined);
        const submittedAfterClick = await detectSiteSubmissionSuccess(page);
        return {
          filled: dedupeText(filled),
          skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
          handled: true,
          advanced: !submittedAfterClick,
          submitted: submittedAfterClick,
        };
      }
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    handled: true,
    submitted: false,
  };
}

function isMicro1ApplicationUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.hostname.toLowerCase() === "jobs.micro1.ai";
  } catch {
    return /jobs\.micro1\.ai/i.test(value);
  }
}

async function inferGithubUrl(profile: Profile): Promise<string> {
  const explicit = (process.env.JAA_GITHUB_URL || "").trim();
  if (explicit) {
    return explicit;
  }

  const resumeText = profile.resumeTextPath
    ? await readFile(profile.resumeTextPath, "utf8").catch(() => "")
    : "";
  const match = resumeText.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9-]+/i);
  if (!match) {
    return "";
  }

  const value = match[0].replace(/^https?:\/\/(?:www\.)?/i, "");
  return `https://${value}`;
}

function getMicro1StartDays(): string {
  return (process.env.JAA_MICRO1_START_DAYS || "1").trim();
}

async function getMicro1HourlyRate(page: Page): Promise<string> {
  const explicit = (process.env.JAA_MICRO1_HOURLY_RATE || "").trim();
  if (explicit) {
    return explicit;
  }

  const defaultRate = 90;
  const rawBodyText = await page.locator("body").innerText().catch(() => "");
  const rangeMatch = rawBodyText.match(/\$?\s*(\d{1,3})\s*(?:-|to)\s*\$?\s*(\d{1,3})\s*\/?\s*(?:hour|hr)\b/i);
  if (!rangeMatch) {
    return String(defaultRate);
  }

  const min = Number.parseInt(rangeMatch[1], 10);
  const max = Number.parseInt(rangeMatch[2], 10);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return String(defaultRate);
  }
  if (defaultRate < min) {
    return String(min);
  }
  if (defaultRate > max) {
    return String(max);
  }
  return String(defaultRate);
}

function getMicro1HoursPerWeek(): string {
  return (process.env.JAA_MICRO1_HOURS_PER_WEEK || "40").trim();
}

function getMicro1SkillYears(profile: Profile, questionText: string): string {
  const normalized = normalizeQuestionText(questionText);
  const explicitPython = (process.env.JAA_MICRO1_PYTHON_YEARS || "").trim();
  const explicitGo = (process.env.JAA_MICRO1_GOLANG_YEARS || process.env.JAA_MICRO1_GO_YEARS || "").trim();

  if (/\bpython\b/.test(normalized)) {
    return explicitPython || profile.yearsOfExperience || "5";
  }
  if (/\bgolang\b|\bgo lang\b|\bgo\b/.test(normalized)) {
    return explicitGo || "1";
  }

  return profile.yearsOfExperience || "5";
}

function extractMicro1QuestionTexts(normalizedBodyText: string): string[] {
  return Array.from(normalizedBodyText.matchAll(/\bq\d+\s+(.+?)(?=\s+q\d+\s+|\s+back\s+apply|\s+refer\s+and\s+earn|$)/gi))
    .map((match) => normalizeQuestionText(match[1]))
    .filter(Boolean);
}

async function getMicro1NumericQuestionAnswer(
  page: Page,
  profile: Profile,
  questionText: string,
  index: number,
): Promise<{ value: string; label: string } | null> {
  const normalized = normalizeQuestionText(questionText);
  if (/how soon|start/.test(normalized)) {
    return { value: getMicro1StartDays(), label: "micro1 start days" };
  }
  if (/hourly rate|expected.*rate|rate.*usd/.test(normalized)) {
    return { value: await getMicro1HourlyRate(page), label: "micro1 hourly rate" };
  }
  if (/hours per week|available.*work|weekly hours/.test(normalized)) {
    return { value: getMicro1HoursPerWeek(), label: "micro1 weekly hours" };
  }
  if (/years.*experience|industry experience/.test(normalized)) {
    if (/\bpython\b/.test(normalized)) {
      return { value: getMicro1SkillYears(profile, normalized), label: "micro1 Python years" };
    }
    if (/\bgolang\b|\bgo lang\b|\bgo\b/.test(normalized)) {
      return { value: getMicro1SkillYears(profile, normalized), label: "micro1 Golang years" };
    }
    return { value: getMicro1SkillYears(profile, normalized), label: `micro1 experience years ${index + 1}` };
  }

  const fallbackAnswers = [
    { value: getMicro1StartDays(), label: "micro1 start days" },
    { value: await getMicro1HourlyRate(page), label: "micro1 hourly rate" },
    { value: getMicro1HoursPerWeek(), label: "micro1 weekly hours" },
  ];
  return fallbackAnswers[index] ?? null;
}

async function runMicro1DirectAutofill(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  if (!isMicro1ApplicationUrl(page.url())) {
    return { filled: [], skipped: [] };
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  const firstName = profile.name.trim().split(/\s+/)[0] || "";
  const lastName = profile.name.trim().split(/\s+/).slice(1).join(" ");

  const fillNamedText = async (name: string, value: string, label: string): Promise<void> => {
    const field = page.locator(`input[name="${escapeCssAttributeValue(name)}"]:visible`).first();
    if (!(await field.isVisible().catch(() => false))) {
      return;
    }
    if (!value.trim()) {
      skipped.push(label);
      return;
    }
    const current = await field.inputValue().catch(() => "");
    if (matchesDesiredChoice(current, value)) {
      filled.push(label);
      return;
    }
    const applied = await replaceEditableFieldValueByTyping(page, field, value);
    if (applied) filled.push(label);
    else skipped.push(label);
  };

  await fillNamedText("first_name", firstName, "micro1 first name");
  await fillNamedText("last_name", lastName, "micro1 last name");
  await fillNamedText("email_id", profile.email, "micro1 email");
  await fillNamedText("linkedin_url", profile.linkedinUrl, "micro1 LinkedIn");

  const countryField = page.locator('select[aria-label="Phone number country"]:visible').first();
  if (await countryField.isVisible().catch(() => false)) {
    const selected = await selectNativeOption(countryField, ["United States", "US"]);
    if (selected) filled.push("micro1 phone country");
    else skipped.push("micro1 phone country");
  }

  const phoneField = page.locator('input[type="tel"]:visible').first();
  if (await phoneField.isVisible().catch(() => false)) {
    const phoneValue = `+1${profile.phone.replace(/\D/g, "").replace(/^1/, "")}`;
    const applied = await replaceEditableFieldValueByTyping(page, phoneField, phoneValue);
    if (applied) filled.push("micro1 phone");
    else skipped.push("micro1 phone");
  }

  const fileField = page.locator('input[type="file"]').first();
  if ((await fileField.count().catch(() => 0)) > 0) {
    const resumeFilePath = await resolveResumeFilePath(profile);
    const existingUpload = await fileField
      .evaluate((node) => (node as HTMLInputElement).files?.length ?? 0)
      .catch(() => 0);
    if (existingUpload > 0) {
      filled.push("micro1 resume upload");
    } else if (await uploadFile(page, fileField, resumeFilePath)) {
      filled.push("micro1 resume upload");
    } else {
      skipped.push("micro1 resume upload");
    }
  }

  const rawBodyText = await page.locator("body").innerText().catch(() => "");
  const bodyText = normalizeQuestionText(rawBodyText);
  if (/how soon can you start|expected hourly rate|hours per week/.test(bodyText)) {
    const numberInputs = page.locator('input[type="number"]:visible');
    const numberInputCount = await numberInputs.count().catch(() => 0);
    const questionTexts = extractMicro1QuestionTexts(bodyText);
    for (let index = 0; index < numberInputCount; index += 1) {
      const answer = await getMicro1NumericQuestionAnswer(page, profile, questionTexts[index] ?? "", index);
      if (!answer) {
        skipped.push(`micro1 numeric question ${index + 1}`);
        continue;
      }
      const field = numberInputs.nth(index);
      if (!(await field.isVisible().catch(() => false))) {
        skipped.push(answer.label);
        continue;
      }
      const applied = await replaceEditableFieldValueByTyping(page, field, answer.value);
      if (applied) filled.push(answer.label);
      else skipped.push(answer.label);
    }

    const textInputs = page.locator('input[type="text"]:visible:not([name])');
    const githubUrl = await inferGithubUrl(profile);
    const openSourceField = textInputs.nth(0);
    if (await openSourceField.isVisible().catch(() => false)) {
      if (githubUrl) {
        const applied = await replaceEditableFieldValueByTyping(page, openSourceField, githubUrl);
        if (applied) filled.push("micro1 open-source link");
        else skipped.push("micro1 open-source link");
      } else {
        skipped.push("micro1 open-source link");
      }
    }

    const authorizationField = textInputs.nth(1);
    if (await authorizationField.isVisible().catch(() => false)) {
      const authorization = profile.workAuthorization
        ? `${profile.workAuthorization}, authorized to work in the United States`
        : "Authorized to work in the United States";
      const applied = await replaceEditableFieldValueByTyping(page, authorizationField, authorization);
      if (applied) filled.push("micro1 work authorization");
      else skipped.push("micro1 work authorization");
    }

    const yesRadio = page.locator('input[type="radio"][id$="_yes"]:visible').first();
    if (await yesRadio.isVisible().catch(() => false)) {
      const checked = await yesRadio.isChecked().catch(() => false);
      const applied = checked || (await yesRadio.check({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
      if (applied) filled.push("micro1 contract/start confirmation");
      else skipped.push("micro1 contract/start confirmation");
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

function isHirebridgeApplicationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().includes("hirebridge.com");
  } catch {
    return /hirebridge/i.test(url);
  }
}

async function getHirebridgeControlContext(field: Locator): Promise<{
  id: string;
  name: string;
  type: string;
  value: string;
  optionText: string;
  text: string;
}> {
  return field
    .evaluate((node) => {
      const element = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const parts: string[] = [];
      const push = (value: string | null | undefined) => {
        const cleaned = (value || "").replace(/\s+/g, " ").trim();
        if (cleaned) {
          parts.push(cleaned);
        }
      };

      push(element.getAttribute("aria-label"));
      push(element.getAttribute("title"));
      push(element.getAttribute("placeholder"));
      push(element.id);
      push(element.getAttribute("name"));
      if ("labels" in element) {
        for (const label of Array.from(element.labels || [])) {
          push(label.textContent);
        }
      }

      const row = element.closest("tr");
      push(row?.textContent);
      const fieldset = element.closest("fieldset");
      push(fieldset?.textContent);
      const container = element.closest("li, p, td, div");
      push(container?.textContent);

      return {
        id: element.id || "",
        name: element.getAttribute("name") || "",
        type: element.getAttribute("type") || element.tagName.toLowerCase(),
        value: "value" in element ? String(element.value || "") : "",
        optionText: parts.slice(0, 4).join(" "),
        text: parts.join(" ").slice(0, 1000),
      };
    })
    .catch(() => ({ id: "", name: "", type: "", value: "", optionText: "", text: "" }));
}

function getHirebridgeTextAnswer(profile: Profile, contextText: string): { value: string; label: string } | null {
  const label = normalizeQuestionText(contextText);
  const nameParts = profile.name.trim().split(/\s+/);
  const first = nameParts[0] || "";
  const last = nameParts.slice(1).join(" ");

  if (/confirm.*email|verify.*email|re enter.*email|email.*confirm|email.*verify/.test(label)) {
    return { value: profile.email, label: "hirebridge confirm email" };
  }
  if (/\bemail\b|e mail/.test(label)) {
    return { value: profile.email, label: "hirebridge email" };
  }
  if (/preferred.*name/.test(label)) {
    return { value: first || profile.name, label: "hirebridge preferred name" };
  }
  if (/first.*name|given.*name/.test(label)) {
    return { value: first, label: "hirebridge first name" };
  }
  if (/last.*name|family.*name|surname/.test(label)) {
    return { value: last, label: "hirebridge last name" };
  }
  if (/linkedin|linked in/.test(label)) {
    return { value: profile.linkedinUrl, label: "hirebridge LinkedIn" };
  }
  if (/street|address line 1|address1|address 1|\baddress\b/.test(label) && !/\bemail\b/.test(label)) {
    return { value: profile.streetAddress, label: "hirebridge street address" };
  }
  if (/\bcity\b/.test(label)) {
    return { value: profile.city, label: "hirebridge city" };
  }
  if (/postal|zip/.test(label)) {
    return { value: profile.postalCode, label: "hirebridge postal code" };
  }
  if (/phone|mobile|telephone|cell/.test(label)) {
    return { value: profile.phone, label: "hirebridge phone" };
  }
  if (/salary|compensation/.test(label)) {
    return { value: "175000", label: "hirebridge desired salary" };
  }
  if (/signature|full legal name|certif.*name/.test(label)) {
    return { value: profile.name, label: "hirebridge signature" };
  }
  if (/source|where.*hear|how.*hear|where.*learn/.test(label)) {
    return { value: "LinkedIn", label: "hirebridge source" };
  }

  return null;
}

function getHirebridgeSelectValues(profile: Profile, contextText: string): { values: string[]; label: string } | null {
  const label = normalizeQuestionText(contextText);
  if (/country/.test(label)) {
    return { values: ["United States", "United States of America", "USA", "US"], label: "hirebridge country" };
  }
  if (/\bstate\b|province|region/.test(label)) {
    return { values: [expandUsStateName(profile.state), profile.state], label: "hirebridge state" };
  }
  if (/source|where.*hear|how.*hear|where.*learn/.test(label)) {
    return { values: ["LinkedIn", "LinkedIn page or job posting"], label: "hirebridge source" };
  }
  if (/gender|race|ethnicity|disability|veteran/.test(label)) {
    return {
      values: [
        "I do not want to answer",
        "I do not wish to answer",
        "Prefer not to disclose",
        "Decline to Self Identify",
        "Decline to identify",
        "Not Specified",
      ],
      label: "hirebridge voluntary disclosure",
    };
  }
  if (/current.*employee|currently.*employed|employee.*current|referr|sponsor|visa|vista|assessment|previously.*employed|worked.*for/.test(label)) {
    return { values: ["No", "N"], label: "hirebridge no answer" };
  }
  if (/eligible|authorized|legally.*work|work.*united states|work.*authorization/.test(label)) {
    return { values: ["Yes", "Y"], label: "hirebridge yes answer" };
  }

  return null;
}

function getHirebridgeChoiceValues(contextText: string): { values: string[]; label: string; checked: boolean } | null {
  const label = normalizeQuestionText(contextText);
  if (/privacy|policy|terms|acknowledge|certif|agreement|consent/.test(label)) {
    return { values: ["Yes", "Agree", "I Agree", "Acknowledge", "Accept"], label: "hirebridge acknowledgement", checked: true };
  }
  if (/gender|race|ethnicity|disability|veteran/.test(label)) {
    return {
      values: [
        "I do not want to answer",
        "I do not wish to answer",
        "Prefer not to disclose",
        "Decline to Self Identify",
        "Decline",
        "Not Specified",
      ],
      label: "hirebridge voluntary disclosure",
      checked: true,
    };
  }
  if (/current.*employee|currently.*employed|employee.*current|referr|sponsor|visa|vista|assessment|previously.*employed|worked.*for/.test(label)) {
    return { values: ["No", "N"], label: "hirebridge no answer", checked: true };
  }
  if (/eligible|authorized|legally.*work|work.*united states|work.*authorization/.test(label)) {
    return { values: ["Yes", "Y"], label: "hirebridge yes answer", checked: true };
  }

  return null;
}

async function runHirebridgeDirectAutofill(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped"> & { advanced: boolean; submitted: boolean }> {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const looksLikeHirebridge =
    isHirebridgeApplicationUrl(page.url()) || /hirebridge|quickapply|profile submission/i.test(bodyText);
  if (!looksLikeHirebridge) {
    return { filled: [], skipped: [], advanced: false, submitted: false };
  }

  if (/profile submission completed|thank you for submitting your profile|application has been submitted/i.test(bodyText)) {
    return { filled: [], skipped: [], advanced: false, submitted: true };
  }

  const filled: string[] = [];
  const skipped: string[] = [];

  const resumeFilePath = await resolveResumeFilePath(profile);
  const fileFields = page.locator('input[type="file"]');
  const fileCount = await fileFields.count().catch(() => 0);
  for (let index = 0; index < fileCount; index += 1) {
    const field = fileFields.nth(index);
    const existingUpload = await field
      .evaluate((node) => (node as HTMLInputElement).files?.length ?? 0)
      .catch(() => 0);
    if (existingUpload > 0) {
      filled.push("hirebridge resume upload");
      continue;
    }
    if (await uploadFile(page, field, resumeFilePath)) {
      filled.push("hirebridge resume upload");
    } else {
      skipped.push("hirebridge resume upload");
    }
  }

  const textFields = page.locator(
    [
      'input:visible:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])',
      "textarea:visible",
    ].join(", "),
  );
  const textCount = await textFields.count().catch(() => 0);
  for (let index = 0; index < textCount; index += 1) {
    const field = textFields.nth(index);
    if (await field.isDisabled().catch(() => true)) {
      continue;
    }
    const context = await getHirebridgeControlContext(field);
    const answer = getHirebridgeTextAnswer(profile, `${context.text} ${context.name} ${context.id}`);
    if (!answer?.value.trim()) {
      continue;
    }

    const current = await field.inputValue().catch(() => "");
    if (matchesDesiredChoice(current, answer.value)) {
      filled.push(answer.label);
      continue;
    }

    const applied = await replaceEditableFieldValueByTyping(page, field, answer.value);
    if (applied) {
      filled.push(answer.label);
    } else {
      skipped.push(answer.label);
    }
  }

  const selects = page.locator("select:visible");
  const selectCount = await selects.count().catch(() => 0);
  for (let index = 0; index < selectCount; index += 1) {
    const field = selects.nth(index);
    if (await field.isDisabled().catch(() => true)) {
      continue;
    }
    const context = await getHirebridgeControlContext(field);
    const answer = getHirebridgeSelectValues(profile, `${context.text} ${context.name} ${context.id}`);
    if (!answer) {
      continue;
    }

    const selected = await selectNativeOption(field, answer.values);
    if (selected) {
      filled.push(answer.label);
    } else {
      skipped.push(answer.label);
    }
  }

  const radios = page.locator('input[type="radio"]:visible');
  const radioCount = await radios.count().catch(() => 0);
  for (let index = 0; index < radioCount; index += 1) {
    const field = radios.nth(index);
    if (await field.isDisabled().catch(() => true)) {
      continue;
    }
    const context = await getHirebridgeControlContext(field);
    const answer = getHirebridgeChoiceValues(`${context.text} ${context.name} ${context.id}`);
    if (!answer) {
      continue;
    }
    const optionText = `${context.optionText} ${context.value}`;
    const optionMatches = answer.values.some((value) => matchesDesiredChoice(optionText, value));
    if (!optionMatches) {
      continue;
    }
    const checked = await field.isChecked().catch(() => false);
    const applied = checked || (await field.check({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
    if (applied) {
      filled.push(answer.label);
    } else {
      skipped.push(answer.label);
    }
  }

  const checkboxes = page.locator('input[type="checkbox"]:visible');
  const checkboxCount = await checkboxes.count().catch(() => 0);
  for (let index = 0; index < checkboxCount; index += 1) {
    const field = checkboxes.nth(index);
    if (await field.isDisabled().catch(() => true)) {
      continue;
    }
    const context = await getHirebridgeControlContext(field);
    const answer = getHirebridgeChoiceValues(`${context.text} ${context.name} ${context.id}`);
    if (!answer || !answer.checked) {
      continue;
    }
    const applied = await setCheckboxValue(field, "Yes");
    if (applied) {
      filled.push(answer.label);
    } else {
      skipped.push(answer.label);
    }
  }

  let advanced = false;
  const refreshedText = await page.locator("body").innerText().catch(() => "");
  const emailGate =
    /verify.*email|confirm.*email|email address/i.test(refreshedText) &&
    !/resume|quickapply|profile submission completed|voluntary/i.test(refreshedText);
  if (emailGate && filled.some((label) => /hirebridge .*email/.test(label))) {
    const action = await findVisibleAction(page, getPrimaryActionSelectors("hirebridge"));
    if (action && /next|continue/i.test(action.label)) {
      advanced = await clickActionHandle(page, action);
      if (advanced) {
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
        await page.waitForTimeout(1200).catch(() => undefined);
      }
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    advanced,
    submitted: false,
  };
}

function isDayforceApplicationUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().includes("dayforcehcm.com");
  } catch {
    return /dayforcehcm/i.test(url);
  }
}

async function fillDayforceTextById(
  page: Page,
  id: string,
  value: string,
  label: string,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const field = page.locator(`input[id="${escapeCssAttributeValue(id)}"]:visible, textarea[id="${escapeCssAttributeValue(id)}"]:visible`).first();
  if (!(await field.isVisible().catch(() => false))) {
    return { filled: [], skipped: [] };
  }
  if (!value.trim()) {
    return { filled: [], skipped: [label] };
  }
  const current = await field.inputValue().catch(() => "");
  if (matchesDesiredChoice(current, value)) {
    return { filled: [label], skipped: [] };
  }
  const applied = await replaceEditableFieldValueByTyping(page, field, value);
  return applied ? { filled: [label], skipped: [] } : { filled: [], skipped: [label] };
}

async function selectDayforceSearchById(
  page: Page,
  id: string,
  values: string[],
  label: string,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const field = page.locator(`input[id="${escapeCssAttributeValue(id)}"]:visible`).first();
  if (!(await field.isVisible().catch(() => false))) {
    return { filled: [], skipped: [] };
  }

  const current = await field.inputValue().catch(() => "");
  if (values.some((value) => matchesDesiredChoice(current, value))) {
    return { filled: [label], skipped: [] };
  }

  for (const value of values) {
    await field.click({ timeout: 5_000 }).catch(() => undefined);
    await field.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
    await field.type(value, { delay: 15 }).catch(() => undefined);
    await page.waitForTimeout(500).catch(() => undefined);

    const option = page.locator(`.ant-select-item-option:has-text("${escapeCssAttributeValue(value)}")`).first();
    const clicked =
      (await option.click({ timeout: 2_000 }).then(() => true).catch(() => false)) ||
      (await field.press("Enter").then(() => true).catch(() => false));
    await page.waitForTimeout(300).catch(() => undefined);
    if (clicked) {
      return { filled: [label], skipped: [] };
    }
  }

  return { filled: [], skipped: [label] };
}

async function runDayforceDirectAutofill(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped"> & { advanced: boolean }> {
  if (!isDayforceApplicationUrl(page.url())) {
    return { filled: [], skipped: [], advanced: false };
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  const merge = (result: Pick<AutofillPassResult, "filled" | "skipped">) => {
    filled.push(...result.filled);
    skipped.push(...result.skipped);
  };

  const privacyModalText = await page.locator("body").innerText().catch(() => "");
  if (/platform privacy policy|please review the policy below/i.test(privacyModalText)) {
    const modalCheckboxes = page.locator('.ant-modal input[type="checkbox"]:visible, input[type="checkbox"]:visible');
    const checkboxCount = await modalCheckboxes.count().catch(() => 0);
    for (let index = 0; index < checkboxCount; index += 1) {
      const checkbox = modalCheckboxes.nth(index);
      if (await setCheckboxValue(checkbox, "Yes")) {
        filled.push("dayforce privacy modal acknowledgement");
        break;
      }
    }

    const save = page.locator('.ant-modal button:has-text("Save"), button:has-text("Save")').last();
    if (await save.isVisible().catch(() => false)) {
      const saved = await save.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false);
      if (saved) {
        filled.push("dayforce privacy modal save");
        await page.waitForTimeout(1_000).catch(() => undefined);
      }
    }
  }

  const names = profile.name.trim().split(/\s+/);
  const first = names[0] || "";
  const last = names.slice(1).join(" ");
  const phone = profile.phone.replace(/\D/g, "").replace(/^1/, "");

  merge(await fillDayforceTextById(page, "jobPostingApplication_personalInfo_email", profile.email, "dayforce email"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_personalInfo_confirmEmail", profile.email, "dayforce confirm email"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_personalInfo_firstName", first, "dayforce first name"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_personalInfo_lastName", last, "dayforce last name"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_personalInfo_linkedInURL", profile.linkedinUrl, "dayforce LinkedIn"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_personalInfo_homePhone", phone, "dayforce home phone"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_personalInfo_mobilePhone", phone, "dayforce mobile phone"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_personalInfo_address1", profile.streetAddress, "dayforce address"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_personalInfo_address2", profile.addressLine2, "dayforce address 2"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_personalInfo_city", profile.city, "dayforce city"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_personalInfo_postalCode", profile.postalCode, "dayforce postal code"));

  merge(await selectDayforceSearchById(page, "jobPostingApplication_personalInfo_preferredContactMethod", ["Email"], "dayforce contact method"));
  merge(await selectDayforceSearchById(page, "jobPostingApplication_personalInfo_countryCode", ["United States", "USA"], "dayforce country"));
  merge(await selectDayforceSearchById(page, "jobPostingApplication_personalInfo_stateCode", [expandUsStateName(profile.state), profile.state], "dayforce state"));
  merge(await selectDayforceSearchById(page, "jobPostingApplication_personalInfo_candidateSource", ["LinkedIn"], "dayforce source"));

  merge(await fillDayforceTextById(page, "jobPostingApplication_educationHistory_0_degreeName", "Bachelor's Degree", "dayforce degree"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_educationHistory_0_majorName", "Computer Information Systems", "dayforce major"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_educationHistory_0_schoolName", "North Carolina State University", "dayforce school"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_educationHistory_0_city", "Raleigh", "dayforce school city"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_educationHistory_0_gpa", "3.7", "dayforce GPA"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_educationHistory_0_effectiveStart", "2017-08-01", "dayforce education start"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_educationHistory_0_effectiveEnd", "2021-05-01", "dayforce education end"));
  merge(await selectDayforceSearchById(page, "jobPostingApplication_educationHistory_0_countryCode", ["United States", "USA"], "dayforce education country"));
  merge(await selectDayforceSearchById(page, "jobPostingApplication_educationHistory_0_stateCode", ["North Carolina", "NC"], "dayforce education state"));

  merge(await fillDayforceTextById(page, "jobPostingApplication_workHistory_0_title", "Software Consultant", "dayforce work title"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_workHistory_0_companyName", "Hurdle Solutions", "dayforce work company"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_workHistory_0_effectiveStart", "2019-10-01", "dayforce work start"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_workHistory_0_city", profile.city, "dayforce work city"));
  merge(await fillDayforceTextById(page, "jobPostingApplication_workHistory_0_description", profile.resumeSummary, "dayforce work description"));
  merge(await selectDayforceSearchById(page, "jobPostingApplication_workHistory_0_countryCode", ["United States", "USA"], "dayforce work country"));
  merge(await selectDayforceSearchById(page, "jobPostingApplication_workHistory_0_stateCode", [expandUsStateName(profile.state), profile.state], "dayforce work state"));

  const currentWork = page.locator('input[id="jobPostingApplication_workHistory_0_isCurrent"]:visible').first();
  if (await currentWork.isVisible().catch(() => false)) {
    if (await setCheckboxValue(currentWork, "Yes")) filled.push("dayforce current role");
    else skipped.push("dayforce current role");
  }

  const privacy = page.locator('input[type="checkbox"]:visible').filter({ hasText: /privacy/i }).first();
  const privacyByText = page.locator('label:has-text("Privacy Statement") input[type="checkbox"], input[type="checkbox"]:near(:text("Privacy Statement"))').first();
  const privacyField = (await privacy.isVisible().catch(() => false)) ? privacy : privacyByText;
  if (await privacyField.isVisible().catch(() => false)) {
    if (await setCheckboxValue(privacyField, "Yes")) filled.push("dayforce privacy acknowledgement");
    else skipped.push("dayforce privacy acknowledgement");
  }

  let advanced = false;
  if (filled.length > 0) {
    const next = await findVisibleAction(page, ['button:has-text("Next")', 'button[aria-label*="next" i]']);
    if (next) {
      advanced = await clickActionHandle(page, next);
      if (advanced) {
        await page.waitForTimeout(1500).catch(() => undefined);
      }
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    advanced,
  };
}

async function suggestFieldValue(
  profile: Profile,
  explicitAnswers: Awaited<ReturnType<typeof loadApplicationAnswers>>,
  bank: Awaited<ReturnType<typeof loadQuestionBank>>,
  label: string,
  type: string,
  required: boolean,
  choices: string[] = [],
): Promise<string> {
  return (
    suggestFormAnswer(
      { label, type, required, choices },
      profile,
      lookupApplicationAnswer(explicitAnswers, label, type),
      "application-answers",
    )?.value ||
    suggestFormAnswer({ label, type, required, choices }, profile, lookupQuestionBankAnswer(bank, label, type, choices))
      ?.value ||
    ""
  );
}

function inferCompanyNameFromPageTitle(value: string): string {
  const cleaned = cleanRepeatedText(tidy(value));
  if (!cleaned) {
    return "";
  }

  const match = cleaned.match(/@\s+(.+)$/) || cleaned.match(/\bat\s+(.+)$/i);
  return cleanRepeatedText(match?.[1] ?? "");
}

function buildGenericInterestAnswer(company: string, profile: Profile): string {
  const companyName = cleanRepeatedText(company);
  const intro = companyName
    ? `I'm interested in ${companyName} because this role aligns with my background building production backend systems, APIs, cloud infrastructure, and developer-facing platforms.`
    : "I'm interested in this role because it aligns with my background building production backend systems, APIs, cloud infrastructure, and developer-facing platforms.";
  const summary = tidy(profile.resumeSummary);
  const outro =
    "I'm looking for a remote team where I can contribute quickly, own implementation end to end, and ship durable systems with clear product value.";

  return tidy([intro, summary, outro].filter(Boolean).join(" ")).slice(0, 1200);
}

type CloseBuildWithUsVerification = {
  id: string;
  method: string;
};

let closeBuildWithUsVerificationPromise: Promise<CloseBuildWithUsVerification | null> | null = null;

async function solveCloseBuildWithUsVerification(): Promise<CloseBuildWithUsVerification | null> {
  if (!closeBuildWithUsVerificationPromise) {
    closeBuildWithUsVerificationPromise = solveCloseBuildWithUsVerificationOnce();
  }

  return closeBuildWithUsVerificationPromise;
}

async function solveCloseBuildWithUsVerificationOnce(): Promise<CloseBuildWithUsVerification | null> {
  const script = String.raw`
import hashlib
import json
import re
import urllib.request

url = "https://api.close.com/buildwithus/"
with urllib.request.urlopen(url, timeout=15) as response:
    challenge = json.loads(response.read().decode("utf-8"))

traits = challenge["traits"]
key = challenge["key"].encode("utf-8")
payload = [
    hashlib.blake2b(trait.encode("utf-8"), digest_size=64, key=key).hexdigest()
    for trait in traits
]
request = urllib.request.Request(
    url,
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=15) as response:
    text = response.read().decode("utf-8")

match = re.search(r"Verification ID:\s*([^\s]+)", text)
print(json.dumps({"id": match.group(1) if match else "", "response": text, "key": challenge["key"]}))
`.trim();

  const runners: Array<[string, string[]]> = [
    ["python", ["-c", script]],
    ["py", ["-3", "-c", script]],
  ];

  for (const [command, args] of runners) {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout: 30000 });
      const parsed = JSON.parse(stdout.trim()) as { id?: string; response?: string; key?: string };
      const id = tidy(parsed.id);
      if (!id) {
        continue;
      }

      return {
        id,
        method: `Used Python hashlib.blake2b with digest_size=64 and key=b"${tidy(
          parsed.key,
        )}" for each provided trait, encoded as UTF-8, then POSTed the bare JSON array of lowercase hex digests back to https://api.close.com/buildwithus/.`,
      };
    } catch {
      continue;
    }
  }

  return null;
}

async function resolveAshbySpecialTextAnswer(label: string, companyName: string): Promise<string> {
  const normalized = normalizeQuestionText(label);
  const normalizedCompany = normalizeQuestionText(companyName);
  const isCloseBuildWithUsPrompt =
    normalized.includes("api close com buildwithus") ||
    (normalizedCompany === "close" && normalized.includes("get the id"));

  if (!isCloseBuildWithUsPrompt) {
    return "";
  }

  const verification = await solveCloseBuildWithUsVerification();
  if (!verification) {
    return "";
  }

  if (normalized.includes("verification id")) {
    return verification.id;
  }

  if (
    normalized.includes("code scripting") ||
    normalized.includes("techniques you used") ||
    normalized.includes("prompts") ||
    normalized.includes("get the id")
  ) {
    return verification.method;
  }

  return "";
}

async function waitAfterLocatorAction(locator: Locator, timeoutMs = 150): Promise<void> {
  await locator
    .evaluate(
      (_node, delay) =>
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, delay);
        }),
      timeoutMs,
    )
    .catch(() => undefined);
}

async function isActiveChoiceButton(button: Locator): Promise<boolean> {
  return button
    .evaluate((node) => {
      const element = node as HTMLElement;
      const className = `${element.className || ""}`;
      return (
        className.includes("_active") ||
        element.getAttribute("aria-pressed") === "true" ||
        element.getAttribute("aria-checked") === "true"
      );
    })
    .catch(() => false);
}

async function visibleButtonByExactText(scope: LocatorScope, value: string): Promise<Locator | null> {
  const buttons = scope.locator("button");
  const count = await buttons.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const visible = await button.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const text = tidy(await button.textContent().catch(() => ""));
    if (!matchesDesiredChoice(text, value)) {
      continue;
    }

    return button;
  }

  return null;
}

async function clickBinaryChoiceButton(scope: LocatorScope, value: string): Promise<boolean> {
  const normalized = normalizeQuestionText(value);
  if (normalized !== "yes" && normalized !== "no") {
    return false;
  }

  const desired = normalized === "yes" ? "Yes" : "No";
  const opposite = normalized === "yes" ? "No" : "Yes";
  const desiredButton = await visibleButtonByExactText(scope, desired);
  const oppositeButton = await visibleButtonByExactText(scope, opposite);
  if (!desiredButton || !oppositeButton) {
    return false;
  }

  // Ashby yes/no controls can be visually active while React state is still blank after a DOM-only repair.
  // Toggle through the opposite value so the component emits a real state transition before submit.
  await oppositeButton.click({ timeout: 5000 }).catch(() => false);
  await waitAfterLocatorAction(oppositeButton, 200);
  const clicked =
    (await desiredButton.click({ timeout: 5000 }).then(() => true).catch(() => false)) ||
    (await desiredButton.click({ timeout: 5000, force: true }).then(() => true).catch(() => false));
  await waitAfterLocatorAction(desiredButton, 300);
  if (!clicked) {
    return false;
  }

  const active = await isActiveChoiceButton(desiredButton);
  if (active) {
    return true;
  }

  const siblingHasActiveState = await desiredButton
    .evaluate((node) => {
      const parent = (node as HTMLElement).parentElement;
      return Array.from(parent?.querySelectorAll("button") ?? []).some((button) => {
        const element = button as HTMLElement;
        const className = `${element.className || ""}`;
        return (
          className.includes("_active") ||
          element.getAttribute("aria-pressed") === "true" ||
          element.getAttribute("aria-checked") === "true"
        );
      });
    })
    .catch(() => false);
  return !siblingHasActiveState;
}

async function clickVisibleButtonByText(scope: LocatorScope, value: string): Promise<boolean> {
  const binaryApplied = await clickBinaryChoiceButton(scope, value);
  if (binaryApplied) {
    return true;
  }

  const button = await visibleButtonByExactText(scope, value);
  if (!button) {
    return false;
  }

  const clicked =
    (await button.click({ timeout: 5000 }).then(() => true).catch(() => false)) ||
    (await button.click({ timeout: 5000, force: true }).then(() => true).catch(() => false));
  if (!clicked) {
    return false;
  }

  await waitAfterLocatorAction(button);
  return true;
}

function shouldOverwriteExistingAshbyValue(label: string, currentValue: string, desiredValue: string): boolean {
  const normalizedLabel = normalizeQuestionText(label);
  const normalizedCurrent = normalizeQuestionText(currentValue);
  const normalizedDesired = normalizeQuestionText(desiredValue);
  if (!normalizedCurrent || !normalizedDesired) {
    return false;
  }

  if (/^(n a|na|none|unknown)$/.test(normalizedCurrent)) {
    return !/(not applicable|if not applicable|enter n a|enter na)/.test(normalizedLabel);
  }

  if (/^(name|full name|legal name)$/.test(normalizedLabel)) {
    return !matchesDesiredChoice(currentValue, desiredValue);
  }

  if (/(linkedin|linkedln|linked in|github|git link|website|portfolio)/.test(normalizedLabel)) {
    return !matchesDesiredChoice(currentValue, desiredValue);
  }

  if (/\blocation\b|where are you located|country state or city/.test(normalizedLabel)) {
    return !matchesDesiredChoice(currentValue, desiredValue);
  }

  if (/phone/.test(normalizedLabel)) {
    return !/\d{3}.*\d{3}.*\d{4}/.test(currentValue);
  }

  if (/programming languages|server side|backend languages/.test(normalizedLabel)) {
    return !/(python|javascript|typescript|node|java|sql)/.test(normalizedCurrent);
  }

  return false;
}

async function fillAshbyEntryTextFields(
  page: Page,
  entry: Locator,
  label: string,
  profile: Profile,
  explicitAnswers: Awaited<ReturnType<typeof loadApplicationAnswers>>,
  bank: Awaited<ReturnType<typeof loadQuestionBank>>,
  companyName: string,
  genericInterestAnswer: string,
  github: string,
  website: string,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const fields = entry.locator(
    'input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]), textarea, select, [role="combobox"]',
  );
  const fieldCount = await fields.count().catch(() => 0);
  for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
    const field = fields.nth(fieldIndex);
    const question = await describeVisibleField(field);
    if (!question) {
      continue;
    }

    const displayLabel =
      question.label === "Unlabeled field" ||
      question.label === "Type here..." ||
      question.label === "hello@example.com..." ||
      question.label === "Start typing..."
        ? label
        : label || question.label;
    const specialValue = await resolveAshbySpecialTextAnswer(displayLabel, companyName);
    const desiredValue =
      specialValue ||
      (/git link|github/i.test(displayLabel)
        ? github
        : /linked\s*in|linkedin|linkedln/i.test(displayLabel)
          ? profile.linkedinUrl
          : /website|portfolio/i.test(displayLabel) && website
            ? website
            : /how did you hear/i.test(displayLabel)
              ? lookupApplicationAnswer(explicitAnswers, displayLabel, question.type) || "LinkedIn"
              : /what interests you/i.test(displayLabel)
                ? lookupApplicationAnswer(explicitAnswers, displayLabel, question.type) || genericInterestAnswer
                : await suggestFieldValue(
                    profile,
                    explicitAnswers,
                    bank,
                    displayLabel,
                    question.type,
                    question.required,
                    question.choices,
                  ));
    if (!desiredValue) {
      skipped.push(displayLabel);
      continue;
    }

    const currentValue = await readFieldCurrentValue(field, question.tag, question.type);
    if (isMeaningfulValue(currentValue) && !shouldOverwriteExistingAshbyValue(displayLabel, currentValue, desiredValue)) {
      if (question.tag === "input" || question.tag === "textarea") {
        await syncEditableFieldValue(page, field, question.tag, currentValue);
      }
      filled.push(displayLabel);
      continue;
    }

    const applied = await setEditableFieldValue(page, field, question.tag, desiredValue);
    if (applied) {
      filled.push(displayLabel);
    } else {
      skipped.push(displayLabel);
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((fieldLabel) => !filled.includes(fieldLabel))),
  };
}

async function completeAshbyPrerequisiteIfNeeded(entry: Locator, profile: Profile): Promise<boolean> {
  const entryText = tidy(await entry.textContent().catch(() => ""));
  if (!/shipit\.kovocredit\.com\/api\/apply/i.test(entryText)) {
    return false;
  }

  const posted = await fetch("https://shipit.kovocredit.com/api/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: profile.name,
      linkedin: profile.linkedinUrl,
    }),
  })
    .then((response) => response.ok)
    .catch(() => false);
  const checked = await entry
    .locator('input[type="checkbox"][name="Done"]')
    .first()
    .evaluate((node) => {
      const input = node as HTMLInputElement;
      if (!input.checked) {
        input.click();
      }
      return true;
    })
    .catch(() => false);
  const clicked = await clickVisibleButtonByText(entry, "Done");
  return posted || checked || clicked;
}

function inferAshbyChoiceAnswer(label: string, choices: string[]): string {
  const normalized = normalizeQuestionText(label);
  const choose = (pattern: RegExp) => choices.find((choice) => pattern.test(choice)) || "";
  const yes = () => choose(/^yes$/i) || choose(/\byes\b/i);
  const no = () => choose(/^no$/i) || choose(/\bno\b/i);

  if (/sponsorship|immigration support|employment visa|work visa/.test(normalized)) return no();
  if (/authorized to work|legally authorized|legally able to work|right to work/.test(normalized)) return yes();
  if (/certify|attest|true complete and accurate|complete and accurate|information provided/.test(normalized)) return yes();
  if (/reviewed.*compensation range|acknowledge.*compensation range|compensation range/.test(normalized)) return yes();
  if (/bay area.*relocat|relocat.*bay area|located in the bay area/.test(normalized)) return no();
  if (/currently based in austin|currently based in .*tx|currently based in .*california|currently based in .*new york|currently based in .*san francisco/.test(normalized)) return no();
  if (/involuntarily terminated|fired/.test(normalized)) return no();
  if (/open to relocation|work from.*office|onsite/.test(normalized)) return choose(/remote/i) || no();
  if (/text message|sms/.test(normalized)) return no();
  if (/background check/.test(normalized)) return yes();
  if (/project based delivery|client needs|project availability|comfortable proceeding/.test(normalized)) return yes();
  if (/ever worked at|previously worked|employee or contractor/.test(normalized)) return no();
  if (/current.*user|existing.*user|are you.*user|customer of|use .*product|clubhouse user/.test(normalized)) return no();
  if (/processing.*personal information|privacy.*application|collecting.*personal information/.test(normalized)) return yes();
  if (/available.*est|available.*pst|est or pst/.test(normalized)) return yes();
  if (/fluent.*english|english.*fluent/.test(normalized)) return yes();
  if (/english.*comfortable|comfortable.*english|writing and speaking in english/.test(normalized)) {
    return choose(/very comfortable/i) || choose(/proficient/i) || yes();
  }
  if (/skill level.*kubernetes|kubernetes.*skill level/.test(normalized)) {
    return choose(/^advanced$/i) || choose(/\badvanced\b/i) || choose(/^expert$/i);
  }
  if (/skill level.*observabil|observabil.*skill level/.test(normalized)) {
    return choose(/^advanced$/i) || choose(/\badvanced\b/i) || choose(/^expert$/i);
  }
  if (/skill level.*opentelemetry|opentelemetry.*skill level/.test(normalized)) {
    return choose(/^beginner$/i) || choose(/\bbeginner\b/i) || choose(/^advanced$/i);
  }
  if (/preferred method of communication/.test(normalized)) return choose(/^email$/i) || choose(/\bemail\b/i);
  if (/pronouns|gender identity/.test(normalized)) return choose(/prefer not|decline|not disclose/i);
  if (/credentialed with rula/.test(normalized)) return no();
  if (/ai native development tools|llm based cli agents/.test(normalized)) return choose(/^4\b|advanced/i);
  if (/experience with ai systems in production/.test(normalized)) return choose(/experimented|prototype|poc|side project/i);
  if (/rag or llm based systems/.test(normalized)) return choose(/built a basic version|simple retrieval/i);

  return "";
}

async function forceAshbyYesNoChoices(scope: LocatorScope): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const entries = scope.locator(
    '.ashby-application-form-field-entry, [class*="ashby-application-form-field-entry"], [class*="_fieldEntry_"]',
  );
  const count = await entries.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const entry = entries.nth(index);
    const label = cleanExtractedLabel(
      tidy(
        await entry
          .locator('label, .ashby-application-form-question-title, [class*="question-title"], [class*="questionTitle"]')
          .first()
          .textContent()
          .catch(() => ""),
      ),
    );
    if (!label) {
      continue;
    }

    const choices = dedupeText(
      await entry.locator("button, label").evaluateAll((nodes) =>
        nodes.map((node) => (node.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean),
      ),
    ).filter((choice) => /^(yes|no)$/i.test(choice));
    if (!choices.some((choice) => /^yes$/i.test(choice)) || !choices.some((choice) => /^no$/i.test(choice))) {
      continue;
    }

    const desiredValue = inferAshbyChoiceAnswer(label, choices);
    if (!/^(yes|no)$/i.test(desiredValue)) {
      continue;
    }

    const applied =
      (await clickVisibleButtonByText(entry, desiredValue).catch(() => false)) ||
      (await clickRadioChoice(entry, desiredValue).catch(() => false));

    if (applied) {
      filled.push(label);
    } else {
      skipped.push(label);
    }
  }

  const fallbackChoices = await scope
    .locator('input[type="radio"]')
    .evaluateAll((nodes) => {
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const normalize = (value: string) => read(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const labelFor = (input: HTMLInputElement) => {
        const id = input.getAttribute("id") || "";
        const direct = id ? read(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) : "";
        const wrapped = read(input.closest("label")?.textContent);
        const nearby = [input.parentElement, input.parentElement?.parentElement]
          .map((node) => read(node?.textContent))
          .find((text) => text && text.length <= 80);
        return direct || wrapped || nearby || "";
      };

      const groups = new Map<
        string,
        Array<{ id: string; label: string; checked: boolean; input: HTMLInputElement }>
      >();
      for (const node of nodes) {
        const input = node as HTMLInputElement;
        if (!visible(input)) continue;
        const name = input.getAttribute("name") || input.getAttribute("id") || "";
        const id = input.getAttribute("id") || "";
        const label = labelFor(input);
        if (!name || !id || !label) continue;
        const group = groups.get(name) || [];
        group.push({ id, label, checked: input.checked, input });
        groups.set(name, group);
      }

      const actions: Array<{ id: string; label: string }> = [];
      for (const group of groups.values()) {
        if (group.some((entry) => entry.checked)) continue;
        const yesNoChoices = group
          .map((entry) => entry.label)
          .filter((label) => /^(yes|no)$/i.test(label));
        if (!yesNoChoices.some((choice) => /^yes$/i.test(choice)) || !yesNoChoices.some((choice) => /^no$/i.test(choice))) {
          continue;
        }

        let context = "";
        for (const entry of group) {
          let current: HTMLElement | null = entry.input.parentElement;
          for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
            const text = read(current.textContent);
            const normalizedText = normalize(text);
            if (
              text.length > 20 &&
              text.length < 1800 &&
              /sponsorship|immigration support|employment visa|work visa|authorized to work|legally authorized|right to work|certify|attest|privacy|compensation range/.test(
                normalizedText,
              ) &&
              yesNoChoices.every((choice) => normalizedText.includes(normalize(choice)))
            ) {
              context = text;
              break;
            }
          }
          if (context) break;
        }
        if (!context) continue;

        const normalizedContext = normalize(context);
        const desiredValue = /sponsorship|immigration support|employment visa|work visa/.test(normalizedContext)
          ? "no"
          : /authorized to work|legally authorized|right to work|certify|attest|privacy|compensation range/.test(
                normalizedContext,
              )
            ? "yes"
            : "";
        if (!desiredValue) continue;

        const match = group.find((entry) => normalize(entry.label) === desiredValue);
        if (match) {
          actions.push({ id: match.id, label: `Ashby ${desiredValue} radio` });
        }
      }

      return actions;
    })
    .catch(() => [] as Array<{ id: string; label: string }>);

  for (const choice of fallbackChoices) {
    const radio = scope.locator(`[id="${escapeAttributeValue(choice.id)}"]`).first();
    const applied =
      (await radio.check({ timeout: 3000, force: true }).then(() => true).catch(() => false)) ||
      (await radio.click({ timeout: 3000, force: true }).then(() => true).catch(() => false));
    if (applied && (await radio.isChecked().catch(() => false))) {
      filled.push(choice.label);
    } else {
      skipped.push(choice.label);
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function runAshbyDirectAutofill(
  page: Page,
  scope: LocatorScope,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const explicitAnswers = await loadApplicationAnswers();
  const bank = await loadQuestionBank();
  const filled: string[] = [];
  const skipped: string[] = [];
  const github =
    lookupApplicationAnswer(explicitAnswers, "github", "text") ||
    lookupApplicationAnswer(explicitAnswers, "git link", "text") ||
    "";
  const website =
    lookupApplicationAnswer(explicitAnswers, "website", "text") ||
    lookupApplicationAnswer(explicitAnswers, "portfolio", "text") ||
    "";
  const companyName = inferCompanyNameFromPageTitle(await page.title());
  const genericInterestAnswer = buildGenericInterestAnswer(companyName, profile);
  const entries = scope.locator(
    '.ashby-application-form-field-entry, [class*="ashby-application-form-field-entry"], [class*="_fieldEntry_"]',
  );
  const count = await entries.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const entry = entries.nth(index);
    const visible = await entry.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    if (await completeAshbyPrerequisiteIfNeeded(entry, profile)) {
      filled.push("Kovo prerequisite");
    }

    const label = cleanExtractedLabel(
      tidy(
        await entry
          .locator('label, .ashby-application-form-question-title, [class*="question-title"], [class*="questionTitle"]')
          .first()
          .textContent()
          .catch(() => ""),
      ),
    );
    if (!label) {
      continue;
    }

    const textFields = await fillAshbyEntryTextFields(
      page,
      entry,
      label,
      profile,
      explicitAnswers,
      bank,
      companyName,
      genericInterestAnswer,
      github,
      website,
    );
    filled.push(...textFields.filled);
    skipped.push(...textFields.skipped);

    const buttonTexts = dedupeText(
      await entry.locator("button").evaluateAll((nodes) =>
        nodes
          .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean),
      ),
    ).filter((text) => !/upload file|choose file|submit application|apply(?: for this job)?|continue|review/i.test(text));
    if (buttonTexts.length >= 2 && buttonTexts.length <= 5) {
      const desiredValue =
        inferAshbyChoiceAnswer(label, buttonTexts) ||
        (await suggestFieldValue(profile, explicitAnswers, bank, label, "radio", await hasRequiredMarker(entry), buttonTexts));

      if (!desiredValue) {
        skipped.push(label);
        continue;
      }

      const applied = await clickVisibleButtonByText(entry, desiredValue);
      if (applied) {
        await page.waitForTimeout(500).catch(() => undefined);
      }
      if (applied) {
        filled.push(label);
      } else {
        skipped.push(label);
      }
      continue;
    }

    const radios = entry.locator('input[type="radio"], [role="radio"]');
    if ((await radios.count().catch(() => 0)) >= 2) {
      const rawChoices = dedupeText(
        await entry.locator("label").evaluateAll((nodes) =>
          nodes
            .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
            .filter(Boolean),
        ),
      );
      const optionOnlyChoices = rawChoices.filter((choice) =>
        /^(yes|no|email|phone call|text message|open to remote work|open to hybrid|open to .*onsite)$/i.test(choice),
      );
      const choices = optionOnlyChoices.length >= 2 ? optionOnlyChoices : rawChoices;
      const desiredValue =
        inferAshbyChoiceAnswer(label, choices) ||
        (await suggestFieldValue(profile, explicitAnswers, bank, label, "radio", await hasRequiredMarker(entry), choices));
      if (!desiredValue) {
        skipped.push(label);
        continue;
      }

      const applied = await clickRadioChoice(entry, desiredValue);
      if (applied) {
        filled.push(label);
      } else {
        skipped.push(label);
      }
      continue;
    }

    const checkboxes = entry.locator('input[type="checkbox"], [role="checkbox"]');
    if ((await checkboxes.count().catch(() => 0)) >= 1) {
      const choices = dedupeText(
        await entry.locator("label").evaluateAll((nodes) =>
          nodes
            .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
            .filter(Boolean),
        ),
      ).filter((choice) => !/^(yes|no)$/i.test(choice));
      if (choices.length > 0) {
        const desiredValue =
          inferAshbyChoiceAnswer(label, choices) ||
          (await suggestFieldValue(profile, explicitAnswers, bank, label, "checkbox", await hasRequiredMarker(entry), choices));
        if (desiredValue) {
          const applied = await clickCheckboxChoice(entry, desiredValue);
          if (applied) {
            filled.push(label);
          } else {
            skipped.push(label);
          }
          continue;
        }
      }
    }

    const fields = entry.locator(
      'input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]), textarea, select, [role="combobox"]',
    );
    const fieldCount = await fields.count().catch(() => 0);
    for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
      const field = fields.nth(fieldIndex);
      const question = await describeVisibleField(field);
      if (!question) {
        continue;
      }

      const displayLabel =
        question.label === "Unlabeled field" ||
        question.label === "Type here..." ||
        question.label === "hello@example.com..." ||
        question.label === "Start typing..."
          ? label
          : label || question.label;
      const specialValue = await resolveAshbySpecialTextAnswer(displayLabel, companyName);
      const desiredValue =
        specialValue ||
        (/git link|github/i.test(displayLabel)
          ? github
          : /linked\s*in|linkedin|linkedln/i.test(displayLabel)
            ? profile.linkedinUrl
            : /website|portfolio/i.test(displayLabel) && website
              ? website
              : /how did you hear/i.test(displayLabel)
                ? lookupApplicationAnswer(explicitAnswers, displayLabel, question.type) || "LinkedIn"
                : /what interests you/i.test(displayLabel)
                  ? lookupApplicationAnswer(explicitAnswers, displayLabel, question.type) || genericInterestAnswer
                  : await suggestFieldValue(
                      profile,
                      explicitAnswers,
                      bank,
                      displayLabel,
                      question.type,
                      question.required,
                      question.choices,
                    ));
      if (!desiredValue) {
        skipped.push(displayLabel);
        continue;
      }

      const currentValue = await readFieldCurrentValue(field, question.tag, question.type);
      if (isMeaningfulValue(currentValue) && !shouldOverwriteExistingAshbyValue(displayLabel, currentValue, desiredValue)) {
        if (question.tag === "input" || question.tag === "textarea") {
          await syncEditableFieldValue(page, field, question.tag, currentValue);
        }
        filled.push(displayLabel);
        continue;
      }

      const applied = await setEditableFieldValue(page, field, question.tag, desiredValue);
      if (applied) {
        filled.push(displayLabel);
      } else {
        skipped.push(displayLabel);
      }
    }
  }

  const forcedChoices = await forceAshbyYesNoChoices(scope);
  filled.push(...forcedChoices.filled);
  skipped.push(...forcedChoices.skipped);

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function extractLinkedInQuestionText(field: Locator, ignoredTexts: string[] = []): Promise<string> {
  return cleanExtractedLabel(
    tidy(
      await field
        .evaluate((node, ignored) => {
          const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
          const ignoredValues = Array.isArray(ignored)
            ? ignored.map((value) => read(typeof value === "string" ? value : "")).filter(Boolean)
            : [];
          const containers = [
            node.closest(".jobs-easy-apply-form-section__grouping"),
            node.closest(".fb-dash-form-element"),
            node.closest("fieldset"),
            node.closest("label"),
            node.parentElement,
          ].filter(Boolean) as HTMLElement[];

          for (const container of containers) {
            let text = read(container.textContent);
            if (!text) {
              continue;
            }

            for (const ignoredValue of ignoredValues) {
              if (ignoredValue) {
                text = text.split(ignoredValue).join(" ");
              }
            }

            text = text
              .replace(/\b(required|yes|no|select an option|back|next|review|submit)\b/gi, " ")
              .replace(/\s+/g, " ")
              .trim();
            if (text) {
              return text;
            }
          }

          return "";
        }, ignoredTexts)
        .catch(() => ""),
    ),
  );
}

async function runLinkedInDirectAutofill(
  page: Page,
  scope: LocatorScope,
  profile: Profile,
): Promise<AutofillPassResult> {
  const explicitAnswers = await loadApplicationAnswers();
  const bank = await loadQuestionBank();
  const filled: string[] = [];
  const skipped: string[] = [];

  const groups = scope.locator("fieldset");
  const groupCount = await groups.count().catch(() => 0);
  for (let index = 0; index < groupCount; index += 1) {
    const group = groups.nth(index);
    if (!(await group.isVisible().catch(() => false))) {
      continue;
    }

    const radioCount = await group.locator('input[type="radio"], [role="radio"]').count().catch(() => 0);
    if (radioCount < 2) {
      continue;
    }

    const choices = dedupeText(
      await group.locator("label").evaluateAll((nodes) =>
        nodes
          .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean),
      ),
    );
    const label = (await extractLinkedInQuestionText(group, choices)) || "LinkedIn radio question";
    const alreadySelected =
      (await group.locator('input[type="radio"]:checked').count().catch(() => 0)) > 0 ||
      (await group.locator('[aria-checked="true"]').count().catch(() => 0)) > 0;
    if (alreadySelected) {
      filled.push(label);
      continue;
    }

    const desiredValue = await suggestFieldValue(
      profile,
      explicitAnswers,
      bank,
      label,
      "radio",
      await hasRequiredMarker(group),
      choices,
    );
    if (!desiredValue) {
      skipped.push(label);
      continue;
    }

    const applied = await clickRadioChoice(group, desiredValue);
    if (applied) {
      filled.push(label);
    } else {
      skipped.push(label);
    }
  }

  const fields = scope.locator('select, input[type="text"], input[type="number"], input[role="combobox"], textarea');
  const fieldCount = await fields.count().catch(() => 0);
  for (let index = 0; index < fieldCount; index += 1) {
    const field = fields.nth(index);
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }

    const question = await describeVisibleField(field);
    if (!question || ["file", "hidden", "radio", "password", "submit", "button"].includes(question.type)) {
      continue;
    }

    const label =
      (await extractLinkedInQuestionText(field, question.choices)) ||
      (question.label === "Unlabeled field" ? "" : question.label) ||
      "LinkedIn field";
    const desiredValue = await suggestFieldValue(
      profile,
      explicitAnswers,
      bank,
      label,
      question.type,
      question.required,
      question.choices,
    );
    if (!desiredValue) {
      const currentValue = await readFieldCurrentValue(field, question.tag, question.type);
      if (isMeaningfulValue(currentValue)) {
        filled.push(label);
        continue;
      }
      skipped.push(label);
      continue;
    }

    const currentValue = await readFieldCurrentValue(field, question.tag, question.type);
    if (isMeaningfulValue(currentValue) && !shouldOverrideLinkedInPrefilledValue(label, currentValue, desiredValue)) {
      filled.push(label);
      continue;
    }

    const applied = await setEditableFieldValue(page, field, question.tag, desiredValue);
    if (applied) {
      filled.push(label);
    } else {
      skipped.push(label);
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    decisions: [],
  };
}

async function fillLinkedInGreenhouseTextQuestion(
  form: Locator,
  labelPattern: RegExp,
  value: string,
): Promise<boolean> {
  const fields = form.locator('input[type="text"]:visible, textarea:visible');
  const count = await fields.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const field = fields.nth(index);
    const containerText = normalizeQuestionText(
      await field
        .evaluate((node) => {
          const container =
            node.closest(".jobs-easy-apply-form-element") ||
            node.closest("[data-test-form-element]") ||
            node.closest("div");
          return (container?.textContent || "").replace(/\s+/g, " ").trim();
        })
        .catch(() => ""),
    );
    if (!labelPattern.test(containerText)) {
      continue;
    }

    const currentValue = await field.inputValue().catch(() => "");
    if (isMeaningfulValue(currentValue)) {
      return true;
    }

    await field.fill(value).catch(() => undefined);
    return isMeaningfulValue(await field.inputValue().catch(() => ""));
  }

  return false;
}

async function clickLinkedInGreenhouseRadioQuestion(
  form: Locator,
  labelPattern: RegExp,
  desiredValue: "true" | "false",
): Promise<boolean> {
  const groups = form.locator("fieldset");
  const count = await groups.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const group = groups.nth(index);
    const groupText = normalizeQuestionText(await group.innerText().catch(() => ""));
    if (!labelPattern.test(groupText)) {
      continue;
    }

    const selected = await group
      .locator(`input[type="radio"][value="${desiredValue}"]:checked`)
      .count()
      .then((selectedCount) => selectedCount > 0)
      .catch(() => false);
    if (selected) {
      return true;
    }

    await group.locator(`input[type="radio"][value="${desiredValue}"]`).first().click({ force: true }).catch(() => undefined);
    return group
      .locator(`input[type="radio"][value="${desiredValue}"]:checked`)
      .count()
      .then((selectedCount) => selectedCount > 0)
      .catch(() => false);
  }

  return false;
}

async function runLinkedInGreenhouseFallbackAutofill(
  page: Page,
  scope: LocatorScope,
  profile: Profile,
): Promise<AutofillPassResult> {
  const form = scope.locator("form").last();
  const formText = normalizeQuestionText(await form.innerText().catch(() => ""));
  if (!formText || !/application powered by greenhouse|additional questions/.test(formText)) {
    return { filled: [], skipped: [], decisions: [] };
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  const add = (applied: boolean, label: string) => (applied ? filled : skipped).push(label);
  const preferredFirstName = profile.name.split(/\s+/)[0] || profile.name;

  add(await fillLinkedInGreenhouseTextQuestion(form, /linkedin profile|linkedin url/, profile.linkedinUrl), "LinkedIn profile");
  add(await fillLinkedInGreenhouseTextQuestion(form, /\bwebsite\b|portfolio|personal site/, "https://shjabbour.github.io/"), "website");
  add(await fillLinkedInGreenhouseTextQuestion(form, /full legal name|legal name|presented on your id/, profile.name), "legal name");
  add(await fillLinkedInGreenhouseTextQuestion(form, /preferred first name|preferred name/, preferredFirstName), "preferred name");
  add(await fillLinkedInGreenhouseTextQuestion(form, /referred by|referral|employee.*full name/, "N/A"), "referral");
  add(await fillLinkedInGreenhouseTextQuestion(form, /type real|real person/, "Real"), "human check");
  add(await clickLinkedInGreenhouseRadioQuestion(form, /eligible to work|authorized to work|legally.*work/, "true"), "work eligibility");
  add(await clickLinkedInGreenhouseRadioQuestion(form, /require sponsorship|future.*sponsorship/, "false"), "sponsorship");
  add(await clickLinkedInGreenhouseRadioQuestion(form, /recruiting sms|sms messages|text messages/, "false"), "SMS consent");

  const visaSelect = form.locator("select:visible").first();
  if (await visaSelect.isVisible().catch(() => false)) {
    await visaSelect.selectOption("NA").catch(() => undefined);
    add(/^NA$/i.test(await visaSelect.inputValue().catch(() => "")), "visa type");
  }

  await page.waitForTimeout(300).catch(() => undefined);
  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    decisions: [],
  };
}

async function runLeverDirectAutofill(
  page: Page,
  scope: LocatorScope,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const explicitAnswers = await loadApplicationAnswers();
  const bank = await loadQuestionBank();
  const filled: string[] = [];
  const skipped: string[] = [];
  const website =
    lookupApplicationAnswer(explicitAnswers, "website", "text") ||
    lookupApplicationAnswer(explicitAnswers, "portfolio", "text") ||
    "";
  const directFields: Array<{ name: string; selector: string; value: string }> = [
    { name: "full name", selector: 'input[name="name"]', value: profile.name },
    { name: "email", selector: 'input[name="email"]', value: profile.email },
    { name: "phone", selector: 'input[name="phone"]', value: profile.phone },
    { name: "location", selector: 'input[name="location"]', value: profile.location },
    {
      name: "org",
      selector: 'input[name="org"]',
      value: lookupApplicationAnswer(explicitAnswers, "current company", "text") || "",
    },
    { name: "linkedin", selector: 'input[name="urls[LinkedIn]"]', value: profile.linkedinUrl },
    {
      name: "github",
      selector: 'input[name="urls[GitHub]"]',
      value: lookupApplicationAnswer(explicitAnswers, "github", "text") || "",
    },
    {
      name: "portfolio",
      selector: 'input[name="urls[Portfolio]"]',
      value: lookupApplicationAnswer(explicitAnswers, "portfolio", "text") || website,
    },
    { name: "website", selector: 'input[name="urls[Other]"]', value: website },
  ];

  for (const action of directFields) {
    const field = scope.locator(action.selector).first();
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }

    if (!action.value.trim()) {
      skipped.push(action.name);
      continue;
    }

    const currentValue = await field.inputValue().catch(() => "");
    if (isMeaningfulValue(currentValue)) {
      filled.push(action.name);
      continue;
    }

    const applied = await setEditableFieldValue(page, field, "input", action.value);
    if (applied) {
      filled.push(action.name);
    } else {
      skipped.push(action.name);
    }
  }

  const selectFields = scope.locator('select[name^="eeo["]');
  const selectCount = await selectFields.count().catch(() => 0);
  for (let index = 0; index < selectCount; index += 1) {
    const field = selectFields.nth(index);
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }

    const question = await describeVisibleField(field);
    if (!question) {
      continue;
    }

    const label = cleanExtractedLabel(question.label) || "Lever select";
    const desiredValue = await suggestFieldValue(
      profile,
      explicitAnswers,
      bank,
      label,
      question.type,
      question.required,
      question.choices,
    );
    if (!desiredValue) {
      skipped.push(label);
      continue;
    }

    const currentValue = await field.inputValue().catch(() => "");
    if (isMeaningfulValue(currentValue)) {
      filled.push(label);
      continue;
    }

    const applied = await setEditableFieldValue(page, field, question.tag, desiredValue);
    if (applied) {
      filled.push(label);
    } else {
      skipped.push(label);
    }
  }

  const questionGroups = scope.locator(".application-question");
  const groupCount = await questionGroups.count().catch(() => 0);
  for (let index = 0; index < groupCount; index += 1) {
    const group = questionGroups.nth(index);
    if (!(await group.isVisible().catch(() => false))) {
      continue;
    }

    const groupLabel = cleanExtractedLabel(
      tidy(
        await group
          .locator(".application-label .text, .application-label, legend")
          .first()
          .textContent()
          .catch(() => ""),
      ),
    );
    const radioOptions = group.locator('input[type="radio"]');
    const radioCount = await radioOptions.count().catch(() => 0);
    if (radioCount >= 2) {
      const choices = await group.locator("label").evaluateAll((nodes) =>
        nodes
          .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean),
      );
      const desiredValue = await suggestFieldValue(
        profile,
        explicitAnswers,
        bank,
        groupLabel || "Lever radio question",
        "radio",
        true,
        dedupeText(choices),
      );
      if (!desiredValue) {
        skipped.push(groupLabel || "Lever radio question");
        continue;
      }

      const alreadySelected =
        (await group.locator('input[type="radio"]:checked').count().catch(() => 0)) > 0 ||
        (await group.locator('[aria-checked="true"]').count().catch(() => 0)) > 0;
      if (alreadySelected) {
        filled.push(groupLabel || "Lever radio question");
        continue;
      }

      const applied = await clickRadioChoice(group, desiredValue);
      if (applied) {
        filled.push(groupLabel || "Lever radio question");
      } else {
        skipped.push(groupLabel || "Lever radio question");
      }
      continue;
    }

    const customFields = group.locator(
      'input:not([type="hidden"]):not([type="file"]):not([type="radio"]), textarea, select',
    );
    const customCount = await customFields.count().catch(() => 0);
    for (let fieldIndex = 0; fieldIndex < customCount; fieldIndex += 1) {
      const field = customFields.nth(fieldIndex);
      const question = await describeVisibleField(field);
      if (!question) {
        continue;
      }

      const label =
        question.label === "Unlabeled field" || question.label === "Type your response"
          ? groupLabel || question.label
          : question.label;
      const desiredValue = await suggestFieldValue(
        profile,
        explicitAnswers,
        bank,
        label,
        question.type,
        question.required,
        question.choices,
      );
      if (!desiredValue) {
        skipped.push(label);
        continue;
      }

      const currentValue = await readFieldCurrentValue(field, question.tag, question.type);
      if (isMeaningfulValue(currentValue)) {
        filled.push(label);
        continue;
      }

      const applied =
        question.type === "checkbox"
          ? await setCheckboxValue(field, desiredValue)
          : await setEditableFieldValue(page, field, question.tag, desiredValue);
      if (applied) {
        filled.push(label);
      } else {
        skipped.push(label);
      }
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function runToastCareersAutofill(
  page: Page,
  profile: Profile,
  options: AutofillExecutionOptions = {},
): Promise<AutofillResult> {
  await page.waitForTimeout(2000);
  await acceptCookieBannerIfPresent(page).catch(() => undefined);
  await waitForToastCareersFields(page);

  const submit = options.submit === true;
  let submitted = false;
  const filled: string[] = [];
  const skipped: string[] = [];

  const uploads = await runToastResumeUpload(page, profile);
  filled.push(...uploads.filled);
  skipped.push(...uploads.skipped);
  if (uploads.filled.length > 0) {
    await waitForToastCareersFields(page);
  }

  const toastHosted = await runToastCareersDirectAutofill(page, profile);
  filled.push(...toastHosted.filled);
  skipped.push(...toastHosted.skipped);

  const siteKind = await detectApplicationSiteKind(page);
  const action = await findVisibleAction(page, getPrimaryActionSelectors(siteKind));
  const nextAction = action?.label || "No primary action detected";
  if (!submit) {
    return buildAutofillResult(filled, skipped, nextAction, {
      stoppedBeforeSubmit: true,
      submitted: false,
      stopReason: "Configured to stop before submit.",
    });
  }

  const unresolvedRequired = await listUnresolvedRequiredFields(page);
  if (unresolvedRequired.length > 0) {
    return buildAutofillResult(filled, skipped, nextAction, {
      stoppedBeforeSubmit: false,
      submitted,
      stopReason: `Required fields still missing: ${unresolvedRequired.slice(0, 4).join(", ")}`,
    });
  }

  if (!action) {
    return buildAutofillResult(filled, skipped, nextAction, {
      stoppedBeforeSubmit: false,
      submitted,
      stopReason: "No primary employer-form action was detected after autofill.",
    });
  }

  const clicked = await clickActionHandle(page, action);
  if (!clicked) {
    return buildAutofillResult(filled, skipped, nextAction, {
      stoppedBeforeSubmit: false,
      submitted,
      stopReason: `Could not click the employer-form action: ${action.label}`,
    });
  }

  const clickedFinalAction = isSiteFinalAction(action.label);
  await page.waitForTimeout(clickedFinalAction ? (siteKind === "ashby" ? 7000 : 2500) : 1500);
  if (clickedFinalAction) {
    const submissionBlocker = await detectSiteSubmissionBlocker(page, profile);
    if (submissionBlocker) {
      return buildAutofillResult(filled, skipped, action.label, {
        stoppedBeforeSubmit: false,
        submitted: false,
        stopReason: submissionBlocker,
      });
    }

    submitted = true;
    return buildAutofillResult(filled, skipped, "Submitted", {
      stoppedBeforeSubmit: false,
      submitted: true,
      stopReason: (await detectSiteSubmissionSuccess(page))
        ? "Application submitted."
        : `Final action clicked: ${action.label}`,
    });
  }

  return buildAutofillResult(filled, skipped, await getPrimaryActionText(page, siteKind), {
    stoppedBeforeSubmit: false,
    submitted,
    stopReason: "Advanced to the next Toast application step.",
  });
}

async function describeVisibleField(field: Locator): Promise<(FormQuestion & { tag: string }) | null> {
  const isVisible = await field.isVisible().catch(() => false);
  if (!isVisible) {
    return null;
  }

  const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
  const role = tidy(await field.getAttribute("role").catch(() => ""));
  const popup = tidy(await field.getAttribute("aria-haspopup").catch(() => ""));
  const choices: string[] = [];

  if (tag === "select") {
    const options = field.locator("option");
    const count = await options.count();
    for (let index = 0; index < count; index += 1) {
      const choice = tidy(await options.nth(index).textContent().catch(() => ""));
      if (choice) {
        choices.push(choice);
      }
    }
  }

  const label = await extractLocatorLabel(field);
  const fieldName =
    tidy(await field.getAttribute("name").catch(() => "")) ||
    tidy(await field.getAttribute("id").catch(() => ""));
  const accept = tidy(await field.getAttribute("accept").catch(() => ""));

  const type =
    (role === "combobox" || popup === "listbox" ? "combobox" : "") ||
    tidy(await field.getAttribute("type").catch(() => "")) ||
    tag ||
    "unknown";

  const required =
    (await hasRequiredMarker(field)) ||
    labelHasRequiredMarker(type === "file" ? deriveFileFieldLabel(label, fieldName, accept) : label) ||
    isKnownRequiredFieldIdentifier(fieldName);

  return {
    label: type === "file" ? deriveFileFieldLabel(label, fieldName, accept) : label || "Unlabeled field",
    type,
    required,
    choices: dedupeText(choices),
    tag: type === "combobox" ? "combobox" : tag,
  };
}

async function describeVisibleRadioGroup(group: Locator): Promise<FormQuestion | null> {
  const isVisible = await group.isVisible().catch(() => false);
  if (!isVisible) {
    return null;
  }

  const radioControlCount = await group.locator('input[type="radio"], [role="radio"]').count().catch(() => 0);
  if (radioControlCount < 2) {
    return null;
  }

  const label =
    tidy(await group.locator("legend").first().textContent({ timeout: 500 }).catch(() => "")) ||
    tidy(await group.getAttribute("aria-label").catch(() => "")) ||
    tidy(
      await group
        .locator(
          ".ashby-application-form-question-title, [class*=\"question-title\"], [class*=\"questionTitle\"], .fb-dash-form-element__label, [data-test-form-builder-radio-button-form-component__title], .jobs-easy-apply-form-section__grouping label, label",
        )
        .first()
        .textContent({ timeout: 500 })
        .catch(() => ""),
    );

  const optionLabels = group.locator("label");
  const optionCount = await optionLabels.count();
  const choices: string[] = [];
  for (let index = 0; index < optionCount; index += 1) {
    const choice = tidy(await optionLabels.nth(index).textContent().catch(() => ""));
    if (choice) {
      choices.push(choice);
    }
  }

  const required = (await hasRequiredMarker(group)) || labelHasRequiredMarker(label);

  const dedupedChoices = dedupeText(choices);
  if (dedupedChoices.length < 2) {
    return null;
  }

  return {
    label: label || "Unlabeled radio group",
    type: "radio",
    required,
    choices: dedupedChoices,
  };
}

async function clickRadioChoice(group: Locator, choiceText: string): Promise<boolean> {
  const normalizedTarget = normalizeQuestionText(choiceText);
  const labels = group.locator("label");
  const count = await labels.count();

  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    const visible = await label.isVisible().catch(() => false);
    if (!visible) continue;

    const text = tidy(await label.textContent().catch(() => ""));
    const normalizedText = normalizeQuestionText(text);
    if (
      normalizedText === normalizedTarget ||
      normalizedText.includes(normalizedTarget) ||
      normalizedTarget.includes(normalizedText)
    ) {
      const inputId = tidy(await label.getAttribute("for").catch(() => ""));
      const input = inputId
        ? group.locator(`[id="${escapeAttributeValue(inputId)}"]`).first()
        : label.locator('input[type="radio"], [role="radio"]').first();
      const hasInput = (await input.count().catch(() => 0)) > 0;
      const inputIsSelected = async () =>
        hasInput &&
        ((await input.isChecked().catch(() => false)) ||
          (await input.getAttribute("aria-checked").catch(() => "")) === "true");

      const labelClicked =
        (await label.click({ timeout: 5000 }).then(() => true).catch(() => false)) ||
        (await label.click({ timeout: 5000, force: true }).then(() => true).catch(() => false));
      if (labelClicked) {
        await waitAfterLocatorAction(label);
        if (!hasInput || (await inputIsSelected())) {
          return true;
        }
      }

      if (hasInput) {
        const inputClicked =
          (await input.check({ timeout: 5000, force: true }).then(() => true).catch(() => false)) ||
          (await input.click({ timeout: 5000, force: true }).then(() => true).catch(() => false));
        await waitAfterLocatorAction(label);
        if (inputClicked && (await inputIsSelected())) {
          return true;
        }
      }

      const optionContainer = label.locator("xpath=ancestor::*[self::div or self::label][1]").first();
      const containerClicked =
        (await optionContainer.click({ timeout: 5000 }).then(() => true).catch(() => false)) ||
        (await optionContainer.click({ timeout: 5000, force: true }).then(() => true).catch(() => false));
      await waitAfterLocatorAction(label);
      if (containerClicked && (!hasInput || (await inputIsSelected()))) {
        return true;
      }
    }
  }

  return false;
}

async function clickCheckboxChoice(group: Locator, choiceText: string): Promise<boolean> {
  const normalizedTarget = normalizeQuestionText(choiceText);
  const labels = group.locator("label");
  const count = await labels.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    const visible = await label.isVisible().catch(() => false);
    if (!visible) continue;

    const text = tidy(await label.textContent().catch(() => ""));
    const normalizedText = normalizeQuestionText(text);
    if (
      normalizedText === normalizedTarget ||
      normalizedText.includes(normalizedTarget) ||
      normalizedTarget.includes(normalizedText)
    ) {
      const inputId = tidy(await label.getAttribute("for").catch(() => ""));
      const input = inputId
        ? group.locator(`[id="${escapeAttributeValue(inputId)}"]`).first()
        : label.locator('input[type="checkbox"], [role="checkbox"]').first();
      const hasInput = (await input.count().catch(() => 0)) > 0;
      if (hasInput && (await input.isChecked().catch(() => false))) {
        return true;
      }

      if (hasInput) {
        const inputChecked =
          (await input.check({ timeout: 5_000, force: true }).then(() => true).catch(() => false)) ||
          (await input.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
        await waitAfterLocatorAction(label);
        if (inputChecked && (await input.isChecked().catch(() => false))) {
          return true;
        }
      }

      const labelClicked =
        (await label.click({ timeout: 5000 }).then(() => true).catch(() => false)) ||
        (await label.click({ timeout: 5000, force: true }).then(() => true).catch(() => false));
      await waitAfterLocatorAction(label);
      if (!hasInput) {
        return labelClicked;
      }
      if (labelClicked && (await input.isChecked().catch(() => false))) {
        return true;
      }

      const inputClicked =
        (await input.check({ timeout: 5000, force: true }).then(() => true).catch(() => false)) ||
        (await input.click({ timeout: 5000, force: true }).then(() => true).catch(() => false));
      await waitAfterLocatorAction(label);
      return inputClicked && (await input.isChecked().catch(() => false));
    }
  }

  return false;
}

async function clickVisibleOptionByText(page: Page, value: string): Promise<boolean> {
  const optionSelectors = [
    '[role="option"]',
    '[data-automation-id="promptOption"]',
    '[data-automation-id="menuItem"]',
    'li[role="option"]',
  ];

  for (const selector of optionSelectors) {
    const options = page.locator(selector);
    const count = await options.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      const visible = await option.isVisible().catch(() => false);
      if (!visible) continue;

      const text = tidy(await option.textContent().catch(() => ""));
      if (matchesDesiredChoice(text, value)) {
        const clicked = await option
          .click({ timeout: 5000 })
          .then(() => true)
          .catch(() => false);
        if (clicked) {
          return true;
        }

        const box = await option.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
          return true;
        }
      }
    }
  }

  return false;
}

function buildComboboxCandidateValues(value: string): string[] {
  const cleaned = tidy(value);
  if (!cleaned) {
    return [];
  }

  const parts = cleaned
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);

  return dedupeText([
    cleaned,
    parts.slice(0, 2).join(", "),
    parts[0] ?? "",
    parts.at(-1) ?? "",
  ]);
}

function isAffirmativeAnswer(value: string): boolean {
  return /^(yes|true|y|agree|agreed|accept|accepted|acknowledge|acknowledged|confirm|confirmed|consent|consented|read|checked|on)$/.test(
    normalizeQuestionText(value),
  );
}

function isNegativeAnswer(value: string): boolean {
  return /^(no|false|n|decline|declined|disagree|unchecked|off)$/.test(normalizeQuestionText(value));
}

async function isCheckboxChecked(field: Locator): Promise<boolean> {
  return field
    .evaluate((node) => {
      const input = node as HTMLInputElement;
      if (typeof input.checked === "boolean") {
        return input.checked;
      }

      return input.getAttribute("aria-checked") === "true";
    })
    .catch(async () => (await field.getAttribute("aria-checked").catch(() => "")) === "true");
}

async function setCheckboxValue(field: Locator, value: string): Promise<boolean> {
  const desiredState = isAffirmativeAnswer(value) ? true : isNegativeAnswer(value) ? false : null;
  if (desiredState === null) {
    return false;
  }

  const currentState = await isCheckboxChecked(field);
  if (currentState === desiredState) {
    return true;
  }

  if (desiredState) {
    await field.check({ timeout: 5000 }).catch(() => field.click({ timeout: 5000 }).catch(() => undefined));
  } else {
    await field.uncheck({ timeout: 5000 }).catch(() => field.click({ timeout: 5000 }).catch(() => undefined));
  }

  return (await isCheckboxChecked(field)) === desiredState;
}

function getWorkdayAccountPassword(): string {
  return (process.env.JAA_WORKDAY_PASSWORD || "").trim();
}

function getMissingWorkdayPasswordMessage(): string {
  return "Workday account password is not configured; set JAA_WORKDAY_PASSWORD or finish account creation manually.";
}

function expandUsStateName(value: string): string {
  const normalized = tidy(value).toUpperCase();
  const states: Record<string, string> = {
    AL: "Alabama",
    AK: "Alaska",
    AZ: "Arizona",
    AR: "Arkansas",
    CA: "California",
    CO: "Colorado",
    CT: "Connecticut",
    DE: "Delaware",
    FL: "Florida",
    GA: "Georgia",
    HI: "Hawaii",
    ID: "Idaho",
    IL: "Illinois",
    IN: "Indiana",
    IA: "Iowa",
    KS: "Kansas",
    KY: "Kentucky",
    LA: "Louisiana",
    ME: "Maine",
    MD: "Maryland",
    MA: "Massachusetts",
    MI: "Michigan",
    MN: "Minnesota",
    MS: "Mississippi",
    MO: "Missouri",
    MT: "Montana",
    NE: "Nebraska",
    NV: "Nevada",
    NH: "New Hampshire",
    NJ: "New Jersey",
    NM: "New Mexico",
    NY: "New York",
    NC: "North Carolina",
    ND: "North Dakota",
    OH: "Ohio",
    OK: "Oklahoma",
    OR: "Oregon",
    PA: "Pennsylvania",
    RI: "Rhode Island",
    SC: "South Carolina",
    SD: "South Dakota",
    TN: "Tennessee",
    TX: "Texas",
    UT: "Utah",
    VT: "Vermont",
    VA: "Virginia",
    WA: "Washington",
    WV: "West Virginia",
    WI: "Wisconsin",
    WY: "Wyoming",
    DC: "District of Columbia",
  };

  return states[normalized] || tidy(value);
}

async function openWorkdaySignInGate(page: Page): Promise<boolean> {
  if (await isWorkdaySignInGate(page)) {
    return true;
  }

  const selectors = [
    'main button:has-text("Sign In")',
    'main a:has-text("Sign In")',
    '[data-automation-id="signInLink"]',
    '[data-automation-id="utilityButtonSignIn"]',
    'button:has-text("Sign In")',
    'a:has-text("Sign In")',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible().catch(() => false))) {
      continue;
    }

    const href = tidy(await locator.getAttribute("href").catch(() => ""));
    const currentUrl = page.url();
    const clicked =
      (await locator.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
      (await locator.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
    await page.waitForTimeout(1200).catch(() => undefined);
    if (await isWorkdaySignInGate(page)) {
      return true;
    }

    if (href) {
      const resolved = new URL(href, currentUrl).toString();
      const navigated = await page.goto(resolved, { waitUntil: "domcontentloaded", timeout: 30_000 }).then(() => true).catch(() => false);
      if (navigated) {
        await page.waitForTimeout(1200).catch(() => undefined);
        if (await isWorkdaySignInGate(page)) {
          return true;
        }
      }
    }

    if (clicked && (await isWorkdaySignInGate(page))) {
      return true;
    }
  }

  return false;
}

async function hasVisibleWorkdayEmailSignInFields(page: Page): Promise<boolean> {
  const emailVisible = await page
    .locator('input[autocomplete="email"], input[data-automation-id="email"], input[type="email"]')
    .evaluateAll((nodes) =>
      nodes.some((node) => {
        const element = node as HTMLElement;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }),
    )
    .catch(() => false);
  const passwordVisible = await page
    .locator('input[autocomplete="current-password"], input[data-automation-id="password"]')
    .evaluateAll((nodes) =>
      nodes.some((node) => {
        const element = node as HTMLElement;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }),
    )
    .catch(() => false);

  return emailVisible && passwordVisible;
}

async function openWorkdayEmailSignInPane(page: Page): Promise<boolean> {
  if (await hasVisibleWorkdayEmailSignInFields(page)) {
    return true;
  }

  const selectors = [
    '[data-automation-id="SignInWithEmailButton"]',
    'button:has-text("Sign in with email")',
    'button:has-text("Sign In with email")',
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (!(await button.isVisible().catch(() => false))) {
      continue;
    }

    const clicked =
      (await button.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
      (await button.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
    if (!clicked) {
      continue;
    }

    await page.waitForTimeout(1_200).catch(() => undefined);
    if (await hasVisibleWorkdayEmailSignInFields(page)) {
      return true;
    }
  }

  return false;
}

async function setWorkdayCheckboxValue(page: Page, checkbox: Locator, checked: boolean): Promise<boolean> {
  const readCurrent = async () =>
    checkbox
      .evaluate((node) => {
        const input = node as HTMLInputElement;
        return input.type === "checkbox" ? input.checked : input.checked || input.getAttribute("aria-checked") === "true";
      })
      .catch(() => false);

  const current = await readCurrent();
  if (current === checked) {
    return current;
  }

  await checkbox.focus().catch(() => undefined);
  await page.keyboard.press("Space").catch(() => undefined);
  await page.waitForTimeout(150).catch(() => undefined);
  const afterKeyboard = await readCurrent();
  if (afterKeyboard === checked) {
    return afterKeyboard;
  }

  const box = await checkbox.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
    await page.waitForTimeout(150).catch(() => undefined);
    const afterMouse = await readCurrent();
    if (afterMouse === checked) {
      return afterMouse;
    }
  }

  const clickedVisibleLabel = await checkbox
    .evaluate((node) => {
      const input = node as HTMLInputElement;
      const label =
        (input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null) ||
        input.closest("label") ||
        input.parentElement?.querySelector("span, div");
      if (label instanceof HTMLElement) {
        label.scrollIntoView({ block: "center", inline: "nearest" });
        const rect = label.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return null;
        }
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        };
      }
      return null;
    })
    .catch(() => null as { x: number; y: number } | null);
  if (clickedVisibleLabel) {
    await page.mouse.click(clickedVisibleLabel.x, clickedVisibleLabel.y).catch(() => undefined);
    await page.waitForTimeout(200).catch(() => undefined);
    const afterLabel = await readCurrent();
    if (afterLabel === checked) {
      return afterLabel;
    }
  }

  const clickedDomLabel = await checkbox
    .evaluate((node) => {
      const input = node as HTMLInputElement;
      const label =
        (input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null) || input.closest("label");
      if (!(label instanceof HTMLElement)) {
        return null;
      }
      label.scrollIntoView({ block: "center", inline: "nearest" });
      label.click();
      for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const event = eventName.startsWith("pointer")
          ? new PointerEvent(eventName, { bubbles: true, cancelable: true, pointerType: "mouse" })
          : new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window });
        label.dispatchEvent(event);
      }
      return input.type === "checkbox" ? input.checked : input.checked || input.getAttribute("aria-checked") === "true";
    })
    .catch(() => null);
  if (clickedDomLabel === checked) {
    return true;
  }

  const toggled = await checkbox
    .evaluate((node, desired) => {
      const input = node as HTMLInputElement;
      input.checked = desired as boolean;
      input.setAttribute("aria-checked", desired ? "true" : "false");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.type === "checkbox" ? input.checked : input.checked || input.getAttribute("aria-checked") === "true";
    }, checked)
    .catch(() => current);

  return Boolean(toggled) === checked;
}

async function setWorkdayCheckboxByLabelText(page: Page, pattern: RegExp, checked: boolean): Promise<boolean> {
  const checkboxId = await page
    .evaluate(
      ({ source, flags }) => {
        const matcher = new RegExp(source, flags.replace(/g/g, ""));
        const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
        const isVisible = (element: Element) => {
          const html = element as HTMLElement;
          const style = window.getComputedStyle(html);
          const rect = html.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
          if (!isVisible(input)) continue;
          const id = input.id;
          const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
          const texts = [read(label?.textContent), read(input.getAttribute("aria-label"))];
          for (let parent = input.parentElement, depth = 0; parent && depth < 6; parent = parent.parentElement, depth += 1) {
            texts.push(read(parent.textContent));
          }
          if (!texts.some((text) => text && matcher.test(text))) continue;
          return id || null;
        }
        return null;
      },
      { source: pattern.source, flags: pattern.flags },
    )
    .catch(() => null);

  if (!checkboxId) {
    return false;
  }

  const checkbox = page.locator(`[id="${escapeCssAttributeValue(checkboxId)}"]`).first();
  return setWorkdayCheckboxValue(page, checkbox, checked);
}

async function selectWorkdayTodayFromDatePicker(page: Page): Promise<boolean> {
  const openPicker = () =>
    page
      .evaluate(() => {
        const isVisible = (element: Element | null) => {
          if (!element) return false;
          const html = element as HTMLElement;
          const style = window.getComputedStyle(html);
          const rect = html.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const openDateButton = Array.from(document.querySelectorAll<HTMLElement>("button[aria-label]")).find((button) =>
          /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
            button.getAttribute("aria-label") || "",
          ),
        );
        if (isVisible(openDateButton ?? null)) return true;

        const icon = document.querySelector<HTMLElement>(
          '[data-automation-id="formField-dateSignedOn"] [data-automation-id="dateIcon"], [data-automation-id="dateIcon"], [role="button"][aria-label="Calendar"]',
        );
        if (!icon) return false;
        icon.scrollIntoView({ block: "center" });
        icon.click();
        return true;
      })
      .catch(() => false);

  const clickDateInOpenPicker = (mode: "today" | "alternate") =>
    page
      .evaluate(
        async (mode) => {
          const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
          const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
          const isVisible = (element: Element | null) => {
            if (!element) return false;
            const html = element as HTMLElement;
            const style = window.getComputedStyle(html);
            const rect = html.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const clickElement = (element: HTMLElement) => {
            element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
            element.click();
            element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
            return true;
          };

          const months = [
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december",
          ];
          const picker = document.querySelector<HTMLElement>('[data-automation-id="datePicker"], [role="application"]');
          const heading = read(picker?.textContent);
          const match = heading.match(
            /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i,
          );
          if (match) {
            const currentMonth = months.indexOf(match[1].toLowerCase());
            const currentYear = Number(match[2]);
            const today = new Date();
            const targetDelta = (today.getFullYear() - currentYear) * 12 + today.getMonth() - currentMonth;
            const controlSelector =
              targetDelta >= 0
                ? '[data-automation-id="nextControl"], button[aria-label*="Next month" i]'
                : '[data-automation-id="previousControl"], button[aria-label*="Previous month" i]';
            for (let index = 0; index < Math.min(Math.abs(targetDelta), 360); index += 1) {
              const control = Array.from(document.querySelectorAll<HTMLElement>(controlSelector)).find(isVisible);
              if (!control) return false;
              clickElement(control);
              await wait(8);
            }
            await wait(150);
          }

          const today = new Date();
          const monthName = today.toLocaleString("en-US", { month: "long" });
          const year = String(today.getFullYear());
          const todayDay = today.getDate();
          const monthYearPattern = new RegExp(`\\b${monthName}\\s+${year}\\b`, "i");
          const dateButtons = Array.from(document.querySelectorAll<HTMLElement>("button[aria-label]")).filter(isVisible);
          const findDay = (day: number) =>
            dateButtons.find((button) => {
              const aria = read(button.getAttribute("aria-label"));
              const text = read(button.textContent);
              return text === String(day) && monthYearPattern.test(aria);
            });

          if (mode === "alternate") {
            const alternateDays =
              todayDay > 1 ? [todayDay - 1, todayDay + 1, todayDay + 2] : [todayDay + 1, todayDay + 2];
            for (const alternateDay of alternateDays) {
              const alternate = findDay(alternateDay);
              if (!alternate) continue;
              clickElement(alternate);
              return true;
            }
            return false;
          }

          const todayByAutomation = Array.from(
            document.querySelectorAll<HTMLElement>('[data-automation-id="datePickerToday"]'),
          ).find(isVisible);
          if (todayByAutomation) {
            clickElement(todayByAutomation);
            return true;
          }

          const todayButton =
            dateButtons.find((button) => {
              const aria = read(button.getAttribute("aria-label"));
              return /\btoday\b/i.test(aria) && monthYearPattern.test(aria) && read(button.textContent) === String(todayDay);
            }) ?? findDay(todayDay);
          if (!todayButton) return false;

          clickElement(todayButton);
          return true;
        },
        mode,
      )
      .catch(() => false);

  const opened = await openPicker();
  if (!opened) {
    return false;
  }

  await page.waitForTimeout(500).catch(() => undefined);
  const alternateSelected = await clickDateInOpenPicker("alternate");
  if (alternateSelected) {
    await page.waitForTimeout(500).catch(() => undefined);
    const reopened = await openPicker();
    if (!reopened) {
      return false;
    }
    await page.waitForTimeout(500).catch(() => undefined);
  }

  return clickDateInOpenPicker("today");
}

async function forceFillWorkdayDateSectionInputs(
  page: Page,
  month: string,
  day: string,
  year: string,
): Promise<boolean> {
  const parts = [
    { selector: 'input[id$="dateSectionMonth-input"]', value: month },
    { selector: 'input[id$="dateSectionDay-input"]', value: day },
    { selector: 'input[id$="dateSectionYear-input"]', value: year },
  ];
  let touched = false;

  for (const part of parts) {
    const input = page.locator(part.selector).first();
    if ((await input.count().catch(() => 0)) === 0) {
      continue;
    }

    touched = true;
    await input.scrollIntoViewIfNeeded().catch(() => undefined);
    const forceFilled = await input
      .fill(part.value, { force: true, timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (!forceFilled) {
      await input
        .evaluate((node, nextValue) => {
          const inputElement = node as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          if (setter) {
            setter.call(inputElement, nextValue as string);
          } else {
            inputElement.value = nextValue as string;
          }
          inputElement.dispatchEvent(
            new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              inputType: "insertText",
              data: nextValue as string,
            }),
          );
          inputElement.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: nextValue as string,
            }),
          );
          inputElement.dispatchEvent(new Event("change", { bubbles: true }));
          inputElement.dispatchEvent(new Event("blur", { bubbles: true }));
          return inputElement.value;
        }, part.value)
        .catch(() => undefined);
    }
    await input.dispatchEvent("input").catch(() => undefined);
    await input.dispatchEvent("change").catch(() => undefined);
    await input.dispatchEvent("blur").catch(() => undefined);
  }

  if (!touched) {
    return false;
  }

  await page.waitForTimeout(250).catch(() => undefined);
  return page
    .evaluate(
      ({ expectedMonth, expectedDay, expectedYear }) => {
        const read = (selector: string) =>
          (document.querySelector<HTMLInputElement>(selector)?.value || "").replace(/^0+/, "") || "0";
        return (
          read('input[id$="dateSectionMonth-input"]') === String(Number(expectedMonth)) &&
          read('input[id$="dateSectionDay-input"]') === String(Number(expectedDay)) &&
          read('input[id$="dateSectionYear-input"]') === String(Number(expectedYear))
        );
      },
      { expectedMonth: month, expectedDay: day, expectedYear: year },
    )
    .catch(() => false);
}

async function typeWorkdayDateFromFirstSegment(
  page: Page,
  month: string,
  day: string,
  year: string,
): Promise<boolean> {
  const targetDate = `${month}${day}${year}`;
  const focused = await page
    .evaluate(() => {
      const monthSegment = document.querySelector<HTMLElement>(
        '#selfIdentifiedDisabilityData--dateSignedOn-dateSectionMonth, [id$="dateSectionMonth"]',
      );
      if (!monthSegment) return false;
      monthSegment.scrollIntoView({ block: "center", inline: "nearest" });
      monthSegment.focus();
      const rect = monthSegment.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      };
      for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const event = eventName.startsWith("pointer")
          ? new PointerEvent(eventName, { ...init, pointerType: "mouse" })
          : new MouseEvent(eventName, init);
        monthSegment.dispatchEvent(event);
      }
      return true;
    })
    .catch(() => false);
  if (!focused) {
    return forceFillWorkdayDateSectionInputs(page, month, day, year);
  }

  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
  await page.keyboard.press("Backspace").catch(() => undefined);
  await page.keyboard.type(targetDate, { delay: 30 }).catch(() => undefined);
  await page.waitForTimeout(400).catch(() => undefined);

  const typedWholeDate = await page
    .evaluate(
      ({ expectedMonth, expectedDay, expectedYear }) => {
        const read = (selector: string) =>
          (document.querySelector<HTMLInputElement>(selector)?.value || "").replace(/^0+/, "") || "0";
        return (
          read('input[id$="dateSectionMonth-input"]') === String(Number(expectedMonth)) &&
          read('input[id$="dateSectionDay-input"]') === String(Number(expectedDay)) &&
          read('input[id$="dateSectionYear-input"]') === String(Number(expectedYear))
        );
      },
      { expectedMonth: month, expectedDay: day, expectedYear: year },
    )
    .catch(() => false);
  if (typedWholeDate) {
    return true;
  }

  const parts = [
    { suffix: "dateSectionMonth-input", value: month },
    { suffix: "dateSectionDay-input", value: day },
    { suffix: "dateSectionYear-input", value: year },
  ];
  for (const part of parts) {
    const input = page.locator(`input[id$="${part.suffix}"]`).first();
    const inputId = await input.evaluate((node) => (node as HTMLInputElement).id).catch(() => "");
    const displaySelector = inputId ? `#${inputId.replace(/-input$/, "-display").replace(/(["\\])/g, "\\$1")}` : "";
    const target = displaySelector ? page.locator(displaySelector).first() : input;
    await target.evaluate((node) => (node as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" })).catch(() => undefined);
    await target.click({ timeout: 2_000, force: true }).catch(() => undefined);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
    await page.keyboard.press("Backspace").catch(() => undefined);
    await page.keyboard.type(part.value, { delay: 20 }).catch(() => undefined);
    await page.keyboard.press("Tab").catch(() => undefined);
  }
  await page.waitForTimeout(300).catch(() => undefined);

  const typedSegmentParts = await page
    .evaluate(
      ({ expectedMonth, expectedDay, expectedYear }) => {
        const read = (selector: string) =>
          (document.querySelector<HTMLInputElement>(selector)?.value || "").replace(/^0+/, "") || "0";
        return (
          read('input[id$="dateSectionMonth-input"]') === String(Number(expectedMonth)) &&
          read('input[id$="dateSectionDay-input"]') === String(Number(expectedDay)) &&
          read('input[id$="dateSectionYear-input"]') === String(Number(expectedYear))
        );
      },
      { expectedMonth: month, expectedDay: day, expectedYear: year },
    )
    .catch(() => false);
  if (typedSegmentParts) {
    return true;
  }

  return forceFillWorkdayDateSectionInputs(page, month, day, year);
}

async function typeWorkdayMonthYearFromFirstSegment(
  page: Page,
  monthSegmentSelector: string,
  month: string,
  year: string,
): Promise<boolean> {
  const focused = await page
    .evaluate((selector) => {
      const monthSegment = document.querySelector<HTMLElement>(selector);
      if (!monthSegment) return false;
      monthSegment.scrollIntoView({ block: "center", inline: "nearest" });
      monthSegment.focus();
      const rect = monthSegment.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      };
      for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const event = eventName.startsWith("pointer")
          ? new PointerEvent(eventName, { ...init, pointerType: "mouse" })
          : new MouseEvent(eventName, init);
        monthSegment.dispatchEvent(event);
      }
      return true;
    }, monthSegmentSelector)
    .catch(() => false);
  if (!focused) {
    return false;
  }

  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
  await page.keyboard.press("Backspace").catch(() => undefined);
  await page.keyboard.type(`${month}${year}`, { delay: 30 }).catch(() => undefined);
  await page.waitForTimeout(400).catch(() => undefined);

  return page
    .evaluate(
      ({ selector, expectedMonth, expectedYear }) => {
        const monthSegment = document.querySelector<HTMLElement>(selector);
        const inputPrefix = monthSegment?.id.replace(/-dateSectionMonth$/, "");
        if (!inputPrefix) return false;
        const read = (id: string) =>
          (document.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`)?.value || "").replace(/^0+/, "") || "0";
        return (
          read(`${inputPrefix}-dateSectionMonth-input`) === String(Number(expectedMonth)) &&
          read(`${inputPrefix}-dateSectionYear-input`) === String(Number(expectedYear))
        );
      },
      { selector: monthSegmentSelector, expectedMonth: month, expectedYear: year },
    )
    .catch(() => false);
}

async function typeWorkdayYearFromDisplay(page: Page, inputSelector: string, year: string): Promise<boolean> {
  const input = page.locator(inputSelector).first();
  const count = await input.count().catch(() => 0);
  if (count === 0) {
    return false;
  }

  const displaySelector = await input
    .evaluate((node) => {
      const inputElement = node as HTMLInputElement;
      const displayId = inputElement.id.replace(/-input$/, "-display");
      return displayId && document.getElementById(displayId) ? `#${CSS.escape(displayId)}` : "";
    })
    .catch(() => "");
  const clickTarget = displaySelector ? page.locator(displaySelector).first() : input;

  await clickTarget.evaluate((node) => (node as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" })).catch(() => undefined);
  await clickTarget.click({ timeout: 3_000, force: true }).catch(() => undefined);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
  await page.keyboard.press("Backspace").catch(() => undefined);
  await page.keyboard.type(year, { delay: 25 }).catch(() => undefined);
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(300).catch(() => undefined);

  return input
    .evaluate(
      (node, expectedYear) => {
        const value = ((node as HTMLInputElement).value || "").replace(/^0+/, "") || "0";
        return value === String(Number(expectedYear as string));
      },
      year,
    )
    .catch(() => false);
}

async function submitWorkdayCreateAccount(page: Page): Promise<boolean> {
  const action = await findVisibleAction(page, [
    '[data-automation-id="click_filter"][aria-label="Create Account"]',
    'button[data-automation-id="createAccountSubmitButton"]',
    'button:has-text("Create Account")',
  ]);
  if (!action) {
    return false;
  }

  const clicked = await clickActionHandle(page, action);
  if (!clicked) {
    return false;
  }

  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(1500).catch(() => undefined);
  return true;
}

async function readWorkdayAuthError(page: Page): Promise<string> {
  if (
    !(await isWorkdayCreateAccountGate(page)) &&
    !(await isWorkdaySignInGate(page)) &&
    !/\/login\b/i.test(page.url())
  ) {
    return "";
  }

  const alerts = page.locator('[data-automation-id="errorMessage"], [role="alert"]');
  const count = await alerts.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 5); index += 1) {
    const locator = alerts.nth(index);
    if (!(await locator.isVisible().catch(() => false))) {
      continue;
    }

    const text = tidy(await locator.textContent().catch(() => ""));
    if (
      text &&
      /wrong email|wrong password|account might be locked|account locked|invalid password|invalid email|unable to sign in|already exists|verify your email|email verification/i.test(
        text,
      )
    ) {
      return text;
    }
  }

  const bodyText = tidy(await page.locator("body").innerText().catch(() => ""));
  const bodyAuthBlocker = bodyText.match(
    /(verify your account before you sign in|request a verification email|account may need verification|resend account verification|verify your email|email verification)/i,
  );
  if (bodyAuthBlocker?.[0]) {
    return cleanRepeatedText(bodyAuthBlocker[0]);
  }

  return "";
}

function shouldTryWorkdayCreateAccountAfterSignInError(message: string): boolean {
  return /wrong email|wrong password|unable to sign in|invalid email|invalid password/i.test(message);
}

async function advanceWorkdayAuthentication(page: Page, profile: Profile, submit: boolean): Promise<boolean> {
  const siteKind = await detectApplicationSiteKind(page);
  if (siteKind !== "workday" || !submit) {
    return false;
  }

  const authError = await readWorkdayAuthError(page);
  if (authError) {
    if (shouldTryWorkdayCreateAccountAfterSignInError(authError)) {
      const openedCreateAccount = await openWorkdayCreateAccountPane(page).catch(() => false);
      if (openedCreateAccount) {
        await runWorkdayAccountAutofill(page, profile).catch(() => ({ filled: [], skipped: [] }));
        if (!getWorkdayAccountPassword()) {
          return false;
        }
        return submitWorkdayCreateAccount(page);
      }
    }

    return false;
  }

  if (await isWorkdayCreateAccountGate(page)) {
    if (getWorkdayAccountPassword()) {
      const openedSignIn = await openWorkdaySignInGate(page).catch(() => false);
      if (openedSignIn && (await isWorkdaySignInGate(page))) {
        const signIn = await runWorkdaySignInAutofill(page, profile, true);
        return signIn.advanced === true;
      }
    }

    await openWorkdayCreateAccountPane(page).catch(() => undefined);
    await runWorkdayAccountAutofill(page, profile).catch(() => ({ filled: [], skipped: [] }));
    if (!getWorkdayAccountPassword()) {
      return false;
    }
    return submitWorkdayCreateAccount(page);
  }

  await openWorkdayEmailSignInPane(page).catch(() => undefined);
  const signIn = await runWorkdaySignInAutofill(page, profile, false);
  if (signIn.filled.length === 0 && signIn.skipped.length === 0) {
    return false;
  }

  const signInAction = await findVisibleAction(page, [
    'button[data-automation-id="signInSubmitButton"]',
    '[data-automation-id="click_filter"][aria-label="Sign In"]',
    '[data-automation-id="click_filter"][aria-label="Submit"]',
  ]);
  if (!signInAction) {
    return false;
  }

  const clicked = await clickActionHandle(page, signInAction);
  if (!clicked) {
    return false;
  }

  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(1500).catch(() => undefined);
  return true;
}

async function readWorkdayPromptValue(trigger: Locator): Promise<string> {
  const tag = await trigger.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
  if (tag === "input") {
    const value = tidy(await trigger.inputValue().catch(() => ""));
    if (value) {
      return value;
    }
  }

  const text = tidy(await trigger.textContent().catch(() => ""));
  if (text) {
    return text;
  }

  return tidy(
    await trigger
      .locator('xpath=ancestor::*[@data-automation-id="formField" or self::div][1]')
      .textContent()
      .catch(() => ""),
  );
}

async function clickWorkdayPromptOption(page: Page, candidate: string): Promise<boolean> {
  if (await clickWorkdayVisibleOptionByText(page, candidate)) {
    return true;
  }

  const escaped = escapeRegExp(candidate);
  const patterns = [new RegExp(`^${escaped}$`, "i"), new RegExp(`^${escaped}\\b`, "i")];
  for (const pattern of patterns) {
    for (const selector of ['[role="listbox"] [role="option"]', '[data-automation-id="promptOption"]', '[id^="menuItem-"]', '[role="option"]']) {
      const options = page.locator(selector).filter({ hasText: pattern });
      const count = await options.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const option = options.nth(index);
        if (!(await option.isVisible().catch(() => false))) {
          continue;
        }

        const isInsideVisibleListViewport = await option
          .evaluate((node) => {
            const element = node as HTMLElement;
            const rect = element.getBoundingClientRect();
            const centerX = rect.x + rect.width / 2;
            const centerY = rect.y + rect.height / 2;
            const listbox = element.closest<HTMLElement>('[role="listbox"], [data-automation-id="activeListContainer"]');
            if (!listbox) {
              return centerX >= 0 && centerY >= 0 && centerX <= window.innerWidth && centerY <= window.innerHeight;
            }
            const listRect = listbox.getBoundingClientRect();
            return (
              centerX >= listRect.x &&
              centerX <= listRect.x + listRect.width &&
              centerY >= listRect.y &&
              centerY <= listRect.y + listRect.height
            );
          })
          .catch(() => false);
        if (!isInsideVisibleListViewport) {
          continue;
        }

        const clicked =
          (await option.click({ timeout: 4_000 }).then(() => true).catch(() => false)) ||
          (await option.click({ timeout: 4_000, force: true }).then(() => true).catch(() => false));
        if (clicked) {
          return true;
        }
      }
    }
  }

  return page
    .evaluate((candidateText) => {
      const normalize = (value: string | null | undefined) =>
        (value ?? "")
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replace(/[_-]+/g, " ")
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const isVisible = (element: Element) => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const desired = normalize(candidateText);
      if (!desired) return false;

      const options = Array.from(
        document.querySelectorAll(
          '[role="listbox"] [role="option"], [data-automation-id="promptOption"], [id^="menuItem-"], [role="option"]',
        ),
      ).filter(isVisible) as HTMLElement[];
      const insideVisibleListViewport = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        const listbox = element.closest<HTMLElement>('[role="listbox"], [data-automation-id="activeListContainer"]');
        if (!listbox) {
          return centerX >= 0 && centerY >= 0 && centerX <= window.innerWidth && centerY <= window.innerHeight;
        }
        const listRect = listbox.getBoundingClientRect();
        return (
          centerX >= listRect.x &&
          centerX <= listRect.x + listRect.width &&
          centerY >= listRect.y &&
          centerY <= listRect.y + listRect.height
        );
      };
      const option =
        options.find((element) => insideVisibleListViewport(element) && normalize(element.textContent) === desired) ||
        options.find((element) => insideVisibleListViewport(element) && normalize(element.textContent).startsWith(desired)) ||
        options.find((element) => insideVisibleListViewport(element) && normalize(element.textContent).includes(desired));
      if (!option) return false;

      const target = option.closest<HTMLElement>('[role="option"], [data-automation-id="promptOption"], [id^="menuItem-"]') || option;
      const rect = target.getBoundingClientRect();
      const clientX = rect.x + rect.width / 2;
      const clientY = rect.y + rect.height / 2;
      const eventNames = [
        "pointerover",
        "pointerenter",
        "mouseover",
        "mouseenter",
        "pointerdown",
        "mousedown",
        "pointerup",
        "mouseup",
        "click",
      ];
      for (const eventName of eventNames) {
        const event = eventName.startsWith("pointer")
          ? new PointerEvent(eventName, {
              bubbles: true,
              cancelable: true,
              view: window,
              button: 0,
              clientX,
              clientY,
              pointerType: "mouse",
            })
          : new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window, button: 0, clientX, clientY });
        target.dispatchEvent(event);
      }
      return true;
    }, candidate)
    .catch(() => false);
}

async function scrollWorkdayPromptOptionIntoView(page: Page, candidate: string): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await clickWorkdayPromptOption(page, candidate)) {
      return true;
    }

    const advanced = await page
      .evaluate(() => {
        const isVisible = (element: Element) => {
          const html = element as HTMLElement;
          const style = window.getComputedStyle(html);
          const rect = html.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const listboxes = Array.from(document.querySelectorAll('[role="listbox"], [data-automation-id="activeListContainer"]'))
          .filter(isVisible)
          .filter((element) => {
            const html = element as HTMLElement;
            return html.scrollHeight > html.clientHeight + 8;
          }) as HTMLElement[];
        const listbox = listboxes[0];
        if (!listbox) return false;

        const previousScrollTop = listbox.scrollTop;
        const maxScrollTop = listbox.scrollHeight - listbox.clientHeight;
        const increment = Math.max(96, listbox.clientHeight - 32);
        listbox.scrollTop = Math.min(maxScrollTop, previousScrollTop + increment);
        listbox.dispatchEvent(new Event("scroll", { bubbles: true }));
        return listbox.scrollTop > previousScrollTop;
      })
      .catch(() => false);

    if (!advanced) {
      break;
    }

    await page.waitForTimeout(160).catch(() => undefined);
  }

  return false;
}

async function selectWorkdayNestedPromptValue(
  page: Page,
  searchInput: Locator,
  candidate: string,
): Promise<boolean> {
  const normalized = normalizeQuestionText(candidate);
  const parents: string[] = [];
  if (/\bjob boards?\b|search engines?|indeed|linkedin/.test(normalized)) {
    parents.push("Third-party boards", "Paid Job Board", "Job Board", "Job Boards", "Job Sites");
  }

  for (const parent of parents) {
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill("").catch(() => undefined);
      await page.waitForTimeout(250).catch(() => undefined);
    }

    const expanded = await clickWorkdayPromptOption(page, parent);
    if (!expanded) {
      continue;
    }

    await page.waitForTimeout(300).catch(() => undefined);
    const selected =
      (await clickWorkdayPromptOption(page, candidate)) ||
      (await scrollWorkdayPromptOptionIntoView(page, candidate));
    if (selected) {
      return true;
    }
  }

  return false;
}

async function selectWorkdayPromptValue(page: Page, trigger: Locator, candidates: string[]): Promise<boolean> {
  const normalizedCandidates = dedupeText(candidates.map((candidate) => tidy(candidate)).filter(Boolean));
  if (normalizedCandidates.length === 0) {
    return false;
  }

  const tag = await trigger.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
  const searchInput = tag === "button" ? trigger.locator("xpath=following-sibling::input[1]").first() : trigger;

  await trigger.evaluate((node) => (node as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" })).catch(() => undefined);
  await page.waitForTimeout(150).catch(() => undefined);
  await trigger.click({ timeout: 5_000, force: true }).catch(() => undefined);
  await page.waitForTimeout(300).catch(() => undefined);

  for (const candidate of normalizedCandidates) {
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill(candidate).catch(() => undefined);
      await page.waitForTimeout(900).catch(() => undefined);
    }

    let selected = await clickWorkdayPromptOption(page, candidate);
    if (!selected) {
      selected = await scrollWorkdayPromptOptionIntoView(page, candidate);
    }

    if (!selected) {
      selected = await selectWorkdayNestedPromptValue(page, searchInput, candidate);
    }

    if (!selected && (await searchInput.isVisible().catch(() => false))) {
      await searchInput.press("ArrowDown").catch(() => undefined);
      await page.waitForTimeout(120).catch(() => undefined);
      await searchInput.press("Enter").catch(() => undefined);
      await page.waitForTimeout(400).catch(() => undefined);
      const keyboardSelectedValue = tidy(await readWorkdayPromptValue(trigger).catch(() => ""));
      selected =
        matchesDesiredChoice(keyboardSelectedValue, candidate) ||
        (isMeaningfulValue(keyboardSelectedValue) && !/select one/i.test(keyboardSelectedValue));
    }

    await page.waitForTimeout(500).catch(() => undefined);
    const selectedValue = tidy(await readWorkdayPromptValue(trigger).catch(() => ""));
    if (selected && matchesDesiredChoice(selectedValue, candidate)) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(300).catch(() => undefined);
      return true;
    }
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(500).catch(() => undefined);
  const selectedValue = normalizeQuestionText(await readWorkdayPromptValue(trigger));
  return normalizedCandidates.some((candidate) => matchesDesiredChoice(selectedValue, candidate));
}

async function ensureWorkdayEducationSchoolSelected(page: Page, candidates: string[]): Promise<boolean> {
  const schoolInput = page.locator('input[id^="education-"][id$="--school"], input[id*="school" i][id^="education-"]').first();
  if (!(await schoolInput.isVisible().catch(() => false))) {
    return false;
  }

  const readSchoolContext = async () =>
    tidy(
      await schoolInput
        .evaluate((node) => {
          const field = (node as HTMLElement).closest('[data-automation-id^="formField"]');
          return field?.textContent || "";
        })
        .catch(() => ""),
    );
  const removeSelectedOtherCountry = async () => {
    const context = await readSchoolContext();
    if (!/\bOther\s+-\s+(?!United States of America\b)/i.test(context)) {
      return;
    }
    const removed = await schoolInput
      .evaluate((node) => {
        const field = (node as HTMLElement).closest('[data-automation-id^="formField"]');
        const charm = field?.querySelector<HTMLElement>('[data-automation-id="DELETE_charm"]');
        if (!charm) return false;
        charm.click();
        return true;
      })
      .catch(() => false);
    if (removed) {
      await page.waitForTimeout(500).catch(() => undefined);
    }
  };
  const hasSelectedSchool = async () => {
    const context = await readSchoolContext();
    return /item selected/i.test(context) && !/\bOther\s+-\s+(?!United States of America\b)/i.test(context);
  };

  if (await hasSelectedSchool()) {
    return true;
  }
  await removeSelectedOtherCountry();

  const trySearchAndSelect = async (searchText: string, optionText: string, pressEnter = false) => {
    await schoolInput.evaluate((node) => (node as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" })).catch(() => undefined);
    await schoolInput.click({ timeout: 3_000, force: true }).catch(() => undefined);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
    await page.keyboard.press("Backspace").catch(() => undefined);
    await schoolInput.fill(searchText).catch(async () => {
      await page.keyboard.type(searchText, { delay: 20 }).catch(() => undefined);
    });
    await page.waitForTimeout(900).catch(() => undefined);
    if (pressEnter) {
      await schoolInput.press("Enter").catch(() => undefined);
      await page.waitForTimeout(900).catch(() => undefined);
    }
    const selected =
      (await clickWorkdayPromptOption(page, optionText)) ||
      (await scrollWorkdayPromptOptionIntoView(page, optionText));
    await page.waitForTimeout(600).catch(() => undefined);
    return selected && (await hasSelectedSchool());
  };

  for (const candidate of dedupeText(candidates.map((value) => tidy(value)).filter(Boolean))) {
    if (await trySearchAndSelect(candidate, candidate)) {
      return true;
    }
  }

  return trySearchAndSelect("Other", "Other - United States of America", true);
}

async function fillWorkdayAccountField(
  page: Page,
  selectors: string[],
  value: string,
  label: string,
): Promise<{ filled: string[]; skipped: string[] }> {
  const field = await findFirstVisibleField(page, selectors);
  if (!field) {
    return { filled: [], skipped: [] };
  }

  const currentValue = await field.inputValue().catch(() => "");
  if (isMeaningfulValue(currentValue)) {
    return { filled: [label], skipped: [] };
  }

  if (!value.trim()) {
    return { filled: [], skipped: [label] };
  }

  const applied = await setEditableFieldValue(page, field, "input", value);
  if (applied) {
    return { filled: [label], skipped: [] };
  }

  return { filled: [], skipped: [label] };
}

async function runWorkdayAccountAutofill(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const siteKind = await detectApplicationSiteKind(page);
  if (siteKind !== "workday") {
    return { filled: [], skipped: [] };
  }

  if (!(await isWorkdayCreateAccountGate(page))) {
    return { filled: [], skipped: [] };
  }

  await openWorkdayCreateAccountPane(page).catch(() => undefined);
  const password = getWorkdayAccountPassword();
  const filled: string[] = [];
  const skipped: string[] = [];

  const emailResult = await fillWorkdayAccountField(
    page,
    [
      'input[data-automation-id="email"]',
      '[data-automation-id="email"] input',
      'input[autocomplete="email"]',
      'input[type="email"]',
      'input[name="email"]',
    ],
    profile.email,
    "Email Address",
  );
  filled.push(...emailResult.filled);
  skipped.push(...emailResult.skipped);

  const primaryPasswordResult = await fillWorkdayAccountField(
    page,
    [
      'input[data-automation-id="password"]',
      '[data-automation-id="password"] input',
      'input[autocomplete="new-password"]',
    ],
    password,
    password ? "Password" : "Password (set JAA_WORKDAY_PASSWORD)",
  );
  filled.push(...primaryPasswordResult.filled);
  skipped.push(...primaryPasswordResult.skipped);

  const verifyPasswordResult = await fillWorkdayAccountField(
    page,
    [
      'input[data-automation-id="verifyPassword"]',
      '[data-automation-id="verifyPassword"] input',
      'input[id*="verify" i][type="password"]',
      'input[name*="verify" i][type="password"]',
    ],
    password,
    password ? "Verify Password" : "Verify Password (set JAA_WORKDAY_PASSWORD)",
  );
  filled.push(...verifyPasswordResult.filled);
  skipped.push(...verifyPasswordResult.skipped);

  const termsCheckbox = await findFirstVisibleField(page, [
    'input[data-automation-id="createAccountCheckbox"]',
    '[data-automation-id="createAccountCheckbox"] input[type="checkbox"]',
    'input[type="checkbox"][id*="createAccount" i]',
  ]);
  if (termsCheckbox) {
    const accepted = await setWorkdayCheckboxValue(page, termsCheckbox, true);
    if (accepted) {
      filled.push("Create Account Terms");
    } else {
      skipped.push("Create Account Terms");
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

function inferWorkdayPromptAnswer(label: string): string {
  const normalized = normalizeQuestionText(label);
  if (/currently work at cvs|currently work at cvs health/.test(normalized)) return "No";
  if (/ever been employed by cvs|previously employed by cvs|candidateispreviousworker/.test(normalized)) return "No";
  if (/ever been employed by centene|previously employed by centene|employed by centene/.test(normalized)) return "No";
  if (/worked for humana|humana.*associate.*intern.*contractor|previously worked for humana/.test(normalized)) return "No";
  if (/deloitte/.test(normalized) && /currently|previously|employed|worked/.test(normalized)) return "No";
  if (/sms|mms|text messages?/.test(normalized)) return "Please do not send me SMS/MMS messages.";
  if (/communicate with me via text|text message/.test(normalized)) return "No";
  if (/currently require sponsorship|future require sponsorship|require sponsorship|employment based visa|require support.*work visa|obtain extend.*work visa/.test(normalized)) return "No";
  if (/legally able to work|proof.*work in the united states|authorized to work|right to work|identity and right to work/.test(normalized)) return "Yes";
  if (/background check|criminal records check|credit check|drug screening/.test(normalized)) return "Yes";
  if (
    /submitted electronically|receipt of this application|true and complete|falsification|misrepresentation|required to sign|condition of employment|employment.*at will|conform to the rules|code of conduct|will not engage in any outside activity|conflict of interest|personal sales activities/.test(
      normalized,
    )
  ) {
    return "Yes, I agree";
  }
  if (/outside audit firm|kpmg|pwc|price waterhouse|coopers lybrand|financial or business relationship|business relationship or affiliation/.test(normalized)) {
    return "Not True";
  }
  if (/non compete|non solicitation|restrict.*post employment|agreement.*interfere|agreement.*restrict/.test(normalized)) return "No";
  if (/relatives?.*(?:employed|work)|family.*(?:employed|work)|close family members.*employed|currently employed by the company|currently employed by travelers|domestic partner|significant personal relationship|related to.*employee/.test(normalized)) return "No";
  if (/mortgage servicer/.test(normalized)) return "No";
  if (/military spouse|military domestic partner|in the reserves|\breserves\b/.test(normalized)) return "No";
  if (/board of directors|advisory board/.test(normalized)) return "No";
  if (/reside in the location.*job posting|within commutable distance/.test(normalized)) return "Yes";
  if (/base pay expectation|salary expectation|compensation expectation|desired salary/.test(normalized)) return getPhenomSalaryExpectation();
  if (/open to relocation|willing to relocate|relocation/.test(normalized)) return "No";
  if (/consent to receive messages?.*future job opportunities|future job opportunities.*methods/.test(normalized)) return "Do not contact me about future job opportunities.";
  if (/future opportunities|future roles|future job opportunities/.test(normalized)) return "Yes";
  if (/ai tool|artificial intelligence|reviewed by ai|use of ai/.test(normalized)) return "I consent to have my application reviewed by AI";
  if (/excluded|debarred|suspended|ineligible.*health care program|medicare|medicaid/.test(normalized)) return "No";
  if (/defense health agency|dha|political appointee/.test(normalized)) return "No";
  if (/spouse or partner.*military|serves served in the us military/.test(normalized)) return "No";
  if (/at least 18|18 years old/.test(normalized)) return "Yes";
  if (/involuntarily discharged|asked to resign/.test(normalized)) return "No";
  if (/government contractor|government entity|civil service|va hospital/.test(normalized)) return "No";
  if (/disciplinary action|professional license|certification|credentials/.test(normalized)) return "No";
  if (/windows forms.*net frameworks|net frameworks.*windows forms/.test(normalized)) return "1-4 Years";
  if (/highest level of education|education.*completed|level of education/.test(normalized)) return "Bachelor's Degree";
  if (/retail industry experience|retail.*experience/.test(normalized)) return "Less than 1";
  if (/declare.*responses|correct and complete|misrepresentation.*omission|authorize investigation/.test(normalized)) return "Yes";
  if (/5.*years.*designing.*developing.*testing.*supporting software applications/.test(normalized)) return "Yes";
  if (/specialty pharmacy/.test(normalized)) return "No";
  if (/veteran status|protected veteran/.test(normalized)) return "I am not a veteran";
  if (/gender|what is your sex/.test(normalized)) return "Choose Not to Disclose";
  if (/hispanic.*latino|latino descent/.test(normalized)) return "No";
  if (/ethnicity|race/.test(normalized)) return "I do not want to answer";
  return "";
}

function inferWorkdayPromptAnswerCandidates(label: string): string[] {
  const answer = inferWorkdayPromptAnswer(label);
  const normalized = normalizeQuestionText(label);
  const candidates = answer ? [answer] : [];
  if (/veteran status|protected veteran/.test(normalized)) {
    candidates.push(
      "I am not a Veteran (I did not serve in the military).",
      "I am not a Veteran",
      "I am not a veteran",
      "I AM NOT A VETERAN",
      "I am not a protected veteran.",
      "I am not a protected veteran",
      "I am not a protected Veteran",
      "I am not a U.S. military protected veteran",
      "Not a Veteran",
      "I do not wish to answer/choose not to identify my veteran status.",
      "I do not wish to answer",
      "No",
    );
  }
  if (/gender|what is your sex/.test(normalized)) {
    candidates.push(
      "Choose Not to Disclose",
      "Wish Not To Answer",
      "I choose not to disclose",
      "I do not wish to answer",
      "Decline to answer",
    );
  }
  if (/ethnicity|race/.test(normalized)) {
    candidates.push(
      "I choose not to disclose (United States of America)",
      "I choose not to disclose",
      "Wish Not To Answer (United States of America)",
      "Wish Not To Answer",
      "Choose Not to Disclose",
      "Not Declaring (United States of America)",
      "Not Declaring",
      "I do not wish to answer",
      "I don't wish to answer",
      "I do not want to answer",
      "I choose not to self-identify",
      "Decline to answer",
      "Decline to Self Identify",
    );
  }
  if (/windows forms.*net frameworks|net frameworks.*windows forms/.test(normalized)) {
    candidates.push("1 - 4 Years", "Less than 5 years");
  }
  if (/highest level of education|education.*completed|level of education/.test(normalized)) {
    candidates.push("Bachelor's Degree", "Bachelor Degree", "Bachelors", "Bachelor");
  }
  if (/open to relocation|willing to relocate|relocation/.test(normalized)) {
    candidates.push(
      "No",
      "No, I am not willing to relocate",
      "I am not willing to relocate",
    );
  }
  if (/future opportunities|future roles|future job opportunities/.test(normalized)) {
    candidates.push("Yes");
  }
  if (/ai tool|artificial intelligence|reviewed by ai|use of ai/.test(normalized)) {
    candidates.push(
      "Yes – I consent to letting AI tools review my application.",
      "Yes - I consent to letting AI tools review my application.",
      "I consent to have my application reviewed by AI",
      "Yes",
    );
  }
  if (/military spouse|military domestic partner|in the reserves|\breserves\b/.test(normalized)) {
    candidates.push("No");
  }
  if (/hispanic.*latino|latino descent/.test(normalized)) {
    candidates.push("No");
  }
  if (/outside audit firm|kpmg|pwc|price waterhouse|coopers lybrand|financial or business relationship|business relationship or affiliation/.test(normalized)) {
    candidates.push("Not True", "Not true", "No", "False");
  }
  if (/close family members.*employed|mortgage servicer/.test(normalized)) {
    candidates.push("No");
  }
  if (/sms|mms|text messages?/.test(normalized)) {
    candidates.push("Please do not send me SMS/MMS messages.", "Please do not send me SMS/MMS messages", "No");
  }
  if (/consent to receive messages?.*future job opportunities|future job opportunities.*methods/.test(normalized)) {
    candidates.push("Do not contact me about future job opportunities.", "Do not contact me about future job opportunities");
  }
  if (
    /submitted electronically|receipt of this application|true and complete|falsification|misrepresentation|required to sign|condition of employment|employment.*at will|conform to the rules|code of conduct|will not engage in any outside activity|conflict of interest|personal sales activities/.test(
      normalized,
    )
  ) {
    candidates.push("Yes, I agree", "I agree", "Yes", "True");
  }
  if (/non compete|non solicitation|restrict.*post employment|agreement.*interfere|agreement.*restrict/.test(normalized)) {
    candidates.push("No, I do not agree", "No", "Not True", "Not true");
  }
  if (/retail industry experience|retail.*experience/.test(normalized)) {
    candidates.push("Less than 1", "0-1 Years", "0 - 1 Years", "0 to 1 Years", "None");
  }
  if (/background check|declare.*responses|correct and complete|misrepresentation.*omission|authorize investigation/.test(normalized)) {
    candidates.push("Yes", "Yes.", "I agree", "I certify");
  }
  return dedupeText(candidates);
}

function inferWorkdayTextareaAnswer(label: string): string {
  const normalized = normalizeQuestionText(label);
  if (/base pay expectation|salary expectation|compensation expectation|desired salary/.test(normalized)) {
    return getPhenomSalaryExpectation();
  }
  if (/reason for leaving|reason.*leave|why.*leav/.test(normalized)) {
    return "I am seeking a role aligned with long-term full-stack engineering work, stable production systems, and continued growth across backend, frontend, and cloud delivery.";
  }
  return "";
}

async function readWorkdayPromptContext(trigger: Locator): Promise<string> {
  return trigger
    .evaluate((node) => {
      const element = node as HTMLElement;
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const parents: HTMLElement[] = [];
      for (let parent = element.parentElement; parent && parents.length < 8; parent = parent.parentElement) {
        parents.push(parent);
      }
      const containers = [
        element.closest("fieldset"),
        element.closest('[data-automation-id^="formField"]'),
        element.closest('[data-automation-id="formField"]'),
        ...parents,
      ].filter(Boolean) as HTMLElement[];
      for (const container of containers) {
        const text = read(container.textContent);
        if (text && text.length <= 2000) return text;
      }
      return read(element.getAttribute("aria-label")) || read(element.textContent);
    })
    .catch(() => "");
}

async function readWorkdayCheckboxLabel(checkbox: Locator): Promise<string> {
  return checkbox
    .evaluate((node) => {
      const input = node as HTMLInputElement;
      const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const labels = Array.from(input.labels ?? [])
        .map((label) => read(label.textContent))
        .filter(Boolean);
      if (labels.length > 0) {
        return labels.join(" ");
      }

      if (input.id) {
        const matchingLabel = Array.from(document.querySelectorAll("label")).find(
          (label) => label.getAttribute("for") === input.id,
        );
        const labelText = read(matchingLabel?.textContent);
        if (labelText) {
          return labelText;
        }
      }

      const ariaLabel = read(input.getAttribute("aria-label"));
      if (ariaLabel) {
        return ariaLabel;
      }

      const container = input.closest("label, [role='checkbox'], [data-automation-id='checkboxPanel']");
      return read(container?.textContent);
    })
    .catch(() => "");
}

async function clickWorkdayVisibleOptionByText(page: Page, candidate: string): Promise<boolean> {
  return page
    .evaluate((candidateText) => {
      const normalize = (value: string | null | undefined) =>
        (value ?? "")
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replace(/[_-]+/g, " ")
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const isVisible = (element: Element) => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const isInsideVisibleListViewport = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        const listbox = element.closest<HTMLElement>('[role="listbox"], [data-automation-id="activeListContainer"]');
        if (!listbox) {
          return centerX >= 0 && centerY >= 0 && centerX <= window.innerWidth && centerY <= window.innerHeight;
        }
        const listRect = listbox.getBoundingClientRect();
        return (
          centerX >= listRect.x &&
          centerX <= listRect.x + listRect.width &&
          centerY >= listRect.y &&
          centerY <= listRect.y + listRect.height
        );
      };
      const clickElement = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2,
          button: 0,
        };
        for (const eventName of [
          "pointerover",
          "pointerenter",
          "mouseover",
          "mouseenter",
          "pointerdown",
          "mousedown",
          "pointerup",
          "mouseup",
          "click",
        ]) {
          const event = eventName.startsWith("pointer")
            ? new PointerEvent(eventName, { ...init, pointerType: "mouse" })
            : new MouseEvent(eventName, init);
          element.dispatchEvent(event);
        }
      };

      const desired = normalize(candidateText);
      if (!desired) return false;

      const options = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="listbox"] [role="option"], [data-automation-id="promptOption"], [id^="menuItem-"], [role="option"]',
        ),
      ).filter((element) => isVisible(element) && isInsideVisibleListViewport(element));
      const option =
        options.find((element) => normalize(element.textContent) === desired) ||
        options.find((element) => normalize(element.textContent).startsWith(desired)) ||
        options.find((element) => normalize(element.textContent).includes(desired));
      if (!option) return false;

      const target = option.closest<HTMLElement>('[role="option"], [data-automation-id="promptOption"], [id^="menuItem-"]') || option;
      clickElement(target);
      return true;
    }, candidate)
    .catch(() => false);
}

async function runWorkdayQuestionnaireAutofill(page: Page): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const filled: string[] = [];
  const skipped: string[] = [];
  const prompts = page.locator(
    'button[id^="primaryQuestionnaire--"], button[id^="secondaryQuestionnaire--"], button[id^="supplementaryQuestionnaire--"], button#personalInfoUS--veteranStatus, button#personalInfoUS--gender, button#personalInfoUS--ethnicity',
  );
  const count = await prompts.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const prompt = prompts.nth(index);
    if (!(await prompt.isVisible().catch(() => false))) continue;

    const currentValue = tidy(await readWorkdayPromptValue(prompt).catch(() => ""));
    if (isMeaningfulValue(currentValue) && !/select one/i.test(currentValue)) {
      filled.push(currentValue);
      continue;
    }

    const context = await readWorkdayPromptContext(prompt);
    const answers = inferWorkdayPromptAnswerCandidates(context);
    if (answers.length === 0) {
      skipped.push(cleanExtractedLabel(context) || "Workday prompt");
      continue;
    }

    const applied = await selectWorkdayPromptValue(page, prompt, answers);
    if (applied) {
      filled.push(cleanExtractedLabel(context) || answers[0]);
    } else {
      skipped.push(cleanExtractedLabel(context) || answers[0]);
    }
  }

  const textareas = page.locator(
    'textarea[id^="primaryQuestionnaire--"], textarea[id^="secondaryQuestionnaire--"], textarea[id^="supplementaryQuestionnaire--"]',
  );
  const textareaCount = await textareas.count().catch(() => 0);
  for (let index = 0; index < textareaCount; index += 1) {
    const textarea = textareas.nth(index);
    if (!(await textarea.isVisible().catch(() => false))) continue;

    const context = await readWorkdayPromptContext(textarea);
    const label = cleanExtractedLabel(context) || "Workday textarea";
    const currentValue = tidy(await textarea.inputValue().catch(() => ""));
    if (isMeaningfulValue(currentValue)) {
      filled.push(label);
      continue;
    }

    const answer = inferWorkdayTextareaAnswer(context);
    if (!answer) {
      skipped.push(label);
      continue;
    }

    const applied = await setEditableFieldValue(page, textarea, "textarea", answer);
    if (applied) {
      filled.push(label);
    } else {
      skipped.push(label);
    }
  }

  const checkboxes = page.locator('input[type="checkbox"]');
  const checkboxCount = await checkboxes.count().catch(() => 0);
  for (let index = 0; index < checkboxCount; index += 1) {
    const checkbox = checkboxes.nth(index);
    if (!(await checkbox.isVisible().catch(() => false))) continue;

    const optionLabel = await readWorkdayCheckboxLabel(checkbox);
    const context = `${await readWorkdayPromptContext(checkbox)} ${optionLabel}`;
    const normalizedContext = normalizeQuestionText(context);
    const normalizedOption = normalizeQuestionText(optionLabel);
    if (
      !/federal government|defense health agency|dha|political appointee/.test(normalizedContext) ||
      !/^(no|none of the above)$/.test(normalizedOption)
    ) {
      continue;
    }

    const applied = await setWorkdayCheckboxValue(page, checkbox, true);
    if (applied) {
      filled.push(cleanExtractedLabel(context) || "Workday federal employment answer");
    } else {
      skipped.push(cleanExtractedLabel(context) || "Workday federal employment answer");
    }
  }

  const terms = page
    .locator('#termsAndConditions--acceptTermsAndAgreements, input[name="acceptTermsAndAgreements"]')
    .first();
  if (await terms.isVisible().catch(() => false)) {
    const accepted = await setWorkdayCheckboxValue(page, terms, true);
    if (accepted) filled.push("Workday Terms");
    else skipped.push("Workday Terms");
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function runWorkdayDirectAutofill(
  page: Page,
  profile: Profile,
): Promise<Pick<AutofillPassResult, "filled" | "skipped">> {
  const siteKind = await detectApplicationSiteKind(page);
  if (siteKind !== "workday" || (await isWorkdayCreateAccountGate(page)) || (await isWorkdaySignInGate(page))) {
    return { filled: [], skipped: [] };
  }

  const filled: string[] = [];
  const skipped: string[] = [];
  const [firstName, ...lastNameParts] = profile.name.split(/\s+/).filter(Boolean);
  const explicitAnswers = await loadApplicationAnswers();
  const educationInstitution =
    lookupApplicationAnswer(explicitAnswers, "institution", "text") ||
    lookupApplicationAnswer(explicitAnswers, "school", "text") ||
    lookupApplicationAnswer(explicitAnswers, "university", "text") ||
    "";
  const educationProgram =
    lookupApplicationAnswer(explicitAnswers, "field of study", "text") ||
    lookupApplicationAnswer(explicitAnswers, "program", "text") ||
    lookupApplicationAnswer(explicitAnswers, "major", "text") ||
    "";
  const educationLevel =
    lookupApplicationAnswer(explicitAnswers, "education level", "select") ||
    lookupApplicationAnswer(explicitAnswers, "highest level of education", "select") ||
    "Bachelor's Degree";
  const knownFields: Array<{ selector: string; value: string; label: string }> = [
    { selector: "#name--legalName--firstName", value: firstName || "", label: "Workday First Name" },
    { selector: "#name--legalName--lastName", value: lastNameParts.join(" "), label: "Workday Last Name" },
    { selector: "#address--addressLine1", value: profile.streetAddress, label: "Workday Address Line 1" },
    { selector: "#address--addressLine2", value: profile.addressLine2, label: "Workday Address Line 2" },
    { selector: "#address--city", value: profile.city || profile.location, label: "Workday City" },
    { selector: "#address--postalCode", value: profile.postalCode, label: "Workday Postal Code" },
    { selector: "#phoneNumber--phoneNumber", value: profile.phone, label: "Workday Phone Number" },
    { selector: "#selfIdentifiedDisabilityData--name", value: profile.name, label: "Workday Disability Name" },
    {
      selector: 'input[id^="education-"][id$="--school"], input[id*="school" i][id^="education-"]',
      value: educationInstitution,
      label: "Workday Education School",
    },
    {
      selector: 'input[id^="education-"][id$="--fieldOfStudy"], input[id*="fieldOfStudy" i][id^="education-"]',
      value: educationProgram,
      label: "Workday Education Field of Study",
    },
    {
      selector: 'input[id^="education-"][id$="--firstYearAttended-dateSectionYear-input"]',
      value: "2017",
      label: "Workday Education Start Year",
    },
    {
      selector: 'input[id^="education-"][id$="--lastYearAttended-dateSectionYear-input"]',
      value: "2021",
      label: "Workday Education End Year",
    },
  ];
  for (const config of knownFields) {
    const field = page.locator(config.selector).first();
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }

    const currentValue = tidy(await field.inputValue().catch(() => ""));
    if (isMeaningfulValue(currentValue)) {
      if (
        config.selector === "#address--addressLine2" &&
        !config.value.trim() &&
        matchesDesiredChoice(currentValue, profile.streetAddress)
      ) {
        const cleared = await setEditableFieldValue(page, field, "input", "");
        if (cleared) {
          filled.push(config.label);
        } else {
          skipped.push(config.label);
        }
        continue;
      }

      filled.push(config.label);
      continue;
    }

    if (!config.value.trim()) {
      skipped.push(config.label);
      continue;
    }

    const applied = await setEditableFieldValue(page, field, "input", config.value);
    if (applied) {
      filled.push(config.label);
    } else {
      skipped.push(config.label);
    }
  }

  const educationSchoolApplied = await ensureWorkdayEducationSchoolSelected(page, [
    educationInstitution,
    "North Carolina State University",
    "NC State University",
  ]);
  if (educationSchoolApplied) {
    filled.push("Workday Education School");
  }

  for (const config of [
    {
      selector: 'input[id^="education-"][id$="--firstYearAttended-dateSectionYear-input"]',
      value: "2017",
      label: "Workday Education Start Year",
    },
    {
      selector: 'input[id^="education-"][id$="--lastYearAttended-dateSectionYear-input"]',
      value: "2021",
      label: "Workday Education End Year",
    },
  ]) {
    const currentValue = tidy(await page.locator(config.selector).first().inputValue().catch(() => ""));
    const applied = matchesDesiredChoice(currentValue, config.value) || (await typeWorkdayYearFromDisplay(page, config.selector, config.value));
    if (applied) {
      filled.push(config.label);
    } else {
      skipped.push(config.label);
    }
  }

  const salaryFields = page.locator('input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea');
  const salaryFieldCount = await salaryFields.count().catch(() => 0);
  for (let index = 0; index < salaryFieldCount; index += 1) {
    const field = salaryFields.nth(index);
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }
    const context = normalizeQuestionText(await readWorkdayPromptContext(field));
    if (!/salary|compensation|base pay|desired pay/.test(context)) {
      continue;
    }
    const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "input");
    const currentValue = tidy(await readFieldCurrentValue(field, tag).catch(() => ""));
    if (isMeaningfulValue(currentValue)) {
      filled.push("Workday Salary Expectation");
      continue;
    }
    const salaryValue = tag === "textarea" ? getPhenomSalaryExpectation() : (process.env.JAA_SALARY_NUMERIC || "165000").trim();
    const applied = await setEditableFieldValue(page, field, tag, salaryValue);
    if (applied) filled.push("Workday Salary Expectation");
    else skipped.push("Workday Salary Expectation");
  }

  const firstWorkExperienceFields: Array<{ selector: string; value: string; tag: "input" | "textarea"; label: string }> = [
    {
      selector: 'input[id^="workExperience-"][id$="--jobTitle"]',
      value: "Lead Developer / CTO",
      tag: "input",
      label: "Workday Work Experience Job Title",
    },
    {
      selector: 'input[id^="workExperience-"][id$="--companyName"]',
      value: "Stealth Startup",
      tag: "input",
      label: "Workday Work Experience Company",
    },
    {
      selector: 'input[id^="workExperience-"][id$="--location"]',
      value: "Raleigh, NC",
      tag: "input",
      label: "Workday Work Experience Location",
    },
    {
      selector: 'textarea[id^="workExperience-"][id$="--roleDescription"]',
      value:
        "Built backend systems and cloud infrastructure supporting retail-focused software deployments. Owned implementation across product logic, backend services, databases, and deployment workflows.",
      tag: "textarea",
      label: "Workday Work Experience Description",
    },
  ];
  for (const config of firstWorkExperienceFields) {
    const field = page.locator(config.selector).first();
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }
    const currentValue = tidy(await field.inputValue().catch(() => ""));
    if (isMeaningfulValue(currentValue)) {
      filled.push(config.label);
      continue;
    }
    const applied = await setEditableFieldValue(page, field, config.tag, config.value);
    if (applied) filled.push(config.label);
    else skipped.push(config.label);
  }

  const currentWorkCheckbox = page.locator('input[id^="workExperience-"][id$="--currentlyWorkHere"]').first();
  if (await currentWorkCheckbox.isVisible().catch(() => false)) {
    const applied =
      (await currentWorkCheckbox.isChecked().catch(() => false)) ||
      (await setWorkdayCheckboxValue(page, currentWorkCheckbox, true));
    if (applied) filled.push("Workday Current Work Experience");
    else skipped.push("Workday Current Work Experience");
  }

  const firstWorkStartMonthSegment = page
    .locator('div[id^="workExperience-"][id$="--startDate-dateSectionMonth"]')
    .first();
  if (await firstWorkStartMonthSegment.isVisible().catch(() => false)) {
    const currentStartYear = tidy(
      await page.locator('input[id^="workExperience-"][id$="--startDate-dateSectionYear-input"]').first().inputValue().catch(() => ""),
    );
    const applied =
      matchesDesiredChoice(currentStartYear, "2023") ||
      (await typeWorkdayMonthYearFromFirstSegment(
        page,
        'div[id^="workExperience-"][id$="--startDate-dateSectionMonth"]',
        "07",
        "2023",
      ));
    if (applied) filled.push("Workday Work Experience Start Date");
    else skipped.push("Workday Work Experience Start Date");
  }

  const resumePath = profile.resumeFilePath?.trim();
  const resumeSelectButton = page
    .locator('[data-automation-id="select-files"], button#resumeAttachments--attachments, button:has-text("Select files")')
    .first();
  if (resumePath && (await resumeSelectButton.isVisible().catch(() => false))) {
    const resumeExists = await access(resumePath, fsConstants.R_OK).then(() => true).catch(() => false);
    if (!resumeExists) {
      skipped.push("Workday Resume Upload");
    } else {
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 5_000 }).catch(() => null);
      const clicked =
        (await resumeSelectButton.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
        (await resumeSelectButton.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false));
      const chooser = clicked ? await chooserPromise : null;
      if (chooser) {
        const uploaded = await chooser.setFiles(resumePath).then(() => true).catch(() => false);
        await page.waitForTimeout(1_000).catch(() => undefined);
        if (uploaded) {
          filled.push("Workday Resume Upload");
        } else {
          skipped.push("Workday Resume Upload");
        }
      } else {
        const fileInputs = page.locator('input[type="file"]');
        const fileInputCount = await fileInputs.count().catch(() => 0);
        let uploaded = false;
        for (let index = 0; index < fileInputCount; index += 1) {
          uploaded = await fileInputs.nth(index).setInputFiles(resumePath).then(() => true).catch(() => false);
          if (uploaded) break;
        }
        await page.waitForTimeout(uploaded ? 3_000 : 500).catch(() => undefined);
        if (uploaded) {
          filled.push("Workday Resume Upload");
        } else {
          skipped.push("Workday Resume Upload");
        }
      }
    }
  }

  const educationDegreeField = page.locator('button[id^="education-"][id$="--degree"], button[name="degree"]').first();
  if (await educationDegreeField.isVisible().catch(() => false)) {
    const currentValue = tidy(await readWorkdayPromptValue(educationDegreeField).catch(() => ""));
    const applied =
      (isMeaningfulValue(currentValue) && !/select one/i.test(currentValue)) ||
      (await selectWorkdayPromptValue(page, educationDegreeField, [
        "Bachelors",
        "Bachelor's Degree",
        "Bachelor Degree",
        educationLevel,
        "Bachelor Level Degree",
        "Bachelor",
        "BS",
        "BA",
      ]));
    if (applied) {
      filled.push("Workday Education Degree");
    } else {
      skipped.push("Workday Education Degree");
    }
  }

  const educationFieldOfStudyField = page
    .locator('button[id^="education-"][id$="--fieldOfStudy"], button[name="fieldOfStudy"]')
    .first();
  if (educationProgram && (await educationFieldOfStudyField.isVisible().catch(() => false))) {
    const currentValue = tidy(await readWorkdayPromptValue(educationFieldOfStudyField).catch(() => ""));
    const applied =
      (isMeaningfulValue(currentValue) && !/select one/i.test(currentValue)) ||
      (await selectWorkdayPromptValue(page, educationFieldOfStudyField, [
        educationProgram,
        "Computer Information Systems",
        "Computer and Information Science",
        "Computer Science",
        "Information Systems",
      ]));
    if (applied) {
      filled.push("Workday Education Field of Study");
    } else {
      skipped.push("Workday Education Field of Study");
    }
  }

  const questionnaire = await runWorkdayQuestionnaireAutofill(page);
  filled.push(...questionnaire.filled);
  skipped.push(...questionnaire.skipped);

  const priorWorkerGroup = page.locator('fieldset:has(input[name="candidateIsPreviousWorker"])').first();
  if (await priorWorkerGroup.isVisible().catch(() => false)) {
    const noInput = priorWorkerGroup.locator('input[name="candidateIsPreviousWorker"][value="false"]').first();
    const noLabel = priorWorkerGroup.locator('label[for]').filter({ hasText: /^No$/ }).first();
    const priorWorkerApplied =
      (await noLabel.click({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
      (await noLabel.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false)) ||
      (await noInput.check({ timeout: 5_000 }).then(() => true).catch(() => false)) ||
      (await noInput.click({ timeout: 5_000, force: true }).then(() => true).catch(() => false)) ||
      (await noInput
        .evaluate((node) => {
          const input = node as HTMLInputElement;
          input.checked = true;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.dispatchEvent(new Event("click", { bubbles: true }));
          return input.checked;
        })
        .catch(() => false));
    if (priorWorkerApplied && (await noInput.isChecked().catch(() => false))) {
      filled.push("Workday Previous Worker");
    } else {
      skipped.push("Workday Previous Worker");
    }
  }

  const sourceField = page.locator("#source--source").first();
  if (await sourceField.isVisible().catch(() => false)) {
    const applied = await selectWorkdayPromptValue(page, sourceField, [
      "Linkedln",
      "LinkedIn (Ad Posting)",
      "Job Board-LinkedIn",
      "Job Board - LinkedIn",
      "Internet - Job Boards/Search Engines",
      "Paid Job Board",
      "Job Board or Online Posting",
      "LinkedIn",
      "LinkedIn Company page",
      "Social Media Page",
    ]);
    if (applied) {
      filled.push("Workday Source");
    } else {
      skipped.push("Workday Source");
    }
  }

  const stateField = page.locator("button#address--countryRegion").first();
  if (await stateField.isVisible().catch(() => false)) {
    const desiredState = expandUsStateName(profile.state);
    const applied = desiredState ? await selectWorkdayPromptValue(page, stateField, [desiredState]) : false;
    if (applied) {
      filled.push("Workday State");
    } else {
      skipped.push("Workday State");
    }
  }

  const phoneTypeField = page.locator("button#phoneNumber--phoneType").first();
  if (await phoneTypeField.isVisible().catch(() => false)) {
    const applied = await selectWorkdayPromptValue(page, phoneTypeField, ["Mobile", "Cell", "Cell Phone", "Cellular"]);
    if (applied) {
      filled.push("Workday Phone Type");
    } else {
      skipped.push("Workday Phone Type");
    }
  }

  const preferredNameCheckbox = page.locator('#name--preferredCheck, input[name="preferredCheck"]').first();
  if (await preferredNameCheckbox.isVisible().catch(() => false)) {
    const preferredApplied = await setCheckboxValue(preferredNameCheckbox, "no");
    if (preferredApplied) {
      filled.push("Workday Preferred Name");
    } else {
      skipped.push("Workday Preferred Name");
    }
  }

  const disabilityLanguageField = page.locator("button#selfIdentifiedDisabilityData--disabilityForm").first();
  if (await disabilityLanguageField.isVisible().catch(() => false)) {
    const currentValue = await readWorkdayPromptValue(disabilityLanguageField);
    const applied =
      matchesDesiredChoice(currentValue, "English") ||
      (await selectWorkdayPromptValue(page, disabilityLanguageField, ["English"]));
    if (applied) {
      filled.push("Workday Disability Language");
    } else {
      skipped.push("Workday Disability Language");
    }
  }

  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  const year = String(today.getFullYear());
  const disabilityDatePresent =
    (await page
      .locator(
        '[data-automation-id="formField-dateSignedOn"], #selfIdentifiedDisabilityData--dateSignedOn, [data-automation-id="dateIcon"]',
      )
      .first()
      .isVisible()
      .catch(() => false)) ||
    (await page.locator('input[id$="dateSectionMonth-input"]').count().then((count) => count > 0).catch(() => false));
  const keyboardDateApplied =
    disabilityDatePresent && (await typeWorkdayDateFromFirstSegment(page, month, day, year));
  if (keyboardDateApplied) {
    filled.push("Workday Disability Date");
  } else {
    const disabilityDatePickerApplied =
      disabilityDatePresent && (await selectWorkdayTodayFromDatePicker(page));
    if (disabilityDatePickerApplied) {
      filled.push("Workday Disability Date");
    }

    const disabilityDateFields: Array<{ selector: string; value: string; label: string }> = [
      {
        selector: 'input[id$="dateSectionMonth-input"]',
        value: month,
        label: "Workday Disability Date Month",
      },
      {
        selector: 'input[id$="dateSectionDay-input"]',
        value: day,
        label: "Workday Disability Date Day",
      },
      {
        selector: 'input[id$="dateSectionYear-input"]',
        value: year,
        label: "Workday Disability Date Year",
      },
    ];
    for (const fieldConfig of disabilityDateFields) {
      if (disabilityDatePickerApplied) {
        continue;
      }

      const field = page.locator(fieldConfig.selector).first();
      if ((await field.count().catch(() => 0)) === 0) {
        continue;
      }

      const currentValue = tidy(await field.inputValue().catch(() => ""));
      if (matchesDesiredChoice(currentValue, fieldConfig.value)) {
        filled.push(fieldConfig.label);
        continue;
      }

      const applied = await setEditableFieldValue(page, field, "input", fieldConfig.value);
      if (applied) {
        filled.push(fieldConfig.label);
      } else {
        skipped.push(fieldConfig.label);
      }
    }
  }

  const disabilityDeclineAppliedByLabel = await setWorkdayCheckboxByLabelText(
    page,
    /I\s+do\s+not\s+want\s+to\s+answer|I\s+do\s+not\s+wish\s+to\s+answer|decline\s+to\s+answer/i,
    true,
  );
  const disabilityNoLabel = page.getByText(/No,\s*I do not have a disability/i).first();
  const disabilityNoAppliedByLabel =
    !disabilityDeclineAppliedByLabel &&
    (await setWorkdayCheckboxByLabelText(
      page,
      /No,\s*I do not have a disability/i,
      true,
    ));
  if (disabilityDeclineAppliedByLabel) {
    filled.push("Workday Disability Status");
  } else if (disabilityNoAppliedByLabel) {
    filled.push("Workday Disability Status");
  } else if (await disabilityNoLabel.isVisible().catch(() => false)) {
    const disabilityCheckboxes = page.locator('input[type="checkbox"][id$="-disabilityStatus"]');
    const disabilityCheckboxCount = await disabilityCheckboxes.count().catch(() => 0);
    const noCheckbox = disabilityCheckboxes.nth(1);
    const applied =
      (disabilityCheckboxCount >= 2 && (await setWorkdayCheckboxValue(page, noCheckbox, true).catch(() => false))) ||
      (await disabilityNoLabel
        .click({ timeout: 5_000 })
        .then(
          async () =>
            disabilityCheckboxCount >= 2 &&
            ((await noCheckbox.isChecked().catch(() => false)) || (await setWorkdayCheckboxValue(page, noCheckbox, true))),
        )
        .catch(() => false)) ||
      (await disabilityNoLabel
        .click({ timeout: 5_000, force: true })
        .then(
          async () =>
            disabilityCheckboxCount >= 2 &&
            ((await noCheckbox.isChecked().catch(() => false)) || (await setWorkdayCheckboxValue(page, noCheckbox, true))),
        )
        .catch(() => false));
    if (applied) {
      filled.push("Workday Disability Status");
    } else {
      skipped.push("Workday Disability Status");
    }
  } else {
    const disabilityCheckboxes = page.locator('input[type="checkbox"][id$="-disabilityStatus"]');
    const visibleCount = await disabilityCheckboxes.count().catch(() => 0);
    if (visibleCount >= 2) {
      const noCheckbox = disabilityCheckboxes.nth(1);
      const current = await noCheckbox.isChecked().catch(() => false);
      const applied = current || (await setWorkdayCheckboxValue(page, noCheckbox, true));
      if (applied) {
        filled.push("Workday Disability Status");
      } else {
        skipped.push("Workday Disability Status");
      }
    }
  }

  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
  };
}

async function runWorkdaySignInAutofill(
  page: Page,
  profile: Profile,
  submit = false,
): Promise<Pick<AutofillPassResult, "filled" | "skipped"> & { advanced: boolean }> {
  const siteKind = await detectApplicationSiteKind(page);
  if (siteKind !== "workday" || !(await isWorkdaySignInGate(page))) {
    return { filled: [], skipped: [], advanced: false };
  }

  await openWorkdayEmailSignInPane(page).catch(() => undefined);
  const password = getWorkdayAccountPassword();
  const filled: string[] = [];
  const skipped: string[] = [];

  const emailFields = page.locator('input[autocomplete="email"], input[data-automation-id="email"], input[type="email"]');
  const emailCount = await emailFields.count().catch(() => 0);
  let emailFilled = false;
  for (let index = 0; index < emailCount; index += 1) {
    const field = emailFields.nth(index);
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }

    if (await setEditableFieldValue(page, field, "input", profile.email)) {
      emailFilled = true;
    }
  }
  if (emailFilled) {
    filled.push("Workday Sign In Email");
  } else if (emailCount > 0) {
    skipped.push("Workday Sign In Email");
  }

  const passwordFields = page.locator(
    'input[autocomplete="current-password"], input[data-automation-id="password"], input[type="password"]:not([id*="verify" i]):not([name*="verify" i])',
  );
  const passwordCount = await passwordFields.count().catch(() => 0);
  let passwordFilled = false;
  for (let index = 0; index < passwordCount; index += 1) {
    const field = passwordFields.nth(index);
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }

    if (!password) {
      skipped.push("Workday Sign In Password (set JAA_WORKDAY_PASSWORD)");
      continue;
    }

    if (await setEditableFieldValue(page, field, "input", password)) {
      passwordFilled = true;
    }
  }
  if (passwordFilled) {
    filled.push("Workday Sign In Password");
  } else if (passwordCount > 0 && !password) {
    skipped.push("Workday Sign In Password (set JAA_WORKDAY_PASSWORD)");
  } else if (passwordCount > 0) {
    skipped.push("Workday Sign In Password");
  }

  const result = {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    advanced: false,
  };

  if (!submit) {
    return result;
  }

  const signInAction = await findVisibleAction(page, [
    'button[data-automation-id="signInSubmitButton"]',
    '[data-automation-id="click_filter"][aria-label="Sign In"]',
    '[data-automation-id="click_filter"][aria-label="Submit"]',
  ]);
  if (!signInAction) {
    return result;
  }

  const clicked = await clickActionHandle(page, signInAction);
  if (!clicked) {
    return result;
  }

  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(1500).catch(() => undefined);
  return {
    ...result,
    advanced: true,
  };
}

function normalizeComparableUrl(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^mailto:/i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function isAcceptableEditableValue(currentValue: string, desiredValue: string): boolean {
  const current = tidy(currentValue);
  const desired = tidy(desiredValue);
  if (!current || !desired) {
    return false;
  }

  if (matchesDesiredChoice(current, desired) || normalizeQuestionText(current) === normalizeQuestionText(desired)) {
    return true;
  }

  if (/https?:\/\/|www\.|linkedin\.com|github\.com/i.test(`${current} ${desired}`)) {
    return normalizeComparableUrl(current) === normalizeComparableUrl(desired);
  }

  const currentDigits = current.replace(/\D/g, "");
  const desiredDigits = desired.replace(/\D/g, "");
  if (currentDigits.length >= 7 && desiredDigits.length >= 7) {
    return currentDigits.endsWith(desiredDigits) || desiredDigits.endsWith(currentDigits);
  }

  return false;
}

async function setEditableFieldValue(page: Page, field: Locator, tag: string, value: string): Promise<boolean> {
  if (tag === "select") {
    return selectNativeOption(field, [value]);
  }

  if (tag === "combobox") {
    const candidates = buildComboboxCandidateValues(value);
    const elementTag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => tag);
    await field.click({ timeout: 5000 }).catch(() => undefined);

    for (const candidate of candidates) {
      if (await clickVisibleOptionByText(page, candidate)) {
        return true;
      }

      const searchInput =
        elementTag === "button" ? field.locator("xpath=following-sibling::input[1]").first() : null;
      if (elementTag === "button") {
        await searchInput?.fill(candidate).catch(() => undefined);
      } else {
        await field.fill(candidate).catch(() => undefined);
      }
      await page
        .waitForSelector('[role="option"], [class*="result"], [class*="option"], [class*="Option"]', {
          timeout: elementTag === "button" ? 900 : 1500,
        })
        .catch(() => undefined);
      await page.waitForTimeout(elementTag === "button" ? 800 : 900).catch(() => undefined);
      if (await clickVisibleOptionByText(page, candidate)) {
        return true;
      }

      if (elementTag !== "button") {
        const keyboardTarget = searchInput ?? field;
        await keyboardTarget.press("ArrowDown").catch(() => undefined);
        await page.waitForTimeout(100).catch(() => undefined);
        await keyboardTarget.press("Enter").catch(() => undefined);
        await page.waitForTimeout(250).catch(() => undefined);
      } else {
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(150).catch(() => undefined);
      }

      const inputValue = tidy(await field.inputValue().catch(() => ""));
      const selectedValue = await readFieldCurrentValue(field, "combobox").catch(() => "");
      const searchValue = tidy(await searchInput?.inputValue().catch(() => ""));
      const textValue = tidy(await field.textContent().catch(() => ""));
      if (
        matchesDesiredChoice(inputValue, candidate) ||
        matchesDesiredChoice(selectedValue, candidate) ||
        matchesDesiredChoice(searchValue, candidate) ||
        matchesDesiredChoice(textValue, candidate)
      ) {
        return true;
      }
    }

    const inputValue = tidy(await field.inputValue().catch(() => ""));
    const selectedValue = await readFieldCurrentValue(field, "combobox").catch(() => "");
    const textValue = tidy(await field.textContent().catch(() => ""));
    return candidates.some(
      (candidate) =>
        matchesDesiredChoice(inputValue, candidate) ||
        matchesDesiredChoice(selectedValue, candidate) ||
        matchesDesiredChoice(textValue, candidate),
    );
  }

  if (tag === "textarea" || tag === "input") {
    await syncEditableFieldValue(page, field, tag, value).catch(() => undefined);
    await page.waitForTimeout(250).catch(() => undefined);
    const inputValue = await field.inputValue().catch(() => "");
    if (isAcceptableEditableValue(inputValue, value)) {
      return true;
    }

    if (await clickVisibleOptionByText(page, value)) {
      return true;
    }

    await field.press("ArrowDown").catch(() => undefined);
    await page.waitForTimeout(100).catch(() => undefined);
    await field.press("Enter").catch(() => undefined);
    await page.waitForTimeout(250).catch(() => undefined);
    const finalInputValue = await field.inputValue().catch(() => "");
    return isAcceptableEditableValue(finalInputValue, value) || normalizeQuestionText(value) === "united states";
  }

  await field.click({ timeout: 3000 }).catch(() => undefined);
  const applied = await field
    .evaluate((node, nextValue) => {
      const element = node as HTMLElement;
      element.innerText = nextValue as string;
      return element.innerText;
    }, value)
    .catch(() => "");
  return isMeaningfulValue(tidy(String(applied)));
}

async function syncEditableFieldValue(page: Page, field: Locator, tag: string, value: string): Promise<boolean> {
  if (tag !== "input" && tag !== "textarea") {
    return false;
  }

  const nextValue = tidy(value);
  if (!nextValue) {
    return false;
  }

  await field.scrollIntoViewIfNeeded().catch(() => undefined);
  await field
    .click({ timeout: 5_000 })
    .catch(() => field.click({ timeout: 5_000, force: true }).catch(() => undefined));
  await field.fill("").catch(() => undefined);
  await page.waitForTimeout(80).catch(() => undefined);
  await field.fill(nextValue).catch(() => undefined);
  await field.dispatchEvent("input").catch(() => undefined);
  await field.dispatchEvent("change").catch(() => undefined);
  await field.press("Tab").catch(() => undefined);
  await page.waitForTimeout(120).catch(() => undefined);

  let currentValue = await field.inputValue().catch(() => "");
  if (isAcceptableEditableValue(currentValue, nextValue)) {
    return true;
  }

  await field.fill("", { force: true, timeout: 2_000 }).catch(() => undefined);
  await field.fill(nextValue, { force: true, timeout: 2_000 }).catch(() => undefined);
  await field.dispatchEvent("input").catch(() => undefined);
  await field.dispatchEvent("change").catch(() => undefined);
  await field.dispatchEvent("blur").catch(() => undefined);
  await page.waitForTimeout(120).catch(() => undefined);
  currentValue = await field.inputValue().catch(() => "");
  if (isAcceptableEditableValue(currentValue, nextValue)) {
    return true;
  }

  const nativeValue = await field
    .evaluate((node, value) => {
      const input = node as HTMLInputElement | HTMLTextAreaElement;
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) {
        setter.call(input, value as string);
      } else {
        input.value = value as string;
      }
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: value as string,
        }),
      );
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      return input.value;
    }, nextValue)
    .catch(() => "");
  return isAcceptableEditableValue(nativeValue, nextValue);
}

async function readFieldCurrentValue(field: Locator, tag: string, type = ""): Promise<string> {
  if (type === "checkbox") {
    return (await isCheckboxChecked(field)) ? "Yes" : "";
  }

  if (tag === "select") {
    return field
      .evaluate((node) => {
        const select = node as HTMLSelectElement;
        const option = select.options[select.selectedIndex];
        const value = (select.value || "").trim();
        const text = (option?.textContent || "").replace(/\s+/g, " ").trim();
        if (!value || value === "-1000" || /^(not specified|select|select an option|choose|choose one)$/i.test(text)) {
          return "";
        }
        return text || value;
      })
      .catch(() => "");
  }

  if (tag === "combobox") {
    return field
      .evaluate((node) => {
        const element = node as HTMLElement;
        const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
        const inputValue = read((element as HTMLInputElement).value);
        const textValue = read(element.textContent);
        if (textValue && !/^(select|select one|select an option|choose|choose one)$/i.test(textValue)) {
          return textValue;
        }

        const ariaValue = read(element.getAttribute("aria-label"))
          .replace(/^(country|state|phone device type|phone type|country phone code)\s+/i, "")
          .replace(/\s+required$/i, "")
          .trim();
        if (ariaValue && !/^(select|select one|select an option|choose|choose one)$/i.test(ariaValue)) {
          return ariaValue;
        }

        const containers = [
          element.closest('[class*="select__control"]')?.parentElement,
          element.closest('[class*="select"]'),
          element.parentElement?.parentElement,
          element.parentElement,
        ].filter(Boolean) as HTMLElement[];
        for (const container of containers) {
          const selected = [
            read(container.querySelector('[class*="single-value"]')?.textContent),
            ...Array.from(container.querySelectorAll('[class*="multi-value"]')).map((item) =>
              read(item.textContent),
            ),
          ]
            .filter(Boolean)
            .join(" | ");
          if (selected) {
            return selected;
          }
        }
        return inputValue;
      })
      .catch(() => "");
  }

  if (tag === "input" || tag === "textarea") {
    return await field.inputValue().catch(() => "");
  }

  return tidy(await field.textContent().catch(() => ""));
}

async function runHeuristicAutofill(
  page: Page,
  profile: Profile,
  scope: LocatorScope = page,
): Promise<AutofillPassResult> {
  const explicitAnswers = await loadApplicationAnswers();
  const bank = await loadQuestionBank();
  const decisions: QuestionDecision[] = [];
  const filled: string[] = [];
  const skipped: string[] = [];
  const seenFingerprints = new Set<string>();

  const fieldLocator = scope.locator(
    'input, textarea, select, [contenteditable="true"], [role="combobox"], input[role="combobox"], button[aria-haspopup="listbox"]',
  );
  const fieldCount = await fieldLocator.count();
  for (let index = 0; index < fieldCount; index += 1) {
    const field = fieldLocator.nth(index);
    const question = await describeVisibleField(field);
    if (!question) continue;
    if (["file", "hidden", "radio", "password", "submit", "button"].includes(question.type)) {
      continue;
    }

    const currentValue = await readFieldCurrentValue(field, question.tag, question.type);

    const fingerprint = makeQuestionFingerprint(question);
    if (seenFingerprints.has(fingerprint)) {
      continue;
    }
    seenFingerprints.add(fingerprint);

    const explicitAnswer = lookupApplicationAnswer(explicitAnswers, question.label, question.type);
    const savedAnswer = lookupQuestionBankAnswer(bank, question.label, question.type, question.choices);
    const suggestion =
      suggestFormAnswer(question, profile, explicitAnswer, "application-answers") ??
      suggestFormAnswer(question, profile, savedAnswer);

    if (!suggestion) {
      if (isMeaningfulValue(currentValue)) {
        continue;
      }
      skipped.push(question.label);
      decisions.push({
        label: question.label,
        type: question.type,
        choices: question.choices,
        answer: "",
        status: "unanswered",
        source: "unanswered",
        seenAt: new Date().toISOString(),
      });
      continue;
    }

    const shouldOverwriteNoWithNotApplicable =
      /enter n\/?a|enter n a|if not applicable/i.test(question.label) &&
      matchesDesiredChoice(currentValue, "No") &&
      matchesDesiredChoice(suggestion.value, "N/A");
    if (isMeaningfulValue(currentValue) && !shouldOverwriteNoWithNotApplicable) {
      continue;
    }

    const applied =
      question.type === "checkbox"
        ? await setCheckboxValue(field, suggestion.value)
        : await setEditableFieldValue(page, field, question.tag, suggestion.value);
    if (applied) {
      filled.push(question.label);
      decisions.push({
        label: question.label,
        type: question.type,
        choices: question.choices,
        answer: suggestion.value,
        status: "answered",
        source: suggestion.source,
        seenAt: new Date().toISOString(),
      });
    } else {
      skipped.push(question.label);
      decisions.push({
        label: question.label,
        type: question.type,
        choices: question.choices,
        answer: "",
        status: "unanswered",
        source: "unanswered",
        seenAt: new Date().toISOString(),
      });
    }
  }

  const groupLocator = scope.locator(
    'fieldset, [role="radiogroup"], [data-automation-id="radioGroup"], .application-question',
  );
  const groupCount = await groupLocator.count();
  for (let index = 0; index < groupCount; index += 1) {
    const group = groupLocator.nth(index);
    const question = await describeVisibleRadioGroup(group);
    if (!question) continue;

    const fingerprint = makeQuestionFingerprint(question);
    if (seenFingerprints.has(fingerprint)) {
      continue;
    }
    seenFingerprints.add(fingerprint);

    const alreadySelected =
      (await group.locator('input[type="radio"]:checked').count().catch(() => 0)) > 0 ||
      (await group.locator('[aria-checked="true"]').count().catch(() => 0)) > 0;
    if (alreadySelected) {
      continue;
    }

    const explicitAnswer = lookupApplicationAnswer(explicitAnswers, question.label, question.type);
    const savedAnswer = lookupQuestionBankAnswer(bank, question.label, question.type, question.choices);
    const suggestion =
      suggestFormAnswer(question, profile, explicitAnswer, "application-answers") ??
      suggestFormAnswer(question, profile, savedAnswer);

    if (!suggestion) {
      skipped.push(question.label);
      decisions.push({
        label: question.label,
        type: question.type,
        choices: question.choices,
        answer: "",
        status: "unanswered",
        source: "unanswered",
        seenAt: new Date().toISOString(),
      });
      continue;
    }

    const applied = await clickRadioChoice(group, suggestion.value);
    if (applied) {
      filled.push(question.label);
      decisions.push({
        label: question.label,
        type: question.type,
        choices: question.choices,
        answer: suggestion.value,
        status: "answered",
        source: suggestion.source,
        seenAt: new Date().toISOString(),
      });
    } else {
      skipped.push(question.label);
      decisions.push({
        label: question.label,
        type: question.type,
        choices: question.choices,
        answer: "",
        status: "unanswered",
        source: "unanswered",
        seenAt: new Date().toISOString(),
      });
    }
  }

  await persistQuestionDecisions(decisions);
  return {
    filled: dedupeText(filled),
    skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
    decisions,
  };
}

async function listUnresolvedRequiredFields(scope: LocatorScope): Promise<string[]> {
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const fields = scope.locator(
    'input, textarea, select, [contenteditable="true"], [role="combobox"], input[role="combobox"], button[aria-haspopup="listbox"]',
  );
  const fieldCount = await fields.count().catch(() => 0);

  for (let index = 0; index < fieldCount; index += 1) {
    const field = fields.nth(index);
    const question = await describeVisibleField(field);
    if (!question || !question.required) {
      continue;
    }
    if (await isSatisfiedReactSelectField(field)) {
      continue;
    }
    if (shouldDeferRequiredValidation(question)) {
      continue;
    }
    if (["hidden", "submit", "button"].includes(question.type)) {
      continue;
    }
    if (
      question.type === "combobox" &&
      isMeaningfulValue(
        question.label
          .replace(/^(country|state|phone device type|phone type|country phone code)\s+/i, "")
          .replace(/\bRequired\b/gi, "")
          .trim(),
      )
    ) {
      continue;
    }

    const fingerprint = makeQuestionFingerprint(question);
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);

    let satisfied = false;
    if (question.type === "checkbox") {
      satisfied = await isCheckboxChecked(field);
    } else if (question.type === "file") {
      satisfied =
        (await field.evaluate((node) => (node as HTMLInputElement).files?.length ?? 0).catch(() => 0)) > 0;
    } else if (question.tag === "select" || question.tag === "input" || question.tag === "textarea") {
      satisfied = isMeaningfulValue(await readFieldCurrentValue(field, question.tag, question.type));
    } else {
      satisfied = isMeaningfulValue(await readFieldCurrentValue(field, question.tag, question.type));
    }

    if (!satisfied) {
      unresolved.push(question.label);
    }
  }

  const taleoDateFields = scope.locator('input[type="hidden"][id*="dv_cs_experience_"][id$=".inputrelevant"]');
  const taleoDateCount = await taleoDateFields.count().catch(() => 0);
  for (let index = 0; index < taleoDateCount; index += 1) {
    const field = taleoDateFields.nth(index);
    const relevant = await field
      .evaluate((node) => {
        const element = node as HTMLInputElement;
        const container = element.closest(".entity-block") || element.parentElement;
        if (!container) {
          return false;
        }

        const style = window.getComputedStyle(container);
        const rect = container.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .catch(() => false);
    if (!relevant) {
      continue;
    }

    const id = tidy(await field.getAttribute("id").catch(() => ""));
    const name = tidy(await field.getAttribute("name").catch(() => ""));
    const identifier = `${id} ${name}`;
    const label = labelFromKnownFieldIdentifier(identifier) || (await extractLocatorLabel(field)) || "Taleo date field";
    const required = (await hasRequiredMarker(field)) || labelHasRequiredMarker(label);
    if (!required || seen.has(makeQuestionFingerprint({ label, type: "hidden-date", required: true, choices: [] }))) {
      continue;
    }

    seen.add(makeQuestionFingerprint({ label, type: "hidden-date", required: true, choices: [] }));
    const value = tidy(await field.inputValue().catch(() => ""));
    if (!isMeaningfulValue(value)) {
      unresolved.push(label);
    }
  }

  const groups = scope.locator(
    'fieldset, [role="radiogroup"], [data-automation-id="radioGroup"], .application-question',
  );
  const groupCount = await groups.count().catch(() => 0);
  for (let index = 0; index < groupCount; index += 1) {
    const group = groups.nth(index);
    const question = await describeVisibleRadioGroup(group);
    if (!question || !question.required) {
      continue;
    }
    if (shouldDeferRequiredValidation(question)) {
      continue;
    }

    const fingerprint = makeQuestionFingerprint(question);
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);

    const selected =
      (await group.locator('input[type="radio"]:checked').count().catch(() => 0)) > 0 ||
      (await group.locator('[aria-checked="true"]').count().catch(() => 0)) > 0;
    if (!selected) {
      unresolved.push(question.label);
    }
  }

  return dedupeText(unresolved);
}

async function listUnresolvedWorkdayRequiredFields(page: Page): Promise<string[]> {
  const unresolved = await page.evaluate(() => {
    function __name<T>(target: T): T {
      return target;
    }

    const read = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const visible = (element: Element) => {
      const html = element as HTMLElement;
      const style = window.getComputedStyle(html);
      const rect = html.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const meaningful = (value: string) =>
      Boolean(value) && !/^(select|select one|select an option|choose|choose one|please select|not specified|not selected)$/i.test(value);
    const labelFromIdentifier = (identifier: string) =>
      identifier
        .replace(/^.*--/, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const cleanLabel = (label: string) =>
      read(label)
        .replace(/\bRequired\b/gi, "")
        .replace(/\*/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const labelFor = (element: HTMLElement) => {
      const id = element.getAttribute("id") || "";
      const name = element.getAttribute("name") || "";
      return cleanLabel(
        element.getAttribute("aria-label") ||
          (id ? read(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) : "") ||
          labelFromIdentifier(name || id) ||
          read(element.textContent),
      );
    };
    const valueFor = (element: HTMLElement) =>
      read((element as HTMLInputElement).value) || read(element.textContent);

    const missing: string[] = [];
    const seen = new Set<string>();
    const push = (label: string) => {
      const clean = cleanLabel(label);
      if (!clean || seen.has(clean.toLowerCase())) return;
      seen.add(clean.toLowerCase());
      missing.push(clean);
    };

    for (const group of Array.from(document.querySelectorAll("fieldset, [role='radiogroup']"))) {
      if (!visible(group)) continue;
      const radios = Array.from(group.querySelectorAll('input[type="radio"], [role="radio"]'));
      if (radios.length < 2) continue;
      const groupText = read(group.textContent);
      const required = /\*/.test(groupText) || /\bRequired\b/i.test(groupText);
      if (!required) continue;
      const selected = radios.some((radio) => {
        const input = radio as HTMLInputElement;
        return input.checked || radio.getAttribute("aria-checked") === "true";
      });
      if (!selected) {
        push(read(group.querySelector("legend")?.textContent) || read(group.getAttribute("aria-label")) || "Radio group");
      }
    }

    for (const element of Array.from(
      document.querySelectorAll('input:not([type="hidden"]), textarea, select, [role="combobox"], input[role="combobox"], button[aria-haspopup="listbox"]'),
    )) {
      if (!visible(element)) continue;
      const html = element as HTMLElement;
      const type =
        html.getAttribute("role") === "combobox" || html.getAttribute("aria-haspopup") === "listbox"
          ? "combobox"
          : html.getAttribute("type") || html.tagName.toLowerCase();
      if (/^(hidden|submit|button|reset|password)$/i.test(type)) continue;
      if (html.getAttribute("data-automation-id") === "beecatcher") continue;
      if (/utilityMenuButton|navigationItem|backToJobPosting|socialIcon|privacyLink/i.test(html.getAttribute("data-automation-id") || "")) continue;

      const label = labelFor(html);
      if (/^(settings|search|candidate home|job alerts|back to job posting|phone extension)$/i.test(label)) continue;
      const containerText = read(html.closest('[data-automation-id="formField"]')?.textContent);
      const required =
        /\bRequired\b/i.test(html.getAttribute("aria-label") || "") ||
        html.hasAttribute("required") ||
        html.getAttribute("aria-required") === "true" ||
        /\*/.test(containerText);
      if (!required) continue;

      if (type === "checkbox") {
        const input = html as HTMLInputElement;
        if (!input.checked && html.getAttribute("aria-checked") !== "true") push(label);
        continue;
      }

      if (type === "file") {
        if (((html as HTMLInputElement).files?.length ?? 0) === 0) push(label);
        continue;
      }

      if (!meaningful(valueFor(html))) {
        push(label);
      }
    }

    return missing;
  });

  return dedupeText(unresolved);
}

async function isSatisfiedReactSelectField(field: Locator): Promise<boolean> {
  return field
    .evaluate((node) => {
      const element = node as HTMLInputElement;
      if (element.tagName.toLowerCase() !== "input") {
        return false;
      }

      const container =
        element.closest(".select__container") ||
        element.closest(".select-shell") ||
        element.closest('[class*="select"]');
      if (!container) {
        return false;
      }

      const selected = container.querySelector(
        '.select__single-value, .select__multi-value, [class*="singleValue"], [class*="multiValue"]',
      );
      const text = (selected?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return Boolean(text) && !/^(select|select an option|choose|choose one|please select)$/.test(text);
    })
    .catch(() => false);
}

async function findLinkedInPrimaryAction(applyRoot: Locator): Promise<ActionHandle | null> {
  return findVisibleAction(applyRoot, [
    'button[aria-label*="submit" i]',
    'button:has-text("Submit application")',
    'button:has-text("Submit")',
    'button[aria-label*="review" i]',
    'button:has-text("Review")',
    'button[aria-label*="next" i]',
    'button:has-text("Next")',
    'button[aria-label*="continue" i]',
    'button:has-text("Continue")',
  ]);
}

function isLinkedInSearchResultsHref(value: string): boolean {
  return /linkedin\.com\/jobs\/search-results/i.test(value) || /currentJobId=/i.test(value);
}

async function findLinkedInPrimaryJobApplyControl(page: Page): Promise<ActionHandle | null> {
  const selectors = [
    'button[aria-label*="easy apply" i]',
    'a[aria-label*="easy apply" i]',
    'button[aria-label*="apply on company website" i]',
    'a[aria-label*="apply on company website" i]',
    'button[aria-label*="apply on employer website" i]',
    'a[aria-label*="apply on employer website" i]',
    'button[aria-label*="apply" i]',
    'a[aria-label*="apply" i]',
    'button:has-text("Easy Apply")',
    'a:has-text("Easy Apply")',
    'button:has-text("Apply")',
    'a:has-text("Apply")',
  ];

  let best: { score: number; action: ActionHandle } | null = null;

  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = Math.min(await matches.count().catch(() => 0), 20);

    for (let index = 0; index < count; index += 1) {
      const locator = matches.nth(index);
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      const label = await getActionLabel(locator);
      const href = tidy(await locator.getAttribute("href").catch(() => ""));
      const normalized = `${label} ${href}`.toLowerCase();
      if (!normalized.includes("apply")) {
        continue;
      }
      if (href && isLinkedInSearchResultsHref(href)) {
        continue;
      }
      if (label.length > 120) {
        continue;
      }

      const box = await locator.boundingBox().catch(() => null);
      const y = box?.y ?? 9_999;
      if (y > 900) {
        continue;
      }

      const score = y * 100 + index;
      if (!best || score < best.score) {
        best = {
          score,
          action: {
            label,
            locator,
          },
        };
      }
    }
  }

  return best?.action ?? null;
}

async function findLinkedInEasyApplyControl(page: Page): Promise<ActionHandle | null> {
  const action = await findLinkedInPrimaryJobApplyControl(page);
  if (!action) {
    return null;
  }

  const href = tidy(await action.locator.getAttribute("href").catch(() => ""));
  const normalized = `${action.label} ${href}`.toLowerCase();
  if (normalized.includes("easy apply") || /\/apply\//i.test(href)) {
    return action;
  }

  return null;
}

async function openLinkedInEasyApply(page: Page, action: ActionHandle): Promise<boolean> {
  const href = tidy(await action.locator.getAttribute("href").catch(() => ""));
  const directApplyUrl = /\/apply\//i.test(href) ? new URL(href, page.url()).toString() : "";
  const attempts: Array<() => Promise<void>> = [
    async () => {
      await action.locator.scrollIntoViewIfNeeded().catch(() => undefined);
      await action.locator.click({ timeout: 5000 });
    },
    async () => {
      await action.locator.click({ timeout: 5000, force: true });
    },
    async () => {
      await action.locator.evaluate((node) => {
        if (node instanceof HTMLElement) {
          node.click();
        }
      });
    },
  ];

  if (directApplyUrl) {
    attempts.push(async () => {
      await page.goto(directApplyUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    });
  }

  for (const attempt of attempts) {
    await attempt().catch(() => undefined);
    await page.waitForTimeout(1500).catch(() => undefined);

    if ((await findLinkedInApplyRoot(page)) || /\/apply\//i.test(page.url())) {
      return true;
    }
  }

  return Boolean(await findLinkedInApplyRoot(page));
}

async function dismissLinkedInPostSubmitPrompts(page: Page): Promise<void> {
  await clickFirstVisible(page, [
    'button:has-text("Done")',
    'button:has-text("Dismiss")',
    'button:has-text("Close")',
  ]).catch(() => undefined);
}

async function detectLinkedInSubmittedStatusText(page: Page): Promise<boolean> {
  const bodyText = normalizeQuestionText(await page.locator("body").innerText().catch(() => ""));
  return (
    bodyText.includes("application submitted") ||
    bodyText.includes("application sent") ||
    bodyText.includes("you ve applied") ||
    bodyText.includes("applied")
  );
}

async function detectLinkedInSubmissionSuccess(page: Page): Promise<boolean> {
  if (await detectLinkedInSubmittedStatusText(page)) {
    return true;
  }

  const applyRoot = await findLinkedInApplyRoot(page);
  return !applyRoot;
}

async function detectSiteSubmissionSuccess(page: Page): Promise<boolean> {
  const bodyText = normalizeQuestionText(await page.locator("body").innerText().catch(() => ""));
  return (
    bodyText.includes("application submitted") ||
    bodyText.includes("application was successfully submitted") ||
    bodyText.includes("thank you for applying") ||
    bodyText.includes("thank you for your job application") ||
    bodyText.includes("process completed") ||
    bodyText.includes("thanks for applying") ||
    bodyText.includes("we received your application") ||
    bodyText.includes("we ve received your application previously") ||
    bodyText.includes("received your application previously") ||
    bodyText.includes("your information has been uploaded successfully") ||
    bodyText.includes("you re all set") ||
    bodyText.includes("you ve already applied") ||
    bodyText.includes("already applied for this job") ||
    bodyText.includes("your application has been submitted") ||
    bodyText.includes("your application was successfully submitted") ||
    /thank|submitted|confirmation|success/.test(page.url().toLowerCase())
  );
}

function detectExternalCompletionRequirementFromText(bodyText: string): string {
  if (
    bodyText.includes("brief meritfirst video assessment") ||
    (bodyText.includes("meritfirst") && bodyText.includes("video assessment")) ||
    (bodyText.includes("have you completed") &&
      bodyText.includes("assessment") &&
      bodyText.includes("submit that first before applying"))
  ) {
    return "Required external MeritFirst video assessment has not been completed.";
  }

  if (
    bodyText.includes("try fuser and share a link to a flow") ||
    (bodyText.includes("sign up for a free account") &&
      bodyText.includes("make it public") &&
      bodyText.includes("enter that link here"))
  ) {
    return "Required external product exercise/link has not been completed.";
  }

  return "";
}

async function hasVisibleInputValueMatching(page: Page, pattern: RegExp): Promise<boolean> {
  return page
    .locator('input:not([type="hidden"]):visible, textarea:visible')
    .evaluateAll((elements, source) => {
      const regex = new RegExp(source, "i");
      return elements.some((element) => {
        const value = ((element as HTMLInputElement | HTMLTextAreaElement).value || "").trim();
        return regex.test(value);
      });
    }, pattern.source)
    .catch(() => false);
}

function detectProfileLocationEligibilityBlocker(rawBodyText: string, profile: Profile): string {
  const profileState = (profile.state || "").trim().toUpperCase();
  const profileStateName = expandUsStateName(profile.state || "").trim().toUpperCase();
  if (!profileState) {
    return "";
  }

  const stateListMatch =
    rawBodyText.match(/only accepting applicants from (?:the following )?(?:areas|states):?\s*([A-Z,\s]+)\.?/i) ||
    rawBodyText.match(/currently residing in one of (?:those|the following) (?:areas|states):?\s*([A-Z,\s]+)\.?/i);
  const allowedStates = [...new Set((stateListMatch?.[1].match(/\b[A-Z]{2}\b/g) ?? []).map((state) => state.toUpperCase()))];
  if (
    allowedStates.length > 0 &&
    /currently resid|current resid|only accepting applicants/i.test(rawBodyText) &&
    !allowedStates.includes(profileState) &&
    !allowedStates.map((state) => expandUsStateName(state).toUpperCase()).includes(profileStateName)
  ) {
    return `Role requires current residence in ${allowedStates.join(", ")}; profile state is ${profileStateName || profileState}.`;
  }

  return "";
}

async function detectSiteSubmissionBlocker(page: Page, profile?: Profile): Promise<string> {
  const rawBodyText = await page.locator("body").innerText().catch(() => "");
  const bodyText = normalizeQuestionText(rawBodyText);
  const locationEligibilityBlocker = profile ? detectProfileLocationEligibilityBlocker(rawBodyText, profile) : "";
  if (locationEligibilityBlocker) {
    return locationEligibilityBlocker;
  }

  if (/community\.workday\.com\/maintenance-page/i.test(page.url()) || /workday is currently unavailable|planned maintenance/.test(bodyText)) {
    return "Workday planned maintenance is blocking the employer application; retry after the outage window.";
  }

  const captchaChallenge = await detectEmployerCaptchaChallenge(page);
  if (captchaChallenge) {
    return captchaChallenge;
  }

  const externalCompletionBlocker = detectExternalCompletionRequirementFromText(bodyText);
  if (externalCompletionBlocker) {
    if (
      externalCompletionBlocker.includes("product exercise") &&
      (await hasVisibleInputValueMatching(page, /fuser\.studio/))
    ) {
      return "";
    }
    return externalCompletionBlocker;
  }

  if (/couldn t submit your application|flagged as possible spam|possible spam/.test(bodyText)) {
    return "Employer anti-spam rejected the submission.";
  }
  if (
    /application limit|application limits|reached your application limit|limit one application per role|two active applications/i.test(
      bodyText,
    )
  ) {
    return "Employer application limit prevented submission.";
  }
  if (
    /jobright\.ai/i.test(page.url()) &&
    /sign up to apply|already a member sign in|apply to .+ @/.test(bodyText)
  ) {
    return "Jobright requires account sign-up/sign-in before it can send the profile.";
  }
  if (/job not found|job you requested was not found|no longer accepting applications|this job is no longer available/.test(bodyText)) {
    return "Employer application page says this job is no longer available.";
  }

  return "";
}

function isTaxCreditSurveyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)surveyengine\.taxcreditco\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

async function completeTaxCreditSurveyOptOutIfPresent(page: Page): Promise<boolean> {
  if (!isTaxCreditSurveyUrl(page.url())) {
    return false;
  }

  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(800).catch(() => undefined);
  const optOut = page
    .locator('input[type="submit" i][value*="Opt Out" i], button:has-text("Opt Out"), a:has-text("Opt Out")')
    .first();
  if (!(await optOut.isVisible().catch(() => false))) {
    return false;
  }

  const clicked =
    (await optOut.click({ timeout: 10_000 }).then(() => true).catch(() => false)) ||
    (await optOut.click({ timeout: 10_000, force: true }).then(() => true).catch(() => false));
  if (!clicked) {
    return false;
  }

  await page.waitForTimeout(4_000).catch(() => undefined);
  await page.waitForURL(/completeinlineassessment|workdayjobs\.com|wd\d?\.myworkdayjobs\.com/i, {
    timeout: 12_000,
  }).catch(() => undefined);
  return true;
}

async function findLinkedInApplyRoot(page: Page): Promise<Locator | null> {
  const directSelectors = [
    ".jobs-easy-apply-content",
    ".jobs-easy-apply-modal",
    ".jobs-easy-apply-modal-content",
    '[data-test-modal-id="easy-apply-modal"]',
  ];

  for (const selector of directSelectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }

  const dialogs = page.getByRole("dialog");
  const dialogCount = await dialogs.count().catch(() => 0);
  for (let index = 0; index < Math.min(dialogCount, 3); index += 1) {
    const dialog = dialogs.nth(index);
    const visible = await dialog.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const hasApplySignals =
      (await dialog.locator(".jobs-easy-apply-content").count().catch(() => 0)) > 0 ||
      (await dialog.getByRole("button", { name: /next|review|submit|continue/i }).count().catch(() => 0)) > 0 ||
      (await dialog.locator('input, textarea, select, input[type="file"]').count().catch(() => 0)) > 0;

    if (hasApplySignals) {
      return dialog;
    }
  }

  return null;
}

async function buildLinkedInApplyReview(
  page: Page,
  draft: ExtractedJobDraft,
  notes: string[],
  hasEasyApply: boolean,
): Promise<LinkedInApplyReview> {
  const applyRoot = await findLinkedInApplyRoot(page);
  if (!applyRoot) {
    return {
      url: page.url(),
      title: draft.title,
      company: draft.company,
      hasEasyApply,
      stage: hasEasyApply ? "Easy Apply available on job page" : "Job page only",
      primaryAction: hasEasyApply ? "Open Easy Apply" : "No application open",
      fields: [],
      notes,
    };
  }

  const primaryAction =
    tidy(
      await applyRoot
        .getByRole("button", { name: /next|review|submit|continue/i })
        .first()
        .textContent()
        .catch(() => ""),
    ) || "Application modal open";

  if (/submit/i.test(primaryAction)) {
    notes.push("Reached a submit step. The flow stopped here without clicking submit.");
  }

  const stage =
    tidy(
      await applyRoot
        .locator('[aria-live="polite"], .jobs-easy-apply-content p, h2, h3')
        .first()
        .textContent()
        .catch(() => ""),
    ) || "Application modal inspected";

  const fields = await inspectApplicationFields(applyRoot);
  return {
    url: page.url(),
    title: draft.title,
    company: draft.company,
    hasEasyApply,
    stage,
    primaryAction,
    fields,
    notes,
  };
}

export async function reviewCurrentLinkedInApplication(headed = true): Promise<LinkedInApplyReview> {
  return withPersistentPage(headed, async (page) => {
    if (!page.url() || page.url() === "about:blank") {
      throw new Error("No active page found in the persistent browser profile.");
    }

    await waitForLinkedInJobPageReady(page);
    await waitForLinkedInApplyControls(page);
    const draft = await extractFromPage(page, "linkedin");
    const notes: string[] = [];

    const easyApplyButton = page.getByRole("button", { name: /easy apply/i }).first();
    const hasEasyApply = await easyApplyButton.isVisible().catch(() => false);

    if (hasEasyApply) {
      notes.push("Easy Apply button found.");
      await easyApplyButton.click({ timeout: 5000 }).catch(() => {
        notes.push("Easy Apply button was found but could not be clicked automatically.");
      });
      await page.waitForTimeout(1500);
    } else {
      notes.push("Easy Apply button not found on the current page.");
    }
    const review = await buildLinkedInApplyReview(page, draft, notes, hasEasyApply);
    await saveBrowserArtifact("linkedin-apply-review", review);
    return review;
  });
}

export async function reviewAttachedLinkedInApplication(): Promise<LinkedInApplyReview> {
  return withAttachedPage(async (page) => {
    await waitForLinkedInJobPageReady(page);
    await waitForLinkedInApplyControls(page);
    const review = await reviewPageLinkedInApplication(page);
    await saveBrowserArtifact("linkedin-apply-review-attached", review);
    return review;
  });
}

export async function captureAttachedCurrentPage(): Promise<ExtractedJobDraft> {
  return withAttachedPage(async (page) => {
    await waitForLinkedInJobPageReady(page);
    const source = new URL(page.url()).hostname;
    const extracted = await extractFromPage(page, source);
    await saveBrowserArtifact("capture-attached", extracted);
    return extracted;
  });
}

export async function captureAttachedCurrentPageContext(): Promise<{
  url: string;
  title: string;
  headings: string[];
  bodyText: string;
  siteKind: ApplicationSiteKind;
}> {
  return withAttachedPage(async (page) => {
    return buildAttachedCurrentPageContext(page);
  });
}

export async function captureAttachedCurrentFormPageContext(): Promise<{
  url: string;
  title: string;
  headings: string[];
  bodyText: string;
  siteKind: ApplicationSiteKind;
}> {
  return withAttachedFormPage(async (page) => {
    return buildAttachedCurrentPageContext(page);
  });
}

async function buildAttachedCurrentPageContext(page: Page): Promise<{
  url: string;
  title: string;
  headings: string[];
  bodyText: string;
  siteKind: ApplicationSiteKind;
}> {
  await page.waitForTimeout(400).catch(() => undefined);
  const headings = dedupeText(
    await page
      .locator("h1, h2, [role='heading']")
      .evaluateAll((elements) =>
        elements
          .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean),
      )
      .catch(() => [] as string[]),
  )
    .map((value) => cleanRepeatedText(value))
    .filter(Boolean)
    .slice(0, 8);

  return {
    url: page.url(),
    title: tidy(await page.title().catch(() => "")),
    headings,
    bodyText: tidy(await page.locator("body").innerText().catch(() => "")).slice(0, 5000),
    siteKind: await detectApplicationSiteKind(page),
  };
}

async function enrichJobPostingsOnPage(page: Page, urls: string[]): Promise<JobEnrichmentResult[]> {
  const startUrl = page.url();
  const results: JobEnrichmentResult[] = [];

  try {
    for (const rawUrl of urls) {
      const normalizedUrl = normalizeLinkedInJobUrl(rawUrl);

      try {
        await page.goto(normalizedUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1800);
        await expandLinkedInDescription(page);

        const blocked =
          page.url().includes("/authwall") ||
          page.url().includes("/login") ||
          page.url().includes("/checkpoint/");
        if (blocked) {
          results.push({
            inputUrl: rawUrl,
            normalizedUrl,
            success: false,
            draft: null,
            error: "LinkedIn redirected away from the job page. Make sure this browser session is logged in.",
          });
          continue;
        }

        const extracted = await extractFromPage(page, "linkedin");
        const normalizedDraftUrl = normalizeLinkedInJobUrl(extracted.url || normalizedUrl);
        const cleanedDraft: ExtractedJobDraft = {
          ...extracted,
          title: cleanRepeatedText(extracted.title),
          company: cleanRepeatedText(extracted.company),
          description: tidy(extracted.description).slice(0, 6000),
          url: normalizedDraftUrl,
        };

        const hasUsefulData =
          Boolean(cleanedDraft.description) ||
          cleanedDraft.title !== "Untitled role" ||
          cleanedDraft.company !== "Unknown company";

        results.push({
          inputUrl: rawUrl,
          normalizedUrl,
          success: hasUsefulData,
          draft: hasUsefulData ? cleanedDraft : null,
          error: hasUsefulData ? undefined : "The page loaded but no useful job details were extracted.",
        });
      } catch (error) {
        results.push({
          inputUrl: rawUrl,
          normalizedUrl,
          success: false,
          draft: null,
          error: error instanceof Error ? error.message : "unknown error",
        });
      }
    }
  } finally {
    if (startUrl && startUrl !== "about:blank") {
      await page
        .goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
        .catch(() => undefined);
      await page.waitForTimeout(1000).catch(() => undefined);
    }
  }

  return results;
}

export async function enrichAttachedJobPostings(urls: string[]): Promise<JobEnrichmentResult[]> {
  return withAttachedPage(async (page) => {
    const results = await enrichJobPostingsOnPage(page, urls);
    await saveBrowserArtifact("attached-job-enrichment", results);
    return results;
  });
}

export async function enrichPersistentJobPostings(
  urls: string[],
  headed = true,
): Promise<JobEnrichmentResult[]> {
  return withPersistentPage(headed, async (page) => {
    const results = await enrichJobPostingsOnPage(page, urls);
    await saveBrowserArtifact("persistent-job-enrichment", results);
    return results;
  });
}

export async function collectAttachedLinkedInJobs(startUrl?: string): Promise<JobCollectionItem[]> {
  return withAttachedPage(async (page) => {
    if (startUrl?.trim()) {
      await gotoAttachedUrl(page, startUrl);
    }

    const targets = await getAttachedLinkedInPreviewTargets(page);
    const jobs = targets.slice(0, 40).map((target) => ({
      title: target.title.replace(/with verification/gi, "").trim() || "Untitled role",
      company: target.company || "Unknown company",
      url: target.url,
      location: target.location,
      compensationText: "",
      estimatedMaxAnnualCompensation: null,
    }));

    await saveBrowserArtifact("linkedin-collection", jobs);
    return jobs;
  });
}

export async function screenAttachedLinkedInJobs(
  limit: number,
  options: {
    startUrl?: string;
    pageLimit?: number;
  } = {},
): Promise<AttachedLinkedInScreeningResult[]> {
  const startUrl = options.startUrl?.trim();
  const pageLimit = Math.max(1, options.pageLimit ?? 1);

  return withAttachedPage(async (page) => {
    if (startUrl) {
      await gotoAttachedUrl(page, startUrl);
      await page.waitForTimeout(1500).catch(() => undefined);
    }

    const results: AttachedLinkedInScreeningResult[] = [];

    for (let pageNumber = 1; pageNumber <= pageLimit && results.length < Math.max(limit, 0); pageNumber += 1) {
      await waitForLinkedInCollectionPageReady(page);
      const remaining = Math.max(limit, 0) - results.length;
      if (remaining <= 0) {
        break;
      }

      const pageResults = await screenLinkedInJobsOnPage(page, remaining);
      results.push(...pageResults);

      if (pageResults.length === 0 || results.length >= Math.max(limit, 0) || pageNumber >= pageLimit) {
        break;
      }

      const advanced = await advanceLinkedInCollectionPageOnPage(page).catch(() => false);
      if (!advanced) {
        break;
      }
    }

    await saveBrowserArtifact("linkedin-triage-results", results);
    return results;
  });
}

export async function openAttachedJob(url: string): Promise<void> {
  await withNewAttachedPage(async (page) => {
    const targetUrl = url.includes("linkedin.com/jobs/view/") ? normalizeLinkedInJobUrl(url) : url;
    preferredAttachedPageUrl = targetUrl;
    await gotoAttachedUrl(page, targetUrl);
    if (isLinkedInUrl(targetUrl)) {
      await waitForLinkedInJobPageReady(page);
    } else {
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(1500).catch(() => undefined);
    }
    preferredAttachedPageUrl = targetUrl;
  });
}

export async function openAttachedUrl(url: string): Promise<void> {
  await withAttachedPage(async (page) => {
    const targetUrl = url.includes("linkedin.com/jobs/view/") ? normalizeLinkedInJobUrl(url) : url;
    await gotoAttachedUrl(page, targetUrl);
    preferredAttachedPageUrl = targetUrl;
  });
}

export async function triageAttachedVisibleJobs(limit: number): Promise<
  Array<{
    title: string;
    company: string;
    url: string;
    action: "saved" | "dismissed" | "skipped";
    reasons: string[];
    score: number;
  }>
> {
  return withAttachedPage(async (page) => {
    const targets = (await getAttachedLinkedInPreviewTargets(page)).slice(0, Math.max(limit, 0));
    const results: Array<{
      title: string;
      company: string;
      url: string;
      action: "saved" | "dismissed" | "skipped";
      reasons: string[];
      score: number;
    }> = [];

    for (const target of targets) {
      let inspected:
        | {
            title: string;
            company: string;
            description: string;
            draft: ExtractedJobDraft;
            screening: WorkloadScreening;
          }
        | null = null;
      try {
        inspected = await inspectAttachedLinkedInPreviewTarget(page, target);
      } catch {
        results.push({
          title: target.title,
          company: target.company,
          url: target.url,
          action: "skipped",
          reasons: ["Could not open the LinkedIn job card."],
          score: 0,
        });
        continue;
      }

      const { title, company, description, draft, screening } = inspected;

      if (!description) {
        results.push({
          title,
          company,
          url: draft.url,
          action: "skipped",
          reasons: ["Could not retrieve the LinkedIn job description from the preview pane."],
          score: screening.score,
        });
        continue;
      }

      if (!screening.pass) {
        const dismissed = await clickLinkedInPreviewDismissButton(page, target);

        results.push({
          title,
          company,
          url: draft.url,
          action: dismissed ? "dismissed" : "skipped",
          reasons: screening.reasons,
          score: screening.score,
        });
        await page.waitForTimeout(800);
        continue;
      }

      const saveButton = page.locator(linkedInPreviewSaveSelectors.join(", ")).first();
      const saveText = tidy(await saveButton.textContent().catch(() => "")) || tidy(await saveButton.getAttribute("aria-label").catch(() => ""));
      const canSave = await saveButton.isVisible().catch(() => false);

      if (!canSave || /unsave|saved/i.test(saveText)) {
        results.push({
          title,
          company,
          url: draft.url,
          action: "skipped",
          reasons: ["Role passed the screen but the save button was not available or was already saved."],
          score: screening.score,
        });
        continue;
      }

      const saved = await clickLinkedInPreviewSaveButton(page);
      results.push({
        title,
        company,
        url: draft.url,
        action: saved ? "saved" : "skipped",
        reasons: screening.reasons,
        score: screening.score,
      });
      await page.waitForTimeout(800);
    }

    await saveBrowserArtifact("linkedin-triage-results", results);
    return results;
  });
}

export async function clickAttachedLinkedInPreview(index: number): Promise<ExtractedJobDraft> {
  return withAttachedPage(async (page) => {
    const targets = await getAttachedLinkedInPreviewTargets(page);
    if (index < 0 || index >= targets.length) {
      throw new Error(`Preview index ${index} is out of range. Found ${targets.length} visible jobs.`);
    }

    return openAttachedLinkedInPreviewTarget(page, targets[index]);
  });
}

export async function openAttachedLinkedInPreview(url: string): Promise<ExtractedJobDraft> {
  return withAttachedPage(async (page) => {
    const target = await findAttachedLinkedInPreviewTarget(page, url);
    if (!target) {
      throw new Error(`Could not find a visible LinkedIn preview entry for ${normalizeLinkedInJobUrl(url)}.`);
    }

    return openAttachedLinkedInPreviewTarget(page, target);
  });
}

export async function saveAttachedCurrentLinkedInJob(): Promise<{
  status: "saved" | "already-saved" | "unavailable";
  label: string;
}> {
  return withAttachedPage(async (page) => {
    await waitForLinkedInPreviewPaneReady(page);

    const draft = await extractFromPage(page, "linkedin");
    const label = `${cleanRepeatedText(draft.title) || "Untitled role"} @ ${cleanRepeatedText(draft.company) || "Unknown company"}`;

    const saveButton = page.locator(linkedInPreviewSaveSelectors.join(", ")).first();

    const visible = await saveButton.isVisible().catch(() => false);
    if (!visible) {
      return { status: "unavailable", label };
    }

    const beforeText = tidy(await saveButton.textContent().catch(() => "")) || tidy(await saveButton.getAttribute("aria-label").catch(() => ""));
    if (/saved|unsave/i.test(beforeText)) {
      return { status: "already-saved", label };
    }

    const clicked = await clickLinkedInPreviewSaveButton(page);
    if (!clicked) {
      return { status: "unavailable", label };
    }

    await page.waitForTimeout(600).catch(() => undefined);
    const afterText = tidy(await saveButton.textContent().catch(() => "")) || tidy(await saveButton.getAttribute("aria-label").catch(() => ""));
    if (/saved|unsave/i.test(afterText)) {
      return { status: "saved", label };
    }

    return { status: "saved", label };
  });
}

async function advanceLinkedInCollectionPageOnPage(page: Page): Promise<boolean> {
  const currentUrl = page.url();
  const nextButtonSelectors = [
    'button[aria-label*="next" i]',
    'a[aria-label*="next" i]',
    ".artdeco-pagination__button--next",
  ];

  for (const selector of nextButtonSelectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    const disabled =
      (await locator.getAttribute("disabled").catch(() => null)) !== null ||
      (await locator.getAttribute("aria-disabled").catch(() => "")) === "true";

    if (!visible || disabled) {
      continue;
    }

    const clicked = await locator.click({ timeout: 10000 }).then(() => true).catch(() => false);
    if (!clicked) {
      continue;
    }

    await page.waitForTimeout(2500);
    if (page.url() !== currentUrl) {
      return true;
    }
  }

  const nextUrl = new URL(currentUrl);
  const currentStart = Number.parseInt(nextUrl.searchParams.get("start") || "0", 10);
  nextUrl.searchParams.set("start", `${currentStart + 25}`);

  if (nextUrl.toString() === currentUrl) {
    return false;
  }

  await page.goto(nextUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  return page.url() !== currentUrl;
}

function isLinkedInAuthRedirect(page: Page): boolean {
  const currentUrl = page.url().toLowerCase();
  return currentUrl.includes("/authwall") || currentUrl.includes("/login") || currentUrl.includes("/checkpoint");
}

export async function screenPersistentLinkedInJobs(
  limit: number,
  options: {
    startUrl?: string;
    pageLimit?: number;
    headed?: boolean;
  } = {},
): Promise<AttachedLinkedInScreeningResult[]> {
  const startUrl = options.startUrl?.trim() || "https://www.linkedin.com/jobs/collections/remote-jobs/";
  const pageLimit = Math.max(1, options.pageLimit ?? 1);
  const headed = options.headed !== false;

  return withPersistentPage(headed, async (page) => {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500).catch(() => undefined);

    if (isLinkedInAuthRedirect(page)) {
      throw new Error(
        "LinkedIn redirected to login/authwall in the managed browser profile. Run `npm run cli -- browser open https://www.linkedin.com/jobs/` once in this profile, then rerun the save automation.",
      );
    }

    const results: AttachedLinkedInScreeningResult[] = [];

    for (let pageNumber = 1; pageNumber <= pageLimit && results.length < Math.max(limit, 0); pageNumber += 1) {
      await waitForLinkedInCollectionPageReady(page);
      const remaining = Math.max(limit, 0) - results.length;
      if (remaining <= 0) {
        break;
      }

      const pageResults = await screenLinkedInJobsOnPage(page, remaining);
      results.push(...pageResults);

      if (pageResults.length === 0 || results.length >= Math.max(limit, 0) || pageNumber >= pageLimit) {
        break;
      }

      const advanced = await advanceLinkedInCollectionPageOnPage(page).catch(() => false);
      if (!advanced) {
        break;
      }
    }

    await saveBrowserArtifact("linkedin-triage-results", results);
    return results;
  });
}

export async function advanceAttachedLinkedInCollectionPage(): Promise<boolean> {
  return withAttachedPage(async (page) => {
    return advanceLinkedInCollectionPageOnPage(page);
  });
}

async function clickFirstVisible(scope: LocatorScope, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    const clicked = await locator.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

async function getExternalApplyLink(page: Page): Promise<string> {
  const candidates = [
    'a[href]:has-text("Apply")',
    'a[href]:has-text("Apply on company site")',
    'a[href]:has-text("Apply on employer site")',
    'a[href]:has-text("Apply now")',
    'a[href]:has-text("Continue")',
    'a[aria-label*="on company website" i]',
    'a[aria-label*="on employer website" i]',
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    const href = tidy(await locator.getAttribute("href").catch(() => ""));
    const destination = extractExternalApplyDestination(href, page.url());
    if (destination) {
      return destination;
    }
  }

  return "";
}

async function resolveExternalApplyDestinationFromPage(
  page: Page,
  fallbackDestination = "",
  timeoutMs = 8000,
): Promise<string> {
  const initial = extractExternalApplyDestination(safePageUrl(page));
  if (initial) {
    return initial;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !page.isClosed()) {
    await page.waitForTimeout(250).catch(() => undefined);
    const current = extractExternalApplyDestination(safePageUrl(page));
    if (current) {
      return current;
    }
  }

  return extractExternalApplyDestination(fallbackDestination, safePageUrl(page)) || "";
}

async function clickExternalApplyControl(page: Page, fallbackDestination = ""): Promise<Page | null> {
  const selectors = [
    "button.jobs-apply-button",
    'button[aria-label*="on company website" i]',
    'button[aria-label*="on employer website" i]',
    'a[aria-label*="on company website" i]',
    'a[aria-label*="on employer website" i]',
    'a[href*="/safety/go/"][href*="url="]',
    'a:has-text("Apply on company site")',
    'a:has-text("Apply on employer site")',
    'a:has-text("Apply now")',
    'a:has-text("Apply")',
    'button:has-text("Apply")',
    'button:has-text("Apply now")',
    'button:has-text("Continue to application")',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;

    const allowContextPopupFallback = !process.env.JAA_BATCH_APPLY_CHILD;
    const currentPages = allowContextPopupFallback ? new Set(page.context().pages()) : null;
    const href = tidy(await locator.getAttribute("href").catch(() => ""));
    const label = await getActionLabel(locator).catch(() => "");
    const normalizedAction = `${label} ${href}`.toLowerCase();
    if (normalizedAction.includes("easy apply") || /\/jobs\/apply\//i.test(href)) {
      continue;
    }
    const knownDestination = extractExternalApplyDestination(href, page.url()) || fallbackDestination;
    const popupPromise = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
    const navigationPromise = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null);
    const clicked = await locator.click({ timeout: 10000 }).then(() => true).catch(() => false);
    if (!clicked) {
      continue;
    }

    const popup =
      (await popupPromise) ??
      (currentPages ? page.context().pages().find((candidate) => !currentPages.has(candidate)) ?? null : null);
    if (popup) {
      await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
      const popupUrl = safePageUrl(popup);
      const resolvedDestination = await resolveExternalApplyDestinationFromPage(popup, knownDestination);
      if (
        resolvedDestination &&
        popupUrl !== resolvedDestination &&
        (!popupUrl || popupUrl === "about:blank" || isLinkedInUrl(popupUrl))
      ) {
        await popup.goto(resolvedDestination, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
      }
      await popup.waitForTimeout(1200).catch(() => undefined);
      return popup;
    }

    await navigationPromise;
    const pageUrl = safePageUrl(page);
    const resolvedDestination = await resolveExternalApplyDestinationFromPage(page, knownDestination);
    if (
      resolvedDestination &&
      pageUrl !== resolvedDestination &&
      (!pageUrl || pageUrl === "about:blank" || isLinkedInUrl(pageUrl))
    ) {
      await page.goto(resolvedDestination, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
    }
    await page.waitForTimeout(1200).catch(() => undefined);
    return page;
  }

  return null;
}

async function activateExternalApplyFromLinkedIn(
  page: Page,
): Promise<{ destinationPage: Page; destinationUrl: string }> {
  const knownDestination = await getExternalApplyLink(page);
  const destinationPage = (await clickExternalApplyControl(page, knownDestination)) ?? page;
  const destinationUrl =
    (await resolveExternalApplyDestinationFromPage(destinationPage, knownDestination)) || knownDestination;

  return {
    destinationPage,
    destinationUrl,
  };
}

async function openJobsTrackerApplyTarget(
  page: Page,
  target: LinkedInPreviewTarget,
): Promise<{ page: Page; label: string; openedNewPage: boolean } | null> {
  const links = page.locator(`a[href*="/jobs/view/${target.jobId}"]`);
  const count = await links.count().catch(() => 0);
  let fallbackHref = target.url;

  for (let index = 0; index < count; index += 1) {
    const locator = links.nth(index);
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const text = tidy(await locator.textContent().catch(() => ""));
    const aria = tidy(await locator.getAttribute("aria-label").catch(() => ""));
    const href = tidy(await locator.getAttribute("href").catch(() => ""));
    const normalized = `${text} ${aria}`.toLowerCase();
    if (href) {
      fallbackHref = new URL(href, page.url()).toString();
    }

    if (!/easy apply|apply|view application/.test(normalized)) {
      continue;
    }

    const targetUrl = href ? new URL(href, page.url()).toString() : target.url;
    const newPage = await page.context().newPage();
    await newPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
    await newPage.waitForTimeout(1200).catch(() => undefined);
    return {
      page: newPage,
      label: text || aria || "Apply",
      openedNewPage: true,
    };
  }

  if (!fallbackHref) {
    return null;
  }

  const newPage = await page.context().newPage();
  await newPage.goto(fallbackHref, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
  await newPage.waitForTimeout(1200).catch(() => undefined);
  return {
    page: newPage,
    label: "Open job",
    openedNewPage: true,
  };
}

async function fillFirstVisible(
  scope: LocatorScope,
  selectors: string[],
  value: string,
): Promise<boolean> {
  if (!value.trim()) return false;

  for (const selector of selectors) {
    const field = scope.locator(selector).first();
    const visible = await field.isVisible().catch(() => false);
    if (!visible) continue;

    const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
    if (tag === "select") {
      await field.selectOption({ label: value }).catch(() => undefined);
      const currentValue = await field.inputValue().catch(() => "");
      if (currentValue) return true;
      continue;
    }

    await field.fill(value).catch(() => undefined);
    const currentValue = await field.inputValue().catch(() => "");
    if (currentValue) return true;
  }

  return false;
}

async function fillFirstMatchingField(
  page: Page,
  scope: LocatorScope,
  matcher: (field: ApplicationField) => boolean,
  value: string,
): Promise<boolean> {
  if (!value.trim()) return false;

  const fieldLocator = scope.locator(
    'input, textarea, select, [contenteditable="true"], [role="combobox"], input[role="combobox"], button[aria-haspopup="listbox"]',
  );
  const count = await fieldLocator.count();

  for (let index = 0; index < count; index += 1) {
    const field = fieldLocator.nth(index);
    const question = await describeVisibleField(field);
    if (!question || ["file", "hidden", "radio", "password", "submit", "button"].includes(question.type)) {
      continue;
    }

    if (!matcher({ label: question.label, type: question.type, required: question.required })) {
      continue;
    }

    const currentValue = await readFieldCurrentValue(field, question.tag, question.type);
    if (isMeaningfulValue(currentValue)) {
      return true;
    }

    const applied = await setEditableFieldValue(page, field, question.tag, value);
    if (applied) {
      return true;
    }
  }

  return false;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function fieldMatchesAny(field: ApplicationField, patterns: string[]): boolean {
  const haystack = normalizeQuestionText(`${field.label} ${field.type}`);
  return patterns.some((pattern) => haystack.includes(normalizeQuestionText(pattern)));
}

function shouldOverrideLinkedInPrefilledValue(label: string, currentValue: string, desiredValue: string): boolean {
  if (!isMeaningfulValue(currentValue) || !isMeaningfulValue(desiredValue)) {
    return false;
  }
  if (matchesDesiredChoice(currentValue, desiredValue)) {
    return false;
  }

  const normalizedLabel = normalizeQuestionText(label);
  return (
    /\b(first name|last name|full name|given name|surname|family name)\b/.test(normalizedLabel) ||
    /\b(email address|email|mobile phone|phone number|cellphone|phone country code)\b/.test(normalizedLabel)
  );
}

async function detectLinkedInEasyApplyLimit(page: Page): Promise<boolean> {
  const bodyText = normalizeQuestionText(await page.locator("body").innerText().catch(() => ""));
  return /reached today s easy apply limit|limit easy apply submissions|continue applying tomorrow/.test(bodyText);
}

async function runLinkedInApplication(
  page: Page,
  profile: Profile,
  options: AutofillExecutionOptions = {},
): Promise<AutofillResult> {
  await page.waitForTimeout(1000);
  const submit = options.submit === true;
  const envMaxSteps = Number(process.env.JAA_LINKEDIN_MAX_STEPS || process.env.JAA_FORM_MAX_STEPS || "");
  const configuredMaxSteps =
    Number.isFinite(envMaxSteps) && envMaxSteps > 0 ? Math.floor(envMaxSteps) : submit ? 28 : 1;
  const maxSteps = Math.max(1, options.maxSteps ?? configuredMaxSteps);
  const filled: string[] = [];
  const skipped: string[] = [];
  let submitted = false;

  const easyApplyControl = await findLinkedInEasyApplyControl(page);
  const hasEasyApply = Boolean(easyApplyControl && /easy apply/i.test(easyApplyControl.label));
  if (easyApplyControl && hasEasyApply) {
    await openLinkedInEasyApply(page, easyApplyControl);
  }

  if (await detectLinkedInSubmittedStatusText(page)) {
    return buildAutofillResult(filled, skipped, "Submitted", {
      stoppedBeforeSubmit: false,
      submitted: true,
      stopReason: "Application submitted.",
    });
  }

  if (await detectLinkedInEasyApplyLimit(page)) {
    return buildAutofillResult(filled, skipped, "Easy Apply limit reached", {
      stoppedBeforeSubmit: false,
      submitted: false,
      stopReason: "LinkedIn Easy Apply daily limit reached; continue applying tomorrow.",
    });
  }

  const attempts: Array<{ name: string; selectors: string[]; value: string }> = [
    {
      name: "phone",
      selectors: [
        'input[aria-label*="Phone" i]',
        'input[id*="phoneNumber"]',
        'input[name*="phoneNumber"]',
      ],
      value: profile.phone,
    },
    {
      name: "city",
      selectors: ['input[aria-label*="City" i]', 'input[name*="city"]'],
      value: profile.city || profile.location,
    },
    {
      name: "state",
      selectors: ['input[aria-label*="State" i]', 'input[name*="state"]'],
      value: profile.state,
    },
    {
      name: "email",
      selectors: ['input[aria-label*="Email" i]', 'input[type="email"]'],
      value: profile.email,
    },
    {
      name: "work authorization",
      selectors: ['input[aria-label*="work authorization" i]', 'input[aria-label*="authorized" i]'],
      value: profile.workAuthorization,
    },
    {
      name: "years of experience",
      selectors: ['input[aria-label*="years of experience" i]', 'input[aria-label*="experience" i]'],
      value: profile.yearsOfExperience,
    },
  ];

  for (let step = 0; step < maxSteps; step += 1) {
    if (await detectLinkedInSubmittedStatusText(page)) {
      return buildAutofillResult(filled, skipped, "Submitted", {
        stoppedBeforeSubmit: false,
        submitted: true,
        stopReason: "Application submitted.",
      });
    }

    const applyRoot = await findLinkedInApplyRoot(page);
    if (!applyRoot) {
      if (await detectLinkedInEasyApplyLimit(page)) {
        return buildAutofillResult(filled, skipped, "Easy Apply limit reached", {
          stoppedBeforeSubmit: false,
          submitted: false,
          stopReason: "LinkedIn Easy Apply daily limit reached; continue applying tomorrow.",
        });
      }

      return buildAutofillResult(
        filled,
        skipped,
        submitted ? "Submitted" : hasEasyApply ? "Open Easy Apply" : "Easy Apply not available",
        {
          stoppedBeforeSubmit: !submit,
          submitted,
          stopReason: submitted
            ? "Submit action clicked."
            : hasEasyApply
              ? "Easy Apply dialog was not detected."
              : "Easy Apply not available on the current page.",
        },
      );
    }

    for (const attempt of attempts) {
      const success = await fillFirstVisible(applyRoot, attempt.selectors, attempt.value);
      if (success) {
        filled.push(attempt.name);
      } else {
        skipped.push(attempt.name);
      }
    }

    const linkedInDirect = await runLinkedInDirectAutofill(page, applyRoot, profile);
    filled.push(...linkedInDirect.filled);
    skipped.push(...linkedInDirect.skipped);

    const uploads = await runFileAutofillWithinScope(page, applyRoot, profile);
    filled.push(...uploads.filled);
    skipped.push(...uploads.skipped);

    const heuristic = await runHeuristicAutofill(page, profile, applyRoot);
    filled.push(...heuristic.filled);
    skipped.push(...heuristic.skipped);

    const linkedInGreenhouseFallback = await runLinkedInGreenhouseFallbackAutofill(page, applyRoot, profile);
    filled.push(...linkedInGreenhouseFallback.filled);
    skipped.push(...linkedInGreenhouseFallback.skipped);

    const action = await findLinkedInPrimaryAction(applyRoot);
    const nextAction = action?.label || "No primary action detected";
    if (!submit) {
      return buildAutofillResult(filled, skipped, nextAction, {
        stoppedBeforeSubmit: true,
        submitted: false,
        stopReason: "Configured to stop before submit.",
      });
    }

    const unresolvedRequired = await listUnresolvedRequiredFields(applyRoot);
    if (unresolvedRequired.length > 0) {
      return buildAutofillResult(filled, skipped, nextAction, {
        stoppedBeforeSubmit: false,
        submitted,
        stopReason: `Required fields still missing: ${unresolvedRequired.slice(0, 4).join(", ")}`,
      });
    }

    if (!action) {
      return buildAutofillResult(filled, skipped, nextAction, {
        stoppedBeforeSubmit: false,
        submitted,
        stopReason: "No primary LinkedIn action was detected after autofill.",
      });
    }

    const pagesBeforeAction = new Set(page.context().pages());
    const previousActionUrl = page.url();
    const clicked = await clickActionHandle(page, action);
    if (!clicked) {
      return buildAutofillResult(filled, skipped, nextAction, {
        stoppedBeforeSubmit: false,
        submitted,
        stopReason: `Could not click the LinkedIn action: ${action.label}`,
      });
    }

    if (isLinkedInSubmitAction(action.label)) {
      submitted = true;
      await page.waitForTimeout(2500);
      await dismissLinkedInPostSubmitPrompts(page);
      return buildAutofillResult(filled, skipped, "Submitted", {
        stoppedBeforeSubmit: false,
        submitted: true,
        stopReason: (await detectLinkedInSubmissionSuccess(page))
          ? "Application submitted."
          : "Submit clicked; LinkedIn completion could not be confirmed.",
      });
    }

    await page.waitForTimeout(1500);
    if (await detectLinkedInSubmittedStatusText(page)) {
      return buildAutofillResult(filled, skipped, "Submitted", {
        stoppedBeforeSubmit: false,
        submitted: true,
        stopReason: "Application submitted.",
      });
    }
  }

  const applyRoot = await findLinkedInApplyRoot(page);
  const action = applyRoot ? await findLinkedInPrimaryAction(applyRoot) : null;
  if (await detectLinkedInSubmittedStatusText(page)) {
    return buildAutofillResult(filled, skipped, "Submitted", {
      stoppedBeforeSubmit: false,
      submitted: true,
      stopReason: "Application submitted.",
    });
  }

  return buildAutofillResult(filled, skipped, action?.label || "No primary action detected", {
    stoppedBeforeSubmit: false,
    submitted,
    stopReason: `Reached the LinkedIn automation step limit (${maxSteps}).`,
  });
}

export async function autofillAttachedLinkedInApplication(profile: Profile): Promise<AutofillResult> {
  return withAttachedPage(async (page) => {
    const result = await runLinkedInApplication(page, profile);
    await saveBrowserArtifact("linkedin-autofill", result);
    return result;
  });
}

export async function autoApplyAttachedLinkedInApplication(profile: Profile): Promise<AutofillResult> {
  return withAttachedPage(async (page) => {
    const result = await runLinkedInApplication(page, profile, { submit: true });
    await saveBrowserArtifact("linkedin-autofill", result);
    return result;
  });
}

export async function autoApplyLinkedInJobUrlDirect(
  url: string,
  profile: Profile,
): Promise<{
  attempted: boolean;
  review: LinkedInApplyReview;
  autofill: AutofillResult | null;
  external: ExternalApplyResult | null;
}> {
  return withNewAttachedPage(async (page) => {
    const targetUrl = normalizeLinkedInJobUrl(url);
    preferredAttachedPageUrl = targetUrl;
    await gotoAttachedUrl(page, targetUrl);
    await waitForLinkedInJobPageReady(page);
    await waitForLinkedInApplyControls(page);

    if (await detectLinkedInSubmittedStatusText(page)) {
      const draft = await extractFromPage(page, "linkedin");
      const review = await buildLinkedInApplyReview(
        page,
        draft,
        ["LinkedIn shows this application as submitted."],
        false,
      );
      const autofill = buildAutofillResult([], [], "Submitted", {
        stoppedBeforeSubmit: false,
        submitted: true,
        stopReason: "Application submitted.",
      });
      await saveBrowserArtifact("linkedin-autofill", autofill);
      return { attempted: true, review, autofill, external: null };
    }

    const review = shouldSkipLinkedInEasyApply()
      ? await (async () => {
          const draft = await extractFromPage(page, "linkedin");
          const easyApplyControl = await findLinkedInEasyApplyControl(page);
          const hasEasyApply = Boolean(easyApplyControl && /easy apply/i.test(easyApplyControl.label));
          return buildLinkedInApplyReview(
            page,
            draft,
            hasEasyApply
              ? ["Easy Apply button found but skipped because Easy Apply is disabled for this run."]
              : ["Easy Apply button not found on the current page."],
            hasEasyApply,
          );
        })()
      : await reviewPageLinkedInApplication(page);
    if (!review.hasEasyApply || shouldSkipLinkedInEasyApply()) {
      const notes: string[] = [];
      const sourceJobTitle = tidy(await page.locator("h1").first().textContent().catch(() => "")) || "Untitled role";
      const startUrl = page.url();
      const { destinationUrl } = await activateExternalApplyFromLinkedIn(page);

      if (!destinationUrl || isLinkedInUrl(destinationUrl)) {
        notes.push("No external employer application URL was found from this LinkedIn job page.");
        const external: ExternalApplyResult = {
          sourceJobUrl: targetUrl,
          sourceJobTitle,
          destinationUrl: startUrl,
          destinationTitle: tidy(await page.title()),
          externalApplyFound: false,
          autofill: null,
          review: null,
          notes,
        };
        await saveBrowserArtifact("external-apply-result", external);
        return { attempted: false, review, autofill: null, external };
      }

      if (page.url() !== destinationUrl) {
        await page.goto(destinationUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
        await page.waitForTimeout(2500).catch(() => undefined);
      }

      const siteKind = await detectApplicationSiteKind(page);
      if (siteKind === "workday") {
        await enterWorkdayApplicationFlowIfNeeded(page).catch(() => undefined);
        await page.waitForTimeout(800).catch(() => undefined);
      }

      const siteReview = await buildCurrentSiteFormReview(page);
      const siteAutofill = await runResolvedSiteFormAutofill(page, profile, { submit: true });
      if (siteAutofill.stopReason) {
        notes.push(siteAutofill.stopReason);
      }

      const external: ExternalApplyResult = {
        sourceJobUrl: targetUrl,
        sourceJobTitle,
        destinationUrl: page.url(),
        destinationTitle: tidy(await page.title()),
        siteKind: siteReview.siteKind,
        externalApplyFound: true,
        autofill: siteAutofill,
        review: siteReview,
        notes,
      };
      await saveBrowserArtifact("external-apply-result", external);
      return { attempted: false, review, autofill: null, external };
    }

    const autofill = await runLinkedInApplication(page, profile, { submit: true });
    await saveBrowserArtifact("linkedin-autofill", autofill);
    return { attempted: true, review, autofill, external: null };
  });
}

async function buildCurrentSiteFormReview(page: Page): Promise<SiteFormReview> {
  await page.waitForTimeout(1800);
  await acceptCookieBannerIfPresent(page).catch(() => undefined);
  const siteKind = await detectApplicationSiteKind(page);
  await enterSiteApplicationFlowIfNeeded(page, siteKind);
  await page.waitForTimeout(400).catch(() => undefined);
  const currentSiteKind = await detectApplicationSiteKind(page);
  const scope = await resolvePrimaryApplicationScope(page, currentSiteKind);
  const fields = await inspectApplicationFields(scope);
  const primaryAction = await getPrimaryActionText(page, currentSiteKind);
  const stage = await getApplicationStageText(page, currentSiteKind);
  const notes: string[] = [
    `Detected site adapter: ${currentSiteKind}.`,
    /submit/i.test(primaryAction)
      ? "The current page appears to have a submit action. Automation should stop before clicking it."
      : "Primary action does not appear to be final submit.",
  ];

  if (currentSiteKind === "workday" && (await isWorkdayCreateAccountGate(page))) {
    notes.push(
      isTruthyEnv(process.env.JAA_WORKDAY_REUSE_SESSION)
        ? "Workday session reuse is enabled. If an authenticated tenant session exists in this browser profile, review/autofill will try to continue past Create Account without submitting anything."
        : "This Workday page is still at the account gate. Set JAA_WORKDAY_REUSE_SESSION=1 in a browser profile that already has a signed-in Workday session to try continuing past Create Account.",
    );
  }

  return {
    url: page.url(),
    title: tidy(await page.title()),
    siteKind: currentSiteKind,
    stage,
    fields,
    primaryAction,
    notes,
  };
}

async function runCurrentSiteFormAutofill(
  page: Page,
  profile: Profile,
  options: AutofillExecutionOptions = {},
): Promise<AutofillResult> {
  if (/toasttab\.com\/jobs\//i.test(page.url())) {
    return runToastCareersAutofill(page, profile, options);
  }

  await page.waitForTimeout(1800);
  await acceptCookieBannerIfPresent(page).catch(() => undefined);
  const submit = options.submit === true;
  const siteBlocker = await readSiteAutomationBlocker(page);
  if (siteBlocker) {
    return buildAutofillResult([], [], "Manual review required", {
      stoppedBeforeSubmit: false,
      submitted: false,
      stopReason: siteBlocker,
    });
  }

  const initialSiteKind = await detectApplicationSiteKind(page);
  const envMaxSteps = Number(process.env.JAA_SITE_MAX_STEPS || process.env.JAA_FORM_MAX_STEPS || "");
  const defaultSubmitSteps =
    initialSiteKind === "workday"
      ? 40
      : initialSiteKind === "taleo"
        ? 16
        : initialSiteKind === "talemetry" || initialSiteKind === "phenom"
          ? 20
          : initialSiteKind === "successfactors"
            ? 20
          : initialSiteKind === "oraclehcm"
            ? 24
          : 12;
  const configuredMaxSteps =
    Number.isFinite(envMaxSteps) && envMaxSteps > 0 ? Math.floor(envMaxSteps) : submit ? defaultSubmitSteps : 1;
  const maxSteps = Math.max(1, options.maxSteps ?? configuredMaxSteps);
  const debugEnabled = isTruthyEnv(process.env.JAA_DEBUG_FORM_STEPS);
  const filled: string[] = [];
  const skipped: string[] = [];
  const debugSteps: NonNullable<AutofillResult["debugSteps"]> = [];
  const flushDebugSteps = async (): Promise<void> => {
    if (!debugEnabled) {
      return;
    }

    await saveBrowserDebugArtifact("site-form-autofill-debug-latest.json", {
      updatedAt: new Date().toISOString(),
      url: page.url(),
      submit,
      maxSteps,
      filled: dedupeText(filled),
      skipped: dedupeText(skipped.filter((label) => !filled.includes(label))),
      debugSteps,
    });
  };
  let submitted = false;
  const attempts: Array<{ name: string; value: string; patterns: string[] }> = [
    { name: "first name", value: profile.name.split(/\s+/)[0] || "", patterns: ["first name", "firstname", "given name"] },
    { name: "last name", value: profile.name.split(/\s+/).slice(1).join(" ") || "", patterns: ["last name", "lastname", "surname", "family name"] },
    { name: "full name", value: profile.name, patterns: ["full name", "your full name", "candidate full name"] },
    { name: "email", value: profile.email, patterns: ["email"] },
    { name: "phone", value: profile.phone, patterns: ["phone", "mobile", "telephone", "contact number", "primary contact"] },
    { name: "city", value: profile.city || profile.location, patterns: ["city"] },
    { name: "state", value: profile.state, patterns: ["state", "province", "region"] },
    { name: "postal code", value: profile.postalCode, patterns: ["postal code", "zip code", "zipcode"] },
    { name: "street address", value: profile.streetAddress, patterns: ["street address", "address line 1"] },
    { name: "address line 2", value: profile.addressLine2, patterns: ["address line 2", "address 2"] },
    { name: "location", value: profile.location, patterns: ["location"] },
    { name: "linkedin", value: profile.linkedinUrl, patterns: ["linkedin", "linked in"] },
    { name: "summary", value: profile.resumeSummary, patterns: ["summary", "cover letter", "about you", "why are you", "additional information"] },
    { name: "work authorization", value: profile.workAuthorization, patterns: ["work authorization", "authorized", "sponsorship", "visa"] },
    { name: "years of experience", value: profile.yearsOfExperience, patterns: ["years of experience", "how many years"] },
  ];

  for (let step = 0; step < maxSteps; step += 1) {
    await acceptCookieBannerIfPresent(page).catch(() => undefined);
    let siteKind = await detectApplicationSiteKind(page);
    const debugStep =
      debugEnabled
        ? {
            step: step + 1,
            url: page.url(),
            stage: await getApplicationStageText(page, siteKind),
            nextAction: "Starting step",
            fieldCount: 0,
            fieldPreview: [] as string[],
          }
        : null;
    if (debugStep) {
      debugSteps.push(debugStep);
      await flushDebugSteps();
    }
    if (debugStep) {
      debugStep.nextAction = "Entering application flow";
      await flushDebugSteps();
    }
    await enterSiteApplicationFlowIfNeeded(page, siteKind);
    siteKind = await detectApplicationSiteKind(page);
    if (debugStep) {
      debugStep.url = page.url();
      debugStep.stage = await getApplicationStageText(page, await detectApplicationSiteKind(page));
      debugStep.nextAction = "Checking employer authentication";
      await flushDebugSteps();
    }
    if (await completeTaxCreditSurveyOptOutIfPresent(page)) {
      if (debugStep) {
        debugStep.url = page.url();
        debugStep.stage = await getApplicationStageText(page, await detectApplicationSiteKind(page));
        debugStep.nextAction = "Completed tax-credit assessment opt-out";
        await flushDebugSteps();
      }
      continue;
    }
    if (await advanceWorkdayAuthentication(page, profile, submit)) {
      if (debugStep) {
        debugStep.url = page.url();
        debugStep.stage = await getApplicationStageText(page, await detectApplicationSiteKind(page));
        debugStep.nextAction = "Advanced Workday authentication";
        await flushDebugSteps();
      }
      continue;
    }
    if (await advanceTaleoAuthentication(page, profile, submit)) {
      if (debugStep) {
        debugStep.url = page.url();
        debugStep.stage = await getApplicationStageText(page, await detectApplicationSiteKind(page));
        debugStep.nextAction = "Advanced Taleo authentication";
        await flushDebugSteps();
      }
      continue;
    }
    if (siteKind === "workday") {
      const workdayAuthError = await readWorkdayAuthError(page);
      if (workdayAuthError) {
        if (debugStep) {
          debugStep.url = page.url();
          debugStep.stage = await getApplicationStageText(page, await detectApplicationSiteKind(page));
          debugStep.nextAction = `Workday auth error: ${workdayAuthError}`;
          await flushDebugSteps();
        }

        return buildAutofillResult(filled, skipped, "Workday authentication blocked", {
          stoppedBeforeSubmit: false,
          submitted,
          stopReason: workdayAuthError,
          debugSteps,
        });
      }
    }
    if (siteKind === "taleo") {
      const taleoAuthError = await readTaleoAuthBlocker(page);
      if (taleoAuthError) {
        if (debugStep) {
          debugStep.url = page.url();
          debugStep.stage = await getApplicationStageText(page, await detectApplicationSiteKind(page));
          debugStep.nextAction = `Taleo auth error: ${taleoAuthError}`;
          await flushDebugSteps();
        }

        return buildAutofillResult(filled, skipped, "Taleo authentication blocked", {
          stoppedBeforeSubmit: false,
          submitted,
          stopReason: taleoAuthError,
          debugSteps,
        });
      }
    }
    const captchaChallenge = await detectEmployerCaptchaChallenge(page);
    if (captchaChallenge) {
      if (debugStep) {
        debugStep.url = page.url();
        debugStep.stage = await getApplicationStageText(page, await detectApplicationSiteKind(page));
        debugStep.nextAction = captchaChallenge;
        await flushDebugSteps();
      }

      return buildAutofillResult(filled, skipped, "Manual verification required", {
        stoppedBeforeSubmit: false,
        submitted,
        stopReason: captchaChallenge,
        debugSteps,
      });
    }
    const pageBlocker = await detectSiteSubmissionBlocker(page, profile);
    if (pageBlocker) {
      if (debugStep) {
        debugStep.url = page.url();
        debugStep.stage = await getApplicationStageText(page, await detectApplicationSiteKind(page));
        debugStep.nextAction = pageBlocker;
        await flushDebugSteps();
      }

      return buildAutofillResult(filled, skipped, "Employer page blocked", {
        stoppedBeforeSubmit: false,
        submitted,
        stopReason: pageBlocker,
        debugSteps,
      });
    }
    if (submit && (await detectSiteSubmissionSuccess(page))) {
      if (debugStep) {
        debugStep.url = page.url();
        debugStep.stage = await getApplicationStageText(page, await detectApplicationSiteKind(page));
        debugStep.nextAction = "Application submitted";
        await flushDebugSteps();
      }

      return buildAutofillResult(filled, skipped, "Submitted", {
        stoppedBeforeSubmit: false,
        submitted: true,
        stopReason: "Application submitted.",
        debugSteps,
      });
    }
    await page.waitForTimeout(400).catch(() => undefined);
    if (debugStep) {
      debugStep.url = page.url();
      debugStep.stage = await getApplicationStageText(page, await detectApplicationSiteKind(page));
      debugStep.nextAction = "Resolving application scope";
      await flushDebugSteps();
    }
    const scope = await resolvePrimaryApplicationScope(page, siteKind);
    if (debugStep) {
      debugStep.nextAction = "Inspecting application fields";
      await flushDebugSteps();
    }
    const fields = siteKind === "workday" ? [] : await inspectApplicationFields(scope);
    const directSite = isDoverApplicationUrl(page.url())
      ? await runDoverDirectAutofill(page, profile)
      : siteKind === "paycor"
        ? await runPaycorNewtonDirectAutofill(page, profile)
      : siteKind === "smartrecruiters"
        ? await runSmartRecruitersDirectAutofill(page, profile)
          : siteKind === "greenhouse"
            ? await runGreenhouseCustomReactAutofill(page, profile)
            : siteKind === "rippling"
              ? await runRipplingDirectAutofill(page, profile)
              : siteKind === "ukg"
                ? await runUkgDirectAutofill(page, profile)
              : siteKind === "successfactors"
                ? await runSuccessFactorsDirectAutofill(page, profile, submit)
              : siteKind === "oraclehcm"
                ? await runOracleHcmDirectAutofill(page, profile, submit)
                : { filled: [], skipped: [], handled: false };
    filled.push(...directSite.filled);
    skipped.push(...directSite.skipped);
    if (directSite.submitted) {
      return buildAutofillResult(filled, skipped, "Submitted", {
        stoppedBeforeSubmit: false,
        submitted: true,
        stopReason: "Application submitted.",
        debugSteps,
      });
    }
    if (directSite.advanced) {
      continue;
    }
    const directSiteHandled = directSite.handled === true;

    if (!directSiteHandled) {
      for (const attempt of attempts) {
        const matchingFieldExists = fields.some((field) => fieldMatchesAny(field, attempt.patterns));
        if (!matchingFieldExists) {
          skipped.push(attempt.name);
          continue;
        }

        const success = await fillFirstMatchingField(
          page,
          scope,
          (field) => fieldMatchesAny(field, attempt.patterns),
          attempt.value,
        );

        if (success) {
          filled.push(attempt.name);
        } else {
          skipped.push(attempt.name);
        }
      }
    }

    const workdayAccount = await runWorkdayAccountAutofill(page, profile);
    filled.push(...workdayAccount.filled);
    skipped.push(...workdayAccount.skipped);

    const workdaySignIn = await runWorkdaySignInAutofill(page, profile, false);
    filled.push(...workdaySignIn.filled);
    skipped.push(...workdaySignIn.skipped);

    if (
      submit &&
      siteKind === "workday" &&
      !getWorkdayAccountPassword() &&
      ((await isWorkdayCreateAccountGate(page)) || (await isWorkdaySignInGate(page)))
    ) {
      const stopReason = getMissingWorkdayPasswordMessage();
      if (debugStep) {
        debugStep.url = page.url();
        debugStep.stage = await getApplicationStageText(page, siteKind);
        debugStep.nextAction = stopReason;
        await flushDebugSteps();
      }

      return buildAutofillResult(filled, skipped, "Workday authentication blocked", {
        stoppedBeforeSubmit: false,
        submitted,
        stopReason,
        debugSteps,
      });
    }

    const workdayDirect = await runWorkdayDirectAutofill(page, profile);
    filled.push(...workdayDirect.filled);
    skipped.push(...workdayDirect.skipped);

    const micro1 = await runMicro1DirectAutofill(page, profile);
    filled.push(...micro1.filled);
    skipped.push(...micro1.skipped);

    const hirebridge = await runHirebridgeDirectAutofill(page, profile);
    filled.push(...hirebridge.filled);
    skipped.push(...hirebridge.skipped);
    if (hirebridge.submitted) {
      return buildAutofillResult(filled, skipped, "Submitted", {
        stoppedBeforeSubmit: false,
        submitted: true,
        stopReason: "Application submitted.",
        debugSteps,
      });
    }
    if (hirebridge.advanced) {
      continue;
    }

    const dayforce = await runDayforceDirectAutofill(page, profile);
    filled.push(...dayforce.filled);
    skipped.push(...dayforce.skipped);
    if (dayforce.advanced) {
      continue;
    }

    if (siteKind === "workable") {
      const workable = await runWorkableDirectAutofill(page, profile);
      filled.push(...workable.filled);
      skipped.push(...workable.skipped);
    }

    if (siteKind === "phenom") {
      const phenom = await runPhenomDirectAutofill(page, profile);
      filled.push(...phenom.filled);
      skipped.push(...phenom.skipped);
      if (phenom.submitted) {
        return buildAutofillResult(filled, skipped, "Submitted", {
          stoppedBeforeSubmit: false,
          submitted: true,
          stopReason: "Application submitted.",
          debugSteps,
        });
      }
    }

    if (siteKind === "lever") {
      const lever = await runLeverDirectAutofill(page, scope, profile);
      filled.push(...lever.filled);
      skipped.push(...lever.skipped);
    }

    if (siteKind === "greenhouse" && !directSiteHandled) {
      const greenhouseHosted = await runGreenhouseHostedAutofill(page, scope, profile);
      filled.push(...greenhouseHosted.filled);
      skipped.push(...greenhouseHosted.skipped);
    }

    if (siteKind === "ashby") {
      const ashby = await runAshbyDirectAutofill(page, scope, profile);
      filled.push(...ashby.filled);
      skipped.push(...ashby.skipped);
    }

    if (siteKind === "taleo") {
      const taleo = await runTaleoDirectAutofill(page, profile);
      filled.push(...taleo.filled);
      skipped.push(...taleo.skipped);

      const taleoDocument = await runTaleoDocumentFrameAutofill(page, profile);
      filled.push(...taleoDocument.filled);
      skipped.push(...taleoDocument.skipped);
    }

    if (siteKind === "talemetry") {
      const talemetry = await runTalemetryDirectAutofill(page, profile);
      filled.push(...talemetry.filled);
      skipped.push(...talemetry.skipped);
      if (talemetry.advanced) {
        continue;
      }
    }

    const uploads = await runFileAutofillWithinScope(page, scope, profile);
    filled.push(...uploads.filled);
    skipped.push(...uploads.skipped);

    let heuristic: AutofillPassResult;
    if (siteKind === "workday") {
      page.setDefaultTimeout(1_000);
      try {
        heuristic = await runHeuristicAutofill(page, profile, scope);
      } finally {
        page.setDefaultTimeout(30_000);
      }
    } else if (siteKind === "talemetry") {
      heuristic = { filled: [], skipped: [], decisions: [] };
    } else {
      heuristic = await runHeuristicAutofill(page, profile, scope);
    }
    filled.push(...heuristic.filled);
    skipped.push(...heuristic.skipped);

    const currentSiteKind = await detectApplicationSiteKind(page);
    if (currentSiteKind === "ashby") {
      const forcedChoices = await forceAshbyYesNoChoices(scope);
      filled.push(...forcedChoices.filled);
      skipped.push(...forcedChoices.skipped);
    }
    if (currentSiteKind === "ukg") {
      await clearUkgNonApplicableRequiredFields(page);
    }

    const action = await findVisibleAction(page, getPrimaryActionSelectors(currentSiteKind));
    const nextAction = action?.label || "No primary action detected";
    if (debugStep) {
      debugStep.url = page.url();
      debugStep.stage = await getApplicationStageText(page, currentSiteKind);
      debugStep.nextAction = nextAction;
      debugStep.fieldCount = fields.length;
      debugStep.fieldPreview = fields.slice(0, 8).map((field) => `${field.label || "(unlabeled)"}|${field.type}`);
      await flushDebugSteps();
    }
    if (!submit) {
      return buildAutofillResult(filled, skipped, nextAction, {
        stoppedBeforeSubmit: true,
        submitted: false,
        stopReason: "Configured to stop before submit.",
        debugSteps,
      });
    }

    const unresolvedRequired =
      currentSiteKind === "workday" || currentSiteKind === "talemetry" || currentSiteKind === "ukg"
        ? []
        : await listUnresolvedRequiredFields(scope);
    if (unresolvedRequired.length > 0) {
      return buildAutofillResult(filled, skipped, nextAction, {
        stoppedBeforeSubmit: false,
        submitted,
        stopReason: `Required fields still missing: ${unresolvedRequired.slice(0, 4).join(", ")}`,
        debugSteps,
      });
    }

    if (!action) {
      if (await detectSiteSubmissionSuccess(page)) {
        return buildAutofillResult(filled, skipped, "Submitted", {
          stoppedBeforeSubmit: false,
          submitted: true,
          stopReason: "Application submitted.",
          debugSteps,
        });
      }

      const submissionBlocker = await detectSiteSubmissionBlocker(page, profile);
      if (submissionBlocker) {
        return buildAutofillResult(filled, skipped, "Employer page blocked", {
          stoppedBeforeSubmit: false,
          submitted,
          stopReason: submissionBlocker,
          debugSteps,
        });
      }

      return buildAutofillResult(filled, skipped, nextAction, {
        stoppedBeforeSubmit: false,
        submitted,
        stopReason: "No primary employer-form action was detected after autofill.",
        debugSteps,
      });
    }

    const pagesBeforeAction = new Set(page.context().pages());
    const previousActionUrl = page.url();
    const clicked = await clickActionHandle(page, action);
    if (!clicked) {
      if (currentSiteKind === "workday" && /create account/i.test(action.label)) {
        const openedSignIn = await openWorkdaySignInGate(page);
        if (openedSignIn) {
          continue;
        }
      }

      return buildAutofillResult(filled, skipped, nextAction, {
        stoppedBeforeSubmit: false,
        submitted,
        stopReason: `Could not click the employer-form action: ${action.label}`,
        debugSteps,
      });
    }

    if (debugStep) {
      debugStep.nextAction = `Clicked: ${action.label}`;
      await flushDebugSteps();
    }

    const clickedFinalAction = isSiteFinalAction(action.label);
    await page
      .waitForTimeout(
        clickedFinalAction
          ? currentSiteKind === "ashby"
            ? 7000
            : currentSiteKind === "oraclehcm" || currentSiteKind === "ukg" || currentSiteKind === "greenhouse"
              ? 10_000
              : currentSiteKind === "successfactors"
              ? 10_000
              : currentSiteKind === "phenom"
                ? 10_000
              : 2500
          : currentSiteKind === "phenom"
            ? 3000
            : 1500,
      )
      .catch(() => undefined);
    if (currentSiteKind === "ukg" && clickedFinalAction && (await handleUkgAttachmentChangedModal(page))) {
      await page.waitForTimeout(12_000).catch(() => undefined);
    }
    const openedPagesAfterAction = page
      .context()
      .pages()
      .filter((candidate) => !candidate.isClosed() && !pagesBeforeAction.has(candidate));
    const openedTaxCreditPage = openedPagesAfterAction.find((candidate) => isTaxCreditSurveyUrl(candidate.url()));
    if (openedTaxCreditPage) {
      await openedTaxCreditPage.bringToFront().catch(() => undefined);
      const completed = await completeTaxCreditSurveyOptOutIfPresent(openedTaxCreditPage);
      await page.bringToFront().catch(() => undefined);
      await page.waitForTimeout(3_000).catch(() => undefined);
      if (debugStep) {
        debugStep.nextAction = completed ? "Completed tax-credit assessment opt-out" : "Opened tax-credit assessment";
        await flushDebugSteps();
      }
      continue;
    }

    const openedApplicationPage = openedPagesAfterAction
      .map((candidate) => ({
        page: candidate,
        score: candidate.url() !== previousActionUrl ? scoreApplicationFormUrl(candidate.url()) : 0,
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.page;
    if (openedApplicationPage) {
      page = openedApplicationPage;
      await page.bringToFront().catch(() => undefined);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(1200).catch(() => undefined);
      continue;
    }

    if (currentSiteKind === "workday" && /create account/i.test(action.label) && (await isWorkdayCreateAccountGate(page))) {
      await openWorkdaySignInGate(page).catch(() => undefined);
      await page.waitForTimeout(1200).catch(() => undefined);
      continue;
    }

    if (clickedFinalAction) {
      const finalSiteKind = await detectApplicationSiteKind(page);
      const finalValidationErrors =
        finalSiteKind === "taleo" ? await readTaleoPageValidationErrors(page) : [];
      if (finalValidationErrors.length > 0) {
        return buildAutofillResult(filled, skipped, action.label, {
          stoppedBeforeSubmit: false,
          submitted: false,
          stopReason: `Employer page validation errors: ${finalValidationErrors.slice(0, 4).join("; ")}`,
          debugSteps,
        });
      }
      const finalBodyText = normalizeQuestionText(await page.locator("body").innerText().catch(() => ""));
      if (finalSiteKind === "ashby" && /your form needs corrections|missing entry for required field/.test(finalBodyText)) {
        const correctionBlocker = await detectSiteSubmissionBlocker(page, profile);
        if (correctionBlocker) {
          return buildAutofillResult(filled, skipped, action.label, {
            stoppedBeforeSubmit: false,
            submitted: false,
            stopReason: correctionBlocker,
            debugSteps,
          });
        }

        if (debugStep) {
          debugStep.nextAction = "Ashby returned corrections after submit; retrying autofill";
          await flushDebugSteps();
        }
        continue;
      }

      if (finalSiteKind === "ashby" && /couldn t submit your application|flagged as possible spam|possible spam/.test(finalBodyText)) {
        const retryAction = await findVisibleAction(page, getPrimaryActionSelectors(finalSiteKind));
        if (retryAction && isSiteFinalAction(retryAction.label)) {
          if (debugStep) {
            debugStep.nextAction = "Ashby flagged possible spam; retrying submit once";
            await flushDebugSteps();
          }
          const retried = await clickActionHandle(page, retryAction);
          if (retried) {
            await page.waitForTimeout(7000).catch(() => undefined);
            if (await detectSiteSubmissionSuccess(page)) {
              return buildAutofillResult(filled, skipped, "Submitted", {
                stoppedBeforeSubmit: false,
                submitted: true,
                stopReason: "Application submitted.",
                debugSteps,
              });
            }
          }
        }
      }

      const submissionBlocker = await detectSiteSubmissionBlocker(page, profile);
      if (submissionBlocker) {
        return buildAutofillResult(filled, skipped, action.label, {
          stoppedBeforeSubmit: false,
          submitted: false,
          stopReason: submissionBlocker,
          debugSteps,
        });
      }

      const submissionDetected = await detectSiteSubmissionSuccess(page);
      submitted = true;
      return buildAutofillResult(filled, skipped, "Submitted", {
        stoppedBeforeSubmit: false,
        submitted: submissionDetected,
        stopReason: submissionDetected ? "Application submitted." : `Final action clicked: ${action.label}`,
        debugSteps,
      });
    }
  }

  const siteKind = await detectApplicationSiteKind(page);
  const validationErrors = siteKind === "taleo" ? await readTaleoPageValidationErrors(page) : [];
  return buildAutofillResult(filled, skipped, await getPrimaryActionText(page, siteKind), {
    stoppedBeforeSubmit: false,
    submitted,
    stopReason: validationErrors.length
      ? `Employer page validation errors: ${validationErrors.slice(0, 4).join("; ")}`
      : `Reached the employer-form automation step limit (${maxSteps}).`,
    debugSteps,
  });
}

export async function reviewAttachedCurrentForm(): Promise<SiteFormReview> {
  return withAttachedFormPage(async (page) => {
    const review = await buildCurrentSiteFormReview(page);
    await saveBrowserArtifact("site-form-review", review);
    return review;
  });
}

export async function reviewCurrentSiteForm(headed = true): Promise<SiteFormReview> {
  return withPersistentPage(headed, async (page) => {
    if (!page.url() || page.url() === "about:blank") {
      throw new Error("No active page found in the persistent browser profile.");
    }

    const review = await buildCurrentSiteFormReview(page);
    await saveBrowserArtifact("site-form-review", review);
    return review;
  });
}

export async function autofillAttachedCurrentForm(profile: Profile): Promise<AutofillResult> {
  return withAttachedFormPage(async (page) => {
    const result = await runResolvedSiteFormAutofill(page, profile);
    await annotateAutofillResultWithPageState(page, result);
    await saveBrowserArtifact("site-form-autofill", result);
    return result;
  });
}

export async function autoApplyAttachedCurrentForm(profile: Profile): Promise<AutofillResult> {
  return withAttachedFormPage(async (page) => {
    const result = await runResolvedSiteFormAutofill(page, profile, { submit: true });
    await annotateAutofillResultWithPageState(page, result);
    await saveBrowserArtifact("site-form-autofill", result);
    return result;
  });
}

export async function autofillCurrentSiteForm(profile: Profile, headed = true): Promise<AutofillResult> {
  return withPersistentPage(headed, async (page) => {
    if (!page.url() || page.url() === "about:blank") {
      throw new Error("No active page found in the persistent browser profile.");
    }

    const result = await runCurrentSiteFormAutofill(page, profile);
    await annotateAutofillResultWithPageState(page, result);
    await saveBrowserArtifact("site-form-autofill", result);
    return result;
  });
}

export async function reviewSiteFormUrl(url: string, headed = false): Promise<SiteFormReview> {
  return withEphemeralPage(headed, async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const review = await buildCurrentSiteFormReview(page);
    await saveBrowserArtifact("site-form-review", review);
    return review;
  });
}

export async function autofillSiteFormUrl(
  url: string,
  profile: Profile,
  headed = false,
): Promise<AutofillResult> {
  return withEphemeralPage(headed, async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const result = await runCurrentSiteFormAutofill(page, profile);
    await annotateAutofillResultWithPageState(page, result);
    await saveBrowserArtifact("site-form-autofill", result);
    return result;
  });
}

export async function autoApplySiteFormUrl(
  url: string,
  profile: Profile,
  headed = false,
): Promise<AutofillResult> {
  if (isAshbyUrl(url) && (await isAttachedBrowserAvailable())) {
    return withNewAttachedPage(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.bringToFront().catch(() => undefined);
      const result = await runCurrentSiteFormAutofill(page, profile, { submit: true });
      await annotateAutofillResultWithPageState(page, result);
      await saveBrowserArtifact("site-form-autofill", result);
      return result;
    });
  }

  return withEphemeralPage(headed || isAshbyUrl(url), async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const result = await runCurrentSiteFormAutofill(page, profile, { submit: true });
    await annotateAutofillResultWithPageState(page, result);
    await saveBrowserArtifact("site-form-autofill", result);
    return result;
  });
}

export async function autofillAttachedSiteFormUrl(
  url: string,
  profile: Profile,
): Promise<AutofillResult> {
  return withAttachedPage(async (attachedPage) => {
    const page = await attachedPage.context().newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.bringToFront().catch(() => undefined);
    const result = await runResolvedSiteFormAutofill(page, profile);
    await annotateAutofillResultWithPageState(page, result);
    await saveBrowserArtifact("site-form-autofill", result);
    return result;
  });
}

export async function processAttachedExternalJob(
  sourceJobUrl: string,
  profile: Profile,
  options: AutofillExecutionOptions = {},
): Promise<ExternalApplyResult> {
  const withPage = options.isolatedPage ? withNewAttachedPage : withAttachedPage;
  return withPage(async (page) => {
    const notes: string[] = [];
    await page.goto(sourceJobUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    const sourceJobTitle = tidy(await page.locator("h1").first().textContent().catch(() => "")) || "Untitled role";
    const startUrl = page.url();

    const runEmployerDestination = async (): Promise<ExternalApplyResult> => {
      const siteKind = await detectApplicationSiteKind(page);
      if (siteKind === "workday") {
        await enterWorkdayApplicationFlowIfNeeded(page).catch(() => undefined);
        await page.waitForTimeout(800);
      }

      const review = await buildCurrentSiteFormReview(page);

      const autofill = await runResolvedSiteFormAutofill(page, profile, options);
      if (autofill.stopReason) {
        notes.push(autofill.stopReason);
      }

      const result: ExternalApplyResult = {
        sourceJobUrl,
        sourceJobTitle,
        destinationUrl: page.url(),
        destinationTitle: tidy(await page.title()),
        siteKind: review.siteKind,
        externalApplyFound: true,
        autofill,
        review,
        notes,
      };

      await saveBrowserArtifact("external-apply-result", result);
      return result;
    };

    if (!isLinkedInUrl(sourceJobUrl)) {
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(1800).catch(() => undefined);
      return runEmployerDestination();
    }

    await waitForLinkedInJobPageReady(page);
    await waitForLinkedInApplyControls(page);

    const { destinationUrl } = await activateExternalApplyFromLinkedIn(page);

    if (!destinationUrl || isLinkedInUrl(destinationUrl)) {
      notes.push("No external employer application URL was found from this LinkedIn job page.");
      const result: ExternalApplyResult = {
        sourceJobUrl,
        sourceJobTitle,
        destinationUrl: startUrl,
        destinationTitle: tidy(await page.title()),
        externalApplyFound: false,
        autofill: null,
        review: null,
        notes,
      };
      await saveBrowserArtifact("external-apply-result", result);
      return result;
    }

    if (page.url() !== destinationUrl) {
      await page.goto(destinationUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
      await page.waitForTimeout(2500);
    }

    return runEmployerDestination();
  });
}

export async function processAttachedExternalJobFromPreview(
  previewIndex: number,
): Promise<ExternalApplyResult> {
  return withAttachedPage(async (page) => {
    const notes: string[] = [];
    const collectionUrl = page.url();
    const cards = page.locator('a[href*="/jobs/view/"]');
    const count = await cards.count();
    if (previewIndex < 0 || previewIndex >= count) {
      throw new Error(`Preview index ${previewIndex} is out of range. Found ${count} cards.`);
    }

    const card = cards.nth(previewIndex);
    const sourceJobUrl = tidy(
      new URL((await card.getAttribute("href").catch(() => "")) || "", page.url()).toString(),
    );
    await card.scrollIntoViewIfNeeded().catch(() => undefined);
    await card.click({ timeout: 10000 });
    await page
      .locator("h1, .jobs-details-top-card__job-title, .job-details-jobs-unified-top-card__job-title")
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => undefined);
    await page.waitForTimeout(800);

    const sourceJobTitle =
      cleanRepeatedText(
        await page
          .locator("h1, .jobs-details-top-card__job-title, .job-details-jobs-unified-top-card__job-title")
          .first()
          .textContent()
          .catch(() => "") ?? "",
      ) || "Untitled role";
    const sourceCompany =
      cleanRepeatedText(
        await page
          .locator(
            ".job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name, [data-test-company-name], .job-details-jobs-unified-top-card__company-name a",
          )
          .first()
          .textContent()
          .catch(() => "") ?? "",
      ) || "Unknown company";
    const linkedInDraft = await extractFromPage(page, "linkedin");
    const workloadScreening = await evaluateJobScreening({
      title: sourceJobTitle,
      company: sourceCompany,
      description: linkedInDraft.description,
    });
    const compensation = await extractLinkedInCompensation(page);

    const { destinationPage: targetPage, destinationUrl } = await activateExternalApplyFromLinkedIn(page);
    const openedPopup = targetPage !== page;

    if (!destinationUrl || isLinkedInUrl(destinationUrl)) {
      notes.push("No external employer application URL was found from the LinkedIn preview pane.");
      const result: ExternalApplyResult = {
        sourceJobUrl,
        sourceJobTitle,
        sourceCompany,
        compensationText: compensation.compensationText,
        estimatedMaxAnnualCompensation: compensation.estimatedMaxAnnualCompensation,
        workloadScreening,
        destinationUrl: targetPage.url(),
        destinationTitle: tidy(await targetPage.title()),
        externalApplyFound: false,
        autofill: null,
        review: null,
        notes,
      };
      await saveBrowserArtifact("external-apply-preview-result", result);
      return result;
    }

    if (targetPage.url() !== destinationUrl) {
      await targetPage.goto(destinationUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
      await targetPage.waitForTimeout(1200);
    }

    const result: ExternalApplyResult = {
      sourceJobUrl,
      sourceJobTitle,
      sourceCompany,
      compensationText: compensation.compensationText,
      estimatedMaxAnnualCompensation: compensation.estimatedMaxAnnualCompensation,
      workloadScreening,
      destinationUrl: targetPage.url(),
      destinationTitle: tidy(await targetPage.title()),
      externalApplyFound: true,
      autofill: null,
      review: null,
      notes,
    };

    if (openedPopup) {
      await targetPage.close().catch(() => undefined);
    } else if (page.url() !== collectionUrl) {
      await page.goto(collectionUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
      await page.waitForTimeout(1000);
    }

    await saveBrowserArtifact("external-apply-preview-result", result);
    return result;
  });
}

export async function applyAttachedTrackerJob(
  sourceJobUrl: string,
  profile: Profile,
  options: AutofillExecutionOptions = {},
): Promise<AttachedTrackerApplyResult | null> {
  return withAttachedPage(async (page) => {
    if (options.startUrl?.trim()) {
      await gotoAttachedUrl(page, options.startUrl);
    }

    const target = await findAttachedLinkedInPreviewTarget(page, sourceJobUrl);
    if (!target) {
      return null;
    }

    const notes: string[] = [];
    const sourceJobTitle = cleanRepeatedText(target.title) || "Untitled role";
    const sourceCompany = cleanRepeatedText(target.company) || "Unknown company";

    const trackerApply = await openJobsTrackerApplyTarget(page, target);
    if (!trackerApply) {
      const result: AttachedTrackerApplyResult = {
        sourceJobUrl: target.url,
        sourceJobTitle,
        sourceCompany,
        trackerAction: "No tracker apply action detected",
        firstLandingUrl: page.url(),
        openedTrackerApplyInNewPage: false,
        mode: "none",
        linkedInAutofill: null,
        externalResult: null,
        notes: ["No visible Apply control was detected from the Jobs Tracker preview."],
      };
      await saveBrowserArtifact("tracker-apply-result", result);
      return result;
    }

    let landingPage = trackerApply.page;
    let landingUrl = landingPage.url();

    if (landingUrl.includes("linkedin.com")) {
      await waitForLinkedInJobPageReady(landingPage);
      await waitForLinkedInApplyControls(landingPage);
      const expectedLinkedInUrl = normalizeLinkedInJobUrl(target.url);
      const actualLinkedInUrl = normalizeLinkedInJobUrl(landingPage.url());
      if (actualLinkedInUrl.includes("linkedin.com/jobs/view/") && actualLinkedInUrl !== expectedLinkedInUrl) {
        const result: AttachedTrackerApplyResult = {
          sourceJobUrl: target.url,
          sourceJobTitle,
          sourceCompany,
          trackerAction: trackerApply.label,
          firstLandingUrl: landingPage.url(),
          openedTrackerApplyInNewPage: trackerApply.openedNewPage,
          mode: "none",
          linkedInAutofill: null,
          externalResult: null,
          notes: [
            `Tracker apply opened ${actualLinkedInUrl}, which does not match requested job ${expectedLinkedInUrl}.`,
          ],
        };
        await saveBrowserArtifact("tracker-apply-result", result);
        return result;
      }

      const easyApplyControl = await findLinkedInEasyApplyControl(landingPage);
      if (easyApplyControl && /easy apply/i.test(easyApplyControl.label)) {
        const linkedInAutofill = await runLinkedInApplication(landingPage, profile, options);
        const result: AttachedTrackerApplyResult = {
          sourceJobUrl: target.url,
          sourceJobTitle,
          sourceCompany,
          trackerAction: trackerApply.label,
          firstLandingUrl: landingUrl,
          openedTrackerApplyInNewPage: trackerApply.openedNewPage,
          mode: "linkedin",
          linkedInAutofill,
          externalResult: null,
          notes: linkedInAutofill.stopReason ? [linkedInAutofill.stopReason] : [],
        };
        await saveBrowserArtifact("tracker-apply-result", result);
        return result;
      }

      const { destinationPage, destinationUrl } = await activateExternalApplyFromLinkedIn(landingPage);

      if (!destinationUrl || isLinkedInUrl(destinationUrl)) {
        const result: AttachedTrackerApplyResult = {
          sourceJobUrl: target.url,
          sourceJobTitle,
          sourceCompany,
          trackerAction: trackerApply.label,
          firstLandingUrl: landingUrl,
          openedTrackerApplyInNewPage: trackerApply.openedNewPage,
          mode: "none",
          linkedInAutofill: null,
          externalResult: null,
          notes: ["Tracker apply opened LinkedIn, but no second apply action reached an external employer site."],
        };
        await saveBrowserArtifact("tracker-apply-result", result);
        return result;
      }

      landingPage = destinationPage;
      landingUrl = destinationUrl;
    }

    if (landingPage.url() !== landingUrl) {
      await landingPage.goto(landingUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
      await landingPage.waitForTimeout(1200).catch(() => undefined);
    }

    const currentSiteKind = await detectApplicationSiteKind(landingPage);
    if (currentSiteKind === "workday") {
      await enterWorkdayApplicationFlowIfNeeded(landingPage).catch(() => undefined);
      await landingPage.waitForTimeout(800).catch(() => undefined);
    }

    const review = await buildCurrentSiteFormReview(landingPage);

    const autofill = await runResolvedSiteFormAutofill(landingPage, profile, options);
    if (autofill.stopReason) {
      notes.push(autofill.stopReason);
    }

    const externalResult: ExternalApplyResult = {
      sourceJobUrl: target.url,
      sourceJobTitle,
      sourceCompany,
      destinationUrl: safePageUrl(landingPage, landingUrl),
      destinationTitle: await safePageTitle(landingPage),
      siteKind: review.siteKind,
      externalApplyFound: true,
      autofill,
      review,
      notes,
    };

    const result: AttachedTrackerApplyResult = {
      sourceJobUrl: target.url,
      sourceJobTitle,
      sourceCompany,
      trackerAction: trackerApply.label,
      firstLandingUrl: safePageUrl(trackerApply.page, landingUrl),
      openedTrackerApplyInNewPage: trackerApply.openedNewPage,
      mode: "external",
      linkedInAutofill: null,
      externalResult,
      notes,
    };

    await saveBrowserArtifact("tracker-apply-result", result);
    return result;
  });
}

async function reviewPageLinkedInApplication(page: Page): Promise<LinkedInApplyReview> {
  if (!page.url() || page.url() === "about:blank") {
    throw new Error("No active page found in the attached browser.");
  }

  const draft = await extractFromPage(page, "linkedin");
  const notes: string[] = [];

  const easyApplyControl = await findLinkedInEasyApplyControl(page);
  const hasEasyApply = Boolean(easyApplyControl && /easy apply/i.test(easyApplyControl.label));

  if (easyApplyControl && hasEasyApply) {
    notes.push("Easy Apply button found.");
    await easyApplyControl.locator.click({ timeout: 5000 }).catch(() => {
      notes.push("Easy Apply button was found but could not be clicked automatically.");
    });
    await page.waitForTimeout(1500);
  } else {
    notes.push("Easy Apply button not found on the current page.");
  }
  return buildLinkedInApplyReview(page, draft, notes, hasEasyApply);
}
