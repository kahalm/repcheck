// Popup-Logik: zeigt den Cache-Status und triggert das Content-Script auf
// Klick. Seit v1.4.8 wird das Content-Script NICHT mehr automatisch in
// chess.com-Tabs geladen, sondern erst hier via chrome.scripting.executeScript.

const STATUS_EL = document.getElementById('status');
const ERROR_EL = document.getElementById('error-hint');
const REP_EL = document.getElementById('repertoires');

// ─── Sprache ───────────────────────────────────────────────────────────
// Alle sichtbaren Texte kommen aus der geteilten Tabelle lib/i18n.js (self.RepCheckI18n,
// wird in popup.html VOR dieser Datei geladen). `rcLang` ist die aktive Sprache,
// `rcLangStored` die ausdrückliche Wahl des Nutzers ('' = automatisch nach Browsersprache).
let rcLang = self.RepCheckI18n.resolveLang(null, navigator.languages);
let rcLangStored = '';
function t(key, params) { return self.RepCheckI18n.translate(rcLang, key, params); }

// Die Sprachnamen im Auswahlfeld bleiben in ihrer eigenen Sprache (Konvention, kein Schlüssel).
const LANG_NAMES = { en: 'English', de: 'Deutsch', hr: 'Hrvatski' };
const LANG_SELECT = document.getElementById('lang-select');

// Statische Beschriftungen aus dem HTML (data-i18n / -title / -placeholder) neu setzen.
function applyI18n(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  document.documentElement.lang = rcLang;
  if (LANG_SELECT) {
    const auto = self.RepCheckI18n.resolveLang(null, navigator.languages);
    const autoOpt = LANG_SELECT.querySelector('option[value=""]');
    if (autoOpt) autoOpt.textContent = t('lang.auto', { lang: LANG_NAMES[auto] || auto });
    LANG_SELECT.value = rcLangStored;
  }
}

// Beschriftet das ganze Popup neu — statisches Gerüst plus die zur Laufzeit gesetzten Texte,
// die dafür ihren letzten Zustand (Schlüssel + Parameter) merken statt fertiger Strings.
function repaintAll() {
  applyI18n(document);
  paintStatus();
  renderRepertoireList(repItems);
  paintShareState();
  paintChessableState();
  paintConnState();
  paintCrawlSettings();
  // ciRender(null) hieße „Content-Script nicht bereit" — nur neu zeichnen, wenn das
  // Import-Panel überhaupt an einem Chessable-Tab hängt.
  if (ciTabId != null) ciRender(lastCiState);
}

applyI18n(document);

if (chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(['rcLang'], (r) => {
    rcLangStored = (r && r.rcLang) || '';
    rcLang = self.RepCheckI18n.resolveLang(rcLangStored, navigator.languages);
    repaintAll();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.rcLang) {
      rcLangStored = ch.rcLang.newValue || '';
      rcLang = self.RepCheckI18n.resolveLang(rcLangStored, navigator.languages);
      repaintAll();
    }
  });
}

if (LANG_SELECT) {
  LANG_SELECT.addEventListener('change', () => {
    const v = LANG_SELECT.value;
    rcLangStored = v;
    rcLang = self.RepCheckI18n.resolveLang(v, navigator.languages);
    try {
      // Leerer Wert = „automatisch": Schlüssel löschen statt '' zu speichern, sonst würde
      // resolveLang zwar auch fallen, aber der Speicher trüge einen Wert ohne Bedeutung.
      if (v) chrome.storage.local.set({ rcLang: v });
      else chrome.storage.local.remove('rcLang');
    } catch (e) {}
    repaintAll();
  });
}

document.getElementById('open-chesscom').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.chess.com/' });
});
document.getElementById('open-lichess').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://lichess.org/' });
});

document.getElementById('run-check').addEventListener('click', () => triggerInTab('runCheck'));

// „Einstellungen" klappt seit v1.55.0 IMMER die Einstellungen hier im Popup auf — auf jedem
// Tab, auch auf chessable.com oder einem leeren Tab. Vorher hing die RookHub-Verbindung am
// In-Page-Panel und war damit nur auf chess.com/lichess erreichbar. Das seiten-injizierte Panel
// bleibt für das, was Seiten-Kontext braucht (Ordner-Auswahl, PGN einfügen) und ist auf
// chess.com/lichess über „Ordner / PGN auf der Seite…" erreichbar.
const SETTINGS_BOX = document.getElementById('settings-box');
function settingsVisible() { return SETTINGS_BOX.style.display === 'block'; }
function showSettings(on) { SETTINGS_BOX.style.display = on ? 'block' : 'none'; }

