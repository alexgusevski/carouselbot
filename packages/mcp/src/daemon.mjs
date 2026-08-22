#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  ALLOWED_ORIGINS, BRIDGE_HOST, BRIDGE_PORT, BRIDGE_URL, DAEMON_LOCK_PATH,
  DAEMON_STATE_PATH, PACKAGE_NAME, PACKAGE_VERSION, PROTOCOL_VERSION, STATE_DIRECTORY,
} from "./config.mjs";

const MAX_JSON_BYTES = 40 * 1024 * 1024;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const EDITOR_TTL_MS = Number(process.env.SLIDE_STUDIO_EDITOR_TTL_MS) || 30 * 60_000;
const CLIENT_TTL_MS = 45_000;
const MEDIA_TTL_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 90_000;
const EVENT_POLL_TIMEOUT_MS = Number(process.env.SLIDE_STUDIO_EVENT_POLL_TIMEOUT_MS) || 5 * 60_000;
const daemonSecret = randomBytes(32).toString("base64url");
const editors = new Map();
const clients = new Map();
const inflight = new Map();
const media = new Map();
let focusedEditorId = null;
let lockHandle = null;
let idleSince = null;

function log(message) {
  process.stderr.write(`[slide-studio-daemon] ${message}\n`);
}

function activeEditors() {
  const cutoff = Date.now() - EDITOR_TTL_MS;
  return [...editors.values()].filter((editor) => (
    editor.lastSeen >= cutoff
    || Boolean(editor.poll && !editor.poll.destroyed && !editor.poll.writableEnded)
  ));
}

function activeClients() {
  const cutoff = Date.now() - CLIENT_TTL_MS;
  return [...clients.values()].filter((client) => client.lastSeen >= cutoff);
}

function publicClient(client) {
  return { id: client.id, name: client.name || "MCP agent", version: client.version || null };
}

function browserCors(origin) {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Expose-Headers": "X-Slide-Studio-Filename",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function sendJson(response, statusCode, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", ...headers });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("Request body must be valid JSON.")); }
    });
    request.on("error", reject);
  });
}

function bearer(request) {
  const value = request.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : null;
}

function requireInternal(request, response) {
  if (bearer(request) === daemonSecret) return true;
  sendJson(response, 401, { error: "Unauthorized." });
  return false;
}

function requireEditor(request, response, editorId, cors) {
  const editor = editors.get(editorId);
  if (!editor || bearer(request) !== editor.sessionToken) {
    sendJson(response, 401, { error: "Editor session is not authorized." }, cors);
    return null;
  }
  editor.lastSeen = Date.now();
  return editor;
}

function queueEditorEvent(editor, event) {
  editor.queue.push(event);
  if (editor.queue.length > 100) editor.queue.splice(0, editor.queue.length - 100);
  deliverNext(editor);
}

function endEditorPoll(editor) {
  if (!editor?.poll) return;
  const response = editor.poll;
  editor.poll = null;
  clearTimeout(editor.pollTimer);
  editor.pollTimer = null;
  if (!response.writableEnded && !response.destroyed) {
    response.writeHead(204, editor.cors || {});
    response.end();
  }
}

function disconnectEditor(editorId, message = "Browser editor disconnected.") {
  const editor = editors.get(editorId);
  if (!editor) return false;
  endEditorPoll(editor);
  editors.delete(editorId);
  if (focusedEditorId === editorId) focusedEditorId = null;
  for (const [requestId, pending] of inflight) {
    if (pending.editorId !== editorId) continue;
    inflight.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  return true;
}

function deliverNext(editor) {
  if (!editor?.poll || !editor.queue.length) return;
  const response = editor.poll;
  editor.poll = null;
  clearTimeout(editor.pollTimer);
  editor.pollTimer = null;
  sendJson(response, 200, editor.queue.shift(), editor.cors);
}

function broadcastAgents() {
  const event = { kind: "system", type: "agents.changed", agents: activeClients().map(publicClient) };
  for (const editor of activeEditors()) queueEditorEvent(editor, event);
}

function selectEditor(clientId) {
  const connected = activeEditors();
  const client = clients.get(clientId);
  const selected = client?.selectedEditorId && connected.find((editor) => editor.id === client.selectedEditorId);
  if (selected) return selected;
  const focused = focusedEditorId && connected.find((editor) => editor.id === focusedEditorId);
  if (focused) return focused;
  if (connected.length === 1) return connected[0];
  if (!connected.length) throw new Error("No Slide Studio editor is connected. Open the test editor and click Connect AI.");
  throw new Error("Multiple editors are connected and none is selected. Call list_editors, then select_editor.");
}

function callBrowser(clientId, toolName, operation, label) {
  const editor = selectEditor(clientId);
  const client = clients.get(clientId) || { id: clientId, name: "MCP agent" };
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(requestId);
      reject(new Error("The browser did not answer within 90 seconds."));
    }, COMMAND_TIMEOUT_MS);
    inflight.set(requestId, { resolve, reject, timer, editorId: editor.id });
    queueEditorEvent(editor, { kind: "command", requestId, toolName, operation, label, agent: publicClient(client) });
  });
}

