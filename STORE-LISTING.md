# Store listing copy

Reference text for the **store dashboards** (Chrome Web Store, Firefox AMO).
These listing fields are maintained per store in the dashboards — they are **not**
read from the repo and are **not** updated by CI. The manifest `description` is
only a fallback/summary (and must stay ≤132 chars for Chrome).

Keep this file in sync when the listing text changes.

---

## Summary / short description

Chrome "Summary" must be ≤132 characters. AMO "Summary" allows more but keep it short.

> Highlights where your games leave your opening repertoire on chess.com & lichess — with RookHub sync and Chessable FEN tools.

(123 characters — fits Chrome's 132 limit.)

---

## Description (Chrome "Description" / AMO "Description")

> **RepCheck** shows you where your games leave your opening repertoire — right on **chess.com** and **lichess**.
>
> **Features**
> - Highlights the first out-of-repertoire move and transpositions directly in the move list.
> - Use a repertoire from a **local PGN** (pick a folder or paste) or from a **RookHub** instance (server-side analysis).
> - **Save games** to RookHub (with a shareable link) and **copy the PGN** with one click.
> - On **chessable.com**: **copy or search the FEN** of the current position and **remember a line** to RookHub.
>
> **Privacy:** data is only sent to the RookHub instance you configure yourself — nowhere else.

---

## Notes

- Both stores support **localized** listings; English is the default. Add other
  languages in the dashboard if desired.
- The XP display and Chessable training-time tracking are intentionally omitted
  here (XP is currently disabled).
