// Laeuft als Content-Script (ISOLIERTE Welt) auf chessable.com und misst die
// AKTIVE Trainingszeit, um sie an RookHub zu melden (Kategorie „Chessable" im
// Trainingsziele-Tracker). Isolierte Welt ist noetig, weil hier chrome.storage
// (RookHub-Config) + chrome.runtime (Egress ueber den Background-Worker) gebraucht
// werden — anders als chessable-fen.js, das fuer den React-Fiber MAIN-World braucht.
//
// „Aktiv" = ALLE Bedingungen: ein Brett ist da (cm-chessboard [data-square]) UND
// der Tab ist sichtbar+fokussiert UND in den letzten IDLE_MS gab es ein hartes
// Aktivitaetssignal (Brett-Mutation = Zug, Klick/Taste aufs Brett, oder eine
// gewertete Zug-Notification). Reines Offenlassen zaehlt NICHT.
//
// RookHub-Config (URL+Token) kommt aus chrome.storage.local (Key `rookhubConfig`),
// gespiegelt von content.js auf chess.com/lichess (IndexedDB ist origin-scoped).
// Ohne Config wird nichts gemessen/gesendet.
(function () {
  'use strict';

  if (window.__repcheckChessableActivity) return;
  window.__repcheckChessableActivity = true;

  // ---- Sprache (geteilte Tabelle lib/i18n.js, per Manifest VOR dieser Datei geladen) ----
  // Die Statustexte des Kurs-Imports entstehen HIER und gehen als fertiger Text ans Popup
  // (Nachrichtenformat unverändert) — also wird auch hier übersetzt. Fehlt die Tabelle
  // (alte Installation / Manifest noch ohne lib/i18n.js), liefert t() den Schlüssel zurück,
  // statt zu werfen: sichtbar kaputt, aber der Import läuft weiter.
  let rcLang = 'en';
  function t(key, params) {
    const i18n = self.RepCheckI18n;
    if (!i18n || typeof i18n.translate !== 'function') return key;
    return i18n.translate(rcLang, key, params);
  }
  function applyLang(gespeichert) {
    const i18n = self.RepCheckI18n;
    rcLang = (i18n && typeof i18n.resolveLang === 'function')
      ? i18n.resolveLang(gespeichert, navigator.languages)
      : 'en';
  }
  try {
    chrome.storage.local.get(['rcLang'], (r) => applyLang(r && r.rcLang));
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.rcLang) applyLang(ch.rcLang.newValue);
      // Kein Neu-Rendern nötig: diese Datei hält keine eigene UI; der zuletzt gesetzte
      // Statustext bleibt in seiner Sprache, der nächste kommt in der neuen.
    });
  } catch (e) { /* ohne chrome.storage bleibt es bei 'en' */ }

  // ---- Config + Egress ----
  function readConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('rookhubConfig', (r) => resolve((r && r.rookhubConfig) || null));
      } catch (e) { resolve(null); }
    });
  }

  // Gemeinsamer RookHub-Client (lib/rookhub-client.js, per Manifest VOR dieser Datei geladen): Kopfzeilen und
  // Fehlerabbildung an EINER Stelle — ein widerrufener Token heißt „Token ungültig", nicht „HTTP 401".
  // Bisher laufen die Import-Pfade (ingest, ingest/chunk, ingest/live) darüber.
  // `chrome` ausdrücklich mitgeben: in Firefox-Content-Scripts ist `self` das Fenster der SEITE, `self.chrome` gibt es
  // dort nicht — der Client fand dann keine Extension-API und hielt das für „Erweiterung neu geladen" (07.10.2026:
  // jeder Buch-Teil scheiterte, während die direkten chrome.runtime-Aufrufe derselben Datei durchgingen).
  const Rookhub = self.RepCheckRookhub ? self.RepCheckRookhub.create({ t, chrome: typeof chrome !== 'undefined' ? chrome : undefined }) : null;
  function rookhubRequest(path, body) {
    if (!Rookhub) return Promise.reject(new Error(t('err.libMissing')));
    return Rookhub.request(path, { method: 'POST', body });
  }

  // ---- Teil-Dateien verdrahten (chessable-activity/*.js, per Manifest VOR dieser Datei geladen) ----
  // Seit der Zerlegung Z36 liegen Trainingszeit, Kurs-Kontext, Mitschnitt, Karten, Chessable-Abrufe, Abbruch-Meldungen, Kurs holen,
  // Import-Wege/Popup-Bruecke und Fortschritt in eigenen Dateien; hier bleiben Sprache, Config, RookHub-Client, die
  // Bruecken zur MAIN-World und die Reihenfolge, in der alles anlaeuft. Die Teile legen beim Laden nur Funktionen ab;
  // was sie voneinander brauchen, bekommen sie per init(), bevor irgendetwas anlaeuft.
  //
  // S: geteilter Zustand. Ein Feld haengt der Teil an, dem der Wert gehoert (Getter, ggf. Setter, in seinem init);
  // andere lesen/schreiben nur ueber S, nie ueber eine Kopie: lastGameOid/lastGameOidAt (Tracker), courseKind
  // (Kurs-Kontext), crawling/crawlStartedAt/cancelRequested (Kurs holen), progressBid/progressStruct/importedOids
  // (Fortschritt).
  const S = {};
  const A = self.RepCheckActivity;
  const T = A.tracker, CX = A.context, CA = A.capture, BN = A.banners, FE = A.fetch, RP = A.report, CI = A.crawl,
    BR = A.bridge, PR = A.progress;
  const { TICK_MS, dailyZusammenfassung } = T;
  const { ensureCourseNames, lookupCourseKind } = CX;
  const { startDomObserver, ensureProgress, annotateHome } = PR;
  const { cap } = CA;
  T.init({
    S, readConfig, currentCourseId: CX.currentCourseId, bestCourseName: CX.bestCourseName, lookupCourseKind,
    flushProblemMoves: CA.flushProblemMoves, flushReviewLines: CA.flushReviewLines, flushSessionMoves: CA.flushSessionMoves,
  });
  CX.init({ S, readConfig, cap });
  CA.init({
    S, readConfig, decodeUid: CX.decodeUid, readChessableToken: CX.readChessableToken,
    currentCourseId: CX.currentCourseId, showReviewConsentPrompt: BN.showReviewConsentPrompt,
    scheduleAutoImport: BR.scheduleAutoImport, autoImport: BR.autoImport, now: T.now,
  });
  BN.init({
    t, readConfig, bestCourseName: CX.bestCourseName, setReviewConsent: CA.setReviewConsent,
    reviewPending: CA.reviewPending, flushReviewLines: CA.flushReviewLines,
  });
  FE.init({
    t, setStatus: BR.setStatus, readChessableToken: CX.readChessableToken, decodeUid: CX.decodeUid,
    clearStoredChessableToken: CX.clearStoredChessableToken,
  });
  RP.init({
    t, readConfig, bestCourseName: CX.bestCourseName, setStatus: BR.setStatus, showCrawlAlert: BN.showCrawlAlert,
    CRAWL_ALERT_ID: BN.CRAWL_ALERT_ID,
  });
  CI.init({
    S, t, readConfig, cap, pageCourseId: CX.pageCourseId, bestCourseName: CX.bestCourseName, setStatus: BR.setStatus,
    fetchImportedOids: PR.fetchImportedOids, ensureProgress, listCacheGet: FE.listCacheGet,
    listCachePut: FE.listCachePut, chessableGetChecked: FE.chessableGetChecked, harvestFromList: CA.harvestFromList,
    harvestFromGame: CA.harvestFromGame, sleep: FE.sleep, crawlPauseMs: FE.crawlPauseMs, ingestChunk: BR.ingestChunk,
    ingestLiveInParts: BR.ingestLiveInParts, markCourseFetched: BR.markCourseFetched, showNotOwned: BN.showNotOwned,
    handleUnexpected: RP.handleUnexpected, reportCrawlError: RP.reportCrawlError,
  });
  BR.init({
    S, t, rookhubRequest, cap, currentCourseId: CX.currentCourseId, pageCourseId: CX.pageCourseId,
    bestCourseName: CX.bestCourseName, capturedChapters: CA.capturedChapters, capturedLineCount: CA.capturedLineCount,
    markImported: PR.markImported, ensureProgress, crawlAndImport: CI.crawlAndImport,
  });
  PR.init({
    S, t, readConfig, now: T.now, cap, currentCourseId: CX.currentCourseId, chessableGet: FE.chessableGet, sleep: FE.sleep,
    crawlPauseMs: FE.crawlPauseMs, applySuggestedTarget: BR.applySuggestedTarget,
  });

  // ---- Anlaufen, in der Reihenfolge von vor der Zerlegung ----
  T.installSignale();         // Zeiger/Taste aufs Brett, Klick/Taste auf „Next variation"
  CX.installKursIdBruecke();  // course-id von chessable-fen.js (MAIN-World)

  // ---- Takt ----
  ensureCourseNames(false); // Kursname-Karte vorwärmen (persistierter Cache + ggf. Refresh)
  lookupCourseKind();
  T.startTakt();             // Messtakt, hidden, pagehide

  CX.installRememberLine();  // remember-line von chessable-fen.js → RookHub

  // ---- RookHub-URL-Bridge (hier isoliert → MAIN-World chessable-fen.js) ----
  // Die RookHub-URL liegt in chrome.storage.local (nur isoliert lesbar). chessable-fen.js
  // (Page-Kontext) braucht sie, um den „Analyse"-Button synchron im Klick-Handler in einen
  // neuen Tab öffnen zu können (Popup-Blocker-sicher). Nur die URL wird gespiegelt — der
  // Token bleibt in der isolierten Welt.
  async function broadcastRookhubUrl() {
    const cfg = await readConfig();
    const url = cfg && cfg.url ? String(cfg.url).replace(/\/$/, '') : null;
    if (url) window.postMessage({ __repcheck: 'rookhub-url', url }, location.origin);
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__repcheck !== 'request-rookhub-url') return;
    broadcastRookhubUrl();
  });
  broadcastRookhubUrl();   // proaktiv, falls fen.js seine Anfrage vor unserem Listener stellte

  // ---- Chessable-Buttons-Einstellung-Bridge (isoliert → MAIN chessable-fen.js) ----
  // Welche FEN-Tool-Buttons erscheinen, ist im Popup pro Button umschaltbar (chrome.storage.local
  // `chessableButtons`). Nur die isolierte Welt liest chrome.storage → wir spiegeln die Einstellung
  // an chessable-fen.js (MAIN) und aktualisieren sie live, wenn das Popup sie ändert. Bewusst OHNE Vorgaben:
  // seit v1.59.0 ist alles aus, was dort nicht ausdrücklich eingeschaltet ist (fen.js zeigt nur `true`).
  function broadcastChessableButtons() {
    try {
      chrome.storage.local.get('chessableButtons', (r) => {
        const s = Object.assign({}, (r && r.chessableButtons) || {});
        window.postMessage({ __repcheck: 'chessable-buttons', settings: s }, location.origin);
      });
    } catch (e) {}
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data) return;
    // Tagesstatistik für die Hochrechnung hinter dem ⏳-Zähler (MAIN-World hat kein chrome.*).
    if (e.data.__repcheck === 'request-daily') {
      dailyZusammenfassung().then((d) => {
        window.postMessage({ __repcheck: 'daily', daily: d }, location.origin);
      });
      return;
    }
    if (e.data.__repcheck !== 'request-chessable-buttons') return;
    broadcastChessableButtons();
  });
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.chessableButtons) broadcastChessableButtons();
    });
  } catch (e) {}
  broadcastChessableButtons();   // proaktiv

  FE.installCrawlDelay();         // Kurs-holen-Pause aus dem Speicher
  BN.installVerbindenKarte();     // Karte ohne RookHub-Verbindung
  BN.installButtonsHinweis();     // Update-Hinweis zu den Buttons
  CA.installMitschnitt();         // Mitschnitt der Kurs-API aus chessable-capture.js
  BR.installPopupBruecke();       // rc-import vom Popup

  // Fortschritt: Marker und Zaehler im Takt nachziehen.
  setInterval(() => { startDomObserver(); ensureProgress(false); annotateHome(); }, TICK_MS);
  startDomObserver(); ensureProgress(false); annotateHome();

  console.log('[RepCheck Chessable] Activity-Tracking aktiv');
})();
