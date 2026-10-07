'use strict';

// S1-012: „Kurs holen" nur auf einer Kursseite. Bis v1.68.13 fiel currentCourseId (zwei Kopien) ohne Kurs in URL
// und Bridge auf den ERSTEN a[href*="/course/"] im Dokument zurück. Auf chessable.com/home verlinken die Kurskarten
// /course/{bid} — importState meldete onCourse=true für die erste Karte, das Popup schaltete „Kurs holen" frei, und
// nach der Bannrisiko-Bestätigung (die den Kurs nicht nannte) startete ein Crawl mit ggf. >1000 getGame-Abrufen für
// einen Kurs, den niemand gewählt hatte. chessable-fen.js rankte den Link zudem VOR dem React-Fiber.
// Jetzt: EINE Funktion in lib/chessable-course-id.js (URL > Fiber > Link), onCourse nur auf einer Kursseite (Pfad)
// oder bei einer ID aus URL/Fiber, crawlAndImport verweigert sonst, die Bannrisiko-Box nennt den Kurs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lies = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CourseId = require('../extension/lib/chessable-course-id.js');
const { rcTranslate: translate } = require('../extension/lib/i18n.js');

function schnipsel(src, von, bis, datei) {
  const a = src.indexOf(von);
  const b = src.indexOf(bis, a + 1);
  assert.ok(a >= 0 && b > a, `${datei}: Abschnitt „${von.trim()}" nicht gefunden`);
  return src.slice(a, b);
}

// Startseite wie im Dump vom 13.09.: Kurskarten (und Dropdown-Menüs) verlinken /course/{bid}/.
const STARTSEITE_LINKS = ['/home', '/course/107621/', '/course/207313/', '/course/55720/'];

// ─── Lib ────────────────────────────────────────────────────────────────

test('Reihenfolge URL > Fiber > Link', () => {
  assert.deepStrictEqual(CourseId.resolveCourseId({ pathname: '/course/4711/12/', fiberId: '9', links: ['/course/1/'] }), { id: '4711', source: 'url' });
  assert.deepStrictEqual(CourseId.resolveCourseId({ pathname: '/courses/4711', fiberId: '9' }), { id: '4711', source: 'url' });
  assert.deepStrictEqual(CourseId.resolveCourseId({ pathname: '/practice', fiberId: 55720, links: ['/course/1/'] }), { id: '55720', source: 'fiber' });
  assert.deepStrictEqual(CourseId.resolveCourseId({ pathname: '/home', fiberId: null, links: STARTSEITE_LINKS }), { id: '107621', source: 'link' });
  assert.deepStrictEqual(CourseId.resolveCourseId({ pathname: '/courses/fen/rnbq/', links: ['/about'] }), { id: null, source: null });
  assert.deepStrictEqual(CourseId.resolveCourseId(), { id: null, source: null });
});

test('Fiber und Links werden nur befragt, wenn die stärkere Quelle nichts hat; Unsinn zählt nicht', () => {
  const nie = () => { throw new Error('unnötig befragt'); };
  assert.strictEqual(CourseId.resolveCourseId({ pathname: '/course/1/', fiberId: nie, links: nie }).id, '1');
  assert.strictEqual(CourseId.resolveCourseId({ pathname: '/practice', fiberId: () => '2', links: nie }).id, '2');
  assert.deepStrictEqual(CourseId.resolveCourseId({ pathname: '/practice', fiberId: 'abc', links: () => ['/course/3/x'] }), { id: '3', source: 'link' });
});

test('isOnCourse: Kursseite laut Pfad oder ID aus URL/Fiber — eine Link-ID auf der Startseite nicht', () => {
  assert.strictEqual(CourseId.isOnCourse('/home', 'link'), false);
  assert.strictEqual(CourseId.isOnCourse('/', 'link'), false);
  assert.strictEqual(CourseId.isOnCourse('/courses/fen/x/', null), false);
  assert.strictEqual(CourseId.isOnCourse('/practice', 'link'), false);
  assert.strictEqual(CourseId.isOnCourse('/practice', 'fiber'), true);
  assert.strictEqual(CourseId.isOnCourse('/course/1/2', 'link'), true);
  assert.strictEqual(CourseId.isOnCourse('/learn/5/', null), true);
  assert.strictEqual(CourseId.isOnCourse('/courses/77', 'url'), true);
});

// ─── chessable-activity.js: importState und crawlAndImport ─────────────────────────────

