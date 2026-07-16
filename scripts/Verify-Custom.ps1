[CmdletBinding()]
param(
    [switch]$RequireRunning,
    [switch]$RequireChatReady,
    [switch]$RequireChatActions
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RequireStartupContract = [bool]($RequireChatReady -or $RequireChatActions)
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$RuntimeAsarForReport = Join-Path $ProjectRoot "work\runtime\resources\app.asar"
$ReleaseVerificationPath = Join-Path $ProjectRoot "work\verification\release-verification.json"
$verificationResults = [ordered]@{}
$verificationStatusOverrides = [ordered]@{}
$verificationCompleted = $false
$verificationError = $null

function Test-TextContainsAll {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Text,

        [Parameter(Mandatory)]
        [string[]]$Markers
    )

    foreach ($marker in $Markers) {
        if (-not $Text.Contains($marker)) {
            return $false
        }
    }
    return $true
}

function Test-ModelPickerUltraShakeContract {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$JavaScript,

        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Css
    )

    return (
        (Test-TextContainsAll -Text $JavaScript -Markers @(
            'const MOTION_EFFECTIVE_ATTRIBUTE = "data-gpt-codex-motion";'
            'const systemReducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");'
            'systemReducedMotionQuery.addEventListener("change", handleSystemMotionPreferenceChange)'
            'function prefersReducedMotion()'
            'function runUltraShake()'
            'ultraActivation && choice.ultra'
            'result.then(completeSelection, failSelection)'
            'pickerPanel?.classList.add("gpt-codex-model-picker--ultra-shake")'
            'composer?.setAttribute("data-gpt-codex-ultra-shake", "true")'
            'composer?.removeAttribute("data-gpt-codex-ultra-shake")'
        )) -and
        (Test-TextContainsAll -Text $Css -Markers @(
            '@keyframes gpt-codex-model-picker-ultra-shake'
            '.gpt-codex-model-picker__panel.gpt-codex-model-picker--ultra-shake'
            ':root[data-gpt-codex-motion="reduced"] :is('
            '[data-gpt-codex-ultra-shake="true"]'
            'animation: none !important'
            'transition: none !important'
        ))
    )
}

function Test-ModelPickerFluidMotionContract {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$JavaScript,

        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Css
    )

    return (
        (Test-TextContainsAll -Text $JavaScript -Markers @(
            'const PANEL_EXIT_DURATION_MS = 190;'
            'const SELECTION_MOTION_DURATION_MS = 320;'
            'function captureSelectionMotionSnapshot(choice)'
            'function animateSelectionUpdate(snapshot)'
            'pendingSelectionMotion?.targetKey === selectionKey(state.selected)'
            'pickerPanel.dataset.motion = "opening"'
            'pickerPanel.dataset.motion = "open"'
            'pickerPanel.dataset.motion = "closing"'
            'const reversingClose = !pickerPanel.hidden && pickerPanel.dataset.motion === "closing";'
            'panelCloseTransitionTarget.addEventListener("transitionend", panelCloseTransitionHandler)'
            'panelCloseTimer = window.setTimeout(finalizePanelClose, PANEL_EXIT_DURATION_MS + 80)'
            'function settleModelPickerForReducedMotion()'
            'if (reversingClose || prefersReducedMotion())'
        )) -and
        (Test-TextContainsAll -Text $Css -Markers @(
            '.gpt-codex-model-picker__panel[data-motion="open"]'
            '.gpt-codex-model-picker__panel[data-motion="closing"]'
            '.gpt-codex-model-picker__panel[data-motion="opening"] :is('
            'height: 3px'
            'box-shadow: none !important'
            'width 320ms'
            ':root[data-gpt-codex-motion="reduced"] :is('
            'transition: none !important'
        ))
    )
}

function Test-ModelPickerNativeSelectionContract {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$JavaScript
    )

    $localStorageReferenceCount = [regex]::Matches(
        $JavaScript,
        '(?<![\w$])localStorage(?![\w$])'
    ).Count
    $motionPreferenceReadCount = [regex]::Matches(
        $JavaScript,
        'localStorage\.getItem\(\s*MOTION_PREFERENCE_STORAGE_KEY\s*\)'
    ).Count
    $motionPreferenceWriteCount = [regex]::Matches(
        $JavaScript,
        'localStorage\.setItem\(\s*MOTION_PREFERENCE_STORAGE_KEY\s*,\s*preference\s*\)'
    ).Count

    return (
        (Test-TextContainsAll -Text $JavaScript -Markers @(
            'const MOTION_PREFERENCE_STORAGE_KEY = "gpt-codex-custom.motion-preference.v1";'
            'const selected = normalizeSelection(bridge?.selected);'
            'typeof state.bridge.select === "function"'
            'function selectThroughBridge(bridge, choice)'
            'return bridge.select({'
            'choiceStillAvailable'
            'pendingSelectionMotion?.targetKey === selectionKey(state.selected)'
            'result.then(completeSelection, failSelection)'
            'nativeSelectionUnchanged'
        )) -and
        $localStorageReferenceCount -eq 3 -and
        $motionPreferenceReadCount -eq 2 -and
        $motionPreferenceWriteCount -eq 1 -and
        -not [regex]::IsMatch($JavaScript, '(?<![\w$])(?:sessionStorage|indexedDB)(?![\w$])') -and
        -not [regex]::IsMatch($JavaScript, '\bbridge\s*\.\s*selected\s*=')
    )
}

function Test-ModelPickerModeHandoffEvidence {
    param(
        [Parameter(Mandatory)]
        [object]$Evidence,

        [Parameter(Mandatory)]
        [ValidateSet("work", "codex")]
        [string]$ExpectedMode
    )

    if ($null -eq $Evidence) {
        return $false
    }

    try {
        return (
            $Evidence.pass -is [bool] -and
            $Evidence.pass -eq $true -and
            [int]$Evidence.schemaVersion -eq 3 -and
            [double]$Evidence.sampleDurationMs -ge 2000 -and
            [double]$Evidence.stableDurationMs -ge 2000 -and
            [int]$Evidence.postModeSampleCount -ge 30 -and
            [int]$Evidence.probeUnavailableSampleCount -eq 0 -and
            [int]$Evidence.postModeProbeUnavailableSampleCount -eq 0 -and
            [int]$Evidence.duplicateFrameCount -eq 0 -and
            [int]$Evidence.missingControlFrameCount -eq 0 -and
            [int]$Evidence.classifierErrorFrameCount -eq 0 -and
            [int]$Evidence.unrelatedSuppressionFrameCount -eq 0 -and
            [int]$Evidence.nonActionableControlFrameCount -eq 0 -and
            [int]$Evidence.modeMismatchFrameCount -eq 0 -and
            [int]$Evidence.multipleCustomHostFrameCount -eq 0 -and
            [int]$Evidence.maxVisibleNativeTriggerCount -le 1 -and
            [int]$Evidence.maxVisibleCustomTriggerCount -le 1 -and
            [int]$Evidence.maxCustomTriggerCount -le 1 -and
            [int]$Evidence.maxCustomHostCount -le 1 -and
            [int]$Evidence.minSameSlotVisibleControlCount -eq 1 -and
            [int]$Evidence.maxSameSlotVisibleControlCount -eq 1 -and
            [int]$Evidence.minSameSlotActionableControlCount -eq 1 -and
            [int]$Evidence.maxSameSlotActionableControlCount -eq 1 -and
            $Evidence.bridgeKind -ceq "native" -and
            $Evidence.composerAnchored -eq $true -and
            $Evidence.customReplacementActionable -eq $true -and
            [int]$Evidence.customTriggerCount -eq 1 -and
            [int]$Evidence.customTriggerVisibleCount -eq 1 -and
            [int]$Evidence.nativeCompetingTriggerCount -eq 1 -and
            $Evidence.nativeTriggerSuppressed -eq $true -and
            $Evidence.placement -ceq "fixed" -and
            [int]$Evidence.unrelatedSuppressedNativeTriggerCount -eq 0 -and
            [int]$Evidence.visibleNativeTriggerCount -eq 0 -and
            $Evidence.final.activeMode -ceq $ExpectedMode -and
            $Evidence.final.bridgeKind -ceq "native" -and
            $Evidence.final.composerAnchored -eq $true -and
            [int]$Evidence.final.customHostCount -eq 1 -and
            $Evidence.final.customReplacementActionable -eq $true -and
            [int]$Evidence.final.customTriggerCount -eq 1 -and
            [int]$Evidence.final.customTriggerVisibleCount -eq 1 -and
            $Evidence.final.classifierValid -eq $true -and
            [int]$Evidence.final.nativeCompetingTriggerCount -eq 1 -and
            $Evidence.final.nativeTriggerSuppressed -eq $true -and
            $Evidence.final.placement -ceq "fixed" -and
            [int]$Evidence.final.sameSlotActionableControlCount -eq 1 -and
            [int]$Evidence.final.sameSlotVisibleControlCount -eq 1 -and
            [int]$Evidence.final.unrelatedSuppressedNativeTriggerCount -eq 0 -and
            [int]$Evidence.final.visibleNativeTriggerCount -eq 0
        )
    } catch {
        return $false
    }
}

