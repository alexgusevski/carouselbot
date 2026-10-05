import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { DEFAULT_OUTLINE_WIDTH, OUTLINE_RATIO } from "../src/editor-model.mjs";

const root = new URL("..", import.meta.url);
const rootPath = decodeURIComponent(root.pathname);
const distPath = join(rootPath, "dist");
const profile = await mkdtemp(join(tmpdir(), "carouselbot-editor-browser-"));
const debuggingPort = 19600 + Math.floor(Math.random() * 300);
const remoteUrl = process.env.CAROUSELBOT_TEST_URL?.replace(/\/+$/, "") || "";
let diagnostics = "";
const productionHeaders = await readFile(join(rootPath, "deploy/_headers"), "utf8");
const securityPolicy = productionHeaders.match(/Content-Security-Policy: (.+)/)[1];

execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "inherit" });

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".ttf", "font/ttf"],
]);

let web;
let pageUrl = remoteUrl;
let pauseShareResponse = false;
let resumeShareResponse;
if (!pageUrl) {
  const shares = new Map();
  let shareCounter = 0;
  web = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/shares/config") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ siteKey: "test-site-key" }));
      return;
    }
    if (url.pathname === "/api/shares" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const id = `${Date.now().toString(36)}-${(++shareCounter).toString(16).padStart(32, "0")}.${"a".repeat(64)}`;
      const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
      shares.set(id, { payload: Buffer.concat(chunks), format: request.headers["x-carouselbot-share-format"], expiresAt });
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id, expiresAt }));
      return;
    }
    const shareId = url.pathname.match(/^\/api\/shares\/([^/]+)$/)?.[1];
    if (shareId && request.method === "GET") {
      const share = shares.get(shareId);
      if (!share || share.expiresAt <= Date.now()) {
        response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "This share link has expired." }));
        return;
      }
      if (pauseShareResponse) await new Promise((resolve) => { resumeShareResponse = resolve; });
      response.writeHead(200, { "Content-Type": "application/octet-stream", "X-CarouselBot-Share-Format": share.format,
        "Content-Length": share.payload.byteLength, "Cache-Control": "no-store" });
      response.end(share.payload);
      return;
    }
    const relativePath = url.pathname === "/" || /^\/(?:projects|folders|share)\/[^/]+\/?$/.test(url.pathname)
      ? "index.html"
      : url.pathname.slice(1);
    if (!/^(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(relativePath)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(join(distPath, relativePath));
      response.writeHead(200, {
        "Content-Type": contentTypes.get(extname(relativePath)) || "application/octet-stream",
        "Cache-Control": "no-cache",
        "Content-Security-Policy": securityPolicy,
        "Content-Length": body.byteLength,
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });

  await new Promise((resolve, reject) => {
    web.once("error", reject);
    web.listen(0, "127.0.0.1", resolve);
  });
  pageUrl = `http://127.0.0.1:${web.address().port}`;
}

async function firstExistingPath(paths) {
  for (const path of paths.filter(Boolean)) {
    if (await access(path).then(() => true).catch(() => false)) return path;
  }
  throw new Error("Google Chrome was not found. Set CHROME_PATH to run the editor browser test.");
}

const chromePath = await firstExistingPath([
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
]);

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-background-networking",
  "--disable-breakpad",
  "--disable-component-update",
  "--disable-crash-reporter",
  "--disable-extensions",
  "--no-default-browser-check",
  "--no-first-run",
  "--no-sandbox",
  "--noerrdialogs",
  "--window-size=1440,1100",
  `--remote-debugging-port=${debuggingPort}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
chrome.stderr.setEncoding("utf8");
chrome.stderr.on("data", (chunk) => { diagnostics += chunk; });

async function json(path) {
  const response = await fetch(`http://127.0.0.1:${debuggingPort}${path}`);
  if (!response.ok) throw new Error(`DevTools returned ${response.status}`);
  return response.json();
}

