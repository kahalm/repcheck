# Privacy Policy — RepCheck — Opening Repertoire Deviation Checker

**Stand**: 2026-06-11 · **Version der Erweiterung**: 1.8.0

## Zusammenfassung in einem Satz
Die Erweiterung sendet **keine Daten an den Autor** und kommuniziert nur mit den **Endpunkten, die der Nutzer aktiv konfiguriert**: chess.com / lichess.org (wo sie als Content-Script läuft) und — optional — die eigene RookHub-Instanz, deren URL und Token der Nutzer selbst einträgt. Auf chessable.com liest sie zusätzlich nur lokal den eigenen API-Token aus, ohne ihn zu versenden.

## Welche Daten verarbeitet die Erweiterung?

| Datum | Speicherort | Wofür |
|-------|-------------|-------|
| **Repertoire-PGNs** | Lokale IndexedDB (`RepertoireCheckerDB`) im Browserprofil | Move-Trie zur Abweichungs­erkennung auf chess.com-Analyse-Seiten |
| **RookHub-URL** | Lokale IndexedDB | Damit die Erweiterung beim nächsten Start weiß, welcher RookHub-Server angesprochen werden soll |
| **RookHub-Token (`rkh_…`)** | Lokale IndexedDB | Auth-Header für API-Aufrufe an genau die eingetragene RookHub-Instanz |
| **Ordner-Handle** (Chrome File System Access API) | Lokale IndexedDB | Damit der zuletzt gewählte PGN-Ordner ohne erneutes Picken gelesen werden kann |
| **chess.com-Partiezüge** | Nur im Arbeitsspeicher des aktiven Tabs | Vergleich mit dem Repertoire-Trie; werden nirgendwo gespeichert oder gesendet |
| **Chessable-API-Token (JWT)** | `chrome.storage.local` im Browserprofil (Key `chessableToken`) | Wird auf chessable.com aus `localStorage['chessable.web.production.JWT']` gelesen, damit der Nutzer ihn per Knopfdruck in die Zwischenablage kopieren kann (z. B. für piratechess). Wird **nicht** versendet |

## Welche Netzwerk-Verbindungen baut die Erweiterung auf?

1. **chess.com / lichess.org** — die Erweiterung läuft als Content-Script und liest die HTML-DOM der Analyse-Seite. Sie sendet **keine** Daten dorthin.
2. **Vom Nutzer eingetragene RookHub-Instanz** — `GET /api/extension/repertoires?kind=opening` und `GET /api/extension/repertoires/{id}/pgn`. Auth via `Authorization: Bearer rkh_…`. Nur Lese-Zugriff (Token-Scope `extension` ist read-only).
3. **chessable.com** — die Erweiterung läuft als Content-Script und liest **nur** den im `localStorage` der Seite abgelegten API-Token. Sie sendet **keine** Daten an chessable.com und baut von dort aus **keine** weiteren Netzwerk-Verbindungen auf.

Die Extension kommuniziert mit **keinem** anderen Server. Insbesondere:
- Keine Telemetrie, kein Analytics, kein Crash-Reporting
- Keine Werbung, keine Tracker
- Keine Verbindung zum Author / Maintainer

## Wo werden Daten gespeichert?

**Alle** lokal im Browser: Repertoire-Daten in der IndexedDB-Datenbank `RepertoireCheckerDB` (Stores `handles` und `rookhub`), der Chessable-Token in `chrome.storage.local` (Key `chessableToken`). Daten verlassen das Gerät nur Richtung:
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
