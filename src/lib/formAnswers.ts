import type { Profile } from "./types.js";

export type FormQuestion = {
  label: string;
  type: string;
  required: boolean;
  choices: string[];
};

export type SuggestedFormAnswer = {
  value: string;
  source: "application-answers" | "question-bank" | "profile-heuristic";
  reason: string;
};

function lower(value: string): string {
  return value.toLowerCase();
}

function normalize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstName(profile: Profile): string {
  return profile.name.trim().split(/\s+/)[0] || "";
}

function lastName(profile: Profile): string {
  return profile.name.trim().split(/\s+/).slice(1).join(" ");
}

function inferCountry(profile: Profile): string {
  const location = profile.location.trim();
  if (!location) {
    return "";
  }

  const normalizedLocation = normalize(location);
  if (/\bunited states\b|\busa\b|\bu s a\b|\bus\b/.test(normalizedLocation)) {
    return "United States";
  }

  const segments = location
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);

  return segments.at(-1) ?? "";
}

function inferPostalCode(profile: Profile): string {
  if (profile.postalCode.trim()) {
    return profile.postalCode.trim();
  }

  const candidates = [profile.location, profile.city, profile.state];
  for (const candidate of candidates) {
    const match = candidate.match(/\b\d{5}(?:-\d{4})?\b/);
    if (match) {
      return match[0];
    }
  }

  return "";
}

function inferStateOrProvince(profile: Profile): string {
  const value = profile.state.trim();
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

  return states[value.toUpperCase()] || value;
}

function inferStreetAddress(profile: Profile): string {
  return profile.streetAddress.trim();
}

function inferAddressLine2(profile: Profile): string {
  return profile.addressLine2.trim();
}

function inferProfileWebsite(profile: Profile): string {
  return profile.linkedinUrl.trim();
}

function isLinkedInLabel(label: string): boolean {
  return /\blinked\s*in\b|\blinkedin\b|\blinkedln\b/.test(label);
}

function inferProfileTimeZone(profile: Profile): string {
  const normalized = normalize([profile.location, profile.state, profile.city].join(" "));
  if (
    /\b(north carolina|nc|new york|ny|new jersey|nj|florida|fl|georgia|ga|virginia|va|maryland|md|massachusetts|ma|pennsylvania|pa|ohio|oh|michigan|mi|eastern)\b/.test(
      normalized,
    )
  ) {
    return "Eastern Time";
  }
  if (/\b(illinois|il|texas|tx|tennessee|tn|central)\b/.test(normalized)) {
    return "Central Time";
  }
  if (/\b(colorado|co|utah|ut|arizona|az|mountain)\b/.test(normalized)) {
    return "Mountain Time";
  }
  if (/\b(california|ca|washington|wa|oregon|or|pacific)\b/.test(normalized)) {
    return "Pacific Time";
  }

  return "";
}

function buildPhysicalLocationAnswer(profile: Profile): string {
  const location = profile.location.trim() || [profile.city, profile.state, inferCountry(profile)]
    .filter(Boolean)
    .join(", ");
  const timezone = inferProfileTimeZone(profile);
  return [location, timezone].filter(Boolean).join("; ");
}

function inferAuthorizationSignals(profile: Profile): {
  authorized: string | null;
  sponsorship: string | null;
} {
  const text = normalize(profile.workAuthorization);
  if (!text) {
    return { authorized: null, sponsorship: null };
  }

  const authorized =
    /citizen|green card|permanent resident|authorized|can work|does not require sponsorship|no sponsorship/.test(
      text,
    )
      ? "Yes"
      : /not authorized|unable to work/.test(text)
        ? "No"
        : null;

  const sponsorship =
    /require sponsorship|need sponsorship|h1b|h 1 b|opt|cpt|visa sponsorship/.test(text)
      ? "Yes"
      : /citizen|green card|permanent resident|does not require sponsorship|no sponsorship|authorized/.test(
            text,
          )
        ? "No"
        : null;

  return { authorized, sponsorship };
}

function profileHasAiOrLlmSignal(profile: Profile): boolean {
  const text = normalize([profile.resumeSummary, profile.skills.join(" "), profile.targetRoles.join(" ")].join(" "));
  return /\b(ai|artificial intelligence|machine learning|ml|llm|large language model|openai|generative ai|langchain)\b/.test(
    text,
  );
}

function buildRemoteExperienceAnswer(): string {
  return "I have worked remotely for years while building production web applications, backend APIs, data workflows, and cloud deployments. I am comfortable with async communication, written updates, code review, ticket-driven planning, and owning work end-to-end without needing heavy supervision.";
}

