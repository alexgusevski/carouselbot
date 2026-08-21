import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const pageUrl = process.env.SLIDE_STUDIO_TEST_URL || "https://slides-mcp-poc-0821.pages.dev";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const debuggingPort = Number(process.env.SLIDE_STUDIO_CDP_PORT) || 19229;
const profile = await mkdtemp(join(tmpdir(), "slide-studio-agent-client-chrome-"));
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
chrome.stderr.on("data", () => {});

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

function connectCdp(url) {
  const socket = new WebSocket(url);
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

const protocol = await waitForJson("/json/protocol");
const browserDomain = protocol.domains.find((domain) => domain.domain === "Browser");
const permissionType = browserDomain?.types?.find((type) => type.id === "PermissionType");
const localPermissions = (permissionType?.enum || []).filter((value) => /localNetwork|loopbackNetwork/i.test(value));
const pages = await waitForJson("/json/list");
const cdp = connectCdp(pages[0].webSocketDebuggerUrl);
await cdp.ready;
await cdp.send("Runtime.enable");
if (localPermissions.length) await cdp.send("Browser.grantPermissions", { permissions: localPermissions, origin: new URL(pageUrl).origin });
await cdp.send("Page.navigate", { url: pageUrl });

const connectDeadline = Date.now() + 20_000;
let connectedFromUi = false;
while (Date.now() < connectDeadline) {
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
  if (result.result?.value === "clicked") {
    connectedFromUi = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!connectedFromUi) throw new Error("The deployed page never rendered the Connect AI control.");

console.log(JSON.stringify({ ready: true, pageUrl, debuggingPort, localPermissions }));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  cdp.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => chrome.once("exit", resolve));
  await rm(profile, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
