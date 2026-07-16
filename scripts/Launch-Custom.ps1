[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$Diagnostics,
    [switch]$ReplaceExisting,
    [switch]$SkipUpdateCheck
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$RuntimeRoot = Join-Path $ProjectRoot "work\runtime"
$Executable = Join-Path $RuntimeRoot "ChatGPT.exe"
$ProfileRoot = Join-Path $ProjectRoot "profile"
$ChromiumProfile = Join-Path $ProfileRoot "chromium"
$CodexHome = Join-Path $ProfileRoot "codex-home"
$LogRoot = Join-Path $ProjectRoot "logs"
$ChromiumLog = Join-Path $LogRoot "chromium.log"
$SelfTestFile = Join-Path $ChromiumProfile "gpt-codex-custom-self-test-result.json"
$DevToolsPortFile = Join-Path $ChromiumProfile "DevToolsActivePort"
$RequiredSelfTestOutcomes = @(
    "ready",
    "freshModeDecisionHelperWorks",
    "productMenuKeyboardContractWorks",
    "firstConversationOpened",
    "messageEditControlVisible",
    "messageEditModeOpens",
    "messageEditCancelRestoresBubble",
    "messageEditDryRunWorks",
    "messageEditSubmitClosesEditor",
    "generatedImageEditControlVisible",
    "generatedImageEditBridgeReady",
    "generatedImagePreviewLayoutPreserved",
    "generatedImageFullViewOpens",
    "generatedImageFullViewCloses",
    "generatedImageFullViewRestoresInteraction",
    "generatedImageNativeStageWorks",
    "generatedImageEditPipelineWorks",
    "tokenHudContractWorks",
    "pinboardStorageReady",
    "pinboardMessageAssociationWorks",
    "pinboardBookmarkRoundTripWorks",
    "productModeSelectorPersists",
    "productModeOptionsVisible",
    "nativeProductModeBridgeReady",
    "productOptionsRespectBridgeReadiness",
    "nativeChatSearchBridgeReady",
    "nativeChatSearchQueryWorks",
    "nativeChatSearchFakeBridgeWorks",
    "nativeChatManagementBridgeReady",
    "nativeChatDeleteBridgeReady",
    "conversationMenuControlVisible",
    "conversationMenuOpens",
    "conversationMenuFullActionSetVisible",
    "chatRenameDryRunWorks",
    "chatPinDryRunWorks",
    "chatArchiveDryRunWorks",
    "chatShareDryRunWorks",
    "deleteConfirmationOpens",
    "deleteCancelPreservesChat",
    "deleteDryRunWorks",
    "deleteDryRunPreservesChat",
    "historyFullListReconciliationWorks",
    "sessionSelectionAuthoritative",
    "chatScrollSettlesToBottom",
    "sidebarActionsRespectBridgeReadiness",
    "profileReadinessConsistent",
    "loadMoreControlSafe",
    "secondConversationOpened",
    "newChatOpened",
    "siteNavigationReady",
    "accountControlReady",
    "historyPaginationBridgeReady",
    "accountMenuOpens",
    "searchControlWorks",
    "moreMenuOpens",
    "auxiliaryDestinationsVisible",
    "auxiliaryStateClearsOnChatReturn",
    "libraryNavigationDispatched",
    "libraryRouteStayedOpen",
    "modeExitHidesChat",
    "modeReentryRestoresChat",
    "workModeSelectionWorks",
    "codexModeSelectionWorks",
    "modelPickerWorkModeWorks",
    "modelPickerCodexModeWorks",
    "modelPickerChatReturnWorks",
    "tokenHudWorkModeWorks",
    "tokenHudCodexModeWorks",
    "tokenHudChatReturnWorks"
)

function Get-CustomRuntimeProcesses {
    param(
        [Parameter(Mandatory)]
        [string]$ExecutablePath
    )

    $runtimePath = [System.IO.Path]::GetFullPath($ExecutablePath)
    return @(
        Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
            Where-Object {
                $_.ExecutablePath -and
                [System.IO.Path]::GetFullPath($_.ExecutablePath) -eq $runtimePath
            }
    )
}

function Stop-CustomRuntimeProcesses {
    param(
        [Parameter(Mandatory)]
        [string]$ExecutablePath,
        [int]$TimeoutMilliseconds = 10000
    )

    $matchingProcesses = @(Get-CustomRuntimeProcesses -ExecutablePath $ExecutablePath)
    foreach ($matchingProcess in ($matchingProcesses | Sort-Object ProcessId -Descending)) {
        Stop-Process -Id $matchingProcess.ProcessId -Force -ErrorAction SilentlyContinue
    }

    $deadline = (Get-Date).AddMilliseconds($TimeoutMilliseconds)
    do {
        $remainingProcesses = @(Get-CustomRuntimeProcesses -ExecutablePath $ExecutablePath)
        if ($remainingProcesses.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)

    $remainingIds = ($remainingProcesses.ProcessId | Sort-Object) -join ", "
    throw "The existing custom runtime did not exit before relaunch. Remaining PIDs: $remainingIds"
}

function Get-RequiredBooleanOutcomeFailures {
    param(
        [Parameter(Mandatory)]
        [object]$Result,

        [Parameter(Mandatory)]
        [string[]]$RequiredOutcomes
    )

    $missing = [System.Collections.Generic.List[string]]::new()
    $falseOrInvalid = [System.Collections.Generic.List[string]]::new()
    foreach ($outcome in $RequiredOutcomes) {
        $property = $Result.PSObject.Properties[$outcome]
        if ($null -eq $property) {
            $missing.Add($outcome)
            continue
        }
        if ($property.Value -isnot [bool] -or $property.Value -ne $true) {
            $falseOrInvalid.Add($outcome)
        }
    }

    return [PSCustomObject][ordered]@{
        Missing = @($missing)
        FalseOrInvalid = @($falseOrInvalid)
    }
}

if ($SelfTest -and $Diagnostics) {
    throw "Choose either -SelfTest or -Diagnostics, not both."
}

if (-not $SelfTest -and -not $Diagnostics -and -not $SkipUpdateCheck) {
    $updateScript = Join-Path $PSScriptRoot "Update-Custom.ps1"
    if (Test-Path -LiteralPath $updateScript -PathType Leaf) {
        try {
            & $updateScript -Mode Auto
        } catch {
            # A network or release problem must never make the last verified
            # local build unlaunchable. Manual `npm run update:apply` keeps the
            # strict, terminating behavior for explicit maintenance.
            Write-Warning "Automatic custom update was skipped: $_"
        }
    }
}

foreach ($requiredPath in @(
    $Executable,
    (Join-Path $RuntimeRoot "CUSTOM_BUILD.json")
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Custom runtime is not built. Missing: $requiredPath`nRun npm run build first."
    }
}

New-Item -ItemType Directory -Force -Path $ChromiumProfile, $CodexHome, $LogRoot | Out-Null

$env:CODEX_HOME = $CodexHome
$env:CODEX_ELECTRON_USER_DATA_PATH = $ChromiumProfile
$env:GPT_CODEX_CUSTOM_BUILD = "1"
Remove-Item Env:GPT_CODEX_CUSTOM_SELF_TEST -ErrorAction SilentlyContinue

$baseArguments = @(
    "--user-data-dir=`"$ChromiumProfile`"",
    "--enable-logging",
    "--log-file=`"$ChromiumLog`""
)
$arguments = @($baseArguments)
$existingCustomProcesses = @(Get-CustomRuntimeProcesses -ExecutablePath $Executable)
if ($SelfTest -or $Diagnostics) {
    # Electron otherwise forwards this launch to the already-running custom
    # instance, which means the temporary remote-debugging flags never apply.
    # Never replace an unrelated normal custom session without explicit consent.
    if ($existingCustomProcesses.Count -gt 0 -and -not $ReplaceExisting) {
        $requestedMode = if ($SelfTest) { "self-test diagnostics" } else { "renderer diagnostics" }
        $existingIds = ($existingCustomProcesses.ProcessId | Sort-Object -Unique) -join ", "
        throw "A GPT + Codex Custom session is already running (PIDs: $existingIds). Refusing to replace it for $requestedMode. Close it first or rerun with -ReplaceExisting."
    }
    if ($existingCustomProcesses.Count -gt 0) {
        Write-Warning "Replacing the existing GPT + Codex Custom session because -ReplaceExisting was supplied."
        # Match the copied executable path exactly so the Store build is untouched.
        Stop-CustomRuntimeProcesses -ExecutablePath $Executable
    }
    if ($SelfTest) {
        Remove-Item -LiteralPath $SelfTestFile -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $DevToolsPortFile -Force -ErrorAction SilentlyContinue
    $arguments += "--remote-debugging-address=127.0.0.1"
    $arguments += "--remote-debugging-port=0"
    $arguments += "--remote-allow-origins=*"
} else {
    $diagnosticRuntimeProcesses = @(
        $existingCustomProcesses | Where-Object {
            $_.CommandLine -match "--remote-debugging-port(?:=|\s)"
        }
    )
    if ($diagnosticRuntimeProcesses.Count -gt 0 -and -not $ReplaceExisting) {
        $existingIds = ($diagnosticRuntimeProcesses.ProcessId | Sort-Object -Unique) -join ", "
        throw "A diagnostic GPT + Codex Custom session is already running (PIDs: $existingIds). Refusing to replace it with a normal session. Rerun with -ReplaceExisting for that deliberate restart."
    }
    if ($ReplaceExisting -and $existingCustomProcesses.Count -gt 0) {
        Stop-CustomRuntimeProcesses -ExecutablePath $Executable
    }
    # A diagnostic run can be force-stopped before Chromium removes this file.
    # Never leave a normal launch advertising a stale, inactive debug endpoint.
    Remove-Item -LiteralPath $DevToolsPortFile -Force -ErrorAction SilentlyContinue
}

$process = Start-Process -FilePath $Executable -ArgumentList $arguments -WorkingDirectory $RuntimeRoot -PassThru

Write-Host "Launched GPT + Codex Custom." -ForegroundColor Green
Write-Host "PID: $($process.Id)"
Write-Host "Executable: $Executable"
Write-Host "Profile: $ProfileRoot"

if ($Diagnostics) {
    $portDeadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $portDeadline -and -not (Test-Path -LiteralPath $DevToolsPortFile)) {
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path -LiteralPath $DevToolsPortFile)) {
        throw "The isolated renderer diagnostics endpoint did not start."
    }
    $debugPort = [int](Get-Content -LiteralPath $DevToolsPortFile -TotalCount 1)
    Write-Host "Diagnostics: http://127.0.0.1:$debugPort" -ForegroundColor Cyan
}

if ($SelfTest) {
    $selfTestFailure = $null
    try {
        $portDeadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $portDeadline -and -not (Test-Path -LiteralPath $DevToolsPortFile)) {
            Start-Sleep -Milliseconds 250
        }
        if (-not (Test-Path -LiteralPath $DevToolsPortFile)) {
            throw "The temporary renderer diagnostics endpoint did not start."
        }

        $debugPort = [int](Get-Content -LiteralPath $DevToolsPortFile -TotalCount 1)
        $targetsEndpoint = "http://127.0.0.1:$debugPort/json"
        $targetDeadline = (Get-Date).AddSeconds(30)
        $mainTarget = $null
        while ((Get-Date) -lt $targetDeadline -and $null -eq $mainTarget) {
            try {
                $mainTarget = @(Invoke-RestMethod -Uri $targetsEndpoint -TimeoutSec 2) |
                    Where-Object { $_.type -eq "page" -and $_.url -eq "app://-/index.html" } |
                    Select-Object -First 1
            } catch {
                $mainTarget = $null
            }
            if ($null -eq $mainTarget) {
                Start-Sleep -Milliseconds 250
            }
        }
        if ($null -eq $mainTarget) {
            throw "The main custom renderer did not become available for its self-test."
        }

        Start-Sleep -Seconds 3
        $socket = [System.Net.WebSockets.ClientWebSocket]::new()
        $socketTimeout = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(15))
        try {
            $socket.ConnectAsync([Uri]$mainTarget.webSocketDebuggerUrl, $socketTimeout.Token).GetAwaiter().GetResult() | Out-Null
            $expression = 'sessionStorage.removeItem("gpt-codex-custom.self-test-attempt");setTimeout(()=>{void globalThis.GPT_CODEX_CUSTOM_RUN_SELF_TEST()},250);"scheduled"'
            $request = @{
                id = 1
                method = "Runtime.evaluate"
                params = @{
                    expression = $expression
                    returnByValue = $true
                }
            } | ConvertTo-Json -Compress -Depth 6
            $requestBytes = [System.Text.Encoding]::UTF8.GetBytes($request)
            $socket.SendAsync(
                [ArraySegment[byte]]::new($requestBytes),
                [System.Net.WebSockets.WebSocketMessageType]::Text,
                $true,
                $socketTimeout.Token
            ).GetAwaiter().GetResult() | Out-Null
            $responseBytes = New-Object byte[] 65536
            $response = $socket.ReceiveAsync(
                [ArraySegment[byte]]::new($responseBytes),
                $socketTimeout.Token
            ).GetAwaiter().GetResult()
            $responseJson = [System.Text.Encoding]::UTF8.GetString($responseBytes, 0, $response.Count) | ConvertFrom-Json
            $hasProtocolError = $responseJson.PSObject.Properties.Name -contains "error"
            if ($responseJson.id -ne 1 -or $hasProtocolError) {
                throw "The renderer rejected the self-test request."
            }
        } finally {
            $socket.Dispose()
            $socketTimeout.Dispose()
        }

        $resultDeadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $resultDeadline -and -not (Test-Path -LiteralPath $SelfTestFile)) {
            Start-Sleep -Milliseconds 500
        }
        if (-not (Test-Path -LiteralPath $SelfTestFile)) {
            throw "The custom Chat UI self-test did not finish within 90 seconds."
        }
        $selfTestResult = Get-Content -Raw -LiteralPath $SelfTestFile | ConvertFrom-Json
        $outcomeFailures = Get-RequiredBooleanOutcomeFailures `
            -Result $selfTestResult `
            -RequiredOutcomes $RequiredSelfTestOutcomes
        if ($outcomeFailures.Missing.Count -gt 0 -or $outcomeFailures.FalseOrInvalid.Count -gt 0) {
            $failureDetails = [System.Collections.Generic.List[string]]::new()
            if ($outcomeFailures.Missing.Count -gt 0) {
                $failureDetails.Add("Missing required outcomes: $($outcomeFailures.Missing -join ', ').")
            }
            if ($outcomeFailures.FalseOrInvalid.Count -gt 0) {
                $failureDetails.Add("False or invalid required outcomes: $($outcomeFailures.FalseOrInvalid -join ', ').")
            }
            $rendererError = $selfTestResult.PSObject.Properties["selfTestError"]
            if ($null -ne $rendererError -and -not [string]::IsNullOrWhiteSpace([string]$rendererError.Value)) {
                $failureDetails.Add("Renderer self-test error: $([string]$rendererError.Value)")
            }
            throw "The custom Chat UI self-test failed its strict required-outcome contract. $($failureDetails -join ' ')"
        }
        Write-Host "Custom Chat UI self-test completed: $($RequiredSelfTestOutcomes.Count)/$($RequiredSelfTestOutcomes.Count) required outcomes passed." -ForegroundColor Green
    } catch {
        $selfTestFailure = $_
    } finally {
        Stop-CustomRuntimeProcesses -ExecutablePath $Executable
        Remove-Item -LiteralPath $DevToolsPortFile -Force -ErrorAction SilentlyContinue
        $normalProcess = Start-Process -FilePath $Executable -ArgumentList $baseArguments -WorkingDirectory $RuntimeRoot -PassThru
        Write-Host "Relaunched without the temporary diagnostics endpoint."
        Write-Host "PID: $($normalProcess.Id)"
    }

    if ($null -ne $selfTestFailure) {
        throw $selfTestFailure
    }
}
