# RepCheck — Opening Repertoire Deviation Checker

Markiert auf chess.com- und lichess.org-Analyse-Seiten, ab welchem Zug deine Partie aus dem hinterlegten Eröffnungsrepertoire heraus läuft. Repertoire kann lokal als `.pgn`-Ordner liegen, gepasted werden — oder live aus einer eigenen [RookHub](https://github.com/kahalm/rookhub)-Instanz gezogen werden.

💬 **Community / Fragen?** Komm in unseren Discord: https://discord.gg/wczc4BJtMf

Zwei Distributions-Pfade:

| Variante | Datei / Verzeichnis | Installation |
|----------|---------------------|--------------|
| **Tampermonkey-Userscript** | `repcheck.user.js` | Tampermonkey → New Script → Datei einfügen, oder direkt von GitHub-Raw-URL importieren |
| **Browser-Extension (MV3)** | `extension/` | Lokal: Chrome `chrome://extensions/` → „Entpackt laden" · Firefox `about:debugging` → „Temporäres Add-on" · Submission: Chrome Web Store / Firefox AMO (siehe unten) |

Beide bieten identische Funktionalität und teilen sich denselben IndexedDB-Layout (`RepertoireCheckerDB`) — User können wechseln, ohne URL/Token erneut zu hinterlegen.

## Features

- **Deviation-Erkennung** auf `chess.com/analysis/game/*`, `chess.com/game/review/*` sowie `lichess.org/analysis` und `lichess.org/<gameId>[/white|/black]`
- **Repertoire-Quellen**:
  - Lokaler Ordner (File System Access API in Chrome/Edge, File-Input-Fallback in Firefox)
  - PGN paste
  - RookHub-Server (Eröffnungs-Repertoires gefiltert, mit Auth-Token)
- **Settings-Panel** im Repertoire-Banner (⚙-Icon) für URL/Token/Refresh
- **Cache** in IndexedDB — Re-Open der chess.com-Seite zeigt sofort den letzten Stand, Refresh läuft im Hintergrund
- **Soft-Limit-Warnung** bei > 5 MB Gesamtgröße der Repertoires
- **Chessable-FEN-Tools** (ab v1.9.0): auf `chessable.com` zwei Knöpfe unten rechts — **Copy FEN** (aktuelle Brettstellung in die Zwischenablage) und **Search FEN** (öffnet die Chessable-FEN-Suche der Stellung) — plus Anzeige der zuletzt erspielten **XP**
- **Chessable-Trainingszeit → RookHub** (ab v1.10.0): misst auf `chessable.com` die aktive Trainingszeit (Brett da, Tab aktiv, kürzliche Zug-/Klick-Aktivität) und meldet sie an die konfigurierte RookHub-Instanz — dort zählt sie auf das Tagesziel der Kategorie „Chessable" im Trainingsziele-Tracker. Nur aktiv, wenn RookHub-URL+Token hinterlegt sind
- **Chessable-Token-Auslese** (ab v1.8.0): liest auf `chessable.com` den eigenen API-Token aus dem `localStorage` und bietet ihn lokal zum Kopieren an — für die Nutzung in [piratechess](https://github.com/kahalm/piratechess) (Chessable-Kurs-Export). Der Token verlässt den Browser nicht

## Chessable-FEN-Tools

Auf einer Chessable-Trainer-/Lern-Seite mit Brett erscheinen unten rechts:

- **Copy FEN** (grün) — kopiert die aktuelle Stellung als FEN in die Zwischenablage (z.B. zum Einfügen in lichess.org/analysis oder chess.com/analysis).
- **Search FEN** (blau) — öffnet die Chessable-FEN-Suche für die Stellung in einem neuen Tab (innerhalb des aktuellen Kurses, sonst global).
- **Refresh** (grau) — lädt die Seite neu.
- **Remember line** (lila) — schickt die aktuelle Stellung (FEN) an die konfigurierte RookHub-Instanz und merkt sie dort für später (nur mit hinterlegtem RookHub-URL+Token).
- **XP-Badge** (gelb) — zeigt die zuletzt erspielten Punkte (ignoriert Overstudy/Incorrect/Alternative).

Die FEN wird bevorzugt aus dem internen React-State von Chessable gelesen (korrektes Zugrecht/Rochade/Zugzähler), mit DOM-Fallback. Alles läuft rein lokal; „Search FEN" navigiert nur zu chessable.com.

## Chessable-Token auslesen (für piratechess)

[piratechess](https://github.com/kahalm/piratechess) exportiert gekaufte Chessable-Kurse als PGN und braucht dafür den Chessable-API-Token (ein JWT). RepCheck liest genau diesen Token rein lokal aus und gibt ihn nur auf Knopfdruck in die Zwischenablage, damit man ihn dort einfügen kann:

- **Extension**: Auf `chessable.com` eingeloggt sein → RepCheck-Icon in der Toolbar anklicken → unter „Chessable-Token" auf **„Token kopieren"**. Das Token wird aus `localStorage['chessable.web.production.JWT']` gelesen, in `chrome.storage.local` zwischengespeichert und beim Klick in die Zwischenablage kopiert. Es wird **nicht** angezeigt (zu lang) und **nirgendwohin gesendet**.
- **Userscript**: Auf `chessable.com` das Tampermonkey-Menü öffnen → **„🔑 Chessable-Token kopieren"** (nutzt `GM_setClipboard`). Auf Chessable läuft sonst keine Repertoire-Logik.

## Setup für die Browser-Extension

### Voraussetzung: RookHub-Token erstellen

1. In RookHub einloggen → **Profil → „Extension-Tokens"** → „Token erstellen" (Scope `extension`).
2. Den Raw-Token (`rkh_…`) **einmalig** beim Anlegen kopieren.

### Lokale Entwicklung / temporäres Testen

**Chrome / Edge / Brave**:
1. `chrome://extensions/` aufrufen → „Entwicklermodus" aktivieren
2. „Entpackte Erweiterung laden" → `extension/`-Ordner wählen
3. Auf chess.com oder lichess.org gehen, im Repertoire-Banner das ⚙-Icon klicken, RookHub-URL + Token eintragen, „Verbinden"

**Firefox**:
1. `about:debugging#/runtime/this-firefox` → „Temporäres Add-on laden" → `extension/manifest.json` wählen
2. **Achtung**: temporäre Installation wird beim Browser-Neustart entfernt
3. Persistentes Testen: `web-ext run` (siehe unten)

### Mit `web-ext` (empfohlen für Entwicklung)

```bash
npm install -g web-ext
cd extension
web-ext run                       # Firefox mit Auto-Reload
web-ext run --target=chromium     # Chrome mit Auto-Reload
web-ext lint                      # Prüfen für AMO/Store
web-ext build                     # ZIP in extension/web-ext-artifacts/
```

### Icons regenerieren

Die mitgelieferten Placeholder-Icons (weißer „R" auf grünem Quadrat) werden von `generate-icons.py` erzeugt. Python + Pillow nötig:

```bash
pip install pillow
cd extension
python generate-icons.py
```

Für richtige Icons das Script anpassen oder die PNGs durch eigene 16×16 / 48×48 / 128×128-Dateien ersetzen.

## Submission

### Chrome Web Store

1. [Developer-Account](https://chrome.google.com/webstore/devconsole) anlegen — einmalige 5 USD Gebühr
2. `web-ext build` → `extension/web-ext-artifacts/chesscom_repertoire-1.3.0.zip`
3. Upload, Beschreibung, Screenshots (1280×800), Privacy-Policy-URL → `PRIVACY.md` auf GitHub Pages oder ähnlich hosten
4. Submit → Review 1–3 Tage

### Firefox Add-ons (AMO)

1. [Developer Hub](https://addons.mozilla.org/developers/) — kostenlos
2. `web-ext build` oder direkt `web-ext sign --api-key=… --api-secret=…`
3. Upload bei AMO, Privacy Policy URL, Quellcode-Link
4. Review meist <24h

### Edge Add-ons

Chrome-Store-Extensions sind in Edge automatisch installierbar. Eigene Edge-Submission optional.

## Verzeichnis-Struktur

```
repcheck/
├── repcheck.user.js   # Tampermonkey-Userscript (eigenständig)
├── extension/                    # Browser-Extension (MV3)
│   ├── manifest.json
│   ├── content.js                # Logik wie Userscript, RookHub-Fetches über Background
│   ├── chessable-token.js        # Content-Script (isoliert) auf chessable.com: liest localStorage-JWT → chrome.storage.local
│   ├── chessable-activity.js     # Content-Script (isoliert) auf chessable.com: misst aktive Trainingszeit → RookHub
│   ├── chessable-fen.js          # Content-Script (world: MAIN) auf chessable.com: FEN-Copy/Search + XP-Anzeige
│   ├── background.js             # Service-Worker (CORS-freie Fetches)
│   ├── popup.html                # Toolbar-Button-Popup (Status + „Chessable-Token kopieren")
│   ├── popup.js
│   ├── icons/                    # 16/48/128 PNG
│   ├── generate-icons.py         # Placeholder-Icon-Generator (Pillow)
│   └── web-ext-config.cjs        # web-ext-CLI-Konfig
├── PRIVACY.md                    # Datenschutzerklärung (für Store-Submission)
├── CLAUDE.md                     # Projekt-Regeln + RookHub-Integration
└── README.md
```

## RookHub-Endpoints, die genutzt werden

| Methode | Endpoint | Auth | Zweck |
|---------|----------|------|-------|
| GET | `/api/extension/repertoires?kind=opening` | Bearer `rkh_…` (Scope `extension`) | Liste der Eröffnungs-Repertoires {id, name, fileCount, kind, totalSizeBytes} |
| GET | `/api/extension/repertoires/{id}/pgn` | Bearer `rkh_…` (Scope `extension`) | Kombinierter PGN-Text |

Server-Seite: [RookHub v0.79.1+](https://github.com/kahalm/rookhub) — `ExtensionController` mit Scope-Guard.

## Lizenz

[MIT](./LICENSE) — frei nutzbar, frei zu modifizieren, frei zu redistributieren, mit Attribution.
