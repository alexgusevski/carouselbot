import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const root = new URL("..", import.meta.url);
const rootPath = root.pathname;
const deployed = process.argv.includes("--deployed");
const configuredPageUrl = process.env.CAROUSELBOT_TEST_URL || process.env.SLIDE_STUDIO_TEST_URL || "";
const localPagePort = !deployed && !configuredPageUrl ? await availablePort() : null;
const pageUrl = deployed
  ? "https://slides-editor.pages.dev"
  : configuredPageUrl || `http://127.0.0.1:${localPagePort}`;
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const debuggingPort = 19229;
const profile = await mkdtemp(join(tmpdir(), "carouselbot-browser-"));
const stateDirectory = await mkdtemp(join(tmpdir(), "carouselbot-daemon-"));
const exportPath = join(profile, "agent-export.png");
const projectExportDirectory = join(profile, "project-export");
const sharedDaemon = process.argv.includes("--shared-daemon");
const bridgePort = sharedDaemon ? 43117 : 48000 + Math.floor(Math.random() * 1000);
const env = sharedDaemon ? process.env : {
  ...process.env,
  CAROUSELBOT_STATE_DIR: stateDirectory,
  CAROUSELBOT_BRIDGE_PORT: String(bridgePort),
  CAROUSELBOT_ALLOWED_ORIGINS: [process.env.CAROUSELBOT_ALLOWED_ORIGINS, new URL(pageUrl).origin].filter(Boolean).join(","),
};
const browserPageUrl = sharedDaemon ? pageUrl : `${pageUrl}${pageUrl.includes("?") ? "&" : "?"}__mcpBridgePort=${bridgePort}`;
const web = localPagePort
  ? spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, CAROUSELBOT_PORT: String(localPagePort) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  : null;
