// MAIN-World-Content-Script auf chessable.com: passiver Mitschnitt der Chessable-Kurs-API (V1).
//
// Warum MAIN-World: die Chessable-SPA ruft ihre eigene API mit window.fetch/XMLHttpRequest im
// Seiten-Kontext auf. In der isolierten Content-Script-Welt ist das ein ANDERES fetch/XHR — die
// SPA-Antworten sind dort nicht abfangbar. Daher patchen wir hier (MAIN) window.fetch + XHR und
// reichen die ROHEN getCourse/getList/getGame-Antworten per postMessage an die isolierte
// chessable-activity.js weiter (die puffert sie und sendet sie — mit Token/Config/Egress — an RookHub).
//
// Sicherheit/Privacy: NUR die drei Kurs-Daten-Endpoints werden weitergereicht (kein getHomeData,
// keine Auth-Antworten). Kein Egress + KEIN Token hier — der Token bleibt in der isolierten Welt.
// Bridge same-origin (postMessage an location.origin); Empfänger prüft source+origin.
(function () {
  'use strict';
  if (window.__repcheckChessableCapture) return;
  window.__repcheckChessableCapture = true;

  // Nur die Kurs-Struktur-Endpoints (nicht getHomeData/authenticate/…). Klassifikation macht die
  // isolierte Seite über die geteilte lib — hier nur ein billiger Vorfilter.
  const RELEVANT = /\/api\/v1\/(getCourse|getList|getGame)(\?|$)/;

  function forward(url, body) {
    if (typeof body !== 'string' || !body) return;
    // Übergroße Antworten kappen wir NICHT (das PGN muss vollständig sein), aber ganz leere/`{}`
    // reichen wir gar nicht erst weiter.
    if (body.trim() === '' || body.trim() === '{}') return;
    try {
      window.postMessage({ __repcheck: 'chessable-capture', url: String(url), body }, location.origin);
    } catch (e) { /* ignore */ }
  }

  // ---- fetch patchen ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        let url = '';
        const a0 = args[0];
        url = (a0 && typeof a0 === 'object' && 'url' in a0) ? a0.url : String(a0 || '');
        if (RELEVANT.test(url)) {
          p.then((resp) => {
            try { resp.clone().text().then((t) => forward(url, t)).catch(() => {}); } catch (e) {}
          }).catch(() => {});
        }
      } catch (e) { /* never break the page */ }
      return p;
    };
  }

  // ---- XMLHttpRequest patchen ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      try { this.__repcheckUrl = String(url || ''); } catch (e) {}
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      try {
        const url = this.__repcheckUrl || '';
        if (RELEVANT.test(url)) {
          this.addEventListener('load', function () {
            try {
              const t = (this.responseType === '' || this.responseType === 'text') ? this.responseText
                : (this.responseType === 'json' ? JSON.stringify(this.response) : null);
              if (t) forward(url, t);
            } catch (e) {}
          });
        }
      } catch (e) {}
      return origSend.apply(this, args);
    };
  }
})();
