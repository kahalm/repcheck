'use strict';

// Lade-Probe der drei Content-Script-Welten (Zerlegung Z36–Z38, Charakterisierung VOR dem Umbau).
//
// Ohne Browser laesst sich die Verdrahtung nur so pruefen: die Dateien eines `content_scripts`-Eintrags werden in
// der Reihenfolge aus manifest.json in EINE vm geladen (klassische Skripte teilen sich dort wie im Browser den
// globalen Scope), gegen ein winziges Fake-DOM samt Fake-`chrome`. Mitgeschrieben wird JEDE Wirkung nach aussen in
// der Reihenfolge, in der sie entsteht: Listener (Dokument, Fenster, Elemente), Observer, Timer mit Takt,
// Storage-Zugriffe, Nachrichten an den Worker, postMessage an die andere Welt, Konsolenzeilen. Danach werden ein
// paar Einstiege angestossen (Popup-Abfrage `rc-import`/`state`, Mitschnitt einer Kapitelliste, Panel oeffnen) und
// ebenso mitgeschrieben.
//
// Das Protokoll liegt als Golden unter test/fixtures/welten/. Eine Zerlegung, die nur Code verschiebt, muss
// DASSELBE Protokoll erzeugen — fehlt ein Listener, kommt ein Timer in anderer Reihenfolge oder wirft eine Datei
// beim Laden (Name nicht verdrahtet), faellt der Test. Neu schreiben (nur bei gewollter Verhaltensaenderung):
//   WELTEN_UPDATE=1 node --test test/welten-laden.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.join(__dirname, '..', 'extension');
const GOLDEN = path.join(__dirname, 'fixtures', 'welten');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

// Kurzform eines Werts fuers Protokoll (Funktionen und DOM-Knoten nur als Marker).
function kurz(v, tiefe = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'function') return '[fn]';
  if (typeof v !== 'object') return v;
  if (v.__fake) return '[el ' + v.tagName + (v.id ? '#' + v.id : '') + ']';
  if (tiefe > 3) return '[…]';
  if (Array.isArray(v)) return v.map((x) => kurz(x, tiefe + 1));
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = kurz(v[k], tiefe + 1);
  return out;
}

