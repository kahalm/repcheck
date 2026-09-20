const test = require('node:test');
const assert = require('node:assert');
const { classifyChessableApi, parseChapterLids, parseLineOids, parseCourseNameFromGame, buildIngestChapters, parseCourseVariations, progressCounts } =
  require('../extension/lib/chessable-crawl.js');

test('classifyChessableApi recognizes getCourse/getList/getGame with params', () => {
  assert.deepEqual(
    classifyChessableApi('https://www.chessable.com/api/v1/getCourse?uid=1&bid=71754'),
    { kind: 'course', bid: '71754' });
  assert.deepEqual(
    classifyChessableApi('https://www.chessable.com/api/v1/getList?uid=1&bid=71754&lid=42'),
    { kind: 'list', bid: '71754', lid: '42' });
  assert.deepEqual(
    classifyChessableApi('https://www.chessable.com/api/v1/getGame?lng=en&uid=1&oid=99'),
    { kind: 'game', oid: '99' });
  assert.deepEqual(
    classifyChessableApi('https://www.chessable.com/api/v1/getReview?uid=790927&bid=228856&lid=36&oid=36730415'),
    { kind: 'review', bid: '228856', oid: '36730415' });
});

test('classifyChessableApi ignores non-chessable / non-course URLs', () => {
  assert.equal(classifyChessableApi('https://evil.com/api/v1/getCourse?bid=1'), null);
  assert.equal(classifyChessableApi('https://www.chessable.com/api/v1/getHomeData?uid=1'), null);
  assert.equal(classifyChessableApi('not a url'), null);
  // relative URL resolves against chessable.com origin
  assert.deepEqual(classifyChessableApi('/api/v1/getGame?oid=5'), { kind: 'game', oid: '5' });
});

test('parseChapterLids / parseLineOids extract ordered ids, tolerate casing + bad input', () => {
  assert.deepEqual(parseChapterLids('{"course":{"data":[{"id":10},{"id":20}]}}'), ['10', '20']);
  assert.deepEqual(parseChapterLids('{"Course":{"Data":[{"Id":7}]}}'), ['7']);
  assert.deepEqual(parseChapterLids('garbage'), []);
  assert.deepEqual(parseLineOids('{"list":{"name":"Ch","data":[{"id":1,"name":"L1"},{"id":2}]}}'), ['1', '2']);
  assert.deepEqual(parseLineOids('{}'), []);
});

test('buildIngestChapters keeps getList order, drops missing/empty games and empty chapters', () => {
  const chapters = [
    {
      listText: '{"list":{"name":"Ch1","data":[{"id":1},{"id":2},{"id":3}]}}',
      games: { '1': '{"game":{"data":[]}}', '3': '{}', /* 2 missing, 3 empty "{}" */ }
    },
    {
      listText: '{"list":{"name":"Ch2","data":[{"id":9}]}}',
      games: {} // no captured lines → chapter dropped
    }
  ];
  const out = buildIngestChapters(chapters);
  assert.equal(out.length, 1);
  assert.match(out[0].chapterJson, /Ch1/);
  assert.deepEqual(out[0].lines, ['{"game":{"data":[]}}']); // only oid 1 (order preserved, 3 was "{}")
  assert.deepEqual(out[0].lineOids, ['1']);                  // oid per line → server aligns by oid, not position
});

test('parseCourseVariations extracts chapter->oids from getCourse includeVariations', () => {
  const json = '{"course":{"data":[' +
    '{"id":10,"total":2,"variations":[{"oid":101,"type":"x"},{"oid":102}]},' +
    '{"id":20,"variations":[{"oid":201}]}]}}';
  const r = parseCourseVariations(json);
  assert.deepEqual(r.chapters, [{ lid: '10', oids: ['101','102'] }, { lid: '20', oids: ['201'] }]);
  assert.deepEqual(r.allOids, ['101','102','201']);
  assert.deepEqual(parseCourseVariations('garbage'), { chapters: [], allOids: [] });
});

test('progressCounts computes course + per-chapter done/total against imported set', () => {
  const chapters = [{ lid: '10', oids: ['101','102'] }, { lid: '20', oids: ['201'] }];
  const r = progressCounts(chapters, new Set(['101','201','999']));
  assert.equal(r.total, 3);
  assert.equal(r.done, 2);
  assert.deepEqual(r.perChapter, [
    { lid: '10', total: 2, done: 1 },
    { lid: '20', total: 1, done: 1 },
  ]);
});

// ─── Pause zwischen Chessable-Abrufen (v1.56.0) ───────────────────────────────
// Zufällig 2,5–3,5 s; der Bereich darf nur nach oben verschoben werden (Popup-Einstellung `crawlDelay`).
const { CRAWL_DELAY_DEFAULT, normalizeCrawlDelay, pickCrawlDelayMs } = require('../extension/lib/chessable-crawl.js');
const fsCrawl = require('node:fs');
const pathCrawl = require('node:path');

