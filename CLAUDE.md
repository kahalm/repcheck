# Project Rules

## Auslieferung

Dieses Repo liefert **eine** Variante: die **Browser-Extension (Manifest V3)** im Verzeichnis
`extension/` — Chrome Web Store + Firefox AMO. RookHub-Aufrufe laufen über den
Background-Service-Worker (`background.js`), nicht über direktes `fetch()`.

**Das Tampermonkey-Userscript ist am 2026-09-20 entfallen** (`repcheck.user.js`, zuletzt v1.61.0).
Es war eine zweite, von Hand gepflegte Fassung derselben Logik: 4978 Zeilen, davon 1182 generiert
(Shared-Regionen) — also rund **3800 Zeilen Doppelpflege**, um ganze **17 Egress-Aufrufe** zu
isolieren (`chrome.runtime.sendMessage` statt `fetch`). Der Preis dafür waren zehn dauerhafte
Rückstände, drei davon nicht kosmetisch: keine `lineOids` (der Parser ordnete Linien
positionsbasiert zu), kein Byte-Splitting beim Buch-Crawl (der 48-MB-Fehler vom 2026-09-20 blieb
dort offen und war ohne `lineOids` auch nicht sicher zu beheben) und keine Prüfung unerwarteter
Chessable-Antworten (v1.60.0) — der Userscript crawlte also in eine Chessable-Sperre hinein,
statt zu stoppen.

**Folgen für bestehende Installationen:** `@updateURL`/`@downloadURL` zeigten auf die
`master`-Raw-URL. Mit dem Entfernen der Datei bekommt Tampermonkey dort einen 404; installierte
Kopien laufen unverändert mit 1.61.0 weiter und erhalten nie wieder ein Update. Ein
Abschieds-Hinweis wurde bewusst NICHT mehr ausgeliefert (er hätte vor dem Entfernen erscheinen
müssen). Umkehrbar ist das: Datei zurück auf `master` → Updates laufen wieder.

