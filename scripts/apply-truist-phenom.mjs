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
  stateValue: "USA-NC",
  postalCode: "27609",
  phone: "9197100993",
  fullName: "Shadi Jabbour",
};

const experiences = [
  {
    title: "CTO",
    company: "Stealth Startup",
    location: "Raleigh, NC",
    start: "07/2023",
    current: true,
    description:
      "Built and deployed full-stack software systems for retail-focused client use cases.\nOwned implementation across product logic, backend services, databases, and cloud infrastructure.\nDesigned cloud architecture and auto-scaling policies to improve reliability and reduce cost.\nSet up delivery workflows that improved deployment speed and code quality.\nDelivered production software in a startup environment with broad technical ownership.",
  },
  {
    title: "Software Consultant",
    company: "Hurdle Solutions",
    location: "Raleigh, NC",
    start: "10/2019",
    current: true,
    description:
      "Built full-stack applications and cloud-based systems for client projects across web, data, and infrastructure.\nImplemented secure authentication, scalable backend services, and production deployment workflows.\nMigrated enterprise data systems to cloud platforms while reducing downtime and data-loss risk.\nDeveloped data pipelines and analytics workflows for reporting, forecasting, and operational insight.\nCreated dashboards and decision-support tooling for sales, marketing, and business operations.",
  },
  {
    title: "Software Engineer",
    company: "IBM",
    location: "Raleigh, NC",
    start: "01/2022",
    end: "06/2023",
    description:
      "Built and maintained web applications across frontend, backend, APIs, and server-side systems.\nRe-architected a core application to improve modularity, security, and deployment simplicity.\nResolved memory and database performance issues, reducing server resource usage by over 50%.\nImplemented CI/CD pipelines and container deployment workflows to improve uptime and release reliability.\nImproved responsiveness and reliability through queue-based request handling and cloud document storage.",
  },
  {
    title: "Software Engineer",
    company: "Red Hat",
    location: "Raleigh, NC",
    start: "05/2021",
    end: "12/2021",
    description:
      "Built a full-stack data discovery application for search, analytics, and self-service data access.\nImplemented real-time search and analytics features to improve data usability and retrieval speed.\nDesigned data processing workflows for ingestion into search and analytics platforms.\nBuilt deployment workflows and automation to support reliable releases.\nDeveloped a recommendation feature to improve dashboard relevance and presentation.",
  },
  {
    title: "Research Assistant",
    company: "North Carolina State University",
    location: "Raleigh, NC",
    start: "01/2021",
    end: "05/2021",
    description:
      "Built Python scripts for time-series analysis and forecasting across historical temperature datasets.\nDeveloped a data analysis platform with automated collection workflows and cloud API integrations.\nImproved visualization and analysis modules for clearer trend exploration and reporting.\nOptimized database performance and data flow, increasing platform efficiency by 40%.",
  },
];

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractJobSeqNo(input) {
  const value = String(input || "");
  try {
    const url = new URL(value);
    const fromQuery = url.searchParams.get("jobSeqNo");
    if (fromQuery) return fromQuery;
  } catch {
    // Accept raw job sequence numbers too.
  }

  const match = value.match(/TBJTBFUS[A-Z0-9]+EXTERNALENUS/i);
  if (match) return match[0].toUpperCase();
  throw new Error(`Could not find Truist jobSeqNo in: ${value}`);
}

function applyUrl(jobSeqNo) {
  return `https://careers.truist.com/us/en/apply?jobSeqNo=${jobSeqNo}&utm_source=linkedin&utm_medium=phenom-feeds&source=LinkedIn&step=1&stepname=personalInformation`;
}

async function bodyText(page) {
  return clean(await page.locator("body").innerText({ timeout: 15_000 }).catch(() => ""));
}

async function waitForPage(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await sleep(1_000);
}

async function isVisible(locator) {
  return (await locator.count().catch(() => 0)) > 0 && (await locator.first().isVisible().catch(() => false));
}

async function fillInput(page, selector, value) {
  const field = page.locator(selector).first();
  if (!(await isVisible(field))) return false;
  await field.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  await field.fill(String(value), { timeout: 10_000 });
  await field.dispatchEvent("input").catch(() => undefined);
  await field.dispatchEvent("change").catch(() => undefined);
  await field.blur().catch(() => undefined);
  return true;
}

