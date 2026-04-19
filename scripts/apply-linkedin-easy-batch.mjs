import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const jobsPath = path.join(repoRoot, "data", "jobs.json");
const profilePath = path.join(repoRoot, "data", "profile.json");
const defaultSearchUrl =
  "https://www.linkedin.com/jobs/search/?f_AL=true&f_WT=2&geoId=103644278&keywords=software%20engineer&location=United%20States&sortBy=DD";

const args = parseArgs(process.argv.slice(2));
const limit = positiveInt(args.limit, 10);
const searchUrl = args.searchUrl || defaultSearchUrl;
const maxSearchPages = positiveInt(args.pages, 4);
const retryBlocked = /^(1|true|yes)$/i.test(args.retryBlocked || args["retry-blocked"] || "");

const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
const preferredEmails = [
  profile.email,
  "jabboursh@gmail.com",
  "shjabbou@gmail.com",
].map((value) => String(value || "").trim()).filter((value, index, values) => value && values.indexOf(value) === index);
const resumePath = profile.resumeFilePath || path.join(repoRoot, "Shadi_Jabbour_Resume.pdf");
let jobs = await loadJobs();
let activeJobContext = "";

await closeOmniboxTargets();
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0] ?? (await browser.newContext());
const searchPage = await context.newPage();

const directUrls = parseDirectUrls(args.url || args.urls || "");
const collected = directUrls.length
  ? directUrls.map((url) => ({
      title: "",
      company: "",
      location: "",
      url: normalizeLinkedInJobUrl(url),
      description: "",
    }))
  : await collectEasyApplyJobs(searchPage, searchUrl, limit * 3, maxSearchPages);
console.log(directUrls.length ? `Applying ${collected.length} direct URL(s).` : `Collected ${collected.length} Easy Apply candidates.`);

let submittedCount = 0;
let blockedCount = 0;
let attemptedCount = 0;

for (const candidate of collected) {
  if (submittedCount >= limit) break;

  const normalizedUrl = normalizeLinkedInJobUrl(candidate.url);
  const existing = findJobByLinkedInUrl(normalizedUrl);
  if (existing && ["applied", "closed"].includes(existing.status)) {
    continue;
  }
  if (existing?.status === "blocked" && !retryBlocked) {
    continue;
  }

  attemptedCount += 1;
  console.log(`\n[${attemptedCount}] ${candidate.title} @ ${candidate.company}`);
  console.log(normalizedUrl);

  const fastBlock = fastBlockReason(candidate);
  if (fastBlock) {
    blockedCount += 1;
    const notes = `Blocked on ${todayIso()}: ${fastBlock}`;
    await upsertJob({
      ...candidate,
      url: normalizedUrl,
      status: "blocked",
      notes,
    });
    console.log(`BLOCKED: ${notes}`);
    continue;
  }

  const page = await context.newPage();
  try {
    const result = await applyEasyJob(page, {
      ...candidate,
      url: normalizedUrl,
    });

    if (result.status === "applied") {
      submittedCount += 1;
    } else {
      blockedCount += 1;
    }

    await upsertJob({
      ...candidate,
      ...result.jobDetails,
      url: normalizedUrl,
      status: result.status,
      notes: result.notes,
    });

    console.log(`${result.status.toUpperCase()}: ${result.notes}`);
  } catch (error) {
    blockedCount += 1;
    const message = error instanceof Error ? error.message : String(error);
    await upsertJob({
      ...candidate,
      url: normalizedUrl,
      status: "blocked",
      notes: `Blocked on ${todayIso()}: ${message}`,
    });
    console.log(`BLOCKED: ${message}`);
  } finally {
    await page.close().catch(() => undefined);
    await sleep(1200);
  }
}

await searchPage.close().catch(() => undefined);
await browser.close();

console.log("");
console.log(`Attempted: ${attemptedCount}`);
console.log(`Submitted: ${submittedCount}`);
console.log(`Blocked: ${blockedCount}`);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.startsWith("--")) {
      const raw = value.slice(2);
      const eqIndex = raw.indexOf("=");
      if (eqIndex >= 0) {
        const key = raw.slice(0, eqIndex);
        parsed[key] = raw.slice(eqIndex + 1) || "1";
        continue;
      }
      const key = raw;
      const next = values[index + 1];
      parsed[key] = next && !next.startsWith("--") ? next : "1";
      if (next && !next.startsWith("--")) index += 1;
    }
  }
  return parsed;
}

