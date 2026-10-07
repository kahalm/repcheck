'use strict';

// Ingest in Portionen (v1.59.1): Ein Mitschnitt von ~30 Linien eines kommentierten Kurses (entpackt ~470 KB je
// Linie) ging bisher in EINER Anfrage raus und bekam am Proxy 413 (gemeldet 2026-09-14). splitIngestChapters
// schneidet nach UTF-8-Bytes und verteilt ein zu großes Kapitel auf mehrere Teile mit derselben chapterJson.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { splitIngestChapters, INGEST_BATCH_BYTES } = require('../extension/lib/chessable-crawl.js');

const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const linie = (oid, kb, fill = 'x') => JSON.stringify({ game: { id: oid, text: fill.repeat(kb * 1024) } });
const kapitel = (lid, oids, kb) => ({
  chapterJson: JSON.stringify({ list: { id: lid, data: oids.map((o) => ({ id: o })) } }),
  lines: oids.map((o) => linie(o, kb)),
  lineOids: oids.map(String),
});
const alleOids = (batches) => batches.flatMap((b) => b.flatMap((c) => c.lineOids));

test('Deckel liegt deutlich unter dem alten 15-MB-Proxylimit und dem 16-MB-Live-Limit der API', () => {
  assert.ok(INGEST_BATCH_BYTES <= 8 * 1024 * 1024);
});

test('ein kleiner Import bleibt EINE Anfrage mit unveränderten Kapiteln', () => {
  const chapters = [kapitel(1, [11, 12], 2), kapitel(2, [21], 2)];
  const batches = splitIngestChapters(chapters);
  assert.strictEqual(batches.length, 1);
  assert.deepStrictEqual(batches[0].map((c) => c.lineOids), [['11', '12'], ['21']]);
  assert.deepStrictEqual(batches[0].map((c) => c.lines), chapters.map((c) => c.lines));
});

test('Felix-Fall: 30 Linien à 470 KB → mehrere Portionen, jede unter dem Deckel, nichts geht verloren', () => {
  const oids = Array.from({ length: 30 }, (_, i) => 1000 + i);
  const chapters = [kapitel(7, oids.slice(0, 18), 470), kapitel(8, oids.slice(18), 470)];
  const batches = splitIngestChapters(chapters);
  assert.ok(batches.length >= 2, `nur ${batches.length} Portion(en)`);
  for (const b of batches) {
    assert.ok(bytes({ bid: '107621', target: 'repertoire', courseName: 'Attacking Repertoire', chapters: b }) <= INGEST_BATCH_BYTES,
      'eine Portion liegt über dem Deckel');
  }
  assert.deepStrictEqual(alleOids(batches), oids.map(String), 'Reihenfolge oder Linien verändert');
});

test('ein zu großes Kapitel wird geteilt: jeder Teil trägt dieselbe chapterJson, lines und lineOids bleiben gepaart', () => {
  const ch = kapitel(3, Array.from({ length: 12 }, (_, i) => 300 + i), 900);
  const batches = splitIngestChapters([ch], 4 * 1024 * 1024);
  const teile = batches.flat();
  assert.ok(teile.length >= 3);
  for (const t of teile) {
    assert.strictEqual(t.chapterJson, ch.chapterJson);
    assert.strictEqual(t.lines.length, t.lineOids.length);
    t.lines.forEach((l, i) => assert.strictEqual(JSON.parse(l).game.id, Number(t.lineOids[i])));
  }
  assert.deepStrictEqual(teile.flatMap((t) => t.lineOids), ch.lineOids);
});

test('Linien aus dem geteilten Cache (null) kosten fast nichts — 325 davon passen in eine Portion', () => {
  const oids = Array.from({ length: 325 }, (_, i) => 5000 + i);
  const ch = { chapterJson: JSON.stringify({ list: { data: [] } }), lines: oids.map(() => null), lineOids: oids.map(String) };
  const batches = splitIngestChapters([ch]);
  assert.strictEqual(batches.length, 1);
  assert.strictEqual(batches[0][0].lines.length, 325);
});