function umgebung({ href, storage = {} }) {
  const url = new URL(href);
  const log = [];
  const schreib = (...e) => log.push(e.map((x) => kurz(x)));
  const nachId = new Map();
  let elementNr = 0;

  function element(tag) {
    const kinder = [];
    const el = {
      __fake: true, tagName: String(tag).toUpperCase(), nr: ++elementNr, kinder,
      style: {}, dataset: {}, attrs: {}, textContent: '', className: '', title: '', type: '',
      // innerHTML: die ids der Vorlage als Elemente anlegen (das Panel verdrahtet sie danach per getElementById).
      get innerHTML() { return this._html || ''; },
      set innerHTML(v) {
        this._html = String(v);
        for (const m of this._html.matchAll(/<(\w+)[^>]*\sid="([^"]+)"/g)) { const k = element(m[1]); k.id = m[2]; }
      },
      value: '', disabled: false, isConnected: true, parentElement: null, firstChild: null, childElementCount: 0,
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      get id() { return this._id || ''; },
      set id(v) { this._id = v; nachId.set(v, this); },
      appendChild(c) { kinder.push(c); c.parentElement = el; el.firstChild = kinder[0]; el.childElementCount = kinder.length; return c; },
      prepend(c) { kinder.unshift(c); c.parentElement = el; el.firstChild = kinder[0]; el.childElementCount = kinder.length; return c; },
      insertBefore(c) { return el.prepend(c); },
      append(...cs) { cs.forEach((c) => typeof c === 'object' && el.appendChild(c)); },
      replaceChildren() { kinder.length = 0; el.childElementCount = 0; },
      remove() { if (el._id && nachId.get(el._id) === el) nachId.delete(el._id); el.isConnected = false; },
      addEventListener(typ) { schreib('el.on', el.tagName + (el._id ? '#' + el._id : ''), typ); },
      removeEventListener() {},
      setAttribute(k, v) { el.attrs[k] = String(v); if (k === 'id') el.id = v; },
      getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
      removeAttribute(k) { delete el.attrs[k]; },
      hasAttribute(k) { return k in el.attrs; },
      querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false,
      getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
      focus() {}, blur() {}, click() {}, select() {}, scrollIntoView() {}, cloneNode() { return element(tag); },
    };
    return el;
  }

  const body = element('body');
  const head = element('head');
  const document = {
    readyState: 'complete', body, head, documentElement: element('html'), title: 'Probe', visibilityState: 'visible',
    hasFocus: () => true,
    getElementById: (id) => nachId.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [],
    createElement: (tag) => element(tag),
    createTextNode: (t) => ({ textContent: t }),
    addEventListener: (typ) => schreib('document.on', typ),
    removeEventListener() {},
    execCommand: () => true,
  };

  const listener = { onMessage: [], onChanged: [], fenster: {} };
  const chrome = {
    runtime: {
      id: 'probe',
      lastError: null,
      getManifest: () => manifest,
      getURL: (p) => 'chrome-extension://probe/' + p,
      sendMessage: (msg, cb) => { schreib('runtime.sendMessage', msg && msg.type, msg && msg.url, msg && msg.method); if (cb) cb(undefined); },
      onMessage: { addListener: (fn) => { listener.onMessage.push(fn); schreib('runtime.onMessage.addListener'); } },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          schreib('storage.get', keys);
          const liste = keys == null ? Object.keys(storage) : (Array.isArray(keys) ? keys : [keys]);
          const out = {};
          for (const k of liste) if (k in storage) out[k] = storage[k];
          if (cb) cb(out);
        },
        set: (obj, cb) => { schreib('storage.set', Object.keys(obj)); Object.assign(storage, obj); if (cb) cb(); },
        remove: (k, cb) => { schreib('storage.remove', k); if (cb) cb(); },
      },
      onChanged: { addListener: (fn) => { listener.onChanged.push(fn); schreib('storage.onChanged.addListener'); } },
    },
  };

  class MutationObserver {
    constructor() { schreib('MutationObserver.new'); }
    observe(_ziel, opts) { schreib('MutationObserver.observe', opts); }
    disconnect() {}
  }

  const ctx = {
    console: {
      log: (...a) => schreib('console.log', a.map(String).join(' ')),
      warn: (...a) => schreib('console.warn', a.map(String).join(' ')),
      error: (...a) => schreib('console.error', a.map(String).join(' ')),
      debug() {}, info() {},
    },
    document, chrome, MutationObserver,
    location: {
      href: url.href, origin: url.origin, hostname: url.hostname, host: url.host, pathname: url.pathname,
      search: url.search, hash: url.hash, reload() {},
    },
    navigator: { languages: ['de'], userAgent: 'Probe Chrome/141', clipboard: { writeText: async () => {} } },
    setInterval: (_fn, ms) => { schreib('setInterval', ms); return 1; },
    clearInterval() {},
    setTimeout: (_fn, ms) => { schreib('setTimeout', ms); return 1; },
    clearTimeout() {},
    requestAnimationFrame: () => 1,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', backgroundColor: 'rgb(30, 30, 30)' }),
    innerWidth: 1280, innerHeight: 800,
    addEventListener: (typ, fn) => { (listener.fenster[typ] = listener.fenster[typ] || []).push(fn); schreib('window.on', typ); },
    removeEventListener() {},
    postMessage: (data) => schreib('window.postMessage', data),
    open: (...a) => schreib('window.open', a[0]),
    fetch: async (u) => { schreib('fetch', String(u)); return { ok: false, status: 599, text: async () => '', json: async () => ({}), headers: { get: () => null } }; },
    // IndexedDB gibt es in der Probe nicht: open scheitert asynchron (wie ein gesperrter Speicher).
    indexedDB: { open: () => { schreib('indexedDB.open'); const req = { error: new Error('keine IDB') }; setImmediate(() => req.onerror && req.onerror()); return req; } },
    crypto: { randomUUID: () => 'uuid' },
    Intl, URL, Date, Math, JSON, Promise, Map, Set, WeakMap, Array, Object, String, Number, Boolean, RegExp, Error,
    TextEncoder, Symbol, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, atob, btoa,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Innen ist `window` der globale Proxy der vm, nicht das Objekt hier — `e.source === window` braucht genau ihn.
  const fenster = vm.runInContext('window', ctx);
  return { ctx, fenster, log, listener, storage, nachId };
}

// Dateien eines content_scripts-Eintrags (Welt) in Manifest-Reihenfolge.
function weltDateien(konsument) {
  const eintrag = manifest.content_scripts.find((cs) => (cs.js || []).includes(konsument));
  assert.ok(eintrag, 'kein Manifest-Eintrag mit ' + konsument);
  return eintrag.js;
}

function ladeWelt(konsument, opts) {
  const u = umgebung(opts);
  for (const datei of weltDateien(konsument)) {
    u.log.push(['--- lade', datei === konsument ? '<konsument>' : (datei.startsWith('lib/') ? datei : '<welt>')]);
    vm.runInContext(fs.readFileSync(path.join(EXT, datei), 'utf8'), u.ctx, { filename: datei });
  }
  return u;
}

// Protokoll ohne die „--- lade"-Marker der Libs und Welt-Dateien (nur der Konsument bleibt als Marke): die
// Zerlegung darf neue Dateien einfuegen, deren Laden selbst nichts bewirkt; verglichen wird, was die Welt
// INSGESAMT tut, und in welcher Reihenfolge.
function wirkung(log) {
  return log.filter((e) => !(e[0] === '--- lade' && e[1] !== '<konsument>'));
}

function vergleiche(name, log) {
  const datei = path.join(GOLDEN, name + '.json');
  const ist = JSON.stringify(wirkung(log), null, 1);
  if (process.env.WELTEN_UPDATE || !fs.existsSync(datei)) {
    fs.mkdirSync(GOLDEN, { recursive: true });
    fs.writeFileSync(datei, ist + '\n');
    return;
  }
  assert.deepStrictEqual(JSON.parse(ist), JSON.parse(fs.readFileSync(datei, 'utf8')), name + ': Protokoll weicht vom Golden ab');
}

