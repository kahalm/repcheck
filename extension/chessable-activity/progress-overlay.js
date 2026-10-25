// chessable-activity.js-Teil (Zerlegung Z36): Fortschritt auf chessable.com — wie viel des Kurses schon auf RookHub
// liegt (GET /api/extension/chessable/progress): ✓/○ an Chessables Linien, „✓ done/total" je Kapitel auf der
// Kursuebersicht und je Kurskarte auf der Startseite (Kursstruktur je bid in chrome.storage.local `courseStructures`).
//
// Zustand: progressBid/progressStruct/importedOids gehoeren hierher (Popup-Bruecke liest sie ueber S), dazu die
// Startseiten-Zaehler und der DOM-Observer. Keine Seiteneffekte beim Laden; Takt und Erst-Aufruf in chessable-activity.js.
// Laden: Manifest content_scripts (chessable.com, isolierte Welt), VOR chessable-activity.js → self.RepCheckActivity.progress
(function () {
  'use strict';

  // Wie chessable-activity.js: laeuft die isolierte Welt in diesem Tab schon (das Popup laedt die Manifest-Liste nach),
  // nichts neu anlegen.
  if (window.__repcheckChessableActivity) return;

  // Aus chessable-activity.js und den anderen Teilen (init).
  let S, t, readConfig, now, cap, currentCourseId, chessableGet, sleep, crawlPauseMs, applySuggestedTarget;

  const Crawl = self.RepCheckCrawl || null;
  const CourseId = self.RepCheckCourseId || null;

  // „Auf RookHub: 80/741" zaehlt live mit: was RookHub gerade angenommen hat, gilt ab sofort als importiert.
  // Vorher kam die oid-Menge nur beim Seitenaufruf bzw. nach 60 s neu, und waehrend des Holens liefen
  // darunter die Linien, waehrend der Zaehler stand (gemeldet 07.10.2026).
  function markImported(bid, chapters) {
    if (!bid || String(bid) !== String(progressBid)) return;
    let neu = 0;
    for (const ch of chapters || []) {
      for (const oid of (ch && ch.lineOids) || []) {
        if (oid == null || importedOids.has(String(oid))) continue;
        importedOids.add(String(oid));
        neu++;
      }
    }
    if (neu) { try { annotateDom(); } catch (e) { /* Marker sind best effort */ } }
  }

  // ======================================================================================
  // Fortschritts-Overlay: zeigt auf chessable.com, wieviel des Kurses schon auf RookHub ist —
  // Kurs- + Kapitel-Zusammenfassung im Panel (robust) UND Best-Effort-Marker (✓/○) direkt an
  // Chessables eigenen Linien-Elementen (per oid im href/data-Attribut; fragil ggü. DOM-Änderungen).
  // Struktur via getCourse?includeVariations (1 Call, oids je Kapitel), importierte oids via RookHub.
  // ======================================================================================
  let progressBid = null, progressStruct = null, importedOids = new Set(), progressAt = 0;
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
    if (!CourseId || !CourseId.COURSE_PAGE_RE.test(location.pathname)) return;
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
        applySuggestedTarget(bid);
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

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckActivity = self.RepCheckActivity || {}).progress = {
    init(deps) {
      ({ S, t, readConfig, now, cap, currentCourseId, chessableGet, sleep, crawlPauseMs, applySuggestedTarget } = deps);
      Object.defineProperties(S, {
        progressBid: { get: () => progressBid, enumerable: true },
        progressStruct: { get: () => progressStruct, enumerable: true },
        importedOids: { get: () => importedOids, enumerable: true },
      });
    },
    markImported, fetchImportedOids, ensureProgress, annotateDom, startDomObserver, isCourseOverview, isHomePage,
    storageGet, loadStructure, saveStructure, upsertCount, pathOf, annotateCourseOverview, annotateHome,
    paintHomeCard,
  };
})();
