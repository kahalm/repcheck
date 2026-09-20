'use strict';

// Der gespeicherte rkh_-Token darf NICHT mehr in das seiten-injizierte
// Token-Input vorbefuellt werden: das Panel haengt im DOM von chess.com/
// lichess, jedes Seiten-Skript koennte den Klartext aus dem Input lesen
// (s. CLAUDE.md „Sicherheit"). Stattdessen zeigt der Platzhalter an, dass ein
// Token hinterlegt ist, und der Connect-Handler greift bei leerem Feld auf den
// gespeicherten Token zurueck — der Ablauf fuer den Nutzer bleibt gleich.
//
// Die Panel-Glue-Logik lag frueher doppelt vor (extension/content.js und repcheck.user.js);
// hand-gespiegelt und in Node nicht als Ganzes ladbar (IIFE + DOM). Die Tests
// schneiden daher die ECHTEN Codebloecke per stabiler Anker aus beiden Dateien
// und fuehren sie mit Stubs aus — laufen also gegen den ausgelieferten Code
// und halten die beiden Spiegel nebenbei synchron.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lies = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DATEIEN = ['extension/content.js'];

function schnipsel(src, vonAnker, bisAnker, datei) {
  const von = src.indexOf(vonAnker);
  assert.ok(von >= 0, `${datei}: Anker nicht gefunden: ${vonAnker}`);
  const bis = src.indexOf(bisAnker, von);
  assert.ok(bis > von, `${datei}: End-Anker nicht gefunden: ${bisAnker}`);
  return src.slice(von, bis);
}

// Fuehrt den Vorbefuellungs-Block (loadRookhubConfig().then(…)) einer Datei aus.
async function fuehreVorbefuellungAus(datei, cfg) {
  let block = schnipsel(lies(datei), 'loadRookhubConfig().then(cfg => {',
    "document.getElementById('repcheck-pick-dir')", datei).trimEnd();
  assert.ok(block.endsWith(';'), `${datei}: Vorbefuellungs-Block endet nicht mit ;`);
  block = block.slice(0, -1);
  const inputs = {
    'repcheck-rookhub-url': { value: '', placeholder: 'https://rookhub.example.com' },
    'repcheck-rookhub-token': { value: '', placeholder: 'rkh_…' },
  };
  const doc = { getElementById: (id) => inputs[id] || null };
  const fn = new Function('loadRookhubConfig', 'document', 'ROOKHUB_DEFAULT_URL', 't',
    'return (async () => { await (' + block + '); })();');
  await fn(async () => cfg, doc, 'https://rookhub.example', (k) => '<' + k + '>');
  return inputs;
}

// Registriert den Connect-Click-Handler einer Datei mit Stubs und klickt ihn.
async function klickeVerbinden(datei, { getippt, gespeichert }) {
  const block = schnipsel(lies(datei), "document.getElementById('repcheck-rookhub-connect')",
    "document.getElementById('repcheck-rookhub-refresh')", datei).trimEnd();
  const inputs = {
    'repcheck-rookhub-url': { value: 'https://rookhub.example' },
    'repcheck-rookhub-token': { value: getippt || '' },
  };
  let handler = null;
  const doc = {
    getElementById: (id) => (id === 'repcheck-rookhub-connect'
      ? { addEventListener: (_ev, fn) => { handler = fn; } }
      : inputs[id] || null),
  };
  const calls = { status: [], save: [], connect: [] };
  const fn = new Function('document', 'updateStatusText', 't',
    'saveRookhubConfig', 'connectRookHub', 'loadRookhubConfig', block);
  fn(doc,
    (s) => calls.status.push(s),
    (k) => k,
    async (c) => calls.save.push(c),
    async (c) => calls.connect.push(c),
    async () => gespeichert);
  assert.ok(handler, `${datei}: Connect-Handler nicht registriert`);
  await handler();
  return calls;
}

for (const datei of DATEIEN) {
  test(`${datei}: gespeicherter Token wird NICHT ins Input vorbefuellt (nur Platzhalter)`, async () => {
    const inputs = await fuehreVorbefuellungAus(datei,
      { url: 'https://rookhub.example', token: 'rkh_geheim' });
    assert.strictEqual(inputs['repcheck-rookhub-token'].value, '',
      'Klartext-Token liegt wieder im seiten-lesbaren Input');
    assert.strictEqual(inputs['repcheck-rookhub-token'].placeholder, '<panel.tokenSaved>');
    assert.strictEqual(inputs['repcheck-rookhub-url'].value, 'https://rookhub.example');
  });

  test(`${datei}: ohne gespeicherten Token bleibt der rkh_-Platzhalter stehen`, async () => {
    const inputs = await fuehreVorbefuellungAus(datei, { url: 'https://rookhub.example' });
    assert.strictEqual(inputs['repcheck-rookhub-token'].value, '');
    assert.strictEqual(inputs['repcheck-rookhub-token'].placeholder, 'rkh_…');
  });

  test(`${datei}: Verbinden mit leerem Feld nutzt den gespeicherten Token`, async () => {
    const calls = await klickeVerbinden(datei, {
      getippt: '',
      gespeichert: { url: 'https://rookhub.example', token: 'rkh_gespeichert' },
    });
    assert.strictEqual(calls.connect.length, 1, 'connectRookHub wurde nicht aufgerufen');
    assert.strictEqual(calls.connect[0].token, 'rkh_gespeichert');
    assert.strictEqual(calls.save[0].token, 'rkh_gespeichert');
    assert.ok(!calls.status.includes('status.needUrlToken'),
      'leeres Feld + gespeicherter Token darf keinen Fehler ausloesen');
  });

  test(`${datei}: getippter Token gewinnt gegen den gespeicherten`, async () => {
    const calls = await klickeVerbinden(datei, {
      getippt: 'rkh_neu',
      gespeichert: { url: 'https://rookhub.example', token: 'rkh_alt' },
    });
    assert.strictEqual(calls.connect[0].token, 'rkh_neu');
    assert.strictEqual(calls.save[0].token, 'rkh_neu');
  });

  test(`${datei}: weder getippt noch gespeichert → Fehlermeldung, kein Connect`, async () => {
    const calls = await klickeVerbinden(datei, { getippt: '', gespeichert: null });
    assert.deepStrictEqual(calls.status, ['status.needUrlToken']);
    assert.strictEqual(calls.connect.length, 0);
  });
}
