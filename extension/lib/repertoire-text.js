// RepCheck — reine (DOM-/Browser-freie) Text-/PGN-/FEN-Helfer.
//
// SHARED CORE (seit v1.20.0): die Extension lädt dieses Modul als eigenes
// Content-Script (Manifest content_scripts + Popup-executeScript, VOR content.js)
// und konsumiert die Helfer über `self.RepCheckLib` — `content.js` hält KEINE
// eigenen Kopien mehr. Node-Tests: ../test/repertoire-text.test.js.
// HINWEIS: der Userscript (repcheck.user.js) hält vorerst noch eine Inline-Kopie
// dieser Logik; die Zusammenführung über einen Build-Schritt (eine Quelle → beide
// Distributionen) ist der nächste Schritt. Bis dahin: Änderungen hier + im
// Userscript angleichen.

function tokenizePgn(movetext) {
  // Remove comments { ... } and ; line comments
  movetext = movetext.replace(/\{[^}]*\}/g, ' ');
  movetext = movetext.replace(/;[^\n]*/g, ' ');
  // Remove NAGs like $1, $2
  movetext = movetext.replace(/\$\d+/g, ' ');
  // Normalize whitespace
  movetext = movetext.replace(/\s+/g, ' ').trim();

  const tokens = [];
  let i = 0;
  while (i < movetext.length) {
    const ch = movetext[i];
    if (ch === '(') { tokens.push('('); i++; }
    else if (ch === ')') { tokens.push(')'); i++; }
    else if (ch === ' ') { i++; }
    else {
      let j = i;
      while (j < movetext.length && movetext[j] !== ' ' && movetext[j] !== '(' && movetext[j] !== ')') j++;
      tokens.push(movetext.substring(i, j));
      i = j;
    }
  }
  return tokens;
}

function isMoveToken(token) {
  if (!token || token === '(' || token === ')') return false;
  // Skip move numbers: "1.", "1...", "12."
  if (/^\d+\.+$/.test(token)) return false;
  // Skip results
  if (['1-0', '0-1', '1/2-1/2', '*'].includes(token)) return false;
  // A move token starts with a letter (a-h for pawns, KQRBN for pieces) or O for castling
  return /^[a-hKQRBNO]/.test(token);
}

function parseMoveTokens(tokens, pos) {
  // Returns { moves: [...], endPos }
  // Each move: { san, variations: [] }
  const moves = [];
  while (pos < tokens.length) {
    const token = tokens[pos];
    if (token === ')') {
      // End of variation
      return { moves, endPos: pos };
    }
    if (token === '(') {
      // Start of variation — applies to the LAST move's position
      pos++; // skip '('
      const result = parseMoveTokens(tokens, pos);
      pos = result.endPos + 1; // skip ')'
      // Attach variation to the last move before this variation
      if (moves.length > 0) {
        moves[moves.length - 1].variations.push(result.moves);
      }
      continue;
    }
    if (isMoveToken(token)) {
      moves.push({ san: token, variations: [] });
    }
    pos++;
  }
  return { moves, endPos: pos };
}

function parsePgnText(text) {
  // Split into games by header blocks
  const games = [];
  // Split on lines starting with [Event or just parse as one big block
  const sections = text.split(/(?=\[Event\s)/);
  for (const section of sections) {
    // Extract movetext (everything after the last header line "]")
    const lines = section.split('\n');
    let movetextLines = [];
    let pastHeaders = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        pastHeaders = false;
        continue;
      }
      if (trimmed === '' && !pastHeaders) {
        pastHeaders = true;
        continue;
      }
      if (pastHeaders || !trimmed.startsWith('[')) {
        movetextLines.push(trimmed);
        pastHeaders = true;
      }
    }
    const movetext = movetextLines.join(' ').trim();
    if (!movetext) continue;

    const tokens = tokenizePgn(movetext);
    const { moves } = parseMoveTokens(tokens, 0);
    if (moves.length > 0) {
      games.push(moves);
    }
  }

  // If no [Event headers found, try parsing the whole text as movetext
  if (games.length === 0 && text.trim()) {
    const tokens = tokenizePgn(text);
    const { moves } = parseMoveTokens(tokens, 0);
    if (moves.length > 0) {
      games.push(moves);
    }
  }

  return games;
}

function normalizedFen(fen) {
  // Nur die ersten 4 Felder (Stellung, Seite, Rochaderechte, en-passant).
  // Halbzug- und Vollzugzaehler spielen fuer Repertoire-Matching keine Rolle.
  return fen.split(' ').slice(0, 4).join(' ');
}

function chessComPlayedAt(h) {
  if (!h || !h.Date || !/^\d{4}\.\d{2}\.\d{2}$/.test(h.Date)) return null;
  const tm = (h.EndTime || '').match(/(\d{2}):(\d{2}):(\d{2})/);
  const time = tm ? `${tm[1]}:${tm[2]}:${tm[3]}` : '00:00:00';
  const d = new Date(`${h.Date.replace(/\./g, '-')}T${time}Z`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function chessableSearchUrl(fen) {
  // Globale Chessable-FEN-Suche: "/" wird zu "U", " " zu "%20" (chessable-
  // spezifische Kodierung, KEIN encodeURIComponent).
  const encoded = fen.replace(/\//g, 'U').replace(/ /g, '%20');
  return 'https://www.chessable.com/courses/fen/' + encoded + '/';
}

// Node/CommonJS-Export (im Browser-Content-Script ist `module` undefiniert → übersprungen).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    tokenizePgn, isMoveToken, parseMoveTokens, parsePgnText,
    normalizedFen, chessComPlayedAt, chessableSearchUrl,
  };
}

// Browser (Content-Script / Userscript): an ein gemeinsames Namespace hängen,
// aus dem content.js die Helfer bezieht. `self` deckt Window- + Worker-Kontext ab.
if (typeof self !== 'undefined') {
  self.RepCheckLib = Object.assign(self.RepCheckLib || {}, {
    tokenizePgn, isMoveToken, parseMoveTokens, parsePgnText,
    normalizedFen, chessComPlayedAt, chessableSearchUrl,
  });
}
