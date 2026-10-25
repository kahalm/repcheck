// chessable-activity.js-Teil (Zerlegung Z36): aktive Trainingszeit auf chessable.com → RookHub
// (POST /api/extension/training-activity) und die lokale Tagesstatistik hinter dem ⏳-Zaehler. „Aktiv" heisst: Brett da,
// Tab sichtbar+fokussiert, hartes Signal in den letzten IDLE_MS (Zug, Klick/Taste aufs Brett, gewertete Zug-Notification).
// Abgeschlossene Linien meldet reportTrainedLine an RookHub (line-trained).
//
// Zustand: Zaehler und Zeitstempel gehoeren hierher; lastGameOid/lastGameOidAt schreibt der Mitschnitt ueber S (Getter/
// Setter haengt init() an S), courseKind liest flush ueber S. Seiteneffekte nur in installSignale()/startTakt().
// Laden: Manifest content_scripts (chessable.com, isolierte Welt), VOR chessable-activity.js → self.RepCheckActivity.tracker
(function () {
  'use strict';

  // Wie chessable-activity.js: laeuft die isolierte Welt in diesem Tab schon (das Popup laedt die Manifest-Liste nach),
  // nichts neu anlegen.
  if (window.__repcheckChessableActivity) return;

  // Aus chessable-activity.js und den anderen Teilen (init).
  let S, readConfig, currentCourseId, bestCourseName, lookupCourseKind, flushProblemMoves, flushReviewLines;
  let flushSessionMoves;

  const TICK_MS = 5000;        // Mess-Takt
  const IDLE_MS = 60000;       // ohne hartes Signal laenger als das → idle, zaehlt nicht
  const FLUSH_MS = 60000;      // Sende-Intervall
  const MIN_FLUSH_MS = 10000;  // erst ab so viel akkumulierter Zeit senden
  const MAX_FLUSH_S = 3600;    // Serverseitiger Cap je Haeppchen (hier gespiegelt)

  let activeMs = 0;
  let movesTrained = 0;
  let linesTrained = 0;        // abgeschlossene Linien (Klick/Leertaste auf „Next variation")
  let lastGameOid = null;      // oid der zuletzt von der SPA geladenen Linie (aus dem Mitschnitt)
  let lastGameOidAt = 0;
  let lastActivity = 0;
  let lastFlush = Date.now();

  const now = () => Date.now();
  const bump = () => { lastActivity = now(); };
  const boardPresent = () => !!document.querySelector('[data-square]');

  // ---- Aktivitaets-Signale ---- (Listener: installSignale unten)
  // Abgeschlossene LINIEN zaehlen: nach dem Ende einer Variante zeigt Chessable den
  // „Next variation"-Knopf (dt. „Nächste Variante") — genau EIN Klick darauf = eine Linie.
  // TEILSTRING-Match (nicht verankert): der Knopf traegt oft Zusatztext (Tastatur-Hinweis,
  // Icon-Label) — ein exakter Match verfehlte ihn in der Praxis (linesTrained blieb 0).
  // Laengen-Deckel, damit kein grosser Container mit zufaellig enthaltenem Text zaehlt.
  // Bewusst NICHT das nackte „Next" (das blaettert im Learn-Modus jeden Zug weiter).
  const NEXT_VARIATION_RE = /next\s+variation|n(ä|ae)chste\s+variante/i;
  const isNextVariationButton = (el) => {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length > 0 && t.length <= 60 && NEXT_VARIATION_RE.test(t)) return true;
    const aria = el.getAttribute && (el.getAttribute('aria-label') || '');
    return !!aria && NEXT_VARIATION_RE.test(aria);
  };
  // Gemeinsames Dedupe-Fenster fuer Klick UND Taste: loest die Leertaste den Knopf doch als
  // echten Klick aus, zaehlt das Paar trotzdem nur EINE Linie.
  let lastLineCountAt = 0;
  function countLine() {
    if (now() - lastLineCountAt < 1500) return;
    lastLineCountAt = now();
    linesTrained++;
    if (!lineHatFehler) linesCorrect++;
    lineHatFehler = false;                 // naechste Linie faengt sauber an
    bump();
    reportTrainedLine();
  }

  // „Linie auf Chessable trainiert" → RookHub markiert sie im Kurs als gelöst und zieht den
  // Repertoire-SR nach (neu → gelernt, fällig → +1 Stufe). Best-effort + idempotent serverseitig;
  // je oid nur alle 5 min erneut gemeldet (Doppel-Klicks/Space+Klick).
  const reportedOids = new Map();   // oid → zuletzt gemeldet (ms)
  async function reportTrainedLine() {
    const bid = currentCourseId();
    if (!bid || !lastGameOid) return;
    if (now() - lastGameOidAt > 30 * 60 * 1000) return;   // veraltetes Signal (Tab lag herum)
    const oid = lastGameOid;
    const last = reportedOids.get(oid) || 0;
    if (now() - last < 5 * 60 * 1000) return;
    reportedOids.set(oid, now());
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) return;
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    try {
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: baseUrl + '/api/extension/chessable/line-trained',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + cfg.token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ bid, oid }),
        expect: 'json',
      }, () => { /* best-effort */ });
    } catch (e) { /* still */ }
  }
  // Chessable springt per LEERTASTE (globaler Shortcut, KEIN click-Event) zur naechsten Variante —
  // der Haupt-Workflow. Space/Enter zaehlen, wenn ein sichtbarer „Next variation"-Knopf existiert
  // (also der Abschluss-/Navigations-Zustand da ist) und keine Eingabe fokussiert ist.
  function nextVariationButtonVisible() {
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      if (!isNextVariationButton(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }
  // Gewertete Zuege: <span data-testid="moveNotification"> — jede neue Benachrichtigung ist EIN
  // gewerteter Zug (richtig/falsch/overstudied). Der Observer haengt am ELTERN-Knoten, weil React
  // den Notification-Knoten selbst austauscht.
  //
  // WICHTIG (Messung 08.08., Inspector v0.6.1): `attributes` MUSS mitbeobachtet werden. Eine
  // wortgleiche Wiederholung — eine Linie, in der mehrere Zuege dieselben „+150 XP" geben —
  // aendert weder Text noch Knoten; das innerHTML ist byte-identisch. Chessable stoesst nur die
  // Einblend-Animation per ATTRIBUT am Wurzelknoten neu an. Ohne `attributes: true` feuert der
  // Observer dort gar nicht und der Zug faellt still unter den Tisch. Genau daran lag der
  // gemeldete Undercount (4,4 statt real 10-15 Zuege je Linie).
  //
  // Das Zeitfenster steht deshalb auf 400 ms: gemessene echte Zuege lagen 1,8-2,6 s auseinander,
  // alles darunter ist Animations-Flackern desselben Zuges. 800 ms verschluckte zusaetzlich
  // schnell gespielte Zuege.
  let notifObserver = null, watchedNotifParent = null, lastMoveCountAt = 0;
  // Genauigkeit: je Zug der Zustand aus der Icon-Klasse (lib/chessable-feedback.js).
  // `lineHatFehler` gilt fuer die LAUFENDE Linie und wird beim Linienwechsel ausgewertet.
  let movesCorrect = 0, linesCorrect = 0, lineHatFehler = false;

  /** Sichtbares Rueckmeldungs-Icon -> Zustand. DOM-Teil lokal, die Klassen-Zuordnung geteilt. */
  function feedbackKindOf(root) {
    const map = (self.RepCheckFeedback && self.RepCheckFeedback.kindFromClass) || (() => null);
    for (const icon of root.querySelectorAll('.icon-circle-wrapper .icon')) {
      const cs = getComputedStyle(icon);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const k = map(icon.className);
      if (k) return k;
    }
    return null;
  }
  function watchMoveNotif() {
    const n = document.querySelector('[data-testid="moveNotification"]');
    const parent = n && n.parentElement;
    if (!parent || watchedNotifParent === parent) return;
    notifObserver?.disconnect();
    watchedNotifParent = parent;
    notifObserver = new MutationObserver(() => {
      const cur = document.querySelector('[data-testid="moveNotification"]');
      const t = cur ? cur.textContent.trim() : '';
      if (!t) return;
      bump();
      if (now() - lastMoveCountAt > 400) {
        movesTrained++; lastMoveCountAt = now();
        const kind = feedbackKindOf(parent);
        const istFehler = (self.RepCheckFeedback && self.RepCheckFeedback.isFehler)
          ? self.RepCheckFeedback.isFehler(kind) : false;
        if (istFehler) lineHatFehler = true;
        else if (kind) movesCorrect++;     // 'alt' zaehlt als richtig, unbekannt gar nicht
      }
    });
    notifObserver.observe(parent, { childList: true, characterData: true, subtree: true, attributes: true });
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

  // Harte Aktivitaetssignale: Zeiger/Taste aufs Brett, Klick und Leertaste/Enter auf „Next variation".
  function installSignale() {
    document.addEventListener('pointerdown', () => { if (boardPresent()) bump(); }, true);
    document.addEventListener('keydown', () => { if (boardPresent()) bump(); }, true);

    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('button, a, [role="button"]');
      if (!btn) return;
      if (isNextVariationButton(btn)) countLine();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (nextVariationButtonVisible()) countLine();
    }, true);
  }

  // ---------- Tagesstatistik (lokal) ----------
  //
  // Grundlage für die Hochrechnung hinter dem ⏳-Zähler: wie viele Linien heute schon
  // wiederholt wurden und wie lange sie im Schnitt gedauert haben.
  //
  // Bewusst LOKAL und unabhängig von RookHub — die Zahl soll auch ohne konfigurierte Instanz
  // stimmen. Verbucht wird genau dort, wo die Zähler endgültig verbraucht sind: beim Verwerfen
  // (nicht verbunden) und beim erfolgreichen Senden. NICHT beim Fehlschlag — dort werden sie
  // zurückgebucht und später erneut gesendet, ein Zählen an der Stelle zählte doppelt.
  //
  // Gehalten werden 14 Tage, damit sich „heute" gegen den eigenen Schnitt einordnen lässt und
  // eine dünne Tagesbasis (die ersten paar Linien) nicht zu einer Fantasie-Hochrechnung führt.
  const DAILY_KEY = 'rcDailyStats';
  const DAILY_MAX_DAYS = 14;

  /** Lokales Datum als YYYY-MM-DD — bewusst NICHT UTC: „heute" ist der Tag des Nutzers. */
  function tagesSchluessel(d) {
    const x = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  }

  function dailyLesen() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([DAILY_KEY], (r) => {
          const roh = (r && r[DAILY_KEY]) || {};
          resolve(Array.isArray(roh.days) ? roh.days : []);
        });
      } catch (e) { resolve([]); }
    });
  }

  async function dailyBuchen(secs, moves, lines, movesOk, linesOk) {
    if (!secs && !moves && !lines) return;
    const tag = tagesSchluessel();
    const days = await dailyLesen();
    let heute = days.find((d) => d.d === tag);
    if (!heute) { heute = { d: tag, s: 0, m: 0, l: 0 }; days.push(heute); }
    heute.s += secs || 0;
    heute.m += moves || 0;
    heute.l += lines || 0;
    heute.mok = (heute.mok || 0) + (movesOk || 0);
    heute.lok = (heute.lok || 0) + (linesOk || 0);
    days.sort((a, b) => (a.d < b.d ? 1 : -1));          // neueste zuerst
    try { chrome.storage.local.set({ [DAILY_KEY]: { days: days.slice(0, DAILY_MAX_DAYS) } }); } catch (e) { /* egal */ }
  }

  /** Zusammenfassung für die Anzeige: heute + Schnitt der VORTAGE (heute nicht mitrechnen,
   *  sonst vergleicht sich der Tag mit sich selbst). */
  async function dailyZusammenfassung() {
    const days = await dailyLesen();
    const tag = tagesSchluessel();
    const heute = days.find((d) => d.d === tag) || { d: tag, s: 0, m: 0, l: 0 };
    const vortage = days.filter((d) => d.d !== tag && d.l > 0);
    const summe = vortage.reduce((a, d) => ({ s: a.s + d.s, l: a.l + d.l, lok: a.lok + (d.lok || 0) }), { s: 0, l: 0, lok: 0 });
    return {
      heute: { sekunden: heute.s, zuege: heute.m, linien: heute.l,
               zuegeOk: heute.mok || 0, linienOk: heute.lok || 0 },
      schnitt: {
        tage: vortage.length,
        sekProLinie: summe.l ? Math.round(summe.s / summe.l) : null,
        linienQuote: summe.l ? Math.round((summe.lok / summe.l) * 100) : null,
      },
    };
  }

  async function flush(force) {
    if (!force && activeMs < MIN_FLUSH_MS) return;
    const secs = Math.min(MAX_FLUSH_S, Math.round(activeMs / 1000));
    if (secs <= 0) return;

    const cfg = await readConfig();
    lastFlush = now();
    if (!cfg || !cfg.url || !cfg.token) {
      // Nicht mit RookHub verbunden → akkumulierte Zeit verwerfen (kein unbegrenztes Wachsen).
      // Die lokale Tagesstatistik bekommt sie trotzdem: sie hängt nicht an RookHub.
      dailyBuchen(secs, movesTrained, linesTrained, movesCorrect, linesCorrect);
      activeMs = 0; movesTrained = 0; linesTrained = 0; movesCorrect = 0; linesCorrect = 0;
      return;
    }

    const moves = movesTrained;
    const lines = linesTrained;
    const movesOk = movesCorrect;
    const linesOk = linesCorrect;
    activeMs = 0; movesTrained = 0; linesTrained = 0; movesCorrect = 0; linesCorrect = 0; // optimistisch zuruecksetzen
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
        body: JSON.stringify({ secondsActive: secs, movesTrained: moves, linesTrained: lines, courseKind: S.courseKind, courseId: currentCourseId(), courseName: bestCourseName(currentCourseId()) }),
        expect: 'json',
      }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          // Fehlgeschlagen → Zeit/Zuege/Linien zurueckbuchen, damit nichts verloren geht.
          // NICHT in die Tagesstatistik: der naechste Versuch schickt dieselben Werte erneut.
          activeMs += secs * 1000;
          movesTrained += moves;
          linesTrained += lines;
          movesCorrect += movesOk;
          linesCorrect += linesOk;
        } else {
          dailyBuchen(secs, moves, lines, movesOk, linesOk);
        }
      });
    } catch (e) {
      activeMs += secs * 1000;
      movesTrained += moves;
      linesTrained += lines;
      movesCorrect += movesOk;
      linesCorrect += linesOk;
    }
  }

  // Messtakt (TICK_MS), Flush bei „hidden", alles Ausstehende bei pagehide.
  function startTakt() {
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
    window.addEventListener('pagehide', () => { flush(true); flushProblemMoves(); flushReviewLines(); flushSessionMoves(); });
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckActivity = self.RepCheckActivity || {}).tracker = {
    init(deps) {
      ({ S, readConfig, currentCourseId, bestCourseName, lookupCourseKind, flushProblemMoves, flushReviewLines } = deps);
      ({ flushSessionMoves } = deps);
      Object.defineProperties(S, {
        lastGameOid: { get: () => lastGameOid, set: (v) => { lastGameOid = v; }, enumerable: true },
        lastGameOidAt: { get: () => lastGameOidAt, set: (v) => { lastGameOidAt = v; }, enumerable: true },
      });
    },
    TICK_MS, now, bump, boardPresent, countLine, reportTrainedLine, nextVariationButtonVisible, feedbackKindOf,
    watchMoveNotif, watchBoard, tagesSchluessel, dailyLesen, dailyBuchen, dailyZusammenfassung, flush,
    installSignale, startTakt,
  };
})();
