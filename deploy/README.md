# Production deploy

This directory is a **production** deployment scaffold for Captivo Access:
the published `ghcr.io` images, fronted by [Caddy](https://caddyserver.com/)
for automatic HTTPS, with the Manager console and per-resource vendor proxy
routed to the right service.

It's separate from the repo-root `docker-compose.yml`, which is the
dev/build stack (it builds images locally). Don't use that one in
production — use this directory instead.

## Quick start (one command)

Point DNS first — `manager.<domain>`, `connect.<domain>`, and `*.<domain>`
(wildcard) at this host's public IP, with ports 80 + 443 open — then:

```bash
./setup.sh access.example.com
```

`setup.sh` generates `.env` (deriving `COOKIE_DOMAIN` / `MANAGER_PUBLIC_URL` /
`WEBAUTHN_RP_ID` from the domain and creating all secrets once), pulls the
published images, and runs `docker compose up -d`. It's idempotent — re-run any
time. Then open `https://manager.<domain>/` and complete first-run admin setup.
The rest of this document is the reference for what it sets up and how to tune it.

## Architecture recap

- **`access-manager`** (Next.js, `:3100`) — the console: setup, auth,
  invites, admin, APIs. Not published to the host; only Caddy reaches it.
- **`access-dataplane`** (Go) — three listeners, **none published to the
  host**; Caddy terminates TLS and reverse-proxies to each by service name:
  - `:3101` — connector WSS. The data-plane serves this as **plain HTTP**
    (no TLS of its own), so Caddy fronts it at `connect.<ACCESS_DOMAIN>` and
    connectors dial *in* over `wss://connect.<ACCESS_DOMAIN>`. Publishing 3101
    raw would carry the tunnel unencrypted over the internet — don't.
  - `:3102` — internal API (Manager ↔ data-plane). Never exposed off-network.
  - `:3103` — the browser-facing identity-aware proxy that serves vendor
    traffic for `<site>.<ACCESS_DOMAIN>`, fronted by Caddy.
- **`caddy`** — terminates TLS on `:80`/`:443` and reverse-proxies by
  hostname to the two services above, setting `X-Forwarded-Host` /
  `X-Forwarded-Proto` / `X-Forwarded-For` (Caddy does this by default —
  both the Manager and the data-plane's proxy rely on these headers being
  set correctly by the front proxy).
- **`access-postgres`** — not published; only reachable from other
  containers on the compose network.

## Prerequisites

1. A domain you control (e.g. `access.example.com`).
2. DNS records pointing at this host's public IP:
   - `manager.access.example.com` → this host (Manager console)
   - `connect.access.example.com` → this host (connector tunnel — gets its
     own cert automatically via HTTP-01, no plugin needed)
   - `*.access.example.com` → this host (per-resource vendor access — wildcard;
     cert is issued automatically on first use, see [Wildcard TLS](#wildcard-tls) below)
3. Docker + Docker Compose v2 on the host, ports 80 and 443 reachable from
   the internet.
4. Nothing to build — this stack pulls the published `ghcr.io` images
   (`...-manager`, `...-dataplane`, and `...-migrate`, the one-shot
   schema-migration image the Manager waits on). The compose file **pins them
   to a specific release** by default (`${CAPTIVO_VERSION:-<version>}`) so an
   install is reproducible; set `CAPTIVO_VERSION` in `.env` to override or to
   upgrade (see [Updating](#updating)).

## Deploy steps

```bash
cd deploy
cp .env.prod.example .env
# edit .env: fill in ACCESS_DOMAIN and every secret (see the
# `# openssl rand -hex 32` comments in the file for how to generate them)

docker compose -f docker-compose.prod.yml up -d
```

This starts Postgres, the Manager, the data-plane, and Caddy. Caddy will
request certs automatically — the `manager.<ACCESS_DOMAIN>` block works
out of the box via HTTP-01. Watch the logs on first start:

```bash
docker compose -f docker-compose.prod.yml logs -f caddy
```

### Schema migration (automatic)

You don't push the schema by hand. The stack includes a one-shot
`access-migrate` service that pushes the Prisma schema automatically on every
`up -d`, before the Manager starts — idempotent (a no-op when already in sync)
and refusing destructive changes. If it fails, the Manager won't start; check
`docker compose -f docker-compose.prod.yml logs access-migrate`.

### Open it

Go to `https://manager.<ACCESS_DOMAIN>/setup` and register the first
account as a passkey (becomes `ADMIN`). See the repo root
[README](../README.md#how-access-works) for the invite/login flow.

## Wildcard TLS

Each internal app you publish is a `Site` with its own public hostname
(`jira.access.example.com`, `cyberark.access.example.com`, …), and adding one
is a **one-line change in the Manager UI** — no new DNS record and no new
cert to request by hand.

### Default: On-Demand TLS (stock Caddy, no DNS API, no token)

The shipped `Caddyfile` already wildcards `*.{$ACCESS_DOMAIN}` using Caddy's
**On-Demand TLS**: the first time a browser hits a new app hostname, Caddy
asks the Manager (`GET .../api/internal/tls-check?domain=...`) whether that
hostname belongs to a configured `Site` — it only ever issues for hostnames
you've actually published, never arbitrary ones — then completes a normal
ACME **HTTP-01** challenge and caches the cert for future requests. No DNS
plugin, no `DNS_API_TOKEN`, no custom Caddy image, and it works with any DNS
provider.

The only thing this needs is the wildcard `*.access.example.com` `A` record
from [Prerequisites](#prerequisites) above, pointing at this host. Publish a
new app as a `Site` in the Manager UI and the first hit to its hostname
self-provisions the cert — there's nothing else to configure per app, and
nothing further to set up to get here.

### Escape hatch: DNS-01 single wildcard cert (very large deployments)

On-Demand TLS issues one certificate per app hostname, so it's bounded by
Let's Encrypt's per-registered-domain new-certificate rate limit. If you're
publishing enough vendor resources to approach that limit, switch to a **single
DNS-01 wildcard certificate** that covers every current and future hostname
under `*.access.example.com` in one issuance — no per-app certs, no
rate-limit exposure. This requires programmatic access to your DNS zone via
an API (DNS-01 is the only ACME challenge that can prove control of a
wildcard name).

#### The real blocker is your DNS provider's API, not Caddy

DNS-01 needs your DNS host's API — and **many registrars gate or disable it.
GoDaddy, for example, cut off DNS API access in 2024 for accounts with fewer
than 10 domains** ([Let's Encrypt community
thread](https://community.letsencrypt.org/t/godaddy-no-longer-allows-api-access-to-clients-e-g-for-dns-based-cert-renewal-if-you-have-less-than-50-domains/219377)),
so the GoDaddy path simply won't work for most users. Switching ACME tools
(certbot, acme.sh, Caddy) doesn't help — they all need that same API.

#### Recommended: host the DNS zone somewhere with a real API

**Your registrar and your DNS host don't have to be the same company.** Keep
your domain registered wherever it is (GoDaddy, Namecheap, …) and move only the
DNS that DNS-01 needs to a host with a free, first-class API — **without
touching the registrar's (possibly locked-down) API.** Two paths, but they are
not equal in risk:

> ⚠️ **If your access domain is a subdomain of a domain you already use for a
> website or email (e.g. `access.acme.com`, where `acme.com` serves your resource
> and mail), do NOT move that domain's nameservers.** Moving nameservers hands
> the *entire* zone to the new host, and every record you don't recreate there
> (your resource's `A`, `MX`/mail, `SPF`/`DKIM`/`DMARC`) goes dark. Use the
> subdomain path below — it leaves your existing DNS completely untouched.

**Recommended — delegate just the subdomain (deSEC).** Keep the domain's DNS
where it is and hand off only `access.example.com`. Nothing else in the zone
changes; your resource and mail are never at risk. This is the right choice for the
common case: adding vendor access to a domain you already run.

1. [deSEC](https://desec.io/) (free) → **Create domain** → `access.example.com`.
   It gives you its nameservers (e.g. `ns1.desec.io`, `ns2.desec.org`).
2. At your registrar, in the `example.com` zone, add **only** the delegation
   `NS` records (nothing else changes, and you never touch the registrar's
   DNS API):
   ```
   access   NS   ns1.desec.io
   access   NS   ns2.desec.org
   ```
3. In deSEC, add `manager`, `connect`, and `*` `A` records for
   `access.example.com` → the cloud host's IP.
4. Create a token in deSEC's **Token management** and put it in `.env` as
   `DNS_API_TOKEN`. (Its Caddy module is `caddy-dns/desec` — set
   `CADDY_DNS_MODULE=github.com/caddy-dns/desec` in `.env`.)

**Only if the domain is dedicated to this deployment — move the whole zone
(Cloudflare).** Choose this **only** when the domain serves nothing else (no
resource, no mail) or you're deliberately migrating all its DNS to Cloudflare. The
Cloudflare **free plan supports only a full-zone move**, not delegating a lone
subdomain (subdomain-only zones are Enterprise).

1. [Cloudflare](https://www.cloudflare.com/) → **Add a resource** → `example.com`
   (Free). **Recreate every existing record first** (MX/mail, web `A`/`CNAME`,
   TXT) so nothing breaks when nameservers move.
2. At your registrar, change the domain's nameservers to the two Cloudflare
   gave you.
3. In Cloudflare DNS, add `manager`, `connect`, and `*` as `A` records to the
   cloud host's IP — **with the orange proxy cloud OFF ("DNS only") on all of
   them.** A proxied (orange) record makes Cloudflare terminate TLS at its
   edge, which collides with Caddy's own TLS and the connector's WSS tunnel.
   You want DNS + API from Cloudflare, not its proxy. (DNS-01 works either way
   — it only writes a TXT record.)
4. Create a scoped API token: **My Profile → API Tokens → Create Token → "Edit
   zone DNS" → Zone = example.com.** Put it in `.env` as `DNS_API_TOKEN`
   (Cloudflare is the default `CADDY_DNS_MODULE`, so nothing else to set).

**Then, for either path**, Caddy needs a build that includes your provider's
DNS module (the stock `caddy:2-alpine` has none). The repo ships this as an
opt-in — `deploy/Caddy.dns.Dockerfile` (a small xcaddy build, provider set by
the `CADDY_DNS_MODULE` build arg, default Cloudflare) plus
`deploy/docker-compose.dns.override.yml` that wires it in without touching the
base stack. So:

1. Set `DNS_API_TOKEN` in `.env` (and, for a non-Cloudflare provider,
   `CADDY_DNS_MODULE=github.com/caddy-dns/<provider>`).
2. In `Caddyfile`, replace the shipped On-Demand `*.{$ACCESS_DOMAIN}` block's
   `tls { on_demand }` with a `tls { dns ... }` directive for your provider,
   e.g. for Cloudflare:
   ```caddyfile
   *.{$ACCESS_DOMAIN} {
       tls {
           dns cloudflare {$DNS_API_TOKEN}
       }
       reverse_proxy access-dataplane:3103
   }
   ```
   (for deSEC use `dns desec {$DNS_API_TOKEN}`). You can also drop the global
   `on_demand_tls` block at the top of the file — it's unused once no resource
   block references `on_demand`.
3. Bring the stack up with both compose files — the override builds the custom
   Caddy image automatically:
   ```bash
   docker compose -f docker-compose.prod.yml \
     -f docker-compose.dns.override.yml up -d
   docker compose -f docker-compose.prod.yml \
     -f docker-compose.dns.override.yml logs -f caddy   # watch the DNS-01 cert
   ```

Caddy issues the `*.access.example.com` cert via DNS-01. From here,
**publishing a new app is just a `Site` in the Manager UI** — the wildcard
already covers it. (Prefer raw `xcaddy build --with …` and your own image?
That still works — just point the `caddy:` service's `image:` at it instead of
using the override.)

#### Already on a provider with a good API?

If your DNS is already hosted somewhere with an open API (Route 53,
DigitalOcean, Hetzner, deSEC, Cloudflare, …), skip the delegation — just pick
your module from the [`caddy-dns`](https://github.com/caddy-dns) org and
`xcaddy build --with` it, same as above.

## How a vendor reaches an app

Once an admin has created a `Site` — which carries the internal app's
address directly (e.g. `http://10.0.5.20:8080`) — an `AccessGrant`, and the
vendor has registered a passkey, they open `https://<site>.access.example.com`
in their browser. Caddy terminates TLS and forwards to
`access-dataplane:3103`, which checks the session cookie (scoped to
`COOKIE_DOMAIN`, so it's already set from logging in at
`manager.access.example.com`), evaluates the grant, and — if allowed —
streams the request, along with the Resource's internal address, over the
outbound tunnel to the connector running inside the customer's network,
which dials that address. The connector itself takes no `UPSTREAMS`
configuration; the only thing you can set on it is an optional
`ALLOWED_TARGETS` boundary (see [`connector/README.md`](../connector/README.md)).

## Scheduled jobs (cron)

The Manager doesn't run its own scheduler — the cron endpoints are triggered by
the **`access-cron`** container in the Compose stack, which POSTs them on the
internal network with the `CRON_SECRET` Bearer token (health every 5 minutes;
audit + recording retention and the audit-anchor once a day). `./setup.sh` (and
`docker compose … up -d`) start it automatically — **no host crontab needed**.
Check it with `docker logs access-cron`; the console also warns on the Policy page
if a job stops running.

If you run the Manager **outside** the provided compose, trigger the same four
endpoints yourself (`site-health`, `audit-retention`, `recording-retention`,
`audit-anchor`) — e.g. from a host crontab POSTing
`https://manager.<ACCESS_DOMAIN>/api/cron/<name>` with the `CRON_SECRET` bearer.

`POST /api/cron/site-health` opens a **TCP connection** through the connector to
each configured Resource's target — a web-app Resource's internal address, or a
remote-desktop (gateway) Resource's RDP/SSH/VNC host:port — and records the result
(`probedAt`/`probeOk`/`probeDetail`/`probeLatencyMs`) — a successful connect
counts as reachable, a refused/timed-out/tunnel error as unreachable. A
transition (up→down or down→up) also raises an in-console notification and, if
`NOTIFICATION_WEBHOOK_URL` is set, a best-effort webhook. Resources with no target
set yet (no internal address, or a gateway with no credential) are skipped, not
reported unreachable.

`POST /api/cron/audit-retention` deletes audit-log rows older than
`AUDIT_RETENTION_DAYS` (default 730) by sequence prefix, preserving the
tamper-evident hash chain. Leave it unscheduled to keep audit history forever.

`POST /api/cron/audit-anchor` timestamps the audit-log chain head with the RFC
3161 Time-Stamp Authority configured under **Policy → External anchor**, storing
the signed token so history can't be back-dated even by someone with full
database access. It is a no-op unless the feature is enabled and a TSA URL is
set; failures are logged and retried on the next run.

Like the other cron endpoints, both fail closed — with `CRON_SECRET` unset or a
missing/wrong Bearer header they return `401` and do nothing.

## Recorded RDP/SSH/VNC (native remote-desktop gateway)

Console-protocol (RDP/SSH/VNC) sessions are served by a built-in gateway — no
separate pack. Every connector is gateway-capable out of the box: its generated
install command deploys the session engines alongside the connector — **guacd**
(RDP/SSH/VNC) and **KasmVNC** (isolated browser) — and joins the shared
`captivo-gateway` network. Then add a **Remote desktop** Resource (protocol, host,
port, and vault credentials) and vendors connect straight from `/access`,
streamed in-browser and recorded natively (replayable at `/admin/recordings`).

Admins can watch an in-progress remote-desktop session live at `/admin/live` and
take control; guacd's own logs appear on the connector's detail page ("Gateway
logs") for troubleshooting connection or authentication failures.

## Updating

The images are **pinned to a release** (`CAPTIVO_VERSION`, default set in the
compose file), so `pull` alone stays on your current version — upgrading is a
deliberate version bump:

```bash
git pull                                   # picks up a newer default version + any compose/Caddyfile change
# or, to choose a version explicitly, set CAPTIVO_VERSION=<release> in .env
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Check the latest release tags at
`https://github.com/captivo-io/captivo-access/releases`. The schema migrates
automatically on `up -d` (the `access-migrate` service). Connectors run on
their own hosts — update each with `docker pull …connector:latest` + recreate
(the token in `/data` persists). Every release republishes the connector image
in lockstep with the server, so a `:latest` connector stays compatible with a
server tracking the latest release. If you pin the server to an *older* release,
pin the connector to that same `:<version>` so the two don't drift.
