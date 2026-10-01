import { onRequestGet as shareConfig } from '../functions/api/shares/config.js';
import { onRequestPost as uploadShare } from '../functions/api/shares/index.js';
import { onRequestGet as readShare } from '../functions/api/shares/[id].js';

// Production reuses the exact Pages handlers, storage, signing key and quota checks.
// Nothing is proxied when the Worker serves carousel.bot itself.
export async function directShares(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/api/shares/config' && request.method === 'GET') return shareConfig({ request, env });
  if (path === '/api/shares' && request.method === 'POST') return uploadShare({ request, env });
  const match = /^\/api\/shares\/([0-9a-z]{8}-[0-9a-f]{32}\.[0-9a-f]{64})$/.exec(path);
  if (match && request.method === 'GET') return readShare({ request, env, params: { id: match[1] } });
  return Response.json({ error: 'Share route not found.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
