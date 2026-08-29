const test = require("node:test");
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

const root = join(__dirname, "..");

test("release metadata accepts stable and prerelease semantic versions", async () => {
  const { validateReleaseMetadata } = await import(join(root, "scripts/release-policy.mjs"));

  assert.deepEqual(validateReleaseMetadata("v1.2.3", false), { version: "1.2.3", npmTag: "latest" });
  assert.deepEqual(validateReleaseMetadata("v1.2.3-beta.1", true), { version: "1.2.3-beta.1", npmTag: "beta" });
});

test("release metadata rejects unsafe tags and mismatched release types", async () => {
  const { validateReleaseMetadata } = await import(join(root, "scripts/release-policy.mjs"));

  for (const tag of ["main", "v1.2", "v$(id)", "v1.2.3;echo", "v01.2.3"]) {
    assert.throws(() => validateReleaseMetadata(tag, false));
  }
  assert.throws(() => validateReleaseMetadata("v1.2.3-beta.1", false));
  assert.throws(() => validateReleaseMetadata("v1.2.3", true));
});

test("publish workflow validates source before executing repository code", async () => {
  const workflow = await readFile(join(root, ".github/workflows/publish.yml"), "utf8");
  const validation = workflow.indexOf("Validate release metadata before checkout");
  const checkout = workflow.indexOf("Check out the released tag");
  const ancestry = workflow.indexOf("git merge-base --is-ancestor");
  const install = workflow.indexOf("npm ci --ignore-scripts");

  assert.ok(validation >= 0 && validation < checkout);
  assert.ok(checkout < ancestry && ancestry < install);
  assert.match(workflow, /ref: \$\{\{ needs\.verify\.outputs\.release-sha \}\}/);
  assert.match(workflow, /publish-compatibility:[\s\S]*- publish-carouselbot/);

  const lines = workflow.split("\n");
  let runBlockIndent = null;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (runBlockIndent !== null && line.trim() && indent <= runBlockIndent) runBlockIndent = null;
    if (/^\s*run:\s*\|\s*$/.test(line)) runBlockIndent = indent;
    if (runBlockIndent !== null) assert.doesNotMatch(line, /\$\{\{\s*github\.event\./);
    if (/^\s*run:\s*[^|]/.test(line)) assert.doesNotMatch(line, /\$\{\{\s*github\.event\./);
  }
});

test("MCP setup pins the installed package version", async () => {
  const setup = await readFile(join(root, "packages/mcp/src/setup.mjs"), "utf8");
  assert.match(setup, /const specifier = `\$\{PACKAGE_NAME\}@\$\{PACKAGE_VERSION\}`/);
  assert.doesNotMatch(setup, /PACKAGE_NAME\}@\$\{releaseTag/);
});