**IndexedDB-Layout** (DB `RepertoireCheckerDB`, Stores `handles` + `rookhub`) bleibt unverändert.
Der **Token** liegt seit v1.19.1 nicht im (seiten-lesbaren) IndexedDB, sondern extension-privat in
`chrome.storage.local` (bewusster Sicherheits-Tradeoff, s. „Sicherheit").

## Versioning
- Bei jeder Änderung in `extension/` muss die `version` in `extension/manifest.json` erhöht werden.
- Das ist seit dem Wegfall des Userscripts (2026-09-20) das EINZIGE Versionsfeld; die frühere
  Paritätsregel zwischen zwei Feldern entfällt.
- SemVer: patch für Bugfixes, minor für neue Features, major für Breaking Changes.

## Geteilte Module (`extension/lib/`)

Die reinen Helfer leben in EINER Quelle unter `extension/lib/` und sind Node-getestet
(`npm test`). Sie werden geteilt, weil die Extension in ZWEI Welten läuft — isoliert
(`chessable-activity.js`, `content.js`) und MAIN (`chessable-fen.js`) —, die getrennte globale
Scopes haben, und weil dieselben Funktionen in den Unit-Tests laufen sollen.

| Datei | Global | Inhalt |
|---|---|---|
| `lib/repertoire-text.js` | `self.RepCheckLib` | `tokenizePgn`, `isMoveToken`, `parseMoveTokens`, `parsePgnText`, `normalizedFen`, `chessComPlayedAt`, `chessableSearchUrl` |
| `lib/i18n.js` | `self.RepCheckI18n` | Sprachtabelle (siehe „Oberflächensprache") |
| `lib/chessable-course-names.js` | `self.RepCheckCourseNames` | Kursnamen/Nav-Label/uid-Decode — `rc`-Präfixe, weil Top-Level-Deklarationen in der MAIN-World im `window` der Seite landen |
| `lib/chessable-crawl.js` | `RepCheckCrawl` | Crawl-/Ingest-Helfer (`splitIngestChapters`, `checkChessableResponse`, `looksBanned`, …) |
| `lib/chessable-feedback.js` | — | Zuordnung der Rückmeldungs-Icons |

Eine Lib wird als eigenes Content-Script VOR ihren Konsumenten geladen (Manifest
`content_scripts`) und beim Nachladen aus dem Popup mit injiziert (`executeScript`). Wer eine
neue Lib anlegt, trägt sie an BEIDEN Stellen ein — `test/chessable-course-names.test.js` prüft
Manifest-Auslieferung und Lib-Nutzung und schlägt bei einer wiederauferstandenen Inline-Kopie fehl.

**Workflow bei einer Logik-Änderung:** nur die Lib ändern → `npm test`. Der frühere Build-Schritt
(`build/assemble.mjs`, Sentinel-Regionen, `npm run build:userscript`) ist mit dem Userscript
entfallen — es gibt nichts mehr zu generieren.

**Eigenheiten einzelner Funktionen:**

- **⚙-Status/Settings-Banner (`showBanner`)** — ist ein **No-op** und das ⚙ entfernt; Einstellungen laufen über das Popup („Einstellungen" → `openSettings` → `togglePanel`), das Prüf-Ergebnis bleibt über `highlightDeviation` direkt in der Zugliste markiert.
- **Chessable-FEN-Tools** — `chessable-fen.js` blendet seine Buttons seit v1.14.0 NUR im **Practice-Mode** ein (`isPracticeMode()` = `location.pathname` beginnt mit `/practice`); bei SPA-Navigation aus dem Practice-Mode raus wird die UI per `removeUi()` wieder entfernt. Seit v1.33.0 ist **jeder Button (Extension) einzeln ein-/ausblendbar** über das Popup (`chessableButtons` in `chrome.storage.local`): chessable-fen.js (MAIN-World, kein chrome.*-Zugriff) bekommt die Einstellung per postMessage-Bridge `chessable-buttons` von chessable-activity.js (isoliert, `chrome.storage.onChanged` → Live-Update) und blendet die Buttons via `applyButtonSettings()` ein/aus. **Seit v1.59.0 ist dort alles standardmäßig aus**: nur ein gespeichertes `true` zeigt ein Element, ein fehlender Schlüssel heißt aus (auch vor dem Eintreffen der Einstellung — kein Aufblitzen). Neben den sechs Buttons hängen auch der ⏳-Pool-Zähler (`pool`) und die Zug-Rückmeldung (`feedback`) an eigenen Schaltern (`buttonEnabled()` in `renderPool`/`renderFeedback`, auch im Zen). Ein neuer Button braucht also Checkbox in `popup.html`, Eintrag in `CB_KEYS` und `btnRefs` — `test/chessable-buttons.test.js` hält die drei gleich.
- **Button-Styling** — seit v1.14.0 KEINE site-spezifischen Farben mehr; chess.com nutzt dasselbe dezente Dark/Light-Styling wie Lichess (die `[data-site="chesscom"]`-CSS-Overrides sind raus).
- **„Partie speichern" (💾)** — bei Erfolg wird der öffentliche Teilen-Link `{RookHub-URL}/g/{shareToken}` (aus der Server-Antwort) in die Zwischenablage gelegt (`buildShareLink`); Button quittiert mit 🔗. Egress: `rookhubProxy`.
- **RookHub-Import (Browser) auf chessable.com** — seit v1.30.0 lebt die Import-UI (Ziel Repertoire/Buch, „⚡ Kurs holen", Mitschnitt importieren, „live anhängen", Fortschritt) im **Extension-Popup**, NICHT mehr als On-Page-Panel. Das Popup pollt/steuert `chessable-activity.js` (isolierte Welt) per `chrome.runtime.onMessage` `{type:'rc-import', action}` (`state`/`setTarget`/`crawl`/`importCaptured`/`setLive`/`refreshProgress`). Die In-Page-Marker (✓/○ an den Linien) + die ganze Import-/Crawl-/Live-Logik bleiben im Content-Script.
- **Kurs-holen-Pause** (v1.56.0) — zwischen zwei Chessable-Abrufen (`getList`, `getGame`) wartet der Crawl eine **zufällige** Zeit, Standard 2,5–3,5 s. **Extension**: im Popup unter „Einstellungen" einstellbar (`chrome.storage.local` `crawlDelay` = `{minMs,maxMs}`), aber **nur nach oben** — `normalizeCrawlDelay` in `lib/chessable-crawl.js` (von Popup UND `chessable-activity.js` genutzt) hebt alles unter 2,5 bzw. 3,5 s an, erzwingt max ≥ min und deckelt bei 120 s; `chessable-activity.js` führt den Wert per `storage.onChanged` live nach, auch in einen laufenden Crawl. Gewartet wird nur nach einem ECHTEN Abruf — aus dem Mitschnitt stammende Kapitel kosten keine Pause mehr (vorher 3 s auch ohne Request). Das Backoff bei 429/5xx bleibt auf Basis 3 s (`CRAWL_BACKOFF_BASE_MS`: 6/12/24/30 s).
- **Geteilter Linien-Cache beim Kurs holen** (v1.57.0, **Extension-only**) — nach der Kapitel-Phase fragt `crawlAndImport` per `POST /api/extension/chessable/cached-lines` (Batches à 5000), welche der noch zu holenden oids schon im geteilten piratechess-Rohdaten-Cache liegen. Für diese kein `getGame` und keine Pause: die Linie geht als `null` mit ihrer oid in den Ingest, piratechess setzt den Inhalt serverseitig ein (der Inhalt erreicht den Browser nie). Jeder Ingest (`crawlAndImport`, `flushLive`, `buildIngestChapters`) schickt je Kapitel **`lineOids` parallel zu `lines`** — ohne sie las der Parser positionsbasiert, und ein Teil der Linien eines Kapitels (inkrementell/live/Mitschnitt) landete unter der oid und dem Namen der ersten Einträge, galt also nie als importiert. Der finale Buch-Chunk trägt `courseJson` (echte getCourse-Antwort) + `complete: true` → piratechess cacht den Kurs als Ganzes, sofern lückenlos. Umgekehrt landen per Browser geholte Linien im Cache (nie überschreibend). Abwärtskompatibel: alte RookHub-Version → `cached-lines` 404 → nichts gecacht → alles selbst holen, keine `null`-Linien.
- **Import in Portionen** (v1.59.1, **Extension-only**) — „Mitschnitt importieren", „⚡ Kurs holen" (inkrementell) und „live anhängen" schicken nicht mehr alles in EINER Anfrage: `splitIngestChapters` (lib/chessable-crawl.js) schneidet nach UTF-8-Bytes auf ≤ 8 MB je Anfrage und verteilt ein zu großes Kapitel auf Teile mit derselben `chapterJson` (nur mit `lineOids`, sonst bleibt es ganz). Anlass: Felix bekam am 2026-09-14 viermal 413 — RookHubs Frontend-nginx deckelte `/api/` auf 15 MB, und Linien kommentierter Kurse wiegen entpackt ~0,5 MB. Beim Mitschnitt geht die erste Portion über `/ingest` (Import-Eintrag, Benachrichtigung), der Rest über `/ingest/live`. Der Buch-Crawl (`ingest/chunk`) blieb dabei zunächst ungeteilt (ein Kapitel je Anfrage) — das fiel am 2026-09-20 auf die Füße, s. v1.61.0. Seit 1.59.2 zählt „Kurs holen" die Kapitellisten sichtbar mit (`import.fetchingChapters`, vorher stand bei 36 Kapiteln mit Pause zwei Minuten „Kursstruktur") und nennt in der Abschlussmeldung auch verknüpfte Alt-Linien (`linked` aus `ingest/live`, RookHub ≥ 0.478.7; `import.linkedNote`) — ein Abruf, der 641 Linien ihre oid nachtrug, las sich sonst als „0 neue Linien angehängt".
- **Unerwartete Chessable-Antwort stoppt „Kurs holen"** (v1.60.0, **Extension-only**) — `crawlAndImport` holt getCourse/getList/getGame über `chessableGetChecked`, das jede Antwort mit `checkChessableResponse` (lib/chessable-crawl.js) prüft. Abbruch bei: kein 2xx (nach den 429/5xx-Wiederholungen; `chessableGet` hängt dafür `chessableStatus`/`chessableBody` an den Fehler), kein JSON, `{"error":…}` statt Daten, JSON ohne `course.data`/`list.data`/`game` (auch `{}`). 401 bleibt der bekannte Fehler (Anmeldung abgelaufen). Dahinter kann eine Anti-Crawling-Maßnahme stecken, deshalb: (1) die bis dahin geholten, geprüften Linien werden beim Repertoire noch angehängt — sonst müsste ein erneuter Lauf sie wieder bei Chessable holen (beim Buch nicht, das braucht den ganzen Kurs am Stück); (2) Karte auf der Seite und Hinweis im Popup (`rcCrawlAlert` in `chrome.storage.local`) mit Discord-Link und der Bitte, VOR einem erneuten Versuch dem Entwickler Bescheid zu geben — das Popup fragt vor dem nächsten „Kurs holen" nach und löscht den Hinweis erst nach der Bestätigung; (3) Meldung an RookHub (`POST /api/extension/chessable/unexpected-response`, RookHub ≥ 0.478.8) mit Endpunkt, lid/oid, Status, Grund, Fehlermeldung und einem Ausschnitt ≤ 1000 Zeichen, aus dem `scrubSnippet` E-Mail- und IP-Adressen entfernt (eine Cloudflare-Sperrseite nennt die IP). Sieht die Antwort nach einer Sperre aus (`looksBanned`: Fehlermeldung bzw. Nicht-JSON-Text mit banned/suspended/blocked/deleted — dieselbe Wortliste wie RookHubs `ChessableResponseAlertService.LooksBanned`, nur gemeinsam ändern), schreibt RookHub den Admins (höchstens einmal je Nutzer in 24 h), und die Karte sagt das. Anlass: zu 31 Linien kam am 30.06.2026 nur `{"error":{"message":"User is banned or deleted"}}`, und die lagen monatelang als „gecacht" im Linien-Cache. Passive Wege (Mitschnitt, ✓/○-Fortschritt, Startseiten-Zähler) prüfen bewusst nicht — sie holen nicht aktiv.
- **Kursname: Kachel-Badges kappen, Linie fragen, Buch-Abbruch abschließen** (v1.60.2) — (1) Chessables Kurskachel ist EIN Link, dessen `textContent` Titel und Fortschrittsbadges zusammenklebt („Short & Sweet0%Priority0/15variations✓ 0/15" hieß am 19.09. ein Repertoire). `rcCleanCourseTitle` (lib/chessable-course-names.js) kappt am ersten Badge (`\d%`, Priority/Priorität, `N/M variations|Varianten|lines|Linien`, `✓ N[/M]`); alle drei `currentCourseName()` (chessable-activity.js, chessable-fen.js) bevorzugen ein Überschriften-Element im Link und laufen den Text hindurch. (2) Vor dem Seitentext kommt `game.name` aus einer mitgeschnittenen/geholten Linie (`parseCourseNameFromGame` in lib/chessable-crawl.js) — Chessables eigene Angabe, auch für Kurse, die nicht im Konto liegen und deshalb in der Kursliste per Token fehlen. RookHub ≥ 0.484.1 liest denselben Wert serverseitig aus den Linien und stellt ihn vor den gesendeten Namen. (3) Buch-Ziel: nach dem ersten gesendeten Kapitel ist am Server ein Import-Eintrag offen (`bookOpen`); erreicht der Lauf den finalen Chunk nicht (Stopp, Fehler, unerwartete Antwort), schickt das `finally` `ingestChunk(…, true, { aborted: true })` — der Eintrag schließt mit Zählern, die importierten Kapitel bleiben, Status `import.abortedPartial`. Vorher blieb er am Server bis zum Aufräumen (30 min) auf „läuft".
- **Buch-Crawl teilt große Kapitel** (v1.61.0, **Extension-only**) — der Buch-Zweig von `crawlAndImport` schickt ein Kapitel nicht mehr als EINE Anfrage, sondern durch dasselbe `splitIngestChapters` wie Mitschnitt/Repertoire (≤ 8 MB je Anfrage). Anlass: Kapitel 30 („London System – Mainline", 87 Linien) eines Lifetime-Repertoires riss am 2026-09-20 das 48-MB-Limit von `ingest/chunk`; Kestrel lehnt anhand `Content-Length` ab, und RookHubs Fehler-Handler machte daraus ein nacktes **HTTP 500** — der Lauf starb dort, alles ab diesem Kapitel fehlte (Felix: 1290 von 1881 Linien). Die Teile tragen denselben `chapterKey` (die lid) und bleiben serverseitig EIN Kapitel: RookHub ≥ 0.495.0 hält die Kapitelnummer und schiebt nur die LINIENnummer weiter — der Parser wirft die Einträge ohne Inhalt aus `list.data` und begänne sonst je Teil wieder bei `.002`, also genau auf den Linien des Vorgängers (LineId = `Datei:Round`). Alt-Client ohne `chapterKey` → jeder Chunk ist wie bisher ein eigenes Kapitel.
- **Eine Import-Schiene: auch das BUCH holt inkrementell** (v1.63.0) — `crawlAndImport` überspringt jetzt für BEIDE Ziele die Linien, deren oid schon auf RookHub liegt. Der frühere Schalter `incremental = target !== 'book'` bündelte zwei verschiedene Fragen; er ist in `skipKnown` (was wird geholt) und `viaSession` (wie wird es geschickt) zerlegt. Das Buch war ausgenommen, weil seine LineId an der Round-Nummer hängt und ein Skip die Nummerierung verschiebt — seit RookHub **0.496.0** ist die Chessable-oid die Identität einer Linie und die Nummer nur ein Etikett, seit **0.497.1** sucht der Import bei einer Kollision den nächsten freien Platz. Jeder Chunk trägt deshalb `partial`, sobald etwas übersprungen wurde: daran erkennt der Server, dass eine Nummern-Kollision NICHTS über die Identität aussagt (ohne das Signal deutet er dieselbe Kollision umgekehrt — als dieselbe Linie mit geändertem Inhalt, was bei einem vollständigen Re-Import richtig ist). Der finale Chunk meldet `complete: !partial` — nach einem Teil-Import hat der Lauf die übersprungenen Linien gar nicht geholt, piratechess dürfte den Kurs also nicht als Ganzes cachen. **Braucht RookHub ≥ 0.497.1** (kein Fallback eingebaut: Server und Extension gehören demselben Betreiber). Was der Umbau NICHT ändert: der Transportweg. Das Buch streamt weiter über die Chunk-Sitzung (`ingest/chunk` — daran hängen Import-Eintrag, Benachrichtigung und Watchdog), das Repertoire hängt über `ingest/live` an; das ist ein Unterschied im Lebenszyklus, keine doppelte Logik. Nutzen: ein halb importierter Kurs kostet beim erneuten Holen nur noch die fehlenden Linien statt aller (gemeldeter Fall: 591 statt 1881).
- **Fortschritts-Zähler auf Kursübersicht und Startseite** (v1.58.0, **Extension-only**) — zweiter Anlauf nach dem Revert von v1.52.0, diesmal mit Ankern aus echten Inspector-Dumps (volles `pageHtml`, 13.09.): Kursübersicht `#chapterBoxes a.levelBox[href=/course/{bid}/{lid}]` → Badge `✓ done/total` in `.progressVisuals` neben Chessables eigenem Zähler, Kurs-Summe an `h1.courseUI-bookChapter`; Startseite `#mainBooksList .bookHome[data-bid]` → Badge in `.bookDetails` (NIE über Links — dieselben Kurs-Links stehen auch in Dropdown-Menüs). Zähler = Schnittmenge aus `/chessable/progress`-oids und der Kursstruktur (getCourse `includeVariations`), nicht der rohe oid-Count (das war der 413-bei-365-Fehler). Kursstruktur wird je bid in `chrome.storage.local` `courseStructures` gemerkt (7 Tage, max. 80 Kurse, `pruneStructures`); Kurs-/Kapitelseiten legen sie beim Laden ab, die Startseite holt fehlende mit Pause (`crawlPauseMs`, max. 25 je Besuch) und zeigt Badges nur für Kurse, die auf RookHub liegen. `ensureProgress` läuft nur noch auf `/course|practice|learn/{bid}` — vorher löste die Startseite ein getCourse für den erstbesten Kurs-Link aus.


## Einführung für neue Nutzer (v1.59.0, Extension-only)

- **Willkommensseite** `welcome.html` + `welcome.js` (in der Extension, kein Netzabruf): `background.js` öffnet sie bei `runtime.onInstalled` mit `reason: 'install'` genau einmal; danach erreichbar über Popup → „Einstellungen" → „Einführung öffnen" (auch aus der Checkliste). Drei Schritte, jeder mit Aktion: (1) verbinden — dieselbe Ein-Klick-Verbindung (`rookhub-pair`) wie im Popup, Zustand live über `storage.onChanged`; (2) was RepCheck wo tut; (3) Chessable-Buttons ankreuzen — derselbe Speicher `chessableButtons`. `#usage`/`#buttons` springen direkt zum Abschnitt.
- **„Erste Schritte" im Popup**: nur bei `rcOnboarding === 'active'` (setzt der Install-Handler — Bestandsnutzer sehen sie nie) und bis alles erledigt oder weggeklickt ist (`'dismissed'`). Erledigt = Token in `rookhubConfig` · `rcCourseFetched` (setzt `chessable-activity.js` nach jedem erfolgreichen Import: Kurs holen, Mitschnitt, Live) · `chessableButtons` je gespeichert.
- **Hinweis für Updater**: `onInstalled` mit `reason: 'update'` und `previousVersion` < 1.59.0 setzt `rcButtonsNotice: 'pending'` → Hinweis im Popup UND einmal als Banner auf `/practice` (genau dort fehlen die Buttons). „OK", „Buttons auswählen" oder jede gespeicherte Button-Auswahl setzen `'done'`. Content-Scripts öffnen die Willkommensseite über `{type:'rc-open-welcome'}` am Worker (Absender-Prüfung wie beim Fetch-Proxy).
- Die Entscheidungen sind rein und getestet (`versionLess`/`onboardingPlan` in background.js, `onboardingState` in popup.js → `test/onboarding.test.js`); die Button-Schlüssel stehen in popup.js UND welcome.js, der Test hält sie gleich und prüft, dass jeder benutzte Text-Schlüssel existiert.
- **Ohne RookHub-Verbindung** (kein Token in `rookhubConfig`) zeigt `chessable-activity.js` bei JEDEM Laden einer chessable.com-Seite die Karte „RepCheck ist noch nicht mit RookHub verbunden" — ohne Token kann die Extension dort fast nichts. „Später" gilt nur für diese Seite, „Jetzt verbinden" öffnet die Willkommensseite bei `#connect`; ein Verbinden in einem anderen Tab räumt die Karte live weg. Solange sie gilt, wartet der Update-Hinweis. Alle Karten (Verbinden, Zustimmung zu getReview, Update-Hinweis) stapeln sich in EINEM Halter `#repcheck-banners` unten links (`bannerHost`/`bannerCard`) statt einzeln fixiert übereinander zu liegen.

## Oberflächensprache (v1.42.0+)

Popup und In-Page-Panel sprechen **en/de/hr**. Einzige Quelle ist `extension/lib/i18n.js`
(`RC_MESSAGES[lang][key]`) — einquellig, seit dem Wegfall des Userscripts gibt es nichts mehr
zu generieren (die dortige Region war **generiert
und wird nicht von Hand editiert**.

- **Sprachwahl**: `chrome.storage.local['rcLang']` (Extension) bzw. `GM_setValue('rcLang')`
  Fehlt der Wert, entscheidet `navigator.languages`; Fallback ist `en`. Schalter
  sitzt im Popup UND im In-Page-Panel (dort ist das Panel die
  einzige Einstellungsfläche).
- **Warum nicht `chrome.i18n`/`_locales`**: das folgt der Browser-Sprache und ist zur Laufzeit
  nicht umschaltbar; RookHub hat aber eine Nutzer-Sprachwahl, und die soll hier genauso gehen.
  Dazu existiert `chrome.i18n` weder in der MAIN-World (`chessable-fen.js`, dort ist `chrome` das
  Objekt der SEITE). Eine Tabelle lässt sich in beide Welten laden, eine
  API nicht. `_locales` bleibt für die drei Manifest-Felder sinnvoll (siehe TODO).
- **Plural** über `Intl.PluralRules`: Einträge sind `{ one, few, other }`. Kroatisch braucht die
  `few`-Form (1 linija / 2–4 linije / 5+ linija) — das Ternary-Muster des Bestands
  (`'Datei' + (n===1?'':'en')`) fällt dort auseinander. Ein Test erzwingt die `few`-Form.
- **Platzhalter** sind benannt (`{count}`, `{error}`, …), nie konkateniert. Bedingte Teilsätze
  bekommen einen EIGENEN Schlüssel (`import.doneAppended` vs. `…Skipped`), weil der Zusatz nicht
  in jeder Sprache am Satzende steht.
- **Neuer Text?** Schlüssel in `lib/i18n.js` in ALLEN drei Sprachen anlegen → `npm test`
  (prüft Schlüssel-, Platzhalter- und Plural-Parität).
- **Noch nicht umgestellt**: die On-Page-Knopfleiste auf chessable.com (`chessable-fen.js`) —
  siehe TODO.md.

## Site-Adapter (v1.5.0+)

`extension/content.js` hat ein `ADAPTERS`-Objekt mit einem Eintrag pro unterstützter Plattform (`chesscom`, `lichess`). Jeder Adapter exportiert:
- `test(host)` — entscheidet, ob er für `location.hostname` zuständig ist
- `isReviewPage()` — Site-spezifischer URL/DOM-Check für die Analyse-Seite
- `getMoveListEl()` — liefert das Container-Element der Zugliste
- `getMoveNodes(root)` — alle Hauptlinien-Knoten (Lichess nutzt `:scope > move`, um Varianten auszublenden)
- `extractSan(node)` — extrahiert SAN aus einem Knoten; bei Lichess inkl. Mapping `♔♕♖♗♘ → KQRBN` für Figurinen-Notation
- `findBannerContainer()` — wohin das Repertoire-Banner injiziert wird

Neue Plattform hinzufügen = neuen Adapter-Eintrag in beide Dateien einfügen. Restlogik bleibt unverändert.

## RookHub-Integration (v1.3.0+, server-seitige Analyse seit v1.6.0)

Die Extension kann das Repertoire wahlweise aus einem **lokalen Ordner** (File System Access API / File Input) ODER aus einer **RookHub-Instanz** laden. Bei RookHub bleibt das Repertoire-PGN seit v1.6.0 auf dem Server — der Client schickt die SAN-Zugliste der aktuellen Partie, der Server liefert ply-weise Annotationen zurueck.

### Setup (Extension, ab v1.55.0)
Popup → **„Einstellungen"** (geht auf JEDEM Tab, auch auf chessable.com oder einem leeren Tab)
→ **„🔗 Mit RookHub verbinden"**. Der Background-Worker öffnet dazu einen RookHub-Tab
(offenen wiederverwendend, sonst unsichtbar im Hintergrund), wartet ggf. auf die Anmeldung und legt
sich den `rkh_`-Token über `POST /api/profile/tokens` selbst an — kein Copy&Paste. Details unter
„Ein-Klick-Verbindung". Rückfall für Selbsthoster/Sonderfälle: „Token von Hand eintragen" im selben
Aufklapper (URL + `rkh_…` aus **Profil → Extension-Tokens**).

**Warum das so wichtig ist**: bis v1.54.x gab es die Eingabe NUR im seiten-injizierten Panel, und
das lebt nur auf chess.com/lichess. Wer die Extension für Chessable installiert hatte, musste erst
chess.com aufrufen, um sie überhaupt verbinden zu können. Die Verbindung darf deshalb nie wieder an
einer Site hängen — `test/rookhub-connect.test.js` hält das fest.

### Ein-Klick-Verbindung (nur Extension, v1.55.0+)
Ablauf in `background.js` (`pairStart` → `pairAttempt`), Zustand in `chrome.storage.local`
(`rookhubPairing`), Bedien-Oberfläche im Popup (`#rookhub-conn`):
1. Popup schickt `{type:'rookhub-pair', url}`; die URL wird normalisiert (Schema ergänzt, Slash weg,
   Klartext-HTTP nur für localhost) und **vor** dem ersten Fetch als `rookhubConfig.url` abgelegt —
   daran hängt die Egress-Allowlist des Proxys.
2. Offener RookHub-Tab wird wiederverwendet, sonst einer mit `active:false` geöffnet.
3. Pro Anlauf: Tab-URL gegen die Ziel-Origin prüfen → `chrome.scripting.executeScript` liest
   `localStorage['rookhub_user'].token` (das Anmelde-JWT der RookHub-SPA) → `POST /api/profile/tokens`
   (`{name:'RepCheck (<Browser>)', scope:'extension'}`) → `rookhubConfig = {url, token}`.
4. Kein/abgelaufenes JWT → Zustand `waitingLogin`, Tab kommt nach vorn; nach der Anmeldung weckt
   `tabs.onUpdated` den nächsten Anlauf. Das **Popup ist dann längst zu** — deshalb liegt der Ablauf
   im Worker und nicht im Popup, und deshalb steht der Zustand im Storage und nicht im Speicher.
5. Erfolg: Badge „✓", selbst geöffneter Hintergrund-Tab wird geschlossen. **Reihenfolge beachten:**
   erst `state:'done'` schreiben, dann den Tab schließen — sonst meldet `tabs.onRemoved` den eigenen
   Tab-Schluss als „abgebrochen" und überschreibt den Erfolg (genau dieser Bug war da).
6. `pairBusy` verhindert, dass Popup-Poll und `tabs.onUpdated` gleichzeitig je einen Token anlegen.

Das JWT wird **nicht** gespeichert — es dient allein diesem einen POST; persistiert wird nur der
`rkh_`-Token (extension-privat). Gelesen wird es nur nach ausdrücklichem Klick und nur aus einem Tab,
dessen Origin zur eingetragenen RookHub-Adresse passt.

### Verhalten
- **Pro Review-Page** ein `POST /api/extension/analyze-game` mit `{ moves, kind, refresh }`. Antwort: `{ deviation, gaps, inRepertoire, fenBeforeDeviation, repertoireFileCount, illegalMoveAt }`. Der Move-Cache (`lastGameMovesKey`) verhindert Redundanz-Requests, wenn sich die Zugliste nicht aendert.
- **„Aktualisieren"** im Panel sendet `refresh: true` und invalidiert damit den serverseitigen Positions-Set-Cache.
- **Auth**: jeder Request schickt `Authorization: Bearer rkh_…`. Bei 401 wird der Fehler im Status-Text gezeigt; der Token bleibt gespeichert (User muss ihn aktiv im Panel neu eintragen).
- **Offline-Fallback**: schlaegt der Server-Call fehl und ein lokales Position-Set aus einer frueheren Session liegt im IDB-Cache (`positionSet`-Key), wird darauf zurueckgegriffen. Ansonsten Fehler-Banner.
- **Lokaler Modus**: ohne RookHub-Config funktioniert der lokale Folder-/PGN-Mechanismus genauso wie vor 1.3.0 — Position-Set wird vollstaendig im Browser gebaut, persistiert im IDB-Store `rookhub/positionSet`.

### Endpoints (Server-Seite)
- `POST /api/extension/analyze-game` → Body `{ moves: string[], kind?: "Opening"|…, refresh?: bool }` → Response wie oben. Max. 600 plies.
- `GET /api/extension/repertoires?kind=opening` → `[{ id, name, fileCount, kind, totalSizeBytes }]` *(seit 1.6.0 vom Client ungenutzt, fuer kuenftige Tools verfuegbar)*
- `GET /api/extension/repertoires/{id}/pgn` → `text/plain` kombiniertes PGN *(seit 1.6.0 vom Client ungenutzt)*
- Alle akzeptieren JWT und API-Token; API-Token muss `scope=extension` haben.

### Server-Cache (RookHub, `RepertoireAnalyzeService`)
- Per User+Kind, Schluessel `ext:posset:{userId}:{kind}` im `IMemoryCache`.
- TTL: 15 min absolute / 5 min sliding.
- Invalidierung aus `RepertoireService` bei: `UploadFileAsync`, `DeleteFileAsync`, `DeleteAsync`, sowie `UpdateAsync` wenn sich `Kind` aendert.

### IndexedDB-Layout
- DB `RepertoireCheckerDB`, version 2
- Store `handles` (v1) — File System Access API directory handle
- Store `rookhub` (v2):
  - Key `config` → `{ url: string }` (seit v1.19.1 OHNE Token — der liegt extension-privat in `chrome.storage.local`/GM-Storage, nicht im seiten-lesbaren IDB)
  - Key `cache` → `{ pgnTexts: string[], savedAt: number, count: number }`

## Partie kopieren / speichern → RookHub (Copy v1.12.0, Save-Payload v1.13.0)

Auf chess.com/lichess-Review-/Analyse-Seiten blendet RepCheck zwei Buttons in den Floating-Wrap:
- **📋 `#repcheck-copy-pgn`** (`copyGamePgn` → `buildGamePgn`): kopiert die aktuelle Partie als PGN
  in die Zwischenablage (immer sichtbar im Review-Modus).
- **💾 `#repcheck-save-game`** (`syncSaveButton`): **nur wenn RookHub konfiguriert** — schickt die
  Partie an `POST /api/extension/games`; sie erscheint im RookHub-Bereich **„Partien"** (`/games`).

**Wann sie erscheinen (v1.64.0)**: nicht mehr nur bei den Pfaden `/analysis/game/` bzw.
`/game/review/`, sondern auf JEDER chess.com-Seite, die BEIDES hat — (a) einen Link auf
`/analysis/game/…` (so sieht der „Partieanalyse"-Knopf aus; erkannt am ZIEL, nicht an der
übersetzten Beschriftung) und (b) eine Zugliste mit `.node`-Zügen. Ohne (b) stünden sie auch in der
Partien-Liste, wo jede Zeile auf die Analyse verlinkt. Gemeldet am 23.09.2026 für `/game/<id>`:
Zugliste und Analyse-Knopf sind da, aber keine Pfad-Regel traf. Die Zugliste heißt dort
`wc-simple-move-list` und trägt die Klasse `move-list`, der bestehende Selektor passt also
(`chessComMoveList()`). Weil der Knopf erst mit dem Partieende entsteht und sich dabei weder
`<title>` noch Adresse ändern (die beiden Beobachter in `watchNavigation` feuern nicht), bewertet
ein Takt von `REVIEW_POLL_MS` (2 s) neu — zwei `querySelector`, und jede Injektion prüft ihre id.

**Save-Payload (v1.13.0+)**: `{ source, moves[], externalId?, white?, black?, result?, sourceUrl? }`
— die per Site-Adapter (`getGameMoves`) extrahierte SAN-Hauptlinie + Best-Effort-Metadaten
(`getGameMeta`: `externalId` aus URL, `result` aus dem Ergebnis-Token der Zugliste, `white`/`black`
aus `og:title`/`document.title`). Der **Server** baut daraus das PGN und dedupliziert über
(User, Source, ExternalId). (Bis v1.12.0 schickte der Button stattdessen ein client-seitig gebautes
`{ pgn, sourceUrl }` — auf das reichere Format umgestellt, ohne den 📋-Copy-Pfad zu ändern.)

- **Egress**: `rookhubProxy()`
  zum Background-Worker (CORS-frei). Beide Pfade identisch außer diesem Fetch (wie `rookhubAnalyzeGame`).
- **Privacy**: liest nur Zugliste + Seitentitel/URL lokal; sendet ausschließlich an die konfigurierte RookHub-Instanz.

## Sharebar: Link zur aktuellen Line (v1.25.0+, **Extension-only**)

Das **Popup** zeigt oben eine „Sharebar" mit einem öffentlichen Nur-Ansehen-Link
(`{RookHub-URL}/l/{token}`) zur aktuell auf chess.com/lichess gespielten Zugfolge —
kein Button-Umweg, direkt beim Öffnen des Popups sichtbar/kopierbar.
- **Ablauf** (`popup.js` `initShareBar`): nur bei konfigurierter RookHub-Instanz + chess.com/lichess-Tab.
  `getCurrentLineFromTab` lazy-injiziert content.js (`ensureContentLoaded`) und ruft die neue
  API-Methode `window.__rdc_loaded.getCurrentLine()` (→ `{ moves, title }` aus `getGameMoves()`),
  dann `POST /api/extension/share-line { moves, title }` über den Background-Worker → `{ shareToken }`.
- **Dedup**: serverseitig über die **Zugfolge** (nicht den variablen Seitentitel) → derselbe Spielstand
  liefert denselben Link (`SharedLineService.CreateStandaloneAsync`, RookHub).
- `getCurrentLine`
  lebt in `content.js`.
- **Privacy/Egress**: wie „Partie speichern" — nur Zugliste + Seitentitel lokal gelesen, Egress via
  Background-Worker an die konfigurierte RookHub-Instanz.

## Chessable-Token-Auslese (v1.8.0+)

Unabhaengig von der Repertoire-Pruefung kann die Extension auf **chessable.com**
den eigenen API-Token auslesen, damit ihn das externe Tool
**[piratechess](https://github.com/kahalm/piratechess)** (Chessable-Kurs-Export
nach PGN) nutzen kann. Der Token wird **nicht** verschickt — er landet nur lokal
und wird per Copy-Button im Popup in die Zwischenablage gegeben.

- **Quelle**: `localStorage['chessable.web.production.JWT']` im Page-Origin.
  Content-Scripts teilen sich die localStorage der Seite → direkter Lesezugriff,
  keine fetch/XHR-Interception noetig. `extractJwt` deckt Rohwert, JSON-String
  und `{token|jwt|accessToken|access_token}`-Objekt ab.
- **Extension**: `chessable-token.js` (isoliertes Content-Script, matcht
  `*.chessable.com`) liest den Key bei Load, Tab-Fokus, `visibilitychange` und
  `storage`-Events und schreibt `{ token, capturedAt, origin }` nach
  `chrome.storage.local` Key `chessableToken`. Das Popup liest denselben Key
  (origin-uebergreifend, daher NICHT IndexedDB) und aktiviert „Token kopieren".
  Braucht die `storage`-Permission im Manifest.
- **Privacy**: rein lokal (localStorage → clipboard / chrome.storage.local),
  kein Netzwerk-Egress, kein Logging des Tokens.

## Chessable-FEN-Tools (v1.9.0+)

Auf chessable.com blendet RepCheck unten rechts Knoepfe ein — **Copy FEN**
(aktuelle Brettstellung in die Zwischenablage), **Search FEN** (oeffnet die
Chessable-FEN-Suche, kursintern `/course/<id>/fen/…` mit Fallback global),
**Refresh** (`location.reload()`) und **Remember line** (FEN an RookHub merken,
s. u.). Die **XP-Anzeige** der zuletzt erspielten Punkte ist seit **v1.14.3
vorerst deaktiviert** (Badge nicht gerendert, `initPointsTracker`/
`attachNextVariationListener` nicht aufgerufen — Code bleibt für späteres
Re-Aktivieren erhalten; gilt für `chessable-fen.js`).
Ursprung:
[chessable-extension](https://github.com/kahalm/chessable-extension) (v0.9.4),
erweitert.

**Remember line (v1.11.0+):** schickt die aktuelle FEN + Kontext (Kurs-ID,
**Kursname**, Seiten-URL) an `POST /api/extension/remember-line` der RookHub-Instanz → dort in
`RememberedPositions` gespeichert (Verwendungszweck offen). **Kursname über den Bearer
(v1.19.0+):** statt der unzuverlässigen DOM-/React-Fiber-Heuristik wird der echte Kurstitel
über den erfassten Chessable-Bearer aufgelöst — `chessable-course-name`-Resolver (in
`chessable-activity.js`, isolierte Welt) decodiert die `uid` aus dem in `chrome.storage.local`
liegenden JWT (`chessableToken`) und ruft **same-origin** Chessables `getHomeData` ab
(`homeData.booksList[]` → `bid→Name`-Karte, in `chrome.storage.local`/GM-Storage gecacht, TTL 6 h).
Same-origin auf chessable.com → keine CORS-/Cloudflare-Hürde, der Bearer verlässt den Browser
nicht (Anfrage geht an chessable.com). Fehlt der Name (kein Token/Miss), löst ihn der Server aus
dem beim User hinterlegten Bearer auf. Die reinen Bausteine (uid-Decode, Map-Parsing, Nav-Label-Filter)
stehen einmalig in `extension/lib/chessable-course-names.js` (Node-Test `test/chessable-course-names.test.js`)
und werden ausgeliefert — nicht mehr gespiegelt (s. „Shared Core"). Egress wie beim
Activity-Tracking: **Extension** = chessable-fen.js (MAIN-World) postet per
`window.postMessage` zur isolierten chessable-activity.js, die mit RookHub-Config
+ Background-Worker sendet (Token bleibt aus dem Page-Kontext);

- **FEN-Quelle**: bevorzugt die an den Brett-DOM-Knoten haengenden **React-Fiber-
  Props** (`fen`/`interactiveFen`) — nur so kommen Zugrecht/Rochade/Halbzug/
  Vollzug korrekt mit. Fallback: cm-chessboard-DOM (`[data-square]`/`[data-piece]`),
  Legacy-Fallback chessground (`piece`-Transforms). Bei DOM-Fallback sind die
  Metadatenfelder Best-Effort.
- **XP-Tracker**: MutationObserver auf `[data-testid="moveNotification"]`; bei Text
  „XP" wird `span.current-points` ausgelesen. Overstudied/Incorrect/Alternative
  werden ignoriert; Reset bei „Next variation"-Klick.
- **Extension**: `chessable-fen.js` laeuft als **`world: "MAIN"`**-Content-Script
  (siehe manifest) — zwingend, weil React-Fiber-Expandos in der isolierten Welt
  NICHT lesbar sind. Braucht KEINE chrome.*-APIs (Clipboard via
  `navigator.clipboard`, execCommand-Fallback), laeuft daher neben dem isolierten
  `chessable-token.js`.
- **Privacy**: liest nur Seiten-DOM/React-State lokal; FEN geht in die
  Zwischenablage. „Search FEN" oeffnet einen chessable.com-Tab (reine Navigation,
  keine Datenweitergabe an Dritte). Kein zusaetzlicher Netzwerk-Egress.

## Chessable-Trainingszeit → RookHub (v1.10.0+)

RepCheck misst auf chessable.com die **aktive** Trainingszeit und meldet sie an die
RookHub-Instanz des Users (`POST /api/extension/training-activity`), wo sie in die
eigene Kategorie **„Chessable"** des Trainingsziele-Trackers fließt.

- **„Aktiv"** = ALLE: Brett vorhanden (cm-chessboard `[data-square]`) + Tab sichtbar
  & fokussiert + hartes Signal in den letzten 60 s (Brett-Mutation = Zug, Klick/Taste
  aufs Brett, oder gewertete `moveNotification`). Reines Offenlassen zählt NICHT.
  Sliding-Idle-Timer (5-s-Takt), Flush alle 60 s (ab ≥10 s) + bei
  `visibilitychange→hidden`/`pagehide`. Häppchen serverseitig auf 3600 s gedeckelt.
- **RookHub-Config-Sharing** ⚠️: URL+Token liegen in IndexedDB auf chess.com/lichess-
  Origin — auf chessable.com NICHT lesbar (origin-scoped). Daher spiegelt
  `saveRookhubConfig` die Config zusätzlich in **`chrome.storage.local`** (Extension)
 . Das Activity-Script liest
  sie von dort; ohne Config wird nichts gemessen/gesendet.
- **Extension**: `chessable-activity.js` läuft in der **isolierten** Welt (braucht
  `chrome.storage` + `chrome.runtime`); Egress CORS-frei über den Background-Worker
  (`rookhub-fetch`, POST). NICHT MAIN-World (anders als chessable-fen.js).
- **Privacy**: misst nur lokal aus Seiten-DOM; sendet ausschließlich an die vom User
  konfigurierte RookHub-Instanz (Dauer in Sekunden + Zuganzahl, kein Seiteninhalt).

## Chessable getReview-Linien → RookHub (v1.50.0+; token-los + Default v1.51.0)

Beim Training schneidet die Extension die rohe **getReview**-Antwort der gerade trainierten Linie
mit (MAIN-World `chessable-capture.js` → isolierte `chessable-activity.js`; fetch/XHR im
Page-Kontext) und schickt sie an RookHub (`POST /api/extension/chessable/review-lines`), wo sie als
Lücken-Füller neben getGame landet (siehe RookHub-CLAUDE.md). Klassifikation in `lib/chessable-crawl.js`
(`classifyChessableApi` → `{kind:'review',bid,oid}`), Puffer/Flush in `chessable-activity.js`
(`queueReviewLine`/`flushReviewLines`, Session-Dedupe, Batch, best-effort).

**Token-los + Default-Ziel (v1.51.0):** Hat der User KEINEN RookHub-Token hinterlegt, gehen die
Linien an den **anonymen** Endpoint `…/review-lines/anon` — identifiziert über die **Chessable-uid**
(`rcDecodeChessableUid` aus dem Chessable-JWT), NICHT über ein Konto. Ziel ist die konfigurierte URL,
sonst der eingebaute Default `https://rookhub.oberschmid.homes` (auch in `background.js` als erlaubtes
Egress-Origin). Der **erste** token-lose Versand ist EINMALIG zustimmungspflichtig: `showReviewConsentPrompt`
blendet ein In-Page-Banner ein (i18n `review.consent.*`), speichert `rcReviewConsent` = `granted`/`denied`
(chrome.storage.local bzw. GM). Bis zur Zustimmung wird nur gepuffert; „Nicht senden" schaltet es dauerhaft
ab. RookHub claimt die anonym gesammelten Linien, sobald der User seinen Chessable-Bearer verknüpft (uid-Match).
- **Privacy/Store**: der Default sendet an den Autor-Server — offengelegt in `PRIVACY.md`/`docs/privacy.md`,
  und NUR nach ausdrücklicher Zustimmung. Beim Ändern nicht die Zustimmungspflicht/Offenlegung entfernen.

**Sitzungszüge → RookHub (v1.54.0):** Neben getReview wird auch der REQUEST von Chessables eigenem
Session-Report (`POST /api/v1/saveProgressAndReturnNewProgressInfo`) mitgeschnitten — er trägt je Halbzug
das SITZUNGS-Ergebnis (`wrong[]` = falsch gespielte Züge, `overstudied`, `alternativeSkipped`, `level`,
`points`). Die ANTWORT dieses Endpoints wird bewusst NICHT angefasst (enthält Konto-Daten: E-Mail,
Zahlungs-Reste). Capture: `RELEVANT_REQ` in `chessable-capture.js` (fetch `args[1].body`/Request-clone,
XHR `send`-Argument) → Bridge mit `req:true` → `harvestFromSaveProgress` in `chessable-activity.js`
(parst `{uid, data}`, `data` ist ein JSON-STRING mit `{moves:[…]}`), gruppiert je (bid|oid) und sendet
Batches an `POST /api/extension/chessable/session-moves` (RookHub: append-only Roh-Log
`ChessableSessionMoves`, Auswertung offen). **NUR mit RookHub-Token** (wie problem-moves) — der Anon-Pfad
bekommt KEINE Sitzungsdaten; entsprechend in PRIVACY.md/docs/privacy.md offengelegt.
hand-gespiegelt in `initChessableBrowserImport` (direkter `fetch`).

**Zen auf dem Handy (v1.54.1):** Das Zen-Brett liegt per `position:fixed` + z-index ÜBER dem Backdrop — das
trägt nur, wenn kein Vorfahr einen Stacking-Context/Containing-Block aufmacht (transform/filter/contain/
container-type/will-change/positioniertes z-index/opacity<1). Chessables mobiles Layout tut das (Desktop-Kette bis
`#root` nicht, Snapshot 08.08.) → schwarzer Bildschirm, nur unsere Buttons. `zenLiftAncestors(node)` neutralisiert
solche Vorfahren von Brett UND Panel für die Zen-Dauer (Inline-!important, `zenRestoreAncestors` beim Verlassen);
kein DOM-Umbau. Zweite Handy-Falle: das rechts angedockte Panel (≥280 px + 24) liess auf 390 px Breite ein ~80-px-
Brett übrig → `zenNarrow()` (innerWidth<720 oder hochkant) dockt das Panel UNTEN an (`zenPanelPlace`, 34 vh,
vertikale Reserve `zenReservedBottom`), kein Auto-Öffnen, Brett-Minimum 160 px.

**Cached-Count-Overlays (v1.52.0):** `annotateDom` heftet neben den ✓/○-Linien-Markern jetzt auch
Zähl-Badges: auf `/course/{bid}` pro Kapitel `done/total` (Anker `a[href*="/course/{bid}/{lid}"]`, lid exakt
aus dem Pfadsegment) + eine Kurs-Gesamtsumme am ersten `h1`; auf der Startseite je Kurs-Karte „🔖 N"
gecachte Linien (`annotateHomeCourses`, 1 Progress-Call je Kurs, session-gecacht, gedeckelt HOME_MAX_COURSES=40).
Nur mit RookHub-Token (Zähler kommen aus `GET /chessable/progress?bid=`). i18n `progress.cachedCount*`.
`ensureProgress` läuft nur noch auf `/course|practice/\d+` (Startseite → `annotateHomeCourses`).

**Chessable-Hint-Button (v1.52.0):** `clickChessableHint` klickt primär `[data-testid="squareHintButton"]`
(Chessables Hint ist ein Icon-DIV mit Glocke, KEIN `<button>` → die alte Text-über-`button`-Suche fand ihn
nie). Fallback bleibt die Textsuche, jetzt inkl. `div[data-testid]`. `chessable-fen.js`.

**Chessable-Next-Button (v1.53.4):** `clickChessableNext` klickt primär `[data-testid="nextLessonButton"]`.
Chessables Next trägt ZWEI Label-Spans („Next variation" `not-in-mobile` + „Next" `not-in-desktop`) →
`textContent` ist „Next variationNext" und die exakte Textsuche griff nie („Kein „Next" da" im Zen).
Fallback bleibt die Textsuche; der Line-Reset-Listener (`NEXT_LABEL_RE`) erkennt die testid ebenfalls.
`chessable-fen.js`.

## Extension-Architektur (`extension/`)

```
extension/
├── manifest.json       # MV3, host_permissions: https://*/*, content_scripts auf chess.com + lichess.org + chessable.com (chessable hat ZWEI: token=isoliert, fen=world:MAIN); permissions: scripting/activeTab/storage
├── content.js          # Hauptlogik
├── chessable-token.js    # Content-Script (isoliert) auf chessable.com: liest localStorage-JWT → chrome.storage.local
├── chessable-activity.js # Content-Script (isoliert) auf chessable.com: misst aktive Trainingszeit → POST an RookHub; hält zudem den Browser-Kurs-Import-Zustand (Crawl/Mitschnitt/Live/Fortschritt) + chrome.runtime.onMessage-Bridge (`{type:'rc-import'}`), gesteuert vom Popup (kein On-Page-Panel mehr; ✓/○-Marker an den Linien bleiben)
├── chessable-fen.js      # Content-Script (world: "MAIN") auf chessable.com: FEN-Copy/Search-Buttons + XP-Anzeige
├── lib/chessable-course-names.js # geteilter Kern der Kursnamen-Auflösung (uid-Decode + getHomeData-Parsing + isNavLabel), Node-getestet; wird per Manifest in BEIDEN chessable-Welten geladen (isoliert vor chessable-activity.js, MAIN vor chessable-fen.js) → `self.RepCheckCourseNames`. Keine Inline-Kopien mehr — test/chessable-course-names.test.js hält das fest
├── background.js       # Service-Worker, proxied RookHub-Fetches (CORS-frei); öffnet nach der Installation die Willkommensseite
├── welcome.html / .js  # Willkommensseite (v1.59.0): verbinden, was RepCheck wo tut, Chessable-Buttons ankreuzen
├── popup.html / .js    # Toolbar-Button: Cache-Status + „Chessable-Token kopieren" + Sharebar + RookHub-Import (Browser) auf chessable.com [Ziel/Crawl/Mitschnitt/Live/Fortschritt, pollt chessable-activity.js per rc-import; Extension-only] + Chessable-Button-Einstellungen [chrome.storage.local `chessableButtons`, pro Button ein-/ausblendbar]. „Einstellungen"-Knopf klappt seit v1.55.0 IMMER die Popup-Einstellungen auf (`#settings-box`): RookHub-Verbindung [1-Klick-Verbinden + Rückfall „Token von Hand"] + Chessable-Buttons + Kurs-holen-Pause [`crawlDelay`, nur nach oben] + auf chess.com/lichess zusätzlich „Ordner / PGN auf der Seite…" → In-Page-Panel (openSettings)
├── icons/              # 16/48/128 PNG
├── generate-icons.py   # Placeholder-Generator (Pillow)
└── web-ext-config.cjs  # web-ext-CLI-Konfig (Firefox/Chromium-Test)
```

**Message-Protokoll** content ↔ background:
```js
chrome.runtime.sendMessage({
  type: 'rookhub-fetch',
  url, headers,
  method?: 'GET'|'POST',  // default GET
  body?: string,          // JSON string fuer POST
  expect: 'json'|'text',
})
  → { ok: bool, status: number, body: any, error?: string }
```

Der Background-Worker hat `host_permissions: ["https://*/*"]` und ist nicht an Page-CORS gebunden — funktioniert deshalb mit jeder RookHub-Instanz, unabhängig von deren CORS-Konfig.

## Lokales Testen

- **Chrome**: `chrome://extensions/` → „Entwicklermodus" → „Entpackt laden" → `extension/`
- **Firefox**: `about:debugging#/runtime/this-firefox` → „Temporäres Add-on" → `extension/manifest.json`
- **Empfohlen**: `web-ext run` (Auto-Reload). Voraussetzung: `npm install -g web-ext`.

## Sicherheit (v1.19.1+ — nicht zurückbauen)

Security-Review-Härtungen. Beim Ändern der betroffenen Stellen bitte bewusst beibehalten:

- **RookHub-Token NIE ins seiten-lesbare IndexedDB.** Content-Scripts teilen die IndexedDB des Page-Origins (chess.com/lichess) → dort abgelegte Secrets sind für Host-/XSS-Skripte lesbar. Der Token liegt daher extension-privat in `chrome.storage.local` (Key `rookhubConfig`); im IDB-Store `rookhub/config` steht **nur die URL**. `loadRookhubConfig()` liest den Token aus dem privaten Store (mit einmaliger Legacy-Migration aus altem IDB-Token), `saveRookhubConfig()` schreibt ins IDB nur `{ url }`.
- **MAIN↔isoliert postMessage-Bridge** (`chessable-fen.js` ↔ `chessable-activity.js`): Empfänger prüfen `e.source === window` **UND** `e.origin === location.origin`. Rest-Risiko (same-origin Page-Skript könnte Bridge-Messages fälschen) ist bewusst akzeptiert — der Token bleibt aus dem Page-Kontext heraus, Impact wäre nur Daten-Injection, kein Token-Diebstahl. Ein Handshake-Nonce hilft hier nicht robust (MAIN-World ist page-beobachtbar).
- **Background-Egress** (`background.js`): nur `type:'rookhub-fetch'` von `sender.id === chrome.runtime.id`, Ziel-Origin MUSS = `rookhubConfig.url`-Origin, **HTTPS-only** (http nur für `localhost`/`127.0.0.1`), `credentials:'omit'`. Kein offener Proxy.
- **Ein-Klick-Verbindung** (`background.js` `pairAttempt`): das RookHub-JWT wird nur nach ausdrücklichem Nutzer-Klick, nur aus einem Tab mit passender Ziel-Origin gelesen, nie gespeichert und nur für den einen `POST /api/profile/tokens` verwendet. Persistiert wird ausschliesslich der zurueckgegebene `rkh_`-Token — extension-privat wie bisher. Der Token wird im Popup (Extension-Origin) eingegeben, nicht mehr im Seiten-DOM.
- **Manifest `host_permissions`**: `https://*/*` + `http://localhost|127.0.0.1` (kein `http://*/*` — verhindert Klartext-Token-Egress + reduziert Store-Review-Reibung).
- **Packaging**: `web-ext-config.cjs` `ignoreFiles` hält Dev-/CI-Skripte (`*.mjs` CWS-OAuth-Helfer, `*.ps1`) und `web-ext-artifacts/**` aus dem ausgelieferten Paket.

## Submission

- **Chrome Web Store**: 5 USD Lifetime-Fee, `web-ext build` → ZIP upload, Privacy-Policy-URL (`PRIVACY.md` auf GitHub Pages hosten), Screenshots 1280×800. Review 1–3 Tage.
- **Firefox AMO**: kostenlos, `web-ext sign` für AMO-Signatur + Listing. Review meist <24h.

### Veroeffentlichungs-Workflow (Stand 2026-06-11)

**Vor jeder neuen Version**: `version` in `manifest.json` UND `@version` im
erhoehen (siehe „Versioning" oben).

**Firefox AMO — das Add-on ist LISTED (öffentliche addons.mozilla.org-Seite,
NICHT self-hosted).**
- Die CI (`.github/workflows/release.yml`, getriggert von Tag `v*.*.*`) reicht
  die neue Version seit 2026-06-11 mit `--channel=listed --approval-timeout=0`
  direkt beim Listing ein (Review). **Ein `git tag v1.8.0 && git push origin
  v1.8.0` genuegt also** — Voraussetzung: Secrets `AMO_API_KEY` +
  `AMO_API_SECRET` sind gesetzt, sonst ueberspringt die CI die Einreichung.
- `listed` automatisiert nur den Upload; das Review (meist <24h) bleibt. Es
  entsteht KEINE herunterladbare `.xpi` am GitHub-Release (Distribution laeuft
  ueber addons.mozilla.org). Das Listing selbst muss einmalig im Dev Hub
  existieren (Metadaten/Screenshots). Minifizierter Code (`chess.min.js`) kann
  eine Source-Upload-Nachfrage ausloesen.
- Manueller Fallback, falls die CI-Einreichung scheitert: im
  [AMO Developer Hub](https://addons.mozilla.org/developers/) → Add-on →
  „Upload New Version" das ZIP (`cd extension && npx web-ext build`) hochladen.

**Chrome Web Store — nur EINE Version gleichzeitig im Review.** Solange ein
Upload „Pending review" ist, kann NICHT parallel eine neue Version eingereicht
werden. Entweder warten bis das Review durch ist und dann das neue ZIP
hochladen, oder im Developer Dashboard die Pending-Submission canceln, Paket
ersetzen und neu einreichen (setzt die Review-Uhr zurueck). Permission-/Host-
Aenderungen (z. B. v1.8.0: `storage` + chessable.com) loesen ohnehin ein
erneutes, ggf. gruendlicheres Review aus.

CWS-Upload ist seit 2026-06-18 ebenfalls per CI automatisiert: derselbe
`release.yml`-Tag-Trigger laedt die ZIP per Chrome-Web-Store-Publish-API hoch
und reicht sie ein, **sofern** die Secrets `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`,
`CWS_REFRESH_TOKEN`, `CWS_APP_ID` gesetzt sind (sonst Skip). Den `refresh_token`
einmalig lokal erzeugen mit `node extension/get-cws-refresh-token.mjs <id> <secret>`
(OAuth-Client Typ „Desktop app", Redirect `http://localhost:8976`, Chrome Web
Store API im Google-Cloud-Projekt aktiviert). Wegen der „nur EINE Version im
Review"-Regel schlaegt der Step nur als Warnung fehl, wenn schon eine haengt —
der GitHub-Release laeuft trotzdem durch. Manueller Fallback (ZIP aus
`web-ext build` im Developer Dashboard hochladen) bleibt moeglich.
