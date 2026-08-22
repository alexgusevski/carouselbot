import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const CLI_PATH = fileURLToPath(new URL("cli.mjs", import.meta.url));

async function stdinText() {
  if (process.stdin.isTTY) return "";
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

async function parseArguments(arguments_) {
  const [toolName, ...rest] = arguments_;
  if (!toolName) throw new Error("Usage: slides-studio-mcp call <tool> [--json '{\"key\":\"value\"}']");
  const inline = rest.find((value) => value.startsWith("--json="));
  const flagIndex = rest.indexOf("--json");
  const raw = inline?.slice("--json=".length)
    || (flagIndex >= 0 ? rest[flagIndex + 1] : rest.find((value) => !value.startsWith("--")))
    || (rest.includes("--stdin") ? await stdinText() : "")
    || "{}";
  let args;
  try { args = JSON.parse(raw); }
  catch { throw new Error("--json must be a valid JSON object."); }
  if (!args || Array.isArray(args) || typeof args !== "object") throw new Error("--json must be a JSON object.");
  return { toolName, args };
}

async function printableResult(toolName, result) {
  const error = result.isError && result.content?.find((item) => item.type === "text")?.text;
  if (error) throw new Error(error);
  if (toolName === "get_design_guidance") return { guidance: result.content?.find((item) => item.type === "text")?.text || "" };
  const image = result.content?.find((item) => item.type === "image" && item.data);
  if (!image) return result.structuredContent ?? { content: result.content || [] };
  const extension = image.mimeType === "image/jpeg" ? "jpg" : "png";
  const directory = await mkdtemp(join(tmpdir(), "slide-studio-preview-"));
  const previewPath = join(directory, `slide.${extension}`);
  await writeFile(previewPath, Buffer.from(image.data, "base64"));
  return { ...(result.structuredContent || {}), previewPath, temporary: true };
}

function createRpc(child) {
  let input = "";
  let id = 0;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    input += chunk;
    let newline;
    while ((newline = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    }
  });
  child.once("exit", (code) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Local MCP process exited before replying${code == null ? "" : ` (${code})`}.`));
    }
    pending.clear();
  });
  return {
    notify(method, params = {}) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); },
    request(method, params = {}) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timed out waiting for ${method}.`)); }, 120_000);
        pending.set(requestId, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      });
    },
  };
}

async function stopChild(child) {
  if (child.exitCode != null) return;
  child.stdin.end();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const timeout = new Promise((resolve) => { const timer = setTimeout(resolve, 2000); timer.unref(); });
  await Promise.race([exited, timeout]);
  if (child.exitCode == null) child.kill("SIGTERM");
}

export async function runCall(arguments_) {
  const { toolName, args } = await parseArguments(arguments_);
  const child = spawn(process.execPath, [CLI_PATH, "serve"], { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors = `${errors}${chunk}`.slice(-4000); });
  const rpc = createRpc(child);
  try {
    await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Slide Studio CLI fallback", version: "1" } });
    rpc.notify("notifications/initialized");
    if (toolName === "list_tools") {
      const listed = await rpc.request("tools/list");
      const requested = Array.isArray(args.names) ? new Set(args.names.map(String)) : null;
      const tools = listed.tools.filter((tool) => !requested || requested.has(tool.name)).map((tool) => ({
        name: tool.name,
        description: tool.description,
        ...(requested ? { inputSchema: tool.inputSchema } : {}),
      }));
      process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`);
      return;
    }
    if (toolName !== "get_design_guidance") await rpc.request("tools/call", { name: "get_design_guidance", arguments: {} });
    const result = await rpc.request("tools/call", { name: toolName, arguments: args });
    process.stdout.write(`${JSON.stringify(await printableResult(toolName, result), null, 2)}\n`);
  } catch (error) {
    throw new Error(`${error.message}${errors ? `\n${errors.trim()}` : ""}`);
  } finally {
    await stopChild(child);
  }
}
