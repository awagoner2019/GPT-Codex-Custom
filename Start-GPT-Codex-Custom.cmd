@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Launch-Custom.ps1"
if errorlevel 1 pause
