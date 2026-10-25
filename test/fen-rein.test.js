'use strict';

// Charakterisierung reiner Teile von chessable-fen.js (MAIN-World) VOR der Zerlegung Z38: XP-Betrag aus der
// Zug-Rueckmeldung, Vorzeichen, Dauer/Uhrzeit der Pool-Hochrechnung, das Pool-Panel (Hochrechnung aus Tages- bzw.
// Vortagesschnitt), die Chessable-FEN-Such-URL und Kurs-ID/-Name aus React-Fiber-Props. Die FEN-Auslese selbst hat
// ihr Golden in test/chessable-fen-extract.test.js. Per Anker geschnitten (test/helpers/quelle.js sucht in allen
// Laufzeitdateien) — nach dem Umzug pruefen dieselben Tests dieselben Funktionen am neuen Ort.

const test = require('node:test');
const assert = require('node:assert');
const { finde } = require('./helpers/quelle.js');

test('parseXp: Betrag aus „+60 ", Tausenderpunkte, Komma, kein Betrag → null', () => {
  const fn = new Function(finde('function parseXp(pointsText, fullText) {', '/** Zustand aus der SICHTBAREN Icon-Klasse')
    + '\nreturn parseXp;')();
  assert.strictEqual(fn('+60 ', 'egal'), 60);
  assert.strictEqual(fn('', '+150 XP'), 150);
  assert.strictEqual(fn('+1.250', ''), 1250);
  assert.strictEqual(fn('+1,5', ''), 1.5);
  assert.strictEqual(fn('-20', ''), -20);
  assert.strictEqual(fn('', 'Overstudied'), null);
  assert.strictEqual(fn(null, null), null);
});

test('signiert: „+0" und „-3"', () => {
  const fn = new Function(finde('function signiert(n) {', '/** Summe der erfassten') + '\nreturn signiert;')();
  assert.strictEqual(fn(0), '+0');
  assert.strictEqual(fn(60), '+60');
  assert.strictEqual(fn(-3), '-3');
});

test('poolDauer und poolUhrzeit', () => {
  const src = finde('function poolDauer(sekunden) {', 'function poolZeile(label, wert, dezent) {');
  const jetzt = new Date(2026, 9, 25, 21, 50, 0).getTime();
  const { poolDauer, poolUhrzeit } = new Function('Date', src + '\nreturn { poolDauer, poolUhrzeit };')(
    class extends Date { static now() { return jetzt; } });
  assert.strictEqual(poolDauer(29), '0 min');
  assert.strictEqual(poolDauer(12 * 60), '12 min');
  assert.strictEqual(poolDauer(83 * 60), '1:23 h');
  assert.strictEqual(poolDauer(60 * 60), '1:00 h');
  assert.strictEqual(poolUhrzeit(0), '21:50');
  assert.strictEqual(poolUhrzeit(25 * 60), '22:15');
});

// Pool-Panel gegen ein Element, das innerHTML/Stil aufnimmt.
function poolPanel({ rest, daily }) {
  const src = finde('function poolDauer(sekunden) {', 'function togglePoolPanel() {');
  const el = { style: {}, innerHTML: '', id: '' };
  let angelegt = false;
  const document = {
    getElementById: () => (angelegt ? el : null),
    createElement: () => { angelegt = true; return el; },
    body: { appendChild() {} },
  };
  const jetzt = new Date(2026, 9, 25, 20, 0, 0).getTime();
  const render = new Function('document', 'trainingPoolRest', 'poolDaily', 'POOL_PANEL_ID', 'POOL_MIN_LINIEN', 'Date',
    src + '\nreturn renderPoolPanel;')(document, () => rest, daily, 'panel', 5, class extends Date { static now() { return jetzt; } });
  render();
  return el.innerHTML.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
}

test('Pool-Panel: Hochrechnung aus dem Tagesschnitt ab 5 Linien, Vergleich mit den Vortagen', () => {
  const html = poolPanel({ rest: 30, daily: {
    heute: { sekunden: 1200, zuege: 100, linien: 10, zuegeOk: 90, linienOk: 7 },
    schnitt: { tage: 4, sekProLinie: 100 },
  } });
  assert.strictEqual(html, '|Trainingspool|Noch offen|30 Linien|Heute geschafft|10 Linien|Ø je Linie heute|120 s · 12 s/Zug|'
    + 'Genauigkeit heute|70 % (7/10) · 90 % Zuege|Aktive Zeit heute|20 min|Rest ≈|1:00 h → 21:00|'
    + 'gerechnet mit 120 s je Linie (Tagesschnitt)|heute 20 % langsamer als sonst (100 s)|');
});

