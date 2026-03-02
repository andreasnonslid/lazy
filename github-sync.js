// GitHub Sync module for Lazy Apps
// Manual + optional auto-sync of localStorage data to a GitHub repo via Contents API
// Only pushes when data has actually changed (dirty detection via snapshot comparison)

const GitHubSync = (() => {
  const API = 'https://api.github.com';
  const DATA_PATH = 'data/sync.json';
  const SETTINGS_KEY = 'lazy_sync_settings_v1';

  let token, owner, repo, syncKeys;
  let sha = null;
  let syncing = false;
  let autoSyncTimer = null;
  let lastPushedSnapshot = null;
  let lastSyncTime = null;
  let lastSyncOk = null;
  let onDataPulled = null;

  function init(session) {
    token = session.token;
    owner = session.repo.owner;
    repo = session.repo.name;
    syncKeys = session.syncKeys || [];
  }

  function onPull(cb) { onDataPulled = cb; }

  // --- Dirty detection via snapshot comparison ---

  function _snapshot() {
    return syncKeys.map(k => k + '\0' + (localStorage.getItem(k) || '')).join('\n');
  }

  function isDirty() {
    return lastPushedSnapshot === null || _snapshot() !== lastPushedSnapshot;
  }

  // --- GitHub API helper ---

  async function _api(path, opts = {}) {
    const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${path}`, {
      ...opts,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        ...(opts.headers || {})
      }
    });
    if (res.status === 404) return null;
    if (res.status === 409) throw new Error('409 Conflict');
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return res.json();
  }

  // --- Pull: fetch remote data into localStorage ---

  async function pull() {
    const file = await _api(DATA_PATH);
    if (!file) return false;

    sha = file.sha;
    let remoteData;
    try { remoteData = JSON.parse(atob(file.content)).data; }
    catch { return false; }
    if (!remoteData) return false;

    let changed = false;
    syncKeys.forEach(k => {
      if (!(k in remoteData)) return;
      const remoteVal = typeof remoteData[k] === 'string'
        ? remoteData[k]
        : JSON.stringify(remoteData[k]);
      if (remoteVal !== localStorage.getItem(k)) {
        localStorage.setItem(k, remoteVal);
        changed = true;
      }
    });

    lastPushedSnapshot = _snapshot();
    if (changed && onDataPulled) onDataPulled();
    return changed;
  }

  // --- Push: upload localStorage to GitHub (only if dirty) ---

  function _collect() {
    const data = {};
    syncKeys.forEach(k => {
      const v = localStorage.getItem(k);
      if (v !== null) {
        try { data[k] = JSON.parse(v); } catch { data[k] = v; }
      }
    });
    return data;
  }

  function _encode(data) {
    return btoa(unescape(encodeURIComponent(
      JSON.stringify({ version: 1, lastSync: Date.now(), data }, null, 2)
    )));
  }

  async function _doPush() {
    const body = { message: 'Sync app data', content: _encode(_collect()) };
    if (sha) body.sha = sha;
    const res = await _api(DATA_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res && res.content) sha = res.content.sha;
    lastPushedSnapshot = _snapshot();
  }

  async function push() {
    if (!isDirty()) return false;
    try {
      await _doPush();
      return true;
    } catch (e) {
      if (e.message === '409 Conflict') {
        await pull();
        if (isDirty()) await _doPush();
        return true;
      }
      throw e;
    }
  }

  // --- Manual sync: push (if dirty) then pull ---

  async function sync() {
    if (syncing) return { status: 'busy' };
    syncing = true;
    try {
      const pushed = await push();
      const pulled = await pull();
      lastSyncTime = Date.now();
      lastSyncOk = true;
      return { status: 'success', pushed, pulled };
    } catch (e) {
      lastSyncOk = false;
      return { status: 'error', error: e.message };
    } finally {
      syncing = false;
    }
  }

  // --- Auto-sync (optional, user-configured) ---

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
    catch { return {}; }
  }

  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  function startAutoSync(intervalMinutes) {
    stopAutoSync(true);
    const ms = intervalMinutes * 60 * 1000;
    autoSyncTimer = setInterval(() => sync(), ms);
    saveSettings({ autoSync: true, intervalMinutes });
  }

  function stopAutoSync(silent) {
    if (autoSyncTimer) {
      clearInterval(autoSyncTimer);
      autoSyncTimer = null;
    }
    if (!silent) {
      const s = loadSettings();
      s.autoSync = false;
      saveSettings(s);
    }
  }

  // --- Beforeunload: last-chance push if dirty ---

  function enableBeforeUnload() {
    window.addEventListener('beforeunload', () => {
      if (!isDirty()) return;
      try {
        fetch(`${API}/repos/${owner}/${repo}/contents/${DATA_PATH}`, {
          method: 'PUT',
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: 'Sync app data',
            content: _encode(_collect()),
            ...(sha ? { sha } : {})
          }),
          keepalive: true
        });
      } catch {}
    });
  }

  // --- Status accessors ---

  function getLastSyncTime() { return lastSyncTime; }
  function isLastSyncOk() { return lastSyncOk; }
  function isSyncing() { return syncing; }

  return {
    init, onPull, pull, push, sync,
    isDirty, isSyncing, getLastSyncTime, isLastSyncOk,
    startAutoSync, stopAutoSync, loadSettings, saveSettings,
    enableBeforeUnload
  };
})();
