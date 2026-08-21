#!/usr/bin/env node
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const host = "127.0.0.1";
const port = Number(process.env.SLIDE_STUDIO_BRIDGE_PORT) || 43117;
const allowedOrigins = new Set((process.env.SLIDE_STUDIO_ALLOWED_ORIGINS || [
  "https://slides-mcp-poc-0821.pages.dev",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
].join(",")).split(",").map((value) => value.trim()).filter(Boolean));
const editors = new Map();
const inflight = new Map();
let selectedEditorId = null;

function log(message) {
  process.stderr.write(`[slide-studio-mcp] ${message}\n`);
}

function corsHeaders(origin) {
  if (!origin || !allowedOrigins.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...headers });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

function activeEditors() {
  const cutoff = Date.now() - 45_000;
  return [...editors.values()].filter((editor) => editor.lastSeen >= cutoff);
}

function deliverNext(editor) {
  if (!editor?.poll || !editor.queue.length) return;
  const response = editor.poll;
  editor.poll = null;
  sendJson(response, 200, editor.queue.shift(), editor.cors);
}

const bridge = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  const origin = request.headers.origin;
  const cors = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    if (!cors) return sendJson(response, 403, { error: "Origin not allowed" });
    response.writeHead(204, cors);
    response.end();
    return;
  }
  if (url.pathname === "/health" && request.method === "GET") {
    return sendJson(response, 200, { ok: true, service: "slide-studio-local-mcp", editors: activeEditors().length }, cors || { "Cache-Control": "no-store" });
  }
  if (!cors) return sendJson(response, 403, { error: "Origin not allowed" });

  try {
    if (url.pathname === "/connect" && request.method === "POST") {
      const body = await readJson(request);
      if (!body.editorId || typeof body.editorId !== "string") return sendJson(response, 400, { error: "editorId is required" }, cors);
      const editor = editors.get(body.editorId) || { id: body.editorId, queue: [], poll: null };
      editor.pageUrl = body.pageUrl;
      editor.pageOrigin = body.pageOrigin;
      editor.state = body.state;
      editor.lastSeen = Date.now();
      editor.cors = cors;
      editors.set(editor.id, editor);
      log(`Browser editor connected from ${origin} (${editor.id.slice(0, 8)})`);
      return sendJson(response, 200, { ok: true, editorId: editor.id }, cors);
    }
    if (url.pathname === "/events" && request.method === "GET") {
      const editor = editors.get(url.searchParams.get("editorId"));
      if (!editor) return sendJson(response, 404, { error: "Unknown editor" }, cors);
      editor.lastSeen = Date.now();
      editor.cors = cors;
      if (editor.poll) {
        editor.poll.writeHead(204, editor.cors);
        editor.poll.end();
      }
      editor.poll = response;
      deliverNext(editor);
      if (editor.poll) {
        setTimeout(() => {
          if (editor.poll !== response) return;
          editor.poll = null;
          response.writeHead(204, cors);
          response.end();
        }, 20_000).unref();
      }
      return;
    }
    if (url.pathname === "/result" && request.method === "POST") {
      const body = await readJson(request);
      const pending = inflight.get(body.requestId);
      if (!pending) return sendJson(response, 404, { error: "Unknown request" }, cors);
      inflight.delete(body.requestId);
      clearTimeout(pending.timer);
      body.ok ? pending.resolve(body.result) : pending.reject(new Error(body.error || "Browser operation failed"));
      return sendJson(response, 200, { ok: true }, cors);
    }
    return sendJson(response, 404, { error: "Not found" }, cors);
  } catch (error) {
    return sendJson(response, 400, { error: error.message }, cors);
  }
});

bridge.on("error", (error) => {
  log(`Loopback bridge failed: ${error.message}`);
  process.exit(1);
});
bridge.listen(port, host, () => log(`Loopback bridge listening on http://${host}:${port}`));

