# Cutline Studio

A phone-first sports-editing prototype with local clip preview and editing, sample Coach conversations, and an optional per-clip Gemini video review route.

## Run

Requires Node.js 20 or newer. No npm packages or API keys are needed for the local prototype.

```sh
npm start
```

Open **http://localhost:4173**. The server listens on `PORT` (default `4173`) and binds to `0.0.0.0` by default for hosting and previews. If no access password is configured, the app is **open to anyone who can reach it** and video AI stays off. For local-only access, set `HOST=127.0.0.1`. On macOS or Linux, for example:

```sh
HOST=127.0.0.1 PORT=4173 npm start
```

In PowerShell, use `$env:HOST='127.0.0.1'; $env:PORT='4173'; npm start`.

Run the automated server checks with `npm test`.

## Private preview access

Set `CUTLINE_ACCESS_PASSWORD` as a **runtime secret** before deploying a private preview. Choose a unique, randomly generated password of at least 16 characters (the server accepts 16–256 characters; control characters and all-whitespace passwords are rejected). Use a password manager or other secure generator; never use your Gemini key as the password. Keep it out of source code, builds, screenshots, and chat.

With a valid password, every route requires HTTP Basic authentication. Open the app's **HTTPS** URL directly in your browser; when prompted, use the username `cutline` and your private password. Do not use this login over plain HTTP on the internet: Basic credentials would be exposed in transit. Browsers may remember credentials until the browser session ends; private browsing is useful for testing the prompt. The protected app cannot be embedded in a frame.

If `CUTLINE_ACCESS_PASSWORD` is **absent**, the local prototype is accessible without a login, but AI review is disabled even if a key and enable flag are present. If the variable is present but invalid or empty, **all routes fail closed**. Changes to runtime variables require a server restart or redeploy. Always check from a private/incognito browser that an unauthenticated visit prompts for a login before adding a provider key.

This shared password is only for a small personal test: it is not individual user accounts, a logout system, or production-grade access management. The server compares fixed-size credential digests using a timing-safe comparison and temporarily throttles repeated failed login attempts. That throttle is in memory, resets on restart, and uses the socket peer rather than trusting forwarded IP headers; a proxy may group visitors together and block even correct logins for up to a minute. It is not distributed brute-force protection. Anyone with the shared password can use the app and spend the key's quota. Do not share it publicly or enable billing beyond what you can afford. For a public or multi-user launch, add proper authentication, per-user quotas, durable rate limiting, and budget controls.

### Suga personal preview

1. Import this repository and the intended branch as a Node service. In the service's **Env Vars** tab, add `CUTLINE_ACCESS_PASSWORD` as a runtime value and mark it **Sensitive** with the lock **before saving**. Store the password privately; saved sensitive values cannot be read back.
2. Set the non-secret runtime variable `PORT` to `4173`. In **Config**, configure a generated **HTTPS** URL targeting port **4173**, and allocate up to **256 MiB** of memory if your plan permits it. Do not expose a public TCP port for this app.
3. Check the provider's current plan, resource limits and billing before clicking **Apply**. Once the updated service is active, open its HTTPS URL directly in an incognito/private tab and confirm it asks for `cutline` and the password. Do not add the Google key if it does not.
4. Only after verifying the prompt, add `GEMINI_API_KEY` as another **Sensitive** runtime variable and `CUTLINE_AI_ENABLED=true`, then apply the changes. Changes to runtime variables and resources require Apply. Branch pushes can automatically rebuild and redeploy using the active configuration.

Suga's Free plan has no uptime SLA, and its pricing and metering may change. Google Gemini usage is billed separately under your Google account's applicable terms. The 256 MiB limit has not been validated against real hosted Gemini requests and may be insufficient for large clips; the server permits only one review at a time to reduce memory pressure.

## Optional Gemini video review

Video AI is **off by default**. To configure it, set these server-side environment variables using your hosting provider's runtime secret settings or another secure method:

- `CUTLINE_ACCESS_PASSWORD` — the unique private preview password described above. Mark it sensitive.
- `GEMINI_API_KEY` — your Gemini API key. Mark it sensitive; never put it in `index.html`, the repository, or chat.
- `CUTLINE_AI_ENABLED=true` — explicit enable switch. Leave it unset or false to disable review.
- `GEMINI_MODEL` — optional model name; defaults to `gemini-3.8-flash`.

The server reads environment variables at startup; it does not automatically load a `.env` file. Restart the server after changing settings. `/api/health` reports whether the password, key and switch are configured, **not** whether the key or provider connection has been verified. The local clip inspector and editor work without Gemini.

When enabled, the browser asks for confirmation for each clip before sending it to the server and Google Gemini. The server accepts supported video types up to **14 MiB** per request; this leaves room for base64 and prompt overhead in an inline request. See Google's [video input guidance](https://ai.google.dev/gemini-api/docs/generate-content/video-understanding). Google’s [terms](https://ai.google.dev/gemini-api/terms), privacy rules, rate limits, model availability, and possible charges apply; unpaid-service content may be used to improve Google products. Only send footage you are authorized and comfortable sharing.

The consent and origin headers are forgeable by a client; they are not authorization. The one-at-a-time review limit and 30-second peer-IP cooldown are lightweight protections, not reliable per-user quotas. They reset on restart and can group users together behind a proxy. Use a secure, limited private preview only.

## What works in this preview

- The clip inspector samples frames and reads metadata locally. The editor previews, trims, reframes, adds text and audio, and attempts to export short clips in the browser. Supported formats and export features depend on the browser and device.
- Coach replies are **sample templates**, not live AI. Chats, saved reference links, and the theme are stored in the current browser's local storage.
- Video and audio selections are temporary. Previewing, scanning, and editing stay in the browser; a video leaves the device only if you explicitly confirm a configured AI review. Reference links are saved but not fetched.
- Individual sign-in and cloud sync are not connected. No video is written to the server's disk by the review route.

This is a development prototype, not a production server. Use it only on trusted networks and use footage and music you have permission to edit.
