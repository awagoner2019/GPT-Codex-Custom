[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$BootstrapScript = Join-Path $PSScriptRoot "Ensure-OfficialPackage.ps1"
$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    "gpt-codex-custom-bootstrap-test-" + [Guid]::NewGuid().ToString("N")
)
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][bool]$Passed,
        [Parameter(Mandatory = $true)][string]$Detail
    )

    $results.Add([PSCustomObject]@{
        Check = $Name
        Passed = $Passed
        Detail = $Detail
    })
    if (-not $Passed) {
        throw "$Name failed: $Detail"
    }
}

function New-MockPackage {
    [PSCustomObject]@{
        Name = "OpenAI.Codex"
        PackageFullName = "OpenAI.Codex_99.0.0.0_x64__bootstraptest"
        Version = [version]"99.0.0.0"
        InstallLocation = Join-Path $TestRoot "mock-package"
    }
}

function New-MockProcess {
    param(
        [bool]$HasExited,
        [int]$ExitCode
    )

    [PSCustomObject]@{
        HasExited = $HasExited
        ExitCode = $ExitCode
    }
}

function Invoke-ExpectedFailure {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$MessagePattern
    )

    try {
        & $Action | Out-Null
    } catch {
        if ($_.Exception.Message -like $MessagePattern) {
            return $_.Exception.Message
        }
        throw
    }
    throw "Expected failure matching '$MessagePattern', but the action succeeded."
}

New-Item -ItemType Directory -Force -Path $TestRoot | Out-Null
$liveInstallerPath = $null

