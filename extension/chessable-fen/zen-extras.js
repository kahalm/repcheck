// chessable-fen.js-Teil (Zerlegung Z38, zweiter Schnitt, MAIN-World): zustandslose Zen-Extras — Chessables eigenen
// „Next"-/„Hint"-Knopf fernklicken (liegen im Zen hinterm Backdrop) und die Geometrie der 💬 Kommentar-/Zugspalte
// (rechts neben dem Brett bzw. unten auf dem Handy). Bis v1.73.2 in zen.js; Wortlaut unveraendert.
//
// Zustand: keiner. Keine Seiteneffekte beim Laden.
// Laden: Manifest content_scripts (chessable.com, world: MAIN), VOR zen.js und chessable-fen.js. Ablage unter
// self.RepCheckFen.zenExtras nur fuer die Verdrahtung — chessable-fen.js nimmt den Namen danach wieder aus dem window.
(function () {
  'use strict';

  // Wie chessable-fen.js: laeuft die MAIN-World-Leiste in diesem Tab schon, nichts neu anlegen.
  if (window.__repcheckChessableFen) return;

  // Aus chessable-fen.js und den anderen Teilen (init).
  let flash, CONTAINER_ID;

  // ── Zen-Extras: ▸ Next-Klick + 💬 Kommentar-/Zugspalte ──────────────────
  // Chessables eigener „Next"-Knopf liegt im Zen-Modus hinterm Backdrop —
  // der ▸-Button sucht ihn per Text und klickt ihn programmatisch (React
  // bekommt ein echtes click-Event, Sichtbarkeit spielt dafür keine Rolle).
  // Chessables eigener „Hint"-Knopf — im Zen ebenfalls hinterm Backdrop. Gleiche
  // Suche wie beim Next: per Text, klick programmatisch (React braucht keine Sichtbarkeit).
  function clickChessableHint(btn) {
    // Chessables Hint ist ein Icon-DIV [data-testid="squareHintButton"] (Glocke + „Hint") im
    // .board-footer — KEIN <button>. Darum primär per testid (klickt auch im Zen hinterm Backdrop;
    // React braucht keine Sichtbarkeit). Fallback: die alte Textsuche, jetzt inkl. div[data-testid].
    let cand = document.querySelector('[data-testid="squareHintButton"]');
    if (!cand) {
      cand = [...document.querySelectorAll('button, a, [role="button"], div[data-testid]')].find((el) => {
        if (el.closest('#' + CONTAINER_ID)) return false;
        const t = (el.textContent || '').trim();
        if (!/^(hint|tipp)$/i.test(t)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    }
    if (cand) cand.click();
    else flash(btn, 'Kein „Hint" da', '#c62828');
  }

  function clickChessableNext(btn) {
    // Chessables Next ist [data-testid="nextLessonButton"] und traegt ZWEI Label-Spans
    // („Next variation" not-in-mobile + „Next" not-in-desktop) → textContent ist
    // „Next variationNext", die exakte Textsuche griff also nie. Primaer per testid
    // (klickt auch im Zen hinterm Backdrop); Fallback bleibt die Textsuche.
    let cand = document.querySelector('[data-testid="nextLessonButton"]');
    if (!cand) {
      cand = [...document.querySelectorAll('button, a, [role="button"]')].find((el) => {
        if (el.closest('#' + CONTAINER_ID)) return false;
        const t = (el.textContent || '').trim();
        if (!/^(next( variation| chapter| move| line)?|weiter)$/i.test(t)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    }
    if (cand) cand.click();
    else flash(btn, 'Kein „Next" da', '#c62828');
  }

  /** Panel-Breite — BEWUSST unabhängig von der Brettgröße. Sie aus dem Brett-Rect zu rechnen
   *  ging beim automatischen Öffnen schief: da hat Chessable das Brett noch nicht neu
   *  gelayoutet, das Rect ist veraltet, das Panel wurde zu breit und lag über dem Brett
   *  (erst Zu- und Wieder-Aufklappen sah richtig aus). */
  function zenPanelWidth() {
    return Math.round(Math.min(460, Math.max(280, window.innerWidth * 0.24)));
  }

  /** Schmal/hochkant (Handy): das Panel passt nicht NEBEN ein brauchbares Brett → es dockt unten an. */
  function zenNarrow() { return window.innerWidth < 720 || window.innerWidth < window.innerHeight; }
  function zenPanelHeightNarrow() { return Math.round(window.innerHeight * 0.34); }

  /** Panel-Geometrie — rechts neben dem Brett (breit) bzw. unten drunter (schmal/hochkant). */
  function zenPanelPlace(panel) {
    const s = panel.style;
    s.setProperty('position', 'fixed', 'important');
    if (zenNarrow()) {
      s.setProperty('left', '12px', 'important');
      s.setProperty('right', '12px', 'important');
      s.setProperty('bottom', '12px', 'important');
      s.setProperty('top', 'auto', 'important');
      s.setProperty('transform', 'none', 'important');
      s.setProperty('width', 'auto', 'important');
      s.setProperty('max-height', zenPanelHeightNarrow() + 'px', 'important');
    } else {
      s.setProperty('top', '50%', 'important');
      s.setProperty('right', '12px', 'important');
      s.setProperty('left', 'auto', 'important');
      s.setProperty('bottom', 'auto', 'important');
      s.setProperty('transform', 'translateY(-50%)', 'important');
      s.setProperty('width', zenPanelWidth() + 'px', 'important');
      s.setProperty('max-height', '92vh', 'important');
    }
    s.setProperty('overflow-y', 'auto', 'important');
    s.setProperty('z-index', '2147483615', 'important');
    s.setProperty('margin', '0', 'important');
    s.setProperty('padding', '12px', 'important');
    s.setProperty('border-radius', '10px', 'important');
    s.setProperty('box-shadow', '0 4px 24px rgba(0,0,0,0.5)', 'important');
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckFen = self.RepCheckFen || {}).zenExtras = {
    init(deps) {
      ({ flash, CONTAINER_ID } = deps);
    },
    clickChessableHint, clickChessableNext, zenPanelWidth, zenNarrow, zenPanelHeightNarrow, zenPanelPlace,
  };
})();