function ladeActivity(pathname, links) {
  const src = lies('extension/chessable-activity.js');
  const kern = schnipsel(src, '  // Kurs-ID ermitteln (geteilte Datei', '  // ---- Kursnamen-Kern', 'chessable-activity.js');
  const state = schnipsel(src, '  function importState() {', '  // Popup → Content-Script.', 'chessable-activity.js');
  const crawl = schnipsel(src, '  async function crawlAndImport(', '  // V1: nur den passiven Mitschnitt', 'chessable-activity.js');
  const log = { status: [], geholt: [] };
  let horcher = null;
  const location = { pathname, origin: 'https://www.chessable.com' };
  const window = { addEventListener: (typ, fn) => { if (typ === 'message') horcher = fn; } };
  const deps = {
    self: { RepCheckCourseId: CourseId },
    location,
    window,
    document: { querySelectorAll: (sel) => (sel === 'a[href*="/course/"]' ? links.map((h) => ({ getAttribute: () => h })) : []) },
    bestCourseName: (bid) => 'Kurs ' + bid,
    capturedLineCount: () => 0,
    autoImport: false,
    importTarget: 'repertoire',
    lastStatus: '',
    progressSummary: () => null,
    progressStruct: null,
    progressBid: null,
    suggestedTarget: () => null,
    t: (k, p) => (p ? k + ' ' + JSON.stringify(p) : k),
    setStatus: (s) => log.status.push(s),
    newSessionId: () => 'sitzung',
    ensureProgress: () => {},
    Crawl: {},
    fetchImportedOids: async (bid) => { log.geholt.push(bid); throw new Error('Halt nach der Kurs-ID'); },
  };
  const namen = Object.keys(deps);
  const rumpf = 'let bridgedCourseId = null, bridgedCourseIdSource = null, bridgedCourseName = null;\n'
    + 'let crawling = false, crawlStartedAt = null, cancelRequested = false;\n'
    + kern + state + crawl
    + '\nreturn { importState, crawlAndImport, currentCourseId };';
  const api = new Function(...namen, rumpf)(...namen.map((n) => deps[n]));
  const bridge = (data) => horcher({ source: window, origin: location.origin, data: Object.assign({ __repcheck: 'course-id' }, data) });
  return { api, log, location, bridge };
}

test('Startseite: kein Kurs, „Kurs holen" gesperrt — die Trainingszeit-Zuordnung behält ihre Link-ID', () => {
  const { api } = ladeActivity('/home', STARTSEITE_LINKS);
  const st = api.importState();
  assert.strictEqual(st.onCourse, false, 'Startseite meldet die erste Kurskarte als aktuellen Kurs');
  assert.strictEqual(st.bid, null);
  assert.strictEqual(st.courseName, null);
  assert.strictEqual(api.currentCourseId(), '107621', 'Trainingszeit-Zuordnung unverändert');
});

test('Startseite: crawlAndImport verweigert, bevor irgendetwas geholt wird', async () => {
  const { api, log } = ladeActivity('/home', STARTSEITE_LINKS);
  await api.crawlAndImport('repertoire');
  assert.deepStrictEqual(log.geholt, [], 'Crawl lief für die erste Kurskarte los');
  assert.deepStrictEqual(log.status, ['import.error {"error":"err.noCourse"}']);
});

test('Kursübersicht: Kurs aus der URL, crawlAndImport holt genau ihn', async () => {
  const { api, log } = ladeActivity('/course/207313/', STARTSEITE_LINKS);
  assert.deepStrictEqual(
    (({ onCourse, bid, courseName }) => ({ onCourse, bid, courseName }))(api.importState()),
    { onCourse: true, bid: '207313', courseName: 'Kurs 207313' });
  await api.crawlAndImport('repertoire');
  assert.deepStrictEqual(log.geholt, ['207313']);
});

test('Practice ohne Kurs im Pfad: die per Fiber gespiegelte ID gilt, eine Link-ID nicht', () => {
  const menue = ['/course/111/'];
  const a = ladeActivity('/practice', menue);
  a.bridge({ courseId: '55720', courseIdSource: 'fiber', courseName: 'Chessable Challenge' });
  assert.strictEqual(a.api.importState().bid, '55720', 'Fiber-ID muss vor dem Menü-Link stehen');
  assert.strictEqual(a.api.importState().onCourse, true);

  const b = ladeActivity('/practice', menue);
  b.bridge({ courseId: '111', courseIdSource: 'link' });
  assert.strictEqual(b.api.importState().onCourse, false, 'eine Link-ID macht keine Kursseite');

  // Alte chessable-fen.js (MAIN-World läuft nach einem Update im offenen Tab weiter) schickt keine Quelle.
  const c = ladeActivity('/practice', []);
  c.bridge({ courseId: '55720' });
  assert.strictEqual(c.api.importState().onCourse, false, 'Bridge-ID ohne Quelle gilt nicht als Fiber');
});

// ─── chessable-fen.js: Fiber vor Link, Quelle geht über die Bridge ────────────────────────

