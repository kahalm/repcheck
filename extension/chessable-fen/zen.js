// chessable-fen.js-Teil (Zerlegung Z38, MAIN-World): Vollbild-/Zen-Modus — Brett gross und mittig auf dunklem
// Backdrop, ohne DOM-Umbau (React) und ohne zoom/scale (Drag&Drop); Stacking-Context-Fallen der Vorfahren werden
// fuer die Dauer neutralisiert (Handy); Zen-Extras ▸ Next, 💡 Hint, 🔬 Analyse, 💬 Kommentar-/Zugspalte.
// Siehe CLAUDE.md „Zen auf dem Handy".
//
// Zustand: alles Zen-Eigene gehoert hierher; die Leiste setzt die vier Zen-Knoepfe beim Bauen ueber S, das Zen liest
// die Knopf-Referenzen der Leiste (btnRefs) ueber S. Seiteneffekt nur in installVollbildEnde().
// Laden: Manifest content_scripts (chessable.com, world: MAIN), VOR chessable-fen.js. Ablage unter self.RepCheckFen.<teil>
// nur fuer die Verdrahtung — chessable-fen.js nimmt den Namen danach wieder aus dem window der Seite.
(function () {
  'use strict';

  // Wie chessable-fen.js: laeuft die MAIN-World-Leiste in diesem Tab schon, nichts neu anlegen.
  if (window.__repcheckChessableFen) return;

  // Aus chessable-fen.js und den anderen Teilen (init).
  let S, flash, CONTAINER_ID, FEEDBACK_ID, POOL_ID, renderFeedback, renderPool, applyButtonSettings;

  // ── Vollbild-/Zen-Modus ─────────────────────────────────────────────────
  // Ganze Seite in echtes Vollbild, das Brett groß und mittig auf dunklem
  // Backdrop. Bewusst KEIN DOM-Umbau (Chessable ist React — Knoten verschieben
  // bricht die Reconciliation): das Brett bekommt nur Inline-Styles, der Rest
  // der Seite verschwindet hinter einem eigenen Backdrop-DIV. Die RepCheck-
  // Buttons liegen über dem Backdrop → der Knopf selbst (oder Esc) führt raus.
  //
  // Vergrößert wird OHNE zoom/transform:scale — beides bricht das Drag&Drop
  // von chessboard.js: die Feld-Offsets werden beim Drag-Start VISUELL
  // gemessen (getBoundingClientRect-basiert, also mitskaliert), die Treffer-
  // Prüfung rechnet aber mit der LAYOUT-squareSize → jede Feld-Hitbox deckt
  // nur einen Teil des Felds, Drops in der toten Zone enden als Snapback
  // (per Inspector-Trace belegt). Stattdessen: width/height des Bretts per
  // !important auf die Zielgröße festnageln und Chessables eigenen Resize-
  // Pfad anstoßen (resize-Event) — der ruft board.resize() auf, chessboard.js
  // berechnet die squareSize echt neu, und Maus- wie Brettkoordinaten leben
  // wieder im selben System.
  const ZEN_BACKDROP_ID = 'repcheck-zen-backdrop';
  const ZEN_STYLE_ID = 'repcheck-zen-style';
  let zenBoard = null;
  let zenPrevStyle = '';
  /** Chessables Annotations-Layer (`svg#drawings`: Pfeile, Kreise) — sein Stil vor dem Zen.
   *  null = noch nicht angefasst. */
  let zenPrevDrawingsStyle = null;
  let zenRescale = null;
  let zenApplied = 0;
  let zenPokeTimer = null;
  // Zen-only-Buttons (▸ Next, 💬 Kommentar-Panel) + gehobenes Panel-Element.
  let zenNextBtn = null;
  let zenPanelBtn = null;
  let zenAnalyseBtn = null;
  let zenHintBtn = null;
  let zenPanelEl = null;
  let zenPanelPrevStyle = '';
  /** Vorfahren, deren Stacking-Context/Containing-Block fürs Zen neutralisiert wurde: [{el, prev}]. */
  let zenLifted = [];

  function zenTarget() {
    return document.getElementById('board')
      || document.querySelector('[data-square]')?.closest('#board, [class*="chessboard"]')
      || document.querySelector('.cg-wrap, cg-container, [class*="cg-wrap"]')
      || null;
  }

  function zenActive() { return !!document.getElementById(ZEN_BACKDROP_ID); }

  // Chessables Resize-Handler (debounced) anstoßen, damit chessboard.js die
  // squareSize an die neue Brettgröße anpasst. Wird nur bei geänderter
  // Zielgröße gerufen → keine Event-Schleife mit dem eigenen resize-Listener.
  function zenPokeLayout() {
    if (zenPokeTimer) return;
    zenPokeTimer = setTimeout(() => {
      zenPokeTimer = null;
      window.dispatchEvent(new Event('resize'));
    }, 60);
  }

  /**
   * Chessables Annotations-Layer: `svg#drawings` — dort liegen Pfeile UND Feld-Kreise.
   *
   * Er ist ein GESCHWISTER des Bretts (beide unter `div.noScrollingWithFinger`) und deckt
   * sich im Normalfall exakt damit, weil er `position:absolute; left:0; top:0` im selben
   * positionierten Elternteil hat. Im Zen ziehen wir das Brett auf `position:fixed` — der
   * Layer bleibt zurueck. Gemessen am 08.08. (Snapshots mtpfeil/ohnepfeil): Brett bei
   * (152,13), Layer bei (1187,545), also 1035 px rechts und 532 px unter dem Brett. Der Pfeil
   * war die ganze Zeit im DOM (`<line stroke="#e02828" marker-end="url(#arrowhead-r)">`), nur
   * eben neben dem Brett — und mit `z-index:10` zusaetzlich unter unserem Backdrop.
   */
  function zenDrawingsLayer() {
    return document.getElementById('drawings');
  }

  /**
   * Brett (und Panel) liegen im Zen per position:fixed + z-index ÜBER dem Backdrop. Das trägt nur,
   * wenn KEIN Vorfahr einen eigenen Stacking-Context/Containing-Block aufmacht (transform, filter,
   * contain, container-type, will-change, positioniertes z-index, opacity<1, …). Sonst bleibt das
   * Brett in diesem Vorfahren gefangen: sein z-index gilt nur dort, das Backdrop (Kind von body) liegt
   * darüber → schwarzer Bildschirm, nur unsere Buttons sichtbar (Handy, 2026-08). Die Desktop-Kette
   * bis #root ist frei davon (Snapshot 08.08.), Chessables mobiles Layout nicht. Solche Vorfahren
   * werden für die Dauer des Zen neutralisiert (Inline-!important, beim Verlassen zurückgesetzt) —
   * die Layout-Verschiebung darunter deckt das Backdrop ohnehin ab. Kein DOM-Umbau (React!).
   */
  function zenLiftAncestors(node) {
    for (let el = node && node.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (zenLifted.some((x) => x.el === el)) continue;
      const cs = getComputedStyle(el);
      const traps = cs.transform !== 'none' || cs.perspective !== 'none' || cs.filter !== 'none'
        || (cs.backdropFilter && cs.backdropFilter !== 'none')
        || (cs.contain && cs.contain !== 'none')
        || (cs.containerType && cs.containerType !== 'normal')
        || /transform|perspective|filter|contain/.test(cs.willChange || '')
        || (cs.zIndex !== 'auto' && cs.position !== 'static')
        || parseFloat(cs.opacity) < 1
        || cs.isolation === 'isolate'
        || (cs.mixBlendMode && cs.mixBlendMode !== 'normal')
        || (cs.clipPath && cs.clipPath !== 'none')
        || (cs.maskImage && cs.maskImage !== 'none');
      if (!traps) continue;
      zenLifted.push({ el, prev: el.getAttribute('style') });
      const st = el.style;
      for (const [p, v] of [['transform', 'none'], ['perspective', 'none'], ['filter', 'none'],
        ['backdrop-filter', 'none'], ['contain', 'none'], ['container-type', 'normal'], ['will-change', 'auto'],
        ['z-index', 'auto'], ['opacity', '1'], ['isolation', 'auto'], ['mix-blend-mode', 'normal'],
        ['clip-path', 'none'], ['mask-image', 'none']]) {
        st.setProperty(p, v, 'important');
      }
    }
  }

  function zenRestoreAncestors() {
    for (const { el, prev } of zenLifted) {
      if (prev) el.setAttribute('style', prev);
      else el.removeAttribute('style');
    }
    zenLifted = [];
  }

  function enterZen(btn) {
    const board = zenTarget();
    const rect = board && board.getBoundingClientRect();
    if (!board || !rect || !rect.width) { flash(btn, 'No board found', '#c62828'); return; }
    zenBoard = board;
    zenPrevStyle = board.getAttribute('style') || '';
    zenLiftAncestors(board);

    const backdrop = document.createElement('div');
    backdrop.id = ZEN_BACKDROP_ID;
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', background: '#111', zIndex: '2147483600',
    });
    // Bewusst KEIN Klick-zum-Beenden: neben das Brett zu klicken passiert beim Training
    // staendig (Maus parken, versehentlicher Klick nach einem Zug) — dabei aus dem Vollbild zu
    // fliegen reisst aus der Konzentration. Raus geht es ueber ✕ oder Esc.
    document.body.appendChild(backdrop);

    // chessboard.js hängt die gezogene Schwebefigur an <body> — die muss ÜBER
    // das Backdrop, sonst ist die Figur während des Ziehens unsichtbar.
    // (.piece-417db ist eine chessboard.js-Konstante, kein generierter Hash.)
    if (!document.getElementById(ZEN_STYLE_ID)) {
      const st = document.createElement('style');
      st.id = ZEN_STYLE_ID;
      st.textContent = 'body > .piece-417db { z-index: 2147483620 !important; }';
      (document.head || document.documentElement).appendChild(st);
    }

    zenApplied = 0;
    zenRescale = () => {
      // Offenes Panel reserviert rechts Platz: das Brett wird entsprechend kleiner UND um
      // die halbe Reserve nach links gerückt, statt sich mit dem Panel zu überlappen.
      const reserve = zenReservedRight();
      const reserveBottom = zenReservedBottom();
      // Nie unter ein bedienbares Minimum: ein rechts angedocktes Panel liess auf dem Handy
      // (390 px breit, 304 px Reserve) ein Brett von ~80 px uebrig.
      const target = Math.max(160, Math.floor(0.97 * Math.min(window.innerWidth - reserve, window.innerHeight - reserveBottom)));
      if (zenPanelEl) zenPanelPlace(zenPanelEl);   // Geometrie folgt Drehung/Resize
      // !important, weil Chessables eigener Resize-Handler style.width neu
      // setzt (fit-height-Berechnung): unsere Größe muss gewinnen — sein
      // board.resize() liest danach die tatsächliche (= unsere) Breite und
      // zeichnet die Felder in der neuen Größe.
      const s = zenBoard.style;
      s.setProperty('position', 'fixed', 'important');
      s.setProperty('left', `calc(50% - ${Math.round(reserve / 2)}px)`, 'important');
      s.setProperty('top', `calc(50% - ${Math.round(reserveBottom / 2)}px)`, 'important');
      s.setProperty('margin', '0', 'important');
      s.setProperty('transform', 'translate(-50%, -50%)', 'important');
      s.setProperty('z-index', '2147483610', 'important');
      for (const p of ['width', 'height', 'max-width', 'max-height']) {
        s.setProperty(p, target + 'px', 'important');
      }
      if (target !== zenApplied) { zenApplied = target; zenPokeLayout(); }
      // Annotations-Layer mit dem Brett mitziehen (siehe zenDrawingsLayer): dieselbe
      // Geometrie, ueber dem Backdrop, und ohne Klicks abzufangen — Pfeile sind Anzeige.
      const dr = zenDrawingsLayer();
      if (dr) {
        if (zenPrevDrawingsStyle === null) zenPrevDrawingsStyle = dr.getAttribute('style') || '';
        const ds = dr.style;
        ds.setProperty('position', 'fixed', 'important');
        ds.setProperty('left', `calc(50% - ${Math.round(reserve / 2)}px)`, 'important');
        ds.setProperty('top', `calc(50% - ${Math.round(reserveBottom / 2)}px)`, 'important');
        ds.setProperty('margin', '0', 'important');
        ds.setProperty('transform', 'translate(-50%, -50%)', 'important');
        ds.setProperty('z-index', '2147483611', 'important');   // knapp ueber dem Brett
        ds.setProperty('pointer-events', 'none', 'important');
        ds.setProperty('width', target + 'px', 'important');
        ds.setProperty('height', target + 'px', 'important');
      }
    };
    zenRescale();
    // Kommentare/Züge standardmäßig AN: im Vollbild ist der freie Platz daneben sonst
    // ungenutzt, und genau diese Spalte will man beim Durcharbeiten sehen. 💬 schaltet sie
    // wieder aus. Nach zenRescale, damit die Brettbreite für die Spaltenbreite schon steht.
    if (!zenNarrow()) zenPanelShow(null, true);   // Handy: Platz reicht nicht fuer beides
    window.addEventListener('resize', zenRescale);

    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
    updateZenButton();
  }

  function exitZen() {
    document.getElementById(ZEN_BACKDROP_ID)?.remove();
    document.getElementById(ZEN_STYLE_ID)?.remove();
    zenPanelHide();
    if (zenPokeTimer) { clearTimeout(zenPokeTimer); zenPokeTimer = null; }
    if (zenRescale) { window.removeEventListener('resize', zenRescale); zenRescale = null; }
    if (zenBoard) {
      if (zenPrevStyle) zenBoard.setAttribute('style', zenPrevStyle);
      else zenBoard.removeAttribute('style');
      zenBoard = null;
    }
    // Annotations-Layer zurueckgeben; Chessable rechnet ihn beim naechsten resize neu.
    if (zenPrevDrawingsStyle !== null) {
      const dr = zenDrawingsLayer();
      if (dr) {
        if (zenPrevDrawingsStyle) dr.setAttribute('style', zenPrevDrawingsStyle);
        else dr.removeAttribute('style');
      }
      zenPrevDrawingsStyle = null;
    }
    // Chessable-Layout zurück auf Normalgröße rechnen lassen (board.resize()).
    window.dispatchEvent(new Event('resize'));
    zenRestoreAncestors();
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    updateZenButton();
  }

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

  // Kommentar-/Zugspalte finden: die Geschwister-Spalte der Brett-Spalte im
  // Practice-Layout (row-practice__col*) mit dem meisten Text — dort wohnen
  // die Kommentare + Zugliste, die man sonst am Linienende sieht.
  function zenPanelTarget() {
    const board = zenBoard || zenTarget();
    const boardCol = board && board.closest('[class*="__col"]');
    const row = boardCol && boardCol.parentElement;
    if (!row) return null;
    let best = null;
    for (const el of row.children) {
      if (el === boardCol) continue;
      if (el.getBoundingClientRect().width < 120) continue;
      if (!best || (el.textContent || '').length > (best.textContent || '').length) best = el;
    }
    return best;
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

  /** Platz, den das offene Panel rechts belegt (inkl. Abstand) — 0, wenn es zu ist oder unten sitzt. */
  function zenReservedRight() {
    return zenPanelEl && !zenNarrow() ? zenPanelWidth() + 24 : 0;
  }
  /** Platz, den das offene Panel UNTEN belegt (nur schmal/hochkant). */
  function zenReservedBottom() {
    return zenPanelEl && zenNarrow() ? zenPanelHeightNarrow() + 24 : 0;
  }

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

  function zenPanelShow(btn, silent) {
    const panel = zenPanelTarget();
    // Beim AUTOMATISCHEN Öffnen (Zen-Start) nicht meckern: findet die Heuristik kein
    // Panel, soll der Nutzer einfach kein Panel sehen — keine Fehlermeldung am Knopf.
    if (!panel) { if (!silent) flash(btn, 'Kein Panel gefunden', '#c62828'); return; }
    zenPanelEl = panel;
    zenPanelPrevStyle = panel.getAttribute('style') || '';
    const s = panel.style;
    zenLiftAncestors(panel);   // dieselbe Stacking-Context-Falle wie beim Brett
    zenPanelPlace(panel);
    // Transparente Panels bekommen auf dem dunklen Backdrop einen zur
    // Textfarbe passenden Grund (helle Schrift → dunkel, dunkle → hell).
    const cs = getComputedStyle(panel);
    if (!cs.backgroundColor || cs.backgroundColor === 'transparent' || /rgba\([^)]*,\s*0\)\s*$/.test(cs.backgroundColor)) {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cs.color || '');
      const lightText = m && (+m[1] + +m[2] + +m[3]) / 3 > 128;
      s.setProperty('background', lightText ? '#1e1e1e' : '#fafafa', 'important');
    }
    if (zenRescale) zenRescale();   // Brett auf den verbleibenden Platz rücken
  }

  function zenPanelHide() {
    if (!zenPanelEl) return;
    if (zenPanelPrevStyle) zenPanelEl.setAttribute('style', zenPanelPrevStyle);
    else zenPanelEl.removeAttribute('style');
    zenPanelEl = null;
    if (zenRescale) zenRescale();   // Brett bekommt den Platz zurück
  }

  function toggleZenPanel(btn) {
    if (zenPanelEl) zenPanelHide();
    else zenPanelShow(btn);
  }

  function updateZenButton() {
    const btn = S.btnRefs.fullscreen;
    if (btn) {
    btn.textContent = zenActive() ? '✕' : '⛶';
    btn.title = zenActive() ? 'Vollbild verlassen (Esc)' : 'Brett bildschirmfüllend (Esc beendet)';
    }
    // Im Zen-Modus bleiben Exit, Refresh und die Zen-Extras (▸/💬) sichtbar.
    // Beim Verlassen stellt applyButtonSettings() die Popup-Einstellungen
    // wieder her; die Zen-Extras werden explizit versteckt (nicht in btnRefs).
    const wrap = document.getElementById(CONTAINER_ID);
    if (!wrap) return;
    // Refresh traegt im Zen nur das Icon — Beschriftungen haben dort nichts verloren.
    if (S.btnRefs.refresh) {
      S.btnRefs.refresh.textContent = zenActive() ? '⟳' : 'Refresh';
      if (zenActive()) Object.assign(S.btnRefs.refresh.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px' });
      else Object.assign(S.btnRefs.refresh.style, { fontSize: '', lineHeight: '', padding: '' });
    }
    if (zenActive()) {
      for (const child of wrap.children) {
        // Zug-Rueckmeldung und Pool-Zaehler schalten sich selbst (Daten + Popup-Einstellung). Im Zen sind
        // sie der einzige Weg, Overstudied/+XP bzw. den Rest zu sehen (Chessables eigene Anzeige liegt
        // hinterm Backdrop) — aber nur, wenn sie eingeschaltet sind.
        if (child.id === FEEDBACK_ID || child.id === POOL_ID) continue;
        const keep = child === btn || child === S.btnRefs.refresh || child === zenNextBtn
          || child === zenPanelBtn || child === zenAnalyseBtn || child === zenHintBtn;
        child.style.display = keep ? '' : 'none';
      }
      renderFeedback();
      renderPool();
    } else {
      if (zenNextBtn) zenNextBtn.style.display = 'none';
      if (zenPanelBtn) zenPanelBtn.style.display = 'none';
      if (zenAnalyseBtn) zenAnalyseBtn.style.display = 'none';
      if (zenHintBtn) zenHintBtn.style.display = 'none';
      applyButtonSettings();
    }
  }

  function installVollbildEnde() {
    // Esc beendet nur das Browser-Vollbild — dann auch den Zen-Zustand abbauen.
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && zenActive()) exitZen();
      else updateZenButton();   // Vollbild BETRETEN → Knopf wechselt auf „verlassen"
    });
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckFen = self.RepCheckFen || {}).zen = {
    init(deps) {
      ({ S, flash, CONTAINER_ID, FEEDBACK_ID, POOL_ID, renderFeedback, renderPool, applyButtonSettings } = deps);
      Object.defineProperties(S, {
        zenNextBtn: { get: () => zenNextBtn, set: (v) => { zenNextBtn = v; }, enumerable: true },
        zenPanelBtn: { get: () => zenPanelBtn, set: (v) => { zenPanelBtn = v; }, enumerable: true },
        zenAnalyseBtn: { get: () => zenAnalyseBtn, set: (v) => { zenAnalyseBtn = v; }, enumerable: true },
        zenHintBtn: { get: () => zenHintBtn, set: (v) => { zenHintBtn = v; }, enumerable: true },
      });
    },
    ZEN_BACKDROP_ID, ZEN_STYLE_ID, zenTarget, zenActive, zenPokeLayout, zenDrawingsLayer, zenLiftAncestors,
    zenRestoreAncestors, enterZen, exitZen, clickChessableHint, clickChessableNext, zenPanelTarget, zenPanelWidth,
    zenNarrow, zenPanelHeightNarrow, zenReservedRight, zenReservedBottom, zenPanelPlace, zenPanelShow, zenPanelHide,
    toggleZenPanel, updateZenButton, installVollbildEnde,
  };
})();