async function waitFor(callback, message, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await callback();
      if (result) return result;
    } catch { /* Chrome or the page may still be starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message}\n${diagnostics.slice(-3000)}`);
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      for (const listener of listeners.get(message.method) || []) listener(message.params || {});
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const commandId = ++id;
        pending.set(commandId, { resolve, reject });
        socket.send(JSON.stringify({ id: commandId, method, params }));
      });
    },
    on(method, callback) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(callback);
    },
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression, { userGesture = false } = {}) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
  return result.result?.value;
}

async function callPageFunction(cdp, functionDeclaration, args = []) {
  const globalObject = await cdp.send("Runtime.evaluate", { expression: "globalThis" });
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId: globalObject.result.objectId,
    functionDeclaration: String(functionDeclaration),
    arguments: args.map((value) => ({ value })),
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser function call failed");
  return result.result?.value;
}

let cdp;
try {
  await waitFor(() => json("/json/list"), "Chrome did not start");
  const target = (await json("/json/list")).find((item) => item.type === "page");
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: pageUrl });
  await waitFor(() => evaluate(cdp, "Boolean(window.carouselBotAgent)"), "Editor did not start");
  const paths = [join(rootPath, "packages/mcp/test/fixtures/video-with-audio.mp4")];
  if (process.env.CAROUSELBOT_AUDIO_FIXTURE) paths.push(process.env.CAROUSELBOT_AUDIO_FIXTURE);
  for (const path of paths) {
    const src = `data:video/mp4;base64,${(await readFile(path)).toString("base64")}`;
    const result = await callPageFunction(cdp, async function (src) {
      const violations = [];
      const onViolation = (event) => violations.push(event.violatedDirective);
      document.addEventListener("securitypolicyviolation", onViolation);
      try {
        const { readVideoAsset, readVideoAudio } = await import("/src/video-media.mjs");
        const asset = await readVideoAsset(src);
        const decoded = await readVideoAudio(src);
        const peak = decoded.getChannelData(0).reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
        const context = new OfflineAudioContext(2, 1, 48000);
        context.decodeAudioData = async () => { throw new Error("Container decoder unavailable"); };
        const fallback = await readVideoAudio(src, context);
        const fallbackPeak = fallback.getChannelData(0).reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
        const { renderSlideMp4 } = await import("/src/video-export.mjs");
        const slide = { ...asset, id: "audio-regression", aspectRatio: "9:16", texts: [], overlays: [] };
        const project = { slides: [slide], assets: [], fonts: [] };
        const output = await renderSlideMp4(slide, project);
        const outputBytes = new Uint8Array(await output.arrayBuffer());
        const binary = Array.from(outputBytes, (byte) => String.fromCharCode(byte)).join("");
        const exported = await readVideoAudio(`data:video/mp4;base64,${btoa(binary)}`);
        const exportPeak = exported.getChannelData(0).reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
        return { duration: asset.duration, peak, fallbackPeak, exportPeak, exportDuration: exported.duration,
          mp4: output.type === "video/mp4", violations };
      } finally { document.removeEventListener("securitypolicyviolation", onViolation); }
    }, [src]);
    if (!result.mp4 || result.peak < 0.02 || result.fallbackPeak < 0.02 || result.exportPeak < 0.02 || result.violations.length
      || Math.abs(result.exportDuration - result.duration) > 0.75) throw new Error(`Audio regression: ${JSON.stringify(result)}`);
    console.log(`Audio import, container fallback, and audible MP4 export under production CSP passed: ${JSON.stringify(result)}`);
  }
  const rejectsUnsupported = await evaluate(cdp, `(async () => {
    const { readVideoAsset } = await import('/src/video-media.mjs');
    const { InputAudioTrack } = await import('/assets/mediabunny-1.60.0.min.mjs');
    const decode = OfflineAudioContext.prototype.decodeAudioData;
    const canDecode = InputAudioTrack.prototype.canDecode;
    OfflineAudioContext.prototype.decodeAudioData = async () => { throw new Error('Unsupported test codec'); };
    InputAudioTrack.prototype.canDecode = async () => false;
    try {
      await readVideoAsset('data:video/mp4;base64,${(await readFile(paths[0])).toString("base64")}');
      return false;
    } catch (error) { return /clip was not imported/.test(error.message); }
    finally { OfflineAudioContext.prototype.decodeAudioData = decode; InputAudioTrack.prototype.canDecode = canDecode; }
  })()`);
  if (!rejectsUnsupported) throw new Error("Unsupported audio was accepted at import");
  console.log("Unsupported audio is rejected before editing.");
} finally {
  cdp?.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => chrome.once("exit", resolve));
  if (web) await new Promise((resolve) => web.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
