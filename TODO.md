# TODO — Browser-Extension Release-Vorbereitung

Was noch manuell erledigt werden muss, bevor die Extension öffentlich veröffentlicht werden kann. Code-Seite ist fertig (siehe `extension/`, Workflows in `.github/workflows/`, MIT-Lizenz, Privacy Policy, GitHub-Pages-Setup).

## Sofort machbar (kein Geld nötig)

- [ ] **GitHub Pages aktivieren**
  Repo → Settings → Pages → Source: **Deploy from a branch** → Branch: **master** → Folder: **/docs** → Save.
  Nach 1–2 Minuten live unter `https://kahalm.github.io/repcheck/`. Diese URL muss in der Chrome-/AMO-Submission als Privacy-Policy-Link angegeben werden (`/privacy.html`).

- [ ] **Erstes Release-Tag setzen** (testet den Workflow)
  ```bash
  git tag v1.3.1 -m "Browser-Extension polish: icons, CI/CD, docs"
  git push origin v1.3.1
  ```
  Erzeugt automatisch ein GitHub Release mit ZIP-Anhang. Prüfen unter „Releases" im Repo.

- [ ] **Lokal in beiden Browsern testen** (Smoke-Test vor Submission)
  - **Chrome**: `chrome://extensions/` → Entwicklermodus → „Entpackt laden" → `extension/`-Ordner. Auf chess.com Analyse-Seite öffnen, ⚙ klicken, RookHub-URL + Token eintragen, „Verbinden" → Status sollte „Eröffnungen geladen" zeigen, Abweichungen markiert.
  - **Firefox**: `about:debugging` → „Temporäres Add-on laden" → `extension/manifest.json`. Gleiche Smoke-Tests.
  - Optional komfortabler: `npm i -g web-ext` + `cd extension && web-ext run` (Auto-Reload) bzw. `web-ext run --target=chromium`.

- [ ] **Screenshots für Stores erstellen** (1280×800 oder 640×400)
  Mindestens einen Screenshot je Store. Empfohlen: 3–5 Stück
  1. chess.com-Analyse mit roter Markierung an der Deviation
  2. Settings-Panel (⚙) mit RookHub-Verbindung
  3. RookHub-Profil mit „Extension-Tokens"-Sektion
  4. Popup mit Cache-Status
  
  Dateien können in `docs/screenshots/` abgelegt und über GitHub Pages verlinkt werden.

## Mit AMO-Account (kostenlos)

- [ ] **Firefox-AMO-Developer-Account anlegen**
  Bei [addons.mozilla.org/developers/](https://addons.mozilla.org/developers/) einloggen.

- [ ] **AMO-API-Key generieren**
  [addons.mozilla.org/developers/addon/api/key/](https://addons.mozilla.org/developers/addon/api/key/) → „Generate new credentials" → API-Key + API-Secret notieren.

- [ ] **AMO-Secrets im Repo hinterlegen**
  Repo → Settings → Secrets and variables → Actions → New repository secret:
  - `AMO_API_KEY` = JWT-Issuer aus AMO
  - `AMO_API_SECRET` = JWT-Secret aus AMO
  
  Beim nächsten Release-Tag (`git tag v… && git push origin v…`) wird die Extension automatisch für Firefox signiert (`.xpi` im Release-Anhang).

- [ ] **AMO-Listing erstellen**
  AMO-Devhub → „Submit New Add-on" → ZIP/XPI hochladen → Beschreibung, Screenshots, Kategorien, Sprachen → Submit. Review meist <24h.
  
  Listing-Felder vorbereiten:
  - **Name**: RepCheck — Opening Repertoire Deviation Checker
  - **Summary**: max 250 Zeichen, z.B. „Markiert auf chess.com Analyse-Seiten, ab welchem Zug deine Partie aus dem Eröffnungsrepertoire heraus läuft. Lokal oder mit RookHub-Server."
  - **Description**: längere Variante mit Setup-Anleitung (kopierbar aus README)
  - **Privacy Policy URL**: `https://kahalm.github.io/repcheck/privacy.html`
  - **Homepage URL**: `https://github.com/kahalm/repcheck`
  - **Support URL**: `https://github.com/kahalm/repcheck/issues`
  - **License**: MIT (gleich auswählen)

## Mit Chrome-Developer-Account (5 USD einmalig)

- [ ] **Chrome Web Store Developer-Account anlegen**
  [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole) → Google-Login → 5 USD Lifetime-Fee bezahlen.

- [ ] **Chrome-Submission vorbereiten**
  - ZIP aus dem letzten Release herunterladen (oder lokal mit `cd extension && web-ext build`)
  - „New Item" → ZIP hochladen
  - Beschreibung, Kategorie „Productivity" oder „Fun", Screenshots
  - Privacy-Policy-URL: `https://kahalm.github.io/repcheck/privacy.html`
  - Permissions begründen: `host_permissions: https://*/*` → „User trägt seine eigene RookHub-Instanz ein, Extension muss dorthin Auth-Requests senden."
  - Submit → Review 1–3 Tage.

## Optional / Später

- [ ] **Edge Add-ons Submission**
  Chrome-Store-Extensions sind in Edge automatisch installierbar. Eine eigene [Edge-Submission](https://partner.microsoft.com/dashboard/microsoftedge/) ist trotzdem möglich (kostenlos), erhöht aber Pflegeaufwand.

- [ ] **Userscript-Distribution** (alternative für User ohne Store-Extension)
  Tampermonkey-User können direkt von GitHub-Raw installieren:
  `https://raw.githubusercontent.com/kahalm/repcheck/master/repcheck.user.js`
  
  Auto-Update läuft bereits über die `@updateURL`/`@downloadURL` im Header.
  Eventuell: in Greasy Fork oder OpenUserJS listen für Discoverability.

- [ ] **Echte Icons** (statt der jetzt-rein-geometrischen Turm-Silhouette)
  Wenn jemand mit Grafik-Sense Lust hat: ein 128×128-PNG mit ordentlicher Schach-Turm-Illustration ersetzen. `extension/generate-icons.py` kann auch entfernt werden, wenn die PNGs handgemacht sind.

- [ ] **Code-Sync-Script** zwischen `repcheck.user.js` (Userscript) und `extension/content.js` (Extension)
  Aktuell pflegen wir beide getrennt. Klein und überschaubar, aber bei der nächsten größeren Feature-Änderung leicht zu vergessen. Ein Build-Script, das nur die `rookhub*Fetch*`-Funktionen austauscht, würde Konsistenz garantieren.

- [ ] **i18n** für die Extension-Settings-UI
  Aktuell alles auf Deutsch (matches RookHub-Stand). Englisch + Croatian parallel würden mit der RookHub-i18n-Linie konsistent sein.

## Erledigt ✓

- [x] Manifest V3 für Chrome + Firefox 109+
- [x] Background-Service-Worker für CORS-freie RookHub-Fetches
- [x] Popup-HTML mit Cache-Status
- [x] Icons 16/48/128 (Turm-Silhouette, regenerierbar)
- [x] `web-ext lint` 0 Errors
- [x] `web-ext build` produziert 40 KB ZIP
- [x] `PRIVACY.md` (Repo) und `docs/privacy.md` (Pages)
- [x] MIT-Lizenz
- [x] GitHub-Actions Build-Workflow
- [x] GitHub-Actions Release-Workflow (mit optional AMO-Sign)
- [x] Userscript-Auto-Update via `@updateURL`/`@downloadURL`
- [x] README + CLAUDE.md aktualisiert
