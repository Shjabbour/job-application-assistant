import { chromium } from "playwright";

const cdpUrl = process.env.JAA_CDP_URL || "http://127.0.0.1:9222";
const resumePath =
  process.env.JAA_RESUME_PATH ||
  "C:/Users/Charbel/Desktop/github/job-application-assistant/Shadi_Jabbour_Resume.pdf";

const profile = {
  firstName: "Shadi",
  lastName: "Jabbour",
  fullName: "Shadi Jabbour",
  address: "641 Pine Ridge Pl",
  city: "Raleigh",
  postalCode: "27609",
  phone: "(919) 710-0993",
};

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractReq(input) {
  const value = String(input || "");
  const match = value.match(/JR-\d+/i);
  if (!match) throw new Error(`Could not find GM req id in ${value}`);
  return match[0].toUpperCase();
}

async function waitForPage(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await sleep(1200);
}

async function bodyText(page) {
  return clean(await page.locator("body").innerText({ timeout: 10_000 }).catch(() => ""));
}

async function currentStep(page) {
  const text = await bodyText(page);
  const match = text.match(/current step\s+(\d+)\s+of\s+6/i);
  return match ? Number(match[1]) : 0;
}

async function visible(locator) {
  return (await locator.count().catch(() => 0)) > 0 && (await locator.first().isVisible().catch(() => false));
}

async function fillIfVisible(page, selector, value) {
  const field = page.locator(selector).first();
  if (!(await visible(field))) return false;
  await field.scrollIntoViewIfNeeded().catch(() => undefined);
  await field.fill(value);
  await field.dispatchEvent("input").catch(() => undefined);
  await field.dispatchEvent("change").catch(() => undefined);
  await field.blur().catch(() => undefined);
  return true;
}

async function clickOptionByText(page, regex) {
  const options = await page.evaluate((source) => {
    const re = new RegExp(source, "i");
    return [...document.querySelectorAll('[role="option"], [data-automation-id="menuItem"]')]
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        return {
          index,
          text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
          visible: Boolean(rect.width || rect.height || element.getClientRects().length),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      })
      .filter((option) => option.visible && option.text && re.test(option.text));
  }, regex.source);
  const option = options[0];
  if (!option) return false;
  await page.mouse.click(option.x + Math.min(option.width - 8, 18), option.y + option.height / 2);
  await sleep(700);
  return true;
}

async function openDropdown(page, selector) {
  const button = page.locator(selector).first();
  if (!(await visible(button))) throw new Error(`Dropdown not visible: ${selector}`);
  await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (element) window.scrollTo({ top: Math.max(0, element.getBoundingClientRect().top + window.scrollY - 520), behavior: "instant" });
  }, selector);
  await sleep(250);
  await button.click({ force: true }).catch(() => undefined);
  await sleep(700);
  let hasOptions = await page
    .locator('[role="option"], [data-automation-id="menuItem"]')
    .count()
    .then((count) => count > 0)
    .catch(() => false);
  if (hasOptions) return;
  await button.focus().catch(() => undefined);
  await page.keyboard.press("Space").catch(() => undefined);
  await sleep(700);
  hasOptions = await page
    .locator('[role="option"], [data-automation-id="menuItem"]')
    .count()
    .then((count) => count > 0)
    .catch(() => false);
  if (!hasOptions) {
    await button.click({ force: true }).catch(() => undefined);
    await sleep(700);
  }
}

async function chooseDropdown(page, selector, regex) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let option = page.getByRole("option", { name: regex }).first();
    if (await visible(option)) {
      await option.click({ force: true });
      await sleep(700);
      return;
    }
    if (await clickOptionByText(page, regex)) return;
    await openDropdown(page, selector);
    option = page.getByRole("option", { name: regex }).first();
    if (await visible(option)) {
      await option.click({ force: true });
      await sleep(700);
      return;
    }
    if (await clickOptionByText(page, regex)) return;
    await sleep(500);
  }
  throw new Error(`Could not choose ${regex} from ${selector}`);
}

