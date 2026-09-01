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
    const relativePath = url.pathname === "/" || /^\/(?:projects|folders)\/[^/]+\/?$/.test(url.pathname)
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

async function callPageFunction(cdp, functionDeclaration, args = []) {
  const globalObject = await cdp.send("Runtime.evaluate", { expression: "globalThis" });
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId: globalObject.result.objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser function call failed");
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

  const imagePasteBefore = await evaluate(cdp, `(() => {
    const inspected = window.carouselBotAgent.inspect({ includeAllProjects: false });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#FE2C55"/></svg>';
    const transfer = new DataTransfer();
    transfer.items.add(new File([svg], 'clipboard-image.svg', { type: 'image/svg+xml' }));
    document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    return {
      assets: inspected.project.assetCount,
      images: inspected.slide.imageCount,
    };
  })()`);
  const imagePaste = await waitFor(
    () => evaluate(cdp, `(() => {
      const inspected = window.carouselBotAgent.inspect({ includeAllProjects: false });
      const asset = inspected.project.assets.find((item) => item.name === 'clipboard-image');
      return asset && inspected.project.assetCount === ${imagePasteBefore.assets + 1}
        && inspected.slide.imageCount === ${imagePasteBefore.images + 1}
        ? { asset, slide: inspected.slide }
        : null;
    })()`),
    "Pasting an image file did not add one reusable asset and overlay.",
  );
  if (imagePaste.asset.width !== 160 || imagePaste.asset.height !== 100) {
    throw new Error(`Clipboard image metadata changed: ${JSON.stringify(imagePaste.asset)}`);
  }

  const layerCopy = await evaluate(cdp, `(() => {
    const before = structuredClone(window.carouselBotAgent.inspect({ includeAllProjects: false }));
    const textBox = document.querySelector('.text-box');
    const textRect = textBox.getBoundingClientRect();
    textBox.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 81,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: textRect.left + 8,
      clientY: textRect.top + 8,
      ctrlKey: true,
    }));
    const selectedBeforeCopy = [...document.querySelectorAll('.text-box.is-selected, .overlay-box.is-selected')].length;
    const transfer = new DataTransfer();
    const copyEvent = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: transfer });
    document.dispatchEvent(copyEvent);
    const canonical = transfer.getData('application/x-carouselbot-layer');
    const legacy = transfer.getData('application/x-slide-studio-layer');
    const plain = transfer.getData('text/plain');
    document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    return {
      before,
      selectedBeforeCopy,
      copyPrevented: copyEvent.defaultPrevented,
      canonical,
      legacy,
      plain,
      storedCanonical: localStorage.getItem('carouselbot-layer-clipboard'),
      storedLegacy: localStorage.getItem('slide-studio-layer-clipboard'),
    };
  })()`);
  const canonicalCopy = JSON.parse(layerCopy.canonical);
  const legacyCopy = JSON.parse(layerCopy.legacy);
  if (
    !layerCopy.copyPrevented
    || layerCopy.selectedBeforeCopy !== 2
    || canonicalCopy.layers.length !== 2
    || legacyCopy.token !== canonicalCopy.token
    || !layerCopy.plain.startsWith("carouselbot-layer:")
    || JSON.parse(layerCopy.storedCanonical).token !== canonicalCopy.token
    || JSON.parse(layerCopy.storedLegacy).token !== canonicalCopy.token
  ) {
    throw new Error(`Layer clipboard compatibility payload changed: ${JSON.stringify(layerCopy)}`);
  }
  const layerPaste = await waitFor(
    () => evaluate(cdp, `(() => {
      const inspected = window.carouselBotAgent.inspect({ includeAllProjects: false });
      return inspected.slide.textCount === ${layerCopy.before.slide.textCount + 1}
        && inspected.slide.imageCount === ${layerCopy.before.slide.imageCount + 1}
        ? {
            inspected,
            selected: [...document.querySelectorAll('.text-box.is-selected, .overlay-box.is-selected')].map((item) => item.dataset.textId || item.dataset.overlayId),
          }
        : null;
    })()`),
    "Pasting the copied mixed layer selection did not duplicate both layers.",
  );
  const originalText = layerCopy.before.slide.texts[0];
  const pastedText = layerPaste.inspected.slide.texts.at(-1);
  const originalImage = layerCopy.before.slide.images[0];
  const pastedImage = layerPaste.inspected.slide.images.at(-1);
  if (
    layerPaste.inspected.project.assetCount !== layerCopy.before.project.assetCount
    || Math.abs(pastedText.x - Math.min(originalText.x + 0.03, 1 - originalText.width)) > 0.0001
    || Math.abs(pastedText.y - Math.min(originalText.y + 0.03, 1 - originalText.height)) > 0.0001
    || Math.abs(pastedImage.x - Math.min(originalImage.x + 0.03, 1 - originalImage.width)) > 0.0001
    || pastedText.z <= originalText.z
    || pastedImage.z <= originalImage.z
    || !layerPaste.selected.includes(pastedText.id)
    || !layerPaste.selected.includes(pastedImage.id)
  ) {
    throw new Error(`Mixed layer paste semantics changed: ${JSON.stringify({ layerCopy, layerPaste })}`);
  }

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

  const slideReordering = await evaluate(cdp, `(() => {
    const drag = (sourceId, targetId, placement) => {
      const source = document.querySelector('.slide-thumb[data-slide-id="' + sourceId + '"]');
      const target = document.querySelector('.slide-thumb[data-slide-id="' + targetId + '"]');
      const transfer = new DataTransfer();
      const targetRect = target.getBoundingClientRect();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      const clientY = placement === 'before' ? targetRect.top + 1 : targetRect.bottom - 1;
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
      return window.carouselBotAgent.inspect({ includeAllProjects: false }).project.slides.map((item) => item.id);
    };
    const movedBefore = drag(${JSON.stringify(uploadedSlide.id)}, ${JSON.stringify(slide.createdSlideId)}, 'before');
    const restored = drag(${JSON.stringify(uploadedSlide.id)}, ${JSON.stringify(slide.createdSlideId)}, 'after');
    return { movedBefore, restored };
  })()`);
  if (
    slideReordering.movedBefore[0] !== uploadedSlide.id
    || slideReordering.restored[0] !== slide.createdSlideId
    || slideReordering.restored[1] !== uploadedSlide.id
  ) {
    throw new Error(`Native slide drag ordering changed: ${JSON.stringify(slideReordering)}`);
  }

  const keyboardSlideNavigation = await evaluate(cdp, `(() => {
    const activeSlideId = () => window.carouselBotAgent.inspect({ includeAllProjects: false }).activeSlideId;
    const activeThumbId = () => document.querySelector('.slide-thumb.is-active')?.dataset.slideId || null;
    const press = (key, target = document) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return { key, activeSlideId: activeSlideId(), activeThumbId: activeThumbId(), prevented: event.defaultPrevented };
    };
    document.querySelector('.slide-thumb[data-slide-id=${JSON.stringify(slide.createdSlideId)}]').click();
    const steps = [
      press('ArrowLeft'),
      press('ArrowUp'),
      press('ArrowRight'),
      press('ArrowRight'),
      press('ArrowDown'),
      press('ArrowLeft'),
      press('ArrowDown'),
      press('ArrowUp'),
    ];
    const activeButton = document.querySelector('.slide-thumb.is-active');
    const activeRect = activeButton.getBoundingClientRect();
    activeButton.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: activeRect.left + activeRect.width / 2,
      clientY: activeRect.top + activeRect.height / 2,
    }));
    const menuOpenBeforeNavigation = Boolean(document.querySelector('.layer-menu'));
    const menuStep = press('ArrowRight');
    const menuOpenAfterNavigation = Boolean(document.querySelector('.layer-menu'));
    press('ArrowLeft');
    const textBox = document.querySelector('.text-box');
    textBox.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 }));
    const inlineEditor = textBox.querySelector('.text-editor');
    const inlineEditingStep = press('ArrowRight', inlineEditor);
    inlineEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const title = document.querySelector('.project-title-input');
    const inputSteps = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map((key) => press(key, title));
    const textareaStep = press('ArrowRight', document.querySelector('#text-value'));
    const rangeStep = press('ArrowRight', document.querySelector('#font-size'));
    return {
      steps,
      menuOpenBeforeNavigation,
      menuStep,
      menuOpenAfterNavigation,
      inlineEditingStep,
      inputSteps,
      textareaStep,
      rangeStep,
    };
  })()`);
  const expectedKeyboardSlideIds = [
    slide.createdSlideId,
    slide.createdSlideId,
    uploadedSlide.id,
    uploadedSlide.id,
    uploadedSlide.id,
    slide.createdSlideId,
    uploadedSlide.id,
    slide.createdSlideId,
  ];
  if (
    keyboardSlideNavigation.steps.some((step, index) => (
      step.activeSlideId !== expectedKeyboardSlideIds[index]
      || step.activeThumbId !== expectedKeyboardSlideIds[index]
      || !step.prevented
    ))
    || !keyboardSlideNavigation.menuOpenBeforeNavigation
    || keyboardSlideNavigation.menuOpenAfterNavigation
    || keyboardSlideNavigation.menuStep.activeSlideId !== uploadedSlide.id
    || keyboardSlideNavigation.menuStep.activeThumbId !== uploadedSlide.id
    || !keyboardSlideNavigation.menuStep.prevented
    || keyboardSlideNavigation.inlineEditingStep.activeSlideId !== slide.createdSlideId
    || keyboardSlideNavigation.inlineEditingStep.activeThumbId !== slide.createdSlideId
    || keyboardSlideNavigation.inlineEditingStep.prevented
    || keyboardSlideNavigation.inputSteps.some((step) => (
      step.activeSlideId !== slide.createdSlideId
      || step.activeThumbId !== slide.createdSlideId
      || step.prevented
    ))
    || keyboardSlideNavigation.textareaStep.activeSlideId !== slide.createdSlideId
    || keyboardSlideNavigation.textareaStep.activeThumbId !== slide.createdSlideId
    || keyboardSlideNavigation.textareaStep.prevented
    || keyboardSlideNavigation.rangeStep.activeSlideId !== slide.createdSlideId
    || keyboardSlideNavigation.rangeStep.activeThumbId !== slide.createdSlideId
    || keyboardSlideNavigation.rangeStep.prevented
  ) {
    throw new Error(`Keyboard slide navigation changed: ${JSON.stringify(keyboardSlideNavigation)}`);
  }

  await evaluate(cdp, `(() => {
    const button = document.querySelector('.slide-thumb[data-slide-id="${slide.createdSlideId}"]');
    const rect = button.getBoundingClientRect();
    button.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
    [...document.querySelectorAll('.layer-menu-item')].find((item) => item.textContent.trim() === 'Change').click();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="640"><rect width="320" height="640" fill="#E7E2D8"/></svg>';
    const transfer = new DataTransfer();
    transfer.items.add(new File([svg], 'replacement-background.svg', { type: 'image/svg+xml' }));
    const input = document.querySelector('#slide-background-upload');
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(
    () => evaluate(cdp, `(() => {
      const project = window.carouselBotAgent.inspect({ includeAllProjects: false }).project;
      const changed = project.slides.find((item) => item.id === ${JSON.stringify(slide.createdSlideId)});
      return changed?.width === 320 && changed?.height === 640 && changed.name === 'Agent-created base';
    })()`),
    "Changing a slide background through its native context menu did not preserve the slide while replacing its image.",
  );

  const outputLabels = await evaluate(cdp, `(() => {
    window.__browserOutput = { downloads: [], shares: [], activation: false };
    const output = window.__browserOutput;
    window.__browserOriginalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      output.downloads.push({ download: this.download, href: this.href });
    };
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: ({ files } = {}) => Boolean(files?.length) });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async ({ files = [], title = null } = {}) => {
        output.shares.push({ title, files: files.map((file) => ({ name: file.name, type: file.type, size: file.size })) });
      },
    });
    const activation = {};
    Object.defineProperty(activation, 'isActive', { get: () => output.activation });
    Object.defineProperty(navigator, 'userActivation', { configurable: true, value: activation });
    const labels = Object.fromEntries(['export', 'share', 'share-all'].map((action) => {
      const button = document.querySelector('[data-action="' + action + '"]');
      return [action, button.innerHTML];
    }));
    document.querySelector('[data-action="export"]').click();
    return labels;
  })()`);
  await waitFor(
    () => evaluate(cdp, `window.__browserOutput.downloads.length === 1 && !document.querySelector('[data-action="export"]').disabled`),
    "Downloading from the native toolbar did not finish.",
  );
  await evaluate(cdp, `document.querySelector('[data-action="share"]').click()`);
  await waitFor(
    () => evaluate(cdp, `window.__browserOutput.shares.length === 1 && !document.querySelector('[data-action="share"]').disabled`),
    "Sharing the active slide from the native toolbar did not finish.",
  );
  await evaluate(cdp, `document.querySelector('[data-action="share-all"]').click()`);
  await waitFor(
    () => evaluate(cdp, `document.querySelector('.toast')?.textContent.includes('Slides are ready') && !document.querySelector('[data-action="share-all"]').disabled`),
    "The first multi-slide share did not prepare and cache the rendered files.",
  );
  const shareCountBeforeActivation = await evaluate(cdp, `window.__browserOutput.shares.length`);
  await evaluate(cdp, `(() => {
    window.__browserOutput.activation = true;
    document.querySelector('[data-action="share-all"]').click();
    return true;
  })()`, { userGesture: true });
  const nativeOutput = await waitFor(
    () => evaluate(cdp, `window.__browserOutput.shares.length === 2 ? ({
      ...window.__browserOutput,
      buttons: Object.fromEntries(['export', 'share', 'share-all'].map((action) => {
        const button = document.querySelector('[data-action="' + action + '"]');
        return [action, { disabled: button.disabled, html: button.innerHTML }];
      })),
    }) : null`),
    "The prepared multi-slide share did not use the cached files on the next gesture.",
  );
  await evaluate(cdp, `HTMLAnchorElement.prototype.click = window.__browserOriginalAnchorClick`);
  const expectedSingleName = "browser-regression-project-agent-created-base.png";
  const expectedAllNames = [
    "01-browser-regression-project-agent-created-base.png",
    "02-browser-regression-project-browser-upload.png",
  ];
  if (
    shareCountBeforeActivation !== 1
    || nativeOutput.downloads[0].download !== expectedSingleName
    || !nativeOutput.downloads[0].href.startsWith("blob:")
    || nativeOutput.shares[0].title !== "Browser regression project"
    || nativeOutput.shares[0].files.length !== 1
    || nativeOutput.shares[0].files[0].name !== expectedSingleName
    || nativeOutput.shares[0].files[0].type !== "image/png"
    || nativeOutput.shares[0].files[0].size < 1000
    || JSON.stringify(nativeOutput.shares[1].files.map((file) => file.name)) !== JSON.stringify(expectedAllNames)
    || nativeOutput.shares[1].files.some((file) => file.type !== "image/png" || file.size < 1000)
    || Object.entries(nativeOutput.buttons).some(([action, button]) => button.disabled || button.html !== outputLabels[action])
  ) {
    throw new Error(`Native download/share behavior changed: ${JSON.stringify({ outputLabels, nativeOutput, shareCountBeforeActivation })}`);
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
  await evaluate(cdp, "window.__carouselBotReloadSentinel = true");
  await cdp.send("Page.reload");
  await waitFor(
    () => evaluate(cdp, `document.readyState === 'complete' && !window.__carouselBotReloadSentinel && location.pathname === '/projects/${encodeURIComponent(projectId)}' && window.carouselBotAgent?.inspect({ includeAllProjects: false }).project?.slideCount === 2`),
    "The project did not survive a hard reload of its deep route.",
  );
  const persisted = await evaluate(cdp, `(() => {
    const inspected = window.carouselBotAgent.inspect({ includeAllProjects: false });
    return { name: inspected.project.name, textValues: (inspected.slide?.texts || []).map((text) => text.text) };
  })()`);
  if (persisted.name !== "Browser regression project" || !persisted.textValues.includes("Module refactor smoke test")) {
    throw new Error(`Reloaded project data changed: ${JSON.stringify(persisted)}`);
  }

  await evaluate(cdp, `(() => {
    const button = document.querySelector('.slide-thumb[data-slide-id="${uploadedSlide.id}"]');
    const rect = button.getBoundingClientRect();
    button.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
    [...document.querySelectorAll('.layer-menu-item')].find((item) => item.textContent.trim() === 'Remove').click();
    return true;
  })()`);
  await waitFor(
    () => evaluate(cdp, `(() => {
      const inspected = window.carouselBotAgent.inspect({ includeAllProjects: false });
      return inspected.project.slideCount === 1
        && !inspected.project.slides.some((item) => item.id === ${JSON.stringify(uploadedSlide.id)});
    })()`),
    "Removing a slide through its native context menu did not update the project.",
  );

  await cdp.send("Page.navigate", { url: `${pageUrl}/projects/missing-project` });
  await waitFor(
    () => evaluate(cdp, `document.readyState === 'complete' && location.pathname === '/' && document.querySelector('.toast')?.textContent.includes('isn’t available')`),
    "A missing deep route did not return to the dashboard with feedback.",
  );

  const filmstripProject = await evaluate(cdp, `window.carouselBotAgent.execute({ type: 'project.create', name: 'Filmstrip preview project with an intentionally long title' })`);
  const filmstripSlideIds = await callPageFunction(cdp, `async function(projectId) {
    const colors = ['#FE2C55', '#25F4EE', '#25282E', '#F4C95D', '#8A5CF5', '#3DBE78', '#F28C45', '#496DDB'];
    const ids = [];
    for (const [index, backgroundColor] of colors.entries()) {
      const result = await this.carouselBotAgent.execute({
        type: 'slide.add',
        projectId,
        name: 'Preview ' + (index + 1),
        backgroundColor,
      });
      ids.push(result.createdSlideId);
    }
    return ids;
  }`, [filmstripProject.projectId]);
  const filmstrip = await waitFor(() => evaluate(cdp, `(() => {
    const card = document.querySelector('.project-card[data-project-id="${filmstripProject.projectId}"]');
    const shell = card?.closest('.project-card-shell');
    const strip = shell?.querySelector('[data-project-preview-strip]');
    const slides = [...(strip?.querySelectorAll('[data-project-preview-slide-id]') || [])];
    const previous = shell?.querySelector('[data-project-preview-direction="previous"]');
    const next = shell?.querySelector('[data-project-preview-direction="next"]');
    const meta = card?.querySelector('.project-meta');
    const title = meta?.querySelector('strong');
    const details = meta?.lastElementChild;
    if (!card || !shell || !strip || slides.length !== 8 || slides.some((slide) => !slide.querySelector('img'))) return false;
    const stripRect = strip.getBoundingClientRect();
    const titleRect = title?.getBoundingClientRect();
    const detailsRect = details?.getBoundingClientRect();
    return {
      slideIds: slides.map((slide) => slide.dataset.projectPreviewSlideId),
      ratios: slides.map((slide) => {
        const rect = slide.getBoundingClientRect();
        return rect.width / rect.height;
      }),
      scrollLeft: strip.scrollLeft,
      maxScrollLeft: strip.scrollWidth - strip.clientWidth,
      overflow: strip.scrollWidth > strip.clientWidth + 2,
      renderedCount: slides.filter((slide) => slide.querySelector('img.thumb-rendered')).length,
      previousHidden: previous?.hidden,
      nextHidden: next?.hidden,
      controlsOutsideLink: !card.contains(previous) && !card.contains(next),
      cardLabel: card.getAttribute('aria-label'),
      buttonTypes: [previous?.type, next?.type],
      labels: [previous?.getAttribute('aria-label'), next?.getAttribute('aria-label')],
      touchTargets: [previous, next].map((button) => Number.parseFloat(getComputedStyle(button).width)),
      footerGap: titleRect?.top - stripRect.bottom,
      footerSameRow: Math.abs((titleRect?.bottom || 0) - (detailsRect?.bottom || 0)) < 2,
      titleTruncated: title && title.scrollWidth > title.clientWidth,
      detailsWhiteSpace: details && getComputedStyle(details).whiteSpace,
      detailsWrapped: details && details.scrollHeight > details.clientHeight + 1,
      metaOverflows: meta && meta.scrollWidth > meta.clientWidth + 1,
    };
  })()`), "The dashboard project filmstrip did not render all slide thumbnails.");
  if (
    JSON.stringify(filmstrip.slideIds) !== JSON.stringify(filmstripSlideIds)
    || filmstrip.ratios.some((ratio) => Math.abs(ratio - (9 / 16)) > 0.02)
    || !filmstrip.overflow
    || filmstrip.renderedCount < 1
    || filmstrip.previousHidden !== true
    || filmstrip.nextHidden !== false
    || !filmstrip.controlsOutsideLink
    || !filmstrip.cardLabel?.includes("8 slides")
    || filmstrip.buttonTypes.some((type) => type !== "button")
    || filmstrip.labels.some((label) => !label?.includes("Filmstrip preview project") || !label.includes("slide previews"))
    || filmstrip.touchTargets.some((size) => size < 44)
    || filmstrip.footerGap < 8
    || filmstrip.footerGap > 24
    || !filmstrip.footerSameRow
    || !filmstrip.titleTruncated
    || filmstrip.detailsWhiteSpace !== "nowrap"
    || filmstrip.detailsWrapped
    || filmstrip.metaOverflows
  ) {
    throw new Error(`Dashboard project filmstrip markup was incorrect: ${JSON.stringify(filmstrip)}`);
  }

  await callPageFunction(cdp, `function(projectId, slideId) {
    return this.carouselBotAgent.execute({ type: 'slide.update', projectId, slideId, backgroundColor: '#0A0A0A' });
  }`, [filmstripProject.projectId, filmstripSlideIds[5]]);
  await evaluate(cdp, `document.querySelector('.project-card[data-project-id="${filmstripProject.projectId}"]').closest('.project-card-shell').querySelector('[data-project-preview-direction="next"]').click()`);
  const filmstripAfterNext = await waitFor(() => evaluate(cdp, `(() => {
    const shell = document.querySelector('.project-card[data-project-id="${filmstripProject.projectId}"]')?.closest('.project-card-shell');
    const strip = shell?.querySelector('[data-project-preview-strip]');
    const previous = shell?.querySelector('[data-project-preview-direction="previous"]');
    const revealedSlide = strip?.querySelector('[data-project-preview-slide-id=${JSON.stringify(filmstripSlideIds[5])}] img.thumb-rendered');
    return strip?.scrollLeft > 2 && previous && !previous.hidden && revealedSlide
      ? { pathname: location.pathname, scrollLeft: strip.scrollLeft }
      : false;
  })()`), "The project filmstrip did not scroll right or reveal its previous control.");
  if (filmstripAfterNext.pathname !== "/") throw new Error(`The filmstrip control opened the project: ${JSON.stringify(filmstripAfterNext)}`);
  const revealedPixel = await evaluate(cdp, `(async () => {
    const image = document.querySelector('.project-card[data-project-id="${filmstripProject.projectId}"] [data-project-preview-slide-id=${JSON.stringify(filmstripSlideIds[5])}] img.thumb-rendered');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  })()`);
  if (revealedPixel.some((channel, index) => Math.abs(channel - [10, 10, 10, 255][index]) > 3)) {
    throw new Error(`A stale off-screen render replaced the updated filmstrip slide: ${JSON.stringify(revealedPixel)}`);
  }

  const filmstripAtEnd = await evaluate(cdp, `(() => {
    const shell = document.querySelector('.project-card[data-project-id="${filmstripProject.projectId}"]').closest('.project-card-shell');
    const strip = shell.querySelector('[data-project-preview-strip]');
    const next = shell.querySelector('[data-project-preview-direction="next"]');
    next.focus();
    strip.scrollLeft = strip.scrollWidth;
    strip.dispatchEvent(new Event('scroll'));
    const previous = shell.querySelector('[data-project-preview-direction="previous"]');
    return { scrollLeft: strip.scrollLeft, maxScrollLeft: strip.scrollWidth - strip.clientWidth, previousHidden: previous.hidden, nextHidden: next.hidden, focusDirection: document.activeElement?.dataset.projectPreviewDirection };
  })()`);
  if (Math.abs(filmstripAtEnd.scrollLeft - filmstripAtEnd.maxScrollLeft) > 2 || filmstripAtEnd.previousHidden || !filmstripAtEnd.nextHidden || filmstripAtEnd.focusDirection !== "previous") {
    throw new Error(`The project filmstrip controls did not reflect its final edge: ${JSON.stringify(filmstripAtEnd)}`);
  }
  await waitFor(
    () => evaluate(cdp, `Boolean(document.querySelector('.project-card[data-project-id="${filmstripProject.projectId}"] [data-project-preview-slide-id=${JSON.stringify(filmstripSlideIds.at(-1))}] img.thumb-rendered'))`),
    "The project filmstrip did not render the newly revealed final slide.",
  );
  await evaluate(cdp, `document.querySelector('.project-card[data-project-id="${filmstripProject.projectId}"]').closest('.project-card-shell').querySelector('[data-project-preview-direction="previous"]').click()`);
  await waitFor(
    () => evaluate(cdp, `(() => {
      const strip = document.querySelector('.project-card[data-project-id="${filmstripProject.projectId}"]')?.closest('.project-card-shell')?.querySelector('[data-project-preview-strip]');
      return strip && strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 2;
    })()`),
    "The project filmstrip did not scroll back to the left.",
  );
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
  const narrowFilmstrip = await waitFor(() => evaluate(cdp, `(() => {
    const shell = document.querySelector('.project-card[data-project-id="${filmstripProject.projectId}"]')?.closest('.project-card-shell');
    const strip = shell?.querySelector('[data-project-preview-strip]');
    if (!strip) return false;
    strip.scrollLeft = 0;
    strip.dispatchEvent(new Event('scroll'));
    const next = shell.querySelector('[data-project-preview-direction="next"]');
    const meta = shell.querySelector('.project-meta');
    const title = meta?.querySelector('strong');
    const details = meta?.lastElementChild;
    return !next.hidden ? {
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      cardWidth: shell.getBoundingClientRect().width,
      overflow: strip.scrollWidth > strip.clientWidth + 2,
      titleTruncated: title && title.scrollWidth > title.clientWidth,
      detailsWhiteSpace: details && getComputedStyle(details).whiteSpace,
      detailsWrapped: details && details.scrollHeight > details.clientHeight + 1,
      metaOverflows: meta && meta.scrollWidth > meta.clientWidth + 1,
    } : false;
  })()`), "The project filmstrip controls did not adapt to the narrow dashboard layout.");
  if (
    narrowFilmstrip.documentWidth > narrowFilmstrip.viewportWidth + 1
    || !narrowFilmstrip.overflow
    || narrowFilmstrip.cardWidth > narrowFilmstrip.viewportWidth
    || !narrowFilmstrip.titleTruncated
    || narrowFilmstrip.detailsWhiteSpace !== "nowrap"
    || narrowFilmstrip.detailsWrapped
    || narrowFilmstrip.metaOverflows
  ) {
    throw new Error(`The narrow project filmstrip caused page-level overflow: ${JSON.stringify(narrowFilmstrip)}`);
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await waitFor(() => evaluate(cdp, "innerWidth > 1000"), "The browser viewport did not return to its desktop size.");
  const nonOverflowingPreview = await waitFor(() => evaluate(cdp, `(() => {
    const shell = document.querySelector('.project-card[data-project-id=${JSON.stringify(projectId)}]')?.closest('.project-card-shell');
    const strip = shell?.querySelector('[data-project-preview-strip]');
    if (!strip) return false;
    const value = {
      overflow: strip.scrollWidth > strip.clientWidth + 2,
      visibleControls: [...shell.querySelectorAll('[data-project-preview-direction]')].filter((button) => !button.hidden).length,
    };
    return !value.overflow && value.visibleControls === 0 ? value : false;
  })()`), "A non-overflowing project preview did not hide its scroll controls after resizing.");
  if (!nonOverflowingPreview || nonOverflowingPreview.overflow || nonOverflowingPreview.visibleControls !== 0) {
    throw new Error(`A non-overflowing project preview showed scroll controls: ${JSON.stringify(nonOverflowingPreview)}`);
  }
  await callPageFunction(cdp, `function(projectId) {
    return this.carouselBotAgent.execute({ type: 'project.delete', projectId });
  }`, [filmstripProject.projectId]);

  const folderUiProject = await evaluate(cdp, `window.carouselBotAgent.execute({ type: 'project.create', name: 'Folder UI project' })`);
  const folderUiSlide = await callPageFunction(cdp, `function(projectId) {
    return this.carouselBotAgent.execute({
      type: 'slide.add',
      projectId,
      name: 'Folder cover',
      backgroundColor: '#25F4EE'
    });
  }`, [folderUiProject.projectId]);
  if (!folderUiSlide?.createdSlideId) throw new Error(`Could not create the folder UI cover slide: ${JSON.stringify(folderUiSlide)}`);
  await waitFor(
    () => evaluate(cdp, `[...document.querySelectorAll('.project-card .project-meta strong')].some((item) => item.textContent === 'Folder UI project')`),
    "The dashboard did not render the project used for folder UI coverage.",
  );
  await evaluate(cdp, `(() => {
    const card = [...document.querySelectorAll('.project-card')].find((item) => item.querySelector('.project-meta strong')?.textContent === 'Folder UI project');
    const rect = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    [...document.querySelectorAll('.layer-menu-item')].find((item) => item.textContent.includes('Move to folder')).click();
    const input = document.querySelector('[data-folder-move-form] input[name="folderPath"]');
    input.value = '/native-folder';
    document.querySelector('[data-folder-move-form]').requestSubmit();
    return true;
  })()`);
  const nativeFolderCard = await waitFor(() => evaluate(cdp, `(() => {
    const card = document.querySelector('.folder-card[data-folder-path="/native-folder"]');
    if (!card || card.querySelectorAll('.folder-preview-slot').length !== 8 || !card.querySelector('.folder-meta-name svg')) return false;
    if ([...document.querySelectorAll('.project-card .project-meta strong')].some((item) => item.textContent === 'Folder UI project')) return false;
    return { href: card.getAttribute('href'), name: card.querySelector('.folder-meta-name')?.textContent.trim() };
  })()`), "Moving a project into a new folder did not render its eight-slot folder card.");
  if (nativeFolderCard.name !== "/native-folder" || nativeFolderCard.href !== "/folders/native-folder") throw new Error(`Folder card metadata was incorrect: ${JSON.stringify(nativeFolderCard)}`);
  await waitFor(
    () => evaluate(cdp, `Boolean(document.querySelector('.folder-card[data-folder-path="/native-folder"] [data-project-cover-id="${folderUiProject.projectId}"] img[data-composite-cover="true"]'))`),
    "The folder card did not compose the first slide into its mosaic.",
  );
  await evaluate(cdp, `document.querySelector('.folder-card[data-folder-path="/native-folder"]').click()`);
  await waitFor(
    () => evaluate(cdp, `location.pathname === '/folders/native-folder' && document.querySelector('.folder-dashboard-title')?.textContent.trim() === '/native-folder'`),
    "Opening the folder card did not show its dashboard route.",
  );
  await evaluate(cdp, "window.__carouselBotFolderReloadSentinel = true");
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(
    () => evaluate(cdp, `document.readyState === 'complete' && !window.__carouselBotFolderReloadSentinel && window.carouselBotAgent && location.pathname === '/folders/native-folder' && document.querySelector('.folder-dashboard-title')?.textContent.trim() === '/native-folder' && [...document.querySelectorAll('.project-card .project-meta strong')].some((item) => item.textContent === 'Folder UI project')`),
    "The folder deep route did not survive a reload.",
  );
  await evaluate(cdp, `(() => {
    const card = [...document.querySelectorAll('.project-card')].find((item) => item.querySelector('.project-meta strong')?.textContent === 'Folder UI project');
    const rect = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    [...document.querySelectorAll('.layer-menu-item')].find((item) => item.textContent.includes('Move to folder')).click();
    const input = document.querySelector('[data-folder-move-form] input[name="folderPath"]');
    input.value = '';
    document.querySelector('[data-folder-move-form]').requestSubmit();
    return true;
  })()`);
  await waitFor(
    () => callPageFunction(cdp, `function(projectId) {
      return location.pathname === '/'
        && !document.querySelector('.folder-card[data-folder-path="/native-folder"]')
        && this.carouselBotAgent.inspect().projects.find((item) => item.id === projectId)?.folderPath === null;
    }`, [folderUiProject.projectId]),
    "Moving the final project out did not remove the implicit folder and return to the dashboard.",
  );
  await callPageFunction(cdp, `function(projectId) {
    return this.carouselBotAgent.execute({ type: 'project.delete', projectId });
  }`, [folderUiProject.projectId]);

  const deletionProject = await evaluate(cdp, `window.carouselBotAgent.execute({ type: 'project.create', name: 'Dashboard deletion check' })`);
  await waitFor(
    () => evaluate(cdp, `[...document.querySelectorAll('.project-card .project-meta strong')].some((item) => item.textContent === 'Dashboard deletion check')`),
    "The dashboard did not render the project used for native deletion coverage.",
  );
  const openProjectDeleteConfirmation = `(() => {
    const card = [...document.querySelectorAll('.project-card')].find((item) => item.querySelector('.project-meta strong')?.textContent === 'Dashboard deletion check');
    const rect = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
    document.querySelector('.layer-menu-item[aria-label="Remove Dashboard deletion check"]').click();
    return Boolean(document.querySelector('.project-delete-confirmation'));
  })()`;
  if (!await evaluate(cdp, openProjectDeleteConfirmation)) throw new Error("The dashboard project delete confirmation did not open.");
  await evaluate(cdp, `document.querySelector('[data-action="cancel-project-delete"]').click()`);
  const cancellation = await evaluate(cdp, `({
    modalClosed: !document.querySelector('.project-delete-confirmation'),
    projectPresent: window.carouselBotAgent.inspect().projects.some((item) => item.id === ${JSON.stringify(deletionProject.projectId)}),
  })`);
  if (!cancellation.modalClosed || !cancellation.projectPresent) {
    throw new Error(`Cancelling native project deletion changed the project: ${JSON.stringify(cancellation)}`);
  }
  if (!await evaluate(cdp, openProjectDeleteConfirmation)) throw new Error("The dashboard project delete confirmation did not reopen.");
  await evaluate(cdp, `document.querySelector('[data-action="confirm-project-delete"]').click()`);
  await waitFor(
    () => evaluate(cdp, `new Promise((resolve) => {
      if (window.carouselBotAgent.inspect().projects.some((item) => item.id === ${JSON.stringify(deletionProject.projectId)})) return resolve(false);
      const request = indexedDB.open('carouselbot-db');
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const item = request.result.transaction('projects', 'readonly').objectStore('projects').get(${JSON.stringify(deletionProject.projectId)});
        item.onerror = () => resolve(false);
        item.onsuccess = () => resolve(item.result == null && ![...document.querySelectorAll('.project-card')].some((card) => card.dataset.projectId === ${JSON.stringify(deletionProject.projectId)}));
      };
    })`),
    "Confirming native project deletion did not remove it from IndexedDB and the dashboard.",
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
    nativeClipboard: true,
    imageUpload: true,
    keyboardSlideNavigation: true,
    nativeSlideLifecycle: true,
    nativeOutputActions: true,
    nativeProjectDeletion: true,
    dashboardProjectFilmstrip: true,
    nativeFolderOrganization: true,
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
