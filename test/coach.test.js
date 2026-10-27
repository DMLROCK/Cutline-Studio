'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../server');
const {
  MAX_COACH_BODY_BYTES, canonicalYouTubeUrl, normalizeCoachRequest, coachRequestPayload,
  parseCoachResponse, parseResearchResponse, cleanArenaRecipe, parseArenaResponse,
} = require('../coach');

const PASSWORD = 'test-only-coach-password-42';
const GOOGLE_KEY = 'test-only-google-key';
const ARENA_KEY = 'test-only-arena-key';
const AUTH = `Basic ${Buffer.from(`cutline:${PASSWORD}`).toString('base64')}`;
const ENV = { CUTLINE_ACCESS_PASSWORD: PASSWORD, CUTLINE_AI_ENABLED: 'true', GEMINI_API_KEY: GOOGLE_KEY };
const YOUTUBE = 'https://www.youtube.com/watch?v=9hE5-98ZeCg';

async function start(t, options = {}) {
  const server = createServer({ env: ENV, ...options });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}
function request(base, body = { prompt: 'Give me edit ideas.' }, options = {}) {
  const headers = { Authorization: AUTH, Origin: base, 'Content-Type': 'application/json', 'X-Coach-Consent': 'yes', ...options.headers };
  for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
  return fetch(base + '/api/coach', { method: 'POST', headers, body: options.raw !== undefined ? options.raw : JSON.stringify(body) });
}
function google(data = { answer: 'A careful summary and edit ideas.', clips: [] }) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }] }), { status: 200 });
}
function grounded() {
  const text = 'Basketball 🏀 context.';
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata: {
    groundingChunks: [{ web: { uri: 'https://example.com/article', title: 'Example source' } }],
    groundingSupports: [{ segment: { endIndex: Buffer.byteLength(text) }, groundingChunkIndices: [0] }],
    searchEntryPoint: { renderedContent: '<div><a href="https://www.google.com/search?q=sports">Search</a></div>' },
  } }] }), { status: 200 });
}
function arena(text = 'Arena creative ideas.') {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}

test('YouTube links are strictly validated and normalized without fetching arbitrary URLs', () => {
  for (const url of [
    YOUTUBE + '&list=abc&si=tracking',
    'https://youtu.be/9hE5-98ZeCg?t=4',
    'https://m.youtube.com/shorts/9hE5-98ZeCg',
    'https://youtube.com/live/9hE5-98ZeCg',
    'https://www.youtube.com/embed/9hE5-98ZeCg',
  ]) assert.equal(canonicalYouTubeUrl(url), YOUTUBE);
  for (const url of [
    'http://youtube.com/watch?v=9hE5-98ZeCg', 'https://youtube.com.evil.test/watch?v=9hE5-98ZeCg',
    'https://evil-youtube.com/watch?v=9hE5-98ZeCg', 'https://user@youtube.com/watch?v=9hE5-98ZeCg',
    'https://youtube.com:444/watch?v=9hE5-98ZeCg', 'https://youtube.com/playlist?list=abc',
    'https://youtu.be/not-an-id', 'https://youtube.com/watch?v=9hE5-98ZeCg_extra', 'file:///etc/passwd',
  ]) assert.equal(canonicalYouTubeUrl(url), null, url);
});

