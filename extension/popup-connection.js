// Popup: RookHub-Verbindung (Zerlegung Z39, bis v1.73.1 in popup.js) — Ein-Klick-Verbindung ueber den Worker
// (rookhub-pair), Rueckfall „Token von Hand", „Trennen" mit Widerruf in RookHub (DELETE /api/extension/token/self).
// Klassisches Skript im globalen Scope des Popups (popup.html laedt es nach popup.js); beim Laden nur Zugriff auf
// Frueheres, die Neubeschriftung beim Sprachwechsel haengt es in repaintHooks (popup.js) ein.

// ─── RookHub-Verbindung ────────────────────────────────────────────────
// Einzige Eingabestelle für URL + Token. Geschrieben wird nach chrome.storage.local
// (`rookhubConfig`) — dieselbe Quelle, aus der content.js und chessable-activity.js pro
// Aktion frisch lesen; ein hier gesetzter Token wirkt also ohne Reload des Tabs.
// Der Token bleibt dabei im Extension-Origin: er läuft nie durch das DOM einer Website
// (s. CLAUDE.md „Sicherheit").
const ROOKHUB_DEFAULT_URL = 'https://rookhub.oberschmid.homes';
const CONN_URL = document.getElementById('conn-url');
const CONN_TOKEN = document.getElementById('conn-token');
const CONN_STATE_EL = document.getElementById('conn-state');
const CONN_PAIR = document.getElementById('conn-pair');
const CONN_TOKENS_LINK = document.getElementById('conn-tokens');

let connPaint = null;
function setConnState(key, params) {
  connPaint = { key, params: params || null };
  paintConnState();
}
function paintConnState() {
  if (connPaint) CONN_STATE_EL.textContent = t(connPaint.key, connPaint.params);
}
repaintHooks.push(paintConnState);

// Tippfehler-tolerant: fehlendes Schema ergänzen, Slash am Ende weg. `null` = unbrauchbar.
// Klartext-HTTP nur für localhost — sonst ginge der Token unverschlüsselt raus (wie background.js).
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

// Wie readRookhubConfigFromStorage(), aber auch ohne Token — für die URL-Vorbelegung.
function readRawRookhubConfig() {
  return new Promise((resolve) => {
    if (!chrome.storage || !chrome.storage.local) { resolve(null); return; }
    chrome.storage.local.get('rookhubConfig', (res) => resolve((res && res.rookhubConfig) || null));
  });
}

function writeRookhubConfig(cfg) {
  return new Promise((resolve) => {
    try { chrome.storage.local.set({ rookhubConfig: cfg }, resolve); } catch (e) { resolve(); }
  });
}

function updateTokensLink() {
  const url = normalizeRookhubUrl(CONN_URL.value) || ROOKHUB_DEFAULT_URL;
  CONN_TOKENS_LINK.href = url + '/profile';
}
CONN_URL.addEventListener('input', updateTokensLink);

async function refreshConnState() {
  const cfg = await readRawRookhubConfig();
  if (!CONN_URL.value) CONN_URL.value = (cfg && cfg.url) || ROOKHUB_DEFAULT_URL;
  updateTokensLink();
  setConnState(cfg && cfg.token ? 'popup.conn.connected' : 'popup.conn.notConnected');
  return cfg;
}

document.getElementById('conn-save').addEventListener('click', async () => {
  const url = normalizeRookhubUrl(CONN_URL.value);
  const token = (CONN_TOKEN.value || '').trim();
  if (!url) { setConnState('popup.conn.needUrl'); return; }
  if (!token) { setConnState('popup.conn.needToken'); return; }
  setConnState('popup.conn.checking');
  // Erst speichern, dann prüfen: der Background-Worker lässt den Fetch nur zur
  // konfigurierten Origin durch (Egress-Allowlist in background.js).
  await writeRookhubConfig({ url, token });
  try {
    await fetchRookhubRepertoires({ url, token });
    CONN_TOKEN.value = '';
    setConnState('popup.conn.connected');
    refreshStatus();
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    // Häufigster Fall bei vertippter Adresse: es antwortet zwar etwas, aber kein RookHub
    // (der Proxy meldet dann „invalid json", weil eine HTML-Fehlerseite zurückkommt).
    if (/invalid json/i.test(msg)) setConnState('popup.conn.errNotRookhub');
    else setConnState('popup.conn.failed', { error: msg });
  }
});

