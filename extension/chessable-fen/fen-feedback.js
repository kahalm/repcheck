// chessable-fen.js-Teil (Zerlegung Z38, MAIN-World): die Zug-Rueckmeldung in RepChecks Leiste — Chessables
// „Overstudied"/„+XP" je Zug gespiegelt (Chessables eigene Anzeige liegt im Zen hinter dem Backdrop), farbig nach dem
// Icon (lib/chessable-feedback.js), mit Summe und Aufschluesselung je Linie; Linienwechsel ueber den Halbzug-Sprung.
//
// Zustand: Eintraege, Fehler-Halbzuege, Marken der letzten Meldung gehoeren hierher; feedbackObserver/watchedFeedbackRoot
// setzt removeUi (Leiste) ueber S zurueck. Keine Seiteneffekte beim Laden.
// Laden: Manifest content_scripts (chessable.com, world: MAIN), VOR chessable-fen.js. Ablage unter self.RepCheckFen.<teil>
// nur fuer die Verdrahtung — chessable-fen.js nimmt den Namen danach wieder aus dem window der Seite.
(function () {
  'use strict';

  // Wie chessable-fen.js: laeuft die MAIN-World-Leiste in diesem Tab schon, nichts neu anlegen.
  if (window.__repcheckChessableFen) return;

  // Aus chessable-fen.js und den anderen Teilen (init).
  let S, buttonEnabled, renderPool;

  const { extractFenFromReact } = self.RepCheckFenExtract;

  // ---------- Zug-Rückmeldung: Overstudied / +XP, mit Aufschlüsselung ----------
  //
  // Chessable zeigt seine Rückmeldung in `.board-footer` — also AUSSERHALB des Brett-Elements
  // und damit im Zen-Modus hinter unserem Backdrop. Statt fremdes DOM hochzuziehen (fragil,
  // Chessable positioniert die Leiste selbst), spiegeln wir den Text in unsere eigene Leiste.
  //
  // Gemessene Struktur (Inspector v0.2.0, Aufnahme vom 08.08.):
  //   <div class="sc-…">                          ← Wrapper, wandert in .board-footer
  //     <span class="icon-circle-wrapper">        ← Zustands-Icons, sprachunabhängig:
  //       <i class="icon icon--correct …">        ←   correct | wrong | alt | give-up | time-up
  //     <div class="sc-…"><span class="current-points">+60&nbsp;</span></div>   ← nur bei XP
  //     <span class="notification-text" data-testid="moveNotification">XP|Overstudied</span>
  // Der Text wird bewusst nur GESPIEGELT, nicht interpretiert: „Overstudied" heißt in einer
  // anderen Chessable-Sprache anders, der Betrag steckt in `.current-points`. Klassifiziert wird
  // nur für die Farbe — und zwar über die Icon-Klasse, nicht über den Text.

  const FEEDBACK_ID = 'repcheck-chessable-feedback';
  const FEEDBACK_LIST_ID = 'repcheck-chessable-feedback-list';
  /** Einträge der laufenden Linie: { text, xp, zeit }. Wird beim Linienwechsel geleert. */
  let lineFeedback = [];
  // Halbzuege, an denen in DIESER Linie ein Fehler passierte (wrong/giveup/timeup). Grund:
  // bei >= 2 Fehlzuegen laesst Chessable am Linienende die verpatzten Zuege WIEDERHOLEN und
  // springt dafuer zum jeweiligen Fehler zurueck/vor — ohne dieses Gedaechtnis sah der grosse
  // Sprung wie eine neue Linie aus und der Zaehler setzte mitten in der Linie zurueck.
  let lineFehlerPlys = [];
  let feedbackObserver = null;
  let watchedFeedbackRoot = null;
  /** Zuletzt gelesene Meldung: Wortlaut, tragender Knoten und Halbzug-Nummer des Bretts.
   *  Alle drei zusammen entscheiden, ob eine Meldung NEU ist. Der Wortlaut allein reicht
   *  nicht: drei „Overstudied" hintereinander sind wortgleich und fielen dadurch auf einen
   *  einzigen Eintrag zusammen. */
  let letzterFeedbackText = '';
  let letzterFeedbackNode = null;
  let letzterFeedbackPly = null;
  /** Zeitpunkt der zuletzt erfassten Meldung — fasst Flackern innerhalb EINES Zuges zusammen. */
  let letzterFeedbackZeit = 0;
  /** Kuerzester Abstand zwischen zwei Zug-Ereignissen. Gemessen lagen echte Zuege 1,8-2,6 s
   *  auseinander; alles darunter ist Animations-Flackern desselben Zuges. */
  const FEEDBACK_MIN_ABSTAND_MS = 400;

  /** Betrag aus „+60 " bzw. aus dem Gesamttext ziehen; null, wenn es kein XP-Ereignis ist. */
  function parseXp(pointsText, fullText) {
    const src = (pointsText || fullText || '').replace(/ /g, ' ');
    const m = /([+-]?\d[\d.,]*)/.exec(src);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  /** Zustand aus der SICHTBAREN Icon-Klasse (sprachunabhängig), sonst null.
   *  Die Klassen-Zuordnung kommt aus lib/chessable-feedback.js — sie wird auch vom
   *  Activity-Script gebraucht und darf nicht in Kopien auseinanderlaufen. */
  function feedbackKind(root) {
    const map = (self.RepCheckFeedback && self.RepCheckFeedback.kindFromClass) || rcFeedbackKindFromClass;
    for (const icon of root.querySelectorAll('.icon-circle-wrapper .icon')) {
      const cs = getComputedStyle(icon);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const k = map(icon.className);
      if (k) return k;
    }
    return null;
  }

  const FEEDBACK_COLORS = {
    correct: '#2e7d32', wrong: '#c62828', alt: '#1565c0', giveup: '#6a1b9a', timeup: '#ef6c00',
  };

  /** Halbzug-Nummer der angezeigten Stellung (0-basiert); null, wenn keine FEN lesbar ist.
   *  Sie leistet zweierlei: wortgleiche Meldungen auseinanderhalten (verschiedene Zuege) und
   *  den Linienwechsel erkennen. */
  function feedbackPly() {
    const fen = extractFenFromReact();
    if (!fen) return null;
    const teile = fen.trim().split(/\s+/);
    const zug = parseInt(teile[5], 10);
    if (!Number.isFinite(zug)) return null;
    return (zug - 1) * 2 + (teile[1] === 'b' ? 1 : 0);
  }

  function initFeedbackTracker() {
    const notif = document.querySelector('[data-testid="moveNotification"]');
    const root = notif && notif.parentElement;
    if (!root) return;
    if (watchedFeedbackRoot === root && feedbackObserver) return;
    feedbackObserver?.disconnect();
    watchedFeedbackRoot = root;

    const lesen = () => {
      const notifEl = root.querySelector('[data-testid="moveNotification"]') || root;
      // Text GEZIELT zusammensetzen statt `root.textContent` zu nehmen: beim schnellen Ziehen
      // steht kurz eine ZWEITE `.current-points`-Span im DOM, und der Gesamttext las sich dann
      // als „+70 +70 XP" (gemeldet 08.08.). Der BETRAG war nie betroffen — der kommt aus dem
      // ersten Treffer von `querySelector`, weshalb die Summe stimmte. Nur die Anzeige war schief.
      const punkteEl = root.querySelector('.current-points');
      const sauber = (n) => (n ? (n.textContent || '') : '').replace(/\u00a0/g, ' ').trim();
      const punkteTxt = sauber(punkteEl);
      const meldungTxt = sauber(notifEl);
      const text = (punkteTxt ? punkteTxt + ' ' : '') + meldungTxt;
      // Leerlauf zwischen zwei Zuegen: Marken loeschen, damit die naechste Meldung zaehlt.
      if (!text) { letzterFeedbackText = ''; letzterFeedbackNode = null; return; }

      // JEDES Feuern des Observers ist EIN Zug-Ereignis. Belegt durch die Messung vom 08.08.
      // (Inspector v0.6.1): drei wortgleiche „+150 XP" hintereinander aendern weder Text noch
      // Knoten — sie aendern NUR ein Attribut am Wurzelknoten (Chessable stoesst die
      // Einblend-Animation neu an), und zwar genau einmal je Zug, im Abstand von rund 2 s.
      //
      // Die erste Fassung verwarf reine Attribut-Mutationen ausdruecklich als „kein neues
      // Ereignis" — dieser Schutz gegen Doppelzaehlung war genau der Grund, warum die
      // Wiederholungen verschluckt wurden. Statt der Mutations-ART entscheidet jetzt der
      // zeitliche Abstand: schnelles Flackern innerhalb eines Zuges wird zusammengefasst,
      // ein echter zweiter Zug nicht. Eine Textaenderung zaehlt IMMER, unabhaengig vom Abstand.
      const jetzt = Date.now();
      const textGeaendert = text !== letzterFeedbackText || notifEl !== letzterFeedbackNode;
      if (!textGeaendert && jetzt - letzterFeedbackZeit < FEEDBACK_MIN_ABSTAND_MS) return;
      letzterFeedbackZeit = jetzt;

      const ply = feedbackPly();
      // Linienwechsel: innerhalb EINER Linie waechst die Halbzug-Nummer in kleinen Schritten
      // (eigener Zug + Antwortzug). Ein GROSSER Sprung — zurueck oder vorwaerts — heisst neue
      // Linie; sonst summierte sich alles ueber die Sitzung auf.
      //
      // WICHTIG: ein kleiner Ruecksprung ist KEIN Linienwechsel. Chessable nimmt einen
      // alternativen (und einen falschen) Zug zurueck, die Nummer faellt dabei um 1-2.
      const sprungZurueck = ply != null && letzterFeedbackPly != null && letzterFeedbackPly - ply;
      // Landet der Sprung bei (oder direkt neben) einem gemerkten Fehler-Halbzug, ist das
      // Chessables Wiederholungsphase („play the moves you missed") — DIESELBE Linie.
      const wiederholung = ply != null && lineFehlerPlys.some((f) => Math.abs(f - ply) <= 1);
      if (ply != null && letzterFeedbackPly != null && !wiederholung
          && (sprungZurueck >= 3 || ply > letzterFeedbackPly + 3)) {
        resetLineFeedback();
        letzterFeedbackZeit = jetzt;   // resetLineFeedback nullt die Marken
      }
      letzterFeedbackText = text;
      letzterFeedbackNode = notifEl;
      letzterFeedbackPly = ply;
      const xp = parseXp(punkteTxt, text);
      const kind = feedbackKind(root);
      const istFehler = (typeof rcFeedbackIsFehler === 'function')
        ? rcFeedbackIsFehler(kind)
        : (self.RepCheckFeedback && self.RepCheckFeedback.isFehler ? self.RepCheckFeedback.isFehler(kind) : false);
      if (istFehler && ply != null) lineFehlerPlys.push(ply);
      lineFeedback.push({ text, xp, kind });
      renderFeedback();
      renderPool();
    };
    lesen();
    feedbackObserver = new MutationObserver(lesen);
    feedbackObserver.observe(root, { childList: true, characterData: true, subtree: true, attributes: true });
  }

  /** Betrag mit Vorzeichen; 0 wird als „+0" geschrieben, damit die Anzeige einheitlich bleibt. */
  function signiert(n) { return (n >= 0 ? '+' : '') + n; }

  /** Summe der erfassten Beträge (Meldungen ohne Betrag zählen als 0). */
  function feedbackSum() {
    return lineFeedback.reduce((s, e) => s + (e.xp || 0), 0);
  }

  function renderFeedback() {
    const badge = document.getElementById(FEEDBACK_ID);
    if (!badge) return;
    const last = lineFeedback[lineFeedback.length - 1];
    if (!last || !buttonEnabled('feedback')) { badge.style.display = 'none'; hideFeedbackList(); return; }
    const sum = feedbackSum();
    // JEDER Zug bekommt einen Betrag — auch „Overstudied" (dann +0), damit die Anzeige nicht
    // zwischen Zahl und Wort springt. Dahinter die laufende Summe dieser Linie. Der
    // Original-Wortlaut (er trägt auch die Kontosprache) bleibt im Tooltip.
    badge.textContent = `${signiert(last.xp || 0)} · Σ ${signiert(sum)}`;
    badge.style.background = FEEDBACK_COLORS[last.kind] || 'rgba(0,0,0,0.45)';
    badge.style.display = 'inline-flex';
    badge.title = `${last.text} — klicken für die Einzelbeträge dieser Linie`;
    const list = document.getElementById(FEEDBACK_LIST_ID);
    if (list && list.style.display !== 'none') renderFeedbackList();
  }

  function renderFeedbackList() {
    let list = document.getElementById(FEEDBACK_LIST_ID);
    if (!list) {
      list = document.createElement('div');
      list.id = FEEDBACK_LIST_ID;
      Object.assign(list.style, {
        position: 'fixed', bottom: '58px', right: '16px', zIndex: '2147483647',
        maxHeight: '50vh', overflowY: 'auto', minWidth: '190px',
        background: 'rgba(0,0,0,0.85)', color: '#fff', borderRadius: '8px',
        padding: '8px 10px', font: '12px/1.5 system-ui, sans-serif',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
      });
      document.body.appendChild(list);
    }
    const zeilen = lineFeedback.map((e, i) => {
      const betrag = signiert(e.xp || 0);
      return `<div style="display:flex;gap:10px;justify-content:space-between">
        <span style="opacity:.65">${i + 1}.</span>
        <span style="flex:1">${e.text.replace(/[<>&]/g, '')}</span>
        <span style="font-variant-numeric:tabular-nums">${betrag}</span></div>`;
    }).join('');
    const sum = feedbackSum();
    list.innerHTML = `<div style="opacity:.7;margin-bottom:4px">Diese Linie — erfasste Meldungen</div>${zeilen}
      <div style="border-top:1px solid rgba(255,255,255,.25);margin-top:6px;padding-top:4px;display:flex;justify-content:space-between">
        <span>Summe der erfassten Beträge</span>
        <span style="font-variant-numeric:tabular-nums">${signiert(sum)}</span></div>
      <div style="opacity:.55;margin-top:4px;font-size:11px">Chessables Gesamtsumme kann abweichen
        (Boni am Linienende zählt RepCheck nicht mit).</div>`;
    list.style.display = 'block';
  }

  function hideFeedbackList() {
    const list = document.getElementById(FEEDBACK_LIST_ID);
    if (list) list.style.display = 'none';
  }

  function toggleFeedbackList() {
    const list = document.getElementById(FEEDBACK_LIST_ID);
    if (list && list.style.display === 'block') hideFeedbackList();
    else if (lineFeedback.length) renderFeedbackList();
  }

  /** Neue Linie → Einträge verwerfen (sonst summiert sich alles über die Sitzung auf). */
  /** Chessables "Next variation"/"Weiter" beendet die Linie -> Eintraege der naechsten
   *  Linie frisch beginnen. Ein Klick auf UNSEREN Pfeil-Knopf zaehlt genauso (er klickt
   *  Chessables Knopf durch). */
  /** Beschriftungen von Chessables „weiter"-Knopf, so weit bekannt. Nur ein ZUSATZ-Signal —
   *  die verlaessliche Linienwechsel-Erkennung sitzt in `lesen` (Halbzug-Sprung). */
  const NEXT_LABEL_RE = /^(next( variation| chapter| move| line)?|continue|weiter|fortfahren|n(ä|ae)chste[rs]?( variante| linie| kapitel| zug)?)$/i;
  let lineResetAttached = false;
  function attachLineResetListener() {
    if (lineResetAttached) return;
    lineResetAttached = true;
    document.body.addEventListener('click', (e) => {
      const el = e.target instanceof Element ? e.target.closest('button, a, [role="button"]') : null;
      if (!el) return;
      const t = (el.textContent || '').trim()
        || (el.getAttribute('aria-label') || '').trim()
        || (el.getAttribute('title') || '').trim();
      if (NEXT_LABEL_RE.test(t) || el.id === 'repcheck-zen-next'
        || el.getAttribute('data-testid') === 'nextLessonButton') resetLineFeedback();
    }, true);
  }

  function resetLineFeedback() {
    lineFeedback = [];
    lineFehlerPlys = [];
    letzterFeedbackText = '';
    letzterFeedbackNode = null;
    letzterFeedbackPly = null;
    hideFeedbackList();
    const badge = document.getElementById(FEEDBACK_ID);
    if (badge) badge.style.display = 'none';
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckFen = self.RepCheckFen || {}).feedback = {
    init(deps) {
      ({ S, buttonEnabled, renderPool } = deps);
      Object.defineProperties(S, {
        feedbackObserver: { get: () => feedbackObserver, set: (v) => { feedbackObserver = v; }, enumerable: true },
        watchedFeedbackRoot: { get: () => watchedFeedbackRoot, set: (v) => { watchedFeedbackRoot = v; }, enumerable: true },
      });
    },
    FEEDBACK_ID, FEEDBACK_LIST_ID, FEEDBACK_MIN_ABSTAND_MS, parseXp, feedbackKind, FEEDBACK_COLORS, feedbackPly,
    initFeedbackTracker, signiert, feedbackSum, renderFeedback, renderFeedbackList, hideFeedbackList,
    toggleFeedbackList, NEXT_LABEL_RE, attachLineResetListener, resetLineFeedback,
  };
})();
