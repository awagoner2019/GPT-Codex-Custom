/**
 * GPT + Codex Custom token HUD integration contract.
 *
 * The main integration calls these bridge-facing globals:
 *
 *   GPT_CODEX_CUSTOM_SYNC_TOKEN_CONTEXT(payload)
 *   GPT_CODEX_CUSTOM_SYNC_TOKEN_USAGE(payload)
 *   GPT_CODEX_CUSTOM_SYNC_TOKEN_MESSAGE(payload)
 *   GPT_CODEX_CUSTOM_TOKEN_PROBE()
 *
 * The frozen `GPT_CODEX_CUSTOM_TOKEN_HUD` object and HUD-prefixed globals expose
 * the same lower-level operations for diagnostics and manual integration tests.
 * `SYNC_TOKEN_CONTEXT` accepts the bridge's `{ mode, threadId, tokenUsage,
 * source: "composer", composerId?, composerGeneration? }` snapshot and treats
 * supplied usage as a cumulative thread total. Generated composer identities
 * prevent an older or cross-mode native composer from replacing active context;
 * identity-free bridge callers remain supported when they match the selected
 * product, and unscoped/manual callers retain the original behavior. `SYNC_TOKEN_USAGE`
 * accepts `{ threadId, tokenUsage,
 * source: "server" }`; without a message ID it is also an authoritative thread
 * total. `SYNC_TOKEN_MESSAGE` accepts the typed-message payload described below.
 *
 * `setActiveContext` accepts `{ mode, threadId, composer?,
 * composerSelector?, contextWindowTokens?, visible? }`, where mode is `chat`,
 * `work`, or `codex`. Pass an Element or selector in `composer` when the native
 * integration already knows the active composer.
 *
 * `updateTokenUsage` accepts `{ mode?, threadId?, messageId?, scope?,
 * tokenUsage }`. `scope` is `message` for per-response usage or `thread` for an
 * authoritative cumulative total. A nested `tokenUsage.total` automatically
 * implies thread scope. Both camelCase and OpenAI-style snake_case token fields
 * are accepted, including protocol/rollout `total_token_usage`,
 * `last_token_usage`, and `model_context_window` wrappers. Message IDs are
 * replacement keys, so retries never double-count. Work/Codex cumulative server
 * snapshots are cached as counts only so an exact total survives app restarts.
 *
 * `updateTypedMessage` accepts `{ mode?: "chat", threadId?, stableId?,
 * messageId?, role?, text, estimatedInputTokens?, estimatedOutputTokens? }`. It
 * stores only character and token counts, never the message text. These values
 * are always visibly identified as estimates.
 *
 * State is also exposed through `data-gpt-codex-token-hud-*` attributes on the
 * document root and HUD, plus the `gpt-codex-token-hud:statechange` event.
 */

