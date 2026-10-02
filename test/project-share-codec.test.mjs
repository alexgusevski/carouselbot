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

test("rejects HTML attributes, invalid encodings, non-finite geometry, and excessive complexity", async () => {
  const invalid = [];
  for (const [target, field, value] of [
    ["asset", "imageData", 'data:image/png;base64,AA==\" /><a id="injected">Forged UI</a>'],
    ["asset", "videoData", 'data:video/mp4;base64,AA==\" onload="alert(1)'],
    ["slide", "imageData", 'data:image/svg+xml,%GG'],
    ["text", "style", '\"/><a>Forged</a>'],
    ["text", "background", 'white\" autofocus'],
    ["text", "rotation", '0);position:fixed'],
    ["text", "size", 1e100],
    ["text", "text", 'x'.repeat(10001)],
    ["overlay", "width", 0],
  ]) {
    const candidate = structuredClone(project);
    const item = { asset: candidate.assets[0], slide: candidate.slides[0], text: candidate.slides[0].texts[0], overlay: candidate.slides[0].overlays[0] }[target];
    item[field] = value;
    invalid.push(candidate);
  }
  const oversized = structuredClone(project);
  oversized.slides[0].texts = Array.from({ length: 101 }, (_, i) => ({ id: `text-${i}` }));
  invalid.push(oversized);
  for (const candidate of invalid) {
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, project: candidate }));
    await assert.rejects(decodeSharedProject(bytes, "json-v1"), /not a valid/);
    await assert.rejects(encodeSharedProject(candidate), /cannot be shared/);
  }
});

test("reconstructs known fields and preserves real SVG backgrounds, video and fonts", async () => {
  const candidate = structuredClone(project);
  candidate.unknown = { html: '<script>bad</script>' };
  candidate.slides[0].imageData = 'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
  candidate.assets[0].videoData = 'data:video/mp4;base64,AAAA';
  candidate.fonts[0].fontData = 'data:font/ttf;base64,AAAA';
  candidate.slides[0].texts[0].fontVariationSettings = { wght: 450 };
  const { payload, format } = await encodeSharedProject(candidate);
  const decoded = await decodeSharedProject(payload, format);
  assert.equal(decoded.unknown, undefined);
  delete candidate.unknown;
  assert.deepEqual(decoded, candidate);
});

test("bounds decompression even for a tiny gzip payload", async () => {
  const bomb = new Blob([' '.repeat(17 * 1024 * 1024)]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = await new Response(bomb).arrayBuffer();
  await assert.rejects(decodeSharedProject(bytes, 'gzip-json-v1'), /too large/);
});
