# Debug-Werkzeuge (nicht für die Stores)

## chessable-inspector.user.js
Diagnose-Userscript für die Fehleranalyse auf chessable.com (z. B. Zen-Vollbild-
Drag&Drop). In Tampermonkey installieren, Trainingsseite öffnen, unten LINKS:

- **RC-Debug: Snapshot** — Brett-Ankerkette (Geometrie, Computed-Styles inkl.
  zoom/transform, offsetWidth vs. Rect), Feld-/Figuren-Beispiele, getrimmtes
  Brett-outerHTML, Viewport/Fullscreen-Zustand.
- **Record 6s** — 6 Sekunden Pointer-Events + Style-/Klassen-Mutationen im
  Brettbereich + Rechtecke der bewegten Figur. Während der Aufnahme eine Figur
  ziehen; für Vollbild-Analysen vorher den Zen-Modus aktivieren.

Ergebnis landet in der Zwischenablage UND als .json-Download.

## Was v0.2.0 zusätzlich erfasst (für die offenen Chessable-Features)

Die erste Dump-Runde reichte für drei Features NICHT — sie erfasste nur den
Brett-Teilbaum, und `boardOuterHtml` war bei 30.000 Zeichen abgeschnitten
(mitten in Reihe 2). Neu im Snapshot:

- **`overlays`** — alle SVG/Canvas/„arrow|marker|highlight|overlay"-Knoten im
  Dokument mit Geometrie, z-Index und Elternpfad, plus `imBrett`-Flag. Damit ist
  entscheidbar, ob die Pfeile IM Brett hängen (Skalierungsfrage) oder daneben
  bzw. am `<body>` (Stapel-/Geometriefrage).
- **`notification`** — der `[data-testid="moveNotification"]`-Knoten samt
  Wrapper, Eltern-HTML und React-Props (für „Overstudy vs. +XP").
- **`xpAnzeigen`** — alle XP-/Rückmeldungs-Texte im Dokument mit Pfad, also auch
  die **Gesamtsumme am Linienende**, die aufklappbar werden soll.
- **`progress`** — Zahlen-Blattknoten in `.row-practice` (`x/y`-Muster),
  `[role="progressbar"]` und React-Props am Brett-Ast, gefiltert auf Schlüssel
  wie `remaining|due|queue|total|line|session` (für „wieviele Linien noch offen").
- **`bodyChildren`**, `boardTailHtml`, `boardHtmlLength` — Kontext, damit ein
  Layer am Dokument-Ende nicht wieder durchs Raster fällt.

Die **Aufnahme** protokolliert zusätzlich `notifications`: jede Textänderung der
Zug-Rückmeldung über die Zeit — die Meldung erscheint nach dem Zug und
verschwindet wieder, ein Snapshot erwischt sie fast nie.

## Was v0.7.0 zusätzlich erfasst

- **`repcheckAnzeigen`** — RepChecks EIGENE Elemente (`.rc-*`, `#repcheck-*`: ✓/○-Linienmarker, Zähler auf
  Kursübersicht und Startseite, FEN-Tool-Buttons) auf der echten, gestylten Seite. Je Element: Rechteck,
  `sichtbar` bzw. `unsichtbarWeil` (display/visibility/opacity/Größe 0/abgeschnitten), `sichtAnteil` nach allen
  Vorfahren mit `overflow` ≠ `visible` und welcher davon abschneidet (`abgeschnittenVon`), `imViewport`,
  tatsächliche Farbe/Schrift, Pfad; dazu `proKlasse` (Anzahl, sichtbar, teilweise abgeschnitten).
  Hintergrund: `pageHtml` entfernt diese Elemente bewusst (Ankersuche) und enthält kein CSS — ob ein Zähler
  live abgeschnitten oder unsichtbar ist, war aus den Dumps nicht erkennbar.

## Was ich für die offenen Features brauche

1. **Snapshot normal** (Practice-Seite, kein Vollbild) — am besten in einer
   Stellung, in der Chessable **Pfeile/Markierungen** anzeigt.
2. **Snapshot im Zen-Vollbild**, gleiche Stellung.
3. **Record 6s im Zen-Vollbild**, und währenddessen **zwei bis drei Züge machen**
   — gern einen richtigen, einen bereits „overstudied" und (wenn es sich ergibt)
   einen falschen. Danach idealerweise noch eine Linie zu Ende spielen, damit
   die **Gesamt-XP am Linienende** im Snapshot/Trace auftaucht.

## Was v0.8.0 zusätzlich kann: chess.com

Das Script greift jetzt auch auf `chess.com`. Dort erscheint unten links **ein**
Knopf (die Chessable-Sammler passen auf chess.com nicht):

- **RC-Debug: chess.com-Snapshot** — sammelt genau das, woran hängt, ob RepCheck
  seine schwebenden Knöpfe (♟ 🔎 📋 💾) einblenden kann:
  - `seite` — Pfad plus die beiden Bedingungen, nach denen `content.js` heute
    entscheidet (`trifftAnalysisGame` = Pfad enthält `/analysis/game/`,
    `trifftGameReview` = `/game/review/`). Beide `false` heißt: hier bleiben die
    Knöpfe aus.
  - `analyseKnoepfe` — alle Links/Knöpfe, deren Text, Klasse, `href`, `data-cy`
    oder `aria-label` nach Analyse/Review aussieht, mit Elternpfad und
    Sichtbarkeit. Daraus entsteht der neue Anker für „zeigen, sobald die
    Partieanalyse angeboten wird".
  - `knopfUmfeld` — das `outerHTML` der umgebenden Knopfleiste (gekürzt).
  - `zuglisten` + `zugKnotenGesamt` + `zugKnotenBeispiele` — in welchem Element
    die Züge stehen und ob sie als `.node` ausgezeichnet sind. Ohne lesbare
    Zugliste nützen die Knöpfe dort nichts.
  - `webComponents` — die Custom-Elements der Seite (chess.com baut die Zugliste
    als `wc-move-list`).
  - `repcheckKnoepfeDa` — ob RepCheck gerade etwas einblendet.

Anwendung: Partieseite öffnen, warten bis der Analyse-Knopf da ist, Knopf
drücken — JSON liegt in der Zwischenablage und als Download.