function buildProudProjectAnswer(): string {
  return "I built a local job application assistant that captures job postings, evaluates fit, and automates application workflows across LinkedIn, Greenhouse, Lever, Ashby, Taleo, and Workday-style forms. It uses TypeScript, Playwright, structured profile data, and targeted heuristics to fill forms, handle edge cases, and keep a local application record. The part I am proudest of is making the system practical: it can inspect a page, adapt to employer-specific fields, solve structured verification tasks, and preserve a clear audit trail instead of relying on brittle one-off scripts.";
}

function buildOutsideWorkAccomplishmentAnswer(): string {
  return "I built a local job application assistant outside of work that captures job postings, evaluates fit, and automates application workflows across several applicant tracking systems. I am proud of it because it combines TypeScript, Playwright, structured data, and practical product thinking into a tool that solves a real problem end to end.";
}

function buildAdditionalInformationAnswer(profile: Profile): string {
  return tidyAnswer(
    `I bring ${profile.yearsOfExperience || "several"} years of full-stack and backend experience across TypeScript, React, Node.js, Python, APIs, automation, cloud deployments, and data-heavy workflows. I am most effective in roles where I can own production features end-to-end and improve the systems around them.`,
  );
}

function buildShortCompanyInterestAnswer(profile: Profile): string {
  return tidyAnswer(
    `This role aligns well with my ${profile.yearsOfExperience || "several"} years of full-stack and backend experience building production web applications, APIs, data models, and operational tooling. I am interested in work where I can own features end-to-end, collaborate closely with product users, and make complex workflows simpler and more reliable.`,
  );
}

function buildAiPromptExperienceAnswer(): string {
  return "Yes. I use AI coding assistants in software development and built a local job application assistant that uses structured prompts and instructions to inspect forms, extract requirements, and automate truthful application workflows across ATS sites.";
}

function buildTrustworthyAiInteractionAnswer(): string {
  return "It feels trustworthy when the system is clear about what it knows, preserves context, asks for clarification when requirements are ambiguous, explains important actions, and gives the user control over irreversible steps. Natural interactions also need concise language, reliable follow-through, and graceful recovery when a tool or assumption fails.";
}

function buildAiBreakdownAnswer(): string {
  return "They usually break down when context is missing, instructions conflict, state changes across a long workflow, or the model overgeneralizes instead of checking the actual source of truth. In real conversations, failures often come from not verifying tool results, mishandling edge cases, or presenting uncertainty too confidently.";
}

function buildToolStackAnswer(): string {
  return "TypeScript, React, Next.js, Node.js, Python, FastAPI/Express, PostgreSQL, Redis, Tailwind CSS, Playwright, GitHub Actions, Docker, AWS/GCP/Azure, Terraform, and observability tools.";
}

function buildFrontendMockToUiAnswer(): string {
  return "I have built polished React/Next.js/Tailwind-style interfaces, but I have not shipped a Framer Motion-heavy production feature. A recent comparable project was a local job application assistant and dashboard: I started from rough workflow notes, mapped the states users needed while applying, and built production UI around job lists, status changes, form automation, and browser review. The hardest parts were keeping the workflow fast without hiding important failures, preventing layout shifts as live data changed, and making browser-driven actions observable. I solved those by giving fixed-format controls stable dimensions, keeping status transitions explicit, testing the flow with Playwright, and surfacing the exact field or page state that needed action.";
}

function buildFrontendPerformanceAnswer(): string {
  return "On data-heavy React views, I improved perceived and actual responsiveness by reducing unnecessary rerenders, debouncing expensive filtering/search work, lazy-loading heavier panels, and keeping table/list dimensions stable while async data arrived. I measured with browser Performance traces, Lighthouse checks where appropriate, and application-level timing around the slow interactions. The user impact was less waiting after input, fewer layout jumps, and screens that stayed interactive while network or automation work continued in the background.";
}

function buildProductionApiSystemAnswer(): string {
  return "At Hurdle Solutions, I built client-facing workflow and reporting APIs that integrated authentication, PostgreSQL data models, cloud deployments, and React interfaces. The system automated operational reporting for stakeholders, reduced manual spreadsheet work, and was maintained after release.";
}

function buildLiveEnvironmentSystemAnswer(): string {
  return "Yes. I built and maintained production websites, APIs, data workflows, and admin tools used by client stakeholders. Work included authentication, reporting pipelines, search/data integrations, CI/CD, cloud deployments, monitoring, and production issue response.";
}

function buildAppliedLlmWorkflowAnswer(): string {
  return "I have applied LLM workflows mainly through prototypes and internal tooling, including a local job-application assistant built with TypeScript, Playwright, structured prompts, and heuristics to inspect forms and automate workflows. I have not owned a production customer-facing LLM platform at scale.";
}