document.getElementById('open-settings').addEventListener('click', () => {
  showSettings(!settingsVisible());
});

document.getElementById('open-page-panel').addEventListener('click', () => triggerInTab('openSettings'));

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

document.getElementById('conn-forget').addEventListener('click', async () => {
  const url = normalizeRookhubUrl(CONN_URL.value) || ROOKHUB_DEFAULT_URL;
  await writeRookhubConfig({ url });   // URL behalten, Token weg
  CONN_TOKEN.value = '';
  setConnState('popup.conn.notConnected');
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

// ─── Chessable-Button-Einstellungen (pro Button/Anzeige ein-/ausblendbar) ──────
// Persistiert in chrome.storage.local `chessableButtons`; chessable-activity.js spiegelt es live
// an chessable-fen.js (MAIN-World), das die Leiste unten rechts entsprechend zeigt/versteckt.
// Seit v1.59.0 ist dort ALLES aus, bis es hier eingeschaltet wird — nur ein gespeichertes `true` zählt.
const CB_KEYS = ['copyFen', 'analyse', 'searchFen', 'refresh', 'remember', 'fullscreen', 'pool', 'feedback'];
function cbEl(k) { return document.getElementById('cb-' + k); }
function loadChessableButtons() {
  if (!chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get('chessableButtons', (res) => {
    const s = (res && res.chessableButtons) || {};
    for (const k of CB_KEYS) { const el = cbEl(k); if (el) el.checked = s[k] === true; }
  });
}
function saveChessableButtons() {
  const s = {};
  for (const k of CB_KEYS) { const el = cbEl(k); s[k] = el ? el.checked : false; }
  // Eine gespeicherte Auswahl erledigt auch den Update-Hinweis „Buttons jetzt aus".
  try { chrome.storage.local.set({ chessableButtons: s, rcButtonsNotice: 'done' }); } catch (e) {}
}
for (const k of CB_KEYS) { const el = cbEl(k); if (el) el.addEventListener('change', saveChessableButtons); }
loadChessableButtons();

// ─── Erste Schritte + Hinweis „Buttons jetzt aus" (v1.59.0) ─────────────
// Die Checkliste gibt es nur nach einer FRISCHEN Installation (background.js setzt `rcOnboarding: 'active'`)
// und nur, bis alles erledigt oder sie weggeklickt ist. Bestehende Nutzer brauchen keine Einführung; sie
// bekommen nach dem Update einmal den Hinweis, dass die Chessable-Buttons jetzt aus sind
// (`rcButtonsNotice: 'pending'`). Erledigt heißt: verbunden = Token in `rookhubConfig`; Kurs geholt =
// `rcCourseFetched` (setzt chessable-activity.js nach einem erfolgreichen Import); Buttons gewählt =
// `chessableButtons` wurde je gespeichert (auch „alles aus" ist eine Wahl).
const ONB_BOX = document.getElementById('onboarding');
const NOTICE_BOX = document.getElementById('buttons-notice');
const ONB_STORAGE_KEYS = ['rcOnboarding', 'rcButtonsNotice', 'rcCourseFetched', 'chessableButtons', 'rookhubConfig'];

function onboardingState(s) {
  const steps = {
    connect: !!(s && s.rookhubConfig && s.rookhubConfig.token),
    course: !!(s && s.rcCourseFetched === true),
    buttons: !!(s && s.chessableButtons),
  };
  const allDone = steps.connect && steps.course && steps.buttons;
  return {
    steps,
    showChecklist: !!(s && s.rcOnboarding === 'active') && !allDone,
    showNotice: !!(s && s.rcButtonsNotice === 'pending'),
  };
}

function openWelcomePage(section) {
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') + (section ? '#' + section : '') });
}

function setLocal(obj) { try { chrome.storage.local.set(obj); } catch (e) {} }

function focusSettings(id) {
  showSettings(true);
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function renderOnboarding(s) {
  const st = onboardingState(s);
  ONB_BOX.style.display = st.showChecklist ? 'block' : 'none';
  for (const k of Object.keys(st.steps)) {
    const li = document.getElementById('onb-' + k);
    if (li) li.classList.toggle('done', st.steps[k]);
  }
  NOTICE_BOX.style.display = st.showNotice ? 'block' : 'none';
}

function refreshOnboarding() {
  if (!chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get(ONB_STORAGE_KEYS, (s) => renderOnboarding(s || {}));
}

function onClick(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', (e) => { e.preventDefault(); fn(); });
}
onClick('onb-connect-link', () => focusSettings('rookhub-conn'));
onClick('onb-course-link', () => openWelcomePage('usage'));
onClick('onb-buttons-link', () => focusSettings('chessable-settings'));
onClick('onb-welcome', () => openWelcomePage());
onClick('open-welcome', () => openWelcomePage());
onClick('onb-close', () => setLocal({ rcOnboarding: 'dismissed' }));
onClick('notice-choose', () => { setLocal({ rcButtonsNotice: 'done' }); focusSettings('chessable-settings'); });
onClick('notice-ok', () => setLocal({ rcButtonsNotice: 'done' }));

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ONB_STORAGE_KEYS.some((k) => ch[k])) refreshOnboarding();
  });
}
refreshOnboarding();

// ─── Kurs holen: Pause zwischen Chessable-Abrufen ─────────────────────
// chessable-activity.js wartet zwischen zwei Abrufen eine zufällige Zeit im Bereich `crawlDelay`
// (chrome.storage.local, {minMs,maxMs}) und führt Änderungen live nach. Der Standard 2,5–3,5 s ist die
// Untergrenze: normalizeCrawlDelay (lib/chessable-crawl.js, dieselbe Funktion wie im Content-Script)
// hebt alles darunter an — einstellbar ist also nur „langsamer".
const CRAWL_MIN_EL = document.getElementById('crawl-min');
const CRAWL_MAX_EL = document.getElementById('crawl-max');
const CRAWL_INTRO_EL = document.getElementById('crawl-intro');
const CRAWL_STATE_EL = document.getElementById('crawl-state');
const CrawlLib = self.RepCheckCrawl;

let crawlPaint = null;   // { key, cfg } — Rückmeldung nach dem Speichern, für den Sprachwechsel gemerkt
function crawlSekunden(ms) {
  return new Intl.NumberFormat(rcLang, { maximumFractionDigits: 2 }).format(ms / 1000);
}
function paintCrawlSettings() {
  const d = CrawlLib.CRAWL_DELAY_DEFAULT;
  CRAWL_INTRO_EL.textContent = t('popup.crawl.intro', { min: crawlSekunden(d.minMs), max: crawlSekunden(d.maxMs) });
  CRAWL_STATE_EL.textContent = crawlPaint
    ? t(crawlPaint.key, { min: crawlSekunden(crawlPaint.cfg.minMs), max: crawlSekunden(crawlPaint.cfg.maxMs) })
    : '';
}
function showCrawlDelay(cfg) {
  CRAWL_MIN_EL.value = String(cfg.minMs / 1000);
  CRAWL_MAX_EL.value = String(cfg.maxMs / 1000);
}
function readSekundenFeld(el) {
  const v = parseFloat(String(el.value).replace(',', '.'));
  return Number.isFinite(v) ? Math.round(v * 1000) : NaN;
}
function saveCrawlDelay() {
  const getippt = { minMs: readSekundenFeld(CRAWL_MIN_EL), maxMs: readSekundenFeld(CRAWL_MAX_EL) };
  const cfg = CrawlLib.normalizeCrawlDelay(getippt);
  showCrawlDelay(cfg);
  // Weicht das Gespeicherte vom Getippten ab (zu schnell, leer, von > bis), sagen wir es statt still zu korrigieren.
  const angepasst = cfg.minMs !== getippt.minMs || cfg.maxMs !== getippt.maxMs;
  crawlPaint = { key: angepasst ? 'popup.crawl.adjusted' : 'popup.crawl.saved', cfg };
  paintCrawlSettings();
  try { chrome.storage.local.set({ crawlDelay: cfg }); } catch (e) {}
}
CRAWL_MIN_EL.addEventListener('change', saveCrawlDelay);
CRAWL_MAX_EL.addEventListener('change', saveCrawlDelay);

showCrawlDelay(CrawlLib.normalizeCrawlDelay(null));
paintCrawlSettings();
if (chrome.storage && chrome.storage.local) {
  chrome.storage.local.get('crawlDelay', (r) => showCrawlDelay(CrawlLib.normalizeCrawlDelay(r && r.crawlDelay)));
}

function readRookhubStore() {
  return new Promise((resolve) => {
    const req = indexedDB.open('RepertoireCheckerDB', 2);
    req.onerror = () => resolve({ config: null, cache: null });
    // Muss dem Schema in content.js openIDB() entsprechen — sonst legt das Popup
    // die DB ohne den rookhub-Store an und content.js bekommt keinen Upgrade-
    // Trigger mehr, weil die Version schon stimmt.
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      if (!db.objectStoreNames.contains('rookhub')) db.createObjectStore('rookhub');
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('rookhub')) {
        db.close();
        resolve({ config: null, cache: null });
        return;
      }
      const tx = db.transaction('rookhub', 'readonly');
      const store = tx.objectStore('rookhub');
      const getCfg = store.get('config');
      const getCache = store.get('cache');
      let pending = 2;
      const out = { config: null, cache: null };
      const done = () => { if (--pending === 0) { db.close(); resolve(out); } };
      getCfg.onsuccess = () => { out.config = getCfg.result || null; done(); };
      getCfg.onerror = done;
      getCache.onsuccess = () => { out.cache = getCache.result || null; done(); };
      getCache.onerror = done;
    };
  });
}

