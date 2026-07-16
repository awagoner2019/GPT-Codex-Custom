[CmdletBinding()]
param(
    [switch]$SkipOfficialInstaller
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$WorkRoot = Join-Path $ProjectRoot "work"
$VendorRoot = Join-Path $ProjectRoot "vendor"
$VendorPackage = Join-Path $VendorRoot "package"
$UpstreamSource = Join-Path $WorkRoot "upstream-src"
$RuntimeRoot = Join-Path $WorkRoot "runtime"
$StageRoot = Join-Path $WorkRoot ("initialize-staging-" + [Guid]::NewGuid().ToString("N"))
$StagePackage = Join-Path $StageRoot "package"
$StageSource = Join-Path $StageRoot "upstream-src"
$StageRuntime = Join-Path $StageRoot "runtime"
$ManifestPath = Join-Path $ProjectRoot "upstream.json"
$AsarCli = Join-Path $ProjectRoot "node_modules\@electron\asar\bin\asar.js"
$BuildScript = Join-Path $PSScriptRoot "Build-Custom.ps1"
$VerifyScript = Join-Path $PSScriptRoot "Verify-Custom.ps1"
$OfficialPackageScript = Join-Path $PSScriptRoot "Ensure-OfficialPackage.ps1"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Assert-ProjectPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPrefix = $ProjectRoot.TrimEnd("\") + "\"
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the project: $fullPath"
    }
}

foreach ($requiredPath in @($AsarCli, $BuildScript, $VerifyScript, $OfficialPackageScript)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required setup dependency is missing: $requiredPath`nRun npm ci before npm run setup."
    }
}

$existingState = @(
    @($VendorPackage, $UpstreamSource, $RuntimeRoot) |
        Where-Object { Test-Path -LiteralPath $_ }
)
if ($existingState.Count -gt 0) {
    throw "This project already has an isolated upstream snapshot. Use npm run upstream:sync to refresh it. Existing paths: $($existingState -join ', ')"
}

$installed = Get-AppxPackage -Name "OpenAI.Codex" |
    Sort-Object Version -Descending |
    Select-Object -First 1
if ($null -eq $installed) {
    if ($SkipOfficialInstaller) {
        throw "The OpenAI.Codex package was not found and automatic official-installer bootstrap was disabled."
    }

    Write-Host "The official package is missing; starting the verified OpenAI/Microsoft installer bootstrap."
    & $OfficialPackageScript | Out-Host
    $installed = Get-AppxPackage -Name "OpenAI.Codex" |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if ($null -eq $installed) {
        throw "The official installer completed without making the OpenAI.Codex package available. Run npm run setup again after installation finishes."
    }
}

$installedAsar = Join-Path $installed.InstallLocation "app\resources\app.asar"
$installedExe = Join-Path $installed.InstallLocation "app\ChatGPT.exe"
foreach ($requiredPath in @($installedAsar, $installedExe)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "The installed package is missing an expected file: $requiredPath"
    }
}

foreach ($path in @($StageRoot, $StagePackage, $StageSource, $StageRuntime, $VendorPackage, $UpstreamSource, $RuntimeRoot)) {
    Assert-ProjectPath $path
}

$createdTargets = [System.Collections.Generic.List[string]]::new()
try {
    New-Item -ItemType Directory -Force -Path $StagePackage, $StageSource, $StageRuntime | Out-Null

    Write-Host "Copying the installed package into this isolated project..."
    Get-ChildItem -LiteralPath $installed.InstallLocation -Force |
        Copy-Item -Destination $StagePackage -Recurse -Force

    $stageAsar = Join-Path $StagePackage "app\resources\app.asar"
    $stageExe = Join-Path $StagePackage "app\ChatGPT.exe"
    $installedAsarHash = (Get-FileHash -LiteralPath $installedAsar -Algorithm SHA256).Hash
    $installedExeHash = (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash
    if ((Get-FileHash -LiteralPath $stageAsar -Algorithm SHA256).Hash -ne $installedAsarHash) {
        throw "The isolated app.asar copy does not match the installed package."
    }
    if ((Get-FileHash -LiteralPath $stageExe -Algorithm SHA256).Hash -ne $installedExeHash) {
        throw "The isolated ChatGPT.exe copy does not match the installed package."
    }

    Write-Host "Extracting the read-only upstream renderer snapshot..."
    & node $AsarCli extract $stageAsar $StageSource
    if ($LASTEXITCODE -ne 0) {
        throw "ASAR extraction failed with exit code $LASTEXITCODE."
    }

    $upstreamPackageJson = Join-Path $StageSource "package.json"
    if (-not (Test-Path -LiteralPath $upstreamPackageJson)) {
        throw "The installed app.asar does not contain package.json."
    }
    $appVersion = [string](Get-Content -Raw -LiteralPath $upstreamPackageJson | ConvertFrom-Json).version

    Get-ChildItem -LiteralPath (Join-Path $StagePackage "app") -Force |
        Copy-Item -Destination $StageRuntime -Recurse -Force

    New-Item -ItemType Directory -Force -Path $VendorRoot, $WorkRoot | Out-Null
    Move-Item -LiteralPath $StagePackage -Destination $VendorPackage
    $createdTargets.Add($VendorPackage)
    Move-Item -LiteralPath $StageSource -Destination $UpstreamSource
    $createdTargets.Add($UpstreamSource)
    Move-Item -LiteralPath $StageRuntime -Destination $RuntimeRoot
    $createdTargets.Add($RuntimeRoot)

    $manifest = [ordered]@{
        packageName = "OpenAI.Codex"
        packageFullName = $installed.PackageFullName
        packageVersion = $installed.Version.ToString()
        appVersion = $appVersion
        appAsarSha256 = $installedAsarHash
        executableSha256 = $installedExeHash
        capturedAtUtc = [DateTime]::UtcNow.ToString("o")
    }
    [System.IO.File]::WriteAllText(
        $ManifestPath,
        (($manifest | ConvertTo-Json -Depth 3) + "`r`n"),
        $utf8NoBom
    )

    Write-Host "Building the independent custom runtime..."
    & $BuildScript

    & $VerifyScript

    Write-Host "GPT + Codex Custom is initialized and verified." -ForegroundColor Green
    Write-Host "The official installed package was read but not modified."
} catch {
    $failure = $_
    foreach ($target in @($createdTargets | Sort-Object { $_.Length } -Descending)) {
        Assert-ProjectPath $target
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Recurse -Force
        }
    }
    throw $failure
} finally {
    Assert-ProjectPath $StageRoot
    if (Test-Path -LiteralPath $StageRoot) {
        Remove-Item -LiteralPath $StageRoot -Recurse -Force
    }
}
