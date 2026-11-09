'use strict';

// Hält die Datenschutzerklärung am Code fest. Bis v1.68.0 beschrieb PRIVACY.md den Stand von v1.51.0:
// falsche host_permissions (http://*/*), keine Erwähnung von scripting/activeTab, Partiezüge „werden
// nirgendwo gesendet", der automatische games/known-Abgleich fehlte ganz, und STORE-LISTING versprach
// „nowhere else", obwohl die Ein-Klick-Verbindung auf die Instanz des Autors vorbelegt ist.
// Ein neuer RookHub-Endpunkt, ein neues Manifest-Recht oder eine geänderte Standard-Instanz lässt
// diesen Test fallen, bis die Erklärung nachgezogen ist.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lies = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PRIVACY = lies('PRIVACY.md');
const manifest = JSON.parse(lies('extension/manifest.json'));

// Alle Laufzeitskripte, auch in Unterordnern (seit der Zerlegung Z36–Z38: content/, chessable-*/).
function extensionSources() {
  const { alleSkripte } = require('./helpers/quelle.js');
  return alleSkripte().map((p) => fs.readFileSync(p, 'utf8')).join('\n');
}

// RookHub-Pfade, die der Code als String-Literal anspricht ('/api/extension/…', '/api/profile/…').
// Alles ab '?' fällt weg; ein Literal mit '/' am Ende wird im Code um eine Id ergänzt.
function codeEndpoints() {
  const set = new Set();
  const re = /['"`](\/api\/(?:extension|profile)\/[A-Za-z0-9/_-]*)/g;
  let m;
  const src = extensionSources();
  while ((m = re.exec(src))) set.add(m[1]);
  return set;
}

test('docs/privacy.md ist PRIVACY.md mit Jekyll-Kopf (GitHub Pages zeigt die docs-Kopie)', () => {
  const docs = lies('docs/privacy.md');
  const kopf = '---\nlayout: default\ntitle: Privacy Policy\n---\n\n';
  assert.ok(docs.startsWith(kopf), 'docs/privacy.md braucht den Jekyll-Kopf');
  assert.strictEqual(docs.slice(kopf.length), PRIVACY,
    'docs/privacy.md weicht von PRIVACY.md ab — neu erzeugen: Kopf + Inhalt von PRIVACY.md');
});

test('jedes Manifest-Recht steht in der Erklärung', () => {
  for (const p of manifest.permissions || []) {
    assert.ok(PRIVACY.includes('`' + p + '`'), `Recht „${p}" fehlt in PRIVACY.md`);
  }
});

test('host_permissions in der Erklärung entsprechen genau dem Manifest', () => {
  const m = PRIVACY.match(/host_permissions:\s*(\[[^\]]*\])/);
  assert.ok(m, 'PRIVACY.md nennt host_permissions nicht');
  assert.deepStrictEqual(JSON.parse(m[1]), manifest.host_permissions);
});

test('jeder RookHub-Endpunkt aus dem Code steht in der Erklärung', () => {
  const endpoints = codeEndpoints();
  assert.ok(endpoints.size >= 15, 'Endpunkt-Suche findet zu wenig — Muster kaputt?');
  for (const ep of endpoints) {
    const needle = ep.endsWith('/') ? ep + '{' : ep;
    assert.ok(PRIVACY.includes(needle), `Endpunkt ${ep} fehlt in PRIVACY.md`);
  }
});

test('die Erklärung nennt keine Endpunkte, die der Code nicht mehr kennt', () => {
  const endpoints = codeEndpoints();
  const re = /(\/api\/(?:extension|profile)\/[A-Za-z0-9/_{}-]*)/g;
  let m;
  while ((m = re.exec(PRIVACY))) {
    const ep = m[1].replace(/\{.*$/, '');
    assert.ok(endpoints.has(ep), `PRIVACY.md nennt ${m[1]}, den der Code nicht aufruft`);
  }
});

test('die voreingestellte Instanz ist in Erklärung und Store-Text offengelegt', () => {
  const src = extensionSources();
  const hosts = new Set();
  const re = /(?:ROOKHUB_DEFAULT_URL|DEFAULT_ROOKHUB_URL|DEFAULT_ROOKHUB_ORIGIN)\s*=\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) hosts.add(new URL(m[1]).host);
  assert.ok(hosts.size >= 1, 'keine Standard-Instanz im Code gefunden — Muster kaputt?');
  const store = lies('STORE-LISTING.md');
  for (const h of hosts) {
    assert.ok(PRIVACY.includes(h), `Standard-Instanz ${h} fehlt in PRIVACY.md`);
    assert.ok(store.includes(h), `Standard-Instanz ${h} fehlt im Datenschutz-Satz von STORE-LISTING.md`);
  }
});

// S1-001 (Delta-Review 2026-11-09): die Erklärung prüfte bisher nur Endpunkte und Rechte. Seit 1.72.0 legte „Kurs holen"
// Chessable-Antworten in der IndexedDB `RepCheckCrawlCache` ab, 1.71.0 brachte `rcBanRiskAck` — beides fehlte, und die
// Erklärung behauptete „nur im Arbeitsspeicher". Jetzt muss jeder Speicherort aus dem Code in PRIVACY.md stehen.

