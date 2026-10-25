'use strict';

// Charakterisierung der reinen Teile von content.js (chess.com/lichess) VOR der Zerlegung Z37: Abweichungs-Analyse
// gegen ein lokales Positions-Set, FEN vor einem Zug, Elo/Namen aus dem Seitentitel, PGN zum Kopieren, Ergebnis aus
// der Zugliste, Teilen-Link und die SAN-Auslese der Site-Adapter. Die Funktionen werden per Anker geschnitten
// (test/helpers/quelle.js sucht sie in allen Laufzeitdateien) und mit Stubs ausgefuehrt — nach dem Umzug pruefen
// dieselben Tests dieselben Funktionen am neuen Ort.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { finde } = require('./helpers/quelle.js');
const Lib = require('../extension/lib/repertoire-text.js');

// chess.js wie im Browser als globales `Chess` (klassisches Skript).
const chessCtx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'chess.min.js'), 'utf8'), chessCtx);
const Chess = chessCtx.Chess;

function analyse(positionen) {
  // Das Positions-Set gehoert content.js; seit der Zerlegung Z37 liest analyzeGame es ueber das Zustandsobjekt S.
  const src = finde('function analyzeGame(gameMoves) {', '// Stellt sicher, dass repertoirePositions geladen ist.');
  return new Function('Chess', 'normalizedFen', 'S', src + '\nreturn { analyzeGame, fenBeforeMove };')(
    Chess, Lib.normalizedFen, { repertoirePositions: positionen });
}

function setAus(zuege) {
  const c = new Chess();
  const s = new Set([Lib.normalizedFen(c.fen())]);
  for (const z of zuege) { c.move(z); s.add(Lib.normalizedFen(c.fen())); }
  return s;
}

test('analyzeGame: ohne Positions-Set keine Abweichung', () => {
  assert.deepStrictEqual(analyse(null).analyzeGame(['e4']), { deviation: -1, gaps: [] });
});

