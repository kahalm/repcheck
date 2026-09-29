'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  tokenizePgn, isMoveToken, parseMoveTokens, parsePgnText,
  normalizedFen, chessComPlayedAt, chessableSearchUrl,
} = require('../extension/lib/repertoire-text.js');

test('tokenizePgn strips comments, NAGs and splits parentheses', () => {
  assert.deepStrictEqual(
    tokenizePgn('1. e4 e5 {good} $1 2. Nf3 (2. f4) Nc6'),
    ['1.', 'e4', 'e5', '2.', 'Nf3', '(', '2.', 'f4', ')', 'Nc6']
  );
  assert.deepStrictEqual(tokenizePgn('  e4   e5  '), ['e4', 'e5']);
});

test('isMoveToken accepts SAN, rejects numbers/results/parens', () => {
  for (const t of ['e4', 'Nf3', 'O-O', 'Qxh7+', 'a8=Q', 'O-O-O']) {
    assert.strictEqual(isMoveToken(t), true, t);
  }
  for (const t of ['1.', '12.', '1...', '1-0', '0-1', '1/2-1/2', '*', '(', ')', '', null]) {
    assert.strictEqual(isMoveToken(t), false, String(t));
  }
});

test('parseMoveTokens builds main line and attaches variations to the last move', () => {
  const tokens = tokenizePgn('1. e4 e5 (1... c5 2. Nf3) 2. Nf3');
  const { moves } = parseMoveTokens(tokens, 0);
  assert.deepStrictEqual(moves.map(m => m.san), ['e4', 'e5', 'Nf3']);
  // Variante hängt am 2. Zug (e5)
  assert.strictEqual(moves[1].variations.length, 1);
  assert.deepStrictEqual(moves[1].variations[0].map(m => m.san), ['c5', 'Nf3']);
  assert.strictEqual(moves[0].variations.length, 0);
});

test('parsePgnText parses a game with headers', () => {
  const pgn = '[Event "Test"]\n[White "A"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n';
  const games = parsePgnText(pgn);
  assert.strictEqual(games.length, 1);
  assert.deepStrictEqual(games[0].map(m => m.san), ['e4', 'e5', 'Nf3', 'Nc6']);
});

test('parsePgnText parses bare movetext without headers', () => {
  const games = parsePgnText('1. d4 d5 2. c4');
  assert.strictEqual(games.length, 1);
  assert.deepStrictEqual(games[0].map(m => m.san), ['d4', 'd5', 'c4']);
});

// ChessBase, Fritz und SCID exportieren „1.e4" OHNE Leerzeichen. Das Token begann mit einer Ziffer, fiel
// durch isMoveToken und wurde still verworfen: alle Weißzüge fehlten, der lokale Modus meldete jede Partie
// ab Zug 1 als Abweichung. Die Literale spiegeln RookHubs PgnMoveTreeTests (Tokenize_SplitsMoveNumbers…),
// dort ist derselbe Fehler serverseitig behoben.
const sans = (moves) => moves.map(m => m.san);

test('tokenizePgn trennt Zugnummern, die am Zug kleben ("1.e4", "12...Nf6")', () => {
  assert.deepStrictEqual(tokenizePgn('1.e4 e5 2.Nf3 Nf6'), tokenizePgn('1. e4 e5 2. Nf3 Nf6'));
  assert.deepStrictEqual(tokenizePgn('12...Nf6'), ['12...', 'Nf6']);
  assert.deepStrictEqual(tokenizePgn('1.e4 c5 (1...e5 2.Nf3) 2.Nf3'),
    ['1.', 'e4', 'c5', '(', '1...', 'e5', '2.', 'Nf3', ')', '2.', 'Nf3']);
});

// Gegenlese S1-003: Mit (?=\S) ging \.+ einen Punkt zurück, die gespreizte Schwarz-Nummer „1... e5"
// wurde zu „1.." „." — folgenlos für parsePgnText, aber nicht mehr „die Nummer als eigenes Token".
test('tokenizePgn lässt gespreizte Zugnummern ("1... e5", "12... Nf6") ganz', () => {
  assert.deepStrictEqual(tokenizePgn('1. e4 e5 (1... c5 2. Nf3) 12... Nf6'),
    ['1.', 'e4', 'e5', '(', '1...', 'c5', '2.', 'Nf3', ')', '12...', 'Nf6']);
  assert.deepStrictEqual(tokenizePgn('1.. e5'), ['1..', 'e5']);
  assert.deepStrictEqual(tokenizePgn('1...'), ['1...']);
  assert.deepStrictEqual(tokenizePgn('(1...e5 2.Nf3)2.Nf3'),
    ['(', '1...', 'e5', '2.', 'Nf3', ')', '2.', 'Nf3']);
});

