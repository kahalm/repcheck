# Lokaler Smoke-Test der Extension VOR einem Release-Tag (Windows/PowerShell).
#
#   cd C:\git\repcheck\extension
#   .\test-in-chrome.ps1
#
# Schritt 1: baut exakt das ZIP, das die CI zum Chrome Web Store hochlaedt
#            (web-ext build → ./web-ext-artifacts/), inkl. Lint.
# Schritt 2: startet Chrome mit der geladenen Extension + Auto-Reload
#            (web-ext run --target=chromium). Fenster offen lassen, Sites testen.
#
# Voraussetzung: Node + Chrome installiert. web-ext wird per npx geholt.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "==> Lint (AMO/Store-Regeln)..." -ForegroundColor Cyan
npx --yes web-ext@latest lint --config=web-ext-config.cjs

Write-Host "`n==> Build ZIP (wie die CI)..." -ForegroundColor Cyan
npx --yes web-ext@latest build --config=web-ext-config.cjs --overwrite-dest
$zip = Get-ChildItem .\web-ext-artifacts\*.zip | Select-Object -First 1
Write-Host ("Artefakt: {0} ({1:N0} Bytes)" -f $zip.Name, $zip.Length) -ForegroundColor Green

Write-Host "`n==> Starte Chrome mit der Extension (Fenster offen lassen)..." -ForegroundColor Cyan
Write-Host "    Beenden mit Strg+C in diesem Fenster.`n" -ForegroundColor DarkGray
npx --yes web-ext@latest run --config=web-ext-config.cjs --target=chromium `
  --start-url "https://www.chess.com/" `
  --start-url "https://lichess.org/" `
  --start-url "https://www.chessable.com/"
