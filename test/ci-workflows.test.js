'use strict';

// Hält das Test-Gate der CI fest. Bis v1.68.0 liefen die Node-Tests in keiner CI: build.yml
// machte nur lint + build, und release.yml reichte einen Tag ungetestet bei AMO (listed) und im
// Chrome Web Store ein. Ein Handstart (workflow_dispatch) las den Eingabewert „tag" nicht und reichte
// den Stand des gewählten Branches ein. Danach lösten test und release den Tag noch getrennt auf; ein
// zwischen den Jobs neu gesetzter Tag (git tag -f / push -f) ging so ungeprüft in die Stores. Die
// Workflows werden hier als Text geprüft (kein YAML-Parser als Abhängigkeit): Schlüssel und
// Reihenfolge der Schritte.

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

// Ein Schritt eines Jobs: von „      - name: <name>" bis zum nächsten Schritt.
function step(jobBody, name) {
  const start = jobBody.indexOf('      - name: ' + name + '\n');
  assert.ok(start >= 0, `Schritt ${name} fehlt`);
  const rest = jobBody.slice(start + 1);
  const next = rest.search(/^      - /m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

const TAG_PIN = "ref: ${{ github.event_name == 'workflow_dispatch' && format('refs/tags/{0}', inputs.tag) || github.ref }}";

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

test('release.yml: Handstart prüft den angegebenen Tag, nicht den Branch', () => {
  const t = job(lies('.github/workflows/release.yml'), 'test');
  assert.ok(t.indexOf('actions/checkout@') >= 0, 'test: checkout fehlt');
  assert.ok(t.includes(TAG_PIN), 'test: checkout muss für workflow_dispatch refs/tags/<tag> nehmen');
});

test('release.yml: release baut genau den im Job test geprüften Commit', () => {
  const yml = lies('.github/workflows/release.yml');
  const t = job(yml, 'test');
  assert.match(t, /^    outputs:\n      sha: \$\{\{ steps\.sha\.outputs\.sha \}\}\s*$/m, 'test muss outputs.sha ausgeben');
  const sha = step(t, 'Geprüften Commit festhalten');
  assert.match(sha, /^        id: sha\s*$/m);
  assert.ok(sha.includes('echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"'), 'sha muss aus git rev-parse HEAD kommen');
  assert.ok(t.indexOf('actions/checkout@') < t.indexOf('id: sha'), 'sha erst nach dem Checkout festhalten');
  assert.ok(t.indexOf('id: sha') < t.indexOf('run: npm test'), 'sha vor den Tests festhalten');

  const r = job(yml, 'release');
  assert.ok(!r.includes(TAG_PIN) && !r.includes('inputs.tag)'), 'release darf den Tag nicht selbst auflösen');
  const checkout = r.indexOf('actions/checkout@');
  assert.ok(checkout >= 0, 'release: checkout fehlt');
  assert.match(r.slice(checkout), /^\s+with:\n\s+ref: \$\{\{ needs\.test\.outputs\.sha \}\}\s*$/m, 'release muss needs.test.outputs.sha auschecken');
  const guard = step(r, 'Gebaut wird der geprüfte Commit');
  assert.ok(guard.includes('SHA: ${{ needs.test.outputs.sha }}'));
  assert.ok(guard.includes('if [ -z "$SHA" ] || [ "$HEAD_SHA" != "$SHA" ]; then') && guard.includes('exit 1'),
    'leerer oder abweichender Commit muss abbrechen');
  assert.ok(r.indexOf('Gebaut wird der geprüfte Commit') < r.indexOf('web-ext@latest build'), 'Prüfung vor dem Build');
});

test('release.yml: GitHub-Release hängt am gebauten Tag, nicht an github.ref', () => {
  const gh = step(job(lies('.github/workflows/release.yml'), 'release'), 'Create GitHub Release');
  assert.ok(gh.includes("tag_name: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}"),
    'tag_name muss beim Handstart inputs.tag nehmen');
  assert.match(gh, /^        if: github\.event_name == 'workflow_dispatch' \|\| startsWith\(github\.ref, 'refs\/tags\/'\)\s*$/m);
});
