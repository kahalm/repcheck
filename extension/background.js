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

  // Allow-list: HTTPS only (plus http on localhost/127.0.0.1 for local dev) so the
  // bearer token is never sent in cleartext to a remote host — and file:// /
  // chrome-extension:// / data: are refused. Matches the manifest host_permissions.
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url)) {
    sendResponse({ ok: false, error: 'url must be https (http only allowed for localhost)' });
    return false;
  }

  // The worker must NOT be a general fetch proxy: only forward to the user's own
  // configured RookHub instance. The content script mirrors {url,token} into
  // chrome.storage.local (key `rookhubConfig`); only allow the request if its
  // origin matches that stored URL's origin.
  // Default-Ziel für token-lose getReview-Linien (kein hinterlegter RookHub-Token): auch ohne
  // konfigurierte URL an dieses eine, fest bekannte Origin erlaubt (nicht offener Proxy).
  const DEFAULT_ROOKHUB_ORIGIN = 'https://rookhub.oberschmid.homes';
  chrome.storage.local.get('rookhubConfig', (res) => {
    const cfgUrl = res && res.rookhubConfig && res.rookhubConfig.url;
    const allowedOrigins = [DEFAULT_ROOKHUB_ORIGIN];
    if (cfgUrl) { try { allowedOrigins.push(new URL(cfgUrl).origin); } catch (e) { /* ignore */ } }
    let targetOrigin;
    try {
      targetOrigin = new URL(url).origin;
    } catch (e) {
      sendResponse({ ok: false, error: 'invalid url' });
      return;
    }
    if (!allowedOrigins.includes(targetOrigin)) {
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

// ─── Ein-Klick-Verbindung mit RookHub (v1.55.0) ────────────────────────────
//
// Vorher musste man den `rkh_`-Token in RookHub von Hand anlegen, kopieren und im
// In-Page-Panel einfügen — das es nur auf chess.com/lichess gibt. Stattdessen öffnet
// die Extension jetzt auf Klick den RookHub-Tab, wartet (falls nötig) auf die Anmeldung
// und legt sich den Token über die vorhandene Sitzung selbst an.
//
// Warum hier im Worker und nicht im Popup: sobald der Nutzer zum RookHub-Tab wechselt,
// um sich anzumelden, ist das Popup zu. Der Zustand liegt deshalb in chrome.storage.local
// (`rookhubPairing`) — der MV3-Worker darf zwischendurch sterben; geweckt wird er von
// tabs.onUpdated (Login-Navigation) bzw. vom Popup-Poll.
//
// Sicherheit: Das RookHub-JWT wird NUR aus einem Tab gelesen, dessen URL zur gerade
// eingetragenen RookHub-Origin passt, und nur nach ausdrücklichem Klick. Es wird nicht
// gespeichert — es dient einzig dem einen POST /api/profile/tokens; persistiert wird
// allein der zurückgegebene `rkh_`-Token (extension-privat, wie bisher).

const PAIR_KEY = 'rookhubPairing';
const PAIR_TIMEOUT_MS = 10 * 60 * 1000;
const PAIR_LIVE = ['waiting', 'waitingLogin', 'creating'];

function storeGet(key) {
  return new Promise((resolve) => {
    try { chrome.storage.local.get(key, (res) => resolve(res ? res[key] : undefined)); }
    catch (e) { resolve(undefined); }
  });
}

function storeSet(obj) {
  return new Promise((resolve) => {
    try { chrome.storage.local.set(obj, resolve); } catch (e) { resolve(); }
  });
}

// Tippfehler-tolerant, aber nie Klartext-HTTP nach außen (gleiche Regel wie der Fetch-Proxy).
function normalizeRookhubUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/i.test(u.hostname)) return null;
  // Tippmuell wie „ht!tp://…" wuerde sonst als https-Adresse durchgehen und erst am Netz scheitern.
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)$/i.test(u.hostname)) return null;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch (e) { return false; }
}

// Ein JWT, das während des Anlegens abläuft, hilft nicht — 30 s Sicherheitsabstand.
function isUsableJwt(tok) {
  if (typeof tok !== 'string') return false;
  const teile = tok.split('.');
  if (teile.length !== 3) return false;
  try {
    const b64 = teile[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
    return !payload.exp || payload.exp * 1000 > Date.now() + 30000;
  } catch (e) { return false; }
}

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text: text || '' });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) { /* Badge ist Kür */ }
}

async function pairSet(patch) {
  const cur = (await storeGet(PAIR_KEY)) || {};
  const next = Object.assign({}, cur, patch, { updatedAt: Date.now() });
  await storeSet({ [PAIR_KEY]: next });
  return next;
}

