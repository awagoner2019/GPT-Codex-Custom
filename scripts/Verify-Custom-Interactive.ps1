<#
.SYNOPSIS
Read-only interactive verification for an already-running GPT + Codex Custom renderer.

.DESCRIPTION
Reads the isolated profile's DevToolsActivePort, attaches only to the exact
app://-/index.html page target, and inspects the current DOM through CDP.

The CDP expression is intentionally observational. It does not click controls,
dispatch events, focus inputs, send messages, upload files, regenerate output,
start dictation, or invoke the shipped custom self-test. The only callable
bridges it uses are explicitly named diagnostic probe functions.

.PARAMETER DevToolsActivePortPath
Path to DevToolsActivePort. The path must remain beneath this project's
profile\chromium directory so the verifier cannot attach through the normal
Codex profile.

.PARAMETER OutputFormat
Table, Json, or Both. Both writes the table to the host and emits JSON to the
success stream.

.PARAMETER TimeoutSeconds
Timeout for each CDP connect, send, and response operation.

.PARAMETER TargetWaitSeconds
Maximum time to wait for the exact app://-/index.html target to appear.
#>
[CmdletBinding()]
param(
    [string]$DevToolsActivePortPath,

    [ValidateSet("Table", "Json", "Both")]
    [string]$OutputFormat = "Both",

    [ValidateRange(1, 120)]
    [int]$TimeoutSeconds = 20,

    [ValidateRange(1, 60)]
    [int]$TargetWaitSeconds = 45
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$ChromiumProfileRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "profile\chromium"))
if ([string]::IsNullOrWhiteSpace($DevToolsActivePortPath)) {
    $DevToolsActivePortPath = Join-Path $ChromiumProfileRoot "DevToolsActivePort"
}
$DevToolsActivePortPath = [System.IO.Path]::GetFullPath($DevToolsActivePortPath)

$ExpectedTargetUrl = "app://-/index.html"
$MaximumCdpMessageBytes = 8MB

function Get-ObjectPropertyValue {
    param(
        [AllowNull()]
        [object]$InputObject,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [AllowNull()]
        [object]$Default = $null
    )

    if ($null -eq $InputObject) {
        return $Default
    }

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $Default
    }

    return $property.Value
}

function Assert-IsolatedDevToolsPortPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $profilePrefix = $ChromiumProfileRoot.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar

    if (-not $Path.StartsWith($profilePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "DevToolsActivePort must be beneath the isolated custom Chromium profile: $ChromiumProfileRoot"
    }
    if ([System.IO.Path]::GetFileName($Path) -ne "DevToolsActivePort") {
        throw "The debugger endpoint file must be named DevToolsActivePort."
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "The isolated custom runtime does not have a DevToolsActivePort file: $Path"
    }
}

function Get-DebugPort {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $lines = @(Get-Content -LiteralPath $Path -ErrorAction Stop)
    if ($lines.Count -lt 1) {
        throw "DevToolsActivePort is empty: $Path"
    }

    $debugPort = 0
    if (-not [int]::TryParse(([string]$lines[0]).Trim(), [ref]$debugPort)) {
        throw "DevToolsActivePort does not begin with a numeric port."
    }
    if ($debugPort -lt 1 -or $debugPort -gt 65535) {
        throw "DevToolsActivePort contains an invalid TCP port: $debugPort"
    }

    return $debugPort
}

function Get-ExactRendererTarget {
    param(
        [Parameter(Mandatory = $true)]
        [int]$DebugPort,

        [Parameter(Mandatory = $true)]
        [int]$WaitSeconds
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    $lastEndpointError = $null

    do {
        $targets = $null
        foreach ($endpointPath in @("json/list", "json")) {
            try {
                $endpointResponse = Invoke-RestMethod `
                    -Uri "http://127.0.0.1:$DebugPort/$endpointPath" `
                    -TimeoutSec 2
                $targets = @($endpointResponse)
                $lastEndpointError = $null
                break
            } catch {
                $lastEndpointError = $_.Exception.Message
            }
        }

        if ($null -ne $targets) {
            $matches = @(
                $targets | Where-Object {
                    (Get-ObjectPropertyValue -InputObject $_ -Name "type") -eq "page" -and
                    (Get-ObjectPropertyValue -InputObject $_ -Name "url") -ceq $ExpectedTargetUrl
                }
            )

            if ($matches.Count -gt 1) {
                throw "More than one exact $ExpectedTargetUrl page target is exposed; refusing an ambiguous attachment."
            }
            if ($matches.Count -eq 1) {
                $webSocketUrl = [string](
                    Get-ObjectPropertyValue -InputObject $matches[0] -Name "webSocketDebuggerUrl"
                )
                if ([string]::IsNullOrWhiteSpace($webSocketUrl)) {
                    throw "The exact renderer target does not expose a WebSocket debugger URL."
                }

                $webSocketUri = [Uri]$webSocketUrl
                if ($webSocketUri.Scheme -ne "ws") {
                    throw "The renderer debugger URL is not a local ws:// endpoint."
                }
                if ($webSocketUri.Host -notin @("127.0.0.1", "localhost", "::1")) {
                    throw "The renderer debugger URL is not loopback-only."
                }

                return $matches[0]
            }
        }

        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    $detail = if ($lastEndpointError) { " Last endpoint error: $lastEndpointError" } else { "" }
    throw "The exact $ExpectedTargetUrl page target did not appear on the isolated debugger port.$detail"
}

function Send-CdpRequest {
    param(
        [Parameter(Mandatory = $true)]
        [System.Net.WebSockets.ClientWebSocket]$Socket,

        [Parameter(Mandatory = $true)]
        [string]$Json,

        [Parameter(Mandatory = $true)]
        [int]$OperationTimeoutSeconds
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Json)
    $cancellation = [System.Threading.CancellationTokenSource]::new()
    $cancellation.CancelAfter([TimeSpan]::FromSeconds($OperationTimeoutSeconds))
    try {
        $Socket.SendAsync(
            [ArraySegment[byte]]::new($bytes),
            [System.Net.WebSockets.WebSocketMessageType]::Text,
            $true,
            $cancellation.Token
        ).GetAwaiter().GetResult() | Out-Null
    } catch [System.OperationCanceledException] {
        throw "Timed out while sending the CDP inspection request."
    } finally {
        $cancellation.Dispose()
    }
}

function Receive-CdpResponse {
    param(
        [Parameter(Mandatory = $true)]
        [System.Net.WebSockets.ClientWebSocket]$Socket,

        [Parameter(Mandatory = $true)]
        [long]$RequestId,

        [Parameter(Mandatory = $true)]
        [int]$OperationTimeoutSeconds,

        [Parameter(Mandatory = $true)]
        [long]$MaximumMessageBytes
    )

    $buffer = New-Object byte[] 16384
    $messageBytes = [System.IO.MemoryStream]::new()
    $messageType = $null
    $cancellation = [System.Threading.CancellationTokenSource]::new()
    $cancellation.CancelAfter([TimeSpan]::FromSeconds($OperationTimeoutSeconds))

    try {
        while ($true) {
            try {
                $receiveResult = $Socket.ReceiveAsync(
                    [ArraySegment[byte]]::new($buffer),
                    $cancellation.Token
                ).GetAwaiter().GetResult()
            } catch [System.OperationCanceledException] {
                throw "Timed out waiting for CDP response id $RequestId."
            }

            if ($receiveResult.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                throw "The renderer closed the debugger WebSocket before CDP response id $RequestId arrived."
            }

            if ($null -eq $messageType) {
                $messageType = $receiveResult.MessageType
            } elseif ($messageType -ne $receiveResult.MessageType) {
                throw "The debugger changed WebSocket message type inside a fragmented message."
            }

            if ($receiveResult.Count -gt 0) {
                $messageBytes.Write($buffer, 0, $receiveResult.Count)
            }
            if ($messageBytes.Length -gt $MaximumMessageBytes) {
                throw "A CDP WebSocket message exceeded the $MaximumMessageBytes byte safety limit."
            }

            if (-not $receiveResult.EndOfMessage) {
                continue
            }

            if ($messageType -eq [System.Net.WebSockets.WebSocketMessageType]::Text) {
                $messageText = [System.Text.Encoding]::UTF8.GetString($messageBytes.ToArray())
                try {
                    $message = $messageText | ConvertFrom-Json -ErrorAction Stop
                } catch {
                    throw "The debugger returned a complete non-JSON text message."
                }

                $messageId = Get-ObjectPropertyValue -InputObject $message -Name "id"
                if ($null -ne $messageId -and [long]$messageId -eq $RequestId) {
                    return $message
                }
            }

            # CDP events and responses for other request ids are complete messages;
            # discard them and begin assembling the next potentially fragmented one.
            $messageBytes.SetLength(0)
            $messageBytes.Position = 0
            $messageType = $null
        }
    } finally {
        $messageBytes.Dispose()
        $cancellation.Dispose()
    }
}

function Add-VerificationCheck {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IList]$List,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$Category,

        [Parameter(Mandatory = $true)]
        [bool]$Required,

        [Parameter(Mandatory = $true)]
        [string]$Status,

        [Parameter(Mandatory = $true)]
        [string]$Detail,

        [AllowNull()]
        [object]$Evidence = $null
    )

    [void]$List.Add([PSCustomObject][ordered]@{
        name = $Name
        category = $Category
        required = $Required
        status = $Status
        detail = $Detail
        evidence = $Evidence
    })
}

function Add-RequiredVerificationCheck {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IList]$List,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$Category,

        [Parameter(Mandatory = $true)]
        [bool]$Passed,

        [Parameter(Mandatory = $true)]
        [string]$PassedDetail,

        [Parameter(Mandatory = $true)]
        [string]$FailedDetail,

        [AllowNull()]
        [object]$Evidence = $null
    )

    $status = if ($Passed) { "Passed" } else { "Failed" }
    $detail = if ($Passed) { $PassedDetail } else { $FailedDetail }
    Add-VerificationCheck -List $List -Name $Name -Category $Category -Required $true `
        -Status $status -Detail $detail -Evidence $Evidence
}

function Add-NativeObservation {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IList]$List,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [bool]$Available,

        [Parameter(Mandatory = $true)]
        [string]$ObservedDetail,

        [Parameter(Mandatory = $true)]
        [string]$UnavailableDetail,

        [AllowNull()]
        [object]$Evidence = $null
    )

    $status = if ($Available) { "Observed" } else { "Unavailable" }
    $detail = if ($Available) { $ObservedDetail } else { $UnavailableDetail }
    Add-VerificationCheck -List $List -Name $Name -Category "Native capability" -Required $false `
        -Status $status -Detail $detail -Evidence $Evidence
}

