const CHAT_MODE_ATTRIBUTE = "data-gpt-codex-custom-mode";
const CHAT_AUXILIARY_ATTRIBUTE = "data-gpt-codex-custom-aux-view";
const PICKER_ID = "gpt-codex-custom-model-picker";
const TRIGGER_ID = `${PICKER_ID}-trigger`;
const PANEL_ID = `${PICKER_ID}-panel`;
const GRID_ID = `${PICKER_ID}-grid`;
const ULTRA_DESCRIPTION_ID = `${PICKER_ID}-ultra-description`;
const FAST_DESCRIPTION_ID = `${PICKER_ID}-fast-description`;
const ROOT_OPEN_ATTRIBUTE = "data-gpt-codex-model-picker-open";
const REPLACEMENT_ACTIONABLE_ATTRIBUTE = "data-gpt-codex-model-picker-actionable";
const CONTROL_ID_ATTRIBUTE = "data-gpt-codex-model-picker-control-id";
const CONTROL_KIND_ATTRIBUTE = "data-gpt-codex-model-picker-control-kind";
const MOTION_EFFECTIVE_ATTRIBUTE = "data-gpt-codex-motion";
const MOTION_PREFERENCE_EVENT = "gpt-codex-custom-motion-preference-change";
const MOTION_PREFERENCE_STORAGE_KEY = "gpt-codex-custom.motion-preference.v1";
const MOTION_PREFERENCE_VALUES = new Set(["full", "reduced", "system"]);
const PANEL_EXIT_DURATION_MS = 190;
const SELECTION_MOTION_DURATION_MS = 320;
const ULTRA_SHAKE_DURATION_MS = 680;
const FAST_LIGHTNING_DURATION_MS = 620;

const MATRIX_COLUMN_DEFINITIONS = Object.freeze({
  "extra-high": Object.freeze({ id: "extra-high", label: "Extra high" }),
  high: Object.freeze({ id: "high", label: "High" }),
  low: Object.freeze({ id: "low", label: "Low" }),
  max: Object.freeze({ id: "max", label: "Max" }),
  medium: Object.freeze({ id: "medium", label: "Medium" }),
  minimal: Object.freeze({ id: "minimal", label: "Minimal" }),
  none: Object.freeze({ id: "none", label: "None" }),
  pro: Object.freeze({ id: "pro", label: "Pro" }),
  xhigh: Object.freeze({ id: "xhigh", label: "Extra high" }),
});
const CHAT_MATRIX_COLUMN_IDS = Object.freeze(["low", "medium", "high", "extra-high", "pro"]);
const NATIVE_MATRIX_COLUMN_IDS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const ULTRA_PARTICLE_LAYOUT = Object.freeze([
  [8, 2.2, 3.8, -0.4, -8, 0.82],
  [16, 1.5, 4.5, -2.1, 7, 0.72],
  [23, 2.8, 5.1, -3.8, -5, 0.88],
  [31, 1.8, 3.6, -1.2, 11, 0.68],
  [39, 2.4, 4.2, -3.1, -9, 0.84],
  [47, 1.4, 5.4, -0.9, 6, 0.64],
  [54, 2.9, 4.8, -4.3, -7, 0.9],
  [62, 1.7, 3.9, -2.7, 9, 0.7],
  [70, 2.3, 5.2, -1.7, -11, 0.8],
  [78, 1.4, 4.1, -3.5, 5, 0.66],
  [86, 2.7, 4.7, -0.6, -6, 0.88],
  [92, 1.8, 5.5, -4.8, 8, 0.72],
]);

function getMatrixColumns(mode = getActiveMode(), nativeModels = null) {
  let ids = CHAT_MATRIX_COLUMN_IDS;
  if (mode !== "chat") {
    const available = new Set(
      asArray(nativeModels).flatMap((model) =>
        asArray(model?.supportedReasoningEfforts).map((entry) =>
          normalizeWords(typeof entry === "string" ? entry : entry?.reasoningEffort),
        ),
      ),
    );
    ids = available.size
      ? NATIVE_MATRIX_COLUMN_IDS.filter((id) => available.has(id))
      : ["low", "medium", "high", "xhigh", "max"];
  }
  return ids.map((id, index) => ({
    ...MATRIX_COLUMN_DEFINITIONS[id],
    index,
    label: mode === "chat" && id === "low" ? "Instant" : MATRIX_COLUMN_DEFINITIONS[id].label,
  }));
}

function getMatrixColumn(id, mode, nativeModels = null) {
  return getMatrixColumns(mode, nativeModels).find((column) => column.id === id) ?? null;
}

let chatModelBridge = null;
let nativeModelBridge = null;
let pickerHost = null;
let pickerTrigger = null;
let pickerPanel = null;
let hiddenNativeSlot = null;
let nativePickerAnchor = null;
let nativeAnchorResizeObserver = null;
let confirmedReplacementContext = null;
let panelOpen = false;
let panelCloseTimer = 0;
let panelCloseTransitionHandler = null;
let panelCloseTransitionTarget = null;
let pendingSelectionMotion = null;
let reconcileQueued = false;
let lastRenderSignature = "";
let ultraShakeTimer = 0;
let fastLightningTimer = 0;
let fastPendingTimer = 0;
let fastRequestSequence = 0;
let pendingFastLightning = false;
let pendingFastRequest = null;
let suppressGridClickUntil = 0;
let rovingGridChoiceKey = null;
let panelRenderSequence = 0;
let pendingPanelFocusIdentity = null;
let motionPreference = "full";
let diagnosticElementIdentitySequence = 0;
const diagnosticElementIdentities = new WeakMap();
const systemReducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const lastNonUltraSelectionByRow = new Map();

function normalizeMotionPreference(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return MOTION_PREFERENCE_VALUES.has(normalized) ? normalized : null;
}

function readStoredMotionPreference() {
  try {
    return normalizeMotionPreference(localStorage.getItem(MOTION_PREFERENCE_STORAGE_KEY)) ?? "full";
  } catch {
    return "full";
  }
}

function getEffectiveMotionPreference(preference = motionPreference) {
  if (preference === "reduced") return "reduced";
  if (preference === "system" && systemReducedMotionQuery.matches) return "reduced";
  return "full";
}

function getMotionPreferenceSnapshot() {
  const rootValue = document.documentElement.getAttribute(MOTION_EFFECTIVE_ATTRIBUTE);
  return Object.freeze({
    effective: ["full", "reduced"].includes(rootValue)
      ? rootValue
      : getEffectiveMotionPreference(),
    preference: motionPreference,
    storageKey: MOTION_PREFERENCE_STORAGE_KEY,
    systemReduced: systemReducedMotionQuery.matches,
  });
}

function settleModelPickerForReducedMotion() {
  if (!prefersReducedMotion()) return;
  const animations = new Set([
    ...(pickerHost?.getAnimations?.({ subtree: true }) ?? []),
    ...(pickerPanel?.getAnimations?.({ subtree: true }) ?? []),
  ]);
  for (const animation of animations) {
    try {
      animation.cancel();
    } catch {
      // A renderer-owned animation may finish between collection and cancellation.
    }
  }
  window.clearTimeout(ultraShakeTimer);
  ultraShakeTimer = 0;
  pickerPanel?.classList.remove("gpt-codex-model-picker--ultra-shake");
  for (const composer of document.querySelectorAll('[data-gpt-codex-ultra-shake="true"]')) {
    composer.removeAttribute("data-gpt-codex-ultra-shake");
  }
  window.clearTimeout(fastLightningTimer);
  fastLightningTimer = 0;
  pickerPanel
    ?.querySelector(".gpt-codex-model-picker__fast-toggle")
    ?.removeAttribute("data-fast-effect");
  pendingFastLightning = false;
  pendingSelectionMotion = null;
  if (!pickerPanel) return;
  cancelPanelMotionTimers();
  if (panelOpen) {
    pickerPanel.hidden = false;
    pickerPanel.inert = false;
    pickerPanel.setAttribute("aria-hidden", "false");
    pickerPanel.dataset.motion = "open";
  } else {
    finalizePanelClose();
  }
}

function applyMotionPreference({ emit = true, settle = true } = {}) {
  const effective = getEffectiveMotionPreference();
  document.documentElement.setAttribute(MOTION_EFFECTIVE_ATTRIBUTE, effective);
  if (settle && effective === "reduced") settleModelPickerForReducedMotion();
  const snapshot = getMotionPreferenceSnapshot();
  if (emit) {
    window.dispatchEvent(new CustomEvent(MOTION_PREFERENCE_EVENT, { detail: snapshot }));
  }
  return snapshot;
}

function setMotionPreference(value, options = undefined) {
  const preference = normalizeMotionPreference(value);
  if (!preference) return null;
  const persist = !(options && typeof options === "object" && options.persist === false);
  let persisted = !persist;
  if (persist) {
    try {
      localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, preference);
      persisted = localStorage.getItem(MOTION_PREFERENCE_STORAGE_KEY) === preference;
    } catch {
      persisted = false;
    }
  }
  motionPreference = preference;
  return Object.freeze({ ...applyMotionPreference(), persisted });
}

function handleSystemMotionPreferenceChange() {
  if (motionPreference === "system") applyMotionPreference();
}

function prefersReducedMotion() {
  return document.documentElement.getAttribute(MOTION_EFFECTIVE_ATTRIBUTE) === "reduced";
}

motionPreference = readStoredMotionPreference();
applyMotionPreference({ emit: false, settle: false });

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeThinkingEffort(value) {
  return value == null ? null : String(value);
}

function normalizeSelection(value) {
  if (!value || typeof value !== "object") return null;
  const slug = String(value.slug ?? "").trim();
  if (!slug) return null;
  return Object.freeze({
    slug,
    thinkingEffort: normalizeThinkingEffort(value.thinkingEffort),
    versionId: value.versionId == null ? null : String(value.versionId),
  });
}

function selectionKey(value) {
  const selection = normalizeSelection(value);
  return selection ? `${selection.slug}\u0000${selection.thinkingEffort ?? ""}` : "";
}

function selectionsMatch(left, right) {
  const a = normalizeSelection(left);
  const b = normalizeSelection(right);
  if (!a || !b || selectionKey(a) !== selectionKey(b)) return false;
  return a.versionId == null || b.versionId == null || a.versionId === b.versionId;
}

