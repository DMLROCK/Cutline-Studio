# Cutline Studio

A phone-first sports-editing prototype with local clip preview/edit controls and an optional per-clip Gemini video review route.

## Run

Requires Node.js 20 or newer. No npm packages are required.

```bash
npm start
```

The server listens on `PORT` (default `4173`) and binds to `0.0.0.0` for hosting. Visit `/` for the editor and `/api/health` for connection status.

## Gemini configuration (server-side only)

Set these in your hosting provider's **secret/environment settings**, never in the browser, `index.html`, or this repository:

- `GEMINI_API_KEY` — secret API key from Google AI Studio.
- `CUTLINE_AI_ENABLED=true` — explicit enable switch. Leave unset/false by default.
- `GEMINI_MODEL` — optional; defaults to `gemini-3.8-flash`.

The key is not included in this repository. Do not paste it into GitHub, chat, or client-side code.

## Important safety limitation

This prototype has a per-clip consent step in the UI and a lightweight per-IP cooldown, but it does **not** have real sign-in, owner authorization, or reliable per-user quotas. Client-side consent headers can be forged. Therefore, do **not** set `CUTLINE_AI_ENABLED=true` on a public deployment until server-side access control and quotas are implemented and tested. You can deploy/test the editor with AI disabled.

Cloud AI sends an uploaded clip to Google only after the user confirms for that clip; provider terms and free-tier limits apply. Upload only footage you own or are authorized to submit. Social links are references; the app does not download them.

## Project files

- `index.html` — studio UI and browser-side editing prototype.
- `server.js` — static server and optional Gemini review endpoint.
- `SETUP.md` — detailed setup and limitations.
- `AI_STUDIO_IMPORT_PROMPT.md` — prompt for reviewing this repository in Google AI Studio Build Mode.
