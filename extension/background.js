// Background service worker: proxies fetch() for the content script.
//
// Why: the content script runs in the chess.com page context, so its fetch()
// is subject to the page's CORS rules. RookHub instances that don't allow
// chess.com as Origin would fail. The background worker has `host_permissions`
// (declared in manifest.json) and can fetch cross-origin without CORS.
//
// Hardening: it is NOT a general proxy — it only accepts messages from this
// extension and only forwards to the user's configured RookHub origin
// (chrome.storage.local `rookhubConfig`). Everything else is rejected.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'rookhub-fetch') return false;

  // Defense in depth: only accept messages from THIS extension's own content
  // scripts. (onMessage is same-extension only, but be explicit — never let a
  // stray sender drive the privileged fetch proxy.)
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'unauthorized sender' });
    return false;
  }

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

  // The worker must NOT be a general fetch proxy: only forward to the user's own
  // configured RookHub instance. The content script mirrors {url,token} into
  // chrome.storage.local (key `rookhubConfig`); only allow the request if its
  // origin matches that stored URL's origin.
  chrome.storage.local.get('rookhubConfig', (res) => {
    const cfgUrl = res && res.rookhubConfig && res.rookhubConfig.url;
    if (!cfgUrl) {
      sendResponse({ ok: false, error: 'rookhub not configured' });
      return;
    }
    let allowedOrigin, targetOrigin;
    try {
      allowedOrigin = new URL(cfgUrl).origin;
      targetOrigin = new URL(url).origin;
    } catch (e) {
      sendResponse({ ok: false, error: 'invalid url' });
      return;
    }
    if (targetOrigin !== allowedOrigin) {
      sendResponse({ ok: false, error: 'target origin not allowed' });
      return;
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
  });

  // Tell Chrome we'll respond async.
  return true;
});
