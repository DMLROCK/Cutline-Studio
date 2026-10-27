'use strict';

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { createServer, MAX_VIDEO_BYTES } = require('../server');

let server;
let baseUrl;

before(async () => {
  server = createServer({ env: {} });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('serves the supplied application at both entry paths', async () => {
  const expected = await readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  // Relative loading also allows a browser-only preview under a subpath.
  assert.match(expected, /<script src="\.\/editor-core\.js"><\/script>/);
  for (const entry of ['/', '/index.html?preview=1']) {
    const response = await fetch(baseUrl + entry);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), expected);
  }
});

test('HEAD returns application headers without a response body', async () => {
  const get = await fetch(baseUrl + '/');
  const head = await fetch(baseUrl + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), get.headers.get('content-length'));
  assert.equal(await head.text(), '');
  await get.arrayBuffer();
});

test('health reports video review as unavailable', async () => {
  const response = await fetch(baseUrl + '/api/health');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const health = await response.json();
  assert.equal(health.videoReviewReady, false);
  assert.equal(health.model, 'gemini-3.8-flash');
  assert.equal(health.maxVideoBytes, MAX_VIDEO_BYTES);
});

test('direct video review requests are rejected without forwarding or echoing the upload', async () => {
  const response = await fetch(baseUrl + '/api/video-review', {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', 'x-clip-consent': 'yes' },
    body: 'private-video-test-content',
  });
  assert.equal(response.status, 503);
  const data = await response.json();
  assert.match(data.error, /not configured/i);
  assert.doesNotMatch(JSON.stringify(data), /private-video-test-content/);
});

test('rejects unsupported methods with an Allow header', async () => {
  for (const [entry, method, allowed] of [
    ['/', 'POST', 'GET, HEAD'],
    ['/api/health', 'POST', 'GET, HEAD'],
    ['/api/video-review', 'GET', 'POST'],
  ]) {
    const response = await fetch(baseUrl + entry, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), allowed);
  }
});

test('does not expose repository or configuration files', async () => {
  for (const entry of ['/server.js', '/package.json', '/.env', '/missing', '/%2e%2e/server.js']) {
    const response = await fetch(baseUrl + entry);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found.' });
  }
});

test('the start command honors HOST and PORT from a different working directory', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: os.tmpdir(),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', CUTLINE_AI_ENABLED: 'false', GEMINI_API_KEY: '', CUTLINE_ACCESS_PASSWORD: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const output = await Promise.race([
    once(child.stdout, 'data').then(([data]) => data.toString()),
    once(child, 'error').then(([error]) => { throw error; }),
    once(child, 'exit').then(([code]) => { throw new Error(`Server exited before listening (${code}).`); }),
  ]);
  const match = output.match(/127\.0\.0\.1:(\d+)/);
  assert.ok(match, `Unexpected server output: ${output}`);
  const response = await fetch(`http://127.0.0.1:${match[1]}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Cutline Studio/);
  const exited = once(child, 'exit');
  child.kill();
  await exited;
});

test('the start command fails clearly for an invalid PORT', () => {
  const child = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: 'not-a-port' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /PORT must be an integer/);
});

test('starting with a key but no password disables AI without logging the key', { timeout: 10000 }, async t => {
  const fakeKey = 'fake-key-for-logging-test';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', CUTLINE_AI_ENABLED: 'true', GEMINI_API_KEY: fakeKey, CUTLINE_ACCESS_PASSWORD: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const [stdout, stderr] = await Promise.all([once(child.stdout, 'data'), once(child.stderr, 'data')]);
  const logs = stdout[0].toString() + stderr[0].toString();
  assert.match(logs, /video AI off/i);
  assert.match(logs, /until a valid access password/i);
  assert.doesNotMatch(logs, new RegExp(fakeKey));
  const exited = once(child, 'exit');
  child.kill();
  await exited;
});

test('startup logs do not expose a configured password or API key', { timeout: 10000 }, async t => {
  const fakeKey = 'fake-key-for-logging-test';
  const fakePassword = 'test-password-for-logging-42';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', CUTLINE_AI_ENABLED: 'true', GEMINI_API_KEY: fakeKey, CUTLINE_ACCESS_PASSWORD: fakePassword },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const [stdout, stderr] = await Promise.all([once(child.stdout, 'data'), once(child.stderr, 'data')]);
  const logs = stdout[0].toString() + stderr[0].toString();
  assert.match(logs, /access protected; video AI configured/i);
  assert.match(logs, /personal testing only/i);
  assert.doesNotMatch(logs, new RegExp(fakeKey));
  assert.doesNotMatch(logs, new RegExp(fakePassword));
  const exited = once(child, 'exit');
  child.kill();
  await exited;
});
