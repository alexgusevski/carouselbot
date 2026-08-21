const LOCAL_MCP_BRIDGE_URL = "http://127.0.0.1:43117";
const LOCAL_MCP_RETRY_MS = 1200;

const localMcpBridgeState = {
  connected: false,
  connecting: false,
  shouldReconnect: false,
  stopped: false,
  editorId: crypto.randomUUID(),
  sessionToken: null,
  agents: [],
  events: [],
  status: "idle",
  statusMessage: "Not connected",
  lastFocusedElement: null,
};

function localMcpRequest(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (localMcpBridgeState.sessionToken && path !== "/connect") headers.set("Authorization", `Bearer ${localMcpBridgeState.sessionToken}`);
  const requestInit = { mode: "cors", cache: "no-store", ...init, headers };
  try {
    return fetch(new Request(`${LOCAL_MCP_BRIDGE_URL}${path}`, { ...requestInit, targetAddressSpace: "loopback" }));
  } catch {
    return fetch(`${LOCAL_MCP_BRIDGE_URL}${path}`, requestInit);
  }
}

function localMcpSendJson(path, value) {
  return localMcpRequest(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
}

function localMcpAgentLabel(agent) {
  const name = String(agent?.name || "AI agent").toLowerCase();
  if (name.includes("claude")) return "Claude";
  if (name.includes("codex")) return "Codex";
  if (name.includes("hermes")) return "Hermes";
  if (name.includes("opencode")) return "OpenCode";
  if (name.includes("openclaw")) return "OpenClaw";
  return agent?.name || "AI agent";
}

function localMcpConnectionMessage() {
  if (!localMcpBridgeState.connected) return localMcpBridgeState.statusMessage;
  if (!localMcpBridgeState.agents.length) return `Local companion connected · editor ${localMcpBridgeState.editorId.slice(0, 8)}`;
  const labels = [...new Set(localMcpBridgeState.agents.map(localMcpAgentLabel))];
  return `${labels.join(", ")} connected · editor ${localMcpBridgeState.editorId.slice(0, 8)}`;
}

function localMcpSetStatus(status, message = localMcpBridgeState.statusMessage) {
  localMcpBridgeState.status = status;
  localMcpBridgeState.statusMessage = message;
  const displayMessage = status === "connected" ? localMcpConnectionMessage() : message;
  document.querySelectorAll('[data-action="connect-agent"]').forEach((button) => {
    button.dataset.mcpStatus = status;
    const label = button.querySelector(".agent-connect-label");
    const labelText = status === "connected" ? "AI connected" : "Connect AI";
    if (label && label.textContent !== labelText) label.textContent = labelText;
  });
  const statusElement = document.querySelector("[data-local-mcp-status]");
  if (statusElement) {
    statusElement.dataset.status = status;
    statusElement.textContent = displayMessage;
  }
  const connectButton = document.querySelector("[data-local-mcp-connect]");
  if (connectButton) {
    connectButton.disabled = status === "connecting" || status === "connected";
    connectButton.textContent = status === "connecting" ? "Connecting…" : status === "connected" ? "Connected" : "Connect to local companion";
  }
}

function localMcpAddEvent(message) {
  localMcpBridgeState.events.unshift(`${new Date().toLocaleTimeString()} · ${message}`);
  localMcpBridgeState.events = localMcpBridgeState.events.slice(0, 12);
}

function localMcpNotify(message, tone = "agent", agent = null) {
  const value = String(message || "").trim().slice(0, 240);
  if (!value) return;
  let stack = document.querySelector("#agent-activity-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "agent-activity-stack";
    stack.className = "agent-activity-stack";
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  const item = document.createElement("div");
  item.className = `agent-activity agent-activity--${["success", "error", "info"].includes(tone) ? tone : "agent"}`;
  item.innerHTML = `<span class="agent-activity-dot" aria-hidden="true"></span><span><strong>${escapeHtml(localMcpAgentLabel(agent))}</strong>${escapeHtml(value)}</span>`;
  stack.appendChild(item);
  requestAnimationFrame(() => item.classList.add("is-visible"));
  window.setTimeout(() => {
    item.classList.remove("is-visible");
    window.setTimeout(() => item.remove(), 220);
  }, 4200);
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
        <p class="agent-modal-lead" id="agent-modal-description">Watch Claude, Codex, Hermes, OpenCode, OpenClaw, or any MCP-compatible agent build and edit this presentation live.</p>
      </header>
      <div class="agent-modal-body">
        <div class="agent-client-row" aria-label="Compatible agent clients">
          <span class="agent-client-chip"><img src="assets/claude-ai-symbol.svg" alt="" />Claude</span>
          <span class="agent-client-chip"><img src="assets/codex-logo.svg" alt="" />Codex</span>
          <span class="agent-client-chip"><img src="assets/hermes-agent-logo.svg" alt="" />Hermes + any MCP client</span>
        </div>
        <ol class="agent-steps">
          <li><span><strong>Install the local companion once</strong><code class="agent-command">npx @alexgusevski/slide-studio-mcp@latest setup</code></span></li>
          <li><span><strong>Start or restart your agent</strong>The agent launches the companion automatically. It listens only on <code>127.0.0.1</code>.</span></li>
          <li><span><strong>Connect this tab</strong>Click below and approve Chrome’s local-network prompt. The active tab follows every edit live.</span></li>
        </ol>
        <p class="agent-privacy-note">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
          <span><strong>No hosted relay.</strong> The website talks directly to the companion on your computer. Prompts, screenshots, projects, and images do not pass through Slide Studio servers.</span>
        </p>
      </div>
      <footer class="agent-modal-footer">
        <span class="agent-connection-status" data-local-mcp-status data-status="idle" role="status">Not connected</span>
        <button class="button button--primary agent-modal-connect" type="button" data-local-mcp-connect>Connect to local companion</button>
      </footer>
    </section>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("[data-local-mcp-close]").addEventListener("click", localMcpCloseModal);
  backdrop.querySelector("[data-local-mcp-connect]").addEventListener("click", localMcpConnectFromClick);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) localMcpCloseModal(); });
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
    } catch { /* Permission name unavailable in this Chrome version. */ }
  }
  return false;
}

