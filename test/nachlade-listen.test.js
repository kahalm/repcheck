'use strict';

// Nachladen aus dem Popup (S1-008, v1.68.12). Chrome injiziert Content-Scripts nicht in Tabs, die vor der Installation
// (oder vor einem Update) offen waren; das Popup lädt sie dort per executeScript nach. Bis v1.68.11 standen die
// Datei-Listen dafür dreimal von Hand im Popup und waren in zwei Fällen unvollständig: auf chess.com fehlte
// lib/chesscom-moves.js (Schicken aus der Partienliste scheiterte mit „keine Züge"), auf chessable.com fehlten
// lib/i18n.js, lib/chessable-feedback.js und chessable-token.js (rohe Textschlüssel, jede Linie „fehlerfrei").
// Seit v1.68.12 liest das Popup die Listen aus dem Manifest — eine neue Lib braucht nur noch den Manifest-Eintrag.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lies = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POPUP = lies('extension/popup.js');
const MANIFEST = JSON.parse(lies('extension/manifest.json'));

function schnipsel(src, vonAnker, bisAnker, datei) {
  const von = src.indexOf(vonAnker);
  assert.ok(von >= 0, `${datei}: Anker nicht gefunden: ${vonAnker}`);
  const bis = src.indexOf(bisAnker, von + vonAnker.length);
  assert.ok(bis > von, `${datei}: End-Anker nicht gefunden: ${bisAnker}`);
  return src.slice(von, bis);
}

// manifestScripts aus popup.js mit einem chrome-Stub: `manifest` ist, was runtime.getManifest() liefert, `base`, was
// runtime.getURL('') liefert (Chrome: chrome-extension://<id>/, Firefox: moz-extension://<uuid>/).
function ladeManifestScripts(manifest, base) {
  return new Function('chrome',
    schnipsel(POPUP, 'function manifestScripts(consumer) {', 'async function ensureContentLoaded(', 'extension/popup.js')
    + '\nreturn manifestScripts;')({ runtime: { getManifest: () => manifest, getURL: (p) => base + p } });
}

const manifestScripts = ladeManifestScripts(MANIFEST, 'chrome-extension://abcdefghijklmnop/');

// Der Manifest-Eintrag der isolierten Welt, der `consumer` lädt.
function manifestEintrag(consumer) {
  const e = MANIFEST.content_scripts.find((cs) => !cs.world && cs.js.includes(consumer));
  assert.ok(e, 'kein isolierter content_scripts-Eintrag für ' + consumer);
  return e.js;
}

test('jede Nachlade-Liste des Popups ist die Manifest-Liste — vollständig und in derselben Reihenfolge', () => {
  for (const consumer of ['content.js', 'chessable-activity.js']) {
    assert.deepStrictEqual(manifestScripts(consumer), manifestEintrag(consumer), consumer);
  }
  // Die Lücken bis v1.68.11 sind damit geschlossen.
  assert.ok(manifestScripts('content.js').includes('lib/chesscom-moves.js'));
  for (const f of ['lib/i18n.js', 'lib/chessable-feedback.js', 'chessable-token.js']) {
    assert.ok(manifestScripts('chessable-activity.js').includes(f), f);
  }
});

test('die MAIN-World-Einträge werden nie in die isolierte Welt nachgeladen', () => {
  // chessable-fen.js läuft in der MAIN-World; seine Libs (auch lib/chessable-feedback.js) dürfen nicht über den
  // MAIN-Eintrag gewählt werden. manifestScripts nimmt nur Einträge ohne `world` bzw. mit ISOLATED.
  assert.deepStrictEqual(manifestScripts('chessable-fen.js'), ['chessable-fen.js']);
  assert.deepStrictEqual(manifestScripts('chessable-capture.js'), ['chessable-capture.js']);
  const isolated = ladeManifestScripts({ content_scripts: [
    { js: ['a.js', 'x.js'], world: 'MAIN' }, { js: ['b.js', 'x.js'], world: 'ISOLATED' }] }, 'chrome-extension://abc/');
  assert.deepStrictEqual(isolated('x.js'), ['b.js', 'x.js']);
});

test('Firefox: absolute moz-extension-Adressen im Manifest ergeben dieselben relativen Listen', () => {
  // Firefox normalisiert content_scripts[].js (Schema-Format strictRelativeUrl) gegen die Basis-URL:
  // runtime.getManifest() liefert 'moz-extension://<uuid>/content.js' und world: 'ISOLATED'. Bis zur Nacharbeit
  // griff includes('content.js') dort nie, das Popup lud nur content.js bzw. chessable-activity.js nach (content.js
  // warf ohne lib/i18n.js). Absolute Adressen einfach weiterreichen geht auch nicht: Firefox lehnt sie in
  // executeScript({ files }) ab — also relativ vergleichen UND relativ zurückgeben.
  const base = 'moz-extension://0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0/';
  const firefox = { ...MANIFEST, content_scripts: MANIFEST.content_scripts.map((cs) => ({
    ...cs, world: cs.world || 'ISOLATED', js: cs.js.map((f) => base + f) })) };
  const ff = ladeManifestScripts(firefox, base);
  for (const consumer of ['content.js', 'chessable-activity.js']) {
    const liste = ff(consumer);
    assert.deepStrictEqual(liste, manifestEintrag(consumer), consumer);
    assert.ok(liste.length > 1, consumer + ': Rückfall auf [consumer] statt Manifest-Liste');
    for (const f of liste) assert.doesNotMatch(f, /^[a-z-]+:|^\//, consumer + ': nicht relativ: ' + f);
  }
  // Die MAIN-Welt bleibt auch in Firefox-Form außen vor.
  assert.deepStrictEqual(ff('chessable-fen.js'), ['chessable-fen.js']);
  // Ein führender Schrägstrich (absoluter Pfad ohne Schema) wird ebenfalls relativ.
  const slash = ladeManifestScripts({ content_scripts: [{ js: ['/lib/a.js', '/x.js'] }] }, base);
  assert.deepStrictEqual(slash('x.js'), ['lib/a.js', 'x.js']);
});

test('popup.js führt keine eigene Datei-Liste mehr — jedes executeScript mit files liest das Manifest', () => {
  assert.doesNotMatch(POPUP, /files:\s*\[/, 'von Hand gepflegte Nachlade-Liste im Popup');
  const aufrufe = POPUP.match(/files:\s*[^,}\n]+/g) || [];
  assert.ok(aufrufe.length >= 2, 'Nachlade-Aufrufe nicht gefunden');
  for (const a of aufrufe) assert.match(a, /files:\s*manifestScripts\('(content|chessable-activity)\.js'\)/, a);
  // triggerInTab lädt über dieselbe Stelle nach wie die Sharebar.
  const trigger = schnipsel(POPUP, 'async function triggerInTab(action) {', '// Aktion ausloesen.', 'extension/popup.js');
  assert.match(trigger, /await ensureContentLoaded\(tab\);/);
});
