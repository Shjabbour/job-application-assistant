@echo off
setlocal
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File ".\scripts\start-openclaw-job-assistant.ps1" start-full-autopilot
