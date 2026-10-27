'use strict';

// Cutline Studio's dependency-free preview server. A shared password can
// protect a personal preview, but this is not a multi-user production service.
const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { createTikTokService } = require('./tiktok');
const {
  MAX_COACH_BODY_BYTES, normalizeCoachRequest, coachRequestPayload, parseCoachResponse, geminiFinishReason,
  researchRequestPayload, parseResearchResponse, arenaRequestPayload, parseArenaResponse,
} = require('./coach');

const indexFile = path.join(__dirname, 'index.html');
const publicProfileFile = path.join(__dirname, 'public-profile.html');
const editorCoreFile = path.join(__dirname, 'editor-core.js');
const DEFAULT_MODEL = 'gemini-3.8-flash';
// Inline requests also contain base64 and prompt overhead. Leave room below
// Gemini's recommended 20 MB total request size for short video inputs.
const MAX_VIDEO_BYTES = 14 * 1024 * 1024;
const REVIEW_COOLDOWN_MS = 30_000;
const COACH_COOLDOWN_MS = 5_000;
const PROVIDER_TIMEOUT_MS = 120_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const AUTH_WINDOW_MS = 60_000;
const MAX_AUTH_FAILURES = 5;
const ACCESS_USERNAME = 'cutline';
const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4', 'video/mpeg', 'video/mov', 'video/quicktime', 'video/avi',
  'video/x-flv', 'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp',
]);

function configuration(env) {
  const requestedModel = String(env.GEMINI_MODEL || '');
  const model = /^[a-zA-Z0-9._-]{1,80}$/.test(requestedModel) ? requestedModel : DEFAULT_MODEL;
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  const passwordProvided = env.CUTLINE_ACCESS_PASSWORD !== undefined;
  const password = passwordProvided ? String(env.CUTLINE_ACCESS_PASSWORD) : '';
  // A supplied but invalid password blocks the entire app, rather than leaving
  // a preview open when its owner expects it to be protected.
  const passwordLength = [...password].length;
  const passwordValid = passwordProvided && passwordLength >= 16 && passwordLength <= 256
    && !/^\s+$/.test(password) && !/[\x00-\x1f\x7f]/.test(password);
  const accessDigest = passwordValid
    ? createHash('sha256').update(`${ACCESS_USERNAME}:${password}`, 'utf8').digest()
    : null;
  const aiRequested = env.CUTLINE_AI_ENABLED === 'true' && apiKey.length > 0;
  const ready = aiRequested && passwordValid;
  const arenaKey = String(env.ARENA_API_KEY || '').trim();
  const requestedArenaModel = String(env.ARENA_MODEL || '').trim();
  const arenaModel = /^[a-zA-Z0-9._:/-]{1,160}$/.test(requestedArenaModel) ? requestedArenaModel : '';
  return {
    model, apiKey, passwordProvided, passwordValid, accessDigest, aiRequested, ready,
    // Optional billable features need both owner configuration and an explicit
    // per-request choice. Neither provider is contacted just by enabling them.
    researchReady: ready && env.CUTLINE_RESEARCH_ENABLED === 'true',
    arenaReady: passwordValid && env.CUTLINE_ARENA_ENABLED === 'true' && Boolean(arenaKey && arenaModel),
    arenaKey, arenaModel,
  };
}

function validAuthorization(header, expectedDigest) {
  if (typeof header !== 'string') return false;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) return false;
  const supplied = Buffer.from(match[1], 'base64');
  if (supplied.length > 2048) return false;
  const suppliedDigest = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function send(res, status, body, contentType, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : payload);
}

function sendJson(res, status, data, headers) {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', headers);
}

function rejectRequest(req, res, status, message, headers) {
  // Drain a rejected request without retaining or forwarding the body.
  req.resume();
  sendJson(res, status, { error: message }, headers);
}

function methodNotAllowed(req, res, allowed) {
  rejectRequest(req, res, 405, 'Method not allowed.', { Allow: allowed.join(', ') });
}

function originMatchesRequest(req) {
  try {
    const origin = new URL(String(req.headers.origin || ''));
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    const requestHost = String(req.headers.host || '').trim().toLowerCase();
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
    const originHost = origin.host.toLowerCase();
    return originHost === requestHost || (forwardedHost !== '' && originHost === forwardedHost);
  } catch (_) {
    return false;
  }
}

