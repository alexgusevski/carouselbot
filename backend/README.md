# Hosted product backend

The product Worker is separate from the existing Pages deployment. Local/MCP editing continues to work without auth or hosted services. Account requests require a verified Clerk session Bearer token; there is no development auth bypass.

## Deployment

Build the browser application, then apply the migrations:

```sh
npm run build
npx wrangler d1 migrations apply carouselbot-product-dev --remote --config wrangler.product.jsonc
npx wrangler deploy --config wrangler.product.jsonc
```

`wrangler.product.jsonc` targets the Beundra account and development database, private R2 bucket, Browser Run and Workflow. Set its `APP_ORIGIN` to the exact deployed application origin. Before production, provision a separate database/bucket/Workflow and configure a live Clerk instance and approved live Polar product. Never copy dev billing data into production.

Configure `CLERK_JWT_KEY` with the public PEM signing key from the configured Clerk instance. This is public configuration; V1 verifies session tokens with the official backend SDK and needs no Clerk admin secret. Refresh it if Clerk rotates the signing key.

Set Worker secrets with Wrangler (`--config wrangler.product.jsonc`):

- `OPENROUTER_API_KEY`: server-only inference key, with a provider spending limit.
- `POLAR_ACCESS_TOKEN`: token for the configured Polar environment and organization.
- `POLAR_WEBHOOK_SECRET`: endpoint secret copied exactly from Polar.

Public vars: `CLERK_PUBLISHABLE_KEY`, `POLAR_PRODUCT_ID`, `POLAR_ENVIRONMENT` (`sandbox` or `production`), `AGENT_ALLOWANCE_USD` and `JOB_BUDGET_USD`. Current allowance defaults reserve up to $0.50 of provider usage per agent request against $5 of provider usage per subscription period. These are provider cost limits, independent of the subscription's checkout price.

The $19/month product maps those defaults to 500 AI credits per paid period and a maximum of 50 credits per request. One credit is $0.01 of provider usage. Starting a request reserves its maximum; unused credits return when it finishes or stops, while completed provider calls are charged. A request needs 50 available credits to start. `/api/config` supplies the UI's allowance/request limits and `/api/account` reports whole remaining credits. Provider spend and credits are separate from the subscription's $19 checkout price and Polar's tax handling.

Register the Polar webhook at `/api/billing/webhook`, raw payload, subscription events (`subscription.active`, `.updated`, `.cycled`, `.canceled`, `.revoked`, `.past_due`, `.paused`, `.resumed`, `.uncanceled`). Entitlement comes from the signed subscription status, product ID and period. A checkout return URL does not grant access. Cancel-at-period-end remains active until its paid period ends. Repeated/out-of-order deliveries cannot reset spent allowance.

## API

All account endpoints are same-origin, authenticated Bearer requests. Public config and signed webhook are the only public product API endpoints.

- `GET /api/config`: public auth readiness and service availability.
- `GET /api/account`: account identity, subscription and remaining provider allowance.
- `GET /api/projects`, `GET /api/projects/:id`: account-scoped documents.
- `PUT /api/projects/:id`: `{project, expectedRevision}`; returns canonical document with server revision. Images/video/fonts are deduplicated into private R2; tiny solid-color SVGs remain inline. CAS conflicts return HTTP 409, latest project and `STALE_PROJECT`.
- `DELETE /api/projects/:id?expectedRevision=N`: CAS delete; stop active jobs first.
- `GET/POST /api/folders`, `POST /api/folders/move`: empty-folder metadata and atomic document moves.
- `DELETE /api/assets/:id`: remove an unreferenced image; database foreign keys protect assets used in projects or chats. Project deletion cleans up its unreferenced media. Authenticated account reads opportunistically prune up to five abandoned uploads older than seven days and retry up to ten queued R2 deletes for that account. Preview needs no cron slot; the optional scheduled handler supports a future production schedule.
- `POST /api/assets`: image bytes with Content-Type and URI-encoded X-File-Name; returns asset ID and private API URL. `GET /api/assets/:id` verifies ownership before serving bytes.
- `GET /api/projects/:id/chat`: display messages and latest job.
- `POST /api/projects/:id/jobs`: `{prompt,attachmentIds,expectedRevision,requestId}`; optional client-generated request ID makes HTTP retry safe.
- `GET /api/jobs/:id`: job, current project, chat and progress events.
- `POST /api/jobs/:id/stop`: cooperative cancellation, preserving saved edits and charging completed provider calls.
- `POST /api/billing/checkout`, `POST /api/billing/portal`: hosted Polar URLs. Product and customer identity are server-selected.

