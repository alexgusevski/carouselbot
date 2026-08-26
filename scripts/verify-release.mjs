import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tag = process.argv[2];
if (!tag) throw new Error("Usage: node scripts/verify-release.mjs <vVERSION>");

const paths = [
  join(root, "packages", "mcp", "package.json"),
  join(root, "packages", "slides-studio-mcp", "package.json"),
];
const packages = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
const versions = new Set(packages.map((manifest) => manifest.version));

if (versions.size !== 1) {
  throw new Error(`Package versions must match: ${packages.map(({ name, version }) => `${name}@${version}`).join(", ")}`);
}

const [version] = versions;
if (tag !== `v${version}`) throw new Error(`Release tag ${tag} does not match package version v${version}.`);

process.stdout.write(`Verified ${tag}: ${packages.map(({ name, version: packageVersion }) => `${name}@${packageVersion}`).join(", ")}\n`);
