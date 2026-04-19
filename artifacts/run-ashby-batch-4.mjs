import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const urlFile = process.env.JAA_DIRECT_APPLY_URL_FILE || "artifacts/continue-ashby-urls-4.txt";
const urls = (await readFile(urlFile, "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const concurrency = Math.max(1, Math.min(Number(process.env.JAA_DIRECT_APPLY_CONCURRENCY || "2") || 2, urls.length));
const timeout = Math.max(60_000, Number(process.env.JAA_DIRECT_APPLY_TIMEOUT_MS || "180000") || 180_000);
let nextIndex = 0;
const results = [];

function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key || key.includes("=") || value == null) {
      continue;
    }
    env[key] = String(value);
  }
  env.JAA_BATCH_APPLY_CHILD = "1";
  return env;
}

function commandForUrl(url) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `npm run cli -- browser auto-apply-form-url ${url}`],
    };
  }

  return {
    command: "npm",
    args: ["run", "cli", "--", "browser", "auto-apply-form-url", url],
  };
}

async function runOne(index, url) {
  const started = Date.now();
  console.log(`\n[START ${index + 1}/${urls.length}] ${url}`);
  try {
    const command = commandForUrl(url);
    const { stdout, stderr } = await execFileAsync(command.command, command.args, {
      cwd: process.cwd(),
      env: childEnv(),
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    const output = `${stdout}\n${stderr}`.trim();
    if (output) {
      console.log(output);
    }
    const submitted = /\bSubmitted:\s+yes\b/i.test(output);
    const reason = (output.match(/\bReason:\s+([^\r\n]+)/i)?.[1] || "").trim();
    const title = (output.match(/\bTitle:\s+([^\r\n]+)/i)?.[1] || "").trim();
    console.log(`[DONE ${index + 1}/${urls.length}] submitted=${submitted ? "yes" : "no"} elapsed=${Math.round((Date.now() - started) / 1000)}s title=${title || "unknown"} reason=${reason || ""}`);
    return { index, url, submitted, reason, title };
  } catch (error) {
    const failure = error;
    const stdout = typeof failure.stdout === "string" ? failure.stdout : Buffer.isBuffer(failure.stdout) ? failure.stdout.toString("utf8") : "";
    const stderr = typeof failure.stderr === "string" ? failure.stderr : Buffer.isBuffer(failure.stderr) ? failure.stderr.toString("utf8") : "";
    const output = `${stdout}\n${stderr}`.trim();
    if (output) {
      console.log(output);
    }
    const submitted = /\bSubmitted:\s+yes\b/i.test(output);
    const reason =
      (output.match(/\bReason:\s+([^\r\n]+)/i)?.[1] || "").trim() ||
      (failure.killed ? "Timed out" : (failure.message || "").split(/\r?\n/)[0].trim());
    const title = (output.match(/\bTitle:\s+([^\r\n]+)/i)?.[1] || "").trim();
    console.log(`[DONE ${index + 1}/${urls.length}] submitted=${submitted ? "yes" : "no"} elapsed=${Math.round((Date.now() - started) / 1000)}s title=${title || "unknown"} reason=${reason || ""}`);
    return { index, url, submitted, reason, title, failed: !submitted };
  }
}

async function worker() {
  for (;;) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= urls.length) return;
    results.push(await runOne(index, urls[index]));
  }
}

console.log(`Direct Ashby batch: ${urls.length} URLs from ${urlFile}, concurrency=${concurrency}, timeout=${Math.round(timeout / 1000)}s`);
await Promise.all(Array.from({ length: concurrency }, () => worker()));
results.sort((a, b) => a.index - b.index);
const submitted = results.filter((result) => result.submitted).length;
console.log(`\nSUMMARY submitted=${submitted}/${urls.length}`);
for (const result of results) {
  console.log(`- submitted=${result.submitted ? "yes" : "no"} | ${result.title || result.url} | ${result.reason || ""}`);
}
