import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Development server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch { /* The child may still be binding its socket. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Development server did not become ready.");
}

test("development server serves modules and deep project and folder routes", async () => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, CAROUSELBOT_PORT: String(port) },
    stdio: "ignore",
  });

  try {
    const rootResponse = await waitForServer(origin, child);
    assert.match(await rootResponse.text(), /<title>CarouselBot<\/title>/);

    const moduleResponse = await fetch(`${origin}/src/main.mjs`);
    assert.equal(moduleResponse.status, 200);
    assert.match(moduleResponse.headers.get("content-type"), /javascript/);
    assert.equal(moduleResponse.headers.get("cache-control"), "no-cache");
    assert.match(await moduleResponse.text(), /installAgentGlobals/);

    const deepRoute = await fetch(`${origin}/projects/server-contract`);
    assert.equal(deepRoute.status, 200);
    assert.match(await deepRoute.text(), /<title>CarouselBot<\/title>/);

    const folderRoute = await fetch(`${origin}/folders/my-folder`);
    assert.equal(folderRoute.status, 200);
    assert.match(await folderRoute.text(), /<title>CarouselBot<\/title>/);

    assert.equal((await fetch(`${origin}/agent-commands.js`)).status, 404);
    assert.equal((await fetch(`${origin}/src/../server.mjs`)).status, 404);
  } finally {
    if (child.exitCode == null) {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
      });
    }
  }
});
