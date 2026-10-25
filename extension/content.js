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
  let currentDeviationIndex = -1;
  let lastGameMovesKey = '';   // Cache: skip analyzeGame wenn Zuege unveraendert
  let lastDeviationFen = null; // FEN vor dem Out-of-Rep-Zug fuer Chessable-Suche

  // Geteilter Zustand fuer die Teil-Dateien (content/*.js). Die Variablen gehoeren content.js (hier und unter
  // „Sprache"); wer sie ausserhalb liest oder schreibt, tut es ueber S — nie ueber eine eigene Kopie. Gelesen wird
  // erst zur Laufzeit (Klick, Takt, Storage-Rueckruf), nie waehrend des Ladens.
  const S = {
    get repertoirePositions() { return repertoirePositions; }, set repertoirePositions(v) { repertoirePositions = v; },
    get dirHandle() { return dirHandle; }, set dirHandle(v) { dirHandle = v; },
    get lastGameMovesKey() { return lastGameMovesKey; }, set lastGameMovesKey(v) { lastGameMovesKey = v; },
    get lastDeviationFen() { return lastDeviationFen; }, set lastDeviationFen(v) { lastDeviationFen = v; },
    get rcLang() { return rcLang; }, set rcLang(v) { rcLang = v; },
    get rcGespeicherteSprache() { return rcGespeicherteSprache; }, set rcGespeicherteSprache(v) { rcGespeicherteSprache = v; },
  };

  // ─── Shared-Core-Helfer (extension/lib/repertoire-text.js) ──────────
  // Reine Text-/PGN-/FEN-Logik lebt EINMAL im Shared-Core, der als Content-Script
  // VOR content.js geladen wird (Manifest content_scripts + Popup-executeScript) →
  // self.RepCheckLib. Keine Inline-Kopien mehr (früher hier + userscript + lib
  // dreifach). tokenizePgn/isMoveToken/parseMoveTokens/parsePgnText: PGN→Zugbaum;
  // normalizedFen: 4-Feld-FEN fürs Repertoire-Matching; chessComPlayedAt: Header→ISO;
  // chessableSearchUrl: globale Chessable-FEN-Such-URL; lichessGameId: Partie-Id nur aus
  // echten lichess-Partie-Adressen (nie aus /analysis, /training …).
  // Seit der Zerlegung Z37 braucht content.js selbst keinen davon mehr; die Teil-Dateien holen sich ihre Helfer
  // dort ab (game-meta.js, local-repertoire.js, floating.js).

  // ─── Teil-Dateien verdrahten (content/*.js, per Manifest VOR dieser Datei geladen) ─────────
  // Seit der Zerlegung Z37 liegen Speicher, RookHub-Aufrufe, Partie-Metadaten, Stylesheet, Partien-Uebersicht, lokaler
  // Modus, Panel und die schwebenden Knoepfe in eigenen Dateien; hier bleiben Zustand, Sprache, Zugliste, Pruefung,
  // Popup-Einstiege und Navigation. Ihre Funktionen stehen beim Laden schon bereit; was sie von hier brauchen,
  // bekommen sie per init() — vor allem anderen, damit kein Rueckruf (Storage, Navigation) eine Teil-Datei ohne ihre
  // Abhaengigkeiten erreicht.
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
  const { analyzeGame, fenBeforeMove, ensurePositionSet, loadRepertoireFromDir } = C.localRepertoire;
  const { rcApplyLang, togglePanel } = C.panel;
  const { injectFloatingButton, syncChessableButton, syncSaveButton, refreshFloatingButton } = C.floating;
  C.rookhubApi.init({ t });
  C.gameMeta.init({ getAdapter, detectSiteKey });
  C.overview.init({
    t, detectSiteKey, loadRookhubConfig, injectStyles,
    rookhubKnownGames, rookhubSaveGame, rookhubAnalyzeSavedGame, fetchChessComHeaders, fetchLichessGame,
  });
  C.localRepertoire.init({
    S, t, updateStatusText: C.panel.updateStatusText, runCheck,
    saveHandle, savePositionSetCache, loadPositionSetCache, loadRookhubCache,
  });
  C.panel.init({
    S, t, rcAutoLang, PANEL_ID, runCheck,
    loadRookhubConfig, rookhubAnalyzeGame, pickDirectory: C.localRepertoire.pickDirectory,
    loadRepertoireFromText: C.localRepertoire.loadRepertoireFromText,
  });
  C.floating.init({
    S, t, injectStyles, detectSiteKey, isReviewPage, getGameMoves, rdcRunCheck,
    loadRookhubConfig, getGameMeta, rookhubSaveGame, buildShareLink,
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

  function detectSiteKey() {
    const host = location.hostname;
    for (const key of Object.keys(ADAPTERS)) {
      if (ADAPTERS[key].test(host)) return key;
    }
    return '';
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