test('eine einzelne Linie über dem Deckel wandert allein statt verloren zu gehen', () => {
  const chapters = [kapitel(1, [1], 10), kapitel(2, [2], 200), kapitel(3, [3], 10)];
  const batches = splitIngestChapters(chapters, 100 * 1024);
  assert.deepStrictEqual(batches.map((b) => b.flatMap((c) => c.lineOids)), [['1'], ['2'], ['3']]);
});

test('Kapitel ohne passende lineOids werden nie geteilt (der Server würde positionsbasiert falsch zuordnen)', () => {
  const ohne = { chapterJson: '{"list":{}}', lines: [linie(1, 300), linie(2, 300), linie(3, 300)] };
  const batches = splitIngestChapters([ohne, kapitel(9, [91], 300)], 500 * 1024);
  const ganz = batches.flat().find((c) => c === ohne);
  assert.ok(ganz, 'Kapitel ohne lineOids wurde verändert');
  assert.strictEqual(ganz.lines.length, 3);
});

test('gezählt wird in UTF-8-Bytes, nicht in Zeichen (Kommentare mit Umlauten)', () => {
  const oids = Array.from({ length: 10 }, (_, i) => i + 1);
  const ch = { chapterJson: '{}', lines: oids.map((o) => linie(o, 100, 'ä')), lineOids: oids.map(String) };
  for (const b of splitIngestChapters([ch], 1024 * 1024)) {
    assert.ok(bytes({ chapters: b }) <= 1024 * 1024, 'Portion in Bytes über dem Deckel');
  }
});

test('Extension: Mitschnitt, „Kurs holen" und Live-Anhängen schicken über die Portionierung', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'chessable-activity.js'), 'utf8');
  assert.match(src, /const parts = Crawl\.splitIngestChapters\(chapters\);\s+const courseName = bestCourseName\(bid\);/);
  assert.match(src, /await ingestLiveInParts\(bid, target, bestCourseName\(bid\), batch, onPart\)/);
  assert.match(src, /await ingestLiveInParts\(bid, importTarget, bestCourseName\(bid\), chapters\)/);
  assert.doesNotMatch(src, /await ingest\(bid, chapters, target/, 'Mitschnitt geht noch in einer Anfrage raus');
  assert.doesNotMatch(src, /await ingestLive\(bid, target, courseName, newChapters\)/, '„Kurs holen" geht noch in einer Anfrage raus');
});

// ─── v1.59.2: Rückmeldung beim „Kurs holen" ─────────────────────────────

function ladeIngestLiveInParts(antworten) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'chessable-activity.js'), 'utf8');
  const von = src.indexOf('  async function ingestLiveInParts(');
  const bis = src.indexOf('  async function flushLive() {', von);
  assert.ok(von >= 0 && bis > von, 'ingestLiveInParts nicht gefunden');
  const aufrufe = [];
  const Crawl = { splitIngestChapters: (ch) => ch.map((c) => [c]) };   // je Kapitel eine Portion
  const ingestLive = async (bid, target, name, part) => { aufrufe.push(part); return antworten[aufrufe.length - 1]; };
  const fn = new Function('Crawl', 'ingestLive', src.slice(von, bis) + '\nreturn ingestLiveInParts;')(Crawl, ingestLive);
  return { fn, aufrufe };
}

test('ingestLiveInParts zählt neu angehängte UND verknüpfte Linien über alle Portionen', async () => {
  // Kurs 207313 am 2026-09-15: drei Portionen, 0 angehängt, 641 Alt-Linien bekamen ihre oid — die Meldung sagte „0".
  const { fn, aufrufe } = ladeIngestLiveInParts([{ imported: 0, linked: 200 }, { imported: 1, linked: 241 }, { imported: 0, linked: 200 }]);
  const res = await fn('207313', 'repertoire', 'Kurs', [{}, {}, {}]);
  assert.strictEqual(aufrufe.length, 3);
  assert.deepStrictEqual(res, { imported: 1, linked: 641, parts: 3 });
});

