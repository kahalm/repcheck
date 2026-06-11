// Laeuft als Content-Script (isolierte Welt) auf chessable.com. Liest den im
// localStorage abgelegten API-Token (`chessable.web.production.JWT`) und legt
// ihn in chrome.storage.local ab, damit das Popup einen Copy-Button anbieten
// kann (Weitergabe an piratechess). Content-Scripts teilen sich die
// localStorage des Page-Origins, daher reicht ein direkter Lesezugriff — kein
// Eingriff in fetch/XHR noetig. Der Token verlaesst den Browser nicht.
(function () {
  const LS_KEY = 'chessable.web.production.JWT';
  let lastStored = null;

  // Der Wert kann roh ("eyJ…"), als JSON-String ("\"eyJ…\"") oder als JSON-
  // Objekt ({token:"eyJ…"}) vorliegen — alle Faelle abdecken.
  function extractJwt(raw) {
    if (typeof raw !== 'string') return null;
    let v = raw.trim();
    if (!v) return null;
    if (v[0] === '"' || v[0] === '{') {
      try {
        const parsed = JSON.parse(v);
        if (typeof parsed === 'string') v = parsed;
        else if (parsed && typeof parsed === 'object') {
          v = parsed.token || parsed.jwt || parsed.accessToken || parsed.access_token || '';
        }
      } catch (e) { /* kein JSON — Rohwert behalten */ }
    }
    v = String(v).trim();
    return v || null;
  }

  function syncToken() {
    let raw;
    try {
      raw = window.localStorage.getItem(LS_KEY);
    } catch (e) {
      return; // localStorage evtl. blockiert
    }
    const token = extractJwt(raw);
    if (!token || token === lastStored) return;
    lastStored = token;
    try {
      chrome.storage.local.set({
        chessableToken: {
          token,
          capturedAt: Date.now(),
          origin: location.origin,
        },
      });
    } catch (e) { /* storage nicht verfuegbar — ignorieren */ }
  }

  // Initial + bei Tab-Fokus/Sichtbarkeit erneut pruefen (Token erscheint erst
  // nach Login bzw. kann rotieren).
  syncToken();
  window.addEventListener('focus', syncToken);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncToken();
  });
  // Reagiert auf Login/Logout in anderen Tabs desselben Origins.
  window.addEventListener('storage', (ev) => {
    if (!ev || ev.key === null || ev.key === LS_KEY) syncToken();
  });
})();
