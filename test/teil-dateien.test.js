'use strict';

// Zerlegung Z36–Z38: die Teil-Dateien eines Content-Scripts (chessable-activity/*.js, content/*.js, chessable-fen/*.js)
// laufen nur, wenn das Manifest sie im SELBEN content_scripts-Eintrag VOR ihrem Konsumenten laedt — dort legen sie
// ihre Funktionen ab, der Konsument verdrahtet sie. Und sie brauchen denselben Guard wie der Konsument: laedt das
// Popup die Manifest-Liste in einen Tab nach, in dem die Welt schon laeuft, darf keine Teil-Datei etwas neu anlegen.
// Ausserdem: jede Datei im Ordner steht im Manifest (eine vergessene Datei waere ein toter Teil bzw. ein
// ReferenceError beim Verdrahten).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

const WELTEN = [
  { konsument: 'chessable-activity.js', ordner: 'chessable-activity', guard: 'if (window.__repcheckChessableActivity) return;' },
  { konsument: 'content.js', ordner: 'content', guard: 'if (window.__rdc_loaded) return;' },
  { konsument: 'chessable-fen.js', ordner: 'chessable-fen', guard: 'if (window.__repcheckChessableFen) return;' },
];

for (const { konsument, ordner, guard } of WELTEN) {
  const dir = path.join(EXT, ordner);
  const dateien = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => ordner + '/' + f) : [];

  test(`${konsument}: Teil-Dateien in ${ordner}/ stehen im Manifest vor dem Konsumenten`, { skip: !dateien.length }, () => {
    const eintrag = manifest.content_scripts.find((cs) => (cs.js || []).includes(konsument));
    const k = eintrag.js.indexOf(konsument);
    for (const f of dateien) {
      const i = eintrag.js.indexOf(f);
      assert.ok(i >= 0, `${f} fehlt im Manifest-Eintrag von ${konsument}`);
      assert.ok(i < k, `${f} muss VOR ${konsument} geladen werden`);
    }
    // Und umgekehrt: alles aus dem Ordner, was im Eintrag steht, gibt es auch.
    for (const f of eintrag.js.filter((x) => x.startsWith(ordner + '/'))) {
      assert.ok(fs.existsSync(path.join(EXT, f)), `${f} steht im Manifest, die Datei fehlt`);
    }
  });

  test(`${konsument}: jede Teil-Datei hat denselben Guard wie der Konsument`, { skip: !dateien.length }, () => {
    assert.ok(fs.readFileSync(path.join(EXT, konsument), 'utf8').includes(guard.replace(' return;', '')), `${konsument}: Guard nicht gefunden`);
    for (const f of dateien) {
      const src = fs.readFileSync(path.join(EXT, f), 'utf8');
      assert.ok(src.includes(guard), `${f}: Guard „${guard}" fehlt`);
    }
  });
}
