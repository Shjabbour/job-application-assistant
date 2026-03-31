import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  ApplicationField,
  AutofillResult,
  ExternalApplyResult,
  ExtractedJobDraft,
  JobCollectionItem,
  LinkedInApplyReview,
  Profile,
  SiteFormReview,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const browserProfileDir = path.join(repoRoot, ".browser-profile");
const browserOutputDir = path.join(repoRoot, "data", "browser");
const attachedChromeProfileDir = path.join(repoRoot, ".chrome-debug-profile");
const browserChannel = process.env.JAA_BROWSER_CHANNEL || "chrome";
const cdpUrl = process.env.JAA_CDP_URL || "http://127.0.0.1:9222";
const preferredAttachedPagePatterns = [
  "linkedin.com/jobs/collections/remote-jobs",
  "linkedin.com/jobs/collections/recommended",
  "linkedin.com/jobs/view/",
  "linkedin.com/jobs/",
];

async function ensureBrowserDirs(): Promise<void> {
  await mkdir(browserProfileDir, { recursive: true });
  await mkdir(browserOutputDir, { recursive: true });
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

  const [context] = browser.contexts();
  if (!context) {
    throw new Error("No browser contexts were found on the attached Chrome session.");
  }

  return context.newPage();
}

async function withAttachedPage<T>(callback: (page: Page, browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const page = await getAttachedPage(browser);
  return callback(page, browser);
}

function tidy(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
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
      const value = tidy(await page.locator(selector).first().textContent().catch(() => ""));
      if (value) return value;
    }
    return "";
  };

  const firstMeta = async (selectors: string[]): Promise<string> => {
    for (const selector of selectors) {
      const value = tidy(
        await page.locator(selector).first().getAttribute("content").catch(() => ""),
      );
      if (value) return value;
    }
    return "";
  };

  const title =
    (await firstText(["h1"])) ||
    (await firstMeta(['meta[property="og:title"]', 'meta[name="og:title"]'])) ||
    tidy(await page.title());

  const company =
    (await firstText([
      "[data-test-company-name]",
      ".job-details-jobs-unified-top-card__company-name",
      ".topcard__org-name-link",
      ".jobsearch-CompanyInfoWithoutHeaderImage a",
    ])) ||
    (await firstMeta(['meta[property="og:site_name"]', 'meta[name="og:site_name"]']));

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

async function inspectApplicationFields(page: Page): Promise<ApplicationField[]> {
  const fieldLocator = page.locator(
    'input, textarea, select, [contenteditable="true"]',
  );
  const count = await fieldLocator.count();
  const fields: ApplicationField[] = [];

  for (let index = 0; index < count; index += 1) {
    const field = fieldLocator.nth(index);
    const isVisible = await field.isVisible().catch(() => false);
    if (!isVisible) continue;

    const label =
      tidy(await field.getAttribute("aria-label").catch(() => "")) ||
      tidy(await field.getAttribute("name").catch(() => "")) ||
      tidy(await field.getAttribute("placeholder").catch(() => "")) ||
      tidy(await field.evaluate((node) => {
        const element = node as HTMLElement;
        const id = element.getAttribute("id");
        if (!id) return "";
        return (document.querySelector(`label[for="${id}"]`)?.textContent ?? "").trim();
      }).catch(() => ""));

    const type =
      tidy(await field.getAttribute("type").catch(() => "")) ||
      (await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "unknown"));

    const required =
      (await field.getAttribute("required").catch(() => null)) !== null ||
      (await field.getAttribute("aria-required").catch(() => "")) === "true";

    fields.push({
      label: label || "Unlabeled field",
      type,
      required,
    });
  }

  return fields;
}

export async function reviewCurrentLinkedInApplication(headed = true): Promise<LinkedInApplyReview> {
  return withPersistentPage(headed, async (page) => {
    if (!page.url() || page.url() === "about:blank") {
      throw new Error("No active page found in the persistent browser profile.");
    }

    await page.waitForTimeout(1000);
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

    const primaryAction =
      tidy(await page.getByRole("button", { name: /next|review|submit|continue/i }).first().textContent().catch(() => "")) ||
      "No primary action detected";

    if (/submit/i.test(primaryAction)) {
      notes.push("Reached a submit step. The flow stopped here without clicking submit.");
    }

    const stage =
      tidy(await page.locator('[aria-live="polite"], .jobs-easy-apply-content p').first().textContent().catch(() => "")) ||
      "Application modal inspected";

    const fields = await inspectApplicationFields(page);
    const review: LinkedInApplyReview = {
      url: page.url(),
      title: draft.title,
      company: draft.company,
      hasEasyApply,
      stage,
      primaryAction,
      fields,
      notes,
    };

    await saveBrowserArtifact("linkedin-apply-review", review);
    return review;
  });
}

