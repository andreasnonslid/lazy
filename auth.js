// Authentication module for Lazy Apps
// PBKDF2 password hashing, AES-GCM token encryption, rate limiting, sessions

const Auth = (() => {
  const RATE_KEY = 'lazy_auth_rate_v1';
  const SESSION_KEY = 'lazy_auth_session';
  const MAX_ATTEMPTS = 5;
  const WINDOW_MS = 15 * 60 * 1000;
  const BASE_LOCKOUT_MS = 15 * 60 * 1000;

  // --- Crypto primitives (Web Crypto API) ---

  function hexToBytes(hex) {
    const a = new Uint8Array(hex.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
    return a;
  }

  function bytesToHex(buf) {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function generateSalt() {
    return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  }

  async function pbkdf2Hash(password, saltHex) {
    const enc = new TextEncoder();
    const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 100000, hash: 'SHA-256' },
      km, 256
    );
    return bytesToHex(bits);
  }

  async function deriveAesKey(password, saltHex) {
    const enc = new TextEncoder();
    const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 100000, hash: 'SHA-256' },
      km,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encrypt(plaintext, password, saltHex) {
    const key = await deriveAesKey(password, saltHex);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext)
    );
    return { iv: bytesToHex(iv), ciphertext: bytesToHex(ct) };
  }

  async function decrypt(encrypted, password, saltHex) {
    const key = await deriveAesKey(password, saltHex);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(encrypted.iv) },
      key,
      hexToBytes(encrypted.ciphertext)
    );
    return new TextDecoder().decode(pt);
  }

  // --- Rate limiting ---

  function _rateData() {
    try { return JSON.parse(localStorage.getItem(RATE_KEY) || '{}'); }
    catch { return {}; }
  }

  function _saveRate(d) {
    localStorage.setItem(RATE_KEY, JSON.stringify(d));
  }

  function checkRateLimit() {
    const d = _rateData();
    const now = Date.now();

    if (d.lockoutUntil && now < d.lockoutUntil) {
      return { allowed: false, lockoutRemaining: Math.ceil((d.lockoutUntil - now) / 1000), attemptsRemaining: 0 };
    }

    if (d.lockoutUntil && now >= d.lockoutUntil) {
      d.lockoutUntil = null;
      d.attempts = [];
    }

    d.attempts = (d.attempts || []).filter(t => now - t < WINDOW_MS);
    _saveRate(d);

    if (d.attempts.length >= MAX_ATTEMPTS) {
      const mult = (d.lockoutCount || 0) + 1;
      d.lockoutUntil = now + BASE_LOCKOUT_MS * mult;
      d.lockoutCount = mult;
      d.attempts = [];
      _saveRate(d);
      return { allowed: false, lockoutRemaining: Math.ceil(BASE_LOCKOUT_MS * mult / 1000), attemptsRemaining: 0 };
    }

    return { allowed: true, attemptsRemaining: MAX_ATTEMPTS - d.attempts.length, lockoutRemaining: 0 };
  }

  function recordAttempt(success) {
    const d = _rateData();
    if (success) {
      d.attempts = [];
      d.lockoutUntil = null;
      d.lockoutCount = 0;
    } else {
      d.attempts = d.attempts || [];
      d.attempts.push(Date.now());
    }
    _saveRate(d);
  }

  // --- Session management (sessionStorage — cleared on tab close) ---

  function getSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function setSession(data) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  // --- Login ---

  async function login(username, password, config) {
    const rate = checkRateLimit();
    if (!rate.allowed) {
      return { success: false, error: `Too many attempts. Try again in ${formatTime(rate.lockoutRemaining)}.`, locked: true };
    }

    if (username !== config.username) {
      recordAttempt(false);
      const r = checkRateLimit();
      if (!r.allowed) return { success: false, error: `Too many attempts. Try again in ${formatTime(r.lockoutRemaining)}.`, locked: true };
      return { success: false, error: `Invalid credentials. ${r.attemptsRemaining} attempt${r.attemptsRemaining !== 1 ? 's' : ''} remaining.` };
    }

    let hash;
    try { hash = await pbkdf2Hash(password, config.salt); }
    catch { recordAttempt(false); return { success: false, error: 'Authentication error.' }; }

    if (hash !== config.passwordHash) {
      recordAttempt(false);
      const r = checkRateLimit();
      if (!r.allowed) return { success: false, error: `Too many attempts. Try again in ${formatTime(r.lockoutRemaining)}.`, locked: true };
      return { success: false, error: `Invalid credentials. ${r.attemptsRemaining} attempt${r.attemptsRemaining !== 1 ? 's' : ''} remaining.` };
    }

    let token;
    try { token = await decrypt(config.encryptedToken, password, config.salt); }
    catch { recordAttempt(false); return { success: false, error: 'Config corrupted. Re-run setup.' }; }

    recordAttempt(true);
    setSession({ token, username, repo: config.repo, syncKeys: config.syncKeys });
    return { success: true, token };
  }

  // --- Config generation (used by setup page) ---

  async function generateConfig(username, password, pat, repoOwner, repoName) {
    const salt = generateSalt();
    const passwordHash = await pbkdf2Hash(password, salt);
    const encryptedToken = await encrypt(pat, password, salt);
    return {
      version: 1,
      username,
      passwordHash,
      salt,
      encryptedToken,
      repo: { owner: repoOwner, name: repoName },
      syncKeys: [
        'infinite_timers_v1',
        'infinite_timers_settings_v1',
        'lazy_notes_v1',
        'lazy_notes_settings_v1',
        'lazy_last_page_v1'
      ]
    };
  }

  // --- Helpers ---

  function formatTime(sec) {
    if (sec >= 3600) {
      const h = Math.floor(sec / 3600);
      const m = Math.ceil((sec % 3600) / 60);
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    if (sec >= 60) {
      const m = Math.ceil(sec / 60);
      return `${m} minute${m !== 1 ? 's' : ''}`;
    }
    return `${sec}s`;
  }

  return {
    checkRateLimit, recordAttempt,
    login, getSession, setSession, clearSession,
    generateConfig, formatTime,
    pbkdf2Hash, encrypt, decrypt, generateSalt
  };
})();
