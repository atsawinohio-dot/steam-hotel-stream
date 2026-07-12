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
- **Known limitation:** some origins (e.g. servers themselves fronted by Cloudflare) block requests from Cloudflare's own IP ranges, returning error 1042. The proxy can't work around that — those channels stay broken (currently: CH7 HD, Pluto TV Trending Now).
- **Known limitation:** extremely long upstream URLs (e.g. Pluto/Paramount+ ad-session tokens) can exceed the proxy's URL-length limit → HTTP 414. Currently affects Paramount+ Picks.

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
