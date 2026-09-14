'use strict';

// Willkommensseite (v1.59.0). Öffnet sich einmal nach der Installation (background.js, runtime.onInstalled)
// und ist über Popup → „Einstellungen" → „Einführung öffnen" jederzeit wieder erreichbar.
//
// Die Seite erklärt nicht nur, sie lässt gleich handeln — mit denselben Bausteinen wie das Popup: Verbinden
// startet die Ein-Klick-Verbindung im Worker (`rookhub-pair`, Ablauf in background.js), und die
// Chessable-Buttons landen im selben Speicher (`chessableButtons`). Der Zustand kommt aus
// chrome.storage.local und wird live nachgeführt: wer sich im RookHub-Tab anmeldet, sieht Schritt 1 hier
// ohne Neuladen als erledigt.

const I18N = self.RepCheckI18n;
let rcLang = I18N.resolveLang(null, navigator.languages);
let rcLangStored = '';
function t(key, params) { return I18N.translate(rcLang, key, params); }

const LANG_NAMES = { en: 'English', de: 'Deutsch', hr: 'Hrvatski' };
const LANG_SELECT = document.getElementById('lang-select');

// ─── Schritt 1: mit RookHub verbinden ───────────────────────────────────
const ROOKHUB_DEFAULT_URL = 'https://rookhub.oberschmid.homes';
const PAIR_LIVE = ['waiting', 'waitingLogin', 'creating'];
const CONN_URL = document.getElementById('conn-url');
const CONN_PAIR = document.getElementById('conn-pair');
const CONN_STATE = document.getElementById('conn-state');
const STEP_CONNECT = document.getElementById('connect');

let connPaint = null;   // { key, params, ok } — für den Sprachwechsel gemerkt
function setConn(key, params, ok) {
  connPaint = { key, params: params || null, ok: !!ok };
  paintConn();
}
function paintConn() {
  if (!connPaint) return;
  CONN_STATE.textContent = t(connPaint.key, connPaint.params);
  CONN_STATE.classList.toggle('ok', connPaint.ok);
}

function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return String(url || ''); }
}

function readConfig() {
  return new Promise((resolve) => {
    try { chrome.storage.local.get('rookhubConfig', (r) => resolve((r && r.rookhubConfig) || null)); }
    catch (e) { resolve(null); }
  });
}

function showConfig(cfg) {
  if (!CONN_URL.value) CONN_URL.value = (cfg && cfg.url) || ROOKHUB_DEFAULT_URL;
  const connected = !!(cfg && cfg.token);
  STEP_CONNECT.classList.toggle('done', connected);
  if (connected) setConn('welcome.connect.connectedTo', { host: hostOf(cfg.url) }, true);
  else if (!CONN_PAIR.disabled) setConn('popup.conn.notConnected');   // während des Verbindens nicht übermalen
}

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
function stopPairPoll() {
  if (pairPoll) { clearInterval(pairPoll); pairPoll = null; }
  CONN_PAIR.disabled = false;
}
function startPairPoll() {
  if (pairPoll) clearInterval(pairPoll);
  CONN_PAIR.disabled = true;
  pairPoll = setInterval(async () => {
    renderPair(await sendBg({ type: 'rookhub-pair-state', poll: true }));
  }, 900);
}

// Dieselben Zustände und Texte wie im Popup (popup.js renderPairState).
function renderPair(st) {
  if (!st) { stopPairPoll(); setConn('popup.conn.failed', { error: t('err.noBackground') }); return; }
  switch (st.state) {
    case 'waiting': setConn('popup.conn.pairing'); break;
    case 'waitingLogin': setConn('popup.conn.login'); break;
    case 'creating': setConn('popup.conn.creating'); break;
    case 'done': stopPairPoll(); readConfig().then(showConfig); break;
    case 'timeout': stopPairPoll(); setConn('popup.conn.timeout'); break;
    case 'cancelled': stopPairPoll(); setConn('popup.conn.cancelled'); break;
    case 'error':
      stopPairPoll();
      if (st.error === 'auth') setConn('popup.conn.errAuth');
      else if (st.error === 'notRookhub') setConn('popup.conn.errNotRookhub');
      else if (st.error === 'invalid url') setConn('popup.conn.needUrl');
      else setConn('popup.conn.failed', { error: st.error || '?' });
      break;
    default: stopPairPoll(); break;
  }
}

