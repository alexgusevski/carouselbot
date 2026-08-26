import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { detectHostAgent } from "./agent-identity.mjs";
import { createCompanion } from "./companion.mjs";
import { createCarouselBotMcpServer } from "./mcp-server.mjs";

export async function serveMcp({ agentName = null } = {}) {
  const companion = await createCompanion(detectHostAgent(agentName));
  const handle = serveStdio(() => createCarouselBotMcpServer(companion), {
    legacy: "serve",
    onerror: (error) => process.stderr.write(`[carouselbot] ${error.message}\n`),
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
  process.stdin.once("end", () => void close().finally(() => process.exit()));
  return { handle, companion, close };
}
