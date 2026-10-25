'use strict';

// Golden des Popups (Zerlegung Z39, Charakterisierung VOR dem Umbau): popup.html laedt seine Skripte in EINE vm
// (wie test/popup-laden.test.js), angestaute Rueckrufe feuern nach jedem Skript. Mitgeschrieben werden die Wirkungen
// nach aussen (Listener je Element-Id, Storage-Zugriffe, Worker-/Tab-Nachrichten, executeScript, Takte) und am Ende
// der sichtbare Zustand jedes Elements (Text, Anzeige, disabled/checked/value/href). Danach: Sprachwechsel (alles
// neu beschriften), Klick auf „Trennen", Klick auf „Kurs holen" (Bannrisiko-Box) — wieder Endzustand.
//
// Verglichen wird die Wirkungsliste SORTIERT (eine Zerlegung darf die Reihenfolge unabhaengiger Registrierungen
// zwischen den Skripten verschieben) und der Endzustand exakt. Neu schreiben:
//   POPUP_UPDATE=1 node --test test/popup-golden.test.js      (gegen eine andere extension/: POPUP_EXT=/pfad)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = process.env.POPUP_EXT || path.join(__dirname, '..', 'extension');
const GOLDEN = path.join(__dirname, 'fixtures', 'popup');
const lies = (rel) => fs.readFileSync(path.join(EXT, rel), 'utf8');

function umgebung(storage, tab) {
  const log = [];
  const schreib = (...e) => log.push(JSON.stringify(e));
  const schlange = [];
  const spaeter = (fn) => schlange.push(fn);
  const elemente = new Map();
  function element(id, tag = 'div') {
    const el = {
      id, tagName: tag.toUpperCase(), style: {}, dataset: {}, value: '', checked: false, disabled: false,
      textContent: '', className: '', href: '', title: '', placeholder: '', kinder: [], listeners: [],
      classList: { add(c) { el.klassen.add(c); }, remove(c) { el.klassen.delete(c); }, toggle(c, an) { if (an) el.klassen.add(c); else el.klassen.delete(c); } },
      klassen: new Set(),
      addEventListener(typ, fn) { el.listeners.push({ typ, fn }); schreib('on', id || tag, typ); },
      querySelector: () => null, querySelectorAll: () => [],
      replaceChildren(...k) { el.kinder = k; }, appendChild(k) { el.kinder.push(k); return k; }, append(...k) { el.kinder.push(...k); },
      scrollIntoView() {}, select() {}, getAttribute: () => null,
    };
    return el;
  }
  const holen = (id) => { if (!elemente.has(id)) elemente.set(id, element(id)); return elemente.get(id); };
  const pick = (keys) => {
    const out = {};
    for (const k of (keys == null ? Object.keys(storage) : Array.isArray(keys) ? keys : [keys])) if (k in storage) out[k] = storage[k];
    return out;
  };
  const onChanged = [];
  const chrome = {
    storage: {
      local: {
        get: (keys, cb) => { schreib('storage.get', keys); spaeter(() => cb(JSON.parse(JSON.stringify(pick(keys))))); },
        set: (obj, cb) => { schreib('storage.set', Object.keys(obj).sort()); Object.assign(storage, obj); if (cb) spaeter(cb); },
        remove: (k, cb) => { schreib('storage.remove', k); delete storage[k]; if (cb) spaeter(cb); },
      },
      onChanged: { addListener: (fn) => { onChanged.push(fn); schreib('storage.onChanged'); } },
    },
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        schreib('runtime.sendMessage', msg.type, msg.url || null, msg.method || null);
        if (!cb) return;
        let antwort;
        if (msg.type === 'rookhub-fetch' && /repertoires/.test(msg.url)) antwort = { ok: true, status: 200, body: [{ name: 'Weiss', fileCount: 3 }] };
        else if (msg.type === 'rookhub-fetch' && /share-line/.test(msg.url)) antwort = { ok: true, status: 200, body: { shareToken: 'tok' } };
        else if (msg.type === 'rookhub-fetch') antwort = { ok: true, status: 204, body: null };
        else if (msg.type === 'rookhub-pair-state') antwort = { state: 'idle' };
        spaeter(() => cb(antwort));
      },
      getManifest: () => JSON.parse(lies('manifest.json')),
      getURL: (p) => 'chrome-extension://x/' + p,
    },
    tabs: {
      query: async () => { schreib('tabs.query'); return tab ? [tab] : []; },
      create: (o) => schreib('tabs.create', o.url),
      sendMessage: (id, msg, cb) => {
        schreib('tabs.sendMessage', msg.type, msg.action);
        spaeter(() => cb(msg.action === 'state' ? { onCourse: true, bid: '4711', courseName: 'Probekurs', captured: 2, crawling: false,
          target: 'repertoire', status: 'bereit', progress: { done: 1, total: 4, pct: 25 }, courseType: 'tactics', suggestedTarget: 'book' } : { started: true }));
      },
    },
    scripting: {
      executeScript: async (o) => {
        schreib('scripting.executeScript', o.files || (o.func ? 'func' : null));
        if (o.func && /__rdc_loaded\)/.test(String(o.func))) return [{ result: true }];
        if (o.func) return [{ result: { moves: ['e4', 'e5'], title: 'Partie' } }];
        return [];
      },
    },
  };
  const document = {
    getElementById: holen,
    querySelector: (sel) => (/ci-target.*checked/.test(sel) ? { value: 'repertoire' } : null),
    querySelectorAll: () => [],
    createElement: (tag) => element('', tag),
    documentElement: {}, execCommand() {},
  };
  const ctx = vm.createContext({
    chrome, document, console,
    navigator: { languages: ['de'], clipboard: { writeText: async () => { schreib('clipboard'); } } },
    window: { addEventListener: (typ) => schreib('window.on', typ), close: () => schreib('window.close') },
    Intl, URL, Date, Promise, JSON, Math, Object, Array, String, Number, RegExp, Error, Map, Set,
    setInterval: (_fn, ms) => { schreib('setInterval', ms); return 1; }, clearInterval() {},
    setTimeout: (fn, ms) => { schreib('setTimeout', ms); return 1; }, clearTimeout() {},
    indexedDB: { open: () => { schreib('indexedDB.open'); return {}; } },
  });
  ctx.self = ctx;
  async function abarbeiten() {
    for (let runde = 0; runde < 8; runde++) {
      await new Promise((r) => setImmediate(r));
      let n = 0;
      while (schlange.length) { if (++n > 10000) throw new Error('Rueckruf-Schleife: ' + log.slice(-5).join(' | ')); schlange.shift()(); }
    }
  }
  return { ctx, log, elemente, onChanged, abarbeiten };
}

