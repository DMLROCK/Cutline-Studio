'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, MAX_VIDEO_BYTES } = require('../server');

const TEST_KEY = 'test-only-fake-key';
const TEST_PASSWORD = 'test-only-long-password-42';
const AUTH = `Basic ${Buffer.from(`cutline:${TEST_PASSWORD}`).toString('base64')}`;
const ENABLED_ENV = {
  CUTLINE_AI_ENABLED: 'true', GEMINI_API_KEY: TEST_KEY, CUTLINE_ACCESS_PASSWORD: TEST_PASSWORD,
};

function authenticatedFetch(url) {
  return fetch(url, { headers: { Authorization: AUTH } });
}

async function start(t, options = {}) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

function review(baseUrl, options = {}) {
  const headers = {
    Authorization: AUTH,
    Origin: baseUrl,
    'Content-Type': 'video/webm',
    'X-Clip-Consent': 'yes',
    ...options.headers,
  };
  for (const [key, value] of Object.entries(headers)) if (value === undefined) delete headers[key];
  return fetch(baseUrl + '/api/video-review', {
    method: 'POST',
    headers,
    body: options.body === undefined ? 'synthetic-test-video' : options.body,
  });
}

function successfulProviderResponse(text = 'Sample model review') {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('AI stays disabled unless the flag, nonblank key and valid access password are present', async t => {
  let providerCalls = 0;
  for (const env of [
    {},
    { CUTLINE_AI_ENABLED: 'true' },
    { CUTLINE_AI_ENABLED: 'false', GEMINI_API_KEY: TEST_KEY },
    { CUTLINE_AI_ENABLED: 'true', GEMINI_API_KEY: '  ' },
    { CUTLINE_AI_ENABLED: 'true', GEMINI_API_KEY: TEST_KEY },
    { CUTLINE_ACCESS_PASSWORD: TEST_PASSWORD, CUTLINE_AI_ENABLED: 'true' },
    { CUTLINE_ACCESS_PASSWORD: TEST_PASSWORD, CUTLINE_AI_ENABLED: 'false', GEMINI_API_KEY: TEST_KEY },
  ]) {
    const baseUrl = await start(t, { env, fetchImpl: async () => { providerCalls++; throw new Error('must not be called'); } });
    const health = await (await authenticatedFetch(baseUrl + '/api/health')).json();
    assert.equal(health.videoReviewReady, false);
    assert.equal((await review(baseUrl)).status, 503);
  }
  assert.equal(providerCalls, 0);
});

test('health reports configuration, size limit and model without exposing the API key', async t => {
  const baseUrl = await start(t, { env: { ...ENABLED_ENV, GEMINI_MODEL: 'gemini-3.6-flash' } });
  const healthText = await (await authenticatedFetch(baseUrl + '/api/health')).text();
  const health = JSON.parse(healthText);
  assert.equal(health.videoReviewReady, true);
  assert.equal(health.model, 'gemini-3.6-flash');
  assert.equal(health.maxVideoBytes, MAX_VIDEO_BYTES);
  assert.match(health.message, /not been connection-tested/i);
  assert.doesNotMatch(healthText, /test-only-fake-key/);
  assert.doesNotMatch(await (await authenticatedFetch(baseUrl + '/')).text(), /test-only-fake-key/);
});

test('unsafe model names fall back to the default rather than entering the provider URL', async t => {
  let providerUrl;
  const baseUrl = await start(t, {
    env: { ...ENABLED_ENV, GEMINI_MODEL: '../../not-a-model?key=secret' },
    fetchImpl: async url => { providerUrl = url; return successfulProviderResponse(); },
  });
  const health = await (await authenticatedFetch(baseUrl + '/api/health')).json();
  assert.equal(health.model, 'gemini-3.8-flash');
  assert.equal((await review(baseUrl)).status, 200);
  assert.equal(providerUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
});

test('rejects missing or mismatched origin, missing consent and unsupported types before contacting Gemini', async t => {
  let providerCalls = 0;
  const baseUrl = await start(t, { env: ENABLED_ENV, fetchImpl: async () => { providerCalls++; return successfulProviderResponse(); } });
  assert.equal((await review(baseUrl, { headers: { Origin: undefined } })).status, 403);
  assert.equal((await review(baseUrl, { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await review(baseUrl, { headers: { 'X-Clip-Consent': undefined } })).status, 400);
  assert.equal((await review(baseUrl, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(providerCalls, 0);
});

test('a confirmed clip is sent to Gemini with its MIME type and bounded focus, then the review is returned', async t => {
  const calls = [];
  const focus = '🏀 ' + 'a'.repeat(600);
  const video = Buffer.from('synthetic-test-video');
  const baseUrl = await start(t, {
    env: ENABLED_ENV,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return successfulProviderResponse('Opening hook\n\nEditing suggestion'); },
  });
  const response = await review(baseUrl, {
    body: video,
    headers: { 'Content-Type': 'video/mp4', 'X-Review-Focus': Buffer.from(focus).toString('base64') },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'Opening hook\n\nEditing suggestion', model: 'gemini-3.8-flash' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(calls[0].options.headers['x-goog-api-key'], TEST_KEY);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.contents[0].parts[0].inline_data.mime_type, 'video/mp4');
  assert.deepEqual(Buffer.from(payload.contents[0].parts[0].inline_data.data, 'base64'), video);
  assert.ok(payload.contents[0].parts[1].text.endsWith('Creator focus: ' + focus.slice(0, 500)));
});

test('accepts the forwarded preview host for browser origin checks', async t => {
  const baseUrl = await start(t, { env: ENABLED_ENV, fetchImpl: async () => successfulProviderResponse() });
  const response = await review(baseUrl, { headers: { Origin: 'https://preview.example', 'X-Forwarded-Host': 'preview.example' } });
  assert.equal(response.status, 200);
});

test('cooldown uses the socket peer and cannot be bypassed by changing X-Forwarded-For', async t => {
  let providerCalls = 0;
  let clock = 10_000;
  const baseUrl = await start(t, {
    env: ENABLED_ENV,
    now: () => clock,
    fetchImpl: async () => { providerCalls++; return successfulProviderResponse(); },
  });
  assert.equal((await review(baseUrl, { headers: { 'X-Forwarded-For': '192.0.2.1' } })).status, 200);
  const limited = await review(baseUrl, { headers: { 'X-Forwarded-For': '192.0.2.2' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '30');
  assert.equal(providerCalls, 1);
  clock += 30_000;
  assert.equal((await review(baseUrl)).status, 200);
  assert.equal(providerCalls, 2);
});

test('allows only one video review at a time and releases the slot afterward', { timeout: 10000 }, async t => {
  let providerCalls = 0;
  let clock = 100_000;
  let markStarted;
  let release;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const baseUrl = await start(t, {
    env: ENABLED_ENV,
    now: () => clock,
    fetchImpl: async () => {
      providerCalls++;
      if (providerCalls === 1) {
        markStarted();
        await gate;
      }
      return successfulProviderResponse();
    },
  });
  const first = review(baseUrl);
  await started;
  clock += 30_000; // Ensure this response is due to concurrency, not cooldown.
  const second = await review(baseUrl);
  assert.equal(second.status, 429);
  assert.match((await second.json()).error, /another video review is in progress/i);
  assert.equal(providerCalls, 1);
  release();
  assert.equal((await first).status, 200);
  clock += 30_000;
  assert.equal((await review(baseUrl)).status, 200);
  assert.equal(providerCalls, 2);
});

test('rejects a declared oversized upload before contacting the provider', async t => {
  let providerCalls = 0;
  const baseUrl = await start(t, { env: ENABLED_ENV, fetchImpl: async () => { providerCalls++; return successfulProviderResponse(); } });
  const result = await new Promise((resolve, reject) => {
    const request = http.request(baseUrl + '/api/video-review', {
      method: 'POST',
      headers: {
        Authorization: AUTH,
        Origin: baseUrl,
        'Content-Type': 'video/mp4',
        'X-Clip-Consent': 'yes',
        'Content-Length': MAX_VIDEO_BYTES + 1,
      },
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end('x');
  });
  assert.equal(result, 413);
  assert.equal(providerCalls, 0);
});

test('rejects oversized chunked uploads without forwarding them', async t => {
  let providerCalls = 0;
  const baseUrl = await start(t, { env: ENABLED_ENV, fetchImpl: async () => { providerCalls++; return successfulProviderResponse(); } });
  const result = await new Promise((resolve, reject) => {
    const request = http.request(baseUrl + '/api/video-review', {
      method: 'POST',
      headers: { Authorization: AUTH, Origin: baseUrl, 'Content-Type': 'video/webm', 'X-Clip-Consent': 'yes' },
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.write(Buffer.alloc(MAX_VIDEO_BYTES));
    request.end(Buffer.from('one-byte-too-many'));
  });
  assert.equal(result, 413);
  assert.equal(providerCalls, 0);
});

test('an empty clip never contacts the provider and releases the review slot', async t => {
  let providerCalls = 0;
  let clock = 100_000;
  const baseUrl = await start(t, {
    env: ENABLED_ENV,
    now: () => clock,
    fetchImpl: async () => { providerCalls++; return successfulProviderResponse(); },
  });
  const response = await review(baseUrl, { body: '' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /empty/i);
  assert.equal(providerCalls, 0);
  clock += 30_000;
  assert.equal((await review(baseUrl)).status, 200);
  assert.equal(providerCalls, 1);
});

test('sanitizes provider failures and handles rate limits, empty replies and timeouts', async t => {
  let clock = 100_000;
  let mode = 'rate-limit';
  const baseUrl = await start(t, {
    env: ENABLED_ENV,
    now: () => clock,
    fetchImpl: async () => {
      if (mode === 'rate-limit') return new Response(JSON.stringify({ error: { message: TEST_KEY } }), { status: 429 });
      if (mode === 'provider-error') return new Response(JSON.stringify({ error: { message: TEST_KEY } }), { status: 400 });
      if (mode === 'empty') return new Response('{}', { status: 200 });
      const error = new Error('provider timed out');
      error.name = 'AbortError';
      throw error;
    },
  });
  for (const [nextMode, expectedStatus] of [['rate-limit', 429], ['provider-error', 502], ['empty', 502], ['timeout', 504]]) {
    mode = nextMode;
    const response = await review(baseUrl);
    assert.equal(response.status, expectedStatus);
    const data = await response.text();
    assert.doesNotMatch(data, /test-only-fake-key/);
    clock += 30_000;
  }
});
