'use strict';

// chess.coms eigene Zugliste (TCN) lesen — die Quelle fuer „Partie speichern" dort, wo keine Zugliste
// im DOM steht (Analyseseite, Review-Tab). Der lange Vektor ist eine ECHTE Partie vom 2026-09-24
// (kahalm–rianherdian, 184296489960): links das `moveList`-Feld aus chess.coms Antwort, rechts die
// 47 Zuege, wie sie die Seite selbst im Analyse-Tab anzeigt.

const test = require('node:test');
const assert = require('node:assert');
const { Chess } = require('../extension/chess.min.js');
const { decodeTcn, sansFromTcn } = require('../extension/lib/chesscom-moves.js');

const PARTIE_TCN = 'mC0SlBZJCKYIks5Qgv7Pft6ZBI9IegWGdm!0blGyjzyrlr0UrIPIabIWcuW5bjUKvKQKuD1TfbZ6tH80HO2MOXMDXJ5RJ4';
const PARTIE_SANS = ('e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6 Bd3 Bd7 dxc5 Bxc5 O-O a5 Qe2 Nge7 Nbd2 a4 b4 axb3 Nxb3 Ng6 '
  + 'Nxc5 Qxc5 Rb1 Qa7 Be3 Qb8 Rb2 Ngxe5 Nxe5 Nxe5 Bf4 f6 Rfb1 Bc8 Bb5+ Ke7 Ba6 g5 Bxb7 gxf4 Bxd5 Qd6 Bxa8').split(' ');

test('eine echte Partie: 94 Zeichen werden zu genau den 47 Zuegen der Seite', () => {
  assert.equal(PARTIE_TCN.length, 94);
  assert.equal(PARTIE_SANS.length, 47);
  assert.deepEqual(sansFromTcn(PARTIE_TCN, Chess), PARTIE_SANS);
});

test('Felder: zwei Zeichen sind von und nach (0 = a1, 63 = h8)', () => {
  assert.deepEqual(decodeTcn('mC')[0], { from: 'e2', to: 'e4' });
  assert.deepEqual(decodeTcn('aa')[0], { from: 'a1', to: 'a1' });
  assert.deepEqual(decodeTcn('mC0S')[1], { from: 'e7', to: 'e6' });
  assert.equal(decodeTcn(PARTIE_TCN).length, 47);
});

test('Umwandlung: das zweite Zeichen traegt Figur und Richtung', () => {
  // e7e8=D — geradeaus, Dame. Das Zielfeld steckt nicht im Zeichen, es folgt aus dem Startfeld.
  assert.deepEqual(decodeTcn('0~')[0], { promotion: 'q', from: 'e7', to: 'e8' });
  // schlagend nach links (d8) und rechts (f8), Springer bzw. Turm
  assert.deepEqual(decodeTcn('0(')[0], { promotion: 'n', from: 'e7', to: 'd8' });
  assert.deepEqual(decodeTcn('0]')[0], { promotion: 'r', from: 'e7', to: 'f8' });
  // dieselbe Figur geradeaus: die drei Zeichen je Figur stehen fuer links / geradeaus / rechts
  assert.deepEqual(decodeTcn('0_')[0], { promotion: 'r', from: 'e7', to: 'e8' });
});

test('Umwandlung landet auch als SAN richtig auf dem Brett', () => {
  const brett = new Chess('8/4P3/8/8/8/8/8/4K2k w - - 0 1');
  const zug = decodeTcn('0~')[0];

  assert.equal(brett.move({ from: zug.from, to: zug.to, promotion: zug.promotion }).san, 'e8=Q');
});

test('kaputte Eingaben ergeben NICHTS — eine halb gelesene Partie waere schlimmer', () => {
  assert.deepEqual(decodeTcn('mC0'), []);          // ungerade Laenge
  assert.deepEqual(decodeTcn('m€'), []);           // unbekanntes Zeichen
  assert.deepEqual(decodeTcn(''), []);
  assert.deepEqual(decodeTcn(null), []);
  assert.deepEqual(sansFromTcn('mCmC', Chess), []); // zweimal derselbe Zug geht nicht
  assert.deepEqual(sansFromTcn(PARTIE_TCN, null), []);
});

test('die Lib wird als Content-Script ausgeliefert (sonst fehlt sie zur Laufzeit)', () => {
  const manifest = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  const seite = manifest.content_scripts.find((c) => c.matches.some((m) => m.includes('chess.com')));

  assert.ok(seite.js.includes('lib/chesscom-moves.js'), 'lib fehlt im Manifest');
  assert.ok(seite.js.indexOf('chess.min.js') < seite.js.indexOf('content.js'), 'chess.js muss vor content.js geladen werden');
});
