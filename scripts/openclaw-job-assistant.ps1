[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Action = "help",

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$debugChromeScript = Join-Path $repoRoot "start-debug-chrome.ps1"

function Invoke-External {
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

function Show-Help {
  Write-Output "OpenClaw Job Application Assistant wrapper"
  Write-Output ""
  Write-Output "Usage:"
  Write-Output "  powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 setup"
  Write-Output "  powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 start-debug-chrome"
  Write-Output "  powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 dashboard"
  Write-Output "  powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 dashboard-public"
  Write-Output "  powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 save-remote-jobs"
  Write-Output "  powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 apply-saved-jobs"
  Write-Output "  powershell -ExecutionPolicy Bypass -File .\scripts\openclaw-job-assistant.ps1 apply-job-url <url>"
  Write-Output ""
  Write-Output "Any unrecognized action is forwarded to:"
  Write-Output "  npm run cli -- browser <action> [args]"
}

Push-Location $repoRoot
try {
  switch ($Action) {
    "help" {
      Show-Help
    }
    "setup" {
      Invoke-External -FilePath "npm" -Args @("install")
      Invoke-External -FilePath "npm" -Args @("run", "browser:install")
    }
    "dashboard" {
      Invoke-External -FilePath "npm" -Args (@("run", "cli", "--", "dashboard") + $Arguments)
    }
    "dashboard-public" {
      Invoke-External -FilePath "npm" -Args (@("run", "cli", "--", "dashboard", "--public") + $Arguments)
    }
    "start-debug-chrome" {
      Invoke-External -FilePath "powershell" -Args (@("-ExecutionPolicy", "Bypass", "-File", $debugChromeScript) + $Arguments)
    }
    default {
      Invoke-External -FilePath "npm" -Args (@("run", "cli", "--", "browser", $Action) + $Arguments)
    }
  }
}
finally {
  Pop-Location
}
