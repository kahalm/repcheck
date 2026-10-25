// Popup: Sharebar (Zerlegung Z39, bis v1.73.1 in popup.js) — oeffentlicher Nur-Ansehen-Link {RookHub}/l/{token} zur
// gerade auf chess.com/lichess gespielten Zugfolge (POST /api/extension/share-line). Liest die Zuege ueber content.js
// (ensureContentLoaded/getCurrentLine, Tab-Helfer in popup.js).
// Klassisches Skript im globalen Scope des Popups (popup.html laedt es nach popup.js); beim Laden nur Zugriff auf
// Frueheres, die Neubeschriftung beim Sprachwechsel haengt es in repaintHooks (popup.js) ein.

// ─── Sharebar: Link zur aktuellen Line ─────────────────────────────────
// Oben im Popup ein oeffentlicher Nur-Ansehen-Link (/l/{token}) zur gerade auf
// chess.com/lichess gespielten Zugfolge. Beim Oeffnen des Popups wird die
// aktuelle Line aus dem Tab gelesen und serverseitig als Line geteilt (Dedup:
// dieselbe Zugfolge -> derselbe Link). Braucht eine konfigurierte RookHub-Instanz.
const SHAREBAR = document.getElementById('sharebar');
const SHARE_URL = document.getElementById('share-url');
const COPY_SHARE = document.getElementById('copy-share');
const SHARE_STATE = document.getElementById('share-state');

let sharePaint = null;
function setShareState(key, params) {
  sharePaint = { key, params: params || null };
  paintShareState();
}
function paintShareState() {
  if (sharePaint) SHARE_STATE.textContent = t(sharePaint.key, sharePaint.params);
}
repaintHooks.push(paintShareState);

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
      if (!resp) { reject(new Error(t('err.noBackground'))); return; }
      if (resp.status === 401) { reject(new Error(t('err.tokenInvalid'))); return; }
      if (!resp.ok) { reject(new Error(resp.error || t('err.http', { status: resp.status }))); return; }
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
  setShareState('popup.share.loading');
  COPY_SHARE.disabled = true;
  try {
    const line = await getCurrentLineFromTab(tab);
    if (!line.moves || !line.moves.length) {
      SHARE_URL.value = '';
      setShareState('popup.share.noMoves');
      return;
    }
    const res = await postShareLine(cfg, line.moves, line.title);
    const token = res && (res.shareToken || res.ShareToken);
    if (!token) throw new Error(t('err.noToken'));
    SHARE_URL.value = (cfg.url || '').replace(/\/$/, '') + '/l/' + token;
    COPY_SHARE.disabled = false;
    setShareState('popup.share.ready', { count: line.moves.length });
  } catch (e) {
    SHARE_URL.value = '';
    setShareState('popup.share.failed', { error: (e && e.message ? e.message : String(e)) });
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
  setShareState('popup.copied');
});

initShareBar();
