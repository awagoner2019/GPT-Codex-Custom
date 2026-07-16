function sendRendererStatus(status, detail = null) {
  try {
    window.electronBridge
      ?.sendMessageFromView({
        type: "gpt-codex-custom-renderer-status",
        status,
        detail,
        href: window.location.href,
        readyState: document.readyState,
        viewport: { height: window.innerHeight, width: window.innerWidth },
      })
      ?.catch?.(() => {});
  } catch {
    // The normal diagnostics channel will take over once initialization finishes.
  }
}

window.addEventListener("error", (event) => {
  sendRendererStatus("error", {
    column: event.colno,
    line: event.lineno,
    message: event.message,
    source: event.filename,
    stack: event.error?.stack ?? null,
  });
});
window.addEventListener("unhandledrejection", (event) => {
  sendRendererStatus("unhandledrejection", {
    message: String(event.reason?.message ?? event.reason ?? "Unknown rejection"),
    stack: event.reason?.stack ?? null,
  });
});
sendRendererStatus("loaded");

const BUILD_INFO = Object.freeze({
  name: "GPT + Codex Custom",
  channel: "local-workspace",
  upstream: "manifest-pinned GPT/Codex desktop",
  features: Object.freeze([
    "first-class-chat-mode",
    "chatgpt-web-history",
    "persistent-product-selector",
    "sent-message-editing",
    "generated-image-editing",
    "reliable-generated-image-viewer",
    "native-chat-search",
    "native-chat-management",
    "token-usage-hud",
    "local-cross-mode-pinboard",
    "native-chat-destinations",
    "account-backed-chat-model-matrix",
    "reliable-chat-scroll",
  ]),
});

const CHAT_MODE_ATTRIBUTE = "data-gpt-codex-custom-mode";
const CHAT_MODE_STORAGE_KEY = "gpt-codex-custom.product-mode";
const CHAT_PRODUCT_ORIENTATION_SEEN_KEY =
  "gpt-codex-custom.product-orientation-seen.v1";
const CHAT_PRODUCT_MENU_OPTION_SELECTOR = '[role="menuitemradio"][data-mode]';
const CHAT_SELF_TEST_STORAGE_KEY = "gpt-codex-custom.self-test-attempt";
const CHAT_SEARCH_DEBOUNCE_MS = 250;
const CHAT_SEARCH_LIMIT = 20;
const CHAT_ACTION_BRIDGE_KEYS = Object.freeze([
  "archiveConversation",
  "deleteConversation",
  "pinConversation",
  "renameConversation",
  "shareConversation",
]);
const CHAT_AUXILIARY_ROUTES = Object.freeze({
  library: "/library",
  plugins: "/plugins",
  projects: "/projects",
  scheduled: "/automations",
});
const CHAT_MESSAGE_EDITOR_SELECTOR =
  '[contenteditable="true"][aria-label="Edit message"], textarea[aria-label="Edit message"], [role="textbox"][aria-label="Edit message"]';

let chatMode = false;
let initialProductModeDecision = null;
let chatLaunchPending = false;
let chatLaunchAttempts = 0;
let lastChatControlClickAt = 0;
let diagnosticsTimer = 0;
let diagnosticsBridgePromise;
let chatSidebarRenderTimer = 0;
let nativeConversationSelect = null;
let nativeNewChat = null;
let nativeSessionConversationId = null;
let nativeSessionTitle = null;
let nativeSessionInitialScrollMode = "follow";
let activeChatConversationId = null;
let chatThreadScrollGeneration = 0;
let chatThreadScrollSettlement = null;
let chatSearchOpen = false;
let chatSearchQuery = "";
let chatSearchDebounceTimer = 0;
let chatSearchRequestSequence = 0;
let nativeChatSearch = Object.freeze({ available: false, search: null });
let nativeChatActions = Object.freeze({
  archiveConversation: null,
  available: false,
  deleteConversation: null,
  pinConversation: null,
  renameConversation: null,
  shareConversation: null,
});
let nativeChatSearchResults = [];
let nativeChatSearchCursor = null;
let nativeChatSearchLoading = false;
let nativeChatSearchError = null;
let chatSidebarCollapsed = false;
let chatProductMenuOpen = false;
let chatProductMenuFocusMode = null;
let chatProductMenuFocusRequest = null;
let chatProductOrientationVisible = false;
let chatAuxiliaryView = null;
let chatSurfaceReturnOverride = false;
let chatSurfaceReturnTimer = 0;
let nativeNavigation = Object.freeze({});
let nativeNavigationLastRequested = null;
let nativeNavigationPendingDestination = null;
let nativeNavigationPendingFromPath = null;
let nativeNavigationPendingTimer = 0;
let nativeProfileIdentity = null;
let nativeProfileMenu = Object.freeze({});
let lastNativeProfileMenuReady = null;
let nativeProductModes = Object.freeze({});
let nativeImageComposer = Object.freeze({});
let nativeHistoryPagination = Object.freeze({
  canFetchNextPage: false,
  fetchNextPage: null,
  isFetchingNextPage: false,
});
const chatHistoryById = new Map();
const archivedChatConversationIds = new Set();
const deletedChatConversationIds = new Set();
let chatConversationMenuElement = null;
let chatConversationMenuTrigger = null;
let chatActionDialogElement = null;
let chatActionDialogConversationId = null;
let chatActionDialogFocusGeneration = 0;
let chatActionDialogOpener = null;
let chatDeleteDialogElement = null;
let chatDeleteDialogConversationId = null;
let chatDeleteDialogFocusGeneration = 0;
let chatDeleteDialogOpener = null;
let generatedImageViewerElement = null;
let generatedImageViewerOpener = null;
let generatedImageViewerSourceImage = null;
let generatedImageViewerScale = 1;

const CHAT_ICON_PATHS = Object.freeze({
  account:
    '<circle cx="12" cy="8" r="3.25"></circle><path d="M5.75 19c.55-3.35 2.6-5 6.25-5s5.7 1.65 6.25 5"></path>',
  archive:
    '<path d="M4 7.5h16v12H4z"></path><path d="M3 4.5h18v3H3z"></path><path d="M9 11.5h6"></path>',
  chevron: '<path d="m9 6 6 6-6 6"></path>',
  collapse:
    '<rect x="3.5" y="4" width="17" height="16" rx="3"></rect><path d="M9 4v16"></path>',
  delete:
    '<path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="m7 7 1 13h8l1-13"></path><path d="M10 11v5M14 11v5"></path>',
  library:
    '<rect x="3.5" y="4" width="17" height="16" rx="3"></rect><circle cx="9" cy="9" r="1.5"></circle><path d="m5.5 17 4.5-4 3 2.5 2.5-2 3 3.5"></path>',
  more:
    '<circle cx="5" cy="12" r="1.25" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"></circle><circle cx="19" cy="12" r="1.25" fill="currentColor" stroke="none"></circle>',
  newChat:
    '<path d="M13.5 5.5 18.5 10.5"></path><path d="m7 17 1.2-4.4L16.8 4a2.1 2.1 0 0 1 3 3l-8.6 8.6L7 17Z"></path><path d="M12 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V12"></path>',
  pin:
    '<path d="m14.5 4 5.5 5.5-3 1.5-4 4-.5 4.5-2-2-4 4-1-1 4-4-2-2 4.5-.5 4-4z"></path>',
  plugins:
    '<path d="M8.5 3.5v4h-4"></path><path d="M15.5 20.5v-4h4"></path><path d="M20.5 8.5h-4v-4"></path><path d="M3.5 15.5h4v4"></path><circle cx="12" cy="12" r="4"></circle>',
  projects:
    '<path d="M3.5 7.5h6l2-2h9v13H3.5z"></path><path d="M3.5 10.5h17"></path>',
  rename:
    '<path d="m4 20 4.25-1 10.5-10.5a2.1 2.1 0 0 0-3-3L5.25 16z"></path><path d="m13.5 7.5 3 3"></path>',
  scheduled:
    '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l-3 2"></path>',
  search:
    '<circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m15.5 15.5 4 4"></path>',
  share:
    '<path d="M12 15V4"></path><path d="m8 8 4-4 4 4"></path><path d="M5 12v7h14v-7"></path>',
});

function getInitialProductModeDecision({
  conversationRoute = false,
  orientationSeen = false,
  storageAvailable = true,
  storedMode = null,
} = {}) {
  const hasStoredMode = storedMode != null;
  const supportedStoredMode = ["chat", "native"].includes(storedMode) ? storedMode : null;
  const freshProfile = storageAvailable && !hasStoredMode && !orientationSeen;
  return Object.freeze({
    autoOpenProductMenu: freshProfile,
    chatMode: Boolean(conversationRoute || supportedStoredMode !== "native"),
    freshProfile,
    storedMode: supportedStoredMode,
  });
}

function getProductMenuNavigationIndex(key, currentIndex, itemCount) {
  if (!Number.isInteger(itemCount) || itemCount < 1) return -1;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown") return currentIndex < 0 ? 0 : (currentIndex + 1) % itemCount;
  if (key === "ArrowUp") {
    return currentIndex < 0 ? itemCount - 1 : (currentIndex - 1 + itemCount) % itemCount;
  }
  return -1;
}

function getProductMenuRovingTabStopIndex(items, preferredIndex = -1) {
  if (
    Number.isInteger(preferredIndex) &&
    preferredIndex >= 0 &&
    preferredIndex < items.length &&
    items[preferredIndex]?.disabled !== true
  ) {
    return preferredIndex;
  }
  const checkedIndex = items.findIndex(
    (item) => item?.disabled !== true && item?.checked === true,
  );
  if (checkedIndex >= 0) return checkedIndex;
  return items.findIndex((item) => item?.disabled !== true);
}

function runRendererContractSelfTest() {
  const initialModeCases = [
    {
      expected: { autoOpenProductMenu: true, chatMode: true },
      input: { storedMode: null },
      name: "fresh-profile-starts-in-chat",
    },
    {
      expected: { autoOpenProductMenu: false, chatMode: true },
      input: { storedMode: "chat" },
      name: "stored-chat-is-honored",
    },
    {
      expected: { autoOpenProductMenu: false, chatMode: false },
      input: { storedMode: "native" },
      name: "stored-native-is-honored",
    },
    {
      expected: { autoOpenProductMenu: false, chatMode: true },
      input: { storedMode: "stale-product-mode" },
      name: "invalid-stored-mode-falls-back-to-chat",
    },
    {
      expected: { autoOpenProductMenu: false, chatMode: true },
      input: { conversationRoute: true, storedMode: "native" },
      name: "conversation-route-forces-chat",
    },
    {
      expected: { autoOpenProductMenu: false, chatMode: true },
      input: { orientationSeen: true, storedMode: null },
      name: "seen-orientation-does-not-reopen",
    },
    {
      expected: { autoOpenProductMenu: false, chatMode: true },
      input: { storageAvailable: false, storedMode: null },
      name: "locked-storage-keeps-chat-without-claiming-freshness",
    },
  ].map((testCase) => {
    const actual = getInitialProductModeDecision(testCase.input);
    return Object.freeze({
      actual: Object.freeze({
        autoOpenProductMenu: actual.autoOpenProductMenu,
        chatMode: actual.chatMode,
      }),
      expected: Object.freeze(testCase.expected),
      name: testCase.name,
      pass:
        actual.autoOpenProductMenu === testCase.expected.autoOpenProductMenu &&
        actual.chatMode === testCase.expected.chatMode,
    });
  });
  const navigationCases = [
    ["ArrowDown", 0, 3, 1],
    ["ArrowDown", 2, 3, 0],
    ["ArrowUp", 0, 3, 2],
    ["ArrowUp", 2, 3, 1],
    ["Home", 2, 3, 0],
    ["End", 0, 3, 2],
  ].map(([key, currentIndex, itemCount, expected]) => {
    const actual = getProductMenuNavigationIndex(key, currentIndex, itemCount);
    return Object.freeze({ actual, currentIndex, expected, itemCount, key, pass: actual === expected });
  });
  const rovingItems = [
    { checked: false, disabled: false },
    { checked: true, disabled: false },
    { checked: false, disabled: true },
  ];
  const checkedTabStop = getProductMenuRovingTabStopIndex(rovingItems);
  const disabledPreferredTabStop = getProductMenuRovingTabStopIndex(rovingItems, 2);
  const preferredTabStop = getProductMenuRovingTabStopIndex(rovingItems, 0);
  const freshModeDecisionPass = initialModeCases.every((testCase) => testCase.pass);
  const productMenuKeyboardPass =
    navigationCases.every((testCase) => testCase.pass) &&
    checkedTabStop === 1 &&
    disabledPreferredTabStop === 1 &&
    preferredTabStop === 0;
  return Object.freeze({
    freshModeDecision: Object.freeze({ cases: Object.freeze(initialModeCases), pass: freshModeDecisionPass }),
    pass: freshModeDecisionPass && productMenuKeyboardPass,
    productMenuKeyboard: Object.freeze({
      checkedTabStop,
      disabledPreferredTabStop,
      navigationCases: Object.freeze(navigationCases),
      pass: productMenuKeyboardPass,
      preferredTabStop,
    }),
    schemaVersion: 1,
  });
}

const RENDERER_CONTRACT_SELF_TEST = runRendererContractSelfTest();

function markCustomBuild() {
  document.documentElement.dataset.gptCodexCustom = "ready";

  if (!document.getElementById("gpt-codex-custom-build-badge")) {
    const badge = document.createElement("div");
    badge.id = "gpt-codex-custom-build-badge";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = "Custom build";
    document.body.appendChild(badge);
  }
}

function ensureChatSidebar() {
  let sidebar = document.getElementById("gpt-codex-custom-chat-sidebar");
  if (sidebar) return sidebar;

  sidebar = document.createElement("aside");
  sidebar.id = "gpt-codex-custom-chat-sidebar";
  sidebar.setAttribute("aria-label", "Chat navigation");
  document.body.appendChild(sidebar);
  return sidebar;
}

function createChatIcon(name) {
  const icon = document.createElement("span");
  icon.className = "gpt-codex-custom-chat-nav-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${CHAT_ICON_PATHS[name] ?? CHAT_ICON_PATHS.more}</svg>`;
  return icon;
}

function createChatNavRow({ active = false, disabled = false, icon, label, onClick }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gpt-codex-custom-chat-nav-row";
  button.dataset.active = String(active);
  button.disabled = disabled;
  button.title = disabled ? `${label} is unavailable for this account or mode` : label;
  button.appendChild(createChatIcon(icon));
  const text = document.createElement("span");
  text.className = "gpt-codex-custom-chat-nav-label";
  text.textContent = label;
  button.appendChild(text);
  button.addEventListener("click", onClick);
  return button;
}

function setAuxiliaryView(destination) {
  const nextDestination = Object.hasOwn(CHAT_AUXILIARY_ROUTES, destination)
    ? destination
    : null;
  const changed = chatAuxiliaryView !== nextDestination;
  chatAuxiliaryView = nextDestination;
  if (nextDestination) {
    document.documentElement.dataset.gptCodexCustomAuxView = nextDestination;
  } else {
    document.documentElement.removeAttribute("data-gpt-codex-custom-aux-view");
  }
  return changed;
}

function clearAuxiliaryView() {
  return setAuxiliaryView(null);
}

function getAuxiliaryDestinationForPath(pathname) {
  if (typeof pathname !== "string") return null;
  return (
    Object.entries(CHAT_AUXILIARY_ROUTES).find(
      ([, route]) => pathname === route || pathname.startsWith(`${route}/`),
    )?.[0] ?? null
  );
}

function cancelPendingNativeNavigation() {
  window.clearTimeout(nativeNavigationPendingTimer);
  nativeNavigationPendingTimer = 0;
  nativeNavigationPendingDestination = null;
  nativeNavigationPendingFromPath = null;
}

function clearChatSurfaceReturnTimer() {
  window.clearTimeout(chatSurfaceReturnTimer);
  chatSurfaceReturnTimer = 0;
}

function reconcileAuxiliaryViewWithPath(pathname, { restoreChat = false } = {}) {
  if (typeof pathname !== "string") return false;
  const routedDestination = getAuxiliaryDestinationForPath(pathname);
  const previousDestination = chatAuxiliaryView;
  const surface = document.querySelector('[data-pip-obstacle="quick-chat"]');

  if (chatSurfaceReturnOverride) {
    if (routedDestination == null) {
      chatSurfaceReturnOverride = false;
      clearChatSurfaceReturnTimer();
    } else {
      if (surface) clearChatSurfaceReturnTimer();
      return clearAuxiliaryView();
    }
  }

  if (routedDestination) {
    cancelPendingNativeNavigation();
    return setAuxiliaryView(routedDestination);
  }

  if (
    nativeNavigationPendingDestination &&
    pathname === nativeNavigationPendingFromPath
  ) {
    return false;
  }
  if (nativeNavigationPendingDestination) cancelPendingNativeNavigation();

  const changed = clearAuxiliaryView();
  if (restoreChat && previousDestination && chatMode) {
    queueMicrotask(showNativeChatSurface);
  }
  return changed;
}

function failNativeChatLaunch(message) {
  chatLaunchPending = false;
  chatLaunchAttempts = 0;
  chatSurfaceReturnOverride = false;
  clearChatSurfaceReturnTimer();
  const changed = reconcileAuxiliaryViewWithPath(window.location.pathname);
  if (changed) scheduleChatSidebarRender();
  showCustomChatStatus(message, { error: true });
}

function showNativeChatSurface() {
  cancelPendingNativeNavigation();
  chatSurfaceReturnOverride = true;
  clearAuxiliaryView();
  const surface = document.querySelector('[data-pip-obstacle="quick-chat"]');
  if (surface) {
    chatLaunchPending = false;
    chatLaunchAttempts = 0;
    clearChatSurfaceReturnTimer();
    if (nativeSessionConversationId) {
      scheduleChatThreadBottomSettlement(
        nativeSessionConversationId,
        nativeSessionInitialScrollMode,
      );
    }
    return;
  }

  chatLaunchPending = false;
  setChatMode(true, { launch: true, persist: false });
  clearChatSurfaceReturnTimer();
  chatSurfaceReturnTimer = window.setTimeout(() => {
    chatSurfaceReturnTimer = 0;
    if (!chatSurfaceReturnOverride) return;
    if (document.querySelector('[data-pip-obstacle="quick-chat"]')) return;
    failNativeChatLaunch("Chat could not be restored because its native control did not open.");
  }, 4500);
}

function cancelChatThreadBottomSettlement(status = "idle") {
  chatThreadScrollGeneration += 1;
  const settlement = chatThreadScrollSettlement;
  chatThreadScrollSettlement = null;
  if (!settlement) {
    document.documentElement.dataset.gptCodexCustomChatScroll = status;
    return;
  }

  window.clearTimeout(settlement.timeoutId);
  window.cancelAnimationFrame(settlement.frameId);
  settlement.mutationObserver?.disconnect();
  settlement.resizeObserver?.disconnect();
  for (const removeListener of settlement.removeListeners) removeListener();
  document.documentElement.dataset.gptCodexCustomChatScroll = status;
}

function getChatThreadScrollState() {
  const surface = document.querySelector('[data-pip-obstacle="quick-chat"]');
  const viewport = surface?.querySelector('[data-quick-chat-thread-scroll-container="true"]');
  const scrollBottom =
    viewport instanceof HTMLElement
      ? Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      : null;
  return Object.freeze({
    atBottom:
      viewport instanceof HTMLElement
        ? Math.abs(viewport.scrollTop - scrollBottom) <= 1
        : null,
    available: viewport instanceof HTMLElement,
    conversationId: nativeSessionConversationId,
    initialScrollMode: nativeSessionInitialScrollMode,
    state: document.documentElement.dataset.gptCodexCustomChatScroll ?? "idle",
  });
}

function scheduleChatThreadBottomSettlement(conversationId, initialScrollMode = "follow") {
  cancelChatThreadBottomSettlement("idle");
  const normalizedConversationId = String(conversationId ?? "").trim();
  const normalizedMode = String(initialScrollMode ?? "follow").trim().toLocaleLowerCase();
  if (!chatMode || !normalizedConversationId) return;
  if (normalizedMode === "anchor-latest") {
    document.documentElement.dataset.gptCodexCustomChatScroll = "anchored";
    return;
  }

  const generation = chatThreadScrollGeneration;
  const settlement = {
    conversationId: normalizedConversationId,
    frameId: 0,
    mutationObserver: null,
    removeListeners: [],
    resizeObserver: null,
    timeoutId: 0,
    viewport: null,
  };
  chatThreadScrollSettlement = settlement;
  document.documentElement.dataset.gptCodexCustomChatScroll = "settling";

  const finish = (status = "settled") => {
    if (chatThreadScrollSettlement !== settlement) return;
    cancelChatThreadBottomSettlement(status);
  };
  const cancelForUserIntent = () => finish("cancelled");
  const cancelForNavigationKey = (event) => {
    if (
      ["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "].includes(
        event.key,
      )
    ) {
      cancelForUserIntent();
    }
  };

  const bindViewport = (viewport, content) => {
    settlement.viewport = viewport;
    const listenerOptions = { capture: true, passive: true };
    for (const type of ["wheel", "touchmove", "pointerdown"]) {
      viewport.addEventListener(type, cancelForUserIntent, listenerOptions);
      settlement.removeListeners.push(() =>
        viewport.removeEventListener(type, cancelForUserIntent, listenerOptions),
      );
    }
    viewport.addEventListener("keydown", cancelForNavigationKey, true);
    settlement.removeListeners.push(() =>
      viewport.removeEventListener("keydown", cancelForNavigationKey, true),
    );

    settlement.mutationObserver = new MutationObserver(() => scheduleFrame());
    settlement.mutationObserver.observe(content, {
      childList: true,
      subtree: true,
    });
    if (typeof ResizeObserver === "function") {
      settlement.resizeObserver = new ResizeObserver(() => scheduleFrame());
      settlement.resizeObserver.observe(viewport);
      settlement.resizeObserver.observe(content);
      const footer = viewport.parentElement?.querySelector('[data-thread-scroll-footer="true"]');
      if (footer) settlement.resizeObserver.observe(footer);
    }
  };

  const settle = () => {
    settlement.frameId = 0;
    if (
      chatThreadScrollSettlement !== settlement ||
      generation !== chatThreadScrollGeneration ||
      !chatMode ||
      chatAuxiliaryView != null ||
      nativeSessionConversationId !== normalizedConversationId
    ) {
      finish("cancelled");
      return;
    }

    const surface = document.querySelector('[data-pip-obstacle="quick-chat"]');
    const viewport = surface?.querySelector('[data-quick-chat-thread-scroll-container="true"]');
    const content = surface?.querySelector('[data-quick-chat-thread-scroll-content="true"]');
    if (!(viewport instanceof HTMLElement) || !(content instanceof HTMLElement)) {
      scheduleFrame();
      return;
    }
    if (!settlement.viewport) bindViewport(viewport, content);
    if (settlement.viewport !== viewport) {
      finish("cancelled");
      scheduleChatThreadBottomSettlement(normalizedConversationId, normalizedMode);
      return;
    }

    const bottom = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (Math.abs(viewport.scrollTop - bottom) > 0.5) viewport.scrollTop = bottom;
  };

  function scheduleFrame() {
    if (chatThreadScrollSettlement !== settlement || settlement.frameId) return;
    settlement.frameId = window.requestAnimationFrame(() => {
      settlement.frameId = window.requestAnimationFrame(settle);
    });
  }

  settlement.timeoutId = window.setTimeout(() => finish("settled"), 1800);
  scheduleFrame();
}

