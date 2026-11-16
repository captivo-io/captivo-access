// Forwards typed-input events from the pages to the broker's control service
// (kasm-browser/control.py) inside this container. The page cannot reach it
// itself (another origin, a private address); the extension's host permission
// can. config.json is written per session by control.py and names the endpoint.
let endpoint = null;
const ready = fetch(chrome.runtime.getURL("config.json"))
  .then((r) => r.json())
  .then((c) => { endpoint = typeof c.url === "string" ? c.url : null; })
  .catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.k) return;
  ready.then(() => {
    if (!endpoint) return;
    fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([msg.k]) }).catch(() => {});
  });
});