function ladeFen(pathname, links, fiberProps) {
  const src = lies('extension/chessable-fen.js');
  const kern = schnipsel(src, '  // Kurs-ID: URL > React-Fiber > erster Kurs-Link', '  function chessableSearchUrl(fen) {', 'chessable-fen.js');
  const funk = schnipsel(src, '  let lastBroadcastCourseId = null;', '  broadcastCourseId();\n', 'chessable-fen.js');
  const gesendet = [];
  const brett = fiberProps ? { __fiber: { memoizedProps: {}, return: { memoizedProps: fiberProps, return: null } } } : null;
  const deps = {
    self: { RepCheckCourseId: CourseId },
    location: { pathname, origin: 'https://www.chessable.com' },
    window: { postMessage: (m, origin) => gesendet.push({ m, origin }) },
    document: {
      getElementById: (id) => (id === 'board' ? brett : null),
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === 'a[href*="/course/"]' ? links.map((h) => ({ getAttribute: () => h })) : []),
    },
    getReactFiber: (el) => (el ? el.__fiber : null),
    currentCourseName: () => null,
  };
  const namen = Object.keys(deps);
  const api = new Function(...namen, kern + funk + '\nreturn { currentCourseId, broadcastCourseId };')(...namen.map((n) => deps[n]));
  return { api, gesendet };
}

test('chessable-fen.js: auf einer Seite mit Brett gewinnt der Fiber gegen einen Menü-Link', () => {
  const { api, gesendet } = ladeFen('/practice', ['/course/111/'], { courseId: 55720 });
  assert.strictEqual(api.currentCourseId(), '55720', 'erster Kurs-Link stand vor dem Fiber');
  api.broadcastCourseId();
  assert.deepStrictEqual(gesendet, [{
    m: { __repcheck: 'course-id', courseId: '55720', courseIdSource: 'fiber', courseName: null },
    origin: 'https://www.chessable.com',
  }]);
});

test('chessable-fen.js: Startseite ohne Brett — Link-ID geht mit Quelle „link" raus', () => {
  const { api, gesendet } = ladeFen('/home', STARTSEITE_LINKS, null);
  api.broadcastCourseId();
  assert.strictEqual(gesendet[0].m.courseId, '107621');
  assert.strictEqual(gesendet[0].m.courseIdSource, 'link');
});

// ─── Eine Quelle, in beiden Welten geladen ──────────────────────────────────────────

test('Manifest lädt lib/chessable-course-id.js vor beiden Konsumenten, keine Inline-Kopien mehr', () => {
  const manifest = JSON.parse(lies('extension/manifest.json'));
  for (const konsument of ['chessable-activity.js', 'chessable-fen.js']) {
    const eintrag = manifest.content_scripts.find((cs) => (cs.js || []).includes(konsument));
    const lib = eintrag.js.indexOf('lib/chessable-course-id.js');
    assert.ok(lib >= 0 && lib < eintrag.js.indexOf(konsument), `${konsument}: Lib fehlt oder kommt zu spät`);
    const src = lies('extension/' + konsument);
    assert.ok(src.includes('self.RepCheckCourseId'), `${konsument}: nutzt die Lib nicht`);
    assert.ok(!src.includes('/\\/courses?\\/(\\d+)'), `${konsument}: eigene URL-Regex ist wieder da`);
    assert.ok(!src.includes('/\\/course\\/(\\d+)(?:\\/|$)/'), `${konsument}: eigene Link-Regex ist wieder da`);
  }
  assert.ok(lies('extension/chessable-activity.js').includes('const bid = pageCourseId();'), 'crawlAndImport muss pageCourseId nehmen');
});

// ─── Popup: die Bannrisiko-Box nennt den Kurs ───────────────────────────────────────

function ladeWarnBox(state) {
  const src = lies('extension/popup.js');
  const block = schnipsel(src, 'function showCiWarn() {', 'async function startCiCrawl() {', 'popup.js');
  const el = () => ({ textContent: '', className: '', type: '', style: {}, children: [],
    append(...c) { this.children.push(...c); }, addEventListener() {} });
  const warn = Object.assign(el(), { replaceChildren(...c) { this.children = c; } });
  const deps = {
    document: { createElement: el },
    CI_WARN: warn,
    ciAlert: null,
    lastCiState: state,
    t: (k, p) => translate('de', k, p),
    startCiCrawl: () => {},
    hideCiWarn: () => {},
  };
  const namen = Object.keys(deps);
  new Function(...namen, block + '\nshowCiWarn();')(...namen.map((n) => deps[n]));
  return warn.children.map((c) => c.textContent);
}

test('Bannrisiko-Box nennt den Kurs, der geholt wird (Name, sonst ID)', () => {
  const mitName = ladeWarnBox({ onCourse: true, bid: '207313', courseName: 'Lifetime Repertoires: Grünfeld' });
  assert.ok(mitName.includes('Geholt wird der Kurs: Lifetime Repertoires: Grünfeld'), mitName.join(' | '));
  assert.ok(mitName.indexOf('Geholt wird der Kurs: Lifetime Repertoires: Grünfeld') < mitName.indexOf(translate('de', 'import.warn.confirm')));
  const ohneName = ladeWarnBox({ onCourse: true, bid: '207313', courseName: null });
  assert.ok(ohneName.includes('Geholt wird der Kurs mit der ID 207313'), ohneName.join(' | '));
});
