import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_URL, DAEMON_API_VERSION, DAEMON_INTERNAL_ACTIONS, DAEMON_STATE_PATH,
  PACKAGE_VERSION, PROTOCOL_VERSION,
} from "./config.mjs";
import { preferHostAgent } from "./agent-identity.mjs";

const DAEMON_ENTRY = fileURLToPath(new URL("daemon.mjs", import.meta.url));
const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 8_000;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readState() {
  try { return JSON.parse(await readFile(DAEMON_STATE_PATH, "utf8")); }
  catch { return null; }
}

async function daemonRequest(state, path, init = {}) {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    ...init,
    headers: { "Authorization": `Bearer ${state.secret}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || `Local companion returned ${response.status}.`);
    error.status = response.status;
    if (value.code) error.code = value.code;
    if (value.details) error.details = value.details;
    throw error;
  }
  return value;
}

function compatibilityIssue(health, { requireCurrentVersion = false } = {}) {
  if (health.protocolVersion !== PROTOCOL_VERSION) {
    return `browser protocol ${health.protocolVersion ?? "unknown"} (requires ${PROTOCOL_VERSION})`;
  }
  const advertisedActions = new Set(Array.isArray(health.capabilities?.internalActions) ? health.capabilities.internalActions : []);
  const missingActions = DAEMON_INTERNAL_ACTIONS.filter((action) => !advertisedActions.has(action));
  if (missingActions.length) return `missing internal actions: ${missingActions.join(", ")}`;
  const advertisedApiVersion = Number(health.daemonApiVersion);
  if (!Number.isInteger(advertisedApiVersion) || advertisedApiVersion < DAEMON_API_VERSION) {
    return `daemon API ${health.daemonApiVersion ?? "unknown"} (requires ${DAEMON_API_VERSION})`;
  }
  if (requireCurrentVersion && health.version !== PACKAGE_VERSION) {
    return `package ${health.version || "unknown"} (requires ${PACKAGE_VERSION})`;
  }
  return null;
}

function stateWithHealth(state, health) {
  return {
    ...state,
    pid: health.pid || state.pid,
    version: health.version || state.version || null,
    protocolVersion: health.protocolVersion,
    daemonApiVersion: health.daemonApiVersion,
    capabilities: health.capabilities,
  };
}

async function inspectDaemon(options = {}) {
  const state = await readState();
  if (!state?.secret || state.port == null) return null;
  try {
    const health = await daemonRequest(state, "/internal/health");
    return { state: stateWithHealth(state, health), health, issue: compatibilityIssue(health, options) };
  } catch {
    return null;
  }
}

async function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function stopDaemon({ state, health }) {
  const pid = Number(health?.pid || state?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return;
  let shutdownAccepted = false;
  try {
    const response = await daemonRequest(state, "/internal/shutdown", { method: "POST", body: "{}" });
    shutdownAccepted = response?.pid === pid;
  } catch { /* Older companions may not expose graceful shutdown. */ }
  if (!shutdownAccepted) {
    try { process.kill(pid, "SIGTERM"); } catch { return; }
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && await processIsRunning(pid)) await wait(100);
  if (await processIsRunning(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* It already stopped. */ }
    const forcedDeadline = Date.now() + 2_000;
    while (Date.now() < forcedDeadline && await processIsRunning(pid)) await wait(100);
  }
}

let ensureQueue = Promise.resolve();

async function ensureDaemonOnce({ forceReplace = false, requireCurrentVersion = false } = {}) {
  const options = { requireCurrentVersion };
  const existing = await inspectDaemon(options);
  if (existing && !forceReplace && !existing.issue) return existing.state;
  if (existing) await stopDaemon(existing);

  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastIssue = existing?.issue || null;
  while (Date.now() < deadline) {
    await wait(100);
    const candidate = await inspectDaemon(options);
    if (!candidate) continue;
    if (!candidate.issue) return candidate.state;
    lastIssue = candidate.issue;
  }
  const detail = lastIssue ? ` Last companion was incompatible: ${lastIssue}.` : "";
  throw new Error(`Could not start a compatible local CarouselBot companion.${detail} Run \`npx -y carouselbot@latest doctor\` for details.`);
}

