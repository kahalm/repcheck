'use strict';

// chess.com-Partienuebersicht (v1.66.0): je Zeile ein Knopf „an RookHub schicken", und wo die Partie
// schon liegt, ein Haekchen mit Link statt des Knopfs. Gewuenscht am 24.09.2026; die Zeilen-Struktur
// stammt aus dem Schnappschuss desselben Tages (`.game-history-games-row`, Grid mit subgrid-Spalten,
// Aktionen-Zelle `.game-history-games-actions` mit Herz + Auswahlkaestchen).
//
// Getestet wird der AUSGELIEFERTE Code: der Uebersichts-Block wird per Anker aus
// extension/content.js ausgeschnitten und mit Stubs ausgefuehrt (Technik wie test/chessable-buttons.test.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8');

const BLOCK = (() => {
  const von = content.indexOf('const OVERVIEW_SWEEP_MS');
  const bis = content.indexOf('function updateStatusText(');
  assert.ok(von > 0 && bis > von, 'Uebersichts-Block nicht gefunden');
  return content.slice(von, bis);
})();

// ─── Winziges DOM, das genau die benutzten Aufrufe kennt ────────────────

function passt(el, sel) {
  if (sel.startsWith('.')) return el.className.split(/\s+/).includes(sel.slice(1));
  const m = sel.match(/^(\w+)\[(\w+)\*="([^"]+)"\]$/);   // a[href*="/game/"]
  if (m) return el.tag === m[1] && String(el.attrs[m[2]] || '').includes(m[3]);
  throw new Error('Selektor im Test nicht abgebildet: ' + sel);
}

function nachkommen(el, out) {
  for (const c of el.children) { out.push(c); nachkommen(c, out); }
  return out;
}

function el(tag, attrs) {
  const node = {
    tag,
    attrs: Object.assign({}, attrs),
    className: (attrs && attrs.class) || '',
    children: [],
    dataset: {},
    listeners: {},
    isConnected: true,
    textContent: '',
    title: '',
    href: '',
    disabled: false,
    type: '',
    target: '',
    rel: '',
    get childElementCount() { return node.children.length; },
    getAttribute: (name) => (name === 'class' ? node.className : node.attrs[name]),
    appendChild(child) { node.children.push(child); return child; },
    replaceChildren(...kinder) { node.children = kinder; },
    addEventListener(type, fn) { (node.listeners[type] = node.listeners[type] || []).push(fn); },
    klick() {
      let gestoppt = false;
      const ev = { preventDefault() { gestoppt = true; }, stopPropagation() { gestoppt = true; } };
      for (const fn of node.listeners.click || []) fn(ev);
      return gestoppt;
    },
    querySelector: (sel) => nachkommen(node, []).find(c => passt(c, sel)) || null,
    querySelectorAll: (sel) => nachkommen(node, []).filter(c => passt(c, sel)),
  };
  node.classList = {
    add: (c) => { node.className = (node.className ? node.className + ' ' : '') + c; },
    contains: (c) => node.className.split(/\s+/).includes(c),
  };
  return node;
}

/** Eine Archiv-Zeile wie im Schnappschuss: deckender Zeilen-Link + leere Aktionen-Zelle. */
function zeile(id, { kompakt = false, art = 'live' } = {}) {
  const row = el('div', { class: 'game-history-games-row' });
  row.appendChild(el('a', { class: 'game-history-games-row-link', href: `/game/${art}/${id}?username=kahalm` }));
  if (!kompakt) row.appendChild(el('div', { class: 'game-history-games-actions' }));
  return row;
}

