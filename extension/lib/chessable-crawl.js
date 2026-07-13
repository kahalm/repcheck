// Reine (Node-testbare) Bausteine für den Chessable-Browser-Import (V1 passiv + V2 aktiv).
// Kein DOM/Netzwerk hier — nur URL-Klassifikation, JSON-Parsing der Chessable-Antworten und die
// Assemblierung der Ingest-Payload. Die eigentlichen fetch()/Egress-Pfade liegen in
// chessable-activity.js (Extension, isolierte Welt) bzw. im Userscript.
//
// Chessable-Kurs-Struktur (wie piratechess sie liest):
//   getCourse?uid&bid            → { course: { data: [ { id: <lid> }, … ] } }        (Kapitel-lids, in Reihenfolge)
//   getList?uid&bid&lid=<lid>    → { list: { name, title, data: [ { id: <oid>, name } ] } }  (Linien-oids je Kapitel)
//   getGame?lng=en&uid&oid=<oid> → { game: { … } }                                   (eine Linie)
// Der fetch-freie piratechess-Parser (POST /course/parse) nimmt je Kapitel die ROHE getList-Antwort
// (chapterJson) + die ROHEN getGame-Antworten (lines[]) in getList-Reihenfolge und erzeugt das PGN.

(function (root) {
  'use strict';

  // Klassifiziert eine (Chessable-)API-URL. Liefert { kind, bid?, lid?, oid? } oder null.
  function classifyChessableApi(url) {
    let u;
    try { u = new URL(url, 'https://www.chessable.com'); } catch (e) { return null; }
    if (!/(^|\.)chessable\.com$/i.test(u.hostname)) return null;
    const p = u.pathname.replace(/\/+$/, '');
    if (p.endsWith('/api/v1/getCourse')) return { kind: 'course', bid: u.searchParams.get('bid') };
    if (p.endsWith('/api/v1/getList')) return { kind: 'list', bid: u.searchParams.get('bid'), lid: u.searchParams.get('lid') };
    if (p.endsWith('/api/v1/getGame')) return { kind: 'game', oid: u.searchParams.get('oid') };
    return null;
  }

  // Kapitel-lids aus einer getCourse-Antwort (roher Text oder Objekt), in Reihenfolge.
  function parseChapterLids(courseJson) {
    let obj;
    try { obj = typeof courseJson === 'string' ? JSON.parse(courseJson) : courseJson; } catch (e) { return []; }
    const data = obj && (obj.course || obj.Course) && (obj.course || obj.Course).data;
    const arr = data || (obj && (obj.Course) && obj.Course.Data);
    if (!Array.isArray(arr)) return [];
    return arr.map(c => (c && (c.id != null ? c.id : c.Id))).filter(v => v != null).map(String);
  }

  // Linien-oids aus einer getList-Antwort (roher Text oder Objekt), in Reihenfolge.
  function parseLineOids(listJson) {
    let obj;
    try { obj = typeof listJson === 'string' ? JSON.parse(listJson) : listJson; } catch (e) { return []; }
    const list = obj && (obj.list || obj.List);
    const arr = list && (list.data || list.Data);
    if (!Array.isArray(arr)) return [];
    return arr.map(l => (l && (l.id != null ? l.id : l.Id))).filter(v => v != null).map(String);
  }

  // Assembliert die Ingest-Kapitel für POST /api/extension/chessable/ingest aus einer geordneten
  // Struktur [{ listText, games: { <oid>: <gameText> } }] — nur Kapitel mit ≥1 vorhandenen Linie,
  // Linien in getList-Reihenfolge, fehlende (nicht erfasste) oids werden ausgelassen.
  function buildIngestChapters(chapters) {
    const out = [];
    for (const ch of (chapters || [])) {
      if (!ch || typeof ch.listText !== 'string') continue;
      const oids = parseLineOids(ch.listText);
      const lines = [];
      for (const oid of oids) {
        const g = ch.games && ch.games[oid];
        if (typeof g === 'string' && g.trim() && g.trim() !== '{}') lines.push(g);
      }
      if (lines.length > 0) out.push({ chapterJson: ch.listText, lines });
    }
    return out;
  }

  const api = { classifyChessableApi, parseChapterLids, parseLineOids, buildIngestChapters };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RepCheckCrawl = api;
})(typeof self !== 'undefined' ? self : this);
