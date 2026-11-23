# ---- build ----
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build
ARG TARGETOS TARGETARCH
ARG VERSION=dev
WORKDIR /src

# See dataplane/Dockerfile for the full explanation. Short version: the repo-root
# go.work lists connector, dataplane, and tunnel as workspace modules. This image
# only needs connector + the shared tunnel module, so we do NOT copy go.work —
# doing so would make `go build` try to resolve every `use` entry (including
# ./dataplane, which we haven't copied) and fail. connector/go.mod already has
#   replace github.com/kurtserdar/captivo-access/tunnel => ../tunnel
# so with no go.work in the build context, `go build` runs in plain single-module
# mode and resolves that replace against the tunnel/ directory copied below.
COPY tunnel ./tunnel
COPY connector ./connector
RUN cd connector && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -ldflags "-X main.Version=${VERSION}" -o /out/connector .

# ---- guacenc ----
# Recordings of graphical sessions (RDP, VNC) are turned into VP9 WebM video on
# the connector once the session has ended (recmaint.go): a guac recording is a
# drawing instruction stream that a player must replay from the start to reach
# any point, at 1-10 MB a minute; the video seeks anywhere and is a fraction of
# the size. guacenc is Apache's encoder for exactly this, built from the same
# 1.6.0 source as guacd with guacd/guacenc-for-recordings.patch (codec, output,
# framerate, keyframe interval and encoder options on the command line; a crash
# on RDP recordings fixed). Built for the target platform, not cross-compiled.
FROM alpine:3.24 AS guacenc
ARG GUAC_VERSION=1.6.0
RUN apk add --no-cache build-base curl patch cairo-dev libjpeg-turbo-dev libpng-dev libwebp-dev \
      util-linux-dev openssl-dev ffmpeg-dev ffmpeg
WORKDIR /build
RUN curl -fsSL "https://archive.apache.org/dist/guacamole/${GUAC_VERSION}/source/guacamole-server-${GUAC_VERSION}.tar.gz" | tar xz
COPY guacd/guacenc-for-recordings.patch guacd/guacenc_test.sh ./
RUN cd guacamole-server-${GUAC_VERSION} \
 && patch -p1 < ../guacenc-for-recordings.patch \
 && ./configure --prefix=/opt/guacamole --disable-guacd --disable-guaclog --without-rdp --without-vnc \
      --without-ssh --without-telnet --without-websockets --without-pulse --without-vorbis >/dev/null \
 && make -C src/libguac -j"$(nproc)" >/dev/null && make -C src/libguac install >/dev/null \
 && make -C src/guacenc -j"$(nproc)" >/dev/null && make -C src/guacenc install >/dev/null \
 && rm -rf /opt/guacamole/include /opt/guacamole/share /opt/guacamole/lib/*.a /opt/guacamole/lib/*.la
# The patch must do what it says before the image exists (guacenc_test.sh lists
# what is checked).
RUN ./guacenc_test.sh

# ---- rdpenc ----
# Recorded native RDP sessions are kept as the server's PDU stream and turned
# into video the same way: rdpenc replays the stream into a headless FreeRDP
# 3 client, without a server, and hands the screen to ffmpeg (recmaint.go).
# Alpine 3.24's FreeRDP decodes H.264 (OpenH264), which the graphics pipeline
# of a current Windows server sends; 3.22's had no H.264 at all. The same
# binary, --live, decodes a running session for live watching (rdplive.go).
FROM alpine:3.24 AS rdpenc
RUN apk add --no-cache build-base pkgconf freerdp-dev libjpeg-turbo-dev zlib-dev
COPY connector/rdpenc/rdpenc.c /build/rdpenc.c
RUN gcc -O2 -Wall -Wno-deprecated-declarations -o /build/rdpenc /build/rdpenc.c \
      $(pkg-config --cflags --libs freerdp3 freerdp-client3 winpr3) -lturbojpeg -lz -lpthread

# ---- run ----
FROM alpine:3.24
# ffmpeg: guacenc's codecs, and ffprobe/ffmpeg to check a finished video and to
# repair an isolated-browser one whose session was cut off before it was closed.
# freerdp-libs: rdpenc's decoder (no X11, no audio); libturbojpeg, zlib: its live
# picture and pointer.
RUN apk add --no-cache ffmpeg cairo libjpeg-turbo libpng libwebp libuuid freerdp-libs libturbojpeg zlib \
 && mkdir -p /data && adduser -D -H -u 10001 connector && chown connector /data
COPY --from=guacenc /opt/guacamole /opt/guacamole
COPY --from=rdpenc /build/rdpenc /usr/local/bin/rdpenc
COPY --from=build /out/connector /usr/local/bin/connector
USER connector
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/connector"]