function positiveInt(value, fallback) {
  const parsed = Number(value || "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseDirectUrls(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function closeOmniboxTargets() {
  const targets = await fetch("http://127.0.0.1:9222/json").then((response) => response.json());
  await Promise.all(
    targets
      .filter((target) => String(target.url || "").startsWith("chrome://omnibox"))
      .map((target) => fetch(`http://127.0.0.1:9222/json/close/${target.id}`).catch(() => undefined)),
  );
}

async function loadJobs() {
  try {
    return JSON.parse(await fs.readFile(jobsPath, "utf8"));
  } catch {
    return [];
  }
}

async function saveJobs() {
  await fs.writeFile(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
}

function normalizeLinkedInJobUrl(value) {
  const match = String(value || "").match(/linkedin\.com\/jobs\/view\/(\d+)/i);
  return match ? `https://www.linkedin.com/jobs/view/${match[1]}/` : String(value || "").trim();
}

function linkedInJobId(value) {
  return normalizeLinkedInJobUrl(value).match(/\/jobs\/view\/(\d+)\//)?.[1] || "";
}

function findJobByLinkedInUrl(url) {
  const id = linkedInJobId(url);
  return jobs.find((job) => linkedInJobId(job.url) === id);
}

function fastBlockReason(candidate) {
  const company = normalize(candidate.company || "");
  const context = normalize(`${candidate.title || ""} ${candidate.company || ""} ${candidate.description || ""}`);
  if (/turing/.test(company) && /llm evaluation|ai evaluation|research evaluation|ai research/.test(context)) {
    return "repeated Turing LLM evaluation Easy Apply flow reaches the step limit in automation; skipping to keep applications moving.";
  }
  if (/samsara/.test(company) && /growth engineer/.test(context)) {
    return "Samsara growth Easy Apply flow repeatedly loops to the step limit in automation; skipping to keep applications moving.";
  }
  if (/\b(contract|contractor|c2c|corp to corp|temporary|temp-to-hire|6 mo|6 month|1099)\b/.test(context)) {
    return "contract or temporary role; skipping to keep applications focused on full-time roles.";
  }
  return "";
}

function slug(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
}

async function upsertJob(result) {
  const normalizedUrl = normalizeLinkedInJobUrl(result.url);
  const existingIndex = jobs.findIndex((job) => linkedInJobId(job.url) === linkedInJobId(normalizedUrl));
  const next = {
    id:
      existingIndex >= 0
        ? jobs[existingIndex].id
        : `${slug(`${result.company || "unknown"}-${result.title || "role"}`)}-${Date.now().toString().slice(-6)}`,
    title: cleanText(result.title) || "Untitled role",
    company: cleanText(result.company) || "Unknown company",
    url: normalizedUrl,
    source: "linkedin.com",
    status: result.status,
    description: cleanText(result.description || ""),
    notes: cleanText(result.notes || ""),
    createdAt: existingIndex >= 0 ? jobs[existingIndex].createdAt : new Date().toISOString(),
    ...(existingIndex >= 0 && jobs[existingIndex].evaluation ? { evaluation: jobs[existingIndex].evaluation } : {}),
  };

  if (existingIndex >= 0) {
    jobs[existingIndex] = {
      ...jobs[existingIndex],
      ...next,
      description:
        next.description.length >= String(jobs[existingIndex].description || "").length
          ? next.description
          : jobs[existingIndex].description,
    };
  } else {
    jobs.push(next);
  }

  await saveJobs();
}

async function collectEasyApplyJobs(page, url, targetCount, pageLimit) {
  const results = [];
  const seen = new Set();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);

  for (let pageNumber = 1; pageNumber <= pageLimit && results.length < targetCount; pageNumber += 1) {
    await waitForSearchResults(page);

    for (let scrollIndex = 0; scrollIndex < 12 && results.length < targetCount; scrollIndex += 1) {
      const visible = await extractSearchCards(page);
      for (const job of visible) {
        const normalizedUrl = normalizeLinkedInJobUrl(job.url);
        if (!normalizedUrl || seen.has(normalizedUrl)) continue;
        const candidate = {
          title: cleanText(job.title) || "Untitled role",
          company: cleanText(job.company) || "Unknown company",
          location: cleanText(job.location),
          url: normalizedUrl,
          description: cleanText(job.cardText),
        };
        seen.add(normalizedUrl);
        if (fastBlockReason(candidate)) continue;
        results.push(candidate);
        if (results.length >= targetCount) break;
      }
      await scrollResultsList(page);
      await page.waitForTimeout(700);
    }

    if (results.length >= targetCount || pageNumber >= pageLimit) break;
    const advanced = await clickNextSearchPage(page);
    if (!advanced) break;
    await page.waitForTimeout(2500);
  }

  return results;
}

async function waitForSearchResults(page) {
  await page
    .waitForFunction(
      () => /linkedin\.com\/jobs\/search/i.test(location.href) && document.body.innerText.includes("Easy Apply"),
      { timeout: 20000 },
    )
    .catch(() => undefined);
}

async function extractSearchCards(page) {
  return page.evaluate(() => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const cards = [];
    const anchors = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]')).filter(visible);
    for (const anchor of anchors) {
      const card =
        anchor.closest("[data-job-id]") ||
        anchor.closest(".job-card-container") ||
        anchor.closest(".jobs-search-results__list-item") ||
        anchor.closest("li") ||
        anchor.parentElement;
      if (!card || !visible(card)) continue;
      const cardText = clean(card.textContent);
      if (!/easy apply/i.test(cardText)) continue;
      const lines = clean(card.innerText || cardText)
        .split(/(?<=\))\s+|(?<=Apply)\s+|\n/)
        .map(clean)
        .filter(Boolean);
      const title = clean(anchor.getAttribute("aria-label") || anchor.textContent).replace(/\s+with verification$/i, "");
      const company =
        clean(card.querySelector(".artdeco-entity-lockup__subtitle span")?.textContent) ||
        lines.find((line) => line && line !== title && !/easy apply|viewed|remote|benefits?|hour|within|ago/i.test(line)) ||
        "";
      const location =
        clean(card.querySelector(".artdeco-entity-lockup__caption span")?.textContent) ||
        lines.find((line) => /\b(remote|united states|, [A-Z]{2})\b/i.test(line)) ||
        "";
      cards.push({
        title,
        company,
        location,
        url: anchor.href,
        cardText,
      });
    }
    return cards;
  });
}

async function scrollResultsList(page) {
  await page.evaluate(() => {
    const candidates = [
      document.querySelector(".jobs-search-results-list"),
      document.querySelector(".jobs-search-results-list__list"),
      document.querySelector('[aria-label*="Search results"]'),
      document.querySelector("main"),
      document.scrollingElement,
    ].filter(Boolean);
    const target = candidates.find((element) => element.scrollHeight > element.clientHeight) || document.scrollingElement;
    target.scrollTop += Math.max(600, Math.floor(target.clientHeight * 0.85));
    window.scrollBy(0, 250);
  });
}

