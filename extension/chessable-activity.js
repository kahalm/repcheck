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

  let activeMs = 0;
  let movesTrained = 0;
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

  // Gewertete Zuege: <span data-testid="moveNotification">; Text "XP" = abgeschlossener Zug.
  let notifObserver = null, watchedNotif = null;
  function watchMoveNotif() {
    const n = document.querySelector('[data-testid="moveNotification"]');
    if (!n || watchedNotif === n) return;
    notifObserver?.disconnect();
    watchedNotif = n;
    notifObserver = new MutationObserver(() => {
      const t = n.textContent.trim();
      if (!t) return;
      bump();
      if (t === 'XP') movesTrained++;
    });
    notifObserver.observe(n, { childList: true, characterData: true, subtree: true });
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
  function currentCourseId() {
    if (bridgedCourseId) return bridgedCourseId;
    const m = /\/courses?\/(\d+)(?:\/|$)/.exec(location.pathname);
    if (m) return m[1];
    for (const a of document.querySelectorAll('a[href*="/course/"]')) {
      const am = /\/course\/(\d+)(?:\/|$)/.exec(a.getAttribute('href') || '');
      if (am) return am[1];
    }
    return null;
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

  // Lesbarer Kursname (Fallback, falls die MAIN-World-Bridge noch nichts gespiegelt hat).
  function currentCourseName() {
    if (bridgedCourseName) return bridgedCourseName;
    const id = currentCourseId();
    if (id) {
      for (const a of document.querySelectorAll('a[href*="/course/' + id + '/"]')) {
        const txt = (a.textContent || '').trim();
        if (txt && txt.length <= 200) return txt;
      }
    }
    const t = (document.title || '').replace(/\s*[|\-–]\s*Chessable.*$/i, '').trim();
    return t || null;
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

  function b64urlDecode(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return atob(s);
  }

  // uid steckt im JWT-Payload unter user.uid (wie piratechess/JwtHelper).
  function decodeUid(token) {
    try {
      const parts = String(token).split('.');
      if (parts.length < 2) return null;
      const obj = JSON.parse(b64urlDecode(parts[1]));
      const uid = obj && obj.user && obj.user.uid;
      return (uid != null && /^\d+$/.test(String(uid))) ? String(uid) : null;
    } catch (e) { return null; }
  }

  function readChessableToken() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('chessableToken', (r) =>
          resolve((r && r.chessableToken && r.chessableToken.token) || null));
      } catch (e) { resolve(null); }
    });
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
      if (!resp.ok) return null;
      const data = await resp.json();
      const home = data && (data.homeData || data.HomeData);
      const books = home && (home.booksList || home.BooksList);
      if (!Array.isArray(books)) return null;
      const map = {};
      for (const b of books) {
        const bid = b && (b.bid != null ? b.bid : b.Bid);
        const name = b && (b.name != null ? b.name : b.Name);
        if (bid != null && typeof name === 'string' && name.trim())
          map[String(bid)] = name.trim().slice(0, 200);
      }
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
  function bestCourseName(courseId) {
    return apiCourseName(courseId) || bridgedCourseName || currentCourseName();
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

  async function flush(force) {
    if (!force && activeMs < MIN_FLUSH_MS) return;
    const secs = Math.min(MAX_FLUSH_S, Math.round(activeMs / 1000));
    if (secs <= 0) return;

    const cfg = await readConfig();
    lastFlush = now();
    if (!cfg || !cfg.url || !cfg.token) {
      // Nicht mit RookHub verbunden → akkumulierte Zeit verwerfen (kein unbegrenztes Wachsen).
      activeMs = 0; movesTrained = 0;
      return;
    }

    const moves = movesTrained;
    activeMs = 0; movesTrained = 0; // optimistisch zuruecksetzen
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
        body: JSON.stringify({ secondsActive: secs, movesTrained: moves, courseKind, courseId: currentCourseId(), courseName: bestCourseName(currentCourseId()) }),
        expect: 'json',
      }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          // Fehlgeschlagen → Zeit/Zuege zurueckbuchen, damit nichts verloren geht.
          activeMs += secs * 1000;
          movesTrained += moves;
        }
      });
    } catch (e) {
      activeMs += secs * 1000;
      movesTrained += moves;
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
  window.addEventListener('pagehide', () => flush(true));

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

  // ======================================================================================
  // Browser-Kurs-Import: V1 (passiver Mitschnitt der Kurs-API) + V2 (aktives Holen). Der Browser
  // holt die Chessable-Daten als echte eingeloggte Session (passiert Cloudflare) und schickt das rohe
  // JSON an RookHub (POST /api/extension/chessable/ingest); der fetch-freie piratechess-Parser macht
  // daraus PGN. Kein serverseitiger Chessable-Abruf/VPN nötig. Additiv — der Server-Import bleibt.
  // ======================================================================================
  const Crawl = self.RepCheckCrawl || null;

  // Per-bid-Mitschnitt-Puffer (Session, in-memory). getGame trägt nur die oid → oid→lid via getList.
  const cap = { bid: null, courseText: null, lists: {}, oidToLid: {}, games: {}, bytes: 0 };
  const CAP_MAX_BYTES = 40 * 1024 * 1024;   // Speicher-Deckel (großer Kurs)
  let autoImport = false;                   // V1: Mitschnitt beim Training automatisch senden
  let autoImportTimer = null;

  try { chrome.storage.local.get('rookhubChessableAutoImport', (r) => { autoImport = !!(r && r.rookhubChessableAutoImport); }); } catch (e) {}

  function resetCap(bid) { cap.bid = bid; cap.courseText = null; cap.lists = {}; cap.oidToLid = {}; cap.games = {}; cap.bytes = 0; }

  // MAIN-World chessable-capture.js → hier: rohe Kurs-API-Antworten puffern (nur source+origin-geprüft).
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__repcheck !== 'chessable-capture') return;
    if (!Crawl) return;
    const info = Crawl.classifyChessableApi(e.data.url);
    const body = e.data.body;
    if (!info || typeof body !== 'string') return;
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
    } else if (info.kind === 'game') {
      if (info.oid != null && !cap.games[info.oid]) { cap.games[info.oid] = body; cap.bytes += body.length; }
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
    if (!cfg || !cfg.url || !cfg.token) throw new Error('Nicht mit RookHub verbunden');
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
        if (!resp || !resp.ok) return reject(new Error((resp && resp.body && resp.body.message) || ('HTTP ' + (resp && resp.status))));
        resolve(resp.body);
      });
    });
  }

  // same-origin Chessable-Fetch (V2 aktiv) — gleiche Rezeptur wie fetchCourseNameMap (Bearer, credentials).
  async function chessableGet(path) {
    const token = await readChessableToken();
    if (!token) throw new Error('Kein Chessable-Token (auf chessable.com eingeloggt?)');
    const uid = decodeUid(token);
    if (!uid) throw new Error('Chessable-Token ohne uid');
    const sep = path.includes('?') ? '&' : '?';
    const resp = await fetch(`https://www.chessable.com/api/v1/${path}${sep}uid=${uid}`,
      { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }, credentials: 'include' });
    if (!resp.ok) throw new Error('Chessable HTTP ' + resp.status);
    return resp.text();
  }

  // Ein Kapitel-Chunk an den kapitelweisen Ingest (bounded pro Request). final=true schließt die
  // Session ab → Server parst+importiert den GANZEN Kurs (korrekte Kapitel-/Round-Reihenfolge).
  async function ingestChunk(sessionId, bid, target, courseName, chapter, final) {
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token) throw new Error('Nicht mit RookHub verbunden');
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: baseUrl + '/api/extension/chessable/ingest/chunk',
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ sessionId, bid, target, courseName, chapter, final }),
        expect: 'json',
      }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp || !resp.ok) return reject(new Error((resp && resp.body && resp.body.message) || ('HTTP ' + (resp && resp.status))));
        resolve(resp.body);
      });
    });
  }

  const CRAWL_INTER_MS = 350;   // schonender Takt gegen das eigene Chessable-Konto
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const newSessionId = () => (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : (String(Date.now()) + '-' + Math.round(Math.random() * 1e9));
  let crawling = false;

  // V2: kompletten Kurs aktiv holen (getCourse→getList→getGame) und KAPITELWEISE streamen — der Server
  // sammelt die Kapitel je Session und importiert erst beim finalen Chunk (kein Riesen-Body).
  async function crawlAndImport(target) {
    if (crawling) return; crawling = true;
    const bid = currentCourseId();
    const sessionId = newSessionId();
    try {
      if (!bid) throw new Error('Kein Kurs erkannt');
      if (!Crawl) throw new Error('Interne lib fehlt');
      setStatus('Hole Kursstruktur …');
      const courseText = (cap.courseText && cap.bid === bid) ? cap.courseText : await chessableGet(`getCourse?bid=${bid}`);
      const lids = Crawl.parseChapterLids(courseText);
      if (!lids.length) throw new Error('Keine Kapitel gefunden');
      const lists = [];
      let total = 0;
      for (const lid of lids) {
        const listText = (cap.lists[lid] && cap.bid === bid) ? cap.lists[lid] : await chessableGet(`getList?bid=${bid}&lid=${lid}`);
        const oids = Crawl.parseLineOids(listText);
        lists.push({ listText, oids });
        total += oids.length;
        await sleep(CRAWL_INTER_MS);
      }
      const courseName = bestCourseName(bid);
      let done = 0, sent = 0;
      for (const { listText, oids } of lists) {
        const lines = [];
        for (const oid of oids) {
          let g = cap.games[oid];
          if (!g) { g = await chessableGet(`getGame?lng=en&oid=${oid}`); await sleep(CRAWL_INTER_MS); }
          if (g && g.trim() && g.trim() !== '{}') { lines.push(g); cap.games[oid] = g; }
          done++; setStatus(`Hole Linien … ${done}/${total}`);
        }
        if (lines.length) { await ingestChunk(sessionId, bid, target, courseName, { chapterJson: listText, lines }, false); sent++; }
      }
      if (!sent) throw new Error('Keine Linien geholt');
      setStatus('Importiere in RookHub …');
      const res = await ingestChunk(sessionId, bid, target, courseName, null, true);
      setStatus(`Fertig: ${res.imported} ${target === 'book' ? 'Puzzles' : 'Linien'} importiert.`);
      ensureProgress(true);
    } catch (err) {
      setStatus('Fehler: ' + ((err && err.message) || err));
    } finally { crawling = false; }
  }

  // V1: nur den passiven Mitschnitt importieren (kein aktives Holen).
  async function importCaptured(target) {
    const bid = cap.bid || currentCourseId();
    const chapters = capturedChapters();
    if (!bid || !chapters.length) { setStatus('Nichts mitgeschnitten.'); return; }
    try {
      setStatus('Importiere Mitschnitt …');
      const res = await ingest(bid, chapters, target, bestCourseName(bid));
      setStatus(`Fertig: ${res.imported} ${target === 'book' ? 'Puzzles' : 'Linien'} importiert.`);
      ensureProgress(true);
    } catch (err) { setStatus('Fehler: ' + ((err && err.message) || err)); }
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
    if (!cfg || !cfg.url || !cfg.token) throw new Error('Nicht mit RookHub verbunden');
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
        if (!resp || !resp.ok) return reject(new Error((resp && resp.body && resp.body.message) || ('HTTP ' + (resp && resp.status))));
        resolve(resp.body);
      });
    });
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
    const chapters = Object.keys(byLid).map(lid => ({ chapterJson: cap.lists[lid], lines: byLid[lid].map(o => cap.games[o]) }));
    liveFlushing = true;
    picked.forEach(o => sentOids.add(o));   // optimistisch; bei Fehler zurücknehmen
    try {
      const res = await ingestLive(bid, importTarget, bestCourseName(bid), chapters);
      setStatus(`Live: ${res.imported} neu angehängt (${sentOids.size} gesendet).`);
      ensureProgress(true);   // Overlay live nachziehen
    } catch (err) {
      picked.forEach(o => sentOids.delete(o));
      setStatus('Live-Fehler: ' + ((err && err.message) || err));
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
    const bid = currentCourseId();
    if (!bid) return;
    if (!force && bid === progressBid && (now() - progressAt) < PROGRESS_TTL) return;
    if (progressFetching) return;
    progressFetching = true;
    try {
      // Struktur (oids je Kapitel) — 1 getCourse-Call, je bid gecacht. Aus dem Mitschnitt, falls schon da.
      if (bid !== progressBid || !progressStruct) {
        const courseText = (cap.courseText && cap.bid === bid) ? cap.courseText : await chessableGet(`getCourse?bid=${bid}&includeVariations=true`);
        progressStruct = Crawl.parseCourseVariations(courseText);
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
      badge.title = done ? 'Auf RookHub' : 'Noch nicht auf RookHub';
      badge.style.cssText = `margin-right:6px;font-weight:700;color:${done ? '#4caf50' : '#9aa4b2'}`;
      row.insertBefore(badge, row.firstChild);
    }
  }

  // Chessable ist eine SPA → bei DOM-Änderungen die Marker (nicht die Fetches) neu anwenden.
  let domObserver = null;
  function startDomObserver() {
    if (domObserver || !document.body) return;
    let t = null;
    domObserver = new MutationObserver(() => {
      if (t) return;
      t = setTimeout(() => { t = null; try { annotateDom(); } catch (e) {} }, 500);
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ---- Zustand + Popup-Bridge (das UI liegt jetzt im Extension-Popup) ----
  // Das früher eingeblendete On-Page-Panel (links unten) ist entfernt; das Popup fragt den
  // Zustand per chrome.tabs.sendMessage ab und löst Crawl / Mitschnitt-Import / Live-Toggle /
  // Ziel-Umschaltung aus. Die In-Page-Marker (✓/○ an Chessables Linien) bleiben (annotateDom).
  let importTarget = 'repertoire';   // vom Popup gesetzt (repertoire|book)
  let lastStatus = '';

  function setStatus(t) { lastStatus = t || ''; }

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
      case 'importCaptured':
        if (msg.target === 'book' || msg.target === 'repertoire') importTarget = msg.target;
        importCaptured(importTarget);
        sendResponse({ started: true });
        break;
      case 'setLive':
        autoImport = !!msg.enabled;
        try { chrome.storage.local.set({ rookhubChessableAutoImport: autoImport }); } catch (e) {}
        if (autoImport && hasUnsentLine()) scheduleAutoImport();
        sendResponse(importState());
        break;
      case 'refreshProgress':
        ensureProgress(true);
        sendResponse({ ok: true });
        break;
      default:
        sendResponse(null);
    }
  });

  setInterval(() => { startDomObserver(); ensureProgress(false); }, TICK_MS);
  startDomObserver(); ensureProgress(false);

  console.log('[RepCheck Chessable] Activity-Tracking aktiv');
})();
