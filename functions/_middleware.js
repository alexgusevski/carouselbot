import { pages, siteOrigin, staticPaths } from "../deploy/agent-pages.mjs";
import { prefersMarkdown } from "./prefers-markdown.mjs";

const markdownType = "text/markdown; charset=utf-8";
const contentSignal = "search=yes, ai-input=yes, ai-train=yes";
const notFound = "# Page not found\n\nSee the [site index](/llms.txt) or return to the [home page](/).\n";

function addVaryAccept(headers) {
  const vary = headers.get("Vary")?.toLowerCase().split(",").map((value) => value.trim());
  if (!vary?.includes("accept") && !vary?.includes("*")) headers.append("Vary", "Accept");
}

function setMarkdownHeaders(headers) {
  headers.set("Content-Type", markdownType);
  headers.set("X-Robots-Tag", "noindex");
  headers.set("Content-Signal", contentSignal);
}

export async function onRequest({ request, next, env }) {
  const url = new URL(request.url);
  const { pathname } = url;
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const explicit = pathname.endsWith(".md");
  const pagePath = explicit
    ? pathname.replace(/(?:\/index)?\.md$/, "").replace(/\/$/, "") || "/"
    : pathname.replace(/\/$/, "") || "/";
  // Pages redirects its index-file URLs to the directory URL.
  const redirectPath = explicit && ["/index", "/index.html"].includes(pagePath)
    ? pages.get("/").markdownPath : null;
  const page = pages.get(pagePath);
  // Every other .md URL (private app routes included) gets the Markdown 404, never the SPA shell.
  if (!page && (!explicit || staticPaths.some(
    (prefix) => pagePath === prefix || pagePath.startsWith(prefix + "/"),
  ))) return next();

  const head = request.method === "HEAD";
  if (page && (explicit || prefersMarkdown(request.headers.get("Accept")))) {
    const asset = new URL(page.markdownPath, url);
    const response = await env.ASSETS.fetch(new Request(asset, { method: request.method }));
    // Check the media type too, since a Pages fallback can return a 200 HTML shell.
    if (response.status === 200 && /^text\/markdown(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) {
      const markdown = new Response(head ? null : response.body, response);
      setMarkdownHeaders(markdown.headers);
      addVaryAccept(markdown.headers);
      markdown.headers.append("Link", `<${siteOrigin}${pagePath}>; rel="canonical"`);
      if (!explicit) {
        markdown.headers.set("Cache-Control", "private, max-age=0");
        markdown.headers.delete("ETag");
        markdown.headers.delete("Last-Modified");
      }
      return markdown;
    }
    await response.body?.cancel();
  }

  const response = await next();
  if (explicit) {
    await response.body?.cancel();
    const headers = new Headers();
    for (const name of ["Content-Security-Policy", "Permissions-Policy", "Referrer-Policy", "X-Content-Type-Options"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (redirectPath) {
      headers.set("Location", redirectPath + url.search);
      return new Response(null, { status: 301, headers });
    }
    setMarkdownHeaders(headers);
    headers.set("Content-Length", String(new TextEncoder().encode(notFound).byteLength));
    return new Response(head ? null : notFound, { status: 404, headers });
  }

  const html = new Response(head ? null : response.body, response);
  addVaryAccept(html.headers);
  html.headers.append("Link", `<${siteOrigin}${page.markdownPath}>; rel="alternate"; type="text/markdown"`);
  if (pagePath === "/") html.headers.append("Link", '</llms.txt>; rel="describedby"; type="text/plain"');
  return html;
}
