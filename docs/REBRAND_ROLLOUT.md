# CarouselBot rebrand rollout

This repository is prepared for the move from Slide Studio to CarouselBot without applying any production changes. Treat the steps below as an ordered release runbook. Do not skip the compatibility release or the browser-storage grace period.

## Prepared identities

| Surface | New identity | Legacy identity retained for compatibility |
| --- | --- | --- |
| Product | CarouselBot | Slide Studio appears only in migration copy |
| Canonical site | `https://carousel.bot` | `https://slides-editor.pages.dev` |
| GitHub | `alexgusevski/carouselbot` | GitHub repository redirect |
| npm package | `carouselbot` | `slides-studio-mcp` shim |
| CLI binary | `carouselbot` | `slides-studio-mcp` |
| MCP config key | `carouselbot` | setup removes `slide-studio` |
| Agent skill | `carouselbot` | existing installed skill is left untouched |

The Cloudflare Pages project remains named `slides-editor` during migration. Its name is an internal deployment identifier, and retaining it keeps the legacy `pages.dev` origin available to read its IndexedDB. Do not delete or recreate that project during the migration.

## Why the legacy origin must keep serving JavaScript

IndexedDB is isolated by origin. The old page must execute under `https://slides-editor.pages.dev` to read projects created there. A network-level redirect would run before that JavaScript and strand the old data.

The prepared transfer flow:

1. Shows a migration notice only on configured legacy origins.
2. Opens the canonical origin from a user click.
3. Binds the two tabs with a random one-time token and exact origin checks.
4. Copies one complete project at a time, including image data.
5. Acknowledges each successful IndexedDB write before sending the next project.
6. Skips an incoming project when the canonical origin already has an equal or newer revision.
7. Leaves every legacy project untouched.

The transfer configuration lives in `app-config.js`. `autoForwardEmptyLegacyStorage` is intentionally `false` in the prepared branch.

For local manual QA, run `npm start` and open `http://127.0.0.1:4173/?__carouselbotMigrationPreview=legacy`. The transfer button opens `http://localhost:4173`, providing two real browser origins without contacting production. The automated browser test uses two isolated localhost ports instead.

## Phase 0 — reserve names

Complete these before public announcement:

- Confirm `carouselbot` is still available on npm.
- Confirm `alexgusevski/carouselbot` is still available on GitHub.
- Publish or otherwise reserve the npm name through the normal release process.
- Verify control of `carousel.bot` in the Cloudflare account that owns the Pages project.

## Phase 1 — compatibility release on the old package

The primary package version and compatibility package version must match. Publish in this order:

```bash
npm install
npm test
npm run mcp:pack
npm run mcp:pack:legacy
npm publish --workspace carouselbot
npm publish --workspace slides-studio-mcp
```

Then mark the old package as renamed without unpublishing it:

```bash
npm deprecate slides-studio-mcp "Slide Studio is now CarouselBot. Existing installs remain compatible; new installs should use carouselbot."
```

Before publishing, confirm the npm trusted-publisher or token configuration permits the new package and that provenance is present on the resulting release.

The compatibility release must be available before the website is served from `carousel.bot`, because older package versions do not allow the new browser origin.

## Phase 2 — rename GitHub

Rename `alexgusevski/tiktokslideeditor` to `alexgusevski/carouselbot` in GitHub settings. GitHub should retain ordinary repository and Git transport redirects. After renaming:

```bash
git remote set-url origin https://github.com/alexgusevski/carouselbot.git
git remote -v
```

Do not create a new repository using the old name; doing so would take over GitHub's redirect. Verify the raw README URL used by the in-app MCP setup prompt after the rename.

## Phase 3 — attach the domain without redirecting the old origin

1. Add `carousel.bot` as a full Cloudflare DNS zone in the same account as the Pages project.
2. Review every record Cloudflare imported or discovered. If DNSSEC is enabled at Spaceship, disable it before changing nameservers; stale DS records can make the domain unreachable.
3. In Spaceship, replace all current authoritative nameservers with the exact Cloudflare nameservers assigned to the new zone. The registration remains at Spaceship.
4. Wait for the Cloudflare zone to become active. Afterward, re-enable DNSSEC through Cloudflare and publish the new DS record at Spaceship if DNSSEC is desired.
5. On the existing `slides-editor` Pages project, use **Custom domains → Set up a domain** to add the apex `carousel.bot`. Do not create only a manual DNS record: Pages must know about the hostname so routing and TLS are provisioned correctly.
6. Wait for the Pages custom domain and certificate to become active, then verify HTTPS from an uncached browser or `curl`.
7. Add `www.carousel.bot` to Pages and redirect it to `https://carousel.bot` if the `www` hostname is desired.
8. Do **not** create a Bulk Redirect for `slides-editor.pages.dev` yet.

Verify both origins serve the same release and that the MCP companion accepts both origins.

## Phase 4 — one-week migration grace period

Deploy the prepared application while `autoForwardEmptyLegacyStorage` remains `false`.

Test with a real browser profile that contains representative legacy projects:

- The old origin reads `slide-studio-db` and shows the number of projects found.
- Clicking the transfer button opens `carousel.bot` without a pop-up warning after the user gesture.
- Text, backgrounds, image assets, slide order, revisions, and project IDs match.
- Repeating the transfer skips equal/newer canonical records instead of overwriting them.
- Closing either tab produces a useful retry message.
- MCP connections work from both origins.

Keep the old editor functional throughout the grace period. The notice says “copy,” not “move,” because no legacy data is deleted.

## Phase 5 — automatic forwarding after the grace period

After the grace period, change this flag and deploy normally:

```js
autoForwardEmptyLegacyStorage: true
```

The old origin will then forward browsers that have no legacy projects or have completed migration. Browsers that still contain unmigrated projects continue to see the copy prompt.

Keep this JavaScript bridge available for several months. A blanket Cloudflare Bulk Redirect is only safe after intentionally ending self-service migration. If one is eventually added, preserve query strings and path suffixes and retain a separately reachable migration page for late users.

## Rollback

- Domain: detach `carousel.bot` from Pages or restore its prior DNS records. The legacy Pages origin remains deployable.
- Website: set `autoForwardEmptyLegacyStorage` back to `false` and redeploy.
- npm: undeprecate the old range if necessary. Do not unpublish either package.
- MCP: both old and new environment-variable names, origins, resource URIs, headers, daemon directories, runtime globals, and clipboard formats remain supported.
- Browser projects: migration only copies data, so the legacy IndexedDB remains a recovery source.

## Post-migration cleanup

Do not remove compatibility aliases in a patch release. Any eventual removal should be announced and released as a major version after telemetry and support history show that the legacy origin and package are no longer in meaningful use.
