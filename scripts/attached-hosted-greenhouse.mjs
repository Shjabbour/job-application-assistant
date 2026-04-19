import path from "node:path";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

function read(value) {
  return (value ?? "").toString().replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return read(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function dedupe(values) {
  return [...new Set(values.map((value) => read(value)).filter(Boolean))];
}

function isMeaningfulValue(value) {
  const normalized = normalize(value);
  return Boolean(normalized) && !/^select( an)? option$/.test(normalized);
}

function isNonDisclosureOption(value) {
  return /prefer not|decline|self identify|wish to answer|rather not|no answer|not say/.test(normalize(value));
}

function matchesChoice(actualValue, desiredValue) {
  const actual = normalize(actualValue);
  const desired = normalize(desiredValue);
  if (!actual || !desired) {
    return false;
  }

  const containsWhole = (haystack, needle) =>
    haystack === needle ||
    haystack.startsWith(`${needle} `) ||
    haystack.endsWith(` ${needle}`) ||
    haystack.includes(` ${needle} `);

  if (containsWhole(actual, desired) || containsWhole(desired, actual)) {
    return true;
  }

  if (desired === "male" && (actual === "man" || actual.includes("man"))) {
    return true;
  }
  if (desired === "female" && (actual === "woman" || actual.includes("woman"))) {
    return true;
  }
  if (desired === "no" && (/^no\b/.test(actual) || /i am not/.test(actual) || /don t have/.test(actual))) {
    return true;
  }
  if (
    (desired.includes("not") || desired.includes("no")) &&
    (actual.includes("no military service") || actual.includes("not a protected veteran"))
  ) {
    return true;
  }
  if (desired === "yes" && /^yes\b/.test(actual)) {
    return true;
  }
  if (/^yes\b/.test(actual) && /\bauthori[sz]ed\b|\bright to work\b|\bnationality\b/.test(desired)) {
    return true;
  }
  if (isNonDisclosureOption(actualValue) && isNonDisclosureOption(desiredValue)) {
    return true;
  }

  return false;
}

function buildResult(filled, skipped, nextAction, options = {}) {
  return {
    filled: dedupe(filled),
    skipped: dedupe(skipped.filter((label) => !filled.includes(label))),
    nextAction,
    stoppedBeforeSubmit: options.stoppedBeforeSubmit === true,
    submitted: options.submitted === true,
    stopReason: options.stopReason || "",
  };
}

async function loadApplicationAnswers(repoRoot) {
  const answersPath = path.join(repoRoot, "data", "application-answers.json");
  try {
    const raw = await readFile(answersPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      text: parsed?.text && typeof parsed.text === "object" ? parsed.text : {},
      select: parsed?.select && typeof parsed.select === "object" ? parsed.select : {},
      radio: parsed?.radio && typeof parsed.radio === "object" ? parsed.radio : {},
      checkbox: parsed?.checkbox && typeof parsed.checkbox === "object" ? parsed.checkbox : {},
    };
  } catch {
    return { text: {}, select: {}, radio: {}, checkbox: {} };
  }
}

function lookupApplicationAnswer(answers, label, type) {
  const normalizedLabel = normalize(label);
  const normalizedType = normalize(type);
  const buckets = [
    normalizedType.includes("radio") ? answers.radio : null,
    normalizedType.includes("select") || normalizedType.includes("dropdown") || normalizedType.includes("combobox")
      ? answers.select
      : null,
    normalizedType.includes("checkbox") ? answers.checkbox : null,
    answers.text,
    answers.select,
    answers.radio,
    answers.checkbox,
  ].filter(Boolean);

  for (const bucket of buckets) {
    for (const [pattern, answer] of Object.entries(bucket)) {
      const normalizedPattern = normalize(pattern);
      if (!normalizedPattern || !read(answer)) {
        continue;
      }
      if (normalizedLabel.includes(normalizedPattern) || normalizedPattern.includes(normalizedLabel)) {
        return read(answer);
      }
    }
  }

  return "";
}

function inferCommonAnswer(label, type, profile, answers) {
  const normalizedLabel = normalize(label);
  if (/^search by\b/.test(normalizedLabel) || /\bsearch\b/.test(normalizedLabel)) {
    return "";
  }
  const explicit = lookupApplicationAnswer(answers, label, type);
  if (explicit) {
    return explicit;
  }
  const profileText = normalize([
    profile.resumeSummary,
    Array.isArray(profile.skills) ? profile.skills.join(" ") : "",
    Array.isArray(profile.targetRoles) ? profile.targetRoles.join(" ") : "",
  ].join(" "));

  const first = read(profile.name).split(/\s+/)[0] || "";
  const last = read(profile.name).split(/\s+/).slice(1).join(" ");
  const location = [read(profile.city), read(profile.state)].filter(Boolean).join(", ") || read(profile.location);

  if (/preferred first name/.test(normalizedLabel)) return first;
  if (/(legal )?first name|given name/.test(normalizedLabel)) return first;
  if (/(legal )?last name|surname|family name/.test(normalizedLabel)) return last;
  if (/\bemail\b/.test(normalizedLabel)) return read(profile.email);
  if (/\bphone\b|telephone|mobile/.test(normalizedLabel)) return read(profile.phone);
  if (/postal code|zip code|zipcode/.test(normalizedLabel)) return read(profile.postalCode);
  if (/your authorization to work|work authorization|authorized to work|right to work/.test(normalizedLabel)) {
    return "I am authorized to work in the country due to my nationality";
  }
  if (/currently based.*countries|based in any of these countries|currently based.*country/.test(normalizedLabel)) {
    return "United States";
  }
  if (/one of the following states|do you live in one of|alabama.*alaska.*delaware/.test(normalizedLabel)) {
    return "No";
  }
  if (/\bcountry\b/.test(normalizedLabel)) return "United States";
  if (/\blocation\b|city, state/.test(normalizedLabel)) return location;
  if (/\bcity\b/.test(normalizedLabel)) return read(profile.city);
  if (/\bstate\b|province|region/.test(normalizedLabel)) return read(profile.state);
  if (/currently reside.*united states|reside in the united states|currently live.*united states/.test(normalizedLabel)) return "Yes";
  if (/currently located.*country/.test(normalizedLabel)) return "Yes";
  if (/linkedin/.test(normalizedLabel)) return read(profile.linkedinUrl);
  if (/website|portfolio/.test(normalizedLabel)) return lookupApplicationAnswer(answers, "website", "text");
  if (/github/.test(normalizedLabel)) return lookupApplicationAnswer(answers, "github", "text");
  if (/how did you hear about this job|where did you hear|where did you learn/.test(normalizedLabel)) return "LinkedIn";
  if (/know anyone.*currently at|know someone.*currently at|know anyone.*work(?:ing)? at|know someone.*work(?:ing)? at/.test(normalizedLabel)) {
    return "No";
  }
  if (/built.*ai agents|ai agents.*built|built.*agentic|agentic.*built/.test(normalizedLabel)) {
    return /select|combobox/.test(type)
      ? "Yes"
      : "Yes - I have built agentic automation workflows using TypeScript, Playwright, LLM-assisted tooling, structured browser inspection, form handling, and retry logic to complete multi-step tasks with a clear audit trail.";
  }
  if (/employee refer|employee referral|referred by an employee|referred you/.test(normalizedLabel)) return "No";
  if (/why.*interested|what interests you|why this opportunity|why this company|why do you want/.test(normalizedLabel)) {
    return read(profile.resumeSummary) || "This role aligns with my background building production software across backend systems, web applications, APIs, cloud infrastructure, and data workflows.";
  }
  if (/current \(or most recent\) company|current company|most recent company/.test(normalizedLabel)) {
    return lookupApplicationAnswer(answers, "current company", "text") || "Hurdle Solutions";
  }
  if (/years of experience|how many years|experience/.test(normalizedLabel)) return read(profile.yearsOfExperience);
  if (/work authorization|citizenship/.test(normalizedLabel) && !/authorized|right to work|sponsorship/.test(normalizedLabel)) {
    return read(profile.workAuthorization);
  }
  if (
    /legally authorized|authorized to work|right to work/.test(normalizedLabel) &&
    /without (the )?need|without.*sponsorship/.test(normalizedLabel)
  ) {
    return "Yes";
  }
  if (/legally authorized|authorized to work|right to work/.test(normalizedLabel)) return "Yes";
  if (/sponsorship|visa/.test(normalizedLabel)) return "No";
  if (/acknowledge.*privacy notice|read and understand.*privacy notice|privacy notice/.test(normalizedLabel)) {
    return "Acknowledge/Confirm";
  }
  if (/privacy statement|privacy policy/.test(normalizedLabel)) return "I agree";
  if (/double check|double-check|reviewed and confirmed|information provided.*accurate|accuracy is crucial/.test(normalizedLabel)) {
    return "I have reviewed and confirmed that all the information provided is accurate and complete.";
  }
  if (/transgender/.test(normalizedLabel)) return "No";
  if (/sexual orientation/.test(normalizedLabel)) return "I don't wish to answer";
  if (/ethnicit/.test(normalizedLabel) || /\brace\b/.test(normalizedLabel)) return "I don't wish to answer";
  if (/by checking this box|consent to .*collecting.*processing|demographic data surveys/.test(normalizedLabel)) {
    return "Yes";
  }
  if (/political products|political campaign|campaign software/.test(normalizedLabel)) return "No";
  if (/llm|large language model|ai systems.*automation/.test(normalizedLabel)) {
    return /\b(ai|artificial intelligence|machine learning|ml|llm|large language model|openai|generative ai|langchain)\b/.test(profileText)
      ? "Yes"
      : "No";
  }
  if (/gender/.test(normalizedLabel)) return lookupApplicationAnswer(answers, "gender", type) || "I don't wish to answer";
  if (/disability/.test(normalizedLabel)) return lookupApplicationAnswer(answers, "disability status", type) || "I don't wish to answer";
  if (/served in the military|military service/.test(normalizedLabel)) {
    return lookupApplicationAnswer(answers, "military service", type) || "No military service";
  }
  if (/veteran/.test(normalizedLabel)) return lookupApplicationAnswer(answers, "veteran status", type) || "No";

  return "";
}

async function acceptCookieBannerIfPresent(page) {
  const accept = page.getByRole("button", { name: /^i accept$/i }).first();
  if (await accept.isVisible().catch(() => false)) {
    await accept.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(1000);
    return true;
  }

  const selectors = [
    'button:has-text("I accept")',
    'button:has-text("I Accept")',
    '[role="button"]:has-text("I accept")',
    '[role="button"]:has-text("I Accept")',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      const clicked = await locator.click({ force: true }).then(() => true).catch(() => false);
      if (clicked) {
        await page.waitForTimeout(1000);
        return true;
      }
    }
  }
  return false;
}

async function detectCaptchaChallenge(page) {
  const frameUrls = page.frames().map((frame) => frame.url());
  if (
    frameUrls.some((url) =>
      /hcaptcha\.com\/captcha\/.*(?:frame=(?:challenge|checkbox|enclave)|hcaptcha(?:-enclave)?\.html#frame=(?:challenge|checkbox|enclave))/i.test(
        url,
      ),
    )
  ) {
    return "Manual CAPTCHA verification is required.";
  }

  const text = normalize(await page.locator("body").innerText().catch(() => ""));
  if (
    /verify you are human|human verification|security verification|security check|complete the captcha|captcha challenge|protected by hcaptcha/.test(text) &&
    frameUrls.some((url) => /hcaptcha\.com|recaptcha\.net|google\.com\/recaptcha/i.test(url))
  ) {
    return "Manual CAPTCHA verification is required.";
  }

  return "";
}

async function findFieldByLabelContains(page, text) {
  const candidate = await page.locator("input, textarea, select").evaluateAll((nodes, needle) => {
    const read = (value) => (value ?? "").toString().replace(/\s+/g, " ").trim();
    const normalize = (value) => read(value).toLowerCase();
    const weakLabel = (value) => /^(select|select\.\.|required|optional)$/i.test(read(value));
    const nearbyLabel = (element) => {
      const containers = [
        element.closest(".field"),
        element.closest(".application-question"),
        element.closest(".select"),
        element.closest(".select__container"),
        element.closest(".select-shell"),
        element.closest(".input-wrapper"),
        element.closest(".text-input-wrapper"),
        element.closest(".checkbox"),
        element.closest(".checkbox__wrapper"),
        element.closest("[class*='field']"),
        element.closest("[class*='question']"),
        element.parentElement?.parentElement,
        element.parentElement,
      ].filter(Boolean);
      for (const container of containers) {
        const candidates = container.querySelectorAll("label, legend, [class*='label'], [class*='Label']");
        for (const candidate of Array.from(candidates)) {
          const text = read(candidate.textContent);
          if (text && !weakLabel(text)) {
            return text;
          }
        }
      }
      return "";
    };
    const target = normalize(String(needle));
    for (const node of nodes) {
      const element = node;
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
      if (!label || weakLabel(label)) {
        label = nearbyLabel(element) || label;
      }
      if (label && normalize(label).includes(target)) {
        return { id, name: element.getAttribute("name") || "" };
      }
    }
    return null;
  }, text).catch(() => null);

  if (!candidate) {
    return null;
  }
  if (candidate.id) {
    const escaped = candidate.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return page.locator(`[id="${escaped}"]`).first();
  }
  if (candidate.name) {
    const escaped = candidate.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return page.locator(`[name="${escaped}"]`).first();
  }
  return null;
}

async function checkCheckboxByLabelContains(page, patterns) {
  const normalizedPatterns = patterns.map((pattern) => normalize(pattern)).filter(Boolean);
  if (normalizedPatterns.length === 0) {
    return false;
  }

  const inputs = page.locator('input[type="checkbox"]');
  const inputCount = await inputs.count().catch(() => 0);
  for (let index = 0; index < inputCount; index += 1) {
    const input = inputs.nth(index);
    if (!(await input.isVisible().catch(() => false))) {
      continue;
    }

    const meta = await readFieldMeta(input);
    const text = normalize(`${meta?.label || ""} ${meta?.name || ""}`);
    if (!text || !normalizedPatterns.some((pattern) => text.includes(pattern) || pattern.includes(text))) {
      continue;
    }

    const checked = await input.isChecked().catch(() => false);
    if (checked || (await input.check({ force: true }).then(() => true).catch(() => false))) {
      return true;
    }
  }

  const labels = page.locator('label, [role="checkbox"]');
  const labelCount = await labels.count().catch(() => 0);
  for (let index = 0; index < labelCount; index += 1) {
    const label = labels.nth(index);
    const visible = await label.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    const text = normalize(await label.textContent().catch(() => ""));
    if (!text || !normalizedPatterns.some((pattern) => text.includes(pattern) || pattern.includes(text))) {
      continue;
    }

    const nested = label.locator('input[type="checkbox"]').first();
    if ((await nested.count().catch(() => 0)) > 0) {
      const checked = await nested.isChecked().catch(() => false);
      if (checked) {
        return true;
      }
      if (await nested.check({ force: true }).then(() => true).catch(() => false)) {
        return true;
      }
    }

    if (await label.click({ force: true }).then(() => true).catch(() => false)) {
      await page.waitForTimeout(150);
      const checked =
        (await nested.isChecked().catch(() => false)) ||
        (read(await label.getAttribute("aria-checked").catch(() => "")) === "true");
      if (checked || (await label.locator('input[type="checkbox"]:checked').count().catch(() => 0)) > 0) {
        return true;
      }
    }
  }

  return false;
}

async function waitForHostedGreenhouseFields(page) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const phone = await findFieldByLabelContains(page, "Phone");
    const email = await findFieldByLabelContains(page, "Email");
    if (phone || email) {
      return;
    }
    await page.waitForTimeout(500);
  }
}

