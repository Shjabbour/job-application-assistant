import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DisplayInfo, ScreenRegion } from "./types.js";

type RawDisplayInfo = Omit<DisplayInfo, "relativePosition" | "shortLabel" | "label">;

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function cleanDisplayInfo(value: unknown): RawDisplayInfo | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const id = Number(raw.id);
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);

  if (![id, x, y, width, height].every(Number.isFinite) || id <= 0 || width <= 0 || height <= 0) {
    return null;
  }

  return {
    id: Math.round(id),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `Screen ${Math.round(id)}`,
    primary: raw.primary === true,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function centerOf(display: ScreenRegion): { x: number; y: number } {
  return {
    x: display.x + display.width / 2,
    y: display.y + display.height / 2,
  };
}

function relativeDirection(display: RawDisplayInfo, primary: RawDisplayInfo): string {
  if (display.id === primary.id) {
    return "primary";
  }

  const displayCenter = centerOf(display);
  const primaryCenter = centerOf(primary);
  const dx = displayCenter.x - primaryCenter.x;
  const dy = displayCenter.y - primaryCenter.y;
  const toleranceX = Math.max(80, Math.min(display.width, primary.width) * 0.2);
  const toleranceY = Math.max(80, Math.min(display.height, primary.height) * 0.2);
  const horizontal = Math.abs(dx) > toleranceX ? (dx < 0 ? "left" : "right") : "";
  const vertical = Math.abs(dy) > toleranceY ? (dy < 0 ? "upper" : "lower") : "";

  if (vertical && horizontal) {
    return `${vertical}-${horizontal}`;
  }

  return vertical || horizontal || "near";
}

function sortByDistanceFromPrimary(displays: RawDisplayInfo[], primary: RawDisplayInfo): RawDisplayInfo[] {
  const primaryCenter = centerOf(primary);
  return [...displays].sort((left, right) => {
    const leftCenter = centerOf(left);
    const rightCenter = centerOf(right);
    const leftDistance = Math.abs(leftCenter.x - primaryCenter.x) + Math.abs(leftCenter.y - primaryCenter.y);
    const rightDistance = Math.abs(rightCenter.x - primaryCenter.x) + Math.abs(rightCenter.y - primaryCenter.y);
    return leftDistance - rightDistance || left.id - right.id;
  });
}

function relativeLabel(direction: string, rank: number, count: number): string {
  if (direction === "primary") {
    return "Primary monitor";
  }

  const nearestLabels: Record<string, string> = {
    left: "Left of primary",
    right: "Right of primary",
    upper: "Above primary",
    lower: "Below primary",
    "upper-left": "Upper left of primary",
    "upper-right": "Upper right of primary",
    "lower-left": "Lower left of primary",
    "lower-right": "Lower right of primary",
    near: "Near primary",
  };
  const farLabels: Record<string, string> = {
    left: "Far left of primary",
    right: "Far right of primary",
    upper: "Far above primary",
    lower: "Far below primary",
    "upper-left": "Far upper left of primary",
    "upper-right": "Far upper right of primary",
    "lower-left": "Far lower left of primary",
    "lower-right": "Far lower right of primary",
    near: "Near primary",
  };

  if (rank === 0 || count === 1) {
    return nearestLabels[direction] ?? "Near primary";
  }

  if (rank === 1) {
    return farLabels[direction] ?? `${rank + 1} near primary`;
  }

  return `${rank + 1} monitors ${direction.replace("-", " ")} of primary`;
}

function addDisplayLabels(displays: RawDisplayInfo[]): DisplayInfo[] {
  if (displays.length === 0) {
    return [];
  }

  const primary = displays.find((display) => display.primary) ?? displays[0];
  const directions = new Map<number, string>();
  const grouped = new Map<string, RawDisplayInfo[]>();

  for (const display of displays) {
    const direction = relativeDirection(display, primary);
    directions.set(display.id, direction);
    grouped.set(direction, [...(grouped.get(direction) ?? []), display]);
  }

  const ranks = new Map<number, { rank: number; count: number }>();
  for (const [direction, group] of grouped.entries()) {
    const ordered = direction === "primary" ? group : sortByDistanceFromPrimary(group, primary);
    ordered.forEach((display, index) => {
      ranks.set(display.id, { rank: index, count: ordered.length });
    });
  }

  return [...displays]
    .sort((left, right) => left.y - right.y || left.x - right.x || left.id - right.id)
    .map((display) => {
      const direction = directions.get(display.id) ?? "near";
      const rankInfo = ranks.get(display.id) ?? { rank: 0, count: 1 };
      const position = relativeLabel(direction, rankInfo.rank, rankInfo.count);
      const shortLabel = `${position} - Screen ${display.id}`;
      const label = `${shortLabel} | ${display.width}x${display.height} at ${display.x},${display.y}`;
      return {
        ...display,
        relativePosition: position,
        shortLabel,
        label,
      };
    });
}

async function listWindowsDisplays(): Promise<DisplayInfo[]> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$screens = [System.Windows.Forms.Screen]::AllScreens
$items = for ($i = 0; $i -lt $screens.Length; $i++) {
  $screen = $screens[$i]
  $match = [System.Text.RegularExpressions.Regex]::Match([string]$screen.DeviceName, '\\d+$')
  $displayId = if ($match.Success) { [int]$match.Value } else { $i + 1 }
  [pscustomobject]@{
    id = $displayId
    name = $screen.DeviceName
    primary = $screen.Primary
    x = $screen.Bounds.X
    y = $screen.Bounds.Y
    width = $screen.Bounds.Width
    height = $screen.Bounds.Height
  }
}

$items | ConvertTo-Json -Depth 4
`;

  const output = await runProcess("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);

  if (!output) {
    return [];
  }

  const parsed = JSON.parse(output) as unknown;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const displays = items
    .map(cleanDisplayInfo)
    .filter((item): item is RawDisplayInfo => item !== null)
    .sort((left, right) => left.id - right.id);
  return addDisplayLabels(displays);
}

export async function listDisplays(): Promise<DisplayInfo[]> {
  if (process.platform === "win32") {
    return listWindowsDisplays();
  }

  return [];
}

function timestampSlug(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    String(date.getMilliseconds()).padStart(3, "0"),
  ].join("");
}

function regionEnv(region: ScreenRegion | null): string {
  if (!region) {
    return "";
  }

  return [region.x, region.y, region.width, region.height].join(",");
}

async function captureWindows(outputPath: string, region: ScreenRegion | null): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$path = $env:LEETCODE_SOLVER_SCREENSHOT_PATH
$region = $env:LEETCODE_SOLVER_REGION

if ([string]::IsNullOrWhiteSpace($region)) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
} else {
  $parts = $region.Split(',')
  if ($parts.Length -ne 4) { throw 'Invalid LEETCODE_SOLVER_REGION.' }
  $bounds = New-Object System.Drawing.Rectangle ([int]$parts[0]), ([int]$parts[1]), ([int]$parts[2]), ([int]$parts[3])
}

$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
`;

  await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      LEETCODE_SOLVER_SCREENSHOT_PATH: outputPath,
      LEETCODE_SOLVER_REGION: regionEnv(region),
    },
  );
}

