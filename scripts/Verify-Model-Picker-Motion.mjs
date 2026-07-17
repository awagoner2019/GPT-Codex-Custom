import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const activePortPath = path.join(projectRoot, "profile", "chromium", "DevToolsActivePort");
const outputDirectory = path.join(projectRoot, "work", "verification");
const resultPath = path.join(outputDirectory, "model-picker-motion.json");
const screenshotPath = path.join(outputDirectory, "model-picker-motion-final.png");
const pickerId = "gpt-codex-custom-model-picker";
const triggerId = `${pickerId}-trigger`;
const panelId = "gpt-codex-custom-model-picker-panel";
const fastLightningDurationMs = 620;
const nativeTriggerAttribute = "data-codex-intelligence-trigger";
const nativeTriggerSelector = `[${nativeTriggerAttribute}="true"]`;
const preservedNativeAnchorSelector =
  `${nativeTriggerSelector}[data-gpt-codex-model-picker-native-slot="true"]`;
const controlIdAttribute = "data-gpt-codex-model-picker-control-id";
const controlKindAttribute = "data-gpt-codex-model-picker-control-kind";
const rootOpenAttribute = "data-gpt-codex-model-picker-open";
const motionEffectiveAttribute = "data-gpt-codex-motion";
const motionPreferenceStorageKey = "gpt-codex-custom.motion-preference.v1";
const stabilitySampleDurationMs = 1_200;
const stabilitySampleIntervalMs = 40;
const minimumStabilitySampleCount = 24;
const maximumAnchorDriftPx = 4;
const sliderRailStartRatio = 0.1;
const sliderRailSpanRatio = 0.8;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const rounded = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);

function getSliderStopX(state, columnIndex) {
  const rect = state?.rowCellsRect;
  const columnCount = Number(state?.columnCount);
  if (
    !rect ||
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.width) ||
    !Number.isInteger(columnCount) ||
    columnCount < 1 ||
    !Number.isInteger(columnIndex) ||
    columnIndex < 0 ||
    columnIndex >= columnCount
  ) {
    return null;
  }
  const columnRatio = columnCount > 1 ? columnIndex / (columnCount - 1) : 0;
  return rect.left + rect.width * (sliderRailStartRatio + sliderRailSpanRatio * columnRatio);
}

function getSignedSliderStopDistance(state, columnIndex, side) {
  const stopX = getSliderStopX(state, columnIndex);
  if (!Number.isFinite(stopX) || !Number.isFinite(state?.knobX)) return null;
  return (state.knobX - stopX) * side;
}

function distancesEaseTowardZero(distances) {
  return (
    distances.length > 1 &&
    distances.every(
      (distance, index) =>
        Number.isFinite(distance) &&
        distance >= -0.75 &&
        (index === 0 || distance <= distances[index - 1] + 0.5),
    )
  );
}

const [portLine] = fs.readFileSync(activePortPath, "utf8").trim().split(/\r?\n/u);
const port = Number(portLine);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid isolated DevTools port in ${activePortPath}.`);
}

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => {
  if (!response.ok) throw new Error(`DevTools target discovery failed: ${response.status}.`);
  return response.json();
});
const matches = targets.filter(
  (target) => target.type === "page" && target.url === "app://-/index.html",
);
if (matches.length !== 1 || !matches[0].webSocketDebuggerUrl) {
  throw new Error(`Expected one exact custom renderer target; found ${matches.length}.`);
}

const socket = new WebSocket(matches[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Timed out connecting to the renderer.")), 10_000);
  socket.addEventListener(
    "open",
    () => {
      clearTimeout(timer);
      resolve();
    },
    { once: true },
  );
  socket.addEventListener(
    "error",
    () => {
      clearTimeout(timer);
      reject(new Error("Could not connect to the renderer."));
    },
    { once: true },
  );
});

let requestId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const { reject, resolve, timer } = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(timer);
  if (message.error) reject(new Error(message.error.message ?? "DevTools request failed."));
  else resolve(message.result);
});

function request(method, params = {}) {
  requestId += 1;
  const id = requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out.`));
    }, 15_000);
    pending.set(id, { reject, resolve, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await request("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Renderer evaluation failed.",
    );
  }
  return response.result?.value;
}

