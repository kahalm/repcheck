'use strict';

// Charakterisierungstest fuer die FEN-Extraktion in extension/chessable-fen.js (Kern von
// "Copy FEN", "Search FEN", "Analyse" und "Remember line"). Bisher war sie ungetestet; der
// Codereview vom 2026-09-29 (S1-018) will chessable-fen.js zerlegen, u. a. in
// lib/fen-extract.js. Dieser Test haelt das HEUTIGE Verhalten fest, damit die Zerlegung beweisen
// kann, dass vorher und nachher dieselbe FEN herauskommt. Beim Umzug nur ladeFenExtraktion()
// auf die neue Datei umstellen — die Erwartungen bleiben.
//
// Getestet wird der ausgelieferte Code: der Abschnitt wird per Anker ausgeschnitten und gegen
// ein Mini-DOM ausgefuehrt (dieselbe Technik wie test/chessable-buttons.test.js). Das Brett im
// ersten Test ist echtes Chessable-Markup aus einem Inspector-Snapshot
// (test/fixtures/chessable-board-practice.html).

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

// ─── Mini-DOM: gerade genug fuer die Selektoren der FEN-Extraktion ─────────

class FakeEl {
  constructor(tag, attrs) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.children = [];
    this.parentElement = null;
  }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  get classList() {
    const liste = (this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    liste.contains = (c) => liste.includes(c);
    return liste;
  }
  get style() {
    const m = /transform\s*:\s*([^;]+)/.exec(this.getAttribute('style') || '');
    return { transform: m ? m[1].trim() : '' };
  }
  getBoundingClientRect() {
    const w = Number(this.getAttribute('data-fake-width')) || 0;
    return { left: 0, top: 0, width: w, height: w };
  }
  *nachfahren() {
    for (const k of this.children) { yield k; yield* k.nachfahren(); }
  }
  matches(sel) { return sel.split(',').some((teil) => passt(this, teil.trim())); }
  querySelectorAll(sel) { return [...this.nachfahren()].filter((e) => e.matches(sel)); }
  querySelector(sel) { for (const e of this.nachfahren()) if (e.matches(sel)) return e; return null; }
  closest(sel) { for (let e = this; e; e = e.parentElement) if (e.matches && e.matches(sel)) return e; return null; }
}

// Einfacher Verbund-Selektor: tag, #id, .klasse, [attr], [attr="w"], [attr*="w"].
function passt(el, sel) {
  const re = /^([\w-]+)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:(\*?=)"([^"]*)")?\]/g;
  let m, gelesen = 0;
  while ((m = re.exec(sel)) && m[0]) {
    if (m.index !== gelesen) throw new Error('Mini-DOM: Selektor nicht unterstuetzt: ' + sel);
    gelesen = re.lastIndex;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && el.getAttribute('id') !== m[2]) return false;
    if (m[3] && !el.classList.contains(m[3])) return false;
    if (m[4]) {
      const v = el.getAttribute(m[4]);
      if (v === null) return false;
      if (m[5] === '=' && v !== m[6]) return false;
      if (m[5] === '*=' && !v.includes(m[6])) return false;
    }
  }
  if (gelesen !== sel.length) throw new Error('Mini-DOM: Selektor nicht unterstuetzt: ' + sel);
  return true;
}

const LEER = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

function parseHtml(html) {
  const wurzel = new FakeEl('#root', {});
  let aktuell = wurzel;
  const re = /<!--[\s\S]*?-->|<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      for (let e = aktuell; e && e !== wurzel; e = e.parentElement) {
        if (e.tagName === m[1].toUpperCase()) { aktuell = e.parentElement; break; }
      }
    } else if (m[2]) {
      const attrs = {};
      for (const a of (m[3] || '').matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? '';
      }
      const el = new FakeEl(m[2], attrs);
      el.parentElement = aktuell === wurzel ? null : aktuell;
      aktuell.children.push(el);
      if (!m[4] && !LEER.has(m[2].toLowerCase())) aktuell = el;
    }
  }
  return wurzel;
}

function fakeDocument(html, seitenText = '') {
  const wurzel = parseHtml(html);
  return {
    wurzel,
    body: { innerText: seitenText },
    getElementById: (id) => wurzel.querySelector('#' + id),
    querySelector: (sel) => wurzel.querySelector(sel),
    querySelectorAll: (sel) => wurzel.querySelectorAll(sel),
  };
}

function ladeFenExtraktion(document) {
  const block = schnipsel(lies('extension/chessable-fen.js'),
    '  // ---------- FEN extraction ----------', '  // ---------- Clipboard ----------',
    'extension/chessable-fen.js');
  return new Function('document', 'location', "'use strict';\n" + block
    + '\nreturn { extractFenFromReact, extractBoardCm, extractBoardCg, extractBoard, buildFEN, isValidFen };')(
    document, { href: 'https://www.chessable.com/practice/1', pathname: '/practice/1' });
}

// ─── Echtes Chessable-Brett (cm-chessboard) ────────────────────────────────

const ECHTES_BRETT = lies('test/fixtures/chessable-board-practice.html');
// Unabhaengig aus den data-square/data-piece-Paaren des Snapshots ermittelt (25 Figuren).
const ECHTE_STELLUNG = 'r5k1/1pp2ppp/rb2b1q1/2B1Q3/1Ppp4/5N2/P4PPP/RN3RK1';
const GRUNDSTELLUNG = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('echtes Brett: cm-chessboard-Felder ergeben die angezeigte Stellung', () => {
  const fen = ladeFenExtraktion(fakeDocument(ECHTES_BRETT));
  assert.strictEqual(fen.extractBoardCm(), ECHTE_STELLUNG);
  assert.strictEqual(fen.extractBoard(), ECHTE_STELLUNG);
});