test('parsePgnText liest kompakte Zugnummern samt Varianten', () => {
  assert.deepStrictEqual(parsePgnText('1.e4 e5 2.Nf3 Nf6').map(sans), [['e4', 'e5', 'Nf3', 'Nf6']]);
  assert.deepStrictEqual(parsePgnText('[Event "x"]\n\n1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 *\n').map(sans),
    [['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']]);
  const [game] = parsePgnText('[Event "x"]\n\n1.e4 c5 (1...e5 2.Nf3) 2.Nf3 *');
  assert.deepStrictEqual(sans(game), ['e4', 'c5', 'Nf3']);
  assert.deepStrictEqual(game[1].variations.map(sans), [['e5', 'Nf3']]);
});

// Die Zeilen wurden mit Leerzeichen verbunden, BEVOR tokenizePgn die „;"-Kommentare bis zum Zeilenende
// entfernte — ein „;" kappte damit den ganzen Rest der Partie.
test('parsePgnText: ";"-Kommentar endet am Zeilenende, nicht am Partieende', () => {
  assert.deepStrictEqual(parsePgnText('[Event "x"]\n\n1. e4 ; Kommentar\n1... e5 2. Nf3 *').map(sans),
    [['e4', 'e5', 'Nf3']]);
  assert.deepStrictEqual(parsePgnText('1. e4 ; bis Zeilenende\n e5').map(sans), [['e4', 'e5']]);
});

test('parsePgnText: ";" in einem mehrzeiligen {…}-Kommentar gehört zum Kommentar', () => {
  assert.deepStrictEqual(parsePgnText('[Event "x"]\n\n1. e4 {Idee; mehr\nText} e5 2. Nf3 *').map(sans),
    [['e4', 'e5', 'Nf3']]);
});

// Das Fehlerbild im lokalen Modus: buildPositionSetFromPgns (content.js) bricht beim ersten illegalen Zug ab —
// ohne Weißzüge ist schon „e5" aus der Grundstellung illegal, das Set hielt nur die Grundstellung.
test('content.js: Positions-Set aus kompakter PGN = Positions-Set aus PGN mit Leerzeichen', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { Chess } = require('../extension/chess.min.js');
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');
  const von = src.indexOf('function walkMovesForPositions(');
  const bis = src.indexOf('// ─── File Loading', von);
  assert.ok(von >= 0 && bis > von, 'Anker in content.js nicht gefunden');
  const build = new Function('Chess', 'parsePgnText', 'normalizedFen', 'console',
    src.slice(von, bis) + '\nreturn buildPositionSetFromPgns;')(Chess, parsePgnText, normalizedFen, { warn() {} });
  const kompakt = build(['[Event "x"]\n\n1.e4 e5 2.Nf3 Nc6 (2...d6 3.d4) 3.Bb5 a6 *']);
  const gespreizt = build(['[Event "x"]\n\n1. e4 e5 2. Nf3 Nc6 (2... d6 3. d4) 3. Bb5 a6 *']);
  assert.strictEqual(kompakt.size, 9);   // Grundstellung + 6 Hauptzüge + 2 Variantenzüge
  assert.deepStrictEqual([...kompakt].sort(), [...gespreizt].sort());
});

test('parsePgnText returns empty for empty input', () => {
  assert.deepStrictEqual(parsePgnText('   '), []);
});

test('normalizedFen keeps only the first four FEN fields', () => {
  assert.strictEqual(
    normalizedFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'),
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3'
  );
});

test('chessComPlayedAt builds an ISO timestamp from chess.com headers', () => {
  assert.strictEqual(
    chessComPlayedAt({ Date: '2026.06.30', EndTime: '12:34:56' }),
    '2026-06-30T12:34:56.000Z'
  );
  // ohne EndTime → Mitternacht
  assert.strictEqual(
    chessComPlayedAt({ Date: '2026.06.30' }),
    '2026-06-30T00:00:00.000Z'
  );
});

test('chessComPlayedAt returns null for missing/invalid date', () => {
  assert.strictEqual(chessComPlayedAt(null), null);
  assert.strictEqual(chessComPlayedAt({}), null);
  assert.strictEqual(chessComPlayedAt({ Date: '30.06.2026' }), null); // falsches Format
});

test('chessableSearchUrl uses Chessable-specific encoding (/ -> U, space -> %20)', () => {
  assert.strictEqual(
    chessableSearchUrl('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
    'https://www.chessable.com/courses/fen/rnbqkbnrUppppppppU8U8U8U8UPPPPPPPPURNBQKBNR%20w%20KQkq%20-%200%201/'
  );
});