async function samplePickerStability() {
  return evaluate(`new Promise((resolve) => {
    const durationMs = ${stabilitySampleDurationMs};
    const intervalMs = ${stabilitySampleIntervalMs};
    const pickerSelector = ${JSON.stringify(`#${pickerId}`)};
    const triggerSelector = ${JSON.stringify(`#${triggerId}`)};
    const nativeTriggerSelector = ${JSON.stringify(nativeTriggerSelector)};
    const preservedNativeAnchorSelector = ${JSON.stringify(preservedNativeAnchorSelector)};
    const identities = new WeakMap();
    let nextIdentity = 1;
    const identity = (element) => {
      if (!(element instanceof Element)) return null;
      if (!identities.has(element)) identities.set(element, nextIdentity++);
      return identities.get(element);
    };
    const rect = (element) => {
      if (!(element instanceof Element)) return null;
      const value = element.getBoundingClientRect();
      return {
        bottom: value.bottom,
        height: value.height,
        left: value.left,
        right: value.right,
        top: value.top,
        width: value.width,
      };
    };
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement) || !element.isConnected || element.hidden) return false;
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      for (let current = element; current instanceof Element; current = current.parentElement) {
        const currentStyle = getComputedStyle(current);
        if (
          currentStyle.display === 'none' ||
          currentStyle.visibility === 'hidden' ||
          currentStyle.visibility === 'collapse' ||
          currentStyle.contentVisibility === 'hidden' ||
          Number(currentStyle.opacity) <= 0.001
        ) {
          return false;
        }
      }
      return (
        bounds.bottom > 0 &&
        bounds.right > 0 &&
        bounds.top < window.innerHeight &&
        bounds.left < window.innerWidth
      );
    };
    const samples = [];
    const startedAt = performance.now();
    const capture = () => {
      const at = performance.now() - startedAt;
      const customHosts = [...document.querySelectorAll(pickerSelector)];
      const customTriggers = [...document.querySelectorAll(triggerSelector)];
      const nativeTriggers = [...document.querySelectorAll(nativeTriggerSelector)].filter(
        (element) => !element.closest(pickerSelector),
      );
      const preservedNativeAnchors = nativeTriggers.filter((element) =>
        element.matches(preservedNativeAnchorSelector),
      );
      const visibleCustomTriggers = customTriggers.filter(isVisible);
      const host = customHosts[0] ?? null;
      const trigger = customTriggers[0] ?? null;
      const anchor = preservedNativeAnchors[0] ?? null;
      const triggerRect = rect(trigger);
      const anchorRect = rect(anchor);
      const triggerCenterY = triggerRect
        ? triggerRect.top + triggerRect.height / 2
        : null;
      const anchorCenterY = anchorRect ? anchorRect.top + anchorRect.height / 2 : null;
      const rightOffset = triggerRect && anchorRect ? triggerRect.right - anchorRect.right : null;
      const centerYOffset =
        triggerCenterY != null && anchorCenterY != null ? triggerCenterY - anchorCenterY : null;
      const probe = globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE?.() ?? null;
      const nativeTriggerDiagnostics = Array.isArray(probe?.nativeTriggerDiagnostics)
        ? probe.nativeTriggerDiagnostics
        : [];
      const nativeTriggerClassificationAvailable =
        nativeTriggerDiagnostics.length === nativeTriggers.length &&
        nativeTriggerDiagnostics.every(
          (diagnostic, index) => diagnostic?.documentIndex === index,
        );
      const competingIndexes = new Set(
        nativeTriggerDiagnostics
          .filter((diagnostic) => diagnostic?.competing === true)
          .map((diagnostic) => diagnostic.documentIndex),
      );
      const visibleAllNativeTriggers = nativeTriggers.filter(isVisible);
      const visibleNativeTriggers = nativeTriggers.filter(
        (element, index) => competingIndexes.has(index) && isVisible(element),
      );
      const visibleOtherNativeTriggers = visibleAllNativeTriggers.filter(
        (element) => !visibleNativeTriggers.includes(element),
      );
      const unrelatedSuppressedNativeTriggers = nativeTriggers.filter(
        (element, index) =>
          !competingIndexes.has(index) &&
          (element.getAttribute('data-gpt-codex-model-picker-native-slot') === 'true' ||
            element.hasAttribute('data-gpt-codex-model-picker-suppression')),
      );
      const hostStyle = host instanceof Element ? getComputedStyle(host) : null;
      const customVisible = visibleCustomTriggers.length > 0;
      const nativeVisible = visibleNativeTriggers.length > 0;
      const presentation = customVisible
        ? nativeVisible
          ? 'both'
          : 'custom-only'
        : nativeVisible
          ? 'native-only'
          : 'neither';
      samples.push({
        anchorIdentity: identity(anchor),
        anchorSuppressed: Boolean(
          anchor &&
            anchor.getAttribute('aria-hidden') === 'true' &&
            anchor.hasAttribute('inert') &&
            !isVisible(anchor)
        ),
        at,
        centerYOffset,
        customHostCount: customHosts.length,
        customTriggerCount: customTriggers.length,
        customTriggerIdentity: identity(trigger),
        hostPlacement: host?.getAttribute('data-placement') ?? null,
        hostPosition: hostStyle?.position ?? null,
        hostVisibility: hostStyle?.visibility ?? null,
        nativeTriggerClassificationAvailable,
        nativeTriggerCount: nativeTriggers.length,
        nativeTriggerDiagnostics,
        presentation,
        preservedNativeAnchorCount: preservedNativeAnchors.length,
        probeVisibleNativeTriggerCount: probe?.visibleNativeTriggerCount ?? null,
        rightOffset,
        unrelatedSuppressedNativeTriggerCount: unrelatedSuppressedNativeTriggers.length,
        visibleAllNativeTriggerCount: visibleAllNativeTriggers.length,
        visibleCustomTriggerCount: visibleCustomTriggers.length,
        visibleNativeTriggerCount: visibleNativeTriggers.length,
        visibleOtherNativeTriggerCount: visibleOtherNativeTriggers.length,
      });
      if (at >= durationMs) {
        resolve({ sampledDurationMs: at, samples });
        return;
      }
      let nextSampleCaptured = false;
      const fallbackTimer = window.setTimeout(() => {
        if (nextSampleCaptured) return;
        nextSampleCaptured = true;
        capture();
      }, intervalMs);
      requestAnimationFrame(() => {
        if (nextSampleCaptured) return;
        nextSampleCaptured = true;
        window.clearTimeout(fallbackTimer);
        capture();
      });
    };
    capture();
  })`);
}

async function inspectUnconfirmedNativeFallback() {
  return evaluate(`(() => {
    const candidate = document.createElement('button');
    candidate.type = 'button';
    candidate.textContent = 'Fallback model control probe';
    candidate.setAttribute(${JSON.stringify(nativeTriggerAttribute)}, 'true');
    candidate.style.cssText = 'position:fixed;left:-20000px;top:0;width:140px;height:32px;';
    document.body.appendChild(candidate);
    const style = getComputedStyle(candidate);
    const evidence = {
      ariaHidden: candidate.getAttribute('aria-hidden'),
      cssVisible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.001,
      display: style.display,
      inert: candidate.hasAttribute('inert'),
      keyboardActionable:
        !candidate.disabled &&
        !candidate.hasAttribute('inert') &&
        candidate.getAttribute('aria-hidden') !== 'true' &&
        candidate.tabIndex >= 0,
      pointerEvents: style.pointerEvents,
      tabIndex: candidate.tabIndex,
      visibility: style.visibility,
    };
    candidate.remove();
    return evidence;
  })()`);
}

async function clickAt(x, y) {
  await request("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    type: "mousePressed",
    x,
    y,
  });
  await request("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 0,
    clickCount: 1,
    type: "mouseReleased",
    x,
    y,
  });
}

async function pressKey(key) {
  const definitions = {
    ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
    ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  };
  const definition = definitions[key];
  if (!definition) throw new Error(`Unsupported verifier key: ${key}`);
  await request("Input.dispatchKeyEvent", {
    ...definition,
    key,
    type: "rawKeyDown",
  });
  await request("Input.dispatchKeyEvent", {
    ...definition,
    key,
    type: "keyUp",
  });
}

async function readState() {
  return evaluate(`(() => {
    const trigger = document.getElementById(${JSON.stringify(triggerId)});
    const panel = document.getElementById(${JSON.stringify(panelId)});
    const probe = globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE?.() ?? null;
    const triggerLabel = trigger?.querySelector('.gpt-codex-model-picker__trigger-label');
    const triggerLightning = trigger?.querySelector('.gpt-codex-model-picker__lightning');
    const rect = (element) => {
      if (!(element instanceof Element)) return null;
      const value = element.getBoundingClientRect();
      return {
        bottom: value.bottom,
        height: value.height,
        left: value.left,
        right: value.right,
        top: value.top,
        width: value.width,
        x: value.x,
        y: value.y,
      };
    };
    const style = (element) => (element instanceof Element ? getComputedStyle(element) : null);
    const selectedCell = panel?.querySelector(
      '.gpt-codex-model-picker__cell[aria-selected="true"]',
    );
    const selectedRow = panel?.querySelector(
      '.gpt-codex-model-picker__matrix-row[data-selected="true"]',
    );
    const rowCells = selectedRow?.querySelector('.gpt-codex-model-picker__row-cells');
    const knob = selectedRow?.querySelector('.gpt-codex-model-picker__slider-knob');
    const track = selectedRow?.querySelector('.gpt-codex-model-picker__slider-track');
    const header = panel?.querySelector('.gpt-codex-model-picker__header');
    const lever = panel?.querySelector('.gpt-codex-model-picker__lever');
    const leverHandle = lever?.querySelector('.gpt-codex-model-picker__lever-handle');
    const ultraBlock = panel?.querySelector('.gpt-codex-model-picker__ultra');
    const particles = [...(ultraBlock?.querySelectorAll('.gpt-codex-model-picker__particle') ?? [])];
    const fastToggle = panel?.querySelector('.gpt-codex-model-picker__fast-toggle');
    const fastIcon = panel?.querySelector('.gpt-codex-model-picker__fast-icon');
    const supportedCells = [...(panel?.querySelectorAll(
      '.gpt-codex-model-picker__cell[data-supported="true"]',
    ) ?? [])];
    const controls = [...(panel?.querySelectorAll(
      '[${controlIdAttribute}]',
    ) ?? [])];
    const activeControlIdentity =
      document.activeElement instanceof HTMLElement && panel?.contains(document.activeElement)
        ? document.activeElement.getAttribute(${JSON.stringify(controlIdAttribute)})
        : null;
    const knobRect = rect(knob);
    const trackRect = rect(track);
    const panelStyle = style(panel);
    const knobStyle = style(knob);
    const trackStyle = style(track);
    const headerStyle = style(header);
    const leverStyle = style(leverHandle);
    const selectedCellStyle = style(selectedCell);
    const selectedRowStyle = style(selectedRow);
    return {
      activeControlIdentity,
      activeMode: probe?.activeMode ?? null,
      bridgeKind: probe?.bridgeKind ?? null,
      cells: supportedCells.map((cell) => ({
        ariaLabel: cell.getAttribute('aria-label'),
        choiceKey: cell.dataset.choiceKey ?? null,
        columnIndex: Number(cell.dataset.columnIndex),
        controlIdentity: cell.getAttribute(${JSON.stringify(controlIdAttribute)}),
        rect: rect(cell),
        rowId: cell.closest('.gpt-codex-model-picker__matrix-row')?.dataset.rowId ?? null,
        rowIndex: Number(cell.dataset.rowIndex),
        selected: cell.getAttribute('aria-selected') === 'true',
        tabIndex: cell.tabIndex,
        ultraCapable:
          cell.closest('.gpt-codex-model-picker__matrix-row')?.dataset.ultraCapable === 'true',
      })),
      controls: controls.map((control) => ({
        controlIdentity: control.getAttribute(${JSON.stringify(controlIdAttribute)}),
        disabled:
          ('disabled' in control && control.disabled) ||
          control.getAttribute('aria-disabled') === 'true',
        kind: control.getAttribute(${JSON.stringify(controlKindAttribute)}),
        tabIndex: control.tabIndex,
      })),
      columnCount: Array.isArray(probe?.columnLabels) ? probe.columnLabels.length : 0,
      catalogBackedChoiceCount: probe?.catalogBackedChoiceCount ?? null,
      catalogChoiceCount: probe?.catalogChoiceCount ?? null,
      catalogIntegrity: probe?.catalogIntegrity === true,
      customReplacementActionable: probe?.customReplacementActionable === true,
      customTriggerVisibleCount: probe?.customTriggerVisibleCount ?? null,
      headerOpacity: Number(headerStyle?.opacity ?? 0),
      headerTranslate: headerStyle?.translate ?? null,
      fastAnimationCount: fastToggle?.getAnimations({ subtree: true }).length ?? 0,
      fastAvailable: probe?.fastAvailable === true,
      fastEffect: fastToggle?.dataset.fastEffect ?? null,
      fastEffective: probe?.fastEffective === true,
      fastEnabled: probe?.fastEnabled === true,
      fastIconColor: style(fastIcon)?.color ?? null,
      fastIconUltraPurple: probe?.fastIconUltraPurple === true,
      fastPending: probe?.fastPending === true,
      fastRect: rect(fastToggle),
      fastSupported: probe?.fastSupported === true,
      fastToggleChecked: fastToggle?.getAttribute('aria-checked') ?? null,
      fastToggleDisabled: fastToggle?.getAttribute('aria-disabled') ?? null,
      knobTransitionDuration: knobStyle?.transitionDuration ?? null,
      knobX: knobRect ? knobRect.left + knobRect.width / 2 : null,
      knobY: knobRect ? knobRect.top + knobRect.height / 2 : null,
      leverChecked: lever?.getAttribute('aria-checked') ?? null,
      leverDisabled: lever?.getAttribute('aria-disabled') ?? null,
      leverRect: rect(lever),
      leverY: rect(leverHandle)?.y ?? null,
      motionReduced: probe?.motionReduced === true,
      motionEffective: probe?.motionEffective ?? null,
      motionPreference: probe?.motionPreference ?? null,
      motionRootState: document.documentElement.getAttribute(
        ${JSON.stringify(motionEffectiveAttribute)},
      ),
      motionStorageKey: probe?.motionStorageKey ?? null,
      motionSystemReduced: probe?.motionSystemReduced === true,
      motionState: probe?.motionState ?? null,
      panelAnimations: panel?.getAnimations().map((animation) => ({
        currentTime: animation.currentTime,
        playState: animation.playState,
      })) ?? [],
      panelHidden: panel?.hidden ?? true,
      panelOpen: probe?.panelOpen === true,
      panelOpacity: Number(panelStyle?.opacity ?? 0),
      panelRect: rect(panel),
      panelTransform: panelStyle?.transform ?? null,
      panelTransitionDuration: panelStyle?.transitionDuration ?? null,
      queryState: probe?.queryState ?? null,
      replacementContextConfirmed: probe?.replacementContextConfirmed === true,
      replacementContextMode: probe?.replacementContextMode ?? null,
      nativeFallbackConnected: probe?.nativeFallbackConnected === true,
      nativeFallbackKeyboardActionable: probe?.nativeFallbackKeyboardActionable === true,
      nativeFallbackReady: probe?.nativeFallbackReady === true,
      nativeFallbackVisible: probe?.nativeFallbackVisible === true,
      nativeCompetingTriggerCount: probe?.nativeCompetingTriggerCount ?? null,
      nativeTriggerActiveComposerIdentity: probe?.nativeTriggerActiveComposerIdentity ?? null,
      nativeTriggerCount: probe?.nativeTriggerCount ?? null,
      nativeTriggerDiagnostics: probe?.nativeTriggerDiagnostics ?? [],
      rootOpenState: document.documentElement.getAttribute(${JSON.stringify(rootOpenAttribute)}),
      rovingGridTabStopKeys: supportedCells
        .filter((cell) => cell.tabIndex === 0)
        .map((cell) => cell.dataset.choiceKey ?? null),
      rowCellsDragging: rowCells?.dataset.dragging === 'true',
      rowCellsRect: rect(rowCells),
      selectedCellVisual: {
        backgroundColor: selectedCellStyle?.backgroundColor ?? null,
        boxShadow: selectedCellStyle?.boxShadow ?? null,
        outlineStyle: selectedCellStyle?.outlineStyle ?? null,
        outlineWidth: selectedCellStyle?.outlineWidth ?? null,
      },
      selectedChoiceKey: selectedCell?.dataset.choiceKey ?? null,
      selectedColumn: probe?.selectedColumn ?? null,
      selectedExactMatch: probe?.selectedExactMatch === true,
      selectedRowVisual: {
        backgroundColor: selectedRowStyle?.backgroundColor ?? null,
        backgroundImage: selectedRowStyle?.backgroundImage ?? null,
        borderColor: selectedRowStyle?.borderTopColor ?? null,
      },
      settling: rowCells?.dataset.settling === 'true',
      syntheticCombinationCount: probe?.syntheticCombinationCount ?? null,
      trackHeight: trackRect?.height ?? null,
      trackTransitionDuration: trackStyle?.transitionDuration ?? null,
      trackWidth: trackRect?.width ?? null,
      expectedTriggerLabel: probe?.expectedTriggerLabel ?? null,
      triggerLabelClientWidth: triggerLabel?.clientWidth ?? null,
      triggerLabelFullyVisible: probe?.triggerLabelFullyVisible === true,
      triggerLabelOverflow: style(triggerLabel)?.overflow ?? null,
      triggerLabelScrollWidth: triggerLabel?.scrollWidth ?? null,
      triggerLabelText: probe?.triggerLabelText ?? triggerLabel?.textContent?.trim() ?? null,
      triggerLabelTextOverflow: style(triggerLabel)?.textOverflow ?? null,
      triggerLightningColor: style(triggerLightning)?.color ?? null,
      triggerLightningUltraPurple: probe?.triggerLightningUltraPurple === true,
      triggerRect: rect(trigger),
      ultraAvailable: probe?.ultraAvailable === true,
      ultraCapableRowIds: probe?.ultraCapableRowIds ?? [],
      ultraEngaged: probe?.ultraEngaged === true,
      ultraParticleAnimationCount: particles.reduce(
        (count, particle) => count + particle.getAnimations().length,
        0,
      ),
      ultraParticleCount: particles.length,
      ultraParticleVisuals: particles.slice(0, 4).map((particle) => {
        const particleStyle = getComputedStyle(particle);
        return {
          opacity: Number(particleStyle.opacity),
          transform: particleStyle.transform,
        };
      }),
      ultraRect: rect(ultraBlock),
      visibleNativeTriggerCount: probe?.visibleNativeTriggerCount ?? null,
      visibleAllNativeTriggerCount: probe?.visibleAllNativeTriggerCount ?? null,
      visibleOtherNativeTriggerCount: probe?.visibleOtherNativeTriggerCount ?? null,
      unrelatedSuppressedNativeTriggerCount:
        probe?.unrelatedSuppressedNativeTriggerCount ?? null,
    };
  })()`);
}

async function readCatalogState() {
  return evaluate(
    "globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_CATALOG_PROBE?.() ?? null",
  );
}

async function focusControl(controlIdentity) {
  return evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(panelId)});
    const identity = ${JSON.stringify(controlIdentity)};
    const control = panel?.querySelector(
      '[${controlIdAttribute}="' + CSS.escape(identity) + '"]',
    );
    if (!(control instanceof HTMLElement)) return false;
    control.focus({ preventScroll: true });
    return document.activeElement === control;
  })()`);
}

async function forcePanelRerenderWithFocus(controlIdentity) {
  return evaluate(`new Promise((resolve) => {
    const panel = document.getElementById(${JSON.stringify(panelId)});
    const identity = ${JSON.stringify(controlIdentity)};
    const selector = '[${controlIdAttribute}="' + CSS.escape(identity) + '"]';
    const control = panel?.querySelector(selector);
    if (!(control instanceof HTMLElement)) {
      resolve({ available: false, controlIdentity: identity });
      return;
    }
    const disabled =
      ('disabled' in control && control.disabled) || control.getAttribute('aria-disabled') === 'true';
    if (disabled) {
      resolve({ available: true, controlIdentity: identity, disabled: true });
      return;
    }
    control.focus({ preventScroll: true });
    const before =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute(${JSON.stringify(controlIdAttribute)})
        : null;
    const opened = globalThis.GPT_CODEX_CUSTOM_OPEN_MODEL_PICKER?.() === true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const replacement = panel?.querySelector(selector);
      const after =
        document.activeElement instanceof HTMLElement
          ? document.activeElement.getAttribute(${JSON.stringify(controlIdAttribute)})
          : null;
      resolve({
        after,
        available: true,
        before,
        controlIdentity: identity,
        disabled: false,
        opened,
        replacementConnected: replacement?.isConnected === true,
        rootOpenState: document.documentElement.getAttribute(${JSON.stringify(rootOpenAttribute)}),
      });
    }));
  })`);
}

async function clickTrigger() {
  const state = await readState();
  if (!state.triggerRect) throw new Error("The custom model picker trigger is missing.");
  await clickAt(
    state.triggerRect.left + state.triggerRect.width / 2,
    state.triggerRect.top + state.triggerRect.height / 2,
  );
}

async function ensurePanel(open) {
  const state = await readState();
  if (state.panelOpen !== open) {
    await clickTrigger();
    await delay(open ? 360 : 240);
  }
  return readState();
}

async function clickChoice(choiceKey) {
  const state = await readState();
  const choice = state.cells.find((cell) => cell.choiceKey === choiceKey);
  if (!choice?.rect) throw new Error(`Choice is not currently available: ${choiceKey}`);
  await clickAt(choice.rect.left + choice.rect.width / 2, choice.rect.top + choice.rect.height / 2);
}

async function waitForChoice(choiceKey, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  let state = await readState();
  while (state.selectedChoiceKey !== choiceKey && Date.now() < deadline) {
    await delay(35);
    state = await readState();
  }
  return state;
}

