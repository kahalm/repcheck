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

  const TICK_MS = 5000;        // Mess-Takt
  const IDLE_MS = 60000;       // ohne hartes Signal laenger als das → idle, zaehlt nicht
  const FLUSH_MS = 60000;      // Sende-Intervall
  const MIN_FLUSH_MS = 10000;  // erst ab so viel akkumulierter Zeit senden
  const MAX_FLUSH_S = 3600;    // Serverseitiger Cap je Haeppchen (hier gespiegelt)

  let activeMs = 0;
  let movesTrained = 0;
  let lastActivity = 0;
  let lastFlush = Date.now();
  let courseKind = null;      // RepertoireKind-Zahl (0-3) oder null = unbekannt
  let lookedUpCourseId = null; // verhindert Doppel-Lookups bei unveraenderter Kurs-ID

  const now = () => Date.now();
  const bump = () => { lastActivity = now(); };
  const boardPresent = () => !!document.querySelector('[data-square]');

  // ---- Aktivitaets-Signale ----
  document.addEventListener('pointerdown', () => { if (boardPresent()) bump(); }, true);
  document.addEventListener('keydown', () => { if (boardPresent()) bump(); }, true);

  // Gewertete Zuege: <span data-testid="moveNotification">; Text "XP" = abgeschlossener Zug.
  let notifObserver = null, watchedNotif = null;
  function watchMoveNotif() {
    const n = document.querySelector('[data-testid="moveNotification"]');
    if (!n || watchedNotif === n) return;
    notifObserver?.disconnect();
    watchedNotif = n;
    notifObserver = new MutationObserver(() => {
      const t = n.textContent.trim();
      if (!t) return;
      bump();
      if (t === 'XP') movesTrained++;
    });
    notifObserver.observe(n, { childList: true, characterData: true, subtree: true });
  }

  // Brett-Mutationen (Figur bewegt) = harter Aktivitaetsnachweis.
  let boardObserver = null, watchedBoard = null;
  function watchBoard() {
    const sq = document.querySelector('[data-square]');
    const board = sq ? (sq.closest('#board, [class*="chessboard"], cg-container') || sq.parentElement) : null;
    if (!board || watchedBoard === board) return;
    boardObserver?.disconnect();
    watchedBoard = board;
    boardObserver = new MutationObserver(() => bump());
    boardObserver.observe(board, { childList: true, subtree: true, attributes: true });
  }

  // ---- Config + Egress ----
  function readConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('rookhubConfig', (r) => resolve((r && r.rookhubConfig) || null));
      } catch (e) { resolve(null); }
    });
  }

  function courseIdFromUrl() {
    const m = /\/courses?\/(\d+)(?:\/|$)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  // Einmalig pro Kurs-ID: fragt RookHub-Repertoires ab und sucht den passenden Kind-Wert.
  async function lookupCourseKind() {
    const courseId = courseIdFromUrl();
    if (!courseId || courseId === lookedUpCourseId) return;
    lookedUpCourseId = courseId;
    courseKind = null;

    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) return;
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    try {
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: baseUrl + '/api/extension/repertoires',
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/json' },
        expect: 'json',
      }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok || !Array.isArray(resp.body)) return;
        const match = resp.body.find(r => r.chessableCourseId === courseId);
        if (match != null) courseKind = match.kind;
      });
    } catch (e) {}
  }

  async function flush(force) {
    if (!force && activeMs < MIN_FLUSH_MS) return;
    const secs = Math.min(MAX_FLUSH_S, Math.round(activeMs / 1000));
    if (secs <= 0) return;

    const cfg = await readConfig();
    lastFlush = now();
    if (!cfg || !cfg.url || !cfg.token) {
      // Nicht mit RookHub verbunden → akkumulierte Zeit verwerfen (kein unbegrenztes Wachsen).
      activeMs = 0; movesTrained = 0;
      return;
    }

    const moves = movesTrained;
    activeMs = 0; movesTrained = 0; // optimistisch zuruecksetzen
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    try {
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: baseUrl + '/api/extension/training-activity',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + cfg.token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ secondsActive: secs, movesTrained: moves, courseKind }),
        expect: 'json',
      }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          // Fehlgeschlagen → Zeit/Zuege zurueckbuchen, damit nichts verloren geht.
          activeMs += secs * 1000;
          movesTrained += moves;
        }
      });
    } catch (e) {
      activeMs += secs * 1000;
      movesTrained += moves;
    }
  }

  // ---- Takt ----
  lookupCourseKind();
  setInterval(() => {
    lookupCourseKind(); // neu bei SPA-Navigation in anderen Kurs
    watchMoveNotif();
    watchBoard();
    if (document.visibilityState === 'visible' && document.hasFocus()
        && boardPresent() && (now() - lastActivity) <= IDLE_MS) {
      activeMs += TICK_MS;
    }
    if (now() - lastFlush >= FLUSH_MS) flush(false);
  }, TICK_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.addEventListener('pagehide', () => flush(true));

  // ---- „Remember line"-Bridge (MAIN-World chessable-fen.js → hier → RookHub) ----
  // chessable-fen.js (Page-Kontext) postet die FEN; hier (isoliert) haengen
  // RookHub-Config + Background-Egress, damit der Token nie in den Page-Kontext geraet.
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.__repcheck !== 'remember-line') return;
    const { fen, courseId, sourceUrl } = e.data;
    const reply = (ok, error) =>
      window.postMessage({ __repcheck: 'remember-line-result', ok: !!ok, error: error || null }, location.origin);

    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) { reply(false, 'Not connected'); return; }
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    try {
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: baseUrl + '/api/extension/remember-line',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + cfg.token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ fen, courseId, sourceUrl }),
        expect: 'json',
      }, (resp) => {
        reply(!chrome.runtime.lastError && resp && resp.ok);
      });
    } catch (err) {
      reply(false, 'Send failed');
    }
  });

  console.log('[RepCheck Chessable] Activity-Tracking aktiv');
})();
