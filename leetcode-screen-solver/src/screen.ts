import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { assertUsableCapture } from "./captureValidation.js";
import type { DisplayInfo, ScreenRegion, WindowInfo } from "./types.js";

type RawDisplayInfo = Omit<DisplayInfo, "relativePosition" | "shortLabel" | "label">;
type RawWindowInfo = Omit<WindowInfo, "label">;

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs: number | null = null): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = timeoutMs
      ? setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          child.kill();
          reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      callback();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve(stdout.trim());
          return;
        }

        reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
      });
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

function cleanWindowInfo(value: unknown): RawWindowInfo | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const id = Number(raw.id);
  const processId = Number(raw.processId);
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  const title = typeof raw.title === "string" ? raw.title.trim() : "";

  if (![id, processId, x, y, width, height].every(Number.isFinite) || id <= 0 || width <= 0 || height <= 0 || !title) {
    return null;
  }

  return {
    id: Math.round(id),
    processId: Math.round(processId),
    processName: typeof raw.processName === "string" && raw.processName.trim() ? raw.processName.trim() : "Unknown app",
    title,
    minimized: raw.minimized === true,
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

function addWindowLabels(windows: RawWindowInfo[]): WindowInfo[] {
  return windows.map((windowInfo) => ({
    ...windowInfo,
    label: `${windowInfo.processName} - ${windowInfo.title} | ${windowInfo.width}x${windowInfo.height} at ${windowInfo.x},${windowInfo.y}`,
  }));
}

export function isRemoteDesktopWindow(windowInfo: Pick<RawWindowInfo, "processName" | "title">): boolean {
  const processName = windowInfo.processName.toLowerCase();
  const title = windowInfo.title.toLowerCase();
  return (
    title.includes("chrome remote desktop") ||
    title.includes("remote chrome desktop") ||
    title.includes("remote desktop") ||
    processName.includes("remoting_desktop") ||
    processName.includes("remote_assistance_host")
  );
}

function usefulWindowScore(windowInfo: RawWindowInfo): number {
  const processName = windowInfo.processName.toLowerCase();
  const title = windowInfo.title.toLowerCase();
  const noisyProcesses = new Set([
    "applicationframehost",
    "explorer",
    "shellexperiencehost",
    "systemsettings",
    "tabtip",
    "textinputhost",
  ]);

  if (noisyProcesses.has(processName)) {
    return -100;
  }

  if (title === "program manager" || title === "settings" || title.includes("interview coder")) {
    return -100;
  }

  if (isRemoteDesktopWindow(windowInfo)) {
    return 140;
  }

  if (processName.includes("discord")) {
    return 100;
  }

  if (processName.includes("chrome") || processName.includes("msedge") || processName.includes("firefox")) {
    return 80;
  }

  if (processName.includes("code")) {
    return 60;
  }

  return 10;
}

async function listWindowsWindows(): Promise<WindowInfo[]> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class WindowCaptureNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct WINDOWPLACEMENT {
    public int length;
    public int flags;
    public int showCmd;
    public POINT ptMinPosition;
    public POINT ptMaxPosition;
    public RECT rcNormalPosition;
  }

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

$items = New-Object System.Collections.Generic.List[object]
[WindowCaptureNative]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [WindowCaptureNative]::IsWindowVisible($hWnd)) { return $true }

  $length = [WindowCaptureNative]::GetWindowTextLength($hWnd)
  if ($length -le 0) { return $true }

  $builder = New-Object System.Text.StringBuilder ($length + 1)
  [void][WindowCaptureNative]::GetWindowText($hWnd, $builder, $builder.Capacity)
  $title = $builder.ToString().Trim()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }

  $rect = New-Object WindowCaptureNative+RECT
  if (-not [WindowCaptureNative]::GetWindowRect($hWnd, [ref]$rect)) { return $true }
  $isMinimized = [WindowCaptureNative]::IsIconic($hWnd)
  if ($isMinimized) {
    $placement = New-Object WindowCaptureNative+WINDOWPLACEMENT
    $placement.length = [System.Runtime.InteropServices.Marshal]::SizeOf([type][WindowCaptureNative+WINDOWPLACEMENT])
    if ([WindowCaptureNative]::GetWindowPlacement($hWnd, [ref]$placement)) {
      $rect = $placement.rcNormalPosition
    }
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 80 -or $height -lt 60) { return $true }

  [uint32]$processId = 0
  [void][WindowCaptureNative]::GetWindowThreadProcessId($hWnd, [ref]$processId)
  $processName = 'Unknown app'
  try {
    $processName = (Get-Process -Id ([int]$processId) -ErrorAction Stop).ProcessName
  } catch {}

  $items.Add([pscustomobject]@{
    id = $hWnd.ToInt64()
    processId = [int]$processId
    processName = $processName
    title = $title
    minimized = [bool]$isMinimized
    x = $rect.Left
    y = $rect.Top
    width = $width
    height = $height
  }) | Out-Null
  return $true
}, [IntPtr]::Zero) | Out-Null

Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) } | ForEach-Object {
  $handle = $_.MainWindowHandle
  $alreadyListed = $false
  foreach ($item in $items) {
    if ($item.id -eq $handle.ToInt64()) {
      $alreadyListed = $true
      break
    }
  }
  if ($alreadyListed) { return }

  $rect = New-Object WindowCaptureNative+RECT
  if (-not [WindowCaptureNative]::GetWindowRect($handle, [ref]$rect)) { return }
  $isMinimized = [WindowCaptureNative]::IsIconic($handle)
  if ($isMinimized) {
    $placement = New-Object WindowCaptureNative+WINDOWPLACEMENT
    $placement.length = [System.Runtime.InteropServices.Marshal]::SizeOf([type][WindowCaptureNative+WINDOWPLACEMENT])
    if ([WindowCaptureNative]::GetWindowPlacement($handle, [ref]$placement)) {
      $rect = $placement.rcNormalPosition
    }
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 80 -or $height -lt 60) { return }

  $items.Add([pscustomobject]@{
    id = $handle.ToInt64()
    processId = [int]$_.Id
    processName = $_.ProcessName
    title = $_.MainWindowTitle.Trim()
    minimized = [bool]$isMinimized
    x = $rect.Left
    y = $rect.Top
    width = $width
    height = $height
  }) | Out-Null
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
  const windows = items
    .map(cleanWindowInfo)
    .filter((item): item is RawWindowInfo => item !== null)
    .filter((item) => usefulWindowScore(item) > -100)
    .sort((left, right) => usefulWindowScore(right) - usefulWindowScore(left) || left.processName.localeCompare(right.processName) || left.title.localeCompare(right.title));
  return addWindowLabels(windows);
}

