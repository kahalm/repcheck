// content.js-Teil (Zerlegung Z37): RookHub-Aufrufe von chess.com/lichess aus — alle ueber den Background-Worker
// (`rookhub-fetch`, CORS-frei, Egress-Allowlist dort). Endpunkte: analyze-game, games, games/known,
// games/{id}/analyze; dazu der Teilen-Link einer gespeicherten Partie. Kein Zustand.
//
// Laden: Manifest content_scripts, VOR content.js → self.RepCheckContent.rookhubApi; `t` setzt content.js per init().
(function () {
  'use strict';

  // Wie content.js: laeuft content.js in diesem Tab schon (das Popup laedt die Manifest-Liste nach), nichts neu anlegen.
  if (window.__rdc_loaded) return;

  let t;   // Uebersetzer aus content.js (init)

  // ─── RookHub Fetch ──────────────────────────────────────────────────
  // Server-seitige Partie-Analyse: kein Vorab-Pull des Repertoires noetig.
  // Fetch laeuft ueber den Background-Service-Worker — der hat `host_permissions`
  // und ist nicht an die Page-CORS-Policy gebunden. Das macht die Extension
  // robust gegenueber RookHub-Instanzen, deren CORS-Policy chess.com nicht
  // explizit erlaubt.
  function rookhubProxy(req) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          Object.assign({ type: 'rookhub-fetch' }, req),
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
              return;
            }
            if (!response) {
              reject(new Error(t('err.noBackground')));
              return;
            }
            resolve(response);
          }
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  // POST /api/extension/analyze-game. Antwort:
  // { deviation, gaps, inRepertoire, fenBeforeDeviation, repertoireFileCount, illegalMoveAt }.
  async function rookhubAnalyzeGame(cfg, moves, options) {
    if (!cfg || !cfg.url || !cfg.token) throw new Error(t('err.urlTokenMissing'));
    const url = cfg.url.replace(/\/$/, '') + '/api/extension/analyze-game';
    const resp = await rookhubProxy({
      url,
      method: 'POST',
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
      expect: 'json',
    });
    if (resp.status === 401) throw new Error(t('err.tokenInvalid'));
    if (!resp.ok) throw new Error(resp.error || t('err.rookhubHttp', { status: resp.status }));
    return resp.body;
  }

  // Schickt die SAN-Zugliste + Best-Effort-Metadaten; der Server baut daraus das PGN
  // (reicheres Format als ein vorgebautes PGN: Spieler/Ergebnis/Game-ID für Dedup + Anzeige).
  async function rookhubSaveGame(cfg, moves, meta) {
    if (!cfg || !cfg.url || !cfg.token) throw new Error(t('err.urlTokenMissing'));
    const url = cfg.url.replace(/\/$/, '') + '/api/extension/games';
    const resp = await rookhubProxy({
      url,
      method: 'POST',
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
        // Bedenkzeit in der Schreibweise der Plattform („180+2"); RookHub >= 0.526.0 zeigt sie in der
        // Partienliste, aeltere ignorieren das Feld.
        timeControl: meta.timeControl,
        // Aus der Uebersicht gesendete Partien sollen gleich gerechnet werden (RookHub >= 0.524.0;
        // aeltere ignorieren das Feld, die Partie ist trotzdem gespeichert).
        analyze: !!meta.analyze,
      }),
      expect: 'json',
    });
    if (resp.status === 401) throw new Error(t('err.tokenInvalid'));
    if (!resp.ok) throw new Error(resp.error || t('err.rookhubHttp', { status: resp.status }));
    return resp.body;
  }

  /**
   * Welche dieser Partien liegen schon bei RookHub? `[]` heisst „keine davon" — auch bei einer aelteren
   * RookHub-Version, die den Endpunkt nicht kennt (404), dann bleiben eben alle Knoepfe stehen. `null`
   * heisst „keine Auskunft" (Netzfehler, 401, 5xx, kaputte Antwort): der Aufrufer merkt sich dann nichts
   * und fragt spaeter erneut. Bis v1.68.8 war auch das `[]`, und ein kurzer 502 liess jede Zeile bis zum
   * Neuladen als „nicht bei RookHub" stehen (↗ statt ✓/📈).
   */
  async function rookhubKnownGames(cfg, source, ids) {
    if (!cfg || !cfg.url || !cfg.token || !ids.length) return [];
    try {
      const resp = await rookhubProxy({
        url: cfg.url.replace(/\/$/, '') + '/api/extension/games/known',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + cfg.token,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ source, externalIds: ids }),
        expect: 'json',
      });
      if (resp && resp.status === 404) return [];
      return resp && resp.ok && Array.isArray(resp.body) ? resp.body : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * „In RookHub analysieren" fuer eine Partie, die schon dort liegt (RookHub >= 0.528.0,
   * `POST /api/extension/games/{id}/analyze`). Wirft mit einer lesbaren Meldung: die Absage-Gruende
   * des Servers (`no-engine`, `too-many-open`) werden uebersetzt, statt eine Sanduhr vorzutaeuschen.
   */
  async function rookhubAnalyzeSavedGame(cfg, id) {
    const resp = await rookhubProxy({
      url: cfg.url.replace(/\/$/, '') + '/api/extension/games/' + encodeURIComponent(id) + '/analyze',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/json' },
      expect: 'json',
    });
    if (resp && resp.ok) return resp.body;
    const reason = resp && resp.body && resp.body.reason;
    if (reason === 'no-engine') throw new Error(t('overview.analyzeNoEngine'));
    if (reason === 'too-many-open') throw new Error(t('overview.analyzeTooMany'));
    if (resp && resp.status === 401) throw new Error(t('err.tokenInvalid'));
    throw new Error(t('overview.analyzeFailed'));
  }

  // Öffentlicher Teilen-Link der gespeicherten Partie ({url}/g/{shareToken}).
  // saved = Server-Antwort von rookhubSaveGame (SavedGameDetailDto).
  function buildShareLink(cfg, saved) {
    const token = saved && (saved.shareToken || saved.ShareToken);
    if (!cfg || !cfg.url || !token) return '';
    return cfg.url.replace(/\/$/, '') + '/g/' + token;
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckContent = self.RepCheckContent || {}).rookhubApi = {
    init(deps) { ({ t } = deps); },
    rookhubProxy, rookhubAnalyzeGame, rookhubSaveGame, rookhubKnownGames, rookhubAnalyzeSavedGame, buildShareLink,
  };
})();
