#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, delimiter, extname } from "node:path";
import {
  ALLOWED_ORIGINS, AUDIT_LOG_PATH, BRIDGE_HOST, BRIDGE_PORT, BRIDGE_URL, DAEMON_LOCK_PATH,
  DAEMON_API_VERSION, DAEMON_INTERNAL_ACTIONS, DAEMON_STATE_PATH, PACKAGE_NAME, PACKAGE_VERSION,
  PROTOCOL_VERSION, STATE_DIRECTORY,
} from "./config.mjs";
import { createLocalFontService } from "./local-fonts.mjs";

const MAX_JSON_BYTES = 40 * 1024 * 1024;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const EDITOR_TTL_MS = Number(process.env.CAROUSELBOT_EDITOR_TTL_MS || process.env.SLIDE_STUDIO_EDITOR_TTL_MS) || 60_000;
const CLIENT_TTL_MS = 45_000;
const MEDIA_TTL_MS = 5 * 60_000;
const FONT_MEDIA_TTL_MS = 5 * 60_000;
const MAX_FONT_MEDIA_ITEMS = 32;
const MAX_FONT_MEDIA_BYTES = 256 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 90_000;
const EDIT_SESSION_TTL_MS = Number(process.env.CAROUSELBOT_EDIT_SESSION_TTL_MS || process.env.SLIDE_STUDIO_EDIT_SESSION_TTL_MS) || 5 * 60_000;
const MAX_AUDIT_EVENTS = 500;
const MAX_AUDIT_BYTES = 2 * 1024 * 1024;
const EVENT_POLL_TIMEOUT_MS = Number(process.env.CAROUSELBOT_EVENT_POLL_TIMEOUT_MS || process.env.SLIDE_STUDIO_EVENT_POLL_TIMEOUT_MS) || 500;
const MAX_EVENT_POLL_TIMEOUT_MS = 5_000;
const daemonSecret = randomBytes(32).toString("base64url");
const editors = new Map();
const clients = new Map();
const inflight = new Map();
const media = new Map();
const fontMedia = new Map();
const editSessions = new Map();
const auditEvents = [];
const configuredFontDirectories = String(process.env.CAROUSELBOT_FONT_DIRS || process.env.SLIDE_STUDIO_FONT_DIRS || "")
  .split(delimiter)
  .map((value) => value.trim())
  .filter(Boolean);
const localFonts = createLocalFontService({
  cacheDirectory: STATE_DIRECTORY,
  ...(configuredFontDirectories.length ? { directories: configuredFontDirectories } : {}),
});
let focusedEditorId = null;
let lockHandle = null;
let idleSince = null;
let auditWrite = Promise.resolve();

function log(message) {
  process.stderr.write(`[carouselbot-daemon] ${message}\n`);
}

function editorHasInflightCommand(editorId) {
  for (const pending of inflight.values()) if (pending.editorId === editorId) return true;
  return false;
}

function activeEditors() {
  const cutoff = Date.now() - EDITOR_TTL_MS;
  return [...editors.values()].filter((editor) => (
    editor.lastSeen >= cutoff
    || Boolean(editor.poll && !editor.poll.destroyed && !editor.poll.writableEnded)
    || editorHasInflightCommand(editor.id)
  ));
}

function activeClients() {
  const cutoff = Date.now() - CLIENT_TTL_MS;
  return [...clients.values()].filter((client) => client.lastSeen >= cutoff);
}

function publicClient(client) {
  return { id: client.id, name: client.name || "MCP agent", version: client.version || null };
}

function codedError(code, message, details = {}) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  error.details = details;
  return error;
}

function daemonHealth(details = {}) {
  return {
    ok: true,
    service: PACKAGE_NAME,
    pid: process.pid,
    version: PACKAGE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    daemonApiVersion: DAEMON_API_VERSION,
    capabilities: { internalActions: [...DAEMON_INTERNAL_ACTIONS] },
    ...details,
  };
}

