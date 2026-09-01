import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, extname, join } from "node:path";
import * as fontkit from "fontkit";

const INDEX_VERSION = 1;
const CURSOR_VERSION = 1;
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const MAX_FONT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_FONT_BYTES = 128 * 1024 * 1024;
const MAX_DISCOVERED_FILES = 20_000;
const MAX_COLLECTION_FACES = 512;
const MAX_SFNT_TABLES = 4_096;
const PUBLIC_FONT_KEYS = [
  "localFontId",
  "family",
  "fullName",
  "postscriptName",
  "subfamily",
  "weight",
  "italic",
  "lastUsedAt",
  "variableAxes",
];
const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".woff", ".woff2"]);
const STYLE_WEIGHTS = [
  [/\b(?:thin|hairline)\b/i, 100],
  [/\b(?:extra[ -]?light|ultra[ -]?light)\b/i, 200],
  [/\blight\b/i, 300],
  [/\b(?:medium)\b/i, 500],
  [/\b(?:semi[ -]?bold|demi[ -]?bold)\b/i, 600],
  [/\b(?:extra[ -]?bold|ultra[ -]?bold)\b/i, 800],
  [/\b(?:black|heavy)\b/i, 900],
  [/\bbold\b/i, 700],
];
const STYLE_ORDER = [
  /\bregular\b/i,
  /\bbook\b/i,
  /\bmedium\b/i,
  /\b(?:semi[ -]?bold|demi[ -]?bold)\b/i,
  /\bbold\b/i,
];

export function defaultMacFontDirectories() {
  if (platform() !== "darwin") return [];
  return [
    join(homedir(), "Library", "Fonts"),
    "/Library/Fonts",
    "/System/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
  ];
}

function codedError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

function sha256(value, encoding = "hex") {
  return createHash("sha256").update(value).digest(encoding);
}

function usageGenerationFor(usage) {
  return sha256(JSON.stringify([...usage.entries()].sort(([left], [right]) => left.localeCompare(right))), "base64url").slice(0, 24);
}

function stableFontId(pathInternal, faceIndex, size, mtimeMs) {
  const identity = `${pathInternal}\0${faceIndex}\0${size}\0${mtimeMs}`;
  return `font_${sha256(identity, "base64url").slice(0, 24)}`;
}

function cleanString(value, fallback = "") {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return normalized || fallback;
}

function inferredWeight(font, subfamily) {
  const os2Weight = Number(font?.["OS/2"]?.usWeightClass);
  if (Number.isFinite(os2Weight) && os2Weight >= 1 && os2Weight <= 1_000) return Math.round(os2Weight);
  const variationWeight = Number(font?.variationAxes?.wght?.default);
  if (Number.isFinite(variationWeight) && variationWeight >= 1 && variationWeight <= 1_000) return Math.round(variationWeight);
  const match = STYLE_WEIGHTS.find(([pattern]) => pattern.test(subfamily));
  return match?.[1] || 400;
}

function variableAxes(font) {
  return Object.entries(font?.variationAxes || {}).flatMap(([rawTag, value]) => {
    const tag = cleanString(rawTag).slice(0, 4);
    const min = Number(value?.min);
    const max = Number(value?.max);
    const defaultValue = Number(value?.default);
    if (!/^[\x20-\x7e]{4}$/.test(tag) || ![min, max, defaultValue].every(Number.isFinite) || min > max) return [];
    return [{
      tag,
      name: cleanString(value?.name, tag),
      min,
      max,
      default: Math.min(max, Math.max(min, defaultValue)),
    }];
  }).sort((left, right) => left.tag.localeCompare(right.tag, "en"));
}

function metadataForFont(font, source, faceIndex) {
  const postscriptName = cleanString(font?.postscriptName);
  const fullName = cleanString(font?.fullName, postscriptName);
  const family = cleanString(font?.familyName, fullName || postscriptName || "Unknown font");
  const subfamily = cleanString(font?.subfamilyName, "Regular");
  const fsSelection = font?.["OS/2"]?.fsSelection || {};
  const italic = Boolean(fsSelection.italic || fsSelection.oblique || Number(font?.italicAngle));
  const localFontId = stableFontId(source.pathInternal, faceIndex, source.size, source.mtimeMs);
  return {
    localFontId,
    family,
    fullName: fullName || family,
    postscriptName: postscriptName || fullName || family,
    sourcePostscriptName: postscriptName || null,
    subfamily,
    weight: inferredWeight(font, subfamily),
    italic,
    variableAxes: variableAxes(font),
    pathInternal: source.pathInternal,
    faceIndex,
    size: source.size,
    mtimeMs: source.mtimeMs,
    fileFingerprint: source.fileFingerprint,
    fingerprint: sha256(`${source.fileFingerprint}\0${faceIndex}\0${postscriptName}`),
    extension: source.extension,
  };
}

