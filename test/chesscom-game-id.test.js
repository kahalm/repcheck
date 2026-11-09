'use strict';

// chess.com-Partie-Id beim Speichern (💾): nur aus echten Partie-Adressen (S1-007, Delta-Review 2026-11-09). Bis
// v1.74.0 las getGameMeta die Id mit einer offenen Regel und fiel sonst auf JEDE 6+-stellige Zahl im Pfad zurück; dazu
// holte es /callback/live/game/<n> (live, sobald kein `/daily/` im Pfad stand) und ersetzte Spieler und Züge durch die
// Antwort — auf /game/computer/<n> wäre das eine fremde Live-Partie mit derselben Nummer gewesen. Gleiches Muster wie
// lichess-game-id.test.js (N8-001): die reine Regel aus lib/repertoire-text.js und die Verdrahtung im ausgelieferten
// getGameMeta.

const test = require('node:test');
const assert = require('node:assert');

const { chessComGameId } = require('../extension/lib/repertoire-text.js');
const { finde } = require('./helpers/quelle.js');

// ─── Die Regel ──────────────────────────────────────────────────────────

test('chess.com: echte Partie-Adressen liefern Id und Art aus dem Pfad', () => {
  const faelle = {
    '/game/live/123456789': { id: '123456789', daily: false },
    '/game/daily/123': { id: '123', daily: true },
    '/game/123456789': { id: '123456789', daily: false },
    '/game/live/123456789/': { id: '123456789', daily: false },
    '/analysis/game/live/123456789': { id: '123456789', daily: false },
    '/analysis/game/live/123456789/review': { id: '123456789', daily: false },
    '/analysis/game/daily/987654': { id: '987654', daily: true },
    '/de/game/daily/42': { id: '42', daily: true },
  };
  for (const [pfad, erwartet] of Object.entries(faelle)) {
    assert.deepStrictEqual(chessComGameId(pfad), erwartet, pfad);
  }
});

test('chess.com: andere Seiten mit Zahlen im Pfad haben keine Partie-Id', () => {
  const keine = [
    '/game/computer/123456789', '/analysis/game/computer/123456789', '/analysis/game/123456789',
    '/game/review/123456789', '/games/archive/kahalm', '/puzzles/problem/1234567', '/member/user123456',
    '/analysis', '/analysis?tab=review', '/home', '/', '', null, undefined,
    '/game/live/abc', '/x/game/live/123456', '/game/live123456', '/game/1234567x',
  ];
  for (const pfad of keine) {
    assert.strictEqual(chessComGameId(pfad), null, String(pfad));
  }
});

// ─── Die Verdrahtung im ausgelieferten getGameMeta ──────────────────────

const GET_GAME_META = finde('async function getGameMeta()', '// ─── Export');

function ladeGetGameMeta(pathname) {
  const ruf = [];
  const stubs = {
    location: { pathname, href: 'https://www.chess.com' + pathname },
    detectSiteKey: () => 'chesscom',
    getGameResult: () => null,
    parsePlayersFromMeta: () => ({ white: 'W', black: 'B', whiteElo: null, blackElo: null }),
    fetchLichessGame: async () => { throw new Error('kein lichess-Abruf auf chess.com'); },
    fetchChessComHeaders: async (id, isDaily) => { ruf.push({ id, isDaily }); return { white: 'Fremd', black: 'Fremd', moves: ['e4'] }; },
    lichessGameId: () => null,
    chessComGameId,
  };
  const namen = Object.keys(stubs);
  const fn = new Function(...namen, GET_GAME_META + '\nreturn getGameMeta;');
  return { getGameMeta: fn(...namen.map(k => stubs[k])), ruf };
}

test('getGameMeta auf /game/computer/<n>: keine externalId, kein Callback-Abruf, DOM-Daten bleiben', async () => {
  for (const pfad of ['/game/computer/123456789', '/analysis/game/computer/123456789']) {
    const { getGameMeta, ruf } = ladeGetGameMeta(pfad);
    const meta = await getGameMeta();
    assert.strictEqual(meta.source, 'chess.com');
    assert.strictEqual(meta.externalId, null, pfad);
    assert.deepStrictEqual(ruf, [], pfad + ': kein Callback für eine Nicht-Partie');
    assert.strictEqual(meta.white, 'W');
    assert.strictEqual(meta.moves, null);
  }
});

test('getGameMeta: Tagespartie fragt den daily-Callback, Live-Partie den live-Callback', async () => {
  const daily = ladeGetGameMeta('/game/daily/123');
  const m1 = await daily.getGameMeta();
  assert.strictEqual(m1.externalId, '123');
  assert.deepStrictEqual(daily.ruf, [{ id: '123', isDaily: true }]);

  const live = ladeGetGameMeta('/analysis/game/live/123456789/review');
  const m2 = await live.getGameMeta();
  assert.strictEqual(m2.externalId, '123456789');
  assert.deepStrictEqual(live.ruf, [{ id: '123456789', isDaily: false }]);
  assert.deepStrictEqual(m2.moves, ['e4']);
});
