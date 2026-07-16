import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const activePortPath = path.join(
  projectRoot,
  "profile",
  "chromium",
  "DevToolsActivePort",
);
const outputPath = path.resolve(
  process.argv[2] ?? path.join(projectRoot, "work", "verification", "custom-ui-final.png"),
);

const [portLine] = fs.readFileSync(activePortPath, "utf8").trim().split(/\r?\n/);
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
  socket.addEventListener("open", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
  socket.addEventListener("error", () => {
    clearTimeout(timer);
    reject(new Error("Could not connect to the renderer."));
  }, { once: true });
});

const requestId = 1;
const screenshot = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Screenshot capture timed out.")), 15_000);
  const onMessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== requestId) return;
    clearTimeout(timer);
    socket.removeEventListener("message", onMessage);
    if (message.error) reject(new Error(message.error.message ?? "Screenshot capture failed."));
    else resolve(message.result);
  };
  socket.addEventListener("message", onMessage);
  socket.send(JSON.stringify({
    id: requestId,
    method: "Page.captureScreenshot",
    params: { captureBeyondViewport: false, format: "png", fromSurface: true },
  }));
});

socket.close();
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, Buffer.from(screenshot.data, "base64"));
console.log(outputPath);
