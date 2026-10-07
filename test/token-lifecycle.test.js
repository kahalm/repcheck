'use strict';

// Lebenszyklus der Extension-Tokens (S1-007, v1.68.11). Bis v1.68.10 legte jedes „Mit RookHub verbinden" einen
// neuen, NIE ablaufenden Token an und ließ den alten gültig; „Trennen" löschte nur lokal. Ab 20 Tokens lehnte
// RookHub ab, und das Popup zeigte die englische Servermeldung roh.
//
// Getestet wird der ausgelieferte Worker als Ganzes in einer vm (wie test/fetch-proxy.test.js) und der
// „Trennen"-Pfad des Popups per Anker mit dem echten lib/rookhub-client.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { RC_MESSAGES } = require('../extension/lib/i18n.js');

const ROOT = path.join(__dirname, '..');
const lies = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = lies('extension/background.js');
const URL_RH = 'https://rookhub.example.com';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.sig';

function schnipsel(src, vonAnker, bisAnker, datei) {
  const von = src.indexOf(vonAnker);
  assert.ok(von >= 0, `${datei}: Anker nicht gefunden: ${vonAnker}`);
  const bis = src.indexOf(bisAnker, von + vonAnker.length);
  assert.ok(bis > von, `${datei}: End-Anker nicht gefunden: ${bisAnker}`);
  return src.slice(von, bis);
}

// Worker mit Stubs: ein angemeldeter RookHub-Tab (id 5), Storage als Objekt, fetch nach `server(url, init)`.
// Jeder Abruf merkt sich, welcher Token in dem Moment in der Config stand (Reihenfolge Speichern/Widerruf).
function ladeWorker(storage, server) {
  const abrufe = [];
  const nop = { addListener() {} };
  const chrome = {
    runtime: { id: 'x', onMessage: nop, onInstalled: nop, getURL: (p) => 'chrome-extension://x/' + p },
    tabs: {
      onUpdated: nop, onRemoved: nop,
      get: async (id) => ({ id, url: URL_RH + '/dashboard', status: 'complete', windowId: 1 }),
      update: async () => {}, remove: async () => {},
    },
    windows: { update: async () => {} },
    scripting: { executeScript: async () => [{ result: JWT }] },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    storage: {
      local: {
        get: (key, cb) => cb({ [key]: storage[key] }),
        set: (obj, cb) => { Object.assign(storage, JSON.parse(JSON.stringify(obj))); if (cb) cb(); },
      },
    },
  };
  const fetch = async (url, init) => {
    abrufe.push({ url, method: init.method, headers: init.headers, body: init.body,
      tokenInConfig: storage.rookhubConfig && storage.rookhubConfig.token });
    const r = await server(url, init);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (r.body == null ? '' : JSON.stringify(r.body)) };
  };
  const ctx = vm.createContext({ chrome, fetch, URL, atob, navigator: { userAgent: 'Chrome/130' }, console, Date, setTimeout });
  vm.runInContext(SRC, ctx, { filename: 'background.js' });
  return { ctx, abrufe };
}

const angelegt = (id, raw) => ({ status: 200, body: { id, name: 'RepCheck (Chrome)', prefix: raw.slice(0, 12), scope: 'extension', rawToken: raw } });
const laufenderVorgang = () => ({ url: URL_RH, tabId: 5, createdTab: false, activated: false, state: 'waiting', startedAt: Date.now() });

test('Verbinden: Token läuft nach 365 Tagen ab, Id wird mit gespeichert, ohne Vorgänger kein Widerruf', async () => {
  const storage = { rookhubConfig: { url: URL_RH }, rookhubPairing: laufenderVorgang() };
  const w = ladeWorker(storage, (url, init) => (init.method === 'POST' ? angelegt(42, 'rkh_NEUNEUNEU_rest') : { status: 500 }));
  const st = await w.ctx.pairAttemptOnce();
  assert.strictEqual(st.state, 'done');
  assert.strictEqual(w.abrufe.length, 1);
  const body = JSON.parse(w.abrufe[0].body);
  assert.deepStrictEqual([body.scope, body.expiresInDays], ['extension', 365]);
  assert.deepStrictEqual(storage.rookhubConfig, { url: URL_RH, token: 'rkh_NEUNEUNEU_rest', tokenId: 42 });
});

