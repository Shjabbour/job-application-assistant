import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { answerChat, buildApplicationPlan, buildFitSummary, buildLinkedInDraft } from "./lib/assistant.js";
import {
  advanceAttachedLinkedInCollectionPage,
  attachedBrowserHasLinkedInPage,
  autofillAttachedLinkedInApplication,
  autofillAttachedCurrentForm,
  captureAttachedCurrentPage,
  captureCurrentLinkedInDraft,
  captureJobPosting,
  clickAttachedLinkedInPreview,
  collectAttachedLinkedInJobs,
  isAttachedBrowserAvailable,
  openAttachedJob,
  processAttachedExternalJobFromPreview,
  getDebugChromeLaunchCommand,
  openBrowser,
  reviewAttachedLinkedInApplication,
  reviewAttachedCurrentForm,
  reviewCurrentLinkedInApplication,
} from "./lib/browser.js";
import {
  addJobFromDraft,
  addJobsFromCollection,
  appendConversation,
  getJobs,
  recordHighPayingCompany,
  getProfile,
  saveJobs,
  saveProfile,
} from "./lib/store.js";
import type { Job, Profile } from "./lib/types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function print(message: string): void {
  output.write(`${message}\n`);
}

async function saveExternalBatchUrls(
  jobs: Array<{ index: number; title: string; sourceUrl: string; destinationUrl: string }>,
): Promise<string> {
  const outputDir = path.join(process.cwd(), "data", "browser");
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(outputDir, `external-apply-urls-${stamp}.json`);
  await writeFile(`${filePath}`, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
  return filePath;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildJobId(title: string, company: string): string {
  const slug = `${company}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);

  return `${slug}-${Date.now().toString().slice(-6)}`;
}

function findJob(jobs: Job[], id: string): Job | undefined {
  return jobs.find((job) => job.id === id);
}

async function askList(rl: readline.Interface, label: string): Promise<string[]> {
  const answer = (await rl.question(`${label} (comma separated): `)).trim();
  return answer
    .split(",")
    .map((item: string) => item.trim())
    .filter(Boolean);
}

async function editProfile(rl: readline.Interface): Promise<void> {
  const current = await getProfile();
  const nextSkills = await askList(rl, `Skills [${current.skills.join(", ")}]`);
  const nextTargetRoles = await askList(rl, `Target roles [${current.targetRoles.join(", ")}]`);

  const profile: Profile = {
    name: (await rl.question(`Name [${current.name}]: `)).trim() || current.name,
    email: (await rl.question(`Email [${current.email}]: `)).trim() || current.email,
    phone: (await rl.question(`Phone [${current.phone}]: `)).trim() || current.phone,
    location: (await rl.question(`Location [${current.location}]: `)).trim() || current.location,
    city: (await rl.question(`City [${current.city}]: `)).trim() || current.city,
    state: (await rl.question(`State [${current.state}]: `)).trim() || current.state,
    linkedinUrl:
      (await rl.question(`LinkedIn URL [${current.linkedinUrl}]: `)).trim() || current.linkedinUrl,
    resumeSummary:
      (await rl.question(`Resume summary [${current.resumeSummary}]: `)).trim() ||
      current.resumeSummary,
    skills: nextSkills.length > 0 ? nextSkills : current.skills,
    targetRoles: nextTargetRoles.length > 0 ? nextTargetRoles : current.targetRoles,
    workAuthorization:
      (await rl.question(`Work authorization [${current.workAuthorization}]: `)).trim() ||
      current.workAuthorization,
    yearsOfExperience:
      (await rl.question(`Years of experience [${current.yearsOfExperience}]: `)).trim() ||
      current.yearsOfExperience,
  };

  await saveProfile(profile);
  print("Profile saved.");
}

async function addJob(rl: readline.Interface): Promise<void> {
  const jobs = await getJobs();

  const title = (await rl.question("Job title: ")).trim();
  const company = (await rl.question("Company: ")).trim();
  const url = (await rl.question("Job URL: ")).trim();
  const source = (await rl.question("Source [LinkedIn]: ")).trim() || "LinkedIn";
  const status = ((await rl.question("Status [saved]: ")).trim() || "saved") as Job["status"];
  const description = (await rl.question("Paste a short job description: ")).trim();
  const notes = (await rl.question("Notes: ")).trim();

  const job: Job = {
    id: buildJobId(title, company),
    title,
    company,
    url,
    source,
    status,
    description,
    notes,
    createdAt: nowIso(),
  };

  jobs.push(job);
  await saveJobs(jobs);
  print(`Saved job ${job.id}`);
}

async function listJobs(): Promise<void> {
  const jobs = await getJobs();

  if (jobs.length === 0) {
    print("No saved jobs.");
    return;
  }

  for (const job of jobs) {
    print(`${job.id} | ${job.status} | ${job.title} @ ${job.company}`);
  }
}

async function viewJob(id: string): Promise<void> {
  const jobs = await getJobs();
  const profile = await getProfile();
  const job = findJob(jobs, id);

  if (!job) {
    print(`Job not found: ${id}`);
    return;
  }

  print(buildFitSummary(profile, job));
}

async function jobPlan(id: string): Promise<void> {
  const jobs = await getJobs();
  const profile = await getProfile();
  const job = findJob(jobs, id);

  if (!job) {
    print(`Job not found: ${id}`);
    return;
  }

  print(buildApplicationPlan(profile, job));
}

async function jobLinkedIn(id: string): Promise<void> {
  const jobs = await getJobs();
  const profile = await getProfile();
  const job = findJob(jobs, id);

  if (!job) {
    print(`Job not found: ${id}`);
    return;
  }

  print(buildLinkedInDraft(profile, job));
}

async function browserOpen(url: string): Promise<void> {
  await openBrowser(url, true);
}

async function browserCapture(url: string): Promise<void> {
  const draft = await captureJobPosting(url, false);
  const job = await addJobFromDraft(draft);
  print(`Saved ${job.id} | ${job.title} @ ${job.company}`);
}

async function browserCaptureLinkedInCurrent(): Promise<void> {
  const draft = await captureCurrentLinkedInDraft(true);
  const job = await addJobFromDraft(draft);
  print(`Saved ${job.id} | ${job.title} @ ${job.company}`);
}

async function browserReviewLinkedInCurrent(): Promise<void> {
  const review = await reviewCurrentLinkedInApplication(true);
  print(
    [
      `Title: ${review.title}`,
      `Company: ${review.company}`,
      `URL: ${review.url}`,
      `Easy Apply: ${review.hasEasyApply ? "yes" : "no"}`,
      `Stage: ${review.stage}`,
      `Primary action: ${review.primaryAction}`,
      `Fields detected: ${review.fields.length}`,
      ...review.fields.map(
        (field, index) =>
          `${index + 1}. ${field.label} | ${field.type} | ${field.required ? "required" : "optional"}`,
      ),
      ...review.notes.map((note) => `Note: ${note}`),
    ].join("\n"),
  );
}

async function browserReviewLinkedInAttached(): Promise<void> {
  const review = await reviewAttachedLinkedInApplication();
  print(
    [
      `Title: ${review.title}`,
      `Company: ${review.company}`,
      `URL: ${review.url}`,
      `Easy Apply: ${review.hasEasyApply ? "yes" : "no"}`,
      `Stage: ${review.stage}`,
      `Primary action: ${review.primaryAction}`,
      `Fields detected: ${review.fields.length}`,
      ...review.fields.map(
        (field, index) =>
          `${index + 1}. ${field.label} | ${field.type} | ${field.required ? "required" : "optional"}`,
      ),
      ...review.notes.map((note) => `Note: ${note}`),
    ].join("\n"),
  );
}

async function browserCaptureAttachedCurrent(): Promise<void> {
  const draft = await captureAttachedCurrentPage();
  const job = await addJobFromDraft(draft);
  print(`Saved ${job.id} | ${job.title} @ ${job.company}`);
}

async function browserCollectAttachedJobs(): Promise<void> {
  const jobs = await collectAttachedLinkedInJobs();
  if (jobs.length === 0) {
    print("No visible LinkedIn job cards were collected from the current page.");
    return;
  }

  for (const [index, job] of jobs.entries()) {
    print(`${index + 1}. ${job.title} | ${job.company} | ${job.location} | ${job.url}`);
  }
}

async function browserAutofillAttached(): Promise<void> {
  const profile = await getProfile();
  const result = await autofillAttachedLinkedInApplication(profile);
  print(
    [
      `Filled: ${result.filled.join(", ") || "none"}`,
      `Skipped: ${result.skipped.join(", ") || "none"}`,
      `Next action: ${result.nextAction}`,
      "Stopped before submit: yes",
    ].join("\n"),
  );
}

async function browserSaveAttachedJobs(): Promise<void> {
  const collection = await collectAttachedLinkedInJobs();
  const added = await addJobsFromCollection(collection);

  if (added.length === 0) {
    print("No new jobs were added. Visible jobs were already saved or none were found.");
    return;
  }

  for (const [index, job] of added.entries()) {
    print(`${index + 1}. ${job.id} | ${job.title} | ${job.url}`);
  }
}

async function browserProcessVisibleJobs(): Promise<void> {
  const profile = await getProfile();
  const collection = await collectAttachedLinkedInJobs();
  const unique = collection.filter(
    (job, index, array) => array.findIndex((entry) => entry.url === job.url) === index,
  );

  if (unique.length === 0) {
    print("No visible jobs were found to process.");
    return;
  }

  const requestedLimit = Number(process.env.JAA_BATCH_LIMIT || "10");
  const safeLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 10;
  const limit = Math.min(unique.length, safeLimit);
  print(`Processing ${limit} visible jobs. Each flow stops before submit.`);

  for (let index = 0; index < limit; index += 1) {
    const job = unique[index];
    print(`\n[${index + 1}/${limit}] ${job.title}`);
    await openAttachedJob(job.url);

    const review = await reviewAttachedLinkedInApplication().catch((error) => {
      print(`Review failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return null;
    });

    if (!review) {
      continue;
    }

    print(`Easy Apply: ${review.hasEasyApply ? "yes" : "no"} | Action: ${review.primaryAction}`);

    if (!review.hasEasyApply) {
      print("Skipped: no Easy Apply button.");
      continue;
    }

    const autofill = await autofillAttachedLinkedInApplication(profile).catch((error) => {
      print(`Autofill failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return null;
    });

    if (!autofill) {
      continue;
    }

    print(`Filled: ${autofill.filled.join(", ") || "none"}`);
    print(`Next action: ${autofill.nextAction}`);
    print("Stopped before submit.");
  }
}

async function browserProcessVisibleExternalJobs(): Promise<void> {
  const requestedLimit = Number(process.env.JAA_BATCH_LIMIT || "10");
  const safeLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 10;
  const requestedPages = Number(process.env.JAA_PAGE_LIMIT || "1");
  const pageLimit = Number.isFinite(requestedPages) && requestedPages > 0 ? requestedPages : 1;
  const capturedUrls: Array<{ index: number; title: string; sourceUrl: string; destinationUrl: string }> =
    [];
  let processedCount = 0;

  for (let pageNumber = 1; pageNumber <= pageLimit && processedCount < safeLimit; pageNumber += 1) {
    const collection = await collectAttachedLinkedInJobs();
    const unique = collection.filter(
      (job, index, array) => array.findIndex((entry) => entry.url === job.url) === index,
    );

    if (unique.length === 0) {
      print(`No visible jobs were found on page ${pageNumber}.`);
      break;
    }

    const remaining = safeLimit - processedCount;
    const limit = Math.min(unique.length, remaining);
    print(`Processing page ${pageNumber}/${pageLimit}, ${limit} jobs from LinkedIn previews.`);

    for (let index = 0; index < limit; index += 1) {
      const job = unique[index];
      print(`\n[${processedCount + 1}/${safeLimit}] ${job.title}`);
      await clickAttachedLinkedInPreview(index).catch(() => undefined);
      const result = await processAttachedExternalJobFromPreview(index).catch((error) => {
        print(`Failed: ${error instanceof Error ? error.message : "unknown error"}`);
        return null;
      });

      processedCount += 1;

      if (!result) {
        continue;
      }

      print(`External apply found: ${result.externalApplyFound ? "yes" : "no"}`);
      print(`Destination: ${result.destinationUrl}`);
      if (result.compensationText) {
        print(`Compensation: ${result.compensationText}`);
      }
      if (result.sourceCompany && (result.estimatedMaxAnnualCompensation ?? 0) >= 250000) {
        const saved = await recordHighPayingCompany({
          company: result.sourceCompany,
          title: result.sourceJobTitle,
          sourceJobUrl: result.sourceJobUrl,
          compensationText:
            result.compensationText || `$${result.estimatedMaxAnnualCompensation?.toLocaleString()}`,
          estimatedMaxAnnualCompensation: result.estimatedMaxAnnualCompensation ?? 0,
          capturedAt: nowIso(),
        });
        print(
          saved
            ? `Saved high-paying company: ${result.sourceCompany}`
            : `High-paying company already saved: ${result.sourceCompany}`,
        );
      }
      if (result.externalApplyFound) {
        capturedUrls.push({
          index: processedCount,
          title: result.sourceJobTitle,
          sourceUrl: result.sourceJobUrl,
          destinationUrl: result.destinationUrl,
        });
      }
      for (const note of result.notes) {
        print(`Note: ${note}`);
      }
    }

    if (processedCount >= safeLimit || pageNumber >= pageLimit) {
      break;
    }

    const advanced = await advanceAttachedLinkedInCollectionPage().catch(() => false);
    if (!advanced) {
      print("Could not advance to the next LinkedIn jobs page.");
      break;
    }
  }

  if (capturedUrls.length > 0) {
    const filePath = await saveExternalBatchUrls(capturedUrls);
    print(`Saved employer URLs: ${filePath}`);
  } else {
    print("No employer application URLs were captured.");
  }
}

async function browserStartAutopilot(): Promise<void> {
  const linkedInUrl = "https://www.linkedin.com/jobs/collections/remote-jobs/";
  const chromeCandidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
  const debugProfileDir = path.join(process.cwd(), ".chrome-debug-profile");

  if (!(await isAttachedBrowserAvailable())) {
    print("Starting debug Chrome...");
    if (!chromePath) {
      print("Chrome was not found in standard locations.");
      return;
    }

    spawn(
      chromePath,
      [
        "--remote-debugging-port=9222",
        `--user-data-dir=${debugProfileDir}`,
        linkedInUrl,
      ],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
      },
    ).unref();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await isAttachedBrowserAvailable()) {
        break;
      }
      await sleep(1000);
    }
  }

  if (!(await isAttachedBrowserAvailable())) {
    print("Could not connect to the attached browser at http://127.0.0.1:9222");
    print("Start it manually with: powershell -ExecutionPolicy Bypass -File .\\start-debug-chrome.ps1");
    return;
  }

  if (!(await attachedBrowserHasLinkedInPage())) {
    print("Attached browser is available, but no LinkedIn jobs page is open.");
    print(`Open this URL in the debug browser: ${linkedInUrl}`);
    return;
  }

  print("Attached browser detected on LinkedIn. Starting external job processing loop...");
  await browserProcessVisibleExternalJobs();
}

async function browserReviewAttachedForm(): Promise<void> {
  const review = await reviewAttachedCurrentForm();
  print(
    [
      `Title: ${review.title}`,
      `URL: ${review.url}`,
      `Primary action: ${review.primaryAction}`,
      `Fields detected: ${review.fields.length}`,
      ...review.fields.map(
        (field, index) =>
          `${index + 1}. ${field.label} | ${field.type} | ${field.required ? "required" : "optional"}`,
      ),
      ...review.notes.map((note) => `Note: ${note}`),
    ].join("\n"),
  );
}

async function browserAutofillAttachedForm(): Promise<void> {
  const profile = await getProfile();
  const result = await autofillAttachedCurrentForm(profile);
  print(
    [
      `Filled: ${result.filled.join(", ") || "none"}`,
      `Skipped: ${result.skipped.join(", ") || "none"}`,
      `Next action: ${result.nextAction}`,
      "Stopped before submit: yes",
    ].join("\n"),
  );
}

function browserAttachHelp(): void {
  print(
    [
      "Start real Chrome in debug mode with:",
      "powershell -ExecutionPolicy Bypass -File .\\start-debug-chrome.ps1",
      "",
      "Then log in manually in that Chrome window.",
      "",
      "After login, use:",
      "npm run cli -- browser review-linkedin-attached",
      "npm run cli -- browser capture-attached-current",
      "npm run cli -- browser collect-attached-jobs",
      "npm run cli -- browser save-attached-jobs",
      "npm run cli -- browser autofill-attached-current",
      "npm run cli -- browser process-visible-jobs",
      "npm run cli -- browser review-attached-form",
      "npm run cli -- browser autofill-attached-form",
      "npm run cli -- browser process-visible-external-jobs",
      "npm run cli -- browser start-autopilot",
      "",
      `CDP URL: ${process.env.JAA_CDP_URL || "http://127.0.0.1:9222"}`,
      `Launch command: ${getDebugChromeLaunchCommand("https://www.linkedin.com/login")}`,
    ].join("\n"),
  );
}

function printHelp(): void {
  print(
    [
      "Commands:",
      "/help",
      "/profile show",
      "/profile edit",
      "/jobs",
      "/job add",
      "/job view <id>",
      "/job plan <id>",
      "/job linkedin <id>",
      "/browser open <url>",
      "/browser capture <url>",
      "/browser capture-linkedin-current",
      "/browser review-linkedin-current",
      "/browser attach-help",
      "/browser review-linkedin-attached",
      "/browser capture-attached-current",
      "/browser collect-attached-jobs",
      "/browser save-attached-jobs",
      "/browser autofill-attached-current",
      "/browser process-visible-jobs",
      "/browser review-attached-form",
      "/browser autofill-attached-form",
      "/browser process-visible-external-jobs",
      "/browser start-autopilot",
      "/quit",
    ].join("\n"),
  );
}

async function chatMode(): Promise<void> {
  const rl = readline.createInterface({ input, output });

  print("Job Application Assistant");
  print("Type /help for commands.");

  while (true) {
    const line = (await rl.question("> ")).trim();

    if (!line) {
      continue;
    }

    if (line === "/quit") {
      rl.close();
      return;
    }

    if (line === "/help") {
      printHelp();
      continue;
    }

    if (line === "/profile show") {
      print(JSON.stringify(await getProfile(), null, 2));
      continue;
    }

    if (line === "/profile edit") {
      await editProfile(rl);
      continue;
    }

    if (line === "/jobs") {
      await listJobs();
      continue;
    }

    if (line === "/job add") {
      await addJob(rl);
      continue;
    }

    if (line.startsWith("/job view ")) {
      await viewJob(line.replace("/job view ", "").trim());
      continue;
    }

    if (line.startsWith("/job plan ")) {
      await jobPlan(line.replace("/job plan ", "").trim());
      continue;
    }

    if (line.startsWith("/job linkedin ")) {
      await jobLinkedIn(line.replace("/job linkedin ", "").trim());
      continue;
    }

    if (line.startsWith("/browser open ")) {
      await browserOpen(line.replace("/browser open ", "").trim());
      continue;
    }

    if (line.startsWith("/browser capture ")) {
      await browserCapture(line.replace("/browser capture ", "").trim());
      continue;
    }

    if (line === "/browser capture-linkedin-current") {
      await browserCaptureLinkedInCurrent();
      continue;
    }

    if (line === "/browser review-linkedin-current") {
      await browserReviewLinkedInCurrent();
      continue;
    }

    if (line === "/browser attach-help") {
      browserAttachHelp();
      continue;
    }

    if (line === "/browser review-linkedin-attached") {
      await browserReviewLinkedInAttached();
      continue;
    }

    if (line === "/browser capture-attached-current") {
      await browserCaptureAttachedCurrent();
      continue;
    }

    if (line === "/browser collect-attached-jobs") {
      await browserCollectAttachedJobs();
      continue;
    }

    if (line === "/browser autofill-attached-current") {
      await browserAutofillAttached();
      continue;
    }

    if (line === "/browser save-attached-jobs") {
      await browserSaveAttachedJobs();
      continue;
    }

    if (line === "/browser process-visible-jobs") {
      await browserProcessVisibleJobs();
      continue;
    }

    if (line === "/browser review-attached-form") {
      await browserReviewAttachedForm();
      continue;
    }

    if (line === "/browser autofill-attached-form") {
      await browserAutofillAttachedForm();
      continue;
    }

    if (line === "/browser process-visible-external-jobs") {
      await browserProcessVisibleExternalJobs();
      continue;
    }

    if (line === "/browser start-autopilot") {
      await browserStartAutopilot();
      continue;
    }

    const profile = await getProfile();
    const jobs = await getJobs();
    const reply = answerChat(line, profile, jobs);

    await appendConversation({ role: "user", content: line, createdAt: nowIso() });
    await appendConversation({ role: "assistant", content: reply, createdAt: nowIso() });

    print(reply);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [scope, action, id] = args;
  const rl = readline.createInterface({ input, output });

  try {
    if (!scope || scope === "chat") {
      rl.close();
      await chatMode();
      return;
    }

    if (scope === "profile" && action === "show") {
      rl.close();
      print(JSON.stringify(await getProfile(), null, 2));
      return;
    }

    if (scope === "profile" && action === "edit") {
      await editProfile(rl);
      rl.close();
      return;
    }

    if (scope === "job" && action === "add") {
      await addJob(rl);
      rl.close();
      return;
    }

    if (scope === "job" && action === "list") {
      rl.close();
      await listJobs();
      return;
    }

    if (scope === "job" && action === "view" && id) {
      rl.close();
      await viewJob(id);
      return;
    }

    if (scope === "job" && action === "plan" && id) {
      rl.close();
      await jobPlan(id);
      return;
    }

    if (scope === "job" && action === "linkedin" && id) {
      rl.close();
      await jobLinkedIn(id);
      return;
    }

    if (scope === "browser" && action === "open" && id) {
      rl.close();
      await browserOpen(id);
      return;
    }

    if (scope === "browser" && action === "capture" && id) {
      rl.close();
      await browserCapture(id);
      return;
    }

    if (scope === "browser" && action === "capture-linkedin-current") {
      rl.close();
      await browserCaptureLinkedInCurrent();
      return;
    }

    if (scope === "browser" && action === "review-linkedin-current") {
      rl.close();
      await browserReviewLinkedInCurrent();
      return;
    }

    if (scope === "browser" && action === "attach-help") {
      rl.close();
      browserAttachHelp();
      return;
    }

    if (scope === "browser" && action === "review-linkedin-attached") {
      rl.close();
      await browserReviewLinkedInAttached();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "capture-attached-current") {
      rl.close();
      await browserCaptureAttachedCurrent();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "collect-attached-jobs") {
      rl.close();
      await browserCollectAttachedJobs();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "autofill-attached-current") {
      rl.close();
      await browserAutofillAttached();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "save-attached-jobs") {
      rl.close();
      await browserSaveAttachedJobs();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "process-visible-jobs") {
      rl.close();
      await browserProcessVisibleJobs();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "review-attached-form") {
      rl.close();
      await browserReviewAttachedForm();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "autofill-attached-form") {
      rl.close();
      await browserAutofillAttachedForm();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "process-visible-external-jobs") {
      rl.close();
      await browserProcessVisibleExternalJobs();
      process.exit(0);
      return;
    }

    if (scope === "browser" && action === "start-autopilot") {
      rl.close();
      await browserStartAutopilot();
      process.exit(0);
      return;
    }

    rl.close();
    print("Unknown command. Run `npm run chat` or see README.md.");
  } catch (error) {
    rl.close();
    print(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
  }
}

void main();