function findNativeNewChatControl() {
  const surface = document.querySelector('[data-pip-obstacle="quick-chat"]');
  return surface
    ? [...surface.querySelectorAll("button")].find(
        (button) =>
          !button.disabled &&
          /new chat/i.test(
            `${button.getAttribute("aria-label") ?? ""} ${button.textContent ?? ""}`,
          ),
      ) ?? null
    : null;
}

function startNewNativeChat() {
  const nativeAction = typeof nativeNewChat === "function" ? nativeNewChat : null;
  const fallbackControl = nativeAction ? null : findNativeNewChatControl();
  if (!nativeAction && !fallbackControl) {
    showCustomChatStatus("New chat is unavailable because its native bridge is not connected.", {
      error: true,
    });
    return;
  }

  closeChatSearch();
  const previousConversationId = activeChatConversationId;
  activeChatConversationId = null;
  showNativeChatSurface();
  try {
    const result = nativeAction ? nativeAction() : fallbackControl.click();
    result?.catch?.(() => {
      activeChatConversationId = previousConversationId;
      scheduleChatSidebarRender();
      showCustomChatStatus("New chat could not be opened by the native Chat action.", {
        error: true,
      });
    });
  } catch {
    activeChatConversationId = previousConversationId;
    showCustomChatStatus("New chat could not be opened by the native Chat action.", {
      error: true,
    });
  }
  scheduleChatSidebarRender();
}

function selectNativeConversation(conversationId, title) {
  if (typeof nativeConversationSelect !== "function") {
    showCustomChatStatus(
      "This conversation is unavailable because its native selection bridge is not connected.",
      { error: true },
    );
    return;
  }

  closeChatSearch();
  const previousConversationId = activeChatConversationId;
  activeChatConversationId = conversationId;
  showNativeChatSurface();
  try {
    const result = nativeConversationSelect(conversationId, title);
    result?.catch?.(() => {
      activeChatConversationId = previousConversationId;
      scheduleChatSidebarRender();
      showCustomChatStatus("The native Chat action could not open this conversation.", {
        error: true,
      });
    });
  } catch {
    activeChatConversationId = previousConversationId;
    showCustomChatStatus("The native Chat action could not open this conversation.", {
      error: true,
    });
  }
  scheduleChatSidebarRender();
}

function failNativeDestination(destination) {
  if (nativeNavigationPendingDestination !== destination) return;
  cancelPendingNativeNavigation();
  const changed = reconcileAuxiliaryViewWithPath(window.location.pathname, {
    restoreChat: true,
  });
  if (changed) scheduleChatSidebarRender();
  const label = destination === "scheduled" ? "Scheduled" : `${destination[0].toUpperCase()}${destination.slice(1)}`;
  showCustomChatStatus(`${label} could not be opened by the native navigation action.`, {
    error: true,
  });
}

function openNativeDestination(destination) {
  const nativeAction = nativeNavigation[destination];
  if (typeof nativeAction !== "function") {
    showCustomChatStatus("This destination is unavailable because its native bridge is not connected.", {
      error: true,
    });
    return;
  }

  closeChatSearch();
  chatSurfaceReturnOverride = false;
  clearChatSurfaceReturnTimer();
  cancelPendingNativeNavigation();
  nativeNavigationPendingDestination = destination;
  nativeNavigationPendingFromPath = nativeNavigation.path ?? window.location.pathname;
  nativeNavigationLastRequested = destination;
  setAuxiliaryView(destination);
  // Native routing also dismisses the Quick Chat overlay. Toggling its launcher
  // afterward restores the previous route, so leave that lifecycle to the shell.
  try {
    const result = nativeAction();
    result?.catch?.(() => failNativeDestination(destination));
  } catch {
    failNativeDestination(destination);
    return;
  }
  nativeNavigationPendingTimer = window.setTimeout(() => {
    if (nativeNavigationPendingDestination !== destination) return;
    if (getAuxiliaryDestinationForPath(window.location.pathname) === destination) {
      cancelPendingNativeNavigation();
      return;
    }
    failNativeDestination(destination);
  }, 3000);
  scheduleChatSidebarRender();
}

function findNativeProfileControl() {
  return (
    document.querySelector('[data-gpt-codex-custom-profile-control="true"]') ??
    [...document.querySelectorAll('button[aria-label]')].find(
      (button) =>
        !button.closest("#gpt-codex-custom-chat-sidebar") &&
        /Open profile menu|Open settings/i.test(button.getAttribute("aria-label") ?? ""),
    )
  );
}

function findConnectedNativeProfileControl() {
  const control = findNativeProfileControl();
  return control?.isConnected === true &&
    control.disabled !== true &&
    control.getAttribute("aria-disabled") !== "true"
    ? control
    : null;
}

function isNativeProfileMenuReady() {
  return (
    typeof nativeProfileMenu.open === "function" ||
    Boolean(findConnectedNativeProfileControl())
  );
}

function markNativeAccountMenu() {
  const controls = [...document.querySelectorAll('button, a, [role="menuitem"]')].filter(
    (element) =>
      !element.closest("#gpt-codex-custom-chat-sidebar") && element.getClientRects().length > 0,
  );
  const settings = controls.find(
    (element) => element.textContent?.replace(/\s+/g, " ").trim() === "Settings",
  );
  const logOut = controls.find((element) =>
    /^(Log out|Sign out)$/i.test(element.textContent?.replace(/\s+/g, " ").trim() ?? ""),
  );
  if (!settings || !logOut) return;
  let menu = settings.parentElement;
  while (menu && menu !== document.body && !menu.contains(logOut)) {
    menu = menu.parentElement;
  }
  if (menu && menu !== document.body) {
    menu.dataset.gptCodexCustomAccountMenu = "true";
  }
}

function openNativeProfileMenu() {
  if (typeof nativeProfileMenu.open === "function") {
    try {
      const result = nativeProfileMenu.open();
      result?.catch?.(() =>
        showCustomChatStatus("The native account menu could not be opened.", { error: true }),
      );
    } catch {
      showCustomChatStatus("The native account menu could not be opened.", { error: true });
      return;
    }
    window.setTimeout(markNativeAccountMenu, 0);
    window.setTimeout(markNativeAccountMenu, 100);
    return;
  }
  const control = findConnectedNativeProfileControl();
  if (!control) {
    showCustomChatStatus(
      "The account menu is unavailable because its native control is not connected.",
      { error: true },
    );
    return;
  }
  try {
    control.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        cancelable: true,
        isPrimary: true,
        pointerType: "mouse",
      }),
    );
    control.click();
  } catch {
    showCustomChatStatus("The connected native account control could not be opened.", {
      error: true,
    });
    return;
  }
  window.setTimeout(markNativeAccountMenu, 0);
  window.setTimeout(() => {
    markNativeAccountMenu();
    const menuMarked = Boolean(
      document.querySelector('[data-gpt-codex-custom-account-menu="true"]'),
    );
    const controlExpanded =
      control.getAttribute("aria-expanded") === "true" || control.dataset.state === "open";
    if (!menuMarked && !controlExpanded && nativeProfileMenu.isOpen !== true) {
      showCustomChatStatus("The connected native account control did not open its menu.", {
        error: true,
      });
    }
  }, 400);
}

function syncNativeProfileMenu(menu) {
  nativeProfileMenu = Object.freeze({ ...(menu ?? {}) });
  scheduleChatSidebarRender();
  scheduleDiagnostics();
}

function scheduleChatSidebarRender() {
  window.clearTimeout(chatSidebarRenderTimer);
  chatSidebarRenderTimer = window.setTimeout(renderChatSidebar, 0);
}

function getChatProductMenuOptions(menu, { enabledOnly = false } = {}) {
  if (!(menu instanceof Element)) return [];
  const options = [...menu.querySelectorAll(CHAT_PRODUCT_MENU_OPTION_SELECTOR)];
  return enabledOnly ? options.filter((option) => !option.disabled) : options;
}

function setChatProductMenuRovingTabStop(menu, preferredOption = null) {
  const options = getChatProductMenuOptions(menu);
  const preferredIndex = options.indexOf(preferredOption);
  const targetIndex = getProductMenuRovingTabStopIndex(
    options.map((option) => ({
      checked: option.getAttribute("aria-checked") === "true",
      disabled: option.disabled,
    })),
    preferredIndex,
  );
  options.forEach((option, index) => {
    option.tabIndex = index === targetIndex ? 0 : -1;
  });
  return targetIndex >= 0 ? options[targetIndex] : null;
}

function focusChatProductMenuOption(menu, preferredOption = null) {
  const target = setChatProductMenuRovingTabStop(menu, preferredOption);
  if (!target) return;
  chatProductMenuFocusMode = target.dataset.mode ?? null;
  target.focus({ preventScroll: true });
}

function handleChatProductMenuKeydown(event) {
  const menu = event.currentTarget;
  if (!(menu instanceof Element)) return;
  const options = getChatProductMenuOptions(menu, { enabledOnly: true });
  const currentOption =
    event.target instanceof Element
      ? event.target.closest(CHAT_PRODUCT_MENU_OPTION_SELECTOR)
      : null;
  const nextIndex = getProductMenuNavigationIndex(
    event.key,
    options.indexOf(currentOption),
    options.length,
  );
  if (nextIndex < 0) return;
  event.preventDefault();
  event.stopPropagation();
  focusChatProductMenuOption(menu, options[nextIndex]);
}

function markChatProductOrientationSeen() {
  try {
    localStorage.setItem(CHAT_PRODUCT_ORIENTATION_SEEN_KEY, "1");
  } catch {
    // A locked-down profile can still use the menu for this session.
  }
}

function openChatProductMenu({ showOrientation = false } = {}) {
  chatProductMenuOpen = true;
  chatProductOrientationVisible ||= showOrientation;
  chatProductMenuFocusMode = null;
  chatProductMenuFocusRequest = "current";
  scheduleChatSidebarRender();
}

function closeChatProductMenu({ restoreFocus = false } = {}) {
  const changed = chatProductMenuOpen || chatProductOrientationVisible;
  chatProductMenuOpen = false;
  chatProductOrientationVisible = false;
  chatProductMenuFocusMode = null;
  chatProductMenuFocusRequest = restoreFocus && chatMode ? "trigger" : null;
  if (changed || restoreFocus) scheduleChatSidebarRender();
}

function toggleChatProductMenu() {
  if (chatProductMenuOpen) {
    closeChatProductMenu({ restoreFocus: true });
  } else {
    openChatProductMenu();
  }
}

function getNativeProductModes() {
  const directBridge = globalThis.GPT_CODEX_CUSTOM_NATIVE_PRODUCT_MODES;
  return directBridge && typeof directBridge === "object" ? directBridge : nativeProductModes;
}

function selectNativeProductMode(mode) {
  if (!["work", "codex"].includes(mode)) return;
  const bridge = getNativeProductModes();
  const select = mode === "work" ? bridge.selectWork : bridge.selectCodex;
  closeChatProductMenu();

  if (typeof select === "function") {
    try {
      const result = select();
      setChatMode(false);
      result?.catch?.(() => {
        chatProductMenuFocusRequest = "trigger";
        setChatMode(true, { launch: true, persist: false });
        showCustomChatStatus(`The native ${mode} mode action could not be completed.`, {
          error: true,
        });
      });
    } catch {
      chatProductMenuFocusRequest = "trigger";
      setChatMode(true, { launch: true, persist: false });
      showCustomChatStatus(`The native ${mode} mode action could not be completed.`, {
        error: true,
      });
    }
    return;
  }

  const trigger = findProductModeTrigger();
  if (!trigger?.isConnected) {
    chatProductMenuFocusRequest = "trigger";
    showCustomChatStatus(
      `${mode === "work" ? "Work" : "Codex"} is unavailable because its native mode bridge is not connected.`,
      { error: true },
    );
    scheduleChatSidebarRender();
    return;
  }
  try {
    trigger.click();
  } catch {
    chatProductMenuFocusRequest = "trigger";
    showCustomChatStatus("The native product menu could not be opened.", { error: true });
    scheduleChatSidebarRender();
    return;
  }
  window.setTimeout(() => {
    const expectedLabel = mode === "work" ? "Work" : "Codex";
    const item = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].find(
      (candidate) => candidate.textContent?.replace(/\s+/g, " ").trim().startsWith(expectedLabel),
    );
    if (!item) {
      chatProductMenuFocusRequest = "trigger";
      showCustomChatStatus(`${expectedLabel} could not be found in the native product menu.`, {
        error: true,
      });
      scheduleChatSidebarRender();
      return;
    }
    try {
      item.click();
      setChatMode(false);
    } catch {
      chatProductMenuFocusRequest = "trigger";
      showCustomChatStatus(`The native ${expectedLabel} mode action could not be completed.`, {
        error: true,
      });
      scheduleChatSidebarRender();
    }
  }, 80);
}

function fetchNextNativeHistoryPage() {
  if (nativeHistoryPagination.isFetchingNextPage) return;
  if (typeof nativeHistoryPagination.fetchNextPage !== "function") {
    showCustomChatStatus(
      "More chats cannot be loaded because the native pagination bridge is not connected.",
      { error: true },
    );
    return;
  }
  try {
    const result = nativeHistoryPagination.fetchNextPage();
    result?.catch?.(() =>
      showCustomChatStatus("The native chat history action could not load more chats.", {
        error: true,
      }),
    );
  } catch {
    showCustomChatStatus("The native chat history action could not load more chats.", {
      error: true,
    });
  }
}

function reconcileNativeProfileMenuReadiness() {
  const ready = isNativeProfileMenuReady();
  if (ready === lastNativeProfileMenuReady) return;
  lastNativeProfileMenuReady = ready;
  scheduleChatSidebarRender();
}

function getNativeChatSearch() {
  if (typeof nativeChatSearch.search === "function" || nativeChatSearch.available === true) {
    return nativeChatSearch;
  }
  const directBridge = globalThis.GPT_CODEX_CUSTOM_CHAT_SEARCH;
  if (!directBridge || typeof directBridge !== "object") return nativeChatSearch;
  return {
    available: directBridge.available === true,
    search: typeof directBridge.search === "function" ? directBridge.search : null,
  };
}

function isNativeChatSearchAvailable(bridge = getNativeChatSearch()) {
  return bridge?.available === true && typeof bridge.search === "function";
}

function normalizeNativeChatSearchItems(items) {
  const normalized = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.kind !== "chatgpt" || !item.conversationId || !item.title) continue;
    const snippet =
      item.searchPreview?.kind === "contentMatch" && item.searchPreview.snippet
        ? String(item.searchPreview.snippet)
        : null;
    normalized.push({
      conversationId: String(item.conversationId),
      kind: "chatgpt",
      searchPreview: snippet ? { kind: "contentMatch", snippet } : null,
      searchTitle: item.searchTitle ? String(item.searchTitle) : String(item.title),
      title: String(item.title),
      updatedAt: item.updatedAt ?? null,
    });
  }
  return normalized;
}

async function requestNativeChatSearch(
  bridge,
  { query, cursor = null, limit = CHAT_SEARCH_LIMIT } = {},
) {
  const normalizedQuery = String(query ?? "").trim();
  if (!isNativeChatSearchAvailable(bridge) || !normalizedQuery) {
    return {
      available: bridge?.available === true,
      cursor: null,
      items: [],
    };
  }
  const response = await bridge.search({
    cursor,
    limit,
    query: normalizedQuery,
  });
  return {
    available: response?.available === true,
    cursor: response?.cursor ?? null,
    items: normalizeNativeChatSearchItems(response?.items),
  };
}

function clearNativeChatSearchResults({ cancelRequest = true } = {}) {
  if (cancelRequest) chatSearchRequestSequence += 1;
  nativeChatSearchResults = [];
  nativeChatSearchCursor = null;
  nativeChatSearchLoading = false;
  nativeChatSearchError = null;
}

function closeChatSearch({ clearQuery = false } = {}) {
  chatSearchOpen = false;
  window.clearTimeout(chatSearchDebounceTimer);
  chatSearchDebounceTimer = 0;
  if (clearQuery) chatSearchQuery = "";
  clearNativeChatSearchResults();
}

async function executeNativeChatSearch({ append = false, cursor = null, requestId = null } = {}) {
  const query = chatSearchQuery.trim();
  const bridge = getNativeChatSearch();
  if (!chatSearchOpen || !query || !isNativeChatSearchAvailable(bridge)) {
    clearNativeChatSearchResults();
    scheduleChatSidebarRender();
    return false;
  }

  const activeRequestId = requestId ?? ++chatSearchRequestSequence;
  if (activeRequestId !== chatSearchRequestSequence) return false;
  nativeChatSearchLoading = true;
  nativeChatSearchError = null;
  if (!append) {
    nativeChatSearchResults = [];
    nativeChatSearchCursor = null;
  }
  scheduleChatSidebarRender();

  try {
    const response = await requestNativeChatSearch(bridge, {
      cursor,
      limit: CHAT_SEARCH_LIMIT,
      query,
    });
    if (activeRequestId !== chatSearchRequestSequence || query !== chatSearchQuery.trim()) {
      return false;
    }
    if (!response.available) {
      nativeChatSearch = Object.freeze({
        available: false,
        search: typeof bridge.search === "function" ? bridge.search : null,
      });
      clearNativeChatSearchResults({ cancelRequest: false });
      scheduleChatSidebarRender();
      return false;
    }

    if (append) {
      const merged = new Map(
        nativeChatSearchResults.map((item) => [item.conversationId, item]),
      );
      for (const item of response.items) merged.set(item.conversationId, item);
      nativeChatSearchResults = [...merged.values()];
    } else {
      nativeChatSearchResults = response.items;
    }
    nativeChatSearchCursor = response.cursor;
    nativeChatSearchLoading = false;
    nativeChatSearchError = null;
    scheduleChatSidebarRender();
    scheduleDiagnostics();
    return true;
  } catch (error) {
    if (activeRequestId !== chatSearchRequestSequence) return false;
    nativeChatSearchLoading = false;
    nativeChatSearchError = error?.message ?? "Native chat search failed.";
    scheduleChatSidebarRender();
    showCustomChatStatus("Native chat search failed. You can retry from the search panel.", {
      error: true,
    });
    scheduleDiagnostics();
    return false;
  }
}

function scheduleNativeChatSearch() {
  window.clearTimeout(chatSearchDebounceTimer);
  chatSearchDebounceTimer = 0;
  const query = chatSearchQuery.trim();
  const bridge = getNativeChatSearch();
  chatSearchRequestSequence += 1;
  const requestId = chatSearchRequestSequence;
  nativeChatSearchResults = [];
  nativeChatSearchCursor = null;
  nativeChatSearchError = null;
  nativeChatSearchLoading =
    chatSearchOpen && Boolean(query) && isNativeChatSearchAvailable(bridge);
  scheduleChatSidebarRender();
  if (!nativeChatSearchLoading) return;
  chatSearchDebounceTimer = window.setTimeout(() => {
    chatSearchDebounceTimer = 0;
    void executeNativeChatSearch({ requestId });
  }, CHAT_SEARCH_DEBOUNCE_MS);
}

function loadNextNativeChatSearchPage() {
  if (nativeChatSearchLoading || nativeChatSearchCursor == null) return;
  if (!isNativeChatSearchAvailable()) {
    showCustomChatStatus(
      "More search results are unavailable because native Chat search is not connected.",
      { error: true },
    );
    return;
  }
  void executeNativeChatSearch({
    append: true,
    cursor: nativeChatSearchCursor,
  });
}

function syncNativeChatSearch(searchBridge) {
  const next = searchBridge && typeof searchBridge === "object" ? searchBridge : {};
  const wasAvailable = isNativeChatSearchAvailable(nativeChatSearch);
  nativeChatSearch = Object.freeze({
    available: next.available === true,
    search: typeof next.search === "function" ? next.search : null,
  });
  const isAvailable = isNativeChatSearchAvailable(nativeChatSearch);
  if (!isAvailable) {
    window.clearTimeout(chatSearchDebounceTimer);
    chatSearchDebounceTimer = 0;
    clearNativeChatSearchResults();
  } else if (!wasAvailable && chatSearchOpen && chatSearchQuery.trim()) {
    scheduleNativeChatSearch();
  }
  scheduleChatSidebarRender();
  scheduleDiagnostics();
}

function getNativeChatActions() {
  if (nativeChatActions.available === true || CHAT_ACTION_BRIDGE_KEYS.some(
    (key) => typeof nativeChatActions[key] === "function",
  )) {
    return nativeChatActions;
  }
  const directBridge = globalThis.GPT_CODEX_CUSTOM_CHAT_ACTIONS;
  if (!directBridge || typeof directBridge !== "object") return nativeChatActions;
  return Object.freeze({
    available: directBridge.available === true,
    ...Object.fromEntries(
      CHAT_ACTION_BRIDGE_KEYS.map((key) => [
        key,
        typeof directBridge[key] === "function" ? directBridge[key] : null,
      ]),
    ),
  });
}

function isNativeChatActionAvailable(action, actions = getNativeChatActions()) {
  return actions?.available === true && typeof actions[action] === "function";
}

function isNativeChatManagementAvailable(actions = getNativeChatActions()) {
  return CHAT_ACTION_BRIDGE_KEYS.every((key) => isNativeChatActionAvailable(key, actions));
}

function isAnyNativeChatActionAvailable(actions = getNativeChatActions()) {
  return CHAT_ACTION_BRIDGE_KEYS.some((key) => isNativeChatActionAvailable(key, actions));
}

function isNativeChatDeleteAvailable(actions = getNativeChatActions()) {
  return isNativeChatActionAvailable("deleteConversation", actions);
}

function syncNativeChatActions(actionsBridge) {
  const next = actionsBridge && typeof actionsBridge === "object" ? actionsBridge : {};
  const previousAvailability = CHAT_ACTION_BRIDGE_KEYS.map(
    (key) => typeof nativeChatActions[key] === "function",
  ).join("");
  nativeChatActions = Object.freeze({
    available: next.available === true,
    ...Object.fromEntries(
      CHAT_ACTION_BRIDGE_KEYS.map((key) => [
        key,
        typeof next[key] === "function" ? next[key] : null,
      ]),
    ),
  });
  const nextAvailability = CHAT_ACTION_BRIDGE_KEYS.map(
    (key) => typeof nativeChatActions[key] === "function",
  ).join("");
  if (previousAvailability !== nextAvailability) {
    scheduleChatSidebarRender();
  }
  scheduleDiagnostics();
}

function closeChatConversationMenu() {
  chatConversationMenuElement?.remove();
  chatConversationMenuElement = null;
  chatConversationMenuTrigger = null;
  document.removeEventListener("pointerdown", dismissChatConversationMenu, true);
}

function dismissChatConversationMenu(event) {
  const target = event.target;
  if (
    target instanceof Node &&
    (chatConversationMenuElement?.contains(target) || chatConversationMenuTrigger?.contains(target))
  ) {
    return;
  }
  closeChatConversationMenu();
}

