# HANDOFF.md

Live status board for handing work between AI agents (Claude Code, ChatGPT Codex, Antigravity IDE, or any other tool used on this repo). See `AGENTS.md` for project background/rules — this file is just "where things stand right now."

**Rule: whichever agent picks up a session reads this file first, and whichever agent stops (task done, or approaching its context/usage limit) updates it before stopping.**

---

## Status: idle

_No agent currently mid-task. Last updated by: Claude (Claude Code) — 2026-07-19._

## Last completed

- Fixed 3HD (channel 3) end to end — this took several rounds, all confirmed fixed by the project owner testing the "M3U IPTV" Windows app on the real hotel network:
  1. **Dead stream URL**: old URL (`live-us1.thaimomo.com/...`) was 404, and every public mirror tried (v2h-cdn, byteark direct, etc.) was dead or 403'd. Real cause: ch3plus.com's official stream uses a server-side-signed URL that expires ~12h with no public token API. Fix: new Cloudflare Worker `workers/ch3-proxy/` (live at `steam-hotel-ch3-proxy.tiny-hall-8718.workers.dev`) that re-derives the signed URL from `ch3plus.com/live`'s HTML periodically and proxies the manifest/segments. See `AGENTS.md` § CH3 auto-refresh proxy.
  2. **Blurry picture**: the app's hls.js uses `startLevel: 0, testBandwidth: false` (index.html) — always starts on whichever quality is listed first, no probe. Upstream's master playlist listed 144p first. Fix: worker reorders master playlist variants highest-bandwidth-first.
  3. **Audio stutter, round 1**: 720p (3.5Mbps) left too little margin against the app's 10s hls.js buffer. Fix: worker caps the master playlist at 480p, dropping 720p entirely (not just reordering) so ABR can't climb back to it either.
  4. **Audio stutter, round 2 (rhythmic, ~8s cadence, only in the separate "M3U IPTV" Windows app — not on ch3plus.com directly and not in our own hls.js player)**: root cause turned out to be that app's own ABR/quality-switching logic choking on the multi-variant master playlist itself, not the proxy or stream. (Along the way also fixed two real proxy bugs worth keeping regardless: a `response.clone()` on the hot segment-serving path was teeing the stream and adding backpressure; the direct/cache-miss path wasn't forwarding the client's `Range` header to origin, so a lost prefetch race would silently return 200 instead of 206.) **Actual fix**: point the channel entry straight at a single-quality media playlist (`/live/playlist_480p/index.m3u8`) instead of the master, removing ABR from the picture entirely for that app.
- Fixed dead ROYS HOTEL logo URL (old `closte.com` CDN subdomain stopped resolving) — now points at `www.theroyshotel.com/wp-content/uploads/2026/03/ROYS-Logo.webp`.
- Looked into adding Mono29: declined. Mono29's official free stream (now hosted at monomaxsports.tv after a domain consolidation, but still genuinely free content) is DRM-protected (Widevine/FairPlay via ByteArk DRM), which this app's plain hls.js setup can't play and which we shouldn't try to circumvent. See AGENTS.md § Content policy.
- Added `AGENTS.md` + this `HANDOFF.md` so Claude Code / Codex / Antigravity can coordinate.
- Fixed channel-list-overlay "bounce" bug on iPhone (open-then-immediate-close double-fire, guarded with a 250ms same-gesture debounce in `openOverlay()`/`closeOverlay()`).
- Fixed iOS fullscreen: no longer calls `video.webkitEnterFullscreen()` (which hid our channel-picker UI); always uses the CSS pseudo-fullscreen fallback instead.
- Declined a request to add "MonoMax Sport TV" — every available stream URL traced back to unauthorized piracy-aggregator redistribution of a paid subscription service. Do not revisit this without a legitimate source (see AGENTS.md § Content policy).

## In progress

_Nothing in progress._

## Next up / open threads

- Nothing queued. Ask the project owner what's next.
- If `workers/ch3-proxy` ever breaks: `ch3plus.com/live`'s HTML probably changed and no longer contains `streamUrlWebAVOD"` — check the page source and update the regex in `workers/ch3-proxy/worker.js`.
- 3HD is currently pinned to 480p with no quality selector (see above) — if a future agent is tempted to switch it back to the adaptive master playlist for sharper picture, know that this previously caused unfixable-from-our-side stutter in the "M3U IPTV" Windows app specifically. Test in that exact app before changing it back.
- Known unfixed limitations (not currently being worked on, just tracked): CH7 HD and Pluto TV Trending Now can't play (upstream blocks Cloudflare IP ranges, error 1042); Paramount+ Picks fails through the CORS proxy (upstream URL too long, HTTP 414). See `AGENTS.md` § CORS proxy.

## Handoff template

Copy this when you stop mid-task:

```md
## Status: in progress

_Picked up by: <tool name> — <date>._

## Last completed
- <what you just finished and verified working>

## In progress
- <exact task>, <why you're stopping: done for now / hit usage limit / blocked>
- Files touched so far: <paths>
- Anything half-done or uncommitted: <state, and whether it's safe to continue vs needs review first>

## Next up
- <the very next concrete step, written for someone with zero memory of this session>
```