function normalizeWords(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isUltraOption(option) {
  const effort = normalizeWords(option?.thinkingEffort);
  const descriptor = normalizeWords(
    [option?.title, option?.selectedLabel, option?.lane, option?.thinkingEffort].filter(Boolean).join(" "),
  );
  return effort === "ultra" || /\bultra\b/iu.test(descriptor);
}

function detectMatrixColumn(option, defaultModelSlug, mode = "chat") {
  if (isUltraOption(option)) return null;
  const effort = normalizeWords(option?.thinkingEffort);
  const lane = normalizeWords(option?.lane);
  const label = normalizeWords([option?.title, option?.selectedLabel].filter(Boolean).join(" "));

  if (/\bpro\b/iu.test(label) || lane === "pro") return getMatrixColumn("pro", mode);
  if (/\b(?:extra high|x high|xhigh)\b/iu.test(label)) {
    return getMatrixColumn("extra-high", mode);
  }
  if (/\b(?:low|min|minimum|instant)\b/iu.test(label)) return getMatrixColumn("low", mode);
  if (/\b(?:medium|balanced|standard)\b/iu.test(label)) return getMatrixColumn("medium", mode);
  if (/\bhigh\b/iu.test(label)) return getMatrixColumn("high", mode);

  if (["none", "minimal", "zero", "min", "low"].includes(effort) || ["instant", "thinking mini"].includes(lane)) {
    return getMatrixColumn("low", mode);
  }
  if (["standard", "medium"].includes(effort)) return getMatrixColumn("medium", mode);
  if (["extended", "high"].includes(effort)) return getMatrixColumn("high", mode);
  if (["xhigh", "x high"].includes(effort)) return getMatrixColumn("extra-high", mode);
  if (effort === "max") return getMatrixColumn(mode === "chat" ? "extra-high" : "max", mode);
  if (["auto", "thinking"].includes(lane)) return getMatrixColumn("medium", mode);
  if (option?.slug === defaultModelSlug) return getMatrixColumn("medium", mode);
  return null;
}

function normalizeChoice(option, versionId, rowId, defaultModelSlug) {
  const selection = normalizeSelection({
    slug: option?.slug,
    thinkingEffort: option?.thinkingEffort,
    versionId,
  });
  if (!selection) return null;
  const ultra = isUltraOption(option);
  return Object.freeze({
    ...selection,
    column: ultra ? null : detectMatrixColumn(option, defaultModelSlug, "chat"),
    description:
      typeof option.description === "string" && option.description.trim()
        ? option.description.trim()
        : null,
    key: `${rowId}:${selection.slug}:${selection.thinkingEffort ?? ""}`,
    label:
      String(option.selectedLabel ?? option.title ?? option.slug ?? "Model").trim() || "Model",
    lane: option.lane == null ? null : String(option.lane),
    rowId,
    ultra,
  });
}

function createRowSource({ defaultModelSlug, id, label, options, versionId }) {
  return Object.freeze({
    defaultModelSlug: defaultModelSlug == null ? null : String(defaultModelSlug),
    id,
    label: String(label || "Models"),
    options: asArray(options),
    versionId: versionId == null ? null : String(versionId),
  });
}

function buildRowSources(data) {
  const sources = [];
  const seen = new Set();
  for (const [index, version] of asArray(data?.versionOptions).entries()) {
    if (!version || typeof version !== "object") continue;
    const versionId = String(version.id ?? `version-${index}`);
    const options = asArray(version.options);
    for (const option of options) {
      const key = selectionKey(option);
      if (key) seen.add(key);
    }
    sources.push(
      createRowSource({
        defaultModelSlug: version.defaultModelSlug ?? data?.defaultModelSlug,
        id: `version:${versionId}`,
        label: version.label ?? version.id ?? `Version ${index + 1}`,
        options,
        versionId,
      }),
    );
  }

  const additional = asArray(data?.options).filter((option) => !seen.has(selectionKey(option)));
  if (additional.length || sources.length === 0) {
    sources.push(
      createRowSource({
        defaultModelSlug: data?.defaultModelSlug,
        id: sources.length ? "available:additional" : "available",
        label: sources.length ? "Other account models" : "Models",
        options: additional.length ? additional : data?.options,
        versionId: null,
      }),
    );
  }

  if (asArray(data?.internalOptions).length) {
    sources.push(
      createRowSource({
        defaultModelSlug: data?.defaultModelSlug,
        id: "available:internal",
        label: "Additional models",
        options: data.internalOptions,
        versionId: null,
      }),
    );
  }
  return sources;
}

function buildModelRows(data, selected) {
  return buildRowSources(data)
    .map((source) => {
      const choices = source.options
        .map((option) => normalizeChoice(option, source.versionId, source.id, source.defaultModelSlug))
        .filter(Boolean);
      const cells = new Map();
      let ultraChoice = null;
      for (const choice of choices) {
        if (choice.ultra) {
          if (!ultraChoice || selectionsMatch(choice, selected)) ultraChoice = choice;
          continue;
        }
        if (!choice.column) continue;
        const existing = cells.get(choice.column.id);
        if (!existing || selectionsMatch(choice, selected)) cells.set(choice.column.id, choice);
      }
      const selectedChoice = choices.find((choice) => selectionsMatch(choice, selected)) ?? null;
      const defaultChoice =
        choices.find(
          (choice) => !choice.ultra && choice.slug === source.defaultModelSlug && choice.column,
        ) ??
        cells.get("medium") ??
        cells.get("high") ??
        [...cells.values()][0] ??
        null;
      return Object.freeze({
        active: selectedChoice != null,
        choices,
        defaultChoice,
        id: source.id,
        label: source.label,
        selectedChoice,
        supportedCells: cells,
        ultraChoice,
      });
    })
    .filter((row) => row.supportedCells.size > 0 || row.ultraChoice != null);
}

function normalizeNativeModelChoice(model, effortOption, rowId, columns) {
  const effort = normalizeThinkingEffort(
    typeof effortOption === "string" ? effortOption : effortOption?.reasoningEffort,
  );
  const selection = normalizeSelection({
    slug: model?.model,
    thinkingEffort: effort,
    versionId: null,
  });
  if (!selection || !effort) return null;
  const ultra = isUltraOption({
    thinkingEffort: effort,
    title: typeof effortOption === "object" ? effortOption?.label : null,
  });
  const effortId = normalizeWords(effort).replace(/\s+/gu, "");
  const column = ultra ? null : columns.find((candidate) => candidate.id === effortId) ?? null;
  const modelLabel = String(model?.displayName ?? model?.model ?? "Model").trim() || "Model";
  const effortLabel = column?.label ?? (ultra ? "Ultra" : effort);
  return Object.freeze({
    ...selection,
    column,
    description:
      (typeof effortOption === "object" &&
        typeof effortOption?.description === "string" &&
        effortOption.description.trim()) ||
      (typeof model?.description === "string" && model.description.trim()) ||
      null,
    key: `${rowId}:${selection.slug}:${selection.thinkingEffort}`,
    label: `${modelLabel} ${effortLabel}`,
    lane: "reasoning",
    rowId,
    ultra,
  });
}

function buildNativeModelRows(models, selected, columns = getMatrixColumns("codex", models)) {
  const selectedKey = selectionKey(selected);
  return asArray(models)
    .map((model, index) => {
      if (!model || typeof model !== "object") return null;
      const modelSlug = String(model.model ?? "").trim();
      if (!modelSlug) return null;
      const rowId = `native:${modelSlug}`;
      const choices = asArray(model.supportedReasoningEfforts)
        .map((effort) => normalizeNativeModelChoice(model, effort, rowId, columns))
        .filter(Boolean);
      const cells = new Map();
      let ultraChoice = null;
      for (const choice of choices) {
        if (choice.ultra) {
          if (!ultraChoice || selectionKey(choice) === selectedKey) ultraChoice = choice;
          continue;
        }
        if (!choice.column) continue;
        const existing = cells.get(choice.column.id);
        if (!existing || selectionKey(choice) === selectedKey) cells.set(choice.column.id, choice);
      }
      const selectedChoice = choices.find((choice) => selectionKey(choice) === selectedKey) ?? null;
      const defaultEffort = normalizeThinkingEffort(model.defaultReasoningEffort);
      const defaultChoice =
        choices.find(
          (choice) => !choice.ultra && choice.thinkingEffort === defaultEffort && choice.column,
        ) ??
        cells.get("medium") ??
        cells.get("high") ??
        [...cells.values()][0] ??
        null;
      return Object.freeze({
        active: selectedChoice != null,
        choices,
        defaultChoice,
        id: rowId,
        label: String(model.displayName ?? modelSlug ?? `Model ${index + 1}`),
        selectedChoice,
        supportedCells: cells,
        ultraChoice,
      });
    })
    .filter((row) => row && (row.supportedCells.size > 0 || row.ultraChoice != null));
}

function findRememberedChoice(row) {
  const rememberedKey = lastNonUltraSelectionByRow.get(row?.id);
  if (!rememberedKey || !row) return null;
  return [...row.supportedCells.values()].find((choice) => selectionKey(choice) === rememberedKey) ?? null;
}

function getActiveMode() {
  const root = document.documentElement;
  if (
    root.getAttribute(CHAT_MODE_ATTRIBUTE) === "chat" &&
    !root.hasAttribute(CHAT_AUXILIARY_ATTRIBUTE)
  ) {
    return "chat";
  }
  const nativeMode = normalizeWords(globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES?.mode);
  return ["work", "codex"].includes(nativeMode) ? nativeMode : null;
}

function getActiveBridge() {
  const mode = getActiveMode();
  if (mode === "chat") return chatModelBridge;
  if (mode && normalizeWords(nativeModelBridge?.mode) === mode) return nativeModelBridge;
  return null;
}

function readPickerState() {
  const mode = getActiveMode();
  const bridge = getActiveBridge();
  const native = bridge?.kind === "native";
  const query = native ? null : bridge?.query ?? bridge?.state ?? null;
  const selected = normalizeSelection(bridge?.selected);
  const nativeStatus = normalizeWords(bridge?.status);
  const loading = native
    ? bridge == null ||
      bridge.models == null ||
      ["pending", "loading", "idle"].includes(nativeStatus)
    : query == null ||
      query.isLoading === true ||
      query.isPending === true ||
      query.isPlaceholderData === true ||
      query.status === "pending" ||
      query.status === "loading";
  const error = native
    ? ["error", "failed"].includes(nativeStatus)
    : query?.isError === true || query?.status === "error" || query?.error != null;
  const columns = getMatrixColumns(mode, native ? bridge?.models : null);
  const rows = loading
    ? []
    : native
      ? buildNativeModelRows(bridge.models, selected, columns)
      : buildModelRows(query?.data, selected);
  const selectedRow = rows.find((row) => row.active) ?? null;
  const selectedChoice = selectedRow?.selectedChoice ?? null;
  const ultraEngaged = selectedChoice?.ultra === true;
  if (selectedRow && selectedChoice && !ultraEngaged && selectedChoice.column) {
    lastNonUltraSelectionByRow.set(selectedRow.id, selectionKey(selectedChoice));
  }
  const activeRow =
    selectedRow ??
    rows.find((row) =>
      [...row.supportedCells.values()].some((choice) => choice.slug === query?.data?.defaultModelSlug),
    ) ??
    rows[0] ??
    null;
  const displayChoice = ultraEngaged
    ? findRememberedChoice(activeRow) ?? activeRow?.defaultChoice ?? null
    : selectedChoice?.column
      ? selectedChoice
      : activeRow?.defaultChoice ?? null;
  const unavailable = !loading && (error || rows.length === 0);
  const serviceTier = native && bridge?.serviceTier && typeof bridge.serviceTier === "object"
    ? bridge.serviceTier
    : null;
  const fastSupported = Boolean(
    native && typeof bridge?.setFastEnabled === "function" && serviceTier?.fastValue != null,
  );
  return Object.freeze({
    activeRow,
    bridge,
    columns,
    displayChoice,
    error,
    fastAvailable: fastSupported && serviceTier?.canToggleFast === true,
    fastEffective: fastSupported && serviceTier?.fastEffective === true,
    fastEnabled: fastSupported && serviceTier?.fastEnabled === true,
    fastSupported,
    loading,
    mode,
    native,
    query,
    rows,
    selected,
    selectedChoice,
    unavailable,
    ultraEngaged,
  });
}

function isChatModeActive() {
  return getActiveMode() === "chat";
}

function isVisibleElement(element) {
  if (!(element instanceof HTMLElement) || element.hidden) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  for (let current = element; current instanceof Element; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.contentVisibility === "hidden" ||
      Number(style.opacity) <= 0.001
    ) {
      return false;
    }
  }
  return true;
}

function isKeyboardActionableElement(element, { requireVisible = true } = {}) {
  if (!(element instanceof HTMLElement) || !element.isConnected || element.hidden) return false;
  if (element.closest("[inert]") || element.closest('[aria-hidden="true"]')) return false;
  if (("disabled" in element && element.disabled) || element.getAttribute("aria-disabled") === "true") {
    return false;
  }
  return element.tabIndex >= 0 && (!requireVisible || isVisibleElement(element));
}

function pickerStateSupportsActions(state) {
  return Boolean(
    state?.bridge &&
      typeof state.bridge.select === "function" &&
      !state.loading &&
      !state.unavailable &&
      state.rows.some((row) => row.supportedCells.size > 0 || row.ultraChoice != null),
  );
}

function setRootPickerOpenState(open) {
  document.documentElement.setAttribute(ROOT_OPEN_ATTRIBUTE, String(Boolean(open)));
}

function clearRootPickerOpenState() {
  document.documentElement.removeAttribute(ROOT_OPEN_ATTRIBUTE);
}

function setReplacementActionable(actionable) {
  if (!pickerHost) return;
  pickerHost.setAttribute(REPLACEMENT_ACTIONABLE_ATTRIBUTE, String(Boolean(actionable)));
  if (actionable) {
    pickerHost.inert = false;
    pickerHost.removeAttribute("aria-hidden");
    return;
  }
  pickerHost.inert = true;
  pickerHost.setAttribute("aria-hidden", "true");
}

function setControlIdentity(element, kind, key = kind) {
  element.setAttribute(CONTROL_ID_ATTRIBUTE, `${kind}:${key}`);
  element.setAttribute(CONTROL_KIND_ATTRIBUTE, kind);
  return element;
}

function getFocusedPanelControlIdentity() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !pickerPanel?.contains(active)) return null;
  return active.getAttribute(CONTROL_ID_ATTRIBUTE);
}

function findNativeModelTrigger(composer = null) {
  const composerScoped = composer instanceof Element;
  const candidates = [
    ...(composer ?? document).querySelectorAll('[data-codex-intelligence-trigger="true"]'),
  ].filter(
    (element) =>
      element.isConnected &&
      (composerScoped || !element.closest('[data-pip-obstacle="quick-chat"]')),
  );
  if (composerScoped) return candidates.length === 1 ? candidates[0] : null;
  return (
    candidates.find((element) => isVisibleElement(element)) ??
    candidates.find(
      (element) =>
        element === nativePickerAnchor ||
        element.getAttribute("data-gpt-codex-model-picker-native-slot") === "true",
    ) ??
    // A trigger already suppressed by this picker remains the correct anchor
    // even though it is intentionally no longer visibly detectable.
    candidates[0] ??
    null
  );
}

function findActiveComposer() {
  const mode = getActiveMode();
  if (!mode) return null;
  if (mode === "chat") {
    const surface = document.querySelector('[data-pip-obstacle="quick-chat"]');
    return surface?.querySelector('form[data-thread-find-composer="true"]') ?? null;
  }
  const nativeTrigger = findNativeModelTrigger();
  const triggerForm =
    nativeTrigger?.closest('form[data-thread-find-composer="true"]') ?? nativeTrigger?.closest("form");
  if (triggerForm) return triggerForm;
  const nativeComposerSurface = nativeTrigger?.closest(".composer-surface-chrome");
  if (nativeComposerSurface) return nativeComposerSurface;
  return [...document.querySelectorAll('form[data-thread-find-composer="true"]')].find(
    (form) => isVisibleElement(form) && !form.closest('[data-pip-obstacle="quick-chat"]'),
  ) ?? null;
}

function findActionButton(composer) {
  const buttons = [...composer.querySelectorAll("button")];
  return (
    buttons.find((button) => button.type === "submit") ??
    buttons.find((button) => /^(send|stop)$/iu.test(button.getAttribute("aria-label") ?? "")) ??
    buttons.at(-1) ??
    null
  );
}

function resolveFooterInsertion(composer) {
  const nativeTrigger = findNativeModelTrigger(composer);
  const actionButton = findActionButton(composer);
  if (nativeTrigger) {
    let insertionSlot = nativeTrigger;
    if (actionButton) {
      while (
        insertionSlot.parentElement &&
        insertionSlot.parentElement !== composer &&
        !insertionSlot.parentElement.contains(actionButton)
      ) {
        insertionSlot = insertionSlot.parentElement;
      }
    }
    return {
      before: insertionSlot,
      nativeSlot: nativeTrigger,
      parent: insertionSlot.parentElement,
    };
  }
  if (!actionButton?.parentElement) return null;
  return { before: actionButton, nativeSlot: null, parent: actionButton.parentElement };
}