CONN_PAIR.addEventListener('click', async () => {
  const raw = CONN_URL.value.trim();
  if (!raw) { setConn('popup.conn.needUrl'); return; }
  CONN_PAIR.disabled = true;
  setConn('popup.conn.pairing');
  const st = await sendBg({ type: 'rookhub-pair', url: raw });   // der Worker normalisiert die Adresse
  renderPair(st);
  if (st && PAIR_LIVE.indexOf(st.state) >= 0) startPairPoll();
});

// ─── Schritt 3: Chessable-Buttons ───────────────────────────────────────
// Gleiche Schlüssel und gleiche Regel wie im Popup (popup.js CB_KEYS): nur ein gespeichertes `true` zeigt
// ein Element. test/onboarding.test.js hält beide Listen gleich.
const CB_KEYS = ['copyFen', 'analyse', 'searchFen', 'refresh', 'remember', 'fullscreen', 'pool', 'feedback'];
const STEP_BUTTONS = document.getElementById('buttons');
const BUTTONS_STATE = document.getElementById('buttons-state');
let buttonsSaved = false;

function paintButtonsState() {
  BUTTONS_STATE.textContent = buttonsSaved ? t('welcome.saved') : '';
  BUTTONS_STATE.classList.toggle('ok', buttonsSaved);
}

function showButtons(stored) {
  const s = stored || {};
  for (const k of CB_KEYS) {
    const el = document.getElementById('cb-' + k);
    if (el) el.checked = s[k] === true;
  }
  STEP_BUTTONS.classList.toggle('done', !!stored);
}

function saveButtons() {
  const s = {};
  for (const k of CB_KEYS) {
    const el = document.getElementById('cb-' + k);
    s[k] = el ? el.checked : false;
  }
  // Eine gespeicherte Auswahl erledigt auch den Update-Hinweis „Buttons jetzt aus".
  try { chrome.storage.local.set({ chessableButtons: s, rcButtonsNotice: 'done' }); } catch (e) {}
  buttonsSaved = true;
  paintButtonsState();
  STEP_BUTTONS.classList.add('done');
}
for (const k of CB_KEYS) {
  const el = document.getElementById('cb-' + k);
  if (el) el.addEventListener('change', saveButtons);
}

// ─── Sprache ────────────────────────────────────────────────────────────
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
  document.documentElement.lang = rcLang;
  const auto = I18N.resolveLang(null, navigator.languages);
  const autoOpt = LANG_SELECT.querySelector('option[value=""]');
  if (autoOpt) autoOpt.textContent = t('lang.auto', { lang: LANG_NAMES[auto] || auto });
  LANG_SELECT.value = rcLangStored;
  paintConn();
  paintButtonsState();
}

function setLang(stored) {
  rcLangStored = stored || '';
  rcLang = I18N.resolveLang(rcLangStored, navigator.languages);
  applyI18n();
}

LANG_SELECT.addEventListener('change', () => {
  const v = LANG_SELECT.value;
  try {
    if (v) chrome.storage.local.set({ rcLang: v });
    else chrome.storage.local.remove('rcLang');
  } catch (e) {}
  setLang(v);
});

// Aus dem Hinweis auf chessable.com bzw. der Popup-Checkliste direkt zu einem Schritt springen.
function focusSection() {
  const id = location.hash.replace('#', '');
  const el = id && document.getElementById(id);
  if (!el || !el.classList.contains('step')) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}
window.addEventListener('hashchange', focusSection);

// ─── Start ──────────────────────────────────────────────────────────────
applyI18n();
chrome.storage.local.get(['rcLang', 'rookhubConfig', 'chessableButtons', 'rookhubPairing'], (r) => {
  const s = r || {};
  showButtons(s.chessableButtons);
  // Läuft schon eine Verbindung (etwa aus dem Popup gestartet), hier weiter beobachten.
  if (s.rookhubPairing && PAIR_LIVE.indexOf(s.rookhubPairing.state) >= 0) {
    startPairPoll();
    renderPair(s.rookhubPairing);
  }
  showConfig(s.rookhubConfig || null);
  setLang(s.rcLang);
  focusSection();
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.rookhubConfig) showConfig(ch.rookhubConfig.newValue || null);
  if (ch.chessableButtons) showButtons(ch.chessableButtons.newValue);
  if (ch.rcLang) setLang(ch.rcLang.newValue);
});
