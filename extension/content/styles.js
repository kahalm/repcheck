// content.js-Teil (Zerlegung Z37): das Stylesheet der Seite — Abweichungs-Marker in der Zugliste, Einstellungs-Panel,
// schwebende Knoepfe, Knopf je Partiezeile der Uebersicht. Eingehaengt erst bei Bedarf (injectStyles, idempotent ueber
// die id `repcheck-styles`), nicht ueber `content_scripts[].css`: so bekommt auch ein Tab, in den das Popup content.js
// nachlaedt (executeScript, kein insertCSS), dieselben Styles wie bisher.
//
// Hier stehen auch die Klassen/Ids, die das Stylesheet kennt (DEVIATION_CLASS …, PANEL_ID) — sie werden beim Laden
// in STYLE_CSS eingesetzt. Laden: Manifest content_scripts, VOR content.js → self.RepCheckContent.styles.
(function () {
  'use strict';

  // Wie content.js: laeuft content.js in diesem Tab schon (das Popup laedt die Manifest-Liste nach), nichts neu anlegen.
  if (window.__rdc_loaded) return;

  // ─── Constants ───────────────────────────────────────────────────────
  const DEVIATION_CLASS = 'repcheck-deviation';
  const GAP_CLASS = 'repcheck-gap';
  const IN_REP_CLASS = 'repcheck-in-rep';
  const PANEL_ID = 'repcheck-panel';

  // ─── UI ─────────────────────────────────────────────────────────────
  // Styles der Deviation-Marker + des Settings-Panels + der Floating-Buttons.
  // Als Konstante ausgelagert (statt inline in injectStyles), damit die Funktion
  // nur noch das Injizieren macht.
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

      /* Uebersichts-Knopf je Partiezeile. "position: relative" ist Pflicht: der Zeilen-Link ist
         absolut positioniert und deckt die ganze Zeile — ein statisches Element darunter bekommt
         keinen Klick. Farben erben von der Zelle, damit er sich in beide chess.com-Themes fuegt. */
      .rc-ov {
        position: relative;
        z-index: 3;
        display: inline-flex;
        align-items: center;
        gap: 2px;
        margin-left: 2px;
      }
      .rc-ov.rc-ov-loose {
        position: absolute;
        top: 4px;
        right: 6px;
      }
      /* Die Aktionen-Zelle ist 80px breit und traegt schon Herz + Auswahlkaestchen. Passt der dritte
         Knopf nicht mehr daneben, soll er UNTER ihnen stehen (die Zeile ist 172px hoch) statt in die
         Nachbarspalte zu laufen — chess.com setzt dort "flex-wrap: nowrap". */
      .game-history-games-actions { flex-wrap: wrap; }
      .rc-ov-btn {
        cursor: pointer;
        background: transparent;
        color: inherit;
        border: 1px solid currentColor;
        border-radius: 6px;
        font-family: inherit;
        font-size: 13px;
        line-height: 1;
        padding: 2px 4px;
        opacity: 0.65;
      }
      .rc-ov-btn:hover { opacity: 1; }
      .rc-ov-btn[disabled] { cursor: default; opacity: 0.45; }
      .rc-ov-done {
        text-decoration: none;
        color: #2e9e4f;
        font-weight: 700;
        line-height: 1;
        padding: 3px 5px;
      }
      /* Stand der RookHub-Analyse neben dem Haken: fertig/laeuft als Link, sonst ein Knopf. */
      .rc-ov-an { text-decoration: none; line-height: 1; padding: 3px 3px; font-size: 14px; }
      .rc-ov-an-btn { font-size: 13px; opacity: 0.55; border-style: dashed; }
    `;

  function injectStyles() {
    if (document.getElementById('repcheck-styles')) return;
    const style = document.createElement('style');
    style.id = 'repcheck-styles';
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckContent = self.RepCheckContent || {}).styles = {
    DEVIATION_CLASS, GAP_CLASS, IN_REP_CLASS, PANEL_ID, STYLE_CSS, injectStyles,
  };
})();
