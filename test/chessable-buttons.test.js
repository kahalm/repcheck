'use strict';

// Die Leiste unten rechts auf chessable.com (Copy FEN, Analyse, Search FEN, Refresh, Remember line,
// Vollbild, ⏳-Pool-Zaehler, Zug-Rueckmeldung) ist seit v1.59.0 in der Extension standardmaessig
// komplett aus — sichtbar wird ein Element erst, wenn es jemand im Popup einschaltet.
//
// Getestet wird der ausgelieferte Code: die Funktionen werden per stabiler Anker aus
// extension/popup.js bzw. extension/chessable-fen.js ausgeschnitten und mit Stubs ausgefuehrt
// (dieselbe Technik wie test/rookhub-connect.test.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lies = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function schnipsel(src, vonAnker, bisAnker, datei) {
  const von = src.indexOf(vonAnker);
  assert.ok(von >= 0, `${datei}: Anker nicht gefunden: ${vonAnker}`);
  const bis = src.indexOf(bisAnker, von + vonAnker.length);
  assert.ok(bis > von, `${datei}: End-Anker nicht gefunden: ${bisAnker}`);
  return src.slice(von, bis);
}

// ─── Popup: Checkboxen ──────────────────────────────────────────────────

function ladePopup(gespeichert) {
  const block = schnipsel(lies('extension/popup.js'),
    'const CB_KEYS = [', 'for (const k of CB_KEYS) { const el = cbEl(k); if (el) el.addEventListener', 'extension/popup.js');
  const elemente = {};
  const document = {
    getElementById: (id) => (elemente[id] = elemente[id] || { checked: false }),
  };
  const speicher = { geschrieben: null };
  const chrome = {
    storage: {
      local: {
        get: (key, cb) => cb(gespeichert === undefined ? {} : { [key]: gespeichert }),
        set: (obj) => { speicher.geschrieben = obj; },
      },
    },
  };
  const api = new Function('document', 'chrome',
    block + '\nreturn { CB_KEYS, loadChessableButtons, saveChessableButtons };')(document, chrome);
  return { ...api, elemente, speicher };
}

test('Popup: ohne gespeicherte Einstellung ist keine Checkbox angehakt', () => {
  const p = ladePopup(undefined);
  p.loadChessableButtons();
  for (const k of p.CB_KEYS) assert.strictEqual(p.elemente['cb-' + k].checked, false, k);
});

test('Popup: nur ausdrücklich eingeschaltete Einträge sind angehakt', () => {
  const p = ladePopup({ copyFen: true, analyse: false, pool: true });
  p.loadChessableButtons();
  const an = p.CB_KEYS.filter((k) => p.elemente['cb-' + k].checked);
  assert.deepStrictEqual(an.sort(), ['copyFen', 'pool']);
});

test('Popup: Speichern schreibt jeden Schlüssel ausdrücklich, fehlende Checkbox = aus', () => {
  const p = ladePopup(undefined);
  p.loadChessableButtons();
  p.elemente['cb-fullscreen'].checked = true;
  delete p.elemente['cb-feedback'];
  p.saveChessableButtons();
  const s = p.speicher.geschrieben.chessableButtons;
  assert.strictEqual(s.fullscreen, true);
  for (const k of p.CB_KEYS.filter((k) => k !== 'fullscreen')) assert.strictEqual(s[k], false, k);
});

test('popup.html: jede Checkbox gehört zu CB_KEYS, keine ist vorab angehakt', () => {
  const html = lies('extension/popup.html');
  const inputs = [...html.matchAll(/<input\b[^>]*\bid="cb-(\w+)"[^>]*>/g)];
  const ids = inputs.map((m) => m[1]).sort();
  assert.deepStrictEqual(ids, [...ladePopup(undefined).CB_KEYS].sort());
  for (const m of inputs) assert.doesNotMatch(m[0], /\bchecked\b/, `cb-${m[1]} darf nicht vorab angehakt sein`);
});

// ─── Seite: chessable-fen.js ────────────────────────────────────────────

function ladeSichtbarkeit() {
  const block = schnipsel(lies('extension/chessable-fen.js'),
    '  let btnRefs = {};', '  function requestButtonSettings() {', 'extension/chessable-fen.js');
  const aufrufe = [];
  return new Function('renderFeedback', 'renderPool', block
    + '\nreturn { setRefs: (r) => { btnRefs = r; }, setSettings: (s) => { buttonSettings = s; }, buttonEnabled, applyButtonSettings };')(
    () => aufrufe.push('feedback'), () => aufrufe.push('pool'));
}