const mcp = spawn(process.execPath, ["packages/mcp/src/cli.mjs", "serve"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
let diagnostics = "";
let editSessionId = null;

async function availablePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

for (const child of [web, mcp].filter(Boolean)) {
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
}

let output = "";
let requestId = 0;
const replies = new Map();
mcp.stdout.setEncoding("utf8");
mcp.stdout.on("data", (chunk) => {
  output += chunk;
  let newline;
  while ((newline = output.indexOf("\n")) >= 0) {
    const line = output.slice(0, newline).trim();
    output = output.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    replies.get(message.id)?.(message);
    replies.delete(message.id);
  }
});

function rpc(method, params = {}, timeout = 100_000) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeout);
    replies.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function tool(name, args = {}) {
  const sessionExempt = new Set(["get_design_guidance", "list_editors", "list_edit_sessions", "list_recent_operations", "begin_edit_session", "end_edit_session"]);
  const arguments_ = editSessionId && !sessionExempt.has(name) ? { ...args, editSessionId } : args;
  const result = await rpc("tools/call", { name, arguments: arguments_ });
  if (result.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
  return result;
}

const chrome = spawn(chromePath, [
  "--headless=new", "--disable-background-networking", "--disable-component-update", "--disable-breakpad",
  "--disable-crash-reporter", "--noerrdialogs", "--no-first-run",
  "--no-default-browser-check", "--window-size=2400,1800", `--remote-debugging-port=${debuggingPort}`,
  `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
chrome.stderr.setEncoding("utf8");
chrome.stderr.on("data", (chunk) => { diagnostics += chunk; });

async function waitForJson(path) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}${path}`);
      if (response.ok) return response.json();
    } catch { /* Chrome is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome DevTools endpoint did not start.");
}

async function closeChromeGracefully() {
  if (chrome.exitCode != null) return;
  let control;
  try {
    const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/version`);
    if (!response.ok) return;
    const version = await response.json();
    control = connectCdp(version.webSocketDebuggerUrl);
    await control.ready;
    await Promise.race([
      control.send("Browser.close").catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    await Promise.race([
      new Promise((resolve) => chrome.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch { /* Chrome may already be closing. */ }
  finally { control?.close(); }
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
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

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
  return result.result?.value;
}

async function waitFor(predicate, message, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${message}\n${diagnostics.slice(-3000)}`);
}

async function boxedLineGeometry(cdp, textId) {
  return evaluate(cdp, `(() => {
    const box = document.querySelector('.text-box[data-text-id="${textId}"]');
    const content = box?.querySelector('.text-visual--inside .text-content');
    const line = content?.querySelector('.text-line');
    const path = content?.querySelector('.text-background path');
    if (!box || !content || !line || !path || !line.firstChild) return {
      ready: false,
      hasBox: Boolean(box),
      hasContent: Boolean(content),
      hasLine: Boolean(line),
      hasPath: Boolean(path),
      contentHtml: content?.innerHTML || null,
    };
    const range = document.createRange();
    range.selectNodeContents(line);
    const lineStyle = getComputedStyle(line);
    const contentRect = content.getBoundingClientRect();
    const pathRect = path.getBoundingClientRect();
    const textRect = range.getBoundingClientRect();
    if (contentRect.width <= 0 || pathRect.width <= 0 || textRect.width <= 0) return {
      ready: false,
      reason: "zero geometry",
      contentWidth: contentRect.width,
      pathWidth: pathRect.width,
      cssPaddingLeft: parseFloat(lineStyle.paddingLeft) || 0,
      cssPaddingRight: parseFloat(lineStyle.paddingRight) || 0,
      textWidth: textRect.width,
      boxWidth: box.getBoundingClientRect().width,
    };
    return {
      ready: true,
      align: box.dataset.align,
      alignItems: getComputedStyle(content).alignItems,
      contentLeft: contentRect.left,
      contentRight: contentRect.right,
      pathLeft: pathRect.left,
      pathRight: pathRect.right,
      pathWidth: pathRect.width,
      cssPaddingLeft: parseFloat(lineStyle.paddingLeft) || 0,
      cssPaddingRight: parseFloat(lineStyle.paddingRight) || 0,
      leftPadding: textRect.left - pathRect.left,
      rightPadding: pathRect.right - textRect.right,
    };
  })()`);
}

let cdp;
let secondCdp;
const additionalCdps = [];
try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Codex browser test", version: "1" } });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  const protocol = await waitForJson("/json/protocol");
  const localPermissions = (protocol.domains.find((domain) => domain.domain === "Browser")?.types.find((type) => type.id === "PermissionType")?.enum || []).filter((value) => /local|loopback/i.test(value));
  const pages = await waitForJson("/json/list");
  cdp = connectCdp(pages[0].webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  if (localPermissions.length) await cdp.send("Browser.grantPermissions", { permissions: localPermissions, origin: new URL(pageUrl).origin });
  await cdp.send("Page.navigate", { url: browserPageUrl });
  await waitFor(() => evaluate(cdp, "document.readyState === 'complete' && Boolean(window.carouselBotAgent) && Boolean(document.querySelector('[data-action=\"connect-agent\"]'))"), "Editor scripts did not load.");
  await evaluate(cdp, "window.carouselBotReady");
  const initialConnection = await evaluate(cdp, `({
    buttonStatus: document.querySelector('[data-action="connect-agent"]')?.dataset.mcpStatus || "idle",
    remembered: localStorage.getItem("carouselbot:mcp-connected"),
    editorId: window.carouselBotLocalMcpBridge.getState().editorId
  })`);
  const initialEditors = (await tool("list_editors")).structuredContent.editors;
  if (initialConnection.buttonStatus !== "idle" || initialConnection.remembered !== null || initialEditors.some((editor) => editor.id === initialConnection.editorId)) {
    throw new Error(`The browser contacted MCP before the user opted in: ${JSON.stringify({ initialConnection, initialEditors })}`);
  }
  await evaluate(cdp, `document.querySelector('[data-action="connect-agent"]').click()`);
  await waitFor(() => evaluate(cdp, `Boolean(document.querySelector('[data-local-mcp-connect]'))`), "MCP connection dialog did not open.");
  const statusAlignment = await evaluate(cdp, `(() => {
    const status = document.querySelector(".agent-connect-actions .agent-connection-status");
    const style = status && getComputedStyle(status);
    return style ? { justifySelf: style.justifySelf, justifyContent: style.justifyContent, textAlign: style.textAlign } : null;
  })()`);
  if (statusAlignment?.justifySelf !== "start" || statusAlignment.justifyContent !== "flex-start" || statusAlignment.textAlign !== "left") throw new Error(`MCP connection status is not left-aligned: ${JSON.stringify(statusAlignment)}`);
  await evaluate(cdp, `document.querySelector('[data-local-mcp-connect]').click()`);
  await waitFor(async () => (await tool("list_editors")).structuredContent.editors.some((editor) => editor.id === initialConnection.editorId), "Editor did not connect.");
  const remembered = await evaluate(cdp, `localStorage.getItem("carouselbot:mcp-connected")`);
  if (remembered !== "1") throw new Error("Successful MCP connection was not remembered.");
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(() => evaluate(cdp, `document.readyState === "complete" && document.querySelector('[data-action="connect-agent"]')?.dataset.mcpStatus === "connected"`), "Remembered MCP connection did not resume after reload.");
  await tool("get_design_guidance");
  const connectedEditors = (await tool("list_editors")).structuredContent.editors;
  const testEditor = connectedEditors.find((editor) => editor.id === initialConnection.editorId);
  const editSession = (await tool("begin_edit_session", { editorId: testEditor.id, purpose: "Full browser integration test" })).structuredContent;
  editSessionId = editSession.id;
  await tool("show_notification", { message: "Hello from the full local MCP", tone: "success" });
  const agentNotification = await evaluate(cdp, `(() => {
    window.carouselBotLocalMcpBridge.notify("Identity icon regression", "success", { name: "Codex browser test" });
    const item = [...document.querySelectorAll("#agent-activity-stack .agent-activity")].find((entry) => entry.textContent.includes("Identity icon regression"));
    return item ? { label: item.querySelector("strong")?.textContent, icon: item.querySelector(".agent-activity-icon img")?.getAttribute("src") } : null;
  })()`);
  if (agentNotification.label !== "Codex" || !agentNotification.icon?.includes("codex-logo-colored")) throw new Error(`MCP notification used the wrong client identity: ${JSON.stringify(agentNotification)}`);

  await evaluate(cdp, "document.querySelector('[data-action=\"home\"]')?.click()");
  await waitFor(() => evaluate(cdp, "Boolean(document.querySelector('.dashboard'))"), "Dashboard did not open.");
  await evaluate(cdp, `(() => {
    window.__carouselBotOriginalRequestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    return true;
  })()`);
  let createdProject;
  try {
    createdProject = (await tool("create_project", { name: "Full MCP browser test" })).structuredContent;
  } finally {
    await evaluate(cdp, `(() => {
      window.requestAnimationFrame = window.__carouselBotOriginalRequestAnimationFrame;
      delete window.__carouselBotOriginalRequestAnimationFrame;
      return true;
    })()`);
  }
  const dashboardUpdated = await evaluate(cdp, `({
    dashboardVisible: Boolean(document.querySelector('.dashboard')),
    projectNames: [...document.querySelectorAll('.project-card .project-meta strong')].map((item) => item.textContent)
  })`);
  if (!dashboardUpdated.dashboardVisible || !dashboardUpdated.projectNames.includes("Full MCP browser test")) throw new Error(`Dashboard did not update live: ${JSON.stringify(dashboardUpdated)}`);
  const dashboardProjectNotification = await waitFor(() => evaluate(cdp, `(() => {
    const item = [...document.querySelectorAll("#agent-activity-stack .agent-activity--success")].find((entry) => entry.textContent.includes("Created Full MCP browser test"));
    return item ? { label: item.querySelector("strong")?.textContent, icon: item.querySelector(".agent-activity-icon img")?.getAttribute("src") } : null;
  })()`), "MCP-created project did not show a dashboard notification.");
  if (dashboardProjectNotification.label !== "Codex" || !dashboardProjectNotification.icon?.includes("codex-logo-colored")) throw new Error(`Dashboard project notification used the wrong client identity: ${JSON.stringify(dashboardProjectNotification)}`);
  const addedSlide = (await tool("add_slide", { projectId: createdProject.projectId, name: "Live automation", backgroundColor: "#25282E" })).structuredContent;
  const dashboardAfterSlide = await evaluate(cdp, `({ pathname: location.pathname, dashboardVisible: Boolean(document.querySelector('.dashboard')), slideCount: [...document.querySelectorAll('.project-card')].find((card) => card.querySelector('.project-meta strong')?.textContent === 'Full MCP browser test')?.querySelector('.project-meta span')?.textContent })`);
  if (dashboardAfterSlide.pathname !== "/" || !dashboardAfterSlide.dashboardVisible || !dashboardAfterSlide.slideCount?.startsWith("1 slide")) throw new Error(`Adding a slide changed the dashboard view: ${JSON.stringify(dashboardAfterSlide)}`);
  await tool("open_project", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId });
  await waitFor(() => evaluate(cdp, "document.querySelector('.project-title-input')?.value === 'Full MCP browser test'"), "Explicitly opening the project did not show the editor.");
  const addedText = (await tool("add_text", {
    projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, text: "Built live by an AI agent",
    x: 0.1, y: 0.2, width: 0.8, height: 0.16, size: 82, style: "boxed", background: "black", backgroundShape: "lines", color: "#FFFFFF",
  })).structuredContent;
  const imported = (await tool("import_asset", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, path: join(rootPath, "assets", "favicon.svg"), name: "CarouselBot mark" })).structuredContent;
  const image = (await tool("add_image", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, assetId: imported.assetId, x: 0.34, y: 0.52, width: 0.32, rotation: 6 })).structuredContent;
  const batch = await tool("apply_operations", { operations: [
    { tool: "add_text", arguments: { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, text: "Claude · Codex · Hermes · OpenCode · OpenClaw", x: 0.1, y: 0.76, width: 0.8, height: 0.1, size: 44, style: "plain", color: "#25F4EE" } },
    { tool: "update_text", arguments: { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, updates: [{ id: addedText.createdTextId, text: "Built live through MCP" }] } },
  ] });
  const supportingTextId = batch.structuredContent.results[0].createdTextId;

  const visible = await evaluate(cdp, `({
    title: document.querySelector('.project-title-input')?.value,
    texts: [...document.querySelectorAll('.text-content')].map((item) => item.textContent),
    connected: document.querySelector('[data-action="connect-agent"]')?.dataset.mcpStatus,
    imageCount: document.querySelectorAll('.overlay-box').length
  })`);
  if (visible.title !== "Full MCP browser test" || !visible.texts.includes("Built live through MCP") || visible.connected !== "connected" || visible.imageCount !== 1) throw new Error(`Live DOM did not match: ${JSON.stringify(visible)}`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  const compactToolbar = await waitFor(() => evaluate(cdp, `(() => {
    const projectIdentity = document.querySelector(".project-identity");
    const airdrop = document.querySelector(".airdrop-icon");
    const github = document.querySelector(".github-mark");
    if (!projectIdentity || !airdrop || !github) return null;
    return {
      projectTitleDisplay: getComputedStyle(projectIdentity).display,
      hasMobileEditButton: Boolean(document.querySelector(".mobile-edit-button")),
      airdropWidth: getComputedStyle(airdrop).width,
      airdropRadius: getComputedStyle(airdrop).borderRadius,
      githubWidth: getComputedStyle(github).width,
    };
  })()`), "Compact editor toolbar did not render.");
  if (compactToolbar.projectTitleDisplay !== "none" || compactToolbar.hasMobileEditButton || compactToolbar.airdropWidth !== "25px" || compactToolbar.airdropRadius !== "50%" || compactToolbar.githubWidth !== "25px") throw new Error(`Compact toolbar regression: ${JSON.stringify(compactToolbar)}`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 2400, height: 1800, deviceScaleFactor: 1, mobile: false });

  for (const [align, expectedAlignItems] of [["left", "flex-start"], ["right", "flex-end"]]) {
    try {
      await tool("update_text", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, updates: [{ id: addedText.createdTextId, align }] });
    } catch (error) {
      const browserState = await evaluate(cdp, `({ bridge: window.carouselBotLocalMcpBridge?.getState(), ready: document.readyState, visible: document.visibilityState })`).catch(() => null);
      const audit = await tool("list_recent_operations", { limit: 10 }).then((result) => result.structuredContent).catch(() => null);
      throw new Error(`${error.message}\nBrowser state: ${JSON.stringify(browserState)}\nRecent operations: ${JSON.stringify(audit)}`);
    }
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(() => evaluate(cdp, `document.readyState === "complete" && document.querySelector('.project-title-input')?.value === "Full MCP browser test" && document.querySelector('[data-action="connect-agent"]')?.dataset.mcpStatus === "connected"`), `Editor did not restore after the ${align}-alignment reload.`);
    await evaluate(cdp, `document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
    let latestGeometry = null;
    const geometry = await waitFor(async () => {
      latestGeometry = await boxedLineGeometry(cdp, addedText.createdTextId);
      return latestGeometry?.ready && Math.abs(latestGeometry.leftPadding - latestGeometry.rightPadding) <= 2
        ? latestGeometry
        : null;
    }, `Boxed ${align}-aligned text did not render after reload.`).catch((error) => {
      throw new Error(`${error.message}\nLast geometry state: ${JSON.stringify(latestGeometry)}`);
    });
    const alignedEdgeDelta = align === "left"
      ? Math.abs(geometry.pathLeft - geometry.contentLeft)
      : Math.abs(geometry.pathRight - geometry.contentRight);
    const minimumPadding = Math.max(0.002, geometry.pathWidth * 0.01);
    const paddingTolerance = 2;
    if (geometry.align !== align || geometry.alignItems !== expectedAlignItems || alignedEdgeDelta > paddingTolerance || geometry.leftPadding < minimumPadding || geometry.rightPadding < minimumPadding || Math.abs(geometry.leftPadding - geometry.rightPadding) > paddingTolerance || Math.abs(geometry.cssPaddingLeft - geometry.cssPaddingRight) > 0.001) {
      throw new Error(`Boxed ${align}-aligned text padding changed after reload: ${JSON.stringify(geometry)}`);
    }
  }

  await tool("update_image", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, updates: [{ id: image.createdImageId, x: 0.31, y: 0.5, width: 0.36, rotation: 12, cropX: 0.05, cropY: 0.05, cropW: 0.9, cropH: 0.9 }] });
  await tool("update_asset", { projectId: createdProject.projectId, assetId: imported.assetId, name: "Verified mark" });
  const duplicated = (await tool("duplicate_layers", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, layerIds: [supportingTextId, image.createdImageId], offsetX: 0.02, offsetY: 0.02 })).structuredContent;
  let layerState = (await tool("inspect_editor", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId })).structuredContent.slide;
  const orderedLayerIds = [...layerState.images.map((item) => item.id), ...layerState.texts.map((item) => item.id)].reverse();
  await tool("reorder_layers", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, layerIds: orderedLayerIds });
  await tool("delete_layers", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, layerIds: duplicated.createdLayers.map((item) => item.id) });

  await tool("update_text", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, updates: [{ id: addedText.createdTextId, text: "Undo and redo verified" }] });
  await tool("undo", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId });
  layerState = (await tool("inspect_editor", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId })).structuredContent.slide;
  if (layerState.texts.find((item) => item.id === addedText.createdTextId)?.text !== "Built live through MCP") throw new Error("Undo did not restore the previous text.");
  await tool("redo", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId });
  layerState = (await tool("inspect_editor", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId })).structuredContent.slide;
  if (layerState.texts.find((item) => item.id === addedText.createdTextId)?.text !== "Undo and redo verified") throw new Error("Redo did not restore the changed text.");
  await tool("set_view", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, canvasZoom: 0.8, showTikTokOverlay: true });

  const temporaryAsset = (await tool("import_asset", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, path: join(rootPath, "assets", "airdrop.svg"), name: "Temporary asset" })).structuredContent;
  await tool("add_image", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, assetId: temporaryAsset.assetId, x: 0.05, y: 0.55, width: 0.2 });
  await tool("delete_asset", { projectId: createdProject.projectId, assetId: temporaryAsset.assetId });

  const duplicatedSlide = (await tool("duplicate_slide", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, name: "Second automated slide" })).structuredContent;
  await tool("update_slide", { projectId: createdProject.projectId, slideId: duplicatedSlide.createdSlideId, name: "Updated second slide", backgroundPath: join(rootPath, "assets", "airdrop.svg"), imageScale: 1.2, imageX: 0.05, imageY: -0.04 });
  await tool("reorder_slides", { projectId: createdProject.projectId, slideIds: [duplicatedSlide.createdSlideId, addedSlide.createdSlideId] });

  const rendered = await tool("render_slide", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, width: 360 });
  const imageContent = rendered.content.find((item) => item.type === "image");
  if (!imageContent?.data || imageContent.data.length < 1000 || imageContent.mimeType !== "image/png") throw new Error("Rendered preview did not return MCP image content.");
  await tool("export_slide", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, outputPath: exportPath });
  if ((await stat(exportPath)).size < 10_000) throw new Error("Exported PNG is unexpectedly small.");
  await tool("export_slide", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, outputPath: exportPath })
    .then(() => { throw new Error("Export unexpectedly overwrote an existing file."); })
    .catch((error) => { if (!/already exists/.test(error.message)) throw error; });
  const exportedProject = (await tool("export_project", { projectId: createdProject.projectId, outputDirectory: projectExportDirectory })).structuredContent;
  if (exportedProject.fileCount !== 2 || (await readdir(projectExportDirectory)).filter((name) => name.endsWith(".png")).length !== 2) throw new Error("Project export did not write both slides.");
  await tool("delete_slide", { projectId: createdProject.projectId, slideId: duplicatedSlide.createdSlideId });
  await tool("update_project", { projectId: createdProject.projectId, name: "Full MCP verified" });
  await tool("end_edit_session", { editSessionId });
  editSessionId = null;
  const pinnedView = await evaluate(cdp, `({ pathname: location.pathname, title: document.querySelector('.project-title-input')?.value, slideId: window.carouselBotAgent.inspect({ includeAllProjects: false }).activeSlideId })`);
  editSessionId = (await tool("begin_edit_session", { editorId: testEditor.id, purpose: "Verify background project edits preserve the current view" })).structuredContent.id;
  const temporaryProject = (await tool("create_project", { name: "Temporary project" })).structuredContent;
  const temporarySlide = (await tool("add_slide", { projectId: temporaryProject.projectId, name: "Background edit", backgroundColor: "#18181B" })).structuredContent;
  const perLineText = (await tool("add_text", { projectId: temporaryProject.projectId, slideId: temporarySlide.createdSlideId, text: "Edited without taking over", role: "subtitle", x: 0.1, y: 0.2, width: 0.8, height: 0.16, style: "boxed", background: "black", color: "#FFFFFF" })).structuredContent;
  const autoFitText = (await tool("add_text", { projectId: temporaryProject.projectId, slideId: temporarySlide.createdSlideId, text: "Short body copy.", role: "body", x: 0.14, y: 0.5, width: 0.72, height: 0.045, style: "boxed", background: "black", color: "#FFFFFF" })).structuredContent;
  const autoFitBefore = (await tool("inspect_editor", { projectId: temporaryProject.projectId, slideId: temporarySlide.createdSlideId })).structuredContent.slide.texts.find((text) => text.id === autoFitText.createdTextId);
  const autoFitUpdate = (await tool("update_text", { projectId: temporaryProject.projectId, slideId: temporarySlide.createdSlideId, updates: [{ id: autoFitText.createdTextId, text: "Most chatbots make you paste the thread, name the project, and fake your own voice. This private memory layer already understands what you have been working on across apps, tabs, documents, and meetings. Press a shortcut in any text field to write a reply, summarize messy work, recall something you saw, or rewrite a highlight without touching the rest." }] })).structuredContent;
  const fullBoxText = (await tool("add_text", { projectId: temporaryProject.projectId, slideId: temporarySlide.createdSlideId, text: "A full box should fit this body copy instead of leaving a huge empty rectangle around it.", role: "body", x: 0.1, y: 0.42, width: 0.8, height: 0.48, style: "boxed", background: "black", backgroundShape: "full", align: "left", color: "#FFFFFF" })).structuredContent;
  const fitted = (await tool("fit_text_boxes", { projectId: temporaryProject.projectId, slideId: temporarySlide.createdSlideId, textIds: [fullBoxText.createdTextId] })).structuredContent;
  const backgroundSlide = (await tool("inspect_editor", { projectId: temporaryProject.projectId, slideId: temporarySlide.createdSlideId })).structuredContent.slide;
  const perLineLayer = backgroundSlide.texts.find((text) => text.id === perLineText.createdTextId);
  const autoFitLayer = backgroundSlide.texts.find((text) => text.id === autoFitText.createdTextId);
  const fullBoxLayer = backgroundSlide.texts.find((text) => text.id === fullBoxText.createdTextId);
  if (perLineLayer?.role !== "subtitle" || perLineLayer.size !== 76 || perLineLayer.backgroundShape !== "lines") throw new Error(`Role defaults or per-line preference failed: ${JSON.stringify(perLineLayer)}`);
  if (!autoFitText.fittedTextBox?.automatic || !autoFitUpdate.fittedTextBoxes?.[0]?.automatic || autoFitLayer.height <= autoFitBefore.height || autoFitLayer.y + autoFitLayer.height > 1.0001) throw new Error(`Automatic MCP text-height fitting failed: ${JSON.stringify({ autoFitText, autoFitBefore, autoFitUpdate, autoFitLayer })}`);
  if (fullBoxLayer?.role !== "body" || fullBoxLayer.size !== 60 || fullBoxLayer.height >= 0.48 || fitted.fittedTextBoxes?.[0]?.id !== fullBoxText.createdTextId) throw new Error(`Full-box content fitting failed: ${JSON.stringify({ fullBoxLayer, fitted })}`);
  const preservedView = await evaluate(cdp, `({ pathname: location.pathname, title: document.querySelector('.project-title-input')?.value, slideId: window.carouselBotAgent.inspect({ includeAllProjects: false }).activeSlideId })`);
  if (JSON.stringify(preservedView) !== JSON.stringify(pinnedView)) throw new Error(`Background project edits changed the user's view: ${JSON.stringify({ pinnedView, preservedView })}`);
  await tool("delete_project", { projectId: temporaryProject.projectId });
  const viewAfterBackgroundDelete = await evaluate(cdp, `({ pathname: location.pathname, title: document.querySelector('.project-title-input')?.value, slideId: window.carouselBotAgent.inspect({ includeAllProjects: false }).activeSlideId })`);
  if (JSON.stringify(viewAfterBackgroundDelete) !== JSON.stringify(pinnedView)) throw new Error(`Deleting a background project changed the user's view: ${JSON.stringify({ pinnedView, viewAfterBackgroundDelete })}`);
  await tool("end_edit_session", { editSessionId });
  editSessionId = null;
  editSessionId = (await tool("begin_edit_session", { editorId: testEditor.id, projectId: createdProject.projectId, purpose: "Finish browser integration test" })).structuredContent.id;
  await tool("open_project", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId });

  const inspected = (await tool("inspect_editor", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId })).structuredContent;
  if (inspected.project.name !== "Full MCP verified" || inspected.project.slides.length !== 1 || inspected.slide.texts.length !== 2 || inspected.slide.images.length !== 1 || inspected.slide.images[0].id !== image.createdImageId || inspected.view.showTikTokOverlay !== true) throw new Error(`Unexpected final state: ${JSON.stringify(inspected)}`);
  const { targetId: secondTargetId } = await cdp.send("Target.createTarget", { url: browserPageUrl });
  const secondPage = await waitFor(async () => (await waitForJson("/json/list")).find((page) => page.id === secondTargetId), "Second editor tab did not open.");
  secondCdp = connectCdp(secondPage.webSocketDebuggerUrl);
  await secondCdp.ready;
  await secondCdp.send("Runtime.enable");
  await waitFor(() => evaluate(secondCdp, `document.readyState === "complete" && document.querySelector('[data-action="connect-agent"]')?.dataset.mcpStatus === "connected"`), "Second editor did not restore the remembered connection.");
  for (let index = 0; index < 5; index += 1) {
    const { targetId } = await cdp.send("Target.createTarget", { url: browserPageUrl });
    const page = await waitFor(async () => (await waitForJson("/json/list")).find((item) => item.id === targetId), `Stress editor ${index + 3} did not open.`);
    const extraCdp = connectCdp(page.webSocketDebuggerUrl);
    await extraCdp.ready;
    await extraCdp.send("Runtime.enable");
    await waitFor(() => evaluate(extraCdp, `document.readyState === "complete" && document.querySelector('[data-action="connect-agent"]')?.dataset.mcpStatus === "connected"`), `Stress editor ${index + 3} did not restore the remembered connection.`);
    additionalCdps.push(extraCdp);
  }
  const stressEditors = (await tool("list_editors")).structuredContent.editors;
  if (stressEditors.length < 7) throw new Error(`Seven-tab transport stress setup connected only ${stressEditors.length} editors.`);
  const previousCoverUrl = await waitFor(() => evaluate(secondCdp, `document.querySelector('[data-project-cover-id="${createdProject.projectId}"] img[data-composite-cover="true"]')?.src || ""`), "The dashboard did not render its initial composed project cover.");
  await evaluate(secondCdp, `(() => {
    window.__carouselBotOriginalRequestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    return true;
  })()`);
  try {
    const stressStartedAt = Date.now();
    await tool("update_project", { projectId: createdProject.projectId, name: "Cross-tab sync verified" });
    if (Date.now() - stressStartedAt > 5_000) throw new Error("A browser operation took over five seconds with seven connected editors.");
    const crossTabActivity = await waitFor(() => evaluate(secondCdp, `(() => {
      const item = [...document.querySelectorAll("#agent-activity-stack .agent-activity")].find((entry) => entry.textContent.includes("Updating the project"));
      return item ? { label: item.querySelector("strong")?.textContent, icon: item.querySelector(".agent-activity-icon img")?.getAttribute("src") } : null;
    })()`), "A tool action performed in another editor was not announced in this tab.");
    if (crossTabActivity.label !== "Codex" || !crossTabActivity.icon?.includes("codex-logo-colored")) throw new Error(`Cross-tab activity used the wrong client identity: ${JSON.stringify(crossTabActivity)}`);
    await waitFor(() => evaluate(secondCdp, `[...document.querySelectorAll('.project-card .project-meta strong')].some((item) => item.textContent === "Cross-tab sync verified")`), "The dashboard did not receive the cross-tab project update.");
    await waitFor(() => evaluate(secondCdp, `(() => {
      const image = document.querySelector('[data-project-cover-id="${createdProject.projectId}"] img[data-composite-cover="true"]');
      return image?.src && image.src !== ${JSON.stringify(previousCoverUrl)};
    })()`), "The dashboard did not refresh its composed cover while animation frames were paused.");
  } finally {
    await evaluate(secondCdp, `(() => {
      window.requestAnimationFrame = window.__carouselBotOriginalRequestAnimationFrame;
      delete window.__carouselBotOriginalRequestAnimationFrame;
      return true;
    })()`);
  }
  await tool("update_project", { projectId: createdProject.projectId, expectedRevision: 0, name: "Stale write" })
    .then(() => { throw new Error("A stale project revision unexpectedly succeeded."); })
    .catch((error) => { if (!/revision changed/.test(error.message)) throw error; });
  await tool("end_edit_session", { editSessionId });
  editSessionId = null;
  process.stdout.write(`${JSON.stringify({ connected: true, optInRequired: true, reconnectAfterReload: true, sevenTabConnectionStress: true, crossTabSync: true, crossTabActionNotifications: true, composedDashboardCover: true, dashboardProjectNotification: true, connectionStatusLeftAligned: true, backgroundEditsPreserveView: true, roleBasedTextDefaults: true, automaticTextHeightFitting: true, agentIdentityNotificationIcon: true, compactToolbar: true, fittedFullBox: true, symmetricPerLinePaddingAfterReload: true, projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, textLayers: 2, imageLayers: 1, operationsCovered: 34, previewBytes: imageContent.data.length, exportBytes: (await stat(exportPath)).size, projectExports: exportedProject.fileCount }, null, 2)}\n`);
} finally {
  await closeChromeGracefully();
  for (const extraCdp of additionalCdps) extraCdp.close();
  secondCdp?.close();
  cdp?.close();
  mcp.stdin.end();
  if (!sharedDaemon) {
    const daemonState = await readFile(join(stateDirectory, `daemon-${bridgePort}.json`), "utf8").then(JSON.parse).catch(() => null);
    if (daemonState?.pid) try { process.kill(daemonState.pid, "SIGTERM"); } catch { /* Already exited. */ }
  }
  const stopChild = async (child) => {
    if (!child || child.exitCode != null) return;
    child.kill("SIGTERM");
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
    await Promise.race([exited, timeout]);
    if (child.exitCode == null) child.kill("SIGKILL");
  };
  await Promise.allSettled([stopChild(chrome), stopChild(web), stopChild(mcp)]);
  await rm(profile, { recursive: true, force: true });
  await rm(stateDirectory, { recursive: true, force: true });
}