function buildRapidPocAnswer(): string {
  return "I shipped a rapid proof of concept for a browser-assisted job application workflow using Playwright, TypeScript, and a local dashboard. The first version proved that the tool could inspect job pages, fill structured fields, upload a resume, and stop only for decisions that required judgment. It started as an experiment, then became a production-quality local tool after I added profile-backed answers, site-specific handlers, better retry behavior, and logging so repeated form failures could be converted into code fixes instead of manual review.";
}

function buildNextTailwindPitfallsAnswer(): string {
  return "Common issues I watch for in Next.js and Tailwind projects are hydration mismatches from browser-only state, layout shift from dynamic data or images, large client bundles, Tailwind class churn that makes variants hard to reason about, and animation or transition work that competes with rendering. I identify these with console hydration warnings, React profiling, browser Performance traces, layout-shift checks, and direct testing on smaller viewports. I mitigate them with clear server/client boundaries, dynamic imports for browser-only code, stable dimensions for fixed-format UI, reduced-motion support, measured animation scope, and component APIs that keep style variants consistent.";
}

function tidyAnswer(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isNonDisclosureValue(value: string): boolean {
  const normalized = normalize(value);
  return /prefer not|decline|self identify|wish to answer|rather not|no answer|not say/.test(
    normalized,
  );
}

function wantsNumericAnswer(question: FormQuestion): boolean {
  const label = normalize(question.label);
  const type = normalize(question.type);
  return type.includes("number") || /\bnumeric\b/.test(label);
}

function normalizeNumericAnswer(value: string): string {
  const raw = value.trim();
  if (!raw) {
    return "";
  }

  const rangeMatch = raw.match(
    /\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m)?\s*(?:-|to|–|—)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m)?/i,
  );
  if (rangeMatch) {
    return scaleNumericAnswer(rangeMatch[3], rangeMatch[4]);
  }

  const singleMatch = raw.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m)?\b/i);
  if (!singleMatch) {
    return "";
  }

  return scaleNumericAnswer(singleMatch[1], singleMatch[2]);
}

function scaleNumericAnswer(raw: string, suffix: string | undefined): string {
  const value = Number.parseFloat(raw.replace(/,/g, ""));
  if (!Number.isFinite(value)) {
    return "";
  }

  const unit = (suffix || "").toLowerCase();
  const scaled = unit === "m" ? value * 1_000_000 : unit === "k" ? value * 1_000 : value;
  return String(Math.round(scaled));
}

