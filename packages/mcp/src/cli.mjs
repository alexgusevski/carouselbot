#!/usr/bin/env node
import { companionDoctor, companionRestart } from "./companion.mjs";
import { EDITOR_URL, PACKAGE_NAME, PACKAGE_VERSION } from "./config.mjs";
import { runSetup } from "./setup.mjs";
import { serveMcp } from "./stdio-server.mjs";

const [command = "serve", ...arguments_] = process.argv.slice(2);

async function main() {
  if (command === "serve") {
    const agentName = arguments_.find((value) => value.startsWith("--agent="))?.slice("--agent=".length) || null;
    await serveMcp({ agentName });
    return;
  }
  if (command === "setup") {
    await runSetup(arguments_);
    return;
  }
  if (command === "call") {
    const { runCall } = await import("./call.mjs");
    await runCall(arguments_);
    return;
  }
  if (command === "doctor") {
    const health = await companionDoctor();
    process.stdout.write(`${JSON.stringify({ package: PACKAGE_NAME, packageVersion: PACKAGE_VERSION, editor: EDITOR_URL, daemon: health }, null, 2)}\n`);
    return;
  }
  if (command === "restart") {
    const health = await companionRestart();
    process.stdout.write(`${JSON.stringify({ package: PACKAGE_NAME, packageVersion: PACKAGE_VERSION, daemon: health }, null, 2)}\n`);
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`Slide Studio MCP ${PACKAGE_VERSION}\n\nUsage:\n  slides-studio-mcp serve [--agent=claude|codex|hermes|opencode|openclaw]\n  slides-studio-mcp setup [--client=claude,codex,hermes,opencode,openclaw] [--yes] [--dry-run]\n  slides-studio-mcp call <tool> [--json '{"key":"value"}'] [--stdin]\n  slides-studio-mcp doctor\n  slides-studio-mcp restart\n  slides-studio-mcp version\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
