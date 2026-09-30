// Popup: Chessable-Button-Einstellungen und „Erste Schritte" (S1-019, aus popup.js ausgelagert in v1.68.13).
// Klassisches Skript im selben globalen Scope wie popup.js: popup.html lädt es DANACH, es nutzt von dort nur
// showSettings (in Klick-Handlern). popup.js selbst greift auf nichts von hier zu — so bleibt es gleich, ob ein
// Storage-Rückruf von popup.js vor oder nach dem Laden dieser Datei feuert (test/popup-laden.test.js).
// Die weiteren Bereiche (Verbindung, Kurs-holen-Pause, Import) folgen in einer eigenen Welle
// (Zerlegungs-Karte Z39: popup-connection.js, popup-import.js, popup-settings.js).

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
