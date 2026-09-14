'use strict';

// Einführung für neue Nutzer (v1.59.0): Willkommensseite nach der Installation, „Erste Schritte" im Popup,
// einmaliger Hinweis für Updater. Getestet werden die reinen Entscheidungen im ausgelieferten Code (per Anker
// ausgeschnitten wie in test/rookhub-connect.test.js) und die Verdrahtung zwischen den Dateien.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { RC_MESSAGES } = require('../extension/lib/i18n.js');

const ROOT = path.join(__dirname, '..');
const lies = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function schnipsel(src, vonAnker, bisAnker, datei) {
  const von = src.indexOf(vonAnker);
  assert.ok(von >= 0, `${datei}: Anker nicht gefunden: ${vonAnker}`);
  const bis = src.indexOf(bisAnker, von + vonAnker.length);
  assert.ok(bis > von, `${datei}: End-Anker nicht gefunden: ${bisAnker}`);
  return src.slice(von, bis);
}

// ─── background.js: was nach der Installation passiert ─────────────────────

const BG = new Function(schnipsel(lies('extension/background.js'),
  'const BUTTONS_DEFAULT_OFF_SINCE', 'function openWelcome(', 'extension/background.js')
  + '\nreturn { versionLess, onboardingPlan };')();

test('versionLess vergleicht Versionsteile als Zahlen, nicht als Text', () => {
  assert.strictEqual(BG.versionLess('1.9.0', '1.59.0'), true);
  assert.strictEqual(BG.versionLess('1.58.0', '1.59.0'), true);
  assert.strictEqual(BG.versionLess('1.58', '1.59.0'), true);
  assert.strictEqual(BG.versionLess('1.59.0', '1.59.0'), false);
  assert.strictEqual(BG.versionLess('1.59.1', '1.59.0'), false);
  assert.strictEqual(BG.versionLess('2.0', '1.59.0'), false);
});

test('frische Installation: Willkommensseite öffnen und Checkliste aktivieren', () => {
  assert.deepStrictEqual(BG.onboardingPlan({ reason: 'install' }), { openWelcome: true, onboarding: 'active' });
});

test('Update von vor 1.59.0: nur der Hinweis, keine Seite und keine Checkliste', () => {
  assert.deepStrictEqual(BG.onboardingPlan({ reason: 'update', previousVersion: '1.58.0' }), { buttonsNotice: 'pending' });
  assert.deepStrictEqual(BG.onboardingPlan({ reason: 'update', previousVersion: '1.9.3' }), { buttonsNotice: 'pending' });
});

test('Update ab 1.59.0, Browser-Update oder fehlende Vorversion: nichts', () => {
  for (const d of [
    { reason: 'update', previousVersion: '1.59.0' },   // auch das Neuladen einer entpackten Extension
    { reason: 'update', previousVersion: '1.60.2' },
    { reason: 'update' },
    { reason: 'chrome_update', previousVersion: '1.58.0' },
    { reason: 'shared_module_update' },
    null,
  ]) assert.deepStrictEqual(BG.onboardingPlan(d), {}, JSON.stringify(d));
});

// ─── popup.js: Checkliste und Hinweis ──────────────────────────────────────

const onboardingState = new Function(schnipsel(lies('extension/popup.js'),
  'function onboardingState(s) {', 'function openWelcomePage(', 'extension/popup.js')
  + '\nreturn onboardingState;')();

test('Checkliste: neuer Nutzer ohne Erledigtes sieht alle drei Schritte offen', () => {
  const st = onboardingState({ rcOnboarding: 'active' });
  assert.strictEqual(st.showChecklist, true);
  assert.deepStrictEqual(st.steps, { connect: false, course: false, buttons: false });
  assert.strictEqual(st.showNotice, false);
});

test('Checkliste: verschwindet, sobald alles erledigt ist', () => {
  const st = onboardingState({
    rcOnboarding: 'active', rookhubConfig: { url: 'https://x', token: 'rkh_1' },
    rcCourseFetched: true, chessableButtons: { copyFen: false },
  });
  assert.deepStrictEqual(st.steps, { connect: true, course: true, buttons: true });
  assert.strictEqual(st.showChecklist, false);
});