function publicFont(font, usage) {
  const value = {
    localFontId: font.localFontId,
    family: font.family,
    fullName: font.fullName,
    postscriptName: font.postscriptName,
    subfamily: font.subfamily,
    weight: font.weight,
    italic: Boolean(font.italic),
    lastUsedAt: usage.get(font.localFontId) || null,
    variableAxes: Array.isArray(font.variableAxes) ? font.variableAxes.map((axis) => ({ ...axis })) : [],
  };
  return Object.fromEntries(PUBLIC_FONT_KEYS.map((key) => [key, value[key]]));
}

function styleRank(font) {
  const style = `${font.subfamily} ${font.italic ? "Italic" : ""}`;
  const base = STYLE_ORDER.findIndex((pattern) => pattern.test(style));
  return (font.italic ? 100 : 0) + (base < 0 ? 5 : base);
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function alphabetical(left, right) {
  return collator.compare(left.family, right.family)
    || styleRank(left) - styleRank(right)
    || collator.compare(left.subfamily, right.subfamily)
    || collator.compare(left.fullName, right.fullName)
    || left.localFontId.localeCompare(right.localFontId);
}

function normalizedQuery(value) {
  return cleanString(value).normalize("NFKC").toLocaleLowerCase("en-US").slice(0, 240);
}

function cursorValue(value) {
  try {
    if (typeof value !== "string" || !value || value.length > 2_048) throw new Error("invalid");
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (decoded?.v !== CURSOR_VERSION || !Number.isInteger(decoded.offset) || decoded.offset < 0) throw new Error("invalid");
    return decoded;
  } catch {
    throw codedError("INVALID_FONT_CURSOR", "The local-font cursor is invalid or expired. Start listing again without a cursor.");
  }
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...value })).toString("base64url");
}

async function readJson(path) {
  if (!path) return null;
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return null; }
}

async function writePrivateJson(path, value) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => {});
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function fontPaths(directories) {
  const roots = [];
  for (const candidate of directories) {
    try { roots.push(await realpath(candidate)); }
    catch { /* Missing font roots are normal. */ }
  }
  roots.sort();
  const discovered = new Map();
  const pending = [...new Set(roots)];
  while (pending.length) {
    const directory = pending.shift();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      let canonical;
      let metadata;
      try {
        canonical = await realpath(path);
        metadata = await stat(canonical);
      } catch { continue; }
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_FONT_FILE_BYTES) continue;
      discovered.set(canonical, {
        pathInternal: canonical,
        size: metadata.size,
        mtimeMs: Number(metadata.mtimeMs),
        extension: extname(canonical).toLowerCase(),
      });
      if (discovered.size > MAX_DISCOVERED_FILES) {
        throw codedError("FONT_INDEX_TOO_LARGE", "Too many local font files were found to index safely.");
      }
    }
  }
  return [...discovered.values()].sort((left, right) => left.pathInternal.localeCompare(right.pathInternal));
}

async function readFileSafely(pathInternal) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(pathInternal, flags);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_FONT_FILE_BYTES) {
      throw codedError("FONT_UNAVAILABLE", "The selected local font is unavailable or too large.");
    }
    return { buffer: await handle.readFile(), metadata };
  } finally {
    await handle.close();
  }
}

function mimeTypeFor(buffer, extension = "") {
  const signature = buffer.subarray(0, 4).toString("latin1");
  if (signature === "wOF2") return "font/woff2";
  if (signature === "wOFF") return "font/woff";
  if (signature === "OTTO") return "font/otf";
  if (["\u0000\u0001\u0000\u0000", "true", "typ1"].includes(signature)) return "font/ttf";
  if (extension === ".woff2") return "font/woff2";
  if (extension === ".woff") return "font/woff";
  if (extension === ".otf") return "font/otf";
  return "font/ttf";
}

