// content.js-Teil (Zerlegung Z37): das Einstellungs-Panel auf chess.com/lichess („Ordner / PGN auf der Seite…" aus dem
// Popup) — Ordner waehlen, PGN einfuegen, Sprache, „Aktualisieren" gegen die GESPEICHERTE RookHub-Config. Bewusst
// ohne URL-/Token-Felder (CLAUDE.md „Sicherheit", test/rookhub-token-panel.test.js). Dazu die Statuszeile des Panels.
//
// Zustand: repertoirePositions, rcLang, rcGespeicherteSprache und lastGameMovesKey gehoeren content.js und laufen ueber
// das geteilte Zustandsobjekt S. Laden: Manifest content_scripts, VOR content.js → self.RepCheckContent.panel;
// Abhaengigkeiten per init().
(function () {
  'use strict';

  // Wie content.js: laeuft content.js in diesem Tab schon (das Popup laedt die Manifest-Liste nach), nichts neu anlegen.
  if (window.__rdc_loaded) return;

  // Aus content.js und den anderen Teil-Dateien (init).
  let S, t, rcAutoLang, PANEL_ID, runCheck;
  let loadRookhubConfig, rookhubAnalyzeGame, pickDirectory, loadRepertoireFromText;

  // Uebersetzten Text fuer die innerHTML-Vorlage des Panels entschaerfen.
  const RC_HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function rcEscHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => RC_HTML_ESCAPES[c]);
  }

  // Nach einem Sprachwechsel das offene Panel neu zeichnen (sonst blieben die
  // Texte bis zum naechsten Oeffnen stehen).
  function rcApplyLang() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.innerHTML = panelHtml();
    wirePanelEvents();
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


  function updateStatusText(text) {
    const el = document.getElementById('repcheck-status');
    if (el) el.textContent = text;
  }


  // Panel-Markup (reiner String, keine DOM-Nebenwirkungen).
  // KEINE URL-/Token-Felder (seit v1.68.2): das Panel haengt im DOM von chess.com/lichess, ein
  // Seiten-Skript koennte dort eine eigene Adresse eintragen und „Verbinden" klicken — der
  // gespeicherte rkh_-Token ginge dann an diese Adresse, und die Egress-Allowlist des Workers
  // (Origin von rookhubConfig.url) folgte ihr. Die Verbindung lebt allein im Popup.
  function panelHtml() {
    return `
      <h3>${rcEscHtml(t('panel.heading'))}</h3>
      <div style="margin-bottom: 12px;">
        <strong>${rcEscHtml(t('panel.rookhub'))}</strong><br>
        <span style="font-size:11px;color:#888;">${rcEscHtml(t('panel.connectInPopup'))}</span>
        <div style="margin-top:6px;">
          <button id="repcheck-rookhub-refresh" class="secondary">${rcEscHtml(t('panel.refresh'))}</button>
        </div>
      </div>
      <hr style="border-color:#444;margin:12px 0;">
      <div style="margin-bottom: 12px;">
        <strong>${rcEscHtml(t('panel.folder'))}</strong><br>
        <button id="repcheck-pick-dir">${rcEscHtml(t('panel.selectFolder'))}</button>
        <span id="repcheck-folder-info" style="font-size:12px;color:#888;margin-left:6px;">${rcEscHtml(S.repertoirePositions ? t('panel.folderLoaded') : t('panel.noFolder'))}</span>
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
        ${rcEscHtml(S.repertoirePositions ? t('panel.loaded') : t('panel.notLoaded'))}
      </div>
    `;
  }

  // Alle Panel-Buttons verdrahten.
  function wirePanelEvents() {
    // Sprachwahl: leerer Wert = Automatik. Der Wert wird GELÖSCHT statt als '' gespeichert,
    // damit die Browsersprache wieder greift.
    const langSel = document.getElementById('repcheck-lang');
    if (langSel) {
      langSel.value = S.rcGespeicherteSprache || '';
      langSel.addEventListener('change', () => {
        const wahl = langSel.value;
        S.rcGespeicherteSprache = wahl;
        try {
          if (wahl) chrome.storage.local.set({ rcLang: wahl });
          else chrome.storage.local.remove('rcLang');
        } catch (e) { /* Speicher nicht erreichbar — Wahl gilt für diese Seite */ }
        S.rcLang = self.RepCheckI18n.resolveLang(wahl || null, navigator.languages);
        rcApplyLang();
      });
    }

    document.getElementById('repcheck-pick-dir')?.addEventListener('click', async () => {
      await pickDirectory();
    });

    document.getElementById('repcheck-load-pgn').addEventListener('click', () => {
      const textarea = document.getElementById('repcheck-pgn-input');
      loadRepertoireFromText(textarea.value);
    });

    document.getElementById('repcheck-close').addEventListener('click', togglePanel);

    // Nur mit der GESPEICHERTEN Config (Popup/Worker): Adresse und Token kommen nie aus dem DOM.
    document.getElementById('repcheck-rookhub-refresh')?.addEventListener('click', async () => {
      const cfg = await loadRookhubConfig();
      if (!cfg) { updateStatusText(t('status.notConfigured')); return; }
      try {
        updateStatusText(t('status.refreshing'));
        await connectRookHub(cfg, { refresh: true });
        S.lastGameMovesKey = '';
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

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckContent = self.RepCheckContent || {}).panel = {
    init(deps) {
      ({ S, t, rcAutoLang, PANEL_ID, runCheck } = deps);
      ({ loadRookhubConfig, rookhubAnalyzeGame, pickDirectory, loadRepertoireFromText } = deps);
    },
    rcEscHtml, rcApplyLang, connectRookHub, updateStatusText, panelHtml, wirePanelEvents, togglePanel,
  };
})();
