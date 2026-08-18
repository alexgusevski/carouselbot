import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "assets"), { recursive: true });

await Promise.all([
  copyFile(join(root, "index.html"), join(output, "index.html")),
  copyFile(join(root, "404.html"), join(output, "404.html")),
  copyFile(join(root, "app.js"), join(output, "app.js")),
  copyFile(join(root, "styles.css"), join(output, "styles.css")),
  copyFile(join(root, "deploy", "_headers"), join(output, "_headers")),
  cp(join(root, "assets"), join(output, "assets"), { recursive: true }),
]);

console.log("Built the static Cloudflare bundle in dist/");