function checksum(buffer) {
  let sum = 0;
  for (let offset = 0; offset < buffer.length; offset += 4) {
    let word = 0;
    for (let index = 0; index < 4; index += 1) word = ((word << 8) | (buffer[offset + index] || 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

function checkedRange(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw codedError("INVALID_FONT_COLLECTION", `The selected collection has an invalid ${label}.`);
  }
}

function align4(value) {
  return Math.ceil(value / 4) * 4;
}

/** Repack one TTC/OTC face as a standalone, browser-loadable SFNT font. */
export function extractTtcFace(value, faceIndex) {
  const source = Buffer.isBuffer(value) ? value : Buffer.from(value);
  checkedRange(source, 0, 12, "header");
  if (source.subarray(0, 4).toString("ascii") !== "ttcf") {
    throw codedError("INVALID_FONT_COLLECTION", "The selected font is not a TrueType/OpenType collection.");
  }
  const faceCount = source.readUInt32BE(8);
  if (!faceCount || faceCount > MAX_COLLECTION_FACES) throw codedError("INVALID_FONT_COLLECTION", "The collection has an invalid face count.");
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= faceCount) {
    throw codedError("FONT_FACE_NOT_FOUND", `Font face ${faceIndex} does not exist in this collection.`);
  }
  checkedRange(source, 12, faceCount * 4, "face directory");
  const faceOffset = source.readUInt32BE(12 + faceIndex * 4);
  checkedRange(source, faceOffset, 12, "face header");
  const sfntVersion = source.subarray(faceOffset, faceOffset + 4);
  const signature = sfntVersion.toString("latin1");
  if (!["\u0000\u0001\u0000\u0000", "true", "typ1", "OTTO"].includes(signature)) {
    throw codedError("INVALID_FONT_COLLECTION", "The selected collection face is not an SFNT font.");
  }
  const tableCount = source.readUInt16BE(faceOffset + 4);
  if (!tableCount || tableCount > MAX_SFNT_TABLES) throw codedError("INVALID_FONT_COLLECTION", "The collection face has an invalid table count.");
  checkedRange(source, faceOffset + 12, tableCount * 16, "table directory");
  const records = [];
  const tags = new Set();
  for (let index = 0; index < tableCount; index += 1) {
    const recordOffset = faceOffset + 12 + index * 16;
    const tagBytes = source.subarray(recordOffset, recordOffset + 4);
    const tag = tagBytes.toString("latin1");
    const offset = source.readUInt32BE(recordOffset + 8);
    const length = source.readUInt32BE(recordOffset + 12);
    checkedRange(source, offset, length, `table ${JSON.stringify(tag)}`);
    if (tags.has(tag)) throw codedError("INVALID_FONT_COLLECTION", "The collection face contains duplicate table tags.");
    tags.add(tag);
    if (tag !== "DSIG") records.push({ tag, tagBytes: Buffer.from(tagBytes), offset, length });
  }
  const head = records.find((record) => record.tag === "head");
  if (!head || head.length < 12) throw codedError("INVALID_FONT_COLLECTION", "The collection face has no valid head table.");

  let outputLength = 12 + records.length * 16;
  for (const record of records) {
    outputLength = align4(outputLength);
    record.outputOffset = outputLength;
    outputLength += align4(record.length);
    if (outputLength > MAX_EXTRACTED_FONT_BYTES) throw codedError("FONT_TOO_LARGE", "The selected font face is too large to transfer safely.");
  }
  const output = Buffer.alloc(outputLength);
  sfntVersion.copy(output, 0);
  output.writeUInt16BE(records.length, 4);
  const highestPowerOfTwo = 2 ** Math.floor(Math.log2(records.length));
  output.writeUInt16BE(highestPowerOfTwo * 16, 6);
  output.writeUInt16BE(Math.log2(highestPowerOfTwo), 8);
  output.writeUInt16BE(records.length * 16 - highestPowerOfTwo * 16, 10);

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    source.copy(output, record.outputOffset, record.offset, record.offset + record.length);
    if (record.tag === "head") output.writeUInt32BE(0, record.outputOffset + 8);
    const directoryOffset = 12 + index * 16;
    record.tagBytes.copy(output, directoryOffset);
    output.writeUInt32BE(checksum(output.subarray(record.outputOffset, record.outputOffset + record.length)), directoryOffset + 4);
    output.writeUInt32BE(record.outputOffset, directoryOffset + 8);
    output.writeUInt32BE(record.length, directoryOffset + 12);
  }
  const adjustment = (0xb1b0afba - checksum(output)) >>> 0;
  output.writeUInt32BE(adjustment, head.outputOffset + 8);
  if (checksum(output) !== 0xb1b0afba) throw codedError("INVALID_FONT_COLLECTION", "The extracted font checksum could not be repaired.");
  return output;
}

function safeFilename(font, mimeType) {
  const extension = mimeType === "font/woff2" ? ".woff2" : mimeType === "font/woff" ? ".woff" : mimeType === "font/otf" ? ".otf" : ".ttf";
  const stem = cleanString(font.postscriptName || font.fullName || "local-font", "local-font")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "local-font";
  return `${stem}${extension}`;
}

export function createLocalFontService({
  directories = defaultMacFontDirectories(),
  cacheDirectory = null,
  cachePath = cacheDirectory ? join(cacheDirectory, "local-font-index-v1.json") : null,
  usagePath = cacheDirectory ? join(cacheDirectory, "local-font-usage-v1.json") : null,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  now = () => Date.now(),
} = {}) {
  let records = new Map();
  let files = [];
  let generation = "empty";
  let initialized = false;
  let lastRefreshAt = -Infinity;
  let refreshPromise = null;
  let usagePromise = null;
  let usage = new Map();
  let usageGeneration = usageGenerationFor(usage);
  let usageWrite = Promise.resolve();

  async function loadUsage() {
    if (usagePromise) return usagePromise;
    usagePromise = (async () => {
      const cached = await readJson(usagePath);
      usage = new Map(Object.entries(cached?.usage || {}).flatMap(([id, timestamp]) => (
        /^font_[A-Za-z0-9_-]{8,}$/.test(id) && Number.isFinite(Number(timestamp)) && Number(timestamp) > 0
          ? [[id, Number(timestamp)]]
          : []
      )));
      usageGeneration = usageGenerationFor(usage);
      return usage;
    })();
    return usagePromise;
  }

  async function buildIndex() {
    const candidates = await fontPaths(directories);
    const cached = await readJson(cachePath);
    const cachedFiles = new Map((cached?.version === INDEX_VERSION && Array.isArray(cached.files) ? cached.files : [])
      .map((file) => [file.pathInternal, file]));
    const nextFiles = [];
    const seenFingerprints = new Set();
    const nextRecords = new Map();
    for (const candidate of candidates) {
      const previous = cachedFiles.get(candidate.pathInternal);
      let indexed;
      if (previous && previous.size === candidate.size && previous.mtimeMs === candidate.mtimeMs && previous.extension === candidate.extension) {
        indexed = previous;
      } else {
        try {
          const { buffer } = await readFileSafely(candidate.pathInternal);
          const fileFingerprint = sha256(buffer);
          const parsed = fontkit.create(buffer);
          const parsedFaces = Array.isArray(parsed?.fonts) ? parsed.fonts : [parsed];
          if (!parsedFaces.length || parsedFaces.length > MAX_COLLECTION_FACES) throw new Error("Invalid face count");
          const source = { ...candidate, fileFingerprint };
          indexed = {
            ...candidate,
            fileFingerprint,
            faces: parsedFaces.map((font, faceIndex) => metadataForFont(font, source, faceIndex)),
          };
        } catch {
          indexed = { ...candidate, fileFingerprint: null, faces: [], invalid: true };
        }
      }
      nextFiles.push(indexed);
      if (!indexed.fileFingerprint || seenFingerprints.has(indexed.fileFingerprint)) continue;
      seenFingerprints.add(indexed.fileFingerprint);
      for (const face of indexed.faces || []) nextRecords.set(face.localFontId, face);
    }
    files = nextFiles;
    records = nextRecords;
    generation = sha256([...records.keys()].sort().join("\0"), "base64url").slice(0, 24);
    lastRefreshAt = now();
    initialized = true;
    await writePrivateJson(cachePath, { version: INDEX_VERSION, generatedAt: lastRefreshAt, files });
    return records;
  }

  async function refresh({ force = false } = {}) {
    if (!force && initialized && now() - lastRefreshAt < refreshIntervalMs) return records;
    if (!refreshPromise) refreshPromise = buildIndex().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function list({ query = "", limit = 50, cursor = null, sort = "recent_then_alphabetical" } = {}) {
    await Promise.all([refresh(), loadUsage()]);
    const safeQuery = normalizedQuery(query);
    const safeSort = sort === "alphabetical" ? "alphabetical" : "recent_then_alphabetical";
    const safeLimit = Math.max(1, Math.min(200, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 50));
    let offset = 0;
    if (cursor) {
      const decoded = cursorValue(cursor);
      if (
        decoded.generation !== generation
        || decoded.query !== safeQuery
        || decoded.sort !== safeSort
        || (safeSort === "recent_then_alphabetical" && decoded.usageGeneration !== usageGeneration)
      ) {
        throw codedError("INVALID_FONT_CURSOR", "The local-font cursor is invalid or expired. Start listing again without a cursor.");
      }
      offset = decoded.offset;
    }
    let matches = [...records.values()].filter((font) => {
      if (!safeQuery) return true;
      return [font.family, font.fullName, font.postscriptName, font.subfamily]
        .some((value) => normalizedQuery(value).includes(safeQuery));
    });
    if (safeSort === "alphabetical") matches.sort(alphabetical);
    else {
      const recent = matches
        .filter((font) => usage.has(font.localFontId))
        .sort((left, right) => usage.get(right.localFontId) - usage.get(left.localFontId) || alphabetical(left, right))
        .slice(0, 8);
      const recentIds = new Set(recent.map((font) => font.localFontId));
      matches = [...recent, ...matches.filter((font) => !recentIds.has(font.localFontId)).sort(alphabetical)];
    }
    const page = matches.slice(offset, offset + safeLimit);
    const nextOffset = offset + page.length;
    return {
      fonts: page.map((font) => publicFont(font, usage)),
      nextCursor: nextOffset < matches.length
        ? encodeCursor({
          generation,
          query: safeQuery,
          sort: safeSort,
          offset: nextOffset,
          ...(safeSort === "recent_then_alphabetical" ? { usageGeneration } : {}),
        })
        : null,
    };
  }

  async function resolve(localFontId) {
    await Promise.all([refresh(), loadUsage()]);
    const font = records.get(String(localFontId || ""));
    return font ? { ...font, lastUsedAt: usage.get(font.localFontId) || null } : null;
  }

  async function readFace(localFontId) {
    let font = await resolve(localFontId);
    if (!font) return null;
    let read;
    try { read = await readFileSafely(font.pathInternal); }
    catch {
      await refresh({ force: true });
      throw codedError("FONT_UNAVAILABLE", `${font.fullName} is not available on this device.`);
    }
    const currentMtime = Number(read.metadata.mtimeMs);
    const currentFingerprint = sha256(read.buffer);
    if (read.metadata.size !== font.size || currentMtime !== font.mtimeMs || currentFingerprint !== font.fileFingerprint) {
      await refresh({ force: true });
      throw codedError("FONT_UNAVAILABLE", `${font.fullName} changed on this device. List local fonts again and use its new ID.`);
    }
    let buffer = read.buffer;
    if (buffer.subarray(0, 4).toString("ascii") === "ttcf") buffer = extractTtcFace(buffer, font.faceIndex);
    const mimeType = mimeTypeFor(buffer, font.extension);
    try {
      const parsed = fontkit.create(buffer);
      if (Array.isArray(parsed?.fonts) || (font.sourcePostscriptName && cleanString(parsed?.postscriptName) !== font.sourcePostscriptName)) {
        throw new Error("Extracted face mismatch");
      }
    } catch {
      throw codedError("FONT_UNAVAILABLE", `${font.fullName} could not be prepared for the browser.`);
    }
    return {
      font: publicFont(font, usage),
      buffer,
      mimeType,
      filename: safeFilename(font, mimeType),
    };
  }

  async function markUsed(localFontId, at = now()) {
    await Promise.all([refresh(), loadUsage()]);
    const font = records.get(String(localFontId || ""));
    if (!font) return null;
    const timestamp = Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : now();
    usage.set(font.localFontId, timestamp);
    usageGeneration = usageGenerationFor(usage);
    usageWrite = usageWrite.then(() => writePrivateJson(usagePath, {
      version: INDEX_VERSION,
      usage: Object.fromEntries([...usage.entries()].sort(([left], [right]) => left.localeCompare(right))),
    }));
    await usageWrite;
    return publicFont(font, usage);
  }

  return { list, resolve, readFace, markUsed, refresh };
}
