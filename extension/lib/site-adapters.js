// Site-Adapter fuer chess.com und lichess (Zerlegung Z37, bis v1.73.1 in content.js). Jede Site exportiert
// dieselbe Schnittstelle: erkennt die Review-Seite, liefert die Zug-Knoten der Hauptlinie und liest daraus SAN
// (siehe CLAUDE.md „Site-Adapter"). Kein Zustand; `document`/`location` werden erst beim Aufruf gelesen.
//
// Wird per Manifest als Content-Script VOR content.js geladen (isolierte Welt) → `self.RepCheckSiteAdapters`;
// in Node (Tests) als Modul. Neue Plattform = neuer Eintrag in ADAPTERS.

(function (root) {
  'use strict';

  const LICHESS_FIGURINES = {
    '♔':'K','♕':'Q','♖':'R','♗':'B','♘':'N',
    '♚':'K','♛':'Q','♜':'R','♝':'B','♞':'N',
  };

  // Chess.com-Zugliste: die neue `wc-simple-move-list` traegt die Klasse `move-list` (Schnappschuss
  // 23.09.2026), aeltere Ansichten `.move-list`/`vertical-move-list`/`wc-move-list`.
  function chessComMoveList() {
    return document.querySelector('.move-list, vertical-move-list, wc-move-list');
  }

  const ADAPTERS = {
    chesscom: {
      test: (host) => host === 'www.chess.com' || host.endsWith('.chess.com') || host === 'chess.com',
      // Die Knoepfe gehoeren auf JEDE Partieseite, sobald chess.com die Partieanalyse anbietet
      // (Wunsch 23.09.2026): auf /game/<id> traf keine der beiden Pfad-Regeln, obwohl Zugliste und
      // Analyse-Knopf da sind. Erkannt wird der Knopf am ZIEL (`/analysis/game/…`) statt an seiner
      // Beschriftung — die ist uebersetzt („Partieanalyse" / „Game Review"). Die Zugliste muss dazu
      // wirklich Zuege fuehren: in der Partien-Liste verlinkt JEDE Zeile auf die Analyse, dort gaebe
      // es aber nichts zu pruefen.
      isReviewPage: () => {
        const url = location.pathname;
        if (url.includes('/analysis/game/') || url.includes('/game/review/')) return true;
        if (!document.querySelector('a[href*="/analysis/game/"]')) return false;
        const liste = chessComMoveList();
        return !!liste && !!liste.querySelector('.node');
      },
      getMoveListEl: () => chessComMoveList(),
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
        if (/^\/[A-Za-z0-9]{8,12}(\/(white|black))?\/?$/.test(location.pathname)) return true;
        return !!document.querySelector('.tview2, .analyse__moves');
      },
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

  // ─── Export ──────────────────────────────────────────────────────────
  const api = { LICHESS_FIGURINES, chessComMoveList, ADAPTERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RepCheckSiteAdapters = api;
})(typeof self !== 'undefined' ? self : this);
