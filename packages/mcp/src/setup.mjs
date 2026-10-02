import { spawnSync } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { EDITOR_URL, PACKAGE_NAME, PACKAGE_ROOT, PACKAGE_VERSION } from "./config.mjs";
import { companionUpgrade } from "./companion.mjs";

const supported = ["claude", "codex", "hermes", "opencode", "openclaw"];
const serverName = "carouselbot";
const legacyServerName = "slide-studio";

function commandExists(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).error?.code !== "ENOENT";
}

function commandVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  return `${result.stdout || ""}${result.stderr || ""}`.match(/\d+\.\d+(?:\.\d+)?/)?.[0] || null;
}

function shellCommand(client, specifier) {
  if (client === "claude") return ["claude", "mcp", "add", "--scope", "user", "--transport", "stdio", serverName, "--", "npx", "-y", specifier, "serve", "--agent=claude"];
  if (client === "codex") return ["codex", "mcp", "add", serverName, "--", "npx", "-y", specifier, "serve", "--agent=codex"];
  if (client === "hermes") return ["hermes", "mcp", "add", serverName, "--command", "npx", "--args", "-y", specifier, "serve", "--agent=hermes"];
  if (client === "openclaw") return ["openclaw", "mcp", "add", serverName, "--command", "npx", "--arg", "-y", "--arg", specifier, "--arg", "serve", "--arg", "--agent=openclaw"];
  return null;
}

function removeCommands(client) {
  if (client === "claude") return [serverName, legacyServerName].map((name) => ["claude", "mcp", "remove", "--scope", "user", name]);
  if (["codex", "hermes", "openclaw"].includes(client)) return [serverName, legacyServerName].map((name) => [client, "mcp", "remove", name]);
  return [];
}

function quote(value) {
  return /^[A-Za-z0-9_@./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function openCodeSnippet(specifier, version = commandVersion("opencode")) {
  const server = { type: "local", command: ["npx", "-y", specifier, "serve", "--agent=opencode"] };
  return JSON.stringify(Number(version?.split(".")[0]) >= 2
    ? { mcp: { servers: { [serverName]: server } } }
    : { mcp: { [serverName]: { ...server, enabled: true } } }, null, 2);
}

export function setupSkillTargets(homeDirectory = homedir(), hermesHome = process.env.HERMES_HOME) {
  const targets = [
    join(homeDirectory, ".agents", "skills", "carouselbot"),
    join(homeDirectory, ".claude", "skills", "carouselbot"),
    join(homeDirectory, ".hermes", "skills", "carouselbot"),
  ];
  if (hermesHome?.trim()) targets.push(join(resolve(hermesHome.trim()), "skills", "carouselbot"));
  return [...new Set(targets)];
}

export function clientSpawnOptions(client) {
  if (client === "hermes") {
    // Hermes tool discovery prompts even after the caller approved CarouselBot
    // setup, and an existing entry adds an overwrite prompt first. Feed both
    // approvals explicitly; EOF otherwise looks like a successful cancel.
    return { input: "y\ny\n", stdio: ["pipe", "inherit", "inherit"] };
  }
  return { stdio: "inherit" };
}

function clientConfigurationPresent(client) {
  if (client !== "hermes") return true;
  const result = spawnSync("hermes", ["mcp", "list"], { encoding: "utf8" });
  return result.status === 0 && /(?:^|\s)carouselbot(?:\s|$)/m.test(String(result.stdout || "") + String(result.stderr || ""));
}

async function installSkill() {
  const source = join(PACKAGE_ROOT, "skill", "carouselbot");
  const targets = setupSkillTargets();
  for (const target of targets) {
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }
  return targets;
}

export async function runSetup(arguments_) {
  const flags = new Set(arguments_);
  const clientArgument = arguments_.find((value) => value.startsWith("--client="))?.slice("--client=".length);
  const requested = clientArgument ? clientArgument.split(",").map((value) => value.trim().toLowerCase()) : supported.filter(commandExists);
  const clients = [...new Set(requested)].filter((client) => supported.includes(client));
  const specifier = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;
  const dryRun = flags.has("--dry-run");
  const assumeYes = flags.has("--yes") || flags.has("-y");
  if (!clients.length) throw new Error("No supported agent CLI was detected. Use --client=claude,codex,hermes,opencode,openclaw or copy the generic stdio config below.");

  process.stdout.write(`CarouselBot MCP ${PACKAGE_VERSION}\nDetected: ${clients.join(", ")}\nEditor: ${EDITOR_URL}\n\n`);
  for (const client of clients) {
    const command = shellCommand(client, specifier);
    if (command) process.stdout.write(`${client}: ${command.map(quote).join(" ")}\n`);
    else process.stdout.write(`opencode config:\n${openCodeSnippet(specifier)}\n`);
  }
  process.stdout.write(`\nGeneric stdio: npx -y ${specifier} serve\n`);
  if (dryRun) return { clients, dryRun: true };

  let approved = assumeYes;
  if (!approved && process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question("\nAdd CarouselBot to the detected agent configs and install its skill? [y/N] ");
    prompt.close();
    approved = /^y(?:es)?$/i.test(answer.trim());
  }
  if (!approved) {
    process.stdout.write("\nNo configuration changed. Re-run with --yes when ready.\n");
    return { clients, installed: false };
  }

  const configured = [];
  for (const client of clients) {
    const command = shellCommand(client, specifier);
    if (!command) continue;
    if (client !== "hermes") {
      for (const remove of removeCommands(client)) spawnSync(remove[0], remove.slice(1), { stdio: "ignore" });
    }
    const result = spawnSync(command[0], command.slice(1), clientSpawnOptions(client));
    if (result.status === 0 && clientConfigurationPresent(client)) {
      configured.push(client);
      if (client === "hermes") {
        const legacyRemove = removeCommands(client).find((remove) => remove.at(-1) === legacyServerName);
        if (legacyRemove) spawnSync(legacyRemove[0], legacyRemove.slice(1), { input: "y\n", stdio: ["pipe", "ignore", "ignore"] });
      }
    } else process.stderr.write(`Could not verify ${client}'s CarouselBot config; the existing config was preserved and its command is printed above for manual setup.\n`);
  }
  const skillTargets = await installSkill();
  const companion = await companionUpgrade();
  process.stdout.write(`\nConfigured: ${configured.join(", ") || "none automatically"}\nSkill installed in:\n${skillTargets.map((value) => `  ${value}`).join("\n")}\nCompanion: ${companion.version} (${companion.upgraded ? "upgraded automatically" : "already current"})\n\nOpen ${EDITOR_URL} in your normal local browser and click Connect AI. Do not use a sandboxed agent browser.\n`);
  process.stdout.write(`First connection check (no browser automation): npx -y ${specifier} call list_editors\n`);
  if (clients.includes("hermes")) process.stdout.write("The companion and browser reconnect automatically. Hermes only needs /reload-mcp when adding entirely new native tool names to an already-running session; the CLI fallback remains available immediately.\n");
  if (clients.includes("claude")) process.stdout.write("Claude may require a new session for native MCP registration; use the CLI fallback immediately instead of stopping.\n");
  if (clients.includes("opencode")) process.stdout.write("OpenCode currently uses its JSON config; merge the snippet printed above into opencode.json.\n");
  return { clients, configured, skillTargets };
}
