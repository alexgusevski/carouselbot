const LOCAL_MCP_BRIDGE_URL = "http://127.0.0.1:43117";
const LOCAL_MCP_RETRY_MS = 1200;
const LOCAL_MCP_EDITOR_ID_KEY = "slide-studio-local-mcp-editor-id";

const localMcpBridgeState = {
  connected: false,
  stopped: false,
  editorId: sessionStorage.getItem(LOCAL_MCP_EDITOR_ID_KEY) || crypto.randomUUID(),
  events: [],
};
sessionStorage.setItem(LOCAL_MCP_EDITOR_ID_KEY, localMcpBridgeState.editorId);

function localMcpRequest(path, init = {}) {
  const requestInit = { mode: "cors", cache: "no-store", ...init };
  try {
    return fetch(new Request(`${LOCAL_MCP_BRIDGE_URL}${path}`, {
      ...requestInit,
      targetAddressSpace: "loopback",
    }));
  } catch {
    return fetch(`${LOCAL_MCP_BRIDGE_URL}${path}`, requestInit);
  }
}

function localMcpAddEvent(message) {
  localMcpBridgeState.events.unshift(`${new Date().toLocaleTimeString()} · ${message}`);
  localMcpBridgeState.events = localMcpBridgeState.events.slice(0, 4);
  localMcpRenderStatus();
}

function localMcpRenderStatus() {
  let panel = document.querySelector("#local-mcp-poc-status");
  if (!panel) {
    panel = document.createElement("aside");
    panel.id = "local-mcp-poc-status";
    panel.innerHTML = `<strong></strong><span></span><ol></ol>`;
    document.body.appendChild(panel);
    const style = document.createElement("style");
    style.textContent = `
      #local-mcp-poc-status { position:fixed; right:14px; bottom:14px; z-index:99999; width:min(330px,calc(100vw - 28px)); padding:12px 14px; border:1px solid rgba(255,255,255,.16); border-radius:12px; background:rgba(18,19,16,.94); color:#fff; box-shadow:0 14px 45px rgba(0,0,0,.28); font:12px/1.35 system-ui,sans-serif; backdrop-filter:blur(12px) }
      #local-mcp-poc-status strong { display:block; color:#25f4ee; font-size:13px }
      #local-mcp-poc-status span { display:block; margin-top:3px; color:rgba(255,255,255,.68) }
      #local-mcp-poc-status ol { margin:8px 0 0; padding:8px 0 0 18px; border-top:1px solid rgba(255,255,255,.1); color:rgba(255,255,255,.78) }
      #local-mcp-poc-status[data-connected="false"] strong { color:#ffe45e }
    `;
    document.head.appendChild(style);
  }
  panel.dataset.connected = String(localMcpBridgeState.connected);
  panel.querySelector("strong").textContent = localMcpBridgeState.connected
    ? "Local MCP companion connected"
    : "Waiting for local MCP companion";
  panel.querySelector("span").textContent = localMcpBridgeState.connected
    ? `Editor ${localMcpBridgeState.editorId.slice(0, 8)} · data stays on this device`
    : "Start the stdio MCP server, then keep this tab open.";
  panel.querySelector("ol").innerHTML = localMcpBridgeState.events.map((event) => `<li>${event.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</li>`).join("");
}

async function localMcpSendJson(path, value) {
  return localMcpRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function localMcpConnect() {
  await window.slideStudioReady;
  while (!localMcpBridgeState.stopped) {
    try {
      const response = await localMcpSendJson("/connect", {
        editorId: localMcpBridgeState.editorId,
        pageUrl: location.href,
        pageOrigin: location.origin,
        state: window.slideStudioLocalMcp.getState(),
      });
      if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
      if (!localMcpBridgeState.connected) localMcpAddEvent("Companion handshake completed");
      localMcpBridgeState.connected = true;
      localMcpRenderStatus();
      await localMcpPoll();
    } catch (error) {
      if (localMcpBridgeState.connected) localMcpAddEvent(`Disconnected: ${error.message}`);
      localMcpBridgeState.connected = false;
      localMcpRenderStatus();
      await new Promise((resolve) => setTimeout(resolve, LOCAL_MCP_RETRY_MS));
    }
  }
}

async function localMcpPoll() {
  while (!localMcpBridgeState.stopped && localMcpBridgeState.connected) {
    const response = await localMcpRequest(`/events?editorId=${encodeURIComponent(localMcpBridgeState.editorId)}`);
    if (response.status === 204) continue;
    if (!response.ok) throw new Error(`Event poll returned ${response.status}`);
    const command = await response.json();
    localMcpAddEvent(`Tool call: ${command.toolName}`);
    try {
      const result = await window.slideStudioLocalMcp.execute(command.operation);
      await localMcpSendJson("/result", { editorId: localMcpBridgeState.editorId, requestId: command.requestId, ok: true, result });
      localMcpAddEvent(`Applied: ${command.toolName}`);
    } catch (error) {
      await localMcpSendJson("/result", { editorId: localMcpBridgeState.editorId, requestId: command.requestId, ok: false, error: error.message });
      localMcpAddEvent(`Failed: ${command.toolName}`);
    }
  }
}

localMcpRenderStatus();
localMcpConnect();
