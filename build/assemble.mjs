// Build-Schritt: single-sourcet die reinen Shared-Core-Helfer.
//
// Quelle der Wahrheit ist extension/lib/repertoire-text.js. Die Extension lädt
// diese Datei als Content-Script (self.RepCheckLib); der Userscript kann keine
// separate Datei laden, daher werden die Funktionen hier in repcheck.user.js
// zwischen den Sentinel-Markern eingefügt. So gibt es nur EINE Quelle.
//
// Aufruf:  npm run build:userscript   (bzw. node build/assemble.mjs)
// Idempotent: mehrfaches Ausführen erzeugt dasselbe Ergebnis.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(root, 'extension/lib/repertoire-text.js');
const USER = join(root, 'repcheck.user.js');

const BEGIN = '  // >>>REPCHECK-SHARED:repertoire-text';
const END = '  // <<<REPCHECK-SHARED:repertoire-text';

// Reine Funktions-Deklarationen aus lib extrahieren: von der ersten `function`
// bis vor den CommonJS/Browser-Export-Block.
const lib = readFileSync(LIB, 'utf8');
const start = lib.indexOf('function tokenizePgn');
const end = lib.indexOf('// Node/CommonJS-Export');
if (start < 0 || end < 0 || end < start) {
  console.error('assemble: lib-Funktionsbereich nicht gefunden — Marker in repertoire-text.js verändert?');
  process.exit(1);
}
const core = lib.slice(start, end).trimEnd();
// Auf die Userscript-IIFE-Einrückung (2 Leerzeichen) bringen.
const indented = core.split('\n').map((l) => (l.length ? '  ' + l : l)).join('\n');

let user = readFileSync(USER, 'utf8');
const bi = user.indexOf(BEGIN);
const ei = user.indexOf(END);
if (bi < 0 || ei < 0 || ei < bi) {
  console.error('assemble: Sentinel-Marker in repcheck.user.js nicht gefunden.');
  process.exit(1);
}
const rebuilt = user.slice(0, bi + BEGIN.length) + '\n' + indented + '\n' + user.slice(ei);
if (rebuilt !== user) {
  writeFileSync(USER, rebuilt);
  console.log('assemble: repcheck.user.js Shared-Core-Region aus lib/repertoire-text.js neu erzeugt.');
} else {
  console.log('assemble: bereits aktuell (keine Änderung).');
}