function aufbau(zeilen, stubs = {}) {
  const wurzel = el('div', {});
  for (const z of zeilen) wurzel.appendChild(z);
  const document = {
    createElement: (tag) => el(tag, {}),
    querySelectorAll: (sel) => wurzel.querySelectorAll(sel),
  };
  const ruf = { known: [], gespeichert: [], header: [], styles: 0 };
  const echte = {
    t: (key) => key,
    detectSiteKey: () => 'chesscom',
    loadRookhubConfig: async () => ({ url: 'https://rookhub.example/', token: 'rkh_x' }),
    injectStyles: () => { ruf.styles++; },
    rookhubKnownGames: async (cfg, source, ids) => { ruf.known.push({ source, ids }); return []; },
    rookhubSaveGame: async (cfg, moves, meta) => { ruf.gespeichert.push({ moves, meta }); return { id: 42 }; },
    fetchChessComHeaders: async (id, daily) => {
      ruf.header.push({ id, daily });
      return { moves: ['e4', 'c5'], white: 'Anna', black: 'Bert', result: '1-0', playedAt: null,
        whiteElo: 1600, blackElo: 1650, timeControl: '180+2' };
    },
    setTimeout: () => 0,
  };
  const args = Object.assign(echte, stubs);
  const namen = ['document', ...Object.keys(args)];
  const fn = new Function(...namen, BLOCK + '\nreturn { syncOverviewGames, chessComGameRows };');
  return Object.assign({ api: fn(document, ...Object.keys(args).map(k => args[k])), ruf, wurzel }, {});
}

const host = (row) => row.querySelector('.rc-ov');
const inhalt = (row) => { const h = host(row); return h && h.children[0]; };

// ─── Zeilen finden ──────────────────────────────────────────────────────

test('nur Zahlen-Ids: /cheating & Co. sind keine Partien', () => {
  const echt = zeile('184299739920');
  const quatsch = el('div', { class: 'game-history-games-row' });
  quatsch.appendChild(el('a', { href: '/game/cheating' }));
  const { api } = aufbau([echt, quatsch]);

  const gefunden = api.chessComGameRows();
  assert.deepEqual(gefunden.map(e => e.id), ['184299739920']);
  assert.equal(gefunden[0].daily, false);
});

test('Fernschach-Partien werden als daily erkannt (eigener Callback-Pfad)', () => {
  const { api } = aufbau([zeile('7788', { art: 'daily' })]);
  assert.deepEqual(api.chessComGameRows().map(e => [e.id, e.daily]), [['7788', true]]);
});

// ─── Zeichnen ───────────────────────────────────────────────────────────

test('unbekannte Partie: Knopf in der Aktionen-Zelle, nicht als neues Rasterkind', async () => {
  const row = zeile('184299739920');
  const { api, ruf } = aufbau([row]);

  await api.syncOverviewGames();

  const zelle = row.querySelector('.game-history-games-actions');
  assert.equal(zelle.children.length, 1, 'Host haengt in der Aktionen-Zelle');
  assert.equal(row.children.length, 2, 'die Zeile selbst bekommt kein zusaetzliches Kind');
  const knopf = inhalt(row);
  assert.equal(knopf.tag, 'button');
  assert.equal(knopf.title, 'overview.send');
  assert.deepEqual(ruf.known, [{ source: 'chess.com', ids: ['184299739920'] }]);
});

test('ohne Aktionen-Zelle (Profilseite, kompakte Zeile) haengt der Knopf absolut in der Zeile', async () => {
  const row = zeile('184299739920', { kompakt: true });
  const { api } = aufbau([row]);

  await api.syncOverviewGames();

  const h = host(row);
  assert.ok(h.classList.contains('rc-ov-loose'), 'traegt die absolute Variante');
  assert.equal(row.children[row.children.length - 1], h);
});

test('schon uebertragen: Haekchen mit Link auf die Partie statt des Knopfs', async () => {
  const row = zeile('184299739920');
  const { api } = aufbau([row], {
    rookhubKnownGames: async () => [{ externalId: '184299739920', id: 7, analysis: { status: 'done' } }],
  });

  await api.syncOverviewGames();

  const haken = inhalt(row);
  assert.equal(haken.tag, 'a');
  assert.equal(haken.textContent, '✓');
  assert.equal(haken.href, 'https://rookhub.example/games/7');
  assert.equal(haken.title, 'overview.sent');
});

