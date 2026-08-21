import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
const wrangler = join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");

console.log("Deploying the current checkout to the persistent Cloudflare Pages dev environment…");
run("npm", ["run", "build"]);
run(wrangler, ["pages", "deploy", "dist", "--project-name", "slides-editor", "--branch", "dev"]);
