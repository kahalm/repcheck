---
layout: default
title: Privacy Policy
---

# Privacy Policy — RepCheck — Opening Repertoire Deviation Checker

**Stand**: 2026-09-29 · **Geprüft gegen Version der Erweiterung**: 1.68.0

## Kurz gesagt
- Die Erweiterung läuft auf chess.com, lichess.org und chessable.com. **Ohne RookHub-Verbindung** vergleicht sie auf chess.com/lichess rein lokal (Repertoire aus einem PGN-Ordner oder eingefügtem Text) und sendet nichts an RookHub. Die einzige Ausnahme sind trainierte Chessable-Linien, und die nur nach deiner ausdrücklichen Zustimmung (Abschnitt „Ohne Verbindung").
- **Mit RookHub-Verbindung** schickt sie Daten an die verbundene Instanz: auf chess.com/lichess die Züge der geprüften Partie und die Ids der Partien in einer Partienliste, auf chessable.com die Kursinhalte, die du trainierst oder holst, dazu Trainingszeit und Trainingsergebnisse. Die Liste steht unten.
- **Die voreingestellte Instanz `https://rookhub.oberschmid.homes` betreibt der Autor der Erweiterung.** Die Ein-Klick-Verbindung ist mit dieser Adresse vorbelegt. Verbindest du dich dort, sieht der Autor als Betreiber alle Daten, die die Erweiterung dorthin schickt. Trägst du eine eigene Instanz ein, gehen die Daten nur dorthin.
- Keine Telemetrie, kein Analytics, kein Crash-Reporting, keine Werbung, keine Tracker.

## Ohne Verbindung: trainierte Chessable-Linien (opt-in)
Damit sich deine Chessable-Kurse auch ohne Einrichtung auf RookHub aufbauen, kann die Erweiterung die auf chessable.com **trainierten Linien** auch ohne RookHub-Token senden. Wichtig:
- Betroffen ist **ausschließlich** das rohe getReview-JSON der gerade trainierten Linie (Zugfolge, Alternativen, Kommentare, Pfeile) — kein anderer Datentyp, keine chess.com/lichess-Daten.
- Der Versand startet **erst nach ausdrücklicher Zustimmung** über einen einmaligen Hinweis („Senden" / „Nicht senden"). Ohne Zustimmung wird **nichts** gesendet; „Nicht senden" schaltet es dauerhaft ab.
- Ziel ist die eingetragene RookHub-URL, sonst die Standard-Instanz `rookhub.oberschmid.homes` (Endpunkt `/api/extension/chessable/review-lines/anon`).
- Identifiziert werden die Linien token-los über deine **Chessable-User-ID (uid)** (lokal aus dem Chessable-JWT abgeleitet, keine Signatur, kein Passwort). Verknüpfst du später deinen Chessable-Bearer mit einer RookHub-Instanz, werden die so gesammelten Linien deinem Konto zugeordnet; sonst werden sie nach 90 Tagen serverseitig gelöscht.

## Mit Verbindung: was geht wann an die RookHub-Instanz?
Alle Aufrufe tragen deinen Extension-Token (`Authorization: Bearer rkh_…`, Scope `extension`) und gehen nur an die eine verbundene Instanz.

**chess.com / lichess.org**

| Wann | Was | Endpunkt |
|------|-----|----------|
| Klick auf „Prüfen" (Repertoire-Check mit RookHub) oder Verbinden im Seiten-Panel | SAN-Zugliste der angezeigten Partie | `POST /api/extension/analyze-game` |
| Klick auf „Partie speichern" (💾) oder in einer Partienliste auf „an RookHub schicken" (↗) | Züge, Spieler, Wertungen, Ergebnis, Datum, Bedenkzeit, Partie-Id und -Adresse | `POST /api/extension/games` |
| Klick auf 📈 in einer Partienliste | Startet die Analyse einer dort schon gespeicherten Partie | `POST /api/extension/games/{id}/analyze` |
| **Automatisch ohne Klick**, sobald eine Partienliste offen ist (Archiv oder Profilseite — auch die eines anderen Spielers) | Plattform und die öffentlichen Ids der sichtbaren Partien (keine Züge, keine Namen) — um anzuzeigen, welche schon bei RookHub liegen. Nachgeladene Zeilen werden im 2,5-s-Takt nachgefragt, laufende Analysen alle 30 s | `POST /api/extension/games/known` |
| Popup: Teilen-Link | Zugfolge und Titel der aktuellen Stellung | `POST /api/extension/share-line` |
| Popup öffnen, Verbindung von Hand prüfen | Liest die Liste deiner Eröffnungsrepertoires | `GET /api/extension/repertoires` |

**chessable.com**

| Wann | Was | Endpunkt |
|------|-----|----------|
| Automatisch beim Training | Aktive Trainingszeit (Sekunden, Zahl trainierter Züge und Linien, Kurs-Id, -Name, -Art) | `POST /api/extension/training-activity` |
| Automatisch beim Training | „Linie trainiert" (Kurs-Id + Linien-Id) | `POST /api/extension/chessable/line-trained` |
| Automatisch beim Training | Das rohe getReview-JSON der trainierten Linie (Zugfolge, Alternativen, Kommentare, Pfeile) | `POST /api/extension/chessable/review-lines` |
| Automatisch beim Training | „Schwierige Züge" aus den ohnehin geladenen Chessable-Antworten: Schwierigkeitszähler `nHard`, deine Fehlzüge je Halbzug, Datum der letzten Wiederholung | `POST /api/extension/chessable/problem-moves` |
| Automatisch beim Training | Sitzungsergebnis je Zug aus dem REQUEST von Chessables eigenem Fortschritts-Report (falsch gespielte Züge, Overstudy-/Alternative-Markierung, Level, Punkte). Die ANTWORT dieses Reports enthält Konto-Daten und wird nicht angefasst | `POST /api/extension/chessable/session-moves` |
| Automatisch beim Durchklicken eines Kurses | Kapitel- und Linieninhalte, die die Seite ohnehin von Chessable lädt (Züge, Kommentare, Varianten); sie werden laufend an deinen Kurs auf RookHub angehängt | `POST /api/extension/chessable/ingest/live` |
| Automatisch auf Kursseiten und auf der Chessable-Startseite | Die Kurs-Ids (auf der Startseite: aller angezeigten Kurse), um zu zeigen, welche Linien schon bei RookHub liegen; auf Kursseiten zusätzlich die Liste deiner Repertoires | `GET /api/extension/chessable/progress`, `GET /api/extension/repertoires` |
| Klick im Popup auf „⚡ Kurs holen" oder „Mitschnitt importieren" | Vorab die Linien-Ids des Kurses (welche liegen schon im geteilten Linien-Cache?), dann Kursstruktur und Linieninhalte, in Portionen | `POST /api/extension/chessable/cached-lines`, `POST /api/extension/chessable/ingest`, `POST /api/extension/chessable/ingest/chunk`, `POST /api/extension/chessable/ingest/live` |
| „⚡ Kurs holen" stoppt wegen einer unerwarteten Chessable-Antwort | Kurs-Id und -Name, abgerufener Chessable-Endpunkt samt Kapitel-/Linien-Id, HTTP-Status, Chessables Fehlermeldung, die ersten 1000 Zeichen der Antwort (E-Mail- und IP-Adressen werden vorher entfernt), Version der Erweiterung | `POST /api/extension/chessable/unexpected-response` |
| Klick auf „Remember line" | Aktuelle Stellung (FEN), Kurs-Id, Kursname, Seitenadresse | `POST /api/extension/remember-line` |

**Verbindung herstellen („🔗 Mit RookHub verbinden")**

Die Erweiterung öffnet einen Tab der eingetragenen Instanz (vorbelegt: `https://rookhub.oberschmid.homes`). Nach deinem Klick liest sie dort mit dem Recht `scripting` das Anmelde-JWT aus dem `localStorage` der RookHub-Seite (`rookhub_user`) — nur aus einem Tab genau dieser Instanz — und legt damit einmalig einen Extension-Token an (`POST /api/profile/tokens`, Name „RepCheck (Browser)"). Das JWT wird nicht gespeichert und für nichts anderes verwendet; gespeichert wird nur der zurückgegebene `rkh_`-Token. Alternativ trägst du URL und Token von Hand ein.

## Verbindungen zu chess.com, lichess.org und chessable.com
- **chess.com / lichess.org** — die Erweiterung liest die Seite (Zugliste, Partienliste). Beim Speichern oder Schicken einer Partie holt sie Kopfdaten und Züge über die Schnittstelle der Plattform selbst (chess.com `/callback/{live|daily}/game/{id}`, lichess `/game/export/{id}`), also vom Server, auf dessen Seite du gerade bist. Sie schreibt dort nichts.
- **chessable.com** — die Erweiterung (a) liest den im `localStorage` der Seite abgelegten Chessable-Token, (b) liest für die FEN-Tools die Brettstellung aus der Seite, (c) misst die aktive Trainingszeit, (d) liest die Antworten mit, die die Seite beim Training ohnehin von Chessable lädt (getReview, getList, getGame, den Request des Fortschritts-Reports). Mit deiner bestehenden Chessable-Anmeldung **ruft sie selbst Daten bei Chessable ab**: Kursnamen (`getHomeData`), mit RookHub-Verbindung die Kursstruktur für die Fortschrittszähler (`getCourse`, auf der Startseite höchstens 25 Kurse je Besuch, mit Pause) und nach deinem Klick auf „⚡ Kurs holen" Kursstruktur, Kapitel und Linien (`getCourse`, `getList`, `getGame`, mit Pause). Sie schreibt nichts zu Chessable. „Search FEN" öffnet auf Knopfdruck eine chessable.com-Suchseite.
- **Der Chessable-Token** geht nur an chessable.com selbst (als Anmeldung bei den Abrufen oben), nie an RookHub oder sonst wohin. Der Knopf „Chessable-Token kopieren" legt ihn in die Zwischenablage, zur Nutzung in piratechess (https://github.com/kahalm/piratechess).

Weitere Server kontaktiert die Erweiterung nicht. Der Discord-Link im Hinweis nach einer unerwarteten Chessable-Antwort öffnet nur auf Klick eine Seite.

## Was wird lokal gespeichert?

| Datum | Speicherort | Wofür |
|-------|-------------|-------|
| **Repertoire-Stellungen** (aus deinen PGNs) | IndexedDB `RepertoireCheckerDB` im Browserprofil | Lokaler Repertoire-Vergleich auf chess.com/lichess |
| **Ordner-Handle** (File System Access API) | IndexedDB `RepertoireCheckerDB` | Den zuletzt gewählten PGN-Ordner ohne erneutes Auswählen lesen |
| **RookHub-URL** | IndexedDB `RepertoireCheckerDB` und `chrome.storage.local` (`rookhubConfig`) | Welche RookHub-Instanz angesprochen wird |
| **RookHub-Token (`rkh_…`)** | nur `chrome.storage.local` (`rookhubConfig`) — von Webseiten nicht lesbar | Anmeldung bei der verbundenen Instanz |
| **Chessable-Token (JWT)** | `chrome.storage.local` (`chessableToken`) | Abrufe bei Chessable (s. o.) und der Kopier-Knopf |
| **Kursnamen, Kursstrukturen** | `chrome.storage.local` (`chessableCourseNames`, `courseStructures`, 7 Tage, höchstens 80 Kurse) | Kursnamen anzeigen, Fortschrittszähler ohne erneuten Abruf |
| **Tägliche Trainingsstatistik** | `chrome.storage.local` (`rcDailyStats`) | Anzeige im Popup; bleibt lokal |
| **Einstellungen und Zustände** | `chrome.storage.local` (`chessableButtons`, `crawlDelay`, `rcLang`, `rcReviewConsent`, `rcOnboarding`, `rcButtonsNotice`, `rcCourseFetched`, `rcCrawlAlert`, `rookhubPairing`) | Button-Auswahl, Pause beim Kurs holen, Sprache, deine Zustimmung, Einführung, Hinweise, Stand der Ein-Klick-Verbindung (ohne JWT) |
| **Partiezüge, mitgeschnittene Chessable-Antworten** | nur im Arbeitsspeicher des Tabs | Vergleich, Speichern, Anhängen wie oben beschrieben |

## Wer hat Zugriff?
- **Du** (über deinen Browser).
- **Der Betreiber der RookHub-Instanz**, mit der du verbunden bist oder an die du trainierte Linien zu senden zugestimmt hast. Er sieht die oben genannten Daten und dazu Token, IP-Adresse und User-Agent jedes Aufrufs (übliches HTTP-Logging). **Ist das die voreingestellte Instanz `rookhub.oberschmid.homes`, ist der Betreiber der Autor der Erweiterung.** Für die Verarbeitung auf dem Server gilt die Datenschutzerklärung der jeweiligen Instanz (Standard-Instanz: https://rookhub.oberschmid.homes/privacy).
- Verbindest du dich nur mit einer eigenen Instanz und stimmst keinem Versand an die Standard-Instanz zu, erhält der Autor keine Daten.

## Wie werden Daten gelöscht?
- **Token widerrufen**: Im RookHub-Profil unter „Extension-Tokens" den Token widerrufen. Danach kann er nicht mehr verwendet werden, auch wenn er noch lokal liegt.
- **Daten auf dem RookHub-Server**: in RookHub selbst löschen (Partien, Kurse, Konto) oder beim Betreiber der Instanz anfragen.
- **Lokale Daten löschen**: Browser-Einstellungen → Website-/Erweiterungsdaten löschen, oder die Erweiterung deinstallieren.
- **Repertoire-Cache zurücksetzen**: In den DevTools → Application → IndexedDB → `RepertoireCheckerDB` löschen.
- **Chessable-Token entfernen**: In den DevTools → Application → Extension storage / `chrome.storage.local` den Key `chessableToken` löschen, oder die Erweiterung deinstallieren. Den Token selbst macht ein Abmelden bei Chessable ungültig.

## Berechtigungen im Manifest
- `host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]` — damit der Background-Service-Worker eine RookHub-Instanz unter beliebiger Adresse erreicht. Er leitet nur an die eingetragene Instanz und an die Standard-Instanz weiter, nur per HTTPS (http nur für `localhost`/`127.0.0.1`), ohne Cookies und nur für Anfragen der Erweiterung selbst.
- `content_scripts.matches: ["https://www.chess.com/*", "https://lichess.org/*", "https://www.chessable.com/*", "https://chessable.com/*"]` — die Repertoire-Prüfung und die Partienlisten auf chess.com/lichess, die Chessable-Funktionen auf chessable.com.
- `scripting` — Skripte der Erweiterung in einen schon offenen Tab nachladen, wenn du im Popup einen Knopf drückst, und bei der Ein-Klick-Verbindung das Anmelde-JWT aus dem RookHub-Tab lesen.
- `activeTab` — nach einem Klick im Popup auf den gerade aktiven Tab zugreifen.
- `storage` — die oben genannten Werte in `chrome.storage.local` ablegen.

## Open Source

Vollständiger Quellcode: https://github.com/kahalm/repcheck. Jeder kann das Verhalten der Erweiterung im Code nachprüfen.

## Kontakt

GitHub-Issues: https://github.com/kahalm/repcheck/issues