function isSafeChatFocusTarget(element) {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  if ("disabled" in element && element.disabled) return false;
  if (element.closest('[hidden], [aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function getChatDialogFocusableElements(dialog) {
  if (!(dialog instanceof Element)) return [];
  return [
    ...dialog.querySelectorAll(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter(isSafeChatFocusTarget);
}

function trapChatDialogFocus(event, backdrop, dialogSelector) {
  if (event.key !== "Tab" || !backdrop) return false;
  const dialog = backdrop.querySelector(dialogSelector);
  if (!(dialog instanceof HTMLElement)) return false;
  const focusableElements = getChatDialogFocusableElements(dialog);
  const first = focusableElements[0] ?? null;
  const last = focusableElements.at(-1) ?? null;
  const active = document.activeElement;
  event.stopPropagation();
  if (!first || !last) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return true;
  }
  if (!dialog.contains(active) || (event.shiftKey && active === first)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
  return true;
}

function findChatActionDialogFocusTarget(opener, conversationId) {
  const conversationRow = [...document.querySelectorAll(
    ".gpt-codex-custom-chat-sidebar-item-row",
  )].find((row) => row.dataset.conversationId === conversationId);
  return [
    opener,
    conversationRow?.querySelector('[data-gpt-codex-custom-conversation-menu-trigger="true"]'),
    conversationRow?.querySelector(".gpt-codex-custom-chat-sidebar-item"),
    document.querySelector('[data-gpt-codex-custom-new-chat="true"]'),
  ].find(isSafeChatFocusTarget);
}

function closeChatActionDialog({ restoreFocus = true } = {}) {
  const backdrop = chatActionDialogElement;
  if (!backdrop) return;
  const opener = chatActionDialogOpener;
  const conversationId = chatActionDialogConversationId;
  const focusGeneration = ++chatActionDialogFocusGeneration;
  backdrop.remove();
  chatActionDialogElement = null;
  chatActionDialogConversationId = null;
  chatActionDialogOpener = null;
  if (!restoreFocus) return;
  window.setTimeout(() => {
    if (focusGeneration !== chatActionDialogFocusGeneration || chatActionDialogElement) return;
    findChatActionDialogFocusTarget(opener, conversationId)?.focus({ preventScroll: true });
  }, 0);
}

function updateConversationTitleInCustomState(conversationId, title) {
  const conversation = chatHistoryById.get(conversationId);
  if (conversation) chatHistoryById.set(conversationId, { ...conversation, title });
  nativeChatSearchResults = nativeChatSearchResults.map((item) =>
    item.conversationId === conversationId
      ? { ...item, searchTitle: title, title }
      : item,
  );
  scheduleChatSidebarRender();
  scheduleDiagnostics();
}

function updateConversationPinnedInCustomState(conversationId, pinned) {
  const conversation = chatHistoryById.get(conversationId);
  if (conversation) {
    chatHistoryById.set(conversationId, {
      ...conversation,
      kind: pinned ? "pinned" : "recent",
      pinned,
    });
  }
  scheduleChatSidebarRender();
  scheduleDiagnostics();
}

function removeArchivedConversationFromCustomState(conversationId) {
  archivedChatConversationIds.add(conversationId);
  chatHistoryById.delete(conversationId);
  nativeChatSearchResults = nativeChatSearchResults.filter(
    (item) => item.conversationId !== conversationId,
  );
  if (activeChatConversationId === conversationId) {
    activeChatConversationId = null;
    startNewNativeChat();
  }
  scheduleChatSidebarRender();
  scheduleDiagnostics();
}

async function copyCustomText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    input.remove();
    return copied;
  }
}

function openChatActionDialog(conversation, action) {
  if (!['rename', 'share'].includes(action)) return;
  const bridgeAction = action === "rename" ? "renameConversation" : "shareConversation";
  if (!isNativeChatActionAvailable(bridgeAction)) {
    showCustomChatStatus(`${action === "rename" ? "Rename" : "Share"} is unavailable because its native bridge is not connected.`, {
      error: true,
    });
    return;
  }

  const opener = chatConversationMenuTrigger ?? document.activeElement;
  closeChatConversationMenu();
  closeChatActionDialog({ restoreFocus: false });
  closeChatDeleteDialog({ restoreFocus: false });
  const focusGeneration = ++chatActionDialogFocusGeneration;

  const backdrop = document.createElement("div");
  backdrop.className = "gpt-codex-custom-chat-action-backdrop";
  backdrop.dataset.action = action;
  const dialog = document.createElement("section");
  dialog.className = "gpt-codex-custom-chat-action-dialog";
  dialog.dataset.action = action;
  dialog.dataset.conversationId = conversation.conversationId;
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("role", "dialog");
  dialog.tabIndex = -1;

  const title = document.createElement("h2");
  title.id = `gpt-codex-custom-chat-${action}-title`;
  title.textContent = action === "rename" ? "Rename chat" : "Share chat";
  dialog.setAttribute("aria-labelledby", title.id);
  const description = document.createElement("p");
  description.id = `gpt-codex-custom-chat-${action}-description`;
  description.textContent = action === "rename"
    ? "Choose a short, recognizable title."
    : "Create a public, anonymous link to this conversation. Anyone with the link can view it.";
  dialog.setAttribute("aria-describedby", description.id);
  const status = document.createElement("p");
  status.className = "gpt-codex-custom-chat-action-status";
  status.setAttribute("aria-live", "polite");

  const field = document.createElement("div");
  field.className = "gpt-codex-custom-chat-action-field";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "gpt-codex-custom-chat-action-input";
  input.setAttribute("aria-label", action === "rename" ? "Chat title" : "Public share link");
  if (action === "rename") {
    input.maxLength = 160;
    input.value = conversation.title;
  } else {
    input.readOnly = true;
    field.hidden = true;
  }
  field.appendChild(input);

  const actions = document.createElement("div");
  actions.className = "gpt-codex-custom-chat-action-buttons";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "gpt-codex-custom-chat-action-cancel";
  cancel.textContent = action === "share" ? "Close" : "Cancel";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "gpt-codex-custom-chat-action-confirm";
  confirm.dataset.gptCodexCustomChatActionConfirm = action;
  confirm.textContent = action === "rename" ? "Save" : "Create link";

  const setPending = (pending) => {
    dialog.dataset.pending = String(pending);
    cancel.disabled = pending;
    confirm.disabled = pending || (action === "rename" && input.value.trim().length === 0);
    input.disabled = pending;
  };
  input.addEventListener("input", () => setPending(false));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !confirm.disabled) {
      event.preventDefault();
      confirm.click();
    }
  });
  cancel.addEventListener("click", () => closeChatActionDialog());
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop && dialog.dataset.pending !== "true") {
      closeChatActionDialog();
    }
  });
  confirm.addEventListener("click", async () => {
    if (confirm.disabled) return;
    if (action === "share" && dialog.dataset.shareUrl) {
      const copied = await copyCustomText(dialog.dataset.shareUrl);
      status.dataset.error = String(!copied);
      status.textContent = copied ? "Link copied." : "Copy failed. Select the link and copy it manually.";
      return;
    }

    const nativeAction = getNativeChatActions()[bridgeAction];
    if (typeof nativeAction !== "function") return;
    setPending(true);
    status.dataset.error = "false";
    status.textContent = action === "rename" ? "Renaming chat..." : "Creating public link...";
    try {
      const result = action === "rename"
        ? await nativeAction(conversation.conversationId, input.value.trim())
        : await nativeAction(conversation.conversationId, conversation.title);
      if (action === "rename") {
        if (result?.renamed !== true) throw new Error("The native Chat rename action did not confirm the update.");
        globalThis.GPT_CODEX_CUSTOM_CHAT_ACTION_UI_RESULT = {
          action,
          conversationId: conversation.conversationId,
          dryRun: result.dryRun === true,
        };
        if (result.dryRun !== true) {
          updateConversationTitleInCustomState(conversation.conversationId, result.title ?? input.value.trim());
          showCustomChatStatus("Chat renamed.");
        }
        closeChatActionDialog();
        return;
      }

      if (result?.shared !== true || typeof result.shareUrl !== "string") {
        throw new Error("The native Chat share action did not return a public link.");
      }
      globalThis.GPT_CODEX_CUSTOM_CHAT_ACTION_UI_RESULT = {
        action,
        conversationId: conversation.conversationId,
        dryRun: result.dryRun === true,
        shareUrl: result.shareUrl,
      };
      if (result.dryRun === true) {
        closeChatActionDialog();
        return;
      }
      dialog.dataset.shareUrl = result.shareUrl;
      input.disabled = false;
      input.value = result.shareUrl;
      field.hidden = false;
      confirm.textContent = "Copy link";
      cancel.disabled = false;
      dialog.dataset.pending = "false";
      const copied = await copyCustomText(result.shareUrl);
      status.dataset.error = String(!copied);
      status.textContent = copied ? "Public link created and copied." : "Public link created. Copy it below.";
      input.focus({ preventScroll: true });
      input.select();
    } catch (error) {
      setPending(false);
      status.dataset.error = "true";
      status.textContent = error?.message ?? `The chat could not be ${action === "rename" ? "renamed" : "shared"}.`;
      showCustomChatStatus(`The chat could not be ${action === "rename" ? "renamed" : "shared"}. Please try again.`, {
        error: true,
      });
    }
  });

  actions.append(cancel, confirm);
  dialog.append(title, description, field, status, actions);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  chatActionDialogElement = backdrop;
  chatActionDialogConversationId = conversation.conversationId;
  chatActionDialogOpener = opener instanceof HTMLElement ? opener : null;
  setPending(false);
  queueMicrotask(() => {
    if (focusGeneration !== chatActionDialogFocusGeneration || chatActionDialogElement !== backdrop) return;
    (action === "rename" ? input : confirm).focus({ preventScroll: true });
    if (action === "rename") input.select();
  });
}

async function executeImmediateChatAction(conversation, action) {
  const bridgeAction = action === "pin" ? "pinConversation" : "archiveConversation";
  const nativeAction = getNativeChatActions()[bridgeAction];
  if (typeof nativeAction !== "function") {
    showCustomChatStatus(`${action === "pin" ? "Pin" : "Archive"} is unavailable because its native bridge is not connected.`, {
      error: true,
    });
    return;
  }
  closeChatConversationMenu();
  const nextPinned = !conversation.pinned;
  showCustomChatStatus(action === "pin" ? `${nextPinned ? "Pinning" : "Unpinning"} chat...` : "Archiving chat...");
  try {
    const result = action === "pin"
      ? await nativeAction(conversation.conversationId, nextPinned)
      : await nativeAction(conversation.conversationId);
    const succeeded = action === "pin" ? result?.pinned === nextPinned : result?.archived === true;
    if (!succeeded) throw new Error(`The native Chat ${action} action did not confirm the update.`);
    globalThis.GPT_CODEX_CUSTOM_CHAT_ACTION_UI_RESULT = {
      action,
      conversationId: conversation.conversationId,
      dryRun: result.dryRun === true,
    };
    if (result.dryRun === true) return;
    if (action === "pin") {
      updateConversationPinnedInCustomState(conversation.conversationId, nextPinned);
      showCustomChatStatus(nextPinned ? "Chat pinned." : "Chat unpinned.");
    } else {
      removeArchivedConversationFromCustomState(conversation.conversationId);
      showCustomChatStatus("Chat archived.");
    }
  } catch (error) {
    showCustomChatStatus(error?.message ?? `The chat could not be ${action === "pin" ? "pinned" : "archived"}.`, {
      error: true,
    });
  }
}

function findChatDeleteDialogFocusTarget(opener, conversationId) {
  const conversationRow = [...document.querySelectorAll(
    ".gpt-codex-custom-chat-sidebar-item-row",
  )].find((row) => row.dataset.conversationId === conversationId);
  const nativeProductTrigger = [...document.querySelectorAll("button[aria-label]")].find(
    (button) =>
      !button.matches('[data-gpt-codex-custom-product-selector="true"]') &&
      button.getAttribute("aria-label")?.startsWith("Switch mode, current mode:"),
  );
  return [
    opener,
    conversationRow?.querySelector('[data-gpt-codex-custom-conversation-menu-trigger="true"]'),
    conversationRow?.querySelector(".gpt-codex-custom-chat-sidebar-item"),
    document.querySelector('[data-gpt-codex-custom-new-chat="true"]'),
    document.querySelector('[data-gpt-codex-custom-product-selector="true"]'),
    nativeProductTrigger,
  ].find(isSafeChatFocusTarget);
}

function trapChatDeleteDialogFocus(event) {
  return trapChatDialogFocus(
    event,
    chatDeleteDialogElement,
    ".gpt-codex-custom-chat-delete-dialog",
  );
}

function closeChatDeleteDialog({ restoreFocus = true } = {}) {
  const backdrop = chatDeleteDialogElement;
  if (!backdrop) return;
  const opener = chatDeleteDialogOpener;
  const conversationId = chatDeleteDialogConversationId;
  const focusGeneration = ++chatDeleteDialogFocusGeneration;
  backdrop.remove();
  chatDeleteDialogElement = null;
  chatDeleteDialogConversationId = null;
  chatDeleteDialogOpener = null;
  if (!restoreFocus) return;
  window.setTimeout(() => {
    window.setTimeout(() => {
      if (focusGeneration !== chatDeleteDialogFocusGeneration || chatDeleteDialogElement) return;
      findChatDeleteDialogFocusTarget(opener, conversationId)?.focus({ preventScroll: true });
    }, 0);
  }, 0);
}

function removeDeletedConversationFromCustomState(conversationId) {
  deletedChatConversationIds.add(conversationId);
  chatHistoryById.delete(conversationId);
  nativeChatSearchResults = nativeChatSearchResults.filter(
    (item) => item.conversationId !== conversationId,
  );
  if (activeChatConversationId === conversationId) {
    activeChatConversationId = null;
    startNewNativeChat();
  }
  scheduleChatSidebarRender();
  scheduleDiagnostics();
}

function openChatDeleteDialog(conversation) {
  const opener = chatConversationMenuTrigger ?? document.activeElement;
  closeChatConversationMenu();
  closeChatDeleteDialog({ restoreFocus: false });
  const focusGeneration = ++chatDeleteDialogFocusGeneration;

  const backdrop = document.createElement("div");
  backdrop.id = "gpt-codex-custom-chat-delete-backdrop";
  backdrop.className = "gpt-codex-custom-chat-delete-backdrop";
  const dialog = document.createElement("section");
  dialog.className = "gpt-codex-custom-chat-delete-dialog";
  dialog.dataset.conversationId = conversation.conversationId;
  dialog.setAttribute("aria-labelledby", "gpt-codex-custom-chat-delete-title");
  dialog.setAttribute("aria-describedby", "gpt-codex-custom-chat-delete-description");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("role", "dialog");
  dialog.tabIndex = -1;

  const title = document.createElement("h2");
  title.id = "gpt-codex-custom-chat-delete-title";
  title.textContent = "Delete chat?";
  const description = document.createElement("p");
  description.id = "gpt-codex-custom-chat-delete-description";
  description.textContent = `This will permanently delete "${conversation.title}".`;
  const status = document.createElement("p");
  status.className = "gpt-codex-custom-chat-delete-status";
  status.setAttribute("aria-live", "polite");
  const actions = document.createElement("div");
  actions.className = "gpt-codex-custom-chat-delete-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "gpt-codex-custom-chat-delete-cancel";
  cancel.textContent = "Cancel";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "gpt-codex-custom-chat-delete-confirm";
  confirm.dataset.gptCodexCustomConfirmDelete = "true";
  confirm.textContent = "Delete";
  confirm.disabled = !isNativeChatDeleteAvailable();

  cancel.addEventListener("click", () => closeChatDeleteDialog());
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop && dialog.dataset.pending !== "true") {
      closeChatDeleteDialog();
    }
  });
  confirm.addEventListener("click", async () => {
    const nativeAction = getNativeChatActions().deleteConversation;
    if (typeof nativeAction !== "function" || confirm.disabled) return;
    confirm.disabled = true;
    cancel.disabled = true;
    dialog.dataset.pending = "true";
    status.dataset.error = "false";
    status.textContent = "Deleting chat...";
    try {
      const result = await nativeAction(conversation.conversationId);
      if (result?.deleted !== true) {
        throw new Error("The native Chat delete action did not confirm deletion.");
      }
      if (result.dryRun === true) {
        globalThis.GPT_CODEX_CUSTOM_DELETE_DRY_RUN_UI_RESULT = {
          conversationId: conversation.conversationId,
          confirmed: true,
        };
        closeChatDeleteDialog();
        return;
      }
      removeDeletedConversationFromCustomState(conversation.conversationId);
      closeChatDeleteDialog();
      showCustomChatStatus("Chat deleted.");
    } catch (error) {
      confirm.disabled = false;
      cancel.disabled = false;
      dialog.dataset.pending = "false";
      status.dataset.error = "true";
      status.textContent = error?.message ?? "The chat could not be deleted.";
      showCustomChatStatus("The chat could not be deleted. Please try again.", { error: true });
    }
  });

  actions.append(cancel, confirm);
  dialog.append(title, description, status, actions);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  chatDeleteDialogElement = backdrop;
  chatDeleteDialogConversationId = conversation.conversationId;
  chatDeleteDialogOpener = opener instanceof HTMLElement ? opener : null;
  queueMicrotask(() => {
    if (
      focusGeneration === chatDeleteDialogFocusGeneration &&
      chatDeleteDialogElement === backdrop &&
      cancel.isConnected
    ) {
      cancel.focus({ preventScroll: true });
    }
  });
}

