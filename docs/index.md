---
layout: default
title: RepCheck — Opening Repertoire Deviation Checker
---

# RepCheck — Opening Repertoire Deviation Checker

Browser-Erweiterung und Tampermonkey-Userscript, die auf chess.com markiert, ab welchem Zug deine Partie aus dem hinterlegten Eröffnungsrepertoire heraus läuft.

- 🌐 **Quellcode**: [github.com/kahalm/repcheck](https://github.com/kahalm/repcheck)
- 🔒 **Datenschutz**: [Privacy Policy](./privacy.html)
- 📥 **Installation**: siehe [README im Repo](https://github.com/kahalm/repcheck#readme)

## Was die Erweiterung macht

Beim Öffnen einer chess.com-Analyse-Seite vergleicht die Erweiterung die gespielten Züge mit einem Eröffnungs-Repertoire, das du entweder:

- als lokalen PGN-Ordner auswählst,
- als PGN-Text einfügst, oder
- aus einer eigenen [RookHub](https://github.com/kahalm/rookhub)-Instanz lädst (per Token).

Der erste Zug, der nicht im Repertoire steht, wird im Move-List-Panel rot markiert.

## Chessable-Token (ab v1.8.0)

Auf `chessable.com` kann RepCheck den eigenen API-Token (JWT) aus dem `localStorage` auslesen und per Knopfdruck in die Zwischenablage kopieren — zur Nutzung in [piratechess](https://github.com/kahalm/piratechess), das damit gekaufte Chessable-Kurse als PGN exportiert. Der Token verlässt den Browser nicht und wird an keinen Server gesendet.

## Was die Erweiterung NICHT macht

- Keine Telemetrie. Keine Tracker. Keine Werbung.
- Keine Verbindung an irgendeinen Server außer chess.com / lichess.org (wo sie läuft) und der von dir aktiv eingetragenen RookHub-URL.
- Der Chessable-Token wird nur lokal gelesen und **nirgendwohin gesendet**.
- Kein Account, kein Login bei einem fremden Dienst.

Details: [Privacy Policy](./privacy.html).
