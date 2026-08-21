import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const pageUrl = process.env.SLIDE_STUDIO_TEST_URL || "https://slides-mcp-poc-0821.pages.dev";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const debuggingPort = 19228;
const root = new URL("..", import.meta.url);
const profile = await mkdtemp(join(tmpdir(), "slide-studio-mcp-chrome-"));
const mcp = spawn(process.execPath, ["mcp/server.mjs"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
mcp.stderr.setEncoding("utf8");
mcp.stderr.on("data", (chunk) => process.stderr.write(chunk));

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

function rpc(method, params = {}, timeout = 35_000) {
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

function tool(name, args = {}) {
  return rpc("tools/call", { name, arguments: args }).then((result) => {
    if (result.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
    return result.structuredContent;
  });
}

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-background-networking",
  "--disable-component-update",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1440,1000",
  `--remote-debugging-port=${debuggingPort}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let chromeErrors = "";
chrome.stderr.setEncoding("utf8");
chrome.stderr.on("data", (chunk) => { chromeErrors += chunk; });

async function waitForJson(path) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}${path}`);
      if (response.ok) return response.json();
    } catch { /* Chrome is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome DevTools endpoint did not start.");
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
      return;
    }
    events.push(message);
  });
  return {
    events,
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
    close() { socket.close(); },
  };
}

async function waitForEditor() {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = await tool("list_editors");
    if (result.editors.length) return result.editors[0];
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The deployed page never connected to localhost. Chrome output:\n${chromeErrors.slice(-3000)}`);
}

async function connectEditorFromUi(cdp) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        let trigger = document.querySelector('[data-action="connect-agent"]');
        if (!trigger && window.slideStudioLocalMcp) {
          await window.slideStudioLocalMcp.execute({ type: "slide.create_demo", projectName: "POC connection test", slideName: "Waiting for agent", backgroundColor: "#EEEDE7" });
          trigger = document.querySelector('[data-action="connect-agent"]');
        }
        if (!trigger) return "waiting";
        trigger.click();
        const connect = document.querySelector('[data-local-mcp-connect]');
        if (!connect) return "waiting";
        connect.click();
        return "clicked";
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.result?.value === "clicked") return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The deployed page never rendered the Connect AI control.");
}

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "browser-poc-test", version: "1" } });
  const protocol = await waitForJson("/json/protocol");
  const browserDomain = protocol.domains.find((domain) => domain.domain === "Browser");
  const permissionType = browserDomain?.types?.find((type) => type.id === "PermissionType");
  const localPermissions = (permissionType?.enum || []).filter((value) => /local|loopback/i.test(value));
  const pages = await waitForJson("/json/list");
  const cdp = connectCdp(pages[0].webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  if (localPermissions.length) {
    await cdp.send("Browser.grantPermissions", { permissions: localPermissions, origin: new URL(pageUrl).origin });
  }
  await cdp.send("Page.navigate", { url: pageUrl });
  await connectEditorFromUi(cdp);
  const editor = await waitForEditor();
  const created = await tool("create_demo_slide", {
    projectName: "Deployed Pages MCP proof",
    slideName: "Created through localhost",
    backgroundColor: "#22252B",
  });
  const added = await tool("add_text", {
    text: "This text came from a local MCP tool call",
    x: 0.12,
    y: 0.38,
    width: 0.76,
    height: 0.16,
    size: 78,
    style: "boxed",
    background: "black",
    color: "#FFFFFF",
  });
  const state = await tool("get_editor_state");
  if (state.activeProjectName !== "Deployed Pages MCP proof" || state.textCount !== 1) {
    throw new Error(`Unexpected browser state: ${JSON.stringify(state)}`);
  }
  console.log(JSON.stringify({ pageUrl, connectedEditor: editor.id, created, added, finalState: state }, null, 2));
  cdp.close();
} finally {
  chrome.kill("SIGTERM");
  mcp.kill("SIGTERM");
  await Promise.allSettled([
    new Promise((resolve) => chrome.once("exit", resolve)),
    new Promise((resolve) => mcp.once("exit", resolve)),
  ]);
  await rm(profile, { recursive: true, force: true });
}
