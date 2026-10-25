// Popup-Logik: zeigt den Repertoire-Status und triggert das Content-Script auf
// Klick. content.js laedt das Manifest auf jeder chess.com- und lichess-Seite
// (`content_scripts`); das Popup injiziert es per chrome.scripting.executeScript
// nur nach, wenn ein Tab es noch nicht hat (etwa ein Tab, der schon vor
// Installation oder Update der Extension offen war).
// Das Popup besteht aus klassischen Skripten in EINEM globalen Scope, popup.html laedt sie in dieser Reihenfolge:
// popup.js (Sprache, Status, Chessable-Token, Tab-Helfer), popup-connection.js (RookHub-Verbindung),
// popup-settings.js (Chessable-Buttons, „Erste Schritte", Kurs-holen-Pause), popup-share.js (Sharebar),
// popup-import.js (RookHub-Import auf chessable.com). Ein Skript greift beim Laden nur auf Frueheres zu.

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
// Die späteren Popup-Skripte (Verbindung, Kurs-holen-Pause, Sharebar, Import) hängen ihre Neubeschriftung beim Laden
// in repaintHooks ein: ein Rückruf aus dieser Datei (Sprachwechsel im Speicher) kann feuern, bevor sie geladen sind,
// und darf dann nichts aufrufen, was es noch nicht gibt (test/popup-laden.test.js).
const repaintHooks = [];
function repaintAll() {
  applyI18n(document);
  paintStatus();
  renderRepertoireList(repItems);
  paintChessableState();
  for (const neu of repaintHooks) neu();
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

// Die RookHub-Config liegt in chrome.storage.local (Key `rookhubConfig`, geschrieben
// von Popup und Worker — seit v1.68.2 nie mehr aus dem Seiten-Panel). Das ist hier die
// EINZIGE Quelle: die IndexedDB `RepertoireCheckerDB` ist origin-scoped (chess.com/lichess)
// und im Popup-Origin (chrome-extension://…) leer. Bis v1.68.12 öffnete das Popup sie
// trotzdem und legte dabei nur eine leere DB im Extension-Origin an.
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
  const config = await readRookhubConfigFromStorage();

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

// Nachladen in Tabs, die schon vor Installation oder Update offen waren: genau die Dateien, die Chrome über das
// Manifest lädt (`content_scripts`, isolierte Welt), in derselben Reihenfolge — EINE Quelle statt Kopien. Bis
// v1.68.11 standen die Listen hier von Hand und fehlten lib/chesscom-moves.js (keine Züge beim Schicken) bzw.
// lib/i18n.js, lib/chessable-feedback.js und chessable-token.js (rohe Schlüssel, falsche Genauigkeit).
// Firefox liefert content_scripts[].js in getManifest() absolut ('moz-extension://<uuid>/content.js'), Chrome
// relativ; executeScript({ files }) nimmt in Firefox aber nur relative Pfade. Deshalb relativ vergleichen UND
// relativ zurückgeben (bis v1.68.14 griff der Vergleich in Firefox nie → nur content.js nachgeladen).
function manifestScripts(consumer) {
  const base = chrome.runtime.getURL('');
  const rel = (p) => (p.startsWith(base) ? p.slice(base.length) : p.replace(/^\//, ''));
  const eintrag = (chrome.runtime.getManifest().content_scripts || [])
    .find((cs) => (cs.world || 'ISOLATED') === 'ISOLATED' && (cs.js || []).map(rel).includes(consumer));
  return eintrag ? eintrag.js.map(rel) : [consumer];
}

async function ensureContentLoaded(tab) {
  const [precheck] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => !!window.__rdc_loaded,
  });
  if (!precheck || !precheck.result) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: manifestScripts('content.js'),
    });
  }
}

// Triggert die angegebene Aktion im Content-Script. Laedt content.js samt Libs
// nur dann nach, wenn der Tab es noch nicht hat (ensureContentLoaded).
async function triggerInTab(action) {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !/^https:\/\/(www\.chess\.com|lichess\.org)\//.test(tab.url)) {
    showError(t('popup.needTab'));
    return;
  }
  try {
    await ensureContentLoaded(tab);
    // Aktion ausloesen.
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
