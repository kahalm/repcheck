'use strict';

// Das Seiten-Panel („Ordner / PGN auf der Seite…") haengt im DOM von chess.com/lichess. Jedes
// Skript der Seite (XSS, kompromittiertes Drittskript) sieht es, kann Werte in seine Felder
// schreiben und Knoepfe per click() ausloesen — die Listener der isolierten Welt bekommen das
// wie einen echten Klick.
//
// Bis v1.68.1 hatte das Panel URL, Token und „Verbinden": die Seite trug eine eigene Adresse ein,
// liess das Token-Feld leer und klickte. Der Handler nahm dann den GESPEICHERTEN rkh_-Token,
// schrieb rookhubConfig auf die fremde Adresse um (die Egress-Allowlist des Workers folgt ihr)
// und schickte den Token per Bearer dorthin (W1 S1-001). Seit v1.68.2 lebt die Verbindung allein
// im Popup (Extension-Origin); das Panel behaelt Ordner, PGN, Sprache und „Aktualisieren", und das
// liest nur die gespeicherte Config.
//
// Getestet wird der ausgelieferte Code: panelHtml + wirePanelEvents werden per stabiler Anker aus
// extension/content.js ausgeschnitten und mit Stubs gegen ein Fake-DOM ausgefuehrt, in dem die
// „Seite" zu JEDER abgefragten id ein Element liefert — auch zu den alten Feldern.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { RC_LANGS, RC_MESSAGES } = require('../extension/lib/i18n.js');

const ROOT = path.join(__dirname, '..');
const DATEI = 'extension/content.js';
const QUELLE = fs.readFileSync(path.join(ROOT, DATEI), 'utf8');

function schnipsel(src, vonAnker, bisAnker) {
  const von = src.indexOf(vonAnker);
  assert.ok(von >= 0, `${DATEI}: Anker nicht gefunden: ${vonAnker}`);
  const bis = src.indexOf(bisAnker, von);
  assert.ok(bis > von, `${DATEI}: End-Anker nicht gefunden: ${bisAnker}`);
  return src.slice(von, bis);
}

const PANEL_BLOCK = schnipsel(QUELLE, '// Panel-Markup (reiner String, keine DOM-Nebenwirkungen).',
  'function togglePanel() {');

const GESPEICHERT = { url: 'https://rookhub.example', token: 'rkh_gespeichert' };
const FREMD = 'https://evil.example';

// Baut Panel-Funktionen samt Stubs; `doc` ist ein Fake-DOM, das zu jeder id ein Element liefert.
function ladePanel() {
  const calls = { save: [], connect: [], storageSet: [], status: [], ids: new Set() };
  const elemente = new Map();
  const element = (id) => {
    if (!elemente.has(id)) {
      elemente.set(id, {
        id, value: '', placeholder: '', listeners: [],
        addEventListener(typ, fn) { this.listeners.push({ typ, fn }); },
      });
    }
    return elemente.get(id);
  };
  const doc = { getElementById: (id) => { calls.ids.add(id); return element(id); } };
  const chrome = {
    storage: { local: {
      set: (obj, cb) => { calls.storageSet.push(obj); if (cb) cb(); },
      remove: () => {},
      get: (_k, cb) => cb({ rookhubConfig: GESPEICHERT }),
    } },
  };
  const fn = new Function(
    't', 'rcEscHtml', 'rcAutoLang', 'repertoirePositions', 'rcGespeicherteSprache', 'document',
    'chrome', 'self', 'navigator', 'rcApplyLang', 'loadRookhubConfig', 'saveRookhubConfig',
    'connectRookHub', 'updateStatusText', 'pickDirectory', 'loadRepertoireFromText', 'togglePanel',
    'ROOKHUB_DEFAULT_URL',
    "let rcLang = 'en'; let lastGameMovesKey = 'alt';\n" + PANEL_BLOCK +
    '\nreturn { panelHtml, wirePanelEvents, lastKey: () => lastGameMovesKey };');
  const api = fn(
    (k) => '<' + k + '>',
    (s) => String(s),
    () => 'en',
    null,
    '',
    doc,
    chrome,
    { RepCheckI18n: { resolveLang: () => 'en' } },
    { languages: ['en'] },
    () => {},
    async () => ({ ...GESPEICHERT }),
    async (c) => { calls.save.push(c); },
    async (c, opts) => { calls.connect.push({ cfg: c, opts: opts || null }); },
    (s) => calls.status.push(s),
    async () => {},
    async () => {},
    () => {},
    'https://rookhub.default');
  return { api, calls, element, elemente };
}

