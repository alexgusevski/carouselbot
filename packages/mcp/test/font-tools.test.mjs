import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createCarouselBotMcpServer } from "../src/mcp-server.mjs";

const PUBLIC_LOCAL_FONT = {
  localFontId: "local-didot-regular",
  family: "Didot",
  fullName: "Didot",
  postscriptName: "Didot",
  subfamily: "Regular",
  weight: 400,
  italic: false,
  lastUsedAt: 0,
  variableAxes: [],
};

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

test("publishes local and project font tools with strict agent-facing schemas", async () => {
  const companion = createCompanion();
  await withHarness(companion, async ({ request }) => {
    const listed = await request("tools/list");
    const { tools } = listed.result;
    const localFonts = toolByName(tools, "list_local_fonts");
    const projectFonts = toolByName(tools, "list_project_fonts");
    const importFont = toolByName(tools, "import_font");
    const addText = toolByName(tools, "add_text");
    const updateText = toolByName(tools, "update_text");
    const applyOperations = toolByName(tools, "apply_operations");

    assert.deepEqual(localFonts.annotations, { openWorldHint: false, readOnlyHint: true });
    assert.deepEqual(projectFonts.annotations, { openWorldHint: false, readOnlyHint: true });
    assert.deepEqual(importFont.annotations, { openWorldHint: false, destructiveHint: false });
    assert.match(localFonts.description, /never filesystem paths/i);

    assert.deepEqual(localFonts.inputSchema.properties.sort.enum, ["recent_then_alphabetical", "alphabetical"]);
    assert.equal(localFonts.inputSchema.properties.limit.minimum, 1);
    assert.equal(localFonts.inputSchema.properties.limit.maximum, 200);
    assert.equal(localFonts.inputSchema.properties.cursor.maxLength, 2048);
    assert.deepEqual(importFont.inputSchema.required.sort(), ["localFontId", "projectId"]);
    assert.equal(Object.hasOwn(importFont.inputSchema.properties, "path"), false);

    const addTextProperties = addText.inputSchema.properties;
    assert.ok(addTextProperties.fontId.anyOf.some((schema) => schema.type === "null"));
    assert.equal(addTextProperties.fontWeight.minimum, 1);
    assert.equal(addTextProperties.fontWeight.maximum, 1000);
    assert.deepEqual(addTextProperties.fontStyle.enum, ["normal", "italic"]);
    assert.equal(addTextProperties.fontVariationSettings.additionalProperties.type, "number");
    assert.match(addTextProperties.fontVariationSettings.description, /Only wght currently has guaranteed/);

    const updateItem = updateText.inputSchema.properties.updates.items;
    assert.ok(updateItem.properties.fontId);
    assert.ok(updateItem.properties.fontVariationSettings);
    const batchToolEnum = applyOperations.inputSchema.properties.operations.items.properties.tool.enum;
    assert.ok(batchToolEnum.includes("import_font"));
  });
});

test("list_local_fonts applies bounded defaults, rejects private inputs, and returns a public DTO", async () => {
  const companion = createCompanion(async (action) => {
    assert.equal(action, "list_local_fonts");
    return { fonts: [PUBLIC_LOCAL_FONT], nextCursor: null };
  });

  await withHarness(companion, async ({ callTool }) => {
    const result = await callTool("list_local_fonts");
    assert.deepEqual(result.structuredContent, { fonts: [PUBLIC_LOCAL_FONT], nextCursor: null });
    assert.doesNotMatch(JSON.stringify(result), /pathInternal|fileFingerprint|faceIndex|fontData|\/System\/Library\/Fonts/);
    assert.deepEqual(
      companion.calls.find((call) => call.action === "list_local_fonts")?.args,
      { limit: 80, sort: "recent_then_alphabetical" },
    );

    const maximumCursor = "A".repeat(2048);
    const withMaximumCursor = await callTool("list_local_fonts", { cursor: maximumCursor });
    assert.equal(withMaximumCursor.isError, undefined);
    assert.equal(companion.calls.findLast((call) => call.action === "list_local_fonts")?.args.cursor, maximumCursor);

    const beforeOversized = companion.calls.length;
    const oversized = await callTool("list_local_fonts", { cursor: `${maximumCursor}A` });
    assert.equal(oversized.isError, true);
    assert.equal(companion.calls.length, beforeOversized, "oversized cursors must not reach the companion");

    const beforeInvalid = companion.calls.length;
    const invalid = await callTool("list_local_fonts", { path: "/System/Library/Fonts/Didot.ttc" });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /unrecognized key|invalid/i);
    assert.equal(companion.calls.length, beforeInvalid, "invalid public input must not reach the companion");
  });
});

