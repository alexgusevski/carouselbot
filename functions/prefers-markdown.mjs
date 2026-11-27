// Returns true when the client prefers Markdown over HTML.
export function prefersMarkdown(accept) {
  if (!accept) return false;
  let md = -1, html = -1;
  for (const part of accept.split(',')) {
    const [type, ...params] = part.trim().toLowerCase().split(';').map(s => s.trim());
    let q = 1;
    for (const p of params) if (p.startsWith('q=')) { const n = Number(p.slice(2)); q = Number.isFinite(n) ? n : 0; }
    if (type === 'text/markdown' || type === 'text/x-markdown') md = Math.max(md, q);
    else if (type === 'text/html' || type === 'application/xhtml+xml') html = Math.max(html, q);
  }
  return md > 0 && md >= html;
}
