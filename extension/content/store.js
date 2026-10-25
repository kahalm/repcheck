// content.js-Teil (Zerlegung Z37): IndexedDB `RepertoireCheckerDB` und RookHub-Config.
//
// IDB-Layout unveraendert (CLAUDE.md „IndexedDB-Layout"): Store `handles` (Ordner-Handle) und `rookhub` (Config nur mit
// URL, Alt-Cache pgnTexts, Positions-Set). Der TOKEN kommt ausschliesslich aus chrome.storage.local (`rookhubConfig`),
// siehe loadRookhubConfig und CLAUDE.md „Sicherheit". Kein Zustand, keine Abhaengigkeiten.
//
// Laden: Manifest content_scripts (chess.com/lichess), VOR content.js; content.js holt sich die Funktionen aus
// self.RepCheckContent.store.
(function () {
  'use strict';

  // Wie content.js: laeuft content.js in diesem Tab schon (das Popup laedt die Manifest-Liste nach), nichts neu anlegen.
  if (window.__rdc_loaded) return;

  // ─── Constants ───────────────────────────────────────────────────────
  const IDB_NAME = 'RepertoireCheckerDB';
  const IDB_STORE = 'handles';
  const IDB_KEY = 'repertoireDir';
  // RookHub-Integration: separater Store fuer Config (URL+Token) und Cache.
  const IDB_ROOKHUB_STORE = 'rookhub';
  const IDB_ROOKHUB_CONFIG_KEY = 'config';
  const IDB_ROOKHUB_CACHE_KEY = 'cache';
  const IDB_ROOKHUB_POSITIONS_KEY = 'positionSet';

  // ─── IndexedDB helpers ───────────────────────────────────────────────
  function openIDB() {
    return new Promise((resolve, reject) => {
      // v2: zusaetzlicher Store fuer RookHub-Config + Cache. onupgradeneeded muss
      // beide Stores anlegen, weil der Upgrade auch beim ersten Anlegen laeuft.
      const req = indexedDB.open(IDB_NAME, 2);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        if (!db.objectStoreNames.contains(IDB_ROOKHUB_STORE)) db.createObjectStore(IDB_ROOKHUB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveHandle(handle) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadHandle() {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  // ─── RookHub IDB Helpers ────────────────────────────────────────────
  async function idbGet(store, key) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(store, key, value) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Extension-privater Config-Spiegel (chrome.storage.local) — seit v1.19.1 die
  // maßgebliche Quelle für den TOKEN. Geschrieben wird er nur im Extension-Origin
  // (Popup, Worker), seit v1.68.2 nicht mehr aus dem Seiten-Panel.
  function readLocalRookhubConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('rookhubConfig', (r) => resolve((r && r.rookhubConfig) || null));
      } catch (e) { resolve(null); }
    });
  }

  // Config laden. Der TOKEN wird bewusst NUR aus chrome.storage.local gelesen
  // (extension-privat), NICHT aus der IndexedDB: die IDB liegt auf dem
  // chess.com/lichess-Origin und ist damit von den Skripten der Host-Seite — und
  // jedem XSS dort — lesbar; ein dort abgelegter Token wäre exfiltrierbar.
  // Legacy-Migration: liegt der Token noch im alten IDB-Config-Record, wird er
  // einmalig nach chrome.storage.local gehoben und aus dem IDB entfernt.
  async function loadRookhubConfig() {
    const local = await readLocalRookhubConfig();
    if (local && local.url && local.token) return local;

    const legacy = await idbGet(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CONFIG_KEY).catch(() => null);
    if (legacy && legacy.url && legacy.token) {
      try {
        await new Promise((resolve) => {
          try { chrome.storage.local.set({ rookhubConfig: { url: legacy.url, token: legacy.token } }, resolve); }
          catch (e) { resolve(); }
        });
      } catch (e) { /* ignore */ }
      try { await idbPut(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CONFIG_KEY, { url: legacy.url }); } catch (e) { /* ignore */ }
      return { url: legacy.url, token: legacy.token };
    }
    // Kein Token — höchstens eine URL (neuer Zustand: IDB hält nur die URL).
    if (local && local.url) return local;
    return (legacy && legacy.url) ? { url: legacy.url } : null;
  }

  // pgnTexts-Cache (vor 1.6.0): nur noch lesend fuer einmalige Migration zum Position-Set.
  function loadRookhubCache() {
    return idbGet(IDB_ROOKHUB_STORE, IDB_ROOKHUB_CACHE_KEY);
  }

  function loadPositionSetCache() {
    return idbGet(IDB_ROOKHUB_STORE, IDB_ROOKHUB_POSITIONS_KEY);
  }

  function savePositionSetCache(data) {
    return idbPut(IDB_ROOKHUB_STORE, IDB_ROOKHUB_POSITIONS_KEY, data);
  }

  // ─── Export ──────────────────────────────────────────────────────────
  (self.RepCheckContent = self.RepCheckContent || {}).store = {
    openIDB, saveHandle, loadHandle, idbGet, idbPut, readLocalRookhubConfig, loadRookhubConfig,
    loadRookhubCache, loadPositionSetCache, savePositionSetCache,
  };
})();
