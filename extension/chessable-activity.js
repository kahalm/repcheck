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

  try { chrome.storage.local.get('rookhubChessableAutoImport', (r) => { autoImport = !!(r && r.rookhubChessableAutoImport); updatePanel(); }); } catch (e) {}

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
    updatePanel();
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

  const CRAWL_INTER_MS = 350;   // schonender Takt gegen das eigene Chessable-Konto
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let crawling = false;

  // V2: kompletten Kurs aktiv holen (getCourse→getList→getGame), Mitschnitt wo vorhanden wiederverwenden.
  async function crawlAndImport(target) {
    if (crawling) return; crawling = true; updatePanel();
    const bid = currentCourseId();
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
      const chapters = [];
      let done = 0;
      for (const { listText, oids } of lists) {
        const games = {};
        for (const oid of oids) {
          let g = cap.games[oid];
          if (!g) { g = await chessableGet(`getGame?lng=en&oid=${oid}`); await sleep(CRAWL_INTER_MS); }
          if (g && g.trim() && g.trim() !== '{}') { games[oid] = g; cap.games[oid] = g; }
          done++; setStatus(`Hole Linien … ${done}/${total}`);
        }
        chapters.push({ listText, games });
      }
      const payload = Crawl.buildIngestChapters(chapters);
      if (!payload.length) throw new Error('Keine Linien geholt');
      setStatus('Importiere in RookHub …');
      const res = await ingest(bid, payload, target, bestCourseName(bid));
      setStatus(`Fertig: ${res.imported} ${target === 'book' ? 'Puzzles' : 'Linien'} importiert.`);
    } catch (err) {
      setStatus('Fehler: ' + ((err && err.message) || err));
    } finally { crawling = false; updatePanel(); }
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
    } catch (err) { setStatus('Fehler: ' + ((err && err.message) || err)); }
  }

  function scheduleAutoImport() {
    if (autoImportTimer) return;
    autoImportTimer = setTimeout(() => {
      autoImportTimer = null;
      if (capturedLineCount() > 0) importCaptured(currentTarget());
    }, 8000);
  }

  // ---- UI-Panel (isolierte Welt darf DOM manipulieren) ----
  let panel = null, statusEl = null, capInfoEl = null, importCapBtn = null, crawlBtn = null, autoChk = null;

  function currentTarget() {
    const r = panel && panel.querySelector('input[name="rc-target"]:checked');
    return r ? r.value : 'repertoire';
  }
  function setStatus(t) { if (statusEl) statusEl.textContent = t || ''; }

  function ensurePanel() {
    if (panel || !document.body) return;
    if (!currentCourseId()) return;   // nur auf Kurs-/Practice-Seiten
    panel = document.createElement('div');
    panel.id = 'repcheck-import-panel';
    panel.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483000;background:#1f2530;color:#e8eaed;font:12px/1.4 system-ui,sans-serif;border:1px solid #3a4250;border-radius:8px;padding:10px 12px;max-width:260px;box-shadow:0 4px 16px rgba(0,0,0,.4)';
    panel.innerHTML =
      '<div style="font-weight:600;margin-bottom:6px">RookHub-Import (Browser)</div>' +
      '<div style="margin-bottom:6px">' +
        '<label style="margin-right:10px"><input type="radio" name="rc-target" value="repertoire" checked> Repertoire</label>' +
        '<label><input type="radio" name="rc-target" value="book"> Kurs/Buch</label>' +
      '</div>' +
      '<button id="rc-crawl" style="width:100%;margin-bottom:6px;padding:6px;background:#2d6cdf;color:#fff;border:0;border-radius:5px;cursor:pointer">⚡ Kurs über meinen Browser holen</button>' +
      '<div id="rc-capinfo" style="margin-bottom:4px;color:#9aa4b2"></div>' +
      '<button id="rc-importcap" style="width:100%;margin-bottom:6px;padding:5px;background:#3a4250;color:#e8eaed;border:0;border-radius:5px;cursor:pointer;display:none">Mitschnitt importieren</button>' +
      '<label style="display:block;margin-bottom:6px;color:#9aa4b2"><input type="checkbox" id="rc-auto"> Beim Training automatisch importieren</label>' +
      '<div id="rc-status" style="color:#8fd08f;min-height:1.2em"></div>';
    document.body.appendChild(panel);
    statusEl = panel.querySelector('#rc-status');
    capInfoEl = panel.querySelector('#rc-capinfo');
    importCapBtn = panel.querySelector('#rc-importcap');
    crawlBtn = panel.querySelector('#rc-crawl');
    autoChk = panel.querySelector('#rc-auto');
    crawlBtn.addEventListener('click', () => crawlAndImport(currentTarget()));
    importCapBtn.addEventListener('click', () => importCaptured(currentTarget()));
    autoChk.addEventListener('change', () => {
      autoImport = autoChk.checked;
      try { chrome.storage.local.set({ rookhubChessableAutoImport: autoImport }); } catch (e) {}
    });
    updatePanel();
  }

  function updatePanel() {
    if (!panel) return;
    const n = capturedLineCount();
    if (capInfoEl) capInfoEl.textContent = n > 0 ? `${n} Linien mitgeschnitten` : 'Noch nichts mitgeschnitten';
    if (importCapBtn) importCapBtn.style.display = n > 0 ? 'block' : 'none';
    if (autoChk) autoChk.checked = autoImport;
    if (crawlBtn) crawlBtn.disabled = crawling;
  }

  setInterval(ensurePanel, TICK_MS);
  ensurePanel();

  console.log('[RepCheck Chessable] Activity-Tracking aktiv');
})();
