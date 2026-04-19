@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js first, then try again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency install failed.
    pause
    exit /b 1
  )
)

dir /b "%LOCALAPPDATA%\ms-playwright\chromium-*" >nul 2>nul
if errorlevel 1 (
  echo Installing Playwright browser runtime...
  call npm run browser:install
  if errorlevel 1 (
    echo Playwright browser install failed.
    pause
    exit /b 1
  )
)

echo Starting Job Application Assistant dashboard on http://127.0.0.1:3030 ...
call npm run dashboard

if errorlevel 1 (
  echo Dashboard exited with an error.
  pause
  exit /b 1
)
