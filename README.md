# Cutline Studio

A phone-first sports editing prototype. A configured Gemini Coach can analyze a **public YouTube video link**, suggest approximate moments, summarize what it observes, explain visible editing choices, and propose hooks, titles and hashtags. The browser editor can then trim an **authorized local copy of the same video**, make a vertical cut, mix local audio, and export it.

**Important:** A link is not a video file or permission to reuse footage. Cutline does not download YouTube videos, directly connect to TikTok's sound catalog, automatically post to TikTok, or make a finished edit from a link alone. AI may miss fast action or produce incorrect timestamps and claims; review everything and use footage and music you have rights to use.

## Using the workflow

1. Open your privately protected Cutline site over HTTPS. If AI is configured, choose **AI Coach**, paste one public YouTube video link, and ask for highlights, a summary, editing ideas, titles and hashtags. Google supports public, not private or unlisted, YouTube videos.
2. Read the confirmation and approve the request. Your message, link and up to six recent messages go to Google Gemini. The link is analyzed remotely; no source video is downloaded to this app. If AI is not configured or the provider cannot analyze the video, the app reports that instead of inventing an analysis.
3. Check the summary and the approximate suggested moments. When a usable moment is returned, choose **Use this moment in editor**. Select an authorized local copy of the **same full video**, then confirm the match. Cutline applies the suggested in/out points, 9:16 frame and suggested headline. If no reliable moments are returned, trim manually. AI sampling can miss quick plays.
4. Preview and adjust the trim, framing, text, color and sound. The current editor handles **one continuous clip** up to 60 source seconds per export; it does not automatically assemble multiple highlights, transcribe speech or recreate every effect.
5. For audio, add a separate local file you are licensed to use, or save the video first and use **Add sound** inside TikTok. [TikTok's Commercial Music Library](https://ads.tiktok.com/business/creativecenter/music/pc/en) and [usage guidance](https://ads.tiktok.com/help/article/how-to-use-the-commercial-music-library) can help you choose music for the right account, region and use. Cutline is not connected to the TikTok catalog; merely finding a song does not grant rights outside its license.
6. Tap **Export current edit**, keep the page open while it renders, preview the result, and choose **Download edit** or **Share / save**. Save it before leaving the page: the output is not automatically stored in the cloud. Browser/device support varies; the selected MP4 or WebM and its codecs may not be accepted by TikTok. The app warns when audio capture fails or a potentially incompatible codec is selected.

Titles and hashtags are **creative suggestions, not a promise of virality or evidence of a current trend**. Without the optional Google Search feature below, the Coach does not do live research. For TikTok-specific trends, also check [TikTok Creative Center](https://ads.tiktok.com/creative/creativeCenter/trends) and its [Creator Search Insights guidance](https://support.tiktok.com/en/using-tiktok/growing-your-audience/creator-search-insights).

## Run locally

Node.js **20 or newer** is required. The local editor needs no npm packages or AI key:

```sh
npm start
```

Open `http://localhost:4173`. The server honors `PORT` (default `4173`) and `HOST` (default `0.0.0.0`); for a local-only process, set `HOST=127.0.0.1`. Run the automated server tests with `npm test`.

Without an access password the local app is open to anyone who can reach it, and all AI routes remain **off**. Do not expose an unprotected personal preview to the internet.

## Set up a private hosted preview and Gemini

Import the **`arena/ae97be88-cutline-studio` branch** as a Node service on a host that supports Node 20+, HTTPS, runtime secrets, and a long-running web process. Set the start command to `npm start` and configure the host's assigned `PORT` if it doesn't set one automatically. GitHub stores the code; it is not itself an always-on hosting service.

In the hosting provider's **runtime environment variables / secrets** (not in a repository file, browser page, screenshot or chat), set:

| Variable | Value / purpose |
| --- | --- |
| `CUTLINE_ACCESS_PASSWORD` | A unique random **16–256 character** private password. Mark it secret. |
| `GEMINI_API_KEY` | Your Google Gemini API key. Mark it secret. Obtain/manage one at [Google AI Studio API keys](https://aistudio.google.com/apikey); never paste it into chat or GitHub. |
| `CUTLINE_AI_ENABLED` | `true` to enable Coach and confirmed per-clip AI review. |
| `GEMINI_MODEL` | Optional; defaults to `gemini-3.8-flash`. Use a model your Google project can access that supports video. |

The server reads these at startup and does **not** load `.env` files automatically. Restart/redeploy after changes. Open the HTTPS address in a private browser window and verify the login prompt **before** adding or enabling an API key. Username: `cutline`; password: your private `CUTLINE_ACCESS_PASSWORD`. If a password variable is present but invalid or empty, all routes fail closed. If it is absent, the app opens without a login and AI remains disabled.

The **configured** badges and `/api/health` describe settings only; they do not validate your key, account, model, provider connection, quotas, or a real video. Only an actual consented request on your deployment can verify those. Google’s [terms](https://ai.google.dev/gemini-api/terms), privacy rules, quotas and possible charges apply; content submitted through unpaid services may be used to improve Google products. Check your actual [Google rate limits](https://aistudio.google.com/rate-limit?timeRange=last-28-days) and billing settings. Google documents up to eight hours of public YouTube video per day on the free tier, subject to other limits and availability; that is **not** a guarantee of unlimited daily use. Long videos and fast sports action may require more processing, and the default static video sampling can miss key frames. Provider requests can time out.

The shared-password gate is for a small personal preview, **not** multi-user production authentication. Use HTTPS: HTTP Basic credentials would otherwise be exposed. Anyone with the password can spend the configured API quota. The in-memory login throttle, one-at-a-time Coach limit and five-second peer cooldown are lightweight safeguards, not per-user billing controls; they reset on restart and can group visitors behind a proxy. Add proper accounts, quotas, durable abuse protection and budget controls before public use.

### If you use the existing Suga preview

The previous Suga setup used a Node service, runtime **Env Vars** marked **Sensitive**, an HTTPS URL targeting the configured `PORT`, and **Apply** to deploy changes. Select the session branch above, set and verify the access password first, then add the Google secret and enable flag and apply/redeploy. Provider screens and plans can change; the new YouTube workflow, memory requirements and real Gemini calls have not been tested on Suga. A small memory allocation may not support the separate 14 MiB upload-review route.

## Optional live Google Search research

Search is **off by default**. Google's Gemini API Search grounding is a paid service and can incur separate charges, including multiple searches; availability varies by model and account. Do not enable it unless the owner has reviewed the [pricing](https://ai.google.dev/gemini-api/docs/pricing) and accepts possible charges.

To make the checkbox available, set `CUTLINE_RESEARCH_ENABLED=true` on the protected, Gemini-enabled server and restart it. The checkbox starts unchecked; selecting it and confirming the request explicitly adds a **second** Gemini call for research. The result displays provider-returned sources and citations, plus Google's required Search Suggestions when supplied. They are retained only in the current tab, not long-term chat storage; after reload the user must run research again. For safety, unrecognized or unsafe suggestion HTML causes the research result to be withheld rather than executed or displayed without its required suggestions. No actual paid Search request has been verified by this repository's mock tests. A source link does not mean every claim is verified or that a title or sound is currently trending.

## Optional Arena creative polish

The normal YouTube analysis uses Gemini. Arena is **not automatically connected** to this Agent Mode session or its credentials. If you have separately authorized access to Arena's developer API and a compatible model, you can optionally set these runtime values on the same protected, Gemini-enabled server:

- `CUTLINE_ARENA_ENABLED=true`
- `ARENA_API_KEY` — a separate runtime secret; never put it in code or chat.
- `ARENA_MODEL` — the model identifier your Arena developer workspace explicitly permits.

The **Arena creative polish** checkbox is unchecked by default. When selected and confirmed, a separate call sends the current message and Gemini's text answer to `https://api.arena.ai/v1/chat/completions`. Arena receives text only; it does not independently watch the video or research trends. Separate access restrictions, quotas, terms and possible costs apply; some Arena routers are limited to particular developer clients. Configuration is not a successful connection test, and the adapter has only been tested with a mock provider.

## Other limits, privacy and hosting

- The separate **uploaded-clip AI review** route requires its own confirmation and accepts supported video types up to **14 MiB**; it sends the selected file to Google. The YouTube-link Coach request does not upload the local source video. The app writes no raw media to its server disk.
- Chats, reference links and theme are stored in the current browser's local storage. Search research is tab-only. Source media, selected audio, export blobs and unsaved edits are temporary. Real accounts, cloud sync, durable video storage and direct TikTok posting are not connected.
- Cloady was investigated as a candidate, but this new workflow has **not** been deployed or tested there. Its idle policy, proxy limits, timeouts, Hetrix behavior, actual Gemini use, and rendering performance remain unverified. Local browser rendering uses the creator's device, not a cloud GPU; Google runs the model remotely. Hosting limits and Google quotas are separate. A free host can sleep or change its terms.
- With the password set, unauthenticated `GET`/`HEAD /api/health` return **401**. An uptime monitor configured to accept 401 can check whether the login gate responds, but that does not prove AI, video analysis, export, or the provider are working. Do not assume monitoring prevents a free host from sleeping.

This is a prototype. Test on the actual host, browser and source files before relying on it for daily publishing.