// Holt die Repertoire-Liste vom RookHub-Server via Background-Worker (CORS-frei).
function fetchRookhubRepertoires(cfg) {
  const baseUrl = (cfg.url || '').replace(/\/$/, '');
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'rookhub-fetch',
      url: baseUrl + '/api/extension/repertoires?kind=opening',
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Accept': 'application/json',
      },
      expect: 'json',
    }, (resp) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!resp) { reject(new Error(t('err.noBackground'))); return; }
      if (resp.status === 401) { reject(new Error(t('err.tokenInvalid'))); return; }
      if (!resp.ok) { reject(new Error(resp.error || t('err.http', { status: resp.status }))); return; }
      resolve(Array.isArray(resp.body) ? resp.body : []);
    });
  });
}

// Zuletzt gezeigte Liste — für das Neubeschriften nach einem Sprachwechsel.
let repItems = null;

function renderRepertoireList(items) {
  repItems = (items && items.length) ? items : null;
  if (!items || items.length === 0) {
    REP_EL.style.display = 'none';
    return;
  }
  const heading = document.createElement('div');
  heading.className = 'heading';
  heading.textContent = t('popup.rep.heading', { count: items.length });
  const ul = document.createElement('ul');
  for (const it of items) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = it.name || t('popup.rep.unnamed');
    const count = document.createElement('span');
    count.className = 'count';
    if (typeof it.fileCount === 'number') {
      count.textContent = t('popup.rep.files', { count: it.fileCount });
    }
    li.appendChild(name);
    li.appendChild(count);
    ul.appendChild(li);
  }
  REP_EL.replaceChildren(heading, ul);
  REP_EL.style.display = 'block';
}

