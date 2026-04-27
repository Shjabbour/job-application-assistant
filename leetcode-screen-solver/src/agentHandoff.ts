import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface AgentHandoffResult {
  answered: boolean;
  answer: string;
  error: string | null;
}

function npmExecutable(): string {
  return process.platform === "win32" ? "cmd" : "npm";
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const parts = value.map(pickText).filter((item): item is string => Boolean(item));
    return parts.length ? parts.join("\n") : null;
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return (
      pickText(record.reply) ??
      pickText(record.response) ??
      pickText(record.text) ??
      pickText(record.output) ??
      pickText(record.message) ??
      pickText(record.result)
    );
  }

  return null;
}

function extractAgentAnswer(stdout: string): string {
  const clean = stripAnsi(stdout);
  const json = extractJsonObject(clean);
  const jsonText = json ? pickText(json) : null;
  return jsonText ?? clean;
}

function terminateChildProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
  } else {
    child.kill();
  }

  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
}

async function readOptionalTrimmed(filePath: string): Promise<string | null> {
  try {
    const value = await readFile(filePath, "utf8");
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function shortErrorText(value: string): string {
  const clean = stripAnsi(value).replace(/\s+/g, " ").trim();
  if (!clean) {
    return "";
  }

  return clean.length <= 600 ? clean : `${clean.slice(0, 597)}...`;
}

export async function askCodexCliAgent(
  repoRoot: string,
  promptFilePath: string,
  runDir: string,
  imagePaths: string[] = [],
): Promise<AgentHandoffResult> {
  const timeoutSeconds = process.env.CODEX_AGENT_TIMEOUT_SECONDS?.trim() || "90";
  const outputPath = path.join(runDir, "codex-answer.md");
  const promptText = await readOptionalTrimmed(promptFilePath);
  const message = promptText
    ? [
        promptText,
        "",
        "Return only the candidate-facing answer. Keep it scannable, but include enough spoken walkthrough detail for both the first-try and robust paths. Include a complete first-try code solution when valid. Use more comments than normal live code so the candidate can look like they are thinking aloud while typing; comments should explain intent, invariants, edge cases, and key data-structure choices.",
      ].join("\n")
    : [
        "Answer the interview assessment prompt in this local file.",
        "",
        promptFilePath,
        "",
        "Return only the candidate-facing answer. Keep it scannable, but include enough spoken walkthrough detail for both the first-try and robust paths. Include a complete first-try code solution when valid. Use more comments than normal live code so the candidate can look like they are thinking aloud while typing; comments should explain intent, invariants, edge cases, and key data-structure choices.",
      ].join("\n");

  return new Promise((resolve) => {
    const imageArgs = imagePaths.flatMap((imagePath) => ["--image", path.resolve(imagePath)]);
    const codexArgs = [
      "exec",
      "--sandbox",
      "read-only",
      "--output-last-message",
      outputPath,
      ...imageArgs,
      "-",
    ];
    const command = process.platform === "win32" ? "cmd" : "codex";
    const commandArgs = process.platform === "win32" ? ["/c", "codex", ...codexArgs] : codexArgs;
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdin.write(message, "utf8");
    child.stdin.end();

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      terminateChildProcessTree(child);
      resolve({
        answered: false,
        answer: "",
        error: `Codex CLI timed out after ${timeoutSeconds}s.`,
      });
    }, Number(process.env.CODEX_AGENT_TIMEOUT_MS ?? Number(timeoutSeconds) * 1000 + 5000));

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        answered: false,
        answer: "",
        error: error.message,
      });
    });

    child.on("close", async (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);

      const fromFile = await readOptionalTrimmed(outputPath);
      if (fromFile) {
        resolve({ answered: true, answer: fromFile, error: null });
        return;
      }

      const stdoutText = shortErrorText(Buffer.concat(stdout).toString("utf8"));
      const stderrText = shortErrorText(Buffer.concat(stderr).toString("utf8"));
      const fallback = extractAgentAnswer(stdoutText);
      resolve({
        answered: false,
        answer: "",
        error: stderrText || fallback || `Codex CLI exited with code ${code}.`,
      });
    });
  });
}

export async function askOpenClawAgent(repoRoot: string, promptFilePath: string): Promise<AgentHandoffResult> {
  const timeoutSeconds = process.env.OPENCLAW_AGENT_TIMEOUT_SECONDS?.trim() || "45";
  const agentId = process.env.OPENCLAW_AGENT_ID?.trim() || "main";
  const promptText = await readOptionalTrimmed(promptFilePath);
  const message = promptText
    ? [
        promptText,
        "",
        "Return only the candidate-facing answer. Keep it scannable, but include enough spoken walkthrough detail for both the first-try and robust paths. Include a complete first-try code solution when valid. Use more comments than normal live code so the candidate can look like they are thinking aloud while typing; comments should explain intent, invariants, edge cases, and key data-structure choices.",
      ].join("\n")
    : [
        "Answer the interview assessment prompt in this local file.",
        "",
        promptFilePath,
        "",
        "Return only the candidate-facing answer. Keep it scannable, but include enough spoken walkthrough detail for both the first-try and robust paths. Include a complete first-try code solution when valid. Use more comments than normal live code so the candidate can look like they are thinking aloud while typing; comments should explain intent, invariants, edge cases, and key data-structure choices.",
      ].join("\n");

  return new Promise((resolve) => {
    const command = npmExecutable();
    const openClawArgs = [
      "run",
      "openclaw:cli",
      "--",
      "agent",
      "--agent",
      agentId,
      "--message",
      message,
      "--json",
      "--timeout",
      timeoutSeconds,
    ];
    const args = process.platform === "win32" ? ["/c", "npm", ...openClawArgs] : openClawArgs;
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      terminateChildProcessTree(child);
      resolve({
        answered: false,
        answer: "",
        error: `OpenClaw agent timed out after ${timeoutSeconds}s (agent: ${agentId}).`,
      });
    }, Number(process.env.OPENCLAW_AGENT_TIMEOUT_MS ?? Number(timeoutSeconds) * 1000 + 5000));

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        answered: false,
        answer: "",
        error: error.message,
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);

      const answer = extractAgentAnswer(Buffer.concat(stdout).toString("utf8"));
      const error = stripAnsi(Buffer.concat(stderr).toString("utf8"));
      if (code === 0 && answer) {
        resolve({ answered: true, answer, error: null });
        return;
      }

      resolve({
        answered: false,
        answer: "",
        error: error || answer || `OpenClaw agent exited with code ${code} (agent: ${agentId}).`,
      });
    });
  });
}
