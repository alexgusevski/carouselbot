import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequest } from "../functions/_middleware.js";
import { prefersMarkdown } from "../functions/prefers-markdown.mjs";

const cases = [
  ["text/markdown, text/html, */*", true],
  ["text/markdown,text/html;q=0.9,application/xhtml+xml;q=0.8,*/*;q=0.5", true],
  ["text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1", true],
  ["text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", false],
  ["*/*", false],
  ["text/plain", false],
  ["", false],
  [undefined, false],
  ["text/markdown;q=0", false],
  ["text/html, text/markdown;q=0.5", false],
  [" TEXT/X-MARKDOWN ; Q=0.8 , APPLICATION/XHTML+XML;q=0.7 ", true],
  ["text/markdown;q=invalid,text/html;q=0", false],
];

test("Accept selects Markdown using media types and q-values", () => {
  for (const [accept, expected] of cases) assert.equal(prefersMarkdown(accept), expected, accept);
});

const html = "<!doctype html><title>CarouselBot</title>";
const markdown = "---\ntitle: \"CarouselBot\"\nurl: \"https://carousel.bot/\"\n---\n\n# Example\n";
const markdownType = "text/markdown; charset=utf-8";
const security = { "X-Content-Type-Options": "nosniff" };

function request(path, accept = "text/markdown", { method = "GET", assetStatus = 200, assetType = markdownType } = {}) {
  const incoming = new Request("https://carousel.bot" + path, { method, headers: { Accept: accept } });
  return onRequest({
    request: incoming,
    env: {
      ASSETS: {
        fetch(asset) {
          assert.equal(new URL(asset.url).pathname, "/index.md");
          assert.equal(asset.method, method);
          return new Response(method === "HEAD" ? null : assetType === markdownType ? markdown : html, {
            status: assetStatus, headers: { ...security, "Content-Type": assetType, ETag: '"markdown"' },
          });
        },
      },
    },
    next: () => new Response(method === "HEAD" ? null : html, {
      headers: { ...security, "Content-Type": "text/html", Link: "</existing>; rel=preload", Vary: "Accept-Encoding" },
    }),
  });
}

test("HTML and Markdown on the same URL retain their bodies and advertise negotiation", async () => {
  for (const accept of ["text/html", "text/markdown", "text/markdown", "text/html"]) {
    const response = await request("/", accept);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.match(response.headers.get("Vary"), /\bAccept\b/i);
    if (accept === "text/html") {
      assert.equal(await response.text(), html);
      assert.match(response.headers.get("Vary"), /Accept-Encoding/);
      assert.match(response.headers.get("Link"), /rel=preload/);
      assert.match(response.headers.get("Link"), /<https:\/\/carousel\.bot\/index\.md>; rel="alternate"; type="text\/markdown"/);
      assert.match(response.headers.get("Link"), /<\/llms\.txt>; rel="describedby"; type="text\/plain"/);
    } else {
      assert.equal(await response.text(), markdown);
      assert.equal(response.headers.get("Content-Type"), markdownType);
      assert.equal(response.headers.get("Link"), '<https://carousel.bot/>; rel="canonical"');
      assert.equal(response.headers.get("X-Robots-Tag"), "noindex");
      assert.equal(response.headers.get("Content-Signal"), "search=yes, ai-input=yes, ai-train=yes");
      assert.equal(response.headers.get("Cache-Control"), "private, max-age=0");
      assert.equal(response.headers.get("ETag"), null);
    }
  }
});

test("explicit Markdown ignores Accept and redirects index-file aliases", async () => {
  assert.equal(await (await request("/index.md", "text/html")).text(), markdown);
  for (const path of ["/index.html.md", "/index/index.md"]) {
    const redirect = await request(path + "?source=test", "text/html");
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("Location"), "/index.md?source=test");
  }
});

test("HEAD keeps GET headers and status without a body", async () => {
  for (const [path, accept] of [["/", "text/html"], ["/", "text/markdown"], ["/index.md", "*/*"], ["/missing.md", "*/*"]]) {
    const get = await request(path, accept);
    const head = await request(path, accept, { method: "HEAD" });
    assert.equal(head.status, get.status);
    assert.deepEqual([...head.headers], [...get.headers]);
    assert.equal(await head.text(), "");
  }
});

test("missing files fall back to HTML only on a negotiated page URL", async () => {
  for (const overrides of [{ assetStatus: 404 }, { assetType: "text/html" }]) {
    const negotiated = await request("/", "text/markdown", overrides);
    assert.equal(negotiated.status, 200);
    assert.equal(await negotiated.text(), html);
    const explicit = await request("/index.md", "text/html", overrides);
    assert.equal(explicit.status, 404);
    assert.equal(explicit.headers.get("Content-Type"), markdownType);
  }
  const missing = await request("/foo/bar/index.md");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("ETag"), null);
  assert.match(await missing.text(), /\[site index\]\(\/llms\.txt\).*\[home page\]\(\/\)/);
});

test("requests outside the public page surface pass through unchanged", async () => {
  for (const path of [
    "/pricing", "/app.js", "/styles.css", "/assets/image.png", "/src/main.mjs", "/sitemap.xml",
    "/robots.txt", "/llms.txt", "/llms-full.txt", "/download.json", "/download.csv",
    "/api/items", "/auth/login", "/checkout", "/projects/local", "/folders/local", "/dashboard",
    "/.well-known/search", "/assets/readme.md",
  ]) {
    const response = new Response("original response");
    const incoming = new Request("https://carousel.bot" + path, { headers: { Accept: "text/markdown" } });
    assert.equal(await onRequest({ request: incoming, next: () => response }), response, path);
  }
});

test(".md URLs on private app routes get the Markdown 404, not the SPA shell", async () => {
  for (const path of ["/projects/x.md", "/folders/x.md", "/share/x.md", "/api/docs.md"]) {
    const response = await request(path, "text/html");
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("Content-Type"), markdownType, path);
    assert.doesNotMatch(await response.text(), /<!doctype/i, path);
  }
});