function Test-UpstreamManifestValueMatch {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Expected,

        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Observed
    )

    return [string]::Equals($Expected, $Observed, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-UpstreamDriftStatusOverride {
    param(
        [Parameter(Mandatory)]
        [string]$Subject,

        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Expected,

        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Observed
    )

    if (Test-UpstreamManifestValueMatch -Expected $Expected -Observed $Observed) {
        return $null
    }
    return [PSCustomObject][ordered]@{
        Status = "Failed"
        Rationale = "$Subject drift from upstream.json: expected '$Expected'; observed '$Observed'."
    }
}

function Get-ModeContractOutcome {
    param(
        [Parameter(Mandatory)]
        [object]$Contract,

        [Parameter(Mandatory)]
        [string]$Label,

        [Parameter(Mandatory)]
        [ValidateSet("chat", "native")]
        [string]$ExpectedMode,

        [Parameter(Mandatory)]
        [string[]]$BooleanPropertyNames,

        [Parameter(Mandatory)]
        [string[]]$ModePropertyNames
    )

    foreach ($propertyName in $BooleanPropertyNames) {
        $property = $Contract.PSObject.Properties[$propertyName]
        if ($null -eq $property) {
            continue
        }

        $isBoolean = $property.Value -is [bool]
        return [PSCustomObject][ordered]@{
            Label = $Label
            Available = $true
            Passed = ($isBoolean -and $property.Value -eq $true)
            Expected = $ExpectedMode
            Actual = if ($isBoolean -and $property.Value -eq $true) { $ExpectedMode } else { "unexpected" }
        }
    }

    foreach ($propertyName in $ModePropertyNames) {
        $property = $Contract.PSObject.Properties[$propertyName]
        if ($null -eq $property) {
            continue
        }

        $value = $property.Value
        if ($null -ne $value -and $value -isnot [string]) {
            foreach ($nestedName in @("resolvedMode", "mode", "result", "value")) {
                $nestedProperty = $value.PSObject.Properties[$nestedName]
                if ($null -ne $nestedProperty) {
                    $value = $nestedProperty.Value
                    break
                }
            }
        }

        $normalizedValue = if ($null -eq $value) {
            ""
        } else {
            ([string]$value).Trim().ToLowerInvariant()
        }
        return [PSCustomObject][ordered]@{
            Label = $Label
            Available = $true
            Passed = ($normalizedValue -ceq $ExpectedMode)
            Expected = $ExpectedMode
            Actual = if ($normalizedValue -in @("chat", "native")) { $normalizedValue } else { "unexpected" }
        }
    }

    return [PSCustomObject][ordered]@{
        Label = $Label
        Available = $false
        Passed = $false
        Expected = $ExpectedMode
        Actual = "missing"
    }
}

function Get-StartupModeContractEvaluation {
    param(
        [Parameter(Mandatory)]
        [string]$DiagnosticsPath,

        [Parameter(Mandatory)]
        [string]$RuntimeAsarPath
    )

    if (-not (Test-Path -LiteralPath $DiagnosticsPath -PathType Leaf)) {
        return [PSCustomObject][ordered]@{
            Passed = $false
            Status = "Skipped"
            Rationale = "Renderer diagnostics are absent, so fresh-profile and stored-mode startup behavior is unproven."
        }
    }

    if (
        (Test-Path -LiteralPath $RuntimeAsarPath -PathType Leaf) -and
        (Get-Item -LiteralPath $DiagnosticsPath).LastWriteTimeUtc.AddSeconds(2) -lt
            (Get-Item -LiteralPath $RuntimeAsarPath).LastWriteTimeUtc
    ) {
        return [PSCustomObject][ordered]@{
            Passed = $false
            Status = "Skipped"
            Rationale = "Renderer diagnostics predate the current runtime ASAR, so the startup-mode contract evidence is stale."
        }
    }

    try {
        $diagnostics = Get-Content -Raw -LiteralPath $DiagnosticsPath | ConvertFrom-Json
    } catch {
        return [PSCustomObject][ordered]@{
            Passed = $false
            Status = "Failed"
            Rationale = "Renderer diagnostics could not be parsed, so the startup-mode contract cannot be verified."
        }
    }

    $contract = $null
    $candidateNames = @(
        "startupModeContract",
        "initialProductModeContract",
        "firstRunModeContract",
        "productModeStartupContract",
        "productModeResolutionContract",
        "startupModeDiagnostics",
        "initialModeDiagnostics",
        "modeResolutionContract",
        "productModeInitializationContract",
        "rendererContractSelfTest",
        "rendererContract",
        "rendererContractDiagnostics"
    )
    foreach ($candidateName in $candidateNames) {
        $property = $diagnostics.PSObject.Properties[$candidateName]
        if ($null -ne $property -and $null -ne $property.Value) {
            $contract = $property.Value
            break
        }
    }
    if ($null -eq $contract) {
        $contractProperty = @(
            $diagnostics.PSObject.Properties | Where-Object {
                $_.Name -match "(?i)(startup|initial|first.?run|fresh).*(product.?mode|mode).*(contract|diagnostic|resolution)|(?:product.?mode|mode).*(startup|initial|first.?run|fresh).*(contract|diagnostic|resolution)"
            }
        ) | Select-Object -First 1
        if ($null -ne $contractProperty) {
            $contract = $contractProperty.Value
        }
    }

    $topLevelOutcomeNames = @(
        "freshModeResolvesToChat",
        "freshProfileResolvesToChat",
        "emptyProfileResolvesToChat",
        "freshDefaultsToChat",
        "storedChatModeHonored",
        "storedChatHonored",
        "existingStoredChatHonored",
        "storedNativeModeHonored",
        "storedNativeHonored",
        "existingStoredNativeHonored"
    )
    if ($null -eq $contract) {
        $hasTopLevelContract = @(
            $topLevelOutcomeNames | Where-Object {
                $null -ne $diagnostics.PSObject.Properties[$_]
            }
        ).Count -gt 0
        if ($hasTopLevelContract) {
            $contract = $diagnostics
        }
    }

    if ($null -eq $contract) {
        return [PSCustomObject][ordered]@{
            Passed = $false
            Status = "Skipped"
            Rationale = "The current custom renderer diagnostics do not expose a startup-mode contract; fresh-profile behavior remains unproven."
        }
    }

    $freshModeDecisionProperty = $contract.PSObject.Properties["freshModeDecision"]
    if ($null -ne $freshModeDecisionProperty -and $null -ne $freshModeDecisionProperty.Value) {
        $caseProperty = $freshModeDecisionProperty.Value.PSObject.Properties["cases"]
        $cases = if ($null -ne $caseProperty) { @($caseProperty.Value) } else { @() }
        $caseContract = [ordered]@{}
        foreach ($caseDefinition in @(
            [PSCustomObject]@{
                Name = "fresh-profile-starts-in-chat"
                ResultName = "freshProfileResolvesToChat"
                ExpectedChatMode = $true
            },
            [PSCustomObject]@{
                Name = "stored-chat-is-honored"
                ResultName = "storedChatModeHonored"
                ExpectedChatMode = $true
            },
            [PSCustomObject]@{
                Name = "stored-native-is-honored"
                ResultName = "storedNativeModeHonored"
                ExpectedChatMode = $false
            }
        )) {
            $matchingCase = @(
                $cases | Where-Object {
                    $_.PSObject.Properties["name"] -and
                    [string]$_.PSObject.Properties["name"].Value -ceq $caseDefinition.Name
                }
            ) | Select-Object -First 1
            if ($null -eq $matchingCase) {
                continue
            }
            $passProperty = $matchingCase.PSObject.Properties["pass"]
            $actualProperty = $matchingCase.PSObject.Properties["actual"]
            $chatModeProperty = if ($null -ne $actualProperty -and $null -ne $actualProperty.Value) {
                $actualProperty.Value.PSObject.Properties["chatMode"]
            } else {
                $null
            }
            $caseContract[$caseDefinition.ResultName] = (
                $null -ne $passProperty -and
                $passProperty.Value -eq $true -and
                $null -ne $chatModeProperty -and
                $chatModeProperty.Value -is [bool] -and
                $chatModeProperty.Value -eq $caseDefinition.ExpectedChatMode
            )
        }
        $contract = [PSCustomObject]$caseContract
    }

    $outcomes = @(
        Get-ModeContractOutcome -Contract $contract -Label "fresh profile" -ExpectedMode "chat" `
            -BooleanPropertyNames @(
                "freshModeResolvesToChat",
                "freshProfileResolvesToChat",
                "emptyProfileResolvesToChat",
                "freshDefaultsToChat",
                "emptyProfileDefaultsToChat",
                "freshModeIsChat"
            ) `
            -ModePropertyNames @(
                "fresh",
                "freshMode",
                "freshProfile",
                "emptyProfile",
                "emptyProfileMode",
                "noStoredMode",
                "missingStoredMode"
            )
        Get-ModeContractOutcome -Contract $contract -Label "stored Chat" -ExpectedMode "chat" `
            -BooleanPropertyNames @(
                "storedChatModeHonored",
                "storedChatHonored",
                "existingStoredChatHonored",
                "storedChatResolvesToChat"
            ) `
            -ModePropertyNames @(
                "storedChat",
                "storedChatMode",
                "existingChat",
                "existingStoredChat"
            )
        Get-ModeContractOutcome -Contract $contract -Label "stored native" -ExpectedMode "native" `
            -BooleanPropertyNames @(
                "storedNativeModeHonored",
                "storedNativeHonored",
                "existingStoredNativeHonored",
                "storedNativeResolvesToNative"
            ) `
            -ModePropertyNames @(
                "storedNative",
                "storedNativeMode",
                "existingNative",
                "existingStoredNative"
            )
    )

    $missing = @($outcomes | Where-Object { -not $_.Available })
    if ($missing.Count -gt 0) {
        return [PSCustomObject][ordered]@{
            Passed = $false
            Status = "Failed"
            Rationale = "The startup-mode diagnostics are incomplete; missing outcomes: $($missing.Label -join ', ')."
        }
    }

    $incorrect = @($outcomes | Where-Object { -not $_.Passed })
    if ($incorrect.Count -gt 0) {
        $mismatches = @(
            $incorrect | ForEach-Object {
                "$($_.Label) expected $($_.Expected), observed $($_.Actual)"
            }
        )
        return [PSCustomObject][ordered]@{
            Passed = $false
            Status = "Failed"
            Rationale = "The startup-mode diagnostics disagree with the intended behavior: $($mismatches -join '; ')."
        }
    }

    return [PSCustomObject][ordered]@{
        Passed = $true
        Status = "Passed"
        Rationale = "Fresh profiles resolve to Chat, and stored Chat/native selections are honored."
    }
}

function Test-VerificationCheckRequired {
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [bool]$RequireRuntime,

        [Parameter(Mandatory)]
        [bool]$RequireStartupContract
    )

    if ($Name -eq "customRuntimeRunning") {
        return $RequireRuntime
    }
    if ($Name -eq "firstRunProductModeContract") {
        return $RequireStartupContract
    }
    return $true
}

