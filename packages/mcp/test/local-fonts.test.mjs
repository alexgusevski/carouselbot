import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fontkit from "fontkit";
import { createLocalFontService, extractTtcFace } from "../src/local-fonts.mjs";

const root = new URL("../../..", import.meta.url);
const tikTokSansPath = new URL("assets/TikTokSans.ttf", root).pathname;
const didotPath = "/System/Library/Fonts/Supplemental/Didot.ttc";

function align4(value) {
  return (value + 3) & ~3;
}

function standaloneFontsToTtc(fonts) {
  const headerLength = align4(12 + fonts.length * 4);
  const offsets = [];
  let length = headerLength;
  for (const font of fonts) {
    offsets.push(length);
    length = align4(length + font.length);
  }
  const collection = Buffer.alloc(length);
  collection.write("ttcf", 0, "ascii");
  collection.writeUInt32BE(0x00020000, 4);
  collection.writeUInt32BE(fonts.length, 8);
  fonts.forEach((font, faceIndex) => {
    const faceOffset = offsets[faceIndex];
    collection.writeUInt32BE(faceOffset, 12 + faceIndex * 4);
    font.copy(collection, faceOffset);
    const tableCount = font.readUInt16BE(4);
    for (let index = 0; index < tableCount; index += 1) {
      const tableRecord = faceOffset + 12 + index * 16;
      collection.writeUInt32BE(font.readUInt32BE(12 + index * 16 + 8) + faceOffset, tableRecord + 8);
    }
  });
  return collection;
}

