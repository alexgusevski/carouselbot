import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url);
const webPort = 49000 + Math.floor(Math.random() * 500);
const canonicalPort = webPort + 500;
const debuggingPort = 19500 + Math.floor(Math.random() * 400);
const legacyOrigin = `http://127.0.0.1:${webPort}`;
const canonicalOrigin = `http://127.0.0.1:${canonicalPort}`;
const legacyUrl = `${legacyOrigin}/?__carouselbotMigrationPreview=legacy&__carouselbotCanonicalPort=${canonicalPort}`;
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = await mkdtemp(join(tmpdir(), "carouselbot-migration-browser-"));
let diagnostics = "";

const legacyWeb = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: { ...process.env, CAROUSELBOT_PORT: String(webPort) },
  stdio: ["ignore", "ignore", "pipe"],
});
const canonicalWeb = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: { ...process.env, CAROUSELBOT_PORT: String(canonicalPort) },
  stdio: ["ignore", "ignore", "pipe"],
});
const chrome = spawn(chromePath, [
  "--headless=new", "--disable-background-networking", "--disable-component-update", "--disable-breakpad", "--disable-extensions", "--disable-popup-blocking",
  "--disable-crash-reporter", "--noerrdialogs", "--no-first-run", "--no-default-browser-check",
  "--window-size=1280,900", `--remote-debugging-port=${debuggingPort}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
for (const child of [legacyWeb, canonicalWeb, chrome]) {
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  return {
    ready: new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); }),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const commandId = ++id;
        pending.set(commandId, { resolve, reject });
        socket.send(JSON.stringify({ id: commandId, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function json(path) {
  const response = await fetch(`http://127.0.0.1:${debuggingPort}${path}`);
  if (!response.ok) throw new Error(`DevTools returned ${response.status}`);
  return response.json();
}

async function waitFor(callback, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await callback();
      if (result) return result;
    } catch { /* The browser or page is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message}\n${diagnostics.slice(-3000)}`);
}

async function evaluate(cdp, expression, { userGesture = false } = {}) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
  return result.result?.value;
}

let legacyCdp;
let canonicalCdp;
try {
  await waitFor(() => json("/json/list"), "Chrome DevTools did not start.");
  const initial = (await json("/json/list")).find((target) => target.type === "page" && target.url === "about:blank");
  if (!initial) throw new Error("Chrome did not expose its initial browser page.");
  legacyCdp = connectCdp(initial.webSocketDebuggerUrl);
  await legacyCdp.ready;
  await legacyCdp.send("Runtime.enable");
  await legacyCdp.send("Page.navigate", { url: legacyUrl });
  await waitFor(() => evaluate(legacyCdp, "document.readyState === 'complete' && Boolean(window.carouselBotReady)"), "Legacy editor did not load.");

  await evaluate(legacyCdp, `new Promise((resolve, reject) => {
    const request = indexedDB.open("slide-studio-db", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("projects", { keyPath: "id" });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction("projects", "readwrite");
      transaction.objectStore("projects").put({
        id: "migration-browser-project", name: "Migration browser project", createdAt: 1, updatedAt: 2, revision: 3,
        assets: [{ id: "asset-1", name: "Pixel", imageData: "data:image/png;base64,iVBORw0KGgo=", width: 1, height: 1 }],
        slides: [{ id: "slide-1", name: "Slide 1", width: 1080, height: 1920, imageData: null, texts: [], overlays: [] }]
      });
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
    };
  })`);
  await legacyCdp.send("Page.reload");
  await waitFor(() => evaluate(legacyCdp, "document.querySelector('[data-action=\"migrate-projects\"]')?.textContent.includes('project')"), "Migration prompt did not find the legacy project.");
  const modalState = await evaluate(legacyCdp, `(() => {
    const modal = document.querySelector('[data-migration-modal] [role="dialog"]');
    const close = document.querySelector('[data-action="close-migration-modal"]');
    return { visible: Boolean(modal), modal: modal?.getAttribute("aria-modal"), hasClose: Boolean(close) };
  })()`);
  if (!modalState.visible || modalState.modal !== "true" || !modalState.hasClose) throw new Error(`Migration notice is not an accessible, closeable modal: ${JSON.stringify(modalState)}`);
  await evaluate(legacyCdp, `document.querySelector('[data-action="close-migration-modal"]').click()`);
  await waitFor(() => evaluate(legacyCdp, `!document.querySelector('[data-migration-modal]')`), "Migration modal did not close.");
  await legacyCdp.send("Page.reload");
  await waitFor(() => evaluate(legacyCdp, "document.querySelector('[data-action=\"migrate-projects\"]')?.textContent.includes('project')"), "Migration modal did not return after a fresh page load.");
  await evaluate(legacyCdp, `(() => {
    document.querySelector('[data-action="migrate-projects"]').scrollIntoView({ block: "center" });
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const buttonRect = await evaluate(legacyCdp, `(() => {
    const button = document.querySelector('[data-action="migrate-projects"]');
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return { x, y, targetIsButton: document.elementFromPoint(x, y) === button };
  })()`);
  if (!buttonRect.targetIsButton) throw new Error(`Migration button could not be brought into the browser viewport: ${JSON.stringify(buttonRect)}`);
  await legacyCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: buttonRect.x, y: buttonRect.y, button: "left", clickCount: 1 });
  await legacyCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: buttonRect.x, y: buttonRect.y, button: "left", clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const clickState = await evaluate(legacyCdp, `({
    button: document.querySelector('[data-action="migrate-projects"]')?.textContent,
    status: document.querySelector('[data-migration-status]')?.textContent,
    config: window.CAROUSELBOT_CONFIG,
  })`);
  const targetUrls = (await json("/json/list")).map(({ url }) => url);

  const canonicalTarget = await waitFor(async () => (await json("/json/list")).find((page) => page.url.startsWith(canonicalOrigin)), `CarouselBot migration tab did not open. Click state: ${JSON.stringify(clickState)}. Targets: ${JSON.stringify(targetUrls)}`);
  canonicalCdp = connectCdp(canonicalTarget.webSocketDebuggerUrl);
  await canonicalCdp.ready;
  await canonicalCdp.send("Runtime.enable");
  const imported = await waitFor(() => evaluate(canonicalCdp, `new Promise((resolve) => {
    const request = indexedDB.open("carouselbot-db");
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const item = request.result.transaction("projects", "readonly").objectStore("projects").get("migration-browser-project");
      item.onerror = () => resolve(null);
      item.onsuccess = () => resolve(item.result || null);
    };
  })`), "Canonical IndexedDB did not receive the project.");
  if (imported.name !== "Migration browser project" || imported.assets?.[0]?.id !== "asset-1") throw new Error("Migrated project data did not match the legacy record.");
  await waitFor(() => evaluate(legacyCdp, "document.querySelector('[data-migration-status]')?.textContent.includes('Copied 1 project')"), "Legacy origin did not receive completion acknowledgement.");
  process.stdout.write(`${JSON.stringify({ copied: true, legacyOrigin, canonicalOrigin, projectId: imported.id, assets: imported.assets.length })}\n`);
} finally {
  legacyCdp?.close();
  canonicalCdp?.close();
  chrome.kill("SIGTERM");
  legacyWeb.kill("SIGTERM");
  canonicalWeb.kill("SIGTERM");
  await rm(profile, { recursive: true, force: true });
}