// Die RookHub-Config wird vom Content-Script auch nach chrome.storage.local
// gespiegelt (saveRookhubConfig, Key `rookhubConfig`). Das ist hier die
// VERLAESSLICHE Quelle: die IndexedDB `RepertoireCheckerDB` ist origin-scoped
// (chess.com/lichess) und im Popup-Origin (chrome-extension://…) NICHT lesbar —
// readRookhubStore() liefert hier also nie die Config. chrome.storage.local ist
// dagegen extension-weit.
function readRookhubConfigFromStorage() {
  return new Promise((resolve) => {
    if (!chrome.storage || !chrome.storage.local) { resolve(null); return; }
    chrome.storage.local.get('rookhubConfig', (res) => {
      const c = res && res.rookhubConfig;
      resolve(c && c.url && c.token ? c : null);
    });
  });
}

// Statuszeile: Schlüssel + Parameter merken (nicht den fertigen Text), damit ein
// Sprachwechsel dieselbe Aussage ohne erneuten Netz-Roundtrip neu beschriften kann.
let statusPaint = { cls: 'status', key: 'popup.status.loading', params: null };
function setStatus(cls, key, params) {
  statusPaint = { cls, key, params: params || null };
  paintStatus();
}
function paintStatus() {
  STATUS_EL.className = statusPaint.cls;
  STATUS_EL.textContent = t(statusPaint.key, statusPaint.params);
}