async function clickNextSearchPage(page) {
  const next = page.getByRole("button", { name: /view next page|next/i }).last();
  const visible = await next.isVisible().catch(() => false);
  const disabled = (await next.getAttribute("aria-disabled").catch(() => "")) === "true";
  if (!visible || disabled) return false;
  const before = page.url();
  await next.click({ timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  return page.url() !== before || (await page.locator("body").innerText().catch(() => "")).includes("Easy Apply");
}

async function applyEasyJob(page, candidate) {
  activeJobContext = `${candidate.title || ""} ${candidate.company || ""} ${candidate.description || ""}`;
  await page.goto(candidate.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  await expandDescription(page);

  let details = await extractJobDetails(page, candidate);
  activeJobContext = `${activeJobContext} ${details.title || ""} ${details.company || ""} ${details.description || ""}`;
  if (await pageHasSubmittedStatus(page)) {
    return {
      status: "applied",
      notes: `LinkedIn already showed Application submitted on ${todayIso()}.`,
      jobDetails: details,
    };
  }

  const opened = await openEasyApply(page, candidate.url);
  if (!opened) {
    return {
      status: "blocked",
      notes: `Blocked on ${todayIso()}: Easy Apply modal was not available or did not open.`,
      jobDetails: details,
    };
  }

  for (let step = 1; step <= 20; step += 1) {
    const root = await easyApplyRoot(page);
    if (!root) {
      if (await pageHasSubmittedStatus(page)) {
        details = await extractJobDetails(page, candidate);
        return {
          status: "applied",
          notes: `Submitted via LinkedIn Easy Apply on ${todayIso()}.`,
          jobDetails: details,
        };
      }
      return {
        status: "blocked",
        notes: `Blocked on ${todayIso()}: Easy Apply dialog disappeared before confirmation.`,
        jobDetails: details,
      };
    }

    const blocker = await detectHardBlocker(page, root);
    if (blocker) {
      return {
        status: "blocked",
        notes: `Blocked on ${todayIso()}: ${blocker}`,
        jobDetails: details,
      };
    }

    const emailBlocker = await detectUnavailableProfileEmail(root);
    if (emailBlocker) {
      return {
        status: "blocked",
        notes: `Blocked on ${todayIso()}: ${emailBlocker}`,
        jobDetails: details,
      };
    }

    await fillEasyApplyStep(page, root);
    await page.waitForTimeout(500);

    const action = await waitForPrimaryEasyApplyAction(page, root);
    if (!action) {
      const missing = await listMissingFields(root);
      const buttons = await visibleActionButtonSummary(root);
      const documentButtons = await visibleDocumentButtonSummary(page);
      const text = await visibleText(root);
      return {
        status: "blocked",
        notes: `Blocked on ${todayIso()}: No next/review/submit action detected${missing.length ? `; missing ${missing.join(", ")}` : ""}${
          buttons ? `; buttons ${buttons}` : ""
        }${documentButtons ? `; document buttons ${documentButtons}` : ""}; root ${text.slice(0, 220)}.`,
        jobDetails: details,
      };
    }

    if (/submit/i.test(action.label)) {
      await forceReviewEmail(page, root);
      await uncheckFollowCompany(root);
      await clickEasyAction(page, action);
      await page.waitForTimeout(3500);
      await dismissPostSubmit(page);
      if (await pageHasSubmittedStatus(page)) {
        details = await extractJobDetails(page, candidate);
        return {
          status: "applied",
          notes: `Submitted via LinkedIn Easy Apply on ${todayIso()}.`,
          jobDetails: details,
        };
      }
      const text = await visibleText(root);
      return {
        status: "blocked",
        notes: `Blocked on ${todayIso()}: Submit clicked but confirmation was not detected. Visible text: ${text.slice(0, 240)}`,
        jobDetails: details,
      };
    }

    const missingBeforeClick = await listMissingFields(root);
    if (missingBeforeClick.length > 0) {
      return {
        status: "blocked",
        notes: `Blocked on ${todayIso()}: Required fields still missing: ${missingBeforeClick.slice(0, 6).join(", ")}.`,
        jobDetails: details,
      };
    }

    await clickEasyAction(page, action);
    await page.waitForTimeout(2800);

    const validation = await visibleValidationError(page);
    if (validation) {
      return {
        status: "blocked",
        notes: `Blocked on ${todayIso()}: LinkedIn validation error after ${action.label}: ${validation}`,
        jobDetails: details,
      };
    }
  }

  const finalRoot = await easyApplyRoot(page);
  const finalText = finalRoot ? await visibleText(finalRoot) : await page.locator("body").innerText().catch(() => "");
  const finalMissing = finalRoot ? await listMissingFields(finalRoot) : [];
  const finalButtons = finalRoot ? await visibleActionButtonSummary(finalRoot) : "";
  return {
    status: "blocked",
    notes: `Blocked on ${todayIso()}: Reached Easy Apply step limit without submission${
      finalMissing.length ? `; missing ${finalMissing.slice(0, 6).join(", ")}` : ""
    }${finalButtons ? `; buttons ${finalButtons}` : ""}; visible text: ${cleanText(finalText).slice(0, 260)}.`,
    jobDetails: details,
  };
}

async function expandDescription(page) {
  await page
    .getByRole("button", { name: /see more|show more/i })
    .first()
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

async function extractJobDetails(page, fallback) {
  return page
    .evaluate((fallbackJob) => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const title =
        clean(document.querySelector("h1")?.textContent) ||
        clean(document.querySelector(".job-details-jobs-unified-top-card__job-title")?.textContent) ||
        fallbackJob.title;
      const company =
        clean(document.querySelector(".job-details-jobs-unified-top-card__company-name a")?.textContent) ||
        clean(document.querySelector('a[href*="/company/"]')?.textContent) ||
        fallbackJob.company;
      const description =
        clean(document.querySelector("#job-details")?.textContent) ||
        clean(document.querySelector(".jobs-description__content")?.textContent) ||
        clean(document.body.innerText).slice(0, 6000);
      return { title, company, description };
    }, fallback)
    .catch(() => ({
      title: fallback.title,
      company: fallback.company,
      description: fallback.description || "",
    }));
}

async function openEasyApply(page, jobUrl) {
  const button = page.getByRole("button", { name: /easy apply/i }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click({ timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(1800);
    if (await easyApplyRoot(page)) return true;
  }

  const link = page
    .locator('a[aria-label*="Easy Apply" i], a:has-text("Easy Apply"), a[href*="/apply/?openSDUIApplyFlow=true"]')
    .first();
  if (await link.isVisible().catch(() => false)) {
    await link.click({ timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(2200);
    if (await easyApplyRoot(page)) return true;
  }

  const direct = `${normalizeLinkedInJobUrl(jobUrl)}apply/?openSDUIApplyFlow=true`;
  await page.goto(direct, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  return Boolean(await easyApplyRoot(page));
}

async function easyApplyRoot(page) {
  const modalSelectors = [
    ".jobs-easy-apply-modal",
    '[data-test-modal-id="easy-apply-modal"]',
    ".artdeco-modal:has(.jobs-easy-apply-content)",
  ];
  for (const selector of modalSelectors) {
    const matches = page.locator(selector);
    const count = await matches.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const direct = matches.nth(index);
      if (!(await direct.isVisible().catch(() => false))) continue;
      const text = await direct.innerText().catch(() => "");
      if (/apply to|resume|contact info|additional questions|submit application|review your application/i.test(text)) {
        return direct;
      }
    }
  }
  const dialogs = page.getByRole("dialog");
  const count = await dialogs.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 4); index += 1) {
    const dialog = dialogs.nth(index);
    if (!(await dialog.isVisible().catch(() => false))) continue;
    const text = await dialog.innerText().catch(() => "");
    if (/apply to|resume|contact info|additional questions|submit application|review your application/i.test(text)) {
      return dialog;
    }
  }
  return null;
}

async function pageHasSubmittedStatus(page) {
  const text = await page.locator("body").innerText().catch(() => "");
  return /application submitted|application sent|you applied|you.ve applied|applied now/i.test(text);
}

async function detectHardBlocker(page, root) {
  const text = await visibleText(root);
  if (/captcha|security check|verify you.re human|manual verification/i.test(text)) {
    return "manual verification or CAPTCHA is required.";
  }
  if (/date of birth|birthdate|birthday/i.test(text)) {
    return "date of birth is required and is not available in saved profile data.";
  }
  if (/assessment|quiz|coding test|take test/i.test(text) && /required/i.test(text)) {
    return "a required assessment is present.";
  }
  const url = page.url();
  if (/checkpoint|authwall|login/i.test(url)) {
    return `LinkedIn redirected to ${url}.`;
  }
  return "";
}

async function fillEasyApplyStep(page, root) {
  await fillFileInputs(root);
  await fillNativeSelects(page, root);
  await fillRadioGroups(root);
  await fillTextInputs(page, root);
  await fillCheckboxes(root);
}

async function fillFileInputs(root) {
  const text = await visibleText(root);
  if (/deselect resume|last used|shadi_jabbour_resume\.pdf/i.test(text)) return;
  const files = root.locator('input[type="file"]');
  const count = await files.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const input = files.nth(index);
    if (!(await input.isVisible().catch(() => false))) continue;
    await input.setInputFiles(resumePath).catch(() => undefined);
    await sleep(800);
  }
}

async function fillNativeSelects(page, root) {
  const selects = root.locator("select");
  const count = await selects.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const select = selects.nth(index);
    if (!(await select.isVisible().catch(() => false))) continue;
    const meta = await selectMeta(select);
    const label = await elementLabel(select);
    const current = cleanText(meta.selected);
    const answer = answerFor(label, "select", meta.options.map((option) => option.text), current);
    if (!answer) continue;
    if (current && choiceMatches(current, answer)) continue;
    await chooseSelectOption(page, select, answer);
  }
}

async function selectMeta(select) {
  return select.evaluate((node) => {
    const options = Array.from(node.options).map((option, index) => ({
      index,
      text: (option.textContent || "").replace(/\s+/g, " ").trim(),
      value: option.value,
    }));
    return {
      value: node.value,
      selected: (node.options[node.selectedIndex]?.textContent || "").replace(/\s+/g, " ").trim(),
      options,
    };
  });
}

async function chooseSelectOption(page, select, desired) {
  const meta = await selectMeta(select);
  const target =
    meta.options.find((option) => choiceMatches(option.text, desired)) ||
    meta.options.find((option) => choiceMatches(option.value, desired));
  if (!target) return false;

  await select.selectOption(target.value).catch(() => undefined);
  await page.waitForTimeout(200);
  let after = await selectMeta(select);
  if (choiceMatches(after.selected, desired)) return true;

  await select.focus().catch(() => undefined);
  await page.keyboard.press("Home").catch(() => undefined);
  for (let index = 0; index < target.index; index += 1) {
    await page.keyboard.press("ArrowDown").catch(() => undefined);
  }
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(300);
  after = await selectMeta(select);
  if (choiceMatches(after.selected, desired)) return true;

  await select
    .evaluate((node, value) => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
      descriptor?.set?.call(node, value);
      node.value = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }, target.value)
    .catch(() => undefined);
  await page.waitForTimeout(250);
  after = await selectMeta(select);
  return choiceMatches(after.selected, desired);
}

async function fillRadioGroups(root) {
  const handledRadioIds = new Set();
  const groups = root.locator("fieldset, [role='radiogroup']");
  const count = await groups.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const group = groups.nth(index);
    if (!(await group.isVisible().catch(() => false))) continue;
    const radioCount = await group.locator('input[type="radio"], [role="radio"]').count().catch(() => 0);
    if (radioCount < 2) continue;
    const ids = await radioNodeIds(group);
    const selected =
      (await group.locator('input[type="radio"]:checked, [aria-checked="true"]').count().catch(() => 0)) > 0;
    if (selected) {
      for (const id of ids) handledRadioIds.add(id);
      continue;
    }
    const choices = await group
      .locator("label, [role='radio']")
      .evaluateAll((nodes) => nodes.map((node) => (node.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean))
      .catch(() => []);
    const label = await elementLabel(group, choices);
    const answer = answerFor(label, "radio", choices, "");
    if (!answer) continue;
    if (await clickChoice(group, answer)) {
      for (const id of ids) handledRadioIds.add(id);
    }
  }
  await fillLooseRadios(root, handledRadioIds);
}

async function radioNodeIds(scope) {
  return scope
    .locator('input[type="radio"], [role="radio"]')
    .evaluateAll((nodes) =>
      nodes.map((node, index) => {
        if (!node.dataset.easyApplyRadioId) {
          node.dataset.easyApplyRadioId = `easy-apply-radio-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
        }
        return node.dataset.easyApplyRadioId;
      }),
    )
    .catch(() => []);
}

async function fillLooseRadios(root, handledRadioIds) {
  const groups = await root
    .locator('input[type="radio"], [role="radio"]')
    .evaluateAll((nodes, handledIds) => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      const labelFor = (radio) => {
        const id = radio.id || "";
        return (
          clean(radio.getAttribute("aria-label")) ||
          clean(id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : "") ||
          clean(radio.closest("label")?.textContent) ||
          clean(radio.parentElement?.textContent)
        );
      };
      const questionFor = (radio, optionText) => {
        const containers = [
          radio.closest(".jobs-easy-apply-form-section__grouping"),
          radio.closest(".fb-dash-form-element"),
          radio.parentElement?.parentElement?.parentElement,
          radio.parentElement?.parentElement,
          radio.parentElement,
        ].filter(Boolean);
        for (const container of containers) {
          const related = Array.from(container.querySelectorAll('input[type="radio"], [role="radio"]')).filter(visible);
          if (related.length < 2 || related.length > 8) continue;
          let text = clean(container.textContent);
          for (const item of related) text = clean(text.split(labelFor(item)).join(" "));
          text = clean(text.replace(/\b(required|select an option|yes|no|back|next|review|submit|continue)\b/gi, " "));
          if (text) return text;
        }
        return optionText;
      };

      const byQuestion = new Map();
      for (const node of nodes) {
        if (!visible(node)) continue;
        if (!node.dataset.easyApplyRadioId) {
          node.dataset.easyApplyRadioId = `easy-apply-radio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }
        if (handledIds.includes(node.dataset.easyApplyRadioId)) continue;
        const option = labelFor(node);
        if (!option) continue;
        const question = questionFor(node, option);
        const key = question.toLowerCase();
        if (!byQuestion.has(key)) byQuestion.set(key, { question, options: [], selected: false });
        const group = byQuestion.get(key);
        group.options.push({ id: node.dataset.easyApplyRadioId, text: option });
        group.selected ||= Boolean(node.checked) || node.getAttribute("aria-checked") === "true";
      }
      return Array.from(byQuestion.values()).filter((group) => group.options.length >= 2 && !group.selected);
    }, Array.from(handledRadioIds))
    .catch(() => []);

  for (const group of groups) {
    const answer = answerFor(group.question, "radio", group.options.map((option) => option.text), "");
    if (!answer) continue;
    const choice = group.options.find((option) => choiceMatches(option.text, answer));
    if (!choice) continue;
    const radio = root.locator(`[data-easy-apply-radio-id="${choice.id}"]`).first();
    await radio.click({ timeout: 5000, force: true }).catch(() => undefined);
    await sleep(250);
  }
}

async function clickChoice(group, desired) {
  const labels = group.locator("label, [role='radio']");
  const count = await labels.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    const text = cleanText(await label.innerText().catch(() => ""));
    if (!choiceMatches(text, desired)) continue;
    await label.click({ timeout: 5000 }).catch(() => undefined);
    await sleep(250);
    return true;
  }

  const radios = group.locator('input[type="radio"], [role="radio"]');
  const radioCount = await radios.count().catch(() => 0);
  for (let index = 0; index < radioCount; index += 1) {
    const radio = radios.nth(index);
    const text = cleanText(
      await radio
        .evaluate((node) => node.closest("label")?.textContent || node.getAttribute("aria-label") || "")
        .catch(() => ""),
    );
    if (!choiceMatches(text, desired)) continue;
    await radio.click({ timeout: 5000, force: true }).catch(() => undefined);
    await sleep(250);
    return true;
  }
  return false;
}

async function fillTextInputs(page, root) {
  const inputs = root.locator(
    'input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"]), textarea',
  );
  const count = await inputs.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const field = inputs.nth(index);
    if (!(await field.isVisible().catch(() => false))) continue;
    const disabled = await field.evaluate((node) => node.disabled || node.readOnly).catch(() => false);
    if (disabled) continue;
    const meta = await field
      .evaluate((node) => ({
        tag: node.tagName.toLowerCase(),
        type: node.getAttribute("type") || "",
        role: node.getAttribute("role") || "",
        id: node.id || "",
        value: node.value || "",
        placeholder: node.getAttribute("placeholder") || "",
      }))
      .catch(() => ({ tag: "", type: "", role: "", id: "", value: "", placeholder: "" }));
    const label = (await elementLabel(field)) || meta.placeholder || meta.id;
    const answer = answerFor(label, meta.type || meta.tag, [], meta.value);
    if (!answer) continue;
    if (cleanText(meta.value) && !shouldOverrideText(label, meta.value, answer)) continue;
    await field.fill(answer).catch(() => undefined);
    if (/combobox|typeahead/i.test(`${meta.role} ${meta.id}`) || /location/.test(normalize(label))) {
      await page.waitForTimeout(500);
      await field.press("ArrowDown").catch(() => undefined);
      await field.press("Enter").catch(() => undefined);
      await page.waitForTimeout(350);
    } else {
      await page.waitForTimeout(150);
    }
  }
}

