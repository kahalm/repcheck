'use strict';

// Charakterisierung reiner Teile von chessable-activity.js VOR der Zerlegung Z36: Retry-After, Tagesstatistik
// (Schluessel, Buchen, Zusammenfassung), Kurzbeschreibung einer unerwarteten Antwort, grober Browsername und die
// Erkennung des „Next variation"-Knopfs. Per Anker geschnitten (test/helpers/quelle.js sucht in allen
// Laufzeitdateien) — nach dem Umzug pruefen dieselben Tests dieselben Funktionen am neuen Ort.

const test = require('node:test');
const assert = require('node:assert');
const { finde } = require('./helpers/quelle.js');

test('parseRetryAfterMs: Sekunden, HTTP-Datum, Unsinn', () => {
  const src = finde('function parseRetryAfterMs(header) {', '// same-origin Chessable-Fetch');
  const jetzt = Date.parse('2026-10-25T12:00:00Z');
  const fn = new Function('Date', src + '\nreturn parseRetryAfterMs;')(Object.assign(function () {}, { now: () => jetzt, parse: Date.parse }));
  assert.strictEqual(fn(null), null);
  assert.strictEqual(fn(''), null);
  assert.strictEqual(fn('5'), 5000);
  assert.strictEqual(fn('0'), 0);
  assert.strictEqual(fn('-3'), 0);
  assert.strictEqual(fn('Sun, 25 Oct 2026 12:00:30 GMT'), 30000);
  assert.strictEqual(fn('Sun, 25 Oct 2026 11:00:00 GMT'), 0);
  assert.strictEqual(fn('bald'), null);
});

// Tagesstatistik gegen einen Fake-Speicher und eine feste Uhr.
function tagesstatistik(tag, speicher = {}) {
  const src = finde('const DAILY_KEY = ', 'async function flush(force) {');
  class FesterTag extends Date {
    constructor(...a) { if (a.length) super(...a); else super(tag + 'T12:00:00'); }
  }
  const chrome = {
    storage: { local: {
      get: (keys, cb) => { const out = {}; for (const k of keys) if (k in speicher) out[k] = JSON.parse(JSON.stringify(speicher[k])); cb(out); },
      set: (obj) => Object.assign(speicher, JSON.parse(JSON.stringify(obj))),
    } },
  };
  const api = new Function('chrome', 'Date', src + '\nreturn { tagesSchluessel, dailyBuchen, dailyZusammenfassung, DAILY_KEY };')(chrome, FesterTag);
  return { api, speicher };
}

test('tagesSchluessel: lokales Datum YYYY-MM-DD', () => {
  const { api } = tagesstatistik('2026-10-25');
  assert.strictEqual(api.tagesSchluessel(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.strictEqual(api.tagesSchluessel(), '2026-10-25');
});

test('dailyBuchen: summiert je Tag, neueste zuerst, hoechstens 14 Tage, nichts bei lauter Nullen', async () => {
  const alt = [];
  for (let i = 1; i <= 15; i++) alt.push({ d: '2026-09-' + String(i).padStart(2, '0'), s: 60, m: 5, l: 1 });
  const { api, speicher } = tagesstatistik('2026-10-25', { rcDailyStats: { days: alt } });
  await api.dailyBuchen(0, 0, 0, 0, 0);
  assert.strictEqual(speicher.rcDailyStats.days.length, 15, 'Nullen duerfen nichts schreiben');
  await api.dailyBuchen(120, 10, 2, 8, 1);
  await api.dailyBuchen(30, 2, 0, 2, 0);
  const tage = speicher.rcDailyStats.days;
  assert.strictEqual(tage.length, 14);
  assert.deepStrictEqual(tage[0], { d: '2026-10-25', s: 150, m: 12, l: 2, mok: 10, lok: 1 });
  assert.strictEqual(tage[1].d, '2026-09-15');
  assert.strictEqual(tage[13].d, '2026-09-03');
});

test('dailyZusammenfassung: heute + Schnitt der Vortage mit Linien (heute zaehlt nicht mit)', async () => {
  const { api } = tagesstatistik('2026-10-25', { rcDailyStats: { days: [
    { d: '2026-10-25', s: 300, m: 20, l: 3, mok: 15, lok: 2 },
    { d: '2026-10-24', s: 600, m: 40, l: 4, lok: 3 },
    { d: '2026-10-23', s: 200, m: 10, l: 0 },
    { d: '2026-10-22', s: 400, m: 30, l: 4, lok: 1 },
  ] } });
  assert.deepStrictEqual(await api.dailyZusammenfassung(), {
    heute: { sekunden: 300, zuege: 20, linien: 3, zuegeOk: 15, linienOk: 2 },
    schnitt: { tage: 2, sekProLinie: 125, linienQuote: 50 },
  });
  const leer = tagesstatistik('2026-10-25');
  assert.deepStrictEqual(await leer.api.dailyZusammenfassung(), {
    heute: { sekunden: 0, zuege: 0, linien: 0, zuegeOk: 0, linienOk: 0 },
    schnitt: { tage: 0, sekProLinie: null, linienQuote: null },
  });
});

test('unexpectedDetail: Endpunkt, oid/lid, Status ausser 200, Grund', () => {
  const fn = new Function(finde('function unexpectedDetail(u) {', '// Grob „Firefox 143"') + '\nreturn unexpectedDetail;')();
  assert.strictEqual(fn({ endpoint: 'getGame', oid: '11', status: 200, reason: 'json' }), 'getGame oid 11 · no JSON');
  assert.strictEqual(fn({ endpoint: 'getList', lid: '7', status: 403, reason: 'status' }), 'getList lid 7 · HTTP 403');
  assert.strictEqual(fn({ endpoint: 'getCourse', status: 200, reason: 'shape' }), 'getCourse · unexpected format');
  assert.strictEqual(fn({ endpoint: 'getCourse', status: 400, message: 'User is banned' }), 'getCourse · HTTP 400 · User is banned');
});

test('coarseBrowser: Name + Hauptversion, kein User-Agent', () => {
  const src = finde('function coarseBrowser() {', '// „Kurs holen" brach mit einem Fehler OHNE');
  const mit = (ua) => new Function('navigator', src + '\nreturn coarseBrowser;')(ua == null ? undefined : { userAgent: ua })();
  assert.strictEqual(mit('Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0'), 'Firefox 143');
  assert.strictEqual(mit('Mozilla/5.0 … Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'), 'Edge 141');
  assert.strictEqual(mit('Mozilla/5.0 … Chrome/141.0.0.0 Safari/537.36'), 'Chrome 141');
  assert.strictEqual(mit('curl/8'), null);
});

test('„Next variation"-Knopf: Teilstring in Text oder aria-label, Laengen-Deckel, nicht das nackte „Next"', () => {
  const src = finde('const NEXT_VARIATION_RE = ', '// Gemeinsames Dedupe-Fenster');
  const ist = new Function(src + '\nreturn isNextVariationButton;')();
  const el = (text, aria) => ({ textContent: text, getAttribute: (k) => (k === 'aria-label' ? aria || null : null) });
  assert.strictEqual(ist(el('Next variation')), true);
  assert.strictEqual(ist(el('  Nächste   Variante  (Leertaste) ')), true);
  assert.strictEqual(ist(el('Naechste Variante')), true);
  assert.strictEqual(ist(el('Next')), false);
  assert.strictEqual(ist(el('', 'Next variation')), true);
  assert.strictEqual(ist(el('x'.repeat(50) + ' next variation ' + 'y'.repeat(20))), false, 'Laengen-Deckel 60');
});
