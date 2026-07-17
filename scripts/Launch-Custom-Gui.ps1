[CmdletBinding()]
param(
    [int]$LauncherProcessId = 0,
    [switch]$SelfTest,
    [switch]$Diagnostics,
    [switch]$ReplaceExisting,
    [switch]$SkipUpdateCheck
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$LaunchScript = Join-Path $PSScriptRoot "Launch-Custom.ps1"
$LogRoot = Join-Path $ProjectRoot "logs"
$LogPath = Join-Path $LogRoot "launcher.log"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$mutex = $null
$mutexAcquired = $false
$launchOutput = [System.Collections.Generic.List[string]]::new()

function Show-LauncherError {
    param([Parameter(Mandatory)][string]$Message)

    Add-Type -AssemblyName System.Windows.Forms
    $dialogText = @"
GPT + Codex Custom could not start.

$Message

Details were written to:
$LogPath
"@.Trim()
    [System.Windows.Forms.MessageBox]::Show(
        $dialogText,
        "GPT + Codex Custom",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}

try {
    if ($LauncherProcessId -gt 0) {
        $launcherProcess = Get-Process -Id $LauncherProcessId -ErrorAction SilentlyContinue
        if ($null -ne $launcherProcess) {
            $launcherProcess.WaitForExit(5000) | Out-Null
        }
    }

    $mutex = [System.Threading.Mutex]::new($false, "Local\GPTCodexCustom.GuiLaunch.v1")
    try {
        $mutexAcquired = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $mutexAcquired = $true
    }
    if (-not $mutexAcquired) {
        exit 0
    }

    if (-not (Test-Path -LiteralPath $LaunchScript -PathType Leaf)) {
        throw "The maintained launch script is missing: $LaunchScript"
    }

    New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
    $header = "GPT + Codex Custom GUI launch`r`nStarted: $([DateTime]::UtcNow.ToString('o'))`r`n`r`n"
    [System.IO.File]::WriteAllText($LogPath, $header, $utf8NoBom)

    $launchArguments = @{}
    if ($SelfTest) { $launchArguments.SelfTest = $true }
    if ($Diagnostics) { $launchArguments.Diagnostics = $true }
    if ($ReplaceExisting) { $launchArguments.ReplaceExisting = $true }
    if ($SkipUpdateCheck) { $launchArguments.SkipUpdateCheck = $true }

    & $LaunchScript @launchArguments *>&1 | ForEach-Object {
        $launchOutput.Add(($_ | Out-String -Width 240).TrimEnd())
    }
    if ($launchOutput.Count -gt 0) {
        [System.IO.File]::AppendAllText(
            $LogPath,
            ($launchOutput -join "`r`n") + "`r`n",
            $utf8NoBom
        )
        $launchOutput.Clear()
    }
} catch {
    $failureText = ($_ | Format-List * -Force | Out-String).Trim()
    try {
        New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
        if ($launchOutput.Count -gt 0) {
            [System.IO.File]::AppendAllText(
                $LogPath,
                ($launchOutput -join "`r`n") + "`r`n",
                $utf8NoBom
            )
            $launchOutput.Clear()
        }
        [System.IO.File]::AppendAllText(
            $LogPath,
            "`r`nFAILED: $([DateTime]::UtcNow.ToString('o'))`r`n$failureText`r`n",
            $utf8NoBom
        )
    } catch {
        # The native dialog still reports the launch failure if logging itself fails.
    }
    Show-LauncherError -Message $_.Exception.Message
    exit 1
} finally {
    if ($mutexAcquired -and $null -ne $mutex) {
        try { $mutex.ReleaseMutex() } catch { }
    }
    if ($null -ne $mutex) {
        $mutex.Dispose()
    }
}
