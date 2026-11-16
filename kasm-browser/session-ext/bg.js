// The isolated session's guard, loaded into every session by control.py.
//
// ONE WINDOW. Chromium's --kiosk applies to the first window only: Ctrl+N (and
// a few other shortcuts) opened an ordinary window with an address bar, from
// which a vendor could go anywhere the container can reach. Any further
// normal window is closed the moment it appears. Popups (window.open with
// features, e.g. an OAuth sign-in) stay: they have no address bar to type in.
//
// TYPED INPUT. When config.json says keys:true, events from the content script
// are posted to the broker's control service (kasm-browser/control.py) with
// this session's keys token; pages cannot read this extension's files, so
// they cannot learn the token or post for the session themselves.
let kiosk = null;
chrome.windows.onCreated.addListener((w) => {
  if (w.type !== "normal") return;
  if (kiosk === null) { kiosk = w.id; return; }
  if (w.id !== kiosk) chrome.windows.remove(w.id).catch(() => {});
});
chrome.windows.onRemoved.addListener((id) => { if (id === kiosk) kiosk = null; });
chrome.windows.getAll({ windowTypes: ["normal"] }).then((ws) => {
  if (ws.length === 0) return;
  ws.sort((a, b) => a.id - b.id);
  if (kiosk === null) kiosk = ws[0].id;
  for (const w of ws) if (w.id !== kiosk) chrome.windows.remove(w.id).catch(() => {});
}).catch(() => {});

let cfg = null;
const ready = fetch(chrome.runtime.getURL("config.json"))
  .then((r) => r.json())
  .then((c) => { cfg = c && typeof c.url === "string" && c.keys === true ? c : null; })
  .catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.k) return;
  ready.then(() => {
    if (!cfg) return;
    fetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-keys-token": String(cfg.token || "") },
      body: JSON.stringify([msg.k]),
    }).catch(() => {});
  });
});
