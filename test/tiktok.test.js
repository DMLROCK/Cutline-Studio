'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server');
const { tiktokConfiguration } = require('../tiktok');

const PASSWORD = 'test-only-cutline-password';
const AUTH = 'Basic ' + Buffer.from('cutline:' + PASSWORD).toString('base64');
const KEY = 'ab'.repeat(32);
const CLIENT_SECRET = 'test-only-tiktok-client-secret';
const ACCESS = 'test-only-access-token';
const REFRESH = 'test-only-refresh-token';
const ROTATED_ACCESS = 'test-only-rotated-access';
const ROTATED_REFRESH = 'test-only-rotated-refresh';

function environment(directory) {
  return { CUTLINE_ACCESS_PASSWORD: PASSWORD, CUTLINE_TIKTOK_ENABLED: 'true', TIKTOK_CLIENT_KEY: 'test-client-key', TIKTOK_CLIENT_SECRET: CLIENT_SECRET, TIKTOK_REDIRECT_URI: 'https://studio.example/api/tiktok/callback', CUTLINE_TIKTOK_ENCRYPTION_KEY: KEY, CUTLINE_TIKTOK_DATA_DIR: directory };
}
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type':'application/json' } }); }
function fakeProvider(options = {}) {
  const calls = [];
  const provider = async (url, request) => {
    calls.push({ url, request });
    if (url.includes('/oauth/token/')) {
      const form = new URLSearchParams(request.body);
      if (form.get('grant_type') === 'refresh_token') return json({ access_token: ROTATED_ACCESS, refresh_token: ROTATED_REFRESH, open_id:'creator-id', scope:options.scopes || 'user.info.basic,user.info.profile,user.info.stats', expires_in:86400, refresh_expires_in:31536000 });
      return json({ access_token:ACCESS, refresh_token:REFRESH, open_id:'creator-id', scope:options.scopes || 'user.info.basic,user.info.profile,user.info.stats', expires_in:86400, refresh_expires_in:31536000 });
    }
    if (url.includes('/user/info/')) {
      if (options.onUser) options.onUser();
      if (options.userGate) await options.userGate;
      if (options.failUser) return json({ error:{ code:'access_token_invalid' } }, 401);
      return json({ data:{ user:{ open_id:'creator-id', display_name:'Sports Creator', username:'sportscreator', avatar_url:'https://images.example/avatar.jpg', bio_description:'My edit page', profile_deep_link:'https://www.tiktok.com/@sportscreator', is_verified:false, follower_count:12345, following_count:12, likes_count:67890, video_count:33 } }, error:{ code:'ok' } });
    }
    if (url.includes('/oauth/revoke/')) return options.failRevoke ? json({error:'offline'}, 500) : json({});
    throw new Error('Unexpected provider endpoint');
  };
  return { provider, calls, options };
}
async function runServer(t, env, provider, clock = () => Date.now()) {
  const server = createServer({ env, fetchImpl:provider, now:clock });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}
async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cutline-tiktok-test-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  return dir;
}
function headers(base, cookie) { return { Authorization:AUTH, Origin:base, 'X-Cutline-Tiktok':'yes', ...(cookie ? { Cookie:cookie } : {}) }; }
async function begin(base) {
  const response = await fetch(base + '/api/tiktok/connect', { method:'POST', headers:headers(base) });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie.split(';')[0];
  const { url } = await response.json();
  return { cookie, setCookie, url:new URL(url) };
}
async function finish(base, attempt, code = 'creator-code') {
  return fetch(base + '/api/tiktok/callback?state=' + encodeURIComponent(attempt.url.searchParams.get('state')) + '&code=' + encodeURIComponent(code), { headers:{ Authorization:AUTH, Cookie:attempt.cookie }, redirect:'manual' });
}
async function mine(base, cookie) { return fetch(base + '/api/tiktok/profile', { headers:{ Authorization:AUTH, ...(cookie ? { Cookie:cookie } : {}) } }); }
async function share(base, cookie, enabled) {
  return fetch(base + '/api/tiktok/share', { method:'POST', headers:{ ...headers(base, cookie), 'Content-Type':'application/json' }, body:JSON.stringify({ share:enabled }) });
}