function restoreNativeModelSlot() {
  const slot = hiddenNativeSlot;
  const element = slot?.element ?? null;
  // Restore our accessibility markers even if the native renderer detached
  // the node. It may reuse that same node later, and it must come back as an
  // actionable fallback rather than carrying stale suppression state.
  if (slot && element instanceof HTMLElement) {
    if (slot.ariaHidden == null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", slot.ariaHidden);
    if (slot.inert) element.setAttribute("inert", "");
    else element.removeAttribute("inert");
    if (slot.suppression == null) {
      element.removeAttribute("data-gpt-codex-model-picker-suppression");
    } else {
      element.setAttribute("data-gpt-codex-model-picker-suppression", slot.suppression);
    }
    element.removeAttribute("data-gpt-codex-model-picker-native-slot");
  }
  nativeAnchorResizeObserver?.disconnect();
  hiddenNativeSlot = null;
  nativePickerAnchor = null;
  return element?.isConnected ? element : null;
}

function nativeFallbackIsReady(element) {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  if (hiddenNativeSlot?.element === element) {
    return Boolean(
      hiddenNativeSlot.fallbackVisible &&
        hiddenNativeSlot.fallbackKeyboardActionable &&
        !("disabled" in element && element.disabled) &&
        element.tabIndex >= 0,
    );
  }
  return isVisibleElement(element) && isKeyboardActionableElement(element);
}

function observeNativePickerAnchor(element) {
  if (typeof ResizeObserver !== "function") return;
  nativeAnchorResizeObserver ??= new ResizeObserver(() => scheduleReconcile());
  nativeAnchorResizeObserver.disconnect();
  if (element?.isConnected) nativeAnchorResizeObserver.observe(element);
  if (pickerHost?.isConnected) nativeAnchorResizeObserver.observe(pickerHost);
}

function suppressNativeModelSlot(element, { preserveLayout = false } = {}) {
  if (!element) {
    restoreNativeModelSlot();
    return false;
  }
  if (!nativeFallbackIsReady(element)) return false;
  const suppression = preserveLayout ? "fixed" : "inline";
  if (hiddenNativeSlot?.element === element) {
    if (element.getAttribute("aria-hidden") !== "true") element.setAttribute("aria-hidden", "true");
    if (!element.hasAttribute("inert")) element.setAttribute("inert", "");
    if (element.getAttribute("data-gpt-codex-model-picker-native-slot") !== "true") {
      element.setAttribute("data-gpt-codex-model-picker-native-slot", "true");
    }
    if (element.getAttribute("data-gpt-codex-model-picker-suppression") !== suppression) {
      element.setAttribute("data-gpt-codex-model-picker-suppression", suppression);
    }
    nativePickerAnchor = element;
    observeNativePickerAnchor(element);
    return true;
  }
  restoreNativeModelSlot();
  hiddenNativeSlot = {
    ariaHidden: element.getAttribute("aria-hidden"),
    element,
    fallbackKeyboardActionable: isKeyboardActionableElement(element),
    fallbackVisible: isVisibleElement(element),
    inert: element.hasAttribute("inert"),
    suppression: element.getAttribute("data-gpt-codex-model-picker-suppression"),
  };
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("inert", "");
  element.setAttribute("data-gpt-codex-model-picker-native-slot", "true");
  element.setAttribute("data-gpt-codex-model-picker-suppression", suppression);
  nativePickerAnchor = element;
  observeNativePickerAnchor(element);
  return true;
}

function getDiagnosticElementIdentity(element) {
  if (!(element instanceof Element)) return null;
  if (!diagnosticElementIdentities.has(element)) {
    diagnosticElementIdentitySequence += 1;
    diagnosticElementIdentities.set(element, diagnosticElementIdentitySequence);
  }
  return diagnosticElementIdentities.get(element);
}

function getDiagnosticRect(element) {
  if (!(element instanceof Element) || !element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return Object.freeze({
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width,
  });
}

function diagnosticRectsOverlap(left, right) {
  if (
    !left ||
    !right ||
    left.width <= 0 ||
    left.height <= 0 ||
    right.width <= 0 ||
    right.height <= 0
  ) {
    return false;
  }
  return (
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top
  );
}

function getNativeModelTriggerClassification({ replacementContextConfirmed = false } = {}) {
  const allTriggers = [
    ...document.querySelectorAll('[data-codex-intelligence-trigger="true"]'),
  ].filter((element) => !element.closest(`#${PICKER_ID}`));
  const mode = getActiveMode();
  const confirmedComposer =
    replacementContextConfirmed && confirmedReplacementContext?.composer?.isConnected
      ? confirmedReplacementContext.composer
      : null;
  const activeComposer = confirmedComposer ?? findActiveComposer();
  const activeInsertion = activeComposer ? resolveFooterInsertion(activeComposer) : null;
  const confirmedSlot =
    replacementContextConfirmed && confirmedReplacementContext?.nativeSlot?.isConnected
      ? confirmedReplacementContext.nativeSlot
      : null;
  const hiddenSlot = hiddenNativeSlot?.element?.isConnected ? hiddenNativeSlot.element : null;
  const activeSlot = confirmedSlot ?? activeInsertion?.nativeSlot ?? null;
  const customAnchorRect = getDiagnosticRect(pickerTrigger ?? pickerHost);
  const diagnostics = allTriggers.map((trigger, documentIndex) => {
    const composer =
      trigger.closest('form[data-thread-find-composer="true"]') ??
      trigger.closest(".composer-surface-chrome") ??
      trigger.closest("form");
    const quickChat = Boolean(trigger.closest('[data-pip-obstacle="quick-chat"]'));
    const inActiveComposer = Boolean(activeComposer?.contains(trigger));
    const rect = getDiagnosticRect(trigger);
    const overlapsCustomAnchor =
      inActiveComposer && diagnosticRectsOverlap(rect, customAnchorRect);
    const allowedForMode = mode === "chat" ? quickChat : !quickChat;
    const exactSlot =
      trigger === activeSlot ||
      trigger === confirmedSlot ||
      (trigger === hiddenSlot && (replacementContextConfirmed || inActiveComposer));
    const competing = Boolean(allowedForMode && (exactSlot || overlapsCustomAnchor));
    const suppression = Object.freeze({
      ariaHidden: trigger.getAttribute("aria-hidden"),
      inert: trigger.hasAttribute("inert"),
      marker:
        trigger.getAttribute("data-gpt-codex-model-picker-native-slot") === "true",
      mode: trigger.getAttribute("data-gpt-codex-model-picker-suppression"),
    });
    return Object.freeze({
      activeSlot: trigger === activeSlot,
      competing,
      composerIdentity: getDiagnosticElementIdentity(composer),
      confirmedSlot: trigger === confirmedSlot,
      documentIndex,
      hiddenSlot: trigger === hiddenSlot,
      identity: getDiagnosticElementIdentity(trigger),
      inActiveComposer,
      keyboardActionable: isKeyboardActionableElement(trigger),
      overlapsCustomAnchor,
      quickChat,
      rect,
      suppression,
      visible: isVisibleElement(trigger),
    });
  });
  const competingIndexes = new Set(
    diagnostics.filter((diagnostic) => diagnostic.competing).map((diagnostic) => diagnostic.documentIndex),
  );
  const competingTriggers = allTriggers.filter((_, index) => competingIndexes.has(index));
  const visibleAllTriggers = allTriggers.filter((element) => isVisibleElement(element));
  const visibleCompetingTriggers = competingTriggers.filter((element) => isVisibleElement(element));
  const visibleOtherTriggers = visibleAllTriggers.filter(
    (element) => !competingTriggers.includes(element),
  );
  const unrelatedSuppressedTriggers = allTriggers.filter((element, index) => {
    if (competingIndexes.has(index)) return false;
    return (
      element.getAttribute("data-gpt-codex-model-picker-native-slot") === "true" ||
      element.hasAttribute("data-gpt-codex-model-picker-suppression")
    );
  });
  return Object.freeze({
    activeComposerIdentity: getDiagnosticElementIdentity(activeComposer),
    allTriggers,
    competingTriggers,
    diagnostics,
    unrelatedSuppressedTriggers,
    visibleAllTriggers,
    visibleCompetingTriggers,
    visibleOtherTriggers,
  });
}

function getVisibleNativeModelTriggers(classification = getNativeModelTriggerClassification()) {
  return classification.visibleCompetingTriggers;
}

function createLightningIcon(className = "gpt-codex-model-picker__lightning") {
  const icon = document.createElement("span");
  icon.className = className;
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    '<svg viewBox="0 0 20 20" fill="none"><path d="M11.6 1.9 4.8 10h4.3l-.7 8.1 6.8-9.2h-4.1l.5-7Z" fill="currentColor"/></svg>';
  return icon;
}

function clearFastPendingState(requestId = null) {
  if (requestId != null && pendingFastRequest?.id !== requestId) return false;
  window.clearTimeout(fastPendingTimer);
  fastPendingTimer = 0;
  pendingFastRequest = null;
  pickerHost?.removeAttribute("data-fast-pending");
  const button = pickerPanel?.querySelector(".gpt-codex-model-picker__fast-toggle");
  if (button) {
    button.closest(".gpt-codex-model-picker__fast-control")?.setAttribute("data-pending", "false");
    button.dataset.pending = "false";
    button.setAttribute("aria-busy", "false");
  }
  return true;
}

function bridgeScopeKey(bridge) {
  return [
    normalizeWords(bridge?.mode),
    String(bridge?.conversationId ?? bridge?.scope?.conversationId ?? ""),
    String(bridge?.hostId ?? bridge?.scope?.hostId ?? ""),
  ].join(":");
}

function failFastRequest(error, requestId = pendingFastRequest?.id ?? null) {
  if (!clearFastPendingState(requestId)) return;
  if (pickerHost) pickerHost.dataset.error = "true";
  if (pickerTrigger) pickerTrigger.title = String(error?.message ?? error);
  renderPicker({ force: true });
}

function observeFastBridgeSnapshot(bridge) {
  if (!pendingFastRequest || bridgeScopeKey(bridge) !== pendingFastRequest.scopeKey) return;
  const confirmed = bridge?.serviceTier?.fastEnabled;
  if (typeof confirmed !== "boolean" || confirmed !== pendingFastRequest.desired) return;
  const requestId = pendingFastRequest.id;
  const shouldStrike = confirmed && pendingFastRequest.previous !== true;
  clearFastPendingState(requestId);
  pickerHost?.removeAttribute("data-error");
  pickerTrigger?.removeAttribute("title");
  if (shouldStrike) pendingFastLightning = true;
}

function runFastLightning() {
  if (prefersReducedMotion()) return;
  window.clearTimeout(fastLightningTimer);
  const button = pickerPanel?.querySelector(".gpt-codex-model-picker__fast-toggle");
  if (!button) return;
  button.removeAttribute("data-fast-effect");
  void button.offsetWidth;
  button.dataset.fastEffect = "striking";
  fastLightningTimer = window.setTimeout(() => {
    button.removeAttribute("data-fast-effect");
    fastLightningTimer = 0;
  }, FAST_LIGHTNING_DURATION_MS);
}

function requestFastMode(state) {
  const scopeKey = bridgeScopeKey(state.bridge);
  if (pendingFastRequest && pendingFastRequest.scopeKey !== scopeKey) {
    clearFastPendingState(pendingFastRequest.id);
    pendingFastLightning = false;
  }
  if (!state.fastAvailable || pendingFastRequest || typeof state.bridge?.setFastEnabled !== "function") {
    return;
  }
  const desired = !state.fastEnabled;
  const requestId = ++fastRequestSequence;
  pendingFastRequest = Object.freeze({
    desired,
    id: requestId,
    mode: state.mode,
    previous: state.fastEnabled,
    scopeKey,
  });
  pickerHost?.removeAttribute("data-error");
  pickerTrigger?.removeAttribute("title");
  pickerHost?.setAttribute("data-fast-pending", "true");
  const button = pickerPanel?.querySelector(".gpt-codex-model-picker__fast-toggle");
  if (button) {
    if (document.activeElement === button) {
      pendingPanelFocusIdentity = button.getAttribute(CONTROL_ID_ATTRIBUTE);
    }
    button.closest(".gpt-codex-model-picker__fast-control")?.setAttribute("data-pending", "true");
    button.disabled = true;
    button.dataset.pending = "true";
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-disabled", "true");
  }
  fastPendingTimer = window.setTimeout(
    () =>
      failFastRequest(
        new Error("Fast mode was not confirmed by the native service tier."),
        requestId,
      ),
    5_500,
  );
  try {
    const result = state.bridge.setFastEnabled(desired);
    if (result && typeof result.then === "function") {
      result.catch((error) => failFastRequest(error, requestId));
    }
  } catch (error) {
    failFastRequest(error, requestId);
  }
}

function createFastEffects() {
  const effects = document.createElement("span");
  effects.className = "gpt-codex-model-picker__fast-effects";
  effects.setAttribute("aria-hidden", "true");
  const flash = document.createElement("span");
  flash.className = "gpt-codex-model-picker__fast-flash";
  const strike = document.createElement("span");
  strike.className = "gpt-codex-model-picker__fast-strike";
  strike.innerHTML =
    '<svg viewBox="0 0 28 48" fill="none"><path d="m18 1-9 18h7l-6 28 17-25h-8L18 1Z"/></svg>';
  effects.append(flash, strike);
  for (let index = 0; index < 8; index += 1) {
    const spark = document.createElement("span");
    spark.className = "gpt-codex-model-picker__fast-spark";
    spark.dataset.sparkIndex = String(index);
    effects.appendChild(spark);
  }
  return effects;
}

function createFastToggle(state) {
  const control = document.createElement("div");
  control.className = "gpt-codex-model-picker__fast-control";
  control.dataset.available = String(state.fastAvailable);
  control.dataset.engaged = String(state.fastEnabled);
  const pending = pendingFastRequest?.scopeKey === bridgeScopeKey(state.bridge);
  control.dataset.pending = String(pending);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "gpt-codex-model-picker__fast-toggle";
  setControlIdentity(button, "fast");
  button.dataset.effective = String(state.fastEffective);
  button.dataset.pending = String(pending);
  button.disabled = !state.fastAvailable || pending;
  button.setAttribute("aria-busy", String(pending));
  button.setAttribute("aria-checked", String(state.fastEnabled));
  button.setAttribute("aria-describedby", FAST_DESCRIPTION_ID);
  button.setAttribute("aria-disabled", String(!state.fastAvailable || pending));
  button.setAttribute(
    "aria-label",
    `${state.fastEnabled ? "Disable" : "Enable"} Fast for ${state.activeRow?.label ?? "the selected model"}`,
  );
  button.setAttribute("role", "switch");
  button.title = state.fastSupported
    ? state.fastAvailable
      ? state.fastEnabled
        ? "Use standard service tier"
        : "Use the account-backed Fast service tier"
      : "Fast is not available for the selected model or account"
    : "Fast is available in Work and Codex when the account exposes that service tier";
  button.addEventListener("click", () => requestFastMode(state));

  const icon = createLightningIcon("gpt-codex-model-picker__fast-icon");
  const copy = document.createElement("span");
  copy.className = "gpt-codex-model-picker__fast-copy";
  const label = document.createElement("strong");
  label.textContent = "Fast";
  const status = document.createElement("span");
  status.textContent = state.fastSupported ? (state.fastEnabled ? "On" : "Off") : "Native only";
  copy.append(label, status);
  const track = document.createElement("span");
  track.className = "gpt-codex-model-picker__fast-track";
  track.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("span");
  thumb.className = "gpt-codex-model-picker__fast-thumb";
  track.appendChild(thumb);
  button.append(icon, copy, track, createFastEffects());

  const description = document.createElement("p");
  description.id = FAST_DESCRIPTION_ID;
  description.className = "gpt-codex-model-picker__sr-only";
  description.textContent = state.fastSupported
    ? state.fastAvailable
      ? `Fast is ${state.fastEnabled ? "on" : "off"}. Changes are committed through the native service-tier control.`
      : "Fast is unavailable for the selected model or account."
    : "The active Chat model bridge does not expose the native Work/Codex Fast service tier.";
  control.append(button, description);
  return control;
}

function ensurePickerElements() {
  if (!pickerHost) {
    pickerHost = document.createElement("div");
    pickerHost.id = PICKER_ID;
    pickerHost.className = "gpt-codex-model-picker";
    pickerHost.style.visibility = "hidden";
    setReplacementActionable(false);
    setRootPickerOpenState(false);

    pickerTrigger = document.createElement("button");
    pickerTrigger.id = TRIGGER_ID;
    pickerTrigger.type = "button";
    pickerTrigger.className = "gpt-codex-model-picker__trigger";
    pickerTrigger.setAttribute("aria-controls", PANEL_ID);
    pickerTrigger.setAttribute("aria-expanded", "false");
    pickerTrigger.setAttribute("aria-haspopup", "dialog");
    pickerTrigger.appendChild(createLightningIcon());

    const label = document.createElement("span");
    label.className = "gpt-codex-model-picker__trigger-label";
    pickerTrigger.appendChild(label);

    const chevron = document.createElement("span");
    chevron.className = "gpt-codex-model-picker__chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none"><path d="m4.75 6.25 3.25 3.5 3.25-3.5" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    pickerTrigger.appendChild(chevron);
    pickerTrigger.addEventListener("click", () => {
      if (panelOpen) closePanel({ restoreFocus: true });
      else openPanel();
    });
    pickerTrigger.addEventListener("keydown", (event) => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        openPanel({ focusLast: event.key === "ArrowUp" });
      }
    });
    pickerHost.appendChild(pickerTrigger);
  }

  if (!pickerPanel) {
    pickerPanel = document.createElement("section");
    pickerPanel.id = PANEL_ID;
    pickerPanel.className = "gpt-codex-model-picker__panel";
    pickerPanel.dataset.motion = "closed";
    pickerPanel.dataset.placement = "above";
    pickerPanel.hidden = true;
    pickerPanel.inert = true;
    pickerPanel.tabIndex = -1;
    pickerPanel.setAttribute("aria-hidden", "true");
    pickerPanel.setAttribute("aria-label", "Model and effort controls");
    pickerPanel.setAttribute("aria-modal", "false");
    pickerPanel.setAttribute("role", "dialog");
    document.body.appendChild(pickerPanel);
  }
}

