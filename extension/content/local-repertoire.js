// content.js-Teil (Zerlegung Z37): lokaler Modus ohne RookHub — Positions-Set aus einem Ordner (File System Access
// API bzw. Datei-Auswahl in Firefox) oder eingefuegtem PGN, persistiert in der IndexedDB; die Abweichungs-Analyse
// dagegen (analyzeGame, transpositionsfest ueber normalisierte FENs) und die FEN vor der Abweichung.
//
// Zustand: repertoirePositions und dirHandle gehoeren content.js und laufen ueber das geteilte Zustandsobjekt S.
// Laden: Manifest content_scripts, VOR content.js → self.RepCheckContent.localRepertoire; Abhaengigkeiten per init().
(function () {
  'use strict';

  // Wie content.js: laeuft content.js in diesem Tab schon (das Popup laedt die Manifest-Liste nach), nichts neu anlegen.
  if (window.__rdc_loaded) return;

  // Shared-Core (lib/repertoire-text.js, per Manifest davor geladen) — wie in content.js.
  const { parsePgnText, normalizedFen } = (self.RepCheckLib || {});
  // Aus content.js und den anderen Teil-Dateien (init).
  let S, t, updateStatusText, runCheck;
  let saveHandle, savePositionSetCache, loadPositionSetCache, loadRookhubCache;

  // Baut das Positions-Set aus PGN-Texten und persistiert es. Wird NUR auf
  // explizite Nutzeraktion aufgerufen (Aktualisieren-Button, neuer Ordner,
  // PGN-Text). Auf Page-Loads lesen wir das fertige Set direkt aus IDB.
  async function buildAndSavePositionSet(pgnTexts) {
    const set = buildPositionSetFromPgns(pgnTexts);
    try {
      await savePositionSetCache({ fens: Array.from(set), savedAt: Date.now() });
    } catch (e) {
      console.warn('[RepertoireChecker] Position-Cache nicht schreibbar:', e);
    }
    return set;
  }

  // ─── Repertoire Position Set ─────────────────────────────────────────
  // Transpositions: statt Zug-Sequenzen speichern wir alle erreichbaren
  // Stellungen als normalisierte FEN-Strings in einem Set. Zwei Partien,
  // die dieselbe Stellung ueber verschiedene Zugfolgen erreichen, treffen
  // auf denselben FEN-Eintrag.

  // normalizedFen: siehe Shared-Core (self.RepCheckLib, oben destrukturiert).

  function walkMovesForPositions(chess, moves, positions) {
    // Wir nutzen denselben Chess-Instanz fuer alle Varianten und stellen den
    // Stand am Ende per undo() wieder her. Ersetzt das alte `new Chess(fen())`
    // pro Variante (FEN-Serialize+Parse-Roundtrip war der Haupt-CPU-Fresser).
    let movesMade = 0;
    for (const move of moves) {
      // Varianten zweigen VOR diesem Zug ab
      if (move.variations && move.variations.length > 0) {
        for (const variation of move.variations) {
          walkMovesForPositions(chess, variation, positions);
        }
      }
      const result = chess.move(move.san);
      if (!result) break; // illegaler Zug im PGN
      movesMade++;
      positions.add(normalizedFen(chess.fen()));
    }
    for (let i = 0; i < movesMade; i++) chess.undo();
  }

  function buildPositionSetFromPgns(pgnTexts) {
    const positions = new Set();
    positions.add(normalizedFen(new Chess().fen())); // Ausgangsstellung einschliessen
    for (const text of pgnTexts) {
      try {
        const games = parsePgnText(text);
        for (const moves of games) {
          walkMovesForPositions(new Chess(), moves, positions);
        }
      } catch (e) {
        console.warn('[RepertoireChecker] PGN parse error:', e);
      }
    }
    return positions;
  }

  // ─── File Loading ────────────────────────────────────────────────────
  async function pickDirectory() {
    // Chrome/Edge: use File System Access API
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        S.dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        await saveHandle(S.dirHandle);
        await loadRepertoireFromDir();
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.error('[RepertoireChecker] Directory picker error:', e);
        }
      }
      return;
    }
    // Firefox fallback: trigger hidden file input
    pickDirectoryViaInput();
  }

  function pickDirectoryViaInput() {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.multiple = true;
    input.accept = '.pgn';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      loadRepertoireFromFiles(input.files);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  function loadRepertoireFromFiles(fileList) {
    const pgnFiles = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.pgn'));
    if (pgnFiles.length === 0) {
      updateStatusText(t('panel.noPgnFiles'));
      return;
    }

    Promise.all(pgnFiles.map(f => f.text())).then(async pgnTexts => {
      S.repertoirePositions = await buildAndSavePositionSet(pgnTexts);
      updateStatusText(t('panel.loadedFiles', { count: pgnTexts.length }));
      runCheck();
    });
  }

  async function loadRepertoireFromDir() {
    if (!S.dirHandle) return false;

    const perm = await S.dirHandle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      const req = await S.dirHandle.requestPermission({ mode: 'read' });
      if (req !== 'granted') return false;
    }

    const pgnTexts = [];
    for await (const [name, entry] of S.dirHandle.entries()) {
      if (entry.kind === 'file' && name.toLowerCase().endsWith('.pgn')) {
        try {
          const file = await entry.getFile();
          const text = await file.text();
          pgnTexts.push(text);
        } catch (e) {
          console.warn(`[RepertoireChecker] Could not read ${name}:`, e);
        }
      }
    }

    if (pgnTexts.length > 0) {
      S.repertoirePositions = await buildAndSavePositionSet(pgnTexts);
      updateStatusText(t('panel.loadedFiles', { count: pgnTexts.length }));
      runCheck();
      return true;
    } else {
      updateStatusText(t('panel.noPgnFiles'));
      return false;
    }
  }

  async function loadRepertoireFromText(pgnText) {
    if (!pgnText.trim()) return;
    S.repertoirePositions = await buildAndSavePositionSet([pgnText]);
    updateStatusText(t('panel.loadedText'));
    runCheck();
  }

  function analyzeGame(gameMoves) {
    // Returns { deviation: int, gaps: int[] }
    // deviation: Index des ersten dauerhaften Ausreissers (-1 = kein)
    // gaps: Indizes temporaerer Ausreisser (Zugumstellungen, Partie kehrt spaeter zurueck)
    if (!S.repertoirePositions) return { deviation: -1, gaps: [] };

    const chess = new Chess();
    const inRep = [];
    for (let i = 0; i < gameMoves.length; i++) {
      const result = chess.move(gameMoves[i]);
      if (!result) { inRep.push(false); break; }
      inRep.push(S.repertoirePositions.has(normalizedFen(chess.fen())));
    }

    let lastIn = -1;
    for (let i = inRep.length - 1; i >= 0; i--) {
      if (inRep[i]) { lastIn = i; break; }
    }

    const gaps = [];
    const inRepertoire = [];
    let deviation = -1;
    for (let i = 0; i < inRep.length; i++) {
      if (inRep[i]) {
        inRepertoire.push(i);
      } else if (i <= lastIn) {
        gaps.push(i);
      } else if (deviation === -1) {
        deviation = i;
      }
    }
    return { deviation, gaps, inRepertoire };
  }

  // FEN nach den ersten `idx` Zuegen (also VOR Anwendung von gameMoves[idx]).
  // Wird fuer die Chessable-Suche genutzt: zeigt die Position, aus der heraus
  // der erste Out-of-Rep-Zug gespielt wurde.
  function fenBeforeMove(gameMoves, idx) {
    const chess = new Chess();
    for (let i = 0; i < idx && i < gameMoves.length; i++) {
      if (!chess.move(gameMoves[i])) break;
    }
    return chess.fen();
  }

  // Stellt sicher, dass repertoirePositions geladen ist. Bei kaltem Tab
  // liest das Set einmalig aus IndexedDB. Migration vom alten pgnTexts-
  // Cache findet hier auch statt, falls noetig.
  async function ensurePositionSet() {
    if (S.repertoirePositions) return true;
    try {
      const cached = await loadPositionSetCache();
      if (cached && Array.isArray(cached.fens) && cached.fens.length > 0) {
        S.repertoirePositions = new Set(cached.fens);
        return true;
      }
    } catch (e) {
      console.log('[RepertoireChecker] Position-Cache nicht lesbar:', e);
    }
    // Migration: aus altem pgnTexts-Cache neu bauen, falls vorhanden.
    try {
      const rh = await loadRookhubCache();
      if (rh && Array.isArray(rh.pgnTexts) && rh.pgnTexts.length > 0) {
        S.repertoirePositions = await buildAndSavePositionSet(rh.pgnTexts);
        return true;
      }
    } catch (e) {
      console.log('[RepertoireChecker] RookHub-PGN-Cache nicht lesbar:', e);
    }
    return false;
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckContent = self.RepCheckContent || {}).localRepertoire = {
    init(deps) {
      ({ S, t, updateStatusText, runCheck } = deps);
      ({ saveHandle, savePositionSetCache, loadPositionSetCache, loadRookhubCache } = deps);
    },
    buildAndSavePositionSet, walkMovesForPositions, buildPositionSetFromPgns, pickDirectory, pickDirectoryViaInput,
    loadRepertoireFromFiles, loadRepertoireFromDir, loadRepertoireFromText, analyzeGame, fenBeforeMove,
    ensurePositionSet,
  };
})();