async function selectGmSource(page) {
  const source = page.locator("#source--source").first();
  if (!(await visible(source))) return;
  const sourceText = clean(
    await page.locator('[data-automation-id="formField-source"]').innerText({ timeout: 3000 }).catch(() => ""),
  );
  if (/1 item selected/.test(sourceText)) return;

  await source.scrollIntoViewIfNeeded().catch(() => undefined);
  await source.click({ force: true });
  await sleep(700);
  if (!(await clickOptionByText(page, /^Internet Job Board\s*\/\s*Job Search$/i))) {
    throw new Error("Could not open GM Internet Job Board source group");
  }
  let selectedOther = false;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await sleep(500);
    if (await clickOptionByText(page, /^Other$/i)) {
      selectedOther = true;
      break;
    }
  }
  if (!selectedOther) {
    throw new Error("Could not choose GM source leaf Other");
  }
}

async function clickNoForPreviousGm(page) {
  const radios = await page.locator('input[name="candidateIsPreviousWorker"]').count().catch(() => 0);
  for (let index = 0; index < radios; index += 1) {
    const radio = page.locator('input[name="candidateIsPreviousWorker"]').nth(index);
    if ((await radio.inputValue().catch(() => "")) === "false") {
      if (!(await radio.isChecked().catch(() => false))) await radio.check({ force: true });
      return;
    }
  }
}

async function fillStep1(page) {
  await selectGmSource(page);
  await clickNoForPreviousGm(page);
  await fillIfVisible(page, "#name--legalName--firstName", profile.firstName);
  await fillIfVisible(page, "#name--legalName--lastName", profile.lastName);
  await fillIfVisible(page, "#address--addressLine1", profile.address);
  await fillIfVisible(page, "#address--city", profile.city);
  if (await visible(page.locator("#address--countryRegion").first())) {
    await chooseDropdown(page, "#address--countryRegion", /^North Carolina$/i);
  }
  await fillIfVisible(page, "#address--postalCode", profile.postalCode);
  await chooseDropdown(page, "#phoneNumber--phoneType", /^Mobile$/i);
  await fillIfVisible(page, "#phoneNumber--phoneNumber", profile.phone);
  await fillIfVisible(page, "#phoneNumber--extension", "");
}

async function uploadResume(page) {
  await page.waitForSelector('input[type="file"]', { timeout: 20_000 }).catch(() => undefined);
  const inputs = await page.locator('input[type="file"]').count().catch(() => 0);
  for (let index = 0; index < inputs; index += 1) {
    await page.locator('input[type="file"]').nth(index).setInputFiles(resumePath);
  }
  if (inputs === 0) {
    const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
    await page.locator('[data-automation-id="select-files"], button:has-text("Select files")').first().click({ force: true });
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(resumePath);
  }
  await page.waitForFunction(
    () => /successfully uploaded|Shadi_Jabbour_Resume\.pdf/i.test(document.body.innerText || ""),
    { timeout: 25_000 },
  );
  await sleep(1000);
}

async function fillStep3(page) {
  await page.waitForSelector('button[id^="primaryQuestionnaire--"]', { timeout: 15_000 }).catch(() => undefined);
  await sleep(500);
  const buttons = await page.locator('button[id^="primaryQuestionnaire--"]').evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.id,
      label:
        element
          .closest('[data-automation-id^="formField-"]')
          ?.innerText?.replace(/\s+/g, " ")
          .trim() || "",
    })),
  );

  for (const button of buttons) {
    const text = button.label.toLowerCase();
    if (text.includes("currently eligible to work")) {
      await chooseDropdown(page, `[id="${button.id}"]`, /^Yes$/i);
    } else if (text.includes("future sponsorship")) {
      await chooseDropdown(page, `[id="${button.id}"]`, /^No$/i);
    } else if (text.includes("government official")) {
      await chooseDropdown(page, `[id="${button.id}"]`, /^No$/i);
    } else if (text.includes("influence decisions related to general motors")) {
      await chooseDropdown(page, `[id="${button.id}"]`, /^No$/i);
    } else if (text.includes("text message") || text.includes("sms")) {
      await chooseDropdown(page, `[id="${button.id}"]`, /^Yes$/i);
    }
  }
}

