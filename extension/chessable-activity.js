// Laeuft als Content-Script (ISOLIERTE Welt) auf chessable.com und misst die
// AKTIVE Trainingszeit, um sie an RookHub zu melden (Kategorie „Chessable" im
// Trainingsziele-Tracker). Isolierte Welt ist noetig, weil hier chrome.storage
// (RookHub-Config) + chrome.runtime (Egress ueber den Background-Worker) gebraucht
// werden — anders als chessable-fen.js, das fuer den React-Fiber MAIN-World braucht.
//
// „Aktiv" = ALLE Bedingungen: ein Brett ist da (cm-chessboard [data-square]) UND
// der Tab ist sichtbar+fokussiert UND in den letzten IDLE_MS gab es ein hartes
// Aktivitaetssignal (Brett-Mutation = Zug, Klick/Taste aufs Brett, oder eine
// gewertete Zug-Notification). Reines Offenlassen zaehlt NICHT.
//
// RookHub-Config (URL+Token) kommt aus chrome.storage.local (Key `rookhubConfig`),
// gespiegelt von content.js auf chess.com/lichess (IndexedDB ist origin-scoped).
// Ohne Config wird nichts gemessen/gesendet.
(function () {
  'use strict';

  if (window.__repcheckChessableActivity) return;
  window.__repcheckChessableActivity = true;

  const TICK_MS = 5000;        // Mess-Takt
  const IDLE_MS = 60000;       // ohne hartes Signal laenger als das → idle, zaehlt nicht
  const FLUSH_MS = 60000;      // Sende-Intervall
  const MIN_FLUSH_MS = 10000;  // erst ab so viel akkumulierter Zeit senden
  const MAX_FLUSH_S = 3600;    // Serverseitiger Cap je Haeppchen (hier gespiegelt)

  // ---- Sprache (geteilte Tabelle lib/i18n.js, per Manifest VOR dieser Datei geladen) ----
  // Die Statustexte des Kurs-Imports entstehen HIER und gehen als fertiger Text ans Popup
  // (Nachrichtenformat unverändert) — also wird auch hier übersetzt. Fehlt die Tabelle
  // (alte Installation / Manifest noch ohne lib/i18n.js), liefert t() den Schlüssel zurück,
  // statt zu werfen: sichtbar kaputt, aber der Import läuft weiter.
  let rcLang = 'en';
  function t(key, params) {
    const i18n = self.RepCheckI18n;
    if (!i18n || typeof i18n.translate !== 'function') return key;
    return i18n.translate(rcLang, key, params);
  }
  function applyLang(gespeichert) {
    const i18n = self.RepCheckI18n;
    rcLang = (i18n && typeof i18n.resolveLang === 'function')
      ? i18n.resolveLang(gespeichert, navigator.languages)
      : 'en';
  }
  try {
    chrome.storage.local.get(['rcLang'], (r) => applyLang(r && r.rcLang));
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.rcLang) applyLang(ch.rcLang.newValue);
      // Kein Neu-Rendern nötig: diese Datei hält keine eigene UI; der zuletzt gesetzte
      // Statustext bleibt in seiner Sprache, der nächste kommt in der neuen.
    });
  } catch (e) { /* ohne chrome.storage bleibt es bei 'en' */ }

  let activeMs = 0;
  let movesTrained = 0;
  let linesTrained = 0;        // abgeschlossene Linien (Klick/Leertaste auf „Next variation")
  let lastGameOid = null;      // oid der zuletzt von der SPA geladenen Linie (aus dem Mitschnitt)
  let lastGameOidAt = 0;
  let lastActivity = 0;
  let lastFlush = Date.now();
  let courseKind = null;       // RepertoireKind (vom Server, z. B. "Opening") oder null = unbekannt
  let lookedUpCourseId = null; // verhindert Doppel-Lookups bei unveraenderter Kurs-ID
  let bridgedCourseId = null;  // Kurs-ID aus chessable-fen.js (MAIN-World, liest den React-Fiber)
  let bridgedCourseName = null; // Kursname aus chessable-fen.js (best-effort, nur Anzeige)

  const now = () => Date.now();
  const bump = () => { lastActivity = now(); };
  const boardPresent = () => !!document.querySelector('[data-square]');

  // ---- Aktivitaets-Signale ----
  document.addEventListener('pointerdown', () => { if (boardPresent()) bump(); }, true);
  document.addEventListener('keydown', () => { if (boardPresent()) bump(); }, true);

  // Abgeschlossene LINIEN zaehlen: nach dem Ende einer Variante zeigt Chessable den
  // „Next variation"-Knopf (dt. „Nächste Variante") — genau EIN Klick darauf = eine Linie.
  // TEILSTRING-Match (nicht verankert): der Knopf traegt oft Zusatztext (Tastatur-Hinweis,
  // Icon-Label) — ein exakter Match verfehlte ihn in der Praxis (linesTrained blieb 0).
  // Laengen-Deckel, damit kein grosser Container mit zufaellig enthaltenem Text zaehlt.
  // Bewusst NICHT das nackte „Next" (das blaettert im Learn-Modus jeden Zug weiter).
  const NEXT_VARIATION_RE = /next\s+variation|n(ä|ae)chste\s+variante/i;
  const isNextVariationButton = (el) => {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length > 0 && t.length <= 60 && NEXT_VARIATION_RE.test(t)) return true;
    const aria = el.getAttribute && (el.getAttribute('aria-label') || '');
    return !!aria && NEXT_VARIATION_RE.test(aria);
  };
  // Gemeinsames Dedupe-Fenster fuer Klick UND Taste: loest die Leertaste den Knopf doch als
  // echten Klick aus, zaehlt das Paar trotzdem nur EINE Linie.
  let lastLineCountAt = 0;
  function countLine() {
    if (now() - lastLineCountAt < 1500) return;
    lastLineCountAt = now();
    linesTrained++;
    if (!lineHatFehler) linesCorrect++;
    lineHatFehler = false;                 // naechste Linie faengt sauber an
    bump();
    reportTrainedLine();
  }

  // „Linie auf Chessable trainiert" → RookHub markiert sie im Kurs als gelöst und zieht den
  // Repertoire-SR nach (neu → gelernt, fällig → +1 Stufe). Best-effort + idempotent serverseitig;
  // je oid nur alle 5 min erneut gemeldet (Doppel-Klicks/Space+Klick).
  const reportedOids = new Map();   // oid → zuletzt gemeldet (ms)
  async function reportTrainedLine() {
    const bid = currentCourseId();
    if (!bid || !lastGameOid) return;
    if (now() - lastGameOidAt > 30 * 60 * 1000) return;   // veraltetes Signal (Tab lag herum)
    const oid = lastGameOid;
    const last = reportedOids.get(oid) || 0;
    if (now() - last < 5 * 60 * 1000) return;
    reportedOids.set(oid, now());
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) return;
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    try {
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: baseUrl + '/api/extension/chessable/line-trained',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + cfg.token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ bid, oid }),
        expect: 'json',
      }, () => { /* best-effort */ });
    } catch (e) { /* still */ }
  }
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button, a, [role="button"]');
    if (!btn) return;
    if (isNextVariationButton(btn)) countLine();
  }, true);
  // Chessable springt per LEERTASTE (globaler Shortcut, KEIN click-Event) zur naechsten Variante —
  // der Haupt-Workflow. Space/Enter zaehlen, wenn ein sichtbarer „Next variation"-Knopf existiert
  // (also der Abschluss-/Navigations-Zustand da ist) und keine Eingabe fokussiert ist.
  function nextVariationButtonVisible() {
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      if (!isNextVariationButton(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (nextVariationButtonVisible()) countLine();
  }, true);

  // Gewertete Zuege: <span data-testid="moveNotification"> — jede neue Benachrichtigung ist EIN
  // gewerteter Zug (richtig/falsch/overstudied). Der Observer haengt am ELTERN-Knoten, weil React
  // den Notification-Knoten selbst austauscht.
  //
  // WICHTIG (Messung 08.08., Inspector v0.6.1): `attributes` MUSS mitbeobachtet werden. Eine
  // wortgleiche Wiederholung — eine Linie, in der mehrere Zuege dieselben „+150 XP" geben —
  // aendert weder Text noch Knoten; das innerHTML ist byte-identisch. Chessable stoesst nur die
  // Einblend-Animation per ATTRIBUT am Wurzelknoten neu an. Ohne `attributes: true` feuert der
  // Observer dort gar nicht und der Zug faellt still unter den Tisch. Genau daran lag der
  // gemeldete Undercount (4,4 statt real 10-15 Zuege je Linie).
  //
  // Das Zeitfenster steht deshalb auf 400 ms: gemessene echte Zuege lagen 1,8-2,6 s auseinander,
  // alles darunter ist Animations-Flackern desselben Zuges. 800 ms verschluckte zusaetzlich
  // schnell gespielte Zuege.
  let notifObserver = null, watchedNotifParent = null, lastMoveCountAt = 0;
  // Genauigkeit: je Zug der Zustand aus der Icon-Klasse (lib/chessable-feedback.js).
  // `lineHatFehler` gilt fuer die LAUFENDE Linie und wird beim Linienwechsel ausgewertet.
  let movesCorrect = 0, linesCorrect = 0, lineHatFehler = false;

  /** Sichtbares Rueckmeldungs-Icon -> Zustand. DOM-Teil lokal, die Klassen-Zuordnung geteilt. */
  function feedbackKindOf(root) {
    const map = (self.RepCheckFeedback && self.RepCheckFeedback.kindFromClass) || (() => null);
    for (const icon of root.querySelectorAll('.icon-circle-wrapper .icon')) {
      const cs = getComputedStyle(icon);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const k = map(icon.className);
      if (k) return k;
    }
    return null;
  }
  function watchMoveNotif() {
    const n = document.querySelector('[data-testid="moveNotification"]');
    const parent = n && n.parentElement;
    if (!parent || watchedNotifParent === parent) return;
    notifObserver?.disconnect();
    watchedNotifParent = parent;
    notifObserver = new MutationObserver(() => {
      const cur = document.querySelector('[data-testid="moveNotification"]');
      const t = cur ? cur.textContent.trim() : '';
      if (!t) return;
      bump();
      if (now() - lastMoveCountAt > 400) {
        movesTrained++; lastMoveCountAt = now();
        const kind = feedbackKindOf(parent);
        const istFehler = (self.RepCheckFeedback && self.RepCheckFeedback.isFehler)
          ? self.RepCheckFeedback.isFehler(kind) : false;
        if (istFehler) lineHatFehler = true;
        else if (kind) movesCorrect++;     // 'alt' zaehlt als richtig, unbekannt gar nicht
      }
    });
    notifObserver.observe(parent, { childList: true, characterData: true, subtree: true, attributes: true });
  }

  // Brett-Mutationen (Figur bewegt) = harter Aktivitaetsnachweis.
  let boardObserver = null, watchedBoard = null;
  function watchBoard() {
    const sq = document.querySelector('[data-square]');
    const board = sq ? (sq.closest('#board, [class*="chessboard"], cg-container') || sq.parentElement) : null;
    if (!board || watchedBoard === board) return;
    boardObserver?.disconnect();
    watchedBoard = board;
    boardObserver = new MutationObserver(() => bump());
    boardObserver.observe(board, { childList: true, subtree: true, attributes: true });
  }

  // ---- Config + Egress ----
  function readConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('rookhubConfig', (r) => resolve((r && r.rookhubConfig) || null));
      } catch (e) { resolve(null); }
    });
  }

  // Kurs-ID ermitteln. In der isolierten Welt ist der React-Fiber NICHT lesbar und
  // die Practice-URL (/practice/…) traegt keine Kurs-ID — daher bevorzugt die von
  // chessable-fen.js (MAIN-World) gespiegelte ID, sonst URL- bzw. Link-Heuristik.
  let stickyCourseId = null;  // letzte sicher erkannte Kurs-ID der Sitzung (SPA-Luecken ueberbruecken)
  function currentCourseId() {
    const direct = (() => {
      if (bridgedCourseId) return bridgedCourseId;
      const m = /\/courses?\/(\d+)(?:\/|$)/.exec(location.pathname);
      if (m) return m[1];
      for (const a of document.querySelectorAll('a[href*="/course/"]')) {
        const am = /\/course\/(\d+)(?:\/|$)/.exec(a.getAttribute('href') || '');
        if (am) return am[1];
      }
      return null;
    })();
    // Sticky: auf der Practice-Seite verschwinden die Kurs-Links je nach SPA-Zustand — dann galt
    // die Minute bisher als „ohne Kurs" (~60 % der Haeppchen). Die zuletzt erkannte ID bleibt
    // gueltig, bis eine ANDERE erkannt wird; gezaehlt wird ohnehin nur bei vorhandenem Brett.
    if (direct) stickyCourseId = direct;
    return direct || stickyCourseId;
  }

  // chessable-fen.js (MAIN-World) spiegelt die per React-Fiber aufgeloeste Kurs-ID hierher.
  // Nur Same-Window + Same-Origin akzeptieren (Defense-in-Depth). Rest-Risiko: ein
  // beliebiges Skript IM chessable.com-Tab teilt window+origin und könnte diese
  // Bridge-Messages fälschen — der Token bleibt aber aus dem Page-Kontext heraus,
  // Impact wäre nur eingeschleuste Anzeige-/Merk-Daten, kein Token-Diebstahl.
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__repcheck !== 'course-id') return;
    const id = e.data.courseId;
    bridgedCourseId = (id != null && /^\d+$/.test(String(id))) ? String(id) : null;
    const name = e.data.courseName;
    bridgedCourseName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 200) : null;
  });

  // ---- Kursnamen-Kern (geteilte Datei lib/chessable-course-names.js, per Manifest VOR dieser
  // Datei geladen; das Popup injiziert sie bei Bedarf mit). Keine eigene Kopie mehr — die
  // Nav-Label-Liste (füllte historisch die Statistik mit „Practice Moves"/„Leaderboard"-Müll)
  // lief zwischen den Laufzeitdateien auseinander. Fehlt die Datei (Tab von vor dem Update),
  // filtern/decodieren wir nicht, statt zu werfen: der Server heilt den Namen über die Kurs-ID.
  const CourseNames = self.RepCheckCourseNames || {};
  function isNavLabel(txt) {
    return typeof CourseNames.isNavLabel === 'function' ? CourseNames.isNavLabel(txt) : false;
  }

  // Lesbarer Kursname (Fallback, falls die MAIN-World-Bridge noch nichts gespiegelt hat).
  // Modus-/Nav-Labels werden verworfen — lieber KEIN Name (der Server heilt über die Kurs-ID)
  // als ein falscher.
  // Kacheltext → Titel: Chessables Kurskachel ist EIN Link, dessen textContent Titel und Fortschrittsbadges
  // zusammenklebt („Short & Sweet0%Priority0/15variations✓ 0/15" — so hieß am 2026-09-19 ein Repertoire).
  // Ein Überschriften-Element im Link trägt den Titel allein; sonst kappt cleanCourseTitle am ersten Badge.
  function cleanTitle(txt) {
    return typeof CourseNames.cleanCourseTitle === 'function' ? CourseNames.cleanCourseTitle(txt) : (String(txt || '').trim() || null);
  }
  function anchorTitle(a) {
    const head = a.querySelector('h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="name" i]');
    return cleanTitle(((head && head.textContent) || a.textContent || '').replace(/\s+/g, ' ').trim());
  }
  function currentCourseName() {
    if (bridgedCourseName && !isNavLabel(bridgedCourseName)) return cleanTitle(bridgedCourseName);
    const id = currentCourseId();
    if (id) {
      const candidates = [];
      for (const a of document.querySelectorAll('a[href*="/course/' + id + '/"]')) {
        const txt = anchorTitle(a);
        if (txt && txt.length <= 200 && !isNavLabel(txt)) candidates.push(txt);
      }
      if (candidates.length) return candidates.sort((a, b) => b.length - a.length)[0];
    }
    const t = (document.title || '').replace(/\s*[|\-–]\s*Chessable.*$/i, '').trim();
    return (t && !isNavLabel(t)) ? cleanTitle(t) : null;
  }

  // ---- Autoritativer Kursname über den Chessable-Bearer ----
  //
  // Der DOM/React-Fiber liefert im Practice-/Learn-Modus oft nur Modus-Labels statt des
  // echten Kurstitels. chessable-token.js legt den eingeloggten Chessable-JWT in
  // chrome.storage.local (`chessableToken`) ab; damit fragen wir Chessables eigene
  // getHomeData-API ab (same-origin auf chessable.com → keine CORS-/Cloudflare-Hürde,
  // genau wie die Chessable-SPA selbst) und bauen eine autoritative bid→Name-Karte.
  // Der Token verlässt den Browser nicht — die Anfrage geht an chessable.com.
  const API_NAMES_TTL_MS = 6 * 60 * 60 * 1000; // 6 h
  let apiCourseNames = {};      // bid(string) → Kursname
  let apiNamesFetchedAt = 0;
  let apiNamesFetching = null;  // in-flight Promise (dedupe)
  let apiNamesLoaded = false;   // persistierten Cache erst einmal laden

  // uid steckt im JWT-Payload unter user.uid (wie piratechess/JwtHelper) — aus der geteilten Lib.
  function decodeUid(token) {
    return typeof CourseNames.decodeChessableUid === 'function'
      ? CourseNames.decodeChessableUid(token) : null;
  }

  function readChessableToken() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('chessableToken', (r) =>
          resolve((r && r.chessableToken && r.chessableToken.token) || null));
      } catch (e) { resolve(null); }
    });
  }

  // 401 von der Chessable-API = der Bearer ist serverseitig tot (Logout/Ablauf):
  // die in chrome.storage.local liegende Kopie loeschen, damit sie den Logout
  // nicht ueberlebt. Nach erneutem Login legt chessable-token.js automatisch
  // den frischen Token nach (Load/Fokus/storage-Event).
  function clearStoredChessableToken() {
    try { chrome.storage.local.remove('chessableToken'); } catch (e) { /* storage nicht verfuegbar — ignorieren */ }
  }

  async function fetchCourseNameMap() {
    const token = await readChessableToken();
    if (!token) return null;
    const uid = decodeUid(token);
    if (!uid) return null;
    try {
      const resp = await fetch(
        `https://www.chessable.com/api/v1/getHomeData?uid=${uid}&sortBookRowsBy=alphabetically&userLanguageShort=en`,
        { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }, credentials: 'include' });
      if (resp.status === 401) clearStoredChessableToken();
      if (!resp.ok) return null;
      const data = await resp.json();
      const map = typeof CourseNames.parseCourseNameMap === 'function'
        ? CourseNames.parseCourseNameMap(data) : {};
      return Object.keys(map).length ? map : null;
    } catch (e) { return null; }
  }

  function loadPersistedNames() {
    if (apiNamesLoaded) return Promise.resolve();
    apiNamesLoaded = true;
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('chessableCourseNames', (r) => {
          const c = r && r.chessableCourseNames;
          if (c && c.map && typeof c.map === 'object') {
            apiCourseNames = c.map;
            apiNamesFetchedAt = c.fetchedAt || 0;
          }
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }

  // Baut/aktualisiert die bid→Name-Karte. `force` umgeht die TTL (z. B. bei neuem, noch
  // unbekanntem Kurs). Concurrent-Aufrufe teilen sich denselben Fetch.
  async function ensureCourseNames(force) {
    await loadPersistedNames();
    if (!force && Object.keys(apiCourseNames).length && (Date.now() - apiNamesFetchedAt) < API_NAMES_TTL_MS)
      return apiCourseNames;
    if (apiNamesFetching) return apiNamesFetching;
    apiNamesFetching = (async () => {
      const map = await fetchCourseNameMap();
      if (map) {
        apiCourseNames = map;
        apiNamesFetchedAt = Date.now();
        try { chrome.storage.local.set({ chessableCourseNames: { map, fetchedAt: apiNamesFetchedAt } }); } catch (e) {}
      }
      apiNamesFetching = null;
      return apiCourseNames;
    })();
    return apiNamesFetching;
  }

  function apiCourseName(courseId) {
    return (courseId && apiCourseNames[String(courseId)]) || null;
  }

  // Bester verfügbarer Name: Chessable-API (autoritativ) > MAIN-World-DOM-Bridge > lokale Heuristik.
  // Kursname aus einer schon geholten/mitgeschnittenen Linie dieses Kurses (game.name) — Chessables eigene
  // Angabe, auch fuer Kurse, die nicht im Konto liegen und deshalb in der Kursliste per Token fehlen.
  function capturedCourseName(courseId) {
    if (!courseId || String(cap.bid) !== String(courseId) || !Crawl || typeof Crawl.parseCourseNameFromGame !== 'function') return null;
    for (const oid in cap.games) {
      const n = Crawl.parseCourseNameFromGame(cap.games[oid]);
      if (n && !isNavLabel(n)) return n;
    }
    return null;
  }

  // Reihenfolge = Verlaesslichkeit: Kursliste per Token > Linien-JSON > MAIN-World-Bridge > Seitentext (gesaeubert).
  function bestCourseName(courseId) {
    return apiCourseName(courseId)
      || capturedCourseName(courseId)
      || (bridgedCourseName && !isNavLabel(bridgedCourseName) ? cleanTitle(bridgedCourseName) : null)
      || currentCourseName();
  }

  // Einmalig pro Kurs-ID: fragt RookHub-Repertoires ab und sucht den passenden Kind-Wert.
  async function lookupCourseKind() {
    const courseId = currentCourseId();
    if (!courseId || courseId === lookedUpCourseId) return;
    lookedUpCourseId = courseId;
    courseKind = null;

    // Kursname-Karte für den (evtl. neuen) Kurs sicherstellen — unabhängig von der
    // RookHub-Config; force-refresh nur, wenn der Kurs noch keinen bekannten Namen hat.
    ensureCourseNames(!apiCourseName(courseId));

    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) return;
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    try {
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: baseUrl + '/api/extension/repertoires',
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/json' },
        expect: 'json',
      }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok || !Array.isArray(resp.body)) return;
        const match = resp.body.find(r => r.chessableCourseId === courseId);
        if (match != null) courseKind = match.kind;
      });
    } catch (e) {}
  }

  // ---------- Tagesstatistik (lokal) ----------
  //
  // Grundlage für die Hochrechnung hinter dem ⏳-Zähler: wie viele Linien heute schon
  // wiederholt wurden und wie lange sie im Schnitt gedauert haben.
  //
  // Bewusst LOKAL und unabhängig von RookHub — die Zahl soll auch ohne konfigurierte Instanz
  // stimmen. Verbucht wird genau dort, wo die Zähler endgültig verbraucht sind: beim Verwerfen
  // (nicht verbunden) und beim erfolgreichen Senden. NICHT beim Fehlschlag — dort werden sie
  // zurückgebucht und später erneut gesendet, ein Zählen an der Stelle zählte doppelt.
  //
  // Gehalten werden 14 Tage, damit sich „heute" gegen den eigenen Schnitt einordnen lässt und
  // eine dünne Tagesbasis (die ersten paar Linien) nicht zu einer Fantasie-Hochrechnung führt.
  const DAILY_KEY = 'rcDailyStats';
  const DAILY_MAX_DAYS = 14;

  /** Lokales Datum als YYYY-MM-DD — bewusst NICHT UTC: „heute" ist der Tag des Nutzers. */
  function tagesSchluessel(d) {
    const x = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  }

  function dailyLesen() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([DAILY_KEY], (r) => {
          const roh = (r && r[DAILY_KEY]) || {};
          resolve(Array.isArray(roh.days) ? roh.days : []);
        });
      } catch (e) { resolve([]); }
    });
  }

  async function dailyBuchen(secs, moves, lines, movesOk, linesOk) {
    if (!secs && !moves && !lines) return;
    const tag = tagesSchluessel();
    const days = await dailyLesen();
    let heute = days.find((d) => d.d === tag);
    if (!heute) { heute = { d: tag, s: 0, m: 0, l: 0 }; days.push(heute); }
    heute.s += secs || 0;
    heute.m += moves || 0;
    heute.l += lines || 0;
    heute.mok = (heute.mok || 0) + (movesOk || 0);
    heute.lok = (heute.lok || 0) + (linesOk || 0);
    days.sort((a, b) => (a.d < b.d ? 1 : -1));          // neueste zuerst
    try { chrome.storage.local.set({ [DAILY_KEY]: { days: days.slice(0, DAILY_MAX_DAYS) } }); } catch (e) { /* egal */ }
  }

  /** Zusammenfassung für die Anzeige: heute + Schnitt der VORTAGE (heute nicht mitrechnen,
   *  sonst vergleicht sich der Tag mit sich selbst). */
  async function dailyZusammenfassung() {
    const days = await dailyLesen();
    const tag = tagesSchluessel();
    const heute = days.find((d) => d.d === tag) || { d: tag, s: 0, m: 0, l: 0 };
    const vortage = days.filter((d) => d.d !== tag && d.l > 0);
    const summe = vortage.reduce((a, d) => ({ s: a.s + d.s, l: a.l + d.l, lok: a.lok + (d.lok || 0) }), { s: 0, l: 0, lok: 0 });
    return {
      heute: { sekunden: heute.s, zuege: heute.m, linien: heute.l,
               zuegeOk: heute.mok || 0, linienOk: heute.lok || 0 },
      schnitt: {
        tage: vortage.length,
        sekProLinie: summe.l ? Math.round(summe.s / summe.l) : null,
        linienQuote: summe.l ? Math.round((summe.lok / summe.l) * 100) : null,
      },
    };
  }

  async function flush(force) {
    if (!force && activeMs < MIN_FLUSH_MS) return;
    const secs = Math.min(MAX_FLUSH_S, Math.round(activeMs / 1000));
    if (secs <= 0) return;

    const cfg = await readConfig();
    lastFlush = now();
    if (!cfg || !cfg.url || !cfg.token) {
      // Nicht mit RookHub verbunden → akkumulierte Zeit verwerfen (kein unbegrenztes Wachsen).
      // Die lokale Tagesstatistik bekommt sie trotzdem: sie hängt nicht an RookHub.
      dailyBuchen(secs, movesTrained, linesTrained, movesCorrect, linesCorrect);
      activeMs = 0; movesTrained = 0; linesTrained = 0; movesCorrect = 0; linesCorrect = 0;
      return;
    }

    const moves = movesTrained;
    const lines = linesTrained;
    const movesOk = movesCorrect;
    const linesOk = linesCorrect;
    activeMs = 0; movesTrained = 0; linesTrained = 0; movesCorrect = 0; linesCorrect = 0; // optimistisch zuruecksetzen
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    try {
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: baseUrl + '/api/extension/training-activity',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + cfg.token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ secondsActive: secs, movesTrained: moves, linesTrained: lines, courseKind, courseId: currentCourseId(), courseName: bestCourseName(currentCourseId()) }),
        expect: 'json',
      }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          // Fehlgeschlagen → Zeit/Zuege/Linien zurueckbuchen, damit nichts verloren geht.
          // NICHT in die Tagesstatistik: der naechste Versuch schickt dieselben Werte erneut.
          activeMs += secs * 1000;
          movesTrained += moves;
          linesTrained += lines;
          movesCorrect += movesOk;
          linesCorrect += linesOk;
        } else {
          dailyBuchen(secs, moves, lines, movesOk, linesOk);
        }
      });
    } catch (e) {
      activeMs += secs * 1000;
      movesTrained += moves;
      linesTrained += lines;
      movesCorrect += movesOk;
      linesCorrect += linesOk;
    }
  }

  // ---- Takt ----
  ensureCourseNames(false); // Kursname-Karte vorwärmen (persistierter Cache + ggf. Refresh)
  lookupCourseKind();
  setInterval(() => {
    lookupCourseKind(); // neu bei SPA-Navigation in anderen Kurs
    watchMoveNotif();
    watchBoard();
    if (document.visibilityState === 'visible' && document.hasFocus()
        && boardPresent() && (now() - lastActivity) <= IDLE_MS) {
      activeMs += TICK_MS;
    }
    if (now() - lastFlush >= FLUSH_MS) flush(false);
  }, TICK_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.addEventListener('pagehide', () => { flush(true); flushProblemMoves(); flushReviewLines(); flushSessionMoves(); });

  // ---- „Remember line"-Bridge (MAIN-World chessable-fen.js → hier → RookHub) ----
  // chessable-fen.js (Page-Kontext) postet die FEN; hier (isoliert) haengen
  // RookHub-Config + Background-Egress, damit der Token nie in den Page-Kontext geraet.
  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__repcheck !== 'remember-line') return;
    const { fen, courseId, sourceUrl } = e.data;
    const reply = (ok, error) =>
      window.postMessage({ __repcheck: 'remember-line-result', ok: !!ok, error: error || null }, location.origin);

    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) { reply(false, 'Not connected'); return; }

    // Autoritativen Kursnamen über den Chessable-Bearer bestimmen; ist er für diesen Kurs
    // noch nicht bekannt, einmal frisch holen (User-Aktion → kurze Wartezeit ok).
    let courseName = apiCourseName(courseId);
    if (!courseName && courseId) { await ensureCourseNames(true); courseName = apiCourseName(courseId); }
    if (!courseName) courseName = bridgedCourseName || currentCourseName();

    const baseUrl = String(cfg.url).replace(/\/$/, '');
    try {
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: baseUrl + '/api/extension/remember-line',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + cfg.token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ fen, courseId, courseName, sourceUrl }),
        expect: 'json',
      }, (resp) => {
        reply(!chrome.runtime.lastError && resp && resp.ok);
      });
    } catch (err) {
      reply(false, 'Send failed');
    }
  });

  // ---- RookHub-URL-Bridge (hier isoliert → MAIN-World chessable-fen.js) ----
  // Die RookHub-URL liegt in chrome.storage.local (nur isoliert lesbar). chessable-fen.js
  // (Page-Kontext) braucht sie, um den „Analyse"-Button synchron im Klick-Handler in einen
  // neuen Tab öffnen zu können (Popup-Blocker-sicher). Nur die URL wird gespiegelt — der
  // Token bleibt in der isolierten Welt.
  async function broadcastRookhubUrl() {
    const cfg = await readConfig();
    const url = cfg && cfg.url ? String(cfg.url).replace(/\/$/, '') : null;
    if (url) window.postMessage({ __repcheck: 'rookhub-url', url }, location.origin);
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__repcheck !== 'request-rookhub-url') return;
    broadcastRookhubUrl();
  });
  broadcastRookhubUrl();   // proaktiv, falls fen.js seine Anfrage vor unserem Listener stellte

  // ---- Chessable-Buttons-Einstellung-Bridge (isoliert → MAIN chessable-fen.js) ----
  // Welche FEN-Tool-Buttons erscheinen, ist im Popup pro Button umschaltbar (chrome.storage.local
  // `chessableButtons`). Nur die isolierte Welt liest chrome.storage → wir spiegeln die Einstellung
  // an chessable-fen.js (MAIN) und aktualisieren sie live, wenn das Popup sie ändert. Bewusst OHNE Vorgaben:
  // seit v1.59.0 ist alles aus, was dort nicht ausdrücklich eingeschaltet ist (fen.js zeigt nur `true`).
  function broadcastChessableButtons() {
    try {
      chrome.storage.local.get('chessableButtons', (r) => {
        const s = Object.assign({}, (r && r.chessableButtons) || {});
        window.postMessage({ __repcheck: 'chessable-buttons', settings: s }, location.origin);
      });
    } catch (e) {}
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data) return;
    // Tagesstatistik für die Hochrechnung hinter dem ⏳-Zähler (MAIN-World hat kein chrome.*).
    if (e.data.__repcheck === 'request-daily') {
      dailyZusammenfassung().then((d) => {
        window.postMessage({ __repcheck: 'daily', daily: d }, location.origin);
      });
      return;
    }
    if (e.data.__repcheck !== 'request-chessable-buttons') return;
    broadcastChessableButtons();
  });
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.chessableButtons) broadcastChessableButtons();
    });
  } catch (e) {}
  broadcastChessableButtons();   // proaktiv

  // ======================================================================================
  // Browser-Kurs-Import: V1 (passiver Mitschnitt der Kurs-API) + V2 (aktives Holen). Der Browser
  // holt die Chessable-Daten als echte eingeloggte Session (passiert Cloudflare) und schickt das rohe
  // JSON an RookHub (POST /api/extension/chessable/ingest); der fetch-freie piratechess-Parser macht
  // daraus PGN. Kein serverseitiger Chessable-Abruf/VPN nötig. Additiv — der Server-Import bleibt.
  // ======================================================================================
  const Crawl = self.RepCheckCrawl || null;

  // Pause zwischen zwei Chessable-Abrufen beim aktiven Kurs-Holen: zufällig in [minMs, maxMs]. Standard
  // 2,5–3,5 s ist zugleich die Untergrenze; das Popup (`crawlDelay` in chrome.storage.local) verschiebt den
  // Bereich nur nach oben. Live nachgeführt, damit eine Änderung auch einen laufenden Crawl sofort bremst.
  let crawlDelay = Crawl ? Crawl.normalizeCrawlDelay(null) : { minMs: 2500, maxMs: 3500 };
  try {
    chrome.storage.local.get('crawlDelay', (r) => {
      if (Crawl) crawlDelay = Crawl.normalizeCrawlDelay(r && r.crawlDelay);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.crawlDelay && Crawl) crawlDelay = Crawl.normalizeCrawlDelay(changes.crawlDelay.newValue);
    });
  } catch (e) { /* Speicher nicht erreichbar — Standardbereich gilt */ }
  function crawlPauseMs() {
    return Crawl ? Crawl.pickCrawlDelayMs(crawlDelay) : 2500 + Math.floor(Math.random() * 1001);
  }

  // Per-bid-Mitschnitt-Puffer (Session, in-memory). getGame trägt nur die oid → oid→lid via getList.
  const cap = { bid: null, courseText: null, lists: {}, oidToLid: {}, games: {}, bytes: 0 };
  const CAP_MAX_BYTES = 40 * 1024 * 1024;   // Speicher-Deckel (großer Kurs)
  // Live-Anhängen ist immer aktiv (kein Schalter mehr): beim Durchklicken erfasste Linien werden
  // laufend an RookHub angehängt. Es gibt keinen Grund, das abzuschalten — der frühere Opt-in-
  // Toggle (rookhubChessableAutoImport) ist entfernt.
  const autoImport = true;
  let autoImportTimer = null;

  function resetCap(bid) { cap.bid = bid; cap.courseText = null; cap.lists = {}; cap.oidToLid = {}; cap.games = {}; cap.bytes = 0; }

  // ===== „Schwierige Züge" ernten =====================================================
  // Die ohnehin mitgeschnittenen Antworten tragen User-Trainingszustand: getList je Linie
  // `nHard`, getGame `game.problemMoves.thisUser` (Fehlzüge je Ply) + `lastReviewed`. Beides
  // wird gebündelt an RookHub gemeldet (POST /api/extension/chessable/problem-moves) und dort
  // je (User, bid, oid) upsertet. Batch + Session-Dedupe halten den Traffic klein; best-effort.
  const problemPending = new Map();   // `${bid}|${oid}` → { bid, entry }
  const problemSent = new Map();      // gleicher Key → zuletzt gesendete Payload (JSON-String)
  let problemFlushTimer = null;

  function queueProblemEntry(bid, entry) {
    if (!bid || !entry || !entry.oid) return;
    const key = bid + '|' + entry.oid;
    const prev = problemPending.get(key);
    const merged = prev ? Object.assign({}, prev.entry, entry) : entry;
    const payload = JSON.stringify(merged);
    if (problemSent.get(key) === payload) return;   // unverändert → nichts senden
    problemPending.set(key, { bid, entry: merged });
    if (!problemFlushTimer) problemFlushTimer = setTimeout(flushProblemMoves, 15000);
  }

  async function flushProblemMoves() {
    problemFlushTimer = null;
    if (!problemPending.size) return;
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) { problemPending.clear(); return; }
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    // je bid ein Batch (max 400 Einträge — Rest im nächsten Flush)
    const byBid = new Map();
    for (const [key, v] of problemPending) {
      if (!byBid.has(v.bid)) byBid.set(v.bid, []);
      const bucket = byBid.get(v.bid);
      if (bucket.length < 400) { bucket.push([key, v.entry]); problemPending.delete(key); }
    }
    for (const [bid, items] of byBid) {
      const body = JSON.stringify({ bid, entries: items.map(([, e]) => e) });
      try {
        chrome.runtime.sendMessage({
          type: 'rookhub-fetch',
          url: baseUrl + '/api/extension/chessable/problem-moves',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + cfg.token,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body,
          expect: 'json',
        }, (resp) => {
          if (!chrome.runtime.lastError && resp && resp.ok) {
            for (const [key, e] of items) problemSent.set(key, JSON.stringify(e));
          }
          // Fehlschlag: bewusst NICHT re-queuen — die nächste Capture bringt denselben Stand.
        });
      } catch (e) { /* still */ }
    }
    if (problemPending.size && !problemFlushTimer) problemFlushTimer = setTimeout(flushProblemMoves, 15000);
  }

  function harvestFromList(bid, body) {
    let o; try { o = JSON.parse(body); } catch (e) { return; }
    const data = o && (o.list || o.List) && ((o.list || o.List).data || (o.list || o.List).Data);
    if (!Array.isArray(data)) return;
    for (const item of data) {
      const oid = item && item.id != null ? String(item.id) : null;
      if (!oid || typeof item.nHard !== 'number') continue;
      queueProblemEntry(bid, { oid, nHard: item.nHard });
    }
  }

  function harvestFromGame(bid, oid, body) {
    let o; try { o = JSON.parse(body); } catch (e) { return; }
    const g = o && (o.game || o.Game);
    if (!g || !oid) return;
    let tu = g.problemMoves && g.problemMoves.thisUser;
    // Chessable liefert bei „keine Fehlzüge" leere ARRAYS statt Objekte → als {} normalisieren
    // (löscht serverseitig alte Fehlzüge; die Linie läuft jetzt sauber).
    if (!tu || Array.isArray(tu)) tu = {};
    const entry = { oid: String(oid), problemMoves: tu };
    if (typeof g.lastReviewed === 'string') entry.lastReviewed = g.lastReviewed.slice(0, 40);
    queueProblemEntry(bid, entry);
  }

  // ===== Sitzungszüge (saveProgress) ernten ===========================================
  // Chessables eigener Session-Report (POST /api/v1/saveProgressAndReturnNewProgressInfo)
  // trägt je Halbzug das SITZUNGS-Ergebnis: falsch gespielte Züge (wrong[]), Overstudy-/
  // Alternative-Flags, Level, Punkte. Mitgeschnitten wird der REQUEST-Body (die Antwort
  // enthält Konto-Daten und bleibt tabu), je Linie (bid|oid) gruppiert und roh an RookHub
  // gemeldet (POST /api/extension/chessable/session-moves, append-only Roh-Log — Auswertung
  // offen). NUR mit RookHub-Token (wie problem-moves); der Anon-Pfad bekommt KEINE Sitzungsdaten.
  const sessionPending = [];        // { bid, entry: { oid, moves: [...] } }
  const SESSION_PENDING_MAX = 200;  // Deckel, falls kein Token da ist/Flushes scheitern
  let sessionFlushTimer = null;

  function harvestFromSaveProgress(body) {
    let o; try { o = JSON.parse(body); } catch (e) { return; }
    // `data` ist ein JSON-STRING im Request-JSON: {"uid":…,"data":"{\"moves\":[…]}"}
    let data = o && o.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { return; } }
    const moves = data && data.moves;
    if (!Array.isArray(moves)) return;
    const byKey = new Map();   // `${bid}|${oid}` → { bid, entry }
    for (const m of moves) {
      if (!m || m.bid == null || m.oid == null) continue;
      const bid = String(m.bid);
      const oid = String(m.oid);
      const key = bid + '|' + oid;
      if (!byKey.has(key)) byKey.set(key, { bid, entry: { oid, moves: [] } });
      byKey.get(key).entry.moves.push(m);
    }
    for (const v of byKey.values()) {
      if (sessionPending.length >= SESSION_PENDING_MAX) break;
      sessionPending.push(v);
    }
    if (sessionPending.length && !sessionFlushTimer) sessionFlushTimer = setTimeout(flushSessionMoves, 15000);
  }

  async function flushSessionMoves() {
    sessionFlushTimer = null;
    if (!sessionPending.length) return;
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) { sessionPending.length = 0; return; }
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    const byBid = new Map();
    for (const v of sessionPending.splice(0)) {
      if (!byBid.has(v.bid)) byBid.set(v.bid, []);
      byBid.get(v.bid).push(v.entry);
    }
    for (const [bid, entries] of byBid) {
      try {
        chrome.runtime.sendMessage({
          type: 'rookhub-fetch',
          url: baseUrl + '/api/extension/chessable/session-moves',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + cfg.token,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({ bid, entries }),
          expect: 'json',
        }, () => { void chrome.runtime.lastError; });
        // Fehlschlag: bewusst NICHT re-queuen — der nächste Durchlauf bringt frische Daten.
      } catch (e) { /* still */ }
    }
  }

  // ===== getReview-Linien ernten =====================================================
  // getReview ist der TRAININGS-Endpoint: ein Call je trainierter Linie mit voller Zugfolge +
  // Alternativen + Kommentaren + Pfeilen. Das ROHE JSON wird PARALLEL zu getGame an RookHub
  // geschickt (POST /api/extension/chessable/review-lines) und dort als Lücken-Füller abgelegt:
  // baut RookHub den Kurs auf, gewinnt ein vorhandener getGame-Eintrag, sonst füllt getReview die
  // Lücke → der Kurs vervollständigt sich nach und nach beim Durchtrainieren. Session-Dedupe +
  // Batch halten den Traffic klein; best-effort (kein Re-Queue bei Fehler — der nächste Review kommt).
  //
  // TOKEN-LOS (kein RookHub-Token hinterlegt): die Linien gehen an den ANONYMEN Endpoint
  // (/review-lines/anon), identifiziert über die Chessable-uid (aus dem Chessable-JWT decodiert).
  // Ziel ist die konfigurierte RookHub-URL, sonst der Default (rookhub.oberschmid.homes). Der ERSTE
  // token-lose Versand ist EINMALIG zustimmungspflichtig (Consent-Banner); bis dahin wird nur gepuffert.
  const DEFAULT_ROOKHUB_URL = 'https://rookhub.oberschmid.homes';
  const reviewPending = new Map();   // `${bid}|${oid}` → { bid, oid, json }
  const reviewSent = new Set();      // gleicher Key → in DIESER Session bereits erfolgreich gesendet
  let reviewFlushTimer = null;
  const REVIEW_JSON_MAX = 512 * 1024;   // je Linie (server-seitiger Cap ist 256 KB; hier großzügiger vorfiltern)
  const REVIEW_PENDING_MAX = 500;       // Puffer-Deckel: bei ausstehender Zustimmung nicht unbegrenzt anhäufen

  // Zustimmung zum token-losen Versand: 'granted' | 'denied' | null (ungefragt). Extension-privat.
  function getReviewConsent() {
    return new Promise((resolve) => {
      try { chrome.storage.local.get('rcReviewConsent', (r) => resolve((r && r.rcReviewConsent) || null)); }
      catch (e) { resolve(null); }
    });
  }
  function setReviewConsent(v) { try { chrome.storage.local.set({ rcReviewConsent: v }); } catch (e) {} }

  // ---- Gemeinsamer Platz für RepChecks Karten auf chessable.com ----
  // Mehrere Hinweise können gleichzeitig anstehen (Verbinden, Zustimmung, Update). Jeder mit eigenem
  // `position: fixed` an derselben Ecke lag über dem anderen — deshalb stapelt EIN Halter sie.
  const BANNER_HOST_ID = 'repcheck-banners';
  function bannerHost() {
    let host = document.getElementById(BANNER_HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = BANNER_HOST_ID;
      Object.assign(host.style, {
        position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483647', maxWidth: '360px',
        display: 'flex', flexDirection: 'column', gap: '10px',
      });
      document.body.appendChild(host);
    }
    return host;
  }
  function bannerCard(id) {
    const bar = document.createElement('div');
    bar.id = id;
    Object.assign(bar.style, {
      background: '#1e1e24', color: '#fff', padding: '14px 16px', borderRadius: '10px',
      boxShadow: '0 4px 24px rgba(0,0,0,.4)', font: '13px/1.45 system-ui, sans-serif',
    });
    return bar;
  }

  // ---- Ohne RookHub-Verbindung: bei jedem Seitenaufruf darauf hinweisen (v1.59.0) ----
  // Ohne Token kann RepCheck auf Chessable fast nichts: kein Kurs holen, keine ✓/○, keine Trainingszeit. Die Karte
  // kommt deshalb bei JEDEM Laden einer chessable.com-Seite, bis verbunden ist; „Später" blendet sie nur für diese
  // Seite aus. Verbunden wird auf der Willkommensseite (Schritt 1): dort gibt es Adresse, Rückmeldung und den
  // Anmelde-Wartezustand, was eine Karte im fremden Seiten-DOM nicht sauber leisten kann.
  const CONNECT_PROMPT_ID = 'repcheck-connect-prompt';
  let connectPromptDismissed = false;
  function isConnected(cfg) { return !!(cfg && cfg.url && cfg.token); }
  async function maybeShowConnectPrompt() {
    if (connectPromptDismissed || !document.body || document.getElementById(CONNECT_PROMPT_ID)) return;
    if (isConnected(await readConfig())) return;
    if (connectPromptDismissed || document.getElementById(CONNECT_PROMPT_ID)) return;
    const bar = bannerCard(CONNECT_PROMPT_ID);
    bar.style.borderLeft = '4px solid #2a8c4a';
    const title = document.createElement('div');
    title.textContent = t('connect.prompt.title');
    Object.assign(title.style, { fontWeight: '600', marginBottom: '4px' });
    const msg = document.createElement('div');
    msg.textContent = t('connect.prompt.body');
    msg.style.marginBottom = '10px';
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
    const later = document.createElement('button');
    later.type = 'button'; later.textContent = t('connect.prompt.later'); styleConsentBtn(later, 'transparent', '#bbb', true);
    const go = document.createElement('button');
    go.type = 'button'; go.textContent = t('connect.prompt.connect'); styleConsentBtn(go, '#2a8c4a', '#fff', false);
    later.addEventListener('click', () => { connectPromptDismissed = true; bar.remove(); });
    go.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'rc-open-welcome', section: 'connect' }, () => void chrome.runtime.lastError); } catch (e) {}
      connectPromptDismissed = true;
      bar.remove();
    });
    row.appendChild(later); row.appendChild(go);
    bar.appendChild(title); bar.appendChild(msg); bar.appendChild(row);
    bannerHost().prepend(bar);   // ganz oben im Stapel: ohne Verbindung ist das der wichtigste Hinweis
  }
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.rookhubConfig && isConnected(ch.rookhubConfig.newValue)) {
        document.getElementById(CONNECT_PROMPT_ID)?.remove();
      }
    });
  } catch (e) {}
  maybeShowConnectPrompt();

  let consentPromptShown = false;   // je Session nur einmal einblenden
  function styleConsentBtn(btn, bg, fg, bordered) {
    Object.assign(btn.style, {
      background: bg, color: fg, border: bordered ? '1px solid #555' : 'none',
      borderRadius: '6px', padding: '6px 12px', cursor: 'pointer', font: 'inherit',
    });
  }
  function showReviewConsentPrompt(targetUrl) {
    if (consentPromptShown) return;
    if (typeof document === 'undefined' || !document.body) return;
    consentPromptShown = true;
    let host; try { host = new URL(targetUrl).host; } catch (e) { host = String(targetUrl); }
    const bar = bannerCard('repcheck-review-consent');
    const msg = document.createElement('div');
    msg.textContent = t('review.consent.body', { host });
    msg.style.marginBottom = '10px';
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
    const no = document.createElement('button');
    no.type = 'button'; no.textContent = t('review.consent.deny'); styleConsentBtn(no, 'transparent', '#bbb', true);
    const yes = document.createElement('button');
    yes.type = 'button'; yes.textContent = t('review.consent.allow'); styleConsentBtn(yes, '#3d7bfd', '#fff', false);
    no.addEventListener('click', () => { setReviewConsent('denied'); reviewPending.clear(); bar.remove(); });
    yes.addEventListener('click', () => { setReviewConsent('granted'); bar.remove(); flushReviewLines(); });
    row.appendChild(no); row.appendChild(yes);
    bar.appendChild(msg); bar.appendChild(row);
    bannerHost().appendChild(bar);
  }

  // ---- Hinweis nach dem Update auf v1.59.0: die Buttons unten rechts sind jetzt aus ----
  // Wer RepCheck vorher benutzt hat, sieht im Practice-Modus die Leiste plötzlich nicht mehr. Genau dort einmal
  // erklären und zum Einschalten führen. background.js setzt `rcButtonsNotice: 'pending'` beim Update; „OK",
  // „Buttons auswählen" oder eine gespeicherte Auswahl (Popup/Willkommensseite) setzen 'done'.
  const BUTTONS_NOTICE_ID = 'repcheck-buttons-notice';
  let buttonsNoticeState = 'unknown';   // 'unknown' → 'shown' | 'settled'
  function settleButtonsNotice() {
    try { chrome.storage.local.set({ rcButtonsNotice: 'done' }); } catch (e) {}
    document.getElementById(BUTTONS_NOTICE_ID)?.remove();
    buttonsNoticeState = 'settled';
  }
  function maybeShowButtonsNotice() {
    if (buttonsNoticeState !== 'unknown' || !/^\/practice(\/|$)/.test(location.pathname)) return;
    try {
      chrome.storage.local.get(['rcButtonsNotice', 'rookhubConfig'], (r) => {
        if (buttonsNoticeState !== 'unknown') return;
        if (!r || r.rcButtonsNotice !== 'pending') { buttonsNoticeState = 'settled'; return; }
        // Ohne Verbindung hat die Verbinden-Karte Vorrang; der Takt unten fragt weiter, der Hinweis kommt danach.
        if (!isConnected(r.rookhubConfig)) return;
        if (!document.body || document.getElementById(BUTTONS_NOTICE_ID)) return;
        buttonsNoticeState = 'shown';
        const bar = bannerCard(BUTTONS_NOTICE_ID);
        const msg = document.createElement('div');
        msg.textContent = t('notice.buttons.body');
        msg.style.marginBottom = '10px';
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
        const ok = document.createElement('button');
        ok.type = 'button'; ok.textContent = t('notice.buttons.ok'); styleConsentBtn(ok, 'transparent', '#bbb', true);
        const choose = document.createElement('button');
        choose.type = 'button'; choose.textContent = t('notice.buttons.choose'); styleConsentBtn(choose, '#2a8c4a', '#fff', false);
        ok.addEventListener('click', settleButtonsNotice);
        choose.addEventListener('click', () => {
          try { chrome.runtime.sendMessage({ type: 'rc-open-welcome', section: 'buttons' }, () => void chrome.runtime.lastError); } catch (e) {}
          settleButtonsNotice();
        });
        row.appendChild(ok); row.appendChild(choose);
        bar.appendChild(msg); bar.appendChild(row);
        bannerHost().appendChild(bar);
      });
    } catch (e) {}
  }
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.rcButtonsNotice && ch.rcButtonsNotice.newValue === 'done') {
        document.getElementById(BUTTONS_NOTICE_ID)?.remove();
        buttonsNoticeState = 'settled';
      }
    });
  } catch (e) {}
  // Chessable ist eine SPA: der Practice-Modus kann auch später per Navigation kommen.
  maybeShowButtonsNotice();
  const buttonsNoticeTimer = setInterval(() => {
    if (buttonsNoticeState !== 'unknown') { clearInterval(buttonsNoticeTimer); return; }
    maybeShowButtonsNotice();
  }, 3000);

  // Für die „Erste Schritte"-Checkliste im Popup: ein erfolgreicher Import hakt „Kurs geholt" ab.
  function markCourseFetched() {
    try { chrome.storage.local.set({ rcCourseFetched: true }); } catch (e) {}
  }

  function queueReviewLine(bid, oid, json) {
    if (!bid || !oid || typeof json !== 'string') return;
    if (!json.trim() || json.trim() === '{}') return;
    if (json.length > REVIEW_JSON_MAX) return;
    const key = bid + '|' + oid;
    if (reviewSent.has(key)) return;   // schon gesendet → nichts tun
    if (!reviewPending.has(key) && reviewPending.size >= REVIEW_PENDING_MAX) return;   // Deckel (Consent ausstehend)
    reviewPending.set(key, { bid: String(bid), oid: String(oid), json });
    if (!reviewFlushTimer) reviewFlushTimer = setTimeout(flushReviewLines, 15000);
  }

  async function flushReviewLines() {
    reviewFlushTimer = null;
    if (!reviewPending.size) return;
    const cfg = await readConfig();
    const token = cfg && cfg.token;
    const configuredUrl = cfg && cfg.url;
    const authed = !!(token && configuredUrl);

    let uid = null;
    if (!authed) {
      // Token-los: uid Pflicht (Identität) + einmalige Zustimmung, sonst puffern/verwerfen.
      uid = decodeUid(await readChessableToken());
      if (!uid) { reviewPending.clear(); return; }   // ohne uid nicht identifizierbar
      const consent = await getReviewConsent();
      const targetUrl = configuredUrl || DEFAULT_ROOKHUB_URL;
      if (consent === 'denied') { reviewPending.clear(); return; }
      if (consent !== 'granted') { showReviewConsentPrompt(targetUrl); return; }   // puffern, auf Zustimmung warten
    }

    const baseUrl = String(authed ? configuredUrl : (configuredUrl || DEFAULT_ROOKHUB_URL)).replace(/\/$/, '');
    const endpoint = authed ? '/api/extension/chessable/review-lines' : '/api/extension/chessable/review-lines/anon';

    // je bid ein Batch (max 50 Linien — Rest im nächsten Flush; getReview-JSON ist groß)
    const byBid = new Map();
    for (const [key, v] of reviewPending) {
      if (!byBid.has(v.bid)) byBid.set(v.bid, []);
      const bucket = byBid.get(v.bid);
      if (bucket.length < 50) { bucket.push([key, v]); reviewPending.delete(key); }
    }
    for (const [bid, items] of byBid) {
      const entries = items.map(([, v]) => ({ oid: v.oid, json: v.json }));
      const body = JSON.stringify(authed ? { bid, entries } : { uid, bid, entries });
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
      if (authed) headers['Authorization'] = 'Bearer ' + token;
      try {
        chrome.runtime.sendMessage({
          type: 'rookhub-fetch',
          url: baseUrl + endpoint,
          method: 'POST',
          headers,
          body,
          expect: 'json',
        }, (resp) => {
          if (!chrome.runtime.lastError && resp && resp.ok) {
            for (const [key] of items) reviewSent.add(key);
          }
          // Fehlschlag: bewusst NICHT re-queuen — der nächste Review derselben Linie bringt es erneut.
        });
      } catch (e) { /* still */ }
    }
    if (reviewPending.size && !reviewFlushTimer) reviewFlushTimer = setTimeout(flushReviewLines, 15000);
  }

  // MAIN-World chessable-capture.js → hier: rohe Kurs-API-Antworten puffern (nur source+origin-geprüft).
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__repcheck !== 'chessable-capture') return;
    // Request-Mitschnitte (nur saveProgress): eigener Pfad, laufen NICHT durch classify/cap.*.
    if (e.data.req) {
      if (typeof e.data.body === 'string' && /\/api\/v1\/saveProgress/.test(String(e.data.url || ''))) {
        harvestFromSaveProgress(e.data.body);
      }
      return;
    }
    if (!Crawl) return;
    const info = Crawl.classifyChessableApi(e.data.url);
    const body = e.data.body;
    if (!info || typeof body !== 'string') return;
    // getReview läuft NEBEN dem Kurs-Mitschnitt-Puffer (eigene Egress-Bahn) — nicht gegen CAP_MAX_BYTES
    // zählen und nicht in cap.* puffern; nur an RookHub weiterreichen.
    if (info.kind === 'review') {
      queueReviewLine(info.bid || cap.bid || currentCourseId(), info.oid, body);
      // beim Training ist die zuletzt reviewte oid die gerade trainierte Linie (wie getGame)
      if (!crawling && info.oid != null) { lastGameOid = String(info.oid); lastGameOidAt = now(); }
      return;
    }
    if (cap.bytes + body.length > CAP_MAX_BYTES) return;
    if (info.kind === 'course') {
      const bid = info.bid || currentCourseId();
      if (bid && bid !== cap.bid) resetCap(bid);
      if (!cap.bid) cap.bid = bid || null;
      cap.courseText = body; cap.bytes += body.length;
    } else if (info.kind === 'list') {
      if (info.bid && info.bid !== cap.bid) resetCap(info.bid);
      if (!cap.bid && info.bid) cap.bid = info.bid;
      if (info.lid != null) {
        cap.lists[info.lid] = body; cap.bytes += body.length;
        for (const oid of Crawl.parseLineOids(body)) cap.oidToLid[oid] = info.lid;
      }
      harvestFromList(info.bid || cap.bid || currentCourseId(), body);
    } else if (info.kind === 'game') {
      if (info.oid != null && !cap.games[info.oid]) { cap.games[info.oid] = body; cap.bytes += body.length; }
      // Beim TRAINING lädt die SPA je Variante genau ein getGame → die zuletzt geladene oid ist
      // die gerade trainierte Linie. Während eines aktiven Kurs-Crawls (viele getGames in Serie)
      // ist das Signal wertlos → nicht überschreiben.
      if (!crawling && info.oid != null) { lastGameOid = String(info.oid); lastGameOidAt = now(); }
      harvestFromGame(cap.bid || currentCourseId(), info.oid, body);
    }
    if (autoImport) scheduleAutoImport();
  });

  // Kapitel-Payload aus dem Puffer (nur Mitgeschnittenes), in getCourse-Reihenfolge.
  function capturedChapters() {
    if (!Crawl) return [];
    const lids = cap.courseText ? Crawl.parseChapterLids(cap.courseText) : Object.keys(cap.lists);
    const chapters = lids.filter(lid => cap.lists[lid]).map(lid => ({ listText: cap.lists[lid], games: cap.games }));
    return Crawl.buildIngestChapters(chapters);
  }
  function capturedLineCount() { return capturedChapters().reduce((n, c) => n + c.lines.length, 0); }

  // ---- Ingest an RookHub (Egress über Background-Worker, CORS-frei; Token bleibt hier) ----
  async function ingest(bid, chapters, target, courseName) {
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) throw new Error(t('err.notConnected'));
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: baseUrl + '/api/extension/chessable/ingest',
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ bid, target, courseName, chapters }),
        expect: 'json',
      }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp || !resp.ok) return reject(new Error((resp && resp.body && resp.body.message) || t('err.http', { status: (resp && resp.status) || 0 })));
        resolve(resp.body);
      });
    });
  }

  // Chessable drosselt (HTTP 429) bei zu schnellem Holen. Nur retrybare Codes wiederholen; dabei
  // `Retry-After` honorieren (Sekunden ODER HTTP-Datum), sonst exponentielles Backoff mit Jitter.
  // 401/403/404 bleiben harte Fehler (kein Retry). Normaler Takt s. crawlPauseMs().
  const CHESSABLE_RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const CHESSABLE_MAX_ATTEMPTS = 5;
  function parseRetryAfterMs(header) {
    if (!header) return null;
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(header);
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
    return null;
  }

  // same-origin Chessable-Fetch (V2 aktiv) — gleiche Rezeptur wie fetchCourseNameMap (Bearer, credentials).
  async function chessableGet(path) {
    const token = await readChessableToken();
    if (!token) throw new Error(t('err.noChessableToken'));
    const uid = decodeUid(token);
    if (!uid) throw new Error(t('err.chessableTokenNoUid'));
    const sep = path.includes('?') ? '&' : '?';
    const url = `https://www.chessable.com/api/v1/${path}${sep}uid=${uid}`;
    const init = { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }, credentials: 'include' };
    let lastStatus = 0, lastBody = '';
    for (let attempt = 1; attempt <= CHESSABLE_MAX_ATTEMPTS; attempt++) {
      const resp = await fetch(url, init);
      if (resp.ok) return resp.text();
      if (resp.status === 401) clearStoredChessableToken(); // Bearer tot — Kopie nicht weiterleben lassen
      lastStatus = resp.status;
      if (!CHESSABLE_RETRYABLE.has(resp.status) || attempt === CHESSABLE_MAX_ATTEMPTS) {
        try { lastBody = await resp.text(); } catch (e) { lastBody = ''; }
        break;
      }
      const retryAfter = parseRetryAfterMs(resp.headers.get('Retry-After'));
      const backoff = (retryAfter != null ? retryAfter : Math.min(30000, CRAWL_BACKOFF_BASE_MS * Math.pow(2, attempt)))
        + Math.floor(Math.random() * 400);
      setStatus(t('import.throttled', {
        status: resp.status,
        seconds: Math.round(backoff / 1000),
        attempt,
        max: CHESSABLE_MAX_ATTEMPTS - 1,
      }));
      await sleep(backoff);
    }
    const err = new Error(t('err.chessableHttp', { status: lastStatus }));
    // Für „Kurs holen": Status + Antworttext, damit z. B. eine Sperrseite als unerwartete Antwort gemeldet werden kann.
    err.chessableStatus = lastStatus;
    err.chessableBody = lastBody;
    throw err;
  }

  // Ein Kapitel-Chunk an den kapitelweisen Ingest (bounded pro Request). RookHub ≥ 0.484.0 importiert jeden
  // Chunk SOFORT; final=true schließt den Import-Eintrag ab (Status, Benachrichtigung).
  // extra: beim finalen Chunk eines vollständig geholten Kurses { courseJson, complete }; bei einem Abbruch
  // { aborted: true } (schließt den Eintrag als abgebrochen, die schon importierten Kapitel bleiben).
  async function ingestChunk(sessionId, bid, target, courseName, chapter, final, extra) {
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) throw new Error(t('err.notConnected'));
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: baseUrl + '/api/extension/chessable/ingest/chunk',
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(Object.assign({ sessionId, bid, target, courseName, chapter, final }, extra || {})),
        expect: 'json',
      }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp || !resp.ok) return reject(new Error((resp && resp.body && resp.body.message) || t('err.http', { status: (resp && resp.status) || 0 })));
        resolve(resp.body);
      });
    });
  }

  const CRAWL_BACKOFF_BASE_MS = 3000;   // Basis des Backoffs bei Drosselung (6/12/24/30 s, s. chessableGet); der normale Takt kommt aus crawlPauseMs()
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const newSessionId = () => (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : (String(Date.now()) + '-' + Math.round(Math.random() * 1e9));
  let crawling = false;
  let crawlStartedAt = null;   // ms-Zeitstempel des laufenden Crawls (fürs Popup: mitlaufender Timer)
  let cancelRequested = false; // vom Popup gesetzt (Aktion 'cancel'); die Crawl-Schleifen brechen dann sauber ab

  // Welche Linien liegen schon im geteilten RookHub-Cache (piratechess)? Für diese fragt der Crawl kein getGame
  // bei Chessable ab; der Import schickt nur die oid, der Server setzt den Inhalt ein. Jede Störung (RookHub zu
  // alt → 404, piratechess nicht erreichbar) heißt schlicht: nichts (weiter) gecacht → selbst holen.
  const SHARED_CACHE_BATCH = 5000;
  async function fetchSharedCachedOids(oids) {
    const result = new Set();
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token || !oids.length) return result;
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    for (let i = 0; i < oids.length; i += SHARED_CACHE_BATCH) {
      const batch = oids.slice(i, i + SHARED_CACHE_BATCH);
      const resp = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({
            type: 'rookhub-fetch',
            url: baseUrl + '/api/extension/chessable/cached-lines',
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ oids: batch }),
            expect: 'json',
          }, (r) => resolve(chrome.runtime.lastError ? null : r));
        } catch (e) { resolve(null); }
      });
      if (!resp || !resp.ok || !resp.body || !Array.isArray(resp.body.oids)) break;
      resp.body.oids.forEach((o) => result.add(String(o)));
    }
    return result;
  }

  // ---- Unerwartete Chessable-Antwort: Holen stoppen, warnen, melden (v1.60.0) ----
  // Jede Antwort beim „Kurs holen" wird geprüft (Crawl.checkChessableResponse). Passt eine nicht, bricht der Lauf ab:
  // dahinter kann eine Anti-Crawling-Maßnahme von Chessable stecken, und blindes Weiterholen würde sie nur bestätigen.
  // Der Nutzer bekommt eine Karte mit Discord-Link (vor einem erneuten Versuch Bescheid geben), das Popup behält den
  // Hinweis (rcCrawlAlert) und fragt vor dem nächsten Holen nach, und RookHub bekommt die Antwort zum Durchsehen —
  // sieht sie nach einer Sperre aus, legt RookHub daraus eine Admin-Nachricht an.
  const DISCORD_URL = 'https://discord.gg/wczc4BJtMf';
  const CRAWL_ALERT_ID = 'repcheck-crawl-alert';

  // Wie chessableGet, aber eine Antwort ohne die erwartete Form wirft einen Fehler mit `unexpected`. 401 bleibt der
  // bekannte Fehler (Chessable-Anmeldung abgelaufen), ein Netzfehler ebenso.
  async function chessableGetChecked(path, kind, where) {
    let text, status;
    try {
      text = await chessableGet(path);
    } catch (e) {
      if (!e || !e.chessableStatus || e.chessableStatus === 401) throw e;
      text = e.chessableBody; status = e.chessableStatus;
    }
    const bad = Crawl.checkChessableResponse(kind, text, status);
    if (!bad) return text;
    if (bad.code === Crawl.BOOK_NOT_OWNED) {
      // Kein Alarm: Chessable sagt nur, dass der Kurs nicht im eingeloggten Konto liegt (v1.65.1).
      const err = new Error(t('import.notOwned.title'));
      err.notOwned = { courseName: bad.courseName };
      throw err;
    }
    const err = new Error(t('import.unexpected.title'));
    err.unexpected = Object.assign({ endpoint: path.split('?')[0] }, where || {}, bad);
    throw err;
  }

  function unexpectedDetail(u) {
    const wo = u.oid ? ` oid ${u.oid}` : u.lid ? ` lid ${u.lid}` : '';
    const was = u.message || (u.reason === 'json' ? 'no JSON' : u.reason === 'shape' ? 'unexpected format' : '');
    return u.endpoint + wo + (u.status !== 200 ? ` · HTTP ${u.status}` : '') + (was ? ` · ${was}` : '');
  }

  // Meldung an RookHub (best effort). Ergebnis: Antwort des Servers ({ banned, adminNotified }) oder null.
  async function reportUnexpected(bid, courseName, u) {
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) return null;
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    let version = null;
    try { version = chrome.runtime.getManifest().version; } catch (e) { /* ohne Version */ }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({
          type: 'rookhub-fetch',
          url: baseUrl + '/api/extension/chessable/unexpected-response',
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            bid, courseName: courseName ? String(courseName).slice(0, 300) : null,
            endpoint: u.endpoint, lid: u.lid || null, oid: u.oid || null, status: u.status,
            reason: u.reason, message: u.message, snippet: u.snippet, extensionVersion: version,
          }),
          expect: 'json',
        }, (r) => resolve(!chrome.runtime.lastError && r && r.ok && r.body ? r.body : null));
      } catch (e) { resolve(null); }
    });
  }

  function showCrawlAlert(h) {
    if (!document.body) return;
    document.getElementById(CRAWL_ALERT_ID)?.remove();
    const bar = bannerCard(CRAWL_ALERT_ID);
    bar.style.borderLeft = '4px solid #e0a800';
    const absatz = (text, style) => {
      const d = document.createElement('div');
      d.textContent = text;
      Object.assign(d.style, { marginBottom: '8px' }, style || {});
      bar.appendChild(d);
    };
    absatz(t('import.unexpected.title'), { fontWeight: '600', marginBottom: '4px' });
    absatz(t('import.unexpected.body'));
    if (h.banned) {
      absatz((h.message ? t('import.unexpected.bannedMessage', { message: h.message }) : t('import.unexpected.bannedPage'))
        + (h.adminNotified ? ' ' + t('import.unexpected.adminsNotified') : ''));
    }
    if (h.saved) absatz(t('import.unexpected.saved', { count: h.saved }));
    absatz(h.detail, { color: '#9aa4b2', fontSize: '11px', wordBreak: 'break-word' });
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center' });
    const hide = document.createElement('button');
    hide.type = 'button'; hide.textContent = t('import.unexpected.dismiss'); styleConsentBtn(hide, 'transparent', '#bbb', true);
    hide.addEventListener('click', () => bar.remove());
    const discord = document.createElement('a');
    discord.href = DISCORD_URL; discord.target = '_blank'; discord.rel = 'noopener';
    discord.textContent = t('import.unexpected.discord');
    styleConsentBtn(discord, '#5865f2', '#fff', false);
    discord.style.textDecoration = 'none';
    row.appendChild(hide); row.appendChild(discord);
    bar.appendChild(row);
    bannerHost().prepend(bar);   // ganz oben: wichtiger als jeder andere Hinweis
  }

  async function handleUnexpected(bid, u, saved) {
    const courseName = bestCourseName(bid);
    const hinweis = {
      at: Date.now(), bid, courseName: courseName || null, detail: unexpectedDetail(u),
      banned: !!u.banned, message: u.message || null, saved: saved || 0, adminNotified: false,
    };
    const merken = () => { try { chrome.storage.local.set({ rcCrawlAlert: hinweis }); } catch (e) { /* egal */ } };
    setStatus(t('import.unexpected.status', { detail: hinweis.detail }));
    showCrawlAlert(hinweis);
    merken();
    const res = await reportUnexpected(bid, courseName, u);
    if (!res) return;
    hinweis.banned = hinweis.banned || !!res.banned;
    hinweis.adminNotified = !!res.adminNotified;
    merken();
    if (document.getElementById(CRAWL_ALERT_ID)) showCrawlAlert(hinweis);   // schon weggeklickt → nicht wieder aufdrängen
  }

  // ---- Kurs nicht im Chessable-Konto (v1.65.1) ----
  // BOOK_NOT_OWNED ist eine klare Auskunft, keine Sperre: erklären, warum nichts geht, und was der Nutzer prüfen kann.
  // Kein rcCrawlAlert (das Popup soll vor dem nächsten Holen nicht nachfragen) und keine Meldung an RookHub.
  const NOT_OWNED_ID = 'repcheck-not-owned';

  function showNotOwned(bid, courseName) {
    const name = courseName || bestCourseName(bid) || ('#' + bid);
    const status = t('import.notOwned.status', { name });
    if (!document.body) return status;
    document.getElementById(NOT_OWNED_ID)?.remove();
    const bar = bannerCard(NOT_OWNED_ID);
    bar.style.borderLeft = '4px solid #5b8def';
    const absatz = (text, style) => {
      const d = document.createElement('div');
      d.textContent = text;
      Object.assign(d.style, { marginBottom: '8px' }, style || {});
      bar.appendChild(d);
    };
    absatz(t('import.notOwned.title'), { fontWeight: '600', marginBottom: '4px' });
    absatz(t('import.notOwned.body', { name }));
    absatz(t('import.notOwned.hint'));
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', justifyContent: 'flex-end' });
    const hide = document.createElement('button');
    hide.type = 'button'; hide.textContent = t('import.unexpected.dismiss'); styleConsentBtn(hide, 'transparent', '#bbb', true);
    hide.addEventListener('click', () => bar.remove());
    row.appendChild(hide);
    bar.appendChild(row);
    bannerHost().prepend(bar);
    return status;
  }

  // V2: Kurs aktiv holen (getCourse→getList→getGame).
  //
  // BEIDE Ziele holen INKREMENTELL (v1.63.0): Linien, deren oid schon auf RookHub liegt, werden nicht
  // erneut von Chessable geholt. Das spart Abrufe, Zeit und Ban-Risiko — bei einem halb importierten
  // Kurs ist das der Unterschied zwischen „1290 Linien noch einmal" und „nur die fehlenden 591".
  //
  // Das Buch war davon bis v1.62.0 ausgenommen, weil seine LineId an der Round-Nummer (Kapitel.Linie)
  // hängt und ein Skip die Nummerierung verschiebt. Seit RookHub 0.496.0 ist die Chessable-oid die
  // Identität einer Linie, die Nummer nur noch ein Etikett; 0.497.1 sucht bei einer Kollision den
  // nächsten freien Platz. Deshalb schickt jeder Chunk `partial`, sobald etwas übersprungen wurde —
  // daran erkennt der Server, dass eine Nummern-Kollision NICHTS über die Identität aussagt.
  // ⚠️ Braucht RookHub ≥ 0.497.1. Gegen einen älteren Server würde ein Teil-Import Linien verlieren.
  //
  // Was sich NICHT ändert: der Transportweg. Das Buch streamt weiter über die Chunk-Sitzung
  // (`ingest/chunk`) — daran hängen Import-Eintrag, Benachrichtigung und der Watchdog; das Repertoire
  // hängt über `ingest/live` an. Das ist ein Unterschied im Lebenszyklus, keine doppelte Logik.
  async function crawlAndImport(target) {
    if (crawling) return; crawling = true; crawlStartedAt = Date.now(); cancelRequested = false;
    const bid = currentCourseId();
    const sessionId = newSessionId();
    // Zwei getrennte Fragen, die früher EIN Schalter waren: was wird geholt, und wie wird es geschickt.
    const skipKnown = true;                    // beide Ziele überspringen, was schon auf RookHub liegt
    const viaSession = target === 'book';      // Buch: Chunk-Sitzung (Import-Eintrag); Repertoire: Live-Append
    const incremental = !viaSession;           // nur noch: „sammelt für den Live-Append"
    // Nur fürs inkrementelle Anhängen gesammelt. Außerhalb des try, damit ein Abbruch wegen einer unerwarteten
    // Chessable-Antwort die bis dahin geholten (geprüften) Linien noch speichern kann.
    const newChapters = [];
    // Buch-Ziel: nach dem ersten gesendeten Kapitel ist am Server ein Import-Eintrag offen (bookOpen); kommt kein
    // finaler Chunk (Stopp, Fehler, unerwartete Antwort), schließt ihn das finally mit `aborted`.
    let sent = 0, bookOpen = false, failMsg = null;
    try {
      if (!bid) throw new Error(t('err.noCourse'));
      if (!Crawl) throw new Error(t('err.libMissing'));

      // Schon importierte oids (nur fürs inkrementelle Repertoire-Anhängen). Fehlt der Endpoint (alte
      // RookHub-Version) → leere Menge → es wird alles geholt (via Append, weiterhin dedupt).
      const prog = await fetchImportedOids(bid);
      const already = new Set((prog && prog.oids) || []);
      // Teil-Import: es wird etwas ausgelassen, der Stapel ist also nicht der ganze Kurs. Daran liest
      // der Server ab, dass eine Kollision der Positionsnummer nichts über die Identität aussagt.
      const partial = skipKnown && already.size > 0;

      setStatus(t('import.fetchingStructure'));
      const courseText = (cap.courseText && cap.bid === bid) ? cap.courseText : await chessableGetChecked(`getCourse?bid=${bid}`, 'course');
      const lids = Crawl.parseChapterLids(courseText);
      if (!lids.length) throw new Error(t('err.noChapters'));
      const lists = [];
      let total = 0, toFetch = 0;
      for (let li = 0; li < lids.length; li++) {
        const lid = lids[li];
        if (cancelRequested) { setStatus(t('import.aborted')); return; }
        // Mitzählen: bei 36 Kapiteln mit Pause stand hier sonst zwei Minuten lang „Kursstruktur" (Kurs 207313).
        setStatus(t('import.fetchingChapters', { done: li + 1, total: lids.length }));
        const fromCapture = !!(cap.lists[lid] && cap.bid === bid);
        const listText = fromCapture ? cap.lists[lid] : await chessableGetChecked(`getList?bid=${bid}&lid=${lid}`, 'list', { lid: String(lid) });
        harvestFromList(bid, listText);   // nHard je Linie auch beim aktiven Kurs-Holen ernten
        const oids = Crawl.parseLineOids(listText);
        lists.push({ lid, listText, oids });
        total += oids.length;
        toFetch += skipKnown ? oids.filter(o => !already.has(String(o))).length : oids.length;
        if (!fromCapture) await sleep(crawlPauseMs());   // Pause nur nach einem echten Abruf, nicht für Mitgeschnittenes
      }
      const courseName = bestCourseName(bid);

      if (skipKnown && toFetch === 0) {
        setStatus(t('import.nothingNew', { count: total }));
        ensureProgress(true);
        return;
      }

      // Linien, die schon im geteilten RookHub-Cache liegen, setzt der Server beim Import selbst ein — dafür
      // weder getGame bei Chessable noch eine Pause. Mitgeschnittene (cap.games) brauchen die Abfrage nicht.
      const wanted = [];
      for (const { oids } of lists) {
        for (const oid of oids) {
          if (skipKnown && already.has(String(oid))) continue;
          if (cap.games[oid]) continue;
          wanted.push(String(oid));
        }
      }
      const shared = wanted.length ? await fetchSharedCachedOids(wanted) : new Set();

      let done = 0, skipped = 0, fromShared = 0;
      const fortschritt = () => (fromShared
        ? t('import.fetchingLinesShared', { done, total: toFetch, shared: fromShared })
        : t('import.fetchingLines', { done, total: toFetch }));
      for (const { lid, listText, oids } of lists) {
        // lineOids parallel zu lines: der Server ordnet die Linien über die oid zu und füllt eine Linie ohne
        // Inhalt (null) aus dem geteilten Cache.
        const lines = [], lineOids = [];
        for (const oid of oids) {
          if (cancelRequested) { setStatus(t('import.aborted')); return; }
          if (skipKnown && already.has(String(oid))) { skipped++; continue; }   // schon auf RookHub → nicht holen
          let g = cap.games[oid];
          if (!g && shared.has(String(oid))) {
            lines.push(null); lineOids.push(String(oid)); fromShared++;
            done++; setStatus(fortschritt());
            continue;
          }
          if (!g) {
            try {
              g = await chessableGetChecked(`getGame?lng=en&oid=${oid}`, 'game', { oid: String(oid) });
            } catch (e) {
              // Die bis hierher geholten Linien dieses Kapitels sind geprüft — nicht verwerfen (Abbruch-Zweig unten).
              if (e && e.unexpected && incremental && lines.length) newChapters.push({ chapterJson: listText, lines, lineOids });
              throw e;
            }
            await sleep(crawlPauseMs());
          }
          if (g && g.trim() && g.trim() !== '{}') { lines.push(g); lineOids.push(String(oid)); cap.games[oid] = g; harvestFromGame(bid, oid, g); }
          done++; setStatus(fortschritt());
        }
        if (!lines.length) continue;
        const chapter = { chapterJson: listText, lines, lineOids };
        if (incremental) newChapters.push(chapter);
        else {
          // Ein Kapitel kann für EINEN Request zu groß sein — Kapitel 30 eines Lifetime-Repertoires riss am
          // 2026-09-20 die 48 MB des Endpoints (der Server meldete das als HTTP 500). Darum dieselbe
          // Byte-Schranke wie beim Mitschnitt/Repertoire; die Teile tragen denselben chapterKey und bleiben
          // serverseitig EIN Kapitel (RookHub ≥ 0.495.0).
          const teile = Crawl.splitIngestChapters([chapter]).flat();
          for (let pi = 0; pi < teile.length; pi++) {
            if (teile.length > 1) setStatus(t('import.chapterPart', { part: pi + 1, parts: teile.length }));
            await ingestChunk(sessionId, bid, target, courseName, teile[pi], false, { chapterKey: String(lid), partial });
            bookOpen = true;
          }
        }
        sent++;
      }
      if (!sent) throw new Error(t('err.noLines'));

      if (incremental) {
        setStatus(t('import.appending'));
        const res = await ingestLiveInParts(bid, target, courseName, newChapters, (part, parts) => {
          if (parts > 1) setStatus(t('import.appendingPart', { part, parts }));
        });
        markCourseFetched();
        const fertig = skipped
          ? t('import.doneAppendedSkipped', { count: res.imported, skipped })
          : t('import.doneAppended', { count: res.imported });
        // Verknüpfte Alt-Linien nennen — sonst las sich ein Abruf mit hunderten nachgetragenen IDs als „0 angehängt".
        setStatus(res.linked ? fertig + ' ' + t('import.linkedNote', { count: res.linked }) : fertig);
      } else {
        setStatus(t('import.importing'));
        // Vollständig geholt → mit der echten getCourse-Antwort als komplett markieren; der Server legt den Kurs
        // dann als Ganzes im geteilten Cache ab (und prüft selbst Kapitelzahl und Lücken).
        // `complete` heißt: piratechess darf den Kurs als Ganzes cachen. Nach einem Teil-Import
        // stimmt das nicht — dieser Lauf hat die übersprungenen Linien gar nicht geholt.
        const res = await ingestChunk(sessionId, bid, target, courseName, null, true,
          { courseJson: courseText, complete: !partial, partial });
        bookOpen = false;
        markCourseFetched();
        setStatus(t(target === 'book' ? 'import.doneImportedPuzzles' : 'import.doneImportedLines', { count: res.imported }));
      }
      ensureProgress(true);
    } catch (err) {
      if (err && err.unexpected) {
        // Bis zum Abbruch geholte, geprüfte Linien noch anhängen — nur beim Repertoire; beim Buch sind die schon
        // gesendeten Kapitel bereits importiert, den Eintrag schließt das finally mit `aborted`.
        let saved = 0;
        if (incremental && newChapters.length) {
          try {
            await ingestLiveInParts(bid, target, bestCourseName(bid), newChapters);
            saved = newChapters.reduce((n, c) => n + c.lineOids.length, 0);
            markCourseFetched();
            ensureProgress(true);
          } catch (e) { /* die Warnung zählt mehr als die Teilsicherung */ }
        }
        await handleUnexpected(bid, err.unexpected, saved);
      } else if (err && err.notOwned) {
        failMsg = showNotOwned(bid, err.notOwned.courseName);
        setStatus(failMsg);
      } else {
        failMsg = t('import.error', { error: (err && err.message) || err });
        setStatus(failMsg);
      }
    } finally {
      if (bookOpen) {
        // Ohne Abschluss stünde der Import-Eintrag bis zum serverseitigen Aufräumen (30 min ohne Kapitel) auf
        // „läuft" — und die Rückmeldung sagte nicht, dass die bis hierhin geholten Kapitel im Kurs sind.
        try {
          const ack = await ingestChunk(sessionId, bid, target, null, null, true, { aborted: true });
          const note = t('import.abortedPartial', { chapters: (ack && ack.chapters) || 0, count: (ack && ack.imported) || 0 });
          if (cancelRequested) setStatus(note);
          else if (failMsg) setStatus(failMsg + ' ' + note);
          ensureProgress(true);
        } catch (e) { /* der Server schließt die Sitzung nach 30 min selbst */ }
      }
      crawling = false; crawlStartedAt = null;
    }
  }

  // V1: nur den passiven Mitschnitt importieren (kein aktives Holen).
  async function importCaptured(target) {
    const bid = cap.bid || currentCourseId();
    const chapters = capturedChapters();
    if (!bid || !chapters.length) { setStatus(t('import.nothingCaptured')); return; }
    try {
      setStatus(t('import.importingCapture'));
      // Erste Portion über /ingest (Import-Eintrag + Benachrichtigung, legt das Ziel bei Bedarf an), den Rest
      // anhängen — ein großer Mitschnitt in EINER Anfrage bekam am Proxy 413.
      const parts = Crawl.splitIngestChapters(chapters);
      const courseName = bestCourseName(bid);
      if (parts.length > 1) setStatus(t('import.importingCapturePart', { part: 1, parts: parts.length }));
      const res = await ingest(bid, parts[0], target, courseName);
      let imported = (res && res.imported) || 0;
      for (let i = 1; i < parts.length; i++) {
        setStatus(t('import.importingCapturePart', { part: i + 1, parts: parts.length }));
        const more = await ingestLive(bid, target, courseName, parts[i]);
        imported += (more && more.imported) || 0;
      }
      markCourseFetched();
      setStatus(t(target === 'book' ? 'import.doneImportedPuzzles' : 'import.doneImportedLines', { count: imported }));
      ensureProgress(true);
    } catch (err) { setStatus(t('import.error', { error: (err && err.message) || err })); }
  }

  // Live-Append (V1 „beim Durchklicken"): jede NEU erfasste Linie wird kurz gebündelt SOFORT ans
  // Repertoire angehängt (POST .../ingest/live), statt am Ende alles auf einmal zu senden. sentOids
  // verhindert Doppel-Sends in dieser Sitzung; der Server dedupliziert zusätzlich per Zugtext.
  const sentOids = new Set();
  let liveFlushing = false;

  function hasUnsentLine() {
    for (const oid of Object.keys(cap.games)) {
      if (sentOids.has(oid)) continue;
      const lid = cap.oidToLid[oid];
      if (lid && cap.lists[lid]) return true;
    }
    return false;
  }

  function scheduleAutoImport() {
    if (autoImportTimer) return;
    autoImportTimer = setTimeout(() => { autoImportTimer = null; flushLive(); }, 1500);
  }

  async function ingestLive(bid, target, courseName, chapters) {
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) throw new Error(t('err.notConnected'));
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: baseUrl + '/api/extension/chessable/ingest/live',
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ bid, target, courseName, chapters }),
        expect: 'json',
      }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp || !resp.ok) return reject(new Error((resp && resp.body && resp.body.message) || t('err.http', { status: (resp && resp.status) || 0 })));
        resolve(resp.body);
      });
    });
  }

  // Anhängen in Portionen (Crawl.splitIngestChapters): eine einzelne Anfrage je Import lief am Proxy in 413, siehe
  // lib/chessable-crawl.js. Liefert die Summe der neu angehängten Linien; scheitert eine Portion, bleiben die davor
  // angehängten stehen (ein erneuter Versuch überspringt sie serverseitig über die oid).
  async function ingestLiveInParts(bid, target, courseName, chapters, onPart) {
    const parts = Crawl.splitIngestChapters(chapters);
    let imported = 0, linked = 0;
    for (let i = 0; i < parts.length; i++) {
      if (onPart) onPart(i + 1, parts.length);
      const res = await ingestLive(bid, target, courseName, parts[i]);
      imported += (res && res.imported) || 0;
      linked += (res && res.linked) || 0;   // RookHub ≥ 0.478.7; ältere liefern das Feld nicht → 0
    }
    return { imported, linked, parts: parts.length };
  }

  async function flushLive() {
    if (liveFlushing || !Crawl) return;
    const bid = cap.bid || currentCourseId();
    if (!bid) return;
    // Neue Linien je Kapitel bündeln — nur solche, deren getList (Kapitel-Kontext) schon bekannt ist.
    const byLid = {}; const picked = [];
    for (const oid of Object.keys(cap.games)) {
      if (sentOids.has(oid)) continue;
      const lid = cap.oidToLid[oid];
      if (!lid || !cap.lists[lid]) continue;
      (byLid[lid] = byLid[lid] || []).push(oid);
      picked.push(oid);
    }
    if (!picked.length) return;
    const chapters = Object.keys(byLid).map(lid => ({ chapterJson: cap.lists[lid], lines: byLid[lid].map(o => cap.games[o]), lineOids: byLid[lid].map(String) }));
    liveFlushing = true;
    picked.forEach(o => sentOids.add(o));   // optimistisch; bei Fehler zurücknehmen
    try {
      const res = await ingestLiveInParts(bid, importTarget, bestCourseName(bid), chapters);
      markCourseFetched();
      setStatus(t('import.liveAppended', { count: res.imported, sent: sentOids.size }));
      ensureProgress(true);   // Overlay live nachziehen
    } catch (err) {
      picked.forEach(o => sentOids.delete(o));
      setStatus(t('import.liveError', { error: (err && err.message) || err }));
    } finally {
      liveFlushing = false;
      if (autoImport && hasUnsentLine()) scheduleAutoImport();   // während des Flushs kam Neues
    }
  }

  // ======================================================================================
  // Fortschritts-Overlay: zeigt auf chessable.com, wieviel des Kurses schon auf RookHub ist —
  // Kurs- + Kapitel-Zusammenfassung im Panel (robust) UND Best-Effort-Marker (✓/○) direkt an
  // Chessables eigenen Linien-Elementen (per oid im href/data-Attribut; fragil ggü. DOM-Änderungen).
  // Struktur via getCourse?includeVariations (1 Call, oids je Kapitel), importierte oids via RookHub.
  // ======================================================================================
  let progressBid = null, progressStruct = null, importedOids = new Set(), progressAt = 0;
  // Seiten, auf denen es EINEN aktuellen Kurs gibt (Übersicht, Kapitel, Practice, Learn).
  const COURSE_PAGE_RE = /^\/(?:course|practice|learn)\/\d+/;
  const PROGRESS_TTL = 60000;
  let progressFetching = false;

  async function fetchImportedOids(bid) {
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) return null;
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: baseUrl + '/api/extension/chessable/progress?bid=' + encodeURIComponent(bid),
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/json' },
        expect: 'json',
      }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok || !resp.body) return resolve(null);
        resolve(resp.body);   // { book, repertoire, oids: [] }
      });
    });
  }

  async function ensureProgress(force) {
    if (!Crawl) return;
    // Nur auf Kursseiten: auf der Startseite fiel currentCourseId() auf den ERSTEN Kurs-Link zurück und löste
    // ein getCourse für einen beliebigen Kurs aus (im Netzwerk-Mitschnitt vom 13.09. belegt). Die Startseite
    // hat ihre eigenen Zähler (annotateHome).
    if (!COURSE_PAGE_RE.test(location.pathname)) return;
    const bid = currentCourseId();
    if (!bid) return;
    // Ohne RookHub-Config gibt es nichts anzuzeigen (fetchImportedOids liefert dann null) — dann
    // aber auch KEIN automatisches getCourse mit dem Chessable-Bearer abfeuern. Sonst erzeugt
    // jeder eingeloggte Chessable-Nutzer ungefragt genau die API-Last, vor der der Crawl-Dialog
    // als Bannrisiko warnt.
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) return;
    if (!force && bid === progressBid && (now() - progressAt) < PROGRESS_TTL) return;
    if (progressFetching) return;
    progressFetching = true;
    try {
      // Struktur (oids je Kapitel) — 1 getCourse-Call, je bid gecacht. Aus dem Mitschnitt, falls schon da.
      if (bid !== progressBid || !progressStruct) {
        const courseText = (cap.courseText && cap.bid === bid) ? cap.courseText : await chessableGet(`getCourse?bid=${bid}&includeVariations=true`);
        progressStruct = Crawl.parseCourseVariations(courseText);
        saveStructure(bid, progressStruct.chapters);   // für die Zähler der Startseite merken
      }
      const prog = await fetchImportedOids(bid);
      importedOids = new Set((prog && prog.oids) || []);
      progressBid = bid; progressAt = now();
      annotateDom();
    } catch (e) { /* still */ }
    finally { progressFetching = false; }
  }

  // Best-Effort: an Chessables eigene Linien-Elemente ein ✓/○ heften. Wir suchen Elemente, deren
  // href/data-Attribut die oid als eigenes Segment enthält (robust ggü. Layout, fragil nur, falls
  // Chessable die oid gar nicht im DOM ausweist). Idempotent über ein data-Flag.
  function annotateDom() {
    if (!progressStruct) return;
    for (const oid of progressStruct.allOids) {
      const done = importedOids.has(String(oid));
      let el = document.querySelector(`a[href*="/${oid}"], a[href$="/${oid}"], [data-oid="${oid}"], [data-variation-id="${oid}"], [data-id="${oid}"]`);
      if (!el) continue;
      const row = el.closest('li, tr, [role="row"], div') || el;
      if (row.querySelector(':scope > .rc-prog-badge')) {
        const b = row.querySelector(':scope > .rc-prog-badge');
        b.textContent = done ? '✓' : '○';
        b.style.color = done ? '#4caf50' : '#9aa4b2';
        continue;
      }
      const badge = document.createElement('span');
      badge.className = 'rc-prog-badge';
      badge.textContent = done ? '✓' : '○';
      badge.title = t(done ? 'progress.onRookhub' : 'progress.notOnRookhub');
      badge.style.cssText = `margin-right:6px;font-weight:700;color:${done ? '#4caf50' : '#9aa4b2'}`;
      row.insertBefore(badge, row.firstChild);
    }
    annotateCourseOverview();
  }

  // Chessable ist eine SPA → bei DOM-Änderungen die Marker (nicht die Fetches) neu anwenden.
  let domObserver = null;
  function startDomObserver() {
    if (domObserver || !document.body) return;
    let t = null;
    domObserver = new MutationObserver(() => {
      if (t) return;
      t = setTimeout(() => { t = null; try { annotateDom(); annotateHome(); } catch (e) {} }, 500);
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ---- Zähler auf Kursübersicht und Startseite (v1.58.0) ----
  // Anker aus echten Inspector-Dumps vom 13.09. (volles Seiten-HTML):
  //  • Kursübersicht /course/{bid}: #chapterBoxes > div.chapter > a.levelBox[href=/course/{bid}/{lid}], darin
  //    .progressVisuals mit Chessables eigenem Zähler („28/28 variations"); Überschrift h1.courseUI-bookChapter.
  //  • Startseite: #mainBooksList .bookHome[data-bid] mit .bookDetails („373 / 817 variations"). Dieselben
  //    Kurs-Links stehen zusätzlich in Dropdown-Menüs — deshalb über die Karte, nie über Links.
  // v1.52.0 riet die Anker (closest('div'), Links statt Karten) und zählte rohe oids ohne Kursstruktur (413 bei
  // einem 365-Linien-Kurs). Jetzt ist der Zähler die Schnittmenge aus RookHub-oids und Chessables Linienliste.
  const STRUCT_KEY = 'courseStructures';
  const STRUCT_TTL_MS = 7 * 24 * 3600 * 1000;
  const STRUCT_MAX_COURSES = 80;
  const HOME_MAX_FETCHES = 25;   // getCourse-Abrufe je Startseiten-Besuch, nur für Kurse ohne gemerkte Struktur

  function isCourseOverview(bid) { return location.pathname.replace(/\/+$/, '') === '/course/' + bid; }
  function isHomePage() { return /^\/(?:home)?\/?$/.test(location.pathname); }

  function storageGet(key) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(key, (r) => resolve(r ? r[key] : undefined)); } catch (e) { resolve(undefined); }
    });
  }

  // Kursstruktur (Kapitel → Linien-oids) je bid merken: die Startseite braucht sie für jeden Kurs, soll dafür aber
  // nicht bei jedem Besuch Chessable abfragen. Kurs- und Kapitelseiten holen sie ohnehin frisch und legen sie ab.
  async function loadStructure(bid) {
    const all = (await storageGet(STRUCT_KEY)) || {};
    const e = all[bid];
    return (e && Array.isArray(e.chapters) && now() - (e.at || 0) < STRUCT_TTL_MS) ? e.chapters : null;
  }
  async function saveStructure(bid, chapters) {
    if (!bid || !Crawl || !Array.isArray(chapters) || !chapters.length) return;
    const all = Object.assign({}, (await storageGet(STRUCT_KEY)) || {});
    all[bid] = { at: now(), chapters: chapters.map((c) => ({ lid: c.lid, oids: c.oids })) };
    try { chrome.storage.local.set({ [STRUCT_KEY]: Crawl.pruneStructures(all, STRUCT_MAX_COURSES) }); }
    catch (e) { /* Speicher nicht verfügbar — dann eben ohne Merken */ }
  }

  // Zähl-Badge „✓ done/total" idempotent an ein Element hängen (setzt Text nur bei Änderung → kein Observer-Echo).
  function upsertCount(host, cls, done, total, block) {
    if (!host) return;
    let b = host.querySelector(':scope > .' + cls);
    if (!b) {
      b = document.createElement(block ? 'div' : 'span');
      b.className = cls;
      host.appendChild(b);
    }
    const text = '✓ ' + done + '/' + total;
    if (b.textContent !== text) b.textContent = text;
    const title = t('progress.countTitle', { done, total });
    if (b.title !== title) b.title = title;
    const col = total > 0 && done >= total ? '#4caf50' : (done > 0 ? '#e0a020' : '#9aa4b2');
    b.style.cssText = (block ? 'display:block;margin-top:4px;' : 'margin-left:6px;')
      + `font-weight:700;font-size:12px;white-space:nowrap;color:${col}`;
  }

  function pathOf(href) {
    try { return new URL(href, location.origin).pathname; } catch (e) { return ''; }
  }

  // Kursübersicht: je Kapitel „✓ auf RookHub / Linien" neben Chessables Zähler, dazu die Kurs-Summe.
  function annotateCourseOverview() {
    const bid = progressBid;
    if (!bid || !progressStruct || !Crawl || !isCourseOverview(bid)) return;
    const counts = Crawl.progressCounts(progressStruct.chapters, importedOids);
    if (!counts.total) return;
    const byLid = new Map(counts.perChapter.map((c) => [String(c.lid), c]));
    const lidRe = new RegExp('^/course/' + bid + '/(\\d+)/?$');
    for (const a of document.querySelectorAll('#chapterBoxes a.levelBox[href]')) {
      const m = lidRe.exec(pathOf(a.getAttribute('href')));
      const c = m && byLid.get(m[1]);
      if (!c || !c.total) continue;
      upsertCount(a.querySelector('.progressVisuals') || a, 'rc-chap-count', c.done, c.total);
    }
    upsertCount(document.querySelector('h1.courseUI-bookChapter'), 'rc-course-count', counts.done, counts.total);
  }

  // Startseite: je Kurskarte „✓ auf RookHub / Linien" — nur für Kurse, die auf RookHub liegen.
  const homeCounts = new Map();   // bid → { done, total } | null (kein Badge) | 'pending'
  let homeRunning = false;
  async function annotateHome() {
    if (!Crawl || !isHomePage()) return;
    const cards = Array.from(document.querySelectorAll('#mainBooksList .bookHome[data-bid]'));
    if (!cards.length) return;
    cards.forEach(paintHomeCard);
    if (homeRunning) return;
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) return;
    const offen = [...new Set(cards.map((c) => c.getAttribute('data-bid')))]
      .filter((b) => /^\d+$/.test(b || '') && !homeCounts.has(b));
    if (!offen.length) return;
    homeRunning = true;
    let fetches = 0;
    try {
      for (const bid of offen) {
        if (!isHomePage()) break;   // SPA-Wechsel: der Rest ist für die nächste Startseite
        homeCounts.set(bid, 'pending');
        const prog = await fetchImportedOids(bid);
        // Kurs gar nicht auf RookHub → kein Badge, sonst trüge jede Karte ein „0/…".
        if (!prog || !(prog.book || prog.repertoire)) { homeCounts.set(bid, null); continue; }
        let chapters = await loadStructure(bid);
        if (!chapters && fetches < HOME_MAX_FETCHES) {
          fetches++;
          try {
            chapters = Crawl.parseCourseVariations(await chessableGet(`getCourse?bid=${bid}&includeVariations=true`)).chapters;
            await saveStructure(bid, chapters);
          } catch (e) { chapters = null; }
          await sleep(crawlPauseMs());   // schonender Takt wie beim Kurs holen
        }
        if (!chapters || !chapters.length) { homeCounts.set(bid, null); continue; }
        const c = Crawl.progressCounts(chapters, new Set((prog.oids || []).map(String)));
        homeCounts.set(bid, c.total ? { done: c.done, total: c.total } : null);
        document.querySelectorAll(`#mainBooksList .bookHome[data-bid="${bid}"]`).forEach(paintHomeCard);
      }
    } catch (e) { /* still */ }
    finally { homeRunning = false; }
  }
  function paintHomeCard(card) {
    const v = homeCounts.get(card.getAttribute('data-bid'));
    if (!v || v === 'pending') return;
    upsertCount(card.querySelector('.bookDetails') || card, 'rc-home-count', v.done, v.total, true);
  }

  // ---- Zustand + Popup-Bridge (das UI liegt jetzt im Extension-Popup) ----
  // Das früher eingeblendete On-Page-Panel (links unten) ist entfernt; das Popup fragt den
  // Zustand per chrome.tabs.sendMessage ab und löst Crawl / Mitschnitt-Import / Live-Toggle /
  // Ziel-Umschaltung aus. Die In-Page-Marker (✓/○ an Chessables Linien) bleiben (annotateDom).
  let importTarget = 'repertoire';   // vom Popup gesetzt (repertoire|book)
  let lastStatus = '';

  // Parameter bewusst `txt`, nicht `t` — `t` ist der Übersetzer-Wrapper (sonst verdeckt).
  function setStatus(txt) { lastStatus = txt || ''; }

  // Kurs-/Kapitel-Fortschritt fürs Popup (null, solange keine Struktur da).
  function progressSummary() {
    if (!Crawl || !progressStruct) return null;
    const c = Crawl.progressCounts(progressStruct.chapters, importedOids);
    if (!c.total) return null;
    return { done: c.done, total: c.total, pct: Math.round((c.done / c.total) * 100), perChapter: c.perChapter };
  }

  function importState() {
    const bid = currentCourseId();
    return {
      onCourse: !!bid,
      bid: bid || null,
      courseName: bid ? bestCourseName(bid) : null,
      captured: capturedLineCount(),
      autoImport,
      crawling,
      crawlStartedAt,
      target: importTarget,
      status: lastStatus,
      progress: progressSummary(),
    };
  }

  // Popup → Content-Script. `state` antwortet synchron mit dem Momentzustand; die Aktionen
  // stoßen an und der Fortschritt wird über wiederholtes `state`-Polling im Popup sichtbar.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'rc-import') return;
    switch (msg.action) {
      case 'state':
        ensureProgress(false);            // opportunistisch frisch halten
        sendResponse(importState());
        break;
      case 'setTarget':
        if (msg.target === 'book' || msg.target === 'repertoire') importTarget = msg.target;
        sendResponse(importState());
        break;
      case 'crawl':
        if (msg.target === 'book' || msg.target === 'repertoire') importTarget = msg.target;
        crawlAndImport(importTarget);
        sendResponse({ started: true });
        break;
      case 'cancel':
        if (crawling) { cancelRequested = true; setStatus(t('import.abortRequested')); }
        sendResponse(importState());
        break;
      case 'importCaptured':
        if (msg.target === 'book' || msg.target === 'repertoire') importTarget = msg.target;
        importCaptured(importTarget);
        sendResponse({ started: true });
        break;
      case 'refreshProgress':
        ensureProgress(true);
        sendResponse({ ok: true });
        break;
      default:
        sendResponse(null);
    }
  });

  setInterval(() => { startDomObserver(); ensureProgress(false); annotateHome(); }, TICK_MS);
  startDomObserver(); ensureProgress(false); annotateHome();

  console.log('[RepCheck Chessable] Activity-Tracking aktiv');
})();
