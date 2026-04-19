import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const cdpUrl = process.env.JAA_CDP_URL || "http://127.0.0.1:9222";
const repoRoot = path.resolve(import.meta.dirname, "..");
const resumePath =
  process.env.JAA_RESUME_PATH ||
  process.env.JAA_RESUME_FILE_PATH ||
  path.join(repoRoot, "Shadi_Jabbour_Resume.pdf");

const profile = {
  email: "jabboursh@gmail.com",
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

function readDotEnvValue(name) {
  const envPath = path.join(repoRoot, ".env");
  const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  return (
    process.env[name] ||
    (envText.match(new RegExp(`^${name}=["']?([^"'\\r\\n]+)["']?`, "m")) || [])[1] ||
    ""
  ).trim();
}

function extractReq(input) {
  const value = String(input || "");
  const match = value.match(/_(\d+)\/?/) || value.match(/\/jobs\/(\d+)\//) || value.match(/\b(\d{7})\b/);
  if (!match) throw new Error(`Could not find Centene req id in ${value}`);
  return match[1];
}

async function waitForPage(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await sleep(1000);
}

async function bodyText(page) {
  return clean(await page.locator("body").innerText({ timeout: 10_000 }).catch(() => ""));
}

async function currentStep(page) {
  const text = await bodyText(page);
  const match = text.match(/current step\s+(\d+)\s+of\s+7/i);
  return match ? Number(match[1]) : 0;
}

async function visible(locator) {
  return (await locator.count().catch(() => 0)) > 0 && (await locator.first().isVisible().catch(() => false));
}

async function fillIfVisible(page, selector, value) {
  const field = page.locator(selector).first();
  if (!(await visible(field))) return false;
  const current = clean(await field.inputValue().catch(() => ""));
  if (current === clean(value)) return true;
  await field.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" })).catch(() => undefined);
  await sleep(150);
  await field.fill(value);
  await field.dispatchEvent("input").catch(() => undefined);
  await field.dispatchEvent("change").catch(() => undefined);
  await field.blur().catch(() => undefined);
  return true;
}

async function clickOptionByText(page, regex) {
  const option = await page.evaluate((source) => {
    const re = new RegExp(source, "i");
    const options = [...document.querySelectorAll('[role="option"], [data-automation-id="promptOption"], [id^="menuItem-"]')];
    for (const element of options) {
      const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      const rect = element.getBoundingClientRect();
      const visible = Boolean(rect.width || rect.height || element.getClientRects().length);
      if (visible && re.test(text)) {
        return { x: rect.x + Math.min(Math.max(rect.width / 2, 20), Math.max(rect.width - 8, 20)), y: rect.y + rect.height / 2 };
      }
    }
    return null;
  }, regex.source);
  if (!option) return false;
  await page.mouse.click(option.x, option.y);
  await sleep(650);
  return true;
}

async function openDropdown(page, selector) {
  const button = page.locator(selector).first();
  if (!(await visible(button))) return false;
  await page.keyboard.press("Escape").catch(() => undefined);
  await button.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" })).catch(() => undefined);
  await sleep(180);
  await button.click({ force: true, position: { x: 20, y: 20 } }).catch(() => undefined);
  await sleep(650);
  return true;
}

async function chooseDropdown(page, selector, regex) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (!(await openDropdown(page, selector))) return false;
    const options = page.locator('[role="option"], [data-automation-id="promptOption"], [id^="menuItem-"]');
    const count = await options.count().catch(() => 0);
    const texts = [];
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      if (!(await option.isVisible().catch(() => false))) {
        texts.push("");
        continue;
      }
      texts.push(clean(await option.textContent().catch(() => "")));
    }
    const matchIndex = texts.findIndex((text) => regex.test(text));
    if (matchIndex >= 0) {
      await options.nth(matchIndex).click({ force: true });
      await sleep(650);
      return true;
    }
    if (await clickOptionByText(page, regex)) return true;
  }
  return false;
}

async function chooseDropdownOrThrow(page, selector, regex) {
  if (!(await chooseDropdown(page, selector, regex))) {
    throw new Error(`Could not choose ${regex} from ${selector}`);
  }
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await visible(locator)) {
      await locator.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" })).catch(() => undefined);
      await sleep(150);
      await locator.click({ force: true });
      return true;
    }
  }
  return false;
}

