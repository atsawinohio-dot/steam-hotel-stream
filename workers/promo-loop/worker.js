// Endless loop channel for the hotel's own signage reel (ROYS PROMO, channel 21).
//
// The static file at promo/playlist.m3u8 on GitHub Pages is a VOD playlist: it
// repeats the 6 segments a fixed number of times and then hits
// #EXT-X-ENDLIST, so the channel eventually stops (24h as shipped). Static
// hosting can't do better on its own — a truly endless channel needs a
// playlist that is regenerated per request, which is what this worker does.
//
// On each request it emits a LIVE playlist (no EXT-X-ENDLIST) holding a small
// sliding window of segments, positioned by wall-clock time. Because the reel
// is exactly 24.000s of 4.000s segments, `floor(elapsed / 4) mod 6` maps any
// instant to the segment that "should" be airing, so the loop never ends and
// every TV in the hotel is showing the same frame at the same time — it
// behaves like a real broadcast channel rather than a per-viewer playback.
//
// Only this manifest passes through the worker. Segment URIs are absolute
// GitHub Pages URLs (which already send Access-Control-Allow-Origin: *), so
// video bandwidth goes player -> Pages directly and never touches Cloudflare —
// same split as workers/pluto-proxy/worker.js.

const SEGMENT_BASE = "https://atsawinohio-dot.github.io/steam-hotel-stream/promo";
const SEGMENT_COUNT = 6;
const SEGMENT_DURATION = 4; // seconds; every segment is exactly 4.000s
// Segments to list per response. 6 (= one full 24s pass) gives players a
// comfortable buffer while keeping the window short enough that a client
// joining late still lands near real time.
const WINDOW = 6;
// Fixed anchor so sequence numbers stay small and identical across isolates.
const EPOCH_SECONDS = Date.UTC(2026, 0, 1) / 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function buildPlaylist(nowSeconds) {
  const tick = Math.floor((nowSeconds - EPOCH_SECONDS) / SEGMENT_DURATION);
  const firstTick = Math.max(0, tick - (WINDOW - 1));

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${SEGMENT_DURATION}`,
    `#EXT-X-MEDIA-SEQUENCE:${firstTick}`,
    // Each pass restarts the segments' timestamps, so every wrap back to
    // segment_000 is a genuine discontinuity. Players need the running count
    // of discontinuities that scrolled off the top of the window, otherwise
    // they mis-order the timeline after a reconnect.
    `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.ceil(firstTick / SEGMENT_COUNT)}`,
  ];

  for (let i = firstTick; i <= tick; i++) {
    const index = i % SEGMENT_COUNT;
    if (index === 0 && i !== 0) {
      lines.push("#EXT-X-DISCONTINUITY");
    }
    lines.push(`#EXTINF:${SEGMENT_DURATION}.000000,`);
    lines.push(`${SEGMENT_BASE}/segment_${String(index).padStart(3, "0")}.ts`);
  }

  // No #EXT-X-ENDLIST: that tag is what tells the player the stream is over.
  lines.push("");
  return lines.join("\n");
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "Steam Hotel ROYS PROMO endless loop. Use /playlist.m3u8",
        { headers: CORS_HEADERS }
      );
    }

    if (url.pathname === "/playlist.m3u8") {
      return new Response(buildPlaylist(Date.now() / 1000), {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/vnd.apple.mpegurl",
          // The window moves every 4s; a cached manifest would stall the loop.
          "Cache-Control": "no-store",
        },
      });
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
