import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BRIDGE_URL, DAEMON_STATE_PATH, PACKAGE_VERSION, PROTOCOL_VERSION } from "./config.mjs";

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
  if (!response.ok) throw new Error(value.error || `Local companion returned ${response.status}.`);
  return value;
}

async function healthyState() {
  const state = await readState();
  if (!state?.secret || state.port == null) return null;
  try {
    const result = await daemonRequest(state, "/internal/health");
    if (result.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Local companion protocol ${result.protocolVersion} is incompatible with package protocol ${PROTOCOL_VERSION}. Restart all Slide Studio MCP clients.`);
    return state;
  } catch (error) {
    if (String(error.message).includes("incompatible")) throw error;
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
  const state = await ensureDaemon();
  const clientId = randomUUID();
  let clientName = initialName;
  let clientVersion = initialVersion;
  let closed = false;

  const post = (path, body) => daemonRequest(state, path, { method: "POST", body: JSON.stringify(body) });
  const register = () => post("/internal/client/connect", { clientId, name: clientName, version: clientVersion });
  await register();
  const heartbeat = setInterval(() => {
    if (!closed) void post("/internal/client/heartbeat", { clientId }).catch(() => {});
  }, 15_000);
  heartbeat.unref();

  return {
    clientId,
    daemon: { pid: state.pid, url: BRIDGE_URL, version: state.version, packageVersion: PACKAGE_VERSION },
    async identify(name, version) {
      clientName = name || clientName;
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
      await post("/internal/client/disconnect", { clientId }).catch(() => {});
    },
  };
}

export async function companionDoctor() {
  const state = await ensureDaemon();
  const health = await daemonRequest(state, "/internal/health");
  return { ...health, url: BRIDGE_URL, stateFile: DAEMON_STATE_PATH };
}
