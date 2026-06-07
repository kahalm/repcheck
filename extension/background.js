// Background service worker: proxies fetch() for the content script.
//
// Why: the content script runs in the chess.com page context, so its fetch()
// is subject to the page's CORS rules. RookHub instances that don't allow
// chess.com as Origin would fail. The background worker has `host_permissions`
// (declared in manifest.json) and can fetch any URL without CORS.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'rookhub-fetch') return false;

  const { url, headers, expect, method, body } = msg;
  if (typeof url !== 'string' || !url) {
    sendResponse({ ok: false, error: 'invalid url' });
    return false;
  }

  // Allow-list: only http(s). Defense in depth — the user enters this URL
  // freely, so refusing file:// / chrome-extension:// / data: is wise.
  if (!/^https?:\/\//i.test(url)) {
    sendResponse({ ok: false, error: 'url must be http(s)' });
    return false;
  }

  const init = {
    method: typeof method === 'string' && method ? method : 'GET',
    headers: headers || {},
    credentials: 'omit',
  };
  if (body != null && init.method !== 'GET' && init.method !== 'HEAD') {
    init.body = body;
  }

  fetch(url, init)
    .then(async (resp) => {
      const text = await resp.text();
      let parsed = text;
      if (expect === 'json') {
        try { parsed = text.length > 0 ? JSON.parse(text) : null; }
        catch (e) {
          sendResponse({ ok: false, status: resp.status, error: 'invalid json' });
          return;
        }
      }
      sendResponse({ ok: resp.ok, status: resp.status, body: parsed });
    })
    .catch((err) => {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    });

  // Tell Chrome we'll respond async.
  return true;
});