async function readFieldMeta(field) {
  return field.evaluate((node) => {
    const element = node;
    const read = (value) => (value ?? "").toString().replace(/\s+/g, " ").trim();
    const weakLabel = (value) => /^(select|select\.\.|required|optional)$/i.test(read(value));
    const nearbyLabel = () => {
      const containers = [
        element.closest(".field"),
        element.closest(".application-question"),
        element.closest(".select"),
        element.closest(".select__container"),
        element.closest(".select-shell"),
        element.closest(".input-wrapper"),
        element.closest(".text-input-wrapper"),
        element.closest(".checkbox"),
        element.closest(".checkbox__wrapper"),
        element.closest("[class*='field']"),
        element.closest("[class*='question']"),
        element.parentElement?.parentElement,
        element.parentElement,
      ].filter(Boolean);
      for (const container of containers) {
        const candidates = container.querySelectorAll("label, legend, [class*='label'], [class*='Label']");
        for (const candidate of Array.from(candidates)) {
          const text = read(candidate.textContent);
          if (text && !weakLabel(text)) {
            return text;
          }
        }
      }
      return "";
    };
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
    if (!label || weakLabel(label)) {
      label = nearbyLabel() || label;
    }
    const tag = element.tagName.toLowerCase();
    const type = tag === "select" ? "select" : (element.getAttribute("type") || tag);
    const required =
      element.hasAttribute("required") ||
      element.getAttribute("aria-required") === "true";
    const role = element.getAttribute("role") || "";
    const readReactSelectSelection = () => {
      const expand = (container) => [container, container?.parentElement, container?.parentElement?.parentElement];
      const roots = [
        element.closest(".select__container"),
        element.closest(".select-shell"),
        element.closest(".select"),
        element.closest("[class*='select']"),
        element.closest("[class*='Select']"),
        element.closest("[class*='field']"),
        element.closest("[class*='Field']"),
        element.closest("[class*='question']"),
        element.closest("[class*='Question']"),
        element.parentElement?.parentElement,
      ];
      const containers = [...new Set(roots.flatMap(expand).filter(Boolean))];
      for (const container of containers) {
        const singleValue = read(container.querySelector(".select__single-value, [class*='singleValue'], [class*='SingleValue']")?.textContent);
        const multiValues = Array.from(container.querySelectorAll(".select__multi-value__label, .select__multi-value, [class*='multiValue'], [class*='MultiValue']"))
          .map((item) => read(item.textContent))
          .filter(Boolean);
        const value = [singleValue, ...multiValues].filter(Boolean).join(" | ");
        if (value) {
          return { singleValue, multiValues, value };
        }
      }
      return { singleValue: "", multiValues: [], value: "" };
    };
    const selection = readReactSelectSelection();
    const singleValue = selection.singleValue;
    const multiValues = selection.multiValues;
    const currentValue =
      tag === "select"
        ? read(element.selectedOptions?.[0]?.textContent || element.value)
        : role === "combobox"
          ? selection.value
        : read(element.value);
    const name = element.getAttribute("name") || "";
    return { label, tag, type, required, currentValue, name, role, singleValue, multiValues };
  }).catch(() => null);
}

