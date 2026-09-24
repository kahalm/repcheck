'use strict';

// Partienuebersicht auf chess.com (v1.66.0) und lichess (v1.67.0): je Zeile ein Knopf „an RookHub schicken", und wo die Partie
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
  return sel.split(',').map(t => t.trim()).filter(Boolean).some(t => passtEinzeln(el, t));
}

/** Nur die Formen, die der Uebersichts-Block wirklich benutzt: `.klasse`, `tag.klasse`, `tag[attr*="x"]`, `tag[attr^="x"]`. */
function passtEinzeln(el, sel) {
  const m = sel.match(/^([a-z]+)?(?:\.([\w-]+))?(?:\[(\w+)([*^])="([^"]+)"\])?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) throw new Error('Selektor im Test nicht abgebildet: ' + sel);
  if (m[1] && el.tag !== m[1]) return false;
  if (m[2] && !el.className.split(/\s+/).includes(m[2])) return false;
  if (m[3]) {
    const wert = String(el.attrs[m[3]] || '');
    if (m[4] === '*' ? !wert.includes(m[5]) : !wert.startsWith(m[5])) return false;
  }
  return true;
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

/** lichess-Partienliste (Schnappschuss 24.09.2026): deckender Overlay-Link, Brett, Infos — keine Aktionen-Zelle. */
function lichessZeile(id, spieler = 'Pahan77') {
  const row = el('article', { class: 'game-row paginated' });
  row.appendChild(el('a', { class: 'game-row__overlay', href: `/${id}KGut` }));   // Id + Spieler-Anhang
  row.appendChild(el('div', { class: 'game-row__board' }));
  const infos = el('div', { class: 'game-row__infos' });
  infos.appendChild(el('a', { class: 'user-link ulpt', href: '/@/' + spieler }));
  row.appendChild(infos);
  return row;
}

function aufbau(zeilen, stubs = {}) {
  const wurzel = el('div', {});
  for (const z of zeilen) wurzel.appendChild(z);
  const document = {
    createElement: (tag) => el(tag, {}),
    querySelectorAll: (sel) => wurzel.querySelectorAll(sel),
  };
  const ruf = { known: [], gespeichert: [], header: [], analysiert: [], styles: 0 };
  const uhr = { jetzt: 1_000_000 };
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
    fetchLichessGame: async (id) => {
      ruf.header.push({ id, lichess: true });
      return { moves: ['d4', 'Nf6'], white: 'Pahan77', black: 'kahalm', result: '1-0', playedAt: null,
        whiteElo: 1837, blackElo: 1881, timeControl: '300+3' };
    },
    rookhubAnalyzeSavedGame: async (cfg, id) => { ruf.analysiert.push(id); return { analysis: { id: 99 } }; },
    // Eigene Uhr: der Durchgang fragt laufende Analysen erst nach 30 s wieder nach.
    Date: { now: () => uhr.jetzt },
    setTimeout: () => 0,
  };
  const args = Object.assign(echte, stubs);
  const namen = ['document', ...Object.keys(args)];
  const fn = new Function(...namen, BLOCK + '\nreturn { syncOverviewGames, chessComGameRows };');
  return Object.assign({ api: fn(document, ...Object.keys(args).map(k => args[k])), ruf, wurzel, uhr }, {});
}

const host = (row) => row.querySelector('.rc-ov');
const inhalt = (row) => { const h = host(row); return h && h.children[0]; };
/** Das zweite Element neben dem Haken: der Stand der RookHub-Analyse. */
const analyse = (row) => { const h = host(row); return h && h.children[1]; };

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

test('schon uebertragen und analysiert: Haken + 📈 auf die RookHub-Analyse, Genauigkeit im Tooltip', async () => {
  const row = zeile('184299739920');
  const { api } = aufbau([row], {
    rookhubKnownGames: async () => [{ externalId: '184299739920', id: 7,
      analysis: { status: 'done', analyzed: 105, total: 105, accuracyWhite: 87.4, accuracyBlack: 71.6 } }],
  });

  await api.syncOverviewGames();

  const haken = inhalt(row);
  assert.equal(haken.tag, 'a');
  assert.equal(haken.textContent, '✓');
  assert.equal(haken.href, 'https://rookhub.example/games/7');
  assert.equal(haken.title, 'overview.sent');
  const an = analyse(row);
  assert.equal(an.tag, 'a');
  assert.equal(an.textContent, '📈');
  assert.equal(an.href, 'https://rookhub.example/games/7');
  assert.equal(an.title, 'overview.openAnalysisAcc');
});

test('laufende Analyse: Haken + Sanduhr mit Fortschritt', async () => {
  const row = zeile('184299739920');
  const { api } = aufbau([row], {
    rookhubKnownGames: async () => [{ externalId: '184299739920', id: 7, analysis: { status: 'running', analyzed: 42, total: 105 } }],
  });

  await api.syncOverviewGames();
  assert.equal(inhalt(row).textContent, '✓');
  assert.equal(analyse(row).textContent, '⏳');
  assert.equal(analyse(row).title, 'overview.analyzingPct');
});

// Gemeldet 24.09.2026 („da fehlt noch das Icon fuer RookHub -> analyze"): eine Partie, die ueber 💾
// gespeichert wurde, lag bei RookHub, war aber nie gerechnet — und aus der Uebersicht liess sich das
// weder sehen noch aendern.
test('bei RookHub, aber nie analysiert: ein 📈-KNOPF stoesst die Analyse an und wird zur Sanduhr', async () => {
  const row = zeile('184299739920');
  const { api, ruf } = aufbau([row], {
    rookhubKnownGames: async () => [{ externalId: '184299739920', id: 7, analysis: null }],
  });
  await api.syncOverviewGames();

  const knopf = analyse(row);
  assert.equal(knopf.tag, 'button');
  assert.equal(knopf.title, 'overview.analyze');
  assert.ok(knopf.klick(), 'Klick wird gestoppt — die Zeile ist selbst ein Knopf mit deckendem Link');
  await new Promise(r => setImmediate(r));

  assert.deepEqual(ruf.analysiert, [7]);
  assert.equal(inhalt(row).textContent, '✓');
  assert.equal(analyse(row).textContent, '⏳');
});

test('gescheiterte Analyse zaehlt wie keine: der Knopf laedt zum Neuversuch', async () => {
  const row = zeile('184299739920');
  const { api } = aufbau([row], {
    rookhubKnownGames: async () => [{ externalId: '184299739920', id: 7, analysis: { status: 'failed' } }],
  });
  await api.syncOverviewGames();
  assert.equal(analyse(row).tag, 'button');
});

test('eine Absage des Servers steht am Knopf, statt eine Sanduhr vorzutaeuschen', async () => {
  const row = zeile('184299739920');
  const { api } = aufbau([row], {
    rookhubKnownGames: async () => [{ externalId: '184299739920', id: 7, analysis: null }],
    rookhubAnalyzeSavedGame: async () => { throw new Error('Keine Engine eingerichtet'); },
  });
  await api.syncOverviewGames();

  analyse(row).klick();
  await new Promise(r => setImmediate(r));

  assert.equal(analyse(row).tag, 'button');
  assert.equal(analyse(row).textContent, '✗');
  assert.equal(analyse(row).title, 'Keine Engine eingerichtet');
  assert.equal(analyse(row).disabled, false);
});

test('laufende Analysen werden nach 30 s nachgefragt — fertige und fremde nicht', async () => {
  const laeuft = zeile('1');
  const fertig = zeile('2');
  let antwort = [
    { externalId: '1', id: 11, analysis: { status: 'running', analyzed: 10, total: 100 } },
    { externalId: '2', id: 12, analysis: { status: 'done' } },
  ];
  const { api, ruf, uhr } = aufbau([laeuft, fertig], {
    rookhubKnownGames: async (cfg, source, ids) => { ruf.known.push({ source, ids }); return antwort.filter(g => ids.includes(g.externalId)); },
  });
  await api.syncOverviewGames();
  assert.equal(analyse(laeuft).textContent, '⏳');

  uhr.jetzt += 10_000;
  await api.syncOverviewGames();
  assert.equal(ruf.known.length, 1, 'vor Ablauf der 30 s keine neue Abfrage');

  antwort = [{ externalId: '1', id: 11, analysis: { status: 'done', accuracyWhite: 90, accuracyBlack: 80 } }];
  uhr.jetzt += 25_000;
  await api.syncOverviewGames();
  assert.deepEqual(ruf.known[1].ids, ['1'], 'nur die laufende wird nachgefragt');
  assert.equal(analyse(laeuft).textContent, '📈', 'fertig: aus der Sanduhr wird der Analyse-Link');
  assert.equal(analyse(fertig).textContent, '📈');
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
  // Danach steht das Haekchen mit der neuen RookHub-Id da — und die Sanduhr der gerade eingereihten Analyse.
  assert.equal(inhalt(row).tag, 'a');
  assert.equal(inhalt(row).href, 'https://rookhub.example/games/42');
  assert.equal(analyse(row).textContent, '⏳');
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

test('auf einer fremden Seite (chessable) ruht der Durchgang', async () => {
  const row = zeile('184299739920');
  const { api, ruf } = aufbau([row], { detectSiteKey: () => 'chessable' });

  await api.syncOverviewGames();

  assert.equal(host(row), null);
  assert.equal(ruf.known.length, 0);
});

// ─── lichess ────────────────────────────────────────────────────────────

test('lichess: Id sind die ersten ACHT Zeichen des Overlay-Links (der traegt den Spieler-Anhang)', async () => {
  const row = lichessZeile('8NPpBdrS');
  const { api, ruf } = aufbau([row], { detectSiteKey: () => 'lichess' });

  await api.syncOverviewGames();

  assert.deepEqual(ruf.known, [{ source: 'lichess', ids: ['8NPpBdrS'] }]);
  assert.equal(inhalt(row).tag, 'button');
});

test('lichess: ohne Aktionen-Zelle haengt der Knopf absolut in der Zeile', async () => {
  const row = lichessZeile('8NPpBdrS');
  const { api } = aufbau([row], { detectSiteKey: () => 'lichess' });

  await api.syncOverviewGames();

  assert.ok(host(row).classList.contains('rc-ov-loose'));
  assert.equal(row.children[row.children.length - 1], host(row));
});

test('lichess: geschickt wird mit der Export-API und der lichess-Quelle', async () => {
  const row = lichessZeile('8NPpBdrS');
  const { api, ruf } = aufbau([row], { detectSiteKey: () => 'lichess' });
  await api.syncOverviewGames();

  inhalt(row).klick();
  await new Promise(r => setImmediate(r));

  assert.deepEqual(ruf.header, [{ id: '8NPpBdrS', lichess: true }]);
  const [send] = ruf.gespeichert;
  assert.equal(send.meta.source, 'lichess');
  assert.equal(send.meta.externalId, '8NPpBdrS');
  assert.equal(send.meta.sourceUrl, 'https://lichess.org/8NPpBdrS');
  assert.equal(send.meta.analyze, true);
  assert.equal(send.meta.timeControl, '300+3');
  assert.deepEqual(send.moves, ['d4', 'Nf6']);
  assert.equal(inhalt(row).href, 'https://rookhub.example/games/42');
});

test('lichess: der Profil-Link daneben ist keine Partie', async () => {
  const row = el('article', { class: 'game-row' });
  row.appendChild(el('a', { class: 'user-link', href: '/@/kahalm' }));
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

test('„In RookHub analysieren" geht ueber die Extension-Flaeche (das API-Token erreicht /api/games nicht)', () => {
  const fn = content.slice(content.indexOf('async function rookhubAnalyzeSavedGame('), content.indexOf('// Öffentlicher Teilen-Link'));
  assert.match(fn, /\/api\/extension\/games\/' \+ encodeURIComponent\(id\) \+ '\/analyze'/);
  assert.match(fn, /no-engine/);
  assert.match(fn, /too-many-open/);
});

test('„known" ist best-effort: eine aeltere RookHub-Version liefert einfach keine Haekchen', () => {
  const fn = content.slice(content.indexOf('async function rookhubKnownGames('), content.indexOf('function buildShareLink('));
  assert.match(fn, /\/api\/extension\/games\/known/);
  assert.match(fn, /catch \(e\) \{\s*return \[\];/);
});