async function fillWorkdayAuth(page) {
  const password = readDotEnvValue("JAA_WORKDAY_PASSWORD");
  if (!password) throw new Error("Missing JAA_WORKDAY_PASSWORD in environment or .env");

  const text = await bodyText(page);
  const passwordInputs = page.locator('input[type="password"]:visible');
  if ((await passwordInputs.count().catch(() => 0)) === 0) return false;
  if (!/Create Account|Sign In|Email Address|Password/i.test(text)) return false;

  const wantsCreate = /Create Account\/Sign In|current step 1 of 7 Create Account/i.test(text) && /Verify New Password/i.test(text);
  const inputs = page.locator('input:not([name="website"])');
  const count = await inputs.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    if (!(await input.isVisible().catch(() => false))) continue;
    const type = await input.getAttribute("type").catch(() => "");
    if (type === "password") await input.fill(password);
    else if (!["checkbox", "radio", "hidden", "submit", "button"].includes(String(type || "").toLowerCase())) {
      await input.fill(profile.email);
    }
  }

  const buttonName = wantsCreate ? /^Create Account$/i : /^Sign In$/i;
  const clicked = await page.getByRole("button", { name: buttonName }).click({ force: true }).then(() => true).catch(() => false);
  if (!clicked && wantsCreate) await page.getByRole("button", { name: /^Sign In$/i }).click({ force: true }).catch(() => undefined);
  await waitForPage(page);

  if (/^Sign In$/i.test(await page.title().catch(() => "")) || /Sign In Email Address\* Password\*/i.test(await bodyText(page))) {
    const signInputs = page.locator('input:not([name="website"])');
    const signCount = await signInputs.count().catch(() => 0);
    for (let index = 0; index < signCount; index += 1) {
      const input = signInputs.nth(index);
      if (!(await input.isVisible().catch(() => false))) continue;
      const type = await input.getAttribute("type").catch(() => "");
      if (type === "password") await input.fill(password);
      else await input.fill(profile.email);
    }
    await page.getByRole("button", { name: /^Sign In$/i }).click({ force: true });
    await waitForPage(page);
  }

  return true;
}

async function ensureApplyPage(page, input, req) {
  if (!page.url().includes(req)) {
    await page.goto(input, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await waitForPage(page);
  }

  if (!page.url().includes("/apply/")) {
    await clickFirstVisible(page, [
      'a:has-text("Apply Now")',
      'button:has-text("Apply Now")',
      'a:has-text("Apply")',
      'button:has-text("Apply")',
    ]);
    await waitForPage(page);
  }

  if (/Start Your Application/i.test(await bodyText(page))) {
    await clickFirstVisible(page, [
      'button:has-text("Use My Last Application")',
      'a:has-text("Use My Last Application")',
      'button:has-text("Apply Manually")',
      'a:has-text("Apply Manually")',
      'button:has-text("Autofill with Resume")',
    ]);
    await waitForPage(page);
  }

  await fillWorkdayAuth(page);
  if (!page.url().includes("/apply/")) throw new Error(`Did not enter Centene apply flow for ${req}: ${page.url()}`);
  return page;
}

async function fillStep1(page) {
  await fillIfVisible(page, "#name--legalName--firstName", profile.firstName);
  await fillIfVisible(page, "#name--legalName--lastName", profile.lastName);
  await fillIfVisible(page, "#address--addressLine1", profile.address);
  await fillIfVisible(page, "#address--city", profile.city);
  await chooseDropdown(page, "#address--countryRegion", /^North Carolina$/i);
  await fillIfVisible(page, "#address--postalCode", profile.postalCode);
  await chooseDropdown(page, "#phoneNumber--phoneType", /^Mobile$/i);
  await fillIfVisible(page, "#phoneNumber--phoneNumber", profile.phone);
}

async function uploadResumeIfNeeded(page) {
  const text = await bodyText(page);
  if (/Shadi_Jabbour_Resume\.pdf.*(successfully uploaded|75\.44 KB)|Resume\/CV Shadi_Jabbour_Resume\.pdf/i.test(text)) return;

  const fileInputs = page.locator('input[type="file"]');
  const count = await fileInputs.count().catch(() => 0);
  if (count > 0) {
    await fileInputs.first().setInputFiles(resumePath);
  } else {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 8_000 });
    await page.locator('[data-automation-id="select-files"], button:has-text("Select files")').first().click({ force: true });
    const chooser = await chooserPromise;
    await chooser.setFiles(resumePath);
  }
  await page.waitForFunction(() => /Shadi_Jabbour_Resume\.pdf|successfully uploaded/i.test(document.body.innerText || ""), {
    timeout: 25_000,
  });
  await sleep(1000);
}