test('normalizeCrawlDelay: ohne/kaputte Einstellung gilt der Standard 2,5–3,5 s', () => {
  assert.deepEqual(CRAWL_DELAY_DEFAULT, { minMs: 2500, maxMs: 3500 });
  for (const raw of [null, undefined, {}, { minMs: 'x', maxMs: NaN }, { minMs: Infinity }]) {
    assert.deepEqual(normalizeCrawlDelay(raw), { minMs: 2500, maxMs: 3500 }, JSON.stringify(raw));
  }
});

test('normalizeCrawlDelay: schneller als der Standard geht nicht — Werte werden angehoben', () => {
  assert.deepEqual(normalizeCrawlDelay({ minMs: 500, maxMs: 1000 }), { minMs: 2500, maxMs: 3500 });
  assert.deepEqual(normalizeCrawlDelay({ minMs: 2400, maxMs: 5000 }), { minMs: 2500, maxMs: 5000 });
  assert.deepEqual(normalizeCrawlDelay({ minMs: 3000, maxMs: 3000 }), { minMs: 3000, maxMs: 3500 });
});

test('normalizeCrawlDelay: langsamer ist erlaubt', () => {
  assert.deepEqual(normalizeCrawlDelay({ minMs: 4000, maxMs: 7000 }), { minMs: 4000, maxMs: 7000 });
});

test('normalizeCrawlDelay: „von" über „bis" zieht „bis" mit hoch', () => {
  assert.deepEqual(normalizeCrawlDelay({ minMs: 6000, maxMs: 4000 }), { minMs: 6000, maxMs: 6000 });
});

test('normalizeCrawlDelay: Tippfehler-Deckel 120 s und ganze Millisekunden', () => {
  assert.deepEqual(normalizeCrawlDelay({ minMs: 3e6, maxMs: 9e9 }), { minMs: 120000, maxMs: 120000 });
  assert.deepEqual(normalizeCrawlDelay({ minMs: 2600.4, maxMs: 3700.6 }), { minMs: 2600, maxMs: 3701 });
});

test('pickCrawlDelayMs: beide Grenzen erreichbar, nie außerhalb', () => {
  const cfg = { minMs: 2500, maxMs: 3500 };
  assert.equal(pickCrawlDelayMs(cfg, () => 0), 2500);
  assert.equal(pickCrawlDelayMs(cfg, () => 0.9999999), 3500);
  assert.equal(pickCrawlDelayMs(cfg, () => 1), 3500);          // defensiv: nie max+1
  assert.equal(pickCrawlDelayMs(cfg, () => -5), 2500);
  assert.equal(pickCrawlDelayMs(cfg, () => NaN), 2500);
});

test('pickCrawlDelayMs: echte Zufallswerte streuen über den Bereich', () => {
  const werte = Array.from({ length: 2000 }, () => pickCrawlDelayMs(null));
  assert.ok(werte.every((v) => Number.isInteger(v) && v >= 2500 && v <= 3500));
  assert.ok(werte.some((v) => v < 2700) && werte.some((v) => v > 3300), 'kein fester Takt mehr');
});

test('pickCrawlDelayMs: eine zu schnelle Einstellung wird auch beim Würfeln nicht unterschritten', () => {
  for (let i = 0; i < 200; i++) assert.ok(pickCrawlDelayMs({ minMs: 10, maxMs: 20 }) >= 2500);
});

test('Crawl-Schleifen: keine feste 3-s-Pause mehr, und keine Pause für Mitgeschnittenes', () => {
  for (const datei of ['extension/chessable-activity.js', 'repcheck.user.js']) {
    const src = fsCrawl.readFileSync(pathCrawl.join(__dirname, '..', datei), 'utf8');
    assert.ok(!/sleep\((CRAWL_)?INTER_MS\)/.test(src), `${datei}: feste Pause gefunden`);
    assert.ok(src.includes('if (!fromCapture) await sleep(crawlPauseMs())'), `${datei}: Kapitel-Pause nicht an echten Abruf gebunden`);
    // Seit 1.60.0 steht der getGame-Abruf der Extension in einem try (unerwartete Antwort) — die Pause danach mehrzeilig.
    assert.ok(/await sleep\(crawlPauseMs\(\)\);\s*\}/.test(src), `${datei}: Linien-Pause nicht zufällig`);
  }
});

