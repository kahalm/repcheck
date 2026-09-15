# Privacy Policy — RepCheck — Opening Repertoire Deviation Checker

**Stand**: 2026-08-10 · **Version der Erweiterung**: 1.51.0

## Zusammenfassung in einem Satz
Die Erweiterung kommuniziert mit chess.com / lichess.org (wo sie als Content-Script läuft) und mit einer RookHub-Instanz für Repertoire-/Trainings-Funktionen. Trägst du eine **eigene** RookHub-URL + Token ein, gehen die Daten nur dorthin. Trainierst du Chessable-Kurse **ohne** eigene RookHub-Konfiguration, bietet die Erweiterung **einmalig** an, deine trainierten Linien an die **Standard-Instanz des Autors (`rookhub.oberschmid.homes`)** zu senden, damit sich deine Kurse dort aufbauen — das passiert **nur nach deiner ausdrücklichen Zustimmung** (ein Klick beim ersten Mal) und lässt sich ablehnen.

## Standard-Ziel „rookhub.oberschmid.homes" (opt-in)
Damit die getReview-Kurs-Vervollständigung auch ohne manuelles Setup funktioniert, ist `https://rookhub.oberschmid.homes` als Standard-Ziel eingebaut. Wichtig:
- Betroffen sind **ausschließlich** die auf chessable.com **trainierten Linien** (das rohe getReview-JSON: Zugfolge, Alternativen, Kommentare, Pfeile) — kein anderer Datentyp, keine chess.com/lichess-Daten.
- Der Versand dorthin startet **erst nach ausdrücklicher Zustimmung** über einen einmaligen Hinweis („Senden" / „Nicht senden"). Ohne Zustimmung wird **nichts** gesendet; „Nicht senden" schaltet es dauerhaft ab.
- Trägst du eine eigene RookHub-URL ein, ist **diese** das Ziel (der Standard greift nur, wenn keine URL gesetzt ist).
- Identifiziert werden die Linien token-los über deine **Chessable-User-ID (uid)** (aus dem Chessable-JWT lokal abgeleitet, keine Signatur/kein Passwort). Verknüpfst du später deinen Chessable-Bearer mit einer RookHub-Instanz, werden die so gesammelten Linien deinem Konto zugeordnet; sonst werden sie nach 90 Tagen serverseitig gelöscht.

## Welche Daten verarbeitet die Erweiterung?