$InspectionExpression = @'
(async () => {
  "use strict";

  const EXPECTED_URL = "app://-/index.html";
  const readinessDeadline = Date.now() + 15_000;
  while (Date.now() < readinessDeadline) {
    const sidebar = document.getElementById("gpt-codex-custom-chat-sidebar");
    const newChat = sidebar?.querySelector('[data-gpt-codex-custom-new-chat="true"]');
    const searchBridge = globalThis.GPT_CODEX_CUSTOM_CHAT_SEARCH;
    const chatActionBridge = globalThis.GPT_CODEX_CUSTOM_CHAT_ACTIONS;
    const requiredChatActionMethods = [
      "archiveConversation",
      "deleteConversation",
      "pinConversation",
      "renameConversation",
      "shareConversation",
    ];
    const conversationMenuTrigger = sidebar?.querySelector(
      '[data-gpt-codex-custom-conversation-menu-trigger="true"]:not(:disabled)',
    );
    if (
      globalThis.GPT_CODEX_CUSTOM_BUILD &&
      document.querySelector('[data-pip-obstacle="quick-chat"]') &&
      newChat &&
      !newChat.disabled &&
      sidebar.querySelectorAll(".gpt-codex-custom-chat-sidebar-item").length > 0 &&
      searchBridge?.available === true &&
      typeof searchBridge.search === "function" &&
      chatActionBridge?.available === true &&
      requiredChatActionMethods.every((method) => typeof chatActionBridge[method] === "function") &&
      conversationMenuTrigger
    ) {
      break;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const round = (value) => Math.round(Number(value) * 100) / 100;
  const toNumber = (value) => {
    const normalized = String(value ?? "").replace(/,/g, "").trim();
    return /^-?\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : null;
  };
  const first = (selectors, root = document) => {
    for (const selector of selectors) {
      try {
        const match = root.querySelector(selector);
        if (match) return match;
      } catch {
        // A compatibility selector should not abort the read-only snapshot.
      }
    }
    return null;
  };
  const rectOf = (element) => {
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    return {
      bottom: round(rect.bottom),
      height: round(rect.height),
      left: round(rect.left),
      right: round(rect.right),
      top: round(rect.top),
      width: round(rect.width),
      x: round(rect.x),
      y: round(rect.y),
    };
  };
  const clippedRectOf = (element) => {
    if (!(element instanceof Element)) return null;
    const raw = element.getBoundingClientRect();
    let left = Math.max(0, raw.left);
    let right = Math.min(innerWidth, raw.right);
    let top = Math.max(0, raw.top);
    let bottom = Math.min(innerHeight, raw.bottom);

    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const ancestorRect = ancestor.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, ancestorRect.left);
        right = Math.min(right, ancestorRect.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, ancestorRect.top);
        bottom = Math.min(bottom, ancestorRect.bottom);
      }
      if (right <= left || bottom <= top) return null;
    }

    return {
      bottom: round(bottom),
      height: round(bottom - top),
      left: round(left),
      right: round(right),
      top: round(top),
      width: round(right - left),
      x: round(left),
      y: round(top),
    };
  };
  const isRendered = (element) => {
    if (!(element instanceof Element) || !element.isConnected) return false;
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
  };
  const isVisible = (element) => {
    if (!isRendered(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
  };
  const isDisabled = (element) =>
    Boolean(
      element?.disabled ||
        element?.getAttribute?.("aria-disabled") === "true" ||
        element?.matches?.(":disabled"),
    );
  const elementMarker = (element) => {
    if (!(element instanceof Element)) return "";
    return normalize(
      [
        element.id,
        element.className,
        ...[...element.attributes]
          .filter((attribute) => attribute.name.startsWith("data-gpt-codex-"))
          .map((attribute) => `${attribute.name}=${attribute.value}`),
      ].join(" "),
    );
  };
  const findCustomFeature = (kind, selectors) => {
    const direct = first(selectors);
    if (direct) return direct;
    const candidates = document.querySelectorAll(
      '[id*="gpt-codex-"], [class*="gpt-codex-"], [data-gpt-codex-custom], ' +
        '[data-gpt-codex-token-hud], [data-gpt-codex-pinboard]',
    );
    return (
      [...candidates].find((element) => {
        const marker = elementMarker(element);
        return marker.toLocaleLowerCase().includes(kind.toLocaleLowerCase());
      }) ?? null
    );
  };
  const safeProbeSummary = (value) => {
    if (value == null) return { type: String(value), keys: [] };
    if (Array.isArray(value)) return { type: "array", length: value.length, keys: [] };
    if (typeof value !== "object") return { type: typeof value, keys: [] };
    const keys = Object.keys(value).slice(0, 40);
    const booleans = {};
    const numbers = {};
    const arrayLengths = {};
    const safeStrings = {};
    for (const key of keys) {
      const item = value[key];
      if (typeof item === "boolean") booleans[key] = item;
      else if (typeof item === "number" && Number.isFinite(item)) numbers[key] = item;
      else if (Array.isArray(item)) arrayLengths[key] = item.length;
      else if (
        typeof item === "string" &&
        /^(state|status|mode|precision|placement|source|selectedSystemHint)$/i.test(key)
      ) {
        safeStrings[key] = item.slice(0, 80);
      }
    }
    return { type: "object", keys, booleans, numbers, arrayLengths, safeStrings };
  };

  const root = document.documentElement;
  const chatSurface = document.querySelector('[data-pip-obstacle="quick-chat"]');
  const sidebar = document.getElementById("gpt-codex-custom-chat-sidebar");
  const chatMode = root.getAttribute("data-gpt-codex-custom-mode") === "chat";
  const auxiliaryView = root.getAttribute("data-gpt-codex-custom-aux-view");
  const customBuild = globalThis.GPT_CODEX_CUSTOM_BUILD;

  const navLabels = sidebar
    ? [...sidebar.querySelectorAll(".gpt-codex-custom-chat-nav-label")].map((element) =>
        normalize(element.textContent),
      )
    : [];
  const newChatControl =
    sidebar?.querySelector('[data-gpt-codex-custom-new-chat="true"]') ??
    [...(sidebar?.querySelectorAll("button") ?? [])].find(
      (button) => normalize(button.textContent) === "New chat",
    ) ??
    null;
  const searchControl =
    [...(sidebar?.querySelectorAll(".gpt-codex-custom-chat-nav-row") ?? [])].find(
      (button) => normalize(button.textContent) === "Search chats",
    ) ?? null;
  const searchPanel = sidebar?.querySelector(".gpt-codex-custom-chat-search-panel") ?? null;
  const searchInput = searchPanel?.querySelector('input[type="search"]') ?? null;
  const nativeSearchBridge = globalThis.GPT_CODEX_CUSTOM_CHAT_SEARCH;
  const nativeSearchReady = Boolean(
    nativeSearchBridge?.available === true &&
      typeof nativeSearchBridge?.search === "function",
  );
  const nativeChatActionBridge = globalThis.GPT_CODEX_CUSTOM_CHAT_ACTIONS;
  const requiredChatActionMethods = [
    "archiveConversation",
    "deleteConversation",
    "pinConversation",
    "renameConversation",
    "shareConversation",
  ];
  const availableChatActionMethods = requiredChatActionMethods.filter(
    (method) => typeof nativeChatActionBridge?.[method] === "function",
  );
  const nativeChatManagementReady = Boolean(
    nativeChatActionBridge?.available === true &&
      availableChatActionMethods.length === requiredChatActionMethods.length,
  );
  const conversationMenuControls = sidebar
    ? [...sidebar.querySelectorAll(
        '[data-gpt-codex-custom-conversation-menu-trigger="true"]',
      )]
    : [];
  const enabledConversationMenuControls = conversationMenuControls.filter(
    (control) => !isDisabled(control),
  );
  const visibleConversationMenuControls = enabledConversationMenuControls.filter(isVisible);
  const historyContainer =
    sidebar?.querySelector(".gpt-codex-custom-chat-sidebar-history") ?? null;
  const historyRows = sidebar
    ? sidebar.querySelectorAll(".gpt-codex-custom-chat-sidebar-item").length
    : 0;
  const historySections = sidebar
    ? [...sidebar.querySelectorAll(".gpt-codex-custom-chat-sidebar-section-title")]
        .map((element) => normalize(element.textContent))
        .filter((label) => label === "Pinned" || label === "Recents")
    : [];

  const modeTrigger =
    document.querySelector('[data-gpt-codex-custom-product-selector="true"]') ?? null;
  const modeMenu =
    document.querySelector('[data-gpt-codex-custom-product-menu="true"]') ?? null;
  const modeOptions = modeMenu
    ? [...modeMenu.querySelectorAll("[data-mode]")].map((option) => ({
        mode: normalize(option.getAttribute("data-mode")).toLocaleLowerCase(),
        role: option.getAttribute("role"),
        checked: option.getAttribute("aria-checked"),
        nativeBridgeReady: option.getAttribute("data-native-bridge-ready"),
      }))
    : [];
  const modeNames = modeOptions.map((option) => option.mode);

  const tokenHost = document.getElementById("gpt-codex-token-hud-host");
  const tokenHud = findCustomFeature("token", [
    "#gpt-codex-token-hud",
    '[data-gpt-codex-token-hud]',
    ".gpt-codex-token-hud",
    "#gpt-codex-custom-token-hud",
    "#gpt-codex-custom-token-usage",
    '[data-gpt-codex-custom-token-hud]',
    '[data-gpt-codex-custom-token-usage]',
    ".gpt-codex-custom-token-hud",
    ".gpt-codex-custom-token-usage",
  ]);
  const tokenText = normalize(tokenHud?.textContent);
  const tokenNodes = tokenHud
    ? [root, tokenHost, tokenHud, ...tokenHud.querySelectorAll("*")].filter(Boolean)
    : [];
  const tokenMetrics = [];
  for (const node of tokenNodes.slice(0, 200)) {
    for (const attribute of [...node.attributes]) {
      if (!/(token|context|usage|used|limit|max|remaining|percent|ratio|precision)/i.test(attribute.name)) {
        continue;
      }
      const value = toNumber(attribute.value);
      if (value != null) {
        tokenMetrics.push({ name: attribute.name, value });
      }
    }
    if (node instanceof HTMLMeterElement || node instanceof HTMLProgressElement) {
      if (Number.isFinite(node.value)) tokenMetrics.push({ name: "element-value", value: node.value });
      if (Number.isFinite(node.max)) tokenMetrics.push({ name: "element-max", value: node.max });
    }
  }
  const tokenMetricElements = tokenHud
    ? tokenHud.querySelectorAll(
        '.gpt-codex-token-hud__metric-value, [data-token-value], [data-token-used], ' +
          '[data-token-limit], [data-token-percent], meter, progress, output',
      ).length
    : 0;
  const tokenMetricOutputs = tokenHud
    ? [...tokenHud.querySelectorAll(".gpt-codex-token-hud__metric-value, output")]
    : [];
  const fullPrecisionValue = (element) => {
    if (!(element instanceof Element)) return null;
    for (const candidate of [
      element.getAttribute("title"),
      element.getAttribute("aria-label"),
      element.textContent,
    ]) {
      const match = normalize(candidate).match(/-?\d[\d,]*(?:\.\d+)?/);
      if (match) return toNumber(match[0]);
    }
    return null;
  };

  let tokenProbeFunction = null;
  let tokenProbeOwner = globalThis;
  let tokenProbeName = null;
  if (typeof globalThis.GPT_CODEX_CUSTOM_TOKEN_PROBE === "function") {
    tokenProbeFunction = globalThis.GPT_CODEX_CUSTOM_TOKEN_PROBE;
    tokenProbeName = "GPT_CODEX_CUSTOM_TOKEN_PROBE";
  } else if (typeof globalThis.GPT_CODEX_CUSTOM_TOKEN_HUD?.probe === "function") {
    tokenProbeFunction = globalThis.GPT_CODEX_CUSTOM_TOKEN_HUD.probe;
    tokenProbeOwner = globalThis.GPT_CODEX_CUSTOM_TOKEN_HUD;
    tokenProbeName = "GPT_CODEX_CUSTOM_TOKEN_HUD.probe";
  }
  const tokenProbe = {
    available: typeof tokenProbeFunction === "function",
    name: tokenProbeName,
    succeeded: false,
    asynchronous: false,
    state: null,
    error: null,
  };
  if (tokenProbe.available) {
    try {
      const probeValue = tokenProbeFunction.call(tokenProbeOwner);
      if (probeValue && typeof probeValue.then === "function") {
        tokenProbe.asynchronous = true;
        tokenProbe.error = "Diagnostic probe returned a Promise; it was not awaited.";
      } else {
        tokenProbe.succeeded = true;
        tokenProbe.state = {
          active: probeValue?.active === true,
          cachedInputTokens:
            typeof probeValue?.cachedInputTokens === "number"
              ? probeValue.cachedInputTokens
              : null,
          contextWindowTokens:
            typeof probeValue?.contextWindowTokens === "number"
              ? probeValue.contextWindowTokens
              : null,
          currentContextPercent:
            typeof probeValue?.currentContextPercent === "number"
              ? probeValue.currentContextPercent
              : null,
          currentContextRemainingTokens:
            typeof probeValue?.currentContextRemainingTokens === "number"
              ? probeValue.currentContextRemainingTokens
              : null,
          currentContextTokens:
            typeof probeValue?.currentContextTokens === "number"
              ? probeValue.currentContextTokens
              : null,
          currentReasoningOutputTokens:
            typeof probeValue?.currentReasoningOutputTokens === "number"
              ? probeValue.currentReasoningOutputTokens
              : null,
          deduplicatedUpdates:
            typeof probeValue?.deduplicatedUpdates === "number"
              ? probeValue.deduplicatedUpdates
              : null,
          estimatedRecordCount:
            typeof probeValue?.estimatedRecordCount === "number"
              ? probeValue.estimatedRecordCount
              : null,
          exactRecordCount:
            typeof probeValue?.exactRecordCount === "number"
              ? probeValue.exactRecordCount
              : null,
          inputQuality:
            typeof probeValue?.input?.quality === "string" ? probeValue.input.quality : null,
          inputTokens:
            typeof probeValue?.input?.tokens === "number" ? probeValue.input.tokens : null,
          lastDiagnosticError:
            typeof probeValue?.lastDiagnosticError === "string"
              ? probeValue.lastDiagnosticError.slice(0, 120)
              : null,
          mode: typeof probeValue?.mode === "string" ? probeValue.mode : null,
          outputQuality:
            typeof probeValue?.output?.quality === "string" ? probeValue.output.quality : null,
          outputTokens:
            typeof probeValue?.output?.tokens === "number" ? probeValue.output.tokens : null,
          dock: typeof probeValue?.dock === "string" ? probeValue.dock : null,
          overlapSafe: probeValue?.overlapSafe !== false,
          placement:
            typeof probeValue?.placement === "string" ? probeValue.placement : null,
          quality: typeof probeValue?.quality === "string" ? probeValue.quality : null,
          reasoningOutputTokens:
            typeof probeValue?.reasoningOutputTokens === "number"
              ? probeValue.reasoningOutputTokens
              : null,
          recordCount:
            typeof probeValue?.messageRecordCount === "number"
              ? probeValue.messageRecordCount
              : null,
          staleUpdates:
            typeof probeValue?.staleUpdates === "number" ? probeValue.staleUpdates : null,
          threadAvailable: probeValue?.threadAvailable === true,
          threadCount:
            typeof probeValue?.threadCount === "number" ? probeValue.threadCount : null,
          thinkingQuality:
            typeof probeValue?.thinking?.quality === "string"
              ? probeValue.thinking.quality
              : null,
          thinkingTokens:
            typeof probeValue?.thinking?.tokens === "number"
              ? probeValue.thinking.tokens
              : null,
          totalTokens:
            typeof probeValue?.totalTokens === "number" ? probeValue.totalTokens : null,
          version: typeof probeValue?.version === "string" ? probeValue.version : null,
        };
      }
    } catch (error) {
      tokenProbe.error = normalize(error?.message ?? error).slice(0, 200);
    }
  }
  const tokenContractSelfTest = {
    available: typeof globalThis.GPT_CODEX_CUSTOM_TOKEN_SELF_TEST === "function",
    succeeded: false,
    result: null,
    error: null,
  };
  if (tokenContractSelfTest.available) {
    try {
      const selfTestValue = globalThis.GPT_CODEX_CUSTOM_TOKEN_SELF_TEST();
      if (selfTestValue && typeof selfTestValue.then === "function") {
        tokenContractSelfTest.error = "Token contract self-test returned a Promise.";
      } else {
        tokenContractSelfTest.succeeded = true;
        tokenContractSelfTest.result = {
          authoritativeReplacementWorks:
            selfTestValue?.authoritativeReplacementWorks === true,
          delayedModeRoutingWorks: selfTestValue?.delayedModeRoutingWorks === true,
          modeIsolationWorks: selfTestValue?.modeIsolationWorks === true,
          nestedLastWorks: selfTestValue?.nestedLastWorks === true,
          nestedTotalWorks: selfTestValue?.nestedTotalWorks === true,
          pass: selfTestValue?.pass === true,
          persistedServerCacheWorks:
            selfTestValue?.persistedServerCacheWorks === true,
          protocolSnakeCaseWorks: selfTestValue?.protocolSnakeCaseWorks === true,
          serverSourcePrecedenceWorks:
            selfTestValue?.serverSourcePrecedenceWorks === true,
          serverTotalPreferredWorks: selfTestValue?.serverTotalPreferredWorks === true,
          stableMessageReplacementWorks:
            selfTestValue?.stableMessageReplacementWorks === true,
          thinkingTrackingWorks: selfTestValue?.thinkingTrackingWorks === true,
          version: typeof selfTestValue?.version === "string" ? selfTestValue.version : null,
        };
      }
    } catch (error) {
      tokenContractSelfTest.error = normalize(error?.message ?? error).slice(0, 200);
    }
  }
  const tokenRatioMatch = tokenText.match(
    /([\d,]+(?:\.\d+)?)\s*(?:tokens?)?\s*(?:\/|of)\s*([\d,]+(?:\.\d+)?)/i,
  );
  const tokenPercentMatch = tokenText.match(/(-?\d+(?:\.\d+)?)\s*%/);
  const findTokenMetric = (pattern, exclude = /$a/) =>
    tokenMetrics.find((metric) => pattern.test(metric.name) && !exclude.test(metric.name))?.value ?? null;
  let usedTokens = findTokenMetric(
    /(used|current|consumed|total.?tokens|token.?count|element-value)/i,
    /(limit|max|window|remaining|percent|ratio)/i,
  );
  let tokenLimit = findTokenMetric(/(limit|max|window|capacity|element-max)/i);
  let displayedPercent = findTokenMetric(/(percent|percentage)/i);
  if (usedTokens == null && tokenRatioMatch) usedTokens = toNumber(tokenRatioMatch[1]);
  if (tokenLimit == null && tokenRatioMatch) tokenLimit = toNumber(tokenRatioMatch[2]);
  if (displayedPercent == null && tokenPercentMatch) displayedPercent = toNumber(tokenPercentMatch[1]);
  const tokenState =
    root.getAttribute("data-gpt-codex-token-hud") ??
    tokenHud?.getAttribute("data-state") ??
    tokenHud?.getAttribute("data-status") ??
    tokenHud?.getAttribute("data-token-state") ??
    null;
  const probedTokenState = tokenProbe.state;
  if (probedTokenState?.currentContextTokens != null) {
    usedTokens = probedTokenState.currentContextTokens;
  } else if (probedTokenState?.totalTokens != null) {
    usedTokens = probedTokenState.totalTokens;
  }
  if (probedTokenState?.contextWindowTokens != null) {
    tokenLimit = probedTokenState.contextWindowTokens;
  }
  const tokenUnavailableState =
    /unavailable|waiting|loading|idle|empty|unknown/i.test(tokenState ?? "") ||
    /no token|token data unavailable|waiting for token/i.test(tokenText) ||
    (tokenProbe.succeeded &&
      (probedTokenState?.quality === "unavailable" || !probedTokenState?.threadAvailable));
  const probedTokenNumbers = probedTokenState
    ? [
        probedTokenState.cachedInputTokens,
        probedTokenState.contextWindowTokens,
        probedTokenState.currentContextRemainingTokens,
        probedTokenState.currentContextTokens,
        probedTokenState.currentReasoningOutputTokens,
        probedTokenState.deduplicatedUpdates,
        probedTokenState.estimatedRecordCount,
        probedTokenState.exactRecordCount,
        probedTokenState.inputTokens,
        probedTokenState.outputTokens,
        probedTokenState.reasoningOutputTokens,
        probedTokenState.recordCount,
        probedTokenState.staleUpdates,
        probedTokenState.threadCount,
        probedTokenState.thinkingTokens,
        probedTokenState.totalTokens,
      ].filter((value) => value != null)
    : [];
  const finiteTokenMetrics =
    tokenMetrics.every((metric) => Number.isFinite(metric.value)) &&
    probedTokenNumbers.every(Number.isFinite) &&
    (probedTokenState?.currentContextPercent == null ||
      Number.isFinite(probedTokenState.currentContextPercent));
  const countLikeMetrics = tokenMetrics.filter(
    (metric) =>
      /(token|used|limit|max|window|remaining|count|element-value|element-max)/i.test(metric.name) &&
      !/(percent|ratio|precision)/i.test(metric.name),
  );
  const integralTokenMetrics =
    countLikeMetrics.every((metric) => Number.isInteger(metric.value)) &&
    probedTokenNumbers.every((value) => Number.isInteger(value) && value >= 0);
  let expectedPercent = null;
  let percentageError = null;
  let percentageTolerance = null;
  let percentageConsistent = null;
  if (usedTokens != null && tokenLimit != null && tokenLimit > 0 && displayedPercent != null) {
    expectedPercent = (usedTokens / tokenLimit) * 100;
    const decimalDigits = tokenPercentMatch?.[1]?.split(".")[1]?.length ?? 2;
    percentageTolerance = Math.max(0.005, 0.5 * 10 ** -decimalDigits);
    percentageError = Math.abs(displayedPercent - expectedPercent);
    percentageConsistent = percentageError <= percentageTolerance + 0.000001;
  }
  const hasTokenTelemetry =
    probedTokenNumbers.length > 0 ||
    tokenMetrics.length > 0 ||
    tokenRatioMatch != null ||
    tokenPercentMatch != null;
  const inputFullPrecision = fullPrecisionValue(tokenMetricOutputs[0]);
  const outputFullPrecision = fullPrecisionValue(tokenMetricOutputs[1]);
  const thinkingFullPrecision = fullPrecisionValue(tokenMetricOutputs[2]);
  const displayPrecisionMatches = Boolean(
    tokenProbe.succeeded &&
      (probedTokenState?.inputTokens == null ||
        inputFullPrecision === probedTokenState.inputTokens) &&
      (probedTokenState?.outputTokens == null ||
        outputFullPrecision === probedTokenState.outputTokens) &&
      (probedTokenState?.thinkingTokens == null ||
        thinkingFullPrecision === probedTokenState.thinkingTokens),
  );
  const totalConsistency = Boolean(
    tokenProbe.succeeded &&
      (probedTokenState?.totalTokens == null ||
        probedTokenState?.inputTokens == null ||
        probedTokenState?.outputTokens == null ||
        probedTokenState.totalTokens ===
          probedTokenState.inputTokens + probedTokenState.outputTokens),
  );
  const qualityValuesValid = Boolean(
    tokenProbe.succeeded &&
      [
        probedTokenState?.quality,
        probedTokenState?.inputQuality,
        probedTokenState?.outputQuality,
        probedTokenState?.thinkingQuality,
      ].every((quality) => quality == null || ["exact", "estimated", "unavailable"].includes(quality)),
  );
  const tokenStructurePass = Boolean(
    tokenHud &&
      tokenHost &&
      /token/i.test(`${elementMarker(tokenHud)} ${tokenHud.getAttribute("aria-label") ?? ""} ${tokenText}`) &&
      tokenHud.querySelector("details > summary") &&
      tokenMetricOutputs.length >= 2 &&
      tokenHost.dataset.dock === "right" &&
      tokenProbe.available,
  );
  const tokenPrecisionPass = Boolean(
    tokenHud &&
      tokenProbe.succeeded &&
      finiteTokenMetrics &&
      integralTokenMetrics &&
      qualityValuesValid &&
      displayPrecisionMatches &&
      totalConsistency &&
      tokenContractSelfTest.succeeded &&
      tokenContractSelfTest.result?.pass === true &&
      (!chatMode || probedTokenState?.mode === "chat") &&
      (tokenUnavailableState || hasTokenTelemetry),
  );

  const pinboard = findCustomFeature("pinboard", [
    "#gpt-codex-pinboard-drawer",
    '[data-gpt-codex-pinboard-drawer]',
    ".gpt-codex-pinboard-drawer",
    "#gpt-codex-custom-pinboard",
    '[data-gpt-codex-custom-pinboard]',
    ".gpt-codex-custom-pinboard",
  ]);
  const pinboardToggle = first([
    "#gpt-codex-pinboard-launcher",
    '[data-gpt-codex-pinboard-action="open"]',
    '[data-gpt-codex-custom-pinboard-toggle]',
    '[aria-controls*="pinboard" i]',
    'button[aria-label*="pinboard" i]',
    'button[title*="pinboard" i]',
  ]);
  const pinboardList = pinboard
    ? first(
        [
          '[data-gpt-codex-pinboard-list]',
          ".gpt-codex-pinboard-list",
          '[data-gpt-codex-custom-pinboard-list]',
          ".gpt-codex-custom-pinboard-list",
          '[role="list"]',
        ],
        pinboard,
      )
    : null;
  const pinboardItems = pinboard
    ? pinboard.querySelectorAll(
        '[data-gpt-codex-pinboard-item-id], .gpt-codex-pinboard-item, ' +
          '[data-gpt-codex-custom-pinboard-item], .gpt-codex-custom-pinboard-item, ' +
          '[data-pin-id], [role="listitem"]',
      ).length
    : 0;
  const pinboardAccessibleName = normalize(
    `${pinboard?.getAttribute("aria-label") ?? ""} ${pinboard?.getAttribute("title") ?? ""}`,
  );
  const pinboardStructurePass = Boolean(
    pinboard &&
      /pinboard/i.test(`${elementMarker(pinboard)} ${pinboardAccessibleName}`) &&
      (pinboardToggle || pinboard.getAttribute("role") || pinboardAccessibleName) &&
      (pinboardList || pinboard.children.length > 0),
  );

  let pinboardProbeFunction = null;
  let pinboardProbeOwner = globalThis;
  let pinboardProbeName = null;
  if (typeof globalThis.GPT_CODEX_CUSTOM_PINBOARD_PROBE === "function") {
    pinboardProbeFunction = globalThis.GPT_CODEX_CUSTOM_PINBOARD_PROBE;
    pinboardProbeName = "GPT_CODEX_CUSTOM_PINBOARD_PROBE";
  } else if (typeof globalThis.GPT_CODEX_CUSTOM_PINBOARD?.probe === "function") {
    pinboardProbeFunction = globalThis.GPT_CODEX_CUSTOM_PINBOARD.probe;
    pinboardProbeOwner = globalThis.GPT_CODEX_CUSTOM_PINBOARD;
    pinboardProbeName = "GPT_CODEX_CUSTOM_PINBOARD.probe";
  } else {
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (!/^GPT_CODEX_CUSTOM_.*PINBOARD.*PROBE$/i.test(name)) continue;
      if (typeof globalThis[name] === "function") {
        pinboardProbeFunction = globalThis[name];
        pinboardProbeName = name;
        break;
      }
    }
  }
  const pinboardProbe = {
    available: typeof pinboardProbeFunction === "function",
    name: pinboardProbeName,
    succeeded: false,
    asynchronous: false,
    contractPass: false,
    summary: null,
    error: null,
  };
  if (pinboardProbe.available) {
    try {
      const probeValue = pinboardProbeFunction.call(pinboardProbeOwner);
      if (probeValue && typeof probeValue.then === "function") {
        pinboardProbe.asynchronous = true;
        pinboardProbe.error = "Diagnostic probe returned a Promise; it was not awaited.";
      } else {
        pinboardProbe.succeeded = true;
        pinboardProbe.summary = {
          bridgeMessages: {
            associated:
              typeof probeValue?.bridgeMessages?.associated === "number"
                ? probeValue.bridgeMessages.associated
                : null,
            complete:
              typeof probeValue?.bridgeMessages?.complete === "number"
                ? probeValue.bridgeMessages.complete
                : null,
            pending:
              typeof probeValue?.bridgeMessages?.pending === "number"
                ? probeValue.bridgeMessages.pending
                : null,
            total:
              typeof probeValue?.bridgeMessages?.total === "number"
                ? probeValue.bridgeMessages.total
                : null,
          },
          database: {
            name: typeof probeValue?.database?.name === "string" ? probeValue.database.name : null,
            store: typeof probeValue?.database?.store === "string" ? probeValue.database.store : null,
            version:
              typeof probeValue?.database?.version === "number"
                ? probeValue.database.version
                : null,
          },
          drawer: {
            filter:
              typeof probeValue?.drawer?.filter === "string" ? probeValue.drawer.filter : null,
            open: probeValue?.drawer?.open === true,
            pendingDeletion: probeValue?.drawer?.pendingDeletion === true,
          },
          localOnly: probeValue?.localOnly === true,
          pins: {
            chat: typeof probeValue?.pins?.chat === "number" ? probeValue.pins.chat : null,
            codex: typeof probeValue?.pins?.codex === "number" ? probeValue.pins.codex : null,
            total: typeof probeValue?.pins?.total === "number" ? probeValue.pins.total : null,
            work: typeof probeValue?.pins?.work === "number" ? probeValue.pins.work : null,
          },
          registeredMessages:
            typeof probeValue?.registeredMessages === "number"
              ? probeValue.registeredMessages
              : null,
          ready: probeValue?.ready === true,
          storage: typeof probeValue?.storage === "string" ? probeValue.storage : null,
          transports: {
            diagnosticsIpc: probeValue?.transports?.diagnosticsIpc === true,
            network: probeValue?.transports?.network === true,
          },
          version: typeof probeValue?.version === "string" ? probeValue.version : null,
        };
        pinboardProbe.contractPass = Boolean(
          pinboardProbe.summary.localOnly &&
            pinboardProbe.summary.ready &&
            pinboardProbe.summary.storage === "ready" &&
            pinboardProbe.summary.transports.network === false &&
            pinboardProbe.summary.transports.diagnosticsIpc === false &&
            Number.isInteger(pinboardProbe.summary.pins.total) &&
            pinboardProbe.summary.pins.total >= 0 &&
            Number.isInteger(pinboardProbe.summary.bridgeMessages.total) &&
            Number.isInteger(pinboardProbe.summary.bridgeMessages.associated) &&
            (pinboardProbe.summary.bridgeMessages.total === 0 ||
              pinboardProbe.summary.bridgeMessages.associated > 0) &&
            pinboardProbe.summary.registeredMessages >=
              pinboardProbe.summary.bridgeMessages.associated,
        );
      }
    } catch (error) {
      pinboardProbe.error = normalize(error?.message ?? error).slice(0, 200);
    }
  }

  const allControls = [
    ...document.querySelectorAll(
      'button, [role="button"], [role="menuitem"], [role="option"], [role="combobox"], select',
    ),
  ];
  const nativeControls = allControls.filter(
    (element) =>
      !element.closest(
        "#gpt-codex-custom-chat-sidebar, #gpt-codex-token-hud, #gpt-codex-token-hud-host, " +
          "#gpt-codex-pinboard-launcher, #gpt-codex-pinboard-drawer, " +
          "#gpt-codex-custom-token-hud, #gpt-codex-custom-token-usage, #gpt-codex-custom-pinboard",
      ),
  );
  const controlLabel = (element) =>
    normalize(
      [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-testid"),
        element.getAttribute("name"),
        element.textContent,
      ]
        .filter(Boolean)
        .join(" "),
    );
  const controlRules = {
    model: (element, label) =>
      /model/i.test(
        `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("data-testid") ?? ""}`,
      ) ||
      /^(Auto|GPT[-\s]?\d|o\d|Codex|Thinking|Reasoning)(?:\b|\s|$)/i.test(label),
    attach: (element, label) =>
      /attach|add (?:photos?|files?)|upload (?:a )?file|paperclip/i.test(label),
    tool: (element, label) =>
      /^(tools?|use a tool|search the web|create image)(?:\b|\s|$)/i.test(label) ||
      /tool/i.test(`${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("data-testid") ?? ""}`),
    dictation: (element, label) =>
      /dictat|voice input|microphone|start recording|record audio/i.test(label),
    copy: (_element, label) => /^copy(?: response| message| code| text)?$/i.test(label),
    regenerate: (_element, label) => /regenerate|try again/i.test(label),
    edit: (element, label) =>
      /^edit(?: message| image| response)?$/i.test(label) ||
      element.hasAttribute("data-gpt-codex-custom-image-edit"),
  };
  const capabilities = {};
  for (const [name, predicate] of Object.entries(controlRules)) {
    const matches = nativeControls.filter((element) => predicate(element, controlLabel(element)));
    capabilities[name] = {
      total: matches.length,
      visible: matches.filter(isVisible).length,
      enabled: matches.filter((element) => !isDisabled(element)).length,
    };
  }
  const fileInputs = document.querySelectorAll('input[type="file"]').length;
  capabilities.attach.fileInputs = fileInputs;
  capabilities.attach.total += fileInputs;
  const customImageEditControls = document.querySelectorAll(
    '[data-gpt-codex-custom-image-edit]',
  ).length;
  capabilities.edit.customImageEditControls = customImageEditControls;
  capabilities.edit.total += customImageEditControls;

  const imageBridge = globalThis.GPT_CODEX_CUSTOM_IMAGE_COMPOSER;
  const imagePipeline = {
    bridgePresent: Boolean(imageBridge && typeof imageBridge === "object"),
    stageImageReady: typeof imageBridge?.stageImage === "function",
    probeAvailable: typeof imageBridge?.probe === "function",
    probeSucceeded: false,
    probe: null,
    probeError: null,
    diagnosticState: root.getAttribute("data-gpt-codex-custom-image-edit") ?? "idle",
    generatedPreviewCount: document.querySelectorAll(
      'button[data-testid="generated-image-preview"]',
    ).length,
    editControlCount: customImageEditControls,
  };
  if (imagePipeline.probeAvailable) {
    try {
      const probeValue = imageBridge.probe();
      if (probeValue && typeof probeValue.then === "function") {
        imagePipeline.probeError = "Diagnostic probe returned a Promise; it was not awaited.";
      } else {
        imagePipeline.probeSucceeded = true;
        imagePipeline.probe = {
          attachmentCount:
            typeof probeValue?.attachmentCount === "number" ? probeValue.attachmentCount : null,
          conversationAvailable: Boolean(probeValue?.conversationId),
          selectedSystemHint:
            typeof probeValue?.selectedSystemHint === "string"
              ? probeValue.selectedSystemHint.slice(0, 80)
              : null,
          summary: safeProbeSummary(probeValue),
        };
      }
    } catch (error) {
      imagePipeline.probeError = normalize(error?.message ?? error).slice(0, 200);
    }
  }

  const imageDialogRules = [];
  const collectImageDialogRules = (rules) => {
    for (const rule of [...(rules ?? [])].slice(0, 2_000)) {
      if (
        typeof rule?.cssText === "string" &&
        rule.cssText.includes(".gpt-codex-custom-generated-image-dialog")
      ) {
        imageDialogRules.push(rule.cssText.slice(0, 500));
      }
      if (rule?.cssRules) collectImageDialogRules(rule.cssRules);
    }
  };
  for (const sheet of [...document.styleSheets].slice(0, 200)) {
    try {
      collectImageDialogRules(sheet.cssRules);
    } catch {
      // Cross-origin or restricted stylesheets are irrelevant to the packaged custom layer.
    }
  }
  imagePipeline.previewLayoutSafe = !imageDialogRules.some((cssText) =>
    /position\s*:\s*relative/i.test(cssText),
  );
  imagePipeline.customDialogRuleCount = imageDialogRules.length;

  const scrollProbe = {
    available: typeof globalThis.GPT_CODEX_CUSTOM_CHAT_SCROLL_PROBE === "function",
    succeeded: false,
    error: null,
    state: null,
  };
  if (scrollProbe.available) {
    try {
      let scrollState = globalThis.GPT_CODEX_CUSTOM_CHAT_SCROLL_PROBE();
      if (scrollState && typeof scrollState.then === "function") {
        scrollProbe.error = "Diagnostic probe returned a Promise; it was not awaited.";
      } else {
        const scrollDeadline = Date.now() + 2_500;
        while (scrollState?.state === "settling" && Date.now() < scrollDeadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 100));
          scrollState = globalThis.GPT_CODEX_CUSTOM_CHAT_SCROLL_PROBE();
        }
        scrollProbe.succeeded = true;
        scrollProbe.state = {
          atBottom: typeof scrollState?.atBottom === "boolean" ? scrollState.atBottom : null,
          available: scrollState?.available === true,
          conversationAvailable: Boolean(scrollState?.conversationId),
          initialScrollMode:
            typeof scrollState?.initialScrollMode === "string"
              ? scrollState.initialScrollMode.slice(0, 80)
              : null,
          state: typeof scrollState?.state === "string" ? scrollState.state.slice(0, 80) : null,
        };
      }
    } catch (error) {
      scrollProbe.error = normalize(error?.message ?? error).slice(0, 200);
    }
  }
  const scrollPositionPass = Boolean(
    scrollProbe.available &&
      scrollProbe.succeeded &&
      (!scrollProbe.state?.conversationAvailable ||
        scrollProbe.state?.initialScrollMode === "anchor-latest" ||
        scrollProbe.state?.atBottom === true),
  );

  const modelPicker = {
    probeAvailable: typeof globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE === "function",
    probeSucceeded: false,
    probeError: null,
    state: null,
  };
  if (modelPicker.probeAvailable) {
    try {
      let pickerState = globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE();
      if (pickerState && typeof pickerState.then === "function") {
        modelPicker.probeError = "Diagnostic probe returned a Promise; it was not awaited.";
      } else {
        const modelDeadline = Date.now() + 10_000;
        while (pickerState?.queryState === "loading" && Date.now() < modelDeadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 200));
          pickerState = globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE();
        }
        modelPicker.probeSucceeded = true;
        modelPicker.state = {
          activeMode:
            typeof pickerState?.activeMode === "string" ? pickerState.activeMode.slice(0, 20) : null,
          activeChatMode: pickerState?.activeChatMode === true,
          bridgeKind:
            typeof pickerState?.bridgeKind === "string" ? pickerState.bridgeKind.slice(0, 20) : null,
          bridgeReady: pickerState?.bridgeReady === true,
          fastAvailable: pickerState?.fastAvailable === true,
          fastEffective: pickerState?.fastEffective === true,
          fastEnabled: pickerState?.fastEnabled === true,
          fastPending: pickerState?.fastPending === true,
          fastSupported: pickerState?.fastSupported === true,
          fastToggleChecked: pickerState?.fastToggleChecked === true,
          fastTogglePresent: pickerState?.fastTogglePresent === true,
          composerAnchored: pickerState?.composerAnchored === true,
          customTriggerCount:
            typeof pickerState?.customTriggerCount === "number"
              ? pickerState.customTriggerCount
              : null,
          customTriggerVisibleCount:
            typeof pickerState?.customTriggerVisibleCount === "number"
              ? pickerState.customTriggerVisibleCount
              : null,
          domMountedInsideComposer: pickerState?.domMountedInsideComposer === true,
          mountedInsideComposer: pickerState?.mountedInsideComposer === true,
          nativeTriggerSuppressed: pickerState?.nativeTriggerSuppressed === true,
          visibleNativeTriggerCount:
            typeof pickerState?.visibleNativeTriggerCount === "number"
              ? pickerState.visibleNativeTriggerCount
              : null,
          motionReduced: pickerState?.motionReduced === true,
          motionState:
            typeof pickerState?.motionState === "string"
              ? pickerState.motionState.slice(0, 20)
              : null,
          placement:
            typeof pickerState?.placement === "string" ? pickerState.placement.slice(0, 20) : null,
          panelOpen: pickerState?.panelOpen === true,
          queryState:
            typeof pickerState?.queryState === "string" ? pickerState.queryState.slice(0, 80) : null,
          rowCount: typeof pickerState?.rowCount === "number" ? pickerState.rowCount : null,
          columnLabels: Array.isArray(pickerState?.columnLabels)
            ? pickerState.columnLabels.map((label) => normalize(label).slice(0, 40)).slice(0, 10)
            : [],
          highSelectable: pickerState?.highSelectable === true,
          selectedColumn:
            typeof pickerState?.selectedColumn === "string"
              ? pickerState.selectedColumn.slice(0, 80)
              : null,
          selectedExactMatch: pickerState?.selectedExactMatch === true,
          supportedIntersectionCount:
            typeof pickerState?.supportedIntersectionCount === "number"
              ? pickerState.supportedIntersectionCount
              : null,
          ultraAvailable: pickerState?.ultraAvailable === true,
          ultraEngaged: pickerState?.ultraEngaged === true,
          ultraParticleAnimationCount:
            typeof pickerState?.ultraParticleAnimationCount === "number"
              ? pickerState.ultraParticleAnimationCount
              : null,
          ultraParticleCount:
            typeof pickerState?.ultraParticleCount === "number"
              ? pickerState.ultraParticleCount
              : null,
        };
      }
    } catch (error) {
      modelPicker.probeError = normalize(error?.message ?? error).slice(0, 200);
    }
  }
  modelPicker.contractPass = Boolean(
    modelPicker.probeAvailable &&
      modelPicker.probeSucceeded &&
      ["chat", "work", "codex"].includes(modelPicker.state?.activeMode) &&
      modelPicker.state?.bridgeReady &&
      modelPicker.state?.mountedInsideComposer &&
      modelPicker.state?.customTriggerCount === 1 &&
      modelPicker.state?.customTriggerVisibleCount === 1 &&
      (modelPicker.state?.activeMode === "chat"
        ? modelPicker.state?.domMountedInsideComposer && modelPicker.state?.placement === "inline"
        : modelPicker.state?.composerAnchored && modelPicker.state?.placement === "fixed") &&
      modelPicker.state?.nativeTriggerSuppressed &&
      modelPicker.state?.visibleNativeTriggerCount === 0 &&
      modelPicker.state?.fastTogglePresent &&
      (modelPicker.state?.activeMode === "chat" || modelPicker.state?.fastSupported) &&
      modelPicker.state?.ultraParticleCount === 12 &&
      modelPicker.state?.queryState === "ready" &&
      modelPicker.state?.rowCount > 0 &&
      modelPicker.state?.highSelectable &&
      modelPicker.state?.supportedIntersectionCount > 0 &&
      typeof modelPicker.state?.motionReduced === "boolean" &&
      (modelPicker.state?.panelOpen
        ? ["opening", "open"].includes(modelPicker.state?.motionState)
        : ["closed", "closing"].includes(modelPicker.state?.motionState)),
  );
  modelPicker.replacementPass = Boolean(
    modelPicker.state?.nativeTriggerSuppressed &&
      modelPicker.state?.visibleNativeTriggerCount === 0 &&
      modelPicker.state?.customTriggerCount === 1 &&
      modelPicker.state?.customTriggerVisibleCount === 1 &&
      modelPicker.state?.fastTogglePresent &&
      modelPicker.state?.ultraParticleCount === 12 &&
      (modelPicker.state?.activeMode === "chat" || modelPicker.state?.fastSupported),
  );

  const composer =
    (chatSurface
      ? [...chatSurface.querySelectorAll("form")].find((form) =>
          form.querySelector('textarea, [contenteditable="true"], [role="textbox"]'),
        )
      : null) ??
    document
      .querySelector('[data-gpt-codex-model-picker-native-slot="true"]')
      ?.closest("form, .composer-surface-chrome") ??
    document
      .getElementById("gpt-codex-custom-model-picker")
      ?.closest("form, .composer-surface-chrome") ??
    null;
  const modelPickerPanelElement = document.getElementById(
    "gpt-codex-custom-model-picker-panel",
  );
  const geometryIssues = [];
  if (tokenHost?.dataset.overlapSafe === "false") {
    geometryIssues.push({ type: "token-hud-overlap-contract", element: "tokenHud" });
  }
  if (tokenHost && tokenHost.dataset.dock !== "right") {
    geometryIssues.push({ type: "token-hud-dock-contract", element: "tokenHud" });
  }
  const intersection = (left, right) => {
    if (!left || !right) return null;
    const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
    const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
    const area = width * height;
    const minimumArea = Math.min(left.width * left.height, right.width * right.height);
    return {
      area,
      height,
      ratio: minimumArea > 0 ? area / minimumArea : 0,
      width,
    };
  };
  const rectIncludingHidden = (element) => {
    if (!element) return null;
    if (isVisible(element)) return rectOf(element);
    const hadHiddenAttribute = element.hasAttribute("hidden");
    const previousStyle = element.getAttribute("style");
    try {
      element.hidden = false;
      element.style.visibility = "hidden";
      element.style.pointerEvents = "none";
      return rectOf(element);
    } finally {
      if (previousStyle == null) element.removeAttribute("style");
      else element.setAttribute("style", previousStyle);
      if (hadHiddenAttribute) element.setAttribute("hidden", "");
      else element.removeAttribute("hidden");
    }
  };
  const geometryElements = {
    sidebar,
    chatSurface,
    tokenHud,
    pinboard: pinboardToggle,
    pinboardDrawer: pinboard,
    modeTrigger,
    composer,
    modelPickerPanel: modelPickerPanelElement,
  };
  const geometryRects = {};
  for (const [name, element] of Object.entries(geometryElements)) {
    geometryRects[name] =
      name === "pinboardDrawer"
        ? rectIncludingHidden(element)
        : isVisible(element)
          ? rectOf(element)
          : null;
  }
  const tokenRightEdgeGap = geometryRects.tokenHud
    ? round(innerWidth - geometryRects.tokenHud.right)
    : null;
  if (tokenRightEdgeGap != null && Math.abs(tokenRightEdgeGap - 14) > 3) {
    geometryIssues.push({
      type: "token-hud-right-edge-gap",
      element: "tokenHud",
      expected: 14,
      actual: tokenRightEdgeGap,
    });
  }
  const tokenRightDockPass = Boolean(
    tokenHost?.dataset.dock === "right" &&
      geometryRects.tokenHud &&
      tokenRightEdgeGap != null &&
      Math.abs(tokenRightEdgeGap - 14) <= 3,
  );
  const checkOverlap = (leftName, rightName, threshold = 0.2) => {
    const leftElement = geometryElements[leftName];
    const rightElement = geometryElements[rightName];
    const leftRect = geometryRects[leftName];
    const rightRect = geometryRects[rightName];
    if (!leftElement || !rightElement || !leftRect || !rightRect) return;
    if (leftElement.contains(rightElement) || rightElement.contains(leftElement)) return;
    const overlap = intersection(leftRect, rightRect);
    if (overlap && overlap.width >= 8 && overlap.height >= 8 && overlap.ratio >= threshold) {
      geometryIssues.push({
        type: "landmark-overlap",
        left: leftName,
        right: rightName,
        ratio: round(overlap.ratio),
      });
    }
  };
  checkOverlap("sidebar", "chatSurface", 0.02);
  checkOverlap("sidebar", "tokenHud");
  checkOverlap("sidebar", "pinboard");
  checkOverlap("tokenHud", "pinboard");
  checkOverlap("tokenHud", "composer");
  checkOverlap("pinboard", "composer");
  checkOverlap("tokenHud", "modeTrigger");
  checkOverlap("pinboard", "modeTrigger");
  checkOverlap("tokenHud", "modelPickerPanel", 0.02);
  checkOverlap("pinboard", "modelPickerPanel", 0.02);

  for (const name of ["sidebar", "tokenHud", "pinboard", "pinboardDrawer", "modelPickerPanel"]) {
    const rect = geometryRects[name];
    if (!rect) continue;
    const clipped =
      rect.left < -2 || rect.top < -2 || rect.right > innerWidth + 2 || rect.bottom > innerHeight + 2;
    if (clipped) geometryIssues.push({ type: "viewport-clipping", element: name });
  }

  const customControlRoots = [
    sidebar,
    tokenHud,
    pinboardToggle,
    pinboard,
    modelPickerPanelElement,
  ].filter(Boolean);
  const customControls = [
    ...new Set(
      customControlRoots.flatMap((featureRoot) => {
        const controls = [
          ...featureRoot.querySelectorAll('button, [role="button"], input, select, textarea'),
        ];
        if (featureRoot.matches('button, [role="button"], input, select, textarea')) {
          controls.unshift(featureRoot);
        }
        return controls;
      }),
    ),
  ].filter(isVisible);
  for (let leftIndex = 0; leftIndex < customControls.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < customControls.length; rightIndex += 1) {
      const leftControl = customControls[leftIndex];
      const rightControl = customControls[rightIndex];
      if (leftControl.contains(rightControl) || rightControl.contains(leftControl)) continue;
      const overlap = intersection(
        clippedRectOf(leftControl),
        clippedRectOf(rightControl),
      );
      if (overlap && overlap.width >= 6 && overlap.height >= 6 && overlap.ratio >= 0.35) {
        geometryIssues.push({
          type: "custom-control-overlap",
          left: elementMarker(leftControl).slice(0, 100),
          right: elementMarker(rightControl).slice(0, 100),
          ratio: round(overlap.ratio),
        });
      }
    }
  }

  let startupModeContract = {
    available: false,
    pass: false,
    schemaVersion: null,
    freshModeDecisionPass: false,
    cases: [],
    errorName: null,
  };
  try {
    const startupContractProbe = globalThis.GPT_CODEX_CUSTOM_RENDERER_CONTRACT_SELF_TEST;
    if (typeof startupContractProbe === "function") {
      const contractResult = startupContractProbe();
      const rawCases = Array.isArray(contractResult?.freshModeDecision?.cases)
        ? contractResult.freshModeDecision.cases
        : [];
      const cases = rawCases.map((testCase) => ({
        name: typeof testCase?.name === "string" ? testCase.name : null,
        pass: testCase?.pass === true,
        actual: {
          autoOpenProductMenu:
            typeof testCase?.actual?.autoOpenProductMenu === "boolean"
              ? testCase.actual.autoOpenProductMenu
              : null,
          chatMode:
            typeof testCase?.actual?.chatMode === "boolean"
              ? testCase.actual.chatMode
              : null,
        },
      }));
      const requiredCases = [
        { name: "fresh-profile-starts-in-chat", chatMode: true },
        { name: "stored-chat-is-honored", chatMode: true },
        { name: "stored-native-is-honored", chatMode: false },
      ];
      const requiredCasesPass = requiredCases.every((requiredCase) => {
        const observed = cases.find((testCase) => testCase.name === requiredCase.name);
        return observed?.pass === true && observed.actual.chatMode === requiredCase.chatMode;
      });
      startupModeContract = {
        available: true,
        pass:
          Number(contractResult?.schemaVersion) >= 1 &&
          contractResult?.freshModeDecision?.pass === true &&
          requiredCasesPass,
        schemaVersion: Number(contractResult?.schemaVersion) || null,
        freshModeDecisionPass: contractResult?.freshModeDecision?.pass === true,
        cases,
        errorName: null,
      };
    }
  } catch (error) {
    startupModeContract = {
      ...startupModeContract,
      errorName: error?.name ? String(error.name) : "Error",
    };
  }

  return {
    url: location.href,
    documentReadyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    customBuild: {
      rootMarker: root.getAttribute("data-gpt-codex-custom"),
      descriptorPresent: Boolean(customBuild && typeof customBuild === "object"),
      name: typeof customBuild?.name === "string" ? customBuild.name : null,
      featureCount: Array.isArray(customBuild?.features) ? customBuild.features.length : 0,
      pass:
        root.getAttribute("data-gpt-codex-custom") === "ready" &&
          Boolean(customBuild && typeof customBuild === "object"),
    },
    startupModeContract,
    chat: {
      mode: chatMode,
      auxiliaryView,
      surfacePresent: Boolean(chatSurface),
      surfaceVisible: isVisible(chatSurface),
      surfaceState: root.getAttribute("data-gpt-codex-custom-chat-surface"),
      sidebarPresent: Boolean(sidebar),
      sidebarVisible: isVisible(sidebar),
      promotedPass: Boolean(
        chatMode &&
          !auxiliaryView &&
          chatSurface &&
          isVisible(chatSurface) &&
          sidebar &&
          isVisible(sidebar),
      ),
      scroll: {
        ...scrollProbe,
        positionPass: scrollPositionPass,
      },
    },
    navigation: {
      labels: navLabels,
      structurePass: ["New chat", "Search chats"].every((label) => navLabels.includes(label)),
      history: {
        containerPresent: Boolean(historyContainer),
        containerVisible: isVisible(historyContainer),
        rowCount: historyRows,
        sections: historySections,
        pass: Boolean(historyContainer && isVisible(historyContainer) && historyRows > 0),
      },
      newChat: {
        present: Boolean(newChatControl),
        visible: isVisible(newChatControl),
        enabled: Boolean(newChatControl && !isDisabled(newChatControl)),
        pass: Boolean(newChatControl && isVisible(newChatControl) && !isDisabled(newChatControl)),
      },
      conversationActions: {
        triggerCount: conversationMenuControls.length,
        enabledCount: enabledConversationMenuControls.length,
        visibleCount: visibleConversationMenuControls.length,
        requiredMethods: requiredChatActionMethods,
        availableMethods: availableChatActionMethods,
        nativeBridgeReady: nativeChatManagementReady,
        pass: Boolean(
          nativeChatManagementReady &&
            conversationMenuControls.length > 0 &&
            enabledConversationMenuControls.length > 0 &&
            visibleConversationMenuControls.length > 0,
        ),
      },
      search: {
        controlPresent: Boolean(searchControl),
        controlVisible: isVisible(searchControl),
        controlEnabled: Boolean(searchControl && !isDisabled(searchControl)),
        panelPresent: Boolean(searchPanel),
        panelOpen: Boolean(searchPanel && !searchPanel.hidden && isVisible(searchPanel)),
        inputPresent: Boolean(searchInput),
        pass: Boolean(
          searchControl &&
            isVisible(searchControl) &&
            !isDisabled(searchControl) &&
            searchPanel &&
            searchInput &&
            nativeSearchReady,
        ),
        nativeBridgeReady: nativeSearchReady,
      },
    },
    modeSelector: {
      triggerPresent: Boolean(modeTrigger),
      triggerVisible: isVisible(modeTrigger),
      menuPresent: Boolean(modeMenu),
      menuOpen: Boolean(modeMenu && !modeMenu.hidden && isVisible(modeMenu)),
      options: modeOptions,
      pass: Boolean(
        modeTrigger &&
          isVisible(modeTrigger) &&
          modeTrigger.getAttribute("aria-haspopup") === "menu" &&
          modeMenu &&
          ["chat", "work", "codex"].every((mode) => modeNames.includes(mode)),
      ),
    },
    tokenHud: {
      present: Boolean(tokenHud),
      visible: isVisible(tokenHud),
      hostPresent: Boolean(tokenHost),
      hostDock: tokenHost?.dataset.dock ?? null,
      hostOverlapSafe: tokenHost?.dataset.overlapSafe !== "false",
      hostPlacement: tokenHost?.dataset.placement ?? null,
      rightDockPass: tokenRightDockPass,
      rightEdgeGap: tokenRightEdgeGap,
      marker: tokenHud ? elementMarker(tokenHud).slice(0, 160) : null,
      state: tokenState,
      structurePass: tokenStructurePass,
      precisionPass: tokenPrecisionPass,
      probe: tokenProbe,
      contractSelfTest: tokenContractSelfTest,
      metricElementCount: tokenMetricElements,
      metricCount: tokenMetrics.length,
      metrics: tokenMetrics.slice(0, 30),
      telemetryAvailable: hasTokenTelemetry,
      unavailableState: tokenUnavailableState,
      usedTokens,
      tokenLimit,
      displayedPercent,
      expectedPercent: expectedPercent == null ? null : round(expectedPercent),
      percentageError: percentageError == null ? null : round(percentageError),
      percentageTolerance,
      percentageConsistent,
      finiteMetrics: finiteTokenMetrics,
      integralCountMetrics: integralTokenMetrics,
      inputFullPrecision,
      outputFullPrecision,
      thinkingFullPrecision,
      displayPrecisionMatches,
      totalConsistency,
      qualityValuesValid,
      modeMatchesSurface: !chatMode || probedTokenState?.mode === "chat",
    },
    pinboard: {
      present: Boolean(pinboard),
      visible: isVisible(pinboard),
      marker: pinboard ? elementMarker(pinboard).slice(0, 160) : null,
      togglePresent: Boolean(pinboardToggle),
      toggleVisible: isVisible(pinboardToggle),
      drawerOpen: Boolean(pinboard && !pinboard.hidden && isVisible(pinboard)),
      listPresent: Boolean(pinboardList),
      itemCount: pinboardItems,
      structurePass: pinboardStructurePass,
      probe: pinboardProbe,
    },
    capabilities,
    imagePipeline,
    modelPicker,
    geometry: {
      pass: geometryIssues.length === 0,
      issueCount: geometryIssues.length,
      issues: geometryIssues.slice(0, 40),
      rects: geometryRects,
      visibleCustomControlCount: customControls.length,
    },
    contract: {
      targetUrlExact: location.href === EXPECTED_URL,
      readOnly: true,
      actionsInvoked: [],
      probesInvoked: [
        tokenProbe.available ? tokenProbe.name : null,
        pinboardProbe.available ? pinboardProbe.name : null,
        imagePipeline.probeAvailable ? "GPT_CODEX_CUSTOM_IMAGE_COMPOSER.probe" : null,
        scrollProbe.available ? "GPT_CODEX_CUSTOM_CHAT_SCROLL_PROBE" : null,
        modelPicker.probeAvailable ? "GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE" : null,
        startupModeContract.available
          ? "GPT_CODEX_CUSTOM_RENDERER_CONTRACT_SELF_TEST"
          : null,
      ].filter(Boolean),
    },
  };
})()
'@

