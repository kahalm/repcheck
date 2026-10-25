// chessable-activity.js-Teil (Zerlegung Z36): Mitschnitt der Kurs-API (MAIN-World chessable-capture.js → hier) und was
// daraus an RookHub geht — Puffer `cap` (getCourse/getList/getGame je Kurs), „schwierige Zuege" (problem-moves),
// Sitzungszuege aus saveProgress (session-moves, nur mit Token) und getReview-Linien (review-lines bzw. token-los
// review-lines/anon nach einmaliger Zustimmung, Standard-Instanz DEFAULT_ROOKHUB_URL).
//
// Zustand: Puffer und Flush-Timer gehoeren hierher; `cap` bekommen Kurs-Kontext, Kurs holen und Fortschritt als
// Objekt (wird nie ersetzt). crawling liest der Mitschnitt-Listener, lastGameOid schreibt er — beides ueber S.
// Seiteneffekt nur in installMitschnitt().
// Laden: Manifest content_scripts (chessable.com, isolierte Welt), VOR chessable-activity.js → self.RepCheckActivity.capture
(function () {
  'use strict';

  // Wie chessable-activity.js: laeuft die isolierte Welt in diesem Tab schon (das Popup laedt die Manifest-Liste nach),
  // nichts neu anlegen.
  if (window.__repcheckChessableActivity) return;

  // Aus chessable-activity.js und den anderen Teilen (init).
  let S, readConfig, decodeUid, readChessableToken, currentCourseId, showReviewConsentPrompt, scheduleAutoImport;
  let autoImport, now;

  const Crawl = self.RepCheckCrawl || null;

  // Per-bid-Mitschnitt-Puffer (Session, in-memory). getGame trägt nur die oid → oid→lid via getList.
  const cap = { bid: null, courseText: null, lists: {}, oidToLid: {}, games: {}, bytes: 0 };
  const CAP_MAX_BYTES = 40 * 1024 * 1024;   // Speicher-Deckel (großer Kurs)

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

  function installMitschnitt() {
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
        if (!S.crawling && info.oid != null) { S.lastGameOid = String(info.oid); S.lastGameOidAt = now(); }
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
        if (!S.crawling && info.oid != null) { S.lastGameOid = String(info.oid); S.lastGameOidAt = now(); }
        harvestFromGame(cap.bid || currentCourseId(), info.oid, body);
      }
      if (autoImport) scheduleAutoImport();
    });
  }

  // Kapitel-Payload aus dem Puffer (nur Mitgeschnittenes), in getCourse-Reihenfolge.
  function capturedChapters() {
    if (!Crawl) return [];
    const lids = cap.courseText ? Crawl.parseChapterLids(cap.courseText) : Object.keys(cap.lists);
    const chapters = lids.filter(lid => cap.lists[lid]).map(lid => ({ listText: cap.lists[lid], games: cap.games }));
    return Crawl.buildIngestChapters(chapters);
  }
  function capturedLineCount() { return capturedChapters().reduce((n, c) => n + c.lines.length, 0); }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckActivity = self.RepCheckActivity || {}).capture = {
    init(deps) {
      ({ S, readConfig, decodeUid, readChessableToken, currentCourseId, showReviewConsentPrompt, scheduleAutoImport } = deps);
      ({ autoImport, now } = deps);
    },
    cap, CAP_MAX_BYTES, resetCap, queueProblemEntry, flushProblemMoves, harvestFromList, harvestFromGame,
    harvestFromSaveProgress, flushSessionMoves, DEFAULT_ROOKHUB_URL, reviewPending, getReviewConsent,
    setReviewConsent, queueReviewLine, flushReviewLines, capturedChapters, capturedLineCount, installMitschnitt,
  };
})();