export async function reviewAttachedLinkedInApplication(): Promise<LinkedInApplyReview> {
  return withAttachedPage(async (page) => {
    await page.waitForTimeout(1000);
    const review = await reviewPageLinkedInApplication(page);
    await saveBrowserArtifact("linkedin-apply-review-attached", review);
    return review;
  });
}

export async function captureAttachedCurrentPage(): Promise<ExtractedJobDraft> {
  return withAttachedPage(async (page) => {
    await page.waitForTimeout(1000);
    const source = new URL(page.url()).hostname;
    const extracted = await extractFromPage(page, source);
    await saveBrowserArtifact("capture-attached", extracted);
    return extracted;
  });
}

export async function collectAttachedLinkedInJobs(): Promise<JobCollectionItem[]> {
  return withAttachedPage(async (page) => {
    await page.waitForTimeout(1200);
    const cards = page.locator('a[href*="/jobs/view/"]');
    const count = Math.min(await cards.count(), 40);
    const seen = new Set<string>();
    const jobs: JobCollectionItem[] = [];

    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      const href = await card.getAttribute("href").catch(() => "");
      const url = tidy(href ? new URL(href, page.url()).toString() : "");
      if (!url || !url.includes("/jobs/view/") || seen.has(url)) continue;

      const text = tidy(await card.textContent().catch(() => ""));
      const title = text
        .replace(/with verification/gi, "")
        .replace(/\s+/g, " ")
        .trim();

      seen.add(url);
      jobs.push({
        title: title || "Untitled role",
        company: "Unknown company",
        url,
        location: "",
        compensationText: "",
        estimatedMaxAnnualCompensation: null,
      });
    }

    await saveBrowserArtifact("linkedin-collection", jobs);
    return jobs;
  });
}

export async function openAttachedJob(url: string): Promise<void> {
  await withAttachedPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
  });
}

export async function clickAttachedLinkedInPreview(index: number): Promise<ExtractedJobDraft> {
  return withAttachedPage(async (page) => {
    const cards = page.locator('a[href*="/jobs/view/"]');
    const count = await cards.count();
    if (index < 0 || index >= count) {
      throw new Error(`Preview index ${index} is out of range. Found ${count} cards.`);
    }

    const card = cards.nth(index);
    await card.scrollIntoViewIfNeeded().catch(() => undefined);
    await card.click({ timeout: 10000 });
    await page.waitForTimeout(2500);
    return extractFromPage(page, "linkedin");
  });
}

export async function advanceAttachedLinkedInCollectionPage(): Promise<boolean> {
  return withAttachedPage(async (page) => {
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
  });
}

async function clickFirstVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
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
    if (href && !href.includes("linkedin.com")) {
      return new URL(href, page.url()).toString();
    }
  }

  return "";
}

async function clickExternalApplyControl(page: Page): Promise<Page | null> {
  const selectors = [
    "button.jobs-apply-button",
    'button[aria-label*="on company website" i]',
    'button[aria-label*="on employer website" i]',
    'a[aria-label*="on company website" i]',
    'a[aria-label*="on employer website" i]',
    'a:has-text("Apply on company site")',
    'a:has-text("Apply on employer site")',
    'a:has-text("Apply now")',
    'button:has-text("Apply")',
    'button:has-text("Apply now")',
    'button:has-text("Continue to application")',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;

    const popupPromise = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
    const clicked = await locator.click({ timeout: 10000 }).then(() => true).catch(() => false);
    if (!clicked) {
      continue;
    }

    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
      await popup.waitForTimeout(2500);
      return popup;
    }

    await page.waitForTimeout(3000);
    return page;
  }

  return null;
}

