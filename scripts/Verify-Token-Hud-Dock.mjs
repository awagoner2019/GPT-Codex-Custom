import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const activePortPath = path.join(projectRoot, "profile", "chromium", "DevToolsActivePort");
const outputDirectory = path.join(projectRoot, "work", "verification");
const resultPath = path.join(outputDirectory, "token-hud-dock.json");
const screenshotPath = path.join(outputDirectory, "token-hud-dock-expanded.png");
const hostId = "gpt-codex-token-hud-host";
const hudId = "gpt-codex-token-hud";
const motionPreferenceKey = "gpt-codex-custom.motion-preference.v1";
const motionPreferences = new Set(["full", "reduced", "system"]);
const effectiveMotionValues = new Set(["full", "reduced"]);
const initialReadinessTimeoutMilliseconds = 5_000;
const rightDockGap = 14;
const rightDockTolerance = 1.25;
const viewportTolerance = 1;

const componentSourcePaths = Object.freeze({
  customCss: path.join(projectRoot, "custom", "gpt-codex-custom.css"),
  pinboardCss: path.join(projectRoot, "custom", "gpt-codex-pinboard.css"),
  pinboardJs: path.join(projectRoot, "custom", "gpt-codex-pinboard.js"),
  tokenHudCss: path.join(projectRoot, "custom", "gpt-codex-token-hud.css"),
});
const componentSources = Object.fromEntries(
  Object.entries(componentSourcePaths).map(([name, filePath]) => [
    name,
    fs.readFileSync(filePath, "utf8"),
  ]),
);
const compactSource = (source) => source.replace(/\s+/gu, " ").trim();
const compactSources = Object.fromEntries(
  Object.entries(componentSources).map(([name, source]) => [name, compactSource(source)]),
);
const countMotionDeclarations = (source) =>
  source.match(/\b(?:animation|transition)\s*:/gu)?.length ?? 0;
const osReducedMotionReferences = Object.entries(componentSources)
  .filter(([, source]) => /prefers-reduced-motion\s*:\s*reduce/iu.test(source))
  .map(([name]) => name);
const expectedReducedRules = Object.freeze({
  customCss:
    ':root[data-gpt-codex-motion="reduced"][data-gpt-codex-custom-mode="chat"] [data-pip-obstacle="quick-chat"], :root[data-gpt-codex-motion="reduced"] #gpt-codex-custom-chat-sidebar { transition: none !important; }',
  pinboardAnimations:
    ':root[data-gpt-codex-motion="reduced"] [data-gpt-codex-pinboard-control="bookmark"][data-gpt-codex-pinboard-state="pending"] .gpt-codex-pinboard-bookmark-icon, :root[data-gpt-codex-motion="reduced"] .gpt-codex-pinboard-empty[data-gpt-codex-pinboard-empty="loading"]::before { animation: none; }',
  pinboardTransitions:
    ':root[data-gpt-codex-motion="reduced"] [data-gpt-codex-pinboard-control="bookmark"], :root[data-gpt-codex-motion="reduced"] .gpt-codex-pinboard-launcher, :root[data-gpt-codex-motion="reduced"] .gpt-codex-pinboard-filter, :root[data-gpt-codex-motion="reduced"] .gpt-codex-pinboard-action { transition: none; }',
  tokenHudAnimation:
    ':root[data-gpt-codex-motion="reduced"] .gpt-codex-token-hud__panel { animation: none; }',
  tokenHudTransitions:
    ':root[data-gpt-codex-motion="reduced"] #gpt-codex-token-hud-host, :root[data-gpt-codex-motion="reduced"] .gpt-codex-token-hud__summary, :root[data-gpt-codex-motion="reduced"] .gpt-codex-token-hud__chevron, :root[data-gpt-codex-motion="reduced"] .gpt-codex-token-hud__context-progress-fill { transition: none; }',
});
const expectedPinboardJump =
  'behavior: document.documentElement.dataset.gptCodexMotion === "reduced" ? "auto" : "smooth",';