async function fillStep4(page) {
  await page.waitForSelector("#personalInfoUS--veteranStatus, input[id$='-ethnicityMulti']", { timeout: 15_000 }).catch(() => undefined);
  if (!(await checkCheckboxByLabel(page, /I do not wish to answer/i))) {
    throw new Error("Could not select GM race non-disclosure checkbox");
  }
  if (await visible(page.locator("#personalInfoUS--veteranStatus").first())) {
    await chooseDropdown(page, "#personalInfoUS--veteranStatus", /^I AM NOT A VETERAN$/i);
  }
  const consent = page.locator("#termsAndConditions--acceptTermsAndAgreements").first();
  if ((await consent.count().catch(() => 0)) && !(await consent.isChecked().catch(() => false))) {
    await consent.check({ force: true });
  }
}

async function fillStep5(page) {
  await page.waitForSelector("#selfIdentifiedDisabilityData--name", { timeout: 15_000 }).catch(() => undefined);
  await fillIfVisible(page, "#selfIdentifiedDisabilityData--name", profile.fullName);
  await fillIfVisible(page, "#selfIdentifiedDisabilityData--dateSignedOn-dateSectionMonth-input", "04");
  await fillIfVisible(page, "#selfIdentifiedDisabilityData--dateSignedOn-dateSectionDay-input", "17");
  await fillIfVisible(page, "#selfIdentifiedDisabilityData--dateSignedOn-dateSectionYear-input", "2026");
  await sleep(300);
  await checkCheckboxByLabel(page, /^I do not want to answer$/i);
}

async function saveAndContinue(page, expectedStep) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if ((await currentStep(page)) >= expectedStep) return;
    await page.locator('[data-automation-id="pageFooterNextButton"]').last().click({ force: true });
    await waitForPage(page);
    if ((await currentStep(page)) >= expectedStep) return;
  }
  throw new Error(`Could not advance to step ${expectedStep}`);
}

async function submitReview(page) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const text = await bodyText(page);
    if (attempt > 1 && !/current step 6 of 6/i.test(text)) return;
    if (/Application Submitted|Process completed|Candidate Home/i.test(text) && !/current step 6 of 6/i.test(text)) return;
    await page
      .waitForFunction(() => [...document.querySelectorAll('[data-automation-id="pageFooterNextButton"]')].some((el) => /Submit/i.test(el.textContent || "")), {
        timeout: 10_000,
      })
      .catch(() => undefined);
    let submit = page.locator('[data-automation-id="pageFooterNextButton"]').filter({ hasText: /Submit/i }).first();
    if (!(await visible(submit)) && /current step 6 of 6/i.test(text)) {
      submit = page.locator('[data-automation-id="pageFooterNextButton"]').last();
    }
    if (!(await visible(submit))) throw new Error("Submit button not visible");
    await submit.click({ force: true });
    await waitForPage(page);
  }
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await visible(locator)) {
      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      await locator.click({ force: true });
      return true;
    }
  }
  return false;
}

async function checkCheckboxByLabel(page, regex) {
  const id = await page.evaluate((source) => {
    const re = new RegExp(source, "i");
    for (const input of document.querySelectorAll('input[type="checkbox"]')) {
      const labels = input.id ? [...document.querySelectorAll(`label[for="${CSS.escape(input.id)}"]`)] : [];
      const text = labels.map((label) => label.innerText || label.textContent || "").join(" ").replace(/\s+/g, " ").trim();
      if (re.test(text)) return input.id;
    }
    return "";
  }, regex.source);
  if (!id) return false;
  const checkbox = page.locator(`[id="${id.replace(/"/g, '\\"')}"]`).first();
  const label = page.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first();
  await page.evaluate((targetId) => {
    const element = document.getElementById(targetId);
    if (element) window.scrollTo({ top: Math.max(0, element.getBoundingClientRect().top + window.scrollY - 320), behavior: "instant" });
  }, id);
  await sleep(250);
  await checkbox.scrollIntoViewIfNeeded().catch(() => undefined);
  if (!(await checkbox.isChecked().catch(() => false))) await checkbox.check({ force: true });
  await sleep(500);
  if (!(await checkbox.isChecked().catch(() => false)) && (await label.count().catch(() => 0))) {
    await label.click({ force: true });
    await sleep(500);
  }
  return Boolean(await checkbox.isChecked().catch(() => false));
}