function openChatConversationMenu(conversation, trigger) {
  closeChatConversationMenu();
  const nativeActions = getNativeChatActions();
  const menu = document.createElement("div");
  menu.id = "gpt-codex-custom-chat-conversation-menu";
  menu.className = "gpt-codex-custom-chat-conversation-menu";
  menu.dataset.conversationId = conversation.conversationId;
  menu.setAttribute("aria-label", `Actions for ${conversation.title}`);
  menu.setAttribute("role", "menu");

  const addItem = ({ action, icon, label, onClick }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gpt-codex-custom-chat-conversation-menu-item";
    button.dataset.action = action;
    button.disabled = !isNativeChatActionAvailable(`${action}Conversation`, nativeActions);
    button.setAttribute("role", "menuitem");
    button.append(createChatIcon(icon), document.createTextNode(label));
    button.addEventListener("click", onClick);
    menu.appendChild(button);
    return button;
  };

  const firstButton = addItem({
    action: "share",
    icon: "share",
    label: "Share",
    onClick: () => openChatActionDialog(conversation, "share"),
  });
  addItem({
    action: "rename",
    icon: "rename",
    label: "Rename",
    onClick: () => openChatActionDialog(conversation, "rename"),
  });
  addItem({
    action: "pin",
    icon: "pin",
    label: conversation.pinned ? "Unpin chat" : "Pin chat",
    onClick: () => void executeImmediateChatAction(conversation, "pin"),
  });
  addItem({
    action: "archive",
    icon: "archive",
    label: "Archive",
    onClick: () => void executeImmediateChatAction(conversation, "archive"),
  });
  const separator = document.createElement("div");
  separator.className = "gpt-codex-custom-chat-conversation-menu-separator";
  separator.setAttribute("role", "separator");
  menu.appendChild(separator);
  addItem({
    action: "delete",
    icon: "delete",
    label: "Delete",
    onClick: () => openChatDeleteDialog(conversation),
  });
  document.body.appendChild(menu);

  const rect = trigger.getBoundingClientRect();
  const width = Math.min(200, window.innerWidth - 16);
  const height = menu.getBoundingClientRect().height;
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))}px`;
  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const currentIndex = items.indexOf(document.activeElement);
    let nextIndex = -1;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1 + items.length) % items.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex >= 0) {
      event.preventDefault();
      items[nextIndex]?.focus();
    }
  });
  chatConversationMenuElement = menu;
  chatConversationMenuTrigger = trigger;
  window.setTimeout(
    () => document.addEventListener("pointerdown", dismissChatConversationMenu, true),
    0,
  );
  queueMicrotask(() => {
    const firstEnabled = menu.querySelector('[role="menuitem"]:not(:disabled)');
    (firstEnabled ?? firstButton).focus();
  });
}

function renderChatSidebar() {
  const activeProductMenuOption =
    document.activeElement instanceof Element
      ? document.activeElement.closest(CHAT_PRODUCT_MENU_OPTION_SELECTOR)
      : null;
  const productMenuHadFocus = Boolean(
    activeProductMenuOption?.closest('[data-gpt-codex-custom-product-menu="true"]'),
  );
  if (productMenuHadFocus) chatProductMenuFocusMode = activeProductMenuOption.dataset.mode ?? null;
  const productMenuFocusRequest = chatProductMenuFocusRequest;
  chatProductMenuFocusRequest = null;
  closeChatConversationMenu();
  const sidebar = ensureChatSidebar();
  sidebar.hidden = !chatMode;
  if (!chatMode) {
    chatProductMenuFocusMode = null;
    return;
  }
  sidebar.dataset.collapsed = String(chatSidebarCollapsed);
  const profileMenuReady = isNativeProfileMenuReady();
  lastNativeProfileMenuReady = profileMenuReady;

  const brand = document.createElement("div");
  brand.className = "gpt-codex-custom-chat-sidebar-brand";
  const brandTitle = document.createElement("button");
  brandTitle.type = "button";
  brandTitle.className = "gpt-codex-custom-chat-sidebar-brand-title";
  brandTitle.dataset.gptCodexCustomProductSelector = "true";
  brandTitle.setAttribute("aria-label", "Switch mode, current mode: Chat");
  brandTitle.setAttribute("aria-controls", "gpt-codex-custom-chat-product-menu");
  brandTitle.setAttribute("aria-haspopup", "menu");
  brandTitle.setAttribute("aria-expanded", String(chatProductMenuOpen));
  const brandLabel = document.createElement("span");
  brandLabel.textContent = "ChatGPT";
  const brandChevron = createChatIcon("chevron");
  brandChevron.classList.add("gpt-codex-custom-chat-product-chevron");
  brandTitle.append(brandLabel, brandChevron);
  brandTitle.addEventListener("click", toggleChatProductMenu);

  const productMenu = document.createElement("div");
  productMenu.id = "gpt-codex-custom-chat-product-menu";
  productMenu.className = "gpt-codex-custom-chat-product-menu";
  productMenu.dataset.gptCodexCustomProductMenu = "true";
  productMenu.hidden = !chatProductMenuOpen;
  productMenu.setAttribute("role", "menu");
  productMenu.setAttribute("aria-label", "Choose product mode");
  const productModes = getNativeProductModes();
  const currentProductMode = chatMode
    ? "chat"
    : ["work", "codex"].includes(productModes.mode)
      ? productModes.mode
      : "work";
  if (chatProductOrientationVisible) {
    const orientation = document.createElement("div");
    orientation.className = "gpt-codex-custom-chat-product-orientation";
    const orientationTitle = document.createElement("span");
    orientationTitle.className = "gpt-codex-custom-chat-product-orientation-title";
    orientationTitle.textContent = "Choose what fits";
    const orientationCopy = document.createElement("span");
    orientationCopy.id = "gpt-codex-custom-chat-product-orientation-copy";
    orientationCopy.className = "gpt-codex-custom-chat-product-orientation-copy";
    orientationCopy.textContent =
      "Each mode is ready for a different kind of task. Switch anytime.";
    orientation.append(orientationTitle, orientationCopy);
    productMenu.setAttribute("aria-describedby", orientationCopy.id);
    productMenu.appendChild(orientation);
    markChatProductOrientationSeen();
  }
  const productOptions = document.createElement("div");
  productOptions.className = "gpt-codex-custom-chat-product-options";
  productOptions.setAttribute("aria-label", "Product modes");
  productOptions.setAttribute("role", "group");
  for (const [mode, description] of [
    ["Chat", "Ask, write, create, and explore."],
    ["Work", "Run multi-step tasks with projects and connected apps."],
    ["Codex", "Inspect, edit, and run code in a selected folder."],
  ]) {
    const normalizedMode = mode.toLocaleLowerCase();
    const option = document.createElement("button");
    option.type = "button";
    option.className = "gpt-codex-custom-chat-product-option";
    option.dataset.mode = normalizedMode;
    option.setAttribute("role", "menuitemradio");
    option.setAttribute("aria-checked", String(normalizedMode === currentProductMode));
    option.tabIndex = -1;
    const optionCopy = document.createElement("span");
    optionCopy.className = "gpt-codex-custom-chat-product-option-copy";
    const optionLabel = document.createElement("span");
    optionLabel.className = "gpt-codex-custom-chat-product-option-label";
    optionLabel.textContent = mode;
    const optionDescription = document.createElement("span");
    optionDescription.className = "gpt-codex-custom-chat-product-option-description";
    optionDescription.textContent = description;
    optionCopy.append(optionLabel, optionDescription);
    option.appendChild(optionCopy);
    if (normalizedMode === currentProductMode) {
      const check = document.createElement("span");
      check.className = "gpt-codex-custom-chat-product-option-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓";
      option.appendChild(check);
    }
    if (mode === "Chat") {
      option.addEventListener("click", () => {
        closeChatProductMenu({ restoreFocus: true });
        setChatMode(true, { persist: true });
      });
    } else {
      const nativeBridgeReady = typeof productModes[`select${mode}`] === "function";
      option.dataset.nativeBridgeReady = String(nativeBridgeReady);
      option.disabled = !nativeBridgeReady;
      option.title = nativeBridgeReady
        ? `Switch to ${mode}`
        : `${mode} is unavailable because its native mode bridge is not connected`;
      option.addEventListener("click", () => selectNativeProductMode(normalizedMode));
    }
    productOptions.appendChild(option);
  }
  productMenu.appendChild(productOptions);
  const preferredProductOption = getChatProductMenuOptions(productMenu).find(
    (option) =>
      option.dataset.mode === chatProductMenuFocusMode ||
      (chatProductMenuFocusMode == null && option.getAttribute("aria-checked") === "true"),
  );
  setChatProductMenuRovingTabStop(productMenu, preferredProductOption);
  productMenu.addEventListener("keydown", handleChatProductMenuKeydown);
  productMenu.addEventListener("focusin", (event) => {
    const option =
      event.target instanceof Element
        ? event.target.closest(CHAT_PRODUCT_MENU_OPTION_SELECTOR)
        : null;
    if (option && productMenu.contains(option) && !option.disabled) {
      const tabStop = setChatProductMenuRovingTabStop(productMenu, option);
      chatProductMenuFocusMode = tabStop?.dataset.mode ?? null;
    }
  });
  const collapseButton = document.createElement("button");
  collapseButton.type = "button";
  collapseButton.className = "gpt-codex-custom-chat-sidebar-collapse";
  collapseButton.setAttribute("aria-label", chatSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar");
  collapseButton.appendChild(createChatIcon("collapse"));
  collapseButton.addEventListener("click", () => {
    chatProductMenuOpen = false;
    chatProductMenuFocusMode = null;
    chatProductOrientationVisible = false;
    chatSidebarCollapsed = !chatSidebarCollapsed;
    scheduleChatSidebarRender();
  });
  brand.append(brandTitle, collapseButton, productMenu);

  const nav = document.createElement("nav");
  nav.className = "gpt-codex-custom-chat-sidebar-nav";
  nav.setAttribute("aria-label", "ChatGPT navigation");
  const newChatButton = createChatNavRow({
    active: !activeChatConversationId && chatAuxiliaryView == null,
    disabled: typeof nativeNewChat !== "function",
    icon: "newChat",
    label: "New chat",
    onClick: startNewNativeChat,
  });
  newChatButton.dataset.gptCodexCustomNewChat = "true";
  nav.appendChild(newChatButton);
  nav.appendChild(
    createChatNavRow({
      active: chatSearchOpen,
      icon: "search",
      label: "Search chats",
      onClick: () => {
        chatSearchOpen = !chatSearchOpen;
        if (chatSearchOpen && chatSearchQuery.trim() && isNativeChatSearchAvailable()) {
          scheduleNativeChatSearch();
        } else {
          window.clearTimeout(chatSearchDebounceTimer);
          chatSearchDebounceTimer = 0;
          if (!chatSearchOpen) clearNativeChatSearchResults();
          scheduleChatSidebarRender();
        }
      },
    }),
  );
  for (const [destination, label, icon] of [
    ["library", "Library", "library"],
    ["projects", "Projects", "projects"],
    ["scheduled", "Scheduled", "scheduled"],
    ["plugins", "Plugins", "plugins"],
  ]) {
    nav.appendChild(
      createChatNavRow({
        active: chatAuxiliaryView === destination,
        disabled: typeof nativeNavigation[destination] !== "function",
        icon,
        label,
        onClick: () => openNativeDestination(destination),
      }),
    );
  }
  nav.appendChild(
    createChatNavRow({
      active: false,
      disabled: !profileMenuReady,
      icon: "more",
      label: "More",
      onClick: () => {
        closeChatSearch();
        openNativeProfileMenu();
        scheduleChatSidebarRender();
      },
    }),
  );

  const searchPanel = document.createElement("div");
  searchPanel.className = "gpt-codex-custom-chat-search-panel";
  searchPanel.hidden = !chatSearchOpen;
  const search = document.createElement("input");
  search.type = "search";
  search.className = "gpt-codex-custom-chat-sidebar-search";
  search.placeholder = "Search chats";
  search.value = chatSearchQuery;
  search.setAttribute("aria-label", "Search chats");
  searchPanel.appendChild(search);

  const history = document.createElement("div");
  history.className = "gpt-codex-custom-chat-sidebar-history";
  const conversations = [...chatHistoryById.values()].sort(
    (left, right) => (right.recencyAt ?? 0) - (left.recencyAt ?? 0),
  );

  function createConversationList(items, label) {
    const section = document.createElement("section");
    section.className = "gpt-codex-custom-chat-sidebar-section";
    const heading = document.createElement("h2");
    heading.className = "gpt-codex-custom-chat-sidebar-section-title";
    heading.textContent = label;
    const list = document.createElement("div");
    list.className = "gpt-codex-custom-chat-sidebar-list";
    list.setAttribute("role", "list");
    for (const conversation of items) {
      const row = document.createElement("div");
      row.className = "gpt-codex-custom-chat-sidebar-item-row";
      row.dataset.active = String(conversation.conversationId === activeChatConversationId);
      row.dataset.conversationId = conversation.conversationId;
      row.setAttribute("role", "listitem");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gpt-codex-custom-chat-sidebar-item";
      button.dataset.conversationId = conversation.conversationId;
      button.dataset.active = String(conversation.conversationId === activeChatConversationId);
      button.disabled = typeof nativeConversationSelect !== "function";
      button.title = button.disabled
        ? "This conversation is unavailable because its native selection bridge is not connected"
        : conversation.title;
      const text = document.createElement("span");
      text.className = "gpt-codex-custom-chat-sidebar-item-main";
      text.textContent = conversation.title;
      button.appendChild(text);
      button.addEventListener("click", () =>
        selectNativeConversation(conversation.conversationId, conversation.title),
      );
      const menuTrigger = document.createElement("button");
      menuTrigger.type = "button";
      menuTrigger.className = "gpt-codex-custom-chat-conversation-menu-trigger";
      menuTrigger.dataset.gptCodexCustomConversationMenuTrigger = "true";
      menuTrigger.dataset.conversationId = conversation.conversationId;
      const canManageConversation =
        isAnyNativeChatActionAvailable() &&
        !conversation.conversationId.startsWith("local-chatgpt:");
      menuTrigger.disabled = !canManageConversation;
      menuTrigger.setAttribute("aria-haspopup", "menu");
      menuTrigger.setAttribute("aria-label", `More options for ${conversation.title}`);
      menuTrigger.title = menuTrigger.disabled
        ? "Chat actions are unavailable because their native bridge is not connected"
        : `More options for ${conversation.title}`;
      menuTrigger.textContent = "\u2026";
      menuTrigger.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openChatConversationMenu(conversation, menuTrigger);
      });
      row.append(button, menuTrigger);
      list.appendChild(row);
    }
    section.append(heading, list);
    return section;
  }

  function createNativeSearchResultList(items) {
    const section = document.createElement("section");
    section.className = "gpt-codex-custom-chat-sidebar-section";
    const heading = document.createElement("h2");
    heading.className = "gpt-codex-custom-chat-sidebar-section-title";
    heading.textContent = "Search results";
    const list = document.createElement("div");
    list.className = "gpt-codex-custom-chat-sidebar-list";
    list.setAttribute("role", "list");
    for (const item of items) {
      const row = document.createElement("div");
      row.setAttribute("role", "listitem");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gpt-codex-custom-chat-sidebar-item";
      button.dataset.conversationId = item.conversationId;
      button.dataset.gptCodexCustomSearchResult = "native";
      button.dataset.active = String(item.conversationId === activeChatConversationId);
      button.disabled = typeof nativeConversationSelect !== "function";
      button.title = button.disabled
        ? "This search result is unavailable because native conversation selection is not connected"
        : item.title;

      const copy = document.createElement("span");
      copy.className = "gpt-codex-custom-chat-sidebar-item-main";
      copy.style.display = "grid";
      copy.style.gap = "2px";
      const title = document.createElement("span");
      title.style.overflow = "hidden";
      title.style.textOverflow = "ellipsis";
      title.style.whiteSpace = "nowrap";
      title.textContent = item.searchTitle || item.title;
      copy.appendChild(title);
      if (item.searchPreview?.snippet) {
        const snippet = document.createElement("span");
        snippet.dataset.gptCodexCustomSearchSnippet = "true";
        snippet.style.color =
          "var(--token-text-secondary, var(--gpt-codex-custom-chat-muted))";
        snippet.style.fontSize = "11px";
        snippet.style.overflow = "hidden";
        snippet.style.textOverflow = "ellipsis";
        snippet.style.whiteSpace = "nowrap";
        snippet.textContent = item.searchPreview.snippet;
        copy.appendChild(snippet);
      }
      button.appendChild(copy);
      button.addEventListener("click", () =>
        selectNativeConversation(item.conversationId, item.title),
      );
      row.appendChild(button);
      list.appendChild(row);
    }
    section.append(heading, list);
    return section;
  }

  function appendHistoryMessage(message, { error = false } = {}) {
    const status = document.createElement("div");
    status.className = "gpt-codex-custom-chat-sidebar-empty";
    status.dataset.error = String(error);
    status.textContent = message;
    history.appendChild(status);
  }

  function appendHistoryAction(label, onClick, { disabled = false } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gpt-codex-custom-chat-load-more";
    button.disabled = disabled;
    button.textContent = label;
    button.addEventListener("click", onClick);
    history.appendChild(button);
  }

  function populateHistory(query = "") {
    history.replaceChildren();
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const nativeSearchActive =
      chatSearchOpen && Boolean(normalizedQuery) && isNativeChatSearchAvailable();
    if (nativeSearchActive) {
      if (nativeChatSearchResults.length > 0) {
        history.appendChild(createNativeSearchResultList(nativeChatSearchResults));
      }
      if (nativeChatSearchLoading && nativeChatSearchResults.length === 0) {
        appendHistoryMessage("Searching chats...");
      } else if (nativeChatSearchError) {
        appendHistoryMessage(nativeChatSearchError, { error: true });
        appendHistoryAction("Retry search", () => void executeNativeChatSearch());
      } else if (!nativeChatSearchLoading && nativeChatSearchResults.length === 0) {
        appendHistoryMessage("No matching chats");
      }
      if (nativeChatSearchCursor != null) {
        appendHistoryAction(
          nativeChatSearchLoading ? "Loading more search results..." : "Load more search results",
          loadNextNativeChatSearchPage,
          { disabled: nativeChatSearchLoading },
        );
      }
      return;
    }

    // Loaded-title filtering is a fallback only when native account search is
    // unavailable. Every non-empty query uses the native bridge when ready.
    const useLoadedTitleFallback =
      chatSearchOpen && Boolean(normalizedQuery) && !isNativeChatSearchAvailable();
    const filtered = useLoadedTitleFallback
      ? conversations.filter((conversation) =>
          conversation.title.toLocaleLowerCase().includes(normalizedQuery),
        )
      : conversations;
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "gpt-codex-custom-chat-sidebar-empty";
      empty.textContent = conversations.length === 0 ? "Loading chat history…" : "No matching chats";
      history.appendChild(empty);
    } else {
      const pinned = filtered.filter((conversation) => conversation.pinned);
      const recent = filtered.filter((conversation) => !conversation.pinned);
      if (pinned.length > 0) history.appendChild(createConversationList(pinned, "Pinned"));
      if (recent.length > 0) history.appendChild(createConversationList(recent, "Recents"));
    }
    if (nativeHistoryPagination.canFetchNextPage) {
      const loadMore = document.createElement("button");
      loadMore.type = "button";
      loadMore.className = "gpt-codex-custom-chat-load-more";
      const paginationBridgeReady =
        typeof nativeHistoryPagination.fetchNextPage === "function";
      loadMore.disabled =
        nativeHistoryPagination.isFetchingNextPage || !paginationBridgeReady;
      loadMore.title = paginationBridgeReady
        ? "Load more chats"
        : "More chats are unavailable because the native pagination bridge is not connected";
      loadMore.textContent = nativeHistoryPagination.isFetchingNextPage
        ? "Loading more chats…"
        : useLoadedTitleFallback
          ? "Load more search results"
          : "Load more chats";
      loadMore.addEventListener("click", fetchNextNativeHistoryPage);
      history.appendChild(loadMore);
    }
  }

  search.addEventListener("input", () => {
    chatSearchQuery = search.value;
    if (chatSearchQuery.trim() && isNativeChatSearchAvailable()) {
      scheduleNativeChatSearch();
    } else {
      window.clearTimeout(chatSearchDebounceTimer);
      chatSearchDebounceTimer = 0;
      clearNativeChatSearchResults();
      populateHistory(chatSearchQuery);
    }
  });
  populateHistory(chatSearchOpen ? chatSearchQuery : "");

  const account = document.createElement("button");
  account.type = "button";
  account.className = "gpt-codex-custom-chat-account";
  account.setAttribute("aria-haspopup", "menu");
  account.setAttribute("aria-label", "Open profile menu");
  account.disabled = !profileMenuReady;
  const avatar = document.createElement(nativeProfileIdentity?.profileImageUrl ? "img" : "span");
  avatar.className = "gpt-codex-custom-chat-account-avatar";
  if (avatar instanceof HTMLImageElement) {
    avatar.src = nativeProfileIdentity.profileImageUrl;
    avatar.alt = "";
  } else {
    avatar.textContent = (nativeProfileIdentity?.displayName ?? "A").trim().slice(0, 1).toUpperCase();
  }
  const accountCopy = document.createElement("span");
  accountCopy.className = "gpt-codex-custom-chat-account-copy";
  const accountName = document.createElement("span");
  accountName.className = "gpt-codex-custom-chat-account-name";
  accountName.textContent = nativeProfileIdentity?.displayName ?? "Account";
  const accountPlan = document.createElement("span");
  accountPlan.className = "gpt-codex-custom-chat-account-plan";
  accountPlan.textContent = nativeProfileIdentity?.accountLabel ?? "Personal account";
  accountCopy.append(accountName, accountPlan);
  account.append(avatar, accountCopy, createChatIcon("chevron"));
  account.addEventListener("click", openNativeProfileMenu);

  sidebar.replaceChildren(brand, nav, searchPanel, history, account);
  if (chatProductMenuOpen && (productMenuFocusRequest === "current" || productMenuHadFocus)) {
    queueMicrotask(() => {
      if (!chatProductMenuOpen || !productMenu.isConnected) return;
      const preferredMode =
        productMenuFocusRequest === "current" ? currentProductMode : chatProductMenuFocusMode;
      const preferredOption = getChatProductMenuOptions(productMenu).find(
        (option) => option.dataset.mode === preferredMode,
      );
      focusChatProductMenuOption(productMenu, preferredOption);
    });
  } else if (!chatProductMenuOpen && productMenuFocusRequest === "trigger") {
    queueMicrotask(() => {
      if (brandTitle.isConnected) brandTitle.focus({ preventScroll: true });
    });
  } else if (chatSearchOpen && !chatProductMenuOpen) {
    queueMicrotask(() => {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    });
  }
}

function reconcileNativeChatHistory(historyById, conversations) {
  if (!Array.isArray(conversations)) return false;
  let changed = false;
  const authoritativeIds = new Set();
  const incomingIds = new Set(
    conversations
      .map((conversation) => conversation?.conversationId)
      .filter(Boolean),
  );

  for (const conversationId of deletedChatConversationIds) {
    if (!incomingIds.has(conversationId)) deletedChatConversationIds.delete(conversationId);
  }
  for (const conversationId of archivedChatConversationIds) {
    if (!incomingIds.has(conversationId)) archivedChatConversationIds.delete(conversationId);
  }

  for (const conversation of conversations) {
    if (!conversation?.conversationId) continue;
    if (
      deletedChatConversationIds.has(conversation.conversationId) ||
      archivedChatConversationIds.has(conversation.conversationId)
    ) {
      if (historyById.delete(conversation.conversationId)) changed = true;
      continue;
    }
    authoritativeIds.add(conversation.conversationId);
    if (!conversation.title) continue;
    const nextConversation = {
      conversationId: conversation.conversationId,
      kind: conversation.kind ?? (conversation.pinned ? "pinned" : "recent"),
      pinned: conversation.pinned === true || conversation.kind === "pinned",
      projectId: conversation.projectId ?? null,
      recencyAt: Number(conversation.recencyAt) || 0,
      title: String(conversation.title),
    };
    const currentConversation = historyById.get(conversation.conversationId);
    if (
      currentConversation?.title !== nextConversation.title ||
      currentConversation?.recencyAt !== nextConversation.recencyAt ||
      currentConversation?.kind !== nextConversation.kind ||
      currentConversation?.pinned !== nextConversation.pinned ||
      currentConversation?.projectId !== nextConversation.projectId
    ) {
      historyById.set(conversation.conversationId, nextConversation);
      changed = true;
    }
  }

  // The native history component supplies its complete flattened list of all
  // currently loaded pages. Prune against that full snapshot so deletions are
  // reflected without discarding older pages that remain in the list.
  for (const conversationId of historyById.keys()) {
    if (!authoritativeIds.has(conversationId)) {
      historyById.delete(conversationId);
      changed = true;
    }
  }
  return changed;
}

function syncNativeChatHistory(conversations, onConversationSelect, onNewChat) {
  const nextConversationSelect =
    typeof onConversationSelect === "function" ? onConversationSelect : null;
  const nextNewChat = typeof onNewChat === "function" ? onNewChat : null;
  let changed =
    Boolean(nativeConversationSelect) !== Boolean(nextConversationSelect) ||
    Boolean(nativeNewChat) !== Boolean(nextNewChat);
  nativeConversationSelect = nextConversationSelect;
  nativeNewChat = nextNewChat;
  changed = reconcileNativeChatHistory(chatHistoryById, conversations) || changed;

  if (changed || !document.getElementById("gpt-codex-custom-chat-sidebar")) {
    scheduleChatSidebarRender();
  }
}

function syncNativeChatSession(session) {
  const previousConversationId = nativeSessionConversationId;
  const conversationId = session?.conversationId ?? null;
  nativeSessionConversationId = conversationId;
  nativeSessionTitle = session?.title ?? null;
  nativeSessionInitialScrollMode = session?.initialScrollMode ?? "follow";
  activeChatConversationId = conversationId;
  if (conversationId && conversationId !== previousConversationId) {
    scheduleChatThreadBottomSettlement(conversationId, nativeSessionInitialScrollMode);
  } else if (!conversationId) {
    cancelChatThreadBottomSettlement("idle");
  }
  syncChatTokenContext(conversationId);
  scheduleChatSidebarRender();
  scheduleDiagnostics();
}

function syncChatTokenContext(
  conversationId = nativeSessionConversationId ?? activeChatConversationId ?? null,
) {
  globalThis.GPT_CODEX_CUSTOM_SYNC_TOKEN_CONTEXT?.({
    mode: "chat",
    source: "custom-chat-mode",
    threadId: conversationId,
    tokenUsage: null,
  });
}

function syncNativeProductModes(modes) {
  const next = modes && typeof modes === "object" ? modes : {};
  const previousAvailability = ["selectWork", "selectCodex"]
    .map((key) => typeof nativeProductModes[key] === "function")
    .join("");
  const nextAvailability = ["selectWork", "selectCodex"]
    .map((key) => typeof next[key] === "function")
    .join("");
  const modeChanged = nativeProductModes.mode !== next.mode;
  nativeProductModes = Object.freeze({ ...next });
  if (!chatMode && ["work", "codex"].includes(next.mode)) {
    globalThis.GPT_CODEX_CUSTOM_SYNC_TOKEN_CONTEXT?.({
      mode: next.mode,
      source: "product-mode",
      threadId: null,
      tokenUsage: null,
    });
  }
  if (previousAvailability !== nextAvailability || modeChanged) scheduleChatSidebarRender();
  scheduleDiagnostics();
}

function syncNativeImageComposer(composer) {
  nativeImageComposer = Object.freeze(
    composer && typeof composer === "object" ? { ...composer } : {},
  );
  scheduleDiagnostics();
}

function syncNativeHistoryPagination(pagination) {
  const next = pagination && typeof pagination === "object" ? pagination : {};
  const nextState = {
    canFetchNextPage: next.canFetchNextPage === true,
    fetchNextPage: typeof next.fetchNextPage === "function" ? next.fetchNextPage : null,
    isFetchingNextPage: next.isFetchingNextPage === true,
  };
  const changed =
    nativeHistoryPagination.canFetchNextPage !== nextState.canFetchNextPage ||
    nativeHistoryPagination.isFetchingNextPage !== nextState.isFetchingNextPage ||
    nativeHistoryPagination.fetchNextPage !== nextState.fetchNextPage;
  nativeHistoryPagination = Object.freeze(nextState);
  if (changed) scheduleChatSidebarRender();
  scheduleDiagnostics();
}

function syncNativeNavigation(actions) {
  const next = actions && typeof actions === "object" ? actions : {};
  const keys = ["library", "projects", "scheduled", "plugins"];
  const previousAvailability = keys
    .map((key) => typeof nativeNavigation[key] === "function")
    .join("");
  const nextAvailability = keys.map((key) => typeof next[key] === "function").join("");
  const pathChanged = nativeNavigation.path !== next.path;
  nativeNavigation = Object.freeze({ ...next });
  const auxiliaryChanged = reconcileAuxiliaryViewWithPath(next.path, { restoreChat: true });
  if (previousAvailability !== nextAvailability || pathChanged || auxiliaryChanged) {
    scheduleChatSidebarRender();
  }
  scheduleDiagnostics();
}

function syncNativeProfileIdentity(identity) {
  const next = identity && typeof identity === "object" ? identity : null;
  if (
    nativeProfileIdentity?.displayName !== next?.displayName ||
    nativeProfileIdentity?.profileImageUrl !== next?.profileImageUrl ||
    nativeProfileIdentity?.accountLabel !== next?.accountLabel
  ) {
    nativeProfileIdentity = next;
    scheduleChatSidebarRender();
  }
}

function getNativeImageComposer() {
  const directBridge = globalThis.GPT_CODEX_CUSTOM_IMAGE_COMPOSER;
  return directBridge && typeof directBridge.stageImage === "function"
    ? directBridge
    : nativeImageComposer;
}

function showCustomChatStatus(message, { error = false } = {}) {
  let status = document.getElementById("gpt-codex-custom-chat-status");
  if (!status) {
    status = document.createElement("div");
    status.id = "gpt-codex-custom-chat-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    document.body.appendChild(status);
  }
  status.dataset.error = String(error);
  status.textContent = message;
  status.hidden = false;
  window.clearTimeout(Number(status.dataset.dismissTimer) || 0);
  const timer = window.setTimeout(() => {
    if (status.isConnected) status.hidden = true;
  }, error ? 6000 : 3500);
  status.dataset.dismissTimer = String(timer);
}

function inferGeneratedImageType(source, blobType) {
  if (blobType?.startsWith("image/")) return blobType;
  const sourcePath = source.split(/[?#]/, 1)[0].toLocaleLowerCase();
  if (sourcePath.endsWith(".jpg") || sourcePath.endsWith(".jpeg")) return "image/jpeg";
  if (sourcePath.endsWith(".webp")) return "image/webp";
  if (sourcePath.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function generatedImageExtension(type) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "png";
}

async function renderedGeneratedImageToBlob(image) {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    try {
      await image.decode();
    } catch {
      // The dimensions below are the authoritative readiness check.
    }
  }
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    throw new Error("The generated image is still loading.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("Could not prepare the generated image canvas.");
  context.drawImage(image, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob?.size > 0) resolve(blob);
        else reject(new Error("The generated image was empty."));
      },
      "image/png",
    );
  });
}

async function generatedImageToFile(image) {
  const source = image.currentSrc || image.src;
  if (!source || source === "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==") {
    throw new Error("The generated image is still loading.");
  }

  let blob;
  if (source.startsWith("blob:")) {
    // Generated-image previews use blob:app:// URLs. Chromium can paint them,
    // but this injected module cannot fetch those URLs back into a File.
    blob = await renderedGeneratedImageToBlob(image);
  } else {
    try {
      const response = await fetch(source, { credentials: "include" });
      if (!response.ok && response.status !== 0) {
        throw new Error(`Could not load the generated image (${response.status}).`);
      }
      blob = await response.blob();
    } catch (fetchError) {
      try {
        blob = await renderedGeneratedImageToBlob(image);
      } catch {
        throw fetchError;
      }
    }
  }
  if (blob.size === 0) throw new Error("The generated image was empty.");
  const type = inferGeneratedImageType(source, blob.type);
  return new File([blob], `generated-image-edit-${Date.now()}.${generatedImageExtension(type)}`, {
    lastModified: Date.now(),
    type,
  });
}

function updateGeneratedImageViewerScale(nextScale) {
  generatedImageViewerScale = Math.min(4, Math.max(0.5, Number(nextScale) || 1));
  const viewerImage = generatedImageViewerElement?.querySelector(
    ".gpt-codex-custom-image-viewer-image",
  );
  const scaleLabel = generatedImageViewerElement?.querySelector(
    "[data-gpt-codex-custom-image-viewer-scale]",
  );
  if (viewerImage instanceof HTMLElement) {
    viewerImage.style.setProperty(
      "--gpt-codex-custom-image-viewer-scale",
      String(generatedImageViewerScale),
    );
  }
  if (scaleLabel) scaleLabel.textContent = `${Math.round(generatedImageViewerScale * 100)}%`;
}

function closeGeneratedImageViewer({ restoreFocus = true } = {}) {
  const viewer = generatedImageViewerElement;
  if (!viewer) return;
  const opener = generatedImageViewerOpener;
  viewer.remove();
  generatedImageViewerElement = null;
  generatedImageViewerOpener = null;
  generatedImageViewerSourceImage = null;
  generatedImageViewerScale = 1;
  document.documentElement.removeAttribute("data-gpt-codex-custom-image-viewer-open");
  if (restoreFocus && isSafeChatFocusTarget(opener)) {
    queueMicrotask(() => opener.focus({ preventScroll: true }));
  }
  scheduleDiagnostics();
}

function trapGeneratedImageViewerFocus(event) {
  return trapChatDialogFocus(
    event,
    generatedImageViewerElement,
    ".gpt-codex-custom-image-viewer-dialog",
  );
}

function openGeneratedImageViewer(sourceImage, opener) {
  if (!(sourceImage instanceof HTMLImageElement)) return false;
  const source = sourceImage.currentSrc || sourceImage.src;
  if (!source || source === "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==") {
    showCustomChatStatus("The generated image is still loading.", { error: true });
    return false;
  }

  closeGeneratedImageViewer({ restoreFocus: false });
  const backdrop = document.createElement("div");
  backdrop.id = "gpt-codex-custom-image-viewer";
  backdrop.className = "gpt-codex-custom-image-viewer";
  backdrop.dataset.gptCodexCustomImageViewer = "true";
  const dialog = document.createElement("section");
  dialog.className = "gpt-codex-custom-image-viewer-dialog";
  dialog.setAttribute("aria-label", sourceImage.alt || "Generated image preview");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("role", "dialog");
  dialog.tabIndex = -1;

  const header = document.createElement("header");
  header.className = "gpt-codex-custom-image-viewer-header";
  const title = document.createElement("span");
  title.className = "gpt-codex-custom-image-viewer-title";
  title.textContent = sourceImage.alt || "Generated image";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "gpt-codex-custom-image-viewer-close";
  close.setAttribute("aria-label", "Close image preview");
  close.textContent = "\u00d7";
  close.addEventListener("click", () => closeGeneratedImageViewer());
  header.append(title, close);

  const viewport = document.createElement("div");
  viewport.className = "gpt-codex-custom-image-viewer-viewport";
  const image = document.createElement("img");
  image.className = "gpt-codex-custom-image-viewer-image";
  image.alt = sourceImage.alt || "Generated image";
  image.draggable = false;
  image.referrerPolicy = sourceImage.referrerPolicy || "no-referrer";
  image.src = source;
  viewport.appendChild(image);

  const toolbar = document.createElement("div");
  toolbar.className = "gpt-codex-custom-image-viewer-toolbar";
  toolbar.setAttribute("aria-label", "Image preview controls");
  toolbar.setAttribute("role", "toolbar");
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "gpt-codex-custom-image-viewer-edit";
  edit.setAttribute("aria-label", "Edit image");
  edit.textContent = "Edit image";
  edit.addEventListener("click", () => void stageGeneratedImageForEditing(sourceImage, edit));
  const zoomOut = document.createElement("button");
  zoomOut.type = "button";
  zoomOut.setAttribute("aria-label", "Zoom out");
  zoomOut.textContent = "\u2212";
  zoomOut.addEventListener("click", () => updateGeneratedImageViewerScale(generatedImageViewerScale - 0.25));
  const scale = document.createElement("button");
  scale.type = "button";
  scale.dataset.gptCodexCustomImageViewerScale = "true";
  scale.setAttribute("aria-label", "Reset zoom");
  scale.textContent = "100%";
  scale.addEventListener("click", () => updateGeneratedImageViewerScale(1));
  const zoomIn = document.createElement("button");
  zoomIn.type = "button";
  zoomIn.setAttribute("aria-label", "Zoom in");
  zoomIn.textContent = "+";
  zoomIn.addEventListener("click", () => updateGeneratedImageViewerScale(generatedImageViewerScale + 0.25));
  toolbar.append(edit, zoomOut, scale, zoomIn);

  dialog.append(header, viewport, toolbar);
  backdrop.appendChild(dialog);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeGeneratedImageViewer();
  });
  viewport.addEventListener("dblclick", () => {
    updateGeneratedImageViewerScale(generatedImageViewerScale === 1 ? 2 : 1);
  });
  document.body.appendChild(backdrop);
  generatedImageViewerElement = backdrop;
  generatedImageViewerOpener = opener instanceof HTMLElement ? opener : null;
  generatedImageViewerSourceImage = sourceImage;
  document.documentElement.dataset.gptCodexCustomImageViewerOpen = "true";
  updateGeneratedImageViewerScale(1);
  queueMicrotask(() => close.focus({ preventScroll: true }));
  scheduleDiagnostics();
  return true;
}

function handleGeneratedImagePreviewClick(event) {
  if (!chatMode || !(event.target instanceof Element)) return;
  const preview = event.target.closest('button[data-testid="generated-image-preview"]');
  if (!(preview instanceof HTMLButtonElement) || preview.getAttribute("aria-hidden") === "true") return;
  const sourceImage = preview.querySelector("img");
  if (!(sourceImage instanceof HTMLImageElement)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openGeneratedImageViewer(sourceImage, preview);
}

function focusNativeImageComposer(sourceImage) {
  const dialog = sourceImage.closest('[role="dialog"]');
  const closePreview = dialog
    ? [...dialog.querySelectorAll('button[aria-label]')].find((button) =>
        /close.*image|close.*preview/i.test(button.getAttribute("aria-label") ?? ""),
      )
    : null;
  closePreview?.click();

  window.requestAnimationFrame(() => {
    const surface = document.querySelector('[data-pip-obstacle="quick-chat"]');
    const composer = surface?.querySelector(
      'form textarea, form [contenteditable="true"], textarea, [contenteditable="true"][role="textbox"]',
    );
    composer?.scrollIntoView({ block: "center", behavior: "smooth" });
    composer?.focus();
  });
}

async function stageGeneratedImageForEditing(image, button) {
  const composer = getNativeImageComposer();
  if (typeof composer?.stageImage !== "function") {
    showCustomChatStatus("Image editing is still initializing. Try again in a moment.", {
      error: true,
    });
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.dataset.state = "loading";
  button.textContent = "Adding…";
  try {
    const file = await generatedImageToFile(image);
    await composer.stageImage(file);
    document.documentElement.dataset.gptCodexCustomImageEdit = "ready";
    showCustomChatStatus("Image added. Describe the changes you want.");
    closeGeneratedImageViewer({ restoreFocus: false });
    focusNativeImageComposer(image);
  } catch (error) {
    document.documentElement.dataset.gptCodexCustomImageEdit = "error";
    showCustomChatStatus(error?.message ?? "Could not prepare this image for editing.", {
      error: true,
    });
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.dataset.state = "idle";
      button.textContent = originalText;
    }
    scheduleDiagnostics();
  }
}

function createGeneratedImageEditControl(image, placement) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `gpt-codex-custom-image-edit gpt-codex-custom-image-edit-${placement}`;
  button.dataset.gptCodexCustomImageEdit = placement;
  button.setAttribute("aria-label", "Edit image");
  button.textContent = "Edit";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void stageGeneratedImageForEditing(image, button);
  });
  return button;
}

function ensureGeneratedImageEditControls() {
  if (!chatMode) return;

  for (const preview of document.querySelectorAll(
    'button[data-testid="generated-image-preview"]',
  )) {
    if (preview.dataset.gptCodexCustomImageEditReady === "true") continue;
    const image = preview.querySelector("img");
    const host = preview.parentElement;
    if (!(image instanceof HTMLImageElement) || !host) continue;
    preview.dataset.gptCodexCustomImageEditReady = "true";
    host.classList.add("gpt-codex-custom-generated-image-host");
    host.appendChild(createGeneratedImageEditControl(image, "gallery"));
  }

  const generatedImageLabels = new Set(
    [...document.querySelectorAll('button[data-testid="generated-image-preview"]')]
      .map((preview) => preview.getAttribute("aria-label"))
      .filter(Boolean),
  );
  for (const image of document.querySelectorAll('[role="dialog"] img')) {
    const dialog = image.closest('[role="dialog"]');
    if (!dialog || dialog.querySelector('[data-gpt-codex-custom-image-edit="preview"]')) {
      continue;
    }
    if (dialog.closest('[data-gpt-codex-custom-image-viewer="true"]')) continue;
    if (!generatedImageLabels.has(image.alt) && !/generated image/i.test(image.alt)) continue;
    dialog.classList.add("gpt-codex-custom-generated-image-dialog");
    dialog.appendChild(createGeneratedImageEditControl(image, "preview"));
  }
}

function waitForSelfTestCondition(predicate, timeoutMs = 12000) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (predicate()) {
        resolve(true);
      } else if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
      } else {
        window.setTimeout(check, 100);
      }
    };
    check();
  });
}

function sampleModelPickerModeTransition(mode, timeoutMs = 12_000, stableWindowMs = 2_000) {
  const startedAt = performance.now();
  let finished = false;
  let modeFirstSeenAt = null;
  let stableStartedAt = null;
  let sampleCount = 0;
  let postModeSampleCount = 0;
  let probeUnavailableSampleCount = 0;
  let postModeProbeUnavailableSampleCount = 0;
  let classifierErrorFrameCount = 0;
  let customOnlyFrameCount = 0;
  let duplicateFrameCount = 0;
  let missingControlFrameCount = 0;
  let modeMismatchFrameCount = 0;
  let multipleCustomHostFrameCount = 0;
  let nativeVisibleFrameCount = 0;
  let nativeOnlyFrameCount = 0;
  let nonActionableControlFrameCount = 0;
  let unrelatedSuppressionFrameCount = 0;
  let maxVisibleNativeTriggerCount = 0;
  let minVisibleCustomTriggerCount = Number.POSITIVE_INFINITY;
  let maxVisibleCustomTriggerCount = 0;
  let maxCustomTriggerCount = 0;
  let maxCustomHostCount = 0;
  let minSameSlotVisibleControlCount = Number.POSITIVE_INFINITY;
  let maxSameSlotVisibleControlCount = 0;
  let minSameSlotActionableControlCount = Number.POSITIVE_INFINITY;
  let maxSameSlotActionableControlCount = 0;

  return new Promise((resolve) => {
    const complete = (pass, probe, now, frame = null) => {
      if (finished) return;
      finished = true;
      resolve({
        schemaVersion: 3,
        pass,
        sampleDurationMs: Math.round((now - startedAt) * 10) / 10,
        stableDurationMs:
          stableStartedAt == null ? 0 : Math.round((now - stableStartedAt) * 10) / 10,
        sampleCount,
        postModeSampleCount,
        probeUnavailableSampleCount,
        postModeProbeUnavailableSampleCount,
        classifierErrorFrameCount,
        customOnlyFrameCount,
        duplicateFrameCount,
        missingControlFrameCount,
        modeMismatchFrameCount,
        multipleCustomHostFrameCount,
        nativeVisibleFrameCount,
        nativeOnlyFrameCount,
        nonActionableControlFrameCount,
        unrelatedSuppressionFrameCount,
        maxVisibleNativeTriggerCount,
        minVisibleCustomTriggerCount: Number.isFinite(minVisibleCustomTriggerCount)
          ? minVisibleCustomTriggerCount
          : null,
        maxVisibleCustomTriggerCount,
        maxCustomTriggerCount,
        maxCustomHostCount,
        minSameSlotVisibleControlCount: Number.isFinite(minSameSlotVisibleControlCount)
          ? minSameSlotVisibleControlCount
          : null,
        maxSameSlotVisibleControlCount,
        minSameSlotActionableControlCount: Number.isFinite(
          minSameSlotActionableControlCount,
        )
          ? minSameSlotActionableControlCount
          : null,
        maxSameSlotActionableControlCount,
        final: {
          activeMode: probe?.activeMode ?? null,
          bridgeKind: probe?.bridgeKind ?? null,
          composerAnchored: probe?.composerAnchored === true,
          customHostCount: frame?.customHostCount ?? null,
          customReplacementActionable: probe?.customReplacementActionable === true,
          customTriggerCount: probe?.customTriggerCount ?? null,
          customTriggerVisibleCount: probe?.customTriggerVisibleCount ?? null,
          classifierValid: frame?.classifierValid === true,
          nativeCompetingTriggerCount: probe?.nativeCompetingTriggerCount ?? null,
          nativeTriggerSuppressed: probe?.nativeTriggerSuppressed === true,
          placement: probe?.placement ?? null,
          sameSlotActionableControlCount: frame?.sameSlotActionableControlCount ?? null,
          sameSlotVisibleControlCount: frame?.sameSlotVisibleControlCount ?? null,
          unrelatedSuppressedNativeTriggerCount:
            probe?.unrelatedSuppressedNativeTriggerCount ?? null,
          visibleNativeTriggerCount: probe?.visibleNativeTriggerCount ?? null,
        },
      });
    };

    const sample = () => {
      if (finished) return;
      const now = performance.now();
      const probe = globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE?.() ?? null;
      sampleCount += 1;
      if (!probe) probeUnavailableSampleCount += 1;
      const expectedModeVisible = probe?.activeMode === mode;
      if (expectedModeVisible && modeFirstSeenAt == null) modeFirstSeenAt = now;
      const nativeTriggerDiagnostics = Array.isArray(probe?.nativeTriggerDiagnostics)
        ? probe.nativeTriggerDiagnostics
        : [];
      const competingDiagnostics = nativeTriggerDiagnostics.filter(
        (diagnostic) => diagnostic?.competing === true,
      );
      const visibleCompetingDiagnostics = competingDiagnostics.filter(
        (diagnostic) => diagnostic?.visible === true,
      );
      const actionableVisibleNativeCount = visibleCompetingDiagnostics.filter(
        (diagnostic) => diagnostic?.keyboardActionable === true,
      ).length;
      const diagnosticUnrelatedSuppressedCount = nativeTriggerDiagnostics.filter(
        (diagnostic) =>
          diagnostic?.competing !== true &&
          (diagnostic?.suppression?.marker === true || diagnostic?.suppression?.mode != null),
      ).length;
      const nativeVisible = Number.isInteger(probe?.visibleNativeTriggerCount)
        ? probe.visibleNativeTriggerCount
        : null;
      const customVisible = Number.isInteger(probe?.customTriggerVisibleCount)
        ? probe.customTriggerVisibleCount
        : null;
      const customCount = Number.isInteger(probe?.customTriggerCount)
        ? probe.customTriggerCount
        : null;
      const nativeCompetingCount = Number.isInteger(probe?.nativeCompetingTriggerCount)
        ? probe.nativeCompetingTriggerCount
        : null;
      const unrelatedSuppressedCount = Number.isInteger(
        probe?.unrelatedSuppressedNativeTriggerCount,
      )
        ? probe.unrelatedSuppressedNativeTriggerCount
        : null;
      const customHostCount = document.querySelectorAll(
        "#gpt-codex-custom-model-picker",
      ).length;
      const classifierValid = Boolean(
        probe &&
          nativeTriggerDiagnostics.every(
            (diagnostic, index) => diagnostic?.documentIndex === index,
          ) &&
          nativeCompetingCount === 1 &&
          nativeCompetingCount === competingDiagnostics.length &&
          nativeVisible === visibleCompetingDiagnostics.length &&
          unrelatedSuppressedCount === diagnosticUnrelatedSuppressedCount,
      );
      const sameSlotVisibleControlCount =
        nativeVisible != null && customVisible != null ? nativeVisible + customVisible : null;
      const actionableVisibleCustomCount =
        customVisible != null && probe?.customReplacementActionable === true ? customVisible : 0;
      const sameSlotActionableControlCount = probe
        ? actionableVisibleNativeCount + actionableVisibleCustomCount
        : null;
      const frame = {
        classifierValid,
        customHostCount,
        sameSlotActionableControlCount,
        sameSlotVisibleControlCount,
      };
      if (modeFirstSeenAt != null) {
        postModeSampleCount += 1;
        if (!probe) postModeProbeUnavailableSampleCount += 1;
        if (!expectedModeVisible) modeMismatchFrameCount += 1;
        if (!classifierValid) classifierErrorFrameCount += 1;
        if ((unrelatedSuppressedCount ?? 0) > 0) unrelatedSuppressionFrameCount += 1;
        if (Number.isInteger(nativeVisible)) {
          maxVisibleNativeTriggerCount = Math.max(maxVisibleNativeTriggerCount, nativeVisible);
          if (nativeVisible > 0) nativeVisibleFrameCount += 1;
        }
        if (Number.isInteger(customVisible)) {
          minVisibleCustomTriggerCount = Math.min(minVisibleCustomTriggerCount, customVisible);
          maxVisibleCustomTriggerCount = Math.max(maxVisibleCustomTriggerCount, customVisible);
        }
        if (Number.isInteger(customCount)) {
          maxCustomTriggerCount = Math.max(maxCustomTriggerCount, customCount);
        }
        maxCustomHostCount = Math.max(maxCustomHostCount, customHostCount);
        if (Number.isInteger(sameSlotVisibleControlCount)) {
          minSameSlotVisibleControlCount = Math.min(
            minSameSlotVisibleControlCount,
            sameSlotVisibleControlCount,
          );
          maxSameSlotVisibleControlCount = Math.max(
            maxSameSlotVisibleControlCount,
            sameSlotVisibleControlCount,
          );
        }
        if (Number.isInteger(sameSlotActionableControlCount)) {
          minSameSlotActionableControlCount = Math.min(
            minSameSlotActionableControlCount,
            sameSlotActionableControlCount,
          );
          maxSameSlotActionableControlCount = Math.max(
            maxSameSlotActionableControlCount,
            sameSlotActionableControlCount,
          );
        }
        const duplicateControl =
          (sameSlotVisibleControlCount ?? 0) > 1 ||
          (sameSlotActionableControlCount ?? 0) > 1;
        const missingControl =
          sameSlotVisibleControlCount == null ||
          sameSlotActionableControlCount == null ||
          sameSlotVisibleControlCount < 1 ||
          sameSlotActionableControlCount < 1;
        if (duplicateControl) duplicateFrameCount += 1;
        if (missingControl) missingControlFrameCount += 1;
        if (
          sameSlotVisibleControlCount === 1 &&
          sameSlotActionableControlCount !== 1
        ) {
          nonActionableControlFrameCount += 1;
        }
        if (
          (customVisible != null && customVisible > 1) ||
          (customCount != null && customCount > 1) ||
          customHostCount > 1
        ) {
          multipleCustomHostFrameCount += 1;
        }
        if (
          nativeVisible === 1 &&
          customVisible === 0 &&
          sameSlotActionableControlCount === 1
        ) {
          nativeOnlyFrameCount += 1;
        }
        if (
          nativeVisible === 0 &&
          customVisible === 1 &&
          sameSlotActionableControlCount === 1
        ) {
          customOnlyFrameCount += 1;
        }
      }
      const passing = Boolean(
        expectedModeVisible &&
          probe?.bridgeKind === "native" &&
          probe?.bridgeReady === true &&
          probe?.composerAnchored === true &&
          probe?.placement === "fixed" &&
          probe?.nativeTriggerSuppressed === true &&
          nativeVisible === 0 &&
          customCount === 1 &&
          customVisible === 1 &&
          customHostCount === 1 &&
          probe?.customReplacementActionable === true &&
          classifierValid &&
          sameSlotVisibleControlCount === 1 &&
          sameSlotActionableControlCount === 1 &&
          unrelatedSuppressedCount === 0 &&
          probe?.queryState === "ready" &&
          probe?.highSelectable === true,
      );
      stableStartedAt = passing ? (stableStartedAt ?? now) : null;
      const stableDuration = stableStartedAt == null ? 0 : now - stableStartedAt;
      if (stableDuration >= stableWindowMs && postModeSampleCount >= 30) {
        complete(
          duplicateFrameCount === 0 &&
            missingControlFrameCount === 0 &&
            nonActionableControlFrameCount === 0 &&
            unrelatedSuppressionFrameCount === 0 &&
            classifierErrorFrameCount === 0 &&
            postModeProbeUnavailableSampleCount === 0 &&
            modeMismatchFrameCount === 0 &&
            multipleCustomHostFrameCount === 0 &&
            maxVisibleNativeTriggerCount <= 1 &&
            maxVisibleCustomTriggerCount <= 1 &&
            maxCustomTriggerCount <= 1 &&
            maxCustomHostCount <= 1 &&
            minSameSlotVisibleControlCount === 1 &&
            maxSameSlotVisibleControlCount === 1 &&
            minSameSlotActionableControlCount === 1 &&
            maxSameSlotActionableControlCount === 1,
          probe,
          now,
          frame,
        );
        return;
      }
      if (now - startedAt >= timeoutMs) {
        complete(false, probe, now, frame);
        return;
      }
      let sampled = false;
      const fallbackTimer = window.setTimeout(() => {
        if (sampled || finished) return;
        sampled = true;
        sample();
      }, 40);
      requestAnimationFrame(() => {
        if (sampled || finished) return;
        sampled = true;
        window.clearTimeout(fallbackTimer);
        sample();
      });
    };
    sample();
  });
}

function withSelfTestTimeout(promise, timeoutMs, label) {
  let timeoutId = 0;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timeoutId = window.setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)),
        timeoutMs,
      );
    }),
  ]).finally(() => window.clearTimeout(timeoutId));
}

function markChatSidebarSelfTestProgress(stage) {
  const progress = Object.freeze({ stage, updatedAt: Date.now() });
  globalThis.GPT_CODEX_CUSTOM_SELF_TEST_PROGRESS = progress;
  document.documentElement.dataset.gptCodexCustomSelfTest = stage;
  void window.electronBridge?.sendMessageFromView({
    type: "gpt-codex-custom-renderer-status",
    status: "self-test",
    detail: { stage },
  });
}

async function runChatSidebarSelfTest() {
  if (new URLSearchParams(window.location.search).has("initialRoute")) return;
  markChatSidebarSelfTestProgress("starting");

  let storedProductModeBeforeSelfTest = null;
  try {
    storedProductModeBeforeSelfTest = localStorage.getItem(CHAT_MODE_STORAGE_KEY);
  } catch {
    // A locked-down profile can disable storage; the current session still works.
  }
  const restoreStoredProductMode = () => {
    try {
      if (storedProductModeBeforeSelfTest == null) {
        localStorage.removeItem(CHAT_MODE_STORAGE_KEY);
      } else {
        localStorage.setItem(CHAT_MODE_STORAGE_KEY, storedProductModeBeforeSelfTest);
      }
    } catch {
      // Keep self-test cleanup best-effort when local storage is unavailable.
    }
  };

  try {

  let selfTestAttempt = 0;
  try {
    selfTestAttempt = Number(sessionStorage.getItem(CHAT_SELF_TEST_STORAGE_KEY)) || 0;
    if (selfTestAttempt >= 3) {
      sessionStorage.removeItem(CHAT_SELF_TEST_STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(CHAT_SELF_TEST_STORAGE_KEY, String(selfTestAttempt + 1));
  } catch {
    // The test can still run when session storage is unavailable; it just cannot resume a reload.
  }

  setChatMode(true, { launch: true, persist: true });
  const ready = await waitForSelfTestCondition(
    () =>
      chatMode &&
      chatHistoryById.size >= 2 &&
      typeof nativeConversationSelect === "function" &&
      typeof nativeNewChat === "function",
  );
  markChatSidebarSelfTestProgress(ready ? "chat-ready" : "chat-not-ready");
  const result = {
    ready,
    freshModeDecisionHelperWorks: RENDERER_CONTRACT_SELF_TEST.freshModeDecision.pass,
    productMenuKeyboardContractWorks: RENDERER_CONTRACT_SELF_TEST.productMenuKeyboard.pass,
    firstConversationOpened: false,
    messageEditControlVisible: false,
    messageEditModeOpens: false,
    messageEditCancelRestoresBubble: false,
    messageEditDryRunWorks: false,
    messageEditSubmitClosesEditor: false,
    generatedImageEditControlVisible: false,
    generatedImageEditBridgeReady: false,
    generatedImagePreviewLayoutPreserved: false,
    generatedImageFullViewOpens: false,
    generatedImageFullViewCloses: false,
    generatedImageFullViewRestoresInteraction: false,
    generatedImageNativeStageWorks: false,
    generatedImageEditPipelineWorks: false,
    tokenHudContractWorks: false,
    pinboardStorageReady: false,
    pinboardMessageAssociationWorks: false,
    pinboardBookmarkRoundTripWorks: false,
    productModeSelectorPersists: false,
    productModeOptionsVisible: false,
    nativeProductModeBridgeReady: false,
    productOptionsRespectBridgeReadiness: false,
    nativeChatSearchBridgeReady: false,
    nativeChatSearchQueryWorks: false,
    nativeChatSearchError: null,
    nativeChatSearchFakeBridgeWorks: false,
    nativeChatManagementBridgeReady: false,
    nativeChatDeleteBridgeReady: false,
    conversationMenuControlVisible: false,
    conversationMenuOpens: false,
    conversationMenuFullActionSetVisible: false,
    chatRenameDryRunWorks: false,
    chatPinDryRunWorks: false,
    chatArchiveDryRunWorks: false,
    chatShareDryRunWorks: false,
    deleteConfirmationOpens: false,
    deleteCancelPreservesChat: false,
    deleteDryRunWorks: false,
    deleteDryRunPreservesChat: false,
    historyFullListReconciliationWorks: false,
    sessionSelectionAuthoritative: false,
    chatScrollSettlesToBottom: false,
    sidebarActionsRespectBridgeReadiness: false,
    profileReadinessConsistent: false,
    loadMoreControlSafe: false,
    secondConversationOpened: false,
    newChatOpened: false,
    siteNavigationReady: false,
    accountControlReady: false,
    historyPaginationBridgeReady: false,
    accountMenuOpens: false,
    searchControlWorks: false,
    moreMenuOpens: false,
    auxiliaryDestinationsVisible: false,
    auxiliaryStateClearsOnChatReturn: false,
    destinationRouteResults: {},
    libraryNavigationDispatched: false,
    libraryRouteStayedOpen: false,
    libraryPathAfterNavigation: null,
    modeExitHidesChat: false,
    modeReentryRestoresChat: false,
    workModeSelectionWorks: false,
    codexModeSelectionWorks: false,
    modelPickerWorkModeWorks: false,
    modelPickerCodexModeWorks: false,
    modelPickerChatReturnWorks: false,
    modelPickerModeEvidence: {},
    tokenHudWorkModeWorks: false,
    tokenHudCodexModeWorks: false,
    tokenHudChatReturnWorks: false,
    historyCount: chatHistoryById.size,
  };
  let generatedImageNativeStageFixture = null;
  let generatedImageNativeStageBridge = null;

  const imageDialogLayoutFixture = document.createElement("div");
  imageDialogLayoutFixture.className = "fixed gpt-codex-custom-generated-image-dialog";
  imageDialogLayoutFixture.hidden = true;
  document.body.appendChild(imageDialogLayoutFixture);
  result.generatedImagePreviewLayoutPreserved =
    getComputedStyle(imageDialogLayoutFixture).position === "fixed";
  imageDialogLayoutFixture.remove();

  const historyFixture = new Map([
    ["loaded-page", { conversationId: "loaded-page", title: "Loaded page" }],
    ["stale", { conversationId: "stale", title: "Deleted chat" }],
  ]);
  const historyFixtureChanged = reconcileNativeChatHistory(historyFixture, [
    { conversationId: "loaded-page", recencyAt: 2, title: "Loaded page" },
    { conversationId: "next-page", recencyAt: 1, title: "Next page" },
  ]);
  result.historyFullListReconciliationWorks =
    historyFixtureChanged &&
    historyFixture.has("loaded-page") &&
    historyFixture.has("next-page") &&
    !historyFixture.has("stale");

  const fakeSearchRequests = [];
  try {
    const fakeSearchResponse = await requestNativeChatSearch(
      {
        available: true,
        search: async (request) => {
          fakeSearchRequests.push(request);
          return {
            available: true,
            cursor: "fake-next-cursor",
            items: [
              {
                kind: "chatgpt",
                conversationId: "fake-search-conversation",
                title: "Fixture chat",
                searchTitle: "Fixture search title",
                updatedAt: 1,
                searchPreview: { kind: "contentMatch", snippet: "Fixture snippet" },
              },
            ],
          };
        },
      },
      { query: "fixture query", limit: 7 },
    );
    result.nativeChatSearchFakeBridgeWorks =
      fakeSearchRequests.length === 1 &&
      fakeSearchRequests[0].query === "fixture query" &&
      fakeSearchRequests[0].cursor === null &&
      fakeSearchRequests[0].limit === 7 &&
      fakeSearchResponse.available === true &&
      fakeSearchResponse.cursor === "fake-next-cursor" &&
      fakeSearchResponse.items[0]?.conversationId === "fake-search-conversation" &&
      fakeSearchResponse.items[0]?.searchPreview?.snippet === "Fixture snippet";
  } catch {
    result.nativeChatSearchFakeBridgeWorks = false;
  }

  if (ready) {
    markChatSidebarSelfTestProgress("opening-first-conversation");
    const conversations = [...chatHistoryById.values()].sort(
      (left, right) => (right.recencyAt ?? 0) - (left.recencyAt ?? 0),
    );
    const [first, second] = conversations;
    const realSearchBridge = getNativeChatSearch();
    result.nativeChatSearchBridgeReady = isNativeChatSearchAvailable(realSearchBridge);
    if (result.nativeChatSearchBridgeReady) {
      try {
        const query = String(first.title ?? "chat").trim() || "chat";
        const searchResponse = await withSelfTestTimeout(
          requestNativeChatSearch(realSearchBridge, { query, limit: 5 }),
          6_000,
          "Native Chat search",
        );
        result.nativeChatSearchQueryWorks =
          searchResponse?.available === true && Array.isArray(searchResponse.items);
      } catch (error) {
        result.nativeChatSearchQueryWorks = false;
        result.nativeChatSearchError = String(error?.message ?? error).slice(0, 300);
      }
    }
    selectNativeConversation(first.conversationId, first.title);
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    result.firstConversationOpened =
      document.querySelector('[data-pip-obstacle="quick-chat"]')?.textContent?.includes(first.title) ??
      false;
    const firstConversationRow = [
      ...document.querySelectorAll(".gpt-codex-custom-chat-sidebar-item"),
    ].find((button) => button.dataset.conversationId === first.conversationId);
    result.sessionSelectionAuthoritative =
      nativeSessionConversationId === first.conversationId &&
      activeChatConversationId === nativeSessionConversationId &&
      firstConversationRow?.dataset.active === "true";
    const chatScrollProbe = getChatThreadScrollState();
    result.chatScrollSettlesToBottom =
      chatScrollProbe.initialScrollMode === "anchor-latest" ||
      (chatScrollProbe.available === true && chatScrollProbe.atBottom === true);

    markChatSidebarSelfTestProgress("testing-chat-management");
    const deleteTarget = conversations.find(
      (conversation) => !conversation.conversationId.startsWith("local-chatgpt:"),
    );
    const nativeDeleteActions = getNativeChatActions();
    result.nativeChatManagementBridgeReady = isNativeChatManagementAvailable(nativeDeleteActions);
    result.nativeChatDeleteBridgeReady = isNativeChatDeleteAvailable(nativeDeleteActions);
    const deleteTargetRow = deleteTarget
      ? [...document.querySelectorAll(".gpt-codex-custom-chat-sidebar-item-row")].find(
          (row) => row.dataset.conversationId === deleteTarget.conversationId,
        )
      : null;
    const deleteMenuTrigger = deleteTargetRow?.querySelector(
      '[data-gpt-codex-custom-conversation-menu-trigger="true"]',
    );
    result.conversationMenuControlVisible = Boolean(
      deleteMenuTrigger && !deleteMenuTrigger.disabled && deleteMenuTrigger.getClientRects().length,
    );
    try {
      deleteMenuTrigger?.click();
      result.conversationMenuOpens = await waitForSelfTestCondition(
        () =>
          document.querySelector(
            '#gpt-codex-custom-chat-conversation-menu [data-action="delete"]',
          )?.getClientRects().length > 0,
        2_000,
      );
      const expectedConversationActions = ["share", "rename", "pin", "archive", "delete"];
      const conversationActionButtons = [
        ...document.querySelectorAll(
          "#gpt-codex-custom-chat-conversation-menu [data-action]",
        ),
      ];
      result.conversationMenuFullActionSetVisible =
        conversationActionButtons.length === expectedConversationActions.length &&
        conversationActionButtons.every(
          (button, index) =>
            button.dataset.action === expectedConversationActions[index] &&
            !button.disabled &&
            button.getClientRects().length > 0,
        );
      document
        .querySelector('#gpt-codex-custom-chat-conversation-menu [data-action="delete"]')
        ?.click();
      result.deleteConfirmationOpens = await waitForSelfTestCondition(
        () => Boolean(document.querySelector(".gpt-codex-custom-chat-delete-dialog")),
        2_000,
      );
      document.querySelector(".gpt-codex-custom-chat-delete-cancel")?.click();
      await waitForSelfTestCondition(
        () => !document.querySelector(".gpt-codex-custom-chat-delete-dialog"),
        2_000,
      );
      result.deleteCancelPreservesChat = Boolean(
        deleteTarget &&
          chatHistoryById.has(deleteTarget.conversationId) &&
          [...document.querySelectorAll(".gpt-codex-custom-chat-sidebar-item-row")].some(
            (row) => row.dataset.conversationId === deleteTarget.conversationId,
          ),
      );

      Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_CHAT_ACTION_DRY_RUN_RESULT");
      Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_CHAT_ACTION_UI_RESULT");
      globalThis.GPT_CODEX_CUSTOM_CHAT_ACTION_DRY_RUN = true;
      const runConversationActionDryRun = async (action) => {
        Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_CHAT_ACTION_DRY_RUN_RESULT");
        Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_CHAT_ACTION_UI_RESULT");
        deleteMenuTrigger?.click();
        const actionVisible = await waitForSelfTestCondition(
          () =>
            document.querySelector(
              `#gpt-codex-custom-chat-conversation-menu [data-action="${action}"]`,
            )?.getClientRects().length > 0,
          2_000,
        );
        if (!actionVisible) return false;
        document
          .querySelector(`#gpt-codex-custom-chat-conversation-menu [data-action="${action}"]`)
          ?.click();

        if (action === "rename" || action === "share") {
          const dialogVisible = await waitForSelfTestCondition(
            () =>
              document.querySelector(`.gpt-codex-custom-chat-action-dialog[data-action="${action}"]`)
                ?.getClientRects().length > 0,
            2_000,
          );
          if (!dialogVisible) return false;
          if (action === "rename") {
            const input = document.querySelector(
              '.gpt-codex-custom-chat-action-dialog[data-action="rename"] input',
            );
            if (input instanceof HTMLInputElement) {
              input.value = "Custom UI dry-run title";
              input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            }
          }
          document
            .querySelector(`[data-gpt-codex-custom-chat-action-confirm="${action}"]`)
            ?.click();
        }

        const completed = await waitForSelfTestCondition(
          () =>
            globalThis.GPT_CODEX_CUSTOM_CHAT_ACTION_UI_RESULT?.action === action &&
            globalThis.GPT_CODEX_CUSTOM_CHAT_ACTION_UI_RESULT?.conversationId ===
              deleteTarget?.conversationId,
          2_000,
        );
        const bridgeResult = globalThis.GPT_CODEX_CUSTOM_CHAT_ACTION_DRY_RUN_RESULT;
        const uiResult = globalThis.GPT_CODEX_CUSTOM_CHAT_ACTION_UI_RESULT;
        return Boolean(
          completed &&
            bridgeResult?.action === action &&
            bridgeResult?.conversationId === deleteTarget?.conversationId &&
            bridgeResult?.dryRun === true &&
            uiResult?.dryRun === true,
        );
      };
      result.chatRenameDryRunWorks = await runConversationActionDryRun("rename");
      result.chatPinDryRunWorks = await runConversationActionDryRun("pin");
      result.chatArchiveDryRunWorks = await runConversationActionDryRun("archive");
      result.chatShareDryRunWorks = await runConversationActionDryRun("share");

      Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_DELETE_DRY_RUN_RESULT");
      Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_DELETE_DRY_RUN_UI_RESULT");
      globalThis.GPT_CODEX_CUSTOM_DELETE_DRY_RUN = true;
      deleteMenuTrigger?.click();
      await waitForSelfTestCondition(
        () => Boolean(document.querySelector("#gpt-codex-custom-chat-conversation-menu")),
        2_000,
      );
      document
        .querySelector('#gpt-codex-custom-chat-conversation-menu [data-action="delete"]')
        ?.click();
      await waitForSelfTestCondition(
        () => Boolean(document.querySelector(".gpt-codex-custom-chat-delete-confirm")),
        2_000,
      );
      document.querySelector(".gpt-codex-custom-chat-delete-confirm")?.click();
      await waitForSelfTestCondition(
        () =>
          Boolean(globalThis.GPT_CODEX_CUSTOM_DELETE_DRY_RUN_RESULT) &&
          Boolean(globalThis.GPT_CODEX_CUSTOM_DELETE_DRY_RUN_UI_RESULT),
        2_000,
      );
      const deleteDryRunResult = globalThis.GPT_CODEX_CUSTOM_DELETE_DRY_RUN_RESULT;
      const deleteDryRunUiResult = globalThis.GPT_CODEX_CUSTOM_DELETE_DRY_RUN_UI_RESULT;
      result.deleteDryRunWorks = Boolean(
        deleteTarget &&
          deleteDryRunResult?.conversationId === deleteTarget.conversationId &&
          deleteDryRunUiResult?.conversationId === deleteTarget.conversationId &&
          deleteDryRunUiResult?.confirmed === true,
      );
      result.deleteDryRunPreservesChat = Boolean(
        deleteTarget &&
          chatHistoryById.has(deleteTarget.conversationId) &&
          [...document.querySelectorAll(".gpt-codex-custom-chat-sidebar-item-row")].some(
            (row) => row.dataset.conversationId === deleteTarget.conversationId,
          ),
      );
    } finally {
      closeChatConversationMenu();
      closeChatDeleteDialog();
      if (!Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_DELETE_DRY_RUN")) {
        globalThis.GPT_CODEX_CUSTOM_DELETE_DRY_RUN = undefined;
      }
      if (!Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_DELETE_DRY_RUN_RESULT")) {
        globalThis.GPT_CODEX_CUSTOM_DELETE_DRY_RUN_RESULT = undefined;
      }
      if (!Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_DELETE_DRY_RUN_UI_RESULT")) {
        globalThis.GPT_CODEX_CUSTOM_DELETE_DRY_RUN_UI_RESULT = undefined;
      }
      if (!Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_CHAT_ACTION_DRY_RUN")) {
        globalThis.GPT_CODEX_CUSTOM_CHAT_ACTION_DRY_RUN = undefined;
      }
      if (!Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_CHAT_ACTION_DRY_RUN_RESULT")) {
        globalThis.GPT_CODEX_CUSTOM_CHAT_ACTION_DRY_RUN_RESULT = undefined;
      }
      if (!Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_CHAT_ACTION_UI_RESULT")) {
        globalThis.GPT_CODEX_CUSTOM_CHAT_ACTION_UI_RESULT = undefined;
      }
    }
    markChatSidebarSelfTestProgress("testing-message-edit");

    const closeOpenMessageEditors = async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const editor = document.querySelector(CHAT_MESSAGE_EDITOR_SELECTOR);
        if (!editor) return true;
        const cancel = [...(editor.closest("form")?.querySelectorAll("button") ?? [])].find(
          (button) => button.textContent?.trim() === "Cancel" && !button.disabled,
        );
        if (!cancel) return false;
        cancel.click();
        await waitForSelfTestCondition(() => !editor.isConnected, 2_000);
      }
      return !document.querySelector(CHAT_MESSAGE_EDITOR_SELECTOR);
    };
    await closeOpenMessageEditors();
    await waitForSelfTestCondition(
      () => Boolean(document.querySelector('button[aria-label="Edit message"]')),
      6_000,
    );
    const editMessageButton = document.querySelector('button[aria-label="Edit message"]');
    result.messageEditControlVisible = Boolean(editMessageButton);
    editMessageButton?.click();
    result.messageEditModeOpens = await waitForSelfTestCondition(
      () => Boolean(document.querySelector(CHAT_MESSAGE_EDITOR_SELECTOR)),
      2_000,
    );
    const openedMessageEditor = document.querySelector(CHAT_MESSAGE_EDITOR_SELECTOR);
    const cancelEditButton = [
      ...(openedMessageEditor?.closest("form")?.querySelectorAll("button") ?? []),
    ].find((button) => button.textContent?.trim() === "Cancel");
    cancelEditButton?.click();
    result.messageEditCancelRestoresBubble = await waitForSelfTestCondition(
      () =>
        !document.querySelector(CHAT_MESSAGE_EDITOR_SELECTOR) &&
        Boolean(document.querySelector('button[aria-label="Edit message"]')),
      6_000,
    );

    try {
      Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_EDIT_DRY_RUN_RESULT");
      globalThis.GPT_CODEX_CUSTOM_EDIT_DRY_RUN = true;
      const dryRunEditButton = document.querySelector('button[aria-label="Edit message"]');
      dryRunEditButton?.click();
      await waitForSelfTestCondition(
        () => Boolean(document.querySelector(CHAT_MESSAGE_EDITOR_SELECTOR)),
        2_000,
      );
      const dryRunEditor = document.querySelector(CHAT_MESSAGE_EDITOR_SELECTOR);
      const unchangedPrompt =
        dryRunEditor && "value" in dryRunEditor
          ? String(dryRunEditor.value)
          : String(dryRunEditor?.textContent ?? "");
      const dryRunForm = dryRunEditor?.closest("form");
      const dryRunSendButton = dryRunForm
        ? [...dryRunForm.querySelectorAll("button")].find((button) => {
            const label = `${button.getAttribute("aria-label") ?? ""} ${button.textContent ?? ""}`
              .replace(/\s+/g, " ")
              .trim();
            return !button.disabled && /^(Send|Send message)(\s+(Send|Send message))?$/i.test(label);
          })
        : null;
      if (
        dryRunEditor &&
        unchangedPrompt.length > 0 &&
        dryRunSendButton &&
        globalThis.GPT_CODEX_CUSTOM_EDIT_DRY_RUN === true
      ) {
        dryRunSendButton.click();
        await waitForSelfTestCondition(
          () => Boolean(globalThis.GPT_CODEX_CUSTOM_EDIT_DRY_RUN_RESULT),
          2_000,
        );
        const dryRunResult = globalThis.GPT_CODEX_CUSTOM_EDIT_DRY_RUN_RESULT;
        result.messageEditDryRunWorks =
          dryRunResult?.conversationId === first.conversationId &&
          typeof dryRunResult.messageId === "string" &&
          dryRunResult.messageId.length > 0 &&
          typeof dryRunResult.prompt === "string" &&
          dryRunResult.prompt === unchangedPrompt;
        result.messageEditSubmitClosesEditor = await waitForSelfTestCondition(
          () => !document.querySelector(CHAT_MESSAGE_EDITOR_SELECTOR),
          6_000,
        );
      }
    } finally {
      await closeOpenMessageEditors();
      if (!Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_EDIT_DRY_RUN")) {
        globalThis.GPT_CODEX_CUSTOM_EDIT_DRY_RUN = undefined;
      }
      if (!Reflect.deleteProperty(globalThis, "GPT_CODEX_CUSTOM_EDIT_DRY_RUN_RESULT")) {
        globalThis.GPT_CODEX_CUSTOM_EDIT_DRY_RUN_RESULT = undefined;
      }
    }

    markChatSidebarSelfTestProgress("testing-token-and-pinboard");
    try {
      const tokenSelfTest = globalThis.GPT_CODEX_CUSTOM_TOKEN_SELF_TEST?.();
      result.tokenHudContractWorks = tokenSelfTest?.pass === true;
    } catch {
      result.tokenHudContractWorks = false;
    }
    try {
      const pinboardProbe = globalThis.GPT_CODEX_CUSTOM_PINBOARD_PROBE?.();
      result.pinboardStorageReady =
        pinboardProbe?.ready === true && pinboardProbe?.storage === "ready";
      result.pinboardMessageAssociationWorks =
        Number(pinboardProbe?.bridgeMessages?.associated) > 0 &&
        Number(pinboardProbe?.registeredMessages) >=
          Number(pinboardProbe?.bridgeMessages?.associated);
      const pinboardSelfTest = await withSelfTestTimeout(
        globalThis.GPT_CODEX_CUSTOM_PINBOARD_SELF_TEST?.(),
        8_000,
        "Pinboard round-trip self-test",
      );
      result.pinboardBookmarkRoundTripWorks = pinboardSelfTest?.pass === true;
    } catch {
      result.pinboardBookmarkRoundTripWorks = false;
    }

    const productSelector = document.querySelector(
      '[data-gpt-codex-custom-product-selector="true"]',
    );
    result.productModeSelectorPersists = Boolean(productSelector);
    productSelector?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    result.productModeOptionsVisible = ["Chat", "Work", "Codex"].every((mode) =>
      [...document.querySelectorAll(
        '[data-gpt-codex-custom-product-menu="true"] [role="menuitemradio"]',
      )].some((option) => option.textContent?.replace(/\s+/g, " ").trim().startsWith(mode)),
    );
    const productModeBridge = getNativeProductModes();
    result.nativeProductModeBridgeReady =
      typeof productModeBridge.selectWork === "function" &&
      typeof productModeBridge.selectCodex === "function";
    const productOptions = [
      ...document.querySelectorAll(
        '[data-gpt-codex-custom-product-menu="true"] [role="menuitemradio"]',
      ),
    ];
    result.productOptionsRespectBridgeReadiness = ["Work", "Codex"].every((mode) => {
      const option = productOptions.find((candidate) =>
        candidate.textContent?.replace(/\s+/g, " ").trim().startsWith(mode),
      );
      const bridgeReady = typeof productModeBridge[`select${mode}`] === "function";
      return Boolean(option) && option.disabled === !bridgeReady;
    });
    closeChatProductMenu();
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    markChatSidebarSelfTestProgress("testing-image-edit");

    const imageComposer = getNativeImageComposer();
    let imageComposerProbe = null;
    try {
      imageComposerProbe = imageComposer?.probe?.() ?? null;
    } catch {
      imageComposerProbe = null;
    }
    result.generatedImageEditBridgeReady =
      typeof imageComposer?.stageImage === "function" &&
      typeof imageComposerProbe?.conversationId === "string";

    let imageFixture = null;
    let imageFixtureUrl = null;
    try {
      imageFixture = document.createElement("div");
      imageFixture.id = "gpt-codex-custom-image-edit-self-test";
      imageFixture.style.cssText =
        "position:fixed;left:-10000px;top:0;width:8px;height:8px;overflow:hidden;z-index:-1";
      const imagePreviewFixture = document.createElement("button");
      imagePreviewFixture.type = "button";
      imagePreviewFixture.dataset.testid = "generated-image-preview";
      imagePreviewFixture.setAttribute("aria-label", "Generated image self-test");
      const imageFixtureContent = document.createElement("img");
      imageFixtureContent.alt = "Generated image self-test";
      const imageFixtureCanvas = document.createElement("canvas");
      imageFixtureCanvas.width = 2;
      imageFixtureCanvas.height = 2;
      const imageFixtureContext = imageFixtureCanvas.getContext("2d");
      if (!imageFixtureContext) throw new Error("The image self-test canvas is unavailable.");
      imageFixtureContext.fillStyle = "#7157d9";
      imageFixtureContext.fillRect(0, 0, 2, 2);
      const imageFixtureBlob = await withSelfTestTimeout(
        new Promise((resolve) => imageFixtureCanvas.toBlob(resolve)),
        2_000,
        "Image self-test canvas conversion",
      );
      if (!(imageFixtureBlob instanceof Blob) || imageFixtureBlob.size === 0) {
        throw new Error("The image self-test canvas produced no image data.");
      }
      imageFixtureUrl = URL.createObjectURL(imageFixtureBlob);
      imageFixtureContent.src = imageFixtureUrl;
      await withSelfTestTimeout(
        imageFixtureContent.decode(),
        2_000,
        "Image self-test decode",
      );
      imagePreviewFixture.appendChild(imageFixtureContent);
      imageFixture.appendChild(imagePreviewFixture);
      document.body.appendChild(imageFixture);
      ensureGeneratedImageEditControls();
      const imageEditControl = imageFixture.querySelector(
        '[data-gpt-codex-custom-image-edit="gallery"]',
      );
      result.generatedImageEditControlVisible = Boolean(imageEditControl);
      imagePreviewFixture.focus({ preventScroll: true });
      imagePreviewFixture.click();
      result.generatedImageFullViewOpens = await waitForSelfTestCondition(
        () => {
          const viewer = document.getElementById("gpt-codex-custom-image-viewer");
          const viewerImage = viewer?.querySelector(".gpt-codex-custom-image-viewer-image");
          return Boolean(
            viewer?.getClientRects().length &&
              viewerImage instanceof HTMLImageElement &&
              viewerImage.src === imageFixtureContent.src &&
              viewer.querySelector('[aria-label="Edit image"]') &&
              viewer.querySelector('[aria-label="Close image preview"]'),
          );
        },
        2_000,
      );
      document
        .querySelector('#gpt-codex-custom-image-viewer [aria-label="Close image preview"]')
        ?.click();
      result.generatedImageFullViewCloses = await waitForSelfTestCondition(
        () => !document.getElementById("gpt-codex-custom-image-viewer"),
        2_000,
      );
      const firstCloseRestoredFocus = await waitForSelfTestCondition(
        () => document.activeElement === imagePreviewFixture,
        2_000,
      );
      imagePreviewFixture.click();
      const viewerReopened = await waitForSelfTestCondition(
        () => Boolean(document.getElementById("gpt-codex-custom-image-viewer")),
        2_000,
      );
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      const viewerClosedByKeyboard = await waitForSelfTestCondition(
        () => !document.getElementById("gpt-codex-custom-image-viewer"),
        2_000,
      );
      result.generatedImageFullViewRestoresInteraction = Boolean(
        firstCloseRestoredFocus &&
          viewerReopened &&
          viewerClosedByKeyboard &&
          !document.documentElement.hasAttribute("data-gpt-codex-custom-image-viewer-open"),
      );
      let stagedFixtureFile = null;
      globalThis.GPT_CODEX_CUSTOM_IMAGE_COMPOSER = {
        probe: () => ({ conversationId: "self-test" }),
        stageImage: async (file) => {
          stagedFixtureFile = file;
        },
      };
      document.documentElement.dataset.gptCodexCustomImageEdit = "loading";
      imageEditControl?.click();
      await waitForSelfTestCondition(
        () => document.documentElement.dataset.gptCodexCustomImageEdit !== "loading",
        2_000,
      );
      const convertedImagePipelineWorks =
        stagedFixtureFile instanceof File &&
        stagedFixtureFile.size > 0 &&
        stagedFixtureFile.type.startsWith("image/");
      generatedImageNativeStageFixture = convertedImagePipelineWorks
        ? stagedFixtureFile
        : null;
      generatedImageNativeStageBridge = imageComposer;
      result.generatedImageEditPipelineWorks = convertedImagePipelineWorks;
    } catch {
      result.generatedImageEditControlVisible = false;
      result.generatedImageFullViewOpens = false;
      result.generatedImageFullViewCloses = false;
      result.generatedImageFullViewRestoresInteraction = false;
      result.generatedImageEditPipelineWorks = false;
    } finally {
      globalThis.GPT_CODEX_CUSTOM_IMAGE_COMPOSER = imageComposer;
      closeGeneratedImageViewer({ restoreFocus: false });
      imageFixture?.remove();
      if (imageFixtureUrl) URL.revokeObjectURL(imageFixtureUrl);
    }

    markChatSidebarSelfTestProgress("opening-second-conversation");
    selectNativeConversation(second.conversationId, second.title);
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    result.secondConversationOpened =
      document.querySelector('[data-pip-obstacle="quick-chat"]')?.textContent?.includes(second.title) ??
      false;

    const previousSessionConversationId = nativeSessionConversationId;
    startNewNativeChat();
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    const surfaceText =
      document.querySelector('[data-pip-obstacle="quick-chat"]')?.textContent ?? "";
    result.newChatOpened =
      (nativeSessionConversationId != null &&
        nativeSessionConversationId !== previousSessionConversationId) ||
      /\bNew chat\b/i.test(surfaceText);
    markChatSidebarSelfTestProgress("testing-sidebar-actions");

    const navigationLabels = [...document.querySelectorAll(".gpt-codex-custom-chat-nav-label")].map(
      (element) => element.textContent?.trim(),
    );
    result.siteNavigationReady = [
      "New chat",
      "Search chats",
      "Library",
      "Projects",
      "Scheduled",
      "Plugins",
      "More",
    ].every((label) => navigationLabels.includes(label));
    result.accountControlReady = Boolean(
      document.querySelector(".gpt-codex-custom-chat-account:not(:disabled)"),
    );
    result.historyPaginationBridgeReady =
      typeof nativeHistoryPagination.canFetchNextPage === "boolean" &&
      (!nativeHistoryPagination.canFetchNextPage ||
        typeof nativeHistoryPagination.fetchNextPage === "function");
    const newChatControl = document.querySelector(
      '[data-gpt-codex-custom-new-chat="true"]',
    );
    const conversationControls = [
      ...document.querySelectorAll(
        '.gpt-codex-custom-chat-sidebar-item:not([data-gpt-codex-custom-search-result])',
      ),
    ];
    const moreActionControl = [...document.querySelectorAll(
      ".gpt-codex-custom-chat-nav-row",
    )].find((button) => button.textContent?.trim() === "More");
    const accountActionControl = document.querySelector(
      ".gpt-codex-custom-chat-account",
    );
    result.sidebarActionsRespectBridgeReadiness =
      Boolean(newChatControl) &&
      newChatControl.disabled === (typeof nativeNewChat !== "function") &&
      conversationControls.length >= 2 &&
      conversationControls.every(
        (button) => button.disabled === (typeof nativeConversationSelect !== "function"),
      );
    const profileMenuReady = isNativeProfileMenuReady();
    result.profileReadinessConsistent =
      Boolean(moreActionControl) &&
      Boolean(accountActionControl) &&
      moreActionControl.disabled === !profileMenuReady &&
      accountActionControl.disabled === !profileMenuReady;
    const loadMoreControl = document.querySelector(
      ".gpt-codex-custom-chat-load-more",
    );
    result.loadMoreControlSafe = nativeHistoryPagination.canFetchNextPage
      ? Boolean(loadMoreControl) &&
        loadMoreControl.disabled ===
          (nativeHistoryPagination.isFetchingNextPage ||
            typeof nativeHistoryPagination.fetchNextPage !== "function")
      : !loadMoreControl;

    const searchControl = [...document.querySelectorAll(".gpt-codex-custom-chat-nav-row")].find(
      (button) => button.textContent?.trim() === "Search chats",
    );
    const previousSearchQuery = chatSearchQuery;
    chatSearchQuery = "";
    clearNativeChatSearchResults();
    searchControl?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    result.searchControlWorks = Boolean(
      document.querySelector(".gpt-codex-custom-chat-search-panel:not([hidden]) input[type='search']"),
    );
    searchControl?.click();
    chatSearchQuery = previousSearchQuery;
    clearNativeChatSearchResults();

    const moreControl = [...document.querySelectorAll(".gpt-codex-custom-chat-nav-row")].find(
      (button) => button.textContent?.trim() === "More",
    );
    moreControl?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    markNativeAccountMenu();
    result.moreMenuOpens = Boolean(
      document.querySelector('[data-gpt-codex-custom-account-menu="true"]'),
    ) || nativeProfileMenu.isOpen === true;
    if (result.moreMenuOpens) nativeProfileMenu.close?.();

    document.querySelector(".gpt-codex-custom-chat-account:not(:disabled)")?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    markNativeAccountMenu();
    result.accountMenuOpens = Boolean(
      document.querySelector('[data-gpt-codex-custom-account-menu="true"]'),
    ) || nativeProfileMenu.isOpen === true;
    if (result.accountMenuOpens) nativeProfileMenu.close?.();

    // Verify the native composer integrations while the underlying Work/Codex
    // route is still the home composer. Destination checks below intentionally
    // leave the native route on Library/Projects/etc., where no composer exists.
    const switchFromChatToNativeMode = async (mode) => {
      const trigger = document.querySelector(
        '[data-gpt-codex-custom-product-selector="true"]',
      );
      trigger?.click();
      const optionReady = await waitForSelfTestCondition(
        () =>
          [...document.querySelectorAll(
            '[data-gpt-codex-custom-product-menu="true"] [role="menuitemradio"]',
          )].some(
            (option) =>
              option.dataset.mode === mode &&
              !option.disabled &&
              option.getClientRects().length > 0,
          ),
        2_000,
      );
      const option = optionReady
        ? [...document.querySelectorAll(
            '[data-gpt-codex-custom-product-menu="true"] [role="menuitemradio"]',
          )].find((candidate) => candidate.dataset.mode === mode)
        : null;
      const modelPickerStabilityPromise = option
        ? sampleModelPickerModeTransition(mode)
        : Promise.resolve({
            schemaVersion: 3,
            pass: false,
            sampleDurationMs: 0,
            stableDurationMs: 0,
            sampleCount: 0,
            postModeSampleCount: 0,
            probeUnavailableSampleCount: 0,
            postModeProbeUnavailableSampleCount: 0,
            classifierErrorFrameCount: 0,
            customOnlyFrameCount: 0,
            duplicateFrameCount: 0,
            missingControlFrameCount: 0,
            modeMismatchFrameCount: 0,
            multipleCustomHostFrameCount: 0,
            nativeVisibleFrameCount: 0,
            nativeOnlyFrameCount: 0,
            nonActionableControlFrameCount: 0,
            unrelatedSuppressionFrameCount: 0,
            maxVisibleNativeTriggerCount: null,
            minVisibleCustomTriggerCount: null,
            maxVisibleCustomTriggerCount: null,
            maxCustomTriggerCount: null,
            maxCustomHostCount: null,
            minSameSlotVisibleControlCount: null,
            maxSameSlotVisibleControlCount: null,
            minSameSlotActionableControlCount: null,
            maxSameSlotActionableControlCount: null,
            final: null,
          });
      option?.click();
      const surfaceSwitched = await waitForSelfTestCondition(
        () =>
          !chatMode &&
          getNativeProductModes().mode === mode &&
          document.getElementById("gpt-codex-custom-chat-sidebar")?.hidden === true &&
          !document.querySelector('[data-pip-obstacle="quick-chat"]'),
        7_000,
      );
      const tokenModeSwitched = await waitForSelfTestCondition(
        () => globalThis.GPT_CODEX_CUSTOM_TOKEN_PROBE?.()?.mode === mode,
        7_000,
      );
      const pickerStability = await modelPickerStabilityPromise;
      const modelPickerSwitched = pickerStability.pass === true;
      const pickerEvidence = globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE?.();
      result.modelPickerModeEvidence[mode] = {
        ...pickerStability,
        bridgeKind: pickerEvidence?.bridgeKind ?? null,
        composerAnchored: pickerEvidence?.composerAnchored === true,
        customReplacementActionable: pickerEvidence?.customReplacementActionable === true,
        customTriggerCount: pickerEvidence?.customTriggerCount ?? null,
        customTriggerVisibleCount: pickerEvidence?.customTriggerVisibleCount ?? null,
        nativeCompetingTriggerCount: pickerEvidence?.nativeCompetingTriggerCount ?? null,
        nativeTriggerSuppressed: pickerEvidence?.nativeTriggerSuppressed === true,
        placement: pickerEvidence?.placement ?? null,
        unrelatedSuppressedNativeTriggerCount:
          pickerEvidence?.unrelatedSuppressedNativeTriggerCount ?? null,
        visibleNativeTriggerCount: pickerEvidence?.visibleNativeTriggerCount ?? null,
      };
      return { modelPickerSwitched, surfaceSwitched, tokenModeSwitched };
    };
    const returnToChat = async () => {
      setChatMode(true, { launch: true, persist: false });
      const surfaceRestored = await waitForSelfTestCondition(
        () =>
          document.getElementById("gpt-codex-custom-chat-sidebar")?.hidden === false &&
          Boolean(document.querySelector('[data-pip-obstacle="quick-chat"]')),
        7_000,
      );
      const tokenModeRestored = await waitForSelfTestCondition(
        () => globalThis.GPT_CODEX_CUSTOM_TOKEN_PROBE?.()?.mode === "chat",
        7_000,
      );
      const modelPickerRestored = await waitForSelfTestCondition(() => {
        const picker = globalThis.GPT_CODEX_CUSTOM_MODEL_PICKER_PROBE?.();
        return (
          picker?.activeMode === "chat" &&
          picker?.bridgeKind === "chat" &&
          picker?.bridgeReady === true &&
          picker?.highSelectable === true
        );
      }, 7_000);
      return { modelPickerRestored, surfaceRestored, tokenModeRestored };
    };

    markChatSidebarSelfTestProgress("testing-work-mode");
    const workSwitch = await switchFromChatToNativeMode("work");
    result.workModeSelectionWorks = workSwitch.surfaceSwitched;
    result.modelPickerWorkModeWorks = workSwitch.modelPickerSwitched;
    result.tokenHudWorkModeWorks = workSwitch.tokenModeSwitched;
    const chatAfterWork = await returnToChat();

    markChatSidebarSelfTestProgress("testing-codex-mode");
    const codexSwitch = await switchFromChatToNativeMode("codex");
    result.codexModeSelectionWorks = codexSwitch.surfaceSwitched;
    result.modelPickerCodexModeWorks = codexSwitch.modelPickerSwitched;
    result.tokenHudCodexModeWorks = codexSwitch.tokenModeSwitched;
    const chatAfterCodex = await returnToChat();
    result.tokenHudChatReturnWorks =
      chatAfterWork.tokenModeRestored && chatAfterCodex.tokenModeRestored;
    result.modelPickerChatReturnWorks =
      chatAfterWork.modelPickerRestored && chatAfterCodex.modelPickerRestored;
    result.modeExitHidesChat =
      result.workModeSelectionWorks && result.codexModeSelectionWorks;
    result.modeReentryRestoresChat =
      chatAfterWork.surfaceRestored && chatAfterCodex.surfaceRestored;

    const destinationPaths = {
      library: "/library",
      projects: "/projects",
      scheduled: "/automations",
      plugins: "/plugins",
    };
    for (const [destination, expectedPath] of Object.entries(destinationPaths)) {
      if (typeof nativeNavigation[destination] !== "function") continue;
      markChatSidebarSelfTestProgress(`testing-destination-${destination}`);
      openNativeDestination(destination);
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      const surface = document.querySelector('[data-pip-obstacle="quick-chat"]');
      result.destinationRouteResults[destination] = {
        auxiliaryStateMatches:
          chatAuxiliaryView === destination &&
          document.documentElement.dataset.gptCodexCustomAuxView === destination,
        overlayHidden: !surface || getComputedStyle(surface).display === "none",
        path: nativeNavigation.path ?? null,
        routeStayedOpen: nativeNavigation.path?.startsWith(expectedPath) === true,
      };
    }
    result.auxiliaryDestinationsVisible = Object.values(result.destinationRouteResults).every(
      (destination) =>
        destination.auxiliaryStateMatches &&
        destination.routeStayedOpen &&
        destination.overlayHidden,
    );
    if (result.destinationRouteResults.library) {
      result.libraryPathAfterNavigation = result.destinationRouteResults.library.path;
      result.libraryNavigationDispatched = nativeNavigationLastRequested != null;
      result.libraryRouteStayedOpen = result.destinationRouteResults.library.routeStayedOpen;
    }
    if (typeof nativeConversationSelect === "function") {
      selectNativeConversation(first.conversationId, first.title);
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      result.auxiliaryStateClearsOnChatReturn =
        chatAuxiliaryView == null &&
        !document.documentElement.hasAttribute("data-gpt-codex-custom-aux-view");
    }

    markChatSidebarSelfTestProgress("testing-native-image-stage");
    try {
      if (
        !(generatedImageNativeStageFixture instanceof File) ||
        typeof generatedImageNativeStageBridge?.selfTestStageImage !== "function"
      ) {
        throw new Error("The native image-edit staging bridge is unavailable.");
      }
      const nativeStageResult = await withSelfTestTimeout(
        generatedImageNativeStageBridge.selfTestStageImage(generatedImageNativeStageFixture),
        15_000,
        "Native image-edit staging self-test",
      );
      result.generatedImageNativeStageWorks =
        nativeStageResult?.status === "ready" &&
        Number(nativeStageResult?.stagedAttachmentCount) >= 1 &&
        nativeStageResult?.cleaned === true &&
        nativeStageResult?.hintRestored === true;
    } catch {
      result.generatedImageNativeStageWorks = false;
    }
    result.generatedImageEditPipelineWorks =
      result.generatedImageEditPipelineWorks && result.generatedImageNativeStageWorks;
  }

  try {
    sessionStorage.removeItem(CHAT_SELF_TEST_STORAGE_KEY);
  } catch {
    // Ignore locked-down session storage.
  }
  markChatSidebarSelfTestProgress("sending-result");
  await window.electronBridge?.sendMessageFromView({
    type: "gpt-codex-custom-self-test-result",
    ...result,
  });
  scheduleDiagnostics();
  } finally {
    restoreStoredProductMode();
  }
}