test('request normalization finds one link and bounds prompt and chat context', () => {
  const history = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: 'x'.repeat(2000) }));
  const value = normalizeCoachRequest({ prompt: `Analyze ${YOUTUBE}&si=abc.`, history, research: true, arena: 'true' });
  assert.equal(value.youtubeUrl, YOUTUBE);
  assert.equal(value.history.length, 6);
  assert.equal(value.history[0].text.length, 1200);
  assert.equal(value.research, true);
  assert.equal(value.arena, false);
  assert.throws(() => normalizeCoachRequest({ prompt: '' }), /message/i);
  assert.throws(() => normalizeCoachRequest({ prompt: 'x'.repeat(1601) }), /1600/);
  assert.throws(() => normalizeCoachRequest({ prompt: 'https://youtube.com/playlist?list=123' }), /video link/i);
  assert.throws(() => normalizeCoachRequest({ prompt: `${YOUTUBE} https://youtu.be/abcdefghijk` }), /one YouTube/i);
  assert.throws(() => normalizeCoachRequest({ prompt: 'Analyze this', youtubeUrl: 'https://youtube.com.evil.test/' }), /YouTube/i);
  assert.equal(normalizeCoachRequest({ prompt: 'Summarize it', youtubeUrl: 'https://youtu.be/9hE5-98ZeCg?si=tracking' }).youtubeUrl, YOUTUBE);
  assert.throws(() => normalizeCoachRequest({ prompt: `Analyze ${YOUTUBE}`, youtubeUrl: 'https://youtu.be/abcdefghijk' }), /one YouTube/i);
});

test('fast-action focus requires a bounded original-video range and never affects Arena', () => {
  const focus = { startSeconds: 125, endSeconds: 185, fps: 999 };
  const request = normalizeCoachRequest({ prompt: `Review ${YOUTUBE}`, videoFocus: focus });
  assert.deepEqual(request.videoFocus, { startSeconds:125, endSeconds:185 });
  const payload = coachRequestPayload(request);
  assert.deepEqual(payload.contents[0].parts[0].video_metadata, { start_offset:'125s', end_offset:'185s', fps:3 });
  assert.match(payload.contents[0].parts[1].text, /original-video seconds/i);
  const ordinary = coachRequestPayload(normalizeCoachRequest({ prompt: `Review ${YOUTUBE}` }));
  assert.equal(ordinary.contents[0].parts[0].video_metadata, undefined);
  for (const bad of [
    {startSeconds:-1,endSeconds:20}, {startSeconds:5,endSeconds:5}, {startSeconds:5,endSeconds:96},
    {startSeconds:'5',endSeconds:50}, {startSeconds:1.5,endSeconds:20}, {startSeconds:0,endSeconds:43201},
    [], 'invalid', {},
  ]) assert.throws(() => normalizeCoachRequest({ prompt:`Review ${YOUTUBE}`, videoFocus:bad }), /focus range/i);
  assert.throws(() => normalizeCoachRequest({ prompt:'No link here', videoFocus:focus }), /requires a public YouTube/i);
  assert.throws(() => normalizeCoachRequest({ prompt:`Review ${YOUTUBE}`, engine:'arena', videoFocus:focus }), /Gemini mode/i);
});

test('only a normalized YouTube URL is attached; ordinary URLs remain text', () => {
  const video = coachRequestPayload(normalizeCoachRequest({ prompt: `Please analyze https://youtu.be/9hE5-98ZeCg?t=7` }));
  assert.equal(video.contents[0].parts[0].file_data.file_uri, YOUTUBE);
  assert.equal(video.generationConfig.responseMimeType, 'application/json');
  assert.equal(video.generationConfig.temperature, undefined);
  assert.equal(video.generationConfig.maxOutputTokens, 8192);
  assert.match(video.systemInstruction.parts[0].text, /uncertain/i);
  assert.match(video.systemInstruction.parts[0].text, /story order/i);
  const edit = coachRequestPayload(normalizeCoachRequest({ prompt:'Make an edit', mode:'edit' }));
  assert.match(edit.contents[0].parts[0].text, /opening, middle and payoff/i);
  const trends = coachRequestPayload(normalizeCoachRequest({ prompt:'Ideas', mode:'trends' }));
  assert.match(trends.contents[0].parts[0].text, /verification checklist/i);
  const text = coachRequestPayload(normalizeCoachRequest({ prompt: 'What is at https://example.com/' }));
  assert.equal(text.contents[0].parts.length, 1);
  assert.match(text.contents[0].parts[0].text, /No video is attached/);
});