async function refreshStatus() {
  let store;
  try {
    store = await readRookhubStore();
  } catch {
    store = { config: null, cache: null };
  }
  // chrome.storage.local-Spiegel hat Vorrang vor der (im Popup-Origin leeren) IDB.
  const config = (await readRookhubConfigFromStorage()) || store.config;
  const { cache } = store;

  if (config && config.url && config.token) {
    setStatus('status', 'popup.rookhub.loading');
    try {
      const items = await fetchRookhubRepertoires(config);
      if (items.length > 0) {
        setStatus('status loaded', 'popup.rookhub.connected', { count: items.length });
        renderRepertoireList(items);
      } else {
        setStatus('status empty', 'popup.rookhub.noOpenings');
      }
    } catch (e) {
      setStatus('status error', 'popup.rookhub.error', { error: e.message });
    }
    return;
  }

  if (cache && cache.count > 0) {
    const ago = Math.round((Date.now() - (cache.savedAt || 0)) / 60000);
    setStatus('status loaded', 'popup.local.loaded', { count: cache.count, min: ago });
    return;
  }

  setStatus('status empty', 'popup.none');
}

refreshStatus();

// ─── Chessable-Token ───────────────────────────────────────────────────
// Der von chessable.com abgefangene Bearer-Token liegt in chrome.storage.local
// (origin-uebergreifend lesbar). Das Popup zeigt ihn nicht an (zu lang), sondern
// bietet nur einen Copy-Button fuer die Weitergabe an piratechess.
const CHESSABLE_BOX = document.getElementById('chessable-box');
const COPY_CHESSABLE = document.getElementById('copy-chessable');
const CHESSABLE_STATE = document.getElementById('chessable-state');

let chessablePaint = null;
function setChessableState(key, params) {
  chessablePaint = { key, params: params || null };
  paintChessableState();
}
function paintChessableState() {
  if (chessablePaint) CHESSABLE_STATE.textContent = t(chessablePaint.key, chessablePaint.params);
}

function refreshChessableToken() {
  if (!chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get('chessableToken', (res) => {
    const entry = res && res.chessableToken;
    if (!entry || !entry.token) {
      CHESSABLE_BOX.style.display = 'none';
      return;
    }
    CHESSABLE_BOX.style.display = 'block';
    COPY_CHESSABLE.disabled = false;
    const ago = Math.round((Date.now() - (entry.capturedAt || 0)) / 60000);
    if (ago <= 0) setChessableState('popup.chessable.justCaptured');
    else setChessableState('popup.chessable.capturedAgo', { min: ago });
  });
}

COPY_CHESSABLE.addEventListener('click', () => {
  chrome.storage.local.get('chessableToken', async (res) => {
    const entry = res && res.chessableToken;
    if (!entry || !entry.token) return;
    try {
      await navigator.clipboard.writeText(entry.token);
      setChessableState('popup.copied');
    } catch (e) {
      setChessableState('popup.copyFailed');
    }
  });
});

refreshChessableToken();

function showError(msg) {
  ERROR_EL.textContent = msg;
  ERROR_EL.style.display = 'block';
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

// ─── Sharebar: Link zur aktuellen Line ─────────────────────────────────
// Oben im Popup ein oeffentlicher Nur-Ansehen-Link (/l/{token}) zur gerade auf
// chess.com/lichess gespielten Zugfolge. Beim Oeffnen des Popups wird die
// aktuelle Line aus dem Tab gelesen und serverseitig als Line geteilt (Dedup:
// dieselbe Zugfolge -> derselbe Link). Braucht eine konfigurierte RookHub-Instanz.
const SHAREBAR = document.getElementById('sharebar');
const SHARE_URL = document.getElementById('share-url');
const COPY_SHARE = document.getElementById('copy-share');
const SHARE_STATE = document.getElementById('share-state');

let sharePaint = null;
function setShareState(key, params) {
  sharePaint = { key, params: params || null };
  paintShareState();
}
function paintShareState() {
  if (sharePaint) SHARE_STATE.textContent = t(sharePaint.key, sharePaint.params);
}

async function ensureContentLoaded(tab) {
  const [precheck] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => !!window.__rdc_loaded,
  });
  if (!precheck || !precheck.result) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['chess.min.js', 'lib/repertoire-text.js', 'lib/i18n.js', 'content.js'],
    });
  }
}

async function getCurrentLineFromTab(tab) {
  await ensureContentLoaded(tab);
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const api = window.__rdc_loaded;
      return api && typeof api.getCurrentLine === 'function' ? api.getCurrentLine() : { moves: [], title: '' };
    },
  });
  return (res && res.result) || { moves: [], title: '' };
}

