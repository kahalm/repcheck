// Gemeinsamer RookHub-Client der Extension (S1-009): EINE Stelle für Standard-Adresse, Adress-Normalisierung,
// Config-Lesen, Bearer-/JSON-Kopfzeilen und die Fehlerabbildung einer RookHub-Antwort — vor allem 401 → „Token
// ungültig oder abgelaufen" statt eines nackten „HTTP 401". Der eigentliche fetch läuft weiter im Background-Worker
// (`rookhub-fetch`: CORS-frei, Egress-Allowlist); hier wird nur die Nachricht gebaut und die Antwort ausgewertet.
//
// Stand: die drei Import-Pfade in chessable-activity.js (ingest, ingest/chunk, ingest/live) laufen hierüber. Die
// übrigen Aufrufer (Best-effort-Pfade in chessable-activity.js, rookhubProxy in content.js, popup.js bis auf „Trennen") folgen mit
// der Zerlegung von chessable-activity.js/content.js; die Standard-Adresse hält test/rookhub-client.test.js in
// allen Dateien gleich.

(function (root) {
  'use strict';

  // Voreingestellte Instanz (token-lose getReview-Linien, Vorbelegung beim Verbinden). Steht zusätzlich in
  // background.js (Egress-Allowlist), popup.js, welcome.js und chessable-activity.js — der Test hält alle gleich.
  const DEFAULT_URL = 'https://rookhub.oberschmid.homes';

  function baseUrl(url) { return String(url || '').replace(/\/$/, ''); }

  // Wurde die Erweiterung aktualisiert oder neu geladen, waehrend das Content-Script lief, ist es abgehaengt:
  // `chrome.runtime.id` fehlt, und jeder Zugriff auf Speicher oder Worker wirft „Extension context invalidated".
  // Vorher wurde daraus „Nicht mit RookHub verbunden" (gemeldet 07.10.2026 mitten in „Kurs holen") — die
  // Verbindung war aber in Ordnung, nur die Seite musste neu geladen werden.
  function contextInvalidated(c, error) {
    try { if (!c || !c.runtime || !c.runtime.id) return true; } catch (e) { return true; }
    return /context invalidated/i.test(String((error && error.message) || error || ''));
  }
  function isConnected(cfg) { return !!(cfg && cfg.url && cfg.token); }

  // Die Config liegt extension-weit in chrome.storage.local (`rookhubConfig`, geschrieben von Popup und Worker).
  function readConfig(chromeApi) {
    const c = chromeApi || root.chrome;
    return new Promise((resolve) => {
      try {
        c.storage.local.get('rookhubConfig', (r) => resolve((r && r.rookhubConfig) || null));
      } catch (e) { resolve(null); }
    });
  }

  // Die Nachricht an den Worker. Mit `body` wird er als JSON geschickt (Standard-Methode dann POST).
  function buildMessage(cfg, path, opts) {
    const o = opts || {};
    const hasBody = o.body !== undefined;
    const headers = { 'Authorization': 'Bearer ' + cfg.token };
    if (hasBody) headers['Content-Type'] = 'application/json';
    headers['Accept'] = 'application/json';
    const msg = { type: 'rookhub-fetch', url: baseUrl(cfg.url) + path, method: o.method || (hasBody ? 'POST' : 'GET'), headers };
    if (hasBody) msg.body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    msg.expect = o.expect || 'json';
    return msg;
  }

  // Fehler aus einer Worker-Antwort ({ ok, status, body, error } oder nichts). 401 heißt immer: Token ungültig oder
  // widerrufen — der Nutzer muss neu verbinden; RookHub schreibt dazu keinen Text, also nie „HTTP 401" zeigen.
  function responseError(resp, t) {
    const tr = typeof t === 'function' ? t : (k) => k;
    const status = (resp && resp.status) || 0;
    let message;
    if (!resp) message = tr('err.noBackground');
    else if (status === 401) message = tr('err.tokenInvalid');
    else message = (resp.body && typeof resp.body.message === 'string' && resp.body.message) || resp.error || tr('err.http', { status });
    const err = new Error(message);
    err.status = status;
    err.tokenInvalid = status === 401;
    return err;
  }

  // Client mit der Übersetzung des Aufrufers (jede Oberfläche hat ihre eigene Sprachwahl).
  function create(options) {
    const o = options || {};
    const t = typeof o.t === 'function' ? o.t : (k) => k;
    const chromeApi = () => o.chrome || root.chrome;

    function send(msg) {
      return new Promise((resolve, reject) => {
        const c = chromeApi();
        try {
          c.runtime.sendMessage(msg, (resp) => {
            if (c.runtime.lastError) { reject(new Error(c.runtime.lastError.message || 'runtime error')); return; }
            resolve(resp);
          });
        } catch (e) { reject(e); }
      });
    }

    // Wirft bei fehlender Verbindung (`notConnected`), Laufzeitfehler und HTTP-Fehler (`status`, `tokenInvalid`);
    // liefert sonst den Antwortrumpf.
    function reloadError() {
      const err = new Error(t('err.extensionReloaded'));
      err.contextInvalidated = true;
      return err;
    }

    async function request(path, opts) {
      const ro = opts || {};
      if (contextInvalidated(chromeApi())) throw reloadError();
      const cfg = ro.cfg || await readConfig(chromeApi());
      if (!cfg && contextInvalidated(chromeApi())) throw reloadError();
      if (!isConnected(cfg)) {
        const err = new Error(t('err.notConnected'));
        err.notConnected = true;
        throw err;
      }
      let resp;
      try { resp = await send(buildMessage(cfg, path, ro)); }
      catch (e) { if (contextInvalidated(chromeApi(), e)) throw reloadError(); throw e; }
      if (!resp || !resp.ok) throw responseError(resp, t);
      return resp.body;
    }

    return { request, send, readConfig: () => readConfig(chromeApi()) };
  }

  const api = { DEFAULT_URL, baseUrl, contextInvalidated, isConnected, readConfig, buildMessage, responseError, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RepCheckRookhub = api;
})(typeof self !== 'undefined' ? self : this);
