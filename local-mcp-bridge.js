const LOCAL_MCP_BRIDGE_URL = (() => {
  if (window.__CAROUSELBOT_MCP_BRIDGE_URL || window.__SLIDE_STUDIO_MCP_BRIDGE_URL) return window.__CAROUSELBOT_MCP_BRIDGE_URL || window.__SLIDE_STUDIO_MCP_BRIDGE_URL;
  const localPort = new URLSearchParams(location.search).get("__mcpBridgePort");
  if (["127.0.0.1", "localhost"].includes(location.hostname) && /^\d{2,5}$/.test(localPort || "")) return `http://127.0.0.1:${localPort}`;
  return "http://127.0.0.1:43117";
})();
const LOCAL_MCP_RETRY_MS = 1200;
const LOCAL_MCP_HEARTBEAT_MS = 10_000;
const LOCAL_MCP_REQUEST_TIMEOUT_MS = 8_000;
const LOCAL_MCP_EVENT_REQUEST_TIMEOUT_MS = 1_500;
const LOCAL_MCP_POLL_INTERVAL_MS = 250;
const LOCAL_MCP_NOTIFICATION_DURATION_MS = 6_300;
const LOCAL_MCP_CONNECTION_KEYS = ["carouselbot:mcp-connected", "slide-studio:mcp-connected"];
const LOCAL_MCP_EDITOR_KEYS = ["carouselbot:mcp-editor-id", "slide-studio:mcp-editor-id"];
const LOCAL_MCP_ACTIVITY_CHANNEL = "carouselbot:mcp-activity";
const LOCAL_MCP_AGENT_PROMPT = "Read https://raw.githubusercontent.com/alexgusevski/carouselbot/refs/heads/main/packages/mcp/README.md and install and configure the CarouselBot MCP and skill for this agent. Do not stop for a restart: if native MCP tools are not available in this session, use the documented CLI fallback so you can operate CarouselBot immediately. When you’re done, reply concisely with: “I’m done and ready to test the connection.”";

function localMcpConnectionWasRemembered() {
  try {
    return LOCAL_MCP_CONNECTION_KEYS.some((key) => localStorage.getItem(key) === "1");
  } catch {
    return false;
  }
}

function localMcpRememberConnection() {
  try {
    LOCAL_MCP_CONNECTION_KEYS.forEach((key) => localStorage.setItem(key, "1"));
  } catch { /* The live connection still works when storage is unavailable. */ }
}

function localMcpForgetConnection() {
  try {
    LOCAL_MCP_CONNECTION_KEYS.forEach((key) => localStorage.removeItem(key));
  } catch { /* The live connection can still be stopped. */ }
}