async function fillCheckboxes(root) {
  const boxes = root.locator('input[type="checkbox"], [role="checkbox"]');
  const count = await boxes.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index);
    if (!(await box.isVisible().catch(() => false))) continue;
    const label = await elementLabel(box);
    if (/follow .* to stay up to date|follow company/i.test(label)) {
      await box.uncheck({ timeout: 3000 }).catch(() => undefined);
      continue;
    }
    const answer = answerFor(label, "checkbox", ["Yes", "No"], "");
    if (!answer) continue;
    const shouldCheck = /^yes|true|agree|accept$/i.test(answer);
    const checked = await isChecked(box);
    if (shouldCheck !== checked) {
      await box.click({ timeout: 5000, force: true }).catch(() => undefined);
      await sleep(200);
    }
  }
}

async function isChecked(locator) {
  return locator
    .evaluate((node) => Boolean(node.checked) || node.getAttribute("aria-checked") === "true")
    .catch(() => false);
}

async function elementLabel(locator, ignoredTexts = []) {
  return locator
    .evaluate((node, ignored) => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const ignoredValues = Array.isArray(ignored) ? ignored.map(clean).filter(Boolean) : [];
      const element = node;
      const id = element.id || "";
      const direct =
        clean(element.getAttribute("aria-label")) ||
        clean(element.getAttribute("placeholder")) ||
        (id ? clean(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) : "");
      if (direct) return direct;
      const containers = [
        element.closest(".jobs-easy-apply-form-section__grouping"),
        element.closest(".fb-dash-form-element"),
        element.closest("fieldset"),
        element.closest("label"),
        element.parentElement?.parentElement,
        element.parentElement,
      ].filter(Boolean);
      for (const container of containers) {
        let text = clean(container.textContent);
        for (const ignoredText of ignoredValues) {
          text = text.split(ignoredText).join(" ");
        }
        text = clean(
          text
            .replace(/\b(required|select an option|back|next|review|submit|continue|yes|no)\b/gi, " ")
            .replace(/\*/g, " "),
        );
        if (text) return text;
      }
      return "";
    }, ignoredTexts)
    .then(cleanText)
    .catch(() => "");
}