test('erneut verbinden: der alte Token DIESER Instanz wird mit dem Anmelde-JWT widerrufen — nach dem Speichern', async () => {
  const storage = { rookhubConfig: { url: URL_RH, token: 'rkh_ALTALTALT_rest', tokenId: 7 }, rookhubPairing: laufenderVorgang() };
  const w = ladeWorker(storage, (url, init) => (init.method === 'POST' ? angelegt(43, 'rkh_NEUNEUNEU_rest') : { status: 204 }));
  const st = await w.ctx.pairAttemptOnce();
  assert.strictEqual(st.state, 'done');
  assert.deepStrictEqual(w.abrufe.map((a) => a.method + ' ' + a.url),
    ['POST ' + URL_RH + '/api/profile/tokens', 'DELETE ' + URL_RH + '/api/profile/tokens/7']);
  assert.strictEqual(w.abrufe[1].headers.Authorization, 'Bearer ' + JWT);
  // Beim Widerruf steht schon der neue Token in der Config: stirbt der Worker dazwischen, bleibt nie ein
  // widerrufener Token gespeichert.
  assert.strictEqual(w.abrufe[1].tokenInConfig, 'rkh_NEUNEUNEU_rest');
  assert.deepStrictEqual(storage.rookhubConfig, { url: URL_RH, token: 'rkh_NEUNEUNEU_rest', tokenId: 43 });
});

test('Verbindung von vor v1.68.11 (ohne Id): der Vorgänger wird über Präfix und Namen gefunden, sonst nichts', async () => {
  const liste = [
    { id: 3, name: 'RepCheck (Firefox)', prefix: 'rkh_ALTALTAL', scope: 'extension' },   // unser Token
    { id: 4, name: 'Mein Skript', prefix: 'rkh_ALTALTAL', scope: 'extension' },          // gleiches Präfix, von Hand
    { id: 5, name: 'RepCheck (Chrome)', prefix: 'rkh_ANDERER_', scope: 'extension' },    // anderer Browser
  ];
  const storage = { rookhubConfig: { url: URL_RH, token: 'rkh_ALTALTALT_rest' }, rookhubPairing: laufenderVorgang() };
  const w = ladeWorker(storage, (url, init) => {
    if (init.method === 'POST') return angelegt(44, 'rkh_NEUNEUNEU_rest');
    if (init.method === 'GET') return { status: 200, body: liste };
    return { status: 204 };
  });
  await w.ctx.pairAttemptOnce();
  // Zwei Kandidaten (id 3 „RepCheck", id 4 von Hand) -> nur der von der Ein-Klick-Verbindung angelegte zählt.
  assert.deepStrictEqual(w.abrufe.map((a) => a.method + ' ' + a.url.replace(URL_RH, '')),
    ['POST /api/profile/tokens', 'GET /api/profile/tokens', 'DELETE /api/profile/tokens/3']);

  // Ohne eindeutigen Treffer wird nichts widerrufen.
  const storage2 = { rookhubConfig: { url: URL_RH, token: 'rkh_UNBEKANNT_rest' }, rookhubPairing: laufenderVorgang() };
  const w2 = ladeWorker(storage2, (url, init) => (init.method === 'POST' ? angelegt(45, 'rkh_NEUNEUNEU_rest')
    : init.method === 'GET' ? { status: 200, body: liste } : { status: 204 }));
  assert.strictEqual((await w2.ctx.pairAttemptOnce()).state, 'done');
  assert.ok(!w2.abrufe.some((a) => a.method === 'DELETE'), 'ohne Treffer darf kein Token fallen');
});

test('scheitert der Widerruf (Netz, 500), ist das Verbinden trotzdem erfolgreich', async () => {
  for (const antwort of [new Error('offline'), { status: 500 }]) {
    const storage = { rookhubConfig: { url: URL_RH, token: 'rkh_ALTALTALT_rest', tokenId: 7 }, rookhubPairing: laufenderVorgang() };
    const w = ladeWorker(storage, (url, init) => (init.method === 'POST' ? angelegt(46, 'rkh_NEUNEUNEU_rest') : antwort));
    const st = await w.ctx.pairAttemptOnce();
    assert.strictEqual(st.state, 'done');
    assert.deepStrictEqual(storage.rookhubConfig, { url: URL_RH, token: 'rkh_NEUNEUNEU_rest', tokenId: 46 });
  }
});

test('Token-Deckel: „Maximum of 20 tokens" wird zum Fehlercode, den Popup und Willkommensseite übersetzen', async () => {
  const storage = { rookhubConfig: { url: URL_RH, token: 'rkh_ALTALTALT_rest', tokenId: 7 }, rookhubPairing: laufenderVorgang() };
  const w = ladeWorker(storage, () => ({ status: 400, body: { message: 'Maximum of 20 tokens per user reached.' } }));
  const st = await w.ctx.pairAttemptOnce();
  assert.deepStrictEqual([st.state, st.error], ['error', 'tooManyTokens']);
  // Der alte Token bleibt dann gespeichert und gültig — kein Widerruf ohne Ersatz.
  assert.strictEqual(w.abrufe.length, 1);
  assert.deepStrictEqual(storage.rookhubConfig, { url: URL_RH, token: 'rkh_ALTALTALT_rest', tokenId: 7 });

  for (const datei of ['extension/popup.js', 'extension/welcome.js']) {
    assert.match(lies(datei), /st\.error === 'tooManyTokens'\) setConn(State)?\('popup\.conn\.errTooMany'\)/, datei);
  }
  for (const lang of Object.keys(RC_MESSAGES)) {
    for (const key of ['popup.conn.errTooMany', 'popup.conn.forgetLocalOnly']) {
      assert.ok(RC_MESSAGES[lang][key] && !/Maximum of/.test(RC_MESSAGES[lang][key]), lang + ': ' + key);
    }
  }
});