async function fillApplicationQuestions(page) {
  const buttons = page.locator('button[id^="primaryQuestionnaire--"]');
  const count = await buttons.count().catch(() => 0);
  const orderedAnswers = [/^Yes$/i, /^No$/i, /^No$/i, /^No$/i, /^No$/i, /^No$/i, /^No$/i];
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const id = await button.getAttribute("id");
    const answer = orderedAnswers[index] || /^No$/i;
    await chooseDropdownOrThrow(page, `[id="${id}"]`, answer);
  }

  const textareas = page.locator('textarea[id^="primaryQuestionnaire--"]');
  const textareaCount = await textareas.count().catch(() => 0);
  for (let index = 0; index < textareaCount; index += 1) {
    const textarea = textareas.nth(index);
    if (!(await textarea.isVisible().catch(() => false))) continue;
    await textarea.fill("$150,000 annual salary");
  }
}

async function setCheckbox(page, selector) {
  const checkbox = page.locator(selector).first();
  if (!(await visible(checkbox))) return false;
  await checkbox.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" })).catch(() => undefined);
  await sleep(150);
  if (!(await checkbox.isChecked().catch(() => false))) await checkbox.click({ force: true });
  await sleep(350);
  if (await checkbox.isChecked().catch(() => false)) return true;

  const id = await checkbox.getAttribute("id").catch(() => "");
  if (id) {
    const label = page.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first();
    if (await visible(label)) {
      await label.click({ force: true });
      await sleep(350);
    }
  }
  return Boolean(await checkbox.isChecked().catch(() => false));
}

async function fillVoluntaryDisclosures(page) {
  if (await visible(page.locator("#personalInfoUS--gender").first())) {
    await chooseDropdown(page, "#personalInfoUS--gender", /choose not|do not wish|decline|not disclose/i);
  }
  await chooseDropdown(page, "#personalInfoUS--hispanicOrLatino", /choose not|do not wish|decline|not disclose|^No$/i);
  await chooseDropdownOrThrow(page, "#personalInfoUS--ethnicity", /undisclosed|choose not|do not wish|decline|not disclose/i);
  await chooseDropdownOrThrow(page, "#personalInfoUS--veteranStatus", /^I AM NOT A VETERAN$|^I am not a veteran$|not protected veteran/i);
  await setCheckbox(page, "#termsAndConditions--acceptTermsAndAgreements");
}

async function checkDisabilityDecline(page) {
  const declineLabel = page.locator("label", { hasText: /^I do not want to answer$/i }).first();
  if (await visible(declineLabel)) {
    await declineLabel.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" })).catch(() => undefined);
    await sleep(150);
    await declineLabel.click({ force: true });
    await sleep(500);
    const selected = await page
      .locator('input[type="checkbox"][id$="-disabilityStatus"]')
      .evaluateAll((inputs) => inputs.some((input) => input.checked || input.getAttribute("aria-checked") === "true"))
      .catch(() => false);
    if (selected) return true;
  }

  const byLabel = await page.evaluate(() => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    for (const input of document.querySelectorAll('input[type="checkbox"]')) {
      const labels = input.id ? [...document.querySelectorAll(`label[for="${CSS.escape(input.id)}"]`)] : [];
      const text = labels.map((label) => normalize(label.textContent)).join(" ");
      if (/I do not want to answer/i.test(text)) return input.id;
    }
    const boxes = [...document.querySelectorAll('input[type="checkbox"][id$="-disabilityStatus"]')];
    return boxes.length >= 3 ? boxes[2].id : "";
  });
  if (byLabel) return setCheckbox(page, `[id="${byLabel.replace(/"/g, '\\"')}"]`);
  return false;
}