test('Kurs holen: geteilter Cache und oid-Zuordnung sind verdrahtet', () => {
  const src = fsCrawl.readFileSync(pathCrawl.join(__dirname, '..', 'extension/chessable-activity.js'), 'utf8');
  assert.ok(src.includes("'/api/extension/chessable/cached-lines'"), 'Cache-Endpoint fehlt');
  assert.ok(src.includes('await fetchSharedCachedOids(wanted)'), 'Crawl fragt den geteilten Cache nicht ab');
  assert.ok(src.includes('lines.push(null); lineOids.push(String(oid)); fromShared++;'), 'gecachte Linie wird nicht übersprungen');
  assert.ok(src.includes('{ chapterJson: listText, lines, lineOids }'), 'Crawl schickt keine lineOids');
  assert.ok(src.includes('{ courseJson: courseText, complete: true }'), 'finaler Chunk nicht als komplett markiert');
  assert.ok(src.includes('lineOids: byLid[lid].map(String)'), 'Live-Anhängen schickt keine lineOids');
});

test('Buch-Crawl: ein zu großes Kapitel geht in byte-begrenzten Teilen raus (nicht als EIN Request)', () => {
  // Kapitel 30 eines Lifetime-Repertoires (87 Linien à ~470 KB) riss am 2026-09-20 das 48-MB-Limit des
  // Chunk-Endpoints; RookHub meldete das als HTTP 500. Der Buch-Zweig muss dieselbe Schranke nutzen wie
  // Mitschnitt und Repertoire — und die Teile per chapterKey als EIN Kapitel kennzeichnen.
  const src = fsCrawl.readFileSync(pathCrawl.join(__dirname, '..', 'extension/chessable-activity.js'), 'utf8');
  assert.ok(src.includes('Crawl.splitIngestChapters([chapter]).flat()'), 'Buch-Kapitel wird nicht nach Bytes geteilt');
  assert.ok(src.includes('chapterKey: String(lid)'), 'Teile tragen keinen chapterKey');
  assert.ok(!/await ingestChunk\(sessionId, bid, target, courseName, chapter, false\)/.test(src),
    'ungeteilter Kapitel-Chunk noch vorhanden');
  // Die lid muss dafür bis in die Sendeschleife durchgereicht werden.
  assert.ok(src.includes('lists.push({ lid, listText, oids })'), 'lid wird nicht mitgeführt');
  assert.ok(src.includes('for (const { lid, listText, oids } of lists)'), 'Sendeschleife kennt die lid nicht');
});

// ─── Zähler auf Kursübersicht und Startseite (v1.58.0) ─────────────────────────
const { pruneStructures } = require('../extension/lib/chessable-crawl.js');

test('pruneStructures behält die zuletzt aktualisierten Kurse und wirft kaputte Einträge weg', () => {
  const map = {
    a: { at: 1, chapters: [] }, b: { at: 3, chapters: [] }, c: { at: 2, chapters: [] }, kaputt: { at: 9 },
  };
  assert.deepEqual(Object.keys(pruneStructures(map, 2)).sort(), ['b', 'c']);
  assert.deepEqual(Object.keys(pruneStructures(map, 10)).sort(), ['a', 'b', 'c']);
  assert.deepEqual(pruneStructures(null, 3), {});
});

test('Zähler hängen an den echten Chessable-Ankern (Dumps 13.09.), nicht an geratenen Containern', () => {
  const src = fsCrawl.readFileSync(pathCrawl.join(__dirname, '..', 'extension/chessable-activity.js'), 'utf8');
  assert.ok(src.includes("'#chapterBoxes a.levelBox[href]'"), 'Kapitel-Anker fehlt');
  assert.ok(src.includes("'.progressVisuals'"), 'Kapitel-Zähler nicht neben Chessables Zähler');
  assert.ok(src.includes("'h1.courseUI-bookChapter'"), 'Kurs-Summe fehlt');
  assert.ok(src.includes("'#mainBooksList .bookHome[data-bid]'"), 'Startseite zählt nicht über die Kurskarten');
  assert.ok(src.includes('if (!COURSE_PAGE_RE.test(location.pathname)) return;'), 'getCourse auf der Startseite nicht verhindert');
  assert.ok(src.includes('annotateDom(); annotateHome();'), 'Startseiten-Zähler nicht an den DOM-Observer gehängt');
});

test('parseCourseNameFromGame liest game.name (Kursname in jeder Linie) und verträgt Müll', () => {
  // Echte Form (Prod-Cache, oid 9960377): game.name = Kurs, game.title = Linie.
  assert.equal(parseCourseNameFromGame('{"game":{"bid":55720,"name":"  Chessable Challenge ","title":"Carlsen – Karjakin"}}'), 'Chessable Challenge');
  assert.equal(parseCourseNameFromGame({ Game: { Name: 'Lifetime Repertoires' } }), 'Lifetime Repertoires');
  assert.equal(parseCourseNameFromGame('{"game":{"name":"   "}}'), null);
  assert.equal(parseCourseNameFromGame('{"error":{"message":"User is banned or deleted"}}'), null);
  assert.equal(parseCourseNameFromGame('not json'), null);
  assert.equal(parseCourseNameFromGame(null), null);
  assert.equal(parseCourseNameFromGame('{"game":{"name":"' + 'x'.repeat(300) + '"}}').length, 200);
});