function answerFor(label, type, choices = [], currentValue = "") {
  const n = normalize(label);
  const options = choices.map(cleanText).filter(Boolean);
  const current = cleanText(currentValue);

  if (/date of birth|birthdate|birthday/.test(n)) return "";

  if (/email/.test(n)) {
    if (options.length > 0) return bestChoice(options, preferredEmails) || "";
    return preferredEmails[0] || "";
  }
  if (/phone country|country code/.test(n)) return bestChoice(options, ["United States (+1)", "United States"]) || "United States (+1)";
  if (/phone|mobile|cell/.test(n)) return profile.phone;
  if (/first name|given name/.test(n)) return "Shadi";
  if (/last name|family name|surname/.test(n)) return "Jabbour";
  if (/full name|legal name/.test(n)) return profile.name;
  if (/city/.test(n)) return profile.city || "Raleigh";
  if (/\bstate\b|province/.test(n)) return bestChoice(options, ["North Carolina", "NC"]) || "North Carolina";
  if (/zip|postal/.test(n)) return profile.postalCode || "27609";
  if (/address|street/.test(n)) return profile.streetAddress || "641 Pine Ridge Pl";
  if (/current location|location/.test(n)) return profile.location || "Raleigh, North Carolina, United States";
  if (/how did you hear|where did you hear|source/.test(n)) return bestChoice(options, ["LinkedIn", "LinkedIn Jobs"]) || "LinkedIn";
  if (/linkedin/.test(n)) return profile.linkedinUrl;
  if (/github/.test(n)) return "https://github.com/Shjabbour";
  if (/portfolio|website|personal site/.test(n)) return "https://shjabbour.github.io/";
  if (/privacy policy|data processing|accurate information|dishonesty|termination of employment/.test(n)) {
    return options.length > 0 ? yesChoice(options) : "Yes";
  }
  if (/18 years of age|age or older|at least 18/.test(n)) {
    return options.length > 0 ? yesChoice(options) : "Yes";
  }
  if (/production grade systems.*(regulated|high precision)|regulated or high precision|legaltech|fintech|healthtech|compliance/.test(n)) {
    return options.length > 0
      ? yesChoice(options)
      : "Yes. I have built and maintained production systems with secure authentication, operational reporting, finance/operations workflows, cloud deployments, and reliability requirements.";
  }
  if (/geometry-intensive|cad|cam|graphics supporting manufacturing/.test(n)) return "N/A";
  if (/current company|most recent company|employer/.test(n)) return "Hurdle Solutions";
  if (/current title|job title|most recent title/.test(n)) return "Software Consultant";
  if (/school|university|institution/.test(n)) return "North Carolina State University";
  if (/completed.*bachelor|bachelor.*degree|bachelors degree/.test(n) && bestChoice(options, ["Yes", "No"])) {
    return yesChoice(options);
  }
  if (/degree|education/.test(n)) return bestChoice(options, ["Bachelor", "Bachelor's Degree", "Bachelor Level Degree"]) || "Bachelor's Degree";
  if (/field of study|major/.test(n)) return "Computer Information Systems";

  if (/salary|compensation|expected pay|pay expectation|base pay/.test(n)) {
    return /number|numeric|integer|decimal/.test(type) || options.length === 0 ? "150000" : "$150K - $175K";
  }
  if (/hourly|rate/.test(n)) return "90";

  if (/equity only|unpaid|no salary/.test(n)) return noChoice(options);
  if (/lead contributor|sole developer/.test(n) && /genai|generative ai|ai related/.test(n)) return noChoice(options);
  if (/relevant experience in this field/.test(n)) {
    return /embedded|firmware|hardware|ruby|rails|trading|property management/i.test(activeJobContext)
      ? noChoice(options)
      : yesChoice(options);
  }
  if (/do you have .*experience|have you .*worked|have you .*built|are you experienced/.test(n)) {
    if (/c\+\+|c plus plus|kdb|trading|firmware|embedded|hardware|ruby|rails|rust|scala|golang|\bgo\b|kotlin|swift|ios|android|snowflake|databricks|mlops|machine learning|deep learning|pytorch|tensorflow|property management|salesforce|servicenow|apollo/.test(n)) {
      return noChoice(options);
    }
  }

  const years = yearsAnswer(n);
  if (years !== null) return years;

  if (/authorized|authorization|eligible to work|legally work|right to work/.test(n)) {
    return yesChoice(options);
  }
  if (/eligible.*w2|w2 employment|w-2 employment/.test(n)) {
    return yesChoice(options);
  }
  if (/sponsor|sponsorship|visa/.test(n)) {
    return noChoice(options);
  }
  if (/citizen|citizenship/.test(n)) {
    if (bestChoice(options, ["Yes", "No"])) return yesChoice(options);
    return bestChoice(options, ["US citizen", "United States", "United States of America", "U.S. Citizen"]) || "US citizen";
  }
  if (/relocat|commut|on site|onsite|hybrid/.test(n)) {
    return /remote/.test(n) ? yesChoice(options) : noChoice(options);
  }
  if (/remote/.test(n)) return yesChoice(options);
  if (/by clicking yes|privacy policy|data processing|dishonesty/.test(n)) {
    return yesChoice(options);
  }
  if (/background check|drug test|reference check|over 18|18 years|at least 18|confirm|attest|accurate|terms|privacy|agree|accept/.test(n)) {
    return yesChoice(options);
  }
  if (/receive text|sms|text message|marketing|newsletter/.test(n)) return noChoice(options);
  if (/former employee|previously worked|employee referral|referred|security clearance|clearance/.test(n)) {
    return noChoice(options);
  }
  if (/veteran/.test(n)) {
    return bestChoice(options, [
      "I am not a veteran",
      "I am not a protected veteran",
      "I am not a U.S. military protected veteran",
      "No",
    ]);
  }
  if (/disability|race|ethnicity|hispanic|latino|gender|transgender/.test(n)) {
    return (
      bestChoice(options, [
        "I do not wish to provide this information",
        "Decline to self identify",
        "Prefer not to say",
        "I don't wish to answer",
        "I do not want to answer",
        "Not specified",
      ]) ||
      (/gender/.test(n) ? bestChoice(options, ["Male"]) : "") ||
      noChoice(options)
    );
  }
  if (/language/.test(n)) return "English, Arabic, Spanish, French";
  if (/available|start date|notice period/.test(n)) return "2 weeks";
  if (/why|interest|summary|describe|cover letter|additional information/.test(n)) {
    return "This role aligns with my background building production software across web applications, backend systems, APIs, cloud infrastructure, and data workflows.";
  }

  if (current) return current;
  return "";
}

