[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [switch]$WriteProjectManifest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $ProjectRoot "dist"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory = Join-Path $ProjectRoot $OutputDirectory
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$StageRoot = Join-Path $OutputDirectory ("update-staging-" + [Guid]::NewGuid().ToString("N"))
$PackageJsonPath = Join-Path $ProjectRoot "package.json"
$UpdateConfigPath = Join-Path $ProjectRoot "config\update.json"
$ProjectManifestPath = Join-Path $ProjectRoot "release-manifest.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

foreach ($requiredPath in @($PackageJsonPath, $UpdateConfigPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required release input is missing: $requiredPath"
    }
}

$packageJson = Get-Content -Raw -LiteralPath $PackageJsonPath | ConvertFrom-Json
$updateConfig = Get-Content -Raw -LiteralPath $UpdateConfigPath | ConvertFrom-Json
$version = [string]$packageJson.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "package.json contains an unsupported release version: $version"
}

$assetName = [string]$updateConfig.assetName
$checksumAssetName = [string]$updateConfig.checksumAssetName
if ([string]::IsNullOrWhiteSpace($assetName) -or [string]::IsNullOrWhiteSpace($checksumAssetName)) {
    throw "config/update.json must define assetName and checksumAssetName."
}

$topLevelFiles = @(
    ".gitattributes",
    ".gitignore",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "Install-GPT-Codex-Custom.cmd",
    "README.md",
    "SECURITY.md",
    "Start-GPT-Codex-Custom.cmd",
    "package-lock.json",
    "package.json",
    "config/update.json"
)
$sourceRoots = @(".github", "custom", "docs", "scripts")
$sourceFiles = [System.Collections.Generic.List[System.IO.FileInfo]]::new()

foreach ($relativePath in $topLevelFiles) {
    $sourcePath = Join-Path $ProjectRoot $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required release file is missing: $relativePath"
    }
    $sourceFiles.Add((Get-Item -LiteralPath $sourcePath))
}

foreach ($relativeRoot in $sourceRoots) {
    $sourceRoot = Join-Path $ProjectRoot $relativeRoot
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
        throw "Required release directory is missing: $relativeRoot"
    }
    foreach ($sourceFile in Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Force) {
        $sourceFiles.Add($sourceFile)
    }
}

$sourceFiles = @($sourceFiles | Sort-Object FullName -Unique)
$manifestEntries = [System.Collections.Generic.List[object]]::new()
New-Item -ItemType Directory -Force -Path $OutputDirectory, $StageRoot | Out-Null

try {
    foreach ($sourceFile in $sourceFiles) {
        $relativePath = $sourceFile.FullName.Substring($ProjectRoot.Length + 1).Replace("\", "/")
        if ($relativePath -match '^(vendor|work|profile|logs|updates|dist|node_modules|\.git|\.mex)(/|$)') {
            throw "Refusing to package excluded content: $relativePath"
        }

        $destinationPath = Join-Path $StageRoot $relativePath.Replace("/", "\")
        $destinationDirectory = Split-Path -Parent $destinationPath
        New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
        Copy-Item -LiteralPath $sourceFile.FullName -Destination $destinationPath -Force
        $manifestEntries.Add([ordered]@{
            path = $relativePath
            sha256 = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash
            length = (Get-Item -LiteralPath $destinationPath).Length
        })
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        project = "GPTCodexCustom"
        repository = [string]$updateConfig.repository
        version = $version
        generatedAtUtc = [DateTime]::UtcNow.ToString("o")
        files = @($manifestEntries)
    }
    $manifestJson = (($manifest | ConvertTo-Json -Depth 6) -replace "`r`n", "`n" -replace "`r", "`n") + "`n"
    $stageManifestPath = Join-Path $StageRoot "release-manifest.json"
    [System.IO.File]::WriteAllText($stageManifestPath, $manifestJson, $utf8NoBom)
    if ($WriteProjectManifest) {
        [System.IO.File]::WriteAllText($ProjectManifestPath, $manifestJson, $utf8NoBom)
    }

    $assetPath = Join-Path $OutputDirectory $assetName
    $checksumPath = Join-Path $OutputDirectory $checksumAssetName
    Remove-Item -LiteralPath $assetPath, $checksumPath -Force -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $StageRoot,
        $assetPath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )
    $assetHash = (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash
    [System.IO.File]::WriteAllText(
        $checksumPath,
        "$assetHash  $assetName`n",
        $utf8NoBom
    )

    [PSCustomObject][ordered]@{
        version = $version
        fileCount = $manifestEntries.Count
        asset = $assetPath
        checksum = $checksumPath
        sha256 = $assetHash
        projectManifestWritten = [bool]$WriteProjectManifest
    } | Format-List
} finally {
    $stageFullPath = [System.IO.Path]::GetFullPath($StageRoot)
    $outputPrefix = $OutputDirectory.TrimEnd("\") + "\"
    if (-not $stageFullPath.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a staging path outside the selected output directory: $stageFullPath"
    }
    if (Test-Path -LiteralPath $stageFullPath) {
        Remove-Item -LiteralPath $stageFullPath -Recurse -Force
    }
}
