'use strict';

// Die RookHub-Verbindung (URL + Token) haengt seit v1.55.0 im Popup und ist damit auf
// JEDEM Tab erreichbar — vorher gab es sie nur im seiten-injizierten Panel, also nur auf
// chess.com/lichess. Wer auf chessable.com startet, kam ohne Umweg nicht an die Eingabe.
//
// Getestet wird der ausgelieferte Code: die reinen Helfer werden per stabiler Anker aus
// extension/background.js bzw. extension/popup.js ausgeschnitten und mit Stubs ausgefuehrt
// (dieselbe Technik wie test/rookhub-token-panel.test.js). Die URL-Normalisierung existiert
// bewusst zweimal — Worker und Popup teilen keinen Scope; der Test haelt beide Kopien gleich.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lies = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function schnipsel(src, vonAnker, bisAnker, datei) {
  const von = src.indexOf(vonAnker);
  assert.ok(von >= 0, `${datei}: Anker nicht gefunden: ${vonAnker}`);
  const bis = src.indexOf(bisAnker, von + vonAnker.length);
  assert.ok(bis > von, `${datei}: End-Anker nicht gefunden: ${bisAnker}`);
  return src.slice(von, bis);
}

function ladeFunktion(datei, vonAnker, bisAnker, name) {
  const block = schnipsel(lies(datei), vonAnker, bisAnker, datei);
  return new Function(block + '\nreturn ' + name + ';')();
}

const NORMALIZER = {
  'extension/background.js': ladeFunktion('extension/background.js',
    'function normalizeRookhubUrl(raw) {', 'function sameOrigin(', 'normalizeRookhubUrl'),
  // Seit der Zerlegung Z39 in popup-connection.js.
  'extension/popup-connection.js': ladeFunktion('extension/popup-connection.js',
    'function normalizeRookhubUrl(raw) {', '// Wie readRookhubConfigFromStorage()', 'normalizeRookhubUrl'),
};

const FAELLE = [
  ['rookhub.example.com', 'https://rookhub.example.com', 'fehlendes Schema wird zu https'],
  ['https://rookhub.example.com/', 'https://rookhub.example.com', 'Slash am Ende faellt weg'],
  ['  https://rookhub.example.com//  ', 'https://rookhub.example.com', 'Leerraum + doppelter Slash'],
  ['https://host.example/rookhub', 'https://host.example/rookhub', 'Unterpfad bleibt erhalten'],
  ['http://localhost:5000', 'http://localhost:5000', 'localhost darf Klartext-HTTP'],
  ['http://127.0.0.1:5000/', 'http://127.0.0.1:5000', '127.0.0.1 darf Klartext-HTTP'],
  ['http://rookhub.example.com', null, 'Klartext-HTTP nach aussen wird abgelehnt'],
  ['', null, 'leere Eingabe'],
  ['   ', null, 'nur Leerraum'],
  ['ht!tp://kaputt', null, 'unparsbare URL'],
];

for (const [datei, normalize] of Object.entries(NORMALIZER)) {
  for (const [eingabe, erwartet, was] of FAELLE) {
    test(`${datei}: normalizeRookhubUrl — ${was}`, () => {
      assert.strictEqual(normalize(eingabe), erwartet, `Eingabe: ${JSON.stringify(eingabe)}`);
    });
  }
}

// ─── JWT-Vorpruefung im Worker ────────────────────────────────────────────
const isUsableJwt = ladeFunktion('extension/background.js',
  'function isUsableJwt(tok) {', 'function setBadge(', 'isUsableJwt');

function jwt(payload) {
  const teil = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return teil({ alg: 'HS256' }) + '.' + teil(payload) + '.sig';
}

test('background.js: gueltiges JWT mit Restlaufzeit wird akzeptiert', () => {
  assert.strictEqual(isUsableJwt(jwt({ exp: Math.floor(Date.now() / 1000) + 3600 })), true);
});

test('background.js: JWT ohne exp wird akzeptiert', () => {
  assert.strictEqual(isUsableJwt(jwt({ sub: '1' })), true);
});

test('background.js: abgelaufenes JWT wird abgelehnt', () => {
  assert.strictEqual(isUsableJwt(jwt({ exp: Math.floor(Date.now() / 1000) - 10 })), false);
});

test('background.js: JWT, das binnen 30 s ablaeuft, wird abgelehnt', () => {
  // Es soll noch fuer den POST /api/profile/tokens reichen.
  assert.strictEqual(isUsableJwt(jwt({ exp: Math.floor(Date.now() / 1000) + 5 })), false);
});

test('background.js: Nicht-JWT wird abgelehnt', () => {
  for (const müll of [null, undefined, '', 'abc', 'a.b', 'a.b.c.d', 'a.###.c']) {
    assert.strictEqual(isUsableJwt(müll), false, String(müll));
  }
});

// ─── Einstellungen duerfen an keiner Site haengen ─────────────────────────
test('popup.js: „Einstellungen" ist nicht mehr auf chess.com/lichess beschraenkt', () => {
  const handler = schnipsel(lies('extension/popup.js'),
    "document.getElementById('open-settings').addEventListener",
    "document.getElementById('open-page-panel')", 'extension/popup.js');
  assert.ok(!/chess\.com|lichess/.test(handler),
    'Der Einstellungs-Knopf darf die Tab-URL nicht mehr pruefen — sonst ist die RookHub-Verbindung auf chessable.com wieder unerreichbar.');
});

test('popup.html: Verbindungs-Bedienelemente sind vorhanden', () => {
  const html = lies('extension/popup.html');
  for (const id of ['settings-box', 'conn-url', 'conn-token', 'conn-pair', 'conn-save', 'conn-forget', 'open-page-panel']) {
    assert.ok(html.includes('id="' + id + '"'), 'fehlt im Popup: ' + id);
  }
});
