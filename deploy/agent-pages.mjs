export const siteOrigin = "https://carousel.bot";

export const pages = new Map([
  ["/", { markdownPath: "/index.md" }],
]);

// Real non-public routes (see deploy/_redirects): robots.txt disallows them.
export const privatePaths = ["/api", "/projects", "/folders", "/share"];
// Static files the Function never handles, even for .md URLs.
export const staticPaths = ["/assets", "/src", "/.well-known"];
