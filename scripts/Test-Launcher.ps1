[CmdletBinding()]
param(
    [switch]$PassThru
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$LauncherExecutable = Join-Path $ProjectRoot "GPT-Codex-Custom.exe"
$LauncherSource = Join-Path $PSScriptRoot "launcher\GPTCodexCustomLauncher.cs"
$GuiLaunchScript = Join-Path $PSScriptRoot "Launch-Custom-Gui.ps1"
$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("GPTCodexCustom-launcher-test-" + [Guid]::NewGuid().ToString("N"))
$ProbePath = Join-Path $TestRoot "launcher-probe.json"

function Assert-TestPath {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\") + "\"
    if (-not $fullPath.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetFileName($TestRoot) -notlike "GPTCodexCustom-launcher-test-*") {
        throw "Refusing to modify a launcher-test path outside the temporary test root: $fullPath"
    }
}

function Get-PortableExecutableSubsystem {
    param([Parameter(Mandatory)][string]$Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
        throw "The launcher is not a valid Windows PE executable."
    }
    $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3C)
    if ($peOffset -lt 0 -or $peOffset + 96 -gt $bytes.Length -or
        $bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or
        $bytes[$peOffset + 2] -ne 0 -or $bytes[$peOffset + 3] -ne 0) {
        throw "The launcher PE header is invalid."
    }
    $optionalHeaderOffset = $peOffset + 24
    $magic = [System.BitConverter]::ToUInt16($bytes, $optionalHeaderOffset)
    if ($magic -ne 0x10B -and $magic -ne 0x20B) {
        throw "The launcher has an unsupported PE optional-header format."
    }
    return [System.BitConverter]::ToUInt16($bytes, $optionalHeaderOffset + 68)
}

foreach ($requiredPath in @($LauncherExecutable, $LauncherSource, $GuiLaunchScript)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required launcher verification input is missing: $requiredPath"
    }
}

Assert-TestPath $TestRoot
try {
    New-Item -ItemType Directory -Force -Path $TestRoot | Out-Null
    $probeArgument = '--launcher-probe "{0}"' -f $ProbePath.Replace('"', '\"')
    $probeProcess = Start-Process `
        -FilePath $LauncherExecutable `
        -ArgumentList $probeArgument `
        -WorkingDirectory $ProjectRoot `
        -Wait `
        -PassThru
    if ($probeProcess.ExitCode -ne 0) {
        throw "The native launcher probe exited with code $($probeProcess.ExitCode)."
    }
    if (-not (Test-Path -LiteralPath $ProbePath -PathType Leaf)) {
        throw "The native launcher did not write its non-launching contract probe."
    }

    $probe = Get-Content -Raw -LiteralPath $ProbePath | ConvertFrom-Json
    $launcherSourceText = Get-Content -Raw -LiteralPath $LauncherSource
    $guiLaunchText = Get-Content -Raw -LiteralPath $GuiLaunchScript
    $expectedRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd("\")
    $observedRoot = [System.IO.Path]::GetFullPath([string]$probe.baseDirectory).TrimEnd("\")
    $results = [ordered]@{
        executablePresent = (Test-Path -LiteralPath $LauncherExecutable -PathType Leaf)
        windowsGuiSubsystem = ((Get-PortableExecutableSubsystem -Path $LauncherExecutable) -eq 2)
        nativeWinExeContract = ([string]$probe.launcherKind -eq "native-winexe")
        projectRootResolved = ($observedRoot -eq $expectedRoot)
        defaultConsoleFree = ($probe.defaultConsoleVisible -eq $false -and [string]$probe.defaultScript -like "*Launch-Custom-Gui.ps1")
        consoleFallbackExplicit = ([string]$probe.consoleOptInArgument -eq "--console" -and [string]$probe.consoleScript -like "*Launch-Custom.ps1")
        noCmdInDefaultLauncher = (-not $launcherSourceText.Contains("cmd.exe") -and $launcherSourceText.Contains("CreateNoWindow = !options.ConsoleVisible"))
        parentExitUpdateHandshake = ($launcherSourceText.Contains("-LauncherProcessId") -and $guiLaunchText.Contains("WaitForExit(5000)"))
        nativeFailureDialog = ($guiLaunchText.Contains("System.Windows.Forms.MessageBox") -and $guiLaunchText.Contains("launcher.log"))
        probeDidNotLaunchRuntime = ([string]$probe.runtimeExecutable -like "*work\runtime\ChatGPT.exe")
    }
    $failed = @($results.GetEnumerator() | Where-Object { -not [bool]$_.Value })
    if ($failed.Count -gt 0) {
        throw "Native launcher verification failed: $($failed.Key -join ', ')"
    }

    if ($PassThru) {
        [PSCustomObject]$results
    } else {
        $results.GetEnumerator() | ForEach-Object {
            [PSCustomObject]@{ Check = $_.Key; Passed = $_.Value }
        } | Format-Table -AutoSize
        Write-Host "Native launcher verification passed." -ForegroundColor Green
    }
} finally {
    Assert-TestPath $TestRoot
    if (Test-Path -LiteralPath $TestRoot) {
        Remove-Item -LiteralPath $TestRoot -Recurse -Force
    }
}
