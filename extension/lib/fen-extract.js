// FEN der angezeigten Chessable-Stellung (Zerlegung Z38, bis v1.73.1 in chessable-fen.js): bevorzugt aus den
// React-Fiber-Props des Bretts (`fen`/`interactiveFen` — nur dort stehen Zugrecht, Rochade, Zugzaehler korrekt), sonst
// aus dem cm-chessboard-DOM ([data-square]/[data-piece]), zuletzt aus chessground (Legacy). `document` wird erst beim
// Aufruf gelesen; kein Zustand.
//
// Laeuft in der MAIN-World (React-Fiber-Expandos sind in der isolierten Welt nicht lesbar): per Manifest VOR
// chessable-fen.js geladen → `self.RepCheckFenExtract` (der einzige Name im window der Seite, wie bei den anderen
// Libs). In Node (Tests) als Modul. Golden: test/chessable-fen-extract.test.js.

(function (root) {
  'use strict';

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

  // ─── Export ──────────────────────────────────────────────────────────
  const api = {
    CM_PIECE_TO_FEN, CG_PIECE_TO_FEN, FEN_REGEX, isValidFen, getReactFiber, collectFenCandidates, extractFenFromReact,
    extractBoardCm, parseTranslate, extractBoardCg, placementFromGrid, extractBoard, detectSideToMove, buildFEN,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RepCheckFenExtract = api;
})(typeof self !== 'undefined' ? self : this);
