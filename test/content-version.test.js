'use strict';

// Version und Kopfkommentare von content.js (Review 2026-09-29, S1-020). Bis v1.68.9 meldete sich
// content.js als „Extension v1.12.0 loaded" und fuehrte version: '1.17.0' (Manifest: 1.68.x) — ein
// Support-Fall haette auf eine uralte Installation getippt. Die Kopfkommentare von content.js und
// popup.js behaupteten, content.js werde seit v1.4.8 nicht mehr automatisch geladen; das Manifest laedt
// es auf jeder chess.com-/lichess-Seite.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lies = (datei) => fs.readFileSync(path.join(ROOT, 'extension', datei), 'utf8');
const content = lies('content.js');
const popup = lies('popup.js');
const manifest = JSON.parse(lies('manifest.json'));

function ausschnitt(text, von, bis) {
  const a = text.indexOf(von);
  const b = text.indexOf(bis, a);
  assert.ok(a >= 0 && b > a, `Block nicht gefunden: ${von}`);
  return text.slice(a, b);
}

test('die Version kommt aus dem Manifest — auch ohne Erweiterungs-Kontext kein Absturz', () => {
  const block = ausschnitt(content, 'const EXT_VERSION', 'window.__rdc_loaded = {');
  const lade = (chrome) => new Function('chrome', block + '\nreturn EXT_VERSION;')(chrome);
  assert.strictEqual(lade({ runtime: { getManifest: () => ({ version: manifest.version }) } }), manifest.version);
  // Ohne Erweiterungs-Kontext (kein chrome.runtime) kein Wurf beim Laden.
  assert.strictEqual(lade({}), '?');
  assert.strictEqual(lade(undefined), '?');
});

test('__rdc_loaded.version und die Lade-Zeile tragen kein Versions-Literal', () => {
  const api = ausschnitt(content, 'window.__rdc_loaded = {', '};');
  assert.match(api, /version: EXT_VERSION,/);
  assert.doesNotMatch(api, /\d+\.\d+\.\d+/, 'kein von Hand gepflegtes Versions-Literal');

  const logs = content.split('\n').filter(z => z.includes('Extension v'));
  assert.deepStrictEqual(logs.map(z => z.trim()), [
    "console.log('[RepertoireChecker] Extension v' + EXT_VERSION + ' loaded');",
  ]);
});

test('Kopfkommentare: content.js wird vom Manifest auf chess.com und lichess geladen', () => {
  const eintrag = manifest.content_scripts.find(cs => cs.js.includes('content.js'));
  assert.ok(eintrag, 'content.js steht in content_scripts');
  assert.ok(eintrag.matches.includes('https://www.chess.com/*'));
  assert.ok(eintrag.matches.includes('https://lichess.org/*'));

  for (const [name, text] of [['content.js', content], ['popup.js', popup]]) {
    const kopf = text.split('\n').slice(0, 20).join('\n');
    assert.doesNotMatch(kopf, /NICHT mehr automatisch/, `${name}: veraltete Behauptung im Kopfkommentar`);
    assert.match(kopf, /content_scripts/, `${name}: Kopfkommentar nennt die Manifest-Liste`);
  }
});
