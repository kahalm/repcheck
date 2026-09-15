'use strict';

// Unerwartete Chessable-Antworten (v1.60.0): „Kurs holen" stoppt, sobald eine Antwort nicht die erwartete Form hat —
// dahinter kann eine Anti-Crawling-Maßnahme stecken. Anlass: {"error":{"message":"User is banned or deleted"}} lag
// seit dem 30.06.2026 für 31 Linien als „gecacht" im geteilten Linien-Cache.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { checkChessableResponse, looksBanned, scrubSnippet, UNEXPECTED_SNIPPET_CHARS } =
  require('../extension/lib/chessable-crawl.js');

const ROOT = path.join(__dirname, '..');
const activity = fs.readFileSync(path.join(ROOT, 'extension', 'chessable-activity.js'), 'utf8');
const popup = fs.readFileSync(path.join(ROOT, 'extension', 'popup.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(ROOT, 'extension', 'popup.html'), 'utf8');

test('gültige Antworten gehen durch', () => {
  assert.equal(checkChessableResponse('course', JSON.stringify({ course: { data: [{ id: 1 }] } })), null);
  assert.equal(checkChessableResponse('course', JSON.stringify({ Course: { Data: [] } })), null);
  assert.equal(checkChessableResponse('list', JSON.stringify({ list: { data: [] } })), null);
  assert.equal(checkChessableResponse('game', JSON.stringify({ game: { moves: [] } })), null);
  // Das erwartete Feld ist da → ein daneben stehendes error-Feld stoppt nichts.
  assert.equal(checkChessableResponse('game', JSON.stringify({ game: {}, error: 'x' })), null);
});

test('die Sperr-Antwort vom 30.06. stoppt und gilt als Sperre', () => {
  const r = checkChessableResponse('game', '{"error":{"message":"User is banned or deleted"}}');
  assert.deepEqual([r.reason, r.status, r.message, r.banned], ['error', 200, 'User is banned or deleted', true]);
});

test('leeres {} und falsche Form stoppen ohne Sperr-Verdacht', () => {
  for (const [kind, text] of [['game', '{}'], ['list', '{"list":{}}'], ['course', '{"course":null}'], ['game', '[]'], ['game', '"x"']]) {
    const r = checkChessableResponse(kind, text);
    assert.equal(r.reason, 'shape', `${kind} ${text}`);
    assert.equal(r.banned, false, `${kind} ${text}`);
  }
});

test('kein JSON: eine Sperrseite gilt als Sperre, abgeschnittenes JSON nicht', () => {
  const block = checkChessableResponse('game',
    '<html><title>Attention Required! | Cloudflare</title><h1>Sorry, you have been blocked</h1></html>');
  assert.deepEqual([block.reason, block.banned], ['json', true]);
  const kaputt = checkChessableResponse('game', '{"game":{"moves":[1,2');   // abgeschnitten wie oid 36114125
  assert.deepEqual([kaputt.reason, kaputt.banned], ['json', false]);
});

test('HTTP-Fehler: Status und Meldung aus dem Rumpf', () => {
  const r = checkChessableResponse('list', '{"error":{"message":"Account suspended"}}', 403);
  assert.deepEqual([r.reason, r.status, r.message, r.banned], ['http', 403, 'Account suspended', true]);
  const leer = checkChessableResponse('game', '', 503);
  assert.deepEqual([leer.reason, leer.status, leer.message, leer.banned], ['http', 503, null, false]);
});

test('Sperr-Regel wie in RookHub: Fehlermeldung zählt allein, JSON-Inhalt ist nie eine Sperre', () => {
  assert.equal(looksBanned(null, '{"list":{"name":"Deleted lines"}}'), false);
  assert.equal(looksBanned('Course not found', 'Sorry, you have been blocked'), false);
  assert.equal(looksBanned(null, '<p>blockedMoves</p>'), false);
  assert.equal(looksBanned('   ', 'Your account was suspended'), true);
  assert.equal(looksBanned(null, ''), false);
});

test('Ausschnitt: gekürzt, ohne E-Mail- und IP-Adressen, Uhrzeiten bleiben', () => {
  const s = scrubSnippet('Your IP: 203.0.113.7 / 2a02:8388:1:2::1 — mail felix@example.com at 08:56:57 ' + 'x'.repeat(5000));
  assert.ok(!s.includes('203.0.113.7'));
  assert.ok(!s.includes('2a02:8388'));
  assert.ok(!s.includes('felix@example.com'));
  assert.ok(s.includes('08:56:57'));
  assert.ok(s.includes('[ip]') && s.includes('[email]'));
  assert.equal(s.length, UNEXPECTED_SNIPPET_CHARS);
  assert.equal(checkChessableResponse('game', 'y'.repeat(9000)).snippet.length, UNEXPECTED_SNIPPET_CHARS);
});

test('Kurs holen prüft getCourse, getList und getGame', () => {
  const crawl = activity.slice(activity.indexOf('async function crawlAndImport('), activity.indexOf('// V1: nur den passiven Mitschnitt'));
  assert.match(crawl, /chessableGetChecked\(`getCourse\?bid=\$\{bid\}`, 'course'\)/);
  assert.match(crawl, /chessableGetChecked\(`getList\?bid=\$\{bid\}&lid=\$\{lid\}`, 'list'/);
  assert.match(crawl, /chessableGetChecked\(`getGame\?lng=en&oid=\$\{oid\}`, 'game'/);
  assert.doesNotMatch(crawl, /await chessableGet\(/);
  assert.match(crawl, /handleUnexpected\(/);
});

test('Stopp: Warnung mit Discord-Link, Hinweis fürs Popup, Meldung an RookHub; 401 bleibt der bekannte Fehler', () => {
  assert.match(activity, /const DISCORD_URL = 'https:\/\/discord\.gg\/wczc4BJtMf'/);
  assert.match(activity, /rcCrawlAlert/);
  assert.match(activity, /\/api\/extension\/chessable\/unexpected-response/);
  assert.match(activity, /e\.chessableStatus === 401\) throw e/);
});

test('Popup zeigt den Hinweis und fragt vor dem nächsten Holen nach', () => {
  assert.match(popupHtml, /id="ci-alert"/);
  assert.match(popup, /rcCrawlAlert/);
  const klick = popup.slice(popup.indexOf("CI_CRAWL.addEventListener('click'"));
  const frage = klick.indexOf('import.unexpected.rerunConfirm');
  assert.ok(frage > 0 && frage < klick.indexOf("ciSend('crawl'"));
});
