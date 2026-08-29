const RELEASE_TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export function validateReleaseMetadata(tag, prerelease) {
  if (!RELEASE_TAG_PATTERN.test(tag || "")) {
    throw new Error("Release tag must be an exact v-prefixed semantic version.");
  }
  if (typeof prerelease !== "boolean") {
    throw new Error("Release prerelease state must be true or false.");
  }

  const version = tag.slice(1);
  const versionIsPrerelease = version.includes("-");
  if (versionIsPrerelease !== prerelease) {
    throw new Error(
      versionIsPrerelease
        ? "A prerelease version must be marked as a GitHub prerelease."
        : "A stable version cannot be marked as a GitHub prerelease.",
    );
  }

  return { version, npmTag: prerelease ? "beta" : "latest" };
}