function postShareLine(cfg, moves, title) {
  const baseUrl = (cfg.url || '').replace(/\/$/, '');
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'rookhub-fetch',
      url: baseUrl + '/api/extension/share-line',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ moves, title }),
      expect: 'json',
    }, (resp) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!resp) { reject(new Error(t('err.noBackground'))); return; }
      if (resp.status === 401) { reject(new Error(t('err.tokenInvalid'))); return; }
      if (!resp.ok) { reject(new Error(resp.error || t('err.http', { status: resp.status }))); return; }
      resolve(resp.body);
    });
  });
}

async function initShareBar() {
  const cfg = await readRookhubConfigFromStorage();
  if (!cfg) return; // ohne RookHub-Config kein Teilen-Link
  const tab = await getActiveTab();
  if (!tab || !tab.url || !/^https:\/\/(www\.chess\.com|lichess\.org)\//.test(tab.url)) return;
  SHAREBAR.style.display = 'block';
  setShareState('popup.share.loading');
  COPY_SHARE.disabled = true;
  try {
    const line = await getCurrentLineFromTab(tab);
    if (!line.moves || !line.moves.length) {
      SHARE_URL.value = '';
      setShareState('popup.share.noMoves');
      return;
    }
    const res = await postShareLine(cfg, line.moves, line.title);
    const token = res && (res.shareToken || res.ShareToken);
    if (!token) throw new Error(t('err.noToken'));
    SHARE_URL.value = (cfg.url || '').replace(/\/$/, '') + '/l/' + token;
    COPY_SHARE.disabled = false;
    setShareState('popup.share.ready', { count: line.moves.length });
  } catch (e) {
    SHARE_URL.value = '';
    setShareState('popup.share.failed', { error: (e && e.message ? e.message : String(e)) });
  }
}

COPY_SHARE.addEventListener('click', async () => {
  if (!SHARE_URL.value) return;
  try {
    await navigator.clipboard.writeText(SHARE_URL.value);
  } catch {
    SHARE_URL.select();
    document.execCommand('copy');
  }
  setShareState('popup.copied');
});

initShareBar();

// ─── RookHub-Import (Browser) auf chessable.com ────────────────────────
// Das früher on-page (links unten) eingeblendete Import-Panel lebt jetzt hier im Popup.
// Das Content-Script chessable-activity.js (isolierte Welt, per manifest auto-injiziert)
// hält den Zustand + die Import-Logik; das Popup fragt ihn per chrome.tabs.sendMessage ab
// (`{type:'rc-import', action}`) und pollt `state`, solange es offen ist.
const CI_BOX = document.getElementById('chessable-import');
const CI_COURSE = document.getElementById('ci-course');
const CI_CRAWL = document.getElementById('ci-crawl');
const CI_IMPORTCAP = document.getElementById('ci-importcap');
const CI_PROGRESS = document.getElementById('ci-progress');
const CI_STATUS = document.getElementById('ci-status');
let ciTabId = null, ciPoll = null, ciTargetInit = false;
// Mitlaufender Timer im Status („… · 1:23"): Basistext + Crawl-Startzeit getrennt halten,
// damit ein 1-s-Ticker die verstrichene Zeit unabhängig vom 1,5-s-State-Poll aktualisiert.
let ciStatusBase = '', ciStartedAt = null, ciTimerInt = null;
let ciCrawling = false;
// Letzter vom Content-Script gemeldeter Zustand — für das Neuzeichnen nach Sprachwechsel.
let lastCiState = null;

function ciElapsedLabel(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function paintCiStatus() {
  CI_STATUS.textContent = ciStartedAt
    ? (ciStatusBase ? `${ciStatusBase} · ${ciElapsedLabel(ciStartedAt)}` : ciElapsedLabel(ciStartedAt))
    : ciStatusBase;
}

function ciSelectedTarget() {
  const r = document.querySelector('input[name="ci-target"]:checked');
  return r ? r.value : 'repertoire';
}

// ---- Gestoppter Kurs-Abruf (v1.60.0) ----
// Stoppt „Kurs holen" wegen einer unerwarteten Chessable-Antwort, legt chessable-activity.js den Hinweis in
// rcCrawlAlert ab. Das Popup zeigt ihn, bis er ausgeblendet wird, und fragt vor dem nächsten Holen nach.
const CI_ALERT = document.getElementById('ci-alert');
const DISCORD_URL = 'https://discord.gg/wczc4BJtMf';
let ciAlert = null;

function paintCiAlert() {
  if (!CI_ALERT) return;
  if (!ciAlert) { CI_ALERT.style.display = 'none'; CI_ALERT.replaceChildren(); return; }
  const teile = [];
  const titel = document.createElement('b');
  titel.textContent = t('import.unexpected.title');
  teile.push(titel);
  const absatz = (text, cls) => {
    const d = document.createElement('div');
    d.textContent = text;
    if (cls) d.className = cls;
    teile.push(d);
  };
  absatz(t('import.unexpected.body'));
  if (ciAlert.banned) {
    absatz((ciAlert.message ? t('import.unexpected.bannedMessage', { message: ciAlert.message }) : t('import.unexpected.bannedPage'))
      + (ciAlert.adminNotified ? ' ' + t('import.unexpected.adminsNotified') : ''));
  }
  if (ciAlert.saved) absatz(t('import.unexpected.saved', { count: ciAlert.saved }));
  let wann = '';
  try { wann = ciAlert.at ? new Date(ciAlert.at).toLocaleString(rcLang) : ''; } catch (e) { /* ohne Zeit */ }
  absatz([ciAlert.courseName || ciAlert.bid, ciAlert.detail, wann].filter(Boolean).join(' · '), 'ci-alert-detail');
  const zeile = document.createElement('div');
  zeile.className = 'ci-alert-row';
  const ausblenden = document.createElement('button');
  ausblenden.type = 'button';
  ausblenden.textContent = t('import.unexpected.dismiss');
  ausblenden.addEventListener('click', () => { try { chrome.storage.local.remove('rcCrawlAlert'); } catch (e) { /* egal */ } });
  const discord = document.createElement('a');
  discord.href = DISCORD_URL; discord.target = '_blank'; discord.rel = 'noopener';
  discord.textContent = t('import.unexpected.discord');
  zeile.append(ausblenden, discord);
  teile.push(zeile);
  CI_ALERT.replaceChildren(...teile);
  CI_ALERT.style.display = 'block';
}

try {
  chrome.storage.local.get('rcCrawlAlert', (r) => { ciAlert = (r && r.rcCrawlAlert) || null; paintCiAlert(); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.rcCrawlAlert) { ciAlert = ch.rcCrawlAlert.newValue || null; paintCiAlert(); }
  });
} catch (e) { /* ohne storage kein Hinweis */ }

function ciSend(action, extra) {
  return new Promise((resolve) => {
    if (ciTabId == null) { resolve(null); return; }
    chrome.tabs.sendMessage(ciTabId, Object.assign({ type: 'rc-import', action }, extra || {}), (resp) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(resp || null);
    });
  });
}