function Get-RequiredVerificationFailures {
    param(
        [Parameter(Mandatory)]
        [System.Collections.IDictionary]$Results,

        [Parameter(Mandatory)]
        [bool]$RequireRuntime,

        [Parameter(Mandatory)]
        [bool]$RequireStartupContract
    )

    return @(
        $Results.GetEnumerator() | Where-Object {
            -not [bool]$_.Value -and
            (Test-VerificationCheckRequired `
                -Name ([string]$_.Key) `
                -RequireRuntime $RequireRuntime `
                -RequireStartupContract $RequireStartupContract)
        }
    )
}

function Write-ReleaseVerificationReport {
    param(
        [Parameter(Mandatory)]
        [string]$ReportPath,

        [Parameter(Mandatory)]
        [string]$RuntimeAsarPath,

        [Parameter(Mandatory)]
        [System.Collections.IDictionary]$Results,

        [Parameter(Mandatory)]
        [System.Collections.IDictionary]$StatusOverrides,

        [Parameter(Mandatory)]
        [bool]$Completed,

        [Parameter(Mandatory)]
        [bool]$RequireRuntime,

        [Parameter(Mandatory)]
        [bool]$RequireStartupContract
    )

    $checks = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $Results.GetEnumerator()) {
        $required = Test-VerificationCheckRequired `
            -Name ([string]$entry.Key) `
            -RequireRuntime $RequireRuntime `
            -RequireStartupContract $RequireStartupContract
        $status = if ($required) {
            if ([bool]$entry.Value) { "Passed" } else { "Failed" }
        } else {
            if ([bool]$entry.Value) { "Observed" } else { "Unavailable" }
        }
        $detail = $null
        if ($StatusOverrides.Contains($entry.Key)) {
            $override = $StatusOverrides[$entry.Key]
            $status = [string]$override.Status
            $detail = [string]$override.Rationale
        }
        $checks.Add([PSCustomObject][ordered]@{
            name = [string]$entry.Key
            required = $required
            status = $status
            detail = $detail
        })
    }
    if (-not $Completed) {
        $checks.Add([PSCustomObject][ordered]@{
            name = "verificationCompleted"
            required = $true
            status = "Failed"
            detail = "The verifier stopped before all required checks completed."
        })
    }

    $requiredChecks = @($checks | Where-Object { $_.required })
    $requiredPassed = @($requiredChecks | Where-Object { $_.status -eq "Passed" }).Count
    $requiredFailed = @($requiredChecks | Where-Object { $_.status -eq "Failed" }).Count
    $requiredSkipped = @($requiredChecks | Where-Object { $_.status -eq "Skipped" }).Count
    $runtimeAsarHash = if (Test-Path -LiteralPath $RuntimeAsarPath -PathType Leaf) {
        (Get-FileHash -LiteralPath $RuntimeAsarPath -Algorithm SHA256).Hash
    } else {
        $null
    }
    $report = [PSCustomObject][ordered]@{
        schemaVersion = 1
        verifier = "Verify-Custom.ps1"
        verifiedAtUtc = [DateTime]::UtcNow.ToString("o")
        runtimeAsarSha256 = $runtimeAsarHash
        summary = [PSCustomObject][ordered]@{
            status = if ($Completed -and ($requiredFailed + $requiredSkipped) -eq 0) { "passed" } else { "failed" }
            requiredTotal = $requiredChecks.Count
            requiredPassed = $requiredPassed
            requiredFailed = $requiredFailed
            requiredSkipped = $requiredSkipped
        }
        checks = @($checks)
    }

    $reportDirectory = Split-Path -Parent $ReportPath
    New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $json = $report | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($ReportPath, $json + [Environment]::NewLine, $utf8NoBom)
}

try {
$UpstreamManifestPath = Join-Path $ProjectRoot "upstream.json"
if (-not (Test-Path -LiteralPath $UpstreamManifestPath)) {
    throw "Upstream manifest is missing: $UpstreamManifestPath"
}
$UpstreamManifest = Get-Content -Raw -LiteralPath $UpstreamManifestPath | ConvertFrom-Json
$ExpectedPackage = [string]$UpstreamManifest.packageFullName
$ExpectedVersion = [string]$UpstreamManifest.packageVersion
$ExpectedAsarHash = [string]$UpstreamManifest.appAsarSha256
$ExpectedExeHash = [string]$UpstreamManifest.executableSha256

$VendorAsar = Join-Path $ProjectRoot "vendor\package\app\resources\app.asar"
$VendorExe = Join-Path $ProjectRoot "vendor\package\app\ChatGPT.exe"
$RuntimeAsar = $RuntimeAsarForReport
$RuntimeExe = Join-Path $ProjectRoot "work\runtime\ChatGPT.exe"
$PatchedIndex = Join-Path $ProjectRoot "work\patched-src\webview\index.html"
$CustomCss = Join-Path $ProjectRoot "work\patched-src\webview\assets\gpt-codex-custom.css"
$CustomJs = Join-Path $ProjectRoot "work\patched-src\webview\assets\gpt-codex-custom.js"
$TokenHudCss = Join-Path $ProjectRoot "work\patched-src\webview\assets\gpt-codex-token-hud.css"
$TokenHudJs = Join-Path $ProjectRoot "work\patched-src\webview\assets\gpt-codex-token-hud.js"
$PinboardCss = Join-Path $ProjectRoot "work\patched-src\webview\assets\gpt-codex-pinboard.css"
$PinboardJs = Join-Path $ProjectRoot "work\patched-src\webview\assets\gpt-codex-pinboard.js"
$ModelPickerCss = Join-Path $ProjectRoot "work\patched-src\webview\assets\gpt-codex-model-picker.css"
$ModelPickerJs = Join-Path $ProjectRoot "work\patched-src\webview\assets\gpt-codex-model-picker.js"
$MaintainedCustomCss = Join-Path $ProjectRoot "custom\gpt-codex-custom.css"
$MaintainedCustomJs = Join-Path $ProjectRoot "custom\gpt-codex-custom.js"
$MaintainedTokenHudCss = Join-Path $ProjectRoot "custom\gpt-codex-token-hud.css"
$MaintainedTokenHudJs = Join-Path $ProjectRoot "custom\gpt-codex-token-hud.js"
$MaintainedModelPickerCss = Join-Path $ProjectRoot "custom\gpt-codex-model-picker.css"
$MaintainedModelPickerJs = Join-Path $ProjectRoot "custom\gpt-codex-model-picker.js"
$OwlIni = Join-Path $ProjectRoot "work\runtime\resources\owl-app.ini"
$AsarCli = Join-Path $ProjectRoot "node_modules\@electron\asar\bin\asar.js"
$DiagnosticsFile = Join-Path $ProjectRoot "profile\chromium\gpt-codex-custom-diagnostics.json"
$SelfTestFile = Join-Path $ProjectRoot "profile\chromium\gpt-codex-custom-self-test-result.json"
$PatchedBootstrap = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "work\patched-src\.vite\build") -Filter "bootstrap-*.js")
$PatchedMain = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "work\patched-src\.vite\build") -Filter "main-*.js")
$PatchedAppMain = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "work\patched-src\webview\assets") -Filter "app-main-*.js")
$PatchedQuickChat = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "work\patched-src\webview\assets") -Filter "quick-chat-window-*.js" | Where-Object {
    (Get-Content -Raw -LiteralPath $_.FullName).Contains("GPT_CODEX_CUSTOM_IMAGE_COMPOSER")
})
$PatchedChatGptThread = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "work\patched-src\webview\assets") -Filter "chatgpt-thread-visibility-*.js")
$PatchedGeneratedImagePreview = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "work\patched-src\webview\assets") -Filter "generated-image-preview-*.js")
$PatchedLocalTurn = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "work\patched-src\webview\assets") -Filter "local-conversation-turn-*.js")
$PatchedTokenUsage = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "work\patched-src\webview\assets") -Filter "app-server-manager-signals-*.js")
$PatchedComposerToken = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "work\patched-src\webview\assets") -Filter "composer-*.js" | Where-Object {
    (Get-Content -Raw -LiteralPath $_.FullName).Contains("GPT_CODEX_CUSTOM_SYNC_TOKEN_CONTEXT")
})