async function selectOption(page, selector, matcher) {
  const field = page.locator(selector).first();
  if (!(await isVisible(field))) return false;
  await field.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  const value = await field.evaluate((element, serialized) => {
    const { text, value, regex } = serialized;
    const options = [...element.options];
    if (value) return options.find((option) => option.value === value)?.value || "";
    if (text) return options.find((option) => (option.textContent || "").trim() === text)?.value || "";
    if (regex) {
      const re = new RegExp(regex, "i");
      return options.find((option) => re.test((option.textContent || "").trim()))?.value || "";
    }
    return "";
  }, matcher);
  if (!value) return false;
  await field.selectOption(value, { timeout: 10_000 });
  await field.dispatchEvent("change").catch(() => undefined);
  await field.blur().catch(() => undefined);
  return true;
}

async function invalidFields(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("input, select, textarea")]
      .filter((element) => !element.checkValidity())
      .map((element) => ({
        id: element.id,
        type: element.type,
        value: element.value,
        message: element.validationMessage,
        visible: Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
        label:
          [...document.querySelectorAll("label")]
            .find((label) => label.htmlFor === element.id)
            ?.innerText?.replace(/\s+/g, " ")
            .trim() || "",
      })),
  );
}

async function currentStep(page) {
  const url = new URL(page.url());
  const step = Number(url.searchParams.get("step") || "0");
  const stepName = url.searchParams.get("stepname") || "";
  return { step, stepName, url: page.url() };
}

async function clickNextUntil(page, targetStep, label) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const before = await currentStep(page);
    if (before.step >= targetStep || page.url().includes("applythankyou")) return;

    const next = page.locator("#next, button:has-text('Next')").last();
    if (!(await isVisible(next))) throw new Error(`No Next button on ${label}`);
    await next.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
    await next.click({ force: true, timeout: 10_000 });
    await waitForPage(page);

    const after = await currentStep(page);
    if (after.step >= targetStep || after.url !== before.url) return;

    const invalid = await invalidFields(page);
    if (invalid.length) {
      throw new Error(`Still on ${label}; invalid fields: ${JSON.stringify(invalid.slice(0, 8))}`);
    }
    await sleep(1_000);
  }

  await sleep(5_000);
  const finalStep = await currentStep(page);
  if (finalStep.step >= targetStep || page.url().includes("applythankyou")) return;

  throw new Error(`Could not advance from ${label}; still at ${page.url()}`);
}

async function fillStep1(page) {
  await selectOption(page, "#applicantSource", { text: "LinkedIn" });
  await selectOption(page, "#country", { value: "USA" });
  await fillInput(page, '[id="cntryFields.firstName"]', profile.firstName);
  await fillInput(page, '[id="cntryFields.lastName"]', profile.lastName);
  await selectOption(page, '[id="cntryFields.preferredName"]', { regex: "^No$" });
  await fillInput(page, '[id="cntryFields.addressLine1"]', profile.address);
  await fillInput(page, '[id="cntryFields.city"]', profile.city);
  await selectOption(page, '[id="cntryFields.region"]', { value: profile.stateValue });
  await fillInput(page, '[id="cntryFields.postalCode"]', profile.postalCode);
  await fillInput(page, "#email", profile.email);
  await selectOption(page, "#deviceType", { text: "Mobile" });
  await selectOption(page, '[id="phoneWidget.countryPhoneCode"]', { value: "USA_1" });
  await fillInput(page, '[id="phoneWidget.phoneNumber"]', profile.phone);

  const fileInputs = await page.locator('input[type="file"]').count().catch(() => 0);
  for (let index = 0; index < fileInputs; index += 1) {
    await page.locator('input[type="file"]').nth(index).setInputFiles(resumePath).catch(() => undefined);
  }
  await sleep(2_500);
}

async function fillExperienceIfEmpty(page) {
  for (const [index, experience] of experiences.entries()) {
    const titleSelector = `[id="experienceData[${index}].title"]`;
    if (!(await page.locator(titleSelector).count().catch(() => 0))) continue;

    const currentTitle = await page.locator(titleSelector).first().inputValue().catch(() => "");
    if (!currentTitle) await fillInput(page, titleSelector, experience.title);
    await fillInput(page, `[id="experienceData[${index}].companyName"]`, experience.company);
    await fillInput(page, `[id="experienceData[${index}].location"]`, experience.location);
    await fillInput(page, `[id="experienceData[${index}].fromTo.startDate"]`, experience.start);
    if (experience.current) {
      const current = page.locator(`[id="experienceData[${index}].fromTo.currentlyWorkHere"]`).first();
      if ((await current.count().catch(() => 0)) && !(await current.isChecked().catch(() => false))) {
        await current.check({ force: true }).catch(() => undefined);
      }
    } else {
      await fillInput(page, `[id="experienceData[${index}].fromTo.endDate"]`, experience.end || "");
    }
    await fillInput(page, `[id="experienceData[${index}].description"]`, experience.description);
  }
}