function detectedMime(buffer, filename) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const header = buffer.subarray(0, 64).toString("ascii");
  if (/ftyp(?:avif|avis)/.test(header)) return "image/avif";
  const text = buffer.subarray(0, 1024).toString("utf8").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) return "image/svg+xml";
  const extension = extname(filename).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return null;
}

async function prepareMedia(filePath) {
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error("Image path must point to a regular file.");
  if (metadata.size > MAX_MEDIA_BYTES) throw new Error("Image is larger than the 25 MB local-transfer limit.");
  const buffer = await readFile(filePath);
  const mimeType = detectedMime(buffer, filePath);
  if (!mimeType) throw new Error("Unsupported image. Use PNG, JPEG, WebP, GIF, SVG, or AVIF.");
  const id = randomUUID();
  media.set(id, { id, buffer, mimeType, filename: basename(filePath), expiresAt: Date.now() + MEDIA_TTL_MS });
  return { mediaId: id, filename: basename(filePath), mimeType, size: buffer.length };
}

async function writeExport(filePath, data, overwrite) {
  const buffer = Buffer.from(data, "base64");
  const handle = await open(filePath, overwrite ? "w" : "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") throw new Error(`Export already exists: ${filePath}. Set overwrite=true only when intended.`);
    throw error;
  });
  try { await handle.writeFile(buffer); } finally { await handle.close(); }
  return { path: filePath, bytes: buffer.length };
}

async function handleInternalCall(body) {
  const client = clients.get(body.clientId);
  if (!client) throw new Error("MCP client session is not registered.");
  client.lastSeen = Date.now();
  if (body.action === "list_editors") {
    const connected = activeEditors();
    const selectedEditorId = connected.find((editor) => editor.id === client.selectedEditorId)?.id
      || connected.find((editor) => editor.id === focusedEditorId)?.id
      || (connected.length === 1 ? connected[0].id : null);
    return {
      selectedEditorId,
      editors: connected.map((editor) => ({ id: editor.id, selected: editor.id === selectedEditorId, focused: editor.id === focusedEditorId, pageUrl: editor.pageUrl, state: editor.state })),
    };
  }
  if (body.action === "select_editor") {
    const editor = activeEditors().find((item) => item.id === body.editorId);
    if (!editor) throw new Error(`Editor is not connected: ${body.editorId}`);
    client.selectedEditorId = editor.id;
    return { editorId: editor.id, pageUrl: editor.pageUrl, state: editor.state };
  }
  if (body.action === "prepare_media") return prepareMedia(body.path);
  if (body.action === "write_export") return writeExport(body.path, body.data, Boolean(body.overwrite));
  if (body.action === "notify") {
    const editor = selectEditor(body.clientId);
    queueEditorEvent(editor, { kind: "system", type: "notification", message: body.message, tone: body.tone, agent: publicClient(client) });
    return { shown: true, editorId: editor.id };
  }
  if (body.action === "browser") return callBrowser(body.clientId, body.toolName, body.operation, body.label);
  if (body.action === "batch") {
    const results = [];
    for (const item of body.items) results.push(await callBrowser(body.clientId, "apply_operations", item.operation, item.label));
    return { applied: results.length, results };
  }
  throw new Error(`Unknown internal action: ${body.action}`);
}

