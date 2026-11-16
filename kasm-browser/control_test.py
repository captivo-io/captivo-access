import importlib.util, os, sys

spec = importlib.util.spec_from_file_location("control", os.path.join(os.path.dirname(__file__), "control.py"))
control = importlib.util.module_from_spec(spec)
sys.modules["control"] = control  # so importlib.reload(control) works in the env tests
spec.loader.exec_module(control)


def test_safe_name_basename():
    assert control._safe_name("report.pdf") == "report.pdf"
    assert control._safe_name("/a/b/report.pdf") == "report.pdf"


def test_safe_name_rejects_traversal():
    assert control._safe_name("../../etc/passwd") == "passwd"
    assert control._safe_name("..") is None
    assert control._safe_name("") is None
    assert control._safe_name("   ") is None
    assert control._safe_name(".") is None


def test_ffmpeg_args_defaults():
    args = control._ffmpeg_args(3, "/rec/s.webm", 2560, 1600)
    assert "-vf" in args
    vf = args[args.index("-vf") + 1]
    assert vf == "scale='min(1280,iw)':-2"
    assert "-b:v" in args
    assert args[args.index("-b:v") + 1] == "512k"
    # unchanged essentials
    assert "libvpx" in args
    assert "-framerate" in args and args[args.index("-framerate") + 1] == "10"
    assert "realtime" in args
    # the filter must come before the tee muxer so both sinks are capped
    assert args.index("-vf") < args.index("tee")


def test_ffmpeg_args_env_overrides():
    import importlib, os
    os.environ["RECORDING_MAX_WIDTH"] = "1600"
    os.environ["RECORDING_VIDEO_BITRATE"] = "768k"
    importlib.reload(control)
    try:
        args = control._ffmpeg_args(3, "/rec/s.webm", 2560, 1600)
        assert args[args.index("-vf") + 1] == "scale='min(1600,iw)':-2"
        assert args[args.index("-b:v") + 1] == "768k"
    finally:
        del os.environ["RECORDING_MAX_WIDTH"]
        del os.environ["RECORDING_VIDEO_BITRATE"]
        importlib.reload(control)


def test_ffmpeg_args_env_fallbacks():
    import importlib, os
    os.environ["RECORDING_MAX_WIDTH"] = "bad"
    os.environ["RECORDING_VIDEO_BITRATE"] = "   "
    importlib.reload(control)
    try:
        assert control.RECORDING_MAX_WIDTH == 1280
        assert control.RECORDING_VIDEO_BITRATE == "512k"
    finally:
        del os.environ["RECORDING_MAX_WIDTH"]
        del os.environ["RECORDING_VIDEO_BITRATE"]
        importlib.reload(control)


def test_clamp_dim_floor():
    assert control._clamp_dim(100, 360, 2560, 1280) == 360
    assert control._clamp_dim(400, 360, 2560, 1280) == 400
    assert control._clamp_dim(None, 360, 2560, 1280) == 1280
    assert control._clamp_dim(480, 480, 1600, 800) == 480


def test_log_format():
    line = control.log("session s1 opened", _emit=False)
    assert line.endswith(" session s1 opened")
    assert len(line.split(" ")[0].split("/")) == 3  # date has 3 parts (YYYY/MM/DD)


if __name__ == "__main__":
    test_safe_name_basename()
    test_safe_name_rejects_traversal()
    test_ffmpeg_args_defaults()
    test_ffmpeg_args_env_overrides()
    test_ffmpeg_args_env_fallbacks()
    test_clamp_dim_floor()
    test_log_format()
    print("ok")


def test_key_events_are_cleaned_and_masked():
    got = control.clean_key_events([
        {"atMs": 1000, "text": "Search: invoices", "masked": False},
        {"atMs": 2000, "text": "hunter2", "masked": True},
        {"atMs": -1, "text": "bad time"},
        {"atMs": 3000, "text": 5},
        "junk",
    ])
    assert [e["text"] for e in got] == ["Search: invoices", "••••"]
    assert control.clean_key_events({"not": "a list"}) == []


def test_key_timeline_is_timed_from_the_video_start():
    events = control.clean_key_events([{"atMs": 1_700_000_005_500, "text": "b"}, {"atMs": 1_700_000_001_000, "text": "a"}])
    tl = control.keys_timeline(events, 1_700_000_000.0)
    assert [(e["atMs"], e["text"]) for e in tl] == [(1000, "a"), (5500, "b")]
    assert all(e["kind"] == "text" for e in tl)
    # No recording, no timeline to place them on.
    assert control.keys_timeline(events, None) == []


def test_keys_extension_is_loaded_only_when_asked(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(control.subprocess, "Popen", lambda args, **kw: calls.append(args) or type("P", (), {"poll": lambda s: None})())
    monkeypatch.setattr(control.time, "sleep", lambda s: None)
    home = str(tmp_path / "home")
    control._spawn(5, "https://x.test", str(tmp_path / "p"), home, True, True, keys_ext=None)
    assert not any(a.startswith("--load-extension") for a in calls[-1])
    control._spawn(5, "https://x.test", str(tmp_path / "p"), home, True, True, keys_ext="/sess/s1/session-ext")
    assert "--load-extension=/sess/s1/session-ext" in calls[-1]


def test_control_token_is_required_when_set():
    assert control.control_authorized("abc", token="abc")
    assert not control.control_authorized("", token="abc")
    assert not control.control_authorized("abd", token="abc")
    # An image started without a token file (manual install) keeps working.
    assert control.control_authorized("", token="")


def test_session_extension_config_carries_the_keys_flag_and_token(tmp_path, monkeypatch):
    src = tmp_path / "ext"
    src.mkdir()
    (src / "manifest.json").write_text("{}")
    monkeypatch.setattr(control, "SESSION_EXT_SRC", str(src))
    import json as _json
    for keys in (True, False):
        home = tmp_path / ("h%d" % keys)
        dst = control._prepare_session_ext(str(home), "s9-1", keys, "tok123")
        cfg = _json.load(open(dst + "/config.json"))
        assert cfg == {"keys": keys, "url": "http://127.0.0.1:7900/session/s9-1/keys", "token": "tok123"}


def test_a_session_runs_as_its_own_user_behind_its_own_cookie_and_password(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(control.subprocess, "Popen", lambda args, **kw: calls.append((args, kw)) or type("P", (), {"poll": lambda s: None})())
    monkeypatch.setattr(control.time, "sleep", lambda s: None)
    home = str(tmp_path / "home")
    control._spawn(7, "https://x.test", str(tmp_path / "p"), home, True, True, xauth=home + "/.Xauthority")
    uid = control.session_uid(7)
    assert uid == 20007
    # Xvnc, the window manager and Chromium all drop to the session's user.
    for args, kw in calls:
        assert kw.get("user") == uid and kw.get("group") == uid and kw.get("extra_groups") == [], args[0]
    xvnc = next(a for a, _ in calls if a[0] == "Xvnc")
    assert "-disableBasicAuth" not in xvnc
    assert xvnc[xvnc.index("-auth") + 1] == home + "/.Xauthority"
    assert xvnc[xvnc.index("-KasmPasswordFile") + 1] == home + "/.kasmpasswd"
    chrome_env = next(kw["env"] for a, kw in calls if a[0] == control.CHROME)
    assert chrome_env["XAUTHORITY"] == home + "/.Xauthority" and chrome_env["HOME"] == home