let chatSidebarSelfTestPromise = null;

function startChatSidebarSelfTest() {
  if (chatSidebarSelfTestPromise) return chatSidebarSelfTestPromise;
  chatSidebarSelfTestPromise = runChatSidebarSelfTest().catch(async (error) => {
    markChatSidebarSelfTestProgress("failed");
    try {
      sessionStorage.removeItem(CHAT_SELF_TEST_STORAGE_KEY);
    } catch {
      // Ignore locked-down session storage.
    }
    await window.electronBridge?.sendMessageFromView({
      type: "gpt-codex-custom-self-test-result",
      ready: false,
      selfTestError: String(error?.message ?? error).slice(0, 500),
    });
    scheduleDiagnostics();
    return false;
  });
  return chatSidebarSelfTestPromise;
}

window.addEventListener("message", (event) => {
  if (event.data?.type === "gpt-codex-custom-run-self-test") {
    void startChatSidebarSelfTest();
  }
});

function markWindowTitle() {
  const suffix = " · Custom";
  if (document.title && !document.title.endsWith(suffix)) {
    document.title += suffix;
  }
}

function isChatConversationRoute() {
  return /^\/work\/conversation\/[^/]+/.test(window.location.pathname);
}

function findProductModeTrigger() {
  return [...document.querySelectorAll("button[aria-label]")].find((button) =>
    button.getAttribute("aria-label")?.startsWith("Switch mode, current mode:"),
  );
}

