[CmdletBinding()]
param(
    [string]$RuntimeRootOverride,
    [string]$UpstreamSourceOverride
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$WorkRoot = Join-Path $ProjectRoot "work"
$UpstreamSource = if ([string]::IsNullOrWhiteSpace($UpstreamSourceOverride)) {
    Join-Path $WorkRoot "upstream-src"
} else {
    [System.IO.Path]::GetFullPath($UpstreamSourceOverride)
}
$PatchedSource = Join-Path $WorkRoot "patched-src"
$RepackedRoot = Join-Path $WorkRoot "repacked"
$RuntimeRoot = if ([string]::IsNullOrWhiteSpace($RuntimeRootOverride)) {
    Join-Path $WorkRoot "runtime"
} else {
    [System.IO.Path]::GetFullPath($RuntimeRootOverride)
}
$RuntimeResources = Join-Path $RuntimeRoot "resources"
$CustomRoot = Join-Path $ProjectRoot "custom"
$AsarCli = Join-Path $ProjectRoot "node_modules\@electron\asar\bin\asar.js"
$OutputArchive = Join-Path $RepackedRoot "app.asar"
$UpstreamManifestPath = Join-Path $ProjectRoot "upstream.json"
$LauncherBuildScript = Join-Path $PSScriptRoot "Build-Launcher.ps1"

if (-not (Test-Path -LiteralPath $UpstreamManifestPath)) {
    throw "Upstream manifest is missing: $UpstreamManifestPath"
}
$UpstreamManifest = Get-Content -Raw -LiteralPath $UpstreamManifestPath | ConvertFrom-Json

function Assert-ProjectPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPrefix = $ProjectRoot.TrimEnd("\") + "\"
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the project: $fullPath"
    }
}

function Replace-UniqueSupportedSequence {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][object[]]$Sequences,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $matches = @()
    foreach ($sequence in $Sequences) {
        $name = [string]$sequence.Name
        $needle = [string]$sequence.Needle
        $replacement = [string]$sequence.Replacement
        if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrEmpty($needle)) {
            throw "Invalid supported sequence definition for $Description."
        }

        $firstMatch = $Text.IndexOf($needle, [System.StringComparison]::Ordinal)
        if ($firstMatch -lt 0) {
            continue
        }
        if ($Text.IndexOf($needle, $firstMatch + $needle.Length, [System.StringComparison]::Ordinal) -ge 0) {
            throw "Found more than one $Description for supported layout '$name'."
        }

        $matches += [pscustomobject]@{
            Name = $name
            Needle = $needle
            Replacement = $replacement
            Index = $firstMatch
        }
    }

    if ($matches.Count -eq 0) {
        throw "Could not find a supported $Description."
    }
    if ($matches.Count -ne 1) {
        throw "Found more than one supported $Description."
    }

    $match = $matches[0]
    return $Text.Substring(0, $match.Index) +
        $match.Replacement +
        $Text.Substring($match.Index + $match.Needle.Length)
}

Assert-ProjectPath $RuntimeRoot

foreach ($requiredPath in @(
    $UpstreamSource,
    $RuntimeResources,
    $AsarCli,
    $LauncherBuildScript,
    (Join-Path $CustomRoot "gpt-codex-custom.css"),
    (Join-Path $CustomRoot "gpt-codex-custom.js"),
    (Join-Path $CustomRoot "gpt-codex-token-hud.css"),
    (Join-Path $CustomRoot "gpt-codex-token-hud.js"),
    (Join-Path $CustomRoot "gpt-codex-pinboard.css"),
    (Join-Path $CustomRoot "gpt-codex-pinboard.js"),
    (Join-Path $CustomRoot "gpt-codex-model-picker.css"),
    (Join-Path $CustomRoot "gpt-codex-model-picker.js")
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required path is missing: $requiredPath"
    }
}