async function localMcpConnectFromClick() {
  if (localMcpBridgeState.connected || localMcpBridgeState.connecting) return;
  localMcpBridgeState.connecting = true;
  localMcpSetStatus("connecting", "Requesting access to the local companion…");
  try {
    const health = await localMcpRequest("/health");
    if (!health.ok) throw new Error(`Local companion returned ${health.status}`);
    await window.slideStudioReady;
    localMcpBridgeState.shouldReconnect = true;
    await localMcpHandshake();
    void localMcpPollWithReconnect();
  } catch (error) {
    localMcpBridgeState.connected = false;
    localMcpBridgeState.shouldReconnect = false;
    const denied = await localMcpPermissionWasDenied();
    localMcpSetStatus(denied ? "denied" : "error", denied
      ? "Local access was blocked. Allow it in Chrome site settings, then try again."
      : "No local companion found. Start or restart your AI agent, then try again.");
    localMcpAddEvent(`Connection failed: ${error.message}`);
  } finally {
    localMcpBridgeState.connecting = false;
  }
}

async function localMcpHandshake() {
  localMcpBridgeState.sessionToken = null;
  const response = await localMcpSendJson("/connect", {
    editorId: localMcpBridgeState.editorId,
    protocolVersion: window.slideStudioAgent.protocolVersion,
    pageUrl: location.href,
    pageOrigin: location.origin,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    state: window.slideStudioAgent.inspect({ includeAllProjects: false }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Bridge returned ${response.status}`);
  if (result.protocolVersion !== window.slideStudioAgent.protocolVersion) throw new Error("The website and local companion versions are incompatible. Update the npm package and reload this page.");
  localMcpBridgeState.sessionToken = result.sessionToken;
  localMcpBridgeState.agents = result.agents || [];
  localMcpBridgeState.connected = true;
  localMcpAddEvent("Companion handshake completed");
  localMcpSetStatus("connected", "Connected locally");
  localMcpNotify(localMcpBridgeState.agents.length ? "Connected and ready to edit" : "Local companion connected; waiting for an agent", "success", localMcpBridgeState.agents[0]);
  void localMcpActivateVisibleEditor();
}

async function localMcpActivateVisibleEditor() {
  if (!localMcpBridgeState.connected || document.visibilityState !== "visible" || !document.hasFocus()) return;
  try {
    const response = await localMcpSendJson("/activate", { editorId: localMcpBridgeState.editorId });
    if (!response.ok) throw new Error(`Activate returned ${response.status}`);
  } catch (error) {
    localMcpAddEvent(`Could not activate this tab: ${error.message}`);
  }
}

function localMcpHandleSystemEvent(event) {
  if (event.type === "agents.changed") {
    const previous = new Set(localMcpBridgeState.agents.map((agent) => agent.id));
    localMcpBridgeState.agents = event.agents || [];
    localMcpSetStatus("connected", "Connected locally");
    for (const agent of localMcpBridgeState.agents) if (!previous.has(agent.id)) localMcpNotify("Connected and ready to edit", "success", agent);
  } else if (event.type === "notification") {
    localMcpNotify(event.message, event.tone, event.agent);
  }
}

async function localMcpPollWithReconnect() {
  while (!localMcpBridgeState.stopped && localMcpBridgeState.shouldReconnect) {
    try {
      if (!localMcpBridgeState.connected) await localMcpHandshake();
      await localMcpPoll();
    } catch (error) {
      if (localMcpBridgeState.connected) localMcpAddEvent(`Disconnected: ${error.message}`);
      localMcpBridgeState.connected = false;
      localMcpBridgeState.sessionToken = null;
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
    const event = await response.json();
    if (event.kind === "system") {
      localMcpHandleSystemEvent(event);
      continue;
    }
    localMcpAddEvent(`Tool call: ${event.toolName}`);
    localMcpNotify(event.label || "Editing the current slide…", "agent", event.agent);
    try {
      const result = await window.slideStudioAgent.execute(event.operation);
      await localMcpSendJson("/result", { editorId: localMcpBridgeState.editorId, requestId: event.requestId, ok: true, result });
      localMcpAddEvent(`Applied: ${event.toolName}`);
    } catch (error) {
      await localMcpSendJson("/result", { editorId: localMcpBridgeState.editorId, requestId: event.requestId, ok: false, error: error.message });
      localMcpAddEvent(`Failed: ${event.toolName}`);
      localMcpNotify(error.message, "error", event.agent);
    }
  }
}

async function localMcpFetchMedia(mediaId) {
  const response = await localMcpRequest(`/media/${encodeURIComponent(mediaId)}?editorId=${encodeURIComponent(localMcpBridgeState.editorId)}`);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not read local image.");
  const blob = await response.blob();
  const name = decodeURIComponent(response.headers.get("X-Slide-Studio-Filename") || "image");
  return { file: new File([blob], name, { type: blob.type }), name };
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest?.('[data-action="connect-agent"]');
  if (trigger) localMcpOpenModal(trigger);
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") localMcpCloseModal(); });

const localMcpAppRoot = document.querySelector("#app");
if (localMcpAppRoot) new MutationObserver(() => localMcpSetStatus(localMcpBridgeState.status, localMcpBridgeState.statusMessage)).observe(localMcpAppRoot, { childList: true, subtree: true });

window.addEventListener("beforeunload", () => {
  localMcpBridgeState.stopped = true;
  localMcpBridgeState.shouldReconnect = false;
});
window.addEventListener("focus", localMcpActivateVisibleEditor);
document.addEventListener("visibilitychange", localMcpActivateVisibleEditor);

window.slideStudioLocalMcpBridge = {
  open: localMcpOpenModal,
  connect: localMcpConnectFromClick,
  fetchMedia: localMcpFetchMedia,
  notify: localMcpNotify,
  getState: () => ({ ...localMcpBridgeState, lastFocusedElement: undefined }),
};
