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

Write-Host "Android wireless pairing"
Write-Host ""
Write-Host "On the phone:"
Write-Host "1. Open Settings > Developer options > Wireless debugging."
Write-Host "2. Turn Wireless debugging on."
Write-Host "3. Tap 'Pair device with pairing code'."
Write-Host "4. Enter the pairing IP:port and code below."
Write-Host ""

$pairAddress = Read-Host "Pairing IP:port"
$pairCode = Read-Host "Pairing code"

if (-not $pairAddress.Trim() -or -not $pairCode.Trim()) {
  throw "Pairing IP:port and code are required."
}

& $adbPath pair $pairAddress.Trim() $pairCode.Trim()

Write-Host ""
Write-Host "Now go back to the Wireless debugging main screen."
Write-Host "Enter the normal IP:port shown under 'IP address & Port'. This is usually different from the pairing port."
$connectAddress = Read-Host "Connect IP:port"

if (-not $connectAddress.Trim()) {
  throw "Connect IP:port is required."
}

& $adbPath connect $connectAddress.Trim()
& $adbPath devices -l

Write-Host ""
$startMirror = Read-Host "Start Android mirror now? [Y/n]"
if ($startMirror -notmatch "^(n|no)$") {
  & (Join-Path $PSScriptRoot "start-android-mirror.ps1")
}