One active job per carousel. Job reservations are atomic D1 transactions, so concurrent jobs cannot reserve the same allowance. Provider generation IDs deduplicate usage debits. A Workflow checkpoints each model call/tool operation; provider calls do not automatically retry. All job edits use document revision CAS so manual or cross-tab edits are never silently overwritten.

Known terminal checkpoint failures persist their error code as a serializable step result, then throw outside the step. This preserves stop, revision, budget and uncertain-usage handling when Workflow error serialization removes custom properties. Successful checkpoint outputs remain unchanged. See [Workflow step results](https://developers.cloudflare.com/workflows/build/workers-api/) and [catching step errors](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/).

The latest hosted job can be undone after reloading or reopening the editor. At job start, a private event stores its canonical before-project snapshot and the existing job asset references protect its media. Agent saves atomically track the resulting revision. Chat/job responses expose `job.canUndo`; authenticated `POST /api/jobs/:id/undo` with `{expectedRevision}` returns `{project,job}`. Restoration increments the project revision, consumes Undo once and leaves billing unchanged. Active jobs, later manual edits and newer requests block restoration. Snapshot events are excluded from public payloads, and starting a newer job removes the previous snapshot. Jobs that started before this feature have no durable snapshot.

## Tests

```sh
node --test backend/test/*.test.mjs test/hosted-agent.test.mjs
npx wrangler deploy --config wrangler.product.jsonc --dry-run
```

Backend tests use Node's built-in SQLite to exercise real schema, CAS, ownership, signed Clerk JWT verification, allowance settlement and folder transactions. Browser verification remains in the repository's complete gate. Verify live sign-in, sandbox checkout/webhooks, reload/reconnect, stop and a generated carousel before production promotion.

Existing `/api/shares` requests in the separate preview proxy to the current Pages origin. Existing links remain readable. New preview uploads remain subject to the current live Turnstile hostname restriction (`carousel.bot`). The proxy disables itself at that origin to avoid recursion.

## Production cutover preparation

`wrangler.product.production.jsonc` is a separate preparation template. It has `workers_dev:false` and an empty routes list, so it does not take traffic from Pages. Its separate production D1 database and private R2 bucket are provisioned, and all product migrations have been applied. Apply future `backend/migrations` only to that product database. Keep development data and billing separate.

The existing Pages project and share bindings were verified in the Beundra account `0013d6c77fa95280762f403d53c52869`: Pages `slides-editor` owns `carousel.bot` and `slides-editor.pages.dev`, KV `907668f59e2b401b96ac15bf2c09437e` is `carouselbot-shares-24h`, and D1 `0c23bce1-e55b-44c7-bd97-e4ca0f233802` is `carouselbot-share-budgets`. Production binds these same resources, preserving existing shared payloads, signing keys, expiration and quotas. Do not reset the share database's `signing_key` or copy the product migrations into it. Shares use KV; private account media uses the separate R2 bucket.

`PRODUCT_SHARING_MODE:"direct"` selects `backend/direct-shares.mjs`, which calls the original Pages handlers for `/api/shares/config`, `/api/shares` uploads and signed share reads. It retains the exact original origin, Turnstile hostname/action, signed-ID and quota enforcement. Copy the existing Pages `TURNSTILE_SECRET_KEY` into the future production Worker and retain the configured site key. No upstream proxy runs on `carousel.bot`.

Before adding the `carousel.bot/*` Worker route, configure a live Clerk instance for that origin and its public PEM verification key, the approved live $19/month Polar product, Polar access/webhook secrets, the bounded OpenRouter secret, and the existing Turnstile secret. Verify real sign-in, a sandbox payment/webhook cycle, a generated carousel, stop/reload/CAS, existing share reads and a verified new share upload. Keep the current Pages deployment and domains available for legacy origin migration and rollback. The cutover route shown in the template is deliberately commented out until those checks pass; production deployment still requires the repository's production safeguards.

Use `npm run deploy:product` for production promotion. Its script requires a clean `main` checkout that exactly matches freshly fetched `origin/main`, the intended `carousel.bot/*` route, live Clerk/Polar configuration, production resource bindings, and the existing sharing resources. It also checks the production Worker's secret names without reading their values before building and deploying. It rejects the current preparation config until the live keys, product and route are ready. Preview deployment remains `npm run deploy:product:dev`.