test('ingestLiveInParts: ältere RookHub-Versionen ohne linked-Feld zählen als 0', async () => {
  const { fn } = ladeIngestLiveInParts([{ imported: 2 }, null]);
  assert.deepStrictEqual(await fn('1', 'repertoire', 'K', [{}, {}]), { imported: 2, linked: 0, parts: 2 });
});

test('„Kurs holen" zählt die Kapitellisten mit und nennt verknüpfte Linien in der Abschlussmeldung', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'chessable-activity.js'), 'utf8');
  assert.match(src, /setStatus\(t\('import\.fetchingChapters', \{ done: li \+ 1, total: lids\.length \}\)\)/);
  assert.match(src, /res\.linked \? fertig \+ ' ' \+ t\('import\.linkedNote', \{ count: res\.linked \}\) : fertig/);
});

// ─── S1-006: „Kurs holen" (Repertoire) verwirft bei einem Abbruch nichts mehr ─────────────────
// Bis v1.68.2 sammelte das Repertoire-Ziel alle Linien und schickte sie erst am Ende; nur eine unerwartete
// Chessable-Antwort sicherte die Teilmenge. Stopp, Chessable-401 oder ein Netzfehler nach 1200 von 1881 Linien
// (~1 h Pause) verwarfen alles, ein geschlossener Tab ebenso — der nächste Lauf holte alles erneut bei Chessable.

// Kurs 4711: Kapitel 1 mit den Linien 11–13, Kapitel 2 mit 21–22.
const KURS = { 1: ['11', '12', '13'], 2: ['21', '22'] };