const tick = () => new Promise((r) => setImmediate(r));

test('Panel-Markup hat keine URL-/Token-Felder und keinen Verbinden-Knopf', () => {
  const { api } = ladePanel();
  const html = api.panelHtml();
  for (const id of ['repcheck-rookhub-url', 'repcheck-rookhub-token', 'repcheck-rookhub-connect']) {
    assert.ok(!html.includes(id), `Seiten-Panel enthaelt wieder ${id}`);
  }
  assert.ok(!/type="password"/.test(html), 'Seiten-Panel hat wieder ein Passwort-/Token-Feld');
  // Was bleibt: Hinweis aufs Popup und „Aktualisieren".
  assert.ok(html.includes('<panel.connectInPopup>'), 'Hinweis auf das Popup fehlt');
  assert.ok(html.includes('id="repcheck-rookhub-refresh"'), '„Aktualisieren" fehlt');
});

test('Seiten-Skript traegt fremde Adresse ein und klickt alles: kein Speichern, kein Token an die fremde Adresse', async () => {
  const { api, calls, element, elemente } = ladePanel();
  api.wirePanelEvents();
  await tick();   // eine etwaige Vorbefuellung abwarten — die Seite schreibt danach
  // Die „Seite" setzt die alten Felder (auch wenn es sie nicht mehr gibt, koennte sie sie anlegen).
  element('repcheck-rookhub-url').value = FREMD;
  element('repcheck-rookhub-token').value = '';
  assert.ok(!element('repcheck-rookhub-connect').listeners.length,
    'auf #repcheck-rookhub-connect haengt wieder ein Listener');
  for (const el of [...elemente.values()]) {
    for (const { typ, fn } of el.listeners) {
      if (typ === 'click') await fn({ isTrusted: false });
    }
  }
  assert.deepStrictEqual(calls.save, [], 'Panel hat die RookHub-Config geschrieben');
  assert.ok(!calls.storageSet.some((o) => o && 'rookhubConfig' in o),
    'Panel hat rookhubConfig in chrome.storage.local geschrieben');
  for (const c of calls.connect) {
    assert.notStrictEqual(c.cfg.url, FREMD, 'Proxy-Aufruf an die fremde Adresse');
    assert.strictEqual(c.cfg.url, GESPEICHERT.url);
  }
  assert.ok(!calls.ids.has('repcheck-rookhub-token'), 'Panel liest wieder ein Token-Feld aus dem Seiten-DOM');
});

test('„Aktualisieren" nimmt die gespeicherte Config und fordert refresh an', async () => {
  const { api, calls, element } = ladePanel();
  api.wirePanelEvents();
  await tick();
  element('repcheck-rookhub-url').value = FREMD;
  const refresh = element('repcheck-rookhub-refresh').listeners.find((l) => l.typ === 'click');
  assert.ok(refresh, '„Aktualisieren" ist nicht verdrahtet');
  await refresh.fn();
  assert.strictEqual(calls.connect.length, 1);
  assert.deepStrictEqual(calls.connect[0].cfg, GESPEICHERT);
  assert.deepStrictEqual(calls.connect[0].opts, { refresh: true });
  assert.strictEqual(api.lastKey(), '', 'Zug-Cache wird nach dem Aktualisieren nicht geleert');
});

test('content.js schreibt die RookHub-Config nicht mehr aus dem Seiten-Kontext', () => {
  assert.ok(!/function saveRookhubConfig\b/.test(QUELLE), 'saveRookhubConfig ist zurueck');
  for (const id of ['repcheck-rookhub-url', 'repcheck-rookhub-token', 'repcheck-rookhub-connect']) {
    assert.ok(!QUELLE.includes(id), `content.js referenziert wieder ${id}`);
  }
});

test('jeder Text-Schluessel des Panels existiert in allen Sprachen', () => {
  const keys = [...PANEL_BLOCK.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]);
  assert.ok(keys.includes('panel.connectInPopup'));
  for (const lang of RC_LANGS) {
    const fehlend = keys.filter((k) => !(k in RC_MESSAGES[lang]));
    assert.deepStrictEqual(fehlend, [], `${lang} fehlen Panel-Schluessel: ${fehlend.join(', ')}`);
  }
});
