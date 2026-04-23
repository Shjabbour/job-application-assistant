import { existsSync, readFileSync } from "node:fs";

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed[0] === trimmed.at(-1) && (trimmed[0] === '"' || trimmed[0] === "'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function loadEnvFiles(paths: string[]): void {
  for (const envPath of paths) {
    if (!existsSync(envPath)) {
      continue;
    }

    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const exportLine = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
      const equalsIndex = exportLine.indexOf("=");
      if (equalsIndex <= 0) {
        continue;
      }

      const key = exportLine.slice(0, equalsIndex).trim();
      if (!key || process.env[key] !== undefined) {
        continue;
      }

      process.env[key] = stripMatchingQuotes(exportLine.slice(equalsIndex + 1));
    }
  }
}
