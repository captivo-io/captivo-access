# ---- build ----
# go 1.25: dataplane/go.mod requires >= 1.25.0 (the go-ldap dependency chain —
# golang.org/x/crypto, golang.org/x/net — needs it). The connector/migrate
# images stay on their own base since they don't pull that chain.
FROM golang:1.25-alpine AS build
WORKDIR /src

# NOTE on the go.work workspace: the repo root has a go.work file that lists all
# three Go modules (connector, dataplane, tunnel). This image only needs
# dataplane + the shared tunnel module, so we deliberately do NOT copy go.work
# into the build context — if we did, `go build` would try to resolve every
# `use` entry in it (including ./connector), which we haven't copied, and the
# build would fail with a missing-directory error.
#
# Instead we rely on dataplane's own go.mod, which already declares
#   replace github.com/kurtserdar/captivo-access/tunnel => ../tunnel
# With no go.work present anywhere on the path, `go build` runs in plain
# single-module mode and resolves that replace against the tunnel/ directory
# copied below. No connector/ checkout is required.
COPY tunnel ./tunnel
COPY dataplane ./dataplane
RUN cd dataplane && CGO_ENABLED=0 go build -o /out/dataplane .

# ---- run ----
FROM alpine:3.20
# /data keeps the SSH jump host's key (sshjump.go); mount a volume there so
# clients don't see a new host key after an update.
RUN adduser -D -H -u 10001 dataplane && mkdir -p /data && chown dataplane /data
COPY --from=build /out/dataplane /usr/local/bin/dataplane
USER dataplane
VOLUME ["/data"]
EXPOSE 3101 2222
ENTRYPOINT ["/usr/local/bin/dataplane"]
