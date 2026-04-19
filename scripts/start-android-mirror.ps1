$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$toolsDir = Join-Path $repoRoot "tools"
$scrcpyDir = Get-ChildItem -Path $toolsDir -Directory -Filter "scrcpy-win64-*" -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending |
  Select-Object -First 1

if (-not $scrcpyDir) {
  throw "scrcpy was not found under $toolsDir. Install it first from the official Genymobile release."
}

$adbPath = Join-Path $scrcpyDir.FullName "adb.exe"
$scrcpyPath = Join-Path $scrcpyDir.FullName "scrcpy.exe"

if (-not (Test-Path $adbPath)) {
  throw "adb.exe was not found next to scrcpy.exe."
}

if (-not (Test-Path $scrcpyPath)) {
  throw "scrcpy.exe was not found."
}

& $adbPath start-server | Out-Null
$devicesOutput = & $adbPath devices -l | Out-String
$lines = $devicesOutput -split "`r?`n"
$authorizedDevice = $lines | Where-Object { $_ -match "\bdevice\b" -and $_ -notmatch "^List of devices" } | Select-Object -First 1
$unauthorizedDevice = $lines | Where-Object { $_ -match "\bunauthorized\b" } | Select-Object -First 1

if (-not $authorizedDevice) {
  Write-Host "No authorized Android device was found." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "On the phone:"
  Write-Host "1. Enable Developer Options."
  Write-Host "2. Enable USB debugging."
  Write-Host "3. Plug the phone into this PC over USB."
  Write-Host "4. Accept the 'Allow USB debugging?' prompt."
  if ($unauthorizedDevice) {
    Write-Host ""
    Write-Host "ADB can see the phone, but it is not authorized yet:" -ForegroundColor Yellow
    Write-Host $unauthorizedDevice
  }
  Write-Host ""
  Write-Host "Current adb devices output:"
  Write-Host $devicesOutput
  Read-Host "Press Enter to exit"
  exit 1
}

Write-Host "Starting Android mirror for:"
Write-Host $authorizedDevice
Write-Host ""
Write-Host "Close the scrcpy window to stop mirroring."
& $scrcpyPath --stay-awake --window-title "Android Phone Mirror"
