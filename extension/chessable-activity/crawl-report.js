// chessable-activity.js-Teil (Zerlegung Z36, zweiter Schnitt): Meldungen, wenn „⚡ Kurs holen" abbricht — unerwartete
// Chessable-Antwort (Karte, Popup-Hinweis rcCrawlAlert, unexpected-response an RookHub) und sonstiger Abbruch
// (crawl-error an RookHub). Bis v1.73.2 in course-import.js; Wortlaut unveraendert.
//
// Zustand: keiner. Keine Seiteneffekte beim Laden.
// Laden: Manifest content_scripts (chessable.com, isolierte Welt), VOR course-import.js und chessable-activity.js
// → self.RepCheckActivity.report
(function () {
  'use strict';

  // Wie chessable-activity.js: laeuft die isolierte Welt in diesem Tab schon (das Popup laedt die Manifest-Liste nach),
  // nichts neu anlegen.
  if (window.__repcheckChessableActivity) return;

  // Aus chessable-activity.js und den anderen Teilen (init).
  let t, readConfig, bestCourseName, setStatus, showCrawlAlert, CRAWL_ALERT_ID;

  // ---- Unerwartete Chessable-Antwort: Holen stoppen, warnen, melden (v1.60.0) ----
  // Jede Antwort beim „Kurs holen" wird geprüft (Crawl.checkChessableResponse). Passt eine nicht, bricht der Lauf ab:
  // dahinter kann eine Anti-Crawling-Maßnahme von Chessable stecken, und blindes Weiterholen würde sie nur bestätigen.
  // Der Nutzer bekommt eine Karte mit Discord-Link (vor einem erneuten Versuch Bescheid geben), das Popup behält den
  // Hinweis (rcCrawlAlert) und fragt vor dem nächsten Holen nach, und RookHub bekommt die Antwort zum Durchsehen —
  // sieht sie nach einer Sperre aus, legt RookHub daraus eine Admin-Nachricht an.

  function unexpectedDetail(u) {
    const wo = u.oid ? ` oid ${u.oid}` : u.lid ? ` lid ${u.lid}` : '';
    const was = u.message || (u.reason === 'json' ? 'no JSON' : u.reason === 'shape' ? 'unexpected format' : '');
    return u.endpoint + wo + (u.status !== 200 ? ` · HTTP ${u.status}` : '') + (was ? ` · ${was}` : '');
  }

  // Grob „Firefox 143" / „Chrome 141" / „Edge 141" — für die Admins reicht Browser und Hauptversion, kein User-Agent.
  function coarseBrowser() {
    const ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '');
    const m = ua.match(/Firefox\/(\d+)/) || ua.match(/Edg\/(\d+)/) || ua.match(/Chrome\/(\d+)/);
    if (!m) return null;
    const name = m[0].startsWith('Firefox') ? 'Firefox' : m[0].startsWith('Edg') ? 'Edge' : 'Chrome';
    return name + ' ' + m[1];
  }

  // „Kurs holen" brach mit einem Fehler OHNE Chessable-Anteil ab (RookHub ≥ 0.696.0): Log + Admin-Nachricht. Bewusst über
  // chrome.runtime direkt statt über den RookHub-Client — dessen Ausfall war am 07.10.2026 genau der Fehler, der nie
  // ankam. Best effort, ohne Antwort an den Nutzer.
  async function reportCrawlError(bid, target, lauf, message) {
    try {
      const cfg = await readConfig();
      if (!cfg || !cfg.url || !cfg.token || !bid) return;
      let version = null;
      try { version = chrome.runtime.getManifest().version; } catch (e) { /* ohne Version */ }
      chrome.runtime.sendMessage({
        type: 'rookhub-fetch',
        url: String(cfg.url).replace(/\/$/, '') + '/api/extension/chessable/crawl-error',
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          bid: String(bid), courseName: (bestCourseName(bid) || '').slice(0, 300) || null, target,
          phase: lauf ? lauf.phase : null, message: String(message || '').slice(0, 1000),
          linesFetched: lauf ? lauf.fetched : null, linesSent: lauf ? lauf.sent : null,
          extensionVersion: version, browser: coarseBrowser(),
        }),
        expect: 'json',
      }, () => { void chrome.runtime.lastError; });
    } catch (e) { /* abgehängt oder ohne Verbindung — dann gibt es keinen Weg mehr */ }
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

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckActivity = self.RepCheckActivity || {}).report = {
    init(deps) {
      ({ t, readConfig, bestCourseName, setStatus, showCrawlAlert, CRAWL_ALERT_ID } = deps);
    },
    unexpectedDetail, coarseBrowser, reportCrawlError, reportUnexpected, handleUnexpected,
  };
})();