async function waitForState(predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  let state = await readState();
  while (!predicate(state) && Date.now() < deadline) {
    await delay(25);
    state = await readState();
  }
  return state;
}

async function switchProductMode(mode, timeout = 12_000) {
  const outcome = await evaluate(`(async () => {
    const targetMode = ${JSON.stringify(mode)};
    const deadline = performance.now() + ${timeout};
    const delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    const probe = () => globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE?.() ?? null;
    const ready = () => {
      const current = probe();
      if (current?.activeMode !== targetMode) return false;
      if (targetMode === 'chat') {
        return current.bridgeKind === 'chat' && current.customTriggerVisibleCount === 1;
      }
      return (
        current.bridgeKind === 'native' &&
        current.bridgeReady === true &&
        current.composerAnchored === true &&
        current.customReplacementActionable === true &&
        current.placement === 'fixed' &&
        current.nativeTriggerSuppressed === true &&
        current.visibleNativeTriggerCount === 0 &&
        current.unrelatedSuppressedNativeTriggerCount === 0 &&
        current.customTriggerVisibleCount === 1
      );
    };
    if (ready()) return { mode: targetMode, probe: probe(), ready: true, switched: false };
    if (targetMode === 'chat') {
      globalThis.GPT_CODEX_CUSTOM_OPEN_CHAT?.();
      while (performance.now() < deadline && !ready()) await delay(25);
      return { mode: probe()?.activeMode ?? null, probe: probe(), ready: ready(), switched: true };
    }
    document.querySelector('[data-gpt-codex-custom-product-selector="true"]')?.click();
    let option = null;
    while (performance.now() < deadline && !option) {
      option = [...document.querySelectorAll(
        '[data-gpt-codex-custom-product-menu="true"] [role="menuitemradio"]',
      )].find((candidate) => candidate.dataset.mode === targetMode && !candidate.disabled) ?? null;
      if (!option) await delay(25);
    }
    option?.click();
    while (performance.now() < deadline && !ready()) await delay(25);
    return { mode: probe()?.activeMode ?? null, probe: probe(), ready: ready(), switched: true };
  })()`);
  if (!outcome?.ready) {
    throw new Error(
      `Could not switch the custom app to ${mode} mode for motion verification: ${JSON.stringify(outcome)}`,
    );
  }
  return outcome;
}

