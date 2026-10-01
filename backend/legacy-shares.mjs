// Keep existing published share links usable while the product runs in a separate preview.
// The upstream continues to enforce its own quotas, signatures and Turnstile hostname.
export async function legacyShares(request, env) {
  const current = new URL(request.url);
  const upstream = env.LEGACY_SHARES_ORIGIN || 'https://carousel.bot';
  if (upstream !== 'https://carousel.bot' || current.origin === upstream) return Response.json({ error: 'Sharing is temporarily unavailable.' }, { status: 503 });
  const validPath = /^\/api\/shares(?:\/(?:config|[0-9a-z]{8}-[0-9a-f]{32}\.[0-9a-f]{64}))?$/.test(current.pathname);
  if (!validPath || !['GET', 'POST'].includes(request.method) || request.method === 'POST' && current.pathname !== '/api/shares') return new Response('Not found', { status: 404 });
  if (request.method === 'POST' && request.headers.get('origin') !== env.APP_ORIGIN) return Response.json({ error: 'Origin is not permitted.' }, { status: 403 });
  const headers = new Headers();
  for (const name of ['content-type', 'content-length', 'x-carouselbot-share-format', 'x-carouselbot-share-bytes', 'x-carouselbot-turnstile', 'cf-connecting-ip']) {
    const value = request.headers.get(name); if (value) headers.set(name, value);
  }
  if (request.method === 'POST') headers.set('origin', upstream);
  try {
    return await fetch(`${upstream}${current.pathname}`, { method: request.method, headers, body: request.method === 'POST' ? request.body : undefined, redirect: 'error' });
  } catch { return Response.json({ error: 'Sharing is temporarily unavailable.' }, { status: 503 }); }
}