export async function listWindows(): Promise<WindowInfo[]> {
  if (process.platform === "win32") {
    return listWindowsWindows();
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

async function captureWindowsWindowPreview(outputPath: string, windowId: number): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class WindowScreenshotNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
}
"@

$path = $env:LEETCODE_SOLVER_SCREENSHOT_PATH
$handle = [IntPtr]::new([int64]$env:LEETCODE_SOLVER_WINDOW_ID)
$rect = New-Object WindowScreenshotNative+RECT
if (-not [WindowScreenshotNative]::GetWindowRect($handle, [ref]$rect)) {
  throw 'Could not read selected window bounds.'
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  throw 'Selected window has invalid bounds.'
}

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $hdc = $graphics.GetHdc()
  try {
    $ok = [WindowScreenshotNative]::PrintWindow($handle, $hdc, 2)
  } finally {
    $graphics.ReleaseHdc($hdc)
  }
  if (-not $ok) {
    throw 'Selected window did not render through Windows window capture.'
  }
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
      LEETCODE_SOLVER_WINDOW_ID: String(windowId),
    },
    3500,
  );
}

async function captureWindowsForegroundWindow(outputPath: string, windowId: number): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class ForegroundWindowCaptureNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr SetActiveWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr SetFocus(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@

$path = $env:LEETCODE_SOLVER_SCREENSHOT_PATH
$handle = [IntPtr]::new([int64]$env:LEETCODE_SOLVER_WINDOW_ID)
$previous = [ForegroundWindowCaptureNative]::GetForegroundWindow()
$wasMinimized = [ForegroundWindowCaptureNative]::IsIconic($handle)
$originalRect = New-Object ForegroundWindowCaptureNative+RECT

[void][ForegroundWindowCaptureNative]::ShowWindow($handle, 9)
Start-Sleep -Milliseconds 150
[void][ForegroundWindowCaptureNative]::GetWindowRect($handle, [ref]$originalRect)
[void][ForegroundWindowCaptureNative]::ShowWindow($handle, 3)
$targetPid = [uint32]0
$targetThread = [ForegroundWindowCaptureNative]::GetWindowThreadProcessId($handle, [ref]$targetPid)
$currentThread = [ForegroundWindowCaptureNative]::GetCurrentThreadId()
$attached = $false
try {
  if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
    $attached = [ForegroundWindowCaptureNative]::AttachThreadInput($currentThread, $targetThread, $true)
  }
  [void][ForegroundWindowCaptureNative]::BringWindowToTop($handle)
  [void][ForegroundWindowCaptureNative]::SetActiveWindow($handle)
  [void][ForegroundWindowCaptureNative]::SetFocus($handle)
  [void][ForegroundWindowCaptureNative]::SetForegroundWindow($handle)
  $HWND_TOPMOST = [IntPtr]::new(-1)
  $HWND_NOTOPMOST = [IntPtr]::new(-2)
  $SWP_NOMOVE = 0x0002
  $SWP_NOSIZE = 0x0001
  $SWP_SHOWWINDOW = 0x0040
  [void][ForegroundWindowCaptureNative]::SetWindowPos($handle, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW)
  [void][ForegroundWindowCaptureNative]::SetWindowPos($handle, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW)
  [void][ForegroundWindowCaptureNative]::SetWindowPos($handle, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW)
  [void][ForegroundWindowCaptureNative]::SetWindowPos($handle, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW)
} finally {
  if ($attached) {
    [void][ForegroundWindowCaptureNative]::AttachThreadInput($currentThread, $targetThread, $false)
  }
}
Start-Sleep -Milliseconds 1500

