// Popup: Chessable-Button-Einstellungen, „Erste Schritte" (S1-019, aus popup.js ausgelagert in v1.68.13) und die
// Kurs-holen-Pause (Zerlegung Z39). Klassisches Skript im selben globalen Scope wie popup.js: popup.html lädt es
// nach popup.js und popup-connection.js, es nutzt von dort showSettings (in Klick-Handlern), t und rcLang. popup.js
// greift auf nichts von hier zu (die Neubeschriftung der Pause hängt in repaintHooks) — so bleibt es gleich, ob ein
// Storage-Rückruf von popup.js vor oder nach dem Laden dieser Datei feuert (test/popup-laden.test.js).

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

repaintHooks.push(paintCrawlSettings);

showCrawlDelay(CrawlLib.normalizeCrawlDelay(null));
paintCrawlSettings();
if (chrome.storage && chrome.storage.local) {
  chrome.storage.local.get('crawlDelay', (r) => showCrawlDelay(CrawlLib.normalizeCrawlDelay(r && r.crawlDelay)));
}
