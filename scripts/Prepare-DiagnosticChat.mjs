import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const activePortPath = path.join(projectRoot, "profile", "chromium", "DevToolsActivePort");
const expectedTargetUrl = "app://-/index.html";
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const [portLine] = fs.readFileSync(activePortPath, "utf8").trim().split(/\r?\n/u);
const port = Number(portLine);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid isolated DevTools port in ${activePortPath}.`);
}

const targetDeadline = Date.now() + 30_000;
let matches = [];
let lastDiscoveryError = null;
while (Date.now() < targetDeadline) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json`, { cache: "no-store" }).then(
      (response) => {
        if (!response.ok) {
          throw new Error(`DevTools target discovery failed: ${response.status}.`);
        }
        return response.json();
      },
    );
    matches = targets.filter(
      (target) => target.type === "page" && target.url === expectedTargetUrl,
    );
    if (matches.length === 1 && matches[0].webSocketDebuggerUrl) break;
    lastDiscoveryError = null;
  } catch (error) {
    lastDiscoveryError = error;
  }
  await delay(200);
}
if (matches.length !== 1 || !matches[0].webSocketDebuggerUrl) {
  const detail = lastDiscoveryError instanceof Error ? ` ${lastDiscoveryError.message}` : "";
  throw new Error(`Expected one exact custom renderer target; found ${matches.length}.${detail}`);
}

const socket = new WebSocket(matches[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("Timed out connecting to the custom renderer.")),
    10_000,
  );
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
      reject(new Error("Could not connect to the custom renderer."));
    },
    { once: true },
  );
});

const expression = `(async () => {
  const storageKey = "gpt-codex-custom.product-mode";
  const storedModeBefore = localStorage.getItem(storageKey);
  const deadline = performance.now() + 20000;
  const delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  let openChat = globalThis.GPT_CODEX_CUSTOM_OPEN_CHAT;
  while (typeof openChat !== "function" && performance.now() < deadline) {
    await delay(50);
    openChat = globalThis.GPT_CODEX_CUSTOM_OPEN_CHAT;
  }
  if (typeof openChat !== "function") {
    return { ready: false, reason: "open-chat-bridge-unavailable", storedModeBefore };
  }
  openChat({ persist: false });
  const isReady = () => {
    const sidebar = document.getElementById("gpt-codex-custom-chat-sidebar");
    const surface = document.querySelector('[data-pip-obstacle="quick-chat"]');
    const selector = document.querySelector('[data-gpt-codex-custom-product-selector="true"]');
    return (
      document.documentElement.getAttribute("data-gpt-codex-custom-mode") === "chat" &&
      sidebar?.hidden === false &&
      Boolean(surface) &&
      Boolean(selector)
    );
  };
  while (!isReady() && performance.now() < deadline) await delay(50);
  const storedModeAfter = localStorage.getItem(storageKey);
  return {
    ready: isReady(),
    storedModeBefore,
    storedModeAfter,
    storedModeUnchanged: storedModeAfter === storedModeBefore,
  };
})()`;

const requestId = 1;
const responsePromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Chat-mode preparation timed out.")), 25_000);
  const handleMessage = (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id !== requestId) return;
    clearTimeout(timer);
    socket.removeEventListener("message", handleMessage);
    resolve(message);
  };
  socket.addEventListener("message", handleMessage);
});

socket.send(
  JSON.stringify({
    id: requestId,
    method: "Runtime.evaluate",
    params: {
      awaitPromise: true,
      expression,
      returnByValue: true,
      silent: true,
      userGesture: false,
    },
  }),
);

let response;
try {
  response = await responsePromise;
} finally {
  socket.close();
}

if (response.error) {
  throw new Error(`Renderer rejected Chat-mode preparation: ${response.error.message}`);
}
if (response.result?.exceptionDetails) {
  throw new Error(
    `Chat-mode preparation threw in the renderer: ${response.result.exceptionDetails.text}`,
  );
}

const outcome = response.result?.result?.value;
if (!outcome?.ready || outcome.storedModeUnchanged !== true) {
  throw new Error(`Chat-mode preparation failed: ${JSON.stringify(outcome)}`);
}

console.log(JSON.stringify({ target: expectedTargetUrl, ...outcome }, null, 2));
