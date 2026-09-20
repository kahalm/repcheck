// Geteilte Auswertung von Chessables Zug-Rückmeldung.
//
// Logik NUR hier ändern — es gibt keine zweite Fassung mehr.
//
// Warum geteilt: die Zuordnung Icon-Klasse → Zustand brauchen ZWEI Stellen —
// chessable-fen.js (Farbe der XP-Plakette, MAIN-World) und chessable-activity.js (Genauigkeit
// je Linie, isolierte Welt). Genau solche Mehrfach-Kopien hat der Codereview 2026-08-07 als
// Drift-Risiko benannt.
//
// Bewusst über die ICON-KLASSE statt über den Text: „Overstudied“, „Incorrect“ usw. heißen in
// jeder Chessable-Kontosprache anders, die Klassennamen nicht.

const RC_FEEDBACK_KINDS = ['correct', 'wrong', 'alt', 'giveup', 'timeup'];

/** Zustand aus einer Icon-Klassenliste; null, wenn keine bekannte Klasse dabei ist. */
function rcFeedbackKindFromClass(cls) {
  const s = String(cls || '');
  if (s.includes('icon--correct')) return 'correct';
  if (s.includes('icon--wrong')) return 'wrong';
  if (s.includes('icon--alt')) return 'alt';
  if (s.includes('icon--give-up')) return 'giveup';
  if (s.includes('icon--time-up')) return 'timeup';
  return null;
}

/**
 * Zählt der Zustand als Fehler für die Genauigkeit einer Linie?
 *
 * `alt` ist KEIN Fehler: ein alternativer Zug ist eine von Chessable akzeptierte Lösung, sie
 * wird nur nicht als Hauptzug gewertet. `giveup`/`timeup` sind Fehler — wer aufgibt oder in die
 * Zeit läuft, konnte die Linie nicht. Ein unbekannter Zustand (null) zählt NICHT als Fehler,
 * damit eine Chessable-Änderung die Quote nicht still nach unten zieht.
 */
function rcFeedbackIsFehler(kind) {
  return kind === 'wrong' || kind === 'giveup' || kind === 'timeup';
}

// Node/CommonJS-Export (Tests) + Browser-Global (Content-Scripts in BEIDEN Welten). Im
// Früher stand der Kern im Userscript direkt im IIFE-Scope, dort griff keiner der beiden Zweige.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RC_FEEDBACK_KINDS, rcFeedbackKindFromClass, rcFeedbackIsFehler };
}
if (typeof self !== 'undefined') {
  self.RepCheckFeedback = { KINDS: RC_FEEDBACK_KINDS, kindFromClass: rcFeedbackKindFromClass, isFehler: rcFeedbackIsFehler };
}
