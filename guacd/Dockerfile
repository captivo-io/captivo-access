# guacd, patched: Apache's guacamole/guacd image with ONE library rebuilt.
#
# guacd 1.6.0 prints the payload of any OSC sequence it does not implement
# (only 0/2 title and 4 palette are), where every other terminal skips it up
# to the terminator. systemd 257+ emits OSC 3008 before every prompt and
# around every command, so SSH sessions to current Ubuntu/Fedora showed
# "tart=...;user=root;hostname=...;cwd=/root" before each prompt; OSC 7 and
# OSC 8 hyperlinks broke the same way. Still unfixed upstream (main, 2026-11).
#
# It also pastes the way a terminal emulator does: line breaks as CR (the
# Enter key), bracketed (ESC [ 200 ~ ... ESC [ 201 ~) when the application
# enables mode 2004. Upstream writes the clipboard raw, so each LF reached the
# application as Ctrl+J; nano runs that as Justify and a pasted certificate
# came out as one reflowed paragraph.
#
# Only libguac-terminal changes: it is rebuilt from the same 1.6.0 source on
# the same Alpine release as the official image and copied over its copy, so
# RDP, VNC, guacd itself and every other library stay Apache's own build.
ARG GUAC_VERSION=1.6.0

FROM alpine:3.18 AS build
ARG GUAC_VERSION
RUN apk add --no-cache build-base autoconf automake libtool curl patch \
      cairo-dev pango-dev libjpeg-turbo-dev libpng-dev libwebp-dev util-linux-dev openssl1.1-compat-dev ttf-dejavu
WORKDIR /build
RUN curl -fsSL "https://archive.apache.org/dist/guacamole/${GUAC_VERSION}/source/guacamole-server-${GUAC_VERSION}.tar.gz" | tar xz
COPY guacd/osc-ignore-unknown.patch guacd/paste-like-a-terminal.patch guacd/osc_test.c guacd/paste_test.c ./
RUN cd guacamole-server-${GUAC_VERSION} \
 && patch -p1 < ../osc-ignore-unknown.patch \
 && patch -p1 < ../paste-like-a-terminal.patch \
 && ./configure --prefix=/opt/guacamole --without-rdp --without-vnc --without-ssh --without-telnet --without-websockets \
      --without-pulse --without-vorbis --disable-guacenc --disable-guaclog >/dev/null \
 && make -C src/libguac -j"$(nproc)" >/dev/null \
 && make -C src/common -j"$(nproc)" >/dev/null \
 && make -C src/terminal -j"$(nproc)" >/dev/null
# The patch must do what it says before the image exists (a font is needed
# for the terminal to start; osc_test.c and paste_test.c list what is checked).
RUN cd guacamole-server-${GUAC_VERSION} \
 && gcc -std=gnu99 -o /build/osc_test ../osc_test.c -I src/terminal -I src/common -I src/libguac -I . \
      $(pkg-config --cflags cairo pango pangocairo) \
      src/terminal/.libs/libguac-terminal.so src/libguac/.libs/libguac.so \
 && gcc -std=gnu99 -o /build/paste_test ../paste_test.c -I src/terminal -I src/common -I src/libguac -I . \
      $(pkg-config --cflags cairo pango pangocairo) \
      src/terminal/.libs/libguac-terminal.so src/libguac/.libs/libguac.so \
 && LD_LIBRARY_PATH=src/terminal/.libs:src/libguac/.libs /build/osc_test \
 && LD_LIBRARY_PATH=src/terminal/.libs:src/libguac/.libs /build/paste_test

FROM guacamole/guacd:${GUAC_VERSION}
ARG GUAC_VERSION
COPY --from=build /build/guacamole-server-${GUAC_VERSION}/src/terminal/.libs/libguac-terminal.so.2.0.0 /opt/guacamole/lib/libguac-terminal.so.2.0.0