async function fillFirstVisible(
  page: Page,
  selectors: string[],
  value: string,
): Promise<boolean> {
  if (!value.trim()) return false;

  for (const selector of selectors) {
    const field = page.locator(selector).first();
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
  matcher: (field: ApplicationField) => boolean,
  value: string,
): Promise<boolean> {
  if (!value.trim()) return false;

  const fieldLocator = page.locator('input, textarea, select, [contenteditable="true"]');
  const count = await fieldLocator.count();

  for (let index = 0; index < count; index += 1) {
    const field = fieldLocator.nth(index);
    const visible = await field.isVisible().catch(() => false);
    if (!visible) continue;

    const label =
      tidy(await field.getAttribute("aria-label").catch(() => "")) ||
      tidy(await field.getAttribute("name").catch(() => "")) ||
      tidy(await field.getAttribute("placeholder").catch(() => ""));
    const type =
      tidy(await field.getAttribute("type").catch(() => "")) ||
      (await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "unknown"));
    const required =
      (await field.getAttribute("required").catch(() => null)) !== null ||
      (await field.getAttribute("aria-required").catch(() => "")) === "true";

    if (!matcher({ label, type, required })) continue;

    const tag = await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
    if (tag === "select") {
      const selected =
        (await field.selectOption({ label: value }).catch(() => [] as string[])).length > 0 ||
        (await field.selectOption({ index: 1 }).catch(() => [] as string[])).length > 0;
      if (selected) return true;
      continue;
    }

    if (tag === "textarea" || type !== "file") {
      await field.fill(value).catch(() => undefined);
      const currentValue = await field.inputValue().catch(() => "");
      if (currentValue) return true;
    }
  }

  return false;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function fieldMatchesAny(field: ApplicationField, patterns: string[]): boolean {
  const haystack = `${field.label} ${field.type}`.toLowerCase();
  return patterns.some((pattern) => haystack.includes(pattern));
}

export async function autofillAttachedLinkedInApplication(profile: Profile): Promise<AutofillResult> {
  return withAttachedPage(async (page) => {
    await page.waitForTimeout(1000);
    const filled: string[] = [];
    const skipped: string[] = [];

    const easyApplyButton = page.getByRole("button", { name: /easy apply/i }).first();
    const hasEasyApply = await easyApplyButton.isVisible().catch(() => false);
    if (hasEasyApply) {
      await easyApplyButton.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
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
        selectors: [
          'input[aria-label*="work authorization" i]',
          'input[aria-label*="authorized" i]',
        ],
        value: profile.workAuthorization,
      },
      {
        name: "years of experience",
        selectors: [
          'input[aria-label*="years of experience" i]',
          'input[aria-label*="experience" i]',
        ],
        value: profile.yearsOfExperience,
      },
    ];

    for (const attempt of attempts) {
      const success = await fillFirstVisible(page, attempt.selectors, attempt.value);
      if (success) {
        filled.push(attempt.name);
      } else {
        skipped.push(attempt.name);
      }
    }

    const nextAction =
      tidy(
        await page
          .getByRole("button", { name: /next|review|submit|continue/i })
          .first()
          .textContent()
          .catch(() => ""),
      ) || "No primary action detected";

    const result: AutofillResult = {
      filled,
      skipped,
      nextAction,
      stoppedBeforeSubmit: true,
    };

    await saveBrowserArtifact("linkedin-autofill", result);
    return result;
  });
}

export async function reviewAttachedCurrentForm(): Promise<SiteFormReview> {
  return withAttachedPage(async (page) => {
    await page.waitForTimeout(1000);
    const fields = await inspectApplicationFields(page);
    const primaryAction =
      tidy(
        await page
          .getByRole("button", { name: /next|continue|review|submit|apply|save/i })
          .first()
          .textContent()
          .catch(() => ""),
      ) || "No primary action detected";

    const review: SiteFormReview = {
      url: page.url(),
      title: tidy(await page.title()),
      fields,
      primaryAction,
      notes: [
        /submit/i.test(primaryAction)
          ? "The current page appears to have a submit action. Automation should stop before clicking it."
          : "Primary action does not appear to be final submit.",
      ],
    };

    await saveBrowserArtifact("site-form-review", review);
    return review;
  });
}

