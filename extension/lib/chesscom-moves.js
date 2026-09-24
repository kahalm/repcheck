// chess.com liefert die Zugliste einer Partie in der eigenen Antwort mit — als TCN, zwei Zeichen je
// Halbzug (`GET /callback/{live|daily}/game/{id}` → `game.moveList`). RepCheck liest die Zuege sonst
// aus der Zugliste im DOM; auf der Analyseseite (Review-Tab) steht dort aber keine (gemeldet
// 2026-09-24, Schnappschuss: 0 Zugknoten), und „Partie speichern" hatte nichts zu speichern.
//
// TCN: ein Feld ist eine Zahl 0..63 (0 = a1, 63 = h8), kodiert ueber das Alphabet unten. Ist das ZWEITE
// Zeichen groesser als 63, ist es eine Umwandlung: die Figur steht in `qnrbkp`, das Zielfeld ergibt sich
// aus dem Startfeld (eine Reihe vor/zurueck, eine Spalte links/geradeaus/rechts).

(function (root) {
  'use strict';

  const TCN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=';
  const PIECES = 'qnrbkp';

  function feld(i) { return TCN_ALPHABET[i % 8] + (Math.floor(i / 8) + 1); }

  /**
   * TCN → Zuege als `{ from, to, promotion? }`. Leeres Array, sobald etwas nicht stimmt (unbekanntes
   * Zeichen, ungerade Laenge, Einsetzzug aus Crazyhouse) — eine halb gelesene Partie waere schlimmer
   * als keine, denn sie liefe unbemerkt in den Import.
   */
  function decodeTcn(text) {
    const s = String(text == null ? '' : text);
    if (!s || s.length % 2 !== 0) return [];
    const out = [];
    for (let i = 0; i < s.length; i += 2) {
      const von = TCN_ALPHABET.indexOf(s[i]);
      let nach = TCN_ALPHABET.indexOf(s[i + 1]);
      if (von < 0 || nach < 0) return [];
      const zug = {};
      if (nach > 63) {
        zug.promotion = PIECES[Math.floor((nach - 64) / 3)];
        nach = von + (von < 16 ? -8 : 8) + ((nach - 64) % 3) - 1;
      }
      if (von > 75) return [];              // Einsetzzug (Crazyhouse) — nicht unsere Partieart
      if (nach < 0 || nach > 63) return [];
      zug.from = feld(von);
      zug.to = feld(nach);
      out.push(zug);
    }
    return out;
  }

  /**
   * TCN → SAN-Liste. Die Zuege werden auf einem Brett nachgespielt (chess.js wird hereingereicht: im
   * Content-Script das globale `Chess`, im Test das Modul) — nur so wird aus von/nach die Notation, die
   * RookHub erwartet. Geht ein Zug nicht, ist die Liste unbrauchbar und es kommt eine leere zurueck.
   */
  function sansFromTcn(text, ChessCtor) {
    const zuege = decodeTcn(text);
    if (!zuege.length || typeof ChessCtor !== 'function') return [];
    const brett = new ChessCtor();
    const sans = [];
    for (const z of zuege) {
      let gespielt = null;
      try { gespielt = brett.move({ from: z.from, to: z.to, promotion: z.promotion || 'q' }); }
      catch (e) { gespielt = null; }
      if (!gespielt) return [];
      sans.push(gespielt.san);
    }
    return sans;
  }

  const api = { decodeTcn, sansFromTcn, TCN_ALPHABET };
  // Node/CommonJS-Export
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RepCheckChessCom = api;
})(typeof self !== 'undefined' ? self : this);