const sourceMotionChecks = [
  {
    evidence: {
      motionDeclarationCounts: Object.fromEntries(
        Object.entries(componentSources)
          .filter(([name]) => name.endsWith("Css"))
          .map(([name, source]) => [name, countMotionDeclarations(source)]),
      ),
      osReducedMotionReferences,
    },
    name: "source.fullMotionOverridesReducedOsMedia",
    passed:
      osReducedMotionReferences.length === 0 &&
      ["customCss", "pinboardCss", "tokenHudCss"].every(
        (name) => countMotionDeclarations(componentSources[name]) > 0,
      ),
  },
  {
    evidence: {
      customCss: compactSources.customCss.includes(expectedReducedRules.customCss),
      pinboardAnimations: compactSources.pinboardCss.includes(
        expectedReducedRules.pinboardAnimations,
      ),
      pinboardTransitions: compactSources.pinboardCss.includes(
        expectedReducedRules.pinboardTransitions,
      ),
      tokenHudAnimation: compactSources.tokenHudCss.includes(
        expectedReducedRules.tokenHudAnimation,
      ),
      tokenHudTransitions: compactSources.tokenHudCss.includes(
        expectedReducedRules.tokenHudTransitions,
      ),
    },
    name: "source.reducedMotionIsImmediate",
    passed:
      compactSources.customCss.includes(expectedReducedRules.customCss) &&
      compactSources.pinboardCss.includes(expectedReducedRules.pinboardAnimations) &&
      compactSources.pinboardCss.includes(expectedReducedRules.pinboardTransitions) &&
      compactSources.tokenHudCss.includes(expectedReducedRules.tokenHudAnimation) &&
      compactSources.tokenHudCss.includes(expectedReducedRules.tokenHudTransitions),
  },
  {
    evidence: {
      effectiveRootBranchPresent: compactSources.pinboardJs.includes(expectedPinboardJump),
      osMediaReferencePresent: /prefers-reduced-motion|matchMedia/iu.test(
        componentSources.pinboardJs,
      ),
    },
    name: "source.pinboardJumpUsesEffectiveMotion",
    passed:
      compactSources.pinboardJs.includes(expectedPinboardJump) &&
      !/prefers-reduced-motion|matchMedia/iu.test(componentSources.pinboardJs),
  },
];