// beimAnhaengen(nr, oids) läuft vor jedem ingestLiveInParts-Aufruf (nr ab 1); wirft es, scheitert dieser Anhang.
function ladeCrawl({ target = 'repertoire', everyMs = 60000, bookEveryMs = 60000, beiGame, kurs = KURS, beimAnhaengen, beimChunk, cache = new Map() } = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'chessable-activity.js'), 'utf8');
  const von = src.indexOf('  async function crawlAndImport(');
  const bis = src.indexOf('  // V1: nur den passiven Mitschnitt', von);
  assert.ok(von >= 0 && bis > von, 'crawlAndImport nicht gefunden');
  const log = { ablauf: [], status: [], angehaengt: [], unerwartet: [], chunks: 0, anhaengen: 0, teile: [], abrufe: [], berichte: [] };
  let api;
  const deps = {
    Crawl: require('../extension/lib/chessable-crawl.js'),
    t: (k, p) => (p ? k + ' ' + JSON.stringify(p) : k),
    pageCourseId: () => '4711',
    newSessionId: () => 'sitzung',
    fetchImportedOids: async () => ({ oids: [] }),
    setStatus: (s) => log.status.push(s),
    cap: { bid: null, courseText: null, lists: {}, games: {}, oidToLid: {} },
    chessableGetChecked: async (p) => {
      log.abrufe.push(p.split('?')[0]);
      if (p.startsWith('getCourse')) return JSON.stringify({ course: { data: Object.keys(kurs).map((id) => ({ id: Number(id) })) } });
      if (p.startsWith('getList')) {
        const lid = /lid=(\d+)/.exec(p)[1];
        return JSON.stringify({ list: { id: Number(lid), data: kurs[lid].map((o) => ({ id: Number(o) })) } });
      }
      const oid = /oid=(\d+)/.exec(p)[1];
      log.ablauf.push('hole ' + oid);
      if (beiGame) beiGame(oid, api);
      return JSON.stringify({ game: { id: Number(oid) } });
    },
    harvestFromList: () => {},
    harvestFromGame: () => {},
    sleep: async () => {},
    crawlPauseMs: () => 0,
    bestCourseName: () => 'Kurs 4711',
    ensureProgress: () => {},
    fetchSharedCachedOids: async () => new Set(),
    ingestChunk: async (sid, bid, tgt, name, chapter, final, extra) => {
      log.chunks++;
      if (beimChunk) beimChunk(log.chunks, chapter, extra);
      log.teile.push(chapter ? { oids: chapter.lineOids.slice(), key: extra && extra.chapterKey }
        : { final: true, aborted: !!(extra && extra.aborted) });
      if (chapter) log.ablauf.push('teil ' + chapter.lineOids.join(','));
      return { imported: 0, chapters: 0 };
    },
    ingestLiveInParts: async (bid, tgt, name, chapters) => {
      const oids = chapters.flatMap((c) => c.lineOids);
      chapters.forEach((c) => assert.strictEqual(c.lines.length, c.lineOids.length, 'lines/lineOids nicht gepaart'));
      const nr = ++log.anhaengen;
      try {
        if (beimAnhaengen) beimAnhaengen(nr, oids);
      } catch (e) {
        log.ablauf.push('scheitert ' + oids.join(','));
        throw e;
      }
      log.ablauf.push('anhängen ' + oids.join(','));
      log.angehaengt.push(...oids);
      return { imported: oids.length, linked: 0, parts: 1 };
    },
    markCourseFetched: () => {},
    handleUnexpected: async (bid, u, saved) => { log.unerwartet.push({ u, saved }); },
    reportCrawlError: (bid, tgt, lauf, message) => { log.berichte.push({ bid, tgt, phase: lauf.phase, fetched: lauf.fetched, sent: lauf.sent, message }); },
    showNotOwned: () => 'nicht im Konto',
    REPERTOIRE_APPEND_EVERY_MS: everyMs,
    BOOK_PART_EVERY_MS: bookEveryMs,
    listCacheGet: async (k) => (cache.has(k) ? cache.get(k) : null),
    listCachePut: async (k, v) => { cache.set(k, v); },
    REPERTOIRE_APPEND_MAX_FAILS: 2,
    REPERTOIRE_APPEND_RETRY_MS: 0,
  };
  const namen = Object.keys(deps);
  const rumpf = 'let crawling = false, crawlStartedAt = null, cancelRequested = false;\n' + src.slice(von, bis)
    + '\nreturn { crawlAndImport, cancel: () => { cancelRequested = true; } };';
  api = new Function(...namen, rumpf)(...namen.map((n) => deps[n]));
  return { crawl: () => api.crawlAndImport(target), log };
}

test('S1-006: Stopp mitten im Kapitel — die schon geholten Linien werden noch angehängt', async () => {
  const { crawl, log } = ladeCrawl({ beiGame: (oid, api) => { if (oid === '12') api.cancel(); } });
  await crawl();
  assert.deepStrictEqual(log.angehaengt, ['11', '12'], 'geholte Linien wurden beim Stopp verworfen');
  assert.ok(!log.ablauf.includes('hole 13'), 'nach dem Stopp weiter geholt');
  const zuletzt = log.status[log.status.length - 1];
  assert.match(zuletzt, /^import\.aborted/);
  assert.match(zuletzt, /import\.unexpected\.saved \{"count":2\}/, 'Status nennt die gesicherten Linien nicht');
});

test('S1-006: Chessable-401 (kein „unerwartet") — Teilmenge gesichert, Meldung nennt die Zahl', async () => {
  const { crawl, log } = ladeCrawl({
    beiGame: (oid) => { if (oid === '22') throw new Error('Chessable HTTP 401'); },
  });
  await crawl();
  assert.deepStrictEqual(log.angehaengt, ['11', '12', '13', '21'], 'bis zum 401 geholte Linien verworfen');
  assert.strictEqual(log.unerwartet.length, 0);
  const zuletzt = log.status[log.status.length - 1];
  assert.match(zuletzt, /^import\.error .*Chessable HTTP 401/);
  assert.match(zuletzt, /import\.unexpected\.saved \{"count":4\}/);
});

