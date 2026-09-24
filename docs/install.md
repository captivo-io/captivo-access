# Install Captivo Access — a complete, worked walkthrough

This guide takes you from a **bare server** to a **working deployment with your
first vendor connected to an internal app**, step by step, with a single running
example you can follow line by line.

It's the long-form companion to [`deploy/README.md`](../deploy/README.md) (the
production reference) — this file is the linear "do these things in order"
version. If you just want a 5-minute local taste with no DNS, see
[`docs/quickstart.md`](quickstart.md) instead.

> **In a hurry?** Once DNS points `manager.<domain>`, `connect.<domain>`, and
> `*.<domain>` at your host, the whole stack is one command:
> `cd deploy && ./setup.sh <your-domain>` (it generates `.env` + secrets and runs
> `docker compose up -d`). This walkthrough explains every piece that command sets up.

> **The example used throughout.** Substitute your own values everywhere you see
> these:
>
> | Thing | Example value |
> |---|---|
> | Registered domain | `acme.com` |
> | Access subdomain (where everything lives) | `access.acme.com` |
> | Server public IP | `203.0.113.10` |
> | An internal app to publish | a wiki at `http://10.0.5.20:8080` |
> | Its public hostname | `wiki.access.acme.com` |
> | The vendor you'll invite | Dana (`dana@contractor.example`) |
>
> Your internal network (where the connector runs) is `10.0.5.0/24` in the example.

At the end, Dana opens `https://wiki.access.acme.com` in a browser, signs in with
a passkey, and reaches your internal wiki — **without a VPN and without any
inbound port open on your network.**

---

## What you'll set up (the whole picture in one breath)

Four containers on one public server (the **Manager** console, a Go **data-plane**,
**Postgres**, and **Caddy** for automatic HTTPS), plus a small **connector** you
run *inside* your own network. The connector dials **out** to the data-plane, so
your network needs no inbound firewall hole. Vendors hit
`https://<app>.access.acme.com`, authenticate with a passkey at the Manager, and
the data-plane streams allowed requests through the tunnel to the connector,
which reaches the internal app.

---

## Step 1 — Get a server and open the right ports

You need a Linux host (Ubuntu 22.04+ in this guide) with a **public IP** and
**ports 80 and 443 reachable from the internet** (Let's Encrypt validates certs
over these).

```bash
# On the server, as root or with sudo:
apt update && apt -y upgrade

# Allow SSH + HTTP + HTTPS through the firewall (if you use ufw):
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

Nothing else needs to be open inbound. (The connector, later, runs elsewhere and
needs only outbound access.)

## Step 2 — Install Docker + Docker Compose v2

```bash
curl -fsSL https://get.docker.com | sh
docker version          # confirm the engine is running
docker compose version  # must be v2 (the "compose" subcommand, not docker-compose)
```

## Step 3 — Point DNS at the server

Add **three records** in your DNS provider, all pointing at the server's public
IP. The third is a **wildcard** — one record that covers every current and future
vendor app, so you never touch DNS again per app.

| Type | Name | Value |
|---|---|---|
| A | `manager.access` | `203.0.113.10` |
| A | `connect.access` | `203.0.113.10` |
| A | `*.access` | `203.0.113.10` |

(Most providers let you enter the name relative to the zone. If yours wants the
full name, use `manager.access.acme.com`, `connect.access.acme.com`,
`*.access.acme.com`.)

**No certificate/API token is needed for DNS.** A wildcard *DNS record* is not the
same as a wildcard *certificate* — the record just says "where," and Caddy issues
each app's certificate automatically later (see Step 8). Any DNS provider works,
including registrars whose certificate API is locked down.

> Wait a few minutes and confirm the records resolve before continuing:
> ```bash
> dig +short manager.access.acme.com     # → 203.0.113.10
> dig +short anything.access.acme.com     # → 203.0.113.10  (proves the wildcard)
> ```

## Step 4 — Get the deploy files and fill in `.env`

On the server:

```bash
git clone https://github.com/captivo-io/captivo-access.git
cd captivo-access/deploy
cp .env.prod.example .env
```

Generate five secrets — run this once per secret and paste each into `.env`:

```bash
openssl rand -hex 32
```

Now edit `.env`. Every variable, with an example value:

| Variable | Example | What it is |
|---|---|---|
| `ACCESS_DOMAIN` | `access.acme.com` | The base domain everything is served under. |
| `COOKIE_DOMAIN` | `.access.acme.com` | **Leading dot** — lets the login cookie from the Manager also work on every `<app>.access.acme.com`. Get this wrong and vendors log in but bounce back to login on the app. |
| `MANAGER_PUBLIC_URL` | `https://manager.access.acme.com` | The Manager's public URL (used for login redirects and the console's "Custom domain" page). |
| `WEBAUTHN_RP_ID` | `access.acme.com` | Passkey Relying-Party ID. Use the **bare** `ACCESS_DOMAIN` (not `manager.`), so passkeys are valid across the whole domain. Must match the host the browser uses, or passkey setup/login fails. |
| `POSTGRES_PASSWORD` | `<openssl rand -hex 32>` | Database password. |
| `SESSION_SECRET` | `<openssl rand -hex 32>` | Signs session tokens. |
| `ENCRYPTION_KEY` | `<openssl rand -hex 32>` | Encrypts TOTP recovery secrets (AES-256-GCM). |
| `DATAPLANE_SECRET` | `<openssl rand -hex 32>` | Shared secret between Manager and data-plane. |
| `CRON_SECRET` | `<openssl rand -hex 32>` | Authorizes the cron endpoints (Step 12). |
| `AUDIT_RETENTION_DAYS` | `730` | Initial audit-log retention (days). Also editable later on the **Policy** page. |

