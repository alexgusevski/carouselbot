const KNOWN_AGENTS = [
  { label: "Hermes", matches: ["hermes"] },
  { label: "Claude", matches: ["claude", "anthropic"] },
  { label: "Codex", matches: ["codex", "openai"] },
  { label: "OpenCode", matches: ["opencode"] },
  { label: "OpenClaw", matches: ["openclaw"] },
];

const GENERIC_CLIENT_NAMES = new Set([
  "ai agent",
  "agent",
  "client",
  "mcp",
  "mcp agent",
  "mcp client",
  "slide studio cli fallback",
]);

export function canonicalAgentName(value) {
  const name = String(value || "").trim();
  const normalized = name.toLowerCase();
  return KNOWN_AGENTS.find(({ matches }) => matches.some((match) => normalized.includes(match)))?.label || name || null;
}

export function isGenericAgentName(value) {
  return GENERIC_CLIENT_NAMES.has(String(value || "").trim().toLowerCase());
}

export function detectHostAgent(explicitName = null, environment = process.env, runtime = process) {
  const configured = canonicalAgentName(explicitName || environment.SLIDE_STUDIO_AGENT);
  if (configured) return configured;
  const environmentKeys = Object.keys(environment).filter((key) => environment[key]).join(" ");
  const evidence = [
    runtime.execPath,
    ...(runtime.argv || []),
    environment.PATH,
    environment.TERM_PROGRAM,
    environment.npm_execpath,
    environmentKeys,
  ].filter(Boolean).join(" ").toLowerCase();
  return KNOWN_AGENTS.find(({ matches }) => matches.some((match) => evidence.includes(match)))?.label || "MCP agent";
}

export function preferHostAgent(reportedName, hostName) {
  const reported = canonicalAgentName(reportedName);
  const host = canonicalAgentName(hostName) || "MCP agent";
  return !reported || isGenericAgentName(reported) ? host : reported;
}
