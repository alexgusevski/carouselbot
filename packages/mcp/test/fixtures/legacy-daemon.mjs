#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import {
  BRIDGE_HOST, BRIDGE_PORT, DAEMON_API_VERSION, DAEMON_INTERNAL_ACTIONS,
  DAEMON_LOCK_PATH, DAEMON_STATE_PATH, PROTOCOL_VERSION, STATE_DIRECTORY,
} from "../../src/config.mjs";

const secret = randomBytes(32).toString("base64url");
const advertiseCompatibleActions = process.env.CAROUSELBOT_TEST_LEGACY_CAPABILITIES === "compatible";
let closing = false;

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function authorized(request) {
  return request.headers.authorization === `Bearer ${secret}`;
}

const server = createServer(async (request, response) => {
  if (!authorized(request)) return send(response, 401, { error: "Unauthorized." });
  if (request.url === "/internal/health" && request.method === "GET") {
    return send(response, 200, {
      ok: true,
      pid: process.pid,
      version: "0.2.0",
      protocolVersion: PROTOCOL_VERSION,
      ...(advertiseCompatibleActions ? {
        daemonApiVersion: DAEMON_API_VERSION,
        capabilities: { internalActions: [...DAEMON_INTERNAL_ACTIONS] },
      } : {}),
    });
  }
  if (request.url === "/internal/shutdown" && request.method === "POST") {
    send(response, 202, { ok: true, pid: process.pid });
    setImmediate(() => void shutdown());
    return;
  }
  if (request.url === "/internal/client/connect" && request.method === "POST") {
    return send(response, 200, { ok: true });
  }
  if (request.url === "/internal/client/disconnect" && request.method === "POST") {
    return send(response, 200, { ok: true });
  }
  return send(response, 400, { error: "Unknown internal action: list_local_fonts" });
});

async function shutdown() {
  if (closing) return;
  closing = true;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  const state = await readFile(DAEMON_STATE_PATH, "utf8").then(JSON.parse).catch(() => null);
  if (state?.pid === process.pid) await unlink(DAEMON_STATE_PATH).catch(() => {});
  await unlink(DAEMON_LOCK_PATH).catch(() => {});
}

process.once("SIGTERM", () => void shutdown().finally(() => process.exit()));
process.once("SIGINT", () => void shutdown().finally(() => process.exit()));

await mkdir(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
await writeFile(DAEMON_LOCK_PATH, String(process.pid), { mode: 0o600 });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(BRIDGE_PORT, BRIDGE_HOST, resolve);
});
await writeFile(DAEMON_STATE_PATH, JSON.stringify({
  pid: process.pid,
  port: BRIDGE_PORT,
  secret,
  version: "0.2.0",
  protocolVersion: PROTOCOL_VERSION,
}), { mode: 0o600 });

