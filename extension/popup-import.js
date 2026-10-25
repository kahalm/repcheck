// Popup: RookHub-Import (Browser) auf chessable.com (Zerlegung Z39, bis v1.73.1 in popup.js) — Ziel, „⚡ Kurs holen"
// samt Bannrisiko-Box und Rueckfrage nach einem Stopp (rcCrawlAlert), „Mitschnitt importieren", Fortschritt. Steuert
// chessable-activity.js per chrome.tabs.sendMessage {type:'rc-import', action} und pollt `state`.
// Klassisches Skript im globalen Scope des Popups (popup.html laedt es nach popup.js); beim Laden nur Zugriff auf
// Frueheres, die Neubeschriftung beim Sprachwechsel haengt es in repaintHooks (popup.js) ein.

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
let ciTabId = null, ciPoll = null, ciTargetTouched = false;
// Mitlaufender Timer im Status („… · 1:23"): Basistext + Crawl-Startzeit getrennt halten,
// damit ein 1-s-Ticker die verstrichene Zeit unabhängig vom 1,5-s-State-Poll aktualisiert.
let ciStatusBase = '', ciStartedAt = null, ciTimerInt = null;
let ciCrawling = false;
// Letzter vom Content-Script gemeldeter Zustand — für das Neuzeichnen nach Sprachwechsel.
let lastCiState = null;
// ciRender(null) hieße „Content-Script nicht bereit" — nur neu zeichnen, wenn das
// Import-Panel überhaupt an einem Chessable-Tab hängt.
repaintHooks.push(() => { if (ciTabId != null) ciRender(lastCiState); });

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

// Bis v1.64.x landete auch „Kurs nicht im Konto" (BOOK_NOT_OWNED) hier — solche Altlasten räumt das Popup still weg.
function takeCiAlert(h) {
  if (h && CrawlLib && CrawlLib.isNotOwnedAlert(h)) {
    try { chrome.storage.local.remove('rcCrawlAlert'); } catch (e) { /* egal */ }
    return null;
  }
  return h || null;
}

// Bannrisiko-Hinweis „nie wieder zeigen" (v1.71.0, gewünscht 07.10.2026): einmal mit Haken bestätigt, startet
// „Kurs holen" danach direkt. Gilt NUR für den allgemeinen Hinweis — nach einer unerwarteten Chessable-Antwort
// (rcCrawlAlert) kommt die Rückfrage trotzdem, das ist ein Einzelfall und genau die Warnung, die zählen soll.
let banRiskAck = false;
// Der Weg zurück: in den Einstellungen („Kurs holen") lässt sich der Hinweis wieder einschalten.
const BAN_RISK_SHOW = document.getElementById('ban-risk-show');
function paintBanRiskShow() { if (BAN_RISK_SHOW) BAN_RISK_SHOW.checked = !banRiskAck; }
try { chrome.storage.local.get('rcBanRiskAck', (r) => { banRiskAck = !!(r && r.rcBanRiskAck); paintBanRiskShow(); }); } catch (e) { /* dann eben fragen */ }
if (BAN_RISK_SHOW) {
  paintBanRiskShow();
  BAN_RISK_SHOW.addEventListener('change', () => {
    banRiskAck = !BAN_RISK_SHOW.checked;
    try {
      if (banRiskAck) chrome.storage.local.set({ rcBanRiskAck: true });
      else chrome.storage.local.remove('rcBanRiskAck');
    } catch (e) { /* gilt dann nur für dieses Popup */ }
  });
}

try {
  chrome.storage.local.get('rcCrawlAlert', (r) => { ciAlert = takeCiAlert(r && r.rcCrawlAlert); paintCiAlert(); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.rcCrawlAlert) { ciAlert = takeCiAlert(ch.rcCrawlAlert.newValue); paintCiAlert(); }
  });
} catch (e) { /* ohne storage kein Hinweis */ }

// ---- Bannrisiko-Bestätigung vor „Kurs holen" ----
// Kein natives Bestätigungsfenster: Firefox zeigt sowas in Extension-Popups nicht an (der Aufruf
// kehrt sofort zurueck, ohne etwas anzuzeigen) — der Button wirkte dadurch tot. Stattdessen eine
// inline Box im Popup, die denselben Text zeigt (plus die Rueckfrage nach einem vorherigen Stopp).
const CI_WARN = document.getElementById('ci-warn');

function hideCiWarn() {
  if (!CI_WARN) return;
  CI_WARN.style.display = 'none';
  CI_WARN.replaceChildren();
}

