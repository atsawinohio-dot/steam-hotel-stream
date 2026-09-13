# AGENTS.md — Steam Hotel IPTV

Shared instructions for AI coding agents working on this repo (Claude Code, ChatGPT Codex, Antigravity IDE, or any other agent that reads `AGENTS.md`). Keep this file in sync with reality — update it whenever the architecture or workflow changes.

## What this project is

A single-page IPTV web app for ROYS Hotel: fullscreen live-TV player with a slide-in channel picker, hosted as a static site on GitHub Pages, installable as a PWA. No backend, no build step, no framework — plain HTML/CSS/JS plus `hls.js` from a CDN.

Live site: https://atsawinohio-dot.github.io/steam-hotel-stream/

## Open work (2026-09-13)

The full, machine-specific handoff (status table, workspace layout on the hotel laptop, where secrets live, gotchas) is in `E:\Steam Hotel\CLAUDE.md` on the hotel laptop — Claude Code loads it automatically when opened anywhere under that folder. Summary for anyone working from a fresh clone:

1. **Decide whether 16 fps is acceptable.** The picture is tuned as of 2026-09-13 23:15 (`YAVG 116`), but only because exposure went to −4, which halves the frame rate to 16. Ask the owner: smooth motion or a visible picture. `camera-settings.ps1 -Exposure -5` returns 30 fps and needs `tune-image.mjs --apply` re-run afterwards. More light removes the choice entirely.
2. **Verify channel 21 audio with real speech — still never done.** Run `workers/event-live/test-mic.ps1` (or `Test Mic.bat`) while someone talks near the camera — it needs no broadcast and no quota. A room with nobody speaking says nothing about speech levels, so the script refuses to grade a clip with no speech in it. Note the mixer fader on `ไมค์กล้อง USB` is back at 0 dB (it was at −13.4 dB earlier the same evening, cancelling most of the +10 dB filter), so the chain currently nets the documented +10 dB — correct level problems at the gain filter, not the fader.
3. The owner still needs to disable the laptop's built-in webcam in Device Manager (it wedges every camera when opened).
4. **Light the room the camera points at.** Still the ceiling on picture quality, and not a software problem. At the unlit desk corner (`YAVG 8/255`) no filter value worked at all — maxing gamma only produced full-frame colour speckle. The lit curtain it faces now tops out at `YAVG 116` against a 155 target.
5. **`roys-ch21-live-guard` has logged nothing since 20:02 on 2026-09-13** although it is an hourly task, and it missed a real broadcast between 23:02 and 23:14. Check the scheduled task.

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
    - **The filter chain is not the whole chain — the fader is part of it, and here it fights the filter.** OBS applies source filters first and the mixer fader after, and this source's fader is at **0.213 linear = −13.4 dB**, so the documented "+10 dB" is really **−3.4 dB** end to end. A side effect worth knowing: the limiter caps peaks at −1 dB *before* the fader, so on-air peaks can never exceed about −14.4 dB no matter how loud the room gets. Read `volume` out of the scene JSON alongside the filters before drawing any conclusion about levels.
    - **Testing levels without going on air: `workers/event-live/test-mic.ps1`** (`Test Mic.bat` for the owner). It records the mic through dshow, reads the real gain / fader / limiter values out of `ROYS_Event.json` so it can never quote stale numbers, replays that exact chain through ffmpeg (`volume` → `alimiter` → `volume`), and reports both raw and predicted on-air levels. `-File <wav>` re-analyses a recording instead of recording, which is also how its two verdict paths were tested. It does not model RNNoise, so the real noise floor will be lower than it reports while speech is roughly unchanged — conservative in the right direction.
    - **A level check with nobody speaking is worse than no check**, because this room's noise floor alone lands inside the −30…−20 dB target band (`mean −25.7 dB` predicted on air) and the test then reports "fine". The script therefore splits each clip into its loud and quiet parts (90th and 10th percentile of short-window RMS), grades the **speech level** rather than the overall mean — the mean just tracks how much of the clip was silence — and refuses to grade at all when the two are within 8 dB. Do not lower that gate: an empty room measured 15.8 dB of spread on its own, so a *small* spread is the only reliable evidence that nobody spoke.
    - `check-audio.ps1` remains the end-to-end check from the viewer's side, but it needs a live broadcast and spends quota, and its comments still describe the old +20 dB phone rig.
  - The agent picks its mic from `MIC_INPUTS` (`ไมค์กล้อง USB` → `ไมค์มือถือ (Camo)` → the laptop mic), whichever the scene collection has, so the mute button keeps working after a swap. It also reports `camera.active` (from `GetSourceActive`), which is what the desktop program's “กล้อง” row shows — a source can exist and still be black.
  - The phone sources (`กล้อง Camo (มือถือ)`, `ไมค์มือถือ (Camo)`) are **hidden, not deleted**, so the phone rig is one click away if the USB camera ever fails.
