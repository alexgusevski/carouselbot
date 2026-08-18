import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readGit = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
const fail = (message) => {
  console.error(`Production deploy blocked: ${message}`);
  process.exit(1);
};

let branch;
try {
  branch = readGit("branch", "--show-current");
} catch {
  fail("this checkout is not on a branch.");
}
if (branch !== "main") fail(`current branch is “${branch || "detached HEAD"}”, not “main”.`);

if (readGit("status", "--porcelain")) fail("the main worktree has uncommitted changes.");

run("git", ["fetch", "origin", "main"]);
const head = readGit("rev-parse", "HEAD");
const remoteMain = readGit("rev-parse", "origin/main");
if (head !== remoteMain) fail("local main does not exactly match origin/main.");

console.log(`Deploying clean main ${head.slice(0, 7)} to Cloudflare Pages…`);
run("npm", ["run", "build"]);
const wrangler = join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
run(wrangler, ["pages", "deploy", "dist", "--project-name", "slides-editor", "--branch", "main"]);
