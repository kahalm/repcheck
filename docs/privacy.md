---
layout: default
title: Privacy Policy
---

# Privacy Policy — Chess.com Repertoire Deviation Checker

**Stand**: 2026-06-03 · **Version der Erweiterung**: 1.3.0

## Zusammenfassung in einem Satz
Die Erweiterung sendet **keine Daten an den Autor** und kommuniziert nur mit den **zwei Endpunkten, die der Nutzer aktiv konfiguriert**: chess.com (wo sie als Content-Script läuft) und — optional — die eigene RookHub-Instanz, deren URL und Token der Nutzer selbst einträgt.

## Welche Daten verarbeitet die Erweiterung?

| Datum | Speicherort | Wofür |
|-------|-------------|-------|
| **Repertoire-PGNs** | Lokale IndexedDB (`RepertoireCheckerDB`) im Browserprofil | Move-Trie zur Abweichungserkennung auf chess.com-Analyse-Seiten |
| **RookHub-URL** | Lokale IndexedDB | Damit die Erweiterung beim nächsten Start weiß, welcher RookHub-Server angesprochen werden soll |
| **RookHub-Token (`rkh_…`)** | Lokale IndexedDB | Auth-Header für API-Aufrufe an genau die eingetragene RookHub-Instanz |
| **Ordner-Handle** (Chrome File System Access API) | Lokale IndexedDB | Damit der zuletzt gewählte PGN-Ordner ohne erneutes Picken gelesen werden kann |
| **chess.com-Partiezüge** | Nur im Arbeitsspeicher des aktiven Tabs | Vergleich mit dem Repertoire-Trie; werden nirgendwo gespeichert oder gesendet |

## Welche Netzwerk-Verbindungen baut die Erweiterung auf?

1. **chess.com** — die Erweiterung läuft als Content-Script auf `https://www.chess.com/*` und liest die HTML-DOM der Analyse-Seite. Sie sendet **keine** Daten an chess.com.
2. **Vom Nutzer eingetragene RookHub-Instanz** — `GET /api/extension/repertoires?kind=opening` und `GET /api/extension/repertoires/{id}/pgn`. Auth via `Authorization: Bearer rkh_…`. Nur Lese-Zugriff (Token-Scope `extension` ist read-only).

Die Extension kommuniziert mit **keinem** anderen Server. Insbesondere:
- Keine Telemetrie, kein Analytics, kein Crash-Reporting
- Keine Werbung, keine Tracker
- Keine Verbindung zum Author / Maintainer

## Wo werden Daten gespeichert?

**Alle** lokal im Browser, in der IndexedDB-Datenbank `RepertoireCheckerDB` (Stores `handles` und `rookhub`). Daten verlassen das Gerät nur Richtung:
- Der RookHub-Server, dessen URL der Nutzer einträgt, beim API-Call
- Niemand sonst

## Wer hat Zugriff?

- **Du** (über deinen Browser)
- **Der RookHub-Server**, den du selbst betreibst oder dem du vertraust — er sieht den Auth-Token, IP und User-Agent jedes API-Calls (Standard-HTTP-Logging)

Der Autor der Erweiterung sieht **nichts**.

## Wie werden Daten gelöscht?

- **Token / URL widerrufen**: Im RookHub-Profil unter „Extension-Tokens" den Token revoken. Damit kann der Token nicht mehr verwendet werden, auch wenn er noch lokal liegt.
- **Lokale Daten löschen**: Browser-Einstellungen → Website-/Extension-Daten löschen, oder die Extension deinstallieren.
- **PGN-Cache zurücksetzen**: In Chrome DevTools → Application → IndexedDB → `RepertoireCheckerDB` löschen.

## Permissions, die im Manifest deklariert sind

- `host_permissions: ["https://*/*", "http://*/*"]` — damit der Background-Service-Worker die vom Nutzer eingetragene RookHub-URL anrufen kann. Eingeschränkt auf HTTP(S); `file://`, `chrome-extension://` und `data:` werden im Code explizit abgelehnt.
- `content_scripts.matches: ["https://www.chess.com/*"]` — die Hauptfunktion läuft ausschließlich auf chess.com.

## Open Source

Vollständiger Quellcode: [github.com/kahalm/chesscom_extension](https://github.com/kahalm/chesscom_extension). Jeder kann das Verhalten der Erweiterung im Code nachprüfen.

## Kontakt

GitHub-Issues: [github.com/kahalm/chesscom_extension/issues](https://github.com/kahalm/chesscom_extension/issues)
