// chessable-fen.js-Teil (Zerlegung Z38, MAIN-World): die Leiste unten rechts im Practice-Modus — Copy FEN, Analyse
// (RookHub, neuer Tab), Search FEN, Refresh, Remember line, Vollbild, dazu ⏳ und Zug-Rueckmeldung; Sichtbarkeit je
// Knopf aus dem Popup (`chessableButtons`, nur ein ausdrueckliches true zeigt), RookHub-URL und „Remember line" ueber
// die postMessage-Bruecke zur isolierten Welt. Ein-/Ausbau bei SPA-Navigation (ensureUi/removeUi).
//
// Zustand: Knopf-Referenzen (btnRefs, ueber S fuers Zen lesbar), Einstellung, RookHub-URL, poolTimer.
// Seiteneffekt nur in installBruecken().
// Laden: Manifest content_scripts (chessable.com, world: MAIN), VOR chessable-fen.js. Ablage unter self.RepCheckFen.<teil>
// nur fuer die Verdrahtung — chessable-fen.js nimmt den Namen danach wieder aus dem window der Seite.
(function () {
  'use strict';

  // Wie chessable-fen.js: laeuft die MAIN-World-Leiste in diesem Tab schon, nichts neu anlegen.
  if (window.__repcheckChessableFen) return;

  // Aus chessable-fen.js und den anderen Teilen (init).
  let S, debugDump, chessableSearchUrl, currentCourseId, togglePoolPanel, renderPool, POOL_ID, POOL_PANEL_ID;
  let toggleFeedbackList, renderFeedback, FEEDBACK_ID, initFeedbackTracker, attachLineResetListener;
  let resetLineFeedback, zenActive, enterZen, exitZen, toggleZenPanel, clickChessableNext, clickChessableHint;

  const { buildFEN } = self.RepCheckFenExtract;

  // ---------- Clipboard ----------

  function copyToClipboard(text) {
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

  // ---------- UI ----------

  const CONTAINER_ID = 'repcheck-chessable-fen-tools';
  const COPY_BTN_ID = 'repcheck-chessable-fen-copy-btn';
  const SEARCH_BTN_ID = 'repcheck-chessable-fen-search-btn';

  function styleButton(btn, bg) {
    Object.assign(btn.style, {
      padding: '8px 12px',
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
      background: bg,
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
      cursor: 'pointer',
      opacity: '0.9',
    });
    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.9'; });
  }

  // Mobile: die Floating-Buttons kollidieren unten mit der Firefox-/System-
  // Leiste. Auf schmalen Screens daher höher setzen (+ Safe-Area) und umbrechen
  // lassen. !important, weil die Basis-Position als Inline-Style gesetzt ist.
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
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '2147483647',
      display: 'flex',
      gap: '8px',
    });

    // Rest-Zaehler des Trainingspools. Im Zen-Modus ist Chessables Tab-Leiste verdeckt —
    // deshalb spiegeln wir die Zahl hierher.
    const poolBadge = document.createElement('button');
    poolBadge.type = 'button';
    poolBadge.id = POOL_ID;
    poolBadge.addEventListener('click', togglePoolPanel);
    Object.assign(poolBadge.style, {
      display: 'none', alignItems: 'center', padding: '6px 9px', borderRadius: '6px',
      background: 'rgba(0,0,0,0.45)', color: '#fff', font: '12px/1 system-ui, sans-serif',
      whiteSpace: 'nowrap', alignSelf: 'center', border: 'none', cursor: 'pointer',
    });
    wrap.appendChild(poolBadge);

    // Zug-Rückmeldung (Overstudied / +XP). Liegt in UNSERER Leiste, weil Chessables eigene
    // Anzeige in `.board-footer` sitzt — im Zen-Modus hinter dem Backdrop. Klick öffnet die
    // Aufschlüsselung der Einzelbeträge dieser Linie.
    const feedbackBadge = document.createElement('button');
    feedbackBadge.id = FEEDBACK_ID;
    feedbackBadge.type = 'button';
    Object.assign(feedbackBadge.style, {
      display: 'none', alignItems: 'center', padding: '6px 10px', border: 'none',
      borderRadius: '6px', color: '#fff', font: '600 12px/1 system-ui, sans-serif',
      cursor: 'pointer', background: 'rgba(0,0,0,0.45)',
    });
    feedbackBadge.addEventListener('click', toggleFeedbackList);

    const copyBtn = document.createElement('button');
    copyBtn.id = COPY_BTN_ID;
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy FEN';
    styleButton(copyBtn, '#2e7d32');
    copyBtn.addEventListener('click', () => {
      const fen = buildFEN();
      if (!fen) { flash(copyBtn, 'No board found', '#c62828'); debugDump(); return; }
      if (copyToClipboard(fen)) {
        flash(copyBtn, 'Copied!', '#1565c0');
        console.log('[RepCheck Chessable]', fen);
      } else {
        flash(copyBtn, 'Copy failed', '#c62828');
        console.log('[RepCheck Chessable] FEN (manual copy):', fen);
      }
    });

    const analyseBtn = document.createElement('button');
    analyseBtn.type = 'button';
    analyseBtn.textContent = 'Analyse';
    analyseBtn.title = 'Stellung in RookHub analysieren (neuer Tab)';
    styleButton(analyseBtn, '#00695c');
    // Geteilt mit dem Zen-Knopf (🔬): identisches Verhalten, nur ein anderes Gehaeuse.
    function openAnalysis(btn) {
      const fen = buildFEN();
      if (!fen) { flash(btn, 'No board found', '#c62828'); debugDump(); return; }
      if (!rookhubBaseUrl) { requestRookhubUrl(); flash(btn, 'Set RookHub URL', '#c62828'); return; }
      const orient = fen.split(' ')[1] === 'b' ? 'black' : 'white';   // Brett aus Sicht der Seite am Zug
      const url = rookhubBaseUrl.replace(/\/$/, '') + '/analysis?fen=' + encodeURIComponent(fen) + '&orientation=' + orient;
      console.log('[RepCheck Chessable Analyse]', fen, '->', url);
      const win = window.open(url, '_blank', 'noopener');
      if (!win) flash(btn, 'Popup blocked', '#c62828');
    }
    analyseBtn.addEventListener('click', () => openAnalysis(analyseBtn));

    const searchBtn = document.createElement('button');
    searchBtn.id = SEARCH_BTN_ID;
    searchBtn.type = 'button';
    searchBtn.textContent = 'Search FEN';
    styleButton(searchBtn, '#1565c0');
    searchBtn.addEventListener('click', () => {
      const fen = buildFEN();
      if (!fen) { flash(searchBtn, 'No board found', '#c62828'); debugDump(); return; }
      const url = chessableSearchUrl(fen);
      console.log('[RepCheck Chessable Search]', fen, '->', url);
      const win = window.open(url, '_blank', 'noopener');
      if (!win) flash(searchBtn, 'Popup blocked', '#c62828');
    });

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.textContent = 'Refresh';
    styleButton(refreshBtn, '#616161');
    refreshBtn.title = 'Seite neu laden';
    refreshBtn.addEventListener('click', () => {
      window.addEventListener('beforeunload', (e) => { e.stopImmediatePropagation(); delete e.returnValue; }, { capture: true, once: true });
      location.reload();
    });

    const rememberBtn = document.createElement('button');
    rememberBtn.type = 'button';
    rememberBtn.textContent = REMEMBER_LABEL;
    styleButton(rememberBtn, '#6a1b9a');
    rememberBtn.title = 'Stellung in RookHub merken';
    rememberBtn.addEventListener('click', () => rememberLine(rememberBtn));

    const fullscreenBtn = document.createElement('button');
    fullscreenBtn.type = 'button';
    fullscreenBtn.textContent = '⛶';   // kompaktes Vollbild-Symbol statt Text-Button
    styleButton(fullscreenBtn, '#37474f');
    Object.assign(fullscreenBtn.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px' });
    fullscreenBtn.title = 'Brett bildschirmfüllend (Esc beendet)';
    fullscreenBtn.addEventListener('click', () => { zenActive() ? exitZen() : enterZen(fullscreenBtn); });

    // Zen-only: ▸ klickt Chessables „Next", 💬 holt die Kommentar-/Zugspalte
    // vor das Backdrop. Außerhalb des Zen-Modus unsichtbar; bewusst NICHT in
    // btnRefs (keine Popup-Toggles dafür).
    const zNext = document.createElement('button');
    zNext.type = 'button';
    zNext.id = 'repcheck-zen-next';
    zNext.textContent = '▸';
    zNext.title = 'Next (nächste Variante/Kapitel)';
    styleButton(zNext, '#2e7d32');
    Object.assign(zNext.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px', display: 'none' });
    zNext.addEventListener('click', () => clickChessableNext(zNext));
    S.zenNextBtn = zNext;

    // Zen-only: 💡 klickt Chessables eigenen Hint-Knopf (liegt hinterm Backdrop).
    const zHint = document.createElement('button');
    zHint.type = 'button';
    zHint.id = 'repcheck-zen-hint';
    zHint.textContent = '💡';
    zHint.title = 'Hint (Chessable-Tipp)';
    styleButton(zHint, '#f9a825');
    Object.assign(zHint.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px', display: 'none' });
    zHint.addEventListener('click', () => clickChessableHint(zHint));
    S.zenHintBtn = zHint;

    // Zen-only: 🔬 oeffnet die aktuelle Stellung in der RookHub-Analyse (neuer Tab) —
    // draussen uebernimmt das der beschriftete Analyse-Knopf, im Zen gilt: nur Icons.
    const zAnalyse = document.createElement('button');
    zAnalyse.type = 'button';
    zAnalyse.id = 'repcheck-zen-analyse';
    zAnalyse.textContent = '🔬';
    zAnalyse.title = 'Stellung in RookHub analysieren (neuer Tab)';
    styleButton(zAnalyse, '#00695c');
    Object.assign(zAnalyse.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px', display: 'none' });
    zAnalyse.addEventListener('click', () => openAnalysis(zAnalyse));
    S.zenAnalyseBtn = zAnalyse;

    const zPanel = document.createElement('button');
    zPanel.type = 'button';
    zPanel.textContent = '💬';
    zPanel.title = 'Kommentare/Züge ein-/ausblenden';
    styleButton(zPanel, '#455a64');
    Object.assign(zPanel.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px', display: 'none' });
    zPanel.addEventListener('click', () => toggleZenPanel(zPanel));
    S.zenPanelBtn = zPanel;

    // XP-Anzeige vorerst deaktiviert (kommt später wieder) — Badge + Tracker aus.
    btnRefs = { copyFen: copyBtn, analyse: analyseBtn, searchFen: searchBtn, refresh: refreshBtn, remember: rememberBtn, fullscreen: fullscreenBtn };
    wrap.appendChild(feedbackBadge);
    wrap.appendChild(copyBtn);
    wrap.appendChild(analyseBtn);
    wrap.appendChild(searchBtn);
    wrap.appendChild(refreshBtn);
    wrap.appendChild(rememberBtn);
    wrap.appendChild(zHint);
    wrap.appendChild(zAnalyse);
    wrap.appendChild(zPanel);
    wrap.appendChild(zNext);
    wrap.appendChild(fullscreenBtn);
    document.body.appendChild(wrap);
    applyButtonSettings();     // je nach Popup-Einstellung ein-/ausblenden
    requestButtonSettings();   // aktuelle Einstellung aus der isolierten Welt anfordern
    // RookHub-URL aus der isolierten Welt (chessable-activity.js) anfordern, damit der
    // Analyse-Button beim Klick synchron einen neuen Tab öffnen kann (Popup-Blocker-sicher).
    requestRookhubUrl();
  }

  // ---- Pro-Button-Sichtbarkeit (im Popup einstellbar) ----
  // Welche Buttons und Anzeigen der Leiste unten rechts erscheinen, ist im Extension-Popup einzeln
  // umschaltbar (chrome.storage.local `chessableButtons`). Seit v1.59.0 ist ALLES aus, bis es dort
  // jemand einschaltet: nur ein ausdrückliches `true` zeigt ein Element, ein fehlender Schlüssel heißt aus
  // — auch solange die Einstellung noch nicht angekommen ist, damit nichts kurz aufblitzt.
  // chessable-fen.js läuft in der MAIN-World ohne chrome.*-Zugriff → chessable-activity.js (isoliert)
  // spiegelt die Einstellung per postMessage hierher (Same-Window + Same-Origin geprüft; kein Secret).
  let btnRefs = {};
  let buttonSettings = {};
  function buttonEnabled(key) {
    return buttonSettings[key] === true;
  }
  function applyButtonSettings() {
    for (const key of Object.keys(btnRefs)) {
      const btn = btnRefs[key];
      if (btn) btn.style.display = buttonEnabled(key) ? '' : 'none';
    }
    // ⏳-Zaehler und Zug-Rueckmeldung haben eigene Daten und schalten sich selbst (fragen buttonEnabled).
    renderFeedback();
    renderPool();
  }
  function requestButtonSettings() {
    window.postMessage({ __repcheck: 'request-chessable-buttons' }, location.origin);
  }
  // Die RookHub-URL liegt extension-privat in chrome.storage.local (nur isolierte Welt lesbar);
  // chessable-activity.js spiegelt sie hierher, damit der Analyse-Button sie synchron im
  // Klick-Handler hat. Nur Same-Window + Same-Origin akzeptieren (Defense-in-Depth; die URL ist
  // kein Secret, der Token bleibt in der isolierten Welt).
  let rookhubBaseUrl = null;
  function requestRookhubUrl() {
    window.postMessage({ __repcheck: 'request-rookhub-url' }, location.origin);
  }
  // „Remember line": FEN + Kontext per window.postMessage an die isolierte Welt
  // (chessable-activity.js), die den Egress mit RookHub-Config + Background-Worker
  // erledigt — so bleibt der Token aus dem Page-Kontext. postMessage ist der
  // robuste MAIN↔isoliert-Kanal (CustomEvent-detail ist in Firefox heikel).
  const REMEMBER_LABEL = 'Remember line';
  let pendingRememberBtn = null;

  function rememberLine(btn) {
    const fen = buildFEN();
    if (!fen) { flash(btn, 'No board found', '#c62828'); debugDump(); return; }
    pendingRememberBtn = btn;
    btn.textContent = 'Saving…';
    btn.disabled = true;
    window.postMessage({
      __repcheck: 'remember-line',
      fen, courseId: currentCourseId(), sourceUrl: location.href,
    }, location.origin);
  }

  function flash(btn, text, color) {
    const oldText = btn.textContent;
    const oldBg = btn.style.background;
    btn.textContent = text;
    btn.style.background = color;
    setTimeout(() => {
      btn.textContent = oldText;
      btn.style.background = oldBg;
    }, 1200);
  }

  // Seit v1.14.0: die FEN-Tools erscheinen NUR im Practice-Mode
  // (chessable.com/practice/…) — auf Kurs-Übersichten/Buch-Seiten o. Ä. nicht.
  function isPracticeMode() {
    return /^\/practice(\/|$)/.test(location.pathname);
  }

  function removeUi() {
    document.getElementById(CONTAINER_ID)?.remove();
    if (poolTimer) { clearInterval(poolTimer); poolTimer = null; }
    document.getElementById(POOL_PANEL_ID)?.remove();
    S.feedbackObserver?.disconnect();
    S.feedbackObserver = null;
    S.watchedFeedbackRoot = null;
    // Practice-Mode verlassen -> die Linie ist vorbei; Eintraege NICHT in die naechste Sitzung
    // mitschleppen.
    resetLineFeedback();
  }

  function ensureUi() {
    if (!isPracticeMode()) { removeUi(); return; }
    createUi();
    initFeedbackTracker();   // Zug-Rueckmeldung mitschneiden (Overstudied / +XP)
    attachLineResetListener();
    renderPool();
    // Der Tab-Zaehler aendert sich auch ohne Zug (Wechsel Learn/Review, Nachladen) — ruhiger
    // Takt statt eines weiteren Observers auf fremdem DOM.
    if (!poolTimer) poolTimer = setInterval(renderPool, 3000);
  }

  let poolTimer = null;

  // Antworten der isolierten Welt: Button-Einstellung, RookHub-URL, Ergebnis von „Remember line".
  function installBruecken() {
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__repcheck !== 'chessable-buttons') return;
      const s = e.data.settings;
      if (s && typeof s === 'object') { buttonSettings = Object.assign({}, s); applyButtonSettings(); }
    });

    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__repcheck !== 'rookhub-url') return;
      if (typeof e.data.url === 'string' && e.data.url) rookhubBaseUrl = e.data.url;
    });

    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__repcheck !== 'remember-line-result') return;
      const btn = pendingRememberBtn;
      pendingRememberBtn = null;
      if (!btn) return;
      btn.disabled = false;
      btn.textContent = REMEMBER_LABEL;
      flash(btn, e.data.ok ? 'Remembered!' : (e.data.error || 'Failed'), e.data.ok ? '#2e7d32' : '#c62828');
    });
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckFen = self.RepCheckFen || {}).toolbar = {
    init(deps) {
      ({ S, debugDump, chessableSearchUrl, currentCourseId, togglePoolPanel, renderPool, POOL_ID, POOL_PANEL_ID } = deps);
      ({ toggleFeedbackList, renderFeedback, FEEDBACK_ID, initFeedbackTracker, attachLineResetListener } = deps);
      ({ resetLineFeedback, zenActive, enterZen, exitZen, toggleZenPanel, clickChessableNext, clickChessableHint } = deps);
      Object.defineProperties(S, {
        btnRefs: { get: () => btnRefs, enumerable: true },
      });
    },
    copyToClipboard, fallbackCopy, CONTAINER_ID, COPY_BTN_ID, SEARCH_BTN_ID, styleButton, MOBILE_STYLE_ID,
    injectMobileStyle, createUi, buttonEnabled, applyButtonSettings, requestButtonSettings, requestRookhubUrl,
    REMEMBER_LABEL, rememberLine, flash, isPracticeMode, removeUi, ensureUi, installBruecken,
  };
})();
