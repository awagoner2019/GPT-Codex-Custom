[CmdletBinding()]
param(
    [switch]$Remove,
    [switch]$PassThru
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$LauncherExecutable = Join-Path $ProjectRoot "GPT-Codex-Custom.exe"
$ProgramsDirectory = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$ShortcutPath = Join-Path $ProgramsDirectory "GPT + Codex Custom.lnk"

if ($Remove) {
    if (Test-Path -LiteralPath $ShortcutPath -PathType Leaf) {
        Remove-Item -LiteralPath $ShortcutPath -Force
    }
    if ($PassThru) { $ShortcutPath }
    exit 0
}

if (-not (Test-Path -LiteralPath $LauncherExecutable -PathType Leaf)) {
    throw "The native launcher is missing. Run npm run build:launcher first: $LauncherExecutable"
}
New-Item -ItemType Directory -Force -Path $ProgramsDirectory | Out-Null
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $LauncherExecutable
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.Description = "Launch the isolated GPT + Codex Custom desktop app"
$shortcut.IconLocation = "$LauncherExecutable,0"
$shortcut.Save()

if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
    throw "Windows did not create the GPT + Codex Custom Start Menu shortcut."
}
if ($PassThru) {
    $ShortcutPath
} else {
    Write-Host "Start Menu shortcut installed: $ShortcutPath" -ForegroundColor Green
}
