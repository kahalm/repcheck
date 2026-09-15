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
  assert.match(src, /await ingestLiveInParts\(bid, target, courseName, newChapters/);
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
