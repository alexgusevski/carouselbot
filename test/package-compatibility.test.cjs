const test = require("node:test");
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

const root = join(__dirname, "..");

test("legacy and canonical MCP packages publish matching versions", async () => {
  const primary = JSON.parse(await readFile(join(root, "packages/mcp/package.json"), "utf8"));
  const legacy = JSON.parse(await readFile(join(root, "packages/slides-studio-mcp/package.json"), "utf8"));
  assert.equal(primary.name, "carouselbot");
  assert.equal(legacy.name, "slides-studio-mcp");
  assert.equal(legacy.version, primary.version);
  assert.equal(legacy.dependencies[primary.name], primary.version);
  assert.equal(primary.bin.carouselbot, "src/cli.mjs");
  assert.equal(legacy.bin[legacy.name], "bin/cli.mjs");
});
