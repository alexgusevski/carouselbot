(function configureCarouselBot(global) {
  const parameters = new URLSearchParams(global.location.search);
  const isLocal = ["127.0.0.1", "localhost"].includes(global.location.hostname);
  const localPort = global.location.port ? `:${global.location.port}` : "";
  const localLegacyOrigin = `http://127.0.0.1${localPort}`;
  const previewCanonicalPort = parameters.get("__carouselbotCanonicalPort");
  const sourceOrigin = (() => { try { return new URL(parameters.get("from")).origin; } catch { return null; } })();
  const localSource = sourceOrigin && ["127.0.0.1", "localhost"].includes(new URL(sourceOrigin).hostname) ? sourceOrigin : null;
  const isLocalLegacyPreview = isLocal && parameters.get("__carouselbotMigrationPreview") === "legacy";
  const isLocalReceiver = isLocal && Boolean(localSource);
  const localCanonicalOrigin = previewCanonicalPort
    ? `http://127.0.0.1:${previewCanonicalPort}`
    : `http://localhost${localPort}`;

  global.CAROUSELBOT_CONFIG = Object.freeze({
    canonicalOrigin: isLocalLegacyPreview ? localCanonicalOrigin : isLocalReceiver ? global.location.origin : "https://carousel.bot",
    legacyOrigins: Object.freeze(isLocalLegacyPreview ? [localLegacyOrigin] : isLocalReceiver ? [localSource] : ["https://slides-editor.pages.dev"]),
    migration: Object.freeze({
      enabled: true,
      autoForwardEmptyLegacyStorage: false,
      transferQueryParameter: "carouselbotMigration",
      sourceQueryParameter: "from",
      projectTimeoutMs: 30_000,
    }),
  });
})(window);
