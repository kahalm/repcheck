# Plan: Chessable-Trainingszeit mitschneiden → RookHub

Status: **Planung** (Trainingszeit-Messung noch kein Code). Erstellt 2026-06-17.
Feature spannt zwei Repos: **repcheck** (Extension/Userscript) + **rookhub** (Backend/Tracker).

> **Update 2026-06-17:** Als Fundament wurde die `chessable-extension`
> (FEN-Copy/Search + XP-Tracker) in repcheck integriert (v1.9.0,
> `extension/chessable-fen.js` als `world:"MAIN"`-Content-Script + Userscript-
> `initChessableFenTools()`). Damit ist bestätigt: **Brett ist DOM-basiert**
> (cm-chessboard `[data-square]`/`[data-piece]`, offene Frage #2 unten erledigt),
> und das **harte Aktivitätssignal** für die Trainingszeit-Messung liegt vor —
> `[data-testid="moveNotification"]` == "XP" + `span.current-points` markiert
> einen abgeschlossenen, gewerteten Zug. Die Trainingszeit-Messung kann diesen
> MutationObserver-Pfad direkt wiederverwenden.

## Ziel

Die RepCheck-Extension misst auf chessable.com die **aktive Trainingszeit** des
Users und schickt sie an dessen RookHub-Instanz, wo sie gespeichert wird und in
den **Trainingsziele-Tracker** einfließt. Gewählte Definition: **nur aktives
Training** (Learn-/Review-/MoveTrainer mit erkennbarer Aktivität, Tab sichtbar),
nicht reine Anwesenheit.

## Datenfluss

```
chessable.com Content-Script (neu)
  → Sliding-Idle-Timer misst aktive Trainingszeit (+ optional Zug-Zähler)
  → flusht Buckets periodisch + bei visibilitychange/beforeunload
  → [Extension]  chrome.runtime.sendMessage({type:'rookhub-fetch', method:'POST', ...}) → background.js (CORS-frei)
  → [Userscript] direkter fetch / GM_xmlhttpRequest (CORS-Thema, s.u.)
  → POST /api/extension/training-activity   (Authorization: Bearer rkh_…)
  → RookHub: ChessableActivity-Tabelle
  → TrainingGoalService.AggregateAsync → Trainingsziele-Tracker
```

## Heuristik "aktives Training"

Zeit zählt nur, wenn **alle** gleichzeitig gelten:
1. **URL = Trainings-Modus** (Learn/Review/MoveTrainer, NICHT Kursliste/Shop/
   Dashboard). SPA-Navigation via `pushState`/`popstate`/`hashchange` überwachen,
   nicht nur Page-Load (Chessable ist eine SPA, URL kann sich ohne Reload ändern).
2. **Tab sichtbar + Fenster fokussiert** (`document.visibilityState==='visible'`).
3. **Hartes Aktivitätssignal in den letzten ~30–60 s**:
   - Brett-DOM-Mutation (Figur bewegt sich = Zug; stärkstes Signal) — **nur falls
     Brett DOM-basiert ist**, siehe offene Frage 2.
   - Pointer/Klick aufs Brett (`pointerdown`/`pointerup`, Drag), Tastatur.
   - Next-Button / Korrekt-Falsch-Feedback-Mutation.
   - `mousemove`/`scroll` zählen **NICHT** als Training.

Akkumulieren via Sliding-Timer, der ohne hartes Signal pausiert.
**Zusatz:** parallel auch **Anzahl trainierter Züge** zählen — robuster als reine
Zeit und passt zu Chessables eigenem Modell (Chessable misst selbst keine Zeit,
nur Züge/XP/Streak — es gibt nichts Fertiges zum Auslesen).

## Extension-Änderungen (repcheck)

| Baustein | Änderung |
|---|---|
| `extension/chessable-activity.js` (neu) | Content-Script auf `*.chessable.com`: URL-Watcher + MutationObserver(Brett) + Event-Listener + Sliding-Timer + Flush. Läuft NEBEN `chessable-token.js`. |
| `extension/manifest.json` | neues Content-Script im chessable-`content_scripts`-Block registrieren; `version` bump (1.8.0 → 1.9.0). |
| `extension/background.js` | bestehender `rookhub-fetch`-Proxy wird wiederverwendet (POST schon unterstützt — verifiziert in popup.js fetchRookhubRepertoires-Muster). Keine Änderung nötig, evtl. nur Doku. |
| **RookHub-Config-Zugriff** ⚠️ | **Kritisch:** IndexedDB (`RepertoireCheckerDB`) ist origin-scoped → die auf chess.com/lichess gespeicherte RookHub-URL+Token ist auf chessable.com NICHT sichtbar. **Lösung:** RookHub-Config in `chrome.storage.local` spiegeln. Mechanismus existiert schon (chessableToken liegt genau so cross-origin in chrome.storage.local). content.js müsste beim Verbinden die config zusätzlich nach chrome.storage.local schreiben; chessable-activity.js liest sie von dort. |
| `repcheck.user.js` | Userscript-Variante angleichen (CLAUDE.md-Sync-Regel: alles 1:1 außer Fetch). `@version` synchron bumpen. Für Userscript: Config-Sharing via GM-Storage (cross-origin) ODER kleines Settings-Panel auf chessable. |
| `extension/popup.html/.js` (optional) | Status "Chessable heute X min getrackt" anzeigen. |

## RookHub-Backend-Änderungen (rookhub)

Basis-Pfad: `/home/kahalm/claude/rookhubstack/rookhub/src/api/RookHub.Api/`

- **Endpoint:** `POST /api/extension/training-activity` in
  `Controllers/ExtensionController.cs` (nach dem `ScopeGuard()`-Muster, ~Z. 31–37).
  Body z.B. `{ secondsActive, movesTrained?, chessableCourseId?, clientTimestamp? }`.
- **Entity + Migration:** neue `Models/ChessableActivity.cs` (analog `CourseAttempt`).
  Felder: `UserId, TimeSeconds, MovesTrained?, AttemptedAt`, Index `(UserId, AttemptedAt)`.
  Referenz-Migration: `Migrations/20260613075640_AddBookKindAndCourseAttempt.cs`.
  DbSet in `Data/AppDbContext.cs` (~Z. 34, CourseAttempts-Stil). EF Core 9 /
  Pomelo MySQL / MariaDB, Auto-Migration bei App-Start.
- **Tracker-Integration:** Join in `Services/TrainingGoalService.cs`
  `AggregateAsync` (~Z. 223–229-Bereich, wo CourseAttempt aggregiert wird).
  Zeitdeckel pro Tag (z.B. 4 h wie EndlessSession).
- **Auth/Scope:** bestehender `scope="extension"` reicht; alternativ neuer Scope
  `"training-activity"` in `Services/ApiTokenService.cs` (~Z. 20 `AllowedScopes`).
- **⚠️ CORS:** `ExtensionPolicy` erlaubt aktuell **nur GET und nur chess.com**
  (`Program.cs` ~Z. 212–223). Für POST von chessable.com-Origin: entweder Policy
  erweitern (`www.chessable.com` + POST) ODER — sauberer — über den
  Extension-Background-Worker proxyen (CORS-frei). Für die Userscript-Variante
  bleibt CORS relevant → dann Policy-Erweiterung nötig.
- **Versionierung:** `APP_VERSION` in
  `src/frontend/app/src/environments/changelog.ts` (~Z. 5, aktuell `0.152.0`) +
  zweisprachiger Changelog-Eintrag.
- **Tests:** `TrainingGoalServiceTests.cs` um `AggregateAsync` mit
  ChessableActivity-Daten erweitern.

## Frontend-Anzeige (rookhub, optional)

- `src/frontend/app/src/app/features/training-goals/training-goals.component.ts`:
  Chessable-Zeit entweder transparent in Kategorie **"Puzzles"** mergen (keine
  UI-Änderung) oder als **neue sichtbare Kategorie "Chessable"** ergänzen.

## Vor Implementierung per Live-DevTools auf chessable.com klären

(Remote nicht verifizierbar — JS-SPA hinter Cloudflare.)
1. **Exakte URL-Pattern** Learn- vs. Review-Session — und **ob die URL sich
   überhaupt ändert** beim Wechsel in den MoveTrainer (oder reines Client-Routing).
2. **Brett-DOM:** DOM-basiert (`chessground`/`cg-board`, `piece`-Knoten →
   MutationObserver tauglich) oder `<canvas>`/`<svg>` (keine DOM-Mutation → nur
   Event-basiert messbar)? **Entscheidet die Kern-Heuristik.**
3. **Selektoren** für Next-Button + Korrekt/Falsch-Feedback (Zähler "Zug fertig").
4. SPA-State/localStorage prüfen, ob doch ein Move-/Session-Zähler als Cross-Check
   existiert.

## Offene Design-Entscheidungen

- Welche Chessable-Trainingsarten zählen (Taktik/Lektion/Studie) — alle oder Auswahl?
- Chessable-Zeit in "Puzzles" mergen oder neue Kategorie "Chessable"?
- Config-Sharing: chrome.storage.local-Spiegel (Extension) + GM-Storage/Settings-
  Panel (Userscript).
- Token-Scope: bestehendes `extension` oder neues `training-activity`?
- Zeitstempel: Client- (Browser) oder Server-Zeit?

## Referenz-Fundstellen (verifiziert)

- repcheck Chessable-Content-Script: `extension/chessable-token.js`
- Manifest chessable-Block: `extension/manifest.json` content_scripts[1]
- Cross-origin chrome.storage.local-Muster: `extension/popup.js` refreshChessableToken
- Background POST-Proxy-Muster: `extension/popup.js` fetchRookhubRepertoires
- piratechess Chessable-API (Kurs-Hierarchie bid→lid→oid→moves, isKey):
  `rookhubstack/piratechess_docker/src/lib/piratechess_lib/PirateChessLib.cs`

## Aktuelle Versionen

- repcheck Extension/Userscript: **1.8.0**
- RookHub: **0.152.0**