foreach ($requiredPath in @(
    $VendorAsar,
    $VendorExe,
    $RuntimeAsar,
    $RuntimeExe,
    $PatchedIndex,
    $CustomCss,
    $CustomJs,
    $TokenHudCss,
    $TokenHudJs,
    $PinboardCss,
    $PinboardJs,
    $ModelPickerCss,
    $ModelPickerJs,
    $MaintainedCustomCss,
    $MaintainedCustomJs,
    $MaintainedTokenHudCss,
    $MaintainedTokenHudJs,
    $MaintainedModelPickerCss,
    $MaintainedModelPickerJs,
    $OwlIni,
    $AsarCli
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Verification path is missing: $requiredPath"
    }
}

$MaintainedCustomCssText = Get-Content -Raw -LiteralPath $MaintainedCustomCss
$MaintainedCustomJsText = Get-Content -Raw -LiteralPath $MaintainedCustomJs
$MaintainedTokenHudCssText = Get-Content -Raw -LiteralPath $MaintainedTokenHudCss
$MaintainedTokenHudJsText = Get-Content -Raw -LiteralPath $MaintainedTokenHudJs
$MaintainedModelPickerCssText = Get-Content -Raw -LiteralPath $MaintainedModelPickerCss
$MaintainedModelPickerJsText = Get-Content -Raw -LiteralPath $MaintainedModelPickerJs
$StartupModeContractEvaluation = Get-StartupModeContractEvaluation `
    -DiagnosticsPath $DiagnosticsFile `
    -RuntimeAsarPath $RuntimeAsar
$verificationStatusOverrides["firstRunProductModeContract"] = $StartupModeContractEvaluation
$PatchedQuickChatText = if ($PatchedQuickChat.Count -eq 1) {
    Get-Content -Raw -LiteralPath $PatchedQuickChat[0].FullName
} else {
    ""
}
$PatchedAppMainText = if ($PatchedAppMain.Count -eq 1) {
    Get-Content -Raw -LiteralPath $PatchedAppMain[0].FullName
} else {
    ""
}
$NativeChatManagementBridgeContractPresent = ($PatchedAppMain.Count -eq 1)
foreach ($requiredToken in @(
    "archiveConversation",
    "deleteConversation",
    "pinConversation",
    "renameConversation",
    "shareConversation",
    "setArchived",
    "setPinned",
    "createShareLink",
    "updateShareLink"
)) {
    $NativeChatManagementBridgeContractPresent = (
        $NativeChatManagementBridgeContractPresent -and $PatchedAppMainText.Contains($requiredToken)
    )
}
$NativeChatManagementBridgeContractPresent = (
    $NativeChatManagementBridgeContractPresent -and
    $MaintainedCustomJsText.Contains("conversationMenuFullActionSetVisible")
)
$GeneratedImageDialogRelativeRule = '(?is)\.gpt-codex-custom-generated-image-dialog\s*\{[^}]*\bposition\s*:\s*relative(?:\s*!important)?\s*(?:;|})'
$ChatScrollProbeContractPresent = (
    $MaintainedCustomJsText.Contains("GPT_CODEX_CUSTOM_CHAT_SCROLL_PROBE") -and
    $MaintainedCustomJsText.Contains("data-quick-chat-thread-scroll-container")
)
$GeneratedImageDialogPositioningSafe = -not [regex]::IsMatch(
    $MaintainedCustomCssText,
    $GeneratedImageDialogRelativeRule
)
$ModelPickerMatrixContractPresent = (
    $MaintainedModelPickerJsText.Contains("getMatrixColumns") -and
    $MaintainedModelPickerJsText.Contains("CHAT_MATRIX_COLUMN_IDS") -and
    $MaintainedModelPickerJsText.Contains("NATIVE_MATRIX_COLUMN_IDS") -and
    $MaintainedModelPickerJsText.Contains('setAttribute("role", "grid")') -and
    $MaintainedModelPickerJsText.Contains('setAttribute("role", "gridcell")') -and
    $MaintainedModelPickerJsText.Contains('setAttribute("role", "slider")') -and
    $MaintainedModelPickerJsText.Contains("supportedCells") -and
    $MaintainedModelPickerJsText.Contains("isPlaceholderData") -and
    $MaintainedModelPickerCssText.Contains("gpt-codex-model-picker__slider-track") -and
    $MaintainedModelPickerCssText.Contains("gpt-codex-model-picker__slider-knob")
)
$ModelPickerUltraContractPresent = (
    $MaintainedModelPickerJsText.Contains("isUltraOption") -and
    $MaintainedModelPickerJsText.Contains('effort === "ultra"') -and
    $MaintainedModelPickerJsText.Contains('setAttribute("role", "switch")') -and
    $MaintainedModelPickerJsText.Contains('setAttribute("aria-disabled", String(!canToggle))') -and
    $MaintainedModelPickerJsText.Contains("ultraChoice") -and
    $MaintainedModelPickerCssText.Contains("gpt-codex-model-picker__lever-handle")
)
$ModelPickerPointerContractPresent = (
    $MaintainedModelPickerJsText.Contains("attachSliderPointerBehavior") -and
    $MaintainedModelPickerJsText.Contains("getBoundedPointerPosition") -and
    $MaintainedModelPickerJsText.Contains("getNearestSupportedChoice") -and
    $MaintainedModelPickerJsText.Contains('addEventListener("pointermove", move') -and
    $MaintainedModelPickerJsText.Contains("suppressGridClickUntil") -and
    $MaintainedModelPickerCssText.Contains('data-dragging="true"')
)
$ModelPickerUltraShakeContractPresent = Test-ModelPickerUltraShakeContract `
    -JavaScript $MaintainedModelPickerJsText `
    -Css $MaintainedModelPickerCssText