function updateProductModeTrigger() {
  const trigger = findProductModeTrigger();
  if (!trigger) return;

  const nativeMode = [...trigger.querySelectorAll("span")].find((span) =>
    ["Work", "Codex"].includes(span.textContent?.trim()),
  );
  const productBrand = [...trigger.querySelectorAll("span")].find(
    (span) => span.textContent?.trim() === "ChatGPT",
  );

  if (chatMode) {
    trigger.dataset.gptCodexCustomChatTrigger = "true";
    trigger.setAttribute("aria-label", "Switch mode, current mode: Chat");
    if (nativeMode) {
      nativeMode.dataset.gptCodexCustomNativeMode = "true";
      nativeMode.setAttribute("aria-hidden", "true");
    }
    if (productBrand) {
      productBrand.dataset.gptCodexCustomProductBrand = "true";
      productBrand.setAttribute("aria-hidden", "true");
    }
    if (!trigger.querySelector("[data-gpt-codex-custom-chat-label]")) {
      const label = document.createElement("span");
      label.dataset.gptCodexCustomChatLabel = "true";
      label.className = "shrink-0 text-token-text-primary";
      label.textContent = "Chat";
      const chevron = trigger.lastElementChild;
      trigger.insertBefore(label, chevron);
    }
  } else {
    trigger.removeAttribute("data-gpt-codex-custom-chat-trigger");
    trigger.querySelector("[data-gpt-codex-custom-chat-label]")?.remove();
    const hiddenMode = trigger.querySelector("[data-gpt-codex-custom-native-mode]");
    hiddenMode?.removeAttribute("aria-hidden");
    hiddenMode?.removeAttribute("data-gpt-codex-custom-native-mode");
    const hiddenBrand = trigger.querySelector("[data-gpt-codex-custom-product-brand]");
    hiddenBrand?.removeAttribute("aria-hidden");
    hiddenBrand?.removeAttribute("data-gpt-codex-custom-product-brand");
  }
}

