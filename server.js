'use strict';

// Cutline Studio's dependency-free preview server. AI review is opt-in and
// requires a server-side key; this is not an authenticated production service.
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const indexFile = path.join(__dirname, 'index.html');
const DEFAULT_MODEL = 'gemini-3.8-flash';
// Inline requests also contain base64 and prompt overhead. Leave room below
// Gemini's recommended 20 MB total request size for short video inputs.
const MAX_VIDEO_BYTES = 14 * 1024 * 1024;
const REVIEW_COOLDOWN_MS = 30_000;
const PROVIDER_TIMEOUT_MS = 120_000;
const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4', 'video/mpeg', 'video/mov', 'video/quicktime', 'video/avi',
  'video/x-flv', 'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp',
]);

function configuration(env) {
  const requestedModel = String(env.GEMINI_MODEL || '');
  const model = /^[a-zA-Z0-9._-]{1,80}$/.test(requestedModel) ? requestedModel : DEFAULT_MODEL;
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  return { model, apiKey, ready: env.CUTLINE_AI_ENABLED === 'true' && apiKey.length > 0 };
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

function readLimitedBody(req, maxBytes) {
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
        fail(uploadError(413, 'For AI review, choose a video no larger than 14 MB.'));
      } else {
        chunks.push(chunk);
      }
    });
    req.once('end', () => {
      if (settled) return;
      if (!size) return fail(uploadError(400, 'The uploaded video was empty.'));
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
    req.once('aborted', () => fail(uploadError(400, 'The upload was interrupted.')));
    req.once('error', fail);
  });
}

function createServer({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const config = configuration(env);
  const reviewTimes = new Map();

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
            generationConfig: { temperature: 0.25, maxOutputTokens: 1600 },
          }),
          signal: controller.signal,
        });
        let providerData;
        try {
          providerData = await upstream.json();
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          providerData = {};
        }
        if (!upstream.ok) {
          const status = upstream.status === 429 ? 429 : 502;
          const message = upstream.status === 429
            ? 'The AI provider is rate limiting this request. Wait and try again.'
            : 'The AI provider could not review this file. Check the model, video format, account and server setup.';
          return sendJson(res, status, { error: message });
        }
        const parts = providerData?.candidates?.[0]?.content?.parts || [];
        const text = parts.map(part => part.text || '').filter(Boolean).join('\n\n').trim();
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
    }
  }

  const server = http.createServer(async (req, res) => {
    // Clients can disconnect while a rejected request is being drained.
    req.on('error', () => {});
    let pathname;
    try {
      pathname = new URL(req.url || '/', 'http://cutline.local').pathname;
    } catch (_) {
      return rejectRequest(req, res, 400, 'Invalid request URL.');
    }
    const isRead = req.method === 'GET' || req.method === 'HEAD';

    if (pathname === '/' || pathname === '/index.html') {
      if (!isRead) return methodNotAllowed(req, res, ['GET', 'HEAD']);
      req.resume();
      try {
        return send(res, 200, await readFile(indexFile), 'text/html; charset=utf-8');
      } catch (_) {
        return sendJson(res, 500, { error: 'Unable to load the application.' });
      }
    }

    if (pathname === '/api/health') {
      if (!isRead) return methodNotAllowed(req, res, ['GET', 'HEAD']);
      req.resume();
      return sendJson(res, 200, {
        videoReviewReady: config.ready,
        model: config.model,
        maxVideoBytes: MAX_VIDEO_BYTES,
        message: config.ready
          ? 'A model is configured, but has not been connection-tested. Each clip requires confirmation.'
          : 'Video AI is off or missing a key. No clip is sent automatically.',
      });
    }

    if (pathname === '/api/video-review') {
      if (req.method !== 'POST') return methodNotAllowed(req, res, ['POST']);
      return reviewVideo(req, res);
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
  const port = Number(process.env.PORT || '4173');
  const host = process.env.HOST || '0.0.0.0';

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
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
      const aiConfigured = configuration(process.env).ready;
      console.log(`Cutline Studio is listening on ${host}:${address.port}; video AI ${aiConfigured ? 'configured' : 'off'}.`);
      if (aiConfigured) console.warn('AI review has no built-in authentication or per-user quotas. Do not expose it publicly without access controls.');
    });
  }
}

module.exports = { createServer, MAX_VIDEO_BYTES };
