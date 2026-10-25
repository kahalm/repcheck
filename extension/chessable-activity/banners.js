// chessable-activity.js-Teil (Zerlegung Z36): RepChecks Karten auf chessable.com, gestapelt in EINEM Halter
// #repcheck-banners unten links — „noch nicht mit RookHub verbunden", Zustimmung zum token-losen Versand der
// getReview-Linien, Update-Hinweis zu den Buttons (v1.59.0), Kurs-holen-Alarm bei unerwarteter Chessable-Antwort
// (Discord-Link) und „Kurs nicht in deinem Chessable-Konto".
//
// Zustand: nur der eigene (schon gezeigt/weggeklickt). Seiteneffekte nur in installVerbindenKarte()/installButtonsHinweis().
// Laden: Manifest content_scripts (chessable.com, isolierte Welt), VOR chessable-activity.js → self.RepCheckActivity.banners
(function () {
  'use strict';

  // Wie chessable-activity.js: laeuft die isolierte Welt in diesem Tab schon (das Popup laedt die Manifest-Liste nach),
  // nichts neu anlegen.
  if (window.__repcheckChessableActivity) return;

  // Aus chessable-activity.js und den anderen Teilen (init).
  let t, readConfig, bestCourseName, setReviewConsent, reviewPending, flushReviewLines;

  // ---- Gemeinsamer Platz für RepChecks Karten auf chessable.com ----
  // Mehrere Hinweise können gleichzeitig anstehen (Verbinden, Zustimmung, Update). Jeder mit eigenem
  // `position: fixed` an derselben Ecke lag über dem anderen — deshalb stapelt EIN Halter sie.
  const BANNER_HOST_ID = 'repcheck-banners';
  function bannerHost() {
    let host = document.getElementById(BANNER_HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = BANNER_HOST_ID;
      Object.assign(host.style, {
        position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483647', maxWidth: '360px',
        display: 'flex', flexDirection: 'column', gap: '10px',
      });
      document.body.appendChild(host);
    }
    return host;
  }
  function bannerCard(id) {
    const bar = document.createElement('div');
    bar.id = id;
    Object.assign(bar.style, {
      background: '#1e1e24', color: '#fff', padding: '14px 16px', borderRadius: '10px',
      boxShadow: '0 4px 24px rgba(0,0,0,.4)', font: '13px/1.45 system-ui, sans-serif',
    });
    return bar;
  }

  // ---- Ohne RookHub-Verbindung: bei jedem Seitenaufruf darauf hinweisen (v1.59.0) ----
  // Ohne Token kann RepCheck auf Chessable fast nichts: kein Kurs holen, keine ✓/○, keine Trainingszeit. Die Karte
  // kommt deshalb bei JEDEM Laden einer chessable.com-Seite, bis verbunden ist; „Später" blendet sie nur für diese
  // Seite aus. Verbunden wird auf der Willkommensseite (Schritt 1): dort gibt es Adresse, Rückmeldung und den
  // Anmelde-Wartezustand, was eine Karte im fremden Seiten-DOM nicht sauber leisten kann.
  const CONNECT_PROMPT_ID = 'repcheck-connect-prompt';
  let connectPromptDismissed = false;
  function isConnected(cfg) { return !!(cfg && cfg.url && cfg.token); }
  async function maybeShowConnectPrompt() {
    if (connectPromptDismissed || !document.body || document.getElementById(CONNECT_PROMPT_ID)) return;
    if (isConnected(await readConfig())) return;
    if (connectPromptDismissed || document.getElementById(CONNECT_PROMPT_ID)) return;
    const bar = bannerCard(CONNECT_PROMPT_ID);
    bar.style.borderLeft = '4px solid #2a8c4a';
    const title = document.createElement('div');
    title.textContent = t('connect.prompt.title');
    Object.assign(title.style, { fontWeight: '600', marginBottom: '4px' });
    const msg = document.createElement('div');
    msg.textContent = t('connect.prompt.body');
    msg.style.marginBottom = '10px';
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
    const later = document.createElement('button');
    later.type = 'button'; later.textContent = t('connect.prompt.later'); styleConsentBtn(later, 'transparent', '#bbb', true);
    const go = document.createElement('button');
    go.type = 'button'; go.textContent = t('connect.prompt.connect'); styleConsentBtn(go, '#2a8c4a', '#fff', false);
    later.addEventListener('click', () => { connectPromptDismissed = true; bar.remove(); });
    go.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'rc-open-welcome', section: 'connect' }, () => void chrome.runtime.lastError); } catch (e) {}
      connectPromptDismissed = true;
      bar.remove();
    });
    row.appendChild(later); row.appendChild(go);
    bar.appendChild(title); bar.appendChild(msg); bar.appendChild(row);
    bannerHost().prepend(bar);   // ganz oben im Stapel: ohne Verbindung ist das der wichtigste Hinweis
  }
  let consentPromptShown = false;   // je Session nur einmal einblenden
  function styleConsentBtn(btn, bg, fg, bordered) {
    Object.assign(btn.style, {
      background: bg, color: fg, border: bordered ? '1px solid #555' : 'none',
      borderRadius: '6px', padding: '6px 12px', cursor: 'pointer', font: 'inherit',
    });
  }
  function showReviewConsentPrompt(targetUrl) {
    if (consentPromptShown) return;
    if (typeof document === 'undefined' || !document.body) return;
    consentPromptShown = true;
    let host; try { host = new URL(targetUrl).host; } catch (e) { host = String(targetUrl); }
    const bar = bannerCard('repcheck-review-consent');
    const msg = document.createElement('div');
    msg.textContent = t('review.consent.body', { host });
    msg.style.marginBottom = '10px';
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
    const no = document.createElement('button');
    no.type = 'button'; no.textContent = t('review.consent.deny'); styleConsentBtn(no, 'transparent', '#bbb', true);
    const yes = document.createElement('button');
    yes.type = 'button'; yes.textContent = t('review.consent.allow'); styleConsentBtn(yes, '#3d7bfd', '#fff', false);
    no.addEventListener('click', () => { setReviewConsent('denied'); reviewPending.clear(); bar.remove(); });
    yes.addEventListener('click', () => { setReviewConsent('granted'); bar.remove(); flushReviewLines(); });
    row.appendChild(no); row.appendChild(yes);
    bar.appendChild(msg); bar.appendChild(row);
    bannerHost().appendChild(bar);
  }

  // ---- Hinweis nach dem Update auf v1.59.0: die Buttons unten rechts sind jetzt aus ----
  // Wer RepCheck vorher benutzt hat, sieht im Practice-Modus die Leiste plötzlich nicht mehr. Genau dort einmal
  // erklären und zum Einschalten führen. background.js setzt `rcButtonsNotice: 'pending'` beim Update; „OK",
  // „Buttons auswählen" oder eine gespeicherte Auswahl (Popup/Willkommensseite) setzen 'done'.
  const BUTTONS_NOTICE_ID = 'repcheck-buttons-notice';
  let buttonsNoticeState = 'unknown';   // 'unknown' → 'shown' | 'settled'
  function settleButtonsNotice() {
    try { chrome.storage.local.set({ rcButtonsNotice: 'done' }); } catch (e) {}
    document.getElementById(BUTTONS_NOTICE_ID)?.remove();
    buttonsNoticeState = 'settled';
  }
  function maybeShowButtonsNotice() {
    if (buttonsNoticeState !== 'unknown' || !/^\/practice(\/|$)/.test(location.pathname)) return;
    try {
      chrome.storage.local.get(['rcButtonsNotice', 'rookhubConfig'], (r) => {
        if (buttonsNoticeState !== 'unknown') return;
        if (!r || r.rcButtonsNotice !== 'pending') { buttonsNoticeState = 'settled'; return; }
        // Ohne Verbindung hat die Verbinden-Karte Vorrang; der Takt unten fragt weiter, der Hinweis kommt danach.
        if (!isConnected(r.rookhubConfig)) return;
        if (!document.body || document.getElementById(BUTTONS_NOTICE_ID)) return;
        buttonsNoticeState = 'shown';
        const bar = bannerCard(BUTTONS_NOTICE_ID);
        const msg = document.createElement('div');
        msg.textContent = t('notice.buttons.body');
        msg.style.marginBottom = '10px';
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
        const ok = document.createElement('button');
        ok.type = 'button'; ok.textContent = t('notice.buttons.ok'); styleConsentBtn(ok, 'transparent', '#bbb', true);
        const choose = document.createElement('button');
        choose.type = 'button'; choose.textContent = t('notice.buttons.choose'); styleConsentBtn(choose, '#2a8c4a', '#fff', false);
        ok.addEventListener('click', settleButtonsNotice);
        choose.addEventListener('click', () => {
          try { chrome.runtime.sendMessage({ type: 'rc-open-welcome', section: 'buttons' }, () => void chrome.runtime.lastError); } catch (e) {}
          settleButtonsNotice();
        });
        row.appendChild(ok); row.appendChild(choose);
        bar.appendChild(msg); bar.appendChild(row);
        bannerHost().appendChild(bar);
      });
    } catch (e) {}
  }
  // Ohne Verbindung bei jedem Seitenaufruf; ein Verbinden in einem anderen Tab raeumt die Karte weg.
  function installVerbindenKarte() {
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.rookhubConfig && isConnected(ch.rookhubConfig.newValue)) {
          document.getElementById(CONNECT_PROMPT_ID)?.remove();
        }
      });
    } catch (e) {}
    maybeShowConnectPrompt();
  }

  // Update-Hinweis zu den Buttons (nur /practice), mit Takt fuer die SPA-Navigation.
  function installButtonsHinweis() {
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.rcButtonsNotice && ch.rcButtonsNotice.newValue === 'done') {
          document.getElementById(BUTTONS_NOTICE_ID)?.remove();
          buttonsNoticeState = 'settled';
        }
      });
    } catch (e) {}
    // Chessable ist eine SPA: der Practice-Modus kann auch später per Navigation kommen.
    maybeShowButtonsNotice();
    const buttonsNoticeTimer = setInterval(() => {
      if (buttonsNoticeState !== 'unknown') { clearInterval(buttonsNoticeTimer); return; }
      maybeShowButtonsNotice();
    }, 3000);
  }

  const DISCORD_URL = 'https://discord.gg/wczc4BJtMf';
  const CRAWL_ALERT_ID = 'repcheck-crawl-alert';

  function showCrawlAlert(h) {
    if (!document.body) return;
    document.getElementById(CRAWL_ALERT_ID)?.remove();
    const bar = bannerCard(CRAWL_ALERT_ID);
    bar.style.borderLeft = '4px solid #e0a800';
    const absatz = (text, style) => {
      const d = document.createElement('div');
      d.textContent = text;
      Object.assign(d.style, { marginBottom: '8px' }, style || {});
      bar.appendChild(d);
    };
    absatz(t('import.unexpected.title'), { fontWeight: '600', marginBottom: '4px' });
    absatz(t('import.unexpected.body'));
    if (h.banned) {
      absatz(h.message ? t('import.unexpected.bannedMessage', { message: h.message }) : t('import.unexpected.bannedPage'));
    }
    // Seit RookHub 0.695.1 bekommen die Admins JEDE unerwartete Antwort gemeldet, nicht nur eine Sperre (07.10.2026).
    if (h.adminNotified) absatz(t('import.unexpected.adminsNotified'));
    if (h.saved) absatz(t('import.unexpected.saved', { count: h.saved }));
    absatz(h.detail, { color: '#9aa4b2', fontSize: '11px', wordBreak: 'break-word' });
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center' });
    const hide = document.createElement('button');
    hide.type = 'button'; hide.textContent = t('import.unexpected.dismiss'); styleConsentBtn(hide, 'transparent', '#bbb', true);
    hide.addEventListener('click', () => bar.remove());
    const discord = document.createElement('a');
    discord.href = DISCORD_URL; discord.target = '_blank'; discord.rel = 'noopener';
    discord.textContent = t('import.unexpected.discord');
    styleConsentBtn(discord, '#5865f2', '#fff', false);
    discord.style.textDecoration = 'none';
    row.appendChild(hide); row.appendChild(discord);
    bar.appendChild(row);
    bannerHost().prepend(bar);   // ganz oben: wichtiger als jeder andere Hinweis
  }

  // ---- Kurs nicht im Chessable-Konto (v1.65.1) ----
  // BOOK_NOT_OWNED ist eine klare Auskunft, keine Sperre: erklären, warum nichts geht, und was der Nutzer prüfen kann.
  // Kein rcCrawlAlert (das Popup soll vor dem nächsten Holen nicht nachfragen) und keine Meldung an RookHub.
  const NOT_OWNED_ID = 'repcheck-not-owned';

  function showNotOwned(bid, courseName) {
    const name = courseName || bestCourseName(bid) || ('#' + bid);
    const status = t('import.notOwned.status', { name });
    if (!document.body) return status;
    document.getElementById(NOT_OWNED_ID)?.remove();
    const bar = bannerCard(NOT_OWNED_ID);
    bar.style.borderLeft = '4px solid #5b8def';
    const absatz = (text, style) => {
      const d = document.createElement('div');
      d.textContent = text;
      Object.assign(d.style, { marginBottom: '8px' }, style || {});
      bar.appendChild(d);
    };
    absatz(t('import.notOwned.title'), { fontWeight: '600', marginBottom: '4px' });
    absatz(t('import.notOwned.body', { name }));
    absatz(t('import.notOwned.hint'));
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', justifyContent: 'flex-end' });
    const hide = document.createElement('button');
    hide.type = 'button'; hide.textContent = t('import.unexpected.dismiss'); styleConsentBtn(hide, 'transparent', '#bbb', true);
    hide.addEventListener('click', () => bar.remove());
    row.appendChild(hide);
    bar.appendChild(row);
    bannerHost().prepend(bar);
    return status;
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckActivity = self.RepCheckActivity || {}).banners = {
    init(deps) {
      ({ t, readConfig, bestCourseName, setReviewConsent, reviewPending, flushReviewLines } = deps);
    },
    BANNER_HOST_ID, bannerHost, bannerCard, CONNECT_PROMPT_ID, isConnected, maybeShowConnectPrompt, styleConsentBtn,
    showReviewConsentPrompt, BUTTONS_NOTICE_ID, settleButtonsNotice, maybeShowButtonsNotice, DISCORD_URL,
    CRAWL_ALERT_ID, showCrawlAlert, NOT_OWNED_ID, showNotOwned, installVerbindenKarte, installButtonsHinweis,
  };
})();