function findSidebarChatButton() {
  const taggedControl = document.querySelector("[data-gpt-codex-custom-chat-control]");
  if (taggedControl) return taggedControl;

  return [...document.querySelectorAll('button, a, [role="button"]')].find((control) => {
    if (control.closest('[role="menu"], [role="listbox"]')) return false;
    const text = control.textContent?.replace(/\s+/g, " ").trim();
    return text === "Chat" || text?.startsWith("Chat ");
  });
}

function updateSidebarBoundary() {
  const chatButton = findSidebarChatButton();
  if (!chatButton) return;

  let sidebarRight = chatButton.getBoundingClientRect().right;
  let node = chatButton.parentElement;
  while (node && node !== document.body) {
    const rect = node.getBoundingClientRect();
    if (
      rect.left <= 8 &&
      rect.width >= 180 &&
      rect.width <= 480 &&
      rect.height >= window.innerHeight * 0.55
    ) {
      sidebarRight = Math.max(sidebarRight, rect.right);
    }
    node = node.parentElement;
  }

  document.documentElement.style.setProperty(
    "--gpt-codex-custom-sidebar-right",
    `${Math.round(sidebarRight)}px`,
  );
  const triggerBottom = findProductModeTrigger()?.getBoundingClientRect().bottom;
  if (triggerBottom) {
    document.documentElement.style.setProperty(
      "--gpt-codex-custom-chat-sidebar-top",
      `${Math.round(triggerBottom + 10)}px`,
    );
  }
}

