#!/usr/bin/env node
import { companionDoctor } from "./companion.mjs";
import { PACKAGE_NAME, PACKAGE_VERSION, TEST_EDITOR_URL } from "./config.mjs";
import { runSetup } from "./setup.mjs";
import { serveMcp } from "./stdio-server.mjs";

const [command = "serve", ...arguments_] = process.argv.slice(2);

async function main() {
  if (command === "serve") {
    await serveMcp();
    return;
  }
  if (command === "setup") {
    await runSetup(arguments_);
    return;
  }
  if (command === "doctor") {
    const health = await companionDoctor();
    process.stdout.write(`${JSON.stringify({ package: PACKAGE_NAME, packageVersion: PACKAGE_VERSION, editor: TEST_EDITOR_URL, daemon: health }, null, 2)}\n`);
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`Slide Studio MCP ${PACKAGE_VERSION}\n\nUsage:\n  slide-studio-mcp serve\n  slide-studio-mcp setup [--client=claude,codex,hermes,opencode,openclaw] [--yes] [--dry-run]\n  slide-studio-mcp doctor\n  slide-studio-mcp version\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
