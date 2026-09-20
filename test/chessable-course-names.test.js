'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  rcDecodeChessableUid: decodeChessableUid,
  rcParseCourseNameMap: parseCourseNameMap,
  rcIsNavLabel: isNavLabel,
} = require('../extension/lib/chessable-course-names.js');

const ROOT = path.join(__dirname, '..');
const lies = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Baut einen JWT (nur Payload zählt) mit base64url-kodiertem JSON.
function jwt(payloadObj) {
  const b64url = (s) => Buffer.from(s).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'h.' + b64url(JSON.stringify(payloadObj)) + '.sig';
}

test('decodeChessableUid liest user.uid aus dem JWT-Payload', () => {
  assert.strictEqual(decodeChessableUid(jwt({ user: { uid: 790927 }, exp: 1 })), '790927');
});

test('decodeChessableUid akzeptiert String-uid', () => {
  assert.strictEqual(decodeChessableUid(jwt({ user: { uid: '42' } })), '42');
});

test('decodeChessableUid gibt null bei fehlender/kaputter uid', () => {
  assert.strictEqual(decodeChessableUid(jwt({ user: {} })), null);
  assert.strictEqual(decodeChessableUid(jwt({ nope: 1 })), null);
  assert.strictEqual(decodeChessableUid('not-a-jwt'), null);
  assert.strictEqual(decodeChessableUid(''), null);
  assert.strictEqual(decodeChessableUid(null), null);
  assert.strictEqual(decodeChessableUid(jwt({ user: { uid: 'x12' } })), null);
});

test('parseCourseNameMap baut bid→Name (camelCase)', () => {
  const data = { homeData: { booksList: [
    { bid: 116242, name: 'Lifetime Repertoires: 1.e4' },
    { bid: 128648, name: 'Short & Sweet' },
  ] } };
  assert.deepStrictEqual(parseCourseNameMap(data), {
    '116242': 'Lifetime Repertoires: 1.e4',
    '128648': 'Short & Sweet',
  });
});

test('parseCourseNameMap toleriert PascalCase-Keys', () => {
  const data = { HomeData: { BooksList: [{ Bid: 1, Name: 'Course One' }] } };
  assert.deepStrictEqual(parseCourseNameMap(data), { '1': 'Course One' });
});

test('parseCourseNameMap überspringt leere Namen und kappt auf 200 Zeichen', () => {
  const long = 'x'.repeat(250);
  const data = { homeData: { booksList: [
    { bid: 1, name: '   ' },
    { bid: 2, name: '  Trim Me  ' },
    { bid: 3, name: long },
  ] } };
  const map = parseCourseNameMap(data);
  assert.strictEqual(map['1'], undefined);
  assert.strictEqual(map['2'], 'Trim Me');
  assert.strictEqual(map['3'].length, 200);
});

test('parseCourseNameMap gibt {} bei fehlender/kaputter Struktur', () => {
  assert.deepStrictEqual(parseCourseNameMap(null), {});
  assert.deepStrictEqual(parseCourseNameMap({}), {});
  assert.deepStrictEqual(parseCourseNameMap({ homeData: {} }), {});
  assert.deepStrictEqual(parseCourseNameMap({ homeData: { booksList: 'nope' } }), {});
});

test('isNavLabel erkennt Modus-/Nav-Labels', () => {
  for (const t of ['Practice', 'Practice Moves', 'Learn Moves', 'Review', 'Overview',
                   'Variations', 'Move Trainer', 'Next', 'Weiter', 'Home']) {
    assert.strictEqual(isNavLabel(t), true, t);
  }
  assert.strictEqual(isNavLabel('  nächstes Kapitel '), true);
  assert.strictEqual(isNavLabel('Previous variation'), true);
});

test('isNavLabel erkennt Leaderboard und Kapitel-Überschriften', () => {
  assert.strictEqual(isNavLabel('Leaderboard'), true);
  assert.strictEqual(isNavLabel('Kapitel 3:'), true);
  assert.strictEqual(isNavLabel('Chapter 12'), true);
  assert.strictEqual(isNavLabel('kapitel:'), true);
});

test('isNavLabel lässt echte Kurstitel durch', () => {
  assert.strictEqual(isNavLabel('Lifetime Repertoires: 1.e4'), false);
  assert.strictEqual(isNavLabel('Learn Chess Openings'), false);
  assert.strictEqual(isNavLabel('Chapter One of My Life'), false);
  assert.strictEqual(isNavLabel(''), false);
  assert.strictEqual(isNavLabel(null), false);
});

// ─── Auslieferung: die getestete Lib IST der Laufzeit-Code ──────────────────────────────
//
// Früher standen hier Drift-Guards: die Lib war eine reine Spiegel-Datei, ausgeführt wurden
// hand-gepflegte Kopien von isNavLabel (chessable-activity.js, chessable-fen.js) — die prompt
// auseinanderliefen. Seit der Umstellung gibt es keine Kopien mehr; die folgenden Tests belegen
// stattdessen, dass die Lib tatsächlich ausgeliefert und benutzt wird. Ohne Manifest-Eintrag bzw.
// mit einer wiederauferstandenen Inline-Kopie schlagen sie fehl.