export async function autofillAttachedCurrentForm(profile: Profile): Promise<AutofillResult> {
  return withAttachedPage(async (page) => {
    await page.waitForTimeout(1000);
    const fields = await inspectApplicationFields(page);
    const filled: string[] = [];
    const skipped: string[] = [];

    const attempts: Array<{ name: string; value: string; patterns: string[] }> = [
      { name: "first name", value: profile.name.split(/\s+/)[0] || "", patterns: ["first name", "firstname", "given name"] },
      { name: "last name", value: profile.name.split(/\s+/).slice(1).join(" ") || "", patterns: ["last name", "lastname", "surname", "family name"] },
      { name: "full name", value: profile.name, patterns: ["full name", "your name", "name"] },
      { name: "email", value: profile.email, patterns: ["email"] },
      { name: "phone", value: profile.phone, patterns: ["phone", "mobile", "telephone"] },
      { name: "city", value: profile.city || profile.location, patterns: ["city"] },
      { name: "state", value: profile.state, patterns: ["state", "province", "region"] },
      { name: "location", value: profile.location, patterns: ["location", "address"] },
      { name: "linkedin", value: profile.linkedinUrl, patterns: ["linkedin"] },
      { name: "summary", value: profile.resumeSummary, patterns: ["summary", "cover letter", "about you", "why are you", "additional information"] },
      { name: "work authorization", value: profile.workAuthorization, patterns: ["work authorization", "authorized", "sponsorship", "visa"] },
      { name: "years of experience", value: profile.yearsOfExperience, patterns: ["years of experience", "experience"] },
    ];

    for (const attempt of attempts) {
      const matchingFieldExists = fields.some((field) => fieldMatchesAny(field, attempt.patterns));
      if (!matchingFieldExists) {
        skipped.push(attempt.name);
        continue;
      }

      const success = await fillFirstMatchingField(
        page,
        (field) => fieldMatchesAny(field, attempt.patterns),
        attempt.value,
      );

      if (success) {
        filled.push(attempt.name);
      } else {
        skipped.push(attempt.name);
      }
    }

    const nextAction =
      tidy(
        await page
          .getByRole("button", { name: /next|continue|review|submit|apply|save/i })
          .first()
          .textContent()
          .catch(() => ""),
      ) || "No primary action detected";

    const result: AutofillResult = {
      filled,
      skipped,
      nextAction,
      stoppedBeforeSubmit: true,
    };

    await saveBrowserArtifact("site-form-autofill", result);
    return result;
  });
}