async function selectBestOption(field, desiredValue) {
  const options = await field.locator("option").evaluateAll((nodes) =>
    nodes.map((node) => ({
      label: (node.textContent || "").replace(/\s+/g, " ").trim(),
      value: node.getAttribute("value") || "",
    })),
  ).catch(() => []);

  for (const option of options) {
    if (matchesChoice(option.label, desiredValue)) {
      const byLabel = await field.selectOption({ label: option.label }).catch(() => []);
      if (byLabel.length > 0) {
        return true;
      }
      const byValue = await field.selectOption(option.value).catch(() => []);
      if (byValue.length > 0) {
        return true;
      }
    }
  }

  return (await field.selectOption({ label: desiredValue }).catch(() => [])).length > 0;
}

async function selectComboboxOption(page, field, desiredValue) {
  const selectionMatches = (selection) =>
    matchesChoice(selection.singleValue, desiredValue) ||
    selection.multiValues.some((value) => matchesChoice(value, desiredValue));

  const getControlBox = async () =>
    field
      .evaluate((node) => {
        const element = node;
        const select = element.closest(".select");
        const control =
          select?.querySelector(".select__control, [class*='control'], [class*='Control']") ||
          element.closest(".select__control, [class*='control'], [class*='Control']") ||
          element;
        const rect = control.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
        };
      })
      .catch(() => null);

  const clickControl = async () => {
    await field.scrollIntoViewIfNeeded().catch(() => undefined);
    const box = await getControlBox();
    if (box && box.width > 0 && box.height > 0) {
      await page.mouse.click(box.x, box.y).catch(() => undefined);
      await page.waitForTimeout(150);
      return true;
    }
    return field.click({ force: true }).then(() => true).catch(() => false);
  };

  const visibleOptions = async () => {
    const id = read(await field.getAttribute("id").catch(() => ""));
    return page
      .locator(".select__menu [class*='option'], .select__menu [role='option']")
      .evaluateAll((nodes, rawId) => {
        const read = (value) => (value ?? "").toString().replace(/\s+/g, " ").trim();
        const id = String(rawId || "");
        const idPrefix = id ? `react-select-${id}-option-` : "";
        return nodes
          .map((node, index) => {
            const element = node;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const text = read(element.textContent);
            return {
              id: element.getAttribute("id") || "",
              text,
              index,
              matchesField: !idPrefix || (element.getAttribute("id") || "").startsWith(idPrefix),
              visible:
                Boolean(text) &&
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== "none" &&
                style.visibility !== "hidden",
            };
          })
          .filter((option) => option.visible);
      }, id)
      .catch(() => []);
  };

  const clickVisibleOption = async () => {
    const id = read(await field.getAttribute("id").catch(() => ""));
    const listboxId = read(await field.getAttribute("aria-controls").catch(() => ""));
    const attrEscape = (value) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const optionLocators = [];
    if (id) {
      optionLocators.push(page.locator(`[id^="react-select-${attrEscape(id)}-option-"]`));
    }
    if (listboxId) {
      optionLocators.push(page.locator(`[id="${attrEscape(listboxId)}"] [role="option"]`));
    }
    optionLocators.push(page.locator(".select__menu [class*='option'], .select__menu [role='option']"));

    for (const options of optionLocators) {
      const optionCount = await options.count().catch(() => 0);
      for (let index = 0; index < optionCount; index += 1) {
        const option = options.nth(index);
        if (!(await option.isVisible().catch(() => false))) {
          continue;
        }
        const text = read(await option.textContent().catch(() => ""));
        if (matchesChoice(text, desiredValue)) {
          return await option.click({ force: true }).then(() => true).catch(() => false);
        }
      }
    }

    return false;
  };

  const clickAndType = async () => {
    await clickControl();
    await field.fill("").catch(() => undefined);
    await field.type(desiredValue, { delay: 20 }).catch(() => undefined);
    await page.waitForTimeout(650);
  };

  const readSelection = async () => {
    const meta = await readFieldMeta(field);
    return {
      singleValue: read(meta?.singleValue),
      multiValues: Array.isArray(meta?.multiValues) ? meta.multiValues.map((value) => read(value)).filter(Boolean) : [],
    };
  };

  const alreadySelected = await readSelection();
  if (selectionMatches(alreadySelected)) {
    return true;
  }

  await clickControl();
  await page.waitForTimeout(250);
  if (await clickVisibleOption()) {
    await page.waitForTimeout(250);
    const selected = await readSelection();
    if (selectionMatches(selected)) {
      return true;
    }
  }

  await clickAndType();
  const listboxId = read(await field.getAttribute("aria-controls").catch(() => ""));
  let options = page.locator(".select__menu [class*='option'], .select__menu [role='option']");
  if (listboxId) {
    const escaped = listboxId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    options = page.locator(`[id="${escaped}"] [role="option"]`);
  }

  const optionRows = await visibleOptions();
  const targetOption =
    optionRows.find((option) => option.matchesField && matchesChoice(option.text, desiredValue)) ||
    optionRows.find((option) => matchesChoice(option.text, desiredValue)) ||
    (optionRows.length === 1 ? optionRows[0] : null);
  if (targetOption?.id) {
    await page.locator(`[id="${targetOption.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`).click({ force: true }).catch(() => undefined);
  } else if (typeof targetOption?.index === "number") {
    await options.nth(targetOption.index).click({ force: true }).catch(() => undefined);
  } else if (await clickVisibleOption()) {
    // Selected by a Greenhouse React option id after filtering changed the listbox.
  } else {
    await page.keyboard.press("ArrowDown").catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
  }

  await page.waitForTimeout(250);
  const selected = await readSelection();
  return selectionMatches(selected);
}