test('laufende Analyse: Sanduhr mit eigener Erklaerung', async () => {
  const row = zeile('184299739920');
  const { api } = aufbau([row], {
    rookhubKnownGames: async () => [{ externalId: '184299739920', id: 7, analysis: { status: 'running' } }],
  });

  await api.syncOverviewGames();
  assert.equal(inhalt(row).textContent, '⏳');
  assert.equal(inhalt(row).title, 'overview.analyzing');
});

test('zweiter Durchgang fragt nichts nach und zeichnet nicht neu', async () => {
  const row = zeile('184299739920');
  const { api, ruf } = aufbau([row]);

  await api.syncOverviewGames();
  const zuerst = inhalt(row);
  await api.syncOverviewGames();

  assert.equal(ruf.known.length, 1, 'die Antwort wird gemerkt');
  assert.equal(inhalt(row), zuerst, 'derselbe Knopf bleibt stehen');
});

test('nachgeladene Zeilen kommen im naechsten Durchgang dran', async () => {
  const erste = zeile('1');
  const { api, ruf, wurzel } = aufbau([erste]);
  await api.syncOverviewGames();

  const zweite = zeile('2');
  wurzel.appendChild(zweite);
  await api.syncOverviewGames();

  assert.deepEqual(ruf.known.map(a => a.ids), [['1'], ['2']], 'nur die neuen Ids werden erfragt');
  assert.equal(inhalt(zweite).tag, 'button');
});

test('hoechstens 300 Ids je Abfrage — der Rest kommt im naechsten Durchgang', async () => {
  const zeilen = Array.from({ length: 320 }, (_, i) => zeile(String(1000 + i)));
  const { api, ruf } = aufbau(zeilen);

  await api.syncOverviewGames();
  assert.equal(ruf.known[0].ids.length, 300);
  assert.equal(host(zeilen[310]), null, 'noch nicht erfragte Zeilen bleiben unberuehrt');

  await api.syncOverviewGames();
  assert.equal(ruf.known[1].ids.length, 20);
  assert.equal(inhalt(zeilen[310]).tag, 'button');
});

// ─── Schicken ───────────────────────────────────────────────────────────

test('Klick schickt die Partie mit Zuegen, Kopfdaten und analyze:true — und navigiert nicht', async () => {
  const row = zeile('184299739920');
  const { api, ruf } = aufbau([row]);
  await api.syncOverviewGames();

  const gestoppt = inhalt(row).klick();
  await new Promise(r => setImmediate(r));

  assert.ok(gestoppt, 'Zeilen-Klick wird gestoppt (die Zeile ist selbst ein Knopf mit deckendem Link)');
  assert.deepEqual(ruf.header, [{ id: '184299739920', daily: false }]);
  const [send] = ruf.gespeichert;
  assert.deepEqual(send.moves, ['e4', 'c5']);
  assert.equal(send.meta.source, 'chess.com');
  assert.equal(send.meta.externalId, '184299739920');
  assert.equal(send.meta.analyze, true);
  assert.equal(send.meta.white, 'Anna');
  assert.equal(send.meta.whiteElo, 1600);
  assert.equal(send.meta.timeControl, '180+2', 'die Bedenkzeit geht mit (RookHub >= 0.526.0 zeigt sie)');
  assert.equal(send.meta.sourceUrl, 'https://www.chess.com/game/live/184299739920');
  // Danach steht das Haekchen mit der neuen RookHub-Id da.
  assert.equal(inhalt(row).tag, 'a');
  assert.equal(inhalt(row).href, 'https://rookhub.example/games/42');
});

