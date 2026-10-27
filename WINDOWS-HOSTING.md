# Keep a protected Cutline preview running on Windows

This is an optional personal-preview setup for a Windows 10/11 computer. **It has not been tested end to end on Windows, Servy, Tailscale Funnel or HetrixTools.** Test it on your own computer before relying on it. Cutline is a prototype, not a hardened multi-user hosting service.

The computer runs Cutline; [Servy](https://github.com/aelassas/servy) can start it with Windows and restart its process after a failure. [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) supplies a public HTTPS link, and [HetrixTools](https://hetrixtools.com/uptime-monitor/) can check the password gate and send alerts. Neither a monitor nor a tunnel keeps a powered-off or sleeping computer running.

Tailscale's free Personal plan is for qualifying non-commercial personal use. Funnel is a beta feature with bandwidth limits; review its current terms. Running the computer also uses electricity and internet bandwidth. AI providers have separate quotas and possible charges.

## 1. Prepare the app and computer

1. Install the current [Node.js LTS](https://nodejs.org/en/download) (Cutline requires Node 20 or later) and the latest [Tailscale for Windows](https://tailscale.com/download/windows). Sign in to Tailscale.
2. Download the **updated** Cutline branch ZIP from GitHub, extract it, and **copy the extracted app files** to a folder such as `C:\CutlineStudio`. Check that `C:\CutlineStudio\server.js` exists directly inside that folder. The `--safe-local` mode is not present in older copies. Back up any personal files before replacing an existing folder; do not put passwords or keys into the ZIP or GitHub.
3. Keep the computer plugged in and connected to the internet. In Windows 11, open **Settings > System > Power & battery > Screen, sleep, & hibernate timeouts**, and set **When plugged in, make my device sleep after** to **Never**. If a plugged-in hibernate timeout is shown, set that to **Never**, too. The screen may turn off. In Windows 10, look under **Settings > System > Power & sleep**. Leave a laptop lid open unless you have checked its lid-close settings and ventilation. Do not cover vents.
4. If you previously launched the foreground Funnel and Cutline in PowerShell, stop the Funnel window with Ctrl+C first, then stop the old Cutline window with Ctrl+C. This prevents two app processes from competing for port 4173.

## 2. Let Servy start and restart Cutline

1. Download the current [Servy release](https://github.com/aelassas/servy/releases/latest) from its official GitHub repository and install it. On most Intel/AMD PCs, choose the modern `x64-installer.exe`; choose ARM64 if Windows says your computer is ARM-based. Installing and configuring Windows services requires administrator permission.
2. Right-click `C:\CutlineStudio` in File Explorer, choose **Properties > Security > Edit > Add**, enter `LOCAL SERVICE`, select **Check Names**, and grant **Read & execute**. Apply the change. This lets the lower-privilege service account read the app files. Do not give it write access to the app folder just to make the basic preview work.
3. Open **Servy** as administrator. On **Service Details**, enter:
   - **Service Name:** `CutlineStudio`
   - **Process Path:** `C:\Program Files\nodejs\node.exe` (or the actual path if Node was installed elsewhere)
   - **Startup Directory:** `C:\CutlineStudio` (the actual folder containing `server.js`)
   - **Process Parameters:** `server.js --safe-local`
   - **Startup Type:** `Automatic`
4. On **Advanced**, enter these environment variables, one per line. After the equals sign, enter your own unique password of at least 16 characters. To avoid Servy's special-character parsing, use letters, numbers and hyphens for this password. A blank password cannot start safe-local mode.

   ```text
   PORT=4173
   CUTLINE_ACCESS_PASSWORD=
   ```

   To use Gemini, also add `CUTLINE_AI_ENABLED=true` and `GEMINI_API_KEY=` followed by your own Google key. Do not include a key if you are not ready to use Gemini. Never share the key or password in chat, screenshots, source files or GitHub.

   According to Servy's documentation, environment variables are encrypted in its local configuration; they still exist in memory and may be accessible to local administrators. **Do not enable Servy's debug logs:** its documentation says debug logging can record sensitive information. Do not export the service configuration; exports can contain plaintext secrets.
5. On **Log On**, select the built-in `NT AUTHORITY\LocalService` account rather than LocalSystem. On **Recovery**, enable health monitoring and choose **RestartProcess**. Leave the restart-attempt limit enabled; after repeated failures, the service may stop and need attention. Servy's health checks monitor process liveness, not whether Gemini or the editor works.
6. Click **Install**, then **Start**. If it fails, check the app path, read permissions and whether another program is already using port 4173. Do not change to a high-privilege account merely to bypass a permissions error.
7. In a new private browser window **on the computer**, open `http://127.0.0.1:4173`. You must see a password challenge. Sign in with username `cutline` and the password you chose. **If you do not see the challenge, stop here and do not enable Funnel.**

`--safe-local` forces Cutline to bind to `127.0.0.1` and refuses to start if its access password is missing or invalid. A proxy such as Funnel can still publish that local port to the internet. The shared password is only suitable for a personal preview, not as a substitute for a production security review or per-user accounts.

## 3. Publish the protected preview with Tailscale

1. Right-click the Tailscale icon in the Windows system tray, choose **Preferences > Run unattended**, and approve the prompt. This keeps Tailscale itself connected across sign-out/restart; it does not start Cutline. See [Tailscale's instructions](https://tailscale.com/docs/how-to/run-unattended).
2. Only after the password check above succeeds, open PowerShell **as administrator** and run:

   ```powershell
   & "$env:ProgramFiles\Tailscale\tailscale.exe" funnel --bg 4173
   ```

   Approve any Tailscale browser prompt and rerun the command if needed. For the link and status, run:

   ```powershell
   & "$env:ProgramFiles\Tailscale\tailscale.exe" funnel status
   ```

3. Open the displayed `https://...ts.net` link from a private browser on your phone, preferably with phone Wi-Fi off for an outside test. Confirm the password challenge and then sign in. Anyone who finds the public URL can attempt to connect; keep the password private.
4. When it is safe to restart the computer, save your work and test a restart. Check that the same public link again presents the password challenge and works. A PC restart, power loss, network outage, failure to reconnect Tailscale, or a process failure beyond Servy's retry limit can still cause downtime.

**Background Funnel persists across restarts. It forwards to whatever is listening on local port 4173, not exclusively Cutline.** Before stopping/replacing Cutline, running another app on that port, or changing security settings, turn the public proxy off in an administrator PowerShell:

```powershell
& "$env:ProgramFiles\Tailscale\tailscale.exe" funnel --https=443 off
```

This assumes the default HTTPS port used in the command above; do not overwrite an existing Tailscale share for another service. Verify the status afterward. Re-enable Funnel only after checking the password challenge again.

## 4. Get free outage alerts

1. Create a free [HetrixTools](https://hetrixtools.com/uptime-monitor/) account. Under **Contact Lists**, add your email address and use **Send test notification** to check it.
2. Open **Uptime Monitors > Add Monitor** and choose **Website**. Name it `Cutline` and enter your actual public Tailscale link followed by `/api/health`.
3. Select your email contact list. Open **Show advanced settings > Accepted HTTP Codes** and select **401**; unselect the default **200** so the monitor does not treat an accidentally unprotected app response as healthy. Save the monitor. See [Hetrix's accepted-code guide](https://docs.hetrixtools.com/website-uptime-monitoring-accepted-http-codes/).
4. Check that the monitor reports online while your protected app is working. If possible, briefly turn off Funnel and confirm that Hetrix alerts you, then re-enable Funnel only after verifying the password challenge.

A 401 response checks that a password gate responds; it does not prove AI, editing, export or every route works. Hetrix can notify you but cannot wake the computer or fix the app. On Hetrix's free plan, log in to its dashboard at least once every 90 days to keep the account active.