test('pairStart: der Token derselben Instanz bleibt samt Id bis zum Erfolg stehen', async () => {
  const storage = { rookhubConfig: { url: URL_RH + '/', token: 'rkh_ALTALTALT_rest', tokenId: 7 } };
  const w = ladeWorker(storage, () => ({ status: 500 }));
  w.ctx.chrome.tabs.query = async () => [{ id: 5 }];
  w.ctx.chrome.scripting.executeScript = async () => [{ result: null }];   // nicht angemeldet -> wartet
  await w.ctx.pairStart(URL_RH);
  assert.deepStrictEqual(storage.rookhubConfig, { url: URL_RH, token: 'rkh_ALTALTALT_rest', tokenId: 7 });
});

// ─── Popup: „Trennen" widerruft den Token in RookHub ─────────────────────────────
const POPUP = lies('extension/popup.js');

// Das Popup lädt lib/rookhub-client.js als klassisches Skript (self.RepCheckRookhub) — hier genauso, mit einem
// winzigen chrome, dessen Worker mit `antwort` antwortet (oder lastError setzt).
function ladeRevoke(antwort) {
  const gesendet = [];
  const chrome = {
    runtime: {
      id: 'repcheck-test',
      lastError: null,
      sendMessage: (msg, cb) => {
        gesendet.push(msg);
        if (antwort === 'lastError') { chrome.runtime.lastError = { message: 'no receiver' }; cb(undefined); chrome.runtime.lastError = null; return; }
        cb(antwort);
      },
    },
  };
  const selbst = { chrome };
  vm.runInNewContext(lies('extension/lib/rookhub-client.js'), { self: selbst });
  const run = new Function('self', 'chrome', 't',
    schnipsel(POPUP, 'async function revokeOwnToken(cfg) {', "document.getElementById('conn-forget')", 'extension/popup.js')
    + '\nreturn revokeOwnToken;')(selbst, chrome, (k) => k);
  return { run, gesendet };
}

const CFG = { url: URL_RH, token: 'rkh_x', tokenId: 9 };

test('Trennen: DELETE /api/extension/token/self mit dem eigenen Token; 204 und 401 heißen „gilt nicht mehr"', async () => {
  const ok = ladeRevoke({ ok: true, status: 204, body: null });
  assert.strictEqual(await ok.run(CFG), true);
  assert.deepStrictEqual([ok.gesendet[0].type, ok.gesendet[0].method, ok.gesendet[0].url, ok.gesendet[0].headers.Authorization],
    ['rookhub-fetch', 'DELETE', URL_RH + '/api/extension/token/self', 'Bearer rkh_x']);
  assert.strictEqual(ok.gesendet[0].body, undefined);
  assert.strictEqual(await ladeRevoke({ ok: false, status: 401, body: null }).run(CFG), true);
});

test('Trennen gegen ältere RookHub-Version (404) oder ohne Worker/Netz: nur lokal, der Nutzer erfährt es', async () => {
  assert.strictEqual(await ladeRevoke({ ok: false, status: 404, body: null }).run(CFG), false);
  assert.strictEqual(await ladeRevoke({ ok: false, status: 0, error: 'Failed to fetch' }).run(CFG), false);
  assert.strictEqual(await ladeRevoke('lastError').run(CFG), false);
  const ohneToken = ladeRevoke({ ok: true, status: 204 });
  assert.strictEqual(await ohneToken.run({ url: URL_RH }), true);
  assert.strictEqual(ohneToken.gesendet.length, 0, 'ohne Token gibt es nichts zu widerrufen');

  // Verdrahtung: erst widerrufen (solange die Config die Origin noch freigibt), dann lokal löschen.
  const handler = schnipsel(POPUP, "document.getElementById('conn-forget')", '\n});', 'extension/popup.js');
  assert.ok(handler.indexOf('revokeOwnToken(') >= 0 && handler.indexOf('revokeOwnToken(') < handler.indexOf('writeRookhubConfig('));
  assert.match(handler, /'popup\.conn\.forgetLocalOnly'/);
  assert.match(lies('extension/popup.html'), /<script src="lib\/rookhub-client\.js"><\/script>\s*<script src="popup\.js">/);
});