function ciRender(st) {
  lastCiState = st;
  if (!st) {
    CI_COURSE.textContent = t('import.notReady');
    CI_CRAWL.disabled = true;
    return;
  }
  CI_COURSE.textContent = st.onCourse
    ? (st.courseName ? t('import.course', { name: st.courseName }) : t('import.courseId', { id: st.bid }))
    : t('import.openCourse');
  ciCrawling = !!st.crawling;
  if (ciCrawling) {
    // „Kurs holen"-Button wird während des Laufs zum Abbrechen-Knopf.
    CI_CRAWL.textContent = t('import.cancel');
    CI_CRAWL.classList.add('ci-cancel');
    CI_CRAWL.disabled = false;
  } else {
    CI_CRAWL.textContent = t('import.crawl');
    CI_CRAWL.classList.remove('ci-cancel');
    CI_CRAWL.disabled = !st.onCourse;
  }
  // Ziel-Radios einmalig aus dem Zustand vorbelegen, danach nicht gegen den User kämpfen.
  if (!ciTargetInit && (st.target === 'book' || st.target === 'repertoire')) {
    const r = document.querySelector(`input[name="ci-target"][value="${st.target}"]`);
    if (r) r.checked = true;
    ciTargetInit = true;
  }
  if (st.captured > 0) {
    CI_IMPORTCAP.style.display = 'block';
    CI_IMPORTCAP.textContent = t('import.captured', { count: st.captured });
  } else {
    CI_IMPORTCAP.style.display = 'none';
  }
  if (st.progress) {
    const p = st.progress;
    const b = document.createElement('b');
    b.textContent = t('import.onRookhub', { done: p.done, total: p.total, pct: p.pct });
    CI_PROGRESS.replaceChildren(b);
  } else {
    CI_PROGRESS.textContent = '';
  }
  ciStatusBase = st.status || '';
  ciStartedAt = (st.crawling && st.crawlStartedAt) ? st.crawlStartedAt : null;
  paintCiStatus();
  if (ciStartedAt && !ciTimerInt) ciTimerInt = setInterval(paintCiStatus, 1000);
  if (!ciStartedAt && ciTimerInt) { clearInterval(ciTimerInt); ciTimerInt = null; }
}

