'use strict';

// Optional, personal-preview TikTok Login Kit integration. It requires an
// approved app and persistent private storage. Tokens never go to the browser.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const COOKIE = '__Host-cutline_tiktok_session';
const POLL_INTERVAL_MS = 60_000;
const STATE_LIFETIME_MS = 10 * 60_000;
const TOKEN_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PROFILES = 50;
const AAD = Buffer.from('cutline-tiktok-profiles-v1');

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeError(status, message) { const error = new Error(message); error.status = status; return error; }
function cookieSession(header) {
  const item = String(header || '').split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='));
  const value = item ? item.slice(COOKIE.length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}
function sessionCookie(token) { return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`; }
function clearSessionCookie() { return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`; }

function tiktokConfiguration(env, passwordValid) {
  const enabled = env.CUTLINE_TIKTOK_ENABLED === 'true';
  const clientKey = String(env.TIKTOK_CLIENT_KEY || '').trim();
  const clientSecret = String(env.TIKTOK_CLIENT_SECRET || '').trim();
  const keyText = String(env.CUTLINE_TIKTOK_ENCRYPTION_KEY || '').trim();
  const encryptionKey = /^[0-9a-fA-F]{64}$/.test(keyText) ? Buffer.from(keyText, 'hex') : null;
  const directoryText = String(env.CUTLINE_TIKTOK_DATA_DIR || '').trim();
  const directory = directoryText && path.isAbsolute(directoryText) ? path.resolve(directoryText) : '';
  // Never write account data inside the source checkout by accident.
  const externalDirectory = directory && directory !== __dirname && !directory.startsWith(__dirname + path.sep);
  let redirect = '';
  try {
    const url = new URL(String(env.TIKTOK_REDIRECT_URI || ''));
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/api/tiktok/callback') redirect = url.href;
  } catch (_) {}
  return {
    ready: Boolean(enabled && passwordValid && clientKey && clientSecret && encryptionKey && externalDirectory && redirect),
    clientKey, clientSecret, encryptionKey, directory, redirect,
  };
}

class EncryptedStore {
  constructor(directory, key) { this.directory = directory; this.key = key; this.file = path.join(directory, 'cutline-tiktok-profiles.enc'); this.data = null; this.queue = Promise.resolve(); }
  async locked(work) {
    const previous = this.queue;
    let release;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (!this.data) this.data = await this.load();
      return await work();
    } finally { release(); }
  }
  async load() {
    let contents;
    try { contents = await fs.readFile(this.file); } catch (error) {
      if (error.code === 'ENOENT') return { profiles: {} };
      throw safeError(503, 'Private profile storage is unavailable.');
    }
    try {
      if (contents.length > 2 * 1024 * 1024) throw new Error('too large');
      const envelope = JSON.parse(contents.toString('utf8'));
      if (envelope.version !== 1) throw new Error('version');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(AAD); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      const data = JSON.parse(plain.toString('utf8'));
      if (!data || typeof data.profiles !== 'object' || Array.isArray(data.profiles)) throw new Error('format');
      return data;
    } catch (_) { throw safeError(503, 'Private profile storage could not be opened. Check the encryption key and data volume.'); }
  }
  async write(next) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    const temporary = path.join(this.directory, '.cutline-' + randomToken(12) + '.tmp');
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, envelope, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.file);
    } catch (_) {
      await fs.unlink(temporary).catch(() => {});
      throw safeError(503, 'Private profile storage is unavailable.');
    }
  }
  async read(fn) { return this.locked(() => structuredClone(fn(this.data))); }
  async update(fn) {
    return this.locked(async () => {
      const next = structuredClone(this.data);
      const result = await fn(next);
      await this.write(next);
      this.data = next;
      return structuredClone(result);
    });
  }
}