function openNativeChat() {
  if (!chatMode) {
    chatLaunchPending = false;
    chatLaunchAttempts = 0;
    return;
  }

  if (document.querySelector('[data-pip-obstacle="quick-chat"]')) {
    chatLaunchPending = false;
    chatLaunchAttempts = 0;
    updateChatSurfaceDiagnostic();
    return;
  }

  const chatButton = findSidebarChatButton();
  if (!chatButton) {
    chatLaunchAttempts += 1;
    if (chatLaunchAttempts < 30) {
      window.setTimeout(openNativeChat, 100);
    } else {
      failNativeChatLaunch(
        "Chat could not be opened because its connected native control was not found.",
      );
    }
    return;
  }

  updateSidebarBoundary();
  const now = Date.now();
  if (
    chatButton.getAttribute("aria-pressed") !== "true" &&
    now - lastChatControlClickAt > 1000
  ) {
    chatButton.click();
    lastChatControlClickAt = now;
  }
  chatLaunchAttempts += 1;
  if (chatLaunchAttempts < 30) {
    window.setTimeout(openNativeChat, 120);
  } else {
    failNativeChatLaunch("Chat could not be opened by its connected native control.");
  }
}

function setChatMode(enabled, { launch = false, persist = true } = {}) {
  chatMode = enabled;
  if (enabled) {
    document.documentElement.setAttribute(CHAT_MODE_ATTRIBUTE, "chat");
    syncChatTokenContext();
  } else {
    document.documentElement.removeAttribute(CHAT_MODE_ATTRIBUTE);
    // The native product bridge can publish its new Work/Codex mode just
    // before chatMode flips false. Re-publish the active context here so that
    // ordering cannot leave the HUD stuck on the prior Chat context.
    const nativeMode = getNativeProductModes().mode;
    if (["work", "codex"].includes(nativeMode)) {
      globalThis.GPT_CODEX_CUSTOM_SYNC_TOKEN_CONTEXT?.({
        mode: nativeMode,
        source: "chat-mode-exit",
        threadId: null,
        tokenUsage: null,
      });
    }
  }

  if (persist) {
    try {
      localStorage.setItem(CHAT_MODE_STORAGE_KEY, enabled ? "chat" : "native");
    } catch {
      // A locked-down profile can disable storage; the current session still works.
    }
  }

  if (!enabled) {
    cancelChatThreadBottomSettlement("idle");
    closeChatConversationMenu();
    closeChatActionDialog();
    closeChatDeleteDialog();
    closeGeneratedImageViewer();
    cancelPendingNativeNavigation();
    chatSurfaceReturnOverride = false;
    clearChatSurfaceReturnTimer();
    clearAuxiliaryView();
    closeChatSearch();
    chatProductMenuOpen = false;
    chatProductMenuFocusMode = null;
    chatProductMenuFocusRequest = null;
    chatProductOrientationVisible = false;
    const chatControl = findSidebarChatButton();
    const chatSurface = document.querySelector('[data-pip-obstacle="quick-chat"]');
    if (
      chatControl?.isConnected &&
      (chatSurface || chatControl.getAttribute("aria-pressed") === "true")
    ) {
      chatControl.click();
    }
  }

  updateProductModeTrigger();
  updateSidebarBoundary();
  scheduleChatSidebarRender();

  if (enabled && launch && !chatLaunchPending) {
    chatLaunchPending = true;
    chatLaunchAttempts = 0;
    window.setTimeout(openNativeChat, 50);
  }
}

function updateChatHeaderControls() {
  const surface = document.querySelector('[data-pip-obstacle="quick-chat"]');
  if (!surface) return;

  for (const button of surface.querySelectorAll("header button")) {
    const label = `${button.getAttribute("aria-label") ?? ""} ${button.textContent ?? ""}`
      .replace(/\s+/g, " ")
      .trim();
    if (/Add to task|Open in a new window|Close chat/i.test(label)) {
      button.hidden = chatMode;
      button.dataset.gptCodexCustomModeSpecificControl = "true";
    }
  }
}

function updateChatSurfaceDiagnostic() {
  const surface = document.querySelector('[data-pip-obstacle="quick-chat"]');
  document.documentElement.dataset.gptCodexCustomChatSurface = surface
    ? "open"
    : chatMode
      ? "waiting"
      : "inactive";
}

function openInitialChatHistory() {
  const surface = document.querySelector('[data-pip-obstacle="quick-chat"]');
  if (!chatMode || !surface || surface.dataset.gptCodexCustomHistoryInitialized) return;

  const historyButton = [...surface.querySelectorAll("button")].find(
    (button) => button.textContent?.replace(/\s+/g, " ").trim() === "View chat history",
  );
  if (!historyButton) return;

  surface.dataset.gptCodexCustomHistoryInitialized = "true";
  historyButton.click();
}

function getDiagnosticsBridge() {
  diagnosticsBridgePromise ??= import("./vscode-api-Dvdo4I-8.js").then(
    ({ m: messageBus }) => messageBus.getInstance(),
  );
  return diagnosticsBridgePromise;
}

function scheduleDiagnostics() {
  if (new URLSearchParams(window.location.search).has("initialRoute")) return;
  if (diagnosticsTimer) return;
  diagnosticsTimer = window.setTimeout(async () => {
    diagnosticsTimer = 0;
    const surface = document.querySelector('[data-pip-obstacle="quick-chat"]');
    const chatControl = findSidebarChatButton();
    const productTrigger = findProductModeTrigger();
    const threadViewport = surface?.querySelector(
      '[data-quick-chat-thread-scroll-container="true"]',
    );
    const threadScrollBottom =
      threadViewport instanceof HTMLElement
        ? Math.max(0, threadViewport.scrollHeight - threadViewport.clientHeight)
        : null;
    const surfaceText = surface?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const ariaButtons = surface
      ? [...surface.querySelectorAll("button[aria-label]")].filter(
          (button) => !/close|minimize|new chat|history/i.test(button.getAttribute("aria-label") ?? ""),
        ).length
      : 0;
    const modeSpecificHeaderControls = surface
      ? [...surface.querySelectorAll("header button")].filter((button) =>
          /Add to task|Open in a new window|Close chat/i.test(
            `${button.getAttribute("aria-label") ?? ""} ${button.textContent ?? ""}`,
          ),
        )
      : [];

    try {
      await window.electronBridge?.sendMessageFromView({
        type: "gpt-codex-custom-diagnostics",
        chatMode,
        chatSurfaceOpen: Boolean(surface),
        chatSurfaceState:
          document.documentElement.dataset.gptCodexCustomChatSurface ?? "unknown",
        chatThreadScrollAtBottom:
          threadViewport instanceof HTMLElement
            ? Math.abs(threadViewport.scrollTop - threadScrollBottom) <= 1
            : null,
        chatThreadScrollState:
          document.documentElement.dataset.gptCodexCustomChatScroll ?? "idle",
        chatControlFound: Boolean(chatControl),
        chatControlTag: chatControl?.tagName ?? null,
        chatControlPressed: chatControl?.getAttribute("aria-pressed") ?? null,
        chatControlDisabled:
          chatControl instanceof HTMLButtonElement ? chatControl.disabled : null,
        chatLaunchAttempts,
        millisecondsSinceChatControlClick: lastChatControlClickAt
          ? Date.now() - lastChatControlClickAt
          : null,
        conversationCandidateCount: ariaButtons,
        hasHistoryHeading: /\bHistory\b/i.test(surfaceText),
        hasRecentChats: /\bRecent chats\b/i.test(surfaceText),
        hasViewChatHistory: /View chat history|See all/i.test(surfaceText),
        historyListItemCount: surface?.querySelectorAll("li button").length ?? 0,
        customSidebarHistoryCount: chatHistoryById.size,
        customSidebarPinnedCount: [...chatHistoryById.values()].filter(
          (conversation) => conversation.pinned,
        ).length,
        customSidebarVisible:
          document.getElementById("gpt-codex-custom-chat-sidebar")?.hidden === false,
        customProductSelectorVisible: Boolean(
          document.querySelector('[data-gpt-codex-custom-product-selector="true"]'),
        ),
        customProductOrientationVisible: chatProductOrientationVisible,
        customProductMenuOpen: chatProductMenuOpen,
        initialProductModeDecision: initialProductModeDecision
          ? {
              autoOpenProductMenu: initialProductModeDecision.autoOpenProductMenu,
              chatMode: initialProductModeDecision.chatMode,
              freshProfile: initialProductModeDecision.freshProfile,
              storedMode: initialProductModeDecision.storedMode,
            }
          : null,
        rendererContractSelfTest: RENDERER_CONTRACT_SELF_TEST,
        nativeProductModeBridgeReady:
          typeof getNativeProductModes().selectWork === "function" &&
          typeof getNativeProductModes().selectCodex === "function",
        generatedImageEditBridgeReady:
          typeof getNativeImageComposer().stageImage === "function",
        generatedImageEditControlCount: document.querySelectorAll(
          "[data-gpt-codex-custom-image-edit]",
        ).length,
        generatedImageViewerOpen: Boolean(generatedImageViewerElement?.isConnected),
        generatedImageViewerReadyCount: document.querySelectorAll(
          'button[data-testid="generated-image-preview"][data-gpt-codex-custom-image-edit-ready="true"]',
        ).length,
        customSidebarSiteNavigationReady:
          document.querySelectorAll(".gpt-codex-custom-chat-nav-row").length >= 7,
        customSidebarNativeDestinationCount: ["library", "projects", "scheduled", "plugins"].filter(
          (key) => typeof nativeNavigation[key] === "function",
        ).length,
        customSidebarAccountReady: isNativeProfileMenuReady(),
        customSidebarSearchOpen: chatSearchOpen,
        customSidebarNativeSearchReady: isNativeChatSearchAvailable(),
        customSidebarNativeDeleteReady: isNativeChatDeleteAvailable(),
        customSidebarNativeManagementReady: isNativeChatManagementAvailable(),
        customSidebarNativeActionCount: CHAT_ACTION_BRIDGE_KEYS.filter((key) =>
          isNativeChatActionAvailable(key),
        ).length,
        customSidebarNativeSearchLoading: nativeChatSearchLoading,
        customSidebarNativeSearchHasError: Boolean(nativeChatSearchError),
        customSidebarNativeSearchResultCount: nativeChatSearchResults.length,
        customSidebarNativeSearchHasNextCursor: nativeChatSearchCursor != null,
        customSidebarAuxiliaryView: chatAuxiliaryView,
        customSidebarNativePath: nativeNavigation.path ?? null,
        nativeConversationSelectReady: typeof nativeConversationSelect === "function",
        nativeNewChatReady: typeof nativeNewChat === "function",
        activeChatConversationId,
        nativeSessionAvailable: nativeSessionConversationId != null,
        nativeSessionHasTitle: Boolean(nativeSessionTitle),
        modeSpecificHeaderControlsHidden:
          modeSpecificHeaderControls.length > 0 &&
          modeSpecificHeaderControls.every((button) => button.hidden),
        pathname: window.location.pathname,
        productTriggerText: productTrigger?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        productTriggerVisibleText: productTrigger
          ? [...productTrigger.querySelectorAll("span")]
              .filter((span) => getComputedStyle(span).display !== "none")
              .map((span) => span.textContent?.trim())
              .filter(Boolean)
              .join(" ")
          : null,
      });
    } catch {
      // Diagnostics must never interfere with the UI.
    }
  }, 250);
}

function handleNativeModeSelection(event) {
  if (
    chatProductMenuOpen &&
    event.target instanceof Element &&
    !event.target.closest(
      '[data-gpt-codex-custom-product-selector], [data-gpt-codex-custom-product-menu]',
    )
  ) {
    closeChatProductMenu();
  }
  if (!chatMode) return;
  const item =
    event.target instanceof Element
      ? event.target.closest('[role="menuitem"], [role="menuitemradio"], [role="option"]')
      : null;
  const label = item?.textContent?.replace(/\s+/g, " ").trim();
  if (
    !item?.closest('[data-gpt-codex-custom-product-menu="true"]') &&
    (label?.startsWith("Work") || label?.startsWith("Codex"))
  ) {
    setChatMode(false);
  }
}

function handleCustomUiKeydown(event) {
  if (!chatMode) return;
  if (generatedImageViewerElement) {
    if (event.key === "Tab") {
      trapGeneratedImageViewerFocus(event);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeGeneratedImageViewer();
      return;
    }
    if (!["+", "=", "-", "0"].includes(event.key)) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "-") updateGeneratedImageViewerScale(generatedImageViewerScale - 0.25);
    else if (event.key === "0") updateGeneratedImageViewerScale(1);
    else updateGeneratedImageViewerScale(generatedImageViewerScale + 0.25);
    return;
  }
  if (chatActionDialogElement) {
    if (event.key === "Tab") {
      trapChatDialogFocus(
        event,
        chatActionDialogElement,
        ".gpt-codex-custom-chat-action-dialog",
      );
      return;
    }
    if (event.key !== "Escape") return;
    const pendingDialog = chatActionDialogElement.querySelector(
      ".gpt-codex-custom-chat-action-dialog",
    );
    if (pendingDialog?.dataset.pending !== "true") {
      event.preventDefault();
      event.stopPropagation();
      closeChatActionDialog();
    }
    return;
  }
  if (chatDeleteDialogElement) {
    if (event.key === "Tab") {
      trapChatDeleteDialogFocus(event);
      return;
    }
    if (event.key !== "Escape") return;
    const pendingDialog = chatDeleteDialogElement.querySelector(
      ".gpt-codex-custom-chat-delete-dialog",
    );
    if (pendingDialog?.dataset.pending !== "true") {
      event.preventDefault();
      event.stopPropagation();
      closeChatDeleteDialog();
    }
    return;
  }
  if (event.key !== "Escape") return;
  if (chatConversationMenuElement) {
    closeChatConversationMenu();
    return;
  }
  if (chatProductMenuOpen) {
    event.preventDefault();
    event.stopPropagation();
    closeChatProductMenu({ restoreFocus: true });
    return;
  }
  if (chatSearchOpen) {
    closeChatSearch();
    scheduleChatSidebarRender();
  }
}

function reconcileUi() {
  if (
    reconcileAuxiliaryViewWithPath(nativeNavigation.path ?? window.location.pathname, {
      restoreChat: true,
    })
  ) {
    scheduleChatSidebarRender();
  }
  if (isChatConversationRoute() && !chatMode) {
    setChatMode(true, { persist: false });
  }
  updateProductModeTrigger();
  updateChatSurfaceDiagnostic();
  openInitialChatHistory();
  updateChatHeaderControls();
  ensureGeneratedImageEditControls();
  markNativeAccountMenu();
  reconcileNativeProfileMenuReadiness();
  scheduleDiagnostics();
  if (chatMode) updateSidebarBoundary();
}

function installHistoryObserver() {
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function customHistoryMethod(...args) {
      const result = original.apply(this, args);
      queueMicrotask(reconcileUi);
      return result;
    };
  }
  window.addEventListener("popstate", reconcileUi);
}

function initializeCustomUi() {
  markCustomBuild();
  markWindowTitle();
  installHistoryObserver();
  document.addEventListener("click", handleGeneratedImagePreviewClick, true);
  document.addEventListener("click", handleNativeModeSelection, true);
  document.addEventListener("keydown", handleCustomUiKeydown, true);
  window.addEventListener("resize", updateSidebarBoundary);

  new MutationObserver(reconcileUi).observe(document.body, {
    childList: true,
    subtree: true,
  });

  let orientationSeen = false;
  let storageAvailable = true;
  let storedMode = null;
  try {
    storedMode = localStorage.getItem(CHAT_MODE_STORAGE_KEY);
    orientationSeen = localStorage.getItem(CHAT_PRODUCT_ORIENTATION_SEEN_KEY) != null;
  } catch {
    storageAvailable = false;
  }
  initialProductModeDecision = getInitialProductModeDecision({
    conversationRoute: isChatConversationRoute(),
    orientationSeen,
    storageAvailable,
    storedMode,
  });
  if (initialProductModeDecision.autoOpenProductMenu) {
    chatProductMenuOpen = true;
    chatProductMenuFocusMode = null;
    chatProductMenuFocusRequest = "current";
    chatProductOrientationVisible = true;
  }
  document.documentElement.dataset.gptCodexCustomRendererSelfTest =
    RENDERER_CONTRACT_SELF_TEST.pass ? "passed" : "failed";
  setChatMode(initialProductModeDecision.chatMode, {
    launch: initialProductModeDecision.chatMode,
    persist: false,
  });
  try {
    if (sessionStorage.getItem(CHAT_SELF_TEST_STORAGE_KEY) != null) {
      window.setTimeout(() => void startChatSidebarSelfTest(), 1800);
    }
  } catch {
    // Ignore locked-down session storage.
  }
  scheduleDiagnostics();
  window.setTimeout(scheduleDiagnostics, 3000);
}

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_BUILD", {
  configurable: false,
  enumerable: true,
  value: BUILD_INFO,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_OPEN_CHAT", {
  configurable: false,
  enumerable: false,
  value: (options = {}) =>
    setChatMode(true, { launch: true, persist: options?.persist !== false }),
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_RUN_SELF_TEST", {
  configurable: false,
  enumerable: false,
  value: startChatSidebarSelfTest,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_RENDERER_CONTRACT_SELF_TEST", {
  configurable: false,
  enumerable: false,
  value: () => RENDERER_CONTRACT_SELF_TEST,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_SYNC_HISTORY", {
  configurable: false,
  enumerable: false,
  value: syncNativeChatHistory,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_SYNC_CHAT_SEARCH", {
  configurable: false,
  enumerable: false,
  value: syncNativeChatSearch,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_SYNC_CHAT_ACTIONS", {
  configurable: false,
  enumerable: false,
  value: syncNativeChatActions,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_SYNC_SESSION", {
  configurable: false,
  enumerable: false,
  value: syncNativeChatSession,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_CHAT_SCROLL_PROBE", {
  configurable: false,
  enumerable: false,
  value: getChatThreadScrollState,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_SYNC_HISTORY_PAGINATION", {
  configurable: false,
  enumerable: false,
  value: syncNativeHistoryPagination,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_SYNC_NAVIGATION", {
  configurable: false,
  enumerable: false,
  value: syncNativeNavigation,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_SYNC_PROFILE", {
  configurable: false,
  enumerable: false,
  value: syncNativeProfileIdentity,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_SYNC_PROFILE_MENU", {
  configurable: false,
  enumerable: false,
  value: syncNativeProfileMenu,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_SYNC_PRODUCT_MODES", {
  configurable: false,
  enumerable: false,
  value: syncNativeProductModes,
  writable: false,
});

Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_SYNC_IMAGE_COMPOSER", {
  configurable: false,
  enumerable: false,
  value: syncNativeImageComposer,
  writable: false,
});

function runCustomUiInitialization() {
  sendRendererStatus("initializing");
  try {
    initializeCustomUi();
    sendRendererStatus("initialized");
  } catch (error) {
    sendRendererStatus("initialization-error", {
      message: String(error?.message ?? error),
      stack: error?.stack ?? null,
    });
    throw error;
  }
}

if (document.readyState === "loading") {
  sendRendererStatus("waiting-for-dom");
  document.addEventListener("DOMContentLoaded", runCustomUiInitialization, { once: true });
} else {
  runCustomUiInitialization();
}

const titleElement = document.querySelector("title");
if (titleElement) {
  new MutationObserver(markWindowTitle).observe(titleElement, {
    childList: true,
    subtree: true,
  });
}