// „Trennen" widerruft den Token auch in RookHub (DELETE /api/extension/token/self — ein Extension-Token darf nur
// sich selbst widerrufen). `true`, wenn er dort nicht mehr gilt: widerrufen (2xx) oder ohnehin ungültig (401).
// Eine ältere RookHub-Version kennt den Endpunkt nicht (404), ohne Netz geht es auch nicht — dann wird nur hier
// getrennt, und der Nutzer erfährt, dass er den Token im Profil löschen muss. Vor dem Überschreiben der Config
// aufrufen: der Worker lässt den Abruf nur zur eingetragenen Origin durch.
async function revokeOwnToken(cfg) {
  if (!self.RepCheckRookhub.isConnected(cfg)) return true;
  try {
    await self.RepCheckRookhub.create({ t }).request('/api/extension/token/self', { method: 'DELETE', cfg });
    return true;
  } catch (e) {
    return !!(e && e.tokenInvalid);
  }
}

document.getElementById('conn-forget').addEventListener('click', async () => {
  const url = normalizeRookhubUrl(CONN_URL.value) || ROOKHUB_DEFAULT_URL;
  const widerrufen = await revokeOwnToken(await readRawRookhubConfig());
  await writeRookhubConfig({ url });   // URL behalten, Token weg
  CONN_TOKEN.value = '';
  setConnState(widerrufen ? 'popup.conn.notConnected' : 'popup.conn.forgetLocalOnly');
  refreshStatus();
});

// Ein-Klick-Verbindung: der Background-Worker öffnet RookHub, wartet auf die Anmeldung und
// legt den `rkh_`-Token über die vorhandene Sitzung selbst an (s. background.js `pairStart`).
// Der Worker macht das, nicht das Popup: sobald der Nutzer zum RookHub-Tab wechselt, ist das
// Popup zu — der Ablauf muss das überleben.
function sendBg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp || null);
      });
    } catch (e) { resolve(null); }
  });
}

let pairPoll = null;
function stopPairPoll() { if (pairPoll) { clearInterval(pairPoll); pairPoll = null; } }

function renderPairState(st) {
  if (!st) { setConnState('popup.conn.failed', { error: t('err.noBackground') }); CONN_PAIR.disabled = false; return; }
  switch (st.state) {
    case 'waiting':
      setConnState('popup.conn.pairing');
      break;
    case 'waitingLogin':
      setConnState('popup.conn.login');
      break;
    case 'creating':
      setConnState('popup.conn.creating');
      break;
    case 'done':
      stopPairPoll();
      CONN_PAIR.disabled = false;
      CONN_TOKEN.value = '';
      setConnState('popup.conn.connected');
      refreshConnState();
      refreshStatus();
      break;
    case 'timeout':
    case 'cancelled':
      stopPairPoll();
      CONN_PAIR.disabled = false;
      setConnState(st.state === 'timeout' ? 'popup.conn.timeout' : 'popup.conn.cancelled');
      break;
    case 'error':
      stopPairPoll();
      CONN_PAIR.disabled = false;
      // Bekannte Fälle übersetzt, alles andere als Server-/Netzmeldung durchreichen.
      if (st.error === 'auth') setConnState('popup.conn.errAuth');
      else if (st.error === 'notRookhub') setConnState('popup.conn.errNotRookhub');
      else if (st.error === 'tooManyTokens') setConnState('popup.conn.errTooMany');
      else setConnState('popup.conn.failed', { error: st.error || '?' });
      break;
    default:
      stopPairPoll();
      CONN_PAIR.disabled = false;
      break;
  }
}

function startPairPoll() {
  stopPairPoll();
  pairPoll = setInterval(async () => {
    renderPairState(await sendBg({ type: 'rookhub-pair-state', poll: true }));
  }, 900);
}

CONN_PAIR.addEventListener('click', async () => {
  const url = normalizeRookhubUrl(CONN_URL.value);
  if (!url) { setConnState('popup.conn.needUrl'); return; }
  CONN_PAIR.disabled = true;
  setConnState('popup.conn.pairing');
  renderPairState(await sendBg({ type: 'rookhub-pair', url }));
  if (CONN_PAIR.disabled) startPairPoll();   // noch am Laufen → weiter beobachten
});

// Beim Öffnen: Zustand herstellen. Ohne Token wird die Einstellungs-Box gleich aufgeklappt —
// das ist der Erstkontakt, und ohne Verbindung tut die Extension sonst nichts Sichtbares.
(async () => {
  const cfg = await refreshConnState();
  // Ordner-/PGN-Panel gibt es nur dort, wo content.js läuft.
  const tab = await getActiveTab();
  if (tab && tab.url && /^https:\/\/(www\.chess\.com|lichess\.org)\//.test(tab.url)) {
    document.getElementById('page-panel-row').style.display = 'flex';
  }
  const st = await sendBg({ type: 'rookhub-pair-state' });
  if (st && (st.state === 'waiting' || st.state === 'waitingLogin' || st.state === 'creating')) {
    showSettings(true);
    CONN_PAIR.disabled = true;
    renderPairState(st);
    startPairPoll();
  } else if (!cfg || !cfg.token) {
    showSettings(true);
  }
})();