// Erkennungszeichen einer eigenen Kopie: das Nav-Label-Regex. Steht es außerhalb der Lib, hat
// sich jemand wieder eine Kopie gebaut.
const KOPIE_MARKER = 'practice( moves)?';

test('manifest.json liefert lib/chessable-course-names.js in BEIDEN Welten aus', () => {
  const manifest = JSON.parse(lies('extension/manifest.json'));
  const LIB = 'lib/chessable-course-names.js';
  for (const konsument of ['chessable-activity.js', 'chessable-fen.js']) {
    const eintrag = manifest.content_scripts.find((cs) => (cs.js || []).includes(konsument));
    assert.ok(eintrag, `kein content_scripts-Eintrag für ${konsument}`);
    const iLib = eintrag.js.indexOf(LIB);
    assert.ok(iLib >= 0, `${konsument}: ${LIB} fehlt im content_scripts-Eintrag`);
    assert.ok(iLib < eintrag.js.indexOf(konsument),
      `${konsument}: ${LIB} muss VOR der Datei geladen werden (self.RepCheckCourseNames)`);
  }
  // chessable-fen.js läuft in der MAIN-World — die Lib muss dort mitgeladen werden, ein
  // Eintrag in der isolierten Welt reicht nicht (getrennte globale Scopes).
  const fenEintrag = manifest.content_scripts.find((cs) => (cs.js || []).includes('chessable-fen.js'));
  assert.strictEqual(fenEintrag.world, 'MAIN');
});

test('das Popup injiziert die Lib beim Nachladen von chessable-activity.js mit', () => {
  // Fallback-Pfad für Tabs, die vor dem Extension-Update geladen wurden: ohne die Lib liefe
  // chessable-activity.js dort ohne Nav-Label-Filter/uid-Decode.
  const popup = lies('extension/popup.js');
  const zeile = popup.split('\n').find((l) => l.includes('executeScript') && l.includes('chessable-activity.js'));
  assert.ok(zeile, 'kein executeScript-Aufruf für chessable-activity.js gefunden');
  assert.ok(zeile.includes('lib/chessable-course-names.js'),
    'lib/chessable-course-names.js fehlt in der Nachlade-Liste des Popups');
});

test('die Extension-Laufzeitdateien benutzen die Lib statt eigener Definitionen', () => {
  for (const rel of ['extension/chessable-activity.js', 'extension/chessable-fen.js']) {
    const src = lies(rel);
    assert.ok(src.includes('self.RepCheckCourseNames'),
      `${rel}: bezieht die Kursnamen-Helfer nicht über self.RepCheckCourseNames`);
    assert.ok(!src.includes(KOPIE_MARKER),
      `${rel}: enthält wieder eine eigene isNavLabel-Kopie`);
  }
  // Der uid-Decode lag ebenfalls doppelt vor (JWT-Payload-Parsing).
  const activity = lies('extension/chessable-activity.js');
  assert.ok(!/function b64urlDecode/.test(activity),
    'chessable-activity.js: eigener base64url-Decoder ist wieder da');
  assert.ok(activity.includes('CourseNames.decodeChessableUid'),
    'chessable-activity.js: decodiert die uid nicht über die Lib');
  assert.ok(activity.includes('CourseNames.parseCourseNameMap'),
    'chessable-activity.js: parst getHomeData nicht über die Lib');
});

// ---- Kurstitel aus dem Kacheltext (2026-09-19) ----------------------------------------------------------
// Chessables Kurskachel ist EIN Link; ihr textContent klebt Titel und Fortschrittsbadges zusammen. Genau so
// wurde ein Repertoire „Short & Sweet0%Priority0/15variations✓ 0/15" angelegt.
const { rcCleanCourseTitle: cleanCourseTitle } = require('../extension/lib/chessable-course-names.js');

test('cleanCourseTitle kappt die Fortschrittsbadges der Kurskachel', () => {
  assert.strictEqual(cleanCourseTitle('Short & Sweet0%Priority0/15variations✓ 0/15'), 'Short & Sweet');
  assert.strictEqual(cleanCourseTitle("Lifetime Repertoires: King's Indian Defense - Part 2 37% 700/1881 variations ✓ 12"),
    "Lifetime Repertoires: King's Indian Defense - Part 2");
  assert.strictEqual(cleanCourseTitle('Meisterpartien Priorität 3/40 Varianten'), 'Meisterpartien');
});

test('cleanCourseTitle lässt Titel ohne Badges unangetastet', () => {
  assert.strictEqual(cleanCourseTitle('1. e4 e5 - The Italian Game'), '1. e4 e5 - The Italian Game');
  assert.strictEqual(cleanCourseTitle('  Learn  Chess Openings '), 'Learn Chess Openings');
  // Eine Zahl im Titel ist kein Badge: kein Prozent, kein „N/M variations".
  assert.strictEqual(cleanCourseTitle('100 Endgames You Must Know'), '100 Endgames You Must Know');
  assert.strictEqual(cleanCourseTitle('Chess Olympiad 2026'), 'Chess Olympiad 2026');
});

test('cleanCourseTitle liefert null statt eines leeren Namens', () => {
  assert.strictEqual(cleanCourseTitle('0%Priority0/15variations'), null);
  assert.strictEqual(cleanCourseTitle('   '), null);
  assert.strictEqual(cleanCourseTitle(null), null);
});