function localMcpEditorId() {
  try {
    const existing = LOCAL_MCP_EDITOR_KEYS.map((key) => sessionStorage.getItem(key)).find(Boolean);
    if (existing) {
      LOCAL_MCP_EDITOR_KEYS.forEach((key) => sessionStorage.setItem(key, existing));
      return existing;
    }
    const created = crypto.randomUUID();
    LOCAL_MCP_EDITOR_KEYS.forEach((key) => sessionStorage.setItem(key, created));
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

const localMcpBridgeState = {
  connected: false,
  connecting: false,
  shouldReconnect: false,
  reconnectLoopRunning: false,
  reconnectFailures: 0,
  connectionRemembered: localMcpConnectionWasRemembered(),
  stopped: false,
  editorId: localMcpEditorId(),
  sessionToken: null,
  agents: [],
  editSessions: [],
  events: [],
  status: "idle",
  statusMessage: "Not connected",
  lastFocusedElement: null,
};
const localMcpActivityChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel(LOCAL_MCP_ACTIVITY_CHANNEL) : null;

async function localMcpRequest(path, init = {}) {
  const { timeoutMs = path.startsWith("/events?") ? 0 : LOCAL_MCP_REQUEST_TIMEOUT_MS, ...fetchInit } = init;
  const headers = new Headers(init.headers || {});
  if (localMcpBridgeState.sessionToken && path !== "/connect") headers.set("Authorization", `Bearer ${localMcpBridgeState.sessionToken}`);
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(new DOMException("Local companion request timed out.", "TimeoutError")), timeoutMs) : null;
  const requestInit = { mode: "cors", cache: "no-store", ...fetchInit, headers, ...(controller ? { signal: controller.signal } : {}) };
  try {
    try {
      return await fetch(new Request(`${LOCAL_MCP_BRIDGE_URL}${path}`, { ...requestInit, targetAddressSpace: "loopback" }));
    } catch (error) {
      if (controller?.signal.aborted) throw error;
      return await fetch(`${LOCAL_MCP_BRIDGE_URL}${path}`, requestInit);
    }
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

function localMcpSendJson(path, value, init = {}) {
  return localMcpRequest(path, {
    ...init,
    method: "POST",
    headers: { ...init.headers, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

const LOCAL_MCP_AGENT_PRESENTATIONS = [
  { matches: ["claude", "anthropic"], label: "Claude", icon: "/assets/claude-ai-icon-f3a857f4.svg" },
  { matches: ["codex", "openai"], label: "Codex", icon: "/assets/codex-logo-colored-53743834.svg" },
  { matches: ["hermes"], label: "Hermes", icon: "/assets/hermes-agent-icon-e5340726.webp" },
  { matches: ["opencode"], label: "OpenCode" },
  { matches: ["openclaw"], label: "OpenClaw" },
];

function localMcpAgentPresentation(agent) {
  const rawName = String(agent?.name || "AI agent").trim();
  const normalizedName = rawName.toLowerCase();
  const known = LOCAL_MCP_AGENT_PRESENTATIONS.find(({ matches }) => matches.some((match) => normalizedName.includes(match)));
  if (known) return known;
  const initials = rawName === "AI agent"
    ? "AI"
    : rawName.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase().slice(0, 2) || "AI";
  return { label: rawName, initials };
}

function localMcpAgentLabel(agent) {
  return localMcpAgentPresentation(agent).label;
}

function localMcpAgentIcon(agent) {
  const presentation = localMcpAgentPresentation(agent);
  if (presentation.icon) {
    return `<span class="agent-activity-icon" aria-hidden="true"><img src="${presentation.icon}" alt="" /></span>`;
  }
  return `<span class="agent-activity-icon agent-activity-icon--generic" aria-hidden="true">${escapeHtml(presentation.initials || "AI")}</span>`;
}

function localMcpConnectionMessage() {
  if (!localMcpBridgeState.connected) return localMcpBridgeState.statusMessage;
  const assignment = localMcpBridgeState.editSessions.find((session) => session.editorId === localMcpBridgeState.editorId);
  const suffix = assignment ? ` · editing ${assignment.purpose}` : ` · editor ${localMcpBridgeState.editorId.slice(0, 8)}`;
  if (!localMcpBridgeState.agents.length) return `Local companion connected${suffix}`;
  const labels = [...new Set(localMcpBridgeState.agents.map(localMcpAgentLabel))];
  return `${labels.join(", ")} connected${suffix}`;
}

function localMcpSetStatus(status, message = localMcpBridgeState.statusMessage) {
  localMcpBridgeState.status = status;
  localMcpBridgeState.statusMessage = message;
  const displayMessage = status === "connected" ? localMcpConnectionMessage() : message;
  document.querySelectorAll('[data-action="connect-agent"]').forEach((button) => {
    button.dataset.mcpStatus = status;
    const label = button.querySelector(".agent-connect-label");
    const labelText = status === "connected" ? "Connected" : status === "connecting" ? "Connecting" : "Connect AI";
    if (label && label.textContent !== labelText) label.textContent = labelText;
    button.setAttribute("aria-label", status === "connected" ? displayMessage : status === "connecting" ? "Connecting via MCP" : "Connect via MCP");
    button.title = status === "connected" ? displayMessage : status === "connecting" ? "Connecting via MCP" : "Connect via MCP";
  });
  const statusElement = document.querySelector("[data-local-mcp-status]");
  if (statusElement) {
    statusElement.dataset.status = status;
    statusElement.textContent = displayMessage;
  }
  const connectButton = document.querySelector("[data-local-mcp-connect]");
  if (connectButton) {
    connectButton.disabled = status === "connecting";
    connectButton.dataset.connected = status === "connected" ? "true" : "false";
    connectButton.textContent = status === "connecting" ? "Connecting…" : status === "connected" ? "Disconnect this browser" : "Connect this browser";
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
  item.innerHTML = `${localMcpAgentIcon(agent)}<span><strong>${escapeHtml(localMcpAgentLabel(agent))}</strong>${escapeHtml(value)}</span>`;
  stack.appendChild(item);
  requestAnimationFrame(() => item.classList.add("is-visible"));
  window.setTimeout(() => {
    item.classList.remove("is-visible");
    window.setTimeout(() => item.remove(), 220);
  }, LOCAL_MCP_NOTIFICATION_DURATION_MS);
}

function localMcpBroadcastActivity(message, tone = "agent", agent = null, { dashboardOnly = false } = {}) {
  if (!dashboardOnly || document.querySelector(".dashboard")) localMcpNotify(message, tone, agent);
  localMcpActivityChannel?.postMessage({
    sourceEditorId: localMcpBridgeState.editorId,
    message: String(message || "").trim().slice(0, 240),
    tone,
    agent,
    dashboardOnly,
  });
}

localMcpActivityChannel?.addEventListener("message", (event) => {
  const activity = event.data;
  if (!activity || activity.sourceEditorId === localMcpBridgeState.editorId || typeof activity.message !== "string") return;
  if (activity.dashboardOnly && !document.querySelector(".dashboard")) return;
  localMcpNotify(activity.message, activity.tone, activity.agent);
});

function localMcpEnsureModal() {
  let backdrop = document.querySelector("#agent-connect-modal");
  if (backdrop) return backdrop;
  backdrop = document.createElement("div");
  backdrop.id = "agent-connect-modal";
  backdrop.className = "agent-modal-backdrop";
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <section class="agent-modal" role="dialog" aria-modal="true" aria-labelledby="agent-modal-title">
      <button class="icon-button agent-modal-close" type="button" data-local-mcp-close aria-label="Close connect dialog">×</button>
      <header class="agent-modal-header">
        <h2 id="agent-modal-title">Connect via MCP</h2>
        <div class="agent-modal-intro">
          <div class="agent-client-icons" aria-label="Compatible with Claude, Codex, Hermes, and other MCP clients">
            <span title="Claude"><img src="/assets/claude-ai-icon-f3a857f4.svg" alt="Claude" /></span>
            <span title="Codex"><img src="/assets/codex-logo-colored-53743834.svg" alt="Codex" /></span>
            <span title="Hermes"><img src="/assets/hermes-agent-icon-e5340726.webp" alt="Hermes" /></span>
          </div>
          <p class="agent-modal-agent-label">Use with an agent</p>
        </div>
      </header>
      <div class="agent-modal-body">
        <ol class="agent-steps">
          <li>
            <div class="agent-step-content">
              <div class="agent-step-heading">
                <strong>Send this to your agent</strong>
                <button class="agent-copy-prompt" type="button" data-copy-agent-prompt>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>
                  <span>Copy prompt</span>
                </button>
              </div>
              <div class="agent-prompt-box">
                <p data-agent-install-prompt></p>
              </div>
            </div>
          </li>
          <li>
            <div class="agent-step-content">
              <strong>Connect this browser</strong>
              <p class="agent-step-description">Click below and accept any browser prompts.</p>
              <div class="agent-connect-actions">
                <span class="agent-connection-status" data-local-mcp-status data-status="idle" role="status">Not connected</span>
                <button class="button button--primary agent-modal-connect" type="button" data-local-mcp-connect>Connect this browser</button>
              </div>
            </div>
          </li>
        </ol>
        <details class="agent-how-it-works">
          <summary><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>How it works</summary>
          <p>The setup installs the local MCP and skill, and your agent runs it. After you approve browser access, its edits appear here live. Projects and media stay on your computer.</p>
        </details>
      </div>
    </section>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("[data-agent-install-prompt]").textContent = LOCAL_MCP_AGENT_PROMPT;
  backdrop.querySelector("[data-local-mcp-close]").addEventListener("click", localMcpCloseModal);
  backdrop.querySelector("[data-local-mcp-connect]").addEventListener("click", localMcpToggleConnection);
  backdrop.querySelector("[data-copy-agent-prompt]").addEventListener("click", localMcpCopyAgentPrompt);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) localMcpCloseModal(); });
  localMcpSetStatus(localMcpBridgeState.status, localMcpBridgeState.statusMessage);
  return backdrop;
}

async function localMcpCopyAgentPrompt(event) {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(LOCAL_MCP_AGENT_PROMPT);
  } catch {
    const input = document.createElement("textarea");
    input.value = LOCAL_MCP_AGENT_PROMPT;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  const label = button.querySelector("span");
  label.textContent = "Copied";
  button.dataset.copied = "true";
  window.setTimeout(() => {
    label.textContent = "Copy prompt";
    delete button.dataset.copied;
  }, 1800);
}

function localMcpOpenModal(trigger) {
  const backdrop = localMcpEnsureModal();
  localMcpBridgeState.lastFocusedElement = trigger || document.activeElement;
  backdrop.hidden = false;
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => backdrop.querySelector("[data-local-mcp-connect]")?.focus());
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
  if (localMcpBridgeState.reconnectLoopRunning) {
    localMcpBridgeState.reconnectFailures = 0;
    localMcpSetStatus("connecting", "Retrying the local companion…");
    return;
  }
  localMcpBridgeState.connecting = true;
  localMcpSetStatus("connecting", "Requesting access to the local companion…");
  try {
    const health = await localMcpRequest("/health");
    if (!health.ok) throw new Error(`Local companion returned ${health.status}`);
    await window.carouselBotReady;
    localMcpBridgeState.shouldReconnect = true;
    await localMcpHandshake();
    localMcpRememberConnection();
    localMcpBridgeState.connectionRemembered = true;
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

async function localMcpDisconnectFromClick() {
  if (!localMcpBridgeState.connected && !localMcpBridgeState.connecting) return;
  localMcpBridgeState.shouldReconnect = false;
  localMcpBridgeState.connectionRemembered = false;
  localMcpForgetConnection();
  const token = localMcpBridgeState.sessionToken;
  try {
    if (token) await localMcpSendJson("/disconnect", { editorId: localMcpBridgeState.editorId });
  } catch { /* The companion may already be gone. */ }
  localMcpBridgeState.connected = false;
  localMcpBridgeState.connecting = false;
  localMcpBridgeState.sessionToken = null;
  localMcpBridgeState.agents = [];
  localMcpBridgeState.editSessions = [];
  localMcpBridgeState.reconnectFailures = 0;
  localMcpSetStatus("idle", "Not connected");
  localMcpAddEvent("Browser disconnected by user");
}

function localMcpToggleConnection() {
  return localMcpBridgeState.connected ? localMcpDisconnectFromClick() : localMcpConnectFromClick();
}

async function localMcpHandshake() {
  localMcpBridgeState.sessionToken = null;
  const response = await localMcpSendJson("/connect", {
    editorId: localMcpBridgeState.editorId,
    protocolVersion: window.carouselBotAgent.protocolVersion,
    pageUrl: location.href,
    pageOrigin: location.origin,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    state: window.carouselBotAgent.inspect({ includeAllProjects: false }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Bridge returned ${response.status}`);
  if (result.protocolVersion !== window.carouselBotAgent.protocolVersion) throw new Error("The website and local companion versions are incompatible. Update the npm package and reload this page.");
  localMcpBridgeState.sessionToken = result.sessionToken;
  localMcpBridgeState.agents = result.agents || [];
  localMcpBridgeState.editSessions = result.editSessions || [];
  localMcpBridgeState.connected = true;
  localMcpBridgeState.reconnectFailures = 0;
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
    localMcpBridgeState.connected = false;
    localMcpBridgeState.sessionToken = null;
    localMcpBridgeState.shouldReconnect = true;
    localMcpSetStatus("connecting", "Reconnecting to the local companion…");
    void localMcpPollWithReconnect();
  }
}

async function localMcpHeartbeat() {
  if (!localMcpBridgeState.connected || !localMcpBridgeState.sessionToken) return;
  try {
    const response = await localMcpSendJson("/heartbeat", { editorId: localMcpBridgeState.editorId });
    if (!response.ok) throw new Error(`Heartbeat returned ${response.status}`);
  } catch {
    // The event poll owns reconnect state. A heartbeat may race with a daemon
    // restart, so it must never create a second reconnect loop.
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
  } else if (event.type === "edit-sessions.changed") {
    localMcpBridgeState.editSessions = event.editSessions || [];
    localMcpSetStatus("connected", "Connected locally");
  }
}

async function localMcpPollWithReconnect() {
  if (localMcpBridgeState.reconnectLoopRunning) return;
  localMcpBridgeState.reconnectLoopRunning = true;
  try {
    while (!localMcpBridgeState.stopped && localMcpBridgeState.shouldReconnect) {
      try {
        if (!localMcpBridgeState.connected) await localMcpHandshake();
        localMcpBridgeState.connecting = false;
        await localMcpPoll();
      } catch (error) {
        if (localMcpBridgeState.connected) localMcpAddEvent(`Disconnected: ${error.message}`);
        localMcpBridgeState.connected = false;
        localMcpBridgeState.connecting = false;
        localMcpBridgeState.sessionToken = null;
        localMcpBridgeState.reconnectFailures += 1;
        const waiting = localMcpBridgeState.reconnectFailures > 1;
        localMcpSetStatus(waiting ? "error" : "connecting", waiting
          ? "Local companion unavailable. Retrying automatically…"
          : "Reconnecting to the local companion…");
        await new Promise((resolve) => setTimeout(resolve, LOCAL_MCP_RETRY_MS));
      }
    }
  } finally {
    localMcpBridgeState.reconnectLoopRunning = false;
  }
}

async function localMcpResumeRememberedConnection() {
  if (!localMcpBridgeState.connectionRemembered || localMcpBridgeState.connected || localMcpBridgeState.reconnectLoopRunning) return;
  await window.carouselBotReady;
  if (localMcpBridgeState.connected || localMcpBridgeState.connecting || localMcpBridgeState.reconnectLoopRunning) return;
  localMcpBridgeState.shouldReconnect = true;
  localMcpBridgeState.connecting = true;
  localMcpBridgeState.reconnectFailures = 0;
  localMcpSetStatus("connecting", "Reconnecting to the local companion…");
  void localMcpPollWithReconnect();
}

async function localMcpPoll() {
  while (!localMcpBridgeState.stopped && localMcpBridgeState.connected) {
    let response;
    try {
      response = await localMcpRequest(`/events?editorId=${encodeURIComponent(localMcpBridgeState.editorId)}&wait=0`, { timeoutMs: LOCAL_MCP_EVENT_REQUEST_TIMEOUT_MS });
    } catch (error) {
      if (!["AbortError", "TimeoutError"].includes(error?.name)) throw error;
      await new Promise((resolve) => setTimeout(resolve, LOCAL_MCP_POLL_INTERVAL_MS));
      continue;
    }
    if (response.status === 204) {
      await new Promise((resolve) => setTimeout(resolve, LOCAL_MCP_POLL_INTERVAL_MS));
      continue;
    }
    if (!response.ok) throw new Error(`Event poll returned ${response.status}`);
    const event = await response.json();
    if (event.kind === "system") {
      localMcpHandleSystemEvent(event);
      continue;
    }
    localMcpAddEvent(`Tool call: ${event.toolName}`);
    localMcpBroadcastActivity(event.label || "Editing the current slide…", "agent", event.agent);
    try {
      const result = await window.carouselBotAgent.execute(event.operation);
      await localMcpSendJson("/result", { editorId: localMcpBridgeState.editorId, requestId: event.requestId, ok: true, result, state: window.carouselBotAgent.inspect({ includeAllProjects: false }) });
      localMcpAddEvent(`Applied: ${event.toolName}`);
      if (event.toolName === "create_project") {
        const projectName = String(result?.name || event.operation?.name || "New project").trim().slice(0, 160);
        localMcpBroadcastActivity(`Created ${projectName}`, "success", event.agent, { dashboardOnly: true });
      }
    } catch (error) {
      await localMcpSendJson("/result", { editorId: localMcpBridgeState.editorId, requestId: event.requestId, ok: false, error: error.message, state: window.carouselBotAgent.inspect({ includeAllProjects: false }) });
      localMcpAddEvent(`Failed: ${event.toolName}`);
      localMcpNotify(error.message, "error", event.agent);
    }
  }
}

async function localMcpFetchMedia(mediaId) {
  const response = await localMcpRequest(`/media/${encodeURIComponent(mediaId)}?editorId=${encodeURIComponent(localMcpBridgeState.editorId)}`);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not read local image.");
  const blob = await response.blob();
  const name = decodeURIComponent(response.headers.get("X-CarouselBot-Filename") || response.headers.get("X-Slide-Studio-Filename") || "image");
  return { file: new File([blob], name, { type: blob.type }), name };
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest?.('[data-action="connect-agent"]');
  if (trigger) localMcpOpenModal(trigger);
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") localMcpCloseModal(); });

const localMcpAppRoot = document.querySelector("#app");
if (localMcpAppRoot) new MutationObserver(() => localMcpSetStatus(localMcpBridgeState.status, localMcpBridgeState.statusMessage)).observe(localMcpAppRoot, { childList: true, subtree: true });

void localMcpResumeRememberedConnection();
const localMcpHeartbeatTimer = window.setInterval(() => void localMcpHeartbeat(), LOCAL_MCP_HEARTBEAT_MS);

window.addEventListener("beforeunload", () => {
  localMcpBridgeState.stopped = true;
  localMcpBridgeState.shouldReconnect = false;
  window.clearInterval(localMcpHeartbeatTimer);
  localMcpActivityChannel?.close();
});
window.addEventListener("focus", localMcpActivateVisibleEditor);
document.addEventListener("visibilitychange", localMcpActivateVisibleEditor);

window.carouselBotLocalMcpBridge = {
  open: localMcpOpenModal,
  connect: localMcpConnectFromClick,
  disconnect: localMcpDisconnectFromClick,
  fetchMedia: localMcpFetchMedia,
  notify: localMcpNotify,
  getState: () => ({ ...localMcpBridgeState, lastFocusedElement: undefined }),
};
window.slideStudioLocalMcpBridge = window.carouselBotLocalMcpBridge;