async function chooseSchoolOther(page) {
  const school = page
    .locator('[id="educationData[0].schoolName"] input.rbt-input-main, input[aria-label="School or University"]')
    .first();
  if (!(await isVisible(school))) return false;
  await school.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  await school.click({ clickCount: 3 }).catch(() => undefined);
  await school.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
  await school.fill("");
  await school.type("Other", { delay: 20 });
  let option = page
    .locator('[role="option"], .dropdown-item, .rbt-menu a, .rbt-menu .dropdown-item')
    .filter({ hasText: /^Other$/i })
    .first();
  for (let attempt = 0; attempt < 12 && !(await isVisible(option)); attempt += 1) {
    await sleep(500);
    option = page
      .locator('[role="option"], .dropdown-item, .rbt-menu a, .rbt-menu .dropdown-item')
      .filter({ hasText: /^Other$/i })
      .first();
  }
  if (!(await isVisible(option))) throw new Error("Truist school typeahead did not expose the Other option");
  await option.click({ force: true, timeout: 10_000 });
  await sleep(500);

  const schoolErrors = await page
    .locator('[id="educationData[0].schoolName-errorMsg"], [aria-label="Enter school name"]')
    .count()
    .catch(() => 0);
  if (schoolErrors) throw new Error("Truist school typeahead still reports Enter school name after selecting Other");
  return true;
}

async function fillStep2(page) {
  await fillExperienceIfEmpty(page);
  await chooseSchoolOther(page);
  await selectOption(page, '[id="educationData[0].degree"]', { text: "Bachelor's Degree" });
  const selectedField = await selectOption(page, '[id="educationData[0].fieldOfStudy"]', { text: "Information Systems" });
  if (!selectedField) await selectOption(page, '[id="educationData[0].fieldOfStudy"]', { text: "Computer Science" });
  await fillInput(page, '[id="educationData[0].gradeAverage"]', "3.7");
}

async function fieldLabel(page, selector) {
  return clean(
    await page.locator(selector).first().evaluate((element) => {
      const label = [...document.querySelectorAll("label")].find((candidate) => candidate.htmlFor === element.id);
      if (label) return label.innerText || "";
      let node = element.parentElement;
      for (let depth = 0; depth < 8 && node; depth += 1, node = node.parentElement) {
        const text = (node.innerText || "").replace(/\s+/g, " ").trim();
        if (text) return text;
      }
      return "";
    }),
  );
}

async function selectByVisibleText(field, regex) {
  const value = await field.evaluate((element, source) => {
    const re = new RegExp(source, "i");
    return [...element.options].find((option) => re.test((option.textContent || "").trim()))?.value || "";
  }, regex.source);
  if (!value) return false;
  await field.selectOption(value);
  await field.dispatchEvent("change").catch(() => undefined);
  await field.blur().catch(() => undefined);
  return true;
}

function answerForSelect(label) {
  const text = label.toLowerCase();
  if (text.includes("sponsorship") || text.includes("immigration-related")) return /^No$/;
  if (text.includes("authorized") && text.includes("work")) return /^Yes$/;
  if (text.includes("18 years")) return /^Yes$/;
  if (text.includes("non-compete") || text.includes("non-solicitation") || text.includes("restrict")) return /^No$/;
  if (text.includes("pricewaterhousecoopers") || text.includes("pwc")) return /^No$/;
  if (text.includes("previously worked for truist") || text.includes("truist employment history")) {
    return /^No, I have never worked for Truist\./;
  }
  if (text.includes("willing to relocate")) return /^No$/;
  return null;
}

async function fillStep3(page) {
  const selects = await page.locator("select").count().catch(() => 0);
  for (let index = 0; index < selects; index += 1) {
    const field = page.locator("select").nth(index);
    if (!(await field.isVisible().catch(() => false))) continue;
    const id = await field.getAttribute("id");
    if (!id?.startsWith("jsqData.")) continue;
    const label = await fieldLabel(page, `[id="${id}"]`);
    const answer = answerForSelect(label);
    if (answer) {
      const selected = await selectByVisibleText(field, answer);
      if (!selected && (await field.evaluate((element) => element.required))) {
        throw new Error(`No matching answer for required Truist question: ${label}`);
      }
    }
  }

  const textFields = await page.locator("textarea, input[type='text']").count().catch(() => 0);
  for (let index = 0; index < textFields; index += 1) {
    const field = page.locator("textarea, input[type='text']").nth(index);
    if (!(await field.isVisible().catch(() => false))) continue;
    const id = await field.getAttribute("id");
    if (!id?.startsWith("jsqData.")) continue;
    const label = await fieldLabel(page, `[id="${id}"]`);
    const value = await field.inputValue().catch(() => "");
    if (value) continue;

    const normalized = label.toLowerCase();
    if (normalized.includes("expected base pay")) {
      await fillInput(page, `[id="${id}"]`, "Open to discussion based on the role scope and total compensation.");
    } else if ((await field.evaluate((element) => element.required || element.getAttribute("aria-required") === "true")) === true) {
      await fillInput(page, `[id="${id}"]`, "N/A");
    }
  }
}

