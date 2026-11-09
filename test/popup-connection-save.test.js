'use strict';

// „Token von Hand" → Speichern (popup-connection.js). S1-009 (Delta-Review 2026-11-09): URL und Token wurden vor der
// Prüfung nach chrome.storage.local geschrieben (nötig für die Egress-Allowlist des Workers) und bei einem Fehlschlag
// stehen gelassen — beim nächsten Öffnen stand „Verbunden", und der bisher gültige Token war überschrieben. Seit
// 1.74.1 kommt bei einem Fehlschlag der alte Stand zurück. Getestet wird die ausgelieferte Datei mit Attrappen.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup-connection.js'), 'utf8');

function ladePopup({ gespeichert, pruefung }) {
  const store = {};
  if (gespeichert !== undefined) store.rookhubConfig = gespeichert;
  const handler = {};
  const el = (id) => ({ id, value: '', textContent: '', disabled: false, href: '', style: {},
    addEventListener: (ev, fn) => { handler[id + ':' + ev] = fn; } });
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || el(id)) };
  const chrome = {
    storage: { local: {
      get: (k, cb) => cb({ [k]: store[k] }),
      set: (o, cb) => { Object.assign(store, JSON.parse(JSON.stringify(o))); cb && cb(); },
      remove: (k, cb) => { delete store[k]; cb && cb(); },
    } },
    runtime: { sendMessage: (m, cb) => cb(null), lastError: null },
  };
  const geprueft = [];
  const stubs = {
    document, chrome,
    t: (k) => k,
    repaintHooks: [],
    fetchRookhubRepertoires: async (cfg) => { geprueft.push({ ...store.rookhubConfig }); return pruefung(cfg); },
    refreshStatus: () => {},
    getActiveTab: async () => null,
    showSettings: () => {},
    self: {},
  };
  const namen = Object.keys(stubs);
  new Function(...namen, SRC)(...namen.map((n) => stubs[n]));
  return { store, els, geprueft, speichern: () => handler['conn-save:click']() };
}

const ALT = { url: 'https://rookhub.oberschmid.homes', token: 'rkh_alt', tokenId: 7 };

test('S1-009: scheitert die Prüfung (401), bleibt die alte Config samt tokenId stehen', async () => {
  const p = ladePopup({ gespeichert: ALT, pruefung: async () => { throw new Error('err.tokenInvalid'); } });
  p.els['conn-url'].value = 'rookhub.oberschmid.home';   // Tippfehler
  p.els['conn-token'].value = 'rkh_neu';
  await p.speichern();
  assert.deepStrictEqual(p.geprueft, [{ url: 'https://rookhub.oberschmid.home', token: 'rkh_neu' }],
    'während der Prüfung muss die neue Adresse eingetragen sein (Egress-Allowlist)');
  assert.deepStrictEqual(p.store.rookhubConfig, ALT);
  assert.strictEqual(p.els['conn-state'].textContent, 'popup.conn.failed');
});

test('S1-009: ohne vorherige Config wird der Eintrag nach einem Fehlschlag ganz entfernt', async () => {
  const p = ladePopup({ pruefung: async () => { throw new Error('invalid json'); } });
  p.els['conn-url'].value = 'https://falsch.example';
  p.els['conn-token'].value = 'rkh_neu';
  await p.speichern();
  assert.ok(!('rookhubConfig' in p.store), 'ungeprüfter Token blieb gespeichert');
  assert.strictEqual(p.els['conn-state'].textContent, 'popup.conn.errNotRookhub');
});

test('Erfolg: die neue Config bleibt, das Token-Feld wird geleert', async () => {
  const p = ladePopup({ gespeichert: ALT, pruefung: async () => [] });
  p.els['conn-url'].value = 'https://rookhub.oberschmid.homes';
  p.els['conn-token'].value = 'rkh_neu';
  await p.speichern();
  assert.deepStrictEqual(p.store.rookhubConfig, { url: 'https://rookhub.oberschmid.homes', token: 'rkh_neu' });
  assert.strictEqual(p.els['conn-token'].value, '');
  assert.strictEqual(p.els['conn-state'].textContent, 'popup.conn.connected');
});
