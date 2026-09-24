'use strict';

// chess.com: die schwebenden Knoepfe (v1.64.0) erscheinen auf JEDER Partieseite, sobald die
// Partieanalyse angeboten wird. Gemeldet am 23.09.2026 fuer /game/<id>: dort traf keine der beiden
// Pfad-Regeln, obwohl Zugliste (`wc-simple-move-list.move-list` mit `.node`-Zuegen) und
// Analyse-Knopf (`<a href="/analysis/game/live/<id>?tab=review">`) da sind.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const content = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');
const adapter = content.slice(content.indexOf('const ADAPTERS = {'), content.indexOf('lichess: {'));
// Nur die Seitenerkennung — `extractSan` daneben liest die Zuege und darf textContent benutzen.
const istReviewSeite = adapter.slice(adapter.indexOf('isReviewPage:'), adapter.indexOf('getMoveListEl:'));

test('der Analyse-Knopf wird am ZIEL erkannt, nicht an seiner Beschriftung', () => {
  assert.match(istReviewSeite, /a\[href\*="\/analysis\/game\/"\]/);
  // Beschriftungen sind uebersetzt — „Partieanalyse" / „Game Review" duerfen nicht die Bedingung sein.
  assert.doesNotMatch(istReviewSeite, /Partieanalyse|Game Review|textContent|innerText/);
});

test('ohne Zuege keine Knoepfe: die Partien-Liste verlinkt in jeder Zeile auf die Analyse', () => {
  assert.match(istReviewSeite, /chessComMoveList\(\)/);
  assert.match(istReviewSeite, /liste\.querySelector\('\.node'\)/);
});

test('die bisherigen Pfad-Regeln gelten weiter', () => {
  assert.match(istReviewSeite, /\/analysis\/game\//);
  assert.match(istReviewSeite, /\/game\/review\//);
});

test('die Zugliste kennt die neue wc-simple-move-list (traegt die Klasse move-list)', () => {
  assert.match(content, /function chessComMoveList\(\)/);
  assert.match(content, /'\.move-list, vertical-move-list, wc-move-list'/);
});

test('ein sparsamer Takt bewertet neu, wenn der Knopf erst nach Partieende erscheint', () => {
  // <title> und Adresse aendern sich dabei nicht — die beiden bisherigen Beobachter feuern nicht.
  assert.match(content, /const REVIEW_POLL_MS = 2000;/);
  assert.match(content, /setInterval\(refreshFloatingButton, REVIEW_POLL_MS\)/);
});

test('„Partie speichern" bricht nicht mehr stumm ab, wenn keine Zuege im DOM stehen', () => {
  // Gemeldet 2026-09-24 auf /analysis/game/live/<id>/review: Knoepfe da, Klick tat gar nichts —
  // dort rendert chess.com keine Zugliste (Schnappschuss: 0 .node-Knoten).
  assert.doesNotMatch(content, /if \(!domMoves\.length\) return;/);
  const save = content.slice(content.indexOf("btn.id = 'repcheck-save-game'"), content.indexOf('function removeFloatingControls'));
  assert.match(save, /tools\.saveNoMoves/);
  // Die DOM-Auslese erst NACH getGameMeta: eine kanonische Zugliste (lichess-Export) zaehlt zuerst.
  assert.ok(save.indexOf('await getGameMeta()') < save.indexOf('getGameMoves()'));
});