test('invalid, excessive or invented clip ranges are never turned into editor actions', () => {
  const data = { candidates: [{ content: { parts: [
    { text: 'hidden thoughts', thought: true },
    { text: JSON.stringify({ answer: 'Ideas', clips: [
      { label: 'valid', startSeconds: 12.3, endSeconds: 28, reason: 'A moment', overlay: 'Hook' },
      { label: 'negative', startSeconds: -1, endSeconds: 2 },
      { label: 'too long', startSeconds: 1, endSeconds: 65 },
      { label: 'zero', startSeconds: 3, endSeconds: 3 },
      { label: 'infinite', startSeconds: 'Infinity', endSeconds: 5 },
      { label: 'null', startSeconds: null, endSeconds: 5 },
    ] }) },
  ] } }] };
  const result = parseCoachResponse(data, true);
  assert.equal(result.answer, 'Ideas');
  assert.equal(result.clips.length, 1);
  assert.equal(result.clips[0].startSeconds, 12.3);
  assert.deepEqual(parseCoachResponse(data, false).clips, []);
  const unstructured = parseCoachResponse({ candidates: [{ content: { parts: [{ text: 'Maybe 00:05 is a clip.' }] } }] }, true);
  assert.deepEqual(unstructured.clips, []);
  assert.match(unstructured.answer, /Maybe/);
});

test('incomplete or blocked Gemini output never becomes an answer or editor action', () => {
  const candidate = { finishReason:'MAX_TOKENS', content:{ parts:[{ text:JSON.stringify({answer:'partial',clips:[{startSeconds:1,endSeconds:2}]}) }] } };
  assert.equal(parseCoachResponse({candidates:[candidate]}, true), null);
  candidate.finishReason = 'SAFETY'; assert.equal(parseCoachResponse({candidates:[candidate]}, true), null);
  candidate.finishReason = 'STOP'; assert.equal(parseCoachResponse({candidates:[candidate]}, true).answer, 'partial');
  assert.equal(parseResearchResponse({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'partial'}]}}]}),null);
});

test('Gemini edit recipes are allowlisted and focused clips must fit the selected source interval', () => {
  const response = { candidates:[{ content:{ parts:[{ text:JSON.stringify({
    answer:'Here are edit ideas.',
    clips:[
      {label:'Within range', startSeconds:125.1, endSeconds:130, reason:'Payoff', overlay:'Play'},
      {label:'Starts before range', startSeconds:1, endSeconds:5},
      {label:'Ends after range', startSeconds:175, endSeconds:190},
    ],
    editRecipe:{ headline:'Highlight', supportingLine:'X'.repeat(120), colorPreset:'punch', zoomStart:120, zoomEnd:151,
      animateZoom:true, titleAnimation:'pop', speed:1.25, panX:999, fadeIn:5, unknown:'do not execute' },
  }) }] } }] };
  const result = parseCoachResponse(response, true, {startSeconds:125,endSeconds:185});
  assert.deepEqual(result.clips.map(clip=>clip.label), ['Within range']);
  assert.deepEqual(result.editRecipe, { headline:'Highlight', supportingLine:'X'.repeat(100), titleAnimation:'pop', colorPreset:'punch', zoomStart:120, zoomEnd:151, animateZoom:true, speed:1.25 });
  const malformed = { candidates:[{ content:{ parts:[{ text:JSON.stringify({answer:'Plain answer',clips:[],editRecipe:{speed:'2',colorPreset:'javascript:bad'}}) }] } }] };
  assert.equal(parseCoachResponse(malformed, false).editRecipe, undefined);
});