async function fillSelfIdentify(page) {
  await page.waitForSelector("#selfIdentifiedDisabilityData--name", { timeout: 20_000 }).catch(() => undefined);
  await sleep(500);
  const today = new Date();
  await fillIfVisible(page, "#selfIdentifiedDisabilityData--name", profile.fullName);
  await fillIfVisible(page, "#selfIdentifiedDisabilityData--dateSignedOn-dateSectionMonth-input", String(today.getMonth() + 1).padStart(2, "0"));
  await fillIfVisible(page, "#selfIdentifiedDisabilityData--dateSignedOn-dateSectionDay-input", String(today.getDate()).padStart(2, "0"));
  await fillIfVisible(page, "#selfIdentifiedDisabilityData--dateSignedOn-dateSectionYear-input", String(today.getFullYear()));
  await checkDisabilityDecline(page);
}

async function completeAssessment(page) {
  if (/completed the assessment/i.test(await bodyText(page))) return;
  const context = page.context();
  const before = new Set(context.pages());
  await page.getByRole("button", { name: /^Take Assessment$/i }).click({ force: true });
  await sleep(5000);
  const survey = context
    .pages()
    .find((candidate) => !before.has(candidate) && /surveyengine\.taxcreditco\.com/i.test(candidate.url())) ||
    context.pages().find((candidate) => /surveyengine\.taxcreditco\.com/i.test(candidate.url()));
  if (survey) {
    await survey.bringToFront().catch(() => undefined);
    await survey.locator('input.opt-out-button, input[value="Opt Out"], input[name="SurveyControl$ctl05"]').first().click({ force: true });
    await sleep(6000);
  }
  await page.bringToFront().catch(() => undefined);
  await waitForPage(page);
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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const text = await bodyText(page);
    if (/Application Submitted|Application Received|Candidate Home/i.test(text) && !/current step 7 of 7/i.test(text)) return;
    const submit = page.getByRole("button", { name: /^Submit$/i }).first();
    if (!(await visible(submit))) {
      await waitForPage(page);
      const retryText = await bodyText(page);
      if (/Application Submitted|Application Received|Candidate Home/i.test(retryText) && !/current step 7 of 7/i.test(retryText)) return;
      throw new Error("Submit button not visible");
    }
    await submit.click({ force: true });
    await waitForPage(page);
  }
}

async function applyCentene(input) {
  const req = extractReq(input);
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  let page = context.pages().find((candidate) => candidate.url().includes(req) && candidate.url().includes("/apply/"));
  if (!page) page = await context.newPage();

  try {
    page = await ensureApplyPage(page, input, req);
    await page.bringToFront().catch(() => undefined);
    await waitForPage(page);

    const initialText = await bodyText(page);
    if (/already applied|Application Submitted|Application Received/i.test(initialText) && /Candidate Home/i.test(initialText)) {
      console.log(JSON.stringify({ submitted: true, req, alreadyApplied: true, url: page.url(), text: initialText.slice(0, 1400) }, null, 2));
      return;
    }

    if ((await currentStep(page)) <= 1) {
      await fillStep1(page);
      await saveAndContinue(page, 2);
    }
    if ((await currentStep(page)) <= 2) {
      await uploadResumeIfNeeded(page);
      await saveAndContinue(page, 3);
    }
    if ((await currentStep(page)) <= 3) {
      await fillApplicationQuestions(page);
      await saveAndContinue(page, 4);
    }
    if ((await currentStep(page)) <= 4) {
      await fillVoluntaryDisclosures(page);
      await saveAndContinue(page, 5);
    }
    if ((await currentStep(page)) <= 5) {
      await fillSelfIdentify(page);
      await saveAndContinue(page, 6);
    }
    if ((await currentStep(page)) <= 6) {
      await completeAssessment(page);
      if ((await currentStep(page)) <= 6) await saveAndContinue(page, 7);
    }
    await submitReview(page);

    const finalText = await bodyText(page);
    console.log(JSON.stringify({ submitted: /Application Submitted|Application Received|Candidate Home/i.test(finalText), req, url: page.url(), title: await page.title(), text: finalText.slice(0, 1800) }, null, 2));
  } finally {
    await browser.close();
  }
}

const input = process.argv.slice(2).join(" ");
if (!input) {
  console.error("Usage: node scripts/apply-centene-workday.mjs <Centene Workday apply URL>");
  process.exit(2);
}

applyCentene(input).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
