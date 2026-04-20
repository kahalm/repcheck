// ==UserScript==
// @name         Chess.com Repertoire Deviation Checker
// @namespace    https://github.com/chesscom-repertoire
// @version      1.0.1
// @description  Shows where your game deviates from your opening repertoire (PGN files)
// @author       You
// @match        https://www.chess.com/*
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/@mliebelt/pgn-parser@1.4.12/lib/pgn-parser.umd.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────
  const IDB_NAME = 'RepertoireCheckerDB';
  const IDB_STORE = 'handles';
  const IDB_KEY = 'repertoireDir';
  const LS_PREFIX = 'repcheck_';
  const DEVIATION_CLASS = 'repcheck-deviation';
  const BANNER_ID = 'repcheck-banner';
  const PANEL_ID = 'repcheck-panel';

  // ─── State ───────────────────────────────────────────────────────────
  let repertoireTrie = null; // root node of the move trie
  let dirHandle = null;      // FileSystemDirectoryHandle
  let lastUrl = '';          // for SPA navigation detection
  let currentDeviationIndex = -1; // -1 = no deviation found yet

  // ─── IndexedDB helpers ───────────────────────────────────────────────
  function openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
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

  // ─── Repertoire Trie ────────────────────────────────────────────────
  function createTrieNode() {
    return { children: {} };
  }

  function insertLine(root, moves) {
    let node = root;
    for (const move of moves) {
      const san = move.notation ? move.notation.notation : move;
      if (!san) continue;
      if (!node.children[san]) {
        node.children[san] = createTrieNode();
      }
      node = node.children[san];
    }
  }

  function walkPgnMoves(root, moves) {
    // Recursively walk parsed PGN moves (which include variations)
    let node = root;
    for (const move of moves) {
      const san = move.notation ? move.notation.notation : null;
      if (!san) continue;

      if (!node.children[san]) {
        node.children[san] = createTrieNode();
      }
      const next = node.children[san];

      // Process variations (alternative moves at this point)
      if (move.variations && move.variations.length > 0) {
        for (const variation of move.variations) {
          // Each variation is an array of moves starting from the SAME position
          // (i.e., the parent node, not 'next')
          walkPgnMoves(node, variation);
        }
      }

      node = next;
    }
  }

  function buildTrieFromPgns(pgnTexts) {
    const root = createTrieNode();
    for (const text of pgnTexts) {
      try {
        const games = PgnParser.parse(text, { startRule: 'games' });
        for (const game of games) {
          if (game.moves && game.moves.length > 0) {
            walkPgnMoves(root, game.moves);
          }
        }
      } catch (e) {
        console.warn('[RepertoireChecker] PGN parse error:', e);
      }
    }
    return root;
  }

  // ─── File System Access ─────────────────────────────────────────────
  async function pickDirectory() {
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'read' });
      await saveHandle(dirHandle);
      await loadRepertoireFromDir();
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('[RepertoireChecker] Directory picker error:', e);
      }
    }
  }

  async function loadRepertoireFromDir() {
    if (!dirHandle) return false;

    // Verify permission
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

  function getPlayerColor() {
    // Returns 'white' or 'black' or null
    try {
      const board = document.querySelector('wc-chess-board');
      if (!board) return null;
      // Try the game API
      if (board.game && typeof board.game.getPlayingAs === 'function') {
        const c = board.game.getPlayingAs();
        if (c === 1) return 'white';
        if (c === 2) return 'black';
      }
      // Fallback: check board orientation via flipped attribute
      const isFlipped = board.hasAttribute('flipped') || board.classList.contains('flipped');
      return isFlipped ? 'black' : 'white';
    } catch {
      return null;
    }
  }

  function getGameMoves() {
    // Extract SAN moves from the move list
    const moves = [];
    const moveList = document.querySelector('.move-list-component, vertical-move-list, wc-move-list');
    if (!moveList) return moves;

    const nodes = moveList.querySelectorAll('.node');
    for (const node of nodes) {
      // Get the text content, stripping move numbers and annotations
      const figurine = node.querySelector('.figurine-notation, [data-figurine]');
      let san;
      if (figurine) {
        // Figurine notation: piece icon + text
        const piece = figurine.querySelector('[data-figurine]');
        const pieceChar = piece ? piece.getAttribute('data-figurine') : '';
        const rest = figurine.textContent.replace(piece ? piece.textContent : '', '').trim();
        san = pieceChar + rest;
      } else {
        san = node.textContent.trim();
      }

      // Clean up: remove move numbers like "1." "2..." etc, annotations, result
      san = san.replace(/^\d+\.+\s*/, '').trim();
      // Skip results
      if (['1-0', '0-1', '1/2-1/2', '*'].includes(san)) continue;
      // Remove annotation symbols
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
        return i; // first deviation
      }
    }
    return -1; // all moves in repertoire
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
      // Find a good insertion point above the move list
      const moveListContainer =
        document.querySelector('.sidebar-container') ||
        document.querySelector('.sidebar-tabbed-content') ||
        document.querySelector('.move-list-wrapper') ||
        document.querySelector('.move-list-component')?.parentElement ||
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
    // Remove previous highlights
    document.querySelectorAll(`.${DEVIATION_CLASS}`).forEach(el => el.classList.remove(DEVIATION_CLASS));

    if (index < 0) return;

    const moveList = document.querySelector('.move-list-component, vertical-move-list, wc-move-list');
    if (!moveList) return;

    const nodes = moveList.querySelectorAll('.node');
    if (index < nodes.length) {
      nodes[index].classList.add(DEVIATION_CLASS);
      // Scroll into view
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

    const hasFileSystemAPI = typeof window.showDirectoryPicker === 'function';

    panel.innerHTML = `
      <h3>Repertoire Settings</h3>
      ${hasFileSystemAPI ? `
        <div style="margin-bottom: 12px;">
          <strong>Load from folder:</strong><br>
          <button id="repcheck-pick-dir">Select PGN Folder</button>
          <span style="font-size:12px;color:#888;margin-left:6px;">${dirHandle ? '(folder selected)' : '(no folder selected)'}</span>
        </div>
        <hr style="border-color:#444;margin:12px 0;">
      ` : `
        <div style="margin-bottom:12px;font-size:12px;color:#f90;">
          File System Access API not available. Use the textarea below.
        </div>
      `}
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

    // Event listeners
    document.getElementById('repcheck-pick-dir')?.addEventListener('click', async () => {
      await pickDirectory();
    });

    document.getElementById('repcheck-load-pgn').addEventListener('click', () => {
      const textarea = document.getElementById('repcheck-pgn-input');
      loadRepertoireFromText(textarea.value);
    });

    document.getElementById('repcheck-close').addEventListener('click', togglePanel);
  }

  // ─── Main Check Logic ───────────────────────────────────────────────
  function runCheck() {
    if (!isReviewPage()) return;
    if (!repertoireTrie) {
      showBanner('No repertoire loaded — click \u2699 to set up', 'no-repertoire');
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

    // Clean up previous UI
    document.getElementById(BANNER_ID)?.remove();
    document.querySelectorAll(`.${DEVIATION_CLASS}`).forEach(el => el.classList.remove(DEVIATION_CLASS));

    if (isReviewPage()) {
      // Wait for move list to render, then run check
      waitForMoveList().then(() => runCheck());
    }
  }

  function waitForMoveList(timeout = 10000) {
    return new Promise((resolve) => {
      const selector = '.move-list-component .node, vertical-move-list .node, wc-move-list .node';
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
        resolve(); // resolve anyway after timeout
      }, timeout);
    });
  }

  // Also re-check when moves change (user navigates through moves)
  function observeMoveListChanges() {
    const observer = new MutationObserver(() => {
      if (isReviewPage() && repertoireTrie) {
        // Debounce
        clearTimeout(observeMoveListChanges._timer);
        observeMoveListChanges._timer = setTimeout(runCheck, 300);
      }
    });

    // Observe the whole body for move list changes (SPA may rebuild DOM)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  async function init() {
    injectStyles();

    // Try to restore saved directory handle
    try {13:51 20.04.2026      dirHandle = await loadHandle();
      if (dirHandle) {
        await loadRepertoireFromDir();
      }
    } catch (e) {
      console.log('[RepertoireChecker] No saved directory handle:', e);
    }

    // Watch for SPA navigation
    const navObserver = new MutationObserver(() => onPageChange());
    navObserver.observe(document.body, { childList: true, subtree: true });

    // Also watch popstate for back/forward navigation
    window.addEventListener('popstate', () => setTimeout(onPageChange, 100));

    // Observe move list changes
    observeMoveListChanges();

    // Initial check
    onPageChange();
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