test('grounded citations use UTF-8 byte offsets per part and unsafe sources are ignored', () => {
  const text = 'A 🏀 play.';
  const data = { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text }, { text: 'Next.' }] }, groundingMetadata: {
    groundingChunks: [
      { web: { uri: 'https://example.com/fact', title: 'Fact' } },
      { web: { uri: 'javascript:alert(1)', title: 'unsafe' } },
    ],
    groundingSupports: [
      { segment: { partIndex: 1, endIndex: Buffer.byteLength('A 🏀') }, groundingChunkIndices: [0, 1] },
      { segment: { partIndex: 1, endIndex: 4 }, groundingChunkIndices: [0] }, // inside emoji: reject
      { segment: { partIndex: 2, endIndex: Buffer.byteLength('Next.') }, groundingChunkIndices: [0] },
    ],
    searchEntryPoint: { renderedContent: '<div>Exact Google suggestions</div>' },
  } }] };
  const result = parseResearchResponse(data);
  assert.equal(result.text, 'A 🏀 play.\nNext.');
  assert.deepEqual(result.supports, [
    { endIndex: 'A 🏀'.length, indices: [0] },
    { endIndex: result.text.length, indices: [0] },
  ]);
  assert.equal(result.sources[1].url, '');
  assert.equal(result.searchHtml, '<div>Exact Google suggestions</div>');
  assert.equal(result.hasSources, true);
  data.candidates[0].groundingMetadata.searchEntryPoint.renderedContent = 'x'.repeat(100001);
  assert.equal(parseResearchResponse(data), null); // Never truncate required suggestions.
  data.candidates[0].groundingMetadata.searchEntryPoint.renderedContent = '';
  data.candidates[0].groundingMetadata.groundingChunks = Array.from({ length: 31 }, () => ({ web: { uri: 'https://example.com/' } }));
  assert.equal(parseResearchResponse(data), null); // Never silently drop sources.
});

test('Arena recipes are optional, bounded, allowlisted, and plain text still works', () => {
  const recipe = cleanArenaRecipe({ headline:'X'.repeat(90), supportingLine:'Keep it readable', titlePosition:'top', titleAnimation:'slide', colorPreset:'punch', zoomStart:125, zoomEnd:180, animateZoom:true, panX:-40, panY:101, vignette:25, fadeIn:.5, fadeOut:4, speed:1.25, unsupported:'execute', __proto__:{ injected:true } });
  assert.equal(recipe.headline.length, 80);
  assert.deepEqual(recipe, { headline:'X'.repeat(80), supportingLine:'Keep it readable', titlePosition:'top', titleAnimation:'slide', colorPreset:'punch', zoomStart:125, zoomEnd:180, panX:-40, vignette:25, animateZoom:true, fadeIn:.5, speed:1.25 });
  assert.equal(cleanArenaRecipe({ colorPreset:'javascript:bad', zoomStart:Infinity, speed:'2' }), null);
  const result = parseArenaResponse({ choices:[{ message:{ content:'```json\n' + JSON.stringify({ answer:'Original creative idea', recipe:{ titleAnimation:'pop', zoomStart:140 } }) + '\n```' } }] });
  assert.equal(result.text, 'Original creative idea');
  assert.deepEqual(result.recipe, { titleAnimation:'pop', zoomStart:140 });
  assert.deepEqual(parseArenaResponse({ choices:[{ message:{ content:'Plain text answer' } }] }), { text:'Plain text answer', recipe:null });
});