| Datum | Speicherort | Wofür |
|-------|-------------|-------|
| **Repertoire-PGNs** | Lokale IndexedDB (`RepertoireCheckerDB`) im Browserprofil | Move-Trie zur Abweichungs­erkennung auf chess.com-Analyse-Seiten |
| **RookHub-URL** | Lokale IndexedDB | Damit die Erweiterung beim nächsten Start weiß, welcher RookHub-Server angesprochen werden soll |
| **RookHub-Token (`rkh_…`)** | Extension: `chrome.storage.local` (Key `rookhubConfig`); Userscript: Tampermonkey-GM-Storage — **extension-/skript-privat, nicht von Webseiten lesbar** (seit v1.19.1; zuvor in der seiten-lesbaren IndexedDB) | Auth-Header für API-Aufrufe an genau die eingetragene RookHub-Instanz |
| **Ordner-Handle** (Chrome File System Access API) | Lokale IndexedDB | Damit der zuletzt gewählte PGN-Ordner ohne erneutes Picken gelesen werden kann |
| **chess.com-Partiezüge** | Nur im Arbeitsspeicher des aktiven Tabs | Vergleich mit dem Repertoire-Trie; werden nirgendwo gespeichert oder gesendet |
| **Chessable-API-Token (JWT)** | `chrome.storage.local` im Browserprofil (Key `chessableToken`) | Wird auf chessable.com aus `localStorage['chessable.web.production.JWT']` gelesen, damit der Nutzer ihn per Knopfdruck in die Zwischenablage kopieren kann — zur Nutzung in piratechess (https://github.com/kahalm/piratechess), das Chessable-Kurse als PGN exportiert. Wird **nicht** versendet |

## Welche Netzwerk-Verbindungen baut die Erweiterung auf?

1. **chess.com / lichess.org** — die Erweiterung läuft als Content-Script und liest die HTML-DOM der Analyse-Seite. Sie sendet **keine** Daten dorthin.
2. **Vom Nutzer eingetragene RookHub-Instanz** — Auth via `Authorization: Bearer rkh_…` (Token-Scope `extension`). Die Erweiterung liest von dort (Repertoires/PGN: `GET /api/extension/repertoires…`) UND schreibt dorthin, wenn du die jeweilige Funktion nutzt: die auf chess.com/lichess angeschaute Partie (Button „Partie speichern"), eine „gemerkte" Chessable-Stellung (Button „Remember line"), einen Teilen-Link zur aktuellen Zugfolge, sowie beim Chessable-Training automatisch: aktive Trainingszeit, die trainierten getReview-Linien, „schwierige Züge" und die Sitzungsergebnisse je trainierter Linie (s. Punkt 3). Stoppt „⚡ Kurs holen" wegen einer unerwarteten Chessable-Antwort (seit v1.60.0), meldet die Erweiterung diese Antwort ebenfalls dorthin: Kurs-ID und -Name, den abgerufenen Chessable-Endpunkt samt Kapitel-/Linien-ID, HTTP-Status, Chessables Fehlermeldung und die ersten 1000 Zeichen der Antwort — E-Mail- und IP-Adressen werden daraus vorher entfernt. Nur an genau diese eine, von dir eingetragene Instanz.
3. **chessable.com** — die Erweiterung läuft als Content-Script und (a) liest den im `localStorage` der Seite abgelegten API-Token, (b) liest für die FEN-Tools die Brettstellung aus DOM/React-State der Seite, (c) misst die aktive Trainingszeit, (d) schneidet beim Training das rohe getReview-JSON der gerade trainierten Linie mit, (e) liest aus den ohnehin geladenen Chessable-Antworten deinen persönlichen Trainingszustand einer Linie mit („schwierige Züge": Schwierigkeitszähler `nHard`, deine Fehlzüge je Halbzug, Datum der letzten Wiederholung), (f) schneidet beim Training den REQUEST von Chessables eigenem Fortschritts-Report mit (Sitzungsergebnis je Zug der gerade trainierten Linie: falsch gespielte Züge, Overstudy-/Alternative-Markierung, Level, Punkte) — die ANTWORT dieses Reports (enthält Konto-Daten) wird nicht angefasst. Sie sendet **keine** Daten an chessable.com. „Search FEN" öffnet auf Knopfdruck eine chessable.com-Suchseite (reine Navigation im Browser). An eine RookHub-Instanz gesendet werden: **Trainingszeit** (Dauer in Sekunden, Anzahl trainierter Züge, abgeschlossene Varianten, Kurs-ID/-Name/-Art), die **getReview-Linien** (rohe Zugfolge + Alternativen + Kommentare + Pfeile), die **„schwierigen Züge"** und die **Sitzungsergebnisse** (nur mit eingetragenem Token, nie an die Standard-Instanz) — an die vom Nutzer eingetragene Instanz, falls vorhanden; sonst (nur die getReview-Linien und **nur nach Zustimmung**, s. o.) an die Standard-Instanz `rookhub.oberschmid.homes`. Beim Knopf **„Remember line"** zusätzlich die aktuelle Stellung (FEN) + Kontext (Kurs-ID, Seiten-URL), nur auf ausdrücklichen Klick.
4. **Standard-RookHub `rookhub.oberschmid.homes`** — nur für token-los gesammelte getReview-Linien und **nur nach ausdrücklicher Zustimmung** (s. Abschnitt oben). Wird eine eigene RookHub-URL eingetragen, entfällt dieses Ziel.

Die Extension kommuniziert mit **keinem** weiteren Server. Insbesondere:
- Keine Telemetrie, kein Analytics, kein Crash-Reporting
- Keine Werbung, keine Tracker
- Verbindung zum Autor **nur** über die Standard-RookHub-Instanz (`rookhub.oberschmid.homes`) und **nur** für zustimmungspflichtig gesendete getReview-Linien — nichts wird ohne Zustimmung dorthin gesendet

## Wo werden Daten gespeichert?

**Alle** lokal im Browser: Repertoire-Daten in der IndexedDB-Datenbank `RepertoireCheckerDB` (Stores `handles` und `rookhub`; die RookHub-**URL** liegt hier, der **Token** NICHT). Der RookHub-Token liegt extension-privat in `chrome.storage.local` (Key `rookhubConfig`) bzw. im Tampermonkey-GM-Storage des Userscripts, der Chessable-Token in `chrome.storage.local` (Key `chessableToken`) — beide von Webseiten nicht lesbar. Daten verlassen das Gerät nur Richtung:
- Der RookHub-Server, dessen URL der Nutzer einträgt, beim API-Call
- Niemand sonst (insbesondere wird der Chessable-Token nirgendwohin gesendet — er landet ausschließlich auf Knopfdruck in der Zwischenablage)

## Wer hat Zugriff?

- **Du** (über deinen Browser)
- **Der RookHub-Server**, den du selbst betreibst oder dem du vertraust — er sieht den Auth-Token, IP und User-Agent jedes API-Calls (Standard-HTTP-Logging)

Der Autor der Erweiterung sieht **nichts**.

## Wie werden Daten gelöscht?

- **Token / URL widerrufen**: Im RookHub-Profil unter „Extension-Tokens" den Token revoken. Damit kann der Token nicht mehr verwendet werden, auch wenn er noch lokal liegt.
- **Lokale Daten löschen**: Browser-Einstellungen → Website-/Extension-Daten löschen, oder die Extension deinstallieren.
- **PGN-Cache zurücksetzen**: In Chrome DevTools → Application → IndexedDB → `RepertoireCheckerDB` löschen.
- **Chessable-Token entfernen**: In Chrome DevTools → Application → Storage → Extension storage / `chrome.storage.local` den Key `chessableToken` löschen, oder die Extension deinstallieren. Den Token selbst kann man in Chessable durch Ausloggen invalidieren.

## Permissions, die im Manifest deklariert sind

- `host_permissions: ["https://*/*", "http://*/*"]` — damit der Background-Service-Worker die vom Nutzer eingetragene RookHub-URL anrufen kann. Eingeschränkt auf HTTP(S); `file://`, `chrome-extension://` und `data:` werden im Code explizit abgelehnt.
- `content_scripts.matches: ["https://www.chess.com/*", "https://lichess.org/*", "https://www.chessable.com/*", "https://chessable.com/*"]` — die Repertoire-Prüfung läuft auf chess.com/lichess, das Token-Auslesen ausschließlich auf chessable.com.
- `storage` — damit der auf chessable.com gelesene Token in `chrome.storage.local` zwischengespeichert und vom Popup-Copy-Button gelesen werden kann.

## Open Source

Vollständiger Quellcode: https://github.com/kahalm/repcheck. Jeder kann das Verhalten der Erweiterung im Code nachprüfen.

## Kontakt

GitHub-Issues: https://github.com/kahalm/repcheck/issues
