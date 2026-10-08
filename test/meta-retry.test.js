'use strict';

// Kopfdaten mit Wiederholung (fetchMetaWithRetry): direkt nach Partieende lieferte chess.com noch keine Namen, RookHub
// speicherte „?" gegen „?" (Prod-Partie 63, 08.10.2026). Wiederholt wird, solange Namen fehlen — höchstens `tries`-mal.

const test = require('node:test');
const assert = require('node:assert');
const { fetchMetaWithRetry } = require('../extension/lib/repertoire-text.js');

const noSleep = { sleep: async () => {} };

test('erster Versuch mit Namen: kein zweiter Abruf', async () => {
  let calls = 0;
  const got = await fetchMetaWithRetry(async () => { calls++; return { white: 'a', black: 'b' }; }, noSleep);
  assert.deepStrictEqual(got, { white: 'a', black: 'b' });
  assert.strictEqual(calls, 1);
});

test('erst leer, dann mit Namen: der zweite Versuch gewinnt', async () => {
  const antworten = [null, { white: 'kahalm', black: 'ukker1992' }];
  let calls = 0;
  const got = await fetchMetaWithRetry(async () => antworten[calls++], noSleep);
  assert.strictEqual(got.white, 'kahalm');
  assert.strictEqual(calls, 2);
});

test('nie Namen: höchstens drei Versuche, das letzte brauchbare Ergebnis bleibt', async () => {
  let calls = 0;
  const got = await fetchMetaWithRetry(async () => { calls++; return calls === 2 ? { white: null, black: null, timeControl: '180+2' } : null; }, noSleep);
  assert.strictEqual(calls, 3);
  assert.strictEqual(got.timeControl, '180+2');
});

test('ein Fehler beim Abruf zählt als leerer Versuch', async () => {
  let calls = 0;
  const got = await fetchMetaWithRetry(async () => { calls++; if (calls === 1) throw new Error('netz'); return { white: 'a', black: 'b' }; }, noSleep);
  assert.strictEqual(got.black, 'b');
  assert.strictEqual(calls, 2);
});

test('zwischen den Versuchen wird gewartet, vor dem ersten nicht', async () => {
  const pausen = [];
  await fetchMetaWithRetry(async () => null, { tries: 3, delayMs: 1500, sleep: async (ms) => { pausen.push(ms); } });
  assert.deepStrictEqual(pausen, [1500, 1500]);
});