test('Coach fails closed without access protection and requires auth, origin and consent', async t => {
  let calls = 0;
  const mock = async () => { calls++; return google(); };
  const off = await start(t, { env: { CUTLINE_AI_ENABLED: 'true', GEMINI_API_KEY: GOOGLE_KEY }, fetchImpl: mock });
  assert.equal((await request(off)).status, 503);
  const base = await start(t, { fetchImpl: mock });
  assert.equal((await request(base, undefined, { headers: { Authorization: undefined } })).status, 401);
  assert.equal((await request(base, undefined, { headers: { Origin: undefined } })).status, 403);
  assert.equal((await request(base, undefined, { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await request(base, undefined, { headers: { 'X-Coach-Consent': undefined } })).status, 400);
  assert.equal((await request(base, undefined, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await fetch(base + '/api/coach', { headers: { Authorization: AUTH } })).status, 405);
  assert.equal(calls, 0);
});

test('explicit owner flags are required for optional potentially billable providers', async t => {
  let calls = 0;
  const base = await start(t, { fetchImpl: async () => { calls++; return google(); } });
  const health = await (await fetch(base + '/api/health', { headers: { Authorization: AUTH } })).json();
  assert.equal(health.coachReady, true);
  assert.equal(health.researchReady, false);
  assert.equal(health.arenaReady, false);
  assert.equal((await request(base, { prompt: 'Titles', research: true })).status, 403);
  assert.equal((await request(base, { prompt: 'Titles', arena: true })).status, 403);
  assert.equal(calls, 0);
  const invalidArena = await start(t, { env: { ...ENV, CUTLINE_ARENA_ENABLED: 'true', ARENA_API_KEY: ARENA_KEY, ARENA_MODEL: '../../?model=bad' }, fetchImpl: async () => { calls++; return google(); } });
  assert.equal((await request(invalidArena, { prompt: 'Ideas', arena: true })).status, 403);
  assert.equal(calls, 0);
});

test('explicit false flags block optional providers even with inherited keys', async t => {
  const calls = [];
  const env = {
    ...ENV,
    GEMINI_MODEL: 'gemini-3.8-flash',
    CUTLINE_RESEARCH_ENABLED: 'false',
    CUTLINE_ARENA_ENABLED: 'false',
    ARENA_API_KEY: ARENA_KEY,
    ARENA_MODEL: 'approved/model',
  };
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return google(); };
  const base = await start(t, { env, fetchImpl });
  const health = await (await fetch(base + '/api/health', { headers: { Authorization: AUTH } })).json();
  assert.equal(health.coachReady, true);
  assert.equal(health.researchReady, false);
  assert.equal(health.arenaReady, false);
  assert.equal((await request(base, { prompt: 'Titles', research: true })).status, 403);
  assert.equal((await request(base, { prompt: 'Titles', arena: true })).status, 403);
  assert.equal((await request(base, { prompt: 'Titles', engine: 'arena' })).status, 503);
  assert.equal(calls.length, 0);
  assert.equal((await request(base, { prompt: 'Titles' })).status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(JSON.parse(calls[0].options.body).tools, undefined);

  const paused = await start(t, { env: { ...env, CUTLINE_AI_ENABLED: 'false' }, fetchImpl });
  assert.equal((await request(paused)).status, 503);
  assert.equal(calls.length, 1, 'disabling AI must also block an inherited Gemini key');
});

test('a confirmed YouTube chat sends only the link and bounded context to Gemini and returns a clip', async t => {
  const calls = [];
  const clips = [{ label: 'Big play', startSeconds: 4.5, endSeconds: 15, reason: 'Potential payoff', overlay: 'A big play' }];
  const base = await start(t, { fetchImpl: async (url, options) => { calls.push({ url, options }); return google({ answer: 'Summary and editing observations.', clips }); } });
  const response = await request(base, { prompt: `Analyze https://youtu.be/9hE5-98ZeCg?t=42`, history: [{ role: 'user', text: 'Basketball' }] });
  assert.equal(response.status, 200);
  const text = await response.text();
  const result = JSON.parse(text);
  assert.equal(result.youtubeUrl, YOUTUBE);
  assert.equal(result.clips[0].startSeconds, 4.5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(calls[0].options.headers['x-goog-api-key'], GOOGLE_KEY);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.contents[0].parts[0].file_data.file_uri, YOUTUBE);
  assert.match(payload.contents[0].parts[1].text, /Basketball/);
  assert.doesNotMatch(JSON.stringify(payload), /inline_data/);
  assert.doesNotMatch(text, /test-only-google-key|test-only-coach-password/);
});

test('a confirmed focused Gemini request forwards only the bounded interval and safe edit recipe', async t => {
  const calls = [];
  const responseBody = { answer:'Review the possible highlight.', clips:[
    {label:'Inside',startSeconds:126,endSeconds:140,reason:'A play',overlay:'Highlight'},
    {label:'Outside',startSeconds:10,endSeconds:15},
  ], editRecipe:{headline:'Big play',zoomStart:120,zoomEnd:140,animateZoom:true,speed:1.25,unknown:'ignore'} };
  const base = await start(t, { fetchImpl:async (url, options) => { calls.push({url,options}); return google(responseBody); } });
  const result = await (await request(base, {prompt:`Analyze ${YOUTUBE}`,videoFocus:{startSeconds:125,endSeconds:155,fps:200}})).json();
  assert.deepEqual(result.clips.map(clip=>clip.label), ['Inside']);
  assert.deepEqual(result.editRecipe,{headline:'Big play',zoomStart:120,zoomEnd:140,animateZoom:true,speed:1.25});
  assert.deepEqual(JSON.parse(calls[0].options.body).contents[0].parts[0].video_metadata,{start_offset:'125s',end_offset:'155s',fps:3});
  assert.doesNotMatch(JSON.stringify(result), /test-only-google-key/);
});

test('opt-in Google Search and Arena calls have separate inputs and return sourced/creative output', async t => {
  const calls = [];
  const base = await start(t, {
    env: { ...ENV, CUTLINE_RESEARCH_ENABLED: 'true', CUTLINE_ARENA_ENABLED: 'true', ARENA_API_KEY: ARENA_KEY, ARENA_MODEL: 'approved/model' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('arena.ai')) return arena();
      if (JSON.parse(options.body).tools) return grounded();
      return google();
    },
  });
  const response = await request(base, { prompt: `Analyze ${YOUTUBE}`, research: true, arena: true });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[1].options.body).tools, [{ googleSearch: {} }]);
  assert.equal(result.research.hasSources, true);
  assert.equal(result.research.supports[0].endIndex, 'Basketball 🏀 context.'.length);
  assert.equal(result.research.sources[0].url, 'https://example.com/article');
  assert.match(result.research.searchHtml, /Search/);
  assert.equal(calls[2].url, 'https://api.arena.ai/v1/chat/completions');
  assert.equal(calls[2].options.headers.Authorization, `Bearer ${ARENA_KEY}`);
  assert.equal(JSON.parse(calls[2].options.body).model, 'approved/model');
  assert.doesNotMatch(calls[2].options.body, /file_data|inline_data/);
  assert.match(result.arena, /Arena creative ideas/);
  assert.doesNotMatch(JSON.stringify(result), /test-only-arena-key|test-only-google-key/);
});

