export const DAY_MS = 86_400_000;
export const SHARE_LIMITS = Object.freeze({
  upload: { count: 400, bytes: 400 * 1024 * 1024, clientCount: 20, clientBytes: 64 * 1024 * 1024 },
  read: { count: 10_000, bytes: 0, clientCount: 300, clientBytes: 0 },
});
const keys = new WeakMap();
const encoder = new TextEncoder();

export function reply(status, message) {
  return Response.json({ error: message }, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    ...(status === 429 ? { "Retry-After": "3600" } : {}),
  } });
}
export function shareAccess(request, env) {
  const url = new URL(request.url);
  if (url.origin !== "https://carousel.bot") return reply(403, "Sharing is only available on carousel.bot.");
  if (env.SHARING_ENABLED !== "true" || !env.SHARES || !env.SHARE_BUDGETS || !env.TURNSTILE_SECRET_KEY) {
    return reply(503, "Sharing is temporarily unavailable.");
  }
  return null;
}
async function signingKey(env) {
  let key = keys.get(env.SHARE_BUDGETS);
  if (!key) {
    const row = await env.SHARE_BUDGETS.prepare("SELECT value FROM share_settings WHERE name = 'signing_key'").first();
    if (!/^[0-9a-f]{64}$/.test(row?.value)) throw new Error("Share signing key is unavailable.");
    key = await crypto.subtle.importKey("raw", encoder.encode(row.value), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(env.SHARE_BUDGETS, key);
  }
  return key;
}
export async function signShareId(id, env) {
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), encoder.encode(`share:${id}`)));
  return `${id}.${Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function verifyShareId(id, env) {
  if (!/^[0-9a-z]{8}-[0-9a-f]{32}\.[0-9a-f]{64}$/.test(id)) return false;
  const [value, signature] = id.split(".");
  const bytes = Uint8Array.from(signature.match(/../g), (hex) => parseInt(hex, 16));
  return crypto.subtle.verify("HMAC", await signingKey(env), bytes, encoder.encode(`share:${value}`));
}
export async function reserveShareBudget(request, env, kind, bytes = 0, now = Date.now()) {
  const limits = SHARE_LIMITS[kind];
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return false; // Do not accept caller-supplied forwarded IP headers.
  const window = Math.floor(now / DAY_MS);
  const hash = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), encoder.encode(`client:${window}:${ip}`)));
  const client = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const reserve = (scope, count, size) => env.SHARE_BUDGETS.prepare(`
    INSERT INTO share_budgets (scope, window, count, bytes, max_count, max_bytes)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(scope, window) DO UPDATE SET count = count + 1, bytes = bytes + excluded.bytes
  `).bind(`${kind}:${scope}`, window, bytes, count, size);
  try {
    await env.SHARE_BUDGETS.batch([
      reserve("global", limits.count, limits.bytes),
      reserve(client, limits.clientCount, limits.clientBytes),
      env.SHARE_BUDGETS.prepare("DELETE FROM share_budgets WHERE window < ?").bind(window - 1),
    ]);
    return true;
  } catch (error) {
    if (String(error.message).includes("share_budget_exceeded")) return false;
    throw error; // Infrastructure failures must fail closed, never skip limits.
  }
}
export async function verifyUpload(request, env) {
  const token = request.headers.get("X-CarouselBot-Turnstile");
  if (!token || token.length > 2048) return false;
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: request.headers.get("CF-Connecting-IP") }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true && result.hostname === "carousel.bot" && result.action === "share";
}
