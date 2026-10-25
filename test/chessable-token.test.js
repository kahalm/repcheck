'use strict';

// Lebensdauer des erfassten Chessable-Bearers:
//  1) chessable-token.js loescht die Kopie in chrome.storage.local, sobald der
//     JWT aus dem localStorage der Seite verschwindet (Logout-Navigation bzw.
//     ausgeloggter Zustand beim Laden) — vorher ueberlebte der Bearer den Logout.
//  2) chessable-activity.js loescht die Kopie bei 401 der Chessable-API
//     (Bearer serverseitig tot), sowohl im Kursnamen-Resolver als auch im Crawl.
// chessable-token.js wird KOMPLETT in einer vm-Sandbox ausgefuehrt (echtes
// Laufzeitverhalten); aus chessable-activity.js werden die betroffenen
// Funktionen per stabiler Anker herausgeschnitten und mit Stubs ausgefuehrt —
// die Datei selbst haengt an chrome.runtime/DOM und ist in Node nicht ladbar.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const lies = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LS_KEY = 'chessable.web.production.JWT';

// ─── chessable-token.js in der Sandbox starten ──────────────────────────────
function starteTokenScript(initialToken) {
  const ls = new Map();
  if (initialToken != null) ls.set(LS_KEY, initialToken);
  const calls = { set: [], remove: [] };
  const handlers = { window: {}, document: {} };
  const merke = (ziel) => (ev, fn) => { (handlers[ziel][ev] || (handlers[ziel][ev] = [])).push(fn); };
  const sandbox = {
    window: {
      localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null) },
      addEventListener: merke('window'),
    },
    document: {
      visibilityState: 'visible',
      addEventListener: merke('document'),
    },
    location: { origin: 'https://www.chessable.com' },
    chrome: { storage: { local: {
      set: (obj) => calls.set.push(obj),
      remove: (key) => calls.remove.push(key),
    } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(lies('extension/chessable-token.js'), sandbox);
  const feuere = (ziel, ev, arg) => (handlers[ziel][ev] || []).forEach((fn) => fn(arg));
  return { ls, calls, feuere };
}

test('chessable-token: Login-Token landet in chrome.storage.local', () => {
  const { calls } = starteTokenScript('eyJtok1');
  assert.strictEqual(calls.set.length, 1);
  assert.strictEqual(calls.set[0].chessableToken.token, 'eyJtok1');
  assert.strictEqual(calls.remove.length, 0);
});

test('chessable-token: Logout (Key weg) loescht die gespeicherte Kopie — genau einmal', () => {
  const { ls, calls, feuere } = starteTokenScript('eyJtok1');
  ls.delete(LS_KEY);
  feuere('window', 'focus');
  assert.deepStrictEqual(calls.remove, ['chessableToken']);
  // Wiederholter Fokus im ausgeloggten Zustand raeumt nicht erneut (kein Churn).
  feuere('window', 'focus');
  feuere('document', 'visibilitychange');
  assert.strictEqual(calls.remove.length, 1);
  assert.strictEqual(calls.set.length, 1); // nur der urspruengliche Login
});

test('chessable-token: Re-Login nach Logout speichert wieder und raeumt beim naechsten Logout erneut', () => {
  const { ls, calls, feuere } = starteTokenScript('eyJtok1');
  ls.delete(LS_KEY);
  feuere('window', 'focus');
  ls.set(LS_KEY, 'eyJtok2');
  feuere('document', 'visibilitychange');
  assert.strictEqual(calls.set.length, 2);
  assert.strictEqual(calls.set[1].chessableToken.token, 'eyJtok2');
  ls.delete(LS_KEY);
  feuere('window', 'focus');
  assert.deepStrictEqual(calls.remove, ['chessableToken', 'chessableToken']);
});

test('chessable-token: Logout in anderem Tab (storage-Event) loescht die Kopie', () => {
  const { ls, calls, feuere } = starteTokenScript('eyJtok1');
  ls.delete(LS_KEY);
  feuere('window', 'storage', { key: LS_KEY });
  assert.deepStrictEqual(calls.remove, ['chessableToken']);
});

test('chessable-token: frischer Load im ausgeloggten Zustand raeumt eine Altkopie', () => {
  const { calls } = starteTokenScript(null);
  assert.deepStrictEqual(calls.remove, ['chessableToken']);
  assert.strictEqual(calls.set.length, 0);
});

// ─── 401-Pfad in chessable-activity.js ──────────────────────────────────────
function schnipsel(src, vonAnker, bisAnker, datei) {
  const von = src.indexOf(vonAnker);
  assert.ok(von >= 0, `${datei}: Anker nicht gefunden: ${vonAnker}`);
  const bis = src.indexOf(bisAnker, von);
  assert.ok(bis > von, `${datei}: End-Anker nicht gefunden: ${bisAnker}`);
  return src.slice(von, bis);
}

function activityAusschnitte() {
  // Seit der Zerlegung Z36: Kursnamen in chessable-activity/course-context.js, Abrufe in chessable-fetch.js —
  // finde() sucht die Anker in allen Laufzeitdateien.
  const { finde } = require('./helpers/quelle.js');
  // Der Helfer liegt zwischen readChessableToken und fetchCourseNameMap.
  const helfer = finde('function clearStoredChessableToken', 'async function fetchCourseNameMap');
  const nameMap = finde('async function fetchCourseNameMap', 'function loadPersistedNames');
  const crawlGet = finde('const CHESSABLE_RETRYABLE', 'const CRAWL_BACKOFF_BASE_MS');
  return { helfer, nameMap, crawlGet };
}

function stubChrome(calls) {
  return { storage: { local: { remove: (key) => calls.push(key) } } };
}
const antwort401 = { ok: false, status: 401, headers: { get: () => null } };

test('chessable-activity: 401 bei getHomeData loescht den gespeicherten Bearer', async () => {
  const { helfer, nameMap } = activityAusschnitte();
  const removeCalls = [];
  const fabrik = new Function(
    'readChessableToken', 'decodeUid', 'CourseNames', 'fetch', 'chrome',
    helfer + '\n' + nameMap + '\nreturn fetchCourseNameMap;');
  const fetchCourseNameMap = fabrik(
    async () => 'eyJtok', () => '42', { parseCourseNameMap: () => ({}) },
    async () => antwort401, stubChrome(removeCalls));
  assert.strictEqual(await fetchCourseNameMap(), null);
  assert.deepStrictEqual(removeCalls, ['chessableToken']);
});

test('chessable-activity: 401 beim Kurs-Holen (chessableGet) loescht den Bearer und bleibt harter Fehler', async () => {
  const { helfer, crawlGet } = activityAusschnitte();
  const removeCalls = [];
  let fetches = 0;
  const fabrik = new Function(
    'readChessableToken', 'decodeUid', 't', 'setStatus', 'CRAWL_INTER_MS', 'sleep', 'fetch', 'chrome',
    helfer + '\n' + crawlGet + '\nreturn chessableGet;');
  const chessableGet = fabrik(
    async () => 'eyJtok', () => '42', (k) => k, () => {}, 0, async () => {},
    async () => { fetches++; return antwort401; }, stubChrome(removeCalls));
  await assert.rejects(() => chessableGet('getCourse'), /err\.chessableHttp/);
  assert.strictEqual(fetches, 1); // 401 ist nicht retrybar
  assert.deepStrictEqual(removeCalls, ['chessableToken']);
});

test('chessable-activity: andere Fehlstatus lassen den Bearer stehen', async () => {
  const { helfer, nameMap } = activityAusschnitte();
  const removeCalls = [];
  const fabrik = new Function(
    'readChessableToken', 'decodeUid', 'CourseNames', 'fetch', 'chrome',
    helfer + '\n' + nameMap + '\nreturn fetchCourseNameMap;');
  const fetchCourseNameMap = fabrik(
    async () => 'eyJtok', () => '42', { parseCourseNameMap: () => ({}) },
    async () => ({ ok: false, status: 503, headers: { get: () => null } }), stubChrome(removeCalls));
  assert.strictEqual(await fetchCourseNameMap(), null);
  assert.deepStrictEqual(removeCalls, []);
});