test('TikTok setup fails closed without a strong password, approved HTTPS callback, private volume and 32-byte key', async t => {
  const dir = await tempDir(t), good = environment(dir);
  assert.equal(tiktokConfiguration(good, true).ready, true);
  for (const override of [
    { CUTLINE_TIKTOK_ENABLED:'false' }, { TIKTOK_CLIENT_SECRET:'' }, { CUTLINE_TIKTOK_ENCRYPTION_KEY:'short' },
    { TIKTOK_REDIRECT_URI:'http://studio.example/api/tiktok/callback' }, { TIKTOK_REDIRECT_URI:'https://studio.example/api/tiktok/callback?bad=1' },
    { CUTLINE_TIKTOK_DATA_DIR:'relative' }, { CUTLINE_TIKTOK_DATA_DIR:path.join(__dirname, '..', 'data') },
  ]) assert.equal(tiktokConfiguration({ ...good, ...override }, true).ready, false);
  assert.equal(tiktokConfiguration(good, false).ready, false);
  const { provider, calls } = fakeProvider();
  const base = await runServer(t, { ...good, CUTLINE_ACCESS_PASSWORD:undefined }, provider);
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.tiktokReady, false);
  assert.equal((await fetch(base + '/api/tiktok/connect', { method:'POST', headers:headers(base) })).status, 503);
  assert.equal((await fetch(base + '/p/' + 'a'.repeat(24))).status, 404);
  assert.equal(calls.length, 0);
});

