// Laeuft als Content-Script in der MAIN-World (siehe manifest.json: world:
// "MAIN") auf chessable.com. Blendet unten rechts zwei Knoepfe ein:
//   - "Copy FEN"   — aktuelle Brettstellung als FEN in die Zwischenablage
//   - "Search FEN" — oeffnet die Chessable-FEN-Suche fuer die Stellung
// und zeigt die zuletzt erspielten XP (nicht Overstudy/Incorrect/Alternative).
//
// MAIN-World ist noetig, weil die zuverlaessige FEN-Quelle die an den Brett-DOM-
// Knoten haengenden React-Fiber-Props sind (`fen`/`interactiveFen`) — die in der
// isolierten Content-Script-Welt NICHT lesbar waeren. Es werden keine chrome.*-
// APIs gebraucht; Clipboard laeuft ueber navigator.clipboard (mit execCommand-
// Fallback). Portiert aus github.com/kahalm/chessable-extension (v0.9.4).
(function () {
  'use strict';

  // Doppel-Init verhindern (z. B. bei mehrfachem Inject).
  if (window.__repcheckChessableFen) return;
  window.__repcheckChessableFen = true;

  // ---- Teil-Dateien verdrahten (lib/fen-extract.js + chessable-fen/*.js, per Manifest VOR dieser Datei geladen) ----
  // Seit der Zerlegung Z38 liegen FEN-Auslese (Lib), Zug-Rueckmeldung, ⏳-Pool, Zen und die Leiste in eigenen Dateien;
  // hier bleiben Kurs-ID/-Name samt Bruecke zur isolierten Welt, die Chessable-FEN-Suche und die Reihenfolge, in der
  // alles anlaeuft. Die Teile legen beim Laden nur Funktionen unter self.RepCheckFen ab; was sie voneinander brauchen,
  // bekommen sie per init(). Danach verschwindet der Name wieder aus dem window der Seite (MAIN-World: jeder globale
  // Name ist fuer die Seite sichtbar).
  //
  // S: geteilter Zustand. Ein Feld haengt der Teil an, dem der Wert gehoert (Getter, ggf. Setter, in seinem init);
  // andere lesen/schreiben nur ueber S: btnRefs (Leiste), zenNextBtn/zenPanelBtn/zenAnalyseBtn/zenHintBtn (Zen, gesetzt
  // von der Leiste), feedbackObserver/watchedFeedbackRoot (Zug-Rueckmeldung, zurueckgesetzt von der Leiste).
  const { extractFenFromReact, getReactFiber } = self.RepCheckFenExtract;
  const S = {};
  const F = self.RepCheckFen;
  const FB = F.feedback, PO = F.pool, ZE = F.zen, TB = F.toolbar;
  delete self.RepCheckFen;
  const { CONTAINER_ID, ensureUi, removeUi, isPracticeMode } = TB;
  const { initFeedbackTracker } = FB;
  FB.init({ S, buttonEnabled: TB.buttonEnabled, renderPool: PO.renderPool });
  PO.init({ buttonEnabled: TB.buttonEnabled });
  ZE.init({
    S, flash: TB.flash, CONTAINER_ID, FEEDBACK_ID: FB.FEEDBACK_ID, POOL_ID: PO.POOL_ID, renderFeedback: FB.renderFeedback,
    renderPool: PO.renderPool, applyButtonSettings: TB.applyButtonSettings,
  });
  TB.init({
    S, debugDump, chessableSearchUrl, currentCourseId, togglePoolPanel: PO.togglePoolPanel, renderPool: PO.renderPool,
    POOL_ID: PO.POOL_ID, POOL_PANEL_ID: PO.POOL_PANEL_ID, toggleFeedbackList: FB.toggleFeedbackList,
    renderFeedback: FB.renderFeedback, FEEDBACK_ID: FB.FEEDBACK_ID, initFeedbackTracker,
    attachLineResetListener: FB.attachLineResetListener, resetLineFeedback: FB.resetLineFeedback, zenActive: ZE.zenActive,
    enterZen: ZE.enterZen, exitZen: ZE.exitZen, toggleZenPanel: ZE.toggleZenPanel, clickChessableNext: ZE.clickChessableNext,
    clickChessableHint: ZE.clickChessableHint,
  });

  function debugDump() {
    const cmSquares = document.querySelectorAll('[data-square]');
    const cmPieces = document.querySelectorAll('[data-piece]');
    const cgBoard = document.querySelector('cg-board, .cg-board, [class*="cg-board"]');
    console.log('[RepCheck Chessable] debug:', {
      url: location.href,
      cmSquaresFound: cmSquares.length,
      cmPiecesFound: cmPieces.length,
      cgBoardFound: !!cgBoard,
      fiberFen: extractFenFromReact(),
      courseId: currentCourseId(),
    });
  }

  // ---------- Chessable search URL ----------

  // Kurs-ID: URL > React-Fiber > erster Kurs-Link (geteilte Datei lib/chessable-course-id.js, per Manifest
  // VOR dieser Datei in der MAIN-World geladen). Bis v1.68.13 kam hier der erste Kurs-Link VOR dem Fiber —
  // auf einer Seite mit Brett und fremden Kurs-Links (Menüs) gewann der Link. Ohne Lib: keine ID.
  const CourseId = self.RepCheckCourseId || null;
  function courseIdInfo() {
    if (!CourseId) return { id: null, source: null };
    return CourseId.resolveCourseId({
      pathname: location.pathname,
      fiberId: boardFiberCourseId,
      links: () => Array.from(document.querySelectorAll('a[href*="/course/"]'), (a) => a.getAttribute('href') || ''),
    });
  }
  function currentCourseId() {
    return courseIdInfo().id;
  }

  function boardFiberCourseId() {
    const anchor = document.getElementById('board') || document.querySelector('[data-square]');
    if (anchor) {
      let fiber = getReactFiber(anchor);
      let depth = 0;
      while (fiber && depth < 60) {
        const id = fiberCourseId(fiber.memoizedProps) || fiberCourseId(fiber.pendingProps);
        if (id) return id;
        fiber = fiber.return;
        depth++;
      }
    }
    return null;
  }

  function fiberCourseId(props) {
    if (!props || typeof props !== 'object') return null;
    const candidates = [
      props.courseId, props.courseID, props.course_id,
      props.course?.id, props.course?.courseId,
    ];
    for (const c of candidates) {
      if (c != null && /^\d+$/.test(String(c))) return String(c);
    }
    return null;
  }

  function chessableSearchUrl(fen) {
    const courseId = currentCourseId();
    if (courseId) {
      // Kursinterne FEN-Suche: "/" -> ";", " " -> %20. Restliche FEN-Zeichen sind
      // URL-sicher, daher KEIN encodeURIComponent (das wuerde ";" zu %3B machen).
      const encoded = fen.replace(/\//g, ';').replace(/ /g, '%20');
      return `https://www.chessable.com/course/${courseId}/fen/${encoded}/`;
    }
    // Fallback (keine Kurs-ID): globale FEN-Suche, "/" -> "U".
    const encoded = fen.replace(/\//g, 'U').replace(/ /g, '%20');
    return `https://www.chessable.com/courses/fen/${encoded}/`;
  }

  // ---- Anlaufen, in der Reihenfolge von vor der Zerlegung ----
  PO.installTagesBruecke();   // Tagesstatistik fuers Pool-Panel
  ZE.installVollbildEnde();   // Esc beendet das Vollbild → Zen abbauen
  TB.installBruecken();       // Button-Einstellung, RookHub-URL, Remember-line-Ergebnis

  if (document.body) ensureUi();
  else document.addEventListener('DOMContentLoaded', ensureUi, { once: true });

  // UI ueber SPA-Navigationen am Leben halten. Verlaesst der User den
  // Practice-Mode (SPA-Nav), wird die UI wieder entfernt.
  const mo = new MutationObserver(() => {
    if (!isPracticeMode()) { removeUi(); return; }
    if (!document.getElementById(CONTAINER_ID)) ensureUi();
    else initFeedbackTracker();   // Notification-Knoten wird bei SPA-Wechseln ersetzt   // UI steht schon, Brett kommt bei Chessable oft später nach
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Navigations-/UI-Linktexte auf der Practice-/Learn-Seite, die KEIN Kursname sind
  // (z. B. „Practice Moves", „Learn Moves", „Review", „nächstes Kapitel", „Previous variation").
  // Diese Links/Labels zeigen ebenfalls auf /course/{id}/… bzw. beschriften den Modus und haben
  // sonst den echten Titel verdrängt (Beispiel: gemeldeter Kursname „Practice Moves"/„Learn Moves").
  // Keine eigene Kopie mehr: die Liste kommt aus lib/chessable-course-names.js, die das Manifest
  // in DIESER (MAIN-)World vor chessable-fen.js lädt — die frühere Kopie hier hing zurück und
  // ließ „Leaderboard"/„Kapitel N" als Kursname durch. Fehlt die Datei, wird nicht gefiltert
  // (kein Absturz der FEN-Tools); die isolierte Welt filtert den gebridgeten Namen ohnehin nochmal.
  const CourseNames = self.RepCheckCourseNames || {};
  function isNavLabel(txt) {
    return typeof CourseNames.isNavLabel === 'function' ? CourseNames.isNavLabel(txt) : false;
  }
  // Kacheltext → Titel (Chessables Kurskachel klebt Titel und Fortschrittsbadges in EINEN Link); Details in
  // lib/chessable-course-names.js. Fehlt die Datei, bleibt der Text, wie er ist.
  function cleanTitle(txt) {
    return typeof CourseNames.cleanCourseTitle === 'function' ? CourseNames.cleanCourseTitle(txt) : (String(txt || '').trim() || null);
  }
  function anchorTitle(a) {
    const head = a.querySelector('h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="name" i]');
    return cleanTitle(((head && head.textContent) || a.textContent || '').replace(/\s+/g, ' ').trim());
  }

  // Kursname aus den React-Fiber-Props (autoritativ, gleiche Quelle wie die verlässliche Kurs-ID):
  // das `course`-Objekt trägt neben `id` auch `name`/`title`. Deutlich robuster als Seitentext,
  // der im Practice-/Learn-Modus nur das Modus-Label liefert.
  function fiberCourseName(props) {
    if (!props || typeof props !== 'object') return null;
    const candidates = [
      props.course?.name, props.course?.title, props.course?.courseName,
      props.courseName, props.courseTitle,
      props.book?.name, props.book?.title,
    ];
    for (const c of candidates) {
      if (typeof c !== 'string') continue;
      const t = c.replace(/\s+/g, ' ').trim();
      if (t && t.length <= 200 && !isNavLabel(t)) return t;
    }
    return null;
  }

  // Lesbarer Kursname: bevorzugt den echten Titel aus dem React-Fiber; sonst der beschreibendste
  // Kurs-Linktext (Nav-/Modus-Labels werden verworfen), zuletzt document.title.
  function currentCourseName() {
    const anchor = document.getElementById('board') || document.querySelector('[data-square]');
    if (anchor) {
      let fiber = getReactFiber(anchor), depth = 0;
      while (fiber && depth < 60) {
        const n = fiberCourseName(fiber.memoizedProps) || fiberCourseName(fiber.pendingProps);
        if (n) return n;
        fiber = fiber.return; depth++;
      }
    }
    const id = currentCourseId();
    if (id) {
      const candidates = [];
      for (const a of document.querySelectorAll('a[href*="/course/' + id + '/"]')) {
        const txt = anchorTitle(a);
        if (txt && txt.length <= 200 && !isNavLabel(txt)) candidates.push(txt);
      }
      // Kurstitel ist i. d. R. der längste, beschreibende Linktext (Nav-Labels sind raus, Badges gekappt).
      if (candidates.length) return candidates.sort((a, b) => b.length - a.length)[0];
    }
    const t = (document.title || '').replace(/\s*[|\-–]\s*Chessable.*$/i, '').trim();
    // Auch der Seitentitel kann ein Nav-Label sein („Leaderboard | Chessable") — sonst landet
    // der als courseName in training-activity/remember-line (gleiche Regel wie in
    // chessable-activity.js).
    return (t && !isNavLabel(t)) ? cleanTitle(t) : null;
  }

  // Kurs-ID (+ Name) an die isolierte Welt (chessable-activity.js) spiegeln: dort ist der
  // React-Fiber nicht lesbar und die Practice-URL (/practice/…) traegt keine Kurs-ID.
  // `courseIdSource` sagt, woher die ID stammt — nur eine per Fiber aufgeloeste macht dort eine
  // Seite zur Kursseite (eine Link-ID auf der Startseite nicht).
  // Nur bei Aenderung posten (kein Spam); deckt initiales Laden + SPA-Navigation ab.
  let lastBroadcastCourseId = null;
  let lastBroadcastCourseName = null;
  let lastBroadcastCourseIdSource = null;
  function broadcastCourseId() {
    const { id, source } = courseIdInfo();
    const name = currentCourseName();
    if (id === lastBroadcastCourseId && name === lastBroadcastCourseName && source === lastBroadcastCourseIdSource) return;
    lastBroadcastCourseId = id;
    lastBroadcastCourseName = name;
    lastBroadcastCourseIdSource = source;
    window.postMessage({ __repcheck: 'course-id', courseId: id, courseIdSource: source, courseName: name }, location.origin);
  }
  broadcastCourseId();
  setInterval(broadcastCourseId, 5000);

  console.log('[RepCheck Chessable] FEN-Tools aktiv');
})();
