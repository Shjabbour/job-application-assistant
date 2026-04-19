[CmdletBinding()]
param(
  [ValidateSet("start", "prepare", "start-save-remote-jobs", "start-full-autopilot")]
  [string]$Mode = "start",

  [switch]$PublicDashboard,
  [switch]$SkipChrome,
  [switch]$SkipDashboard
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$installScript = Join-Path $PSScriptRoot "install-openclaw-plugin.ps1"
$debugChromeScript = Join-Path $repoRoot "start-debug-chrome.ps1"

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter()]
    [string[]]$Args = @()
  )

  & $FilePath @Args
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

function Test-ListeningPort {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  try {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1
    return [bool]$listener
  } catch {
    return $false
  }
}

function Wait-ForListeningPort {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,

    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-ListeningPort -Port $Port) {
      return $true
    }
    Start-Sleep -Seconds 1
  }

  return (Test-ListeningPort -Port $Port)
}

function Ensure-RepoDependencies {
  if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
    Write-Output "Installing project dependencies..."
    Invoke-Step -FilePath "npm" -Args @("install")
  }
}

function Ensure-PlaywrightRuntime {
  $playwrightRoot = Join-Path $env:LOCALAPPDATA "ms-playwright"
  $chromiumInstalled = Test-Path (Join-Path $playwrightRoot "chromium-*")
  if (-not $chromiumInstalled) {
    Write-Output "Installing Playwright browser runtime..."
    Invoke-Step -FilePath "npm" -Args @("run", "browser:install")
  }
}

function Start-DashboardProcess {
  if (Test-ListeningPort -Port 3030) {
    Write-Output "Dashboard already listening on http://127.0.0.1:3030"
    return
  }

  $npmCommand = if ($PublicDashboard) { "npm run dev" } else { "npm run dashboard" }
  $windowTitle = if ($PublicDashboard) { "OpenClaw Job Assistant Public Dashboard" } else { "OpenClaw Job Assistant Dashboard" }
  $command = "Set-Location -LiteralPath '$repoRoot'; $npmCommand"
  Start-Process -FilePath "powershell" -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $command) -WindowStyle Normal | Out-Null
  Write-Output "$windowTitle launched."
}

function Start-DebugChromeProcess {
  if (Test-ListeningPort -Port 9222) {
    Write-Output "Attached Chrome already listening on http://127.0.0.1:9222"
    return $true
  }

  Start-Process -FilePath "powershell" -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", $debugChromeScript) -WindowStyle Normal | Out-Null
  Write-Output "Attached Chrome launch requested."
  return (Wait-ForListeningPort -Port 9222 -TimeoutSeconds 15)
}

function Start-SaveRemoteJobsFlow {
  if (-not $env:JAA_BATCH_LIMIT) {
    $env:JAA_BATCH_LIMIT = "40"
  }
  if (-not $env:JAA_PAGE_LIMIT) {
    $env:JAA_PAGE_LIMIT = "3"
  }

  Write-Output "Starting LinkedIn Remote Jobs save flow..."
  Write-Output "Using JAA_BATCH_LIMIT=$($env:JAA_BATCH_LIMIT) and JAA_PAGE_LIMIT=$($env:JAA_PAGE_LIMIT)"
  Invoke-Step -FilePath "npm" -Args @("run", "openclaw:job-assistant", "--", "save-remote-jobs")
}

function Start-FullAutopilotFlow {
  Start-SaveRemoteJobsFlow
  Write-Output "Starting saved-job apply flow..."
  Invoke-Step -FilePath "npm" -Args @("run", "openclaw:job-assistant", "--", "apply-saved-jobs")
}

Push-Location $repoRoot
try {
  Write-Output "Bootstrapping OpenClaw for this repo..."
  Invoke-Step -FilePath "powershell" -Args @("-ExecutionPolicy", "Bypass", "-File", $installScript, "-Mode", "bootstrap")

  Write-Output "Preparing project runtime..."
  Ensure-RepoDependencies
  Ensure-PlaywrightRuntime

  if ($Mode -eq "prepare") {
    Write-Output "Preparation complete."
    exit 0
  }

  if (-not $SkipDashboard) {
    Start-DashboardProcess
  }

  $chromeReady = $false
  if (-not $SkipChrome) {
    $chromeReady = Start-DebugChromeProcess
  }

  if ($Mode -eq "start-save-remote-jobs") {
    if (-not $chromeReady -and -not (Test-ListeningPort -Port 9222)) {
      Write-Output "Attached Chrome did not report ready on port 9222 yet. The save flow will still be attempted."
    }
    Start-SaveRemoteJobsFlow
  }

  if ($Mode -eq "start-full-autopilot") {
    if (-not $chromeReady -and -not (Test-ListeningPort -Port 9222)) {
      Write-Output "Attached Chrome did not report ready on port 9222 yet. The full autopilot will still be attempted."
    }
    Start-FullAutopilotFlow
  }

  Write-Output "Automatic OpenClaw repo startup complete."
  Write-Output "Next commands:"
  if ($Mode -notin @("start-save-remote-jobs", "start-full-autopilot")) {
    Write-Output "  npm run openclaw:job-assistant -- save-remote-jobs"
  }
  Write-Output "  npm run openclaw:job-assistant -- apply-saved-jobs"
}
finally {
  Pop-Location
}
