// RepCheck — Opening Repertoire Deviation Checker — Content script.
//
// Gleiche Logik wie das Tampermonkey-Userscript im Root des Repos
// (`repcheck.user.js`), aber fuer den Browser-Extension-Kontext
// angepasst: RookHub-Fetches laufen ueber den Background-Service-Worker
// (`background.js`), damit CORS unabhaengig von der RookHub-Server-Policy
// klappt. IndexedDB-Layout (DB `RepertoireCheckerDB`) ist identisch — User
// koennen vom Userscript zur Extension wechseln, ohne URL/Token erneut zu
// hinterlegen.

(function () {
  'use strict';

  // Seit v1.4.8: Content-Script wird NICHT mehr automatisch geladen. Das
  // Popup injiziert chess.min.js + content.js erst auf Klick via
  // chrome.scripting.executeScript. Der Guard hier verhindert doppelte
  // Initialisierung bei wiederholtem Klick im selben Tab.
  if (window.__rdc_loaded) {
    return; // Funktionen liegen schon auf window.__rdc; Popup ruft sie direkt.
  }

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
  const PANEL_ID = 'repcheck-panel';
  // Oeffentliche Default-Instanz fuer Erst-Nutzer (Vorbefuellung im Panel +
  // Registrierungs-Link).
  const ROOKHUB_DEFAULT_URL = 'https://rookhub.oberschmid.homes';

  // ─── State ───────────────────────────────────────────────────────────
  let repertoirePositions = null; // Set<string> of normalized FENs (transposition-aware)
  let dirHandle = null;
  let lastUrl = '';
  let currentDeviationIndex = -1;
  let lastGameMovesKey = '';   // Cache: skip analyzeGame wenn Zuege unveraendert
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
    // Zusaetzlich nach chrome.storage.local spiegeln: IndexedDB ist origin-scoped,
    // also auf chess.com/lichess. Das Chessable-Activity-Script (chessable.com-Origin)
    // kann diese IDB NICHT lesen — chrome.storage.local ist hingegen extension-weit
    // (origin-uebergreifend) und liefert ihm so URL+Token.
    try {
      if (cfg && cfg.url && cfg.token) {
        chrome.storage.local.set({ rookhubConfig: { url: cfg.url, token: cfg.token } });
      }
    } catch (e) { /* storage nicht verfuegbar — ignorieren */ }
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
  // Fetch laeuft ueber den Background-Service-Worker — der hat `host_permissions`
  // und ist nicht an die Page-CORS-Policy gebunden. Das macht die Extension
  // robust gegenueber RookHub-Instanzen, deren CORS-Policy chess.com nicht
  // explizit erlaubt.
  function rookhubProxy(req) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          Object.assign({ type: 'rookhub-fetch' }, req),
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
              return;
            }
            if (!response) {
              reject(new Error('no response from background worker'));
              return;
            }
            resolve(response);
          }
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  // POST /api/extension/analyze-game. Antwort:
  // { deviation, gaps, inRepertoire, fenBeforeDeviation, repertoireFileCount, illegalMoveAt }.
  async function rookhubAnalyzeGame(cfg, moves, options) {
    if (!cfg || !cfg.url || !cfg.token) throw new Error('RookHub: URL oder Token fehlt.');
    const url = cfg.url.replace(/\/$/, '') + '/api/extension/analyze-game';
    const resp = await rookhubProxy({
      url,
      method: 'POST',
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
      expect: 'json',
    });
    if (resp.status === 401) throw new Error('Token ungültig oder abgelaufen.');
    if (!resp.ok) throw new Error(resp.error || ('RookHub HTTP ' + resp.status));
    return resp.body;
  }

  // Schickt die SAN-Zugliste + Best-Effort-Metadaten; der Server baut daraus das PGN
  // (reicheres Format als ein vorgebautes PGN: Spieler/Ergebnis/Game-ID für Dedup + Anzeige).
  async function rookhubSaveGame(cfg, moves, meta) {
    if (!cfg || !cfg.url || !cfg.token) throw new Error('RookHub: URL oder Token fehlt.');
    const url = cfg.url.replace(/\/$/, '') + '/api/extension/games';
    const resp = await rookhubProxy({
      url,
      method: 'POST',
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
      }),
      expect: 'json',
    });
    if (resp.status === 401) throw new Error('Token ungültig oder abgelaufen.');
    if (!resp.ok) throw new Error(resp.error || ('RookHub HTTP ' + resp.status));
    return resp.body;
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

  function normalizedFen(fen) {
    // Nur die ersten 4 Felder (Stellung, Seite, Rochaderechte, en-passant).
    // Halbzug- und Vollzugzaehler spielen fuer Repertoire-Matching keine Rolle.
    return fen.split(' ').slice(0, 4).join(' ');
  }

  function walkMovesForPositions(chess, moves, positions) {
    // Wir nutzen denselben Chess-Instanz fuer alle Varianten und stellen den
    // Stand am Ende per undo() wieder her. Ersetzt das alte `new Chess(fen())`
    // pro Variante (FEN-Serialize+Parse-Roundtrip war der Haupt-CPU-Fresser).
    let movesMade = 0;
    for (const move of moves) {
      // Varianten zweigen VOR diesem Zug ab
      if (move.variations && move.variations.length > 0) {
        for (const variation of move.variations) {
          walkMovesForPositions(chess, variation, positions);
        }
      }
      const result = chess.move(move.san);
      if (!result) break; // illegaler Zug im PGN
      movesMade++;
      positions.add(normalizedFen(chess.fen()));
    }
    for (let i = 0; i < movesMade; i++) chess.undo();
  }

  function buildPositionSetFromPgns(pgnTexts) {
    const positions = new Set();
    positions.add(normalizedFen(new Chess().fen())); // Ausgangsstellung einschliessen
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
        if (/^\/[A-Za-z0-9]{8,12}(\/(white|black))?\/?$/.test(location.pathname)) return true;
        return !!document.querySelector('.tview2, .analyse__moves');
      },
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

  // Spielernamen aus og:title / document.title ("A vs B") best-effort lesen.
  function parsePlayersFromMeta() {
    try {
      const og = document.querySelector('meta[property="og:title"]');
      const t = (og && og.content) || document.title || '';
      const m = t.match(/(.+?)\s+(?:vs\.?|–|-)\s+(.+?)(?:\s+(?:in|•|\||\(|,)|$)/i);
      if (m) return { white: m[1].trim().slice(0, 120), black: m[2].trim().slice(0, 120) };
    } catch (e) {}
    return { white: null, black: null };
  }

  // Metadaten der aktuellen Partie (Quelle, externe ID, Spieler, Ergebnis, URL).
  function getGameMeta() {
    const site = detectSiteKey();
    const meta = {
      source: site === 'chesscom' ? 'chess.com' : 'lichess',
      externalId: null,
      result: getGameResult(),
      sourceUrl: location.href,
      white: null,
      black: null,
    };
    try {
      if (site === 'lichess') {
        const m = location.pathname.match(/^\/([A-Za-z0-9]{8,12})/);
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
    return meta;
  }

  function analyzeGame(gameMoves) {
    // Returns { deviation: int, gaps: int[] }
    // deviation: Index des ersten dauerhaften Ausreissers (-1 = kein)
    // gaps: Indizes temporaerer Ausreisser (Zugumstellungen, Partie kehrt spaeter zurueck)
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
         und Lichess teilen sich dasselbe dezente Dark/Light-Styling oben. */
    `;
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
    btn.addEventListener('click', () => {
      lastGameMovesKey = '';
      rdcRunCheck();
    });
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
    if (!wrap) return; // ohne Container nichts zu tun (kein Review-Modus)
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
      // Oben (vor dem Pruefen-Button) einfuegen.
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
      const moves = getGameMoves();
      if (!moves.length) return;
      btn.textContent = '…';
      btn.disabled = true;
      const reset = (label, title) => setTimeout(() => {
        btn.textContent = label; btn.title = title; btn.disabled = false;
      }, 1500);
      try {
        const saved = await rookhubSaveGame(currentCfg, moves, getGameMeta());
        const link = buildShareLink(currentCfg, saved);
        let copied = false;
        if (link) {
          try { await navigator.clipboard.writeText(link); copied = true; }
          catch (e) { /* Clipboard evtl. ohne User-Geste blockiert */ }
        }
        btn.textContent = copied ? '🔗' : '✓';
        btn.title = copied ? 'Gespeichert · Teilen-Link kopiert' : 'Partie gespeichert';
        reset('💾', 'Partie in RookHub speichern');
      } catch (e) {
        btn.textContent = '✗';
        reset('💾', 'Partie in RookHub speichern');
        console.warn('[RepertoireChecker] Save failed:', e);
      }
    });
    wrap.appendChild(btn);
  }

  function removeFloatingControls() {
    document.getElementById('repcheck-floating-wrap')?.remove();
  }

  function refreshFloatingButton() {
    // Bei echter Navigation den Deviation-Cache zuruecksetzen, damit der
    // Chessable-Button nicht mit einem stale-FEN aus einem anderen Spiel
    // verlinkt.
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

  // Seit v1.14.0 (nur EXTENSION): der fr\u00fchere \u2699-Indikator (Status + Settings-
  // \u00d6ffner) ist entfernt. Einstellungen laufen ausschlie\u00dflich \u00fcber das Popup
  // (\u201eEinstellungen"); das Pr\u00fcf-Ergebnis bleibt direkt in der Zugliste farblich
  // markiert (highlightDeviation). showBanner bleibt als No-op, damit die
  // bestehenden Aufrufer unver\u00e4ndert bleiben.
  // \u26a0\ufe0f Userscript-Sync: Im Userscript bleibt showBanner AKTIV (kein Popup dort).
  function showBanner(_message, _type) { /* extension: kein \u2699-Banner mehr */ }

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

  // ─── Lazy bootstrap (nur bei Klick, nicht beim Page-Load) ───────────
  // Stellt sicher, dass repertoirePositions geladen ist. Bei kaltem Tab
  // liest das Set einmalig aus IndexedDB. Migration vom alten pgnTexts-
  // Cache findet hier auch statt, falls noetig.
  async function ensurePositionSet() {
    if (repertoirePositions) return true;
    try {
      const cached = await loadPositionSetCache();
      if (cached && Array.isArray(cached.fens) && cached.fens.length > 0) {
        repertoirePositions = new Set(cached.fens);
        return true;
      }
    } catch (e) {
      console.log('[RepertoireChecker] Position-Cache nicht lesbar:', e);
    }
    // Migration: aus altem pgnTexts-Cache neu bauen, falls vorhanden.
    try {
      const rh = await loadRookhubCache();
      if (rh && Array.isArray(rh.pgnTexts) && rh.pgnTexts.length > 0) {
        repertoirePositions = await buildAndSavePositionSet(rh.pgnTexts);
        return true;
      }
    } catch (e) {
      console.log('[RepertoireChecker] RookHub-PGN-Cache nicht lesbar:', e);
    }
    return false;
  }

  // Wird vom Popup via chrome.scripting.executeScript aufgerufen.
  // Laedt (falls noetig) das Position-Set und fuehrt einen Check aus.
  async function rdcRunCheck() {
    injectStyles();
    await ensurePositionSet();
    // Re-load dirHandle on demand (falls Nutzer per Folder konfiguriert ist).
    if (!repertoirePositions && !dirHandle) {
      try { dirHandle = await loadHandle(); } catch (e) {}
      if (dirHandle) {
        await loadRepertoireFromDir();
      }
    }
    lastGameMovesKey = ''; // immer frisch pruefen
    runCheck();
  }

  // Wird vom Popup aufgerufen, um das Settings-Panel zu oeffnen.
  function rdcOpenSettings() {
    injectStyles();
    if (!document.getElementById(PANEL_ID)) togglePanel();
  }

  window.__rdc_loaded = {
    runCheck: rdcRunCheck,
    openSettings: rdcOpenSettings,
    refreshButton: refreshFloatingButton,
    version: '1.12.0',
  };

  // ─── Lightweight SPA-Navigation Watch ───────────────────────────────
  // Beobachtet NUR den <title>-Knoten und popstate-Events. Kein subtree-
  // Observer auf document.body, also praktisch kostenlos im Idle.
  // Bei jeder Navigation: pruefen, ob Review-Seite, und Button ein/ausblenden.
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

  console.log('[RepertoireChecker] Extension v1.12.0 loaded');
})();