function uploadError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readLimitedBody(req, maxBytes, messages = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let settled = false;

    function fail(error) {
      if (settled) return;
      settled = true;
      chunks = [];
      reject(error);
    }

    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(uploadError(413, messages.tooLarge || 'For AI review, choose a video no larger than 14 MB.'));
      } else {
        chunks.push(chunk);
      }
    });
    req.once('end', () => {
      if (settled) return;
      if (!size) return fail(uploadError(400, messages.empty || 'The uploaded video was empty.'));
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
    req.once('aborted', () => fail(uploadError(400, 'The upload was interrupted.')));
    req.once('error', fail);
  });
}

function createServer({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const config = configuration(env);
  const tiktok = createTikTokService({ env, passwordValid: config.passwordValid, fetchImpl, now });
  const reviewTimes = new Map();
  const coachTimes = new Map();
  const failedLogins = new Map();
  let reviewInFlight = false;
  let coachInFlight = false;

  function authorize(req, res) {
    if (!config.passwordProvided) return true;
    if (!config.passwordValid) {
      rejectRequest(req, res, 503, 'Access protection is misconfigured. Contact the app owner.');
      return false;
    }

    // Keep the personal preview out of frames, where confirmation UI could be
    // clickjacked. Unprotected local/Arena previews retain their normal behavior.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");

    // Missing credentials always receive a login challenge. For requests with
    // credentials, enforce the limit *before* comparing them, so a 429 cannot
    // be used to keep guessing. Behind a proxy, peers can share the same limit.
    if (req.headers.authorization !== undefined) {
      const address = req.socket.remoteAddress || 'unknown';
      const time = now();
      let attempt = failedLogins.get(address);
      if (attempt && (time - attempt.started >= AUTH_WINDOW_MS || time < attempt.started)) {
        failedLogins.delete(address);
        attempt = null;
      }
      if (attempt && attempt.count >= MAX_AUTH_FAILURES) {
        const seconds = Math.max(1, Math.ceil((AUTH_WINDOW_MS - (time - attempt.started)) / 1000));
        rejectRequest(req, res, 429, 'Too many sign-in attempts. Please wait and try again.', { 'Retry-After': seconds });
        return false;
      }
      if (validAuthorization(req.headers.authorization, config.accessDigest)) {
        failedLogins.delete(address);
        return true;
      }
      if (!attempt) attempt = { started: time, count: 0 };
      attempt.count++;
      // Do not trust X-Forwarded-For, which can be forged. This bounded,
      // in-memory guard is only a lightweight deterrent, not a security service.
      if (failedLogins.size >= 500) {
        for (const [ip, entry] of failedLogins) {
          if (time - entry.started >= AUTH_WINDOW_MS || time < entry.started) failedLogins.delete(ip);
        }
        if (failedLogins.size >= 1000) failedLogins.delete(failedLogins.keys().next().value);
      }
      failedLogins.set(address, attempt);
    }

    rejectRequest(req, res, 401, 'Sign in to access this private preview.', {
      'WWW-Authenticate': 'Basic realm="Cutline Studio", charset="UTF-8"',
    });
    return false;
  }

  async function reviewVideo(req, res) {
    if (!config.ready) {
      return rejectRequest(req, res, 503, 'Video AI is not configured on this server. No video was sent.');
    }
    // These headers protect the normal browser flow, but are forgeable and do not
    // replace authentication or a proper quota on a public deployment.
    if (!originMatchesRequest(req)) {
      return rejectRequest(req, res, 403, 'This request did not come from the Cutline page. No video was sent.');
    }
    if (req.headers['x-clip-consent'] !== 'yes') {
      return rejectRequest(req, res, 400, 'Confirm the per-clip consent before sending a video.');
    }

    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_VIDEO_TYPES.has(contentType)) {
      return rejectRequest(req, res, 415, 'This video type is not supported by the AI review route.');
    }
    if (Number(req.headers['content-length'] || 0) > MAX_VIDEO_BYTES) {
      return rejectRequest(req, res, 413, 'For AI review, choose a video no larger than 14 MB.', { Connection: 'close' });
    }

    // One review at a time keeps a small personal host from retaining several
    // large clips concurrently. This is not a substitute for per-user quotas.
    if (reviewInFlight) {
      return rejectRequest(req, res, 429, 'Another video review is in progress. Please wait and try again.');
    }

    // Do not trust client-supplied X-Forwarded-For. Behind a proxy, this simple
    // guard may group multiple users together and is not a reliable user quota.
    const address = req.socket.remoteAddress || 'unknown';
    const time = now();
    const previous = reviewTimes.get(address);
    if (previous !== undefined && time - previous < REVIEW_COOLDOWN_MS) {
      const retryAfter = Math.max(1, Math.ceil((REVIEW_COOLDOWN_MS - (time - previous)) / 1000));
      return rejectRequest(req, res, 429, `Please wait ${retryAfter} second${retryAfter === 1 ? '' : 's'} before requesting another video review.`, { 'Retry-After': retryAfter });
    }
    if (reviewTimes.size >= 500) {
      for (const [ip, lastReview] of reviewTimes) {
        if (time - lastReview > REVIEW_COOLDOWN_MS * 4) reviewTimes.delete(ip);
      }
      if (reviewTimes.size >= 1000) reviewTimes.delete(reviewTimes.keys().next().value);
    }
    reviewTimes.set(address, time);
    reviewInFlight = true;

    try {
      const video = await readLimitedBody(req, MAX_VIDEO_BYTES);
      const focus = Buffer.from(String(req.headers['x-review-focus'] || ''), 'base64').toString('utf8').slice(0, 500);
      const instruction = [
        'You are a careful sports short-form video editing coach. Review the attached video and help the creator make an original, clearer edit.',
        'Analyze only what you can actually see or hear. Do not invent players, teams, scores, dates, sounds, camera moves, transitions, or exact edits. Mark uncertainty plainly.',
        'Give a concise step-by-step review with approximate timestamps: opening hook; visible sequence and shot changes; text/graphics; pacing; audio cues if clearly audible; payoff/ending; and 3 concrete original improvement suggestions.',
        'If timestamps or details cannot be determined reliably, say so instead of guessing. Do not promise virality. Do not encourage copying another creator frame-for-frame.',
        'Rights reminder: do not assume that sports broadcast footage, another creator’s edit, or music is licensed just because it is publicly viewable.',
        focus ? `Creator focus: ${focus}` : '',
      ].filter(Boolean).join('\n\n');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
      const abortIfDisconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', abortIfDisconnected);
      try {
        const upstream = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { inline_data: { mime_type: contentType, data: video.toString('base64') } },
                { text: instruction },
              ],
            }],
            // Use the Gemini 3 default temperature recommended by Google.
            generationConfig: { maxOutputTokens: 8192 },
          }),
          signal: controller.signal,
        });
        if (!upstream.ok) {
          if (upstream.body && typeof upstream.body.cancel === 'function') await upstream.body.cancel().catch(() => {});
          const status = upstream.status === 429 ? 429 : 502;
          const message = upstream.status === 429
            ? 'The AI provider is rate limiting this request. Wait and try again.'
            : 'The AI provider could not review this file. Check the model, video format, account and server setup.';
          return sendJson(res, status, { error: message });
        }
        const providerData = await readProviderJson(upstream);
        const finishReason = geminiFinishReason(providerData);
        if (finishReason === 'MAX_TOKENS') return sendJson(res, 502, { error: 'The AI review reached its output limit before finishing. Try a shorter clip or a narrower question.' });
        if (finishReason && finishReason !== 'STOP') return sendJson(res, 502, { error: 'The AI provider could not return a complete review of this clip.' });
        const parts = providerData?.candidates?.[0]?.content?.parts;
        const text = Array.isArray(parts) ? parts.filter(part => part && part.thought !== true && typeof part.text === 'string').map(part => part.text).join('\n\n').trim().slice(0, 24000) : '';
        if (!text) return sendJson(res, 502, { error: 'The AI provider returned no readable review.' });
        return sendJson(res, 200, { text, model: config.model });
      } finally {
        clearTimeout(timeout);
        res.off('close', abortIfDisconnected);
      }
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (error.statusCode) {
        return sendJson(res, error.statusCode, { error: error.message }, error.statusCode === 413 ? { Connection: 'close' } : undefined);
      }
      if (error.name === 'AbortError') return sendJson(res, 504, { error: 'The AI review took too long. Try a shorter clip.' });
      // Never log video, prompts, provider responses, or the API key.
      console.error('Video review failed due to a network or server error.');
      return sendJson(res, 502, { error: 'The video review could not be completed. No raw video is written to this server.' });
    } finally {
      reviewInFlight = false;
    }
  }

  async function readProviderJson(response) {
    const length = Number(response.headers?.get?.('content-length') || 0);
    if (length > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('Provider response too large');
    // A capped stream avoids retaining an unexpectedly large provider response.
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_PROVIDER_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error('Provider response too large');
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    }
    // Also supports simple mock providers in tests.
    return response.json();
  }

  async function callProvider(url, headers, payload, res) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    const abortIfDisconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abortIfDisconnected);
    try {
      const upstream = await fetchImpl(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload), signal: controller.signal,
      });
      if (!upstream.ok) {
        const error = new Error('AI provider rejected the request');
        error.providerStatus = upstream.status;
        if (upstream.body && typeof upstream.body.cancel === 'function') await upstream.body.cancel().catch(() => {});
        throw error;
      }
      return await readProviderJson(upstream);
    } finally {
      clearTimeout(timeout);
      res.off('close', abortIfDisconnected);
    }
  }

  function providerFailure(error, feature) {
    if (error.name === 'AbortError') return `${feature} took too long or was canceled. Try again later.`;
    if (error.providerStatus === 429) return `${feature} hit a provider rate limit or quota. Wait or check the provider account.`;
    if ((error.providerStatus === 401 || error.providerStatus === 403) && feature.startsWith('Arena')) return `${feature} was not authorized. Check the Arena key, workspace API access and enabled model. Free coding-router keys may be limited to Claude Code.`;
    if (error.providerStatus === 401 || error.providerStatus === 403) return `${feature} was not authorized. Check the server's provider key, account access and enabled model.`;
    if (error.providerStatus === 404) return `${feature} could not find the configured provider model. Check the model name and account access.`;
    if (error.providerStatus === 400 && feature === 'Gemini Coach') return 'Gemini rejected this request. Check that the video is public and the model supports it; if using fast-action focus, turn it off and try again.';
    if (error.providerStatus >= 500) return `${feature} is temporarily unavailable at the provider. Try again later.`;
    return `${feature} could not be completed. Check the provider key, model, account access and server settings.`;
  }

  async function coach(req, res) {
    if (!config.ready && !config.arenaReady) return rejectRequest(req, res, 503, 'AI Coach is not configured on this server. Nothing was sent.');
    if (!originMatchesRequest(req)) return rejectRequest(req, res, 403, 'This request did not come from the Cutline page. Nothing was sent.');
    if (req.headers['x-coach-consent'] !== 'yes') return rejectRequest(req, res, 400, 'Confirm the Coach privacy notice before sending.');
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') return rejectRequest(req, res, 415, 'Coach requests must use JSON.');
    if (Number(req.headers['content-length'] || 0) > MAX_COACH_BODY_BYTES) {
      return rejectRequest(req, res, 413, 'This Coach request is too large.', { Connection: 'close' });
    }
    if (coachInFlight) return rejectRequest(req, res, 429, 'Another Coach request is in progress. Please wait.');
    coachInFlight = true;
    try {
      const bytes = await readLimitedBody(req, MAX_COACH_BODY_BYTES, { tooLarge: 'This Coach request is too large.', empty: 'Enter a message for the Coach.' });
      let input;
      try { input = JSON.parse(bytes.toString('utf8')); } catch (_) { return sendJson(res, 400, { error: 'The Coach request was not valid JSON.' }); }
      let request;
      try { request = normalizeCoachRequest(input); } catch (error) { return sendJson(res, 400, { error: error.message }); }
      if (request.engine === 'gemini' && !config.ready) return sendJson(res, 503, { error: 'Gemini Coach is not configured. Nothing was sent.' });
      if (request.engine === 'arena' && !config.arenaReady) return sendJson(res, 503, { error: 'Arena Coach is not configured. Nothing was sent.' });
      if (request.engine === 'arena' && request.research) return sendJson(res, 400, { error: 'Google Search research requires Gemini mode. Nothing was sent.' });
      if (request.research && !config.researchReady) return sendJson(res, 403, { error: 'Live Google Search research is not enabled by the owner. No request was sent.' });
      if (request.arena && !config.arenaReady) return sendJson(res, 403, { error: 'Arena creative director is not configured by the owner. No request was sent.' });

      const address = req.socket.remoteAddress || 'unknown';
      const time = now();
      const previous = coachTimes.get(address);
      if (previous !== undefined && time >= previous && time - previous < COACH_COOLDOWN_MS) {
        const retryAfter = Math.max(1, Math.ceil((COACH_COOLDOWN_MS - (time - previous)) / 1000));
        return sendJson(res, 429, { error: `Please wait ${retryAfter} seconds before another Coach request.` }, { 'Retry-After': retryAfter });
      }
      if (coachTimes.size >= 500) {
        for (const [ip, last] of coachTimes) if (time - last > COACH_COOLDOWN_MS * 4 || time < last) coachTimes.delete(ip);
        if (coachTimes.size >= 1000) coachTimes.delete(coachTimes.keys().next().value);
      }
      coachTimes.set(address, time);

      if (request.engine === 'arena') {
        try {
          const data = await callProvider('https://api.arena.ai/v1/chat/completions', { Authorization: `Bearer ${config.arenaKey}` }, arenaRequestPayload(request, '', config.arenaModel), res);
          const result = parseArenaResponse(data);
          if (!result.text) return sendJson(res, 502, { error: 'Arena returned no readable answer.' });
          return sendJson(res, 200, { answer: result.text, clips: [], youtubeUrl: null, provider: 'arena', model: config.arenaModel, ...(result.recipe ? { arenaRecipe: result.recipe } : {}) });
        } catch (error) {
          if (res.destroyed || res.writableEnded) return;
          const status = error.name === 'AbortError' ? 504 : (error.providerStatus === 429 ? 429 : 502);
          return sendJson(res, status, { error: providerFailure(error, 'Arena Coach') });
        }
      }

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`;
      let data;
      try {
        data = await callProvider(geminiUrl, { 'x-goog-api-key': config.apiKey }, coachRequestPayload(request), res);
      } catch (error) {
        if (res.destroyed || res.writableEnded) return;
        const status = error.name === 'AbortError' ? 504 : (error.providerStatus === 429 ? 429 : 502);
        return sendJson(res, status, { error: providerFailure(error, 'Gemini Coach') });
      }
      if (geminiFinishReason(data) === 'MAX_TOKENS') {
        return sendJson(res, 502, { error: 'Gemini reached its output limit before finishing. Try a shorter question or a focused video range.' });
      }
      const result = parseCoachResponse(data, Boolean(request.youtubeUrl), request.videoFocus);
      if (!result) return sendJson(res, 502, { error: 'Gemini returned no complete readable answer. The video may be unavailable, unsupported or blocked.' });
      const output = { ...result, youtubeUrl: request.youtubeUrl, model: config.model };

      if (request.research && !res.destroyed) {
        try {
          const researchData = await callProvider(geminiUrl, { 'x-goog-api-key': config.apiKey }, researchRequestPayload(request, result.answer), res);
          output.research = parseResearchResponse(researchData);
          if (!output.research) output.researchError = 'Google Search returned no usable research. The ideas above are not live-researched.';
        } catch (error) {
          output.researchError = providerFailure(error, 'Google Search research');
        }
      }
      if (request.arena && !res.destroyed) {
        try {
          const arenaData = await callProvider('https://api.arena.ai/v1/chat/completions', { Authorization: `Bearer ${config.arenaKey}` }, arenaRequestPayload(request, result.answer, config.arenaModel), res);
          const arenaResult = parseArenaResponse(arenaData);
          output.arena = arenaResult.text;
          if (arenaResult.recipe) output.arenaRecipe = arenaResult.recipe;
          if (!output.arena) output.arenaError = 'Arena returned no readable creative polish.';
        } catch (error) {
          output.arenaError = providerFailure(error, 'Arena creative polish');
        }
      }
      return sendJson(res, 200, output);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (error.statusCode) return sendJson(res, error.statusCode, { error: error.message }, error.statusCode === 413 ? { Connection: 'close' } : undefined);
      // Never log prompts, links, provider responses, credentials or media.
      console.error('Coach request failed due to a network or server error.');
      return sendJson(res, 502, { error: 'The Coach request could not be completed.' });
    } finally {
      coachInFlight = false;
    }
  }

  const server = http.createServer(async (req, res) => {
    // Clients can disconnect while a rejected request is being drained.
    req.on('error', () => {});
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url || '/', 'http://cutline.local');
    } catch (_) {
      return rejectRequest(req, res, 400, 'Invalid request URL.');
    }
    const pathname = parsedUrl.pathname;
    const isRead = req.method === 'GET' || req.method === 'HEAD';

    // These two narrowly scoped routes are intentionally public: only a
    // user-published random link can reveal its sanitized TikTok snapshot.
    const publicPage = /^\/p\/([A-Za-z0-9_-]{24})$/.exec(pathname);
    const publicApi = /^\/api\/public-profile\/([A-Za-z0-9_-]{24})$/.exec(pathname);
    if (publicPage || publicApi) {
      if (!tiktok.ready) return rejectRequest(req, res, 404, 'Not found.');
      if (publicPage) {
        if (!isRead) return methodNotAllowed(req, res, ['GET', 'HEAD']);
        req.resume();
        try {
          return send(res, 200, await readFile(publicProfileFile), 'text/html; charset=utf-8', {
            'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow',
            'Content-Security-Policy': "frame-ancestors 'none'; default-src 'self'; img-src https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'",
          });
        } catch (_) { return sendJson(res, 500, { error: 'Unable to load this profile.' }); }
      }
      if (req.method !== 'GET') return methodNotAllowed(req, res, ['GET']);
      req.resume();
      try { return sendJson(res, 200, await tiktok.publicProfile(publicApi[1]), { 'Referrer-Policy': 'no-referrer' }); }
      catch (error) { return sendJson(res, error.status || 503, { error: error.status ? error.message : 'Profile unavailable.' }, { 'Referrer-Policy': 'no-referrer' }); }
    }

    if (!authorize(req, res)) return;

    if (pathname === '/' || pathname === '/index.html') {
      if (!isRead) return methodNotAllowed(req, res, ['GET', 'HEAD']);
      req.resume();
      try {
        return send(res, 200, await readFile(indexFile), 'text/html; charset=utf-8');
      } catch (_) {
        return sendJson(res, 500, { error: 'Unable to load the application.' });
      }
    }

    if (pathname === '/editor-core.js') {
      if (!isRead) return methodNotAllowed(req, res, ['GET', 'HEAD']);
      req.resume();
      try { return send(res, 200, await readFile(editorCoreFile), 'text/javascript; charset=utf-8'); }
      catch (_) { return sendJson(res, 500, { error: 'Unable to load the editor.' }); }
    }

    if (pathname === '/api/health') {
      if (!isRead) return methodNotAllowed(req, res, ['GET', 'HEAD']);
      req.resume();
      return sendJson(res, 200, {
        videoReviewReady: config.ready,
        coachReady: config.ready,
        researchReady: config.researchReady,
        arenaReady: config.arenaReady,
        tiktokReady: tiktok.ready,
        model: config.model,
        maxVideoBytes: MAX_VIDEO_BYTES,
        message: config.ready
          ? 'A model is configured, but has not been connection-tested. Each clip requires confirmation.'
          : 'Video AI is off or missing a key or access protection. No clip is sent automatically.',
      });
    }

    if (pathname.startsWith('/api/tiktok/')) {
      // OAuth callbacks are browser navigations; state and a secure HttpOnly
      // session cookie are checked before the code is ever exchanged.
      if (pathname === '/api/tiktok/callback') {
        if (req.method !== 'GET') return methodNotAllowed(req, res, ['GET']);
        req.resume();
        let outcome = 'error';
        if (!parsedUrl.searchParams.has('error')) {
          try {
            await tiktok.finish(req.headers.cookie, parsedUrl.searchParams.get('state'), parsedUrl.searchParams.get('code'));
            outcome = 'connected';
          } catch (_) { /* Avoid putting provider errors, codes or tokens in URLs or logs. */ }
        } else outcome = 'denied';
        res.writeHead(303, { Location: '/?tiktok=' + outcome, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        return res.end();
      }
      if (pathname === '/api/tiktok/profile') {
        if (!isRead) return methodNotAllowed(req, res, ['GET', 'HEAD']);
        req.resume();
        try { return sendJson(res, 200, await tiktok.mine(req.headers.cookie)); }
        catch (error) { return sendJson(res, error.status || 503, { error: error.status ? error.message : 'Profile storage is unavailable.' }); }
      }
      if (!['/api/tiktok/connect', '/api/tiktok/refresh', '/api/tiktok/share', '/api/tiktok/disconnect'].includes(pathname)) return rejectRequest(req, res, 404, 'Not found.');
      if (req.method !== 'POST') return methodNotAllowed(req, res, ['POST']);
      if (!originMatchesRequest(req) || req.headers['x-cutline-tiktok'] !== 'yes') return rejectRequest(req, res, 403, 'This request must come from the Cutline page.');
      try {
        if (pathname === '/api/tiktok/connect') {
          req.resume();
          const result = tiktok.begin(req.headers.cookie);
          return sendJson(res, 200, { url: result.url }, { 'Set-Cookie': result.cookie, 'Referrer-Policy': 'no-referrer' });
        }
        if (pathname === '/api/tiktok/refresh') {
          req.resume();
          return sendJson(res, 200, await tiktok.mine(req.headers.cookie, true));
        }
        if (pathname === '/api/tiktok/disconnect') {
          req.resume();
          const result = await tiktok.disconnect(req.headers.cookie);
          return sendJson(res, 200, result, { 'Set-Cookie': tiktok.clearSessionCookie() });
        }
        const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/json') return rejectRequest(req, res, 415, 'Sharing settings must use JSON.');
        if (Number(req.headers['content-length'] || 0) > 1024) return rejectRequest(req, res, 413, 'Sharing settings are too large.', { Connection: 'close' });
        const bytes = await readLimitedBody(req, 1024, { tooLarge: 'Sharing settings are too large.', empty: 'Choose whether to share your profile.' });
        let body;
        try { body = JSON.parse(bytes.toString('utf8')); } catch (_) { return sendJson(res, 400, { error: 'Sharing settings were not valid JSON.' }); }
        if (!body || typeof body.share !== 'boolean') return sendJson(res, 400, { error: 'Choose whether to share your profile.' });
        return sendJson(res, 200, await tiktok.share(req.headers.cookie, body.share));
      } catch (error) {
        return sendJson(res, error.status || error.statusCode || 503, { error: error.status || error.statusCode ? error.message : 'TikTok profile is unavailable.' });
      }
    }

    if (pathname === '/api/video-review') {
      if (req.method !== 'POST') return methodNotAllowed(req, res, ['POST']);
      return reviewVideo(req, res);
    }

    if (pathname === '/api/coach') {
      if (req.method !== 'POST') return methodNotAllowed(req, res, ['POST']);
      return coach(req, res);
    }

    if (pathname === '/favicon.ico' && isRead) {
      req.resume();
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }

    return rejectRequest(req, res, 404, 'Not found.');
  });
  server.requestTimeout = 120_000;
  return server;
}

if (require.main === module) {
  // A service manager can restart this mode without ever falling back to the
  // open local prototype if its secret is lost or misconfigured. Loopback does
  // not itself make a reverse proxy private; the password is still required.
  const safeLocal = process.argv.slice(2).includes('--safe-local');
  const port = Number(process.env.PORT || '4173');
  const host = safeLocal ? '127.0.0.1' : (process.env.HOST || '0.0.0.0');
  const config = configuration(process.env);

  if (safeLocal && !config.passwordValid) {
    console.error('Safe local mode requires a valid CUTLINE_ACCESS_PASSWORD of 16–256 characters; server not started.');
    process.exitCode = 1;
  } else if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('PORT must be an integer between 0 and 65535.');
    process.exitCode = 1;
  } else {
    const server = createServer();
    server.on('error', error => {
      console.error('Could not start Cutline Studio:', error.message);
      process.exitCode = 1;
    });
    server.listen(port, host, () => {
      const address = server.address();
      const access = config.passwordValid ? 'protected' : (config.passwordProvided ? 'blocked (invalid password)' : 'unprotected');
      const coach = config.ready ? (config.arenaReady ? 'Gemini and Arena configured' : 'Gemini configured') : (config.arenaReady ? 'Arena text configured' : 'off');
      console.log(`Cutline Studio is listening on ${host}:${address.port}; access ${access}; video AI ${config.ready ? 'configured' : 'off'}; Coach ${coach}.`);
      if (config.passwordProvided && !config.passwordValid) {
        console.warn('Access password is invalid; all requests are blocked. Use a unique password of 16–256 characters.');
      }
      if (config.aiRequested && !config.passwordValid) {
        console.warn('Video AI remains off until a valid access password is configured.');
      }
      if (config.ready || config.arenaReady) {
        console.warn('Shared-password protection is for personal testing only; per-user quotas are not implemented. Use HTTPS.');
      }
    });
  }
}

module.exports = { createServer, MAX_VIDEO_BYTES };