// Seit v1.70.1 auch MITTEN im Kapitel (gemeldet 07.10.2026: ein großes Kapitel lieferte eine Viertelstunde lang nichts).
// Mit Frist 0 heißt das: nach jeder Linie.
test('Repertoire: nach Ablauf der Frist wird zwischendurch angehängt, auch mitten im Kapitel', async () => {
  const { crawl, log } = ladeCrawl({ everyMs: 0 });
  await crawl();
  assert.deepStrictEqual(log.ablauf, ['hole 11', 'anhängen 11', 'hole 12', 'anhängen 12', 'hole 13', 'anhängen 13',
    'hole 21', 'anhängen 21', 'hole 22', 'anhängen 22']);
  // Die Abschlussmeldung zählt über alle Zwischen-Anhänge.
  assert.match(log.status[log.status.length - 1], /^import\.doneAppended \{"count":5\}/);
});

test('S1-006: ohne abgelaufene Schranke bleibt es EIN Anhängen am Ende', async () => {
  const { crawl, log } = ladeCrawl({ everyMs: 60 * 60 * 1000 });
  await crawl();
  assert.deepStrictEqual(log.ablauf.filter((a) => a.startsWith('anhängen')), ['anhängen 11,12,13,21,22']);
});

test('S1-006: unerwartete Antwort — die Karte zählt Zwischen-Anhang und Rest zusammen', async () => {
  const { crawl, log } = ladeCrawl({
    everyMs: 0,
    beiGame: (oid) => {
      if (oid !== '22') return;
      const e = new Error('unerwartet');
      e.unexpected = { endpoint: 'getGame', oid };
      throw e;
    },
  });
  await crawl();
  assert.deepStrictEqual(log.angehaengt, ['11', '12', '13', '21']);
  assert.deepStrictEqual(log.unerwartet.map((u) => u.saved), [4]);
});

// Buch-Ziel (v1.70.0): ein Stopp schickt die schon geholten Linien des laufenden Kapitels noch als Teil — über
// ingest/chunk mit dem chapterKey des Kapitels, nie über ingest/live —, danach schließt der Abbruch-Chunk die Sitzung.
test('Buch: ein Stopp liefert das schon Geholte des Kapitels noch ab und schließt die Sitzung', async () => {
  const { crawl, log } = ladeCrawl({ target: 'book', beiGame: (oid, api) => { if (oid === '12') api.cancel(); } });
  await crawl();
  assert.deepStrictEqual(log.angehaengt, [], 'das Buch hängt nie über ingest/live an');
  assert.deepStrictEqual(log.teile, [{ oids: ['11', '12'], key: '1' }, { final: true, aborted: true }]);
  assert.ok(!log.ablauf.includes('hole 13'), 'nach dem Stopp weiter geholt');
});

// Anlass 07.10.2026: ein Abbruch mitten im vierten Kapitel eines Taktikkurses verwarf alles schon Geholte davon.
test('Buch: ein Kapitel geht nach Ablauf der Frist in Teilen raus — alle mit demselben chapterKey', async () => {
  const { crawl, log } = ladeCrawl({ target: 'book', bookEveryMs: 0 });
  await crawl();
  const kapitel = log.teile.filter((x) => !x.final);
  assert.deepStrictEqual(kapitel.map((x) => x.oids.join(',')), ['11', '12', '13', '21', '22', '31'].slice(0, kapitel.length));
  assert.ok(kapitel.length >= 3, 'je Linie ein Teil, weil die Frist 0 ist');
  assert.deepStrictEqual([...new Set(kapitel.filter((x) => x.oids[0].startsWith('1')).map((x) => x.key))], ['1']);
  assert.ok(log.teile[log.teile.length - 1].final && !log.teile[log.teile.length - 1].aborted, 'Abschluss-Chunk fehlt');
  const alle = kapitel.flatMap((x) => x.oids);
  assert.strictEqual(new Set(alle).size, alle.length, 'eine Linie wurde doppelt geschickt');
});

