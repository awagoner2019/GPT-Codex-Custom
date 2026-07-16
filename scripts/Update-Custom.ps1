[CmdletBinding()]
param(
    [ValidateSet("Auto", "Check", "Apply")]
    [string]$Mode = "Check",
    [string]$ProjectRootOverride,
    [string]$Repository,
    [string]$ReleaseMetadataPath,
    [string]$AssetPath,
    [string]$ChecksumPath,
    [switch]$Force,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = if ([string]::IsNullOrWhiteSpace($ProjectRootOverride)) {
    (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
    (Resolve-Path -LiteralPath $ProjectRootOverride).Path
}
$ConfigPath = Join-Path $ProjectRoot "config\update.json"
$LocalConfigPath = Join-Path $ProjectRoot "config\update.local.json"
$PackageJsonPath = Join-Path $ProjectRoot "package.json"
$CurrentManifestPath = Join-Path $ProjectRoot "release-manifest.json"
$UpdateRoot = Join-Path $ProjectRoot "updates"
$StatePath = Join-Path $UpdateRoot "update-state.json"
$RuntimeExecutable = Join-Path $ProjectRoot "work\runtime\ChatGPT.exe"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$AllowedTopLevelFiles = @(
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
$AllowedRoots = @(".github", "custom", "docs", "scripts")
$AllowedDirectoryRoots = @(".github", "config", "custom", "docs", "scripts")

function Assert-ProjectPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPrefix = $ProjectRoot.TrimEnd("\") + "\"
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the project: $fullPath"
    }
}

function Get-OptionalPropertyValue {
    param(
        [Parameter(Mandatory = $true)][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        $Default = $null
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $Default
    }
    return $property.Value
}

function ConvertTo-ComparableVersion {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value -notmatch '^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$') {
        throw "Unsupported release version: $Value"
    }
    return [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
}

function Test-SafeRelativePathSyntax {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $normalized = $RelativePath.Replace("\", "/")
    if ([string]::IsNullOrWhiteSpace($normalized) -or
        $normalized.StartsWith("/") -or
        $normalized.EndsWith("/") -or
        [System.IO.Path]::IsPathRooted($RelativePath) -or
        $normalized.Contains(":")) {
        return $false
    }

    $segments = @($normalized.Split([char]"/"))
    foreach ($segment in $segments) {
        if ([string]::IsNullOrWhiteSpace($segment) -or
            $segment -eq "." -or
            $segment -eq ".." -or
            $segment.EndsWith(".") -or
            $segment.EndsWith(" ") -or
            $segment.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
            $segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
            return $false
        }
    }
    return $true
}

function Test-AllowedRelativePath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    if (-not (Test-SafeRelativePathSyntax -RelativePath $RelativePath)) {
        return $false
    }
    $normalized = $RelativePath.Replace("\", "/")
    if ($AllowedTopLevelFiles -contains $normalized) {
        return $true
    }
    foreach ($root in $AllowedRoots) {
        if ($normalized.StartsWith("$root/", [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Write-UpdateState {
    param([Parameter(Mandatory = $true)][hashtable]$Values)

    New-Item -ItemType Directory -Force -Path $UpdateRoot | Out-Null
    $state = [ordered]@{}
    if (Test-Path -LiteralPath $StatePath) {
        try {
            $existing = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
            foreach ($property in $existing.PSObject.Properties) {
                $state[$property.Name] = $property.Value
            }
        } catch {
            $state = [ordered]@{}
        }
    }
    foreach ($key in $Values.Keys) {
        $state[$key] = $Values[$key]
    }
    [System.IO.File]::WriteAllText(
        $StatePath,
        (($state | ConvertTo-Json -Depth 5) + "`n"),
        $utf8NoBom
    )
}

function Get-LocalModificationSummary {
    if (Test-Path -LiteralPath $CurrentManifestPath -PathType Leaf) {
      try {
        $manifest = Get-Content -Raw -LiteralPath $CurrentManifestPath | ConvertFrom-Json
        $changes = [System.Collections.Generic.List[string]]::new()
        foreach ($entry in @($manifest.files)) {
            $relativePath = [string]$entry.path
            if (-not (Test-AllowedRelativePath -RelativePath $relativePath)) {
                continue
            }
            $fullPath = Join-Path $ProjectRoot $relativePath.Replace("/", "\")
            if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
                $changes.Add("missing $relativePath")
            } elseif ((Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash -ne [string]$entry.sha256) {
                $changes.Add("changed $relativePath")
            }
            if ($changes.Count -ge 8) {
                break
            }
        }
        if ($changes.Count -gt 0) {
            return ($changes -join "; ")
        }
      } catch {
        return "the local release manifest could not be validated"
      }

      # An applied source release intentionally differs from the original Git
      # commit, so tracked Git status is not authoritative after the first
      # update. Still protect new untracked maintained files that a future
      # release might otherwise overwrite.
      $gitDirectory = Join-Path $ProjectRoot ".git"
      if (Test-Path -LiteralPath $gitDirectory -PathType Container) {
          $gitStatus = @(& git -C $ProjectRoot status --porcelain --untracked-files=all 2>$null)
          if ($LASTEXITCODE -eq 0) {
              $untrackedMaintained = @(
                  $gitStatus |
                      Where-Object { $_ -match '^\?\?\s+(.+)$' } |
                      ForEach-Object { $Matches[1].Trim('"').Replace("\", "/") } |
                      Where-Object { Test-AllowedRelativePath -RelativePath $_ } |
                      Select-Object -First 8
              )
              if ($untrackedMaintained.Count -gt 0) {
                  return "untracked maintained files: $($untrackedMaintained -join '; ')"
              }
          }
      }
      return $null
    }

    $gitDirectory = Join-Path $ProjectRoot ".git"
    if (Test-Path -LiteralPath $gitDirectory -PathType Container) {
        $gitStatus = @(& git -C $ProjectRoot status --porcelain --untracked-files=all 2>$null)
        if ($LASTEXITCODE -eq 0 -and $gitStatus.Count -gt 0) {
            return "Git source changes: $((@($gitStatus | Select-Object -First 8) -join '; '))"
        }
    }
    return $null
}

function Get-CustomRuntimeProcess {
    if (-not (Test-Path -LiteralPath $RuntimeExecutable -PathType Leaf)) {
        return @()
    }
    $expectedPath = [System.IO.Path]::GetFullPath($RuntimeExecutable)
    return @(
        Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
            Where-Object {
                $_.ExecutablePath -and
                [System.IO.Path]::GetFullPath($_.ExecutablePath) -eq $expectedPath
            }
    )
}

function Invoke-ProjectCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )

    Write-Host $Name
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE."
    }
}

foreach ($requiredPath in @($ConfigPath, $PackageJsonPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required updater input is missing: $requiredPath"
    }
}

$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
if (Test-Path -LiteralPath $LocalConfigPath -PathType Leaf) {
    $localConfig = Get-Content -Raw -LiteralPath $LocalConfigPath | ConvertFrom-Json
    foreach ($property in $localConfig.PSObject.Properties) {
        $config | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value -Force
    }
}

$enabled = [bool](Get-OptionalPropertyValue -Object $config -Name "enabled" -Default $true)
if ($Mode -eq "Auto" -and -not $enabled) {
    Write-Host "Automatic custom updates are disabled in config/update.json."
    return
}

$repositoryName = if ([string]::IsNullOrWhiteSpace($Repository)) {
    [string](Get-OptionalPropertyValue -Object $config -Name "repository")
} else {
    $Repository
}
if ($repositoryName -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw "The updater repository must use owner/name format. Current value: $repositoryName"
}

$checkIntervalHours = [double](Get-OptionalPropertyValue -Object $config -Name "checkIntervalHours" -Default 24)
if ($Mode -eq "Auto" -and -not $Force -and (Test-Path -LiteralPath $StatePath)) {
    try {
        $priorState = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
        $lastCheckValue = Get-OptionalPropertyValue -Object $priorState -Name "lastCheckUtc"
        if ($null -ne $lastCheckValue) {
            $lastCheckUtc = [DateTime]::Parse([string]$lastCheckValue).ToUniversalTime()
            if ([DateTime]::UtcNow -lt $lastCheckUtc.AddHours($checkIntervalHours)) {
                Write-Host "Custom update check is still within its $checkIntervalHours-hour interval."
                return
            }
        }
    } catch {
        # A malformed state file should cause a fresh check, not block launch.
    }
}

$packageJson = Get-Content -Raw -LiteralPath $PackageJsonPath | ConvertFrom-Json
$currentVersionText = [string]$packageJson.version
$currentVersion = ConvertTo-ComparableVersion -Value $currentVersionText

$release = if (-not [string]::IsNullOrWhiteSpace($ReleaseMetadataPath)) {
    Get-Content -Raw -LiteralPath (Resolve-Path -LiteralPath $ReleaseMetadataPath) | ConvertFrom-Json
} else {
    $releaseUri = "https://api.github.com/repos/$repositoryName/releases/latest"
    Invoke-RestMethod -Uri $releaseUri -Headers @{
        Accept = "application/vnd.github+json"
        "User-Agent" = "GPT-Codex-Custom-Updater/$currentVersionText"
        "X-GitHub-Api-Version" = "2022-11-28"
    } -TimeoutSec 20
}

if ([bool](Get-OptionalPropertyValue -Object $release -Name "draft" -Default $false) -or
    [bool](Get-OptionalPropertyValue -Object $release -Name "prerelease" -Default $false)) {
    throw "The selected release is not a stable published release."
}
$releaseTag = [string](Get-OptionalPropertyValue -Object $release -Name "tag_name")
$availableVersion = ConvertTo-ComparableVersion -Value $releaseTag
$availableVersionText = $releaseTag.TrimStart("v")
$updateAvailable = $availableVersion -gt $currentVersion

Write-UpdateState -Values @{
    lastCheckUtc = [DateTime]::UtcNow.ToString("o")
    currentVersion = $currentVersionText
    latestVersion = $availableVersionText
    updateAvailable = $updateAvailable
    repository = $repositoryName
}

$summary = [PSCustomObject][ordered]@{
    repository = $repositoryName
    currentVersion = $currentVersionText
    latestVersion = $availableVersionText
    updateAvailable = $updateAvailable
}
if ($Mode -eq "Check" -or -not $updateAvailable) {
    $summary | Format-List
    return
}

$modificationSummary = Get-LocalModificationSummary
if (-not $Force -and -not [string]::IsNullOrWhiteSpace($modificationSummary)) {
    $message = "Update $availableVersionText is available, but automatic overwrite was skipped because local source changes were found: $modificationSummary"
    if ($Mode -eq "Auto") {
        Write-Warning $message
        return
    }
    throw "$message`nCommit, revert, or back up those changes, then retry. Use -Force only if overwriting them is intentional."
}

$runningCustomProcesses = @(Get-CustomRuntimeProcess)
if ($runningCustomProcesses.Count -gt 0) {
    $processIds = ($runningCustomProcesses.ProcessId | Sort-Object -Unique) -join ", "
    $message = "Update $availableVersionText is available, but the custom app is running (PIDs: $processIds). Close it before applying the update."
    if ($Mode -eq "Auto") {
        Write-Warning $message
        return
    }
    throw $message
}

$assetName = [string](Get-OptionalPropertyValue -Object $config -Name "assetName")
$checksumAssetName = [string](Get-OptionalPropertyValue -Object $config -Name "checksumAssetName")
$DownloadRoot = Join-Path $UpdateRoot ("download-" + [Guid]::NewGuid().ToString("N"))
$ExtractRoot = Join-Path $DownloadRoot "extracted"
$DownloadedAsset = Join-Path $DownloadRoot $assetName
$DownloadedChecksum = Join-Path $DownloadRoot $checksumAssetName
foreach ($path in @($UpdateRoot, $DownloadRoot, $ExtractRoot, $DownloadedAsset, $DownloadedChecksum)) {
    Assert-ProjectPath $path
}
New-Item -ItemType Directory -Force -Path $DownloadRoot, $ExtractRoot | Out-Null

$backupRoot = $null
$newlyCreatedFiles = [System.Collections.Generic.List[string]]::new()
$appliedFiles = [System.Collections.Generic.List[string]]::new()
try {
    if (-not [string]::IsNullOrWhiteSpace($AssetPath)) {
        Copy-Item -LiteralPath (Resolve-Path -LiteralPath $AssetPath) -Destination $DownloadedAsset -Force
    } else {
        $asset = @($release.assets) | Where-Object { [string]$_.name -eq $assetName } | Select-Object -First 1
        if ($null -eq $asset) {
            throw "Release $releaseTag does not contain $assetName."
        }
        Invoke-WebRequest -Uri ([string]$asset.browser_download_url) -OutFile $DownloadedAsset -Headers @{
            "User-Agent" = "GPT-Codex-Custom-Updater/$currentVersionText"
        } -TimeoutSec 60
    }

    if (-not [string]::IsNullOrWhiteSpace($ChecksumPath)) {
        Copy-Item -LiteralPath (Resolve-Path -LiteralPath $ChecksumPath) -Destination $DownloadedChecksum -Force
    } else {
        $checksumAsset = @($release.assets) | Where-Object { [string]$_.name -eq $checksumAssetName } | Select-Object -First 1
        if ($null -eq $checksumAsset) {
            throw "Release $releaseTag does not contain $checksumAssetName."
        }
        Invoke-WebRequest -Uri ([string]$checksumAsset.browser_download_url) -OutFile $DownloadedChecksum -Headers @{
            "User-Agent" = "GPT-Codex-Custom-Updater/$currentVersionText"
        } -TimeoutSec 30
    }

    $checksumText = Get-Content -Raw -LiteralPath $DownloadedChecksum
    if ($checksumText -notmatch '(?i)\b([A-F0-9]{64})\b') {
        throw "The release checksum file does not contain a SHA-256 value."
    }
    $expectedAssetHash = $Matches[1].ToUpperInvariant()
    $actualAssetHash = (Get-FileHash -LiteralPath $DownloadedAsset -Algorithm SHA256).Hash
    if ($actualAssetHash -ne $expectedAssetHash) {
        throw "The downloaded update checksum does not match the published SHA-256 value."
    }

    # Inspect archive names before extraction so a crafted entry cannot escape
    # the update staging root or exploit a Windows alternate-data-stream name.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($DownloadedAsset)
    try {
        $archivePaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $archive.Entries) {
            $entryPath = $entry.FullName.Replace("\", "/")
            $isDirectory = [string]::IsNullOrEmpty($entry.Name)
            $syntaxPath = if ($isDirectory) { $entryPath.TrimEnd("/") } else { $entryPath }
            if (-not (Test-SafeRelativePathSyntax -RelativePath $syntaxPath)) {
                throw "The update archive contains an unsafe path: $entryPath"
            }
            if (-not $archivePaths.Add($entryPath)) {
                throw "The update archive contains a duplicate path: $entryPath"
            }

            if ($isDirectory) {
                $directoryAllowed = $false
                foreach ($root in $AllowedDirectoryRoots) {
                    if ($syntaxPath -eq $root -or $syntaxPath.StartsWith("$root/", [System.StringComparison]::OrdinalIgnoreCase)) {
                        $directoryAllowed = $true
                        break
                    }
                }
                if (-not $directoryAllowed) {
                    throw "The update archive contains a directory outside the maintained-source allowlist: $entryPath"
                }
            } elseif ($entryPath -ne "release-manifest.json" -and
                -not (Test-AllowedRelativePath -RelativePath $entryPath)) {
                throw "The update archive contains a file outside the maintained-source allowlist: $entryPath"
            }
        }
    } finally {
        $archive.Dispose()
    }

    Expand-Archive -LiteralPath $DownloadedAsset -DestinationPath $ExtractRoot -Force
    $incomingManifestPath = Join-Path $ExtractRoot "release-manifest.json"
    if (-not (Test-Path -LiteralPath $incomingManifestPath -PathType Leaf)) {
        throw "The update package is missing release-manifest.json."
    }
    $incomingManifest = Get-Content -Raw -LiteralPath $incomingManifestPath | ConvertFrom-Json
    if ([int]$incomingManifest.schemaVersion -ne 1 -or [string]$incomingManifest.project -ne "GPTCodexCustom") {
        throw "The update package manifest is not for GPTCodexCustom schema 1."
    }
    if ((ConvertTo-ComparableVersion -Value ([string]$incomingManifest.version)) -ne $availableVersion) {
        throw "The update package version does not match release $releaseTag."
    }

    $manifestPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($incomingManifest.files)) {
        $relativePath = [string]$entry.path
        if (-not (Test-AllowedRelativePath -RelativePath $relativePath)) {
            throw "The update manifest contains a path outside the maintained source allowlist: $relativePath"
        }
        if (-not $manifestPaths.Add($relativePath)) {
            throw "The update manifest contains a duplicate path: $relativePath"
        }
        $incomingPath = Join-Path $ExtractRoot $relativePath.Replace("/", "\")
        if (-not (Test-Path -LiteralPath $incomingPath -PathType Leaf)) {
            throw "The update package is missing a manifest file: $relativePath"
        }
        if ((Get-FileHash -LiteralPath $incomingPath -Algorithm SHA256).Hash -ne [string]$entry.sha256) {
            throw "The update package failed its per-file hash check: $relativePath"
        }
    }

    $unexpectedFiles = @(
        Get-ChildItem -LiteralPath $ExtractRoot -Recurse -File -Force |
            ForEach-Object { $_.FullName.Substring($ExtractRoot.Length + 1).Replace("\", "/") } |
            Where-Object { $_ -ne "release-manifest.json" -and -not $manifestPaths.Contains($_) }
    )
    if ($unexpectedFiles.Count -gt 0) {
        throw "The update package contains unlisted files: $($unexpectedFiles -join ', ')"
    }

    $backupRoot = Join-Path $UpdateRoot ("backup-$currentVersionText-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
    Assert-ProjectPath $backupRoot
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

    # Remove maintained files retired by the new release. Each one is backed up
    # first and is restored by the same rollback path as a replaced file.
    if (Test-Path -LiteralPath $CurrentManifestPath -PathType Leaf) {
        $currentManifest = Get-Content -Raw -LiteralPath $CurrentManifestPath | ConvertFrom-Json
        foreach ($entry in @($currentManifest.files)) {
            $relativePath = [string]$entry.path
            if (-not (Test-AllowedRelativePath -RelativePath $relativePath)) {
                throw "The current release manifest contains a path outside the maintained-source allowlist: $relativePath"
            }
            if ($manifestPaths.Contains($relativePath)) {
                continue
            }

            $targetPath = Join-Path $ProjectRoot $relativePath.Replace("/", "\")
            Assert-ProjectPath $targetPath
            if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
                $backupPath = Join-Path $backupRoot $relativePath.Replace("/", "\")
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupPath) | Out-Null
                Copy-Item -LiteralPath $targetPath -Destination $backupPath -Force
                Remove-Item -LiteralPath $targetPath -Force
            }
        }
    }

    foreach ($entry in @($incomingManifest.files)) {
        $relativePath = [string]$entry.path
        $targetPath = Join-Path $ProjectRoot $relativePath.Replace("/", "\")
        Assert-ProjectPath $targetPath
        if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
            $backupPath = Join-Path $backupRoot $relativePath.Replace("/", "\")
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupPath) | Out-Null
            Copy-Item -LiteralPath $targetPath -Destination $backupPath -Force
        } else {
            $newlyCreatedFiles.Add($targetPath)
        }

        $incomingPath = Join-Path $ExtractRoot $relativePath.Replace("/", "\")
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
        Copy-Item -LiteralPath $incomingPath -Destination $targetPath -Force
        $appliedFiles.Add($targetPath)
    }

    if (Test-Path -LiteralPath $CurrentManifestPath -PathType Leaf) {
        Copy-Item -LiteralPath $CurrentManifestPath -Destination (Join-Path $backupRoot "release-manifest.json") -Force
    } else {
        $newlyCreatedFiles.Add($CurrentManifestPath)
    }
    Copy-Item -LiteralPath $incomingManifestPath -Destination $CurrentManifestPath -Force

    if (-not $SkipBuild) {
        Push-Location $ProjectRoot
        try {
            Invoke-ProjectCommand -Name "Installing pinned Node dependencies..." -Command { & npm ci }
            Invoke-ProjectCommand -Name "Rebuilding the isolated runtime..." -Command { & npm run build }
            Invoke-ProjectCommand -Name "Verifying the updated runtime..." -Command { & npm run verify }
        } finally {
            Pop-Location
        }
    }

    Write-UpdateState -Values @{
        currentVersion = $availableVersionText
        lastAppliedVersion = $availableVersionText
        lastAppliedUtc = [DateTime]::UtcNow.ToString("o")
        lastBackupPath = $backupRoot
        updateAvailable = $false
    }
    Write-Host "Updated GPT + Codex Custom to $availableVersionText." -ForegroundColor Green
    Write-Host "Backup: $backupRoot"
} catch {
    $failure = $_
    $rollbackFailure = $null
    try {
        foreach ($newFile in @($newlyCreatedFiles | Sort-Object { $_.Length } -Descending)) {
            Assert-ProjectPath $newFile
            if (Test-Path -LiteralPath $newFile -PathType Leaf) {
                Remove-Item -LiteralPath $newFile -Force
            }
        }
        if ($null -ne $backupRoot -and (Test-Path -LiteralPath $backupRoot -PathType Container)) {
            foreach ($backupFile in Get-ChildItem -LiteralPath $backupRoot -Recurse -File -Force) {
                $relativePath = $backupFile.FullName.Substring($backupRoot.Length + 1)
                $restorePath = Join-Path $ProjectRoot $relativePath
                Assert-ProjectPath $restorePath
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $restorePath) | Out-Null
                Copy-Item -LiteralPath $backupFile.FullName -Destination $restorePath -Force
            }
        }

        if (-not $SkipBuild -and (Test-Path -LiteralPath $PackageJsonPath)) {
            Push-Location $ProjectRoot
            try {
                & npm ci | Out-Host
                if ($LASTEXITCODE -eq 0) {
                    & npm run build | Out-Host
                    if ($LASTEXITCODE -eq 0) {
                        & npm run verify | Out-Host
                    }
                }
            } finally {
                Pop-Location
            }
        }
    } catch {
        $rollbackFailure = $_
    }

    if ($null -ne $rollbackFailure) {
        throw "The update failed and rollback also failed. Update error: $failure Rollback error: $rollbackFailure"
    }
    throw "The update failed and the prior source was restored. Error: $failure"
} finally {
    Assert-ProjectPath $DownloadRoot
    if (Test-Path -LiteralPath $DownloadRoot) {
        Remove-Item -LiteralPath $DownloadRoot -Recurse -Force
    }
}
