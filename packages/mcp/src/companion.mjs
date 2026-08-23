import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BRIDGE_URL, DAEMON_STATE_PATH, PACKAGE_VERSION, PROTOCOL_VERSION } from "./config.mjs";
import { preferHostAgent } from "./agent-identity.mjs";

const DAEMON_ENTRY = fileURLToPath(new URL("daemon.mjs", import.meta.url));

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
    throw error;
  }
  return value;
}

async function healthyState() {
  const state = await readState();
  if (!state?.secret || state.port == null) return null;
  try {
    const result = await daemonRequest(state, "/internal/health");
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      const error = new Error(`Local companion ${result.version || "unknown"} uses protocol ${result.protocolVersion}; ${PACKAGE_VERSION} requires protocol ${PROTOCOL_VERSION}. Run \`npx -y slides-studio-mcp@beta restart\`, then reload the editor.`);
      error.code = "EPROTOCOL";
      throw error;
    }
    return state;
  } catch (error) {
    if (error.code === "EPROTOCOL") throw error;
    return null;
  }
}

async function ensureDaemon() {
  const existing = await healthyState();
  if (existing) return existing;
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await wait(100);
    const state = await healthyState();
    if (state) return state;
  }
  throw new Error("Could not start the local Slide Studio companion. Run `npx slides-studio-mcp doctor` for details.");
}

export async function createCompanion(initialName = "MCP agent", initialVersion = null) {
  let state = await ensureDaemon();
  const clientId = randomUUID();
  let clientName = initialName;
  let clientVersion = initialVersion;
  let closed = false;

  const rawPost = (path, body) => daemonRequest(state, path, { method: "POST", body: JSON.stringify(body) });
  const register = () => rawPost("/internal/client/connect", { clientId, name: clientName, version: clientVersion });
  const post = async (path, body) => {
    try {
      return await rawPost(path, body);
    } catch (error) {
      if (closed || (error.status && error.status !== 401)) throw error;
      state = await ensureDaemon();
      await register();
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
    get daemon() { return { pid: state.pid, url: BRIDGE_URL, version: state.version, packageVersion: PACKAGE_VERSION }; },
    async identify(name, version) {
      clientName = preferHostAgent(name, clientName);
      clientVersion = version || clientVersion;
      await register();
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
  return { ...health, url: BRIDGE_URL, stateFile: DAEMON_STATE_PATH };
}

export async function companionRestart() {
  const previous = await readState();
  if (previous?.secret && Number.isInteger(previous.pid) && previous.pid > 0) {
    const health = await daemonRequest(previous, "/internal/health").catch(() => null);
    if (health?.pid === previous.pid) {
      await daemonRequest(previous, "/internal/shutdown", { method: "POST", body: "{}" }).catch(() => {
        try { process.kill(previous.pid, "SIGTERM"); } catch { /* It already stopped. */ }
      });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        try {
          process.kill(previous.pid, 0);
          await wait(100);
        } catch {
          break;
        }
      }
    }
  }
  const state = await ensureDaemon();
  const health = await daemonRequest(state, "/internal/health");
  return { ...health, url: BRIDGE_URL, stateFile: DAEMON_STATE_PATH, previousPid: previous?.pid || null };
}
