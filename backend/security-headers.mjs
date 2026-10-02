// Clerk's UI injects styles; scripts remain restricted to the configured FAPI.
// https://clerk.com/docs/guides/secure/best-practices/csp-headers
export function productHeaders(env) {
  let clerkOrigin = "";
  try {
    const host = atob(String(env.CLERK_PUBLISHABLE_KEY || "").split("_")[2]).replace(/\$$/, "");
    if (/^[a-z0-9.-]+$/i.test(host)) clerkOrigin = `https://${host}`;
  } catch { /* An unconfigured deployment keeps the local editor policy. */ }
  const auth = Boolean(clerkOrigin);
  const policy = [
    "default-src 'self'",
    `img-src 'self' data: blob:${auth ? " https://img.clerk.com" : ""}`,
    "media-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    `script-src 'self' https://challenges.cloudflare.com${auth ? ` ${clerkOrigin} https://*.protect.clerk.com` : ""}`,
    `style-src 'self'${auth ? " 'unsafe-inline'" : ""}`,
    "style-src-attr 'unsafe-inline'",
    `frame-src https://challenges.cloudflare.com${auth ? " https://*.protect.clerk.com" : ""}`,
    `connect-src 'self' http://127.0.0.1:43117 https://challenges.cloudflare.com${auth ? ` ${clerkOrigin} https://*.protect.clerk.com:*` : ""}`,
    "worker-src 'self' blob:",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
  ].join("; ");
  return {
    "Content-Security-Policy": policy,
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}
