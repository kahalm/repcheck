// chessable-activity.js-Teil (Zerlegung Z36): Abrufe bei Chessable fuer „Kurs holen" und die Fortschritts-Zaehler —
// same-origin mit dem Chessable-Bearer, Wiederholung bei 429/5xx (Retry-After, Backoff ab CRAWL_BACKOFF_BASE_MS), die
// zufaellige Pause zwischen zwei Abrufen (crawlDelay, im Popup nur nach oben verstellbar), die Pruefung jeder Antwort
// (chessableGetChecked: unerwartet / Kurs nicht im Konto) und der Kursstruktur-Zwischenspeicher (IndexedDB RepCheckCrawlCache).
//
// Zustand: crawlDelay und die IndexedDB-Verbindung gehoeren hierher. Seiteneffekt nur in installCrawlDelay().
// Laden: Manifest content_scripts (chessable.com, isolierte Welt), VOR chessable-activity.js → self.RepCheckActivity.fetch
(function () {
  'use strict';

  // Wie chessable-activity.js: laeuft die isolierte Welt in diesem Tab schon (das Popup laedt die Manifest-Liste nach),
  // nichts neu anlegen.
  if (window.__repcheckChessableActivity) return;

  // Aus chessable-activity.js und den anderen Teilen (init).
  let t, setStatus, readChessableToken, decodeUid, clearStoredChessableToken;

  const Crawl = self.RepCheckCrawl || null;

  // Pause zwischen zwei Chessable-Abrufen beim aktiven Kurs-Holen: zufällig in [minMs, maxMs]. Standard
  // 2,5–3,5 s ist zugleich die Untergrenze; das Popup (`crawlDelay` in chrome.storage.local) verschiebt den
  // Bereich nur nach oben. Live nachgeführt, damit eine Änderung auch einen laufenden Crawl sofort bremst.
  let crawlDelay = Crawl ? Crawl.normalizeCrawlDelay(null) : { minMs: 2500, maxMs: 3500 };
  function crawlPauseMs() {
    return Crawl ? Crawl.pickCrawlDelayMs(crawlDelay) : 2500 + Math.floor(Math.random() * 1001);
  }

  // Kurs-holen-Pause aus chrome.storage.local, live nachgefuehrt.
  function installCrawlDelay() {
    try {
      chrome.storage.local.get('crawlDelay', (r) => {
        if (Crawl) crawlDelay = Crawl.normalizeCrawlDelay(r && r.crawlDelay);
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.crawlDelay && Crawl) crawlDelay = Crawl.normalizeCrawlDelay(changes.crawlDelay.newValue);
      });
    } catch (e) { /* Speicher nicht erreichbar — Standardbereich gilt */ }
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

  const CRAWL_BACKOFF_BASE_MS = 3000;   // Basis des Backoffs bei Drosselung (6/12/24/30 s, s. chessableGet); der normale Takt kommt aus crawlPauseMs()
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  // ---- Kursstruktur-Zwischenspeicher (v1.72.0) ----
  // getCourse und die getList-Antworten je Kapitel bleiben LIST_CACHE_TTL_MS lang im IndexedDB dieser Seite liegen. Ein
  // zweiter Versuch (nach Abbruch, Neuladen, Update der Erweiterung) muss sie dann nicht erneut bei Chessable holen — bei
  // 36 Kapiteln mit Pause waren das jedes Mal rund zwei Minuten und 37 Anfragen (gewünscht 07.10.2026). Bewusst
  // IndexedDB statt chrome.storage.local: dessen 10-MB-Grenze reicht für große Kurse nicht, und ein zusätzliches
  // Recht (unlimitedStorage) hieße neue Zustimmung im Store. Die Antworten sind Chessables eigene Kursdaten, keine
  // Geheimnisse. Jeder Fehler (privater Modus, gesperrter Speicher) heißt schlicht: nichts gespeichert, neu holen.
  const LIST_CACHE_DB = 'RepCheckCrawlCache';
  const LIST_CACHE_STORE = 'responses';
  const LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  let listCacheDbPromise = null;
  function listCacheDb() {
    if (!listCacheDbPromise) {
      listCacheDbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open(LIST_CACHE_DB, 1);
          req.onupgradeneeded = () => { try { req.result.createObjectStore(LIST_CACHE_STORE); } catch (e) { /* schon da */ } };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    }
    return listCacheDbPromise;
  }
  async function listCacheGet(key) {
    const db = await listCacheDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = db.transaction(LIST_CACHE_STORE, 'readonly').objectStore(LIST_CACHE_STORE).get(key);
        req.onsuccess = () => {
          const v = req.result;
          resolve(v && typeof v.text === 'string' && Date.now() - (v.at || 0) < LIST_CACHE_TTL_MS ? v.text : null);
        };
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  async function listCachePut(key, text) {
    const db = await listCacheDb();
    if (!db || typeof text !== 'string') return;
    try { db.transaction(LIST_CACHE_STORE, 'readwrite').objectStore(LIST_CACHE_STORE).put({ text, at: Date.now() }, key); }
    catch (e) { /* voll oder gesperrt — dann eben nicht */ }
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckActivity = self.RepCheckActivity || {}).fetch = {
    init(deps) {
      ({ t, setStatus, readChessableToken, decodeUid, clearStoredChessableToken } = deps);
    },
    crawlPauseMs, CHESSABLE_RETRYABLE, CHESSABLE_MAX_ATTEMPTS, parseRetryAfterMs, chessableGet,
    CRAWL_BACKOFF_BASE_MS, sleep, chessableGetChecked, listCacheDb, listCacheGet, listCachePut, installCrawlDelay,
  };
})();