function yearsAnswer(normalizedLabel) {
  if (!/year|yrs|experience/.test(normalizedLabel)) return null;
  if (/c\+\+|c plus plus|kdb|trading|firmware|embedded|fpga|hardware|ruby|rails|rust|scala|golang|\bgo\b|kotlin|swift|ios|android|snowflake|databricks|mlops|machine learning|deep learning|pytorch|tensorflow|property management|salesforce|servicenow|apollo/.test(normalizedLabel)) {
    return "0";
  }
  if (/python/.test(normalizedLabel)) return "5";
  if (/javascript|typescript|node|react|next\.?js|frontend|front end|full stack|fullstack/.test(normalizedLabel)) return "5";
  if (/\bjava\b/.test(normalizedLabel)) return "3";
  if (/sql|postgres|postgresql|mysql|database|mongodb|redis/.test(normalizedLabel)) return "4";
  if (/aws|gcp|azure|cloud/.test(normalizedLabel)) return "3";
  if (/docker|kubernetes|terraform|ci\/cd|jenkins|gitlab/.test(normalizedLabel)) return "3";
  if (/backend|back end|api|rest|graphql|software engineer|software development|professional work|engineering/.test(normalizedLabel)) {
    return profile.yearsOfExperience || "8";
  }
  return profile.yearsOfExperience || "8";
}

function yesChoice(options) {
  return bestChoice(options, ["Yes", "Y", "True"]) || "Yes";
}

function noChoice(options) {
  return bestChoice(options, ["No", "N", "False"]) || "No";
}

