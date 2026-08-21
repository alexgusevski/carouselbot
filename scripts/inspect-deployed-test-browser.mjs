import { writeFile } from "node:fs/promises";

const debuggingPort = Number(process.env.SLIDE_STUDIO_CDP_PORT) || 19229;
const pages = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`).then((response) => response.json());
const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const commandId = ++id;
    pending.set(commandId, { resolve, reject });
    socket.send(JSON.stringify({ id: commandId, method, params }));
  });
}
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const evaluated = await send("Runtime.evaluate", {
  expression: "JSON.stringify({state: window.slideStudioLocalMcp?.getState(), status: document.querySelector('#local-mcp-poc-status')?.innerText})",
  returnByValue: true,
});
const result = JSON.parse(evaluated.result.value);
const screenshotPath = process.env.SLIDE_STUDIO_SCREENSHOT_PATH;
if (screenshotPath) {
  const screenshot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  result.screenshotPath = screenshotPath;
}
console.log(JSON.stringify(result, null, 2));
socket.close();