$ModelPickerFluidMotionContractPresent = Test-ModelPickerFluidMotionContract `
    -JavaScript $MaintainedModelPickerJsText `
    -Css $MaintainedModelPickerCssText
$ModelPickerSelfTestContractPresent = (
    $MaintainedModelPickerJsText.Contains("GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE") -and
    $MaintainedModelPickerJsText.Contains("GPT_CODEX_CUSTOM_MODEL_PICKER_SELF_TEST") -and
    $MaintainedModelPickerJsText.Contains("nativeSelectionUnchanged") -and
    $MaintainedModelPickerJsText.Contains("ultraRequiresExplicitUltraOption") -and
    $MaintainedModelPickerJsText.Contains("synchronous: true")
)
$ModelPickerUsesNativeSelectionOnly = Test-ModelPickerNativeSelectionContract `
    -JavaScript $MaintainedModelPickerJsText
$ModelPickerSupportsAllModes = (
    $MaintainedModelPickerJsText.Contains("GPT_CODEX_CUSTOM_SYNC_CHAT_MODEL_PICKER") -and
    $MaintainedModelPickerJsText.Contains("GPT_CODEX_CUSTOM_SYNC_NATIVE_MODEL_PICKER") -and
    $MaintainedModelPickerJsText.Contains('return ["work", "codex"].includes(nativeMode) ? nativeMode : null') -and
    $MaintainedModelPickerJsText.Contains('"Instant|Medium|High|Extra high|Pro"') -and
    $MaintainedModelPickerJsText.Contains('"Low|Medium|High|Extra high|Max"') -and
    -not $MaintainedModelPickerCssText.Contains(':root:not([data-gpt-codex-custom-mode="chat"])')
)
$ModelPickerSuppressesNativeSlot = (
    $MaintainedModelPickerJsText.Contains("getVisibleNativeModelTriggers") -and
    $MaintainedModelPickerJsText.Contains("GPT_CODEX_CUSTOM_OPEN_MODEL_PICKER") -and
    $MaintainedModelPickerJsText.Contains('suppressNativeModelSlot(insertion.nativeSlot, { preserveLayout: bridge.kind === "native" })') -and
    $MaintainedModelPickerJsText.Contains('pickerHost.parentElement !== document.body') -and
    $MaintainedModelPickerJsText.Contains('element.setAttribute("inert", "")') -and
    $MaintainedModelPickerJsText.Contains("visibleNativeTriggerCount") -and
    $MaintainedModelPickerCssText.Contains('[data-gpt-codex-model-picker-suppression="fixed"]') -and
    $MaintainedModelPickerCssText.Contains('visibility: hidden !important') -and
    -not $MaintainedModelPickerJsText.Contains('element.hidden = true') -and
    -not $MaintainedModelPickerJsText.Contains('else restoreNativeModelSlot();')
)
$ModelPickerUltraParticlesContractPresent = (
    $MaintainedModelPickerJsText.Contains("ULTRA_PARTICLE_LAYOUT") -and
    $MaintainedModelPickerJsText.Contains("createUltraParticleField") -and
    $MaintainedModelPickerJsText.Contains("ultraParticleCount") -and
    $MaintainedModelPickerCssText.Contains("gpt-codex-model-picker-ultra-particle") -and
    $MaintainedModelPickerCssText.Contains('data-engaged="true"')
)
$ModelPickerFastModeContractPresent = (
    $MaintainedModelPickerJsText.Contains("requestFastMode") -and
    $MaintainedModelPickerJsText.Contains("observeFastBridgeSnapshot") -and
    $MaintainedModelPickerJsText.Contains("pendingFastRequest") -and
    $MaintainedModelPickerJsText.Contains("fastRequestSequence") -and
    $MaintainedModelPickerJsText.Contains("bridgeScopeKey") -and
    $MaintainedModelPickerJsText.Contains("5_500") -and
    $MaintainedModelPickerJsText.Contains('dataset.fastEffect = "striking"') -and
    $MaintainedModelPickerCssText.Contains("gpt-codex-model-picker-fast-icon-strike") -and
    $MaintainedModelPickerCssText.Contains("gpt-codex-model-picker-fast-spark")
)
$TokenHudRightDockContractPresent = (
    $MaintainedTokenHudJsText.Contains("findSafeRightDockPosition") -and
    $MaintainedTokenHudJsText.Contains('document.getElementById("gpt-codex-custom-model-picker")') -and
    $MaintainedTokenHudJsText.Contains('document.querySelectorAll(".composer-surface-chrome")') -and
    $MaintainedTokenHudJsText.Contains('scheduleFixedPosition({ settle: true })') -and
    $MaintainedTokenHudJsText.Contains('host.dataset.dock = "right"') -and
    $MaintainedTokenHudCssText.Contains("--gpt-codex-token-hud-fixed-right") -and
    -not $MaintainedTokenHudCssText.Contains("--gpt-codex-token-hud-fixed-left")
)

$installedPackages = @(Get-AppxPackage -Name ([string]$UpstreamManifest.packageName))
if ($installedPackages.Count -eq 0) {
    throw "The installed package named by upstream.json was not found: $($UpstreamManifest.packageName)"
}
$installed = @($installedPackages | Sort-Object Version -Descending)[0]
$ObservedPackage = [string]$installed.PackageFullName
$ObservedVersion = $installed.Version.ToString()
$InstalledAsar = Join-Path $installed.InstallLocation "app\resources\app.asar"
$InstalledExe = Join-Path $installed.InstallLocation "app\ChatGPT.exe"
$InstalledAsarHash = (Get-FileHash -LiteralPath $InstalledAsar -Algorithm SHA256).Hash
$InstalledExeHash = (Get-FileHash -LiteralPath $InstalledExe -Algorithm SHA256).Hash
$VendorAsarHash = (Get-FileHash -LiteralPath $VendorAsar -Algorithm SHA256).Hash
$VendorExeHash = (Get-FileHash -LiteralPath $VendorExe -Algorithm SHA256).Hash
$RuntimeExeHash = (Get-FileHash -LiteralPath $RuntimeExe -Algorithm SHA256).Hash
$archiveEntries = @(& node $AsarCli list $RuntimeAsar)
if ($LASTEXITCODE -ne 0) {
    throw "Could not list the custom runtime archive."
}

$results = [ordered]@{
    packageIdentity = (Test-UpstreamManifestValueMatch -Expected $ExpectedPackage -Observed $ObservedPackage)
    packageVersion = (Test-UpstreamManifestValueMatch -Expected $ExpectedVersion -Observed $ObservedVersion)
    installedAsarUntouched = (Test-UpstreamManifestValueMatch -Expected $ExpectedAsarHash -Observed $InstalledAsarHash)
    installedExeUntouched = (Test-UpstreamManifestValueMatch -Expected $ExpectedExeHash -Observed $InstalledExeHash)
    vendorAsarPristine = (Test-UpstreamManifestValueMatch -Expected $ExpectedAsarHash -Observed $VendorAsarHash)
    vendorExePristine = (Test-UpstreamManifestValueMatch -Expected $ExpectedExeHash -Observed $VendorExeHash)
    runtimeExePristine = (Test-UpstreamManifestValueMatch -Expected $ExpectedExeHash -Observed $RuntimeExeHash)
    runtimeAsarCustomized = ((Get-FileHash -LiteralPath $RuntimeAsar -Algorithm SHA256).Hash -ne $ExpectedAsarHash)
    rendererInjectionPresent = ((Get-Content -Raw -LiteralPath $PatchedIndex).Contains("GPT_CODEX_CUSTOM_INJECT"))
    customCssPresent = (Test-Path -LiteralPath $CustomCss)
    customJsPresent = (Test-Path -LiteralPath $CustomJs)
    tokenHudCssPresent = (Test-Path -LiteralPath $TokenHudCss)
    tokenHudJsPresent = (Test-Path -LiteralPath $TokenHudJs)
    pinboardCssPresent = (Test-Path -LiteralPath $PinboardCss)
    pinboardJsPresent = (Test-Path -LiteralPath $PinboardJs)
    modelPickerCssPresent = (Test-Path -LiteralPath $ModelPickerCss)
    modelPickerJsPresent = (Test-Path -LiteralPath $ModelPickerJs)
    runtimeArchiveHasCss = ($archiveEntries -contains "\webview\assets\gpt-codex-custom.css")
    runtimeArchiveHasJs = ($archiveEntries -contains "\webview\assets\gpt-codex-custom.js")
    runtimeArchiveHasTokenHud = (($archiveEntries -contains "\webview\assets\gpt-codex-token-hud.css") -and ($archiveEntries -contains "\webview\assets\gpt-codex-token-hud.js"))
    runtimeArchiveHasPinboard = (($archiveEntries -contains "\webview\assets\gpt-codex-pinboard.css") -and ($archiveEntries -contains "\webview\assets\gpt-codex-pinboard.js"))
    runtimeArchiveHasModelPicker = (($archiveEntries -contains "\webview\assets\gpt-codex-model-picker.css") -and ($archiveEntries -contains "\webview\assets\gpt-codex-model-picker.js"))
    rendererModelPickerInjectionPresent = ((Get-Content -Raw -LiteralPath $PatchedIndex).Contains("gpt-codex-model-picker-"))
    sideBySideBootstrap = ($PatchedBootstrap.Count -eq 1 -and (Get-Content -Raw -LiteralPath $PatchedBootstrap[0].FullName).Contains("GPT_CODEX_CUSTOM_BUILD"))
    firstClassChatProductMode = ($PatchedAppMain.Count -eq 1 -and (Get-Content -Raw -LiteralPath $PatchedAppMain[0].FullName).Contains("GPT_CODEX_CUSTOM_OPEN_CHAT"))
    firstRunProductModeContract = ($StartupModeContractEvaluation.Passed -eq $true)
    persistentProductSelectorBridge = ($PatchedAppMain.Count -eq 1 -and (Get-Content -Raw -LiteralPath $PatchedAppMain[0].FullName).Contains("GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES") -and (Get-Content -Raw -LiteralPath $CustomJs).Contains("gptCodexCustomProductSelector"))
    nativeChatSearchIntegrated = ($PatchedAppMain.Count -eq 1 -and (Get-Content -Raw -LiteralPath $PatchedAppMain[0].FullName).Contains("GPT_CODEX_CUSTOM_CHAT_SEARCH") -and (Get-Content -Raw -LiteralPath $CustomJs).Contains("GPT_CODEX_CUSTOM_SYNC_CHAT_SEARCH"))
    nativeChatDeletionIntegrated = ($PatchedAppMain.Count -eq 1 -and (Get-Content -Raw -LiteralPath $PatchedAppMain[0].FullName).Contains("GPT_CODEX_CUSTOM_CHAT_ACTIONS") -and (Get-Content -Raw -LiteralPath $PatchedAppMain[0].FullName).Contains("deleteConversation") -and (Get-Content -Raw -LiteralPath $CustomJs).Contains("openChatDeleteDialog"))
    nativeChatManagementIntegrated = $NativeChatManagementBridgeContractPresent
    sentMessageEditingIntegrated = ($PatchedChatGptThread.Count -eq 1 -and (Get-Content -Raw -LiteralPath $PatchedChatGptThread[0].FullName).Contains("onEditMessage") -and (Get-Content -Raw -LiteralPath $PatchedChatGptThread[0].FullName).Contains("GPT_CODEX_CUSTOM_EDIT_DRY_RUN"))
    messageEditCancelGuardIntegrated = ($PatchedGeneratedImagePreview.Count -eq 1 -and (Get-Content -Raw -LiteralPath $PatchedGeneratedImagePreview[0].FullName).Contains("GPTCodexCancelGuard.current"))
    generatedImageEditingIntegrated = ($PatchedQuickChat.Count -eq 1 -and (Get-Content -Raw -LiteralPath $CustomJs).Contains("stageGeneratedImageForEditing"))
    generatedImageFullViewIntegrated = ($MaintainedCustomJsText.Contains("openGeneratedImageViewer") -and $MaintainedCustomJsText.Contains("handleGeneratedImagePreviewClick") -and $MaintainedCustomCssText.Contains(".gpt-codex-custom-image-viewer"))
    nativeChatModelPickerBridgeIntegrated = ($PatchedQuickChat.Count -eq 1 -and $PatchedQuickChatText.Contains("GPTCodexModelQuery=s(GPTCodexChatModelsQuery)") -and $PatchedQuickChatText.Contains("GPTCodexSelectedModel=u(GPTCodexSelectedChatModel,T)") -and $PatchedQuickChatText.Contains("GPTCodexSelectChatModel") -and $PatchedQuickChatText.Contains("GPT_CODEX_CUSTOM_CHAT_MODEL_PICKER") -and $PatchedQuickChatText.Contains("GPT_CODEX_CUSTOM_SYNC_CHAT_MODEL_PICKER"))
    nativeWorkCodexModelPickerBridgeIntegrated = ($PatchedComposerToken.Count -eq 1 -and (Get-Content -Raw -LiteralPath $PatchedComposerToken[0].FullName).Contains("GPT_CODEX_CUSTOM_NATIVE_MODEL_PICKER") -and (Get-Content -Raw -LiteralPath $PatchedComposerToken[0].FullName).Contains("GPT_CODEX_CUSTOM_SYNC_NATIVE_MODEL_PICKER") -and (Get-Content -Raw -LiteralPath $PatchedComposerToken[0].FullName).Contains("GPT_CODEX_CUSTOM_OPEN_MODEL_PICKER") -and (Get-Content -Raw -LiteralPath $PatchedComposerToken[0].FullName).Contains("The selected model and effort are not available in the active native model snapshot") -and (Get-Content -Raw -LiteralPath $PatchedComposerToken[0].FullName).Contains("GPTCodexSetFastEnabled") -and (Get-Content -Raw -LiteralPath $PatchedComposerToken[0].FullName).Contains('setFastEnabled:GPTCodexSetFastEnabled'))
    chatSessionInitialScrollModeForwarded = ($PatchedQuickChat.Count -eq 1 -and $PatchedQuickChatText.Contains('GPT_CODEX_CUSTOM_SYNC_SESSION?.({conversationId:T,initialScrollMode:D,title:O})'))
    crossModeMessageBridgeIntegrated = ($PatchedChatGptThread.Count -eq 1 -and $PatchedLocalTurn.Count -eq 1 -and (Get-Content -Raw -LiteralPath $PatchedChatGptThread[0].FullName).Contains("GPT_CODEX_CUSTOM_REGISTER_PINNABLE_MESSAGE") -and (Get-Content -Raw -LiteralPath $PatchedLocalTurn[0].FullName).Contains("GPT_CODEX_CUSTOM_REGISTER_PINNABLE_MESSAGE"))
    serverTokenUsageBridgeIntegrated = ($PatchedTokenUsage.Count -eq 1 -and (Get-Content -Raw -LiteralPath $PatchedTokenUsage[0].FullName).Contains("GPT_CODEX_CUSTOM_SYNC_TOKEN_USAGE") -and (Get-Content -Raw -LiteralPath $PatchedTokenUsage[0].FullName).Contains("GPT_CODEX_CUSTOM_RESOLVE_TOKEN_MODE"))
    activeTokenContextBridgeIntegrated = ($PatchedComposerToken.Count -eq 1)
    tokenHudContractPresent = ((Get-Content -Raw -LiteralPath $TokenHudJs).Contains("GPT_CODEX_CUSTOM_SYNC_TOKEN_USAGE") -and (Get-Content -Raw -LiteralPath $TokenHudJs).Contains("GPT_CODEX_CUSTOM_TOKEN_PROBE") -and (Get-Content -Raw -LiteralPath $TokenHudJs).Contains("GPT_CODEX_CUSTOM_TOKEN_SELF_TEST") -and (Get-Content -Raw -LiteralPath $TokenHudJs).Contains("total_token_usage") -and (Get-Content -Raw -LiteralPath $TokenHudJs).Contains("last_token_usage") -and (Get-Content -Raw -LiteralPath $TokenHudJs).Contains("reasoning_output_tokens") -and (Get-Content -Raw -LiteralPath $TokenHudJs).Contains("Thinking is included in Out and Total") -and (Get-Content -Raw -LiteralPath $TokenHudJs).Contains("gpt-codex-custom:token-usage:v1"))
    tokenHudRightDockContractPresent = $TokenHudRightDockContractPresent
    localPinboardContractPresent = ((Get-Content -Raw -LiteralPath $PinboardJs).Contains("GPT_CODEX_CUSTOM_REGISTER_PINNABLE_MESSAGE") -and (Get-Content -Raw -LiteralPath $PinboardJs).Contains("GPT_CODEX_CUSTOM_PINBOARD_PROBE") -and (Get-Content -Raw -LiteralPath $PinboardJs).Contains("GPT_CODEX_CUSTOM_PINBOARD_SELF_TEST"))
    chatModelPickerMatrixContractPresent = $ModelPickerMatrixContractPresent
    chatModelPickerUltraContractPresent = $ModelPickerUltraContractPresent
    chatModelPickerPointerContractPresent = $ModelPickerPointerContractPresent
    chatModelPickerUltraShakeContractPresent = $ModelPickerUltraShakeContractPresent
    modelPickerFluidMotionContractPresent = $ModelPickerFluidMotionContractPresent
    chatModelPickerSelfTestContractPresent = $ModelPickerSelfTestContractPresent
    chatModelPickerUsesNativeSelectionOnly = $ModelPickerUsesNativeSelectionOnly
    modelPickerSupportsChatWorkAndCodex = $ModelPickerSupportsAllModes
    modelPickerSuppressesNativeSlotInAllModes = $ModelPickerSuppressesNativeSlot
    modelPickerUltraParticlesContractPresent = $ModelPickerUltraParticlesContractPresent
    modelPickerFastModeContractPresent = $ModelPickerFastModeContractPresent
    chatScrollProbeContractPresent = $ChatScrollProbeContractPresent
    generatedImageDialogPositioningSafe = $GeneratedImageDialogPositioningSafe
    accountBackedChatPromotion = ((Get-Content -Raw -LiteralPath $CustomJs).Contains("data-pip-obstacle") -and (Get-Content -Raw -LiteralPath $CustomCss).Contains('data-gpt-codex-custom-mode="chat"'))
    runtimeDiagnosticsChannel = ($PatchedMain.Count -eq 1 -and (Get-Content -Raw -LiteralPath $PatchedMain[0].FullName).Contains("gpt-codex-custom-diagnostics.json"))
    isolatedOwlProfile = ((Get-Content -Raw -LiteralPath $OwlIni).Contains("UserDataDirectoryName=GPTCodexCustom"))
}
$packageDriftComparisons = @(
    [PSCustomObject]@{ Name = "packageIdentity"; Subject = "Installed package full name"; Expected = $ExpectedPackage; Observed = $ObservedPackage },
    [PSCustomObject]@{ Name = "packageVersion"; Subject = "Installed package version"; Expected = $ExpectedVersion; Observed = $ObservedVersion },
    [PSCustomObject]@{ Name = "installedAsarUntouched"; Subject = "Installed app.asar SHA-256"; Expected = $ExpectedAsarHash; Observed = $InstalledAsarHash },
    [PSCustomObject]@{ Name = "installedExeUntouched"; Subject = "Installed ChatGPT.exe SHA-256"; Expected = $ExpectedExeHash; Observed = $InstalledExeHash },
    [PSCustomObject]@{ Name = "vendorAsarPristine"; Subject = "Vendor app.asar SHA-256"; Expected = $ExpectedAsarHash; Observed = $VendorAsarHash },
    [PSCustomObject]@{ Name = "vendorExePristine"; Subject = "Vendor ChatGPT.exe SHA-256"; Expected = $ExpectedExeHash; Observed = $VendorExeHash }
)
foreach ($comparison in $packageDriftComparisons) {
    if (-not [bool]$results[$comparison.Name]) {
        $verificationStatusOverrides[$comparison.Name] = Get-UpstreamDriftStatusOverride `
            -Subject $comparison.Subject `
            -Expected $comparison.Expected `
            -Observed $comparison.Observed
    }
}
$verificationResults = $results

