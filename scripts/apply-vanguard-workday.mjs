import { chromium } from "playwright";

const cdpUrl = process.env.JAA_CDP_URL || "http://127.0.0.1:9222";
const resumePath =
  process.env.JAA_RESUME_PATH ||
  "C:/Users/Charbel/Desktop/github/job-application-assistant/Shadi_Jabbour_Resume.pdf";

const profile = {
  firstName: "Shadi",
  lastName: "Jabbour",
  email: "jabboursh@gmail.com",
  address: "641 Pine Ridge Pl",
  city: "Raleigh",
  state: "North Carolina",
  postalCode: "27609",
  phone: "9197100993",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function bodyText(page) {
  return clean(await page.locator("body").innerText({ timeout: 10_000 }).catch(() => ""));
}

async function visibleCount(locator) {
  const count = await locator.count().catch(() => 0);
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}

async function clickVisible(locator, timeout = 10_000) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) {
      await item.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
      await item.click({ timeout });
      return true;
    }
  }
  return false;
}

async function fillIfPresent(page, selector, value) {
  const field = page.locator(selector).first();
  if (!(await field.count().catch(() => 0))) return false;
  await field.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  await field.fill(value, { timeout: 10_000 });
  return true;
}

async function optionTexts(page) {
  return page.locator('[role="option"]').evaluateAll((elements) =>
    elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .map((element, index) => ({
        index,
        text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
      })),
  );
}

async function clickOption(page, desired, { startsWith = false } = {}) {
  const options = await optionTexts(page);
  const exact = new RegExp(`^${escapeRegex(desired)}$`, "i");
  let match = options.find((option) => exact.test(option.text));
  if (!match && startsWith) {
    const prefix = new RegExp(`^${escapeRegex(desired)}\\b|^${escapeRegex(desired)},`, "i");
    match = options.find((option) => prefix.test(option.text));
  }
  if (!match) {
    throw new Error(`Option not found: ${desired}; options=${JSON.stringify(options)}`);
  }
  await page.locator('[role="option"]').nth(match.index).click({ timeout: 10_000 });
  await sleep(500);
}

async function selectButtonBySelector(page, selector, desired, options = {}) {
  const button = page.locator(selector).first();
  if (!(await button.count().catch(() => 0))) return false;
  const current = clean(await button.innerText().catch(() => ""));
  if (current && new RegExp(`^${escapeRegex(desired)}$`, "i").test(current)) return true;
  await button.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  await button.click({ timeout: 10_000 });
  await sleep(600);
  await clickOption(page, desired, options);
  return true;
}

async function selectFirstSelectOne(page, desired) {
  const button = page.locator("button").filter({ hasText: /^Select One$/ }).first();
  if (!(await button.count().catch(() => 0))) return false;
  await button.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  await button.click({ timeout: 10_000 });
  await sleep(600);
  await clickOption(page, desired, { startsWith: desired.toLowerCase() === "no" });
  return true;
}

async function clickNext(page) {
  await page.locator('button[data-automation-id="pageFooterNextButton"]').click({ timeout: 10_000 });
  await sleep(8_000);
}

async function selectSourceLinkedIn(page) {
  const containerText = await page
    .locator('[data-automation-id="multiSelectContainer"]')
    .first()
    .innerText({ timeout: 2_000 })
    .catch(() => "");
  if (/LinkedIn/i.test(containerText)) return;

  const source = page.locator("#source--source").first();
  await source.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  await source.click({ timeout: 10_000 });
  await sleep(600);

  if (!(await visibleCount(page.locator('div[role="option"][data-automation-id="menuItem"]').filter({ hasText: /^LinkedIn$/ })))) {
    const jobBoard = page.locator('div[role="option"][data-automation-id="menuItem"]').filter({ hasText: /^Job Board$/ }).first();
    await jobBoard.click({ timeout: 10_000, position: { x: 20, y: 16 } });
    await sleep(700);
  }

  await page
    .locator('div[role="option"][data-automation-id="menuItem"]')
    .filter({ hasText: /^LinkedIn$/ })
    .first()
    .click({ timeout: 10_000, position: { x: 20, y: 16 } });
  await sleep(700);
  await page.keyboard.press("Escape").catch(() => undefined);
}

async function fillStepOne(page) {
  await selectSourceLinkedIn(page);
  await page
    .locator('#previousWorker--candidateIsPreviousWorker input[type="radio"][value="false"]')
    .check({ force: true })
    .catch(() => undefined);
  await fillIfPresent(page, "#name--legalName--firstName", profile.firstName);
  await fillIfPresent(page, "#name--legalName--lastName", profile.lastName);
  await fillIfPresent(page, "#address--addressLine1", profile.address);
  await fillIfPresent(page, "#address--city", profile.city);
  await selectButtonBySelector(page, "#address--countryRegion", profile.state);
  await fillIfPresent(page, "#address--postalCode", profile.postalCode);
  await selectButtonBySelector(page, "#phoneNumber--phoneType", "Mobile");
  await fillIfPresent(page, "#phoneNumber--phoneNumber", profile.phone);
  await clickNext(page);
}