test('Arena-only text Coach works without Gemini and never fabricates video-clip actions', async t => {
  const calls = [];
  const env = { CUTLINE_ACCESS_PASSWORD:PASSWORD, CUTLINE_ARENA_ENABLED:'true', ARENA_API_KEY:ARENA_KEY, ARENA_MODEL:'approved/model' };
  const base = await start(t, { env, fetchImpl:async (url, options) => { calls.push({ url, options }); return arena(JSON.stringify({ answer:'Here is a text-only plan.', recipe:{ headline:'A big moment', zoomStart:120 } })); } });
  const health = await (await fetch(base + '/api/health', { headers:{ Authorization:AUTH } })).json();
  assert.equal(health.coachReady, false); assert.equal(health.arenaReady, true); assert.equal(health.videoReviewReady, false);
  assert.equal((await request(base, { prompt:'Research this', engine:'arena', research:true })).status, 400);
  assert.equal((await request(base, { prompt:'Analyze this', engine:'gemini' })).status, 503);
  assert.equal(calls.length, 0);
  const response = await request(base, { prompt:`Analyze ${YOUTUBE}`, engine:'arena', history:[{ role:'user', text:'Basketball context' }] });
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.provider, 'arena');
  assert.equal(result.answer, 'Here is a text-only plan.'); assert.deepEqual(result.clips, []); assert.equal(result.youtubeUrl, null);
  assert.deepEqual(result.arenaRecipe, { headline:'A big moment', zoomStart:120 });
  assert.equal(calls.length, 1); assert.match(calls[0].url, /arena\.ai/);
  assert.match(calls[0].options.body, /Basketball context/);
  assert.match(calls[0].options.body, /uninspected text/);
  assert.doesNotMatch(calls[0].options.body, /file_data|inline_data/);
  const open = await start(t, { env:{ ...env, CUTLINE_ACCESS_PASSWORD:undefined }, fetchImpl:async()=>{ throw new Error('must not call'); } });
  assert.equal((await request(open, { prompt:'Ideas', engine:'arena' })).status, 503);
});

