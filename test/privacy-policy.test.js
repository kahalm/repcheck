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

function extensionSources() {
  const dirs = ['extension', 'extension/lib'];
  const out = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) {
      if (f.endsWith('.js') && f !== 'chess.min.js') out.push(lies(path.join(d, f)));
    }
  }
  return out.join('\n');
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
