// Reine (Node-testbare) Bausteine für den Chessable-Browser-Import (V1 passiv + V2 aktiv).
// Kein DOM/Netzwerk hier — nur URL-Klassifikation, JSON-Parsing der Chessable-Antworten und die
// Assemblierung der Ingest-Payload. Die eigentlichen fetch()/Egress-Pfade liegen in
// chessable-activity.js (Extension, isolierte Welt).
//
// Chessable-Kurs-Struktur (wie piratechess sie liest):
//   getCourse?uid&bid            → { course: { data: [ { id: <lid> }, … ] } }        (Kapitel-lids, in Reihenfolge)
//   getList?uid&bid&lid=<lid>    → { list: { name, title, data: [ { id: <oid>, name } ] } }  (Linien-oids je Kapitel)
//   getGame?lng=en&uid&oid=<oid> → { game: { … } }                                   (eine Linie)
//   getReview?uid&bid&lid&oid    → { lesson: { moves: […] }, … }                      (eine trainierte Linie)
// Der fetch-freie piratechess-Parser (POST /course/parse) nimmt je Kapitel die ROHE getList-Antwort
// (chapterJson) + die ROHEN getGame-Antworten (lines[]) in getList-Reihenfolge und erzeugt das PGN.
// getReview ist der TRAININGS-Endpoint (ein Call pro trainierter Linie, mit voller Zugfolge +
// Alternativen + Kommentaren + Pfeilen) — sein Roh-JSON wird parallel zu getGame an RookHub geschickt
// und dort als Lücken-Füller abgelegt (POST /api/extension/chessable/review-lines).

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
    if (p.endsWith('/api/v1/getReview')) return { kind: 'review', bid: u.searchParams.get('bid'), oid: u.searchParams.get('oid') };
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

  // Kursname aus einer getGame-Antwort (roher Text oder Objekt): Chessable schreibt ihn in JEDE Linie
  // (game.name), wo die getCourse-Antwort nur Kapitel-Ids traegt. Die verlaesslichste Quelle nach der
  // Kursliste per Token — und die einzige, die auch fuer Kurse greift, die nicht im eigenen Konto liegen
  // (2026-09-19: ein freier „Short & Sweet"-Kurs bekam sonst den Kacheltext samt Fortschrittsbadges als Namen).
  function parseCourseNameFromGame(gameJson) {
    let obj;
    try { obj = typeof gameJson === 'string' ? JSON.parse(gameJson) : gameJson; } catch (e) { return null; }
    const game = obj && (obj.game || obj.Game);
    const name = game && (game.name != null ? game.name : game.Name);
    const t = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    return t ? t.slice(0, 200) : null;
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
      // lineOids parallel zu lines: der Server ordnet die Linien über ihre oid zu. Ohne sie las der Parser
      // positionsbasiert, und ein Teil der Linien eines Kapitels landete unter fremder oid.
      const lines = [];
      const lineOids = [];
      for (const oid of oids) {
        const g = ch.games && ch.games[oid];
        if (typeof g === 'string' && g.trim() && g.trim() !== '{}') { lines.push(g); lineOids.push(String(oid)); }
      }
      if (lines.length > 0) out.push({ chapterJson: ch.listText, lines, lineOids });
    }
    return out;
  }

  // Ingest-Anfragen in Portionen schneiden (v1.59.1). Eine Anfrage je Import konnte am Proxy scheitern: RookHubs
  // Frontend-nginx deckelte /api/ auf 15 MB, und Linien kommentierter Kurse sind entpackt ~0,5 MB groß — ein
  // Mitschnitt von 30 Linien bekam 413 (gemeldet 2026-09-14). Geschnitten wird nach UTF-8-Bytes der späteren
  // JSON-Payload; ein zu großes Kapitel wird auf mehrere Teile mit derselben chapterJson verteilt. Das geht nur mit
  // lineOids (der Server ordnet die Linien über ihre oid zu) — ohne sie bleibt ein Kapitel ganz. Eine einzelne Linie
  // über dem Deckel wandert allein, kleiner lässt sie sich nicht machen.
  const INGEST_BATCH_BYTES = 8 * 1024 * 1024;
  const INGEST_ENVELOPE_BYTES = 2048;   // bid, target, courseName, Klammern

  function utf8Bytes(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    return unescape(encodeURIComponent(s)).length;
  }

  function splitIngestChapters(chapters, maxBytes) {
    const limit = maxBytes > 0 ? maxBytes : INGEST_BATCH_BYTES;
    const batches = [];
    let cur = [];
    let curBytes = INGEST_ENVELOPE_BYTES;
    const flush = () => {
      if (cur.length) batches.push(cur);
      cur = [];
      curBytes = INGEST_ENVELOPE_BYTES;
    };
    for (const ch of (chapters || [])) {
      if (!ch) continue;
      const lines = Array.isArray(ch.lines) ? ch.lines : [];
      const lineOids = Array.isArray(ch.lineOids) && ch.lineOids.length === lines.length ? ch.lineOids : null;
      if (!lineOids) {
        const whole = utf8Bytes(JSON.stringify(ch)) + 8;
        if (cur.length && curBytes + whole > limit) flush();
        cur.push(ch);
        curBytes += whole;
        continue;
      }
      const headBytes = utf8Bytes(JSON.stringify(ch.chapterJson == null ? null : ch.chapterJson)) + 64;
      let part = null;
      for (let i = 0; i < lines.length; i++) {
        const lineBytes = utf8Bytes(JSON.stringify(lines[i] == null ? null : lines[i])) + utf8Bytes(JSON.stringify(lineOids[i])) + 4;
        if (!part || curBytes + lineBytes > limit) {
          if (part || (cur.length && curBytes + headBytes + lineBytes > limit)) flush();
          part = { chapterJson: ch.chapterJson, lines: [], lineOids: [] };
          cur.push(part);
          curBytes += headBytes;
        }
        part.lines.push(lines[i]);
        part.lineOids.push(lineOids[i]);
        curBytes += lineBytes;
      }
    }
    flush();
    return batches;
  }

  // Kapitel→oids aus einer getCourse?includeVariations=true-Antwort (course.data[].variations[].oid).
  // Für die Fortschritts-Overlays: liefert je Kapitel (lid) die Linien-oids + die Gesamtliste. EIN
  // getCourse-Call genügt für Kurs-/Kapitel-Nenner + alle oids (kein getList je Kapitel nötig).
  function parseCourseVariations(courseJson) {
    let obj;
    try { obj = typeof courseJson === 'string' ? JSON.parse(courseJson) : courseJson; } catch (e) { return { chapters: [], allOids: [] }; }
    const course = obj && (obj.course || obj.Course);
    const data = course && (course.data || course.Data);
    const chapters = []; const allOids = [];
    if (Array.isArray(data)) {
      for (const c of data) {
        const lid = c && (c.id != null ? c.id : c.Id);
        const vars = c && (c.variations || c.Variations);
        const oids = Array.isArray(vars)
          ? vars.map(v => v && (v.oid != null ? v.oid : v.Oid)).filter(x => x != null).map(String)
          : [];
        chapters.push({ lid: lid != null ? String(lid) : null, oids });
        for (const o of oids) allOids.push(o);
      }
    }
    return { chapters, allOids };
  }

  // Kurs-/Kapitel-Fortschrittszahlen aus Struktur + importierter oid-Menge (rein, für Anzeige/Tests).
  function progressCounts(chapters, importedOids) {
    const set = importedOids instanceof Set ? importedOids : new Set(importedOids || []);
    const perChapter = (chapters || []).map(ch => ({
      lid: ch.lid,
      total: ch.oids.length,
      done: ch.oids.reduce((n, o) => n + (set.has(String(o)) ? 1 : 0), 0),
    }));
    const total = perChapter.reduce((n, c) => n + c.total, 0);
    const done = perChapter.reduce((n, c) => n + c.done, 0);
    return { total, done, perChapter };
  }

  // Pause zwischen zwei Chessable-Abrufen beim aktiven Kurs-Holen — zufällig in [minMs, maxMs], damit
  // der Takt nicht maschinell gleichmäßig ist. Der Standard ist zugleich die UNTERGRENZE: der Bereich
  // lässt sich nur nach oben verschieben (langsamer schont das eigene Chessable-Konto), nie schneller.
  const CRAWL_DELAY_DEFAULT = Object.freeze({ minMs: 2500, maxMs: 3500 });
  const CRAWL_DELAY_CEILING_MS = 120000;   // Tippfehler-Deckel („3000" statt „3" Sekunden)

  // Macht aus einer gespeicherten/getippten Einstellung einen gültigen Bereich: fehlende oder
  // unbrauchbare Werte → Standard, zu kleine → auf die Untergrenze angehoben, max ≥ min.
  function normalizeCrawlDelay(raw) {
    const zahl = (v) => (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v) : null;
    let min = zahl(raw && raw.minMs);
    let max = zahl(raw && raw.maxMs);
    if (min == null) min = CRAWL_DELAY_DEFAULT.minMs;
    if (max == null) max = CRAWL_DELAY_DEFAULT.maxMs;
    min = Math.min(CRAWL_DELAY_CEILING_MS, Math.max(CRAWL_DELAY_DEFAULT.minMs, min));
    max = Math.min(CRAWL_DELAY_CEILING_MS, Math.max(CRAWL_DELAY_DEFAULT.maxMs, min, max));
    return { minMs: min, maxMs: max };
  }

  // Würfelt eine Pause (ganze ms, beide Grenzen eingeschlossen). `rnd` nur für Tests.
  function pickCrawlDelayMs(cfg, rnd) {
    const { minMs, maxMs } = normalizeCrawlDelay(cfg);
    const r = typeof rnd === 'function' ? rnd() : Math.random();
    const anteil = Math.min(1, Math.max(0, Number.isFinite(r) ? r : 0));
    return Math.min(maxMs, minMs + Math.floor(anteil * (maxMs - minMs + 1)));
  }

  // Gemerkte Kursstrukturen (bid → { at, chapters }) deckeln: nur die `max` zuletzt aktualisierten behalten.
  function pruneStructures(map, max) {
    const entries = Object.entries(map || {}).filter(([, v]) => v && Array.isArray(v.chapters));
    if (entries.length <= max) return Object.fromEntries(entries);
    entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    return Object.fromEntries(entries.slice(0, max));
  }

  // ---- Unerwartete Chessable-Antworten beim „Kurs holen" (v1.60.0) ----
  // Liefert Chessable nicht die erwartete Form, bricht der Crawl ab statt weiterzuholen: dahinter kann eine
  // Anti-Crawling-Maßnahme stecken, und die soll sich der Entwickler ansehen, bevor jemand erneut holt. Anlass: zu
  // 31 Linien kam am 30.06.2026 nur {"error":{"message":"User is banned or deleted"}} zurück — der Server-Abruf hielt
  // das für eine Linie, und sie lagen monatelang als „gecacht" im geteilten Linien-Cache.
  const UNEXPECTED_SNIPPET_CHARS = 1000;
  const UNEXPECTED_MESSAGE_CHARS = 300;
  // Dieselbe Wortliste prüft RookHub (ChessableResponseAlertService.LooksBanned) — dort entscheidet sie über die
  // Admin-Nachricht, hier nur über den Hinweis im Browser. Nur gemeinsam ändern.
  const BAN_PATTERN = /\b(banned|suspended|blocked|deleted)\b/i;

  // Sieht die Antwort nach einer Sperre aus? In einer JSON-Antwort zählt allein die Fehlermeldung (Kursinhalte dürfen
  // „deleted" enthalten); ohne Fehlermeldung nur ein Ausschnitt, der kein JSON ist — eine Sperrseite.
  function looksBanned(message, snippet) {
    if (message && String(message).trim()) return BAN_PATTERN.test(String(message));
    const s = String(snippet == null ? '' : snippet);
    return !/^\s*[[{]/.test(s) && BAN_PATTERN.test(s);
  }

  // Ausschnitt für die Meldung an RookHub: gekürzt, ohne E-Mail- und IP-Adressen (eine Cloudflare-Sperrseite nennt
  // die IP des Nutzers). Uhrzeiten wie 08:56:57 bleiben stehen — die IPv6-Regel verlangt mindestens vier Gruppen.
  function scrubSnippet(text) {
    return String(text == null ? '' : text)
      .slice(0, UNEXPECTED_SNIPPET_CHARS * 4)
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
      .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}\b/gi, '[ip]')
      .slice(0, UNEXPECTED_SNIPPET_CHARS);
  }

  // Fehlermeldung einer JSON-Antwort: {"error":{"message":"…"}} oder {"error":"…"}; sonst null.
  function chessableErrorMessage(obj) {
    const err = obj.error != null ? obj.error : obj.Error;
    if (err == null || err === false || err === '') return null;
    if (typeof err === 'string') return err;
    if (typeof err === 'object') {
      const m = err.message != null ? err.message : err.Message;
      if (m != null && m !== '') return String(m);
    }
    return JSON.stringify(err);
  }

  function hasExpectedShape(kind, obj) {
    if (kind === 'course') { const c = obj.course || obj.Course; return !!c && Array.isArray(c.data || c.Data); }
    if (kind === 'list') { const l = obj.list || obj.List; return !!l && Array.isArray(l.data || l.Data); }
    if (kind === 'game') { const g = obj.game || obj.Game; return !!g && typeof g === 'object'; }
    return true;
  }

  // Prüft eine Antwort beim „Kurs holen". kind: 'course' | 'list' | 'game'; status: HTTP-Status (fehlt = 200).
  // null = in Ordnung. Sonst { reason, status, message, banned, snippet } mit reason
  //   http  — kein 2xx (auch nach den Wiederholungen bei 429/5xx),
  //   json  — kein JSON (z. B. eine HTML-Sperrseite),
  //   error — Chessable meldet einen Fehler statt der Daten,
  //   shape — JSON ohne das erwartete Feld (course.data / list.data / game), auch das leere {}.
  // Eine Antwort MIT dem erwarteten Feld gilt als in Ordnung, auch wenn daneben ein error-Feld steht.
  function checkChessableResponse(kind, text, status) {
    const code = status == null ? 200 : Number(status);
    const raw = text == null ? '' : String(text);
    let obj = null, parsed = false;
    try { obj = JSON.parse(raw); parsed = true; } catch (e) { /* kein JSON */ }
    const isObj = parsed && obj !== null && typeof obj === 'object' && !Array.isArray(obj);
    const ok2xx = code >= 200 && code < 300;
    if (ok2xx && isObj && hasExpectedShape(kind, obj)) return null;
    const found = isObj ? chessableErrorMessage(obj) : null;
    const message = found ? found.slice(0, UNEXPECTED_MESSAGE_CHARS) : null;
    const snippet = scrubSnippet(raw);
    return {
      reason: !ok2xx ? 'http' : !parsed ? 'json' : message ? 'error' : 'shape',
      status: code,
      message,
      banned: looksBanned(message, snippet),
      snippet,
    };
  }

  const api = { classifyChessableApi, parseChapterLids, parseLineOids, parseCourseNameFromGame, buildIngestChapters, parseCourseVariations, progressCounts,
    pruneStructures, splitIngestChapters, INGEST_BATCH_BYTES,
    checkChessableResponse, looksBanned, scrubSnippet, UNEXPECTED_SNIPPET_CHARS,
    CRAWL_DELAY_DEFAULT, normalizeCrawlDelay, pickCrawlDelayMs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RepCheckCrawl = api;
})(typeof self !== 'undefined' ? self : this);