function showCiWarn() {
  if (!CI_WARN) return;
  const teile = [];
  if (ciAlert) {
    const hinweis = document.createElement('div');
    hinweis.textContent = t('import.unexpected.rerunConfirm', { detail: ciAlert.detail || '' });
    teile.push(hinweis);
  }
  const titel = document.createElement('b');
  titel.textContent = t('import.warn.title');
  teile.push(titel);
  const absatz = (text) => { const d = document.createElement('div'); d.textContent = text; teile.push(d); };
  // Welcher Kurs geholt wird, steht in der Box selbst — bestätigt wird genau dieser (S1-012).
  const st = lastCiState;
  if (st && st.onCourse && st.bid) {
    absatz(st.courseName ? t('import.warn.course', { name: st.courseName }) : t('import.warn.courseId', { id: st.bid }));
  }
  absatz(t('import.warn.body'));
  absatz(t('import.warn.own'));
  absatz(t('import.warn.confirm'));
  // „Nie wieder zeigen" — nur ohne offene Rückfrage nach einer unerwarteten Antwort (die soll jedes Mal kommen).
  ciNeverBox = null;
  if (!ciAlert) {
    const label = document.createElement('label');
    label.className = 'ci-never';
    ciNeverBox = document.createElement('input');
    ciNeverBox.type = 'checkbox';
    ciNeverBox.id = 'ci-warn-never';
    const text = document.createElement('span');
    text.textContent = ' ' + t('import.warn.dontShowAgain');
    label.append(ciNeverBox, text);
    teile.push(label);
  }
  const zeile = document.createElement('div');
  zeile.className = 'ci-alert-row';
  const weiter = document.createElement('button');
  weiter.type = 'button';
  weiter.textContent = t('import.warn.yes');
  weiter.addEventListener('click', startCiCrawl);
  const abbrechen = document.createElement('button');
  abbrechen.type = 'button';
  abbrechen.textContent = t('import.cancel');
  abbrechen.addEventListener('click', hideCiWarn);
  zeile.append(weiter, abbrechen);
  teile.push(zeile);
  CI_WARN.replaceChildren(...teile);
  CI_WARN.style.display = 'block';
}

// Haken „nicht mehr anzeigen" in der gerade offenen Bannrisiko-Box (null, wenn keine offen ist oder eine Rückfrage ansteht).
let ciNeverBox = null;

async function startCiCrawl() {
  if (ciNeverBox && ciNeverBox.checked) {
    banRiskAck = true;
    paintBanRiskShow();
    try { chrome.storage.local.set({ rcBanRiskAck: true }); } catch (e) { /* gilt dann nur für dieses Popup */ }
  }
  ciNeverBox = null;
  hideCiWarn();
  if (ciAlert) { try { chrome.storage.local.remove('rcCrawlAlert'); } catch (e) { /* egal */ } }
  CI_STATUS.textContent = t('import.starting');
  await ciSend('crawl', { target: ciSelectedTarget() });
  ciTick();
}

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
    hideCiWarn();
  } else {
    CI_CRAWL.textContent = t('import.crawl');
    CI_CRAWL.classList.remove('ci-cancel');
    CI_CRAWL.disabled = !st.onCourse;
  }
  // Ziel-Radios einmalig aus dem Zustand vorbelegen, danach nicht gegen den User kämpfen.
  // Ziel-Radios folgen dem Zustand (dort steht auch die aus Chessables Kursart erkannte Wahl, die erst nach
  // dem getCourse eintrifft), bis der Nutzer selbst umschaltet — danach nicht mehr gegen ihn kämpfen.
  if (!ciTargetTouched && (st.target === 'book' || st.target === 'repertoire')) {
    const r = document.querySelector(`input[name="ci-target"][value="${st.target}"]`);
    if (r) r.checked = true;
  }
  const hint = document.getElementById('ci-target-hint');
  if (hint) {
    const kindKey = 'import.courseType.' + st.courseType;
    const targetKey = 'import.target.' + st.suggestedTarget;
    hint.textContent = st.suggestedTarget
      ? t('import.targetDetected', { kind: t(kindKey), target: t(targetKey) })
      : '';
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
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: manifestScripts('chessable-activity.js') });
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
    // Bannrisiko (+ ggf. Rückfrage nach vorherigem Stopp) — Bestätigung inline, siehe showCiWarn(). Hat der Nutzer
    // den Hinweis mit „nie wieder zeigen" bestätigt, geht es direkt los — außer es steht eine Rückfrage an.
    if (banRiskAck && !ciAlert) { startCiCrawl(); return; }
    showCiWarn();
  });
  CI_IMPORTCAP.addEventListener('click', async () => {
    CI_STATUS.textContent = t('import.importing');
    await ciSend('importCaptured', { target: ciSelectedTarget() });
    ciTick();
  });
  document.querySelectorAll('input[name="ci-target"]').forEach((r) =>
    r.addEventListener('change', () => { ciTargetTouched = true; ciSend('setTarget', { target: ciSelectedTarget() }); }));

  ciPoll = setInterval(ciTick, 1500);
  window.addEventListener('unload', () => { if (ciPoll) clearInterval(ciPoll); if (ciTimerInt) clearInterval(ciTimerInt); });
}

initChessableImport();
