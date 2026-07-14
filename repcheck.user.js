// ==UserScript==
// @name         RepCheck — Opening Repertoire Deviation Checker
// @namespace    https://github.com/kahalm/repcheck
// @version      1.32.0
// @require      https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js
// @description  Shows where your game deviates from your opening repertoire (chess.com + lichess, PGN files or RookHub). On chessable.com: copy/search FEN, remember a line to RookHub, show earned XP, report active training time to RookHub, read the API token.
// @author       kahalm
// @homepageURL  https://github.com/kahalm/repcheck
// @supportURL   https://github.com/kahalm/repcheck/issues
// @updateURL    https://raw.githubusercontent.com/kahalm/repcheck/master/repcheck.user.js
// @downloadURL  https://raw.githubusercontent.com/kahalm/repcheck/master/repcheck.user.js
// @icon         https://raw.githubusercontent.com/kahalm/repcheck/master/extension/icons/icon48.png
// @match        https://www.chess.com/*
// @match        https://lichess.org/*
// @match        https://www.chessable.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
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

  // ─── Shared Core: reine PGN-/FEN-Helfer ────────────────────────────
  // GENERIERT aus extension/lib/repertoire-text.js via `npm run build:userscript`
  // (build/assemble.mjs). NICHT VON HAND EDITIEREN — Logik in lib/ ändern + neu bauen.
  // >>>REPCHECK-SHARED:repertoire-text
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

  function normalizedFen(fen) {
    // Nur die ersten 4 Felder (Stellung, Seite, Rochaderechte, en-passant).
    // Halbzug- und Vollzugzaehler spielen fuer Repertoire-Matching keine Rolle.
    return fen.split(' ').slice(0, 4).join(' ');
  }

  function chessComPlayedAt(h) {
    if (!h || !h.Date || !/^\d{4}\.\d{2}\.\d{2}$/.test(h.Date)) return null;
    const tm = (h.EndTime || '').match(/(\d{2}):(\d{2}):(\d{2})/);
    const time = tm ? `${tm[1]}:${tm[2]}:${tm[3]}` : '00:00:00';
    const d = new Date(`${h.Date.replace(/\./g, '-')}T${time}Z`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function chessableSearchUrl(fen) {
    // Globale Chessable-FEN-Suche: "/" wird zu "U", " " zu "%20" (chessable-
    // spezifische Kodierung, KEIN encodeURIComponent).
    const encoded = fen.replace(/\//g, 'U').replace(/ /g, '%20');
    return 'https://www.chessable.com/courses/fen/' + encoded + '/';
  }
  // <<<REPCHECK-SHARED:repertoire-text

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

  // Config laden. Der TOKEN kommt aus dem GM-Storage (Tampermonkey-Sandbox, NICHT
  // seiten-lesbar), nicht aus der IndexedDB: die IDB liegt auf dem
  // chess.com/lichess-Origin und wäre für Host-/XSS-Skripte lesbar; ein dort
  // abgelegter Token wäre exfiltrierbar. Legacy-Migration: ein noch im IDB
  // liegender Token wird einmalig nach GM gehoben und aus dem IDB entfernt (dort
  // bleibt nur die URL).
  async function loadRookhubConfig() {
    let gm = null;
    try { if (typeof GM_getValue !== 'undefined') gm = GM_getValue('rookhubConfig', null); } catch (e) {}
    if (gm && gm.url && gm.token) return gm;

    const legacy = await idbGet(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CONFIG_KEY).catch(() => null);
    if (legacy && legacy.url && legacy.token) {
      try { if (typeof GM_setValue !== 'undefined') GM_setValue('rookhubConfig', { url: legacy.url, token: legacy.token }); } catch (e) {}
      try { await idbPut(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CONFIG_KEY, { url: legacy.url }); } catch (e) {}
      return { url: legacy.url, token: legacy.token };
    }
    if (gm && gm.url) return gm;
    return (legacy && legacy.url) ? { url: legacy.url } : null;
  }

  function saveRookhubConfig(cfg) {
    // Token NUR im GM-Storage (Tampermonkey-Sandbox, origin-übergreifend, nicht
    // seiten-lesbar) — das Chessable-Activity-Tracking liest URL+Token von dort
    // (GM_getValue). In die origin-scoped IndexedDB (chess.com/lichess, für
    // Host-Skripte lesbar) kommt bewusst NUR die URL — nie der Token.
    try {
      if (typeof GM_setValue !== 'undefined' && cfg && cfg.url && cfg.token) {
        GM_setValue('rookhubConfig', { url: cfg.url, token: cfg.token });
      }
    } catch (e) { /* GM-Storage nicht verfuegbar — ignorieren */ }
    return idbPut(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CONFIG_KEY, { url: cfg && cfg.url });
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

  // Schickt die SAN-Zugliste + Best-Effort-Metadaten; der Server baut daraus das PGN
  // (reicheres Format als ein vorgebautes PGN: Spieler/Ergebnis/Game-ID für Dedup + Anzeige).
  async function rookhubSaveGame(cfg, moves, meta) {
    if (!cfg || !cfg.url || !cfg.token) throw new Error('RookHub: URL oder Token fehlt.');
    const url = cfg.url.replace(/\/$/, '') + '/api/extension/games';
    const resp = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: meta.source,
        moves: moves,
        externalId: meta.externalId,
        white: meta.white,
        black: meta.black,
        result: meta.result,
        sourceUrl: meta.sourceUrl,
        playedAt: meta.playedAt,
        whiteElo: meta.whiteElo,
        blackElo: meta.blackElo,
      }),
    });
    if (resp.status === 401) throw new Error('Token ungültig oder abgelaufen.');
    if (!resp.ok) throw new Error('RookHub HTTP ' + resp.status);
    return resp.json().catch(() => null);
  }

  // Öffentlicher Teilen-Link der gespeicherten Partie ({url}/g/{shareToken}).
  // saved = Server-Antwort von rookhubSaveGame (SavedGameDetailDto).
  function buildShareLink(cfg, saved) {
    const token = saved && (saved.shareToken || saved.ShareToken);
    if (!cfg || !cfg.url || !token) return '';
    return cfg.url.replace(/\/$/, '') + '/g/' + token;
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

  // normalizedFen: siehe Shared-Core-Region oben (aus lib/repertoire-text.js).

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

  function buildGamePgn() {
    const moves = getGameMoves();
    if (!moves.length) return '';
    let moveText = '';
    for (let i = 0; i < moves.length; i++) {
      if (i % 2 === 0) moveText += (Math.floor(i / 2) + 1) + '. ';
      moveText += moves[i] + ' ';
    }
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    return '[Event "?"]\n[Site "' + location.href + '"]\n[Date "' + date + '"]\n[White "?"]\n[Black "?"]\n[Result "*"]\n\n' + moveText.trimEnd() + ' *\n';
  }

  async function copyGamePgn() {
    const pgn = buildGamePgn();
    if (!pgn) return;
    try {
      await navigator.clipboard.writeText(pgn);
      const btn = document.getElementById('repcheck-copy-pgn');
      if (btn) { const t = btn.textContent; btn.textContent = '✓'; setTimeout(() => { btn.textContent = t; }, 1200); }
    } catch (e) {
      console.warn('[RepertoireChecker] Clipboard:', e);
    }
  }

  // ─── Metadaten fürs Speichern ───────────────────────────────────────
  // Ergebnis (1-0/0-1/1/2-1/2) aus der Zugliste lesen, falls vorhanden.
  function getGameResult() {
    try {
      const a = getAdapter();
      const root = a && a.getMoveListEl();
      const text = (root ? root.textContent : '') || '';
      const m = text.match(/(1-0|0-1|1\/2-1\/2|½-½)/);
      if (!m) return null;
      return m[1] === '½-½' ? '1/2-1/2' : m[1];
    } catch (e) { return null; }
  }

  // Elo/Rating plausibilisieren (100–4000); sonst null.
  function parseElo(v) {
    const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) && n >= 100 && n <= 4000 ? n : null;
  }

  // Name + optionales trailing "(Rating)" trennen (Lichess-og:title: "Name (1234)").
  function splitNameElo(raw) {
    const s = (raw || '').trim();
    const m = s.match(/^(.*?)\s*\((\d{2,4})\)\s*$/);
    if (m) return { name: m[1].trim().slice(0, 120), elo: parseElo(m[2]) };
    return { name: s.slice(0, 120), elo: null };
  }

  // Spielernamen + Ratings aus og:title / document.title ("A (1234) vs B (1456)") best-effort lesen.
  function parsePlayersFromMeta() {
    try {
      const og = document.querySelector('meta[property="og:title"]');
      const t = (og && og.content) || document.title || '';
      const m = t.match(/(.+?)\s+(?:vs\.?|–|-)\s+(.+?)(?:\s+(?:in|•|\||,)|$)/i);
      if (m) {
        const w = splitNameElo(m[1]);
        const b = splitNameElo(m[2]);
        return { white: w.name, black: b.name, whiteElo: w.elo, blackElo: b.elo };
      }
    } catch (e) {}
    return { white: null, black: null, whiteElo: null, blackElo: null };
  }

  // chessComPlayedAt: siehe Shared-Core-Region oben (aus lib/repertoire-text.js).

  // Kanonische Header (Spieler/Ergebnis/Datum) zu einer chess.com-Game-ID über
  // die same-origin-Callback-API holen — die Analyse-Seite hat sie NICHT im
  // og:title. Best-effort: bei Fehler null, dann greift der og:title-Fallback.
  async function fetchChessComHeaders(id, isDaily) {
    try {
      const kind = isDaily ? 'daily' : 'live';
      const resp = await fetch(`https://www.chess.com/callback/${kind}/game/${id}`, { headers: { 'Accept': 'application/json' } });
      if (!resp.ok) return null;
      const data = await resp.json();
      const h = data && data.game && data.game.pgnHeaders;
      if (!h) return null;
      return {
        white: h.White ? String(h.White).slice(0, 120) : null,
        black: h.Black ? String(h.Black).slice(0, 120) : null,
        result: h.Result || null,
        playedAt: chessComPlayedAt(h),
        whiteElo: parseElo(h.WhiteElo),
        blackElo: parseElo(h.BlackElo),
      };
    } catch (e) { return null; }
  }

  // Kanonische Partie-Daten (Spieler/Ergebnis/Elo/Datum + saubere SAN-Zugliste) zu einer
  // lichess-Game-ID über die same-origin Export-API holen. Zuverlässiger als der og:title
  // (Namen/Elo) UND die DOM-Zugauslese (die auf Analyse-/Study-Ansichten „…"-Lücken liefern
  // kann). Best-effort: bei Fehler null, dann greifen og:title + DOM-Züge als Fallback.
  async function fetchLichessGame(id) {
    try {
      const resp = await fetch(`https://lichess.org/game/export/${id}?clocks=false&evals=false&literate=false`,
        { headers: { 'Accept': 'application/x-chess-pgn' } });
      if (!resp.ok) return null;
      const pgn = await resp.text();
      if (!pgn || /^\s*</.test(pgn)) return null;   // HTML statt PGN → aufgeben
      const hdr = (tag) => { const m = pgn.match(new RegExp('\\[' + tag + ' "([^"]*)"\\]')); return m ? m[1] : null; };
      let result = hdr('Result');
      if (result !== '1-0' && result !== '0-1' && result !== '1/2-1/2') result = null;
      const games = (typeof parsePgnText === 'function') ? parsePgnText(pgn) : [];
      // parsePgnText liefert Zug-OBJEKTE ({san, variations}); der Save braucht SAN-Strings.
      const moves = (games && games[0] && games[0].length)
        ? games[0].map(m => (typeof m === 'string' ? m : m && m.san)).filter(Boolean)
        : null;
      return {
        white: hdr('White') ? hdr('White').slice(0, 120) : null,
        black: hdr('Black') ? hdr('Black').slice(0, 120) : null,
        result,
        whiteElo: parseElo(hdr('WhiteElo')),
        blackElo: parseElo(hdr('BlackElo')),
        playedAt: chessComPlayedAt({ Date: hdr('UTCDate'), EndTime: hdr('UTCTime') }),
        moves,
      };
    } catch (e) { return null; }
  }

  // Metadaten der aktuellen Partie (Quelle, externe ID, Spieler, Ergebnis, URL).
  // Async, weil chess.com die Spielernamen erst per Callback-API liefert.
  async function getGameMeta() {
    const site = detectSiteKey();
    const meta = {
      source: site === 'chesscom' ? 'chess.com' : 'lichess',
      externalId: null,
      result: getGameResult(),
      sourceUrl: location.href,
      white: null,
      black: null,
      playedAt: null,
      whiteElo: null,
      blackElo: null,
      moves: null,
    };
    try {
      if (site === 'lichess') {
        const m = location.pathname.match(/^\/([A-Za-z0-9]{8})/);
        if (m) meta.externalId = m[1];
      } else {
        const m = location.pathname.match(/\/(?:live|daily|game|analysis\/game\/live)\/(\d+)/)
          || location.pathname.match(/(\d{6,})/);
        if (m) meta.externalId = m[1];
      }
    } catch (e) {}
    const players = parsePlayersFromMeta();
    meta.white = players.white;
    meta.black = players.black;
    meta.whiteElo = players.whiteElo;
    meta.blackElo = players.blackElo;
    // lichess: kanonische Daten (Spieler/Ergebnis/Elo/Datum + saubere Züge) via Export-API.
    if (site === 'lichess' && meta.externalId) {
      const g = await fetchLichessGame(meta.externalId);
      if (g) {
        if (g.white) meta.white = g.white;
        if (g.black) meta.black = g.black;
        if (g.result) meta.result = g.result;
        if (g.playedAt) meta.playedAt = g.playedAt;
        if (g.whiteElo != null) meta.whiteElo = g.whiteElo;
        if (g.blackElo != null) meta.blackElo = g.blackElo;
        if (g.moves) meta.moves = g.moves;
      }
    }
    // chess.com: kanonische Header (Spieler/Ergebnis/Datum/Elo) nachziehen.
    if (site === 'chesscom' && meta.externalId) {
      const h = await fetchChessComHeaders(meta.externalId, /\/daily\//.test(location.pathname));
      if (h) {
        if (h.white) meta.white = h.white;
        if (h.black) meta.black = h.black;
        if (h.result) meta.result = h.result;
        if (h.playedAt) meta.playedAt = h.playedAt;
        if (h.whiteElo != null) meta.whiteElo = h.whiteElo;
        if (h.blackElo != null) meta.blackElo = h.blackElo;
      }
    }
    return meta;
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

  // chessableSearchUrl: siehe Shared-Core-Region oben (aus lib/repertoire-text.js).

  // ─── UI ─────────────────────────────────────────────────────────────
  // Styles der Deviation-Marker + des Settings-Panels + der Floating-Buttons.
  // Als Konstante ausgelagert (statt inline in injectStyles).
  const STYLE_CSS = `
      .${DEVIATION_CLASS} {
        background-color: rgba(255, 120, 50, 0.20) !important;
        border-radius: 2px;
      }
      .${GAP_CLASS} {
        background-color: rgba(255, 210, 50, 0.14) !important;
        border-radius: 2px;
      }
      .${IN_REP_CLASS} {
        background-color: rgba(46, 204, 113, 0.10) !important;
        border-radius: 2px;
      }
      #${BANNER_ID} {
        width: 36px; height: 36px;
        padding: 0;
        border: 1px solid rgba(255,255,255,0.10);
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        font-size: 16px;
        border-radius: 6px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.30);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: rgba(28,28,28,0.92);
        color: #d8d8d8;
      }
      #${BANNER_ID}.deviation {
        background: rgba(120, 50, 28, 0.92);
        color: #fbe2d4;
      }
      #${BANNER_ID}.in-repertoire {
        background: rgba(28, 70, 46, 0.92);
        color: #cfe9d6;
      }
      #${BANNER_ID}.no-repertoire {
        background: rgba(28,28,28,0.92);
        color: #a8a8a8;
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
      #repcheck-floating-wrap {
        position: fixed;
        bottom: 60px;
        right: 16px;
        z-index: 9998;
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: flex-end;
      }
      #repcheck-floating, #repcheck-chessable, #repcheck-copy-pgn, #repcheck-save-game {
        width: 36px; height: 36px;
        padding: 0;
        cursor: pointer;
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 6px;
        display: flex; align-items: center; justify-content: center;
        font-size: 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 2px 6px rgba(0,0,0,0.30);
        color: #d8d8d8;
        background: rgba(36,36,36,0.92);
      }
      #repcheck-floating:hover, #repcheck-chessable:hover, #repcheck-copy-pgn:hover, #repcheck-save-game:hover { background: rgba(56,56,56,0.95); }
      #repcheck-floating:active, #repcheck-chessable:active, #repcheck-copy-pgn:active, #repcheck-save-game:active { background: rgba(24,24,24,0.95); }
      /* Light-Theme-Variante: helle Pille mit dunklem Text. Wird ueber
         data-theme="light" am Floating-Wrap aktiviert (detectSiteTheme()). */
      #repcheck-floating-wrap[data-theme="light"] #${BANNER_ID} {
        background: rgba(255,255,255,0.96); color: #2a2a2a;
        box-shadow: 0 2px 6px rgba(0,0,0,0.15);
      }
      #repcheck-floating-wrap[data-theme="light"] #${BANNER_ID}.deviation {
        background: rgba(255, 235, 222, 0.96); color: #8a2e10;
      }
      #repcheck-floating-wrap[data-theme="light"] #${BANNER_ID}.in-repertoire {
        background: rgba(220, 240, 226, 0.96); color: #1f5230;
      }
      #repcheck-floating-wrap[data-theme="light"] #${BANNER_ID}.no-repertoire {
        background: rgba(248,248,248,0.96); color: #6a6a6a;
      }
      #repcheck-floating-wrap[data-theme="light"] #repcheck-floating,
      #repcheck-floating-wrap[data-theme="light"] #repcheck-chessable,
      #repcheck-floating-wrap[data-theme="light"] #repcheck-copy-pgn,
      #repcheck-floating-wrap[data-theme="light"] #repcheck-save-game {
        background: rgba(255,255,255,0.96); color: #2a2a2a;
        border-color: rgba(0,0,0,0.10);
        box-shadow: 0 2px 6px rgba(0,0,0,0.15);
      }
      #repcheck-floating-wrap[data-theme="light"] #repcheck-floating:hover,
      #repcheck-floating-wrap[data-theme="light"] #repcheck-chessable:hover,
      #repcheck-floating-wrap[data-theme="light"] #repcheck-copy-pgn:hover,
      #repcheck-floating-wrap[data-theme="light"] #repcheck-save-game:hover {
        background: rgba(238,238,238,0.98);
      }
      /* Seit v1.14.0: KEINE site-spezifischen Button-Farben mehr — chess.com
         und Lichess teilen sich dasselbe dezente Dark/Light-Styling oben.
         (Das ⚙-Status-/Settings-Quadrat bleibt im Userscript erhalten, nutzt
         aber dieselbe dezente Optik wie die übrigen Buttons.) */
    `;

  function injectStyles() {
    if (document.getElementById('repcheck-styles')) return;
    const style = document.createElement('style');
    style.id = 'repcheck-styles';
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
  }

  // Light- vs Dark-Theme der jeweiligen Site grob erkennen, damit die Pille
  // auf chess.com (oft Light) nicht als dunkler Block aufpoppt, sondern sich
  // dem Theme anpasst. Heuristik: Luminanz des <body>-Backgrounds.
  function detectSiteTheme() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = bg && bg.match(/\d+/g);
      if (!m || m.length < 3) return 'dark';
      const lum = (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]);
      return lum > 150 ? 'light' : 'dark';
    } catch (e) { return 'dark'; }
  }

  function detectSiteKey() {
    const host = location.hostname;
    for (const key of Object.keys(ADAPTERS)) {
      if (ADAPTERS[key].test(host)) return key;
    }
    return '';
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
    // Theme- und Site-Attribute bei jedem Ensure neu setzen — User kann
    // mittendrin Theme wechseln (Lichess + chess.com erlauben das beide).
    wrap.dataset.theme = detectSiteTheme();
    wrap.dataset.site = detectSiteKey();
    return wrap;
  }

  function injectFloatingButton() {
    const wrap = ensureFloatingWrap();
    if (!wrap) return;
    if (document.getElementById('repcheck-floating')) return;
    const btn = document.createElement('button');
    btn.id = 'repcheck-floating';
    btn.type = 'button';
    btn.textContent = '♟';
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
      btn.textContent = '🔎';
      btn.title = 'FEN vor Abweichung in Chessable suchen';
      btn.addEventListener('click', () => {
        if (!lastDeviationFen) return;
        window.open(chessableSearchUrl(lastDeviationFen), '_blank', 'noopener,noreferrer');
      });
      wrap.insertBefore(btn, wrap.firstChild);
    }
  }

  function injectCopyButton() {
    const wrap = ensureFloatingWrap();
    if (!wrap || document.getElementById('repcheck-copy-pgn')) return;
    const btn = document.createElement('button');
    btn.id = 'repcheck-copy-pgn';
    btn.type = 'button';
    btn.textContent = '📋';
    btn.title = 'Partie-PGN kopieren';
    btn.addEventListener('click', copyGamePgn);
    wrap.appendChild(btn);
  }

  async function syncSaveButton() {
    const wrap = document.getElementById('repcheck-floating-wrap');
    if (!wrap) return;
    const existing = document.getElementById('repcheck-save-game');
    const cfg = await loadRookhubConfig().catch(() => null);
    if (!cfg || !cfg.url || !cfg.token) { existing?.remove(); return; }
    if (existing) return;
    const btn = document.createElement('button');
    btn.id = 'repcheck-save-game';
    btn.type = 'button';
    btn.textContent = '💾';
    btn.title = 'Partie in RookHub speichern';
    btn.addEventListener('click', async () => {
      const currentCfg = await loadRookhubConfig().catch(() => null);
      if (!currentCfg) return;
      const domMoves = getGameMoves();
      if (!domMoves.length) return;
      btn.textContent = '…';
      btn.disabled = true;
      const reset = () => setTimeout(() => {
        btn.textContent = '💾'; btn.title = 'Partie in RookHub speichern'; btn.disabled = false;
      }, 1500);
      try {
        const meta = await getGameMeta();
        // Kanonische Zugliste (lichess-Export) bevorzugen, sonst DOM-Auslese.
        const moves = (meta.moves && meta.moves.length) ? meta.moves : domMoves;
        const saved = await rookhubSaveGame(currentCfg, moves, meta);
        const link = buildShareLink(currentCfg, saved);
        let copied = false;
        if (link) {
          try {
            if (typeof GM_setClipboard !== 'undefined') { GM_setClipboard(link, { type: 'text', mimetype: 'text/plain' }); copied = true; }
            else if (navigator.clipboard) { await navigator.clipboard.writeText(link); copied = true; }
          } catch (e) { /* Clipboard evtl. blockiert */ }
        }
        btn.textContent = copied ? '🔗' : '✓';
        btn.title = copied ? 'Gespeichert · Teilen-Link kopiert' : 'Partie gespeichert';
        reset();
      } catch (e) {
        btn.textContent = '✗';
        reset();
        console.warn('[RepertoireChecker] Save failed:', e);
      }
    });
    wrap.appendChild(btn);
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
      injectCopyButton();
      syncSaveButton();
    } else {
      removeFloatingControls();
    }
  }

  function updateStatusText(text) {
    const el = document.getElementById('repcheck-status');
    if (el) el.textContent = text;
  }

  function showBanner(message, type) {
    // Seit v1.6.4: Banner ist ein Icon-Only-Quadrat (\u2699) im Floating-Wrap;
    // Statusfarbe codiert deviation/in-rep/no-rep, der Tooltip (title) zeigt
    // den vollen Text. Klick oeffnet das Settings-Panel.
    const wrap = ensureFloatingWrap();
    if (!wrap) return;
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('button');
      banner.id = BANNER_ID;
      banner.type = 'button';
      banner.textContent = '\u2699';
      banner.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanel();
      });
    }
    // Banner immer oben im Wrap (vor Chessable-/Pruefen-Button).
    if (banner.parentElement !== wrap || wrap.firstChild !== banner) {
      wrap.insertBefore(banner, wrap.firstChild);
    }
    wrap.dataset.theme = detectSiteTheme();
    wrap.dataset.site = detectSiteKey();
    banner.title = message;
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

  // Panel-Markup (reiner String, keine DOM-Nebenwirkungen).
  function panelHtml() {
    return `
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
  }

  // RookHub-Felder vorbefuellen (async) + alle Panel-Buttons verdrahten.
  function wirePanelEvents() {
    // Config laden; ohne vorhandene mit der Default-Instanz vorbelegen, damit
    // Neu-User nicht erst eine URL suchen muessen.
    loadRookhubConfig().then(cfg => {
      const urlInput = document.getElementById('repcheck-rookhub-url');
      const tokenInput = document.getElementById('repcheck-rookhub-token');
      if (urlInput) urlInput.value = (cfg && cfg.url) || ROOKHUB_DEFAULT_URL;
      if (cfg && tokenInput) tokenInput.value = cfg.token || '';
    }).catch(() => {
      const urlInput = document.getElementById('repcheck-rookhub-url');
      if (urlInput && !urlInput.value) urlInput.value = ROOKHUB_DEFAULT_URL;
    });

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
    panel.innerHTML = panelHtml();
    document.body.appendChild(panel);

    wirePanelEvents();
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
    syncSaveButton();
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

  // ─── Chessable-Modus ────────────────────────────────────────────────
  // Auf chessable.com laeuft KEINE Repertoire-Logik, sondern:
  //  1) FEN-Tools (Copy/Search-Buttons + XP-Anzeige) via initChessableFenTools
  //  2) Token-Auslese per TM-Menue (Weitergabe an piratechess).
  // Der API-Token liegt im localStorage unter `chessable.web.production.JWT`
  // und verlaesst den Browser nicht.
  if (/(^|\.)chessable\.com$/i.test(location.hostname)) {
    const CHESSABLE_LS_KEY = 'chessable.web.production.JWT';
    const extractChessableJwt = (raw) => {
      if (typeof raw !== 'string') return null;
      let v = raw.trim();
      if (!v) return null;
      if (v[0] === '"' || v[0] === '{') {
        try {
          const parsed = JSON.parse(v);
          if (typeof parsed === 'string') v = parsed;
          else if (parsed && typeof parsed === 'object') {
            v = parsed.token || parsed.jwt || parsed.accessToken || parsed.access_token || '';
          }
        } catch (e) { /* kein JSON — Rohwert behalten */ }
      }
      v = String(v).trim();
      return v || null;
    };
    if (typeof GM_registerMenuCommand !== 'undefined') {
      GM_registerMenuCommand('🔑 Chessable-Token kopieren', () => {
        let token = null;
        try { token = extractChessableJwt(localStorage.getItem(CHESSABLE_LS_KEY)); } catch (e) {}
        if (!token) {
          alert('RepCheck: Kein Chessable-Token im localStorage gefunden — eingeloggt?');
          return;
        }
        if (typeof GM_setClipboard !== 'undefined') {
          GM_setClipboard(token, { type: 'text', mimetype: 'text/plain' });
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(token);
        }
        alert('RepCheck: Chessable-Token in die Zwischenablage kopiert.');
      });
    }
    // Autoritativer Kursname über den Chessable-Bearer (localStorage-JWT → getHomeData);
    // geteilt zwischen FEN-Tools („Remember line") und Aktivitaets-Tracking.
    const courseNameApi = createChessableCourseNameApi(CHESSABLE_LS_KEY, extractChessableJwt);
    initChessableFenTools(courseNameApi);
    initChessableActivityTracking(courseNameApi);
    initChessableBrowserImport(courseNameApi, CHESSABLE_LS_KEY, extractChessableJwt);
    console.log('[RepertoireChecker] Chessable-Modus aktiv (FEN-Tools + Aktivitaet + Token + Import)');
    return;
  }

  // Browser-Kurs-Import (Pendant zu extension/chessable-capture.js + dem Import-Teil von
  // chessable-activity.js): V1 = passiver Mitschnitt der Chessable-Kurs-API beim Training,
  // V2 = aktives Holen des ganzen Kurses (getCourse→getList→getGame). Der Browser holt die Daten
  // als echte eingeloggte Session (passiert Cloudflare) und schickt das ROHE JSON an RookHub
  // (POST /api/extension/chessable/ingest); der fetch-freie piratechess-Parser macht daraus PGN.
  // Im Userscript alles im Page-Kontext: fetch/XHR direkt patchbar, Egress via direktem fetch
  // (RookHub-ExtensionPolicy erlaubt chessable.com). Kein MAIN/isoliert-Split noetig.
  function initChessableBrowserImport(courseNameApi, lsKey, extractJwt) {
    // --- reine Helfer (Spiegel von extension/lib/chessable-crawl.js) ---
    function classifyApi(url) {
      let u; try { u = new URL(url, 'https://www.chessable.com'); } catch (e) { return null; }
      if (!/(^|\.)chessable\.com$/i.test(u.hostname)) return null;
      const p = u.pathname.replace(/\/+$/, '');
      if (p.endsWith('/api/v1/getCourse')) return { kind: 'course', bid: u.searchParams.get('bid') };
      if (p.endsWith('/api/v1/getList')) return { kind: 'list', bid: u.searchParams.get('bid'), lid: u.searchParams.get('lid') };
      if (p.endsWith('/api/v1/getGame')) return { kind: 'game', oid: u.searchParams.get('oid') };
      return null;
    }
    function parseChapterLids(t) { let o; try { o = typeof t === 'string' ? JSON.parse(t) : t; } catch (e) { return []; } const a = o && (o.course || o.Course) && ((o.course || o.Course).data || (o.course || o.Course).Data); return Array.isArray(a) ? a.map(c => c && (c.id != null ? c.id : c.Id)).filter(v => v != null).map(String) : []; }
    function parseLineOids(t) { let o; try { o = typeof t === 'string' ? JSON.parse(t) : t; } catch (e) { return []; } const l = o && (o.list || o.List); const a = l && (l.data || l.Data); return Array.isArray(a) ? a.map(x => x && (x.id != null ? x.id : x.Id)).filter(v => v != null).map(String) : []; }
    function buildIngestChapters(chapters) {
      const out = [];
      for (const ch of (chapters || [])) {
        if (!ch || typeof ch.listText !== 'string') continue;
        const lines = [];
        for (const oid of parseLineOids(ch.listText)) {
          const g = ch.games && ch.games[oid];
          if (typeof g === 'string' && g.trim() && g.trim() !== '{}') lines.push(g);
        }
        if (lines.length) out.push({ chapterJson: ch.listText, lines });
      }
      return out;
    }
    // Kapitel→oids aus getCourse?includeVariations (Spiegel von lib/chessable-crawl.js).
    function parseCourseVariations(t) {
      let o; try { o = typeof t === 'string' ? JSON.parse(t) : t; } catch (e) { return { chapters: [], allOids: [] }; }
      const course = o && (o.course || o.Course); const data = course && (course.data || course.Data);
      const chapters = []; const allOids = [];
      if (Array.isArray(data)) for (const c of data) {
        const lid = c && (c.id != null ? c.id : c.Id);
        const vars = c && (c.variations || c.Variations);
        const oids = Array.isArray(vars) ? vars.map(v => v && (v.oid != null ? v.oid : v.Oid)).filter(x => x != null).map(String) : [];
        chapters.push({ lid: lid != null ? String(lid) : null, oids });
        for (const x of oids) allOids.push(x);
      }
      return { chapters, allOids };
    }
    function progressCounts(chapters, importedOids) {
      const set = importedOids instanceof Set ? importedOids : new Set(importedOids || []);
      const perChapter = (chapters || []).map(ch => ({ lid: ch.lid, total: ch.oids.length, done: ch.oids.reduce((n, o) => n + (set.has(String(o)) ? 1 : 0), 0) }));
      return { total: perChapter.reduce((n, c) => n + c.total, 0), done: perChapter.reduce((n, c) => n + c.done, 0), perChapter };
    }

    // --- Config/Token/Kurs-ID ---
    function getCfg() { try { if (typeof GM_getValue !== 'undefined') return GM_getValue('rookhubConfig', null); } catch (e) {} return null; }
    function b64urlDecode(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return atob(s); }
    function decodeUid(token) { try { const parts = String(token).split('.'); if (parts.length < 2) return null; const o = JSON.parse(b64urlDecode(parts[1])); const uid = o && o.user && o.user.uid; return (uid != null && /^\d+$/.test(String(uid))) ? String(uid) : null; } catch (e) { return null; } }
    function getToken() { try { return extractJwt(localStorage.getItem(lsKey)); } catch (e) { return null; } }
    function currentCourseId() {
      const m = /\/courses?\/(\d+)(?:\/|$)/.exec(location.pathname);
      if (m) return m[1];
      for (const a of document.querySelectorAll('a[href*="/course/"]')) {
        const am = /\/course\/(\d+)(?:\/|$)/.exec(a.getAttribute('href') || '');
        if (am) return am[1];
      }
      return null;
    }

    // --- V1: passiver Mitschnitt (fetch + XHR im Page-Kontext direkt patchen) ---
    const cap = { bid: null, courseText: null, lists: {}, oidToLid: {}, games: {}, bytes: 0 };
    const CAP_MAX = 40 * 1024 * 1024;
    function resetCap(bid) { cap.bid = bid; cap.courseText = null; cap.lists = {}; cap.oidToLid = {}; cap.games = {}; cap.bytes = 0; }
    function absorb(url, body) {
      if (typeof body !== 'string' || !body || body.trim() === '' || body.trim() === '{}') return;
      const info = classifyApi(url);
      if (!info || cap.bytes + body.length > CAP_MAX) return;
      if (info.kind === 'course') { const bid = info.bid || currentCourseId(); if (bid && bid !== cap.bid) resetCap(bid); if (!cap.bid) cap.bid = bid || null; cap.courseText = body; cap.bytes += body.length; }
      else if (info.kind === 'list') { if (info.bid && info.bid !== cap.bid) resetCap(info.bid); if (!cap.bid && info.bid) cap.bid = info.bid; if (info.lid != null) { cap.lists[info.lid] = body; cap.bytes += body.length; for (const oid of parseLineOids(body)) cap.oidToLid[oid] = info.lid; } }
      else if (info.kind === 'game') { if (info.oid != null && !cap.games[info.oid]) { cap.games[info.oid] = body; cap.bytes += body.length; } }
      updatePanel();
      if (autoImport) scheduleAutoImport();
    }
    const RELEVANT = /\/api\/v1\/(getCourse|getList|getGame)(\?|$)/;
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (...args) {
        const p = origFetch.apply(this, args);
        try { const a0 = args[0]; const url = (a0 && typeof a0 === 'object' && 'url' in a0) ? a0.url : String(a0 || ''); if (RELEVANT.test(url)) p.then(r => { try { r.clone().text().then(t => absorb(url, t)).catch(() => {}); } catch (e) {} }).catch(() => {}); } catch (e) {}
        return p;
      };
    }
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const oOpen = XHR.prototype.open, oSend = XHR.prototype.send;
      XHR.prototype.open = function (m, url, ...rest) { try { this.__rcUrl = String(url || ''); } catch (e) {} return oOpen.call(this, m, url, ...rest); };
      XHR.prototype.send = function (...a) { try { const url = this.__rcUrl || ''; if (RELEVANT.test(url)) this.addEventListener('load', function () { try { const t = (this.responseType === '' || this.responseType === 'text') ? this.responseText : (this.responseType === 'json' ? JSON.stringify(this.response) : null); if (t) absorb(url, t); } catch (e) {} }); } catch (e) {} return oSend.apply(this, a); };
    }

    function capturedChapters() {
      const lids = cap.courseText ? parseChapterLids(cap.courseText) : Object.keys(cap.lists);
      return buildIngestChapters(lids.filter(lid => cap.lists[lid]).map(lid => ({ listText: cap.lists[lid], games: cap.games })));
    }
    function capturedLineCount() { return capturedChapters().reduce((n, c) => n + c.lines.length, 0); }

    // --- Egress + Chessable-Fetch ---
    async function ingest(bid, chapters, target) {
      const cfg = getCfg();
      if (!cfg || !cfg.url || !cfg.token) throw new Error('Nicht mit RookHub verbunden');
      const baseUrl = String(cfg.url).replace(/\/$/, '');
      const courseName = (courseNameApi && courseNameApi.apiCourseName) ? courseNameApi.apiCourseName(bid) : null;
      const resp = await fetch(baseUrl + '/api/extension/chessable/ingest', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ bid, target, courseName, chapters }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error((data && data.message) || ('HTTP ' + resp.status));
      return data;
    }
    // Chessable drosselt (HTTP 429) bei zu schnellem Holen. Nur retrybare Codes wiederholen; dabei
    // `Retry-After` honorieren (Sekunden ODER HTTP-Datum), sonst exponentielles Backoff mit Jitter.
    // 401/403/404 bleiben harte Fehler (kein Retry). Basis-Takt s. INTER_MS.
    const CHESSABLE_RETRYABLE = new Set([429, 500, 502, 503, 504]);
    const CHESSABLE_MAX_ATTEMPTS = 5;
    function parseRetryAfterMs(header) {
      if (!header) return null;
      const secs = Number(header);
      if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
      const when = Date.parse(header);
      if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
      return null;
    }
    async function chessableGet(path) {
      const token = getToken(); if (!token) throw new Error('Kein Chessable-Token (eingeloggt?)');
      const uid = decodeUid(token); if (!uid) throw new Error('Token ohne uid');
      const sep = path.includes('?') ? '&' : '?';
      const url = `https://www.chessable.com/api/v1/${path}${sep}uid=${uid}`;
      const init = { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }, credentials: 'include' };
      let lastStatus = 0;
      for (let attempt = 1; attempt <= CHESSABLE_MAX_ATTEMPTS; attempt++) {
        const resp = await fetch(url, init);
        if (resp.ok) return resp.text();
        lastStatus = resp.status;
        if (!CHESSABLE_RETRYABLE.has(resp.status) || attempt === CHESSABLE_MAX_ATTEMPTS) break;
        const retryAfter = parseRetryAfterMs(resp.headers.get('Retry-After'));
        const backoff = (retryAfter != null ? retryAfter : Math.min(30000, INTER_MS * Math.pow(2, attempt)))
          + Math.floor(Math.random() * 400);
        setStatus(`Chessable drosselt (HTTP ${resp.status}) — warte ${Math.round(backoff / 1000)} s (Versuch ${attempt}/${CHESSABLE_MAX_ATTEMPTS - 1}) …`);
        await sleep(backoff);
      }
      throw new Error('Chessable HTTP ' + lastStatus);
    }

    // Ein Kapitel-Chunk an den kapitelweisen Ingest (bounded); final=true schließt die Session ab.
    async function ingestChunk(sessionId, bid, target, courseName, chapter, final) {
      const cfg = getCfg();
      if (!cfg || !cfg.url || !cfg.token) throw new Error('Nicht mit RookHub verbunden');
      const baseUrl = String(cfg.url).replace(/\/$/, '');
      const resp = await fetch(baseUrl + '/api/extension/chessable/ingest/chunk', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ sessionId, bid, target, courseName, chapter, final }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error((data && data.message) || ('HTTP ' + resp.status));
      return data;
    }

    const INTER_MS = 3000; const sleep = (ms) => new Promise(r => setTimeout(r, ms));  // ~1 Request / 3 s; Backoff s. chessableGet
    const newSessionId = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (String(Date.now()) + '-' + Math.round(Math.random() * 1e9));
    let crawling = false;
    // V2: kompletten Kurs aktiv holen und KAPITELWEISE streamen (kein Riesen-Body; Import beim finalen Chunk).
    // Repertoire (Default): INKREMENTELL — schon auf RookHub liegende oids werden NICHT erneut von Chessable
    // geholt, nur neue via ingestLive angehängt (spart Abrufe + Ban-Risiko). Buch: voll holen + Chunk-Stream
    // (Round-basierte LineId braucht den ganzen Kurs am Stück).
    async function crawlAndImport(target) {
      if (crawling) return; crawling = true; updatePanel();
      const bid = currentCourseId();
      const sessionId = newSessionId();
      const incremental = target !== 'book';
      const courseName = (courseNameApi && courseNameApi.apiCourseName) ? courseNameApi.apiCourseName(bid) : null;
      try {
        if (!bid) throw new Error('Kein Kurs erkannt');
        let already = new Set();
        if (incremental) { const prog = await fetchImportedOids(bid); already = new Set((prog && prog.oids) || []); }
        setStatus('Hole Kursstruktur …');
        const courseText = (cap.courseText && cap.bid === bid) ? cap.courseText : await chessableGet(`getCourse?bid=${bid}`);
        const lids = parseChapterLids(courseText);
        if (!lids.length) throw new Error('Keine Kapitel gefunden');
        const lists = []; let total = 0, toFetch = 0;
        for (const lid of lids) { const listText = (cap.lists[lid] && cap.bid === bid) ? cap.lists[lid] : await chessableGet(`getList?bid=${bid}&lid=${lid}`); const oids = parseLineOids(listText); lists.push({ listText, oids }); total += oids.length; toFetch += incremental ? oids.filter(o => !already.has(String(o))).length : oids.length; await sleep(INTER_MS); }
        if (incremental && toFetch === 0) { setStatus(`Nichts Neues — alle ${total} Linien schon auf RookHub.`); ensureProgress(true); return; }
        let done = 0, sent = 0, skipped = 0;
        const newChapters = [];
        for (const { listText, oids } of lists) {
          const lines = [];
          for (const oid of oids) { if (incremental && already.has(String(oid))) { skipped++; continue; } let g = cap.games[oid]; if (!g) { g = await chessableGet(`getGame?lng=en&oid=${oid}`); await sleep(INTER_MS); } if (g && g.trim() && g.trim() !== '{}') { lines.push(g); cap.games[oid] = g; } done++; setStatus(`Hole neue Linien … ${done}/${toFetch}`); }
          if (!lines.length) continue;
          if (incremental) newChapters.push({ chapterJson: listText, lines });
          else await ingestChunk(sessionId, bid, target, courseName, { chapterJson: listText, lines }, false);
          sent++;
        }
        if (!sent) throw new Error('Keine Linien geholt');
        if (incremental) {
          setStatus('Hänge neue Linien an …');
          const res = await ingestLive(bid, target, courseName, newChapters);
          setStatus(`Fertig: ${res.imported} neue Linien angehängt${skipped ? ` (${skipped} schon vorhanden)` : ''}.`); ensureProgress(true);
        } else {
          setStatus('Importiere in RookHub …');
          const res = await ingestChunk(sessionId, bid, target, courseName, null, true);
          setStatus(`Fertig: ${res.imported} ${target === 'book' ? 'Puzzles' : 'Linien'} importiert.`); ensureProgress(true);
        }
      } catch (err) { setStatus('Fehler: ' + ((err && err.message) || err)); }
      finally { crawling = false; updatePanel(); }
    }
    async function importCaptured(target) {
      const bid = cap.bid || currentCourseId(); const chapters = capturedChapters();
      if (!bid || !chapters.length) { setStatus('Nichts mitgeschnitten.'); return; }
      try { setStatus('Importiere Mitschnitt …'); const res = await ingest(bid, chapters, target); setStatus(`Fertig: ${res.imported} ${target === 'book' ? 'Puzzles' : 'Linien'} importiert.`); ensureProgress(true); }
      catch (err) { setStatus('Fehler: ' + ((err && err.message) || err)); }
    }

    let autoImport = false, autoImportTimer = null;
    try { if (typeof GM_getValue !== 'undefined') autoImport = !!GM_getValue('rookhubChessableAutoImport', false); } catch (e) {}

    // Live-Append (V1 „beim Durchklicken"): jede NEU erfasste Linie kurz gebündelt SOFORT ans
    // Repertoire anhängen (POST .../ingest/live). sentOids = Session-Dedup; Server dedupliziert per Zugtext.
    const sentOids = new Set();
    let liveFlushing = false;
    function hasUnsentLine() {
      for (const oid of Object.keys(cap.games)) { if (sentOids.has(oid)) continue; const lid = cap.oidToLid && cap.oidToLid[oid]; if (lid && cap.lists[lid]) return true; }
      return false;
    }
    async function ingestLive(bid, target, courseName, chapters) {
      const cfg = getCfg();
      if (!cfg || !cfg.url || !cfg.token) throw new Error('Nicht mit RookHub verbunden');
      const baseUrl = String(cfg.url).replace(/\/$/, '');
      const resp = await fetch(baseUrl + '/api/extension/chessable/ingest/live', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ bid, target, courseName, chapters }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error((data && data.message) || ('HTTP ' + resp.status));
      return data;
    }
    async function flushLive() {
      if (liveFlushing) return;
      const bid = cap.bid || currentCourseId();
      if (!bid) return;
      const byLid = {}; const picked = [];
      for (const oid of Object.keys(cap.games)) {
        if (sentOids.has(oid)) continue;
        const lid = cap.oidToLid && cap.oidToLid[oid];
        if (!lid || !cap.lists[lid]) continue;
        (byLid[lid] = byLid[lid] || []).push(oid);
        picked.push(oid);
      }
      if (!picked.length) return;
      const chapters = Object.keys(byLid).map(lid => ({ chapterJson: cap.lists[lid], lines: byLid[lid].map(o => cap.games[o]) }));
      liveFlushing = true;
      picked.forEach(o => sentOids.add(o));
      try {
        const cn = (courseNameApi && courseNameApi.apiCourseName) ? courseNameApi.apiCourseName(bid) : null;
        const res = await ingestLive(bid, currentTarget(), cn, chapters);
        setStatus(`Live: ${res.imported} neu angehängt (${sentOids.size} gesendet).`); ensureProgress(true);
      } catch (err) {
        picked.forEach(o => sentOids.delete(o));
        setStatus('Live-Fehler: ' + ((err && err.message) || err));
      } finally {
        liveFlushing = false;
        if (autoImport && hasUnsentLine()) scheduleAutoImport();
      }
      updatePanel();
    }
    function scheduleAutoImport() { if (autoImportTimer) return; autoImportTimer = setTimeout(() => { autoImportTimer = null; flushLive(); }, 1500); }

    // --- UI-Panel ---
    let panel = null, statusEl = null, progressEl = null, capInfoEl = null, importCapBtn = null, crawlBtn = null, autoChk = null;
    // --- Fortschritts-Overlay (Kurs/Kapitel im Panel + ✓/○ an Chessables Linien) ---
    let progressBid = null, progressStruct = null, importedOids = new Set(), progressAt = 0, progressFetching = false;
    const PROGRESS_TTL = 60000;
    async function fetchImportedOids(bid) {
      const cfg = getCfg(); if (!cfg || !cfg.url || !cfg.token) return null;
      const baseUrl = String(cfg.url).replace(/\/$/, '');
      try {
        const resp = await fetch(baseUrl + '/api/extension/chessable/progress?bid=' + encodeURIComponent(bid),
          { headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/json' } });
        if (!resp.ok) return null;
        return await resp.json();
      } catch (e) { return null; }
    }
    async function ensureProgress(force) {
      const bid = currentCourseId(); if (!bid) return;
      if (!force && bid === progressBid && (Date.now() - progressAt) < PROGRESS_TTL) return;
      if (progressFetching) return; progressFetching = true;
      try {
        if (bid !== progressBid || !progressStruct) {
          const courseText = (cap.courseText && cap.bid === bid) ? cap.courseText : await chessableGet(`getCourse?bid=${bid}&includeVariations=true`);
          progressStruct = parseCourseVariations(courseText);
        }
        const prog = await fetchImportedOids(bid);
        importedOids = new Set((prog && prog.oids) || []);
        progressBid = bid; progressAt = Date.now();
        renderProgress(); annotateDom();
      } catch (e) {} finally { progressFetching = false; }
    }
    function renderProgress() {
      if (!progressEl || !progressStruct) return;
      const c = progressCounts(progressStruct.chapters, importedOids);
      if (c.total === 0) { progressEl.textContent = ''; return; }
      const pct = Math.round((c.done / c.total) * 100);
      const lines = c.perChapter.map((ch, i) => `Kapitel ${i + 1}: ${ch.done}/${ch.total}`).join(' · ');
      progressEl.innerHTML = `<div style="font-weight:600;color:#e8eaed">Auf RookHub: ${c.done}/${c.total} Linien (${pct}%)</div>` +
        `<div style="margin-top:2px;font-size:11px;color:#9aa4b2;max-height:80px;overflow:auto">${lines}</div>`;
    }
    function annotateDom() {
      if (!progressStruct) return;
      for (const oid of progressStruct.allOids) {
        const done = importedOids.has(String(oid));
        const el = document.querySelector(`a[href*="/${oid}"], a[href$="/${oid}"], [data-oid="${oid}"], [data-variation-id="${oid}"], [data-id="${oid}"]`);
        if (!el) continue;
        const row = el.closest('li, tr, [role="row"], div') || el;
        let b = row.querySelector(':scope > .rc-prog-badge');
        if (b) { b.textContent = done ? '✓' : '○'; b.style.color = done ? '#4caf50' : '#9aa4b2'; continue; }
        b = document.createElement('span');
        b.className = 'rc-prog-badge';
        b.textContent = done ? '✓' : '○';
        b.title = done ? 'Auf RookHub' : 'Noch nicht auf RookHub';
        b.style.cssText = `margin-right:6px;font-weight:700;color:${done ? '#4caf50' : '#9aa4b2'}`;
        row.insertBefore(b, row.firstChild);
      }
    }
    let domObserver = null;
    function startDomObserver() {
      if (domObserver || !document.body) return;
      let t = null;
      domObserver = new MutationObserver(() => { if (t) return; t = setTimeout(() => { t = null; try { annotateDom(); } catch (e) {} }, 500); });
      domObserver.observe(document.body, { childList: true, subtree: true });
    }

    function currentTarget() { const r = panel && panel.querySelector('input[name="rc-target"]:checked'); return r ? r.value : 'repertoire'; }
    function setStatus(t) { if (statusEl) statusEl.textContent = t || ''; }
    function ensurePanel() {
      if (panel || !document.body || !currentCourseId()) return;
      panel = document.createElement('div');
      panel.id = 'repcheck-import-panel';
      panel.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483000;background:#1f2530;color:#e8eaed;font:12px/1.4 system-ui,sans-serif;border:1px solid #3a4250;border-radius:8px;padding:10px 12px;max-width:260px;box-shadow:0 4px 16px rgba(0,0,0,.4)';
      panel.innerHTML =
        '<div style="font-weight:600;margin-bottom:6px">RookHub-Import (Browser)</div>' +
        '<div style="margin-bottom:6px"><label style="margin-right:10px"><input type="radio" name="rc-target" value="repertoire" checked> Repertoire</label><label><input type="radio" name="rc-target" value="book"> Kurs/Buch</label></div>' +
        '<div style="font-weight:bold;color:#ffb3b3;background:#3a1f1f;border:1px solid #6b2b2b;border-radius:5px;padding:6px 8px;margin-bottom:6px;line-height:1.35">⚠️ Bannrisiko: „Kurs holen" ruft die Chessable-API automatisiert im Schnelldurchlauf ab. Das kann gegen Chessables Nutzungsbedingungen verstoßen und im schlimmsten Fall zur Sperrung deines Kontos führen. Nur für eigene Kurse, auf eigenes Risiko. Der passive „Mitschnitt" ist unbedenklich.</div>' +
        '<button id="rc-crawl" style="width:100%;margin-bottom:6px;padding:6px;background:#2d6cdf;color:#fff;border:0;border-radius:5px;cursor:pointer">⚡ Kurs über meinen Browser holen</button>' +
        '<div id="rc-capinfo" style="margin-bottom:4px;color:#9aa4b2"></div>' +
        '<button id="rc-importcap" style="width:100%;margin-bottom:6px;padding:5px;background:#3a4250;color:#e8eaed;border:0;border-radius:5px;cursor:pointer;display:none">Mitschnitt importieren</button>' +
        '<label style="display:block;margin-bottom:6px;color:#9aa4b2"><input type="checkbox" id="rc-auto"> Linien beim Durchklicken live anhängen</label>' +
        '<div id="rc-progress" style="margin-bottom:6px;color:#c7cfda;border-top:1px solid #3a4250;padding-top:6px"></div>' +
        '<div id="rc-status" style="color:#8fd08f;min-height:1.2em"></div>';
      document.body.appendChild(panel);
      statusEl = panel.querySelector('#rc-status'); progressEl = panel.querySelector('#rc-progress'); capInfoEl = panel.querySelector('#rc-capinfo');
      importCapBtn = panel.querySelector('#rc-importcap'); crawlBtn = panel.querySelector('#rc-crawl'); autoChk = panel.querySelector('#rc-auto');
      crawlBtn.addEventListener('click', () => {
        // Bannrisiko: der aktive Crawl klappert die Chessable-API automatisiert ab → explizite Bestätigung.
        const ok = window.confirm(
          'Bannrisiko\n\n„Kurs holen" ruft die Chessable-API automatisiert im Schnelldurchlauf ab. ' +
          'Das kann gegen Chessables Nutzungsbedingungen verstoßen und im schlimmsten Fall ' +
          'zur Sperrung deines Kontos führen.\n\nNutze es nur für eigene Kurse und auf eigenes Risiko.\n\nWirklich fortfahren?');
        if (!ok) return;
        crawlAndImport(currentTarget());
      });
      importCapBtn.addEventListener('click', () => importCaptured(currentTarget()));
      autoChk.addEventListener('change', () => { autoImport = autoChk.checked; try { if (typeof GM_setValue !== 'undefined') GM_setValue('rookhubChessableAutoImport', autoImport); } catch (e) {} if (autoImport && hasUnsentLine()) scheduleAutoImport(); });
      updatePanel();
    }
    function updatePanel() {
      if (!panel) return;
      const n = capturedLineCount();
      if (capInfoEl) capInfoEl.textContent = n > 0 ? `${n} Linien mitgeschnitten` : 'Noch nichts mitgeschnitten';
      if (importCapBtn) importCapBtn.style.display = n > 0 ? 'block' : 'none';
      if (autoChk) autoChk.checked = autoImport;
      if (crawlBtn) crawlBtn.disabled = crawling;
    }
    setInterval(() => { ensurePanel(); startDomObserver(); ensureProgress(false); }, 5000); ensurePanel(); startDomObserver(); ensureProgress(false);
  }

  // Misst AKTIVE Chessable-Trainingszeit und meldet sie an RookHub (Kategorie
  // „Chessable" im Trainingsziele-Tracker). „Aktiv" = Brett vorhanden + Tab
  // sichtbar/fokussiert + kuerzliches hartes Signal (Brett-Mutation/Klick/Taste/
  // gewerteter Zug). RookHub-Config kommt aus GM-Storage (origin-uebergreifend,
  // gespiegelt von saveRookhubConfig); ohne Config wird nichts gesendet. Egress
  // per fetch (CORS fuer chessable.com ist serverseitig erlaubt). Pendant zur
  // Extension-Datei extension/chessable-activity.js.
  // Baut aus dem eingeloggten Chessable-JWT (localStorage) + getHomeData eine autoritative
  // bid→Name-Karte. Same-origin auf chessable.com (keine CORS-/Cloudflare-Hürde, wie die
  // Chessable-SPA selbst); der Token verlaesst den Browser nicht. Pendant zur Extension-Logik
  // in extension/chessable-activity.js. Persistiert best-effort in GM-Storage.
  function createChessableCourseNameApi(lsKey, extractJwt) {
    const TTL = 6 * 60 * 60 * 1000; // 6 h
    let names = {}, fetchedAt = 0, fetching = null, loaded = false;

    function b64urlDecode(s) {
      s = String(s).replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      return atob(s);
    }
    function decodeUid(token) {
      try {
        const parts = String(token).split('.');
        if (parts.length < 2) return null;
        const o = JSON.parse(b64urlDecode(parts[1]));
        const uid = o && o.user && o.user.uid;
        return (uid != null && /^\d+$/.test(String(uid))) ? String(uid) : null;
      } catch (e) { return null; }
    }
    function readToken() {
      try { return extractJwt(localStorage.getItem(lsKey)); } catch (e) { return null; }
    }
    async function fetchMap() {
      const token = readToken();
      if (!token) return null;
      const uid = decodeUid(token);
      if (!uid) return null;
      try {
        const resp = await fetch(
          `https://www.chessable.com/api/v1/getHomeData?uid=${uid}&sortBookRowsBy=alphabetically&userLanguageShort=en`,
          { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }, credentials: 'include' });
        if (!resp.ok) return null;
        const data = await resp.json();
        const home = data && (data.homeData || data.HomeData);
        const books = home && (home.booksList || home.BooksList);
        if (!Array.isArray(books)) return null;
        const map = {};
        for (const b of books) {
          const bid = b && (b.bid != null ? b.bid : b.Bid);
          const name = b && (b.name != null ? b.name : b.Name);
          if (bid != null && typeof name === 'string' && name.trim())
            map[String(bid)] = name.trim().slice(0, 200);
        }
        return Object.keys(map).length ? map : null;
      } catch (e) { return null; }
    }
    function loadPersisted() {
      try {
        if (typeof GM_getValue !== 'undefined') {
          const c = GM_getValue('chessableCourseNames', null);
          if (c && c.map && typeof c.map === 'object') { names = c.map; fetchedAt = c.fetchedAt || 0; }
        }
      } catch (e) {}
    }
    async function ensureCourseNames(force) {
      if (!loaded) { loaded = true; loadPersisted(); }
      if (!force && Object.keys(names).length && (Date.now() - fetchedAt) < TTL) return names;
      if (fetching) return fetching;
      fetching = (async () => {
        const map = await fetchMap();
        if (map) {
          names = map; fetchedAt = Date.now();
          try { if (typeof GM_setValue !== 'undefined') GM_setValue('chessableCourseNames', { map, fetchedAt }); } catch (e) {}
        }
        fetching = null;
        return names;
      })();
      return fetching;
    }
    return {
      apiCourseName: (id) => (id && names[String(id)]) || null,
      ensureCourseNames,
    };
  }

  function initChessableActivityTracking(courseNameApi) {
    if (window.__repcheckChessableActivity) return;
    window.__repcheckChessableActivity = true;

    const TICK_MS = 5000, IDLE_MS = 60000, FLUSH_MS = 60000, MIN_FLUSH_MS = 10000, MAX_FLUSH_S = 3600;
    let activeMs = 0, movesTrained = 0, lastActivity = 0, lastFlush = Date.now();
    let courseKind = null, lookedUpCourseId = null;

    const now = () => Date.now();
    const bump = () => { lastActivity = now(); };
    const boardPresent = () => !!document.querySelector('[data-square]');

    document.addEventListener('pointerdown', () => { if (boardPresent()) bump(); }, true);
    document.addEventListener('keydown', () => { if (boardPresent()) bump(); }, true);

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

    function readConfig() {
      try {
        if (typeof GM_getValue !== 'undefined') return GM_getValue('rookhubConfig', null);
      } catch (e) { /* ignore */ }
      return null;
    }

    // Kurs-ID robust ermitteln: URL → Kurs-Links → React-Fiber. Im Page-Kontext ist
    // der Fiber lesbar; die Practice-URL (/practice/…) traegt keine Kurs-ID. Logik
    // analog currentCourseId() in initChessableFenTools().
    function getReactFiber(el) {
      if (!el) return null;
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      return key ? el[key] : null;
    }
    function fiberCourseId(props) {
      if (!props || typeof props !== 'object') return null;
      const candidates = [props.courseId, props.courseID, props.course_id, props.course?.id, props.course?.courseId];
      for (const c of candidates) {
        if (c != null && /^\d+$/.test(String(c))) return String(c);
      }
      return null;
    }
    function currentCourseId() {
      const urlM = /\/courses?\/(\d+)(?:\/|$)/.exec(location.pathname);
      if (urlM) return urlM[1];
      for (const a of document.querySelectorAll('a[href*="/course/"]')) {
        const m = /\/course\/(\d+)(?:\/|$)/.exec(a.getAttribute('href') || '');
        if (m) return m[1];
      }
      const anchor = document.getElementById('board') || document.querySelector('[data-square]');
      let fiber = getReactFiber(anchor), depth = 0;
      while (fiber && depth < 60) {
        const id = fiberCourseId(fiber.memoizedProps) || fiberCourseId(fiber.pendingProps);
        if (id) return id;
        fiber = fiber.return; depth++;
      }
      return null;
    }

    // Navigations-/UI-Linktexte auf der Practice-/Learn-Seite, die KEIN Kursname sind
    // (z. B. „Practice Moves", „Learn Moves", „Review", „nächstes Kapitel", „Previous variation").
    // Diese Links/Labels zeigen ebenfalls auf /course/{id}/… bzw. beschriften den Modus und haben
    // sonst den echten Titel verdrängt (Beispiel: gemeldeter Kursname „Practice Moves"/„Learn Moves").
    function isNavLabel(txt) {
      const t = txt.toLowerCase().trim();
      // Eigenständige Nav-/Modus-/UI-Labels (exakter Match — echte Titel wie „Learn Chess Openings" bleiben).
      if (/^(practice( moves)?|learn( moves)?|review|overview|variations?|move ?trainer|next|previous|prev|continue|weiter|home)$/.test(t)) return true;
      // „Next/Previous chapter|variation|move|line" bzw. deutsche Entsprechungen.
      if (/^(next|previous|prev|nächst\w*|naechst\w*|vorherig\w*|vorig\w*|letzt\w*)\b/.test(t)
          && /(chapter|variation|move|line|kapitel|variante|zug|linie)/.test(t)) return true;
      return false;
    }

    // Kursname aus den React-Fiber-Props (autoritativ, gleiche Quelle wie die verlässliche Kurs-ID):
    // das `course`-Objekt trägt neben `id` auch `name`/`title`. Robuster als Seitentext, der im
    // Practice-/Learn-Modus nur das Modus-Label liefert.
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
      let fiber = getReactFiber(anchor), depth = 0;
      while (fiber && depth < 60) {
        const n = fiberCourseName(fiber.memoizedProps) || fiberCourseName(fiber.pendingProps);
        if (n) return n;
        fiber = fiber.return; depth++;
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
      return t || null;
    }

    // Bester verfügbarer Kursname: Chessable-API (autoritativ, via Bearer) > DOM-Heuristik.
    function bestCourseName() {
      return courseNameApi.apiCourseName(currentCourseId()) || currentCourseName();
    }

    function lookupCourseKind() {
      const courseId = currentCourseId();
      if (!courseId || courseId === lookedUpCourseId) return;
      lookedUpCourseId = courseId;
      courseKind = null;
      // Kursname-Karte für den (evtl. neuen) Kurs sicherstellen — force nur bei unbekanntem Kurs.
      courseNameApi.ensureCourseNames(!courseNameApi.apiCourseName(courseId));
      const cfg = readConfig();
      if (!cfg || !cfg.url || !cfg.token) return;
      fetch(String(cfg.url).replace(/\/$/, '') + '/api/extension/repertoires', {
        method: 'GET',
        mode: 'cors',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/json' },
      }).then(r => r.ok ? r.json() : null).then(list => {
        if (!Array.isArray(list)) return;
        const match = list.find(r => r.chessableCourseId === courseId);
        if (match != null) courseKind = match.kind;
      }).catch(() => {});
    }

    function flush(force) {
      if (!force && activeMs < MIN_FLUSH_MS) return;
      const secs = Math.min(MAX_FLUSH_S, Math.round(activeMs / 1000));
      if (secs <= 0) return;

      const cfg = readConfig();
      lastFlush = now();
      if (!cfg || !cfg.url || !cfg.token) { activeMs = 0; movesTrained = 0; return; }

      const moves = movesTrained;
      activeMs = 0; movesTrained = 0;
      const url = String(cfg.url).replace(/\/$/, '') + '/api/extension/training-activity';
      fetch(url, {
        method: 'POST',
        mode: 'cors',
        keepalive: force,
        headers: {
          'Authorization': 'Bearer ' + cfg.token,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ secondsActive: secs, movesTrained: moves, courseKind, courseId: currentCourseId(), courseName: bestCourseName() }),
      }).then((resp) => {
        if (!resp.ok) { activeMs += secs * 1000; movesTrained += moves; }
      }).catch(() => { activeMs += secs * 1000; movesTrained += moves; });
    }

    courseNameApi.ensureCourseNames(false); // Kursname-Karte vorwärmen
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
  }

  // FEN-Tools fuer chessable.com: "Copy FEN"/"Search FEN"-Buttons unten rechts
  // plus XP-Anzeige. Alle Helfer sind hier gekapselt (eigene chessableSearchUrl-
  // Variante mit Kurs-ID), damit nichts mit der Repertoire-Logik kollidiert.
  // Portiert aus github.com/kahalm/chessable-extension (v0.9.4). Im Userscript
  // (Tampermonkey) ist der React-Fiber an den Brett-DOM-Knoten lesbar; in der
  // Extension uebernimmt das die MAIN-World-Datei extension/chessable-fen.js.
  function initChessableFenTools(courseNameApi) {
    if (window.__repcheckChessableFen) return;
    window.__repcheckChessableFen = true;

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
    const FEN_REGEX = /^[1-8rnbqkpRNBQKP/]+\s[wb]\s[KQkqA-Ha-h-]+\s(?:[a-h][1-8]|-)\s\d+\s\d+$/;

    const isValidFen = (s) => typeof s === 'string' && FEN_REGEX.test(s.trim());

    function getReactFiber(el) {
      if (!el) return null;
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      return key ? el[key] : null;
    }

    function collectFenCandidates(props, out) {
      if (!props || typeof props !== 'object') return;
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
      const domPlacement = extractBoardCm();
      if (domPlacement) {
        const matched = candidates.find((c) => c.split(' ')[0] === domPlacement);
        if (matched) return matched;
      }
      return candidates[0];
    }

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

    const extractBoard = () => extractBoardCm() || extractBoardCg();

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

    function copyToClipboard(text) {
      if (typeof GM_setClipboard !== 'undefined') {
        try { GM_setClipboard(text, { type: 'text', mimetype: 'text/plain' }); return true; } catch (e) { /* fallthrough */ }
      }
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

    function chessableCourseSearchUrl(fen) {
      const courseId = currentCourseId();
      if (courseId) {
        // Kursinterne FEN-Suche: "/" -> ";", " " -> %20 (KEIN encodeURIComponent).
        const encoded = fen.replace(/\//g, ';').replace(/ /g, '%20');
        return `https://www.chessable.com/course/${courseId}/fen/${encoded}/`;
      }
      // Fallback: globale FEN-Suche, "/" -> "U".
      const encoded = fen.replace(/\//g, 'U').replace(/ /g, '%20');
      return `https://www.chessable.com/courses/fen/${encoded}/`;
    }

    function debugDump() {
      console.log('[RepCheck Chessable] debug:', {
        url: location.href,
        cmSquaresFound: document.querySelectorAll('[data-square]').length,
        cmPiecesFound: document.querySelectorAll('[data-piece]').length,
        fiberFen: extractFenFromReact(),
        courseId: currentCourseId(),
      });
    }

    // ---- XP-Tracker ----
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
            lastXP = pointsEl.textContent.replace(/[\s ]+/g, '');
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

    // ---- UI ----
    const CONTAINER_ID = 'repcheck-chessable-fen-tools';

    function styleButton(btn, bg) {
      Object.assign(btn.style, {
        padding: '8px 12px', fontSize: '13px', fontFamily: 'system-ui, sans-serif',
        background: bg, color: '#fff', border: 'none', borderRadius: '6px',
        boxShadow: '0 2px 6px rgba(0,0,0,0.3)', cursor: 'pointer', opacity: '0.9',
      });
      btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
      btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.9'; });
    }

    function flash(btn, text, color) {
      const oldText = btn.textContent;
      const oldBg = btn.style.background;
      btn.textContent = text;
      btn.style.background = color;
      setTimeout(() => { btn.textContent = oldText; btn.style.background = oldBg; }, 1200);
    }

    // Mobile: Buttons höher setzen (+ Safe-Area) + umbrechen, damit sie nicht
    // die Firefox-/System-Leiste unten überdecken. !important wegen Inline-Style.
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

    function createUi() {
      if (document.getElementById(CONTAINER_ID)) return;
      injectMobileStyle();
      const wrap = document.createElement('div');
      wrap.id = CONTAINER_ID;
      Object.assign(wrap.style, {
        position: 'fixed', bottom: '16px', right: '16px',
        zIndex: '2147483647', display: 'flex', gap: '8px',
      });

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = 'Copy FEN';
      styleButton(copyBtn, '#2e7d32');
      copyBtn.addEventListener('click', () => {
        const fen = buildFEN();
        if (!fen) { flash(copyBtn, 'No board found', '#c62828'); debugDump(); return; }
        if (copyToClipboard(fen)) flash(copyBtn, 'Copied!', '#1565c0');
        else { flash(copyBtn, 'Copy failed', '#c62828'); console.log('[RepCheck Chessable] FEN:', fen); }
      });

      const analyseBtn = document.createElement('button');
      analyseBtn.type = 'button';
      analyseBtn.textContent = 'Analyse';
      analyseBtn.title = 'Stellung in RookHub analysieren (neuer Tab)';
      styleButton(analyseBtn, '#00695c');
      analyseBtn.addEventListener('click', () => {
        const fen = buildFEN();
        if (!fen) { flash(analyseBtn, 'No board found', '#c62828'); debugDump(); return; }
        let cfg = null;
        try { if (typeof GM_getValue !== 'undefined') cfg = GM_getValue('rookhubConfig', null); } catch (e) {}
        if (!cfg || !cfg.url) { flash(analyseBtn, 'Set RookHub URL', '#c62828'); return; }
        const orient = fen.split(' ')[1] === 'b' ? 'black' : 'white';   // Brett aus Sicht der Seite am Zug
        const url = String(cfg.url).replace(/\/$/, '') + '/analysis?fen=' + encodeURIComponent(fen) + '&orientation=' + orient;
        const win = window.open(url, '_blank', 'noopener');
        if (!win) flash(analyseBtn, 'Popup blocked', '#c62828');
      });

      const searchBtn = document.createElement('button');
      searchBtn.type = 'button';
      searchBtn.textContent = 'Search FEN';
      styleButton(searchBtn, '#1565c0');
      searchBtn.addEventListener('click', () => {
        const fen = buildFEN();
        if (!fen) { flash(searchBtn, 'No board found', '#c62828'); debugDump(); return; }
        const win = window.open(chessableCourseSearchUrl(fen), '_blank', 'noopener');
        if (!win) flash(searchBtn, 'Popup blocked', '#c62828');
      });

      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.textContent = 'Refresh';
      refreshBtn.title = 'Seite neu laden';
      styleButton(refreshBtn, '#616161');
      refreshBtn.addEventListener('click', () => { location.reload(); });

      const rememberBtn = document.createElement('button');
      rememberBtn.type = 'button';
      rememberBtn.textContent = 'Remember line';
      rememberBtn.title = 'Stellung in RookHub merken';
      styleButton(rememberBtn, '#6a1b9a');
      rememberBtn.addEventListener('click', () => rememberLine(rememberBtn));

      // XP-Anzeige vorerst deaktiviert (kommt später wieder) — Badge + Tracker aus.
      wrap.appendChild(copyBtn);
      wrap.appendChild(analyseBtn);
      wrap.appendChild(searchBtn);
      wrap.appendChild(refreshBtn);
      wrap.appendChild(rememberBtn);
      document.body.appendChild(wrap);
    }

    // „Remember line": aktuelle FEN + Kontext an RookHub schicken (zum spaeteren
    // Gebrauch dort gespeichert). Config aus GM-Storage (origin-uebergreifend),
    // Egress per fetch (RookHub-CORS erlaubt chessable.com + POST).
    async function rememberLine(btn) {
      const fen = buildFEN();
      if (!fen) { flash(btn, 'No board found', '#c62828'); debugDump(); return; }
      let cfg = null;
      try { if (typeof GM_getValue !== 'undefined') cfg = GM_getValue('rookhubConfig', null); } catch (e) {}
      if (!cfg || !cfg.url || !cfg.token) { flash(btn, 'Not connected', '#c62828'); return; }
      const base = String(cfg.url).replace(/\/$/, '');
      const oldText = btn.textContent;
      btn.textContent = 'Saving…'; btn.disabled = true;
      // Autoritativen Kursnamen über den Chessable-Bearer bestimmen; bei Miss einmal frisch holen.
      // Bleibt er leer, löst der Server ihn aus dem gespeicherten Bearer des Users auf.
      const courseId = currentCourseId();
      let courseName = courseNameApi ? courseNameApi.apiCourseName(courseId) : null;
      if (!courseName && courseId && courseNameApi) {
        await courseNameApi.ensureCourseNames(true);
        courseName = courseNameApi.apiCourseName(courseId);
      }
      fetch(base + '/api/extension/remember-line', {
        method: 'POST', mode: 'cors',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen, courseId, courseName, sourceUrl: location.href }),
      }).then((resp) => {
        btn.disabled = false; btn.textContent = oldText;
        flash(btn, resp.ok ? 'Remembered!' : 'Failed', resp.ok ? '#2e7d32' : '#c62828');
      }).catch(() => {
        btn.disabled = false; btn.textContent = oldText;
        flash(btn, 'Failed', '#c62828');
      });
    }

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

    // Seit v1.14.0: die FEN-Tools erscheinen NUR im Practice-Mode
    // (chessable.com/practice/…) — sonst nicht.
    function isPracticeMode() {
      return /^\/practice(\/|$)/.test(location.pathname);
    }

    function removeUi() {
      document.getElementById(CONTAINER_ID)?.remove();
      pointsObserver?.disconnect();
      pointsObserver = null;
      watchedNotif = null;
    }

    function ensureUi() {
      if (!isPracticeMode()) { removeUi(); return; }
      createUi();
      // XP-Tracker vorerst deaktiviert (kommt später wieder):
      //   initPointsTracker(); attachNextVariationListener(); if (lastXP) updatePointsDisplay();
    }

    if (document.body) ensureUi();
    else document.addEventListener('DOMContentLoaded', ensureUi, { once: true });

    // Verlaesst der User den Practice-Mode (SPA-Nav), wird die UI wieder entfernt.
    const mo = new MutationObserver(() => {
      if (!isPracticeMode()) { removeUi(); return; }
      if (!document.getElementById(CONTAINER_ID)) ensureUi();
      // initPointsTracker(); // XP-Tracker vorerst deaktiviert
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
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

  console.log('[RepertoireChecker] Userscript v1.11.0 loaded');
})();
