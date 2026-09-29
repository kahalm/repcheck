'use strict';

// Gemeinsamer RookHub-Client (S1-009, lib/rookhub-client.js). Anlass: der RookHub-Aufruf war 16-mal von Hand gebaut,
// und nur ein Teil der Pfade erkannte 401 als „Token ungültig". Wurde der Token in RookHub widerrufen, stand beim
// Chessable-Import (ingest, ingest/chunk, ingest/live) nur „HTTP 401" da — ohne Hinweis, dass neu verbunden werden muss.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Rookhub = require('../extension/lib/rookhub-client.js');

const ROOT = path.join(__dirname, '..');
const lies = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const t = (k, p) => (p ? k + ' ' + JSON.stringify(p) : k);

// Winziges chrome: rookhubConfig im Storage, der Worker antwortet mit `antwort` (oder setzt lastError).
function fakeChrome({ cfg = { url: 'https://rookhub.example/', token: 'rkh_x' }, antwort, lastError } = {}) {
  const gesendet = [];
  const chrome = {
    storage: { local: { get: (key, cb) => cb({ rookhubConfig: cfg }) } },
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        gesendet.push(msg);
        chrome.runtime.lastError = lastError ? { message: lastError } : null;
        cb(typeof antwort === 'function' ? antwort(msg) : antwort);
        chrome.runtime.lastError = null;
      },
    },
  };
  return { chrome, gesendet };
}

test('Nachricht an den Worker: dieselbe Form wie die bisher von Hand gebauten (Charakterisierung)', () => {
  const cfg = { url: 'https://rookhub.example/', token: 'rkh_x' };
  const body = { bid: '1', target: 'repertoire', courseName: 'K', chapters: [] };
  // So stand es bis v1.68.3 in ingest()/ingestChunk()/ingestLive().
  assert.deepStrictEqual(Rookhub.buildMessage(cfg, '/api/extension/chessable/ingest', { body }), {
    type: 'rookhub-fetch',
    url: 'https://rookhub.example/api/extension/chessable/ingest',
    method: 'POST',
    headers: { 'Authorization': 'Bearer rkh_x', 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
    expect: 'json',
  });
  // GET ohne Rumpf: kein Content-Type, kein body.
  assert.deepStrictEqual(Rookhub.buildMessage({ url: 'https://r.example', token: 't' }, '/api/extension/repertoires'), {
    type: 'rookhub-fetch', url: 'https://r.example/api/extension/repertoires', method: 'GET',
    headers: { 'Authorization': 'Bearer t', 'Accept': 'application/json' }, expect: 'json',
  });
});

test('Fehlerabbildung: 401 heißt immer „Token ungültig", sonst Servertext, Worker-Fehler oder HTTP-Status', () => {
  const e401 = Rookhub.responseError({ ok: false, status: 401, body: null }, t);
  assert.deepStrictEqual([e401.message, e401.status, e401.tokenInvalid], ['err.tokenInvalid', 401, true]);
  assert.strictEqual(Rookhub.responseError({ ok: false, status: 400, body: { message: 'No lines.' } }, t).message, 'No lines.');
  assert.strictEqual(Rookhub.responseError({ ok: false, status: 0, error: 'target origin not allowed' }, t).message, 'target origin not allowed');
  const e500 = Rookhub.responseError({ ok: false, status: 500, body: '<html>' }, t);
  assert.deepStrictEqual([e500.message, e500.tokenInvalid], ['err.http {"status":500}', false]);
  assert.strictEqual(Rookhub.responseError(undefined, t).message, 'err.noBackground');
});

test('request: liest die Config, schickt über den Worker und liefert den Rumpf', async () => {
  const { chrome, gesendet } = fakeChrome({ antwort: { ok: true, status: 200, body: { imported: 3 } } });
  const client = Rookhub.create({ t, chrome });
  assert.deepStrictEqual(await client.request('/api/extension/chessable/ingest/live', { body: { a: 1 } }), { imported: 3 });
  assert.strictEqual(gesendet[0].url, 'https://rookhub.example/api/extension/chessable/ingest/live');
  assert.strictEqual(gesendet[0].headers.Authorization, 'Bearer rkh_x');
});

test('request: ohne Verbindung, bei Laufzeitfehler und bei 401 ein Fehler mit lesbarer Meldung', async () => {
  const ohne = fakeChrome({ cfg: { url: 'https://rookhub.example' } });
  await assert.rejects(Rookhub.create({ t, chrome: ohne.chrome }).request('/x', { body: {} }),
    (e) => e.notConnected === true && e.message === 'err.notConnected');
  assert.strictEqual(ohne.gesendet.length, 0, 'ohne Token darf nichts rausgehen');
  const weg = fakeChrome({ lastError: 'Extension context invalidated.' });
  await assert.rejects(Rookhub.create({ t, chrome: weg.chrome }).request('/x'), /Extension context invalidated/);
  const tot = fakeChrome({ antwort: { ok: false, status: 401, body: null } });
  await assert.rejects(Rookhub.create({ t, chrome: tot.chrome }).request('/x', { body: {} }),
    (e) => e.tokenInvalid === true && e.message === 'err.tokenInvalid');
});

// Die drei Import-Pfade aus chessable-activity.js, gegen den echten Client und ein gestubbtes chrome ausgeführt.
function ladeImportPfade(antwort) {
  const src = lies('extension/chessable-activity.js');
  const schnitt = (von, bis) => {
    const a = src.indexOf(von), b = src.indexOf(bis, a);
    assert.ok(a >= 0 && b > a, 'nicht gefunden: ' + von);
    return src.slice(a, b);
  };
  const block = schnitt('  function rookhubRequest(', '  // Kurs-ID ermitteln')
    + schnitt('  async function ingest(bid, chapters, target, courseName)', '  // Chessable drosselt (HTTP 429)')
    + schnitt('  async function ingestChunk(', '  const CRAWL_BACKOFF_BASE_MS')
    + schnitt('  async function ingestLive(', '  // Anhängen in Portionen');
  const { chrome, gesendet } = fakeChrome({ antwort });
  const client = Rookhub.create({ t, chrome });
  const readConfig = () => Rookhub.readConfig(chrome);
  const fns = new Function('chrome', 't', 'readConfig', 'Rookhub', block + '\nreturn { ingest, ingestChunk, ingestLive };')(
    chrome, t, readConfig, client);
  return { fns, gesendet };
}

test('Chessable-Import: ein widerrufener Token meldet „Token ungültig" statt „HTTP 401" (alle drei Pfade)', async () => {
  const { fns, gesendet } = ladeImportPfade({ ok: false, status: 401, body: null });
  const erwartet = (e) => e.message === 'err.tokenInvalid';
  await assert.rejects(fns.ingest('1', [], 'repertoire', 'K'), erwartet);
  await assert.rejects(fns.ingestChunk('s', '1', 'book', 'K', null, true, { aborted: true }), erwartet);
  await assert.rejects(fns.ingestLive('1', 'repertoire', 'K', []), erwartet);
  assert.deepStrictEqual(gesendet.map((m) => m.url.replace('https://rookhub.example', '')),
    ['/api/extension/chessable/ingest', '/api/extension/chessable/ingest/chunk', '/api/extension/chessable/ingest/live']);
});

test('Chessable-Import: Rumpf und Servertexte unverändert', async () => {
  const { fns, gesendet } = ladeImportPfade((msg) => (msg.url.endsWith('/chunk')
    ? { ok: false, status: 400, body: { message: 'No captured lines in session.' } }
    : { ok: true, status: 200, body: { imported: 2 } }));
  assert.deepStrictEqual(await fns.ingest('9', [{ x: 1 }], 'book', 'Kurs'), { imported: 2 });
  assert.deepStrictEqual(JSON.parse(gesendet[0].body), { bid: '9', target: 'book', courseName: 'Kurs', chapters: [{ x: 1 }] });
  await assert.rejects(fns.ingestChunk('s1', '9', 'book', 'Kurs', null, true, { aborted: true }), /No captured lines in session\./);
  assert.deepStrictEqual(JSON.parse(gesendet[1].body),
    { sessionId: 's1', bid: '9', target: 'book', courseName: 'Kurs', chapter: null, final: true, aborted: true });
  assert.deepStrictEqual(await fns.ingestLive('9', 'repertoire', 'Kurs', []), { imported: 2 });
  assert.deepStrictEqual(JSON.parse(gesendet[2].body), { bid: '9', target: 'repertoire', courseName: 'Kurs', chapters: [] });
});

test('Auslieferung: die Lib lädt VOR chessable-activity.js, auch beim Nachladen aus dem Popup', () => {
  const manifest = JSON.parse(lies('extension/manifest.json'));
  const chessable = manifest.content_scripts.find((c) => c.js.includes('chessable-activity.js'));
  const js = chessable.js;
  assert.ok(js.includes('lib/rookhub-client.js'), 'Manifest liefert lib/rookhub-client.js nicht aus');
  assert.ok(js.indexOf('lib/rookhub-client.js') < js.indexOf('chessable-activity.js'));
  const popup = lies('extension/popup.js');
  const nachladen = /files: \[([^\]]*'chessable-activity\.js'[^\]]*)\]/.exec(popup);
  assert.ok(nachladen, 'Nachladeliste für chessable-activity.js nicht gefunden');
  const liste = nachladen[1];
  assert.ok(liste.includes("'lib/rookhub-client.js'") && liste.indexOf("'lib/rookhub-client.js'") < liste.indexOf("'chessable-activity.js'"),
    'Popup lädt lib/rookhub-client.js nicht vor chessable-activity.js nach');
});