function compactSelectionLabel(state) {
  if (!state.selected) return "Choose model";
  const rowLabel = state.activeRow?.label ?? "";
  const choiceLabel = state.displayChoice?.label ?? state.selectedChoice?.label ?? state.selected.slug;
  let base = choiceLabel || rowLabel;
  if (/^\d+(?:\.\d+)?\b/u.test(base)) base = `GPT-${base}`;
  if (state.ultraEngaged) {
    return `${base}${/\bultra\b/iu.test(base) ? "" : " Ultra"}`.replace(/\s+/gu, " ").trim();
  }
  const columnLabel = state.displayChoice?.column?.label ?? "";
  if (columnLabel && !normalizeWords(base).includes(normalizeWords(columnLabel))) {
    base = `${base} ${columnLabel}`;
  }
  return base.replace(/\s+/gu, " ").trim();
}

function createPanelHeader(state) {
  const header = document.createElement("div");
  header.className = "gpt-codex-model-picker__header";
  const copy = document.createElement("div");
  const title = document.createElement("div");
  title.className = "gpt-codex-model-picker__title";
  title.textContent = "Model matrix";
  copy.appendChild(title);
  const subtitle = document.createElement("div");
  subtitle.className = "gpt-codex-model-picker__subtitle";
  subtitle.textContent = state.selected
    ? `${state.selected.slug}${state.selected.thinkingEffort ? ` - ${state.selected.thinkingEffort}` : ""}`
    : "Account-backed models";
  copy.appendChild(subtitle);
  header.append(copy, createFastToggle(state));
  return header;
}

function selectThroughBridge(bridge, choice) {
  if (typeof bridge?.select !== "function") throw new Error("Native model selection is unavailable");
  return bridge.select({
    slug: choice.slug,
    thinkingEffort: normalizeThinkingEffort(choice.thinkingEffort),
    versionId: choice.versionId == null ? null : String(choice.versionId),
  });
}

function captureSelectionMotionSnapshot(choice) {
  if (!panelOpen || pickerPanel?.hidden || prefersReducedMotion()) return null;
  const knob = pickerPanel.querySelector(".gpt-codex-model-picker__slider-knob");
  const track = pickerPanel.querySelector(".gpt-codex-model-picker__slider-track");
  const leverHandle = pickerPanel.querySelector(".gpt-codex-model-picker__lever-handle");
  const knobRect = knob?.getBoundingClientRect();
  const trackRect = track?.getBoundingClientRect();
  const leverRect = leverHandle?.getBoundingClientRect();
  return Object.freeze({
    knobCenterX: knobRect ? knobRect.left + knobRect.width / 2 : null,
    knobCenterY: knobRect ? knobRect.top + knobRect.height / 2 : null,
    leverCenterY: leverRect ? leverRect.top + leverRect.height / 2 : null,
    targetKey: selectionKey(choice),
    trackWidth: trackRect?.width ?? 0,
  });
}

