# Quickstart — see it work in ~5 minutes (zero DNS)

This is the fastest way to watch a real end-to-end flow — a browser reaching an
internal app through Captivo Access with real HTTPS — **without configuring any
DNS**. It's for evaluation; for a real deployment see
[`deploy/README.md`](../deploy/README.md).

The trick: [**sslip.io**](https://sslip.io/) is a public wildcard DNS service
that resolves `anything.<your-ip>.sslip.io` to `<your-ip>` automatically. So you
get real, publicly-resolvable hostnames — and therefore real Let's Encrypt
certificates — with no DNS records to create.

## What you need

- A server with a **public IP**, **ports 80 and 443 open** to the internet, and
  Docker + Docker Compose v2. (A cheap throwaway VPS is perfect. Don't reuse a
  box that already serves a resource or mail on 80/443.)
- 5 minutes.

Throughout, replace `SERVER_IP` with your server's public IP written with dots,
e.g. `203.0.113.10`.

## 1. Get the repo and configure

```bash
git clone https://github.com/captivo-io/captivo-access.git
cd captivo-access/deploy
cp .env.prod.example .env
```

Edit `.env` — set the domain to your sslip.io name and generate the secrets:

```bash
ACCESS_DOMAIN=SERVER_IP.sslip.io
COOKIE_DOMAIN=.SERVER_IP.sslip.io
MANAGER_PUBLIC_URL=https://manager.SERVER_IP.sslip.io
WEBAUTHN_RP_ID=SERVER_IP.sslip.io
# then fill POSTGRES_PASSWORD / SESSION_SECRET / ENCRYPTION_KEY /
# DATAPLANE_SECRET / CRON_SECRET — each: openssl rand -hex 32
```

## 2. TLS is automatic — no Caddyfile edit

The shipped `Caddyfile` already serves `manager.` and `connect.`, **and** a
wildcard `*.{$ACCESS_DOMAIN}` block (On-Demand TLS, gated by the Manager) that
covers every per-resource vendor hostname automatically. Any app hostname you add
later — e.g. `app.SERVER_IP.sslip.io` — falls under that wildcard, so there's
nothing to edit here: you just pick the hostname when you create the Resource (step
6). Move on.

## 3. Bring it up

```bash
docker compose -f docker-compose.prod.yml up -d
```

The schema is pushed automatically by the one-shot `access-migrate` service on
`up -d` — nothing to run by hand.

Watch the certs get issued: `docker compose -f docker-compose.prod.yml logs -f caddy`.

## 4. Run a dummy "internal app"

Any web app works. This one just echoes request info:

```bash
docker run -d --name testapp --network captivo-access-prod_default nginxdemos/hello
```

The connector will reach it at `http://testapp:80` on the compose network.

## 5. First admin

Open `https://manager.SERVER_IP.sslip.io/setup` and register with a passkey
(this account becomes ADMIN). On Windows, pick **Windows Hello** in the passkey
dialog — if it only offers a USB security key, set up a Windows Hello PIN first
(Settings → Accounts → Sign-in options → PIN).

## 6. Define the app and enroll a connector

In the console:

1. **Connectors → add one** and copy the `PAIR_CODE` it shows. For this
   single-box quickstart, **don't run the generated command** (it deploys three
   containers on the `captivo-gateway` network, where they can't reach `testapp`
   on the compose network). Instead run this simplified single-container version
   on the compose network, pointed at the internal service names (simpler and
   more reliable for an all-in-one-box test):

   ```bash
   docker run -d --name access-connector --restart unless-stopped \
     --network captivo-access-prod_default \
     -e MANAGER_URL=http://access-manager:3100 \
     -e DATAPLANE_URL=ws://access-dataplane:3101 \
     -e PAIR_CODE=<paste from the console> \
     -v access_connector_data:/data \
     ghcr.io/captivo-io/captivo-access-connector:latest
   ```

   It should show as **online** in the console shortly. No per-app config is
   needed here — the connector takes no `UPSTREAMS` (only an optional
   `ALLOWED_TARGETS` boundary, unneeded for this quickstart).

