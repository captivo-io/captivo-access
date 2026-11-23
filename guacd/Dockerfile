# guacd, patched: Apache's guacamole/guacd image with two libraries rebuilt.
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
# And it tells the connection when a full-screen program (vim, top, less)
# takes the alternate buffer or gives it back (a captivo-altscreen
# instruction), so the data plane leaves what is typed into one out of the
# keystroke log, as it does for native SSH. The data plane removes the
# instruction before the browser; guacamole-common-js would ignore it.
#
# SSH sessions tell the server the terminal is an xterm-256color, not "linux"
# (upstream's default): 256 colours, and vim, less or top leave the shell's
# screen as it was (the alternate screen), which also lets the data plane
# tell their keys from the shell's. Keys that are not text then go as xterm
# sends them (F1-F4, Home/End, F11/F12, Shift+Tab, and Ctrl/Alt/Shift on them
# as xterm's modifier parameter); a resource that sets terminal-type to
# "linux" keeps the console's keys.
#
# Only libguac-terminal and the SSH plugin (libguac-client-ssh) change: they
# are rebuilt from the same 1.6.0 source on the same Alpine release as the
# official image, against its own libssh2, and copied over its copies, so RDP,
# VNC, guacd itself and every other library stay Apache's own build.
ARG GUAC_VERSION=1.6.0

FROM alpine:3.18 AS build
ARG GUAC_VERSION
RUN apk add --no-cache build-base autoconf automake libtool curl patch \
      cairo-dev pango-dev libjpeg-turbo-dev libpng-dev libwebp-dev util-linux-dev openssl1.1-compat-dev ttf-dejavu
# The official image's own libssh2 (headers, library), for the SSH plugin.
COPY --from=guacamole/guacd:1.6.0 /opt/guacamole/include/libssh2.h /opt/guacamole/include/libssh2_publickey.h /opt/guacamole/include/libssh2_sftp.h /opt/guacamole/include/
COPY --from=guacamole/guacd:1.6.0 /opt/guacamole/lib/libssh2.so.1.0.1 /opt/guacamole/lib/
RUN ln -s libssh2.so.1.0.1 /opt/guacamole/lib/libssh2.so.1 && ln -s libssh2.so.1 /opt/guacamole/lib/libssh2.so
WORKDIR /build
RUN curl -fsSL "https://archive.apache.org/dist/guacamole/${GUAC_VERSION}/source/guacamole-server-${GUAC_VERSION}.tar.gz" | tar xz
COPY guacd/osc-ignore-unknown.patch guacd/paste-like-a-terminal.patch guacd/alt-screen-notice.patch \
     guacd/xterm-keys.patch guacd/ssh-xterm-default.patch \
     guacd/osc_test.c guacd/paste_test.c guacd/altscreen_test.c guacd/xterm_keys_test.c ./
RUN cd guacamole-server-${GUAC_VERSION} \
 && patch -p1 < ../osc-ignore-unknown.patch \
 && patch -p1 < ../paste-like-a-terminal.patch \
 && patch -p1 < ../alt-screen-notice.patch \
 && patch -p1 < ../xterm-keys.patch \
 && patch -p1 < ../ssh-xterm-default.patch \
 && CPPFLAGS=-I/opt/guacamole/include LDFLAGS=-L/opt/guacamole/lib \
    ./configure --prefix=/opt/guacamole --without-rdp --without-vnc --with-ssh --without-telnet --without-websockets \
      --without-pulse --without-vorbis --disable-guacenc --disable-guaclog > /build/configure.log \
 && grep -q "SSH .* yes" /build/configure.log \
 && make -C src/libguac -j"$(nproc)" >/dev/null \
 && make -C src/common -j"$(nproc)" >/dev/null \
 && make -C src/common-ssh -j"$(nproc)" >/dev/null \
 && make -C src/terminal -j"$(nproc)" >/dev/null \
 && make -C src/protocols/ssh -j"$(nproc)" >/dev/null
# The patch must do what it says before the image exists (a font is needed
# for the terminal to start; osc_test.c, paste_test.c, altscreen_test.c and
# xterm_keys_test.c list what is checked).
RUN cd guacamole-server-${GUAC_VERSION} \
 && gcc -std=gnu99 -o /build/osc_test ../osc_test.c -I src/terminal -I src/common -I src/libguac -I . \
      $(pkg-config --cflags cairo pango pangocairo) \
      src/terminal/.libs/libguac-terminal.so src/libguac/.libs/libguac.so \
 && gcc -std=gnu99 -o /build/paste_test ../paste_test.c -I src/terminal -I src/common -I src/libguac -I . \
      $(pkg-config --cflags cairo pango pangocairo) \
      src/terminal/.libs/libguac-terminal.so src/libguac/.libs/libguac.so \
 && gcc -std=gnu99 -o /build/altscreen_test ../altscreen_test.c -I src/terminal -I src/common -I src/libguac -I . \
      $(pkg-config --cflags cairo pango pangocairo) \
      src/terminal/.libs/libguac-terminal.so src/libguac/.libs/libguac.so \
 && gcc -std=gnu99 -o /build/xterm_keys_test ../xterm_keys_test.c -I src/terminal -I src/common -I src/libguac -I . \
      $(pkg-config --cflags cairo pango pangocairo) \
      src/terminal/.libs/libguac-terminal.so src/libguac/.libs/libguac.so \
 && LD_LIBRARY_PATH=src/terminal/.libs:src/libguac/.libs /build/xterm_keys_test \
 && LD_LIBRARY_PATH=src/terminal/.libs:src/libguac/.libs /build/osc_test \
 && LD_LIBRARY_PATH=src/terminal/.libs:src/libguac/.libs /build/altscreen_test \
 && LD_LIBRARY_PATH=src/terminal/.libs:src/libguac/.libs /build/paste_test

FROM guacamole/guacd:${GUAC_VERSION}
ARG GUAC_VERSION
COPY --from=build /build/guacamole-server-${GUAC_VERSION}/src/terminal/.libs/libguac-terminal.so.2.0.0 /opt/guacamole/lib/libguac-terminal.so.2.0.0
COPY --from=build /build/guacamole-server-${GUAC_VERSION}/src/protocols/ssh/.libs/libguac-client-ssh.so.0.0.0 /opt/guacamole/lib/libguac-client-ssh.so.0.0.0
