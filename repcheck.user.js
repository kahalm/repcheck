// ==UserScript==
// @name         RepCheck — Opening Repertoire Deviation Checker
// @namespace    https://github.com/kahalm/repcheck
// @version      1.59.0
// @require      https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js
// @description  Shows where your game deviates from your opening repertoire (chess.com + lichess, PGN files or RookHub). On chessable.com: copy/search FEN, remember a line to RookHub, show earned XP, report active training time to RookHub, read the API token.
// @author       kahalm
// @homepageURL  https://github.com/kahalm/repcheck
// @supportURL   https://github.com/kahalm/repcheck/issues
// @updateURL    https://raw.githubusercontent.com/kahalm/repcheck/master/repcheck.user.js
// @downloadURL  https://raw.githubusercontent.com/kahalm/repcheck/master/repcheck.user.js
// @icon         https://raw.githubusercontent.com/kahalm/repcheck/master/extension/icons/icon48.png
// @match        https://www.chess.com/*
// @match        https://lichess.org/*
// @match        https://www.chessable.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────
  const IDB_NAME = 'RepertoireCheckerDB';
  const IDB_STORE = 'handles';
  const IDB_KEY = 'repertoireDir';
  // RookHub-Integration: separater Store fuer Config (URL+Token) und Cache.
  const IDB_ROOKHUB_STORE = 'rookhub';
  const IDB_ROOKHUB_CONFIG_KEY = 'config';
  const IDB_ROOKHUB_CACHE_KEY = 'cache';
  const IDB_ROOKHUB_POSITIONS_KEY = 'positionSet';
  const DEVIATION_CLASS = 'repcheck-deviation';
  const GAP_CLASS = 'repcheck-gap';
  const IN_REP_CLASS = 'repcheck-in-rep';
  const BANNER_ID = 'repcheck-banner';
  const PANEL_ID = 'repcheck-panel';
  // Oeffentliche Default-Instanz fuer Erst-Nutzer (Vorbefuellung im Panel +
  // Registrierungs-Link).
  const ROOKHUB_DEFAULT_URL = 'https://rookhub.oberschmid.homes';

  // ─── State ───────────────────────────────────────────────────────────
  let repertoirePositions = null; // Set<string> of normalized FENs (transposition-aware)
  let dirHandle = null;
  let lastUrl = '';
  let currentDeviationIndex = -1;
  let lastGameMovesKey = '';
  let lastDeviationFen = null; // FEN vor dem Out-of-Rep-Zug fuer Chessable-Suche

  // ─── Shared Core: reine PGN-/FEN-Helfer ────────────────────────────
  // GENERIERT aus extension/lib/repertoire-text.js via `npm run build:userscript`
  // (build/assemble.mjs). NICHT VON HAND EDITIEREN — Logik in lib/ ändern + neu bauen.
  // >>>REPCHECK-SHARED:repertoire-text
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
  // <<<REPCHECK-SHARED:repertoire-text

  // ─── Shared Core: Übersetzungen ─────────────────────────────────────
  // GENERIERT aus extension/lib/i18n.js via `npm run build:userscript`
  // (build/assemble.mjs). NICHT VON HAND EDITIEREN — Texte in lib/ ändern + neu bauen.
  // >>>REPCHECK-SHARED:i18n
  const RC_MESSAGES = {
    en: {
      // — Sprachwahl —
      'lang.label': 'Language',
      'lang.auto': 'Automatic ({lang})',

      // — Popup: Kopf und Grundgerüst —
      'popup.share.heading': 'Link to the current line',
      'popup.share.copy': 'Copy',
      'popup.share.loading': 'loading…',
      'popup.share.noMoves': 'No move sequence on this page.',
      'popup.share.ready': {
        one: '{count} ply · click “Copy”',
        other: '{count} plies · click “Copy”',
      },
      'popup.share.failed': 'Could not create link: {error}',
      'popup.copied': 'copied ✓',
      'popup.copyFailed': 'copy failed',
      'popup.status.loading': 'Loading status…',
      'popup.check': 'Check',
      'popup.settings': 'Settings',

      // — Popup: Repertoire-Status —
      'popup.rep.heading': {
        one: 'Repertoire ({count})',
        other: 'Repertoires ({count})',
      },
      'popup.rep.unnamed': '(unnamed)',
      'popup.rep.files': {
        one: '{count} PGN',
        other: '{count} PGNs',
      },
      'popup.rookhub.loading': 'RookHub: loading repertoires…',
      'popup.rookhub.connected': {
        one: 'RookHub connected · {count} repertoire',
        other: 'RookHub connected · {count} repertoires',
      },
      'popup.rookhub.noOpenings': 'RookHub connected · no opening repertoires',
      'popup.rookhub.error': 'RookHub: {error}',
      'popup.local.loaded': {
        one: 'Local: {count} opening loaded ({min} min ago)',
        other: 'Local: {count} openings loaded ({min} min ago)',
      },
      'popup.none': 'No repertoire loaded yet',

      // — Popup: RookHub-Verbindung (einzige Eingabestelle, auf JEDEM Tab erreichbar) —
      'popup.conn.heading': 'RookHub connection',
      'popup.conn.notConnected': 'Not connected',
      'popup.conn.connected': 'Connected',
      'popup.conn.pair': '🔗 Connect to RookHub',
      'popup.conn.pairHint': 'Opens RookHub, waits for your sign-in and creates the access token for you.',
      'popup.conn.pairing': 'Opening RookHub…',
      'popup.conn.login': 'Please sign in to RookHub in the tab that opened — this continues by itself.',
      'popup.conn.creating': 'Creating access token…',
      'popup.conn.checking': 'Checking token…',
      'popup.conn.failed': 'Failed: {error}',
      'popup.conn.timeout': 'Stopped — took too long.',
      'popup.conn.cancelled': 'Stopped — the RookHub tab was closed.',
      'popup.conn.manual': 'Enter token by hand',
      'popup.conn.save': 'Save',
      'popup.conn.forget': 'Disconnect',
      'popup.conn.tokens': 'Manage tokens in RookHub ↗',
      'popup.conn.needUrl': 'Please enter the RookHub address.',
      'popup.conn.needToken': 'Please enter a token.',
      'popup.conn.errAuth': 'Not signed in to RookHub (or the session expired).',
      'popup.conn.errNotRookhub': 'No RookHub found at this address.',
      'popup.conn.pagePanel': 'Folder / PGN on the page…',

      // — Popup: Chessable-Token —
      'popup.chessable.heading': 'Chessable token',
      'popup.chessable.copy': 'Copy token',
      'popup.chessable.justCaptured': 'just captured',
      'popup.chessable.capturedAgo': 'captured {min} min ago',

      // — Popup: Chessable-Button-Einstellungen —
      'popup.buttons.heading': 'Chessable buttons',
      'popup.buttons.intro': 'Choose which buttons and indicators appear in the bottom right on chessable.com (practice mode). Everything is off until you turn it on.',
      'popup.buttons.fullscreen': 'Fullscreen',
      'popup.buttons.pool': '⏳ Still open in the training pool',
      'popup.buttons.feedback': 'Move feedback (+XP)',

      // — Popup: Erste Schritte + Hinweis „Buttons jetzt aus" (v1.59.0) —
      'popup.onb.heading': 'Getting started',
      'popup.onb.close': 'Hide',
      'popup.onb.connect': 'Connect to RookHub',
      'popup.onb.course': 'Fetch a Chessable course to RookHub',
      'popup.onb.buttons': 'Choose the Chessable buttons',
      'popup.onb.welcome': 'Open the introduction ↗',
      'notice.buttons.body': 'New in RepCheck: the buttons in the bottom right on chessable.com can now be switched on one by one and are off by default.',
      'notice.buttons.choose': 'Choose buttons',
      'notice.buttons.ok': 'OK',
      'connect.prompt.title': 'RepCheck is not connected to RookHub yet',
      'connect.prompt.body': 'Without RookHub, RepCheck cannot fetch courses, show ✓ and ○ or report training time on Chessable.',
      'connect.prompt.connect': 'Connect now',
      'connect.prompt.later': 'Later',

      // — Willkommensseite (welcome.html) —
      'welcome.title': 'Welcome to RepCheck',
      'welcome.intro': 'RepCheck connects chess.com, lichess and Chessable with your RookHub. Three steps and you are ready.',
      'welcome.connect.text': 'RepCheck uses your RookHub account to know your repertoires and to fetch Chessable courses. Sign in to RookHub when asked; the access token is created for you.',
      'welcome.connect.connectedTo': '✓ Connected to {host}',
      'welcome.usage.title': 'What RepCheck does where',
      'welcome.usage.games': 'Open the analysis after a game. RepCheck marks in the move list where you left your repertoire.',
      'welcome.usage.chessable': 'Open a course and choose “⚡ Fetch course via my browser” in the RepCheck popup. The lines are stored in RookHub, and ✓ and ○ on chessable.com show what is already there.',
      'welcome.usage.rookhub': 'In RookHub you keep training your repertoires and courses.',
      'welcome.buttons.text': 'In practice mode on chessable.com, RepCheck can show buttons and indicators in the bottom right. Everything is off until you tick it here. You can change it later in the popup under “Settings”.',
      'welcome.btn.copyFen': 'copies the position to the clipboard',
      'welcome.btn.analyse': 'opens the position in the RookHub analysis',
      'welcome.btn.searchFen': 'searches Chessable for the position',
      'welcome.btn.refresh': 'reloads the page',
      'welcome.btn.remember': 'remembers the position in RookHub',
      'welcome.btn.fullscreen': 'board fills the screen, with its own buttons for Next, Hint and comments',
      'welcome.btn.pool': 'counter next to the buttons; click it for the day’s summary',
      'welcome.btn.feedback': 'points for each move, also in fullscreen; click it for the line’s breakdown',
      'welcome.saved': 'Saved.',
      'welcome.footer': 'You can open this page again at any time: popup → “Settings” → “Open the introduction”.',

      // — Popup: Kurs holen, Pause zwischen Chessable-Abrufen —
      'popup.crawl.heading': 'Fetch course: pause between requests',
      'popup.crawl.intro': 'Between two Chessable requests RepCheck waits a random time in this range. It can only be made slower — the minimum is {min}–{max} s.',
      'popup.crawl.from': 'from',
      'popup.crawl.to': 'to',
      'popup.crawl.saved': 'Saved: {min}–{max} s',
      'popup.crawl.adjusted': 'Adjusted to the allowed range: {min}–{max} s',

      // — Popup: Fußzeile —
      'popup.open.chesscom': 'chess.com',
      'popup.open.lichess': 'lichess.org',
      'popup.needTab': 'Please open chess.com or lichess.org in the active tab first.',
      'popup.error': 'Error: {error}',

      // — Kurs-Import über den Browser —
      'import.heading': 'RookHub import (browser)',
      'import.target.repertoire': 'Repertoire',
      'import.target.book': 'Course/book',
      'import.crawl': '⚡ Fetch course via my browser',
      'import.cancel': 'Cancel',
      'import.captured': {
        one: 'Import recorded lines ({count} line)',
        other: 'Import recorded lines ({count} lines)',
      },
      'import.capturedPlain': 'Import recorded lines',
      'import.capturedInfo': {
        one: '{count} line recorded',
        other: '{count} lines recorded',
      },
      'import.capturedNone': 'Nothing recorded yet',
      'import.notReady': 'Content script not ready — reload the page.',
      'import.course': 'Course: {name}',
      'import.courseId': 'Course ID {id}',
      'import.openCourse': 'Open a Chessable course.',
      'import.onRookhub': 'On RookHub: {done}/{total} lines ({pct}%)',
      'import.starting': 'Starting…',
      'import.importing': 'Importing…',
      'import.warn.title': 'Ban risk',
      'import.warn.body': '“Fetch course via my browser” makes rapid, automated calls to the Chessable API. This may violate Chessable’s terms of use and in the worst case get your account suspended.',
      'import.warn.own': 'Use it only for your own courses and at your own risk.',
      'import.warn.confirm': 'Continue anyway?',
      'import.throttled': 'Chessable is throttling (HTTP {status}) — waiting {seconds} s (attempt {attempt}/{max})…',
      'import.fetchingStructure': 'Fetching course structure…',
      'import.aborted': 'Cancelled.',
      'import.abortRequested': 'Cancelling…',
      'import.nothingNew': {
        one: 'Nothing new — the {count} line is already on RookHub.',
        other: 'Nothing new — all {count} lines are already on RookHub.',
      },
      'import.fetchingLines': 'Fetching new lines… {done}/{total}',
      'import.fetchingLinesShared': 'Fetching new lines… {done}/{total} ({shared} from the RookHub cache)',
      'import.appending': 'Appending new lines…',
      'import.doneAppended': {
        one: 'Done: {count} new line appended.',
        other: 'Done: {count} new lines appended.',
      },
      'import.doneAppendedSkipped': {
        one: 'Done: {count} new line appended ({skipped} already present).',
        other: 'Done: {count} new lines appended ({skipped} already present).',
      },
      'import.doneImportedPuzzles': {
        one: 'Done: {count} puzzle imported.',
        other: 'Done: {count} puzzles imported.',
      },
      'import.doneImportedLines': {
        one: 'Done: {count} line imported.',
        other: 'Done: {count} lines imported.',
      },
      'import.nothingCaptured': 'Nothing recorded.',
      'import.importingCapture': 'Importing recorded lines…',
      'import.liveAppended': {
        one: 'Live: {count} line appended ({sent} sent).',
        other: 'Live: {count} lines appended ({sent} sent).',
      },
      'import.liveError': 'Live error: {error}',
      'import.error': 'Error: {error}',

      // — In-Page-Einstellungs-Panel —
      'panel.heading': 'Repertoire settings',
      'panel.rookhub': 'RookHub:',
      'panel.connect': 'Connect',
      'panel.refresh': 'Refresh',
      'panel.noAccount': 'No account yet? ',
      'panel.register': 'Register at {host}',
      'panel.tokenHint': ' · then create a token under Profile → “Extension tokens”.',
      'panel.tokenSaved': 'Token saved — leave empty to keep it',
      'panel.folder': 'Load from folder:',
      'panel.selectFolder': 'Select PGN folder',
      'panel.folderLoaded': '(loaded)',
      'panel.noFolder': '(no folder selected)',
      'panel.paste': 'Or paste PGN:',
      'panel.pastePlaceholder': 'Paste your repertoire PGN here…',
      'panel.loadPgn': 'Load PGN',
      'panel.close': 'Close',
      'panel.loaded': 'Repertoire loaded',
      'panel.notLoaded': 'No repertoire loaded',
      'panel.loadedFiles': {
        one: 'Repertoire loaded: {count} file',
        other: 'Repertoire loaded: {count} files',
      },
      'panel.loadedText': 'Repertoire loaded from text',
      'panel.noPgnFiles': 'No .pgn files found in the folder',

      // — Verbindungsstatus (Popup UND Panel) —
      'status.needUrlToken': 'RookHub: URL and token required.',
      'status.connecting': 'RookHub: connecting…',
      'status.refreshing': 'RookHub: refreshing…',
      'status.notConfigured': 'RookHub: not configured yet.',
      'status.error': 'RookHub: {error}',
      'status.connectedNoOpenings': 'RookHub: connected, but no opening repertoires found.',
      'status.connectedFiles': {
        one: 'RookHub: connected ({count} file).',
        other: 'RookHub: connected ({count} files).',
      },

      // — Prüf-Ergebnis —
      'check.outOfRep': 'Out of repertoire at move {move} ({color}: {san})',
      'check.outOfRepWithGaps': 'Out of repertoire at move {move} ({color}: {san}) ({gaps})',
      'check.transpositions': {
        one: '{count} transposition',
        other: '{count} transpositions',
      },
      'check.inRep': 'In repertoire ✓',
      'check.inRepWithGaps': 'In repertoire ✓ ({gaps})',
      'check.fullyInRep': 'Game fully within repertoire ✓',
      'check.noMoves': 'No moves found',
      'check.noRepertoire': 'No repertoire loaded — click ⚙ to set one up',
      'check.white': 'White',
      'check.black': 'Black',

      // — Schwebende Knöpfe auf chess.com/lichess —
      'tools.check': 'Check the current game against the repertoire',
      'tools.searchFen': 'Search Chessable for the FEN before the deviation',
      'tools.copyPgn': 'Copy game PGN',
      'tools.saveGame': 'Save game to RookHub',
      'tools.saved': 'Game saved',
      'tools.savedWithLink': 'Saved · share link copied',

      // — ✓/○-Marker an Chessables eigener Linienliste —
      'progress.onRookhub': 'On RookHub',
      'progress.notOnRookhub': 'Not on RookHub yet',
      'progress.countTitle': 'On RookHub: {done} of {total}',

      // — Fehlertexte —
      'err.noBackground': 'no response from the background worker',
      'err.tokenInvalid': 'Token invalid or expired.',
      'err.http': 'HTTP {status}',
      'err.rookhubHttp': 'RookHub HTTP {status}',
      'err.urlTokenMissing': 'RookHub: URL or token missing.',
      'err.noToken': 'no token in the response',
      'err.notConnected': 'Not connected to RookHub',
      'review.consent.body': 'RepCheck sends the lines you train to {host} to build your courses. Send them?',
      'review.consent.allow': 'Send',
      'review.consent.deny': 'Don’t send',
      'err.noChessableToken': 'No Chessable token (are you logged in to chessable.com?)',
      'err.chessableTokenNoUid': 'Chessable token without uid',
      'err.chessableHttp': 'Chessable HTTP {status}',
      'err.noCourse': 'No course detected',
      'err.libMissing': 'internal lib missing',
      'err.noChapters': 'No chapters found',
      'err.noLines': 'No lines fetched',

      // — Tampermonkey-Menü (nur Userscript) —
      'menu.check': '♟ Check',
      'menu.settings': '⚙ Settings',
      'menu.copyChessableToken': '🔑 Copy Chessable token',
      'menu.noChessableToken': 'RepCheck: no Chessable token found in localStorage — logged in?',
      'menu.chessableTokenCopied': 'RepCheck: Chessable token copied to clipboard.',
    },

    de: {
      'lang.label': 'Sprache',
      'lang.auto': 'Automatisch ({lang})',

      'popup.share.heading': 'Link zur aktuellen Line',
      'popup.share.copy': 'Kopieren',
      'popup.share.loading': 'lade…',
      'popup.share.noMoves': 'Keine Zugfolge auf dieser Seite.',
      'popup.share.ready': {
        one: '{count} Halbzug · klick „Kopieren“',
        other: '{count} Halbzüge · klick „Kopieren“',
      },
      'popup.share.failed': 'Link fehlgeschlagen: {error}',
      'popup.copied': 'kopiert ✓',
      'popup.copyFailed': 'Kopieren fehlgeschlagen',
      'popup.status.loading': 'Lade Status…',
      'popup.check': 'Prüfen',
      'popup.settings': 'Einstellungen',

      'popup.rep.heading': {
        one: 'Repertoire ({count})',
        other: 'Repertoires ({count})',
      },
      'popup.rep.unnamed': '(unbenannt)',
      'popup.rep.files': {
        one: '{count} PGN',
        other: '{count} PGNs',
      },
      'popup.rookhub.loading': 'RookHub: lade Repertoires…',
      'popup.rookhub.connected': {
        one: 'RookHub verbunden · {count} Repertoire',
        other: 'RookHub verbunden · {count} Repertoires',
      },
      'popup.rookhub.noOpenings': 'RookHub verbunden · keine Opening-Repertoires',
      'popup.rookhub.error': 'RookHub: {error}',
      'popup.local.loaded': {
        one: 'Lokal: {count} Eröffnung geladen (vor {min} min)',
        other: 'Lokal: {count} Eröffnungen geladen (vor {min} min)',
      },
      'popup.none': 'Noch kein Repertoire geladen',

      // — Popup: RookHub-Verbindung (einzige Eingabestelle, auf JEDEM Tab erreichbar) —
      'popup.conn.heading': 'RookHub-Verbindung',
      'popup.conn.notConnected': 'Nicht verbunden',
      'popup.conn.connected': 'Verbunden',
      'popup.conn.pair': '🔗 Mit RookHub verbinden',
      'popup.conn.pairHint': 'Öffnet RookHub, wartet auf deine Anmeldung und legt den Zugriffs-Token selbst an.',
      'popup.conn.pairing': 'Öffne RookHub…',
      'popup.conn.login': 'Bitte im geöffneten Tab bei RookHub anmelden — es geht dann von selbst weiter.',
      'popup.conn.creating': 'Lege Zugriffs-Token an…',
      'popup.conn.checking': 'Prüfe Token…',
      'popup.conn.failed': 'Fehlgeschlagen: {error}',
      'popup.conn.timeout': 'Abgebrochen — hat zu lange gedauert.',
      'popup.conn.cancelled': 'Abgebrochen — der RookHub-Tab wurde geschlossen.',
      'popup.conn.manual': 'Token von Hand eintragen',
      'popup.conn.save': 'Speichern',
      'popup.conn.forget': 'Trennen',
      'popup.conn.tokens': 'Tokens in RookHub verwalten ↗',
      'popup.conn.needUrl': 'Bitte die RookHub-Adresse eintragen.',
      'popup.conn.needToken': 'Bitte einen Token eintragen.',
      'popup.conn.errAuth': 'Nicht bei RookHub angemeldet (oder die Sitzung ist abgelaufen).',
      'popup.conn.errNotRookhub': 'Unter dieser Adresse ist kein RookHub erreichbar.',
      'popup.conn.pagePanel': 'Ordner / PGN auf der Seite…',

      'popup.chessable.heading': 'Chessable-Token',
      'popup.chessable.copy': 'Token kopieren',
      'popup.chessable.justCaptured': 'gerade erfasst',
      'popup.chessable.capturedAgo': 'vor {min} min erfasst',

      'popup.buttons.heading': 'Chessable-Buttons',
      'popup.buttons.intro': 'Welche Buttons und Anzeigen unten rechts auf chessable.com (Practice-Modus) erscheinen. Standardmäßig ist alles aus.',
      'popup.buttons.fullscreen': 'Vollbild',
      'popup.buttons.pool': '⏳ Noch offen im Trainingspool',
      'popup.buttons.feedback': 'Zug-Rückmeldung (+XP)',

      'popup.onb.heading': 'Erste Schritte',
      'popup.onb.close': 'Ausblenden',
      'popup.onb.connect': 'Mit RookHub verbinden',
      'popup.onb.course': 'Einen Chessable-Kurs zu RookHub holen',
      'popup.onb.buttons': 'Chessable-Buttons auswählen',
      'popup.onb.welcome': 'Einführung öffnen ↗',
      'notice.buttons.body': 'Neu in RepCheck: Die Buttons unten rechts auf chessable.com lassen sich jetzt einzeln einschalten und sind standardmäßig aus.',
      'notice.buttons.choose': 'Buttons auswählen',
      'notice.buttons.ok': 'OK',
      'connect.prompt.title': 'RepCheck ist noch nicht mit RookHub verbunden',
      'connect.prompt.body': 'Ohne RookHub kann RepCheck auf Chessable keine Kurse holen, keine ✓ und ○ zeigen und keine Trainingszeit melden.',
      'connect.prompt.connect': 'Jetzt verbinden',
      'connect.prompt.later': 'Später',

      'welcome.title': 'Willkommen bei RepCheck',
      'welcome.intro': 'RepCheck verbindet chess.com, lichess und Chessable mit deinem RookHub. Drei Schritte, dann kann es losgehen.',
      'welcome.connect.text': 'RepCheck nutzt dein RookHub-Konto, um deine Repertoires zu kennen und Chessable-Kurse zu holen. Melde dich bei RookHub an, wenn danach gefragt wird; der Zugriffs-Token wird automatisch angelegt.',
      'welcome.connect.connectedTo': '✓ Verbunden mit {host}',
      'welcome.usage.title': 'Was RepCheck wo macht',
      'welcome.usage.games': 'Öffne nach einer Partie die Analyse. RepCheck markiert in der Zugliste, wo du dein Repertoire verlassen hast.',
      'welcome.usage.chessable': 'Öffne einen Kurs und wähle im RepCheck-Popup „⚡ Kurs über meinen Browser holen“. Die Linien landen in RookHub, und ✓ und ○ auf chessable.com zeigen, was schon dort liegt.',
      'welcome.usage.rookhub': 'In RookHub trainierst du deine Repertoires und Kurse weiter.',
      'welcome.buttons.text': 'Im Practice-Modus auf chessable.com kann RepCheck unten rechts Buttons und Anzeigen einblenden. Alles ist aus, bis du es hier ankreuzt. Später geht das auch im Popup unter „Einstellungen“.',
      'welcome.btn.copyFen': 'kopiert die Stellung in die Zwischenablage',
      'welcome.btn.analyse': 'öffnet die Stellung in der RookHub-Analyse',
      'welcome.btn.searchFen': 'sucht die Stellung auf Chessable',
      'welcome.btn.refresh': 'lädt die Seite neu',
      'welcome.btn.remember': 'merkt die Stellung in RookHub',
      'welcome.btn.fullscreen': 'Brett bildschirmfüllend, mit eigenen Knöpfen für Next, Hint und Kommentare',
      'welcome.btn.pool': 'Zähler neben den Buttons; ein Klick zeigt die Tagesbilanz',
      'welcome.btn.feedback': 'Punkte je Zug, auch im Vollbild; ein Klick zeigt die Einzelbeträge der Linie',
      'welcome.saved': 'Gespeichert.',
      'welcome.footer': 'Diese Seite findest du jederzeit wieder: Popup → „Einstellungen“ → „Einführung öffnen“.',

      'popup.crawl.heading': 'Kurs holen: Pause zwischen Abrufen',
      'popup.crawl.intro': 'Zwischen zwei Chessable-Abrufen wartet RepCheck eine zufällige Zeit in diesem Bereich. Es geht nur langsamer — das Minimum ist {min}–{max} s.',
      'popup.crawl.from': 'von',
      'popup.crawl.to': 'bis',
      'popup.crawl.saved': 'Gespeichert: {min}–{max} s',
      'popup.crawl.adjusted': 'Auf den erlaubten Bereich angepasst: {min}–{max} s',

      'popup.open.chesscom': 'chess.com',
      'popup.open.lichess': 'lichess.org',
      'popup.needTab': 'Bitte zuerst chess.com oder lichess.org im aktiven Tab öffnen.',
      'popup.error': 'Fehler: {error}',

      'import.heading': 'RookHub-Import (Browser)',
      'import.target.repertoire': 'Repertoire',
      'import.target.book': 'Kurs/Buch',
      'import.crawl': '⚡ Kurs über meinen Browser holen',
      'import.cancel': 'Abbrechen',
      'import.captured': {
        one: 'Mitschnitt importieren ({count} Linie)',
        other: 'Mitschnitt importieren ({count} Linien)',
      },
      'import.capturedPlain': 'Mitschnitt importieren',
      'import.capturedInfo': {
        one: '{count} Linie mitgeschnitten',
        other: '{count} Linien mitgeschnitten',
      },
      'import.capturedNone': 'Noch nichts mitgeschnitten',
      'import.notReady': 'Content-Script nicht bereit — Seite neu laden.',
      'import.course': 'Kurs: {name}',
      'import.courseId': 'Kurs-ID {id}',
      'import.openCourse': 'Öffne einen Chessable-Kurs.',
      'import.onRookhub': 'Auf RookHub: {done}/{total} Linien ({pct}%)',
      'import.starting': 'Starte …',
      'import.importing': 'Importiere …',
      'import.warn.title': 'Bannrisiko',
      'import.warn.body': '„Kurs über meinen Browser holen“ ruft die Chessable-API automatisiert im Schnelldurchlauf ab. Das kann gegen Chessables Nutzungsbedingungen verstoßen und im schlimmsten Fall zur Sperrung deines Kontos führen.',
      'import.warn.own': 'Nutze es nur für eigene Kurse und auf eigenes Risiko.',
      'import.warn.confirm': 'Wirklich fortfahren?',
      'import.throttled': 'Chessable drosselt (HTTP {status}) — warte {seconds} s (Versuch {attempt}/{max}) …',
      'import.fetchingStructure': 'Hole Kursstruktur …',
      'import.aborted': 'Abgebrochen.',
      'import.abortRequested': 'Abbruch angefordert …',
      'import.nothingNew': {
        one: 'Nichts Neues — {count} Linie ist schon auf RookHub.',
        other: 'Nichts Neues — alle {count} Linien sind schon auf RookHub.',
      },
      'import.fetchingLines': 'Hole neue Linien … {done}/{total}',
      'import.fetchingLinesShared': 'Hole neue Linien … {done}/{total} ({shared} aus dem RookHub-Cache)',
      'import.appending': 'Hänge neue Linien an …',
      'import.doneAppended': {
        one: 'Fertig: {count} neue Linie angehängt.',
        other: 'Fertig: {count} neue Linien angehängt.',
      },
      'import.doneAppendedSkipped': {
        one: 'Fertig: {count} neue Linie angehängt ({skipped} schon vorhanden).',
        other: 'Fertig: {count} neue Linien angehängt ({skipped} schon vorhanden).',
      },
      'import.doneImportedPuzzles': {
        one: 'Fertig: {count} Puzzle importiert.',
        other: 'Fertig: {count} Puzzles importiert.',
      },
      'import.doneImportedLines': {
        one: 'Fertig: {count} Linie importiert.',
        other: 'Fertig: {count} Linien importiert.',
      },
      'import.nothingCaptured': 'Nichts mitgeschnitten.',
      'import.importingCapture': 'Importiere Mitschnitt …',
      'import.liveAppended': {
        one: 'Live: {count} Linie angehängt ({sent} gesendet).',
        other: 'Live: {count} Linien angehängt ({sent} gesendet).',
      },
      'import.liveError': 'Live-Fehler: {error}',
      'import.error': 'Fehler: {error}',

      'panel.heading': 'Repertoire-Einstellungen',
      'panel.rookhub': 'RookHub:',
      'panel.connect': 'Verbinden',
      'panel.refresh': 'Aktualisieren',
      'panel.noAccount': 'Noch kein Konto? ',
      'panel.register': 'Auf {host} registrieren',
      'panel.tokenHint': ' · Token dann unter Profil → „Extension-Tokens“ erstellen.',
      'panel.tokenSaved': 'Token gespeichert — leer lassen, um ihn zu behalten',
      'panel.folder': 'Aus Ordner laden:',
      'panel.selectFolder': 'PGN-Ordner wählen',
      'panel.folderLoaded': '(geladen)',
      'panel.noFolder': '(kein Ordner gewählt)',
      'panel.paste': 'Oder PGN einfügen:',
      'panel.pastePlaceholder': 'Repertoire-PGN hier einfügen…',
      'panel.loadPgn': 'PGN laden',
      'panel.close': 'Schließen',
      'panel.loaded': 'Repertoire geladen',
      'panel.notLoaded': 'Kein Repertoire geladen',
      'panel.loadedFiles': {
        one: 'Repertoire geladen: {count} Datei',
        other: 'Repertoire geladen: {count} Dateien',
      },
      'panel.loadedText': 'Repertoire aus Text geladen',
      'panel.noPgnFiles': 'Keine .pgn-Dateien im Ordner gefunden',

      'status.needUrlToken': 'RookHub: URL und Token erforderlich.',
      'status.connecting': 'RookHub: verbinde…',
      'status.refreshing': 'RookHub: aktualisiere…',
      'status.notConfigured': 'RookHub: noch nicht konfiguriert.',
      'status.error': 'RookHub: {error}',
      'status.connectedNoOpenings': 'RookHub: verbunden, aber keine Opening-Repertoires gefunden.',
      'status.connectedFiles': {
        one: 'RookHub: verbunden ({count} Datei).',
        other: 'RookHub: verbunden ({count} Dateien).',
      },

      'check.outOfRep': 'Aus dem Repertoire bei Zug {move} ({color}: {san})',
      'check.outOfRepWithGaps': 'Aus dem Repertoire bei Zug {move} ({color}: {san}) ({gaps})',
      'check.transpositions': {
        one: '{count} Zugumstellung',
        other: '{count} Zugumstellungen',
      },
      'check.inRep': 'Im Repertoire ✓',
      'check.inRepWithGaps': 'Im Repertoire ✓ ({gaps})',
      'check.fullyInRep': 'Partie vollständig im Repertoire ✓',
      'check.noMoves': 'Keine Züge gefunden',
      'check.noRepertoire': 'Kein Repertoire geladen — ⚙ klicken zum Einrichten',
      'check.white': 'Weiß',
      'check.black': 'Schwarz',

      'tools.check': 'Aktuelle Partie gegen Repertoire prüfen',
      'tools.searchFen': 'FEN vor Abweichung in Chessable suchen',
      'tools.copyPgn': 'Partie-PGN kopieren',
      'tools.saveGame': 'Partie in RookHub speichern',
      'tools.saved': 'Partie gespeichert',
      'tools.savedWithLink': 'Gespeichert · Teilen-Link kopiert',
      'progress.onRookhub': 'Auf RookHub',
      'progress.notOnRookhub': 'Noch nicht auf RookHub',
      'progress.countTitle': 'Auf RookHub: {done} von {total}',

      'err.noBackground': 'keine Antwort vom Background-Worker',
      'err.tokenInvalid': 'Token ungültig oder abgelaufen.',
      'err.http': 'HTTP {status}',
      'err.rookhubHttp': 'RookHub HTTP {status}',
      'err.urlTokenMissing': 'RookHub: URL oder Token fehlt.',
      'err.noToken': 'kein Token in der Antwort',
      'err.notConnected': 'Nicht mit RookHub verbunden',
      'review.consent.body': 'RepCheck schickt die von dir trainierten Linien an {host}, um deine Kurse aufzubauen. Senden?',
      'review.consent.allow': 'Senden',
      'review.consent.deny': 'Nicht senden',
      'err.noChessableToken': 'Kein Chessable-Token (auf chessable.com eingeloggt?)',
      'err.chessableTokenNoUid': 'Chessable-Token ohne uid',
      'err.chessableHttp': 'Chessable HTTP {status}',
      'err.noCourse': 'Kein Kurs erkannt',
      'err.libMissing': 'Interne lib fehlt',
      'err.noChapters': 'Keine Kapitel gefunden',
      'err.noLines': 'Keine Linien geholt',

      'menu.check': '♟ Prüfen',
      'menu.settings': '⚙ Einstellungen',
      'menu.copyChessableToken': '🔑 Chessable-Token kopieren',
      'menu.noChessableToken': 'RepCheck: Kein Chessable-Token im localStorage gefunden — eingeloggt?',
      'menu.chessableTokenCopied': 'RepCheck: Chessable-Token in die Zwischenablage kopiert.',
    },

    hr: {
      'lang.label': 'Jezik',
      'lang.auto': 'Automatski ({lang})',
      'popup.share.heading': 'Poveznica na trenutnu liniju',
      'popup.share.copy': 'Kopiraj',
      'popup.share.loading': 'učitavanje…',
      'popup.share.noMoves': 'Na ovoj stranici nema niza poteza.',
      'popup.share.ready': {
        one: '{count} polupotez · klikni „Kopiraj“',
        few: '{count} polupoteza · klikni „Kopiraj“',
        other: '{count} polupoteza · klikni „Kopiraj“',
      },
      'popup.share.failed': 'Poveznica nije uspjela: {error}',
      'popup.copied': 'kopirano ✓',
      'popup.copyFailed': 'Kopiranje nije uspjelo',
      'popup.status.loading': 'Učitavanje stanja…',
      'popup.check': 'Provjeri',
      'popup.settings': 'Postavke',
      'popup.rep.heading': {
        one: 'Repertoar ({count})',
        few: 'Repertoari ({count})',
        other: 'Repertoari ({count})',
      },
      'popup.rep.unnamed': '(bez naziva)',
      'popup.rep.files': {
        one: '{count} PGN',
        few: '{count} PGN-a',
        other: '{count} PGN-ova',
      },
      'popup.rookhub.loading': 'RookHub: učitavanje repertoara…',
      'popup.rookhub.connected': {
        one: 'RookHub povezan · {count} repertoar',
        few: 'RookHub povezan · {count} repertoara',
        other: 'RookHub povezan · {count} repertoara',
      },
      'popup.rookhub.noOpenings': 'RookHub povezan · nema repertoara otvaranja',
      'popup.rookhub.error': 'RookHub: {error}',
      'popup.local.loaded': {
        one: 'Lokalno: učitano {count} otvaranje (prije {min} min)',
        few: 'Lokalno: učitana {count} otvaranja (prije {min} min)',
        other: 'Lokalno: učitano {count} otvaranja (prije {min} min)',
      },
      'popup.none': 'Još nije učitan nijedan repertoar',

      // — Popup: RookHub-Verbindung (einzige Eingabestelle, auf JEDEM Tab erreichbar) —
      'popup.conn.heading': 'RookHub veza',
      'popup.conn.notConnected': 'Nije povezano',
      'popup.conn.connected': 'Povezano',
      'popup.conn.pair': '🔗 Poveži s RookHubom',
      'popup.conn.pairHint': 'Otvara RookHub, čeka tvoju prijavu i sam izrađuje pristupni token.',
      'popup.conn.pairing': 'Otvaram RookHub…',
      'popup.conn.login': 'Prijavi se na RookHub u otvorenoj kartici — dalje ide samo od sebe.',
      'popup.conn.creating': 'Izrađujem pristupni token…',
      'popup.conn.checking': 'Provjeravam token…',
      'popup.conn.failed': 'Nije uspjelo: {error}',
      'popup.conn.timeout': 'Prekinuto — predugo je trajalo.',
      'popup.conn.cancelled': 'Prekinuto — RookHub kartica je zatvorena.',
      'popup.conn.manual': 'Ručni unos tokena',
      'popup.conn.save': 'Spremi',
      'popup.conn.forget': 'Odspoji',
      'popup.conn.tokens': 'Upravljaj tokenima u RookHubu ↗',
      'popup.conn.needUrl': 'Unesi adresu RookHuba.',
      'popup.conn.needToken': 'Unesi token.',
      'popup.conn.errAuth': 'Nisi prijavljen na RookHub (ili je sesija istekla).',
      'popup.conn.errNotRookhub': 'Na toj adresi nema RookHuba.',
      'popup.conn.pagePanel': 'Mapa / PGN na stranici…',
      'popup.chessable.heading': 'Chessable token',
      'popup.chessable.copy': 'Kopiraj token',
      'popup.chessable.justCaptured': 'upravo zabilježen',
      'popup.chessable.capturedAgo': 'zabilježen prije {min} min',
      'popup.buttons.heading': 'Chessable gumbi',
      'popup.buttons.intro': 'Koji se gumbi i prikazi pojavljuju dolje desno na chessable.com (Practice način). Prema zadanim postavkama sve je isključeno.',
      'popup.buttons.fullscreen': 'Cijeli zaslon',
      'popup.buttons.pool': '⏳ Još otvoreno u skupu za vježbu',
      'popup.buttons.feedback': 'Povratna informacija o potezu (+XP)',
      'popup.onb.heading': 'Prvi koraci',
      'popup.onb.close': 'Sakrij',
      'popup.onb.connect': 'Poveži se s RookHubom',
      'popup.onb.course': 'Dohvati Chessable tečaj na RookHub',
      'popup.onb.buttons': 'Odaberi Chessable gumbe',
      'popup.onb.welcome': 'Otvori uvod ↗',
      'notice.buttons.body': 'Novo u RepChecku: gumbi dolje desno na chessable.com sada se uključuju pojedinačno i prema zadanim postavkama su isključeni.',
      'notice.buttons.choose': 'Odaberi gumbe',
      'notice.buttons.ok': 'U redu',
      'connect.prompt.title': 'RepCheck još nije povezan s RookHubom',
      'connect.prompt.body': 'Bez RookHuba RepCheck na Chessableu ne može dohvaćati tečajeve, prikazivati ✓ i ○ niti javljati vrijeme treninga.',
      'connect.prompt.connect': 'Poveži sada',
      'connect.prompt.later': 'Kasnije',
      'welcome.title': 'Dobro došli u RepCheck',
      'welcome.intro': 'RepCheck povezuje chess.com, lichess i Chessable s tvojim RookHubom. Tri koraka i možeš početi.',
      'welcome.connect.text': 'RepCheck koristi tvoj RookHub račun kako bi znao tvoje repertoare i dohvaćao Chessable tečajeve. Prijavi se na RookHub kad to bude zatraženo; pristupni token stvara se automatski.',
      'welcome.connect.connectedTo': '✓ Povezano s {host}',
      'welcome.usage.title': 'Što RepCheck radi i gdje',
      'welcome.usage.games': 'Nakon partije otvori analizu. RepCheck u popisu poteza označi gdje si napustio svoj repertoar.',
      'welcome.usage.chessable': 'Otvori tečaj i u RepCheck skočnom prozoru pokreni dohvat tečaja (⚡). Linije se spremaju u RookHub, a ✓ i ○ na chessable.com pokazuju što je već ondje.',
      'welcome.usage.rookhub': 'U RookHubu nastavljaš trenirati svoje repertoare i tečajeve.',
      'welcome.buttons.text': 'U Practice načinu na chessable.com RepCheck može prikazati gumbe i prikaze dolje desno. Sve je isključeno dok to ovdje ne označiš. Kasnije to možeš promijeniti u postavkama skočnog prozora.',
      'welcome.btn.copyFen': 'kopira poziciju u međuspremnik',
      'welcome.btn.analyse': 'otvara poziciju u RookHub analizi',
      'welcome.btn.searchFen': 'traži poziciju na Chessableu',
      'welcome.btn.refresh': 'ponovno učitava stranicu',
      'welcome.btn.remember': 'pamti poziciju u RookHubu',
      'welcome.btn.fullscreen': 'ploča preko cijelog zaslona, s vlastitim gumbima za Next, Hint i komentare',
      'welcome.btn.pool': 'brojač pokraj gumba; klik prikazuje dnevni pregled',
      'welcome.btn.feedback': 'bodovi po potezu, i preko cijelog zaslona; klik prikazuje pojedinačne iznose linije',
      'welcome.saved': 'Spremljeno.',
      'welcome.footer': 'Ovu stranicu uvijek možeš ponovno otvoriti: skočni prozor → postavke → „Otvori uvod“.',
      'popup.crawl.heading': 'Dohvati tečaj: pauza između zahtjeva',
      'popup.crawl.intro': 'Između dva Chessable zahtjeva RepCheck čeka nasumično vrijeme u ovom rasponu. Može samo sporije — minimum je {min}–{max} s.',
      'popup.crawl.from': 'od',
      'popup.crawl.to': 'do',
      'popup.crawl.saved': 'Spremljeno: {min}–{max} s',
      'popup.crawl.adjusted': 'Prilagođeno dopuštenom rasponu: {min}–{max} s',
      'popup.open.chesscom': 'chess.com',
      'popup.open.lichess': 'lichess.org',
      'popup.needTab': 'Najprije otvori chess.com ili lichess.org u aktivnoj kartici.',
      'popup.error': 'Greška: {error}',
      'import.heading': 'RookHub uvoz (preglednik)',
      'import.target.repertoire': 'Repertoar',
      'import.target.book': 'Tečaj/knjiga',
      'import.crawl': '⚡ Dohvati tečaj preko mog preglednika',
      'import.cancel': 'Odustani',
      'import.captured': {
        one: 'Uvezi snimljene linije ({count} linija)',
        few: 'Uvezi snimljene linije ({count} linije)',
        other: 'Uvezi snimljene linije ({count} linija)',
      },
      'import.capturedPlain': 'Uvezi snimku',
      'import.capturedInfo': {
        one: 'snimljena {count} linija',
        few: 'snimljene {count} linije',
        other: 'snimljeno {count} linija',
      },
      'import.capturedNone': 'Još ništa nije snimljeno',
      'import.notReady': 'Content script nije spreman — ponovno učitaj stranicu.',
      'import.course': 'Tečaj: {name}',
      'import.courseId': 'ID tečaja {id}',
      'import.openCourse': 'Otvori neki Chessable tečaj.',
      'import.onRookhub': 'Na RookHubu: {done}/{total} linija ({pct}%)',
      'import.starting': 'Pokrećem …',
      'import.importing': 'Uvozim …',
      'import.warn.title': 'Rizik od blokade računa',
      'import.warn.body': '„Dohvati tečaj preko mog preglednika“ automatizirano i u brzom slijedu poziva Chessable API. To može prekršiti Chessableove uvjete korištenja i u najgorem slučaju dovesti do blokade tvojeg računa.',
      'import.warn.own': 'Koristi to samo za vlastite tečajeve i na vlastitu odgovornost.',
      'import.warn.confirm': 'Stvarno nastaviti?',
      'import.throttled': 'Chessable usporava promet (HTTP {status}) — čekam {seconds} s (pokušaj {attempt}/{max}) …',
      'import.fetchingStructure': 'Dohvaćam strukturu tečaja …',
      'import.aborted': 'Prekinuto.',
      'import.abortRequested': 'Zatražen prekid …',
      'import.nothingNew': {
        one: 'Ništa novo — {count} linija je već na RookHubu.',
        few: 'Ništa novo — sve {count} linije već su na RookHubu.',
        other: 'Ništa novo — svih {count} linija već je na RookHubu.',
      },
      'import.fetchingLines': 'Dohvaćam nove linije … {done}/{total}',
      'import.fetchingLinesShared': 'Dohvaćam nove linije … {done}/{total} ({shared} iz RookHub predmemorije)',
      'import.appending': 'Dodajem nove linije …',
      'import.doneAppended': {
        one: 'Gotovo: dodana {count} nova linija.',
        few: 'Gotovo: dodane {count} nove linije.',
        other: 'Gotovo: dodano {count} novih linija.',
      },
      'import.doneAppendedSkipped': {
        one: 'Gotovo: dodana {count} nova linija (već postojećih: {skipped}).',
        few: 'Gotovo: dodane {count} nove linije (već postojećih: {skipped}).',
        other: 'Gotovo: dodano {count} novih linija (već postojećih: {skipped}).',
      },
      'import.doneImportedPuzzles': {
        one: 'Gotovo: uvezena {count} zagonetka.',
        few: 'Gotovo: uvezene {count} zagonetke.',
        other: 'Gotovo: uvezeno {count} zagonetki.',
      },
      'import.doneImportedLines': {
        one: 'Gotovo: uvezena {count} linija.',
        few: 'Gotovo: uvezene {count} linije.',
        other: 'Gotovo: uvezeno {count} linija.',
      },
      'import.nothingCaptured': 'Ništa nije snimljeno.',
      'import.importingCapture': 'Uvozim snimku …',
      'import.liveAppended': {
        one: 'Uživo: dodana {count} linija ({sent} poslano).',
        few: 'Uživo: dodane {count} linije ({sent} poslano).',
        other: 'Uživo: dodano {count} linija ({sent} poslano).',
      },
      'import.liveError': 'Greška uživo: {error}',
      'import.error': 'Greška: {error}',
      'panel.heading': 'Postavke repertoara',
      'panel.rookhub': 'RookHub:',
      'panel.connect': 'Poveži',
      'panel.refresh': 'Osvježi',
      'panel.noAccount': 'Još nemaš račun? ',
      'panel.register': 'Registriraj se na {host}',
      'panel.tokenHint': ' · zatim izradi token pod Profile → „Extension tokens“.',
      'panel.tokenSaved': 'Token je spremljen — ostavi prazno da ga zadržiš',
      'panel.folder': 'Učitaj iz mape:',
      'panel.selectFolder': 'Odaberi PGN mapu',
      'panel.folderLoaded': '(učitano)',
      'panel.noFolder': '(nije odabrana mapa)',
      'panel.paste': 'Ili zalijepi PGN:',
      'panel.pastePlaceholder': 'Ovdje zalijepi PGN repertoara…',
      'panel.loadPgn': 'Učitaj PGN',
      'panel.close': 'Zatvori',
      'panel.loaded': 'Repertoar učitan',
      'panel.notLoaded': 'Nijedan repertoar nije učitan',
      'panel.loadedFiles': {
        one: 'Repertoar učitan: {count} datoteka',
        few: 'Repertoar učitan: {count} datoteke',
        other: 'Repertoar učitan: {count} datoteka',
      },
      'panel.loadedText': 'Repertoar učitan iz teksta',
      'panel.noPgnFiles': 'U mapi nema .pgn datoteka',
      'status.needUrlToken': 'RookHub: potrebni su URL i token.',
      'status.connecting': 'RookHub: povezivanje…',
      'status.refreshing': 'RookHub: osvježavanje…',
      'status.notConfigured': 'RookHub: još nije podešen.',
      'status.error': 'RookHub: {error}',
      'status.connectedNoOpenings': 'RookHub: povezan, ali nije pronađen nijedan repertoar otvaranja.',
      'status.connectedFiles': {
        one: 'RookHub: povezan ({count} datoteka).',
        few: 'RookHub: povezan ({count} datoteke).',
        other: 'RookHub: povezan ({count} datoteka).',
      },
      'check.outOfRep': 'Izvan repertoara na potezu {move} ({color}: {san})',
      'check.outOfRepWithGaps': 'Izvan repertoara na potezu {move} ({color}: {san}) ({gaps})',
      'check.transpositions': {
        one: '{count} transpozicija',
        few: '{count} transpozicije',
        other: '{count} transpozicija',
      },
      'check.inRep': 'U repertoaru ✓',
      'check.inRepWithGaps': 'U repertoaru ✓ ({gaps})',
      'check.fullyInRep': 'Partija je u cijelosti u repertoaru ✓',
      'check.noMoves': 'Nema pronađenih poteza',
      'check.noRepertoire': 'Nijedan repertoar nije učitan — klikni ⚙ za postavljanje',
      'check.white': 'Bijeli',
      'check.black': 'Crni',
      'tools.check': 'Provjeri trenutnu partiju u odnosu na repertoar',
      'tools.searchFen': 'Potraži FEN prije odstupanja na Chessableu',
      'tools.copyPgn': 'Kopiraj PGN partije',
      'tools.saveGame': 'Spremi partiju u RookHub',
      'tools.saved': 'Partija spremljena',
      'tools.savedWithLink': 'Spremljeno · poveznica za dijeljenje kopirana',
      'err.noBackground': 'nema odgovora od background workera',
      'err.tokenInvalid': 'Token nije valjan ili je istekao.',
      'err.http': 'HTTP {status}',
      'err.rookhubHttp': 'RookHub HTTP {status}',
      'err.urlTokenMissing': 'RookHub: nedostaje URL ili token.',
      'err.noToken': 'u odgovoru nema tokena',
      'err.notConnected': 'Nije povezano s RookHubom',
      'review.consent.body': 'RepCheck šalje linije koje treniraš na {host} kako bi izgradio tvoje tečajeve. Poslati?',
      'review.consent.allow': 'Pošalji',
      'review.consent.deny': 'Ne šalji',
      'err.noChessableToken': 'Nema Chessable tokena (jesi li prijavljen na chessable.com?)',
      'err.chessableTokenNoUid': 'Chessable token bez uid',
      'err.chessableHttp': 'Chessable HTTP {status}',
      'err.noCourse': 'Nije prepoznat nijedan tečaj',
      'err.libMissing': 'nedostaje interna lib',
      'err.noChapters': 'Nema pronađenih poglavlja',
      'err.noLines': 'Nije dohvaćena nijedna linija',
      'menu.check': '♟ Provjeri',
      'menu.settings': '⚙ Postavke',
      'menu.copyChessableToken': '🔑 Kopiraj Chessable token',
      'menu.noChessableToken': 'RepCheck: u localStorageu nije pronađen Chessable token — jesi li prijavljen?',
      'menu.chessableTokenCopied': 'RepCheck: Chessable token kopiran u međuspremnik.',
      'progress.onRookhub': 'Na RookHubu',
      'progress.notOnRookhub': 'Još nije na RookHubu',
      'progress.countTitle': 'Na RookHubu: {done} od {total}',
    },
  };

  /** Verfügbare Sprache aus einem BCP-47-Tag ableiten („de-AT" → „de"), sonst die Rückfallsprache. */
  function rcNormalizeLang(tag) {
    const kurz = String(tag || '').toLowerCase().split(/[-_]/)[0];
    return RC_LANGS.indexOf(kurz) >= 0 ? kurz : RC_FALLBACK;
  }

  /**
   * Sprache bestimmen: ausdrückliche Wahl des Nutzers schlägt alles, sonst die Browsersprache,
   * sonst Englisch. `gespeichert` kommt aus dem jeweiligen Speicher der Distribution
   * (chrome.storage.local bzw. GM-Storage) — dieses Modul kennt keinen Speicher, damit es
   * unverändert in Node, im Content-Script und im Userscript läuft.
   */
  function rcResolveLang(gespeichert, navigatorSprachen) {
    if (gespeichert && RC_LANGS.indexOf(String(gespeichert).toLowerCase()) >= 0) {
      return String(gespeichert).toLowerCase();
    }
    const liste = Array.isArray(navigatorSprachen) ? navigatorSprachen : [];
    for (const tag of liste) {
      const kurz = String(tag || '').toLowerCase().split(/[-_]/)[0];
      if (RC_LANGS.indexOf(kurz) >= 0) return kurz;
    }
    return RC_FALLBACK;
  }

  /** Plural-Variante wählen. Ohne Intl (alte Umgebung) bleibt es bei one/other. */
  function rcPluralForm(lang, count) {
    try {
      return new Intl.PluralRules(lang).select(count);
    } catch (e) {
      return count === 1 ? 'one' : 'other';
    }
  }

  /** Eintrag zu einer fertigen Vorlage auflösen: Plural-Objekte auf die passende Variante. */
  function rcTemplate(eintrag, lang, params) {
    if (typeof eintrag === 'string') return eintrag;
    if (!eintrag || typeof eintrag !== 'object') return null;
    const count = params && typeof params.count === 'number' ? params.count : 0;
    const form = rcPluralForm(lang, count);
    // Kroatisch kennt one/few/other; fehlt eine Variante, greift `other`, dann `one`.
    return eintrag[form] || eintrag.other || eintrag.one || null;
  }

  /**
   * Übersetzen. `{name}`-Platzhalter werden aus `params` gefüllt; ein fehlender Platzhalter bleibt
   * wörtlich stehen (sichtbar statt still leer). Unbekannte Schlüssel geben den Schlüssel zurück.
   */
  function rcTranslate(lang, key, params) {
    const sprache = RC_LANGS.indexOf(lang) >= 0 ? lang : RC_FALLBACK;
    const tabelle = RC_MESSAGES[sprache] || {};
    let vorlage = rcTemplate(tabelle[key], sprache, params);
    if (vorlage == null && sprache !== RC_FALLBACK) {
      vorlage = rcTemplate((RC_MESSAGES[RC_FALLBACK] || {})[key], RC_FALLBACK, params);
    }
    if (vorlage == null) return key;
    if (!params) return vorlage;
    return vorlage.replace(/\{(\w+)\}/g, (ganz, name) => (
      Object.prototype.hasOwnProperty.call(params, name) && params[name] != null
        ? String(params[name])
        : ganz
    ));
  }
  // <<<REPCHECK-SHARED:i18n

  // ─── Shared Core: Zug-Rückmeldung ───────────────────────────────────
  // GENERIERT aus extension/lib/chessable-feedback.js via `npm run build:userscript`.
  // NICHT VON HAND EDITIEREN.
  // >>>REPCHECK-SHARED:chessable-feedback
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
  // <<<REPCHECK-SHARED:chessable-feedback

  // ─── Shared Core: Chessable-Kursnamen ───────────────────────────────
  // GENERIERT aus extension/lib/chessable-course-names.js via `npm run build:userscript`
  // (build/assemble.mjs). NICHT VON HAND EDITIEREN — Logik in lib/ ändern + neu bauen.
  // >>>REPCHECK-SHARED:chessable-course-names
  function rcB64UrlDecode(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return atob(s);
  }

  // uid steckt im JWT-Payload unter user.uid (wie piratechess/JwtHelper). Gibt die uid als
  // String zurück oder null (leerer/kaputter Token, fehlende uid).
  function rcDecodeChessableUid(token) {
    try {
      const parts = String(token).split('.');
      if (parts.length < 2) return null;
      const o = JSON.parse(rcB64UrlDecode(parts[1]));
      const uid = o && o.user && o.user.uid;
      return (uid != null && /^\d+$/.test(String(uid))) ? String(uid) : null;
    } catch (e) { return null; }
  }

  // getHomeData-Antwort → { bid(string): name }. Toleriert camelCase/PascalCase-Keys und
  // numerische/String-bids; überspringt leere Namen; kappt auf 200 Zeichen.
  function rcParseCourseNameMap(data) {
    const home = data && (data.homeData || data.HomeData);
    const books = home && (home.booksList || home.BooksList);
    if (!Array.isArray(books)) return {};
    const map = {};
    for (const b of books) {
      const bid = b && (b.bid != null ? b.bid : b.Bid);
      const name = b && (b.name != null ? b.name : b.Name);
      if (bid != null && typeof name === 'string' && name.trim())
        map[String(bid)] = name.trim().slice(0, 200);
    }
    return map;
  }

  // Navigations-/Modus-/UI-Labels, die KEIN Kursname sind. Die Falle: solche Links zeigen ebenfalls
  // auf /course/{id}/… und verdrängten deshalb den echten Titel — gemeldet wurden „Practice Moves",
  // „Leaderboard" oder „Kapitel 3:" als Kursname.
  function rcIsNavLabel(txt) {
    const t = String(txt || '').toLowerCase().trim();
    // Eigenständige Nav-/Modus-/UI-Labels (exakter Match — echte Titel wie „Learn Chess Openings" bleiben).
    if (/^(practice( moves)?|learn( moves)?|review|overview|variations?|move ?trainer|next|previous|prev|continue|weiter|home|leaderboard)$/.test(t)) return true;
    // „Next/Previous chapter|variation|move|line" bzw. deutsche Entsprechungen.
    if (/^(next|previous|prev|nächst\w*|naechst\w*|vorherig\w*|vorig\w*|letzt\w*)\b/.test(t)
        && /(chapter|variation|move|line|kapitel|variante|zug|linie)/.test(t)) return true;
    // Kapitel-Überschriften („Kapitel 3:", „Chapter 12") — Seitentext, kein Kurstitel.
    if (/^(kapitel|chapter)\s*\d*\s*:?$/.test(t)) return true;
    return false;
  }
  // <<<REPCHECK-SHARED:chessable-course-names

  // ─── Sprache ────────────────────────────────────────────────────────
  // rcTranslate/rcResolveLang stammen aus der Region oben (generiert aus
  // extension/lib/i18n.js). Die ausdrueckliche Wahl des Nutzers liegt im
  // GM-Storage unter `rcLang` ('en'|'de'|'hr'); fehlt sie, entscheidet die
  // Browsersprache.
  let rcLang = 'en';
  try {
    rcGespeicherteSprache = (typeof GM_getValue === 'function' ? GM_getValue('rcLang') : '') || '';
    rcLang = rcResolveLang(rcGespeicherteSprache || null, navigator.languages);
  } catch (e) {
    rcLang = rcResolveLang(null, navigator.languages);
  }
  /** Ausdrückliche Wahl des Nutzers ('' = Automatik) — nur für die Anzeige im Panel. */
  let rcGespeicherteSprache = '';
  /** Welche Sprache die Automatik wählen würde — für die Beschriftung „Automatisch (…)". */
  function rcAutoLang() {
    return rcResolveLang(null, navigator.languages);
  }

  function t(key, params) { return rcTranslate(rcLang, key, params); }

  // Uebersetzten Text fuer die innerHTML-Vorlage des Panels entschaerfen.
  const RC_HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function rcEscHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => RC_HTML_ESCAPES[c]);
  }

  // ─── IndexedDB helpers ───────────────────────────────────────────────
  function openIDB() {
    return new Promise((resolve, reject) => {
      // v2: zusaetzlicher Store fuer RookHub-Config + Cache. onupgradeneeded muss
      // beide Stores anlegen, weil der Upgrade auch beim ersten Anlegen laeuft.
      const req = indexedDB.open(IDB_NAME, 2);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        if (!db.objectStoreNames.contains(IDB_ROOKHUB_STORE)) db.createObjectStore(IDB_ROOKHUB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveHandle(handle) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadHandle() {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  // ─── RookHub IDB Helpers ────────────────────────────────────────────
  async function idbGet(store, key) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(store, key, value) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Config laden. Der TOKEN kommt aus dem GM-Storage (Tampermonkey-Sandbox, NICHT
  // seiten-lesbar), nicht aus der IndexedDB: die IDB liegt auf dem
  // chess.com/lichess-Origin und wäre für Host-/XSS-Skripte lesbar; ein dort
  // abgelegter Token wäre exfiltrierbar. Legacy-Migration: ein noch im IDB
  // liegender Token wird einmalig nach GM gehoben und aus dem IDB entfernt (dort
  // bleibt nur die URL).
  async function loadRookhubConfig() {
    let gm = null;
    try { if (typeof GM_getValue !== 'undefined') gm = GM_getValue('rookhubConfig', null); } catch (e) {}
    if (gm && gm.url && gm.token) return gm;

    const legacy = await idbGet(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CONFIG_KEY).catch(() => null);
    if (legacy && legacy.url && legacy.token) {
      try { if (typeof GM_setValue !== 'undefined') GM_setValue('rookhubConfig', { url: legacy.url, token: legacy.token }); } catch (e) {}
      try { await idbPut(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CONFIG_KEY, { url: legacy.url }); } catch (e) {}
      return { url: legacy.url, token: legacy.token };
    }
    if (gm && gm.url) return gm;
    return (legacy && legacy.url) ? { url: legacy.url } : null;
  }

  function saveRookhubConfig(cfg) {
    // Token NUR im GM-Storage (Tampermonkey-Sandbox, origin-übergreifend, nicht
    // seiten-lesbar) — das Chessable-Activity-Tracking liest URL+Token von dort
    // (GM_getValue). In die origin-scoped IndexedDB (chess.com/lichess, für
    // Host-Skripte lesbar) kommt bewusst NUR die URL — nie der Token.
    try {
      if (typeof GM_setValue !== 'undefined' && cfg && cfg.url && cfg.token) {
        GM_setValue('rookhubConfig', { url: cfg.url, token: cfg.token });
      }
    } catch (e) { /* GM-Storage nicht verfuegbar — ignorieren */ }
    return idbPut(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CONFIG_KEY, { url: cfg && cfg.url });
  }

  // pgnTexts-Cache (vor 1.6.0): nur noch lesend fuer einmalige Migration zum Position-Set.
  function loadRookhubCache() {
    return idbGet(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CACHE_KEY);
  }

  function loadPositionSetCache() {
    return idbGet(IDB_ROOKHUB_STORE, IDB_ROOKHUB_POSITIONS_KEY);
  }

  function savePositionSetCache(data) {
    return idbPut(IDB_ROOKHUB_STORE, IDB_ROOKHUB_POSITIONS_KEY, data);
  }

  // Baut das Positions-Set aus PGN-Texten und persistiert es. Wird NUR auf
  // explizite Nutzeraktion aufgerufen (Aktualisieren-Button, neuer Ordner,
  // PGN-Text). Auf Page-Loads lesen wir das fertige Set direkt aus IDB.
  async function buildAndSavePositionSet(pgnTexts) {
    const set = buildPositionSetFromPgns(pgnTexts);
    try {
      await savePositionSetCache({ fens: Array.from(set), savedAt: Date.now() });
    } catch (e) {
      console.warn('[RepertoireChecker] Position-Cache nicht schreibbar:', e);
    }
    return set;
  }

  // ─── RookHub Fetch ──────────────────────────────────────────────────
  // Server-seitige Partie-Analyse: kein Vorab-Pull des Repertoires noetig.
  // Endpoint: POST /api/extension/analyze-game mit { moves, kind, refresh }.
  // Antwort: { deviation, gaps, inRepertoire, fenBeforeDeviation, repertoireFileCount, illegalMoveAt }.
  async function rookhubAnalyzeGame(cfg, moves, options) {
    if (!cfg || !cfg.url || !cfg.token) throw new Error(t('err.urlTokenMissing'));
    const url = cfg.url.replace(/\/$/, '') + '/api/extension/analyze-game';
    const resp = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        moves: moves || [],
        kind: 'Opening',
        refresh: !!(options && options.refresh),
      }),
    });
    if (resp.status === 401) throw new Error(t('err.tokenInvalid'));
    if (!resp.ok) throw new Error(t('err.rookhubHttp', { status: resp.status }));
    return await resp.json();
  }

  // Schickt die SAN-Zugliste + Best-Effort-Metadaten; der Server baut daraus das PGN
  // (reicheres Format als ein vorgebautes PGN: Spieler/Ergebnis/Game-ID für Dedup + Anzeige).
  async function rookhubSaveGame(cfg, moves, meta) {
    if (!cfg || !cfg.url || !cfg.token) throw new Error(t('err.urlTokenMissing'));
    const url = cfg.url.replace(/\/$/, '') + '/api/extension/games';
    const resp = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: meta.source,
        moves: moves,
        externalId: meta.externalId,
        white: meta.white,
        black: meta.black,
        result: meta.result,
        sourceUrl: meta.sourceUrl,
        playedAt: meta.playedAt,
        whiteElo: meta.whiteElo,
        blackElo: meta.blackElo,
      }),
    });
    if (resp.status === 401) throw new Error(t('err.tokenInvalid'));
    if (!resp.ok) throw new Error(t('err.rookhubHttp', { status: resp.status }));
    return resp.json().catch(() => null);
  }

  // Öffentlicher Teilen-Link der gespeicherten Partie ({url}/g/{shareToken}).
  // saved = Server-Antwort von rookhubSaveGame (SavedGameDetailDto).
  function buildShareLink(cfg, saved) {
    const token = saved && (saved.shareToken || saved.ShareToken);
    if (!cfg || !cfg.url || !token) return '';
    return cfg.url.replace(/\/$/, '') + '/g/' + token;
  }

  // Seit v1.6.0: RookHub-Modus zieht das Repertoire NICHT mehr vorab. Stattdessen
  // wird pro Review-Page ein POST /analyze-game gesendet (Game → Annotations). Hier
  // verifizieren wir nur Auth + zaehlen die Dateien, damit das Panel ein Feedback gibt.
  async function connectRookHub(cfg, options) {
    const refresh = !!(options && options.refresh);
    const result = await rookhubAnalyzeGame(cfg, [], { refresh });
    const fc = result && typeof result.repertoireFileCount === 'number' ? result.repertoireFileCount : 0;
    if (fc === 0) {
      updateStatusText(t('status.connectedNoOpenings'));
    } else {
      updateStatusText(t('status.connectedFiles', { count: fc }));
    }
    runCheck();
  }

  // ─── Repertoire Position Set ─────────────────────────────────────────
  // Transpositions: statt Zug-Sequenzen speichern wir alle erreichbaren
  // Stellungen als normalisierte FEN-Strings in einem Set. Zwei Partien,
  // die dieselbe Stellung ueber verschiedene Zugfolgen erreichen, treffen
  // auf denselben FEN-Eintrag.

  // normalizedFen: siehe Shared-Core-Region oben (aus lib/repertoire-text.js).

  function walkMovesForPositions(chess, moves, positions) {
    // Wir nutzen denselben Chess-Instanz fuer alle Varianten und stellen den
    // Stand am Ende per undo() wieder her. Ersetzt das alte `new Chess(fen())`
    // pro Variante (FEN-Serialize+Parse-Roundtrip war der Haupt-CPU-Fresser).
    let movesMade = 0;
    for (const move of moves) {
      if (move.variations && move.variations.length > 0) {
        for (const variation of move.variations) {
          walkMovesForPositions(chess, variation, positions);
        }
      }
      const result = chess.move(move.san);
      if (!result) break;
      movesMade++;
      positions.add(normalizedFen(chess.fen()));
    }
    for (let i = 0; i < movesMade; i++) chess.undo();
  }

  function buildPositionSetFromPgns(pgnTexts) {
    const positions = new Set();
    positions.add(normalizedFen(new Chess().fen()));
    for (const text of pgnTexts) {
      try {
        const games = parsePgnText(text);
        for (const moves of games) {
          walkMovesForPositions(new Chess(), moves, positions);
        }
      } catch (e) {
        console.warn('[RepertoireChecker] PGN parse error:', e);
      }
    }
    return positions;
  }

  // ─── File Loading ────────────────────────────────────────────────────
  async function pickDirectory() {
    // Chrome/Edge: use File System Access API
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        await saveHandle(dirHandle);
        await loadRepertoireFromDir();
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.error('[RepertoireChecker] Directory picker error:', e);
        }
      }
      return;
    }
    // Firefox fallback: trigger hidden file input
    pickDirectoryViaInput();
  }

  function pickDirectoryViaInput() {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.multiple = true;
    input.accept = '.pgn';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      loadRepertoireFromFiles(input.files);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  function loadRepertoireFromFiles(fileList) {
    const pgnFiles = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.pgn'));
    if (pgnFiles.length === 0) {
      updateStatusText(t('panel.noPgnFiles'));
      return;
    }

    Promise.all(pgnFiles.map(f => f.text())).then(async pgnTexts => {
      repertoirePositions = await buildAndSavePositionSet(pgnTexts);
      updateStatusText(t('panel.loadedFiles', { count: pgnTexts.length }));
      runCheck();
    });
  }

  async function loadRepertoireFromDir() {
    if (!dirHandle) return false;

    const perm = await dirHandle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      const req = await dirHandle.requestPermission({ mode: 'read' });
      if (req !== 'granted') return false;
    }

    const pgnTexts = [];
    for await (const [name, entry] of dirHandle.entries()) {
      if (entry.kind === 'file' && name.toLowerCase().endsWith('.pgn')) {
        try {
          const file = await entry.getFile();
          const text = await file.text();
          pgnTexts.push(text);
        } catch (e) {
          console.warn(`[RepertoireChecker] Could not read ${name}:`, e);
        }
      }
    }

    if (pgnTexts.length > 0) {
      repertoirePositions = await buildAndSavePositionSet(pgnTexts);
      updateStatusText(t('panel.loadedFiles', { count: pgnTexts.length }));
      runCheck();
      return true;
    } else {
      updateStatusText(t('panel.noPgnFiles'));
      return false;
    }
  }

  async function loadRepertoireFromText(pgnText) {
    if (!pgnText.trim()) return;
    repertoirePositions = await buildAndSavePositionSet([pgnText]);
    updateStatusText(t('panel.loadedText'));
    runCheck();
  }

  // ─── Site Adapter (chess.com + lichess) ─────────────────────────────
  // Jede Site exportiert dieselbe Schnittstelle: erkennt die Review-Seite,
  // liefert die Zug-Knoten der Hauptlinie und sagt, wohin das Banner soll.
  const LICHESS_FIGURINES = {
    '♔':'K','♕':'Q','♖':'R','♗':'B','♘':'N',
    '♚':'K','♛':'Q','♜':'R','♝':'B','♞':'N',
  };

  const ADAPTERS = {
    chesscom: {
      test: (host) => host === 'www.chess.com' || host.endsWith('.chess.com') || host === 'chess.com',
      isReviewPage: () => {
        const url = location.pathname;
        return url.includes('/analysis/game/') || url.includes('/game/review/');
      },
      getMoveListEl: () => document.querySelector('.move-list, vertical-move-list, wc-move-list'),
      getMoveNodes: (root) => root.querySelectorAll('.node'),
      extractSan: (node) => {
        // node.textContent enthaelt auch Text aus dem inline <style>-Block der
        // SVG-Figurinen, was sonst in den SAN gemischt wird. SVGs entfernen.
        const clone = node.cloneNode(true);
        clone.querySelectorAll('svg, style, script, defs, title').forEach(el => el.remove());
        const visibleText = clone.textContent.trim();
        const figurineEl = node.querySelector('[data-figurine]');
        const figurine = figurineEl ? figurineEl.getAttribute('data-figurine') : '';
        let san = (figurine + visibleText).trim();
        san = san.replace(/^\d+\.+\s*/, '').trim();
        if (['1-0','0-1','1/2-1/2','*'].includes(san)) return '';
        san = san.replace(/[?!]+$/, '').trim();
        return san;
      },
    },
    lichess: {
      test: (host) => host === 'lichess.org' || host.endsWith('.lichess.org'),
      isReviewPage: () => {
        if (location.pathname.startsWith('/analysis')) return true;
        // Spielseiten: /<id> oder /<id>/(white|black); ID typischerweise 8 Zeichen,
        // bei alten Spielen auch laenger.
        if (/^\/[A-Za-z0-9]{8,12}(\/(white|black))?\/?$/.test(location.pathname)) return true;
        // DOM-Fallback fuer Studies/Broadcasts, falls die Tview2 sichtbar ist.
        return !!document.querySelector('.tview2, .analyse__moves');
      },
      // Wir geben fuer Lichess das eigentliche .tview2 zurueck, damit
      // :scope > move greift (nur Hauptlinie, keine Varianten).
      getMoveListEl: () => document.querySelector('.tview2'),
      getMoveNodes: (root) => root.querySelectorAll(':scope > move'),
      extractSan: (node) => {
        // Lichess kann Figurinen-Notation (Unicode-Symbole statt KQRBN) anzeigen.
        // Mapping zurueck auf SAN-Buchstaben, sonst kann chess.js den Zug nicht
        // parsen. Eval/Glyphen/Kommentare gehoeren nicht in den SAN.
        const clone = node.cloneNode(true);
        clone.querySelectorAll('eval, glyph, comment, interrupt, lines, line').forEach(el => el.remove());
        const raw = clone.textContent.trim();
        let san = '';
        for (const ch of raw) san += LICHESS_FIGURINES[ch] || ch;
        san = san.replace(/^\d+\.+\s*/, '').trim();
        if (['1-0','0-1','1/2-1/2','*'].includes(san)) return '';
        san = san.replace(/[?!]+$/, '').trim();
        return san;
      },
    },
  };

  function getAdapter() {
    const host = location.hostname;
    for (const key of Object.keys(ADAPTERS)) {
      if (ADAPTERS[key].test(host)) return ADAPTERS[key];
    }
    return null;
  }

  function isReviewPage() {
    const a = getAdapter();
    return a ? a.isReviewPage() : false;
  }

  function getGameMoves() {
    const a = getAdapter();
    if (!a) return [];
    const root = a.getMoveListEl();
    if (!root) return [];
    const moves = [];
    for (const node of a.getMoveNodes(root)) {
      const san = a.extractSan(node);
      if (san) moves.push(san);
    }
    return moves;
  }

  function buildGamePgn() {
    const moves = getGameMoves();
    if (!moves.length) return '';
    let moveText = '';
    for (let i = 0; i < moves.length; i++) {
      if (i % 2 === 0) moveText += (Math.floor(i / 2) + 1) + '. ';
      moveText += moves[i] + ' ';
    }
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    return '[Event "?"]\n[Site "' + location.href + '"]\n[Date "' + date + '"]\n[White "?"]\n[Black "?"]\n[Result "*"]\n\n' + moveText.trimEnd() + ' *\n';
  }

  async function copyGamePgn() {
    const pgn = buildGamePgn();
    if (!pgn) return;
    try {
      await navigator.clipboard.writeText(pgn);
      const btn = document.getElementById('repcheck-copy-pgn');
      if (btn) { const t = btn.textContent; btn.textContent = '✓'; setTimeout(() => { btn.textContent = t; }, 1200); }
    } catch (e) {
      console.warn('[RepertoireChecker] Clipboard:', e);
    }
  }

  // ─── Metadaten fürs Speichern ───────────────────────────────────────
  // Ergebnis (1-0/0-1/1/2-1/2) aus der Zugliste lesen, falls vorhanden.
  function getGameResult() {
    try {
      const a = getAdapter();
      const root = a && a.getMoveListEl();
      const text = (root ? root.textContent : '') || '';
      const m = text.match(/(1-0|0-1|1\/2-1\/2|½-½)/);
      if (!m) return null;
      return m[1] === '½-½' ? '1/2-1/2' : m[1];
    } catch (e) { return null; }
  }

  // Elo/Rating plausibilisieren (100–4000); sonst null.
  function parseElo(v) {
    const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) && n >= 100 && n <= 4000 ? n : null;
  }

  // Name + optionales trailing "(Rating)" trennen (Lichess-og:title: "Name (1234)").
  function splitNameElo(raw) {
    const s = (raw || '').trim();
    const m = s.match(/^(.*?)\s*\((\d{2,4})\)\s*$/);
    if (m) return { name: m[1].trim().slice(0, 120), elo: parseElo(m[2]) };
    return { name: s.slice(0, 120), elo: null };
  }

  // Spielernamen + Ratings aus og:title / document.title ("A (1234) vs B (1456)") best-effort lesen.
  function parsePlayersFromMeta() {
    try {
      const og = document.querySelector('meta[property="og:title"]');
      const t = (og && og.content) || document.title || '';
      const m = t.match(/(.+?)\s+(?:vs\.?|–|-)\s+(.+?)(?:\s+(?:in|•|\||,)|$)/i);
      if (m) {
        const w = splitNameElo(m[1]);
        const b = splitNameElo(m[2]);
        return { white: w.name, black: b.name, whiteElo: w.elo, blackElo: b.elo };
      }
    } catch (e) {}
    return { white: null, black: null, whiteElo: null, blackElo: null };
  }

  // chessComPlayedAt: siehe Shared-Core-Region oben (aus lib/repertoire-text.js).

  // Kanonische Header (Spieler/Ergebnis/Datum) zu einer chess.com-Game-ID über
  // die same-origin-Callback-API holen — die Analyse-Seite hat sie NICHT im
  // og:title. Best-effort: bei Fehler null, dann greift der og:title-Fallback.
  async function fetchChessComHeaders(id, isDaily) {
    try {
      const kind = isDaily ? 'daily' : 'live';
      const resp = await fetch(`https://www.chess.com/callback/${kind}/game/${id}`, { headers: { 'Accept': 'application/json' } });
      if (!resp.ok) return null;
      const data = await resp.json();
      const h = data && data.game && data.game.pgnHeaders;
      if (!h) return null;
      return {
        white: h.White ? String(h.White).slice(0, 120) : null,
        black: h.Black ? String(h.Black).slice(0, 120) : null,
        result: h.Result || null,
        playedAt: chessComPlayedAt(h),
        whiteElo: parseElo(h.WhiteElo),
        blackElo: parseElo(h.BlackElo),
      };
    } catch (e) { return null; }
  }

  // Kanonische Partie-Daten (Spieler/Ergebnis/Elo/Datum + saubere SAN-Zugliste) zu einer
  // lichess-Game-ID über die same-origin Export-API holen. Zuverlässiger als der og:title
  // (Namen/Elo) UND die DOM-Zugauslese (die auf Analyse-/Study-Ansichten „…"-Lücken liefern
  // kann). Best-effort: bei Fehler null, dann greifen og:title + DOM-Züge als Fallback.
  async function fetchLichessGame(id) {
    try {
      const resp = await fetch(`https://lichess.org/game/export/${id}?clocks=false&evals=false&literate=false`,
        { headers: { 'Accept': 'application/x-chess-pgn' } });
      if (!resp.ok) return null;
      const pgn = await resp.text();
      if (!pgn || /^\s*</.test(pgn)) return null;   // HTML statt PGN → aufgeben
      const hdr = (tag) => { const m = pgn.match(new RegExp('\\[' + tag + ' "([^"]*)"\\]')); return m ? m[1] : null; };
      let result = hdr('Result');
      if (result !== '1-0' && result !== '0-1' && result !== '1/2-1/2') result = null;
      const games = (typeof parsePgnText === 'function') ? parsePgnText(pgn) : [];
      // parsePgnText liefert Zug-OBJEKTE ({san, variations}); der Save braucht SAN-Strings.
      const moves = (games && games[0] && games[0].length)
        ? games[0].map(m => (typeof m === 'string' ? m : m && m.san)).filter(Boolean)
        : null;
      return {
        white: hdr('White') ? hdr('White').slice(0, 120) : null,
        black: hdr('Black') ? hdr('Black').slice(0, 120) : null,
        result,
        whiteElo: parseElo(hdr('WhiteElo')),
        blackElo: parseElo(hdr('BlackElo')),
        playedAt: chessComPlayedAt({ Date: hdr('UTCDate'), EndTime: hdr('UTCTime') }),
        moves,
      };
    } catch (e) { return null; }
  }

  // Metadaten der aktuellen Partie (Quelle, externe ID, Spieler, Ergebnis, URL).
  // Async, weil chess.com die Spielernamen erst per Callback-API liefert.
  async function getGameMeta() {
    const site = detectSiteKey();
    const meta = {
      source: site === 'chesscom' ? 'chess.com' : 'lichess',
      externalId: null,
      result: getGameResult(),
      sourceUrl: location.href,
      white: null,
      black: null,
      playedAt: null,
      whiteElo: null,
      blackElo: null,
      moves: null,
    };
    try {
      if (site === 'lichess') {
        const m = location.pathname.match(/^\/([A-Za-z0-9]{8})/);
        if (m) meta.externalId = m[1];
      } else {
        const m = location.pathname.match(/\/(?:live|daily|game|analysis\/game\/live)\/(\d+)/)
          || location.pathname.match(/(\d{6,})/);
        if (m) meta.externalId = m[1];
      }
    } catch (e) {}
    const players = parsePlayersFromMeta();
    meta.white = players.white;
    meta.black = players.black;
    meta.whiteElo = players.whiteElo;
    meta.blackElo = players.blackElo;
    // lichess: kanonische Daten (Spieler/Ergebnis/Elo/Datum + saubere Züge) via Export-API.
    if (site === 'lichess' && meta.externalId) {
      const g = await fetchLichessGame(meta.externalId);
      if (g) {
        if (g.white) meta.white = g.white;
        if (g.black) meta.black = g.black;
        if (g.result) meta.result = g.result;
        if (g.playedAt) meta.playedAt = g.playedAt;
        if (g.whiteElo != null) meta.whiteElo = g.whiteElo;
        if (g.blackElo != null) meta.blackElo = g.blackElo;
        if (g.moves) meta.moves = g.moves;
      }
    }
    // chess.com: kanonische Header (Spieler/Ergebnis/Datum/Elo) nachziehen.
    if (site === 'chesscom' && meta.externalId) {
      const h = await fetchChessComHeaders(meta.externalId, /\/daily\//.test(location.pathname));
      if (h) {
        if (h.white) meta.white = h.white;
        if (h.black) meta.black = h.black;
        if (h.result) meta.result = h.result;
        if (h.playedAt) meta.playedAt = h.playedAt;
        if (h.whiteElo != null) meta.whiteElo = h.whiteElo;
        if (h.blackElo != null) meta.blackElo = h.blackElo;
      }
    }
    return meta;
  }

  function analyzeGame(gameMoves) {
    if (!repertoirePositions) return { deviation: -1, gaps: [] };

    const chess = new Chess();
    const inRep = [];
    for (let i = 0; i < gameMoves.length; i++) {
      const result = chess.move(gameMoves[i]);
      if (!result) { inRep.push(false); break; }
      inRep.push(repertoirePositions.has(normalizedFen(chess.fen())));
    }

    let lastIn = -1;
    for (let i = inRep.length - 1; i >= 0; i--) {
      if (inRep[i]) { lastIn = i; break; }
    }

    const gaps = [];
    const inRepertoire = [];
    let deviation = -1;
    for (let i = 0; i < inRep.length; i++) {
      if (inRep[i]) {
        inRepertoire.push(i);
      } else if (i <= lastIn) {
        gaps.push(i);
      } else if (deviation === -1) {
        deviation = i;
      }
    }
    return { deviation, gaps, inRepertoire };
  }

  // FEN nach den ersten `idx` Zuegen (also VOR Anwendung von gameMoves[idx]).
  // Wird fuer die Chessable-Suche genutzt: zeigt die Position, aus der heraus
  // der erste Out-of-Rep-Zug gespielt wurde.
  function fenBeforeMove(gameMoves, idx) {
    const chess = new Chess();
    for (let i = 0; i < idx && i < gameMoves.length; i++) {
      if (!chess.move(gameMoves[i])) break;
    }
    return chess.fen();
  }

  // chessableSearchUrl: siehe Shared-Core-Region oben (aus lib/repertoire-text.js).

  // ─── UI ─────────────────────────────────────────────────────────────
  // Styles der Deviation-Marker + des Settings-Panels + der Floating-Buttons.
  // Als Konstante ausgelagert (statt inline in injectStyles).
  const STYLE_CSS = `
      .${DEVIATION_CLASS} {
        background-color: rgba(255, 120, 50, 0.20) !important;
        border-radius: 2px;
      }
      .${GAP_CLASS} {
        background-color: rgba(255, 210, 50, 0.14) !important;
        border-radius: 2px;
      }
      .${IN_REP_CLASS} {
        background-color: rgba(46, 204, 113, 0.10) !important;
        border-radius: 2px;
      }
      #${BANNER_ID} {
        width: 36px; height: 36px;
        padding: 0;
        border: 1px solid rgba(255,255,255,0.10);
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        font-size: 16px;
        border-radius: 6px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.30);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: rgba(28,28,28,0.92);
        color: #d8d8d8;
      }
      #${BANNER_ID}.deviation {
        background: rgba(120, 50, 28, 0.92);
        color: #fbe2d4;
      }
      #${BANNER_ID}.in-repertoire {
        background: rgba(28, 70, 46, 0.92);
        color: #cfe9d6;
      }
      #${BANNER_ID}.no-repertoire {
        background: rgba(28,28,28,0.92);
        color: #a8a8a8;
      }
      #${PANEL_ID} {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 10000;
        background: #2b2b2b;
        color: #e0e0e0;
        border: 1px solid #555;
        border-radius: 8px;
        padding: 20px;
        width: 420px;
        max-height: 80vh;
        overflow-y: auto;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
      }
      #${PANEL_ID} h3 {
        margin: 0 0 12px 0;
        font-size: 16px;
        color: #fff;
      }
      #${PANEL_ID} button {
        background: #4a9eff;
        color: #fff;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        margin: 4px 4px 4px 0;
      }
      #${PANEL_ID} button:hover {
        background: #3a8eef;
      }
      #${PANEL_ID} button.secondary {
        background: #555;
      }
      #${PANEL_ID} button.secondary:hover {
        background: #666;
      }
      #${PANEL_ID} textarea {
        width: 100%;
        height: 150px;
        background: #1a1a1a;
        color: #e0e0e0;
        border: 1px solid #555;
        border-radius: 4px;
        padding: 8px;
        font-family: monospace;
        font-size: 12px;
        resize: vertical;
        box-sizing: border-box;
      }
      #${PANEL_ID} .status {
        font-size: 12px;
        color: #aaa;
        margin-top: 8px;
      }
      #repcheck-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5);
        z-index: 9999;
      }
      #repcheck-floating-wrap {
        position: fixed;
        bottom: 60px;
        right: 16px;
        z-index: 9998;
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: flex-end;
      }
      #repcheck-floating, #repcheck-chessable, #repcheck-copy-pgn, #repcheck-save-game {
        width: 36px; height: 36px;
        padding: 0;
        cursor: pointer;
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 6px;
        display: flex; align-items: center; justify-content: center;
        font-size: 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 2px 6px rgba(0,0,0,0.30);
        color: #d8d8d8;
        background: rgba(36,36,36,0.92);
      }
      #repcheck-floating:hover, #repcheck-chessable:hover, #repcheck-copy-pgn:hover, #repcheck-save-game:hover { background: rgba(56,56,56,0.95); }
      #repcheck-floating:active, #repcheck-chessable:active, #repcheck-copy-pgn:active, #repcheck-save-game:active { background: rgba(24,24,24,0.95); }
      /* Light-Theme-Variante: helle Pille mit dunklem Text. Wird ueber
         data-theme="light" am Floating-Wrap aktiviert (detectSiteTheme()). */
      #repcheck-floating-wrap[data-theme="light"] #${BANNER_ID} {
        background: rgba(255,255,255,0.96); color: #2a2a2a;
        box-shadow: 0 2px 6px rgba(0,0,0,0.15);
      }
      #repcheck-floating-wrap[data-theme="light"] #${BANNER_ID}.deviation {
        background: rgba(255, 235, 222, 0.96); color: #8a2e10;
      }
      #repcheck-floating-wrap[data-theme="light"] #${BANNER_ID}.in-repertoire {
        background: rgba(220, 240, 226, 0.96); color: #1f5230;
      }
      #repcheck-floating-wrap[data-theme="light"] #${BANNER_ID}.no-repertoire {
        background: rgba(248,248,248,0.96); color: #6a6a6a;
      }
      #repcheck-floating-wrap[data-theme="light"] #repcheck-floating,
      #repcheck-floating-wrap[data-theme="light"] #repcheck-chessable,
      #repcheck-floating-wrap[data-theme="light"] #repcheck-copy-pgn,
      #repcheck-floating-wrap[data-theme="light"] #repcheck-save-game {
        background: rgba(255,255,255,0.96); color: #2a2a2a;
        border-color: rgba(0,0,0,0.10);
        box-shadow: 0 2px 6px rgba(0,0,0,0.15);
      }
      #repcheck-floating-wrap[data-theme="light"] #repcheck-floating:hover,
      #repcheck-floating-wrap[data-theme="light"] #repcheck-chessable:hover,
      #repcheck-floating-wrap[data-theme="light"] #repcheck-copy-pgn:hover,
      #repcheck-floating-wrap[data-theme="light"] #repcheck-save-game:hover {
        background: rgba(238,238,238,0.98);
      }
      /* Seit v1.14.0: KEINE site-spezifischen Button-Farben mehr — chess.com
         und Lichess teilen sich dasselbe dezente Dark/Light-Styling oben.
         (Das ⚙-Status-/Settings-Quadrat bleibt im Userscript erhalten, nutzt
         aber dieselbe dezente Optik wie die übrigen Buttons.) */
    `;

  function injectStyles() {
    if (document.getElementById('repcheck-styles')) return;
    const style = document.createElement('style');
    style.id = 'repcheck-styles';
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
  }

  // Light- vs Dark-Theme der jeweiligen Site grob erkennen, damit die Pille
  // auf chess.com (oft Light) nicht als dunkler Block aufpoppt, sondern sich
  // dem Theme anpasst. Heuristik: Luminanz des <body>-Backgrounds.
  function detectSiteTheme() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = bg && bg.match(/\d+/g);
      if (!m || m.length < 3) return 'dark';
      const lum = (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]);
      return lum > 150 ? 'light' : 'dark';
    } catch (e) { return 'dark'; }
  }

  function detectSiteKey() {
    const host = location.hostname;
    for (const key of Object.keys(ADAPTERS)) {
      if (ADAPTERS[key].test(host)) return key;
    }
    return '';
  }

  function ensureFloatingWrap() {
    if (!document.body) return null;
    let wrap = document.getElementById('repcheck-floating-wrap');
    if (!wrap) {
      injectStyles();
      wrap = document.createElement('div');
      wrap.id = 'repcheck-floating-wrap';
      document.body.appendChild(wrap);
    }
    // Theme- und Site-Attribute bei jedem Ensure neu setzen — User kann
    // mittendrin Theme wechseln (Lichess + chess.com erlauben das beide).
    wrap.dataset.theme = detectSiteTheme();
    wrap.dataset.site = detectSiteKey();
    return wrap;
  }

  function injectFloatingButton() {
    const wrap = ensureFloatingWrap();
    if (!wrap) return;
    if (document.getElementById('repcheck-floating')) return;
    const btn = document.createElement('button');
    btn.id = 'repcheck-floating';
    btn.type = 'button';
    btn.textContent = '♟';
    btn.title = t('tools.check');
    btn.addEventListener('click', runCheckTrigger);
    wrap.appendChild(btn);
  }

  // Chessable-Button: nur sichtbar wenn eine Abweichung erkannt wurde.
  // Klick oeffnet Chessable mit der FEN VOR dem Out-of-Rep-Zug.
  function syncChessableButton() {
    const wrap = document.getElementById('repcheck-floating-wrap');
    let btn = document.getElementById('repcheck-chessable');
    if (!lastDeviationFen) {
      btn?.remove();
      return;
    }
    if (!wrap) return;
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'repcheck-chessable';
      btn.type = 'button';
      btn.textContent = '🔎';
      btn.title = t('tools.searchFen');
      btn.addEventListener('click', () => {
        if (!lastDeviationFen) return;
        window.open(chessableSearchUrl(lastDeviationFen), '_blank', 'noopener,noreferrer');
      });
      wrap.insertBefore(btn, wrap.firstChild);
    }
  }

  function injectCopyButton() {
    const wrap = ensureFloatingWrap();
    if (!wrap || document.getElementById('repcheck-copy-pgn')) return;
    const btn = document.createElement('button');
    btn.id = 'repcheck-copy-pgn';
    btn.type = 'button';
    btn.textContent = '📋';
    btn.title = t('tools.copyPgn');
    btn.addEventListener('click', copyGamePgn);
    wrap.appendChild(btn);
  }

  async function syncSaveButton() {
    const wrap = document.getElementById('repcheck-floating-wrap');
    if (!wrap) return;
    const existing = document.getElementById('repcheck-save-game');
    const cfg = await loadRookhubConfig().catch(() => null);
    if (!cfg || !cfg.url || !cfg.token) { existing?.remove(); return; }
    if (existing) return;
    const btn = document.createElement('button');
    btn.id = 'repcheck-save-game';
    btn.type = 'button';
    btn.textContent = '💾';
    btn.title = t('tools.saveGame');
    btn.addEventListener('click', async () => {
      const currentCfg = await loadRookhubConfig().catch(() => null);
      if (!currentCfg) return;
      const domMoves = getGameMoves();
      if (!domMoves.length) return;
      btn.textContent = '…';
      btn.disabled = true;
      const reset = () => setTimeout(() => {
        btn.textContent = '💾'; btn.title = t('tools.saveGame'); btn.disabled = false;
      }, 1500);
      try {
        const meta = await getGameMeta();
        // Kanonische Zugliste (lichess-Export) bevorzugen, sonst DOM-Auslese.
        const moves = (meta.moves && meta.moves.length) ? meta.moves : domMoves;
        const saved = await rookhubSaveGame(currentCfg, moves, meta);
        const link = buildShareLink(currentCfg, saved);
        let copied = false;
        if (link) {
          try {
            if (typeof GM_setClipboard !== 'undefined') { GM_setClipboard(link, { type: 'text', mimetype: 'text/plain' }); copied = true; }
            else if (navigator.clipboard) { await navigator.clipboard.writeText(link); copied = true; }
          } catch (e) { /* Clipboard evtl. blockiert */ }
        }
        btn.textContent = copied ? '🔗' : '✓';
        btn.title = copied ? t('tools.savedWithLink') : t('tools.saved');
        reset();
      } catch (e) {
        btn.textContent = '✗';
        reset();
        console.warn('[RepertoireChecker] Save failed:', e);
      }
    });
    wrap.appendChild(btn);
  }

  function removeFloatingControls() {
    document.getElementById('repcheck-floating-wrap')?.remove();
  }

  function refreshFloatingButton() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastDeviationFen = null;
      lastGameMovesKey = '';
    }
    if (isReviewPage()) {
      injectFloatingButton();
      syncChessableButton();
      injectCopyButton();
      syncSaveButton();
    } else {
      removeFloatingControls();
    }
  }

  function updateStatusText(text) {
    const el = document.getElementById('repcheck-status');
    if (el) el.textContent = text;
  }

  function showBanner(message, type) {
    // Seit v1.6.4: Banner ist ein Icon-Only-Quadrat (⚙) im Floating-Wrap;
    // Statusfarbe codiert deviation/in-rep/no-rep, der Tooltip (title) zeigt
    // den vollen Text. Klick oeffnet das Settings-Panel.
    const wrap = ensureFloatingWrap();
    if (!wrap) return;
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('button');
      banner.id = BANNER_ID;
      banner.type = 'button';
      banner.textContent = '⚙';
      banner.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanel();
      });
    }
    // Banner immer oben im Wrap (vor Chessable-/Pruefen-Button).
    if (banner.parentElement !== wrap || wrap.firstChild !== banner) {
      wrap.insertBefore(banner, wrap.firstChild);
    }
    wrap.dataset.theme = detectSiteTheme();
    wrap.dataset.site = detectSiteKey();
    banner.title = message;
    banner.className = type;
  }

  function highlightDeviation(index, gaps, inRepertoire) {
    document.querySelectorAll(`.${DEVIATION_CLASS}`).forEach(el => el.classList.remove(DEVIATION_CLASS));
    document.querySelectorAll(`.${GAP_CLASS}`).forEach(el => el.classList.remove(GAP_CLASS));
    document.querySelectorAll(`.${IN_REP_CLASS}`).forEach(el => el.classList.remove(IN_REP_CLASS));

    const a = getAdapter();
    if (!a) return;
    const moveList = a.getMoveListEl();
    if (!moveList) return;
    const nodes = a.getMoveNodes(moveList);

    if (inRepertoire) {
      for (const ri of inRepertoire) {
        if (ri < nodes.length) nodes[ri].classList.add(IN_REP_CLASS);
      }
    }
    if (gaps) {
      for (const gi of gaps) {
        if (gi < nodes.length) nodes[gi].classList.add(GAP_CLASS);
      }
    }
    if (index >= 0 && index < nodes.length) {
      nodes[index].classList.add(DEVIATION_CLASS);
      nodes[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // Panel-Markup (reiner String, keine DOM-Nebenwirkungen).
  function panelHtml() {
    const host = ROOKHUB_DEFAULT_URL.replace(/^https?:\/\//, '');
    return `
      <h3>${rcEscHtml(t('panel.heading'))}</h3>
      <div style="margin-bottom: 12px;">
        <strong>${rcEscHtml(t('panel.rookhub'))}</strong><br>
        <input id="repcheck-rookhub-url" placeholder="https://rookhub.example.com" />
        <input id="repcheck-rookhub-token" placeholder="rkh_…" type="password" />
        <div style="margin-top:6px;">
          <button id="repcheck-rookhub-connect">${rcEscHtml(t('panel.connect'))}</button>
          <button id="repcheck-rookhub-refresh" class="secondary">${rcEscHtml(t('panel.refresh'))}</button>
        </div>
        <span style="font-size:11px;color:#888;">
          ${rcEscHtml(t('panel.noAccount'))}<a href="${ROOKHUB_DEFAULT_URL}/register" target="_blank" rel="noopener" style="color:#4a9eff;">${rcEscHtml(t('panel.register', { host }))}</a>${rcEscHtml(t('panel.tokenHint'))}
        </span>
      </div>
      <hr style="border-color:#444;margin:12px 0;">
      <div style="margin-bottom: 12px;">
        <strong>${rcEscHtml(t('panel.folder'))}</strong><br>
        <button id="repcheck-pick-dir">${rcEscHtml(t('panel.selectFolder'))}</button>
        <span id="repcheck-folder-info" style="font-size:12px;color:#888;margin-left:6px;">${rcEscHtml(repertoirePositions ? t('panel.folderLoaded') : t('panel.noFolder'))}</span>
      </div>
      <hr style="border-color:#444;margin:12px 0;">
      <div>
        <strong>${rcEscHtml(t('panel.paste'))}</strong><br>
        <textarea id="repcheck-pgn-input" placeholder="${rcEscHtml(t('panel.pastePlaceholder'))}"></textarea>
        <button id="repcheck-load-pgn">${rcEscHtml(t('panel.loadPgn'))}</button>
        <button id="repcheck-close" class="secondary">${rcEscHtml(t('panel.close'))}</button>
      </div>
      <hr style="border-color:#444;margin:12px 0;">
      <div>
        <label style="font-size:12px;color:#bbb;">${rcEscHtml(t('lang.label'))}
          <select id="repcheck-lang" style="margin-left:6px;">
            <option value="">${rcEscHtml(t('lang.auto', { lang: rcAutoLang() }))}</option>
            <option value="en">English</option>
            <option value="de">Deutsch</option>
            <option value="hr">Hrvatski</option>
          </select>
        </label>
      </div>
      <div class="status" id="repcheck-status">
        ${rcEscHtml(repertoirePositions ? t('panel.loaded') : t('panel.notLoaded'))}
      </div>
    `;
  }

  // RookHub-Felder vorbefuellen (async) + alle Panel-Buttons verdrahten.
  function wirePanelEvents() {
    // Sprachwahl: leerer Wert = Automatik. Der Wert wird GELÖSCHT statt als '' gespeichert,
    // damit die Browsersprache wieder greift.
    const langSel = document.getElementById('repcheck-lang');
    if (langSel) {
      langSel.value = rcGespeicherteSprache || '';
      langSel.addEventListener('change', () => {
        const wahl = langSel.value;
        rcGespeicherteSprache = wahl;
        try { GM_setValue('rcLang', wahl); } catch (e) { /* GM nicht verfügbar */ }
        rcLang = rcResolveLang(wahl || null, navigator.languages);
        rcApplyLang();
      });
    }

    // Config laden; ohne vorhandene mit der Default-Instanz vorbelegen, damit
    // Neu-User nicht erst eine URL suchen muessen.
    loadRookhubConfig().then(cfg => {
      const urlInput = document.getElementById('repcheck-rookhub-url');
      const tokenInput = document.getElementById('repcheck-rookhub-token');
      if (urlInput) urlInput.value = (cfg && cfg.url) || ROOKHUB_DEFAULT_URL;
      // Der gespeicherte Token wird bewusst NICHT vorbefuellt: das Panel haengt im
      // DOM der Seite, jedes Seiten-Skript koennte den Klartext aus dem Input lesen.
      // Stattdessen zeigt der Platzhalter an, dass einer hinterlegt ist; leer
      // absenden = gespeicherten Token weiterverwenden (s. Connect-Handler).
      if (cfg && cfg.token && tokenInput) tokenInput.placeholder = t('panel.tokenSaved');
    }).catch(() => {
      const urlInput = document.getElementById('repcheck-rookhub-url');
      if (urlInput && !urlInput.value) urlInput.value = ROOKHUB_DEFAULT_URL;
    });

    document.getElementById('repcheck-pick-dir')?.addEventListener('click', async () => {
      await pickDirectory();
    });

    document.getElementById('repcheck-load-pgn').addEventListener('click', () => {
      const textarea = document.getElementById('repcheck-pgn-input');
      loadRepertoireFromText(textarea.value);
    });

    document.getElementById('repcheck-close').addEventListener('click', togglePanel);

    document.getElementById('repcheck-rookhub-connect')?.addEventListener('click', async () => {
      const url = (document.getElementById('repcheck-rookhub-url').value || '').trim();
      const typed = (document.getElementById('repcheck-rookhub-token').value || '').trim();
      // Leeres Feld = gespeicherten Token beibehalten (er wird aus Sicherheitsgruenden
      // nicht mehr ins Input vorbefuellt, s. Vorbefuellung oben).
      const saved = typed ? null : await loadRookhubConfig().catch(() => null);
      const token = typed || ((saved && saved.token) || '');
      if (!url || !token) { updateStatusText(t('status.needUrlToken')); return; }
      try {
        await saveRookhubConfig({ url, token });
        updateStatusText(t('status.connecting'));
        await connectRookHub({ url, token });
      } catch (e) {
        updateStatusText(t('status.error', { error: e.message }));
      }
    });

    document.getElementById('repcheck-rookhub-refresh')?.addEventListener('click', async () => {
      const cfg = await loadRookhubConfig();
      if (!cfg) { updateStatusText(t('status.notConfigured')); return; }
      try {
        updateStatusText(t('status.refreshing'));
        await connectRookHub(cfg, { refresh: true });
        // Lokales Set wird nicht mehr genutzt, sobald RookHub konfiguriert ist.
        lastGameMovesKey = '';
      } catch (e) {
        updateStatusText(t('status.error', { error: e.message }));
      }
    });
  }

  function togglePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      existing.remove();
      document.getElementById('repcheck-overlay')?.remove();
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'repcheck-overlay';
    overlay.addEventListener('click', togglePanel);
    document.body.appendChild(overlay);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = panelHtml();
    document.body.appendChild(panel);

    wirePanelEvents();
  }

  // ─── Main Check Logic ───────────────────────────────────────────────
  // Source-Priority: RookHub-Config vorhanden → Server-seitige Analyse (POST analyze-game).
  // Sonst lokales Position-Set (Folder/PGN-Paste). Bei RookHub-Fehler fallback aufs
  // lokale Set, falls vorhanden (Offline-Modus).
  function renderAnalysis(gameMoves, analysis) {
    const deviationIdx = analysis.deviation;
    const gaps = analysis.gaps || [];
    const inRepertoire = analysis.inRepertoire || [];
    currentDeviationIndex = deviationIdx;
    lastDeviationFen = analysis.fenBeforeDeviation
      || (deviationIdx >= 0 ? fenBeforeMove(gameMoves, deviationIdx) : null);

    if (deviationIdx >= 0) {
      const moveNum = Math.floor(deviationIdx / 2) + 1;
      const color = deviationIdx % 2 === 0 ? t('check.white') : t('check.black');
      // Mit und ohne Zugumstellungs-Anhang sind ZWEI Meldungen, kein zusammengesetzter Satz:
      // in anderen Sprachen sitzt der Zusatz nicht zwingend am Satzende.
      const san = gameMoves[deviationIdx];
      showBanner(gaps.length > 0
        ? t('check.outOfRepWithGaps', { move: moveNum, color, san, gaps: t('check.transpositions', { count: gaps.length }) })
        : t('check.outOfRep', { move: moveNum, color, san }), 'deviation');
      highlightDeviation(deviationIdx, gaps, inRepertoire);
    } else if (gaps.length > 0) {
      showBanner(t('check.inRepWithGaps', { gaps: t('check.transpositions', { count: gaps.length }) }), 'in-repertoire');
      highlightDeviation(-1, gaps, inRepertoire);
    } else {
      showBanner(t('check.fullyInRep'), 'in-repertoire');
      highlightDeviation(-1, [], inRepertoire);
    }
    syncChessableButton();
    syncSaveButton();
  }

  async function runCheck() {
    if (!isReviewPage()) return;
    const gameMoves = getGameMoves();
    if (gameMoves.length === 0) {
      showBanner(t('check.noMoves'), 'no-repertoire');
      return;
    }
    const key = gameMoves.join('\x00');
    if (key === lastGameMovesKey) return;
    lastGameMovesKey = key;

    const cfg = await loadRookhubConfig().catch(() => null);
    if (cfg && cfg.url && cfg.token) {
      try {
        const analysis = await rookhubAnalyzeGame(cfg, gameMoves);
        renderAnalysis(gameMoves, analysis);
        return;
      } catch (e) {
        console.warn('[RepertoireChecker] RookHub analyze failed:', e);
        if (!repertoirePositions) {
          showBanner(t('status.error', { error: e.message }), 'no-repertoire');
          return;
        }
        // Fallback aufs lokale Set (Offline / Cache aus frueherer Session).
      }
    }

    if (!repertoirePositions) {
      showBanner(t('check.noRepertoire'), 'no-repertoire');
      return;
    }
    renderAnalysis(gameMoves, analyzeGame(gameMoves));
  }

  // ─── Lazy bootstrap (nur bei Klick) ─────────────────────────────────
  // Seit v1.4.8: keine Auto-Initialisierung beim Page-Load. Userscript
  // registriert nur GM-Menu-Eintraege; die echte Arbeit (IDB lesen,
  // Styles injecten, Check) passiert erst beim Klick.
  let bootstrapped = false;
  async function ensureBootstrapped() {
    if (bootstrapped) return;
    bootstrapped = true;
    injectStyles();

    try {
      const cached = await loadPositionSetCache();
      if (cached && Array.isArray(cached.fens) && cached.fens.length > 0) {
        repertoirePositions = new Set(cached.fens);
        return;
      }
    } catch (e) {
      console.log('[RepertoireChecker] Position-Cache nicht lesbar:', e);
    }
    // Migration aus altem pgnTexts-Cache, falls noch vorhanden.
    try {
      const rh = await loadRookhubCache();
      if (rh && Array.isArray(rh.pgnTexts) && rh.pgnTexts.length > 0) {
        repertoirePositions = await buildAndSavePositionSet(rh.pgnTexts);
        return;
      }
    } catch (e) {
      console.log('[RepertoireChecker] RookHub-PGN-Cache nicht lesbar:', e);
    }
    // Folder-Handle als letzter Fallback.
    try {
      dirHandle = await loadHandle();
      if (dirHandle) {
        await loadRepertoireFromDir();
      }
    } catch (e) {
      console.log('[RepertoireChecker] No saved directory handle:', e);
    }
  }

  async function runCheckTrigger() {
    await ensureBootstrapped();
    lastGameMovesKey = '';
    runCheck();
  }

  async function openSettingsTrigger() {
    await ensureBootstrapped();
    if (!document.getElementById(PANEL_ID)) togglePanel();
  }

  // ─── Chessable-Modus ────────────────────────────────────────────────
  // Auf chessable.com laeuft KEINE Repertoire-Logik, sondern:
  //  1) FEN-Tools (Copy/Search-Buttons + XP-Anzeige) via initChessableFenTools
  //  2) Token-Auslese per TM-Menue (Weitergabe an piratechess).
  // Der API-Token liegt im localStorage unter `chessable.web.production.JWT`
  // und verlaesst den Browser nicht.
  if (/(^|\.)chessable\.com$/i.test(location.hostname)) {
    const CHESSABLE_LS_KEY = 'chessable.web.production.JWT';
    const extractChessableJwt = (raw) => {
      if (typeof raw !== 'string') return null;
      let v = raw.trim();
      if (!v) return null;
      if (v[0] === '"' || v[0] === '{') {
        try {
          const parsed = JSON.parse(v);
          if (typeof parsed === 'string') v = parsed;
          else if (parsed && typeof parsed === 'object') {
            v = parsed.token || parsed.jwt || parsed.accessToken || parsed.access_token || '';
          }
        } catch (e) { /* kein JSON — Rohwert behalten */ }
      }
      v = String(v).trim();
      return v || null;
    };
    if (typeof GM_registerMenuCommand !== 'undefined') {
      GM_registerMenuCommand(t('menu.copyChessableToken'), () => {
        let token = null;
        try { token = extractChessableJwt(localStorage.getItem(CHESSABLE_LS_KEY)); } catch (e) {}
        if (!token) {
          alert(t('menu.noChessableToken'));
          return;
        }
        if (typeof GM_setClipboard !== 'undefined') {
          GM_setClipboard(token, { type: 'text', mimetype: 'text/plain' });
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(token);
        }
        alert(t('menu.chessableTokenCopied'));
      });
    }
    // Autoritativer Kursname über den Chessable-Bearer (localStorage-JWT → getHomeData);
    // geteilt zwischen FEN-Tools („Remember line") und Aktivitaets-Tracking.
    const courseNameApi = createChessableCourseNameApi(CHESSABLE_LS_KEY, extractChessableJwt);
    initChessableFenTools(courseNameApi);
    initChessableActivityTracking(courseNameApi);
    initChessableBrowserImport(courseNameApi, CHESSABLE_LS_KEY, extractChessableJwt);
    console.log('[RepertoireChecker] Chessable-Modus aktiv (FEN-Tools + Aktivitaet + Token + Import)');
    return;
  }

  // Browser-Kurs-Import (Pendant zu extension/chessable-capture.js + dem Import-Teil von
  // chessable-activity.js): V1 = passiver Mitschnitt der Chessable-Kurs-API beim Training,
  // V2 = aktives Holen des ganzen Kurses (getCourse→getList→getGame). Der Browser holt die Daten
  // als echte eingeloggte Session (passiert Cloudflare) und schickt das ROHE JSON an RookHub
  // (POST /api/extension/chessable/ingest); der fetch-freie piratechess-Parser macht daraus PGN.
  // Im Userscript alles im Page-Kontext: fetch/XHR direkt patchbar, Egress via direktem fetch
  // (RookHub-ExtensionPolicy erlaubt chessable.com). Kein MAIN/isoliert-Split noetig.
  function initChessableBrowserImport(courseNameApi, lsKey, extractJwt) {
    // --- reine Helfer (Spiegel von extension/lib/chessable-crawl.js) ---
    function classifyApi(url) {
      let u; try { u = new URL(url, 'https://www.chessable.com'); } catch (e) { return null; }
      if (!/(^|\.)chessable\.com$/i.test(u.hostname)) return null;
      const p = u.pathname.replace(/\/+$/, '');
      if (p.endsWith('/api/v1/getCourse')) return { kind: 'course', bid: u.searchParams.get('bid') };
      if (p.endsWith('/api/v1/getList')) return { kind: 'list', bid: u.searchParams.get('bid'), lid: u.searchParams.get('lid') };
      if (p.endsWith('/api/v1/getGame')) return { kind: 'game', oid: u.searchParams.get('oid') };
      if (p.endsWith('/api/v1/getReview')) return { kind: 'review', bid: u.searchParams.get('bid'), oid: u.searchParams.get('oid') };
      return null;
    }
    function parseChapterLids(t) { let o; try { o = typeof t === 'string' ? JSON.parse(t) : t; } catch (e) { return []; } const a = o && (o.course || o.Course) && ((o.course || o.Course).data || (o.course || o.Course).Data); return Array.isArray(a) ? a.map(c => c && (c.id != null ? c.id : c.Id)).filter(v => v != null).map(String) : []; }
    function parseLineOids(t) { let o; try { o = typeof t === 'string' ? JSON.parse(t) : t; } catch (e) { return []; } const l = o && (o.list || o.List); const a = l && (l.data || l.Data); return Array.isArray(a) ? a.map(x => x && (x.id != null ? x.id : x.Id)).filter(v => v != null).map(String) : []; }
    function buildIngestChapters(chapters) {
      const out = [];
      for (const ch of (chapters || [])) {
        if (!ch || typeof ch.listText !== 'string') continue;
        const lines = [];
        for (const oid of parseLineOids(ch.listText)) {
          const g = ch.games && ch.games[oid];
          if (typeof g === 'string' && g.trim() && g.trim() !== '{}') lines.push(g);
        }
        if (lines.length) out.push({ chapterJson: ch.listText, lines });
      }
      return out;
    }
    // Kapitel→oids aus getCourse?includeVariations (Spiegel von lib/chessable-crawl.js).
    function parseCourseVariations(t) {
      let o; try { o = typeof t === 'string' ? JSON.parse(t) : t; } catch (e) { return { chapters: [], allOids: [] }; }
      const course = o && (o.course || o.Course); const data = course && (course.data || course.Data);
      const chapters = []; const allOids = [];
      if (Array.isArray(data)) for (const c of data) {
        const lid = c && (c.id != null ? c.id : c.Id);
        const vars = c && (c.variations || c.Variations);
        const oids = Array.isArray(vars) ? vars.map(v => v && (v.oid != null ? v.oid : v.Oid)).filter(x => x != null).map(String) : [];
        chapters.push({ lid: lid != null ? String(lid) : null, oids });
        for (const x of oids) allOids.push(x);
      }
      return { chapters, allOids };
    }
    function progressCounts(chapters, importedOids) {
      const set = importedOids instanceof Set ? importedOids : new Set(importedOids || []);
      const perChapter = (chapters || []).map(ch => ({ lid: ch.lid, total: ch.oids.length, done: ch.oids.reduce((n, o) => n + (set.has(String(o)) ? 1 : 0), 0) }));
      return { total: perChapter.reduce((n, c) => n + c.total, 0), done: perChapter.reduce((n, c) => n + c.done, 0), perChapter };
    }

    // --- Config/Token/Kurs-ID ---
    function getCfg() { try { if (typeof GM_getValue !== 'undefined') return GM_getValue('rookhubConfig', null); } catch (e) {} return null; }

    // ===== „Schwierige Züge" ernten (Spiegel von extension/chessable-activity.js) =====
    // getList: nHard je Linie; getGame: problemMoves.thisUser + lastReviewed. Batch + Dedupe,
    // Egress direkter fetch (RookHub-ExtensionPolicy erlaubt chessable.com).
    const problemPending = new Map(); const problemSent = new Map();
    let problemFlushTimer = null;
    function queueProblemEntry(bid, entry) {
      if (!bid || !entry || !entry.oid) return;
      const key = bid + '|' + entry.oid;
      const prev = problemPending.get(key);
      const merged = prev ? Object.assign({}, prev.entry, entry) : entry;
      if (problemSent.get(key) === JSON.stringify(merged)) return;
      problemPending.set(key, { bid, entry: merged });
      if (!problemFlushTimer) problemFlushTimer = setTimeout(flushProblemMoves, 15000);
    }
    function flushProblemMoves() {
      problemFlushTimer = null;
      if (!problemPending.size) return;
      const cfg = getCfg();
      if (!cfg || !cfg.url || !cfg.token) { problemPending.clear(); return; }
      const byBid = new Map();
      for (const [key, v] of problemPending) {
        if (!byBid.has(v.bid)) byBid.set(v.bid, []);
        const bucket = byBid.get(v.bid);
        if (bucket.length < 400) { bucket.push([key, v.entry]); problemPending.delete(key); }
      }
      for (const [bid, items] of byBid) {
        fetch(String(cfg.url).replace(/\/$/, '') + '/api/extension/chessable/problem-moves', {
          method: 'POST', mode: 'cors',
          headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ bid, entries: items.map(([, e]) => e) }),
        }).then(r => { if (r.ok) for (const [key, e] of items) problemSent.set(key, JSON.stringify(e)); }).catch(() => {});
      }
      if (problemPending.size && !problemFlushTimer) problemFlushTimer = setTimeout(flushProblemMoves, 15000);
    }
    function harvestFromList(bid, body) {
      let o; try { o = JSON.parse(body); } catch (e) { return; }
      const l = o && (o.list || o.List); const data = l && (l.data || l.Data);
      if (!Array.isArray(data)) return;
      for (const item of data) {
        const oid = item && item.id != null ? String(item.id) : null;
        if (!oid || typeof item.nHard !== 'number') continue;
        queueProblemEntry(bid, { oid, nHard: item.nHard });
      }
    }
    function harvestFromGame(bid, oid, body) {
      let o; try { o = JSON.parse(body); } catch (e) { return; }
      const g = o && (o.game || o.Game);
      if (!g || !oid) return;
      let tu = g.problemMoves && g.problemMoves.thisUser;
      if (!tu || Array.isArray(tu)) tu = {};   // leeres Array = keine Fehlzüge → {} (löscht alte)
      const entry = { oid: String(oid), problemMoves: tu };
      if (typeof g.lastReviewed === 'string') entry.lastReviewed = g.lastReviewed.slice(0, 40);
      queueProblemEntry(bid, entry);
    }
    // ===== getReview-Linien ernten (Spiegel von extension/chessable-activity.js) =====
    // getReview = Trainings-Endpoint (volle Zugfolge + Alternativen + Kommentare + Pfeile). Rohes JSON
    // parallel zu getGame an RookHub (POST /api/extension/chessable/review-lines) → dort Lücken-Füller
    // (getGame gewinnt, sonst füllt getReview → Kurs vervollständigt sich beim Durchtrainieren).
    // Session-Dedupe + Batch; best-effort (kein Re-Queue).
    const DEFAULT_ROOKHUB_URL = 'https://rookhub.oberschmid.homes';
    const reviewPending = new Map(); const reviewSent = new Set();
    let reviewFlushTimer = null;
    const REVIEW_JSON_MAX = 512 * 1024;
    const REVIEW_PENDING_MAX = 500;   // Puffer-Deckel: bei ausstehender Zustimmung nicht unbegrenzt anhäufen
    // Zustimmung zum token-losen Versand: 'granted' | 'denied' | null (ungefragt).
    function getReviewConsent() { try { return (typeof GM_getValue !== 'undefined' ? GM_getValue('rcReviewConsent', null) : null) || null; } catch (e) { return null; } }
    function setReviewConsent(v) { try { if (typeof GM_setValue !== 'undefined') GM_setValue('rcReviewConsent', v); } catch (e) {} }
    let consentPromptShown = false;
    function showReviewConsentPrompt(targetUrl) {
      if (consentPromptShown || typeof document === 'undefined' || !document.body) return;
      consentPromptShown = true;
      let host; try { host = new URL(targetUrl).host; } catch (e) { host = String(targetUrl); }
      const bar = document.createElement('div');
      bar.id = 'repcheck-review-consent';
      Object.assign(bar.style, { position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483647', maxWidth: '360px', background: '#1e1e24', color: '#fff', padding: '14px 16px', borderRadius: '10px', boxShadow: '0 4px 24px rgba(0,0,0,.4)', font: '13px/1.45 system-ui, sans-serif' });
      const msg = document.createElement('div'); msg.textContent = t('review.consent.body', { host }); msg.style.marginBottom = '10px';
      const row = document.createElement('div'); Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
      const mkBtn = (label, bg, fg, bordered) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; Object.assign(b.style, { background: bg, color: fg, border: bordered ? '1px solid #555' : 'none', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer', font: 'inherit' }); return b; };
      const no = mkBtn(t('review.consent.deny'), 'transparent', '#bbb', true);
      const yes = mkBtn(t('review.consent.allow'), '#3d7bfd', '#fff', false);
      no.addEventListener('click', () => { setReviewConsent('denied'); reviewPending.clear(); bar.remove(); });
      yes.addEventListener('click', () => { setReviewConsent('granted'); bar.remove(); flushReviewLines(); });
      row.appendChild(no); row.appendChild(yes); bar.appendChild(msg); bar.appendChild(row); document.body.appendChild(bar);
    }
    function queueReviewLine(bid, oid, json) {
      if (!bid || !oid || typeof json !== 'string') return;
      if (!json.trim() || json.trim() === '{}' || json.length > REVIEW_JSON_MAX) return;
      const key = bid + '|' + oid;
      if (reviewSent.has(key)) return;
      if (!reviewPending.has(key) && reviewPending.size >= REVIEW_PENDING_MAX) return;   // Deckel (Consent ausstehend)
      reviewPending.set(key, { bid: String(bid), oid: String(oid), json });
      if (!reviewFlushTimer) reviewFlushTimer = setTimeout(flushReviewLines, 15000);
    }
    function flushReviewLines() {
      reviewFlushTimer = null;
      if (!reviewPending.size) return;
      const cfg = getCfg();
      const token = cfg && cfg.token;
      const configuredUrl = cfg && cfg.url;
      const authed = !!(token && configuredUrl);
      let uid = null;
      if (!authed) {
        // Token-los: uid Pflicht (Identität) + einmalige Zustimmung.
        uid = rcDecodeChessableUid(getToken());
        if (!uid) { reviewPending.clear(); return; }
        const consent = getReviewConsent();
        const targetUrl = configuredUrl || DEFAULT_ROOKHUB_URL;
        if (consent === 'denied') { reviewPending.clear(); return; }
        if (consent !== 'granted') { showReviewConsentPrompt(targetUrl); return; }   // puffern, auf Zustimmung warten
      }
      const baseUrl = String(authed ? configuredUrl : (configuredUrl || DEFAULT_ROOKHUB_URL)).replace(/\/$/, '');
      const endpoint = authed ? '/api/extension/chessable/review-lines' : '/api/extension/chessable/review-lines/anon';
      const byBid = new Map();
      for (const [key, v] of reviewPending) {
        if (!byBid.has(v.bid)) byBid.set(v.bid, []);
        const bucket = byBid.get(v.bid);
        if (bucket.length < 50) { bucket.push([key, v]); reviewPending.delete(key); }
      }
      for (const [bid, items] of byBid) {
        const entries = items.map(([, v]) => ({ oid: v.oid, json: v.json }));
        const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
        if (authed) headers['Authorization'] = 'Bearer ' + token;
        fetch(baseUrl + endpoint, {
          method: 'POST', mode: 'cors', headers,
          body: JSON.stringify(authed ? { bid, entries } : { uid, bid, entries }),
        }).then(r => { if (r.ok) for (const [key] of items) reviewSent.add(key); }).catch(() => {});
      }
      if (reviewPending.size && !reviewFlushTimer) reviewFlushTimer = setTimeout(flushReviewLines, 15000);
    }
    // ===== Sitzungszüge (saveProgress) ernten =====
    // Chessables Session-Report trägt je Halbzug das SITZUNGS-Ergebnis (wrong[], Overstudy/
    // Alternative, Level/Punkte). Mitgeschnitten wird der REQUEST-Body (die Antwort enthält
    // Konto-Daten und bleibt tabu) → gruppiert je Linie → POST /chessable/session-moves
    // (append-only Roh-Log). NUR mit RookHub-Token — kein Anon-Pfad für Sitzungsdaten.
    const sessionPending = [];
    const SESSION_PENDING_MAX = 200;
    let sessionFlushTimer = null;
    function harvestFromSaveProgress(body) {
      let o; try { o = JSON.parse(body); } catch (e) { return; }
      let data = o && o.data;   // `data` ist ein JSON-STRING im Request-JSON
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { return; } }
      const moves = data && data.moves;
      if (!Array.isArray(moves)) return;
      const byKey = new Map();
      for (const m of moves) {
        if (!m || m.bid == null || m.oid == null) continue;
        const bid = String(m.bid), oid = String(m.oid), key = bid + '|' + oid;
        if (!byKey.has(key)) byKey.set(key, { bid, entry: { oid, moves: [] } });
        byKey.get(key).entry.moves.push(m);
      }
      for (const v of byKey.values()) {
        if (sessionPending.length >= SESSION_PENDING_MAX) break;
        sessionPending.push(v);
      }
      if (sessionPending.length && !sessionFlushTimer) sessionFlushTimer = setTimeout(flushSessionMoves, 15000);
    }
    function flushSessionMoves() {
      sessionFlushTimer = null;
      if (!sessionPending.length) return;
      const cfg = getCfg();
      if (!cfg || !cfg.url || !cfg.token) { sessionPending.length = 0; return; }
      const byBid = new Map();
      for (const v of sessionPending.splice(0)) {
        if (!byBid.has(v.bid)) byBid.set(v.bid, []);
        byBid.get(v.bid).push(v.entry);
      }
      for (const [bid, entries] of byBid) {
        fetch(String(cfg.url).replace(/\/$/, '') + '/api/extension/chessable/session-moves', {
          method: 'POST', mode: 'cors',
          headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ bid, entries }),
        }).catch(() => {});
        // Fehlschlag: bewusst NICHT re-queuen — der nächste Durchlauf bringt frische Daten.
      }
    }

    window.addEventListener('pagehide', () => { flushProblemMoves(); flushReviewLines(); flushSessionMoves(); });
    function getToken() { try { return extractJwt(localStorage.getItem(lsKey)); } catch (e) { return null; } }
    function currentCourseId() {
      const m = /\/courses?\/(\d+)(?:\/|$)/.exec(location.pathname);
      if (m) return m[1];
      for (const a of document.querySelectorAll('a[href*="/course/"]')) {
        const am = /\/course\/(\d+)(?:\/|$)/.exec(a.getAttribute('href') || '');
        if (am) return am[1];
      }
      return null;
    }

    // --- V1: passiver Mitschnitt (fetch + XHR im Page-Kontext direkt patchen) ---
    const cap = { bid: null, courseText: null, lists: {}, oidToLid: {}, games: {}, bytes: 0 };
    const CAP_MAX = 40 * 1024 * 1024;
    function resetCap(bid) { cap.bid = bid; cap.courseText = null; cap.lists = {}; cap.oidToLid = {}; cap.games = {}; cap.bytes = 0; }
    function absorb(url, body) {
      if (typeof body !== 'string' || !body || body.trim() === '' || body.trim() === '{}') return;
      const info = classifyApi(url);
      if (!info) return;
      // getReview läuft NEBEN dem Kurs-Mitschnitt-Puffer (eigene Egress-Bahn) — nicht gegen CAP_MAX
      // zählen/puffern; nur an RookHub weiterreichen.
      if (info.kind === 'review') {
        queueReviewLine(info.bid || cap.bid || currentCourseId(), info.oid, body);
        if (!crawling && info.oid != null) window.__repcheckLastGameOid = { oid: String(info.oid), at: Date.now() };
        return;
      }
      if (cap.bytes + body.length > CAP_MAX) return;
      if (info.kind === 'course') { const bid = info.bid || currentCourseId(); if (bid && bid !== cap.bid) resetCap(bid); if (!cap.bid) cap.bid = bid || null; cap.courseText = body; cap.bytes += body.length; }
      else if (info.kind === 'list') { if (info.bid && info.bid !== cap.bid) resetCap(info.bid); if (!cap.bid && info.bid) cap.bid = info.bid; if (info.lid != null) { cap.lists[info.lid] = body; cap.bytes += body.length; for (const oid of parseLineOids(body)) cap.oidToLid[oid] = info.lid; } harvestFromList(info.bid || cap.bid || currentCourseId(), body); }
      else if (info.kind === 'game') {
        if (info.oid != null && !cap.games[info.oid]) { cap.games[info.oid] = body; cap.bytes += body.length; }
        // Trainings-Signal für initChessableActivityTracking (eigene Closure): zuletzt geladene
        // Linie = gerade trainierte Linie. Während eines aktiven Crawls wertlos → nicht spiegeln.
        if (!crawling && info.oid != null) window.__repcheckLastGameOid = { oid: String(info.oid), at: Date.now() };
        harvestFromGame(cap.bid || currentCourseId(), info.oid, body);
      }
      updatePanel();
      if (autoImport) scheduleAutoImport();
    }
    const RELEVANT = /\/api\/v1\/(getCourse|getList|getGame|getReview)(\?|$)/;
    // Session-Report: hier interessiert der REQUEST-Body (Sitzungszüge inkl. Fehlversuche);
    // die ANTWORT wird bewusst NICHT angefasst (enthält Konto-Daten).
    const RELEVANT_REQ = /\/api\/v1\/saveProgress/;
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (...args) {
        const p = origFetch.apply(this, args);
        try {
          const a0 = args[0]; const url = (a0 && typeof a0 === 'object' && 'url' in a0) ? a0.url : String(a0 || '');
          if (RELEVANT.test(url)) p.then(r => { try { r.clone().text().then(t => absorb(url, t)).catch(() => {}); } catch (e) {} }).catch(() => {});
          if (RELEVANT_REQ.test(url)) {
            const a1 = args[1];
            if (a1 && typeof a1.body === 'string') harvestFromSaveProgress(a1.body);
            else if (a0 && typeof a0 === 'object' && typeof a0.clone === 'function') a0.clone().text().then(t => harvestFromSaveProgress(t)).catch(() => {});
          }
        } catch (e) {}
        return p;
      };
    }
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const oOpen = XHR.prototype.open, oSend = XHR.prototype.send;
      XHR.prototype.open = function (m, url, ...rest) { try { this.__rcUrl = String(url || ''); } catch (e) {} return oOpen.call(this, m, url, ...rest); };
      XHR.prototype.send = function (...a) { try { const url = this.__rcUrl || ''; if (RELEVANT_REQ.test(url) && typeof a[0] === 'string') harvestFromSaveProgress(a[0]); if (RELEVANT.test(url)) this.addEventListener('load', function () { try { const t = (this.responseType === '' || this.responseType === 'text') ? this.responseText : (this.responseType === 'json' ? JSON.stringify(this.response) : null); if (t) absorb(url, t); } catch (e) {} }); } catch (e) {} return oSend.apply(this, a); };
    }

    function capturedChapters() {
      const lids = cap.courseText ? parseChapterLids(cap.courseText) : Object.keys(cap.lists);
      return buildIngestChapters(lids.filter(lid => cap.lists[lid]).map(lid => ({ listText: cap.lists[lid], games: cap.games })));
    }
    function capturedLineCount() { return capturedChapters().reduce((n, c) => n + c.lines.length, 0); }

    // --- Egress + Chessable-Fetch ---
    async function ingest(bid, chapters, target) {
      const cfg = getCfg();
      if (!cfg || !cfg.url || !cfg.token) throw new Error(t('err.notConnected'));
      const baseUrl = String(cfg.url).replace(/\/$/, '');
      const courseName = (courseNameApi && courseNameApi.apiCourseName) ? courseNameApi.apiCourseName(bid) : null;
      const resp = await fetch(baseUrl + '/api/extension/chessable/ingest', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ bid, target, courseName, chapters }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error((data && data.message) || ('HTTP ' + resp.status));
      return data;
    }
    // Chessable drosselt (HTTP 429) bei zu schnellem Holen. Nur retrybare Codes wiederholen; dabei
    // `Retry-After` honorieren (Sekunden ODER HTTP-Datum), sonst exponentielles Backoff mit Jitter.
    // 401/403/404 bleiben harte Fehler (kein Retry). Normaler Takt s. crawlPauseMs.
    const CHESSABLE_RETRYABLE = new Set([429, 500, 502, 503, 504]);
    const CHESSABLE_MAX_ATTEMPTS = 5;
    function parseRetryAfterMs(header) {
      if (!header) return null;
      const secs = Number(header);
      if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
      const when = Date.parse(header);
      if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
      return null;
    }
    async function chessableGet(path) {
      const token = getToken(); if (!token) throw new Error('Kein Chessable-Token (eingeloggt?)');
      const uid = rcDecodeChessableUid(token); if (!uid) throw new Error('Token ohne uid');
      const sep = path.includes('?') ? '&' : '?';
      const url = `https://www.chessable.com/api/v1/${path}${sep}uid=${uid}`;
      const init = { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }, credentials: 'include' };
      let lastStatus = 0;
      for (let attempt = 1; attempt <= CHESSABLE_MAX_ATTEMPTS; attempt++) {
        const resp = await fetch(url, init);
        if (resp.ok) return resp.text();
        lastStatus = resp.status;
        if (!CHESSABLE_RETRYABLE.has(resp.status) || attempt === CHESSABLE_MAX_ATTEMPTS) break;
        const retryAfter = parseRetryAfterMs(resp.headers.get('Retry-After'));
        const backoff = (retryAfter != null ? retryAfter : Math.min(30000, CRAWL_BACKOFF_BASE_MS * Math.pow(2, attempt)))
          + Math.floor(Math.random() * 400);
        setStatus(`Chessable drosselt (HTTP ${resp.status}) — warte ${Math.round(backoff / 1000)} s (Versuch ${attempt}/${CHESSABLE_MAX_ATTEMPTS - 1}) …`);
        await sleep(backoff);
      }
      throw new Error('Chessable HTTP ' + lastStatus);
    }

    // Ein Kapitel-Chunk an den kapitelweisen Ingest (bounded); final=true schließt die Session ab.
    async function ingestChunk(sessionId, bid, target, courseName, chapter, final) {
      const cfg = getCfg();
      if (!cfg || !cfg.url || !cfg.token) throw new Error(t('err.notConnected'));
      const baseUrl = String(cfg.url).replace(/\/$/, '');
      const resp = await fetch(baseUrl + '/api/extension/chessable/ingest/chunk', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ sessionId, bid, target, courseName, chapter, final }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error((data && data.message) || ('HTTP ' + resp.status));
      return data;
    }

    const CRAWL_BACKOFF_BASE_MS = 3000; const sleep = (ms) => new Promise(r => setTimeout(r, ms));  // Backoff-Basis s. chessableGet
    // Zufällige Pause 2,5–3,5 s zwischen zwei Chessable-Abrufen. Userscript: fester Bereich ohne Regler —
    // einstellbar (nur nach oben) ist er nur im Extension-Popup.
    const crawlPauseMs = () => 2500 + Math.floor(Math.random() * 1001);
    const newSessionId = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (String(Date.now()) + '-' + Math.round(Math.random() * 1e9));
    let crawling = false;
    let cancelRequested = false;          // Abbrechen-Button während des Laufs
    let crawlStartedAt = null;            // ms-Start des Crawls (mitlaufender Timer im Status)
    let crawlTimerInt = null;
    let statusBase = '';
    // V2: kompletten Kurs aktiv holen und KAPITELWEISE streamen (kein Riesen-Body; Import beim finalen Chunk).
    // Repertoire (Default): INKREMENTELL — schon auf RookHub liegende oids werden NICHT erneut von Chessable
    // geholt, nur neue via ingestLive angehängt (spart Abrufe + Ban-Risiko). Buch: voll holen + Chunk-Stream
    // (Round-basierte LineId braucht den ganzen Kurs am Stück).
    async function crawlAndImport(target) {
      if (crawling) return; crawling = true; cancelRequested = false; crawlStartedAt = Date.now();
      if (!crawlTimerInt) crawlTimerInt = setInterval(paintStatus, 1000);
      updatePanel();
      const bid = currentCourseId();
      const sessionId = newSessionId();
      const incremental = target !== 'book';
      const courseName = (courseNameApi && courseNameApi.apiCourseName) ? courseNameApi.apiCourseName(bid) : null;
      try {
        if (!bid) throw new Error(t('err.noCourse'));
        let already = new Set();
        if (incremental) { const prog = await fetchImportedOids(bid); already = new Set((prog && prog.oids) || []); }
        setStatus(t('import.fetchingStructure'));
        const courseText = (cap.courseText && cap.bid === bid) ? cap.courseText : await chessableGet(`getCourse?bid=${bid}`);
        const lids = parseChapterLids(courseText);
        if (!lids.length) throw new Error(t('err.noChapters'));
        const lists = []; let total = 0, toFetch = 0;
        for (const lid of lids) { if (cancelRequested) { setStatus(t('import.aborted')); return; } const fromCapture = !!(cap.lists[lid] && cap.bid === bid); const listText = fromCapture ? cap.lists[lid] : await chessableGet(`getList?bid=${bid}&lid=${lid}`); const oids = parseLineOids(listText); lists.push({ listText, oids }); total += oids.length; toFetch += incremental ? oids.filter(o => !already.has(String(o))).length : oids.length; if (!fromCapture) await sleep(crawlPauseMs()); }
        if (incremental && toFetch === 0) { setStatus(t('import.nothingNew', { count: total })); ensureProgress(true); return; }
        let done = 0, sent = 0, skipped = 0;
        const newChapters = [];
        for (const { listText, oids } of lists) {
          const lines = [];
          for (const oid of oids) { if (cancelRequested) { setStatus(t('import.aborted')); return; } if (incremental && already.has(String(oid))) { skipped++; continue; } let g = cap.games[oid]; if (!g) { g = await chessableGet(`getGame?lng=en&oid=${oid}`); await sleep(crawlPauseMs()); } if (g && g.trim() && g.trim() !== '{}') { lines.push(g); cap.games[oid] = g; } done++; setStatus(t('import.fetchingLines', { done, total: toFetch })); }
          if (!lines.length) continue;
          if (incremental) newChapters.push({ chapterJson: listText, lines });
          else await ingestChunk(sessionId, bid, target, courseName, { chapterJson: listText, lines }, false);
          sent++;
        }
        if (!sent) throw new Error(t('err.noLines'));
        if (incremental) {
          setStatus(t('import.appending'));
          const res = await ingestLive(bid, target, courseName, newChapters);
          setStatus(skipped
            ? t('import.doneAppendedSkipped', { count: res.imported, skipped })
            : t('import.doneAppended', { count: res.imported })); ensureProgress(true);
        } else {
          setStatus(t('import.importing'));
          const res = await ingestChunk(sessionId, bid, target, courseName, null, true);
          setStatus(t(target === 'book' ? 'import.doneImportedPuzzles' : 'import.doneImportedLines', { count: res.imported })); ensureProgress(true);
        }
      } catch (err) { setStatus(t('import.error', { error: (err && err.message) || err })); }
      finally { crawling = false; crawlStartedAt = null; if (crawlTimerInt) { clearInterval(crawlTimerInt); crawlTimerInt = null; } updatePanel(); }
    }
    async function importCaptured(target) {
      const bid = cap.bid || currentCourseId(); const chapters = capturedChapters();
      if (!bid || !chapters.length) { setStatus(t('import.nothingCaptured')); return; }
      try { setStatus(t('import.importingCapture')); const res = await ingest(bid, chapters, target); setStatus(t(target === 'book' ? 'import.doneImportedPuzzles' : 'import.doneImportedLines', { count: res.imported })); ensureProgress(true); }
      catch (err) { setStatus(t('import.error', { error: (err && err.message) || err })); }
    }

    // Live-Anhängen ist immer aktiv (kein Schalter mehr) — siehe extension/chessable-activity.js.
    const autoImport = true;
    let autoImportTimer = null;

    // Live-Append (V1 „beim Durchklicken"): jede NEU erfasste Linie kurz gebündelt SOFORT ans
    // Repertoire anhängen (POST .../ingest/live). sentOids = Session-Dedup; Server dedupliziert per Zugtext.
    const sentOids = new Set();
    let liveFlushing = false;
    function hasUnsentLine() {
      for (const oid of Object.keys(cap.games)) { if (sentOids.has(oid)) continue; const lid = cap.oidToLid && cap.oidToLid[oid]; if (lid && cap.lists[lid]) return true; }
      return false;
    }
    async function ingestLive(bid, target, courseName, chapters) {
      const cfg = getCfg();
      if (!cfg || !cfg.url || !cfg.token) throw new Error(t('err.notConnected'));
      const baseUrl = String(cfg.url).replace(/\/$/, '');
      const resp = await fetch(baseUrl + '/api/extension/chessable/ingest/live', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ bid, target, courseName, chapters }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error((data && data.message) || ('HTTP ' + resp.status));
      return data;
    }
    async function flushLive() {
      if (liveFlushing) return;
      const bid = cap.bid || currentCourseId();
      if (!bid) return;
      const byLid = {}; const picked = [];
      for (const oid of Object.keys(cap.games)) {
        if (sentOids.has(oid)) continue;
        const lid = cap.oidToLid && cap.oidToLid[oid];
        if (!lid || !cap.lists[lid]) continue;
        (byLid[lid] = byLid[lid] || []).push(oid);
        picked.push(oid);
      }
      if (!picked.length) return;
      const chapters = Object.keys(byLid).map(lid => ({ chapterJson: cap.lists[lid], lines: byLid[lid].map(o => cap.games[o]) }));
      liveFlushing = true;
      picked.forEach(o => sentOids.add(o));
      try {
        const cn = (courseNameApi && courseNameApi.apiCourseName) ? courseNameApi.apiCourseName(bid) : null;
        const res = await ingestLive(bid, currentTarget(), cn, chapters);
        setStatus(`Live: ${res.imported} neu angehängt (${sentOids.size} gesendet).`); ensureProgress(true);
      } catch (err) {
        picked.forEach(o => sentOids.delete(o));
        setStatus(t('import.liveError', { error: (err && err.message) || err }));
      } finally {
        liveFlushing = false;
        if (autoImport && hasUnsentLine()) scheduleAutoImport();
      }
      updatePanel();
    }
    function scheduleAutoImport() { if (autoImportTimer) return; autoImportTimer = setTimeout(() => { autoImportTimer = null; flushLive(); }, 1500); }

    // --- UI-Panel ---
    let panel = null, statusEl = null, progressEl = null, capInfoEl = null, importCapBtn = null, crawlBtn = null;
    // --- Fortschritts-Overlay (Kurs/Kapitel im Panel + ✓/○ an Chessables Linien) ---
    let progressBid = null, progressStruct = null, importedOids = new Set(), progressAt = 0, progressFetching = false;
    const PROGRESS_TTL = 60000;
    async function fetchImportedOids(bid) {
      const cfg = getCfg(); if (!cfg || !cfg.url || !cfg.token) return null;
      const baseUrl = String(cfg.url).replace(/\/$/, '');
      try {
        const resp = await fetch(baseUrl + '/api/extension/chessable/progress?bid=' + encodeURIComponent(bid),
          { headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/json' } });
        if (!resp.ok) return null;
        return await resp.json();
      } catch (e) { return null; }
    }
    async function ensureProgress(force) {
      const bid = currentCourseId(); if (!bid) return;
      // Ohne RookHub-Config gibt es nichts anzuzeigen (fetchImportedOids liefert dann null) — dann
      // aber auch KEIN automatisches getCourse mit dem Chessable-Bearer abfeuern. Sonst erzeugt
      // jeder eingeloggte Chessable-Nutzer ungefragt genau die API-Last, vor der der Crawl-Dialog
      // als Bannrisiko warnt.
      const cfg0 = getCfg(); if (!cfg0 || !cfg0.url || !cfg0.token) return;
      if (!force && bid === progressBid && (Date.now() - progressAt) < PROGRESS_TTL) return;
      if (progressFetching) return; progressFetching = true;
      try {
        if (bid !== progressBid || !progressStruct) {
          const courseText = (cap.courseText && cap.bid === bid) ? cap.courseText : await chessableGet(`getCourse?bid=${bid}&includeVariations=true`);
          progressStruct = parseCourseVariations(courseText);
        }
        const prog = await fetchImportedOids(bid);
        importedOids = new Set((prog && prog.oids) || []);
        progressBid = bid; progressAt = Date.now();
        renderProgress(); annotateDom();
      } catch (e) {} finally { progressFetching = false; }
    }
    function renderProgress() {
      if (!progressEl || !progressStruct) return;
      const c = progressCounts(progressStruct.chapters, importedOids);
      if (c.total === 0) { progressEl.textContent = ''; return; }
      const pct = Math.round((c.done / c.total) * 100);
      const lines = c.perChapter.map((ch, i) => `Kapitel ${i + 1}: ${ch.done}/${ch.total}`).join(' · ');
      progressEl.innerHTML = `<div style="font-weight:600;color:#e8eaed">Auf RookHub: ${c.done}/${c.total} Linien (${pct}%)</div>` +
        `<div style="margin-top:2px;font-size:11px;color:#9aa4b2;max-height:80px;overflow:auto">${lines}</div>`;
    }
    function annotateDom() {
      if (!progressStruct) return;
      for (const oid of progressStruct.allOids) {
        const done = importedOids.has(String(oid));
        const el = document.querySelector(`a[href*="/${oid}"], a[href$="/${oid}"], [data-oid="${oid}"], [data-variation-id="${oid}"], [data-id="${oid}"]`);
        if (!el) continue;
        const row = el.closest('li, tr, [role="row"], div') || el;
        let b = row.querySelector(':scope > .rc-prog-badge');
        if (b) { b.textContent = done ? '✓' : '○'; b.style.color = done ? '#4caf50' : '#9aa4b2'; continue; }
        b = document.createElement('span');
        b.className = 'rc-prog-badge';
        b.textContent = done ? '✓' : '○';
        b.title = t(done ? 'progress.onRookhub' : 'progress.notOnRookhub');
        b.style.cssText = `margin-right:6px;font-weight:700;color:${done ? '#4caf50' : '#9aa4b2'}`;
        row.insertBefore(b, row.firstChild);
      }
    }
    let domObserver = null;
    function startDomObserver() {
      if (domObserver || !document.body) return;
      let t = null;
      domObserver = new MutationObserver(() => { if (t) return; t = setTimeout(() => { t = null; try { annotateDom(); } catch (e) {} }, 500); });
      domObserver.observe(document.body, { childList: true, subtree: true });
    }

    function currentTarget() { const r = panel && panel.querySelector('input[name="rc-target"]:checked'); return r ? r.value : 'repertoire'; }
    function elapsedLabel(ms) { const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
    function paintStatus() { if (!statusEl) return; statusEl.textContent = crawlStartedAt ? (statusBase ? `${statusBase} · ${elapsedLabel(crawlStartedAt)}` : elapsedLabel(crawlStartedAt)) : statusBase; }
    function setStatus(t) { statusBase = t || ''; paintStatus(); }
    function ensurePanel() {
      if (panel || !document.body || !currentCourseId()) return;
      panel = document.createElement('div');
      panel.id = 'repcheck-import-panel';
      panel.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483000;background:#1f2530;color:#e8eaed;font:12px/1.4 system-ui,sans-serif;border:1px solid #3a4250;border-radius:8px;padding:10px 12px;max-width:260px;box-shadow:0 4px 16px rgba(0,0,0,.4)';
      panel.innerHTML =
        '<div style="font-weight:600;margin-bottom:6px">RookHub-Import (Browser)</div>' +
        '<div style="margin-bottom:6px"><label style="margin-right:10px"><input type="radio" name="rc-target" value="repertoire" checked> Repertoire</label><label><input type="radio" name="rc-target" value="book"> Kurs/Buch</label></div>' +
        '<button id="rc-crawl" style="width:100%;margin-bottom:6px;padding:6px;background:#2d6cdf;color:#fff;border:0;border-radius:5px;cursor:pointer">⚡ Kurs über meinen Browser holen</button>' +
        '<div id="rc-capinfo" style="margin-bottom:4px;color:#9aa4b2"></div>' +
        '<button id="rc-importcap" style="width:100%;margin-bottom:6px;padding:5px;background:#3a4250;color:#e8eaed;border:0;border-radius:5px;cursor:pointer;display:none">Mitschnitt importieren</button>' +
        '<div id="rc-progress" style="margin-bottom:6px;color:#c7cfda;border-top:1px solid #3a4250;padding-top:6px"></div>' +
        '<div id="rc-status" style="color:#8fd08f;min-height:1.2em"></div>';
      document.body.appendChild(panel);
      statusEl = panel.querySelector('#rc-status'); progressEl = panel.querySelector('#rc-progress'); capInfoEl = panel.querySelector('#rc-capinfo');
      importCapBtn = panel.querySelector('#rc-importcap'); crawlBtn = panel.querySelector('#rc-crawl');
      crawlBtn.addEventListener('click', () => {
        // Läuft ein Crawl, ist derselbe Button der Abbrechen-Knopf.
        if (crawling) { cancelRequested = true; setStatus(t('import.abortRequested')); return; }
        // Bannrisiko: der aktive Crawl klappert die Chessable-API automatisiert ab → explizite Bestätigung.
        const ok = window.confirm([
          t('import.warn.title'), t('import.warn.body'), t('import.warn.own'), t('import.warn.confirm'),
        ].join('\n\n'));
        if (!ok) return;
        crawlAndImport(currentTarget());
      });
      importCapBtn.addEventListener('click', () => importCaptured(currentTarget()));
      updatePanel();
    }
    function updatePanel() {
      if (!panel) return;
      const n = capturedLineCount();
      if (capInfoEl) capInfoEl.textContent = n > 0 ? t('import.capturedInfo', { count: n }) : t('import.capturedNone');
      if (importCapBtn) importCapBtn.style.display = n > 0 ? 'block' : 'none';
      if (crawlBtn) {
        crawlBtn.disabled = false;
        crawlBtn.textContent = crawling ? t('import.cancel') : t('import.crawl');
        crawlBtn.style.background = crawling ? '#c62828' : '#2d6cdf';
      }
    }
    setInterval(() => { ensurePanel(); startDomObserver(); ensureProgress(false); }, 5000); ensurePanel(); startDomObserver(); ensureProgress(false);
  }

  // Misst AKTIVE Chessable-Trainingszeit und meldet sie an RookHub (Kategorie
  // „Chessable" im Trainingsziele-Tracker). „Aktiv" = Brett vorhanden + Tab
  // sichtbar/fokussiert + kuerzliches hartes Signal (Brett-Mutation/Klick/Taste/
  // gewerteter Zug). RookHub-Config kommt aus GM-Storage (origin-uebergreifend,
  // gespiegelt von saveRookhubConfig); ohne Config wird nichts gesendet. Egress
  // per fetch (CORS fuer chessable.com ist serverseitig erlaubt). Pendant zur
  // Extension-Datei extension/chessable-activity.js.
  // Baut aus dem eingeloggten Chessable-JWT (localStorage) + getHomeData eine autoritative
  // bid→Name-Karte. Same-origin auf chessable.com (keine CORS-/Cloudflare-Hürde, wie die
  // Chessable-SPA selbst); der Token verlaesst den Browser nicht. Pendant zur Extension-Logik
  // in extension/chessable-activity.js. Persistiert best-effort in GM-Storage.
  function createChessableCourseNameApi(lsKey, extractJwt) {
    const TTL = 6 * 60 * 60 * 1000; // 6 h
    let names = {}, fetchedAt = 0, fetching = null, loaded = false;

    function readToken() {
      try { return extractJwt(localStorage.getItem(lsKey)); } catch (e) { return null; }
    }
    async function fetchMap() {
      const token = readToken();
      if (!token) return null;
      const uid = rcDecodeChessableUid(token);
      if (!uid) return null;
      try {
        const resp = await fetch(
          `https://www.chessable.com/api/v1/getHomeData?uid=${uid}&sortBookRowsBy=alphabetically&userLanguageShort=en`,
          { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }, credentials: 'include' });
        if (!resp.ok) return null;
        const data = await resp.json();
        const map = rcParseCourseNameMap(data);
        return Object.keys(map).length ? map : null;
      } catch (e) { return null; }
    }
    function loadPersisted() {
      try {
        if (typeof GM_getValue !== 'undefined') {
          const c = GM_getValue('chessableCourseNames', null);
          if (c && c.map && typeof c.map === 'object') { names = c.map; fetchedAt = c.fetchedAt || 0; }
        }
      } catch (e) {}
    }
    async function ensureCourseNames(force) {
      if (!loaded) { loaded = true; loadPersisted(); }
      if (!force && Object.keys(names).length && (Date.now() - fetchedAt) < TTL) return names;
      if (fetching) return fetching;
      fetching = (async () => {
        const map = await fetchMap();
        if (map) {
          names = map; fetchedAt = Date.now();
          try { if (typeof GM_setValue !== 'undefined') GM_setValue('chessableCourseNames', { map, fetchedAt }); } catch (e) {}
        }
        fetching = null;
        return names;
      })();
      return fetching;
    }
    return {
      apiCourseName: (id) => (id && names[String(id)]) || null,
      ensureCourseNames,
    };
  }

  function initChessableActivityTracking(courseNameApi) {
    if (window.__repcheckChessableActivity) return;
    window.__repcheckChessableActivity = true;

    const TICK_MS = 5000, IDLE_MS = 60000, FLUSH_MS = 60000, MIN_FLUSH_MS = 10000, MAX_FLUSH_S = 3600;
    let activeMs = 0, movesTrained = 0, linesTrained = 0, lastActivity = 0, lastFlush = Date.now();
    let courseKind = null, lookedUpCourseId = null;

    const now = () => Date.now();
    const bump = () => { lastActivity = now(); };
    const boardPresent = () => !!document.querySelector('[data-square]');

    document.addEventListener('pointerdown', () => { if (boardPresent()) bump(); }, true);
    document.addEventListener('keydown', () => { if (boardPresent()) bump(); }, true);

    // Abgeschlossene LINIEN: ein Klick auf Chessables „Next variation" (dt. „Nächste Variante")
    // = eine fertig trainierte Linie. Bewusst NICHT das nackte „Next" (Learn-Modus blättert damit Zuege).
    // TEILSTRING-Match: der Knopf traegt oft Zusatztext (Tastatur-Hinweis) — exakter Match
    // verfehlte ihn in der Praxis. Laengen-Deckel gegen grosse Container.
    const NEXT_VARIATION_RE = /next\s+variation|n(ä|ae)chste\s+variante/i;
    const isNextVariationButton = (el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 0 && t.length <= 60 && NEXT_VARIATION_RE.test(t)) return true;
      const aria = el.getAttribute && (el.getAttribute('aria-label') || '');
      return !!aria && NEXT_VARIATION_RE.test(aria);
    };
    // Gemeinsames Dedupe-Fenster fuer Klick UND Taste (Space kann den Knopf doch klicken → 1 Linie).
    let lastLineCountAt = 0;
    function countLine() {
      if (now() - lastLineCountAt < 1500) return;
      lastLineCountAt = now();
      linesTrained++;
      if (!lineHatFehler) linesCorrect++;
      lineHatFehler = false;
      bump();
      reportTrainedLine();
    }

    // „Linie trainiert" → RookHub (Kurs gelöst + Repertoire-SR nachziehen). Die oid kommt aus dem
    // Browser-Import-Mitschnitt (window.__repcheckLastGameOid, s. initChessableBrowserImport).
    const reportedOids = new Map();
    function reportTrainedLine() {
      const sig = window.__repcheckLastGameOid;
      const bid = currentCourseId();
      if (!sig || !bid || Date.now() - sig.at > 30 * 60 * 1000) return;
      const last = reportedOids.get(sig.oid) || 0;
      if (Date.now() - last < 5 * 60 * 1000) return;
      reportedOids.set(sig.oid, Date.now());
      const cfg = readConfig();
      if (!cfg || !cfg.url || !cfg.token) return;
      fetch(String(cfg.url).replace(/\/$/, '') + '/api/extension/chessable/line-trained', {
        method: 'POST',
        mode: 'cors',
        headers: {
          'Authorization': 'Bearer ' + cfg.token,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ bid, oid: sig.oid }),
      }).catch(() => {});
    }
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('button, a, [role="button"]');
      if (!btn) return;
      if (isNextVariationButton(btn)) countLine();
    }, true);
    // Leertaste = Haupt-Workflow zum Weiterspringen (globaler Shortcut, KEIN click-Event).
    function nextVariationButtonVisible() {
      for (const el of document.querySelectorAll('button, a, [role="button"]')) {
        if (!isNextVariationButton(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
      return false;
    }
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (nextVariationButtonVisible()) countLine();
    }, true);

    // Jede neue Benachrichtigung = EIN gewerteter Zug; Observer am Eltern-Knoten (uebersteht
    // React-Node-Austausch) + Zeitfenster-Dedupe. Frueher (nur Text "XP", Observer am Knoten
    // selbst) wurden ~80-90 % der Zuege verschluckt.
    let notifObserver = null, watchedNotifParent = null, lastMoveCountAt = 0;
    // Genauigkeit: je Zug der Zustand aus der Icon-Klasse (geteilte Region oben).
    let movesCorrect = 0, linesCorrect = 0, lineHatFehler = false;
    function feedbackKindOf(root) {
      for (const icon of root.querySelectorAll('.icon-circle-wrapper .icon')) {
        const cs = getComputedStyle(icon);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const k = rcFeedbackKindFromClass(icon.className);
        if (k) return k;
      }
      return null;
    }
    function watchMoveNotif() {
      const n = document.querySelector('[data-testid="moveNotification"]');
      const parent = n && n.parentElement;
      if (!parent || watchedNotifParent === parent) return;
      notifObserver?.disconnect();
      watchedNotifParent = parent;
      notifObserver = new MutationObserver(() => {
        const cur = document.querySelector('[data-testid="moveNotification"]');
        const t = cur ? cur.textContent.trim() : '';
        if (!t) return;
        bump();
        if (now() - lastMoveCountAt > 400) {
          movesTrained++; lastMoveCountAt = now();
          const kind = feedbackKindOf(parent);
          if (rcFeedbackIsFehler(kind)) lineHatFehler = true;
          else if (kind) movesCorrect++;   // 'alt' zaehlt als richtig, unbekannt gar nicht
        }
      });
      // `attributes` MUSS mit: eine wortgleiche Wiederholung („+150 XP" mehrfach) aendert weder
      // Text noch Knoten, sondern nur ein Attribut — ohne das feuert der Observer nicht und der
      // Zug wird nie gezaehlt (Messung 08.08.; Ursache des Undercounts 4,4 statt 10-15 je Linie).
      notifObserver.observe(parent, { childList: true, characterData: true, subtree: true, attributes: true });
    }

    let boardObserver = null, watchedBoard = null;
    function watchBoard() {
      const sq = document.querySelector('[data-square]');
      const board = sq ? (sq.closest('#board, [class*="chessboard"], cg-container') || sq.parentElement) : null;
      if (!board || watchedBoard === board) return;
      boardObserver?.disconnect();
      watchedBoard = board;
      boardObserver = new MutationObserver(() => bump());
      boardObserver.observe(board, { childList: true, subtree: true, attributes: true });
    }

    function readConfig() {
      try {
        if (typeof GM_getValue !== 'undefined') return GM_getValue('rookhubConfig', null);
      } catch (e) { /* ignore */ }
      return null;
    }

    // Kurs-ID robust ermitteln: URL → Kurs-Links → React-Fiber. Im Page-Kontext ist
    // der Fiber lesbar; die Practice-URL (/practice/…) traegt keine Kurs-ID. Logik
    // analog currentCourseId() in initChessableFenTools().
    function getReactFiber(el) {
      if (!el) return null;
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      return key ? el[key] : null;
    }
    function fiberCourseId(props) {
      if (!props || typeof props !== 'object') return null;
      const candidates = [props.courseId, props.courseID, props.course_id, props.course?.id, props.course?.courseId];
      for (const c of candidates) {
        if (c != null && /^\d+$/.test(String(c))) return String(c);
      }
      return null;
    }
    let stickyCourseId = null;  // letzte sicher erkannte Kurs-ID (SPA-Luecken ueberbruecken)
    function currentCourseId() {
      const direct = (() => {
        const urlM = /\/courses?\/(\d+)(?:\/|$)/.exec(location.pathname);
        if (urlM) return urlM[1];
        for (const a of document.querySelectorAll('a[href*="/course/"]')) {
          const m = /\/course\/(\d+)(?:\/|$)/.exec(a.getAttribute('href') || '');
          if (m) return m[1];
        }
        const anchor = document.getElementById('board') || document.querySelector('[data-square]');
        let fiber = getReactFiber(anchor), depth = 0;
        while (fiber && depth < 60) {
          const id = fiberCourseId(fiber.memoizedProps) || fiberCourseId(fiber.pendingProps);
          if (id) return id;
          fiber = fiber.return; depth++;
        }
        return null;
      })();
      if (direct) stickyCourseId = direct;
      return direct || stickyCourseId;
    }

    // Navigations-/UI-Linktexte auf der Practice-/Learn-Seite, die KEIN Kursname sind
    // (z. B. „Practice Moves", „Learn Moves", „Review", „nächstes Kapitel", „Previous variation").
    // Diese Links/Labels zeigen ebenfalls auf /course/{id}/… bzw. beschriften den Modus und haben
    // sonst den echten Titel verdrängt (Beispiel: gemeldeter Kursname „Practice Moves"/„Learn Moves").
    // Die Liste steht in der generierten Shared-Region oben (`rcIsNavLabel`, Quelle
    // extension/lib/chessable-course-names.js) — hier gibt es bewusst KEINE eigene Kopie mehr.

    // Kursname aus den React-Fiber-Props (autoritativ, gleiche Quelle wie die verlässliche Kurs-ID):
    // das `course`-Objekt trägt neben `id` auch `name`/`title`. Robuster als Seitentext, der im
    // Practice-/Learn-Modus nur das Modus-Label liefert.
    function fiberCourseName(props) {
      if (!props || typeof props !== 'object') return null;
      const candidates = [
        props.course?.name, props.course?.title, props.course?.courseName,
        props.courseName, props.courseTitle,
        props.book?.name, props.book?.title,
      ];
      for (const c of candidates) {
        if (typeof c !== 'string') continue;
        const t = c.replace(/\s+/g, ' ').trim();
        if (t && t.length <= 200 && !rcIsNavLabel(t)) return t;
      }
      return null;
    }

    // Lesbarer Kursname: bevorzugt den echten Titel aus dem React-Fiber; sonst der beschreibendste
    // Kurs-Linktext (Nav-/Modus-Labels werden verworfen), zuletzt document.title.
    function currentCourseName() {
      const anchor = document.getElementById('board') || document.querySelector('[data-square]');
      let fiber = getReactFiber(anchor), depth = 0;
      while (fiber && depth < 60) {
        const n = fiberCourseName(fiber.memoizedProps) || fiberCourseName(fiber.pendingProps);
        if (n) return n;
        fiber = fiber.return; depth++;
      }
      const id = currentCourseId();
      if (id) {
        const candidates = [];
        for (const a of document.querySelectorAll('a[href*="/course/' + id + '/"]')) {
          const txt = (a.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt && txt.length <= 200 && !rcIsNavLabel(txt)) candidates.push(txt);
        }
        // Kurstitel ist i. d. R. der längste, beschreibende Linktext (Nav-Labels sind raus).
        if (candidates.length) return candidates.sort((a, b) => b.length - a.length)[0];
      }
      const t = (document.title || '').replace(/\s*[|\-–]\s*Chessable.*$/i, '').trim();
      // Auch der Seitentitel kann ein Nav-Label sein („Leaderboard | Chessable") — sonst landet
      // der als courseName in training-activity/remember-line (gleiche Regel wie in
      // chessable-activity.js).
      return (t && !rcIsNavLabel(t)) ? t : null;
    }

    // Bester verfügbarer Kursname: Chessable-API (autoritativ, via Bearer) > DOM-Heuristik.
    function bestCourseName() {
      return courseNameApi.apiCourseName(currentCourseId()) || currentCourseName();
    }

    function lookupCourseKind() {
      const courseId = currentCourseId();
      if (!courseId || courseId === lookedUpCourseId) return;
      lookedUpCourseId = courseId;
      courseKind = null;
      // Kursname-Karte für den (evtl. neuen) Kurs sicherstellen — force nur bei unbekanntem Kurs.
      courseNameApi.ensureCourseNames(!courseNameApi.apiCourseName(courseId));
      const cfg = readConfig();
      if (!cfg || !cfg.url || !cfg.token) return;
      fetch(String(cfg.url).replace(/\/$/, '') + '/api/extension/repertoires', {
        method: 'GET',
        mode: 'cors',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/json' },
      }).then(r => r.ok ? r.json() : null).then(list => {
        if (!Array.isArray(list)) return;
        const match = list.find(r => r.chessableCourseId === courseId);
        if (match != null) courseKind = match.kind;
      }).catch(() => {});
    }

    // ---------- Tagesstatistik (lokal) ----------
    // Grundlage fuer die Hochrechnung hinter dem ⏳-Zaehler. Bewusst LOKAL und unabhaengig von
    // RookHub. Verbucht wird genau dort, wo die Zaehler endgueltig verbraucht sind: beim
    // Verwerfen (nicht verbunden) und beim erfolgreichen Senden — NICHT beim Fehlschlag, dort
    // werden sie zurueckgebucht und spaeter erneut gesendet (das zaehlte doppelt).
    function rcTagesSchluessel() {
      const x = new Date(); const p2 = (n) => String(n).padStart(2, '0');
      return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`;
    }
    function rcDailyBuchen(secs, moves, lines, movesOk, linesOk) {
      if (!secs && !moves && !lines) return;
      try {
        const roh = (typeof GM_getValue === 'function' && GM_getValue('rcDailyStats')) || {};
        const days = Array.isArray(roh.days) ? roh.days : [];
        const tag = rcTagesSchluessel();
        let h = days.find((d) => d.d === tag);
        if (!h) { h = { d: tag, s: 0, m: 0, l: 0 }; days.push(h); }
        h.s += secs || 0; h.m += moves || 0; h.l += lines || 0;
        h.mok = (h.mok || 0) + (movesOk || 0); h.lok = (h.lok || 0) + (linesOk || 0);
        days.sort((a, b) => (a.d < b.d ? 1 : -1));
        if (typeof GM_setValue === 'function') GM_setValue('rcDailyStats', { days: days.slice(0, 14) });
      } catch (e) { /* Speicher nicht verfuegbar */ }
    }

    function flush(force) {
      if (!force && activeMs < MIN_FLUSH_MS) return;
      const secs = Math.min(MAX_FLUSH_S, Math.round(activeMs / 1000));
      if (secs <= 0) return;

      const cfg = readConfig();
      lastFlush = now();
      if (!cfg || !cfg.url || !cfg.token) {
        rcDailyBuchen(secs, movesTrained, linesTrained, movesCorrect, linesCorrect);
        activeMs = 0; movesTrained = 0; linesTrained = 0; movesCorrect = 0; linesCorrect = 0; return;
      }

      const moves = movesTrained;
      const lines = linesTrained;
      const movesOk = movesCorrect;
      const linesOk = linesCorrect;
      activeMs = 0; movesTrained = 0; linesTrained = 0; movesCorrect = 0; linesCorrect = 0;
      const url = String(cfg.url).replace(/\/$/, '') + '/api/extension/training-activity';
      fetch(url, {
        method: 'POST',
        mode: 'cors',
        keepalive: force,
        headers: {
          'Authorization': 'Bearer ' + cfg.token,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ secondsActive: secs, movesTrained: moves, linesTrained: lines, courseKind, courseId: currentCourseId(), courseName: bestCourseName() }),
      }).then((resp) => {
        if (!resp.ok) { activeMs += secs * 1000; movesTrained += moves; linesTrained += lines; movesCorrect += movesOk; linesCorrect += linesOk; }
        else rcDailyBuchen(secs, moves, lines, movesOk, linesOk);
      }).catch(() => { activeMs += secs * 1000; movesTrained += moves; linesTrained += lines; movesCorrect += movesOk; linesCorrect += linesOk; });
    }

    courseNameApi.ensureCourseNames(false); // Kursname-Karte vorwärmen
    lookupCourseKind();
    setInterval(() => {
      lookupCourseKind(); // neu bei SPA-Navigation in anderen Kurs
      watchMoveNotif();
      watchBoard();
      if (document.visibilityState === 'visible' && document.hasFocus()
          && boardPresent() && (now() - lastActivity) <= IDLE_MS) {
        activeMs += TICK_MS;
      }
      if (now() - lastFlush >= FLUSH_MS) flush(false);
    }, TICK_MS);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush(true);
    });
    window.addEventListener('pagehide', () => flush(true));
  }

  // FEN-Tools fuer chessable.com: "Copy FEN"/"Search FEN"-Buttons unten rechts
  // plus XP-Anzeige. Alle Helfer sind hier gekapselt (eigene chessableSearchUrl-
  // Variante mit Kurs-ID), damit nichts mit der Repertoire-Logik kollidiert.
  // Portiert aus github.com/kahalm/chessable-extension (v0.9.4). Im Userscript
  // (Tampermonkey) ist der React-Fiber an den Brett-DOM-Knoten lesbar; in der
  // Extension uebernimmt das die MAIN-World-Datei extension/chessable-fen.js.
  function initChessableFenTools(courseNameApi) {
    if (window.__repcheckChessableFen) return;
    window.__repcheckChessableFen = true;

    const CM_PIECE_TO_FEN = {
      wK: 'K', wQ: 'Q', wR: 'R', wB: 'B', wN: 'N', wP: 'P',
      bK: 'k', bQ: 'q', bR: 'r', bB: 'b', bN: 'n', bP: 'p',
    };
    const CG_PIECE_TO_FEN = {
      'white king': 'K', 'white queen': 'Q', 'white rook': 'R',
      'white bishop': 'B', 'white knight': 'N', 'white pawn': 'P',
      'black king': 'k', 'black queen': 'q', 'black rook': 'r',
      'black bishop': 'b', 'black knight': 'n', 'black pawn': 'p',
    };
    const FEN_REGEX = /^[1-8rnbqkpRNBQKP/]+\s[wb]\s[KQkqA-Ha-h-]+\s(?:[a-h][1-8]|-)\s\d+\s\d+$/;

    const isValidFen = (s) => typeof s === 'string' && FEN_REGEX.test(s.trim());

    function getReactFiber(el) {
      if (!el) return null;
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      return key ? el[key] : null;
    }

    function collectFenCandidates(props, out) {
      if (!props || typeof props !== 'object') return;
      if (isValidFen(props.interactiveFen)) out.push(props.interactiveFen.trim());
      if (isValidFen(props.fen)) out.push(props.fen.trim());
    }

    function extractFenFromReact() {
      const anchor = document.getElementById('board')
        || document.querySelector('[data-square]')?.closest('#board, [class*="chessboard"]')
        || document.querySelector('[data-square]');
      if (!anchor) return null;
      let fiber = getReactFiber(anchor);
      if (!fiber) return null;
      const candidates = [];
      let depth = 0;
      while (fiber && depth < 40) {
        collectFenCandidates(fiber.memoizedProps, candidates);
        collectFenCandidates(fiber.pendingProps, candidates);
        fiber = fiber.return;
        depth++;
      }
      if (!candidates.length) return null;
      const domPlacement = extractBoardCm();
      if (domPlacement) {
        const matched = candidates.find((c) => c.split(' ')[0] === domPlacement);
        if (matched) return matched;
      }
      return candidates[0];
    }

    function extractBoardCm() {
      const squares = document.querySelectorAll('[data-square]');
      if (!squares.length) return null;
      const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
      let sawAnyPiece = false;
      for (const sq of squares) {
        const name = sq.getAttribute('data-square');
        if (!name || name.length !== 2) continue;
        const file = name.charCodeAt(0) - 'a'.charCodeAt(0);
        const rank = parseInt(name[1], 10) - 1;
        if (file < 0 || file > 7 || rank < 0 || rank > 7) continue;
        const pieceEl = sq.querySelector('[data-piece]');
        if (!pieceEl) continue;
        const fenChar = CM_PIECE_TO_FEN[pieceEl.getAttribute('data-piece')];
        if (!fenChar) continue;
        grid[7 - rank][file] = fenChar;
        sawAnyPiece = true;
      }
      if (!sawAnyPiece) return null;
      return placementFromGrid(grid);
    }

    function parseTranslate(style) {
      const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(style);
      if (!m) return null;
      return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
    }

    function extractBoardCg() {
      const board = document.querySelector('cg-board, .cg-board, [class*="cg-board"]');
      if (!board) return null;
      const rect = board.getBoundingClientRect();
      const sq = rect.width / 8;
      if (!sq || !isFinite(sq)) return null;
      const wrap = document.querySelector('.cg-wrap, cg-container, [class*="cg-wrap"]');
      let orientation = 'white';
      for (let p = wrap; p; p = p.parentElement) {
        if (p.classList?.contains('orientation-black')) { orientation = 'black'; break; }
        if (p.classList?.contains('orientation-white')) { orientation = 'white'; break; }
      }
      const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
      const pieces = board.querySelectorAll('piece');
      if (!pieces.length) return null;
      for (const p of pieces) {
        if (p.classList.contains('ghost') || p.classList.contains('fading')) continue;
        const cls = Array.from(p.classList);
        const color = cls.find((c) => c === 'white' || c === 'black');
        const role = cls.find((c) => ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'].includes(c));
        if (!color || !role) continue;
        const fenChar = CG_PIECE_TO_FEN[`${color} ${role}`];
        if (!fenChar) continue;
        const t = parseTranslate(p.style.transform || p.getAttribute('style') || '');
        if (!t) continue;
        const colIdx = Math.round(t.x / sq);
        const rowIdx = Math.round(t.y / sq);
        if (colIdx < 0 || colIdx > 7 || rowIdx < 0 || rowIdx > 7) continue;
        const file = orientation === 'white' ? colIdx : 7 - colIdx;
        const rank = orientation === 'white' ? 7 - rowIdx : rowIdx;
        grid[7 - rank][file] = fenChar;
      }
      return placementFromGrid(grid);
    }

    function placementFromGrid(grid) {
      return grid.map((row) => {
        let s = '', empty = 0;
        for (const c of row) {
          if (c === null) empty++;
          else {
            if (empty) { s += empty; empty = 0; }
            s += c;
          }
        }
        if (empty) s += empty;
        return s;
      }).join('/');
    }

    const extractBoard = () => extractBoardCm() || extractBoardCg();

    function detectSideToMove() {
      const txt = document.body.innerText || '';
      if (/black\s+to\s+(?:move|play)/i.test(txt)) return 'b';
      if (/white\s+to\s+(?:move|play)/i.test(txt)) return 'w';
      return null;
    }

    function buildFEN() {
      const fiberFen = extractFenFromReact();
      if (fiberFen) return fiberFen;
      const placement = extractBoard();
      if (!placement) return null;
      return `${placement} ${detectSideToMove() || 'w'} KQkq - 0 1`;
    }

    function copyToClipboard(text) {
      if (typeof GM_setClipboard !== 'undefined') {
        try { GM_setClipboard(text, { type: 'text', mimetype: 'text/plain' }); return true; } catch (e) { /* fallthrough */ }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
        return true;
      }
      return fallbackCopy(text);
    }

    function fallbackCopy(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    }

    function fiberCourseId(props) {
      if (!props || typeof props !== 'object') return null;
      const candidates = [
        props.courseId, props.courseID, props.course_id,
        props.course?.id, props.course?.courseId,
      ];
      for (const c of candidates) {
        if (c != null && /^\d+$/.test(String(c))) return String(c);
      }
      return null;
    }

    function currentCourseId() {
      const urlM = /\/courses?\/(\d+)(?:\/|$)/.exec(location.pathname);
      if (urlM) return urlM[1];
      for (const a of document.querySelectorAll('a[href*="/course/"]')) {
        const m = /\/course\/(\d+)(?:\/|$)/.exec(a.getAttribute('href') || '');
        if (m) return m[1];
      }
      const anchor = document.getElementById('board') || document.querySelector('[data-square]');
      if (anchor) {
        let fiber = getReactFiber(anchor);
        let depth = 0;
        while (fiber && depth < 60) {
          const id = fiberCourseId(fiber.memoizedProps) || fiberCourseId(fiber.pendingProps);
          if (id) return id;
          fiber = fiber.return;
          depth++;
        }
      }
      return null;
    }

    function chessableCourseSearchUrl(fen) {
      const courseId = currentCourseId();
      if (courseId) {
        // Kursinterne FEN-Suche: "/" -> ";", " " -> %20 (KEIN encodeURIComponent).
        const encoded = fen.replace(/\//g, ';').replace(/ /g, '%20');
        return `https://www.chessable.com/course/${courseId}/fen/${encoded}/`;
      }
      // Fallback: globale FEN-Suche, "/" -> "U".
      const encoded = fen.replace(/\//g, 'U').replace(/ /g, '%20');
      return `https://www.chessable.com/courses/fen/${encoded}/`;
    }

    function debugDump() {
      console.log('[RepCheck Chessable] debug:', {
        url: location.href,
        cmSquaresFound: document.querySelectorAll('[data-square]').length,
        cmPiecesFound: document.querySelectorAll('[data-piece]').length,
        fiberFen: extractFenFromReact(),
        courseId: currentCourseId(),
      });
    }

// ---------- Zug-Rückmeldung: Overstudied / +XP, mit Aufschlüsselung ----------
    //
    // Chessable zeigt seine Rückmeldung in `.board-footer` — also AUSSERHALB des Brett-Elements
    // und damit im Zen-Modus hinter unserem Backdrop. Statt fremdes DOM hochzuziehen (fragil,
    // Chessable positioniert die Leiste selbst), spiegeln wir den Text in unsere eigene Leiste.
    //
    // Gemessene Struktur (Inspector v0.2.0, Aufnahme vom 08.08.):
    //   <div class="sc-…">                          ← Wrapper, wandert in .board-footer
    //     <span class="icon-circle-wrapper">        ← Zustands-Icons, sprachunabhängig:
    //       <i class="icon icon--correct …">        ←   correct | wrong | alt | give-up | time-up
    //     <div class="sc-…"><span class="current-points">+60&nbsp;</span></div>   ← nur bei XP
    //     <span class="notification-text" data-testid="moveNotification">XP|Overstudied</span>
    // Der Text wird bewusst nur GESPIEGELT, nicht interpretiert: „Overstudied" heißt in einer
    // anderen Chessable-Sprache anders, der Betrag steckt in `.current-points`. Klassifiziert wird
    // nur für die Farbe — und zwar über die Icon-Klasse, nicht über den Text.

    const FEEDBACK_ID = 'repcheck-chessable-feedback';
    const FEEDBACK_LIST_ID = 'repcheck-chessable-feedback-list';
    /** Einträge der laufenden Linie: { text, xp, zeit }. Wird beim Linienwechsel geleert. */
    let lineFeedback = [];
    // Halbzuege, an denen in DIESER Linie ein Fehler passierte (wrong/giveup/timeup). Grund:
    // bei >= 2 Fehlzuegen laesst Chessable am Linienende die verpatzten Zuege WIEDERHOLEN und
    // springt dafuer zum jeweiligen Fehler zurueck/vor — ohne dieses Gedaechtnis sah der grosse
    // Sprung wie eine neue Linie aus und der Zaehler setzte mitten in der Linie zurueck.
    let lineFehlerPlys = [];
    let feedbackObserver = null;
    let watchedFeedbackRoot = null;
    /** Zuletzt gelesene Meldung: Wortlaut, tragender Knoten und Halbzug-Nummer des Bretts.
     *  Alle drei zusammen entscheiden, ob eine Meldung NEU ist. Der Wortlaut allein reicht
     *  nicht: drei „Overstudied" hintereinander sind wortgleich und fielen dadurch auf einen
     *  einzigen Eintrag zusammen. */
    let letzterFeedbackText = '';
    let letzterFeedbackNode = null;
    let letzterFeedbackPly = null;
    /** Zeitpunkt der zuletzt erfassten Meldung — fasst Flackern innerhalb EINES Zuges zusammen. */
    let letzterFeedbackZeit = 0;
    /** Kuerzester Abstand zwischen zwei Zug-Ereignissen. Gemessen lagen echte Zuege 1,8-2,6 s
     *  auseinander; alles darunter ist Animations-Flackern desselben Zuges. */
    const FEEDBACK_MIN_ABSTAND_MS = 400;

    /** Betrag aus „+60 " bzw. aus dem Gesamttext ziehen; null, wenn es kein XP-Ereignis ist. */
    function parseXp(pointsText, fullText) {
      const src = (pointsText || fullText || '').replace(/ /g, ' ');
      const m = /([+-]?\d[\d.,]*)/.exec(src);
      if (!m) return null;
      const n = parseFloat(m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    }

    /** Zustand aus der SICHTBAREN Icon-Klasse (sprachunabhängig), sonst null.
     *  Die Klassen-Zuordnung kommt aus lib/chessable-feedback.js — sie wird auch vom
     *  Activity-Script gebraucht und darf nicht in Kopien auseinanderlaufen. */
    function feedbackKind(root) {
      const map = rcFeedbackKindFromClass;
      for (const icon of root.querySelectorAll('.icon-circle-wrapper .icon')) {
        const cs = getComputedStyle(icon);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const k = map(icon.className);
        if (k) return k;
      }
      return null;
    }

    const FEEDBACK_COLORS = {
      correct: '#2e7d32', wrong: '#c62828', alt: '#1565c0', giveup: '#6a1b9a', timeup: '#ef6c00',
    };

    /** Halbzug-Nummer der angezeigten Stellung (0-basiert); null, wenn keine FEN lesbar ist.
     *  Sie leistet zweierlei: wortgleiche Meldungen auseinanderhalten (verschiedene Zuege) und
     *  den Linienwechsel erkennen. */
    function feedbackPly() {
      const fen = extractFenFromReact();
      if (!fen) return null;
      const teile = fen.trim().split(/\s+/);
      const zug = parseInt(teile[5], 10);
      if (!Number.isFinite(zug)) return null;
      return (zug - 1) * 2 + (teile[1] === 'b' ? 1 : 0);
    }

    function initFeedbackTracker() {
      const notif = document.querySelector('[data-testid="moveNotification"]');
      const root = notif && notif.parentElement;
      if (!root) return;
      if (watchedFeedbackRoot === root && feedbackObserver) return;
      feedbackObserver?.disconnect();
      watchedFeedbackRoot = root;

      const lesen = () => {
        const notifEl = root.querySelector('[data-testid="moveNotification"]') || root;
        // Text GEZIELT zusammensetzen statt `root.textContent` zu nehmen: beim schnellen Ziehen
        // steht kurz eine ZWEITE `.current-points`-Span im DOM, und der Gesamttext las sich dann
        // als „+70 +70 XP" (gemeldet 08.08.). Der BETRAG war nie betroffen — der kommt aus dem
        // ersten Treffer von `querySelector`, weshalb die Summe stimmte. Nur die Anzeige war schief.
        const punkteEl = root.querySelector('.current-points');
        const sauber = (n) => (n ? (n.textContent || '') : '').replace(/\u00a0/g, ' ').trim();
        const punkteTxt = sauber(punkteEl);
        const meldungTxt = sauber(notifEl);
        const text = (punkteTxt ? punkteTxt + ' ' : '') + meldungTxt;
        // Leerlauf zwischen zwei Zuegen: Marken loeschen, damit die naechste Meldung zaehlt.
        if (!text) { letzterFeedbackText = ''; letzterFeedbackNode = null; return; }

        // JEDES Feuern des Observers ist EIN Zug-Ereignis. Belegt durch die Messung vom 08.08.
        // (Inspector v0.6.1): drei wortgleiche „+150 XP" hintereinander aendern weder Text noch
        // Knoten — sie aendern NUR ein Attribut am Wurzelknoten (Chessable stoesst die
        // Einblend-Animation neu an), und zwar genau einmal je Zug, im Abstand von rund 2 s.
        //
        // Die erste Fassung verwarf reine Attribut-Mutationen ausdruecklich als „kein neues
        // Ereignis" — dieser Schutz gegen Doppelzaehlung war genau der Grund, warum die
        // Wiederholungen verschluckt wurden. Statt der Mutations-ART entscheidet jetzt der
        // zeitliche Abstand: schnelles Flackern innerhalb eines Zuges wird zusammengefasst,
        // ein echter zweiter Zug nicht. Eine Textaenderung zaehlt IMMER, unabhaengig vom Abstand.
        const jetzt = Date.now();
        const textGeaendert = text !== letzterFeedbackText || notifEl !== letzterFeedbackNode;
        if (!textGeaendert && jetzt - letzterFeedbackZeit < FEEDBACK_MIN_ABSTAND_MS) return;
        letzterFeedbackZeit = jetzt;

        const ply = feedbackPly();
        // Linienwechsel: innerhalb EINER Linie waechst die Halbzug-Nummer in kleinen Schritten
        // (eigener Zug + Antwortzug). Ein GROSSER Sprung — zurueck oder vorwaerts — heisst neue
        // Linie; sonst summierte sich alles ueber die Sitzung auf.
        //
        // WICHTIG: ein kleiner Ruecksprung ist KEIN Linienwechsel. Chessable nimmt einen
        // alternativen (und einen falschen) Zug zurueck, die Nummer faellt dabei um 1-2.
        const sprungZurueck = ply != null && letzterFeedbackPly != null && letzterFeedbackPly - ply;
        // Landet der Sprung bei (oder direkt neben) einem gemerkten Fehler-Halbzug, ist das
        // Chessables Wiederholungsphase („play the moves you missed") — DIESELBE Linie.
        const wiederholung = ply != null && lineFehlerPlys.some((f) => Math.abs(f - ply) <= 1);
        if (ply != null && letzterFeedbackPly != null && !wiederholung
            && (sprungZurueck >= 3 || ply > letzterFeedbackPly + 3)) {
          resetLineFeedback();
          letzterFeedbackZeit = jetzt;   // resetLineFeedback nullt die Marken
        }
        letzterFeedbackText = text;
        letzterFeedbackNode = notifEl;
        letzterFeedbackPly = ply;
        const xp = parseXp(punkteTxt, text);
        const kind = feedbackKind(root);
        const istFehler = (typeof rcFeedbackIsFehler === 'function')
          ? rcFeedbackIsFehler(kind)
          : (self.RepCheckFeedback && self.RepCheckFeedback.isFehler ? self.RepCheckFeedback.isFehler(kind) : false);
        if (istFehler && ply != null) lineFehlerPlys.push(ply);
        lineFeedback.push({ text, xp, kind });
        renderFeedback();
        renderPool();
      };
      lesen();
      feedbackObserver = new MutationObserver(lesen);
      feedbackObserver.observe(root, { childList: true, characterData: true, subtree: true, attributes: true });
    }

    /** Betrag mit Vorzeichen; 0 wird als „+0" geschrieben, damit die Anzeige einheitlich bleibt. */
    function signiert(n) { return (n >= 0 ? '+' : '') + n; }

    /** Summe der erfassten Beträge (Meldungen ohne Betrag zählen als 0). */
    function feedbackSum() {
      return lineFeedback.reduce((s, e) => s + (e.xp || 0), 0);
    }

    function renderFeedback() {
      const badge = document.getElementById(FEEDBACK_ID);
      if (!badge) return;
      const last = lineFeedback[lineFeedback.length - 1];
      if (!last) { badge.style.display = 'none'; hideFeedbackList(); return; }
      const sum = feedbackSum();
      // JEDER Zug bekommt einen Betrag — auch „Overstudied" (dann +0), damit die Anzeige nicht
      // zwischen Zahl und Wort springt. Dahinter die laufende Summe dieser Linie. Der
      // Original-Wortlaut (er trägt auch die Kontosprache) bleibt im Tooltip.
      badge.textContent = `${signiert(last.xp || 0)} · Σ ${signiert(sum)}`;
      badge.style.background = FEEDBACK_COLORS[last.kind] || 'rgba(0,0,0,0.45)';
      badge.style.display = 'inline-flex';
      badge.title = `${last.text} — klicken für die Einzelbeträge dieser Linie`;
      const list = document.getElementById(FEEDBACK_LIST_ID);
      if (list && list.style.display !== 'none') renderFeedbackList();
    }

    function renderFeedbackList() {
      let list = document.getElementById(FEEDBACK_LIST_ID);
      if (!list) {
        list = document.createElement('div');
        list.id = FEEDBACK_LIST_ID;
        Object.assign(list.style, {
          position: 'fixed', bottom: '58px', right: '16px', zIndex: '2147483647',
          maxHeight: '50vh', overflowY: 'auto', minWidth: '190px',
          background: 'rgba(0,0,0,0.85)', color: '#fff', borderRadius: '8px',
          padding: '8px 10px', font: '12px/1.5 system-ui, sans-serif',
          boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        });
        document.body.appendChild(list);
      }
      const zeilen = lineFeedback.map((e, i) => {
        const betrag = signiert(e.xp || 0);
        return `<div style="display:flex;gap:10px;justify-content:space-between">
          <span style="opacity:.65">${i + 1}.</span>
          <span style="flex:1">${e.text.replace(/[<>&]/g, '')}</span>
          <span style="font-variant-numeric:tabular-nums">${betrag}</span></div>`;
      }).join('');
      const sum = feedbackSum();
      list.innerHTML = `<div style="opacity:.7;margin-bottom:4px">Diese Linie — erfasste Meldungen</div>${zeilen}
        <div style="border-top:1px solid rgba(255,255,255,.25);margin-top:6px;padding-top:4px;display:flex;justify-content:space-between">
          <span>Summe der erfassten Beträge</span>
          <span style="font-variant-numeric:tabular-nums">${signiert(sum)}</span></div>
        <div style="opacity:.55;margin-top:4px;font-size:11px">Chessables Gesamtsumme kann abweichen
          (Boni am Linienende zählt RepCheck nicht mit).</div>`;
      list.style.display = 'block';
    }

    function hideFeedbackList() {
      const list = document.getElementById(FEEDBACK_LIST_ID);
      if (list) list.style.display = 'none';
    }

    function toggleFeedbackList() {
      const list = document.getElementById(FEEDBACK_LIST_ID);
      if (list && list.style.display === 'block') hideFeedbackList();
      else if (lineFeedback.length) renderFeedbackList();
    }

    /** Neue Linie → Einträge verwerfen (sonst summiert sich alles über die Sitzung auf). */
    /** Chessables "Next variation"/"Weiter" beendet die Linie -> Eintraege der naechsten
     *  Linie frisch beginnen. Ein Klick auf UNSEREN Pfeil-Knopf zaehlt genauso (er klickt
     *  Chessables Knopf durch). */
    /** Beschriftungen von Chessables „weiter"-Knopf, so weit bekannt. Nur ein ZUSATZ-Signal —
     *  die verlaessliche Linienwechsel-Erkennung sitzt in `lesen` (Halbzug-Sprung). */
    const NEXT_LABEL_RE = /^(next( variation| chapter| move| line)?|continue|weiter|fortfahren|n(ä|ae)chste[rs]?( variante| linie| kapitel| zug)?)$/i;
    let lineResetAttached = false;
    function attachLineResetListener() {
      if (lineResetAttached) return;
      lineResetAttached = true;
      document.body.addEventListener('click', (e) => {
        const el = e.target instanceof Element ? e.target.closest('button, a, [role="button"]') : null;
        if (!el) return;
        const t = (el.textContent || '').trim()
          || (el.getAttribute('aria-label') || '').trim()
          || (el.getAttribute('title') || '').trim();
        if (NEXT_LABEL_RE.test(t) || el.id === 'repcheck-zen-next'
          || el.getAttribute('data-testid') === 'nextLessonButton') resetLineFeedback();
      }, true);
    }

    function resetLineFeedback() {
      lineFeedback = [];
      lineFehlerPlys = [];
      letzterFeedbackText = '';
      letzterFeedbackNode = null;
      letzterFeedbackPly = null;
      hideFeedbackList();
      const badge = document.getElementById(FEEDBACK_ID);
      if (badge) badge.style.display = 'none';
    }


    // ---- UI ----
    const CONTAINER_ID = 'repcheck-chessable-fen-tools';

    function styleButton(btn, bg) {
      Object.assign(btn.style, {
        padding: '8px 12px', fontSize: '13px', fontFamily: 'system-ui, sans-serif',
        background: bg, color: '#fff', border: 'none', borderRadius: '6px',
        boxShadow: '0 2px 6px rgba(0,0,0,0.3)', cursor: 'pointer', opacity: '0.9',
      });
      btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
      btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.9'; });
    }

    function flash(btn, text, color) {
      const oldText = btn.textContent;
      const oldBg = btn.style.background;
      btn.textContent = text;
      btn.style.background = color;
      setTimeout(() => { btn.textContent = oldText; btn.style.background = oldBg; }, 1200);
    }

    // Mobile: Buttons höher setzen (+ Safe-Area) + umbrechen, damit sie nicht
    // die Firefox-/System-Leiste unten überdecken. !important wegen Inline-Style.
    const MOBILE_STYLE_ID = 'repcheck-chessable-fen-mobile-style';
    function injectMobileStyle() {
      if (document.getElementById(MOBILE_STYLE_ID)) return;
      const st = document.createElement('style');
      st.id = MOBILE_STYLE_ID;
      st.textContent = `
        @media (max-width: 768px) {
          #${CONTAINER_ID} {
            bottom: calc(env(safe-area-inset-bottom, 0px) + 88px) !important;
            right: calc(env(safe-area-inset-right, 0px) + 8px) !important;
            left: 8px !important;
            flex-wrap: wrap !important;
            justify-content: flex-end !important;
            gap: 6px !important;
          }
          #${CONTAINER_ID} button { padding: 6px 10px !important; font-size: 12px !important; }
        }`;
      (document.head || document.documentElement).appendChild(st);
    }

    // ── Vollbild-/Zen-Modus (identisch zur Extension-Variante) ────────────
    // Ganze Seite in echtes Vollbild, Brett groß und mittig auf dunklem
    // Backdrop; KEIN DOM-Umbau (React) — nur Inline-Styles + eigenes DIV.
    // Vergrößert wird OHNE zoom/transform:scale — beides bricht das Drag&Drop
    // von chessboard.js (Feld-Offsets visuell gemessen, Treffer-Prüfung mit
    // Layout-squareSize → Drops enden als Snapback). Stattdessen width/height
    // per !important festnageln und Chessables Resize-Pfad anstoßen, damit
    // board.resize() die squareSize echt neu berechnet.
    const ZEN_BACKDROP_ID = 'repcheck-zen-backdrop';
    const ZEN_STYLE_ID = 'repcheck-zen-style';
    let zenBoard = null;
    let zenPrevStyle = '';
    /** Chessables Annotations-Layer (`svg#drawings`: Pfeile, Kreise) — sein Stil vor dem Zen.
     *  null = noch nicht angefasst. */
    let zenPrevDrawingsStyle = null;
    let zenRescale = null;
    let zenApplied = 0;
    let zenPokeTimer = null;
    let zenBtnRef = null;
    let zenRefreshBtnRef = null;
    // Zen-only-Buttons (▸ Next, 💬 Kommentar-Panel) + gehobenes Panel-Element.
    let zenNextBtnRef = null;
    let zenAnalyseBtnRef = null;
    let zenHintBtnRef = null;
    let zenPanelBtnRef = null;
    let zenPanelEl = null;
    let zenPanelPrevStyle = '';
    /** Vorfahren, deren Stacking-Context/Containing-Block fürs Zen neutralisiert wurde: [{el, prev}]. */
    let zenLifted = [];

    function zenTarget() {
      return document.getElementById('board')
        || document.querySelector('[data-square]')?.closest('#board, [class*="chessboard"]')
        || document.querySelector('.cg-wrap, cg-container, [class*="cg-wrap"]')
        || null;
    }

    function zenActive() { return !!document.getElementById(ZEN_BACKDROP_ID); }

    // Chessables Resize-Handler (debounced) anstoßen, damit chessboard.js die
    // squareSize an die neue Brettgröße anpasst. Wird nur bei geänderter
    // Zielgröße gerufen → keine Event-Schleife mit dem eigenen resize-Listener.
    function zenPokeLayout() {
      if (zenPokeTimer) return;
      zenPokeTimer = setTimeout(() => {
        zenPokeTimer = null;
        window.dispatchEvent(new Event('resize'));
      }, 60);
    }


    /**
     * Chessables Annotations-Layer: `svg#drawings` — dort liegen Pfeile UND Feld-Kreise.
     *
     * Er ist ein GESCHWISTER des Bretts (beide unter `div.noScrollingWithFinger`) und deckt
     * sich im Normalfall exakt damit, weil er `position:absolute; left:0; top:0` im selben
     * positionierten Elternteil hat. Im Zen ziehen wir das Brett auf `position:fixed` — der
     * Layer bleibt zurueck. Gemessen am 08.08. (Snapshots mtpfeil/ohnepfeil): Brett bei
     * (152,13), Layer bei (1187,545), also 1035 px rechts und 532 px unter dem Brett. Der Pfeil
     * war die ganze Zeit im DOM (`<line stroke="#e02828" marker-end="url(#arrowhead-r)">`), nur
     * eben neben dem Brett — und mit `z-index:10` zusaetzlich unter unserem Backdrop.
     */
    function zenDrawingsLayer() {
      return document.getElementById('drawings');
    }

    /**
     * Brett (und Panel) liegen im Zen per position:fixed + z-index ÜBER dem Backdrop. Das trägt nur,
     * wenn KEIN Vorfahr einen eigenen Stacking-Context/Containing-Block aufmacht (transform, filter,
     * contain, container-type, will-change, positioniertes z-index, opacity<1, …). Sonst bleibt das
     * Brett in diesem Vorfahren gefangen: sein z-index gilt nur dort, das Backdrop (Kind von body) liegt
     * darüber → schwarzer Bildschirm, nur unsere Buttons sichtbar (Handy, 2026-08). Die Desktop-Kette
     * bis #root ist frei davon (Snapshot 08.08.), Chessables mobiles Layout nicht. Solche Vorfahren
     * werden für die Dauer des Zen neutralisiert (Inline-!important, beim Verlassen zurückgesetzt) —
     * die Layout-Verschiebung darunter deckt das Backdrop ohnehin ab. Kein DOM-Umbau (React!).
     */
    function zenLiftAncestors(node) {
      for (let el = node && node.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
        if (zenLifted.some((x) => x.el === el)) continue;
        const cs = getComputedStyle(el);
        const traps = cs.transform !== 'none' || cs.perspective !== 'none' || cs.filter !== 'none'
          || (cs.backdropFilter && cs.backdropFilter !== 'none')
          || (cs.contain && cs.contain !== 'none')
          || (cs.containerType && cs.containerType !== 'normal')
          || /transform|perspective|filter|contain/.test(cs.willChange || '')
          || (cs.zIndex !== 'auto' && cs.position !== 'static')
          || parseFloat(cs.opacity) < 1
          || cs.isolation === 'isolate'
          || (cs.mixBlendMode && cs.mixBlendMode !== 'normal')
          || (cs.clipPath && cs.clipPath !== 'none')
          || (cs.maskImage && cs.maskImage !== 'none');
        if (!traps) continue;
        zenLifted.push({ el, prev: el.getAttribute('style') });
        const st = el.style;
        for (const [p, v] of [['transform', 'none'], ['perspective', 'none'], ['filter', 'none'],
          ['backdrop-filter', 'none'], ['contain', 'none'], ['container-type', 'normal'], ['will-change', 'auto'],
          ['z-index', 'auto'], ['opacity', '1'], ['isolation', 'auto'], ['mix-blend-mode', 'normal'],
          ['clip-path', 'none'], ['mask-image', 'none']]) {
          st.setProperty(p, v, 'important');
        }
      }
    }

    function zenRestoreAncestors() {
      for (const { el, prev } of zenLifted) {
        if (prev) el.setAttribute('style', prev);
        else el.removeAttribute('style');
      }
      zenLifted = [];
    }

    function enterZen(btn) {
      const board = zenTarget();
      const rect = board && board.getBoundingClientRect();
      if (!board || !rect || !rect.width) { flash(btn, 'No board found', '#c62828'); return; }
      zenBoard = board;
      zenPrevStyle = board.getAttribute('style') || '';
      zenLiftAncestors(board);
      const backdrop = document.createElement('div');
      backdrop.id = ZEN_BACKDROP_ID;
      Object.assign(backdrop.style, { position: 'fixed', inset: '0', background: '#111', zIndex: '2147483600' });
      // Bewusst KEIN Klick-zum-Beenden: neben das Brett zu klicken passiert beim Training
    // staendig (Maus parken, versehentlicher Klick nach einem Zug) — dabei aus dem Vollbild zu
    // fliegen reisst aus der Konzentration. Raus geht es ueber ✕ oder Esc.
      document.body.appendChild(backdrop);
      // chessboard.js hängt die gezogene Schwebefigur an <body> — die muss ÜBER
      // das Backdrop, sonst ist die Figur während des Ziehens unsichtbar.
      // (.piece-417db ist eine chessboard.js-Konstante, kein generierter Hash.)
      if (!document.getElementById(ZEN_STYLE_ID)) {
        const st = document.createElement('style');
        st.id = ZEN_STYLE_ID;
        st.textContent = 'body > .piece-417db { z-index: 2147483620 !important; }';
        (document.head || document.documentElement).appendChild(st);
      }
      zenApplied = 0;
      zenRescale = () => {
        // Offenes Panel reserviert rechts Platz: das Brett wird entsprechend kleiner UND um
        // die halbe Reserve nach links gerückt, statt sich mit dem Panel zu überlappen.
        const reserve = zenReservedRight();
        const reserveBottom = zenReservedBottom();
        // Nie unter ein bedienbares Minimum: ein rechts angedocktes Panel liess auf dem Handy
        // (390 px breit, 304 px Reserve) ein Brett von ~80 px uebrig.
        const target = Math.max(160, Math.floor(0.97 * Math.min(window.innerWidth - reserve, window.innerHeight - reserveBottom)));
        if (zenPanelEl) zenPanelPlace(zenPanelEl);   // Geometrie folgt Drehung/Resize
        // !important, weil Chessables eigener Resize-Handler style.width neu
        // setzt (fit-height-Berechnung): unsere Größe muss gewinnen — sein
        // board.resize() liest danach die tatsächliche (= unsere) Breite und
        // zeichnet die Felder in der neuen Größe.
        const s = zenBoard.style;
        s.setProperty('position', 'fixed', 'important');
        s.setProperty('left', `calc(50% - ${Math.round(reserve / 2)}px)`, 'important');
        s.setProperty('top', `calc(50% - ${Math.round(reserveBottom / 2)}px)`, 'important');
        s.setProperty('margin', '0', 'important');
        s.setProperty('transform', 'translate(-50%, -50%)', 'important');
        s.setProperty('z-index', '2147483610', 'important');
        for (const p of ['width', 'height', 'max-width', 'max-height']) {
          s.setProperty(p, target + 'px', 'important');
        }
        if (target !== zenApplied) { zenApplied = target; zenPokeLayout(); }
        // Annotations-Layer mit dem Brett mitziehen (siehe zenDrawingsLayer): dieselbe
        // Geometrie, ueber dem Backdrop, und ohne Klicks abzufangen — Pfeile sind Anzeige.
        const dr = zenDrawingsLayer();
        if (dr) {
          if (zenPrevDrawingsStyle === null) zenPrevDrawingsStyle = dr.getAttribute('style') || '';
          const ds = dr.style;
          ds.setProperty('position', 'fixed', 'important');
          ds.setProperty('left', `calc(50% - ${Math.round(reserve / 2)}px)`, 'important');
          ds.setProperty('top', `calc(50% - ${Math.round(reserveBottom / 2)}px)`, 'important');
          ds.setProperty('margin', '0', 'important');
          ds.setProperty('transform', 'translate(-50%, -50%)', 'important');
          ds.setProperty('z-index', '2147483611', 'important');   // knapp ueber dem Brett
          ds.setProperty('pointer-events', 'none', 'important');
          ds.setProperty('width', target + 'px', 'important');
          ds.setProperty('height', target + 'px', 'important');
        }
      };
      zenRescale();
      // Kommentare/Züge standardmäßig AN: im Vollbild ist der freie Platz daneben sonst
      // ungenutzt, und genau diese Spalte will man beim Durcharbeiten sehen. 💬 schaltet sie
      // wieder aus. Nach zenRescale, damit die Brettbreite für die Spaltenbreite schon steht.
      if (!zenNarrow()) zenPanelShow(null, true);   // Handy: Platz reicht nicht fuer beides
      window.addEventListener('resize', zenRescale);
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
      updateZenButton();
    }


    function exitZen() {
      const bd = document.getElementById(ZEN_BACKDROP_ID);
      if (bd) bd.remove();
      document.getElementById(ZEN_STYLE_ID)?.remove();
      zenPanelHide();
      if (zenPokeTimer) { clearTimeout(zenPokeTimer); zenPokeTimer = null; }
      if (zenRescale) { window.removeEventListener('resize', zenRescale); zenRescale = null; }
      if (zenBoard) {
        if (zenPrevStyle) zenBoard.setAttribute('style', zenPrevStyle);
        else zenBoard.removeAttribute('style');
        zenBoard = null;
      }
      // Annotations-Layer zurueckgeben; Chessable rechnet ihn beim naechsten resize neu.
      if (zenPrevDrawingsStyle !== null) {
        const dr = zenDrawingsLayer();
        if (dr) {
          if (zenPrevDrawingsStyle) dr.setAttribute('style', zenPrevDrawingsStyle);
          else dr.removeAttribute('style');
        }
        zenPrevDrawingsStyle = null;
      }
      // Chessable-Layout zurück auf Normalgröße rechnen lassen (board.resize()).
      window.dispatchEvent(new Event('resize'));
      zenRestoreAncestors();
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      updateZenButton();
    }

    // ── Zen-Extras: ▸ Next-Klick + 💬 Kommentar-/Zugspalte ────────────────
    // Chessables eigener „Next"-Knopf liegt im Zen-Modus hinterm Backdrop —
    // der ▸-Button sucht ihn per Text und klickt ihn programmatisch (React
    // bekommt ein echtes click-Event, Sichtbarkeit spielt dafür keine Rolle).
    // Chessables eigener „Hint"-Knopf — im Zen ebenfalls hinterm Backdrop. Gleiche
  // Suche wie beim Next: per Text, klick programmatisch (React braucht keine Sichtbarkeit).
  function clickChessableHint(btn) {
    // Chessables Hint ist ein Icon-DIV [data-testid="squareHintButton"] (Glocke + „Hint") im
    // .board-footer — KEIN <button>. Primär per testid (klickt auch im Zen hinterm Backdrop),
    // Fallback Textsuche inkl. div[data-testid].
    let cand = document.querySelector('[data-testid="squareHintButton"]');
    if (!cand) {
      cand = [...document.querySelectorAll('button, a, [role="button"], div[data-testid]')].find((el) => {
        if (el.closest('#' + CONTAINER_ID)) return false;
        const t = (el.textContent || '').trim();
        if (!/^(hint|tipp)$/i.test(t)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    }
    if (cand) cand.click();
    else flash(btn, 'Kein „Hint" da', '#c62828');
  }

  function clickChessableNext(btn) {
      // Chessables Next ist [data-testid="nextLessonButton"] und traegt ZWEI Label-Spans
      // („Next variation" not-in-mobile + „Next" not-in-desktop) → textContent ist
      // „Next variationNext", die exakte Textsuche griff also nie. Primaer per testid
      // (klickt auch im Zen hinterm Backdrop); Fallback bleibt die Textsuche.
      let cand = document.querySelector('[data-testid="nextLessonButton"]');
      if (!cand) {
        cand = [...document.querySelectorAll('button, a, [role="button"]')].find((el) => {
          if (el.closest('#' + CONTAINER_ID)) return false;
          const t = (el.textContent || '').trim();
          if (!/^(next( variation| chapter| move| line)?|weiter)$/i.test(t)) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
      }
      if (cand) cand.click();
      else flash(btn, 'Kein „Next" da', '#c62828');
    }

    // Kommentar-/Zugspalte finden: die Geschwister-Spalte der Brett-Spalte im
    // Practice-Layout (row-practice__col*) mit dem meisten Text — dort wohnen
    // die Kommentare + Zugliste, die man sonst am Linienende sieht.
    function zenPanelTarget() {
      const board = zenBoard || zenTarget();
      const boardCol = board && board.closest('[class*="__col"]');
      const row = boardCol && boardCol.parentElement;
      if (!row) return null;
      let best = null;
      for (const el of row.children) {
        if (el === boardCol) continue;
        if (el.getBoundingClientRect().width < 120) continue;
        if (!best || (el.textContent || '').length > (best.textContent || '').length) best = el;
      }
      return best;
    }

    /** Panel-Breite — BEWUSST unabhängig von der Brettgröße. Sie aus dem Brett-Rect zu rechnen
     *  ging beim automatischen Öffnen schief: da hat Chessable das Brett noch nicht neu
     *  gelayoutet, das Rect ist veraltet, das Panel wurde zu breit und lag über dem Brett
     *  (erst Zu- und Wieder-Aufklappen sah richtig aus). */
    function zenPanelWidth() {
      return Math.round(Math.min(460, Math.max(280, window.innerWidth * 0.24)));
    }

    /** Schmal/hochkant (Handy): das Panel passt nicht NEBEN ein brauchbares Brett → es dockt unten an. */
    function zenNarrow() { return window.innerWidth < 720 || window.innerWidth < window.innerHeight; }
    function zenPanelHeightNarrow() { return Math.round(window.innerHeight * 0.34); }

    /** Platz, den das offene Panel rechts belegt (inkl. Abstand) — 0, wenn es zu ist oder unten sitzt. */
    function zenReservedRight() {
      return zenPanelEl && !zenNarrow() ? zenPanelWidth() + 24 : 0;
    }
    /** Platz, den das offene Panel UNTEN belegt (nur schmal/hochkant). */
    function zenReservedBottom() {
      return zenPanelEl && zenNarrow() ? zenPanelHeightNarrow() + 24 : 0;
    }

    /** Panel-Geometrie — rechts neben dem Brett (breit) bzw. unten drunter (schmal/hochkant). */
    function zenPanelPlace(panel) {
      const s = panel.style;
      s.setProperty('position', 'fixed', 'important');
      if (zenNarrow()) {
        s.setProperty('left', '12px', 'important');
        s.setProperty('right', '12px', 'important');
        s.setProperty('bottom', '12px', 'important');
        s.setProperty('top', 'auto', 'important');
        s.setProperty('transform', 'none', 'important');
        s.setProperty('width', 'auto', 'important');
        s.setProperty('max-height', zenPanelHeightNarrow() + 'px', 'important');
      } else {
        s.setProperty('top', '50%', 'important');
        s.setProperty('right', '12px', 'important');
        s.setProperty('left', 'auto', 'important');
        s.setProperty('bottom', 'auto', 'important');
        s.setProperty('transform', 'translateY(-50%)', 'important');
        s.setProperty('width', zenPanelWidth() + 'px', 'important');
        s.setProperty('max-height', '92vh', 'important');
      }
      s.setProperty('overflow-y', 'auto', 'important');
      s.setProperty('z-index', '2147483615', 'important');
      s.setProperty('margin', '0', 'important');
      s.setProperty('padding', '12px', 'important');
      s.setProperty('border-radius', '10px', 'important');
      s.setProperty('box-shadow', '0 4px 24px rgba(0,0,0,0.5)', 'important');
    }

    function zenPanelShow(btn, silent) {
      const panel = zenPanelTarget();
      // Beim AUTOMATISCHEN Öffnen (Zen-Start) nicht meckern: findet die Heuristik kein
      // Panel, soll der Nutzer einfach kein Panel sehen — keine Fehlermeldung am Knopf.
      if (!panel) { if (!silent) flash(btn, 'Kein Panel gefunden', '#c62828'); return; }
      zenPanelEl = panel;
      zenPanelPrevStyle = panel.getAttribute('style') || '';
      const s = panel.style;
      zenLiftAncestors(panel);   // dieselbe Stacking-Context-Falle wie beim Brett
      zenPanelPlace(panel);
      // Transparente Panels bekommen auf dem dunklen Backdrop einen zur
      // Textfarbe passenden Grund (helle Schrift → dunkel, dunkle → hell).
      const cs = getComputedStyle(panel);
      if (!cs.backgroundColor || cs.backgroundColor === 'transparent' || /rgba\([^)]*,\s*0\)\s*$/.test(cs.backgroundColor)) {
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cs.color || '');
        const lightText = m && (+m[1] + +m[2] + +m[3]) / 3 > 128;
        s.setProperty('background', lightText ? '#1e1e1e' : '#fafafa', 'important');
      }
      if (zenRescale) zenRescale();   // Brett auf den verbleibenden Platz rücken
    }

    function zenPanelHide() {
      if (!zenPanelEl) return;
      if (zenPanelPrevStyle) zenPanelEl.setAttribute('style', zenPanelPrevStyle);
      else zenPanelEl.removeAttribute('style');
      zenPanelEl = null;
      if (zenRescale) zenRescale();   // Brett bekommt den Platz zurück
    }

    function toggleZenPanel(btn) {
      if (zenPanelEl) zenPanelHide();
      else zenPanelShow(btn);
    }

    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && zenActive()) exitZen();
      else updateZenButton();   // Vollbild BETRETEN → Knopf wechselt auf „verlassen"
    });

    function updateZenButton() {
      if (zenBtnRef) {
      zenBtnRef.textContent = zenActive() ? '✕' : '⛶';
      zenBtnRef.title = zenActive() ? 'Vollbild verlassen (Esc)' : 'Brett bildschirmfüllend (Esc beendet)';
      }
      // Im Zen-Modus bleiben Exit, Refresh und die Zen-Extras (▸/💬) sichtbar;
      // beim Verlassen wieder die normalen zeigen, Zen-Extras verstecken.
      const wrap = document.getElementById(CONTAINER_ID);
      if (!wrap) return;
      // Refresh traegt im Zen nur das Icon — Beschriftungen haben dort nichts verloren.
      if (zenRefreshBtnRef) {
        zenRefreshBtnRef.textContent = zenActive() ? '⟳' : 'Refresh';
        if (zenActive()) Object.assign(zenRefreshBtnRef.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px' });
        else Object.assign(zenRefreshBtnRef.style, { fontSize: '', lineHeight: '', padding: '' });
      }
      for (const child of wrap.children) {
        const zenOnly = child === zenNextBtnRef || child === zenPanelBtnRef || child === zenAnalyseBtnRef || child === zenHintBtnRef;
        // Die Zug-Rueckmeldung bleibt im Zen sichtbar - sie ist dort der einzige Weg,
        // Overstudied/+XP zu sehen (Chessables eigene Anzeige liegt hinterm Backdrop).
        const keep = child === zenBtnRef || child === zenRefreshBtnRef || zenOnly || child.id === FEEDBACK_ID || child.id === POOL_ID;
        child.style.display = zenActive() ? (keep ? '' : 'none') : (zenOnly ? 'none' : '');
      }
    }

    // ---------- Verbleibende Linien im Trainingspool ----------
    //
    // Quelle ist die Zaehler-Plakette im AUSGEWAEHLTEN Tab der Chessable-Leiste. Gemessen am
    // 08.08. (Inspector-Snapshot):
    //   <button role="tab" aria-selected="true" id="tab-1">
    //     <span class="MuiTab-wrapper"><span class="sc-hlqNbq iXetOK">68</span><span>Review</span></span>
    //
    // Bewusst NICHT ueber die Klassen `sc-hlqNbq iXetOK` gesucht: styled-components erzeugt die
    // bei jedem Chessable-Deploy neu. Die Struktur ist stabil und sprachunabhaengig.

    const POOL_ID = 'repcheck-chessable-pool';
    let poolTimer = null;

    function trainingPoolRest() {
      const tab = document.querySelector('button[role="tab"][aria-selected="true"]');
      if (!tab) return null;
      for (const span of tab.querySelectorAll('span')) {
        if (span.children.length) continue;
        const t = (span.textContent || '').trim();
        if (/^\d{1,4}$/.test(t)) return parseInt(t, 10);
      }
      return null;
    }

    function renderPool() {
      const el = document.getElementById(POOL_ID);
      if (!el) return;
      const rest = trainingPoolRest();
      if (rest == null) { el.style.display = 'none'; hidePoolPanel(); return; }
      el.textContent = '\u23F3 ' + rest;
      el.title = 'Noch offen im aktuellen Trainingspool — klicken fuer Tagesbilanz und Hochrechnung';
      el.style.display = 'inline-flex';
    }

    // ---------- Klick auf den Pool-Zaehler: Tagesbilanz + Hochrechnung ----------
    // Im Userscript liegt die Tagesstatistik direkt im GM-Storage — keine Bruecke noetig.
    // Grundsatz: lieber ehrlich unscharf als scheingenau. Nach drei Linien ist ein Tagesschnitt
    // Rauschen; dann wird der Schnitt der Vortage genommen und das auch dazugeschrieben.
    const POOL_PANEL_ID = 'repcheck-chessable-pool-panel';
    const POOL_MIN_LINIEN = 5;

    function poolTagesdaten() {
      let days = [];
      try {
        const roh = (typeof GM_getValue === 'function' && GM_getValue('rcDailyStats')) || {};
        days = Array.isArray(roh.days) ? roh.days : [];
      } catch (e) { /* egal */ }
      const x = new Date(); const p2 = (n) => String(n).padStart(2, '0');
      const tag = `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`;
      const h = days.find((d) => d.d === tag) || { s: 0, m: 0, l: 0 };
      const vortage = days.filter((d) => d.d !== tag && d.l > 0);
      const sum = vortage.reduce((a, d) => ({ s: a.s + d.s, l: a.l + d.l }), { s: 0, l: 0 });
      return {
        heute: { sekunden: h.s, zuege: h.m, linien: h.l, zuegeOk: h.mok || 0, linienOk: h.lok || 0 },
        schnitt: { tage: vortage.length, sekProLinie: sum.l ? Math.round(sum.s / sum.l) : null },
      };
    }

    function poolDauer(sek) {
      const m = Math.round(sek / 60);
      if (m < 60) return m + ' min';
      return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ' h';
    }
    function poolUhrzeit(inSek) {
      const d = new Date(Date.now() + inSek * 1000);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    function poolZeile(label, wert) {
      return '<div style="display:flex;gap:14px;justify-content:space-between"><span>' + label
        + '</span><span style="font-variant-numeric:tabular-nums">' + wert + '</span></div>';
    }

    function renderPoolPanel() {
      let el = document.getElementById(POOL_PANEL_ID);
      if (!el) {
        el = document.createElement('div');
        el.id = POOL_PANEL_ID;
        Object.assign(el.style, {
          position: 'fixed', bottom: '58px', right: '16px', zIndex: '2147483647',
          minWidth: '250px', maxWidth: '320px', background: 'rgba(0,0,0,0.88)', color: '#fff',
          borderRadius: '8px', padding: '10px 12px', font: '12px/1.55 system-ui, sans-serif',
          boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        });
        document.body.appendChild(el);
      }
      const rest = trainingPoolRest();
      const d = poolTagesdaten();
      const h = d.heute, sch = d.schnitt;
      const z = ['<div style="opacity:.7;margin-bottom:5px">Trainingspool</div>'];
      z.push(poolZeile('Noch offen', rest == null ? '—' : rest + ' Linien'));
      z.push(poolZeile('Heute geschafft', h.linien + ' Linien'));
      const heuteSchnitt = h.linien > 0 ? Math.round(h.sekunden / h.linien) : null;
      if (heuteSchnitt != null) {
        const proZug = h.zuege > 0 ? ' · ' + (h.sekunden / h.zuege).toFixed(0) + ' s/Zug' : '';
        z.push(poolZeile('Ø je Linie heute', heuteSchnitt + ' s' + proZug));
      }
      if (h.linien > 0) {
        // Richtig = kein Fehlzug, kein Aufgeben, kein Zeitablauf; ein akzeptierter
        // Alternativzug zaehlt NICHT als Fehler.
        const quote = Math.round((h.linienOk / h.linien) * 100);
        const zq = h.zuege > 0 ? ' · ' + Math.round((h.zuegeOk / h.zuege) * 100) + ' % Zuege' : '';
        z.push(poolZeile('Genauigkeit heute', quote + ' % (' + h.linienOk + '/' + h.linien + ')' + zq));
      }
      if (h.sekunden > 0) z.push(poolZeile('Aktive Zeit heute', poolDauer(h.sekunden)));

      let basis = null, basisText = '';
      if (heuteSchnitt != null && h.linien >= POOL_MIN_LINIEN) { basis = heuteSchnitt; basisText = 'Tagesschnitt'; }
      else if (sch.sekProLinie) {
        basis = sch.sekProLinie;
        basisText = 'Schnitt der letzten ' + sch.tage + (sch.tage === 1 ? ' Tag' : ' Tage');
      }
      z.push('<div style="border-top:1px solid rgba(255,255,255,.22);margin:7px 0 5px"></div>');
      if (rest == null) z.push('<div style="opacity:.75">Kein Pool-Zaehler auf der Seite gefunden.</div>');
      else if (rest === 0) z.push('<div>Pool leer — fuer heute durch. ✓</div>');
      else if (basis == null) z.push('<div style="opacity:.75">Fuer eine Hochrechnung fehlen noch Daten — nach ein paar Linien steht hier eine Schaetzung.</div>');
      else {
        const restSek = rest * basis;
        z.push(poolZeile('Rest ≈', poolDauer(restSek) + ' → ' + poolUhrzeit(restSek)));
        z.push('<div style="opacity:.6;margin-top:3px;font-size:11px">gerechnet mit ' + basis + ' s je Linie ('
          + basisText + ')' + (heuteSchnitt != null && h.linien < POOL_MIN_LINIEN
            ? ' — heute erst ' + h.linien + (h.linien === 1 ? ' Linie' : ' Linien') + ', dafuer zu wenig' : '') + '</div>');
        if (heuteSchnitt != null && sch.sekProLinie && h.linien >= POOL_MIN_LINIEN) {
          const diff = Math.round(((heuteSchnitt / sch.sekProLinie) - 1) * 100);
          if (Math.abs(diff) >= 8) {
            z.push('<div style="opacity:.6;font-size:11px">heute ' + Math.abs(diff) + ' % '
              + (diff > 0 ? 'langsamer' : 'schneller') + ' als sonst (' + sch.sekProLinie + ' s)</div>');
          }
        }
      }
      el.innerHTML = z.join('');
      el.style.display = 'block';
    }

    function togglePoolPanel() {
      const el = document.getElementById(POOL_PANEL_ID);
      if (el && el.style.display === 'block') { el.style.display = 'none'; return; }
      renderPoolPanel();
    }
    function hidePoolPanel() {
      const el = document.getElementById(POOL_PANEL_ID);
      if (el) el.style.display = 'none';
    }

    function createUi() {
      if (document.getElementById(CONTAINER_ID)) return;
      injectMobileStyle();
      const wrap = document.createElement('div');
      wrap.id = CONTAINER_ID;
      Object.assign(wrap.style, {
        position: 'fixed', bottom: '16px', right: '16px',
        zIndex: '2147483647', display: 'flex', gap: '8px',
      });

      // Rest-Zaehler des Trainingspools. Im Zen-Modus ist Chessables Tab-Leiste verdeckt —
      // deshalb spiegeln wir die Zahl hierher.
      const poolBadge = document.createElement('button');
      poolBadge.type = 'button';
      poolBadge.id = POOL_ID;
      poolBadge.addEventListener('click', togglePoolPanel);
      Object.assign(poolBadge.style, {
        display: 'none', alignItems: 'center', padding: '6px 9px', borderRadius: '6px',
        background: 'rgba(0,0,0,0.45)', color: '#fff', font: '12px/1 system-ui, sans-serif',
        whiteSpace: 'nowrap', alignSelf: 'center', border: 'none', cursor: 'pointer',
      });
      wrap.appendChild(poolBadge);

      // Zug-Rückmeldung (Overstudied / +XP). Liegt in UNSERER Leiste, weil Chessables eigene
      // Anzeige in `.board-footer` sitzt — im Zen-Modus hinter dem Backdrop. Klick öffnet die
      // Aufschlüsselung der Einzelbeträge dieser Linie.
      const feedbackBadge = document.createElement('button');
      feedbackBadge.id = FEEDBACK_ID;
      feedbackBadge.type = 'button';
      Object.assign(feedbackBadge.style, {
        display: 'none', alignItems: 'center', padding: '6px 10px', border: 'none',
        borderRadius: '6px', color: '#fff', font: '600 12px/1 system-ui, sans-serif',
        cursor: 'pointer', background: 'rgba(0,0,0,0.45)',
      });
      feedbackBadge.addEventListener('click', toggleFeedbackList);

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = 'Copy FEN';
      styleButton(copyBtn, '#2e7d32');
      copyBtn.addEventListener('click', () => {
        const fen = buildFEN();
        if (!fen) { flash(copyBtn, 'No board found', '#c62828'); debugDump(); return; }
        if (copyToClipboard(fen)) { flash(copyBtn, 'Copied!', '#1565c0'); console.log('[RepCheck Chessable]', fen); }
        else { flash(copyBtn, 'Copy failed', '#c62828'); console.log('[RepCheck Chessable] FEN (manual copy):', fen); }
      });

      const analyseBtn = document.createElement('button');
      analyseBtn.type = 'button';
      analyseBtn.textContent = 'Analyse';
      analyseBtn.title = 'Stellung in RookHub analysieren (neuer Tab)';
      styleButton(analyseBtn, '#00695c');
      // Geteilt mit dem Zen-Knopf (🔬): identisches Verhalten, nur ein anderes Gehaeuse.
      function openAnalysis(btn) {
        const fen = buildFEN();
        if (!fen) { flash(btn, 'No board found', '#c62828'); debugDump(); return; }
        let cfg = null;
        try { if (typeof GM_getValue !== 'undefined') cfg = GM_getValue('rookhubConfig', null); } catch (e) {}
        if (!cfg || !cfg.url) { flash(btn, 'Set RookHub URL', '#c62828'); return; }
        const orient = fen.split(' ')[1] === 'b' ? 'black' : 'white';   // Brett aus Sicht der Seite am Zug
        const url = String(cfg.url).replace(/\/$/, '') + '/analysis?fen=' + encodeURIComponent(fen) + '&orientation=' + orient;
        const win = window.open(url, '_blank', 'noopener');
        if (!win) flash(btn, 'Popup blocked', '#c62828');
      }
      analyseBtn.addEventListener('click', () => openAnalysis(analyseBtn));

      const searchBtn = document.createElement('button');
      searchBtn.type = 'button';
      searchBtn.textContent = 'Search FEN';
      styleButton(searchBtn, '#1565c0');
      searchBtn.addEventListener('click', () => {
        const fen = buildFEN();
        if (!fen) { flash(searchBtn, 'No board found', '#c62828'); debugDump(); return; }
        const win = window.open(chessableCourseSearchUrl(fen), '_blank', 'noopener');
        if (!win) flash(searchBtn, 'Popup blocked', '#c62828');
      });

      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.textContent = 'Refresh';
      refreshBtn.title = 'Seite neu laden';
      styleButton(refreshBtn, '#616161');
      refreshBtn.addEventListener('click', () => {
        // Chessable hängt im Training einen beforeunload-Handler ein („Seite verlassen?") — beim
        // bewusst geklickten Refresh ist der Dialog nur Reibung. Einmalig in der Capture-Phase
        // abfangen, bevor Chessables Handler dran ist (gleich wie in chessable-fen.js).
        window.addEventListener('beforeunload', (e) => { e.stopImmediatePropagation(); delete e.returnValue; }, { capture: true, once: true });
        location.reload();
      });

      const rememberBtn = document.createElement('button');
      rememberBtn.type = 'button';
      rememberBtn.textContent = 'Remember line';
      rememberBtn.title = 'Stellung in RookHub merken';
      styleButton(rememberBtn, '#6a1b9a');
      rememberBtn.addEventListener('click', () => rememberLine(rememberBtn));

      const fullscreenBtn = document.createElement('button');
      fullscreenBtn.type = 'button';
      fullscreenBtn.textContent = '⛶';   // kompaktes Vollbild-Symbol statt Text-Button
      fullscreenBtn.title = 'Brett bildschirmfüllend (Esc beendet)';
      styleButton(fullscreenBtn, '#37474f');
      Object.assign(fullscreenBtn.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px' });
      fullscreenBtn.addEventListener('click', () => { zenActive() ? exitZen() : enterZen(fullscreenBtn); });
      zenBtnRef = fullscreenBtn;
      zenRefreshBtnRef = refreshBtn;

      // Zen-only: ▸ klickt Chessables „Next", 💬 holt die Kommentar-/Zugspalte
      // vor das Backdrop. Außerhalb des Zen-Modus unsichtbar.
      const zNext = document.createElement('button');
      zNext.type = 'button';
      zNext.id = 'repcheck-zen-next';
      zNext.textContent = '▸';
      zNext.title = 'Next (nächste Variante/Kapitel)';
      styleButton(zNext, '#2e7d32');
      Object.assign(zNext.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px', display: 'none' });
      zNext.addEventListener('click', () => clickChessableNext(zNext));
      zenNextBtnRef = zNext;

      // Zen-only: 💡 klickt Chessables eigenen Hint-Knopf (liegt hinterm Backdrop).
      const zHint = document.createElement('button');
      zHint.type = 'button';
      zHint.id = 'repcheck-zen-hint';
      zHint.textContent = '💡';
      zHint.title = 'Hint (Chessable-Tipp)';
      styleButton(zHint, '#f9a825');
      Object.assign(zHint.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px', display: 'none' });
      zHint.addEventListener('click', () => clickChessableHint(zHint));
      zenHintBtnRef = zHint;

      // Zen-only: 🔬 oeffnet die aktuelle Stellung in der RookHub-Analyse (neuer Tab) —
      // draussen uebernimmt das der beschriftete Analyse-Knopf, im Zen gilt: nur Icons.
      const zAnalyse = document.createElement('button');
      zAnalyse.type = 'button';
      zAnalyse.id = 'repcheck-zen-analyse';
      zAnalyse.textContent = '🔬';
      zAnalyse.title = 'Stellung in RookHub analysieren (neuer Tab)';
      styleButton(zAnalyse, '#00695c');
      Object.assign(zAnalyse.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px', display: 'none' });
      zAnalyse.addEventListener('click', () => openAnalysis(zAnalyse));
      zenAnalyseBtnRef = zAnalyse;

      const zPanel = document.createElement('button');
      zPanel.type = 'button';
      zPanel.textContent = '💬';
      zPanel.title = 'Kommentare/Züge ein-/ausblenden';
      styleButton(zPanel, '#455a64');
      Object.assign(zPanel.style, { fontSize: '15px', lineHeight: '1', padding: '8px 10px', display: 'none' });
      zPanel.addEventListener('click', () => toggleZenPanel(zPanel));
      zenPanelBtnRef = zPanel;

      // XP-Anzeige vorerst deaktiviert (kommt später wieder) — Badge + Tracker aus.
      wrap.appendChild(feedbackBadge);
      wrap.appendChild(copyBtn);
      wrap.appendChild(analyseBtn);
      wrap.appendChild(searchBtn);
      wrap.appendChild(refreshBtn);
      wrap.appendChild(rememberBtn);
      wrap.appendChild(zHint);
      wrap.appendChild(zAnalyse);
      wrap.appendChild(zPanel);
      wrap.appendChild(zNext);
      wrap.appendChild(fullscreenBtn);
      document.body.appendChild(wrap);
    }

    // „Remember line": aktuelle FEN + Kontext an RookHub schicken (zum spaeteren
    // Gebrauch dort gespeichert). Config aus GM-Storage (origin-uebergreifend),
    // Egress per fetch (RookHub-CORS erlaubt chessable.com + POST).
    async function rememberLine(btn) {
      const fen = buildFEN();
      if (!fen) { flash(btn, 'No board found', '#c62828'); debugDump(); return; }
      let cfg = null;
      try { if (typeof GM_getValue !== 'undefined') cfg = GM_getValue('rookhubConfig', null); } catch (e) {}
      if (!cfg || !cfg.url || !cfg.token) { flash(btn, 'Not connected', '#c62828'); return; }
      const base = String(cfg.url).replace(/\/$/, '');
      const oldText = btn.textContent;
      btn.textContent = 'Saving…'; btn.disabled = true;
      // Autoritativen Kursnamen über den Chessable-Bearer bestimmen; bei Miss einmal frisch holen.
      // Bleibt er leer, löst der Server ihn aus dem gespeicherten Bearer des Users auf.
      const courseId = currentCourseId();
      let courseName = courseNameApi ? courseNameApi.apiCourseName(courseId) : null;
      if (!courseName && courseId && courseNameApi) {
        await courseNameApi.ensureCourseNames(true);
        courseName = courseNameApi.apiCourseName(courseId);
      }
      fetch(base + '/api/extension/remember-line', {
        method: 'POST', mode: 'cors',
        headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen, courseId, courseName, sourceUrl: location.href }),
      }).then((resp) => {
        btn.disabled = false; btn.textContent = oldText;
        flash(btn, resp.ok ? 'Remembered!' : 'Failed', resp.ok ? '#2e7d32' : '#c62828');
      }).catch(() => {
        btn.disabled = false; btn.textContent = oldText;
        flash(btn, 'Failed', '#c62828');
      });
    }

    // Seit v1.14.0: die FEN-Tools erscheinen NUR im Practice-Mode
    // (chessable.com/practice/…) — sonst nicht.
    function isPracticeMode() {
      return /^\/practice(\/|$)/.test(location.pathname);
    }

    function removeUi() {
      document.getElementById(CONTAINER_ID)?.remove();
      if (poolTimer) { clearInterval(poolTimer); poolTimer = null; }
      document.getElementById(POOL_PANEL_ID)?.remove();
      feedbackObserver?.disconnect();
      feedbackObserver = null;
      watchedFeedbackRoot = null;
      // Practice-Mode verlassen -> die Linie ist vorbei; Eintraege NICHT in die naechste Sitzung
      // mitschleppen.
      resetLineFeedback();
    }

    function ensureUi() {
      if (!isPracticeMode()) { removeUi(); return; }
      createUi();
      initFeedbackTracker();   // Zug-Rueckmeldung mitschneiden (Overstudied / +XP)
      attachLineResetListener();
      renderPool();
      if (!poolTimer) poolTimer = setInterval(renderPool, 3000);
    }

    if (document.body) ensureUi();
    else document.addEventListener('DOMContentLoaded', ensureUi, { once: true });

    // Verlaesst der User den Practice-Mode (SPA-Nav), wird die UI wieder entfernt.
    const mo = new MutationObserver(() => {
      if (!isPracticeMode()) { removeUi(); return; }
      if (!document.getElementById(CONTAINER_ID)) ensureUi();
      else initFeedbackTracker();   // Notification-Knoten wird bei SPA-Wechseln ersetzt   // UI steht schon, Brett kommt bei Chessable oft später nach
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Tampermonkey/Greasemonkey-Menue: erscheint im Klick-Menue des
  // TM-Icons. Das ist der EINZIGE automatische Eingriff des Userscripts
  // beim Page-Load.
  if (typeof GM_registerMenuCommand !== 'undefined') {
    GM_registerMenuCommand(t('menu.check'), runCheckTrigger);
    GM_registerMenuCommand(t('menu.settings'), openSettingsTrigger);
  }

  // ─── Lightweight SPA-Navigation Watch ───────────────────────────────
  // Beobachtet NUR den <title>-Knoten und popstate-Events. Praktisch
  // kostenlos im Idle. Bei jeder Navigation: Floating-Button nur auf
  // Review-Seiten zeigen.
  function watchNavigation() {
    const observe = () => {
      const titleEl = document.querySelector('title');
      if (!titleEl) {
        setTimeout(observe, 250);
        return;
      }
      new MutationObserver(refreshFloatingButton).observe(titleEl, { childList: true });
    };
    observe();
    window.addEventListener('popstate', refreshFloatingButton);
  }

  watchNavigation();
  refreshFloatingButton();

  console.log('[RepertoireChecker] Userscript v1.11.0 loaded');
})();
