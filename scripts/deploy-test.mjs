import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const project = "slides-mcp-poc-0821";
const allowedBranch = "alex/local-mcp-pages-poc";
const readGit = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
const fail = (message) => { console.error(`Test deploy blocked: ${message}`); process.exit(1); };

const branch = readGit("branch", "--show-current");
if (branch !== allowedBranch) fail(`expected ${allowedBranch}, found ${branch || "detached HEAD"}.`);
if (readGit("status", "--porcelain")) fail("commit or stash all changes first.");

console.log(`Deploying ${readGit("rev-parse", "--short", "HEAD")} to the isolated ${project} Pages project…`);
run("npm", ["run", "build"]);
const wrangler = join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
run(wrangler, ["pages", "deploy", "dist", "--project-name", project, "--branch", "main"]);