try {
    $liveVerification = & $BootstrapScript -VerifyDownloadOnly -KeepInstaller
    $liveInstallerPath = [string]$liveVerification.Path
    Add-Result `
        -Name "liveSignedDownload" `
        -Passed (
            $liveVerification.SignatureStatus -ceq "Valid" -and
            $liveVerification.Signer -ceq "Microsoft Corporation" -and
            $liveVerification.ProductId -ceq "9PLM9XGG6VKS" -and
            (Test-Path -LiteralPath $liveInstallerPath -PathType Leaf)
        ) `
        -Detail "The current Microsoft installer downloaded and passed the production signature gate."

    $copyLiveInstaller = {
        param([string]$Uri, [string]$Destination)
        Copy-Item -LiteralPath $liveInstallerPath -Destination $Destination -Force
    }.GetNewClosure()
    $noDelay = { param([int]$Seconds) }.GetNewClosure()

    $existingState = [PSCustomObject]@{
        DownloadCalls = 0
        LaunchCalls = 0
    }
    $existingResolver = { param([string]$Name) New-MockPackage }.GetNewClosure()
    $unexpectedDownload = {
        param([string]$Uri, [string]$Destination)
        $existingState.DownloadCalls++
        throw "Download should not run for an existing package."
    }.GetNewClosure()
    $unexpectedLaunch = {
        param([string]$Executable)
        $existingState.LaunchCalls++
        throw "Launch should not run for an existing package."
    }.GetNewClosure()
    $existingResult = & $BootstrapScript `
        -PackageResolver $existingResolver `
        -DownloadAction $unexpectedDownload `
        -InstallerLauncher $unexpectedLaunch `
        -DelayAction $noDelay
    Add-Result `
        -Name "existingPackageFastPath" `
        -Passed (
            $existingResult.BootstrapUsed -eq $false -and
            $existingState.DownloadCalls -eq 0 -and
            $existingState.LaunchCalls -eq 0
        ) `
        -Detail "An existing official package bypasses download and launch."

    $successState = [PSCustomObject]@{
        Installed = $false
        LaunchCalls = 0
        DelayCalls = 0
        Clock = [DateTime]"2030-01-01T00:00:00Z"
    }
    $successResolver = {
        param([string]$Name)
        if ($successState.Installed) { New-MockPackage }
    }.GetNewClosure()
    $successLauncher = {
        param([string]$Executable)
        $successState.LaunchCalls++
        New-MockProcess -HasExited $true -ExitCode 0
    }.GetNewClosure()
    $successDelay = {
        param([int]$Seconds)
        $successState.DelayCalls++
        $successState.Clock = $successState.Clock.AddSeconds($Seconds)
        $successState.Installed = $true
    }.GetNewClosure()
    $successClock = { $successState.Clock }.GetNewClosure()
    $successResult = & $BootstrapScript `
        -TimeoutMinutes 1 `
        -PackageResolver $successResolver `
        -DownloadAction $copyLiveInstaller `
        -InstallerLauncher $successLauncher `
        -DelayAction $successDelay `
        -UtcNowProvider $successClock
    Add-Result `
        -Name "freshInstallSuccess" `
        -Passed (
            $successResult.BootstrapUsed -eq $true -and
            $successState.LaunchCalls -eq 1 -and
            $successState.DelayCalls -ge 1
        ) `
        -Detail "A missing package downloads, launches once, waits, and resumes after registration."

    $cancelState = [PSCustomObject]@{
        Clock = [DateTime]"2030-01-01T00:00:00Z"
    }
    $missingResolver = { param([string]$Name) @() }.GetNewClosure()
    $cancelLauncher = {
        param([string]$Executable)
        New-MockProcess -HasExited $true -ExitCode 1223
    }.GetNewClosure()
    $cancelDelay = {
        param([int]$Seconds)
        $cancelState.Clock = $cancelState.Clock.AddSeconds(6)
    }.GetNewClosure()
    $cancelClock = { $cancelState.Clock }.GetNewClosure()
    $cancelMessage = Invoke-ExpectedFailure `
        -MessagePattern "The official installer exited with code 1223*" `
        -Action {
            & $BootstrapScript `
                -TimeoutMinutes 1 `
                -PackageResolver $missingResolver `
                -DownloadAction $copyLiveInstaller `
                -InstallerLauncher $cancelLauncher `
                -DelayAction $cancelDelay `
                -UtcNowProvider $cancelClock
        }
    Add-Result `
        -Name "installerCancellation" `
        -Passed ($cancelMessage -like "*code 1223*") `
        -Detail "A cancelled installer receives a grace period and then fails with its exit code."

    $timeoutState = [PSCustomObject]@{
        Clock = [DateTime]"2030-01-01T00:00:00Z"
    }
    $timeoutLauncher = {
        param([string]$Executable)
        New-MockProcess -HasExited $true -ExitCode 0
    }.GetNewClosure()
    $timeoutDelay = {
        param([int]$Seconds)
        $timeoutState.Clock = $timeoutState.Clock.AddSeconds(31)
    }.GetNewClosure()
    $timeoutClock = { $timeoutState.Clock }.GetNewClosure()
    $timeoutMessage = Invoke-ExpectedFailure `
        -MessagePattern "Timed out waiting for the official ChatGPT/Codex package after 1 minute(s).*" `
        -Action {
            & $BootstrapScript `
                -TimeoutMinutes 1 `
                -PackageResolver $missingResolver `
                -DownloadAction $copyLiveInstaller `
                -InstallerLauncher $timeoutLauncher `
                -DelayAction $timeoutDelay `
                -UtcNowProvider $timeoutClock
        }
    Add-Result `
        -Name "registrationTimeout" `
        -Passed ($timeoutMessage -like "*after 1 minute(s)*") `
        -Detail "A successful installer process that never registers the package times out with remediation."

    $untrustedMessage = Invoke-ExpectedFailure `
        -MessagePattern "Refusing an installer URL outside get.microsoft.com*" `
        -Action {
            & $BootstrapScript `
                -VerifyDownloadOnly `
                -InstallerUrl "https://example.com/installer/download/9PLM9XGG6VKS"
        }
    Add-Result `
        -Name "untrustedHostRejected" `
        -Passed ($untrustedMessage -like "Refusing an installer URL outside*") `
        -Detail "A lookalike download host is rejected before any transfer."

    $unsignedDownload = {
        param([string]$Uri, [string]$Destination)
        $bytes = New-Object byte[] (128KB)
        $bytes[0] = 0x4D
        $bytes[1] = 0x5A
        [System.IO.File]::WriteAllBytes($Destination, $bytes)
    }.GetNewClosure()
    $unsignedMessage = Invoke-ExpectedFailure `
        -MessagePattern "The official installer signature is not valid:*" `
        -Action {
            & $BootstrapScript `
                -VerifyDownloadOnly `
                -PackageResolver $missingResolver `
                -DownloadAction $unsignedDownload `
                -DelayAction $noDelay
        }
    Add-Result `
        -Name "unsignedInstallerRejected" `
        -Passed ($unsignedMessage -like "*signature is not valid*") `
        -Detail "An unsigned PE-shaped payload is rejected before launch."

    $retryState = [PSCustomObject]@{
        Attempts = 0
        DelayCalls = 0
    }
    $retryDownload = {
        param([string]$Uri, [string]$Destination)
        $retryState.Attempts++
        if ($retryState.Attempts -lt 3) {
            throw "Synthetic transient network failure."
        }
        Copy-Item -LiteralPath $liveInstallerPath -Destination $Destination -Force
    }.GetNewClosure()
    $retryDelay = {
        param([int]$Seconds)
        $retryState.DelayCalls++
    }.GetNewClosure()
    $retryVerification = & $BootstrapScript `
        -VerifyDownloadOnly `
        -PackageResolver $missingResolver `
        -DownloadAction $retryDownload `
        -DelayAction $retryDelay
    Add-Result `
        -Name "transientDownloadRetry" `
        -Passed (
            $retryVerification.SignatureStatus -ceq "Valid" -and
            $retryState.Attempts -eq 3 -and
            $retryState.DelayCalls -eq 2
        ) `
        -Detail "Two transient download failures recover on the third signed attempt."

    $results | Format-Table -AutoSize -Wrap
    Write-Host "Official package bootstrap verification passed: $($results.Count)/$($results.Count) checks." -ForegroundColor Green
} finally {
    if (-not [string]::IsNullOrWhiteSpace($liveInstallerPath)) {
        $liveRoot = Split-Path -Parent $liveInstallerPath
        $tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\") + "\"
        $liveFullPath = [System.IO.Path]::GetFullPath($liveRoot)
        if ($liveFullPath.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
            $liveFullPath -like "*gpt-codex-custom-installer-*") {
            Remove-Item -LiteralPath $liveFullPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    $testFullPath = [System.IO.Path]::GetFullPath($TestRoot)
    $tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\") + "\"
    if (-not $testFullPath.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a bootstrap test path outside the temporary directory: $testFullPath"
    }
    if (Test-Path -LiteralPath $testFullPath) {
        Remove-Item -LiteralPath $testFullPath -Recurse -Force
    }
}
