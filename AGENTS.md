# AGENTS.md — Steam Hotel IPTV

Shared instructions for AI coding agents working on this repo (Claude Code, ChatGPT Codex, Antigravity IDE, or any other agent that reads `AGENTS.md`). Keep this file in sync with reality — update it whenever the architecture or workflow changes.

## What this project is

A single-page IPTV web app for ROYS Hotel: fullscreen live-TV player with a slide-in channel picker, hosted as a static site on GitHub Pages, installable as a PWA. No backend, no build step, no framework — plain HTML/CSS/JS plus `hls.js` from a CDN.

Live site: https://atsawinohio-dot.github.io/steam-hotel-stream/

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
- Used directly (no `?url=` param) as the 3HD channel URL: `.../live/playlist.m3u8`
- How it works: on each request it checks a KV-cached signed query string; if missing/near-expiry it re-fetches `ch3plus.com/live`, regexes out `streamUrlWebAVOD`, and caches the query params (refreshed ~30min before the real `x_ark_expires`). It then proxies the manifest/segments from `ch3-33-web.cdn.byteark.com`, stripping the signed query off every relative URI in `.m3u8` bodies so all follow-up requests keep routing through the worker (which reattaches a fresh token server-side).
- If this breaks: check whether `ch3plus.com/live`'s HTML still contains `streamUrlWebAVOD":"..."` — if CH3 changes their page structure, the regex in `workers/ch3-proxy/worker.js` needs updating.

### ROYS PROMO endless-loop generator

A static playlist can only loop a *finite* number of times before `#EXT-X-ENDLIST` stops the channel. To make the hotel's own signage reel run forever, the manifest is generated per request instead.

- Source: `workers/promo-loop/` in this repo. No KV, no secrets — `wrangler deploy` from that folder is all it takes.
- Deployed as: `steam-hotel-promo-loop.tiny-hall-8718.workers.dev`
- Used as the ROYS PROMO channel URL: `.../playlist.m3u8`
- How it works: emits a 6-segment sliding-window LIVE playlist (no `EXT-X-ENDLIST`) positioned by wall-clock time — `floor(elapsed / 4) mod 6` picks the segment that should be airing. **This depends on the reel being an exact multiple of the segment duration** (24.000s = 6 × 4.000s); if the reel is ever re-encoded to a length that doesn't divide evenly, the clock arithmetic drifts and the constants at the top of `worker.js` must be updated to match.
- Side effect worth knowing: because position comes from the clock, every TV in the hotel shows the same frame at the same time, like a real broadcast channel, rather than each guest starting the reel from frame 0.
- Only the manifest goes through the worker; segment URIs are absolute GitHub Pages URLs (Pages already sends `Access-Control-Allow-Origin: *`), so video bandwidth is player→Pages and never touches Cloudflare — same split as the Pluto shim.
- `promo/playlist.m3u8` (static, 24h then stops) is left in the repo as a fallback if the worker ever needs to be bypassed.

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
