// chessable-fen.js-Teil (Zerlegung Z38, MAIN-World): der ⏳-Zaehler — Linien, die im aktuellen Trainingspool noch
// offen sind (Zaehler-Plakette im ausgewaehlten Chessable-Tab) — und sein Panel mit Tagesbilanz und Hochrechnung
// (Tagesstatistik kommt per postMessage aus chessable-activity.js).
//
// Zustand: nur poolDaily. Seiteneffekt nur in installTagesBruecke().
// Laden: Manifest content_scripts (chessable.com, world: MAIN), VOR chessable-fen.js. Ablage unter self.RepCheckFen.<teil>
// nur fuer die Verdrahtung — chessable-fen.js nimmt den Namen danach wieder aus dem window der Seite.
(function () {
  'use strict';

  // Wie chessable-fen.js: laeuft die MAIN-World-Leiste in diesem Tab schon, nichts neu anlegen.
  if (window.__repcheckChessableFen) return;

  // Aus chessable-fen.js und den anderen Teilen (init).
  let buttonEnabled;

  // ---------- Verbleibende Linien im Trainingspool ----------
  //
  // Quelle ist die Zaehler-Plakette im AUSGEWAEHLTEN Tab der Chessable-Leiste. Gemessen am
  // 08.08. (Inspector-Snapshot):
  //   <button role="tab" aria-selected="true" id="tab-1">
  //     <span class="MuiTab-wrapper"><span class="sc-hlqNbq iXetOK">68</span><span>Review</span></span>
  //
  // Bewusst NICHT ueber die Klassen `sc-hlqNbq iXetOK` gesucht: styled-components erzeugt die
  // bei jedem Chessable-Deploy neu, ein Selektor darauf haelt keine Woche. Die Struktur
  // (role=tab, erste blattlose Kind-Span mit reiner Zahl) ist stabil und sprachunabhaengig —
  // die Beschriftung („Review") waere es nicht, die haengt an der Kontosprache.

  const POOL_ID = 'repcheck-chessable-pool';

  // ---------- Klick auf den Pool-Zähler: Tagesbilanz + Hochrechnung ----------
  //
  // Die Zahlen kommen aus der lokalen Tagesstatistik von chessable-activity.js (isolierte
  // Welt hat chrome.storage, wir hier nicht) über die vorhandene postMessage-Brücke.
  //
  // Grundsatz für die Hochrechnung: lieber ehrlich unscharf als scheingenau. Nach drei
  // Linien ist ein Tagesschnitt Rauschen — dann wird der Schnitt der Vortage genommen und
  // das auch dazugeschrieben. Gibt es beides nicht, steht da keine Zahl, sondern der Grund.

  const POOL_PANEL_ID = 'repcheck-chessable-pool-panel';
  /** Ab so vielen Linien gilt der Tagesschnitt als tragfähig. */
  const POOL_MIN_LINIEN = 5;
  let poolDaily = null;

  function poolFordereDaten() {
    try { window.postMessage({ __repcheck: 'request-daily' }, location.origin); } catch (e) { /* egal */ }
  }

  /** „1:23 h" bzw. „12 min" — Stunden erst, wenn es welche gibt. */
  function poolDauer(sekunden) {
    const m = Math.round(sekunden / 60);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ' h';
  }

  function poolUhrzeit(inSekunden) {
    const d = new Date(Date.now() + inSekunden * 1000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function poolZeile(label, wert, dezent) {
    return '<div style="display:flex;gap:14px;justify-content:space-between' + (dezent ? ';opacity:.7' : '') + '">'
      + '<span>' + label + '</span><span style="font-variant-numeric:tabular-nums">' + wert + '</span></div>';
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
    const h = (poolDaily && poolDaily.heute) || { sekunden: 0, zuege: 0, linien: 0 };
    const sch = (poolDaily && poolDaily.schnitt) || { tage: 0, sekProLinie: null };

    const zeilen = [];
    zeilen.push('<div style="opacity:.7;margin-bottom:5px">Trainingspool</div>');
    zeilen.push(poolZeile('Noch offen', rest == null ? '—' : rest + ' Linien'));
    zeilen.push(poolZeile('Heute geschafft', h.linien + ' Linien'));

    const heuteSchnitt = h.linien > 0 ? Math.round(h.sekunden / h.linien) : null;
    if (heuteSchnitt != null) {
      const proZug = h.zuege > 0 ? ' · ' + (h.sekunden / h.zuege).toFixed(0) + ' s/Zug' : '';
      zeilen.push(poolZeile('Ø je Linie heute', heuteSchnitt + ' s' + proZug));
    }
    if (h.linien > 0) {
      // Eine Linie gilt als richtig, wenn in ihr kein Fehlzug, kein Aufgeben und kein
      // Zeitablauf vorkam; ein akzeptierter Alternativzug zaehlt NICHT als Fehler.
      const quote = Math.round((h.linienOk / h.linien) * 100);
      const zugQuote = h.zuege > 0 ? ' · ' + Math.round((h.zuegeOk / h.zuege) * 100) + ' % Zuege' : '';
      zeilen.push(poolZeile('Genauigkeit heute', quote + ' % (' + h.linienOk + '/' + h.linien + ')' + zugQuote));
    }
    if (h.sekunden > 0) zeilen.push(poolZeile('Aktive Zeit heute', poolDauer(h.sekunden)));

    // Hochrechnung: Tagesschnitt, wenn er auf genug Linien beruht — sonst der Schnitt der
    // Vortage. Das Feld sagt immer dazu, worauf es sich stützt.
    let basis = null, basisText = '';
    if (heuteSchnitt != null && h.linien >= POOL_MIN_LINIEN) {
      basis = heuteSchnitt; basisText = 'Tagesschnitt';
    } else if (sch.sekProLinie) {
      basis = sch.sekProLinie;
      basisText = 'Schnitt der letzten ' + sch.tage + (sch.tage === 1 ? ' Tag' : ' Tage');
    }

    zeilen.push('<div style="border-top:1px solid rgba(255,255,255,.22);margin:7px 0 5px"></div>');
    if (rest == null) {
      zeilen.push('<div style="opacity:.75">Kein Pool-Zähler auf der Seite gefunden.</div>');
    } else if (rest === 0) {
      zeilen.push('<div>Pool leer — für heute durch. ✓</div>');
    } else if (basis == null) {
      zeilen.push('<div style="opacity:.75">Für eine Hochrechnung fehlen noch Daten — '
        + 'nach ein paar Linien steht hier eine Schätzung.</div>');
    } else {
      const restSek = rest * basis;
      zeilen.push(poolZeile('Rest ≈', poolDauer(restSek) + ' → ' + poolUhrzeit(restSek)));
      zeilen.push('<div style="opacity:.6;margin-top:3px;font-size:11px">gerechnet mit ' + basis
        + ' s je Linie (' + basisText + ')'
        + (heuteSchnitt != null && h.linien < POOL_MIN_LINIEN
          ? ' — heute erst ' + h.linien + (h.linien === 1 ? ' Linie' : ' Linien') + ', dafür zu wenig'
          : '') + '</div>');
      if (heuteSchnitt != null && sch.sekProLinie && h.linien >= POOL_MIN_LINIEN) {
        const diff = Math.round(((heuteSchnitt / sch.sekProLinie) - 1) * 100);
        if (Math.abs(diff) >= 8) {
          zeilen.push('<div style="opacity:.6;font-size:11px">heute ' + Math.abs(diff) + ' % '
            + (diff > 0 ? 'langsamer' : 'schneller') + ' als sonst (' + sch.sekProLinie + ' s)</div>');
        }
      }
    }
    el.innerHTML = zeilen.join('');
    el.style.display = 'block';
  }

  function togglePoolPanel() {
    const el = document.getElementById(POOL_PANEL_ID);
    if (el && el.style.display === 'block') { el.style.display = 'none'; return; }
    poolFordereDaten();     // Antwort rendert nach; wir zeigen sofort, was wir schon haben
    renderPoolPanel();
  }

  function hidePoolPanel() {
    const el = document.getElementById(POOL_PANEL_ID);
    if (el) el.style.display = 'none';
  }
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
    if (rest == null || !buttonEnabled('pool')) { el.style.display = 'none'; hidePoolPanel(); return; }
    el.textContent = '\u23F3 ' + rest;
    el.title = 'Noch offen im aktuellen Trainingspool — klicken fuer Tagesbilanz und Hochrechnung';
    el.style.display = 'inline-flex';
  }

  // Tagesstatistik aus der isolierten Welt (chessable-activity.js) fuer das Pool-Panel.
  function installTagesBruecke() {
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin || !e.data) return;
      if (e.data.__repcheck !== 'daily') return;
      poolDaily = e.data.daily || null;
      if (document.getElementById(POOL_PANEL_ID)) renderPoolPanel();
    });
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckFen = self.RepCheckFen || {}).pool = {
    init(deps) {
      ({ buttonEnabled } = deps);
    },
    POOL_ID, POOL_PANEL_ID, POOL_MIN_LINIEN, poolFordereDaten, poolDauer, poolUhrzeit, poolZeile, renderPoolPanel,
    togglePoolPanel, hidePoolPanel, trainingPoolRest, renderPool, installTagesBruecke,
  };
})();