test("list_project_fonts uses the read-only browser operation and keeps stored font bytes private", async () => {
  const publicProjectFont = {
    id: "project-font-1",
    source: "local",
    localFontId: PUBLIC_LOCAL_FONT.localFontId,
    family: "Didot",
    fullName: "Didot",
    postscriptName: "Didot",
    subfamily: "Regular",
    weight: 400,
    italic: false,
    cssFamily: "carousel-font-project-font-1",
    variableAxes: [],
    addedAt: 1_788_126_972_333,
    available: true,
  };
  const companion = createCompanion(async (action, args) => {
    assert.equal(action, "browser");
    assert.deepEqual(args, {
      toolName: "list_project_fonts",
      operation: { type: "font.list", projectId: "project-1" },
      label: "Editing in CarouselBot…",
      editSessionId: "session-1",
      mutating: false,
    });
    return { projectId: "project-1", revision: 4, fonts: [publicProjectFont] };
  });

  await withHarness(companion, async ({ callTool }) => {
    const result = await callTool("list_project_fonts", {
      editSessionId: "session-1",
      projectId: "project-1",
    });
    assert.deepEqual(result.structuredContent, {
      projectId: "project-1",
      revision: 4,
      fonts: [publicProjectFont],
    });
    assert.doesNotMatch(JSON.stringify(result), /fontData|data:font|pathInternal|fontMediaId|\/System\/Library\/Fonts/);
  });
});

test("import_font prepares the exact local face with the edit session and exposes only the public mutation result", async () => {
  const prepared = {
    font: PUBLIC_LOCAL_FONT,
    fontMediaId: "font-media-secret",
  };
  const companion = createCompanion(async (action, args) => {
    if (action === "prepare_font") return prepared;
    if (action === "browser") {
      assert.deepEqual(args, {
        toolName: "import_font",
        operation: {
          type: "font.import",
          projectId: "project-1",
          localFontId: PUBLIC_LOCAL_FONT.localFontId,
          font: PUBLIC_LOCAL_FONT,
          fontMediaId: "font-media-secret",
        },
        label: "Adding a local font…",
        editSessionId: "session-1",
        mutating: true,
      });
      return {
        projectId: "project-1",
        fontId: "project-font-1",
        localFontId: PUBLIC_LOCAL_FONT.localFontId,
        family: "Didot",
        subfamily: "Regular",
        weight: 400,
        italic: false,
        existing: false,
        revision: 42,
      };
    }
    return {};
  });

  await withHarness(companion, async ({ callTool }) => {
    await callTool("get_design_guidance");
    const result = await callTool("import_font", {
      editSessionId: "session-1",
      projectId: "project-1",
      localFontId: PUBLIC_LOCAL_FONT.localFontId,
    });

    assert.deepEqual(
      companion.calls.find((call) => call.action === "prepare_font")?.args,
      { localFontId: PUBLIC_LOCAL_FONT.localFontId, editSessionId: "session-1" },
    );
    assert.equal(result.structuredContent.fontId, "project-font-1");
    assert.equal(result.structuredContent.revision, 42);
    assert.doesNotMatch(JSON.stringify(result), /font-media-secret|fontData|pathInternal|\/System\/Library\/Fonts/);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      projectId: "project-1",
      revision: 42,
      fontId: "project-font-1",
      localFontId: PUBLIC_LOCAL_FONT.localFontId,
      existing: false,
    });
  });
});

