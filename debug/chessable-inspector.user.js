// ==UserScript==
// @name         RepCheck Chessable-Inspector (Debug)
// @namespace    https://github.com/kahalm/repcheck
// @version      0.11.0
// @description  Diagnose-Werkzeug: sammelt Brett-DOM/Geometrie/Drag-Traces sowie Trainings-Zähler (DOM, React-State, Seiten-State, Netzwerk) auf chessable.com — und auf chess.com die Auszeichnung von Zugliste und Analyse-Knopf — als JSON (Zwischenablage + Download). NICHT für die Stores — nur zur Fehleranalyse.
// @match        https://www.chessable.com/*
// @match        https://chessable.com/*
// @match        https://www.chess.com/*
// @match        https://chess.com/*
// @match        https://lichess.org/*
// @grant        GM_addStyle
// @updateURL    https://raw.githubusercontent.com/kahalm/repcheck/master/debug/chessable-inspector.user.js
// @downloadURL  https://raw.githubusercontent.com/kahalm/repcheck/master/debug/chessable-inspector.user.js
// @run-at       document-idle
// ==/UserScript==

/*
 * Zweck: RepCheck-Features (Zen-Vollbild, FEN-Tools) arbeiten auf Chessables
 * fremdem React-DOM. Dieses Script zieht alles heraus, was man zur Analyse
 * braucht, OHNE DevTools-Handarbeit:
 *   [Snapshot]  – Brett-Ankerkette (Geometrie + relevante Computed-Styles),
 *                 Feld-/Figuren-Beispiele, getrimmtes outerHTML, Viewport/
 *                 Fullscreen-Zustand, Zähler-Kandidaten MIT Beschriftung,
 *                 React-Props+Hook-State, Seiten-State, Speicher-Schlüssel.
 *   [Record 6s] – zeichnet Pointer-Events + Style-/Klassen-Mutationen im
 *                 Brettbereich + Rechteck der bewegten Figur auf (fürs
 *                 Debuggen von Drag&Drop/Animationen: einfach während der
 *                 Aufnahme eine Figur ziehen).
 *   [Record 30s] – dasselbe über längere Zeit, gedacht für die Frage „woher
 *                 kommt der Trainingspool-Zähler": eine Linie zu Ende spielen
 *                 und weiterschalten, dann zeigen Netzwerk-Mitschnitt und
 *                 Zähler-Verlauf, welcher Wert sich mitbewegt.
 * Ergebnis wird in die Zwischenablage kopiert UND als .json heruntergeladen.
 *
 * WICHTIG (Datenschutz): der Dump wandert zum Entwickler. Der Chessable-Bearer
 * (localStorage `chessable.web.production.JWT`) und alles, was nach Token
 * aussieht, wird deshalb ZENSIERT — siehe `istGeheim`. Beim Ergänzen neuer
 * Sammler diese Regel mitziehen.
 */
