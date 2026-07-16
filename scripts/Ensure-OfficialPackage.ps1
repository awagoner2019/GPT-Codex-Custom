[CmdletBinding()]
param(
    [switch]$VerifyDownloadOnly,
    [switch]$KeepInstaller,

    [ValidateRange(1, 30)]
    [int]$TimeoutMinutes = 10,

    [string]$InstallerUrl = "https://get.microsoft.com/installer/download/9PLM9XGG6VKS?cid=website_cta_psi",

    [Parameter(DontShow = $true)]
    [scriptblock]$PackageResolver = {
        param([string]$RequestedName)
        @(Get-AppxPackage -Name $RequestedName -ErrorAction SilentlyContinue)
    },

    [Parameter(DontShow = $true)]
    [scriptblock]$DownloadAction = {
        param([string]$Uri, [string]$Destination)
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
    },

    [Parameter(DontShow = $true)]
    [scriptblock]$InstallerLauncher = {
        param([string]$Executable)
        Start-Process -FilePath $Executable -PassThru
    },

    [Parameter(DontShow = $true)]
    [scriptblock]$DelayAction = {
        param([int]$Seconds)
        Start-Sleep -Seconds $Seconds
    },

    [Parameter(DontShow = $true)]
    [scriptblock]$UtcNowProvider = {
        [DateTime]::UtcNow
    }
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$PackageName = "OpenAI.Codex"
$StoreProductId = "9PLM9XGG6VKS"
$ExpectedInstallerHost = "get.microsoft.com"
$ExpectedSigner = "Microsoft Corporation"
$ExpectedCompany = "Microsoft Corporation"
$ExpectedProduct = "Store Installer"
$DownloadRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    "gpt-codex-custom-installer-" + [Guid]::NewGuid().ToString("N")
)
$InstallerPath = Join-Path $DownloadRoot "ChatGPT Installer.exe"
$installerProcess = $null
$packageReady = $false

function Get-OfficialPackage {
    @(& $PackageResolver $PackageName) |
        Sort-Object Version -Descending |
        Select-Object -First 1
}

function Assert-InstallerUri {
    param([Parameter(Mandatory = $true)][string]$Value)

    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) {
        throw "The official installer URL is invalid: $Value"
    }
    if ($uri.Scheme -cne "https") {
        throw "Refusing a non-HTTPS official installer URL: $Value"
    }
    if ($uri.DnsSafeHost -ine $ExpectedInstallerHost) {
        throw "Refusing an installer URL outside ${ExpectedInstallerHost}: $Value"
    }
    if ($uri.AbsolutePath -ine "/installer/download/$StoreProductId") {
        throw "The installer URL does not target the expected ChatGPT product $StoreProductId."
    }
}

function Assert-OfficialInstaller {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path
    if ($item.Length -lt 100KB -or $item.Length -gt 25MB) {
        throw "The downloaded installer has an unexpected size: $($item.Length) bytes."
    }

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        if ($stream.ReadByte() -ne 0x4D -or $stream.ReadByte() -ne 0x5A) {
            throw "The downloaded file is not a Windows executable."
        }
    } finally {
        $stream.Dispose()
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "The official installer signature is not valid: $($signature.StatusMessage)"
    }
    if ($null -eq $signature.SignerCertificate) {
        throw "The official installer has no signer certificate."
    }

    $signerName = $signature.SignerCertificate.GetNameInfo(
        [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
        $false
    )
    if ($signerName -cne $ExpectedSigner) {
        throw "The installer signer is '$signerName', not '$ExpectedSigner'."
    }
    if ($item.VersionInfo.CompanyName -cne $ExpectedCompany) {
        throw "The installer company is '$($item.VersionInfo.CompanyName)', not '$ExpectedCompany'."
    }
    if ($item.VersionInfo.ProductName -cne $ExpectedProduct) {
        throw "The downloaded executable is '$($item.VersionInfo.ProductName)', not '$ExpectedProduct'."
    }

    [PSCustomObject]@{
        Path = $item.FullName
        Length = $item.Length
        Sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
        SignatureStatus = [string]$signature.Status
        Signer = $signerName
        Company = $item.VersionInfo.CompanyName
        Product = $item.VersionInfo.ProductName
        FileVersion = $item.VersionInfo.FileVersion
        ProductId = $StoreProductId
        Source = $InstallerUrl
    }
}

$installed = Get-OfficialPackage
if ($null -ne $installed -and -not $VerifyDownloadOnly) {
    Write-Host "Official ChatGPT/Codex package already installed: $($installed.PackageFullName)"
    return [PSCustomObject]@{
        PackageName = $installed.Name
        PackageFullName = $installed.PackageFullName
        InstallLocation = $installed.InstallLocation
        BootstrapUsed = $false
    }
}