const tick = () => new Promise((r) => setImmediate(r));

test('chessable.com, isolierte Welt (chessable-activity.js): Laden, Popup-Abfrage, Mitschnitt', async () => {
  const u = ladeWelt('chessable-activity.js', {
    href: 'https://www.chessable.com/course/4711/',
    storage: { rookhubConfig: { url: 'https://rookhub.example', token: 'rkh_x' }, rcLang: 'de' },
  });
  await tick();
  u.log.push(['--- popup: state']);
  let antwort;
  for (const fn of u.listener.onMessage) fn({ type: 'rc-import', action: 'state' }, {}, (r) => { antwort = r; });
  u.log.push(['state', kurz(antwort)]);
  await tick();
  u.log.push(['--- mitschnitt: getList']);
  const liste = JSON.stringify({ list: { id: 7, data: [{ id: 11, nHard: 2 }, { id: 12, nHard: 0 }] } });
  for (const fn of u.listener.fenster.message || []) {
    fn({ source: u.fenster, origin: 'https://www.chessable.com',
      data: { __repcheck: 'chessable-capture', url: 'https://www.chessable.com/api/v1/getList?bid=4711&lid=7', body: liste } });
  }
  await tick();
  u.log.push(['--- popup: setTarget book']);
  for (const fn of u.listener.onMessage) fn({ type: 'rc-import', action: 'setTarget', target: 'book' }, {}, (r) => { antwort = r; });
  u.log.push(['state', kurz(antwort)]);
  u.log.push(['--- bridge: request-daily + request-rookhub-url']);
  for (const fn of u.listener.fenster.message || []) {
    fn({ source: u.fenster, origin: 'https://www.chessable.com', data: { __repcheck: 'request-daily' } });
    fn({ source: u.fenster, origin: 'https://www.chessable.com', data: { __repcheck: 'request-rookhub-url' } });
  }
  await tick();
  u.log.push(['--- storage: rookhubConfig weg, Buttons-Einstellung neu']);
  for (const fn of u.listener.onChanged) fn({ chessableButtons: { newValue: { copyFen: true } } }, 'local');
  await tick();
  vergleiche('chessable-isoliert', u.log);
});

test('chessable.com, isolierte Welt ohne Verbindung: Verbinden-Karte', async () => {
  const u = ladeWelt('chessable-activity.js', { href: 'https://www.chessable.com/practice/4711/1', storage: {} });
  await tick();
  vergleiche('chessable-isoliert-ohne-verbindung', u.log);
});

test('chessable.com, MAIN-Welt (chessable-fen.js): Laden im Practice-Modus, Einstellungen und URL kommen an', async () => {
  const u = ladeWelt('chessable-fen.js', { href: 'https://www.chessable.com/practice/4711/1' });
  await tick();
  u.log.push(['--- bridge: chessable-buttons + rookhub-url + daily']);
  for (const fn of u.listener.fenster.message || []) {
    fn({ source: u.fenster, origin: 'https://www.chessable.com', data: { __repcheck: 'chessable-buttons', settings: { copyFen: true, pool: true, fullscreen: true } } });
    fn({ source: u.fenster, origin: 'https://www.chessable.com', data: { __repcheck: 'rookhub-url', url: 'https://rookhub.example' } });
    fn({ source: u.fenster, origin: 'https://www.chessable.com', data: { __repcheck: 'daily', daily: { heute: { sekunden: 600, zuege: 40, linien: 5 }, schnitt: { tage: 3, sekProLinie: 100 } } } });
  }
  await tick();
  u.log.push(['sichtbar', [...u.nachId.entries()].map(([id, el]) => [id, el.style.display || '']).sort()]);
  vergleiche('chessable-main', u.log);
});

test('chess.com, isolierte Welt (content.js): Laden auf einer Partieseite, Panel oeffnen, Zugliste lesen', async () => {
  const u = ladeWelt('content.js', {
    href: 'https://www.chess.com/game/live/123456789',
    storage: { rookhubConfig: { url: 'https://rookhub.example', token: 'rkh_x' } },
  });
  await tick();
  const api = u.ctx.__rdc_loaded;
  u.log.push(['api', kurz(api)]);
  u.log.push(['--- getCurrentLine']);
  u.log.push(['zeile', kurz(api.getCurrentLine())]);
  u.log.push(['--- openSettings']);
  api.openSettings();
  await tick();
  u.log.push(['ids', [...u.nachId.keys()].sort()]);
  vergleiche('content-chesscom', u.log);
});

test('lichess, isolierte Welt (content.js): Laden auf der Analyse', async () => {
  const u = ladeWelt('content.js', { href: 'https://lichess.org/analysis', storage: {} });
  await tick();
  u.log.push(['--- runCheck ohne Zuege']);
  await u.ctx.__rdc_loaded.runCheck();
  await tick();
  u.log.push(['ids', [...u.nachId.keys()].sort()]);
  vergleiche('content-lichess', u.log);
});
