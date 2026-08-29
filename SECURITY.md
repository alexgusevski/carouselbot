# Security Policy

## Supported versions

The hosted editor is updated in place. Security fixes for the npm packages are
applied to the latest release line.

| Component | Supported |
| --- | --- |
| Hosted editor at `carousel.bot` | Current deployment |
| `carouselbot` and `slides-studio-mcp` 0.2.x | Yes |
| Earlier npm versions | No |

## Active security controls

- **Repository:** protected `main`, pull-request checks, linear history, immutable
  GitHub Action SHAs, least-privilege workflow permissions, Dependabot, CodeQL,
  dependency review, secret scanning, and push protection.
- **npm releases:** exact `v<semver>` tags, release commits verified against
  protected `main`, matching package versions, tests before publishing, and an
  `npm-release` environment restricted to release tags.
- **Package identity:** npm trusted publishing uses a short-lived GitHub OIDC
  credential instead of a stored npm token. Both packages require 2FA and
  disallow bypass-2FA tokens. Publishing requests npm provenance.
  The canonical and compatibility packages publish in separate jobs so a failed
  compatibility publish can be retried without republishing the canonical package.
- **Installed MCP version:** setup writes an exact package version into the local
  MCP configuration. Users update deliberately by rerunning `npx carouselbot@latest setup`.
- **Application:** the public site is static and has no application backend. User
  projects stay in browser storage. The optional MCP companion binds to loopback,
  checks the browser origin, and uses random local bearer tokens.

The release workflow has no npm-token fallback: if the npm Trusted Publisher
configuration does not match this repository, `.github/workflows/publish.yml`,
and the `npm-release` environment, publishing fails closed. Provenance is visible
on npm for releases produced by that workflow; older releases may predate it.

## Trust boundaries

The MCP companion is designed for a trusted local user account. Processes and MCP
clients running as the same operating-system user are mutually trusted; it is not
a sandbox against hostile software already running on that account. The companion
does not expose a public network service or upload projects to CarouselBot.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/alexgusevski/carouselbot/security/advisories/new)
so reports, reproduction steps, and proposed fixes remain confidential until a
coordinated release is ready.

Include the affected component and version, the expected impact, reproduction
steps or a proof of concept, and any suggested mitigation. You should receive an
initial acknowledgement within seven days and a status update at least every
fourteen days while the report is active.

Good-faith research that avoids privacy violations, data destruction, service
degradation, and access beyond what is necessary to demonstrate the issue is
welcome. We will not pursue action against researchers who follow this policy.