export async function processAttachedExternalJob(
  sourceJobUrl: string,
  profile: Profile,
): Promise<ExternalApplyResult> {
  return withAttachedPage(async (page) => {
    const notes: string[] = [];
    await page.goto(sourceJobUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);

    const sourceJobTitle = tidy(await page.locator("h1").first().textContent().catch(() => "")) || "Untitled role";
    const startUrl = page.url();

    let destinationUrl = await getExternalApplyLink(page);

    if (!destinationUrl) {
      const clicked = await clickFirstVisible(page, [
        'a:has-text("Apply on company site")',
        'a:has-text("Apply on employer site")',
        'a:has-text("Apply now")',
        'button:has-text("Apply")',
        'button:has-text("Apply on company site")',
        'button:has-text("Continue to application")',
      ]);

      if (clicked) {
        await page.waitForTimeout(2500);
        destinationUrl = page.url();
      }
    }

    if (!destinationUrl || destinationUrl.includes("linkedin.com")) {
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

    const review = await (async () => {
      const fields = await inspectApplicationFields(page);
      const primaryAction =
        tidy(
          await page
            .getByRole("button", { name: /next|continue|review|submit|apply|save/i })
            .first()
            .textContent()
            .catch(() => ""),
        ) || "No primary action detected";

      return {
        url: page.url(),
        title: tidy(await page.title()),
        fields,
        primaryAction,
        notes: [
          /submit/i.test(primaryAction)
            ? "Stopped before a detected submit action."
            : "Filled current page and stopped before final submission.",
        ],
      } satisfies SiteFormReview;
    })();

    const autofill = await (async () => {
      const fields = await inspectApplicationFields(page);
      const filled: string[] = [];
      const skipped: string[] = [];
      const attempts: Array<{ name: string; value: string; patterns: string[] }> = [
        { name: "first name", value: profile.name.split(/\s+/)[0] || "", patterns: ["first name", "firstname", "given name"] },
        { name: "last name", value: profile.name.split(/\s+/).slice(1).join(" ") || "", patterns: ["last name", "lastname", "surname", "family name"] },
        { name: "full name", value: profile.name, patterns: ["full name", "your name", "name"] },
        { name: "email", value: profile.email, patterns: ["email"] },
        { name: "phone", value: profile.phone, patterns: ["phone", "mobile", "telephone"] },
        { name: "city", value: profile.city || profile.location, patterns: ["city"] },
        { name: "state", value: profile.state, patterns: ["state", "province", "region"] },
        { name: "location", value: profile.location, patterns: ["location", "address"] },
        { name: "linkedin", value: profile.linkedinUrl, patterns: ["linkedin"] },
        { name: "summary", value: profile.resumeSummary, patterns: ["summary", "cover letter", "about you", "additional information", "why are you"] },
        { name: "work authorization", value: profile.workAuthorization, patterns: ["work authorization", "authorized", "sponsorship", "visa"] },
        { name: "years of experience", value: profile.yearsOfExperience, patterns: ["years of experience", "experience"] },
      ];

      for (const attempt of attempts) {
        const matchingFieldExists = fields.some((field) => fieldMatchesAny(field, attempt.patterns));
        if (!matchingFieldExists) {
          skipped.push(attempt.name);
          continue;
        }
        const success = await fillFirstMatchingField(
          page,
          (field) => fieldMatchesAny(field, attempt.patterns),
          attempt.value,
        );
        if (success) filled.push(attempt.name);
        else skipped.push(attempt.name);
      }

      const nextAction =
        tidy(
          await page
            .getByRole("button", { name: /next|continue|review|submit|apply|save/i })
            .first()
            .textContent()
            .catch(() => ""),
        ) || "No primary action detected";

      return {
        filled,
        skipped,
        nextAction,
        stoppedBeforeSubmit: true,
      } satisfies AutofillResult;
    })();

    const result: ExternalApplyResult = {
      sourceJobUrl,
      sourceJobTitle,
      destinationUrl: page.url(),
      destinationTitle: tidy(await page.title()),
      externalApplyFound: true,
      autofill,
      review,
      notes,
    };

    await saveBrowserArtifact("external-apply-result", result);
    return result;
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
    await page.waitForTimeout(2500);

    const sourceJobTitle =
      tidy(await page.locator("h1").first().textContent().catch(() => "")) || "Untitled role";
    const sourceCompany =
      tidy(
        await page
          .locator(
            ".job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name, [data-test-company-name]",
          )
          .first()
          .textContent()
          .catch(() => ""),
      ) || "Unknown company";
    const compensation = await extractLinkedInCompensation(page);

    let destinationUrl = await getExternalApplyLink(page);
    let targetPage: Page = page;
    let openedPopup = false;

    if (!destinationUrl) {
      const openedPage = await clickExternalApplyControl(page);
      if (openedPage) {
        targetPage = openedPage;
        openedPopup = openedPage !== page;
        destinationUrl = openedPage.url();
      }
    }

    if (!destinationUrl || destinationUrl.includes("linkedin.com")) {
      notes.push("No external employer application URL was found from the LinkedIn preview pane.");
      const result: ExternalApplyResult = {
        sourceJobUrl,
        sourceJobTitle,
        sourceCompany,
        compensationText: compensation.compensationText,
        estimatedMaxAnnualCompensation: compensation.estimatedMaxAnnualCompensation,
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
      await targetPage.waitForTimeout(2500);
    }

    const result: ExternalApplyResult = {
      sourceJobUrl,
      sourceJobTitle,
      sourceCompany,
      compensationText: compensation.compensationText,
      estimatedMaxAnnualCompensation: compensation.estimatedMaxAnnualCompensation,
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
      await page.waitForTimeout(1500);
    }

    await saveBrowserArtifact("external-apply-preview-result", result);
    return result;
  });
}

async function reviewPageLinkedInApplication(page: Page): Promise<LinkedInApplyReview> {
  if (!page.url() || page.url() === "about:blank") {
    throw new Error("No active page found in the attached browser.");
  }

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

  const primaryAction =
    tidy(
      await page
        .getByRole("button", { name: /next|review|submit|continue/i })
        .first()
        .textContent()
        .catch(() => ""),
    ) || "No primary action detected";

  if (/submit/i.test(primaryAction)) {
    notes.push("Reached a submit step. The flow stopped here without clicking submit.");
  }

  const stage =
    tidy(
      await page
        .locator('[aria-live="polite"], .jobs-easy-apply-content p')
        .first()
        .textContent()
        .catch(() => ""),
    ) || "Application modal inspected";

  const fields = await inspectApplicationFields(page);
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