test('consented Arena output can include a safe edit recipe without receiving video bytes', async t => {
  const calls = [];
  const base = await start(t, {
    env:{ ...ENV, CUTLINE_ARENA_ENABLED:'true', ARENA_API_KEY:ARENA_KEY, ARENA_MODEL:'approved/model' },
    fetchImpl:async (url, options) => {
      calls.push({ url, options });
      return url.includes('arena.ai') ? arena(JSON.stringify({ answer:'Build a quick hook.', recipe:{ headline:'Big moment', zoomStart:120, zoomEnd:150, animateZoom:true, titleAnimation:'pop', vignette:20, speed:100, arbitraryAction:'bad' } })) : google();
    },
  });
  const result = await (await request(base, { prompt:`Edit ${YOUTUBE}`, arena:true })).json();
  assert.equal(result.arena, 'Build a quick hook.');
  assert.deepEqual(result.arenaRecipe, { headline:'Big moment', titleAnimation:'pop', zoomStart:120, zoomEnd:150, vignette:20, animateZoom:true });
  assert.doesNotMatch(calls[1].options.body, /file_data|inline_data/);
  assert.match(calls[1].options.body, /not the video/i);
});

test('provider failures are meaningful and optional failures preserve the base answer', async t => {
  let calls = 0;
  const base = await start(t, {
    env: { ...ENV, CUTLINE_RESEARCH_ENABLED: 'true', CUTLINE_ARENA_ENABLED: 'true', ARENA_API_KEY: ARENA_KEY, ARENA_MODEL: 'approved/model' },
    fetchImpl: async () => { calls++; return calls === 1 ? google() : new Response('private upstream error', { status: 429 }); },
  });
  const response = await request(base, { prompt: 'Titles', research: true, arena: true });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.answer, /summary/);
  assert.match(result.researchError, /rate limit/i);
  assert.match(result.arenaError, /rate limit/i);
  assert.doesNotMatch(JSON.stringify(result), /private upstream error/);
  assert.equal(calls, 3);
  const failed = await start(t, { fetchImpl: async () => new Response('secret diagnostic', { status: 429 }) });
  const limited = await request(failed);
  assert.equal(limited.status, 429);
  assert.doesNotMatch(await limited.text(), /secret diagnostic/);
});

test('provider errors offer safe setup guidance without returning upstream diagnostics', async t => {
  for (const [status, pattern] of [[400,/video is public/i],[401,/not authorized/i],[403,/account access/i],[404,/model/i],[503,/temporarily unavailable/i]]) {
    const base = await start(t, { fetchImpl:async () => new Response('secret diagnostic', {status}) });
    const response = await request(base);
    assert.equal(response.status,502);
    const body = await response.text();
    assert.match(body,pattern); assert.doesNotMatch(body,/secret diagnostic|test-only-google-key/);
  }
});

test('Arena authorization failures explain app access without leaking provider details', async t => {
  const arenaEnv = { CUTLINE_ACCESS_PASSWORD:PASSWORD, CUTLINE_ARENA_ENABLED:'true', ARENA_API_KEY:ARENA_KEY, ARENA_MODEL:'approved/model' };
  for (const status of [401, 403]) {
    const base = await start(t, { env:arenaEnv, fetchImpl:async () => new Response('private upstream diagnostic', {status}) });
    const response = await request(base, {prompt:'Give me ideas', engine:'arena'});
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.match(body, /workspace API access/i);
    assert.match(body, /Claude Code/i);
    assert.doesNotMatch(body, /private upstream diagnostic|test-only-arena-key/);
  }
  const base = await start(t, { env:{...ENV, ...arenaEnv}, fetchImpl:async url => url.includes('arena.ai') ? new Response('private upstream diagnostic', {status:403}) : google() });
  const response = await request(base, {prompt:'Give me ideas', arena:true});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.answer, /summary/i);
  assert.match(result.arenaError, /workspace API access/i);
  assert.doesNotMatch(JSON.stringify(result), /private upstream diagnostic|test-only-arena-key/);
});

