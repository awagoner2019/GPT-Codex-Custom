[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$RuntimeExe = Join-Path $ProjectRoot "work\runtime\ChatGPT.exe"
$PatchedAssets = Join-Path $ProjectRoot "work\patched-src\webview\assets"
$CustomJs = Join-Path $PatchedAssets "gpt-codex-custom.js"
$CustomCss = Join-Path $PatchedAssets "gpt-codex-custom.css"
$DiagnosticsFile = Join-Path $ProjectRoot "profile\chromium\gpt-codex-custom-diagnostics.json"
$SelfTestFile = Join-Path $ProjectRoot "profile\chromium\gpt-codex-custom-self-test-result.json"
$PatchedAppMain = @(Get-ChildItem -LiteralPath $PatchedAssets -Filter "app-main-*.js")

foreach ($requiredPath in @($RuntimeExe, $CustomJs, $CustomCss, $DiagnosticsFile, $SelfTestFile)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Delete-chat verification path is missing: $requiredPath"
    }
}
if ($PatchedAppMain.Count -ne 1) {
    throw "Expected exactly one patched app-main bundle, found $($PatchedAppMain.Count)."
}

$runtimePath = [System.IO.Path]::GetFullPath($RuntimeExe)
$runtimeRunning = $null -ne (Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object {
    $_.ExecutablePath -and
    [System.IO.Path]::GetFullPath($_.ExecutablePath) -eq $runtimePath
})
$appMainText = Get-Content -Raw -LiteralPath $PatchedAppMain[0].FullName
$customJsText = Get-Content -Raw -LiteralPath $CustomJs
$customCssText = Get-Content -Raw -LiteralPath $CustomCss
$diagnostics = Get-Content -Raw -LiteralPath $DiagnosticsFile | ConvertFrom-Json
$selfTest = Get-Content -Raw -LiteralPath $SelfTestFile | ConvertFrom-Json

$results = [ordered]@{
    customRuntimeRunning = $runtimeRunning
    nativeDeleteBridgeIntegrated = (
        $appMainText.Contains("GPT_CODEX_CUSTOM_CHAT_ACTIONS") -and
        $appMainText.Contains("a.get(WS).delete(t)") -and
        $customJsText.Contains("openChatDeleteDialog")
    )
    sidebarDeleteUiIntegrated = (
        $customJsText.Contains("gpt-codex-custom-chat-conversation-menu") -and
        $customCssText.Contains(".gpt-codex-custom-chat-conversation-menu") -and
        $customCssText.Contains(".gpt-codex-custom-chat-delete-dialog")
    )
    runtimeDeleteBridgeReady = ($diagnostics.customSidebarNativeDeleteReady -eq $true)
    conversationMenuControlWorks = ($selfTest.conversationMenuControlVisible -eq $true)
    conversationMenuOpens = ($selfTest.conversationMenuOpens -eq $true)
    deleteConfirmationOpens = ($selfTest.deleteConfirmationOpens -eq $true)
    cancelPreservesConversation = ($selfTest.deleteCancelPreservesChat -eq $true)
    nativeDeleteDryRunWorks = ($selfTest.nativeChatDeleteBridgeReady -eq $true -and $selfTest.deleteDryRunWorks -eq $true)
    deleteDryRunPreservesConversation = ($selfTest.deleteDryRunPreservesChat -eq $true)
}

$results.GetEnumerator() | ForEach-Object {
    [PSCustomObject]@{ Check = $_.Key; Passed = $_.Value }
} | Format-Table -AutoSize

$failed = @($results.GetEnumerator() | Where-Object { -not $_.Value })
if ($failed.Count -gt 0) {
    throw "Delete-chat verification failed: $($failed.Key -join ', ')"
}

Write-Host "Delete-chat verification passed." -ForegroundColor Green