async function uploadFileIfPresent(page, labelPatterns, filePath) {
  if (!read(filePath)) {
    return false;
  }

  const visibleInputs = page.locator('input[type="file"]');
  const count = await visibleInputs.count().catch(() => 0);
  if (count === 0) {
    return false;
  }

  let fallback = null;
  for (let index = 0; index < count; index += 1) {
    const field = visibleInputs.nth(index);
    if (!(await field.isVisible().catch(() => false))) {
      continue;
    }
    const meta = await readFieldMeta(field);
    if (!meta) {
      continue;
    }
    if (!fallback) {
      fallback = field;
    }
    const normalizedLabel = normalize(`${meta.label} ${meta.name}`);
    if (labelPatterns.some((pattern) => normalizedLabel.includes(normalize(pattern)))) {
      await field.setInputFiles(filePath).catch(() => undefined);
      return true;
    }
  }

  if (fallback) {
    await fallback.setInputFiles(filePath).catch(() => undefined);
    return true;
  }

  return false;
}

async function listUnresolvedRequiredFields(page) {
  const fields = await page.locator("input, textarea, select").evaluateAll((nodes) => {
    const read = (value) => (value ?? "").toString().replace(/\s+/g, " ").trim();
    const results = [];
    for (const node of nodes) {
      const element = node;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const required =
        element.hasAttribute("required") ||
        element.getAttribute("aria-required") === "true";
      if (!required) {
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
      const weakLabel = (value) => /^(select|select\.\.|required|optional)$/i.test(read(value));
      if (!label || weakLabel(label)) {
        const containers = [
          element.closest(".field"),
          element.closest(".application-question"),
          element.closest(".select"),
          element.closest(".select__container"),
          element.closest(".select-shell"),
          element.closest(".input-wrapper"),
          element.closest(".text-input-wrapper"),
          element.closest(".checkbox"),
          element.closest(".checkbox__wrapper"),
          element.closest("[class*='field']"),
          element.closest("[class*='question']"),
          element.parentElement?.parentElement,
          element.parentElement,
        ].filter(Boolean);
        for (const container of containers) {
          const candidates = container.querySelectorAll("label, legend, [class*='label'], [class*='Label']");
          for (const candidate of Array.from(candidates)) {
            const text = read(candidate.textContent);
            if (text && !weakLabel(text)) {
              label = text;
              break;
            }
          }
          if (label && !weakLabel(label)) {
            break;
          }
        }
      }
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute("role") || "";
      const type = tag === "select" ? "select" : (element.getAttribute("type") || tag);
      if (type === "hidden" || element.getAttribute("aria-hidden") === "true") {
        continue;
      }
      const readReactSelectSelection = () => {
        const expand = (container) => [container, container?.parentElement, container?.parentElement?.parentElement];
        const roots = [
          element.closest(".select__container"),
          element.closest(".select-shell"),
          element.closest(".select"),
          element.closest("[class*='select']"),
          element.closest("[class*='Select']"),
          element.closest("[class*='field']"),
          element.closest("[class*='Field']"),
          element.closest("[class*='question']"),
          element.closest("[class*='Question']"),
          element.parentElement?.parentElement,
        ];
        const containers = [...new Set(roots.flatMap(expand).filter(Boolean))];
        for (const container of containers) {
          const singleValue = read(container.querySelector(".select__single-value, [class*='singleValue'], [class*='SingleValue']")?.textContent);
          const multiValues = Array.from(container.querySelectorAll(".select__multi-value__label, .select__multi-value, [class*='multiValue'], [class*='MultiValue']"))
            .map((item) => read(item.textContent))
            .filter(Boolean);
          const value = [singleValue, ...multiValues].filter(Boolean).join(" | ");
          if (value) {
            return value;
          }
        }
        return "";
      };
      let value = "";
      const reactSelectValue = readReactSelectSelection();
      if (reactSelectValue) {
        value = reactSelectValue;
      } else if (tag === "select") {
        value = read(element.selectedOptions?.[0]?.textContent || element.value);
      } else if (role === "combobox") {
        value = "";
      } else if (type === "checkbox" || type === "radio") {
        value = element.checked ? "checked" : "";
      } else {
        value = read(element.value);
      }
      if (!value || /^select( an)? option$/i.test(value)) {
        results.push(label || "Unlabeled field");
      }
    }
    return results;
  }).catch(() => []);

  return dedupe(fields);
}

async function findPrimaryAction(page) {
  const selectors = [
    'button:has-text("Submit Application")',
    'button:has-text("Submit application")',
    'button:has-text("Submit")',
    'input[type="submit"]',
    'button:has-text("Review Application")',
    'button:has-text("Review application")',
    'button:has-text("Review")',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Apply")',
    'button:has-text("Apply now")',
    'a:has-text("Apply")',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      const label =
        read(await locator.textContent().catch(() => "")) ||
        read(await locator.getAttribute("value").catch(() => "")) ||
        read(await locator.getAttribute("aria-label").catch(() => "")) ||
        "Primary action";
      return { locator, label };
    }
  }

  return null;
}

