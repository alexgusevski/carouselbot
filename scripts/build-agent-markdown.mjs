import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pages, privatePaths, siteOrigin, staticPaths } from "../deploy/agent-pages.mjs";
import { homeCopy } from "../src/home-copy.mjs";

const pageBodies = new Map([
  ["/", `# ${homeCopy.heading} *${homeCopy.emphasis}*\n\n${homeCopy.eyebrow}\n\n${homeCopy.intro}`],
]);
const instructions = "Use this search API to find relevant content across this site with keywords or natural-language queries, instead of crawling individual pages. Results are returned in Markdown.";
const discovery = 'Every page is also available as Markdown: request it with `Accept: text/markdown` or add `.md` to the URL.';
const bots = [
  "Googlebot", "Bingbot", "OAI-SearchBot", "ChatGPT-User", "GPTBot", "ClaudeBot",
  "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Google-Extended",
  "Applebot", "Applebot-Extended", "CCBot", "Meta-ExternalAgent", "Amazonbot",
  "DuckAssistBot", "MistralAI-User",
];

function meta(html, name) {
  // Match the attribute order used by the site's HTML templates.
  return html.match(new RegExp(`<meta\\s+(?:name|property)="${name}"\\s+content="([^"]*)"`, "i"))?.[1];
}

export async function buildAgentMarkdown(output) {
  const sitemap = await readFile(join(output, "sitemap.xml"), "utf8");
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, url]) => url);
  assert.deepEqual([...urls].sort(), [...pages.keys()].map((path) => siteOrigin + path).sort(),
    "Register the public copy and Markdown path for each sitemap page");

  const entries = [];
  for (const url of urls) {
    const path = new URL(url).pathname;
    const html = (await readFile(join(output, path, "index.html"), "utf8")).replace(/\r\n?/g, "\n");
    const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || meta(html, "og:title");
    const description = meta(html, "description") || meta(html, "og:description");
    const image = meta(html, "og:image");
    const body = pageBodies.get(path);
    assert.ok(title && description && body, `Missing public page copy for ${url}`);
    const fields = { title, description, image: image && new URL(image, url).href, url };
    const frontMatter = Object.entries(fields).filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
    const jsonLd = [...html.matchAll(/<script\b[^>]*\btype="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(([, source]) => `\n\n\`\`\`json\n${source}${source.endsWith("\n") ? "" : "\n"}\`\`\``).join("");
    const markdown = `---
agent:
  instructions: ${JSON.stringify(instructions)}
  endpoint: "${siteOrigin}/.well-known/search?q={query}"
  method: "GET"
  documentation: "https://developers.cloudflare.com/ai-search/how-to/search-for-agents/"
${frontMatter}
---

> Site index for agents: ${siteOrigin}/llms.txt

${body}${jsonLd}
`;
    const file = join(output, pages.get(path).markdownPath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, markdown);
    const written = await readFile(file, "utf8");
    assert.ok(written.startsWith("---\n"), `Missing front matter for ${url}`);
    const yaml = written.split("\n---\n", 1)[0];
    assert.match(yaml, /^title: ".+"$/m);
    assert.match(yaml, /^url: ".+"$/m);
    assert.doesNotMatch(written, /<(?:script|nav|style|html)\b/i);
    entries.push({ url, title, description, markdown });
  }

  const home = entries.find(({ url }) => url === siteOrigin + "/");
  await writeFile(join(output, "llms.txt"), `# ${home.title}

> ${home.description}

${homeCopy.intro}

## Pages

${entries.map(({ url, title, description }) => `- [${title}](${url}): ${description}`).join("\n")}

${discovery}
`);
  await writeFile(join(output, "llms-full.txt"), entries.map(({ markdown }) => markdown).join("\n"));
  const group = `Allow: /
${privatePaths.flatMap((path) => [`Disallow: ${path}/`, `Disallow: ${path}$`]).join("\n")}
Content-Signal: search=yes, ai-input=yes, ai-train=yes`;
  await writeFile(join(output, "robots.txt"), `User-agent: *
${group}

${bots.map((bot) => `User-agent: ${bot}`).join("\n")}
${group}

# Agents: start at ${siteOrigin}/llms.txt
Sitemap: ${siteOrigin}/sitemap.xml
`);
  const include = [...pages.keys()].flatMap((path) => path === "/" ? [path] : [path, path + "/"]);
  const exclude = staticPaths.map((path) => path + "/*");
  await writeFile(join(output, "_routes.json"), JSON.stringify({ version: 1, include: [...include, "/*.md"], exclude }, null, 2) + "\n");
}
