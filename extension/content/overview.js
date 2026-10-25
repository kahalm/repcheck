// content.js-Teil (Zerlegung Z37): Partien-Uebersicht auf chess.com (/member/<name>/games, Profil) und lichess
// (/@/<name>/all, Profil) — je Zeile ein Knopf „an RookHub schicken" bzw. ✓ mit Analyse-Stand (CLAUDE.md
// „Partien-Übersicht"). Eigener Zustand (overviewSeen, Backoff) bleibt hier; der Takt (OVERVIEW_SWEEP_MS) und das
// popstate-Ereignis haengen in content.js (watchNavigation).
//
// Laden: Manifest content_scripts, VOR content.js → self.RepCheckContent.overview; Abhaengigkeiten per init().
(function () {
  'use strict';

  // Wie content.js: laeuft content.js in diesem Tab schon (das Popup laedt die Manifest-Liste nach), nichts neu anlegen.
  if (window.__rdc_loaded) return;

  // Aus content.js und den anderen Teil-Dateien (init).
  let t, detectSiteKey, loadRookhubConfig, injectStyles;
  let rookhubKnownGames, rookhubSaveGame, rookhubAnalyzeSavedGame, fetchChessComHeaders, fetchLichessGame;

  // ─── Partien-Uebersicht: je Zeile „an RookHub schicken" ─────────────────
  // chess.com listet die Partien im Archiv (/member/<name>/games) und auf der Profilseite als
  // `.game-history-games-row`. Die Zeile ist ein Grid mit `subgrid`-Spalten (Schnappschuss 24.09.2026),
  // ein zusaetzliches Kind IM FLUSS wuerde das Raster verschieben. Der Knopf haengt deshalb in der
  // vorhandenen Aktionen-Zelle (`.game-history-games-actions`, dort stehen schon Herz und
  // Auswahlkaestchen); die kompakte Variante der Profilseite hat die Zelle nicht — dort haengt er
  // ABSOLUT positioniert oben rechts in der Zeile (die ist `position: relative`, das Raster bleibt
  // unberuehrt).
  const OVERVIEW_SWEEP_MS = 2500;
  // Laeuft eine Analyse, fragt der Durchgang ihren Stand in diesem Abstand neu — sonst stuende die
  // Sanduhr bis zum naechsten Seitenaufruf da, obwohl RookHub laengst fertig ist.
  const OVERVIEW_RUNNING_RECHECK_MS = 30000;
  const OVERVIEW_HOST_CLASS = 'rc-ov';
  // Externe Id → { id } wenn die Partie schon bei RookHub liegt, sonst null. Erspart die Abfrage bei
  // jedem Durchgang; ein eigener Versand traegt seinen Treffer direkt ein.
  const overviewSeen = new Map();
  let overviewBusy = false;
  // Gibt RookHub keine Auskunft (rookhubKnownGames → null), traegt der Durchgang nichts ein und fragt
  // erneut — fruehestens nach OVERVIEW_RETRY_BASE_MS, bei jedem weiteren Fehlschlag doppelt so spaet
  // (hoechstens OVERVIEW_RETRY_MAX_MS), damit ein ausgefallenes RookHub nicht alle 2,5 s gefragt wird.
  const OVERVIEW_RETRY_BASE_MS = 5000;
  const OVERVIEW_RETRY_MAX_MS = 120000;
  let overviewRetryAt = 0;
  let overviewFailures = 0;

  // Alle Partiezeilen der Seite mit ihrer chess.com-Id. Nur ZAHLEN-Ids: zwischen den Partielinks des
  // Schnappschusses standen auch /cheating, /partners und /chesscom. `slot` = die vorhandene
  // Aktionen-Zelle, in die der Knopf gehoert.
  function chessComGameRows() {
    const out = [];
    for (const row of document.querySelectorAll('.game-history-games-row')) {
      const link = row.querySelector('a[href*="/game/"]');
      const href = link ? (link.getAttribute('href') || '') : '';
      const m = href.match(/\/game\/(live|daily)\/(\d+)/);
      if (!m) continue;
      out.push({ row, id: m[2], daily: m[1] === 'daily', slot: row.querySelector('.game-history-games-actions') });
    }
    return out;
  }

  // lichess (`/@/<name>/all`, Profil): `article.game-row` mit deckendem `a.game-row__overlay`, dessen
  // Ziel `/<id8><spieler4>` ist — die Partie-Id sind die ersten ACHT Zeichen (dieselben, die
  // `getGameMeta` aus der Adresse liest). Eine Aktionen-Zelle gibt es dort nicht: der Knopf haengt
  // absolut oben rechts in der Zeile (Schnappschuss 24.09.2026: `position: relative`, 239 px hoch).
  function lichessGameRows() {
    const out = [];
    for (const row of document.querySelectorAll('.game-row')) {
      const link = row.querySelector('a.game-row__overlay, a[href^="/"]');
      const m = link && (link.getAttribute('href') || '').match(/^\/([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?:\/(?:white|black))?$/);
      if (!m) continue;
      out.push({ row, id: m[1], slot: null });
    }
    return out;
  }

  // Was je Plattform verschieden ist — der Rest des Durchgangs ist derselbe.
  const OVERVIEW_SITES = {
    chesscom: {
      source: 'chess.com',
      rows: chessComGameRows,
      headers: (entry) => fetchChessComHeaders(entry.id, entry.daily),
      url: (entry) => 'https://www.chess.com/game/' + (entry.daily ? 'daily/' : 'live/') + entry.id,
    },
    lichess: {
      source: 'lichess',
      rows: lichessGameRows,
      // Die Export-API liefert Zuege, Spieler, Wertungen, Ergebnis, Datum und Bedenkzeit in EINEM Abruf.
      headers: (entry) => fetchLichessGame(entry.id),
      url: (entry) => 'https://lichess.org/' + entry.id,
    },
  };

  function overviewHost(entry) {
    let host = entry.row.querySelector('.' + OVERVIEW_HOST_CLASS);
    if (host) return host;
    host = document.createElement('span');
    host.className = OVERVIEW_HOST_CLASS;
    if (entry.slot) entry.slot.appendChild(host);
    else { host.classList.add('rc-ov-loose'); entry.row.appendChild(host); }
    return host;
  }

  function overviewGameLink(cfg, rookhubId) {
    return rookhubId ? cfg.url.replace(/\/$/, '') + '/games/' + rookhubId : cfg.url.replace(/\/$/, '') + '/games';
  }

  // Schon uebertragen: ✓ (Link auf die Partie) und daneben der Stand der RookHub-Analyse — fertig 📈
  // (oeffnet sie, Genauigkeit im Tooltip), laeuft ⏳, nie gerechnet oder gescheitert ein 📈-KNOPF, der
  // sie anstoesst. Vorher stand nur das ✓, und „liegt bei RookHub" liess sich nicht von „ist dort
  // analysiert" unterscheiden (gemeldet 24.09.2026: „da fehlt noch das Icon fuer RookHub -> analyze").
  function paintOverviewKnown(host, cfg, state) {
    host.replaceChildren();
    const link = overviewGameLink(cfg, state && state.id);
    const done = document.createElement('a');
    done.className = 'rc-ov-done';
    done.textContent = '✓';
    done.href = link;
    done.target = '_blank';
    done.rel = 'noopener';
    done.title = t('overview.sent');
    done.addEventListener('click', (ev) => ev.stopPropagation());
    host.appendChild(done);
    host.appendChild(overviewAnalysisElement(host, cfg, state, link));
  }

  function overviewAnalysisStatus(state) {
    return (state && state.analysis && state.analysis.status) || null;
  }

  function overviewAnalysisElement(host, cfg, state, link) {
    const a = state && state.analysis;
    const status = overviewAnalysisStatus(state);
    if (status === 'done' || status === 'pending' || status === 'running') {
      const el = document.createElement('a');
      el.className = 'rc-ov-an';
      el.href = link;
      el.target = '_blank';
      el.rel = 'noopener';
      el.textContent = status === 'done' ? '📈' : '⏳';
      el.title = status === 'done' ? overviewDoneTitle(a) : overviewRunningTitle(a);
      el.addEventListener('click', (ev) => ev.stopPropagation());
      return el;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rc-ov-btn rc-ov-an-btn';
    btn.textContent = '📈';
    btn.title = t('overview.analyze');
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      startOverviewAnalysis(host, cfg, state, btn);
    });
    return btn;
  }

  function overviewDoneTitle(a) {
    const pct = (v) => (v == null ? '—' : Math.round(v) + ' %');
    return a.accuracyWhite == null && a.accuracyBlack == null
      ? t('overview.openAnalysis')
      : t('overview.openAnalysisAcc', { white: pct(a.accuracyWhite), black: pct(a.accuracyBlack) });
  }

  function overviewRunningTitle(a) {
    return a && a.total > 0
      ? t('overview.analyzingPct', { pct: Math.round(100 * (a.analyzed || 0) / a.total) })
      : t('overview.analyzing');
  }

  async function startOverviewAnalysis(host, cfg, state, btn) {
    if (!state || !state.id) return;
    btn.disabled = true;
    btn.textContent = '…';
    btn.title = t('overview.sending');
    try {
      await rookhubAnalyzeSavedGame(cfg, state.id);
      state.analysis = { status: 'pending', analyzed: 0, total: 0 };
      state.checkedAt = Date.now();
      paintOverviewKnown(host, cfg, state);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '✗';
      btn.title = (e && e.message) || t('overview.analyzeFailed');
      setTimeout(() => {
        if (!btn.isConnected) return;
        btn.textContent = '📈';
        btn.title = t('overview.analyze');
      }, 5000);
    }
  }

  function paintOverviewButton(host, cfg, entry, site) {
    host.replaceChildren();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rc-ov-btn';
    btn.textContent = '↗';
    btn.title = t('overview.send');
    // Die ganze Zeile ist ein Knopf (`role="button"`) und traegt darueber einen deckenden Link —
    // ohne beides zu stoppen navigiert der Klick weg, statt die Partie zu schicken.
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      sendOverviewGame(cfg, entry, host, btn, site);
    });
    host.appendChild(btn);
  }

  async function sendOverviewGame(cfg, entry, host, btn, site) {
    btn.disabled = true;
    btn.textContent = '…';
    btn.title = t('overview.sending');
    try {
      const h = await site.headers(entry);
      const moves = h && h.moves ? h.moves : [];
      if (!moves.length) throw new Error(t('tools.saveNoMoves'));
      const saved = await rookhubSaveGame(cfg, moves, {
        source: site.source,
        externalId: entry.id,
        white: h.white,
        black: h.black,
        result: h.result,
        playedAt: h.playedAt,
        whiteElo: h.whiteElo,
        blackElo: h.blackElo,
        timeControl: h.timeControl,
        sourceUrl: site.url(entry),
        // Aus der Uebersicht geschickte Partien sollen gleich gerechnet werden.
        analyze: true,
      });
      const state = { id: saved && (saved.id || saved.Id), analysis: { status: 'pending' }, checkedAt: Date.now() };
      overviewSeen.set(entry.id, state);
      paintOverviewKnown(host, cfg, state);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '✗';
      btn.title = (e && e.message) || t('overview.failed');
      setTimeout(() => {
        if (!btn.isConnected) return;
        btn.textContent = '↗';
        btn.title = t('overview.send');
      }, 5000);
    }
  }

  // Ein Durchgang ueber die Zeilen der Seite: unbekannte Ids einmal bei RookHub erfragen, dann je Zeile
  // Haekchen oder Knopf zeichnen. Laeuft im Takt, weil chess.com die Zeilen nachlaedt (Blaettern,
  // „mehr laden") ohne <title> oder Adresse zu aendern.
  async function syncOverviewGames() {
    const site = OVERVIEW_SITES[detectSiteKey()];
    if (overviewBusy || !site) return;
    const entries = site.rows();
    if (!entries.length) return;
    const cfg = await loadRookhubConfig().catch(() => null);
    if (!cfg || !cfg.url || !cfg.token) return;
    overviewBusy = true;
    try {
      injectStyles();
      const now = Date.now();
      // Unbekannte Ids — und die, deren Analyse laeuft und laenger nicht nachgefragt wurde.
      const faellig = [...new Set(entries.map(e => e.id))].filter((id) => {
        if (!overviewSeen.has(id)) return true;
        const st = overviewSeen.get(id);
        const status = overviewAnalysisStatus(st);
        return (status === 'pending' || status === 'running') && now - (st.checkedAt || 0) >= OVERVIEW_RUNNING_RECHECK_MS;
      });
      if (faellig.length && now >= overviewRetryAt) {
        // Der Endpunkt nimmt hoechstens 300 Ids; der Rest kommt im naechsten Durchgang.
        const batch = faellig.slice(0, 300);
        const known = await rookhubKnownGames(cfg, site.source, batch);
        if (known === null) {
          // Keine Auskunft: nichts eintragen — sonst hiesse jede Zeile bis zum Neuladen „nicht bei
          // RookHub", und eine laufende Analyse spraenge von ⏳ auf ↗. Spaeter erneut, mit Backoff.
          overviewFailures++;
          overviewRetryAt = now + Math.min(OVERVIEW_RETRY_MAX_MS, OVERVIEW_RETRY_BASE_MS * 2 ** (overviewFailures - 1));
        } else {
          overviewFailures = 0;
          overviewRetryAt = 0;
          const found = new Map();
          for (const g of known) {
            const ext = g && (g.externalId || g.ExternalId);
            if (ext) found.set(String(ext), { id: g.id || g.Id, analysis: g.analysis || g.Analysis || null, checkedAt: now });
          }
          for (const id of batch) overviewSeen.set(id, found.get(id) || null);
        }
      }
      for (const entry of entries) {
        if (!overviewSeen.has(entry.id)) continue;   // erst im naechsten Durchgang erfragt
        const host = overviewHost(entry);
        const state = overviewSeen.get(entry.id);
        const a = state && state.analysis;
        const stamp = entry.id + (state
          ? ':' + (state.id || '') + ':' + (overviewAnalysisStatus(state) || '') + ':' + ((a && a.analyzed) || 0)
          : ':neu');
        if (host.dataset.rcStamp === stamp && host.childElementCount) continue;
        host.dataset.rcStamp = stamp;
        if (state) paintOverviewKnown(host, cfg, state);
        else paintOverviewButton(host, cfg, entry, site);
      }
    } finally {
      overviewBusy = false;
    }
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckContent = self.RepCheckContent || {}).overview = {
    init(deps) {
      ({ t, detectSiteKey, loadRookhubConfig, injectStyles } = deps);
      ({ rookhubKnownGames, rookhubSaveGame, rookhubAnalyzeSavedGame, fetchChessComHeaders, fetchLichessGame } = deps);
    },
    OVERVIEW_SWEEP_MS, syncOverviewGames, chessComGameRows, lichessGameRows,
  };
})();
