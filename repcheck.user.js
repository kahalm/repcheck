// ==UserScript==
// @name         RepCheck — Opening Repertoire Deviation Checker
// @namespace    https://github.com/kahalm/repcheck
// @version      1.6.0
// @require      https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js
// @description  Shows where your game deviates from your opening repertoire (chess.com + lichess, PGN files or RookHub)
// @author       kahalm
// @homepageURL  https://github.com/kahalm/repcheck
// @supportURL   https://github.com/kahalm/repcheck/issues
// @updateURL    https://raw.githubusercontent.com/kahalm/repcheck/master/repcheck.user.js
// @downloadURL  https://raw.githubusercontent.com/kahalm/repcheck/master/repcheck.user.js
// @icon         https://raw.githubusercontent.com/kahalm/repcheck/master/extension/icons/icon48.png
// @match        https://www.chess.com/*
// @match        https://lichess.org/*
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────
  const IDB_NAME = 'RepertoireCheckerDB';
  const IDB_STORE = 'handles';
  const IDB_KEY = 'repertoireDir';
  // RookHub-Integration: separater Store fuer Config (URL+Token) und Cache.
  const IDB_ROOKHUB_STORE = 'rookhub';
  const IDB_ROOKHUB_CONFIG_KEY = 'config';
  const IDB_ROOKHUB_CACHE_KEY = 'cache';
  const IDB_ROOKHUB_POSITIONS_KEY = 'positionSet';
  const DEVIATION_CLASS = 'repcheck-deviation';
  const GAP_CLASS = 'repcheck-gap';
  const IN_REP_CLASS = 'repcheck-in-rep';
  const BANNER_ID = 'repcheck-banner';
  const PANEL_ID = 'repcheck-panel';
  // Oeffentliche Default-Instanz fuer Erst-Nutzer (Vorbefuellung im Panel +
  // Registrierungs-Link).
  const ROOKHUB_DEFAULT_URL = 'https://rookhub.oberschmid.homes';

  // ─── State ───────────────────────────────────────────────────────────
  let repertoirePositions = null; // Set<string> of normalized FENs (transposition-aware)
  let dirHandle = null;
  let lastUrl = '';
  let currentDeviationIndex = -1;
  let lastGameMovesKey = '';
  let lastDeviationFen = null; // FEN vor dem Out-of-Rep-Zug fuer Chessable-Suche

  // ─── Lightweight PGN Parser ─────────────────────────────────────────
  // Parses PGN move text into a flat list with variation support.
  // Returns array of games, each game = array of moves.
  // Each move = { san: string, variations: [ [move, ...], ... ] }

  function tokenizePgn(movetext) {
    // Remove comments { ... } and ; line comments
    movetext = movetext.replace(/\{[^}]*\}/g, ' ');
    movetext = movetext.replace(/;[^\n]*/g, ' ');
    // Remove NAGs like $1, $2
    movetext = movetext.replace(/\$\d+/g, ' ');
    // Normalize whitespace
    movetext = movetext.replace(/\s+/g, ' ').trim();

    const tokens = [];
    let i = 0;
    while (i < movetext.length) {
      const ch = movetext[i];
      if (ch === '(') { tokens.push('('); i++; }
      else if (ch === ')') { tokens.push(')'); i++; }
      else if (ch === ' ') { i++; }
      else {
        let j = i;
        while (j < movetext.length && movetext[j] !== ' ' && movetext[j] !== '(' && movetext[j] !== ')') j++;
        tokens.push(movetext.substring(i, j));
        i = j;
      }
    }
    return tokens;
  }

  function isMoveToken(token) {
    if (!token || token === '(' || token === ')') return false;
    // Skip move numbers: "1.", "1...", "12."
    if (/^\d+\.+$/.test(token)) return false;
    // Skip results
    if (['1-0', '0-1', '1/2-1/2', '*'].includes(token)) return false;
    // A move token starts with a letter (a-h for pawns, KQRBN for pieces) or O for castling
    return /^[a-hKQRBNO]/.test(token);
  }

  function parseMoveTokens(tokens, pos) {
    // Returns { moves: [...], endPos }
    // Each move: { san, variations: [] }
    const moves = [];
    while (pos < tokens.length) {
      const token = tokens[pos];
      if (token === ')') {
        // End of variation
        return { moves, endPos: pos };
      }
      if (token === '(') {
        // Start of variation — applies to the LAST move's position
        pos++; // skip '('
        const result = parseMoveTokens(tokens, pos);
        pos = result.endPos + 1; // skip ')'
        // Attach variation to the last move before this variation
        if (moves.length > 0) {
          moves[moves.length - 1].variations.push(result.moves);
        }
        continue;
      }
      if (isMoveToken(token)) {
        moves.push({ san: token, variations: [] });
      }
      pos++;
    }
    return { moves, endPos: pos };
  }

  function parsePgnText(text) {
    // Split into games by header blocks
    const games = [];
    // Split on lines starting with [Event or just parse as one big block
    const sections = text.split(/(?=\[Event\s)/);
    for (const section of sections) {
      // Extract movetext (everything after the last header line "]")
      const lines = section.split('\n');
      let movetextLines = [];
      let pastHeaders = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          pastHeaders = false;
          continue;
        }
        if (trimmed === '' && !pastHeaders) {
          pastHeaders = true;
          continue;
        }
        if (pastHeaders || !trimmed.startsWith('[')) {
          movetextLines.push(trimmed);
          pastHeaders = true;
        }
      }
      const movetext = movetextLines.join(' ').trim();
      if (!movetext) continue;

      const tokens = tokenizePgn(movetext);
      const { moves } = parseMoveTokens(tokens, 0);
      if (moves.length > 0) {
        games.push(moves);
      }
    }

    // If no [Event headers found, try parsing the whole text as movetext
    if (games.length === 0 && text.trim()) {
      const tokens = tokenizePgn(text);
      const { moves } = parseMoveTokens(tokens, 0);
      if (moves.length > 0) {
        games.push(moves);
      }
    }

    return games;
  }

  // ─── IndexedDB helpers ───────────────────────────────────────────────
  function openIDB() {
    return new Promise((resolve, reject) => {
      // v2: zusaetzlicher Store fuer RookHub-Config + Cache. onupgradeneeded muss
      // beide Stores anlegen, weil der Upgrade auch beim ersten Anlegen laeuft.
      const req = indexedDB.open(IDB_NAME, 2);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        if (!db.objectStoreNames.contains(IDB_ROOKHUB_STORE)) db.createObjectStore(IDB_ROOKHUB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveHandle(handle) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadHandle() {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  // ─── RookHub IDB Helpers ────────────────────────────────────────────
  async function idbGet(store, key) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(store, key, value) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function loadRookhubConfig() {
    return idbGet(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CONFIG_KEY);
  }

  function saveRookhubConfig(cfg) {
    return idbPut(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CONFIG_KEY, cfg);
  }

  // pgnTexts-Cache (vor 1.6.0): nur noch lesend fuer einmalige Migration zum Position-Set.
  function loadRookhubCache() {
    return idbGet(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CACHE_KEY);
  }

  function loadPositionSetCache() {
    return idbGet(IDB_ROOKHUB_STORE, IDB_ROOKHUB_POSITIONS_KEY);
  }

  function savePositionSetCache(data) {
    return idbPut(IDB_ROOKHUB_STORE, IDB_ROOKHUB_POSITIONS_KEY, data);
  }

  // Baut das Positions-Set aus PGN-Texten und persistiert es. Wird NUR auf
  // explizite Nutzeraktion aufgerufen (Aktualisieren-Button, neuer Ordner,
  // PGN-Text). Auf Page-Loads lesen wir das fertige Set direkt aus IDB.
  async function buildAndSavePositionSet(pgnTexts) {
    const set = buildPositionSetFromPgns(pgnTexts);
    try {
      await savePositionSetCache({ fens: Array.from(set), savedAt: Date.now() });
    } catch (e) {
      console.warn('[RepertoireChecker] Position-Cache nicht schreibbar:', e);
    }
    return set;
  }

  // ─── RookHub Fetch ──────────────────────────────────────────────────
  // Server-seitige Partie-Analyse: kein Vorab-Pull des Repertoires noetig.
  // Endpoint: POST /api/extension/analyze-game mit { moves, kind, refresh }.
  // Antwort: { deviation, gaps, inRepertoire, fenBeforeDeviation, repertoireFileCount, illegalMoveAt }.
  async function rookhubAnalyzeGame(cfg, moves, options) {
    if (!cfg || !cfg.url || !cfg.token) throw new Error('RookHub: URL oder Token fehlt.');
    const url = cfg.url.replace(/\/$/, '') + '/api/extension/analyze-game';
    const resp = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        moves: moves || [],
        kind: 'Opening',
        refresh: !!(options && options.refresh),
      }),
    });
    if (resp.status === 401) throw new Error('Token ungültig oder abgelaufen.');
    if (!resp.ok) throw new Error('RookHub HTTP ' + resp.status);
    return await resp.json();
  }

  // Seit v1.6.0: RookHub-Modus zieht das Repertoire NICHT mehr vorab. Stattdessen
  // wird pro Review-Page ein POST /analyze-game gesendet (Game → Annotations). Hier
  // verifizieren wir nur Auth + zaehlen die Dateien, damit das Panel ein Feedback gibt.
  async function connectRookHub(cfg, options) {
    const refresh = !!(options && options.refresh);
    const result = await rookhubAnalyzeGame(cfg, [], { refresh });
    const fc = result && typeof result.repertoireFileCount === 'number' ? result.repertoireFileCount : 0;
    if (fc === 0) {
      updateStatusText('RookHub: verbunden, aber keine Opening-Repertoires gefunden.');
    } else {
      updateStatusText('RookHub: verbunden (' + fc + ' Datei' + (fc === 1 ? '' : 'en') + ').');
    }
    runCheck();
  }

  // ─── Repertoire Position Set ─────────────────────────────────────────
  // Transpositions: statt Zug-Sequenzen speichern wir alle erreichbaren
  // Stellungen als normalisierte FEN-Strings in einem Set. Zwei Partien,
  // die dieselbe Stellung ueber verschiedene Zugfolgen erreichen, treffen
  // auf denselben FEN-Eintrag.

  function normalizedFen(fen) {
    return fen.split(' ').slice(0, 4).join(' ');
  }

  function walkMovesForPositions(chess, moves, positions) {
    // Wir nutzen denselben Chess-Instanz fuer alle Varianten und stellen den
    // Stand am Ende per undo() wieder her. Ersetzt das alte `new Chess(fen())`
    // pro Variante (FEN-Serialize+Parse-Roundtrip war der Haupt-CPU-Fresser).
    let movesMade = 0;
    for (const move of moves) {
      if (move.variations && move.variations.length > 0) {
        for (const variation of move.variations) {
          walkMovesForPositions(chess, variation, positions);
        }
      }
      const result = chess.move(move.san);
      if (!result) break;
      movesMade++;
      positions.add(normalizedFen(chess.fen()));
    }
    for (let i = 0; i < movesMade; i++) chess.undo();
  }

  function buildPositionSetFromPgns(pgnTexts) {
    const positions = new Set();
    positions.add(normalizedFen(new Chess().fen()));
    for (const text of pgnTexts) {
      try {
        const games = parsePgnText(text);
        for (const moves of games) {
          walkMovesForPositions(new Chess(), moves, positions);
        }
      } catch (e) {
        console.warn('[RepertoireChecker] PGN parse error:', e);
      }
    }
    return positions;
  }

  // ─── File Loading ────────────────────────────────────────────────────
  async function pickDirectory() {
    // Chrome/Edge: use File System Access API
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        await saveHandle(dirHandle);
        await loadRepertoireFromDir();
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.error('[RepertoireChecker] Directory picker error:', e);
        }
      }
      return;
    }
    // Firefox fallback: trigger hidden file input
    pickDirectoryViaInput();
  }

  function pickDirectoryViaInput() {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.multiple = true;
    input.accept = '.pgn';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      loadRepertoireFromFiles(input.files);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  function loadRepertoireFromFiles(fileList) {
    const pgnFiles = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.pgn'));
    if (pgnFiles.length === 0) {
      updateStatusText('No .pgn files found in folder');
      return;
    }

    Promise.all(pgnFiles.map(f => f.text())).then(async pgnTexts => {
      repertoirePositions = await buildAndSavePositionSet(pgnTexts);
      updateStatusText(`Repertoire loaded: ${pgnTexts.length} file(s)`);
      runCheck();
    });
  }

  async function loadRepertoireFromDir() {
    if (!dirHandle) return false;

    const perm = await dirHandle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      const req = await dirHandle.requestPermission({ mode: 'read' });
      if (req !== 'granted') return false;
    }

    const pgnTexts = [];
    for await (const [name, entry] of dirHandle.entries()) {
      if (entry.kind === 'file' && name.toLowerCase().endsWith('.pgn')) {
        try {
          const file = await entry.getFile();
          const text = await file.text();
          pgnTexts.push(text);
        } catch (e) {
          console.warn(`[RepertoireChecker] Could not read ${name}:`, e);
        }
      }
    }

    if (pgnTexts.length > 0) {
      repertoirePositions = await buildAndSavePositionSet(pgnTexts);
      updateStatusText(`Repertoire loaded: ${pgnTexts.length} file(s)`);
      runCheck();
      return true;
    } else {
      updateStatusText('No .pgn files found in folder');
      return false;
    }
  }

  async function loadRepertoireFromText(pgnText) {
    if (!pgnText.trim()) return;
    repertoirePositions = await buildAndSavePositionSet([pgnText]);
    updateStatusText('Repertoire loaded from text');
    runCheck();
  }

  // ─── Site Adapter (chess.com + lichess) ─────────────────────────────
  // Jede Site exportiert dieselbe Schnittstelle: erkennt die Review-Seite,
  // liefert die Zug-Knoten der Hauptlinie und sagt, wohin das Banner soll.
  const LICHESS_FIGURINES = {
    '♔':'K','♕':'Q','♖':'R','♗':'B','♘':'N',
    '♚':'K','♛':'Q','♜':'R','♝':'B','♞':'N',
  };

  const ADAPTERS = {
    chesscom: {
      test: (host) => host === 'www.chess.com' || host.endsWith('.chess.com') || host === 'chess.com',
      isReviewPage: () => {
        const url = location.pathname;
        return url.includes('/analysis/game/') || url.includes('/game/review/');
      },
      getMoveListEl: () => document.querySelector('.move-list, vertical-move-list, wc-move-list'),
      getMoveNodes: (root) => root.querySelectorAll('.node'),
      extractSan: (node) => {
        // node.textContent enthaelt auch Text aus dem inline <style>-Block der
        // SVG-Figurinen, was sonst in den SAN gemischt wird. SVGs entfernen.
        const clone = node.cloneNode(true);
        clone.querySelectorAll('svg, style, script, defs, title').forEach(el => el.remove());
        const visibleText = clone.textContent.trim();
        const figurineEl = node.querySelector('[data-figurine]');
        const figurine = figurineEl ? figurineEl.getAttribute('data-figurine') : '';
        let san = (figurine + visibleText).trim();
        san = san.replace(/^\d+\.+\s*/, '').trim();
        if (['1-0','0-1','1/2-1/2','*'].includes(san)) return '';
        san = san.replace(/[?!]+$/, '').trim();
        return san;
      },
      findBannerContainer: () =>
        document.querySelector('.move-list')?.parentElement ||
        document.querySelector('.analysis-view-movelist')?.parentElement ||
        document.querySelector('.sidebar-container') ||
        document.querySelector('.sidebar-tabbed-content') ||
        document.querySelector('vertical-move-list')?.parentElement,
    },
    lichess: {
      test: (host) => host === 'lichess.org' || host.endsWith('.lichess.org'),
      isReviewPage: () => {
        if (location.pathname.startsWith('/analysis')) return true;
        // Spielseiten: /<id> oder /<id>/(white|black); ID typischerweise 8 Zeichen,
        // bei alten Spielen auch laenger.
        if (/^\/[A-Za-z0-9]{8,12}(\/(white|black))?\/?$/.test(location.pathname)) return true;
        // DOM-Fallback fuer Studies/Broadcasts, falls die Tview2 sichtbar ist.
        return !!document.querySelector('.tview2, .analyse__moves');
      },
      // Wir geben fuer Lichess das eigentliche .tview2 zurueck, damit
      // :scope > move greift (nur Hauptlinie, keine Varianten).
      getMoveListEl: () => document.querySelector('.tview2'),
      getMoveNodes: (root) => root.querySelectorAll(':scope > move'),
      extractSan: (node) => {
        // Lichess kann Figurinen-Notation (Unicode-Symbole statt KQRBN) anzeigen.
        // Mapping zurueck auf SAN-Buchstaben, sonst kann chess.js den Zug nicht
        // parsen. Eval/Glyphen/Kommentare gehoeren nicht in den SAN.
        const clone = node.cloneNode(true);
        clone.querySelectorAll('eval, glyph, comment, interrupt, lines, line').forEach(el => el.remove());
        const raw = clone.textContent.trim();
        let san = '';
        for (const ch of raw) san += LICHESS_FIGURINES[ch] || ch;
        san = san.replace(/^\d+\.+\s*/, '').trim();
        if (['1-0','0-1','1/2-1/2','*'].includes(san)) return '';
        san = san.replace(/[?!]+$/, '').trim();
        return san;
      },
      findBannerContainer: () =>
        document.querySelector('.analyse__moves') ||
        document.querySelector('.tview2')?.parentElement ||
        document.querySelector('.analyse__tools'),
    },
  };

  function getAdapter() {
    const host = location.hostname;
    for (const key of Object.keys(ADAPTERS)) {
      if (ADAPTERS[key].test(host)) return ADAPTERS[key];
    }
    return null;
  }

  function isReviewPage() {
    const a = getAdapter();
    return a ? a.isReviewPage() : false;
  }

  function getGameMoves() {
    const a = getAdapter();
    if (!a) return [];
    const root = a.getMoveListEl();
    if (!root) return [];
    const moves = [];
    for (const node of a.getMoveNodes(root)) {
      const san = a.extractSan(node);
      if (san) moves.push(san);
    }
    return moves;
  }

  function analyzeGame(gameMoves) {
    if (!repertoirePositions) return { deviation: -1, gaps: [] };

    const chess = new Chess();
    const inRep = [];
    for (let i = 0; i < gameMoves.length; i++) {
      const result = chess.move(gameMoves[i]);
      if (!result) { inRep.push(false); break; }
      inRep.push(repertoirePositions.has(normalizedFen(chess.fen())));
    }

    let lastIn = -1;
    for (let i = inRep.length - 1; i >= 0; i--) {
      if (inRep[i]) { lastIn = i; break; }
    }

    const gaps = [];
    const inRepertoire = [];
    let deviation = -1;
    for (let i = 0; i < inRep.length; i++) {
      if (inRep[i]) {
        inRepertoire.push(i);
      } else if (i <= lastIn) {
        gaps.push(i);
      } else if (deviation === -1) {
        deviation = i;
      }
    }
    return { deviation, gaps, inRepertoire };
  }

  // FEN nach den ersten `idx` Zuegen (also VOR Anwendung von gameMoves[idx]).
  // Wird fuer die Chessable-Suche genutzt: zeigt die Position, aus der heraus
  // der erste Out-of-Rep-Zug gespielt wurde.
  function fenBeforeMove(gameMoves, idx) {
    const chess = new Chess();
    for (let i = 0; i < idx && i < gameMoves.length; i++) {
      if (!chess.move(gameMoves[i])) break;
    }
    return chess.fen();
  }

  function chessableSearchUrl(fen) {
    // Globale Chessable-FEN-Suche: "/" wird zu "U", " " zu "%20" (chessable-
    // spezifische Kodierung, KEIN encodeURIComponent).
    const encoded = fen.replace(/\//g, 'U').replace(/ /g, '%20');
    return 'https://www.chessable.com/courses/fen/' + encoded + '/';
  }

  // ─── UI ─────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('repcheck-styles')) return;
    const style = document.createElement('style');
    style.id = 'repcheck-styles';
    style.textContent = `
      .${DEVIATION_CLASS} {
        background-color: rgba(255, 120, 50, 0.45) !important;
        border-radius: 3px;
        outline: 2px solid rgba(255, 80, 20, 0.7);
      }
      .${GAP_CLASS} {
        background-color: rgba(255, 210, 50, 0.35) !important;
        border-radius: 3px;
        outline: 2px solid rgba(200, 160, 0, 0.6);
      }
      .${IN_REP_CLASS} {
        background-color: rgba(46, 204, 113, 0.25) !important;
        border-radius: 3px;
        outline: 2px solid rgba(39, 174, 96, 0.5);
      }
      #${BANNER_ID} {
        position: relative;
        z-index: 100;
        padding: 8px 12px;
        font-size: 13px;
        font-weight: 600;
        text-align: center;
        border-radius: 4px;
        margin: 6px 8px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #${BANNER_ID}.deviation {
        background: linear-gradient(135deg, #ff6b35, #e04800);
        color: #fff;
      }
      #${BANNER_ID}.in-repertoire {
        background: linear-gradient(135deg, #2ecc71, #27ae60);
        color: #fff;
      }
      #${BANNER_ID}.no-repertoire {
        background: #3a3a3a;
        color: #aaa;
      }
      #${PANEL_ID} {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 10000;
        background: #2b2b2b;
        color: #e0e0e0;
        border: 1px solid #555;
        border-radius: 8px;
        padding: 20px;
        width: 420px;
        max-height: 80vh;
        overflow-y: auto;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
      }
      #${PANEL_ID} h3 {
        margin: 0 0 12px 0;
        font-size: 16px;
        color: #fff;
      }
      #${PANEL_ID} button {
        background: #4a9eff;
        color: #fff;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        margin: 4px 4px 4px 0;
      }
      #${PANEL_ID} button:hover {
        background: #3a8eef;
      }
      #${PANEL_ID} button.secondary {
        background: #555;
      }
      #${PANEL_ID} button.secondary:hover {
        background: #666;
      }
      #${PANEL_ID} textarea {
        width: 100%;
        height: 150px;
        background: #1a1a1a;
        color: #e0e0e0;
        border: 1px solid #555;
        border-radius: 4px;
        padding: 8px;
        font-family: monospace;
        font-size: 12px;
        resize: vertical;
        box-sizing: border-box;
      }
      #${PANEL_ID} .status {
        font-size: 12px;
        color: #aaa;
        margin-top: 8px;
      }
      #repcheck-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5);
        z-index: 9999;
      }
      #repcheck-gear {
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 4px;
        font-size: 16px;
        margin-left: 8px;
        vertical-align: middle;
        background: transparent;
        border: none;
        color: #aaa;
        padding: 0;
      }
      #repcheck-gear:hover {
        background: rgba(255,255,255,0.1);
        color: #fff;
      }
      #repcheck-floating-wrap {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 9998;
        display: flex;
        flex-direction: column;
        gap: 8px;
        align-items: stretch;
      }
      #repcheck-floating, #repcheck-chessable {
        cursor: pointer;
        border: none;
        border-radius: 6px;
        padding: 8px 14px;
        font-size: 13px;
        font-weight: 600;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 2px 8px rgba(0,0,0,0.35);
        color: #fff;
      }
      #repcheck-floating { background: #2a8c4a; }
      #repcheck-floating:hover { background: #36a85a; }
      #repcheck-floating:active { background: #1f7a3d; }
      #repcheck-chessable { background: #d04a3e; }
      #repcheck-chessable:hover { background: #e85a4e; }
      #repcheck-chessable:active { background: #b03a2f; }
    `;
    document.head.appendChild(style);
  }

  function ensureFloatingWrap() {
    if (!document.body) return null;
    let wrap = document.getElementById('repcheck-floating-wrap');
    if (!wrap) {
      injectStyles();
      wrap = document.createElement('div');
      wrap.id = 'repcheck-floating-wrap';
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  function injectFloatingButton() {
    const wrap = ensureFloatingWrap();
    if (!wrap) return;
    if (document.getElementById('repcheck-floating')) return;
    const btn = document.createElement('button');
    btn.id = 'repcheck-floating';
    btn.type = 'button';
    btn.textContent = '♟ Prüfen';
    btn.title = 'Aktuelle Partie gegen Repertoire pruefen';
    btn.addEventListener('click', runCheckTrigger);
    wrap.appendChild(btn);
  }

  // Chessable-Button: nur sichtbar wenn eine Abweichung erkannt wurde.
  // Klick oeffnet Chessable mit der FEN VOR dem Out-of-Rep-Zug.
  function syncChessableButton() {
    const wrap = document.getElementById('repcheck-floating-wrap');
    let btn = document.getElementById('repcheck-chessable');
    if (!lastDeviationFen) {
      btn?.remove();
      return;
    }
    if (!wrap) return;
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'repcheck-chessable';
      btn.type = 'button';
      btn.textContent = '🔎 Chessable';
      btn.title = 'FEN vor Abweichung in Chessable suchen';
      btn.addEventListener('click', () => {
        if (!lastDeviationFen) return;
        window.open(chessableSearchUrl(lastDeviationFen), '_blank', 'noopener,noreferrer');
      });
      wrap.insertBefore(btn, wrap.firstChild);
    }
  }

  function removeFloatingControls() {
    document.getElementById('repcheck-floating-wrap')?.remove();
  }

  function refreshFloatingButton() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastDeviationFen = null;
      lastGameMovesKey = '';
    }
    if (isReviewPage()) {
      injectFloatingButton();
      syncChessableButton();
    } else {
      removeFloatingControls();
    }
  }

  function updateStatusText(text) {
    const el = document.getElementById('repcheck-status');
    if (el) el.textContent = text;
  }

  function showBanner(message, type) {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      const a = getAdapter();
      const moveListContainer = a ? a.findBannerContainer() : null;

      if (!moveListContainer) return;

      banner = document.createElement('div');
      banner.id = BANNER_ID;

      const gear = document.createElement('button');
      gear.id = 'repcheck-gear';
      gear.textContent = '\u2699';
      gear.title = 'Repertoire Settings';
      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanel();
      });

      const wrapper = document.createElement('div');
      wrapper.style.display = 'flex';
      wrapper.style.alignItems = 'center';
      wrapper.style.justifyContent = 'center';

      const span = document.createElement('span');
      span.id = 'repcheck-banner-text';

      wrapper.appendChild(span);
      wrapper.appendChild(gear);
      banner.appendChild(wrapper);

      moveListContainer.insertBefore(banner, moveListContainer.firstChild);
    }

    const textEl = banner.querySelector('#repcheck-banner-text') || banner;
    textEl.textContent = message;
    banner.className = type;
  }

  function highlightDeviation(index, gaps, inRepertoire) {
    document.querySelectorAll(`.${DEVIATION_CLASS}`).forEach(el => el.classList.remove(DEVIATION_CLASS));
    document.querySelectorAll(`.${GAP_CLASS}`).forEach(el => el.classList.remove(GAP_CLASS));
    document.querySelectorAll(`.${IN_REP_CLASS}`).forEach(el => el.classList.remove(IN_REP_CLASS));

    const a = getAdapter();
    if (!a) return;
    const moveList = a.getMoveListEl();
    if (!moveList) return;
    const nodes = a.getMoveNodes(moveList);

    if (inRepertoire) {
      for (const ri of inRepertoire) {
        if (ri < nodes.length) nodes[ri].classList.add(IN_REP_CLASS);
      }
    }
    if (gaps) {
      for (const gi of gaps) {
        if (gi < nodes.length) nodes[gi].classList.add(GAP_CLASS);
      }
    }
    if (index >= 0 && index < nodes.length) {
      nodes[index].classList.add(DEVIATION_CLASS);
      nodes[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function togglePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      existing.remove();
      document.getElementById('repcheck-overlay')?.remove();
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'repcheck-overlay';
    overlay.addEventListener('click', togglePanel);
    document.body.appendChild(overlay);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;

    // RookHub-Config zum Vorbefuellen der Felder laden (async, dann DOM updaten).
    // Wenn noch keine Config vorhanden, mit der oeffentlichen Default-Instanz
    // vorbelegen, damit Neu-User nicht erst eine URL suchen muessen.
    loadRookhubConfig().then(cfg => {
      const urlInput = document.getElementById('repcheck-rookhub-url');
      const tokenInput = document.getElementById('repcheck-rookhub-token');
      if (urlInput) urlInput.value = (cfg && cfg.url) || ROOKHUB_DEFAULT_URL;
      if (cfg && tokenInput) tokenInput.value = cfg.token || '';
    }).catch(() => {
      const urlInput = document.getElementById('repcheck-rookhub-url');
      if (urlInput && !urlInput.value) urlInput.value = ROOKHUB_DEFAULT_URL;
    });

    panel.innerHTML = `
      <h3>Repertoire Settings</h3>
      <div style="margin-bottom: 12px;">
        <strong>RookHub:</strong><br>
        <input id="repcheck-rookhub-url" placeholder="https://rookhub.example.com" />
        <input id="repcheck-rookhub-token" placeholder="rkh_…" type="password" />
        <div style="margin-top:6px;">
          <button id="repcheck-rookhub-connect">Verbinden</button>
          <button id="repcheck-rookhub-refresh" class="secondary">Aktualisieren</button>
        </div>
        <span style="font-size:11px;color:#888;">
          Noch kein Konto? <a href="${ROOKHUB_DEFAULT_URL}/register" target="_blank" rel="noopener" style="color:#4a9eff;">Auf ${ROOKHUB_DEFAULT_URL.replace(/^https?:\/\//,'')} registrieren</a> · Token dann unter Profil → „Extension-Tokens" erstellen.
        </span>
      </div>
      <hr style="border-color:#444;margin:12px 0;">
      <div style="margin-bottom: 12px;">
        <strong>Load from folder:</strong><br>
        <button id="repcheck-pick-dir">Select PGN Folder</button>
        <span id="repcheck-folder-info" style="font-size:12px;color:#888;margin-left:6px;">${repertoirePositions ? '(loaded)' : '(no folder selected)'}</span>
      </div>
      <hr style="border-color:#444;margin:12px 0;">
      <div>
        <strong>Or paste PGN:</strong><br>
        <textarea id="repcheck-pgn-input" placeholder="Paste your repertoire PGN here..."></textarea>
        <button id="repcheck-load-pgn">Load PGN</button>
        <button id="repcheck-close" class="secondary">Close</button>
      </div>
      <div class="status" id="repcheck-status">
        ${repertoirePositions ? 'Repertoire loaded' : 'No repertoire loaded'}
      </div>
    `;

    document.body.appendChild(panel);

    document.getElementById('repcheck-pick-dir')?.addEventListener('click', async () => {
      await pickDirectory();
    });

    document.getElementById('repcheck-load-pgn').addEventListener('click', () => {
      const textarea = document.getElementById('repcheck-pgn-input');
      loadRepertoireFromText(textarea.value);
    });

    document.getElementById('repcheck-close').addEventListener('click', togglePanel);

    document.getElementById('repcheck-rookhub-connect')?.addEventListener('click', async () => {
      const url = (document.getElementById('repcheck-rookhub-url').value || '').trim();
      const token = (document.getElementById('repcheck-rookhub-token').value || '').trim();
      if (!url || !token) { updateStatusText('RookHub: URL und Token erforderlich.'); return; }
      try {
        await saveRookhubConfig({ url, token });
        updateStatusText('RookHub: verbinde…');
        await connectRookHub({ url, token });
      } catch (e) {
        updateStatusText('RookHub: ' + e.message);
      }
    });

    document.getElementById('repcheck-rookhub-refresh')?.addEventListener('click', async () => {
      const cfg = await loadRookhubConfig();
      if (!cfg) { updateStatusText('RookHub: noch nicht konfiguriert.'); return; }
      try {
        updateStatusText('RookHub: aktualisiere…');
        await connectRookHub(cfg, { refresh: true });
        // Lokales Set wird nicht mehr genutzt, sobald RookHub konfiguriert ist.
        lastGameMovesKey = '';
      } catch (e) {
        updateStatusText('RookHub: ' + e.message);
      }
    });
  }

  // ─── Main Check Logic ───────────────────────────────────────────────
  // Source-Priority: RookHub-Config vorhanden \u2192 Server-seitige Analyse (POST analyze-game).
  // Sonst lokales Position-Set (Folder/PGN-Paste). Bei RookHub-Fehler fallback aufs
  // lokale Set, falls vorhanden (Offline-Modus).
  function renderAnalysis(gameMoves, analysis) {
    const deviationIdx = analysis.deviation;
    const gaps = analysis.gaps || [];
    const inRepertoire = analysis.inRepertoire || [];
    currentDeviationIndex = deviationIdx;
    lastDeviationFen = analysis.fenBeforeDeviation
      || (deviationIdx >= 0 ? fenBeforeMove(gameMoves, deviationIdx) : null);

    if (deviationIdx >= 0) {
      const moveNum = Math.floor(deviationIdx / 2) + 1;
      const color = deviationIdx % 2 === 0 ? 'White' : 'Black';
      const gapInfo = gaps.length > 0 ? ` (${gaps.length} Zugumstellung${gaps.length > 1 ? 'en' : ''})` : '';
      showBanner(`Out of repertoire at move ${moveNum} (${color}: ${gameMoves[deviationIdx]})${gapInfo}`, 'deviation');
      highlightDeviation(deviationIdx, gaps, inRepertoire);
    } else if (gaps.length > 0) {
      showBanner(`Im Repertoire \u2713 (${gaps.length} Zugumstellung${gaps.length > 1 ? 'en' : ''})`, 'in-repertoire');
      highlightDeviation(-1, gaps, inRepertoire);
    } else {
      showBanner('Game fully within repertoire \u2713', 'in-repertoire');
      highlightDeviation(-1, [], inRepertoire);
    }
    syncChessableButton();
  }

  async function runCheck() {
    if (!isReviewPage()) return;
    const gameMoves = getGameMoves();
    if (gameMoves.length === 0) {
      showBanner('No moves found', 'no-repertoire');
      return;
    }
    const key = gameMoves.join('\x00');
    if (key === lastGameMovesKey) return;
    lastGameMovesKey = key;

    const cfg = await loadRookhubConfig().catch(() => null);
    if (cfg && cfg.url && cfg.token) {
      try {
        const analysis = await rookhubAnalyzeGame(cfg, gameMoves);
        renderAnalysis(gameMoves, analysis);
        return;
      } catch (e) {
        console.warn('[RepertoireChecker] RookHub analyze failed:', e);
        if (!repertoirePositions) {
          showBanner('RookHub: ' + e.message, 'no-repertoire');
          return;
        }
        // Fallback aufs lokale Set (Offline / Cache aus frueherer Session).
      }
    }

    if (!repertoirePositions) {
      showBanner('No repertoire loaded \u2014 click \u2699 to set up', 'no-repertoire');
      return;
    }
    renderAnalysis(gameMoves, analyzeGame(gameMoves));
  }

  // ─── Lazy bootstrap (nur bei Klick) ─────────────────────────────────
  // Seit v1.4.8: keine Auto-Initialisierung beim Page-Load. Userscript
  // registriert nur GM-Menu-Eintraege; die echte Arbeit (IDB lesen,
  // Styles injecten, Check) passiert erst beim Klick.
  let bootstrapped = false;
  async function ensureBootstrapped() {
    if (bootstrapped) return;
    bootstrapped = true;
    injectStyles();

    try {
      const cached = await loadPositionSetCache();
      if (cached && Array.isArray(cached.fens) && cached.fens.length > 0) {
        repertoirePositions = new Set(cached.fens);
        return;
      }
    } catch (e) {
      console.log('[RepertoireChecker] Position-Cache nicht lesbar:', e);
    }
    // Migration aus altem pgnTexts-Cache, falls noch vorhanden.
    try {
      const rh = await loadRookhubCache();
      if (rh && Array.isArray(rh.pgnTexts) && rh.pgnTexts.length > 0) {
        repertoirePositions = await buildAndSavePositionSet(rh.pgnTexts);
        return;
      }
    } catch (e) {
      console.log('[RepertoireChecker] RookHub-PGN-Cache nicht lesbar:', e);
    }
    // Folder-Handle als letzter Fallback.
    try {
      dirHandle = await loadHandle();
      if (dirHandle) {
        await loadRepertoireFromDir();
      }
    } catch (e) {
      console.log('[RepertoireChecker] No saved directory handle:', e);
    }
  }

  async function runCheckTrigger() {
    await ensureBootstrapped();
    lastGameMovesKey = '';
    runCheck();
  }

  async function openSettingsTrigger() {
    await ensureBootstrapped();
    if (!document.getElementById(PANEL_ID)) togglePanel();
  }

  // Tampermonkey/Greasemonkey-Menue: erscheint im Klick-Menue des
  // TM-Icons. Das ist der EINZIGE automatische Eingriff des Userscripts
  // beim Page-Load.
  if (typeof GM_registerMenuCommand !== 'undefined') {
    GM_registerMenuCommand('♟ Prüfen', runCheckTrigger);
    GM_registerMenuCommand('⚙ Einstellungen', openSettingsTrigger);
  }

  // ─── Lightweight SPA-Navigation Watch ───────────────────────────────
  // Beobachtet NUR den <title>-Knoten und popstate-Events. Praktisch
  // kostenlos im Idle. Bei jeder Navigation: Floating-Button nur auf
  // Review-Seiten zeigen.
  function watchNavigation() {
    const observe = () => {
      const titleEl = document.querySelector('title');
      if (!titleEl) {
        setTimeout(observe, 250);
        return;
      }
      new MutationObserver(refreshFloatingButton).observe(titleEl, { childList: true });
    };
    observe();
    window.addEventListener('popstate', refreshFloatingButton);
  }

  watchNavigation();
  refreshFloatingButton();

  console.log('[RepertoireChecker] Userscript v1.6.0 loaded');
})();
