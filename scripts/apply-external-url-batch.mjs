import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const urls = [];
  let parallel = 2;
  let timeoutMs = 120_000;
  let label = "external-batch";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--parallel") {
      parallel = Math.max(1, Number(argv[++index] || "1") || 1);
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = Math.max(30_000, Number(argv[++index] || "120000") || 120_000);
      continue;
    }
    if (arg === "--label") {
      label = (argv[++index] || label).replace(/[^\w.-]+/g, "-").slice(0, 80) || label;
      continue;
    }
    if (arg === "--file") {
      const file = argv[++index];
      if (!file) {
        throw new Error("--file requires a path");
      }
      const text = fs.readFileSync(path.resolve(repoRoot, file), "utf8");
      urls.push(...extractUrls(text));
      continue;
    }
    urls.push(...extractUrls(arg));
  }

  return { urls: [...new Set(urls)], parallel, timeoutMs, label };
}

function extractUrls(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => /^https?:\/\//i.test(part));
}

function summarize(stdout, stderr, timedOut) {
  const combined = `${stdout}\n${stderr}`;
  const submitted = /\bSubmitted:\s*yes\b/i.test(combined);
  const reason = combined.match(/\bReason:\s*(.+)/i)?.[1]?.trim() || "";
  const nextAction = combined.match(/\bNext action:\s*(.+)/i)?.[1]?.trim() || "";
  const filled = combined.match(/\bFilled:\s*(.+)/i)?.[1]?.trim() || "";

  return {
    submitted,
    timedOut,
    reason,
    nextAction,
    filled,
  };
}

function killProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pid || process.platform !== "win32") {
      resolve();
      return;
    }
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    killer.once("close", () => resolve());
    killer.once("error", () => resolve());
  });
}

async function runOne(url, index, total, timeoutMs, label) {
  const prefix = `[${label} ${index}/${total}]`;
  const started = Date.now();
  console.log(`${prefix} START ${url}`);

  return await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts", "browser", "auto-apply-form-url", url],
      {
      cwd: repoRoot,
      windowsHide: true,
      env: process.env,
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(async () => {
      timedOut = true;
      await killProcessTree(child.pid);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      stderr += `${error.stack || error.message}\n`;
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const elapsedSeconds = ((Date.now() - started) / 1000).toFixed(1);
      const summary = summarize(stdout, stderr, timedOut);
      const status = summary.submitted ? "SUBMITTED" : timedOut ? "TIMEOUT" : "NOT_SUBMITTED";
      console.log(`${prefix} ${status} ${elapsedSeconds}s code=${code ?? "n/a"}`);
      if (summary.nextAction) {
        console.log(`${prefix} next=${summary.nextAction}`);
      }
      if (summary.reason) {
        console.log(`${prefix} reason=${summary.reason}`);
      }
      if (stderr.trim()) {
        console.log(`${prefix} stderr=${stderr.trim().slice(0, 1200)}`);
      }
      resolve({ url, code, stdout, stderr, ...summary });
    });
  });
}

async function main() {
  const { urls, parallel, timeoutMs, label } = parseArgs(process.argv.slice(2));
  if (urls.length === 0) {
    throw new Error("No URLs provided.");
  }

  console.log(`[${label}] urls=${urls.length} parallel=${parallel} timeoutMs=${timeoutMs}`);
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < urls.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await runOne(urls[index], index + 1, urls.length, timeoutMs, label);
    }
  }

  await Promise.all(Array.from({ length: Math.min(parallel, urls.length) }, () => worker()));
  const submitted = results.filter((result) => result?.submitted).length;
  const timedOut = results.filter((result) => result?.timedOut).length;
  console.log(`[${label}] DONE submitted=${submitted} notSubmitted=${results.length - submitted} timedOut=${timedOut}`);
  for (const result of results) {
    console.log(
      `[${label}] RESULT ${result.submitted ? "submitted" : "blocked"} | ${result.reason || result.nextAction || "No reason"} | ${result.url}`,
    );
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
