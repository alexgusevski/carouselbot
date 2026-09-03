import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(root, "src");

test("every local module import resolves to a committed source file", async () => {
  const moduleNames = (await readdir(sourceDirectory)).filter((name) => name.endsWith(".mjs"));
  assert.deepEqual(moduleNames.sort(), [
    "agent-commands.mjs",
    "agent-font-patch.mjs",
    "editor-actions.mjs",
    "editor-model.mjs",
    "editor-output.mjs",
    "editor-projects.mjs",
    "editor-state.mjs",
    "editor-ui.mjs",
    "editor-view.mjs",
    "editor.mjs",
    "layer-interactions.mjs",
    "main.mjs",
    "project-fonts.mjs",
    "project-store.mjs",
    "slide-background.mjs",
    "slide-renderer.mjs",
  ]);

  for (const name of moduleNames) {
    const path = join(sourceDirectory, name);
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/from\s+["'](\.\/.+?)["']/g)) {
      await assert.doesNotReject(access(resolve(dirname(path), match[1])), `${name} imports missing ${match[1]}`);
    }
  }
});

test("the feature-controller dependency graph stays acyclic and facade-owned", async () => {
  const moduleNames = (await readdir(sourceDirectory)).filter((name) => name.endsWith(".mjs"));
  const dependencies = new Map();
  for (const name of moduleNames) {
    const source = await readFile(join(sourceDirectory, name), "utf8");
    dependencies.set(name, [...source.matchAll(/from\s+["']\.\/(.+?\.mjs)["']/g)].map((match) => match[1]));
  }

  const featureControllers = new Set([
    "editor-actions.mjs",
    "editor-output.mjs",
    "editor-projects.mjs",
    "editor-ui.mjs",
  ]);
  for (const name of featureControllers) {
    const forbidden = dependencies.get(name).filter((dependency) => dependency === "editor.mjs" || featureControllers.has(dependency));
    assert.deepEqual(forbidden, [], `${name} must receive cross-controller behavior from the facade`);
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (name, path = []) => {
    if (visiting.has(name)) assert.fail(`module cycle: ${[...path, name].join(" -> ")}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of dependencies.get(name) || []) visit(dependency, [...path, name]);
    visiting.delete(name);
    visited.add(name);
  };
  moduleNames.forEach((name) => visit(name));
});

test("the browser bootloader preserves readiness compatibility aliases", async () => {
  const source = await readFile(join(root, "app.js"), "utf8");
  assert.match(source, /import\("\/src\/main\.mjs"\)/);
  assert.match(source, /window\.carouselBotReady/);
  assert.match(source, /window\.slideStudioReady = window\.carouselBotReady/);
});

test("the production build copies the complete module graph and versions the entry assets", async () => {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "pipe" });
  const sourceModules = (await readdir(sourceDirectory)).filter((name) => name.endsWith(".mjs")).sort();
  const builtModules = (await readdir(join(root, "dist", "src"))).filter((name) => name.endsWith(".mjs")).sort();
  assert.deepEqual(builtModules, sourceModules);

  const index = await readFile(join(root, "dist", "index.html"), "utf8");
  assert.doesNotMatch(index, /\?v=dev/);
  assert.match(index, /\/app\.js\?v=[0-9a-f]{12}/);
  assert.doesNotMatch(index, /agent-commands\.js/);
});

test("deployment headers prevent mixed-version module graphs", async () => {
  const headers = await readFile(join(root, "deploy", "_headers"), "utf8");
  const blocks = new Map(headers.trim().split(/\n(?=\/)/).map((block) => {
    const [path, ...rules] = block.split("\n");
    return [path.trim(), rules.map((rule) => rule.trim()).filter(Boolean)];
  }));
  const contentSecurityPolicy = blocks.get("/*")?.find((rule) => rule.startsWith("Content-Security-Policy:"));
  assert.match(contentSecurityPolicy, /style-src 'self'; style-src-attr 'unsafe-inline'/);
  assert.ok(blocks.get("/src/*")?.includes("Cache-Control: no-cache"));
  assert.ok(blocks.get("/app.js")?.includes("Cache-Control: no-cache"));
});