$runtimePath = [System.IO.Path]::GetFullPath($RuntimeExe)
$running = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
    Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -eq $runtimePath) }
$results.customRuntimeRunning = ($null -ne $running)

if ($RequireChatReady) {
    if (-not (Test-Path -LiteralPath $DiagnosticsFile)) {
        throw "Chat runtime diagnostics are missing: $DiagnosticsFile"
    }
    $diagnostics = Get-Content -Raw -LiteralPath $DiagnosticsFile | ConvertFrom-Json
    $results.chatSelectorVisiblyChatOnly = ($diagnostics.customProductSelectorVisible -eq $true)
    $results.nativeProductModeSwitchingReady = ($diagnostics.nativeProductModeBridgeReady -eq $true)
    $results.nativeImageEditingBridgeReady = ($diagnostics.generatedImageEditBridgeReady -eq $true)
    $results.nativeChatSurfaceOpen = ($diagnostics.chatMode -eq $true -and $diagnostics.chatSurfaceOpen -eq $true -and $diagnostics.chatControlPressed -eq "true")
    $results.accountHistoryAvailable = ([int]$diagnostics.conversationCandidateCount -gt 0 -and [int]$diagnostics.historyListItemCount -gt 0)
    $results.modeSpecificChatSidebar = ($diagnostics.customSidebarVisible -eq $true -and [int]$diagnostics.customSidebarHistoryCount -gt 0)
    $results.chatSidebarActionsReady = ($diagnostics.nativeConversationSelectReady -eq $true -and $diagnostics.nativeNewChatReady -eq $true)
    $results.chatHeaderIsModeSpecific = ($diagnostics.modeSpecificHeaderControlsHidden -eq $true)
    $results.chatWebsiteSidebarReady = ($diagnostics.customSidebarSiteNavigationReady -eq $true -and [int]$diagnostics.customSidebarNativeDestinationCount -ge 3)
    $results.chatAccountControlReady = ($diagnostics.customSidebarAccountReady -eq $true)
    $results.nativeChatSearchReady = ($diagnostics.customSidebarNativeSearchReady -eq $true)
    $results.nativeChatDeleteReady = ($diagnostics.customSidebarNativeDeleteReady -eq $true)
    $results.nativeChatManagementReady = ($diagnostics.customSidebarNativeManagementReady -eq $true -and [int]$diagnostics.customSidebarNativeActionCount -eq 5)
}