async function sampleProductTransition(mode, timeout = 12_000) {
  const outcome = await evaluate(`(async () => {
    const targetMode = ${JSON.stringify(mode)};
    const timeout = ${timeout};
    const pickerSelector = ${JSON.stringify(`#${pickerId}`)};
    const triggerSelector = ${JSON.stringify(`#${triggerId}`)};
    const nativeSelector = ${JSON.stringify(nativeTriggerSelector)};
    const startedAt = performance.now();
    const delayFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement) || !element.isConnected || element.hidden) return false;
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      for (let current = element; current instanceof Element; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          style.contentVisibility === 'hidden' ||
          Number(style.opacity) <= 0.001
        ) return false;
      }
      return true;
    };
    const isKeyboardActionable = (element) =>
      isVisible(element) &&
      !element.closest('[inert]') &&
      !element.closest('[aria-hidden="true"]') &&
      !(('disabled' in element && element.disabled) || element.getAttribute('aria-disabled') === 'true') &&
      element.tabIndex >= 0;
    const samples = [];
    const capture = (source) => {
      const customHosts = [...document.querySelectorAll(pickerSelector)];
      const customTriggers = [...document.querySelectorAll(triggerSelector)];
      const nativeTriggers = [...document.querySelectorAll(nativeSelector)].filter(
        (element) => !element.closest(pickerSelector),
      );
      const visibleCustom = customTriggers.filter(isVisible);
      const actionableCustom = visibleCustom.filter(isKeyboardActionable);
      const probe = globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE?.() ?? null;
      const activeChatComposer = probe?.activeMode === 'chat'
        ? visibleCustom
            .map((element) => element.closest('[data-pip-obstacle="quick-chat"]'))
            .find((element) => element instanceof HTMLElement) ?? null
        : null;
      const nativeTriggerDiagnostics = Array.isArray(probe?.nativeTriggerDiagnostics)
        ? probe.nativeTriggerDiagnostics
        : [];
      const nativeTriggerClassificationAvailable =
        nativeTriggerDiagnostics.length === nativeTriggers.length &&
        nativeTriggerDiagnostics.every(
          (diagnostic, index) => diagnostic?.documentIndex === index,
        );
      const competingIndexes = new Set(
        nativeTriggerDiagnostics
          .filter((diagnostic) => diagnostic?.competing === true)
          .map((diagnostic) => diagnostic.documentIndex),
      );
      const visibleAllNative = nativeTriggers.filter(isVisible);
      const visibleNative = nativeTriggers.filter(
        (element, index) => competingIndexes.has(index) && isVisible(element),
      );
      const activeChatNative = activeChatComposer
        ? nativeTriggers.filter((element) => activeChatComposer.contains(element))
        : [];
      const visibleActiveChatNative = activeChatNative.filter(isVisible);
      const actionableActiveChatNative = activeChatNative.filter(isKeyboardActionable);
      const visibleOtherNative = visibleAllNative.filter(
        (element) => !visibleNative.includes(element),
      );
      const actionableNative = visibleAllNative.filter(isKeyboardActionable);
      const unrelatedSuppressedNative = nativeTriggers.filter(
        (element, index) =>
          !competingIndexes.has(index) &&
          (element.getAttribute('data-gpt-codex-model-picker-native-slot') === 'true' ||
             element.hasAttribute('data-gpt-codex-model-picker-suppression')),
      );
      const stableActiveChatReplacement =
        probe?.activeMode === 'chat' &&
        probe.customReplacementActionable === true &&
        probe.replacementContextConfirmed === true;
      const transitionClassificationAvailable =
        nativeTriggerClassificationAvailable &&
        (!stableActiveChatReplacement || activeChatComposer instanceof HTMLElement);
      const visibleNativeForPresentation =
        stableActiveChatReplacement ? visibleActiveChatNative : visibleNative;
      const actionableNativeForPresentation =
        stableActiveChatReplacement
          ? actionableActiveChatNative
          : visibleNative.filter(isKeyboardActionable);
      const nativeBlocksCustomOnly =
        visibleNativeForPresentation.length > 0 || actionableNativeForPresentation.length > 0;
      const presentation = !transitionClassificationAvailable
        ? 'unclassified'
        : visibleCustom.length
          ? nativeBlocksCustomOnly ? 'both' : 'custom-only'
          : nativeBlocksCustomOnly ? 'native-only' : 'neither';
      const sample = {
        actionableActiveChatComposerNativeTriggerCount: actionableActiveChatNative.length,
        actionableControlCount: actionableCustom.length + actionableNative.length,
        activeChatComposerNativeTriggerCount: activeChatNative.length,
        activeChatComposerResolved: activeChatComposer instanceof HTMLElement,
        activeMode: probe?.activeMode ?? null,
        at: performance.now() - startedAt,
        customHostCount: customHosts.length,
        customReplacementActionable: probe?.customReplacementActionable === true,
        nativeTriggerClassificationAvailable,
        nativeTriggerDiagnostics,
        presentation,
        probeVisibleNativeTriggerCount: probe?.visibleNativeTriggerCount ?? null,
        replacementContextConfirmed: probe?.replacementContextConfirmed === true,
        source,
        stableActiveChatReplacement,
        transitionClassificationAvailable,
        unrelatedSuppressedNativeTriggerCount: unrelatedSuppressedNative.length,
        visibleActiveChatComposerNativeTriggerCount: visibleActiveChatNative.length,
        visibleAllNativeTriggerCount: visibleAllNative.length,
        visibleCustomTriggerCount: visibleCustom.length,
        visibleNativeTriggerCount: visibleNative.length,
        visibleOtherNativeTriggerCount: visibleOtherNative.length,
      };
      samples.push(sample);
      return sample;
    };
    const ready = () => {
      const probe = globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE?.() ?? null;
      return Boolean(
        probe?.activeMode === targetMode &&
        probe.bridgeKind === 'native' &&
        probe.bridgeReady === true &&
        probe.composerAnchored === true &&
        probe.customReplacementActionable === true &&
        probe.replacementContextConfirmed === true &&
        probe.nativeTriggerSuppressed === true &&
        probe.visibleNativeTriggerCount === 0 &&
        probe.unrelatedSuppressedNativeTriggerCount === 0 &&
        probe.customTriggerVisibleCount === 1
      );
    };
    document.querySelector('[data-gpt-codex-custom-product-selector="true"]')?.click();
    let option = null;
    while (performance.now() - startedAt < timeout && !option) {
      option = [...document.querySelectorAll(
        '[data-gpt-codex-custom-product-menu="true"] [role="menuitemradio"]',
      )].find((candidate) => candidate.dataset.mode === targetMode && !candidate.disabled) ?? null;
      if (!option) await delay(16);
    }
    if (!option) return { activeMode: null, ready: false, samples, targetMode };
    capture('before-click');
    option.click();
    await Promise.resolve();
    capture('after-microtask');
    let readyFrameCount = 0;
    while (performance.now() - startedAt < timeout) {
      await delayFrame();
      capture('frame');
      readyFrameCount = ready() ? readyFrameCount + 1 : 0;
      if (readyFrameCount >= 3) break;
    }
    return {
      activeMode: globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE?.()?.activeMode ?? null,
      durationMs: performance.now() - startedAt,
      ready: ready(),
      samples,
      targetMode,
    };
  })()`);
  if (!outcome?.ready) {
    throw new Error(`Could not complete the sampled transition to ${mode}.`);
  }
  return outcome;
}

const checks = [];
const check = (name, passed, evidence) => {
  checks.push({ evidence, name, passed: Boolean(passed) });
};
const isTransparentColor = (value) => {
  const normalized = String(value ?? "").replace(/\s+/gu, "").toLowerCase();
  return normalized === "transparent" || /^rgba\([^,]+,[^,]+,[^,]+,0(?:\.0+)?\)$/u.test(normalized);
};

function checkProductTransition(name, transition) {
  const samples = transition?.samples ?? [];
  const invalidSamples = samples.filter(
    (sample) =>
      sample.customHostCount > 1 ||
      sample.visibleCustomTriggerCount > 1 ||
      !sample.nativeTriggerClassificationAvailable ||
      !sample.transitionClassificationAvailable ||
      sample.probeVisibleNativeTriggerCount !== sample.visibleNativeTriggerCount ||
      sample.unrelatedSuppressedNativeTriggerCount > 0 ||
      sample.presentation === "both" ||
      sample.presentation === "neither" ||
      sample.actionableControlCount < 1,
  );
  const final = samples.at(-1) ?? null;
  check(
    name,
    transition?.ready === true &&
      samples.length >= 3 &&
      invalidSamples.length === 0 &&
      final?.activeMode === transition.targetMode &&
      final?.presentation === "custom-only" &&
      final?.visibleNativeTriggerCount === 0 &&
      final?.unrelatedSuppressedNativeTriggerCount === 0 &&
      final?.replacementContextConfirmed === true,
    {
      anomalousSamples: invalidSamples.slice(0, 16).map((sample) => ({
        ...sample,
        at: rounded(sample.at),
      })),
      durationMs: rounded(transition?.durationMs),
      final,
      maximumCustomHostCount: samples.length
        ? Math.max(...samples.map((sample) => sample.customHostCount))
        : null,
      maximumVisibleCompetingNativeWithCustom: samples.length
        ? Math.max(
            ...samples.map((sample) =>
              sample.visibleCustomTriggerCount > 0 ? sample.visibleNativeTriggerCount : 0,
            ),
          )
        : null,
      maximumVisibleAllNativeWithCustom: samples.length
        ? Math.max(
            ...samples.map((sample) =>
              sample.visibleCustomTriggerCount > 0 ? sample.visibleAllNativeTriggerCount : 0,
            ),
          )
        : null,
      maximumVisibleOtherNativeWithCustom: samples.length
        ? Math.max(
            ...samples.map((sample) =>
              sample.visibleCustomTriggerCount > 0 ? sample.visibleOtherNativeTriggerCount : 0,
            ),
          )
        : null,
      minimumActionableControlCount: samples.length
        ? Math.min(...samples.map((sample) => sample.actionableControlCount))
        : null,
      presentationSequence: samples.map((sample) => sample.presentation),
      sampleCount: samples.length,
      targetMode: transition?.targetMode ?? null,
    },
  );
}

let originalChoiceKey = null;
let originalFastEnabled = null;
let originalUltraEngaged = null;
let originalProductMode = null;
let originalMotionControllerState = null;
let originalMotionStoredValue = null;
let fatalError = null;

await request("Runtime.enable");
await request("Page.enable");
await request("Page.bringToFront");

try {
  originalProductMode = (await readState()).activeMode;
  const motionBaseline = await evaluate(`(() => {
    const getter = globalThis.GPT_CODEX_CUSTOM_MOTION_PREFERENCE;
    const setter = globalThis.GPT_CODEX_CUSTOM_SET_MOTION_PREFERENCE;
    const storageKey = ${JSON.stringify(motionPreferenceStorageKey)};
    const storedBefore = localStorage.getItem(storageKey);
    if (typeof getter !== 'function' || typeof setter !== 'function') {
      return { available: false, storedBefore };
    }
    const before = getter();
    const forced = setter('full', { persist: false });
    return {
      available: true,
      before,
      forced,
      rootEffective: document.documentElement.getAttribute(
        ${JSON.stringify(motionEffectiveAttribute)},
      ),
      storedAfter: localStorage.getItem(storageKey),
      storedBefore,
    };
  })()`);
  originalMotionControllerState = motionBaseline?.before ?? null;
  originalMotionStoredValue = motionBaseline?.storedBefore ?? null;
  check(
    "motion.fullBaselineUsesAppPreference",
    motionBaseline?.available === true &&
      motionBaseline.forced?.preference === "full" &&
      motionBaseline.forced?.effective === "full" &&
      motionBaseline.forced?.storageKey === motionPreferenceStorageKey &&
      motionBaseline.rootEffective === "full" &&
      motionBaseline.storedAfter === motionBaseline.storedBefore,
    motionBaseline,
  );

  await switchProductMode("chat");
  await delay(120);
  await ensurePanel(false);
  const chatReady = await readState();
  const chatCatalog = await readCatalogState();
  const modelPickerSelfTest = await evaluate(
    "globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_SELF_TEST?.() ?? null",
  );
  check(
    "chat.mixedVersionCatalogCannotManufactureModelEffortPairs",
    modelPickerSelfTest?.passed === true &&
      modelPickerSelfTest?.exactCatalogRows === true &&
      modelPickerSelfTest?.noSyntheticInstant === true &&
      modelPickerSelfTest?.unknownEffortFailsClosed === true,
    modelPickerSelfTest,
  );
  const chatCombinations = Array.isArray(chatCatalog?.displayedCombinations)
    ? chatCatalog.displayedCombinations
    : [];
  const mislabeledFiveFiveInstant = chatCombinations.filter(
    (choice) =>
      String(choice?.label ?? "").trim().toLowerCase() === "5.5 instant" &&
      String(choice?.model ?? "").trim().toLowerCase() !== "gpt-5.5",
  );
  const duplicateChatCombinations = chatCombinations.filter((choice, index, choices) => {
    const key = [choice?.model, choice?.slug, choice?.thinkingEffort ?? ""].join("\u0000");
    return (
      choices.findIndex(
        (candidate) =>
          [candidate?.model, candidate?.slug, candidate?.thinkingEffort ?? ""].join("\u0000") ===
          key,
      ) !== index
    );
  });
  check(
    "chat.liveMatrixContainsOnlyExactAccountCombinations",
    chatReady.queryState === "ready" &&
      chatReady.catalogIntegrity === true &&
      chatReady.catalogChoiceCount === chatReady.catalogBackedChoiceCount &&
      chatReady.catalogChoiceCount === chatCombinations.length &&
      chatCatalog?.selectedExactMatch === true &&
      chatReady.syntheticCombinationCount === 0 &&
      mislabeledFiveFiveInstant.length === 0 &&
      duplicateChatCombinations.length === 0,
    {
      catalogBackedChoiceCount: chatReady.catalogBackedChoiceCount,
      catalogChoiceCount: chatReady.catalogChoiceCount,
      combinations: chatCombinations,
      mislabeledFiveFiveInstant,
      selectedExactMatch: chatCatalog?.selectedExactMatch,
      syntheticCombinationCount: chatReady.syntheticCombinationCount,
    },
  );
  const chatNativeDiagnostics = Array.isArray(chatReady.nativeTriggerDiagnostics)
    ? chatReady.nativeTriggerDiagnostics
    : [];
  const chatNativeClassificationAvailable =
    Number.isInteger(chatReady.nativeTriggerCount) &&
    chatNativeDiagnostics.length === chatReady.nativeTriggerCount &&
    chatNativeDiagnostics.every((diagnostic, index) => diagnostic?.documentIndex === index);
  const activeChatComposerNativeDiagnostics = chatNativeDiagnostics.filter(
    (diagnostic) => diagnostic?.quickChat === true && diagnostic?.inActiveComposer === true,
  );
  const competingChatNativeDiagnostics = chatNativeDiagnostics.filter(
    (diagnostic) => diagnostic?.competing === true,
  );
  const [activeChatComposerNativeDiagnostic] = activeChatComposerNativeDiagnostics;
  const customChatActionableControlCount = chatReady.customReplacementActionable
    ? chatReady.customTriggerVisibleCount
    : 0;
  const activeChatComposerActionableControlCount =
    customChatActionableControlCount +
    activeChatComposerNativeDiagnostics.filter(
      (diagnostic) => diagnostic?.keyboardActionable === true,
    ).length;
  const sameSlotActionableControlCount =
    customChatActionableControlCount +
    activeChatComposerNativeDiagnostics.filter(
      (diagnostic) =>
        diagnostic?.keyboardActionable === true &&
        (diagnostic.activeSlot || diagnostic.confirmedSlot || diagnostic.hiddenSlot),
    ).length;
  check(
    "chat.activeComposerHasOneSuppressedNativeSlotAndOneActionableModelControl",
    chatReady.activeMode === "chat" &&
      chatReady.bridgeKind === "chat" &&
      chatReady.customReplacementActionable === true &&
      chatReady.customTriggerVisibleCount === 1 &&
      chatReady.replacementContextConfirmed === true &&
      chatReady.replacementContextMode === "chat" &&
      chatNativeClassificationAvailable &&
      activeChatComposerNativeDiagnostics.length === 1 &&
      competingChatNativeDiagnostics.length === 1 &&
      chatReady.nativeCompetingTriggerCount === 1 &&
      activeChatComposerNativeDiagnostic?.documentIndex ===
        competingChatNativeDiagnostics[0]?.documentIndex &&
      activeChatComposerNativeDiagnostic?.identity != null &&
      activeChatComposerNativeDiagnostic.composerIdentity ===
        chatReady.nativeTriggerActiveComposerIdentity &&
      activeChatComposerNativeDiagnostic.quickChat === true &&
      activeChatComposerNativeDiagnostic.inActiveComposer === true &&
      activeChatComposerNativeDiagnostic.activeSlot === true &&
      activeChatComposerNativeDiagnostic.confirmedSlot === true &&
      activeChatComposerNativeDiagnostic.hiddenSlot === true &&
      activeChatComposerNativeDiagnostic.suppression?.marker === true &&
      activeChatComposerNativeDiagnostic.suppression?.mode === "inline" &&
      activeChatComposerNativeDiagnostic.suppression?.inert === true &&
      activeChatComposerNativeDiagnostic.suppression?.ariaHidden === "true" &&
      activeChatComposerNativeDiagnostic.visible === false &&
      activeChatComposerNativeDiagnostic.keyboardActionable === false &&
      chatReady.visibleNativeTriggerCount === 0 &&
      customChatActionableControlCount === 1 &&
      activeChatComposerActionableControlCount === 1 &&
      sameSlotActionableControlCount === 1,
    {
      activeChatComposerActionableControlCount,
      activeChatComposerNativeDiagnostics,
      activeMode: chatReady.activeMode,
      competingChatNativeDiagnostics,
      customChatActionableControlCount,
      customReplacementActionable: chatReady.customReplacementActionable,
      customTriggerVisibleCount: chatReady.customTriggerVisibleCount,
      inactiveVisibleNativeDiagnostics: chatNativeDiagnostics.filter(
        (diagnostic) =>
          diagnostic?.visible === true &&
          !(diagnostic.quickChat === true && diagnostic.inActiveComposer === true),
      ),
      nativeCompetingTriggerCount: chatReady.nativeCompetingTriggerCount,
      nativeTriggerActiveComposerIdentity: chatReady.nativeTriggerActiveComposerIdentity,
      nativeTriggerCount: chatReady.nativeTriggerCount,
      replacementContextConfirmed: chatReady.replacementContextConfirmed,
      replacementContextMode: chatReady.replacementContextMode,
      sameSlotActionableControlCount,
      visibleAllNativeTriggerCount: chatReady.visibleAllNativeTriggerCount,
      visibleNativeTriggerCount: chatReady.visibleNativeTriggerCount,
    },
  );
  const chatToWork = await sampleProductTransition("work");
  checkProductTransition("transition.chatToWorkHasNoDuplicateOrMissingControl", chatToWork);
  const workReady = await readState();
  const workCatalog = await readCatalogState();
  const workToCodex = await sampleProductTransition("codex");
  checkProductTransition("transition.workToCodexHasNoDuplicateOrMissingControl", workToCodex);
  await delay(300);
  const ready = await readState();
  if (ready.queryState !== "ready" || !ready.triggerRect) {
    throw new Error("The account-backed model picker is not ready.");
  }
  const codexCatalog = await readCatalogState();
  const exactNativeCatalog = (state, catalog) => {
    const combinations = Array.isArray(catalog?.displayedCombinations)
      ? catalog.displayedCombinations
      : [];
    const keys = combinations.map((choice) =>
      [choice?.model, choice?.slug, choice?.thinkingEffort ?? ""].join("\u0000"),
    );
    return (
      state?.queryState === "ready" &&
      state?.catalogIntegrity === true &&
      state?.catalogChoiceCount > 0 &&
      state.catalogChoiceCount === state.catalogBackedChoiceCount &&
      state.catalogChoiceCount === combinations.length &&
      catalog?.selectedExactMatch === true &&
      state.syntheticCombinationCount === 0 &&
      new Set(keys).size === keys.length &&
      combinations.every(
        (choice) =>
          String(choice?.model ?? "").trim() === String(choice?.modelLabel ?? "").trim(),
      )
    );
  };
  check(
    "native.workAndCodexMatricesContainOnlySupportedSnapshotCombinations",
    workReady.activeMode === "work" &&
      exactNativeCatalog(workReady, workCatalog) &&
      ready.activeMode === "codex" &&
      exactNativeCatalog(ready, codexCatalog),
    {
      codex: {
        catalogBackedChoiceCount: ready.catalogBackedChoiceCount,
        catalogChoiceCount: ready.catalogChoiceCount,
        combinations: codexCatalog?.displayedCombinations,
        selectedExactMatch: codexCatalog?.selectedExactMatch,
        syntheticCombinationCount: ready.syntheticCombinationCount,
      },
      work: {
        catalogBackedChoiceCount: workReady.catalogBackedChoiceCount,
        catalogChoiceCount: workReady.catalogChoiceCount,
        combinations: workCatalog?.displayedCombinations,
        selectedExactMatch: workCatalog?.selectedExactMatch,
        syntheticCombinationCount: workReady.syntheticCombinationCount,
      },
    },
  );
  check(
    "native.onlyCustomPickerVisible",
    ready.visibleNativeTriggerCount === 0 &&
      ready.nativeCompetingTriggerCount === 1 &&
      ready.unrelatedSuppressedNativeTriggerCount === 0 &&
      ready.motionPreference === "full" &&
      ready.motionEffective === "full" &&
      ready.motionRootState === "full" &&
      !ready.motionReduced,
    {
      activeMode: ready.activeMode,
      motionEffective: ready.motionEffective,
      motionPreference: ready.motionPreference,
      motionRootState: ready.motionRootState,
      motionSystemReduced: ready.motionSystemReduced,
      nativeCompetingTriggerCount: ready.nativeCompetingTriggerCount,
      nativeTriggerDiagnostics: ready.nativeTriggerDiagnostics,
      unrelatedSuppressedNativeTriggerCount: ready.unrelatedSuppressedNativeTriggerCount,
      visibleAllNativeTriggerCount: ready.visibleAllNativeTriggerCount,
      visibleNativeTriggerCount: ready.visibleNativeTriggerCount,
      visibleOtherNativeTriggerCount: ready.visibleOtherNativeTriggerCount,
    },
  );
  check(
    "trigger.fullModelAndEffortRemainVisible",
    chatReady.triggerLabelFullyVisible &&
      chatReady.triggerLabelText === chatReady.expectedTriggerLabel &&
      ready.triggerLabelFullyVisible &&
      ready.triggerLabelText === ready.expectedTriggerLabel,
    {
      chat: {
        clientWidth: chatReady.triggerLabelClientWidth,
        expected: chatReady.expectedTriggerLabel,
        overflow: chatReady.triggerLabelOverflow,
        scrollWidth: chatReady.triggerLabelScrollWidth,
        text: chatReady.triggerLabelText,
        textOverflow: chatReady.triggerLabelTextOverflow,
      },
      native: {
        clientWidth: ready.triggerLabelClientWidth,
        expected: ready.expectedTriggerLabel,
        overflow: ready.triggerLabelOverflow,
        scrollWidth: ready.triggerLabelScrollWidth,
        text: ready.triggerLabelText,
        textOverflow: ready.triggerLabelTextOverflow,
      },
    },
  );
  const fallbackContract = await inspectUnconfirmedNativeFallback();
  check(
    "native.fallbackVisibleAndKeyboardActionableWhenCustomIsUnconfirmed",
    ready.customReplacementActionable &&
      ready.nativeFallbackConnected &&
      ready.nativeFallbackKeyboardActionable &&
      ready.nativeFallbackReady &&
      ready.nativeFallbackVisible &&
      fallbackContract.cssVisible &&
      fallbackContract.keyboardActionable &&
      fallbackContract.pointerEvents !== "none",
    {
      customReplacementActionable: ready.customReplacementActionable,
      liveNativeFallback: {
        connected: ready.nativeFallbackConnected,
        keyboardActionable: ready.nativeFallbackKeyboardActionable,
        ready: ready.nativeFallbackReady,
        visibleBeforeSuppression: ready.nativeFallbackVisible,
      },
      unconfirmedNativeProbe: fallbackContract,
    },
  );
  await delay(50);

  await ensurePanel(false);
  const stability = await samplePickerStability();
  const stabilitySamples = stability?.samples ?? [];
  const presentationRuns = [];
  for (const sample of stabilitySamples) {
    const currentRun = presentationRuns.at(-1);
    if (currentRun?.presentation === sample.presentation) {
      currentRun.endAt = sample.at;
      currentRun.sampleCount += 1;
    } else {
      presentationRuns.push({
        endAt: sample.at,
        presentation: sample.presentation,
        sampleCount: 1,
        startAt: sample.at,
      });
    }
  }
  const alignmentSamples = stabilitySamples.filter(
    (sample) => Number.isFinite(sample.rightOffset) && Number.isFinite(sample.centerYOffset),
  );
  const initialAlignment = alignmentSamples[0] ?? null;
  const maximumAlignmentError = alignmentSamples.length
    ? Math.max(
        ...alignmentSamples.map((sample) =>
          Math.hypot(sample.rightOffset, sample.centerYOffset),
        ),
      )
    : Number.POSITIVE_INFINITY;
  const maximumAlignmentDrift = initialAlignment
    ? Math.max(
        ...alignmentSamples.map((sample) =>
          Math.hypot(
            sample.rightOffset - initialAlignment.rightOffset,
            sample.centerYOffset - initialAlignment.centerYOffset,
          ),
        ),
      )
    : Number.POSITIVE_INFINITY;
  const customTriggerIdentities = new Set(
    stabilitySamples.map((sample) => sample.customTriggerIdentity).filter(Number.isInteger),
  );
  const nativeAnchorIdentities = new Set(
    stabilitySamples.map((sample) => sample.anchorIdentity).filter(Number.isInteger),
  );
  const presentations = new Set(stabilitySamples.map((sample) => sample.presentation));
  const customNativeAlternated =
    presentations.has("custom-only") && presentations.has("native-only");
  const stableSample = (sample) =>
    sample.customHostCount === 1 &&
    sample.customTriggerCount === 1 &&
    sample.visibleCustomTriggerCount === 1 &&
    sample.nativeTriggerClassificationAvailable &&
    sample.visibleNativeTriggerCount === 0 &&
    sample.probeVisibleNativeTriggerCount === 0 &&
    sample.unrelatedSuppressedNativeTriggerCount === 0 &&
    sample.preservedNativeAnchorCount === 1 &&
    sample.anchorSuppressed &&
    sample.presentation === "custom-only" &&
    sample.hostPlacement === "fixed" &&
    sample.hostPosition === "fixed" &&
    sample.hostVisibility !== "hidden" &&
    Number.isFinite(sample.rightOffset) &&
    Number.isFinite(sample.centerYOffset) &&
    Math.hypot(sample.rightOffset, sample.centerYOffset) <= maximumAnchorDriftPx;
  const anomalousSamples = stabilitySamples
    .filter((sample) => !stableSample(sample))
    .slice(0, 12)
    .map((sample) => ({
      ...sample,
      at: rounded(sample.at),
      centerYOffset: rounded(sample.centerYOffset),
      rightOffset: rounded(sample.rightOffset),
    }));
  check(
    "native.customPickerStaysStableAgainstPreservedAnchor",
    stability?.sampledDurationMs >= stabilitySampleDurationMs &&
      stabilitySamples.length >= minimumStabilitySampleCount &&
      stabilitySamples.every(stableSample) &&
      !customNativeAlternated &&
      customTriggerIdentities.size === 1 &&
      nativeAnchorIdentities.size === 1 &&
      maximumAlignmentError <= maximumAnchorDriftPx &&
      maximumAlignmentDrift <= maximumAnchorDriftPx,
    {
      anomalousSamples,
      customNativeAlternated,
      customTriggerIdentityCount: customTriggerIdentities.size,
      maximumAlignmentDriftPx: rounded(maximumAlignmentDrift),
      maximumAlignmentErrorPx: rounded(maximumAlignmentError),
      maximumAnchorDriftPx,
      maximumCustomTriggerCount: stabilitySamples.length
        ? Math.max(...stabilitySamples.map((sample) => sample.customTriggerCount))
        : null,
      maximumVisibleNativeTriggerCount: stabilitySamples.length
        ? Math.max(...stabilitySamples.map((sample) => sample.visibleNativeTriggerCount))
        : null,
      maximumVisibleAllNativeTriggerCount: stabilitySamples.length
        ? Math.max(...stabilitySamples.map((sample) => sample.visibleAllNativeTriggerCount))
        : null,
      maximumVisibleOtherNativeTriggerCount: stabilitySamples.length
        ? Math.max(...stabilitySamples.map((sample) => sample.visibleOtherNativeTriggerCount))
        : null,
      maximumUnrelatedSuppressedNativeTriggerCount: stabilitySamples.length
        ? Math.max(
            ...stabilitySamples.map((sample) => sample.unrelatedSuppressedNativeTriggerCount),
          )
        : null,
      minimumRequiredSampleCount: minimumStabilitySampleCount,
      nativeAnchorIdentityCount: nativeAnchorIdentities.size,
      presentationRuns: presentationRuns.map((run) => ({
        ...run,
        endAt: rounded(run.endAt),
        startAt: rounded(run.startAt),
      })),
      sampleCount: stabilitySamples.length,
      sampledDurationMs: rounded(stability?.sampledDurationMs),
    },
  );

  const openingSamples = [];
  await clickTrigger();
  openingSamples.push({ at: 0, ...(await readState()) });
  await delay(45);
  openingSamples.push({ at: 45, ...(await readState()) });
  await delay(45);
  openingSamples.push({ at: 90, ...(await readState()) });
  await delay(45);
  openingSamples.push({ at: 135, ...(await readState()) });
  await delay(230);
  openingSamples.push({ at: 365, ...(await readState()) });
  const openingSettled = openingSamples.at(-1);
  const openingStart = openingSamples[0];
  const openingHasInBetweenFrame = openingSamples.slice(1, -1).some(
    (sample) =>
      !sample.panelHidden &&
      ((sample.panelOpacity > 0.02 && sample.panelOpacity < 0.98) ||
        (sample.panelTransform !== openingStart.panelTransform &&
          sample.panelTransform !== openingSettled.panelTransform)),
  );
  check(
    "panel.openFluidly",
    openingHasInBetweenFrame &&
      openingSettled.motionState === "open" &&
      openingSettled.panelOpen &&
      openingSettled.rootOpenState === "true" &&
      openingSettled.panelOpacity > 0.99,
    openingSamples.map(({ at, headerOpacity, motionState, panelHidden, panelOpacity, panelTransform, rootOpenState }) => ({
      at,
      headerOpacity: rounded(headerOpacity),
      motionState,
      panelHidden,
      panelOpacity: rounded(panelOpacity),
      panelTransform,
      rootOpenState,
    })),
  );

  await clickTrigger();
  const closingSamples = [{ at: 0, ...(await readState()) }];
  await delay(70);
  closingSamples.push({ at: 70, ...(await readState()) });
  await delay(165);
  closingSamples.push({ at: 235, ...(await readState()) });
  check(
    "panel.closeFluidly",
    closingSamples[0].motionState === "closing" &&
      !closingSamples[0].panelHidden &&
      closingSamples[1].panelOpacity < closingSamples[0].panelOpacity &&
      closingSamples[2].motionState === "closed" &&
      closingSamples[0].rootOpenState === "false" &&
      closingSamples[2].rootOpenState === "false" &&
      closingSamples[2].panelHidden,
    closingSamples.map(({ at, motionState, panelHidden, panelOpacity, panelTransform, rootOpenState }) => ({
      at,
      motionState,
      panelHidden,
      panelOpacity: rounded(panelOpacity),
      panelTransform,
      rootOpenState,
    })),
  );

  await clickTrigger();
  await delay(340);
  await clickTrigger();
  await delay(70);
  const interruptedClose = await readState();
  await clickTrigger();
  const reversedImmediately = await readState();
  await delay(340);
  const reversedSettled = await readState();
  check(
    "panel.closeCanReverse",
    interruptedClose.motionState === "closing" &&
      !interruptedClose.panelHidden &&
      interruptedClose.rootOpenState === "false" &&
      reversedImmediately.motionState === "open" &&
      reversedImmediately.rootOpenState === "true" &&
      reversedSettled.panelOpen &&
      reversedSettled.motionState === "open" &&
      reversedSettled.rootOpenState === "true" &&
      !reversedSettled.panelHidden,
    {
      interruptedClose: {
        motionState: interruptedClose.motionState,
        opacity: rounded(interruptedClose.panelOpacity),
        rootOpenState: interruptedClose.rootOpenState,
      },
      reversedImmediately: {
        motionState: reversedImmediately.motionState,
        opacity: rounded(reversedImmediately.panelOpacity),
        rootOpenState: reversedImmediately.rootOpenState,
      },
      reversedSettled: {
        motionState: reversedSettled.motionState,
        opacity: rounded(reversedSettled.panelOpacity),
        rootOpenState: reversedSettled.rootOpenState,
      },
    },
  );
  check(
    "state.openAttributeTracksPanelLifecycle",
    openingSettled.rootOpenState === "true" &&
      closingSamples[0].rootOpenState === "false" &&
      closingSamples[2].rootOpenState === "false" &&
      interruptedClose.rootOpenState === "false" &&
      reversedImmediately.rootOpenState === "true" &&
      reversedSettled.rootOpenState === "true",
    {
      closed: closingSamples[2].rootOpenState,
      closing: closingSamples[0].rootOpenState,
      open: openingSettled.rootOpenState,
      reversed: reversedSettled.rootOpenState,
    },
  );

  const initialSelection = await readState();
  originalFastEnabled = initialSelection.fastEnabled;
  originalUltraEngaged = initialSelection.ultraEngaged;
  const selectedCell = initialSelection.cells.find((cell) => cell.selected);
  if (!selectedCell) throw new Error("The current native selection is not represented in the matrix.");
  check(
    "accessibility.gridHasOneSelectedRovingTabStop",
    initialSelection.rovingGridTabStopKeys.length === 1 &&
      initialSelection.rovingGridTabStopKeys[0] === selectedCell.choiceKey &&
      selectedCell.tabIndex === 0,
    {
      selectedChoiceKey: selectedCell.choiceKey,
      selectedTabIndex: selectedCell.tabIndex,
      tabStopChoiceKeys: initialSelection.rovingGridTabStopKeys,
    },
  );

  const selectedRowCells = initialSelection.cells
    .filter((cell) => cell.rowIndex === selectedCell.rowIndex)
    .sort((left, right) => left.columnIndex - right.columnIndex);
  const selectedRowPosition = selectedRowCells.findIndex(
    (cell) => cell.choiceKey === selectedCell.choiceKey,
  );
  let rovingTarget = null;
  let rovingKey = null;
  if (selectedRowPosition >= 0 && selectedRowPosition < selectedRowCells.length - 1) {
    rovingTarget = selectedRowCells[selectedRowPosition + 1];
    rovingKey = "ArrowRight";
  } else if (selectedRowPosition > 0) {
    rovingTarget = selectedRowCells[selectedRowPosition - 1];
    rovingKey = "ArrowLeft";
  } else {
    const otherRows = [...new Set(initialSelection.cells.map((cell) => cell.rowIndex))]
      .filter((rowIndex) => rowIndex !== selectedCell.rowIndex)
      .sort((left, right) => left - right);
    const targetRow =
      otherRows.find((rowIndex) => rowIndex > selectedCell.rowIndex) ?? otherRows.at(-1) ?? null;
    if (targetRow != null) {
      rovingTarget = initialSelection.cells
        .filter((cell) => cell.rowIndex === targetRow)
        .sort(
          (left, right) =>
            Math.abs(left.columnIndex - selectedCell.columnIndex) -
            Math.abs(right.columnIndex - selectedCell.columnIndex),
        )[0] ?? null;
      rovingKey = targetRow > selectedCell.rowIndex ? "ArrowDown" : "ArrowUp";
    }
  }
  if (!rovingTarget || !rovingKey || !selectedCell.controlIdentity) {
    throw new Error("No supported grid neighbor is available for roving-tabindex verification.");
  }
  if (!(await focusControl(selectedCell.controlIdentity))) {
    throw new Error("Could not focus the selected grid cell for roving-tabindex verification.");
  }
  await pressKey(rovingKey);
  await delay(35);
  const rovingState = await readState();
  check(
    "accessibility.gridArrowsMoveTheRovingTabStop",
    rovingState.activeControlIdentity === rovingTarget.controlIdentity &&
      rovingState.rovingGridTabStopKeys.length === 1 &&
      rovingState.rovingGridTabStopKeys[0] === rovingTarget.choiceKey &&
      rovingState.selectedChoiceKey === selectedCell.choiceKey,
    {
      activeControlIdentity: rovingState.activeControlIdentity,
      arrowKey: rovingKey,
      expectedControlIdentity: rovingTarget.controlIdentity,
      selectedChoiceKey: rovingState.selectedChoiceKey,
      tabStopChoiceKeys: rovingState.rovingGridTabStopKeys,
    },
  );

  const focusControlState = await readState();
  const focusCases = [
    {
      controlIdentity: rovingTarget.controlIdentity,
      kind: "grid",
      name: "focus.gridCellPersistsAcrossPanelRerender",
      required: true,
    },
    {
      controlIdentity: focusControlState.controls.find((control) => control.kind === "slider")
        ?.controlIdentity ?? null,
      kind: "slider",
      name: "focus.selectedRowSliderPersistsAcrossPanelRerender",
      required: true,
    },
    {
      controlIdentity: focusControlState.controls.find((control) => control.kind === "fast")
        ?.controlIdentity ?? null,
      kind: "fast",
      name: "focus.fastSwitchPersistsAcrossPanelRerender",
      required: false,
    },
    {
      controlIdentity: focusControlState.controls.find((control) => control.kind === "ultra")
        ?.controlIdentity ?? null,
      kind: "ultra",
      name: "focus.ultraControlPersistsAcrossPanelRerender",
      required: false,
    },
  ];
  const focusEvidence = [];
  for (const focusCase of focusCases) {
    const evidence = focusCase.controlIdentity
      ? await forcePanelRerenderWithFocus(focusCase.controlIdentity)
      : { available: false, controlIdentity: null };
    const passed = evidence.disabled
      ? !focusCase.required
      : evidence.available &&
        evidence.opened &&
        evidence.replacementConnected &&
        evidence.before === focusCase.controlIdentity &&
        evidence.after === focusCase.controlIdentity &&
        evidence.rootOpenState === "true";
    check(focusCase.name, passed, { ...evidence, kind: focusCase.kind, required: focusCase.required });
    focusEvidence.push({ ...evidence, kind: focusCase.kind, passed });
  }
  const advancedFocusEvidence = focusEvidence.filter(({ kind }) => ["fast", "ultra"].includes(kind));
  check(
    "focus.advancedControlsKeepStableIdentities",
    advancedFocusEvidence.length === 2 && advancedFocusEvidence.every(({ passed }) => passed),
    advancedFocusEvidence,
  );
  check(
    "visual.selectionHasNoBoundingBoxes",
    isTransparentColor(initialSelection.selectedCellVisual?.backgroundColor) &&
      initialSelection.selectedCellVisual?.boxShadow === "none" &&
      initialSelection.selectedCellVisual?.outlineStyle === "none" &&
      isTransparentColor(initialSelection.selectedRowVisual?.backgroundColor) &&
      initialSelection.selectedRowVisual?.backgroundImage === "none" &&
      isTransparentColor(initialSelection.selectedRowVisual?.borderColor) &&
      initialSelection.trackHeight <= 4,
    {
      selectedCell: initialSelection.selectedCellVisual,
      selectedRow: initialSelection.selectedRowVisual,
      trackHeight: rounded(initialSelection.trackHeight),
    },
  );
  check(
    "effects.structureIsMounted",
    initialSelection.ultraParticleCount === 12 &&
      initialSelection.fastRect != null &&
      initialSelection.fastToggleChecked != null,
    {
      fastSupported: initialSelection.fastSupported,
      fastToggleChecked: initialSelection.fastToggleChecked,
      particleCount: initialSelection.ultraParticleCount,
    },
  );
  originalChoiceKey = selectedCell.choiceKey;
  const sameRowChoices = initialSelection.cells.filter(
    (cell) => cell.rowIndex === selectedCell.rowIndex && cell.choiceKey !== originalChoiceKey,
  );
  const targetChoice =
    sameRowChoices.find((cell) => cell.columnIndex === 2) ??
    sameRowChoices.sort(
      (left, right) =>
        Math.abs(right.columnIndex - selectedCell.columnIndex) -
        Math.abs(left.columnIndex - selectedCell.columnIndex),
    )[0];
  if (!targetChoice) throw new Error("No alternate native model selection is available for motion testing.");

  const selectionSamples = [
    {
      at: 0,
      choiceKey: initialSelection.selectedChoiceKey,
      knobX: initialSelection.knobX,
      settling: initialSelection.settling,
    },
  ];
  await clickAt(
    targetChoice.rect.left + targetChoice.rect.width / 2,
    targetChoice.rect.top + targetChoice.rect.height / 2,
  );
  for (let index = 1; index <= 28; index += 1) {
    await delay(25);
    const state = await readState();
    selectionSamples.push({
      at: index * 25,
      choiceKey: state.selectedChoiceKey,
      knobX: state.knobX,
      settling: state.settling,
    });
  }
  const selectionFinal = await waitForChoice(targetChoice.choiceKey);
  const selectionXs = selectionSamples
    .map((sample) => sample.knobX)
    .filter(Number.isFinite)
    .map((value) => rounded(value));
  const uniqueSelectionXs = [...new Set(selectionXs)];
  const oldSelectionX = initialSelection.knobX;
  const finalSelectionX = selectionFinal.knobX;
  const lowerBound = Math.min(oldSelectionX, finalSelectionX) + 1;
  const upperBound = Math.max(oldSelectionX, finalSelectionX) - 1;
  const hasIntermediateSelectionX = selectionXs.some(
    (value) => value > lowerBound && value < upperBound,
  );
  check(
    "selection.animatesToNativeConfirmation",
    selectionFinal.selectedChoiceKey === targetChoice.choiceKey &&
      Math.abs(finalSelectionX - oldSelectionX) > 8 &&
      uniqueSelectionXs.length >= 3 &&
      hasIntermediateSelectionX &&
      selectionSamples.some((sample) => sample.settling),
    {
      finalChoiceKey: selectionFinal.selectedChoiceKey,
      finalKnobX: rounded(finalSelectionX),
      originalChoiceKey,
      originalKnobX: rounded(oldSelectionX),
      sampleCount: selectionSamples.length,
      targetChoiceKey: targetChoice.choiceKey,
      uniqueKnobPositions: uniqueSelectionXs,
    },
  );

  await clickChoice(originalChoiceKey);
  const selectionRestored = await waitForChoice(originalChoiceKey);
  check("selection.restoredAfterClickTest", selectionRestored.selectedChoiceKey === originalChoiceKey, {
    originalChoiceKey,
    restoredChoiceKey: selectionRestored.selectedChoiceKey,
  });
  await delay(380);

  const returnSnapStart = await readState();
  const returnSnapSelectedCell = returnSnapStart.cells.find((cell) => cell.selected);
  const returnSnapTarget = returnSnapStart.cells.find(
    (cell) =>
      cell.rowIndex === returnSnapSelectedCell?.rowIndex &&
      cell.choiceKey === targetChoice.choiceKey,
  );
  if (!returnSnapSelectedCell || !returnSnapTarget?.rect || !Number.isFinite(returnSnapStart.knobX)) {
    throw new Error("Could not resolve the no-op release geometry.");
  }
  const returnSnapY = returnSnapStart.knobY;
  const returnSnapTargetX = getSliderStopX(returnSnapStart, returnSnapTarget.columnIndex);
  const returnSnapColumnDistance = Math.abs(
    returnSnapTarget.columnIndex - returnSnapSelectedCell.columnIndex,
  );
  if (!Number.isFinite(returnSnapTargetX) || returnSnapColumnDistance < 1) {
    throw new Error("Could not resolve the no-op release stop.");
  }
  const partialReleaseAlpha = 0.35 / returnSnapColumnDistance;
  const partialReleaseX =
    returnSnapStart.knobX +
    (returnSnapTargetX - returnSnapStart.knobX) * partialReleaseAlpha;
  await request("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    type: "mousePressed",
    x: returnSnapStart.knobX,
    y: returnSnapY,
  });
  await request("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    type: "mouseMoved",
    x: partialReleaseX,
    y: returnSnapY,
  });
  await delay(24);
  const partialDrag = await readState();
  await request("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 0,
    clickCount: 1,
    type: "mouseReleased",
    x: partialReleaseX,
    y: returnSnapY,
  });
  const returnSnapSamples = [{ at: 0, ...(await readState()) }];
  for (const milliseconds of [40, 100, 180, 360]) {
    await delay(milliseconds - returnSnapSamples.at(-1).at);
    returnSnapSamples.push({ at: milliseconds, ...(await readState()) });
  }
  const returnSnapFinal = returnSnapSamples.at(-1);
  const returnSnapFinalStopX = getSliderStopX(
    returnSnapFinal,
    returnSnapSelectedCell.columnIndex,
  );
  const returnSnapReleaseStopX = getSliderStopX(
    returnSnapSamples[0],
    returnSnapSelectedCell.columnIndex,
  );
  const returnSnapSide =
    Math.sign(partialReleaseX - getSliderStopX(returnSnapStart, returnSnapSelectedCell.columnIndex)) ||
    1;
  const returnSnapDistances = returnSnapSamples.map((sample) =>
    getSignedSliderStopDistance(sample, returnSnapSelectedCell.columnIndex, returnSnapSide),
  );
  const returnSnapReleaseDistance =
    (partialReleaseX - returnSnapReleaseStopX) * returnSnapSide;
  const returnIsMonotonic = distancesEaseTowardZero(returnSnapDistances);
  check(
    "slider.partialReleaseEasesBack",
    partialDrag.rowCellsDragging &&
      Math.abs(partialDrag.knobX - partialReleaseX) < 3 &&
      returnSnapReleaseDistance > 3 &&
      returnSnapDistances[0] <= returnSnapReleaseDistance + 0.5 &&
      returnSnapDistances[0] > 2 &&
      new Set(returnSnapDistances.map(rounded)).size >= 3 &&
      returnIsMonotonic &&
      Math.abs(returnSnapFinal.knobX - returnSnapFinalStopX) < 2 &&
      returnSnapFinal.selectedChoiceKey === originalChoiceKey,
    {
      columnDistance: returnSnapColumnDistance,
      finalChoiceKey: returnSnapFinal.selectedChoiceKey,
      finalStopX: rounded(returnSnapFinalStopX),
      originalChoiceKey,
      originalKnobX: rounded(returnSnapStart.knobX),
      partialReleaseAlpha: rounded(partialReleaseAlpha),
      partialReleaseX: rounded(partialReleaseX),
      samples: returnSnapSamples.map((sample) => ({
        at: sample.at,
        knobX: rounded(sample.knobX),
        signedDistance: rounded(
          getSignedSliderStopDistance(
            sample,
            returnSnapSelectedCell.columnIndex,
            returnSnapSide,
          ),
        ),
        stopX: rounded(getSliderStopX(sample, returnSnapSelectedCell.columnIndex)),
      })),
      targetStopX: rounded(returnSnapTargetX),
    },
  );

  const dragStart = await readState();
  const dragSelectedCell = dragStart.cells.find((cell) => cell.selected);
  const dragTarget = dragStart.cells.find(
    (cell) =>
      cell.rowIndex === dragSelectedCell?.rowIndex && cell.choiceKey === targetChoice.choiceKey,
  );
  if (!dragSelectedCell || !dragTarget?.rect || !Number.isFinite(dragStart.knobX)) {
    throw new Error("Could not resolve slider drag geometry.");
  }
  const dragY = dragStart.knobY;
  const dragTargetX = getSliderStopX(dragStart, dragTarget.columnIndex);
  const dragColumnDistance = Math.abs(
    dragTarget.columnIndex - dragSelectedCell.columnIndex,
  );
  if (!Number.isFinite(dragTargetX) || dragColumnDistance < 1) {
    throw new Error("Could not resolve the slider target stop.");
  }
  const dragDelta = dragTargetX - dragStart.knobX;
  const dragFinalRatio = 1 - 0.25 / dragColumnDistance;
  const dragRatios = Array.from(
    { length: 5 },
    (_, index) => (dragFinalRatio * (index + 1)) / 5,
  );
  await request("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    type: "mousePressed",
    x: dragStart.knobX,
    y: dragY,
  });
  const dragSamples = [];
  for (const ratio of dragRatios) {
    const requestedX = dragStart.knobX + dragDelta * ratio;
    await request("Input.dispatchMouseEvent", {
      button: "left",
      buttons: 1,
      type: "mouseMoved",
      x: requestedX,
      y: dragY,
    });
    await delay(22);
    const state = await readState();
    dragSamples.push({
      knobX: state.knobX,
      requestedX,
      rowCellsDragging: state.rowCellsDragging,
      transitionDuration: state.knobTransitionDuration,
    });
  }
  const dragging = await readState();
  const dragDirection = Math.sign(dragDelta) || 1;
  const maximumTrackingError = Math.max(
    ...dragSamples.map((sample) => Math.abs(sample.knobX - sample.requestedX)),
  );
  const dragIsMonotonic = dragSamples.every(
    (sample, index) =>
      index === 0 ||
      (sample.knobX - dragSamples[index - 1].knobX) * dragDirection >= -0.5,
  );
  const uniqueDragPositions = new Set(dragSamples.map((sample) => rounded(sample.knobX))).size;
  const dragReleaseX = dragStart.knobX + dragDelta * dragRatios.at(-1);
  check(
    "slider.dragFollowsPointerContinuously",
    dragSamples.every((sample) => sample.rowCellsDragging) &&
      dragSamples.every((sample) => /^0s(?:, 0s)*$/u.test(sample.transitionDuration ?? "")) &&
      maximumTrackingError < 3 &&
      dragIsMonotonic &&
      uniqueDragPositions === dragSamples.length,
    {
      maximumTrackingError: rounded(maximumTrackingError),
      samples: dragSamples.map((sample) => ({
        error: rounded(Math.abs(sample.knobX - sample.requestedX)),
        knobX: rounded(sample.knobX),
        requestedX: rounded(sample.requestedX),
      })),
      uniqueDragPositions,
    },
  );
  await request("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 0,
    clickCount: 1,
    type: "mouseReleased",
    x: dragReleaseX,
    y: dragY,
  });
  const releaseSnapSamples = [{ at: 0, ...(await readState()) }];
  for (const milliseconds of [40, 100, 180, 360, 520]) {
    await delay(milliseconds - releaseSnapSamples.at(-1).at);
    releaseSnapSamples.push({ at: milliseconds, ...(await readState()) });
  }
  let dragFinal = releaseSnapSamples.at(-1);
  if (dragFinal.selectedChoiceKey !== targetChoice.choiceKey) {
    await waitForChoice(targetChoice.choiceKey);
    await delay(380);
    dragFinal = await readState();
  }
  const released = releaseSnapSamples[0];
  const dragFinalTargetX = getSliderStopX(dragFinal, dragTarget.columnIndex);
  const releaseSide = Math.sign(dragReleaseX - dragTargetX) || 1;
  const releaseSnapDistances = releaseSnapSamples.map((sample) =>
    getSignedSliderStopDistance(sample, dragTarget.columnIndex, releaseSide),
  );
  const releaseSnapIsMonotonic = distancesEaseTowardZero(releaseSnapDistances);
  if (!Number.isFinite(dragFinalTargetX)) {
    throw new Error("Could not resolve the confirmed slider stop after selection.");
  }
  check(
    "slider.releaseEasesToNativeStop",
    Math.abs(released.knobX - dragReleaseX) < 4 &&
      releaseSnapDistances[0] > 2 &&
      new Set(releaseSnapDistances.map(rounded)).size >= 3 &&
      releaseSnapIsMonotonic &&
      dragFinal.selectedChoiceKey === targetChoice.choiceKey &&
      Math.abs(dragFinal.knobX - dragFinalTargetX) < 2,
    {
      finalChoiceKey: dragFinal.selectedChoiceKey,
      finalKnobX: rounded(dragFinal.knobX),
      finalTargetKnobX: rounded(dragFinalTargetX),
      releaseX: rounded(dragReleaseX),
      samples: releaseSnapSamples.map((sample) => ({
        at: sample.at,
        choiceKey: sample.selectedChoiceKey,
        knobX: rounded(sample.knobX),
        signedDistance: rounded(
          getSignedSliderStopDistance(sample, dragTarget.columnIndex, releaseSide),
        ),
        stopX: rounded(getSliderStopX(sample, dragTarget.columnIndex)),
      })),
      targetChoiceKey: targetChoice.choiceKey,
      initialTargetKnobX: rounded(dragTargetX),
    },
  );
  check(
    "slider.dragStaysAttached",
    dragging.rowCellsDragging &&
      /^0s(?:, 0s)*$/u.test(dragging.knobTransitionDuration ?? "") &&
      Math.abs(dragging.knobX - dragReleaseX) < 3 &&
      Math.abs(released.knobX - dragReleaseX) < 4 &&
      dragFinal.selectedChoiceKey === targetChoice.choiceKey,
    {
      dragFinalChoiceKey: dragFinal.selectedChoiceKey,
      dragTargetChoiceKey: targetChoice.choiceKey,
      dragReleaseX: rounded(dragReleaseX),
      dragTargetX: rounded(dragTargetX),
      dragging: {
        knobTransitionDuration: dragging.knobTransitionDuration,
        knobX: rounded(dragging.knobX),
        rowCellsDragging: dragging.rowCellsDragging,
      },
      maximumTrackingError: rounded(maximumTrackingError),
      releasedKnobX: rounded(released.knobX),
    },
  );

  await delay(190);
  await clickChoice(originalChoiceKey);
  const dragRestored = await waitForChoice(originalChoiceKey);
  check("selection.restoredAfterDragTest", dragRestored.selectedChoiceKey === originalChoiceKey, {
    originalChoiceKey,
    restoredChoiceKey: dragRestored.selectedChoiceKey,
  });
  await delay(380);

  let ultraSetupState = await readState();
  const ultraEntryChoice =
    ultraSetupState.cells.find((cell) => cell.selected && cell.ultraCapable) ??
    ultraSetupState.cells.find((cell) => cell.ultraCapable) ??
    null;
  let ultraCapableRowSelected = false;
  if (ultraEntryChoice) {
    if (ultraSetupState.selectedChoiceKey !== ultraEntryChoice.choiceKey) {
      await clickChoice(ultraEntryChoice.choiceKey);
      ultraSetupState = await waitForChoice(ultraEntryChoice.choiceKey, 4_000);
      await delay(380);
    }
    ultraCapableRowSelected =
      ultraSetupState.selectedChoiceKey === ultraEntryChoice.choiceKey &&
      ultraSetupState.cells.some(
        (cell) => cell.choiceKey === ultraEntryChoice.choiceKey && cell.ultraCapable,
      );
  }
  if (
    ultraCapableRowSelected &&
    ultraSetupState.ultraEngaged &&
    ultraSetupState.leverDisabled === "false" &&
    ultraSetupState.leverRect
  ) {
    await clickAt(
      ultraSetupState.leverRect.left + ultraSetupState.leverRect.width / 2,
      ultraSetupState.leverRect.top + ultraSetupState.leverRect.height / 2,
    );
    ultraSetupState = await waitForState((state) => !state.ultraEngaged, 4_000);
  }
  let ultraActivatedForTest = false;
  let ultraActiveState = ultraSetupState;
  if (
    ultraCapableRowSelected &&
    !ultraActiveState.ultraEngaged &&
    ultraActiveState.ultraAvailable &&
    ultraActiveState.leverDisabled === "false" &&
    ultraActiveState.leverRect
  ) {
    await clickAt(
      ultraActiveState.leverRect.left + ultraActiveState.leverRect.width / 2,
      ultraActiveState.leverRect.top + ultraActiveState.leverRect.height / 2,
    );
    ultraActiveState = await waitForState((state) => state.ultraEngaged, 4_000);
    ultraActivatedForTest = ultraActiveState.ultraEngaged;
  }
  check(
    "ultra.accountBackedCapableRowIsUsed",
    Boolean(
      ultraEntryChoice?.choiceKey &&
        ultraEntryChoice.ultraCapable &&
        ultraCapableRowSelected &&
        ultraActivatedForTest,
    ),
    {
      activatedThroughNativeLever: ultraActivatedForTest,
      entryChoiceKey: ultraEntryChoice?.choiceKey ?? null,
      entryRowId: ultraEntryChoice?.rowId ?? null,
      selectedChoiceKey: ultraActiveState.selectedChoiceKey,
      ultraCapableRowIds: ultraActiveState.ultraCapableRowIds,
    },
  );
  const particleSamples = [];
  for (const milliseconds of [0, 160, 340, 560]) {
    if (milliseconds > (particleSamples.at(-1)?.at ?? 0)) {
      await delay(milliseconds - (particleSamples.at(-1)?.at ?? 0));
    }
    const state = await readState();
    particleSamples.push({
      animationCount: state.ultraParticleAnimationCount,
      at: milliseconds,
      engaged: state.ultraEngaged,
      visuals: state.ultraParticleVisuals,
    });
  }
  const particleVisualSignatures = new Set(
    particleSamples.map((sample) => JSON.stringify(sample.visuals)),
  );
  const ultraColorSettledState = await readState();
  check(
    "ultra.particlesMoveWhileNativeUltraIsSelected",
    ultraActiveState.ultraEngaged &&
      ultraActiveState.ultraParticleCount === 12 &&
      particleSamples.every((sample) => sample.engaged && sample.animationCount === 12) &&
      particleVisualSignatures.size >= 3,
    {
      activatedThroughNativeLever: ultraActivatedForTest,
      particleCount: ultraActiveState.ultraParticleCount,
      samples: particleSamples,
      uniqueVisualStateCount: particleVisualSignatures.size,
    },
  );
  check(
    "ultra.lightningIconsTurnPurple",
    ultraColorSettledState.ultraEngaged &&
      ultraColorSettledState.triggerLightningUltraPurple &&
      ultraColorSettledState.fastIconUltraPurple,
    {
      initialFastIconColor: ultraActiveState.fastIconColor,
      initialTriggerLightningColor: ultraActiveState.triggerLightningColor,
      settledFastIconColor: ultraColorSettledState.fastIconColor,
      settledTriggerLightningColor: ultraColorSettledState.triggerLightningColor,
      ultraEngaged: ultraColorSettledState.ultraEngaged,
    },
  );
  if (ultraActiveState.ultraEngaged) {
    const currentUltra = await readState();
    await clickAt(
      currentUltra.leverRect.left + currentUltra.leverRect.width / 2,
      currentUltra.leverRect.top + currentUltra.leverRect.height / 2,
    );
    const ultraOff = await waitForState((state) => !state.ultraEngaged, 4_000);
    await delay(300);
    const ultraSettledOff = await readState();
    check(
      "ultra.particlesStopAfterNativeUltraIsDisabled",
      !ultraOff.ultraEngaged && ultraSettledOff.ultraParticleAnimationCount === 0,
      {
        engaged: ultraSettledOff.ultraEngaged,
        particleAnimationCount: ultraSettledOff.ultraParticleAnimationCount,
      },
    );
    check(
      "ultra.lightningIconsReturnToNormalWhenDisabled",
      !ultraSettledOff.triggerLightningUltraPurple && !ultraSettledOff.fastIconUltraPurple,
      {
        fastIconColor: ultraSettledOff.fastIconColor,
        triggerLightningColor: ultraSettledOff.triggerLightningColor,
        ultraEngaged: ultraSettledOff.ultraEngaged,
      },
    );
  }

  let ultraRestoredState = await readState();
  if (ultraRestoredState.selectedChoiceKey !== originalChoiceKey) {
    const originalChoice = ultraRestoredState.cells.find(
      (cell) => cell.choiceKey === originalChoiceKey,
    );
    if (originalChoice?.rect) {
      await clickChoice(originalChoiceKey);
      ultraRestoredState = await waitForChoice(originalChoiceKey, 4_000);
      await delay(380);
    }
  }
  if (
    originalUltraEngaged === true &&
    !ultraRestoredState.ultraEngaged &&
    ultraRestoredState.leverDisabled === "false" &&
    ultraRestoredState.leverRect
  ) {
    await clickAt(
      ultraRestoredState.leverRect.left + ultraRestoredState.leverRect.width / 2,
      ultraRestoredState.leverRect.top + ultraRestoredState.leverRect.height / 2,
    );
    ultraRestoredState = await waitForState((state) => state.ultraEngaged, 4_000);
  }
  check(
    "ultra.nativeStateRestored",
    ultraRestoredState.selectedChoiceKey === originalChoiceKey &&
      ultraRestoredState.ultraEngaged === originalUltraEngaged,
    {
      expectedChoiceKey: originalChoiceKey,
      expectedEngaged: originalUltraEngaged,
      restoredChoiceKey: ultraRestoredState.selectedChoiceKey,
      restoredEngaged: ultraRestoredState.ultraEngaged,
    },
  );

  let fastBaseline = await readState();
  const fastStartingEnabled = fastBaseline.fastEnabled;
  const fastEvidence = {
    activeMode: fastBaseline.activeMode,
    available: fastBaseline.fastAvailable,
    originalEnabled: originalFastEnabled,
    supported: fastBaseline.fastSupported,
  };
  let fastPreconditionPassed = false;
  let fastChangedAwayFromOriginal = false;
  let fastRealChangeChecked = false;
  if (fastBaseline.fastSupported && fastBaseline.fastAvailable && fastBaseline.fastRect) {
    if (fastBaseline.fastEnabled) {
      await clickAt(
        fastBaseline.fastRect.left + fastBaseline.fastRect.width / 2,
        fastBaseline.fastRect.top + fastBaseline.fastRect.height / 2,
      );
      fastBaseline = await waitForState(
        (state) => !state.fastEnabled && !state.fastPending,
        5_000,
      );
      fastChangedAwayFromOriginal =
        originalFastEnabled === true && !fastBaseline.fastEnabled && !fastBaseline.fastPending;
    }
    fastPreconditionPassed = !fastBaseline.fastEnabled && !fastBaseline.fastPending;
    if (fastPreconditionPassed && fastBaseline.fastRect) {
      await clickAt(
        fastBaseline.fastRect.left + fastBaseline.fastRect.width / 2,
        fastBaseline.fastRect.top + fastBaseline.fastRect.height / 2,
      );
      const fastImmediate = await readState();
      const fastSamples = [{ at: 0, state: fastImmediate }];
      const startedAt = Date.now();
      let fastConfirmed = fastImmediate.fastEnabled && !fastImmediate.fastPending;
      while (Date.now() - startedAt < 5_000) {
        await delay(25);
        const state = await readState();
        fastSamples.push({ at: Date.now() - startedAt, state });
        fastConfirmed ||= state.fastEnabled && !state.fastPending;
        if (
          fastConfirmed &&
          fastSamples.some((sample) => sample.state.fastEffect === "striking") &&
          Date.now() - startedAt >= 180
        ) {
          break;
        }
      }
      const fastFinal = fastSamples.at(-1).state;
      const strikeSamples = fastSamples.filter(
        (sample) => sample.state.fastEffect === "striking" || sample.state.fastAnimationCount > 0,
      );
      const pendingSamples = fastSamples.filter((sample) => sample.state.fastPending);
      const immediatePendingUnchecked =
        fastImmediate.fastPending && fastImmediate.fastToggleChecked === "false";
      const immediateAlreadyConfirmed =
        fastImmediate.fastEnabled &&
        !fastImmediate.fastPending &&
        fastImmediate.fastToggleChecked === "true";
      const pendingSamplesRemainUnchecked = pendingSamples.every(
        (sample) => sample.state.fastToggleChecked === "false",
      );
      const strikeSamplesAreConfirmed = strikeSamples.every(
        (sample) => sample.state.fastEnabled && !sample.state.fastPending,
      );
      if (originalFastEnabled === false) {
        fastChangedAwayFromOriginal = fastConfirmed && fastFinal.fastEnabled;
      }
      Object.assign(fastEvidence, {
        changedAwayFromOriginal: fastChangedAwayFromOriginal,
        confirmed: fastConfirmed,
        immediate: {
          checked: fastImmediate.fastToggleChecked,
          enabled: fastImmediate.fastEnabled,
          pending: fastImmediate.fastPending,
          path: immediatePendingUnchecked
            ? "pending-unchecked"
            : immediateAlreadyConfirmed
              ? "already-confirmed"
              : "invalid",
        },
        pendingSampleCount: pendingSamples.length,
        pendingSamplesRemainUnchecked,
        sampleCount: fastSamples.length,
        strikeSampleCount: strikeSamples.length,
        strikeSamplesAreConfirmed,
      });
      check(
        "fast.realNativeStateChangeOccurs",
        fastStartingEnabled === originalFastEnabled && fastChangedAwayFromOriginal,
        fastEvidence,
      );
      fastRealChangeChecked = true;
      check(
        "fast.nativeToggleConfirmsBeforeLightning",
        (immediatePendingUnchecked || immediateAlreadyConfirmed) &&
          pendingSamplesRemainUnchecked &&
          fastConfirmed &&
          fastFinal.fastToggleChecked === "true" &&
          strikeSamples.length >= 2 &&
          strikeSamplesAreConfirmed,
        fastEvidence,
      );
      await delay(fastLightningDurationMs + 100);
      const fastOnSettled = await readState();
      if (originalFastEnabled === false && fastOnSettled.fastRect) {
        await clickAt(
          fastOnSettled.fastRect.left + fastOnSettled.fastRect.width / 2,
          fastOnSettled.fastRect.top + fastOnSettled.fastRect.height / 2,
        );
      }
      const fastRestored = await waitForState(
        (state) => state.fastEnabled === originalFastEnabled && !state.fastPending,
        5_000,
      );
      check(
        "fast.nativeStateRestored",
        fastRestored.fastEnabled === originalFastEnabled && !fastRestored.fastPending,
        {
          expected: originalFastEnabled,
          restored: fastRestored.fastEnabled,
        },
      );
    }
  }
  if (!fastPreconditionPassed) {
    if (!fastRealChangeChecked) check("fast.realNativeStateChangeOccurs", false, fastEvidence);
    check("fast.nativeToggleConfirmsBeforeLightning", false, fastEvidence);
    check("fast.nativeStateRestored", false, fastEvidence);
  }

  await evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(panelId)});
    const host = document.getElementById('gpt-codex-custom-model-picker');
    const composer = host?.closest('form, .composer-surface-chrome');
    panel?.classList.remove('gpt-codex-model-picker--ultra-shake');
    composer?.removeAttribute('data-gpt-codex-ultra-shake');
    void panel?.offsetWidth;
    void composer?.offsetWidth;
    panel?.classList.add('gpt-codex-model-picker--ultra-shake');
    composer?.setAttribute('data-gpt-codex-ultra-shake', 'true');
    return true;
  })()`);
  const ultraMotionSamples = [];
  for (const milliseconds of [0, 80, 180, 320, 500, 680]) {
    if (milliseconds > (ultraMotionSamples.at(-1)?.at ?? 0)) {
      await delay(milliseconds - (ultraMotionSamples.at(-1)?.at ?? 0));
    }
    const state = await readState();
    ultraMotionSamples.push({
      at: milliseconds,
      panelTransform: state.panelTransform,
    });
  }
  const uniqueUltraTransforms = [
    ...new Set(ultraMotionSamples.map((sample) => sample.panelTransform)),
  ];
  check(
    "ultra.dampedResponseRuns",
    uniqueUltraTransforms.length >= 4 &&
      ultraMotionSamples.at(-1).panelTransform === "matrix(1, 0, 0, 1, 0, 0)",
    {
      accountUltraAvailable: dragRestored.ultraAvailable,
      samples: ultraMotionSamples,
      uniqueTransformCount: uniqueUltraTransforms.length,
    },
  );
  await evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(panelId)});
    const host = document.getElementById('gpt-codex-custom-model-picker');
    panel?.classList.remove('gpt-codex-model-picker--ultra-shake');
    host?.closest('form, .composer-surface-chrome')?.removeAttribute(
      'data-gpt-codex-ultra-shake',
    );
    return true;
  })()`);

  const screenshot = await request("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true,
  });
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));

  await ensurePanel(false);
  const reducedController = await evaluate(`(() => {
    const setter = globalThis.GPT_CODEX_CUSTOM_SET_MOTION_PREFERENCE;
    const getter = globalThis.GPT_CODEX_CUSTOM_MOTION_PREFERENCE;
    const storageKey = ${JSON.stringify(motionPreferenceStorageKey)};
    const storedBefore = localStorage.getItem(storageKey);
    const setResult = typeof setter === 'function'
      ? setter('reduced', { persist: false })
      : null;
    return {
      current: typeof getter === 'function' ? getter() : null,
      rootEffective: document.documentElement.getAttribute(
        ${JSON.stringify(motionEffectiveAttribute)},
      ),
      setResult,
      storedAfter: localStorage.getItem(storageKey),
      storedBefore,
    };
  })()`);
  await clickTrigger();
  const reducedOpen = await readState();
  await clickTrigger();
  const reducedClosed = await readState();
  check(
    "accessibility.reducedMotionIsImmediate",
    reducedController.setResult?.preference === "reduced" &&
      reducedController.setResult?.effective === "reduced" &&
      reducedController.rootEffective === "reduced" &&
      reducedController.storedAfter === reducedController.storedBefore &&
      reducedOpen.motionPreference === "reduced" &&
      reducedOpen.motionEffective === "reduced" &&
      reducedOpen.motionRootState === "reduced" &&
      reducedOpen.motionReduced &&
      reducedOpen.motionState === "open" &&
      reducedOpen.panelOpen &&
      /^0s(?:, 0s)*$/u.test(reducedOpen.panelTransitionDuration ?? "") &&
      reducedClosed.motionReduced &&
      reducedClosed.motionState === "closed" &&
      reducedClosed.panelHidden,
    {
      closed: {
        hidden: reducedClosed.panelHidden,
        motionReduced: reducedClosed.motionReduced,
        motionState: reducedClosed.motionState,
      },
      open: {
        effective: reducedOpen.motionEffective,
        motionReduced: reducedOpen.motionReduced,
        preference: reducedOpen.motionPreference,
        motionState: reducedOpen.motionState,
        rootState: reducedOpen.motionRootState,
        transitionDuration: reducedOpen.panelTransitionDuration,
      },
      preferenceController: reducedController,
    },
  );
} catch (error) {
  fatalError = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  try {
    await evaluate(`(() => {
      const panel = document.getElementById(${JSON.stringify(panelId)});
      const host = document.getElementById('gpt-codex-custom-model-picker');
      panel?.classList.remove('gpt-codex-model-picker--ultra-shake');
      host?.closest('form, .composer-surface-chrome')?.removeAttribute(
        'data-gpt-codex-ultra-shake',
      );
      return true;
    })()`);
    await ensurePanel(true);
    let state = await readState();
    if (
      originalUltraEngaged != null &&
      state.ultraEngaged !== originalUltraEngaged &&
      state.leverDisabled === "false" &&
      state.leverRect
    ) {
      await clickAt(
        state.leverRect.left + state.leverRect.width / 2,
        state.leverRect.top + state.leverRect.height / 2,
      );
      await waitForState((candidate) => candidate.ultraEngaged === originalUltraEngaged, 5_000);
      state = await readState();
    }
    if (
      originalFastEnabled != null &&
      state.fastEnabled !== originalFastEnabled &&
      state.fastAvailable &&
      state.fastRect
    ) {
      await clickAt(
        state.fastRect.left + state.fastRect.width / 2,
        state.fastRect.top + state.fastRect.height / 2,
      );
      await waitForState(
        (candidate) => candidate.fastEnabled === originalFastEnabled && !candidate.fastPending,
        5_000,
      );
    }
    if (originalChoiceKey) {
      state = await readState();
      if (state.selectedChoiceKey !== originalChoiceKey) {
        const original = state.cells.find((cell) => cell.choiceKey === originalChoiceKey);
        if (original?.rect) {
          await clickAt(
            original.rect.left + original.rect.width / 2,
            original.rect.top + original.rect.height / 2,
          );
          await waitForChoice(originalChoiceKey);
        }
      }
    }
    await ensurePanel(false);
    const closedCleanupState = await readState();
    if (originalProductMode && originalProductMode !== "codex") {
      await switchProductMode(originalProductMode);
    }
    const motionRestore = originalMotionControllerState?.preference
      ? await evaluate(`(() => {
          const setter = globalThis.GPT_CODEX_CUSTOM_SET_MOTION_PREFERENCE;
          const getter = globalThis.GPT_CODEX_CUSTOM_MOTION_PREFERENCE;
          const storageKey = ${JSON.stringify(motionPreferenceStorageKey)};
          const storedBefore = localStorage.getItem(storageKey);
          const restored = typeof setter === 'function'
            ? setter(${JSON.stringify(originalMotionControllerState?.preference)}, { persist: false })
            : null;
          return {
            current: typeof getter === 'function' ? getter() : null,
            restored,
            rootEffective: document.documentElement.getAttribute(
              ${JSON.stringify(motionEffectiveAttribute)},
            ),
            storedAfter: localStorage.getItem(storageKey),
            storedBefore,
          };
        })()`)
      : null;
    check(
      "motion.preferenceRestoredWithoutStorageMutation",
      motionRestore?.restored?.preference === originalMotionControllerState?.preference &&
        motionRestore?.current?.preference === originalMotionControllerState?.preference &&
        motionRestore?.rootEffective === motionRestore?.restored?.effective &&
        motionRestore?.storedBefore === originalMotionStoredValue &&
        motionRestore?.storedAfter === originalMotionStoredValue,
      {
        expected: originalMotionControllerState,
        expectedStoredValue: originalMotionStoredValue,
        restored: motionRestore,
      },
    );
    const finalCleanupState = await readState();
    check(
      "state.openAttributeIsCleanAfterVerifierClose",
      !closedCleanupState.panelOpen &&
        closedCleanupState.rootOpenState === "false" &&
        !finalCleanupState.panelOpen &&
        finalCleanupState.rootOpenState !== "true",
      {
        afterClose: {
          panelOpen: closedCleanupState.panelOpen,
          rootOpenState: closedCleanupState.rootOpenState,
        },
        afterModeRestore: {
          panelOpen: finalCleanupState.panelOpen,
          rootOpenState: finalCleanupState.rootOpenState,
        },
      },
    );
  } catch (cleanupError) {
    fatalError ??= `Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`;
  }
  socket.close();
}

const failed = checks.filter((entry) => !entry.passed);
const result = {
  checks,
  failed: failed.map((entry) => entry.name),
  fatalError,
  generatedAtUtc: new Date().toISOString(),
  passed: fatalError == null && failed.length === 0,
  renderer: matches[0].url,
  screenshotPath,
  verifier: path.basename(import.meta.filename),
};
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
