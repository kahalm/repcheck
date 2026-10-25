// content.js-Teil (Zerlegung Z37): die schwebenden Knoepfe unten rechts auf Review-/Analyse-Seiten — ♟ pruefen,
// 🔎 Chessable-Suche nach einer Abweichung, 📋 PGN kopieren, 💾 an RookHub speichern (CLAUDE.md „Partie kopieren /
// speichern"). Ein- und Ausblenden entscheidet refreshFloatingButton (Takt und Beobachter in content.js).
//
// Zustand: `lastUrl` gehoert nur hierher; lastDeviationFen und lastGameMovesKey gehoeren content.js und laufen ueber
// das geteilte Zustandsobjekt S (Getter/Setter dort). Laden: Manifest content_scripts, VOR content.js →
// self.RepCheckContent.floating; Abhaengigkeiten per init().
(function () {
  'use strict';

  // Wie content.js: laeuft content.js in diesem Tab schon (das Popup laedt die Manifest-Liste nach), nichts neu anlegen.
  if (window.__rdc_loaded) return;

  const { chessableSearchUrl } = (self.RepCheckLib || {});
  let lastUrl = '';
  // Aus content.js und den anderen Teil-Dateien (init).
  let S, t, injectStyles, detectSiteKey, isReviewPage, getGameMoves, rdcRunCheck;
  let loadRookhubConfig, getGameMeta, rookhubSaveGame, buildShareLink;

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
      S.lastGameMovesKey = '';
      rdcRunCheck();
    });
    wrap.appendChild(btn);
  }

  // Chessable-Button: nur sichtbar wenn eine Abweichung erkannt wurde.
  // Klick oeffnet Chessable mit der FEN VOR dem Out-of-Rep-Zug.
  function syncChessableButton() {
    const wrap = document.getElementById('repcheck-floating-wrap');
    let btn = document.getElementById('repcheck-chessable');
    if (!S.lastDeviationFen) {
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
        if (!S.lastDeviationFen) return;
        window.open(chessableSearchUrl(S.lastDeviationFen), '_blank', 'noopener,noreferrer');
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
      S.lastDeviationFen = null;
      S.lastGameMovesKey = '';
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

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckContent = self.RepCheckContent || {}).floating = {
    init(deps) {
      ({ S, t, injectStyles, detectSiteKey, isReviewPage, getGameMoves, rdcRunCheck } = deps);
      ({ loadRookhubConfig, getGameMeta, rookhubSaveGame, buildShareLink } = deps);
    },
    buildGamePgn, copyGamePgn, detectSiteTheme, ensureFloatingWrap, injectFloatingButton, syncChessableButton,
    injectCopyButton, syncSaveButton, removeFloatingControls, refreshFloatingButton,
  };
})();
