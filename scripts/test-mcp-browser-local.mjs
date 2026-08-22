import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url);
const rootPath = root.pathname;
const pageUrl = process.argv.includes("--deployed")
  ? "https://slides-mcp-poc-0821.pages.dev"
  : process.env.SLIDE_STUDIO_TEST_URL || "http://127.0.0.1:4173";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const debuggingPort = 19229;
const profile = await mkdtemp(join(tmpdir(), "slide-studio-browser-"));
const stateDirectory = await mkdtemp(join(tmpdir(), "slide-studio-daemon-"));
const exportPath = join(profile, "agent-export.png");
const projectExportDirectory = join(profile, "project-export");
const sharedDaemon = process.argv.includes("--shared-daemon");
const env = sharedDaemon ? process.env : { ...process.env, SLIDE_STUDIO_STATE_DIR: stateDirectory };
const web = new URL(pageUrl).hostname === "127.0.0.1"
  ? spawn(process.execPath, ["server.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
  : null;
const mcp = spawn(process.execPath, ["packages/mcp/src/cli.mjs", "serve"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
let diagnostics = "";
let editSessionId = null;
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
  "--headless=new", "--disable-background-networking", "--disable-component-update", "--no-first-run",
  "--no-default-browser-check", "--window-size=1440,1000", `--remote-debugging-port=${debuggingPort}`,
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
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

let cdp;
let secondCdp;
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
  await cdp.send("Page.navigate", { url: pageUrl });
  await waitFor(() => evaluate(cdp, "document.readyState === 'complete' && Boolean(window.slideStudioAgent)"), "Editor scripts did not load.");
  const initialConnection = await evaluate(cdp, `({
    buttonStatus: document.querySelector('[data-action="connect-agent"]')?.dataset.mcpStatus || "idle",
    remembered: localStorage.getItem("slide-studio:mcp-connected"),
    editorId: window.slideStudioLocalMcpBridge.getState().editorId
  })`);
  const initialEditors = (await tool("list_editors")).structuredContent.editors;
  if (initialConnection.buttonStatus !== "idle" || initialConnection.remembered !== null || initialEditors.some((editor) => editor.id === initialConnection.editorId)) {
    throw new Error(`The browser contacted MCP before the user opted in: ${JSON.stringify({ initialConnection, initialEditors })}`);
  }
  await evaluate(cdp, `(async () => {
    document.querySelector('[data-action="connect-agent"]').click();
    document.querySelector('[data-local-mcp-connect]').click();
    return true;
  })()`);
  await waitFor(async () => (await tool("list_editors")).structuredContent.editors.some((editor) => editor.id === initialConnection.editorId), "Editor did not connect.");
  const remembered = await evaluate(cdp, `localStorage.getItem("slide-studio:mcp-connected")`);
  if (remembered !== "1") throw new Error("Successful MCP connection was not remembered.");
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(() => evaluate(cdp, `document.readyState === "complete" && document.querySelector('[data-action="connect-agent"]')?.dataset.mcpStatus === "connected"`), "Remembered MCP connection did not resume after reload.");
  await tool("get_design_guidance");
  const connectedEditors = (await tool("list_editors")).structuredContent.editors;
  const testEditor = connectedEditors.find((editor) => editor.id === initialConnection.editorId);
  const editSession = (await tool("begin_edit_session", { editorId: testEditor.id, purpose: "Full browser integration test" })).structuredContent;
  editSessionId = editSession.id;
  await tool("show_notification", { message: "Hello from the full local MCP", tone: "success" });

  await evaluate(cdp, "document.querySelector('[data-action=\"home\"]')?.click()");
  await waitFor(() => evaluate(cdp, "Boolean(document.querySelector('.dashboard'))"), "Dashboard did not open.");
  const createdProject = (await tool("create_project", { name: "Full MCP browser test" })).structuredContent;
  const dashboardUpdated = await evaluate(cdp, `({
    dashboardVisible: Boolean(document.querySelector('.dashboard')),
    projectNames: [...document.querySelectorAll('.project-card .project-meta strong')].map((item) => item.textContent)
  })`);
  if (!dashboardUpdated.dashboardVisible || !dashboardUpdated.projectNames.includes("Full MCP browser test")) throw new Error(`Dashboard did not update live: ${JSON.stringify(dashboardUpdated)}`);
  const addedSlide = (await tool("add_slide", { projectId: createdProject.projectId, name: "Live automation", backgroundColor: "#25282E" })).structuredContent;
  await waitFor(() => evaluate(cdp, "document.querySelector('.project-title-input')?.value === 'Full MCP browser test'"), "Adding the first slide did not open the editor.");
  const addedText = (await tool("add_text", {
    projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, text: "Built live by an AI agent",
    x: 0.1, y: 0.2, width: 0.8, height: 0.16, size: 82, style: "boxed", background: "black", backgroundShape: "lines", color: "#FFFFFF",
  })).structuredContent;
  const imported = (await tool("import_asset", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, path: join(rootPath, "assets", "favicon.svg"), name: "Slide Studio mark" })).structuredContent;
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
  editSessionId = (await tool("begin_edit_session", { editorId: testEditor.id, purpose: "Verify project deletion" })).structuredContent.id;
  const temporaryProject = (await tool("create_project", { name: "Temporary project" })).structuredContent;
  await tool("delete_project", { projectId: temporaryProject.projectId });
  await tool("end_edit_session", { editSessionId });
  editSessionId = null;
  editSessionId = (await tool("begin_edit_session", { editorId: testEditor.id, projectId: createdProject.projectId, purpose: "Finish browser integration test" })).structuredContent.id;
  await tool("open_project", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId });

  const inspected = (await tool("inspect_editor", { projectId: createdProject.projectId, slideId: addedSlide.createdSlideId })).structuredContent;
  if (inspected.project.name !== "Full MCP verified" || inspected.project.slides.length !== 1 || inspected.slide.texts.length !== 2 || inspected.slide.images.length !== 1 || inspected.slide.images[0].id !== image.createdImageId || inspected.view.showTikTokOverlay !== true) throw new Error(`Unexpected final state: ${JSON.stringify(inspected)}`);
  const { targetId: secondTargetId } = await cdp.send("Target.createTarget", { url: pageUrl });
  const secondPage = await waitFor(async () => (await waitForJson("/json/list")).find((page) => page.id === secondTargetId), "Second editor tab did not open.");
  secondCdp = connectCdp(secondPage.webSocketDebuggerUrl);
  await secondCdp.ready;
  await secondCdp.send("Runtime.enable");
  await waitFor(() => evaluate(secondCdp, `document.readyState === "complete" && document.querySelector('[data-action="connect-agent"]')?.dataset.mcpStatus === "connected"`), "Second editor did not restore the remembered connection.");
  await tool("update_project", { projectId: createdProject.projectId, name: "Cross-tab sync verified" });
  await waitFor(() => evaluate(secondCdp, `[...document.querySelectorAll('.project-card .project-meta strong')].some((item) => item.textContent === "Cross-tab sync verified")`), "The dashboard did not receive the cross-tab project update.");
  await tool("update_project", { projectId: createdProject.projectId, expectedRevision: 0, name: "Stale write" })
    .then(() => { throw new Error("A stale project revision unexpectedly succeeded."); })
    .catch((error) => { if (!/revision changed/.test(error.message)) throw error; });
  await tool("end_edit_session", { editSessionId });
  editSessionId = null;
  process.stdout.write(`${JSON.stringify({ connected: true, optInRequired: true, reconnectAfterReload: true, crossTabSync: true, projectId: createdProject.projectId, slideId: addedSlide.createdSlideId, textLayers: 2, imageLayers: 1, operationsCovered: 26, previewBytes: imageContent.data.length, exportBytes: (await stat(exportPath)).size, projectExports: exportedProject.fileCount }, null, 2)}\n`);
} finally {
  secondCdp?.close();
  cdp?.close();
  mcp.stdin.end();
  if (!sharedDaemon) {
    const daemonState = await readFile(join(stateDirectory, "daemon-43117.json"), "utf8").then(JSON.parse).catch(() => null);
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
