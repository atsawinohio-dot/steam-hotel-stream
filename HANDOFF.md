# HANDOFF.md

Live status board for handing work between AI agents (Claude Code, ChatGPT Codex, Antigravity IDE, or any other tool used on this repo). See `AGENTS.md` for project background/rules — this file is just "where things stand right now."

**Rule: whichever agent picks up a session reads this file first, and whichever agent stops (task done, or approaching its context/usage limit) updates it before stopping.**

---

## Status: idle

_No agent currently mid-task. Last updated by: Claude (Claude Code) — 2026-07-19._

## Last completed

- Fixed 3HD (channel 3): the old URL (`live-us1.thaimomo.com/...`) was dead (404), and every public mirror tried (v2h-cdn, byteark direct, etc.) was either dead or 403'd. Traced the real cause to ch3plus.com's official stream using a server-side-signed URL that expires ~12h and has no public token API. Built and deployed a new Cloudflare Worker (`workers/ch3-proxy/`, live at `steam-hotel-ch3-proxy.tiny-hall-8718.workers.dev`) that periodically re-derives the signed URL from `ch3plus.com/live`'s HTML and proxies the manifest/segments. Verified master playlist → variant playlist → segment all return 200 end-to-end. See `AGENTS.md` § CH3 auto-refresh proxy. **Not yet confirmed working from the hotel's actual network/player** — ask the project owner to test.
- Added `AGENTS.md` + this `HANDOFF.md` so Claude Code / Codex / Antigravity can coordinate.
- Fixed channel-list-overlay "bounce" bug on iPhone (open-then-immediate-close double-fire, guarded with a 250ms same-gesture debounce in `openOverlay()`/`closeOverlay()`).
- Fixed iOS fullscreen: no longer calls `video.webkitEnterFullscreen()` (which hid our channel-picker UI); always uses the CSS pseudo-fullscreen fallback instead.
- Declined a request to add "MonoMax Sport TV" — every available stream URL traced back to unauthorized piracy-aggregator redistribution of a paid subscription service. Do not revisit this without a legitimate source (see AGENTS.md § Content policy).

## In progress

_Nothing in progress._

## Next up / open threads

- Confirm with the project owner that 3HD now plays correctly on the real hotel network/player.
- If `workers/ch3-proxy` ever breaks: `ch3plus.com/live`'s HTML probably changed and no longer contains `streamUrlWebAVOD"` — check the page source and update the regex in `workers/ch3-proxy/worker.js`.
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
