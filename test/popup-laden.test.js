'use strict';

// Das Popup besteht aus mehreren klassischen Skripten, die sich EINEN globalen Scope teilen (S1-019, Zerlegung von
// popup.js ab v1.68.13). Zwei Dinge dürfen dabei nicht kippen:
//  1. Kein Skript greift beim Laden auf etwas zu, das erst ein späteres Skript deklariert, und keine Rückruf-Funktion
//     eines früheren Skripts braucht ein späteres — ein Storage- oder Worker-Rückruf kann zwischen zwei <script>-Tags
//     feuern. Der Test lädt die Skripte deshalb in der Reihenfolge aus popup.html in EINE vm und lässt nach JEDEM
//     Skript die angestauten Rückrufe laufen (schlechtester Fall).
//  2. Kein Name ist in zwei Popup-Skripten deklariert (const/let doppelt = SyntaxError, das zweite Skript liefe nie).
// Der Test lief schon gegen das ungeteilte popup.js (Charakterisierung vor dem Umbau).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.join(__dirname, '..', 'extension');
const lies = (rel) => fs.readFileSync(path.join(EXT, rel), 'utf8');
const SKRIPTE = [...lies('popup.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const POPUP_SKRIPTE = SKRIPTE.filter((s) => /^popup[\w-]*\.js$/.test(s));

function element(id) {
  return {
    id, style: {}, dataset: {}, value: '', checked: false, disabled: false, textContent: '', className: '', href: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    replaceChildren() {}, appendChild() {}, append() {}, scrollIntoView() {}, select() {}, getAttribute: () => null,
  };
}

// Winzige Popup-Umgebung. Jeder Rückruf (Storage, Worker) läuft asynchron wie im Browser; Fehler darin werden gesammelt.
function umgebung(storage) {
  const fehler = [];
  const warteschlange = [];
  const spaeter = (fn) => warteschlange.push(() => { try { fn(); } catch (e) { fehler.push(e); } });
  const elemente = {};
  const pick = (keys) => {
    const out = {};
    for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in storage) out[k] = storage[k];
    return out;
  };
  const chrome = {
    storage: {
      local: {
        get: (keys, cb) => spaeter(() => cb(pick(keys))),
        set: (obj, cb) => { Object.assign(storage, obj); if (cb) spaeter(cb); },
        remove: () => {},
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => { if (cb) spaeter(() => cb(undefined)); },
      getManifest: () => JSON.parse(lies('manifest.json')),
      getURL: (p) => 'chrome-extension://x/' + p,
    },
    tabs: { query: async () => [], create() {}, sendMessage() {} },
    scripting: { executeScript: async () => [] },
  };
  const document = {
    getElementById: (id) => (elemente[id] = elemente[id] || element(id)),
    querySelector: () => null, querySelectorAll: () => [], createElement: () => element(),
    documentElement: {}, execCommand() {},
  };
  const idb = { geoeffnet: 0 };
  const ctx = vm.createContext({
    indexedDB: { open: () => { idb.geoeffnet++; return {}; } },
    chrome, document, navigator: { languages: ['de'], clipboard: { writeText: async () => {} } },
    window: { addEventListener() {}, close() {} }, console, Intl, URL, Date, setInterval: () => 1, clearInterval() {},
  });
  ctx.self = ctx;
  return { ctx, fehler, warteschlange, elemente, idb };
}

async function ladePopup(storage) {
  const u = umgebung(storage);
  const onRejection = (e) => u.fehler.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    for (const datei of SKRIPTE) {
      vm.runInContext(lies(datei), u.ctx, { filename: datei });
      // Schlechtester Fall: alle bis hierhin angestauten Rückrufe feuern, BEVOR das nächste Skript lädt.
      for (let runde = 0; runde < 5; runde++) {
        await new Promise((r) => setImmediate(r));
        while (u.warteschlange.length) u.warteschlange.shift()();
      }
    }
    await new Promise((r) => setImmediate(r));
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }
  return u;
}

test('popup.html lädt die Libs vor den Popup-Skripten und popup.js als erstes Popup-Skript', () => {
  assert.ok(POPUP_SKRIPTE.length >= 1 && POPUP_SKRIPTE[0] === 'popup.js', POPUP_SKRIPTE.join(', '));
  const ersterPopup = SKRIPTE.indexOf('popup.js');
  for (const lib of ['lib/i18n.js', 'lib/chessable-crawl.js', 'lib/rookhub-client.js']) {
    assert.ok(SKRIPTE.indexOf(lib) >= 0 && SKRIPTE.indexOf(lib) < ersterPopup, lib);
  }
});

test('alle Popup-Skripte laden ohne Fehler — auch wenn Rückrufe zwischen zwei Skripten feuern', async () => {
  for (const storage of [
    {},                                                                                   // frisch, nicht verbunden
    { rcLang: 'hr', rcOnboarding: 'active', rcButtonsNotice: 'pending', chessableButtons: { pool: true },
      rookhubConfig: { url: 'https://rookhub.example', token: 'rkh_x' }, crawlDelay: { minMs: 5000, maxMs: 9000 } },
  ]) {
    const u = await ladePopup(storage);
    assert.deepStrictEqual(u.fehler.map((e) => String(e && e.stack || e)), [], JSON.stringify(storage));
    // Das Popup hat wirklich gezeichnet (Statuszeile, Checkboxen aus dem Speicher).
    assert.ok(u.elemente.status.textContent, 'Statuszeile leer');
    if (storage.chessableButtons) assert.strictEqual(u.elemente['cb-pool'].checked, true);
  }
});

test('kein Name ist in zwei Popup-Skripten deklariert', () => {
  const wo = new Map();
  for (const datei of POPUP_SKRIPTE) {
    for (const m of lies(datei).matchAll(/^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      assert.ok(!wo.has(m[1]), `${m[1]} steht in ${wo.get(m[1])} UND ${datei}`);
      wo.set(m[1], datei);
    }
  }
  assert.ok(wo.size > 50, 'Deklarationen nicht gefunden — Muster kaputt?');
});

test('toter IndexedDB-Pfad ist weg: das Popup öffnet keine IndexedDB, ohne Verbindung steht „kein Repertoire"', async () => {
  // Die IndexedDB RepertoireCheckerDB gehört dem Seiten-Origin (content.js); im Popup-Origin war sie immer leer.
  // Bis v1.68.12 öffnete refreshStatus sie trotzdem (readRookhubStore) und legte dabei eine leere DB an, der
  // Zweig „Lokal: … geladen" war unerreichbar.
  const u = await ladePopup({});
  assert.strictEqual(u.idb.geoeffnet, 0, 'Popup öffnet eine IndexedDB');
  assert.strictEqual(u.elemente.status.textContent, u.ctx.RepCheckI18n.translate('de', 'popup.none'));
  for (const datei of POPUP_SKRIPTE) assert.doesNotMatch(lies(datei), /indexedDB\.|readRookhubStore\(|'popup\.local\.loaded'/, datei);
  for (const [lang, tabelle] of Object.entries(u.ctx.RepCheckI18n.MESSAGES)) {
    assert.ok(!('popup.local.loaded' in tabelle), lang + ': popup.local.loaded ist verwaist');
  }
});