async function fillStepTwo(page) {
  const text = await bodyText(page);
  if (!/Successfully Uploaded|Shadi_Jabbour_Resume\.pdf/i.test(text)) {
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count().catch(() => 0)) {
      await fileInput.setInputFiles(resumePath);
    } else {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10_000 }),
        page.locator('button[data-automation-id="select-files"]').click({ timeout: 10_000 }),
      ]);
      await chooser.setFiles(resumePath);
    }
    await sleep(5_000);
  }
  await clickNext(page);
}

async function checkVisibleCheckboxByLabel(page, label) {
  const boxes = page.locator('input[type="checkbox"]');
  const count = await boxes.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index);
    const currentLabel = clean(
      await box.evaluate((element) => (element.labels && element.labels[0] ? element.labels[0].innerText : "")).catch(() => ""),
    );
    if (currentLabel === label) {
      await box.check({ force: true });
      return true;
    }
  }
  return false;
}

async function fillApplicationQuestions(page) {
  while ((await page.locator("button").filter({ hasText: /^Select One$/ }).count().catch(() => 0)) > 0) {
    const first = page.locator("button").filter({ hasText: /^Select One$/ }).first();
    const context = clean(
      await first.evaluate((element) => {
        let cursor = element.parentElement;
        for (let depth = 0; cursor && depth < 7; depth += 1, cursor = cursor.parentElement) {
          const text = cursor.innerText || "";
          if (text.includes("?") || text.includes("Required")) return text;
        }
        return element.innerText || "";
      }),
    );
    const answer = /citizen|lawful permanent resident|refugee|asylum/i.test(context) ? "Yes" : "No";
    await selectFirstSelectOne(page, answer);
  }
  await checkVisibleCheckboxByLabel(page, "No");
  await checkVisibleCheckboxByLabel(page, "None");
  await clickNext(page);
}

async function fillVoluntaryDisclosures(page) {
  await selectButtonBySelector(page, 'button[aria-label^="What is your Gender?"]', "Undisclosed");
  await selectButtonBySelector(page, 'button[aria-label^="What is your Veteran Status?"]', "I AM NOT A VETERAN");
  await page.getByLabel(/Yes, I have read and consent/i).first().check({ force: true });
  await clickNext(page);
}

async function startApplication(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(8_000);
  if (/application received|application submitted|jobTasks\/completed/i.test(await bodyText(page))) return;

  const apply = page.locator('a[data-automation-id="adventureButton"], a:has-text("Apply"), button:has-text("Apply")').first();
  if (await apply.count().catch(() => 0)) {
    await apply.click({ timeout: 10_000 });
    await sleep(5_000);
  }

  const useLast = page.locator('a[data-automation-id="useMyLastApplication"], a:has-text("Use My Last Application")').first();
  if (await useLast.count().catch(() => 0)) {
    await useLast.click({ timeout: 10_000 });
    await sleep(8_000);
  }
}

async function run(url) {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page =
    context.pages().find((candidate) => /vanguard\.wd5\.myworkdayjobs\.com/.test(candidate.url())) ||
    (await context.newPage());
  await page.bringToFront();

  await startApplication(page, url);
  for (let guard = 0; guard < 8; guard += 1) {
    const text = await bodyText(page);
    if (/application received|application submitted|jobTasks\/completed/i.test(`${text} ${page.url()}`)) break;
    if (/current step 1 of 5 My Information|My Information \* Indicates/i.test(text)) {
      await fillStepOne(page);
      continue;
    }
    if (/current step 2 of 5 My Experience|My Experience \* Indicates/i.test(text)) {
      await fillStepTwo(page);
      continue;
    }
    if (/current step 3 of 5 Application Questions|Application Questions \* Indicates/i.test(text)) {
      await fillApplicationQuestions(page);
      continue;
    }
    if (/current step 4 of 5 Voluntary Disclosures|Voluntary Disclosures \* Indicates/i.test(text)) {
      await fillVoluntaryDisclosures(page);
      continue;
    }
    if (/current step 5 of 5 Review|Review My Information/i.test(text)) {
      await page.locator('button[data-automation-id="pageFooterNextButton"]').click({ timeout: 10_000 });
      await sleep(12_000);
      continue;
    }
    throw new Error(`Unrecognized Vanguard state at ${page.url()}: ${text.slice(0, 800)}`);
  }

  const finalText = await bodyText(page);
  const result = {
    url: page.url(),
    title: await page.title().catch(() => ""),
    submitted: /application received|application submitted|successfully been submitted|jobTasks\/completed/i.test(
      `${finalText} ${page.url()}`,
    ),
    text: finalText.slice(0, 3000),
  };
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

const url = process.argv[2];
if (!url) {
  console.error("Usage: node scripts/apply-vanguard-workday.mjs <vanguard-workday-job-url>");
  process.exit(2);
}

run(url).catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
