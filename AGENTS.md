# AGENTS.md — Steam Hotel IPTV

Shared instructions for AI coding agents working on this repo (Claude Code, ChatGPT Codex, Antigravity IDE, or any other agent that reads `AGENTS.md`). Keep this file in sync with reality — update it whenever the architecture or workflow changes.

## What this project is

A single-page IPTV web app for ROYS Hotel: fullscreen live-TV player with a slide-in channel picker, hosted as a static site on GitHub Pages, installable as a PWA. No backend, no build step, no framework — plain HTML/CSS/JS plus `hls.js` from a CDN.

Live site: https://atsawinohio-dot.github.io/steam-hotel-stream/

## Open work (2026-09-13)

The full, machine-specific handoff (status table, workspace layout on the hotel laptop, where secrets live, gotchas) is in `E:\Steam Hotel\CLAUDE.md` on the hotel laptop — Claude Code loads it automatically when opened anywhere under that folder. Summary for anyone working from a fresh clone:

1. Verify channel 21 audio with real speech (phone mic via Camo, OBS gain filter +20 dB) — run `workers/event-live/check-audio.ps1` while someone talks near the phone. A quiet room measured `mean_volume -37.5 dB` on 2026-09-13, which says nothing about speech.
2. The phone drops off Wi-Fi in Camo; move events to a USB cable (Camo's `ignoredDevices` currently lists the phone's USB serial — remove it with the owner's OK). Also switch off the phone's auto-lock during an event: a locked phone leaves Camo sending its grey "no camera" card, which is then what channel 21 broadcasts.
3. The owner still needs to disable the laptop's built-in webcam in Device Manager (it wedges every camera when opened).

The channel 21 remote control (item 1 of the previous round) is **done and tested end to end** on 2026-09-13 — see "Remote control from a phone" below.

## Multi-agent handoff protocol

This project gets worked on by more than one AI tool (Claude Code, ChatGPT Codex, Antigravity IDE), sometimes in the same day, never in the same session. To avoid re-deriving context every time:

1. **At the start of a session, read `HANDOFF.md` first** (before this file, even) — it says whether work is mid-flight and what the very next step is.
2. **Before you stop** — whether the task is done, or you're approaching your context/usage limit and need to end the session — **update `HANDOFF.md`** using the template at the bottom of that file. A few sentences is enough: what you just finished, what's half-done, what the next agent should do first. Assume the next reader remembers nothing from this conversation.
3. If you're stopping mid-edit (uncommitted changes, a file in a broken intermediate state), say so explicitly — don't leave the next agent to discover it by accident. Prefer committing working increments over leaving big uncommitted diffs.
4. Don't treat another agent's unfinished work as wrong just because it's unfamiliar — check `HANDOFF.md` and recent `git log` before changing direction.

## Repo layout

```
index.html          Everything: markup, CSS, and JS in one file. This is the whole app.
iptv.m3u8            Channel list (M3U8 playlist format: #EXTINF + logo/group metadata + stream URL per channel).
playlist.m3u8         HLS playlist for the hotel's own looping welcome video (ROYS HOTEL channel).
segment_*.ts          The 5 video segments that playlist.m3u8 loops through (~10.4h loop via repeated refs + EXT-X-DISCONTINUITY).
promo/segment_*.ts    The 6 segments (4.000s each, exactly 24s total) of the hotel's signage reel (ROYS PROMO channel).
promo/playlist.m3u8   Static 24h VOD loop of those segments. NOT what the channel points at — kept as a fallback;
                      the live channel URL is workers/promo-loop, which loops forever (see below).
manifest.webmanifest  PWA manifest (name, icons, standalone display).
sw.js                 Service worker: network-first cache of the app shell for offline/fast reload.
icon-*.png, apple-touch-icon.png, favicon-32.png   PWA/app icons.
```

No `package.json`, no build tooling. Edit `index.html` directly and it's live.

## Deployment

- Static hosting: **GitHub Pages** on the `master` branch of `github.com/atsawinohio-dot/steam-hotel-stream`.
- Deploy = `git add -A && git commit -m "..." && git push`. GitHub auto-builds and serves.
- **The Pages build queue is sometimes very slow** (observed 5–10+ minutes some days, usually under a minute). Check status with:
  ```
  gh api repos/atsawinohio-dot/steam-hotel-stream/pages/builds/latest --jq '{status, commit}'
  ```
  Don't assume a slow build means something is broken — poll and wait.
- Verify a deploy actually landed with a cache-busted curl, not just "it built":
  ```
  curl -s "https://atsawinohio-dot.github.io/steam-hotel-stream/?bust=$(date +%s)" | grep "<something unique to the change>"
  ```

## CORS proxy

Some third-party channel streams block cross-origin requests (no `Access-Control-Allow-Origin`), which breaks `hls.js` in the browser even though the stream works fine in VLC. There's a Cloudflare Worker proxy for this:

- Source: `E:\Steam Hotel\...\scratchpad\iptv-proxy\worker.js` (not in this repo — lives in a scratchpad; consider committing it somewhere durable if you touch it again)
- Deployed as: `steam-hotel-iptv-proxy.tiny-hall-8718.workers.dev`
- Usage: `https://steam-hotel-iptv-proxy.tiny-hall-8718.workers.dev/?url=<url-encoded original stream URL>`
- It rewrites manifest URIs (segments, sub-playlists, `#EXT-X-KEY` URIs) to also route through the proxy, and adds `Access-Control-Allow-Origin: *`.
- **It is also useful purely for throughput, even when CORS is fine.** Some origins are slow and erratic over the hotel ISP's direct route but fast and stable via Cloudflare's backbone. KTV (Korean government CDN) is the live example: ratio 0.96–1.35 direct (rebuffering) vs **0.53 through the proxy**, with per-segment times tightening from 6–14s to 5–6s. So when a channel is too slow to stream in real time, measure it through the proxy before concluding the source is unusable — and don't "simplify" such an entry back to its direct URL, since it will pass a single spot-check and stutter in real use.
- **Known limitation:** some origins (e.g. servers themselves fronted by Cloudflare) block requests from Cloudflare's own IP ranges, returning error 1042 or 403. The proxy can't work around that — those channels can't be CORS-fixed (currently: CH7 HD, Pluto TV Trending Now). Note CH7's *stream* is fine and plays in native players; it's only unusable in the browser, because CH7's CDN allowlists `https://www.ch7.com` as the sole permitted origin. Fixing it would need a proxy on a Thai IP, not a Cloudflare Worker.
- **Known limitation:** extremely long upstream URLs (e.g. Pluto/Paramount+ ad-session tokens) can exceed the proxy's URL-length limit → HTTP 414. Currently affects Paramount+ Picks.

### PPTV HD 36 auto-refresh manifest

PPTV serves a signed byteark URL (`x_ark_*`, ~6h validity) from its player iframe at `www-live.pptvhd36.com/api/live_player/program/1`. Same family as CH3/Amarin.

- Source: `workers/pptv-proxy/` in this repo. Deployed as `steam-hotel-pptv-proxy.tiny-hall-8718.workers.dev`, KV binding `PPTV_TOKEN_CACHE`.
- Used as the channel URL: `.../live/playlist_720p.m3u8`
- **PPTV's audio is demuxed** — `720p/index.m3u8` is video-only and the soundtrack lives in `audio-hi/th/index.m3u8`, reachable only via the master's `#EXT-X-MEDIA` AUDIO group. So the worker emits a synthesised master (one 720p variant + the Thai audio rendition) rather than pinning at the video rendition. Pinning directly would play silently — the same bug Amarin had.
- It also can't just redirect to PPTV's real master: that lists 1080p first and declares nonsense `BANDWIDTH` values (1080p tagged 500kbps, 144p 50kbps), so ABR has no usable signal and `startLevel: 0` would pin everyone to 1080p.
- The worker only fetches pptvhd36.com, never byteark, so byteark's Cloudflare-egress block can't affect it and segments still leave from the player's own Thai IP.
- If it breaks: check that the player iframe still contains a `...playlist.m3u8?x_ark_...` URL and update the regex in `workers/pptv-proxy/worker.js`. The regex captures the whole URL including host, so a CDN hostname change is handled automatically.

### Pluto TV CORS shim

Pluto's stitcher replies with `access-control-allow-origin: http://pluto.tv` — a specific foreign origin, not `*` — so browsers reject every response and hls.js can't even read the master playlist. Native players (the owner's "M3U IPTV" app, VLC) ignore CORS, so **Pluto channels look fine there and fail only in the web app**; don't take "it works in the app" as evidence the entry is good.

- Source: `workers/pluto-proxy/` in this repo.
- Deployed as: `steam-hotel-pluto-proxy.tiny-hall-8718.workers.dev`
- Usage: `https://steam-hotel-pluto-proxy.tiny-hall-8718.workers.dev/<plutoChannelId>.m3u8` — the id is the hex string from Pluto's `jmp2.uk/plu-<id>.m3u8` links.
- It resolves the channel through `jmp2.uk` (which mints a fresh `authToken`), then rewrites the manifest's relative URIs **against the post-redirect stitcher URL** and routes sub-playlists back through itself with `Access-Control-Allow-Origin: *`.
- Only manifests pass through the worker. Pluto serves segments from `*.plutotv.net` with `access-control-allow-origin: *` already, and media playlists reference them absolutely, so video bandwidth goes player→CDN directly and never touches Cloudflare.
- The generic `steam-hotel-iptv-proxy` **cannot** do this job: it resolves relative URIs against the URL it was handed rather than the one it landed on after the 302, so it rewrites `1539795/playlist.m3u8` to `jmp2.uk/1539795/playlist.m3u8`, which 404s.
- The `u` parameter is restricted to `pluto.tv`/`plutotv.net` over https so this can't be used as an open relay.

### CH3 (3HD) auto-refresh proxy

3HD's *official* free stream (ch3plus.com) doesn't have a stable public URL — every public mirror found in third-party IPTV lists (thaimomo, v2h-cdn, etc.) was already dead as of 2026-07-19. The real byteark CDN URL is signed and expires ~every 12h, generated server-side and embedded in `https://ch3plus.com/live`'s HTML (`streamUrlWebAVOD` field in the SSR JSON) — there's no separate public token API to call.

- Source: `workers/ch3-proxy/` in this repo (also deployable standalone with `wrangler deploy` from that folder).
- Deployed as: `steam-hotel-ch3-proxy.tiny-hall-8718.workers.dev`
- Used directly (no `?url=` param) as the 3HD channel URL: `.../live/720p/index.m3u8` — a *media* playlist, deliberately not the master. The player re-fetches this URL every few seconds to refresh the live window, and each of those hits goes through the worker, which reattaches a current token. Point it at the master instead and the player only touches the worker once, then keeps using byteark URLs carrying whatever token was frozen at load time — playback dies with `PLAYER_ERROR_CONNECTION_FAILED` once that token ages out.
- How it works: on each request it checks a KV-cached signed query string; if missing/near-expiry it re-fetches `ch3plus.com/live`, regexes out `streamUrlWebAVOD`, and caches the query params (refreshed ~30min before the real `x_ark_expires`). It then 302-redirects to `ch3-33-web.cdn.byteark.com` + the same path + a fresh signed query, so the video traffic leaves from the player's own Thai IP (byteark 451s Cloudflare's egress IPs).
- If this breaks: check whether `ch3plus.com/live`'s HTML still contains `streamUrlWebAVOD":"..."` — if CH3 changes their page structure, the regex in `workers/ch3-proxy/worker.js` needs updating.
- The worker normalizes every URL this channel has ever been given (`/live/playlist_720p/index.m3u8` and the master `/live/playlist.m3u8`) onto `/live/720p/index.m3u8`, because IPTV clients cache the channel URL and keep sending stale ones long after `iptv.m3u8` is fixed. Adding a path alias there is usually faster than waiting for a client to re-read the playlist.
- 2026-09-02: byteark renamed the variant paths (`/live/playlist_720p/index.m3u8` → `/live/720p/index.m3u8`), which 404'd the URL the playlist was using. Fixed by updating the pinned path. If 3HD 404s again, fetch `ch3plus.com/live`, pull `streamUrlWebAVOD`, load that master playlist and read the current variant path out of it.

### ROYS PROMO endless-loop generator (not currently in the lineup)

**The ROYS PROMO channel was removed from `iptv.m3u8` at the owner's request (2026-08-17).** The worker below is still deployed and the `promo/` segments are still in the repo, so re-adding the channel is just restoring its two `#EXTINF` lines. Everything else in this section still describes how it works.

A static playlist can only loop a *finite* number of times before `#EXT-X-ENDLIST` stops the channel. To make the hotel's own signage reel run forever, the manifest is generated per request instead.

- Source: `workers/promo-loop/` in this repo. No KV, no secrets — `wrangler deploy` from that folder is all it takes.
- Deployed as: `steam-hotel-promo-loop.tiny-hall-8718.workers.dev`
- Used as the ROYS PROMO channel URL: `.../playlist.m3u8`
- How it works: emits a 6-segment sliding-window LIVE playlist (no `EXT-X-ENDLIST`) positioned by wall-clock time — `floor(elapsed / 4) mod 6` picks the segment that should be airing. **This depends on the reel being an exact multiple of the segment duration** (24.000s = 6 × 4.000s); if the reel is ever re-encoded to a length that doesn't divide evenly, the clock arithmetic drifts and the constants at the top of `worker.js` must be updated to match.
- Side effect worth knowing: because position comes from the clock, every TV in the hotel shows the same frame at the same time, like a real broadcast channel, rather than each guest starting the reel from frame 0.
- Only the manifest goes through the worker; segment URIs are absolute GitHub Pages URLs (Pages already sends `Access-Control-Allow-Origin: *`), so video bandwidth is player→Pages and never touches Cloudflare — same split as the Pluto shim.
- `promo/playlist.m3u8` (static, 24h then stops) is left in the repo as a fallback if the worker ever needs to be bypassed.

### Channel 21 "Event" — live broadcasts from the hotel (Workers Free only)

Added 2026-09-13 for the hotel's STEM events. The owner explicitly wanted Cloudflare **with no paid subscription** — Cloudflare Stream has no free tier, and R2 requires adding a subscription (a $0 plan, but the owner declined it). So everything runs on the Workers Free plan, with video held in a SQLite-backed Durable Object.

```
OBS --RTMP--> ffmpeg on the hotel PC --HLS over HTTPS PUT--> steam-hotel-event worker --> Durable Object (SQLite)
                                                                         ^
                                     TVs / phones anywhere --GET---------+
```

- Source: `workers/event-live/`. Deployed as `steam-hotel-event.tiny-hall-8718.workers.dev`; channel URL `.../live/index.m3u8`; health/usage at `.../status`.
- **Starting a broadcast:** double-click `E:\Steam Hotel\Start Event Live.bat` (outside the repo), which runs `start-event.ps1`: ffmpeg listens on `rtmp://127.0.0.1:1935/live` (localhost only, so no Windows Firewall prompt), copies OBS's stream into 6s segments without re-encoding, and uploads them. OBS settings: Stream → Custom, server `rtmp://127.0.0.1:1935/live`, key `event`; Output → keyframe interval **2s**, bitrate ~**2500 Kbps**, 720p. `start-event.ps1 -Test` loops `Steam Hotel.mp4` instead, to test the chain without a camera.
- **OBS setup (tested with real OBS 32.2.2, 2026-09-13):** a separate OBS profile **"ROYS Event"** (`%APPDATA%\obs-studio\basic\profiles\ROYS_Event`) and scene collection **"ROYS Event"** hold the event settings, so the hotel's existing OBS profile ("Untitled", which streams to `192.168.1.105`) is untouched. `Start Event Live.bat` opens OBS with `--profile "ROYS Event" --collection "ROYS Event"`. The profile must use **Advanced** output mode with `keyint_sec: 2` in `streamEncoder.json` — OBS 32's Simple mode does not pin the keyframe interval, and with copy-only segmenting that produced 4.7s/7.9s segments instead of 6s. The scene "Event" currently holds a looping `Steam Hotel.mp4` and a "ทดสอบจาก OBS" label as a test source; for a real event swap in the camera (a Video Capture Device) and hide both. Never put a Display/Window Capture in that scene — channel 21 is public to anyone with the playlist.
- **Camera (changed 2026-09-13, evening): a wired USB camera, not the phone.** The hotel plugged in a `USB 2.0 Camera` (Realtek `VID_0BDA&PID_5697`, a composite device whose second half is the mic `Microphone (Realtek USB2.0 MIC)`), and the owner asked for channel 21 to use it for both picture and sound. It replaces the phone-over-Camo rig, which kept dropping off Wi-Fi.
  - OBS source **“กล้อง USB”** (`dshow_input`) in the “Event” scene: `res_type: 1`, `resolution: 1280x720`, `frame_interval: 333333` (30fps), **`video_format: 400`**. Two traps there: this OBS build's format enum is `0 = any, 300 = YVYU, 400 = MJPEG` (a wrong value logs `Video format match failed`), and `video_device_id` must be OBS's spelling — `USB 2.0 Camera:\\?\usb#22vid_0bda&…#22{65e8773d-…}\global`, with every `#` escaped as `#22`. ffmpeg's `@device_pnp_…` name is a different thing and gives a black source.
  - **720p, not 1080p, on purpose.** The camera advertises MJPEG up to 2560×1440, and ffmpeg can grab 1080p30 from it, but OBS fails with `DShow: Run failed (0x800705AA) Insufficient system resources` above 720p once the camera's own mic is also open — USB 2.0 bandwidth. The stream encodes 1280×720 anyway, so nothing is lost.
  - **Camo Studio must not be running.** It holds the USB camera open, and OBS then gets the same `0x800705AA`. The agent kills `CamoStudio.exe` on “เริ่มถ่ายทอดสด” (it used to *launch* it, back when the phone was the camera).
  - Sound: **“ไมค์กล้อง USB”** (`wasapi_input_capture`, endpoint `{0.0.1.00000000}.{d44d57b4-69ba-4ce1-8577-4f3009816f05}`) with RNNoise → **+10 dB** gain → limiter −1 dB. The phone mic needed +20 dB; this one sits on a −47 dB noise floor, and a quiet room measures `mean_volume -29.7 dB` on the channel. Still to be checked against real speech.
  - The agent picks its mic from `MIC_INPUTS` (`ไมค์กล้อง USB` → `ไมค์มือถือ (Camo)` → the laptop mic), whichever the scene collection has, so the mute button keeps working after a swap. It also reports `camera.active` (from `GetSourceActive`), which is what the desktop program's “กล้อง” row shows — a source can exist and still be black.
  - The phone sources (`กล้อง Camo (มือถือ)`, `ไมค์มือถือ (Camo)`) are **hidden, not deleted**, so the phone rig is one click away if the USB camera ever fails.
- **Camera, the old phone rig (2026-09-13, daytime — kept for reference):** the event camera is the owner's phone ("A16") through **Camo** — Camo Studio on the laptop pairs with the Camo app over Wi-Fi and exposes a "Camo" virtual camera, which the Event scene uses as a Video Capture Device ("กล้อง Camo (มือถือ)"), with the phone's mic ("ไมค์มือถือ (Camo)") as the audio. After a laptop restart Camo Studio can fall back to "DroidCam Video" as its device and OBS then shows a "Start DroidCam" card — pick the phone again under Device in Camo Studio. The laptop's built-in "USB2.0 HD UVC WebCam" never delivered frames (it is toggled by ASUS Fn+F10 and vanished after reboot); don't rely on it. Worse, *anything that opens it wedges Windows' Camera Frame Server for every camera*, Camo included (seen twice on 2026-09-13: Camo Studio picked the webcam, then Camo itself hung in OBS and ffmpeg). Keep it **disabled in Device Manager**; if Fn+F10 or a driver update brings it back, disable it again and Restart.
  - If OBS logs `data.GetDevice failed` for a camera that works elsewhere, check two things: Windows' Camera Frame Server can wedge so that *every* frame-server camera (built-in and Camo) hangs in DirectShow while DroidCam still works — a real **Restart** fixes it (Fast Startup is on, so Shut down does not); and OBS's `video_device_id` must be `<name>:<path>` with `#` escaped as `#22` and the path starting `\\?\` (two backslashes, as Windows spells device paths) — one backslash also gives `GetDevice failed`.
- **Remote control from a phone (added and tested end to end 2026-09-13):** `https://steam-hotel-event.tiny-hall-8718.workers.dev/control` — a password-protected page that starts and stops the broadcast, mutes the mic, drops a standby card over the camera, and shows a preview frame plus a mic level meter. Built because the owner wanted to run an event from their phone without standing at the laptop.
  - **Shape:** `control.js` lives in the *same* Durable Object as the video, so the control side shares one request budget and one piece of state with the channel. The phone talks to `/control/api/*` with a session cookie (HMAC of `CONTROL_PASSWORD`, valid 12h, 10 failed logins per 10 minutes then a 429); the laptop's agent talks to `/control/agent` with `Bearer INGEST_TOKEN`.
  - **The laptop only polls out.** `agent/agent.mjs` (Node, no dependencies) makes outbound HTTPS calls every 4s while the page is open or a broadcast is running and every 30s otherwise — idle that is ~2,900 requests/day instead of ~17,000. Nothing listens for inbound connections, so no router or Windows Firewall work. Every one of those requests counts against `DAILY_BUDGET`.
  - **Commands are a one-shot queue with a 3-minute TTL**, not a desired state: the agent only acts when a button was actually pressed, so it never fights someone operating OBS by hand, and a button pressed while the laptop was off does not fire hours later. A newer press replaces an unsent older one of the same pair (start/stop, mute/unmute, standby/camera).
  - The agent drives OBS through **obs-websocket** (v5 auth: `base64(sha256(base64(sha256(password + salt)) + challenge))`), launches OBS itself on `เริ่มถ่ายทอดสด` if it is closed, spawns the same ffmpeg RTMP listener `start-event.ps1` uses, reads Camo Studio's log (it has no API) to report whether the phone is connected, and uploads a 480px JPEG preview only while someone is looking at the page.
  - The standby scene **“พักรอ”** is created through the obs-websocket API on first connect, not by editing the scene collection file, so it cannot collide with whatever OBS last saved. It shows **`workers/event-live/standby.png`** — the hotel's own logo, full frame (the owner asked for that on 2026-09-13, replacing the navy “เดี๋ยวกลับมา / Be right back” card the first version drew). To change the card, replace that PNG (1920×1080) — the agent re-points the OBS source at it on every connect, and drops the old card's sources if they are still in the scene.
  - **Setup:** `setup-control.ps1` with OBS closed — it generates the password, uploads it as the worker secret `CONTROL_PASSWORD`, writes the same value to `E:\Steam Hotel\event-control-password.txt` (outside the repo), and switches on obs-websocket in `%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json`. **Run it with OBS closed** or OBS overwrites that file on exit.
  - **Running it:** the desktop program `E:\Steam Hotel\ROYS Event Control.bat` (or the “ROYS ควบคุมช่อง 21” shortcut on the desktop). Use it **or** `Start Event Live.bat`, never both — both spawn an ffmpeg listening on RTMP 1935.
  - **Measured 2026-09-13:** start from cold (OBS not even running) to a live channel, ~25s; standby/camera and mute/unmute take effect within ~5s; stop takes the channel off air in ~6s.
  - If the agent stops polling, the page shows a red “โน้ตบุ๊กออฟไลน์” banner. The desktop program below restarts the agent by itself; if the program is not running either, nothing does — someone has to open it on the laptop. (On 2026-09-13, before the program existed, the agent was killed along with the Claude session whose shell had started it and simply stayed dead.)
  - Debugging note: `/control/api/state` contains Thai scene names. Windows PowerShell 5.1's `Invoke-WebRequest` decodes JSON bodies as Latin-1, so Thai comes back as mojibake in the console even when the page is fine; compare by code point, not by eye.
- **The desktop program (`workers/event-live/app/`, added and tested 2026-09-13).** `roys-event-control.ps1` is a WinForms window plus tray icon that *owns* the agent: it starts it hidden, restarts it within a second if it dies, and shuts it down (but not OBS) when the owner quits. Same six commands as the phone page, plus the channel state, OBS/Camo state, a mic meter, today's request count, buttons to copy the control-page link and password, and a checkbox that puts a shortcut in the Startup folder.
  - It talks to the agent through three files in `E:\Steam Hotel\`, not through Cloudflare: `event-agent-command.txt` (one button press, picked up within half a second), `event-agent-status.json` (what the agent last saw), `event-agent-watch.txt` (touched while the window is open, which tells the agent to re-read OBS every 2s so the meter is live). The window therefore costs **zero** worker requests and keeps working when the internet is down. The agent's poll reply carries the channel state so the program can show “on air” and the daily budget for free.
  - `launch.vbs` starts it with no console window. Windows passes that hidden show state down the whole process tree, which cost a couple of hours on 2026-09-13: the program's own window never appeared (fixed by calling `ShowWindow` on the form), and **OBS** started invisibly and hung forever on its unanswerable “crash detected, start in Safe Mode?” prompt. The agent now launches OBS through `cmd /c start` (normal show state) **and** deletes stale `%APPDATA%\obs-studio\.sentinel\run_*` markers first — `--disable-shutdown-check` does not suppress that prompt in OBS 32.2.2.
  - The X button hides to the tray; only “ออกจากโปรแกรม” in the tray menu really quits (and it asks first if the channel is live, then stops the broadcast cleanly). Quitting kills the agent and its ffmpeg but deliberately spares OBS.
  - PowerShell notes, learned the hard way: the script must be saved **UTF-8 with BOM** or 5.1 renders every Thai string as mojibake; WinForms buttons appear as generic panes in UI Automation, so scripted testing has to send `BM_CLICK` to the child window; and never `Where-Object { $_.CommandLine -like '*roys-event-control*' }` from a shell whose own command line contains that string — it kills the shell.
- **Picture quality (tuned 2026-09-13 evening, after the owner said the picture was soft and the colours poor).** In order of how much each mattered:
  - **The canvas was throwing away sharpness.** The profile was 1920×1080 base → 1280×720 output while the camera captured 720p: every frame was scaled up and then back down. The canvas is now **1280×720 base and output**, and the camera captures **1920×1080** and is scaled once, down to it — supersampling, which is sharper than capturing 720p natively. Watch for this after any canvas change: OBS rescales existing scene items to keep their relative size, so re-set the item scale (`scaleX = baseWidth / sourceWidth`) rather than trusting bounds — a bounds change made in the same call as a source-size change is ignored.
  - **Bitrate**: `streamEncoder.json` 2500 → **3500 kbps**, preset `veryfast` → **`faster`** (i5-10300H, 8 threads, plenty for 720p30). 3500 keeps a full house inside the hotel's bandwidth — 20 rooms ≈ 70 Mbps. Advanced-output encoder settings live in that file, not in `basic.ini`, and OBS only reads it at startup, so change it with OBS closed.
  - **Filters on “กล้อง USB”**: `ปรับสี` (color_filter_v2) and `เพิ่มความคม` (sharpness). **They are tuned to the room and the framing, against measurements, not by eye** — re-tune them whenever the camera is moved or the lighting changes.
    - Current (2026-09-13, camera aimed at the lit display wall): **gamma −0.10, contrast +0.08, saturation +0.25, brightness +0.06, sharpness 0.12** — `YAVG 168, YLOW 116, YHIGH 216`, which keeps the whites clear of the 235 ceiling.
    - Two earlier states, for scale: dark room, camera at a dim corner → needed gamma **+0.45** just to reach `YAVG 90`, and the noise came up with it; after the hotel added light but before the camera was re-aimed → gamma +0.15 for `YAVG 84`. Re-aiming the camera at a lit wall moved `YAVG` from 84 to **186** on its own, which is the whole point: aim and light do far more than the filter.
    - How to re-tune: broadcast, then for each candidate set the filter, wait ~14s for the new frames to reach the live edge, and measure. Aim for `YAVG` around 100–170 depending on how bright the scene legitimately is, with `YHIGH` under about 225.
  - **What is left is light, not software**: the room needs lamps, and the camera's own exposure / white balance / focus live behind OBS → source Properties → **Configure Video** (a Windows property page; obs-websocket cannot reach it).
  - **Do not set this camera to 1080p15** hoping for a longer exposure: it stops delivering frames entirely (source goes 0×0, channel goes black) and needs the source deactivated and reactivated to come back. 1920×1080 **30fps** MJPEG is the mode that works.
  - Measuring quality without guessing: `ffmpeg -live_start_index -1 -i <channel url> -t 6 -vf signalstats,metadata=print -f null -` prints YLOW/YAVG/YHIGH/SATAVG for what viewers actually receive; `-update 1` over a few seconds writes the newest frame to a file to look at.
- **“OBS keeps freezing” (2026-09-13, late evening) — it was not the encoder.** While streaming 720p30 on the `faster` preset OBS used **9.3% CPU** on this i5-10300H, with 1 lagged frame in 4,954. Two other things were:
  - **A hidden source still holding a device that no longer exists.** `กล้อง Camo (มือถือ)` was hidden in the scene but still `active`, so OBS kept retrying the Camo virtual camera after Camo Studio was closed — `data.GetDevice failed` in the log, and a stuttering UI, because DirectShow retries block. Fix without deleting the source: `active: false` **and** `deactivate_when_not_showing: true`. Worth checking any time a camera is swapped out: an unused `dshow_input` left active is a liability, not a spare.
  - **Windows' `TextInputHost.exe` stuck at ~12% CPU** for hours (11,460 CPU-seconds). Killing it is safe — Windows starts it again on demand — and it came back idle.
  - The USB camera source is deliberately left **always active** (`deactivate_when_not_showing: false`) so switching back from the standby card is instant, and now decodes MJPEG in hardware (`hw_decode: true`).
  - Diagnosing this kind of thing: sample per-process CPU over 10s rather than trusting a Task Manager glance (`Get-Process` twice, diff `.CPU`, divide by seconds and cores), and read the OBS log for `lagged`/`skipped`/`data.GetDevice failed` — obs-websocket answering in 1 ms proves the core is healthy even when the window feels stuck.
- **Off air:** the playlist 404s ("Not live") whenever nothing has been uploaded for 30s, so outside events channel 21 shows the player's "not available" message. That is normal — the daily health check treats it as such.
- **Upload auth:** a bearer token. `setup-token.ps1` generates it, stores it as the worker secret `INGEST_TOKEN`, and writes the same value to `E:\Steam Hotel\event-ingest-token.txt` (outside the repo). Re-run it to rotate. It feeds wrangler through cmd's `<`, not a PowerShell pipe — Windows PowerShell appends CRLF to piped input, wrangler keeps the `\r` in the secret, and every upload then 401s.
- **The quota is the real constraint.** The Free plan's 100,000 Worker requests/day are per *account*, shared with the 3HD / Amarin / Pluto proxies (which use well under 100/day as of 2026-09-13). A viewer costs ~1,200 requests/hour, so the worker caps itself at `DAILY_BUDGET` = 85,000/day: once spent, it serves an `#EXT-X-ENDLIST` playlist, which makes players *stop polling* (rejecting requests wouldn't help — a rejected request still counts). The event goes off air until 07:00 Bangkok (00:00 UTC reset), but the rest of the lineup survives. Rough capacity: ~70 viewer-hours a day, e.g. 20 TVs for 3.5 hours. Check `/status` → `requestsToday` during an event.
- Durable Object limits that shaped the code: rows are capped at 2 MB (a 6s segment at 2.5 Mbps is ~1.9 MB, so segments are split into 1 MB rows); 100,000 rows written/day (the request counter lives in memory and is flushed every 200 requests or on each playlist upload, rather than written per request).
- If the owner ever accepts the R2 subscription, moving segment storage to R2 with public r2.dev reads would take viewing off the Worker quota entirely.

## Editing `iptv.m3u8`

Each channel is two lines:
```
#EXTINF:-1 tvg-id="..." tvg-logo="<logo url>" group-title="<category>",<Channel Name>
<stream url>
```
- `group-title` becomes the category chip / subtitle shown in the channel list UI — always set it.
- Keep a space between every attribute (`tvg-id="x" tvg-logo="y"`, not `tvg-id="x"tvg-logo="y"`) — missing spaces silently break some strict M3U parsers.
- If a channel's URL is `http://` (not `https://`), it will be blocked by the browser as mixed content on this HTTPS site. Find an `https://` mirror or route it through the CORS proxy.

## Content policy — read before adding a channel

Only add channels that are legitimately free-to-air or officially free-to-stream (public broadcasters, ad-supported OTT like Pluto TV, official free streams). **Do not add channels sourced from piracy-aggregator repos or sites that redistribute paid subscription content (e.g. MonoMax, premium sports feeds) without authorization** — this has come up before and was declined. If a user wants a paid service on the big screen, the answer is Cast/AirPlay from their own authenticated device/app, not embedding a scraped stream.

## Testing changes

There's no test suite. Verify changes by:
1. `curl`-checking the deployed file directly for the expected content (fast, reliable, no browser flakiness).
2. Loading the live URL in a real browser and exercising the actual interaction (channel switch, fullscreen, volume, PWA install) — don't just eyeball a screenshot.
3. **Sanity-check `<style>...</style>` balance after any CSS edit** — a previous edit once deleted the closing `</style>` tag, which caused the entire `<body>` to be parsed as CSS text and rendered a blank page. Quick check:
   ```
   grep -c '<style>' index.html; grep -c '</style>' index.html   # must match
   ```
4. When testing fullscreen or channel-switch behavior, remember `iOS Safari` has no `Element.requestFullscreen()` — this app deliberately avoids `video.webkitEnterFullscreen()` too (it hands the whole screen to Apple's native player chrome and hides our channel-picker UI). Fullscreen here always falls back to a CSS "pseudo-fullscreen" (`.player.pseudo-fs`, `position:fixed` + `100dvh/dvw`) so our own controls stay usable on every device.

## UX conventions already established

- Video fills the whole screen by default; the channel list is a popup/drawer (`#overlay`) opened via the "เปลี่ยนช่อง" button or a left-swipe, not a persistent sidebar.
- Arrow keys (desktop/remote): Up/Down = change channel, Left/Right = close/open the channel overlay.
- Touch: swipe up/down on the video = change channel, swipe left = open the overlay.
- The currently-playing channel gets a `LIVE` badge in the list — it's added/removed directly in `loadChannel()`/`markActive()`, not by re-rendering the whole list (re-rendering on every channel switch caused UI flicker/bugs in past iterations).
- Sound: browsers block autoplay-with-sound without a user gesture. The app tries unmuted autoplay first, falls back to a "tap to enable sound" prompt, and once unlocked never re-mutes automatically.
- Hotel info ticker (breakfast time / promo / front desk) is real content provided by the user — don't invent or guess hotel details; ask if something needs updating.

## Communicate in Thai

The project owner communicates in Thai. Match that in commit messages are fine in English, but any direct response/explanation to the user should be in Thai unless they switch languages first.
