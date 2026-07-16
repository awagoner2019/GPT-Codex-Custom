/*
 * Local-only cross-mode message pinboard for the isolated GPT/Codex renderer.
 *
 * Public renderer-bridge contract:
 *
 *   globalThis.GPT_CODEX_CUSTOM_REGISTER_PINNABLE_MESSAGE({
 *     mode: "chat", // "chat" | "work" | "codex"
 *     role: "assistant",
 *     conversationId: "stable-conversation-id",
 *     turnId: "stable-turn-id",
 *     messageId: "stable-message-id",
 *     text: "Current message text",
 *     complete: true,
 *   });
 *
 * Repeated calls update the same source message, including streaming text and
 * completion state. The bridge may optionally include element, controlsRoot,
 * and jump when it already owns those references; otherwise this module
 * associates the payload with rendered message/turn containers by exact IDs
 * and then a conservative text fallback. Incomplete messages are associated
 * but cannot be bookmarked until complete is true.
 *
 * The only public globals are:
 *   GPT_CODEX_CUSTOM_REGISTER_PINNABLE_MESSAGE(payload)
 *   GPT_CODEX_CUSTOM_PINBOARD_PROBE()
 *
 * Bookmark content stays in IndexedDB for this renderer origin. This module
 * never uses a network API, Electron bridge, or the custom diagnostics IPC.
 *
 * Stable integration/test attributes:
 *   data-gpt-codex-pinboard
 *   data-gpt-codex-pinboard-drawer
 *   data-gpt-codex-pinboard-message
 *   data-gpt-codex-pinboard-message-id
 *   data-gpt-codex-pinboard-conversation-id
 *   data-gpt-codex-pinboard-turn-id
 *   data-gpt-codex-pinboard-role
 *   data-gpt-codex-pinboard-complete
 *   data-gpt-codex-pinboard-mode
 *   data-gpt-codex-pinboard-control
 *   data-gpt-codex-pinboard-action
 *   data-gpt-codex-pinboard-state
 *   data-gpt-codex-pinboard-filter
 *   data-gpt-codex-pinboard-item-id
 *   data-gpt-codex-pinboard-confirmation
 */

