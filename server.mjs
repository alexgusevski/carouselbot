import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const port = Number(process.env.SLIDE_STUDIO_PORT) || 4173;

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/agent-commands.js", ["agent-commands.js", "text/javascript; charset=utf-8"]],
  ["/local-mcp-bridge.js", ["local-mcp-bridge.js", "text/javascript; charset=utf-8"]],
  ["/assets/TikTokSans.ttf", ["assets/TikTokSans.ttf", "font/ttf"]],
  ["/assets/airdrop.svg", ["assets/airdrop.svg", "image/svg+xml"]],
  ["/assets/claude-ai-symbol.svg", ["assets/claude-ai-symbol.svg", "image/svg+xml"]],
  ["/assets/codex-logo.svg", ["assets/codex-logo.svg", "image/svg+xml"]],
  ["/assets/hermes-agent-logo.webp", ["assets/hermes-agent-logo.webp", "image/webp"]],
  ["/assets/Octicons-mark-github.svg", ["assets/Octicons-mark-github.svg", "image/svg+xml"]],
  ["/assets/favicon.svg", ["assets/favicon.svg", "image/svg+xml"]],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  const entry = files.get(url.pathname)
    || (/^\/projects\/[^/]+\/?$/.test(url.pathname) ? files.get("/") : null);

  if (!entry || (request.method !== "GET" && request.method !== "HEAD")) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  try {
    const [relativePath, contentType] = entry;
    const body = await readFile(join(root, relativePath));
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.byteLength,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Server error");
  }
});

server.listen(port, host, () => {
  console.log(`Slide Studio is running at http://${host}:${port}`);
});
