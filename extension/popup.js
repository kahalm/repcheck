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
    // Muss dem Schema in content.js openIDB() entsprechen — sonst legt das Popup
    // die DB ohne den rookhub-Store an und content.js bekommt keinen Upgrade-
    // Trigger mehr, weil die Version schon stimmt.
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      if (!db.objectStoreNames.contains('rookhub')) db.createObjectStore('rookhub');
    };
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

// Die RookHub-Config wird vom Content-Script auch nach chrome.storage.local
// gespiegelt (saveRookhubConfig, Key `rookhubConfig`). Das ist hier die
// VERLAESSLICHE Quelle: die IndexedDB `RepertoireCheckerDB` ist origin-scoped
// (chess.com/lichess) und im Popup-Origin (chrome-extension://…) NICHT lesbar —
// readRookhubStore() liefert hier also nie die Config. chrome.storage.local ist
// dagegen extension-weit.
function readRookhubConfigFromStorage() {
  return new Promise((resolve) => {
    if (!chrome.storage || !chrome.storage.local) { resolve(null); return; }
    chrome.storage.local.get('rookhubConfig', (res) => {
      const c = res && res.rookhubConfig;
      resolve(c && c.url && c.token ? c : null);
    });
  });
}

async function refreshStatus() {
  let store;
  try {
    store = await readRookhubStore();
  } catch {
    store = { config: null, cache: null };
  }
  // chrome.storage.local-Spiegel hat Vorrang vor der (im Popup-Origin leeren) IDB.
  const config = (await readRookhubConfigFromStorage()) || store.config;
  const { cache } = store;

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

// ─── Chessable-Token ───────────────────────────────────────────────────
// Der von chessable.com abgefangene Bearer-Token liegt in chrome.storage.local
// (origin-uebergreifend lesbar). Das Popup zeigt ihn nicht an (zu lang), sondern
// bietet nur einen Copy-Button fuer die Weitergabe an piratechess.
const CHESSABLE_BOX = document.getElementById('chessable-box');
const COPY_CHESSABLE = document.getElementById('copy-chessable');
const CHESSABLE_STATE = document.getElementById('chessable-state');

function refreshChessableToken() {
  if (!chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get('chessableToken', (res) => {
    const entry = res && res.chessableToken;
    if (!entry || !entry.token) {
      CHESSABLE_BOX.style.display = 'none';
      return;
    }
    CHESSABLE_BOX.style.display = 'block';
    COPY_CHESSABLE.disabled = false;
    const ago = Math.round((Date.now() - (entry.capturedAt || 0)) / 60000);
    CHESSABLE_STATE.textContent = ago <= 0 ? 'gerade erfasst' : `vor ${ago} min erfasst`;
  });
}

COPY_CHESSABLE.addEventListener('click', () => {
  chrome.storage.local.get('chessableToken', async (res) => {
    const entry = res && res.chessableToken;
    if (!entry || !entry.token) return;
    try {
      await navigator.clipboard.writeText(entry.token);
      CHESSABLE_STATE.textContent = 'kopiert ✓';
    } catch (e) {
      CHESSABLE_STATE.textContent = 'Kopieren fehlgeschlagen';
    }
  });
});

refreshChessableToken();

function showError(msg) {
  ERROR_EL.textContent = msg;
  ERROR_EL.style.display = 'block';
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

// ─── Sharebar: Link zur aktuellen Line ─────────────────────────────────
// Oben im Popup ein oeffentlicher Nur-Ansehen-Link (/l/{token}) zur gerade auf
// chess.com/lichess gespielten Zugfolge. Beim Oeffnen des Popups wird die
// aktuelle Line aus dem Tab gelesen und serverseitig als Line geteilt (Dedup:
// dieselbe Zugfolge -> derselbe Link). Braucht eine konfigurierte RookHub-Instanz.
const SHAREBAR = document.getElementById('sharebar');
const SHARE_URL = document.getElementById('share-url');
const COPY_SHARE = document.getElementById('copy-share');
const SHARE_STATE = document.getElementById('share-state');

async function ensureContentLoaded(tab) {
  const [precheck] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => !!window.__rdc_loaded,
  });
  if (!precheck || !precheck.result) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['chess.min.js', 'lib/repertoire-text.js', 'content.js'],
    });
  }
}

async function getCurrentLineFromTab(tab) {
  await ensureContentLoaded(tab);
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const api = window.__rdc_loaded;
      return api && typeof api.getCurrentLine === 'function' ? api.getCurrentLine() : { moves: [], title: '' };
    },
  });
  return (res && res.result) || { moves: [], title: '' };
}

function postShareLine(cfg, moves, title) {
  const baseUrl = (cfg.url || '').replace(/\/$/, '');
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'rookhub-fetch',
      url: baseUrl + '/api/extension/share-line',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ moves, title }),
      expect: 'json',
    }, (resp) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!resp) { reject(new Error('keine Antwort vom Background-Worker')); return; }
      if (resp.status === 401) { reject(new Error('Token ungültig oder abgelaufen.')); return; }
      if (!resp.ok) { reject(new Error(resp.error || ('HTTP ' + resp.status))); return; }
      resolve(resp.body);
    });
  });
}

async function initShareBar() {
  const cfg = await readRookhubConfigFromStorage();
  if (!cfg) return; // ohne RookHub-Config kein Teilen-Link
  const tab = await getActiveTab();
  if (!tab || !tab.url || !/^https:\/\/(www\.chess\.com|lichess\.org)\//.test(tab.url)) return;
  SHAREBAR.style.display = 'block';
  SHARE_STATE.textContent = 'lade…';
  COPY_SHARE.disabled = true;
  try {
    const line = await getCurrentLineFromTab(tab);
    if (!line.moves || !line.moves.length) {
      SHARE_URL.value = '';
      SHARE_STATE.textContent = 'Keine Zugfolge auf dieser Seite.';
      return;
    }
    const res = await postShareLine(cfg, line.moves, line.title);
    const token = res && (res.shareToken || res.ShareToken);
    if (!token) throw new Error('kein Token in der Antwort');
    SHARE_URL.value = (cfg.url || '').replace(/\/$/, '') + '/l/' + token;
    COPY_SHARE.disabled = false;
    const n = line.moves.length;
    SHARE_STATE.textContent = `${n} Halbzug${n === 1 ? '' : 'e'} · klick „Kopieren"`;
  } catch (e) {
    SHARE_URL.value = '';
    SHARE_STATE.textContent = 'Link fehlgeschlagen: ' + (e && e.message ? e.message : String(e));
  }
}

COPY_SHARE.addEventListener('click', async () => {
  if (!SHARE_URL.value) return;
  try {
    await navigator.clipboard.writeText(SHARE_URL.value);
  } catch {
    SHARE_URL.select();
    document.execCommand('copy');
  }
  SHARE_STATE.textContent = 'kopiert ✓';
});

initShareBar();

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
      // 2) Lazy-Inject chess.min.js + Shared-Core (RepCheckLib) + content.js (einmalig pro Tab).
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['chess.min.js', 'lib/repertoire-text.js', 'content.js'],
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