if ($RequireChatActions) {
    if (-not (Test-Path -LiteralPath $SelfTestFile)) {
        throw "Chat action self-test result is missing: $SelfTestFile"
    }
    $selfTest = Get-Content -Raw -LiteralPath $SelfTestFile | ConvertFrom-Json
    $results.firstConversationActionWorks = ($selfTest.ready -eq $true -and $selfTest.firstConversationOpened -eq $true)
    $results.freshModeDecisionHelperWorks = ($selfTest.freshModeDecisionHelperWorks -eq $true)
    $results.productMenuKeyboardContractWorks = ($selfTest.productMenuKeyboardContractWorks -eq $true)
    $results.messageEditControlWorks = ($selfTest.messageEditControlVisible -eq $true)
    $results.messageEditModeWorks = ($selfTest.messageEditModeOpens -eq $true -and $selfTest.messageEditCancelRestoresBubble -eq $true)
    $results.messageEditSubmitDryRunWorks = ($selfTest.messageEditDryRunWorks -eq $true -and $selfTest.messageEditSubmitClosesEditor -eq $true)
    $results.generatedImageEditControlWorks = ($selfTest.generatedImageEditControlVisible -eq $true)
    $results.generatedImageEditBridgeWorks = ($selfTest.generatedImageEditBridgeReady -eq $true)
    $results.generatedImageFullViewWorks = ($selfTest.generatedImageFullViewOpens -eq $true -and $selfTest.generatedImageFullViewCloses -eq $true -and $selfTest.generatedImageFullViewRestoresInteraction -eq $true)
    $results.generatedImageNativeStageWorks = ($selfTest.generatedImageNativeStageWorks -eq $true)
    $results.generatedImageEditPipelineWorks = ($selfTest.generatedImageEditPipelineWorks -eq $true)
    $results.tokenHudContractWorks = ($selfTest.tokenHudContractWorks -eq $true)
    $results.pinboardStorageWorks = ($selfTest.pinboardStorageReady -eq $true)
    $results.pinboardMessageAssociationWorks = ($selfTest.pinboardMessageAssociationWorks -eq $true)
    $results.pinboardBookmarkRoundTripWorks = ($selfTest.pinboardBookmarkRoundTripWorks -eq $true)
    $results.productModeSelectorPersists = ($selfTest.productModeSelectorPersists -eq $true -and $selfTest.productModeOptionsVisible -eq $true)
    $results.productModeCallbacksWork = ($selfTest.nativeProductModeBridgeReady -eq $true)
    $results.productOptionsRespectBridgeReadiness = ($selfTest.productOptionsRespectBridgeReadiness -eq $true)
    $results.nativeChatSearchContractWorks = ($selfTest.nativeChatSearchFakeBridgeWorks -eq $true -and $selfTest.nativeChatSearchBridgeReady -eq $true -and $selfTest.nativeChatSearchQueryWorks -eq $true)
    $results.nativeChatManagementBridgeWorks = ($selfTest.nativeChatManagementBridgeReady -eq $true)
    $results.nativeChatDeleteBridgeWorks = ($selfTest.nativeChatDeleteBridgeReady -eq $true)
    $results.conversationMenuControlWorks = ($selfTest.conversationMenuControlVisible -eq $true)
    $results.conversationMenuWorks = ($selfTest.conversationMenuOpens -eq $true -and $selfTest.conversationMenuFullActionSetVisible -eq $true)
    $results.chatRenameDryRunWorks = ($selfTest.chatRenameDryRunWorks -eq $true)
    $results.chatPinDryRunWorks = ($selfTest.chatPinDryRunWorks -eq $true)
    $results.chatArchiveDryRunWorks = ($selfTest.chatArchiveDryRunWorks -eq $true)
    $results.chatShareDryRunWorks = ($selfTest.chatShareDryRunWorks -eq $true)
    $results.deleteConfirmationWorks = ($selfTest.deleteConfirmationOpens -eq $true)
    $results.deleteCancelWorks = ($selfTest.deleteCancelPreservesChat -eq $true)
    $results.deleteDryRunWorks = ($selfTest.deleteDryRunWorks -eq $true -and $selfTest.deleteDryRunPreservesChat -eq $true)
    $results.historyFullListReconciliationWorks = ($selfTest.historyFullListReconciliationWorks -eq $true)
    $results.sessionSelectionIsAuthoritative = ($selfTest.sessionSelectionAuthoritative -eq $true)
    $results.sidebarActionsRespectBridgeReadiness = ($selfTest.sidebarActionsRespectBridgeReadiness -eq $true)
    $results.profileReadinessIsConsistent = ($selfTest.profileReadinessConsistent -eq $true)
    $results.loadMoreControlIsSafe = ($selfTest.loadMoreControlSafe -eq $true)
    $results.repeatedConversationActionWorks = ($selfTest.secondConversationOpened -eq $true)
    $results.newChatActionWorks = ($selfTest.newChatOpened -eq $true)
    $results.siteNavigationStructureWorks = ($selfTest.siteNavigationReady -eq $true)
    $results.nativeDestinationDispatchWorks = ($selfTest.libraryNavigationDispatched -eq $true)
    $results.chatLibraryRouteWorks = ($selfTest.libraryRouteStayedOpen -eq $true)
    $results.destinationPagesVisibleAndInteractive = ($selfTest.auxiliaryDestinationsVisible -eq $true)
    $results.auxiliaryStateClearsOnChatReturn = ($selfTest.auxiliaryStateClearsOnChatReturn -eq $true)
    $results.searchControlWorks = ($selfTest.searchControlWorks -eq $true)
    $results.historyPaginationBridgeWorks = ($selfTest.historyPaginationBridgeReady -eq $true)
    $results.moreMenuWorks = ($selfTest.moreMenuOpens -eq $true)
    $results.accountFooterWorks = ($selfTest.accountControlReady -eq $true)
    $results.accountMenuWorks = ($selfTest.accountMenuOpens -eq $true)
    $results.modeExitHidesChatUi = ($selfTest.modeExitHidesChat -eq $true)
    $results.modeReentryRestoresChatUi = ($selfTest.modeReentryRestoresChat -eq $true)
    $results.workModeSelectionWorks = ($selfTest.workModeSelectionWorks -eq $true)
    $results.codexModeSelectionWorks = ($selfTest.codexModeSelectionWorks -eq $true)
    $results.modelPickerWorkModeWorks = ($selfTest.modelPickerWorkModeWorks -eq $true)
    $results.modelPickerCodexModeWorks = ($selfTest.modelPickerCodexModeWorks -eq $true)
    $results.modelPickerChatReturnWorks = ($selfTest.modelPickerChatReturnWorks -eq $true)
    $workPickerEvidence = $selfTest.modelPickerModeEvidence.work
    $codexPickerEvidence = $selfTest.modelPickerModeEvidence.codex
    $results.modelPickerWorkHasNoNativeDuplicate = Test-ModelPickerModeHandoffEvidence `
        -Evidence $workPickerEvidence `
        -ExpectedMode "work"
    $results.modelPickerCodexHasNoNativeDuplicate = Test-ModelPickerModeHandoffEvidence `
        -Evidence $codexPickerEvidence `
        -ExpectedMode "codex"
    $results.tokenHudWorkModeWorks = ($selfTest.tokenHudWorkModeWorks -eq $true)
    $results.tokenHudCodexModeWorks = ($selfTest.tokenHudCodexModeWorks -eq $true)
    $results.tokenHudChatReturnWorks = ($selfTest.tokenHudChatReturnWorks -eq $true)
}