// Konstanten `const NAME = '…'` bzw. `const NAME = ['…', …]` aus dem Code, um Bezeichner in Aufrufen aufzulösen.
function codeKonstanten(src) {
  const out = {};
  for (const m of src.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*(?:'([^']+)'|\[([^\]]*)\])/g)) {
    out[m[1]] = m[2] ? [m[2]] : [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return out;
}

// Schlüssel der obersten Ebene eines Objektliterals ab `{` (verschachtelte Objekte zählen nicht).
function objektSchluessel(text) {
  const out = [];
  let tiefe = 0, erwarteSchluessel = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[' || c === '(') { tiefe++; if (tiefe === 1) erwarteSchluessel = true; continue; }
    if (c === '}' || c === ']' || c === ')') { tiefe--; if (tiefe === 0) break; continue; }
    if (tiefe === 1 && c === ',') { erwarteSchluessel = true; continue; }
    if (tiefe === 1 && erwarteSchluessel && /[A-Za-z_$]/.test(c)) {
      const m = /^([A-Za-z_$][\w$]*)\s*[:,}]/.exec(text.slice(i));
      if (m) out.push(m[1]);
      erwarteSchluessel = false;
    }
  }
  return out;
}

function storageSchluessel() {
  const src = extensionSources();
  const k = codeKonstanten(src);
  const keys = new Set();
  const aufruf = /(?:storage\.local\.(?:get|set|remove)|\bstore(?:Get|Set|Remove))\(\s*/g;
  let m;
  while ((m = aufruf.exec(src))) {
    const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 600);
    let a;
    if ((a = /^'([^']+)'/.exec(rest))) keys.add(a[1]);
    else if ((a = /^\[([^\]]*)\]/.exec(rest))) {
      for (const x of a[1].matchAll(/'([^']+)'|([A-Z_][A-Z0-9_]*)/g)) (x[1] ? [x[1]] : (k[x[2]] || [])).forEach((s) => keys.add(s));
    } else if ((a = /^\{\s*\[([A-Z_][A-Z0-9_]*)\]/.exec(rest))) (k[a[1]] || []).forEach((s) => keys.add(s));
    else if (rest.startsWith('{')) objektSchluessel(rest).forEach((s) => keys.add(s));
    else if ((a = /^([A-Z_][A-Z0-9_]*)\b/.exec(rest))) (k[a[1]] || []).forEach((s) => keys.add(s));
    // Kleingeschriebene Variablen (key, obj, patch) sind Durchreicher — ihre Schlüssel stehen an den Aufrufern.
  }
  // background.js setzt die Einführungs-Schlüssel über ein `patch`-Objekt.
  for (const x of src.matchAll(/\bpatch\.([A-Za-z_$][\w$]*)\s*=/g)) keys.add(x[1]);
  return keys;
}

function indexedDbNamen() {
  const src = extensionSources();
  const k = codeKonstanten(src);
  const namen = new Set();
  for (const m of src.matchAll(/indexedDB\.open\(\s*(?:'([^']+)'|([A-Z_][A-Z0-9_]*))/g)) {
    (m[1] ? [m[1]] : (k[m[2]] || [m[2]])).forEach((n) => namen.add(n));
  }
  return namen;
}

test('jeder chrome.storage.local-Schlüssel aus dem Code steht in der Erklärung', () => {
  const keys = storageSchluessel();
  for (const bekannt of ['rookhubConfig', 'chessableToken', 'rcBanRiskAck', 'rcOnboarding', 'rcDailyStats']) {
    assert.ok(keys.has(bekannt), `Schlüssel-Suche findet ${bekannt} nicht — Muster kaputt?`);
  }
  for (const key of keys) assert.ok(PRIVACY.includes('`' + key + '`'), `chrome.storage.local-Schlüssel ${key} fehlt in PRIVACY.md`);
});

test('jede IndexedDB aus dem Code steht in der Erklärung, samt Website, auf der sie liegt', () => {
  const namen = indexedDbNamen();
  assert.deepStrictEqual([...namen].sort(), ['RepCheckCrawlCache', 'RepertoireCheckerDB'],
    'neue IndexedDB — in PRIVACY.md aufnehmen (sie liegt im Websitespeicher, nicht bei der Erweiterung)');
  for (const n of namen) assert.ok(PRIVACY.includes('`' + n + '`'), `IndexedDB ${n} fehlt in PRIVACY.md`);
  const zeile = (n) => PRIVACY.split('\n').find((z) => z.startsWith('|') && z.includes('`' + n + '`')) || '';
  assert.match(zeile('RepCheckCrawlCache'), /chessable\.com/);
  assert.match(zeile('RepertoireCheckerDB'), /chess\.com/);
  assert.doesNotMatch(PRIVACY, /IndexedDB `RepertoireCheckerDB` im Browserprofil/);
});

test('die Erklärung verspricht nicht, dass Deinstallieren die Website-IndexedDBs löscht', () => {
  const loeschen = PRIVACY.slice(PRIVACY.indexOf('## Wie werden Daten gelöscht?'));
  assert.doesNotMatch(loeschen, /oder die Erweiterung deinstallieren\.\n/);
  assert.match(loeschen, /RepCheckCrawlCache/);
});

test('die Kopfzeile nennt die ausgelieferte Haupt-/Nebenversion', () => {
  const m = /Geprüft gegen Version der Erweiterung\*\*: (\d+\.\d+)\./.exec(PRIVACY);
  assert.ok(m, 'Kopfzeile ohne Version');
  assert.strictEqual(m[1], manifest.version.split('.').slice(0, 2).join('.'),
    'PRIVACY.md ist gegen eine andere Nebenversion geprüft — durchsehen und Kopfzeile anheben');
});
