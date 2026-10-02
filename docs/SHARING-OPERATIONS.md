# Sharing safeguards

Sharing runs only on `https://carousel.bot`. Previews have no KV or D1 bindings.
The production `TURNSTILE_SECRET_KEY` is an encrypted Pages secret; the site key
is public in `wrangler.jsonc`. Verification checks the hostname and `share` action.

`SHARE_BUDGETS` contains only quota counters and a private signing key. Initialize
new installations with `migrations/0001_share_budgets.sql`. Do not reinitialize or
rotate the signing key during routine deployments: existing signed links need it.
D1 admission uses one transaction for global and per-IP reservations. A failed
constraint rolls both back. IPs are HMAC-pseudonymized separately each UTC day.
Expired counters are pruned on successful admissions.

Limits per UTC day:

| Operation | Entire service | Per IP |
| --- | --- | --- |
| Uploads | 400 attempts / 400 MiB | 20 attempts / 64 MiB |
| Reads | 10,000 KV lookups | 300 KV lookups |

Uploads are capped at 8 MiB compressed and 16 MiB decoded, with a 30-second body
read deadline. Failed validation and storage attempts consume their reservations.
Storage expires 24 hours after admission, so adjacent daily windows can retain at
most 800 MiB of newly admitted shares. Other services' usage still counts against
account allowances. Keep the Workers Free plan for a no-overage posture; these
budgets bound share storage operations, not all incoming Worker invocations.

Set `SHARING_ENABLED` to `false` in production configuration and redeploy to stop
both API operations. The static editor and local projects remain available.
Missing verification or quota infrastructure fails closed with 503. Quota denials
return 429. Existing zone rate rules and retained-deployment redirects remain an
additional edge defense.

This security release invalidates unsigned links made by older deployments.
Saved local copies remain available; create a new link to share them again.
Do not roll production back to a deployment preceding these controls.
