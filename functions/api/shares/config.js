import { reply, shareAccess } from "../../_lib/share-security.js";

export function onRequestGet({ request, env }) {
  const denied = shareAccess(request, env);
  if (denied) return denied;
  if (!env.TURNSTILE_SITE_KEY) return reply(503, "Sharing is temporarily unavailable.");
  return Response.json({ siteKey: env.TURNSTILE_SITE_KEY }, { headers: { "Cache-Control": "no-store" } });
}