2. **Resources → add one.** Name it, set the **hostname** to just `app` (the
   field shows your `.SERVER_IP.sslip.io` domain suffix automatically),
   **internal address** = `http://testapp:80` (the dummy app's address on the
   compose network), and bind it to your connector.

3. **Grants → grant yourself access** to that resource (or invite a second user and
   grant them).

## 7. See it work

Open `https://app.SERVER_IP.sslip.io`. You sign in with your passkey, the access
decision is checked, and the request is tunnelled out to the connector and into
the dummy app — you see its response. Revoke the grant and reload: **403**.

That's the whole product, running with real TLS and zero DNS setup. When you're
ready for a real deployment (your own domain, wildcard so new apps are UI-only),
follow [`deploy/README.md`](../deploy/README.md).

## 8. Optional: a remote-desktop (SSH) resource (+a few minutes)

Captivo Access also serves **RDP/SSH/VNC** in the browser through a native
gateway (guacd) — no separate install. RDP needs a Windows target, but **SSH**
lets you try it end-to-end with a throwaway container. The vendor never sees the
password: it's stored encrypted and injected server-side.

> **On by default.** The "Remote session" Resource type and its credential vault
> are enabled out of the box (`NATIVE_GATEWAY` / `VAULT_ENABLED`), and the connector
> already bundles the gateway engines — nothing to turn on. (If a prior operator
> disabled them, remove `NATIVE_GATEWAY=0` / `VAULT_ENABLED=0` from the Manager's
> `.env` and restart: `docker compose up -d access-manager`. Isolated browser is
> likewise on by default via `ISOLATED_ENABLED`.)

1. **Install a connector (if you haven't already).** Every connector is
   gateway-capable out of the box — its install command
   (`/admin/connectors` → **Add connector**, or **Update** on an existing one)
   creates the `captivo-gateway` network and deploys both session engines
   alongside the connector: **guacd** (RDP/SSH/VNC) and **KasmVNC** (isolated
   browser). One command, nothing else to install.

2. **Run a throwaway SSH target** on that gateway network:

   ```bash
   docker run -d --name sshtarget --restart unless-stopped \
     --network captivo-gateway \
     -e PUID=1000 -e PGID=1000 \
     -e USER_NAME=demo -e USER_PASSWORD=demo -e PASSWORD_ACCESS=true \
     linuxserver/openssh-server
   ```

   guacd reaches it at `sshtarget:2222` on the shared network.

3. **Add a Remote session Resource.** In the console: **Resources → add**, choose
   **Remote session (RDP / SSH / VNC)**, protocol **SSH**, host `sshtarget`,
   port `2222`, username `demo`, password `demo`, and bind it to your connector.
   (Optionally turn on **Record sessions**.)

4. **Grant yourself** access to it, then open it from **My access** (`/access`).
   You get an SSH terminal **in the browser** — you never typed the password, and
   there's no second login.

5. **See the extras (optional).** With recording on, the session is replayable at
   `/admin/recordings`; while it's open, an admin can watch it live and take
   control at `/admin/live`; and guacd's logs show on the connector's detail page
   ("Gateway logs").

Cleanup for this part: `docker rm -f sshtarget captivo-guacd` (and remove the
Resource/connector in the console).

> **A third access method: isolated browser.** On the same connector you can
> also run a Resource as an **Isolated browser** (`ISOLATED`): the internal web app
> opens inside a throwaway, server-side browser and only pixels stream to the
> vendor — nothing lands on their machine. It adds clipboard DLP, an optional screen
> watermark, per-direction file transfer (off by default), and a seekable recording.
> See [`how-it-works.md`](how-it-works.md#the-isolated-browser-path-isolated).

## Cleanup

```bash
docker rm -f access-connector testapp sshtarget captivo-guacd captivo-kasm
docker network rm captivo-gateway
docker volume rm access_connector_data captivo_guacd_recordings captivo_guacd_logs captivo_guacd_drive captivo_kasm_logs
docker compose -f docker-compose.prod.yml down -v
```

(`down -v` only removes the compose project's own volumes; the connector-created
containers, network, and volumes above are separate and must be removed explicitly.)
