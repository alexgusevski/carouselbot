import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PACKAGE_JSON = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
export const PACKAGE_NAME = PACKAGE_JSON.name;
export const PACKAGE_VERSION = PACKAGE_JSON.version;
export const PROTOCOL_VERSION = 2;
export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = Number(process.env.SLIDE_STUDIO_BRIDGE_PORT) || 43117;
export const BRIDGE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
export const TEST_EDITOR_URL = "https://slides-mcp-poc-0821.pages.dev";
export const ALLOWED_ORIGINS = new Set((process.env.SLIDE_STUDIO_ALLOWED_ORIGINS || [
  TEST_EDITOR_URL,
  "http://127.0.0.1:4173",
  "http://localhost:4173",
].join(",")).split(",").map((value) => value.trim()).filter(Boolean));
export const GUIDANCE_PATH = join(PACKAGE_ROOT, "guidance", "design.md");

function defaultStateDirectory() {
  if (process.env.SLIDE_STUDIO_STATE_DIR) return process.env.SLIDE_STUDIO_STATE_DIR;
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || homedir(), "SlideStudioMCP");
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "SlideStudioMCP");
  return join(process.env.XDG_RUNTIME_DIR || join(homedir(), ".cache"), "slides-studio-mcp");
}

export const STATE_DIRECTORY = defaultStateDirectory();
export const DAEMON_STATE_PATH = join(STATE_DIRECTORY, `daemon-${BRIDGE_PORT}.json`);
export const DAEMON_LOCK_PATH = join(STATE_DIRECTORY, `daemon-${BRIDGE_PORT}.lock`);