function ensureDaemon(options = {}) {
  const operation = ensureQueue.then(() => ensureDaemonOnce(options));
  ensureQueue = operation.catch(() => {});
  return operation;
}

function unsupportedInternalAction(error) {
  return error?.code === "UNSUPPORTED_INTERNAL_ACTION" || /Unknown internal action:/i.test(error?.message || "");
}

export async function createCompanion(initialName = "MCP agent", initialVersion = null) {
  // Compatibility is resolved before the stdio server advertises its tools. A
  // stale shared daemon is replaced in place; this MCP process stays alive and
  // the browser's remembered loopback connection reconnects automatically.
  let state = await ensureDaemon();
  const clientId = randomUUID();
  let clientName = initialName;
  let clientVersion = initialVersion;
  let closed = false;
  let unsupportedRecovery = null;
  const repairedUnsupportedActions = new Set();

  const rawPost = (path, body) => daemonRequest(state, path, { method: "POST", body: JSON.stringify(body) });
  const register = () => rawPost("/internal/client/connect", { clientId, name: clientName, version: clientVersion });
  const recoverUnsupportedAction = (action) => {
    if (unsupportedRecovery) return unsupportedRecovery;
    if (repairedUnsupportedActions.has(action)) return null;
    repairedUnsupportedActions.add(action);
    const recovery = (async () => {
      state = await ensureDaemon({ forceReplace: true });
      await register();
    })();
    const trackedRecovery = recovery.finally(() => {
      if (unsupportedRecovery === trackedRecovery) unsupportedRecovery = null;
    });
    unsupportedRecovery = trackedRecovery;
    return unsupportedRecovery;
  };
  const post = async (path, body) => {
    try {
      return await rawPost(path, body);
    } catch (error) {
      const unsupportedAction = path === "/internal/call" && unsupportedInternalAction(error) ? body.action : null;
      if (closed || (error.status && error.status !== 401 && !unsupportedAction)) throw error;
      if (unsupportedAction) {
        const recovery = recoverUnsupportedAction(unsupportedAction);
        if (!recovery) throw error;
        await recovery;
      } else {
        state = await ensureDaemon();
        await register();
      }
      return rawPost(path, body);
    }
  };
  await register();
  const heartbeat = setInterval(() => {
    if (!closed) void post("/internal/client/heartbeat", { clientId }).catch(() => {});
  }, 15_000);
  heartbeat.unref();

  return {
    clientId,
    get daemon() {
      return {
        pid: state.pid,
        url: BRIDGE_URL,
        version: state.version,
        packageVersion: PACKAGE_VERSION,
        daemonApiVersion: state.daemonApiVersion,
        capabilities: state.capabilities,
      };
    },
    async identify(name, version) {
      clientName = preferHostAgent(name, clientName);
      clientVersion = version || clientVersion;
      await post("/internal/client/connect", { clientId, name: clientName, version: clientVersion });
    },
    async call(action, body = {}) {
      const response = await post("/internal/call", { clientId, action, ...body });
      return response.result;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      await rawPost("/internal/client/disconnect", { clientId }).catch(() => {});
    },
  };
}

export async function companionDoctor() {
  const state = await ensureDaemon();
  const health = await daemonRequest(state, "/internal/health");
  return { ...health, packageVersion: PACKAGE_VERSION, compatible: true, url: BRIDGE_URL, stateFile: DAEMON_STATE_PATH };
}

export async function companionUpgrade() {
  const previous = await inspectDaemon();
  const state = await ensureDaemon({ requireCurrentVersion: true });
  const health = await daemonRequest(state, "/internal/health");
  return {
    ...health,
    packageVersion: PACKAGE_VERSION,
    compatible: true,
    upgraded: Boolean(previous && previous.health.version !== health.version),
    previousPid: previous?.health.pid || null,
    url: BRIDGE_URL,
    stateFile: DAEMON_STATE_PATH,
  };
}

export async function companionRestart() {
  const previous = await inspectDaemon();
  const state = await ensureDaemon({ forceReplace: true });
  const health = await daemonRequest(state, "/internal/health");
  return {
    ...health,
    packageVersion: PACKAGE_VERSION,
    compatible: true,
    url: BRIDGE_URL,
    stateFile: DAEMON_STATE_PATH,
    previousPid: previous?.health.pid || null,
  };
}
