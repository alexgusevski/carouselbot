import test from "node:test";
import assert from "node:assert/strict";
import { detectHostAgent, preferHostAgent } from "../src/agent-identity.mjs";

test("detects Hermes from its bundled Node runtime without client cooperation", () => {
  const runtime = { execPath: "/Users/person/.hermes/node/bin/node", argv: ["node", "slides-studio-mcp", "serve"] };
  assert.equal(detectHostAgent(null, {}, runtime), "Hermes");
});

test("explicit setup identity wins over runtime inference", () => {
  const runtime = { execPath: "/usr/bin/node", argv: ["node", "slides-studio-mcp", "serve"] };
  assert.equal(detectHostAgent("codex", { PATH: "/Users/person/.hermes/node/bin" }, runtime), "Codex");
});

test("generic MCP metadata does not erase the detected host agent", () => {
  assert.equal(preferHostAgent("mcp", "Hermes"), "Hermes");
  assert.equal(preferHostAgent("Slide Studio CLI fallback", "Claude"), "Claude");
  assert.equal(preferHostAgent("Codex Desktop", "Hermes"), "Codex");
});
