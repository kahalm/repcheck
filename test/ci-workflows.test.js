'use strict';

// Hält das Test-Gate der CI fest. Bis v1.68.0 liefen die Node-Tests in keiner CI: build.yml
// machte nur lint + build, und release.yml reichte einen Tag ungetestet bei AMO (listed) und im
// Chrome Web Store ein. Ein Handstart (workflow_dispatch) las den Eingabewert „tag" nicht und reichte
// den Stand des gewählten Branches ein. Die Workflows werden hier als Text geprüft (kein YAML-Parser
// als Abhängigkeit): Schlüssel und Reihenfolge der Schritte.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lies = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Rumpf eines Jobs: von „  <name>:" bis zum nächsten Job auf derselben Einrückung.
function job(yml, name) {
  const start = yml.search(new RegExp('^  ' + name + ':\\s*$', 'm'));
  assert.ok(start >= 0, `Job ${name} fehlt`);
  const rest = yml.slice(start + 1);
  const next = rest.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('package.json: npm test startet node --test', () => {
  const pkg = JSON.parse(lies('package.json'));
  assert.match(pkg.scripts.test, /^node --test\b/);
});

test('build.yml: Unit-Tests laufen vor web-ext build', () => {
  const b = job(lies('.github/workflows/build.yml'), 'build');
  const tests = b.indexOf('run: npm test');
  assert.ok(tests >= 0, 'build.yml ruft npm test nicht auf');
  assert.ok(tests < b.indexOf('web-ext@latest build'), 'npm test muss vor dem Build stehen');
});

test('release.yml: Einreichung hängt am Test-Job', () => {
  const yml = lies('.github/workflows/release.yml');
  const t = job(yml, 'test');
  assert.ok(t.includes('run: npm test'), 'Job test ruft npm test nicht auf');
  const r = job(yml, 'release');
  assert.match(r, /^\s+needs:\s*test\s*$/m, 'release braucht needs: test');
  assert.ok(!r.includes('continue-on-error'), 'release darf das Gate nicht aufweichen');
  assert.ok(r.indexOf('web-ext@latest sign') > 0, 'AMO-Einreichung erwartet');
});

test('release.yml: Tag muss zur manifest.json-Version passen', () => {
  const t = job(lies('.github/workflows/release.yml'), 'test');
  assert.ok(t.includes("require('./extension/manifest.json').version"), 'Versions-Check liest das Manifest nicht');
  assert.match(t, /if \[ "\$TAG" != "v\$VERSION" \]; then/);
  assert.match(t, /exit 1/);
});

test('release.yml: Handstart baut den angegebenen Tag, nicht den Branch', () => {
  const yml = lies('.github/workflows/release.yml');
  const pin = "ref: ${{ github.event_name == 'workflow_dispatch' && format('refs/tags/{0}', inputs.tag) || github.ref }}";
  for (const name of ['test', 'release']) {
    const j = job(yml, name);
    const checkout = j.indexOf('actions/checkout@');
    assert.ok(checkout >= 0, `${name}: checkout fehlt`);
    assert.ok(j.includes(pin), `${name}: checkout muss für workflow_dispatch refs/tags/<tag> nehmen`);
  }
});