test('Die Import-Pfade bauen den Aufruf nicht mehr von Hand', () => {
  const src = lies('extension/chessable-activity.js');
  for (const endpunkt of ['/api/extension/chessable/ingest\'', '/api/extension/chessable/ingest/chunk\'', '/api/extension/chessable/ingest/live\'']) {
    const i = src.indexOf(endpunkt);
    assert.ok(i > 0, 'Endpunkt fehlt: ' + endpunkt);
    const umgebung = src.slice(Math.max(0, i - 300), i + 200);
    assert.doesNotMatch(umgebung, /type: 'rookhub-fetch'|'Bearer ' \+/, 'von Hand gebaut: ' + endpunkt);
    assert.match(umgebung, /rookhubRequest\(/);
  }
});

test('Standard-Instanz: überall dieselbe Adresse wie in der Lib (sonst lehnt der Worker die token-losen Linien ab)', () => {
  const fundstellen = {
    'extension/background.js': /const DEFAULT_ROOKHUB_ORIGIN = '([^']+)'/,
    'extension/popup.js': /const ROOKHUB_DEFAULT_URL = '([^']+)'/,
    'extension/welcome.js': /const ROOKHUB_DEFAULT_URL = '([^']+)'/,
    'extension/chessable-activity.js': /const DEFAULT_ROOKHUB_URL = '([^']+)'/,
  };
  for (const [datei, muster] of Object.entries(fundstellen)) {
    const m = muster.exec(lies(datei));
    assert.ok(m, 'Standard-Adresse nicht gefunden in ' + datei);
    assert.strictEqual(m[1], Rookhub.DEFAULT_URL, datei + ' weicht ab');
  }
});