function bestChoice(options, desiredValues) {
  for (const desired of desiredValues) {
    const match = options.find((option) => choiceMatches(option, desired));
    if (match) return match;
  }
  return "";
}

function choiceMatches(choice, desired) {
  const c = normalize(choice);
  const d = normalize(desired);
  if (!c || !d) return false;
  if (c === d || c.includes(d) || d.includes(c)) return true;
  if (d === "yes") return /^(yes|y|true)$/.test(c);
  if (d === "no") return /^(no|n|false)$/.test(c);
  if (/decline|prefer not|do not wish|don t wish|do not want|not specified/.test(d)) {
    return /decline|prefer not|do not wish|don t wish|do not want|not specified|choose not|opt out/.test(c);
  }
  if (/not.*veteran/.test(d)) return /not.*veteran|no/.test(c);
  return false;
}

function shouldOverrideText(label, current, answer) {
  const n = normalize(label);
  if (!cleanText(current)) return true;
  if (choiceMatches(current, answer)) return false;
  return /email|phone|first name|last name|full name|city|state|zip|postal|linkedin|github|portfolio/.test(n);
}

async function primaryEasyApplyAction(page, root) {
  const id = `easy-apply-action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const label = await root
    .evaluate((node, actionId) => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      const scoreFor = (button) => {
        const label = clean(button.getAttribute("aria-label")) || clean(button.innerText || button.textContent);
        const normalized = label.toLowerCase();
        if (!label) return 0;
        if (button.disabled || button.getAttribute("aria-disabled") === "true") return 0;
        if (/back|edit|\bview\b|download|dismiss|\bshow\b|company photos|help center/i.test(label)) return 0;
        if (/submit application/i.test(label)) return 50;
        if (/review your application|review/i.test(label)) return 40;
        if (/continue to next step/i.test(label)) return 30;
        if (/\bnext\b/.test(normalized)) return 25;
        if (/\bcontinue\b/.test(normalized)) return 20;
        return 0;
      };
      const buttons = Array.from(node.querySelectorAll("button")).filter(visible);
      const ranked = buttons
        .map((button, index) => ({ button, index, score: scoreFor(button) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => a.score - b.score || a.index - b.index);
      const picked = ranked.at(-1);
      if (!picked) return "";
      picked.button.dataset.easyApplyActionId = actionId;
      return clean(picked.button.getAttribute("aria-label")) || clean(picked.button.innerText || picked.button.textContent);
    }, id)
    .catch(() => "");

  if (!label) return fallbackEasyApplyAction(page);
  const locator = page.locator(`[data-easy-apply-action-id="${id}"]`).first();
  return { locator, label };
}

async function waitForPrimaryEasyApplyAction(page, fallbackRoot) {
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const root = (await easyApplyRoot(page)) || fallbackRoot;
    const action = root ? await primaryEasyApplyAction(page, root) : await fallbackEasyApplyAction(page);
    if (action) return action;
    await page.waitForTimeout(700);
  }
  return null;
}

async function fallbackEasyApplyAction(page) {
  const id = `easy-apply-action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const label = await page
    .evaluate((actionId) => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const scoreFor = (button) => {
        const label = clean(button.getAttribute("aria-label")) || clean(button.innerText || button.textContent);
        const normalized = label.toLowerCase();
        if (!label) return 0;
        if (button.disabled || button.getAttribute("aria-disabled") === "true") return 0;
        if (/back|edit|\bview\b|download|dismiss|\bshow\b|company photos|help center/i.test(label)) return 0;
        if (/submit application/i.test(label)) return 50;
        if (/review your application|review/i.test(label)) return 40;
        if (/continue to next step/i.test(label)) return 30;
        if (/\bnext\b/.test(normalized)) return 25;
        if (/\bcontinue\b/.test(normalized)) return 20;
        return 0;
      };
      const modal =
        Array.from(document.querySelectorAll(".jobs-easy-apply-modal, [data-test-modal-id='easy-apply-modal'], .artdeco-modal"))
          .filter(visible)
          .find((element) => /apply to|resume|contact info|additional questions|submit application|review your application/i.test(clean(element.innerText))) ||
        document;
      const rank = (scope) =>
        Array.from(scope.querySelectorAll("button"))
          .filter(visible)
          .map((button, index) => ({ button, index, score: scoreFor(button) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => a.score - b.score || a.index - b.index);
      const picked = (rank(modal).at(-1) || (modal === document ? null : rank(document).at(-1)));
      if (!picked) return "";
      picked.button.dataset.easyApplyActionId = actionId;
      return clean(picked.button.getAttribute("aria-label")) || clean(picked.button.innerText || picked.button.textContent);
    }, id)
    .catch(() => "");

  if (!label) return null;
  return { locator: page.locator(`[data-easy-apply-action-id="${id}"]`).first(), label };
}

async function clickEasyAction(page, action) {
  await dismissSaveApplicationOverlay(page);
  await action.locator.scrollIntoViewIfNeeded().catch(() => undefined);
  if (await action.locator.click({ timeout: 6000 }).then(() => true).catch(() => false)) return true;
  if (await action.locator.click({ timeout: 4000, force: true }).then(() => true).catch(() => false)) return true;
  return action.locator
    .evaluate((node) => {
      if (node instanceof HTMLElement) {
        node.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
}

async function dismissSaveApplicationOverlay(page) {
  const hasSavePrompt = await page.locator("body").innerText().then((text) => /save this application/i.test(text)).catch(() => false);
  if (!hasSavePrompt) return;
  await page
    .locator('.artdeco-modal__confirm-dialog button[aria-label="Dismiss"], button[aria-label="Dismiss"]')
    .last()
    .click({ timeout: 3000 })
    .catch(() => undefined);
  await page.waitForTimeout(400).catch(() => undefined);
}

async function listMissingFields(root) {
  return root
    .evaluate((node) => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const missing = [];
      const seen = new Set();
      const labelFor = (element) => {
        const id = element.id || "";
        const direct =
          clean(element.getAttribute("aria-label")) ||
          clean(element.getAttribute("placeholder")) ||
          (id ? clean(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) : "");
        if (direct) return direct;
        const container =
          element.closest(".jobs-easy-apply-form-section__grouping") ||
          element.closest(".fb-dash-form-element") ||
          element.closest("fieldset") ||
          element.closest("label") ||
          element.parentElement;
        return clean(container?.textContent).replace(/\b(required|select an option|yes|no|back|next|review|submit)\b/gi, " ");
      };
      const add = (label) => {
        const cleanLabel = clean(label).replace(/\*/g, "");
        const key = cleanLabel.toLowerCase();
        if (cleanLabel && !seen.has(key)) {
          seen.add(key);
          missing.push(cleanLabel);
        }
      };
      for (const field of Array.from(document.querySelectorAll("input, textarea, select"))) {
        if (!visible(field)) continue;
        const type = field.getAttribute("type") || field.tagName.toLowerCase();
        if (/hidden|file|button|submit|radio|checkbox/i.test(type)) continue;
        const containerText = clean(
          field.closest(".jobs-easy-apply-form-section__grouping")?.textContent ||
            field.closest(".fb-dash-form-element")?.textContent ||
            field.parentElement?.textContent,
        );
        const required = /\brequired\b/i.test(containerText) || field.required || field.getAttribute("aria-required") === "true";
        if (!required) continue;
        const value =
          field.tagName === "SELECT"
            ? clean(field.options[field.selectedIndex]?.textContent)
            : clean(field.value || field.textContent);
        if (!value || /select an option|select|choose/i.test(value)) add(labelFor(field));
      }
      for (const group of Array.from(document.querySelectorAll("fieldset, [role='radiogroup']"))) {
        if (!visible(group)) continue;
        const radios = Array.from(group.querySelectorAll('input[type="radio"], [role="radio"]'));
        if (radios.length < 2) continue;
        const groupText = clean(group.textContent);
        if (!/\brequired\b|\*/i.test(groupText)) continue;
        const selected = radios.some((radio) => radio.checked || radio.getAttribute("aria-checked") === "true");
        if (!selected) add(clean(group.querySelector("legend")?.textContent) || groupText);
      }
      return missing.slice(0, 8);
    })
    .catch(() => []);
}

async function detectUnavailableProfileEmail(root) {
  const allowedEmails = preferredEmails.map((email) => cleanText(email).toLowerCase()).filter(Boolean);
  if (allowedEmails.length === 0) return "";

  return root
    .locator("select")
    .evaluateAll((selects, allowed) => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const labelFor = (element) => {
        const id = element.id || "";
        const direct =
          clean(element.getAttribute("aria-label")) ||
          clean(element.getAttribute("placeholder")) ||
          (id ? clean(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) : "");
        if (direct) return direct;
        const container =
          element.closest(".jobs-easy-apply-form-section__grouping") ||
          element.closest(".fb-dash-form-element") ||
          element.closest("fieldset") ||
          element.closest("label") ||
          element.parentElement;
        return clean(container?.textContent);
      };

      for (const select of selects) {
        if (!visible(select)) continue;
        const options = Array.from(select.options).map((option) => clean(option.textContent)).filter(Boolean);
        const emailOptions = options.filter((option) => /@[a-z0-9.-]+\.[a-z]{2,}/i.test(option));
        if (emailOptions.length === 0) continue;
        const label = labelFor(select);
        if (!/email/i.test(label) && emailOptions.length < options.length - 1) continue;
        const hasAllowed = emailOptions.some((option) => allowed.includes(option.toLowerCase()));
        if (!hasAllowed) {
          return `LinkedIn Easy Apply contact step only offered ${emailOptions.join(" and ")}; none of the verified preferred emails (${allowed.join(", ")}) were available.`;
        }
      }

      return "";
    }, allowedEmails)
    .catch(() => "");
}

async function visibleActionButtonSummary(root) {
  return root
    .evaluate(() => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      return Array.from(node.querySelectorAll("button"))
        .filter(visible)
        .map((button) => {
          const label = clean(button.getAttribute("aria-label")) || clean(button.innerText || button.textContent) || "(blank)";
          const state = button.disabled || button.getAttribute("aria-disabled") === "true" ? "disabled" : "enabled";
          return `${label}:${state}`;
        })
        .slice(-8)
        .join(" | ");
    })
    .then(cleanText)
    .catch(() => "");
}

async function visibleDocumentButtonSummary(page) {
  return page
    .evaluate(() => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      return Array.from(document.querySelectorAll("button"))
        .filter(visible)
        .map((button) => {
          const label = clean(button.getAttribute("aria-label")) || clean(button.innerText || button.textContent) || "(blank)";
          const state = button.disabled || button.getAttribute("aria-disabled") === "true" ? "disabled" : "enabled";
          return `${label}:${state}`;
        })
        .slice(-12)
        .join(" | ");
    })
    .then(cleanText)
    .catch(() => "");
}