function matchChoice(choices: string[], desiredValue: string): string | null {
  const normalizedDesired = normalize(desiredValue);
  if (!normalizedDesired) {
    return null;
  }

  const exact = choices.find((choice) => normalize(choice) === normalizedDesired);
  if (exact) {
    return exact;
  }

  const directGenderSynonym =
    normalizedDesired === "male"
      ? choices.find((choice) => normalize(choice) === "man")
      : normalizedDesired === "man"
        ? choices.find((choice) => normalize(choice) === "male")
        : normalizedDesired === "female"
          ? choices.find((choice) => normalize(choice) === "woman")
          : normalizedDesired === "woman"
            ? choices.find((choice) => normalize(choice) === "female")
            : null;
  if (directGenderSynonym) {
    return directGenderSynonym;
  }

  const contains = choices.find((choice) => {
    const normalizedChoice = normalize(choice);
    return (
      normalizedChoice.includes(normalizedDesired) || normalizedDesired.includes(normalizedChoice)
    );
  });
  if (contains) {
    return contains;
  }

  const synonymMatches: Record<string, RegExp[]> = {
    male: [/\bman\b/i],
    man: [/\bmale\b/i],
    female: [/\bwoman\b/i],
    woman: [/\bfemale\b/i],
    "i am not a protected veteran": [/no military service/i, /not.*protected veteran/i, /not.*veteran/i],
    "i am not a u s military protected veteran": [/no military service/i, /not.*protected veteran/i, /not.*veteran/i],
    "n a": [/^n\/?a$/i, /not applicable/i],
    na: [/^n\/?a$/i, /not applicable/i],
    "decline to self identify": [/prefer not/i, /don t wish to answer/i, /not wish to answer/i],
    "not applicable": [/^n\/?a$/i],
  };
  for (const pattern of synonymMatches[normalizedDesired] ?? []) {
    const synonym = choices.find((choice) => pattern.test(choice));
    if (synonym) {
      return synonym;
    }
  }

  if (isNonDisclosureValue(desiredValue)) {
    return (
      choices.find((choice) =>
        /prefer not|decline|self identify|wish to answer|rather not|no answer|not say/i.test(
          choice,
        ),
      ) ?? null
    );
  }

  const desiredYes = new Set(["yes", "true", "y"]);
  const desiredNo = new Set(["no", "false", "n"]);
  if (desiredYes.has(normalizedDesired)) {
    return (
      choices.find((choice) => /\byes\b|\btrue\b|\bagree\b|\bi do\b/i.test(choice)) ?? null
    );
  }

  if (desiredNo.has(normalizedDesired)) {
    return (
      choices.find(
        (choice) =>
          /\bno\b|\bnot\b|\bfalse\b|\bdecline\b|\bprefer not\b|\bdo not\b|\bdon t\b|\bi am not\b|\bnot a protected veteran\b/i.test(
            choice,
          ),
      ) ?? null
    );
  }

  return null;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function chooseEmailValue(question: FormQuestion, profile: Profile): string {
  const profileEmail = profile.email.trim();
  const choices = question.choices.map((choice) => choice.trim()).filter(Boolean);
  if (choices.length === 0) {
    return profileEmail;
  }

  const exact = choices.find((choice) => normalizeEmail(choice) === normalizeEmail(profileEmail));
  if (exact) {
    return exact;
  }

  return (
    choices.find((choice) => /@gmail\.com\b/i.test(choice) && !/jabbourchad/i.test(choice)) ||
    choices.find((choice) => !/jabbourchad/i.test(choice)) ||
    choices[0] ||
    profileEmail
  );
}

function chooseValue(question: FormQuestion, desiredValue: string): string | null {
  if (!desiredValue.trim()) {
    return null;
  }

  if (wantsNumericAnswer(question)) {
    const numericValue = normalizeNumericAnswer(desiredValue);
    if (numericValue) {
      return numericValue;
    }
  }

  if (question.choices.length === 0) {
    return desiredValue;
  }

  return matchChoice(question.choices, desiredValue);
}

function answerFromProfile(question: FormQuestion, profile: Profile): SuggestedFormAnswer | null {
  const label = normalize(question.label);
  const fieldType = normalize(question.type);
  const auth = inferAuthorizationSignals(profile);

  const directValue =
    label.includes("first name")
      ? firstName(profile)
      : label.includes("last name") || label.includes("surname") || label.includes("family name")
        ? lastName(profile)
        : label.includes("full name") || (label === "name" && profile.name.trim())
          ? profile.name
        : label.includes("middle name")
          ? "N/A"
        : label.includes("recruiting sms") ||
            label.includes("sms messages") ||
            label.includes("text messages") ||
            label.includes("text message")
          ? "No"
        : label.includes("future job opportunities") ||
            label.includes("recruitment activities") ||
            label.includes("business developments and events")
          ? "No"
        : label.includes("which location are you applying for")
          ? "US - Remote"
        : label.includes("from where do you intend to work")
          ? "Raleigh, North Carolina, United States"
        : label.includes("currently based in austin")
          ? "No"
        : label.includes("pronouns")
          ? "Prefer not to disclose"
        : label.includes("reviewed") && label.includes("acknowledge") && label.includes("compensation range")
          ? "Yes"
        : label.includes("collecting and processing your personal information") ||
            (label.includes("processing") && label.includes("application") && label.includes("employment"))
          ? "Yes"
        : label.includes("email")
          ? chooseEmailValue(question, profile)
        : label.includes("phone") ||
            label.includes("mobile number") ||
            label.includes("contact number") ||
            label.includes("primary contact")
            ? profile.phone
              : label.includes("country code") &&
                  (label.includes("phone") || label.includes("cellphone") || label.includes("mobile"))
                ? "United States (+1)"
              : label.includes("how did you hear") ||
                  label.includes("how did you hear about") ||
                  label.includes("where did you hear")
                ? "LinkedIn"
              : label.includes("country") && !label.includes("country code")
                ? inferCountry(profile)
        : isLinkedInLabel(label)
                ? profile.linkedinUrl
                : label.includes("production system") && label.includes("apis")
                  ? buildProductionApiSystemAnswer()
                : label.includes("systems that interact with live environments") ||
                    (label.includes("live environments") &&
                      (label.includes("websites") || label.includes("cms") || label.includes("data pipelines")))
                  ? buildLiveEnvironmentSystemAnswer()
                : label.includes("applying ai") && label.includes("llm") && label.includes("workflows")
                  ? buildAppliedLlmWorkflowAnswer()
                : label.includes("website") ||
                    label.includes("portfolio") ||
                    label.includes("github") ||
                    label.includes("social media") ||
                    label.includes("social presence") ||
                    label.includes("blog") ||
                    label.includes("publication")
                  ? inferProfileWebsite(profile)
                  : label.includes("city")
                    ? profile.city || profile.location
                  : label.includes("postal code") || label.includes("zip code") || label === "zip"
                    ? inferPostalCode(profile)
                  : label.includes("place of residence") && label.includes("region")
                    ? profile.city || profile.location
                  : label.includes("state") || label.includes("province") || label.includes("region")
                    ? inferStateOrProvince(profile)
                    : label.includes("address line 2") || label.includes("address 2")
                      ? inferAddressLine2(profile)
                    : label.includes("street address") ||
                        label.includes("address line 1") ||
                        label === "address" ||
                        label === "street"
                      ? inferStreetAddress(profile)
                    : label.includes("place of residence") || label.includes("country of residence")
                      ? inferCountry(profile)
                    : label.includes("currently reside") && /united states|usa|u s a|us/.test(label)
                      ? "Yes"
                    : label.includes("currently located") && label.includes("country")
                      ? "Yes"
                    : label.includes("bay area") && label.includes("relocat")
                      ? "No"
                    : label.includes("where are you located")
                      ? profile.location
                    : label.includes("physically located") || (label.includes("located") && label.includes("time zone"))
                      ? buildPhysicalLocationAnswer(profile)
                    : label.includes("location")
                      ? profile.location
                      : label.includes("address")
                        ? inferStreetAddress(profile)
                        : label.includes("visa sponsorship") ||
                            label.includes("require sponsorship") ||
                            label.includes("need sponsorship") ||
                            label.includes("immigration support") ||
                            label.includes("immigration sponsorship") ||
                            (label.includes("sponsorship") && label.includes("work authorization"))
                          ? auth.sponsorship || "No"
                        : label.includes("work authorization")
                        ? profile.workAuthorization || auth.authorized || ""
                        : label.includes("legally work") || label.includes("legal work")
                          ? profile.workAuthorization
                            ? `Yes. I am a ${profile.workAuthorization} and do not require visa sponsorship.`
                            : auth.authorized || ""
                        : label.includes("currently eligible to work") || label.includes("eligible to work")
                          ? "Yes"
                        : label.includes("open for w2") || label.includes("open to w2")
                          ? "Yes"
                        : label.includes("authorized to work") || label.includes("right to work")
                          ? auth.authorized || profile.workAuthorization
                            : label.includes("employee refer") ||
                                label.includes("employee referral") ||
                                label.includes("referred by an employee") ||
                                label.includes("referred you") ||
                                label.includes("employees inform you")
                              ? "No"
                            : label.includes("felony") ||
                                label.includes("breach of trust") ||
                                label.includes("dishonesty") ||
                                label.includes("convicted")
                              ? "No"
                            : label.includes("non compete") ||
                                label.includes("non solicitation") ||
                                label.includes("non disclosure") ||
                                label.includes("confidentiality") ||
                                label.includes("restrict your ability")
                              ? "No"
                            : (label.includes("employee name") && label.includes("position id")) ||
                                label.includes("employee name or position id")
                              ? "Position ID"
                            : label.includes("served in the military") || label.includes("military service")
                              ? "No military service"
                            : label.includes("veteran")
                              ? "I am not a protected Veteran"
                            : label.includes("f 1 visa status") || label.includes("f1 visa status")
                              ? "No"
                            : label.includes("enter n a") ||
                                label.includes("enter na") ||
                                label.includes("if not applicable") ||
                                label.includes("employee name") ||
                                label.includes("position id")
                              ? "N/A"
                            : label.includes("gender identity")
                              ? "Prefer not to disclose"
                            : label.includes("race identity")
                              ? "I do not wish to provide this information"
                            : label.includes("hispanic or latino")
                              ? "No"
                            : label.includes("transgender")
                              ? "No"
                            : label.includes("sexual orientation")
                              ? "I do not wish to provide this information"
                            : label.includes("ethnicit") || (label.includes("race") && label.includes("identify"))
                              ? "I do not wish to provide this information"
                            : label.includes("disability")
                              ? "No"
                            : label.includes("veteran") || label.includes("served in the military")
                              ? "No"
                            : label.includes("family") ||
                                label.includes("relative") ||
                                label.includes("related to anyone") ||
                                label.includes("currently working at")
                              ? "No"
                              : label.includes("temporary") ||
                                  label.includes("consultant") ||
                                  label.includes("contingent worker")
                                ? "No"
                              : label.includes("cpf") || label.includes("mf number")
                                ? "No"
                                : label.includes("clt")
                                  ? /united states|usa|u s a|us/.test(normalize(profile.location))
                                    ? "No"
                                    : "Yes"
                                  : label.includes("english") &&
                                      (label.includes("comfortable") ||
                                        (label.includes("writing") && label.includes("speaking")))
                                    ? "I'm very comfortable with writing and speaking in English."
                                  : label.includes("english") && label.includes("proficien")
                                    ? "Proficient"
                                    : label.includes("political products") ||
                                        label.includes("political campaign") ||
                                        label.includes("campaign software")
                                      ? "No"
                                      : label.includes("llm") ||
                                          label.includes("large language model") ||
                                          (label.includes("ai system") && label.includes("automation"))
                                        ? profileHasAiOrLlmSignal(profile)
                                          ? "Yes"
                                          : "No"
                                      : label.includes("written prompts or instructions") && label.includes("ai system")
                                        ? buildAiPromptExperienceAnswer()
                                      : label.includes("ai interaction") &&
                                          label.includes("natural") &&
                                          label.includes("trustworthy")
                                        ? buildTrustworthyAiInteractionAnswer()
                                      : label.includes("ai systems") && label.includes("break down")
                                        ? buildAiBreakdownAnswer()
                                      : label.includes("owned backend systems") ||
                                          label.includes("owning backend systems") ||
                                          label.includes("backend systems or services end to end")
                                        ? "Yes - multiple systems"
                                      : label.includes("hands on software development")
                                        ? Number(profile.yearsOfExperience || "0") >= 10
                                          ? "10 or more years"
                                          : Number(profile.yearsOfExperience || "0") >= 7
                                            ? "7 or more years but less than 10 years"
                                            : Number(profile.yearsOfExperience || "0") >= 5
                                              ? "5 or more years but less than 7 years"
                                              : Number(profile.yearsOfExperience || "0") >= 3
                                                ? "3 or more years but less than 5 years"
                                                : Number(profile.yearsOfExperience || "0") >= 1
                                                  ? "1 or more years but less than 3 years"
                                                  : "Less than 1 year"
                                      : label.includes("oracle databases") && label.includes("pl sql")
                                        ? "No experience"
                                      : label.includes("python") && label.includes("pandas") && label.includes("spark")
                                        ? "2 or more years but less than 4 years"
                                      : label.includes("cloud platforms")
                                        ? "Yes"
                                      : label.includes("bigdata tools") ||
                                          (label.includes("databricks") && label.includes("spark") && label.includes("cassandra"))
                                        ? "No"
                                      : label.includes("professional backend software development experience")
                                        ? "7-9 years"
                                      : label.includes("primary backend language") ||
                                          (label.includes("backend language") && label.includes("production"))
                                        ? "Python"
                                      : label.includes("designed and built apis") ||
                                          label.includes("built apis") ||
                                          label.includes("backend services consumed by other teams") ||
                                          label.includes("external customers")
                                        ? "Yes - multiple production APIs/services"
                                      : (label.includes("reliable") &&
                                          label.includes("performant") &&
                                          label.includes("secure") &&
                                          label.includes("production")) ||
                                          label.includes("reliability performance and security")
                                        ? "I've owned reliability, performance, and security concerns in production"
                                      : label.includes("react native")
                                        ? "Less than 2 years"
                                      : label.includes("node js") && label.includes("production")
                                        ? profile.yearsOfExperience
                                      : label.includes("aws") && label.includes("infrastructure as code")
                                        ? "Hands-on contributor to infrastructure changes and CI/CD pipelines"
                                      : label.includes("experience using") &&
                                          question.choices.some((choice) => /current user|former user|no/i.test(choice))
                                        ? "No"
                                      : label.includes("credentialed with rula")
                                        ? "No"
                                      : label.includes("engineering specialization")
                                        ? "Full-stack and backend platform engineering"
                                      : label.includes("ai native development tools") ||
                                          (label.includes("llm based cli agents") && label.includes("engineering workflow"))
                                        ? "4 - Advanced"
                                      : label.includes("experience with ai systems in production")
                                        ? "Experimented / built prototypes (POCs, side projects)"
                                      : label.includes("rag or llm based systems")
                                        ? "Built a basic version (e.g., simple retrieval + LLM)"
                                      : label.includes("snack fuels your best ideas")
                                        ? "Coffee and dark chocolate"
                                      : label.includes("go to stack") ||
                                          (label.includes("stack") &&
                                            label.includes("tools") &&
                                            label.includes("getting things done"))
                                        ? buildToolStackAnswer()
                                      : label.includes("rough mock") &&
                                          label.includes("production ui") &&
                                          (label.includes("next js") || label.includes("tailwind"))
                                        ? buildFrontendMockToUiAnswer()
                                      : label.includes("improved") &&
                                          label.includes("performance") &&
                                          (label.includes("frontend") || label.includes("interactivity"))
                                        ? buildFrontendPerformanceAnswer()
                                      : (label.includes("proof of concept") || label.includes("experiment")) &&
                                          label.includes("shipped rapidly")
                                        ? buildRapidPocAnswer()
                                      : label.includes("common pitfalls") &&
                                          (label.includes("next js") ||
                                            label.includes("tailwind") ||
                                            label.includes("framer motion"))
                                        ? buildNextTailwindPitfallsAnswer()
              : label.includes("project based delivery model") ||
                  (label.includes("client needs") && label.includes("project availability")) ||
                  label.includes("comfortable proceeding")
                ? "Yes"
              : label.includes("available to work in est") ||
                  label.includes("available to work in pst") ||
                  label.includes("est or pst")
                ? "Yes"
              : label.includes("ever worked at") ||
                                  label.includes("previously worked at") ||
                                  label.includes("worked for") ||
                                  label.includes("previous roles") ||
                                  label.includes("employee or contractor")
                                ? label.includes("provide details") || label.includes("duration of your employment")
                                  ? "N/A"
                                  : "No"
                                : label.includes("first bullet point") && label.includes("about you")
                                ? "Systems-oriented mindset"
                              : label.includes("completed") &&
                                  (label.includes("assessment") ||
                                    label.includes("video assessment") ||
                                    label.includes("take home") ||
                                    label.includes("take-home") ||
                                    label.includes("exercise"))
                                ? "No"
                              : label.includes("years of experience") ||
                                  label.includes("how many years")
                              ? profile.yearsOfExperience
                              : label.includes("highest level education achieved")
                                ? "Bachelor's Degree"
                                : label.includes("first and last initial") && label.includes("zip")
                                  ? `${firstName(profile).charAt(0)}${lastName(profile).charAt(0)}${inferPostalCode(profile)}`.toUpperCase()
                              : /\bnumeric\b/.test(label) &&
                                  (label.includes("easy apply form element") ||
                                    label.includes("single line text form component"))
                                ? "175000"
                              : label.includes("expected monthly salary")
                                ? "12500"
                              : label.includes("salary expectation") ||
                                  label.includes("salary requirement") ||
                                  label.includes("compensation expectation") ||
                                  label.includes("desired salary")
                                ? "$150K - $175K"
                              : label.includes("notice period") || label.includes("when can you start")
                                ? "Two weeks after offer acceptance."
                              : label.includes("where did you find out") ||
                                  label.includes("where did you hear") ||
                                  label.includes("where did you learn")
                                ? "LinkedIn"
                              : label.includes("complex full stack project") ||
                                  label.includes("full stack project") ||
                                  label.includes("challenging project") ||
                                  label.includes("project you re proud") ||
                                  label.includes("project you're proud") ||
                                  label.includes("piece of work you are most proud") ||
                                  label.includes("exceptional work")
                                ? buildProudProjectAnswer()
                              : label.includes("what makes you a strong candidate") ||
                                  label.includes("what makes you a great candidate") ||
                                  label.includes("tell us more about you")
                                ? profile.resumeSummary
                              : label.includes("most important to you in your next role")
                                ? "I am looking for a remote engineering role with clear ownership, strong technical standards, practical product impact, and room to ship reliable systems end to end."
                              : label.includes("summary") ||
                                  label.includes("what interests you") ||
                                  label.includes("why you are interested") ||
                                  label.includes("why interested") ||
                                  label.includes("interested in this position") ||
                                  label.includes("why this company") ||
                                  /^why [a-z0-9][a-z0-9 ]{1,40}$/.test(label) ||
                                  label.includes("why do you want") ||
                                  label.includes("cover letter") ||
                                  label.includes("about you") ||
                                  label.includes("additional information") ||
                                  label.includes("why are you")
                                ? /^why [a-z0-9][a-z0-9 ]{1,40}$/.test(label)
                                  ? buildShortCompanyInterestAnswer(profile)
                                  : profile.resumeSummary
                                : label.includes("anything else") || label.includes("anything else you d like to share")
                                  ? buildAdditionalInformationAnswer(profile)
                                : (label.includes("remote") && label.includes("experience")) ||
                                    (label.includes("working remotely") && label.includes("describe"))
                                  ? buildRemoteExperienceAnswer()
                                  : label.includes("type alan") ||
                                      (label.includes("human") && label.includes("alan turing"))
                                    ? "ALAN"
                                    : (label.includes("meaningful accomplishment") && label.includes("outside of work")) ||
                                        (label.includes("outside of work") && label.includes("proud"))
                                      ? buildOutsideWorkAccomplishmentAnswer()
                                : label.includes("something you built") ||
                                    (label.includes("built") && label.includes("proud"))
                                  ? buildProudProjectAnswer()
                                : label.includes("software products") || label.includes("tools you are proficient")
                                  ? "JavaScript, TypeScript, React, Next.js, Node.js, Express.js, Python, Java, REST APIs, GraphQL, PostgreSQL, MySQL, MongoDB, Redis, AWS, GCP, Azure, Docker, Kubernetes, Jenkins, GitLab CI/CD, Terraform, Git, Playwright, Selenium, pytest, Elasticsearch"
                                : label.includes("server side programming languages") ||
                                    label.includes("backend programming languages") ||
                                    label.includes("programming languages are you most proficient")
                                  ? "Python, JavaScript, TypeScript, Node.js, Java, and SQL"
                                : (label.includes("in person") || label.includes("in-person")) &&
                                    (label.includes("los angeles") || label.includes("la")) &&
                                    (label.includes("full time") || label.includes("full-time") || label.includes("available"))
                                  ? "No"
                                : label.includes("background or future goals align with fuser")
                                  ? "My background is strongest where product workflows, full-stack implementation, and automation meet. I have built React and TypeScript interfaces, backend APIs, and browser automation tooling that turns messy workflows into reliable software. Fuser's product direction aligns with the kind of work I like most: helping people move from an idea to a working product faster while keeping the engineering practical, observable, and maintainable."
                                : label.includes("dream project") && label.includes("fuser")
                                  ? "I would build a workflow that lets a non-technical founder turn a rough product brief into a usable internal tool: authenticated pages, a data model, API integrations, deployment, and a review loop that shows exactly what changed. The goal would be to make the generated result useful enough for a real pilot while keeping engineers in control of quality, security, and maintainability."
                                : label.includes("three emojis") && label.includes("describe you")
                                  ? "Builder, debugger, teammate"
                                : label.includes("open to relocation") || label.includes("relocat")
                                  ? "No"
                                : label.includes("remote") ||
                                    label.includes("hybrid") ||
                                    label.includes("on site") ||
                                    label.includes("onsite") ||
                                    label.includes("commute") ||
                                    label.includes("travel")
                                    ? "Yes"
                                      : label.includes("background check") ||
                                          label.includes("reference check") ||
                                          label.includes("assessment")
                                        ? "Yes"
                                      : label.includes("managed projects involving cognizant") ||
                                          label.includes("interacted directly with cognizant") ||
                                          label.includes("government agency") ||
                                          label.includes("government department") ||
                                          label.includes("post government employment") ||
                                          label.includes("conceivable intersection") ||
                                          label.includes("future job opportunities") ||
                                          label.includes("recruitment activities") ||
                                          label.includes("business developments and events")
                                        ? "No"
                                      : label.includes("previously employed") ||
                                          label.includes("previously been employed") ||
                                          label.includes("previous employment") ||
                                          label.includes("ever been employed") ||
                                          label.includes("former employee") ||
                                          label.includes("north korea") ||
                                        label.includes("data retention")
                                      ? "No"
                                      : label.includes("privacy policy") ||
                                          label.includes("terms and agreements") ||
                                          label.includes("accept terms") ||
                                          label.includes("applicant privacy") ||
                                          label.includes("privacy notice") ||
                                          label.includes("terms and conditions") ||
                                          label.includes("terms of use") ||
                                          label.startsWith("i have read") ||
                                          label.includes("i acknowledge") ||
                                          label.includes("i certify") ||
                                          label.includes("sign electronically") ||
                                          label.includes("self attestation")
                                        ? "Yes"
                                      : fieldType.includes("checkbox") &&
                                          (label.includes("i understand") ||
                                            label.includes("i acknowledge") ||
                                            label.includes("acknowledge")) &&
                                          (label.includes("receive text") ||
                                            label.includes("text sms") ||
                                            label.includes("text message") ||
                                            label.includes("text communications") ||
                                            label.includes("sms communication"))
                                        ? "Yes"
                                      : (label.includes("agreement") &&
                                          label.includes("receive text") &&
                                          label.includes("message")) ||
                                          (label.includes("consent") &&
                                            label.includes("receive text") &&
                                            label.includes("message"))
                                        ? "No - I do not consent to receiving text messages"
                                      : label.includes("preferred method of communication")
                                        ? "Email"
                                      : label.includes("receive text messages") ||
                                          label.includes("text notification") ||
                                          label.includes("text sms") ||
                                          label.includes("text communications") ||
                                          label.includes("sms communication")
                                        ? "No"
                                      : label.includes("demographic data") && label.includes("consent")
                                        ? "Yes"
                                      : label.includes("preferred check") || label.includes("preferred name")
                                        ? "No"
                                      : label.includes("over 18") ||
                                          label.includes("above 18") ||
                                          label.includes("age of 18")
                                        ? "Yes"
                                        : "";

  if (!directValue?.trim()) {
    return null;
  }

  const value = chooseValue(question, directValue);
  if (!value) {
    return null;
  }

  return {
    value,
    source: "profile-heuristic",
    reason: "Matched question text to a saved profile field or a common job-form heuristic.",
  };
}

export function suggestFormAnswer(
  question: FormQuestion,
  profile: Profile,
  savedAnswer?: string | null,
  source: SuggestedFormAnswer["source"] = "question-bank",
): SuggestedFormAnswer | null {
  if (savedAnswer?.trim()) {
    const value = chooseValue(question, savedAnswer);
    if (value) {
      return {
        value,
        source,
        reason:
          source === "application-answers"
            ? "Matched an answer from the explicit application answer file."
            : "Matched a previously saved answer for the same question.",
      };
    }
  }

  return answerFromProfile(question, profile);
}
