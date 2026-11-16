#!/usr/bin/env python3
# In-container session broker for the high-fidelity (KasmVNC) isolated browser.
# Spawns a fresh per-session Xvnc (display + RFB + web/WS on one port) + fluxbox +
# kiosk Chromium on demand and reaps it on close. No docker socket: sessions are
# PROCESSES inside this one container. The hub (Xvnc :1 on 6901, started by
# entrypoint.sh) serves the static web client; per-session ports serve live RFB.
import hmac, json, os, secrets, shutil, signal, subprocess, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CHROME = shutil.which("chromium") or shutil.which("chromium-browser") or "chromium"
MAX_SESSIONS = int(os.environ.get("MAX_SESSIONS", "5"))
MAX_SESSION_SECONDS = int(os.environ.get("MAX_SESSION_SECONDS", "14400"))
BASE_PORT = 6900  # per-session port = BASE_PORT + display; hub is 6901 (display :1)
# The session extension baked into the image (kasm-browser/session-ext): it
# closes the non-kiosk windows a shortcut can open and, when asked, records
# typed input. Plus a per-session ceiling on what it may store.
SESSION_EXT_SRC = os.environ.get("SESSION_EXT_DIR", "/session-ext")
MAX_KEY_EVENTS = 20000


def _read_control_token(path):
    """The shared secret every caller of this service must present (written by
    entrypoint.sh, read by the connector from the same volume, sent by the
    data-plane). Without it, any page in an isolated browser -- they run in this
    container -- could open, close or spy on other vendors' sessions."""
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


CONTROL_TOKEN = _read_control_token(os.environ.get("KASM_TOKEN_FILE", "/secret/token"))


def control_authorized(header_value, token=None):
    token = CONTROL_TOKEN if token is None else token
    if not token:
        return True  # an image started without a token file (manual install)
    return hmac.compare_digest((header_value or "").strip(), token)
FT_MAX_BYTES = int(os.environ.get("ISOLATED_FT_MAX_BYTES", str(100 * 1024 * 1024)))


def log(msg, _emit=True):
    # Timestamped broker log line (session lifecycle). Printed to stdout with flush;
    # the entrypoint tees stdout to /kasmlog/kasm.log so the connector can tail it and
    # the console shows "Isolated browser logs". Returns the line so it is testable.
    # Matches the guacd/connector log style (YYYY/MM/DD HH:MM:SS ...).
    line = time.strftime("%Y/%m/%d %H:%M:%S") + " " + msg
    if _emit:
        print(line, flush=True)
    return line


def _positive_int_env(name, default):
    try:
        v = int(os.environ.get(name, "").strip())
        return v if v > 0 else default
    except (TypeError, ValueError):
        return default

# Recording encode knobs (tunable without rebuilding the connector image).
RECORDING_MAX_WIDTH = _positive_int_env("RECORDING_MAX_WIDTH", 1280)
RECORDING_VIDEO_BITRATE = (os.environ.get("RECORDING_VIDEO_BITRATE", "").strip() or "512k")

_lock = threading.Lock()
_sessions = {}  # id -> {"display": N, "port": p, "procs": [...], "profile": path, "started": ts}
_seq = {"n": 0}


def _free_display():
    # Display 1 is the hub; sessions use 2..MAX_SESSIONS+1.
    used = {s["display"] for s in _sessions.values()}
    for n in range(2, MAX_SESSIONS + 2):
        if n not in used:
            return n
    return None