(() => {
  "use strict";

  const REGISTER_NAME = "GPT_CODEX_CUSTOM_REGISTER_PINNABLE_MESSAGE";
  const PROBE_NAME = "GPT_CODEX_CUSTOM_PINBOARD_PROBE";

  if (
    Object.prototype.hasOwnProperty.call(globalThis, REGISTER_NAME) ||
    Object.prototype.hasOwnProperty.call(globalThis, PROBE_NAME)
  ) {
    return;
  }

  const VERSION = "1.1.0";
  const DATABASE_NAME = "gpt-codex-custom-pinboard";
  const DATABASE_VERSION = 1;
  const STORE_NAME = "pins";
  const MAX_ID_LENGTH = 2_048;
  const MAX_SOURCE_ID_LENGTH = 512;
  const MAX_LABEL_LENGTH = 240;
  const MAX_TEXT_LENGTH = 250_000;
  const EXCERPT_LENGTH = 360;
  const DRAWER_ID = "gpt-codex-pinboard-drawer";
  const TITLE_ID = "gpt-codex-pinboard-title";
  const MODE_LABELS = Object.freeze({
    chat: "Chat",
    codex: "Codex",
    work: "Work",
  });
  const FILTERS = Object.freeze(["all", "chat", "work", "codex"]);
  const ASSOCIATION_ATTRIBUTES = Object.freeze({
    conversation: Object.freeze([
      "data-conversation-id",
      "data-chatgpt-conversation-id",
      "data-thread-id",
      "data-task-id",
    ]),
    message: Object.freeze([
      "data-message-id",
      "data-message-uuid",
      "data-message-key",
      "data-content-search-unit-key",
      "data-local-conversation-item-target-ids",
    ]),
    turn: Object.freeze([
      "data-chatgpt-conversation-turn-id",
      "data-content-search-turn-key",
      "data-content-search-assistant-turn-key",
      "data-turn-id",
      "data-turn-key",
    ]),
  });

  const state = {
    busyKeys: new Set(),
    database: null,
    drawerOpen: false,
    filter: "all",
    lastErrorName: null,
    pendingDeleteKey: null,
    pinsByKey: new Map(),
    storageStatus: "loading",
  };

  const registrationsByElement = new WeakMap();
  const registrationsByKey = new Map();
  const bridgeEntriesByKey = new Map();
  const pendingAssociationKeys = new Set();
  let associationObserver = null;
  let associationRenderTimer = 0;
  let associationRetryTimer = 0;
  let bodyReadyPromise;
  let lastFocusedElement = null;
  let mutationQueue = Promise.resolve();
  let registrationSequence = 0;
  let ui = null;

  function isElement(value) {
    return value != null && value.nodeType === Node.ELEMENT_NODE;
  }

  function normalizeMode(value) {
    const mode = String(value ?? "").trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(MODE_LABELS, mode)) {
      throw new TypeError('Pinboard mode must be "chat", "work", or "codex".');
    }
    return mode;
  }

  function normalizeId(value) {
    const id = String(value ?? "").trim();
    if (!id) throw new TypeError("Pinboard message id must be a non-empty string.");
    if (id.length > MAX_ID_LENGTH) {
      throw new RangeError("Pinboard message id exceeds " + MAX_ID_LENGTH + " characters.");
    }
    return id;
  }

  function normalizeSourceId(value, name, required = false) {
    if (value == null || value === "") {
      if (required) {
        throw new TypeError("Pinboard " + name + " must be a non-empty string.");
      }
      return "";
    }

    const id = String(value).trim();
    if (!id && required) {
      throw new TypeError("Pinboard " + name + " must be a non-empty string.");
    }
    if (id.length > MAX_SOURCE_ID_LENGTH) {
      throw new RangeError(
        "Pinboard " + name + " exceeds " + MAX_SOURCE_ID_LENGTH + " characters.",
      );
    }
    return id;
  }

  function normalizeRole(value) {
    const role = String(value ?? "").trim().toLowerCase();
    if (!role) throw new TypeError("Pinboard role must be a non-empty string.");
    if (role.length > 64) throw new RangeError("Pinboard role exceeds 64 characters.");
    return role;
  }

  function roleLabel(role) {
    return role.charAt(0).toUpperCase() + role.slice(1);
  }

  function makeBridgeMessageId(source) {
    const stableIdentity = source.stableId || source.turnId || source.messageId;
    return normalizeId(
      [source.conversationId, stableIdentity, source.role].join("\u001f"),
    );
  }

  function normalizeLabel(value) {
    if (value == null) return "";
    return String(value).replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
  }

  function normalizeText(value) {
    if (value == null) return "";
    return String(value)
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, MAX_TEXT_LENGTH);
  }

  function makeExcerpt(text) {
    const compact = normalizeText(text).replace(/\s+/g, " ");
    if (compact.length <= EXCERPT_LENGTH) return compact;
    return compact.slice(0, EXCERPT_LENGTH - 1).trimEnd() + "…";
  }

  function normalizeDate(value, fallback) {
    if (value == null || value === "") return fallback;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }

  function makeKey(mode, id) {
    return mode + ":" + encodeURIComponent(id);
  }

  function setStorageStatus(status, error = null) {
    state.storageStatus = status;
    state.lastErrorName = error?.name ? String(error.name) : null;
    document.documentElement.setAttribute("data-gpt-codex-pinboard", status);
    updateAllRegistrationControls();
    renderUi();
  }

  function whenBodyReady() {
    if (document.body) return Promise.resolve(document.body);
    bodyReadyPromise ??= new Promise((resolve) => {
      document.addEventListener("DOMContentLoaded", () => resolve(document.body), {
        once: true,
      });
    });
    return bodyReadyPromise;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new DOMException("IndexedDB is unavailable.", "NotSupportedError"));
        return;
      }

      let settled = false;
      const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error ?? new DOMException("Unable to open pinboard storage.", "UnknownError"));
      };

      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: "key" });

        if (!store.indexNames.contains("by-mode")) {
          store.createIndex("by-mode", "mode", { unique: false });
        }
        if (!store.indexNames.contains("by-pinned-at")) {
          store.createIndex("by-pinned-at", "pinnedAt", { unique: false });
        }
      };

      request.onerror = () => fail(request.error);
      request.onblocked = () =>
        fail(new DOMException("Pinboard storage upgrade is blocked.", "BlockedError"));
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        resolve(request.result);
      };
    });
  }

  function getAllPins(database) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).getAll();

      request.onerror = () => reject(request.error ?? transaction.error);
      request.onsuccess = () => resolve(request.result ?? []);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function putPin(pin) {
    return new Promise((resolve, reject) => {
      const transaction = state.database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(pin);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function deletePin(key) {
    return new Promise((resolve, reject) => {
      const transaction = state.database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function sanitizeStoredPin(value) {
    if (!value || typeof value !== "object") return null;

    try {
      const mode = normalizeMode(value.mode);
      const id = normalizeId(value.id);
      const key = makeKey(mode, id);
      if (value.key !== key) return null;

      const text = normalizeText(value.text);
      if (!text) return null;

      const now = new Date().toISOString();
      return Object.freeze({
        conversationId: normalizeSourceId(value.conversationId, "conversationId"),
        createdAt: normalizeDate(value.createdAt, null),
        excerpt: makeExcerpt(text),
        id,
        key,
        label: normalizeLabel(value.label),
        messageId: normalizeSourceId(value.messageId, "messageId"),
        mode,
        pinnedAt: normalizeDate(value.pinnedAt, now),
        role: value.role ? normalizeRole(value.role) : "message",
        schemaVersion: 1,
        text,
        turnId: normalizeSourceId(value.turnId, "turnId"),
        updatedAt: normalizeDate(value.updatedAt, now),
      });
    } catch {
      return null;
    }
  }

  function enqueueMutation(operation) {
    const run = mutationQueue.then(operation, operation);
    mutationQueue = run.catch(() => {});
    return run;
  }

  async function initializeStorage() {
    setStorageStatus("loading");

    try {
      const database = await openDatabase();
      state.database = database;
      database.addEventListener("versionchange", () => {
        database.close();
        if (state.database === database) state.database = null;
        setStorageStatus(
          "error",
          new DOMException("Pinboard storage version changed.", "VersionError"),
        );
        announce("Pinboard storage is unavailable until the app is reloaded.", "error");
      });

      const storedPins = await getAllPins(database);
      state.pinsByKey.clear();
      for (const value of storedPins) {
        const pin = sanitizeStoredPin(value);
        if (pin) state.pinsByKey.set(pin.key, pin);
      }

      setStorageStatus("ready");
      return true;
    } catch (error) {
      state.database?.close();
      state.database = null;
      setStorageStatus("error", error);
      announce("Pinboard storage could not be opened.", "error");
      return false;
    }
  }

  function createElement(tagName, options = {}) {
    const element = document.createElement(tagName);
    if (options.className) element.className = options.className;
    if (options.text != null) element.textContent = options.text;
    if (options.type) element.type = options.type;
    return element;
  }

  function createActionButton(action, label, variant = "secondary") {
    const button = createElement("button", {
      className: "gpt-codex-pinboard-action",
      text: label,
      type: "button",
    });
    button.setAttribute("data-gpt-codex-pinboard-action", action);
    button.setAttribute("data-gpt-codex-pinboard-variant", variant);
    return button;
  }

  function ensureUi() {
    if (ui) return ui;
    if (!document.body) return null;

    const launcher = createElement("button", {
      className: "gpt-codex-pinboard-launcher",
      type: "button",
    });
    launcher.id = "gpt-codex-pinboard-launcher";
    launcher.setAttribute("data-gpt-codex-pinboard-action", "open");
    launcher.setAttribute("aria-controls", DRAWER_ID);
    launcher.setAttribute("aria-expanded", "false");

    const launcherIcon = createElement("span", {
      className: "gpt-codex-pinboard-launcher-icon",
      text: "★",
    });
    launcherIcon.setAttribute("aria-hidden", "true");
    const launcherLabel = createElement("span", {
      className: "gpt-codex-pinboard-launcher-label",
      text: "Pinboard",
    });
    const launcherCount = createElement("span", {
      className: "gpt-codex-pinboard-launcher-count",
      text: "0",
    });
    launcherCount.setAttribute("aria-hidden", "true");
    launcher.append(launcherIcon, launcherLabel, launcherCount);

    const backdrop = createElement("div", {
      className: "gpt-codex-pinboard-backdrop",
    });
    backdrop.hidden = true;
    backdrop.setAttribute("data-gpt-codex-pinboard-backdrop", "true");

    const drawer = createElement("section", {
      className: "gpt-codex-pinboard-drawer",
    });
    drawer.id = DRAWER_ID;
    drawer.hidden = true;
    drawer.tabIndex = -1;
    drawer.setAttribute("data-gpt-codex-pinboard-drawer", "true");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-labelledby", TITLE_ID);

    const header = createElement("header", {
      className: "gpt-codex-pinboard-header",
    });
    const headingWrap = createElement("div", {
      className: "gpt-codex-pinboard-heading-wrap",
    });
    const title = createElement("h2", {
      className: "gpt-codex-pinboard-title",
      text: "Pinboard",
    });
    title.id = TITLE_ID;
    const summary = createElement("p", {
      className: "gpt-codex-pinboard-summary",
      text: "Saved locally in this custom app",
    });
    headingWrap.append(title, summary);
    const closeButton = createActionButton("close", "Close");
    closeButton.classList.add("gpt-codex-pinboard-close");
    closeButton.setAttribute("aria-label", "Close pinboard");
    header.append(headingWrap, closeButton);

    const filters = createElement("div", {
      className: "gpt-codex-pinboard-filters",
    });
    filters.setAttribute("data-gpt-codex-pinboard-filters", "true");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "Filter pinned messages");

    const filterButtons = new Map();
    for (const filter of FILTERS) {
      const filterButton = createElement("button", {
        className: "gpt-codex-pinboard-filter",
        text: filter === "all" ? "All" : MODE_LABELS[filter],
        type: "button",
      });
      filterButton.setAttribute("data-gpt-codex-pinboard-filter", filter);
      filterButton.addEventListener("click", () => {
        state.filter = filter;
        state.pendingDeleteKey = null;
        renderUi();
      });
      filterButtons.set(filter, filterButton);
      filters.appendChild(filterButton);
    }

    const list = createElement("div", {
      className: "gpt-codex-pinboard-list",
    });
    list.setAttribute("data-gpt-codex-pinboard-list", "true");
    list.setAttribute("role", "list");

    const status = createElement("p", {
      className: "gpt-codex-pinboard-status",
    });
    status.setAttribute("data-gpt-codex-pinboard-status", "idle");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("role", "status");

    drawer.append(header, filters, list, status);
    document.body.append(launcher, backdrop, drawer);

    launcher.addEventListener("click", () => void openDrawer());
    closeButton.addEventListener("click", closeDrawer);
    backdrop.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", handleDocumentKeydown, true);

    ui = {
      backdrop,
      closeButton,
      drawer,
      filterButtons,
      launcher,
      launcherCount,
      list,
      status,
      summary,
    };

    renderUi();
    return ui;
  }

  function announce(message, kind = "info") {
    if (!ui) return;
    ui.status.textContent = message;
    ui.status.setAttribute("data-gpt-codex-pinboard-status", kind);
  }

  function sortedPins() {
    return [...state.pinsByKey.values()].sort((left, right) =>
      right.pinnedAt.localeCompare(left.pinnedAt),
    );
  }

  function modeCounts() {
    const counts = { chat: 0, codex: 0, work: 0 };
    for (const pin of state.pinsByKey.values()) counts[pin.mode] += 1;
    return counts;
  }

  function formatDate(value) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value));
    } catch {
      return "";
    }
  }

  function findLiveRegistration(key, requireCallback = false) {
    const registrations = registrationsByKey.get(key);
    if (!registrations) return null;

    const ordered = [...registrations].sort(
      (left, right) => right.sequence - left.sequence,
    );
    return (
      ordered.find(
        (registration) =>
          registration.element.isConnected &&
          (!requireCallback || typeof registration.jump === "function"),
      ) ?? null
    );
  }

  function hasJumpTarget(key) {
    return Boolean(findLiveRegistration(key, true) ?? findLiveRegistration(key));
  }

  function renderPinItem(pin) {
    const item = createElement("article", {
      className: "gpt-codex-pinboard-item",
    });
    item.setAttribute("data-gpt-codex-pinboard-item-id", pin.key);
    item.setAttribute("data-gpt-codex-pinboard-mode", pin.mode);
    item.setAttribute("data-gpt-codex-pinboard-role", pin.role);
    if (pin.conversationId) {
      item.setAttribute("data-gpt-codex-pinboard-conversation-id", pin.conversationId);
    }
    if (pin.turnId) item.setAttribute("data-gpt-codex-pinboard-turn-id", pin.turnId);
    if (pin.messageId) {
      item.setAttribute("data-gpt-codex-pinboard-message-id", pin.messageId);
    }
    item.setAttribute("role", "listitem");

    const meta = createElement("div", {
      className: "gpt-codex-pinboard-item-meta",
    });
    const mode = createElement("span", {
      className: "gpt-codex-pinboard-mode",
      text: MODE_LABELS[pin.mode],
    });
    mode.setAttribute("data-gpt-codex-pinboard-mode-badge", pin.mode);
    const role = createElement("span", {
      className: "gpt-codex-pinboard-role",
      text: roleLabel(pin.role),
    });
    role.setAttribute("data-gpt-codex-pinboard-role-badge", pin.role);
    const timestamp = createElement("time", {
      className: "gpt-codex-pinboard-time",
      text: formatDate(pin.pinnedAt),
    });
    timestamp.dateTime = pin.pinnedAt;
    meta.append(mode, role, timestamp);
    item.appendChild(meta);

    if (pin.label) {
      const label = createElement("h3", {
        className: "gpt-codex-pinboard-item-label",
        text: pin.label,
      });
      item.appendChild(label);
    }

    const excerpt = createElement("p", {
      className: "gpt-codex-pinboard-excerpt",
      text: pin.excerpt,
    });
    excerpt.setAttribute("data-gpt-codex-pinboard-excerpt", "true");
    item.appendChild(excerpt);

    if (state.pendingDeleteKey === pin.key) {
      const confirmation = createElement("div", {
        className: "gpt-codex-pinboard-confirmation",
      });
      confirmation.setAttribute("data-gpt-codex-pinboard-confirmation", "delete");
      confirmation.setAttribute("role", "group");
      confirmation.setAttribute("aria-label", "Confirm bookmark removal");

      const question = createElement("p", {
        className: "gpt-codex-pinboard-confirmation-text",
        text: "Remove this bookmark? The saved copy will be deleted from this app.",
      });
      const actions = createElement("div", {
        className: "gpt-codex-pinboard-item-actions",
      });
      const cancel = createActionButton("cancel-delete", "Cancel");
      const confirm = createActionButton("confirm-delete", "Remove", "danger");
      const deleting = state.busyKeys.has(pin.key);
      cancel.disabled = deleting;
      confirm.disabled = deleting;
      cancel.addEventListener("click", () => {
        state.pendingDeleteKey = null;
        renderUi();
        focusItemAction(pin.key, "delete");
      });
      confirm.addEventListener("click", () => void confirmDelete(pin.key));
      actions.append(cancel, confirm);
      confirmation.append(question, actions);
      item.appendChild(confirmation);
      return item;
    }

    const actions = createElement("div", {
      className: "gpt-codex-pinboard-item-actions",
    });
    const copy = createActionButton("copy", "Copy");
    copy.addEventListener("click", () => void copyPinnedMessage(pin));
    actions.appendChild(copy);

    if (hasJumpTarget(pin.key)) {
      const jump = createActionButton("jump", "Jump");
      jump.addEventListener("click", () => void jumpToPinnedMessage(pin));
      actions.appendChild(jump);
    }

    const remove = createActionButton("delete", "Remove", "quiet-danger");
    remove.addEventListener("click", () => requestDelete(pin.key));
    actions.appendChild(remove);
    item.appendChild(actions);
    return item;
  }

  function renderEmptyState() {
    const empty = createElement("div", {
      className: "gpt-codex-pinboard-empty",
    });
    empty.setAttribute("data-gpt-codex-pinboard-empty", state.storageStatus);

    const title = createElement("h3", {
      className: "gpt-codex-pinboard-empty-title",
    });
    title.tabIndex = -1;
    title.setAttribute("data-gpt-codex-pinboard-empty-heading", "true");
    const detail = createElement("p", {
      className: "gpt-codex-pinboard-empty-detail",
    });

    if (state.storageStatus === "loading") {
      title.textContent = "Opening local pinboard…";
      detail.textContent = "Saved messages will appear here.";
    } else if (state.storageStatus === "error") {
      title.textContent = "Pinboard storage is unavailable";
      detail.textContent = "Reload the custom app to try opening local storage again.";
    } else if (state.filter === "all") {
      title.textContent = "Nothing pinned yet";
      detail.textContent = "Use the star control on a registered message to save it here.";
    } else {
      title.textContent = "No " + MODE_LABELS[state.filter] + " pins";
      detail.textContent = "Choose another filter or bookmark a message in this mode.";
    }

    empty.append(title, detail);
    return empty;
  }

  function renderUi() {
    if (!ui) return;

    const counts = modeCounts();
    const total = state.pinsByKey.size;
    const launcherDescription =
      total === 0
        ? "Open pinboard, no saved messages"
        : "Open pinboard, " +
          total +
          (total === 1 ? " saved message" : " saved messages");
    ui.launcherCount.textContent = String(total);
    ui.launcher.setAttribute("aria-label", launcherDescription);
    ui.launcher.title = launcherDescription;
    ui.launcher.setAttribute("data-gpt-codex-pinboard-count", String(total));
    ui.drawer.setAttribute("data-gpt-codex-pinboard-storage", state.storageStatus);
    ui.summary.textContent =
      total === 0
        ? "Saved locally in this custom app"
        : total + (total === 1 ? " saved message" : " saved messages") + " · local only";

    for (const [filter, button] of ui.filterButtons) {
      const count = filter === "all" ? total : counts[filter];
      const selected = state.filter === filter;
      const label = filter === "all" ? "All" : MODE_LABELS[filter];
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("data-gpt-codex-pinboard-selected", String(selected));
      button.textContent = label + " " + count;
    }

    const visiblePins = sortedPins().filter(
      (pin) => state.filter === "all" || pin.mode === state.filter,
    );
    ui.list.replaceChildren(
      ...(visiblePins.length ? visiblePins.map(renderPinItem) : [renderEmptyState()]),
    );
  }

  async function openDrawer(options = {}) {
    await whenBodyReady();
    ensureUi();

    if (options.filter != null) {
      const filter = String(options.filter).toLowerCase();
      if (!FILTERS.includes(filter)) {
        throw new TypeError('Pinboard filter must be "all", "chat", "work", or "codex".');
      }
      state.filter = filter;
    }

    if (!state.drawerOpen) {
      lastFocusedElement = isElement(document.activeElement) ? document.activeElement : null;
    }
    state.drawerOpen = true;
    ui.backdrop.hidden = false;
    ui.drawer.hidden = false;
    ui.launcher.setAttribute("aria-expanded", "true");
    document.documentElement.setAttribute("data-gpt-codex-pinboard-drawer", "open");
    renderUi();

    queueMicrotask(() => {
      if (state.pendingDeleteKey) {
        focusItemAction(state.pendingDeleteKey, "cancel-delete");
      } else {
        ui.closeButton.focus({ preventScroll: true });
      }
    });
  }

  function closeDrawer(options = {}) {
    if (!ui || !state.drawerOpen) return;
    const restoreFocus = options?.restoreFocus !== false;
    const focusTarget = lastFocusedElement?.isConnected ? lastFocusedElement : ui.launcher;
    state.drawerOpen = false;
    state.pendingDeleteKey = null;
    ui.backdrop.hidden = true;
    ui.drawer.hidden = true;
    ui.launcher.setAttribute("aria-expanded", "false");
    document.documentElement.removeAttribute("data-gpt-codex-pinboard-drawer");
    renderUi();

    lastFocusedElement = null;
    if (restoreFocus) focusTarget.focus({ preventScroll: true });
  }

  function getFocusableElements(container) {
    return [...container.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
        'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  }

  function handleDocumentKeydown(event) {
    if (!state.drawerOpen || !ui) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeDrawer();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = getFocusableElements(ui.drawer);
    if (!focusable.length) {
      event.preventDefault();
      ui.drawer.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function findItemElement(key) {
    if (!ui) return null;
    return [...ui.list.querySelectorAll("[data-gpt-codex-pinboard-item-id]")].find(
      (element) => element.getAttribute("data-gpt-codex-pinboard-item-id") === key,
    );
  }

  function focusElement(element, options = {}) {
    if (
      !isElement(element) ||
      !element.isConnected ||
      typeof element.focus !== "function"
    ) {
      return false;
    }

    const addTemporaryTabIndex =
      options.makeFocusable === true &&
      !element.hasAttribute("tabindex") &&
      Number(element.tabIndex) < 0;
    if (addTemporaryTabIndex) element.setAttribute("tabindex", "-1");
    element.focus({ preventScroll: true });
    const focused = document.activeElement === element;
    if (addTemporaryTabIndex) {
      const removeTemporaryTabIndex = () => {
        if (element.getAttribute("tabindex") === "-1") element.removeAttribute("tabindex");
      };
      if (focused) {
        element.addEventListener("blur", removeTemporaryTabIndex, { once: true });
      } else {
        removeTemporaryTabIndex();
      }
    }
    return focused;
  }

  function findItemActionElement(key, action = null) {
    const item = findItemElement(key);
    if (!item) return null;
    const actions = [...item.querySelectorAll("[data-gpt-codex-pinboard-action]")];
    return action == null
      ? actions.find((candidate) => !candidate.disabled) ?? null
      : actions.find(
          (candidate) =>
            candidate.getAttribute("data-gpt-codex-pinboard-action") === action,
        ) ?? null;
  }

  function focusItemAction(key, action) {
    queueMicrotask(() => {
      focusElement(findItemActionElement(key, action));
    });
  }

  function removalFocusPlan(key) {
    const visibleKeys = sortedPins()
      .filter((pin) => state.filter === "all" || pin.mode === state.filter)
      .map((pin) => pin.key);
    const index = visibleKeys.indexOf(key);
    return Object.freeze({
      nextKey: index >= 0 ? visibleKeys[index + 1] ?? null : null,
      previousKey: index > 0 ? visibleKeys[index - 1] : null,
    });
  }

  function focusAfterRemoval(plan) {
    queueMicrotask(() => {
      if (plan.nextKey && focusElement(findItemActionElement(plan.nextKey))) return;
      if (plan.previousKey && focusElement(findItemActionElement(plan.previousKey))) return;
      focusElement(
        ui?.list.querySelector('[data-gpt-codex-pinboard-empty-heading="true"]'),
        { makeFocusable: true },
      );
    });
  }

  function normalizeRegistrationOptions(options) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Pinboard registration options are required.");
    }

    const mode = normalizeMode(options.mode);
    const id = normalizeId(options.id);
    const conversationId = normalizeSourceId(options.conversationId, "conversationId");
    const turnId = normalizeSourceId(options.turnId, "turnId");
    const messageId = normalizeSourceId(options.messageId, "messageId");
    const role = normalizeRole(options.role ?? "message");
    if (options.getText != null && typeof options.getText !== "function") {
      throw new TypeError("Pinboard getText must be a function when supplied.");
    }
    if (options.jump != null && typeof options.jump !== "function") {
      throw new TypeError("Pinboard jump must be a function when supplied.");
    }
    if (options.controlsRoot != null && !isElement(options.controlsRoot)) {
      throw new TypeError("Pinboard controlsRoot must be an Element when supplied.");
    }

    return {
      complete: options.complete === true,
      conversationId,
      controlsRoot: options.controlsRoot ?? null,
      createdAt: options.createdAt ?? null,
      getText: options.getText ?? null,
      id,
      jump: options.jump ?? null,
      key: makeKey(mode, id),
      label: options.label ?? roleLabel(role) + " message",
      messageId,
      mode,
      role,
      text: options.text,
      turnId,
    };
  }

  function createBookmarkControl(registration) {
    const button = createElement("button", {
      className: "gpt-codex-pinboard-bookmark-control",
      type: "button",
    });
    button.setAttribute("data-gpt-codex-pinboard-control", "bookmark");
    button.setAttribute("data-gpt-codex-pinboard-action", "toggle-bookmark");

    const icon = createElement("span", {
      className: "gpt-codex-pinboard-bookmark-icon",
      text: "☆",
    });
    icon.setAttribute("aria-hidden", "true");
    button.appendChild(icon);
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggleRegistration(registration);
    });
    registration.controlIcon = icon;
    return button;
  }

  function mountRegistrationControl(registration) {
    const root = registration.controlsRoot ?? registration.element;
    if (!registration.control) {
      registration.control = createBookmarkControl(registration);
    }
    if (registration.control.parentElement !== root) root.appendChild(registration.control);
  }

  function updateRegistrationControl(registration) {
    if (!registration.active) return;
    mountRegistrationControl(registration);

    const bookmarked = state.pinsByKey.has(registration.key);
    const busy = state.busyKeys.has(registration.key);
    const complete = registration.complete;
    const available =
      state.storageStatus === "ready" && (complete || bookmarked);
    const stateLabel = busy
      ? "pending"
      : !complete && !bookmarked
        ? "incomplete"
      : !available
        ? "unavailable"
        : bookmarked
          ? "bookmarked"
          : "available";
    const modeLabel = MODE_LABELS[registration.mode];
    const actionLabel =
      !complete && !bookmarked
        ? "Wait for this " + modeLabel + " message to finish before bookmarking"
        : bookmarked
          ? "Remove bookmark from this " + modeLabel + " message"
          : "Bookmark this " + modeLabel + " message";

    registration.control.disabled = busy || !available;
    registration.control.setAttribute("aria-label", actionLabel);
    registration.control.setAttribute("aria-pressed", String(bookmarked));
    registration.control.setAttribute("data-gpt-codex-pinboard-state", stateLabel);
    registration.control.title = actionLabel;
    registration.controlIcon.textContent = bookmarked ? "★" : "☆";
  }

  function updateControlsForKey(key) {
    const registrations = registrationsByKey.get(key);
    if (!registrations) return;
    for (const registration of registrations) updateRegistrationControl(registration);
  }

  function updateAllRegistrationControls() {
    for (const registrations of registrationsByKey.values()) {
      for (const registration of registrations) updateRegistrationControl(registration);
    }
  }

  function readRegistrationText(registration) {
    let value;
    if (typeof registration.getText === "function") {
      value = registration.getText(registration.element);
    } else if (registration.text != null) {
      value = registration.text;
    } else {
      const clone = registration.element.cloneNode(true);
      for (const control of clone.querySelectorAll("[data-gpt-codex-pinboard-control]")) {
        control.remove();
      }
      value = clone.textContent;
    }

    if (value && typeof value.then === "function") {
      throw new TypeError("Pinboard getText must return text synchronously.");
    }

    const text = normalizeText(value);
    if (!text) {
      throw new Error("This message has no text to bookmark.");
    }
    return text;
  }

  function createPinSnapshot(registration, existing = null) {
    const now = new Date().toISOString();
    const text = readRegistrationText(registration);
    return Object.freeze({
      conversationId: registration.conversationId,
      createdAt: normalizeDate(registration.createdAt, null),
      excerpt: makeExcerpt(text),
      id: registration.id,
      key: registration.key,
      label: normalizeLabel(registration.label),
      messageId: registration.messageId,
      mode: registration.mode,
      pinnedAt: existing?.pinnedAt ?? now,
      role: registration.role,
      schemaVersion: 1,
      text,
      turnId: registration.turnId,
      updatedAt: now,
    });
  }

  async function bookmarkRegistration(registration) {
    const storageReady = await ready;
    if (!registration.complete) {
      announce("Wait for the message to finish before bookmarking it.", "error");
      return false;
    }
    if (!storageReady || state.busyKeys.has(registration.key)) {
      if (!storageReady) announce("Pinboard storage is unavailable.", "error");
      return false;
    }

    state.busyKeys.add(registration.key);
    updateControlsForKey(registration.key);

    try {
      const pin = createPinSnapshot(
        registration,
        state.pinsByKey.get(registration.key) ?? null,
      );
      await enqueueMutation(() => putPin(pin));
      state.pinsByKey.set(pin.key, pin);
      announce("Message bookmarked locally.", "success");
      return true;
    } catch (error) {
      state.lastErrorName = error?.name ? String(error.name) : "Error";
      announce(
        error?.message === "This message has no text to bookmark."
          ? error.message
          : "The bookmark could not be saved.",
        "error",
      );
      return false;
    } finally {
      state.busyKeys.delete(registration.key);
      updateControlsForKey(registration.key);
      renderUi();
    }
  }

  function requestDelete(key) {
    const pin = state.pinsByKey.get(key);
    if (!pin) return false;
    state.pendingDeleteKey = key;
    if (state.filter !== "all" && state.filter !== pin.mode) state.filter = pin.mode;
    void openDrawer();
    renderUi();
    focusItemAction(key, "cancel-delete");
    return true;
  }

  async function confirmDelete(key) {
    if (!state.pinsByKey.has(key) || state.busyKeys.has(key)) return false;
    const focusPlan = removalFocusPlan(key);
    const storageReady = await ready;
    if (!storageReady) {
      announce("Pinboard storage is unavailable.", "error");
      focusItemAction(key, "confirm-delete");
      return false;
    }

    let removed = false;
    state.busyKeys.add(key);
    updateControlsForKey(key);
    renderUi();

    try {
      await enqueueMutation(() => deletePin(key));
      state.pinsByKey.delete(key);
      state.pendingDeleteKey = null;
      removed = true;
      announce("Bookmark removed.", "success");
      return true;
    } catch (error) {
      state.lastErrorName = error?.name ? String(error.name) : "Error";
      announce("The bookmark could not be removed.", "error");
      return false;
    } finally {
      state.busyKeys.delete(key);
      updateControlsForKey(key);
      renderUi();
      if (removed) focusAfterRemoval(focusPlan);
      else focusItemAction(key, "confirm-delete");
    }
  }

  async function toggleRegistration(registration) {
    if (state.pinsByKey.has(registration.key)) {
      return requestDelete(registration.key);
    }
    return bookmarkRegistration(registration);
  }

  function syncRegistrationAttributes(registration) {
    const { element } = registration;
    element.setAttribute("data-gpt-codex-pinboard-message", "registered");
    element.setAttribute(
      "data-gpt-codex-pinboard-message-id",
      registration.messageId || registration.id,
    );
    for (const [attribute, value] of [
      ["data-gpt-codex-pinboard-conversation-id", registration.conversationId],
      ["data-gpt-codex-pinboard-turn-id", registration.turnId],
    ]) {
      if (value) element.setAttribute(attribute, value);
      else element.removeAttribute(attribute);
    }
    element.setAttribute("data-gpt-codex-pinboard-role", registration.role);
    element.setAttribute(
      "data-gpt-codex-pinboard-complete",
      String(registration.complete),
    );
    element.setAttribute("data-gpt-codex-pinboard-mode", registration.mode);
  }

  async function refreshRegistration(registration, patch = {}) {
    if (!registration.active) return false;
    if (patch == null || typeof patch !== "object") {
      throw new TypeError("Pinboard registration refresh patch must be an object.");
    }

    if (Object.prototype.hasOwnProperty.call(patch, "getText")) {
      if (patch.getText != null && typeof patch.getText !== "function") {
        throw new TypeError("Pinboard getText must be a function when supplied.");
      }
      registration.getText = patch.getText ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "jump")) {
      if (patch.jump != null && typeof patch.jump !== "function") {
        throw new TypeError("Pinboard jump must be a function when supplied.");
      }
      registration.jump = patch.jump ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "controlsRoot")) {
      if (patch.controlsRoot != null && !isElement(patch.controlsRoot)) {
        throw new TypeError("Pinboard controlsRoot must be an Element when supplied.");
      }
      registration.controlsRoot = patch.controlsRoot ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "createdAt")) {
      registration.createdAt = patch.createdAt;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "complete")) {
      registration.complete = patch.complete === true;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "label")) {
      registration.label = patch.label;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "text")) {
      registration.text = patch.text;
    }

    for (const [property, label] of [
      ["conversationId", "conversationId"],
      ["messageId", "messageId"],
      ["turnId", "turnId"],
    ]) {
      if (Object.prototype.hasOwnProperty.call(patch, property)) {
        registration[property] = normalizeSourceId(patch[property], label);
      }
    }

    syncRegistrationAttributes(registration);
    mountRegistrationControl(registration);
    updateRegistrationControl(registration);

    const existing = state.pinsByKey.get(registration.key);
    if (!existing) {
      return true;
    }
    if (!registration.complete) {
      return true;
    }

    const storageReady = await ready;
    if (!storageReady || state.busyKeys.has(registration.key)) return false;
    state.busyKeys.add(registration.key);
    updateControlsForKey(registration.key);

    try {
      const pin = createPinSnapshot(registration, existing);
      await enqueueMutation(() => putPin(pin));
      state.pinsByKey.set(pin.key, pin);
      return true;
    } catch (error) {
      state.lastErrorName = error?.name ? String(error.name) : "Error";
      announce("The saved bookmark could not be refreshed.", "error");
      return false;
    } finally {
      state.busyKeys.delete(registration.key);
      updateControlsForKey(registration.key);
      renderUi();
    }
  }

  function unregisterRegistration(registration) {
    if (!registration.active) return;
    registration.active = false;
    registration.control?.remove();

    if (registrationsByElement.get(registration.element) === registration) {
      registrationsByElement.delete(registration.element);
      registration.element.removeAttribute("data-gpt-codex-pinboard-message");
      registration.element.removeAttribute("data-gpt-codex-pinboard-message-id");
      registration.element.removeAttribute("data-gpt-codex-pinboard-conversation-id");
      registration.element.removeAttribute("data-gpt-codex-pinboard-turn-id");
      registration.element.removeAttribute("data-gpt-codex-pinboard-role");
      registration.element.removeAttribute("data-gpt-codex-pinboard-complete");
      registration.element.removeAttribute("data-gpt-codex-pinboard-mode");
    }

    const registrations = registrationsByKey.get(registration.key);
    registrations?.delete(registration);
    if (registrations?.size === 0) registrationsByKey.delete(registration.key);
  }

  function registerMessage(element, options) {
    if (!isElement(element)) {
      throw new TypeError("Pinboard registerMessage requires a message Element.");
    }

    const descriptor = normalizeRegistrationOptions(options);
    const previous = registrationsByElement.get(element);
    if (previous) unregisterRegistration(previous);

    const registration = {
      active: true,
      complete: descriptor.complete,
      conversationId: descriptor.conversationId,
      control: null,
      controlIcon: null,
      controlsRoot: descriptor.controlsRoot,
      createdAt: descriptor.createdAt,
      element,
      getText: descriptor.getText,
      id: descriptor.id,
      jump: descriptor.jump,
      key: descriptor.key,
      label: descriptor.label,
      messageId: descriptor.messageId,
      mode: descriptor.mode,
      role: descriptor.role,
      sequence: ++registrationSequence,
      text: descriptor.text,
      turnId: descriptor.turnId,
    };

    registrationsByElement.set(element, registration);
    if (!registrationsByKey.has(registration.key)) {
      registrationsByKey.set(registration.key, new Set());
    }
    registrationsByKey.get(registration.key).add(registration);

    syncRegistrationAttributes(registration);
    mountRegistrationControl(registration);
    updateRegistrationControl(registration);

    return Object.freeze({
      bookmark: () => bookmarkRegistration(registration),
      ensureControl: () => {
        if (!registration.active) return false;
        mountRegistrationControl(registration);
        updateRegistrationControl(registration);
        return true;
      },
      id: registration.id,
      isActive: () => registration.active,
      isBookmarked: () => state.pinsByKey.has(registration.key),
      key: registration.key,
      mode: registration.mode,
      refresh: (patch) => refreshRegistration(registration, patch),
      requestUnbookmark: () => requestDelete(registration.key),
      toggle: () => toggleRegistration(registration),
      unregister: () => unregisterRegistration(registration),
    });
  }

  function normalizeBridgePayload(payload) {
    if (!payload || typeof payload !== "object") {
      throw new TypeError("Pinnable message payload must be an object.");
    }

    const mode = normalizeMode(payload.mode);
    const role = normalizeRole(payload.role);
    const conversationId = normalizeSourceId(
      payload.conversationId,
      "conversationId",
    );
    const turnId = normalizeSourceId(payload.turnId, "turnId");
    const messageId = normalizeSourceId(payload.messageId, "messageId");
    const stableId = normalizeSourceId(
      payload.stableId ?? payload.recordId,
      "stableId",
    );
    if (!stableId && !turnId && !messageId) {
      throw new TypeError("Pinnable message payload requires stableId, turnId, or messageId.");
    }
    if (payload.element != null && !isElement(payload.element)) {
      throw new TypeError("Pinnable message element must be an Element when supplied.");
    }
    if (payload.controlsRoot != null && !isElement(payload.controlsRoot)) {
      throw new TypeError("Pinnable message controlsRoot must be an Element when supplied.");
    }
    if (payload.jump != null && typeof payload.jump !== "function") {
      throw new TypeError("Pinnable message jump must be a function when supplied.");
    }

    const source = {
      complete: payload.complete === true,
      conversationId,
      controlsRoot: payload.controlsRoot ?? null,
      element: payload.element ?? null,
      jump: payload.jump ?? null,
      messageId,
      mode,
      role,
      stableId,
      text: normalizeText(payload.text),
      turnId,
    };
    source.id = makeBridgeMessageId(source);
    source.key = makeKey(source.mode, source.id);
    return Object.freeze(source);
  }

  function possibleIdentifierValues(identifier, role) {
    if (!identifier) return [];
    return [
      identifier,
      role + ":" + identifier,
      "user:" + identifier,
      "assistant:" + identifier,
      "message:" + identifier,
      "turn:" + identifier,
      identifier + ":message",
      identifier + "/message",
      role + ":" + identifier + ":message",
      role + ":" + identifier + "/message",
    ];
  }

  function elementsWithAttribute(root, attribute) {
    const elements = [];
    if (isElement(root) && root.hasAttribute(attribute)) elements.push(root);
    elements.push(...root.querySelectorAll("[" + attribute + "]"));
    return elements;
  }

  function findExactAttribute(root, attributes, values) {
    const wanted = new Set(values.filter(Boolean).map(String));
    if (!wanted.size) return null;

    for (const attribute of attributes) {
      for (const element of elementsWithAttribute(root, attribute)) {
        if (wanted.has(element.getAttribute(attribute))) return element;
      }
    }
    return null;
  }

  function serializedAttributeContainsId(value, identifier) {
    if (!value || !identifier) return false;
    if (value === identifier) return true;
    if (
      value.endsWith(":" + identifier) ||
      value.endsWith("/" + identifier) ||
      value.includes(":" + identifier + ":") ||
      value.includes(":" + identifier + "/") ||
      value.includes("/" + identifier + "/")
    ) {
      return true;
    }
    return value
      .split(/[\s,;[\]"']+/)
      .filter(Boolean)
      .includes(identifier);
  }

  function findLooseMessageAttribute(root, source) {
    const identifiers = [source.messageId, source.turnId].filter(Boolean);
    for (const attribute of ASSOCIATION_ATTRIBUTES.message) {
      for (const element of elementsWithAttribute(root, attribute)) {
        const value = element.getAttribute(attribute);
        if (
          identifiers.some((identifier) =>
            serializedAttributeContainsId(value, identifier),
          )
        ) {
          return element;
        }
      }
    }
    return null;
  }

  function findElementById(root, source) {
    const identifiers = [source.messageId, source.turnId].filter(Boolean);
    for (const identifier of identifiers) {
      const possibleIds = [
        identifier,
        source.role + "-" + identifier,
        "message-" + identifier,
        "turn-" + identifier,
      ];
      for (const id of possibleIds) {
        const element = document.getElementById(id);
        if (element && (root === document || root.contains(element))) return element;
      }
    }
    return null;
  }

  function findRoleContainer(root, role) {
    const roleAttributes = [
      "data-message-author-role",
      "data-message-role",
      "data-author",
      "data-role",
    ];
    const exact = findExactAttribute(root, roleAttributes, [role]);
    if (exact) return exact;

    if (role === "user") {
      return (
        root.querySelector("[data-user-message-bubble]") ??
        root.querySelector("[data-local-conversation-user-anchor]")
      );
    }
    if (role === "assistant") {
      return root.querySelector("[data-local-conversation-final-assistant]");
    }
    return null;
  }

  function textWithoutPinboardControls(element) {
    const clone = element.cloneNode(true);
    for (const control of clone.querySelectorAll(
      "[data-gpt-codex-pinboard-control], [data-gpt-codex-pinboard-drawer]",
    )) {
      control.remove();
    }
    return normalizeText(clone.textContent);
  }

  function roleMatchScore(element, role) {
    const roleAttributes = [
      "data-message-author-role",
      "data-message-role",
      "data-author",
      "data-role",
    ];
    if (roleAttributes.some((attribute) => element.getAttribute(attribute) === role)) {
      return 240;
    }
    if (
      role === "user" &&
      (element.hasAttribute("data-user-message-bubble") ||
        element.hasAttribute("data-local-conversation-user-anchor"))
    ) {
      return 220;
    }
    if (
      role === "assistant" &&
      element.hasAttribute("data-local-conversation-final-assistant")
    ) {
      return 220;
    }
    return 0;
  }

  function findByText(root, source) {
    const targetText = normalizeText(source.text);
    if (targetText.length < 12) return null;

    const selector = [
      "[data-message-author-role]",
      "[data-message-role]",
      "[data-user-message-bubble]",
      "[data-local-conversation-user-anchor]",
      "[data-local-conversation-final-assistant]",
      '[data-chatgpt-conversation-turn="true"]',
      "[data-content-search-turn-key]",
      "[data-content-search-assistant-turn-key]",
      "[data-content-search-unit-key]",
      "article",
    ].join(",");
    const candidates = new Set(root.querySelectorAll(selector));
    if (isElement(root) && root.matches(selector)) candidates.add(root);

    let best = null;
    let bestScore = -1;
    let bestLength = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (
        candidate.closest("[data-gpt-codex-pinboard-drawer]") ||
        candidate.hasAttribute("data-gpt-codex-pinboard-control")
      ) {
        continue;
      }

      const candidateText = textWithoutPinboardControls(candidate);
      if (!candidateText) continue;

      let score = roleMatchScore(candidate, source.role);
      if (candidateText === targetText) {
        score += 1_000;
      } else if (
        candidateText.startsWith(targetText) ||
        candidateText.endsWith(targetText)
      ) {
        score += 760;
      } else if (candidateText.includes(targetText) && targetText.length >= 20) {
        score += 620;
      } else if (
        !source.complete &&
        targetText.includes(candidateText) &&
        candidateText.length >= 20
      ) {
        score += 480;
      } else {
        continue;
      }

      if (
        score > bestScore ||
        (score === bestScore && candidateText.length < bestLength)
      ) {
        best = candidate;
        bestScore = score;
        bestLength = candidateText.length;
      }
    }
    return best;
  }

  function findMessageElement(source) {
    if (source.element?.isConnected) return source.element;

    const conversationRoot =
      findExactAttribute(
        document,
        ASSOCIATION_ATTRIBUTES.conversation,
        possibleIdentifierValues(source.conversationId, source.role),
      ) ?? document;
    const scopes =
      conversationRoot === document ? [document] : [conversationRoot, document];

    const messageValues = [
      ...possibleIdentifierValues(source.messageId, source.role),
      ...possibleIdentifierValues(source.turnId, source.role),
    ];
    const turnValues = [
      ...possibleIdentifierValues(source.turnId, source.role),
      ...possibleIdentifierValues(source.messageId, source.role),
    ];
    const testIdValues = [
      source.turnId,
      source.messageId,
      source.turnId ? "conversation-turn-" + source.turnId : "",
      source.messageId ? "conversation-turn-" + source.messageId : "",
      source.turnId ? "turn-" + source.turnId : "",
      source.messageId ? "message-" + source.messageId : "",
    ].filter(Boolean);

    for (const scope of scopes) {
      const exactMessage =
        findElementById(scope, source) ??
        findExactAttribute(scope, ASSOCIATION_ATTRIBUTES.message, messageValues) ??
        findLooseMessageAttribute(scope, source);
      if (exactMessage) return exactMessage;

      const turn =
        findExactAttribute(scope, ASSOCIATION_ATTRIBUTES.turn, turnValues) ??
        findExactAttribute(scope, ["data-testid"], testIdValues);
      if (turn) {
        return (
          findByText(turn, source) ??
          findRoleContainer(turn, source.role) ??
          turn
        );
      }

      const textMatch = findByText(scope, source);
      if (textMatch) return textMatch;
    }
    return null;
  }

  function associateBridgeEntry(entry, element) {
    if (!isElement(element) || !element.isConnected) return false;

    if (
      entry.element === element &&
      entry.registration?.isActive()
    ) {
      if (entry.needsRefresh) {
        entry.needsRefresh = false;
        void entry.registration.refresh({
          complete: entry.source.complete,
          conversationId: entry.source.conversationId,
          controlsRoot: entry.source.controlsRoot,
          jump: entry.source.jump,
          messageId: entry.source.messageId,
          text: entry.source.text,
          turnId: entry.source.turnId,
        });
      }
      entry.registration.ensureControl();
      pendingAssociationKeys.delete(entry.key);
      entry.attempts = 0;
      return true;
    }

    entry.registration?.unregister();
    entry.element = element;
    entry.registration = registerMessage(element, {
      complete: entry.source.complete,
      conversationId: entry.source.conversationId,
      controlsRoot: entry.source.controlsRoot,
      id: entry.source.id,
      jump: entry.source.jump,
      label: roleLabel(entry.source.role) + " message",
      messageId: entry.source.messageId,
      mode: entry.source.mode,
      role: entry.source.role,
      text: entry.source.text,
      turnId: entry.source.turnId,
    });
    entry.needsRefresh = false;
    pendingAssociationKeys.delete(entry.key);
    entry.attempts = 0;
    return true;
  }

  function reconcilePendingAssociations() {
    associationRenderTimer = 0;
    if (!pendingAssociationKeys.size) return;

    for (const key of [...pendingAssociationKeys]) {
      const entry = bridgeEntriesByKey.get(key);
      if (!entry) {
        pendingAssociationKeys.delete(key);
        continue;
      }
      if (
        entry.element?.isConnected &&
        entry.registration?.isActive()
      ) {
        entry.registration.ensureControl();
        pendingAssociationKeys.delete(key);
        entry.attempts = 0;
        continue;
      }

      entry.registration?.unregister();
      entry.registration = null;
      entry.element = null;
      const element = findMessageElement(entry.source);
      if (!associateBridgeEntry(entry, element)) entry.attempts += 1;
    }

    if (
      pendingAssociationKeys.size &&
      [...pendingAssociationKeys].some(
        (key) => (bridgeEntriesByKey.get(key)?.attempts ?? 0) < 8,
      ) &&
      !associationRetryTimer
    ) {
      associationRetryTimer = window.setTimeout(() => {
        associationRetryTimer = 0;
        scheduleAssociationReconcile();
      }, 500);
    }
  }

  function scheduleAssociationReconcile() {
    if (!pendingAssociationKeys.size || associationRenderTimer) return;
    associationRenderTimer = window.requestAnimationFrame(
      reconcilePendingAssociations,
    );
  }

  function ensureAssociationObserver() {
    if (associationObserver) return;
    void whenBodyReady().then(() => {
      if (associationObserver) return;
      const attributeFilter = [
        ...ASSOCIATION_ATTRIBUTES.conversation,
        ...ASSOCIATION_ATTRIBUTES.message,
        ...ASSOCIATION_ATTRIBUTES.turn,
        "data-testid",
        "data-message-author-role",
        "data-message-role",
        "data-author",
        "data-role",
        "data-user-message-bubble",
        "data-local-conversation-user-anchor",
        "data-local-conversation-final-assistant",
        "id",
      ];
      const pinboardMutation = (mutation) => {
        const target =
          mutation.target instanceof Element
            ? mutation.target
            : mutation.target.parentElement;
        if (
          target?.closest(
            "#gpt-codex-pinboard-launcher, #gpt-codex-pinboard-drawer, " +
              '[data-gpt-codex-pinboard-control]',
          )
        ) {
          return false;
        }

        const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
        if (changedNodes.length === 0) return true;
        return !changedNodes.every((node) => {
          const element =
            node instanceof Element
              ? node
              : node.parentElement;
          return Boolean(
            element?.matches?.('[data-gpt-codex-pinboard-control]') ||
              element?.closest?.(
                "#gpt-codex-pinboard-launcher, #gpt-codex-pinboard-drawer, " +
                  '[data-gpt-codex-pinboard-control]',
              ),
          );
        });
      };
      associationObserver = new MutationObserver((mutations) => {
        if (!mutations.some(pinboardMutation)) return;
        for (const entry of bridgeEntriesByKey.values()) {
          if (
            entry.element?.isConnected &&
            entry.registration?.isActive()
          ) {
            entry.registration.ensureControl();
          } else {
            pendingAssociationKeys.add(entry.key);
          }
        }
        scheduleAssociationReconcile();
      });
      associationObserver.observe(document.body, {
        attributeFilter: [...new Set(attributeFilter)],
        attributes: true,
        childList: true,
        subtree: true,
      });
      scheduleAssociationReconcile();
    });
  }

  function unregisterBridgeEntry(entry) {
    if (bridgeEntriesByKey.get(entry.key) !== entry) return;
    entry.registration?.unregister();
    bridgeEntriesByKey.delete(entry.key);
    pendingAssociationKeys.delete(entry.key);
  }

  function createBridgeHandle(entry) {
    return Object.freeze({
      isAssociated: () =>
        Boolean(
          entry.element?.isConnected &&
            entry.registration?.isActive(),
        ),
      key: entry.key,
      unregister: () => unregisterBridgeEntry(entry),
    });
  }

  function bridgeSourceChanged(previous, next) {
    return (
      previous.complete !== next.complete ||
      previous.conversationId !== next.conversationId ||
      previous.controlsRoot !== next.controlsRoot ||
      previous.element !== next.element ||
      previous.jump !== next.jump ||
      previous.messageId !== next.messageId ||
      previous.stableId !== next.stableId ||
      previous.turnId !== next.turnId ||
      previous.text !== next.text
    );
  }

  function registerPinnableMessage(payload) {
    const source = normalizeBridgePayload(payload);
    let entry = bridgeEntriesByKey.get(source.key);

    if (!entry) {
      entry = {
        attempts: 0,
        element: null,
        handle: null,
        key: source.key,
        needsRefresh: true,
        registration: null,
        source,
      };
      entry.handle = createBridgeHandle(entry);
      bridgeEntriesByKey.set(entry.key, entry);
    } else {
      entry.needsRefresh ||= bridgeSourceChanged(entry.source, source);
      entry.source = source;
      entry.attempts = 0;
    }

    ensureAssociationObserver();
    const immediateElement =
      source.element?.isConnected
        ? source.element
        : entry.element?.isConnected
          ? entry.element
          : findMessageElement(source);

    if (!associateBridgeEntry(entry, immediateElement)) {
      pendingAssociationKeys.add(entry.key);
      scheduleAssociationReconcile();
    }
    return entry.handle;
  }

  async function copyTextToClipboard(text) {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return;
    }

    const textarea = createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.position = "fixed";
    textarea.style.inset = "-9999px auto auto -9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new DOMException("Clipboard copy was rejected.", "NotAllowedError");
  }

  async function copyPinnedMessage(pin) {
    try {
      await copyTextToClipboard(pin.text);
      announce("Pinned message copied.", "success");
    } catch (error) {
      state.lastErrorName = error?.name ? String(error.name) : "Error";
      announce("The pinned message could not be copied.", "error");
    }
  }

  function resolveJumpDestination(callbackResult, registration) {
    const returnedElement = isElement(callbackResult)
      ? callbackResult
      : isElement(callbackResult?.element)
        ? callbackResult.element
        : null;
    if (returnedElement?.isConnected) {
      return Object.freeze({ element: returnedElement, scroll: true });
    }

    const activeElement = document.activeElement;
    if (
      isElement(activeElement) &&
      activeElement.isConnected &&
      activeElement !== document.body &&
      activeElement !== document.documentElement &&
      activeElement !== ui?.launcher &&
      !ui?.drawer.contains(activeElement)
    ) {
      return Object.freeze({ element: activeElement, scroll: false });
    }

    return Object.freeze({ element: registration.element, scroll: true });
  }

  function focusJumpDestination(destination) {
    const { element, scroll } = destination;
    if (!isElement(element) || !element.isConnected) return false;
    if (scroll && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({
        behavior:
          document.documentElement.dataset.gptCodexMotion === "reduced" ? "auto" : "smooth",
        block: "center",
      });
    }
    return focusElement(element, { makeFocusable: true });
  }

  async function jumpToPinnedMessage(pin) {
    const registration =
      findLiveRegistration(pin.key, true) ?? findLiveRegistration(pin.key);
    if (!registration) {
      announce("This message is not currently mounted.", "error");
      renderUi();
      return false;
    }

    const drawerFilter = state.filter;
    const drawerOpener = lastFocusedElement;
    closeDrawer({ restoreFocus: false });

    try {
      let callbackResult = null;
      if (typeof registration.jump === "function") {
        callbackResult = await registration.jump(
          Object.freeze({
            element: registration.element,
            id: pin.id,
            key: pin.key,
            mode: pin.mode,
          }),
        );
      }
      const destination = resolveJumpDestination(callbackResult, registration);
      if (!focusJumpDestination(destination)) {
        throw new DOMException("The jump destination could not be focused.", "InvalidStateError");
      }
      return true;
    } catch (error) {
      state.lastErrorName = error?.name ? String(error.name) : "Error";
      announce("The message could not be opened.", "error");
      try {
        await openDrawer({ filter: drawerFilter });
        lastFocusedElement = drawerOpener?.isConnected ? drawerOpener : null;
        focusItemAction(pin.key, "jump");
      } catch {
        // The original jump error remains the actionable failure.
      }
      return false;
    }
  }

  function isBookmarked(mode, id) {
    return state.pinsByKey.has(makeKey(normalizeMode(mode), normalizeId(id)));
  }

  function diagnosticProbe() {
    const counts = modeCounts();
    const bridgeEntries = [...bridgeEntriesByKey.values()];
    const modelPickerOpen =
      document.documentElement.getAttribute("data-gpt-codex-model-picker-open") ===
      "true";
    const launcherStyle =
      ui?.launcher && typeof globalThis.getComputedStyle === "function"
        ? globalThis.getComputedStyle(ui.launcher)
        : null;
    return Object.freeze({
      bridgeMessages: Object.freeze({
        associated: bridgeEntries.filter(
          (entry) =>
            entry.element?.isConnected &&
            entry.registration?.isActive(),
        ).length,
        complete: bridgeEntries.filter((entry) => entry.source.complete).length,
        pending: pendingAssociationKeys.size,
        total: bridgeEntries.length,
      }),
      database: Object.freeze({
        name: DATABASE_NAME,
        store: STORE_NAME,
        version: DATABASE_VERSION,
      }),
      drawer: Object.freeze({
        filter: state.filter,
        open: state.drawerOpen,
        pendingDeletion: Boolean(state.pendingDeleteKey),
      }),
      lastErrorName: state.lastErrorName,
      launcher: Object.freeze({
        accessible: Boolean(
          ui?.launcher.getAttribute("aria-label") && ui?.launcher.getAttribute("title"),
        ),
        compact: ui?.launcher.getAttribute("data-gpt-codex-pinboard-count") === "0",
        modelPickerOpen,
        pointerSuppressed: modelPickerOpen && launcherStyle?.pointerEvents === "none",
      }),
      localOnly: true,
      pins: Object.freeze({
        chat: counts.chat,
        codex: counts.codex,
        total: state.pinsByKey.size,
        work: counts.work,
      }),
      ready: state.storageStatus === "ready",
      registeredMessages: [...registrationsByKey.values()].reduce(
        (total, registrations) => total + registrations.size,
        0,
      ),
      storage: state.storageStatus,
      transports: Object.freeze({
        diagnosticsIpc: false,
        network: false,
      }),
      version: VERSION,
    });
  }

  async function pinboardContractSelfTest() {
    const originalFilter = state.filter;
    const originalPendingDeleteKey = state.pendingDeleteKey;
    const fixture = document.createElement("article");
    const stableId = `self-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fixture.textContent = "Temporary local pinboard verification message.";
    fixture.style.position = "fixed";
    fixture.style.left = "-10000px";
    fixture.style.top = "0";
    document.body.appendChild(fixture);

    let bridgeHandle = null;
    let key = null;
    const result = {
      bookmarkPersistenceWorks: false,
      cleanupWorks: false,
      deleteConfirmationWorks: false,
      deleteFocusWorks: false,
      jumpClosesBeforeCallbackWorks: false,
      jumpFocusWorks: false,
      jumpWorks: false,
      modeFilterWorks: false,
      pass: false,
      registrationWorks: false,
      storageReady: false,
    };

    try {
      result.storageReady = (await ready) === true && state.storageStatus === "ready";
      if (!result.storageReady) return Object.freeze({ ...result, version: VERSION });

      let jumped = false;
      let drawerClosedBeforeJump = false;
      bridgeHandle = registerPinnableMessage({
        complete: true,
        conversationId: "pinboard-self-test",
        element: fixture,
        jump: () => {
          jumped = true;
          drawerClosedBeforeJump = state.drawerOpen === false && ui?.drawer.hidden === true;
          return fixture;
        },
        mode: "chat",
        role: "assistant",
        stableId,
        text: fixture.textContent,
        turnId: stableId,
      });
      key = bridgeHandle.key;
      const entry = bridgeEntriesByKey.get(key);
      result.registrationWorks = Boolean(
        bridgeHandle.isAssociated() &&
          entry?.registration?.isActive() &&
          fixture.querySelector('[data-gpt-codex-pinboard-control="bookmark"]'),
      );

      const bookmarkResult = await entry.registration.bookmark();
      const storedAfterBookmark = await getAllPins(state.database);
      result.bookmarkPersistenceWorks =
        bookmarkResult === true &&
        state.pinsByKey.has(key) &&
        storedAfterBookmark.some((pin) => pin.key === key);

      state.filter = "codex";
      renderUi();
      const hiddenByOtherMode = !findItemElement(key);
      state.filter = "chat";
      renderUi();
      const visibleInOwnMode = Boolean(findItemElement(key));
      result.modeFilterWorks = hiddenByOtherMode && visibleInOwnMode;

      await openDrawer({ filter: "chat" });
      const pin = state.pinsByKey.get(key);
      const jumpResult = await jumpToPinnedMessage(pin);
      result.jumpWorks = jumpResult === true && jumped && state.drawerOpen === false;
      result.jumpClosesBeforeCallbackWorks = drawerClosedBeforeJump;
      result.jumpFocusWorks = document.activeElement === fixture;

      const deleteRequested = requestDelete(key);
      const confirmationVisible = Boolean(
        findItemElement(key)?.querySelector(
          '[data-gpt-codex-pinboard-confirmation="delete"]',
        ),
      );
      const deleteResult = await confirmDelete(key);
      await Promise.resolve();
      const storedAfterDelete = await getAllPins(state.database);
      result.deleteConfirmationWorks =
        deleteRequested &&
        confirmationVisible &&
        deleteResult === true &&
        !state.pinsByKey.has(key) &&
        !storedAfterDelete.some((pin) => pin.key === key);
      result.deleteFocusWorks = Boolean(
        document.activeElement?.hasAttribute?.("data-gpt-codex-pinboard-action") ||
          document.activeElement?.getAttribute?.(
            "data-gpt-codex-pinboard-empty-heading",
          ) === "true",
      );
      result.cleanupWorks = !state.pinsByKey.has(key);
      result.pass = Object.entries(result)
        .filter(([name]) => name !== "pass")
        .every(([, value]) => value === true);
      return Object.freeze({ ...result, version: VERSION });
    } catch (error) {
      return Object.freeze({
        ...result,
        error: String(error?.message ?? error).slice(0, 300),
        pass: false,
        version: VERSION,
      });
    } finally {
      if (key && state.pinsByKey.has(key) && state.database) {
        try {
          await enqueueMutation(() => deletePin(key));
        } catch {
          // The returned cleanup flag reports the failed cleanup.
        }
        state.pinsByKey.delete(key);
      }
      bridgeHandle?.unregister();
      fixture.remove();
      state.filter = originalFilter;
      state.pendingDeleteKey = originalPendingDeleteKey;
      closeDrawer();
      renderUi();
    }
  }

  async function initialize() {
    try {
      const uiReady = whenBodyReady().then(() => {
        ensureUi();
        renderUi();
      });
      const storageReady = await initializeStorage();
      await uiReady;
      updateAllRegistrationControls();
      renderUi();
      return storageReady;
    } catch (error) {
      setStorageStatus("error", error);
      return false;
    }
  }

  const ready = initialize();

  Object.defineProperty(globalThis, REGISTER_NAME, {
    configurable: false,
    enumerable: true,
    value: registerPinnableMessage,
    writable: false,
  });

  Object.defineProperty(globalThis, PROBE_NAME, {
    configurable: false,
    enumerable: false,
    value: diagnosticProbe,
    writable: false,
  });

  Object.defineProperty(globalThis, "GPT_CODEX_CUSTOM_PINBOARD_SELF_TEST", {
    configurable: false,
    enumerable: false,
    value: pinboardContractSelfTest,
    writable: false,
  });
})();
