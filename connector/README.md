# Captivo Access — connector

The connector is a small agent you run inside your own network (on-prem,
private VPC, home lab — anywhere that isn't internet-reachable). It:

- enrolls with the Manager using a one-time pairing code, storing a
  long-lived connector token on disk,
- dials **out** to the data-plane over WSS (never accepts inbound
  connections, never needs an open firewall port),
- proxies HTTP requests from the data-plane to the internal address the
  Manager sends for each request — that address is defined once, per app,
  as a **Resource** in the Manager console, not on the connector itself,
- relays **WebSocket** connections and answers **TCP reachability probes** for
  the same targets — both bounded by the same `ALLOWED_TARGETS` check as HTTP,
- reports live **telemetry** (version, uptime, connection counts, throughput, a
  recent-log tail) to the Manager and applies an optional Manager-pushed
  **egress policy** — both over a control stream on the same outbound tunnel.

Every connector host also brokers **recorded remote-desktop sessions** (RDP/SSH/VNC,
via a bundled **guacd**) and **isolated-browser sessions** (via a bundled **KasmVNC**).
The install command deploys both engines alongside the connector on a shared
`captivo-gateway` Docker network — there is nothing to enable (see [Running](#running)).

It shares wire-format and dial types with the data-plane via the
[`tunnel`](../tunnel) module.

## Environment variables

| Variable        | Required | Meaning                                                                 |
| ---------------- | -------- | ------------------------------------------------------------------------ |
| `MANAGER_URL`     | yes      | Base URL of the Manager (used for enrollment/pairing).                  |
| `DATAPLANE_URL`   | yes      | TLS-terminated WSS URL of the data-plane tunnel to dial, e.g. `wss://connect.access.example.com`. Use `wss://` — a plain `ws://` tunnel is unencrypted. |
| `PAIR_CODE`       | first run only | One-time pairing code from the Manager UI. Only needed until a token is stored at `TOKEN_FILE`; ignored afterwards. |
| `ALLOWED_TARGETS` | no       | Optional egress boundary: comma-separated CIDRs/hosts/`host:port`s, e.g. `10.0.5.0/24,jira.internal,192.168.1.50:8080`. If set, the connector refuses to dial any target outside this list, even if a Resource's internal address points there. Unset means it dials whatever the Manager routes to it. |
| `TOKEN_FILE`      | no       | Path to the stored connector token. Default: `/data/token`.            |
| `LOG_LEVEL`       | no       | Initial log threshold (`debug`/`info`/`warn`/`error`). Default `info`; the Manager can override it live via connector policy. |

Upstream targets themselves aren't configured on the connector at all —
each internal app is defined as a **Resource** (with its internal address) in
the Manager console, and the connector dials whatever address the Manager
sends it for a given request, subject to `ALLOWED_TARGETS` if set.

The Manager can also push a per-connector **egress policy** (set on the
connector's detail page). It combines with `ALLOWED_TARGETS` as an
**intersection**: a target must satisfy both to be dialed. `ALLOWED_TARGETS`
(set on the container, on-host) is the hard ceiling — a Manager-pushed policy
can only tighten it further, never widen it, so a compromised control plane
can't make a connector reach something its local boundary forbids.

## Ports

None. The connector makes only outbound connections (to `MANAGER_URL` and
`DATAPLANE_URL`) and never listens on a socket.

## Data

The connector token issued at enrollment is written to `TOKEN_FILE`
(default `/data/token`) so the container can restart and reconnect without
needing `PAIR_CODE` again. Mount `/data` as a volume so the token survives
container recreation.

## Building

The Docker build context is the **repository root** (not this directory),
because the module depends on the sibling `tunnel/` module via a `replace`
directive in `connector/go.mod`:

```bash
docker build -f connector/Dockerfile -t captivo-access-connector .
```

See [`Dockerfile`](./Dockerfile) for why the repo-root `go.work` is
intentionally *not* copied into the build context.

## Running

Prebuilt images are published to GitHub Container Registry on each
`vX.Y.Z` release tag, so you don't need to build locally — just pull and
run:

```bash
docker run -d \
  --name access-connector --restart unless-stopped \
  -e MANAGER_URL=https://access.example.com \
  -e DATAPLANE_URL=wss://connect.access.example.com \
  -e PAIR_CODE=<one-time code from the Manager UI> \
  -v access_connector_data:/data \
  ghcr.io/captivo-io/captivo-access-connector:latest
```

The Manager generates this exact command for you (with your real
`MANAGER_URL`/`DATAPLANE_URL`/pairing code) under **Add connector** — copy it
from there rather than hand-editing, so the container name (`access-connector`)
and token volume (`access_connector_data`) match what the console's
**Re-pair** and **Update** commands expect. Note the console's command is longer
than the snippet above: it also starts the guacd and KasmVNC session engines
(see below).

To cap what this connector may reach, add `-e ALLOWED_TARGETS=10.0.5.0/24`
(or a comma-separated list of CIDRs/hosts) to the command above — optional,
and unrelated to which apps route through this connector, which is decided
entirely by Resources in the Manager.

Every connector host also runs the session engines out of the box — there is
nothing to enable. The console's generated command deploys **guacd** (recorded
RDP/SSH/VNC) and the **KasmVNC** isolated browser alongside the connector and
joins them on the shared `captivo-gateway` network durably; don't attach that
network or install the engines by hand. guacd's logs are surfaced back on the
connector's detail page ("Gateway logs") for troubleshooting.

You can still build from source with the `docker build` command above if
you prefer (or need a version that hasn't been tagged yet).

On first start, the connector redeems `PAIR_CODE` and stores its token in
the `access_connector_data` volume. On subsequent restarts, `PAIR_CODE` is no longer
needed (and is ignored if still set) — the connector reads its stored token
from `/data/token` and reconnects.
