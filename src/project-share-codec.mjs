import { validateSharedProject } from "./project-share-schema.mjs";

export const SHARE_FORMAT_VERSION = 1;
export const SHARE_TTL_SECONDS = 24 * 60 * 60;
export const MAX_SHARE_BYTES = 8 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
export const SHARED_FOLDER_PATH = "/Shared";

function fail(message) {
  throw new Error(message);
}

async function readLimited(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        fail("This shared project is too large to open.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function encodeSharedProject(project) {
  try { project = validateSharedProject(project); }
  catch { fail("This project cannot be shared yet. Check its media and layers."); }
  const bytes = new TextEncoder().encode(JSON.stringify({ version: SHARE_FORMAT_VERSION, project }));
  if (bytes.byteLength > MAX_UNCOMPRESSED_BYTES) {
    fail("This project is too large to share. Try removing unused assets or videos.");
  }
  const compressed = typeof CompressionStream === "function";
  const payload = compressed
    ? await readLimited(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")), MAX_SHARE_BYTES)
    : bytes;
  if (payload.byteLength > MAX_SHARE_BYTES) {
    fail("This project is too large to share. Try removing unused assets or videos.");
  }
  return { payload, format: compressed ? "gzip-json-v1" : "json-v1" };
}

export async function decodeSharedProject(payload, format) {
  const input = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (input.byteLength > MAX_SHARE_BYTES) fail("This shared project is too large to open.");
  let bytes;
  if (format === "gzip-json-v1") {
    if (typeof DecompressionStream !== "function") fail("This browser cannot open compressed shares.");
    bytes = await readLimited(new Blob([input]).stream().pipeThrough(new DecompressionStream("gzip")), MAX_UNCOMPRESSED_BYTES);
  } else if (format === "json-v1") {
    bytes = input;
  } else fail("This share uses an unsupported format.");
  let data;
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("This shared project is damaged."); }
  if (data?.version !== SHARE_FORMAT_VERSION) {
    fail("This share is not a valid CarouselBot project.");
  }
  try { return validateSharedProject(data.project); }
  catch { fail("This share is not a valid CarouselBot project."); }
}
