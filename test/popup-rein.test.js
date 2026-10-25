'use strict';

// Charakterisierung reiner Popup-Helfer VOR der Zerlegung Z39: verstrichene Zeit im Import-Status, Sekundenfelder
// der Kurs-holen-Pause (Komma, leer), Sekunden-Anzeige in der Popup-Sprache. Per Anker geschnitten
// (test/helpers/quelle.js sucht in allen Laufzeitdateien) — nach dem Umzug dieselben Funktionen am neuen Ort.

const test = require('node:test');
const assert = require('node:assert');
const { finde } = require('./helpers/quelle.js');

test('ciElapsedLabel: m:ss seit dem Start, nie negativ', () => {
  const jetzt = 1_000_000;
  const fn = new Function('Date', finde('function ciElapsedLabel(ms) {', 'function paintCiStatus() {') + '\nreturn ciElapsedLabel;')(
    { now: () => jetzt });
  assert.strictEqual(fn(jetzt), '0:00');
  assert.strictEqual(fn(jetzt - 83_400), '1:23');
  assert.strictEqual(fn(jetzt - 3_605_000), '60:05');
  assert.strictEqual(fn(jetzt + 5_000), '0:00');
});

test('readSekundenFeld: Komma oder Punkt, ganze Millisekunden, Unsinn → NaN', () => {
  const fn = new Function(finde('function readSekundenFeld(el) {', 'function saveCrawlDelay() {') + '\nreturn readSekundenFeld;')();
  assert.strictEqual(fn({ value: '2,5' }), 2500);
  assert.strictEqual(fn({ value: '3.1234' }), 3123);
  assert.ok(Number.isNaN(fn({ value: '' })));
  assert.ok(Number.isNaN(fn({ value: 'bald' })));
});

test('crawlSekunden: Zahl in der Popup-Sprache, hoechstens zwei Nachkommastellen', () => {
  const src = finde('function crawlSekunden(ms) {', 'function paintCrawlSettings() {');
  const mit = (rcLang) => new Function('rcLang', src + '\nreturn crawlSekunden;')(rcLang);
  assert.strictEqual(mit('de')(2500), '2,5');
  assert.strictEqual(mit('en')(3333), '3.33');
  assert.strictEqual(mit('de')(120000), '120');
});
