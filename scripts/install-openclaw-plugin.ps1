[CmdletBinding()]
param(
  [ValidateSet("help", "print-path", "link", "install", "bootstrap")]
  [string]$Mode = "help"
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginPath = Join-Path $repoRoot "plugins\job-application-assistant-openclaw"
$manifestPath = Join-Path $pluginPath ".codex-plugin\plugin.json"
$pluginId = "job-application-assistant-openclaw"

function Test-CompatibleNodeVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$VersionText
  )

  $normalized = $VersionText.Trim()
  if ($normalized.StartsWith("v")) {
    $normalized = $normalized.Substring(1)
  }

  try {
    return ([version]$normalized) -ge ([version]"22.14.0")
  } catch {
    return $false
  }
}

function Get-CompatibleNodeInstall {
  $currentNode = Get-Command node -ErrorAction SilentlyContinue
  if ($currentNode) {
    $currentVersion = (& $currentNode.Source --version).Trim()
    if ($LASTEXITCODE -eq 0 -and (Test-CompatibleNodeVersion -VersionText $currentVersion)) {
      $currentNpm = Get-Command npm -ErrorAction SilentlyContinue
      return [pscustomobject]@{
        Source = "path"
        Version = $currentVersion
        NodePath = $currentNode.Source
        NpmPath = if ($currentNpm) { $currentNpm.Source } else { "npm" }
      }
    }
  }

  if ($env:NVM_HOME -and (Test-Path $env:NVM_HOME)) {
    $candidate = Get-ChildItem $env:NVM_HOME -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "^v\d+\.\d+\.\d+$" } |
      Sort-Object { [version]$_.Name.TrimStart("v") } -Descending |
      ForEach-Object {
        $nodePath = Join-Path $_.FullName "node.exe"
        $npmPath = Join-Path $_.FullName "npm.cmd"
        if ((Test-Path $nodePath) -and (Test-Path $npmPath)) {
          $versionText = (& $nodePath --version).Trim()
          if ($LASTEXITCODE -eq 0 -and (Test-CompatibleNodeVersion -VersionText $versionText)) {
            [pscustomobject]@{
              Source = "nvm"
              Version = $versionText
              NodePath = $nodePath
              NpmPath = $npmPath
            }
          }
        }
      } |
      Select-Object -First 1

    if ($candidate) {
      return $candidate
    }
  }

  return $null
}

function Assert-ManifestExists {
  if (-not (Test-Path $manifestPath)) {
    Write-Output "OpenClaw plugin manifest not found at $manifestPath"
    exit 1
  }
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $segments = @($machinePath, $userPath) | Where-Object { $_ }
  if ($segments.Count -gt 0) {
    $env:Path = ($segments -join ";")
  }
}

function Install-OpenClaw {
  $compatibleNode = Get-CompatibleNodeInstall
  if ($compatibleNode) {
    Write-Output "Installing OpenClaw with npm using Node $($compatibleNode.Version) from $($compatibleNode.Source)."
    & $compatibleNode.NpmPath "install" "-g" "openclaw@latest"
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
    Refresh-ProcessPath
    return
  }

  Write-Output "No compatible Node 22.14+ runtime is active. Falling back to the official Windows installer."
  $tempScript = Join-Path ([System.IO.Path]::GetTempPath()) "openclaw-install.ps1"
  try {
    Invoke-WebRequest -UseBasicParsing "https://openclaw.ai/install.ps1" -OutFile $tempScript
    & powershell -ExecutionPolicy Bypass -File $tempScript -NoOnboard
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  } finally {
    Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
  }
  Refresh-ProcessPath
}

function Get-OpenClawModulePath {
  param(
    [Parameter(Mandatory = $true)]
    [pscustomobject]$CompatibleNode
  )

  $prefix = (& $CompatibleNode.NpmPath "prefix" "-g").Trim()
  if ($LASTEXITCODE -ne 0 -or -not $prefix) {
    return $null
  }

  $modulePath = Join-Path $prefix "node_modules\openclaw\openclaw.mjs"
  if (Test-Path $modulePath) {
    return $modulePath
  }

  return $null
}