if (process.argv.includes("--static")) {
  const failed = sourceMotionChecks.filter((entry) => !entry.passed);
  const result = {
    checks: sourceMotionChecks,
    failed: failed.map((entry) => entry.name),
    mode: "static-source",
    passed: failed.length === 0,
    verifier: path.basename(import.meta.filename),
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const rounded = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);
const roundedRect = (rect) =>
  rect
    ? Object.fromEntries(
        Object.entries(rect).map(([key, value]) => [key, rounded(value)]),
      )
    : null;

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

const debuggerUrl = new URL(matches[0].webSocketDebuggerUrl);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (
  debuggerUrl.protocol !== "ws:" ||
  !loopbackHosts.has(debuggerUrl.hostname) ||
  Number(debuggerUrl.port) !== port
) {
  throw new Error("The exact renderer target did not advertise the isolated loopback endpoint.");
}

const socket = new WebSocket(debuggerUrl.href);
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

async function clickAt(x, y) {
  await request("Input.dispatchMouseEvent", {
    button: "none",
    buttons: 0,
    type: "mouseMoved",
    x,
    y,
  });
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

async function readState() {
  return evaluate(`(() => {
    const host = document.getElementById(${JSON.stringify(hostId)});
    const hud = document.getElementById(${JSON.stringify(hudId)});
    const details = hud?.querySelector('.gpt-codex-token-hud__details');
    const summary = details?.querySelector(':scope > .gpt-codex-token-hud__summary');
    const panel = details?.querySelector(':scope > .gpt-codex-token-hud__panel');
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
    const visible = (element) => {
      if (!(element instanceof Element) || !element.isConnected || element.closest('[hidden]')) {
        return false;
      }
      const value = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        value.width > 1 &&
        value.height > 1 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0.01
      );
    };
    const marker = (element) => {
      if (!(element instanceof Element)) return null;
      if (element.id) return \`#\${element.id}\`;
      const classes = [...element.classList].slice(0, 3).join('.');
      return \`\${element.localName}\${classes ? \`.\${classes}\` : ''}\`;
    };
    const obstacles = [];
    const seen = new Set();
    const addObstacle = (element, kind, source) => {
      if (
        !(element instanceof Element) ||
        seen.has(element) ||
        element.closest('#${hostId}, #${hudId}') ||
        !visible(element)
      ) {
        return;
      }
      seen.add(element);
      obstacles.push({ kind, marker: marker(element), rect: rect(element), source });
    };

    addObstacle(
      document.getElementById('gpt-codex-custom-chat-sidebar'),
      'leftCustomSidebar',
      '#gpt-codex-custom-chat-sidebar',
    );
    addObstacle(
      document.getElementById('gpt-codex-pinboard-launcher'),
      'pinboard',
      '#gpt-codex-pinboard-launcher',
    );
    addObstacle(
      document.getElementById('gpt-codex-pinboard-drawer'),
      'pinboard',
      '#gpt-codex-pinboard-drawer',
    );
    addObstacle(
      document.getElementById('gpt-codex-custom-model-picker-panel'),
      'modelPanel',
      '#gpt-codex-custom-model-picker-panel',
    );

    const composerControlSelector = [
      'textarea:not([type="search"])',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="plaintext-only"][role="textbox"]',
    ].join(',');
    for (const control of document.querySelectorAll(composerControlSelector)) {
      if (!visible(control) || control.closest('form[data-thread-find-composer="true"]')) continue;
      const label = \`\${control.getAttribute('aria-label') ?? ''} \${
        control.getAttribute('placeholder') ?? ''
      }\`;
      if (/edit message|find|search/i.test(label)) continue;
      if (
        control.closest('[role="dialog"]') &&
        !control.closest('[data-pip-obstacle="quick-chat"]')
      ) {
        continue;
      }
      const composer =
        control.closest('.composer-surface-chrome') ??
        control.closest('form') ??
        control.closest('[data-testid*="composer" i], [data-composer]') ??
        control.parentElement;
      addObstacle(composer, 'composer', marker(control));
    }
    for (const composer of document.querySelectorAll('.composer-surface-chrome')) {
      addObstacle(composer, 'composer', '.composer-surface-chrome');
    }

    const hudRect = rect(hud);
    const collisionFor = (obstacle) => {
      if (!hudRect || !obstacle.rect) return null;
      const width = Math.min(hudRect.right, obstacle.rect.right) -
        Math.max(hudRect.left, obstacle.rect.left);
      const height = Math.min(hudRect.bottom, obstacle.rect.bottom) -
        Math.max(hudRect.top, obstacle.rect.top);
      return width > 0.5 && height > 0.5
        ? {
            height,
            kind: obstacle.kind,
            marker: obstacle.marker,
            source: obstacle.source,
            width,
          }
        : null;
    };
    const panelStyle = panel instanceof Element ? getComputedStyle(panel) : null;
    const panelAnimations = panel instanceof Element
      ? panel.getAnimations().map((animation) => {
          const timing = animation.effect?.getComputedTiming?.() ?? {};
          return {
            currentTime: Number.isFinite(Number(animation.currentTime))
              ? Number(animation.currentTime)
              : null,
            delay: Number.isFinite(Number(timing.delay)) ? Number(timing.delay) : null,
            duration: Number.isFinite(Number(timing.duration)) ? Number(timing.duration) : null,
            playState: animation.playState,
            progress: Number.isFinite(Number(timing.progress)) ? Number(timing.progress) : null,
          };
        })
      : [];
    const probe = globalThis.GPT_CODEX_CUSTOM_TOKEN_PROBE?.() ?? null;
    const motionGetter = globalThis.GPT_CODEX_CUSTOM_MOTION_PREFERENCE;
    const motionGetterAvailable = typeof motionGetter === 'function';
    const rootMotionEffective = document.documentElement.getAttribute('data-gpt-codex-motion');
    let motionGetterError = null;
    let motionSnapshot = null;
    if (motionGetterAvailable) {
      try {
        const candidate = motionGetter();
        if (candidate && typeof candidate === 'object') {
          motionSnapshot = {
            effective: typeof candidate.effective === 'string' ? candidate.effective : null,
            preference: typeof candidate.preference === 'string' ? candidate.preference : null,
            storageKey: typeof candidate.storageKey === 'string' ? candidate.storageKey : null,
            systemReduced:
              typeof candidate.systemReduced === 'boolean' ? candidate.systemReduced : null,
          };
        } else {
          motionGetterError = 'Motion preference getter returned a non-object snapshot.';
        }
      } catch (error) {
        motionGetterError = error instanceof Error ? error.message : String(error);
      }
    }
    let storedMotionPreference = null;
    let motionStorageAccessible = true;
    try {
      storedMotionPreference = localStorage.getItem(${JSON.stringify(motionPreferenceKey)});
    } catch {
      motionStorageAccessible = false;
    }

    return {
      collisions: obstacles.map(collisionFor).filter(Boolean),
      details: {
        open: details instanceof HTMLDetailsElement ? details.open : false,
        rect: rect(details),
      },
      detailsOpen: details instanceof HTMLDetailsElement ? details.open : false,
      host: {
        dock: host?.dataset.dock ?? null,
        overlapSafe: host?.dataset.overlapSafe ?? null,
        placement: host?.dataset.placement ?? null,
        positioned: host?.dataset.positioned ?? null,
        rect: rect(host),
        visible: visible(host),
      },
      hud: {
        dock: hud?.dataset.dock ?? null,
        expanded: hud?.dataset.expanded ?? null,
        hidden: hud?.hidden ?? true,
        rect: hudRect,
        visible: visible(hud),
      },
      motion: {
        effective: motionSnapshot?.effective ?? null,
        getterAvailable: motionGetterAvailable,
        getterError: motionGetterError,
        getterReturnedSnapshot: motionSnapshot !== null,
        preference: motionSnapshot?.preference ?? null,
        rootEffective: rootMotionEffective,
        rootEffectiveMatches:
          motionSnapshot !== null && motionSnapshot.effective === rootMotionEffective,
        setterAvailable: typeof globalThis.GPT_CODEX_CUSTOM_SET_MOTION_PREFERENCE === 'function',
        snapshotStorageKey: motionSnapshot?.storageKey ?? null,
        storageKeyMatches: motionSnapshot?.storageKey === ${JSON.stringify(motionPreferenceKey)},
        storageAccessible: motionStorageAccessible,
        storedPreference: storedMotionPreference,
        storedPreferencePresent: storedMotionPreference !== null,
        systemReduced: motionSnapshot?.systemReduced ?? null,
      },
      obstacles,
      panel: {
        animationName: panelStyle?.animationName ?? null,
        animations: panelAnimations,
        layoutHeight: panel instanceof HTMLElement ? panel.offsetHeight : null,
        layoutWidth: panel instanceof HTMLElement ? panel.offsetWidth : null,
        opacity: Number(panelStyle?.opacity ?? 0),
        rect: rect(panel),
        transform: panelStyle?.transform ?? null,
        transformOrigin: panelStyle?.transformOrigin ?? null,
        visible: visible(panel),
      },
      probe: probe
        ? {
            active: probe.active === true,
            dock: probe.dock ?? null,
            expanded: probe.expanded === true,
            overlapSafe: probe.overlapSafe !== false,
            placement: probe.placement ?? null,
          }
        : null,
      rendererMediaReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      summary: {
        ariaExpanded: summary?.getAttribute('aria-expanded') ?? null,
        rect: rect(summary),
        visible: visible(summary),
      },
      targetUrl: location.href,
      viewport: {
        deviceScaleFactor: devicePixelRatio,
        height: innerHeight,
        width: innerWidth,
      },
    };
  })()`);
}

async function waitForState(predicate, description, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let state = await readState();
  while (!predicate(state) && Date.now() < deadline) {
    await delay(40);
    state = await readState();
  }
  if (!predicate(state)) throw new Error(`Timed out waiting for ${description}.`);
  return state;
}

const visiblePositionedHudReady = (state) =>
  state.targetUrl === "app://-/index.html" &&
  state.host.visible &&
  state.hud.visible &&
  state.summary.visible &&
  state.host.positioned === "true";
const motionControllerReady = (state) =>
  state.motion.getterAvailable &&
  state.motion.getterReturnedSnapshot &&
  state.motion.setterAvailable &&
  state.motion.storageAccessible &&
  state.motion.storageKeyMatches &&
  motionPreferences.has(state.motion.preference) &&
  effectiveMotionValues.has(state.motion.effective) &&
  state.motion.rootEffectiveMatches;
const initialReadinessReady = (state) =>
  visiblePositionedHudReady(state) && motionControllerReady(state);
const readinessEvidenceFor = (state, timing) => ({
  elapsedMilliseconds: timing.elapsedMilliseconds,
  hud: {
    hostPositioned: state.host.positioned,
    hostVisible: state.host.visible,
    hudVisible: state.hud.visible,
    ready: visiblePositionedHudReady(state),
    summaryVisible: state.summary.visible,
    targetMatches: state.targetUrl === "app://-/index.html",
    targetUrl: state.targetUrl,
  },
  motionController: {
    effective: state.motion.effective,
    effectiveValid: effectiveMotionValues.has(state.motion.effective),
    getterAvailable: state.motion.getterAvailable,
    getterError: state.motion.getterError,
    getterReturnedSnapshot: state.motion.getterReturnedSnapshot,
    preference: state.motion.preference,
    preferenceValid: motionPreferences.has(state.motion.preference),
    ready: motionControllerReady(state),
    rootEffective: state.motion.rootEffective,
    rootEffectiveMatches: state.motion.rootEffectiveMatches,
    setterAvailable: state.motion.setterAvailable,
    snapshotStorageKey: state.motion.snapshotStorageKey,
    storageAccessible: state.motion.storageAccessible,
    storageKeyMatches: state.motion.storageKeyMatches,
    storedPreference: state.motion.storedPreference,
    storedPreferencePresent: state.motion.storedPreferencePresent,
    systemReduced: state.motion.systemReduced,
  },
  observations: timing.observations,
  ready: initialReadinessReady(state),
  timeoutMilliseconds: timing.timeoutMilliseconds,
});

async function waitForHudAndMotionController(timeout = initialReadinessTimeoutMilliseconds) {
  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  let observations = 1;
  let state = await readState();
  while (!initialReadinessReady(state) && Date.now() < deadline) {
    await delay(40);
    state = await readState();
    observations += 1;
  }

  const evidence = readinessEvidenceFor(state, {
    elapsedMilliseconds: Date.now() - startedAt,
    observations,
    timeoutMilliseconds: timeout,
  });
  if (!evidence.ready) {
    const error = new Error(
      `Timed out after ${timeout} ms waiting for the visible positioned token HUD and ` +
        `shared app motion controller. Last readiness evidence: ${JSON.stringify(evidence)}`,
    );
    error.readinessEvidence = evidence;
    throw error;
  }
  return { evidence, state };
}

async function clickSummary() {
  const state = await readState();
  const rect = state.summary.rect;
  if (!state.summary.visible || !rect) throw new Error("The token HUD summary is not clickable.");
  await clickAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

async function ensureOpen(open, settleMilliseconds = 0) {
  let state = await readState();
  if (state.detailsOpen !== open) {
    await clickSummary();
    state = await waitForState(
      (candidate) => candidate.detailsOpen === open,
      `the token HUD to ${open ? "open" : "close"}`,
    );
  }
  if (settleMilliseconds > 0) {
    await delay(settleMilliseconds);
    state = await readState();
  }
  return state;
}

async function setEmulatedMotionMedia(value) {
  await request("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value }],
  });
  mediaOverrideActive = true;
  return waitForState(
    (state) => state.rendererMediaReducedMotion === (value === "reduce"),
    `renderer motion media to report ${value}`,
  );
}

async function setAppMotionPreference(preference, expectedEffective) {
  if (!motionPreferences.has(preference)) {
    throw new Error(`Unsupported app motion preference: ${preference}.`);
  }
  await evaluate(`(() => {
    const setter = globalThis.GPT_CODEX_CUSTOM_SET_MOTION_PREFERENCE;
    if (typeof setter !== 'function') {
      throw new Error('The shared app motion controller is unavailable.');
    }
    setter(${JSON.stringify(preference)});
  })()`);
  return waitForState(
    (state) =>
      state.motion.preference === preference &&
      state.motion.effective === expectedEffective &&
      state.motion.storageAccessible,
    `app motion preference ${preference} with effective motion ${expectedEffective}`,
  );
}

async function restoreAppMotionState(snapshot) {
  if (!snapshot || !motionPreferences.has(snapshot.preference)) {
    throw new Error("The original app motion preference could not be restored safely.");
  }
  await setAppMotionPreference(snapshot.preference, snapshot.effective);
  await evaluate(`(() => {
    const key = ${JSON.stringify(motionPreferenceKey)};
    if (${JSON.stringify(snapshot.storedPreferencePresent)}) {
      localStorage.setItem(key, ${JSON.stringify(snapshot.storedPreference)});
    } else {
      localStorage.removeItem(key);
    }
  })()`);
  return readState();
}

const checks = [...sourceMotionChecks];
const check = (name, passed, evidence) => {
  checks.push({ evidence, name, passed: Boolean(passed) });
};
const rightGapFor = (state, rect) =>
  rect && Number.isFinite(state.viewport?.width) ? state.viewport.width - rect.right : null;
const atRightDockGap = (state, rect) => {
  const gap = rightGapFor(state, rect);
  return Number.isFinite(gap) && Math.abs(gap - rightDockGap) <= rightDockTolerance;
};
const insideViewport = (state, rect) =>
  Boolean(
    rect &&
      rect.left >= -viewportTolerance &&
      rect.top >= -viewportTolerance &&
      rect.right <= state.viewport.width + viewportTolerance &&
      rect.bottom <= state.viewport.height + viewportTolerance,
  );
const identityTransform = (value) =>
  value === "none" || value === "matrix(1, 0, 0, 1, 0, 0)";
const stateEvidence = (state, at = null) => ({
  at,
  collisions: state.collisions.map((collision) => ({
    ...collision,
    height: rounded(collision.height),
    width: rounded(collision.width),
  })),
  detailsRect: roundedRect(state.details.rect),
  detailsOpen: state.detailsOpen,
  hostRect: roundedRect(state.host.rect),
  hostRightGap: rounded(rightGapFor(state, state.host.rect)),
  hostVisible: state.host.visible,
  panelAnimations: state.panel.animations.map((animation) => ({
    ...animation,
    currentTime: rounded(animation.currentTime),
    delay: rounded(animation.delay),
    duration: rounded(animation.duration),
    progress: rounded(animation.progress),
  })),
  panelLayoutHeight: rounded(state.panel.layoutHeight),
  panelLayoutWidth: rounded(state.panel.layoutWidth),
  panelOpacity: rounded(state.panel.opacity),
  panelRect: roundedRect(state.panel.rect),
  panelTransform: state.panel.transform,
  panelVisible: state.panel.visible,
  motion: state.motion,
  rendererMediaReducedMotion: state.rendererMediaReducedMotion,
  summaryRect: roundedRect(state.summary.rect),
  summaryRightGap: rounded(rightGapFor(state, state.summary.rect)),
});

let fatalError = null;
let mediaOverrideActive = false;
let initialReadiness = null;
let originalMotion = null;
let originalOpen = null;
let rendererMediaReducedMotionAtStart = null;
let normalMotionSource = null;
let reducedMotionSystemFallback = null;
let restoration = null;
let screenshotCaptured = false;

await request("Runtime.enable");
await request("Page.enable");
await request("Page.bringToFront");

try {
  const readiness = await waitForHudAndMotionController();
  const ready = readiness.state;
  initialReadiness = readiness.evidence;
  check("hud.visiblePositionedWithMotionControllerReady", true, initialReadiness);

  // Capture both restoration snapshots from the same ready state before any mutation.
  originalOpen = ready.detailsOpen;
  rendererMediaReducedMotionAtStart = ready.rendererMediaReducedMotion;
  originalMotion = { ...ready.motion };

  // The initial media value is diagnostic evidence only. Tests always select an explicit app
  // preference, and cleanup restores the exact stored/global/effective state captured above.
  await setEmulatedMotionMedia("reduce");
  await setAppMotionPreference("full", "full");
  normalMotionSource = "explicit-full-app-preference-with-emulated-reduced-system-media";

  const collapsed = await ensureOpen(false, 280);
  check(
    "hud.collapsedVisibleAtRightDock",
    !collapsed.detailsOpen &&
      collapsed.host.visible &&
      collapsed.hud.visible &&
      collapsed.summary.visible &&
      collapsed.host.dock === "right" &&
      collapsed.hud.dock === "right" &&
      collapsed.host.placement === "fixed" &&
      collapsed.host.positioned === "true" &&
      collapsed.host.overlapSafe === "true" &&
      collapsed.summary.ariaExpanded === "false" &&
      atRightDockGap(collapsed, collapsed.host.rect) &&
      atRightDockGap(collapsed, collapsed.summary.rect),
    {
      expectedRightGap: rightDockGap,
      host: collapsed.host,
      hud: collapsed.hud,
      measured: stateEvidence(collapsed),
      tolerance: rightDockTolerance,
    },
  );

  const openingSamples = [];
  await clickSummary();
  const openingStartedAt = Date.now();
  for (const requestedAt of [0, 24, 55, 95, 150, 240, 360]) {
    const elapsed = Date.now() - openingStartedAt;
    if (requestedAt > elapsed) await delay(requestedAt - elapsed);
    openingSamples.push({
      actualAt: Date.now() - openingStartedAt,
      requestedAt,
      state: await readState(),
    });
  }
  const expanded = openingSamples.at(-1).state;
  if (!expanded.detailsOpen || !expanded.panel.visible) {
    throw new Error("The token HUD did not remain visibly expanded after clicking its summary.");
  }

  const normalMotionFrames = openingSamples.filter(({ state }) =>
    state.panel.animations.some(
      (animation) =>
        Number.isFinite(animation.duration) &&
        animation.duration > 0 &&
        animation.playState !== "finished",
    ),
  );
  const uniqueTransforms = new Set(
    openingSamples.map(({ state }) => state.panel.transform).filter(Boolean),
  );
  const intermediateOpacity = openingSamples.some(
    ({ state }) => state.panel.opacity > 0.02 && state.panel.opacity < 0.98,
  );
  check(
    "hud.expansionUsesNormalMotion",
    openingSamples.every(
      ({ state }) =>
        state.rendererMediaReducedMotion &&
        state.motion.preference === "full" &&
        state.motion.effective === "full",
    ) &&
      normalMotionFrames.length > 0 &&
      (intermediateOpacity || uniqueTransforms.size >= 3) &&
      expanded.panel.opacity > 0.99 &&
      identityTransform(expanded.panel.transform),
    {
      normalMotionSource,
      samples: openingSamples.map(({ actualAt, requestedAt, state }) =>
        stateEvidence(state, { actual: actualAt, requested: requestedAt }),
      ),
      uniqueTransformCount: uniqueTransforms.size,
    },
  );
  check(
    "hud.fullMotionOverridesReducedOsMedia",
    openingSamples.every(
      ({ state }) =>
        state.rendererMediaReducedMotion && state.motion.effective === "full",
    ) && normalMotionFrames.length > 0,
    {
      appPreference: "full",
      effectiveMotion: expanded.motion.effective,
      rendererMediaReducedMotion: expanded.rendererMediaReducedMotion,
    },
  );

  const anchoredFrames = openingSamples.filter(
    ({ state }) =>
      state.detailsOpen && state.host.rect && state.details.rect && state.panel.rect,
  );
  const expandedDockEnvelopeLeft = Math.min(
    expanded.host.rect.left,
    expanded.details.rect.left,
  );
  const dockEnvelopeInwardExtension =
    collapsed.summary.rect.left - expandedDockEnvelopeLeft;
  check(
    "hud.expansionRemainsRightAnchoredAndOpensInward",
    anchoredFrames.length >= 3 &&
      anchoredFrames.every(
        ({ state }) =>
          atRightDockGap(state, state.host.rect) &&
          atRightDockGap(state, state.details.rect) &&
          atRightDockGap(state, state.summary.rect),
      ) &&
      atRightDockGap(expanded, expanded.panel.rect) &&
      expandedDockEnvelopeLeft < collapsed.summary.rect.left - 24 &&
      dockEnvelopeInwardExtension > 24,
    {
      collapsedSummaryRect: roundedRect(collapsed.summary.rect),
      dockEnvelopeInwardExtension: rounded(dockEnvelopeInwardExtension),
      expectedRightGap: rightDockGap,
      expandedDetailsRect: roundedRect(expanded.details.rect),
      expandedDockEnvelopeLeft: rounded(expandedDockEnvelopeLeft),
      expandedHostRect: roundedRect(expanded.host.rect),
      expandedPanelRect: roundedRect(expanded.panel.rect),
      expandedPanelRightGap: rounded(rightGapFor(expanded, expanded.panel.rect)),
      expandedSummaryRect: roundedRect(expanded.summary.rect),
      rightAnchorGaps: anchoredFrames.map(({ actualAt, state }) => ({
        at: actualAt,
        details: rounded(rightGapFor(state, state.details.rect)),
        host: rounded(rightGapFor(state, state.host.rect)),
        summary: rounded(rightGapFor(state, state.summary.rect)),
      })),
      tolerance: rightDockTolerance,
    },
  );

  check(
    "hud.expandedStaysInsideViewport",
    insideViewport(expanded, expanded.host.rect) &&
      insideViewport(expanded, expanded.hud.rect) &&
      insideViewport(expanded, expanded.summary.rect) &&
      insideViewport(expanded, expanded.panel.rect),
    {
      hostRect: roundedRect(expanded.host.rect),
      hudRect: roundedRect(expanded.hud.rect),
      panelRect: roundedRect(expanded.panel.rect),
      summaryRect: roundedRect(expanded.summary.rect),
      tolerance: viewportTolerance,
      viewport: expanded.viewport,
    },
  );

  const obstacleCounts = expanded.obstacles.reduce((counts, obstacle) => {
    counts[obstacle.kind] = (counts[obstacle.kind] ?? 0) + 1;
    return counts;
  }, {});
  check(
    "hud.expandedAvoidsSidebarComposerPinboardAndModelPanel",
    expanded.collisions.length === 0 && expanded.host.overlapSafe === "true",
    {
      collisions: expanded.collisions,
      obstacleCounts,
      obstacles: expanded.obstacles.map((obstacle) => ({
        kind: obstacle.kind,
        marker: obstacle.marker,
        rect: roundedRect(obstacle.rect),
        source: obstacle.source,
      })),
      overlapSafe: expanded.host.overlapSafe,
    },
  );

  const screenshot = await request("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true,
  });
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  screenshotCaptured = true;

  await ensureOpen(false, 240);
  await setEmulatedMotionMedia("no-preference");
  await setAppMotionPreference("reduced", "reduced");
  const reducedCollapsed = await ensureOpen(false);
  await clickSummary();
  const reducedImmediate = await readState();
  await delay(40);
  const reducedSettled = await readState();
  const explicitReducedHasMotion = [reducedImmediate, reducedSettled].some((state) =>
    state.panel.animations.some(
      (animation) => Number.isFinite(animation.duration) && animation.duration > 0,
    ),
  );
  check(
    "hud.explicitReducedMotionIsImmediate",
    !reducedCollapsed.rendererMediaReducedMotion &&
      [reducedImmediate, reducedSettled].every(
        (state) =>
          !state.rendererMediaReducedMotion &&
          state.motion.preference === "reduced" &&
          state.motion.effective === "reduced",
      ) &&
      reducedImmediate.detailsOpen &&
      reducedImmediate.panel.visible &&
      reducedImmediate.panel.opacity > 0.99 &&
      identityTransform(reducedImmediate.panel.transform) &&
      !explicitReducedHasMotion,
    {
      collapsed: stateEvidence(reducedCollapsed),
      immediate: stateEvidence(reducedImmediate),
      settled: stateEvidence(reducedSettled),
    },
  );

  await ensureOpen(false);
  const systemNoPreference = await setAppMotionPreference("system", "full");
  await setEmulatedMotionMedia("reduce");
  const systemReduced = await waitForState(
    (state) =>
      state.rendererMediaReducedMotion &&
      state.motion.preference === "system" &&
      state.motion.effective === "reduced",
    "system motion preference to resolve to reduced",
  );
  await clickSummary();
  const systemReducedImmediate = await readState();
  await delay(40);
  const systemReducedSettled = await readState();
  const systemReducedHasMotion = [systemReducedImmediate, systemReducedSettled].some((state) =>
    state.panel.animations.some(
      (animation) => Number.isFinite(animation.duration) && animation.duration > 0,
    ),
  );
  await ensureOpen(false);
  await setEmulatedMotionMedia("no-preference");
  const systemRestoredFull = await waitForState(
    (state) =>
      !state.rendererMediaReducedMotion &&
      state.motion.preference === "system" &&
      state.motion.effective === "full",
    "system motion preference to resolve back to full",
  );
  reducedMotionSystemFallback = {
    doesNotInferPersonalSetting: true,
    exercised: true,
    source: "explicit-system-preference-following-emulated-media",
  };
  check(
    "hud.reducedMotionSystemFallbackIsImmediate",
    systemNoPreference.motion.effective === "full" &&
      systemReduced.motion.effective === "reduced" &&
      systemReducedImmediate.detailsOpen &&
      systemReducedImmediate.panel.visible &&
      systemReducedImmediate.panel.opacity > 0.99 &&
      identityTransform(systemReducedImmediate.panel.transform) &&
      !systemReducedHasMotion &&
      systemRestoredFull.motion.effective === "full",
    {
      ...reducedMotionSystemFallback,
      noPreference: stateEvidence(systemNoPreference),
      reduced: stateEvidence(systemReduced),
      reducedImmediate: stateEvidence(systemReducedImmediate),
      reducedSettled: stateEvidence(systemReducedSettled),
      restoredFull: stateEvidence(systemRestoredFull),
    },
  );
} catch (error) {
  if (error && typeof error === "object" && error.readinessEvidence) {
    initialReadiness = error.readinessEvidence;
    check("hud.visiblePositionedWithMotionControllerReady", false, initialReadiness);
  }
  fatalError = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  try {
    if (mediaOverrideActive) {
      await request("Emulation.setEmulatedMedia", { features: [] });
      mediaOverrideActive = false;
      await delay(60);
    }
    if (originalMotion) {
      const restoredMotion = await restoreAppMotionState(originalMotion);
      const motionRestored =
        restoredMotion.motion.preference === originalMotion.preference &&
        restoredMotion.motion.effective === originalMotion.effective &&
        restoredMotion.motion.storedPreferencePresent ===
          originalMotion.storedPreferencePresent &&
        restoredMotion.motion.storedPreference === originalMotion.storedPreference &&
        restoredMotion.rendererMediaReducedMotion === rendererMediaReducedMotionAtStart;
      restoration = {
        motion: {
          original: originalMotion,
          restored: restoredMotion.motion,
          rendererMediaReducedMotion: restoredMotion.rendererMediaReducedMotion,
        },
      };
      check("hud.motionPreferenceStateRestored", motionRestored, restoration.motion);
    }
    if (typeof originalOpen === "boolean") {
      const beforeRestore = await readState();
      if (beforeRestore.detailsOpen !== originalOpen) {
        await clickSummary();
        await waitForState(
          (state) => state.detailsOpen === originalOpen,
          "the original token HUD open state",
        );
      }
      const restored = await readState();
      restoration = {
        ...(restoration ?? {}),
        originalOpen,
        restoredOpen: restored.detailsOpen,
        rendererMediaReducedMotion: restored.rendererMediaReducedMotion,
      };
      check(
        "hud.originalOpenStateRestored",
        restored.detailsOpen === originalOpen,
        restoration,
      );
    }
  } catch (cleanupError) {
    const cleanupMessage =
      cleanupError instanceof Error ? cleanupError.stack ?? cleanupError.message : String(cleanupError);
    fatalError = fatalError
      ? `${fatalError}\nCleanup failed: ${cleanupMessage}`
      : `Cleanup failed: ${cleanupMessage}`;
  }
  socket.close();
}

const failed = checks.filter((entry) => !entry.passed);
const result = {
  activePortPath,
  checks,
  failed: failed.map((entry) => entry.name),
  fatalError,
  generatedAtUtc: new Date().toISOString(),
  initialReadiness,
  motionEnvironment: {
    normalMotionSource,
    reducedMotionSystemFallback,
    rendererMediaReducedMotionAtStart,
  },
  passed: fatalError == null && failed.length === 0,
  renderer: matches[0].url,
  restoration,
  resultPath,
  screenshotCaptured,
  screenshotPath,
  verifier: path.basename(import.meta.filename),
};
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