foreach ($generatedPath in @($PatchedSource, $RepackedRoot)) {
    Assert-ProjectPath $generatedPath
    if (Test-Path -LiteralPath $generatedPath) {
        Remove-Item -LiteralPath $generatedPath -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $generatedPath | Out-Null
}

Get-ChildItem -LiteralPath $UpstreamSource -Force |
    Copy-Item -Destination $PatchedSource -Recurse -Force

$PatchedAssets = Join-Path $PatchedSource "webview\assets"
$CustomCssSource = Join-Path $CustomRoot "gpt-codex-custom.css"
$CustomJsSource = Join-Path $CustomRoot "gpt-codex-custom.js"
$TokenHudCssSource = Join-Path $CustomRoot "gpt-codex-token-hud.css"
$TokenHudJsSource = Join-Path $CustomRoot "gpt-codex-token-hud.js"
$PinboardCssSource = Join-Path $CustomRoot "gpt-codex-pinboard.css"
$PinboardJsSource = Join-Path $CustomRoot "gpt-codex-pinboard.js"
$ModelPickerCssSource = Join-Path $CustomRoot "gpt-codex-model-picker.css"
$ModelPickerJsSource = Join-Path $CustomRoot "gpt-codex-model-picker.js"
Copy-Item -LiteralPath $CustomCssSource -Destination $PatchedAssets -Force
Copy-Item -LiteralPath $CustomJsSource -Destination $PatchedAssets -Force
Copy-Item -LiteralPath $TokenHudCssSource -Destination $PatchedAssets -Force
Copy-Item -LiteralPath $TokenHudJsSource -Destination $PatchedAssets -Force
Copy-Item -LiteralPath $PinboardCssSource -Destination $PatchedAssets -Force
Copy-Item -LiteralPath $PinboardJsSource -Destination $PatchedAssets -Force
Copy-Item -LiteralPath $ModelPickerCssSource -Destination $PatchedAssets -Force
Copy-Item -LiteralPath $ModelPickerJsSource -Destination $PatchedAssets -Force
$CustomCssVersion = (Get-FileHash -LiteralPath $CustomCssSource -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
$CustomJsVersion = (Get-FileHash -LiteralPath $CustomJsSource -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
$TokenHudCssVersion = (Get-FileHash -LiteralPath $TokenHudCssSource -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
$TokenHudJsVersion = (Get-FileHash -LiteralPath $TokenHudJsSource -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
$PinboardCssVersion = (Get-FileHash -LiteralPath $PinboardCssSource -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
$PinboardJsVersion = (Get-FileHash -LiteralPath $PinboardJsSource -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
$ModelPickerCssVersion = (Get-FileHash -LiteralPath $ModelPickerCssSource -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
$ModelPickerJsVersion = (Get-FileHash -LiteralPath $ModelPickerJsSource -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
$CustomCssAssetName = "gpt-codex-custom-$CustomCssVersion.css"
$CustomJsAssetName = "gpt-codex-custom-$CustomJsVersion.js"
$TokenHudCssAssetName = "gpt-codex-token-hud-$TokenHudCssVersion.css"
$TokenHudJsAssetName = "gpt-codex-token-hud-$TokenHudJsVersion.js"
$PinboardCssAssetName = "gpt-codex-pinboard-$PinboardCssVersion.css"
$PinboardJsAssetName = "gpt-codex-pinboard-$PinboardJsVersion.js"
$ModelPickerCssAssetName = "gpt-codex-model-picker-$ModelPickerCssVersion.css"
$ModelPickerJsAssetName = "gpt-codex-model-picker-$ModelPickerJsVersion.js"
Copy-Item -LiteralPath $CustomCssSource -Destination (Join-Path $PatchedAssets $CustomCssAssetName) -Force
Copy-Item -LiteralPath $CustomJsSource -Destination (Join-Path $PatchedAssets $CustomJsAssetName) -Force
Copy-Item -LiteralPath $TokenHudCssSource -Destination (Join-Path $PatchedAssets $TokenHudCssAssetName) -Force
Copy-Item -LiteralPath $TokenHudJsSource -Destination (Join-Path $PatchedAssets $TokenHudJsAssetName) -Force
Copy-Item -LiteralPath $PinboardCssSource -Destination (Join-Path $PatchedAssets $PinboardCssAssetName) -Force
Copy-Item -LiteralPath $PinboardJsSource -Destination (Join-Path $PatchedAssets $PinboardJsAssetName) -Force
Copy-Item -LiteralPath $ModelPickerCssSource -Destination (Join-Path $PatchedAssets $ModelPickerCssAssetName) -Force
Copy-Item -LiteralPath $ModelPickerJsSource -Destination (Join-Path $PatchedAssets $ModelPickerJsAssetName) -Force

$RendererIndex = Join-Path $PatchedSource "webview\index.html"
$html = [System.IO.File]::ReadAllText($RendererIndex)
$marker = "<!-- GPT_CODEX_CUSTOM_INJECT -->"
if ($html.Contains($marker)) {
    throw "The pristine renderer already contains the custom marker. Refresh work/upstream-src."
}
$injection = @"
    $marker
    <link rel="stylesheet" href="./assets/$CustomCssAssetName">
    <link rel="stylesheet" href="./assets/$TokenHudCssAssetName">
    <link rel="stylesheet" href="./assets/$PinboardCssAssetName">
    <link rel="stylesheet" href="./assets/$ModelPickerCssAssetName">
    <script type="module" src="./assets/$TokenHudJsAssetName"></script>
    <script type="module" src="./assets/$PinboardJsAssetName"></script>
    <script type="module" src="./assets/$ModelPickerJsAssetName"></script>
    <script type="module" src="./assets/$CustomJsAssetName"></script>
"@
$appModuleMatches = [regex]::Matches(
    $html,
    '<script type="module" crossorigin src="\./assets/index-[^"]+\.js"></script>'
)
if ($appModuleMatches.Count -ne 1) {
    throw "Expected exactly one renderer entry module, found $($appModuleMatches.Count)."
}
$appModuleTag = $appModuleMatches[0].Value
$html = $html.Replace($appModuleTag, "$injection`r`n    $appModuleTag")
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($RendererIndex, $html, $utf8NoBom)

$BootstrapFile = Get-ChildItem -LiteralPath (Join-Path $PatchedSource ".vite\build") -Filter "bootstrap-*.js"
if (@($BootstrapFile).Count -ne 1) {
    throw "Expected exactly one compiled bootstrap bundle, found $(@($BootstrapFile).Count)."
}

$bootstrapText = [System.IO.File]::ReadAllText($BootstrapFile.FullName)
$singleInstanceNeedle = 'var $=i.l({isMacOS:fe,isPackaged:a.app.isPackaged});if(!(!$||a.app.requestSingleInstanceLock()))'
$singleInstanceReplacement = 'var $=process.env.GPT_CODEX_CUSTOM_BUILD===`1`?!1:i.l({isMacOS:fe,isPackaged:a.app.isPackaged});if(!(!$||a.app.requestSingleInstanceLock()))'
$singleInstanceNeedleNew = 'var $=i.l({isMacOS:ye,isPackaged:a.app.isPackaged});if(!(!$||a.app.requestSingleInstanceLock()))'
$singleInstanceReplacementNew = 'var $=process.env.GPT_CODEX_CUSTOM_BUILD===`1`?!1:i.l({isMacOS:ye,isPackaged:a.app.isPackaged});if(!(!$||a.app.requestSingleInstanceLock()))'
$singleInstanceNeedleLatest = 'var $=i.l({isMacOS:De,isPackaged:a.app.isPackaged});if(!(!$||a.app.requestSingleInstanceLock()))'
$singleInstanceReplacementLatest = 'var $=process.env.GPT_CODEX_CUSTOM_BUILD===`1`?!1:i.l({isMacOS:De,isPackaged:a.app.isPackaged});if(!(!$||a.app.requestSingleInstanceLock()))'
$singleInstanceSequences = @(
    [pscustomobject]@{ Name = "signed 26.707.6957.0 / app 26.707.51957"; Needle = $singleInstanceNeedle; Replacement = $singleInstanceReplacement }
    [pscustomobject]@{ Name = "signed 26.707.8479.0 / app 26.707.62119"; Needle = $singleInstanceNeedleNew; Replacement = $singleInstanceReplacementNew }
    [pscustomobject]@{ Name = "signed 26.707.9564.0 / app 26.707.71524"; Needle = $singleInstanceNeedleLatest; Replacement = $singleInstanceReplacementLatest }
)
$bootstrapText = Replace-UniqueSupportedSequence -Text $bootstrapText -Sequences $singleInstanceSequences -Description "single-instance bootstrap sequence"
[System.IO.File]::WriteAllText($BootstrapFile.FullName, $bootstrapText, $utf8NoBom)

$MainFile = Get-ChildItem -LiteralPath (Join-Path $PatchedSource ".vite\build") -Filter "main-*.js"
if (@($MainFile).Count -ne 1) {
    throw "Expected exactly one compiled main bundle, found $(@($MainFile).Count)."
}

$mainText = [System.IO.File]::ReadAllText($MainFile.FullName)
$readySelfTestNeedle = 'this.samplerManager.handleRendererReady(e),M$().info(`Handled ''ready'' message, sent ide-context-updated`);break;case`open-in-main-window`:'
$readySelfTestReplacement = 'this.samplerManager.handleRendererReady(e),M$().info(`Handled ''ready'' message, sent ide-context-updated`),process.env.GPT_CODEX_CUSTOM_SELF_TEST===`1`&&setTimeout(()=>{this.windowManager.sendMessageToWebContents(e,{type:`gpt-codex-custom-run-self-test`})},5e3);break;case`open-in-main-window`:'
$readySelfTestNeedleNew = 'this.samplerManager.handleRendererReady(e),P$().info(`Handled ''ready'' message, sent ide-context-updated`);break;case`open-in-main-window`:'
$readySelfTestReplacementNew = 'this.samplerManager.handleRendererReady(e),P$().info(`Handled ''ready'' message, sent ide-context-updated`),process.env.GPT_CODEX_CUSTOM_SELF_TEST===`1`&&setTimeout(()=>{this.windowManager.sendMessageToWebContents(e,{type:`gpt-codex-custom-run-self-test`})},5e3);break;case`open-in-main-window`:'
$readySelfTestSequences = @(
    [pscustomobject]@{ Name = "26.707.31428"; Needle = $readySelfTestNeedle; Replacement = $readySelfTestReplacement }
    [pscustomobject]@{ Name = "26.707.51957"; Needle = $readySelfTestNeedleNew; Replacement = $readySelfTestReplacementNew }
)
$mainText = Replace-UniqueSupportedSequence -Text $mainText -Sequences $readySelfTestSequences -Description "renderer-ready Chat self-test insertion point"

$diagnosticsNeedle = 'case`global-dictation-failed`:break;case`power-save-blocker-set`:'
$diagnosticsReplacement = 'case`global-dictation-failed`:break;case`gpt-codex-custom-diagnostics`:try{p.writeFileSync(u.join(c.app.getPath(`userData`),`gpt-codex-custom-diagnostics.json`),JSON.stringify({...t,receivedAtUtc:new Date().toISOString()},null,2))}catch{}break;case`gpt-codex-custom-renderer-status`:try{p.appendFileSync(u.join(c.app.getPath(`userData`),`gpt-codex-custom-renderer-status.jsonl`),JSON.stringify({...t,receivedAtUtc:new Date().toISOString()})+`\n`)}catch{}break;case`gpt-codex-custom-self-test-result`:try{p.writeFileSync(u.join(c.app.getPath(`userData`),`gpt-codex-custom-self-test-result.json`),JSON.stringify({...t,receivedAtUtc:new Date().toISOString()},null,2))}catch{}break;case`power-save-blocker-set`:'
$diagnosticsMatch = $mainText.IndexOf($diagnosticsNeedle, [System.StringComparison]::Ordinal)
if ($diagnosticsMatch -lt 0) {
    throw "Could not find the pinned main-process message sequence for diagnostics."
}
if ($mainText.IndexOf($diagnosticsNeedle, $diagnosticsMatch + $diagnosticsNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one main-process diagnostics insertion point."
}
$mainText = $mainText.Replace($diagnosticsNeedle, $diagnosticsReplacement)
[System.IO.File]::WriteAllText($MainFile.FullName, $mainText, $utf8NoBom)

$AppMainFile = Get-ChildItem -LiteralPath (Join-Path $PatchedSource "webview\assets") -Filter "app-main-*.js"
if (@($AppMainFile).Count -ne 1) {
    throw "Expected exactly one compiled app-main bundle, found $(@($AppMainFile).Count)."
}

$appMainText = [System.IO.File]::ReadAllText($AppMainFile.FullName)
$productMenuNeedle = 'let C;return t[27]!==_||t[28]!==S||t[29]!==f?(C=(0,kH.jsxs)(sS,{align:`start`,contentClassName:`p-1.5`,contentWidth:`menuWide`,sideOffset:4,triggerButton:f,children:[_,S]}),t[27]=_,t[28]=S,t[29]=f,t[30]=C):C=t[30],C}'
$productMenuReplacement = 'let G=(0,kH.jsx)(aS.Item,{className:`py-2.5 text-base`,SubText:(0,kH.jsx)(`span`,{className:`text-sm text-token-description-foreground`,children:`For everyday conversations`}),onSelect:()=>{globalThis.GPT_CODEX_CUSTOM_OPEN_CHAT?.()},children:(0,kH.jsx)(`span`,{className:`text-token-text-primary`,children:`Chat`})});let C;return t[27]!==_||t[28]!==S||t[29]!==f?(C=(0,kH.jsxs)(sS,{align:`start`,contentClassName:`p-1.5`,contentWidth:`menuWide`,sideOffset:4,triggerButton:f,children:[_,S,G]}),t[27]=_,t[28]=S,t[29]=f,t[30]=C):C=t[30],C}'
$productMenuNeedleNew = 'E=(0,MH.jsxs)(o,{align:l,contentClassName:u,contentWidth:d,sideOffset:f,triggerButton:h,children:[b,T]}),t[32]=o,t[33]=b,t[34]=T,t[35]=l,t[36]=u,t[37]=d,t[38]=f,t[39]=h,t[40]=E):E=t[40],E}'
$productMenuReplacementNew = 'E=(0,MH.jsxs)(o,{align:l,contentClassName:u,contentWidth:d,sideOffset:f,triggerButton:h,children:[b,T,(0,MH.jsx)(aS.Item,{className:`py-2.5 text-base`,SubText:(0,MH.jsx)(`span`,{className:`text-sm text-token-description-foreground`,children:`For everyday conversations`}),onSelect:()=>{globalThis.GPT_CODEX_CUSTOM_OPEN_CHAT?.()},children:(0,MH.jsx)(`span`,{className:`text-token-text-primary`,children:`Chat`})})]}),t[32]=o,t[33]=b,t[34]=T,t[35]=l,t[36]=u,t[37]=d,t[38]=f,t[39]=h,t[40]=E):E=t[40],E}'
$productMenuNeedleLatest = 'E=(0,PH.jsxs)(o,{align:l,contentClassName:u,contentWidth:d,sideOffset:f,triggerButton:h,children:[b,T]}),t[32]=o,t[33]=b,t[34]=T,t[35]=l,t[36]=u,t[37]=d,t[38]=f,t[39]=h,t[40]=E):E=t[40],E}'
$productMenuReplacementLatest = 'E=(0,PH.jsxs)(o,{align:l,contentClassName:u,contentWidth:d,sideOffset:f,triggerButton:h,children:[b,T,(0,PH.jsx)(aS.Item,{className:`py-2.5 text-base`,SubText:(0,PH.jsx)(`span`,{className:`text-sm text-token-description-foreground`,children:`For everyday conversations`}),onSelect:()=>{globalThis.GPT_CODEX_CUSTOM_OPEN_CHAT?.()},children:(0,PH.jsx)(`span`,{className:`text-token-text-primary`,children:`Chat`})})]}),t[32]=o,t[33]=b,t[34]=T,t[35]=l,t[36]=u,t[37]=d,t[38]=f,t[39]=h,t[40]=E):E=t[40],E}'
$productMenuSequences = @(
    [pscustomobject]@{ Name = "26.707.31428"; Needle = $productMenuNeedle; Replacement = $productMenuReplacement }
    [pscustomobject]@{ Name = "26.707.51957"; Needle = $productMenuNeedleNew; Replacement = $productMenuReplacementNew }
    [pscustomobject]@{ Name = "26.707.71524"; Needle = $productMenuNeedleLatest; Replacement = $productMenuReplacementLatest }
)
$appMainText = Replace-UniqueSupportedSequence -Text $appMainText -Sequences $productMenuSequences -Description "Work/Codex product-menu sequence"

$productModeBridgeNeedle = 'function DH(e){let t=(0,OH.c)(31),{mode:n,onModeSelect:r}=e,i=Tn(),a=AH[n],o;'
$productModeBridgeReplacement = 'function DH(e){let t=(0,OH.c)(31),{mode:n,onModeSelect:r}=e;globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES={mode:n,selectWork:()=>r(`work`),selectCodex:()=>r(`codex`)};globalThis.GPT_CODEX_CUSTOM_SYNC_PRODUCT_MODES?.(globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES);let i=Tn(),a=AH[n],o;'
$productModeBridgeNeedleNew = 'function EH(e){let t=(0,jH.c)(41),{mode:n,onModeSelect:r}=e,i=Tn(),a,o,s,c,l,u,d,f;'
$productModeBridgeReplacementNew = 'function EH(e){let t=(0,jH.c)(41),{mode:n,onModeSelect:r}=e;globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES={mode:n,selectWork:()=>r(`work`),selectCodex:()=>r(`codex`)};globalThis.GPT_CODEX_CUSTOM_SYNC_PRODUCT_MODES?.(globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES);let i=Tn(),a,o,s,c,l,u,d,f;'
$productModeBridgeNeedleLatest = 'function OH(e){let t=(0,NH.c)(41),{mode:n,onModeSelect:r}=e,i=Tn(),a,o,s,c,l,u,d,f;'
$productModeBridgeReplacementLatest = 'function OH(e){let t=(0,NH.c)(41),{mode:n,onModeSelect:r}=e;globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES={mode:n,selectWork:()=>r(`work`),selectCodex:()=>r(`codex`)};globalThis.GPT_CODEX_CUSTOM_SYNC_PRODUCT_MODES?.(globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES);let i=Tn(),a,o,s,c,l,u,d,f;'
$productModeBridgeSequences = @(
    [pscustomobject]@{ Name = "26.707.31428"; Needle = $productModeBridgeNeedle; Replacement = $productModeBridgeReplacement }
    [pscustomobject]@{ Name = "26.707.51957"; Needle = $productModeBridgeNeedleNew; Replacement = $productModeBridgeReplacementNew }
    [pscustomobject]@{ Name = "26.707.71524"; Needle = $productModeBridgeNeedleLatest; Replacement = $productModeBridgeReplacementLatest }
)
$appMainText = Replace-UniqueSupportedSequence -Text $appMainText -Sequences $productModeBridgeSequences -Description "Work/Codex product-mode component"

$chatControlNeedle = '(0,mV.jsx)(lk,{"aria-keyshortcuts":s,"aria-pressed":n,className:c,icon:Dne,onClick:l,label:u,trailing:m})'
$chatControlReplacement = '(0,mV.jsx)(lk,{"data-gpt-codex-custom-chat-control":!0,"aria-keyshortcuts":s,"aria-pressed":n,className:c,icon:Dne,onClick:l,label:u,trailing:m})'
$chatControlNeedleNew = '(0,pV.jsx)(ck,{"aria-keyshortcuts":s,"aria-pressed":n,className:c,icon:One,onClick:l,label:u,trailing:m})'
$chatControlReplacementNew = '(0,pV.jsx)(ck,{"data-gpt-codex-custom-chat-control":!0,"aria-keyshortcuts":s,"aria-pressed":n,className:c,icon:One,onClick:l,label:u,trailing:m})'
$chatControlNeedleLatest = '(0,hV.jsx)(uk,{"aria-keyshortcuts":s,"aria-pressed":n,className:c,icon:Ene,onClick:l,label:u,trailing:m})'
$chatControlReplacementLatest = '(0,hV.jsx)(uk,{"data-gpt-codex-custom-chat-control":!0,"aria-keyshortcuts":s,"aria-pressed":n,className:c,icon:Ene,onClick:l,label:u,trailing:m})'
$chatControlSequences = @(
    [pscustomobject]@{ Name = "26.707.31428"; Needle = $chatControlNeedle; Replacement = $chatControlReplacement }
    [pscustomobject]@{ Name = "26.707.51957"; Needle = $chatControlNeedleNew; Replacement = $chatControlReplacementNew }
    [pscustomobject]@{ Name = "26.707.71524"; Needle = $chatControlNeedleLatest; Replacement = $chatControlReplacementLatest }
)
$appMainText = Replace-UniqueSupportedSequence -Text $appMainText -Sequences $chatControlSequences -Description "native Chat sidebar control"

# The combined desktop build ships the ChatGPT Library page, but its route guard
# redirects accounts without the desktop rollout flag to Sites. Chat mode exposes
# Library intentionally, so keep the shipped page mounted in this isolated build.
$chatLibraryGuardNeedle = 'if(!ob(ba(`3765605143`),ba(`1404955983`)))'
$chatLibraryGuardReplacement = 'if(!1)'
$chatLibraryGuardMatch = $appMainText.IndexOf($chatLibraryGuardNeedle, [System.StringComparison]::Ordinal)
if ($chatLibraryGuardMatch -lt 0) {
    throw "Could not find the pinned ChatGPT Library route guard."
}
if ($appMainText.IndexOf($chatLibraryGuardNeedle, $chatLibraryGuardMatch + $chatLibraryGuardNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one ChatGPT Library route guard."
}
$appMainText = $appMainText.Replace($chatLibraryGuardNeedle, $chatLibraryGuardReplacement)

$navigationBridgeNeedle = 'C=t&&!l&&ob(h,_),w=t&&m&&!S,T=pm();return'
$navigationBridgeReplacement = 'C=t&&!l&&ob(h,_),w=t&&m&&!S,T=pm();F0({enabled:!1,limit:20,search:``});globalThis.GPT_CODEX_CUSTOM_SYNC_NAVIGATION?.({path:s.pathname,library:()=>{o(`/library`)},projects:()=>{o(`/projects`)},scheduled:()=>{o(`/automations`)},plugins:()=>{o(`/plugins`)}});return'
$navigationBridgeNeedleNew = 'C=t&&!l&&ob(h,_),w=t&&m&&!S,T=mm();return'
$navigationBridgeReplacementNew = 'C=t&&!l&&ob(h,_),w=t&&m&&!S,T=mm();L0({enabled:!1,limit:20,search:``});globalThis.GPT_CODEX_CUSTOM_SYNC_NAVIGATION?.({path:s.pathname,library:()=>{o(`/library`)},projects:()=>{o(`/projects`)},scheduled:()=>{o(`/automations`)},plugins:()=>{o(`/plugins`)}});return'
$navigationBridgeNeedleLatest = 'C=t&&!l&&ob(h,_),w=t&&m&&!S,T=hm();return'
$navigationBridgeReplacementLatest = 'C=t&&!l&&ob(h,_),w=t&&m&&!S,T=hm();z0({enabled:!1,limit:20,search:``});globalThis.GPT_CODEX_CUSTOM_SYNC_NAVIGATION?.({path:s.pathname,library:()=>{o(`/library`)},projects:()=>{o(`/projects`)},scheduled:()=>{o(`/automations`)},plugins:()=>{o(`/plugins`)}});return'
$navigationBridgeSequences = @(
    [pscustomobject]@{ Name = "26.707.31428"; Needle = $navigationBridgeNeedle; Replacement = $navigationBridgeReplacement }
    [pscustomobject]@{ Name = "26.707.51957"; Needle = $navigationBridgeNeedleNew; Replacement = $navigationBridgeReplacementNew }
    [pscustomobject]@{ Name = "26.707.71524"; Needle = $navigationBridgeNeedleLatest; Replacement = $navigationBridgeReplacementLatest }
)
$appMainText = Replace-UniqueSupportedSequence -Text $appMainText -Sequences $navigationBridgeSequences -Description "native navigation sequence"

$profileControlNeedle = '"aria-label":L,onClick:R,children:[z,B]'
$profileControlReplacement = '"data-gpt-codex-custom-profile-control":!0,"aria-label":L,onClick:R,children:[z,B]'
$profileControlMatch = $appMainText.IndexOf($profileControlNeedle, [System.StringComparison]::Ordinal)
if ($profileControlMatch -lt 0) {
    throw "Could not find the pinned native profile control."
}
if ($appMainText.IndexOf($profileControlNeedle, $profileControlMatch + $profileControlNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one native profile control."
}
$appMainText = $appMainText.Replace($profileControlNeedle, $profileControlReplacement)

$profileIdentityNeedle = 'let H=V,U;e[52]===Symbol.for(`react.memo_cache_sentinel`)'
$profileIdentityReplacement = 'let H=V;globalThis.GPT_CODEX_CUSTOM_SYNC_PROFILE?.({displayName:A,profileImageUrl:M,accountLabel:u?`Personal account`:`Local settings`});let U;e[52]===Symbol.for(`react.memo_cache_sentinel`)'
$profileIdentityMatch = $appMainText.IndexOf($profileIdentityNeedle, [System.StringComparison]::Ordinal)
if ($profileIdentityMatch -lt 0) {
    throw "Could not find the pinned native profile identity sequence."
}
if ($appMainText.IndexOf($profileIdentityNeedle, $profileIdentityMatch + $profileIdentityNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one native profile identity sequence."
}
$appMainText = $appMainText.Replace($profileIdentityNeedle, $profileIdentityReplacement)

$chatActionBridge = 'let GPTCodexChatActionId=e=>{let t=String(e??``).trim();if(t.length===0||t.startsWith(`local-chatgpt:`))throw Error(`Only saved chats support this action`);return t},GPTCodexChatActionDryRun=(e,t)=>{if(globalThis.GPT_CODEX_CUSTOM_CHAT_ACTION_DRY_RUN!==!0)return null;let n={action:e,...t,dryRun:!0};globalThis.GPT_CODEX_CUSTOM_CHAT_ACTION_DRY_RUN_RESULT=n;return n};globalThis.GPT_CODEX_CUSTOM_CHAT_ACTIONS={available:!0,archiveConversation:async e=>{let t=GPTCodexChatActionId(e),n=GPTCodexChatActionDryRun(`archive`,{archived:!0,conversationId:t});if(n)return n;await a.get(WS).setArchived(t,!0);return{archived:!0,conversationId:t,dryRun:!1}},deleteConversation:async e=>{let t=GPTCodexChatActionId(e);if(globalThis.GPT_CODEX_CUSTOM_DELETE_DRY_RUN===!0){globalThis.GPT_CODEX_CUSTOM_DELETE_DRY_RUN_RESULT={conversationId:t};return{conversationId:t,deleted:!0,dryRun:!0}}let n=GPTCodexChatActionDryRun(`delete`,{conversationId:t,deleted:!0});if(n)return n;await a.get(WS).delete(t);return{conversationId:t,deleted:!0,dryRun:!1}},pinConversation:async(e,t)=>{let n=GPTCodexChatActionId(e),r=t===!0,i=GPTCodexChatActionDryRun(`pin`,{conversationId:n,pinned:r});if(i)return i;await a.get(WS).setPinned(n,r);return{conversationId:n,dryRun:!1,pinned:r}},renameConversation:async(e,t)=>{let n=GPTCodexChatActionId(e),r=String(t??``).trim().slice(0,160);if(r.length===0)throw Error(`Chat title cannot be empty`);let i=GPTCodexChatActionDryRun(`rename`,{conversationId:n,renamed:!0,title:r});if(i)return i;await a.get(WS).rename(n,r);return{conversationId:n,dryRun:!1,renamed:!0,title:r}},shareConversation:async(e,t)=>{let n=GPTCodexChatActionId(e),r=GPTCodexChatActionDryRun(`share`,{conversationId:n,shared:!0,shareUrl:`https://chatgpt.com/share/gpt-codex-custom-dry-run`});if(r)return r;let i=a.get(WS),o=await i.get(n),s=o?.current_node??o?.currentNodeId;if(typeof s!==`string`||s.length===0)throw Error(`The conversation has no shareable current message`);let c=await i.createShareLink({conversation_id:n,current_node_id:s,is_anonymous:!0}),l=c.current_node_id??s,u=c.share_url,d=e=>e?.has_been_auto_blocked===!0||e?.has_been_auto_moderated===!0||e?.has_been_blocked===!0;if(d(c.moderation_state))throw Error(`ChatGPT blocked this conversation from sharing`);if(!(c.is_public&&c.is_visible&&c.is_anonymous)){let e=await i.updateShareLink(c.share_id,{current_node_id:l,highlighted_message_id:c.highlighted_message_id,is_anonymous:!0,is_public:!0,is_visible:!0,title:String(t??c.title??``)});if(d(e.moderation_state))throw Error(`ChatGPT blocked this conversation from sharing`)}if(typeof u!==`string`||u.length===0)throw Error(`ChatGPT did not return a share link`);return{conversationId:n,currentNodeId:l,dryRun:!1,shared:!0,shareUrl:u}}};globalThis.GPT_CODEX_CUSTOM_SYNC_CHAT_ACTIONS?.(globalThis.GPT_CODEX_CUSTOM_CHAT_ACTIONS);'
$chatSearchBridgeNeedle = 'function F0(e){let t=(0,L0.c)(20),{enabled:n,limit:r,search:i}=e,a=f(b),o=g(db),s;'
$chatSearchBridgeReplacement = 'function F0(e){let t=(0,L0.c)(20),{enabled:n,limit:r,search:i}=e,a=f(b),o=g(db);' + $chatActionBridge + 'globalThis.GPT_CODEX_CUSTOM_CHAT_SEARCH={available:!0,search:async e=>{let t=String(e?.query??``).trim();if(t.length===0)return{available:!0,cursor:null,items:[]};let n=await a.get(WS).globalSearch({limit:Math.min(Math.max(Number(e?.limit)||20,1),50),query:t});return{available:!0,cursor:n.cursor??n.next_cursor??null,items:N0({searchItems:n.items??[]})}}};globalThis.GPT_CODEX_CUSTOM_SYNC_CHAT_SEARCH?.(globalThis.GPT_CODEX_CUSTOM_CHAT_SEARCH);let s;'
$chatSearchBridgeNeedleNew = 'function L0(e){let t=(0,z0.c)(20),{enabled:n,limit:r,search:i}=e,a=f(b),o=g(db),s;'
$chatSearchBridgeReplacementNew = 'function L0(e){let t=(0,z0.c)(20),{enabled:n,limit:r,search:i}=e,a=f(b),o=g(db);' + $chatActionBridge + 'globalThis.GPT_CODEX_CUSTOM_CHAT_SEARCH={available:!0,search:async e=>{let t=String(e?.query??``).trim();if(t.length===0)return{available:!0,cursor:null,items:[]};let n=await a.get(WS).globalSearch({limit:Math.min(Math.max(Number(e?.limit)||20,1),50),query:t});return{available:!0,cursor:n.cursor??n.next_cursor??null,items:F0({searchItems:n.items??[]})}}};globalThis.GPT_CODEX_CUSTOM_SYNC_CHAT_SEARCH?.(globalThis.GPT_CODEX_CUSTOM_CHAT_SEARCH);let s;'
$chatSearchBridgeNeedleLatest = 'function z0(e){let t=(0,V0.c)(20),{enabled:n,limit:r,search:i}=e,a=f(b),o=g(db),s;'
$chatSearchBridgeReplacementLatest = 'function z0(e){let t=(0,V0.c)(20),{enabled:n,limit:r,search:i}=e,a=f(b),o=g(db);' + $chatActionBridge + 'globalThis.GPT_CODEX_CUSTOM_CHAT_SEARCH={available:!0,search:async e=>{let t=String(e?.query??``).trim();if(t.length===0)return{available:!0,cursor:null,items:[]};let n=await a.get(WS).globalSearch({limit:Math.min(Math.max(Number(e?.limit)||20,1),50),query:t});return{available:!0,cursor:n.cursor??n.next_cursor??null,items:L0({searchItems:n.items??[]})}}};globalThis.GPT_CODEX_CUSTOM_SYNC_CHAT_SEARCH?.(globalThis.GPT_CODEX_CUSTOM_CHAT_SEARCH);let s;'
$chatSearchBridgeSequences = @(
    [pscustomobject]@{ Name = "26.707.31428"; Needle = $chatSearchBridgeNeedle; Replacement = $chatSearchBridgeReplacement }
    [pscustomobject]@{ Name = "26.707.51957"; Needle = $chatSearchBridgeNeedleNew; Replacement = $chatSearchBridgeReplacementNew }
    [pscustomobject]@{ Name = "26.707.71524"; Needle = $chatSearchBridgeNeedleLatest; Replacement = $chatSearchBridgeReplacementLatest }
)
$appMainText = Replace-UniqueSupportedSequence -Text $appMainText -Sequences $chatSearchBridgeSequences -Description "native Chat search state owner"
[System.IO.File]::WriteAllText($AppMainFile.FullName, $appMainText, $utf8NoBom)

$profileMenuBridgeNeedle = 'h=s(sn),_;'
$profileMenuBridgeReplacement = 'h=s(sn);globalThis.GPT_CODEX_CUSTOM_SYNC_PROFILE_MENU?.({open:()=>i.set(sn,!0),close:()=>i.set(sn,!1),isOpen:h});let _;'
$profileMenuBridgeNeedleNew = 'h=s(ln),_;'
$profileMenuBridgeReplacementNew = 'h=s(ln);globalThis.GPT_CODEX_CUSTOM_SYNC_PROFILE_MENU?.({open:()=>i.set(ln,!0),close:()=>i.set(ln,!1),isOpen:h});let _;'
$profileMenuBridgeSequences = @(
    [pscustomobject]@{ Name = "26.707.31428"; Needle = $profileMenuBridgeNeedle; Replacement = $profileMenuBridgeReplacement }
    [pscustomobject]@{ Name = "26.707.51957"; Needle = $profileMenuBridgeNeedleNew; Replacement = $profileMenuBridgeReplacementNew }
)
$profileMenuBridgeNeedles = @($profileMenuBridgeNeedle, $profileMenuBridgeNeedleNew)
$ProfileDropdownFile = @(Get-ChildItem -LiteralPath (Join-Path $PatchedSource "webview\assets") -Filter "profile-dropdown-*.js" | Where-Object {
    $candidateText = [System.IO.File]::ReadAllText($_.FullName)
    @($profileMenuBridgeNeedles | Where-Object { $candidateText.Contains($_) }).Count -gt 0
})
if ($ProfileDropdownFile.Count -ne 1) {
    throw "Expected exactly one compiled profile dropdown bundle, found $($ProfileDropdownFile.Count)."
}
$profileDropdownText = [System.IO.File]::ReadAllText($ProfileDropdownFile[0].FullName)
$profileDropdownText = Replace-UniqueSupportedSequence -Text $profileDropdownText -Sequences $profileMenuBridgeSequences -Description "native profile-menu state sequence"
[System.IO.File]::WriteAllText($ProfileDropdownFile[0].FullName, $profileDropdownText, $utf8NoBom)

$historyBridgeNeedle = 'function Gr(e){let t=(0,Jr.c)(14),{conversations:n,nowMs:r,onConversationSelect:i,onNewChat:a}=e,o=ft(),s;'
$historyBridgeReplacement = 'function Gr(e){let t=(0,Jr.c)(14),{conversations:n,nowMs:r,onConversationSelect:i,onNewChat:a}=e;globalThis.GPT_CODEX_CUSTOM_SYNC_HISTORY?.(n.map(e=>({conversationId:e.conversationId,title:e.title,recencyAt:e.recencyAt,kind:e.kind,pinned:e.pinned,projectId:e.projectId})),i,a);let o=ft(),s;'
$QuickChatFile = @(Get-ChildItem -LiteralPath (Join-Path $PatchedSource "webview\assets") -Filter "quick-chat-window-*.js" | Where-Object {
    [System.IO.File]::ReadAllText($_.FullName).Contains($historyBridgeNeedle)
})
if ($QuickChatFile.Count -ne 1) {
    throw "Expected exactly one compiled Quick Chat history bundle, found $($QuickChatFile.Count)."
}

$quickChatText = [System.IO.File]::ReadAllText($QuickChatFile[0].FullName)
$modelQueryImportNeedle = 'import{A as Ze,B as Qe,E as $e,Fn as et,M as tt,N as nt,Pn as rt,_ as it,b as at,cr as ot,et as st,lr as ct,v as lt}from"./use-workspace-file-search-CcTaajZd.js"'
$modelQueryImportReplacement = 'import{A as Ze,B as Qe,E as $e,Fn as et,M as tt,N as nt,Pn as rt,_ as it,b as at,cr as ot,et as st,lr as ct,s as GPTCodexChatModelsQuery,v as lt}from"./use-workspace-file-search-CcTaajZd.js"'
$modelQueryImportNeedleNew = 'import{A as Ze,B as Qe,E as $e,Fn as et,M as tt,N as nt,Pn as rt,_ as it,b as at,cr as ot,et as st,lr as ct,v as lt}from"./use-workspace-file-search-C3LX3fzH.js"'
$modelQueryImportReplacementNew = 'import{A as Ze,B as Qe,E as $e,Fn as et,M as tt,N as nt,Pn as rt,_ as it,b as at,cr as ot,et as st,lr as ct,s as GPTCodexChatModelsQuery,v as lt}from"./use-workspace-file-search-C3LX3fzH.js"'
$modelQueryImportNeedleLatest = 'import{A as Ze,B as Qe,E as $e,Fn as et,M as tt,N as nt,Pn as rt,_ as it,b as at,cr as ot,et as st,lr as ct,v as lt}from"./use-workspace-file-search-BLRuERQT.js"'
$modelQueryImportReplacementLatest = 'import{A as Ze,B as Qe,E as $e,Fn as et,M as tt,N as nt,Pn as rt,_ as it,b as at,cr as ot,et as st,lr as ct,s as GPTCodexChatModelsQuery,v as lt}from"./use-workspace-file-search-BLRuERQT.js"'
$modelQueryImportSequences = @(
    [pscustomobject]@{ Name = "26.707.31428"; Needle = $modelQueryImportNeedle; Replacement = $modelQueryImportReplacement }
    [pscustomobject]@{ Name = "26.707.51957"; Needle = $modelQueryImportNeedleNew; Replacement = $modelQueryImportReplacementNew }
    [pscustomobject]@{ Name = "26.707.71524"; Needle = $modelQueryImportNeedleLatest; Replacement = $modelQueryImportReplacementLatest }
)
$quickChatText = Replace-UniqueSupportedSequence -Text $quickChatText -Sequences $modelQueryImportSequences -Description "Quick Chat account-model query import"

$imageComposerImportNeedle = 'import{R as rn,a as an,c as on,i as sn,m as cn,o as ln,s as un,z as dn}from"./chatgpt-conversation-composer-state-DhYP9K9y.js"'
$imageComposerImportReplacement = 'import{R as rn,a as an,c as on,g as GPTCodexRemoveImageAttachment,i as sn,l as GPTCodexSelectedChatModel,m as cn,o as ln,r as GPTCodexImageAttachments,s as un,u as GPTCodexSelectedHint,v as GPTCodexSelectChatModel,x as GPTCodexUploadFiles,y as GPTCodexSetHint,z as dn}from"./chatgpt-conversation-composer-state-DhYP9K9y.js"'
$imageComposerImportNeedleNew = 'import{R as rn,a as an,c as on,i as sn,m as cn,o as ln,s as un,z as dn}from"./chatgpt-conversation-composer-state-DqMw-lg9.js"'
$imageComposerImportReplacementNew = 'import{R as rn,a as an,c as on,g as GPTCodexRemoveImageAttachment,i as sn,l as GPTCodexSelectedChatModel,m as cn,o as ln,r as GPTCodexImageAttachments,s as un,u as GPTCodexSelectedHint,v as GPTCodexSelectChatModel,x as GPTCodexUploadFiles,y as GPTCodexSetHint,z as dn}from"./chatgpt-conversation-composer-state-DqMw-lg9.js"'
$imageComposerImportNeedleLatest = 'import{R as rn,a as an,c as on,i as sn,m as cn,o as ln,s as un,z as dn}from"./chatgpt-conversation-composer-state-Boi75zO6.js"'
$imageComposerImportReplacementLatest = 'import{R as rn,a as an,c as on,g as GPTCodexRemoveImageAttachment,i as sn,l as GPTCodexSelectedChatModel,m as cn,o as ln,r as GPTCodexImageAttachments,s as un,u as GPTCodexSelectedHint,v as GPTCodexSelectChatModel,x as GPTCodexUploadFiles,y as GPTCodexSetHint,z as dn}from"./chatgpt-conversation-composer-state-Boi75zO6.js"'
$imageComposerImportSequences = @(
    [pscustomobject]@{ Name = "26.707.31428"; Needle = $imageComposerImportNeedle; Replacement = $imageComposerImportReplacement }
    [pscustomobject]@{ Name = "26.707.51957"; Needle = $imageComposerImportNeedleNew; Replacement = $imageComposerImportReplacementNew }
    [pscustomobject]@{ Name = "26.707.71524"; Needle = $imageComposerImportNeedleLatest; Replacement = $imageComposerImportReplacementLatest }
)
$quickChatText = Replace-UniqueSupportedSequence -Text $quickChatText -Sequences $imageComposerImportSequences -Description "Quick Chat composer-state import"

$historyBridgeMatch = $quickChatText.IndexOf($historyBridgeNeedle, [System.StringComparison]::Ordinal)
if ($historyBridgeMatch -lt 0) {
    throw "Could not find the pinned Quick Chat history component."
}
if ($quickChatText.IndexOf($historyBridgeNeedle, $historyBridgeMatch + $historyBridgeNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one Quick Chat history component."
}
$quickChatText = $quickChatText.Replace($historyBridgeNeedle, $historyBridgeReplacement)

$historyMetadataNeedle = 'return[{conversationId:a,recencyAt:r.recencyAt,title:(r.kind===`optimistic`?t.get(a):r.conversation.title)?.trim()||n}]'
$historyMetadataReplacement = 'return[{conversationId:a,recencyAt:r.recencyAt,title:(r.kind===`optimistic`?t.get(a):r.conversation.title)?.trim()||n,kind:r.kind,pinned:r.kind===`pinned`,projectId:r.projectId??null}]'
$historyMetadataMatch = $quickChatText.IndexOf($historyMetadataNeedle, [System.StringComparison]::Ordinal)
if ($historyMetadataMatch -lt 0) {
    throw "Could not find the pinned Quick Chat history metadata sequence."
}
if ($quickChatText.IndexOf($historyMetadataNeedle, $historyMetadataMatch + $historyMetadataNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one Quick Chat history metadata sequence."
}
$quickChatText = $quickChatText.Replace($historyMetadataNeedle, $historyMetadataReplacement)

$historyPaginationNeedle = 'Ie=tr(Fe),Le=O??ae'
$historyPaginationReplacement = 'Ie=tr(Fe);globalThis.GPT_CODEX_CUSTOM_SYNC_HISTORY_PAGINATION?.({canFetchNextPage:j.canFetchNextConversationPage,isFetchingNextPage:j.isFetchingNextConversationPage,fetchNextPage:j.fetchNextConversationPage});let Le=O??ae'
$historyPaginationMatch = $quickChatText.IndexOf($historyPaginationNeedle, [System.StringComparison]::Ordinal)
if ($historyPaginationMatch -lt 0) {
    throw "Could not find the pinned Quick Chat history-pagination sequence."
}
if ($quickChatText.IndexOf($historyPaginationNeedle, $historyPaginationMatch + $historyPaginationNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one Quick Chat history-pagination sequence."
}
$quickChatText = $quickChatText.Replace($historyPaginationNeedle, $historyPaginationReplacement)

$sessionBridgeNeedle = ',{conversationId:T,initialScrollMode:D,title:O}=t,j=xr({flatConversationHistory:!0})'
$sessionBridgeReplacement = ',{conversationId:T,initialScrollMode:D,title:O}=t,GPTCodexModelQuery=s(GPTCodexChatModelsQuery),GPTCodexSelectedModel=u(GPTCodexSelectedChatModel,T);globalThis.GPT_CODEX_CUSTOM_CHAT_MODEL_PICKER={conversationId:T,state:GPTCodexModelQuery,query:GPTCodexModelQuery,selected:GPTCodexSelectedModel,select:e=>GPTCodexSelectChatModel(c,T,e)};globalThis.GPT_CODEX_CUSTOM_SYNC_CHAT_MODEL_PICKER?.(globalThis.GPT_CODEX_CUSTOM_CHAT_MODEL_PICKER);globalThis.GPT_CODEX_CUSTOM_SYNC_SESSION?.({conversationId:T,initialScrollMode:D,title:O});globalThis.GPT_CODEX_CUSTOM_SYNC_TOKEN_CONTEXT?.({mode:`chat`,threadId:T,tokenUsage:null,source:`session`});if(n===`floating`){let GPTCodexStageCustomImage=async(e,t=!1)=>{if(!(e instanceof File))throw Error(`Image editing requires a File`);let n=new Set(c.get(GPTCodexImageAttachments,T).map(e=>e.uploadId));await GPTCodexUploadFiles(c,T,[e],t?{isTemporaryChat:!0}:{});let r=c.get(GPTCodexImageAttachments,T).filter(e=>!n.has(e.uploadId)),i=r.find(e=>e.status===`ready`);if(i==null){for(let e of r)e.uploadId&&GPTCodexRemoveImageAttachment(c,T,e.uploadId);throw Error(`The native image upload did not produce a ready attachment`)}GPTCodexSetHint(c,T,`picture_v2`);return{attachmentCount:c.get(GPTCodexImageAttachments,T).length,stagedAttachmentCount:r.length,status:i.status,uploadId:i.uploadId}};globalThis.GPT_CODEX_CUSTOM_IMAGE_COMPOSER={conversationId:T,probe:()=>({attachmentCount:c.get(GPTCodexImageAttachments,T).length,conversationId:T,selectedSystemHint:c.get(GPTCodexSelectedHint,T)}),stageImage:e=>GPTCodexStageCustomImage(e),selfTestStageImage:async e=>{let t=c.get(GPTCodexImageAttachments,T).map(e=>e.uploadId),n=new Set(t),r=c.get(GPTCodexSelectedHint,T),i=null,a=null;try{i=await GPTCodexStageCustomImage(e,!0)}catch(e){a=e}finally{for(let e of c.get(GPTCodexImageAttachments,T))!n.has(e.uploadId)&&e.uploadId&&GPTCodexRemoveImageAttachment(c,T,e.uploadId);GPTCodexSetHint(c,T,r)}if(a)throw a;return{...i,cleaned:t.length===c.get(GPTCodexImageAttachments,T).length,hintRestored:c.get(GPTCodexSelectedHint,T)===r}}};globalThis.GPT_CODEX_CUSTOM_SYNC_IMAGE_COMPOSER?.(globalThis.GPT_CODEX_CUSTOM_IMAGE_COMPOSER)}let j=xr({flatConversationHistory:!0})'
$sessionBridgeMatch = $quickChatText.IndexOf($sessionBridgeNeedle, [System.StringComparison]::Ordinal)
if ($sessionBridgeMatch -lt 0) {
    throw "Could not find the pinned Quick Chat session sequence."
}
if ($quickChatText.IndexOf($sessionBridgeNeedle, $sessionBridgeMatch + $sessionBridgeNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one Quick Chat session sequence."
}
$quickChatText = $quickChatText.Replace($sessionBridgeNeedle, $sessionBridgeReplacement)
[System.IO.File]::WriteAllText($QuickChatFile[0].FullName, $quickChatText, $utf8NoBom)

$GeneratedImagePreviewFile = @(
    Get-ChildItem -LiteralPath (Join-Path $PatchedSource "webview\assets") -Filter "generated-image-preview-*.js"
)
if ($GeneratedImagePreviewFile.Count -ne 1) {
    throw "Expected exactly one generated-image/message renderer, found $($GeneratedImagePreviewFile.Count)."
}
$generatedImagePreviewText = [System.IO.File]::ReadAllText($GeneratedImagePreviewFile[0].FullName)
$messageCancelGuardPatches = @(
    [pscustomobject]@{
        Name = "cancel guard state"
        Needle = 'c=(0,fd.useRef)(null),[l]=(0,fd.useState)(()=>{'
        Replacement = 'c=(0,fd.useRef)(null),GPTCodexCancelGuard=(0,fd.useRef)(!1),[l]=(0,fd.useState)(()=>{'
    },
    [pscustomobject]@{
        Name = "cancel guard draft callback"
        Needle = '_=(0,fd.useEffectEvent)(()=>{i(l.getText())});'
        Replacement = '_=(0,fd.useEffectEvent)(()=>{GPTCodexCancelGuard.current||i(l.getText())});'
    },
    [pscustomobject]@{
        Name = "submit guard"
        Needle = 'let v=async()=>{if(!h){g(!0);try{await a(l.getText().trim())}finally{g(!1)}}};'
        Replacement = 'let v=async()=>{if(!h){g(!0);let e=l.getText().trim();GPTCodexCancelGuard.current=!0;try{await a(e)}catch(e){throw GPTCodexCancelGuard.current=!1,e}finally{g(!1)}}};'
    },
    [pscustomobject]@{
        Name = "cancel guard button"
        Needle = '(0,pd.jsx)(ge,{color:`outline`,size:`toolbar`,disabled:h,onClick:r,children:(0,pd.jsx)(q,{id:`codex.userMessage.cancelEditMessage`,defaultMessage:`Cancel`,description:`Button label for canceling an edited user message`})})'
        Replacement = '(0,pd.jsx)(ge,{color:`outline`,size:`toolbar`,disabled:h,onClick:()=>{GPTCodexCancelGuard.current=!0,r()},children:(0,pd.jsx)(q,{id:`codex.userMessage.cancelEditMessage`,defaultMessage:`Cancel`,description:`Button label for canceling an edited user message`})})'
    }
)
foreach ($messageCancelGuardPatch in $messageCancelGuardPatches) {
    $messageCancelGuardMatch = $generatedImagePreviewText.IndexOf(
        $messageCancelGuardPatch.Needle,
        [System.StringComparison]::Ordinal
    )
    if ($messageCancelGuardMatch -lt 0) {
        throw "Could not find the pinned message-edit $($messageCancelGuardPatch.Name) sequence."
    }
    if ($generatedImagePreviewText.IndexOf(
        $messageCancelGuardPatch.Needle,
        $messageCancelGuardMatch + $messageCancelGuardPatch.Needle.Length,
        [System.StringComparison]::Ordinal
    ) -ge 0) {
        throw "Found more than one message-edit $($messageCancelGuardPatch.Name) sequence."
    }
    $generatedImagePreviewText = $generatedImagePreviewText.Replace(
        $messageCancelGuardPatch.Needle,
        $messageCancelGuardPatch.Replacement
    )
}
[System.IO.File]::WriteAllText(
    $GeneratedImagePreviewFile[0].FullName,
    $generatedImagePreviewText,
    $utf8NoBom
)

$ChatGptThreadFile = @(Get-ChildItem -LiteralPath (Join-Path $PatchedSource "webview\assets") -Filter "chatgpt-thread-visibility-*.js")
if ($ChatGptThreadFile.Count -ne 1) {
    throw "Expected exactly one compiled ChatGPT thread renderer, found $($ChatGptThreadFile.Count)."
}
$chatGptThreadText = [System.IO.File]::ReadAllText($ChatGptThreadFile[0].FullName)
$messageEditResolverNeedle = 'function db(e){return e.type===`chatgpt-reasoning-group`?e.items:[]}function fb(e){'
$messageEditResolverReplacement = 'function db(e){return e.type===`chatgpt-reasoning-group`?e.items:[]}function GPTCodexResolveEditableUserMessage(e,t,n,r){let i=e.get(Qn,t),a=e.get(Ti,t);if(i==null||a==null)return null;let o=[],s=new Set;for(let e=a;e!=null&&!s.has(e);){let t=i[e];if(t==null)break;o.push({id:e,node:t}),s.add(e),e=t.parent??null}o.reverse();let c=o.filter(({node:e})=>e.message?.author?.role===`user`),l=c.find(({id:e,node:t})=>e===n||t.message?.metadata?.turnId===n||t.message?.metadata?.turn_id===n)??null;if(l==null&&typeof n===`string`){let e=/^fallback-turn-(\d+)$/.exec(n);e!=null&&(l=c[Number(e[1])]??null)}if(l==null){let e=t=>{let n=t?.content;return typeof n?.text===`string`?n.text:Array.isArray(n?.parts)?n.parts.filter(e=>typeof e===`string`).join(``):``};l=c.find(({node:t})=>e(t.message).trim()===r.trim())??null}return l==null?null:{messageId:l.id,messageMetadata:l.node.message?.metadata,parentMessageId:l.node.parent??null}}function GPTCodexExtractCustomMessageText(e){if(typeof e===`string`)return e;if(Array.isArray(e))return e.map(GPTCodexExtractCustomMessageText).join(``);if(e&&typeof e===`object`)return GPTCodexExtractCustomMessageText(e.text??e.content??e.parts??``);return``}function GPTCodexSyncCustomMessage(e){globalThis.GPT_CODEX_CUSTOM_SYNC_TOKEN_MESSAGE?.(e),globalThis.GPT_CODEX_CUSTOM_REGISTER_PINNABLE_MESSAGE?.(e)}function fb(e){'
$messageEditResolverMatch = $chatGptThreadText.IndexOf($messageEditResolverNeedle, [System.StringComparison]::Ordinal)
if ($messageEditResolverMatch -lt 0) {
    throw "Could not find the pinned ChatGPT user-message resolver insertion point."
}
if ($chatGptThreadText.IndexOf($messageEditResolverNeedle, $messageEditResolverMatch + $messageEditResolverNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one ChatGPT user-message resolver insertion point."
}
$chatGptThreadText = $chatGptThreadText.Replace($messageEditResolverNeedle, $messageEditResolverReplacement)

$messageEditNeedle = '(0,wb.jsx)(ga,{message:s.message,sentAtMs:s.sentAtMs,hasExternalAttachments:v,hostId:i,threadId:l,turnId:h})'
$messageEditReplacement = '(GPTCodexSyncCustomMessage({mode:`chat`,role:`user`,conversationId:r,turnId:h,stableId:`${h??s.sentAtMs??s.message}:user`,messageId:GPTCodexResolveEditableUserMessage(g,r,h,s.message)?.messageId??h,text:s.message,complete:!0}),(0,wb.jsx)(ga,{message:s.message,sentAtMs:s.sentAtMs,hasExternalAttachments:v,hostId:i,threadId:l,turnId:h,onEditMessage:GPTCodexResolveEditableUserMessage(g,r,h,s.message)!=null?async e=>{let t=GPTCodexResolveEditableUserMessage(g,r,h,s.message);if(t==null)throw Error(`Cannot edit a ChatGPT message without its mapping entry`);if(globalThis.GPT_CODEX_CUSTOM_EDIT_DRY_RUN===!0){globalThis.GPT_CODEX_CUSTOM_EDIT_DRY_RUN_RESULT={conversationId:r,messageId:t.messageId,parentMessageId:t.parentMessageId,prompt:e};return}await Zc(g,{conversationId:r,messageMetadata:t.messageMetadata,parentMessageId:t.parentMessageId,prompt:e})}:void 0}))'
$messageEditMatch = $chatGptThreadText.IndexOf($messageEditNeedle, [System.StringComparison]::Ordinal)
if ($messageEditMatch -lt 0) {
    throw "Could not find the pinned ChatGPT user-message renderer."
}
if ($chatGptThreadText.IndexOf($messageEditNeedle, $messageEditMatch + $messageEditNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one ChatGPT user-message renderer."
}
$chatGptThreadText = $chatGptThreadText.Replace($messageEditNeedle, $messageEditReplacement)

$assistantMessageBridgeNeedle = '(0,wb.jsx)(Tv,{browserConversationId:n,item:s,conversationId:r,cwd:null,hostId:i,turnId:h})'
$assistantMessageBridgeReplacement = '(GPTCodexSyncCustomMessage({mode:`chat`,role:`assistant`,conversationId:r,turnId:h,stableId:`${h??s.messageId??`chat`}:assistant`,messageId:s.messageId??h,text:GPTCodexExtractCustomMessageText(s.content),complete:s.completed===!0}),(0,wb.jsx)(Tv,{browserConversationId:n,item:s,conversationId:r,cwd:null,hostId:i,turnId:h}))'
$assistantMessageBridgeMatch = $chatGptThreadText.IndexOf($assistantMessageBridgeNeedle, [System.StringComparison]::Ordinal)
if ($assistantMessageBridgeMatch -lt 0) {
    throw "Could not find the pinned ChatGPT assistant-message renderer."
}
if ($chatGptThreadText.IndexOf($assistantMessageBridgeNeedle, $assistantMessageBridgeMatch + $assistantMessageBridgeNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one ChatGPT assistant-message renderer."
}
$chatGptThreadText = $chatGptThreadText.Replace($assistantMessageBridgeNeedle, $assistantMessageBridgeReplacement)
[System.IO.File]::WriteAllText($ChatGptThreadFile[0].FullName, $chatGptThreadText, $utf8NoBom)

$LocalTurnFile = @(Get-ChildItem -LiteralPath (Join-Path $PatchedSource "webview\assets") -Filter "local-conversation-turn-*.js")
if ($LocalTurnFile.Count -ne 1) {
    throw "Expected exactly one Work/Codex turn renderer, found $($LocalTurnFile.Count)."
}
$localTurnText = [System.IO.File]::ReadAllText($LocalTurnFile[0].FullName)
$localMessageHelperNeedle = 'function Nv(e){let t='
$localMessageHelperReplacement = 'function GPTCodexSyncCustomMessage(e){globalThis.GPT_CODEX_CUSTOM_SYNC_TOKEN_MESSAGE?.(e),globalThis.GPT_CODEX_CUSTOM_REGISTER_PINNABLE_MESSAGE?.(e)}function Nv(e){let t='
$localMessageHelperMatch = $localTurnText.IndexOf($localMessageHelperNeedle, [System.StringComparison]::Ordinal)
if ($localMessageHelperMatch -lt 0) {
    throw "Could not find the pinned Work/Codex message-renderer insertion point."
}
if ($localTurnText.IndexOf($localMessageHelperNeedle, $localMessageHelperMatch + $localMessageHelperNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one Work/Codex message-renderer insertion point."
}
$localTurnText = $localTurnText.Replace($localMessageHelperNeedle, $localMessageHelperReplacement)

$localUserMessageNeedle = 'content:(0,$.jsx)(Nv,{item:r,conversationId:e,hostId:t,conversationDetailLevel:fe,isTurnInProgress:q,cwd:p,reportEntityType:k,resolvedApps:E,renderMcpApps:he,toolActivityTurnKey:ae,turnId:lt??void 0'
$localUserMessageReplacement = 'content:(GPTCodexSyncCustomMessage({mode:pe?`work`:`codex`,role:`user`,conversationId:e,turnId:lt??null,stableId:`${lt??r.id??n}:user`,messageId:r.id??lt??`user-${n}`,text:r.message??``,complete:!0}),(0,$.jsx)(Nv,{item:r,conversationId:e,hostId:t,conversationDetailLevel:fe,isTurnInProgress:q,cwd:p,reportEntityType:k,resolvedApps:E,renderMcpApps:he,toolActivityTurnKey:ae,turnId:lt??void 0'
$localUserMessageNeedleNew = 'content:(0,$.jsx)(Nv,{item:r,conversationId:e,hostId:t,conversationDetailLevel:pe,isTurnInProgress:K,cwd:p,reportEntityType:k,resolvedApps:E,renderMcpApps:ge,toolActivityTurnKey:oe,turnId:lt??void 0'
$localUserMessageReplacementNew = 'content:(GPTCodexSyncCustomMessage({mode:me?`work`:`codex`,role:`user`,conversationId:e,turnId:lt??null,stableId:`${lt??r.id??n}:user`,messageId:r.id??lt??`user-${n}`,text:r.message??``,complete:!0}),(0,$.jsx)(Nv,{item:r,conversationId:e,hostId:t,conversationDetailLevel:pe,isTurnInProgress:K,cwd:p,reportEntityType:k,resolvedApps:E,renderMcpApps:ge,toolActivityTurnKey:oe,turnId:lt??void 0'
$localUserMessageSequences = @(
    [pscustomobject]@{ Name = "26.707.31428"; Needle = $localUserMessageNeedle; Replacement = $localUserMessageReplacement }
    [pscustomobject]@{ Name = "26.707.51957"; Needle = $localUserMessageNeedleNew; Replacement = $localUserMessageReplacementNew }
)
$localTurnText = Replace-UniqueSupportedSequence -Text $localTurnText -Sequences $localUserMessageSequences -Description "Work/Codex user-message renderer"

$localUserMessageTailNeedle = 'emptyUserMessageOverride:n===0?w:void 0})}),{canOwnLatestTurnFollowContent:!1})'
$localUserMessageTailReplacement = 'emptyUserMessageOverride:n===0?w:void 0}))}),{canOwnLatestTurnFollowContent:!1})'
$localUserMessageTailMatch = $localTurnText.IndexOf($localUserMessageTailNeedle, [System.StringComparison]::Ordinal)
if ($localUserMessageTailMatch -lt 0) {
    throw "Could not find the pinned Work/Codex user-message renderer tail."
}
if ($localTurnText.IndexOf($localUserMessageTailNeedle, $localUserMessageTailMatch + $localUserMessageTailNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one Work/Codex user-message renderer tail."
}
$localTurnText = $localTurnText.Replace($localUserMessageTailNeedle, $localUserMessageTailReplacement)

$localAssistantMessageNeedle = '(0,$.jsx)(Nv,{item:be,conversationId:e,hostId:t,conversationDetailLevel:fe,isTurnInProgress:q,cwd:p,resolvedApps:E,renderMcpApps:he,reportEntityType:k,toolActivityTurnKey:ae,turnId:ut??void 0,processTargets:dt,projectlessOutputDirectory:q?null:b'
$localAssistantMessageReplacement = '(GPTCodexSyncCustomMessage({mode:pe?`work`:`codex`,role:`assistant`,conversationId:e,turnId:ut??null,stableId:`${ut??lt??be.id??`final`}:assistant`,messageId:be.id??ut??lt??`assistant`,text:nt??be.content??``,complete:be.completed===!0}),(0,$.jsx)(Nv,{item:be,conversationId:e,hostId:t,conversationDetailLevel:fe,isTurnInProgress:q,cwd:p,resolvedApps:E,renderMcpApps:he,reportEntityType:k,toolActivityTurnKey:ae,turnId:ut??void 0,processTargets:dt,projectlessOutputDirectory:q?null:b'
$localAssistantMessageNeedleNew = '(0,$.jsx)(Nv,{item:be,conversationId:e,hostId:t,conversationDetailLevel:pe,isTurnInProgress:K,cwd:p,resolvedApps:E,renderMcpApps:ge,reportEntityType:k,toolActivityTurnKey:oe,turnId:ut??void 0,processTargets:dt,projectlessOutputDirectory:K?null:b'
$localAssistantMessageReplacementNew = '(GPTCodexSyncCustomMessage({mode:me?`work`:`codex`,role:`assistant`,conversationId:e,turnId:ut??null,stableId:`${ut??lt??be.id??`final`}:assistant`,messageId:be.id??ut??lt??`assistant`,text:nt??be.content??``,complete:be.completed===!0}),(0,$.jsx)(Nv,{item:be,conversationId:e,hostId:t,conversationDetailLevel:pe,isTurnInProgress:K,cwd:p,resolvedApps:E,renderMcpApps:ge,reportEntityType:k,toolActivityTurnKey:oe,turnId:ut??void 0,processTargets:dt,projectlessOutputDirectory:K?null:b'
$localAssistantMessageSequences = @(
    [pscustomobject]@{ Name = "26.707.31428"; Needle = $localAssistantMessageNeedle; Replacement = $localAssistantMessageReplacement }
    [pscustomobject]@{ Name = "26.707.51957"; Needle = $localAssistantMessageNeedleNew; Replacement = $localAssistantMessageReplacementNew }
)
$localTurnText = Replace-UniqueSupportedSequence -Text $localTurnText -Sequences $localAssistantMessageSequences -Description "Work/Codex assistant-message renderer"

$localAssistantMessageTailNeedle = 'onAssistantFileLinkOpen:st,onForkTurn:M})})})),!ht&&Wn'
$localAssistantMessageTailReplacement = 'onAssistantFileLinkOpen:st,onForkTurn:M}))})})),!ht&&Wn'
$localAssistantMessageTailMatch = $localTurnText.IndexOf($localAssistantMessageTailNeedle, [System.StringComparison]::Ordinal)
if ($localAssistantMessageTailMatch -lt 0) {
    throw "Could not find the pinned Work/Codex assistant-message renderer tail."
}
if ($localTurnText.IndexOf($localAssistantMessageTailNeedle, $localAssistantMessageTailMatch + $localAssistantMessageTailNeedle.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "Found more than one Work/Codex assistant-message renderer tail."
}
$localTurnText = $localTurnText.Replace($localAssistantMessageTailNeedle, $localAssistantMessageTailReplacement)
[System.IO.File]::WriteAllText($LocalTurnFile[0].FullName, $localTurnText, $utf8NoBom)

$TokenUsageFile = @(Get-ChildItem -LiteralPath (Join-Path $PatchedSource "webview\assets") -Filter "app-server-manager-signals-*.js")
if ($TokenUsageFile.Count -ne 1) {
    throw "Expected exactly one app-server token-usage bundle, found $($TokenUsageFile.Count)."
}
$tokenUsageText = [System.IO.File]::ReadAllText($TokenUsageFile[0].FullName)
$tokenUsageNeedle = 'case`thread/tokenUsage/updated`:{let{threadId:e,tokenUsage:t}=n.params,r=B(e);this.updateConversationState(r,e=>{e.latestTokenUsageInfo=t});break}'
$tokenUsageReplacement = 'case`thread/tokenUsage/updated`:{let{threadId:e,tokenUsage:t}=n.params,r=B(e);this.updateConversationState(r,e=>{e.latestTokenUsageInfo=t});globalThis.GPT_CODEX_CUSTOM_SYNC_TOKEN_USAGE?.({mode:globalThis.GPT_CODEX_CUSTOM_RESOLVE_TOKEN_MODE?.(e),threadId:e,turnId:n.params.turnId??null,tokenUsage:t,source:`server`});break}'
$tokenUsageNeedleLatest = 'case`thread/tokenUsage/updated`:{let{threadId:e,tokenUsage:t}=n.params,r=V(e);this.updateConversationState(r,e=>{e.latestTokenUsageInfo=t});break}'
$tokenUsageReplacementLatest = 'case`thread/tokenUsage/updated`:{let{threadId:e,tokenUsage:t}=n.params,r=V(e);this.updateConversationState(r,e=>{e.latestTokenUsageInfo=t});globalThis.GPT_CODEX_CUSTOM_SYNC_TOKEN_USAGE?.({mode:globalThis.GPT_CODEX_CUSTOM_RESOLVE_TOKEN_MODE?.(e),threadId:e,turnId:n.params.turnId??null,tokenUsage:t,source:`server`});break}'
$tokenUsageSequences = @(
    [pscustomobject]@{ Name = "26.707.31428 / 26.707.51957"; Needle = $tokenUsageNeedle; Replacement = $tokenUsageReplacement }
    [pscustomobject]@{ Name = "26.707.71524"; Needle = $tokenUsageNeedleLatest; Replacement = $tokenUsageReplacementLatest }
)
$tokenUsageText = Replace-UniqueSupportedSequence -Text $tokenUsageText -Sequences $tokenUsageSequences -Description "server token-usage update sequence"
[System.IO.File]::WriteAllText($TokenUsageFile[0].FullName, $tokenUsageText, $utf8NoBom)

$nativeModelBridgeNeedle = 'function Ce(){H==null||V!=null||Se(H.model,H.reasoningEffort)}function we(){U&&ud()}iS(`composer.openModelPicker`,()=>{'
$nativeModelBridgeReplacement = 'function Ce(){H==null||V!=null||Se(H.model,H.reasoningEffort)}function we(){U&&ud()}let GPTCodexMode=globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES?.mode??`codex`;if(GPTCodexMode===`work`||GPTCodexMode===`codex`){let GPTCodexModels=f??[],GPTCodexSelection={slug:g,model:g,thinkingEffort:z,reasoningEffort:z},GPTCodexSelect=t=>{let n=String(t?.model??t?.slug??``),r=String(t?.reasoningEffort??t?.thinkingEffort??``),i=GPTCodexModels.some(e=>e.model===n&&e.supportedReasoningEfforts?.some(e=>e.reasoningEffort===r));if(!i)throw Error(`The selected model and effort are not available in the active native model snapshot`);return Se(n,r)},GPTCodexSetFastEnabled=t=>{if(!S||N||re==null)throw Error(`Fast mode is unavailable in the active native service-tier snapshot`);return x(t?re:null,`composer_menu`)};globalThis.GPT_CODEX_CUSTOM_NATIVE_MODEL_PICKER={version:2,kind:`native`,mode:GPTCodexMode,scope:{conversationId:e,hostId:i.hostId,cwd:i.cwd??null},conversationId:e,hostId:i.hostId,cwd:i.cwd??null,status:d,nativeCompactAvailable:U,models:GPTCodexModels,powerSelections:L,selected:GPTCodexSelection,select:GPTCodexSelect,serviceTier:{allowed:S,availableOptions:b.availableOptions??[],canToggleFast:S&&!N&&re!=null&&(ne===re||Vi(te,re)),fastCompatible:re!=null&&Vi(te,re),fastEffective:ae,fastEnabled:J===`fast`,fastValue:re??null,loading:b.isLoading===true,selectedIconKind:J,selectedOption:q??null,selectedServiceTier:ne??null,serviceTierForRequest:b.serviceTierForRequest??null},setFastEnabled:GPTCodexSetFastEnabled};globalThis.GPT_CODEX_CUSTOM_SYNC_NATIVE_MODEL_PICKER?.(globalThis.GPT_CODEX_CUSTOM_NATIVE_MODEL_PICKER)}iS(`composer.openModelPicker`,()=>{if(globalThis.GPT_CODEX_CUSTOM_OPEN_MODEL_PICKER?.())return;'
$nativeModelBridgeNeedleNew = 'function we(){U==null||H!=null||Ce(U.model,U.reasoningEffort)}function Te(){W&&ud()}iS(`composer.openModelPicker`,()=>{'
$nativeModelBridgeReplacementNew = 'function we(){U==null||H!=null||Ce(U.model,U.reasoningEffort)}function Te(){W&&ud()}let GPTCodexMode=globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES?.mode??`codex`;if(GPTCodexMode===`work`||GPTCodexMode===`codex`){let GPTCodexModels=m??[],GPTCodexSelection={slug:y,model:y,thinkingEffort:B,reasoningEffort:B},GPTCodexSelect=t=>{let n=String(t?.model??t?.slug??``),r=String(t?.reasoningEffort??t?.thinkingEffort??``),i=GPTCodexModels.some(e=>e.model===n&&e.supportedReasoningEfforts?.some(e=>e.reasoningEffort===r));if(!i)throw Error(`The selected model and effort are not available in the active native model snapshot`);return Ce(n,r)},GPTCodexSetFastEnabled=t=>{if(!C||P||J==null)throw Error(`Fast mode is unavailable in the active native service-tier snapshot`);return S(t?J:null,`composer_menu`)};globalThis.GPT_CODEX_CUSTOM_NATIVE_MODEL_PICKER={version:2,kind:`native`,mode:GPTCodexMode,scope:{conversationId:e,hostId:a.hostId,cwd:a.cwd??null},conversationId:e,hostId:a.hostId,cwd:a.cwd??null,status:f,nativeCompactAvailable:W,models:GPTCodexModels,powerSelections:R,selected:GPTCodexSelection,select:GPTCodexSelect,serviceTier:{allowed:C,availableOptions:x.availableOptions??[],canToggleFast:C&&!P&&J!=null&&(q===J||Vi(ne,J)),fastCompatible:J!=null&&Vi(ne,J),fastEffective:ae,fastEnabled:Y===`fast`,fastValue:J??null,loading:x.isLoading===true,selectedIconKind:Y,selectedOption:re??null,selectedServiceTier:q??null,serviceTierForRequest:x.serviceTierForRequest??null},setFastEnabled:GPTCodexSetFastEnabled};globalThis.GPT_CODEX_CUSTOM_SYNC_NATIVE_MODEL_PICKER?.(globalThis.GPT_CODEX_CUSTOM_NATIVE_MODEL_PICKER)}iS(`composer.openModelPicker`,()=>{if(globalThis.GPT_CODEX_CUSTOM_OPEN_MODEL_PICKER?.())return;'
$nativeModelBridgeNeedleLatest = 'function we(){U==null||H!=null||Ce(U.model,U.reasoningEffort)}function Te(){W&&fd()}oS(`composer.openModelPicker`,()=>{'
$nativeModelBridgeReplacementLatest = 'function we(){U==null||H!=null||Ce(U.model,U.reasoningEffort)}function Te(){W&&fd()}let GPTCodexMode=globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES?.mode??`codex`;if(GPTCodexMode===`work`||GPTCodexMode===`codex`){let GPTCodexModels=m??[],GPTCodexSelection={slug:y,model:y,thinkingEffort:B,reasoningEffort:B},GPTCodexSelect=t=>{let n=String(t?.model??t?.slug??``),r=String(t?.reasoningEffort??t?.thinkingEffort??``),i=GPTCodexModels.some(e=>e.model===n&&e.supportedReasoningEfforts?.some(e=>e.reasoningEffort===r));if(!i)throw Error(`The selected model and effort are not available in the active native model snapshot`);return Ce(n,r)},GPTCodexSetFastEnabled=t=>{if(!C||P||J==null)throw Error(`Fast mode is unavailable in the active native service-tier snapshot`);return S(t?J:null,`composer_menu`)};globalThis.GPT_CODEX_CUSTOM_NATIVE_MODEL_PICKER={version:2,kind:`native`,mode:GPTCodexMode,scope:{conversationId:e,hostId:a.hostId,cwd:a.cwd??null},conversationId:e,hostId:a.hostId,cwd:a.cwd??null,status:f,nativeCompactAvailable:W,models:GPTCodexModels,powerSelections:R,selected:GPTCodexSelection,select:GPTCodexSelect,serviceTier:{allowed:C,availableOptions:x.availableOptions??[],canToggleFast:C&&!P&&J!=null&&(q===J||Vi(ne,J)),fastCompatible:J!=null&&Vi(ne,J),fastEffective:ae,fastEnabled:Y===`fast`,fastValue:J??null,loading:x.isLoading===true,selectedIconKind:Y,selectedOption:re??null,selectedServiceTier:q??null,serviceTierForRequest:x.serviceTierForRequest??null},setFastEnabled:GPTCodexSetFastEnabled};globalThis.GPT_CODEX_CUSTOM_SYNC_NATIVE_MODEL_PICKER?.(globalThis.GPT_CODEX_CUSTOM_NATIVE_MODEL_PICKER)}oS(`composer.openModelPicker`,()=>{if(globalThis.GPT_CODEX_CUSTOM_OPEN_MODEL_PICKER?.())return;'
$nativeModelBridgeSequences = @(
    [pscustomobject]@{ Name = "26.707.31428"; Needle = $nativeModelBridgeNeedle; Replacement = $nativeModelBridgeReplacement }
    [pscustomobject]@{ Name = "26.707.51957"; Needle = $nativeModelBridgeNeedleNew; Replacement = $nativeModelBridgeReplacementNew }
    [pscustomobject]@{ Name = "26.707.71524"; Needle = $nativeModelBridgeNeedleLatest; Replacement = $nativeModelBridgeReplacementLatest }
)

$composerTokenNeedle = 'let u=c,d=$e(me.showContextWindowUsage),f=_(ha,u),p;'
$composerTokenReplacement = 'let u=c,d=$e(me.showContextWindowUsage),f=_(ha,u),GPTCodexTokenComposer=(0,Fk.useRef)(null),GPTCodexComposerMode=globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES?.mode;if(GPTCodexTokenComposer.current==null&&(GPTCodexComposerMode===`work`||GPTCodexComposerMode===`codex`)){let GPTCodexComposerGeneration=(Number(globalThis.GPT_CODEX_CUSTOM_TOKEN_COMPOSER_SEQUENCE)||0)+1;globalThis.GPT_CODEX_CUSTOM_TOKEN_COMPOSER_SEQUENCE=GPTCodexComposerGeneration,GPTCodexTokenComposer.current={id:`${GPTCodexComposerMode}:${GPTCodexComposerGeneration}`,generation:GPTCodexComposerGeneration,mode:GPTCodexComposerMode}}document.documentElement.getAttribute(`data-gpt-codex-custom-mode`)===`chat`||GPTCodexTokenComposer.current==null||globalThis.GPT_CODEX_CUSTOM_SYNC_TOKEN_CONTEXT?.({mode:GPTCodexTokenComposer.current.mode,threadId:u,tokenUsage:f,source:`composer`,composerId:GPTCodexTokenComposer.current.id,composerGeneration:GPTCodexTokenComposer.current.generation});let p;'
$composerTokenNeedleNew = 'let u=c,d=$e(pe.showContextWindowUsage),f=_(ha,u),p;'
$composerTokenReplacementNew = 'let u=c,d=$e(pe.showContextWindowUsage),f=_(ha,u),GPTCodexTokenComposer=(0,Fk.useRef)(null),GPTCodexComposerMode=globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES?.mode;if(GPTCodexTokenComposer.current==null&&(GPTCodexComposerMode===`work`||GPTCodexComposerMode===`codex`)){let GPTCodexComposerGeneration=(Number(globalThis.GPT_CODEX_CUSTOM_TOKEN_COMPOSER_SEQUENCE)||0)+1;globalThis.GPT_CODEX_CUSTOM_TOKEN_COMPOSER_SEQUENCE=GPTCodexComposerGeneration,GPTCodexTokenComposer.current={id:`${GPTCodexComposerMode}:${GPTCodexComposerGeneration}`,generation:GPTCodexComposerGeneration,mode:GPTCodexComposerMode}}document.documentElement.getAttribute(`data-gpt-codex-custom-mode`)===`chat`||GPTCodexTokenComposer.current==null||globalThis.GPT_CODEX_CUSTOM_SYNC_TOKEN_CONTEXT?.({mode:GPTCodexTokenComposer.current.mode,threadId:u,tokenUsage:f,source:`composer`,composerId:GPTCodexTokenComposer.current.id,composerGeneration:GPTCodexTokenComposer.current.generation});let p;'
$composerTokenReplacementLatest = 'let u=c,d=$e(pe.showContextWindowUsage),f=_(ha,u),GPTCodexTokenComposer=(0,qO.useRef)(null),GPTCodexComposerMode=globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES?.mode;if(GPTCodexTokenComposer.current==null&&(GPTCodexComposerMode===`work`||GPTCodexComposerMode===`codex`)){let GPTCodexComposerGeneration=(Number(globalThis.GPT_CODEX_CUSTOM_TOKEN_COMPOSER_SEQUENCE)||0)+1;globalThis.GPT_CODEX_CUSTOM_TOKEN_COMPOSER_SEQUENCE=GPTCodexComposerGeneration,GPTCodexTokenComposer.current={id:`${GPTCodexComposerMode}:${GPTCodexComposerGeneration}`,generation:GPTCodexComposerGeneration,mode:GPTCodexComposerMode}}document.documentElement.getAttribute(`data-gpt-codex-custom-mode`)===`chat`||GPTCodexTokenComposer.current==null||globalThis.GPT_CODEX_CUSTOM_SYNC_TOKEN_CONTEXT?.({mode:GPTCodexTokenComposer.current.mode,threadId:u,tokenUsage:f,source:`composer`,composerId:GPTCodexTokenComposer.current.id,composerGeneration:GPTCodexTokenComposer.current.generation});let p;'
$composerTokenReplacementCurrent = $composerTokenReplacementLatest.Replace('(0,qO.useRef)(null)', '(0,Pk.useRef)(null)')
$composerTokenSequences = @(
    [pscustomobject]@{ Name = "26.707.31428"; Needle = $composerTokenNeedle; Replacement = $composerTokenReplacement }
)
switch ([string]$UpstreamManifest.appVersion) {
    "26.707.31428" { }
    "26.707.51957" {
        $composerTokenSequences += [pscustomobject]@{ Name = "26.707.51957"; Needle = $composerTokenNeedleNew; Replacement = $composerTokenReplacementNew }
    }
    "26.707.62119" {
        $composerTokenSequences += [pscustomobject]@{ Name = "26.707.62119"; Needle = $composerTokenNeedleNew; Replacement = $composerTokenReplacementNew }
    }
    "26.707.71524" {
        $composerTokenSequences += [pscustomobject]@{ Name = "26.707.71524"; Needle = $composerTokenNeedleNew; Replacement = $composerTokenReplacementLatest }
    }
    "26.707.72221" {
        $composerTokenSequences += [pscustomobject]@{ Name = "26.707.72221"; Needle = $composerTokenNeedleNew; Replacement = $composerTokenReplacementCurrent }
    }
    default {
        throw "The active composer token bridge has no reviewed React alias for upstream app version $($UpstreamManifest.appVersion)."
    }
}
$composerTokenNeedles = @($composerTokenNeedle, $composerTokenNeedleNew)

$ComposerTokenFile = @(Get-ChildItem -LiteralPath (Join-Path $PatchedSource "webview\assets") -Filter "composer-*.js" | Where-Object {
    $candidateText = [System.IO.File]::ReadAllText($_.FullName)
    @($composerTokenNeedles | Where-Object { $candidateText.Contains($_) }).Count -gt 0
})
if ($ComposerTokenFile.Count -ne 1) {
    throw "Expected exactly one active composer token-state bundle, found $($ComposerTokenFile.Count)."
}
$composerTokenText = [System.IO.File]::ReadAllText($ComposerTokenFile[0].FullName)
$composerTokenText = Replace-UniqueSupportedSequence -Text $composerTokenText -Sequences $nativeModelBridgeSequences -Description "Work/Codex native model-picker sequence"
$composerTokenText = Replace-UniqueSupportedSequence -Text $composerTokenText -Sequences $composerTokenSequences -Description "active composer token-state sequence"
[System.IO.File]::WriteAllText($ComposerTokenFile[0].FullName, $composerTokenText, $utf8NoBom)

& node $AsarCli pack $PatchedSource $OutputArchive --unpack-dir node_modules
if ($LASTEXITCODE -ne 0) {
    throw "ASAR repack failed with exit code $LASTEXITCODE."
}

$RuntimeArchive = Join-Path $RuntimeResources "app.asar"
$RuntimeUnpacked = Join-Path $RuntimeResources "app.asar.unpacked"
$GeneratedUnpacked = "$OutputArchive.unpacked"

Assert-ProjectPath $RuntimeArchive
Assert-ProjectPath $RuntimeUnpacked
Copy-Item -LiteralPath $OutputArchive -Destination $RuntimeArchive -Force

if (Test-Path -LiteralPath $RuntimeUnpacked) {
    Remove-Item -LiteralPath $RuntimeUnpacked -Recurse -Force
}
if (Test-Path -LiteralPath $GeneratedUnpacked) {
    Copy-Item -LiteralPath $GeneratedUnpacked -Destination $RuntimeUnpacked -Recurse -Force
}

$OwlIni = Join-Path $RuntimeResources "owl-app.ini"
[System.IO.File]::WriteAllText(
    $OwlIni,
    "[Owl]`r`nUserDataDirectoryName=GPTCodexCustom`r`n",
    $utf8NoBom
)

$archiveHash = (Get-FileHash -LiteralPath $RuntimeArchive -Algorithm SHA256).Hash
$buildMetadata = [ordered]@{
    name = "GPT + Codex Custom"
    upstreamPackage = $UpstreamManifest.packageFullName
    upstreamVersion = $UpstreamManifest.packageVersion
    upstreamAppVersion = $UpstreamManifest.appVersion
    builtAtUtc = [DateTime]::UtcNow.ToString("o")
    appAsarSha256 = $archiveHash
    profileName = "GPTCodexCustom"
    allowsSideBySideLaunch = $true
}
$metadataJson = $buildMetadata | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText(
    (Join-Path $RuntimeRoot "CUSTOM_BUILD.json"),
    $metadataJson + "`r`n",
    $utf8NoBom
)

& $LauncherBuildScript

Write-Host "Custom GPT/Codex runtime built successfully." -ForegroundColor Green
Write-Host "Runtime: $RuntimeRoot"
Write-Host "app.asar SHA-256: $archiveHash"
