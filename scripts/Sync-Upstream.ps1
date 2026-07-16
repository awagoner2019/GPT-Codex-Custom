[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$WorkRoot = Join-Path $ProjectRoot "work"
$ManifestPath = Join-Path $ProjectRoot "upstream.json"
$VendorPackage = Join-Path $ProjectRoot "vendor\package"
$UpstreamSource = Join-Path $WorkRoot "upstream-src"
$RuntimeRoot = Join-Path $WorkRoot "runtime"
$RuntimeExe = Join-Path $RuntimeRoot "ChatGPT.exe"
$StageRoot = Join-Path $WorkRoot "upstream-sync-staging"
$AsarCli = Join-Path $ProjectRoot "node_modules\@electron\asar\bin\asar.js"
$BuildScript = Join-Path $PSScriptRoot "Build-Custom.ps1"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Assert-ProjectPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPrefix = $ProjectRoot.TrimEnd("\") + "\"
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the project: $fullPath"
    }
}

foreach ($path in @($ManifestPath, $VendorPackage, $UpstreamSource, $RuntimeRoot, $AsarCli, $BuildScript)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Required upstream-sync path is missing: $path"
    }
}

$oldManifestText = [System.IO.File]::ReadAllText($ManifestPath)
$oldManifest = $oldManifestText | ConvertFrom-Json
$installed = Get-AppxPackage -Name ([string]$oldManifest.packageName) |
    Sort-Object Version -Descending |
    Select-Object -First 1
if ($null -eq $installed) {
    throw "The installed $($oldManifest.packageName) package was not found."
}

