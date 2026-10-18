# Captivo Access — data-plane

The data-plane is the **data path** of Captivo Access: the internet-reachable
Go service that connectors dial out to, and the identity-aware reverse proxy
that vendor traffic actually flows through. The [Manager](../README.md) is the
*control plane* (console, identity, grants, Postgres); the data-plane carries the
live traffic.

It has **three listeners**:

- a **public WSS endpoint** (`:3101`) each connector dials into, backed by a
  [yamux](https://github.com/hashicorp/yamux)-multiplexed session and tracked in
  an in-memory registry of connected connectors; a per-connector **control
  stream** on that session carries connector telemetry (version, uptime,
  connection counts, throughput, a recent-log tail) up to the Manager and
  egress-policy updates down to the connector;
- a **browser-facing identity-aware reverse proxy** (`:3103`) that serves vendor
  traffic per resource — it checks the session cookie and the access grant on
  **every request** (fail-closed) before streaming it down the right connector's
  tunnel, and emits an audit event for each decision. It also relays
  **WebSocket** upgrades transparently, and — for Resources with recording enabled
  or a clipboard restriction — injects an rrweb recorder and/or a clipboard
  guard into HTML responses (stripping the upstream CSP on any injected
  response so the inline script runs) and serves the reserved `/__captivo/*`
  endpoints (never forwarded upstream). The same listener also hosts the
  **native remote-desktop gateway**: `/guac-tunnel` bridges a browser to guacd
  (RDP/SSH/VNC) through the connector, driving the guacd handshake server-side
  and injecting the vault credential so it never reaches the vendor; `/guac-view`
  lets an admin **join** that guacd connection (by its connection ID) to watch or
  take control of a live session. It likewise hosts the **isolated-browser**
  transport: `/kasm-tunnel` bridges a browser to a throwaway KasmVNC session
  through the connector, and `/kasm-view` joins it for live watch/take-control;
- an **internal API** (`:3102`) the Manager calls to round-trip an allowlisted
  HTTP request (`/proxy`), run a reachability probe (`/probe`), list active
  gateway sessions, set take-control, or relay isolated-browser file transfers
  (`/kasm-files`), through a specific connector.

It shares wire-format and dial types with the connector via the
[`tunnel`](../tunnel) module and holds **no persistent state** — connector
sessions live only in memory and re-establish on reconnect.

## Architecture

```
   Vendor browser                      Manager  (control plane, :3100)
        │                              Next.js · console · grants · Postgres
        │ HTTPS                                     │
        ▼                                           │  /proxy · /probe
  Front proxy (Caddy — TLS,                         │  (x-dataplane-secret)
  routes <site>.access.<domain>)                    │
        │                                           ▼
        │  :3103                           ┌────────────────────┐
        └─────────────────────────────────▶│     DATA-PLANE     │◀── :3102 internal API
             identity-aware proxy          │        (Go)        │      (Manager only)
        session + grant checked per req    │ in-memory registry │
                                           │ of connectors      │
                                           └─────────┬──────────┘
                                          :3101 WSS  │  (connectors dial OUT)
   ════════════════════════════════════════════════│════ network boundary ════
                                                     ▼
                                           Connector  (Go, inside customer network)
                                             dials out; never listens
                                                     ├──▶ Internal app  (wiki, dashboard, …)
                                                     ├──▶ guacd ─▶ Remote desktop (RDP/SSH/VNC)
                                                     └──▶ KasmVNC ─▶ Isolated browser
```

A vendor request never reaches an internal app until the data-plane has resolved
`session → user`, `hostname → site`, and `evaluateAccess(user, site, now) →
allow`. The connector only ever makes **outbound** connections; the data-plane is
the single endpoint every tunnel terminates at. Splitting it from the Manager is
deliberate: streaming raw bytes over many long-lived tunnels is a Go job, and the
internet-facing traffic surface stays isolated from the control plane's console,
secrets, and database.

## Ports

| Port | Address env     | Audience                                                              |
| ---- | --------------- | -------------------------------------------------------------------- |
| 3101 | `WSS_ADDR`      | Public — connectors dial in here (`/tunnel`, `/healthz`)             |
| 3103 | `PROXY_ADDR`    | Public (behind the front TLS proxy) — vendor per-resource traffic, plus the native gateway (`/guac-tunnel` + `/guac-view`) and the isolated browser (`/kasm-tunnel` + `/kasm-view`) |
| 3102 | `INTERNAL_ADDR` | Compose-internal only — the Manager's `/proxy` + `/probe`; **must not** be published to the host/internet |

In `docker-compose.yml`, `3101` and `3103` are published; `3102` is reachable
solely from other containers on the compose network (the Manager calls
`http://access-dataplane:3102/proxy`).

## Environment variables

| Variable             | Default                       | Meaning                                                              |
| -------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `DATAPLANE_SECRET`   | *(required)*                  | Shared secret checked on the internal API (`x-dataplane-secret` header). Must match the Manager's `DATAPLANE_SECRET`. |
| `CONTROL_PLANE_URL`  | `http://access-manager:3100`  | Base URL of the Manager, used for control-plane callbacks.          |
| `MANAGER_PUBLIC_URL` | *(empty — set in prod)*       | The Manager's public URL, used to build the absolute `/login?returnTo=` redirect when an unauthenticated vendor hits the proxy. Empty logs a warning and may loop the login redirect. |
| `WSS_ADDR`           | `:3101`                       | Listen address for the public connector-facing WSS endpoint.        |
| `PROXY_ADDR`         | `:3103`                       | Listen address for the browser-facing identity-aware proxy.         |
| `INTERNAL_ADDR`      | `:3102`                       | Listen address for the internal proxy/probe API. Keep this off any public port mapping. |
| `AUDIT_QUEUE_CAP`    | `10000`                       | Bounded in-memory audit-event queue depth before the proxy drops events rather than blocking. |
| `WEB_SESSION_IDLE_SECS` | `120`                      | Idle timeout (seconds) after which a web-app proxy session is considered ended for the activity feed. |
| `RECORDING_MAX_BYTES` | unset (no cap)                | Optional per-recording cumulative (pre-gzip) byte cap. Unset, a recording runs as long as its session. When set and reached, capture stops, the session continues, and the console marks the recording as cut short. |

## Building

The Docker build context is the **repository root** (not this directory),
because the module depends on the sibling `tunnel/` module via a `replace`
directive in `dataplane/go.mod`:

```bash
docker build -f dataplane/Dockerfile -t captivo-access-dataplane .
```

See [`Dockerfile`](./Dockerfile) for why the repo-root `go.work` is
intentionally *not* copied into the build context.

## Running (via compose)

The data-plane is started as part of the full stack:

```bash
docker compose up -d access-dataplane
```

It has no persistent state of its own — connector sessions live only in
memory and are re-established on reconnect.
