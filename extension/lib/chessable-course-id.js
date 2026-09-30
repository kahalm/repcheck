'use strict';
// Kurs-ID der aktuellen chessable.com-Seite — EINE Quelle für beide Welten: per manifest.json VOR
// chessable-activity.js (isolierte Welt) UND vor chessable-fen.js (MAIN-World) geladen, beide holen
// sich die Funktionen über `self.RepCheckCourseId`. In der MAIN-World landet nur dieser eine Name im
// `window` der Seite (IIFE).
//
// Bis v1.68.13 hatte jede Datei ihre eigene Fassung, in verschiedener Reihenfolge: chessable-activity.js
// nahm die Bridge-ID, dann die URL, dann den ERSTEN Kurs-Link im Dokument; chessable-fen.js nahm den
// Link sogar VOR dem React-Fiber. Auf der Startseite (Kurskarten verlinken /course/{bid}) meldete
// importState damit onCourse=true für die erste Karte, und „Kurs holen" startete nach der
// Bannrisiko-Bestätigung einen Crawl für einen Kurs, den niemand gewählt hatte (S1-012).

(function (root) {
  // Seiten, auf denen es EINEN aktuellen Kurs gibt (Übersicht, Kapitel, Practice, Learn).
  const COURSE_PAGE_RE = /^\/(?:course|practice|learn)\/\d+/;
  const URL_ID_RE = /\/courses?\/(\d+)(?:\/|$)/;
  const LINK_ID_RE = /\/course\/(\d+)(?:\/|$)/;
  const isId = (v) => v != null && /^\d+$/.test(String(v));

  // Reihenfolge URL > Fiber > Link. `fiberId` und `links` dürfen Funktionen sein — sie laufen nur,
  // wenn die stärkere Quelle nichts liefert (der Fiber-Lauf und die Link-Suche kosten DOM-Arbeit).
  // `links`: Liste von href-Werten. Liefert { id, source } mit source 'url' | 'fiber' | 'link' | null.
  function resolveCourseId({ pathname, fiberId, links } = {}) {
    const m = URL_ID_RE.exec(String(pathname || ''));
    if (m) return { id: m[1], source: 'url' };
    const fiber = typeof fiberId === 'function' ? fiberId() : fiberId;
    if (isId(fiber)) return { id: String(fiber), source: 'fiber' };
    const hrefs = typeof links === 'function' ? links() : links;
    for (const href of hrefs || []) {
      const lm = LINK_ID_RE.exec(String(href || ''));
      if (lm) return { id: lm[1], source: 'link' };
    }
    return { id: null, source: null };
  }

  // Hat die Seite EINEN aktuellen Kurs? Kursseite laut Pfad, oder die ID stammt aus URL bzw. React-Fiber.
  // Eine nur über einen Link geratene ID (Startseite: erste Kurskarte, Dropdown-Menüs) zählt nicht.
  function isOnCourse(pathname, source) {
    return COURSE_PAGE_RE.test(String(pathname || '')) || source === 'url' || source === 'fiber';
  }

  const api = { COURSE_PAGE_RE, resolveCourseId, isOnCourse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RepCheckCourseId = api;
})(typeof self !== 'undefined' ? self : this);