test("font text fields validate before dispatch and preserve deterministic IDs and variable axes", async () => {
  const companion = createCompanion(async (action, args) => action === "browser"
    ? { projectId: args.operation.projectId, createdTextId: "text-1", revision: 1 }
    : {});

  await withHarness(companion, async ({ callTool }) => {
    await callTool("get_design_guidance");
    const valid = await callTool("add_text", {
      editSessionId: "session-1",
      projectId: "project-1",
      slideId: "slide-1",
      text: "speed limit",
      fontId: "project-font-1",
      fontWeight: 725,
      fontStyle: "italic",
      fontVariationSettings: { wght: 725, wdth: 90 },
    });
    assert.equal(valid.isError, undefined);
    const browserCall = companion.calls.find((call) => call.action === "browser");
    assert.deepEqual(browserCall.args.operation, {
      type: "text.add",
      projectId: "project-1",
      slideId: "slide-1",
      text: "speed limit",
      fontId: "project-font-1",
      fontWeight: 725,
      fontStyle: "italic",
      fontVariationSettings: { wght: 725, wdth: 90 },
    });
    assert.equal(browserCall.args.editSessionId, "session-1");

    for (const invalidFields of [
      { fontId: "" },
      { fontWeight: 0 },
      { fontWeight: 1001 },
      { fontStyle: "oblique" },
      { fontVariationSettings: { weight: 700 } },
    ]) {
      const browserCallsBefore = companion.calls.filter((call) => call.action === "browser").length;
      const invalid = await callTool("add_text", {
        projectId: "project-1",
        slideId: "slide-1",
        text: "invalid font",
        ...invalidFields,
      });
      assert.equal(invalid.isError, true, JSON.stringify(invalidFields));
      assert.equal(
        companion.calls.filter((call) => call.action === "browser").length,
        browserCallsBefore,
        `invalid fields reached browser: ${JSON.stringify(invalidFields)}`,
      );
    }
  });
});

test("apply_operations prepares imported fonts against the outer edit session", async () => {
  const companion = createCompanion(async (action) => {
    if (action === "prepare_font") return { font: PUBLIC_LOCAL_FONT, fontMediaId: "batch-font-media" };
    if (action === "batch") return { applied: 2, projectId: "project-1", revision: 7 };
    return {};
  });

  await withHarness(companion, async ({ callTool }) => {
    await callTool("get_design_guidance");
    const result = await callTool("apply_operations", {
      editSessionId: "outer-session",
      operations: [
        {
          tool: "import_font",
          arguments: {
            editSessionId: "inner-session-must-not-win",
            projectId: "project-1",
            localFontId: PUBLIC_LOCAL_FONT.localFontId,
          },
        },
        {
          tool: "add_text",
          arguments: {
            projectId: "project-1",
            slideId: "slide-1",
            text: "speed limit",
            fontId: "already-imported-project-font",
          },
        },
      ],
    });

    assert.deepEqual(
      companion.calls.find((call) => call.action === "prepare_font")?.args,
      { localFontId: PUBLIC_LOCAL_FONT.localFontId, editSessionId: "outer-session" },
    );
    const batch = companion.calls.find((call) => call.action === "batch");
    assert.equal(batch.args.editSessionId, "outer-session");
    assert.deepEqual(batch.args.items[0].operation, {
      type: "font.import",
      projectId: "project-1",
      localFontId: PUBLIC_LOCAL_FONT.localFontId,
      font: PUBLIC_LOCAL_FONT,
      fontMediaId: "batch-font-media",
    });
    assert.deepEqual(batch.args.items[1].operation, {
      type: "text.add",
      projectId: "project-1",
      slideId: "slide-1",
      text: "speed limit",
      fontId: "already-imported-project-font",
    });
    assert.equal(result.structuredContent.applied, 2);
  });
});