async function visibleValidationError(page) {
  return page
    .evaluate(() => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const errors = Array.from(
        document.querySelectorAll('[role="alert"], .artdeco-inline-feedback--error, .fb-dash-form-element__error-text'),
      )
        .filter(visible)
        .map((node) => clean(node.textContent))
        .filter(Boolean);
      return errors.join(" | ").slice(0, 300);
    })
    .catch(() => "");
}

async function forceReviewEmail(page, root) {
  const text = await visibleText(root);
  if (!/review your application/i.test(text) || !/jabbourchad@gmail\.com/i.test(text)) return;
  const edit = root.getByRole("button", { name: /edit contact info/i }).first();
  if (!(await edit.isVisible().catch(() => false))) return;
  await edit.click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(1000);
  const editedRoot = (await easyApplyRoot(page)) || root;
  const selects = editedRoot.locator("select");
  const count = await selects.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const select = selects.nth(index);
    const label = await elementLabel(select);
    if (/email/i.test(label) || /email/i.test(cleanText(await select.innerText().catch(() => "")))) {
      const meta = await selectMeta(select);
      const answer = answerFor(label, "select", meta.options.map((option) => option.text), meta.selected);
      if (answer) {
        await chooseSelectOption(page, select, answer);
      }
      break;
    }
  }
  const review = await primaryEasyApplyAction(page, editedRoot);
  if (review && /review/i.test(review.label)) {
    await clickEasyAction(page, review).catch(() => undefined);
    await page.waitForTimeout(1000);
  }
}

async function uncheckFollowCompany(root) {
  const checkbox = root.locator('#follow-company-checkbox, input[type="checkbox"]').first();
  if (!(await checkbox.isVisible().catch(() => false))) return;
  const label = await elementLabel(checkbox);
  if (/follow|stay up to date/i.test(label) || (await checkbox.getAttribute("id").catch(() => "")) === "follow-company-checkbox") {
    await checkbox.uncheck({ timeout: 3000 }).catch(() => undefined);
  }
}

async function dismissPostSubmit(page) {
  await page.getByRole("button", { name: /done|close|dismiss/i }).first().click({ timeout: 4000 }).catch(() => undefined);
}

async function visibleText(locator) {
  return cleanText(await locator.innerText().catch(() => ""));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/c\+\+/g, "c++")
    .replace(/[^a-z0-9+#.\s/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