(() => {
  "use strict";

  const existingApi = globalThis.GPT_CODEX_CUSTOM_TOKEN_HUD;
  if (existingApi?.version) {
    existingApi.refreshMount?.();
    return;
  }

  const API_VERSION = "1.3.0";
  const HUD_ID = "gpt-codex-token-hud";
  const HOST_ID = "gpt-codex-token-hud-host";
  const STATE_EVENT = "gpt-codex-token-hud:statechange";
  const STORAGE_KEY = "gpt-codex-custom:token-usage:v1";
  const STORAGE_VERSION = 1;
  const MAX_THREADS = 100;
  const MAX_RECORDS_PER_THREAD = 500;
  const DRAFT_MESSAGE_ID = "__draft__";
  const THREAD_TOTAL_MESSAGE_ID = "__thread_total__";
  const MODE_LABELS = Object.freeze({
    chat: "Chat",
    codex: "Codex",
    unknown: "Unknown",
    work: "Work",
  });
  const MODE_SCOPED_CONTEXT_SOURCES = new Set([
    "chat-mode-exit",
    "composer",
    "custom-chat-mode",
    "product-mode",
    "session",
  ]);
  const COMPOSER_CONTROL_SELECTOR = [
    'textarea:not([type="search"])',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="plaintext-only"][role="textbox"]',
  ].join(",");
  const threads = new Map();
  const threadModesById = new Map();
  const pendingUsageByThreadId = new Map();
  const latestComposerGenerationsByMode = new Map();
  const latestComposerIdsByMode = new Map();
  const compactNumberFormatter = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    notation: "compact",
  });
  const fullNumberFormatter = new Intl.NumberFormat();
  const activeContext = {
    composer: null,
    composerGeneration: null,
    composerId: null,
    composerSelector: null,
    contextWindowTokens: null,
    mode: "unknown",
    threadId: null,
    visible: false,
  };

  let initialized = false;
  let host = null;
  let hud = null;
  let refs = null;
  let bodyObserver = null;
  let hudResizeObserver = null;
  let mountTimer = 0;
  let fixedPositionFrame = 0;
  let fixedSettleTimers = [];
  let renderFrame = 0;
  let pendingRenderReason = "state";
  let globalDuplicateCount = 0;
  let sequence = 0;
  let lastDiagnosticError = null;
  let lastContextRejection = null;
  let modeIsolatedContextPublications = 0;
  let staleContextPublications = 0;

  function normalizeMode(value) {
    const normalized = String(value ?? "")
      .trim()
      .toLocaleLowerCase();
    return Object.hasOwn(MODE_LABELS, normalized) && normalized !== "unknown"
      ? normalized
      : "unknown";
  }

  function normalizeId(value) {
    if (value == null) return null;
    const normalized = String(value).trim();
    return normalized || null;
  }

  function normalizeSource(value, fallback) {
    const normalized = String(value ?? fallback)
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .slice(0, 32);
    return normalized || fallback;
  }

  function tokenNumber(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
  }

  function composerGenerationNumber(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  function modelPickerIsOpen() {
    return (
      document.documentElement?.getAttribute("data-gpt-codex-model-picker-open") === "true"
    );
  }

  function currentProductMode() {
    if (document.documentElement?.getAttribute("data-gpt-codex-custom-mode") === "chat") {
      return "chat";
    }
    return normalizeMode(globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES?.mode);
  }

  function firstTokenNumber(...values) {
    for (const value of values) {
      const number = tokenNumber(value);
      if (number != null) return number;
    }
    return null;
  }

  function objectValue(value) {
    return value && typeof value === "object" ? value : {};
  }

  function hasAnyUsage(usage) {
    return [
      usage.inputTokens,
      usage.outputTokens,
      usage.totalTokens,
      usage.cachedInputTokens,
      usage.reasoningOutputTokens,
    ].some((value) => value != null);
  }

  function usageCounts(usage) {
    const value = objectValue(usage);
    const inputDetails = objectValue(
      value.inputTokensDetails ??
        value.input_tokens_details ??
        value.promptTokensDetails ??
        value.prompt_tokens_details,
    );
    const outputDetails = objectValue(
      value.outputTokensDetails ??
        value.output_tokens_details ??
        value.completionTokensDetails ??
        value.completion_tokens_details,
    );

    return {
      cachedInputTokens: firstTokenNumber(
        value.cachedInputTokens,
        value.cached_input_tokens,
        inputDetails.cachedTokens,
        inputDetails.cached_tokens,
      ),
      inputTokens: firstTokenNumber(
        value.inputTokens,
        value.input_tokens,
        value.promptTokens,
        value.prompt_tokens,
      ),
      outputTokens: firstTokenNumber(
        value.outputTokens,
        value.output_tokens,
        value.completionTokens,
        value.completion_tokens,
      ),
      reasoningOutputTokens: firstTokenNumber(
        value.reasoningOutputTokens,
        value.reasoning_output_tokens,
        value.reasoningTokens,
        value.reasoning_tokens,
        outputDetails.reasoningTokens,
        outputDetails.reasoning_tokens,
      ),
      totalTokens: firstTokenNumber(value.totalTokens, value.total_tokens),
    };
  }

  function normalizeTokenUsage(rawTokenUsage) {
    const wrapper = objectValue(rawTokenUsage);
    const tokenUsage = objectValue(
      wrapper.tokenUsage ??
        wrapper.token_usage ??
        wrapper.usage ??
        wrapper.info ??
        wrapper,
    );
    const nestedTotal = objectValue(
      tokenUsage.total ??
        tokenUsage.totalUsage ??
        tokenUsage.total_usage ??
        tokenUsage.totalTokenUsage ??
        tokenUsage.total_token_usage,
    );
    const hasNestedTotal = Object.keys(nestedTotal).length > 0;
    const nestedLast = objectValue(
      tokenUsage.last ??
        tokenUsage.lastUsage ??
        tokenUsage.last_usage ??
        tokenUsage.lastTokenUsage ??
        tokenUsage.last_token_usage,
    );
    const hasNestedLast = Object.keys(nestedLast).length > 0;
    const usage = hasNestedTotal ? nestedTotal : hasNestedLast ? nestedLast : tokenUsage;
    const selectedCounts = usageCounts(usage);
    const lastCounts = hasNestedLast ? usageCounts(nestedLast) : null;

    return {
      ...selectedCounts,
      contextWindowTokens: firstTokenNumber(
        wrapper.contextWindowTokens,
        wrapper.context_window_tokens,
        wrapper.modelContextWindow,
        wrapper.model_context_window,
        tokenUsage.contextWindowTokens,
        tokenUsage.context_window_tokens,
        tokenUsage.modelContextWindow,
        tokenUsage.model_context_window,
        usage.contextWindowTokens,
        usage.context_window_tokens,
      ),
      currentCachedInputTokens: lastCounts?.cachedInputTokens ?? null,
      currentContextTokens: lastCounts?.totalTokens ?? null,
      currentInputTokens: lastCounts?.inputTokens ?? null,
      currentOutputTokens: lastCounts?.outputTokens ?? null,
      currentReasoningOutputTokens: lastCounts?.reasoningOutputTokens ?? null,
      inferredScope: hasNestedTotal ? "thread" : "message",
    };
  }

  function estimateTypedInput(text) {
    const value = String(text ?? "").trim();
    if (!value) return 0;

    const characters = Array.from(value);
    let asciiCharacters = 0;
    let emojiCharacters = 0;
    let otherCharacters = 0;

    for (const character of characters) {
      if (/^[\x00-\x7f]$/.test(character)) {
        asciiCharacters += 1;
      } else if (/\p{Extended_Pictographic}/u.test(character)) {
        emojiCharacters += 1;
      } else {
        otherCharacters += 1;
      }
    }

    return Math.max(
      1,
      Math.ceil(asciiCharacters / 4 + otherCharacters + emojiCharacters * 2),
    );
  }

  function threadKey(mode, threadId) {
    return `${mode}\u0000${threadId}`;
  }

  function createThread(mode, threadId) {
    return {
      authoritativeRecordId: null,
      contextWindowTokens: null,
      deduplicatedUpdates: 0,
      key: threadKey(mode, threadId),
      lastSource: null,
      lastUpdatedAt: null,
      messages: new Map(),
      mode,
      persistedUsageLoaded: false,
      staleUpdates: 0,
      threadId,
    };
  }

  function getThread(mode, threadId, create = false) {
    if (mode === "unknown" || !threadId) return null;
    const key = threadKey(mode, threadId);
    let thread = threads.get(key) ?? null;
    if (!thread && create) {
      thread = createThread(mode, threadId);
      threads.set(key, thread);
      trimThreads();
    } else if (thread) {
      threads.delete(key);
      threads.set(key, thread);
    }
    return thread;
  }

  function rememberThreadMode(threadId, mode) {
    const id = normalizeId(threadId);
    const normalizedMode = normalizeMode(mode);
    if (!id || normalizedMode === "unknown") return "unknown";

    threadModesById.delete(id);
    threadModesById.set(id, normalizedMode);
    while (threadModesById.size > MAX_THREADS * 2) {
      const oldestId = threadModesById.keys().next().value;
      if (oldestId === activeContext.threadId) {
        const activeMode = threadModesById.get(oldestId);
        threadModesById.delete(oldestId);
        threadModesById.set(oldestId, activeMode);
        continue;
      }
      threadModesById.delete(oldestId);
      pendingUsageByThreadId.delete(oldestId);
    }
    return normalizedMode;
  }

  function resolveModeForThread(threadId) {
    const id = normalizeId(threadId);
    if (!id) return "unknown";
    const remembered = normalizeMode(threadModesById.get(id));
    if (remembered !== "unknown") return remembered;
    return activeContext.threadId === id ? activeContext.mode : "unknown";
  }

  function readPersistedUsage() {
    try {
      const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "null");
      if (parsed?.version !== STORAGE_VERSION || !Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter(
        (entry) =>
          normalizeMode(entry?.mode) !== "unknown" &&
          Boolean(normalizeId(entry?.threadId)) &&
          entry?.tokenUsage &&
          typeof entry.tokenUsage === "object",
      );
    } catch {
      return [];
    }
  }

  function writePersistedUsage(entries) {
    try {
      globalThis.localStorage?.setItem(
        STORAGE_KEY,
        JSON.stringify({
          entries: entries
            .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
            .slice(0, MAX_THREADS),
          version: STORAGE_VERSION,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  function persistedTokenUsage(record) {
    const total = {
      cachedInputTokens: record.cachedInputTokens,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      reasoningOutputTokens: record.reasoningOutputTokens,
      totalTokens: record.totalTokens,
    };
    const last = {
      cachedInputTokens: record.currentCachedInputTokens,
      inputTokens: record.currentInputTokens,
      outputTokens: record.currentOutputTokens,
      reasoningOutputTokens: record.currentReasoningOutputTokens,
      totalTokens: record.currentContextTokens,
    };
    const hasLast = Object.values(last).some((value) => value != null);
    return {
      modelContextWindow: record.contextWindowTokens,
      total,
      ...(hasLast ? { last } : {}),
    };
  }

  function persistAuthoritativeRecord(thread, record) {
    if (
      !thread ||
      !record ||
      record.scope !== "thread" ||
      !["work", "codex"].includes(thread.mode) ||
      !["server", "composer"].includes(record.reportSource)
    ) {
      return false;
    }

    const entries = readPersistedUsage();
    const key = threadKey(thread.mode, thread.threadId);
    const retained = entries.filter(
      (entry) => threadKey(normalizeMode(entry.mode), normalizeId(entry.threadId)) !== key,
    );
    retained.push({
      mode: thread.mode,
      reportSource: record.reportSource,
      threadId: thread.threadId,
      tokenUsage: persistedTokenUsage(record),
      updatedAt: record.updatedAt,
    });
    return writePersistedUsage(retained);
  }

  function restorePersistedUsage(thread) {
    if (!thread || thread.persistedUsageLoaded) return false;
    thread.persistedUsageLoaded = true;
    if (!["work", "codex"].includes(thread.mode)) return false;

    const key = threadKey(thread.mode, thread.threadId);
    const entry = readPersistedUsage().find(
      (candidate) =>
        threadKey(normalizeMode(candidate.mode), normalizeId(candidate.threadId)) === key,
    );
    if (!entry) return false;

    const result = updateTokenUsage({
      messageId: THREAD_TOTAL_MESSAGE_ID,
      mode: thread.mode,
      persist: false,
      scope: "thread",
      source: "server-cache",
      threadId: thread.threadId,
      tokenUsage: entry.tokenUsage,
      updatedAt: entry.updatedAt,
    });
    return result.accepted === true;
  }

  function queuePendingTokenUsage(threadId, payload) {
    const id = normalizeId(threadId);
    if (!id) return false;
    pendingUsageByThreadId.delete(id);
    pendingUsageByThreadId.set(id, { ...objectValue(payload), threadId: id });
    while (pendingUsageByThreadId.size > MAX_THREADS) {
      pendingUsageByThreadId.delete(pendingUsageByThreadId.keys().next().value);
    }
    return true;
  }

  function flushPendingTokenUsage(threadId, mode) {
    const id = normalizeId(threadId);
    const normalizedMode = normalizeMode(mode);
    if (!id || normalizedMode === "unknown") return null;
    const pending = pendingUsageByThreadId.get(id);
    if (!pending) return null;
    pendingUsageByThreadId.delete(id);
    return updateTokenUsage({ ...pending, mode: normalizedMode, threadId: id });
  }

  function trimThreads() {
    while (threads.size > MAX_THREADS) {
      const oldestKey = threads.keys().next().value;
      const activeKey = activeContext.threadId
        ? threadKey(activeContext.mode, activeContext.threadId)
        : null;
      if (oldestKey === activeKey) {
        const activeThread = threads.get(oldestKey);
        threads.delete(oldestKey);
        threads.set(oldestKey, activeThread);
        continue;
      }
      threads.delete(oldestKey);
    }
  }

  function setMessageRecord(thread, record) {
    thread.messages.delete(record.messageId);
    thread.messages.set(record.messageId, record);
    while (thread.messages.size > MAX_RECORDS_PER_THREAD) {
      const oldestId = thread.messages.keys().next().value;
      if (oldestId === thread.authoritativeRecordId) {
        const authoritative = thread.messages.get(oldestId);
        thread.messages.delete(oldestId);
        thread.messages.set(oldestId, authoritative);
        continue;
      }
      thread.messages.delete(oldestId);
    }
  }

  function recordFingerprint(record) {
    return [
      record.source,
      record.scope,
      record.inputTokens,
      record.outputTokens,
      record.totalTokens,
      record.cachedInputTokens,
      record.reasoningOutputTokens,
      record.contextWindowTokens,
      record.currentContextTokens,
      record.currentInputTokens,
      record.currentOutputTokens,
      record.currentCachedInputTokens,
      record.currentReasoningOutputTokens,
      record.characterCount,
    ].join("|");
  }

  function reportSourcePriority(source) {
    const normalized = normalizeSource(source, "unknown");
    if (normalized === "server") return 4;
    if (normalized === "composer") return 3;
    if (normalized === "server-cache") return 2;
    return 1;
  }

  function recordCumulativeTotal(record) {
    if (!record) return null;
    return (
      record.totalTokens ??
      (record.inputTokens != null && record.outputTokens != null
        ? record.inputTokens + record.outputTokens
        : null)
    );
  }

  function mergeMissingRecordValues(record, previous) {
    if (!previous) return record;
    for (const key of [
      "cachedInputTokens",
      "contextWindowTokens",
      "currentCachedInputTokens",
      "currentContextTokens",
      "currentInputTokens",
      "currentOutputTokens",
      "currentReasoningOutputTokens",
      "inputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens",
    ]) {
      if (record[key] == null && previous[key] != null) record[key] = previous[key];
    }
    return record;
  }

  function addKnown(target, key, value) {
    if (value == null) return;
    target[key] = (target[key] ?? 0) + value;
  }

  function sumRecords(records) {
    const totals = {
      cachedInputTokens: null,
      contextWindowTokens: null,
      inputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
    };

    for (const record of records) {
      addKnown(totals, "cachedInputTokens", record.cachedInputTokens);
      addKnown(totals, "inputTokens", record.inputTokens);
      addKnown(totals, "outputTokens", record.outputTokens);
      addKnown(totals, "reasoningOutputTokens", record.reasoningOutputTokens);
      addKnown(totals, "totalTokens", record.totalTokens);
      if (record.contextWindowTokens != null) {
        totals.contextWindowTokens = record.contextWindowTokens;
      }
    }

    return totals;
  }

  function combineKnown(...values) {
    const known = values.filter((value) => value != null);
    return known.length > 0 ? known.reduce((total, value) => total + value, 0) : null;
  }

  function aggregateThread(thread) {
    if (!thread) {
      return {
        cachedInputTokens: null,
        contextWindowTokens: activeContext.contextWindowTokens,
        currentContextTokens: null,
        currentReasoningOutputTokens: null,
        deduplicatedUpdates: 0,
        estimatedRecordCount: 0,
        exactRecordCount: 0,
        inputQuality: "unavailable",
        inputTokens: null,
        lastSource: null,
        lastUpdatedAt: null,
        messageRecordCount: 0,
        outputQuality: "unavailable",
        outputTokens: null,
        quality: "unavailable",
        reasoningOutputTokens: null,
        staleUpdates: 0,
        totalTokens: null,
      };
    }

    const records = [...thread.messages.values()];
    const authoritative = thread.authoritativeRecordId
      ? thread.messages.get(thread.authoritativeRecordId) ?? null
      : null;
    const estimates = records.filter(
      (record) =>
        record.source === "estimated" &&
        (authoritative == null || record.sequence > authoritative.sequence),
    );
    const exactRecords = authoritative
      ? [
          authoritative,
          ...records.filter(
            (record) =>
              record.source === "exact" &&
              record.scope === "message" &&
              record.sequence > authoritative.sequence,
          ),
        ]
      : records.filter((record) => record.source === "exact" && record.scope === "message");
    const exactTotals = sumRecords(exactRecords);
    const estimatedTotals = sumRecords(estimates);
    const inputTokens = combineKnown(exactTotals.inputTokens, estimatedTotals.inputTokens);
    const outputTokens = combineKnown(exactTotals.outputTokens, estimatedTotals.outputTokens);
    const inputQuality =
      estimatedTotals.inputTokens != null
        ? "estimated"
        : exactTotals.inputTokens != null
          ? "exact"
          : "unavailable";
    const outputQuality =
      estimatedTotals.outputTokens != null
        ? "estimated"
        : exactTotals.outputTokens != null
          ? "exact"
          : "unavailable";
    const quality =
      estimates.length > 0
        ? "estimated"
        : exactRecords.length > 0 &&
            [exactTotals.inputTokens, exactTotals.outputTokens, exactTotals.totalTokens].some(
              (value) => value != null,
            )
          ? "exact"
          : "unavailable";
    const summedTotal = combineKnown(exactTotals.totalTokens, estimatedTotals.totalTokens);
    const totalTokens =
      summedTotal ??
      (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null);
    const contextRecord =
      (authoritative?.currentContextTokens != null ? authoritative : null) ??
      [...exactRecords].reverse().find((record) => record.currentContextTokens != null) ??
      null;

    return {
      cachedInputTokens: exactTotals.cachedInputTokens,
      contextWindowTokens:
        thread.contextWindowTokens ??
        exactTotals.contextWindowTokens ??
        activeContext.contextWindowTokens,
      currentContextTokens: contextRecord?.currentContextTokens ?? null,
      currentReasoningOutputTokens: contextRecord?.currentReasoningOutputTokens ?? null,
      deduplicatedUpdates: thread.deduplicatedUpdates,
      estimatedRecordCount: estimates.length,
      exactRecordCount: exactRecords.length,
      inputQuality,
      inputTokens,
      lastSource: thread.lastSource,
      lastUpdatedAt: thread.lastUpdatedAt,
      messageRecordCount: records.length,
      outputQuality,
      outputTokens,
      quality,
      reasoningOutputTokens: exactTotals.reasoningOutputTokens,
      staleUpdates: thread.staleUpdates,
      totalTokens,
    };
  }

  function formatCompactTokens(value) {
    return value == null ? "\u2014" : compactNumberFormatter.format(value);
  }

  function formatFullTokens(value) {
    return value == null ? "Unavailable" : fullNumberFormatter.format(value);
  }

  function qualityLabel(quality) {
    if (quality === "exact") return "Exact";
    if (quality === "estimated") return "Estimated";
    return "Unavailable";
  }

  function modeLabel(mode) {
    return MODE_LABELS[mode] ?? MODE_LABELS.unknown;
  }

  function createMetric(label, kind) {
    const metric = document.createElement("span");
    metric.className = `gpt-codex-token-hud__metric gpt-codex-token-hud__metric--${kind}`;

    const metricLabel = document.createElement("span");
    metricLabel.className = "gpt-codex-token-hud__metric-label";
    metricLabel.textContent = label;

    const output = document.createElement("output");
    output.className = "gpt-codex-token-hud__metric-value";
    output.textContent = "\u2014";

    metric.append(metricLabel, output);
    return { metric, output };
  }

  function createCardMetric(label, kind) {
    const metric = document.createElement("div");
    metric.className = `gpt-codex-token-hud__card-metric gpt-codex-token-hud__card-metric--${kind}`;

    const metricLabel = document.createElement("span");
    metricLabel.className = "gpt-codex-token-hud__card-metric-label";
    metricLabel.textContent = label;

    const output = document.createElement("output");
    output.className = "gpt-codex-token-hud__card-metric-value";
    output.textContent = "\u2014";

    const unit = document.createElement("span");
    unit.className = "gpt-codex-token-hud__card-metric-unit";
    unit.textContent = "tokens";

    metric.append(metricLabel, output, unit);
    return { metric, output };
  }

  function createUsageIcon() {
    const namespace = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(namespace, "svg");
    icon.classList.add("gpt-codex-token-hud__title-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    icon.setAttribute("viewBox", "0 0 20 20");

    const axis = document.createElementNS(namespace, "path");
    axis.setAttribute("d", "M3.5 3.5v13h13");
    const trend = document.createElementNS(namespace, "path");
    trend.setAttribute("d", "m5.25 13 3.15-3.7 2.55 2.1 3.8-5.15");
    const arrow = document.createElementNS(namespace, "path");
    arrow.setAttribute("d", "M12.35 6.25h2.4v2.4");
    icon.append(axis, trend, arrow);
    return icon;
  }

  function ensureHud() {
    if (hud?.isConnected && host?.isConnected && refs) return;
    if (!document.body) return;

    host = document.getElementById(HOST_ID);
    hud = document.getElementById(HUD_ID);
    if (host && hud && host.contains(hud)) {
      host.remove();
    }

    host = document.createElement("div");
    host.id = HOST_ID;
    host.dataset.dock = "right";
    host.dataset.overlapSafe = "true";
    host.dataset.placement = "fixed";
    host.dataset.positioned = "false";

    hud = document.createElement("aside");
    hud.id = HUD_ID;
    hud.setAttribute("aria-label", "Token usage");
    hud.hidden = true;

    const details = document.createElement("details");
    details.className = "gpt-codex-token-hud__details";

    const summary = document.createElement("summary");
    summary.className = "gpt-codex-token-hud__summary";
    summary.setAttribute("aria-label", "Token usage unavailable");
    summary.setAttribute("aria-controls", `${HUD_ID}-panel`);
    summary.setAttribute("aria-expanded", "false");

    const mode = document.createElement("span");
    mode.className = "gpt-codex-token-hud__mode";
    mode.textContent = "Chat";

    const input = createMetric("In", "input");
    const separator = document.createElement("span");
    separator.className = "gpt-codex-token-hud__separator";
    separator.setAttribute("aria-hidden", "true");
    separator.textContent = "\u00b7";
    const output = createMetric("Out", "output");
    const thinkingSeparator = separator.cloneNode(true);
    const thinking = createMetric("Think", "thinking");

    const quality = document.createElement("span");
    quality.className = "gpt-codex-token-hud__quality";
    quality.textContent = "Unavailable";

    const chevron = document.createElement("span");
    chevron.className = "gpt-codex-token-hud__chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "\u2304";

    summary.append(
      mode,
      input.metric,
      separator,
      output.metric,
      thinkingSeparator,
      thinking.metric,
      quality,
      chevron,
    );

    const panel = document.createElement("div");
    panel.className = "gpt-codex-token-hud__panel";
    panel.id = `${HUD_ID}-panel`;
    panel.setAttribute("aria-labelledby", `${HUD_ID}-heading`);
    panel.setAttribute("role", "region");

    const panelHeader = document.createElement("header");
    panelHeader.className = "gpt-codex-token-hud__panel-header";

    const titleGroup = document.createElement("div");
    titleGroup.className = "gpt-codex-token-hud__title-group";

    const heading = document.createElement("h2");
    heading.className = "gpt-codex-token-hud__heading";
    heading.id = `${HUD_ID}-heading`;
    heading.textContent = "Token Usage";
    titleGroup.append(createUsageIcon(), heading);

    const panelQuality = document.createElement("span");
    panelQuality.className = "gpt-codex-token-hud__quality gpt-codex-token-hud__quality--panel";
    panelQuality.textContent = "Unavailable";
    panelHeader.append(titleGroup, panelQuality);

    const metricGrid = document.createElement("div");
    metricGrid.className = "gpt-codex-token-hud__metric-grid";
    const panelInput = createCardMetric("In", "input");
    const panelOutput = createCardMetric("Out", "output");
    const panelThinking = createCardMetric("Thinking", "thinking");
    const panelTotal = createCardMetric("Total", "total");
    metricGrid.append(
      panelInput.metric,
      panelOutput.metric,
      panelThinking.metric,
      panelTotal.metric,
    );

    const context = document.createElement("section");
    context.className = "gpt-codex-token-hud__context";
    context.hidden = true;
    context.setAttribute("aria-label", "Context usage");

    const contextHeader = document.createElement("div");
    contextHeader.className = "gpt-codex-token-hud__context-header";
    const contextLabel = document.createElement("span");
    contextLabel.className = "gpt-codex-token-hud__context-label";
    contextLabel.textContent = "Context";
    const contextPercent = document.createElement("output");
    contextPercent.className = "gpt-codex-token-hud__context-percent";
    contextHeader.append(contextLabel, contextPercent);

    const contextProgress = document.createElement("div");
    contextProgress.className = "gpt-codex-token-hud__context-progress";
    contextProgress.setAttribute("role", "progressbar");
    contextProgress.setAttribute("aria-valuemin", "0");
    const contextProgressFill = document.createElement("span");
    contextProgressFill.className = "gpt-codex-token-hud__context-progress-fill";
    contextProgress.append(contextProgressFill);

    const contextCaption = document.createElement("div");
    contextCaption.className = "gpt-codex-token-hud__context-caption";
    const contextUsed = document.createElement("span");
    const contextRemaining = document.createElement("span");
    contextCaption.append(contextUsed, contextRemaining);
    context.append(contextHeader, contextProgress, contextCaption);

    const sourceNote = document.createElement("p");
    sourceNote.className = "gpt-codex-token-hud__source-note";
    sourceNote.id = `${HUD_ID}-note`;
    sourceNote.textContent = "Token usage has not been reported for this thread.";

    const updated = document.createElement("time");
    updated.className = "gpt-codex-token-hud__updated";
    updated.textContent = "Not updated";

    const footer = document.createElement("footer");
    footer.className = "gpt-codex-token-hud__footer";
    footer.append(sourceNote, updated);

    const liveStatus = document.createElement("span");
    liveStatus.className = "gpt-codex-token-hud__sr-only";
    liveStatus.setAttribute("aria-atomic", "true");
    liveStatus.setAttribute("aria-live", "polite");
    liveStatus.setAttribute("role", "status");

    panel.append(panelHeader, metricGrid, context, footer);
    details.append(summary, panel);
    hud.append(details, liveStatus);
    host.append(hud);
    document.body.append(host);

    refs = {
      context,
      contextCaption: contextUsed,
      contextPercent,
      contextProgress,
      contextProgressFill,
      contextRemaining,
      details,
      inputOutput: input.output,
      liveStatus,
      mode,
      outputOutput: output.output,
      panelInputOutput: panelInput.output,
      panelOutputOutput: panelOutput.output,
      panel,
      panelQuality,
      panelThinkingOutput: panelThinking.output,
      panelTotalOutput: panelTotal.output,
      quality,
      sourceNote,
      summary,
      thinkingOutput: thinking.output,
      updated,
    };

    details.addEventListener("toggle", () => {
      hud.dataset.expanded = String(details.open);
      syncModelPickerPresentation();
      scheduleMount();
      publishState();
    });
    details.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !details.open) return;
      details.open = false;
      summary.focus();
      event.stopPropagation();
    });

    hudResizeObserver?.disconnect();
    if (typeof ResizeObserver === "function") {
      hudResizeObserver = new ResizeObserver(() => {
        if (host?.dataset.placement === "fixed") scheduleFixedPosition();
      });
      hudResizeObserver.observe(hud);
    }
  }

  function isVisibleElement(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    if (element.closest(`#${HUD_ID}, #${HOST_ID}`)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function isComposerControl(element) {
    if (!isVisibleElement(element) || !element.matches(COMPOSER_CONTROL_SELECTOR)) return false;
    const label = `${element.getAttribute("aria-label") ?? ""} ${
      element.getAttribute("placeholder") ?? ""
    }`.trim();
    if (/edit message|find|search/i.test(label)) return false;
    if (
      element.closest('[role="dialog"]') &&
      !element.closest('[data-pip-obstacle="quick-chat"]')
    ) {
      return false;
    }
    return true;
  }

  function resolveComposerElement() {
    const explicit = activeContext.composer;
    if (explicit instanceof Element && isVisibleElement(explicit)) return explicit;
    if (typeof explicit === "string") {
      try {
        const element = document.querySelector(explicit);
        if (isVisibleElement(element)) return element;
      } catch {
        setDiagnosticError("invalid-composer-selector");
      }
    }
    if (activeContext.composerSelector) {
      try {
        const element = document.querySelector(activeContext.composerSelector);
        if (isVisibleElement(element)) return element;
      } catch {
        setDiagnosticError("invalid-composer-selector");
      }
    }

    if (isComposerControl(document.activeElement)) return document.activeElement;

    const controls = [...document.querySelectorAll(COMPOSER_CONTROL_SELECTOR)].filter(
      isComposerControl,
    );
    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      let score = rect.bottom / Math.max(window.innerHeight, 1);
      if (control.closest("form")) score += 2;
      if (control.closest('[data-pip-obstacle="quick-chat"]')) {
        score += activeContext.mode === "chat" ? 10 : -10;
      } else if (activeContext.mode === "chat") {
        score -= 2;
      }
      if (score > bestScore) {
        best = control;
        bestScore = score;
      }
    }
    return best;
  }

  function resolveFlowAnchor(element) {
    if (!isVisibleElement(element)) return null;
    if (element.matches(COMPOSER_CONTROL_SELECTOR)) {
      return (
        element.closest("form") ??
        element.closest('[data-testid*="composer" i], [data-composer]') ??
        element.parentElement
      );
    }
    return element.closest("form") ?? element;
  }

  function mountHud() {
    mountTimer = 0;
    ensureHud();
    if (!host || !hud || !activeContext.visible || activeContext.mode === "unknown") return;

    const previousPlacement = host.dataset.placement;
    if (host.parentElement !== document.body) document.body.append(host);
    host.dataset.placement = "fixed";
    scheduleFixedPosition({ settle: true });

    if (previousPlacement !== host.dataset.placement) {
      updateDiagnosticDatasets();
      publishState();
    }
  }

  function scheduleMount() {
    if (mountTimer) return;
    mountTimer = window.setTimeout(mountHud, 60);
  }

  function rectanglesOverlap(first, second, gap = 6) {
    return !(
      first.right + gap <= second.left ||
      first.left >= second.right + gap ||
      first.bottom + gap <= second.top ||
      first.top >= second.bottom + gap
    );
  }

  function visibleViewportRectangle(element) {
    if (!isVisibleElement(element)) return null;
    const rect = element.getBoundingClientRect();
    return rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
      ? rect
      : null;
  }

  function fixedLayoutObstacles() {
    const entries = [];
    const seen = new Set();
    const add = (element, kind) => {
      if (!(element instanceof Element) || seen.has(element)) return;
      const rect = visibleViewportRectangle(element);
      if (!rect) return;
      seen.add(element);
      entries.push({ kind, rect });
    };

    add(document.getElementById("gpt-codex-pinboard-launcher"), "pinboard");
    add(document.getElementById("gpt-codex-pinboard-drawer"), "overlay");
    add(document.getElementById("gpt-codex-custom-model-picker"), "model");
    add(document.getElementById("gpt-codex-custom-model-picker-panel"), "overlay");
    for (const dialog of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
      add(dialog, "overlay");
    }

    const composer = resolveComposerElement();
    add(resolveFlowAnchor(composer) ?? composer, "composer");
    const composerSurfaces = [...document.querySelectorAll(".composer-surface-chrome")].filter(
      (surface) =>
        activeContext.mode === "chat"
          ? Boolean(surface.closest('[data-pip-obstacle="quick-chat"]'))
          : !surface.closest('[data-pip-obstacle="quick-chat"]'),
    );
    for (const surface of composerSurfaces) add(surface, "composer");
    return entries;
  }

  function fixedCandidate(left, top, width, height) {
    return {
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
    };
  }

  function findSafeRightDockPosition(width, height, obstacles, preferredBottom) {
    const edge = 14;
    const gap = 10;
    const rightDockLeft = Math.max(edge, window.innerWidth - width - edge);
    const maximumTop = Math.max(edge, window.innerHeight - height - edge);
    const clampTop = (value) => Math.min(maximumTop, Math.max(edge, value));
    const candidates = [];
    const seen = new Set();
    const preferredTop = clampTop(preferredBottom - height);

    const addCandidate = (top) => {
      const clampedTop = Math.round(clampTop(top));
      if (seen.has(clampedTop)) return;
      seen.add(clampedTop);
      candidates.push(fixedCandidate(rightDockLeft, clampedTop, width, height));
    };

    addCandidate(preferredTop);

    for (const obstacle of obstacles.slice(0, 120)) {
      addCandidate(obstacle.top - height - gap);
      addCandidate(obstacle.bottom + gap);
    }

    addCandidate(edge);
    addCandidate(maximumTop);

    for (let top = preferredTop; top >= edge; top -= 24) addCandidate(top);
    for (let top = preferredTop + 24; top <= maximumTop; top += 24) addCandidate(top);

    return (
      candidates.find((candidate) =>
        obstacles.every((obstacle) => !rectanglesOverlap(candidate, obstacle)),
      ) ?? null
    );
  }

  function positionFixedHud() {
    if (!host || !hud || host.dataset.placement !== "fixed" || hud.hidden) return;
    host.style.visibility = "hidden";
    const rect = hud.getBoundingClientRect();
    const dockState = stateFor();
    const compact =
      dockState.modelPickerOpen ||
      (dockState.quality === "unavailable" && refs?.details.open !== true);
    const width = Math.min(
      Math.max(rect.width, compact ? 112 : 220),
      Math.max(window.innerWidth - 28, 1),
    );
    const height = Math.min(
      Math.max(rect.height, compact ? 30 : 34),
      Math.max(window.innerHeight - 28, 1),
    );
    const obstacleEntries = fixedLayoutObstacles();
    const stackAnchors = obstacleEntries.filter(
      ({ kind, rect: obstacle }) =>
        (kind === "pinboard" || kind === "composer") && obstacle.top > window.innerHeight * 0.45,
    );
    const preferredBottom = stackAnchors.reduce(
      (bottom, { rect: obstacle }) => Math.min(bottom, obstacle.top - 10),
      window.innerHeight - 14,
    );
    const safePosition = findSafeRightDockPosition(
      width,
      height,
      obstacleEntries.map(({ rect: obstacle }) => obstacle),
      preferredBottom,
    );

    if (!safePosition) {
      host.dataset.overlapSafe = "false";
      host.dataset.positioned = "false";
      host.style.visibility = "hidden";
      updateDiagnosticDatasets();
      publishState();
      return;
    }

    host.style.setProperty("--gpt-codex-token-hud-fixed-right", "14px");
    host.style.setProperty(
      "--gpt-codex-token-hud-fixed-top",
      `${safePosition.top}px`,
    );
    host.dataset.overlapSafe = "true";
    host.dataset.positioned = "true";
    host.style.visibility = "visible";
    updateDiagnosticDatasets();
  }

  function scheduleFixedPosition({ settle = false } = {}) {
    if (!fixedPositionFrame) {
      fixedPositionFrame = window.requestAnimationFrame(() => {
        fixedPositionFrame = 0;
        positionFixedHud();
      });
    }
    if (!settle) return;
    fixedSettleTimers.forEach((timer) => window.clearTimeout(timer));
    fixedSettleTimers = [180, 520, 1_000].map((delay) =>
      window.setTimeout(() => scheduleFixedPosition(), delay),
    );
  }

  function activeThread() {
    return getThread(activeContext.mode, activeContext.threadId, false);
  }

  function stateFor(query = {}) {
    const requestedMode = normalizeMode(query.mode ?? activeContext.mode);
    const requestedThreadId = normalizeId(
      query.threadId ?? query.conversationId ?? query.taskId ?? activeContext.threadId,
    );
    const thread = getThread(requestedMode, requestedThreadId, false);
    const aggregate = aggregateThread(thread);
    const isActive =
      activeContext.visible &&
      requestedMode === activeContext.mode &&
      requestedThreadId === activeContext.threadId;

    return Object.freeze({
      active: isActive,
      activeComposerGeneration: isActive ? activeContext.composerGeneration : null,
      activeComposerId: isActive ? activeContext.composerId : null,
      cachedInputTokens: aggregate.cachedInputTokens,
      contextPublicationRejections:
        staleContextPublications + modeIsolatedContextPublications,
      contextWindowTokens: aggregate.contextWindowTokens,
      currentContextTokens: aggregate.currentContextTokens,
      currentContextPercent:
        aggregate.currentContextTokens != null &&
        aggregate.contextWindowTokens != null &&
        aggregate.contextWindowTokens > 0
          ? Math.min(
              100,
              (aggregate.currentContextTokens / aggregate.contextWindowTokens) * 100,
            )
          : null,
      currentContextRemainingTokens:
        aggregate.currentContextTokens != null && aggregate.contextWindowTokens != null
          ? Math.max(aggregate.contextWindowTokens - aggregate.currentContextTokens, 0)
          : null,
      currentReasoningOutputTokens: aggregate.currentReasoningOutputTokens,
      deduplicatedUpdates: aggregate.deduplicatedUpdates,
      estimatedRecordCount: aggregate.estimatedRecordCount,
      exactRecordCount: aggregate.exactRecordCount,
      expanded: isActive ? Boolean(refs?.details.open) : false,
      input: Object.freeze({
        quality: aggregate.inputQuality,
        tokens: aggregate.inputTokens,
      }),
      lastDiagnosticError,
      lastContextRejection,
      lastSource: aggregate.lastSource,
      lastUpdatedAt: aggregate.lastUpdatedAt,
      messageRecordCount: aggregate.messageRecordCount,
      modelPickerOpen: modelPickerIsOpen(),
      modeIsolatedContextPublications,
      mode: requestedMode,
      modeLabel: modeLabel(requestedMode),
      output: Object.freeze({
        quality: aggregate.outputQuality,
        tokens: aggregate.outputTokens,
      }),
      dock: isActive ? host?.dataset.dock ?? "right" : "inactive",
      overlapSafe: isActive ? host?.dataset.overlapSafe !== "false" : true,
      placement: isActive ? host?.dataset.placement ?? "pending" : "inactive",
      quality: aggregate.quality,
      reasoningOutputTokens: aggregate.reasoningOutputTokens,
      staleUpdates: aggregate.staleUpdates,
      staleContextPublications,
      threadAvailable: Boolean(requestedThreadId),
      threadCount: threads.size,
      threadId: requestedThreadId,
      totalDeduplicatedUpdates: globalDuplicateCount,
      totalTokens: aggregate.totalTokens,
      thinking: Object.freeze({
        quality: aggregate.reasoningOutputTokens == null ? "unavailable" : "exact",
        tokens: aggregate.reasoningOutputTokens,
      }),
      version: API_VERSION,
    });
  }

  function getState(query = {}) {
    return stateFor(objectValue(query));
  }

  function sourceNoteFor(state) {
    if (state.quality === "exact") {
      if (state.lastSource === "server-cache") {
        return "Cached server totals; Thinking stays included in Out and Total.";
      }
      return "Server totals; Thinking is included in Out and Total.";
    }
    if (state.quality === "estimated") {
      return "Estimated from this chat; server values remain exact.";
    }
    return "Token usage has not been reported for this thread.";
  }

  function setCardMetric(output, label, value, quality, note = "") {
    output.textContent = value == null ? "\u2014" : formatFullTokens(value);
    output.title = value == null ? `${label} tokens unavailable` : formatFullTokens(value);
    output.setAttribute(
      "aria-label",
      value == null
        ? `${label} tokens unavailable`
        : `${formatFullTokens(value)} ${label.toLocaleLowerCase()} tokens, ${quality}${note}`,
    );
  }

  function stateAriaLabel(state) {
    const input =
      state.input.tokens == null
        ? "input unavailable"
        : `input ${formatFullTokens(state.input.tokens)} tokens, ${state.input.quality}`;
    const output =
      state.output.tokens == null
        ? "output unavailable"
        : `output ${formatFullTokens(state.output.tokens)} tokens, ${state.output.quality}`;
    const thinking =
      state.thinking.tokens == null
        ? "thinking unavailable"
        : `thinking ${formatFullTokens(state.thinking.tokens)} tokens, ${state.thinking.quality}`;
    const total =
      state.totalTokens == null
        ? "total unavailable"
        : `total ${formatFullTokens(state.totalTokens)} tokens`;
    const context =
      state.currentContextTokens == null || state.contextWindowTokens == null
        ? ""
        : `; context ${formatFullTokens(state.currentContextTokens)} of ${formatFullTokens(
            state.contextWindowTokens,
          )} tokens`;
    return `${state.modeLabel} token usage: ${input}; ${output}; ${thinking}; ${total}; ${qualityLabel(
      state.quality,
    )} overall${context}. Activate for details. Thinking is included in output and total.`;
  }

  function syncModelPickerPresentation() {
    if (!hud || !refs) return;
    const pickerOpen = modelPickerIsOpen();
    hud.dataset.modelPickerOpen = String(pickerOpen);
    refs.summary.setAttribute(
      "aria-expanded",
      String(refs.details.open && !pickerOpen),
    );
    refs.panel.toggleAttribute("inert", pickerOpen);
    if (pickerOpen) {
      refs.panel.setAttribute("aria-hidden", "true");
    } else {
      refs.panel.removeAttribute("aria-hidden");
    }
  }

  function updateDiagnosticDatasets(state = stateFor()) {
    const root = document.documentElement;
    root.dataset.gptCodexTokenHud = initialized ? "ready" : "loading";
    root.dataset.gptCodexTokenHudDuplicates = String(state.totalDeduplicatedUpdates);
    root.dataset.gptCodexTokenHudError = lastDiagnosticError ?? "none";
    root.dataset.gptCodexTokenHudCurrentContext =
      state.currentContextTokens == null ? "unavailable" : String(state.currentContextTokens);
    root.dataset.gptCodexTokenHudCurrentThinking =
      state.currentReasoningOutputTokens == null
        ? "unavailable"
        : String(state.currentReasoningOutputTokens);
    root.dataset.gptCodexTokenHudComposerGeneration =
      state.activeComposerGeneration == null ? "none" : String(state.activeComposerGeneration);
    root.dataset.gptCodexTokenHudContextRejection = state.lastContextRejection ?? "none";
    root.dataset.gptCodexTokenHudContextRejections = String(
      state.contextPublicationRejections,
    );
    root.dataset.gptCodexTokenHudContextStale = String(state.staleContextPublications);
    root.dataset.gptCodexTokenHudInput =
      state.input.tokens == null ? "unavailable" : String(state.input.tokens);
    root.dataset.gptCodexTokenHudMode = state.mode;
    root.dataset.gptCodexTokenHudModeIsolation = String(
      state.modeIsolatedContextPublications,
    );
    root.dataset.gptCodexTokenHudModelPickerOpen = String(state.modelPickerOpen);
    root.dataset.gptCodexTokenHudOutput =
      state.output.tokens == null ? "unavailable" : String(state.output.tokens);
    root.dataset.gptCodexTokenHudThinking =
      state.thinking.tokens == null ? "unavailable" : String(state.thinking.tokens);
    root.dataset.gptCodexTokenHudDock = state.dock;
    root.dataset.gptCodexTokenHudOverlapSafe = String(state.overlapSafe);
    root.dataset.gptCodexTokenHudPlacement = state.placement;
    root.dataset.gptCodexTokenHudQuality = state.quality;
    root.dataset.gptCodexTokenHudRecords = String(state.messageRecordCount);
    root.dataset.gptCodexTokenHudSource = state.lastSource ?? "none";
    root.dataset.gptCodexTokenHudStale = String(state.staleUpdates);
    root.dataset.gptCodexTokenHudThread = state.threadAvailable ? "available" : "unavailable";

    if (!hud) return;
    hud.dataset.expanded = String(state.expanded);
    hud.dataset.dock = state.dock;
    hud.dataset.inputQuality = state.input.quality;
    hud.dataset.modelPickerOpen = String(state.modelPickerOpen);
    hud.dataset.mode = state.mode;
    hud.dataset.outputQuality = state.output.quality;
    hud.dataset.thinkingQuality = state.thinking.quality;
    hud.dataset.placement = state.placement;
    hud.dataset.quality = state.quality;
    hud.dataset.thread = state.threadAvailable ? "available" : "unavailable";
  }

  function publishState(state = stateFor()) {
    document.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: state }));
  }

  function renderHud(reason = "state") {
    renderFrame = 0;
    ensureHud();
    if (!hud || !host || !refs) return;

    const state = stateFor();
    const shouldShow = activeContext.visible && activeContext.mode !== "unknown";
    hud.hidden = !shouldShow;
    host.hidden = !shouldShow;
    if (!shouldShow) {
      updateDiagnosticDatasets(state);
      publishState(state);
      return;
    }

    refs.mode.textContent = state.modeLabel;
    refs.inputOutput.textContent = formatCompactTokens(state.input.tokens);
    refs.inputOutput.setAttribute(
      "aria-label",
      state.input.tokens == null
        ? "Input tokens unavailable"
        : `${formatFullTokens(state.input.tokens)} input tokens, ${state.input.quality}`,
    );
    refs.inputOutput.title =
      state.input.tokens == null ? "Input tokens unavailable" : formatFullTokens(state.input.tokens);
    refs.outputOutput.textContent = formatCompactTokens(state.output.tokens);
    refs.outputOutput.setAttribute(
      "aria-label",
      state.output.tokens == null
        ? "Output tokens unavailable"
        : `${formatFullTokens(state.output.tokens)} output tokens, ${state.output.quality}`,
    );
    refs.outputOutput.title =
      state.output.tokens == null
        ? "Output tokens unavailable"
        : formatFullTokens(state.output.tokens);
    refs.thinkingOutput.textContent = formatCompactTokens(state.thinking.tokens);
    refs.thinkingOutput.setAttribute(
      "aria-label",
      state.thinking.tokens == null
        ? "Thinking tokens unavailable"
        : `${formatFullTokens(state.thinking.tokens)} thinking tokens, ${state.thinking.quality}`,
    );
    refs.thinkingOutput.title =
      state.thinking.tokens == null
        ? "Thinking tokens unavailable"
        : formatFullTokens(state.thinking.tokens);
    refs.quality.textContent = qualityLabel(state.quality);
    refs.panelQuality.textContent = qualityLabel(state.quality);
    const qualityTitle =
      state.quality === "exact"
        ? state.lastSource === "server-cache"
          ? "Exact server values restored from the local counts-only cache"
          : "Exact values reported by the Codex server"
        : state.quality === "estimated"
          ? "Estimated from Chat messages; no exact server usage is available"
          : "Token usage unavailable";
    refs.quality.title = qualityTitle;
    refs.panelQuality.title = qualityTitle;
    refs.summary.setAttribute("aria-label", stateAriaLabel(state));
    setCardMetric(
      refs.panelInputOutput,
      "Input",
      state.input.tokens,
      state.input.quality,
    );
    setCardMetric(
      refs.panelOutputOutput,
      "Output",
      state.output.tokens,
      state.output.quality,
    );
    setCardMetric(
      refs.panelThinkingOutput,
      "Thinking",
      state.thinking.tokens,
      state.thinking.quality,
      "; included in output and total",
    );
    setCardMetric(refs.panelTotalOutput, "Total", state.totalTokens, state.quality);

    const hasContext =
      state.currentContextTokens != null &&
      state.contextWindowTokens != null &&
      state.contextWindowTokens > 0 &&
      state.currentContextPercent != null;
    refs.context.hidden = !hasContext;
    if (hasContext) {
      const contextPercent = state.currentContextPercent.toLocaleString(undefined, {
        maximumFractionDigits: state.currentContextPercent < 1 ? 2 : 1,
      });
      refs.contextPercent.textContent = `${contextPercent}% used`;
      refs.contextCaption.textContent = `${formatFullTokens(
        state.currentContextTokens,
      )} / ${formatFullTokens(state.contextWindowTokens)} tokens`;
      refs.contextRemaining.textContent = `${formatFullTokens(
        state.currentContextRemainingTokens,
      )} left`;
      refs.contextProgress.setAttribute("aria-valuemax", String(state.contextWindowTokens));
      refs.contextProgress.setAttribute(
        "aria-valuenow",
        String(Math.min(state.currentContextTokens, state.contextWindowTokens)),
      );
      refs.contextProgress.setAttribute(
        "aria-valuetext",
        `${contextPercent}% used, ${formatFullTokens(
          state.currentContextRemainingTokens,
        )} tokens remaining`,
      );
      refs.contextProgressFill.style.setProperty(
        "--gpt-codex-token-hud-context-percent",
        `${state.currentContextPercent}%`,
      );
    } else {
      refs.contextProgress.removeAttribute("aria-valuemax");
      refs.contextProgress.removeAttribute("aria-valuenow");
      refs.contextProgress.removeAttribute("aria-valuetext");
      refs.contextProgressFill.style.removeProperty("--gpt-codex-token-hud-context-percent");
    }

    const updatedDate = state.lastUpdatedAt ? new Date(state.lastUpdatedAt) : null;
    if (updatedDate && Number.isFinite(updatedDate.getTime())) {
      refs.updated.dateTime = updatedDate.toISOString();
      refs.updated.textContent = `Updated ${updatedDate.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })}`;
    } else {
      refs.updated.removeAttribute("datetime");
      refs.updated.textContent = "Not updated";
    }
    refs.sourceNote.textContent = sourceNoteFor(state);

    hud.dataset.expanded = String(refs.details.open);
    syncModelPickerPresentation();
    updateDiagnosticDatasets(state);
    if (reason === "context" || reason === "exact") {
      refs.liveStatus.textContent = stateAriaLabel(state).replace(" Activate for details.", "");
    }
    publishState(state);
    scheduleMount();
  }

  function scheduleRender(reason = "state") {
    const priority = { context: 4, exact: 3, state: 2, typed: 1 };
    if ((priority[reason] ?? 0) >= (priority[pendingRenderReason] ?? 0)) {
      pendingRenderReason = reason;
    }
    if (renderFrame) return;
    const callback = () => {
      const nextReason = pendingRenderReason;
      pendingRenderReason = "state";
      renderHud(nextReason);
    };
    renderFrame = window.requestAnimationFrame(callback);
  }

  function setDiagnosticError(error) {
    lastDiagnosticError = error;
    if (document.documentElement) updateDiagnosticDatasets();
  }

  function clearDiagnosticError() {
    lastDiagnosticError = null;
  }

  function resolveUpdateTarget(update) {
    const threadId = normalizeId(
      update.threadId ?? update.conversationId ?? update.taskId ?? activeContext.threadId,
    );
    const requestedMode = normalizeMode(update.mode);
    const mode =
      requestedMode !== "unknown" ? requestedMode : resolveModeForThread(threadId);
    return { mode, threadId };
  }

  function targetIsActive(target) {
    return target.mode === activeContext.mode && target.threadId === activeContext.threadId;
  }

  function composerContextDecision(context = {}, options = {}) {
    const next = objectValue(context);
    const generation = composerGenerationNumber(
      next.composerGeneration ?? next.composer_generation,
    );
    const composerId = normalizeId(next.composerId ?? next.composer_id);
    const source = normalizeSource(next.source, "context");
    const mode = normalizeMode(next.mode ?? next.productMode);
    const expectedMode = normalizeMode(options.expectedMode ?? currentProductMode());
    if (
      (generation != null || MODE_SCOPED_CONTEXT_SOURCES.has(source)) &&
      expectedMode !== "unknown" &&
      mode !== expectedMode
    ) {
      return Object.freeze({
        accepted: false,
        composerId,
        expectedMode,
        generation,
        mode,
        reason: "composer-mode-mismatch",
        source,
      });
    }
    if (generation == null) {
      return Object.freeze({ accepted: true, composerId, generation, mode, reason: null, source });
    }

    const suppliedLatestGeneration = Number(options.latestGeneration);
    const comparisonGeneration =
      Number.isSafeInteger(suppliedLatestGeneration) && suppliedLatestGeneration >= 0
        ? suppliedLatestGeneration
        : latestComposerGenerationsByMode.get(mode) ?? 0;
    const comparisonComposerId = Object.hasOwn(options, "latestComposerId")
      ? normalizeId(options.latestComposerId)
      : latestComposerIdsByMode.get(mode) ?? null;

    if (generation < comparisonGeneration) {
      return Object.freeze({
        accepted: false,
        composerId,
        generation,
        latestGeneration: comparisonGeneration,
        mode,
        reason: "stale-composer-generation",
      });
    }
    if (
      generation === comparisonGeneration &&
      composerId &&
      comparisonComposerId &&
      composerId !== comparisonComposerId
    ) {
      return Object.freeze({
        accepted: false,
        composerId,
        generation,
        latestGeneration: comparisonGeneration,
        mode,
        reason: "composer-generation-conflict",
      });
    }
    return Object.freeze({ accepted: true, composerId, generation, mode, reason: null });
  }

  function recordContextPublicationRejection(decision) {
    if (decision.reason === "composer-mode-mismatch") {
      modeIsolatedContextPublications += 1;
    } else {
      staleContextPublications += 1;
    }
    lastContextRejection = decision.reason;
    const state = stateFor();
    updateDiagnosticDatasets(state);
    scheduleRender("state");
    return Object.freeze({
      accepted: false,
      reason: decision.reason,
      state,
    });
  }

  function applyActiveContext(context = {}) {
    const next = context == null ? {} : objectValue(context);
    const composerDecision = composerContextDecision(next);
    if (!composerDecision.accepted) {
      return recordContextPublicationRejection(composerDecision);
    }

    const mode = normalizeMode(next.mode ?? next.productMode);
    const threadId = normalizeId(next.threadId ?? next.conversationId ?? next.taskId);
    activeContext.mode = mode;
    activeContext.threadId = threadId;
    activeContext.composer = next.composerElement ?? next.composer ?? null;
    activeContext.composerGeneration = composerDecision.generation;
    activeContext.composerId = composerDecision.composerId;
    activeContext.composerSelector =
      typeof next.composerSelector === "string" ? next.composerSelector : null;
    activeContext.contextWindowTokens = firstTokenNumber(
      next.contextWindowTokens,
      next.context_window_tokens,
      next.modelContextWindow,
      next.model_context_window,
    );
    activeContext.visible =
      next.visible !== false && next.active !== false && mode !== "unknown";

    if (composerDecision.generation != null) {
      latestComposerGenerationsByMode.set(
        mode,
        Math.max(
          latestComposerGenerationsByMode.get(mode) ?? 0,
          composerDecision.generation,
        ),
      );
      latestComposerIdsByMode.set(mode, composerDecision.composerId);
    }

    rememberThreadMode(threadId, mode);
    const thread = getThread(mode, threadId, Boolean(threadId));
    if (thread && activeContext.contextWindowTokens != null) {
      thread.contextWindowTokens = activeContext.contextWindowTokens;
    }
    if (thread) restorePersistedUsage(thread);
    flushPendingTokenUsage(threadId, mode);
    clearDiagnosticError();
    const state = stateFor();
    updateDiagnosticDatasets(state);
    scheduleRender("context");
    scheduleMount();
    return Object.freeze({ accepted: true, reason: null, state });
  }

  function setActiveContext(context = {}) {
    return applyActiveContext(context).state;
  }

  function updateTokenUsage(update = {}) {
    const next = objectValue(update);
    const target = resolveUpdateTarget(next);
    if (target.mode === "unknown" || !target.threadId) {
      setDiagnosticError("missing-token-usage-context");
      return Object.freeze({
        accepted: false,
        reason: "A Chat, Work, or Codex mode and threadId are required.",
        state: stateFor(),
      });
    }

    const normalized = normalizeTokenUsage(next.tokenUsage ?? next.token_usage ?? next.usage ?? next);
    if (!hasAnyUsage(normalized)) {
      setDiagnosticError("unavailable-token-usage");
      return Object.freeze({
        accepted: false,
        reason: "tokenUsage did not contain a supported token count.",
        state: stateFor(target),
      });
    }

    const requestedScope = String(next.scope ?? normalized.inferredScope).toLocaleLowerCase();
    const scope = requestedScope === "thread" ? "thread" : "message";
    const rawUsage = objectValue(next.tokenUsage ?? next.token_usage ?? next.usage ?? next);
    const messageId =
      normalizeId(
        next.messageId ??
          next.responseId ??
          next.eventId ??
          next.turnId ??
          next.turn_id ??
          rawUsage.messageId ??
          rawUsage.message_id ??
          rawUsage.responseId ??
          rawUsage.response_id ??
          rawUsage.id,
      ) ?? (scope === "thread" ? THREAD_TOTAL_MESSAGE_ID : null);
    if (!messageId) {
      setDiagnosticError("missing-message-id");
      return Object.freeze({
        accepted: false,
        reason: "messageId is required for per-message token usage.",
        state: stateFor(target),
      });
    }

    rememberThreadMode(target.threadId, target.mode);
    const thread = getThread(target.mode, target.threadId, true);
    const contextWindowTokens =
      firstTokenNumber(
        next.contextWindowTokens,
        next.context_window_tokens,
        next.modelContextWindow,
        next.model_context_window,
      ) ?? normalized.contextWindowTokens;
    const reportSource = normalizeSource(next.source, "server");
    const suppliedUpdatedAt = Number(next.updatedAt ?? next.updated_at);
    const updatedAt =
      Number.isFinite(suppliedUpdatedAt) && suppliedUpdatedAt > 0
        ? Math.round(suppliedUpdatedAt)
        : Date.now();
    const record = {
      cachedInputTokens: normalized.cachedInputTokens,
      characterCount: null,
      contextWindowTokens,
      currentCachedInputTokens: normalized.currentCachedInputTokens,
      currentContextTokens: normalized.currentContextTokens,
      currentInputTokens: normalized.currentInputTokens,
      currentOutputTokens: normalized.currentOutputTokens,
      currentReasoningOutputTokens: normalized.currentReasoningOutputTokens,
      inputTokens: normalized.inputTokens,
      messageId,
      outputTokens: normalized.outputTokens,
      reportPriority: reportSourcePriority(reportSource),
      reportSource,
      reasoningOutputTokens: normalized.reasoningOutputTokens,
      scope,
      sequence: sequence + 1,
      source: "exact",
      totalTokens:
        normalized.totalTokens ??
        (normalized.inputTokens != null && normalized.outputTokens != null
          ? normalized.inputTokens + normalized.outputTokens
          : null),
      updatedAt,
    };

    const previous = thread.messages.get(messageId);
    const previousCumulativeTotal = recordCumulativeTotal(previous);
    const nextCumulativeTotal = recordCumulativeTotal(record);
    if (
      scope === "thread" &&
      previous?.source === "exact" &&
      previous.scope === "thread" &&
      previousCumulativeTotal != null &&
      nextCumulativeTotal != null &&
      nextCumulativeTotal < previousCumulativeTotal &&
      reportSource !== "server" &&
      record.reportPriority <= (previous.reportPriority ?? 1)
    ) {
      thread.staleUpdates += 1;
      clearDiagnosticError();
      if (targetIsActive(target)) {
        updateDiagnosticDatasets();
        scheduleRender("exact");
      }
      return Object.freeze({
        accepted: true,
        deduplicated: false,
        stale: true,
        state: stateFor(target),
      });
    }

    if (scope === "thread" && previous?.source === "exact") {
      mergeMissingRecordValues(record, previous);
    }
    record.fingerprint = recordFingerprint(record);

    if (previous?.source === "exact" && previous.fingerprint === record.fingerprint) {
      thread.deduplicatedUpdates += 1;
      globalDuplicateCount += 1;
      if (record.reportPriority > (previous.reportPriority ?? 1)) {
        previous.reportPriority = record.reportPriority;
        previous.reportSource = record.reportSource;
        previous.updatedAt = Math.max(previous.updatedAt ?? 0, record.updatedAt);
      }
      thread.lastSource = previous.reportSource;
      thread.lastUpdatedAt = previous.updatedAt;
      if (scope === "thread" && next.persist !== false) {
        persistAuthoritativeRecord(thread, previous);
      }
      clearDiagnosticError();
      if (targetIsActive(target)) {
        updateDiagnosticDatasets();
        scheduleRender("exact");
      }
      return Object.freeze({
        accepted: true,
        deduplicated: true,
        state: stateFor(target),
      });
    }

    sequence += 1;
    record.sequence = sequence;
    setMessageRecord(thread, record);
    if (scope === "thread") thread.authoritativeRecordId = messageId;
    if (contextWindowTokens != null) thread.contextWindowTokens = contextWindowTokens;
    thread.lastSource = record.reportSource;
    thread.lastUpdatedAt = record.updatedAt;
    if (scope === "thread" && next.persist !== false) {
      persistAuthoritativeRecord(thread, record);
    }
    clearDiagnosticError();
    if (targetIsActive(target)) {
      updateDiagnosticDatasets();
      scheduleRender("exact");
    }
    return Object.freeze({
      accepted: true,
      deduplicated: false,
      state: stateFor(target),
    });
  }

  function updateTypedMessage(update = {}) {
    const next = objectValue(update);
    const target = resolveUpdateTarget(next);
    if (target.mode !== "chat" || !target.threadId) {
      setDiagnosticError("typed-estimate-requires-chat-context");
      return Object.freeze({
        accepted: false,
        reason: "Typed estimates require an active Chat mode and threadId.",
        state: stateFor(),
      });
    }

    const thread = getThread(target.mode, target.threadId, true);
    const messageId =
      normalizeId(
        next.stableId ??
          next.recordId ??
          next.messageId ??
          next.draftId ??
          next.clientMessageId,
      ) ?? DRAFT_MESSAGE_ID;
    const text = String(next.text ?? next.typedText ?? next.content ?? next.message ?? "");
    const previous = thread.messages.get(messageId);

    if (!text.trim()) {
      const removed = previous?.source === "estimated";
      if (removed) thread.messages.delete(messageId);
      thread.lastSource = normalizeSource(next.source, "message");
      thread.lastUpdatedAt = Date.now();
      clearDiagnosticError();
      if (targetIsActive(target)) {
        updateDiagnosticDatasets();
        scheduleRender("typed");
      }
      return Object.freeze({
        accepted: true,
        cleared: Boolean(removed),
        deduplicated: false,
        state: stateFor(target),
      });
    }

    if (previous?.source === "exact") {
      thread.deduplicatedUpdates += 1;
      globalDuplicateCount += 1;
      thread.lastSource = normalizeSource(next.source, "message");
      thread.lastUpdatedAt = Date.now();
      clearDiagnosticError();
      if (targetIsActive(target)) updateDiagnosticDatasets();
      return Object.freeze({
        accepted: true,
        deduplicated: true,
        exactPreserved: true,
        state: stateFor(target),
      });
    }

    const role = String(next.role ?? next.authorRole ?? "user")
      .trim()
      .toLocaleLowerCase();
    const isAssistant = role === "assistant";
    const estimatedTokens = isAssistant
      ? tokenNumber(next.estimatedOutputTokens ?? next.estimated_output_tokens) ??
        estimateTypedInput(text)
      : tokenNumber(next.estimatedInputTokens ?? next.estimated_input_tokens) ??
        estimateTypedInput(text);
    const record = {
      cachedInputTokens: null,
      characterCount: Array.from(text).length,
      contextWindowTokens: null,
      inputTokens: isAssistant ? null : estimatedTokens,
      messageId,
      outputTokens: isAssistant ? estimatedTokens : null,
      reportSource: normalizeSource(next.source, "message"),
      reasoningOutputTokens: null,
      role: isAssistant ? "assistant" : "user",
      scope: "message",
      sequence: sequence + 1,
      source: "estimated",
      totalTokens: estimatedTokens,
      updatedAt: Date.now(),
    };
    record.fingerprint = recordFingerprint(record);

    if (previous?.source === "estimated" && previous.fingerprint === record.fingerprint) {
      thread.deduplicatedUpdates += 1;
      globalDuplicateCount += 1;
      thread.lastSource = record.reportSource;
      thread.lastUpdatedAt = record.updatedAt;
      clearDiagnosticError();
      if (targetIsActive(target)) updateDiagnosticDatasets();
      return Object.freeze({
        accepted: true,
        deduplicated: true,
        state: stateFor(target),
      });
    }

    sequence += 1;
    record.sequence = sequence;
    setMessageRecord(thread, record);
    thread.lastSource = record.reportSource;
    thread.lastUpdatedAt = record.updatedAt;
    clearDiagnosticError();
    if (targetIsActive(target)) {
      updateDiagnosticDatasets();
      scheduleRender("typed");
    }
    return Object.freeze({
      accepted: true,
      deduplicated: false,
      state: stateFor(target),
    });
  }

  function syncTokenUsage(payload = {}) {
    const bridged = { ...objectValue(payload) };
    const rawUsage = objectValue(
      bridged.tokenUsage ?? bridged.token_usage ?? bridged.usage ?? bridged,
    );
    const normalizedUsage = normalizeTokenUsage(rawUsage);
    const messageId = normalizeId(
      bridged.messageId ??
        bridged.responseId ??
        bridged.eventId ??
        bridged.turnId ??
        bridged.turn_id ??
        rawUsage.messageId ??
        rawUsage.message_id ??
        rawUsage.responseId ??
        rawUsage.response_id ??
        rawUsage.id,
    );

    const threadId = normalizeId(
      bridged.threadId ?? bridged.conversationId ?? bridged.taskId,
    );
    if (normalizeMode(bridged.mode) === "unknown") {
      const resolvedMode = resolveModeForThread(threadId);
      if (resolvedMode === "unknown") {
        if (threadId) queuePendingTokenUsage(threadId, bridged);
        setDiagnosticError("pending-token-usage-context");
        return Object.freeze({
          accepted: false,
          pending: Boolean(threadId),
          reason: "Token usage is waiting for its Work or Codex thread context.",
          state: stateFor(),
        });
      }
      bridged.mode = resolvedMode;
    }

    if (
      bridged.scope == null &&
      (normalizedUsage.inferredScope === "thread" || !messageId)
    ) {
      bridged.scope = "thread";
    }
    if (bridged.scope === "thread") {
      bridged.messageId = THREAD_TOTAL_MESSAGE_ID;
    }
    return updateTokenUsage(bridged);
  }

  function syncTokenContext(payload = {}) {
    const bridged = objectValue(payload);
    const contextResult = applyActiveContext(bridged);
    const providedUsage = bridged.tokenUsage ?? bridged.token_usage ?? bridged.usage;
    if (providedUsage != null && hasAnyUsage(normalizeTokenUsage(providedUsage))) {
      const usageResult = syncTokenUsage({
        ...bridged,
        messageId: bridged.messageId ?? THREAD_TOTAL_MESSAGE_ID,
        scope: bridged.scope ?? "thread",
        source: bridged.source ?? "composer",
      });
      return contextResult.accepted ? usageResult.state : stateFor();
    }
    return contextResult.state;
  }

  function syncTokenMessage(payload = {}) {
    return updateTypedMessage(payload);
  }

  function tokenContractSelfTest() {
    const prefix = `__gpt_codex_token_self_test_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}__`;
    const chatThreadId = `${prefix}:chat`;
    const routedThreadId = `${prefix}:routed`;
    const codexThreadId = `${prefix}:codex`;
    const sourceThreadId = `${prefix}:source`;
    const persistThreadId = `${prefix}:persist`;
    const savedSequence = sequence;
    const savedDuplicateCount = globalDuplicateCount;
    const savedDiagnosticError = lastDiagnosticError;
    let savedPersistedUsage = null;
    let persistedUsageCaptured = false;
    try {
      savedPersistedUsage = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
      persistedUsageCaptured = true;
    } catch {
      persistedUsageCaptured = false;
    }
    const result = {
      authoritativeReplacementWorks: false,
      composerModeIsolationWorks: false,
      delayedModeRoutingWorks: false,
      modeIsolationWorks: false,
      nestedLastWorks: false,
      nestedTotalWorks: false,
      pass: false,
      persistedServerCacheWorks: false,
      protocolSnakeCaseWorks: false,
      serverSourcePrecedenceWorks: false,
      serverTotalPreferredWorks: false,
      stableMessageReplacementWorks: false,
      staleContextPublicationRejected: false,
      thinkingTrackingWorks: false,
    };

    try {
      const nestedTotal = normalizeTokenUsage({
        modelContextWindow: 16_384,
        total: {
          cachedInputTokens: 4,
          inputTokens: 12,
          outputTokens: 5,
          reasoningOutputTokens: 2,
          totalTokens: 17,
        },
      });
      result.nestedTotalWorks =
        nestedTotal.inferredScope === "thread" &&
        nestedTotal.inputTokens === 12 &&
        nestedTotal.outputTokens === 5 &&
        nestedTotal.totalTokens === 17 &&
        nestedTotal.contextWindowTokens === 16_384;

      const nestedLast = normalizeTokenUsage({
        last: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      });
      result.nestedLastWorks =
        nestedLast.inferredScope === "message" &&
        nestedLast.inputTokens === 7 &&
        nestedLast.outputTokens === 3 &&
        nestedLast.totalTokens === 10;

      const protocolUsage = normalizeTokenUsage({
        total_token_usage: {
          cached_input_tokens: 70,
          input_tokens: 80,
          output_tokens: 20,
          reasoning_output_tokens: 8,
          total_tokens: 100,
        },
        last_token_usage: {
          cached_input_tokens: 14,
          input_tokens: 18,
          output_tokens: 6,
          reasoning_output_tokens: 3,
          total_tokens: 24,
        },
        model_context_window: 128_000,
      });
      result.protocolSnakeCaseWorks =
        protocolUsage.inferredScope === "thread" &&
        protocolUsage.inputTokens === 80 &&
        protocolUsage.outputTokens === 20 &&
        protocolUsage.totalTokens === 100 &&
        protocolUsage.currentContextTokens === 24 &&
        protocolUsage.currentReasoningOutputTokens === 3 &&
        protocolUsage.contextWindowTokens === 128_000;

      const currentComposerDecision = composerContextDecision(
        {
          composerGeneration: 52,
          composerId: "work:52",
          mode: "work",
          source: "composer",
        },
        { expectedMode: "work", latestGeneration: 52, latestComposerId: "work:52" },
      );
      const staleComposerDecision = composerContextDecision(
        {
          composerGeneration: 51,
          composerId: "work:51",
          mode: "work",
          source: "composer",
        },
        { expectedMode: "work", latestGeneration: 52, latestComposerId: "work:52" },
      );
      const isolatedComposerDecision = composerContextDecision(
        {
          composerGeneration: 53,
          composerId: "codex:53",
          mode: "codex",
          source: "composer",
        },
        { expectedMode: "work", latestGeneration: 52, latestComposerId: "work:52" },
      );
      const isolatedChatSessionDecision = composerContextDecision(
        { mode: "chat", source: "session" },
        { expectedMode: "work" },
      );
      result.staleContextPublicationRejected =
        currentComposerDecision.accepted === true &&
        staleComposerDecision.accepted === false &&
        staleComposerDecision.reason === "stale-composer-generation";
      result.composerModeIsolationWorks =
        isolatedComposerDecision.accepted === false &&
        isolatedComposerDecision.reason === "composer-mode-mismatch" &&
        isolatedChatSessionDecision.accepted === false &&
        isolatedChatSessionDecision.reason === "composer-mode-mismatch";

      updateTypedMessage({
        mode: "chat",
        role: "user",
        stableId: "turn-1:user",
        text: "before authoritative total",
        threadId: chatThreadId,
      });
      updateTokenUsage({
        messageId: THREAD_TOTAL_MESSAGE_ID,
        mode: "chat",
        scope: "thread",
        threadId: chatThreadId,
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });
      updateTypedMessage({
        mode: "chat",
        role: "assistant",
        stableId: "turn-1:assistant",
        text: "after total",
        threadId: chatThreadId,
      });
      const aggregateAfterTotal = aggregateThread(getThread("chat", chatThreadId));
      result.authoritativeReplacementWorks =
        aggregateAfterTotal.inputTokens === 100 &&
        aggregateAfterTotal.outputTokens > 50 &&
        aggregateAfterTotal.estimatedRecordCount === 1 &&
        aggregateAfterTotal.exactRecordCount === 1;

      const recordsBeforeReplacement = aggregateAfterTotal.messageRecordCount;
      updateTypedMessage({
        messageId: "late-server-id",
        mode: "chat",
        role: "assistant",
        stableId: "turn-1:assistant",
        text: "after total with a longer streamed completion",
        threadId: chatThreadId,
      });
      const aggregateAfterReplacement = aggregateThread(getThread("chat", chatThreadId));
      result.stableMessageReplacementWorks =
        aggregateAfterReplacement.messageRecordCount === recordsBeforeReplacement &&
        aggregateAfterReplacement.estimatedRecordCount === 1 &&
        aggregateAfterReplacement.outputTokens > aggregateAfterTotal.outputTokens;

      rememberThreadMode(routedThreadId, "work");
      const routed = syncTokenUsage({
        source: "self-test",
        threadId: routedThreadId,
        tokenUsage: { last: { inputTokens: 33, outputTokens: 11, totalTokens: 44 } },
      });
      result.delayedModeRoutingWorks =
        routed.accepted === true &&
        routed.state.mode === "work" &&
        routed.state.threadId === routedThreadId &&
        routed.state.input.tokens === 33 &&
        routed.state.output.tokens === 11;

      rememberThreadMode(codexThreadId, "codex");
      const codexRouted = syncTokenUsage({
        source: "self-test",
        threadId: codexThreadId,
        tokenUsage: { total: { inputTokens: 19, outputTokens: 6, totalTokens: 25 } },
      });
      const workStateAfterCodex = stateFor({ mode: "work", threadId: routedThreadId });
      result.modeIsolationWorks =
        codexRouted.accepted === true &&
        codexRouted.state.mode === "codex" &&
        codexRouted.state.input.tokens === 19 &&
        codexRouted.state.output.tokens === 6 &&
        workStateAfterCodex.input.tokens === 33 &&
        workStateAfterCodex.output.tokens === 11;

      rememberThreadMode(sourceThreadId, "work");
      syncTokenUsage({
        mode: "work",
        persist: false,
        source: "server",
        threadId: sourceThreadId,
        tokenUsage: {
          total: {
            inputTokens: 60,
            outputTokens: 40,
            reasoningOutputTokens: 12,
            totalTokens: 101,
          },
          last: {
            inputTokens: 20,
            outputTokens: 5,
            reasoningOutputTokens: 3,
            totalTokens: 25,
          },
          modelContextWindow: 200,
        },
      });
      const staleComposer = syncTokenUsage({
        mode: "work",
        persist: false,
        source: "composer",
        threadId: sourceThreadId,
        tokenUsage: {
          total: { inputTokens: 55, outputTokens: 35, totalTokens: 90 },
          last: { inputTokens: 18, outputTokens: 4, totalTokens: 22 },
          modelContextWindow: 200,
        },
      });
      const sourceState = stateFor({ mode: "work", threadId: sourceThreadId });
      result.serverSourcePrecedenceWorks =
        staleComposer.stale === true &&
        sourceState.lastSource === "server" &&
        sourceState.totalTokens === 101 &&
        sourceState.currentContextTokens === 25 &&
        sourceState.staleUpdates === 1;
      result.serverTotalPreferredWorks =
        sourceState.input.tokens === 60 &&
        sourceState.output.tokens === 40 &&
        sourceState.totalTokens === 101;
      result.thinkingTrackingWorks =
        sourceState.reasoningOutputTokens === 12 &&
        sourceState.currentReasoningOutputTokens === 3 &&
        sourceState.thinking.tokens === 12 &&
        sourceState.thinking.quality === "exact" &&
        sourceState.totalTokens === 101;

      rememberThreadMode(persistThreadId, "codex");
      syncTokenUsage({
        mode: "codex",
        source: "server",
        threadId: persistThreadId,
        tokenUsage: {
          total: {
            cachedInputTokens: 100,
            inputTokens: 120,
            outputTokens: 30,
            reasoningOutputTokens: 10,
            totalTokens: 150,
          },
          last: {
            inputTokens: 40,
            outputTokens: 8,
            reasoningOutputTokens: 6,
            totalTokens: 48,
          },
          modelContextWindow: 256,
        },
      });
      threads.delete(threadKey("codex", persistThreadId));
      const restoredThread = getThread("codex", persistThreadId, true);
      const restored = restorePersistedUsage(restoredThread);
      const restoredState = stateFor({ mode: "codex", threadId: persistThreadId });
      result.persistedServerCacheWorks =
        persistedUsageCaptured &&
        restored === true &&
        restoredState.lastSource === "server-cache" &&
        restoredState.input.tokens === 120 &&
        restoredState.output.tokens === 30 &&
        restoredState.totalTokens === 150 &&
        restoredState.currentContextTokens === 48 &&
        restoredState.reasoningOutputTokens === 10 &&
        restoredState.currentReasoningOutputTokens === 6 &&
        restoredState.thinking.tokens === 10 &&
        restoredState.contextWindowTokens === 256;

      result.pass = Object.entries(result)
        .filter(([key]) => key !== "pass")
        .every(([, value]) => value === true);
      return Object.freeze({ ...result, version: API_VERSION });
    } finally {
      for (const mode of ["chat", "work", "codex"]) {
        threads.delete(threadKey(mode, chatThreadId));
        threads.delete(threadKey(mode, routedThreadId));
        threads.delete(threadKey(mode, codexThreadId));
        threads.delete(threadKey(mode, sourceThreadId));
        threads.delete(threadKey(mode, persistThreadId));
      }
      threadModesById.delete(chatThreadId);
      threadModesById.delete(routedThreadId);
      threadModesById.delete(codexThreadId);
      threadModesById.delete(sourceThreadId);
      threadModesById.delete(persistThreadId);
      pendingUsageByThreadId.delete(chatThreadId);
      pendingUsageByThreadId.delete(routedThreadId);
      pendingUsageByThreadId.delete(codexThreadId);
      pendingUsageByThreadId.delete(sourceThreadId);
      pendingUsageByThreadId.delete(persistThreadId);
      if (persistedUsageCaptured) {
        try {
          if (savedPersistedUsage == null) {
            globalThis.localStorage?.removeItem(STORAGE_KEY);
          } else {
            globalThis.localStorage?.setItem(STORAGE_KEY, savedPersistedUsage);
          }
        } catch {
          // The contract result already records storage unavailability.
        }
      }
      sequence = savedSequence;
      globalDuplicateCount = savedDuplicateCount;
      lastDiagnosticError = savedDiagnosticError;
    }
  }

  function tokenProbe() {
    return getState();
  }

  function refreshMount() {
    scheduleRender("state");
    scheduleMount();
    return stateFor();
  }

  function defineGlobal(name, value, enumerable = false) {
    Object.defineProperty(globalThis, name, {
      configurable: false,
      enumerable,
      value,
      writable: false,
    });
  }

  const api = Object.freeze({
    getState,
    probe: tokenProbe,
    refreshMount,
    setActiveContext,
    syncTokenContext,
    syncTokenMessage,
    syncTokenUsage,
    selfTest: tokenContractSelfTest,
    updateTokenUsage,
    updateTypedMessage,
    resolveModeForThread,
    version: API_VERSION,
  });

  defineGlobal("GPT_CODEX_CUSTOM_TOKEN_HUD", api, true);
  defineGlobal("GPT_CODEX_CUSTOM_TOKEN_HUD_SET_ACTIVE_CONTEXT", setActiveContext);
  defineGlobal("GPT_CODEX_CUSTOM_TOKEN_HUD_UPDATE_TOKEN_USAGE", updateTokenUsage);
  defineGlobal("GPT_CODEX_CUSTOM_TOKEN_HUD_UPDATE_TYPED_MESSAGE", updateTypedMessage);
  defineGlobal("GPT_CODEX_CUSTOM_TOKEN_HUD_GET_STATE", getState);
  defineGlobal("GPT_CODEX_CUSTOM_TOKEN_HUD_REFRESH", refreshMount);
  defineGlobal("GPT_CODEX_CUSTOM_SYNC_TOKEN_CONTEXT", syncTokenContext);
  defineGlobal("GPT_CODEX_CUSTOM_SYNC_TOKEN_USAGE", syncTokenUsage);
  defineGlobal("GPT_CODEX_CUSTOM_SYNC_TOKEN_MESSAGE", syncTokenMessage);
  defineGlobal("GPT_CODEX_CUSTOM_TOKEN_PROBE", tokenProbe);
  defineGlobal("GPT_CODEX_CUSTOM_RESOLVE_TOKEN_MODE", resolveModeForThread);
  defineGlobal("GPT_CODEX_CUSTOM_TOKEN_SELF_TEST", tokenContractSelfTest);

  function mutationTouchesOutsideHud(mutation) {
    if (!(mutation.target instanceof Element)) return true;
    if (!mutation.target.closest(`#${HUD_ID}, #${HOST_ID}`)) return true;
    return [...mutation.addedNodes, ...mutation.removedNodes].some(
      (node) => node instanceof Element && !node.closest(`#${HUD_ID}, #${HOST_ID}`),
    );
  }

  function initialize() {
    if (initialized || !document.body) return;
    initialized = true;
    ensureHud();
    syncModelPickerPresentation();
    updateDiagnosticDatasets();

    bodyObserver = new MutationObserver((mutations) => {
      const pickerStateChanged = mutations.some(
        (mutation) =>
          mutation.type === "attributes" &&
          mutation.attributeName === "data-gpt-codex-model-picker-open",
      );
      if (pickerStateChanged) {
        syncModelPickerPresentation();
        scheduleRender("state");
      }
      if (pickerStateChanged || mutations.some(mutationTouchesOutsideHud)) scheduleMount();
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
    bodyObserver.observe(document.documentElement, {
      attributeFilter: [
        "data-gpt-codex-model-picker-open",
        "data-gpt-codex-pinboard-drawer",
      ],
      attributes: true,
    });

    window.addEventListener("resize", scheduleMount, { passive: true });
    window.addEventListener(
      "scroll",
      () => {
        if (host?.dataset.placement === "fixed") scheduleFixedPosition();
      },
      { capture: true, passive: true },
    );
    scheduleRender("state");
    scheduleMount();
  }

  document.documentElement.dataset.gptCodexTokenHud = "loading";
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
