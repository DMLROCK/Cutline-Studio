'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

const TEST_PASSWORD = 'test-only-preview-password-42';
const TEST_KEY = 'test-only-provider-key';
const basic = (username, password) => `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
const AUTH = basic('cutline', TEST_PASSWORD);
const ENV = { CUTLINE_ACCESS_PASSWORD: TEST_PASSWORD, CUTLINE_AI_ENABLED: 'true', GEMINI_API_KEY: TEST_KEY };

async function start(t, options = {}) {
  const server = createServer({ env: ENV, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

function providerResponse() {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Mock review' }] } }] }), { status: 200 });
}

test('all routes challenge anonymous requests before serving content or invoking AI', async t => {
  let calls = 0;
  const base = await start(t, { fetchImpl: async () => { calls++; return providerResponse(); } });
  for (const [method, route] of [
    ['GET', '/'], ['HEAD', '/'], ['GET', '/index.html?x=1'], ['GET', '/editor-core.js'], ['GET', '/api/health'],
    ['GET', '/server.js'], ['GET', '/missing'], ['GET', '/api/video-review'],
    ['POST', '/api/video-review'], ['POST', '/'],
  ]) {
    const response = await fetch(base + route, {
      method,
      headers: { Origin: base, 'Content-Type': 'video/webm', 'X-Clip-Consent': 'yes' },
      ...(method === 'POST' ? { body: 'private-test-video' } : {}),
    });
    assert.equal(response.status, 401, `${method} ${route}`);
    assert.match(response.headers.get('www-authenticate'), /^Basic realm="Cutline Studio"/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
    const text = await response.text();
    assert.doesNotMatch(text, /private-test-video|test-only-provider-key|test-only-preview-password-42/);
  }
  assert.equal(calls, 0);
});

test('correct credentials grant access, while wrong or malformed credentials do not', async t => {
  let calls = 0;
  const base = await start(t, { fetchImpl: async () => { calls++; return providerResponse(); } });
  for (const header of [basic('wrong-user', TEST_PASSWORD), basic('cutline', 'incorrect-password'), 'Bearer anything', 'Basic !!!!']) {
    const response = await fetch(base + '/', { headers: { Authorization: header } });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /^Basic /);
  }
  const home = await fetch(base + '/', { headers: { Authorization: AUTH } });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Cutline Studio/);
  assert.doesNotMatch(html, /test-only-provider-key|test-only-preview-password-42/);
  const healthResponse = await fetch(base + '/api/health', { headers: { Authorization: AUTH } });
  const healthText = await healthResponse.text();
  assert.equal(healthResponse.status, 200);
  assert.equal(JSON.parse(healthText).videoReviewReady, true);
  assert.doesNotMatch(healthText, /test-only-provider-key|test-only-preview-password-42/);
  const core = await fetch(base + '/editor-core.js', { headers: { Authorization: AUTH } });
  assert.equal(core.status, 200);
  assert.match(core.headers.get('content-type'), /javascript/);
  assert.match(await core.text(), /CutlineEditorCore/);
  assert.equal((await fetch(base + '/editor-core.js', { method:'POST', headers: { Authorization: AUTH } })).status, 405);
  assert.equal((await fetch(base + '/server.js', { headers: { Authorization: AUTH } })).status, 404);
  const response = await fetch(base + '/api/video-review', {
    method: 'POST',
    headers: { Authorization: AUTH, Origin: base, 'Content-Type': 'video/webm', 'X-Clip-Consent': 'yes' },
    body: 'synthetic-test-video',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, 'Mock review');
  assert.equal(calls, 1);
});

test('UTF-8 passwords and colons are supported by Basic authentication', async t => {
  const password = 'test-only-🔑:long-password';
  const base = await start(t, { env: { CUTLINE_ACCESS_PASSWORD: password } });
  const response = await fetch(base + '/', { headers: { Authorization: basic('cutline', password) } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('www-authenticate') || '', /^$/);
});

test('invalid configured passwords fail closed for every route and never enable AI', async t => {
  let calls = 0;
  for (const password of ['', 'too-short', ' '.repeat(16), 'a'.repeat(257), 'a'.repeat(15) + '\n', '🔑'.repeat(8)]) {
    const base = await start(t, {
      env: { ...ENV, CUTLINE_ACCESS_PASSWORD: password },
      fetchImpl: async () => { calls++; return providerResponse(); },
    });
    for (const [method, route] of [['GET', '/'], ['GET', '/api/health'], ['POST', '/api/video-review']]) {
      const response = await fetch(base + route, {
        method,
        headers: { Authorization: basic('cutline', password), Origin: base, 'Content-Type': 'video/webm', 'X-Clip-Consent': 'yes' },
        ...(method === 'POST' ? { body: 'synthetic-test-video' } : {}),
      });
      assert.equal(response.status, 503, `password ${JSON.stringify(password)}, route ${route}`);
      assert.equal(response.headers.get('www-authenticate'), null);
      assert.match((await response.json()).error, /misconfigured/i);
    }
  }
  assert.equal(calls, 0);
});

test('failed logins are throttled by socket peer until the time window expires', async t => {
  let clock = 100_000;
  const base = await start(t, { now: () => clock });
  // Anonymous visits still get the browser prompt rather than filling the limit.
  for (let i = 0; i < 8; i++) assert.equal((await fetch(base + '/')).status, 401);
  for (let i = 0; i < 5; i++) {
    const response = await fetch(base + '/', { headers: { Authorization: basic('cutline', 'incorrect'), 'X-Forwarded-For': `192.0.2.${i}` } });
    assert.equal(response.status, 401);
  }
  const limited = await fetch(base + '/', { headers: { Authorization: basic('cutline', 'incorrect'), 'X-Forwarded-For': '192.0.2.99' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  // Even a correct guess must be blocked while the peer is throttled; otherwise
  // returning 429 only on wrong guesses would not slow down guessing at all.
  assert.equal((await fetch(base + '/', { headers: { Authorization: AUTH } })).status, 429);
  clock += 60_000;
  assert.equal((await fetch(base + '/', { headers: { Authorization: AUTH } })).status, 200);
  assert.equal((await fetch(base + '/', { headers: { Authorization: basic('cutline', 'incorrect') } })).status, 401);
});
