import { spawn } from "node:child_process";
import { once } from "node:events";

const child = spawn(process.execPath, ["mcp/server.mjs"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

let output = "";
const replies = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk;
  let newline;
  while ((newline = output.indexOf("\n")) >= 0) {
    const line = output.slice(0, newline).trim();
    output = output.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    replies.get(message.id)?.(message);
    replies.delete(message.id);
  }
});

function request(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 5000);
    replies.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  await new Promise((resolve) => setTimeout(resolve, 150));
  const initialized = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "poc-test", version: "1" } });
  if (initialized.result?.serverInfo?.name !== "slide-studio-local-poc") throw new Error("MCP initialize failed");
  const listed = await request(2, "tools/list");
  const names = listed.result?.tools?.map((tool) => tool.name) || [];
  for (const expected of ["list_editors", "get_editor_state", "create_demo_slide", "add_text"]) {
    if (!names.includes(expected)) throw new Error(`Missing tool: ${expected}`);
  }
  const health = await fetch("http://127.0.0.1:43117/health");
  if (!health.ok || !(await health.json()).ok) throw new Error("Loopback health check failed");
  console.log(`MCP initialize, ${names.length} tools, and loopback bridge health all passed.`);
} finally {
  child.kill("SIGTERM");
  await once(child, "exit");
}
