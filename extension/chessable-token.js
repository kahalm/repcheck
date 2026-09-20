// Laeuft als Content-Script (isolierte Welt) auf chessable.com. Liest den im
// localStorage abgelegten API-Token (`chessable.web.production.JWT`) und legt
// ihn in chrome.storage.local ab, damit das Popup einen Copy-Button anbieten
// kann (Weitergabe an piratechess). Content-Scripts teilen sich die
// localStorage des Page-Origins, daher reicht ein direkter Lesezugriff — kein
// Eingriff in fetch/XHR noetig. Der Token verlaesst den Browser nicht.
//
// Die Ablage ist bewusst Klartext: chrome.storage.local ist extension-privat,
// aber einen echten Schluesselbund gibt es im Extension-Kontext nicht — jede
// "Verschluesselung" muesste den Schluessel daneben legen. Das Risiko wird
// stattdessen ueber die LEBENSDAUER begrenzt: verschwindet der JWT aus dem
// localStorage (Logout/Session-Ende), loescht syncToken() die Kopie hier;
// antwortet die Chessable-API mit 401 (Bearer serverseitig tot), loescht sie
// chessable-activity.js (clearStoredChessableToken). Früher gab es dafür einen Userscript-Spiegel
// hat kein Pendant: er liest den JWT bei Bedarf live aus dem localStorage und
// persistiert nie eine Kopie.
(function () {
  const LS_KEY = 'chessable.web.production.JWT';
  let lastStored = null;
  let geraeumt = false; // Logout schon verarbeitet — remove nicht bei jedem Fokus wiederholen

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
      return; // localStorage evtl. blockiert — Zustand unbekannt, nichts raeumen
    }
    const token = extractJwt(raw);
    if (!token) {
      // Ausgeloggter Zustand (Key weg/leer): die gespeicherte Kopie mitloeschen,
      // sonst ueberlebt der Bearer den Chessable-Logout im Extension-Storage.
      // Greift auch beim frischen Page-Load nach einer Logout-Navigation.
      if (!geraeumt) {
        geraeumt = true;
        lastStored = null;
        try { chrome.storage.local.remove('chessableToken'); } catch (e) { /* storage nicht verfuegbar — ignorieren */ }
      }
      return;
    }
    geraeumt = false;
    if (token === lastStored) return;
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
