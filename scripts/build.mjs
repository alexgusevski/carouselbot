import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "assets"), { recursive: true });

const [indexHtml, appSource, bridgeSource, styleSource] = await Promise.all([
  readFile(join(root, "index.html"), "utf8"),
  readFile(join(root, "app.js"), "utf8"),
  readFile(join(root, "local-mcp-bridge.js"), "utf8"),
  readFile(join(root, "styles.css"), "utf8"),
]);
const assetVersion = createHash("sha256")
  .update(appSource)
  .update(bridgeSource)
  .update(styleSource)
  .digest("hex")
  .slice(0, 12);

await Promise.all([
  writeFile(join(output, "index.html"), indexHtml.replaceAll("?v=dev", `?v=${assetVersion}`)),
  copyFile(join(root, "404.html"), join(output, "404.html")),
  copyFile(join(root, "app.js"), join(output, "app.js")),
  copyFile(join(root, "local-mcp-bridge.js"), join(output, "local-mcp-bridge.js")),
  copyFile(join(root, "styles.css"), join(output, "styles.css")),
  copyFile(join(root, "deploy", "_headers"), join(output, "_headers")),
  cp(join(root, "assets"), join(output, "assets"), { recursive: true }),
]);

console.log("Built the static Cloudflare bundle in dist/");