test('Pool-Panel: zu wenig heute → Vortagesschnitt, mit Begruendung; ohne Daten keine Zahl; leerer Pool', () => {
  assert.strictEqual(poolPanel({ rest: 10, daily: {
    heute: { sekunden: 300, zuege: 20, linien: 2, zuegeOk: 20, linienOk: 2 },
    schnitt: { tage: 1, sekProLinie: 90 },
  } }), '|Trainingspool|Noch offen|10 Linien|Heute geschafft|2 Linien|Ø je Linie heute|150 s · 15 s/Zug|'
    + 'Genauigkeit heute|100 % (2/2) · 100 % Zuege|Aktive Zeit heute|5 min|Rest ≈|15 min → 20:15|'
    + 'gerechnet mit 90 s je Linie (Schnitt der letzten 1 Tag) — heute erst 2 Linien, dafür zu wenig|');
  assert.strictEqual(poolPanel({ rest: 10, daily: null }),
    '|Trainingspool|Noch offen|10 Linien|Heute geschafft|0 Linien|Für eine Hochrechnung fehlen noch Daten — nach ein paar Linien steht hier eine Schätzung.|');
  assert.strictEqual(poolPanel({ rest: 0, daily: null }), '|Trainingspool|Noch offen|0 Linien|Heute geschafft|0 Linien|Pool leer — für heute durch. ✓|');
  assert.strictEqual(poolPanel({ rest: null, daily: null }), '|Trainingspool|Noch offen|—|Heute geschafft|0 Linien|Kein Pool-Zähler auf der Seite gefunden.|');
});

test('chessableSearchUrl: kursintern mit „;", sonst global mit „U"', () => {
  // lib/repertoire-text.js hat eine gleichnamige (globale) Fassung — hier die kursinterne aus der MAIN-World.
  const src = finde('function chessableSearchUrl(fen) {\n    const courseId = currentCourseId();', '// ---------- Zug-Rückmeldung');
  const mit = (id) => new Function('currentCourseId', src + '\nreturn chessableSearchUrl;')(() => id);
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  assert.strictEqual(mit('55720')(fen),
    'https://www.chessable.com/course/55720/fen/rnbqkbnr;pppppppp;8;8;4P3;8;PPPP1PPP;RNBQKBNR%20b%20KQkq%20e3%200%201/');
  assert.strictEqual(mit(null)(fen),
    'https://www.chessable.com/courses/fen/rnbqkbnrUppppppppU8U8U4P3U8UPPPP1PPPURNBQKBNR%20b%20KQkq%20e3%200%201/');
});

test('fiberCourseId: Zahl aus courseId/courseID/course_id/course.id, sonst null', () => {
  const fn = new Function(finde('function fiberCourseId(props) {', 'function chessableSearchUrl(fen) {') + '\nreturn fiberCourseId;')();
  assert.strictEqual(fn({ courseId: 55720 }), '55720');
  assert.strictEqual(fn({ course: { courseId: '7' } }), '7');
  assert.strictEqual(fn({ course_id: 'abc', courseID: 12 }), '12');
  assert.strictEqual(fn({ courseId: 'x1' }), null);
  assert.strictEqual(fn(null), null);
});

test('fiberCourseName: erster brauchbarer Name, Nav-Labels und Ueberlanges verworfen', () => {
  const src = finde('function fiberCourseName(props) {', '// Lesbarer Kursname: bevorzugt');
  const fn = new Function('isNavLabel', src + '\nreturn fiberCourseName;')((t) => /^practice moves$/i.test(t));
  assert.strictEqual(fn({ course: { name: '  Lifetime   Repertoires ' } }), 'Lifetime Repertoires');
  assert.strictEqual(fn({ course: { name: 'Practice Moves' }, courseTitle: 'Grünfeld' }), 'Grünfeld');
  assert.strictEqual(fn({ book: { title: 'x'.repeat(201) } }), null);
  assert.strictEqual(fn({ courseName: 42 }), null);
});