const knopf = () => ({ style: { display: '' } });

test('Seite: ohne Einstellung ist jeder Button ausgeblendet', () => {
  const s = ladeSichtbarkeit();
  const refs = { copyFen: knopf(), analyse: knopf(), searchFen: knopf(), refresh: knopf(), remember: knopf(), fullscreen: knopf() };
  s.setRefs(refs);
  s.applyButtonSettings();
  for (const [k, b] of Object.entries(refs)) assert.strictEqual(b.style.display, 'none', k);
});

test('Seite: nur `true` blendet ein — false, fehlend oder "true" als Text bleiben aus', () => {
  const s = ladeSichtbarkeit();
  const refs = { copyFen: knopf(), analyse: knopf(), searchFen: knopf(), refresh: knopf() };
  s.setRefs(refs);
  s.setSettings({ copyFen: true, analyse: false, searchFen: 'true' });
  s.applyButtonSettings();
  assert.strictEqual(refs.copyFen.style.display, '');
  assert.strictEqual(refs.analyse.style.display, 'none');
  assert.strictEqual(refs.searchFen.style.display, 'none');
  assert.strictEqual(refs.refresh.style.display, 'none');
});

test('Seite: btnRefs + die zwei Anzeigen decken genau die Popup-Schlüssel ab', () => {
  const src = lies('extension/chessable-fen.js');
  const m = src.match(/btnRefs = \{ ([^}]*) \};/);
  assert.ok(m, 'btnRefs-Zuweisung in createUi nicht gefunden');
  const keys = m[1].split(',').map((p) => p.split(':')[0].trim()).concat(['pool', 'feedback']).sort();
  assert.deepStrictEqual(keys, [...ladePopup(undefined).CB_KEYS].sort());
});

test('Seite: ⏳-Pool-Zähler bleibt ohne Einschalten verborgen, auch wenn es Daten gibt', () => {
  const block = schnipsel(lies('extension/chessable-fen.js'),
    '  function renderPool() {', '  // ---------- UI ----------', 'extension/chessable-fen.js');
  const el = { style: { display: '' }, textContent: '', title: '' };
  let an = false;
  const renderPool = new Function('document', 'trainingPoolRest', 'hidePoolPanel', 'buttonEnabled', 'POOL_ID',
    block + '\nreturn renderPool;')({ getElementById: () => el }, () => 12, () => {}, (k) => k === 'pool' && an, 'x');
  renderPool();
  assert.strictEqual(el.style.display, 'none');
  an = true;
  renderPool();
  assert.strictEqual(el.style.display, 'inline-flex');
  assert.match(el.textContent, /12/);
});

test('Seite: Zug-Rückmeldung bleibt ohne Einschalten verborgen, auch nach einem Zug', () => {
  const block = schnipsel(lies('extension/chessable-fen.js'),
    '  function renderFeedback() {', '  function renderFeedbackList() {', 'extension/chessable-fen.js');
  const badge = { style: { display: '', background: '' }, textContent: '', title: '' };
  let an = false;
  const renderFeedback = new Function('document', 'FEEDBACK_ID', 'lineFeedback', 'hideFeedbackList', 'feedbackSum',
    'signiert', 'FEEDBACK_COLORS', 'FEEDBACK_LIST_ID', 'renderFeedbackList', 'buttonEnabled',
    block + '\nreturn renderFeedback;')(
    { getElementById: (id) => (id === 'fb' ? badge : null) }, 'fb', [{ text: '+5 XP', xp: 5, kind: 'xp' }], () => {},
    () => 5, (n) => '+' + n, {}, 'fbl', () => {}, (k) => k === 'feedback' && an);
  renderFeedback();
  assert.strictEqual(badge.style.display, 'none');
  an = true;
  renderFeedback();
  assert.strictEqual(badge.style.display, 'inline-flex');
});

test('Keine Vorgabe „an" mehr in Seite und Einstellungs-Weiterleitung', () => {
  for (const datei of ['extension/chessable-fen.js', 'extension/chessable-activity.js']) {
    assert.doesNotMatch(lies(datei), /copyFen: true/, `${datei} setzt noch eine Vorgabe „an"`);
  }
});
