import { MAX_SHARE_BYTES, SHARE_TTL_SECONDS, decodeSharedProject } from "../../../src/project-share-codec.mjs";
import { reply, shareAccess, signShareId, reserveShareBudget, verifyUpload } from "../../_lib/share-security.js";

async function readUpload(stream, limit) {
  if (!stream) return null;
  const reader = stream.getReader();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 30_000);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  if (timedOut) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function onRequestPost({ request, env }) {
  const denied = shareAccess(request, env);
  if (denied) return denied;
  if (request.headers.get("Origin") !== new URL(request.url).origin) return reply(403, "This share request must come from CarouselBot.");
  const format = request.headers.get("X-CarouselBot-Share-Format");
  if (!["gzip-json-v1", "json-v1"].includes(format)
    || request.headers.get("Content-Type")?.split(";")[0] !== "application/octet-stream") return reply(415, "Unsupported share format.");
  // Reserve the declared size before buffering. The reader enforces that exact
  // reservation even when HTTP Content-Length is missing or dishonest.
  const size = Number(request.headers.get("X-CarouselBot-Share-Bytes"));
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SHARE_BYTES) return reply(413, "This project is empty or too large to share (8 MB maximum).");
  try {
    if (!await verifyUpload(request, env)) return reply(403, "Please verify the share request and try again.");
    const createdAt = Date.now();
    if (!await reserveShareBudget(request, env, "upload", size, createdAt)) return reply(429, "Free sharing capacity is temporarily full. Please try again later.");
    const payload = await readUpload(request.body, size);
    if (!payload || payload.byteLength !== size) return reply(413, "The project size does not match its upload reservation.");
    try { await decodeSharedProject(payload, format); }
    catch { return reply(400, "This is not a valid CarouselBot project."); }
    const id = await signShareId(`${createdAt.toString(36)}-${crypto.randomUUID().replaceAll("-", "")}`, env);
    const expiresAt = createdAt + SHARE_TTL_SECONDS * 1000;
    await env.SHARES.put(`share:${id}`, payload, { expiration: Math.floor(expiresAt / 1000), metadata: { format, expiresAt } });
    return Response.json({ id, expiresAt }, { status: 201, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return reply(503, "Sharing is temporarily unavailable. Please try again later.");
  }
}
