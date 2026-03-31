$profileDir = Join-Path $PSScriptRoot ".chrome-debug-profile"
$url = "https://www.linkedin.com/login"

New-Item -ItemType Directory -Force $profileDir | Out-Null

$chromeCandidates = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)

$chromePath = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chromePath) {
  throw "Chrome not found in standard locations."
}

Start-Process -FilePath $chromePath -ArgumentList @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$profileDir",
  $url
)