function publicSession(session) {
  return {
    id: session.id,
    editSessionId: session.id,
    editorId: session.editorId,
    projectId: session.projectId || null,
    purpose: session.purpose,
    owner: session.owner,
    createdAt: session.createdAt,
    leaseExpiresAt: session.lastSeen + EDIT_SESSION_TTL_MS,
  };
}

function broadcastEditSessions() {
  const event = { kind: "system", type: "edit-sessions.changed", editSessions: activeEditSessions().map(publicSession) };
  for (const editor of activeEditors()) queueEditorEvent(editor, event);
}

function activeEditSessions() {
  const cutoff = Date.now() - EDIT_SESSION_TTL_MS;
  const activeEditorIds = new Set(activeEditors().map((editor) => editor.id));
  return [...editSessions.values()].filter((session) => session.lastSeen >= cutoff && activeEditorIds.has(session.editorId));
}

function releaseEditSession(sessionId, reason = "released") {
  const session = editSessions.get(sessionId);
  if (!session) return null;
  editSessions.delete(sessionId);
  for (const client of clients.values()) if (client.implicitSessionId === sessionId) client.implicitSessionId = null;
  recordAudit({ action: "edit_session.end", status: "ok", session, message: reason });
  broadcastEditSessions();
  return session;
}

function recordAudit({ action, status = "ok", client = null, session = null, editorId = null, projectId = null, toolName = null, revision = null, message = null }) {
  const event = {
    id: randomUUID(), at: new Date().toISOString(), action, status,
    ...(client ? { client: publicClient(client) } : {}),
    ...(session ? { editSessionId: session.id, owner: session.owner } : {}),
    ...(editorId || session?.editorId ? { editorId: editorId || session.editorId } : {}),
    ...(projectId || session?.projectId ? { projectId: projectId || session.projectId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(revision != null ? { revision } : {}),
    ...(message ? { message: String(message).slice(0, 300) } : {}),
  };
  auditEvents.push(event);
  if (auditEvents.length > MAX_AUDIT_EVENTS) auditEvents.splice(0, auditEvents.length - MAX_AUDIT_EVENTS);
  auditWrite = auditWrite.then(() => appendFile(AUDIT_LOG_PATH, `${JSON.stringify(event)}\n`, { mode: 0o600 })).catch((error) => log(`Could not write operation audit: ${error.message}`));
  return event;
}

function sessionForEditor(editorId) {
  return activeEditSessions().find((session) => session.editorId === editorId) || null;
}

function sessionForProject(projectId) {
  return projectId ? activeEditSessions().find((session) => session.projectId === projectId) || null : null;
}

function requireEditSession(sessionId) {
  const session = editSessions.get(sessionId);
  if (!session || session.lastSeen < Date.now() - EDIT_SESSION_TTL_MS) {
    if (session) releaseEditSession(session.id, "lease expired");
    throw codedError("EDIT_SESSION_EXPIRED", "The edit session is missing or expired. Begin a new edit session and retry.");
  }
  if (!activeEditors().some((editor) => editor.id === session.editorId)) {
    releaseEditSession(session.id, "editor disconnected");
    throw codedError("EDITOR_DISCONNECTED", "The browser tab assigned to this edit session is no longer connected.");
  }
  session.lastSeen = Date.now();
  return session;
}

function claimProject(session, projectId) {
  if (!projectId) return;
  const conflict = sessionForProject(projectId);
  if (conflict && conflict.id !== session.id) {
    recordAudit({ action: "edit_session.conflict", status: "blocked", session, projectId, message: `Project held by ${conflict.owner.name}` });
    throw codedError("PROJECT_BUSY", `Project ${projectId} is being edited by ${conflict.owner.name} (${conflict.purpose}). Use a different project or wait for edit session ${conflict.id} to end.`, { session: publicSession(conflict) });
  }
  if (session.projectId && session.projectId !== projectId) {
    if (session.implicit) {
      session.projectId = projectId;
      return;
    }
    throw codedError("SESSION_PROJECT_MISMATCH", `This edit session is assigned to project ${session.projectId}. End it and begin another session for ${projectId}.`);
  }
  session.projectId = projectId;
}

function beginEditSession(client, { editorId, projectId, purpose }) {
  const connected = activeEditors();
  if (!connected.length) throw codedError("NO_EDITOR", "No CarouselBot editor is connected. Open the editor in the user's normal browser and click Connect AI.");
  let editor = editorId ? connected.find((item) => item.id === editorId) : null;
  if (editorId && !editor) throw codedError("EDITOR_DISCONNECTED", `Editor is not connected: ${editorId}`);
  if (!editor) {
    const selected = client.selectedEditorId && connected.find((item) => item.id === client.selectedEditorId);
    const available = connected.filter((item) => !sessionForEditor(item.id));
    editor = selected && !sessionForEditor(selected.id) ? selected : available.length === 1 ? available[0] : null;
    if (!editor) throw codedError("EDITOR_SELECTION_REQUIRED", "Multiple browser tabs are available. Call list_editors, choose an unassigned editor, then begin_edit_session with editorId.");
  }
  const editorConflict = sessionForEditor(editor.id);
  if (editorConflict) throw codedError("EDITOR_BUSY", `Editor ${editor.id} is assigned to ${editorConflict.owner.name} (${editorConflict.purpose}) until ${new Date(editorConflict.lastSeen + EDIT_SESSION_TTL_MS).toISOString()}.`, { session: publicSession(editorConflict) });
  const projectConflict = sessionForProject(projectId);
  if (projectConflict) throw codedError("PROJECT_BUSY", `Project ${projectId} is being edited by ${projectConflict.owner.name} (${projectConflict.purpose}).`, { session: publicSession(projectConflict) });
  const now = Date.now();
  const session = {
    id: randomUUID(), editorId: editor.id, projectId: projectId || null,
    purpose: String(purpose || "Edit CarouselBot").slice(0, 160), owner: publicClient(client),
    creatorClientId: client.id, lastClientId: client.id, implicit: false, createdAt: now, lastSeen: now,
  };
  editSessions.set(session.id, session);
  client.selectedEditorId = editor.id;
  recordAudit({ action: "edit_session.begin", client, session });
  broadcastEditSessions();
  return session;
}

function browserCors(origin) {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Expose-Headers": "X-CarouselBot-Filename, X-Slide-Studio-Filename, X-CarouselBot-Local-Font-Id",
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

function sendLocalFont(response, item, headers = {}) {
  response.writeHead(200, {
    ...headers,
    "Content-Type": item.mimeType,
    "Content-Length": item.buffer.length,
    "X-CarouselBot-Filename": encodeURIComponent(item.filename),
    "X-Slide-Studio-Filename": encodeURIComponent(item.filename),
    "X-CarouselBot-Local-Font-Id": encodeURIComponent(item.font.localFontId),
  });
  response.end(item.buffer);
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
  for (const session of editSessions.values()) if (session.editorId === editorId) releaseEditSession(session.id, "editor disconnected");
  editors.delete(editorId);
  for (const [id, item] of fontMedia) if (item.editorId === editorId) fontMedia.delete(id);
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
  if (!connected.length) throw new Error("No CarouselBot editor is connected. Open the editor and click Connect AI.");
  throw new Error("Multiple editors are connected and none is selected. Call list_editors, then select_editor.");
}

function requireLocalFontPermission(editor) {
  if (editor?.localFontsEnabled) return editor;
  throw codedError("FONT_PERMISSION_REQUIRED", "Open CarouselBot and enable local fonts.");
}

function selectLocalFontEditor(clientId) {
  return requireLocalFontPermission(selectEditor(clientId));
}

function localFontEditorForCall(clientId, editSessionId) {
  if (!editSessionId) return selectLocalFontEditor(clientId);
  const session = requireEditSession(editSessionId);
  session.lastClientId = clientId;
  return requireLocalFontPermission(editors.get(session.editorId));
}

function resolveBrowserTarget(clientId, { editSessionId, mutating, projectId }) {
  const client = clients.get(clientId) || { id: clientId, name: "MCP agent" };
  if (editSessionId) {
    const session = requireEditSession(editSessionId);
    session.lastClientId = clientId;
    if (mutating) claimProject(session, projectId);
    return { client, editor: editors.get(session.editorId), session };
  }
  if (!mutating) return { client, editor: selectEditor(clientId), session: null };
  let session = client.implicitSessionId && editSessions.get(client.implicitSessionId);
  if (session) {
    session = requireEditSession(session.id);
    claimProject(session, projectId);
    return { client, editor: editors.get(session.editorId), session };
  }
  const editor = selectEditor(clientId);
  const conflict = sessionForEditor(editor.id);
  if (conflict) throw codedError("EDITOR_BUSY", `Editor ${editor.id} is assigned to ${conflict.owner.name} (${conflict.purpose}). Begin an edit session on another editor.`, { session: publicSession(conflict) });
  const now = Date.now();
  session = {
    id: randomUUID(), editorId: editor.id, projectId: null, purpose: "Implicit single-agent edit",
    owner: publicClient(client), creatorClientId: client.id, lastClientId: client.id,
    implicit: true, createdAt: now, lastSeen: now,
  };
  claimProject(session, projectId);
  editSessions.set(session.id, session);
  client.implicitSessionId = session.id;
  recordAudit({ action: "edit_session.begin", client, session, message: "implicit" });
  broadcastEditSessions();
  return { client, editor, session };
}

function callBrowser(clientId, toolName, operation, label, { editSessionId = null, mutating = false } = {}) {
  const projectId = operation?.projectId || null;
  const { client, editor, session } = resolveBrowserTarget(clientId, { editSessionId, mutating, projectId });
  if (mutating && session && !session.implicit && !session.projectId && toolName !== "create_project") {
    throw codedError("PROJECT_ID_REQUIRED", "This edit session is not bound to a project yet. Pass projectId, or create a project first so the daemon can bind it atomically.");
  }
  const requestId = randomUUID();
  recordAudit({ action: "tool.call", client, session, editorId: editor.id, projectId, toolName, status: "started" });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(requestId);
      if (operation?.fontMediaId) fontMedia.delete(operation.fontMediaId);
      recordAudit({ action: "tool.result", client, session, editorId: editor.id, projectId, toolName, status: "error", message: "Browser timeout" });
      reject(codedError("BROWSER_TIMEOUT", "The browser did not answer within 90 seconds."));
    }, COMMAND_TIMEOUT_MS);
    inflight.set(requestId, {
      resolve,
      reject,
      timer,
      editorId: editor.id,
      client,
      session,
      projectId,
      toolName,
      fontMediaId: operation?.fontMediaId || null,
    });
    queueEditorEvent(editor, { kind: "command", requestId, toolName, operation, label, editSessionId: session?.id || null, agent: publicClient(client) });
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

function localFontFilename(font, mimeType) {
  const extension = ({
    "font/ttf": "ttf",
    "font/otf": "otf",
    "font/woff": "woff",
    "font/woff2": "woff2",
  })[mimeType] || "font";
  const stem = String(font?.postscriptName || font?.localFontId || "local-font")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "local-font";
  return `${stem}.${extension}`;
}

async function readLocalFontFace(localFontId) {
  if (!localFontId || typeof localFontId !== "string") throw codedError("FONT_NOT_FOUND", "A valid localFontId is required.");
  const prepared = await localFonts.readFace(localFontId);
  if (!prepared?.font || !prepared?.buffer) throw codedError("FONT_NOT_FOUND", `Local font is unavailable: ${localFontId}`);
  const buffer = Buffer.isBuffer(prepared.buffer) ? prepared.buffer : Buffer.from(prepared.buffer);
  const mimeType = prepared.mimeType || "application/octet-stream";
  return { font: prepared.font, buffer, mimeType, filename: localFontFilename(prepared.font, mimeType) };
}

async function prepareFont(clientId, localFontId, editSessionId) {
  const editor = localFontEditorForCall(clientId, editSessionId);
  const prepared = await readLocalFontFace(localFontId);
  const now = Date.now();
  let retainedBytes = 0;
  for (const [id, item] of fontMedia) {
    if (item.expiresAt < now) fontMedia.delete(id);
    else retainedBytes += item.buffer.length;
  }
  if (fontMedia.size >= MAX_FONT_MEDIA_ITEMS || retainedBytes + prepared.buffer.length > MAX_FONT_MEDIA_BYTES) {
    throw codedError("FONT_TRANSFER_LIMIT", "Too many local fonts are waiting to be transferred. Finish the pending imports and retry.");
  }
  const fontMediaId = randomUUID();
  fontMedia.set(fontMediaId, {
    ...prepared,
    id: fontMediaId,
    editorId: editor.id,
    localFontId: prepared.font.localFontId,
    expiresAt: now + FONT_MEDIA_TTL_MS,
  });
  return { font: prepared.font, fontMediaId };
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
    if (selectedEditorId) client.selectedEditorId = selectedEditorId;
    return {
      selectedEditorId,
      editors: connected.map((editor) => {
        const assigned = sessionForEditor(editor.id);
        return { id: editor.id, selected: editor.id === selectedEditorId, focused: editor.id === focusedEditorId, pageUrl: editor.pageUrl, state: editor.state, editSession: assigned ? publicSession(assigned) : null };
      }),
      editSessions: activeEditSessions().map(publicSession),
    };
  }
  if (body.action === "select_editor") {
    const editor = activeEditors().find((item) => item.id === body.editorId);
    if (!editor) throw new Error(`Editor is not connected: ${body.editorId}`);
    client.selectedEditorId = editor.id;
    return { editorId: editor.id, pageUrl: editor.pageUrl, state: editor.state };
  }
  if (body.action === "begin_edit_session") return publicSession(beginEditSession(client, body));
  if (body.action === "end_edit_session") {
    const session = editSessions.get(body.editSessionId);
    if (!session) return { released: false, editSessionId: body.editSessionId };
    releaseEditSession(session.id, "released by agent");
    return { released: true, editSessionId: session.id, editorId: session.editorId, projectId: session.projectId || null };
  }
  if (body.action === "list_edit_sessions") return { editSessions: activeEditSessions().map(publicSession) };
  if (body.action === "list_recent_operations") {
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 50));
    const events = auditEvents.filter((event) => (!body.projectId || event.projectId === body.projectId) && (!body.status || event.status === body.status));
    return { events: events.slice(-limit).reverse(), localLogPath: AUDIT_LOG_PATH };
  }
  if (body.action === "list_local_fonts") {
    localFontEditorForCall(body.clientId, body.editSessionId);
    return localFonts.list({ query: body.query, limit: body.limit, cursor: body.cursor, sort: body.sort });
  }
  if (body.action === "prepare_font") return prepareFont(body.clientId, body.localFontId, body.editSessionId);
  if (body.action === "prepare_media") return prepareMedia(body.path);
  if (body.action === "write_export") return writeExport(body.path, body.data, Boolean(body.overwrite));
  if (body.action === "notify") {
    const { editor } = resolveBrowserTarget(body.clientId, { editSessionId: body.editSessionId, mutating: false, projectId: null });
    queueEditorEvent(editor, { kind: "system", type: "notification", message: body.message, tone: body.tone, agent: publicClient(client) });
    return { shown: true, editorId: editor.id };
  }
  if (body.action === "browser") return callBrowser(body.clientId, body.toolName, body.operation, body.label, { editSessionId: body.editSessionId, mutating: Boolean(body.mutating) });
  if (body.action === "batch") {
    const results = [];
    for (const item of body.items) results.push(await callBrowser(body.clientId, item.toolName || "apply_operations", item.operation, item.label, { editSessionId: body.editSessionId, mutating: true }));
    return { applied: results.length, results };
  }
  throw codedError("UNSUPPORTED_INTERNAL_ACTION", `Unknown internal action: ${body.action}`, {
    action: body.action,
    supportedActions: [...DAEMON_INTERNAL_ACTIONS],
  });
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
    return sendJson(response, 200, daemonHealth({ editors: activeEditors().length, agents: activeClients().length }), cors || {});
  }

  try {
    if (url.pathname.startsWith("/internal/")) {
      if (!requireInternal(request, response)) return;
      if (url.pathname === "/internal/health" && request.method === "GET") return sendJson(response, 200, daemonHealth());
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
        const departing = clients.get(body.clientId);
        if (departing?.implicitSessionId) releaseEditSession(departing.implicitSessionId, "implicit client disconnected");
        clients.delete(body.clientId);
        broadcastAgents();
        return sendJson(response, 200, { ok: true });
      }
      if (url.pathname === "/internal/client/heartbeat" && request.method === "POST") {
        const client = clients.get(body.clientId);
        if (client) {
          client.lastSeen = Date.now();
          const session = client.implicitSessionId && editSessions.get(client.implicitSessionId);
          if (session) session.lastSeen = Date.now();
        }
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
      if (previous) {
        endEditorPoll(previous);
        for (const [requestId, pending] of inflight) {
          if (pending.editorId !== body.editorId) continue;
          inflight.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(codedError("EDITOR_RELOADED", "The assigned browser tab reloaded during this operation. Inspect the editor and retry."));
        }
      }
      const editor = {
        id: body.editorId, queue: [], poll: null, pageUrl: body.pageUrl,
        pollTimer: null, state: body.state, lastSeen: Date.now(), cors,
        localFontsEnabled: body.localFontsEnabled === true,
        sessionToken: randomBytes(32).toString("base64url"),
      };
      editors.set(editor.id, editor);
      if (body.hasFocus && body.visibilityState === "visible") focusedEditorId = editor.id;
      log(`Editor connected (${editor.id.slice(0, 8)})`);
      return sendJson(response, 200, { ok: true, editorId: editor.id, sessionToken: editor.sessionToken, protocolVersion: PROTOCOL_VERSION, version: PACKAGE_VERSION, localFontsEnabled: editor.localFontsEnabled, agents: activeClients().map(publicClient), editSessions: activeEditSessions().map(publicSession) }, cors);
    }
    if (url.pathname === "/activate" && request.method === "POST") {
      const body = await readJson(request);
      const editor = requireEditor(request, response, body.editorId, cors);
      if (!editor) return;
      focusedEditorId = editor.id;
      return sendJson(response, 200, { ok: true, editorId: editor.id }, cors);
    }
    if (url.pathname === "/heartbeat" && request.method === "POST") {
      const body = await readJson(request);
      const editor = requireEditor(request, response, body.editorId, cors);
      if (!editor) return;
      return sendJson(response, 200, { ok: true, editorId: editor.id }, cors);
    }
    if (url.pathname === "/disconnect" && request.method === "POST") {
      const body = await readJson(request);
      const editor = requireEditor(request, response, body.editorId, cors);
      if (!editor) return;
      disconnectEditor(editor.id);
      return sendJson(response, 200, { ok: true, editorId: editor.id }, cors);
    }
    if (url.pathname === "/fonts/enable" && request.method === "POST") {
      const body = await readJson(request);
      const editor = requireEditor(request, response, body.editorId, cors);
      if (!editor) return;
      editor.localFontsEnabled = true;
      return sendJson(response, 200, { enabled: true }, cors);
    }
    if (url.pathname === "/fonts" && request.method === "GET") {
      const editor = requireEditor(request, response, url.searchParams.get("editorId"), cors);
      if (!editor) return;
      requireLocalFontPermission(editor);
      const result = await localFonts.list({
        query: url.searchParams.get("query") || "",
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
        cursor: url.searchParams.get("cursor") || null,
        sort: url.searchParams.get("sort") || undefined,
      });
      return sendJson(response, 200, result, cors);
    }
    if (url.pathname === "/fonts/use" && request.method === "POST") {
      const body = await readJson(request);
      const editor = requireEditor(request, response, body.editorId, cors);
      if (!editor) return;
      requireLocalFontPermission(editor);
      const font = await localFonts.markUsed(body.localFontId);
      if (!font) throw codedError("FONT_NOT_FOUND", `Local font is unavailable: ${body.localFontId}`);
      return sendJson(response, 200, { font }, cors);
    }
    if (url.pathname.startsWith("/fonts/") && request.method === "GET") {
      const editor = requireEditor(request, response, url.searchParams.get("editorId"), cors);
      if (!editor) return;
      requireLocalFontPermission(editor);
      const localFontId = decodeURIComponent(url.pathname.slice("/fonts/".length));
      return sendLocalFont(response, await readLocalFontFace(localFontId), cors);
    }
    if (url.pathname.startsWith("/font-media/") && request.method === "GET") {
      const editor = requireEditor(request, response, url.searchParams.get("editorId"), cors);
      if (!editor) return;
      requireLocalFontPermission(editor);
      const id = decodeURIComponent(url.pathname.slice("/font-media/".length));
      const item = fontMedia.get(id);
      if (!item || item.expiresAt < Date.now()) {
        fontMedia.delete(id);
        throw codedError("FONT_MEDIA_UNAVAILABLE", "Local font transfer is missing or expired.");
      }
      if (item.editorId !== editor.id) throw codedError("FONT_MEDIA_UNAVAILABLE", "Local font transfer is missing or expired.");
      fontMedia.delete(id);
      return sendLocalFont(response, item, cors);
    }
    if (url.pathname === "/events" && request.method === "GET") {
      const editor = requireEditor(request, response, url.searchParams.get("editorId"), cors);
      if (!editor) return;
      const requestedWait = Number(url.searchParams.get("wait"));
      const waitMs = url.searchParams.has("wait") && Number.isFinite(requestedWait)
        ? Math.min(MAX_EVENT_POLL_TIMEOUT_MS, Math.max(0, requestedWait))
        : EVENT_POLL_TIMEOUT_MS;
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
      if (editor.poll && waitMs === 0) {
        endEditorPoll(editor);
      } else if (editor.poll) editor.pollTimer = setTimeout(() => {
        if (editor.poll !== response) return;
        endEditorPoll(editor);
      }, waitMs);
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
      if (pending.fontMediaId) fontMedia.delete(pending.fontMediaId);
      if (body.state) editor.state = body.state;
      if (body.ok) {
        try {
          if (pending.session && body.result?.projectId) claimProject(pending.session, body.result.projectId);
        } catch (error) {
          recordAudit({ action: "tool.result", client: pending.client, session: pending.session, editorId: editor.id, projectId: body.result?.projectId, toolName: pending.toolName, status: "error", message: error.message });
          pending.reject(error);
          return sendJson(response, 200, { ok: true, accepted: false }, cors);
        }
        if (pending.session) pending.session.lastSeen = Date.now();
        recordAudit({ action: "tool.result", client: pending.client, session: pending.session, editorId: editor.id, projectId: body.result?.projectId || pending.projectId, toolName: pending.toolName, status: "ok", revision: body.result?.revision });
        pending.resolve(body.result);
      } else {
        recordAudit({ action: "tool.result", client: pending.client, session: pending.session, editorId: editor.id, projectId: pending.projectId, toolName: pending.toolName, status: "error", message: body.error || "Browser operation failed" });
        pending.reject(new Error(body.error || "Browser operation failed."));
      }
      return sendJson(response, 200, { ok: true }, cors);
    }
    if (url.pathname.startsWith("/media/") && request.method === "GET") {
      const editor = requireEditor(request, response, url.searchParams.get("editorId"), cors);
      if (!editor) return;
      const id = decodeURIComponent(url.pathname.slice("/media/".length));
      const item = media.get(id);
      if (!item || item.expiresAt < Date.now()) return sendJson(response, 404, { error: "Local image transfer expired." }, cors);
      media.delete(id);
      response.writeHead(200, { ...cors, "Content-Type": item.mimeType, "Content-Length": item.buffer.length, "X-CarouselBot-Filename": encodeURIComponent(item.filename), "X-Slide-Studio-Filename": encodeURIComponent(item.filename) });
      response.end(item.buffer);
      return;
    }
    return sendJson(response, 404, { error: "Not found." }, cors);
  } catch (error) {
    const headers = cors || {};
    const statusCode = ["ENOENT", "FONT_NOT_FOUND", "FONT_MEDIA_UNAVAILABLE"].includes(error.code)
      ? 404
      : ["EACCES", "FONT_PERMISSION_REQUIRED"].includes(error.code)
        ? 403
        : error.code === "FONT_TRANSFER_LIMIT" ? 429 : 400;
    return sendJson(response, statusCode, {
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details && Object.keys(error.details).length ? { details: error.details } : {}),
    }, headers);
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
      const running = new Error(`CarouselBot daemon is already running or starting (pid ${lockPid}).`);
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
  await writeFile(temporary, JSON.stringify({
    pid: process.pid,
    port: BRIDGE_PORT,
    secret: daemonSecret,
    version: PACKAGE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    daemonApiVersion: DAEMON_API_VERSION,
  }), { mode: 0o600 });
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
  for (const [id, item] of fontMedia) if (item.expiresAt < now) fontMedia.delete(id);
  for (const session of editSessions.values()) if (session.lastSeen < now - EDIT_SESSION_TTL_MS) releaseEditSession(session.id, "lease expired");
  let clientsChanged = false;
  for (const [id, client] of clients) if (client.lastSeen < now - CLIENT_TTL_MS) {
    if (client.implicitSessionId) releaseEditSession(client.implicitSessionId, "implicit client expired");
    clients.delete(id);
    clientsChanged = true;
  }
  for (const [id, editor] of editors) {
    if (
      editor.lastSeen >= now - EDITOR_TTL_MS
      || (editor.poll && !editor.poll.destroyed && !editor.poll.writableEnded)
      || editorHasInflightCommand(id)
    ) continue;
    disconnectEditor(id, "Browser editor connection expired.");
  }
  if (clientsChanged) broadcastAgents();
  if (activeClients().length || activeEditors().length) idleSince = null;
  else if (!idleSince) idleSince = now;
  else if (now - idleSince > 10 * 60_000) void shutdown();
}, 15_000).unref();

async function main() {
  await acquireDaemonLock();
  const previousAudit = await readFile(AUDIT_LOG_PATH, "utf8").catch(() => "");
  for (const line of previousAudit.trim().split("\n").slice(-MAX_AUDIT_EVENTS)) {
    try { auditEvents.push(JSON.parse(line)); } catch { /* Ignore an interrupted final line. */ }
  }
  const auditMetadata = await stat(AUDIT_LOG_PATH).catch(() => null);
  if (auditMetadata?.size > MAX_AUDIT_BYTES) await rename(AUDIT_LOG_PATH, `${AUDIT_LOG_PATH}.previous`).catch(() => {});
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
