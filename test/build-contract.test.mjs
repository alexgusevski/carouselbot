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
    "home-copy.mjs",
    "layer-interactions.mjs",
    "main.mjs",
    "project-fonts.mjs",
    "project-store.mjs",
    "slide-background.mjs",
    "slide-renderer.mjs",
    "video-audio.mjs",
    "video-export.mjs",
    "video-frame.mjs",
    "video-media.mjs",
    "video-playback.mjs",
    "video-sample.mjs",
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
  const { dependencies } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const videoLibrary = `assets/mediabunny-${dependencies.mediabunny}.min.mjs`;
  assert.deepEqual(await readFile(join(root, "dist", videoLibrary)), await readFile(join(root, "node_modules/mediabunny/dist/bundles/mediabunny.min.mjs")));
  assert.ok((await readFile(join(root, "src/video-media.mjs"), "utf8")).includes(`/${videoLibrary}`));
  assert.ok((await readFile(join(root, "server.mjs"), "utf8")).includes(`/${videoLibrary}`));
  await access(join(root, "dist/assets/mediabunny-LICENSE.txt"));

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
  assert.match(contentSecurityPolicy, /connect-src 'self' http:\/\/127\.0\.0\.1:43117/);
  assert.ok(blocks.get("/src/*")?.includes("Cache-Control: no-cache"));
  assert.ok(blocks.get("/app.js")?.includes("Cache-Control: no-cache"));
  assert.deepEqual(blocks.get("/index.md"), [
    "Content-Type: text/markdown; charset=utf-8",
    'Link: <https://carousel.bot/>; rel="canonical"',
    "X-Robots-Tag: noindex",
    "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
  ]);
  assert.ok(blocks.get("/")?.includes('Link: <https://carousel.bot/index.md>; rel="alternate"; type="text/markdown"'));
  assert.ok(blocks.get("/")?.includes('Link: </llms.txt>; rel="describedby"; type="text/plain"'));
});

test("the Pages project is static: no Functions, bindings or cloud calls", async () => {
  const source = await readFile(join(root, "wrangler.jsonc"), "utf8");
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(config.name, "slides-editor", "the legacy-origin IndexedDB migration depends on this project name");
  assert.equal(config.pages_build_output_dir, "./dist");
  for (const key of ["kv_namespaces", "d1_databases", "r2_buckets", "vars", "services", "durable_objects", "env"]) {
    assert.equal(config[key], undefined, `wrangler.jsonc must not declare ${key}`);
  }
  await assert.rejects(access(join(root, "functions")), "functions/ must not exist");

  const clientFiles = ["app.js", "app-config.js", "domain-migration.js", "local-mcp-bridge.js",
    ...(await readdir(sourceDirectory)).filter((name) => name.endsWith(".mjs")).map((name) => `src/${name}`)];
  for (const file of clientFiles) {
    const source = await readFile(join(root, file), "utf8");
    assert.doesNotMatch(source, /["'`]\/api\//, `${file} must not call a server API`);
    assert.doesNotMatch(source, /challenges\.cloudflare\.com|turnstile/i, `${file} must not load Turnstile`);
  }

  const headers = await readFile(join(root, "deploy", "_headers"), "utf8");
  assert.doesNotMatch(headers, /challenges\.cloudflare\.com/);
});

test("the static build ships SEO files and a real 404 instead of SPA soft 404s", async () => {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "pipe" });
  await assert.rejects(access(join(root, "dist", "_worker.js")));
  await assert.rejects(access(join(root, "dist", "functions")));
  const robots = await readFile(join(root, "dist", "robots.txt"), "utf8");
  assert.match(robots, /^Sitemap: https:\/\/carousel\.bot\/sitemap\.xml$/m);
  const sitemap = await readFile(join(root, "dist", "sitemap.xml"), "utf8");
  assert.deepEqual([...sitemap.matchAll(/<loc>(.+?)<\/loc>/g)].map((match) => match[1]), ["https://carousel.bot/"]);
  assert.equal(sitemap, await readFile(join(root, "deploy", "sitemap.xml"), "utf8"));
  const markdown = await readFile(join(root, "dist", "index.md"), "utf8");
  assert.match(markdown, /^---\nagent:\n/);
  assert.match(markdown, /^title: "CarouselBot"$/m);
  assert.match(markdown, /^url: "https:\/\/carousel\.bot\/"$/m);
  assert.match(markdown, /^# Turn photos into \*scroll-stoppers\.\*$/m);
  assert.doesNotMatch(markdown, /<(?:script|nav|style|html)\b/i);
  assert.equal(markdown.endsWith("\n"), true);
  assert.doesNotMatch(markdown, /\r/);
  const llms = await readFile(join(root, "dist", "llms.txt"), "utf8");
  assert.match(llms, /- \[CarouselBot\]\(https:\/\/carousel\.bot\/\): /);
  assert.equal(await readFile(join(root, "dist", "llms-full.txt"), "utf8"), markdown);
  await assert.rejects(access(join(root, "dist", "_routes.json")));
  assert.match(robots, /^Content-Signal: search=yes, ai-input=yes, ai-train=yes$/m);
  assert.match(robots, /^User-agent: ClaudeBot$/m);
  assert.match(robots, /^Disallow: \/projects\/$/m);
  assert.match(robots, /^# Agents: start at https:\/\/carousel\.bot\/llms\.txt$/m);
  assert.doesNotMatch(llms, /\.md\)/, "llms.txt links canonical HTML URLs");
  assert.match(await readFile(join(root, "dist", "404.html"), "utf8"), /Page not found/);
  const redirects = (await readFile(join(root, "dist", "_redirects"), "utf8"))
    .split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(redirects, ["/projects/* / 200", "/folders/* / 200", "/share/* / 302", "/share / 302"]);
  assert.match(await readFile(join(root, "dist", "index.html"), "utf8"), /<link rel="canonical" href="https:\/\/carousel\.bot" \/>/);
});

test("the agent install prompt reads instructions from an immutable release tag", async () => {
  const bridge = await readFile(join(root, "local-mcp-bridge.js"), "utf8");
  const url = bridge.match(/const LOCAL_MCP_INSTRUCTIONS_URL = "([^"]+)"/)?.[1];
  assert.match(url, /^https:\/\/raw\.githubusercontent\.com\/alexgusevski\/carouselbot\/v\d+\.\d+\.\d+\/packages\/mcp\/README\.md$/);
  assert.doesNotMatch(bridge, /refs\/heads|\/main\/packages/);
  const tag = url.match(/\/v(\d+\.\d+\.\d+)\//)[1];
  const published = JSON.parse(await readFile(join(root, "packages/mcp/package.json"), "utf8")).version;
  const [major, minor, patch] = tag.split(".").map(Number);
  const [pMajor, pMinor, pPatch] = published.split(".").map(Number);
  assert.ok(major < pMajor || (major === pMajor && (minor < pMinor || (minor === pMinor && patch <= pPatch))), "the pinned tag must be a released version");
});

test("the editor pairs with new companions and still connects to older ones", async () => {
  const bridge = await readFile(join(root, "local-mcp-bridge.js"), "utf8");
  assert.match(bridge, /pairingSupported: true/);
  assert.match(bridge, /pairingKey: localMcpStoredPairingKey\(\)/);
  assert.match(bridge, /response\.status === 202 && result\.pairingRequired/);
  assert.match(bridge, /data-local-mcp-pairing-code/);
});
