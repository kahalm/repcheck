# Project Rules

## Distributions-Pfade

Dieses Repo liefert **zwei** Varianten derselben Funktionalität, die parallel gepflegt werden:

1. **Tampermonkey-Userscript** — `chesscom_repertoire.user.js` im Root. Eigenständig, Cross-Browser via Tampermonkey/Greasemonkey. Auto-Update über die GitHub-Raw-URL.
2. **Browser-Extension (Manifest V3)** — `extension/`-Verzeichnis. Chrome Web Store + Firefox AMO. Content-Script-Logik identisch zum Userscript, RookHub-Fetches laufen über Background-Service-Worker (`background.js`) statt direkter `fetch()`.

**Beide teilen sich denselben IndexedDB-Layout** (DB `RepertoireCheckerDB`, Stores `handles` + `rookhub`). User können zwischen den Varianten wechseln, ohne URL/Token erneut zu hinterlegen.

## Versioning
- Bei jeder Änderung an `chesscom_repertoire.user.js` muss die `@version` im Tampermonkey-Header erhöht werden.
- Bei jeder Änderung in `extension/` muss die `version` in `extension/manifest.json` mit erhöht werden.
- Beide Versionsfelder sollen synchron bleiben (gleiche SemVer-Nummer), damit User identische Versions zwischen Userscript und Extension haben.
- SemVer: patch für Bugfixes, minor für neue Features, major für Breaking Changes.

## Code-Synchronisation Userscript ↔ Extension

Wenn du an der Hauptlogik etwas änderst:
- **Den Userscript** `chesscom_repertoire.user.js` anpassen
- Dann `extension/content.js` **angleichen**: alles 1:1 übernehmen, außer die RookHub-Fetches — die laufen in der Extension über `chrome.runtime.sendMessage({type: 'rookhub-fetch', ...})` zum Background-Worker statt direkter `fetch()`.
- Die `rookhubFetchOpeningList` / `rookhubFetchPgn` sind die einzigen abweichenden Stellen.

Ein einziger Build-Schritt, der die Userscript-Quelle als Basis nimmt und nur die Fetch-Funktionen patcht, wäre eine Option für die Zukunft — aktuell ist die Diff klein genug, um manuell synchron gehalten zu werden.

## RookHub-Integration (v1.3.0+)

Die Extension kann das Repertoire wahlweise aus einem **lokalen Ordner** (File System Access API / File Input) ODER aus einer **RookHub-Instanz** laden.

### Setup
1. In RookHub einloggen → **Profil → „Extension-Tokens"** → „Token erstellen" (Scope `extension`, Ablauf optional). Raw-Token erscheint einmalig — kopieren.
2. Auf chess.com im Repertoire-Settings-Panel (Zahnrad):
   - **URL**: z. B. `https://rookhub.example.com` (ohne trailing slash; Protokoll http/https, der userscript respektiert beides).
   - **Token**: `rkh_…` aus dem Profil.
3. „Verbinden" → URL+Token werden in IndexedDB (`RepertoireCheckerDB` / `rookhub` Store) gespeichert; die Liste der **Eröffnungs-Repertoires** (`?kind=opening`) wird geladen, jede PGN gefetcht, ein Move-Trie gebaut, und die kombinierten PGNs werden lokal in den Cache (`cache`-Key) abgelegt.

### Verhalten
- **Beim Start** des Userscripts wird zuerst der Cache benutzt (instant, auch offline), danach läuft im Hintergrund ein Refresh gegen den Server. Cache-Limit existiert nicht — die `totalSizeBytes`-Summe der Liste löst nur eine Confirm-Warnung aus, wenn sie > 5 MB überschreitet.
- **„Aktualisieren"** im Panel triggert einen manuellen Refresh.
- **Auth**: jeder Request schickt `Authorization: Bearer rkh_…`. Bei 401 wird der Fehler im Status-Text gezeigt; der Token bleibt gespeichert (User muss ihn aktiv im Panel neu eintragen).
- **Fallback**: ohne RookHub-Config funktioniert der lokale Folder-/PGN-Mechanismus genauso wie vor 1.3.0.

### Endpoints (Server-Seite)
- `GET /api/extension/repertoires?kind=opening` → `[{ id, name, fileCount, kind, totalSizeBytes }]`
- `GET /api/extension/repertoires/{id}/pgn` → `text/plain` kombiniertes PGN
- Beide akzeptieren JWT und API-Token; API-Token muss `scope=extension` haben.

### IndexedDB-Layout
- DB `RepertoireCheckerDB`, version 2
- Store `handles` (v1) — File System Access API directory handle
- Store `rookhub` (v2):
  - Key `config` → `{ url: string, token: string }`
  - Key `cache` → `{ pgnTexts: string[], savedAt: number, count: number }`

## Extension-Architektur (`extension/`)

```
extension/
├── manifest.json       # MV3, host_permissions: https://*/*, content_scripts auf chess.com
├── content.js          # Hauptlogik (port vom Userscript)
├── background.js       # Service-Worker, proxied RookHub-Fetches (CORS-frei)
├── popup.html / .js    # Toolbar-Button: zeigt Cache-Status
├── icons/              # 16/48/128 PNG
├── generate-icons.py   # Placeholder-Generator (Pillow)
└── web-ext-config.cjs  # web-ext-CLI-Konfig (Firefox/Chromium-Test)
```

**Message-Protokoll** content ↔ background:
```js
chrome.runtime.sendMessage({ type: 'rookhub-fetch', url, headers, expect: 'json'|'text' })
  → { ok: bool, status: number, body: any, error?: string }
```

Der Background-Worker hat `host_permissions: ["https://*/*"]` und ist nicht an Page-CORS gebunden — funktioniert deshalb mit jeder RookHub-Instanz, unabhängig von deren CORS-Konfig.

## Lokales Testen

- **Chrome**: `chrome://extensions/` → „Entwicklermodus" → „Entpackt laden" → `extension/`
- **Firefox**: `about:debugging#/runtime/this-firefox` → „Temporäres Add-on" → `extension/manifest.json`
- **Empfohlen**: `web-ext run` (Auto-Reload). Voraussetzung: `npm install -g web-ext`.

## Submission

- **Chrome Web Store**: 5 USD Lifetime-Fee, `web-ext build` → ZIP upload, Privacy-Policy-URL (`PRIVACY.md` auf GitHub Pages hosten), Screenshots 1280×800. Review 1–3 Tage.
- **Firefox AMO**: kostenlos, `web-ext sign` für AMO-Signatur + Listing. Review meist <24h.
