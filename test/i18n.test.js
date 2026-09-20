'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  RC_LANGS, RC_FALLBACK, RC_MESSAGES, rcNormalizeLang, rcResolveLang, rcTranslate,
} = require('../extension/lib/i18n.js');

// Platzhalter einer Vorlage einsammeln — Plural-Objekte über alle Varianten hinweg.
function platzhalter(eintrag) {
  const texte = typeof eintrag === 'string' ? [eintrag] : Object.values(eintrag || {});
  const out = new Set();
  for (const t of texte) {
    for (const m of String(t).matchAll(/\{(\w+)\}/g)) out.add(m[1]);
  }
  return [...out].sort();
}

test('jede Sprache kennt jeden Schlüssel der Rückfallsprache', () => {
  const keys = Object.keys(RC_MESSAGES[RC_FALLBACK]);
  assert.ok(keys.length > 80, `zu wenige Schlüssel: ${keys.length}`);
  for (const lang of RC_LANGS) {
    const fehlend = keys.filter((k) => !(k in RC_MESSAGES[lang]));
    assert.deepStrictEqual(fehlend, [], `${lang} fehlen Schlüssel: ${fehlend.join(', ')}`);
  }
});

test('keine Sprache hat Schlüssel, die die Rückfallsprache nicht kennt', () => {
  const bekannt = new Set(Object.keys(RC_MESSAGES[RC_FALLBACK]));
  for (const lang of RC_LANGS) {
    const zuviel = Object.keys(RC_MESSAGES[lang]).filter((k) => !bekannt.has(k));
    assert.deepStrictEqual(zuviel, [], `${lang} hat unbekannte Schlüssel: ${zuviel.join(', ')}`);
  }
});

// Ein vergessener Platzhalter fällt sonst erst auf, wenn die Zahl im Text fehlt — und dann nur
// in der einen Sprache, die kaum jemand gegenliest.
test('Platzhalter sind über alle Sprachen identisch', () => {
  for (const [key, eintrag] of Object.entries(RC_MESSAGES[RC_FALLBACK])) {
    const erwartet = platzhalter(eintrag);
    for (const lang of RC_LANGS) {
      assert.deepStrictEqual(platzhalter(RC_MESSAGES[lang][key]), erwartet,
        `${lang}/${key}: Platzhalter weichen ab`);
    }
  }
});

test('Plural-Einträge sind in allen Sprachen Plural-Einträge', () => {
  for (const [key, eintrag] of Object.entries(RC_MESSAGES[RC_FALLBACK])) {
    const istPlural = typeof eintrag === 'object';
    for (const lang of RC_LANGS) {
      assert.strictEqual(typeof RC_MESSAGES[lang][key] === 'object', istPlural,
        `${lang}/${key}: Plural-Struktur weicht ab`);
      if (istPlural) {
        assert.ok(RC_MESSAGES[lang][key].other, `${lang}/${key}: „other“ fehlt`);
      }
    }
  }
});

// Kroatisch flektiert bei 2–4 anders als ab 5. Ohne die few-Form stünde dort die 5+-Form,
// also „2 linija“ statt „2 linije“.
test('kroatische Plural-Einträge haben die few-Form', () => {
  for (const [key, eintrag] of Object.entries(RC_MESSAGES[RC_FALLBACK])) {
    if (typeof eintrag !== 'object') continue;
    assert.ok(RC_MESSAGES.hr[key].few, `hr/${key}: „few“ fehlt (2–4)`);
  }
});

test('rcTranslate setzt Platzhalter ein', () => {
  assert.strictEqual(rcTranslate('de', 'popup.error', { error: 'Zeitüberschreitung' }),
    'Fehler: Zeitüberschreitung');
  assert.strictEqual(rcTranslate('en', 'import.onRookhub', { done: 3, total: 10, pct: 30 }),
    'On RookHub: 3/10 lines (30%)');
});

test('rcTranslate wählt die Plural-Form nach Sprache', () => {
  assert.strictEqual(rcTranslate('de', 'panel.loadedFiles', { count: 1 }), 'Repertoire geladen: 1 Datei');
  assert.strictEqual(rcTranslate('de', 'panel.loadedFiles', { count: 4 }), 'Repertoire geladen: 4 Dateien');
  // Kroatisch: 1 → one, 3 → few, 7 → other. Die drei müssen sich unterscheiden.
  const hr1 = rcTranslate('hr', 'panel.loadedFiles', { count: 1 });
  const hr3 = rcTranslate('hr', 'panel.loadedFiles', { count: 3 });
  const hr7 = rcTranslate('hr', 'panel.loadedFiles', { count: 7 });
  assert.notStrictEqual(hr1, hr3, 'hr: one und few sind gleich');
  assert.notStrictEqual(hr3, hr7, 'hr: few und other sind gleich');
});

test('unbekannter Schlüssel gibt den Schlüssel zurück (sichtbar kaputt statt leer)', () => {
  assert.strictEqual(rcTranslate('de', 'gibt.es.nicht'), 'gibt.es.nicht');
});

test('fehlender Platzhalter bleibt wörtlich stehen', () => {
  assert.strictEqual(rcTranslate('de', 'popup.error', {}), 'Fehler: {error}');
  assert.strictEqual(rcTranslate('de', 'popup.error', { error: null }), 'Fehler: {error}');
});

test('unbekannte Sprache fällt auf Englisch zurück', () => {
  assert.strictEqual(rcTranslate('fr', 'panel.close'), RC_MESSAGES.en['panel.close']);
});

test('rcNormalizeLang kürzt Regionen und filtert Unbekanntes', () => {
  assert.strictEqual(rcNormalizeLang('de-AT'), 'de');
  assert.strictEqual(rcNormalizeLang('HR'), 'hr');
  assert.strictEqual(rcNormalizeLang('fr-CA'), 'en');
  assert.strictEqual(rcNormalizeLang(null), 'en');
});

test('rcResolveLang: Nutzerwahl schlägt Browsersprache', () => {
  assert.strictEqual(rcResolveLang('hr', ['de-DE', 'de']), 'hr');
  assert.strictEqual(rcResolveLang(null, ['de-DE', 'de']), 'de');
  assert.strictEqual(rcResolveLang('', ['fr-FR', 'hr']), 'hr');   // erste unterstützte gewinnt
  assert.strictEqual(rcResolveLang(null, []), 'en');
  assert.strictEqual(rcResolveLang('klingonisch', ['de']), 'de'); // ungültige Wahl wird ignoriert
});

