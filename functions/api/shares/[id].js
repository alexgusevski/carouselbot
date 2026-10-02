import { MAX_SHARE_BYTES, SHARE_TTL_SECONDS } from "../../../src/project-share-codec.mjs";

import { reply, shareAccess, verifyShareId, reserveShareBudget } from "../../_lib/share-security.js";

export async function onRequestGet({ request, env, params }) {
  const denied = shareAccess(request, env);
  if (denied) return denied;
  const id = params.id;
  if (typeof id !== "string" || !/^[0-9a-z]{8}-[0-9a-f]{32}\.[0-9a-f]{64}$/.test(id)) {
    return reply(404, "This share link is invalid or has expired.");
  }
  const createdAt = parseInt(id.split("-", 1)[0], 36);
  if (!Number.isSafeInteger(createdAt) || createdAt > Date.now() + 60_000) {
    return reply(404, "This share link is invalid or has expired.");
  }
  if (Date.now() >= createdAt + SHARE_TTL_SECONDS * 1000) {
    return reply(410, "This share link has expired.");
  }
  let result;
  try {
    if (!await verifyShareId(id, env)) return reply(404, "This share link is invalid or has expired.");
    if (!await reserveShareBudget(request, env, "read")) return reply(429, "Free sharing capacity is temporarily full. Please try again later.");
    result = await env.SHARES.getWithMetadata(`share:${id}`, "arrayBuffer");
  }
  catch (error) {
    console.error("Could not load shared project", error);
    return reply(503, "Sharing is temporarily unavailable. Please try again later.");
  }
  if (!result.value || !result.metadata) {
    return reply(Date.now() - createdAt < 90_000 ? 425 : 404,
      Date.now() - createdAt < 90_000 ? "This share is still becoming available. Please retry." : "This share link is invalid or has expired.");
  }
  if (Number(result.metadata.expiresAt) <= Date.now()) {
    return reply(410, "This share link has expired.");
  }
  if (result.value.byteLength > MAX_SHARE_BYTES
    || !["gzip-json-v1", "json-v1"].includes(result.metadata.format)) {
    return reply(404, "This share link is invalid or has expired.");
  }
  return new Response(result.value, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(result.value.byteLength),
      "X-CarouselBot-Share-Format": result.metadata.format,
      "X-CarouselBot-Expires-At": String(result.metadata.expiresAt),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
