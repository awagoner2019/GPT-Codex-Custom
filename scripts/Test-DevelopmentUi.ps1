<#
.SYNOPSIS
Runs the complete non-destructive GPT + Codex Custom UI verification sequence.

.DESCRIPTION
Runs the strict renderer self-test, launches the isolated diagnostics renderer,
checks its read-only UI contract and account-backed Chat bridges, exercises the
model-picker and token-dock verifiers, and restores a normal non-diagnostic
custom runtime even when a check fails.

.PARAMETER SkipSelfTest
Skips creation of fresh strict self-test evidence. Use only when the current
runtime ASAR already has a passing self-test result.
#>
[CmdletBinding()]
param(
    [switch]$SkipSelfTest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$LaunchScript = Join-Path $PSScriptRoot "Launch-Custom.ps1"
$StaticVerifier = Join-Path $PSScriptRoot "Verify-Custom.ps1"
$InteractiveVerifier = Join-Path $PSScriptRoot "Verify-Custom-Interactive.ps1"
$DiagnosticChatPreparation = Join-Path $PSScriptRoot "Prepare-DiagnosticChat.mjs"
$MotionVerifier = Join-Path $PSScriptRoot "Verify-Model-Picker-Motion.mjs"
$TokenDockVerifier = Join-Path $PSScriptRoot "Verify-Token-Hud-Dock.mjs"
$PowerShellExecutable = (Get-Command powershell.exe -ErrorAction Stop).Source
$NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source

foreach ($requiredPath in @(
    $LaunchScript,
    $StaticVerifier,
    $InteractiveVerifier,
    $DiagnosticChatPreparation,
    $MotionVerifier,
    $TokenDockVerifier
)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required development verifier is missing: $requiredPath"
    }
}

function Invoke-VerificationStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$Executable,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    Write-Host ""
    Write-Host "=== $Name ===" -ForegroundColor Cyan
    & $Executable @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "$Name failed with exit code $exitCode."
    }
}

$verificationFailure = $null
try {
    if (-not $SkipSelfTest) {
        Invoke-VerificationStep -Name "Strict renderer self-test" `
            -Executable $PowerShellExecutable `
            -Arguments @(
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $LaunchScript,
                "-SelfTest", "-ReplaceExisting", "-SkipUpdateCheck"
            )
    }

    Invoke-VerificationStep -Name "Isolated diagnostics launch" `
        -Executable $PowerShellExecutable `
        -Arguments @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $LaunchScript,
            "-Diagnostics", "-ReplaceExisting", "-SkipUpdateCheck"
        )

    Invoke-VerificationStep -Name "Transient Chat-mode preparation" `
        -Executable $NodeExecutable -Arguments @($DiagnosticChatPreparation)

    Invoke-VerificationStep -Name "Read-only interactive contract" `
        -Executable $PowerShellExecutable `
        -Arguments @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $InteractiveVerifier,
            "-OutputFormat", "Table"
        )

    Invoke-VerificationStep -Name "Account-backed Chat action contract" `
        -Executable $PowerShellExecutable `
        -Arguments @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $StaticVerifier,
            "-RequireRunning", "-RequireChatReady", "-RequireChatActions"
        )

    Invoke-VerificationStep -Name "Model-picker motion" `
        -Executable $NodeExecutable -Arguments @($MotionVerifier)

    Invoke-VerificationStep -Name "Token-dock behavior" `
        -Executable $NodeExecutable -Arguments @($TokenDockVerifier)

    Write-Host ""
    Write-Host "Development UI verification passed." -ForegroundColor Green
} catch {
    $verificationFailure = $_
} finally {
    try {
        Invoke-VerificationStep -Name "Restore normal custom runtime" `
            -Executable $PowerShellExecutable `
            -Arguments @(
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $LaunchScript,
                "-ReplaceExisting", "-SkipUpdateCheck"
            )
    } catch {
        if ($null -eq $verificationFailure) {
            $verificationFailure = $_
        } else {
            Write-Warning "Verification failed and the normal custom runtime could not be restored: $($_.Exception.Message)"
        }
    }
}

if ($null -ne $verificationFailure) {
    throw $verificationFailure
}

Write-Host "All selected UI gates passed and diagnostics were disabled." -ForegroundColor Green