function sfntChecksum(buffer) {
  let sum = 0;
  for (let offset = 0; offset < buffer.length; offset += 4) {
    let word = 0;
    for (let index = 0; index < 4; index += 1) word = ((word << 8) | (buffer[offset + index] || 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

test("extracts a bounds-checked standalone SFNT face from a TTC", async () => {
  const standalone = await readFile(tikTokSansPath);
  const collection = standaloneFontsToTtc([standalone, standalone]);
  const extracted = extractTtcFace(collection, 1);
  assert.notEqual(extracted.subarray(0, 4).toString("ascii"), "ttcf");
  assert.equal(sfntChecksum(extracted), 0xb1b0afba);
  const parsed = fontkit.create(extracted);
  assert.equal(parsed.postscriptName, fontkit.create(standalone).postscriptName);
  assert.throws(() => extractTtcFace(collection, 2), /FONT_FACE_NOT_FOUND/);
  const invalid = Buffer.from(collection);
  invalid.writeUInt32BE(invalid.length + 4, 16);
  assert.throws(() => extractTtcFace(invalid, 1), /INVALID_FONT_COLLECTION/);
  assert.throws(() => extractTtcFace(standalone, 0), /INVALID_FONT_COLLECTION/);
});

test("indexes, caches, searches, paginates, resolves, transfers, and sorts local fonts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "carouselbot-local-fonts-"));
  const cacheDirectory = join(directory, "cache");
  const fontDirectory = join(directory, "fonts");
  await mkdir(fontDirectory);
  const firstPath = join(fontDirectory, "a-tiktok-sans.ttf");
  const duplicatePath = join(fontDirectory, "b-duplicate.ttf");
  const collectionPath = join(fontDirectory, "collection.ttc");
  try {
    const standalone = await readFile(tikTokSansPath);
    await Promise.all([
      copyFile(tikTokSansPath, firstPath),
      copyFile(tikTokSansPath, duplicatePath),
      writeFile(collectionPath, standaloneFontsToTtc([standalone, standalone])),
      writeFile(join(fontDirectory, "not-a-font.otf"), "not a font"),
    ]);
    const service = createLocalFontService({ directories: [fontDirectory], cacheDirectory, refreshIntervalMs: Infinity });
    const alphabetical = await service.list({ query: "tiktok sans", limit: 20, sort: "alphabetical" });
    assert.equal(alphabetical.fonts.length, 3, "identical standalone files should be de-duplicated while TTC faces remain distinct");
    assert.equal(alphabetical.nextCursor, null);
    assert.ok(alphabetical.fonts.every((font) => font.localFontId.startsWith("font_")));
    assert.ok(alphabetical.fonts.every((font) => font.lastUsedAt === null));
    assert.ok(alphabetical.fonts.some((font) => font.variableAxes.some((axis) => axis.tag === "wght")));
    const serialized = JSON.stringify(alphabetical);
    assert.doesNotMatch(serialized, /carouselbot-local-fonts|a-tiktok-sans|\/fonts\//);
    assert.deepEqual(Object.keys(alphabetical.fonts[0]), [
      "localFontId", "family", "fullName", "postscriptName", "subfamily", "weight", "italic", "lastUsedAt", "variableAxes",
    ]);

    const firstPage = await service.list({ limit: 1, sort: "alphabetical" });
    assert.equal(firstPage.fonts.length, 1);
    assert.ok(firstPage.nextCursor);
    const secondPage = await service.list({ limit: 1, cursor: firstPage.nextCursor, sort: "alphabetical" });
    assert.equal(secondPage.fonts.length, 1);
    assert.notEqual(secondPage.fonts[0].localFontId, firstPage.fonts[0].localFontId);
    await assert.rejects(service.list({ cursor: "not-a-cursor" }), /INVALID_FONT_CURSOR/);
    const recentBeforeUsage = await service.list({ limit: 1, sort: "recent_then_alphabetical" });
    assert.ok(recentBeforeUsage.nextCursor);

    const collectionFont = await Promise.all(alphabetical.fonts.map((font) => service.resolve(font.localFontId)))
      .then((fonts) => fonts.find((font) => font.extension === ".ttc" && font.faceIndex === 1));
    assert.ok(collectionFont?.pathInternal.endsWith("collection.ttc"));
    const prepared = await service.readFace(collectionFont.localFontId);
    assert.equal(prepared.font.localFontId, collectionFont.localFontId);
    assert.equal(prepared.mimeType, "font/ttf");
    assert.match(prepared.filename, /\.ttf$/);
    assert.notEqual(prepared.buffer.subarray(0, 4).toString("ascii"), "ttcf");
    assert.equal(fontkit.create(prepared.buffer).postscriptName, collectionFont.postscriptName);

    const usedAt = 1_788_126_972_333;
    await service.markUsed(alphabetical.fonts.at(-1).localFontId, usedAt);
    await assert.rejects(
      service.list({ limit: 1, cursor: recentBeforeUsage.nextCursor, sort: "recent_then_alphabetical" }),
      /INVALID_FONT_CURSOR/,
      "recent cursors must expire when usage changes their ordering snapshot",
    );
    const alphabeticalAfterUsage = await service.list({ limit: 1, cursor: firstPage.nextCursor, sort: "alphabetical" });
    assert.equal(alphabeticalAfterUsage.fonts[0].localFontId, secondPage.fonts[0].localFontId, "usage changes must not expire alphabetical cursors");
    const recent = await service.list({ limit: 20, sort: "recent_then_alphabetical" });
    assert.equal(recent.fonts[0].localFontId, alphabetical.fonts.at(-1).localFontId);
    assert.equal(recent.fonts[0].lastUsedAt, usedAt);
    const persistedRecentPage = await service.list({ limit: 1, sort: "recent_then_alphabetical" });
    assert.ok(persistedRecentPage.nextCursor);

    const cachedService = createLocalFontService({ directories: [fontDirectory], cacheDirectory, refreshIntervalMs: Infinity });
    const cached = await cachedService.list({ query: "TikTok", limit: 20, sort: "alphabetical" });
    assert.deepEqual(cached.fonts.map((font) => font.localFontId), alphabetical.fonts.map((font) => font.localFontId));
    assert.equal((await cachedService.list({ limit: 20 })).fonts[0].lastUsedAt, usedAt);
    const resumedRecentPage = await cachedService.list({ limit: 1, cursor: persistedRecentPage.nextCursor, sort: "recent_then_alphabetical" });
    assert.equal(resumedRecentPage.fonts.length, 1, "persisted usage snapshots should keep valid cursors resumable after restart");
    assert.ok(existsSync(join(cacheDirectory, "local-font-index-v1.json")));
    assert.ok(existsSync(join(cacheDirectory, "local-font-usage-v1.json")));

    const beforeIds = new Set(alphabetical.fonts.map((font) => font.localFontId));
    const changedTime = new Date(Date.now() + 10_000);
    await utimes(firstPath, changedTime, changedTime);
    await service.refresh({ force: true });
    const changed = await service.list({ query: "TikTok", limit: 20, sort: "alphabetical" });
    assert.ok(changed.fonts.some((font) => !beforeIds.has(font.localFontId)), "changing font metadata should rotate its opaque ID");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("indexes and extracts every Didot TTC face on macOS", { skip: !existsSync(didotPath) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "carouselbot-didot-"));
  const fontDirectory = join(directory, "fonts");
  await mkdir(fontDirectory);
  await copyFile(didotPath, join(fontDirectory, "Didot.ttc"));
  try {
    const service = createLocalFontService({ directories: [fontDirectory], cacheDirectory: join(directory, "cache"), refreshIntervalMs: Infinity });
    const { fonts } = await service.list({ query: "Didot", limit: 20, sort: "alphabetical" });
    assert.equal(fonts.length, 3);
    assert.deepEqual(fonts.map((font) => font.subfamily), ["Regular", "Bold", "Italic"]);
    assert.deepEqual(new Set(fonts.map((font) => font.subfamily)), new Set(["Regular", "Italic", "Bold"]));
    assert.deepEqual(new Set(fonts.map((font) => font.weight)), new Set([400, 700]));
    for (const font of fonts) {
      const prepared = await service.readFace(font.localFontId);
      assert.equal(prepared.mimeType, "font/ttf");
      assert.equal(fontkit.create(prepared.buffer).postscriptName, font.postscriptName);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
