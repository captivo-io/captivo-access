#!/bin/sh
set -e
mkdir -p /root/.vnc
cp /kasmvnc.yaml /root/.vnc/kasmvnc.yaml
# Clear stale X locks/sockets left by an unclean shutdown (e.g. the host being
# power-cut). At container start no Xvnc is alive, so every /tmp/.X*-lock is
# stale; without this the hub's `Xvnc :1` below dies with "Server is already
# active for display 1", 6901 never listens, and every isolated session shows a
# blank screen. (_spawn already clears per-session displays :2+; this covers the
# hub display :1, which entrypoint — not _spawn — starts.)
rm -f /tmp/.X*-lock 2>/dev/null || true
rm -f /tmp/.X11-unix/X* 2>/dev/null || true
# Hub: serves the static KasmVNC web client (HTML/assets) on the fixed port 6901.
# Its display is never rendered to (no window manager, no browser) — only
# per-session Xvnc instances carry live displays. The data-plane routes only the
# web client here; each live RFB-over-WebSocket goes to a per-session port.
# Its X display takes a root-only cookie, so no session user can open it.
xauth -q -f /root/.hub-xauth add :1 . "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
chmod 600 /root/.hub-xauth
Xvnc :1 -geometry 1280x800 -depth 24 -websocketPort 6901 -interface 0.0.0.0 \
  -httpd /usr/share/kasmvnc/www -SecurityTypes None -disableBasicAuth -auth /root/.hub-xauth &
sleep 2
mkdir -p /kasmlog
# The control service's shared secret (control.py, read by the connector from
# the same volume). Generated once per install and kept across updates.
mkdir -p /secret
[ -s /secret/token ] || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /secret/token
# Readable by root here and by the connector (uid 10001, same volume), not by
# the session users isolated browsers run as.
chown 10001:10001 /secret/token
chmod 400 /secret/token
chmod 711 /secret
# Sessions' homes, profiles and recordings: each session's own directories are
# 0700 to its user (control.py); these parents must not list them.
mkdir -p /sess /profiles /rec
chmod 711 /sess /profiles
chmod 700 /rec
# Chromium policy (kasm-browser/policy.json): no file://, chrome://, devtools
# or incognito, and nothing on this container or its neighbours -- including
# this container's own addresses, added here because only now are they known.
python3 - <<'PY'
import json, os, subprocess
p = json.load(open("/captivo-policy.json"))
ips = subprocess.run(["hostname", "-I"], capture_output=True, text=True).stdout.split()
p["URLBlocklist"] += [ip if ":" not in ip else "[%s]" % ip for ip in ips] + [os.uname().nodename]
os.makedirs("/etc/chromium/policies/managed", exist_ok=True)
json.dump(p, open("/etc/chromium/policies/managed/captivo.json", "w"), indent=1)
PY
python3 /control.py 2>&1 | tee /kasmlog/kasm.log
