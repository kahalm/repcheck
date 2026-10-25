// RepCheck — Opening Repertoire Deviation Checker — Content script fuer chess.com und lichess.
//
// Hauptlogik der Extension auf den Partie-Seiten. RookHub-Fetches laufen ueber den
// Background-Service-Worker (`background.js`), damit CORS unabhaengig von der RookHub-Server-Policy
// klappt. Das IndexedDB-Layout (DB `RepertoireCheckerDB`) ist seit der Userscript-Zeit unveraendert.

(function () {
  'use strict';

  // Das Manifest laedt dieses Skript (mit chess.min.js und den Libs davor) auf JEDER chess.com- und
  // lichess-Seite (`content_scripts`). Das Popup injiziert es per chrome.scripting.executeScript nur
  // nach, wenn ein Tab es noch nicht hat (etwa ein Tab, der schon vor Installation oder Update der
  // Extension offen war). Der Guard verhindert dann die doppelte Initialisierung.
  if (window.__rdc_loaded) {
    return; // Funktionen liegen schon auf window.__rdc_loaded; das Popup ruft sie direkt.
  }

  // ─── State ───────────────────────────────────────────────────────────
  let repertoirePositions = null; // Set<string> of normalized FENs (transposition-aware)
  let dirHandle = null;
  let lastUrl = '';
  let currentDeviationIndex = -1;
  let lastGameMovesKey = '';   // Cache: skip analyzeGame wenn Zuege unveraendert
  let lastDeviationFen = null; // FEN vor dem Out-of-Rep-Zug fuer Chessable-Suche

  // ─── Shared-Core-Helfer (extension/lib/repertoire-text.js) ──────────
  // Reine Text-/PGN-/FEN-Logik lebt EINMAL im Shared-Core, der als Content-Script
  // VOR content.js geladen wird (Manifest content_scripts + Popup-executeScript) →
  // self.RepCheckLib. Keine Inline-Kopien mehr (früher hier + userscript + lib
  // dreifach). tokenizePgn/isMoveToken/parseMoveTokens/parsePgnText: PGN→Zugbaum;
  // normalizedFen: 4-Feld-FEN fürs Repertoire-Matching; chessComPlayedAt: Header→ISO;
  // chessableSearchUrl: globale Chessable-FEN-Such-URL; lichessGameId: Partie-Id nur aus
  // echten lichess-Partie-Adressen (nie aus /analysis, /training …).
  const {
    tokenizePgn, isMoveToken, parseMoveTokens, parsePgnText,
    normalizedFen, chessComPlayedAt, chessableSearchUrl, lichessGameId, fetchMetaWithRetry,
  } = (self.RepCheckLib || {});

  // ─── Teil-Dateien verdrahten (content/*.js, per Manifest VOR dieser Datei geladen) ─────────
  // Seit der Zerlegung Z37 liegen Speicher, RookHub-Aufrufe, Partie-Metadaten, Stylesheet und Partien-Uebersicht in eigenen Dateien. Ihre Funktionen
  // stehen beim Laden schon bereit; was sie von hier brauchen, bekommen sie per init() — vor allem anderen, damit kein
  // Rueckruf (Storage, Navigation) eine Teil-Datei ohne ihre Abhaengigkeiten erreicht.
  const C = self.RepCheckContent;
  const {
    saveHandle, loadHandle, loadRookhubConfig, loadRookhubCache, loadPositionSetCache, savePositionSetCache,
  } = C.store;
  const {
    rookhubAnalyzeGame, rookhubSaveGame, rookhubKnownGames, rookhubAnalyzeSavedGame, buildShareLink,
  } = C.rookhubApi;
  const { getGameMeta, fetchChessComHeaders, fetchLichessGame } = C.gameMeta;
  const { DEVIATION_CLASS, GAP_CLASS, IN_REP_CLASS, PANEL_ID, injectStyles } = C.styles;
  const { OVERVIEW_SWEEP_MS, syncOverviewGames } = C.overview;
  C.rookhubApi.init({ t });
  C.gameMeta.init({ getAdapter, detectSiteKey });
  C.overview.init({
    t, detectSiteKey, loadRookhubConfig, injectStyles,
    rookhubKnownGames, rookhubSaveGame, rookhubAnalyzeSavedGame, fetchChessComHeaders, fetchLichessGame,
  });

  // ─── Sprache (geteilte Tabelle, extension/lib/i18n.js) ──────────────
  // lib/i18n.js wird als Content-Script VOR content.js geladen (Manifest
  // content_scripts + Popup-executeScript) → self.RepCheckI18n. Die ausdrueckliche
  // Wahl des Nutzers steht in chrome.storage.local unter `rcLang` ('en'|'de'|'hr');
  // fehlt sie, entscheidet die Browsersprache.
  let rcLang = self.RepCheckI18n.resolveLang(null, navigator.languages);
  /** Ausdrückliche Wahl des Nutzers ('' = Automatik) — nur für die Anzeige im Panel. */
  let rcGespeicherteSprache = '';
  /** Welche Sprache die Automatik wählen würde — für die Beschriftung „Automatisch (…)". */
  function rcAutoLang() {
    return self.RepCheckI18n.resolveLang(null, navigator.languages);
  }

  function t(key, params) { return self.RepCheckI18n.translate(rcLang, key, params); }

  // Uebersetzten Text fuer die innerHTML-Vorlage des Panels entschaerfen.
  const RC_HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function rcEscHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => RC_HTML_ESCAPES[c]);
  }

  // Nach einem Sprachwechsel das offene Panel neu zeichnen (sonst blieben die
  // Texte bis zum naechsten Oeffnen stehen).
  function rcApplyLang() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.innerHTML = panelHtml();
    wirePanelEvents();
  }

  try {
    chrome.storage.local.get(['rcLang'], (r) => {
      rcGespeicherteSprache = (r && r.rcLang) || '';
      rcLang = self.RepCheckI18n.resolveLang(r && r.rcLang, navigator.languages);
      rcApplyLang();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.rcLang) {
        rcGespeicherteSprache = ch.rcLang.newValue || '';
        rcLang = self.RepCheckI18n.resolveLang(ch.rcLang.newValue, navigator.languages);
        rcApplyLang();
      }
    });
  } catch (e) { /* ohne chrome.storage bleibt die Browsersprache */ }

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

  // Seit v1.6.0: RookHub-Modus zieht das Repertoire NICHT mehr vorab. Stattdessen
  // wird pro Review-Page ein POST /analyze-game gesendet (Game → Annotations). Hier
  // verifizieren wir nur Auth + zaehlen die Dateien, damit das Panel ein Feedback gibt.
  async function connectRookHub(cfg, options) {
    const refresh = !!(options && options.refresh);
    const result = await rookhubAnalyzeGame(cfg, [], { refresh });
    const fc = result && typeof result.repertoireFileCount === 'number' ? result.repertoireFileCount : 0;
    if (fc === 0) {
      updateStatusText(t('status.connectedNoOpenings'));
    } else {
      updateStatusText(t('status.connectedFiles', { count: fc }));
    }
    runCheck();
  }

  // ─── Repertoire Position Set ─────────────────────────────────────────
  // Transpositions: statt Zug-Sequenzen speichern wir alle erreichbaren
  // Stellungen als normalisierte FEN-Strings in einem Set. Zwei Partien,
  // die dieselbe Stellung ueber verschiedene Zugfolgen erreichen, treffen
  // auf denselben FEN-Eintrag.

  // normalizedFen: siehe Shared-Core (self.RepCheckLib, oben destrukturiert).

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
      updateStatusText(t('panel.noPgnFiles'));
      return;
    }

    Promise.all(pgnFiles.map(f => f.text())).then(async pgnTexts => {
      repertoirePositions = await buildAndSavePositionSet(pgnTexts);
      updateStatusText(t('panel.loadedFiles', { count: pgnTexts.length }));
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
      updateStatusText(t('panel.loadedFiles', { count: pgnTexts.length }));
      runCheck();
      return true;
    } else {
      updateStatusText(t('panel.noPgnFiles'));
      return false;
    }
  }

  async function loadRepertoireFromText(pgnText) {
    if (!pgnText.trim()) return;
    repertoirePositions = await buildAndSavePositionSet([pgnText]);
    updateStatusText(t('panel.loadedText'));
    runCheck();
  }

  // ─── Site Adapter (chess.com + lichess) ─────────────────────────────
  // Jede Site exportiert dieselbe Schnittstelle: erkennt die Review-Seite,
  // liefert die Zug-Knoten der Hauptlinie und sagt, wohin das Banner soll.
  // Die Adapter selbst (ADAPTERS mit test/isReviewPage/getMoveListEl/getMoveNodes/extractSan) liegen seit der
  // Zerlegung Z37 in lib/site-adapters.js — per Manifest VOR dieser Datei geladen (self.RepCheckSiteAdapters).
  const { ADAPTERS } = self.RepCheckSiteAdapters;

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

  // Aktuelle Hauptlinie + kurzer Titel — vom Popup (Sharebar) via executeScript gelesen.
  function rdcGetCurrentLine() {
    try {
      return { moves: getGameMoves() || [], title: (document.title || '').slice(0, 120) };
    } catch {
      return { moves: [], title: '' };
    }
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

  // chessableSearchUrl (globale Chessable-FEN-Such-URL): siehe Shared-Core (self.RepCheckLib).

  // ─── UI ─────────────────────────────────────────────────────────────
  // Das Stylesheet (STYLE_CSS, injectStyles) liegt in content/styles.js.

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
    btn.title = t('tools.check');
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
      btn.title = t('tools.searchFen');
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
    btn.title = t('tools.copyPgn');
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
    btn.title = t('tools.saveGame');
    btn.addEventListener('click', async () => {
      const currentCfg = await loadRookhubConfig().catch(() => null);
      if (!currentCfg) return;
      btn.textContent = '…';
      btn.disabled = true;
      const reset = (label, title) => setTimeout(() => {
        btn.textContent = label; btn.title = title; btn.disabled = false;
      }, 1500);
      try {
        const meta = await getGameMeta();
        // Kanonische Zugliste (lichess-Export) bevorzugen, sonst DOM-Auslese. Die DOM-Auslese erst HIER,
        // nicht mehr vor dem Klick-Rumpf: auf chess.coms Analyseseite steht im Review-Tab keine Zugliste
        // im DOM (gemeldet 2026-09-24), und der frühere Wächter „keine Zuege → return" liess den Knopf
        // stumm nichts tun. Ohne Zuege gibt es jetzt ein sichtbares Nein mit Grund.
        const moves = (meta.moves && meta.moves.length) ? meta.moves : getGameMoves();
        if (!moves.length) {
          btn.textContent = '✗';
          btn.title = t('tools.saveNoMoves');
          reset('💾', t('tools.saveGame'));
          return;
        }
        const saved = await rookhubSaveGame(currentCfg, moves, meta);
        const link = buildShareLink(currentCfg, saved);
        let copied = false;
        if (link) {
          try { await navigator.clipboard.writeText(link); copied = true; }
          catch (e) { /* Clipboard evtl. ohne User-Geste blockiert */ }
        }
        // Ohne Spielernamen gespeichert (Plattform lieferte auch nach Wiederholungen nichts): sichtbar sagen statt
        // still „?" gegen „?" — ein zweiter Klick später trägt sie nach (RookHub ≥ 0.725.3 heilt fehlende Kopfdaten).
        const noNames = !meta.white || !meta.black;
        btn.textContent = noNames ? '⚠' : copied ? '🔗' : '✓';
        btn.title = noNames ? t('tools.savedNoNames') : copied ? t('tools.savedWithLink') : t('tools.saved');
        reset('💾', t('tools.saveGame'));
      } catch (e) {
        btn.textContent = '✗';
        reset('💾', t('tools.saveGame'));
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
  // KEINE URL-/Token-Felder (seit v1.68.2): das Panel haengt im DOM von chess.com/lichess, ein
  // Seiten-Skript koennte dort eine eigene Adresse eintragen und „Verbinden" klicken — der
  // gespeicherte rkh_-Token ginge dann an diese Adresse, und die Egress-Allowlist des Workers
  // (Origin von rookhubConfig.url) folgte ihr. Die Verbindung lebt allein im Popup.
  function panelHtml() {
    return `
      <h3>${rcEscHtml(t('panel.heading'))}</h3>
      <div style="margin-bottom: 12px;">
        <strong>${rcEscHtml(t('panel.rookhub'))}</strong><br>
        <span style="font-size:11px;color:#888;">${rcEscHtml(t('panel.connectInPopup'))}</span>
        <div style="margin-top:6px;">
          <button id="repcheck-rookhub-refresh" class="secondary">${rcEscHtml(t('panel.refresh'))}</button>
        </div>
      </div>
      <hr style="border-color:#444;margin:12px 0;">
      <div style="margin-bottom: 12px;">
        <strong>${rcEscHtml(t('panel.folder'))}</strong><br>
        <button id="repcheck-pick-dir">${rcEscHtml(t('panel.selectFolder'))}</button>
        <span id="repcheck-folder-info" style="font-size:12px;color:#888;margin-left:6px;">${rcEscHtml(repertoirePositions ? t('panel.folderLoaded') : t('panel.noFolder'))}</span>
      </div>
      <hr style="border-color:#444;margin:12px 0;">
      <div>
        <strong>${rcEscHtml(t('panel.paste'))}</strong><br>
        <textarea id="repcheck-pgn-input" placeholder="${rcEscHtml(t('panel.pastePlaceholder'))}"></textarea>
        <button id="repcheck-load-pgn">${rcEscHtml(t('panel.loadPgn'))}</button>
        <button id="repcheck-close" class="secondary">${rcEscHtml(t('panel.close'))}</button>
      </div>
      <hr style="border-color:#444;margin:12px 0;">
      <div>
        <label style="font-size:12px;color:#bbb;">${rcEscHtml(t('lang.label'))}
          <select id="repcheck-lang" style="margin-left:6px;">
            <option value="">${rcEscHtml(t('lang.auto', { lang: rcAutoLang() }))}</option>
            <option value="en">English</option>
            <option value="de">Deutsch</option>
            <option value="hr">Hrvatski</option>
          </select>
        </label>
      </div>
      <div class="status" id="repcheck-status">
        ${rcEscHtml(repertoirePositions ? t('panel.loaded') : t('panel.notLoaded'))}
      </div>
    `;
  }

  // Alle Panel-Buttons verdrahten.
  function wirePanelEvents() {
    // Sprachwahl: leerer Wert = Automatik. Der Wert wird GELÖSCHT statt als '' gespeichert,
    // damit die Browsersprache wieder greift.
    const langSel = document.getElementById('repcheck-lang');
    if (langSel) {
      langSel.value = rcGespeicherteSprache || '';
      langSel.addEventListener('change', () => {
        const wahl = langSel.value;
        rcGespeicherteSprache = wahl;
        try {
          if (wahl) chrome.storage.local.set({ rcLang: wahl });
          else chrome.storage.local.remove('rcLang');
        } catch (e) { /* Speicher nicht erreichbar — Wahl gilt für diese Seite */ }
        rcLang = self.RepCheckI18n.resolveLang(wahl || null, navigator.languages);
        rcApplyLang();
      });
    }

    document.getElementById('repcheck-pick-dir')?.addEventListener('click', async () => {
      await pickDirectory();
    });

    document.getElementById('repcheck-load-pgn').addEventListener('click', () => {
      const textarea = document.getElementById('repcheck-pgn-input');
      loadRepertoireFromText(textarea.value);
    });

    document.getElementById('repcheck-close').addEventListener('click', togglePanel);

    // Nur mit der GESPEICHERTEN Config (Popup/Worker): Adresse und Token kommen nie aus dem DOM.
    document.getElementById('repcheck-rookhub-refresh')?.addEventListener('click', async () => {
      const cfg = await loadRookhubConfig();
      if (!cfg) { updateStatusText(t('status.notConfigured')); return; }
      try {
        updateStatusText(t('status.refreshing'));
        await connectRookHub(cfg, { refresh: true });
        lastGameMovesKey = '';
      } catch (e) {
        updateStatusText(t('status.error', { error: e.message }));
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
  // Source-Priority: RookHub-Config vorhanden → Server-seitige Analyse (POST analyze-game).
  // Sonst lokales Position-Set (Folder/PGN-Paste). Bei RookHub-Fehler fallback aufs
  // lokale Set, falls vorhanden (Offline-Modus).
  //
  // Das Ergebnis steht in der Zugliste (highlightDeviation). Scheitert die Pruefung (keine Zuege,
  // RookHub-Fehler inkl. 401 „Token ungueltig", kein Repertoire), zeigt der ♟-Knopf ✗ und den
  // uebersetzten Grund im title, nach CHECK_FAIL_MS wieder ♟ — wie 💾. Bis v1.68.7 liefen diese Faelle
  // in showBanner, seit v1.14.0 ein No-op: der Klick endete stumm.
  const CHECK_FAIL_MS = 3000;
  let checkFailTimer = null;
  function flagCheckFailed(message) {
    injectFloatingButton();
    const btn = document.getElementById('repcheck-floating');
    if (!btn) return;
    btn.textContent = '✗';
    btn.title = message;
    clearTimeout(checkFailTimer);
    checkFailTimer = setTimeout(() => {
      btn.textContent = '♟';
      btn.title = t('tools.check');
    }, CHECK_FAIL_MS);
  }

  function renderAnalysis(gameMoves, analysis) {
    const deviationIdx = analysis.deviation;
    const gaps = analysis.gaps || [];
    const inRepertoire = analysis.inRepertoire || [];
    currentDeviationIndex = deviationIdx;
    lastDeviationFen = analysis.fenBeforeDeviation
      || (deviationIdx >= 0 ? fenBeforeMove(gameMoves, deviationIdx) : null);

    highlightDeviation(deviationIdx >= 0 ? deviationIdx : -1, gaps, inRepertoire);
    syncChessableButton();
    syncSaveButton();
  }

  async function runCheck() {
    if (!isReviewPage()) return;
    const gameMoves = getGameMoves();
    if (gameMoves.length === 0) {
      flagCheckFailed(t('check.noMoves'));
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
          flagCheckFailed(t('status.error', { error: e.message }));
          return;
        }
        // Fallback aufs lokale Set (Offline / Cache aus frueherer Session).
      }
    }

    if (!repertoirePositions) {
      flagCheckFailed(t('check.noRepertoire'));
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

  // Die Version kommt aus dem Manifest, der einzigen Versionsquelle (CLAUDE.md „Versioning"). Bis
  // v1.68.9 standen hier zwei von Hand gepflegte Literale (version „1.17.0", Log „v1.12.0"), die
  // niemand nachzog. Ohne Erweiterungs-Kontext (kein chrome.runtime) bleibt es bei '?'.
  const EXT_VERSION = (() => {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; }
  })();

  window.__rdc_loaded = {
    runCheck: rdcRunCheck,
    openSettings: rdcOpenSettings,
    refreshButton: refreshFloatingButton,
    getCurrentLine: rdcGetCurrentLine,
    version: EXT_VERSION,
  };

  // ─── Lightweight SPA-Navigation Watch ───────────────────────────────
  // Beobachtet NUR den <title>-Knoten und popstate-Events. Kein subtree-
  // Observer auf document.body, also praktisch kostenlos im Idle.
  // Bei jeder Navigation: pruefen, ob Review-Seite, und Button ein/ausblenden.
  const REVIEW_POLL_MS = 2000;
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
    // Der Analyse-Knopf entsteht erst, wenn die Partie vorbei ist — bzw. nachdem die Seitenleiste
    // nachgeladen hat. Dabei aendert sich weder <title> noch die Adresse, die beiden Beobachter oben
    // feuern also nicht. Darum ein sparsamer Takt: zwei querySelector alle 2 s, und Einblenden wie
    // Ausblenden sind idempotent (jede Injektion prueft ihre id).
    setInterval(refreshFloatingButton, REVIEW_POLL_MS);
    // Dieselbe Ueberlegung fuer die Partien-Uebersicht: chess.com laedt die Zeilen nach (Blaettern,
    // „mehr laden"), ohne <title> oder Adresse zu aendern. Ein Durchgang ohne Partiezeilen kostet
    // einen querySelectorAll und bricht sofort ab.
    setInterval(syncOverviewGames, OVERVIEW_SWEEP_MS);
    window.addEventListener('popstate', syncOverviewGames);
  }

  watchNavigation();
  refreshFloatingButton();
  syncOverviewGames();

  console.log('[RepertoireChecker] Extension v' + EXT_VERSION + ' loaded');
})();
