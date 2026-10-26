# Cutline Studio

A phone-first sports-editing prototype with local clip preview and editing, sample Coach conversations, and an optional per-clip Gemini video review route.

## Run

Requires Node.js 20 or newer. No npm packages or API keys are needed for the local prototype.

```sh
npm start
```

Open **http://localhost:4173**. The server listens on `PORT` (default `4173`) and binds to `0.0.0.0` by default for hosting and previews. For local-only access, set `HOST=127.0.0.1`. On macOS or Linux, for example:

```sh
HOST=127.0.0.1 PORT=4173 npm start
```

In PowerShell, use `$env:HOST='127.0.0.1'; $env:PORT='4173'; npm start`.

Run the automated server checks with `npm test`.

## Optional Gemini video review

Video AI is **off by default**. To configure it, set these as server-side environment variables using your hosting provider's secret settings or another secure method:

- `GEMINI_API_KEY` — your Gemini API key. Never put it in `index.html`, the repository, or chat.
- `CUTLINE_AI_ENABLED=true` — explicit enable switch. Leave it unset or false to disable review.
- `GEMINI_MODEL` — optional model name; defaults to `gemini-3.8-flash`.

The server reads environment variables at startup; it does not automatically load a `.env` file. Restart the server after changing settings. `/api/health` reports whether the key and switch are present, **not** whether the key or provider connection has been verified. The local clip inspector and editor work without Gemini.

When enabled, the browser asks for confirmation for each clip before sending it to the server and Google Gemini. The server accepts supported video types up to **14 MiB** per request; this leaves room for base64 and prompt overhead in an inline request. See Google's [video input guidance](https://ai.google.dev/gemini-api/docs/generate-content/video-understanding). Google’s [terms](https://ai.google.dev/gemini-api/terms), privacy rules, rate limits, model availability, and possible charges apply; unpaid-service content may be used to improve Google products. Only send footage you are authorized and comfortable sharing.

### Important security limitation

The consent and origin headers can be forged. This prototype has **no real authentication, authorization, or per-user quotas**, and its 30-second peer-IP cooldown is only a lightweight guard (a proxy can group many users together). Do **not** enable AI on a public deployment until proper server-side access controls and quotas are implemented and tested. For a private local test, bind to `127.0.0.1`, keep the key in your environment, and enable AI only when you intend to use it.

## What works in this preview

- The clip inspector samples frames and reads metadata locally. The editor previews, trims, reframes, adds text and audio, and attempts to export short clips in the browser. Supported formats and export features depend on the browser and device.
- Coach replies are **sample templates**, not live AI. Chats, saved reference links, and the theme are stored in the current browser's local storage.
- Video and audio selections are temporary. Previewing, scanning, and editing stay in the browser; a video leaves the device only if you explicitly confirm a configured AI review. Reference links are saved but not fetched.
- Sign-in and cloud sync are not connected. No video is written to the server's disk by the review route.

This is a development prototype, not a production server. Use it only on trusted networks and use footage and music you have permission to edit.
