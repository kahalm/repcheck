// chessable-activity.js-Teil (Zerlegung Z36): „⚡ Kurs holen" — crawlAndImport (getCourse → getList → getGame, schon
// Importiertes und im geteilten Linien-Cache Liegendes ueberspringen, Repertoire per ingest/live zwischendurch anhaengen,
// Buch per ingest/chunk in Teilen). Die Meldungen bei einem Abbruch (unexpected-response, crawl-error) liegen in
// crawl-report.js.
// Siehe CLAUDE.md „Eigenheiten" (Kurs holen) — dort ist jede Regel dieses Ablaufs begruendet.
//
// Zustand: crawling/crawlStartedAt/cancelRequested gehoeren hierher; Popup-Bruecke und Mitschnitt lesen bzw. setzen sie
// ueber S. Keine Seiteneffekte beim Laden.
// Laden: Manifest content_scripts (chessable.com, isolierte Welt), VOR chessable-activity.js → self.RepCheckActivity.crawl
(function () {
  'use strict';

  // Wie chessable-activity.js: laeuft die isolierte Welt in diesem Tab schon (das Popup laedt die Manifest-Liste nach),
  // nichts neu anlegen.
  if (window.__repcheckChessableActivity) return;

  // Aus chessable-activity.js und den anderen Teilen (init).
  let S, t, readConfig, cap, pageCourseId, bestCourseName, setStatus, fetchImportedOids, ensureProgress;
  let listCacheGet, listCachePut, chessableGetChecked, harvestFromList, harvestFromGame, sleep, crawlPauseMs;
  let ingestChunk, ingestLiveInParts, markCourseFetched, showNotOwned, handleUnexpected, reportCrawlError;

  // ======================================================================================
  // Browser-Kurs-Import: V1 (passiver Mitschnitt der Kurs-API) + V2 (aktives Holen). Der Browser
  // holt die Chessable-Daten als echte eingeloggte Session (passiert Cloudflare) und schickt das rohe
  // JSON an RookHub (POST /api/extension/chessable/ingest); der fetch-freie piratechess-Parser macht
  // daraus PGN. Kein serverseitiger Chessable-Abruf/VPN nötig. Additiv — der Server-Import bleibt.
  // ======================================================================================
  const Crawl = self.RepCheckCrawl || null;

  const newSessionId = () => (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : (String(Date.now()) + '-' + Math.round(Math.random() * 1e9));
  let crawling = false;
  let crawlStartedAt = null;   // ms-Zeitstempel des laufenden Crawls (fürs Popup: mitlaufender Timer)
  let cancelRequested = false; // vom Popup gesetzt (Aktion 'cancel'); die Crawl-Schleifen brechen dann sauber ab
  // Repertoire-Ziel: geholte Linien an Kapitelgrenzen zwischendurch anhängen, sobald seit dem letzten Anhängen so viel
  // Zeit vergangen ist. Ein geschlossener Tab kostet dann nur die Linien seit dem letzten Anhängen statt des ganzen
  // Laufs; die Schranke hält die ingest/live-Aufrufe klein, wenn viele kleine Kapitel ohne Pause durchlaufen.
  const REPERTOIRE_APPEND_EVERY_MS = 60000;
  // Buch-Ziel: ein Kapitel geht nicht mehr erst vollständig raus, sondern spätestens nach dieser Zeit in Teilen (gleicher
  // chapterKey — RookHub ≥ 0.495.0 hält die Kapitelnummer und schiebt nur die Liniennummer weiter, wie bei den
  // Byte-Teilen). Anlass 07.10.2026: ein Abbruch mitten im vierten Kapitel eines Taktikkurses warf alles weg, was davon
  // schon geholt war; jetzt kostet er höchstens die letzte Minute.
  const BOOK_PART_EVERY_MS = 60000;
  // Ein Zwischen-Anhang ist best effort: scheitert er (502 beim Neustart oder Deploy von RookHub, piratechess kurz weg),
  // bleibt der Puffer liegen, und der nächste Versuch kommt an der nächsten Kapitelgrenze nach Ablauf der Schranke oder
  // beim Schluss-Anhang. Erst so viele Fehlschläge HINTEREINANDER brechen den Lauf ab, damit bei dauerhaft kaputtem
  // RookHub nicht noch eine Stunde bei Chessable geholt wird. Token ungültig oder keine Verbindung bricht sofort ab.
  const REPERTOIRE_APPEND_MAX_FAILS = 2;
  // Pause vor der einen Wiederholung des Schluss-Anhangs (ein Neustart von RookHub dauert Sekunden).
  const REPERTOIRE_APPEND_RETRY_MS = 5000;

  // Welche Linien liegen schon im geteilten RookHub-Cache (piratechess)? Für diese fragt der Crawl kein getGame
  // bei Chessable ab; der Import schickt nur die oid, der Server setzt den Inhalt ein. Jede Störung (RookHub zu
  // alt → 404, piratechess nicht erreichbar) heißt schlicht: nichts (weiter) gecacht → selbst holen.
  const SHARED_CACHE_BATCH = 5000;
  async function fetchSharedCachedOids(oids) {
    const result = new Set();
    const cfg = await readConfig();
    if (!cfg || !cfg.url || !cfg.token || !oids.length) return result;
    const baseUrl = String(cfg.url).replace(/\/$/, '');
    for (let i = 0; i < oids.length; i += SHARED_CACHE_BATCH) {
      const batch = oids.slice(i, i + SHARED_CACHE_BATCH);
      const resp = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({
            type: 'rookhub-fetch',
            url: baseUrl + '/api/extension/chessable/cached-lines',
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ oids: batch }),
            expect: 'json',
          }, (r) => resolve(chrome.runtime.lastError ? null : r));
        } catch (e) { resolve(null); }
      });
      if (!resp || !resp.ok || !resp.body || !Array.isArray(resp.body.oids)) break;
      resp.body.oids.forEach((o) => result.add(String(o)));
    }
    return result;
  }

  // V2: Kurs aktiv holen (getCourse→getList→getGame).
  //
  // BEIDE Ziele holen INKREMENTELL (v1.63.0): Linien, deren oid schon auf RookHub liegt, werden nicht
  // erneut von Chessable geholt. Das spart Abrufe, Zeit und Ban-Risiko — bei einem halb importierten
  // Kurs ist das der Unterschied zwischen „1290 Linien noch einmal" und „nur die fehlenden 591".
  //
  // Das Buch war davon bis v1.62.0 ausgenommen, weil seine LineId an der Round-Nummer (Kapitel.Linie)
  // hängt und ein Skip die Nummerierung verschiebt. Seit RookHub 0.496.0 ist die Chessable-oid die
  // Identität einer Linie, die Nummer nur noch ein Etikett; 0.497.1 sucht bei einer Kollision den
  // nächsten freien Platz. Deshalb schickt jeder Chunk `partial`, sobald etwas übersprungen wurde —
  // daran erkennt der Server, dass eine Nummern-Kollision NICHTS über die Identität aussagt.
  // ⚠️ Braucht RookHub ≥ 0.497.1. Gegen einen älteren Server würde ein Teil-Import Linien verlieren.
  //
  // Was sich NICHT ändert: der Transportweg. Das Buch streamt weiter über die Chunk-Sitzung
  // (`ingest/chunk`) — daran hängen Import-Eintrag, Benachrichtigung und der Watchdog; das Repertoire
  // hängt über `ingest/live` an. Das ist ein Unterschied im Lebenszyklus, keine doppelte Logik.
  async function crawlAndImport(target) {
    if (crawling) return; crawling = true; crawlStartedAt = Date.now(); cancelRequested = false;
    // Nur auf einer Kursseite (S1-012): sonst hieße bid die erste Kurskarte der Startseite.
    const bid = pageCourseId();
    const sessionId = newSessionId();
    // Zwei getrennte Fragen, die früher EIN Schalter waren: was wird geholt, und wie wird es geschickt.
    const skipKnown = true;                    // beide Ziele überspringen, was schon auf RookHub liegt
    const viaSession = target === 'book';      // Buch: Chunk-Sitzung (Import-Eintrag); Repertoire: Live-Append
    const incremental = !viaSession;           // nur noch: „sammelt für den Live-Append"
    // Nur fürs inkrementelle Anhängen gesammelt: geholt, aber noch nicht angehängt. Außerhalb des try, damit JEDER
    // Abbruch (Stopp, unerwartete Antwort, Chessable-401, Netzfehler) die bis dahin geholten Linien noch speichern
    // kann — sonst müsste ein erneuter Lauf sie wieder bei Chessable holen.
    // Wo der Lauf steht und wie weit er kam — geht bei einem Abbruch mit der Fehlermeldung an RookHub (reportCrawlError).
    const lauf = { phase: 'start', fetched: 0, sent: 0 };
    const newChapters = [];
    const appended = { imported: 0, linked: 0, lines: 0 };   // Summe der in diesem Lauf schon angehängten Linien
    let lastAppendAt = Date.now();
    // Hängt newChapters an und nimmt sie erst nach Erfolg heraus (scheitert es, bleiben sie für den nächsten Versuch
    // liegen; schon Angehängtes überspringt der Server über die oid).
    const appendNew = async (onPart) => {
      if (!newChapters.length) return;
      const batch = newChapters.slice();
      lauf.phase = 'sending';
      const res = await ingestLiveInParts(bid, target, bestCourseName(bid), batch, onPart);
      newChapters.splice(0, batch.length);
      lauf.sent += batch.reduce((n, c) => n + c.lineOids.length, 0);
      appended.imported += res.imported;
      appended.linked += res.linked;
      appended.lines += batch.reduce((n, c) => n + c.lineOids.length, 0);
      lastAppendAt = Date.now();
      markCourseFetched();
    };
    // Wiederholen lohnt nicht, wenn es ohnehin nicht klappen kann: Token ungültig/widerrufen oder RookHub nicht verbunden.
    const hoffnungslos = (e) => !!(e && (e.tokenInvalid || e.notConnected));
    let appendFails = 0;   // Zwischen-Anhänge, die hintereinander scheiterten
    // Zwischen-Anhang an einer Kapitelgrenze, best effort (s. REPERTOIRE_APPEND_MAX_FAILS). Ein Fehlschlag setzt die
    // Schranke neu: der nächste Versuch kommt frühestens nach REPERTOIRE_APPEND_EVERY_MS, zwei Fehlschläge hintereinander
    // liegen also mindestens so weit auseinander, und ein kurzer Neustart von RookHub bricht den Lauf nicht ab.
    const appendBetween = async () => {
      try {
        await appendNew();
        appendFails = 0;
      } catch (e) {
        lastAppendAt = Date.now();
        if (hoffnungslos(e) || ++appendFails >= REPERTOIRE_APPEND_MAX_FAILS) throw e;
      }
    };
    // Nach einem Abbruch den Rest sichern (best effort). Liefert, wie viele Linien dieser Lauf insgesamt gesichert hat.
    const saveRest = async () => {
      if (!incremental) return 0;
      try { await appendNew(); } catch (e) { /* die eigentliche Meldung zählt mehr als die Teilsicherung */ }
      if (appended.lines) ensureProgress(true);
      return appended.lines;
    };
    // Buch-Ziel: nach dem ersten gesendeten Kapitel ist am Server ein Import-Eintrag offen (bookOpen); kommt kein
    // finaler Chunk (Stopp, Fehler, unerwartete Antwort), schließt ihn das finally mit `aborted`.
    let sent = 0, bookOpen = false, failMsg = null;
    try {
      if (!bid) throw new Error(t('err.noCourse'));
      if (!Crawl) throw new Error(t('err.libMissing'));

      // Schon importierte oids (nur fürs inkrementelle Repertoire-Anhängen). Fehlt der Endpoint (alte
      // RookHub-Version) → leere Menge → es wird alles geholt (via Append, weiterhin dedupt).
      const prog = await fetchImportedOids(bid);
      const already = new Set((prog && prog.oids) || []);
      // Teil-Import: es wird etwas ausgelassen, der Stapel ist also nicht der ganze Kurs. Daran liest
      // der Server ab, dass eine Kollision der Positionsnummer nichts über die Identität aussagt.
      const partial = skipKnown && already.size > 0;

      lauf.phase = 'structure';
      setStatus(t('import.fetchingStructure'));
      let courseText = (cap.courseText && cap.bid === bid) ? cap.courseText : await listCacheGet(`${bid}:course`);
      if (courseText == null) {
        courseText = await chessableGetChecked(`getCourse?bid=${bid}`, 'course');
        listCachePut(`${bid}:course`, courseText);
      }
      const lids = Crawl.parseChapterLids(courseText);
      if (!lids.length) throw new Error(t('err.noChapters'));
      const lists = [];
      let total = 0, toFetch = 0;
      for (let li = 0; li < lids.length; li++) {
        const lid = lids[li];
        if (cancelRequested) { setStatus(t('import.aborted')); return; }
        // Mitzählen: bei 36 Kapiteln mit Pause stand hier sonst zwei Minuten lang „Kursstruktur" (Kurs 207313).
        lauf.phase = 'chapters';
        setStatus(t('import.fetchingChapters', { done: li + 1, total: lids.length }));
        const fromCapture = !!(cap.lists[lid] && cap.bid === bid);
        let listText = fromCapture ? cap.lists[lid] : await listCacheGet(`${bid}:${lid}`);
        const fromCache = !fromCapture && listText != null;
        if (listText == null) {
          listText = await chessableGetChecked(`getList?bid=${bid}&lid=${lid}`, 'list', { lid: String(lid) });
          listCachePut(`${bid}:${lid}`, listText);
        }
        harvestFromList(bid, listText);   // nHard je Linie auch beim aktiven Kurs-Holen ernten
        const oids = Crawl.parseLineOids(listText);
        lists.push({ lid, listText, oids });
        total += oids.length;
        toFetch += skipKnown ? oids.filter(o => !already.has(String(o))).length : oids.length;
        if (!fromCapture && !fromCache) await sleep(crawlPauseMs());   // Pause nur nach einem echten Abruf
      }
      const courseName = bestCourseName(bid);

      if (skipKnown && toFetch === 0) {
        setStatus(t('import.nothingNew', { count: total }));
        ensureProgress(true);
        return;
      }

      // Linien, die schon im geteilten RookHub-Cache liegen, setzt der Server beim Import selbst ein — dafür
      // weder getGame bei Chessable noch eine Pause. Mitgeschnittene (cap.games) brauchen die Abfrage nicht.
      const wanted = [];
      for (const { oids } of lists) {
        for (const oid of oids) {
          if (skipKnown && already.has(String(oid))) continue;
          if (cap.games[oid]) continue;
          wanted.push(String(oid));
        }
      }
      const shared = wanted.length ? await fetchSharedCachedOids(wanted) : new Set();

      let done = 0, skipped = 0, fromShared = 0;
      const fortschritt = () => (fromShared
        ? t('import.fetchingLinesShared', { done, total: toFetch, shared: fromShared })
        : t('import.fetchingLines', { done, total: toFetch }));
      let lastBookPartAt = Date.now();
      for (const { lid, listText, oids } of lists) {
        // lineOids parallel zu lines: der Server ordnet die Linien über die oid zu und füllt eine Linie ohne
        // Inhalt (null) aus dem geteilten Cache.
        const lines = [], lineOids = [];
        let sentUpTo = 0;   // Buch: so viele Linien dieses Kapitels liegen schon bei RookHub
        let pushedUpTo = 0; // Repertoire: so viele Linien dieses Kapitels liegen schon in newChapters (bzw. sind angehängt)
        // Repertoire: das noch nicht Gesammelte dieses Kapitels in den Anhänge-Puffer legen (gleiches chapterJson —
        // der Live-Append ordnet über die oid zu, ein Kapitel in mehreren Stücken ist dort kein Problem).
        const pushRest = () => {
          if (!incremental || pushedUpTo >= lines.length) return;
          newChapters.push({ chapterJson: listText, lines: lines.slice(pushedUpTo), lineOids: lineOids.slice(pushedUpTo) });
          pushedUpTo = lines.length;
        };
        // Buch: was von diesem Kapitel noch nicht gesendet ist, als Teil(e) schicken. Ein Kapitel kann für EINEN
        // Request zu groß sein (Kapitel 30 eines Lifetime-Repertoires riss am 2026-09-20 die 48 MB des Endpoints) —
        // darum dieselbe Byte-Schranke wie beim Mitschnitt; alle Teile tragen denselben chapterKey.
        const sendBookPart = async () => {
          if (incremental || sentUpTo >= lines.length) return;
          const rest = { chapterJson: listText, lines: lines.slice(sentUpTo), lineOids: lineOids.slice(sentUpTo) };
          const teile = Crawl.splitIngestChapters([rest]).flat();
          lauf.phase = 'sending';
          for (let pi = 0; pi < teile.length; pi++) {
            if (teile.length > 1) setStatus(t('import.chapterPart', { part: pi + 1, parts: teile.length }));
            await ingestChunk(sessionId, bid, target, courseName, teile[pi], false, { chapterKey: String(lid), partial });
            bookOpen = true;
          }
          lauf.sent += lines.length - sentUpTo;
          lauf.phase = 'lines';
          sentUpTo = lines.length;
          lastBookPartAt = Date.now();
        };
        // Beim Abbruch (Stopp, Chessable-Fehler) das schon Geholte noch abliefern — best effort: ist RookHub oder die
        // Erweiterung selbst weg, scheitert das eben auch.
        const rescueBookPart = async () => { try { await sendBookPart(); } catch (e) { /* der eigentliche Fehler zählt */ } };
        for (const oid of oids) {
          if (cancelRequested) {
            // Die schon geholten Linien dieses Kapitels sichern: Repertoire hängt sie an, das Buch schickt den Rest.
            pushRest();
            await rescueBookPart();
            const saved = await saveRest();
            setStatus(saved ? t('import.aborted') + ' ' + t('import.unexpected.saved', { count: saved }) : t('import.aborted'));
            return;
          }
          if (skipKnown && already.has(String(oid))) { skipped++; continue; }   // schon auf RookHub → nicht holen
          let g = cap.games[oid];
          if (!g && shared.has(String(oid))) {
            lines.push(null); lineOids.push(String(oid)); fromShared++;
            done++; setStatus(fortschritt());
            continue;
          }
          if (!g) {
            try {
              lauf.phase = 'lines';
              g = await chessableGetChecked(`getGame?lng=en&oid=${oid}`, 'game', { oid: String(oid) });
              lauf.fetched++;
            } catch (e) {
              // Die bis hierher geholten Linien dieses Kapitels sind geprüft — nicht verwerfen, egal woran der Abruf
              // scheiterte (unerwartete Antwort, Chessable-401, Netzfehler; Abbruch-Zweig unten).
              pushRest();
              await rescueBookPart();
              throw e;
            }
            await sleep(crawlPauseMs());
          }
          if (g && g.trim() && g.trim() !== '{}') { lines.push(g); lineOids.push(String(oid)); cap.games[oid] = g; harvestFromGame(bid, oid, g); }
          done++; setStatus(fortschritt());
          if (!incremental && Date.now() - lastBookPartAt >= BOOK_PART_EVERY_MS) { await sendBookPart(); setStatus(fortschritt()); }
          // Repertoire: auch MITTEN im Kapitel anhängen, wenn die Frist um ist — vorher nur an Kapitelgrenzen, und bei
          // einem großen Kapitel kam bei RookHub eine Viertelstunde lang nichts an (gemeldet 07.10.2026).
          if (incremental && Date.now() - lastAppendAt >= REPERTOIRE_APPEND_EVERY_MS && lines.length > pushedUpTo) {
            pushRest();
            await appendBetween();
            setStatus(fortschritt());
          }
        }
        if (!lines.length) continue;
        if (incremental) {
          pushRest();
          if (Date.now() - lastAppendAt >= REPERTOIRE_APPEND_EVERY_MS) await appendBetween();
        } else {
          await sendBookPart();   // der Rest des Kapitels (oder das ganze, wenn es in unter einer Minute geholt war)
        }
        sent++;
      }
      if (!sent) throw new Error(t('err.noLines'));

      if (incremental) {
        setStatus(t('import.appending'));
        const onPart = (part, parts) => { if (parts > 1) setStatus(t('import.appendingPart', { part, parts })); };
        // Schluss-Anhang: einmal wiederholen, bevor der Lauf als gescheitert gilt. Sonst meldete der Status „Fehler",
        // obwohl die Wiederholung in saveRest alles gespeichert hatte.
        try {
          await appendNew(onPart);
        } catch (e) {
          if (hoffnungslos(e)) throw e;
          await sleep(REPERTOIRE_APPEND_RETRY_MS);
          setStatus(t('import.appending'));
          await appendNew(onPart);
        }
        const res = appended;
        const fertig = skipped
          ? t('import.doneAppendedSkipped', { count: res.imported, skipped })
          : t('import.doneAppended', { count: res.imported });
        // Verknüpfte Alt-Linien nennen — sonst las sich ein Abruf mit hunderten nachgetragenen IDs als „0 angehängt".
        setStatus(res.linked ? fertig + ' ' + t('import.linkedNote', { count: res.linked }) : fertig);
      } else {
        setStatus(t('import.importing'));
        // Vollständig geholt → mit der echten getCourse-Antwort als komplett markieren; der Server legt den Kurs
        // dann als Ganzes im geteilten Cache ab (und prüft selbst Kapitelzahl und Lücken).
        // `complete` heißt: piratechess darf den Kurs als Ganzes cachen. Nach einem Teil-Import
        // stimmt das nicht — dieser Lauf hat die übersprungenen Linien gar nicht geholt.
        const res = await ingestChunk(sessionId, bid, target, courseName, null, true,
          { courseJson: courseText, complete: !partial, partial });
        bookOpen = false;
        markCourseFetched();
        setStatus(t(target === 'book' ? 'import.doneImportedPuzzles' : 'import.doneImportedLines', { count: res.imported }));
      }
      ensureProgress(true);
    } catch (err) {
      // Bis zum Abbruch geholte, geprüfte Linien noch anhängen — nur beim Repertoire, und bei JEDEM Fehler; beim Buch
      // sind die schon gesendeten Kapitel bereits importiert, den Eintrag schließt das finally mit `aborted`.
      const saved = await saveRest();
      if (err && err.unexpected) {
        await handleUnexpected(bid, err.unexpected, saved);
      } else if (err && err.notOwned) {
        failMsg = showNotOwned(bid, err.notOwned.courseName);
        setStatus(failMsg);
      } else {
        failMsg = t('import.error', { error: (err && err.message) || err });
        if (saved) failMsg += ' ' + t('import.unexpected.saved', { count: saved });
        setStatus(failMsg);
        // Jeder sonstige Abbruch geht an RookHub (Log + Admin-Nachricht) — auch und gerade, wenn der Versand an RookHub
        // selbst das Problem war: der Bericht nimmt den direkten Kanal, nicht den RookHub-Client (07.10.2026).
        reportCrawlError(bid, target, lauf, (err && err.message) || String(err));
      }
    } finally {
      if (bookOpen) {
        // Ohne Abschluss stünde der Import-Eintrag bis zum serverseitigen Aufräumen (30 min ohne Kapitel) auf
        // „läuft" — und die Rückmeldung sagte nicht, dass die bis hierhin geholten Kapitel im Kurs sind.
        try {
          const ack = await ingestChunk(sessionId, bid, target, null, null, true, { aborted: true });
          const note = t('import.abortedPartial', { chapters: (ack && ack.chapters) || 0, count: (ack && ack.imported) || 0 });
          if (cancelRequested) setStatus(note);
          else if (failMsg) setStatus(failMsg + ' ' + note);
          ensureProgress(true);
        } catch (e) { /* der Server schließt die Sitzung nach 30 min selbst */ }
      }
      crawling = false; crawlStartedAt = null;
    }
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckActivity = self.RepCheckActivity || {}).crawl = {
    init(deps) {
      ({ S, t, readConfig, cap, pageCourseId, bestCourseName, setStatus, fetchImportedOids, ensureProgress } = deps);
      ({ listCacheGet, listCachePut, chessableGetChecked, harvestFromList, harvestFromGame, sleep, crawlPauseMs } = deps);
      ({ ingestChunk, ingestLiveInParts, markCourseFetched, showNotOwned, handleUnexpected, reportCrawlError } = deps);
      Object.defineProperties(S, {
        crawling: { get: () => crawling, enumerable: true },
        crawlStartedAt: { get: () => crawlStartedAt, enumerable: true },
        cancelRequested: { get: () => cancelRequested, set: (v) => { cancelRequested = v; }, enumerable: true },
      });
    },
    newSessionId, REPERTOIRE_APPEND_EVERY_MS, BOOK_PART_EVERY_MS, REPERTOIRE_APPEND_MAX_FAILS,
    REPERTOIRE_APPEND_RETRY_MS, SHARED_CACHE_BATCH, fetchSharedCachedOids, crawlAndImport,
  };
})();