// Liest das Anmelde-JWT aus dem RookHub-Tab (Angular legt es unter `rookhub_user` ab).
async function readJwtFromTab(tabId) {
  let res;
  try {
    res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const raw = localStorage.getItem('rookhub_user');
          if (!raw) return null;
          const u = JSON.parse(raw);
          return (u && typeof u.token === 'string') ? u.token : null;
        } catch (e) { return null; }
      },
    });
  } catch (e) { return null; }
  const tok = res && res[0] && res[0].result;
  return isUsableJwt(tok) ? tok : null;
}

// Legt den Extension-Token über die Anmelde-Sitzung an. Fehlercodes 'auth'/'notRookhub'
// übersetzt das Popup; alles andere ist eine Server-Meldung und wird durchgereicht.
async function createApiToken(baseUrl, jwt) {
  const label = /Firefox/i.test(navigator.userAgent) ? 'Firefox'
    : /Edg\//i.test(navigator.userAgent) ? 'Edge'
    : /Chrome/i.test(navigator.userAgent) ? 'Chrome' : 'Browser';
  const resp = await fetch(baseUrl + '/api/profile/tokens', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + jwt,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    credentials: 'omit',
    body: JSON.stringify({ name: 'RepCheck (' + label + ')', scope: 'extension', expiresInDays: null }),
  });
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { /* HTML/Fehlerseite */ }
  if (resp.status === 401) throw new Error('auth');
  if (resp.status === 404) throw new Error('notRookhub');
  if (!resp.ok) throw new Error((body && body.message) || ('HTTP ' + resp.status));
  const raw = body && (body.rawToken || body.RawToken);
  if (!raw) throw new Error('notRookhub');
  return raw;
}

// Ein Anlauf: Tab prüfen → JWT lesen → Token anlegen. Popup-Poll und tabs.onUpdated können
// gleichzeitig anklopfen — der Riegel verhindert, dass daraus zwei Tokens werden.
let pairBusy = false;
async function pairAttempt() {
  if (pairBusy) return (await storeGet(PAIR_KEY)) || { state: 'idle' };
  pairBusy = true;
  try { return await pairAttemptOnce(); }
  finally { pairBusy = false; }
}

async function pairAttemptOnce() {
  const st = await storeGet(PAIR_KEY);
  if (!st || !st.tabId || PAIR_LIVE.indexOf(st.state) < 0) return st || { state: 'idle' };
  if (Date.now() - (st.startedAt || 0) > PAIR_TIMEOUT_MS) { setBadge(''); return pairSet({ state: 'timeout' }); }

  let tab = null;
  try { tab = await chrome.tabs.get(st.tabId); } catch (e) { tab = null; }
  if (!tab) { setBadge(''); return pairSet({ state: 'cancelled' }); }
  // Weggenavigiert oder noch am Laden → nichts injizieren, nur weiter warten.
  if (!tab.url || !sameOrigin(tab.url, st.url) || tab.status !== 'complete') return pairSet({ state: 'waiting' });

  const jwt = await readJwtFromTab(st.tabId);
  if (!jwt) {
    // Nicht angemeldet: den (bis dahin unsichtbaren) Tab nach vorn holen, damit der
    // Nutzer sich anmelden kann. Danach weckt tabs.onUpdated den nächsten Anlauf.
    if (!st.activated) {
      try {
        await chrome.tabs.update(st.tabId, { active: true });
        if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      } catch (e) { /* Fenster-Fokus ist Kür */ }
    }
    return pairSet({ state: 'waitingLogin', activated: true });
  }

  await pairSet({ state: 'creating' });
  try {
    const token = await createApiToken(st.url, jwt);
    await storeSet({ rookhubConfig: { url: st.url, token } });
    setBadge('✓', '#2a8c4a');
    // ERST 'done' festschreiben, DANN den Tab schließen: sonst meldet der onRemoved-Horcher
    // den selbst ausgelösten Tab-Schluss als „abgebrochen" und überschreibt den Erfolg.
    const fertig = await pairSet({ state: 'done', error: null });
    // Selbst geöffneten Hintergrund-Tab wieder schließen — den hat der Nutzer nie gesehen.
    if (st.createdTab && !st.activated) { try { await chrome.tabs.remove(st.tabId); } catch (e) { /* egal */ } }
    return fertig;
  } catch (e) {
    setBadge('');
    return pairSet({ state: 'error', error: String((e && e.message) || e) });
  }
}

