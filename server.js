// Cutline Studio's lightweight, dependency-free preview server.
// Configure GEMINI_API_KEY and CUTLINE_AI_ENABLED=true only on a trusted server.
// Before public launch, add real account authentication and stronger per-user quotas.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 4173);
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const REVIEW_COOLDOWN_MS = 30_000;
const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4', 'video/mpeg', 'video/mov', 'video/quicktime', 'video/avi',
  'video/x-flv', 'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp',
]);
const MODEL = /^[a-zA-Z0-9._-]{1,80}$/.test(process.env.GEMINI_MODEL || '')
  ? process.env.GEMINI_MODEL
  : 'gemini-3.8-flash';
const reviewTimes = new Map();

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store, private',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  res.end(body);
}

function aiReady() {
  return process.env.CUTLINE_AI_ENABLED === 'true' && Boolean(process.env.GEMINI_API_KEY);
}

function clientAddress(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function originMatchesRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
    const requestHost = String(req.headers.host || '').split(',')[0].trim().toLowerCase();
    return originHost === forwardedHost || originHost === requestHost;
  } catch (_) {
    return false;
  }
}

async function readLimitedBody(req, maxBytes) {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > maxBytes) {
    req.resume();
    const error = new Error('For this first AI connection, upload a video no larger than 20 MB.');
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(chunk);
    }
  }
  if (tooLarge) {
    const error = new Error('For this first AI connection, upload a video no larger than 20 MB.');
    error.statusCode = 413;
    throw error;
  }
  if (!size) {
    const error = new Error('The uploaded video was empty.');
    error.statusCode = 400;
    throw error;
  }
  return Buffer.concat(chunks, size);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://cutline.local');
  if (req.method === 'GET' && requestUrl.pathname === '/api/health') {
    return sendJson(res, 200, {
      videoReviewReady: aiReady(),
      model: MODEL,
      maxVideoBytes: MAX_VIDEO_BYTES,
      message: aiReady()
        ? 'A server-side model is configured; each clip still requires explicit confirmation.'
        : 'No model call is available. No uploaded video will be sent.',
    });
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/video-review') {
    if (!aiReady()) return sendJson(res, 503, { error: 'The secure AI provider is not configured on this server. No video was sent.' });
    if (!originMatchesRequest(req)) return sendJson(res, 403, { error: 'This request did not come from the Cutline page. No video was sent.' });
    if (req.headers['x-clip-consent'] !== 'yes') return sendJson(res, 400, { error: 'Confirm the per-clip consent before sending a video.' });

    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_VIDEO_TYPES.has(contentType)) return sendJson(res, 415, { error: 'This video type is not supported by the current AI review route.' });

    const address = clientAddress(req);
    const now = Date.now();
    const previous = reviewTimes.get(address) || 0;
    if (now - previous < REVIEW_COOLDOWN_MS) {
      return sendJson(res, 429, { error: 'Please wait 30 seconds before requesting another video review.' });
    }
    reviewTimes.set(address, now);
    if (reviewTimes.size > 500) {
      for (const [ip, time] of reviewTimes) if (now - time > REVIEW_COOLDOWN_MS * 4) reviewTimes.delete(ip);
    }

    try {
      const video = await readLimitedBody(req, MAX_VIDEO_BYTES);
      let focus = '';
      try { focus = Buffer.from(String(req.headers['x-review-focus'] || ''), 'base64').toString('utf8').slice(0, 500); } catch (_) {}
      const instruction = [
        'You are a careful sports short-form video editing coach. Review the attached video and help the creator make an original, clearer edit.',
        'Analyze only what you can actually see or hear. Do not invent players, teams, scores, dates, sounds, camera moves, transitions, or exact edits. Mark uncertainty plainly.',
        'Give a concise step-by-step review with approximate timestamps: opening hook; visible sequence and shot changes; text/graphics; pacing; audio cues if clearly audible; payoff/ending; and 3 concrete original improvement suggestions.',
        'If timestamps or details cannot be determined reliably, say so instead of guessing. Do not promise virality. Do not encourage copying another creator frame-for-frame.',
        'Rights reminder: do not assume that sports broadcast footage, another creator’s edit, or music is licensed just because it is publicly viewable.',
        focus ? `Creator focus: ${focus}` : '',
      ].filter(Boolean).join('\n\n');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      let upstream;
      try {
        upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY,
          },
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
      } finally {
        clearTimeout(timeout);
      }

      const providerData = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        const status = upstream.status === 429 ? 429 : 502;
        const message = upstream.status === 429
          ? 'The AI provider’s free-tier rate limit was reached. Wait and try again; no extra service has been enabled.'
          : 'The AI provider could not review this file. Check its supported video format, free-tier eligibility and server setup.';
        return sendJson(res, status, { error: message });
      }
      const parts = providerData?.candidates?.[0]?.content?.parts || [];
      const text = parts.map(part => part.text || '').filter(Boolean).join('\n\n').trim();
      if (!text) return sendJson(res, 502, { error: 'The AI provider returned no readable review.' });
      return sendJson(res, 200, { text, model: MODEL });
    } catch (error) {
      if (error.statusCode) return sendJson(res, error.statusCode, { error: error.message });
      if (error.name === 'AbortError') return sendJson(res, 504, { error: 'The AI review took too long. Try a shorter clip.' });
      console.error('Video review failed:', error.message || 'unknown server error');
      return sendJson(res, 500, { error: 'The video review could not be completed. No raw video is written to this server.' });
    }
  }

  if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
    try {
      const body = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      });
      return res.end(body);
    } catch (_) {
      return sendJson(res, 500, { error: 'Cutline Studio page could not be read.' });
    }
  }

  if (req.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }
  return sendJson(res, 404, { error: 'Not found.' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Cutline Studio listening on 0.0.0.0:${PORT}; video AI ${aiReady() ? 'enabled' : 'not configured'}.`);
});
