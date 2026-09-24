import { MAX_SHARE_BYTES, SHARE_TTL_SECONDS } from "../../../src/project-share-codec.mjs";

function reply(status, message) {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function readUpload(stream) {
  if (!stream) return null;
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SHARE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function onRequestPost({ request, env }) {
  if (!env.SHARES) return reply(503, "Sharing is not available yet.");
  const url = new URL(request.url);
  // pages.dev does not pass through carousel.bot's zone-level WAF rate limit.
  if (!["carousel.bot", "localhost", "127.0.0.1"].includes(url.hostname)) {
    return reply(403, "Sharing is only available on carousel.bot.");
  }
  if (request.headers.get("Origin") !== url.origin) {
    return reply(403, "This share request must come from CarouselBot.");
  }
  const format = request.headers.get("X-CarouselBot-Share-Format");
  if (!["gzip-json-v1", "json-v1"].includes(format)
    || request.headers.get("Content-Type")?.split(";")[0] !== "application/octet-stream") {
    return reply(415, "Unsupported share format.");
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (declaredLength > MAX_SHARE_BYTES) return reply(413, "This project is too large to share.");
  let payload;
  try { payload = await readUpload(request.body); }
  catch { return reply(400, "Could not read this project."); }
  if (!payload?.byteLength) return reply(413, "This project is empty or too large to share.");

  const createdAt = Date.now();
  const id = `${createdAt.toString(36)}-${crypto.randomUUID().replaceAll("-", "")}`;
  const expiresAt = createdAt + SHARE_TTL_SECONDS * 1000;
  try {
    await env.SHARES.put(`share:${id}`, payload, {
      expirationTtl: SHARE_TTL_SECONDS,
      metadata: { format, expiresAt },
    });
  } catch (error) {
    console.error("Could not store shared project", error);
    return reply(503, "Free sharing capacity is unavailable right now. Please try again later.");
  }
  return Response.json({ id, expiresAt }, {
    status: 201,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