async function fillStep4(page) {
  await selectOption(page, "#eeoUSA\\.ethnicity", { regex: "do not wish" });
  await selectOption(page, "#eeoUSA\\.veteranStatus", { regex: "not a veteran" });
  const agreement = page.locator("#agreementCheck").first();
  if (await isVisible(agreement)) {
    if (!(await agreement.isChecked().catch(() => false))) await agreement.check({ force: true });
  }
}

async function fillStep5(page) {
  await selectOption(page, "#languageChange", { text: "English" });
  await fillInput(page, '[id="disability_heading_self_identity1.signatureName"]', profile.fullName);
  const decline = page.locator('input[type="radio"][value*="DECLINE"], input[type="radio"][id*="DECLINE"]').first();
  if (await isVisible(decline)) {
    await decline.check({ force: true });
    return;
  }

  const radios = await page.locator('input[type="radio"]').count().catch(() => 0);
  for (let index = 0; index < radios; index += 1) {
    const radio = page.locator('input[type="radio"]').nth(index);
    const label = await radio.evaluate((element) => {
      const explicit = [...document.querySelectorAll("label")].find((candidate) => candidate.htmlFor === element.id);
      return explicit?.innerText || element.parentElement?.innerText || "";
    });
    if (/do not want|decline|do not wish/i.test(label)) {
      await radio.check({ force: true });
      return;
    }
  }
  throw new Error("Could not find disability decline option");
}

async function submitReview(page) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (page.url().includes("applythankyou")) return;
    const submit = page.locator("button").filter({ hasText: /^Submit$/ }).last();
    if (!(await isVisible(submit))) throw new Error("Submit button not visible on Truist review page");
    await submit.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
    await submit.click({ force: true, timeout: 10_000 });
    await waitForPage(page);
    const text = await bodyText(page);
    if (page.url().includes("applythankyou") || /successfully applied|thank you for applying/i.test(text)) return;
  }
  await sleep(6_000);
  const finalText = await bodyText(page);
  if (page.url().includes("applythankyou") || /successfully applied|thank you for applying/i.test(finalText)) return;
  throw new Error(`Submit did not reach confirmation: ${page.url()}`);
}

async function applyTruist(input) {
  const jobSeqNo = extractJobSeqNo(input);
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  const existingPage = context
    .pages()
    .reverse()
    .find((candidate) => candidate.url().includes(jobSeqNo) && candidate.url().includes("/apply"));
  const page = existingPage || (await context.newPage());

  try {
    if (!existingPage) {
      await page.goto(applyUrl(jobSeqNo), { waitUntil: "domcontentloaded", timeout: 45_000 });
    } else {
      await page.bringToFront().catch(() => undefined);
    }
    await waitForPage(page);

    const firstText = await bodyText(page);
    if (/no longer available|not accepting applications|page you are looking for/i.test(firstText)) {
      throw new Error(`Truist posting unavailable for ${jobSeqNo}: ${firstText.slice(0, 500)}`);
    }

    if (page.url().includes("applythankyou")) {
      // Already submitted in this browser session.
    } else {
      if ((await currentStep(page)).step <= 1) {
        await fillStep1(page);
        await clickNextUntil(page, 2, "step 1 personal information");
      }
      if ((await currentStep(page)).step <= 2) {
        await fillStep2(page);
        await clickNextUntil(page, 3, "step 2 work and education");
      }
      if ((await currentStep(page)).step <= 3) {
        await fillStep3(page);
        await clickNextUntil(page, 4, "step 3 application questions");
      }
      if ((await currentStep(page)).step <= 4) {
        await fillStep4(page);
        await clickNextUntil(page, 5, "step 4 voluntary disclosures");
      }
      if ((await currentStep(page)).step <= 5) {
        await fillStep5(page);
        await clickNextUntil(page, 6, "step 5 disability self-identification");
      }
      await submitReview(page);
    }

    const text = await bodyText(page);
    const result = { submitted: true, jobSeqNo, url: page.url(), title: await page.title(), text: text.slice(0, 1200) };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await browser.close();
  }
}

const input = process.argv.slice(2).join(" ");
if (!input) {
  console.error("Usage: node scripts/apply-truist-phenom.mjs <Truist job URL or jobSeqNo>");
  process.exit(2);
}

applyTruist(input).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