test('analyzeGame: Abweichung, Luecke (Zugumstellung) und Repertoire-Zuege', () => {
  // Repertoire: 1.e4 e5 2.Nf3 Nc6 3.Bb5 — Partie: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 (ab Zug 5 raus)
  const { analyzeGame } = analyse(setAus(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']));
  assert.deepStrictEqual(analyzeGame(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']),
    { deviation: 4, gaps: [], inRepertoire: [0, 1, 2, 3] });
  // Zugumstellung: 1.Nf3 Nc6 2.e4 e5 3.Bb5 kehrt ins Repertoire zurueck — die Zuege davor sind Luecken, keine
  // Abweichung. (Nach 2...e5 steht das e.p.-Feld e6 in der FEN, die Stellung zaehlt dort also noch nicht.)
  const r = analyzeGame(['Nf3', 'Nc6', 'e4', 'e5', 'Bb5']);
  assert.deepStrictEqual(r, { deviation: -1, gaps: [0, 1, 2, 3], inRepertoire: [4] });
  // Illegaler Zug: Auswertung bricht ab, der Zug zaehlt als draussen.
  assert.deepStrictEqual(analyzeGame(['e4', 'Ke7']), { deviation: 1, gaps: [], inRepertoire: [0] });
});

test('fenBeforeMove: Stellung VOR dem Zug mit Index idx, illegaler Zug stoppt', () => {
  const { fenBeforeMove } = analyse(null);
  assert.strictEqual(fenBeforeMove(['e4', 'e5', 'Nf3'], 0), new Chess().fen());
  assert.strictEqual(fenBeforeMove(['e4', 'e5', 'Nf3'], 2), 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2');
  assert.strictEqual(fenBeforeMove(['e4', 'Ke7', 'Nf3'], 3), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
});

function meta(docTitle, ogTitle) {
  const src = finde('function parseElo(v) {', '// chessComPlayedAt');
  const document = {
    title: docTitle,
    querySelector: (sel) => (sel === 'meta[property="og:title"]' && ogTitle != null ? { content: ogTitle } : null),
  };
  return new Function('document', src + '\nreturn { parseElo, splitNameElo, parsePlayersFromMeta };')(document);
}

test('parseElo: nur 100–4000, Ziffern aus Text', () => {
  const { parseElo } = meta('');
  assert.strictEqual(parseElo('1850'), 1850);
  assert.strictEqual(parseElo('(2012)'), 2012);
  assert.strictEqual(parseElo(99), null);
  assert.strictEqual(parseElo(4001), null);
  assert.strictEqual(parseElo(undefined), null);
  assert.strictEqual(parseElo('?'), null);
});

test('splitNameElo + parsePlayersFromMeta: og:title vor document.title, Elo in Klammern', () => {
  const { splitNameElo } = meta('');
  assert.deepStrictEqual(splitNameElo(' Magnus (2850) '), { name: 'Magnus', elo: 2850 });
  assert.deepStrictEqual(splitNameElo('Hikaru'), { name: 'Hikaru', elo: null });
  assert.deepStrictEqual(meta('egal', 'Alice (1500) vs Bob (1620) in Rapid').parsePlayersFromMeta(),
    { white: 'Alice', black: 'Bob', whiteElo: 1500, blackElo: 1620 });
  assert.deepStrictEqual(meta('Carla – Dora • lichess.org', null).parsePlayersFromMeta(),
    { white: 'Carla', black: 'Dora', whiteElo: null, blackElo: null });
  assert.deepStrictEqual(meta('Nur ein Titel', null).parsePlayersFromMeta(),
    { white: null, black: null, whiteElo: null, blackElo: null });
});

test('buildGamePgn: Zugnummern, Seite, Datum, leer ohne Zuege', () => {
  const src = finde('function buildGamePgn() {', 'async function copyGamePgn() {');
  const bau = (moves) => new Function('getGameMoves', 'location', 'Date', src + '\nreturn buildGamePgn;')(
    () => moves, { href: 'https://lichess.org/abcdefgh' },
    class extends Date { constructor() { super('2026-10-25T12:00:00Z'); } })();
  assert.strictEqual(bau([]), '');
  assert.strictEqual(bau(['e4', 'e5', 'Nf3']),
    '[Event "?"]\n[Site "https://lichess.org/abcdefgh"]\n[Date "2026.10.25"]\n[White "?"]\n[Black "?"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *\n');
});

test('getGameResult: Ergebnis-Token der Zugliste, ½-½ wird 1/2-1/2', () => {
  const src = finde('function getGameResult() {', '// Elo/Rating plausibilisieren');
  const mit = (text) => new Function('getAdapter', src + '\nreturn getGameResult;')(
    () => ({ getMoveListEl: () => (text == null ? null : { textContent: text }) }))();
  assert.strictEqual(mit('1. e4 e5 1-0'), '1-0');
  assert.strictEqual(mit('… ½-½'), '1/2-1/2');
  assert.strictEqual(mit('1. d4'), null);
  assert.strictEqual(mit(null), null);
});

test('buildShareLink: {url}/g/{token}, Slash am Ende weg, ohne Token leer', () => {
  const src = finde('function buildShareLink(cfg, saved) {', '// ─── Export');
  const link = new Function(src + '\nreturn buildShareLink;')();
  assert.strictEqual(link({ url: 'https://rh.example/' }, { shareToken: 'abc' }), 'https://rh.example/g/abc');
  assert.strictEqual(link({ url: 'https://rh.example' }, { ShareToken: 'X' }), 'https://rh.example/g/X');
  assert.strictEqual(link({ url: 'https://rh.example' }, {}), '');
  assert.strictEqual(link(null, { shareToken: 'abc' }), '');
});

// ─── Site-Adapter: SAN aus den Zugknoten ─────────────────────────────────────

function knoten(text, entfernbar = [], figurine = null) {
  return {
    cloneNode: () => ({
      querySelectorAll: (sel) => entfernbar.filter((e) => sel.split(', ').includes(e.tag)).map((e) => ({ remove() { text = text.replace(e.text, ''); } })),
      get textContent() { return text; },
    }),
    querySelector: (sel) => (sel === '[data-figurine]' && figurine ? { getAttribute: () => figurine } : null),
  };
}

function adapter() {
  const src = finde('const LICHESS_FIGURINES = {', '// ─── Export');
  return new Function('document', 'location', src + '\nreturn ADAPTERS;')({ querySelector: () => null }, { pathname: '/' });
}

test('chess.com extractSan: Figurine aus data-figurine, Nummer/Glyphen/Ergebnis weg, <style> der SVG ignoriert', () => {
  const { chesscom } = adapter();
  assert.strictEqual(chesscom.extractSan(knoten('f3', [], 'N')), 'Nf3');
  assert.strictEqual(chesscom.extractSan(knoten('12. exd5!?')), 'exd5');
  assert.strictEqual(chesscom.extractSan(knoten('Qh5.fill{}', [{ tag: 'style', text: '.fill{}' }])), 'Qh5');
  assert.strictEqual(chesscom.extractSan(knoten('1-0')), '');
});

test('lichess extractSan: Figurinen-Zeichen → Buchstaben, Bewertung/Glyphe entfernt', () => {
  const { lichess } = adapter();
  assert.strictEqual(lichess.extractSan(knoten('♘f3')), 'Nf3');
  assert.strictEqual(lichess.extractSan(knoten('♛xd8+?')), 'Qxd8+');
  assert.strictEqual(lichess.extractSan(knoten('e4+0.3', [{ tag: 'eval', text: '+0.3' }])), 'e4');
  assert.strictEqual(lichess.extractSan(knoten('1/2-1/2')), '');
});

test('Adapter-Erkennung am Host', () => {
  const { chesscom, lichess } = adapter();
  assert.ok(chesscom.test('www.chess.com') && chesscom.test('chess.com') && chesscom.test('de.chess.com'));
  assert.ok(!chesscom.test('notchess.com'));
  assert.ok(lichess.test('lichess.org') && lichess.test('de.lichess.org'));
  assert.ok(!lichess.test('lichess.org.evil.example'));
});

test('lib/site-adapters.js: als Modul ladbar, liefert dieselben Adapter wie im Browser (self.RepCheckSiteAdapters)', () => {
  const lib = require('../extension/lib/site-adapters.js');
  assert.deepStrictEqual(Object.keys(lib.ADAPTERS), ['chesscom', 'lichess']);
  for (const a of Object.values(lib.ADAPTERS)) {
    for (const k of ['test', 'isReviewPage', 'getMoveListEl', 'getMoveNodes', 'extractSan']) assert.strictEqual(typeof a[k], 'function', k);
  }
  assert.strictEqual(lib.LICHESS_FIGURINES['♞'], 'N');
});
