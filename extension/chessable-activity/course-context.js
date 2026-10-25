// chessable-activity.js-Teil (Zerlegung Z36): welcher Kurs, wie heisst er — Kurs-ID der Seite (lib/chessable-course-id.js:
// URL > React-Fiber aus chessable-fen.js > Link, mit Sticky-ID), Kursname (Kursliste per Chessable-Bearer > Linien-JSON >
// MAIN-World-Bruecke > Seitentext), Kursart von RookHub (lookupCourseKind) und die Bruecken course-id und remember-line.
// Der Chessable-Bearer verlaesst den Browser nicht (getHomeData same-origin).
//
// Zustand: Bruecken-Werte, Sticky-ID und Namenskarte gehoeren hierher; courseKind liest der Tracker ueber S.
// Seiteneffekte nur in installKursIdBruecke()/installRememberLine().
// Laden: Manifest content_scripts (chessable.com, isolierte Welt), VOR chessable-activity.js → self.RepCheckActivity.context
(function () {
  'use strict';

  // Wie chessable-activity.js: laeuft die isolierte Welt in diesem Tab schon (das Popup laedt die Manifest-Liste nach),
  // nichts neu anlegen.
  if (window.__repcheckChessableActivity) return;

  // Aus chessable-activity.js und den anderen Teilen (init).
  let S, readConfig, cap;

  const Crawl = self.RepCheckCrawl || null;

  let courseKind = null;       // RepertoireKind (vom Server, z. B. "Opening") oder null = unbekannt
  let lookedUpCourseId = null; // verhindert Doppel-Lookups bei unveraenderter Kurs-ID
  let bridgedCourseId = null;  // Kurs-ID aus chessable-fen.js (MAIN-World, liest den React-Fiber)
  let bridgedCourseIdSource = null; // woher chessable-fen.js sie hat: 'url' | 'fiber' | 'link' (lib/chessable-course-id.js)
  let bridgedCourseName = null; // Kursname aus chessable-fen.js (best-effort, nur Anzeige)

  // Kurs-ID ermitteln (geteilte Datei lib/chessable-course-id.js, per Manifest VOR dieser Datei geladen):
  // URL > React-Fiber > erster Kurs-Link. In der isolierten Welt ist der Fiber NICHT lesbar und die
  // Practice-URL (/practice/…) traegt keine Kurs-ID — die Fiber-ID spiegelt chessable-fen.js (MAIN-World)
  // hierher; nur eine dort per Fiber aufgeloeste ID zaehlt als Fiber (URL und Links sieht diese Datei selbst).
  const CourseId = self.RepCheckCourseId || null;
  let stickyCourseId = null;  // letzte sicher erkannte Kurs-ID der Sitzung (SPA-Luecken ueberbruecken)
  function courseIdInfo() {
    if (!CourseId) return { id: null, source: null };
    const r = CourseId.resolveCourseId({
      pathname: location.pathname,
      fiberId: bridgedCourseIdSource === 'fiber' ? bridgedCourseId : null,
      links: () => Array.from(document.querySelectorAll('a[href*="/course/"]'), (a) => a.getAttribute('href') || ''),
    });
    // Sticky: auf der Practice-Seite verschwinden die Kurs-Links je nach SPA-Zustand — dann galt
    // die Minute bisher als „ohne Kurs" (~60 % der Haeppchen). Die zuletzt erkannte ID bleibt
    // gueltig, bis eine ANDERE erkannt wird; gezaehlt wird ohnehin nur bei vorhandenem Brett.
    if (r.id) stickyCourseId = r.id;
    return r;
  }
  function currentCourseId() {
    return courseIdInfo().id || stickyCourseId;
  }
  // Kurs-ID nur, wenn die Seite EINEN aktuellen Kurs hat (Kursseite laut Pfad oder ID aus URL/Fiber) —
  // für „Kurs holen" und das Popup. Auf der Startseite fiele currentCourseId() auf die erste Kurskarte
  // zurück; die Trainingszeit-Zuordnung darf das (Brett nötig), ein Crawl mit Bannrisiko nicht.
  function pageCourseId() {
    const r = courseIdInfo();
    return CourseId && CourseId.isOnCourse(location.pathname, r.source) ? (r.id || stickyCourseId) : null;
  }

  function installKursIdBruecke() {
    // chessable-fen.js (MAIN-World) spiegelt die per React-Fiber aufgeloeste Kurs-ID hierher.
    // Nur Same-Window + Same-Origin akzeptieren (Defense-in-Depth). Rest-Risiko: ein
    // beliebiges Skript IM chessable.com-Tab teilt window+origin und könnte diese
    // Bridge-Messages fälschen — der Token bleibt aber aus dem Page-Kontext heraus,
    // Impact wäre nur eingeschleuste Anzeige-/Merk-Daten, kein Token-Diebstahl.
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__repcheck !== 'course-id') return;
      const id = e.data.courseId;
      bridgedCourseId = (id != null && /^\d+$/.test(String(id))) ? String(id) : null;
      const src = e.data.courseIdSource;
      bridgedCourseIdSource = (bridgedCourseId && (src === 'url' || src === 'fiber' || src === 'link')) ? src : null;
      const name = e.data.courseName;
      bridgedCourseName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 200) : null;
    });
  }

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

  function installRememberLine() {
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
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckActivity = self.RepCheckActivity || {}).context = {
    init(deps) {
      ({ S, readConfig, cap } = deps);
      Object.defineProperties(S, {
        courseKind: { get: () => courseKind, enumerable: true },
      });
    },
    CourseId, courseIdInfo, currentCourseId, pageCourseId, CourseNames, isNavLabel, cleanTitle, anchorTitle,
    currentCourseName, decodeUid, readChessableToken, clearStoredChessableToken, fetchCourseNameMap,
    loadPersistedNames, ensureCourseNames, apiCourseName, capturedCourseName, bestCourseName, lookupCourseKind,
    installKursIdBruecke, installRememberLine,
  };
})();