> **Most operational settings are now managed from the console** (Policy page),
> not the environment: audit-log retention, session-recording retention, the
> recording-consent gate, the notification webhook, invitation-link lifetime,
> the source-IP allowlist, the maximum grant duration, and session limits. The
> matching env vars (`AUDIT_RETENTION_DAYS`, `INVITE_TTL_HOURS`,
> `NOTIFICATION_WEBHOOK_URL`, `RECORDING_CONSENT_REQUIRED`, `SESSION_TTL_HOURS`)
> still work as the initial default, but the value set in the UI always wins —
> so you don't need to set them here.

Leave the optional/commented ones (`DNS_API_TOKEN`, `CADDY_DNS_MODULE`,
`RECORDING_ENABLED` (Pro session recording — gates the per-Resource "Record
sessions" toggle), `NATIVE_GATEWAY` (Pro remote-desktop gateway — gates the
"Remote session" (RDP/SSH/VNC) Resource type; `captivo-guacd` is bundled with
every connector, this makes it usable), `VAULT_ENABLED` (Pro credential vault —
stores per-Resource RDP/SSH/VNC logins, injected server-side; required for
remote-session logins), `ISOLATED_ENABLED` (Pro isolated browser — gates the
"Isolated browser" Resource type; the `captivo-kasm` (KasmVNC) container is bundled
with every gateway connector and reverse-proxied at `/kasm-tunnel`, so host-nginx
deployments must route `/kasm-tunnel` (and `/kasm-tunnel/`) and `/kasm-view` (and
`/kasm-view/`, the admin live-watch relay) to the data-plane like `/guac-tunnel`,
and if you set the connector's `ALLOWED_TARGETS` it must include
`captivo-kasm:6901` and `captivo-kasm:7900`, like `captivo-guacd:4822`),
`CONNECTOR_TUNNEL_URL` (overrides the default
`wss://connect.<ACCESS_DOMAIN>` endpoint)) alone unless you know you need them. `DNS_API_TOKEN` is **only** for the large-scale wildcard-certificate escape
hatch — you do not need it for a normal install.

The four Pro capability flags (`RECORDING_ENABLED`, `NATIVE_GATEWAY`,
`VAULT_ENABLED`, `ISOLATED_ENABLED`) are **on by default** — leaving them
commented keeps the features enabled; set one to `0` only to disable it.

**Never commit `.env`.** It holds every secret.

## Step 5 — Bring the stack up

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps      # all services "running"/"healthy"
docker compose -f docker-compose.prod.yml logs -f caddy   # watch the first cert issue
```

Caddy fetches the `manager.access.acme.com` and `connect.access.acme.com`
certificates automatically over HTTP-01 (that's why ports 80/443 must be open).
Give it a minute; `Ctrl-C` out of the logs once you see certificates obtained.

## Step 6 — Schema migration (automatic)

You don't run anything here. The stack includes a one-shot `access-migrate`
service that pushes the Prisma schema to Postgres automatically every time you
`up -d` (Step 5), before the Manager starts. It's idempotent — a no-op when the
schema is already in sync — and refuses any destructive change, so it can't
silently drop data. If it ever fails, the Manager won't start; check
`docker compose -f docker-compose.prod.yml logs access-migrate`.

## Step 7 — Create the first admin

Open **`https://manager.access.acme.com/setup`** and register the first account
with a **passkey** (Touch ID / Windows Hello / a security key). This account
becomes the `ADMIN`. There is no default/seed account.

