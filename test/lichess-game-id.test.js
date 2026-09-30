'use strict';

// lichess-Partie-Id beim Speichern (💾): nur aus echten Partie-Adressen. Bis v1.68.6 las getGameMeta
// die ersten acht Zeichen JEDES Pfads (Regex ohne Ende-Anker) — auf dem Analysebrett also „analysis",
// auf /broadcast/… „broadcas". RookHub dedupliziert über (User, Quelle, externalId): alle dort
// gespeicherten Partien eines Nutzers fielen auf EINEN Datensatz, eine längere überschrieb die frühere
// hinter ihrem Teilen-Link, eine kürzere bekam den Link der alten zurück (Review 2026-09-29, N8-001).
//
// Zwei Teile: die reine Regel aus lib/repertoire-text.js und die Verdrahtung im AUSGELIEFERTEN
// getGameMeta (per Anker aus extension/content.js ausgeschnitten, mit Stubs ausgeführt).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { lichessGameId } = require('../extension/lib/repertoire-text.js');

const ROOT = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8');

// ─── Die Regel ──────────────────────────────────────────────────────────

test('echte Partie-Adressen liefern die achtstellige Partie-Id', () => {
  const faelle = {
    '/abcdefgh': 'abcdefgh',
    '/abcdefgh/': 'abcdefgh',
    '/abcdefgh/white': 'abcdefgh',
    '/abcdefgh/black': 'abcdefgh',
    '/Xy12Ab9Q': 'Xy12Ab9Q',
    '/abcdefgh1234': 'abcdefgh',        // Sicht eines Spielers: Id + vier Zeichen Spieler-Anhang
    '/abcdefgh1234/black': 'abcdefgh',
  };
  for (const [pfad, id] of Object.entries(faelle)) {
    assert.strictEqual(lichessGameId(pfad), id, pfad);
  }
});

test('Analysebrett, Übertragungen, Studien und andere Seiten haben keine Partie-Id', () => {
  const keine = [
    '/analysis', '/analysis/', '/analysis/standard', '/analysis/fromPosition',
    '/analysis/rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR_b_KQkq_-_0_1',
    '/broadcast', '/broadcast/tata-steel-2026/round-1/AbCdEfGh', '/broadcast/tata-steel-2026/AbCdEfGh',
    '/study/AbCdEfGh', '/study/AbCdEfGh/IjKlMnOp',
    '/training', '/training/', '/training/mateIn2', '/practice', '/practice/checkmates/piece-checkmates-i/BJy6fEDf/fE4k21MW',
    '/tutorial', '/insights', '/insights/kahalm/acpl/opening', '/streamer', '/features', '/timeline', '/calendar',
    '/Analysis',                           // Groß-/Kleinschreibung ändert nichts an der Seite
    '/', '', null, undefined,
    '/abcdefg',                            // sieben Zeichen
    '/abcdefghi',                          // neun Zeichen (weder Id noch Id + Spieler)
    '/abcdefgh/edit', '/abcdefgh/white/x', '/@/kahalm', '/tv', '/embed/game/abcdefgh',
  ];
  for (const pfad of keine) {
    assert.strictEqual(lichessGameId(pfad), null, String(pfad));
  }
});

// ─── Die Verdrahtung im ausgelieferten getGameMeta ──────────────────────

const GET_GAME_META = (() => {
  const von = content.indexOf('async function getGameMeta()');
  const bis = content.indexOf('function analyzeGame(', von);
  assert.ok(von > 0 && bis > von, 'getGameMeta nicht gefunden');
  return content.slice(von, bis);
})();

function ladeGetGameMeta(pathname, { site = 'lichess' } = {}) {
  const ruf = { lichess: [], chesscom: [] };
  const stubs = {
    location: { pathname, href: 'https://lichess.org' + pathname },
    detectSiteKey: () => site,
    getGameResult: () => null,
    parsePlayersFromMeta: () => ({ white: 'W', black: 'B', whiteElo: null, blackElo: null }),
    fetchLichessGame: async (id) => { ruf.lichess.push(id); return null; },
    fetchChessComHeaders: async (id) => { ruf.chesscom.push(id); return null; },
    lichessGameId,
  };
  const namen = Object.keys(stubs);
  const fn = new Function(...namen, GET_GAME_META + '\nreturn getGameMeta;');
  return { getGameMeta: fn(...namen.map(k => stubs[k])), ruf };
}

test('getGameMeta auf dem Analysebrett: keine externalId, kein Export-Abruf', async () => {
  for (const pfad of ['/analysis', '/analysis/standard', '/broadcast/tata-steel-2026/round-1/AbCdEfGh', '/training']) {
    const { getGameMeta, ruf } = ladeGetGameMeta(pfad);
    const meta = await getGameMeta();
    assert.strictEqual(meta.externalId, null, pfad);
    assert.strictEqual(meta.source, 'lichess');
    assert.deepStrictEqual(ruf.lichess, [], pfad + ': kein Abruf der Export-API für eine Nicht-Partie');
  }
});

test('getGameMeta auf einer echten Partie: Id aus der Adresse, Export-API wird gefragt', async () => {
  const { getGameMeta, ruf } = ladeGetGameMeta('/AbCd1234wXyZ/black');
  const meta = await getGameMeta();
  assert.strictEqual(meta.externalId, 'AbCd1234');
  assert.deepStrictEqual(ruf.lichess, ['AbCd1234']);
});