async function ensureApplyPage(page, input, req) {
  if (page.url().includes(req) && page.url().includes("/apply/")) return page;

  if (!page.url().includes(req)) {
    if (!input.includes("generalmotors.wd5.myworkdayjobs.com")) {
      throw new Error(`Need an open GM Workday job/apply page for ${req}, or pass a GM Workday URL`);
    }
    await page.goto(input, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await waitForPage(page);
  }

  if (page.url().includes("/apply/")) return page;

  const context = page.context();
  const newPagePromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  const clicked = await clickFirstVisible(page, [
    '[data-automation-id="adventureButton"]',
    'a:has-text("Apply")',
    'button:has-text("Apply")',
    'a:has-text("Apply Manually")',
    'button:has-text("Apply Manually")',
    'a:has-text("Use My Last Application")',
    'button:has-text("Use My Last Application")',
  ]);
  if (!clicked) {
    const text = await bodyText(page);
    throw new Error(`Could not find GM Apply button for ${req}: ${text.slice(0, 600)}`);
  }

  const maybeNewPage = await newPagePromise;
  if (maybeNewPage) page = maybeNewPage;
  await page.bringToFront().catch(() => undefined);
  await waitForPage(page);

  if (!page.url().includes("/apply/")) {
    const continueClicked = await clickFirstVisible(page, [
      'a:has-text("Apply Manually")',
      'button:has-text("Apply Manually")',
      'a:has-text("Use My Last Application")',
      'button:has-text("Use My Last Application")',
      '[data-automation-id="adventureButton"]',
    ]);
    if (continueClicked) await waitForPage(page);
  }

  if (!page.url().includes("/apply/")) {
    throw new Error(`GM page did not enter apply flow for ${req}: ${page.url()}`);
  }
  return page;
}

async function applyGm(input) {
  const req = extractReq(input);
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  let page = context.pages().find((candidate) => candidate.url().includes(req) && candidate.url().includes("/apply/"));
  if (!page) {
    page = context.pages().find((candidate) => candidate.url().includes(req));
  }
  if (!page) page = await context.newPage();

  try {
    page = await ensureApplyPage(page, input, req);
    await page.bringToFront().catch(() => undefined);
    await waitForPage(page);

    const text = await bodyText(page);
    if (/already applied|Application Submitted/i.test(text) && /Candidate Home/i.test(text)) {
      console.log(JSON.stringify({ submitted: true, req, url: page.url(), text: text.slice(0, 1000) }, null, 2));
      return;
    }

    if ((await currentStep(page)) <= 1) {
      await fillStep1(page);
      await saveAndContinue(page, 2);
    }
    if ((await currentStep(page)) <= 2) {
      await uploadResume(page);
      await saveAndContinue(page, 3);
    }
    if ((await currentStep(page)) <= 3) {
      await fillStep3(page);
      await saveAndContinue(page, 4);
    }
    if ((await currentStep(page)) <= 4) {
      await fillStep4(page);
      await saveAndContinue(page, 5);
    }
    if ((await currentStep(page)) <= 5) {
      await fillStep5(page);
      await saveAndContinue(page, 6);
    }
    await submitReview(page);
    const finalText = await bodyText(page);
    console.log(JSON.stringify({ submitted: true, req, url: page.url(), title: await page.title(), text: finalText.slice(0, 1400) }, null, 2));
  } finally {
    await browser.close();
  }
}

const input = process.argv.slice(2).join(" ");
if (!input) {
  console.error("Usage: node scripts/apply-gm-workday.mjs <GM Workday URL or open-page req id>");
  process.exit(2);
}

applyGm(input).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