function New-VerificationReport {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Snapshot,

        [Parameter(Mandatory = $true)]
        [object]$Target,

        [Parameter(Mandatory = $true)]
        [int]$DebugPort
    )

    $checks = New-Object System.Collections.ArrayList

    $contract = Get-ObjectPropertyValue -InputObject $Snapshot -Name "contract"
    $customBuild = Get-ObjectPropertyValue -InputObject $Snapshot -Name "customBuild"
    $startupModeContract = Get-ObjectPropertyValue -InputObject $Snapshot -Name "startupModeContract"
    $chat = Get-ObjectPropertyValue -InputObject $Snapshot -Name "chat"
    $chatScroll = Get-ObjectPropertyValue -InputObject $chat -Name "scroll"
    $navigation = Get-ObjectPropertyValue -InputObject $Snapshot -Name "navigation"
    $history = Get-ObjectPropertyValue -InputObject $navigation -Name "history"
    $newChat = Get-ObjectPropertyValue -InputObject $navigation -Name "newChat"
    $conversationActions = Get-ObjectPropertyValue -InputObject $navigation -Name "conversationActions"
    $search = Get-ObjectPropertyValue -InputObject $navigation -Name "search"
    $modeSelector = Get-ObjectPropertyValue -InputObject $Snapshot -Name "modeSelector"
    $tokenHud = Get-ObjectPropertyValue -InputObject $Snapshot -Name "tokenHud"
    $pinboard = Get-ObjectPropertyValue -InputObject $Snapshot -Name "pinboard"
    $pinboardProbe = Get-ObjectPropertyValue -InputObject $pinboard -Name "probe"
    $geometry = Get-ObjectPropertyValue -InputObject $Snapshot -Name "geometry"
    $capabilities = Get-ObjectPropertyValue -InputObject $Snapshot -Name "capabilities"
    $imagePipeline = Get-ObjectPropertyValue -InputObject $Snapshot -Name "imagePipeline"
    $modelPicker = Get-ObjectPropertyValue -InputObject $Snapshot -Name "modelPicker"

    Add-RequiredVerificationCheck -List $checks -Name "target.exactAppRenderer" -Category "Harness safety" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $contract -Name "targetUrlExact" -Default $false)) `
        -PassedDetail "Attached to the exact app://-/index.html renderer." `
        -FailedDetail "The evaluated renderer URL was not exactly app://-/index.html." `
        -Evidence ([PSCustomObject]@{ url = Get-ObjectPropertyValue -InputObject $Snapshot -Name "url" })

    Add-RequiredVerificationCheck -List $checks -Name "custom.buildMarker" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $customBuild -Name "pass" -Default $false)) `
        -PassedDetail "The custom root marker and build descriptor are present." `
        -FailedDetail "The custom root marker or build descriptor is missing." `
        -Evidence $customBuild

    Add-RequiredVerificationCheck -List $checks -Name "modeStartup.rendererContract" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $startupModeContract -Name "pass" -Default $false)) `
        -PassedDetail "The pure renderer contract proves fresh profiles resolve to Chat and stored Chat/native selections are honored." `
        -FailedDetail "The renderer startup-mode probe is unavailable or does not prove fresh Chat plus stored Chat/native behavior." `
        -Evidence $startupModeContract

    Add-RequiredVerificationCheck -List $checks -Name "chat.promotedSurface" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $chat -Name "promotedPass" -Default $false)) `
        -PassedDetail "Chat mode, the promoted native surface, and the custom rail are visible." `
        -FailedDetail "Select Chat and return to New chat or a conversation so the promoted surface and rail are visible." `
        -Evidence $chat

    Add-RequiredVerificationCheck -List $checks -Name "chat.initialScrollPosition" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $chatScroll -Name "positionPass" -Default $false)) `
        -PassedDetail "The saved-chat scroll probe is available and the initial conversation position is settled at the latest message." `
        -FailedDetail "The saved-chat scroll probe is missing, still settling, or the active conversation opened away from its latest message." `
        -Evidence $chatScroll

    Add-RequiredVerificationCheck -List $checks -Name "chat.navigationStructure" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $navigation -Name "structurePass" -Default $false)) `
        -PassedDetail "The promoted Chat navigation contains its required controls." `
        -FailedDetail "The promoted Chat navigation is missing required custom controls." `
        -Evidence ([PSCustomObject]@{ labels = Get-ObjectPropertyValue -InputObject $navigation -Name "labels" })

    Add-RequiredVerificationCheck -List $checks -Name "chat.historyContainer" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $history -Name "pass" -Default $false)) `
        -PassedDetail "The custom history container is visible and contains account-backed rows." `
        -FailedDetail "The custom history container is absent, hidden, or contains no account-backed rows." `
        -Evidence $history

    Add-RequiredVerificationCheck -List $checks -Name "chat.newChatControl" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $newChat -Name "pass" -Default $false)) `
        -PassedDetail "New chat is present, visible, and enabled." `
        -FailedDetail "The custom New chat control is absent, hidden, or disabled." `
        -Evidence $newChat

    Add-RequiredVerificationCheck -List $checks -Name "chat.conversationActions" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $conversationActions -Name "pass" -Default $false)) `
        -PassedDetail "Saved chats expose a visible, enabled actions menu backed by all five native management methods." `
        -FailedDetail "The saved-chat actions control is hidden, disabled, or missing one of its native management methods." `
        -Evidence $conversationActions

    Add-RequiredVerificationCheck -List $checks -Name "chat.searchControl" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $search -Name "pass" -Default $false)) `
        -PassedDetail "Search chats and its input structure are present without opening it." `
        -FailedDetail "The custom search control or its input structure is missing." `
        -Evidence $search

    Add-RequiredVerificationCheck -List $checks -Name "tokenHud.structure" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $tokenHud -Name "structurePass" -Default $false)) `
        -PassedDetail "The token HUD exposes recognizable custom structure and telemetry or a defined state." `
        -FailedDetail "The token HUD custom structure was not found." `
        -Evidence $tokenHud

    Add-RequiredVerificationCheck -List $checks -Name "tokenHud.rightDock" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $tokenHud -Name "rightDockPass" -Default $false)) `
        -PassedDetail "The token HUD is visible on its dedicated 14px right-edge dock." `
        -FailedDetail "The token HUD is missing from or displaced away from its right-edge dock." `
        -Evidence $tokenHud

    Add-RequiredVerificationCheck -List $checks -Name "tokenHud.precision" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $tokenHud -Name "precisionPass" -Default $false)) `
        -PassedDetail "The read-only token probe, exact accessible values, quality labels, and aggregate arithmetic agree." `
        -FailedDetail "Token telemetry lacks a valid unavailable state or has imprecise/inconsistent probe and display data." `
        -Evidence $tokenHud

    Add-RequiredVerificationCheck -List $checks -Name "pinboard.structure" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $pinboard -Name "structurePass" -Default $false)) `
        -PassedDetail "The pinboard exposes its custom container, control, and content structure." `
        -FailedDetail "The pinboard custom structure was not found or is incomplete." `
        -Evidence ([PSCustomObject]@{
            present = Get-ObjectPropertyValue -InputObject $pinboard -Name "present"
            visible = Get-ObjectPropertyValue -InputObject $pinboard -Name "visible"
            togglePresent = Get-ObjectPropertyValue -InputObject $pinboard -Name "togglePresent"
            listPresent = Get-ObjectPropertyValue -InputObject $pinboard -Name "listPresent"
            itemCount = Get-ObjectPropertyValue -InputObject $pinboard -Name "itemCount"
            marker = Get-ObjectPropertyValue -InputObject $pinboard -Name "marker"
        })

    Add-RequiredVerificationCheck -List $checks -Name "pinboard.probe" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $pinboardProbe -Name "contractPass" -Default $false)) `
        -PassedDetail "The read-only pinboard probe returned synchronously and confirms local-only, no-network state." `
        -FailedDetail "The pinboard probe is absent/broken or does not confirm its local-only transport contract." `
        -Evidence $pinboardProbe

    Add-RequiredVerificationCheck -List $checks -Name "modeSelector.structure" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $modeSelector -Name "pass" -Default $false)) `
        -PassedDetail "The persistent Chat/Work/Codex mode selector structure is present." `
        -FailedDetail "The persistent mode selector, menu, or one of its three options is missing." `
        -Evidence $modeSelector

    Add-RequiredVerificationCheck -List $checks -Name "modelPicker.accountBackedMatrix" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $modelPicker -Name "contractPass" -Default $false)) `
        -PassedDetail "The composer model matrix is mounted, account-backed, populated, and wired through the native selector." `
        -FailedDetail "The active Chat/Work/Codex model matrix is absent, loading/unavailable, empty, missing High, or disconnected from the native selector." `
        -Evidence $modelPicker

    Add-RequiredVerificationCheck -List $checks -Name "modelPicker.replacesNativeAndEffects" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $modelPicker -Name "replacementPass" -Default $false)) `
        -PassedDetail "Only the custom picker is visible; its Fast control and deterministic Ultra particle field are mounted." `
        -FailedDetail "A shipped picker remains visible, or the custom Fast/Ultra effect structure is incomplete." `
        -Evidence $modelPicker

    $geometryIssues = @(Get-ObjectPropertyValue -InputObject $geometry -Name "issues" -Default @())
    Add-RequiredVerificationCheck -List $checks -Name "geometry.noObviousOverlap" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $geometry -Name "pass" -Default $false)) `
        -PassedDetail "No obvious custom landmark, control, composer, or viewport collision was detected." `
        -FailedDetail "One or more obvious geometry collisions were detected." `
        -Evidence ([PSCustomObject]@{
            issueCount = Get-ObjectPropertyValue -InputObject $geometry -Name "issueCount"
            issues = $geometryIssues
            rects = Get-ObjectPropertyValue -InputObject $geometry -Name "rects"
        })

    Add-NativeObservation -List $checks -Name "native.accountHistoryRows" `
        -Available ([int](Get-ObjectPropertyValue -InputObject $history -Name "rowCount" -Default 0) -gt 0) `
        -ObservedDetail "Account-backed history rows are present." `
        -UnavailableDetail "No account-backed history rows are currently exposed; this is account/state dependent." `
        -Evidence $history

    foreach ($capabilityName in @("model", "attach", "tool", "dictation", "copy", "regenerate", "edit")) {
        $capability = Get-ObjectPropertyValue -InputObject $capabilities -Name $capabilityName
        $count = [int](Get-ObjectPropertyValue -InputObject $capability -Name "total" -Default 0)
        Add-NativeObservation -List $checks -Name "native.$($capabilityName)Control" `
            -Available ($count -gt 0) `
            -ObservedDetail "$capabilityName control(s) are present in the current native surface." `
            -UnavailableDetail "$capabilityName controls are not present in this account, flag, route, or conversation state." `
            -Evidence $capability
    }

    $modeOptions = @(Get-ObjectPropertyValue -InputObject $modeSelector -Name "options" -Default @())
    $nativeModeReady = $false
    if ($modeOptions.Count -gt 0) {
        $workReady = @($modeOptions | Where-Object {
            (Get-ObjectPropertyValue -InputObject $_ -Name "mode") -eq "work" -and
            (Get-ObjectPropertyValue -InputObject $_ -Name "nativeBridgeReady") -eq "true"
        }).Count -gt 0
        $codexReady = @($modeOptions | Where-Object {
            (Get-ObjectPropertyValue -InputObject $_ -Name "mode") -eq "codex" -and
            (Get-ObjectPropertyValue -InputObject $_ -Name "nativeBridgeReady") -eq "true"
        }).Count -gt 0
        $nativeModeReady = $workReady -and $codexReady
    }
    Add-NativeObservation -List $checks -Name "native.modeCallbacks" -Available $nativeModeReady `
        -ObservedDetail "Native Work and Codex mode callbacks are bridged." `
        -UnavailableDetail "One or both native mode callbacks are not currently bridged." `
        -Evidence $modeOptions

    $imagePipelineAvailable =
        [bool](Get-ObjectPropertyValue -InputObject $imagePipeline -Name "stageImageReady" -Default $false) -or
        [int](Get-ObjectPropertyValue -InputObject $imagePipeline -Name "editControlCount" -Default 0) -gt 0 -or
        [bool](Get-ObjectPropertyValue -InputObject $imagePipeline -Name "probeSucceeded" -Default $false)
    Add-NativeObservation -List $checks -Name "native.imagePipeline" -Available $imagePipelineAvailable `
        -ObservedDetail "The image-edit pipeline exposes a bridge, diagnostic state, probe, or generated-image control." `
        -UnavailableDetail "The image-edit pipeline is not active in the current account/conversation state." `
        -Evidence $imagePipeline

    Add-RequiredVerificationCheck -List $checks -Name "image.previewLayout" -Category "Custom contract" `
        -Passed ([bool](Get-ObjectPropertyValue -InputObject $imagePipeline -Name "previewLayoutSafe" -Default $false)) `
        -PassedDetail "The custom image controls preserve the native fixed full-screen preview layout." `
        -FailedDetail "A custom generated-image dialog rule still overrides the native preview geometry." `
        -Evidence ([PSCustomObject]@{
            previewLayoutSafe = Get-ObjectPropertyValue -InputObject $imagePipeline -Name "previewLayoutSafe"
            customDialogRuleCount = Get-ObjectPropertyValue -InputObject $imagePipeline -Name "customDialogRuleCount"
        })

    Add-NativeObservation -List $checks -Name "native.pinboardItems" `
        -Available ([int](Get-ObjectPropertyValue -InputObject $pinboard -Name "itemCount" -Default 0) -gt 0) `
        -ObservedDetail "The current pinboard contains item structure." `
        -UnavailableDetail "The current pinboard has no items; an empty pinboard is non-fatal." `
        -Evidence ([PSCustomObject]@{
            itemCount = Get-ObjectPropertyValue -InputObject $pinboard -Name "itemCount"
        })

    Add-NativeObservation -List $checks -Name "native.tokenTelemetry" `
        -Available ([bool](Get-ObjectPropertyValue -InputObject $tokenHud -Name "telemetryAvailable" -Default $false)) `
        -ObservedDetail "Live token telemetry is available to the HUD." `
        -UnavailableDetail "Live token telemetry is not available in the current mode/thread; the HUD state remains contractual." `
        -Evidence ([PSCustomObject]@{
            state = Get-ObjectPropertyValue -InputObject $tokenHud -Name "state"
            unavailableState = Get-ObjectPropertyValue -InputObject $tokenHud -Name "unavailableState"
            metricCount = Get-ObjectPropertyValue -InputObject $tokenHud -Name "metricCount"
        })

    $checkArray = @($checks.ToArray())
    $requiredChecks = @($checkArray | Where-Object { $_.required })
    $requiredFailures = @($requiredChecks | Where-Object { $_.status -ne "Passed" })
    $nativeObservations = @($checkArray | Where-Object { -not $_.required })

    return [PSCustomObject][ordered]@{
        schemaVersion = 1
        verifier = "Verify-Custom-Interactive.ps1"
        generatedAtUtc = [DateTime]::UtcNow.ToString("o")
        target = [PSCustomObject][ordered]@{
            url = $ExpectedTargetUrl
            type = Get-ObjectPropertyValue -InputObject $Target -Name "type"
            debuggerPort = $DebugPort
            devToolsActivePortPath = $DevToolsActivePortPath
        }
        readOnlyContract = [PSCustomObject][ordered]@{
            passed = [bool](Get-ObjectPropertyValue -InputObject $contract -Name "readOnly" -Default $false)
            actionsInvoked = @(Get-ObjectPropertyValue -InputObject $contract -Name "actionsInvoked" -Default @())
            diagnosticProbesInvoked = @(
                Get-ObjectPropertyValue -InputObject $contract -Name "probesInvoked" -Default @()
            )
            prohibitedActions = @(
                "message-send",
                "file-upload",
                "regenerate",
                "dictation-or-microphone",
                "control-click-or-dispatch"
            )
        }
        summary = [PSCustomObject][ordered]@{
            requiredPassed = ($requiredFailures.Count -eq 0)
            requiredCount = $requiredChecks.Count
            requiredFailed = $requiredFailures.Count
            nativeObserved = @($nativeObservations | Where-Object { $_.status -eq "Observed" }).Count
            nativeUnavailable = @($nativeObservations | Where-Object { $_.status -eq "Unavailable" }).Count
        }
        checks = $checkArray
        diagnostics = [PSCustomObject][ordered]@{
            documentReadyState = Get-ObjectPropertyValue -InputObject $Snapshot -Name "documentReadyState"
            viewport = Get-ObjectPropertyValue -InputObject $Snapshot -Name "viewport"
            imagePipeline = $imagePipeline
            modelPicker = $modelPicker
            tokenHud = $tokenHud
            pinboardProbe = $pinboardProbe
            geometry = $geometry
        }
    }
}

function Write-VerificationReport {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Report,

        [Parameter(Mandatory = $true)]
        [ValidateSet("Table", "Json", "Both")]
        [string]$Format
    )

    if ($Format -in @("Table", "Both")) {
        $tableRows = @(
            foreach ($check in @(Get-ObjectPropertyValue -InputObject $Report -Name "checks" -Default @())) {
                [PSCustomObject]@{
                    Check = Get-ObjectPropertyValue -InputObject $check -Name "name"
                    Category = Get-ObjectPropertyValue -InputObject $check -Name "category"
                    Required = Get-ObjectPropertyValue -InputObject $check -Name "required"
                    Status = Get-ObjectPropertyValue -InputObject $check -Name "status"
                    Detail = Get-ObjectPropertyValue -InputObject $check -Name "detail"
                }
            }
        )
        if ($tableRows.Count -gt 0) {
            $tableText = $tableRows | Format-Table -AutoSize -Wrap | Out-String -Width 260
            Write-Host $tableText.TrimEnd()
        }
    }

    if ($Format -in @("Json", "Both")) {
        $Report | ConvertTo-Json -Depth 16
    }
}

function New-OperationalErrorReport {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $errorCheck = [PSCustomObject][ordered]@{
        name = "harness.operational"
        category = "Harness"
        required = $false
        status = "Error"
        detail = $Message
        evidence = $null
    }

    return [PSCustomObject][ordered]@{
        schemaVersion = 1
        verifier = "Verify-Custom-Interactive.ps1"
        generatedAtUtc = [DateTime]::UtcNow.ToString("o")
        target = [PSCustomObject][ordered]@{
            url = $ExpectedTargetUrl
            devToolsActivePortPath = $DevToolsActivePortPath
        }
        readOnlyContract = [PSCustomObject][ordered]@{
            passed = $true
            actionsInvoked = @()
            diagnosticProbesInvoked = @()
        }
        summary = [PSCustomObject][ordered]@{
            requiredPassed = $false
            requiredCount = 0
            requiredFailed = 0
            nativeObserved = 0
            nativeUnavailable = 0
            operationalError = $true
        }
        checks = @($errorCheck)
        diagnostics = $null
    }
}

$exitCode = 0
$report = $null
$socket = $null

try {
    Assert-IsolatedDevToolsPortPath -Path $DevToolsActivePortPath
    $debugPort = Get-DebugPort -Path $DevToolsActivePortPath
    $target = Get-ExactRendererTarget -DebugPort $debugPort -WaitSeconds $TargetWaitSeconds

    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    $socket.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(10)
    $connectCancellation = [System.Threading.CancellationTokenSource]::new()
    $connectCancellation.CancelAfter([TimeSpan]::FromSeconds($TimeoutSeconds))
    try {
        $socket.ConnectAsync(
            [Uri](Get-ObjectPropertyValue -InputObject $target -Name "webSocketDebuggerUrl"),
            $connectCancellation.Token
        ).GetAwaiter().GetResult() | Out-Null
    } catch [System.OperationCanceledException] {
        throw "Timed out connecting to the exact custom renderer debugger target."
    } finally {
        $connectCancellation.Dispose()
    }

    $requestId = 1L
    $request = [ordered]@{
        id = $requestId
        method = "Runtime.evaluate"
        params = [ordered]@{
            expression = $InspectionExpression
            awaitPromise = $true
            returnByValue = $true
            silent = $true
            userGesture = $false
        }
    } | ConvertTo-Json -Compress -Depth 8

    Send-CdpRequest -Socket $socket -Json $request -OperationTimeoutSeconds $TimeoutSeconds
    $response = Receive-CdpResponse -Socket $socket -RequestId $requestId `
        -OperationTimeoutSeconds $TimeoutSeconds -MaximumMessageBytes $MaximumCdpMessageBytes

    $protocolError = Get-ObjectPropertyValue -InputObject $response -Name "error"
    if ($null -ne $protocolError) {
        $protocolMessage = Get-ObjectPropertyValue -InputObject $protocolError -Name "message" -Default "Unknown CDP error"
        throw "Runtime.evaluate was rejected by the renderer: $protocolMessage"
    }

    $responseResult = Get-ObjectPropertyValue -InputObject $response -Name "result"
    $exceptionDetails = Get-ObjectPropertyValue -InputObject $responseResult -Name "exceptionDetails"
    if ($null -ne $exceptionDetails) {
        $exceptionText = Get-ObjectPropertyValue -InputObject $exceptionDetails -Name "text" -Default "Inspection expression failed"
        throw "The read-only inspection expression failed: $exceptionText"
    }

    $remoteResult = Get-ObjectPropertyValue -InputObject $responseResult -Name "result"
    $snapshot = Get-ObjectPropertyValue -InputObject $remoteResult -Name "value"
    if ($null -eq $snapshot) {
        throw "The renderer did not return the by-value interactive verification snapshot."
    }

    $report = New-VerificationReport -Snapshot $snapshot -Target $target -DebugPort $debugPort
    $requiredPassed = [bool](
        Get-ObjectPropertyValue -InputObject (
            Get-ObjectPropertyValue -InputObject $report -Name "summary"
        ) -Name "requiredPassed" -Default $false
    )
    if (-not $requiredPassed) {
        $exitCode = 1
    }
} catch {
    $report = New-OperationalErrorReport -Message $_.Exception.Message
    $exitCode = 2
} finally {
    if ($null -ne $socket) {
        $socket.Dispose()
    }
}

Write-VerificationReport -Report $report -Format $OutputFormat
exit $exitCode
