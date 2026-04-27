@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js first, then try again.
  pause
  exit /b 1
)

if not exist "leetcode-screen-solver\node_modules" (
  echo Installing Interview Coder dependencies...
  call npm run interview:install
  if errorlevel 1 (
    echo Dependency install failed.
    pause
    exit /b 1
  )
)

echo Starting Interview Assistant on http://127.0.0.1:4378 ...
call npm run interview:watch:ui

if errorlevel 1 (
  echo Interview Assistant exited with an error.
  pause
  exit /b 1
)
