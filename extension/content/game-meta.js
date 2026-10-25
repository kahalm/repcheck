// content.js-Teil (Zerlegung Z37): Metadaten der Partie fuers Speichern — Ergebnis aus der Zugliste, Spieler/Elo aus
// og:title, kanonische Kopfdaten und Zuege von chess.com (Callback-API, TCN) bzw. lichess (Export-API), jeweils mit
// Wiederholung (fetchMetaWithRetry). Kein Zustand.
//
// Laden: Manifest content_scripts, VOR content.js → self.RepCheckContent.gameMeta; getAdapter/detectSiteKey setzt
// content.js per init().
(function () {
  'use strict';

  // Wie content.js: laeuft content.js in diesem Tab schon (das Popup laedt die Manifest-Liste nach), nichts neu anlegen.
  if (window.__rdc_loaded) return;

  // Shared-Core (lib/repertoire-text.js, per Manifest davor geladen) — wie in content.js.
  const { parsePgnText, chessComPlayedAt, lichessGameId, fetchMetaWithRetry } = (self.RepCheckLib || {});
  let getAdapter, detectSiteKey;   // aus content.js (init)

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

  // chessComPlayedAt (chess.com Date+EndTime → ISO): siehe Shared-Core (self.RepCheckLib).

  // Kanonische Header (Spieler/Ergebnis/Datum) zu einer chess.com-Game-ID über
  // die same-origin-Callback-API holen — die Analyse-Seite hat sie NICHT im
  // og:title. Best-effort: bei Fehler null, dann greift der og:title-Fallback.
  // Mit Wiederholung (fetchMetaWithRetry, Shared-Core): direkt nach Partieende war die Antwort manchmal noch leer.
  function fetchChessComHeaders(id, isDaily) {
    return fetchMetaWithRetry ? fetchMetaWithRetry(() => fetchChessComHeadersOnce(id, isDaily)) : fetchChessComHeadersOnce(id, isDaily);
  }

  async function fetchChessComHeadersOnce(id, isDaily) {
    try {
      const kind = isDaily ? 'daily' : 'live';
      const resp = await fetch(`https://www.chess.com/callback/${kind}/game/${id}`, { headers: { 'Accept': 'application/json' } });
      if (!resp.ok) return null;
      const data = await resp.json();
      const h = data && data.game && data.game.pgnHeaders;
      if (!h) return null;
      // Die ZUEGE liegen in derselben Antwort (`moveList`, TCN). Sie sind die verlaessliche Quelle: auf
      // der Analyseseite rendert chess.com im Review-Tab gar keine Zugliste, aus der sich lesen liesse
      // (gemeldet 2026-09-24). Unlesbar → leer, dann bleibt es bei der DOM-Auslese.
      const moveApi = (typeof self !== 'undefined' && self.RepCheckChessCom) || null;
      const moves = moveApi && typeof Chess === 'function'
        ? moveApi.sansFromTcn(data.game.moveList, Chess) : [];
      return {
        moves: moves.length ? moves : null,
        white: h.White ? String(h.White).slice(0, 120) : null,
        black: h.Black ? String(h.Black).slice(0, 120) : null,
        result: h.Result || null,
        playedAt: chessComPlayedAt(h),
        whiteElo: parseElo(h.WhiteElo),
        blackElo: parseElo(h.BlackElo),
        timeControl: h.TimeControl ? String(h.TimeControl).slice(0, 32) : null,
      };
    } catch (e) { return null; }
  }

  // Kanonische Partie-Daten (Spieler/Ergebnis/Elo/Datum + saubere SAN-Zugliste) zu einer
  // lichess-Game-ID über die same-origin Export-API holen. Zuverlässiger als der og:title
  // (Namen/Elo) UND die DOM-Zugauslese (die auf Analyse-/Study-Ansichten „…"-Lücken liefern
  // kann). Best-effort: bei Fehler null, dann greifen og:title + DOM-Züge als Fallback.
  function fetchLichessGame(id) {
    return fetchMetaWithRetry ? fetchMetaWithRetry(() => fetchLichessGameOnce(id)) : fetchLichessGameOnce(id);
  }

  async function fetchLichessGameOnce(id) {
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
        timeControl: hdr('TimeControl') ? hdr('TimeControl').slice(0, 32) : null,
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
      timeControl: null,
      moves: null,
    };
    try {
      if (site === 'lichess') {
        // Nur echte Partie-Adressen: auf dem Analysebrett (/analysis) oder /broadcast/… gibt es keine
        // Partie-Id — dort bleibt sie null, sonst fielen alle dort gespeicherten Partien bei RookHub
        // auf einen Datensatz zusammen.
        meta.externalId = lichessGameId(location.pathname);
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
        if (g.timeControl) meta.timeControl = g.timeControl;
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
        if (h.timeControl) meta.timeControl = h.timeControl;
        // Zuege aus chess.coms eigener Antwort schlagen die DOM-Auslese: sie sind vollstaendig, auch
        // wenn die Seite gerade keine Zugliste zeigt (Analyseseite, Review-Tab).
        if (h.moves && h.moves.length) meta.moves = h.moves;
      }
    }
    return meta;
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckContent = self.RepCheckContent || {}).gameMeta = {
    init(deps) { ({ getAdapter, detectSiteKey } = deps); },
    getGameResult, parseElo, splitNameElo, parsePlayersFromMeta,
    fetchChessComHeaders, fetchChessComHeadersOnce, fetchLichessGame, fetchLichessGameOnce, getGameMeta,
  };
})();
