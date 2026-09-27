# How Captivo Access works

A plain walkthrough: first how the pieces fit together and how you set them up,
then the exact path a single request takes from a vendor's browser to an
internal web app — and every gate it passes through on the way.

Captivo Access gives outside users **time-boxed, audited access to specific
internal web apps and remote desktops (RDP/SSH/VNC)** — without a VPN, without
opening inbound ports, and without ever exposing the apps' real addresses. The
walkthrough below follows a web app; [the remote-desktop path](#the-remote-desktop-path-gateway)
is the same gates with a different tail.

---

## Setup, in plain terms

The whole thing is **two pieces**:

| Piece | Where it runs | What it is |
|---|---|---|
| **Manager** | your cloud (internet-facing) | The front door: identity (passkey/SSO), the admin console, and the access policy. Admins sign in at this address; vendors don't — they reach per-app hostnames served by a companion identity-aware proxy (below). |
| **Connector** | deep inside your network | A small agent that dials **outbound only** — no inbound port is ever opened to it. It's the only thing that reaches your internal apps, and their real addresses never leave your network. It also **stores the session recordings**, encrypted with a key it generates and never sends anywhere. |

Setting it up:

1. **Prepare a server and a subdomain.** A cloud server, and a subdomain
   pointing at it (`access.yourdomain.com`). Set up DNS the safe way — if it's a
   subdomain of a domain you already use for a resource or email, delegate *just*
   that subdomain (see [`deploy/README.md`](../deploy/README.md)); never move the
   parent domain's nameservers.
2. **Install Captivo Access.** One `docker compose … up -d` on the server brings
   up the Manager, its database, and the proxy, with automatic HTTPS. Nothing to
   build — it pulls the published images.
3. **Create the first admin.** Open `manager.access.yourdomain.com/setup` and
   register yourself with a **passkey**. No passwords — your device is the key.
4. **Install a connector inside your network.** In the admin console you create a
   connector and get a ready-to-run `docker run` command. Run it on a machine
   inside your network; it dials out and shows up as online.
5. **Define two things: the app, and who.** A **Resource** = which internal app
   (e.g. `jira.access.yourdomain.com` → the app's real internal address, set
   directly on the Resource — the connector itself needs no per-app config; it
   just dials whatever address the Resource sends it, optionally bounded by
   `ALLOWED_TARGETS` on the connector's container).
   An **access grant** = invite the user (they register a passkey) and grant them
   that Resource — optionally time-boxed, approval-gated, or on a recurring schedule
   ("weekdays 09:00–18:00").
6. **Done.** The user signs in from their browser and reaches only the apps
   they're allowed to.

---

## The journey of a single request

**Scenario:** a vendor types `jira.access.yourdomain.com` into their browser.
Every request travels this path. A solid arrow is the path continuing; a
branch labelled **no** is a rule that stops the request.

```mermaid
flowchart TD
    A["Browser<br/>https://jira.access.yourdomain.com"] --> B["DNS routes to your cloud host<br/>Caddy terminates TLS"]
    B --> C["Identity-aware proxy :3103"]
    C --> G1{"Gate 1<br/>Signed in?"}
    G1 -->|no| L["Redirect to login<br/>(passkey)"]
    G1 -->|yes| M{"Which Resource?<br/>match by hostname"}
    M -->|no match| E404["404"]
    M -->|matched| G2{"Gate 2 — allowed?<br/>grant · approval · schedule"}
    G2 -->|no| E403["403<br/>no grant / pending / off-hours / denied / expired"]
    G2 -->|yes| T["Outbound tunnel to connector<br/>carries the Resource's internal address"]
    T --> G3{"Gate 3<br/>within ALLOWED_TARGETS?<br/>(optional boundary)"}
    G3 -->|no| E502["502"]
    G3 -->|yes| APP["Internal app<br/>http://10.0.5.20:8080"]
    APP --> R["Response flows back<br/>connector → tunnel → proxy → browser"]

    classDef deny fill:#3b1b20,stroke:#ff6b7a,color:#ffc2c8;
    classDef ok fill:#123027,stroke:#42d19a,color:#bff3df;
    class L,E404,E403,E502 deny;
    class R ok;
```

Step by step:

1. **The browser opens the address.** `jira.access.yourdomain.com` is a public
   *front-door* name you invented — not the real Jira address.
2. **DNS + TLS.** DNS sends that name to your cloud host, where **Caddy**
   terminates HTTPS. The real internal addresses never touch public DNS.
3. **The proxy receives it.** All `*.access.yourdomain.com` traffic lands on one
   identity-aware proxy. From here, three gates.
4. **Gate 1 — Signed in?** The proxy looks for a valid session cookie (has the
   user signed in with their passkey?). **If not → redirect to login**; after the
   passkey ceremony the user returns to where they were.
5. **Which Resource?** The proxy matches the request's hostname to a defined **Resource**.
   **No matching Resource → 404.** An address you never defined leads nowhere.
6. **Gate 2 — Allowed?** The real decision (`evaluateAccess`): does this user have
   a **grant** for this Resource — is it **approved**, and within its **time window**
   and **recurring schedule**? **If not → 403**, with a specific reason: no grant,
   pending approval, outside hours, denied, or expired.
7. **Outbound tunnel.** The proxy sends the request, along with the Resource's
   internal address, through the connector's **outbound-only** tunnel. The
   cloud never dials into your network — the connector always opened the
   connection.
8. **Gate 3 — Within the boundary?** The connector dials the internal address
   defined on the Resource (`http://10.0.5.20:8080`). If the connector's container
   has an optional `ALLOWED_TARGETS` boundary set, the address must fall
   inside it. **Outside it → 502.** Left unset, the connector dials whatever
   address the Manager routes to it.
9. **The internal app responds.** Jira (or whatever it is) sees the request and
   produces its response, as if the user were on the internal network.
10. **The response flows back** — connector → tunnel → proxy → Caddy → browser.
    The user sees Jira. They never "entered" the network; they only spoke to the
    one app they're allowed to, from behind the gates.

> **And all of it is recorded.** Every allow and every deny on this path is
> written to an append-only, hash-chained audit log — who, when, which app, which
> decision. That tamper-evident trail is what backs the compliance story
> (KVKK / Law No. 5651).

> **A few variations on the same path.** WebSocket apps (e.g. a browser-based
> console) are relayed the same way; **web sessions can be recorded** per Resource
> (AES-256-GCM at rest **on the connector's own disk**, never in the control plane) and replayed in the console; internal staff/admins can optionally sign in via
> **SSO/OIDC** instead of a passkey; and **RDP/SSH/VNC** sessions take
> [the remote-desktop path](#the-remote-desktop-path-gateway) below. Who can do
> what in the console is governed by five roles (`ADMIN`, `OPERATOR`, `AUDITOR`,
> `STAFF`, `VENDOR`).

> **Extra policy gates (optional).** Gate 2 can carry more than the grant: a
> **source-IP allowlist** rejects access from networks you didn't approve, a
> **maximum grant duration** stops anyone handing out never-expiring access, and
> **session limits** (idle / max-lifetime / concurrency) bound the login itself.
> All of these live on the console's **Policy** page and apply live.

---

## The remote-desktop path (gateway)

A **Remote desktop** Resource (RDP/SSH/VNC) passes the same first two gates, but its
tail is different: instead of an HTTP round trip to an internal app, the browser
runs a live session rendered by **guacd** — the remote-desktop engine every
connector deploys on its own host, alongside the connector itself. The
target's credential lives **encrypted** in the vault; only the data-plane
decrypts it, per session, to hand to guacd, so the vendor never sees the
password and the "internal app" is a live screen streamed to the browser.

```mermaid
flowchart TD
    A["Vendor browser<br/>Remote desktop session"] -->|"WSS /guac-tunnel"| C["Data-plane :3103"]
    C --> G1{"Gate 1<br/>Signed in?"}
    G1 -->|no| L["Unauthorized"]
    G1 -->|yes| G2{"Gate 2 — allowed?<br/>grant · approval · schedule"}
    G2 -->|no| E403["Forbidden"]
    G2 -->|yes| CR["Decrypt the vault credential<br/>(server-side only)"]
    CR -->|outbound tunnel| GD["guacd on the connector host<br/>opens RDP/SSH/VNC to the target<br/>credential injected"]
    GD --> SCR["Live screen streamed to the browser<br/>(recorded if enabled)"]
    ADM["Admin · /admin/live"] -->|"join by connection ID (WSS /guac-view)"| GD
    GD -.->|"keyframe + live · optional take-control"| ADM

    classDef deny fill:#3b1b20,stroke:#ff6b7a,color:#ffc2c8;
    classDef ok fill:#123027,stroke:#42d19a,color:#bff3df;
    class L,E403 deny;
    class SCR ok;
```

- **Gateway-capable by default.** Every connector deploys the session engines
  out of the box — its one install command brings up guacd (RDP/SSH/VNC) and
  KasmVNC (isolated browser) alongside the connector on the shared
  `captivo-gateway` network (no separate pack, no toggle).
- **Credential injection.** The RDP/SSH/VNC username and secret are stored
  encrypted in the vault; the data-plane decrypts them only to build the guacd
  handshake — they never reach the vendor's browser.
- **Recording.** With **Record sessions** on, the guacd stream is captured and
  replayable at `/admin/recordings`. The bytes are written to the **connector's own
  disk**, AES-256-GCM-encrypted with a key only that connector holds; replay and
  command search reach into it on demand, so the control plane never receives the
  content (see [where recordings are stored](install.md#where-session-recordings-are-stored)).
- **Live view.** An admin or auditor can watch an in-progress session at
  `/admin/live`: the viewer **joins the same guacd connection by its ID**, so
  guacd sends the current screen immediately (not just future changes), and an
  admin can **take control**. The vendor sees a "being monitored" notice, and
  every watch / take / release is audited.
- **Health + logs.** Gateway targets are TCP-reachability-checked like web apps
  (Resources page + dashboard), and guacd's own logs surface on the connector's
  detail page ("Gateway logs") for troubleshooting.

## The isolated-browser path (isolated)

An **Isolated browser** Resource passes the same first two gates, but its tail
runs the app inside a **throwaway, server-side browser** (KasmVNC on the connector
host) and streams only pixels to the vendor — the app's content never touches the
vendor's own machine, the strongest isolation of the three methods. It reuses the
gateway plumbing (a `/kasm-tunnel` data-plane relay through the connector) and adds
DLP controls that only make sense when we own the browser: **clipboard** direction
control, an optional **screen watermark** (the vendor's email + a live clock,
composited onto what they see and any screenshot), per-direction **file transfer**
(off by default; upload into the browser and/or download out, each gated per
Resource), a **seekable** video recording (AES-256-GCM at rest), and the same **live watch /
take-control / terminate** as gateway (a second shared client via `/kasm-view`).
The isolated desktop sizes to the vendor's screen so it fills fullscreen.

```mermaid
flowchart TD
    A["Vendor browser<br/>Isolated browser session"] -->|"WSS /kasm-tunnel"| C["Data-plane :3103"]
    C --> G1{"Gate 1<br/>Signed in?"}
    G1 -->|no| L["Unauthorized"]
    G1 -->|yes| G2{"Gate 2 — allowed?<br/>grant · approval · schedule"}
    G2 -->|no| E403["Forbidden"]
    G2 -->|yes| BR["Broker spawns a throwaway<br/>browser (KasmVNC) on the<br/>connector host"]
    BR -->|outbound tunnel| APP["Isolated browser opens the<br/>Resource's internal URL"]
    APP --> PX["Only pixels streamed to the vendor<br/>(recorded if enabled)"]
    PX -.->|"clipboard · watermark · file transfer<br/>(per-Resource DLP)"| DLP["DLP controls"]
    ADM["Admin · /admin/live"] -->|"join the session (WSS /kasm-view)"| BR
    BR -.->|"live · optional take-control"| ADM

    classDef deny fill:#3b1b20,stroke:#ff6b7a,color:#ffc2c8;
    classDef ok fill:#123027,stroke:#42d19a,color:#bff3df;
    class L,E403 deny;
    class PX ok;
```

- **Nothing lands locally.** The app renders inside the server-side browser; the
  vendor only ever receives a pixel stream, so no page content, cookies, or
  downloaded files reach their machine unless **file transfer** is explicitly
  enabled for that Resource.
- **DLP you can only do when you own the browser.** Clipboard direction control,
  a composited screen watermark, and per-direction file transfer are all enforced
  server-side; file transfers are ephemeral (wiped when the session ends) and every
  upload/download is written to the audit log.
- **Recording + live view.** The session records to a **seekable** video, and an
  admin can watch it live at `/admin/live` (joining via `/kasm-view`) and take
  control — the vendor sees a "being monitored" notice, same as gateway.

A Resource's **access method** — `TRANSPARENT` (web app), `GATEWAY` (remote
desktop), or `ISOLATED` (isolated browser) — is chosen on its form; all three share
the identical session + grant gates above and differ only in the tail.

---

See also: [`deploy/README.md`](../deploy/README.md) for the full production
deploy (DNS, TLS, connector install), and the root
[`README.md`](../README.md) for the architecture overview.
