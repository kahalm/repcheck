'use strict';

// Sicherheitsgrenze des Fetch-Proxys im Background-Worker (extension/background.js, `rookhub-fetch`).
// Er ist bewusst KEIN offener Proxy: nur Nachrichten der eigenen Erweiterung, nur HTTPS (http nur
// localhost/127.0.0.1), nur an die eingetragene RookHub-Origin oder die Standard-Instanz, ohne Cookies.
// Getestet wird der ausgelieferte Worker als Ganzes in einer vm mit Stubs für chrome.* und fetch.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
const EXT_ID = 'repcheck-test-id';

function ladeWorker(storage) {
  const listeners = [];
  const fetches = [];
  const nop = { addListener() {} };
  const chrome = {
    runtime: {
      id: EXT_ID,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onInstalled: nop,
      getURL: (p) => 'chrome-extension://' + EXT_ID + '/' + p,
    },
    tabs: { onUpdated: nop, onRemoved: nop },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    storage: {
      local: {
        get: (key, cb) => cb({ [key]: storage[key] }),
        set: (obj, cb) => { Object.assign(storage, obj); if (cb) cb(); },
      },
    },
  };
  const fetch = (url, init) => {
    fetches.push({ url, init });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":1}') });
  };
  const ctx = vm.createContext({ chrome, fetch, URL, atob, navigator: { userAgent: 'test' }, console, Date, setTimeout });
  vm.runInContext(SRC, ctx, { filename: 'background.js' });
  return { listeners, fetches };
}

// Schickt eine Nachricht durch alle onMessage-Listener, wie Chrome es tut; liefert die erste Antwort.
function senden(worker, msg, sender) {
  return new Promise((resolve) => {
    let fertig = false;
    const antwort = (r) => { if (!fertig) { fertig = true; resolve(r); } };
    let asynchron = false;
    for (const fn of worker.listeners) {
      if (fn(msg, sender, antwort) === true) asynchron = true;
    }
    if (!asynchron) setTimeout(() => antwort(undefined), 0);
  });
}

const EIGEN = { id: EXT_ID };
const CFG = { rookhubConfig: { url: 'https://rookhub.example.com/app', token: 'rkh_x' } };

test('Proxy: fremder Absender wird abgewiesen, kein fetch', async () => {
  const w = ladeWorker({ ...CFG });
  const r = await senden(w, { type: 'rookhub-fetch', url: 'https://rookhub.example.com/api/x' }, { id: 'andere-erweiterung' });
  assert.deepStrictEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'unauthorized sender' });
  assert.strictEqual(w.fetches.length, 0);
});

test('Proxy: Klartext-HTTP nach außen und file:// werden abgewiesen', async () => {
  const w = ladeWorker({ rookhubConfig: { url: 'http://rookhub.example.com', token: 'rkh_x' } });
  for (const url of ['http://rookhub.example.com/api/x', 'file:///etc/passwd', 'data:text/plain,x']) {
    const r = await senden(w, { type: 'rookhub-fetch', url }, EIGEN);
    assert.strictEqual(r.ok, false, url);
    assert.match(r.error, /https/, url);
  }
  assert.strictEqual(w.fetches.length, 0);
});

test('Proxy: fremde HTTPS-Origin wird abgewiesen', async () => {
  const w = ladeWorker({ ...CFG });
  const r = await senden(w, { type: 'rookhub-fetch', url: 'https://evil.example.net/steal' }, EIGEN);
  assert.deepStrictEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'target origin not allowed' });
  assert.strictEqual(w.fetches.length, 0);
});

test('Proxy: eingetragene Origin geht durch, ohne Cookies, mit Methode und Body', async () => {
  const w = ladeWorker({ ...CFG });
  const r = await senden(w, {
    type: 'rookhub-fetch', url: 'https://rookhub.example.com/api/extension/games', method: 'POST',
    headers: { Authorization: 'Bearer rkh_x' }, body: '{"a":1}', expect: 'json',
  }, EIGEN);
  // body stammt aus der vm (anderes Object-Prototyp) — über JSON vergleichen.
  assert.deepStrictEqual({ ok: r.ok, status: r.status, body: JSON.parse(JSON.stringify(r.body)) }, { ok: true, status: 200, body: { ok: 1 } });
  assert.strictEqual(w.fetches.length, 1);
  assert.strictEqual(w.fetches[0].init.credentials, 'omit');
  assert.strictEqual(w.fetches[0].init.method, 'POST');
  assert.strictEqual(w.fetches[0].init.body, '{"a":1}');
});

test('Proxy: ohne Konfiguration nur die Standard-Instanz', async () => {
  const w = ladeWorker({});
  const ok = await senden(w, { type: 'rookhub-fetch', url: 'https://rookhub.oberschmid.homes/api/extension/chessable/review-lines/anon', method: 'POST', body: '{}' }, EIGEN);
  assert.strictEqual(ok.ok, true);
  const nein = await senden(w, { type: 'rookhub-fetch', url: 'https://rookhub.example.com/api/x' }, EIGEN);
  assert.strictEqual(nein.error, 'target origin not allowed');
  assert.strictEqual(w.fetches.length, 1);
});

test('Proxy: localhost darf Klartext-HTTP, wenn es die eingetragene Instanz ist', async () => {
  const w = ladeWorker({ rookhubConfig: { url: 'http://localhost:5000', token: 'rkh_x' } });
  const r = await senden(w, { type: 'rookhub-fetch', url: 'http://localhost:5000/api/extension/repertoires' }, EIGEN);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(w.fetches.length, 1);
});
