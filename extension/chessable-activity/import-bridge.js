// chessable-activity.js-Teil (Zerlegung Z36): die Import-Wege zu RookHub (ingest, ingest/chunk, ingest/live ueber den
// gemeinsamen RookHub-Client), „Mitschnitt importieren", das laufende Live-Anhaengen beim Durchklicken und die
// Popup-Bruecke: Popup ↔ Content-Script per chrome.runtime.onMessage {type:'rc-import', action} — state, setTarget,
// crawl, cancel, importCaptured, refreshProgress (Nachrichtenformat unveraendert).
//
// Zustand: Ziel (importTarget/targetChosenFor), Status, Live-Puffer gehoeren hierher; crawling/crawlStartedAt/
// cancelRequested (Kurs holen) und progressBid/progressStruct/importedOids (Fortschritt) laufen ueber S.
// Seiteneffekt nur in installPopupBruecke().
// Laden: Manifest content_scripts (chessable.com, isolierte Welt), VOR chessable-activity.js → self.RepCheckActivity.bridge
(function () {
  'use strict';

  // Wie chessable-activity.js: laeuft die isolierte Welt in diesem Tab schon (das Popup laedt die Manifest-Liste nach),
  // nichts neu anlegen.
  if (window.__repcheckChessableActivity) return;

  // Aus chessable-activity.js und den anderen Teilen (init).
  let S, t, rookhubRequest, cap, currentCourseId, pageCourseId, bestCourseName, capturedChapters, capturedLineCount;
  let markImported, ensureProgress, crawlAndImport;

  const Crawl = self.RepCheckCrawl || null;

  // Live-Anhängen ist immer aktiv (kein Schalter mehr): beim Durchklicken erfasste Linien werden
  // laufend an RookHub angehängt. Es gibt keinen Grund, das abzuschalten — der frühere Opt-in-
  // Toggle (rookhubChessableAutoImport) ist entfernt.
  const autoImport = true;
  let autoImportTimer = null;

  // Für die „Erste Schritte"-Checkliste im Popup: ein erfolgreicher Import hakt „Kurs geholt" ab.
  function markCourseFetched() {
    try { chrome.storage.local.set({ rcCourseFetched: true }); } catch (e) {}
  }

  // ---- Ingest an RookHub (Egress über Background-Worker, CORS-frei; Token bleibt hier) ----
  async function ingest(bid, chapters, target, courseName) {
    return rookhubRequest('/api/extension/chessable/ingest', { bid, target, courseName, chapters });
  }

  // Ein Kapitel-Chunk an den kapitelweisen Ingest (bounded pro Request). RookHub ≥ 0.484.0 importiert jeden
  // Chunk SOFORT; final=true schließt den Import-Eintrag ab (Status, Benachrichtigung).
  // extra: beim finalen Chunk eines vollständig geholten Kurses { courseJson, complete }; bei einem Abbruch
  // { aborted: true } (schließt den Eintrag als abgebrochen, die schon importierten Kapitel bleiben).
  async function ingestChunk(sessionId, bid, target, courseName, chapter, final, extra) {
    const res = await rookhubRequest('/api/extension/chessable/ingest/chunk',
      Object.assign({ sessionId, bid, target, courseName, chapter, final }, extra || {}));
    markImported(bid, chapter ? [chapter] : []);
    return res;
  }

  // V1: nur den passiven Mitschnitt importieren (kein aktives Holen).
  async function importCaptured(target) {
    const bid = cap.bid || currentCourseId();
    const chapters = capturedChapters();
    if (!bid || !chapters.length) { setStatus(t('import.nothingCaptured')); return; }
    try {
      setStatus(t('import.importingCapture'));
      // Erste Portion über /ingest (Import-Eintrag + Benachrichtigung, legt das Ziel bei Bedarf an), den Rest
      // anhängen — ein großer Mitschnitt in EINER Anfrage bekam am Proxy 413.
      const parts = Crawl.splitIngestChapters(chapters);
      const courseName = bestCourseName(bid);
      if (parts.length > 1) setStatus(t('import.importingCapturePart', { part: 1, parts: parts.length }));
      const res = await ingest(bid, parts[0], target, courseName);
      let imported = (res && res.imported) || 0;
      for (let i = 1; i < parts.length; i++) {
        setStatus(t('import.importingCapturePart', { part: i + 1, parts: parts.length }));
        const more = await ingestLive(bid, target, courseName, parts[i]);
        imported += (more && more.imported) || 0;
      }
      markCourseFetched();
      setStatus(t(target === 'book' ? 'import.doneImportedPuzzles' : 'import.doneImportedLines', { count: imported }));
      ensureProgress(true);
    } catch (err) { setStatus(t('import.error', { error: (err && err.message) || err })); }
  }

  // Live-Append (V1 „beim Durchklicken"): jede NEU erfasste Linie wird kurz gebündelt SOFORT ans
  // Repertoire angehängt (POST .../ingest/live), statt am Ende alles auf einmal zu senden. sentOids
  // verhindert Doppel-Sends in dieser Sitzung; der Server dedupliziert zusätzlich per Zugtext.
  const sentOids = new Set();
  let liveFlushing = false;

  function hasUnsentLine() {
    for (const oid of Object.keys(cap.games)) {
      if (sentOids.has(oid)) continue;
      const lid = cap.oidToLid[oid];
      if (lid && cap.lists[lid]) return true;
    }
    return false;
  }

  function scheduleAutoImport() {
    if (autoImportTimer) return;
    autoImportTimer = setTimeout(() => { autoImportTimer = null; flushLive(); }, 1500);
  }

  async function ingestLive(bid, target, courseName, chapters) {
    const res = await rookhubRequest('/api/extension/chessable/ingest/live', { bid, target, courseName, chapters });
    markImported(bid, chapters);
    return res;
  }

  // Anhängen in Portionen (Crawl.splitIngestChapters): eine einzelne Anfrage je Import lief am Proxy in 413, siehe
  // lib/chessable-crawl.js. Liefert die Summe der neu angehängten Linien; scheitert eine Portion, bleiben die davor
  // angehängten stehen (ein erneuter Versuch überspringt sie serverseitig über die oid).
  async function ingestLiveInParts(bid, target, courseName, chapters, onPart) {
    const parts = Crawl.splitIngestChapters(chapters);
    let imported = 0, linked = 0;
    for (let i = 0; i < parts.length; i++) {
      if (onPart) onPart(i + 1, parts.length);
      const res = await ingestLive(bid, target, courseName, parts[i]);
      imported += (res && res.imported) || 0;
      linked += (res && res.linked) || 0;   // RookHub ≥ 0.478.7; ältere liefern das Feld nicht → 0
    }
    return { imported, linked, parts: parts.length };
  }

  async function flushLive() {
    if (liveFlushing || !Crawl) return;
    const bid = cap.bid || currentCourseId();
    if (!bid) return;
    // Neue Linien je Kapitel bündeln — nur solche, deren getList (Kapitel-Kontext) schon bekannt ist.
    const byLid = {}; const picked = [];
    for (const oid of Object.keys(cap.games)) {
      if (sentOids.has(oid)) continue;
      const lid = cap.oidToLid[oid];
      if (!lid || !cap.lists[lid]) continue;
      (byLid[lid] = byLid[lid] || []).push(oid);
      picked.push(oid);
    }
    if (!picked.length) return;
    const chapters = Object.keys(byLid).map(lid => ({ chapterJson: cap.lists[lid], lines: byLid[lid].map(o => cap.games[o]), lineOids: byLid[lid].map(String) }));
    liveFlushing = true;
    picked.forEach(o => sentOids.add(o));   // optimistisch; bei Fehler zurücknehmen
    try {
      const res = await ingestLiveInParts(bid, importTarget, bestCourseName(bid), chapters);
      markCourseFetched();
      setStatus(t('import.liveAppended', { count: res.imported, sent: sentOids.size }));
      ensureProgress(true);   // Overlay live nachziehen
    } catch (err) {
      picked.forEach(o => sentOids.delete(o));
      setStatus(t('import.liveError', { error: (err && err.message) || err }));
    } finally {
      liveFlushing = false;
      if (autoImport && hasUnsentLine()) scheduleAutoImport();   // während des Flushs kam Neues
    }
  }

  // ---- Zustand + Popup-Bridge (das UI liegt jetzt im Extension-Popup) ----
  // Das früher eingeblendete On-Page-Panel (links unten) ist entfernt; das Popup fragt den
  // Zustand per chrome.tabs.sendMessage ab und löst Crawl / Mitschnitt-Import / Live-Toggle /
  // Ziel-Umschaltung aus. Die In-Page-Marker (✓/○ an Chessables Linien) bleiben (annotateDom).
  let importTarget = 'repertoire';   // vom Popup gesetzt (repertoire|book)
  // Hat der Nutzer das Ziel fuer diesen Kurs selbst gewaehlt? Dann gewinnt seine Wahl gegen die erkannte Kursart.
  let targetChosenFor = null;

  // Ziel aus Chessables Kursart (getCourse `type`, siehe Crawl.targetForCourseType) — nur solange der Nutzer
  // fuer diesen Kurs nichts anderes gewaehlt hat.
  function suggestedTarget() {
    return S.progressStruct && Crawl ? Crawl.targetForCourseType(S.progressStruct.type) : null;
  }
  // `bid` ausdrücklich: beim ersten Laden ist progressBid noch nicht gesetzt — und „null" gegen „null" verglichen hieß
  // „der Nutzer hat für diesen Kurs gewählt". Ergebnis in 1.70.0: die Erkennung stand im Popup, das Ziel blieb auf
  // Repertoire (gemeldet 07.10.2026 an einem Taktikkurs).
  function applySuggestedTarget(bid) {
    const s = suggestedTarget();
    if (s && (targetChosenFor == null || String(targetChosenFor) !== String(bid))) importTarget = s;
  }
  let lastStatus = '';

  // Parameter bewusst `txt`, nicht `t` — `t` ist der Übersetzer-Wrapper (sonst verdeckt).
  function setStatus(txt) { lastStatus = txt || ''; }

  // Kurs-/Kapitel-Fortschritt fürs Popup (null, solange keine Struktur da).
  function progressSummary() {
    if (!Crawl || !S.progressStruct) return null;
    const c = Crawl.progressCounts(S.progressStruct.chapters, S.importedOids);
    if (!c.total) return null;
    return { done: c.done, total: c.total, pct: Math.round((c.done / c.total) * 100), perChapter: c.perChapter };
  }

  function importState() {
    const bid = pageCourseId();   // Startseite: kein Kurs, „Kurs holen" bleibt gesperrt
    return {
      onCourse: !!bid,
      bid: bid || null,
      courseName: bid ? bestCourseName(bid) : null,
      captured: capturedLineCount(),
      autoImport,
      crawling: S.crawling,
      crawlStartedAt: S.crawlStartedAt,
      target: importTarget,
      // Erkannte Kursart (opening/tactics/endgame/strategy) und das Ziel, das daraus folgt — fuers Popup.
      courseType: (S.progressStruct && String(S.progressBid) === String(bid) && S.progressStruct.type) || null,
      suggestedTarget: String(S.progressBid) === String(bid) ? suggestedTarget() : null,
      status: lastStatus,
      progress: progressSummary(),
    };
  }

  function installPopupBruecke() {
    // Popup → Content-Script. `state` antwortet synchron mit dem Momentzustand; die Aktionen
    // stoßen an und der Fortschritt wird über wiederholtes `state`-Polling im Popup sichtbar.
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'rc-import') return;
      switch (msg.action) {
        case 'state':
          ensureProgress(false);            // opportunistisch frisch halten
          sendResponse(importState());
          break;
        case 'setTarget':
          if (msg.target === 'book' || msg.target === 'repertoire') { importTarget = msg.target; targetChosenFor = pageCourseId(); }
          sendResponse(importState());
          break;
        case 'crawl':
          if (msg.target === 'book' || msg.target === 'repertoire') importTarget = msg.target;
          crawlAndImport(importTarget);
          sendResponse({ started: true });
          break;
        case 'cancel':
          if (S.crawling) { S.cancelRequested = true; setStatus(t('import.abortRequested')); }
          sendResponse(importState());
          break;
        case 'importCaptured':
          if (msg.target === 'book' || msg.target === 'repertoire') importTarget = msg.target;
          importCaptured(importTarget);
          sendResponse({ started: true });
          break;
        case 'refreshProgress':
          ensureProgress(true);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse(null);
      }
    });
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckActivity = self.RepCheckActivity || {}).bridge = {
    init(deps) {
      ({ S, t, rookhubRequest, cap, currentCourseId, pageCourseId, bestCourseName, capturedChapters, capturedLineCount } = deps);
      ({ markImported, ensureProgress, crawlAndImport } = deps);
    },
    autoImport, markCourseFetched, ingest, ingestChunk, importCaptured, hasUnsentLine, scheduleAutoImport,
    ingestLive, ingestLiveInParts, flushLive, suggestedTarget, applySuggestedTarget, setStatus, progressSummary,
    importState, installPopupBruecke,
  };
})();
