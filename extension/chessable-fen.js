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

  // ---------- Points tracker ----------
  //
  // Beobachtet <span data-testid="moveNotification">. Steht da "XP", wird der
  // Wert aus dem Geschwister-<span class="current-points"> gelesen.
  // "Overstudied"/"Incorrect"/"Alternative" werden ignoriert.

  let lastXP = null;
  let pointsObserver = null;
  let watchedNotif = null;

  function initPointsTracker() {
    const notif = document.querySelector('[data-testid="moveNotification"]');
    if (!notif) return;

    if (watchedNotif && watchedNotif !== notif) {
      pointsObserver?.disconnect();
      pointsObserver = null;
    }
    if (pointsObserver) return;
    watchedNotif = notif;

    pointsObserver = new MutationObserver(() => {
      if (notif.textContent.trim() === 'XP') {
        const pointsEl = document.querySelector('span.current-points');
        if (pointsEl) {
          lastXP = pointsEl.textContent.replace(/[\s ]+/g, '');
          updatePointsDisplay();
        }
      }
    });
    pointsObserver.observe(notif, { childList: true, characterData: true, subtree: true });
  }

  function updatePointsDisplay() {
    const el = document.getElementById('repcheck-chessable-last-xp');
    if (!el || !lastXP) return;
    el.textContent = lastXP + ' XP';
    el.style.display = 'inline-block';
  }

  function hidePointsDisplay() {
    const el = document.getElementById('repcheck-chessable-last-xp');
    if (el) el.style.display = 'none';
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

  function createUi() {
    if (document.getElementById(CONTAINER_ID)) return;

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
    refreshBtn.addEventListener('click', () => { location.reload(); });

    const rememberBtn = document.createElement('button');
    rememberBtn.type = 'button';
    rememberBtn.textContent = REMEMBER_LABEL;
    styleButton(rememberBtn, '#6a1b9a');
    rememberBtn.title = 'Stellung in RookHub merken';
    rememberBtn.addEventListener('click', () => rememberLine(rememberBtn));

    const xpBadge = document.createElement('span');
    xpBadge.id = 'repcheck-chessable-last-xp';
    Object.assign(xpBadge.style, {
      display: 'none',
      padding: '8px 10px',
      fontSize: '13px',
      fontWeight: 'bold',
      fontFamily: 'system-ui, sans-serif',
      background: '#f9a825',
      color: '#333',
      borderRadius: '6px',
      boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
      lineHeight: '1',
    });

    wrap.appendChild(xpBadge);
    wrap.appendChild(copyBtn);
    wrap.appendChild(searchBtn);
    wrap.appendChild(refreshBtn);
    wrap.appendChild(rememberBtn);
    document.body.appendChild(wrap);
  }

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
    if (e.source !== window || !e.data || e.data.__repcheck !== 'remember-line-result') return;
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

  // XP zuruecksetzen, wenn der User "Next variation" klickt.
  let nextVarListenerAttached = false;

  function attachNextVariationListener() {
    if (nextVarListenerAttached) return;
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('button, a, [role="button"]');
      if (!btn) return;
      if (/^Next\s*(variation)?$/i.test(btn.textContent.trim())) {
        lastXP = null;
        hidePointsDisplay();
      }
    }, true);
    nextVarListenerAttached = true;
  }

  function ensureUi() {
    createUi();
    initPointsTracker();
    attachNextVariationListener();
    if (lastXP) updatePointsDisplay();
  }

  if (document.body) ensureUi();
  else document.addEventListener('DOMContentLoaded', ensureUi, { once: true });

  // UI ueber SPA-Navigationen am Leben halten; Points-Tracker neu pruefen, weil
  // Chessable das Notification-Element pro Aufgabe ersetzt (alter Observer stirbt).
  const mo = new MutationObserver(() => {
    if (!document.getElementById(CONTAINER_ID)) ensureUi();
    initPointsTracker();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  console.log('[RepCheck Chessable] FEN-Tools aktiv');
})();