const server = createServer(async (request, response) => {
  const host = request.headers.host || "";
  if (![`${BRIDGE_HOST}:${BRIDGE_PORT}`, `localhost:${BRIDGE_PORT}`].includes(host)) return sendJson(response, 421, { error: "Invalid Host header." });
  const url = new URL(request.url || "/", BRIDGE_URL);
  const origin = request.headers.origin;
  const cors = browserCors(origin);

  if (request.method === "OPTIONS") {
    if (!cors) return sendJson(response, 403, { error: "Origin not allowed." });
    response.writeHead(204, cors);
    response.end();
    return;
  }
  if (url.pathname === "/health" && request.method === "GET") {
    if (origin && !cors) return sendJson(response, 403, { error: "Origin not allowed." });
    return sendJson(response, 200, { ok: true, service: PACKAGE_NAME, version: PACKAGE_VERSION, protocolVersion: PROTOCOL_VERSION, editors: activeEditors().length, agents: activeClients().length }, cors || {});
  }

  try {
    if (url.pathname.startsWith("/internal/")) {
      if (!requireInternal(request, response)) return;
      if (url.pathname === "/internal/health" && request.method === "GET") return sendJson(response, 200, { ok: true, pid: process.pid, version: PACKAGE_VERSION, protocolVersion: PROTOCOL_VERSION });
      if (url.pathname === "/internal/shutdown" && request.method === "POST") {
        sendJson(response, 202, { ok: true, pid: process.pid });
        setImmediate(() => void shutdown());
        return;
      }
      const body = await readJson(request);
      if (url.pathname === "/internal/client/connect" && request.method === "POST") {
        const existing = clients.get(body.clientId) || { id: body.clientId };
        Object.assign(existing, { name: body.name || existing.name || "MCP agent", version: body.version || existing.version || null, lastSeen: Date.now() });
        clients.set(existing.id, existing);
        broadcastAgents();
        return sendJson(response, 200, { ok: true, client: publicClient(existing) });
      }
      if (url.pathname === "/internal/client/disconnect" && request.method === "POST") {
        clients.delete(body.clientId);
        broadcastAgents();
        return sendJson(response, 200, { ok: true });
      }
      if (url.pathname === "/internal/client/heartbeat" && request.method === "POST") {
        const client = clients.get(body.clientId);
        if (client) client.lastSeen = Date.now();
        return sendJson(response, 200, { ok: Boolean(client) });
      }
      if (url.pathname === "/internal/call" && request.method === "POST") return sendJson(response, 200, { ok: true, result: await handleInternalCall(body) });
      return sendJson(response, 404, { error: "Internal endpoint not found." });
    }

    if (!cors) return sendJson(response, 403, { error: "Origin not allowed." });
    if (url.pathname === "/connect" && request.method === "POST") {
      const body = await readJson(request);
      if (!body.editorId || typeof body.editorId !== "string") return sendJson(response, 400, { error: "editorId is required." }, cors);
      if (body.protocolVersion !== PROTOCOL_VERSION) return sendJson(response, 409, { error: `Protocol mismatch. Browser=${body.protocolVersion}; companion=${PROTOCOL_VERSION}.`, protocolVersion: PROTOCOL_VERSION }, cors);
      const previous = editors.get(body.editorId);
      if (previous?.poll) endEditorPoll(previous);
      const editor = {
        id: body.editorId, queue: previous?.queue || [], poll: null, pageUrl: body.pageUrl,
        pollTimer: null, state: body.state, lastSeen: Date.now(), cors, sessionToken: randomBytes(32).toString("base64url"),
      };
      editors.set(editor.id, editor);
      if (body.hasFocus && body.visibilityState === "visible") focusedEditorId = editor.id;
      log(`Editor connected (${editor.id.slice(0, 8)})`);
      return sendJson(response, 200, { ok: true, editorId: editor.id, sessionToken: editor.sessionToken, protocolVersion: PROTOCOL_VERSION, version: PACKAGE_VERSION, agents: activeClients().map(publicClient) }, cors);
    }
    if (url.pathname === "/activate" && request.method === "POST") {
      const body = await readJson(request);
      const editor = requireEditor(request, response, body.editorId, cors);
      if (!editor) return;
      focusedEditorId = editor.id;
      return sendJson(response, 200, { ok: true, editorId: editor.id }, cors);
    }
    if (url.pathname === "/disconnect" && request.method === "POST") {
      const body = await readJson(request);
      const editor = requireEditor(request, response, body.editorId, cors);
      if (!editor) return;
      disconnectEditor(editor.id);
      return sendJson(response, 200, { ok: true, editorId: editor.id }, cors);
    }
    if (url.pathname === "/events" && request.method === "GET") {
      const editor = requireEditor(request, response, url.searchParams.get("editorId"), cors);
      if (!editor) return;
      editor.cors = cors;
      if (editor.poll) endEditorPoll(editor);
      editor.poll = response;
      response.once("close", () => {
        if (editor.poll !== response) return;
        editor.poll = null;
        clearTimeout(editor.pollTimer);
        editor.pollTimer = null;
        editor.lastSeen = Date.now();
      });
      deliverNext(editor);
      if (editor.poll) editor.pollTimer = setTimeout(() => {
        if (editor.poll !== response) return;
        endEditorPoll(editor);
      }, EVENT_POLL_TIMEOUT_MS);
      editor.pollTimer?.unref();
      return;
    }
    if (url.pathname === "/result" && request.method === "POST") {
      const body = await readJson(request);
      const editor = requireEditor(request, response, body.editorId, cors);
      if (!editor) return;
      const pending = inflight.get(body.requestId);
      if (!pending || pending.editorId !== editor.id) return sendJson(response, 404, { error: "Unknown request." }, cors);
      inflight.delete(body.requestId);
      clearTimeout(pending.timer);
      if (body.ok) {
        if (body.result?.project || body.result?.projects) editor.state = body.result;
        pending.resolve(body.result);
      } else pending.reject(new Error(body.error || "Browser operation failed."));
      return sendJson(response, 200, { ok: true }, cors);
    }
    if (url.pathname.startsWith("/media/") && request.method === "GET") {
      const editor = requireEditor(request, response, url.searchParams.get("editorId"), cors);
      if (!editor) return;
      const id = decodeURIComponent(url.pathname.slice("/media/".length));
      const item = media.get(id);
      if (!item || item.expiresAt < Date.now()) return sendJson(response, 404, { error: "Local image transfer expired." }, cors);
      media.delete(id);
      response.writeHead(200, { ...cors, "Content-Type": item.mimeType, "Content-Length": item.buffer.length, "X-Slide-Studio-Filename": encodeURIComponent(item.filename) });
      response.end(item.buffer);
      return;
    }
    return sendJson(response, 404, { error: "Not found." }, cors);
  } catch (error) {
    const headers = cors || {};
    const statusCode = error.code === "ENOENT" ? 404 : error.code === "EACCES" ? 403 : 400;
    return sendJson(response, statusCode, { error: error.message }, headers);
  }
});