function zustand(elemente) {
  const out = {};
  for (const [id, el] of [...elemente.entries()].sort()) {
    const z = {};
    for (const k of ['textContent', 'value', 'href', 'title', 'className']) if (el[k]) z[k] = el[k];
    if (el.style.display) z.display = el.style.display;
    if (el.disabled) z.disabled = true;
    if (el.checked) z.checked = true;
    if (el.klassen.size) z.klassen = [...el.klassen].sort();
    if (el.kinder.length) z.kinder = el.kinder.map((k) => (k && (k.textContent || k.tagName)) || String(k));
    out[id] = z;
  }
  return out;
}

async function popupLauf(storage, tab) {
  const u = umgebung(storage, tab);
  const skripte = [...lies('popup.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  for (const datei of skripte) {
    vm.runInContext(lies(datei), u.ctx, { filename: datei });
    await u.abarbeiten();
  }
  const ergebnis = { wirkung: null, start: zustand(u.elemente) };
  // Sprachwechsel (anderer Tab/Willkommensseite): alles neu beschriften.
  for (const fn of u.onChanged) fn({ rcLang: { newValue: 'hr' } }, 'local');
  await u.abarbeiten();
  ergebnis.kroatisch = zustand(u.elemente);
  // Kurs holen (Bannrisiko-Box) bzw. Trennen.
  for (const id of ['ci-crawl', 'conn-forget']) {
    const el = u.elemente.get(id);
    // Nicht auf den Handler warten: er wartet selbst auf Rueckrufe, die erst abarbeiten() ausloest.
    for (const l of (el ? el.listeners : []).filter((x) => x.typ === 'click')) l.fn({ preventDefault() {} });
    await u.abarbeiten();
  }
  ergebnis.nachKlicks = zustand(u.elemente);
  ergebnis.wirkung = u.log.slice().sort();
  return ergebnis;
}

function vergleiche(name, ist) {
  const datei = path.join(GOLDEN, name + '.json');
  const text = JSON.stringify(ist, null, 1);
  if (process.env.POPUP_UPDATE || !fs.existsSync(datei)) {
    fs.mkdirSync(GOLDEN, { recursive: true });
    fs.writeFileSync(datei, text + '\n');
    return;
  }
  assert.deepStrictEqual(JSON.parse(text), JSON.parse(fs.readFileSync(datei, 'utf8')), name + ': Popup weicht vom Golden ab');
}

const VERBUNDEN = {
  rookhubConfig: { url: 'https://rookhub.example', token: 'rkh_x' }, rcLang: 'de',
  chessableToken: { token: 'eyJ', capturedAt: 0 }, crawlDelay: { minMs: 5000, maxMs: 9000 },
  rcCrawlAlert: { at: 0, bid: '4711', detail: 'getGame oid 1 · HTTP 403', banned: false },
  chessableButtons: { pool: true }, rcOnboarding: 'active',
};

test('Popup auf chessable.com, verbunden: Status, Import-Panel, Hinweis, Sprachwechsel, Kurs holen, Trennen', async () => {
  const tab = { id: 7, url: 'https://www.chessable.com/course/4711/' };
  vergleiche('popup-chessable', await popupLauf(JSON.parse(JSON.stringify(VERBUNDEN)), tab));
});

test('Popup auf chess.com, verbunden: Sharebar und Seiten-Panel', async () => {
  const tab = { id: 8, url: 'https://www.chess.com/game/live/123' };
  vergleiche('popup-chesscom', await popupLauf(JSON.parse(JSON.stringify(VERBUNDEN)), tab));
});

test('Popup ohne Verbindung und ohne Tab', async () => {
  vergleiche('popup-leer', await popupLauf({}, null));
});