test('a truncated Gemini response is reported without exposing partial output', async t => {
  const base = await start(t, { fetchImpl:async () => new Response(JSON.stringify({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'private partial result'}]}}]}),{status:200}) });
  const response = await request(base);
  assert.equal(response.status,502);
  const result = await response.json();
  assert.match(result.error,/output limit/i);
  assert.doesNotMatch(JSON.stringify(result),/private partial result/);
});

test('invalid JSON, oversized bodies and invalid links never reach the provider', async t => {
  let calls = 0;
  const base = await start(t, { fetchImpl: async () => { calls++; return google(); } });
  assert.equal((await request(base, {}, { raw: '{invalid' })).status, 400);
  assert.equal((await request(base, { prompt: 'https://youtube.com/playlist?list=123' })).status, 400);
  assert.equal((await request(base, { prompt:`Analyze ${YOUTUBE}`, videoFocus:{startSeconds:0,endSeconds:91} })).status, 400);
  assert.equal((await request(base, { prompt:'No video attached', videoFocus:{startSeconds:0,endSeconds:30} })).status, 400);
  const result = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/coach', { method: 'POST', headers: {
      Authorization: AUTH, Origin: base, 'Content-Type': 'application/json', 'X-Coach-Consent': 'yes', 'Content-Length': MAX_COACH_BODY_BYTES + 1,
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end('x');
  });
  assert.equal(result, 413);
  assert.equal(calls, 0);
});

test('chunked Coach requests are bounded before they reach the provider', async t => {
  let calls = 0;
  const base = await start(t, { fetchImpl: async () => { calls++; return google(); } });
  const status = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/coach', { method: 'POST', headers: {
      Authorization: AUTH, Origin: base, 'Content-Type': 'application/json', 'X-Coach-Consent': 'yes',
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(Buffer.alloc(MAX_COACH_BODY_BYTES));
    req.end('too much');
  });
  assert.equal(status, 413);
  assert.equal(calls, 0);
});

test('oversized provider responses and provider timeouts fail without leaking diagnostics', async t => {
  const tooLarge = await start(t, { fetchImpl: async () => new Response(JSON.stringify({ payload: 'x'.repeat(1024 * 1024) }), { status: 200 }) });
  const largeResult = await request(tooLarge);
  assert.equal(largeResult.status, 502);
  assert.doesNotMatch(await largeResult.text(), /x{100}|test-only-google-key/);
  const timeout = await start(t, { fetchImpl: async () => { const error = new Error('private network detail'); error.name = 'AbortError'; throw error; } });
  const timedOut = await request(timeout);
  assert.equal(timedOut.status, 504);
  assert.doesNotMatch(await timedOut.text(), /private network detail/);
});

test('Coach has a single in-flight slot and a peer cooldown that cannot be bypassed with forwarded IPs', { timeout: 10000 }, async t => {
  let clock = 100_000, calls = 0, release, markStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  t.after(() => release());
  const base = await start(t, { now: () => clock, fetchImpl: async () => { calls++; if (calls === 1) { markStarted(); await gate; } return google(); } });
  const first = request(base, { prompt: 'First' });
  await started;
  clock += 5_000;
  const concurrent = await request(base, { prompt: 'Second' }, { headers: { 'X-Forwarded-For': '192.0.2.3' } });
  assert.equal(concurrent.status, 429);
  assert.match((await concurrent.json()).error, /in progress/);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await request(base, { prompt: 'Second' }, { headers: { 'X-Forwarded-For': '192.0.2.4' } })).status, 200);
  const cooldown = await request(base, { prompt: 'Third' }, { headers: { 'X-Forwarded-For': '192.0.2.5' } });
  assert.equal(cooldown.status, 429);
  assert.equal(cooldown.headers.get('retry-after'), '5');
  assert.equal(calls, 2);
});
