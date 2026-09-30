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
  assert.ok(tests < b.indexOf('web-ext build'), 'npm test muss vor dem Build stehen');
});

test('release.yml: Build und Einreichung hängen am Test-Job', () => {
  const yml = lies('.github/workflows/release.yml');
  const t = job(yml, 'test');
  assert.ok(t.includes('run: npm test'), 'Job test ruft npm test nicht auf');
  assert.match(job(yml, 'build'), /^    needs: test\s*$/m, 'build braucht needs: test');
  assert.match(job(yml, 'amo'), /^    needs: \[test, build\]\s*$/m, 'amo braucht test (für outputs.sha) und build');
  assert.match(job(yml, 'cws'), /^    needs: build\s*$/m, 'cws braucht build');
  assert.match(job(yml, 'github-release'), /^    needs: build\s*$/m, 'github-release braucht build');
  assert.ok(!yml.includes('continue-on-error'), 'kein Job darf das Gate oder seinen Fehlschlag aufweichen');
  assert.ok(step(job(yml, 'amo'), 'Submit to Firefox AMO listing (if secrets configured)').includes('web-ext sign'),
    'AMO-Einreichung erwartet');
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

test('release.yml: build und amo nehmen genau den im Job test geprüften Commit', () => {
  const yml = lies('.github/workflows/release.yml');
  const t = job(yml, 'test');
  assert.match(t, /^    outputs:\n      sha: \$\{\{ steps\.sha\.outputs\.sha \}\}\s*$/m, 'test muss outputs.sha ausgeben');
  const sha = step(t, 'Geprüften Commit festhalten');
  assert.match(sha, /^        id: sha\s*$/m);
  assert.ok(sha.includes('echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"'), 'sha muss aus git rev-parse HEAD kommen');
  assert.ok(t.indexOf('actions/checkout@') < t.indexOf('id: sha'), 'sha erst nach dem Checkout festhalten');
  assert.ok(t.indexOf('id: sha') < t.indexOf('run: npm test'), 'sha vor den Tests festhalten');

  // build und amo checken aus; cws und github-release nehmen die ZIP aus build (Artefakt).
  for (const [name, guardName, action] of [
    ['build', 'Gebaut wird der geprüfte Commit', 'web-ext build'],
    ['amo', 'Eingereicht wird der geprüfte Commit', 'web-ext sign'],
  ]) {
    const r = job(yml, name);
    assert.ok(!r.includes(TAG_PIN) && !r.includes('inputs.tag)'), `${name} darf den Tag nicht selbst auflösen`);
    const checkout = r.indexOf('actions/checkout@');
    assert.ok(checkout >= 0, `${name}: checkout fehlt`);
    assert.match(r.slice(checkout), /^\s+with:\n\s+ref: \$\{\{ needs\.test\.outputs\.sha \}\}\s*$/m, `${name} muss needs.test.outputs.sha auschecken`);
    const guard = step(r, guardName);
    assert.ok(guard.includes('SHA: ${{ needs.test.outputs.sha }}'));
    assert.ok(guard.includes('if [ -z "$SHA" ] || [ "$HEAD_SHA" != "$SHA" ]; then') && guard.includes('exit 1'),
      'leerer oder abweichender Commit muss abbrechen');
    assert.ok(r.indexOf(guardName) < r.indexOf(action), `${name}: Prüfung vor ${action}`);
  }
  for (const name of ['cws', 'github-release']) {
    assert.ok(!job(yml, name).includes('actions/checkout@'), `${name} braucht keinen Checkout, nur die ZIP aus build`);
  }
});

test('release.yml: GitHub-Release hängt am gebauten Tag, nicht an github.ref', () => {
  const gh = step(job(lies('.github/workflows/release.yml'), 'github-release'), 'Create GitHub Release');
  assert.ok(gh.includes("tag_name: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}"),
    'tag_name muss beim Handstart inputs.tag nehmen');
  assert.match(gh, /^        if: github\.event_name == 'workflow_dispatch' \|\| startsWith\(github\.ref, 'refs\/tags\/'\)\s*$/m);
});

// S1-010: Lieferkette des Release-Laufs. Bis v1.68.13 lief AMO-Einreichung und Build über
// „npx --yes web-ext@latest" — die jeweils neueste npm-Version samt frisch aufgelöster Abhängigkeiten,
// im selben Job wie AMO-Key/Secret (zusätzlich als Argumente) und ein contents:write-Token, den
// actions/checkout in .git/config ablegte. Actions hingen an verschiebbaren Tags, build.yml hatte
// keinen permissions-Block.
const WORKFLOWS = ['.github/workflows/build.yml', '.github/workflows/release.yml'];
// Ganze Kommentarzeilen weg: die Kommentare erklären die alte Aufrufform.
const code = (yml) => yml.replace(/^\s*#.*$/gm, '');

test('Lieferkette: web-ext kommt aus package-lock.json, nie als npx web-ext@latest', () => {
  const pkg = JSON.parse(lies('package.json'));
  const ver = pkg.devDependencies && pkg.devDependencies['web-ext'];
  assert.match(String(ver), /^\d+\.\d+\.\d+$/, 'web-ext als devDependency mit exakter Version');
  const lock = JSON.parse(lies('package-lock.json'));
  assert.strictEqual(lock.packages[''].devDependencies['web-ext'], ver, 'Lockfile passt nicht zu package.json');
  assert.strictEqual(lock.packages['node_modules/web-ext'].version, ver, 'Lockfile löst web-ext nicht exakt auf');
  assert.match(lock.packages['node_modules/web-ext'].integrity, /^sha512-/);
  assert.match(lies('.gitignore'), /^node_modules\/$/m, 'node_modules gehört nicht ins Repo');

  for (const wf of WORKFLOWS) {
    const yml = code(lies(wf));
    assert.ok(!/web-ext@/.test(yml), `${wf}: web-ext nicht per npx@<version> nachladen`);
    assert.ok(!/npx\b[^\n]*web-ext/.test(yml), `${wf}: web-ext nicht über npx`);
    const calls = [...yml.matchAll(/\.\.\/node_modules\/\.bin\/web-ext /g)].map((m) => m.index);
    assert.ok(calls.length > 0, `${wf}: web-ext aus node_modules erwartet`);
    const ci = yml.indexOf('run: npm ci --ignore-scripts');
    assert.ok(ci >= 0, `${wf}: npm ci --ignore-scripts fehlt`);
    assert.ok(calls.every((i) => i > ci), `${wf}: npm ci muss vor jedem web-ext-Aufruf stehen`);
  }
});

test('Lieferkette: jede Action auf einen Commit-SHA gepinnt', () => {
  for (const wf of WORKFLOWS) {
    const uses = [...lies(wf).matchAll(/^\s+(?:- )?uses:\s*(\S+)(.*)$/gm)];
    assert.ok(uses.length > 0, `${wf}: keine Actions gefunden`);
    for (const [, ref, rest] of uses) {
      assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${wf}: ${ref} nicht auf Commit-SHA gepinnt`);
      assert.match(rest, /^ # v\d+\.\d+\.\d+$/, `${wf}: ${ref} ohne Versions-Kommentar`);
    }
  }
});

test('Lieferkette: actions/checkout legt keinen Token in .git/config ab', () => {
  for (const wf of WORKFLOWS) {
    const yml = lies(wf);
    const checkouts = [...yml.matchAll(/uses: actions\/checkout@/g)];
    assert.ok(checkouts.length > 0, `${wf}: checkout fehlt`);
    for (const m of checkouts) {
      const rest = yml.slice(m.index);
      const next = rest.slice(1).search(/^      - /m);
      const block = next >= 0 ? rest.slice(0, next + 1) : rest;
      assert.match(block, /^          persist-credentials: false\s*$/m, `${wf}: checkout ohne persist-credentials: false`);
    }
  }
});

test('Lieferkette: AMO-Keys gehen per env an web-ext, nicht als Argument', () => {
  const yml = code(lies('.github/workflows/release.yml'));
  assert.ok(!/--api-key|--api-secret/.test(yml), 'AMO-Key/Secret nicht als Argument übergeben');
  assert.ok(yml.includes('WEB_EXT_API_KEY: ${{ secrets.AMO_API_KEY }}'), 'WEB_EXT_API_KEY aus secrets.AMO_API_KEY');
  assert.ok(yml.includes('WEB_EXT_API_SECRET: ${{ secrets.AMO_API_SECRET }}'), 'WEB_EXT_API_SECRET aus secrets.AMO_API_SECRET');
});

test('Rechte: Workflows lesen nur, Schreibrecht nur für das GitHub-Release', () => {
  for (const wf of WORKFLOWS) {
    assert.match(lies(wf), /^permissions:\n  contents: read\s*$/m, `${wf}: oberster permissions-Block contents: read fehlt`);
  }
  const yml = lies('.github/workflows/release.yml');
  const writes = [...yml.matchAll(/contents: write/g)];
  assert.strictEqual(writes.length, 1, 'contents: write genau einmal');
  const gh = yml.indexOf('uses: softprops/action-gh-release@');
  const jobStarts = [...yml.matchAll(/^  [A-Za-z0-9_-]+:\s*$/gm)].map((m) => m.index);
  const jobOf = (i) => Math.max(...jobStarts.filter((j) => j < i));
  assert.strictEqual(jobOf(writes[0].index), jobOf(gh), 'contents: write nur im Job, der das GitHub-Release anlegt');
});

// S1-011: Store-Fehler waren bis v1.68.13 weich — AMO endete in „|| echo ::warning::", CWS (OAuth, Upload,
// Publish) in „exit 0" bzw. einer Warnung, im selben Job wie das GitHub-Release. Der Lauf war grün, auch wenn
// weder AMO noch der Chrome Web Store die Version bekommen hatten (CWS lässt nur EINE Version im Review zu),
// und niemand reichte nach. Jetzt: eigene Jobs, jeder Fehler rot, das GitHub-Release hängt nicht daran.
test('release.yml: Store-Einreichung in eigenen Jobs, GitHub-Release hängt nicht an ihnen', () => {
  const yml = lies('.github/workflows/release.yml');
  const gh = job(yml, 'github-release');
  assert.ok(gh.includes('uses: softprops/action-gh-release@'), 'GitHub-Release im Job github-release');
  assert.ok(!/needs:.*\b(amo|cws)\b/.test(gh), 'GitHub-Release darf nicht auf die Store-Jobs warten');
  assert.ok(!code(gh).includes('secrets.'), 'github-release sieht keine Store-Secrets');
  assert.ok(!code(job(yml, 'build')).includes('secrets.'), 'build sieht keine Store-Secrets');
  assert.ok(job(yml, 'amo').includes('secrets.AMO_API_KEY') && !job(yml, 'amo').includes('secrets.CWS_'), 'AMO-Secrets nur im Job amo');
  assert.ok(job(yml, 'cws').includes('secrets.CWS_REFRESH_TOKEN') && !job(yml, 'cws').includes('secrets.AMO_'), 'CWS-Secrets nur im Job cws');
  // Beide Stores und das Release bekommen genau die ZIP aus build.
  const up = step(job(yml, 'build'), 'ZIP an die Folge-Jobs');
  assert.match(up, /^          name: extension-zip\s*$/m);
  assert.match(up, /^          if-no-files-found: error\s*$/m);
  assert.match(up, /^          retention-days: 90\s*$/m, 'ZIP lange genug aufheben, um einen Store-Job nachzuholen');
  for (const name of ['cws', 'github-release']) {
    const dl = step(job(yml, name), 'ZIP aus dem Build');
    assert.ok(dl.includes('uses: actions/download-artifact@'), `${name}: ZIP aus build holen`);
    assert.match(dl, /^          name: extension-zip\s*$/m);
  }
});

test('release.yml: gescheiterte Store-Einreichung macht den Lauf rot', () => {
  const yml = code(lies('.github/workflows/release.yml'));
  assert.ok(!yml.includes('::warning::'), 'Store-Fehler nicht als Warnung durchwinken');
  assert.ok(!/\|\|\s*\\?\s*\n?\s*echo/.test(yml), 'kein „|| echo" hinter einem Store-Aufruf');

  const amo = step(job(yml, 'amo'), 'Submit to Firefox AMO listing (if secrets configured)');
  assert.match(amo, /if ! \.\.\/node_modules\/\.bin\/web-ext sign \\/, 'Rückgabewert von web-ext sign prüfen');
  assert.match(amo, /::error::AMO[^\n]*\n\s+exit 1\n/, 'AMO-Fehler endet in exit 1');
  assert.strictEqual((amo.match(/exit 0/g) || []).length, 1, 'exit 0 nur für fehlende Secrets');
  assert.match(amo, /secrets not set — skipping AMO submission"\n\s+exit 0/);

  const cws = step(job(yml, 'cws'), 'Submit to Chrome Web Store (if secrets configured)');
  assert.strictEqual((cws.match(/exit 0/g) || []).length, 1, 'exit 0 nur für fehlende Secrets');
  assert.match(cws, /secrets not set — skipping Chrome Web Store submission"\n\s+exit 0/);
  for (const what of ['OAuth-Refresh', 'CWS-Upload nicht SUCCESS', 'CWS-Publish nicht OK']) {
    assert.match(cws, new RegExp('::error::(CWS: )?' + what + '[^\\n]*\\n\\s+exit 1\\n'), `${what} muss den Job rot machen`);
  }
});