(() => {
  'use strict';
  const PANEL_ID = 'repcheck-inspector-panel';
  if (document.getElementById(PANEL_ID)) return;
  // Auf chess.com laeuft NUR der chess.com-Sammler (die Chessable-Sammler greifen dort ins Leere).
  const AUF_CHESSCOM = /(^|\.)chess\.com$/i.test(location.hostname);
  const AUF_LICHESS = /(^|\.)lichess\.org$/i.test(location.hostname);

  // ── Datenschutz: nichts Geheimes in den Dump ────────────────────────────
  const GEHEIM_KEY = /(token|jwt|auth|secret|passwor|bearer|credential|cookie|api[-_]?key)/i;
  /** JWT-Form: drei base64url-Segmente. Fängt Tokens auch unter harmlosem Schlüsselnamen. */
  const JWT_FORM = /^[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/;

  function istGeheim(key, wert) {
    if (GEHEIM_KEY.test(String(key))) return true;
    const s = typeof wert === 'string' ? wert.trim() : '';
    return JWT_FORM.test(s) || /^Bearer\s+\S+/i.test(s);
  }
  function zensiert(wert) {
    return typeof wert === 'string' ? `«${wert.length} Zeichen zensiert»` : '«zensiert»';
  }
  /** Freitext (HTML, Response-Körper) von Token-artigen Zeichenfolgen befreien. */
  function zensiereText(text) {
    return String(text).replace(/[\w-]{12,}\.[\w-]{12,}\.[\w-]{12,}/g, '«JWT zensiert»');
  }

  // ── Brett-Anker (gleiche Heuristik wie chessable-fen.js) ────────────────
  function boardAnchor() {
    return document.getElementById('board')
      || document.querySelector('[data-square]')?.closest('#board, [class*="chessboard"]')
      || document.querySelector('.cg-wrap, cg-container, [class*="cg-wrap"]')
      || null;
  }

  /** Die Practice-Spalte: der Container, in dem Brett UND Trainer-Kopf/Fortschritt leben.
   *  Beleg aus den Dumps vom 08.08.: `row-practice row-practice--lesson-progress`. */
  function practiceRow() {
    const board = boardAnchor();
    return (board && board.closest('[class*="row-practice"]'))
      || document.querySelector('[class*="row-practice"]')
      || null;
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { left: +r.left.toFixed(1), top: +r.top.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) };
  }

  function kurzPfad(el, tiefe) {
    const teile = [];
    for (let p = el, i = 0; p && i < tiefe; p = p.parentElement, i++) {
      teile.push(p.tagName
        + (p.id ? '#' + p.id : '')
        + (p.className ? '.' + String(p.className).trim().split(/\s+/).slice(0, 2).join('.') : ''));
    }
    return teile.join(' < ');
  }

  function describe(el) {
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName, id: el.id || null,
      class: String(el.className).slice(0, 200) || null,
      rect: rectOf(el),
      offset: { width: el.offsetWidth, height: el.offsetHeight, left: el.offsetLeft, top: el.offsetTop },
      style: {
        position: cs.position, display: cs.display, zoom: cs.zoom, transform: cs.transform,
        width: cs.width, height: cs.height, overflow: cs.overflow, zIndex: cs.zIndex,
        transition: cs.transition.slice(0, 200), willChange: cs.willChange,
      },
      inlineStyle: (el.getAttribute('style') || '').slice(0, 500) || null,
    };
  }

  function snapshot() {
    const board = boardAnchor();
    const data = {
      kind: 'repcheck-inspector-snapshot',
      when: new Date().toISOString(),
      url: location.href,
      ua: navigator.userAgent,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      fullscreenElement: document.fullscreenElement
        ? document.fullscreenElement.tagName + '#' + (document.fullscreenElement.id || '-')
        : null,
      zenBackdrop: !!document.getElementById('repcheck-zen-backdrop'),
      boardFound: !!board,
      ancestors: [],
      squares: [],
      pieces: [],
      boardOuterHtml: null,
    };
    if (board) {
      let el = board;
      for (let i = 0; el && el !== document.documentElement && i < 10; i++) {
        data.ancestors.push(describe(el));
        el = el.parentElement;
      }
      // Beispiel-Felder (a1/h8-artige Extreme, falls auffindbar) + erste Figuren
      const squares = [...document.querySelectorAll('[data-square]')];
      for (const sq of [squares[0], squares[squares.length - 1]].filter(Boolean)) {
        data.squares.push({ ...describe(sq), html: sq.outerHTML.slice(0, 400) });
      }
      for (const pc of [...document.querySelectorAll('[data-piece], piece')].slice(0, 3)) {
        data.pieces.push({ ...describe(pc), html: pc.outerHTML.slice(0, 400) });
      }
      // 30.000 Zeichen reichten NICHT: der Schnitt lag mitten in Reihe 2, ein Overlay am Ende
      // des Bretts wäre systematisch unsichtbar geblieben. Kopf UND Ende mitnehmen.
      data.boardOuterHtml = board.outerHTML.slice(0, 120000);
      data.boardTailHtml = board.outerHTML.length > 120000 ? board.outerHTML.slice(-12000) : null;
      data.boardHtmlLength = board.outerHTML.length;
    }
    // Jeden Sammler EINZELN kapseln. Vorher riss ein einziger werfender Sammler den ganzen
    // Dump mit — der Knopf blieb stumm im Aufnahme-Zustand stehen und man wusste nicht, woran
    // es lag. Jetzt fehlt im schlimmsten Fall ein Feld, und der Fehler steht in `fehler`.
    data.fehler = [];
    const sammle = (name, fn) => {
      try { data[name] = fn(); } catch (e) { data.fehler.push({ wo: name, fehler: String(e).slice(0, 200) }); data[name] = null; }
    };
    sammle('overlays', () => collectOverlays(board));
    sammle('notification', () => collectNotification());
    sammle('xpAnzeigen', () => collectXpAnzeigen());
    sammle('progress', () => collectProgress(board));
    sammle('zaehler', () => collectZaehler());
    sammle('poolKandidat', () => collectPoolKandidat());
    sammle('practiceHtml', () => collectPracticeHtml());
    sammle('drawer', () => collectDrawer());
    sammle('seitenState', () => collectSeitenState());
    sammle('speicher', () => collectSpeicher());
    sammle('netzwerkBisher', () => collectResourceUrls());
    sammle('bodyChildren', () => [...document.body.children].slice(0, 40).map((el) => ({
      tag: el.tagName, id: el.id || null, class: String(el.className).slice(0, 80) || null,
      rect: rectOf(el), zIndex: getComputedStyle(el).zIndex, position: getComputedStyle(el).position,
    })));
    sammle('pageHtml', () => collectPageHtml());
    sammle('repcheckAnzeigen', () => collectRepcheckAnzeigen());
    return data;
  }

  /** GANZER Seiten-DOM — für UI-Platzierung auf LIST-Seiten (Kurs-/Kapitelübersicht), die die
   *  brett-fokussierten Sammler NICHT erfassen (bodyChildren ist nur 1 Ebene tief + gekappt). Geklont
   *  und entrümpelt: script/style/svg/canvas/link/noscript raus, das Brett (anderswo erfasst) und
   *  RepChecks EIGENE Overlays (`#repcheck-*`, `.rc-*`) raus, inline-`style` + `data:`-URIs raus —
   *  die Struktur bleibt (Tags, `class`, `id`, `href`, `data-*`, `oid`/`lid`), also genau die Anker
   *  fürs Overlay. JWTs zensiert. Kopf+Ende gedeckelt (Dev-Dump). */
  /** RepChecks EIGENE Anzeigen (✓/○-Marker, Zähler, Buttons) auf der echten, gestylten Seite vermessen. pageHtml
   *  entfernt sie bewusst (Ankersuche) und trägt kein CSS — sieht also weder sie noch ihr Aussehen. Hier je
   *  Element: Rechteck, sichtbar oder warum nicht, welcher Vorfahr mit overflow≠visible es abschneidet und wie viel
   *  davon übrig bleibt, tatsächliche Farbe/Schrift, Pfad. Dazu eine Zusammenfassung je rc-Klasse. */
  function collectRepcheckAnzeigen() {
    const alle = [...document.querySelectorAll('[class^="rc-"], [class*=" rc-"], [id^="repcheck-"]')]
      .filter((el) => !el.closest('#' + PANEL_ID));
    const vw = window.innerWidth, vh = window.innerHeight;
    const flaecheVon = (b) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
    const proKlasse = {};
    const elemente = alle.slice(0, 300).map((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const klasse = String(el.className || '').split(/\s+/).find((c) => c.startsWith('rc-')) || el.id || el.tagName;
      // Sichtfläche schrittweise mit jedem abschneidenden Vorfahren schneiden.
      let sicht = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      let abgeschnittenVon = null;
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.overflowX === 'visible' && pcs.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        const vorher = flaecheVon(sicht);
        sicht = { left: Math.max(sicht.left, pr.left), top: Math.max(sicht.top, pr.top),
          right: Math.min(sicht.right, pr.right), bottom: Math.min(sicht.bottom, pr.bottom) };
        if (flaecheVon(sicht) < vorher && !abgeschnittenVon)
          abgeschnittenVon = kurzPfad(p, 1) + ' (overflow ' + pcs.overflowX + '/' + pcs.overflowY + ')';
      }
      const flaeche = r.width * r.height;
      const sichtFlaeche = flaecheVon(sicht);
      const unsichtbarWeil = cs.display === 'none' ? 'display:none'
        : cs.visibility !== 'visible' ? 'visibility:' + cs.visibility
        : Number(cs.opacity) === 0 ? 'opacity:0'
        : flaeche === 0 ? 'Größe 0'
        : sichtFlaeche === 0 ? 'vollständig abgeschnitten' : null;
      const eintrag = {
        klasse,
        text: (el.textContent || '').trim().slice(0, 60),
        title: el.title || null,
        rect: rectOf(el),
        sichtbar: !unsichtbarWeil,
        unsichtbarWeil,
        sichtAnteil: flaeche ? +(sichtFlaeche / flaeche).toFixed(2) : 0,
        abgeschnittenVon,
        imViewport: r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw,
        stil: { color: cs.color, fontSize: cs.fontSize, fontWeight: cs.fontWeight, display: cs.display,
          whiteSpace: cs.whiteSpace, lineHeight: cs.lineHeight },
        pfad: kurzPfad(el, 5),
      };
      const k = proKlasse[klasse] || (proKlasse[klasse] = { anzahl: 0, sichtbar: 0, teilweiseAbgeschnitten: 0 });
      k.anzahl++;
      if (eintrag.sichtbar) k.sichtbar++;
      if (flaeche && eintrag.sichtAnteil < 1) k.teilweiseAbgeschnitten++;
      return eintrag;
    });
    return { gesamt: alle.length, proKlasse, elemente };
  }

  function collectPageHtml() {
    const body = document.body;
    if (!body) return { gefunden: false };
    const klon = body.cloneNode(true);
    const drop = 'script,style,noscript,svg,canvas,link,template,iframe,'
      + '#board,[class*="chessboard"],[data-square],'
      + '[id^="repcheck-"],[class^="rc-"],[class*=" rc-"]';
    for (const el of klon.querySelectorAll(drop)) el.remove();
    for (const el of klon.querySelectorAll('*')) {
      el.removeAttribute('style');
      for (const a of ['src', 'href', 'srcset', 'xlink:href']) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v && /^data:/i.test(v)) el.setAttribute(a, 'data:…');
      }
    }
    const html = zensiereText(klon.outerHTML);
    const HEAD = 500000, TAIL = 40000;
    return {
      gefunden: true,
      len: html.length,
      html: html.slice(0, HEAD),
      ende: html.length > HEAD ? html.slice(-TAIL) : null,
    };
  }

  // ── Sammler für die drei offenen Fragen ─────────────────────────────────

  /** Pfeil-/Markierungs-Layer: liegen sie IM Brett (dann Skalierungsfrage) oder daneben/am body
   *  (dann Stapel-/Geometriefrage)? Figuren-SVGs werden ausgeschlossen, die sind bekannt. */
  function collectOverlays(board) {
    const sel = 'svg, canvas, [class*="arrow" i], [class*="annot" i], [class*="circle" i],'
      + ' [class*="marker" i], [class*="draw" i], [class*="overlay" i], [class*="highlight" i]';
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('.piece-417db')) continue;          // Figuren-SVG, bekannt
      if (el.closest('#repcheck-inspector-panel')) continue;
      const path = [];
      for (let p = el, i = 0; p && i < 6; p = p.parentElement, i++) {
        path.push(p.tagName + (p.id ? '#' + p.id : '') + (p.className ? '.' + String(p.className).trim().split(/\s+/).slice(0, 3).join('.') : ''));
      }
      out.push({
        ...describe(el),
        imBrett: !!(board && board.contains(el)),
        pfad: path.join(' < '),
        html: el.outerHTML.slice(0, 600),
      });
      if (out.length >= 40) break;
    }
    return out;
  }

  /** Zug-Rückmeldung (XP / Overstudied / falsch): Wrapper, Eltern und React-Props. */
  function collectNotification() {
    const notif = document.querySelector('[data-testid="moveNotification"]');
    if (!notif) return { gefunden: false };
    const wrap = notif.closest('div') || notif;
    return {
      gefunden: true,
      text: notif.textContent,
      notifHtml: notif.outerHTML.slice(0, 1500),
      wrapperHtml: wrap.outerHTML.slice(0, 3000),
      elternHtml: wrap.parentElement ? wrap.parentElement.outerHTML.slice(0, 4000) : null,
      currentPoints: [...document.querySelectorAll('span.current-points')].map((e) => e.textContent),
      props: fiberProps(notif, 6),
    };
  }

  /** Alle XP-Anzeigen im Dokument — die Pro-Zug-Meldung UND die Gesamtsumme am Linienende
   *  (die soll aufklappbar werden). Blattknoten, damit nicht ganze Container mitkommen. */
  function collectXpAnzeigen() {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length) continue;
      if (el.closest('#repcheck-chessable-fen-tools, #repcheck-inspector-panel')) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 40) continue;
      if (!/(\d[\d.,]*\s*(XP|punkte|points)|overstud|korrekt|correct|incorrect|alternativ)/i.test(t)) continue;
      out.push({ text: t, pfad: kurzPfad(el, 5), rect: rectOf(el), testid: el.closest('[data-testid]')?.getAttribute('data-testid') || null });
      if (out.length >= 25) break;
    }
    return out;
  }

  /** Trainingspool, alte Fassung (bleibt für die Vergleichbarkeit mit den Dumps vom 08.08.). */
  function collectProgress(board) {
    const zahlen = [];
    const row = board && board.closest('.row-practice');
    if (row) {
      for (const el of row.querySelectorAll('*')) {
        if (el.closest('#repcheck-chessable-fen-tools')) continue;
        if (el.children.length) continue;                    // nur Blattknoten
        const t = (el.textContent || '').trim();
        if (!t || t.length > 24) continue;
        if (!/\d/.test(t)) continue;
        if (!/^\d+\s*\/\s*\d+$|^\d+\s*(von|of)\s*\d+$|^\d+%?$/.test(t)) continue;
        zahlen.push({ text: t, pfad: el.tagName + '.' + String(el.className).slice(0, 60), rect: rectOf(el) });
        if (zahlen.length >= 30) break;
      }
    }
    const bars = [...document.querySelectorAll('[role="progressbar"], progress')].map((el) => ({
      now: el.getAttribute('aria-valuenow'), max: el.getAttribute('aria-valuemax'),
      text: (el.textContent || '').trim().slice(0, 40), class: String(el.className).slice(0, 60),
    }));
    return { zahlen, bars, props: fiberProps(board, 40) };
  }

  // ── Trainingspool-Zähler: breiter suchen und BESCHRIFTEN ────────────────
  //
  // Warum die alte Fassung nichts fand (Messung 08.08.): sie nahm nur Blattknoten unter
  // `.row-practice`, die EXAKT „x/y", „x von y" oder „n%" hießen. Eine Zeile wie „180 XP" oder
  // „3 lines left" fiel damit durchs Raster. Gefunden wurden zwar nackte Zahlen (100 %, 1, 180
  // und ein 99er-SPAN) — aber ohne die umgebende Beschriftung ließ sich nicht sagen, was sie
  // bedeuten, weil der Snapshot außerhalb des Bretts gar kein HTML mitnahm. Genau diese zwei
  // Lücken schließen `collectZaehler` (Umfeld) und `collectPracticeHtml` (Struktur).

  /** Beschriftung rund um ein Element — erst damit wird aus „180" eine Aussage. */
  function umfeld(el) {
    const eltern = el.parentElement;
    const text = (n) => (n ? (n.textContent || '').trim().slice(0, 60) || null : null);
    return {
      pfad: kurzPfad(el, 5),
      testid: el.closest('[data-testid]')?.getAttribute('data-testid') || null,
      aria: el.getAttribute('aria-label') || el.closest('[aria-label]')?.getAttribute('aria-label') || null,
      titel: el.getAttribute('title') || el.closest('[title]')?.getAttribute('title') || null,
      vorher: text(el.previousElementSibling),
      nachher: text(el.nextElementSibling),
      elternText: eltern ? (eltern.textContent || '').trim().slice(0, 140) : null,
      grosselternText: eltern && eltern.parentElement
        ? (eltern.parentElement.textContent || '').trim().slice(0, 220) : null,
      sichtbar: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    };
  }

  /**
   * Gemeldeter Fundort des Pool-Zaehlers (Nutzer, 08.08.): `<span class="sc-hlqNbq iXetOK">68</span>`.
   * Die styled-components-Klassen (`sc-…`, `iXetOK`) sind BUILD-generiert und aendern sich mit
   * jedem Chessable-Deploy — als Selektor taugen sie also NICHT dauerhaft. Hier werden sie nur
   * benutzt, um den Knoten EINMAL zu finden und sein Umfeld vollstaendig mitzunehmen; daraus
   * laesst sich dann ein stabiler Anker (Beschriftung, data-testid, Position) ableiten.
   */
  function collectPoolKandidat() {
    const treffer = [];
    for (const el of document.querySelectorAll('span, div')) {
      if (el.children.length) continue;
      const t = (el.textContent || '').trim();
      if (!/^\d{1,4}$/.test(t)) continue;
      const cls = String(el.className);
      if (!/\bsc-[A-Za-z]/.test(cls)) continue;          // styled-components-Knoten
      const eltern = el.parentElement;
      treffer.push({
        text: t,
        class: cls.slice(0, 120),
        pfad: kurzPfad(el, 6),
        rect: rectOf(el),
        elternHtml: eltern ? eltern.outerHTML.slice(0, 1200) : null,
        grosselternHtml: eltern && eltern.parentElement ? eltern.parentElement.outerHTML.slice(0, 3000) : null,
      });
      if (treffer.length >= 30) break;
    }
    return treffer;
  }

  /** Jeder kurze Text mit einer Ziffer — dokumentweit, samt Umfeld. Brett-Koordinaten fliegen
   *  raus (die haben die Messung vom 08.08. zugemüllt). Bewusst großzügig: lieber 120 Kandidaten
   *  mit Beschriftung als 4 nackte Zahlen. */
  function collectZaehler() {
    const out = [];
    const row = practiceRow();
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length) continue;                       // nur Blattknoten
      if (el.closest('#repcheck-inspector-panel, #repcheck-chessable-fen-tools')) continue;
      if (el.closest('[class*="notation"], [data-square]')) continue;   // Brett-Koordinaten
      const t = (el.textContent || '').trim();
      if (!t || t.length > 32 || !/\d/.test(t)) continue;
      out.push({ text: t, imPracticeRow: !!(row && row.contains(el)), ...umfeld(el), rect: rectOf(el) });
      if (out.length >= 120) break;
    }
    return out;
  }

  /**
   * Move-Trainer-Drawer (`#mt-drawer`). WICHTIGSTER Anker für die Pool-Frage — und der Grund,
   * warum die bisherige Messung nichts fand: der Drawer hängt in `.MuiDrawer-root`, einem
   * SCHWESTER-Zweig neben `.row-practice`. Wer vom Brett aus sucht, kommt dort nie hin.
   *
   * Belegt aus den Dumps vom 08.08.: darin stecken `mt-drawer-content__chapter` (Kapiteltitel,
   * Klasse trägt `--active--is-review`) und `mt-drawer-content__variations__link` mit den
   * Attributen `oid`/`lid` sowie `#currentStudyingVariation` — also die Linien-Identität. Im
   * Review-Modus war nur EINE Variante gerendert (Höhen 60 + 52 = 112), der Pool stand also
   * nicht offen. Deshalb hier ALLES ungekürzt und strukturiert, statt wie bisher als auf 600
   * Zeichen beschnittenes Overlay-HTML.
   */
  function collectDrawer() {
    const drawer = document.getElementById('mt-drawer')
      || document.querySelector('[class*="mt-drawer"], [class*="sidebar-drawer"]');
    if (!drawer) return { gefunden: false };
    const kapitel = [...drawer.querySelectorAll('[class*="chapter"]')].slice(0, 60).map((el) => ({
      class: String(el.className).slice(0, 200),
      text: (el.textContent || '').trim().slice(0, 120),
      rect: rectOf(el),
      kinder: el.children.length,
    }));
    const linien = [...drawer.querySelectorAll('[class*="variations__link"], a[oid], [oid], [lid]')]
      .slice(0, 300).map((el) => ({
        class: String(el.className).slice(0, 200),
        oid: el.getAttribute('oid'), lid: el.getAttribute('lid'),
        text: (el.textContent || '').trim().slice(0, 100),
        rect: rectOf(el),
      }));
    const html = zensiereText(drawer.outerHTML);
    return {
      gefunden: true,
      id: drawer.id || null,
      class: String(drawer.className).slice(0, 200),
      rect: rectOf(drawer),
      // Wie viele Einträge gerendert sind, ist selbst schon die halbe Antwort: listet der Drawer
      // den ganzen Pool oder nur die laufende Linie?
      anzahlKapitel: kapitel.length,
      anzahlLinien: linien.length,
      aktuelleVariante: (document.getElementById('currentStudyingVariation') || {}).textContent || null,
      kapitel,
      linien,
      htmlLaenge: html.length,
      html: html.slice(0, 90000),
      ende: html.length > 90000 ? html.slice(-8000) : null,
    };
  }

  /** Struktur der Practice-Spalte OHNE das Brett (das ist separat und riesig). Ohne diesen
   *  Ausschnitt lassen sich die gefundenen Zahlen nicht einordnen. */
  function collectPracticeHtml() {
    const row = practiceRow();
    if (!row) return { gefunden: false };
    const klon = row.cloneNode(true);
    // Brett rauswerfen: es macht den Löwenanteil des HTML aus und ist anderswo schon erfasst.
    for (const b of klon.querySelectorAll('#board, [class*="chessboard"], [data-square]')) b.remove();
    const html = zensiereText(klon.outerHTML);
    return {
      gefunden: true,
      class: String(row.className).slice(0, 200),
      rect: rectOf(row),
      laengeOhneBrett: html.length,
      html: html.slice(0, 90000),
      ende: html.length > 90000 ? html.slice(-8000) : null,
    };
  }

  // ── React: Props UND Hook-State, auf- und abwärts ───────────────────────

  function fiberVon(el) {
    if (!el) return null;
    // Seit 0.10.1 laeuft das Skript in Tampermonkeys Sandbox (noetig wegen lichess' CSP). In Firefox
    // liegt davor eine Xray-Sicht, die Fremd-Eigenschaften wie `__reactFiber$…` verbirgt —
    // `wrappedJSObject` ist der Weg zum echten Element. In Chrome gibt es beides nicht, dort bleibt alles wie gehabt.
    const ziel = el.wrappedJSObject || el;
    try {
      const key = Object.keys(ziel).find((k) => k.startsWith('__reactFiber$'));
      return key ? ziel[key] : null;
    } catch (e) {
      return null;
    }
  }

  /** Props entlang der Fiber-Kette einsammeln — nur flache, plausible Schlüssel/Werte. */
  function fiberProps(el, depth) {
    const fiber0 = fiberVon(el);
    if (!fiber0) return null;
    const treffer = [];
    const interessant = /(remain|left|due|queue|pool|total|count|index|position|progress|line|variation|trainer|session|xp|point|overstud|correct|status|type)/i;
    let fiber = fiber0;
    for (let i = 0; fiber && i < depth; fiber = fiber.return, i++) {
      for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
        if (!props || typeof props !== 'object') continue;
        for (const [k, v] of Object.entries(props)) {
          if (!interessant.test(k)) continue;
          const t = typeof v;
          if (t === 'number' || t === 'boolean' || t === 'string') {
            treffer.push({ tiefe: i, key: k, wert: String(v).slice(0, 60) });
          } else if (Array.isArray(v)) {
            treffer.push({ tiefe: i, key: k, wert: 'Array(' + v.length + ')' });
          }
        }
      }
      if (treffer.length > 120) break;
    }
    // Duplikate (gleicher key+wert) zusammenfassen
    const gesehen = new Set();
    return treffer.filter((t) => {
      const id = t.key + '=' + t.wert;
      if (gesehen.has(id)) return false;
      gesehen.add(id); return true;
    }).slice(0, 60);
  }

  /** Ein einzelnes Fiber ausleuchten: Props FLACH (alle Schlüssel, nicht nur „interessante")
   *  und der Hook-State. Letzterer ist der eigentliche Nachbesserungspunkt — die Messung vom
   *  08.08. sah nur Props und fand deshalb ausschließlich `collapseMoveTrainerHeader`.
   *  React hält den Zustand einer Funktionskomponente aber in `memoizedState`, einer
   *  verketteten Liste von Hooks. */
  function fiberDetail(fiber, tiefe, richtung) {
    const name = typeof fiber.type === 'string' ? fiber.type
      : (fiber.type && (fiber.type.displayName || fiber.type.name)) || null;
    const eintrag = { tiefe, richtung, komponente: name, props: [], hooks: [] };

    const props = fiber.memoizedProps;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [k, v] of Object.entries(props).slice(0, 40)) {
        if (k === 'children') continue;
        const t = typeof v;
        if (t === 'number' || t === 'boolean') eintrag.props.push(k + '=' + v);
        else if (t === 'string') eintrag.props.push(k + '=' + (istGeheim(k, v) ? zensiert(v) : v.slice(0, 50)));
        else if (Array.isArray(v)) eintrag.props.push(k + '=Array(' + v.length + ')');
        else if (v && t === 'object') eintrag.props.push(k + '={' + Object.keys(v).slice(0, 12).join(',') + '}');
      }
    }

    let hook = fiber.memoizedState;
    for (let n = 0; hook && n < 30; hook = hook.next, n++) {
      const v = hook.memoizedState;
      const t = typeof v;
      if (t === 'number' || t === 'boolean') eintrag.hooks.push('#' + n + '=' + v);
      else if (t === 'string') eintrag.hooks.push('#' + n + '=' + (istGeheim('', v) ? zensiert(v) : v.slice(0, 60)));
      else if (Array.isArray(v)) eintrag.hooks.push('#' + n + '=Array(' + v.length + ')');
      else if (v && t === 'object') {
        // Nur Zahlen ausschreiben: genau die tragen einen Zähler.
        const keys = Object.keys(v).slice(0, 30);
        const zahlen = keys.filter((k) => typeof v[k] === 'number').map((k) => k + '=' + v[k]);
        eintrag.hooks.push('#' + n + '={' + keys.join(',') + '}' + (zahlen.length ? ' → ' + zahlen.join(' ') : ''));
      }
    }
    if (!eintrag.props.length && !eintrag.hooks.length) return null;
    return eintrag;
  }

  /** Fiber-Baum um einen Anker herum abgrasen: `auf` Ebenen nach oben (Richtung Wurzel) und
   *  bis `knoten` Fibers nach unten (Breitensuche über child/sibling). Nach unten zu gehen ist
   *  neu — der Zähler sitzt vermutlich im Trainer-Kopf, also NEBEN dem Brett, nicht darüber. */
  function fiberScan(el, auf, knoten) {
    const start = fiberVon(el);
    if (!start) return { gefunden: false };
    const aufwaerts = [];
    let f = start;
    for (let i = 0; f && i < auf; f = f.return, i++) {
      const d = fiberDetail(f, i, 'auf');
      if (d) aufwaerts.push(d);
    }
    const abwaerts = [];
    const queue = [[start, 0]];
    const gesehen = new Set();
    let besucht = 0;
    while (queue.length && besucht < knoten) {
      const [fib, tiefe] = queue.shift();
      if (!fib || gesehen.has(fib)) continue;
      gesehen.add(fib);
      besucht++;
      if (tiefe > 0) {
        const d = fiberDetail(fib, tiefe, 'ab');
        if (d) abwaerts.push(d);
      }
      if (tiefe < 12) {
        if (fib.child) queue.push([fib.child, tiefe + 1]);
        if (fib.sibling) queue.push([fib.sibling, tiefe]);
      }
    }
    return { gefunden: true, besuchteFibers: besucht, aufwaerts, abwaerts: abwaerts.slice(0, 80) };
  }

  /** Fiber an ALLEN drei Ankern abgrasen. Der Move-Trainer-Drawer haengt in einem
   *  SCHWESTER-Zweig neben `.row-practice` — vom Brett aus ist er ueber `fiber.return`
   *  unerreichbar. Genau daran ist die Messung vom 08.08. gescheitert. */
  function alleFiberScans() {
    const anker = [
      ['drawer', document.getElementById('mt-drawer') || document.querySelector('[class*="mt-drawer"]')],
      ['practiceRow', practiceRow()],
      ['board', boardAnchor()],
    ];
    const out = {};
    for (const [name, el] of anker) {
      out[name] = el ? fiberScan(el, 12, 400) : { gefunden: false };
    }
    return out;
  }

  // ── Seiten-State und Speicher ──────────────────────────────────────────

  /** Globaler Seiten-Zustand: bei React-Seiten hängt der Sitzungszustand oft komplett an einem
   *  bekannten Fenster-Objekt (Next.js `__NEXT_DATA__`, Redux, Apollo). */
  function collectSeitenState() {
    const out = { nextDataScript: null, globale: [], windowKeys: [] };
    const nd = document.getElementById('__NEXT_DATA__');
    if (nd) out.nextDataScript = zensiereText(nd.textContent || '').slice(0, 60000);

    for (const k of ['__NEXT_DATA__', '__APOLLO_STATE__', '__APOLLO_CLIENT__', '__REDUX_STATE__',
      '__INITIAL_STATE__', '__PRELOADED_STATE__', '__NUXT__', 'dataLayer', 'chessable']) {
      let v;
      try { v = window[k]; } catch (e) { continue; }
      if (v == null) continue;
      out.globale.push({
        key: k,
        typ: Array.isArray(v) ? 'Array(' + v.length + ')' : typeof v,
        keys: (typeof v === 'object' ? Object.keys(v).slice(0, 40) : null),
      });
    }
    try {
      out.windowKeys = Object.keys(window)
        .filter((k) => /(state|store|app|chessable|session|user|trainer|course|progress)/i.test(k))
        .slice(0, 60);
    } catch (e) { /* egal */ }
    return out;
  }

  /** Speicher-Schlüssel: Chessable legt Trainer-Zustand teilweise lokal ab. Werte werden
   *  gekürzt, Token-artiges wird ZENSIERT (der Dump geht an den Entwickler). */
  function collectSpeicher() {
    const lies = (store, name) => {
      const out = [];
      try {
        for (let i = 0; i < store.length && out.length < 60; i++) {
          const k = store.key(i);
          const v = store.getItem(k) || '';
          out.push({
            store: name, key: k, laenge: v.length,
            wert: istGeheim(k, v) ? zensiert(v) : zensiereText(v).slice(0, 200),
          });
        }
      } catch (e) {
        out.push({ store: name, key: '(nicht lesbar)', fehler: String(e).slice(0, 120) });
      }
      return out;
    };
    return [...lies(localStorage, 'local'), ...lies(sessionStorage, 'session')];
  }

  /** Schon gelaufene Chessable-Aufrufe — nur URLs (Körper gibt es rückwirkend nicht mehr).
   *  Zeigt, WELCHE Endpunkte überhaupt in Frage kommen; die Körper liefert die Aufnahme. */
  function collectResourceUrls() {
    try {
      return performance.getEntriesByType('resource')
        .map((e) => e.name)
        .filter((u) => /\/(api|graphql|ajax)\b|getList|getGame|getCourse|getHomeData|practice/i.test(u))
        .slice(-60)
        .map((u) => u.slice(0, 300));
    } catch (e) { return []; }
  }

  // ── Aufnahme: Pointer + Mutations + Figuren-Rects + Netzwerk + Zähler ───
  function record(seconds, done) {
    const board = boardAnchor();
    const row = practiceRow();
    const trace = {
      kind: 'repcheck-inspector-recording',
      when: new Date().toISOString(),
      url: location.href,
      seconds,
      fehler: [],
      pointer: [], mutations: [], pieceRects: [],
    };
    // `snapshot()` lief hier frueher UNGEKAPSELT und synchron im Klick-Handler: warf ein
    // Sammler, stand der Knopf schon auf „zeichnet auf" und die Aufnahme startete nie.
    // Genau so ist der 6-s- wie der 30-s-Knopf ausgefallen.
    try {
      trace.snapshotBefore = snapshot();
    } catch (e) {
      trace.snapshotBefore = null;
      trace.fehler.push({ wo: 'snapshotBefore', fehler: String(e).slice(0, 200) });
    }
    const t0 = performance.now();
    const ts = () => +(performance.now() - t0).toFixed(1);

    let lastMove = 0;
    const onPointer = (e) => {
      if (e.type === 'pointermove' || e.type === 'mousemove') {
        if (e.timeStamp - lastMove < 30) return;    // ~33 Hz reicht
        lastMove = e.timeStamp;
      }
      const t = e.target instanceof Element ? e.target : null;
      trace.pointer.push({
        t: ts(), type: e.type, x: e.clientX, y: e.clientY,
        target: t ? t.tagName + (t.id ? '#' + t.id : '') + ' ' + String(t.className).slice(0, 80) : null,
      });
    };
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup']) {
      document.addEventListener(ev, onPointer, { capture: true, passive: true });
    }

    // Zug-Rückmeldung mitschneiden: die Meldung erscheint NACH dem Zug und verschwindet wieder —
    // ein Snapshot erwischt sie fast nie. Hier über die Zeit protokollieren (Text + Klassen),
    // damit die Zustände (XP-Betrag, „Overstudied", falsch) unterscheidbar werden.
    trace.notifications = [];
    let notifMo = null;
    const notifRoot = document.querySelector('[data-testid="moveNotification"]')?.parentElement
      || document.querySelector('[data-testid="moveNotification"]');
    if (notifRoot) {
      // JEDES Feuern protokollieren, auch bei unveraendertem Text. Die alte Fassung filterte
      // `last.text !== t` — damit hatte der Rekorder denselben blinden Fleck wie der Tracker,
      // den er aufklaeren soll: drei gleiche Meldungen hintereinander ergaben einen Eintrag.
      // Die Kernfrage lautet ja gerade, OB das DOM bei einer wortgleichen Wiederholung
      // ueberhaupt anfasst wird. Deshalb zusaetzlich die Mutations-ARTEN und die Halbzug-Nummer.
      let notifLetzterKnoten = null;
      const logNotif = (records) => {
        const el = notifRoot.querySelector('[data-testid="moveNotification"]') || notifRoot;
        const arten = records ? [...new Set(records.map((r) => r.type))] : ['(initial)'];
        trace.notifications.push({
          t: ts(),
          text: (notifRoot.textContent || '').trim().slice(0, 120),
          arten,
          anzahlMutationen: records ? records.length : 0,
          knotenNeu: el !== notifLetzterKnoten,       // hat React den Knoten ersetzt?
          ply: (() => { const f = extractFenFromReact(); if (!f) return null;
            const teile = f.trim().split(/\s+/); const zug = parseInt(teile[5], 10);
            return Number.isFinite(zug) ? (zug - 1) * 2 + (teile[1] === 'b' ? 1 : 0) : null; })(),
          fen: extractFenFromReact(),
          html: notifRoot.innerHTML.slice(0, 800),
        });
        notifLetzterKnoten = el;
        if (trace.notifications.length > 400) notifMo && notifMo.disconnect();
      };
      logNotif();
      notifMo = new MutationObserver(logNotif);
      notifMo.observe(notifRoot, { childList: true, characterData: true, subtree: true, attributes: true });
    } else {
      trace.notifications.push({ t: 0, text: '(kein [data-testid="moveNotification"] beim Start gefunden)' });
    }

    // Zähler-VERLAUF: welche Zahl in der Practice-Spalte ändert sich, wenn eine Linie fertig
    // wird? Genau das beantwortet die Frage nach dem Trainingspool — ein einzelner Snapshot
    // kann es nicht, weil er den Wert nicht in Bewegung sieht.
    trace.zaehlerVerlauf = [];
    let letzteZaehler = '';
    const zaehlerTimer = setInterval(() => {
      const quelle = row || document.body;
      const werte = [];
      for (const el of quelle.querySelectorAll('*')) {
        if (el.children.length) continue;
        if (el.closest('#repcheck-inspector-panel, #repcheck-chessable-fen-tools')) continue;
        if (el.closest('[class*="notation"], [data-square]')) continue;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 32 || !/\d/.test(t)) continue;
        werte.push(t);
        if (werte.length >= 40) break;
      }
      const schluessel = werte.join('|');
      if (schluessel !== letzteZaehler) {
        letzteZaehler = schluessel;
        trace.zaehlerVerlauf.push({ t: ts(), werte });
      }
    }, 500);

    // Netzwerk-Mitschnitt: die Pool-Zahl kommt sehr wahrscheinlich aus einer Chessable-Antwort
    // (getList/getCourse/getGame). fetch UND XHR werden für die Dauer der Aufnahme umhüllt und
    // danach wieder zurückgesetzt — beides, weil ungewiss ist, was Chessable benutzt.
    trace.netzwerk = [];
    const merkeAntwort = (methode, url, koerper) => {
      if (!/chessable\.com/i.test(url) && !url.startsWith('/')) return;
      if (/\.(js|css|png|jpg|jpeg|svg|woff2?|gif|webp)(\?|$)/i.test(url)) return;
      if (trace.netzwerk.length >= 40) return;
      const roh = zensiereText(String(koerper || ''));
      trace.netzwerk.push({
        t: ts(), methode, url: url.slice(0, 300),
        laenge: roh.length,
        koerper: roh.slice(0, 8000),
      });
    };

    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      const methode = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
      return origFetch.apply(this, args).then((res) => {
        // Klon lesen, damit die Seite ihre eigene Antwort unangetastet bekommt.
        try { res.clone().text().then((txt) => merkeAntwort(methode, url, txt), () => {}); } catch (e) { /* egal */ }
        return res;
      });
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (methode, url, ...rest) {
      this.__rcMethode = methode; this.__rcUrl = url;
      return origOpen.call(this, methode, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', () => {
        let txt = '';
        try { txt = this.responseType === '' || this.responseType === 'text' ? this.responseText : '(' + this.responseType + ')'; } catch (e) { txt = '(nicht lesbar)'; }
        merkeAntwort(this.__rcMethode || 'GET', this.__rcUrl || '', txt);
      });
      return origSend.apply(this, args);
    };

    let mo = null;
    if (board) {
      mo = new MutationObserver((muts) => {
        for (const m of muts.slice(0, 20)) {
          const t = m.target instanceof Element ? m.target : null;
          if (!t) continue;
          trace.mutations.push({
            t: ts(), attr: m.attributeName,
            target: t.tagName + ' ' + String(t.className).slice(0, 80),
            value: (t.getAttribute(m.attributeName) || '').slice(0, 200),
          });
        }
        if (trace.mutations.length > 3000) mo.disconnect();
      });
      mo.observe(board, { attributes: true, attributeFilter: ['style', 'class'], subtree: true });
      // Zug-Spur: bei jeder Aenderung der Halbzug-Nummer ein Eintrag. Zeigt, ob das BRETT ein
      // brauchbarer Ausloeser waere und wie sich ein alternativer/zurueckgenommener Zug verhaelt.
      trace.zugSpur = [];
      let letzterSpurPly = null;
      const spurTimer = setInterval(() => {
        const f = extractFenFromReact();
        if (!f) return;
        const teile = f.trim().split(/\s+/);
        const zug = parseInt(teile[5], 10);
        if (!Number.isFinite(zug)) return;
        const ply = (zug - 1) * 2 + (teile[1] === 'b' ? 1 : 0);
        if (ply === letzterSpurPly) return;
        letzterSpurPly = ply;
        const notif = document.querySelector('[data-testid="moveNotification"]');
        trace.zugSpur.push({
          t: ts(), ply, fen: f,
          meldung: notif ? (notif.parentElement || notif).textContent.trim().slice(0, 80) : null,
        });
      }, 200);
      trace.__spurTimer = spurTimer;
    }

    // Das zuletzt angefasste Figuren-Element regelmäßig vermessen (Drag-Pfad).
    const rectTimer = setInterval(() => {
      const dragged = document.querySelector('[data-piece]:hover, piece:hover')
        || document.querySelector('[class*="dragging"], [class*="drag"] [data-piece]');
      if (dragged) trace.pieceRects.push({ t: ts(), rect: rectOf(dragged), class: String(dragged.className).slice(0, 80) });
    }, 100);

    setTimeout(() => {
      for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup']) {
        document.removeEventListener(ev, onPointer, { capture: true });
      }
      if (mo) mo.disconnect();
      if (notifMo) notifMo.disconnect();
      clearInterval(rectTimer);
      clearInterval(zaehlerTimer);
      if (trace.__spurTimer) { clearInterval(trace.__spurTimer); delete trace.__spurTimer; }
      // Netzwerk unbedingt zurückbauen — ein hängengebliebener Wrapper würde die Seite
      // für den Rest der Sitzung belasten.
      try {
        window.fetch = origFetch;
        XMLHttpRequest.prototype.open = origOpen;
        XMLHttpRequest.prototype.send = origSend;
      } catch (e) { trace.fehler.push({ wo: 'netzwerk-rueckbau', fehler: String(e).slice(0, 200) }); }
      // Zum Vergleich: derselbe Zustand NACH der Aufnahme. Die Differenz der Zähler ist die
      // eigentliche Antwort auf „welcher Wert ist der Trainingspool".
      // Auch der Abschluss gekapselt — sonst kostet ein werfender Sammler die FERTIGE Aufnahme.
      try {
        trace.snapshotAfter = { zaehler: collectZaehler(), progress: collectProgress(boardAnchor()) };
      } catch (e) { trace.fehler.push({ wo: 'snapshotAfter', fehler: String(e).slice(0, 200) }); }
      try { trace.fiberScan = alleFiberScans(); }
      catch (e) { trace.fehler.push({ wo: 'fiberScan', fehler: String(e).slice(0, 200) }); }
      done(trace);
    }, seconds * 1000);
  }

  /**
   * Schlanke Aufnahme NUR fuer die Zug-Rueckmeldung. Die grosse Aufnahme sammelt fuer diese
   * Frage viel zu viel (Drawer-HTML, Fiber-Scans, Netzwerk-Mitschnitt) — jeder dieser Sammler
   * ist eine Stelle, an der die Aufnahme scheitern kann, bevor sie ankommt.
   *
   * Beantwortet genau eine Frage: feuert das DOM ueberhaupt, wenn dieselbe Meldung
   * („+150 XP") ein zweites Mal erscheint — und wenn ja, mit welcher Mutations-Art?
   */
  function recordXp(seconds, done) {
    const trace = {
      kind: 'repcheck-inspector-recording-xp',
      when: new Date().toISOString(),
      url: location.href,
      seconds,
      fehler: [],
      notifications: [],
      zugSpur: [],
    };
    const t0 = performance.now();
    const ts = () => +(performance.now() - t0).toFixed(1);
    const sicher = (name, fn) => {
      try { return fn(); } catch (e) { trace.fehler.push({ t: ts(), wo: name, fehler: String(e).slice(0, 200) }); return null; }
    };

    const plyJetzt = () => sicher('ply', () => {
      const f = extractFenFromReact();
      if (!f) return null;
      const teile = f.trim().split(/\s+/);
      const zug = parseInt(teile[5], 10);
      return Number.isFinite(zug) ? { ply: (zug - 1) * 2 + (teile[1] === 'b' ? 1 : 0), fen: f } : null;
    });

    const notif = document.querySelector('[data-testid="moveNotification"]');
    const root = (notif && notif.parentElement) || notif;
    trace.notifGefunden = !!root;
    let letzterKnoten = null;
    let mo = null;
    if (root) {
      const lies = (records) => sicher('lies', () => {
        const el = root.querySelector('[data-testid="moveNotification"]') || root;
        const p = plyJetzt();
        trace.notifications.push({
          t: ts(),
          text: (root.textContent || '').trim().slice(0, 120),
          arten: records ? [...new Set(records.map((r) => r.type))] : ['(initial)'],
          anzahl: records ? records.length : 0,
          knotenNeu: el !== letzterKnoten,
          ply: p ? p.ply : null,
          html: root.innerHTML.slice(0, 600),
        });
        letzterKnoten = el;
        if (trace.notifications.length >= 300 && mo) mo.disconnect();
      });
      lies();
      mo = new MutationObserver(lies);
      mo.observe(root, { childList: true, characterData: true, subtree: true, attributes: true });
    }

    // Zug-Spur: jede Aenderung der Halbzug-Nummer mit der dann sichtbaren Meldung. Zeigt, ob
    // das BRETT ein brauchbarer Ausloeser waere und wie sich eine Ruecknahme verhaelt.
    let letzterPly = null;
    const spur = setInterval(() => {
      const p = plyJetzt();
      if (!p || p.ply === letzterPly) return;
      letzterPly = p.ply;
      const n = document.querySelector('[data-testid="moveNotification"]');
      trace.zugSpur.push({
        t: ts(), ply: p.ply, fen: p.fen,
        meldung: n ? ((n.parentElement || n).textContent || '').trim().slice(0, 80) : null,
      });
      if (trace.zugSpur.length >= 300) clearInterval(spur);
    }, 150);

    setTimeout(() => {
      if (mo) mo.disconnect();
      clearInterval(spur);
      done(trace);
    }, seconds * 1000);
  }

  // ── chess.com: woran haengt die Einblendung der schwebenden Knoepfe? ─────
  // content.js zeigt ♟/🔎/📋/💾 nur auf einer „Review-Seite": bisher Pfad mit /analysis/game/
  // oder /game/review/. Die Zuege liest es aus .move-list / vertical-move-list / wc-move-list
  // (Zugknoten .node). Auf einer Partieseite wie /game/<id> greift beides moeglicherweise nicht.
  // Dieser Sammler beantwortet: Welcher Knopf bietet die Analyse an, wie ist er ausgezeichnet,
  // und in welchem Element stehen die Zuege?
  function ccKurz(el) {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      klasse: String(el.className || '').slice(0, 160) || undefined,
      id: el.id || undefined,
      href: el.getAttribute('href') || undefined,
      dataCy: el.getAttribute('data-cy') || undefined,
      testId: el.getAttribute('data-test-element') || el.getAttribute('data-testid') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) || undefined,
      pfad: kurzPfad(el, 4),
      sichtbar: !!(r.width || r.height),
    };
  }

  const CC_ANALYSE = /analys|review|auswert|rückblick|ruckblick|rueckblick/i;

  function chessComSnapshot() {
    const q = (sel) => { try { return [...document.querySelectorAll(sel)]; } catch (e) { return []; } };
    const alleNodes = q('.node');

    const zuglisten = q('[class*="move-list"], [class*="moveList"], vertical-move-list, wc-move-list, '
      + '[data-cy*="move"], [class*="movelist"]').slice(0, 8).map((el) => Object.assign(ccKurz(el), {
        kinder: el.children.length,
        zugKnoten: el.querySelectorAll('.node').length,
        // Falls .node nicht passt: was steckt sonst drin?
        kindTags: [...new Set([...el.children].map((k) => k.tagName.toLowerCase()))].slice(0, 6),
        htmlAnfang: zensiereText(el.outerHTML.slice(0, 2500)),
      }));

    const analyse = q('a, button, [role="button"]').filter((el) => CC_ANALYSE.test(
      (el.textContent || '') + ' ' + String(el.className || '') + ' ' + (el.getAttribute('href') || '')
      + ' ' + (el.getAttribute('data-cy') || '') + ' ' + (el.getAttribute('aria-label') || ''))
    ).slice(0, 15).map(ccKurz);

    // Umfeld des ersten sichtbaren Analyse-Knopfes: dort steht meist die ganze Knopfleiste.
    const ersterSichtbar = q('a, button, [role="button"]').filter((el) => CC_ANALYSE.test(
      (el.textContent || '') + ' ' + String(el.className || '') + ' ' + (el.getAttribute('href') || ''))
      && el.getBoundingClientRect().width)[0];
    const knopfUmfeld = ersterSichtbar
      ? zensiereText((ersterSichtbar.closest('[class*="sidebar"], [class*="panel"], [class*="controls"], [class*="buttons"]')
          || ersterSichtbar.parentElement || ersterSichtbar).outerHTML.slice(0, 3000))
      : null;

    return {
      kind: 'chesscom-snapshot',
      zeit: new Date().toISOString(),
      seite: {
        pfad: location.pathname,
        suche: location.search.slice(0, 200),
        titel: document.title.slice(0, 120),
        // Genau die beiden Bedingungen, an denen content.js heute entscheidet:
        trifftAnalysisGame: location.pathname.includes('/analysis/game/'),
        trifftGameReview: location.pathname.includes('/game/review/'),
      },
      repcheckKnoepfeDa: !!document.getElementById('repcheck-floating-wrap'),
      zugKnotenGesamt: alleNodes.length,
      zugKnotenBeispiele: alleNodes.slice(0, 6).map((n) => ({
        klasse: String(n.className || '').slice(0, 80),
        text: (n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24),
        pfad: kurzPfad(n, 3),
      })),
      zuglisten,
      analyseKnoepfe: analyse,
      knopfUmfeld,
      // chess.com baut vieles aus Web-Components — welche stehen auf der Seite?
      webComponents: [...new Set([...document.querySelectorAll('*')]
        .map((e) => e.tagName.toLowerCase()).filter((t) => t.includes('-')))].slice(0, 40),
      brett: q('wc-chess-board, chess-board, [class*="board-layout"], [class*="board"]').slice(0, 4).map(ccKurz),
    };
  }

  // ── chess.com: woher kommen die ZUEGE? ──────────────────────────────────
  // „Partie speichern" liest die Zuege aus dem DOM. Auf der Analyseseite (Review-Tab) gibt es dort keine
  // Zugliste — der Knopf konnte also nichts speichern. Dieser Sammler beantwortet, ob chess.coms eigene
  // Partie-Antwort (dieselbe, aus der RepCheck schon die Kopfzeilen holt) die Zuege mitliefert, und
  // stellt die DOM-Lesung als Vergleich daneben.
  function ccSpielId() {
    const p = location.pathname;
    const m = p.match(/\/(?:live|daily|game|analysis\/game\/live|analysis\/game\/daily)\/(\d+)/) || p.match(/(\d{6,})/);
    return m ? m[1] : null;
  }

  /** SAN-Liste aus der Zugliste im DOM — dieselbe Lesart wie content.js (Knoten `.node`). */
  function ccDomZuege() {
    const liste = document.querySelector('.move-list, vertical-move-list, wc-move-list');
    if (!liste) return null;
    return [...liste.querySelectorAll('.node')].map((n) => {
      const klon = n.cloneNode(true);
      klon.querySelectorAll('svg, style, script, defs, title').forEach((e) => e.remove());
      const fig = n.querySelector('[data-figurine]');
      return ((fig ? fig.getAttribute('data-figurine') : '') + klon.textContent.trim())
        .replace(/^\d+\.+\s*/, '').replace(/[?!]+$/, '').trim();
    }).filter(Boolean);
  }

  async function chessComZugquelle() {
    const id = ccSpielId();
    const ergebnis = {
      kind: 'chesscom-moves',
      zeit: new Date().toISOString(),
      pfad: location.pathname,
      spielId: id,
      domZuege: ccDomZuege(),
      abrufe: [],
    };
    for (const art of ['live', 'daily']) {
      const url = `https://www.chess.com/callback/${art}/game/${id}`;
      const eintrag = { art, url };
      try {
        const resp = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
        eintrag.status = resp.status;
        if (resp.ok) {
          const daten = await resp.json();
          const spiel = daten && daten.game;
          eintrag.topKeys = Object.keys(daten || {});
          eintrag.gameKeys = spiel ? Object.keys(spiel) : null;
          eintrag.pgnHeaders = spiel && spiel.pgnHeaders ? spiel.pgnHeaders : null;
          // Alles, was nach Zuegen aussieht: Feldname, Typ, Laenge, Anfang.
          eintrag.zugFelder = {};
          for (const [k, v] of Object.entries(spiel || {})) {
            if (!/move|pgn|tcn/i.test(k)) continue;
            eintrag.zugFelder[k] = typeof v === 'string'
              ? { typ: 'string', laenge: v.length, anfang: zensiereText(v.slice(0, 400)) }
              : { typ: Array.isArray(v) ? 'array' : typeof v, laenge: Array.isArray(v) ? v.length : undefined,
                  anfang: zensiereText(JSON.stringify(v).slice(0, 300)) };
          }
        }
      } catch (e) {
        eintrag.fehler = String(e).slice(0, 200);
      }
      ergebnis.abrufe.push(eintrag);
      if (eintrag.status === 200) break;   // die passende Art gefunden
    }
    return ergebnis;
  }

  // ── Uebersichtsseite: wie sind die PARTIEZEILEN gebaut? ─────────────────
  // Fuer „Partie an RookHub schicken" braucht es je Zeile einen Platz fuer den Knopf und die Partie-Id.
  // Gesammelt wird deshalb: welche Links zeigen auf eine Partie, wie sieht die Zeile darum aus (Vorfahren
  // mit Klassen und Geschwisterzahl — die ZEILE ist der Vorfahr, von dem es viele gleichartige gibt), und
  // das gekuerzte HTML zweier echter Zeilen als Vorlage.
  const ID_MUSTER = [
    { name: 'chesscom-analysis', re: /^\/analysis\/game\/(?:live|daily)\/(\d+)/ },
    { name: 'chesscom-game', re: /^\/(?:game|live|daily)\/(?:live\/|daily\/)?(\d+)/ },
    { name: 'lichess-game', re: /^\/([A-Za-z0-9]{8})(?:\/(?:white|black))?$/ },
  ];

  function partieLinkId(href) {
    let pfad;
    try { pfad = new URL(href, location.origin).pathname; } catch (e) { return null; }
    for (const m of ID_MUSTER) {
      const t = pfad.match(m.re);
      if (t) return { quelle: m.name, id: t[1], pfad };
    }
    return null;
  }

  function vorfahren(el, tiefe) {
    const kette = [];
    for (let p = el.parentElement, i = 0; p && i < tiefe; p = p.parentElement, i++) {
      const klasse = String(p.className || '').slice(0, 90);
      const gleichartige = p.parentElement
        ? [...p.parentElement.children].filter((k) => k.tagName === p.tagName && String(k.className || '') === String(p.className || '')).length
        : 0;
      kette.push({ tag: p.tagName.toLowerCase(), klasse, id: p.id || undefined, gleichartigeGeschwister: gleichartige });
    }
    return kette;
  }

  function uebersichtZeilen() {
    const treffer = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const t = partieLinkId(a.getAttribute('href'));
      if (!t) continue;
      treffer.push({ ...t, linkKlasse: String(a.className || '').slice(0, 90), text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), el: a });
    }
    // Die ZEILE: der erste Vorfahr mit mehreren gleichartigen Geschwistern — dort haengt spaeter der Knopf.
    const zeileVon = (el) => {
      for (let p = el.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) {
        const gleich = p.parentElement
          ? [...p.parentElement.children].filter((k) => k.tagName === p.tagName && String(k.className || '') === String(p.className || '')).length
          : 0;
        if (gleich >= 3) return p;
      }
      return el.parentElement;
    };
    const ids = [...new Set(treffer.map((t) => t.id))];
    const beispiele = [];
    for (const t of treffer.slice(0, 3)) {
      const zeile = zeileVon(t.el);
      beispiele.push({
        id: t.id, quelle: t.quelle, linkKlasse: t.linkKlasse,
        vorfahren: vorfahren(t.el, 5),
        zeileTag: zeile ? zeile.tagName.toLowerCase() : null,
        zeileKlasse: zeile ? String(zeile.className || '').slice(0, 120) : null,
        // Wie ist die Zeile gebaut? Davon haengt ab, ob ein zusaetzliches Kind das Layout zerreisst
        // (Raster mit festen Spalten) oder einfach mitlaeuft (Flex).
        zeileLayout: zeile ? (() => {
          const cs = getComputedStyle(zeile);
          const r = zeile.getBoundingClientRect();
          return {
            display: cs.display, gridTemplateColumns: cs.gridTemplateColumns.slice(0, 160),
            flexWrap: cs.flexWrap, position: cs.position, gap: cs.gap,
            breite: Math.round(r.width), hoehe: Math.round(r.height),
          };
        })() : null,
        zellen: zeile ? [...zeile.children].map((k) => {
          const r = k.getBoundingClientRect();
          const cs = getComputedStyle(k);
          return {
            tag: k.tagName.toLowerCase(), klasse: String(k.className || '').slice(0, 90),
            breite: Math.round(r.width), text: (k.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
            display: cs.display, flex: cs.flex,
          };
        }) : [],
        zeileHtml: zeile ? zensiereText(zeile.outerHTML.slice(0, 9000)) : null,
      });
    }
    return {
      kind: 'uebersicht-zeilen',
      zeit: new Date().toISOString(),
      seite: location.hostname + location.pathname,
      partieLinks: treffer.length,
      verschiedeneIds: ids.length,
      idsAnfang: ids.slice(0, 8),
      beispiele,
      // Was die Seite sonst je Zeile zeigt (Genauigkeit, Ergebnis, Zeit) — fuer die RookHub-Uebersicht.
      spaltenUeberschriften: [...document.querySelectorAll('th, [role="columnheader"], [class*="header"] [class*="cell"]')]
        .slice(0, 12).map((e) => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30)).filter(Boolean),
    };
  }

  // ── Ausgabe: Zwischenablage + Datei-Download ────────────────────────────
  function deliver(obj, btn, label) {
    // Fehlerfest: wenn hier etwas wirft (zu grosses JSON, blockierter Download, Clipboard),
    // blieb der Knopf frueher stumm im Aufnahme-Zustand stehen und man wusste nicht, warum.
    let json;
    try {
      json = JSON.stringify(obj, null, 1);
    } catch (e) {
      meldeFehler(btn, 'JSON fehlgeschlagen: ' + String(e).slice(0, 80));
      return;
    }
    const groesse = Math.round(json.length / 1024);
    try { navigator.clipboard.writeText(json).catch(() => {}); } catch (e) { /* Download reicht */ }
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = `repcheck-inspector-${obj.kind.includes('record') ? 'recording' : 'snapshot'}-${Date.now()}.json`;
      document.body.appendChild(a);         // Firefox laedt nur an einem eingehaengten Anker
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
    } catch (e) {
      meldeFehler(btn, 'Download fehlgeschlagen (' + groesse + ' KB): ' + String(e).slice(0, 60));
      return;
    }
    const prev = btn.dataset.rcLabel || btn.textContent;
    btn.textContent = `${label} (${groesse} KB)`;
    setTimeout(() => { btn.textContent = prev; }, 4000);
  }

  /** Fehler sichtbar machen statt stumm haengen zu bleiben — und in die Konsole. */
  function meldeFehler(btn, text) {
    console.error('[RepCheck Inspector]', text);
    const prev = btn.dataset.rcLabel || btn.textContent;
    btn.textContent = '⚠ ' + text.slice(0, 60);
    btn.style.background = '#b71c1c';
    setTimeout(() => { btn.textContent = prev; btn.style.background = btn.dataset.rcBg || '#455a64'; }, 8000);
  }

  // ── Panel ───────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  Object.assign(panel.style, {
    position: 'fixed', bottom: '16px', left: '16px', zIndex: '2147483647',
    display: 'flex', gap: '6px', fontFamily: 'system-ui, sans-serif',
  });
  function mkBtn(text, bg) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    Object.assign(b.style, {
      padding: '6px 10px', fontSize: '12px', background: bg, color: '#fff',
      border: 'none', borderRadius: '6px', cursor: 'pointer', opacity: '0.85',
      boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
    });
    return b;
  }
  // Auf chess.com haben die Chessable-Knoepfe keinen Sinn — nur der eine Sammler.
  if (AUF_CHESSCOM || AUF_LICHESS) {
    if (AUF_CHESSCOM) {
    const ccBtn = mkBtn('RC-Debug: chess.com-Snapshot', '#2e7d32');
    ccBtn.title = 'Sammelt Zugliste, Analyse-Knopf und Seitenpfad — die Angaben, an denen haengt, '
      + 'ob RepCheck seine schwebenden Knoepfe einblenden kann.';
    ccBtn.addEventListener('click', () => {
      let data;
      try { data = chessComSnapshot(); }
      catch (e) { meldeFehler(ccBtn, 'snapshot: ' + String(e).slice(0, 70)); return; }
      deliver(data, ccBtn, 'kopiert + Download ✓');
    });
    ccBtn.dataset.rcLabel = ccBtn.textContent;
    ccBtn.dataset.rcBg = ccBtn.style.background;
    panel.appendChild(ccBtn);

    // Zweiter Knopf: woher kommen die Zuege? (fuer „Partie speichern" auf der Analyseseite)
    const zugBtn = mkBtn('RC-Debug: chess.com-Zugquelle', '#1565c0');
    zugBtn.title = 'Fragt chess.coms eigene Partie-Antwort ab und stellt sie neben die Zugliste im DOM — '
      + 'damit „Partie speichern" auch dort funktioniert, wo keine Zugliste steht.';
    zugBtn.addEventListener('click', async () => {
      zugBtn.textContent = 'frage chess.com …';
      let data;
      try { data = await chessComZugquelle(); }
      catch (e) { meldeFehler(zugBtn, 'zugquelle: ' + String(e).slice(0, 70)); return; }
      deliver(data, zugBtn, 'kopiert + Download ✓');
    });
    zugBtn.dataset.rcLabel = zugBtn.textContent;
    zugBtn.dataset.rcBg = zugBtn.style.background;
    panel.appendChild(zugBtn);
    }

    // Uebersichtsseite (chess.com UND lichess): Aufbau der Partiezeilen fuer den Senden-Knopf je Partie.
    const zeilenBtn = mkBtn('RC-Debug: Partiezeilen', '#6a1b9a');
    zeilenBtn.title = 'Auf einer Uebersicht (Partien-Archiv/Profil): wie sind die Zeilen gebaut, wo steht die '
      + 'Partie-Id, wohin passt ein Knopf.';
    zeilenBtn.addEventListener('click', () => {
      let data;
      try { data = uebersichtZeilen(); }
      catch (e) { meldeFehler(zeilenBtn, 'zeilen: ' + String(e).slice(0, 70)); return; }
      deliver(data, zeilenBtn, 'kopiert + Download ✓');
    });
    zeilenBtn.dataset.rcLabel = zeilenBtn.textContent;
    zeilenBtn.dataset.rcBg = zeilenBtn.style.background;
    panel.appendChild(zeilenBtn);

    document.body.appendChild(panel);
    return;
  }

  const snapBtn = mkBtn('RC-Debug: Snapshot', '#455a64');
  snapBtn.addEventListener('click', () => {
    let data;
    try { data = snapshot(); } catch (e) { meldeFehler(snapBtn, 'snapshot: ' + String(e).slice(0, 70)); return; }
    try { data.fiberScan = alleFiberScans(); } catch (e) { data.fiberScan = { fehler: String(e).slice(0, 200) }; }
    deliver(data, snapBtn, 'kopiert + Download ✓');
  });
  const recBtn = mkBtn('Record 6s', '#b71c1c');
  recBtn.addEventListener('click', () => {
    recBtn.textContent = 'zeichnet auf … (jetzt ziehen!)';
    try { record(6, (trace) => deliver(trace, recBtn, 'kopiert + Download ✓')); }
    catch (e) { meldeFehler(recBtn, 'record: ' + String(e).slice(0, 70)); }
  });
  // Für die Pool-Frage: lang genug, um eine Linie zu Ende zu spielen und weiterzuschalten.
  const poolBtn = mkBtn('Record 30s (Pool)', '#4527a0');
  poolBtn.title = 'Aufnahme mit Netzwerk-Mitschnitt und Zähler-Verlauf: eine Linie zu Ende '
    + 'spielen und weiterschalten — danach zeigt der Dump, welcher Wert sich mitbewegt hat.';
  poolBtn.addEventListener('click', () => {
    poolBtn.textContent = 'zeichnet 30 s auf … (Linie fertig spielen!)';
    try { record(30, (trace) => deliver(trace, poolBtn, 'kopiert + Download ✓')); }
    catch (e) { meldeFehler(poolBtn, 'record: ' + String(e).slice(0, 70)); }
  });
  // Schlank und gezielt fuer die XP-Frage: wenig Sammler, kleines JSON, wenig Fehlerquellen.
  const xpBtn = mkBtn('Record 20s (XP)', '#00695c');
  xpBtn.title = 'Nur die Zug-Rueckmeldung: protokolliert JEDES Feuern des Observers (auch bei '
    + 'gleichem Text) samt Mutations-Art, Knotenwechsel und Halbzug-Nummer.';
  xpBtn.addEventListener('click', () => {
    xpBtn.textContent = 'zeichnet 20 s auf … (jetzt Zuege spielen!)';
    try { recordXp(20, (trace) => deliver(trace, xpBtn, 'kopiert + Download ✓')); }
    catch (e) { meldeFehler(xpBtn, 'recordXp: ' + String(e).slice(0, 70)); }
  });
  for (const b of [snapBtn, recBtn, poolBtn, xpBtn]) {
    b.dataset.rcLabel = b.textContent;
    b.dataset.rcBg = b.style.background;
  }
  panel.appendChild(snapBtn);
  panel.appendChild(recBtn);
  panel.appendChild(poolBtn);
  panel.appendChild(xpBtn);
  document.body.appendChild(panel);
})();
