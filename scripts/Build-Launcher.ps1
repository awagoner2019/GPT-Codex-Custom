[CmdletBinding()]
param(
    [string]$OutputPath,
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $ProjectRoot "GPT-Codex-Custom.exe"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path $ProjectRoot $OutputPath
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$SourcePath = Join-Path $PSScriptRoot "launcher\GPTCodexCustomLauncher.cs"
$ManifestPath = Join-Path $PSScriptRoot "launcher\GPTCodexCustomLauncher.manifest"
$PackageJsonPath = Join-Path $ProjectRoot "package.json"
$GuiLaunchScript = Join-Path $PSScriptRoot "Launch-Custom-Gui.ps1"
$ConsoleLaunchScript = Join-Path $PSScriptRoot "Launch-Custom.ps1"
$TestScript = Join-Path $PSScriptRoot "Test-Launcher.ps1"
$StageRoot = Join-Path $ProjectRoot ("work\launcher-build-" + [Guid]::NewGuid().ToString("N"))
$StageExecutable = Join-Path $StageRoot "GPT-Codex-Custom.exe"
$AssemblyInfoPath = Join-Path $StageRoot "AssemblyInfo.cs"
$IconPath = Join-Path $StageRoot "GPT-Codex-Custom.ico"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Assert-ProjectPath {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPrefix = $ProjectRoot.TrimEnd("\") + "\"
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to write a launcher path outside the project: $fullPath"
    }
}

function Get-CSharpCompiler {
    $candidates = @(
        (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
        (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }
    $command = Get-Command csc.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
        return $command.Source
    }
    throw "The Windows .NET Framework C# compiler was not found. Enable or repair .NET Framework 4.8 and retry."
}

function New-LauncherIcon {
    param([Parameter(Mandatory)][string]$Path)

    Add-Type -AssemblyName System.Drawing
    $bitmap = [System.Drawing.Bitmap]::new(
        64,
        64,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $iconHandle = [IntPtr]::Zero
    $icon = $null
    $stream = $null
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.Clear([System.Drawing.Color]::Transparent)

        $background = [System.Drawing.RectangleF]::new(3, 3, 58, 58)
        $gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            $background,
            [System.Drawing.Color]::FromArgb(255, 113, 71, 255),
            [System.Drawing.Color]::FromArgb(255, 40, 190, 182),
            35.0
        )
        $darkBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(238, 20, 20, 24))
        $whiteBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
        $font = [System.Drawing.Font]::new("Segoe UI", 20, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        try {
            $graphics.FillEllipse($gradient, $background)
            $graphics.FillEllipse($darkBrush, [System.Drawing.RectangleF]::new(8, 8, 48, 48))
            $text = "G+"
            $textSize = $graphics.MeasureString($text, $font)
            $graphics.DrawString(
                $text,
                $font,
                $whiteBrush,
                (64 - $textSize.Width) / 2,
                (64 - $textSize.Height) / 2 - 1
            )
        } finally {
            $font.Dispose()
            $whiteBrush.Dispose()
            $darkBrush.Dispose()
            $gradient.Dispose()
        }

        $iconHandle = $bitmap.GetHicon()
        $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
        $icon.Save($stream)
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $icon) { $icon.Dispose() }
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

Assert-ProjectPath $OutputPath
Assert-ProjectPath $StageRoot
foreach ($requiredPath in @(
    $SourcePath,
    $ManifestPath,
    $PackageJsonPath,
    $GuiLaunchScript,
    $ConsoleLaunchScript,
    $TestScript
)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required launcher source is missing: $requiredPath"
    }
}

$compiler = Get-CSharpCompiler
if ($CheckOnly) {
    Write-Host "Native launcher prerequisites are available." -ForegroundColor Green
    Write-Host "Compiler: $compiler"
    return
}
$packageVersionText = [string](Get-Content -Raw -LiteralPath $PackageJsonPath | ConvertFrom-Json).version
$packageVersion = [version]$packageVersionText
$assemblyVersion = "{0}.{1}.{2}.0" -f $packageVersion.Major, $packageVersion.Minor, $packageVersion.Build

try {
    New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null
    $assemblyInfo = @"
using System.Reflection;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("GPT + Codex Custom Launcher")]
[assembly: AssemblyDescription("Console-free launcher for the isolated GPT + Codex Custom runtime")]
[assembly: AssemblyCompany("GPT Codex Custom contributors")]
[assembly: AssemblyProduct("GPT + Codex Custom")]
[assembly: AssemblyCopyright("Unofficial community project")]
[assembly: ComVisible(false)]
[assembly: AssemblyVersion("$assemblyVersion")]
[assembly: AssemblyFileVersion("$assemblyVersion")]
[assembly: AssemblyInformationalVersion("$packageVersionText")]
"@
    [System.IO.File]::WriteAllText($AssemblyInfoPath, $assemblyInfo, $utf8NoBom)
    New-LauncherIcon -Path $IconPath

    $compilerArguments = @(
        "/nologo",
        "/target:winexe",
        "/optimize+",
        "/platform:anycpu",
        "/out:$StageExecutable",
        "/win32manifest:$ManifestPath",
        "/win32icon:$IconPath",
        "/reference:System.dll",
        "/reference:System.Core.dll",
        "/reference:System.Windows.Forms.dll",
        $SourcePath,
        $AssemblyInfoPath
    )
    & $compiler @compilerArguments
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $StageExecutable -PathType Leaf)) {
        throw "The native launcher compiler failed with exit code $LASTEXITCODE."
    }

    Copy-Item -LiteralPath $StageExecutable -Destination $OutputPath -Force
    & $TestScript -PassThru | Out-Null
    Write-Host "Native GPT + Codex Custom launcher built successfully." -ForegroundColor Green
    Write-Host "Launcher: $OutputPath"
    Write-Host "SHA-256: $((Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash)"
} finally {
    Assert-ProjectPath $StageRoot
    if (Test-Path -LiteralPath $StageRoot) {
        Remove-Item -LiteralPath $StageRoot -Recurse -Force
    }
}
