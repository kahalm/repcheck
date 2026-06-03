// Chess.com Repertoire Deviation Checker — Content script.
//
// Gleiche Logik wie das Tampermonkey-Userscript im Root des Repos
// (`chesscom_repertoire.user.js`), aber fuer den Browser-Extension-Kontext
// angepasst: RookHub-Fetches laufen ueber den Background-Service-Worker
// (`background.js`), damit CORS unabhaengig von der RookHub-Server-Policy
// klappt. IndexedDB-Layout (DB `RepertoireCheckerDB`) ist identisch — User
// koennen vom Userscript zur Extension wechseln, ohne URL/Token erneut zu
// hinterlegen.

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
  const DEVIATION_CLASS = 'repcheck-deviation';
  const BANNER_ID = 'repcheck-banner';
  const PANEL_ID = 'repcheck-panel';
  // Soft-Limit: ueber dieser Summe (Bytes) zeigt das UI eine Warnung vor dem Laden.
  const ROOKHUB_SOFT_LIMIT = 5 * 1024 * 1024;

  // ─── State ───────────────────────────────────────────────────────────
  let repertoireTrie = null;
  let dirHandle = null;
  let lastUrl = '';
  let currentDeviationIndex = -1;

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

  function loadRookhubCache() {
    return idbGet(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CACHE_KEY);
  }

  function saveRookhubCache(cache) {
    return idbPut(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CACHE_KEY, cache);
  }

  // ─── RookHub Fetch ──────────────────────────────────────────────────
  // Holt zuerst die Repertoire-Liste (?kind=opening), dann die einzelnen
  // PGN-Texte. Soft-Limit-Pruefung vor dem Pull der PGNs.

  // Fetch laeuft ueber den Background-Service-Worker — der hat `host_permissions`
  // und ist nicht an die Page-CORS-Policy gebunden. Das macht die Extension
  // robust gegenueber RookHub-Instanzen, deren CORS-Policy chess.com nicht
  // explizit erlaubt.
  function rookhubProxy(url, headers, expect) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'rookhub-fetch', url, headers, expect },
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

  async function rookhubFetchOpeningList(baseUrl, token) {
    const url = baseUrl.replace(/\/$/, '') + '/api/extension/repertoires?kind=opening';
    const resp = await rookhubProxy(url, {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json',
    }, 'json');
    if (resp.status === 401) throw new Error('Token ungültig oder abgelaufen.');
    if (!resp.ok) throw new Error(resp.error || ('RookHub HTTP ' + resp.status));
    return resp.body; // Array von { id, name, fileCount, kind, totalSizeBytes }
  }

  async function rookhubFetchPgn(baseUrl, token, id) {
    const url = baseUrl.replace(/\/$/, '') + '/api/extension/repertoires/' + id + '/pgn';
    const resp = await rookhubProxy(url, {
      'Authorization': 'Bearer ' + token,
      'Accept': 'text/plain',
    }, 'text');
    if (!resp.ok) throw new Error(resp.error || ('RookHub HTTP ' + resp.status + ' fuer Puzzle ' + id));
    return resp.body;
  }

  async function loadRepertoireFromRookHub(cfg, options) {
    if (!cfg || !cfg.url || !cfg.token) {
      throw new Error('RookHub: URL oder Token fehlt.');
    }
    const list = await rookhubFetchOpeningList(cfg.url, cfg.token);
    if (!list || list.length === 0) {
      updateStatusText('Keine Eröffnungs-Repertoires in RookHub gefunden.');
      return;
    }
    const totalBytes = list.reduce((s, r) => s + (r.totalSizeBytes || 0), 0);
    if (totalBytes > ROOKHUB_SOFT_LIMIT && !(options && options.skipWarning)) {
      const mb = (totalBytes / 1024 / 1024).toFixed(1);
      if (!confirm('Es werden ' + list.length + ' Repertoires geladen — zusammen ' + mb + ' MB. Fortfahren?')) {
        updateStatusText('Laden abgebrochen.');
        return;
      }
    }
    const pgnTexts = [];
    for (const repo of list) {
      try {
        const txt = await rookhubFetchPgn(cfg.url, cfg.token, repo.id);
        if (txt) pgnTexts.push(txt);
      } catch (e) {
        console.warn('[RepertoireChecker] RookHub PGN-Fetch fehlgeschlagen:', e);
      }
    }
    if (pgnTexts.length === 0) {
      updateStatusText('RookHub: keine PGNs geladen.');
      return;
    }
    repertoireTrie = buildTrieFromPgns(pgnTexts);
    await saveRookhubCache({ pgnTexts, savedAt: Date.now(), count: pgnTexts.length });
    updateStatusText('RookHub: ' + pgnTexts.length + ' Eröffnungen geladen');
    runCheck();
  }

  // ─── Repertoire Trie ────────────────────────────────────────────────
  function createTrieNode() {
    return { children: {} };
  }

  function walkParsedMoves(root, moves) {
    let node = root;
    for (const move of moves) {
      const san = move.san;
      if (!san) continue;

      if (!node.children[san]) {
        node.children[san] = createTrieNode();
      }
      const next = node.children[san];

      // Process variations (alternative moves at this point)
      if (move.variations && move.variations.length > 0) {
        for (const variation of move.variations) {
          walkParsedMoves(node, variation);
        }
      }

      node = next;
    }
  }

  function buildTrieFromPgns(pgnTexts) {
    const root = createTrieNode();
    for (const text of pgnTexts) {
      try {
        const games = parsePgnText(text);
        for (const moves of games) {
          walkParsedMoves(root, moves);
        }
      } catch (e) {
        console.warn('[RepertoireChecker] PGN parse error:', e);
      }
    }
    return root;
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

    Promise.all(pgnFiles.map(f => f.text())).then(pgnTexts => {
      repertoireTrie = buildTrieFromPgns(pgnTexts);
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
      repertoireTrie = buildTrieFromPgns(pgnTexts);
      updateStatusText(`Repertoire loaded: ${pgnTexts.length} file(s)`);
      runCheck();
      return true;
    } else {
      updateStatusText('No .pgn files found in folder');
      return false;
    }
  }

  function loadRepertoireFromText(pgnText) {
    if (!pgnText.trim()) return;
    repertoireTrie = buildTrieFromPgns([pgnText]);
    updateStatusText('Repertoire loaded from text');
    runCheck();
  }

  // ─── Chess.com Integration ──────────────────────────────────────────
  function isReviewPage() {
    const url = location.pathname;
    return url.includes('/analysis/game/') || url.includes('/game/review/');
  }

  function getGameMoves() {
    const moves = [];
    const moveList = document.querySelector('.move-list, vertical-move-list, wc-move-list');
    if (!moveList) return moves;

    const nodes = moveList.querySelectorAll('.node');
    for (const node of nodes) {
      const figurineEl = node.querySelector('[data-figurine]');
      let san;
      if (figurineEl) {
        san = figurineEl.getAttribute('data-figurine') + node.textContent.trim();
      } else {
        san = node.textContent.trim();
      }

      san = san.replace(/^\d+\.+\s*/, '').trim();
      if (['1-0', '0-1', '1/2-1/2', '*'].includes(san)) continue;
      san = san.replace(/[?!]+$/, '').trim();
      if (san) moves.push(san);
    }
    return moves;
  }

  function findDeviation(gameMoves) {
    if (!repertoireTrie) return -1;

    let node = repertoireTrie;
    for (let i = 0; i < gameMoves.length; i++) {
      const san = gameMoves[i];
      if (node.children[san]) {
        node = node.children[san];
      } else {
        return i;
      }
    }
    return -1;
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
    `;
    document.head.appendChild(style);
  }

  function updateStatusText(text) {
    const el = document.getElementById('repcheck-status');
    if (el) el.textContent = text;
  }

  function showBanner(message, type) {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      const moveListContainer =
        document.querySelector('.move-list')?.parentElement ||
        document.querySelector('.analysis-view-movelist')?.parentElement ||
        document.querySelector('.sidebar-container') ||
        document.querySelector('.sidebar-tabbed-content') ||
        document.querySelector('vertical-move-list')?.parentElement;

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

  function highlightDeviation(index) {
    document.querySelectorAll(`.${DEVIATION_CLASS}`).forEach(el => el.classList.remove(DEVIATION_CLASS));

    if (index < 0) return;

    const moveList = document.querySelector('.move-list, vertical-move-list, wc-move-list');
    if (!moveList) return;

    const nodes = moveList.querySelectorAll('.node');
    if (index < nodes.length) {
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
    loadRookhubConfig().then(cfg => {
      const urlInput = document.getElementById('repcheck-rookhub-url');
      const tokenInput = document.getElementById('repcheck-rookhub-token');
      if (cfg && urlInput) urlInput.value = cfg.url || '';
      if (cfg && tokenInput) tokenInput.value = cfg.token || '';
    }).catch(() => {});

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
        <span style="font-size:11px;color:#888;">Token im RookHub-Profil → „Extension-Tokens".</span>
      </div>
      <hr style="border-color:#444;margin:12px 0;">
      <div style="margin-bottom: 12px;">
        <strong>Load from folder:</strong><br>
        <button id="repcheck-pick-dir">Select PGN Folder</button>
        <span id="repcheck-folder-info" style="font-size:12px;color:#888;margin-left:6px;">${repertoireTrie ? '(loaded)' : '(no folder selected)'}</span>
      </div>
      <hr style="border-color:#444;margin:12px 0;">
      <div>
        <strong>Or paste PGN:</strong><br>
        <textarea id="repcheck-pgn-input" placeholder="Paste your repertoire PGN here..."></textarea>
        <button id="repcheck-load-pgn">Load PGN</button>
        <button id="repcheck-close" class="secondary">Close</button>
      </div>
      <div class="status" id="repcheck-status">
        ${repertoireTrie ? 'Repertoire loaded' : 'No repertoire loaded'}
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
        updateStatusText('RookHub: lade…');
        await loadRepertoireFromRookHub({ url, token });
      } catch (e) {
        updateStatusText('RookHub: ' + e.message);
      }
    });

    document.getElementById('repcheck-rookhub-refresh')?.addEventListener('click', async () => {
      const cfg = await loadRookhubConfig();
      if (!cfg) { updateStatusText('RookHub: noch nicht konfiguriert.'); return; }
      try {
        updateStatusText('RookHub: aktualisiere…');
        await loadRepertoireFromRookHub(cfg);
      } catch (e) {
        updateStatusText('RookHub: ' + e.message);
      }
    });
  }

  // ─── Main Check Logic ───────────────────────────────────────────────
  function runCheck() {
    if (!isReviewPage()) return;
    if (!repertoireTrie) {
      showBanner('No repertoire loaded \u2014 click \u2699 to set up', 'no-repertoire');
      return;
    }

    const gameMoves = getGameMoves();
    if (gameMoves.length === 0) {
      showBanner('No moves found', 'no-repertoire');
      return;
    }

    const deviationIdx = findDeviation(gameMoves);
    currentDeviationIndex = deviationIdx;

    if (deviationIdx >= 0) {
      const moveNum = Math.floor(deviationIdx / 2) + 1;
      const color = deviationIdx % 2 === 0 ? 'White' : 'Black';
      showBanner(`Out of repertoire at move ${moveNum} (${color}: ${gameMoves[deviationIdx]})`, 'deviation');
      highlightDeviation(deviationIdx);
    } else {
      showBanner('Game fully within repertoire \u2713', 'in-repertoire');
      highlightDeviation(-1);
    }
  }

  // ─── SPA Navigation & Initialization ────────────────────────────────
  function onPageChange() {
    const url = location.href;
    if (url === lastUrl) return;
    lastUrl = url;

    document.getElementById(BANNER_ID)?.remove();
    document.querySelectorAll(`.${DEVIATION_CLASS}`).forEach(el => el.classList.remove(DEVIATION_CLASS));

    if (isReviewPage()) {
      waitForMoveList().then(() => runCheck());
    }
  }

  function waitForMoveList(timeout = 10000) {
    return new Promise((resolve) => {
      const selector = '.move-list .node, vertical-move-list .node, wc-move-list .node';
      if (document.querySelector(selector)) {
        resolve();
        return;
      }

      const observer = new MutationObserver(() => {
        if (document.querySelector(selector)) {
          observer.disconnect();
          resolve();
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        resolve();
      }, timeout);
    });
  }

  function observeMoveListChanges() {
    const observer = new MutationObserver(() => {
      if (isReviewPage() && repertoireTrie) {
        clearTimeout(observeMoveListChanges._timer);
        observeMoveListChanges._timer = setTimeout(runCheck, 300);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  async function init() {
    console.log('[RepertoireChecker] Extension v1.3.0 initializing');
    injectStyles();

    // 1) RookHub-Cache laden, wenn vorhanden — gibt sofortige Verfuegbarkeit, auch
    //    wenn die API offline ist. Server-Refresh laeuft anschliessend im Hintergrund.
    let cacheLoaded = false;
    try {
      const cache = await loadRookhubCache();
      if (cache && Array.isArray(cache.pgnTexts) && cache.pgnTexts.length > 0) {
        repertoireTrie = buildTrieFromPgns(cache.pgnTexts);
        updateStatusText('RookHub (Cache): ' + cache.pgnTexts.length + ' Eröffnungen');
        cacheLoaded = true;
      }
    } catch (e) {
      console.log('[RepertoireChecker] RookHub-Cache nicht lesbar:', e);
    }

    // 2) RookHub-Refresh im Hintergrund, wenn konfiguriert. Fehler nur loggen.
    try {
      const cfg = await loadRookhubConfig();
      if (cfg && cfg.url && cfg.token) {
        loadRepertoireFromRookHub(cfg, { skipWarning: true }).catch(e => {
          console.warn('[RepertoireChecker] RookHub Hintergrund-Refresh:', e.message);
        });
      }
    } catch (e) {
      console.log('[RepertoireChecker] RookHub-Config nicht lesbar:', e);
    }

    // 3) Fallback: lokaler Folder-Handle, wenn (noch) kein Trie vorhanden.
    if (!cacheLoaded) {
      try {
        dirHandle = await loadHandle();
        if (dirHandle) {
          await loadRepertoireFromDir();
        }
      } catch (e) {
        console.log('[RepertoireChecker] No saved directory handle:', e);
      }
    }

    const navObserver = new MutationObserver(() => onPageChange());
    navObserver.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('popstate', () => setTimeout(onPageChange, 100));

    observeMoveListChanges();

    onPageChange();
    console.log('[RepertoireChecker] Ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
