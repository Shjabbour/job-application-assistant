[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

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
        NodePath = $currentNode.Source
        NpmPath = if ($currentNpm) { $currentNpm.Source } else { "npm" }
      }
    }
  }

  if ($env:NVM_HOME -and (Test-Path $env:NVM_HOME)) {
    return Get-ChildItem $env:NVM_HOME -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "^v\d+\.\d+\.\d+$" } |
      Sort-Object { [version]$_.Name.TrimStart("v") } -Descending |
      ForEach-Object {
        $nodePath = Join-Path $_.FullName "node.exe"
        $npmPath = Join-Path $_.FullName "npm.cmd"
        if ((Test-Path $nodePath) -and (Test-Path $npmPath)) {
          $versionText = (& $nodePath --version).Trim()
          if ($LASTEXITCODE -eq 0 -and (Test-CompatibleNodeVersion -VersionText $versionText)) {
            [pscustomobject]@{
              NodePath = $nodePath
              NpmPath = $npmPath
            }
          }
        }
      } |
      Select-Object -First 1
  }

  return $null
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

$compatibleNode = Get-CompatibleNodeInstall
if (-not $compatibleNode) {
  Write-Output "No compatible Node 22.14+ runtime was found for OpenClaw."
  Write-Output "Run `npm run openclaw:bootstrap` after installing Node 22.14+ or enabling it through nvm."
  exit 1
}

$modulePath = Get-OpenClawModulePath -CompatibleNode $compatibleNode
if (-not $modulePath) {
  Write-Output "OpenClaw is not installed for this repo runner."
  Write-Output "Run `npm run openclaw:bootstrap` first."
  exit 1
}

& $compatibleNode.NodePath $modulePath @Arguments
exit $LASTEXITCODE