$installedAsar = Join-Path $installed.InstallLocation "app\resources\app.asar"
$installedExe = Join-Path $installed.InstallLocation "app\ChatGPT.exe"
$installedAsarHash = (Get-FileHash -LiteralPath $installedAsar -Algorithm SHA256).Hash
$installedExeHash = (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash
$alreadyCurrent =
    $installed.PackageFullName -eq [string]$oldManifest.packageFullName -and
    $installed.Version.ToString() -eq [string]$oldManifest.packageVersion -and
    $installedAsarHash -eq [string]$oldManifest.appAsarSha256 -and
    $installedExeHash -eq [string]$oldManifest.executableSha256

if ($alreadyCurrent -and -not $Force) {
    Write-Host "The isolated upstream snapshot already matches $($installed.PackageFullName)." -ForegroundColor Green
    return
}

Write-Host "Installed package: $($installed.PackageFullName)"
Write-Host "Snapshot package:  $($oldManifest.packageFullName)"
if (-not $Apply) {
    Write-Host "No files were changed. Re-run with -Apply to stage, validate, and atomically replace the isolated copy." -ForegroundColor Yellow
    return
}

$runtimePath = [System.IO.Path]::GetFullPath($RuntimeExe)
$runningCustom = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
    Where-Object {
        $_.ExecutablePath -and
        [System.IO.Path]::GetFullPath($_.ExecutablePath) -eq $runtimePath
    }
if ($null -ne $runningCustom) {
    throw "Close the custom GPT/Codex app before syncing its upstream runtime. The official installed app may remain open."
}

Assert-ProjectPath $StageRoot
if (Test-Path -LiteralPath $StageRoot) {
    Remove-Item -LiteralPath $StageRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null

$StagePackage = Join-Path $StageRoot "package"
$StageSource = Join-Path $StageRoot "upstream-src"
$CandidateRuntime = Join-Path $StageRoot "runtime-candidate"
$BackupRoot = Join-Path $StageRoot "backup"
$BackupPackage = Join-Path $BackupRoot "package"
$BackupSource = Join-Path $BackupRoot "upstream-src"
$BackupRuntime = Join-Path $BackupRoot "runtime"
foreach ($path in @($StagePackage, $StageSource, $CandidateRuntime, $BackupRoot)) {
    Assert-ProjectPath $path
    New-Item -ItemType Directory -Force -Path $path | Out-Null
}

$vendorSwapped = $false
$sourceSwapped = $false
$runtimeSwapped = $false

try {
    Write-Host "Copying the installed package into isolated staging..."
    Get-ChildItem -LiteralPath $installed.InstallLocation -Force |
        Copy-Item -Destination $StagePackage -Recurse -Force

    $stageAsar = Join-Path $StagePackage "app\resources\app.asar"
    $stageExe = Join-Path $StagePackage "app\ChatGPT.exe"
    if ((Get-FileHash -LiteralPath $stageAsar -Algorithm SHA256).Hash -ne $installedAsarHash) {
        throw "The staged app.asar hash does not match the installed package."
    }
    if ((Get-FileHash -LiteralPath $stageExe -Algorithm SHA256).Hash -ne $installedExeHash) {
        throw "The staged executable hash does not match the installed package."
    }

    Write-Host "Extracting and validating the new renderer..."
    & node $AsarCli extract $stageAsar $StageSource
    if ($LASTEXITCODE -ne 0) {
        throw "ASAR extraction failed with exit code $LASTEXITCODE."
    }
    $upstreamPackageJson = Join-Path $StageSource "package.json"
    if (-not (Test-Path -LiteralPath $upstreamPackageJson)) {
        throw "The staged upstream ASAR does not contain package.json."
    }
    $appVersion = [string](Get-Content -Raw -LiteralPath $upstreamPackageJson | ConvertFrom-Json).version

    Get-ChildItem -LiteralPath (Join-Path $StagePackage "app") -Force |
        Copy-Item -Destination $CandidateRuntime -Recurse -Force

    $newManifest = [ordered]@{
        packageName = [string]$oldManifest.packageName
        packageFullName = $installed.PackageFullName
        packageVersion = $installed.Version.ToString()
        appVersion = $appVersion
        appAsarSha256 = $installedAsarHash
        executableSha256 = $installedExeHash
        capturedAtUtc = [DateTime]::UtcNow.ToString("o")
    }
    $newManifestText = ($newManifest | ConvertTo-Json -Depth 3) + "`r`n"

    Move-Item -LiteralPath $VendorPackage -Destination $BackupPackage
    $vendorSwapped = $true
    Move-Item -LiteralPath $StagePackage -Destination $VendorPackage

    Move-Item -LiteralPath $UpstreamSource -Destination $BackupSource
    $sourceSwapped = $true
    Move-Item -LiteralPath $StageSource -Destination $UpstreamSource
    [System.IO.File]::WriteAllText($ManifestPath, $newManifestText, $utf8NoBom)

    Write-Host "Building the candidate runtime against exact compatibility needles..."
    & $BuildScript -RuntimeRootOverride $CandidateRuntime
    if ($LASTEXITCODE -ne 0) {
        throw "Candidate build failed with exit code $LASTEXITCODE."
    }

    Move-Item -LiteralPath $RuntimeRoot -Destination $BackupRuntime
    $runtimeSwapped = $true
    Move-Item -LiteralPath $CandidateRuntime -Destination $RuntimeRoot

    & (Join-Path $PSScriptRoot "Verify-Custom.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "The refreshed runtime failed verification with exit code $LASTEXITCODE."
    }

    Assert-ProjectPath $StageRoot
    Remove-Item -LiteralPath $StageRoot -Recurse -Force
    Write-Host "The isolated custom runtime now targets $($installed.PackageFullName)." -ForegroundColor Green
} catch {
    $failure = $_
    try {
        if ($runtimeSwapped) {
            $failedRuntime = Join-Path $StageRoot "failed-runtime"
            if (Test-Path -LiteralPath $RuntimeRoot) {
                Move-Item -LiteralPath $RuntimeRoot -Destination $failedRuntime
            }
            if (Test-Path -LiteralPath $BackupRuntime) {
                Move-Item -LiteralPath $BackupRuntime -Destination $RuntimeRoot
            }
        }
        if ($sourceSwapped) {
            $failedSource = Join-Path $StageRoot "failed-upstream-src"
            if (Test-Path -LiteralPath $UpstreamSource) {
                Move-Item -LiteralPath $UpstreamSource -Destination $failedSource
            }
            if (Test-Path -LiteralPath $BackupSource) {
                Move-Item -LiteralPath $BackupSource -Destination $UpstreamSource
            }
        }
        if ($vendorSwapped) {
            $failedPackage = Join-Path $StageRoot "failed-package"
            if (Test-Path -LiteralPath $VendorPackage) {
                Move-Item -LiteralPath $VendorPackage -Destination $failedPackage
            }
            if (Test-Path -LiteralPath $BackupPackage) {
                Move-Item -LiteralPath $BackupPackage -Destination $VendorPackage
            }
        }
        [System.IO.File]::WriteAllText($ManifestPath, $oldManifestText, $utf8NoBom)
    } catch {
        throw "Upstream refresh failed and rollback also failed. Original error: $failure. Rollback error: $_"
    }
    throw $failure
}