function animateSelectionUpdate(snapshot) {
  if (!snapshot || prefersReducedMotion() || !pickerPanel || pickerPanel.hidden) return;
  const cells = pickerPanel.querySelector(
    '.gpt-codex-model-picker__matrix-row[data-selected="true"] .gpt-codex-model-picker__row-cells',
  );
  const knob = cells?.querySelector(".gpt-codex-model-picker__slider-knob");
  const track = cells?.querySelector(".gpt-codex-model-picker__slider-track");
  const motionAnimations = [];
  if (cells && knob && Number.isFinite(snapshot.knobCenterX)) {
    const finalKnobRect = knob.getBoundingClientRect();
    const horizontalDelta =
      snapshot.knobCenterX - (finalKnobRect.left + finalKnobRect.width / 2);
    const verticalDelta = Number.isFinite(snapshot.knobCenterY)
      ? snapshot.knobCenterY - (finalKnobRect.top + finalKnobRect.height / 2)
      : 0;
    cells.dataset.settling = "true";
    if (
      (Math.abs(horizontalDelta) > 0.5 || Math.abs(verticalDelta) > 0.5) &&
      typeof knob.animate === "function"
    ) {
      motionAnimations.push(
        knob.animate(
          [
            {
              translate: `${horizontalDelta}px ${verticalDelta}px`,
              scale: "0.96",
            },
            { translate: "0 0", scale: "1" },
          ],
          {
            duration: SELECTION_MOTION_DURATION_MS,
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
            fill: "both",
          },
        ),
      );
    }
    const finalTrackRect = track?.getBoundingClientRect();
    if (
      track &&
      finalTrackRect &&
      Number.isFinite(snapshot.trackWidth) &&
      Math.abs(snapshot.trackWidth - finalTrackRect.width) > 0.5 &&
      typeof track.animate === "function"
    ) {
      motionAnimations.push(
        track.animate(
          [
            { width: `${snapshot.trackWidth}px` },
            { width: `${finalTrackRect.width}px` },
          ],
          {
            duration: SELECTION_MOTION_DURATION_MS,
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
            fill: "both",
          },
        ),
      );
    }
    if (motionAnimations.length) {
      Promise.allSettled(motionAnimations.map((animation) => animation.finished)).then(() => {
        motionAnimations.forEach((animation) => animation.cancel());
        if (cells.isConnected) cells.removeAttribute("data-settling");
      });
    } else {
      cells.removeAttribute("data-settling");
    }
  }

  const leverHandle = pickerPanel.querySelector(".gpt-codex-model-picker__lever-handle");
  const leverRect = leverHandle?.getBoundingClientRect();
  if (
    leverHandle &&
    leverRect &&
    Number.isFinite(snapshot.leverCenterY) &&
    typeof leverHandle.animate === "function"
  ) {
    const verticalDelta = snapshot.leverCenterY - (leverRect.top + leverRect.height / 2);
    if (Math.abs(verticalDelta) > 0.5) {
      leverHandle.animate(
        [
          { translate: `0 ${verticalDelta}px`, scale: "0.94" },
          { translate: "0 0", scale: "1" },
        ],
        {
          duration: 360,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        },
      );
    }
  }

  pickerPanel
    .querySelector(".gpt-codex-model-picker__selection-detail")
    ?.animate?.(
      [
        { opacity: 0.42, translate: "0 4px" },
        { opacity: 1, translate: "0 0" },
      ],
      { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  pickerPanel
    .querySelector('.gpt-codex-model-picker__cell[aria-selected="true"] .gpt-codex-model-picker__cell-dot')
    ?.animate?.(
      [
        { opacity: 0.55, transform: "scale(0.72)" },
        { opacity: 1, transform: "scale(1.25)" },
      ],
      { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
}

function selectGenuineChoice(choice, { ultraActivation = false } = {}) {
  const bridge = getActiveBridge();
  const scopeKey = bridgeScopeKey(bridge);
  const currentState = readPickerState();
  const choiceStillAvailable = currentState.rows.some((row) =>
    row.choices.some(
      (candidate) =>
        candidate.key === choice.key && selectionKey(candidate) === selectionKey(choice),
    ),
  );
  if (!bridge || !choiceStillAvailable) return false;
  pendingSelectionMotion = captureSelectionMotionSnapshot(choice);
  const completeSelection = () => {
    if (bridgeScopeKey(getActiveBridge()) !== scopeKey) {
      pendingSelectionMotion = null;
      scheduleReconcile();
      return false;
    }
    pickerHost?.removeAttribute("data-error");
    pickerTrigger?.removeAttribute("title");
    if (ultraActivation && choice.ultra) runUltraShake();
    scheduleReconcile();
    return true;
  };
  const failSelection = (error) => {
    if (bridgeScopeKey(getActiveBridge()) !== scopeKey) {
      pendingSelectionMotion = null;
      scheduleReconcile();
      return false;
    }
    if (pendingSelectionMotion) {
      pendingSelectionMotion = Object.freeze({
        ...pendingSelectionMotion,
        targetKey: selectionKey(readPickerState().selected),
      });
    }
    if (pickerHost) pickerHost.dataset.error = "true";
    if (pickerTrigger) pickerTrigger.title = String(error?.message ?? error);
    renderPicker({ force: true });
    return false;
  };
  try {
    const result = selectThroughBridge(bridge, choice);
    if (result && typeof result.then === "function") {
      return result.then(completeSelection, failSelection);
    }
    return completeSelection();
  } catch (error) {
    return failSelection(error);
  }
}

function getSupportedGridCells() {
  return [...(pickerPanel?.querySelectorAll('[role="gridcell"][data-supported="true"]') ?? [])];
}

function setRovingGridCell(cell, { focus = true } = {}) {
  if (!(cell instanceof HTMLElement) || cell.dataset.supported !== "true") return false;
  const cells = getSupportedGridCells();
  if (!cells.includes(cell)) return false;
  for (const candidate of cells) candidate.tabIndex = candidate === cell ? 0 : -1;
  rovingGridChoiceKey = cell.dataset.choiceKey ?? null;
  if (focus) cell.focus({ preventScroll: true });
  return true;
}

function resolveRovingGridChoice(state, focusedControlIdentity) {
  const choices = state.rows.flatMap((row) => [...row.supportedCells.values()]);
  const availableKeys = new Set(choices.map((choice) => choice.key));
  const focusedChoiceKey = focusedControlIdentity?.startsWith("grid:")
    ? focusedControlIdentity.slice("grid:".length)
    : null;
  const selectedChoiceKey = state.displayChoice?.key ?? null;
  rovingGridChoiceKey =
    (focusedChoiceKey && availableKeys.has(focusedChoiceKey) ? focusedChoiceKey : null) ??
    (selectedChoiceKey && availableKeys.has(selectedChoiceKey) ? selectedChoiceKey : null) ??
    (rovingGridChoiceKey && availableKeys.has(rovingGridChoiceKey) ? rovingGridChoiceKey : null) ??
    choices[0]?.key ??
    null;
}

function restoreFocusedPanelControl(controlIdentity, renderSequence) {
  if (!controlIdentity) return;
  requestAnimationFrame(() => {
    if (
      renderSequence !== panelRenderSequence ||
      !panelOpen ||
      pickerPanel?.hidden ||
      pickerPanel?.inert
    ) {
      return;
    }
    const target = pickerPanel.querySelector(
      `[${CONTROL_ID_ATTRIBUTE}="${CSS.escape(controlIdentity)}"]`,
    );
    if (!(target instanceof HTMLElement) || !isKeyboardActionableElement(target)) return;
    if (target.getAttribute(CONTROL_KIND_ATTRIBUTE) === "grid") {
      setRovingGridCell(target, { focus: false });
    }
    target.focus({ preventScroll: true });
    if (document.activeElement === target && pendingPanelFocusIdentity === controlIdentity) {
      pendingPanelFocusIdentity = null;
    }
  });
}

function focusGridNeighbor(cell, key) {
  const cells = getSupportedGridCells();
  const row = Number(cell.dataset.rowIndex);
  const column = Number(cell.dataset.columnIndex);
  let candidates = [];
  if (key === "ArrowLeft" || key === "ArrowRight") {
    candidates = cells
      .filter((candidate) => Number(candidate.dataset.rowIndex) === row)
      .sort((a, b) => Number(a.dataset.columnIndex) - Number(b.dataset.columnIndex));
    const current = candidates.indexOf(cell);
    const delta = key === "ArrowLeft" ? -1 : 1;
    setRovingGridCell(candidates[Math.max(0, Math.min(candidates.length - 1, current + delta))]);
    return;
  }
  if (key === "Home" || key === "End") {
    candidates = cells
      .filter((candidate) => Number(candidate.dataset.rowIndex) === row)
      .sort((a, b) => Number(a.dataset.columnIndex) - Number(b.dataset.columnIndex));
    setRovingGridCell(candidates[key === "Home" ? 0 : candidates.length - 1]);
    return;
  }
  const direction = key === "ArrowUp" ? -1 : 1;
  const rows = [...new Set(cells.map((candidate) => Number(candidate.dataset.rowIndex)))].sort(
    (a, b) => a - b,
  );
  const targetRow = rows[rows.indexOf(row) + direction];
  if (targetRow == null) return;
  candidates = cells.filter((candidate) => Number(candidate.dataset.rowIndex) === targetRow);
  candidates.sort(
    (a, b) =>
      Math.abs(Number(a.dataset.columnIndex) - column) -
      Math.abs(Number(b.dataset.columnIndex) - column),
  );
  setRovingGridCell(candidates[0]);
}

function handleGridCellKeyDown(event) {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    focusGridNeighbor(event.currentTarget, event.key);
  }
}

function createGridCell(row, rowIndex, column, state) {
  const choice = row.supportedCells.get(column.id) ?? null;
  const selected = choice != null && selectionsMatch(choice, state.displayChoice);
  if (!choice) {
    const unavailable = document.createElement("span");
    unavailable.className = "gpt-codex-model-picker__cell is-unavailable";
    unavailable.dataset.columnIndex = String(column.index);
    unavailable.dataset.rowIndex = String(rowIndex);
    unavailable.dataset.supported = "false";
    unavailable.setAttribute("aria-disabled", "true");
    unavailable.setAttribute("aria-label", `${row.label}, ${column.label}: unavailable for this account`);
    unavailable.setAttribute("role", "gridcell");
    unavailable.title = `${column.label} is not available for ${row.label} on this account`;
    const mark = document.createElement("span");
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "-";
    unavailable.appendChild(mark);
    return unavailable;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "gpt-codex-model-picker__cell is-supported";
  button.dataset.choiceKey = choice.key;
  button.dataset.columnIndex = String(column.index);
  button.dataset.modelSlug = choice.slug;
  button.dataset.rowIndex = String(rowIndex);
  button.dataset.supported = "true";
  button.dataset.thinkingEffort = choice.thinkingEffort ?? "";
  button.tabIndex = choice.key === rovingGridChoiceKey ? 0 : -1;
  setControlIdentity(button, "grid", choice.key);
  button.setAttribute("aria-label", `${row.label}, ${column.label}: ${choice.label}`);
  button.setAttribute("aria-selected", String(selected));
  button.setAttribute("role", "gridcell");
  button.title = choice.description
    ? `${choice.label} - ${choice.description}`
    : `${choice.label} (${choice.slug}${choice.thinkingEffort ? `, ${choice.thinkingEffort}` : ""})`;
  button.addEventListener("click", () => selectGenuineChoice(choice));
  button.addEventListener("focus", () => setRovingGridCell(button, { focus: false }));
  button.addEventListener("keydown", handleGridCellKeyDown);
  const dot = document.createElement("span");
  dot.className = "gpt-codex-model-picker__cell-dot";
  dot.setAttribute("aria-hidden", "true");
  button.appendChild(dot);
  return button;
}

function handleSliderKeyDown(event, row, currentChoice) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const choices = [...row.supportedCells.values()].sort((a, b) => a.column.index - b.column.index);
  const currentIndex = Math.max(
    0,
    choices.findIndex((choice) => selectionKey(choice) === selectionKey(currentChoice)),
  );
  let target = null;
  if (event.key === "Home") target = choices[0];
  else if (event.key === "End") target = choices.at(-1);
  else {
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    target = choices[Math.max(0, Math.min(choices.length - 1, currentIndex + delta))];
  }
  if (target && selectionKey(target) !== selectionKey(currentChoice)) selectGenuineChoice(target);
}

function getBoundedPointerPosition(cells, clientX, columns) {
  const rect = cells.getBoundingClientRect();
  const start = rect.left + rect.width * 0.1;
  const width = Math.max(rect.width * 0.8, 1);
  const ratio = Math.max(0, Math.min(1, (clientX - start) / width));
  const columnPosition = ratio * Math.max(columns.length - 1, 0);
  return Object.freeze({
    columnIndex: Math.round(columnPosition),
    columnPosition,
    knobLeft: 10 + ratio * 80,
    ratio,
    trackWidth: ratio * 80,
  });
}

function getNearestSupportedChoice(row, columnPosition) {
  return (
    [...row.supportedCells.values()].sort(
      (a, b) =>
        Math.abs(a.column.index - columnPosition) -
          Math.abs(b.column.index - columnPosition) ||
        a.column.index - b.column.index,
    )[0] ?? null
  );
}

function restoreSliderVisual(cells, currentChoice, columns) {
  const index = currentChoice.column.index;
  const step = columns.length > 1 ? 80 / (columns.length - 1) : 0;
  const wasDragging = cells.dataset.dragging === "true";
  cells.removeAttribute("data-dragging");
  if (wasDragging) void cells.offsetWidth;
  cells.style.setProperty("--slider-track-width", `${index * step}%`);
  cells.style.setProperty("--slider-knob-left", `${10 + index * step}%`);
}

function attachSliderPointerBehavior(cells, row, currentChoice, columns) {
  let gesture = null;
  const finish = (event, cancelled = false) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    const wasDragging = gesture.dragging;
    const pointer = getBoundedPointerPosition(cells, event.clientX, columns);
    gesture = null;
    const target = getNearestSupportedChoice(row, pointer.columnPosition);
    if (!wasDragging || cancelled) {
      restoreSliderVisual(cells, currentChoice, columns);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressGridClickUntil = performance.now() + 160;
    if (target && selectionKey(target) !== selectionKey(currentChoice)) {
      // Keep the exact release position in place while the native bridge
      // commits. The confirmed native stop eases in from here, while a failed
      // selection returns through the same motion path.
      cells.removeAttribute("data-dragging");
      selectGenuineChoice(target);
      return;
    }
    restoreSliderVisual(cells, currentChoice, columns);
  };
  const move = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!gesture.dragging && Math.abs(event.clientX - gesture.startX) < 4) return;
    gesture.dragging = true;
    event.preventDefault();
    const pointer = getBoundedPointerPosition(cells, event.clientX, columns);
    cells.dataset.dragging = "true";
    cells.style.setProperty("--slider-track-width", `${pointer.trackWidth}%`);
    cells.style.setProperty("--slider-knob-left", `${pointer.knobLeft}%`);
  };
  const up = (event) => finish(event);
  const cancel = (event) => finish(event, true);
  cells.addEventListener("pointerdown", (event) => {
    if (event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) return;
    gesture = {
      dragging: false,
      pointerId: event.pointerId,
      startX: event.clientX,
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  });
  cells.addEventListener(
    "click",
    (event) => {
      if (performance.now() < suppressGridClickUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
}

function createMatrixRow(row, rowIndex, state) {
  const columns = state.columns;
  const rowElement = document.createElement("div");
  rowElement.className = "gpt-codex-model-picker__matrix-row";
  rowElement.style.setProperty("--row-motion-index", String(rowIndex));
  rowElement.dataset.rowId = row.id;
  rowElement.dataset.selected = String(row === state.activeRow);
  rowElement.dataset.ultraCapable = String(row.ultraChoice != null);
  rowElement.setAttribute("aria-rowindex", String(rowIndex + 2));
  rowElement.setAttribute("role", "row");

  const label = document.createElement("div");
  label.className = "gpt-codex-model-picker__row-label";
  label.setAttribute("role", "rowheader");
  label.textContent = row.label;
  rowElement.appendChild(label);

  const cells = document.createElement("div");
  cells.className = "gpt-codex-model-picker__row-cells";
  cells.setAttribute("role", "presentation");
  const selectedChoice = row === state.activeRow ? state.displayChoice : null;
  if (selectedChoice?.column) {
    const step = columns.length > 1 ? 80 / (columns.length - 1) : 0;
    cells.style.setProperty("--selected-column-index", String(selectedChoice.column.index));
    cells.style.setProperty("--slider-track-width", `${selectedChoice.column.index * step}%`);
    cells.style.setProperty("--slider-knob-left", `${10 + selectedChoice.column.index * step}%`);
    const slider = document.createElement("div");
    slider.className = "gpt-codex-model-picker__slider";
    slider.tabIndex = 0;
    setControlIdentity(slider, "slider", row.id);
    slider.setAttribute("aria-label", `Intelligence level for ${row.label}`);
    slider.setAttribute("aria-orientation", "horizontal");
    slider.setAttribute("aria-valuemax", String(columns.length));
    slider.setAttribute("aria-valuemin", "1");
    slider.setAttribute("aria-valuenow", String(selectedChoice.column.index + 1));
    slider.setAttribute("aria-valuetext", `${row.label} ${selectedChoice.column.label}`);
    slider.setAttribute("role", "slider");
    slider.addEventListener("keydown", (event) => handleSliderKeyDown(event, row, selectedChoice));
    const track = document.createElement("span");
    track.className = "gpt-codex-model-picker__slider-track";
    track.setAttribute("aria-hidden", "true");
    slider.appendChild(track);
    const knob = document.createElement("span");
    knob.className = "gpt-codex-model-picker__slider-knob";
    knob.setAttribute("aria-hidden", "true");
    slider.appendChild(knob);
    cells.appendChild(slider);
    attachSliderPointerBehavior(cells, row, selectedChoice, columns);
  }
  for (const column of columns) {
    cells.appendChild(createGridCell(row, rowIndex, column, state));
  }
  rowElement.appendChild(cells);
  return rowElement;
}

function createModelMatrix(state) {
  const matrix = document.createElement("div");
  matrix.id = GRID_ID;
  matrix.className = "gpt-codex-model-picker__matrix";
  matrix.style.setProperty("--matrix-column-count", String(state.columns.length));
  matrix.style.minWidth = `${Math.max(440, 118 + state.columns.length * 66)}px`;
  matrix.setAttribute("aria-colcount", String(state.columns.length + 1));
  matrix.setAttribute("aria-label", `${state.mode === "chat" ? "Chat" : state.mode === "work" ? "Work" : "Codex"} model and effort matrix`);
  matrix.setAttribute("aria-rowcount", String(state.rows.length + 1));
  matrix.setAttribute("role", "grid");

  const header = document.createElement("div");
  header.className = "gpt-codex-model-picker__matrix-header";
  header.setAttribute("aria-rowindex", "1");
  header.setAttribute("role", "row");
  const corner = document.createElement("span");
  corner.className = "gpt-codex-model-picker__matrix-corner";
  corner.setAttribute("aria-hidden", "true");
  header.appendChild(corner);
  const columnHeaders = document.createElement("div");
  columnHeaders.className = "gpt-codex-model-picker__column-headers";
  columnHeaders.setAttribute("role", "presentation");
  for (const column of state.columns) {
    const columnHeader = document.createElement("span");
    columnHeader.setAttribute("role", "columnheader");
    columnHeader.textContent = column.label;
    columnHeaders.appendChild(columnHeader);
  }
  header.appendChild(columnHeaders);
  matrix.appendChild(header);
  state.rows.forEach((row, index) => matrix.appendChild(createMatrixRow(row, index, state)));
  return matrix;
}

function chooseUltraOffTarget(state) {
  if (!state.activeRow) return null;
  return findRememberedChoice(state.activeRow) ?? state.activeRow.defaultChoice ?? null;
}

function runUltraShake() {
  if (prefersReducedMotion()) return;
  window.clearTimeout(ultraShakeTimer);
  const composer = findActiveComposer();
  const cleanup = () => {
    pickerPanel?.classList.remove("gpt-codex-model-picker--ultra-shake");
    composer?.removeAttribute("data-gpt-codex-ultra-shake");
    ultraShakeTimer = 0;
  };
  cleanup();
  void pickerPanel?.offsetWidth;
  void composer?.offsetWidth;
  pickerPanel?.classList.add("gpt-codex-model-picker--ultra-shake");
  composer?.setAttribute("data-gpt-codex-ultra-shake", "true");
  ultraShakeTimer = window.setTimeout(cleanup, ULTRA_SHAKE_DURATION_MS);
}

function createUltraParticleField() {
  const field = document.createElement("span");
  field.className = "gpt-codex-model-picker__particle-field";
  field.setAttribute("aria-hidden", "true");
  ULTRA_PARTICLE_LAYOUT.forEach(([left, size, duration, phase, drift, opacity], index) => {
    const particle = document.createElement("span");
    particle.className = "gpt-codex-model-picker__particle";
    particle.dataset.particleIndex = String(index);
    particle.style.setProperty("--particle-left", `${left}%`);
    particle.style.setProperty("--particle-size", `${size}px`);
    particle.style.setProperty("--particle-duration", `${duration}s`);
    particle.style.setProperty("--particle-delay", `${-(index * 0.133).toFixed(3)}s`);
    particle.style.setProperty("--particle-phase", `${phase}px`);
    particle.style.setProperty("--particle-drift", `${drift}px`);
    particle.style.setProperty("--particle-opacity", String(opacity));
    field.appendChild(particle);
  });
  return field;
}

function createUltraLever(state) {
  const activeRow = state.activeRow;
  const ultraChoice = activeRow?.ultraChoice ?? null;
  const offChoice = chooseUltraOffTarget(state);
  const canToggle = state.ultraEngaged ? offChoice != null : ultraChoice != null;
  const unavailableReason = state.ultraEngaged
    ? `Ultra is on, but no genuine non-Ultra option is available for ${activeRow?.label ?? "this row"}.`
    : `Ultra is unavailable because ${activeRow?.label ?? "this account"} exposes no explicit Ultra effort.`;

  const lever = document.createElement("aside");
  lever.className = "gpt-codex-model-picker__ultra";
  lever.dataset.engaged = String(state.ultraEngaged);
  lever.appendChild(createUltraParticleField());
  const label = document.createElement("div");
  label.className = "gpt-codex-model-picker__ultra-label";
  label.textContent = "ULTRA";
  lever.appendChild(label);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "gpt-codex-model-picker__lever";
  setControlIdentity(button, "ultra");
  button.disabled = !canToggle;
  button.setAttribute("aria-checked", String(state.ultraEngaged));
  button.setAttribute("aria-describedby", ULTRA_DESCRIPTION_ID);
  button.setAttribute("aria-disabled", String(!canToggle));
  button.setAttribute("aria-label", `${state.ultraEngaged ? "Disable" : "Enable"} Ultra for ${activeRow?.label ?? "the selected model"}`);
  button.setAttribute("role", "switch");
  button.title = canToggle
    ? state.ultraEngaged
      ? `Return to ${offChoice.label}`
      : `Select genuine Ultra option ${ultraChoice.label}`
    : unavailableReason;
  button.addEventListener("click", () => {
    if (!canToggle) return;
    if (state.ultraEngaged) {
      selectGenuineChoice(offChoice);
      return;
    }
    if (state.displayChoice?.column) {
      lastNonUltraSelectionByRow.set(activeRow.id, selectionKey(state.displayChoice));
    }
    selectGenuineChoice(ultraChoice, { ultraActivation: true });
  });
  const rail = document.createElement("span");
  rail.className = "gpt-codex-model-picker__lever-rail";
  rail.setAttribute("aria-hidden", "true");
  const handle = document.createElement("span");
  handle.className = "gpt-codex-model-picker__lever-handle";
  rail.appendChild(handle);
  button.appendChild(rail);
  lever.appendChild(button);

  const stateLabel = document.createElement("div");
  stateLabel.className = "gpt-codex-model-picker__ultra-state";
  stateLabel.textContent = state.ultraEngaged ? "ON" : "OFF";
  lever.appendChild(stateLabel);
  const description = document.createElement("p");
  description.id = ULTRA_DESCRIPTION_ID;
  description.className = "gpt-codex-model-picker__sr-only";
  description.textContent = canToggle
    ? state.ultraEngaged
      ? `Ultra is on. Activating the lever selects ${offChoice.label}.`
      : `Ultra is off. Activating the lever selects ${ultraChoice.label}, an account-provided Ultra option.`
    : unavailableReason;
  lever.appendChild(description);
  return lever;
}

function createStatus(message, detail) {
  const status = document.createElement("div");
  status.className = "gpt-codex-model-picker__status";
  status.setAttribute("role", "status");
  const title = document.createElement("div");
  title.className = "gpt-codex-model-picker__status-title";
  title.textContent = message;
  status.appendChild(title);
  const copy = document.createElement("div");
  copy.textContent = detail;
  status.appendChild(copy);
  return status;
}

function createSelectionDetail(state) {
  const detail = document.createElement("div");
  detail.className = "gpt-codex-model-picker__selection-detail";
  detail.setAttribute("aria-live", "polite");
  const label = document.createElement("strong");
  label.textContent = compactSelectionLabel(state);
  detail.appendChild(label);
  const description = document.createElement("span");
  description.textContent =
    state.displayChoice?.description ??
    `Account selection: ${state.selected?.slug ?? "unavailable"}${state.selected?.thinkingEffort ? ` - ${state.selected.thinkingEffort}` : ""}`;
  detail.appendChild(description);
  return detail;
}

function renderPanel(state, focusedControlIdentity) {
  resolveRovingGridChoice(state, focusedControlIdentity);
  const renderSequence = ++panelRenderSequence;
  pickerPanel.replaceChildren(createPanelHeader(state));
  pickerPanel.dataset.ultraEngaged = String(state.ultraEngaged);
  if (state.loading) {
    pickerPanel.appendChild(
      createStatus("Loading model matrix...", "Fetching genuine models available to this ChatGPT account."),
    );
    restoreFocusedPanelControl(focusedControlIdentity, renderSequence);
    return;
  }
  if (state.unavailable) {
    pickerPanel.appendChild(
      createStatus(
        "Model matrix unavailable",
        state.error
          ? "The account model query failed. Close and reopen the picker to try again."
          : "The account response contained no options that map to the supported matrix levels.",
      ),
    );
    restoreFocusedPanelControl(focusedControlIdentity, renderSequence);
    return;
  }
  const body = document.createElement("div");
  body.className = "gpt-codex-model-picker__body";
  body.appendChild(createModelMatrix(state));
  body.appendChild(createUltraLever(state));
  pickerPanel.appendChild(body);
  pickerPanel.appendChild(createSelectionDetail(state));
  restoreFocusedPanelControl(focusedControlIdentity, renderSequence);
}

function updateTriggerLabel(label) {
  const element = pickerTrigger?.querySelector(".gpt-codex-model-picker__trigger-label");
  if (!element || element.textContent === label) return;
  const hadLabel = Boolean(element.textContent);
  element.textContent = label;
  if (hadLabel && !prefersReducedMotion() && typeof element.animate === "function") {
    element.animate(
      [
        { opacity: 0.38, translate: "0 3px" },
        { opacity: 1, translate: "0 0" },
      ],
      { duration: 190, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  }
}

function renderPicker({ force = false } = {}) {
  if (!pickerTrigger || !pickerPanel) return null;
  const state = readPickerState();
  const label = state.loading
    ? "Loading models"
    : state.unavailable
      ? "Models unavailable"
      : compactSelectionLabel(state);
  const focusedControlIdentity = getFocusedPanelControlIdentity() ?? pendingPanelFocusIdentity;
  const signature = JSON.stringify({
    bridgeKind: state.bridge?.kind ?? null,
    conversationId: state.bridge?.conversationId ?? null,
    error: state.error,
    fastAvailable: state.fastAvailable,
    fastEffective: state.fastEffective,
    fastEnabled: state.fastEnabled,
    fastSupported: state.fastSupported,
    label,
    loading: state.loading,
    mode: state.mode,
    rows: state.rows.map((row) => ({
      cells: [...row.supportedCells.entries()],
      id: row.id,
      label: row.label,
      ultra: row.ultraChoice,
    })),
    selected: state.selected,
    unavailable: state.unavailable,
    ultraEngaged: state.ultraEngaged,
  });
  if (!force && signature === lastRenderSignature) {
    if (panelOpen) positionPanel();
    return focusedControlIdentity;
  }
  const selectionMotion =
    pendingSelectionMotion?.targetKey === selectionKey(state.selected)
      ? pendingSelectionMotion
      : null;
  if (selectionMotion) pendingSelectionMotion = null;
  lastRenderSignature = signature;
  updateTriggerLabel(label);
  const modeLabel = state.mode === "chat" ? "Chat" : state.mode === "work" ? "Work" : "Codex";
  pickerTrigger.setAttribute("aria-label", `Select ${modeLabel} model and effort. Current: ${label}`);
  pickerTrigger.dataset.modelSlug = state.selected?.slug ?? "";
  pickerTrigger.dataset.thinkingEffort = state.selected?.thinkingEffort ?? "";
  pickerHost.dataset.fastEnabled = String(state.fastEnabled);
  pickerHost.dataset.state = state.loading ? "loading" : state.unavailable ? "unavailable" : "ready";
  pickerHost.dataset.ultraEngaged = String(state.ultraEngaged);
  pickerPanel.dataset.fastEnabled = String(state.fastEnabled);
  renderPanel(state, focusedControlIdentity);
  if (panelOpen) {
    positionPanel();
    animateSelectionUpdate(selectionMotion);
  }
  if (pendingFastLightning && state.fastEnabled) {
    pendingFastLightning = false;
    requestAnimationFrame(() => runFastLightning());
  }
  return focusedControlIdentity;
}

function positionNativePickerHost() {
  if (pickerHost?.dataset.placement !== "fixed") return true;
  if (!nativePickerAnchor?.isConnected) return false;
  const anchorRect = nativePickerAnchor.getBoundingClientRect();
  const activeComposer = findActiveComposer();
  const anchorIsActive = Boolean(activeComposer?.contains(nativePickerAnchor));
  const anchorOnScreen =
    anchorRect.bottom > 0 &&
    anchorRect.right > 0 &&
    anchorRect.top < window.innerHeight &&
    anchorRect.left < window.innerWidth;
  if (
    !anchorIsActive ||
    !anchorOnScreen ||
    anchorRect.width <= 0 ||
    anchorRect.height <= 0
  ) {
    return false;
  }
  pickerHost.style.width = `${anchorRect.width}px`;
  const hostRect = pickerHost.getBoundingClientRect();
  if (hostRect.width <= 0 || hostRect.height <= 0) return false;
  const margin = 8;
  const left = Math.max(
    margin,
    Math.min(window.innerWidth - hostRect.width - margin, anchorRect.right - hostRect.width),
  );
  const top = Math.max(
    margin,
    Math.min(
      window.innerHeight - hostRect.height - margin,
      anchorRect.top + (anchorRect.height - hostRect.height) / 2,
    ),
  );
  pickerHost.style.left = `${left}px`;
  pickerHost.style.top = `${top}px`;
  pickerHost.style.visibility = "visible";
  return true;
}

function replacementContextIsMountReady(state, composer, insertion) {
  if (
    !pickerStateSupportsActions(state) ||
    !(composer instanceof HTMLElement) ||
    !composer.isConnected ||
    !(insertion?.parent instanceof HTMLElement) ||
    !insertion.parent.isConnected ||
    !(insertion.before instanceof HTMLElement) ||
    !insertion.before.isConnected ||
    insertion.before.parentElement !== insertion.parent ||
    !pickerHost?.isConnected ||
    !pickerPanel?.isConnected ||
    !pickerTrigger?.isConnected ||
    pickerTrigger.disabled ||
    pickerTrigger.tabIndex < 0
  ) {
    return false;
  }
  if (state.bridge.kind === "native") {
    return Boolean(
      insertion.nativeSlot instanceof HTMLElement &&
        insertion.nativeSlot.isConnected &&
        composer.contains(insertion.nativeSlot) &&
        pickerHost.parentElement === document.body &&
        pickerHost.dataset.placement === "fixed",
    );
  }
  return Boolean(
    pickerHost.parentElement === insertion.parent && pickerHost.nextSibling === insertion.before,
  );
}

function replacementContextIsActionable(state, composer, insertion) {
  return Boolean(
    replacementContextIsMountReady(state, composer, insertion) &&
      pickerHost?.getAttribute(REPLACEMENT_ACTIONABLE_ATTRIBUTE) === "true" &&
      isKeyboardActionableElement(pickerTrigger),
  );
}

function createReplacementContext(state, composer, insertion) {
  return Object.freeze({
    before: insertion.before,
    bridgeKind: state.bridge?.kind ?? null,
    bridgeScopeKey: bridgeScopeKey(state.bridge),
    composer,
    mode: state.mode,
    nativeSlot: insertion.nativeSlot ?? null,
    parent: insertion.parent,
  });
}

function replacementContextMatches(context, state, composer, insertion) {
  return Boolean(
    context &&
      context.before === insertion?.before &&
      context.bridgeKind === (state.bridge?.kind ?? null) &&
      context.bridgeScopeKey === bridgeScopeKey(state.bridge) &&
      context.composer === composer &&
      context.mode === state.mode &&
      context.nativeSlot === (insertion?.nativeSlot ?? null) &&
      context.parent === insertion?.parent,
  );
}

function currentReplacementIsConfirmed() {
  if (pickerHost?.getAttribute(REPLACEMENT_ACTIONABLE_ATTRIBUTE) !== "true") return false;
  const state = readPickerState();
  const composer = findActiveComposer();
  const insertion = composer ? resolveFooterInsertion(composer) : null;
  if (!replacementContextMatches(confirmedReplacementContext, state, composer, insertion)) return false;
  if (!replacementContextIsActionable(state, composer, insertion)) return false;
  if (state.bridge.kind === "native" && insertion.nativeSlot !== hiddenNativeSlot?.element) {
    return false;
  }
  return !insertion.nativeSlot || nativeFallbackIsReady(insertion.nativeSlot);
}

function invalidateStaleReplacement() {
  if (
    pickerHost?.getAttribute(REPLACEMENT_ACTIONABLE_ATTRIBUTE) !== "true" ||
    currentReplacementIsConfirmed()
  ) {
    return false;
  }
  const active = document.activeElement;
  const restoreFallbackFocus = Boolean(
    active instanceof HTMLElement &&
      (pickerHost?.contains(active) || pickerPanel?.contains(active)),
  );
  setReplacementActionable(false);
  pickerHost.style.visibility = "hidden";
  closePanel({ immediate: true });
  const restoredNativeSlot = restoreNativeModelSlot();
  confirmedReplacementContext = null;
  pendingSelectionMotion = null;
  lastRenderSignature = "";
  rovingGridChoiceKey = null;
  pendingPanelFocusIdentity = null;
  panelRenderSequence += 1;
  if (restoreFallbackFocus && isKeyboardActionableElement(restoredNativeSlot)) {
    restoredNativeSlot.focus({ preventScroll: true });
  }
  return true;
}

function positionPanel() {
  if (!panelOpen || !pickerTrigger?.isConnected || !pickerPanel) return;
  const triggerRect = pickerTrigger.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  const columnCount = readPickerState().columns.length;
  const desiredWidth = Math.min(820, 620 + Math.max(0, columnCount - 5) * 66);
  const width = Math.min(desiredWidth, window.innerWidth - margin * 2);
  pickerPanel.style.width = `${width}px`;
  const maximumLeft = window.innerWidth - width - margin;
  let left = Math.max(margin, Math.min(triggerRect.left, maximumLeft));
  const height = Math.min(pickerPanel.scrollHeight, window.innerHeight - margin * 2);
  const above = triggerRect.top - height - gap;
  const placement = above >= margin ? "above" : "below";
  const top = placement === "above"
    ? above
    : Math.min(triggerRect.bottom + gap, window.innerHeight - height - margin);
  const boundedTop = Math.max(margin, top);
  pickerPanel.dataset.placement = placement;
  const pinboardLauncher = document.getElementById("gpt-codex-pinboard-launcher");
  if (pinboardLauncher instanceof HTMLElement && !pinboardLauncher.hidden) {
    const obstacle = pinboardLauncher.getBoundingClientRect();
    const overlapsVertically = boundedTop < obstacle.bottom + gap && boundedTop + height + gap > obstacle.top;
    const overlapsHorizontally = left < obstacle.right + gap && left + width + gap > obstacle.left;
    const leftOfLauncher = obstacle.left - width - gap;
    if (overlapsVertically && overlapsHorizontally && leftOfLauncher >= margin) {
      left = Math.min(maximumLeft, leftOfLauncher);
    }
  }
  pickerPanel.style.left = `${left}px`;
  pickerPanel.style.top = `${boundedTop}px`;
}

function cancelPanelMotionTimers() {
  window.clearTimeout(panelCloseTimer);
  panelCloseTimer = 0;
  if (panelCloseTransitionTarget && panelCloseTransitionHandler) {
    panelCloseTransitionTarget.removeEventListener("transitionend", panelCloseTransitionHandler);
  }
  panelCloseTransitionHandler = null;
  panelCloseTransitionTarget = null;
}

function finalizePanelClose() {
  if (!pickerPanel || panelOpen) return;
  cancelPanelMotionTimers();
  pickerPanel.hidden = true;
  pickerPanel.dataset.motion = "closed";
  pickerPanel.inert = true;
  panelCloseTimer = 0;
}

function openPanel({ focusLast = false } = {}) {
  if (
    !pickerHost?.isConnected ||
    pickerHost.getAttribute(REPLACEMENT_ACTIONABLE_ATTRIBUTE) !== "true"
  ) {
    return false;
  }
  ensurePickerElements();
  const reversingClose = !pickerPanel.hidden && pickerPanel.dataset.motion === "closing";
  cancelPanelMotionTimers();
  if (pickerPanel.hidden && !reversingClose) rovingGridChoiceKey = null;
  const focusedControlIdentity = renderPicker({ force: true });
  panelOpen = true;
  setRootPickerOpenState(true);
  pickerPanel.hidden = false;
  pickerPanel.inert = false;
  pickerPanel.setAttribute("aria-hidden", "false");
  pickerTrigger.setAttribute("aria-expanded", "true");
  positionPanel();
  if (reversingClose || prefersReducedMotion()) {
    pickerPanel.dataset.motion = "open";
  } else {
    pickerPanel.dataset.motion = "opening";
    void pickerPanel.offsetWidth;
    pickerPanel.dataset.motion = "open";
  }
  if (!focusedControlIdentity) requestAnimationFrame(() => {
    const controls = [
      ...pickerPanel.querySelectorAll(
        '[role="gridcell"][data-supported="true"], [role="slider"], [role="switch"][aria-disabled="false"]',
      ),
    ];
    const selected = pickerPanel.querySelector('[role="gridcell"][aria-selected="true"]');
    (focusLast ? controls.at(-1) : selected ?? controls[0] ?? pickerPanel)?.focus({
      preventScroll: true,
    });
  });
  return true;
}

function closePanel({ immediate = false, restoreFocus = false } = {}) {
  panelOpen = false;
  pendingPanelFocusIdentity = null;
  setRootPickerOpenState(false);
  if (!pickerPanel) return;
  cancelPanelMotionTimers();
  pickerPanel.inert = true;
  pickerPanel.setAttribute("aria-hidden", "true");
  pickerTrigger?.setAttribute("aria-expanded", "false");
  if (immediate || prefersReducedMotion() || pickerPanel.hidden) {
    finalizePanelClose();
  } else {
    pickerPanel.dataset.motion = "closing";
    panelCloseTransitionTarget = pickerPanel;
    panelCloseTransitionHandler = (event) => {
      if (
        event.target === panelCloseTransitionTarget &&
        event.propertyName === "transform" &&
        !panelOpen
      ) {
        finalizePanelClose();
      }
    };
    panelCloseTransitionTarget.addEventListener("transitionend", panelCloseTransitionHandler);
    panelCloseTimer = window.setTimeout(finalizePanelClose, PANEL_EXIT_DURATION_MS + 80);
  }
  if (restoreFocus && pickerTrigger?.isConnected) {
    requestAnimationFrame(() => pickerTrigger.focus({ preventScroll: true }));
  }
}

function unmountPicker() {
  const active = document.activeElement;
  const restoreFallbackFocus = Boolean(
    active instanceof HTMLElement &&
      (pickerHost?.contains(active) || pickerPanel?.contains(active)),
  );
  setReplacementActionable(false);
  confirmedReplacementContext = null;
  closePanel({ immediate: true });
  const restoredNativeSlot = restoreNativeModelSlot();
  window.clearTimeout(fastLightningTimer);
  fastLightningTimer = 0;
  clearFastPendingState();
  pendingFastLightning = false;
  pickerHost?.remove();
  pickerPanel?.remove();
  pickerHost = null;
  pickerTrigger = null;
  pickerPanel = null;
  pendingSelectionMotion = null;
  lastRenderSignature = "";
  rovingGridChoiceKey = null;
  pendingPanelFocusIdentity = null;
  panelRenderSequence += 1;
  clearRootPickerOpenState();
  if (restoreFallbackFocus && isKeyboardActionableElement(restoredNativeSlot)) {
    requestAnimationFrame(() => {
      if (isKeyboardActionableElement(restoredNativeSlot)) {
        restoredNativeSlot.focus({ preventScroll: true });
      }
    });
  }
}

function reconcilePicker() {
  reconcileQueued = false;
  invalidateStaleReplacement();
  const bridge = getActiveBridge();
  const composer = findActiveComposer();
  const insertion = composer ? resolveFooterInsertion(composer) : null;
  const state = readPickerState();
  if (pendingFastRequest && bridgeScopeKey(bridge) !== pendingFastRequest.scopeKey) {
    clearFastPendingState(pendingFastRequest.id);
    pendingFastLightning = false;
  }
  if (
    !bridge ||
    !composer ||
    !insertion?.parent ||
    !insertion.before ||
    !pickerStateSupportsActions(state)
  ) {
    unmountPicker();
    return;
  }
  if (bridge.kind === "native" && !insertion.nativeSlot) {
    unmountPicker();
    return;
  }
  if (insertion.nativeSlot && !nativeFallbackIsReady(insertion.nativeSlot)) {
    unmountPicker();
    return;
  }
  ensurePickerElements();
  const mountingReplacement =
    pickerHost.getAttribute(REPLACEMENT_ACTIONABLE_ATTRIBUTE) !== "true";
  if (mountingReplacement) {
    setReplacementActionable(false);
    pickerHost.style.visibility = "hidden";
  }
  if (bridge.kind === "native" && insertion.nativeSlot) {
    pickerHost.dataset.placement = "fixed";
    if (pickerHost.parentElement !== document.body) document.body.appendChild(pickerHost);
    nativePickerAnchor = insertion.nativeSlot;
    observeNativePickerAnchor(nativePickerAnchor);
  } else {
    pickerHost.dataset.placement = "inline";
    pickerHost.style.removeProperty("left");
    pickerHost.style.removeProperty("top");
    pickerHost.style.removeProperty("width");
    pickerHost.style.removeProperty("visibility");
    if (pickerHost.parentElement !== insertion.parent || pickerHost.nextSibling !== insertion.before) {
      insertion.parent.insertBefore(pickerHost, insertion.before);
    }
  }
  renderPicker();
  if (bridge.kind === "native" && !positionNativePickerHost()) {
    unmountPicker();
    return;
  }
  if (bridge.kind !== "native") pickerHost.style.removeProperty("visibility");
  const preparedState = readPickerState();
  if (!replacementContextIsMountReady(preparedState, composer, insertion)) {
    unmountPicker();
    return;
  }
  // Keep the shipped control mounted as the native state/action source. Its
  // exact trigger is suppressed only after the custom replacement is both
  // connected and keyboard actionable; either marker disappearing restores it.
  if (insertion.nativeSlot) {
    if (!suppressNativeModelSlot(insertion.nativeSlot, { preserveLayout: bridge.kind === "native" })) {
      unmountPicker();
      return;
    }
  } else {
    restoreNativeModelSlot();
  }
  confirmedReplacementContext = createReplacementContext(preparedState, composer, insertion);
  setReplacementActionable(true);
  if (!currentReplacementIsConfirmed()) unmountPicker();
}

function scheduleReconcile() {
  if (reconcileQueued) return;
  reconcileQueued = true;
  requestAnimationFrame(reconcilePicker);
}

function mutationNeedsReconcile(record) {
  if (!(record?.target instanceof Node)) return true;
  if (pickerHost?.contains(record.target) || pickerPanel?.contains(record.target)) return false;
  return true;
}

function syncChatModelPicker(bridge) {
  chatModelBridge = bridge && typeof bridge === "object" ? { kind: "chat", mode: "chat", ...bridge } : null;
  invalidateStaleReplacement();
  scheduleReconcile();
}

function syncNativeModelPicker(bridge) {
  const nextBridge = bridge && typeof bridge === "object" ? { kind: "native", ...bridge } : null;
  if (pendingFastRequest && bridgeScopeKey(nextBridge) !== pendingFastRequest.scopeKey) {
    clearFastPendingState(pendingFastRequest.id);
    pendingFastLightning = false;
  }
  nativeModelBridge = nextBridge;
  observeFastBridgeSnapshot(nativeModelBridge);
  invalidateStaleReplacement();
  scheduleReconcile();
}

function getModelPickerProbe() {
  const state = readPickerState();
  const motion = getMotionPreferenceSnapshot();
  const replacementContextConfirmed = currentReplacementIsConfirmed();
  const nativeTriggerClassification = getNativeModelTriggerClassification({
    replacementContextConfirmed,
  });
  const visibleNativeModelTriggers = getVisibleNativeModelTriggers(nativeTriggerClassification);
  const visibleAllNativeModelTriggers = nativeTriggerClassification.visibleAllTriggers;
  const customTriggers = [...document.querySelectorAll(`#${TRIGGER_ID}`)];
  const customTriggerVisibleCount = customTriggers.filter((element) => isVisibleElement(element)).length;
  const supportedGridCells = getSupportedGridCells();
  const rovingGridCells = supportedGridCells.filter((element) => element.tabIndex === 0);
  const focusedControlIdentity =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.getAttribute(CONTROL_ID_ATTRIBUTE)
      : null;
  const fastToggle = pickerPanel?.querySelector(".gpt-codex-model-picker__fast-toggle");
  const particles = [
    ...(pickerPanel?.querySelectorAll(".gpt-codex-model-picker__particle") ?? []),
  ];
  const activeComposer = findActiveComposer();
  const domMountedInsideComposer = Boolean(
    pickerHost?.isConnected &&
      pickerHost.closest('form[data-thread-find-composer="true"], .composer-surface-chrome'),
  );
  const anchorRect = nativePickerAnchor?.isConnected
    ? nativePickerAnchor.getBoundingClientRect()
    : null;
  const hostRect = pickerHost?.isConnected ? pickerHost.getBoundingClientRect() : null;
  const anchorRightOffset = anchorRect && hostRect ? hostRect.right - anchorRect.right : null;
  const anchorCenterYOffset =
    anchorRect && hostRect
      ? hostRect.top + hostRect.height / 2 - (anchorRect.top + anchorRect.height / 2)
      : null;
  const composerAnchored = Boolean(
    pickerHost?.isConnected &&
      pickerHost.dataset.placement === "fixed" &&
      pickerHost.parentElement === document.body &&
      isVisibleElement(pickerHost) &&
      nativePickerAnchor?.isConnected &&
      activeComposer?.contains(nativePickerAnchor) &&
      anchorRect?.width > 0 &&
      anchorRect?.height > 0 &&
      Math.abs(anchorRightOffset ?? Number.POSITIVE_INFINITY) <= 2 &&
      Math.abs(anchorCenterYOffset ?? Number.POSITIVE_INFINITY) <= 2,
  );
  const customReplacementActionable = Boolean(
    pickerHost?.getAttribute(REPLACEMENT_ACTIONABLE_ATTRIBUTE) === "true" &&
      isKeyboardActionableElement(pickerTrigger),
  );
  const nativeActionableControlCount = visibleAllNativeModelTriggers.filter((element) =>
    isKeyboardActionableElement(element),
  ).length;
  const nativeFallbackReady = nativeFallbackIsReady(hiddenNativeSlot?.element);
  return Object.freeze({
    actionableControlCount:
      nativeActionableControlCount + (customReplacementActionable ? 1 : 0),
    activeChatMode: isChatModeActive(),
    activeMode: state.mode,
    bridgeKind: state.bridge?.kind ?? null,
    bridgeReady: typeof state.bridge?.select === "function",
    conversationId: state.bridge?.conversationId ?? null,
    fastAvailable: state.fastAvailable,
    fastEffective: state.fastEffective,
    fastEnabled: state.fastEnabled,
    fastPending: pendingFastRequest?.scopeKey === bridgeScopeKey(state.bridge),
    fastSupported: state.fastSupported,
    fastToggleChecked: fastToggle?.getAttribute("aria-checked") === "true",
    fastTogglePresent: Boolean(fastToggle),
    anchorCenterYOffset,
    anchorLayoutPreserved: Boolean(anchorRect?.width > 0 && anchorRect?.height > 0),
    anchorRightOffset,
    composerAnchored,
    customReplacementActionable,
    customTriggerCount: customTriggers.length,
    customTriggerVisibleCount,
    domMountedInsideComposer,
    mountedInsideComposer: domMountedInsideComposer || composerAnchored,
    nativeFallbackConnected: hiddenNativeSlot?.element?.isConnected === true,
    nativeFallbackKeyboardActionable: hiddenNativeSlot?.fallbackKeyboardActionable === true,
    nativeFallbackReady,
    nativeFallbackVisible: hiddenNativeSlot?.fallbackVisible === true,
    placement: pickerHost?.dataset.placement ?? "unmounted",
    nativeTriggerSuppressed:
      customReplacementActionable &&
      replacementContextConfirmed &&
      nativeTriggerClassification.competingTriggers.includes(hiddenNativeSlot?.element) &&
      hiddenNativeSlot?.element?.getAttribute("data-gpt-codex-model-picker-native-slot") === "true" &&
      hiddenNativeSlot.element.getAttribute("aria-hidden") === "true" &&
      hiddenNativeSlot.element.hasAttribute("inert") &&
      visibleNativeModelTriggers.length === 0 &&
      nativeTriggerClassification.unrelatedSuppressedTriggers.length === 0,
    nativeCompetingTriggerCount: nativeTriggerClassification.competingTriggers.length,
    nativeTriggerActiveComposerIdentity: nativeTriggerClassification.activeComposerIdentity,
    nativeTriggerDiagnostics: nativeTriggerClassification.diagnostics,
    visibleNativeTriggerCount: visibleNativeModelTriggers.length,
    visibleAllNativeTriggerCount: visibleAllNativeModelTriggers.length,
    visibleOtherNativeTriggerCount: nativeTriggerClassification.visibleOtherTriggers.length,
    unrelatedSuppressedNativeTriggerCount:
      nativeTriggerClassification.unrelatedSuppressedTriggers.length,
    nativeTriggerCount: nativeTriggerClassification.allTriggers.length,
    motionEffective: motion.effective,
    motionPreference: motion.preference,
    motionReduced: prefersReducedMotion(),
    motionStorageKey: motion.storageKey,
    motionSystemReduced: motion.systemReduced,
    motionState: pickerPanel?.dataset.motion ?? "unmounted",
    panelOpen,
    focusedControlIdentity,
    rootOpenState: document.documentElement.getAttribute(ROOT_OPEN_ATTRIBUTE),
    rovingGridChoiceKey,
    rovingGridTabStopCount: rovingGridCells.length,
    rovingGridTabStopKeys: rovingGridCells.map((element) => element.dataset.choiceKey ?? null),
    queryState: state.loading ? "loading" : state.unavailable ? "unavailable" : "ready",
    replacementContextConfirmed,
    replacementContextMode: confirmedReplacementContext?.mode ?? null,
    rowCount: state.rows.length,
    columnLabels: state.columns.map((column) => column.label),
    highSelectable: state.rows.some((row) => row.supportedCells.has("high")),
    selected: state.selected,
    selectedColumn: state.displayChoice?.column?.id ?? null,
    selectedExactMatch: Boolean(state.selectedChoice),
    supportedIntersectionCount: state.rows.reduce(
      (total, row) => total + row.supportedCells.size,
      0,
    ),
    ultraAvailable: state.rows.some((row) => row.ultraChoice != null),
    ultraCapableRowIds: state.rows
      .filter((row) => row.ultraChoice != null)
      .map((row) => row.id),
    ultraEngaged: state.ultraEngaged,
    ultraParticleAnimationCount: particles.reduce(
      (count, particle) => count + particle.getAnimations().length,
      0,
    ),
    ultraParticleCount: particles.length,
  });
}

function runModelPickerSelfTest() {
  const realBridge = getActiveBridge();
  const realSelectionBefore = selectionKey(realBridge?.selected);
  let fakeSelectCalls = 0;
  const fakeSelections = [];
  const fakeBridge = {
    select(value) {
      fakeSelectCalls += 1;
      fakeSelections.push(value);
    },
  };
  const fakeData = {
    defaultModelSlug: "self-test-base",
    options: [],
    versionOptions: [
      {
        defaultModelSlug: "self-test-base",
        id: "self-test-version",
        label: "Account row",
        options: [
          { lane: "instant", slug: "self-test-base", title: "Account model" },
          {
            lane: "thinking",
            slug: "self-test-medium",
            thinkingEffort: "standard",
            title: "Medium",
          },
          {
            lane: "thinking",
            slug: "self-test-high",
            thinkingEffort: "extended",
            title: "High",
          },
          {
            lane: "thinking",
            slug: "self-test-extra-high",
            thinkingEffort: "max",
            title: "Extra High",
          },
          {
            lane: "thinking",
            slug: "self-test-ultra",
            thinkingEffort: "ultra",
            title: "Ultra",
          },
        ],
      },
    ],
  };
  const rows = buildModelRows(fakeData, {
    slug: "self-test-high",
    thinkingEffort: "extended",
    versionId: "self-test-version",
  });
  const mediumChoice = rows[0]?.supportedCells.get("medium") ?? null;
  const highChoice = rows[0]?.supportedCells.get("high") ?? null;
  const extraHighChoice = rows[0]?.supportedCells.get("extra-high") ?? null;
  const ultraChoice = rows[0]?.ultraChoice ?? null;
  if (highChoice) selectThroughBridge(fakeBridge, highChoice);
  if (ultraChoice) selectThroughBridge(fakeBridge, ultraChoice);
  const nativeRows = buildNativeModelRows(
    [
      {
        defaultReasoningEffort: "medium",
        displayName: "Native account model",
        model: "self-test-native",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map(
          (reasoningEffort) => ({ reasoningEffort }),
        ),
      },
    ],
    { slug: "self-test-native", thinkingEffort: "high" },
  );
  const nativeMaxChoice = nativeRows[0]?.supportedCells.get("max") ?? null;
  const nativeUltraChoice = nativeRows[0]?.ultraChoice ?? null;
  const realSelectionAfter = selectionKey(realBridge?.selected);
  const nativeSelectionUnchanged = realSelectionBefore === realSelectionAfter;
  const genuineMatrixMapping =
    mediumChoice?.thinkingEffort === "standard" &&
    highChoice?.slug === "self-test-high" &&
    highChoice?.thinkingEffort === "extended" &&
    extraHighChoice?.thinkingEffort === "max" &&
    ultraChoice?.slug === "self-test-ultra" &&
    ultraChoice?.thinkingEffort === "ultra" &&
    nativeMaxChoice?.thinkingEffort === "max" &&
    nativeUltraChoice?.thinkingEffort === "ultra";
  const highPointerTarget = getNearestSupportedChoice(rows[0], 2);
  const literalModeLabels =
    getMatrixColumns("chat").map((column) => column.label).join("|") ===
      "Instant|Medium|High|Extra high|Pro" &&
    getMatrixColumns("codex").map((column) => column.label).join("|") ===
      "Low|Medium|High|Extra high|Max";
  return Object.freeze({
    fakeSelectCalls,
    genuineMatrixMapping,
    highPointerTargetWorks: selectionKey(highPointerTarget) === selectionKey(highChoice),
    literalModeLabels,
    nativeSelectionUnchanged,
    passed:
      fakeSelectCalls === 2 &&
      genuineMatrixMapping &&
      selectionKey(highPointerTarget) === selectionKey(highChoice) &&
      literalModeLabels &&
      nativeSelectionUnchanged &&
      fakeSelections.every((selection) => selection.versionId === "self-test-version"),
    synchronous: true,
    ultraRequiresExplicitUltraOption:
      ultraChoice?.thinkingEffort === "ultra" && nativeUltraChoice?.thinkingEffort === "ultra",
  });
}

function openCustomModelPicker() {
  if (
    !pickerTrigger?.isConnected ||
    pickerHost?.getAttribute(REPLACEMENT_ACTIONABLE_ATTRIBUTE) !== "true" ||
    !isKeyboardActionableElement(pickerTrigger)
  ) {
    return false;
  }
  return openPanel();
}

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_SET_MOTION_PREFERENCE", {
  configurable: false,
  enumerable: false,
  value: setMotionPreference,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_MOTION_PREFERENCE", {
  configurable: false,
  enumerable: false,
  value: getMotionPreferenceSnapshot,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_SYNC_CHAT_MODEL_PICKER", {
  configurable: false,
  enumerable: false,
  value: syncChatModelPicker,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_SYNC_NATIVE_MODEL_PICKER", {
  configurable: false,
  enumerable: false,
  value: syncNativeModelPicker,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE", {
  configurable: false,
  enumerable: false,
  value: getModelPickerProbe,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_OPEN_MODEL_PICKER", {
  configurable: false,
  enumerable: false,
  value: openCustomModelPicker,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_MODEL_PICKER_SELF_TEST", {
  configurable: false,
  enumerable: false,
  value: runModelPickerSelfTest,
  writable: false,
});

function initializeModelPicker() {
  const observer = new MutationObserver((records) => {
    if (!records.some(mutationNeedsReconcile)) return;
    invalidateStaleReplacement();
    scheduleReconcile();
  });
  observer.observe(document.documentElement, {
    attributeFilter: [CHAT_MODE_ATTRIBUTE, CHAT_AUXILIARY_ATTRIBUTE, MOTION_EFFECTIVE_ATTRIBUTE],
    attributes: true,
    childList: true,
    subtree: true,
  });
  document.addEventListener(
    "focusin",
    (event) => {
      if (!pendingPanelFocusIdentity || !(event.target instanceof HTMLElement)) return;
      if (!pickerPanel?.contains(event.target)) {
        pendingPanelFocusIdentity = null;
        return;
      }
      const identity = event.target.getAttribute(CONTROL_ID_ATTRIBUTE);
      if (identity && identity !== pendingPanelFocusIdentity) pendingPanelFocusIdentity = null;
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        panelOpen &&
        !pickerPanel?.contains(event.target) &&
        !pickerTrigger?.contains(event.target)
      ) {
        closePanel();
      }
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (panelOpen && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePanel({ restoreFocus: true });
      }
    },
    true,
  );
  const handleViewportChange = () => {
    if (pickerHost?.dataset.placement === "fixed" && !positionNativePickerHost()) {
      unmountPicker();
    }
    positionPanel();
    scheduleReconcile();
  };
  window.addEventListener("resize", handleViewportChange);
  window.addEventListener(
    "scroll",
    handleViewportChange,
    true,
  );
  window.visualViewport?.addEventListener("resize", handleViewportChange);
  window.visualViewport?.addEventListener("scroll", handleViewportChange);
  systemReducedMotionQuery.addEventListener("change", handleSystemMotionPreferenceChange);
  syncChatModelPicker(globalThis.GPT_CODEX_CUSTOM_CHAT_MODEL_PICKER ?? null);
  syncNativeModelPicker(globalThis.GPT_CODEX_CUSTOM_NATIVE_MODEL_PICKER ?? null);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeModelPicker, { once: true });
} else {
  initializeModelPicker();
}