test('ohne React-Fiber: FEN aus dem Brett, Seite am Zug aus dem Seitentext, Rest fest', () => {
  const fall = (text) => ladeFenExtraktion(fakeDocument(ECHTES_BRETT, text)).buildFEN();
  assert.strictEqual(fall('Black to move'), ECHTE_STELLUNG + ' b KQkq - 0 1');
  assert.strictEqual(fall('Find the plan. White to play!'), ECHTE_STELLUNG + ' w KQkq - 0 1');
  assert.strictEqual(fall(''), ECHTE_STELLUNG + ' w KQkq - 0 1', 'ohne Hinweis: Weiss');
});

function mitFiber(document, kette) {
  // kette[0] haengt am Brett-Element, jedes weitere Glied ist fiber.return des vorigen.
  let fiber = null;
  for (let i = kette.length - 1; i >= 0; i--) fiber = { ...kette[i], return: fiber };
  document.getElementById('board')['__reactFiber$test1234'] = fiber;
  return document;
}

test('React-Fiber: bevorzugt die FEN, deren Figurenstand zum angezeigten Brett passt', () => {
  const passend = ECHTE_STELLUNG + ' w - - 3 21';
  const doc = mitFiber(fakeDocument(ECHTES_BRETT, 'Black to move'), [
    { memoizedProps: { className: 'x' }, pendingProps: null },
    { memoizedProps: { interactiveFen: GRUNDSTELLUNG, fen: '  ' + passend + '  ' } },
  ]);
  const fen = ladeFenExtraktion(doc);
  assert.strictEqual(fen.extractFenFromReact(), passend, 'getrimmt, und nicht die erste Kandidatin');
  assert.strictEqual(fen.buildFEN(), passend, 'Fiber-FEN schlaegt die Brett-Rekonstruktion');
});

test('React-Fiber: ohne Brett-Treffer gewinnt die erste gueltige Kandidatin', () => {
  const andere = '8/8/8/8/8/8/8/K6k w - - 0 1';
  const doc = mitFiber(fakeDocument(ECHTES_BRETT), [
    { memoizedProps: { fen: 'keine fen', interactiveFen: 42 }, pendingProps: { fen: andere } },
    { memoizedProps: { interactiveFen: GRUNDSTELLUNG } },
  ]);
  assert.strictEqual(ladeFenExtraktion(doc).extractFenFromReact(), andere,
    'ungueltige Werte zaehlen nicht; pendingProps des naeheren Knotens vor weiter oben');
});

test('React-Fiber ohne FEN-Props: zurueck zur Brett-Rekonstruktion', () => {
  const doc = mitFiber(fakeDocument(ECHTES_BRETT), [{ memoizedProps: { id: 'board' } }]);
  const fen = ladeFenExtraktion(doc);
  assert.strictEqual(fen.extractFenFromReact(), null);
  assert.strictEqual(fen.buildFEN(), ECHTE_STELLUNG + ' w KQkq - 0 1');
});

test('isValidFen: nur vollstaendige FEN mit sechs Feldern', () => {
  const { isValidFen } = ladeFenExtraktion(fakeDocument(''));
  assert.strictEqual(isValidFen(GRUNDSTELLUNG), true);
  assert.strictEqual(isValidFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'), false);
  assert.strictEqual(isValidFen('4k3/8/8/8/8/8/8/4K3 w - e3 0 1'), true);
  assert.strictEqual(isValidFen(null), false);
});

// ─── chessground-Fallback (falls Chessable die Brett-Engine wechselt) ──────

function cgBrett(orientierung) {
  // Brett 400 px breit -> 50 px je Feld; translate(x, y) = (Spalte, Zeile) auf dem Bildschirm.
  return `<div class="cg-wrap orientation-${orientierung}"><cg-container><cg-board data-fake-width="400">`
    + '<piece class="white king" style="transform: translate(150px, 0px);"></piece>'
    + '<piece class="black king" style="transform: translate(150px, 350px);"></piece>'
    + '<piece class="black queen" style="transform: translate(350px, 300px);"></piece>'
    + '<piece class="white pawn ghost" style="transform: translate(0px, 50px);"></piece>'
    + '<piece class="white rook fading" style="transform: translate(50px, 50px);"></piece>'
    + '</cg-board></cg-container></div>';
}

test('chessground: Schwarz unten — Felder werden gespiegelt, ghost/fading zaehlen nicht', () => {
  const fen = ladeFenExtraktion(fakeDocument(cgBrett('black')));
  assert.strictEqual(fen.extractBoardCm(), null, 'kein cm-chessboard auf der Seite');
  assert.strictEqual(fen.extractBoardCg(), '4k3/q7/8/8/8/8/8/4K3');
  assert.strictEqual(fen.buildFEN(), '4k3/q7/8/8/8/8/8/4K3 w KQkq - 0 1');
});

test('chessground: Weiss unten', () => {
  const fen = ladeFenExtraktion(fakeDocument(cgBrett('white')));
  assert.strictEqual(fen.extractBoard(), '3K4/8/8/8/8/8/7q/3k4');
});

test('kein Brett auf der Seite: keine FEN', () => {
  const fen = ladeFenExtraktion(fakeDocument('<div id="main"><p>Chessable</p></div>'));
  assert.strictEqual(fen.extractFenFromReact(), null);
  assert.strictEqual(fen.buildFEN(), null);
});