async function ciTick() { ciRender(await ciSend('state')); }

async function initChessableImport() {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !/^https:\/\/(www\.)?chessable\.com\//.test(tab.url)) return;
  ciTabId = tab.id;
  CI_BOX.style.display = 'block';

  // Falls das Content-Script (noch) nicht antwortet (Tab vor dem Extension-Update geladen),
  // einmal nachinjizieren (Guard in chessable-activity.js verhindert Doppel-Init).
  let st = await ciSend('state');
  if (!st) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/chessable-crawl.js', 'lib/chessable-course-names.js', 'chessable-activity.js'] });
    } catch (e) { /* ignore */ }
    st = await ciSend('state');
  }
  ciRender(st);

  CI_CRAWL.addEventListener('click', async () => {
    // Läuft ein Crawl, ist derselbe Button der Abbrechen-Knopf.
    if (ciCrawling) {
      await ciSend('cancel');
      ciTick();
      return;
    }
    // Der letzte Lauf wurde wegen einer unerwarteten Chessable-Antwort gestoppt → erst fragen, ob der Entwickler Bescheid weiß.
    if (ciAlert && !window.confirm(t('import.unexpected.rerunConfirm', { detail: ciAlert.detail || '' }))) return;
    // Bannrisiko: der aktive Crawl klappert die Chessable-API automatisiert ab → explizite Bestätigung.
    const ok = window.confirm(
      t('import.warn.title') + '\n\n' +
      t('import.warn.body') + '\n\n' +
      t('import.warn.own') + '\n\n' +
      t('import.warn.confirm')
    );
    if (!ok) return;
    if (ciAlert) { try { chrome.storage.local.remove('rcCrawlAlert'); } catch (e) { /* egal */ } }
    CI_STATUS.textContent = t('import.starting');
    await ciSend('crawl', { target: ciSelectedTarget() });
    ciTick();
  });
  CI_IMPORTCAP.addEventListener('click', async () => {
    CI_STATUS.textContent = t('import.importing');
    await ciSend('importCaptured', { target: ciSelectedTarget() });
    ciTick();
  });
  document.querySelectorAll('input[name="ci-target"]').forEach((r) =>
    r.addEventListener('change', () => ciSend('setTarget', { target: ciSelectedTarget() })));

  ciPoll = setInterval(ciTick, 1500);
  window.addEventListener('unload', () => { if (ciPoll) clearInterval(ciPoll); if (ciTimerInt) clearInterval(ciTimerInt); });
}

initChessableImport();

// Triggert die angegebene Aktion im Content-Script. Laedt chess.min.js +
// content.js nur dann, wenn der Tab sie noch nicht hat (Idempotency-Guard
// in content.js).
async function triggerInTab(action) {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !/^https:\/\/(www\.chess\.com|lichess\.org)\//.test(tab.url)) {
    showError(t('popup.needTab'));
    return;
  }
  try {
    // 1) Pruefen, ob content.js schon geladen ist.
    const [precheck] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!window.__rdc_loaded,
    });
    if (!precheck || !precheck.result) {
      // 2) Lazy-Inject chess.min.js + Shared-Core (RepCheckLib) + content.js (einmalig pro Tab).
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['chess.min.js', 'lib/repertoire-text.js', 'lib/i18n.js', 'content.js'],
      });
    }
    // 3) Aktion ausloesen.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [action],
      func: (act) => {
        const api = window.__rdc_loaded;
        if (!api || typeof api[act] !== 'function') {
          console.warn('[RepertoireChecker] Kein Eintrag fuer Aktion:', act);
          return;
        }
        api[act]();
      },
    });
    window.close();
  } catch (e) {
    showError(t('popup.error', { error: (e && e.message ? e.message : String(e)) }));
  }
}