def _clamp_dim(v, lo, hi, default):
    try:
        v = int(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def _spawn(display, url, profile, home, copy_out, paste_in, w=1280, h=800, watermark_text="", insecure=False, keys_ext=None):
    disp = ":%d" % display
    env = {**os.environ, "DISPLAY": disp, "HOME": home}
    os.makedirs(profile, exist_ok=True)
    os.makedirs(home + "/.vnc", exist_ok=True)
    os.makedirs(home + "/Downloads", exist_ok=True)
    # A SIGKILLed predecessor on this (reused) display can leave a stale X lock +
    # socket, so the new Xvnc refuses to start and then serves a dead/blank display
    # — an intermittent blank-session hang. Clear both before starting.
    for stale in ("/tmp/.X%d-lock" % display, "/tmp/.X11-unix/X%d" % display):
        try:
            os.remove(stale)
        except OSError:
            pass
    port = BASE_PORT + display
    # Clipboard DLP is applied as Xvnc parameters, NOT via kasmvnc.yaml: KasmVNC's
    # data_loss_prevention YAML is only read by the kasmvncserver wrapper, which
    # translates server_to_client.enabled -> SendCutText and client_to_server.enabled
    # -> AcceptCutText. We launch Xvnc directly (bypassing the wrapper), so a YAML
    # config is ignored entirely — the flags below are the real, enforced control.
    #   SendCutText   = server -> client = copy-out (isolated desktop -> vendor)
    #   AcceptCutText = client -> server = paste-in (vendor -> isolated desktop)
    send_cut = "-SendCutText=" + ("1" if copy_out else "0")
    accept_cut = "-AcceptCutText=" + ("1" if paste_in else "0")
    xvnc_args = ["Xvnc", disp, "-geometry", "%dx%d" % (w, h), "-depth", "24",
                 "-websocketPort", str(port), "-interface", "0.0.0.0",
                 "-httpd", "/usr/share/kasmvnc/www", "-SecurityTypes", "None",
                 "-disableBasicAuth", "-AlwaysShared=1", send_cut, accept_cut]
    if watermark_text:
        # DLP watermark rendered by KasmVNC at the RFB/client layer (appears in the
        # vendor's browser, the admin live view, and any screenshot — NOT the x11grab
        # recording). strftime in the text gives a live clock. Fixed tiled/diagonal/
        # translucent appearance.
        wt = watermark_text[:200]
        xvnc_args += ["-DLP_WatermarkText=" + wt, "-DLP_WatermarkTextAngle=30",
                      "-DLP_WatermarkRepeatSpace=380", "-DLP_WatermarkFontSize=28",
                      "-DLP_WatermarkTint=255,255,255,45"]
    xvnc = subprocess.Popen(xvnc_args, env=env)
    time.sleep(1.5)
    fbox = subprocess.Popen(["fluxbox"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Paint a plain solid background so fluxbox's fbsetbg helper finds a wallpaper
    # setter and stops raising its "I can't find an app to set the wallpaper with"
    # X dialog (briefly visible in the canvas before Chromium kiosk covers it). No
    # brand image here — the app-side ConnectSplash carries the branding.
    subprocess.Popen(["hsetroot", "-solid", "#000000"], env=env,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    chrome_args = [CHROME, "--kiosk", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
                   "--no-first-run", "--no-default-browser-check", "--disable-translate",
                   # Quiet the log in this headless, single-purpose container:
                   # --disable-background-networking kills the GCM/push registration
                   # attempts (PHONE_REGISTRATION_ERROR etc.); the rest stop Chromium
                   # probing D-Bus for notifications, power (UPower), media, and
                   # proxy config (NetworkManager) that don't exist here.
                   "--disable-background-networking", "--disable-sync",
                   "--disable-component-update", "--disable-default-apps", "--no-pings",
                   "--no-proxy-server",
                   "--disable-features=Translate,MediaRouter,OptimizationHints,MediaSessionService,UsePortalNotifications,DisableLoadExtensionCommandLineSwitch",
                   "--user-data-dir=" + profile]
    if keys_ext:
        # The session extension: closes extra non-kiosk windows and, when the
        # session logs keystrokes, records typed input (credential fields
        # masked) and posts it to this service.
        chrome_args.append("--load-extension=" + keys_ext)
    if insecure:
        # Opt-in per Resource: the target uses a self-signed / internal-CA cert.
        chrome_args.append("--ignore-certificate-errors")
    chrome_args.append(url)
    chrome = subprocess.Popen(chrome_args, env=env)
    return [xvnc, fbox, chrome]


def _kill(sess):
    for p in sess["procs"]:
        if p.poll() is None:
            p.send_signal(signal.SIGTERM)
    time.sleep(1.0)
    for p in sess["procs"]:
        if p.poll() is None:
            p.kill()
    rec_proc = sess.get("rec_proc")
    if rec_proc is not None and rec_proc.poll() is None:
        rec_proc.kill()
    shutil.rmtree(sess["profile"], ignore_errors=True)
    shutil.rmtree(sess["home"], ignore_errors=True)
    rec_file = sess.get("rec_file")
    if rec_file:
        try:
            os.remove(rec_file)
        except OSError:
            pass


def _prepare_session_ext(home, sid, keys, keys_token):
    """A per-session copy of the session extension, told whether to record typed
    input, where to post it and with which per-session token (pages cannot read
    the extension's files, so they cannot learn it)."""
    dst = home + "/session-ext"
    shutil.copytree(SESSION_EXT_SRC, dst, dirs_exist_ok=True)
    with open(dst + "/config.json", "w") as f:
        json.dump({"keys": keys, "url": "http://127.0.0.1:7900/session/%s/keys" % sid, "token": keys_token}, f)
    return dst


def open_session(url, copy_out, paste_in, w=1280, h=800, watermark_text="", insecure=False, keys=False):
    with _lock:
        if len(_sessions) >= MAX_SESSIONS:
            log("capacity reached (%d active) — session refused" % MAX_SESSIONS)
            return None
        display = _free_display()
        if display is None:
            log("no free display — session refused")
            return None
        _seq["n"] += 1
        sid = "s%d-%d" % (int(time.time()), _seq["n"])
        profile = "/profiles/" + sid
        home = "/sess/" + sid
        session_ext = None
        keys_token = secrets.token_hex(16)
        if os.path.isdir(SESSION_EXT_SRC):
            try:
                session_ext = _prepare_session_ext(home, sid, keys, keys_token)
            except OSError as e:
                log("session %s: session extension not prepared (%s)" % (sid, e))
        procs = _spawn(display, url, profile, home, copy_out, paste_in, w, h, watermark_text, insecure, session_ext)
        port = BASE_PORT + display
        _sessions[sid] = {"display": display, "port": port, "procs": procs,
                          "profile": profile, "home": home, "started": time.time(),
                          "w": w, "h": h, "keys": [] if (session_ext and keys) else None,
                          "keys_token": keys_token}
        log("session %s opened -> %s (%dx%d)" % (sid, url, w, h))
        return {"id": sid, "port": port}


def close_session(sid):
    with _lock:
        sess = _sessions.pop(sid, None)
    if sess:
        log("session %s closed" % sid)
        _kill(sess)


def _ffmpeg_args(display, recfile, w=1280, h=800):
    # Grab the per-session Xvnc display as WebM (VP8). The tee muxer writes two sinks:
    # the live pipe (stdout, streamed to the data-plane — crash-safe interim recording)
    # and a seekable file (finalized on clean stop for correct duration + seeking).
    # onfail=ignore keeps the file writing even if the pipe reader goes away. x11grab
    # is real-time paced, so an interrupted (SIGINT) capture still has correct
    # timestamps + duration.
    #
    # The -vf scale caps the RECORDING width (aspect-preserving, never upscaling) and a
    # modest -b:v keeps the file small; both are env-tunable. This only shrinks the
    # STORED replay — the vendor's view and the admin's /kasm-view live view are
    # separate full-resolution streams. Applied before -f tee so both sinks are capped.
    return ["ffmpeg", "-loglevel", "error", "-f", "x11grab",
            "-video_size", "%dx%d" % (w, h), "-framerate", "10", "-i", ":%d" % display,
            "-an", "-vf", "scale='min(%d,iw)':-2" % RECORDING_MAX_WIDTH,
            "-c:v", "libvpx", "-b:v", RECORDING_VIDEO_BITRATE, "-deadline", "realtime",
            "-f", "tee", "-map", "0:v",
            "[f=webm:onfail=ignore]pipe:1|[f=webm]" + recfile]


def _ffmpeg_capture(display, recfile, w=1280, h=800):
    return subprocess.Popen(_ffmpeg_args(display, recfile, w, h),
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def _reaper():
    while True:
        time.sleep(60)
        now = time.time()
        with _lock:
            stale = [sid for sid, s in _sessions.items() if now - s["started"] > MAX_SESSION_SECONDS]
            for sid in stale:
                sess = _sessions.pop(sid)
                log("session %s reaped (stale)" % sid)
                threading.Thread(target=_kill, args=(sess,), daemon=True).start()


def clean_key_events(batch):
    """Well-formed events from the extension; a masked one never keeps its text."""
    out = []
    if not isinstance(batch, list):
        return out
    for e in batch[:200]:
        if not isinstance(e, dict):
            continue
        at = e.get("atMs")
        text = e.get("text")
        if not isinstance(at, (int, float)) or at < 0 or not isinstance(text, str) or len(text) > 4096:
            continue
        masked = e.get("masked") is True
        out.append({"at": float(at), "text": "\u2022\u2022\u2022\u2022" if masked else text, "masked": masked})
    return out


def keys_timeline(events, t0):
    """Absolute page times -> offsets from the video's start (rec_t0, seconds).
    Without a recording there is no timeline to place them on."""
    if t0 is None:
        return []
    base = t0 * 1000.0
    return [{"atMs": int(max(0.0, e["at"] - base)), "kind": "text", "text": e["text"], "masked": e["masked"]}
            for e in sorted(events, key=lambda x: x["at"])]


def _safe_name(name):
    # Reduce any client-supplied name to a single safe path segment. Returns the
    # basename with directory parts stripped, or None if nothing usable remains.
    if not isinstance(name, str):
        return None
    base = os.path.basename(name.strip().replace("\\", "/"))
    if base in ("", ".", ".."):
        return None
    return base


class H(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the data-plane closed the relay before reading the reply

    def _authorized(self, path):
        if path == "/healthz":
            return True
        if control_authorized(self.headers.get("X-Kasm-Token")):
            return True
        self._json(401, {"error": "unauthorized"})
        return False

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if not self._authorized(u.path):
            return
        # Live session recording: stream the ffmpeg WebM capture of the session's
        # display until the data-plane disconnects (recording lifecycle = connection
        # lifecycle). The broker never sees the recordingKey — the data-plane owns it.
        if u.path.startswith("/session/") and u.path.endswith("/rec"):
            sid = u.path[len("/session/"):-len("/rec")]
            with _lock:
                sess = _sessions.get(sid)
                display = sess["display"] if sess else None
                rec_w = sess.get("w", 1280) if sess else 1280
                rec_h = sess.get("h", 800) if sess else 800
            if display is None:
                return self._json(404, {"error": "not_found"})
            recfile = "/rec/" + sid + ".webm"
            proc = _ffmpeg_capture(display, recfile, rec_w, rec_h)
            with _lock:
                s = _sessions.get(sid)
                if s is not None:
                    s["rec_proc"] = proc
                    s["rec_file"] = recfile
                    # Typed-input times are offsets from here, the video's zero.
                    s.setdefault("rec_t0", time.time())
            self.send_response(200)
            self.send_header("Content-Type", "video/webm")
            self.end_headers()
            try:
                while True:
                    # read1: forward whatever ffmpeg has produced so far instead of
                    # blocking for a full 64 KiB (a static page trickles bytes slowly).
                    buf = proc.stdout.read1(65536)
                    if not buf:
                        break
                    self.wfile.write(buf)  # raises when the data-plane disconnects
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                # SIGINT (not terminate/kill) so ffmpeg writes the trailer + Cues +
                # Duration, leaving /rec/<sid>.webm seekable for the finalize pull.
                if proc.poll() is None:
                    proc.send_signal(signal.SIGINT)
                    try:
                        proc.wait(timeout=8)
                    except Exception:
                        proc.kill()
            return
        # Finalized recording: stream the seekable /rec/<sid>.webm (finalizing first if
        # ffmpeg somehow still runs). The data-plane pulls this on clean session end.
        if u.path.startswith("/session/") and u.path.endswith("/recording"):
            sid = u.path[len("/session/"):-len("/recording")]
            with _lock:
                s = _sessions.get(sid)
                recfile = s.get("rec_file") if s else None
                proc = s.get("rec_proc") if s else None
            if proc is not None and proc.poll() is None:
                proc.send_signal(signal.SIGINT)
                try:
                    proc.wait(timeout=8)
                except Exception:
                    proc.kill()
            if not recfile or not os.path.exists(recfile):
                return self._json(404, {"error": "not_found"})
            try:
                self.send_response(200)
                self.send_header("Content-Type", "video/webm")
                self.send_header("Content-Length", str(os.path.getsize(recfile)))
                self.end_headers()
                with open(recfile, "rb") as f:
                    while True:
                        buf = f.read(65536)
                        if not buf:
                            break
                        self.wfile.write(buf)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return
        # File transfer: list finished downloads in the session's Downloads dir.
        if u.path.startswith("/session/") and u.path.endswith("/downloads"):
            sid = u.path[len("/session/"):-len("/downloads")]
            with _lock:
                sess = _sessions.get(sid)
                home = sess["home"] if sess else None
            if home is None:
                return self._json(404, {"error": "not_found"})
            ddir = home + "/Downloads"
            out = []
            try:
                for n in os.listdir(ddir):
                    if n.endswith(".crdownload"):
                        continue
                    p = ddir + "/" + n
                    if os.path.isfile(p):
                        out.append({"name": n, "size": os.path.getsize(p), "mtime": int(os.path.getmtime(p))})
            except OSError:
                pass
            return self._json(200, out)
        # File transfer: stream one finished download.
        if u.path.startswith("/session/") and "/downloads/" in u.path:
            head, _, raw = u.path.partition("/downloads/")
            sid = head[len("/session/"):]
            name = _safe_name(urllib.parse.unquote(raw))
            with _lock:
                sess = _sessions.get(sid)
                home = sess["home"] if sess else None
            if home is None or name is None:
                return self._json(404, {"error": "not_found"})
            p = home + "/Downloads/" + name
            if not os.path.isfile(p):
                return self._json(404, {"error": "not_found"})
            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(os.path.getsize(p)))
                self.end_headers()
                with open(p, "rb") as f:
                    while True:
                        buf = f.read(65536)
                        if not buf:
                            break
                        self.wfile.write(buf)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return
        # Typed-input timeline for the session, timed from the start of its video.
        # Pulled by the data-plane at session end, next to the finalized video.
        if u.path.startswith("/session/") and u.path.endswith("/keys"):
            sid = u.path[len("/session/"):-len("/keys")]
            with _lock:
                s = _sessions.get(sid)
                events = list(s.get("keys") or []) if s else None
                t0 = s.get("rec_t0") if s else None
            if events is None:
                return self._json(404, {"error": "not_found"})
            return self._json(200, keys_timeline(events, t0))
        if u.path == "/healthz":
            return self._json(200, {"ok": True})
        self._json(404, {"error": "not_found"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not (path.startswith("/session/") and path.endswith("/keys")) and not self._authorized(path):
            return
        if path == "/session":
            n = int(self.headers.get("Content-Length", "0") or "0")
            try:
                data = json.loads(self.rfile.read(n) or b"{}")
            except Exception:
                data = {}
            url = data.get("url", "")
            if not (isinstance(url, str) and (url.startswith("http://") or url.startswith("https://"))):
                return self._json(400, {"error": "bad_url"})
            copy_out = data.get("copyOut", True)
            paste_in = data.get("pasteIn", True)
            w = _clamp_dim(data.get("w"), 360, 2560, 1280)
            h = _clamp_dim(data.get("h"), 480, 1600, 800)
            wtext = data.get("watermarkText", "")
            if not isinstance(wtext, str):
                wtext = ""
            insecure = bool(data.get("insecure", False))
            keys = data.get("keys") is True
            res = open_session(url, copy_out, paste_in, w, h, wtext, insecure, keys)
            if res is None:
                return self._json(503, {"error": "capacity"})
            return self._json(201, res)
        # From the session's own extension only: loopback, and the session's
        # keys token, which pages cannot read. Checked before the control token,
        # which the extension does not hold.
        if path.startswith("/session/") and path.endswith("/keys"):
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self._json(403, {"error": "forbidden"})
            sid = path[len("/session/"):-len("/keys")]
            with _lock:
                want = (_sessions.get(sid) or {}).get("keys_token") or ""
            if not want or not hmac.compare_digest(self.headers.get("X-Keys-Token") or "", want):
                return self._json(403, {"error": "forbidden"})
            n = int(self.headers.get("Content-Length", "0") or "0")
            if n > 65536:
                return self._json(413, {"error": "too_large"})
            try:
                batch = json.loads(self.rfile.read(n) or b"[]")
            except Exception:
                return self._json(400, {"error": "bad_body"})
            with _lock:
                s = _sessions.get(sid)
                if s is None or s.get("keys") is None:
                    return self._json(404, {"error": "not_found"})
                for e in clean_key_events(batch):
                    if len(s["keys"]) >= MAX_KEY_EVENTS:
                        break
                    s["keys"].append(e)
            return self._json(200, {"ok": True})
        if path.startswith("/session/") and path.endswith("/close"):
            sid = path[len("/session/"):-len("/close")]
            close_session(sid)
            return self._json(200, {"ok": True})
        # File transfer: write an uploaded file into the session HOME root, where the
        # isolated Chromium's file picker opens.
        if path.startswith("/session/") and path.endswith("/upload"):
            sid = path[len("/session/"):-len("/upload")]
            with _lock:
                sess = _sessions.get(sid)
                home = sess["home"] if sess else None
            if home is None:
                return self._json(404, {"error": "not_found"})
            name = _safe_name(self.headers.get("X-Filename", ""))
            if name is None:
                return self._json(400, {"error": "bad_name"})
            n = int(self.headers.get("Content-Length", "0") or "0")
            if n > FT_MAX_BYTES:
                return self._json(413, {"error": "too_large"})
            dest = home + "/" + name
            remaining = n
            try:
                with open(dest, "wb") as f:
                    while remaining > 0:
                        chunk = self.rfile.read(min(65536, remaining))
                        if not chunk:
                            break
                        f.write(chunk)
                        remaining -= len(chunk)
            except OSError:
                return self._json(500, {"error": "write_failed"})
            return self._json(201, {"ok": True, "name": name})
        self._json(404, {"error": "not_found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    os.makedirs("/profiles", exist_ok=True)
    os.makedirs("/rec", exist_ok=True)
    threading.Thread(target=_reaper, daemon=True).start()
    # A startup line so the console's "Isolated browser logs" confirms the engine is
    # alive immediately (like guacd's start banner), before any session runs.
    log("kasm broker started (max %d sessions)" % MAX_SESSIONS)
    ThreadingHTTPServer(("0.0.0.0", 7900), H).serve_forever()