Assert-InstallerUri -Value $InstallerUrl
New-Item -ItemType Directory -Force -Path $DownloadRoot | Out-Null

try {
    Write-Host "Downloading Microsoft's official signed ChatGPT installer..."
    $previousSecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol
    try {
        [System.Net.ServicePointManager]::SecurityProtocol = (
            $previousSecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
        )
        $downloaded = $false
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try {
                & $DownloadAction $InstallerUrl $InstallerPath
                if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
                    throw "The download completed without creating the installer file."
                }
                $downloaded = $true
                break
            } catch {
                if ($attempt -ge 3) {
                    throw "The official installer download failed after 3 attempts: $($_.Exception.Message)"
                }
                Write-Warning "Official installer download attempt $attempt failed; retrying."
                & $DelayAction $attempt
            }
        }
        if (-not $downloaded) {
            throw "The official installer download did not complete."
        }
    } finally {
        [System.Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
    }

    $installer = Assert-OfficialInstaller -Path $InstallerPath
    Write-Host "Verified Microsoft signature and SHA-256 $($installer.Sha256)." -ForegroundColor Green

    if ($VerifyDownloadOnly) {
        Write-Host "Official installer bootstrap verification passed; nothing was installed." -ForegroundColor Green
        return [PSCustomObject]@{
            Length = $installer.Length
            Sha256 = $installer.Sha256
            SignatureStatus = $installer.SignatureStatus
            Signer = $installer.Signer
            Company = $installer.Company
            Product = $installer.Product
            FileVersion = $installer.FileVersion
            ProductId = $installer.ProductId
            Source = $installer.Source
            TemporaryFileRemoved = (-not $KeepInstaller)
            Path = if ($KeepInstaller) { $InstallerPath } else { $null }
        }
    }

    Write-Host "Opening the official installer. Complete its prompt; setup will continue automatically."
    $installerProcess = & $InstallerLauncher $InstallerPath
    if ($null -eq $installerProcess) {
        throw "The official installer launcher did not return a process handle."
    }
    $deadline = (& $UtcNowProvider).AddMinutes($TimeoutMinutes)
    $nonzeroExitObservedAt = $null
    $lastInstallerExitCode = $null

    do {
        & $DelayAction 2
        $now = & $UtcNowProvider
        $installed = Get-OfficialPackage
        if ($null -ne $installed) {
            Write-Host "Official package is ready: $($installed.PackageFullName)" -ForegroundColor Green
            $packageReady = $true
            return [PSCustomObject]@{
                PackageName = $installed.Name
                PackageFullName = $installed.PackageFullName
                InstallLocation = $installed.InstallLocation
                BootstrapUsed = $true
                InstallerSha256 = $installer.Sha256
            }
        }

        if ($installerProcess.HasExited -and $installerProcess.ExitCode -ne 0) {
            $lastInstallerExitCode = [int]$installerProcess.ExitCode
            if ($null -eq $nonzeroExitObservedAt) {
                $nonzeroExitObservedAt = $now
            } elseif (($now - $nonzeroExitObservedAt).TotalSeconds -ge 10) {
                throw "The official installer exited with code $lastInstallerExitCode before the package was available."
            }
        }
    } while ($now -lt $deadline)

    $exitDetail = if ($null -ne $lastInstallerExitCode) {
        " The last installer exit code was $lastInstallerExitCode."
    } else {
        ""
    }
    throw "Timed out waiting for the official ChatGPT/Codex package after $TimeoutMinutes minute(s).$exitDetail Finish or reopen the installer, then run npm run setup again."
} finally {
    if ($packageReady -and $null -ne $installerProcess -and -not $installerProcess.HasExited) {
        $waitMethod = $installerProcess.PSObject.Methods["WaitForExit"]
        if ($null -ne $waitMethod) {
            $null = $installerProcess.WaitForExit(5000)
        }
    }
    $installerStillRunning = ($null -ne $installerProcess -and -not $installerProcess.HasExited)
    if (-not $KeepInstaller -and -not $installerStillRunning -and (Test-Path -LiteralPath $DownloadRoot)) {
        try {
            Remove-Item -LiteralPath $DownloadRoot -Recurse -Force
        } catch {
            Write-Warning "Could not remove the temporary official installer at $DownloadRoot."
        }
    } elseif (-not $KeepInstaller -and $installerStillRunning) {
        Write-Warning "The official installer is still open, so its temporary file remains at $InstallerPath."
    } elseif ($KeepInstaller) {
        Write-Host "Kept the verified installer at $InstallerPath"
    }
}
