# HANDOFF.md

Live status board for handing work between AI agents (Claude Code, ChatGPT Codex, Antigravity IDE, or any other tool used on this repo). See `AGENTS.md` for project background/rules — this file is just "where things stand right now."

**Rule: whichever agent picks up a session reads this file first, and whichever agent stops (task done, or approaching its context/usage limit) updates it before stopping.**

---

## Status: idle

_No agent currently mid-task. Last updated by: Claude (Claude Code) — 2026-07-20._

## Last completed

- **Fixed CH3 again — byteark started geo-blocking Cloudflare Workers' egress (2026-07-20).** Owner reported "ch3 ดูไม่ได้" (can't watch). Diagnosis: the signed token from `ch3plus.com/live` was fine (verified valid directly), but every request the `ch3-proxy` worker made to `ch3-33-web.cdn.byteark.com` came back `451 Unavailable For Legal Reasons` — confirmed via `wrangler tail` and `wrangler dev --remote` that the worker always executes from Cloudflare's Singapore colo (`CF-RAY: ...-SIN`), and Cloudflare has no compute PoP inside Thailand, so there's no way to make the Worker's own fetch originate from a Thai IP (tried `[placement] mode = "smart"` first — did not help, reverted). Root cause: byteark now geo-fences the actual video CDN to Thailand IPs (confirmed: a request from a Thailand-geolocated IP got 200 with the exact same token that got the Worker 451). `ch3plus.com/live` itself (the token source page) is *not* geo-blocked, only the byteark video CDN is.
  - **Fix:** rewrote `workers/ch3-proxy/worker.js` from a full proxy into a **302 redirect**. The worker still scrapes/refreshes the signed token from `ch3plus.com/live` into KV exactly as before (that part was never broken), but instead of fetching and streaming byteark's manifest/segments itself, it now redirects the player straight to the real signed byteark URL. The actual video traffic then leaves from the player's own IP (the hotel's Thailand network), which passes byteark's geo-check. Bonus: this is simpler — no more manifest rewriting/reordering/prefetch-caching logic needed, since the channel is already pinned to the single-quality `playlist_720p` endpoint (see below) and byteark's own manifest already embeds a valid signed query on every segment URI.
  - Verified end-to-end after deploy: worker returns `302` → `Location` points at a fresh byteark URL → that URL returns `200` with a live manifest (increasing media-sequence numbers) → fetched an actual `.ts` segment referenced in it and confirmed a real MPEG-TS sync byte (`0x47`), 726 KB.
  - If this breaks again: check the same way — `curl -D- <worker-url>` for the status code, and `curl` the byteark URL directly from a Thailand-geolocated IP to tell "token problem" (fails from Thai IP too) apart from "geo-block problem" (works from Thai IP, fails from the worker). If byteark ever blocks Thailand IPs too or changes how it detects Cloudflare, this redirect approach stops working and there's no fix possible purely within Cloudflare Workers (no Thai compute PoP) — would need to host the redirect/proxy on a server that actually has a Thailand-based IP (e.g. a Thai VPS, or AWS's Bangkok region) instead.
  - Note: `iptv.m3u8` actually points CH3 at `/live/playlist_720p/index.m3u8` (not `playlist_480p` as older entries below still say — that was superseded by commits `41556d4`/`3eac330`, HANDOFF wasn't updated at the time). The `MAX_BANDWIDTH`/480p-cap logic mentioned below no longer exists in the worker — it's moot now since the channel is pinned directly to a single-quality endpoint upstream instead.
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
