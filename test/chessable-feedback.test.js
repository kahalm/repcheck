'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { RC_FEEDBACK_KINDS, rcFeedbackKindFromClass, rcFeedbackIsFehler } =
  require('../extension/lib/chessable-feedback.js');

// Echte Klassenlisten, wie sie im Chessable-DOM stehen (Inspector-Dumps vom 08.08.).
test('kindFromClass erkennt die Zustände an der Icon-Klasse', () => {
  assert.strictEqual(rcFeedbackKindFromClass('icon icon--correct fas fa-check'), 'correct');
  assert.strictEqual(rcFeedbackKindFromClass('icon icon--wrong fas fa-xmark'), 'wrong');
  assert.strictEqual(rcFeedbackKindFromClass('icon icon--alt fas fa-arrows-split-up-and-left'), 'alt');
  assert.strictEqual(rcFeedbackKindFromClass('icon icon--give-up fas fa-flag'), 'giveup');
  assert.strictEqual(rcFeedbackKindFromClass('icon icon--time-up fas fa-clock'), 'timeup');
});

test('unbekannte oder leere Klassen ergeben null', () => {
  assert.strictEqual(rcFeedbackKindFromClass('icon icon--brandneu'), null);
  assert.strictEqual(rcFeedbackKindFromClass(''), null);
  assert.strictEqual(rcFeedbackKindFromClass(null), null);
  assert.strictEqual(rcFeedbackKindFromClass(undefined), null);
});

// Ein alternativer Zug ist eine von Chessable AKZEPTIERTE Lösung — er darf die Quote nicht
// drücken. Aufgeben und Zeitablauf dagegen schon.
test('isFehler: alt ist kein Fehler, giveup und timeup schon', () => {
  assert.strictEqual(rcFeedbackIsFehler('wrong'), true);
  assert.strictEqual(rcFeedbackIsFehler('giveup'), true);
  assert.strictEqual(rcFeedbackIsFehler('timeup'), true);
  assert.strictEqual(rcFeedbackIsFehler('correct'), false);
  assert.strictEqual(rcFeedbackIsFehler('alt'), false);
});

// Ein unbekannter Zustand darf die Genauigkeit NICHT still nach unten ziehen: benennt
// Chessable seine Icons um, wäre sonst plötzlich jede Linie „falsch".
test('unbekannter Zustand gilt nicht als Fehler', () => {
  assert.strictEqual(rcFeedbackIsFehler(null), false);
  assert.strictEqual(rcFeedbackIsFehler('irgendwas'), false);
});

test('KINDS listet genau die erkannten Zustände', () => {
  assert.deepStrictEqual(RC_FEEDBACK_KINDS, ['correct', 'wrong', 'alt', 'giveup', 'timeup']);
});

// Drift-Guard wie bei den übrigen geteilten Modulen: die Laufzeit-Dateien müssen die Lib
// BENUTZEN und dürfen die Zuordnung nicht noch einmal selbst hinschreiben.
test('die Laufzeit-Dateien haben keine eigene Klassen-Zuordnung mehr', () => {
  const wurzel = path.join(__dirname, '..');
  for (const rel of ['extension/chessable-fen.js', 'extension/chessable-activity.js']) {
    const src = fs.readFileSync(path.join(wurzel, rel), 'utf8');
    assert.ok(!src.includes("includes('icon--correct')"),
      `${rel} enthält wieder eine eigene Icon-Zuordnung — lib/chessable-feedback.js benutzen`);
  }
});