test('Buch: ein Chessable-Fehler mitten im Kapitel — das schon Geholte geht noch raus, dann der Fehler', async () => {
  const { crawl, log } = ladeCrawl({ target: 'book', beiGame: (oid) => { if (oid === '13') throw new Error('Chessable HTTP 401'); } });
  await crawl();
  assert.deepStrictEqual(log.teile[0], { oids: ['11', '12'], key: '1' });
  assert.match(log.status.join(' | '), /Chessable HTTP 401/);
});

// Nacharbeit S1-006: der Zwischen-Anhang an der Kapitelgrenze stand ohne try/catch — ein einziger 502 beim Neustart
// von RookHub brach den ganzen Chessable-Lauf nach Kapitel 1 ab (Kapitel 2 und 3 wurden nie geholt).
const KURS3 = { 1: ['11', '12', '13'], 2: ['21', '22'], 3: ['31'] };
const http502 = () => Object.assign(new Error('HTTP 502'), { status: 502 });

test('S1-006: ein scheiternder Zwischen-Anhang bricht den Lauf nicht ab — der nächste Anhang holt ihn nach', async () => {
  const { crawl, log } = ladeCrawl({
    everyMs: 0, kurs: KURS3,
    beimAnhaengen: (nr) => { if (nr === 1) throw http502(); },
  });
  await crawl();
  assert.deepStrictEqual(log.ablauf, [
    'hole 11', 'scheitert 11',
    'hole 12', 'anhängen 11,12',
    'hole 13', 'anhängen 13',
    'hole 21', 'anhängen 21', 'hole 22', 'anhängen 22',
    'hole 31', 'anhängen 31',
  ]);
  assert.deepStrictEqual(log.angehaengt, ['11', '12', '13', '21', '22', '31'], 'nicht jede Linie genau einmal angehängt');
  assert.ok(!log.status.some((s) => s.startsWith('import.error')), 'Status meldet einen Fehler');
  assert.match(log.status[log.status.length - 1], /^import\.doneAppended \{"count":6\}/);
});

test('S1-006: nur Fehlschläge HINTEREINANDER zählen — ein gelungener Anhang setzt den Zähler zurück', async () => {
  const { crawl, log } = ladeCrawl({
    everyMs: 0, kurs: { 1: ['11'], 2: ['21'], 3: ['31'], 4: ['41'] },
    beimAnhaengen: (nr) => { if (nr === 1 || nr === 3) throw http502(); },
  });
  await crawl();
  assert.deepStrictEqual(log.angehaengt, ['11', '21', '31', '41']);
  assert.match(log.status[log.status.length - 1], /^import\.doneAppended \{"count":4\}/);
});

test('S1-006: RookHub dauerhaft kaputt — nach 2 Fehlschlägen hintereinander wird nicht weiter bei Chessable geholt', async () => {
  const { crawl, log } = ladeCrawl({ everyMs: 0, kurs: KURS3, beimAnhaengen: () => { throw http502(); } });
  await crawl();
  assert.ok(!log.ablauf.includes('hole 31'), 'trotz kaputtem RookHub weiter geholt');
  assert.deepStrictEqual(log.angehaengt, []);
  assert.match(log.status[log.status.length - 1], /^import\.error .*HTTP 502/);
});

test('S1-006: Token ungültig beim Zwischen-Anhang — sofort abbrechen, nicht weiter holen', async () => {
  const { crawl, log } = ladeCrawl({
    everyMs: 0, kurs: KURS3,
    beimAnhaengen: () => { throw Object.assign(new Error('err.tokenInvalid'), { status: 401, tokenInvalid: true }); },
  });
  await crawl();
  assert.ok(!log.ablauf.includes('hole 21'), 'nach „Token ungültig" weiter bei Chessable geholt');
  assert.match(log.status[log.status.length - 1], /^import\.error .*err\.tokenInvalid/);
});

