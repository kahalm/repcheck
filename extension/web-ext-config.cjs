// Konfiguration fuer Mozillas `web-ext`-CLI (lokales Testen + Build/Signing).
//
// Installation:  npm install -g web-ext
//
// Wichtige Befehle (im Verzeichnis ./extension ausfuehren):
//   web-ext run                # Startet Firefox mit Auto-Reload
//   web-ext run --target=chromium  # Startet Chrome mit Auto-Reload (Chromium gebraucht)
//   web-ext lint               # Pruefen ob Manifest + Code OK fuer AMO
//   web-ext build              # Erzeugt ein ZIP unter ./web-ext-artifacts/
//   web-ext sign --api-key=... --api-secret=...  # AMO-Signatur

module.exports = {
  sourceDir: __dirname,
  artifactsDir: __dirname + '/web-ext-artifacts',
  ignoreFiles: [
    'web-ext-config.cjs',
    'generate-icons.py',
    '**/*.md',
    '**/.DS_Store',
  ],
  build: {
    overwriteDest: true,
  },
  run: {
    startUrl: ['https://www.chess.com/'],
  },
};