async function hasGreenhouseSecurityCodeChallenge(page) {
  const codeInputs = await page.locator('input[id^="security-input-"]').count().catch(() => 0);
  if (codeInputs > 0) {
    return true;
  }
  const text = normalize(await page.locator("body").innerText({ timeout: 3000 }).catch(() => ""));
  return text.includes("verification code was sent") && text.includes("security code");
}

async function greenhouseConfirmationDetected(page) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const url = page.url().toLowerCase();
    const text = normalize(await page.locator("body").innerText({ timeout: 3000 }).catch(() => ""));
    if (
      url.includes("/confirmation") ||
      /thank you for applying|application has been received|application received|we received your application|application submitted/.test(text)
    ) {
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

async function extractGreenhouseCompany(page) {
  const title = read(await page.title().catch(() => ""));
  const titleMatch = title.match(/\bat\s+(.+?)$/i);
  if (titleMatch) {
    return read(titleMatch[1].replace(/\s*[|-].*$/, ""));
  }
  const text = read(await page.locator("body").innerText({ timeout: 3000 }).catch(() => ""));
  const headingMatch = text.match(/\bThank you for applying to\s+(.+?)!/i);
  if (headingMatch) {
    return read(headingMatch[1]);
  }
  return "";
}

function parseGreenhouseSecurityCode(text, company) {
  const normalizedCompany = normalize(company);
  const candidates = [];
  for (const chunk of read(text).split(/security code for your application to/i).slice(1)) {
    const code =
      chunk.match(/\bapplication:\s*([A-Za-z0-9]{8})\b/i)?.[1] ||
      chunk.match(/\b([A-Za-z0-9]{8})\s+After you enter\b/i)?.[1] ||
      "";
    if (!code) {
      continue;
    }
    const companyLabel = read((chunk.split(/\s+-\s+Hi\b/i)[0] || chunk).slice(0, 100));
    const normalizedLabel = normalize(companyLabel);
    const companyScore =
      normalizedCompany &&
      normalizedLabel &&
      (normalizedLabel.includes(normalizedCompany) || normalizedCompany.includes(normalizedLabel))
        ? 2
        : 1;
    candidates.push({ code, score: companyScore });
  }

  if (candidates.length > 0) {
    candidates.sort((left, right) => right.score - left.score);
    return candidates[0].code;
  }

  return read(text).match(/\bapplication:\s*([A-Za-z0-9]{8})\b/i)?.[1] || "";
}

async function findGreenhouseSecurityCode(context, profile, company) {
  const queries = [
    company
      ? `from:(no-reply@us.greenhouse-mail.io) "Security code for your application to ${company}" newer:1d`
      : "",
    company ? `from:(no-reply@us.greenhouse-mail.io) "${company}" "security code" newer:1d` : "",
    `from:(no-reply@us.greenhouse-mail.io) "Security code for your application" newer:1d`,
    `from:(no-reply@us.greenhouse-mail.io) newer:1d`,
  ].filter(Boolean);

  for (const accountIndex of [1, 0, 2, 3]) {
    for (const query of queries) {
      const gmailPage = await context.newPage();
      try {
        const url = `https://mail.google.com/mail/u/${accountIndex}/#search/${encodeURIComponent(query)}`;
        await gmailPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => undefined);
        await gmailPage.waitForTimeout(6000);
        const title = read(await gmailPage.title().catch(() => ""));
        if (/sign in|accounts\.google|workspace\.google\.com/i.test(`${title} ${gmailPage.url()}`)) {
          continue;
        }
        let text = await gmailPage.locator("body").innerText({ timeout: 15000 }).catch(() => "");
        let code = parseGreenhouseSecurityCode(text, company);
        if (!code) {
          const firstConversation = gmailPage.locator('[role="main"] tr, .Cp .zA').first();
          if (await firstConversation.count().catch(() => 0)) {
            await firstConversation.click({ force: true }).catch(() => undefined);
            await gmailPage.waitForTimeout(3500);
            text = await gmailPage.locator("body").innerText({ timeout: 15000 }).catch(() => "");
            code = parseGreenhouseSecurityCode(text, company);
          }
        }
        if (code) {
          return code;
        }
      } finally {
        await gmailPage.close().catch(() => undefined);
      }
    }
  }

  return "";
}

