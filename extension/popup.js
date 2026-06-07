// Popup-Logik: zeigt den Cache-Status und triggert das Content-Script auf
// Klick. Seit v1.4.8 wird das Content-Script NICHT mehr automatisch in
// chess.com-Tabs geladen, sondern erst hier via chrome.scripting.executeScript.

const STATUS_EL = document.getElementById('status');
const ERROR_EL = document.getElementById('error-hint');
const REP_EL = document.getElementById('repertoires');

document.getElementById('open-chesscom').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.chess.com/' });
});
document.getElementById('open-lichess').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://lichess.org/' });
});

document.getElementById('run-check').addEventListener('click', () => triggerInTab('runCheck'));
document.getElementById('open-settings').addEventListener('click', () => triggerInTab('openSettings'));

function readRookhubStore() {
  return new Promise((resolve) => {
    const req = indexedDB.open('RepertoireCheckerDB', 2);
    req.onerror = () => resolve({ config: null, cache: null });
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('rookhub')) {
        db.close();
        resolve({ config: null, cache: null });
        return;
      }
      const tx = db.transaction('rookhub', 'readonly');
      const store = tx.objectStore('rookhub');
      const getCfg = store.get('config');
      const getCache = store.get('cache');
      let pending = 2;
      const out = { config: null, cache: null };
      const done = () => { if (--pending === 0) { db.close(); resolve(out); } };
      getCfg.onsuccess = () => { out.config = getCfg.result || null; done(); };
      getCfg.onerror = done;
      getCache.onsuccess = () => { out.cache = getCache.result || null; done(); };
      getCache.onerror = done;
    };
  });
}

// Holt die Repertoire-Liste vom RookHub-Server via Background-Worker (CORS-frei).
function fetchRookhubRepertoires(cfg) {
  const baseUrl = (cfg.url || '').replace(/\/$/, '');
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'rookhub-fetch',
      url: baseUrl + '/api/extension/repertoires?kind=opening',
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Accept': 'application/json',
      },
      expect: 'json',
    }, (resp) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!resp) { reject(new Error('keine Antwort vom Background-Worker')); return; }
      if (resp.status === 401) { reject(new Error('Token ungültig oder abgelaufen.')); return; }
      if (!resp.ok) { reject(new Error(resp.error || ('HTTP ' + resp.status))); return; }
      resolve(Array.isArray(resp.body) ? resp.body : []);
    });
  });
}

function renderRepertoireList(items) {
  if (!items || items.length === 0) {
    REP_EL.style.display = 'none';
    return;
  }
  const heading = document.createElement('div');
  heading.className = 'heading';
  heading.textContent = `Repertoires (${items.length})`;
  const ul = document.createElement('ul');
  for (const it of items) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = it.name || '(unbenannt)';
    const count = document.createElement('span');
    count.className = 'count';
    if (typeof it.fileCount === 'number') {
      count.textContent = it.fileCount + ' PGN' + (it.fileCount === 1 ? '' : 's');
    }
    li.appendChild(name);
    li.appendChild(count);
    ul.appendChild(li);
  }
  REP_EL.replaceChildren(heading, ul);
  REP_EL.style.display = 'block';
}

async function refreshStatus() {
  let store;
  try {
    store = await readRookhubStore();
  } catch {
    STATUS_EL.className = 'status empty';
    STATUS_EL.textContent = 'Status nicht verfügbar';
    return;
  }
  const { config, cache } = store;

  if (config && config.url && config.token) {
    STATUS_EL.className = 'status';
    STATUS_EL.textContent = 'RookHub: lade Repertoires…';
    try {
      const items = await fetchRookhubRepertoires(config);
      if (items.length > 0) {
        STATUS_EL.className = 'status loaded';
        STATUS_EL.textContent = `RookHub verbunden · ${items.length} Repertoire${items.length === 1 ? '' : 's'}`;
        renderRepertoireList(items);
      } else {
        STATUS_EL.className = 'status empty';
        STATUS_EL.textContent = 'RookHub verbunden · keine Opening-Repertoires';
      }
    } catch (e) {
      STATUS_EL.className = 'status error';
      STATUS_EL.textContent = 'RookHub: ' + e.message;
    }
    return;
  }

  if (cache && cache.count > 0) {
    const ago = Math.round((Date.now() - (cache.savedAt || 0)) / 60000);
    STATUS_EL.className = 'status loaded';
    STATUS_EL.textContent = `Lokal: ${cache.count} Eröffnungen geladen (vor ${ago} min)`;
    return;
  }

  STATUS_EL.className = 'status empty';
  STATUS_EL.textContent = 'Noch kein Repertoire geladen';
}

refreshStatus();

function showError(msg) {
  ERROR_EL.textContent = msg;
  ERROR_EL.style.display = 'block';
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

// Triggert die angegebene Aktion im Content-Script. Laedt chess.min.js +
// content.js nur dann, wenn der Tab sie noch nicht hat (Idempotency-Guard
// in content.js).
async function triggerInTab(action) {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !/^https:\/\/(www\.chess\.com|lichess\.org)\//.test(tab.url)) {
    showError('Bitte zuerst chess.com oder lichess.org im aktiven Tab oeffnen.');
    return;
  }
  try {
    // 1) Pruefen, ob content.js schon geladen ist.
    const [precheck] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!window.__rdc_loaded,
    });
    if (!precheck || !precheck.result) {
      // 2) Lazy-Inject chess.min.js + content.js (einmalig pro Tab).
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['chess.min.js', 'content.js'],
      });
    }
    // 3) Aktion ausloesen.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [action],
      func: (act) => {
        const api = window.__rdc_loaded;
        if (!api || typeof api[act] !== 'function') {
          console.warn('[RepertoireChecker] Kein Eintrag fuer Aktion:', act);
          return;
        }
        api[act]();
      },
    });
    window.close();
  } catch (e) {
    showError('Fehler: ' + (e && e.message ? e.message : String(e)));
  }
}