$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bounds = New-Object System.Drawing.Rectangle $virtual.Left, $virtual.Top, $virtual.Width, $virtual.Height
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
  if ($wasMinimized) {
    [void][ForegroundWindowCaptureNative]::ShowWindow($handle, 6)
  } elseif (($originalRect.Right - $originalRect.Left) -gt 0 -and ($originalRect.Bottom - $originalRect.Top) -gt 0) {
    [void][ForegroundWindowCaptureNative]::SetWindowPos(
      $handle,
      [IntPtr]::new(-2),
      $originalRect.Left,
      $originalRect.Top,
      $originalRect.Right - $originalRect.Left,
      $originalRect.Bottom - $originalRect.Top,
      0x0040
    )
  }
  if ($previous -ne [IntPtr]::Zero -and $previous -ne $handle) {
    [void][ForegroundWindowCaptureNative]::SetForegroundWindow($previous)
  }
}
`;

  await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      LEETCODE_SOLVER_SCREENSHOT_PATH: outputPath,
      LEETCODE_SOLVER_WINDOW_ID: String(windowId),
    },
    8000,
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

export async function captureWindow(runDir: string, windowId: number): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("App window capture is currently implemented for Windows.");
  }

  const screenDir = path.join(runDir, "screens");
  await mkdir(screenDir, { recursive: true });
  const outputPath = path.join(screenDir, `window-${timestampSlug()}.png`);
  try {
    await captureWindowsWindowPreview(outputPath, windowId);
    await assertUsableCapture(outputPath);
  } catch {
    await captureWindowsForegroundWindow(outputPath, windowId);
  }
  return outputPath;
}

export async function captureWindowPreview(runDir: string, windowId: number, forceForeground = false): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("App window preview is currently implemented for Windows.");
  }

  const screenDir = path.join(runDir, "screens");
  await mkdir(screenDir, { recursive: true });
  const outputPath = path.join(screenDir, `window-preview-${timestampSlug()}.png`);
  if (forceForeground) {
    await captureWindowsForegroundWindow(outputPath, windowId);
  } else {
    await captureWindowsWindowPreview(outputPath, windowId);
  }
  return outputPath;
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
