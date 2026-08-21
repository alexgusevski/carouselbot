import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createCompanion } from "./companion.mjs";
import { createSlideStudioMcpServer } from "./mcp-server.mjs";

export async function serveMcp() {
  const companion = await createCompanion();
  const handle = serveStdio(() => createSlideStudioMcpServer(companion), {
    legacy: "serve",
    onerror: (error) => process.stderr.write(`[slide-studio-mcp] ${error.message}\n`),
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await handle.close().catch(() => {});
    await companion.close();
  };
  process.once("SIGINT", () => void close().finally(() => process.exit()));
  process.once("SIGTERM", () => void close().finally(() => process.exit()));
  process.once("SIGHUP", () => void close().finally(() => process.exit()));
  process.stdin.once("end", () => void close());
  return { handle, companion, close };
}
