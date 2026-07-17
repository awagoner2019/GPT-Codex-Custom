@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title GPT + Codex Custom Setup

set "CHECK_ONLY=0"
if /I "%~1"=="--check" set "CHECK_ONLY=1"

call :check_prerequisites
if errorlevel 1 goto :failure

if "%CHECK_ONLY%"=="1" (
    echo Installer prerequisite check passed.
    exit /b 0
)

echo.
echo GPT + Codex Custom Setup
echo ========================
echo This setup never edits the official ChatGPT installation.
echo.

if exist "work\runtime\ChatGPT.exe" (
    echo This copy is already initialized.
    if not exist "GPT-Codex-Custom.exe" (
        echo Building the native Windows launcher...
        call npm run build:launcher
        if errorlevel 1 goto :failure
    )
    powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Install-LauncherShortcut.ps1"
    choice /C YN /N /M "Launch it now? [Y/N] "
    if errorlevel 2 exit /b 0
    start "" ".\GPT-Codex-Custom.exe"
    if errorlevel 1 goto :failure
    exit /b 0
)

if not exist "node_modules\@electron\asar\bin\asar.js" (
    echo Installing the pinned build dependency...
    call npm ci
    if errorlevel 1 goto :failure
)

echo Starting verified setup...
echo If the official ChatGPT package is missing, Microsoft's signed installer will open.
call npm run setup
if errorlevel 1 goto :failure

echo.
echo Setup and verification completed successfully.
choice /C YN /N /M "Launch GPT + Codex Custom now? [Y/N] "
if errorlevel 2 exit /b 0
start "" ".\GPT-Codex-Custom.exe"
if errorlevel 1 goto :failure
exit /b 0

:check_prerequisites
if not exist "package.json" (
    echo ERROR: package.json is missing. Extract the complete release before running setup.
    exit /b 1
)
if not exist "scripts\Initialize-Custom.ps1" (
    echo ERROR: setup scripts are missing. Extract the complete release before running setup.
    exit /b 1
)
if not exist "scripts\Ensure-OfficialPackage.ps1" (
    echo ERROR: official installer verification is missing. Extract the complete release before running setup.
    exit /b 1
)
if not exist "scripts\Build-Launcher.ps1" (
    echo ERROR: native launcher build script is missing. Extract the complete release before running setup.
    exit /b 1
)
where node.exe >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js 20 or newer is required. Install it from https://nodejs.org/ and retry.
    exit /b 1
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo ERROR: npm is required. Repair the Node.js installation and retry.
    exit /b 1
)
set "NODE_MAJOR="
for /f "usebackq delims=" %%V in (`node -p "parseInt(process.versions.node.split('.')[0], 10)"`) do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
    echo ERROR: Unable to determine the installed Node.js version.
    exit /b 1
)
if !NODE_MAJOR! LSS 20 (
    echo ERROR: Node.js 20 or newer is required. Found major version !NODE_MAJOR!.
    exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Build-Launcher.ps1" -CheckOnly
if errorlevel 1 (
    echo ERROR: The native Windows launcher prerequisites are unavailable.
    exit /b 1
)
exit /b 0

:failure
echo.
echo Setup did not complete. Nothing in the official ChatGPT installation was modified.
echo See docs\INSTALLATION.md for recovery steps.
if "%CHECK_ONLY%"=="1" exit /b 1
pause
exit /b 1