async function pairStart(rawUrl) {
  const url = normalizeRookhubUrl(rawUrl);
  if (!url) return { state: 'error', error: 'invalid url' };

  // Ziel-Origin MUSS vor dem ersten Fetch in der Config stehen — daran hängt die
  // Egress-Allowlist oben. Ein Token derselben Instanz bleibt bis zum Erfolg erhalten.
  const cfg = (await storeGet('rookhubConfig')) || {};
  const keep = (cfg.url && cfg.token && sameOrigin(cfg.url, url)) ? cfg.token : null;
  await storeSet({ rookhubConfig: keep ? { url, token: keep } : { url } });

  // Offenen RookHub-Tab wiederverwenden — wer schon angemeldet dort steht, merkt vom
  // ganzen Vorgang nichts. Sonst einen im Hintergrund öffnen.
  let tabId = null, createdTab = false;
  try {
    const offen = await chrome.tabs.query({ url: new URL(url).origin + '/*' });
    if (offen && offen.length) tabId = offen[0].id;
  } catch (e) { /* ohne Treffer neu öffnen */ }
  if (tabId == null) {
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
      createdTab = true;
    } catch (e) {
      return { state: 'error', error: String((e && e.message) || e) };
    }
  }
  await storeSet({ [PAIR_KEY]: { url, tabId, createdTab, activated: false, state: 'waiting', startedAt: Date.now() } });
  setBadge('…', '#7a8a9a');
  return pairAttempt();
}

// Weckt den Worker, wenn im RookHub-Tab navigiert wird (Anmeldung, SPA-Wechsel).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo || (!changeInfo.status && !changeInfo.url)) return;
  storeGet(PAIR_KEY).then((st) => {
    if (st && st.tabId === tabId && PAIR_LIVE.indexOf(st.state) >= 0) pairAttempt();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  storeGet(PAIR_KEY).then((st) => {
    if (st && st.tabId === tabId && PAIR_LIVE.indexOf(st.state) >= 0) { setBadge(''); pairSet({ state: 'cancelled' }); }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== 'rookhub-pair' && msg.type !== 'rookhub-pair-state')) return false;
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ state: 'error', error: 'unauthorized sender' });
    return false;
  }
  (async () => {
    if (msg.type === 'rookhub-pair') {
      sendResponse(await pairStart(msg.url));
      return;
    }
    let st = (await storeGet(PAIR_KEY)) || { state: 'idle' };
    if (msg.poll && PAIR_LIVE.indexOf(st.state) >= 0) st = await pairAttempt();
    if (st.state === 'done') setBadge('');   // Popup hat den Erfolg gesehen
    sendResponse(st);
  })();
  return true;
});

// ─── Einführung für neue Nutzer (v1.59.0) ──────────────────────────────────
//
// Nach einer FRISCHEN Installation öffnet sich einmal die Willkommensseite (welcome.html), und das Popup
// zeigt die „Erste Schritte"-Checkliste (`rcOnboarding: 'active'`). Bestehende Nutzer brauchen keine
// Einführung — sie bekommen nach dem Update von einer Version vor 1.59.0 einmal den Hinweis, dass die
// Chessable-Buttons jetzt standardmäßig aus sind (`rcButtonsNotice: 'pending'`; Popup und Practice-Seite
// zeigen ihn, bis er bestätigt oder eine Button-Auswahl gespeichert wird).
const BUTTONS_DEFAULT_OFF_SINCE = '1.59.0';

// „1.9.0" < „1.59.0": Teile als Zahlen vergleichen, nicht als Text.
function versionLess(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

// Was nach runtime.onInstalled zu tun ist — rein, damit testbar (test/onboarding.test.js).
function onboardingPlan(details) {
  if (!details) return {};
  if (details.reason === 'install') return { openWelcome: true, onboarding: 'active' };
  if (details.reason === 'update' && details.previousVersion
      && versionLess(details.previousVersion, BUTTONS_DEFAULT_OFF_SINCE)) {
    return { buttonsNotice: 'pending' };
  }
  return {};
}

function openWelcome(section) {
  const hash = ['connect', 'usage', 'buttons'].indexOf(section) >= 0 ? '#' + section : '';
  try { chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') + hash }); } catch (e) { /* Kür */ }
}

async function applyInstallDetails(details) {
  const plan = onboardingPlan(details);
  const patch = {};
  if (plan.onboarding) patch.rcOnboarding = plan.onboarding;
  if (plan.buttonsNotice) patch.rcButtonsNotice = plan.buttonsNotice;
  if (Object.keys(patch).length) await storeSet(patch);
  if (plan.openWelcome) openWelcome();
  return plan;
}

chrome.runtime.onInstalled.addListener((details) => { applyInstallDetails(details); });

// Der Hinweis auf chessable.com öffnet die Willkommensseite über den Worker — ein Content-Script darf
// chrome.tabs nicht selbst benutzen.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'rc-open-welcome') return false;
  if (!sender || sender.id !== chrome.runtime.id) return false;
  openWelcome(msg.section);
  sendResponse({ ok: true });
  return false;
});