- **Camera, the old phone rig (2026-09-13, daytime — kept for reference):** the event camera is the owner's phone ("A16") through **Camo** — Camo Studio on the laptop pairs with the Camo app over Wi-Fi and exposes a "Camo" virtual camera, which the Event scene uses as a Video Capture Device ("กล้อง Camo (มือถือ)"), with the phone's mic ("ไมค์มือถือ (Camo)") as the audio. After a laptop restart Camo Studio can fall back to "DroidCam Video" as its device and OBS then shows a "Start DroidCam" card — pick the phone again under Device in Camo Studio. The laptop's built-in "USB2.0 HD UVC WebCam" never delivered frames (it is toggled by ASUS Fn+F10 and vanished after reboot); don't rely on it. Worse, *anything that opens it wedges Windows' Camera Frame Server for every camera*, Camo included (seen twice on 2026-09-13: Camo Studio picked the webcam, then Camo itself hung in OBS and ffmpeg). Keep it **disabled in Device Manager**; if Fn+F10 or a driver update brings it back, disable it again and Restart.
  - If OBS logs `data.GetDevice failed` for a camera that works elsewhere, check two things: Windows' Camera Frame Server can wedge so that *every* frame-server camera (built-in and Camo) hangs in DirectShow while DroidCam still works — a real **Restart** fixes it (Fast Startup is on, so Shut down does not); and OBS's `video_device_id` must be `<name>:<path>` with `#` escaped as `#22` and the path starting `\\?\` (two backslashes, as Windows spells device paths) — one backslash also gives `GetDevice failed`.
- **Remote control from a phone (added and tested end to end 2026-09-13):** `https://steam-hotel-event.tiny-hall-8718.workers.dev/control` — a page (no password since 2026-09-14, see below) that starts and stops the broadcast, mutes the mic, drops a standby card over the camera, and shows a preview frame plus a mic level meter. Built because the owner wanted to run an event from their phone without standing at the laptop.
  - **Shape:** `control.js` lives in the *same* Durable Object as the video, so the control side shares one request budget and one piece of state with the channel. The phone talks to `/control/api/*` with a session cookie (HMAC of `CONTROL_PASSWORD`, valid 12h, 10 failed logins per 10 minutes then a 429); the laptop's agent talks to `/control/agent` with `Bearer INGEST_TOKEN`.
  - **The page has no password as of 2026-09-14 — the owner asked for it and confirmed after being told what it means.** Anyone with the URL can start and stop the broadcast, mute the mic, and see a preview frame from inside the hotel. The 12-hour session was the reason: it meant retyping a 14-character password on a phone twice a day. Offered alternatives that keep a barrier (a 90-day session plus a 6-digit code, or a saved magic link) were declined.
    - **Auth is keyed off the secret, not deleted from the code.** `sessionValid()` returns true when `env.CONTROL_PASSWORD` is unset, and the login route accepts anything in that state so a stale page still works. Turn the password back on with `npx wrangler secret put CONTROL_PASSWORD` in `workers/event-live` — no code change, no redeploy. Turn it off again with `wrangler secret delete CONTROL_PASSWORD` (`CI=true` for a non-interactive confirm).
    - `INGEST_TOKEN` is untouched by this and still gates every upload and agent poll — deleting the control password does **not** open the ingest path. Verified after the change: a wrong bearer gets 401, the real one gets 200.
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
  - **Filters on “กล้อง USB”**: `ปรับสี` (filter id `color_filter`, OBS's "Color Correction") and `เพิ่มความคม` (sharpness). **They are tuned to the room and the framing, against measurements, not by eye** — re-tune them whenever the camera is moved or the lighting changes.
    - **Which knob does what — measured on this camera, 2026-09-13, through OBS's own render** (`GetSourceScreenshot` of the `Event` scene, which is exactly what goes to air). Sweep each knob with the others at 0:

      | knob | 0 → +0.3 | full range | black level (`YMIN`) |
      |---|---|---|---|
      | `gamma` | 26 → 36 | 0 → 1.5 gives `YAVG` 26 → 71 | stays at 16 until gamma ≈ 1.0 |
      | `brightness` | 26 → **145** | saturates to white by +1.0 | **16 → 143** — destroys black |
      | `contrast` | 26 → 28 | whole range moves `YAVG` 23 → 34 | stays 16; controls highlights only |

      So **`gamma` is the brightness control and `brightness` is a trap**: it is a flat additive offset, so it lifts the black floor with everything else and the picture turns into grey fog. The `brightness +0.06` that was in the filter lifted the black level from 16 to **74** — measurably a picture with no blacks in it. Tune with `gamma`, leave `brightness` at 0.
    - Current (2026-09-13 23:15, camera re-aimed at a lit curtain, tuned by `tune-image.mjs --apply`): **gamma +0.8, contrast +0.16, saturation +0.22, brightness 0, sharpness 0.12** — `YAVG 116, YHIGH 144`, black floor back at 16, noise 3.05, `SATMAX` 36. The tuner stopped at 0.8 of its own accord: gamma 1.2 pushed `SATMAX` to 47 and the shadows went magenta. `YAVG 116` is short of the 155 target and that is the honest ceiling for this much light.
    - Camera settings changed with it: **exposure −5 → −4, gain 128 → 96** (see the camera-controls notes below). Both were measured on this framing, not carried over. Saturation is up because the frame is mostly white wall: `SATAVG` barely moves (5.2 → 5.7) while the figurines on the shelves visibly gain colour, so judge saturation by eye and use `SATAVG` only to check it is not runaway.
    - Colour balance was checked rather than assumed: `UAVG 127.1 / VAVG 130.4` against a neutral 128, i.e. a barely-there warm lean. The wall *looks* cool grey because it is cool grey — no white-balance correction was applied, and none should be without the numbers asking for one. Real white balance lives in the camera's own Configure Video page anyway, not in a filter.
    - Two earlier states, for scale: dark room, camera at a dim corner → needed gamma **+0.45** just to reach `YAVG 90`, and the noise came up with it; after the hotel added light but before the camera was re-aimed → gamma +0.15 for `YAVG 84`. Re-aiming the camera at a lit wall moved `YAVG` from 84 to **186** on its own, which is the whole point: aim and light do far more than the filter.
    - **How to re-tune: `node workers/event-live/tune-image.mjs`** (OBS open, no broadcast needed, no quota). It reads the picture back out of OBS, binary-searches `gamma` for the target `YAVG`, drops `contrast` if the highlights clip, and **restores every filter value it touched unless you pass `--apply`**. Flags: `--target=155 --max-high=225 --max-noise=2.0`.
      - **Two guards, because brightness numbers alone were wrong twice.** The first ruined picture was temporal: pushing gamma in a dark room amplified sensor noise until the frame was solid colour speckle. The second was spatial and survived the first guard — shadows (a pole, a metal rack) turned into flat magenta blotches that do not flicker, so a frame-to-frame difference reads them as clean. The catch is `SATMAX`, the most saturated pixel in the frame: on a pale curtain it tracked the blotching exactly (32 → 44 → 60 → 75 as gamma went 0 → 1.2 → 2.06 → 3.0) while **`SATAVG` moved the wrong way** (11.3 → 10.3), because the washed-out curtain fills most of the frame and dilutes the average. This is the `SATAVG` trap already noted below, in a new costume: measure the extreme, not the mean, when the artefact is local.
      - It measures noise as well as brightness, and that guard is the whole point. Without it the search happily returned `gamma 2.98` — `YAVG 90`, black level 16, every brightness number healthy — and the actual frame was solid magenta-and-blue speckle, because pushing gamma in a dark room amplifies sensor noise faster than signal. Brightness statistics alone cannot tell a good picture from a ruined one; the tuner now takes two screenshots 250 ms apart and measures the mean absolute difference between them (`blend=all_mode=difference` → `signalstats`), stopping as soon as that exceeds 1.5× the noise at neutral settings.
      - The noise reference is taken at `gamma 0, brightness 0`, not from the picture as found: a picture squashed flat by a positive `brightness` measures *less* noise (0.34 vs 1.12 here) purely because the veil compresses the differences.
      - The old manual route still works: broadcast, set the filter, wait ~14s for frames to reach the live edge, and measure off the channel. Aim for `YAVG` around 100–170 depending on how bright the scene legitimately is, with `YHIGH` under about 225.
    - **Never send `opacity` in `SetSourceFilterSettings` for this filter.** Passing `opacity: 100` (the value OBS's UI shows) produced a wildly blown-out render — `YAVG 106` where the untouched picture read 26, and `brightness ±0.25` then saturating the whole frame to pure white or pure black. A whole sweep was measured and thrown away before this was spotted. Send only the four keys the filter actually stores (`gamma`, `contrast`, `brightness`, `saturation`); anything omitted falls back to a correct default, and `{gamma:0, contrast:0, brightness:0, saturation:0}` reproduces the filter-disabled picture exactly (26 vs 25.6 — the check worth running whenever a sweep looks strange).
  - **The camera's own controls are reachable from a script** — `workers/event-live/camera-settings.ps1` talks to the driver through DirectShow (`IAMVideoProcAmp` / `IAMCameraControl`), which is what sits behind OBS's “Configure Video” button and what obs-websocket cannot touch. `.\camera-settings.ps1` prints every control with its range, value and auto/manual mode; `-WhiteBalance 5100`, `-Exposure -6`, `-Gain`, `-Hue`, `-Saturation`, `-WhiteBalanceAuto`, `-ExposureAuto` set them. Settings live in the camera, so they outlast OBS restarts, and — despite the warning the script prints — they can be changed while OBS is streaming: the driver accepts property changes on a separately bound filter.
  - **White balance is locked at 5100 K (was auto).** Auto white balance drifts as people move through frame, which is what “สีไม่ดี” looked like. The value came from sweeping 3600–6000 K and measuring `UAVG`/`VAVG` off the live channel: 4800–5100 keeps the blue–amber axis closest to neutral (`UAVG` 125–132 against 128).
  - **Re-measured 2026-09-13 23:15 after the camera moved to a lit curtain, and the old numbers did not survive the move.** Frame rate came out at **30.2 fps at exposure −5** (not the 23 recorded earlier) and **gain turned out not to affect frame rate at all** — 30.2 fps at every gain from 0 to 128, so gain buys brightness and pays only in noise. Exposure is still the frame-rate control: −5 → `YAVG 31` at 30.2 fps, **−4 → `YAVG 67.6` at 16 fps**. −4 is what the channel runs now, because at −5 this room is too dark to tune at all; if an event needs smooth motion more than it needs a visible picture, put it back to −5 and add light. With the longer exposure, gain came down from 128 to **96**: at −4, gain 128 gave `YAVG 77.5` at noise 4.57 while 96 gave 61.5 at noise 3.00, and the filter recovers that brightness more cleanly than the sensor does.
  - **Exposure, gain and focus are locked too, and the reason is frame rate.** This camera buys brightness with exposure time, and exposure time caps the frame rate — measured straight off the device in this room: auto → `YAVG 109` but only **12.7 fps**; exposure −6 → 23 fps but `YAVG 24`; **exposure −5 with gain 128 → `YAVG 96` at 23 fps**, which is nearly auto's brightness at nearly double the frame rate. That is what is locked. Auto exposure had been quietly running the channel at ~13 fps (OBS pads the rest), so “the video looks juddery” would have had nothing to do with the network.
  - **Focus: locked at 80.** The sweep (file size of a fixed-quality JPEG, a more stable sharpness proxy than an edge score) is flat from 0 to 250 and falls off after 300 — a small sensor with deep depth of field, so anything from the wall to the sofa is in focus. The point of locking it is not sharpness but stillness: autofocus hunting mid-event is what makes a picture breathe in and out.
  - Re-run `camera-settings.ps1` sweeps if the camera moves to a different room or the lighting changes; the numbers above are for this room, ~2–3 m from the display wall. Everything goes back with `-ExposureAuto`, `-FocusAuto`, `-WhiteBalanceAuto`.
  - **The stubborn “green cast” is the wall.** `VAVG` stayed 112–118 at every white-balance value, and a wider shot showed why: the room's wall really is mint green. Do not chase `VAVG` to 128 — that would paint a green wall grey. White balance moves the blue–amber axis only; green–magenta is not a white-balance control.
  - **Saturation in the OBS filter amplifies any cast**, because it scales chroma away from 128: at +0.38 the wall's `VAVG` read 112, at +0.22 it read 115 with the same camera settings. If a cast looks worse than it measures at the camera, check the filter before blaming the camera.
  - **What is left is light, not software**: the room needs lamps, and the camera's own exposure / white balance / focus live behind OBS → source Properties → **Configure Video** (a Windows property page; obs-websocket cannot reach it).
  - **Do not change this camera's capture mode while OBS is running.** Setting `resolution` / `frame_interval` through obs-websocket drops the device (source goes 0×0) and it does not come back until OBS restarts. Change it in `%APPDATA%\obs-studio\basic\scenes\ROYS_Event.json` with OBS **closed** instead.
  - **`data.GetDevice failed` while `ffmpeg -f dshow -i video="USB 2.0 Camera"` still works means the saved device id is wrong, not the camera.** That happened here by writing the id from a script with one escape level too many: the value must decode to exactly `USB 2.0 Camera:\\?\usb#22…#22{guid}\global` — two backslashes, `?`, one backslash — and a doubled version silently fails every OBS start. Check it with `python -c "import json;print(repr(json.load(open(path))['sources']…))"`, not by eye in the file.
  - **Do not set this camera to 1080p15** hoping for a longer exposure: it stops delivering frames entirely (source goes 0×0, channel goes black) and needs the source deactivated and reactivated to come back. 1920×1080 **30fps** MJPEG is the mode that works.
  - Measuring quality without guessing: `ffmpeg -live_start_index -1 -i <channel url> -t 6 -vf signalstats,metadata=print -f null -` prints YLOW/YAVG/YHIGH/SATAVG for what viewers actually receive; `-update 1` over a few seconds writes the newest frame to a file to look at.
- **“OBS keeps freezing” (2026-09-13, late evening) — it was not the encoder.** While streaming 720p30 on the `faster` preset OBS used **9.3% CPU** on this i5-10300H, with 1 lagged frame in 4,954. Two other things were:
  - **A hidden source still holding a device that no longer exists.** `กล้อง Camo (มือถือ)` was hidden in the scene but still `active`, so OBS kept retrying the Camo virtual camera after Camo Studio was closed — `data.GetDevice failed` in the log, and a stuttering UI, because DirectShow retries block. Fix without deleting the source: `active: false` **and** `deactivate_when_not_showing: true`. Worth checking any time a camera is swapped out: an unused `dshow_input` left active is a liability, not a spare.
  - **Windows' `TextInputHost.exe` stuck at ~12% CPU** for hours (11,460 CPU-seconds). Killing it is safe — Windows starts it again on demand — and it came back idle.
  - The USB camera source is deliberately left **always active** (`deactivate_when_not_showing: false`) so switching back from the standby card is instant, and now decodes MJPEG in hardware (`hw_decode: true`).
  - Diagnosing this kind of thing: sample per-process CPU over 10s rather than trusting a Task Manager glance (`Get-Process` twice, diff `.CPU`, divide by seconds and cores), and read the OBS log for `lagged`/`skipped`/`data.GetDevice failed` — obs-websocket answering in 1 ms proves the core is healthy even when the window feels stuck.
- **The watching bots (added 2026-09-13, at the owner's request for “ทีม AI bot”).** Three of them, deliberately split by how fast they need to react and what they cost:
  1. **ยามเฝ้าออกอากาศ — inside the desktop program, every second, zero worker requests.** It already has the agent's status locally, so it raises a tray alert and a `เตือน:` line in `event-control.log` for: a black picture on air (camera not delivering while the standby card is *not* up, 20s), a mic left muted (90s), a mic that is on but silent (`micDb < -55`, 2 min), OBS streaming while nothing reaches Cloudflare (45s — shorter cried wolf 3 seconds after “start”), a broadcast running past 3 hours, the daily budget past 70% and 90%, and the agent going quiet mid-broadcast. Each alert has its own cooldown so a long fault does not become a stream of notifications.
  2. **ตรวจ 21 ช่องทุกเช้า 08:00** — the existing `iptv-channel-health-check` scheduled task. Whole-lineup outage detection; notifies only on failure.
  3. **ยามโควตา/ลืมปิดไลฟ์ — `roys-ch21-live-guard`, hourly.** One `/status` call plus the local status file; notifies only if the channel has been live over 3 hours, is live between 23:00 and 06:00, the budget is past 60%, the budget is spent, the worker is unreachable, or the channel is broadcasting black. Logs every run to `E:\Steam Hotel\ch21-guard.log` whether it alerts or not. This is the one that catches the expensive mistake: a broadcast left running overnight spends the account-wide request budget and takes **every** channel down until 07:00.
  - The split matters: anything that needs a reaction in seconds belongs in the program (it is already polling), and anything that must work when the laptop's program is closed belongs in a scheduled task. Scheduled tasks only run while the Claude app is open on the laptop.
- **Off air:** the playlist 404s ("Not live") whenever nothing has been uploaded for 30s, so outside events channel 21 shows the player's "not available" message. That is normal — the daily health check treats it as such.
- **Upload auth:** a bearer token. `setup-token.ps1` generates it, stores it as the worker secret `INGEST_TOKEN`, and writes the same value to `E:\Steam Hotel\event-ingest-token.txt` (outside the repo). Re-run it to rotate. It feeds wrangler through cmd's `<`, not a PowerShell pipe — Windows PowerShell appends CRLF to piped input, wrangler keeps the `\r` in the secret, and every upload then 401s.
- **Startup latency: where the ~25 seconds between "start" and a picture actually goes.** Timed off the agent's own log on 2026-09-14, from a real start the owner triggered:

  | phase | time |
  |---|---|
  | command received → Camo killed → OBS launched | 2s |
  | OBS launched → obs-websocket answering | 4s |
  | everything after that | ~19s |

  So OBS is not the problem, and pre-warming it would buy about 6 seconds at most. The bulk is the player: an HLS client conventionally buffers three segments before it renders anything, and at `hls_time 6` that is 18 seconds. Two changes attack that without touching the request rate:
  - **`#EXT-X-START:TIME-OFFSET=-6,PRECISE=YES`**, injected by the worker in `startAtLiveEdge()` as it serves the playlist (the stored playlist is left untouched). It tells the player to begin one segment back from the live edge instead of choosing for itself. One segment of margin rather than zero, so a briefly slow player still has something buffered.
  - **`-hls_init_time 2`** on the ffmpeg listener, so the *first* segment is cut at the next keyframe after 2s (OBS keyframes every 2s) while every segment after it stays at `hls_time 6`. There is something to fetch about 4 seconds sooner and the steady-state segment count is unchanged.
  - **Why not just shorten `hls_time`:** it divides the latency and multiplies the request count by the same factor. At 6s a viewer costs ~1,200 requests/hour and the budget allows ~70 viewer-hours; at 2s that becomes ~3,600/hour and ~23 viewer-hours — 20 TVs would get about 70 minutes instead of 3.5 hours. That trade is the owner's to make, not a default.
  - Neither change has been measured end to end against the TV yet — the remaining unknown is how the M3U IPTV app behaves, including how quickly it retries after the 404 the channel serves while off air. Time it from the owner pressing start to a picture appearing, and record the number here.
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
