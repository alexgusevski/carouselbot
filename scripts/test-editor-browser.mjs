import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const root = new URL("..", import.meta.url);
const rootPath = decodeURIComponent(root.pathname);
const distPath = join(rootPath, "dist");
const profile = await mkdtemp(join(tmpdir(), "carouselbot-editor-browser-"));
const debuggingPort = 19600 + Math.floor(Math.random() * 300);
const remoteUrl = process.env.CAROUSELBOT_TEST_URL?.replace(/\/+$/, "") || "";
let diagnostics = "";

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
if (!pageUrl) {
  web = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const relativePath = url.pathname === "/" || /^\/projects\/[^/]+\/?$/.test(url.pathname)
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

let cdp;
const runtimeErrors = [];
try {
  await waitFor(() => json("/json/list"), "Chrome DevTools did not start.");
  const target = (await json("/json/list")).find((item) => item.type === "page");
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    runtimeErrors.push(exceptionDetails.exception?.description || exceptionDetails.text || "Uncaught exception");
  });
  cdp.on("Log.entryAdded", ({ entry }) => {
    if (entry.level === "error") runtimeErrors.push(entry.text);
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: pageUrl });

  await waitFor(
    () => evaluate(cdp, "document.readyState === 'complete' && Boolean(window.carouselBotAgent) && Boolean(window.carouselBotReady)"),
    "The modular editor did not finish loading.",
  );
  await evaluate(cdp, "window.carouselBotReady");

  const initial = await evaluate(cdp, `({
    title: document.title,
    dashboard: Boolean(document.querySelector('.dashboard')),
    protocolVersion: window.carouselBotAgent.protocolVersion,
    sameAgentAlias: window.carouselBotAgent === window.slideStudioAgent,
    sameReadyAlias: window.carouselBotReady === window.slideStudioReady,
    sourceModules: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/src/')).map((entry) => new URL(entry.name).pathname),
  })`);
  if (initial.title !== "CarouselBot" || !initial.dashboard || initial.protocolVersion !== 3 || !initial.sameAgentAlias || !initial.sameReadyAlias) {
    throw new Error(`Unexpected initial editor state: ${JSON.stringify(initial)}`);
  }
  if (!initial.sourceModules.includes("/src/main.mjs") || !initial.sourceModules.includes("/src/editor.mjs")) {
    throw new Error(`The browser did not load the expected module graph: ${JSON.stringify(initial.sourceModules)}`);
  }

  await evaluate(cdp, `(() => {
    document.querySelector('[data-action="new-project"]').click();
    return true;
  })()`);
  const projectId = await waitFor(
    () => evaluate(cdp, `location.pathname.startsWith('/projects/') && window.carouselBotAgent.inspect({ includeAllProjects: false }).project?.id`),
    "Creating a project through the dashboard did not open it.",
  );

  await evaluate(cdp, `(() => {
    const title = document.querySelector('.project-title-input');
    title.value = 'Browser regression project';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor(
    () => evaluate(cdp, `new Promise((resolve) => {
      const request = indexedDB.open('carouselbot-db');
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const item = request.result.transaction('projects', 'readonly').objectStore('projects').get(${JSON.stringify(projectId)});
        item.onerror = () => resolve(false);
        item.onsuccess = () => resolve(item.result?.name === 'Browser regression project' && item.result?.revision >= 1);
      };
    })`),
    "The renamed project was not persisted to IndexedDB.",
  );

  const storageContract = await evaluate(cdp, `(async () => {
    const store = await import('/src/project-store.mjs');
    const temporary = {
      id: 'browser-store-contract',
      name: 'Storage contract',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      slides: [],
      assets: [],
    };
    await store.putProject(temporary);
    const created = await store.getProjectFromDb(temporary.id);
    const updatedEvent = JSON.parse(localStorage.getItem(store.PROJECT_SYNC_STORAGE_KEY));
    let putConflict = null;
    let deleteConflict = null;
    try {
      await store.putProject({ ...temporary, revision: 2 }, { expectedRevision: 0, broadcast: false });
    } catch (error) {
      putConflict = { code: error.code, expected: error.expectedRevision, actual: error.actualRevision };
    }
    try {
      await store.deleteProjectFromDb(temporary.id, { expectedRevision: 0, broadcast: false });
    } catch (error) {
      deleteConflict = { code: error.code, expected: error.expectedRevision, actual: error.actualRevision };
    }
    const retainedAfterConflicts = await store.getProjectFromDb(temporary.id);
    await store.deleteProjectFromDb(temporary.id, { expectedRevision: 1 });
    const deletedEvent = JSON.parse(localStorage.getItem(store.PROJECT_SYNC_STORAGE_KEY));
    const deleted = await store.getProjectFromDb(temporary.id);
    return { created, updatedEvent, putConflict, deleteConflict, retainedAfterConflicts, deletedEvent, deleted };
  })()`);
  if (
    storageContract.created?.revision !== 1
    || storageContract.putConflict?.code !== "STALE_PROJECT"
    || storageContract.putConflict?.expected !== 0
    || storageContract.putConflict?.actual !== 1
    || storageContract.deleteConflict?.code !== "STALE_PROJECT"
    || storageContract.retainedAfterConflicts?.revision !== 1
    || storageContract.updatedEvent?.type !== "project.updated"
    || storageContract.deletedEvent?.type !== "project.deleted"
    || storageContract.deleted !== null
  ) {
    throw new Error(`IndexedDB storage contracts changed: ${JSON.stringify(storageContract)}`);
  }

  const slide = await evaluate(cdp, `window.carouselBotAgent.execute({
    type: 'slide.add',
    projectId: ${JSON.stringify(projectId)},
    name: 'Agent-created base',
    backgroundColor: '#E7E2D8'
  })`);
  if (!slide?.createdSlideId) throw new Error(`The compatibility agent could not add a slide: ${JSON.stringify(slide)}`);

  const agentMatrix = await evaluate(cdp, `(async () => {
    const agent = window.carouselBotAgent;
    const visibleBefore = agent.inspect({ includeAllProjects: false }).activeProjectId;
    const steps = [];
    const run = async (operation) => {
      steps.push(operation.type);
      return agent.execute(operation);
    };
    const bridge = window.carouselBotLocalMcpBridge;
    const originalFetchMedia = bridge.fetchMedia;
    bridge.fetchMedia = async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#FE2C55"/></svg>';
      return { file: new File([svg], 'agent-matrix.svg', { type: 'image/svg+xml' }), name: 'agent-matrix.svg' };
    };
    let scratch;
    try {
      scratch = await run({ type: 'project.create', name: 'Agent operation matrix' });
      const firstSlide = await run({
        type: 'slide.add',
        projectId: scratch.projectId,
        name: 'Matrix base',
        backgroundColor: '#111111',
      });
      const text = await run({
        type: 'text.add',
        projectId: scratch.projectId,
        slideId: firstSlide.createdSlideId,
        text: 'Matrix text',
        role: 'body',
      });
      await run({
        type: 'text.update',
        projectId: scratch.projectId,
        slideId: firstSlide.createdSlideId,
        updates: [{ id: text.createdTextId, text: 'Updated matrix text', align: 'left', rotation: 12 }],
      });
      await run({
        type: 'text.fit',
        projectId: scratch.projectId,
        slideId: firstSlide.createdSlideId,
        textIds: [text.createdTextId],
        mode: 'both',
      });
      const asset = await run({
        type: 'asset.import',
        projectId: scratch.projectId,
        slideId: firstSlide.createdSlideId,
        mediaId: 'agent-matrix',
        name: 'Matrix asset',
      });
      await run({ type: 'asset.update', projectId: scratch.projectId, assetId: asset.assetId, name: 'Updated asset' });
      const image = await run({
        type: 'image.add',
        projectId: scratch.projectId,
        slideId: firstSlide.createdSlideId,
        assetId: asset.assetId,
        x: 0.2,
        y: 0.25,
        width: 0.3,
      });
      await run({
        type: 'image.update',
        projectId: scratch.projectId,
        slideId: firstSlide.createdSlideId,
        updates: [{ id: image.createdImageId, rotation: 18, cropX: 0.1, cropY: 0.1, cropW: 0.8, cropH: 0.8 }],
      });
      const copies = await run({
        type: 'layer.duplicate',
        projectId: scratch.projectId,
        slideId: firstSlide.createdSlideId,
        layerIds: [text.createdTextId, image.createdImageId],
      });
      const withCopies = agent.inspect({ projectId: scratch.projectId, slideId: firstSlide.createdSlideId, includeAllProjects: false }).slide;
      const layerIds = [...withCopies.texts.map((item) => item.id), ...withCopies.images.map((item) => item.id)];
      await run({
        type: 'layer.reorder',
        projectId: scratch.projectId,
        slideId: firstSlide.createdSlideId,
        layerIds: layerIds.reverse(),
      });
      await run({
        type: 'layer.delete',
        projectId: scratch.projectId,
        slideId: firstSlide.createdSlideId,
        layerIds: copies.createdLayers.map((item) => item.id),
      });
      await run({ type: 'asset.delete', projectId: scratch.projectId, assetId: asset.assetId });
      const duplicate = await run({
        type: 'slide.duplicate',
        projectId: scratch.projectId,
        slideId: firstSlide.createdSlideId,
        name: 'Matrix duplicate',
      });
      await run({
        type: 'slide.update',
        projectId: scratch.projectId,
        slideId: duplicate.createdSlideId,
        name: 'Updated duplicate',
        backgroundColor: '#25F4EE',
        imageScale: 1.2,
      });
      await run({
        type: 'slide.reorder',
        projectId: scratch.projectId,
        slideIds: [duplicate.createdSlideId, firstSlide.createdSlideId],
      });
      await run({ type: 'slide.delete', projectId: scratch.projectId, slideId: duplicate.createdSlideId });
      await run({ type: 'project.update', projectId: scratch.projectId, name: 'Completed operation matrix' });
      const finalState = agent.inspect({ projectId: scratch.projectId, slideId: firstSlide.createdSlideId, includeAllProjects: false });
      const deletion = await run({ type: 'project.delete', projectId: scratch.projectId });
      const visibleAfter = agent.inspect({ includeAllProjects: false }).activeProjectId;
      const removed = !agent.inspect().projects.some((project) => project.id === scratch.projectId);
      return { visibleBefore, visibleAfter, steps, finalState, deletion, removed };
    } finally {
      bridge.fetchMedia = originalFetchMedia;
    }
  })()`);
  if (
    agentMatrix.visibleBefore !== projectId
    || agentMatrix.visibleAfter !== projectId
    || agentMatrix.steps.length !== 19
    || agentMatrix.finalState?.project?.name !== "Completed operation matrix"
    || agentMatrix.finalState?.project?.slideCount !== 1
    || agentMatrix.finalState?.project?.assetCount !== 0
    || agentMatrix.finalState?.slide?.texts?.[0]?.text !== "Updated matrix text"
    || agentMatrix.finalState?.slide?.images?.length !== 0
    || !agentMatrix.removed
    || agentMatrix.deletion?.viewChanged !== false
  ) {
    throw new Error(`Direct agent operation matrix failed: ${JSON.stringify(agentMatrix)}`);
  }

  await evaluate(cdp, `document.querySelector('[data-action="add-text"]').click()`);
  await waitFor(() => evaluate(cdp, `Boolean(document.querySelector('#text-value'))`), "The Add text action did not select a new text layer.");
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#text-value');
    input.value = 'Module refactor smoke test';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor(
    () => evaluate(cdp, `window.carouselBotAgent.inspect({ includeAllProjects: false }).slide?.texts?.[0]?.text === 'Module refactor smoke test'`),
    "Editing text through the inspector did not update the model.",
  );
  await waitFor(
    () => evaluate(cdp, `new Promise((resolve) => {
      const request = indexedDB.open('carouselbot-db');
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const item = request.result.transaction('projects', 'readonly').objectStore('projects').get(${JSON.stringify(projectId)});
        item.onerror = () => resolve(false);
        item.onsuccess = () => resolve(item.result?.slides?.some((slide) => slide.texts?.some((text) => text.text === 'Module refactor smoke test')));
      };
    })`),
    "The edited text was not persisted before the history check.",
  );

  await evaluate(cdp, "document.activeElement?.blur?.()");
  await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  await waitFor(
    () => evaluate(cdp, `window.carouselBotAgent.inspect({ includeAllProjects: false }).slide?.texts?.length === 0`),
    "Undo did not remove the newly added text layer.",
  );
  await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }))`);
  await waitFor(
    () => evaluate(cdp, `window.carouselBotAgent.inspect({ includeAllProjects: false }).slide?.texts?.[0]?.text === 'Module refactor smoke test'`),
    "Redo did not restore the edited text layer.",
  );

  const pointerInteraction = await evaluate(cdp, `(() => {
    const inspectText = () => structuredClone(window.carouselBotAgent.inspect({ includeAllProjects: false }).slide.texts[0]);
    const before = inspectText();
    const box = document.querySelector('.text-box');
    const boxRect = box.getBoundingClientRect();
    const startX = boxRect.left + 8;
    const startY = boxRect.top + 8;
    box.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 71, pointerType: 'mouse', button: 0, buttons: 1, clientX: startX, clientY: startY,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 71, pointerType: 'mouse', buttons: 1, clientX: startX + 32, clientY: startY + 24,
    }));
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 71, pointerType: 'mouse', button: 0, clientX: startX + 32, clientY: startY + 24,
    }));
    const afterDrag = inspectText();
    const handle = box.querySelector('[data-corner="se"]');
    const handleRect = handle.getBoundingClientRect();
    const resizeX = handleRect.left + handleRect.width / 2;
    const resizeY = handleRect.top + handleRect.height / 2;
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 72, pointerType: 'mouse', button: 0, buttons: 1, clientX: resizeX, clientY: resizeY,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 72, pointerType: 'mouse', buttons: 1, clientX: resizeX + 28, clientY: resizeY + 28,
    }));
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 72, pointerType: 'mouse', button: 0, clientX: resizeX + 28, clientY: resizeY + 28,
    }));
    return { before, afterDrag, afterResize: inspectText() };
  })()`);
  if (
    Math.abs(pointerInteraction.afterDrag.x - pointerInteraction.before.x) < 0.01
    || Math.abs(pointerInteraction.afterDrag.y - pointerInteraction.before.y) < 0.01
    || pointerInteraction.afterResize.width <= pointerInteraction.afterDrag.width + 0.01
    || pointerInteraction.afterResize.height <= pointerInteraction.afterDrag.height + 0.01
  ) {
    throw new Error(`Pointer drag or resize did not update the text layer: ${JSON.stringify(pointerInteraction)}`);
  }
  await waitFor(
    () => evaluate(cdp, `new Promise((resolve) => {
      const request = indexedDB.open('carouselbot-db');
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const item = request.result.transaction('projects', 'readonly').objectStore('projects').get(${JSON.stringify(projectId)});
        item.onerror = () => resolve(false);
        item.onsuccess = () => {
          const text = item.result?.slides?.find((slide) => slide.id === ${JSON.stringify(slide.createdSlideId)})?.texts?.[0];
          resolve(text?.width >= ${pointerInteraction.afterResize.width - 0.0001} && text?.height >= ${pointerInteraction.afterResize.height - 0.0001});
        };
      };
    })`),
    "Pointer interaction changes were not persisted.",
  );

  await evaluate(cdp, `(() => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#25F4EE"/></svg>';
    const file = new File([svg], 'browser-upload.svg', { type: 'image/svg+xml' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector('#photo-upload');
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const uploadedSlide = await waitFor(
    () => evaluate(cdp, `(() => {
      const project = window.carouselBotAgent.inspect({ includeAllProjects: false }).project;
      const uploaded = project?.slides?.find((slide) => slide.name === 'browser-upload');
      return project?.slideCount === 2 && uploaded?.width === 600 && uploaded?.height === 900 ? uploaded : null;
    })()`),
    "Uploading an SVG through the native file input did not add a slide.",
  );
  if (uploadedSlide.name !== "browser-upload" || uploadedSlide.width !== 600 || uploadedSlide.height !== 900) {
    throw new Error(`The uploaded slide metadata changed: ${JSON.stringify(uploadedSlide)}`);
  }

  const rendered = await evaluate(cdp, `(() => {
    const inspected = window.carouselBotAgent.inspect({ includeAllProjects: false });
    return window.carouselBotAgent.execute({ type: 'slide.render', projectId: inspected.project.id, slideId: inspected.slide.id, width: 270 });
  })()`);
  if (rendered?.mimeType !== "image/png" || rendered.width !== 270 || rendered.height !== 480 || rendered.data?.length < 100) {
    throw new Error(`Rendering through the compatibility agent returned an invalid image: ${JSON.stringify(rendered)}`);
  }
  const renderedPixel = await evaluate(cdp, `(async () => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + ${JSON.stringify(rendered.data)};
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 5, 5, 1, 1, 0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  })()`);
  const expectedPixel = [231, 226, 216, 255];
  if (renderedPixel.some((channel, index) => Math.abs(channel - expectedPixel[index]) > 3)) {
    throw new Error(`Rendered PNG does not contain the expected slide background: ${JSON.stringify(renderedPixel)}`);
  }

  await waitFor(
    () => evaluate(cdp, `new Promise((resolve) => {
      const request = indexedDB.open('carouselbot-db');
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const item = request.result.transaction('projects', 'readonly').objectStore('projects').get(${JSON.stringify(projectId)});
        item.onerror = () => resolve(false);
        item.onsuccess = () => {
          const uploaded = item.result?.slides?.find((slide) => slide.name === 'browser-upload');
          resolve(item.result?.slides?.length === 2 && uploaded?.width === 600 && uploaded?.height === 900);
        };
      };
    })`),
    "The uploaded slide was not persisted before reload.",
  );
  await cdp.send("Page.reload");
  await waitFor(
    () => evaluate(cdp, `document.readyState === 'complete' && location.pathname === '/projects/${encodeURIComponent(projectId)}' && window.carouselBotAgent?.inspect({ includeAllProjects: false }).project?.slideCount === 2`),
    "The project did not survive a hard reload of its deep route.",
  );
  const persisted = await evaluate(cdp, `(() => {
    const inspected = window.carouselBotAgent.inspect({ includeAllProjects: false });
    return { name: inspected.project.name, textValues: (inspected.slide?.texts || []).map((text) => text.text) };
  })()`);
  if (persisted.name !== "Browser regression project" || !persisted.textValues.includes("Module refactor smoke test")) {
    throw new Error(`Reloaded project data changed: ${JSON.stringify(persisted)}`);
  }

  await cdp.send("Page.navigate", { url: `${pageUrl}/projects/missing-project` });
  await waitFor(
    () => evaluate(cdp, `document.readyState === 'complete' && location.pathname === '/' && document.querySelector('.toast')?.textContent.includes('isn’t available')`),
    "A missing deep route did not return to the dashboard with feedback.",
  );

  const failedResources = await evaluate(cdp, `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/src/') && entry.responseStatus >= 400).map((entry) => ({ name: entry.name, status: entry.responseStatus }))`);
  if (failedResources.length) throw new Error(`Some source modules failed to load: ${JSON.stringify(failedResources)}`);
  if (runtimeErrors.length) throw new Error(`Browser runtime errors:\n${runtimeErrors.join("\n")}`);

  process.stdout.write(`${JSON.stringify({
    loadedModules: initial.sourceModules.length,
    projectCreated: true,
    indexedDbPersistence: true,
    indexedDbConflictProtection: true,
    directUiTextEditing: true,
    pointerDragResize: true,
    undoRedo: true,
    imageUpload: true,
    deepRouteReload: true,
    missingRouteFallback: true,
    agentCompatibility: true,
    agentOperationsCovered: agentMatrix.steps.length,
    renderedPngBytes: Math.floor(rendered.data.length * 0.75),
  }, null, 2)}\n`);
} finally {
  cdp?.close();
  if (chrome.exitCode == null) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5_000);
      chrome.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      chrome.kill("SIGTERM");
    });
  }
  if (web) await new Promise((resolve) => web.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