async function waitForBrowser(timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const connected = activeEditors();
    const editor = selectedEditorId
      ? connected.find((candidate) => candidate.id === selectedEditorId)
      : connected.sort((a, b) => b.lastSeen - a.lastSeen)[0];
    if (editor) return editor;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

async function callBrowser(toolName, operation) {
  const editor = await waitForBrowser();
  if (!editor) throw new Error("No deployed Slide Studio tab is connected. Open the test Pages URL and allow local-network access.");
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(requestId);
      reject(new Error("The browser did not answer the tool call within 30 seconds."));
    }, 30_000);
    inflight.set(requestId, { resolve, reject, timer });
    editor.queue.push({ requestId, toolName, operation });
    deliverNext(editor);
  });
}

const tools = [
  {
    name: "list_editors",
    description: "List Slide Studio browser tabs currently connected to this local companion.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "select_editor",
    description: "Pin subsequent tool calls to one connected Slide Studio editor ID.",
    inputSchema: {
      type: "object",
      required: ["editorId"],
      properties: { editorId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_editor_state",
    description: "Read the active project and slide state from the connected Slide Studio browser tab.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_demo_slide",
    description: "Create and open a real Slide Studio project with one generated 9:16 demo slide.",
    inputSchema: {
      type: "object",
      properties: {
        projectName: { type: "string" },
        slideName: { type: "string" },
        backgroundColor: { type: "string", description: "Six-digit hex color such as #24262B." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add_text",
    description: "Add a real text layer to the active Slide Studio slide using normalized 0-1 coordinates.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
        x: { type: "number", minimum: 0, maximum: 1 },
        y: { type: "number", minimum: 0, maximum: 1 },
        width: { type: "number", minimum: 0.1, maximum: 1 },
        height: { type: "number", minimum: 0.04, maximum: 1 },
        size: { type: "number", minimum: 20, maximum: 180 },
        color: { type: "string" },
        style: { type: "string", enum: ["plain", "outline", "boxed"] },
        background: { type: "string", enum: ["white", "black"] },
        backgroundShape: { type: "string", enum: ["lines", "full"] },
        align: { type: "string", enum: ["left", "center", "right"] },
        rotation: { type: "number", minimum: -180, maximum: 180 },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  if (name === "list_editors") {
    return { selectedEditorId, editors: activeEditors().map((editor) => ({ id: editor.id, selected: editor.id === selectedEditorId, pageUrl: editor.pageUrl, state: editor.state })) };
  }
  if (name === "select_editor") {
    const editor = activeEditors().find((candidate) => candidate.id === args.editorId);
    if (!editor) throw new Error(`Editor is not connected: ${args.editorId}`);
    selectedEditorId = editor.id;
    return { selectedEditorId, pageUrl: editor.pageUrl, state: editor.state };
  }
  if (name === "get_editor_state") return callBrowser(name, { type: "editor.get_state" });
  if (name === "create_demo_slide") return callBrowser(name, { type: "slide.create_demo", ...args });
  if (name === "add_text") return callBrowser(name, { type: "text.add", ...args });
  throw new Error(`Unknown tool: ${name}`);
}

function sendRpc(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function handleRpc(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.id == null) return;
  try {
    if (message.method === "initialize") {
      return sendRpc({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "slide-studio-local-poc", version: "0.1.0" },
        instructions: "Open the isolated Slide Studio Pages test in a browser before calling editing tools.",
      } });
    }
    if (message.method === "ping") return sendRpc({ jsonrpc: "2.0", id: message.id, result: {} });
    if (message.method === "tools/list") return sendRpc({ jsonrpc: "2.0", id: message.id, result: { tools } });
    if (message.method === "tools/call") {
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      return sendRpc({ jsonrpc: "2.0", id: message.id, result: {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      } });
    }
    return sendRpc({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  } catch (error) {
    return sendRpc({ jsonrpc: "2.0", id: message.id, result: {
      content: [{ type: "text", text: error.message }],
      isError: true,
    } });
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    try { void handleRpc(JSON.parse(line)); }
    catch (error) { log(`Invalid JSON-RPC input: ${error.message}`); }
  }
});

function shutdown() {
  for (const editor of editors.values()) {
    if (!editor.poll) continue;
    editor.poll.writeHead(204, editor.cors || {});
    editor.poll.end();
    editor.poll = null;
  }
  for (const pending of inflight.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Local MCP companion is shutting down."));
  }
  inflight.clear();
  bridge.closeAllConnections?.();
  bridge.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 750).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
