// Popup-Logik: zeigt den Cache-Status der RookHub-Daten und einen Shortcut auf chess.com.
// Bewusst sehr klein — die echte Einstellungs-UI lebt im Content-Script auf chess.com.

const STATUS_EL = document.getElementById('status');

document.getElementById('open-chesscom').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.chess.com/' });
});

// IndexedDB direkt aus dem Popup-Kontext lesen — gleiche DB wie der Content-Script,
// weil Browser-Extensions pro Extension-ID isolierte Storage haben (Popup + Content
// + Background teilen sich Origin-Storage).
function readCacheStatus() {
  return new Promise((resolve) => {
    const req = indexedDB.open('RepertoireCheckerDB', 2);
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('rookhub')) {
        db.close();
        resolve(null);
        return;
      }
      const tx = db.transaction('rookhub', 'readonly');
      const get = tx.objectStore('rookhub').get('cache');
      get.onsuccess = () => { db.close(); resolve(get.result || null); };
      get.onerror = () => { db.close(); resolve(null); };
    };
  });
}

readCacheStatus().then((cache) => {
  if (cache && cache.count > 0) {
    const ago = Math.round((Date.now() - (cache.savedAt || 0)) / 60000);
    STATUS_EL.className = 'status loaded';
    STATUS_EL.textContent = `RookHub: ${cache.count} Eröffnungen geladen (vor ${ago} min)`;
  } else {
    STATUS_EL.className = 'status empty';
    STATUS_EL.textContent = 'Noch kein Repertoire geladen';
  }
}).catch(() => {
  STATUS_EL.className = 'status empty';
  STATUS_EL.textContent = 'Status nicht verfügbar';
});
