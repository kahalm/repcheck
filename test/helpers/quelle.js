'use strict';

// Quelltext-Helfer fuer Tests, die Funktionen per Anker aus den Laufzeitdateien schneiden.
//
// `finde(von, bis)` sucht den Anker in ALLEN Skripten unter extension/ (rekursiv, ohne chess.min.js) und verlangt,
// dass er in genau EINER Datei steht. So bleibt ein Charakterisierungstest gueltig, wenn die Zerlegung (Z36–Z39)
// eine Funktion in eine andere Datei verschiebt — er prueft dann dieselbe Funktion am neuen Ort.
//
// `welt(konsument)` liefert die Quelltexte aller NICHT-Lib-Dateien des content_scripts-Eintrags, der `konsument`
// laedt, aneinandergehaengt (in Manifest-Reihenfolge). Fuer Pruefungen der Art „die Welt enthaelt X", die vor der
// Zerlegung gegen die eine Datei liefen.
//
// Liegt unter test/, laeuft also als (leere) Testdatei mit — das ist harmlos.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const EXT = path.join(__dirname, '..', '..', 'extension');

function alleSkripte(dir = EXT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'web-ext-artifacts') alleSkripte(p, out);
    } else if (e.name.endsWith('.js') && e.name !== 'chess.min.js') {
      out.push(p);
    }
  }
  return out;
}

const rel = (p) => path.relative(EXT, p).split(path.sep).join('/');
const lies = (relPfad) => fs.readFileSync(path.join(EXT, relPfad), 'utf8');

function finde(von, bis) {
  const treffer = alleSkripte().filter((p) => fs.readFileSync(p, 'utf8').includes(von));
  assert.strictEqual(treffer.length, 1, `Anker „${von}" in ${treffer.length} Dateien: ${treffer.map(rel).join(', ')}`);
  const src = fs.readFileSync(treffer[0], 'utf8');
  const a = src.indexOf(von);
  const b = bis == null ? src.length : src.indexOf(bis, a + von.length);
  assert.ok(b > a, `${rel(treffer[0])}: End-Anker „${bis}" nicht gefunden`);
  return src.slice(a, b);
}

function welt(konsument) {
  const manifest = JSON.parse(lies('manifest.json'));
  const eintrag = manifest.content_scripts.find((cs) => (cs.js || []).includes(konsument));
  assert.ok(eintrag, 'kein Manifest-Eintrag mit ' + konsument);
  return eintrag.js.filter((f) => !f.startsWith('lib/') && f !== 'chess.min.js').map(lies).join('\n');
}

module.exports = { EXT, alleSkripte, finde, welt, lies, rel };
