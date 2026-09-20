# TODO — Browser-Extension Release-Vorbereitung

Was noch manuell erledigt werden muss, bevor die Extension öffentlich veröffentlicht werden kann. Code-Seite ist fertig (siehe `extension/`, Workflows in `.github/workflows/`, MIT-Lizenz, Privacy Policy, GitHub-Pages-Setup).

## Geparkt (User-Wuensche 2026-08-09, „fuer nachher")

- [ ] **Pool-Statistik aktualisiert nur beim Auf-/Zuklappen** — das Panel hinter dem
  Rest-Linien-Zaehler soll sich auch bei einer NEU abgeschlossenen Linie aktualisieren, nicht nur
  beim Schliessen und Wiederoeffnen.
- [ ] **Statistik gesamt + je Repertoire** — zusaetzlich zur Tages-Bilanz eine Gesamt-Statistik und
  eine je aktuellem Chessable-Kurs/Repertoire (eventuell; User sagte „eventuell").


## Release-Vorbereitung — ERLEDIGT (Stand 2026-08-08)

Die Extension ist in **beiden Stores live** und wird per Tag automatisch eingereicht; die
ursprüngliche Checkliste ist damit abgearbeitet. Belegt am 08.08.:

- [x] **GitHub Pages** — `https://kahalm.github.io/repcheck/privacy.html` liefert HTTP 200
  (Privacy-Policy-Link für beide Stores).
- [x] **Release-Workflow** — Tag `v*.*.*` erzeugt GitHub-Release + ZIP und reicht bei AMO **und**
  Chrome Web Store ein (Secrets hinterlegt). Letzter Lauf v1.40.0: AMO hochgeladen,
  CWS `uploadState: SUCCESS` + Publish `OK`.
- [x] **AMO** — Account, API-Key, Secrets, Listing stehen; Add-on ist öffentlich (`status: public`),
  aktuelle Version dort **1.40.0**.
- [x] **Chrome Web Store** — Account + Listing stehen, Item-ID `mhddbldcaancdahlochjanpkkboaccpn`,
  Einreichung läuft über die CI.
- [x] **Store-Screenshots** — vorhanden (ohne sie wäre keine der beiden Freigaben erfolgt).

Wiederkehrend (kein einmaliges TODO):
- [ ] **Vor jedem Store-Release kurz in beiden Browsern smoke-testen** — Chrome
  (`chrome://extensions` → „Entpackt laden" → `extension/`) und Firefox (`about:debugging` →
  „Temporäres Add-on" → `extension/manifest.json`): auf chess.com eine Analyse-Seite öffnen
  (Abweichungen markiert?) und auf chessable.com Practice (Knopfleiste, Zen-Vollbild,
  Zug-Rückmeldung).

## Chessable-Trainingsmodus (User-Wunsch 2026-08-08)

- [x] **Pfeile/Markierungen fehlen im Vollbild (Zen-Modus)** — GELÖST v1.44.1
  Aufgeklärt durch vier gepaarte Snapshots (mitkreise/ohnekreis, mtpfeil/ohnepfeil, 08.08.),
  jeweils Normalmodus gegen Zen. Der Layer heißt **`svg#drawings`** und trägt Pfeile UND
  Feld-Kreise.

  **Er war nie weg.** In `ohnepfeil.json` (Zen) steht der Pfeil vollständig im DOM:
  `<line stroke="#e02828" stroke-width="4" marker-end="url(#arrowhead-r)" opacity="1">`.
  Er lag nur woanders:

  | | Brett | `svg#drawings` |
  |---|---|---|
  | Normal | (431,5 / 113) 503×503 | (431,5 / 113) 503×503 — deckungsgleich |
  | Zen | (152 / 13) 838×838, `position:fixed` | (1187 / 545) 838×838, `position:absolute` |

  Also 1035 px rechts und 532 px unter dem Brett, dazu mit `z-index:10` unter unserem Backdrop
  (2147483600). Ursache: der Layer ist ein GESCHWISTER des Bretts (beide unter
  `div.noScrollingWithFinger`) und deckt sich normalerweise nur deshalb mit ihm, weil er
  `position:absolute; left:0; top:0` im selben positionierten Elternteil hat. Sobald wir das
  Brett auf `position:fixed` ziehen, bleibt er zurück. Die GRÖSSE zog Chessable korrekt nach
  (838) — nur die Position nicht.

  Fix: `zenRescale` gibt dem Layer dieselbe Geometrie wie dem Brett (fixed, gleiche
  left/top/transform/Größe), hebt ihn knapp über das Brett und setzt `pointer-events:none`,
  damit er keine Klicks abfängt. `exitZen` stellt den vorherigen Stil wieder her.

  **Lehre:** die erste Messung schloss aus zwei Snapshots ohne aktiven Pfeil „kein Layer im
  DOM". Zwei Snapshots mit sichtbarer Annotation hätten die Frage sofort entschieden — bei
  „ist X überhaupt da?" gehört ein Paar mit/ohne gemessen, nicht ein Zustand.

- [x] **Zug-Feedback anzeigen: Overstudy vs. +XP** — ERLEDIGT v1.40.0, zwei Zählfehler behoben in
  v1.41.1: (a) wortgleiche Meldungen hintereinander (drei „Overstudied") fielen auf EINEN Eintrag
  zusammen — verglichen wurde nur der Text, und der Leerlauf zwischen zwei Zügen löschte die
  Vergleichsmarke nicht; (b) beim Linienwechsel wurde nicht zurückgesetzt (Liste + Summe liefen über
  die Sitzung weiter), weil der Reset allein an einem Klick auf einen Knopf mit passender
  Beschriftung hing. Beides hängt jetzt an der Halbzug-Nummer der Stellung statt am Wortlaut/Klick.
  **Noch nicht im Browser gegengeprüft** — siehe Smoke-Test-Punkt oben.
  Nach einem Zug zeigt Chessable an, ob der Zug „overstudied" war oder wieviel XP er gebracht hat.
  Das soll RepCheck ebenfalls sichtbar machen (der Nutzer sieht es im Zen-Modus sonst nicht).
  Quelle ist vermutlich `[data-testid="moveNotification"]` — genau der Knoten, den der frühere
  XP-Tracker (`initPointsTracker`, seit v1.14.3 deaktiviert, Code noch vorhanden) beobachtet hat.
  Dort wurden „Overstudied"/„Incorrect"/„Alternative" bewusst ignoriert; jetzt sollen sie
  unterschieden und angezeigt werden. Passende Stelle für die Anzeige suchen (Zen-Leiste?).

- [x] **Vollbild nach dem Refresh-Knopf erhalten** — GEBAUT (v1.39.0) und auf Nutzerwunsch WIEDER
  ENTFERNT (v1.41.0). Echtes Vollbild kann einen Reload nicht überleben (`requestFullscreen()`
  verlangt eine frische Nutzergeste); wiederhergestellt wurde deshalb nur der Zen-Aufbau ohne
  Browser-Vollbild, mit einem dritten Knopf-Zustand „Vollbild fortsetzen". Genau dieser
  Zwischenzustand hat in der Praxis gestört — der Vorbehalt aus der Planung hat sich bestätigt.
  Falls das Thema wiederkommt: nicht denselben Weg nochmal gehen, sondern beim Refresh gar nicht
  erst aus dem Zen fallen (z. B. Inhalt neu laden statt `location.reload()`).


- [ ] **Nach dem Refresh automatisch an die richtige Stelle zurückspielen** (User-Wunsch 2026-08-08)
  Zweck des Refresh-Knopfes ist, einen Verklicker nicht als Fehler werten zu lassen — er wirft den
  Nutzer aber an den Linienanfang zurück. Wunsch: die bereits gespielten Züge automatisch
  nachspielen.
  **Machbarkeit — die Bausteine sind belegt** (aus `dumps/repcheck-inspector-recording-*.json`):
  - Feld-Elemente sind eindeutig adressierbar: die IDs beginnen mit dem Feldnamen
    (`DIV#e4-2760-7211-…`, `DIV#d2-3e6e-…`), zusätzlich tragen sie eine `square-<feld>`-Klasse.
  - **Klick-Klick-Eingabe funktioniert**: nach dem ersten Klick erscheinen die
    Legalzug-Markierungen (61 `highlight-legal-mt2`-Mutationen im Mitschnitt), der zweite Klick
    aufs Zielfeld führt den Zug aus. Ein Zug lässt sich also ohne Drag-Simulation auslösen.
  - Dass synthetische Klicks bei Chessable ankommen, ist durch den ▸-Knopf bereits belegt (der
    ruft `el.click()` auf Chessables eigenem „Next"-Button).
  **Was noch offen ist (und vor dem Bauen geklärt werden MUSS):**
  1. Serviert Chessable nach dem Reload überhaupt DIESELBE Linie? Der Move-Trainer zieht die
     nächste fällige — kommt eine andere, dürfte NICHTS nachgespielt werden. Erkennung über die
     Linien-/oid-Kennung bzw. die Start-FEN (Inspector v0.2.0 erfasst `progress.props`).
  2. Nehmen die Brett-Handler synthetische Pointer-Events an (isTrusted=false)? Der ▸-Knopf beweist
     es für React-Buttons, nicht für den Brett-Layer.
  3. Timing: nach jedem eigenen Zug antwortet der Gegner animiert — der nächste Klick darf erst
     nach dem Settle kommen (Brett-Mutation abwarten, nicht blind `setTimeout`).
  **Sicherheitsregel für die Umsetzung:** vor JEDEM nachgespielten Zug die aktuelle Stellung gegen
  die erwartete prüfen und bei Abweichung sofort abbrechen (mit sichtbarem Hinweis). Ein
  „danebengegangener" Nachspiel-Zug wäre genau der Fehler, den der Nutzer vermeiden will — lieber
  gar nicht nachspielen als falsch.
  **Zu erwägen:** die Züge liegen ohnehin schon vor (RepCheck sieht jeden Zug für die
  Trainingszeit-Messung); der `ZEN_RESTORE_KEY`-Mechanismus aus v1.39.0 ist die passende Stelle,
  um sie über den Reload zu retten.

- [x] **Gesamt-XP am Linienende aufklappbar machen** — TEILWEISE ERLEDIGT v1.40.0 (RepCheck schlüsselt die SELBST erfassten Einzelbeträge auf; Chessables eigene Endsumme wird nicht ausgelesen, Boni am Linienende fehlen deshalb — im Panel ausgewiesen)
  Am Ende einer Linie zeigt Chessable die Gesamt-XP (in beiden Modi). Diese Summe soll klickbar
  sein und die **Einzelbeträge** zeigen, aus denen sie sich zusammensetzt. Hängt direkt am
  Zug-Feedback oben: wenn RepCheck die Pro-Zug-Meldungen ohnehin mitschneidet, ist die
  Aufschlüsselung nur noch eine Anzeige der gesammelten Liste (kein zusätzlicher Datenzugriff).
  Offen: ob die Summe von Chessable exakt der Summe der Einzelmeldungen entspricht (Rundung,
  Boni am Linienende) — sonst muss die Aufschlüsselung als „erfasste Einzelbeträge" beschriftet
  werden statt als Zerlegung der Summe. Erfasst wird das mit Inspector v0.2.0 (`xpAnzeigen`).

- [x] **Restliche Linien im Trainingspool anzeigen** — ERLEDIGT v1.43.0
  Der Nutzer hat den Fundort gefunden, wo keine meiner Messungen gesucht hatte: die Zahl ist
  eine **Plakette im ausgewählten Tab** der Chessable-Leiste, nicht am Brett und nicht im
  Move-Trainer-Drawer:
  ```html
  <button role="tab" aria-selected="true" id="tab-1">
    <span class="MuiTab-wrapper"><span class="sc-hlqNbq iXetOK">68</span><span>Review</span></span>
  ```
  Gesucht wird bewusst über die STRUKTUR (`button[role="tab"][aria-selected="true"]` → erste
  blattlose Kind-Span mit reiner Zahl), nicht über die Klassen `sc-hlqNbq iXetOK`: die erzeugt
  styled-components bei jedem Chessable-Deploy neu. Die Beschriftung („Review") taugt ebenfalls
  nicht als Anker — sie hängt an der Kontosprache.
  Angezeigt wird die Zahl als ⏳-Plakette in der RepCheck-Leiste und bleibt im Zen-Modus
  sichtbar; genau dort ist Chessables eigene Tab-Leiste ja hinter dem Backdrop.

  **Lehre:** drei Messrunden haben am Brett und am Drawer gesucht, weil die erste Notiz die
  Suche dorthin gelenkt hatte. Die Zahl saß die ganze Zeit in der Navigation. Beim nächsten
  „nicht gefunden" früher dokumentweit suchen, statt den Anker zu verfeinern.

## Optional / Später

- [ ] **Edge Add-ons Submission**
  Chrome-Store-Extensions sind in Edge automatisch installierbar. Eine eigene [Edge-Submission](https://partner.microsoft.com/dashboard/microsoftedge/) ist trotzdem möglich (kostenlos), erhöht aber Pflegeaufwand.

- [ ] **Echte Icons** (statt der jetzt-rein-geometrischen Turm-Silhouette)
  Wenn jemand mit Grafik-Sense Lust hat: ein 128×128-PNG mit ordentlicher Schach-Turm-Illustration ersetzen. `extension/generate-icons.py` kann auch entfernt werden, wenn die PNGs handgemacht sind.

- [x] **Code-Sync-Script zwischen Userscript und Extension** — HINFÄLLIG seit 2026-09-20:
  das Userscript ist entfallen, es gibt nur noch die Extension. Es gibt nichts mehr zu syncen.

- [x] **i18n für die Einstellungs-UI** — ERLEDIGT v1.42.0 (en/de/hr, Sprachwahl im Popup UND im
  In-Page-Panel; `extension/lib/i18n.js` ist die einzige Quelle). Umgestellt sind Popup,
  In-Page-Panel, Prüf-Ergebnis,
  Knopf-Tooltips auf chess.com/lichess und der komplette Chessable-Browser-Import.
  Vorgefunden war übrigens KEIN reines Deutsch, sondern ein Mischmasch — „Repertoire Settings",
  „Select PGN Folder", „Close" standen englisch neben „Verbinden" und „RookHub: verbinde…".

- [ ] **i18n Teil 2: die On-Page-Knopfleiste auf chessable.com** (bewusst nicht in v1.42.0)
  `extension/chessable-fen.js` (~26 Texte: Knopf-Tooltips,
  `flash()`-Kurzmeldungen, das Zug-Rückmeldungs-Panel). Steckt in der MAIN-World, hat also weder
  `chrome.*` noch Zugriff auf die Sprachwahl. Der Weg ist klar und die Bausteine liegen:
  `lib/i18n.js` ist reine Logik ohne `chrome.*` und lässt sich als viertes MAIN-World-Script VOR
  `chessable-fen.js` laden; der Sprachcode kommt über die schon vorhandene postMessage-Brücke
  (Muster `chessable-buttons` in chessable-activity.js). Nur die zwei Buchstaben wandern, nicht
  die Tabelle.
  Zu beachten: der in Badge/Tooltip gespiegelte Chessable-Text („Overstudied", „+12 XP") bleibt
  in der KONTOsprache — der Code spiegelt bewusst statt zu interpretieren. Der übersetzte Satz
  drumherum muss das aushalten.

- [ ] **Store-Metadaten übersetzen** (`_locales/{en,de,hr}/messages.json` + `default_locale`)
  Betrifft nur `name`, `description` und `action.default_title` im Manifest — die drei Felder
  erreicht ein Laufzeitmodul prinzipiell nicht. Bewusst NICHT zusammen mit v1.42.0 gemacht: ist
  die `_locales`-Datei fehlerhaft, lädt die Extension gar nicht mehr („Invalid value for 'name'"),
  und v1.41.x liegt gerade im Store-Review. Getrennt und mit Smoke-Test in beiden Browsern.

## Erledigt ✓

- [x] Manifest V3 für Chrome + Firefox 109+
- [x] Background-Service-Worker für CORS-freie RookHub-Fetches
- [x] Popup-HTML mit Cache-Status
- [x] Icons 16/48/128 (Turm-Silhouette, regenerierbar)
- [x] `web-ext lint` 0 Errors
- [x] `web-ext build` produziert 40 KB ZIP
- [x] `PRIVACY.md` (Repo) und `docs/privacy.md` (Pages)
- [x] MIT-Lizenz
- [x] GitHub-Actions Build-Workflow
- [x] GitHub-Actions Release-Workflow (mit optional AMO-Sign)
- [x] Userscript-Auto-Update via `@updateURL`/`@downloadURL` (mit dem Userscript 2026-09-20 entfallen)
- [x] README + CLAUDE.md aktualisiert
