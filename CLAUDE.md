# Project Rules

## Distributions-Pfade

Dieses Repo liefert **zwei** Varianten derselben Funktionalität, die parallel gepflegt werden:

1. **Tampermonkey-Userscript** — `repcheck.user.js` im Root. Eigenständig, Cross-Browser via Tampermonkey/Greasemonkey. Auto-Update über die GitHub-Raw-URL.
2. **Browser-Extension (Manifest V3)** — `extension/`-Verzeichnis. Chrome Web Store + Firefox AMO. Content-Script-Logik identisch zum Userscript, RookHub-Fetches laufen über Background-Service-Worker (`background.js`) statt direkter `fetch()`.

**Beide teilen sich denselben IndexedDB-Layout** (DB `RepertoireCheckerDB`, Stores `handles` + `rookhub`). User können zwischen den Varianten wechseln, ohne URL/Token erneut zu hinterlegen.

## Versioning
- Bei jeder Änderung an `repcheck.user.js` muss die `@version` im Tampermonkey-Header erhöht werden.
- Bei jeder Änderung in `extension/` muss die `version` in `extension/manifest.json` mit erhöht werden.
- Beide Versionsfelder sollen synchron bleiben (gleiche SemVer-Nummer), damit User identische Versions zwischen Userscript und Extension haben.
- SemVer: patch für Bugfixes, minor für neue Features, major für Breaking Changes.

## Code-Synchronisation Userscript ↔ Extension

Wenn du an der Hauptlogik etwas änderst:
- **Den Userscript** `repcheck.user.js` anpassen
- Dann `extension/content.js` **angleichen**: alles 1:1 übernehmen, außer die RookHub-Fetches — die laufen in der Extension über `chrome.runtime.sendMessage({type: 'rookhub-fetch', ...})` zum Background-Worker statt direkter `fetch()`.
- Der einzige abweichende Codepfad ist `rookhubAnalyzeGame`: im Userscript direkter `fetch(POST …)`, in der Extension `rookhubProxy({ method:'POST', body, … })` zum Background-Worker.

Ein einziger Build-Schritt, der die Userscript-Quelle als Basis nimmt und nur die Fetch-Funktionen patcht, wäre eine Option für die Zukunft — aktuell ist die Diff klein genug, um manuell synchron gehalten zu werden.

## Site-Adapter (v1.5.0+)

`repcheck.user.js` und `extension/content.js` haben ein `ADAPTERS`-Objekt mit einem Eintrag pro unterstützter Plattform (`chesscom`, `lichess`). Jeder Adapter exportiert:
- `test(host)` — entscheidet, ob er für `location.hostname` zuständig ist
- `isReviewPage()` — Site-spezifischer URL/DOM-Check für die Analyse-Seite
- `getMoveListEl()` — liefert das Container-Element der Zugliste
- `getMoveNodes(root)` — alle Hauptlinien-Knoten (Lichess nutzt `:scope > move`, um Varianten auszublenden)
- `extractSan(node)` — extrahiert SAN aus einem Knoten; bei Lichess inkl. Mapping `♔♕♖♗♘ → KQRBN` für Figurinen-Notation
- `findBannerContainer()` — wohin das Repertoire-Banner injiziert wird

Neue Plattform hinzufügen = neuen Adapter-Eintrag in beide Dateien einfügen. Restlogik bleibt unverändert.

## RookHub-Integration (v1.3.0+, server-seitige Analyse seit v1.6.0)

Die Extension kann das Repertoire wahlweise aus einem **lokalen Ordner** (File System Access API / File Input) ODER aus einer **RookHub-Instanz** laden. Bei RookHub bleibt das Repertoire-PGN seit v1.6.0 auf dem Server — der Client schickt die SAN-Zugliste der aktuellen Partie, der Server liefert ply-weise Annotationen zurueck.

### Setup
1. In RookHub einloggen → **Profil → „Extension-Tokens"** → „Token erstellen" (Scope `extension`, Ablauf optional). Raw-Token erscheint einmalig — kopieren.
2. Auf chess.com **oder lichess.org** im Repertoire-Settings-Panel (Zahnrad):
   - **URL**: z. B. `https://rookhub.example.com` (ohne trailing slash; Protokoll http/https, der userscript respektiert beides).
   - **Token**: `rkh_…` aus dem Profil.
3. „Verbinden" → URL+Token werden in IndexedDB (`RepertoireCheckerDB` / `rookhub` Store) gespeichert. Ein einmaliger `POST /api/extension/analyze-game` mit leerer Zugliste verifiziert Auth und meldet die Anzahl gefundener Opening-Dateien.

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
  - Key `config` → `{ url: string, token: string }`
  - Key `cache` → `{ pgnTexts: string[], savedAt: number, count: number }`

## Extension-Architektur (`extension/`)

```
extension/
├── manifest.json       # MV3, host_permissions: https://*/*, content_scripts auf chess.com + lichess.org
├── content.js          # Hauptlogik (port vom Userscript)
├── background.js       # Service-Worker, proxied RookHub-Fetches (CORS-frei)
├── popup.html / .js    # Toolbar-Button: zeigt Cache-Status
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

## Submission

- **Chrome Web Store**: 5 USD Lifetime-Fee, `web-ext build` → ZIP upload, Privacy-Policy-URL (`PRIVACY.md` auf GitHub Pages hosten), Screenshots 1280×800. Review 1–3 Tage.
- **Firefox AMO**: kostenlos, `web-ext sign` für AMO-Signatur + Listing. Review meist <24h.