test('S1-006: scheitert der Schluss-Anhang einmal, gelingt die Wiederholung — Status „fertig", nicht „Fehler"', async () => {
  const { crawl, log } = ladeCrawl({
    everyMs: 60 * 60 * 1000,
    beimAnhaengen: (nr) => { if (nr === 1) throw http502(); },
  });
  await crawl();
  assert.deepStrictEqual(log.angehaengt, ['11', '12', '13', '21', '22']);
  assert.ok(!log.status.some((s) => s.startsWith('import.error')), 'Status meldet einen Fehler, obwohl alles gespeichert ist');
  assert.match(log.status[log.status.length - 1], /^import\.doneAppended \{"count":5\}/);
});

// Gewünscht 07.10.2026: ein zweiter Versuch soll die Kapitellisten nicht wieder bei Chessable holen.
test('Kursstruktur-Cache: der zweite Lauf holt getCourse und getList nicht noch einmal — nur die Linien', async () => {
  const cache = new Map();
  const erster = ladeCrawl({ cache });
  await erster.crawl();
  assert.deepStrictEqual(erster.log.abrufe.filter((a) => a !== 'getGame'), ['getCourse', 'getList', 'getList']);
  assert.ok(cache.has('4711:course') && cache.has('4711:1') && cache.has('4711:2'));

  const zweiter = ladeCrawl({ cache });
  await zweiter.crawl();
  assert.deepStrictEqual(zweiter.log.abrufe.filter((a) => a !== 'getGame'), [], 'Struktur kam erneut von Chessable');
  assert.ok(zweiter.log.abrufe.includes('getGame'), 'die Linien selbst werden weiter geholt');
});

// Gewünscht 07.10.2026: jeder sonstige Abbruch geht an RookHub (Log + Admin-Nachricht) — Stopp und unerwartete Antwort
// haben ihren eigenen Weg und erzeugen keinen zweiten Bericht.
test('Abbruch-Bericht: ein Chessable-401 wird mit Phase und Zählern gemeldet', async () => {
  const { crawl, log } = ladeCrawl({ target: 'book', beiGame: (oid) => { if (oid === '13') throw new Error('Chessable HTTP 401'); } });
  await crawl();
  assert.strictEqual(log.berichte.length, 1);
  const b = log.berichte[0];
  assert.deepStrictEqual([b.bid, b.tgt, b.phase, b.message], ['4711', 'book', 'lines', 'Chessable HTTP 401']);
  assert.strictEqual(b.fetched, 2, 'zwei Linien waren geholt');
  assert.strictEqual(b.sent, 2, 'die Rettung hat sie noch abgeliefert');
});

test('Abbruch-Bericht: ein scheiternder Versand meldet Phase „sending"', async () => {
  const { crawl, log } = ladeCrawl({ target: 'book', bookEveryMs: 0, beimChunk: (nr) => { if (nr === 2) throw new Error('RepCheck was updated or reloaded'); } });
  await crawl();
  assert.strictEqual(log.berichte.length, 1);
  assert.strictEqual(log.berichte[0].phase, 'sending');
  assert.match(log.berichte[0].message, /updated or reloaded/);
});

test('Abbruch-Bericht: Stopp und unerwartete Antwort erzeugen keinen zusätzlichen Bericht', async () => {
  const stopp = ladeCrawl({ target: 'book', beiGame: (oid, api) => { if (oid === '12') api.cancel(); } });
  await stopp.crawl();
  assert.deepStrictEqual(stopp.log.berichte, []);
  const unerwartet = ladeCrawl({ beiGame: (oid) => {
    if (oid !== '12') return;
    const e = new Error('unerwartet'); e.unexpected = { endpoint: 'getGame', oid }; throw e;
  } });
  await unerwartet.crawl();
  assert.deepStrictEqual(unerwartet.log.berichte, []);
  assert.strictEqual(unerwartet.log.unerwartet.length, 1);
});
