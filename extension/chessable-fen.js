// Laeuft als Content-Script in der MAIN-World (siehe manifest.json: world:
// "MAIN") auf chessable.com. Blendet unten rechts zwei Knoepfe ein:
//   - "Copy FEN"   — aktuelle Brettstellung als FEN in die Zwischenablage
//   - "Search FEN" — oeffnet die Chessable-FEN-Suche fuer die Stellung
// und zeigt die zuletzt erspielten XP (nicht Overstudy/Incorrect/Alternative).
//
// MAIN-World ist noetig, weil die zuverlaessige FEN-Quelle die an den Brett-DOM-
// Knoten haengenden React-Fiber-Props sind (`fen`/`interactiveFen`) — die in der
// isolierten Content-Script-Welt NICHT lesbar waeren. Es werden keine chrome.*-
// APIs gebraucht; Clipboard laeuft ueber navigator.clipboard (mit execCommand-
// Fallback). Portiert aus github.com/kahalm/chessable-extension (v0.9.4).
(function () {
  'use strict';

  // Doppel-Init verhindern (z. B. bei mehrfachem Inject).
  if (window.__repcheckChessableFen) return;
  window.__repcheckChessableFen = true;

  // ---------- FEN extraction ----------
  //
  // Chessable nutzt cm-chessboard. Jedes Feld ist ein div mit
  // `data-square="a8"` und enthaelt ein Kind-div mit `data-piece="bR"`
  // (Farbe lowercase: w/b, Rolle uppercase: K Q R B N P).
  // chessground-Fallback bleibt fuer den Fall, dass Chessable die Engine wechselt.

  const CM_PIECE_TO_FEN = {
    wK: 'K', wQ: 'Q', wR: 'R', wB: 'B', wN: 'N', wP: 'P',
    bK: 'k', bQ: 'q', bR: 'r', bB: 'b', bN: 'n', bP: 'p',
  };

  const CG_PIECE_TO_FEN = {
    'white king': 'K', 'white queen': 'Q', 'white rook': 'R',
    'white bishop': 'B', 'white knight': 'N', 'white pawn': 'P',
    'black king': 'k', 'black queen': 'q', 'black rook': 'r',
    'black bishop': 'b', 'black knight': 'n', 'black pawn': 'p',
  };

  function debugDump() {
    const cmSquares = document.querySelectorAll('[data-square]');
    const cmPieces = document.querySelectorAll('[data-piece]');
    const cgBoard = document.querySelector('cg-board, .cg-board, [class*="cg-board"]');
    console.log('[RepCheck Chessable] debug:', {
      url: location.href,
      cmSquaresFound: cmSquares.length,
      cmPiecesFound: cmPieces.length,
      cgBoardFound: !!cgBoard,
      fiberFen: extractFenFromReact(),
      courseId: currentCourseId(),
    });
  }

  // ---- React fiber FEN extraction (preferred) ----

  const FEN_REGEX = /^[1-8rnbqkpRNBQKP/]+\s[wb]\s[KQkqA-Ha-h-]+\s(?:[a-h][1-8]|-)\s\d+\s\d+$/;

  function isValidFen(s) {
    return typeof s === 'string' && FEN_REGEX.test(s.trim());
  }

  function getReactFiber(el) {
    if (!el) return null;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    return key ? el[key] : null;
  }

  function collectFenCandidates(props, out) {
    if (!props || typeof props !== 'object') return;
    // interactiveFen = Zustand nach einem User-Zug; fen = Lektions-/Basisstellung.
    // Welche zur angezeigten Stellung passt, variiert pro Seite -> beide sammeln
    // und spaeter per DOM-Abgleich auswaehlen.
    if (isValidFen(props.interactiveFen)) out.push(props.interactiveFen.trim());
    if (isValidFen(props.fen)) out.push(props.fen.trim());
  }

  function extractFenFromReact() {
    const anchor = document.getElementById('board')
      || document.querySelector('[data-square]')?.closest('#board, [class*="chessboard"]')
      || document.querySelector('[data-square]');
    if (!anchor) return null;

    let fiber = getReactFiber(anchor);
    if (!fiber) return null;

    const candidates = [];
    let depth = 0;
    while (fiber && depth < 40) {
      collectFenCandidates(fiber.memoizedProps, candidates);
      collectFenCandidates(fiber.pendingProps, candidates);
      fiber = fiber.return;
      depth++;
    }
    if (!candidates.length) return null;

    // Bevorzugt die FEN, deren Figurenstand dem angezeigten Brett entspricht
    // (disambiguiert fen vs. interactiveFen).
    const domPlacement = extractBoardCm();
    if (domPlacement) {
      const matched = candidates.find((c) => c.split(' ')[0] === domPlacement);
      if (matched) return matched;
    }
    return candidates[0];
  }

  // ---- cm-chessboard extraction (Chessable) ----

  function extractBoardCm() {
    const squares = document.querySelectorAll('[data-square]');
    if (!squares.length) return null;

    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    let sawAnyPiece = false;

    for (const sq of squares) {
      const name = sq.getAttribute('data-square');
      if (!name || name.length !== 2) continue;
      const file = name.charCodeAt(0) - 'a'.charCodeAt(0);
      const rank = parseInt(name[1], 10) - 1;
      if (file < 0 || file > 7 || rank < 0 || rank > 7) continue;

      const pieceEl = sq.querySelector('[data-piece]');
      if (!pieceEl) continue;
      const fenChar = CM_PIECE_TO_FEN[pieceEl.getAttribute('data-piece')];
      if (!fenChar) continue;

      grid[7 - rank][file] = fenChar;
      sawAnyPiece = true;
    }

    if (!sawAnyPiece) return null;
    return placementFromGrid(grid);
  }

  // ---- chessground extraction (legacy fallback) ----

  function parseTranslate(style) {
    const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(style);
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  }

  function extractBoardCg() {
    const board = document.querySelector('cg-board, .cg-board, [class*="cg-board"]');
    if (!board) return null;

    const rect = board.getBoundingClientRect();
    const sq = rect.width / 8;
    if (!sq || !isFinite(sq)) return null;

    const wrap = document.querySelector('.cg-wrap, cg-container, [class*="cg-wrap"]');
    let orientation = 'white';
    for (let p = wrap; p; p = p.parentElement) {
      if (p.classList?.contains('orientation-black')) { orientation = 'black'; break; }
      if (p.classList?.contains('orientation-white')) { orientation = 'white'; break; }
    }

    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    const pieces = board.querySelectorAll('piece');
    if (!pieces.length) return null;

    for (const p of pieces) {
      if (p.classList.contains('ghost') || p.classList.contains('fading')) continue;
      const cls = Array.from(p.classList);
      const color = cls.find((c) => c === 'white' || c === 'black');
      const role = cls.find((c) => ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'].includes(c));
      if (!color || !role) continue;
      const fenChar = CG_PIECE_TO_FEN[`${color} ${role}`];
      if (!fenChar) continue;

      const t = parseTranslate(p.style.transform || p.getAttribute('style') || '');
      if (!t) continue;

      const colIdx = Math.round(t.x / sq);
      const rowIdx = Math.round(t.y / sq);
      if (colIdx < 0 || colIdx > 7 || rowIdx < 0 || rowIdx > 7) continue;

      const file = orientation === 'white' ? colIdx : 7 - colIdx;
      const rank = orientation === 'white' ? 7 - rowIdx : rowIdx;
      grid[7 - rank][file] = fenChar;
    }

    return placementFromGrid(grid);
  }

  function placementFromGrid(grid) {
    return grid.map((row) => {
      let s = '', empty = 0;
      for (const c of row) {
        if (c === null) empty++;
        else {
          if (empty) { s += empty; empty = 0; }
          s += c;
        }
      }
      if (empty) s += empty;
      return s;
    }).join('/');
  }

  function extractBoard() {
    return extractBoardCm() || extractBoardCg();
  }

  function detectSideToMove() {
    const txt = document.body.innerText || '';
    if (/black\s+to\s+(?:move|play)/i.test(txt)) return 'b';
    if (/white\s+to\s+(?:move|play)/i.test(txt)) return 'w';
    return null;
  }

  function buildFEN() {
    const fiberFen = extractFenFromReact();
    if (fiberFen) return fiberFen;

    const placement = extractBoard();
    if (!placement) return null;
    return `${placement} ${detectSideToMove() || 'w'} KQkq - 0 1`;
  }

  // ---------- Clipboard ----------

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      return true;
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  // ---------- Chessable search URL ----------

  function currentCourseId() {
    const urlM = /\/courses?\/(\d+)(?:\/|$)/.exec(location.pathname);
    if (urlM) return urlM[1];

    for (const a of document.querySelectorAll('a[href*="/course/"]')) {
      const m = /\/course\/(\d+)(?:\/|$)/.exec(a.getAttribute('href') || '');
      if (m) return m[1];
    }

    const anchor = document.getElementById('board') || document.querySelector('[data-square]');
    if (anchor) {
      let fiber = getReactFiber(anchor);
      let depth = 0;
      while (fiber && depth < 60) {
        const id = fiberCourseId(fiber.memoizedProps) || fiberCourseId(fiber.pendingProps);
        if (id) return id;
        fiber = fiber.return;
        depth++;
      }
    }
    return null;
  }

  function fiberCourseId(props) {
    if (!props || typeof props !== 'object') return null;
    const candidates = [
      props.courseId, props.courseID, props.course_id,
      props.course?.id, props.course?.courseId,
    ];
    for (const c of candidates) {
      if (c != null && /^\d+$/.test(String(c))) return String(c);
    }
    return null;
  }

  function chessableSearchUrl(fen) {
    const courseId = currentCourseId();
    if (courseId) {
      // Kursinterne FEN-Suche: "/" -> ";", " " -> %20. Restliche FEN-Zeichen sind
      // URL-sicher, daher KEIN encodeURIComponent (das wuerde ";" zu %3B machen).
      const encoded = fen.replace(/\//g, ';').replace(/ /g, '%20');
      return `https://www.chessable.com/course/${courseId}/fen/${encoded}/`;
    }
    // Fallback (keine Kurs-ID): globale FEN-Suche, "/" -> "U".
    const encoded = fen.replace(/\//g, 'U').replace(/ /g, '%20');
    return `https://www.chessable.com/courses/fen/${encoded}/`;
  }

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

  // ---------- Verbleibende Linien im Trainingspool ----------
  //
  // Quelle ist die Zaehler-Plakette im AUSGEWAEHLTEN Tab der Chessable-Leiste. Gemessen am
  // 08.08. (Inspector-Snapshot):
  //   <button role="tab" aria-selected="true" id="tab-1">
  //     <span class="MuiTab-wrapper"><span class="sc-hlqNbq iXetOK">68</span><span>Review</span></span>
  //
  // Bewusst NICHT ueber die Klassen `sc-hlqNbq iXetOK` gesucht: styled-components erzeugt die
  // bei jedem Chessable-Deploy neu, ein Selektor darauf haelt keine Woche. Die Struktur
  // (role=tab, erste blattlose Kind-Span mit reiner Zahl) ist stabil und sprachunabhaengig —
  // die Beschriftung („Review") waere es nicht, die haengt an der Kontosprache.

  const POOL_ID = 'repcheck-chessable-pool';

  // ---------- Klick auf den Pool-Zähler: Tagesbilanz + Hochrechnung ----------
  //
  // Die Zahlen kommen aus der lokalen Tagesstatistik von chessable-activity.js (isolierte
  // Welt hat chrome.storage, wir hier nicht) über die vorhandene postMessage-Brücke.
  //
  // Grundsatz für die Hochrechnung: lieber ehrlich unscharf als scheingenau. Nach drei
  // Linien ist ein Tagesschnitt Rauschen — dann wird der Schnitt der Vortage genommen und
  // das auch dazugeschrieben. Gibt es beides nicht, steht da keine Zahl, sondern der Grund.

  const POOL_PANEL_ID = 'repcheck-chessable-pool-panel';
  /** Ab so vielen Linien gilt der Tagesschnitt als tragfähig. */
  const POOL_MIN_LINIEN = 5;
  let poolDaily = null;

  function poolFordereDaten() {
    try { window.postMessage({ __repcheck: 'request-daily' }, location.origin); } catch (e) { /* egal */ }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data) return;
    if (e.data.__repcheck !== 'daily') return;
    poolDaily = e.data.daily || null;
    if (document.getElementById(POOL_PANEL_ID)) renderPoolPanel();
  });

  /** „1:23 h" bzw. „12 min" — Stunden erst, wenn es welche gibt. */
  function poolDauer(sekunden) {
    const m = Math.round(sekunden / 60);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ' h';
  }

  function poolUhrzeit(inSekunden) {
    const d = new Date(Date.now() + inSekunden * 1000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function poolZeile(label, wert, dezent) {
    return '<div style="display:flex;gap:14px;justify-content:space-between' + (dezent ? ';opacity:.7' : '') + '">'
      + '<span>' + label + '</span><span style="font-variant-numeric:tabular-nums">' + wert + '</span></div>';
  }

  function renderPoolPanel() {
    let el = document.getElementById(POOL_PANEL_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = POOL_PANEL_ID;
      Object.assign(el.style, {
        position: 'fixed', bottom: '58px', right: '16px', zIndex: '2147483647',
        minWidth: '250px', maxWidth: '320px', background: 'rgba(0,0,0,0.88)', color: '#fff',
        borderRadius: '8px', padding: '10px 12px', font: '12px/1.55 system-ui, sans-serif',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
      });
      document.body.appendChild(el);
    }
    const rest = trainingPoolRest();
    const h = (poolDaily && poolDaily.heute) || { sekunden: 0, zuege: 0, linien: 0 };
    const sch = (poolDaily && poolDaily.schnitt) || { tage: 0, sekProLinie: null };

    const zeilen = [];
    zeilen.push('<div style="opacity:.7;margin-bottom:5px">Trainingspool</div>');
    zeilen.push(poolZeile('Noch offen', rest == null ? '—' : rest + ' Linien'));
    zeilen.push(poolZeile('Heute geschafft', h.linien + ' Linien'));

    const heuteSchnitt = h.linien > 0 ? Math.round(h.sekunden / h.linien) : null;
    if (heuteSchnitt != null) {
      const proZug = h.zuege > 0 ? ' · ' + (h.sekunden / h.zuege).toFixed(0) + ' s/Zug' : '';
      zeilen.push(poolZeile('Ø je Linie heute', heuteSchnitt + ' s' + proZug));
    }
    if (h.linien > 0) {
      // Eine Linie gilt als richtig, wenn in ihr kein Fehlzug, kein Aufgeben und kein
      // Zeitablauf vorkam; ein akzeptierter Alternativzug zaehlt NICHT als Fehler.
      const quote = Math.round((h.linienOk / h.linien) * 100);
      const zugQuote = h.zuege > 0 ? ' · ' + Math.round((h.zuegeOk / h.zuege) * 100) + ' % Zuege' : '';
      zeilen.push(poolZeile('Genauigkeit heute', quote + ' % (' + h.linienOk + '/' + h.linien + ')' + zugQuote));
    }
    if (h.sekunden > 0) zeilen.push(poolZeile('Aktive Zeit heute', poolDauer(h.sekunden)));

    // Hochrechnung: Tagesschnitt, wenn er auf genug Linien beruht — sonst der Schnitt der
    // Vortage. Das Feld sagt immer dazu, worauf es sich stützt.
    let basis = null, basisText = '';
    if (heuteSchnitt != null && h.linien >= POOL_MIN_LINIEN) {
      basis = heuteSchnitt; basisText = 'Tagesschnitt';
    } else if (sch.sekProLinie) {
      basis = sch.sekProLinie;
      basisText = 'Schnitt der letzten ' + sch.tage + (sch.tage === 1 ? ' Tag' : ' Tage');
    }

    zeilen.push('<div style="border-top:1px solid rgba(255,255,255,.22);margin:7px 0 5px"></div>');
    if (rest == null) {
      zeilen.push('<div style="opacity:.75">Kein Pool-Zähler auf der Seite gefunden.</div>');
    } else if (rest === 0) {
      zeilen.push('<div>Pool leer — für heute durch. ✓</div>');
    } else if (basis == null) {
      zeilen.push('<div style="opacity:.75">Für eine Hochrechnung fehlen noch Daten — '
        + 'nach ein paar Linien steht hier eine Schätzung.</div>');
    } else {
      const restSek = rest * basis;
      zeilen.push(poolZeile('Rest ≈', poolDauer(restSek) + ' → ' + poolUhrzeit(restSek)));
      zeilen.push('<div style="opacity:.6;margin-top:3px;font-size:11px">gerechnet mit ' + basis
        + ' s je Linie (' + basisText + ')'
        + (heuteSchnitt != null && h.linien < POOL_MIN_LINIEN
          ? ' — heute erst ' + h.linien + (h.linien === 1 ? ' Linie' : ' Linien') + ', dafür zu wenig'
          : '') + '</div>');
      if (heuteSchnitt != null && sch.sekProLinie && h.linien >= POOL_MIN_LINIEN) {
        const diff = Math.round(((heuteSchnitt / sch.sekProLinie) - 1) * 100);
        if (Math.abs(diff) >= 8) {
          zeilen.push('<div style="opacity:.6;font-size:11px">heute ' + Math.abs(diff) + ' % '
            + (diff > 0 ? 'langsamer' : 'schneller') + ' als sonst (' + sch.sekProLinie + ' s)</div>');
        }
      }
    }
    el.innerHTML = zeilen.join('');
    el.style.display = 'block';
  }

  function togglePoolPanel() {
    const el = document.getElementById(POOL_PANEL_ID);
    if (el && el.style.display === 'block') { el.style.display = 'none'; return; }
    poolFordereDaten();     // Antwort rendert nach; wir zeigen sofort, was wir schon haben
    renderPoolPanel();
  }

  function hidePoolPanel() {
    const el = document.getElementById(POOL_PANEL_ID);
    if (el) el.style.display = 'none';
  }
  let poolTimer = null;

  function trainingPoolRest() {
    const tab = document.querySelector('button[role="tab"][aria-selected="true"]');
    if (!tab) return null;
    for (const span of tab.querySelectorAll('span')) {
      if (span.children.length) continue;
      const t = (span.textContent || '').trim();
      if (/^\d{1,4}$/.test(t)) return parseInt(t, 10);
    }
    return null;
  }

  function renderPool() {
    const el = document.getElementById(POOL_ID);
    if (!el) return;
    const rest = trainingPoolRest();
    if (rest == null || !buttonEnabled('pool')) { el.style.display = 'none'; hidePoolPanel(); return; }
    el.textContent = '\u23F3 ' + rest;
    el.title = 'Noch offen im aktuellen Trainingspool — klicken fuer Tagesbilanz und Hochrechnung';
    el.style.display = 'inline-flex';
  }

  // ---------- UI ----------

  const CONTAINER_ID = 'repcheck-chessable-fen-tools';
  const COPY_BTN_ID = 'repcheck-chessable-fen-copy-btn';
  const SEARCH_BTN_ID = 'repcheck-chessable-fen-search-btn';

  function styleButton(btn, bg) {
    Object.assign(btn.style, {
      padding: '8px 12px',
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
      background: bg,
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
      cursor: 'pointer',
      opacity: '0.9',
    });
    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.9'; });
  }

  // Mobile: die Floating-Buttons kollidieren unten mit der Firefox-/System-
  // Leiste. Auf schmalen Screens daher höher setzen (+ Safe-Area) und umbrechen
  // lassen. !important, weil die Basis-Position als Inline-Style gesetzt ist.
  const MOBILE_STYLE_ID = 'repcheck-chessable-fen-mobile-style';
  function injectMobileStyle() {
    if (document.getElementById(MOBILE_STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = MOBILE_STYLE_ID;
    st.textContent = `
      @media (max-width: 768px) {
        #${CONTAINER_ID} {
          bottom: calc(env(safe-area-inset-bottom, 0px) + 88px) !important;
          right: calc(env(safe-area-inset-right, 0px) + 8px) !important;
          left: 8px !important;
          flex-wrap: wrap !important;
          justify-content: flex-end !important;
          gap: 6px !important;
        }
        #${CONTAINER_ID} button { padding: 6px 10px !important; font-size: 12px !important; }
      }`;
    (document.head || document.documentElement).appendChild(st);
  }

  // ── Vollbild-/Zen-Modus ─────────────────────────────────────────────────
  // Ganze Seite in echtes Vollbild, das Brett groß und mittig auf dunklem
  // Backdrop. Bewusst KEIN DOM-Umbau (Chessable ist React — Knoten verschieben
  // bricht die Reconciliation): das Brett bekommt nur Inline-Styles, der Rest
  // der Seite verschwindet hinter einem eigenen Backdrop-DIV. Die RepCheck-
  // Buttons liegen über dem Backdrop → der Knopf selbst (oder Esc) führt raus.
  //
  // Vergrößert wird OHNE zoom/transform:scale — beides bricht das Drag&Drop
  // von chessboard.js: die Feld-Offsets werden beim Drag-Start VISUELL
  // gemessen (getBoundingClientRect-basiert, also mitskaliert), die Treffer-
  // Prüfung rechnet aber mit der LAYOUT-squareSize → jede Feld-Hitbox deckt
  // nur einen Teil des Felds, Drops in der toten Zone enden als Snapback
  // (per Inspector-Trace belegt). Stattdessen: width/height des Bretts per
  // !important auf die Zielgröße festnageln und Chessables eigenen Resize-
  // Pfad anstoßen (resize-Event) — der ruft board.resize() auf, chessboard.js
  // berechnet die squareSize echt neu, und Maus- wie Brettkoordinaten leben
  // wieder im selben System.
  const ZEN_BACKDROP_ID = 'repcheck-zen-backdrop';
  const ZEN_STYLE_ID = 'repcheck-zen-style';
  let zenBoard = null;
  let zenPrevStyle = '';
  /** Chessables Annotations-Layer (`svg#drawings`: Pfeile, Kreise) — sein Stil vor dem Zen.
   *  null = noch nicht angefasst. */
  let zenPrevDrawingsStyle = null;
  let zenRescale = null;
  let zenApplied = 0;
  let zenPokeTimer = null;
  // Zen-only-Buttons (▸ Next, 💬 Kommentar-Panel) + gehobenes Panel-Element.
  let zenNextBtn = null;
  let zenPanelBtn = null;
  let zenAnalyseBtn = null;
  let zenHintBtn = null;
  let zenPanelEl = null;
  let zenPanelPrevStyle = '';
  /** Vorfahren, deren Stacking-Context/Containing-Block fürs Zen neutralisiert wurde: [{el, prev}]. */
  let zenLifted = [];

  function zenTarget() {
    return document.getElementById('board')
      || document.querySelector('[data-square]')?.closest('#board, [class*="chessboard"]')
      || document.querySelector('.cg-wrap, cg-container, [class*="cg-wrap"]')
      || null;
  }

  function zenActive() { return !!document.getElementById(ZEN_BACKDROP_ID); }

  // Chessables Resize-Handler (debounced) anstoßen, damit chessboard.js die
  // squareSize an die neue Brettgröße anpasst. Wird nur bei geänderter
  // Zielgröße gerufen → keine Event-Schleife mit dem eigenen resize-Listener.
  function zenPokeLayout() {
    if (zenPokeTimer) return;
    zenPokeTimer = setTimeout(() => {
      zenPokeTimer = null;
      window.dispatchEvent(new Event('resize'));
    }, 60);
  }


  /**
   * Chessables Annotations-Layer: `svg#drawings` — dort liegen Pfeile UND Feld-Kreise.
   *
   * Er ist ein GESCHWISTER des Bretts (beide unter `div.noScrollingWithFinger`) und deckt
   * sich im Normalfall exakt damit, weil er `position:absolute; left:0; top:0` im selben
   * positionierten Elternteil hat. Im Zen ziehen wir das Brett auf `position:fixed` — der
   * Layer bleibt zurueck. Gemessen am 08.08. (Snapshots mtpfeil/ohnepfeil): Brett bei
   * (152,13), Layer bei (1187,545), also 1035 px rechts und 532 px unter dem Brett. Der Pfeil
   * war die ganze Zeit im DOM (`<line stroke="#e02828" marker-end="url(#arrowhead-r)">`), nur
   * eben neben dem Brett — und mit `z-index:10` zusaetzlich unter unserem Backdrop.
   */
  function zenDrawingsLayer() {
    return document.getElementById('drawings');
  }

  /**
   * Brett (und Panel) liegen im Zen per position:fixed + z-index ÜBER dem Backdrop. Das trägt nur,
   * wenn KEIN Vorfahr einen eigenen Stacking-Context/Containing-Block aufmacht (transform, filter,
   * contain, container-type, will-change, positioniertes z-index, opacity<1, …). Sonst bleibt das
   * Brett in diesem Vorfahren gefangen: sein z-index gilt nur dort, das Backdrop (Kind von body) liegt
   * darüber → schwarzer Bildschirm, nur unsere Buttons sichtbar (Handy, 2026-08). Die Desktop-Kette
   * bis #root ist frei davon (Snapshot 08.08.), Chessables mobiles Layout nicht. Solche Vorfahren
   * werden für die Dauer des Zen neutralisiert (Inline-!important, beim Verlassen zurückgesetzt) —
   * die Layout-Verschiebung darunter deckt das Backdrop ohnehin ab. Kein DOM-Umbau (React!).
   */
  function zenLiftAncestors(node) {
    for (let el = node && node.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (zenLifted.some((x) => x.el === el)) continue;
      const cs = getComputedStyle(el);
      const traps = cs.transform !== 'none' || cs.perspective !== 'none' || cs.filter !== 'none'
        || (cs.backdropFilter && cs.backdropFilter !== 'none')
        || (cs.contain && cs.contain !== 'none')
        || (cs.containerType && cs.containerType !== 'normal')
        || /transform|perspective|filter|contain/.test(cs.willChange || '')
        || (cs.zIndex !== 'auto' && cs.position !== 'static')
        || parseFloat(cs.opacity) < 1
        || cs.isolation === 'isolate'
        || (cs.mixBlendMode && cs.mixBlendMode !== 'normal')
        || (cs.clipPath && cs.clipPath !== 'none')
        || (cs.maskImage && cs.maskImage !== 'none');
      if (!traps) continue;
      zenLifted.push({ el, prev: el.getAttribute('style') });
      const st = el.style;
      for (const [p, v] of [['transform', 'none'], ['perspective', 'none'], ['filter', 'none'],
        ['backdrop-filter', 'none'], ['contain', 'none'], ['container-type', 'normal'], ['will-change', 'auto'],
        ['z-index', 'auto'], ['opacity', '1'], ['isolation', 'auto'], ['mix-blend-mode', 'normal'],
        ['clip-path', 'none'], ['mask-image', 'none']]) {
        st.setProperty(p, v, 'important');
      }
    }
  }

  function zenRestoreAncestors() {
    for (const { el, prev } of zenLifted) {
      if (prev) el.setAttribute('style', prev);
      else el.removeAttribute('style');
    }
    zenLifted = [];
  }

  function enterZen(btn) {
    const board = zenTarget();
    const rect = board && board.getBoundingClientRect();
    if (!board || !rect || !rect.width) { flash(btn, 'No board found', '#c62828'); return; }
    zenBoard = board;
    zenPrevStyle = board.getAttribute('style') || '';
    zenLiftAncestors(board);

    const backdrop = document.createElement('div');
    backdrop.id = ZEN_BACKDROP_ID;
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', background: '#111', zIndex: '2147483600',
    });
    // Bewusst KEIN Klick-zum-Beenden: neben das Brett zu klicken passiert beim Training
    // staendig (Maus parken, versehentlicher Klick nach einem Zug) — dabei aus dem Vollbild zu
    // fliegen reisst aus der Konzentration. Raus geht es ueber ✕ oder Esc.
    document.body.appendChild(backdrop);

    // chessboard.js hängt die gezogene Schwebefigur an <body> — die muss ÜBER
    // das Backdrop, sonst ist die Figur während des Ziehens unsichtbar.
    // (.piece-417db ist eine chessboard.js-Konstante, kein generierter Hash.)
    if (!document.getElementById(ZEN_STYLE_ID)) {
      const st = document.createElement('style');
      st.id = ZEN_STYLE_ID;
      st.textContent = 'body > .piece-417db { z-index: 2147483620 !important; }';
      (document.head || document.documentElement).appendChild(st);
    }

    zenApplied = 0;
    zenRescale = () => {
      // Offenes Panel reserviert rechts Platz: das Brett wird entsprechend kleiner UND um
      // die halbe Reserve nach links gerückt, statt sich mit dem Panel zu überlappen.
      const reserve = zenReservedRight();
      const reserveBottom = zenReservedBottom();
      // Nie unter ein bedienbares Minimum: ein rechts angedocktes Panel liess auf dem Handy
      // (390 px breit, 304 px Reserve) ein Brett von ~80 px uebrig.
      const target = Math.max(160, Math.floor(0.97 * Math.min(window.innerWidth - reserve, window.innerHeight - reserveBottom)));
      if (zenPanelEl) zenPanelPlace(zenPanelEl);   // Geometrie folgt Drehung/Resize
      // !important, weil Chessables eigener Resize-Handler style.width neu
      // setzt (fit-height-Berechnung): unsere Größe muss gewinnen — sein
      // board.resize() liest danach die tatsächliche (= unsere) Breite und
      // zeichnet die Felder in der neuen Größe.
      const s = zenBoard.style;
      s.setProperty('position', 'fixed', 'important');
      s.setProperty('left', `calc(50% - ${Math.round(reserve / 2)}px)`, 'important');
      s.setProperty('top', `calc(50% - ${Math.round(reserveBottom / 2)}px)`, 'important');
      s.setProperty('margin', '0', 'important');
      s.setProperty('transform', 'translate(-50%, -50%)', 'important');
      s.setProperty('z-index', '2147483610', 'important');
      for (const p of ['width', 'height', 'max-width', 'max-height']) {
        s.setProperty(p, target + 'px', 'important');
      }
      if (target !== zenApplied) { zenApplied = target; zenPokeLayout(); }
      // Annotations-Layer mit dem Brett mitziehen (siehe zenDrawingsLayer): dieselbe
      // Geometrie, ueber dem Backdrop, und ohne Klicks abzufangen — Pfeile sind Anzeige.
      const dr = zenDrawingsLayer();
      if (dr) {
        if (zenPrevDrawingsStyle === null) zenPrevDrawingsStyle = dr.getAttribute('style') || '';
        const ds = dr.style;
        ds.setProperty('position', 'fixed', 'important');
        ds.setProperty('left', `calc(50% - ${Math.round(reserve / 2)}px)`, 'important');
        ds.setProperty('top', `calc(50% - ${Math.round(reserveBottom / 2)}px)`, 'important');
        ds.setProperty('margin', '0', 'important');
        ds.setProperty('transform', 'translate(-50%, -50%)', 'important');
        ds.setProperty('z-index', '2147483611', 'important');   // knapp ueber dem Brett
        ds.setProperty('pointer-events', 'none', 'important');
        ds.setProperty('width', target + 'px', 'important');
        ds.setProperty('height', target + 'px', 'important');
      }
    };
    zenRescale();
    // Kommentare/Züge standardmäßig AN: im Vollbild ist der freie Platz daneben sonst
    // ungenutzt, und genau diese Spalte will man beim Durcharbeiten sehen. 💬 schaltet sie
    // wieder aus. Nach zenRescale, damit die Brettbreite für die Spaltenbreite schon steht.
    if (!zenNarrow()) zenPanelShow(null, true);   // Handy: Platz reicht nicht fuer beides
    window.addEventListener('resize', zenRescale);

    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
    updateZenButton();
  }


  function exitZen() {
    document.getElementById(ZEN_BACKDROP_ID)?.remove();
    document.getElementById(ZEN_STYLE_ID)?.remove();
    zenPanelHide();
    if (zenPokeTimer) { clearTimeout(zenPokeTimer); zenPokeTimer = null; }
    if (zenRescale) { window.removeEventListener('resize', zenRescale); zenRescale = null; }
    if (zenBoard) {
      if (zenPrevStyle) zenBoard.setAttribute('style', zenPrevStyle);
      else zenBoard.removeAttribute('style');
      zenBoard = null;
    }
    // Annotations-Layer zurueckgeben; Chessable rechnet ihn beim naechsten resize neu.
    if (zenPrevDrawingsStyle !== null) {
      const dr = zenDrawingsLayer();
      if (dr) {
        if (zenPrevDrawingsStyle) dr.setAttribute('style', zenPrevDrawingsStyle);
        else dr.removeAttribute('style');
      }
      zenPrevDrawingsStyle = null;
    }
    // Chessable-Layout zurück auf Normalgröße rechnen lassen (board.resize()).
    window.dispatchEvent(new Event('resize'));
    zenRestoreAncestors();
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    updateZenButton();
  }

  // ── Zen-Extras: ▸ Next-Klick + 💬 Kommentar-/Zugspalte ──────────────────
  // Chessables eigener „Next"-Knopf liegt im Zen-Modus hinterm Backdrop —
  // der ▸-Button sucht ihn per Text und klickt ihn programmatisch (React
  // bekommt ein echtes click-Event, Sichtbarkeit spielt dafür keine Rolle).
  // Chessables eigener „Hint"-Knopf — im Zen ebenfalls hinterm Backdrop. Gleiche
  // Suche wie beim Next: per Text, klick programmatisch (React braucht keine Sichtbarkeit).
  function clickChessableHint(btn) {
    // Chessables Hint ist ein Icon-DIV [data-testid="squareHintButton"] (Glocke + „Hint") im
    // .board-footer — KEIN <button>. Darum primär per testid (klickt auch im Zen hinterm Backdrop;
    // React braucht keine Sichtbarkeit). Fallback: die alte Textsuche, jetzt inkl. div[data-testid].
    let cand = document.querySelector('[data-testid="squareHintButton"]');
    if (!cand) {
      cand = [...document.querySelectorAll('button, a, [role="button"], div[data-testid]')].find((el) => {
        if (el.closest('#' + CONTAINER_ID)) return false;
        const t = (el.textContent || '').trim();
        if (!/^(hint|tipp)$/i.test(t)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    }
    if (cand) cand.click();
    else flash(btn, 'Kein „Hint" da', '#c62828');
  }

  function clickChessableNext(btn) {
    // Chessables Next ist [data-testid="nextLessonButton"] und traegt ZWEI Label-Spans
    // („Next variation" not-in-mobile + „Next" not-in-desktop) → textContent ist
    // „Next variationNext", die exakte Textsuche griff also nie. Primaer per testid
    // (klickt auch im Zen hinterm Backdrop); Fallback bleibt die Textsuche.
    let cand = document.querySelector('[data-testid="nextLessonButton"]');
    if (!cand) {
      cand = [...document.querySelectorAll('button, a, [role="button"]')].find((el) => {
        if (el.closest('#' + CONTAINER_ID)) return false;
        const t = (el.textContent || '').trim();
        if (!/^(next( variation| chapter| move| line)?|weiter)$/i.test(t)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    }
    if (cand) cand.click();
    else flash(btn, 'Kein „Next" da', '#c62828');
  }

  // Kommentar-/Zugspalte finden: die Geschwister-Spalte der Brett-Spalte im
  // Practice-Layout (row-practice__col*) mit dem meisten Text — dort wohnen
  // die Kommentare + Zugliste, die man sonst am Linienende sieht.
  function zenPanelTarget() {
    const board = zenBoard || zenTarget();
    const boardCol = board && board.closest('[class*="__col"]');
    const row = boardCol && boardCol.parentElement;
    if (!row) return null;
    let best = null;
    for (const el of row.children) {
      if (el === boardCol) continue;
      if (el.getBoundingClientRect().width < 120) continue;
      if (!best || (el.textContent || '').length > (best.textContent || '').length) best = el;
    }
    return best;
  }

  /** Panel-Breite — BEWUSST unabhängig von der Brettgröße. Sie aus dem Brett-Rect zu rechnen
   *  ging beim automatischen Öffnen schief: da hat Chessable das Brett noch nicht neu
   *  gelayoutet, das Rect ist veraltet, das Panel wurde zu breit und lag über dem Brett
   *  (erst Zu- und Wieder-Aufklappen sah richtig aus). */
  function zenPanelWidth() {
    return Math.round(Math.min(460, Math.max(280, window.innerWidth * 0.24)));
  }

  /** Schmal/hochkant (Handy): das Panel passt nicht NEBEN ein brauchbares Brett → es dockt unten an. */
  function zenNarrow() { return window.innerWidth < 720 || window.innerWidth < window.innerHeight; }
  function zenPanelHeightNarrow() { return Math.round(window.innerHeight * 0.34); }

  /** Platz, den das offene Panel rechts belegt (inkl. Abstand) — 0, wenn es zu ist oder unten sitzt. */
  function zenReservedRight() {
    return zenPanelEl && !zenNarrow() ? zenPanelWidth() + 24 : 0;
  }
  /** Platz, den das offene Panel UNTEN belegt (nur schmal/hochkant). */
  function zenReservedBottom() {
    return zenPanelEl && zenNarrow() ? zenPanelHeightNarrow() + 24 : 0;
  }

  /** Panel-Geometrie — rechts neben dem Brett (breit) bzw. unten drunter (schmal/hochkant). */
  function zenPanelPlace(panel) {
    const s = panel.style;
    s.setProperty('position', 'fixed', 'important');
    if (zenNarrow()) {
      s.setProperty('left', '12px', 'important');
      s.setProperty('right', '12px', 'important');
      s.setProperty('bottom', '12px', 'important');
      s.setProperty('top', 'auto', 'important');
      s.setProperty('transform', 'none', 'important');
      s.setProperty('width', 'auto', 'important');
      s.setProperty('max-height', zenPanelHeightNarrow() + 'px', 'important');
    } else {
      s.setProperty('top', '50%', 'important');
      s.setProperty('right', '12px', 'important');
      s.setProperty('left', 'auto', 'important');
      s.setProperty('bottom', 'auto', 'important');
      s.setProperty('transform', 'translateY(-50%)', 'important');
      s.setProperty('width', zenPanelWidth() + 'px', 'important');
      s.setProperty('max-height', '92vh', 'important');
    }
    s.setProperty('overflow-y', 'auto', 'important');
    s.setProperty('z-index', '2147483615', 'important');
    s.setProperty('margin', '0', 'important');
    s.setProperty('padding', '12px', 'important');
    s.setProperty('border-radius', '10px', 'important');
    s.setProperty('box-shadow', '0 4px 24px rgba(0,0,0,0.5)', 'important');
  }

  function zenPanelShow(btn, silent) {
    const panel = zenPanelTarget();
    // Beim AUTOMATISCHEN Öffnen (Zen-Start) nicht meckern: findet die Heuristik kein
    // Panel, soll der Nutzer einfach kein Panel sehen — keine Fehlermeldung am Knopf.
    if (!panel) { if (!silent) flash(btn, 'Kein Panel gefunden', '#c62828'); return; }
    zenPanelEl = panel;
    zenPanelPrevStyle = panel.getAttribute('style') || '';
    const s = panel.style;
    zenLiftAncestors(panel);   // dieselbe Stacking-Context-Falle wie beim Brett
    zenPanelPlace(panel);
    // Transparente Panels bekommen auf dem dunklen Backdrop einen zur
    // Textfarbe passenden Grund (helle Schrift → dunkel, dunkle → hell).
    const cs = getComputedStyle(panel);
    if (!cs.backgroundColor || cs.backgroundColor === 'transparent' || /rgba\([^)]*,\s*0\)\s*$/.test(cs.backgroundColor)) {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cs.color || '');
      const lightText = m && (+m[1] + +m[2] + +m[3]) / 3 > 128;
      s.setProperty('background', lightText ? '#1e1e1e' : '#fafafa', 'important');
    }
    if (zenRescale) zenRescale();   // Brett auf den verbleibenden Platz rücken
  }

  function zenPanelHide() {
    if (!zenPanelEl) return;
    if (zenPanelPrevStyle) zenPanelEl.setAttribute('style', zenPanelPrevStyle);
    else zenPanelEl.removeAttribute('style');
    zenPanelEl = null;
    if (zenRescale) zenRescale();   // Brett bekommt den Platz zurück
  }

  function toggleZenPanel(btn) {
    if (zenPanelEl) zenPanelHide();
    else zenPanelShow(btn);
  }

  // Esc beendet nur das Browser-Vollbild — dann auch den Zen-Zustand abbauen.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && zenActive()) exitZen();
    else updateZenButton();   // Vollbild BETRETEN → Knopf wechselt auf „verlassen"
  });

  function updateZenButton() {
    const btn = btnRefs.fullscreen;
    if (btn) {
    btn.textContent = zenActive() ? '✕' : '⛶';
    btn.title = zenActive() ? 'Vollbild verlassen (Esc)' : 'Brett bildschirmfüllend (Esc beendet)';
    }
    // Im Zen-Modus bleiben Exit, Refresh und die Zen-Extras (▸/💬) sichtbar.
    // Beim Verlassen stellt applyButtonSettings() die Popup-Einstellungen
    // wieder her; die Zen-Extras werden explizit versteckt (nicht in btnRefs).
    const wrap = document.getElementById(CONTAINER_ID);
    if (!wrap) return;
    // Refresh traegt im Zen nur das Icon — Beschriftungen haben dort nichts verloren.
    if (btnRefs.refresh) {
      btnRefs.refresh.textContent = zenActive() ? '⟳' : 'Refresh';
      if (zenActive()) Object.assign(btnRefs.refresh.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px' });
      else Object.assign(btnRefs.refresh.style, { fontSize: '', lineHeight: '', padding: '' });
    }
    if (zenActive()) {
      for (const child of wrap.children) {
        // Zug-Rueckmeldung und Pool-Zaehler schalten sich selbst (Daten + Popup-Einstellung). Im Zen sind
        // sie der einzige Weg, Overstudied/+XP bzw. den Rest zu sehen (Chessables eigene Anzeige liegt
        // hinterm Backdrop) — aber nur, wenn sie eingeschaltet sind.
        if (child.id === FEEDBACK_ID || child.id === POOL_ID) continue;
        const keep = child === btn || child === btnRefs.refresh || child === zenNextBtn
          || child === zenPanelBtn || child === zenAnalyseBtn || child === zenHintBtn;
        child.style.display = keep ? '' : 'none';
      }
      renderFeedback();
      renderPool();
    } else {
      if (zenNextBtn) zenNextBtn.style.display = 'none';
      if (zenPanelBtn) zenPanelBtn.style.display = 'none';
      if (zenAnalyseBtn) zenAnalyseBtn.style.display = 'none';
      if (zenHintBtn) zenHintBtn.style.display = 'none';
      applyButtonSettings();
    }
  }

  function createUi() {
    if (document.getElementById(CONTAINER_ID)) return;
    injectMobileStyle();

    const wrap = document.createElement('div');
    wrap.id = CONTAINER_ID;
    Object.assign(wrap.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '2147483647',
      display: 'flex',
      gap: '8px',
    });

    // Rest-Zaehler des Trainingspools. Im Zen-Modus ist Chessables Tab-Leiste verdeckt —
    // deshalb spiegeln wir die Zahl hierher.
    const poolBadge = document.createElement('button');
    poolBadge.type = 'button';
    poolBadge.id = POOL_ID;
    poolBadge.addEventListener('click', togglePoolPanel);
    Object.assign(poolBadge.style, {
      display: 'none', alignItems: 'center', padding: '6px 9px', borderRadius: '6px',
      background: 'rgba(0,0,0,0.45)', color: '#fff', font: '12px/1 system-ui, sans-serif',
      whiteSpace: 'nowrap', alignSelf: 'center', border: 'none', cursor: 'pointer',
    });
    wrap.appendChild(poolBadge);

    // Zug-Rückmeldung (Overstudied / +XP). Liegt in UNSERER Leiste, weil Chessables eigene
    // Anzeige in `.board-footer` sitzt — im Zen-Modus hinter dem Backdrop. Klick öffnet die
    // Aufschlüsselung der Einzelbeträge dieser Linie.
    const feedbackBadge = document.createElement('button');
    feedbackBadge.id = FEEDBACK_ID;
    feedbackBadge.type = 'button';
    Object.assign(feedbackBadge.style, {
      display: 'none', alignItems: 'center', padding: '6px 10px', border: 'none',
      borderRadius: '6px', color: '#fff', font: '600 12px/1 system-ui, sans-serif',
      cursor: 'pointer', background: 'rgba(0,0,0,0.45)',
    });
    feedbackBadge.addEventListener('click', toggleFeedbackList);

    const copyBtn = document.createElement('button');
    copyBtn.id = COPY_BTN_ID;
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy FEN';
    styleButton(copyBtn, '#2e7d32');
    copyBtn.addEventListener('click', () => {
      const fen = buildFEN();
      if (!fen) { flash(copyBtn, 'No board found', '#c62828'); debugDump(); return; }
      if (copyToClipboard(fen)) {
        flash(copyBtn, 'Copied!', '#1565c0');
        console.log('[RepCheck Chessable]', fen);
      } else {
        flash(copyBtn, 'Copy failed', '#c62828');
        console.log('[RepCheck Chessable] FEN (manual copy):', fen);
      }
    });

    const analyseBtn = document.createElement('button');
    analyseBtn.type = 'button';
    analyseBtn.textContent = 'Analyse';
    analyseBtn.title = 'Stellung in RookHub analysieren (neuer Tab)';
    styleButton(analyseBtn, '#00695c');
    // Geteilt mit dem Zen-Knopf (🔬): identisches Verhalten, nur ein anderes Gehaeuse.
    function openAnalysis(btn) {
      const fen = buildFEN();
      if (!fen) { flash(btn, 'No board found', '#c62828'); debugDump(); return; }
      if (!rookhubBaseUrl) { requestRookhubUrl(); flash(btn, 'Set RookHub URL', '#c62828'); return; }
      const orient = fen.split(' ')[1] === 'b' ? 'black' : 'white';   // Brett aus Sicht der Seite am Zug
      const url = rookhubBaseUrl.replace(/\/$/, '') + '/analysis?fen=' + encodeURIComponent(fen) + '&orientation=' + orient;
      console.log('[RepCheck Chessable Analyse]', fen, '->', url);
      const win = window.open(url, '_blank', 'noopener');
      if (!win) flash(btn, 'Popup blocked', '#c62828');
    }
    analyseBtn.addEventListener('click', () => openAnalysis(analyseBtn));

    const searchBtn = document.createElement('button');
    searchBtn.id = SEARCH_BTN_ID;
    searchBtn.type = 'button';
    searchBtn.textContent = 'Search FEN';
    styleButton(searchBtn, '#1565c0');
    searchBtn.addEventListener('click', () => {
      const fen = buildFEN();
      if (!fen) { flash(searchBtn, 'No board found', '#c62828'); debugDump(); return; }
      const url = chessableSearchUrl(fen);
      console.log('[RepCheck Chessable Search]', fen, '->', url);
      const win = window.open(url, '_blank', 'noopener');
      if (!win) flash(searchBtn, 'Popup blocked', '#c62828');
    });

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.textContent = 'Refresh';
    styleButton(refreshBtn, '#616161');
    refreshBtn.title = 'Seite neu laden';
    refreshBtn.addEventListener('click', () => {
      window.addEventListener('beforeunload', (e) => { e.stopImmediatePropagation(); delete e.returnValue; }, { capture: true, once: true });
      location.reload();
    });

    const rememberBtn = document.createElement('button');
    rememberBtn.type = 'button';
    rememberBtn.textContent = REMEMBER_LABEL;
    styleButton(rememberBtn, '#6a1b9a');
    rememberBtn.title = 'Stellung in RookHub merken';
    rememberBtn.addEventListener('click', () => rememberLine(rememberBtn));

    const fullscreenBtn = document.createElement('button');
    fullscreenBtn.type = 'button';
    fullscreenBtn.textContent = '⛶';   // kompaktes Vollbild-Symbol statt Text-Button
    styleButton(fullscreenBtn, '#37474f');
    Object.assign(fullscreenBtn.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px' });
    fullscreenBtn.title = 'Brett bildschirmfüllend (Esc beendet)';
    fullscreenBtn.addEventListener('click', () => { zenActive() ? exitZen() : enterZen(fullscreenBtn); });

    // Zen-only: ▸ klickt Chessables „Next", 💬 holt die Kommentar-/Zugspalte
    // vor das Backdrop. Außerhalb des Zen-Modus unsichtbar; bewusst NICHT in
    // btnRefs (keine Popup-Toggles dafür).
    const zNext = document.createElement('button');
    zNext.type = 'button';
    zNext.id = 'repcheck-zen-next';
    zNext.textContent = '▸';
    zNext.title = 'Next (nächste Variante/Kapitel)';
    styleButton(zNext, '#2e7d32');
    Object.assign(zNext.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px', display: 'none' });
    zNext.addEventListener('click', () => clickChessableNext(zNext));
    zenNextBtn = zNext;

    // Zen-only: 💡 klickt Chessables eigenen Hint-Knopf (liegt hinterm Backdrop).
    const zHint = document.createElement('button');
    zHint.type = 'button';
    zHint.id = 'repcheck-zen-hint';
    zHint.textContent = '💡';
    zHint.title = 'Hint (Chessable-Tipp)';
    styleButton(zHint, '#f9a825');
    Object.assign(zHint.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px', display: 'none' });
    zHint.addEventListener('click', () => clickChessableHint(zHint));
    zenHintBtn = zHint;

    // Zen-only: 🔬 oeffnet die aktuelle Stellung in der RookHub-Analyse (neuer Tab) —
    // draussen uebernimmt das der beschriftete Analyse-Knopf, im Zen gilt: nur Icons.
    const zAnalyse = document.createElement('button');
    zAnalyse.type = 'button';
    zAnalyse.id = 'repcheck-zen-analyse';
    zAnalyse.textContent = '🔬';
    zAnalyse.title = 'Stellung in RookHub analysieren (neuer Tab)';
    styleButton(zAnalyse, '#00695c');
    Object.assign(zAnalyse.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px', display: 'none' });
    zAnalyse.addEventListener('click', () => openAnalysis(zAnalyse));
    zenAnalyseBtn = zAnalyse;

    const zPanel = document.createElement('button');
    zPanel.type = 'button';
    zPanel.textContent = '💬';
    zPanel.title = 'Kommentare/Züge ein-/ausblenden';
    styleButton(zPanel, '#455a64');
    Object.assign(zPanel.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px', display: 'none' });
    zPanel.addEventListener('click', () => toggleZenPanel(zPanel));
    zenPanelBtn = zPanel;

    // XP-Anzeige vorerst deaktiviert (kommt später wieder) — Badge + Tracker aus.
    btnRefs = { copyFen: copyBtn, analyse: analyseBtn, searchFen: searchBtn, refresh: refreshBtn, remember: rememberBtn, fullscreen: fullscreenBtn };
    wrap.appendChild(feedbackBadge);
    wrap.appendChild(copyBtn);
    wrap.appendChild(analyseBtn);
    wrap.appendChild(searchBtn);
    wrap.appendChild(refreshBtn);
    wrap.appendChild(rememberBtn);
    wrap.appendChild(zHint);
    wrap.appendChild(zAnalyse);
    wrap.appendChild(zPanel);
    wrap.appendChild(zNext);
    wrap.appendChild(fullscreenBtn);
    document.body.appendChild(wrap);
    applyButtonSettings();     // je nach Popup-Einstellung ein-/ausblenden
    requestButtonSettings();   // aktuelle Einstellung aus der isolierten Welt anfordern
    // RookHub-URL aus der isolierten Welt (chessable-activity.js) anfordern, damit der
    // Analyse-Button beim Klick synchron einen neuen Tab öffnen kann (Popup-Blocker-sicher).
    requestRookhubUrl();
  }

  // ---- Pro-Button-Sichtbarkeit (im Popup einstellbar) ----
  // Welche Buttons und Anzeigen der Leiste unten rechts erscheinen, ist im Extension-Popup einzeln
  // umschaltbar (chrome.storage.local `chessableButtons`). Seit v1.59.0 ist ALLES aus, bis es dort
  // jemand einschaltet: nur ein ausdrückliches `true` zeigt ein Element, ein fehlender Schlüssel heißt aus
  // — auch solange die Einstellung noch nicht angekommen ist, damit nichts kurz aufblitzt.
  // chessable-fen.js läuft in der MAIN-World ohne chrome.*-Zugriff → chessable-activity.js (isoliert)
  // spiegelt die Einstellung per postMessage hierher (Same-Window + Same-Origin geprüft; kein Secret).
  let btnRefs = {};
  let buttonSettings = {};
  function buttonEnabled(key) {
    return buttonSettings[key] === true;
  }
  function applyButtonSettings() {
    for (const key of Object.keys(btnRefs)) {
      const btn = btnRefs[key];
      if (btn) btn.style.display = buttonEnabled(key) ? '' : 'none';
    }
    // ⏳-Zaehler und Zug-Rueckmeldung haben eigene Daten und schalten sich selbst (fragen buttonEnabled).
    renderFeedback();
    renderPool();
  }
  function requestButtonSettings() {
    window.postMessage({ __repcheck: 'request-chessable-buttons' }, location.origin);
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__repcheck !== 'chessable-buttons') return;
    const s = e.data.settings;
    if (s && typeof s === 'object') { buttonSettings = Object.assign({}, s); applyButtonSettings(); }
  });

  // Die RookHub-URL liegt extension-privat in chrome.storage.local (nur isolierte Welt lesbar);
  // chessable-activity.js spiegelt sie hierher, damit der Analyse-Button sie synchron im
  // Klick-Handler hat. Nur Same-Window + Same-Origin akzeptieren (Defense-in-Depth; die URL ist
  // kein Secret, der Token bleibt in der isolierten Welt).
  let rookhubBaseUrl = null;
  function requestRookhubUrl() {
    window.postMessage({ __repcheck: 'request-rookhub-url' }, location.origin);
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__repcheck !== 'rookhub-url') return;
    if (typeof e.data.url === 'string' && e.data.url) rookhubBaseUrl = e.data.url;
  });

  // „Remember line": FEN + Kontext per window.postMessage an die isolierte Welt
  // (chessable-activity.js), die den Egress mit RookHub-Config + Background-Worker
  // erledigt — so bleibt der Token aus dem Page-Kontext. postMessage ist der
  // robuste MAIN↔isoliert-Kanal (CustomEvent-detail ist in Firefox heikel).
  const REMEMBER_LABEL = 'Remember line';
  let pendingRememberBtn = null;

  function rememberLine(btn) {
    const fen = buildFEN();
    if (!fen) { flash(btn, 'No board found', '#c62828'); debugDump(); return; }
    pendingRememberBtn = btn;
    btn.textContent = 'Saving…';
    btn.disabled = true;
    window.postMessage({
      __repcheck: 'remember-line',
      fen, courseId: currentCourseId(), sourceUrl: location.href,
    }, location.origin);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__repcheck !== 'remember-line-result') return;
    const btn = pendingRememberBtn;
    pendingRememberBtn = null;
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = REMEMBER_LABEL;
    flash(btn, e.data.ok ? 'Remembered!' : (e.data.error || 'Failed'), e.data.ok ? '#2e7d32' : '#c62828');
  });

  function flash(btn, text, color) {
    const oldText = btn.textContent;
    const oldBg = btn.style.background;
    btn.textContent = text;
    btn.style.background = color;
    setTimeout(() => {
      btn.textContent = oldText;
      btn.style.background = oldBg;
    }, 1200);
  }


  // Seit v1.14.0: die FEN-Tools erscheinen NUR im Practice-Mode
  // (chessable.com/practice/…) — auf Kurs-Übersichten/Buch-Seiten o. Ä. nicht.
  function isPracticeMode() {
    return /^\/practice(\/|$)/.test(location.pathname);
  }

  function removeUi() {
    document.getElementById(CONTAINER_ID)?.remove();
    if (poolTimer) { clearInterval(poolTimer); poolTimer = null; }
    document.getElementById(POOL_PANEL_ID)?.remove();
    feedbackObserver?.disconnect();
    feedbackObserver = null;
    watchedFeedbackRoot = null;
    // Practice-Mode verlassen -> die Linie ist vorbei; Eintraege NICHT in die naechste Sitzung
    // mitschleppen.
    resetLineFeedback();
  }

  function ensureUi() {
    if (!isPracticeMode()) { removeUi(); return; }
    createUi();
    initFeedbackTracker();   // Zug-Rueckmeldung mitschneiden (Overstudied / +XP)
    attachLineResetListener();
    renderPool();
    // Der Tab-Zaehler aendert sich auch ohne Zug (Wechsel Learn/Review, Nachladen) — ruhiger
    // Takt statt eines weiteren Observers auf fremdem DOM.
    if (!poolTimer) poolTimer = setInterval(renderPool, 3000);
  }

  if (document.body) ensureUi();
  else document.addEventListener('DOMContentLoaded', ensureUi, { once: true });

  // UI ueber SPA-Navigationen am Leben halten. Verlaesst der User den
  // Practice-Mode (SPA-Nav), wird die UI wieder entfernt.
  const mo = new MutationObserver(() => {
    if (!isPracticeMode()) { removeUi(); return; }
    if (!document.getElementById(CONTAINER_ID)) ensureUi();
    else initFeedbackTracker();   // Notification-Knoten wird bei SPA-Wechseln ersetzt   // UI steht schon, Brett kommt bei Chessable oft später nach
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Navigations-/UI-Linktexte auf der Practice-/Learn-Seite, die KEIN Kursname sind
  // (z. B. „Practice Moves", „Learn Moves", „Review", „nächstes Kapitel", „Previous variation").
  // Diese Links/Labels zeigen ebenfalls auf /course/{id}/… bzw. beschriften den Modus und haben
  // sonst den echten Titel verdrängt (Beispiel: gemeldeter Kursname „Practice Moves"/„Learn Moves").
  // Keine eigene Kopie mehr: die Liste kommt aus lib/chessable-course-names.js, die das Manifest
  // in DIESER (MAIN-)World vor chessable-fen.js lädt — die frühere Kopie hier hing zurück und
  // ließ „Leaderboard"/„Kapitel N" als Kursname durch. Fehlt die Datei, wird nicht gefiltert
  // (kein Absturz der FEN-Tools); die isolierte Welt filtert den gebridgeten Namen ohnehin nochmal.
  const CourseNames = self.RepCheckCourseNames || {};
  function isNavLabel(txt) {
    return typeof CourseNames.isNavLabel === 'function' ? CourseNames.isNavLabel(txt) : false;
  }

  // Kursname aus den React-Fiber-Props (autoritativ, gleiche Quelle wie die verlässliche Kurs-ID):
  // das `course`-Objekt trägt neben `id` auch `name`/`title`. Deutlich robuster als Seitentext,
  // der im Practice-/Learn-Modus nur das Modus-Label liefert.
  function fiberCourseName(props) {
    if (!props || typeof props !== 'object') return null;
    const candidates = [
      props.course?.name, props.course?.title, props.course?.courseName,
      props.courseName, props.courseTitle,
      props.book?.name, props.book?.title,
    ];
    for (const c of candidates) {
      if (typeof c !== 'string') continue;
      const t = c.replace(/\s+/g, ' ').trim();
      if (t && t.length <= 200 && !isNavLabel(t)) return t;
    }
    return null;
  }

  // Lesbarer Kursname: bevorzugt den echten Titel aus dem React-Fiber; sonst der beschreibendste
  // Kurs-Linktext (Nav-/Modus-Labels werden verworfen), zuletzt document.title.
  function currentCourseName() {
    const anchor = document.getElementById('board') || document.querySelector('[data-square]');
    if (anchor) {
      let fiber = getReactFiber(anchor), depth = 0;
      while (fiber && depth < 60) {
        const n = fiberCourseName(fiber.memoizedProps) || fiberCourseName(fiber.pendingProps);
        if (n) return n;
        fiber = fiber.return; depth++;
      }
    }
    const id = currentCourseId();
    if (id) {
      const candidates = [];
      for (const a of document.querySelectorAll('a[href*="/course/' + id + '/"]')) {
        const txt = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (txt && txt.length <= 200 && !isNavLabel(txt)) candidates.push(txt);
      }
      // Kurstitel ist i. d. R. der längste, beschreibende Linktext (Nav-Labels sind raus).
      if (candidates.length) return candidates.sort((a, b) => b.length - a.length)[0];
    }
    const t = (document.title || '').replace(/\s*[|\-–]\s*Chessable.*$/i, '').trim();
    // Auch der Seitentitel kann ein Nav-Label sein („Leaderboard | Chessable") — sonst landet
    // der als courseName in training-activity/remember-line (gleiche Regel wie in
    // chessable-activity.js).
    return (t && !isNavLabel(t)) ? t : null;
  }

  // Kurs-ID (+ Name) an die isolierte Welt (chessable-activity.js) spiegeln: dort ist der
  // React-Fiber nicht lesbar und die Practice-URL (/practice/…) traegt keine Kurs-ID.
  // Nur bei Aenderung posten (kein Spam); deckt initiales Laden + SPA-Navigation ab.
  let lastBroadcastCourseId = null;
  let lastBroadcastCourseName = null;
  function broadcastCourseId() {
    const id = currentCourseId();
    const name = currentCourseName();
    if (id === lastBroadcastCourseId && name === lastBroadcastCourseName) return;
    lastBroadcastCourseId = id;
    lastBroadcastCourseName = name;
    window.postMessage({ __repcheck: 'course-id', courseId: id, courseName: name }, location.origin);
  }
  broadcastCourseId();
  setInterval(broadcastCourseId, 5000);

  console.log('[RepCheck Chessable] FEN-Tools aktiv');
})();