function Invoke-OpenClaw {
  param(
    [Parameter(Mandatory = $true)]
    [pscustomobject]$Runner,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,

    [switch]$SilenceOutput
  )

  if ($Runner.Type -eq "command") {
    if ($SilenceOutput) {
      & $Runner.CommandPath @Arguments *> $null
    } else {
      & $Runner.CommandPath @Arguments
    }
  } else {
    if ($SilenceOutput) {
      & $Runner.NodePath $Runner.ScriptPath @Arguments *> $null
    } else {
      & $Runner.NodePath $Runner.ScriptPath @Arguments
    }
  }

  return $LASTEXITCODE
}

function Get-OpenClawCommand {
  param(
    [switch]$InstallIfMissing
  )

  $command = Get-Command openclaw -ErrorAction SilentlyContinue
  if ($command) {
    & $command.Source "--version" *> $null
    if ($LASTEXITCODE -eq 0) {
      return [pscustomobject]@{
        Type = "command"
        CommandPath = $command.Source
      }
    }
  }

  $compatibleNode = Get-CompatibleNodeInstall
  if ($compatibleNode) {
    $modulePath = Get-OpenClawModulePath -CompatibleNode $compatibleNode
    if ($modulePath) {
      & $compatibleNode.NodePath $modulePath "--version" *> $null
      if ($LASTEXITCODE -eq 0) {
        return [pscustomobject]@{
          Type = "node"
          NodePath = $compatibleNode.NodePath
          ScriptPath = $modulePath
        }
      }
    }
  }

  if ($InstallIfMissing) {
    Install-OpenClaw
    return Get-OpenClawCommand
  }

  if (-not $command) {
    Write-Output "OpenClaw is not installed or not on PATH. Install OpenClaw first, then rerun this script."
  } else {
    Write-Output "OpenClaw is installed but cannot start with the current Node runtime. Install or activate Node 22.14+ and rerun this script."
  }
  exit 1
}

function Install-Or-LinkPlugin {
  param(
    [Parameter(Mandatory = $true)]
    [pscustomobject]$OpenClaw,

    [Parameter(Mandatory = $true)]
    [ValidateSet("link", "install")]
    [string]$InstallMode
  )

  $inspectExit = Invoke-OpenClaw -Runner $OpenClaw -Arguments @("plugins", "inspect", $pluginId, "--json") -SilenceOutput
  if ($inspectExit -eq 0) {
    Write-Output "OpenClaw plugin already present: $pluginId"
  } else {
    $args = @("plugins", "install")
    if ($InstallMode -eq "link") {
      $args += "-l"
    }
    $args += $pluginPath
    $installExit = Invoke-OpenClaw -Runner $OpenClaw -Arguments $args
    if ($installExit -ne 0) {
      exit $installExit
    }
  }

  $enableExit = Invoke-OpenClaw -Runner $OpenClaw -Arguments @("plugins", "enable", $pluginId) -SilenceOutput
  if ($enableExit -eq 0) {
    Write-Output "OpenClaw plugin enabled: $pluginId"
  }
}

switch ($Mode) {
  "help" {
    Write-Output "OpenClaw plugin helper"
    Write-Output "Plugin path: $pluginPath"
    Write-Output ""
    Write-Output "Usage:"
    Write-Output "  powershell -ExecutionPolicy Bypass -File .\scripts\install-openclaw-plugin.ps1 -Mode bootstrap"
    Write-Output "  powershell -ExecutionPolicy Bypass -File .\scripts\install-openclaw-plugin.ps1 -Mode link"
    Write-Output "  powershell -ExecutionPolicy Bypass -File .\scripts\install-openclaw-plugin.ps1 -Mode install"
    Write-Output "  powershell -ExecutionPolicy Bypass -File .\scripts\install-openclaw-plugin.ps1 -Mode print-path"
    exit 0
  }
  "print-path" {
    Assert-ManifestExists
    Write-Output $pluginPath
    exit 0
  }
  default {
    Assert-ManifestExists
    $resolvedMode = if ($Mode -eq "bootstrap") { "link" } else { $Mode }
    $openclaw = Get-OpenClawCommand -InstallIfMissing:($Mode -eq "bootstrap")
    Install-Or-LinkPlugin -OpenClaw $openclaw -InstallMode $resolvedMode
    $versionExit = Invoke-OpenClaw -Runner $openclaw -Arguments @("--version")
    exit $versionExit
  }
}