test('OAuth is bound to a secure host-only browser session and rejects forged or replayed state before token exchange', async t => {
  const dir = await tempDir(t), fake = fakeProvider();
  const base = await runServer(t, environment(dir), fake.provider);
  assert.equal((await fetch(base + '/api/tiktok/connect', { method:'POST' })).status, 401);
  assert.equal((await fetch(base + '/api/tiktok/connect', { method:'POST', headers:{ Authorization:AUTH, Origin:'https://evil.example', 'X-Cutline-Tiktok':'yes' } })).status, 403);
  assert.equal((await fetch(base + '/api/tiktok/connect', { method:'POST', headers:{ Authorization:AUTH, Origin:base } })).status, 403);
  const attempt = await begin(base);
  assert.match(attempt.setCookie, /^__Host-cutline_tiktok_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  assert.equal(attempt.url.origin, 'https://www.tiktok.com');
  assert.equal(attempt.url.pathname, '/v2/auth/authorize/');
  assert.equal(attempt.url.searchParams.get('scope'), 'user.info.basic,user.info.profile,user.info.stats');
  assert.equal(attempt.url.searchParams.get('redirect_uri'), 'https://studio.example/api/tiktok/callback');
  assert.ok(attempt.url.searchParams.get('state').length >= 40);
  assert.equal((await fetch(base + '/api/tiktok/callback?state=wrong&code=hello', { headers:{ Authorization:AUTH, Cookie:attempt.cookie }, redirect:'manual' })).headers.get('location'), '/?tiktok=error');
  assert.equal(fake.calls.length, 0);
  const success = await finish(base, attempt);
  assert.equal(success.status, 303); assert.equal(success.headers.get('location'), '/?tiktok=connected');
  assert.equal(success.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(fake.calls.length, 2);
  assert.equal((await finish(base, attempt)).headers.get('location'), '/?tiktok=error');
  assert.equal(fake.calls.length, 2);
  const second = await begin(base);
  const mismatched = await fetch(base + '/api/tiktok/callback?state=' + second.url.searchParams.get('state') + '&code=hello', { headers:{ Authorization:AUTH, Cookie:attempt.cookie }, redirect:'manual' });
  assert.equal(mismatched.headers.get('location'), '/?tiktok=error');
  assert.equal(fake.calls.length, 2);
  const text = await (await mine(base, attempt.cookie)).text();
  assert.doesNotMatch(text, /test-only-access-token|test-only-refresh-token|test-only-tiktok-client-secret|creator-id/);
  assert.equal(JSON.parse(text).profile.followers, 12345);
  assert.equal((await (await mine(base)).json()).connected, false);
  const disk = await fs.readFile(path.join(dir, 'cutline-tiktok-profiles.enc'), 'utf8');
  for (const secret of [ACCESS, REFRESH, CLIENT_SECRET, 'creator-id', 'Sports Creator']) assert.equal(disk.includes(secret), false);
  assert.equal((await fs.stat(path.join(dir, 'cutline-tiktok-profiles.enc'))).mode & 0o077, 0);
});

test('sharing is explicit, public data is sanitized, refreshes are limited and links are revocable', async t => {
  const dir = await tempDir(t), fake = fakeProvider(); let time = 1_800_000_000_000;
  const base = await runServer(t, environment(dir), fake.provider, () => time);
  const attempt = await begin(base); await finish(base, attempt);
  const original = await (await mine(base, attempt.cookie)).json();
  assert.equal(original.shared, false); assert.equal(original.shareId, '');
  assert.equal((await share(base, null, true)).status, 401);
  assert.equal((await fetch(base + '/api/tiktok/share', { method:'POST', headers:{ ...headers(base, attempt.cookie), Origin:'https://evil.example', 'Content-Type':'application/json' }, body:'{"share":true}' })).status, 403);
  const published = await (await share(base, attempt.cookie, true)).json();
  assert.equal(published.shared, true); assert.match(published.shareId, /^[A-Za-z0-9_-]{24}$/);
  const page = await fetch(base + '/p/' + published.shareId); // No Basic auth.
  assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const result = await fetch(base + '/api/public-profile/' + published.shareId);
  assert.equal(result.status, 200);
  const publicText = await result.text(), publicData = JSON.parse(publicText);
  assert.equal(publicData.profile.followers, 12345); assert.equal(publicData.profile.likes, 67890);
  assert.doesNotMatch(publicText, /test-only-access-token|test-only-refresh-token|creator-id|sessionHash|shareId/);
  const before = fake.calls.filter(item => item.url.includes('/user/info/')).length;
  await fetch(base + '/api/public-profile/' + published.shareId);
  assert.equal(fake.calls.filter(item => item.url.includes('/user/info/')).length, before);
  time += 60_001; fake.options.failUser = true;
  const hidden = await (await fetch(base + '/api/public-profile/' + published.shareId)).json();
  assert.equal(hidden.profile, null); assert.equal(hidden.refreshFailed, true);
  const owner = await (await mine(base, attempt.cookie)).json();
  assert.equal(owner.profile.followers, 12345); assert.equal(owner.refreshFailed, true);
  time += 60_001; fake.options.failUser = false;
  const restored = await (await fetch(base + '/api/public-profile/' + published.shareId)).json();
  assert.equal(restored.profile.followers, 12345);
  await share(base, attempt.cookie, false);
  assert.equal((await fetch(base + '/api/public-profile/' + published.shareId)).status, 404);
  const republished = await (await share(base, attempt.cookie, true)).json();
  assert.notEqual(republished.shareId, published.shareId);
});

test('expired OAuth state is rejected without contacting TikTok', async t => {
  const dir = await tempDir(t), fake = fakeProvider(); let time = 1_800_000_000_000;
  const base = await runServer(t, environment(dir), fake.provider, () => time);
  const attempt = await begin(base); time += 10 * 60_000 + 1;
  assert.equal((await finish(base, attempt)).headers.get('location'), '/?tiktok=error');
  assert.equal(fake.calls.length, 0);
  assert.equal((await (await mine(base, attempt.cookie)).json()).connected, false);
});

test('simultaneous public visits coalesce into a single TikTok refresh', { timeout:5000 }, async t => {
  const dir = await tempDir(t), fake = fakeProvider(); let time = 1_800_000_000_000;
  const base = await runServer(t, environment(dir), fake.provider, () => time);
  const attempt = await begin(base); await finish(base, attempt);
  const published = await (await share(base, attempt.cookie, true)).json();
  let release, seen; fake.options.userGate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { seen = resolve; }); fake.options.onUser = seen;
  const before = fake.calls.filter(call => call.url.includes('/user/info/')).length;
  const requests = Array.from({ length:12 }, () => fetch(base + '/api/public-profile/' + published.shareId));
  await started;
  assert.equal(fake.calls.filter(call => call.url.includes('/user/info/')).length, before + 1);
  release();
  const responses = await Promise.all(requests);
  assert.ok(responses.every(item => item.status === 200));
  assert.equal(fake.calls.filter(call => call.url.includes('/user/info/')).length, before + 1);
});

test('encrypted account state survives a restart, rotates tokens, and fails closed with the wrong key', async t => {
  const dir = await tempDir(t), fake = fakeProvider(); let time = 1_800_000_000_000;
  const env = environment(dir), base = await runServer(t, env, fake.provider, () => time);
  const attempt = await begin(base); await finish(base, attempt);
  const published = await (await share(base, attempt.cookie, true)).json();
  const restarted = await runServer(t, env, fake.provider, () => time);
  assert.equal((await (await mine(restarted, attempt.cookie)).json()).shareId, published.shareId);
  time += 24 * 60 * 60 * 1000;
  const refreshed = await fetch(restarted + '/api/tiktok/refresh', { method:'POST', headers:headers(restarted, attempt.cookie) });
  assert.equal(refreshed.status, 200); assert.equal((await refreshed.json()).profile.followers, 12345);
  const rotation = fake.calls.find(call => call.url.includes('/oauth/token/') && new URLSearchParams(call.request.body).get('grant_type') === 'refresh_token');
  assert.ok(rotation); assert.equal(new URLSearchParams(rotation.request.body).get('refresh_token'), REFRESH);
  assert.equal(fake.calls.filter(call => call.url.includes('/user/info/')).at(-1).request.headers.Authorization, 'Bearer ' + ROTATED_ACCESS);
  const disk = await fs.readFile(path.join(dir, 'cutline-tiktok-profiles.enc'), 'utf8');
  assert.doesNotMatch(disk, /test-only-rotated-access|test-only-rotated-refresh/);
  const wrong = await runServer(t, { ...env, CUTLINE_TIKTOK_ENCRYPTION_KEY:'cd'.repeat(32) }, fake.provider, () => time);
  const inaccessible = await mine(wrong, attempt.cookie);
  assert.equal(inaccessible.status, 503);
  assert.equal(await fs.readFile(path.join(dir, 'cutline-tiktok-profiles.enc'), 'utf8'), disk);
});

test('partial consent leaves unknown statistics blank and disconnect deletes local data even if revocation fails', async t => {
  const dir = await tempDir(t), fake = fakeProvider({ scopes:'user.info.basic', failRevoke:true });
  const base = await runServer(t, environment(dir), fake.provider);
  const attempt = await begin(base); await finish(base, attempt);
  const infoCall = fake.calls.find(call => call.url.includes('/user/info/'));
  assert.doesNotMatch(infoCall.url, /follower_count|username/);
  // A malicious provider returning extra fields must not be displayed without consent.
  const profile = await (await mine(base, attempt.cookie)).json();
  assert.equal(profile.statsPermission, false);
  assert.equal(profile.profile.followers, null);
  assert.equal(profile.profile.username, '');
  const published = await (await share(base, attempt.cookie, true)).json();
  const disconnected = await (await fetch(base + '/api/tiktok/disconnect', { method:'POST', headers:headers(base, attempt.cookie) })).json();
  assert.equal(disconnected.disconnected, true); assert.equal(disconnected.revocationFailed, true);
  assert.equal((await fetch(base + '/api/public-profile/' + published.shareId)).status, 404);
  assert.equal((await (await mine(base, attempt.cookie)).json()).connected, false);
});