async function captureMac(outputPath: string, region: ScreenRegion | null): Promise<void> {
  const args = ["-x"];
  if (region) {
    args.push("-R", [region.x, region.y, region.width, region.height].join(","));
  }
  args.push(outputPath);
  await runProcess("screencapture", args);
}

async function captureLinux(outputPath: string, region: ScreenRegion | null): Promise<void> {
  if (region) {
    await runProcess("import", [
      "-window",
      "root",
      "-crop",
      `${region.width}x${region.height}+${region.x}+${region.y}`,
      outputPath,
    ]);
    return;
  }

  await runProcess("gnome-screenshot", ["-f", outputPath]);
}

export async function captureScreen(runDir: string, region: ScreenRegion | null): Promise<string> {
  const screenDir = path.join(runDir, "screens");
  await mkdir(screenDir, { recursive: true });

  const outputPath = path.join(screenDir, `screen-${timestampSlug()}.png`);

  if (process.platform === "win32") {
    await captureWindows(outputPath, region);
    return outputPath;
  }

  if (process.platform === "darwin") {
    await captureMac(outputPath, region);
    return outputPath;
  }

  if (process.platform === "linux") {
    await captureLinux(outputPath, region);
    return outputPath;
  }

  throw new Error(`Screen capture is not supported on ${process.platform}.`);
}

export async function captureClipboardImage(runDir: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Clipboard image capture is currently implemented for Windows. Use image mode with a screenshot file.");
  }

  const screenDir = path.join(runDir, "screens");
  await mkdir(screenDir, { recursive: true });
  const outputPath = path.join(screenDir, `clipboard-${timestampSlug()}.png`);

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$path = $env:LEETCODE_SOLVER_CLIPBOARD_PATH
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) {
  throw 'No image found on the clipboard. Use Win+Shift+S first, then run clipboard mode.'
}

try {
  $image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $image.Dispose()
}
`;

  await runProcess(
    "powershell.exe",
    ["-STA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      LEETCODE_SOLVER_CLIPBOARD_PATH: outputPath,
    },
  );

  return outputPath;
}

export function makeRunId(date = new Date()): string {
  return timestampSlug(date).replace(/-\d{3}$/, "");
}
