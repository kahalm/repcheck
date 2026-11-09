'use strict';

// Kursstruktur-Cache RepCheckCrawlCache (v1.72.0, chessable-activity/chessable-fetch.js). S1-003 (Delta-Review
// 2026-11-09): listCacheGet lieferte für Einträge älter als 24 h nur null, gelöscht wurde nie — jede je geholte
// Kapitelliste blieb dauerhaft im Speicher von chessable.com. Seit 1.74.1 räumt das Öffnen der DB abgelaufene
// Einträge ab. Der Block läuft hier gegen eine kleine IndexedDB-Attrappe (keine neue Abhängigkeit).

const test = require('node:test');
const assert = require('node:assert');
const { finde } = require('./helpers/quelle.js');

const BLOCK = finde('  const LIST_CACHE_DB = ', '  // ─── Export');
const TTL = 24 * 60 * 60 * 1000;

// Minimal-IndexedDB: ein Store, get/put/openCursor (mit delete/continue), Rückrufe asynchron wie im Browser.
function fakeIndexedDb(vorbelegt) {
  const data = new Map(vorbelegt);
  const later = (f) => setImmediate(f);
  const store = {
    get(key) { const req = {}; later(() => { req.result = data.get(key); req.onsuccess && req.onsuccess(); }); return req; },
    put(value, key) { data.set(key, value); return {}; },
    openCursor() {
      const req = {};
      const keys = [...data.keys()];
      let i = 0;
      const step = () => later(() => {
        if (i < keys.length) {
          const k = keys[i];
          req.result = { key: k, value: data.get(k), delete() { data.delete(k); }, continue() { i++; step(); } };
        } else req.result = null;
        req.onsuccess && req.onsuccess();
      });
      step();
      return req;
    },
  };
  const db = { createObjectStore() {}, transaction: () => ({ objectStore: () => store }) };
  const indexedDB = { open() { const req = {}; later(() => { req.result = db; req.onsuccess && req.onsuccess(); }); return req; } };
  return { indexedDB, data };
}

function lade(idb) {
  return new Function('indexedDB', BLOCK + '\nreturn { listCacheGet, listCachePut };')(idb);
}

const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test('S1-003: abgelaufene Einträge verschwinden, frische und der neue bleiben', async () => {
  const jetzt = Date.now();
  const { indexedDB, data } = fakeIndexedDb([
    ['1:course', { text: 'alt', at: jetzt - TTL - 60 * 60 * 1000 }],   // 25 h
    ['1:7', { text: 'alt', at: jetzt - 2 * TTL }],
    ['2:course', { text: 'frisch', at: jetzt - 60 * 1000 }],
    ['kaputt', 'kein Objekt'],
  ]);
  const { listCachePut, listCacheGet } = lade(indexedDB);
  await listCachePut('3:course', 'neu');
  await ticks();
  assert.deepStrictEqual([...data.keys()].sort(), ['2:course', '3:course']);
  assert.strictEqual(await listCacheGet('2:course'), 'frisch');
  assert.strictEqual(await listCacheGet('1:course'), null);
});

test('S1-003: ohne IndexedDB (privater Modus) bleibt alles ein stiller No-op', async () => {
  const { listCachePut, listCacheGet } = lade({ open() { throw new Error('gesperrt'); } });
  await listCachePut('a', 'b');
  assert.strictEqual(await listCacheGet('a'), null);
});
