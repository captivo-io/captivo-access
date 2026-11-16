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
  if (kiosk === null) { kiosk = w.id; startKiosk(); return; }
  if (w.id !== kiosk) chrome.windows.remove(w.id).catch(() => {});
});
chrome.windows.onRemoved.addListener((id) => { if (id === kiosk) kiosk = null; });
chrome.windows.getAll({ windowTypes: ["normal"] }).then((ws) => {
  if (ws.length === 0) return;
  ws.sort((a, b) => a.id - b.id);
  if (kiosk === null) kiosk = ws[0].id;
  for (const w of ws) if (w.id !== kiosk) chrome.windows.remove(w.id).catch(() => {});
  startKiosk();
}).catch(() => {});

let conf = {};
let cfg = null; // set when this session records typed input
const ready = fetch(chrome.runtime.getURL("config.json"))
  .then((r) => r.json())
  .then((c) => {
    conf = c || {};
    cfg = typeof conf.url === "string" && conf.keys === true ? conf : null;
  })
  .catch(() => {});

// START. Behind the egress proxy Chromium opens on about:blank: a resource
// opened directly is requested before this worker is listening, and the
// proxy's 407 reaches the vendor as a sign-in dialog. The resource is opened
// from here once the answer below is in place -- in a new tab, which (unlike a
// redirected blank tab) gives the page the keyboard, so its autofocus works --
// and the blank tab is closed.
let started = false;
function startKiosk() {
  ready.then(() => {
    if (started || kiosk === null || typeof conf.startUrl !== "string" || !conf.startUrl) return;
    started = true;
    chrome.tabs.query({ windowId: kiosk }).then((blank) => {
      chrome.tabs.create({ windowId: kiosk, url: conf.startUrl, active: true }).then(() => {
        for (const t of blank) chrome.tabs.remove(t.id).catch(() => {});
      }).catch(() => {});
    }).catch(() => {});
  });
}

// NETWORK. The session reaches the network only through the connector's egress
// proxy, which applies this session's rule to the token it is given here (the
// proxy asks with a 407). Pages cannot read the token. A token the proxy
// refuses is not offered twice for the same request.
const offered = new Set();
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) { callback({}); return; }
    ready.then(() => {
      const token = typeof conf.proxyToken === "string" ? conf.proxyToken : "";
      if (!token || offered.has(details.requestId)) { callback({ cancel: true }); return; }
      offered.add(details.requestId);
      callback({ authCredentials: { username: "session", password: token } });
    });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"],
);
chrome.webRequest.onCompleted.addListener((d) => offered.delete(d.requestId), { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener((d) => offered.delete(d.requestId), { urls: ["<all_urls>"] });

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
