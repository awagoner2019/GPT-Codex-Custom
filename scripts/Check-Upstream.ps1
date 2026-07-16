[CmdletBinding()]
param(
    [switch]$FailOnDrift,
    [switch]$AsJson
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$ManifestPath = Join-Path $ProjectRoot "upstream.json"
if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "Upstream manifest is missing: $ManifestPath"
}

$manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
$installed = Get-AppxPackage -Name ([string]$manifest.packageName) |
    Sort-Object Version -Descending |
    Select-Object -First 1
if ($null -eq $installed) {
    throw "The installed $($manifest.packageName) package was not found."
}

$installedAsar = Join-Path $installed.InstallLocation "app\resources\app.asar"
$installedExe = Join-Path $installed.InstallLocation "app\ChatGPT.exe"
foreach ($path in @($installedAsar, $installedExe)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Installed upstream file is missing: $path"
    }
}

$installedAsarHash = (Get-FileHash -LiteralPath $installedAsar -Algorithm SHA256).Hash
$installedExeHash = (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash
$matches =
    $installed.PackageFullName -eq [string]$manifest.packageFullName -and
    $installed.Version.ToString() -eq [string]$manifest.packageVersion -and
    $installedAsarHash -eq [string]$manifest.appAsarSha256 -and
    $installedExeHash -eq [string]$manifest.executableSha256

$result = [ordered]@{
    matchesSnapshot = $matches
    installedPackage = $installed.PackageFullName
    installedVersion = $installed.Version.ToString()
    snapshotPackage = [string]$manifest.packageFullName
    snapshotVersion = [string]$manifest.packageVersion
    installedAsarSha256 = $installedAsarHash
    snapshotAsarSha256 = [string]$manifest.appAsarSha256
    installedExecutableSha256 = $installedExeHash
    snapshotExecutableSha256 = [string]$manifest.executableSha256
}

if ($AsJson) {
    $result | ConvertTo-Json -Depth 3
} else {
    [PSCustomObject]$result | Format-List
}

if ($FailOnDrift -and -not $matches) {
    throw "The installed GPT/Codex package differs from the isolated upstream snapshot. Run npm run upstream:sync after reviewing the new package."
}
