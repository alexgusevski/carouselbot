# CarouselBot app implementation and launch setup

The mobile client lives in `apps/mobile`. It reuses the current Cloudflare
product's accounts, project schema, private media, agent Workflows, revision
checks, Stop, Undo and allowance accounting. The web's local/MCP editor remains
available and unchanged. The starting hosted product is commit `d81e32e`.

## Provisioned

Expo project `@alexgusevski/carouselbot`, ID
`7b7652ae-4c24-47fd-9cb9-6f1dac8c243c`, is created and linked. Native identifiers
are `com.beundra.carouselbot`. Code includes Clerk native AuthView and
RevenueCat hosted paywall, restoration, identification, server reconciliation
and webhook support. Creation of a separate RevenueCat project is pending
approval for the official CLI OAuth grant; the existing CLI token only accesses
IQMog. No existing RevenueCat project was changed.

## Worker setup

Apply migration `0004_mobile_billing.sql` before deploying the new Worker. It
preserves Polar rows and marks them as `provider='polar'` while adding store
metadata. Test fixtures run all four migrations. Production must apply the same
migration to its separate database.

Public Worker variables:

| Variable | Value / purpose |
| --- | --- |
| `CLERK_MOBILE_AUDIENCE` | `carouselbot-mobile`, matching the signed Clerk session claim |
| `REVENUECAT_ENTITLEMENT_ID` | `pro` |
| `REVENUECAT_PRODUCT_IDS` | Comma-separated exact store IDs approved for CarouselBot |
| `REVENUECAT_ENVIRONMENT` | `SANDBOX` for preview; `PRODUCTION` for release |

Secrets are server-only: `REVENUECAT_SECRET_KEY` (a RevenueCat secret API key
with subscriber access) and `REVENUECAT_WEBHOOK_AUTH` (the full Authorization
header configured on the webhook). Register subscription/transfer events at
`/api/billing/revenuecat/webhook`. The receiver fetches authoritative subscribers
for identified Clerk users, including both sides of a transfer. It marks an
event processed only after reconciliation succeeds, so failed verification is
retryable. No webhook transaction fields or client CustomerInfo grant access.
Unexpected product IDs/stores and sandbox purchases in production are rejected.
Deleted accounts keep only a revocation marker (Clerk user ID and deletion time)
so offline-verified unexpired JWTs and later billing retries cannot recreate the
account or refill a purged allowance.

The credit ledger continues to grant 500 credits per paid period, reserve at most
50 per request, charge actual provider usage and return unused reservations.
Replay, grace and cancellation do not refill spent credits. A signed current
subscription from either provider allows jobs from either client; subscription
management still belongs to its purchase provider.

## Clerk native setup

Use CarouselBot's existing Clerk application, not a new identity system.
Production Native API is already enabled, but the iOS applications and mobile
SSO redirect allowlist were empty when inspected. An iOS registration was
prepared with Apple team `QWD554QVGB` and `com.beundra.carouselbot`; submitting
it and adding the audience claim await browser security approval. Development
and production instances require their own configuration.

Configure email code, Google and Apple in that instance. Native AuthView uses
the provider configuration; it does not require a parallel hand-built email
flow. Register Google native OAuth client IDs for the package/bundle and the
actual Android signing certificate; add them to Clerk. Configure Apple's app
identifier capability and Clerk Apple connection. Set the session customization
claim `{"aud":"carouselbot-mobile"}`; retain existing custom claims. Add the
app association and redirects required by Clerk's enabled native flows. For
signed release builds use the actual EAS certificate fingerprints; do not reuse
IQMog fingerprints or assume debug certificates apply to production.

## RevenueCat and store catalog

Create a separate CarouselBot project with App Store and Google Play apps.
Set restoration behavior to **Keep with original App User ID**: subscriptions
belong to a signed-in CarouselBot account, and another account must not acquire
fresh credits by repeatedly restoring the same store subscription. Identity is
configured before presenting purchases; anonymous purchases are not offered.
Suggested IDs are Apple `carouselbot_pro_monthly`, Google subscription
`carouselbot-pro` / base plan `monthly` (subscriber API ID
`carouselbot-pro:monthly`). These are proposed identifiers, not provisioned
products. Create entitlement `pro`, offering `default`, monthly package
`$rc_monthly`, and attach both real store products. Set the offering current.
Choose the actual store price to match the web plan and inspect localized store
prices before release; client code displays RevenueCat/store pricing.

Create a **draft** hosted paywall for the default offering. Suggested prompt:

> CarouselBot turns users' own photos and words into editable carousels. Warm
> paper #F7F7F2, ink #1E241B, sage #DCEABF and accent #415E22. Calm, spacious,
> rounded design with small stacked slide artwork; no generic AI chat imagery.
> Title: “Make room for your next idea.” Explain 500 agent credits per monthly
> billing period, shared carousels and subscription access on app and web, and
> manual control of every slide. Use real localized package prices and billing
> duration. No invented free trial. Include close, restore, privacy and terms.
> Never claim image generation: the agent edits text/layout using uploaded media.

Draft generation does not publish the paywall. Publication requires explicit
user approval under the RevenueCat paywall design skill. Populate EAS preview
and production public keys separately, with the correct Clerk/backend instance.

## Required release verification

Verified locally: the full repository editor/Node/build/browser/migration/MCP
gate, mobile TypeScript and autosave tests, signed mobile identity and billing
ledger tests, mobile Chrome touch editing/PNG export, Worker bundle dry-run,
and iOS/Android JavaScript exports pass. An iPhone Release simulator build runs
the actual app: live slide rendering, text inspector with automatic fitting,
keyboard-aware composer, send dismissing the keyboard, all-slide save to Photos
and the native PNG share sheet were exercised successfully. The separate test
simulator was shut down afterward.

Android internal APK build from implementation commit `bcdabe9` is queued in
[Expo](https://expo.dev/accounts/alexgusevski/projects/carouselbot/builds/2f3d701f-dbdb-4744-ae12-8666dab8dbc1).
It does not yet contain live Clerk/RevenueCat configuration and exposes the
manual demo. No Android installation or store purchase is claimed verified.

Implementation is not a claim of store launch readiness. Remaining external
checks are native Google/Apple/email sign-in, valid audience tokens against the
deployed backend, store sandbox purchase/cancel/restore, native hosted paywall
appearance, purchases unlocking the same web account, existing Polar accounts
unlocking mobile, account deletion and both device export paths. Validate MP4
codecs/audio on iPhone and Android; the local renderer uses browser codecs.

Account deletion removes projects/jobs/media references/allowances and queues
private object deletion before deleting the Clerk user. It refuses to delete
while jobs run. Store subscriptions must be canceled separately. If Clerk asks
for recent authentication, complete it before retrying. Provider billing records
remain subject to the provider's retention rules.

Publish verified privacy/terms/support URLs before store submission. The initial
`https://carousel.bot/privacy` and `/terms` links could not be verified as policy
pages and must not be treated as reviewed legal documents. Ensure Apple privacy
and Google Data Safety disclosures reflect Clerk account data, cloud user
content, agent provider processing, RevenueCat purchase/account identity and
operational logs. Do not invent retention schedules or “no data collected.”

The existing web product's launch checks still apply: production Google OAuth,
Polar approval, production secrets and its guarded production cutover are
separate from the app code. This work does not submit or release either store app.
