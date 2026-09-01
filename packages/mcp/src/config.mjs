import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PACKAGE_JSON = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
export const PACKAGE_NAME = PACKAGE_JSON.name;
export const PACKAGE_VERSION = PACKAGE_JSON.version;
export const PROTOCOL_VERSION = 3;
// The browser protocol changes only when the hosted editor and companion can no
// longer communicate. Internal MCP-to-daemon actions evolve independently, so
// advertise them explicitly instead of treating a matching browser protocol as
// proof that two installed package versions are compatible.
export const DAEMON_API_VERSION = 1;
export const DAEMON_INTERNAL_ACTIONS = Object.freeze([
  "batch",
  "begin_edit_session",
  "browser",
  "end_edit_session",
  "list_edit_sessions",
  "list_editors",
  "list_local_fonts",
  "list_recent_operations",
  "notify",
  "prepare_font",
  "prepare_media",
  "select_editor",
  "write_export",
]);
export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = Number(process.env.CAROUSELBOT_BRIDGE_PORT || process.env.SLIDE_STUDIO_BRIDGE_PORT) || 43117;
export const BRIDGE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
export const EDITOR_URL = "https://carousel.bot";
export const LEGACY_EDITOR_URL = "https://slides-editor.pages.dev";
export const ALLOWED_ORIGINS = new Set((process.env.CAROUSELBOT_ALLOWED_ORIGINS || process.env.SLIDE_STUDIO_ALLOWED_ORIGINS || [
  EDITOR_URL,
  LEGACY_EDITOR_URL,
  "http://127.0.0.1:4173",
  "http://localhost:4173",
].join(",")).split(",").map((value) => value.trim()).filter(Boolean));
export const GUIDANCE_PATH = join(PACKAGE_ROOT, "guidance", "design.md");

function defaultStateDirectory() {
  if (process.env.CAROUSELBOT_STATE_DIR || process.env.SLIDE_STUDIO_STATE_DIR) return process.env.CAROUSELBOT_STATE_DIR || process.env.SLIDE_STUDIO_STATE_DIR;
  const legacy = platform() === "win32"
    ? join(process.env.LOCALAPPDATA || homedir(), "SlideStudioMCP")
    : platform() === "darwin"
      ? join(homedir(), "Library", "Caches", "SlideStudioMCP")
      : join(process.env.XDG_RUNTIME_DIR || join(homedir(), ".cache"), "slides-studio-mcp");
  if (existsSync(legacy)) return legacy;
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || homedir(), "CarouselBot");
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "CarouselBot");
  return join(process.env.XDG_RUNTIME_DIR || join(homedir(), ".cache"), "carouselbot");
}

export const STATE_DIRECTORY = defaultStateDirectory();
export const DAEMON_STATE_PATH = join(STATE_DIRECTORY, `daemon-${BRIDGE_PORT}.json`);
export const DAEMON_LOCK_PATH = join(STATE_DIRECTORY, `daemon-${BRIDGE_PORT}.lock`);
export const AUDIT_LOG_PATH = join(STATE_DIRECTORY, `operations-${BRIDGE_PORT}.jsonl`);
