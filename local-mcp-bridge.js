const LOCAL_MCP_BRIDGE_URL = "http://127.0.0.1:43117";
const LOCAL_MCP_RETRY_MS = 1200;
const LOCAL_MCP_EDITOR_ID_KEY = "slide-studio-local-mcp-editor-id";

const localMcpBridgeState = {
  connected: false,
  connecting: false,
  shouldReconnect: false,
  stopped: false,
  editorId: sessionStorage.getItem(LOCAL_MCP_EDITOR_ID_KEY) || crypto.randomUUID(),
  events: [],
  status: "idle",
  statusMessage: "Not connected",
  lastFocusedElement: null,
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

function localMcpSendJson(path, value) {
  return localMcpRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

function localMcpSetStatus(status, message) {
  localMcpBridgeState.status = status;
  localMcpBridgeState.statusMessage = message;
  document.querySelectorAll('[data-action="connect-agent"]').forEach((button) => {
    button.dataset.mcpStatus = status;
    const label = button.querySelector(".agent-connect-label");
    const labelText = status === "connected" ? "AI connected" : "Connect AI";
    if (label && label.textContent !== labelText) label.textContent = labelText;
  });
  const statusElement = document.querySelector("[data-local-mcp-status]");
  if (statusElement) {
    statusElement.dataset.status = status;
    statusElement.textContent = message;
  }
  const connectButton = document.querySelector("[data-local-mcp-connect]");
  if (connectButton) {
    connectButton.disabled = status === "connecting" || status === "connected";
    connectButton.textContent = status === "connecting"
      ? "Connecting…"
      : status === "connected" ? "Connected" : "Connect to running MCP";
  }
}

function localMcpAddEvent(message) {
  localMcpBridgeState.events.unshift(`${new Date().toLocaleTimeString()} · ${message}`);
  localMcpBridgeState.events = localMcpBridgeState.events.slice(0, 8);
}

function localMcpEnsureModal() {
  let backdrop = document.querySelector("#agent-connect-modal");
  if (backdrop) return backdrop;

  backdrop = document.createElement("div");
  backdrop.id = "agent-connect-modal";
  backdrop.className = "agent-modal-backdrop";
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <section class="agent-modal" role="dialog" aria-modal="true" aria-labelledby="agent-modal-title" aria-describedby="agent-modal-description">
      <button class="icon-button agent-modal-close" type="button" data-local-mcp-close aria-label="Close connect dialog">×</button>
      <header class="agent-modal-header">
        <p class="agent-modal-kicker">Local-first agent control</p>
        <h2 id="agent-modal-title">Connect to an AI agent</h2>
        <p class="agent-modal-lead" id="agent-modal-description">Let Claude, Codex, or Hermes create and edit slides in this open browser tab through a companion running on your computer.</p>
      </header>
      <div class="agent-modal-body">
        <div class="agent-client-row" aria-label="Compatible agent clients">
          <span class="agent-client-chip"><img src="assets/claude-ai-symbol.svg" alt="" />Claude</span>
          <span class="agent-client-chip"><img src="assets/codex-logo.svg" alt="" />Codex</span>
          <span class="agent-client-chip"><img src="assets/hermes-agent-logo.svg" alt="" />Hermes</span>
        </div>
        <ol class="agent-steps">
          <li><span><strong>Add the local MCP companion to your agent</strong>For this test, point the agent at the checked-out server file.<code class="agent-command">node /path/to/slide-studio/mcp/server.mjs</code></span></li>
          <li><span><strong>Keep the agent and this editor open</strong>The companion listens only on <code>127.0.0.1</code>. Slide and image data stays in this browser.</span></li>
          <li><span><strong>Connect this tab</strong>Click below and approve Chrome’s local-network prompt. Then ask your agent to create a slide or add text.</span></li>
        </ol>
        <p class="agent-privacy-note">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
          <span><strong>No hosted relay in this test.</strong> This page talks directly to the MCP companion on your computer. Slide Studio is not a middleman for prompts, screenshots, or images.</span>
        </p>
      </div>
      <footer class="agent-modal-footer">
        <span class="agent-connection-status" data-local-mcp-status data-status="idle" role="status">Not connected</span>
        <button class="button button--primary agent-modal-connect" type="button" data-local-mcp-connect>Connect to running MCP</button>
      </footer>
    </section>`;
  document.body.appendChild(backdrop);

  backdrop.querySelector("[data-local-mcp-close]").addEventListener("click", localMcpCloseModal);
  backdrop.querySelector("[data-local-mcp-connect]").addEventListener("click", localMcpConnectFromClick);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) localMcpCloseModal();
  });
  localMcpSetStatus(localMcpBridgeState.status, localMcpBridgeState.statusMessage);
  return backdrop;
}

function localMcpOpenModal(trigger) {
  const backdrop = localMcpEnsureModal();
  localMcpBridgeState.lastFocusedElement = trigger || document.activeElement;
  backdrop.hidden = false;
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => backdrop.querySelector(localMcpBridgeState.connected ? "[data-local-mcp-close]" : "[data-local-mcp-connect]")?.focus());
}

function localMcpCloseModal() {
  const backdrop = document.querySelector("#agent-connect-modal");
  if (!backdrop || backdrop.hidden) return;
  backdrop.hidden = true;
  document.body.style.overflow = "";
  localMcpBridgeState.lastFocusedElement?.focus?.();
}

async function localMcpPermissionWasDenied() {
  if (!navigator.permissions?.query) return false;
  for (const name of ["loopback-network", "local-network-access", "local-network"]) {
    try {
      const permission = await navigator.permissions.query({ name });
      if (permission.state === "denied") return true;
      if (permission.state === "granted" || permission.state === "prompt") return false;
    } catch { /* This permission name is not available in this Chrome version. */ }
  }
  return false;
}

async function localMcpConnectFromClick() {
  if (localMcpBridgeState.connected || localMcpBridgeState.connecting) return;
  localMcpBridgeState.connecting = true;
  localMcpSetStatus("connecting", "Requesting access to the local companion…");

  try {
    // This request intentionally happens directly inside the click handler. Chrome
    // uses it to display the loopback/local-network permission prompt when needed.
    const health = await localMcpRequest("/health");
    if (!health.ok) throw new Error(`Local companion returned ${health.status}`);
    await window.slideStudioReady;
    localMcpBridgeState.shouldReconnect = true;
    await localMcpHandshake();
    localMcpPollWithReconnect();
  } catch (error) {
    localMcpBridgeState.connected = false;
    localMcpBridgeState.shouldReconnect = false;
    const denied = await localMcpPermissionWasDenied();
    localMcpSetStatus(
      denied ? "denied" : "error",
      denied
        ? "Local access was blocked. Allow it in Chrome site settings, then try again."
        : "No local MCP companion found. Start it in your agent, then try again.",
    );
    localMcpAddEvent(`Connection failed: ${error.message}`);
  } finally {
    localMcpBridgeState.connecting = false;
  }
}

async function localMcpHandshake() {
  const response = await localMcpSendJson("/connect", {
    editorId: localMcpBridgeState.editorId,
    pageUrl: location.href,
    pageOrigin: location.origin,
    state: window.slideStudioLocalMcp.getState(),
  });
  if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
  localMcpBridgeState.connected = true;
  localMcpAddEvent("Companion handshake completed");
  localMcpSetStatus("connected", `Connected locally · editor ${localMcpBridgeState.editorId.slice(0, 8)}`);
}

async function localMcpPollWithReconnect() {
  while (!localMcpBridgeState.stopped && localMcpBridgeState.shouldReconnect) {
    try {
      if (!localMcpBridgeState.connected) await localMcpHandshake();
      await localMcpPoll();
    } catch (error) {
      if (localMcpBridgeState.connected) localMcpAddEvent(`Disconnected: ${error.message}`);
      localMcpBridgeState.connected = false;
      localMcpSetStatus("connecting", "Reconnecting to the local companion…");
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

document.addEventListener("click", (event) => {
  const trigger = event.target.closest?.('[data-action="connect-agent"]');
  if (trigger) localMcpOpenModal(trigger);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") localMcpCloseModal();
});

const localMcpAppRoot = document.querySelector("#app");
if (localMcpAppRoot) {
  new MutationObserver(() => {
    localMcpSetStatus(localMcpBridgeState.status, localMcpBridgeState.statusMessage);
  }).observe(localMcpAppRoot, { childList: true, subtree: true });
}

window.addEventListener("beforeunload", () => {
  localMcpBridgeState.stopped = true;
  localMcpBridgeState.shouldReconnect = false;
});

window.slideStudioLocalMcpBridge = {
  open: localMcpOpenModal,
  connect: localMcpConnectFromClick,
  getState: () => ({ ...localMcpBridgeState, lastFocusedElement: undefined }),
};