async function fillGreenhouseSecurityCode(page, code) {
  if (!/^[A-Za-z0-9]{8}$/.test(read(code))) {
    return false;
  }

  const characterInputs = page.locator('input[id^="security-input-"]');
  const count = await characterInputs.count().catch(() => 0);
  if (count >= code.length) {
    for (let index = 0; index < code.length; index += 1) {
      await characterInputs.nth(index).fill(code[index]).catch(() => undefined);
      await page.waitForTimeout(50);
    }
    const value = await characterInputs.evaluateAll((nodes) => nodes.map((node) => node.value || "").join("")).catch(() => "");
    return value === code;
  }

  const singleInput = page
    .locator('input[autocomplete="one-time-code"], input[aria-label*="security" i], input[id*="security" i], input[name*="code" i]')
    .first();
  if (await singleInput.isVisible().catch(() => false)) {
    await singleInput.fill(code).catch(() => undefined);
    const value = await singleInput.inputValue().catch(() => "");
    return value === code;
  }

  return false;
}

async function main() {
  const payload = JSON.parse(process.argv[2] || "{}");
  const repoRoot = payload.repoRoot || process.cwd();
  const url = read(payload.url);
  const profile = payload.profile || {};
  const submit = payload.submit === true;
  const cdpUrl = payload.cdpUrl || "http://127.0.0.1:9222";

  if (!url) {
    throw new Error("A target URL is required.");
  }

  const answers = await loadApplicationAnswers(repoRoot);
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const [context] = browser.contexts();
    if (!context) {
      throw new Error("No browser contexts were found on the attached Chrome session.");
    }

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.bringToFront().catch(() => undefined);
    await page.waitForTimeout(2000);
    await acceptCookieBannerIfPresent(page).catch(() => undefined);
    const initialCaptcha = await detectCaptchaChallenge(page);
    if (initialCaptcha) {
      process.stdout.write(`${JSON.stringify(buildResult([], [], "Manual verification required", {
        stoppedBeforeSubmit: false,
        submitted: false,
        stopReason: initialCaptcha,
      }))}\n`);
      return;
    }

    const filled = [];
    const skipped = [];

    const resumeUploaded = await uploadFileIfPresent(page, ["resume", "resume/cv", "cv"], read(profile.resumeFilePath));
    if (resumeUploaded) {
      filled.push("resume upload");
      await page.waitForTimeout(4000);
    } else if (read(profile.resumeFilePath)) {
      skipped.push("resume upload");
    }

    const coverUploaded = await uploadFileIfPresent(page, ["cover letter", "motivation"], read(profile.coverLetterFilePath));
    if (coverUploaded) {
      filled.push("cover letter upload");
      await page.waitForTimeout(1500);
    }

    await waitForHostedGreenhouseFields(page);

    const first = read(profile.name).split(/\s+/)[0] || "";
    const last = read(profile.name).split(/\s+/).slice(1).join(" ");
    const state = read(profile.state);
    const expandedState = state.toUpperCase() === "NC" ? "North Carolina" : state;
    const location =
      [read(profile.city), expandedState, "United States"].filter(Boolean).join(", ") ||
      [read(profile.city), state].filter(Boolean).join(", ") ||
      read(profile.location);
    const website = lookupApplicationAnswer(answers, "website", "text") || lookupApplicationAnswer(answers, "portfolio", "text");

    const commonSteps = [
      { name: "first name", patterns: ["legal first name", "first name", "given name"], type: "text", value: first },
      { name: "last name", patterns: ["legal last name", "last name", "surname", "family name"], type: "text", value: last },
      { name: "email", patterns: ["email"], type: "text", value: read(profile.email) },
      { name: "country", patterns: ["country"], type: "select", value: "United States" },
      { name: "phone", patterns: ["phone"], type: "text", value: read(profile.phone) },
      { name: "preferred first name", patterns: ["preferred first name"], type: "text", value: first },
      { name: "location", patterns: ["location", "city, state", "where are you currently based", "currently based"], type: "text", value: location },
      { name: "postal code", patterns: ["postal code", "zip code", "zipcode"], type: "text", value: read(profile.postalCode) },
      { name: "linkedin", patterns: ["linkedin profile", "linkedin"], type: "text", value: read(profile.linkedinUrl) },
      { name: "website", patterns: ["website", "portfolio"], type: "text", value: website },
      { name: "how did you hear", patterns: ["how did you hear about this job", "how did you hear about", "where did you hear", "where did you learn"], type: "select", value: "LinkedIn" },
      {
        name: "ai familiarity",
        patterns: ["overall familiarity with artificial intelligence", "familiarity with ai concepts", "rate your overall familiarity"],
        type: "select",
        value: "4 - Very familiar",
      },
      {
        name: "knows current employee",
        patterns: ["know anyone currently at", "know someone currently at", "know anyone working at", "know someone working at"],
        type: "text",
        value: "No",
      },
      {
        name: "east coast location",
        patterns: ["east coast of the united states", "located on the east coast", "east coast"],
        type: "select",
        value: "Yes",
      },
      {
        name: "ai tools usage",
        patterns: ["what ai tools are you currently using", "ai tools are you currently using", "how are you using them"],
        type: "text",
        value:
          "I use ChatGPT, Claude, GitHub Copilot, and local automation tools to speed up software work: drafting and reviewing code, generating test cases, debugging failures, summarizing technical context, and building Playwright/TypeScript workflows. I still verify outputs, run tests, inspect diffs, and make the final engineering decisions myself.",
      },
      {
        name: "ai evaluation consent",
        patterns: ["consenting to the use of ai", "use of ai for evaluating my candidacy", "ai for evaluating my candidacy"],
        type: "select",
        value: "Yes",
      },
      {
        name: "built ai agents",
        patterns: ["built ai agents", "built any ai agents", "have you built ai agents", "agentic automation"],
        type: "select",
        value: "Yes",
      },
      {
        name: "employee referral",
        patterns: ["did an employee refer you", "employee referral", "employee refer", "referred you"],
        type: "select",
        value: "No",
      },
      {
        name: "current company",
        patterns: ["current (or most recent) company", "current company", "most recent company"],
        type: "text",
        value: lookupApplicationAnswer(answers, "current company", "text") || "Hurdle Solutions",
      },
      {
        name: "authorized to work",
        patterns: ["your authorization to work", "work authorization", "legally authorized to work", "authorized to work", "right to work"],
        type: "select",
        value: "I am authorized to work in the country due to my nationality",
      },
      {
        name: "employment sponsorship",
        patterns: ["require immigration sponsorship", "require employment sponsorship", "visa sponsorship", "need sponsorship"],
        type: "select",
        value: "No",
      },
      {
        name: "currently reside in united states",
        patterns: ["currently reside in the united states", "reside in the united states", "currently live in the united states"],
        type: "select",
        value: "Yes",
      },
      {
        name: "excluded states residency",
        patterns: ["one of the following states", "do you live in one of", "alabama alaska delaware"],
        type: "select",
        value: "No",
      },
      {
        name: "privacy acknowledgement",
        patterns: ["job applicant privacy notice", "privacy notice", "applicant privacy statement", "privacy statement", "privacy policy"],
        type: "select",
        value: "Acknowledge/Confirm",
      },
      {
        name: "information accuracy confirmation",
        patterns: ["double-check all the information", "reviewed and confirmed", "accuracy is crucial"],
        type: "select",
        value: "I have reviewed and confirmed that all the information provided is accurate and complete.",
      },
      { name: "gender", patterns: ["gender identity", "gender"], type: "select", value: lookupApplicationAnswer(answers, "gender", "select") || "I don't wish to answer" },
      { name: "transgender experience", patterns: ["person of transgender experience", "transgender experience"], type: "select", value: "No" },
      { name: "sexual orientation", patterns: ["sexual orientation"], type: "select", value: "I don't wish to answer" },
      { name: "transgender", patterns: ["identify as transgender", "transgender"], type: "select", value: "I don't wish to answer" },
      { name: "disability status", patterns: ["disability status", "disability"], type: "select", value: lookupApplicationAnswer(answers, "disability status", "select") || "I don't wish to answer" },
      { name: "military service", patterns: ["served in the military", "military service"], type: "select", value: "No military service" },
      { name: "veteran status", patterns: ["veteran status", "veteran"], type: "select", value: lookupApplicationAnswer(answers, "veteran status", "select") || "No" },
      { name: "ethnicity", patterns: ["select up to 2 ethnicities", "ethnicities"], type: "select", value: "I don't wish to answer" },
      {
        name: "demographic consent",
        patterns: ["by checking this box", "consent to reddit collecting", "demographic data surveys"],
        type: "checkbox",
        value: "Yes",
      },
    ];

    for (const step of commonSteps) {
      if (!read(step.value)) {
        skipped.push(step.name);
        continue;
      }

      if (step.type === "checkbox") {
        const checked = await checkCheckboxByLabelContains(page, step.patterns);
        if (checked) {
          filled.push(step.name);
        } else {
          skipped.push(step.name);
        }
        continue;
      }

      let field = null;
      for (const pattern of step.patterns) {
        field = await findFieldByLabelContains(page, pattern);
        if (field) {
          break;
        }
      }
      if (!field) {
        skipped.push(step.name);
        continue;
      }

      const meta = await readFieldMeta(field);
      if (
        step.name === "employment sponsorship" &&
        meta?.label &&
        /legally authorized|authorized to work|right to work|without (the )?need|without.*sponsorship/.test(normalize(meta.label))
      ) {
        skipped.push(step.name);
        continue;
      }
      if (meta && isMeaningfulValue(meta.currentValue) && (step.type !== "select" || matchesChoice(meta.currentValue, step.value))) {
        filled.push(step.name);
        continue;
      }

      const applied =
        meta?.role === "combobox"
          ? await selectComboboxOption(page, field, step.value)
          : step.type === "select"
            ? await selectBestOption(field, step.value)
            : step.type === "checkbox"
              ? await field.check().then(() => true).catch(() => false)
            : await field.fill(step.value).then(() => true).catch(() => false);

      if (applied) {
        filled.push(step.name);
      } else {
        skipped.push(step.name);
      }
    }

    const allFields = page.locator("input, textarea, select");
    const count = await allFields.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const field = allFields.nth(index);
      if (!(await field.isVisible().catch(() => false))) {
        continue;
      }
      const meta = await readFieldMeta(field);
      if (!meta?.label || isMeaningfulValue(meta.currentValue) || meta.type === "file" || meta.type === "search") {
        continue;
      }

      const answer = inferCommonAnswer(meta.label, meta.type, profile, answers);
      if (!read(answer)) {
        continue;
      }

      const applied =
        meta.role === "combobox"
          ? await selectComboboxOption(page, field, answer)
          : meta.tag === "select" || meta.type === "select"
            ? await selectBestOption(field, answer)
            : meta.type === "checkbox"
              ? await field.check().then(() => true).catch(() => false)
              : await field.fill(answer).then(() => true).catch(() => false);

      if (applied) {
        filled.push(meta.label);
      }
    }

    const primaryAction = await findPrimaryAction(page);
    const nextAction = primaryAction?.label || "No primary action detected";
    if (!submit) {
      process.stdout.write(`${JSON.stringify(buildResult(filled, skipped, nextAction, {
        stoppedBeforeSubmit: true,
        submitted: false,
        stopReason: "Configured to stop before submit.",
      }))}\n`);
      return;
    }

    const captchaChallenge = await detectCaptchaChallenge(page);
    if (captchaChallenge) {
      process.stdout.write(`${JSON.stringify(buildResult(filled, skipped, "Manual verification required", {
        stoppedBeforeSubmit: false,
        submitted: false,
        stopReason: captchaChallenge,
      }))}\n`);
      return;
    }

    const unresolvedRequired = await listUnresolvedRequiredFields(page);
    if (unresolvedRequired.length > 0) {
      process.stdout.write(`${JSON.stringify(buildResult(filled, skipped, nextAction, {
        stoppedBeforeSubmit: false,
        submitted: false,
        stopReason: `Required fields still missing: ${unresolvedRequired.slice(0, 4).join(", ")}`,
      }))}\n`);
      return;
    }

    if (!primaryAction) {
      process.stdout.write(`${JSON.stringify(buildResult(filled, skipped, nextAction, {
        stoppedBeforeSubmit: false,
        submitted: false,
        stopReason: "No primary employer-form action was detected after autofill.",
      }))}\n`);
      return;
    }

    const clicked = await primaryAction.locator.click({ timeout: 10000 }).then(() => true).catch(() => false);
    if (!clicked) {
      process.stdout.write(`${JSON.stringify(buildResult(filled, skipped, nextAction, {
        stoppedBeforeSubmit: false,
        submitted: false,
        stopReason: `Could not click the employer-form action: ${primaryAction.label}`,
      }))}\n`);
      return;
    }

    const submitAction = /submit/i.test(primaryAction.label);
    await page.waitForTimeout(submitAction ? 2500 : 1500);

    if (submitAction && await hasGreenhouseSecurityCodeChallenge(page)) {
      const company = await extractGreenhouseCompany(page);
      const code = await findGreenhouseSecurityCode(context, profile, company);
      if (!code) {
        process.stdout.write(`${JSON.stringify(buildResult(filled, skipped, "Manual verification required", {
          stoppedBeforeSubmit: false,
          submitted: false,
          stopReason: `Greenhouse security code was required${company ? ` for ${company}` : ""}, but no matching Gmail code was found.`,
        }))}\n`);
        return;
      }

      if (!await fillGreenhouseSecurityCode(page, code)) {
        process.stdout.write(`${JSON.stringify(buildResult(filled, skipped, "Manual verification required", {
          stoppedBeforeSubmit: false,
          submitted: false,
          stopReason: "Greenhouse security code was found, but the code fields could not be filled.",
        }))}\n`);
        return;
      }
      filled.push("greenhouse security code");

      const submitAfterCode = await findPrimaryAction(page);
      if (!submitAfterCode || !await submitAfterCode.locator.isEnabled().catch(() => false)) {
        process.stdout.write(`${JSON.stringify(buildResult(filled, skipped, "Manual verification required", {
          stoppedBeforeSubmit: false,
          submitted: false,
          stopReason: "Greenhouse security code was entered, but Submit application was not enabled.",
        }))}\n`);
        return;
      }

      const clickedAfterCode = await submitAfterCode.locator.click({ timeout: 10000 }).then(() => true).catch(() => false);
      if (!clickedAfterCode) {
        process.stdout.write(`${JSON.stringify(buildResult(filled, skipped, "Manual verification required", {
          stoppedBeforeSubmit: false,
          submitted: false,
          stopReason: "Greenhouse security code was entered, but the final Submit application click failed.",
        }))}\n`);
        return;
      }
    }

    const confirmed = submitAction ? await greenhouseConfirmationDetected(page) : false;
    process.stdout.write(`${JSON.stringify(buildResult(filled, skipped, primaryAction.label, {
      stoppedBeforeSubmit: false,
      submitted: submitAction && confirmed,
      stopReason: submitAction
        ? confirmed
          ? "Application submitted and confirmation detected."
          : `Final action clicked: ${primaryAction.label}; confirmation was not detected.`
        : "Advanced to the next hosted-Greenhouse step.",
    }))}\n`);
  } finally {
    // The worker attaches to an already-running debug Chrome. Let process exit
    // close the CDP socket without sending a browser shutdown command.
  }
}

main().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
