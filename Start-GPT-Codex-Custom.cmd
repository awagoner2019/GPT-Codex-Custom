@echo off
setlocal
cd /d "%~dp0"
echo Starting GPT + Codex Custom with the optional console launcher...
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Launch-Custom.ps1"
if errorlevel 1 pause
