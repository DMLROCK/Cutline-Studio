'use strict';
// Optional browser regression with mocked providers; no real API calls are made.
// Requires puppeteer-core and CHROME_PATH. See README.md.
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const { createServer } = require('../server');

const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('Set CHROME_PATH to a Chromium/Chrome executable.');
const password = 'browser-test-password-42';
const youtube = 'https://www.youtube.com/watch?v=9hE5-98ZeCg';
const arena = { CUTLINE_ARENA_ENABLED:'true', ARENA_API_KEY:'mock-arena-key', ARENA_MODEL:'approved/model' };
const gemini = { CUTLINE_AI_ENABLED:'true', GEMINI_API_KEY:'mock-google-key' };

async function start(env) {
  const requests = [];
  let clock = 100000;
  const server = createServer({
    env: { CUTLINE_ACCESS_PASSWORD:password, ...env },
    now: () => { clock += 6000; return clock; },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (url.includes('arena.ai')) {
        return new Response(JSON.stringify({ choices:[{ message:{ content:JSON.stringify({answer:'Mock Arena creative idea.'}) } }] }), {status:200});
      }
      return new Response(JSON.stringify({ candidates:[{ content:{ parts:[{ text:JSON.stringify({answer:'Mock Gemini video summary.', clips:[]}) }] } }] }), {status:200});
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, base:`http://127.0.0.1:${server.address().port}` };
}
async function close(server) { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
async function set(page, id, value, event = 'input') {
  await page.evaluate(({id,value,event}) => {
    const el = document.getElementById(id);
    if (el.type === 'checkbox') el.checked = value; else el.value = value;
    el.dispatchEvent(new Event(event, {bubbles:true}));
  }, {id,value,event});
}
async function open(browser, base, width = 390, blockHealth = false) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.setViewport({width, height:844});
  await page.authenticate({username:'cutline', password});
  if (blockHealth) {
    await page.setRequestInterception(true);
    page.on('request', request => request.url().endsWith('/api/health') ? request.respond({status:404}) : request.continue());
  }
  await page.goto(base, {waitUntil:'networkidle0'});
  await page.click('.mobile-nav [data-view="coach"]');
  return {page, errors};
}
async function read(page, id) {
  return page.$eval('#' + id, el => ({value:el.value, checked:el.checked, disabled:el.disabled, hidden:el.hidden, text:el.textContent}));
}

async function main() {
  const browser = await puppeteer.launch({executablePath:chrome, headless:true, args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    const both = await start({...arena, ...gemini});
    try {
      const {page, errors} = await open(browser, both.base);
      await page.waitForFunction(() => !document.querySelector('#coach-test').disabled);
      assert.equal((await read(page, 'coach-engine')).value, 'arena');
      assert.match((await read(page, 'coach-ai-badge')).text, /ARENA TEXT CONFIGURED/);
      assert.equal((await read(page, 'coach-arena-video')).hidden, false);
      assert.equal((await read(page, 'coach-arena')).checked, false);
      assert.equal(both.requests.length, 0, 'configuration check contacted a provider');

      // A selected-provider test does not send the user's chat or video.
      await page.click('#coach-test');
      await page.waitForFunction(() => document.querySelector('#coach-test-status').textContent.includes('replied'));
      assert.equal(both.requests.length, 1);
      assert.match(both.requests[0].url, /arena\.ai/);
      assert.doesNotMatch(JSON.stringify(both.requests[0].body), /youtube\.com|file_data/);

      await set(page, 'chat-input', 'Give me a basketball hook.');
      await page.click('#coach-send');
      await page.waitForFunction(() => !document.querySelector('#coach-consent-modal').hidden);
      assert.match((await read(page, 'coach-consent-intro')).text, /will not receive or watch the video/i);
      assert.equal(both.requests.length, 1, 'Arena chat was sent without confirmation');
      await page.click('#coach-consent'); await page.click('#confirm-coach');
      await page.waitForFunction(() => document.querySelector('#chat-messages').textContent.includes('Mock Arena creative idea.'));
      assert.equal(both.requests.length, 2);
      assert.match(both.requests[1].url, /arena\.ai/);
      await page.waitForFunction(() => !document.querySelector('#coach-arena-video').disabled);

      // Switching to the combined workflow is an explicit opt-in and requires
      // confirmation again before either provider is contacted.
      await page.$eval('#coach-arena-video', el => el.scrollIntoView({block:'center',behavior:'instant'}));
      await page.click('#coach-arena-video');
      assert.equal((await read(page, 'coach-engine')).value, 'gemini');
      assert.equal((await read(page, 'coach-arena')).checked, true);
      assert.equal((await read(page, 'coach-arena-video')).hidden, true);
      await set(page, 'coach-video-url', youtube);
      await set(page, 'chat-input', 'Summarize the video and suggest a hook.');
      await page.click('#coach-send');
      await page.waitForFunction(() => !document.querySelector('#coach-consent-modal').hidden);
      assert.match((await read(page, 'coach-consent-extras')).text, /Arena.*Gemini answer.*charge separately.*does not watch/i);
      assert.equal(both.requests.length, 2, 'combined request was sent without confirmation');
      await page.click('#coach-consent'); await page.click('#confirm-coach');
      await page.waitForFunction(() => document.querySelector('#chat-messages').textContent.includes('Mock Gemini video summary.'));
      assert.equal(both.requests.length, 4);
      assert.match(both.requests[2].url, /generativelanguage\.googleapis\.com/);
      assert.equal(both.requests[2].body.contents[0].parts[0].file_data.file_uri, youtube);
      assert.match(both.requests[3].url, /arena\.ai/);
      assert.match(JSON.stringify(both.requests[3].body), /Mock Gemini video summary/);
      assert.doesNotMatch(JSON.stringify(both.requests[3].body), /file_data/);
      assert.match(await page.$eval('#chat-messages', el => el.textContent), /did not independently view the video/i);

      // A manual Gemini selection does not silently re-enable the second call.
      await set(page, 'coach-engine', 'arena', 'change');
      await set(page, 'coach-engine', 'gemini', 'change');
      assert.equal((await read(page, 'coach-arena')).checked, false);
      for (const width of [390, 320]) {
        await page.setViewport({width, height:844});
        const size = await page.evaluate(() => ({viewport:innerWidth, document:document.documentElement.scrollWidth}));
        assert.ok(size.document <= size.viewport, `Coach overflows at ${width}px: ${JSON.stringify(size)}`);
      }
      assert.deepEqual(errors, []);
      await page.close();
      console.log('PASS: Arena default, isolated test, explicit combined consent, two mocked calls and mobile layout');
    } finally { await close(both.server); }

    for (const scenario of [
      {env:arena, engine:'arena', title:/video AI/i},
      {env:gemini, engine:'gemini', title:/Arena/i},
      {env:{}, engine:'arena', title:/AI Coach/i, disabled:true},
    ]) {
      const instance = await start(scenario.env);
      try {
        const {page, errors} = await open(browser, instance.base, 320);
        await page.waitForFunction(() => document.querySelector('#coach-ai-badge').textContent !== 'AI CHECKING');
        assert.equal((await read(page, 'coach-engine')).value, scenario.engine);
        assert.equal((await read(page, 'coach-engine')).disabled, Boolean(scenario.disabled));
        assert.equal((await read(page, 'coach-setup')).hidden, false);
        assert.match((await read(page, 'coach-setup-title')).text, scenario.title);
        assert.equal((await read(page, 'coach-arena-video')).hidden, true);
        await page.$eval('#coach-setup summary', el => el.scrollIntoView({block:'center',behavior:'instant'}));
        await page.click('#coach-setup summary');
        const setupSize = await page.evaluate(() => ({viewport:innerWidth, document:document.documentElement.scrollWidth}));
        assert.ok(setupSize.document <= setupSize.viewport, `Setup overflows at 320px: ${JSON.stringify(setupSize)}`);
        assert.match(await page.$eval('#coach-setup', el => el.textContent), /ARENA_API_KEY/);
        assert.equal(instance.requests.length, 0);
        assert.deepEqual(errors, []);
        await page.close();
      } finally { await close(instance.server); }
    }
    console.log('PASS: Arena-only, Gemini-only and no-provider setups');

    const fallback = await start({});
    try {
      const {page, errors} = await open(browser, fallback.base, 320, true);
      assert.match((await read(page, 'coach-setup-message')).text, /browser-only preview cannot run AI/i);
      assert.equal((await read(page, 'coach-test')).disabled, true);
      assert.deepEqual(errors, []);
      await page.close();
    } finally { await close(fallback.server); }
    console.log('PASS: browser-only preview clearly reports AI unavailable');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
