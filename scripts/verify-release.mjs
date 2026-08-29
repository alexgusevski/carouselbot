import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseMetadata } from "./release-policy.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tag = process.argv[2];
const prereleaseArgument = process.argv[3];
if (!tag || !["true", "false"].includes(prereleaseArgument)) {
  throw new Error("Usage: node scripts/verify-release.mjs <vVERSION> <true|false>");
}
const { version, npmTag } = validateReleaseMetadata(tag, prereleaseArgument === "true");

const paths = [
  join(root, "packages", "mcp", "package.json"),
  join(root, "packages", "slides-studio-mcp", "package.json"),
];
const packages = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
const versions = new Set(packages.map((manifest) => manifest.version));

if (versions.size !== 1) {
  throw new Error(`Package versions must match: ${packages.map(({ name, version }) => `${name}@${version}`).join(", ")}`);
}

const [packageVersion] = versions;
if (version !== packageVersion) throw new Error(`Release tag ${tag} does not match package version v${packageVersion}.`);

process.stdout.write(
  `Verified ${tag} for npm tag ${npmTag}: ${packages.map(({ name, version: manifestVersion }) => `${name}@${manifestVersion}`).join(", ")}\n`,
);
