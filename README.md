# Captivo Access

![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)

**Open-source, self-hosted, VPN-less Zero Trust remote access for third-party vendors.**

Grant an external vendor or contractor passkey-authenticated, time-boxed,
audited access to one specific internal web app **or remote desktop
(RDP/SSH/VNC)** — without a VPN, without opening an inbound port into your
network, and without handing out a standing credential. You self-host it: there is no SaaS, no vendor lock-in,
and no traffic that passes through anyone's infrastructure but your own.

> **Status: early development.** Passkey identity, the outbound-only
> connector tunnel, time-boxed access grants (with an approval flow and
> recurring schedules), the identity-aware reverse proxy, and a
> tamper-evident (hash-chained) audit trail are all implemented and working
> end-to-end (see [Features](#features)). SSO/OIDC login, session recording
> (web sessions via rrweb, plus native RDP/SSH/VNC remote-desktop sessions
> streamed in-browser, recorded, and watchable live), an encrypted **credential
> vault** for remote-desktop targets, and a light/dark/system console are shipped
> too. **Session isolation** — an isolated remote browser (KasmVNC) for the
> riskiest access, with live watch/take-control/terminate, seekable video
> recording, and clipboard + screen-watermark DLP — is now shipped as well. Not
> production-hardened; review the [Security model](#security-model) yourself
> before relying on it.

> **New here?** [Quickstart](./docs/quickstart.md) gets you a working
> end-to-end demo in ~5 minutes with **zero DNS setup**.
> [How it works](./docs/how-it-works.md) explains the pieces and traces a
> request through every gate.

## Why

Most organizations that let vendors and contractors touch internal
applications do it one of two ways: a full VPN (broad network access, a
standing credential, an inbound endpoint to defend) or a shared login
handed over Slack. Neither is scoped, neither expires itself, and neither
gives you an audit trail of what the vendor actually touched. Captivo
Access is a narrower tool: point it at one internal app, give one vendor a
passkey and a time window, and every request they make is checked live and
logged.

If you just need a transparent identity-aware proxy in front of internal
web apps, this is in the same space as Cloudflare Access or Pomerium — with
a vendor-lifecycle (invite → time-boxed grant → revoke) and Turkish
KVKK/5651-style retention framing layered on top, and it's yours to run
on your own infrastructure. Unlike a pure web proxy, it also brokers native
**RDP / SSH / VNC** sessions to internal desktops — streamed in-browser,
recorded, and watchable live — with no VPN and no separate bastion.

## Architecture

```
 Vendor's browser
       │  HTTPS (passkey login, then per-resource access)
       ▼
 Front proxy  (Caddy/nginx — TLS termination, routes by hostname)
       │
       ├──▶ Control plane   (Next.js, :3100)
       │    identity & passkeys, admin console,
       │    access grants, audit log, Postgres
       │
       └──▶ Data plane      (Go, :3103)
             identity-aware reverse proxy — checks the
             session + the access grant on every request
                   │
                   ▼
          outbound-only WSS tunnel (yamux-multiplexed)
                   │
 ══════════════════│══════════════════ network boundary ══════════════════
                   ▼
             Connector (Go — runs inside the customer network)
                   │  dials OUT to the data plane; never listens,
                   │  never accepts an inbound connection
                   ├──▶ Internal web app   (wiki, admin panel, dashboard, ...)
                   │
                   ├──▶ guacd         (remote-desktop engine, bundled with every connector)
                   │        └──▶ Remote desktop  (RDP / SSH / VNC target)
                   │
                   └──▶ kasm-browser  (isolated-browser engine, bundled with every connector)
                            └──▶ Isolated browser → opens an internal web app,
                                 streams pixels only (nothing lands on the vendor)
```

Four moving pieces:

- **Control plane** — a Next.js app (`/`, this repo's root). Owns identity
  (WebAuthn passkeys + TOTP recovery), the admin console (connectors,
  resources, grants, audit), and Postgres.
- **Data plane** (`dataplane/`) — a Go service with three listeners: the
  public WSS endpoint connectors dial into, an internal API the control
  plane calls, and the browser-facing identity-aware reverse proxy that
  serves vendor traffic per resource.
- **Connector** (`connector/`) — a small Go binary you run inside your own
  network. It dials **out** to the data plane over WSS and never opens a
  listening port; it holds a local allowlist of the internal services it's
  permitted to reach. Its install command always brings up the session engines
  alongside it — **guacd** (remote desktop) and **kasm-browser** / KasmVNC
  (isolated browser) — reached the same outbound-only way, no toggle.
- **`tunnel/`** — the shared wire-format module (frames, dial requests,
  body streaming) used by both the data plane and the connector.

A vendor request is checked **live, on every single request** — session
cookie → user, hostname → resource, `evaluateAccess(user, site, now)` → allow
or deny with a reason — before it's ever streamed to the connector.

## Features

Shipped and working today:

- **Passkey (WebAuthn) authentication**, no passwords anywhere — plus TOTP
  as a break-glass recovery path if a user loses every passkey.
- **Time-boxed access grants** — an admin ties one vendor to one resource with
  an optional start/end window; a vendor's `/access` page shows what's
  active vs. upcoming.
- **Outbound-only connector** — dials the internal address defined on each
  Resource, and never accepts an inbound connection. An optional `ALLOWED_TARGETS`
  boundary caps which internal addresses a connector may reach.
- **Identity-aware reverse proxy** — host-based routing
  (`<site>.access.<domain>`), session + grant checked on every request,
  fail-closed.
- **Append-only audit log** — every allowed request and every authenticated
  denial is recorded, with KVKK/5651-oriented retention cleanup and CSV
  export from the admin console.
- **Light / dark / system theme** — the console follows the OS by default, with
  a light/dark switcher in the header.

- **Approval flow** — a vendor can request access to a resource; the request is
  pending (and denied) until an admin approves it, or the admin denies it.
  Admin-created grants are active immediately.
- **Recurring schedules** — a grant can be restricted to weekly windows (e.g.
  weekdays 09:00–18:00 in a chosen timezone), evaluated in that timezone.
- **Display timezone** — every date shown, and every date typed into a form
  (grant start/end, access requests, audit and recording filters), uses one
  zone: the organization default (Policy → Platform settings; per tenant on
  Cloud), which each user can override under Preferences (console and vendor
  portal alike). When neither is set, the viewer's browser zone is used.
- **Tamper-evident audit** — audit rows are hash-chained; the admin console
  can verify the chain is intact and detect alteration, deletion, splicing,
  or tail-truncation. An optional **external anchor** (a trusted RFC 3161 /
  KamuSM timestamp on the chain head, enabled from Policy) seals the chain
  against an actor who could rewrite the whole database.
- **Per-resource health monitoring** — a scheduled probe TCP-connects to each Resource
  through its connector and shows reachability + latency in the console. When a
  Resource goes down or recovers, an in-console notification is raised (nav bell +
  list) and, optionally, a best-effort webhook is fired
  (`NOTIFICATION_WEBHOOK_URL`, Slack/Teams-friendly) — no mail server required.
- **SSO / OIDC login** — internal staff/admins can sign in with an identity
  provider (Entra, Google, Okta) alongside passkeys; accounts are
  invite-matched (no auto-provisioning). Vendors stay passkey-only.
- **AD / LDAP directory + group mapping** — connect an LDAP/Active Directory
  (reached through a connector, bind tested from the console), then map
  directory groups by DN to a console **role** or a specific **Resource** at
  `/admin/directory`. Membership drives authorization, so revoking a user in
  your directory removes their mapped access.
- **Roles** — five fixed roles (`ADMIN`, `OPERATOR`, `AUDITOR`, `STAFF`,
  `VENDOR`) drive a capability layer across the console and APIs.
- **Custom domains** — publish a Resource on its own hostname with automatic TLS
  (Caddy On-Demand), configured from the console.
- **WebSocket passthrough** — the proxy relays WebSocket upgrades transparently,
  so WS/streaming internal apps (e.g. a Proxmox noVNC console) work end-to-end.
- **Session recording** — on by default (disable with `RECORDING_ENABLED=0`); with a
  per-Resource toggle, both **web sessions** (an injected rrweb DOM recorder) and
  **remote-desktop sessions** (captured natively from the guacd stream,
  AES-256-GCM-encrypted at rest) are replayable at `/admin/recordings`; admins
  filter, replay, and delete them (each deletion is written to the audit log).
- **Native remote-desktop gateway (RDP/SSH/VNC)** — console protocols are served
  in-browser with no separate pack: every connector runs sessions out of the box,
  its install command also deploying the session engines (guacd for RDP/SSH/VNC,
  KasmVNC for isolated browser) alongside it. The connector needs no toggle; the
  "Remote session" Resource type is available by default (disable with
  `NATIVE_GATEWAY=0`), with server-side credential injection via the built-in
  vault (on by default). Add a **Remote
  desktop** Resource (protocol/host/port/credentials); the credential is injected
  server-side and the vendor never sees the password. Resources carry a `TRANSPARENT`
  (web app) vs `GATEWAY` (remote desktop) label, and gateway targets are
  reachability-checked like web apps.
- **Live session view** — an admin/auditor watches an in-progress remote-desktop
  session in real time from `/admin/live` (the current screen shows on join, via
  guacd connection sharing), and an admin can **take control**; the vendor sees a
  "being monitored" notice and every watch/take/release is written to the audit
  log. Isolated-browser sessions are watchable + controllable the same way (a
  second shared KasmVNC client).
- **Isolated browser (session isolation)** — the highest-isolation access method:
  instead of proxying the app to the vendor's own browser, a Resource can run in a
  throwaway, server-side **isolated browser** (KasmVNC) streamed to the vendor —
  nothing but pixels reaches their machine. It sizes to the vendor's screen (fills
  fullscreen), records to a **seekable** video, enforces **clipboard DLP** (copy/paste
  direction control), and can overlay a **screen watermark** (the vendor's email + a
  live clock, on their screen and any screenshot) as a leak deterrent. Per-direction
  **file transfer** (upload into the browser / download out) is off by default and
  gated per Resource; transfers are ephemeral and audited. A Resource's
  access method is `TRANSPARENT` (web app) / `GATEWAY` (remote desktop) / `ISOLATED`
  (isolated browser).
- **In-session control panel + on-screen keyboard** — remote-desktop and
  isolated-browser sessions carry a collapsible, edge-docked control panel
  (full screen, clipboard status, file upload, leave) and a full on-screen
  keyboard with sticky modifiers, so keys a browser can't send — F-keys, arrows,
  and combinations like **Ctrl+Alt+Del** — reach the session from any device. The
  RECORDED / being-monitored notices stay visible the whole time.
- **Email (SMTP)** — configured from the console (`/admin/email`); sends invite
  emails, access-request/approval emails, and resource down/recovered alerts. (Invites
  can also be copied as a one-time link and sent yourself; all of these events also
  raise in-console notifications regardless of SMTP.)
- **Automatic schema migration + guided upgrade** — the deploy stack runs
  migrations automatically on `up -d` (a one-shot `access-migrate` service), and
  the console shows in-app update notifications with a copyable one-command
  upgrade + per-connector update commands.
- **Policy page** — console-wide controls at `/admin/policy`, all live-editable
  (no redeploy): **session** limits (idle timeout, max lifetime, concurrent-session
  cap), a **maximum grant duration** (every grant must expire — time-boxed vendor
  access), **retention** for the audit log and session recordings, a **recording
  mode** (off / per-resource / required — leave recording to each resource, force
  every session for compliance, or disable it) and a **recording consent** gate,
  the notification webhook, and the invitation-link lifetime.
  Settings that used to be environment variables now live here (the UI value wins).
- **Zero-Trust source-IP allowlist** — restrict vendor access to published Resources
  to specific networks (IPv4/IPv6 CIDRs). Checked live on every request against
  the real client IP (from the front proxy — not spoofable via `X-Forwarded-For`);
  the console itself is never gated, so a bad list can't lock an admin out.
- **Per-resource clipboard control** — a transparent Resource can restrict the vendor's
  clipboard (block copy-out, block paste-in, or both); the proxy injects a
  capture-phase guard into the app's pages. A deterrent, not a hard control
  (bypassable with JavaScript disabled); gateway Resources use Guacamole's own
  clipboard settings instead.
- **Connector observability + egress policy** — each connector's detail page
  shows live telemetry (version, uptime, active/total connections, bytes
  in/out, denied count) and a recent-log tail, streamed over the tunnel's
  control channel — plus a separate **Gateway logs** tail from guacd for
  troubleshooting remote-desktop connections. An optional per-connector
  **egress policy** narrows what a
  connector may reach on top of its local `ALLOWED_TARGETS` — it can only
  tighten that boundary, never widen it. A connector's **log level** (and a
  fleet-wide default) is set from the console and pushed live — turn on
  per-request debug logging for troubleshooting, then back off, without a
  redeploy.
- **User management** — disable/enable and **delete** non-admin users (deletion
  removes the account + credentials but preserves the audit trail).

## Quick start (local/dev)

Requires Docker + Docker Compose v2.

```bash
git clone https://github.com/captivo-io/captivo-access.git
cd captivo-access
cp .env.example .env
```

Edit `.env` and fill in the required secrets — each is a 32-byte hex value:

```bash
openssl rand -hex 32   # → POSTGRES_PASSWORD
openssl rand -hex 32   # → SESSION_SECRET
openssl rand -hex 32   # → ENCRYPTION_KEY
openssl rand -hex 32   # → DATAPLANE_SECRET
```

(`WEBAUTHN_RP_ID` can stay `localhost` for local dev — see
[Passkeys are bound to the domain](#passkeys-are-bound-to-the-domain) below
for why this matters once you deploy for real.)

Bring the stack up:

```bash
docker compose up -d --build
```

This starts Postgres, the control plane, and the data plane. On first run
against a fresh database, push the Prisma schema once:

```bash
pnpm install
DATABASE_URL="postgresql://access:<POSTGRES_PASSWORD>@localhost:5434/captivo_access" pnpm db:push
```

(substitute the `POSTGRES_PASSWORD` you put in `.env`; Postgres is exposed
on host port `5434` in dev to avoid clashing with other local Postgres
instances.)

Then open **http://localhost:3100/setup** and register the first account
as a passkey — it becomes the initial `ADMIN`. There's no seed/default
account.

## Production deploy

The repo-root `docker-compose.yml` above builds images locally and is meant
for development. For a real deployment — the published `ghcr.io` images,
fronted by [Caddy](https://caddyserver.com/) with automatic HTTPS for both
the admin console and the per-resource vendor proxy — use the
[`deploy/`](deploy/README.md) scaffold instead.

> **New to this?** [`docs/install.md`](docs/install.md) is a complete,
> worked-example walkthrough — bare server → DNS → deploy → first admin →
> connector → first vendor connected, with a troubleshooting table. Start
> there; the summary below and [`deploy/README.md`](deploy/README.md) are the
> quick reference.

```bash
cd deploy
cp .env.prod.example .env   # fill in ACCESS_DOMAIN and secrets
docker compose -f docker-compose.prod.yml up -d
```

Images are published to `ghcr.io/captivo-io/captivo-access-{manager,dataplane,connector,migrate,kasm-browser}`
on each `vX.Y.Z` release tag (plus `latest`) — see
[`.github/workflows/publish.yml`](.github/workflows/publish.yml) and the
[releases](https://github.com/captivo-io/captivo-access/releases). Pull the
`latest` tag (or pin a specific `vX.Y.Z`); the `deploy/` scaffold references
them already. The **schema is migrated automatically** on `up -d` by the
one-shot `access-migrate` service — no manual `db push` step. `deploy/README.md`
also covers the wildcard-TLS trade-off (one Caddy DNS-01 plugin vs. the
On-Demand default that needs no per-resource setup).

## How access works

> New here? [`docs/how-it-works.md`](./docs/how-it-works.md) walks the whole
> thing in plain terms — the two pieces, the setup, and a diagram of every gate
> a request passes through from browser to internal app.

1. **Add a connector.** An admin goes to `/admin/connectors`, names a
   connector, and gets back a one-time pairing code and a ready-to-copy
   `docker run` command. That command is run on a host **inside the
   customer's own network**, with just `MANAGER_URL`, `DATAPLANE_URL` (the
   data plane's TLS-terminated WSS tunnel endpoint, e.g.
   `wss://connect.<your-domain>`), and `PAIR_CODE` — no per-app config (see
   [`connector/README.md`](./connector/README.md) for the full env
   reference, including the optional `ALLOWED_TARGETS` egress boundary). On
   first start the connector redeems the pairing code, stores a long-lived
   token in its `/data` volume, and dials the data plane — it then shows up
   as online.
2. **Add a resource.** Under `/admin/sites`, the admin creates a `Site` bound to
   a connector, giving it the internal app's real address
   (`http://10.0.5.20:8080`) directly — that's the only place the address is
   configured.
3. **Grant a vendor access.** At `/admin/grants`, the admin picks a vendor
   user, a resource, and an optional start/end window, then saves. Revoking a
   grant is immediate and irreversible.
4. **The vendor signs in and connects.** The vendor is invited via a
   one-time link at `/admin/invites` (email + role + expiry), registers a
   passkey at `/invite/[token]` — no shared credentials ever exist — and
   logs in at `/login` with a discoverable passkey (no username field). Once
   their grant is active, they open `https://<site>.access.<domain>`
   directly; the data plane resolves their session, checks the grant, and
   — if allowed — streams the request through the connector's tunnel to
   the real internal app.
5. **Everything is audited.** Every allowed request, and every denied
   request from an authenticated user, is written to the audit log (see
   [Security model](#security-model)).

If a passkey user ever loses every registered passkey, `/recover` accepts
their email plus a TOTP code (set up in advance) and lets them register a
new one; every failure path returns the same generic error, so the response
never reveals whether an email exists or which check failed.

#### Passkeys are bound to the domain

WebAuthn passkeys are bound to the *Relying Party ID* at registration and
re-checked on every login. **`WEBAUTHN_RP_ID` must be the exact domain the
control plane is served from** (no scheme, no port) — `localhost` for
local dev, `access.yourcompany.com` for production. If it doesn't match the
browser's address bar, registration and login fail silently with no useful
client-side error. Set it correctly *before* anyone registers a passkey:
changing it later invalidates every passkey already enrolled. In production
the origin must also be HTTPS — browsers refuse WebAuthn over plain HTTP
for any RP ID other than `localhost`.

Cross-subdomain session sharing (the admin console at
`manager.access.<domain>` and every vendor resource at
`<site>.access.<domain>`) requires `COOKIE_DOMAIN` set to a leading-dot
domain covering both, e.g. `.access.yourcompany.com` — left empty, it
defaults to a host-only cookie, fine for local dev but broken across
subdomains in production. The `deploy/` scaffold's Caddyfile already routes
`manager.<ACCESS_DOMAIN>` and `*.<ACCESS_DOMAIN>` to the right service by
`Host` / `X-Forwarded-Host`; if you're fronting it with your own proxy
instead, replicate that routing and forward those headers.

## Security model

- **Outbound-only connector, no inbound port.** The connector inside your
  network only ever dials out to the data plane over WSS/443; it never
  listens on a socket and never needs a firewall rule opened toward it.
- **Optional egress boundary.** A `Site`'s internal address is set once in
  the Manager and travels with the request through the tunnel to the
  connector, which dials it directly — no per-app config on the connector
  itself. To constrain what a connector may reach regardless of what a Resource
  requests, set `ALLOWED_TARGETS` (CIDRs/hosts) on its container; a target
  outside that boundary is rejected and the stream is closed.
- **Passkey-only identity.** No password exists anywhere in the system —
  WebAuthn passkeys for normal login, TOTP only as a break-glass recovery
  path (itself encrypted at rest, AES-256-GCM).
- **Fail-closed access checks, live on every request.** There is no
  session-level cache: the data plane's proxy resolves the session,
  resolves the hostname to a `Site`, and calls `evaluateAccess()` for that
  user + resource + time before opening a connector stream — on **every**
  request. A missing/expired session redirects to `/login`; a resolved user
  without an active grant gets a 403 with a specific reason (no grant,
  expired, not yet started, revoked, pending approval, or a disabled
  account). Revoking a grant takes effect on the vendor's very next
  request — nothing is cached.
- **Session lifetime policy.** Beyond the per-request grant check, an optional
  console-wide policy (`/admin/policy`) bounds sessions themselves: an idle
  timeout, a maximum absolute duration, and a cap on concurrent sessions per
  user. These limit how long a stolen or forgotten session stays usable,
  independent of grant state.
- **Source-IP allowlist (Zero-Trust network gate).** An optional allowlist
  (`/admin/policy`) restricts which networks may reach published Resources — a
  granted user from a non-allowlisted IP is denied (`ip_not_allowed`, audited)
  before any request reaches a connector. The IP evaluated is the one the
  trusted front proxy records (the rightmost `X-Forwarded-For` hop), so a client
  can't bypass it by forging that header. The admin console is never gated.
- **Time-boxed access.** An optional maximum-grant-duration policy forces every
  grant to carry an end date and caps how long it can last — no standing,
  never-expiring vendor access.
- **Append-only audit log.** Every allowed request, and every denied
  request from an authenticated user, is written to an `AuditEvent` row —
  timestamp, user, resource, host/method/path, response status, bytes out, the
  decision and its reason, client IP, and user agent. Anonymous requests
  that simply redirect to `/login` aren't logged (there's no identity yet
  to attribute them to). Rows are denormalized (the user's email and resource's
  name are captured at write time) so the trail still reads correctly after
  the underlying user or resource is later deleted, and are never updated —
  only inserted. Admins can filter, paginate, and export to CSV at
  `/admin/audit`.
- **Retention, not indefinite storage.** `AUDIT_RETENTION_DAYS` (default
  `730`) governs how long rows are kept — set this to match your own
  KVKK/5651 obligations, not just the default. Cleanup isn't automatic:
  wire `POST /api/cron/audit-retention` (Bearer `CRON_SECRET`) into a
  scheduler, e.g. a daily cron entry. The endpoint fails closed — with
  `CRON_SECRET` unset, every call returns `401` and nothing is deleted.
- **Tamper-evident:** rows are hash-chained (each row carries the previous
  row's hash), and the admin console verifies the chain — detecting
  alteration, deletion, splicing, and tail-truncation. An optional **external
  anchor** (a trusted RFC 3161 / KamuSM timestamp on the chain head, enabled
  from Policy and driven by a daily cron) seals it against an actor who can
  rewrite the whole database.

## Roadmap / not yet

Session isolation (the isolated remote browser) has now shipped — see
[Features](#features). The remaining "Pro"-tier items (e.g. file transfer into an
isolated session, a licensing/tier mechanism) are not built yet — don't assume
they exist.

The console is intentionally **English-only** (Turkish localization is not
planned for the console itself; the KVKK/5651 framing is about data behavior,
not UI language).

## Development

Requirements: **Node 20**, **pnpm 9.14.2**, Docker (for local Postgres).

```bash
pnpm install
pnpm dev          # http://localhost:3100
pnpm build        # production build
pnpm test         # vitest
pnpm lint
pnpm typecheck
pnpm db:generate  # regenerate the Prisma client after a schema change
pnpm db:push      # push schema to the database (no migration files yet)
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contributor workflow
and PR checklist.

## License

[Apache License 2.0](./LICENSE).

## Security

This is a security product — please report vulnerabilities responsibly. See
[SECURITY.md](./SECURITY.md). Do not open public issues for security
reports.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
