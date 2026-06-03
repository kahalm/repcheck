# Project Rules

## Versioning
- Bei jeder Änderung an `chesscom_repertoire.user.js` muss die `@version` im Tampermonkey-Header erhöht werden (SemVer: patch für Bugfixes, minor für neue Features, major für Breaking Changes).

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