async function acquireDaemonLock() {
  await mkdir(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  try {
    lockHandle = await open(DAEMON_LOCK_PATH, "wx", 0o600);
    await lockHandle.writeFile(String(process.pid));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      const lockPid = Number(await readFile(DAEMON_LOCK_PATH, "utf8"));
      if (!Number.isInteger(lockPid) || lockPid <= 0) throw Object.assign(new Error("Invalid daemon lock."), { code: "ESTALE" });
      process.kill(lockPid, 0);
      const running = new Error(`Slide Studio daemon is already running or starting (pid ${lockPid}).`);
      running.code = "EALREADY";
      throw running;
    } catch (checkError) {
      if (checkError.code === "EALREADY") throw checkError;
      if (!["ESRCH", "ENOENT", "ESTALE"].includes(checkError.code)) throw checkError;
      await unlink(DAEMON_LOCK_PATH).catch(() => {});
      lockHandle = await open(DAEMON_LOCK_PATH, "wx", 0o600);
      await lockHandle.writeFile(String(process.pid));
    }
  }
}

async function writeDaemonState() {
  const temporary = `${DAEMON_STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ pid: process.pid, port: BRIDGE_PORT, secret: daemonSecret, version: PACKAGE_VERSION, protocolVersion: PROTOCOL_VERSION }), { mode: 0o600 });
  await rename(temporary, DAEMON_STATE_PATH);
}

async function cleanup() {
  for (const editor of editors.values()) endEditorPoll(editor);
  for (const pending of inflight.values()) { clearTimeout(pending.timer); pending.reject(new Error("Local companion is shutting down.")); }
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  const state = await readFile(DAEMON_STATE_PATH, "utf8").then(JSON.parse).catch(() => null);
  if (state?.pid === process.pid) await unlink(DAEMON_STATE_PATH).catch(() => {});
  await lockHandle?.close().catch(() => {});
  await unlink(DAEMON_LOCK_PATH).catch(() => {});
}

setInterval(() => {
  const now = Date.now();
  for (const [id, item] of media) if (item.expiresAt < now) media.delete(id);
  let clientsChanged = false;
  for (const [id, client] of clients) if (client.lastSeen < now - CLIENT_TTL_MS) { clients.delete(id); clientsChanged = true; }
  for (const [id, editor] of editors) {
    if (editor.lastSeen >= now - EDITOR_TTL_MS || (editor.poll && !editor.poll.destroyed && !editor.poll.writableEnded)) continue;
    disconnectEditor(id, "Browser editor connection expired.");
  }
  if (clientsChanged) broadcastAgents();
  if (activeClients().length || activeEditors().length) idleSince = null;
  else if (!idleSince) idleSince = now;
  else if (now - idleSince > 10 * 60_000) void shutdown();
}, 15_000).unref();

async function main() {
  await acquireDaemonLock();
  server.on("error", (error) => { log(`Bridge failed: ${error.message}`); process.exitCode = 1; });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(BRIDGE_PORT, BRIDGE_HOST, resolve);
  });
  await writeDaemonState();
  log(`Listening on ${BRIDGE_URL}`);
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await cleanup().catch((error) => log(`Cleanup failed: ${error.message}`));
  process.exit();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

main().catch(async (error) => {
  log(error.message);
  await lockHandle?.close().catch(() => {});
  process.exit(1);
});
