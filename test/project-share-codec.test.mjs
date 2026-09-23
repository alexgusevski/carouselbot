import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeSharedProject,
  encodeSharedProject,
  MAX_SHARE_BYTES,
  SHARED_FOLDER_PATH,
} from "../src/project-share-codec.mjs";
import { duplicateProjectData } from "../src/editor-model.mjs";

const imageData = `data:image/png;base64,${"a".repeat(100_000)}`;
const project = {
  id: "source", name: "Editable photo story", slides: [{
    id: "slide", name: "Cover", imageData, width: 1080, height: 1920,
    texts: [{ id: "text", text: "Hello", fontId: "font" }],
    overlays: [{ id: "overlay", assetId: "asset", x: 0.1, y: 0.2, width: 0.3 }],
  }],
  assets: [{ id: "asset", name: "Photo", imageData, width: 100, height: 100 }],
  fonts: [{ id: "font", family: "Sample", variableAxes: [] }],
};

test("encodes a project with embedded media and imports an independent copy", async () => {
  const { payload, format } = await encodeSharedProject(project);
  assert.ok(payload.byteLength < MAX_SHARE_BYTES);
  const decoded = await decodeSharedProject(payload, format);
  assert.deepEqual(decoded, project);
  const imported = duplicateProjectData(decoded, { name: decoded.name, folderPath: SHARED_FOLDER_PATH });
  assert.equal(imported.folderPath, "/Shared");
  assert.equal(imported.name, project.name);
  assert.notEqual(imported.id, project.id);
  assert.notEqual(imported.slides[0].id, project.slides[0].id);
  assert.equal(imported.slides[0].overlays[0].assetId, imported.assets[0].id);
  assert.equal(imported.slides[0].texts[0].fontId, imported.fonts[0].id);
  imported.slides[0].texts[0].text = "Changed";
  assert.equal(project.slides[0].texts[0].text, "Hello");
});

test("rejects unsupported and malformed share data", async () => {
  await assert.rejects(decodeSharedProject(new Uint8Array([1, 2, 3]), "new-format"), /unsupported format/);
  await assert.rejects(decodeSharedProject(new TextEncoder().encode("{}"), "json-v1"), /not a valid CarouselBot project/);
  await assert.rejects(encodeSharedProject({ id: "bad", name: "bad", slides: [{}], assets: [] }), /cannot be shared/);
});