> Passkey fails with "Something went wrong"? See
> [Troubleshooting](#troubleshooting) — it's almost always `WEBAUTHN_RP_ID` not
> matching the host in your browser's address bar.

## Step 8 — Verify DNS + TLS from the console

In the console, open **Custom domain** (under Infrastructure). It shows the exact
wildcard record for your domain and your server's IP, and a **Verify DNS** button.
Click it — a green result means the wildcard record is live and new apps will get
HTTPS automatically. (If it's red, fix the `*.access.acme.com` record from Step 3
and retry; DNS can take a few minutes.)

There's nothing to configure for per-app TLS: the shipped Caddy uses **On-Demand
TLS** — the first time a browser hits `wiki.access.acme.com`, Caddy asks the
Manager "is this a real Resource?" and, if yes, issues that app's certificate over
HTTP-01 and caches it. No token, no per-app setup.

## Step 9 — Enroll a connector (inside your network)

The connector is the piece that runs **inside** your network and reaches the
internal app. It only dials outward — no inbound port.

1. In the console: **Connectors → Add connector**. The Manager shows a ready-to-run
   command with your `MANAGER_URL`, `DATAPLANE_URL`, and a one-time `PAIR_CODE`
   already filled in. **Copy it.**
2. On a machine inside `10.0.5.0/24` that can reach the wiki, run that command.

   The console's command is a single line that installs three containers on a
   private Docker network — one command, nothing else to install:

   - **`access-connector`** — the outbound connector agent. Its token lives in the
     `access_connector_data` volume, so it reconnects after restarts without the
     pairing code.
   - **`captivo-guacd`** — the session engine for recorded remote-desktop
     resources (RDP/SSH/VNC).
   - **`captivo-kasm`** — the isolated-browser engine (KasmVNC) for isolated-browser
     resources.

   Every connector is gateway- and isolated-capable out of the box — there is no
   separate mode to toggle. A simplified view of the connector container itself
   (the console's real command is longer and also starts the two engines above):

   ```bash
   docker run -d \
     --name access-connector --restart unless-stopped \
     -e MANAGER_URL=https://manager.access.acme.com \
     -e DATAPLANE_URL=wss://connect.access.acme.com \
     -e PAIR_CODE=<one-time code from the console> \
     -v access_connector_data:/data \
     ghcr.io/captivo-io/captivo-access-connector:latest
   ```

   > **Always copy the full command from the console** rather than hand-writing it
   > — it comes pre-filled with your URLs and pairing code and also starts the
   > guacd + KasmVNC engines. Optionally add `-e ALLOWED_TARGETS=10.0.5.0/24` to
   > the connector to hard-limit what it may ever reach. For more on recorded
   > remote-desktop sessions, see
   > [remote-desktop gateway](../deploy/README.md#recorded-rdpsshvnc-native-remote-desktop-gateway).
3. Back in the console, the connector flips to **Online** within a few seconds.

## Step 10 — Publish your first app as a Resource

In the console: **Resources → Add resource**.

- **Name:** `Internal Wiki`
- **Hostname:** `wiki.access.acme.com` (a subdomain under your wildcard — no new
  DNS needed)
- **Internal address:** `http://10.0.5.20:8080` (the address the *connector*
  reaches, not the browser)
- **Connector:** the one you enrolled in Step 9

Save. That's the entire per-app setup — no DNS record, no certificate, no Caddy
edit. The first visit to `wiki.access.acme.com` self-provisions its TLS cert.

## Step 11 — Give a vendor access

1. **Invite the vendor.** People → Invites → invite `dana@contractor.example` with
   role **Vendor** (external supplier) or **Staff** (your own employee — same
   access, different label; see [Roles](#roles)). If SMTP is configured
   (**Email** page), Dana gets the invite by mail; otherwise copy the one-time
   invite link and send it yourself.
2. **Grant access.** Grants → New grant → user Dana, resource `Internal Wiki`.
   Optionally time-box it (start/end), require approval, or attach a weekly
   schedule. Leave the window empty for permanent access.
3. **Dana enrolls + connects.** Dana opens the invite link, registers a passkey,
   then opens `https://wiki.access.acme.com` — signs in once at the Manager and
   lands on your internal wiki. Every request is checked against the grant and
   recorded in the audit log.

Done — your first vendor is reaching an internal app with no VPN and no inbound
port on your network.

## Roles

Assign the least privilege that fits. Roles govern the **admin console** only —
reaching an app is always controlled by grants, independent of role (any role,
including Admin, connects only where it's been granted).

| Role | Can do | Typical use |
|---|---|---|
| **Admin** | Everything: connectors, resources, users, invites, email, sessions, grants, audit | The operator(s) running the deployment |
| **Operator** | Approve/deny/revoke/create grants + view the console | Day-to-day access approvers, help desk |
| **Auditor** | Read-only console: audit log (+ CSV), resources, grants — no changes | Compliance / security reviewers |
| **Staff** | Connect-only (like Vendor), internal identity | Your own employees needing app access |
| **Vendor** | Connect-only | External suppliers |

Staff vs Vendor is the same access with a distinct identity — the difference shows
up in the audit log (alongside the Company column) so you can tell internal from
external access at a glance.

## Step 12 — Schedule the maintenance jobs (cron)

Scheduling is **automatic**: the `access-cron` container in the Compose stack POSTs
the four cron endpoints on the internal network with the `CRON_SECRET` bearer
token (`site-health` every 5 minutes; `audit-retention`, `recording-retention`,
and `audit-anchor` once a day). `./setup.sh` and `docker compose … up -d` start it
for you — no host crontab required. Watch it with `docker logs access-cron`.

If you run the Manager outside the provided `docker-compose.prod.yml`, trigger the
same endpoints yourself from the host's cron, POSTing
`https://manager.<your-domain>/api/cron/<name>` with the `CRON_SECRET` bearer token.

Resource-health records reachability and raises an in-console notification (and an
optional `NOTIFICATION_WEBHOOK_URL` alert) when a Resource goes up or down.
Audit-retention deletes rows older than `AUDIT_RETENTION_DAYS` while preserving
the tamper-evident hash chain. Both fail closed without a valid `CRON_SECRET`.

## Updating

```bash
cd captivo-access/deploy
git pull
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The schema is migrated automatically on `up -d` (the `access-migrate` service) —
nothing to run by hand. Connectors run on their own hosts and are **not** touched
by this command; update each with `docker pull …connector:latest` + recreate (the
token in `/data` persists, so no re-enrollment). The console's **Updates** page
shows the exact commands when an update is available.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Passkey setup/login fails ("Something went wrong") at `/setup` | `WEBAUTHN_RP_ID` doesn't match the host in the browser | Set `WEBAUTHN_RP_ID=access.acme.com` (the bare access domain), restart the manager, retry. It must be equal to, or a parent of, the host you actually open. |
| An app hostname shows a TLS/certificate error | Wildcard `*.access` A record missing, or the hostname isn't a configured Resource | Run **Custom domain → Verify DNS** in the console. Confirm the Resource exists (Caddy only issues certs for real Resources). Fresh DNS can take a few minutes. |
| New connector stays **Offline** | Wrong `DATAPLANE_URL` (must be `wss://connect.…`, not `ws://`), or the machine can't reach the internet outbound | Re-copy the exact command from the console; verify the connector host can reach `connect.access.acme.com:443` outbound; check `docker logs access-connector`. |
| Opening an app returns **502** | Connector can't reach the Resource's internal address, or `ALLOWED_TARGETS` blocks it | Check the internal address is what the *connector* can reach (`http://10.0.5.20:8080`); if `ALLOWED_TARGETS` is set, ensure the target is inside it; confirm the app is up from the connector's host. |
| Vendor logs in but the app bounces back to login | `COOKIE_DOMAIN` wrong | It must be the **leading-dot** form `.access.acme.com`, restart the manager. |
| Invite emails don't arrive | SMTP not configured/enabled | Configure it on the **Email** page (and tick *Enabled*). Until then, copy the one-time invite link from the Invites screen and send it manually. |
| `access-migrate` fails / Manager won't start | Wrong `POSTGRES_PASSWORD`, Postgres unhealthy, or a destructive schema change | Check `docker compose -f docker-compose.prod.yml logs access-migrate`; ensure `access-postgres` is healthy and `POSTGRES_PASSWORD` matches `.env`. A refused destructive change is intentional (no data loss). |

## Where to go deeper

- [`deploy/README.md`](../deploy/README.md) — production reference: architecture,
  the DNS-01 single-wildcard-certificate **escape hatch** for very large
  deployments, and provider-delegation recipes (deSEC / Cloudflare).
- [`connector/README.md`](../connector/README.md) — connector environment
  variables, `ALLOWED_TARGETS`, and building from source.
- [`deploy/README.md`](../deploy/README.md#recorded-rdpsshvnc-native-remote-desktop-gateway)
  — the native remote-desktop gateway (bundled with the connector) for recorded
  RDP/SSH/VNC access.
- [`docs/how-it-works.md`](how-it-works.md) — the journey of a single request, in
  plain terms.
- [`docs/quickstart.md`](quickstart.md) — a zero-DNS local demo in ~5 minutes.