if ($RequireRunning -and -not $results.customRuntimeRunning) {
    throw "The custom runtime is not running from $RuntimeExe"
}

$failed = @(
    Get-RequiredVerificationFailures `
        -Results $results `
        -RequireRuntime ([bool]$RequireRunning) `
        -RequireStartupContract $RequireStartupContract
)
if ($StartupModeContractEvaluation.Status -ne "Passed") {
    if ($RequireStartupContract) {
        Write-Warning "First-run product-mode contract $($StartupModeContractEvaluation.Status.ToLowerInvariant()): $($StartupModeContractEvaluation.Rationale) This live verification gate is required and non-passing."
    } else {
        Write-Warning "First-run product-mode contract unavailable for plain static verification: $($StartupModeContractEvaluation.Rationale) The runtime-only gate is skipped."
    }
}
$results.GetEnumerator() | ForEach-Object {
    $statusOverride = if ($verificationStatusOverrides.Contains($_.Key)) {
        $verificationStatusOverrides[$_.Key]
    } else {
        $null
    }
    $required = Test-VerificationCheckRequired `
        -Name ([string]$_.Key) `
        -RequireRuntime ([bool]$RequireRunning) `
        -RequireStartupContract $RequireStartupContract
    [PSCustomObject]@{
        Check = $_.Key
        Required = $required
        Passed = $_.Value
        Status = if ($null -ne $statusOverride) {
            $statusOverride.Status
        } elseif ($_.Key -eq "customRuntimeRunning" -and -not $RequireRunning) {
            if ($_.Value) { "Observed" } else { "Unavailable" }
        } elseif ($_.Value) {
            "Passed"
        } else {
            "Failed"
        }
        Detail = if ($null -ne $statusOverride) { $statusOverride.Rationale } else { $null }
    }
} | Format-Table -AutoSize -Wrap

$verificationCompleted = $true
if ($failed.Count -gt 0) {
    throw "Custom build verification failed: $($failed.Key -join ', ')"
}

Write-Host "Custom build verification passed." -ForegroundColor Green
} catch {
    $verificationError = $_
}

try {
    Write-ReleaseVerificationReport `
        -ReportPath $ReleaseVerificationPath `
        -RuntimeAsarPath $RuntimeAsarForReport `
        -Results $verificationResults `
        -StatusOverrides $verificationStatusOverrides `
        -Completed $verificationCompleted `
        -RequireRuntime ([bool]$RequireRunning) `
        -RequireStartupContract $RequireStartupContract
    Write-Host "Release verification report: work\verification\release-verification.json"
} catch {
    if ($null -eq $verificationError) {
        $verificationError = $_
    } else {
        Write-Warning "The sanitized release-verification report could not be written."
    }
}

if ($null -ne $verificationError) {
    throw $verificationError
}
