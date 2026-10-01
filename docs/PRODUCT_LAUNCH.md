# Product launch state

The repository is private. Published MCP packages and previously licensed MIT versions remain usable. New hosted product code is proprietary.

## Verified infrastructure

All CarouselBot Cloudflare resources use account `0013d6c77fa95280762f403d53c52869` (Alex@beundraab.se).

| Environment | Database | Private media | Traffic |
| --- | --- | --- | --- |
| Preview | `carouselbot-product-dev`, `fa805421-2c9c-4202-86c0-297151bb44cf` | `carouselbot-product-dev` | `https://carouselbot-product-dev.longformstudio-api.workers.dev` |
| Production | `carouselbot-product`, `aad4c84f-495f-4374-a2b4-fc9e330da1e3` | `carouselbot-product` | Not routed yet |

Both product databases have all three migrations. Preview sign-in, project save, private media upload and dashboard reload have been verified with the Beundra account. The full editor, migration and MCP browser gates pass.

The production configuration reuses the existing `carouselbot-shares-24h` KV and `carouselbot-share-budgets` D1 database. Their IDs and the `slides-editor` Pages project were verified in the same account. Existing public share signatures and quotas remain intact.

Clerk application `CarouselBot` belongs to the Beundra organization. Preview uses its development instance, `awaited-lacewing-5587.clerk.accounts.dev`. Production instance `ins_3K5t1LZ072UqJGMj1DdlpENHZIG` uses `clerk.carousel.bot`: all five DNS records are verified, its TLS endpoint serves public JWKS, and the live publishable key and public RSA verification key are configured in the production template. Verification needs only that public signing key; no Clerk administrative secret is deployed. Signing-key rotation requires refreshing this configured public key.

Polar organization `CarouselBot` (`910c22e9-7592-4e09-b0ce-5370849695c9`) is separate from IQMog. Product `cd39dfb0-6110-4e40-ae3c-85a8405ac2a0` is $19 per month. The plan includes 500 credits per billing period; each agent request reserves up to 50, charges actual provider cost, and returns unused credits. One credit equals $0.01 of provider usage.

The live Polar product, scoped token and signed webhook are configured for the preview. A zero-charge subscription checkout and its signed webhook were verified: entitlement came from the webhook, and the account received 500 credits. The preview OpenRouter secret is configured and hosted generation has been exercised. Secret values are stored in Cloudflare, never in source. Production secrets still need provisioning independently.

Backend review covers tenant isolation, verified Clerk sessions, project revision checks, signed and replay-safe billing updates, atomic allowance reservations and usage settlement, and private media reference cleanup. A provider usage-write failure conservatively consumes the reserved request budget. Browser Run sessions belong to one job, each preview uses an isolated browser context, and session IDs are excluded from public job events. Focused regressions cover settlement retries and deletion during a concurrent asset reupload.

The latest hosted job has durable Undo through a private before-job snapshot. Restoration retains prior media, increments the project revision and leaves billing unchanged. Later edits and active or newer jobs prevent restoration, including a concurrent job-start race. Known terminal Workflow error codes persist across checkpoints so budget failures keep their actionable saved-edits message. These paths pass the product regression tests.

Live preview checks verified a generated 2K coffee photo saved as an editable background while the editor tab was closed, a subsequent title edit and browser render completing successfully, Undo restoring the prior title after reloading, and cooperative Stop preserving completed edits. The completed title-edit job cost $0.061091; the stopped job cost $0.041839 and left no reserved allowance. Total preview provider usage at that check was $0.285068. Older chat images are removed from model input as needed to keep the latest image within the request budget.

## Remaining launch checks

1. Finish production Google OAuth in Clerk. Separate Google project `fluted-ranger-510313-m2` is created in the Beundra account; Google policy acceptance and the OAuth credentials/settings remain to be completed.
2. Complete Polar merchant verification and payout connection in the owner's account. Payout connection needs the owner's handoff; product creation and the preview test do not establish merchant approval.
3. Verify production sign-in, existing share reads and a new verified share upload during cutover. Preview image generation, browser reconnect, cooperative stop and durable undo are verified; checkout returns do not grant entitlement.
4. Provision production Worker secrets independently: OpenRouter key, scoped Polar token, webhook secret and the existing Pages Turnstile secret. Preserve the existing public share signing key, KV and budget database.
5. Complete the production cutover after live validation. The production template intentionally keeps `routes: []`, and the guarded `npm run deploy:product` requires clean `main`, exact `origin/main`, the intended `carousel.bot/*` route and all production secrets. Keep the existing Pages deployment available for rollback.

The original production Pages deployment is unchanged until these checks finish. See [backend setup](../backend/README.md) and [agent architecture](HOSTED_AGENT.md) for configuration details.
