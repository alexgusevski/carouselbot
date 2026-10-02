import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createCarouselBotMcpServer } from "../src/mcp-server.mjs";

function createCompanion(handler = async () => ({})) {
  const calls = [];
  return {
    calls,
    async identify(name, version) {
      calls.push({ method: "identify", name, version });
    },
    async call(action, args = {}) {
      calls.push({ method: "call", action, args });
      return handler(action, args, calls);
    },
  };
}

async function createHarness(companion) {
  const server = await createCarouselBotMcpServer(companion);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  let id = 0;
  clientTransport.onmessage = (message) => {
    const resolve = pending.get(message.id);
    if (!resolve) return;
    pending.delete(message.id);
    resolve(message);
  };
  await server.connect(serverTransport);
  await clientTransport.start();

  const request = async (method, params = {}) => {
    const requestId = ++id;
    const response = new Promise((resolve) => pending.set(requestId, resolve));
    await clientTransport.send({ jsonrpc: "2.0", id: requestId, method, params });
    return response;
  };
  const notify = (method, params = {}) => clientTransport.send({ jsonrpc: "2.0", method, params });

  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "font-tools-test", version: "1" },
  });
  assert.equal(initialized.result.serverInfo.name, "carouselbot");
  await notify("notifications/initialized");

  return {
    request,
    async callTool(name, args = {}) {
      const response = await request("tools/call", { name, arguments: args });
      assert.equal(response.error, undefined, response.error?.message);
      return response.result;
    },
    async close() {
      await clientTransport.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

async function withHarness(companion, callback) {
  const harness = await createHarness(companion);
  try {
    return await callback(harness);
  } finally {
    await harness.close();
  }
}

function toolByName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool;
}


test("video schemas remain discoverable under compatible image tools", async () => {
  await withHarness(createCompanion(), async ({ request }) => {
    const { tools } = (await request("tools/list")).result;
    assert.match(toolByName(tools, "import_asset").description, /video/);
    assert.match(toolByName(tools, "add_image").description, /video/);
    assert.equal(toolByName(tools, "render_slide").inputSchema.properties.time.minimum, 0);
    assert.deepEqual(toolByName(tools, "export_slide").inputSchema.properties.format.enum, ["auto", "png", "mp4"]);
    assert.ok(toolByName(tools, "set_video_playback").inputSchema.properties.playing);
  });
});

test("mixed exports preserve the assigned edit session for every slide", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "carouselbot-video-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const companion = createCompanion(async (action, args) => {
    if (action === "browser" && args.operation.type === "editor.inspect") return { project: { id: "project", slides: [{ id: "still", index: 0 }, { id: "video", index: 1 }] } };
    if (action === "browser" && args.operation.type === "slide.export") return { filename: args.operation.slideId === "video" ? "clip.mp4" : "still.png", data: "eA==" };
    if (action === "write_export") return { path: args.path };
    return {};
  });
  await withHarness(companion, async ({ callTool }) => {
    await callTool("get_design_guidance");
    const result = await callTool("export_project", { projectId: "project", editSessionId: "session", outputDirectory: directory, overwrite: true });
    assert.equal(result.isError, undefined);
    const browserCalls = companion.calls.filter(call => call.action === "browser");
    assert.equal(browserCalls.length, 3);
    for (const call of browserCalls) assert.equal(call.args.editSessionId, "session");
    const writes = companion.calls.filter(call => call.action === "write_export");
    assert.ok(writes[0].args.path.endsWith("01-still.png"));
    assert.ok(writes[1].args.path.endsWith("02-clip.mp4"));
  });
});