test('Checkliste: eine URL ohne Token gilt nicht als verbunden, „alles aus" gilt als gewählt', () => {
  const st = onboardingState({ rcOnboarding: 'active', rookhubConfig: { url: 'https://x' }, chessableButtons: {} });
  assert.strictEqual(st.steps.connect, false);
  assert.strictEqual(st.steps.buttons, true);
});

test('Checkliste: weggeklickt oder Bestandsnutzer → nie sichtbar', () => {
  assert.strictEqual(onboardingState({ rcOnboarding: 'dismissed' }).showChecklist, false);
  assert.strictEqual(onboardingState({}).showChecklist, false);
  assert.strictEqual(onboardingState(null).showChecklist, false);
});

test('Hinweis „Buttons jetzt aus": nur solange er aussteht', () => {
  assert.strictEqual(onboardingState({ rcButtonsNotice: 'pending' }).showNotice, true);
  assert.strictEqual(onboardingState({ rcButtonsNotice: 'done' }).showNotice, false);
});

// ─── Verdrahtung zwischen den Dateien ───────────────────────────────────────

function cbKeys(datei) {
  const m = lies(datei).match(/const CB_KEYS = (\[[^\]]*\]);/);
  assert.ok(m, `${datei}: CB_KEYS nicht gefunden`);
  return new Function('return ' + m[1])();
}

test('welcome.js und popup.js kennen dieselben Button-Schlüssel', () => {
  assert.deepStrictEqual(cbKeys('extension/welcome.js'), cbKeys('extension/popup.js'));
});

test('welcome.html: jede Checkbox gehört zu CB_KEYS, keine ist vorab angehakt', () => {
  const inputs = [...lies('extension/welcome.html').matchAll(/<input\b[^>]*\bid="cb-(\w+)"[^>]*>/g)];
  assert.deepStrictEqual(inputs.map((m) => m[1]).sort(), [...cbKeys('extension/popup.js')].sort());
  for (const m of inputs) assert.doesNotMatch(m[0], /\bchecked\b/, `cb-${m[1]} darf nicht vorab angehakt sein`);
});

test('jeder Text-Schlüssel in Popup und Willkommensseite existiert', () => {
  const en = RC_MESSAGES.en;
  const fehlend = [];
  for (const datei of ['extension/popup.html', 'extension/welcome.html']) {
    for (const m of lies(datei).matchAll(/data-i18n(?:-title|-placeholder)?="([\w.]+)"/g)) {
      if (!(m[1] in en)) fehlend.push(`${datei}: ${m[1]}`);
    }
  }
  for (const datei of ['extension/popup.js', 'extension/welcome.js']) {
    for (const m of lies(datei).matchAll(/\b(?:t|setConn|setConnState)\('([\w.]+)'/g)) {
      if (!(m[1] in en)) fehlend.push(`${datei}: ${m[1]}`);
    }
  }
  for (const m of lies('extension/chessable-activity.js').matchAll(/\bt\('((?:notice|connect)\.[\w.]+)'/g)) {
    if (!(m[1] in en)) fehlend.push(`chessable-activity.js: ${m[1]}`);
  }
  assert.deepStrictEqual(fehlend, []);
});

test('jeder erfolgreiche Chessable-Import hakt „Kurs geholt" ab', () => {
  const zeilen = lies('extension/chessable-activity.js').split('\n');
  const aufrufe = [
    'await ingestLive(bid, target, courseName, newChapters);',
    'await ingestChunk(sessionId, bid, target, courseName, null, true,',
    'await ingest(bid, chapters, target, bestCourseName(bid));',
    'await ingestLive(bid, importTarget, bestCourseName(bid), chapters);',
  ];
  for (const aufruf of aufrufe) {
    const i = zeilen.findIndex((z) => z.includes(aufruf));
    assert.ok(i >= 0, `Aufruf nicht gefunden: ${aufruf}`);
    assert.strictEqual(zeilen[i + 1].trim(), 'markCourseFetched();', `nach „${aufruf}" fehlt markCourseFetched()`);
  }
});

test('background.js öffnet die Willkommensseite nur für Nachrichten der eigenen Extension', () => {
  const block = schnipsel(lies('extension/background.js'),
    "msg.type !== 'rc-open-welcome'", 'openWelcome(msg.section)', 'extension/background.js');
  assert.match(block, /sender\.id !== chrome\.runtime\.id/);
});