test('ohne Zuege wird nichts geschickt, der Knopf meldet den Grund', async () => {
  const row = zeile('184299739920');
  const { api, ruf } = aufbau([row], { fetchChessComHeaders: async () => null });
  await api.syncOverviewGames();

  inhalt(row).klick();
  await new Promise(r => setImmediate(r));

  assert.equal(ruf.gespeichert.length, 0);
  assert.equal(inhalt(row).textContent, '✗');
  assert.equal(inhalt(row).title, 'tools.saveNoMoves');
  assert.equal(inhalt(row).disabled, false, 'ein zweiter Versuch bleibt moeglich');
});

test('ein gescheiterter Versand nennt die Meldung des Servers', async () => {
  const row = zeile('184299739920');
  const { api } = aufbau([row], { rookhubSaveGame: async () => { throw new Error('Token ungueltig'); } });
  await api.syncOverviewGames();

  inhalt(row).klick();
  await new Promise(r => setImmediate(r));
  assert.equal(inhalt(row).title, 'Token ungueltig');
});

// ─── Wann der Durchgang gar nicht laeuft ────────────────────────────────

test('ohne Token wird nichts gezeichnet und nichts erfragt', async () => {
  const row = zeile('184299739920');
  const { api, ruf } = aufbau([row], { loadRookhubConfig: async () => ({ url: 'https://rookhub.example/' }) });

  await api.syncOverviewGames();

  assert.equal(host(row), null);
  assert.equal(ruf.known.length, 0);
  assert.equal(ruf.styles, 0);
});

test('auf lichess laeuft der chess.com-Durchgang nicht (Zeilen-Struktur ist dort anders)', async () => {
  const row = zeile('184299739920');
  const { api, ruf } = aufbau([row], { detectSiteKey: () => 'lichess' });

  await api.syncOverviewGames();

  assert.equal(host(row), null);
  assert.equal(ruf.known.length, 0);
});

// ─── Einbau im Content-Script ───────────────────────────────────────────

test('ein sparsamer Takt fasst nachgeladene Zeilen — chess.com aendert dabei weder Titel noch Adresse', () => {
  assert.match(content, /const OVERVIEW_SWEEP_MS = \d+;/);
  assert.match(content, /setInterval\(syncOverviewGames, OVERVIEW_SWEEP_MS\)/);
  assert.match(content, /addEventListener\('popstate', syncOverviewGames\)/);
});

test('der Host ist positioniert — sonst faengt der deckende Zeilen-Link jeden Klick', () => {
  const css = content.slice(content.indexOf('.rc-ov {'), content.indexOf('.rc-ov-btn {'));
  assert.match(css, /position: relative/);
  assert.match(css, /z-index/);
  // Die 80px-Zelle traegt schon zwei Knoepfe: passt der dritte nicht daneben, bricht er UM statt in
  // die Nachbarspalte zu laufen (chess.com setzt dort nowrap). Im Browser nachgemessen.
  assert.match(css, /\.game-history-games-actions \{ flex-wrap: wrap; \}/);
});

test('die Bedenkzeit reist von beiden Plattformen mit (RookHub >= 0.526.0 zeigt sie in der Liste)', () => {
  const save = content.slice(content.indexOf('async function rookhubSaveGame('), content.indexOf('async function rookhubKnownGames('));
  assert.match(save, /timeControl: meta\.timeControl/);
  // chess.com nennt sie in den pgnHeaders seiner Callback-Antwort, lichess im Export-PGN.
  const cc = content.slice(content.indexOf('async function fetchChessComHeaders('), content.indexOf('async function fetchLichessGame('));
  assert.match(cc, /timeControl: h\.TimeControl/);
  const li = content.slice(content.indexOf('async function fetchLichessGame('), content.indexOf('async function getGameMeta('));
  assert.match(li, /hdr\('TimeControl'\)/);
});

test('„known" ist best-effort: eine aeltere RookHub-Version liefert einfach keine Haekchen', () => {
  const fn = content.slice(content.indexOf('async function rookhubKnownGames('), content.indexOf('function buildShareLink('));
  assert.match(fn, /\/api\/extension\/games\/known/);
  assert.match(fn, /catch \(e\) \{\s*return \[\];/);
});
