# The updater beside a connector (updater/main.go): Docker CLI, the updater
# binary and recipe.sh, nothing else. See main.go for what it does and why it
# takes no input from the network.

# ---- build ----
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS build
ARG TARGETOS TARGETARCH
ARG VERSION=dev
WORKDIR /src
# No go.work, as in connector/Dockerfile: updater/go.mod's replace finds tunnel/.
COPY tunnel ./tunnel
COPY updater ./updater
RUN cd updater && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -ldflags "-X main.Version=${VERSION}" -o /out/updater .

# ---- run ----
# The official Docker CLI image (Alpine): docker, sh, and the busybox tools the
# uninstall recipe uses (sort, xargs, rm). The CLI negotiates the API version
# down to the host's daemon.
FROM docker:27.5.1-cli
COPY --from=build /out/updater /usr/local/bin/updater
COPY updater/recipe.sh /usr/local/bin/recipe.sh
RUN chmod 755 /usr/local/bin/recipe.sh
ENTRYPOINT ["/usr/local/bin/updater"]