function sanitizeToken(data, previous, time) {
  const access = typeof data?.access_token === 'string' ? data.access_token : '';
  const refresh = typeof data?.refresh_token === 'string' ? data.refresh_token : (previous?.refresh || '');
  const openId = typeof data?.open_id === 'string' ? data.open_id : (previous?.openId || '');
  const expires = Number(data?.expires_in);
  const refreshExpires = Number(data?.refresh_expires_in);
  const scopes = typeof data?.scope === 'string' ? data.scope : (previous?.scopes || '');
  if (!access || access.length > 4096 || !refresh || refresh.length > 4096 || !openId || openId.length > 256 || !Number.isFinite(expires) || expires <= 0 || expires > 366 * 86400) {
    throw safeError(502, 'TikTok did not return a usable authorization. Please reconnect.');
  }
  return {
    access, refresh, openId, scopes: scopes.slice(0, 1000),
    accessExpiresAt: time + expires * 1000,
    refreshExpiresAt: Number.isFinite(refreshExpires) && refreshExpires > 0 && refreshExpires <= 2 * 366 * 86400
      ? time + refreshExpires * 1000 : (previous?.refreshExpiresAt || time),
  };
}
function safeLink(value, onlyTikTok = false) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 2048) return '';
    if (onlyTikTok && url.hostname !== 'www.tiktok.com' && url.hostname !== 'tiktok.com') return '';
    return url.href;
  } catch (_) { return ''; }
}
function cleanMetric(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function cleanProfile(user, time) {
  const username = typeof user?.username === 'string' && /^[A-Za-z0-9._]{1,32}$/.test(user.username) ? user.username : '';
  return {
    displayName: typeof user?.display_name === 'string' ? user.display_name.slice(0, 100) : '',
    username,
    avatarUrl: safeLink(user?.avatar_url),
    profileUrl: safeLink(user?.profile_deep_link, true),
    bio: typeof user?.bio_description === 'string' ? user.bio_description.slice(0, 300) : '',
    verified: user?.is_verified === true,
    followers: cleanMetric(user?.follower_count),
    following: cleanMetric(user?.following_count),
    likes: cleanMetric(user?.likes_count),
    videos: cleanMetric(user?.video_count),
    updatedAt: time,
  };
}
function exposedProfile(record) {
  if (!record) return null;
  return {
    connected: true,
    profile: record.profile || null,
    statsPermission: String(record.tokens?.scopes || '').split(',').includes('user.info.stats'),
    shared: !!record.shareId,
    shareId: record.shareId || '',
    pollSeconds: POLL_INTERVAL_MS / 1000,
  };
}

function createTikTokService({ env, passwordValid, fetchImpl, now = Date.now }) {
  const settings = tiktokConfiguration(env, passwordValid);
  const pending = new Map();
  const attempted = new Map();
  const refreshStatus = new Map();
  const inflight = new Map();
  const store = settings.ready ? new EncryptedStore(settings.directory, settings.encryptionKey) : null;

  function requireReady() { if (!settings.ready) throw safeError(503, 'TikTok connection is not configured. No TikTok request was sent.'); }
  function sessionHash(cookieHeader) { const token = cookieSession(cookieHeader); return token ? hash(token) : ''; }
  async function provider(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        if (response.body && typeof response.body.cancel === 'function') await response.body.cancel().catch(() => {});
        throw new Error('provider rejected request');
      }
      if (Number(response.headers?.get?.('content-length') || 0) > MAX_RESPONSE_BYTES) {
        if (response.body && typeof response.body.cancel === 'function') await response.body.cancel().catch(() => {});
        throw new Error('response too large');
      }
      let data;
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('response too large'); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      } else {
        const text = await response.text();
        if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('response too large');
        data = JSON.parse(text);
      }
      if (data?.error && data.error.code && data.error.code !== 'ok') throw new Error('provider error');
      if (data?.error && typeof data.error === 'string') throw new Error('provider error');
      return data;
    } catch (_) { throw safeError(502, 'TikTok could not complete the request. Check approval, permissions, or reconnect.'); }
    finally { clearTimeout(timeout); }
  }
  async function tokenRequest(fields) {
    const body = new URLSearchParams({ client_key: settings.clientKey, client_secret: settings.clientSecret, ...fields });
    return provider('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' }, body: body.toString(),
    });
  }
  async function retrieveUser(tokens) {
    const scopes = tokens.scopes.split(',');
    if (!scopes.includes('user.info.basic')) throw safeError(403, 'TikTok profile permission was not granted.');
    const fields = ['open_id', 'display_name', 'avatar_url'];
    if (scopes.includes('user.info.profile')) fields.push('username', 'bio_description', 'profile_deep_link', 'is_verified');
    if (scopes.includes('user.info.stats')) fields.push('follower_count', 'following_count', 'likes_count', 'video_count');
    const data = await provider('https://open.tiktokapis.com/v2/user/info/?fields=' + fields.join(','), {
      method: 'GET', headers: { Authorization: `Bearer ${tokens.access}` },
    });
    if (!data?.data?.user || data.data.user.open_id !== tokens.openId) throw safeError(502, 'TikTok returned an invalid profile.');
    const user = { ...data.data.user };
    if (!scopes.includes('user.info.profile')) for (const field of ['username','bio_description','profile_deep_link','is_verified']) delete user[field];
    if (!scopes.includes('user.info.stats')) for (const field of ['follower_count','following_count','likes_count','video_count']) delete user[field];
    return cleanProfile(user, now());
  }
  function begin(cookieHeader) {
    requireReady();
    const time = now();
    for (const [state, value] of pending) if (time - value.time > STATE_LIFETIME_MS || time < value.time) pending.delete(state);
    if (pending.size >= 1000) throw safeError(429, 'Too many connection attempts. Please try again later.');
    const token = cookieSession(cookieHeader) || randomToken();
    const state = randomToken();
    pending.set(state, { sessionHash: hash(token), time });
    const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
    url.search = new URLSearchParams({ client_key: settings.clientKey, response_type: 'code', scope: 'user.info.basic,user.info.profile,user.info.stats', redirect_uri: settings.redirect, state }).toString();
    return { url: url.href, cookie: sessionCookie(token) };
  }
  async function finish(cookieHeader, state, code) {
    requireReady();
    if (typeof state !== 'string' || typeof code !== 'string' || state.length > 100 || code.length < 1 || code.length > 2048) throw safeError(400, 'TikTok authorization was not completed.');
    const session = sessionHash(cookieHeader);
    const attempt = pending.get(state);
    pending.delete(state); // A callback is usable at most once, even after failure.
    if (!session || !attempt || attempt.sessionHash !== session || now() < attempt.time || now() - attempt.time > STATE_LIFETIME_MS) {
      throw safeError(400, 'TikTok authorization expired or did not match this browser. Please reconnect.');
    }
    const tokenData = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: settings.redirect });
    const tokens = sanitizeToken(tokenData, null, now());
    let profile = null;
    try { profile = await retrieveUser(tokens); } catch (_) {} // Keep the connection; the owner can retry.
    const recordId = await store.update(db => {
      let record = Object.values(db.profiles).find(item => item.tokens?.openId === tokens.openId);
      if (!record && Object.keys(db.profiles).length >= MAX_PROFILES) throw safeError(503, 'This personal preview has reached its profile limit.');
      // One TikTok account per browser session. Reconnecting the same account
      // recovers its share link without exposing another account's data.
      for (const item of Object.values(db.profiles)) if (item.sessionHash === session && item !== record) item.sessionHash = '';
      if (!record) { record = { id: randomToken(18), shareId: '' }; db.profiles[record.id] = record; }
      record.sessionHash = session; record.tokens = tokens;
      // Never retain fields from an older, broader consent after reconnecting.
      record.profile = profile;
      return record.id;
    });
    attempted.delete(recordId); refreshStatus.delete(recordId);
  }
  async function findBySession(cookieHeader) {
    const session = sessionHash(cookieHeader);
    if (!session) return null;
    return store.read(db => Object.values(db.profiles).find(record => record.sessionHash === session) || null);
  }
  async function refresh(id) {
    if (inflight.has(id)) return inflight.get(id);
    const last = attempted.get(id);
    const time = now();
    if (last !== undefined && time >= last && time - last < POLL_INTERVAL_MS) return refreshStatus.get(id);
    attempted.set(id, time);
    const task = (async () => {
      const record = await store.read(db => db.profiles[id] || null);
      if (!record) return false;
      let tokens = record.tokens;
      try {
        if (tokens.accessExpiresAt <= now() + 60_000) {
          if (tokens.refreshExpiresAt <= now()) throw new Error('expired');
          const tokenData = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh });
          const updated = sanitizeToken(tokenData, tokens, now());
          if (updated.openId !== tokens.openId) throw new Error('account mismatch');
          tokens = updated;
          // Persist rotated refresh tokens before attempting another provider call.
          await store.update(db => {
            if (db.profiles[id] && db.profiles[id].tokens.refresh === record.tokens.refresh) db.profiles[id].tokens = tokens;
            return null;
          });
        }
        const profile = await retrieveUser(tokens);
        await store.update(db => {
          if (db.profiles[id] && db.profiles[id].tokens.openId === tokens.openId && db.profiles[id].tokens.access === tokens.access) db.profiles[id].profile = profile;
          return null;
        });
        refreshStatus.set(id, true);
        return true;
      } catch (_) {
        // Do not keep publishing a cached snapshot if authorization might have
        // been revoked. The owner may still see its clearly dated last result.
        refreshStatus.set(id, false);
        return false;
      }
    })();
    inflight.set(id, task);
    try { return await task; } finally { inflight.delete(id); }
  }
  async function mine(cookieHeader, shouldRefresh = false) {
    requireReady();
    let record = await findBySession(cookieHeader);
    if (!record) return { connected: false, pollSeconds: POLL_INTERVAL_MS / 1000 };
    if (shouldRefresh) { await refresh(record.id); record = await findBySession(cookieHeader); }
    const exposed = exposedProfile(record);
    if (exposed) exposed.refreshFailed = refreshStatus.get(record.id) === false;
    return exposed || { connected: false };
  }
  async function share(cookieHeader, enabled) {
    requireReady();
    const session = sessionHash(cookieHeader);
    if (!session) throw safeError(401, 'Connect your TikTok account first.');
    return store.update(db => {
      const record = Object.values(db.profiles).find(item => item.sessionHash === session);
      if (!record) throw safeError(401, 'Connect your TikTok account first.');
      record.shareId = enabled ? (record.shareId || randomToken(18)) : '';
      return exposedProfile(record);
    });
  }
  async function publicProfile(shareId) {
    requireReady();
    if (!/^[A-Za-z0-9_-]{24}$/.test(String(shareId || ''))) throw safeError(404, 'Profile not found.');
    let record = await store.read(db => Object.values(db.profiles).find(item => item.shareId === shareId) || null);
    if (!record) throw safeError(404, 'Profile not found or no longer shared.');
    const refreshed = await refresh(record.id);
    record = await store.read(db => Object.values(db.profiles).find(item => item.shareId === shareId) || null);
    if (!record) throw safeError(404, 'Profile not found or no longer shared.');
    // Hide cached public data if TikTok cannot confirm it: this includes
    // revoked permissions as well as network failures. Never return tokens.
    return { profile: refreshed === false ? null : (record.profile || null), refreshFailed: refreshed === false, statsPermission: String(record.tokens?.scopes || '').split(',').includes('user.info.stats'), pollSeconds: POLL_INTERVAL_MS / 1000 };
  }
  async function disconnect(cookieHeader) {
    requireReady();
    const session = sessionHash(cookieHeader);
    if (!session) return { disconnected: true, revocationFailed: false };
    const record = await store.update(db => {
      const match = Object.values(db.profiles).find(item => item.sessionHash === session);
      if (match) delete db.profiles[match.id];
      return match || null;
    });
    if (!record) return { disconnected: true, revocationFailed: false };
    attempted.delete(record.id); refreshStatus.delete(record.id);
    let revocationFailed = false;
    try {
      const body = new URLSearchParams({ client_key: settings.clientKey, client_secret: settings.clientSecret, token: record.tokens.access });
      await provider('https://open.tiktokapis.com/v2/oauth/revoke/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    } catch (_) { revocationFailed = true; }
    return { disconnected: true, revocationFailed };
  }
  return { ready: settings.ready, begin, finish, mine, share, publicProfile, disconnect, clearSessionCookie };
}

module.exports = { createTikTokService, tiktokConfiguration, cookieSession, cleanProfile, POLL_INTERVAL_MS };
