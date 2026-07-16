[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$PackageScript = Join-Path $PSScriptRoot "New-UpdatePackage.ps1"
$UpdateScript = Join-Path $PSScriptRoot "Update-Custom.ps1"
$ConfigPath = Join-Path $ProjectRoot "config\update.json"
$PackageJsonPath = Join-Path $ProjectRoot "package.json"
$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("GPTCodexCustom-update-test-" + [Guid]::NewGuid().ToString("N"))
$OutputRoot = Join-Path $TestRoot "dist"
$FixtureRoot = Join-Path $TestRoot "fixture"
$ExtractAuditRoot = Join-Path $TestRoot "audit"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Assert-TestPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\") + "\"
    if (-not $fullPath.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetFileName($TestRoot) -notlike "GPTCodexCustom-update-test-*") {
        throw "Refusing to modify a path outside the updater test root: $fullPath"
    }
}

Assert-TestPath $TestRoot
New-Item -ItemType Directory -Force -Path $OutputRoot, $FixtureRoot, $ExtractAuditRoot | Out-Null

try {
    & $PackageScript -OutputDirectory $OutputRoot | Out-Host

    $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
    $projectPackage = Get-Content -Raw -LiteralPath $PackageJsonPath | ConvertFrom-Json
    $assetPath = Join-Path $OutputRoot ([string]$config.assetName)
    $checksumPath = Join-Path $OutputRoot ([string]$config.checksumAssetName)
    foreach ($requiredPath in @($assetPath, $checksumPath)) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "The update package generator did not create $requiredPath."
        }
    }

    $checksumText = Get-Content -Raw -LiteralPath $checksumPath
    if ($checksumText -notmatch '(?i)\b([A-F0-9]{64})\b') {
        throw "The generated checksum file has no SHA-256 value."
    }
    if ((Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash -ne $Matches[1].ToUpperInvariant()) {
        throw "The generated update asset does not match its checksum file."
    }

    Expand-Archive -LiteralPath $assetPath -DestinationPath $ExtractAuditRoot -Force
    $forbiddenPackageEntries = @(
        Get-ChildItem -LiteralPath $ExtractAuditRoot -Recurse -File -Force |
            ForEach-Object { $_.FullName.Substring($ExtractAuditRoot.Length + 1).Replace("\", "/") } |
            Where-Object { $_ -match '^(vendor|work|profile|logs|updates|node_modules|\.git|\.mex)(/|$)' }
    )
    if ($forbiddenPackageEntries.Count -gt 0) {
        throw "The generated update package contains excluded state: $($forbiddenPackageEntries -join ', ')"
    }

    New-Item -ItemType Directory -Force -Path `
        (Join-Path $FixtureRoot "config"), `
        (Join-Path $FixtureRoot "custom"), `
        (Join-Path $FixtureRoot "logs"), `
        (Join-Path $FixtureRoot "profile"), `
        (Join-Path $FixtureRoot "vendor"), `
        (Join-Path $FixtureRoot "work") | Out-Null
    Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $FixtureRoot "config\update.json")
    [System.IO.File]::WriteAllText(
        (Join-Path $FixtureRoot "package.json"),
        "{`"name`":`"gpt-codex-custom-fixture`",`"version`":`"0.0.1`"}`n",
        $utf8NoBom
    )
    $oldFixtureFile = Join-Path $FixtureRoot "custom\old.txt"
    [System.IO.File]::WriteAllText($oldFixtureFile, "old", $utf8NoBom)
    foreach ($privateRoot in @("profile", "vendor", "work", "logs")) {
        [System.IO.File]::WriteAllText(
            (Join-Path $FixtureRoot "$privateRoot\sentinel.txt"),
            "$privateRoot-preserved",
            $utf8NoBom
        )
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $FixtureRoot "upstream.json"),
        "{`"localFingerprint`":true}`n",
        $utf8NoBom
    )

    $fixtureManifest = [ordered]@{
        schemaVersion = 1
        project = "GPTCodexCustom"
        repository = [string]$config.repository
        version = "0.0.1"
        generatedAtUtc = [DateTime]::UtcNow.ToString("o")
        files = @(
            [ordered]@{
                path = "custom/old.txt"
                sha256 = (Get-FileHash -LiteralPath $oldFixtureFile -Algorithm SHA256).Hash
                length = (Get-Item -LiteralPath $oldFixtureFile).Length
            }
        )
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $FixtureRoot "release-manifest.json"),
        (($fixtureManifest | ConvertTo-Json -Depth 6) + "`n"),
        $utf8NoBom
    )

    $metadataPath = Join-Path $TestRoot "release.json"
    $releaseMetadata = [ordered]@{
        tag_name = "v$([string]$projectPackage.version)"
        draft = $false
        prerelease = $false
        assets = @()
    }
    [System.IO.File]::WriteAllText(
        $metadataPath,
        (($releaseMetadata | ConvertTo-Json -Depth 4) + "`n"),
        $utf8NoBom
    )

    # A valid checksum must not make an archive with a forbidden path acceptable.
    $tamperedAssetPath = Join-Path $TestRoot "tampered-update.zip"
    $tamperedChecksumPath = Join-Path $TestRoot "tampered-update.zip.sha256"
    Copy-Item -LiteralPath $assetPath -Destination $tamperedAssetPath -Force
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $tamperedArchive = [System.IO.Compression.ZipFile]::Open(
        $tamperedAssetPath,
        [System.IO.Compression.ZipArchiveMode]::Update
    )
    try {
        $forbiddenEntry = $tamperedArchive.CreateEntry("profile/forbidden.txt")
        $writer = [System.IO.StreamWriter]::new($forbiddenEntry.Open())
        try {
            $writer.Write("forbidden")
        } finally {
            $writer.Dispose()
        }
    } finally {
        $tamperedArchive.Dispose()
    }
    $tamperedHash = (Get-FileHash -LiteralPath $tamperedAssetPath -Algorithm SHA256).Hash
    [System.IO.File]::WriteAllText(
        $tamperedChecksumPath,
        "$tamperedHash  tampered-update.zip`n",
        $utf8NoBom
    )
    $forbiddenArchiveRejected = $false
    try {
        & $UpdateScript `
            -Mode Apply `
            -ProjectRootOverride $FixtureRoot `
            -ReleaseMetadataPath $metadataPath `
            -AssetPath $tamperedAssetPath `
            -ChecksumPath $tamperedChecksumPath `
            -SkipBuild `
            -Force | Out-Host
    } catch {
        if ([string]$_ -notmatch "maintained-source allowlist") {
            throw
        }
        $forbiddenArchiveRejected = $true
    }
    if (-not $forbiddenArchiveRejected) {
        throw "The updater accepted an archive containing forbidden profile state."
    }

    # Manifest-based local changes must block a normal update.
    [System.IO.File]::WriteAllText($oldFixtureFile, "locally changed", $utf8NoBom)
    $localChangeRejected = $false
    try {
        & $UpdateScript `
            -Mode Apply `
            -ProjectRootOverride $FixtureRoot `
            -ReleaseMetadataPath $metadataPath `
            -AssetPath $assetPath `
            -ChecksumPath $checksumPath `
            -SkipBuild | Out-Host
    } catch {
        if ([string]$_ -notmatch "local source changes") {
            throw
        }
        $localChangeRejected = $true
    }
    if (-not $localChangeRejected) {
        throw "The updater overwrote a locally modified maintained file."
    }
    [System.IO.File]::WriteAllText($oldFixtureFile, "old", $utf8NoBom)

    & $UpdateScript `
        -Mode Apply `
        -ProjectRootOverride $FixtureRoot `
        -ReleaseMetadataPath $metadataPath `
        -AssetPath $assetPath `
        -ChecksumPath $checksumPath `
        -SkipBuild | Out-Host

    $updatedFixturePackage = Get-Content -Raw -LiteralPath (Join-Path $FixtureRoot "package.json") | ConvertFrom-Json
    if ([string]$updatedFixturePackage.version -ne [string]$projectPackage.version) {
        throw "The fixture did not advance to the packaged version."
    }
    if (Test-Path -LiteralPath $oldFixtureFile -PathType Leaf) {
        throw "The updater did not retire a maintained file removed from the new release."
    }
    foreach ($privateRoot in @("profile", "vendor", "work", "logs")) {
        $actualSentinel = Get-Content -Raw -LiteralPath (Join-Path $FixtureRoot "$privateRoot\sentinel.txt")
        if ($actualSentinel -ne "$privateRoot-preserved") {
            throw "The updater changed private $privateRoot state."
        }
    }
    if ((Get-Content -Raw -LiteralPath (Join-Path $FixtureRoot "upstream.json")) -ne "{`"localFingerprint`":true}`n") {
        throw "The custom source updater changed the machine-specific upstream fingerprint."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $FixtureRoot "release-manifest.json") -PathType Leaf)) {
        throw "The updater did not install the release manifest."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $FixtureRoot "scripts\Update-Custom.ps1") -PathType Leaf)) {
        throw "The updater did not install maintained source files."
    }

    Write-Host "Updater verification passed: hashing, archive allowlist, local-change refusal, retired-file cleanup, apply, and private-state preservation." -ForegroundColor Green
} finally {
    Assert-TestPath $TestRoot
    if (Test-Path -LiteralPath $TestRoot) {
        Remove-Item -LiteralPath $TestRoot -Recurse -Force
    }
}
