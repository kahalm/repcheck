'use strict';

// ♟-Prüfung: ein Fehlschlag ist am Knopf zu sehen (Review 2026-09-29, S1-015). Bis v1.68.7 meldete
// runCheck jeden Fehler über showBanner — seit v1.14.0 ein No-op. Ein widerrufener Token (401), kein
// Repertoire oder keine Züge endeten also stumm, nur console.warn. Jetzt zeigt der ♟-Knopf ✗ und den
// übersetzten Grund im title und nach 3 s wieder ♟ (wie 💾).
//
// Getestet wird der AUSGELIEFERTE Code: der Prüf-Block und rookhubAnalyzeGame werden per Anker aus
// extension/content.js ausgeschnitten und mit Stubs ausgeführt (Technik wie test/uebersicht-knopf.test.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { rcTranslate } = require('../extension/lib/i18n.js');

const ROOT = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8');

function ausschnitt(von, bis) {
  const a = content.indexOf(von);
  const b = content.indexOf(bis, a);
  assert.ok(a > 0 && b > a, `Block nicht gefunden: ${von}`);
  return content.slice(a, b);
}

const PRUEF_BLOCK = ausschnitt('// ─── Main Check Logic', '// ─── Lazy bootstrap');
const ANALYZE = ausschnitt('async function rookhubAnalyzeGame(', '// Schickt die SAN-Zugliste');

const t = (key, params) => rcTranslate('de', key, params);

function aufbau({ moves = ['e4', 'c5'], cfg = { url: 'https://rookhub.example/', token: 'rkh_x' },
  antwort = { status: 401, ok: false }, lokal = null } = {}) {
  const knopf = { id: 'repcheck-floating', textContent: '♟', title: t('tools.check') };
  const ruf = { markiert: [], timer: [], proxy: [] };
  const stubs = {
    t,
    document: { getElementById: (id) => (id === 'repcheck-floating' ? knopf : null) },
    injectFloatingButton: () => {},
    isReviewPage: () => true,
    getGameMoves: () => moves,
    lastGameMovesKey: '',
    loadRookhubConfig: async () => cfg,
    rookhubProxy: async (req) => { ruf.proxy.push(req); return antwort; },
    repertoirePositions: lokal,
    analyzeGame: () => ({ deviation: 1, gaps: [] }),
    highlightDeviation: (...args) => { ruf.markiert.push(args); },
    syncChessableButton: () => {},
    syncSaveButton: () => {},
    fenBeforeMove: () => 'fen',
    currentDeviationIndex: -1,
    lastDeviationFen: null,
    console: { warn: () => {}, log: () => {} },
    setTimeout: (fn, ms) => { ruf.timer.push({ fn, ms }); return ruf.timer.length; },
    clearTimeout: () => {},
  };
  const namen = Object.keys(stubs);
  const fn = new Function(...namen, ANALYZE + '\n' + PRUEF_BLOCK + '\nreturn { runCheck };');
  return { api: fn(...namen.map(k => stubs[k])), knopf, ruf };
}

test('401 ohne lokales Repertoire: ✗ und „Token ungültig" am ♟-Knopf, nach 3 s wieder ♟', async () => {
  const { api, knopf, ruf } = aufbau();
  await api.runCheck();

  assert.strictEqual(ruf.proxy.length, 1, 'RookHub wurde gefragt');
  assert.strictEqual(knopf.textContent, '✗');
  assert.strictEqual(knopf.title, t('status.error', { error: t('err.tokenInvalid') }));
  assert.match(knopf.title, /Token ungültig/);
  assert.deepStrictEqual(ruf.markiert, [], 'keine Markierung ohne Ergebnis');

  assert.strictEqual(ruf.timer.length, 1);
  assert.strictEqual(ruf.timer[0].ms, 3000);
  ruf.timer[0].fn();
  assert.strictEqual(knopf.textContent, '♟');
  assert.strictEqual(knopf.title, t('tools.check'));
});

test('RookHub nicht erreichbar (502): der Grund steht am Knopf', async () => {
  const { api, knopf } = aufbau({ antwort: { status: 502, ok: false, error: 'Bad Gateway' } });
  await api.runCheck();
  assert.strictEqual(knopf.textContent, '✗');
  assert.strictEqual(knopf.title, t('status.error', { error: 'Bad Gateway' }));
});

test('keine Züge: ✗ mit „Keine Züge gefunden", ohne RookHub zu fragen', async () => {
  const { api, knopf, ruf } = aufbau({ moves: [] });
  await api.runCheck();
  assert.strictEqual(knopf.textContent, '✗');
  assert.strictEqual(knopf.title, t('check.noMoves'));
  assert.strictEqual(ruf.proxy.length, 0);
});

test('weder RookHub noch lokales Repertoire: ✗ mit dem Einrichtungs-Hinweis (ohne das entfernte ⚙)', async () => {
  const { api, knopf } = aufbau({ cfg: null });
  await api.runCheck();
  assert.strictEqual(knopf.textContent, '✗');
  assert.strictEqual(knopf.title, t('check.noRepertoire'));
  for (const lang of ['en', 'de', 'hr']) {
    assert.ok(!rcTranslate(lang, 'check.noRepertoire').includes('⚙'), `${lang}: verweist noch auf das entfernte ⚙`);
  }
});

test('401 mit lokalem Repertoire: Rückfall aufs lokale Set, kein ✗', async () => {
  const { api, knopf, ruf } = aufbau({ lokal: new Set(['x']) });
  await api.runCheck();
  assert.strictEqual(knopf.textContent, '♟');
  assert.strictEqual(ruf.markiert.length, 1, 'Ergebnis aus dem lokalen Set markiert');
  assert.strictEqual(ruf.markiert[0][0], 1);
});

test('Erfolg: Markierung in der Zugliste, der Knopf bleibt ♟', async () => {
  const { api, knopf, ruf } = aufbau({
    antwort: { status: 200, ok: true, body: { deviation: -1, gaps: [3], inRepertoire: [0, 1] } },
  });
  await api.runCheck();
  assert.strictEqual(knopf.textContent, '♟');
  assert.strictEqual(knopf.title, t('tools.check'));
  assert.deepStrictEqual(ruf.markiert, [[-1, [3], [0, 1]]]);
  assert.strictEqual(ruf.timer.length, 0);
});
