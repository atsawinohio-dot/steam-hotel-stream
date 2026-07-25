// Auto-refreshing single-quality master for PPTV HD 36's official free live
// stream (pptvhd36.com).
//
// PPTV embeds its player in an iframe at
// `www-live.pptvhd36.com/api/live_player/program/1`, and that page carries a
// freshly signed byteark URL (`x_ark_*` query, observed ~6h validity) in the
// player config. Same signed-URL family as CH3 and Amarin, so this worker
// follows the same shape: scrape the page periodically, cache the token in KV,
// and hand the player a manifest with a fresh token attached.
//
// Why a synthesised master rather than a redirect to PPTV's own:
//   1. PPTV's audio is DEMUXED - `720p/index.m3u8` is video-only (verified with
//      ffprobe: one h264 stream, no audio), with the soundtrack in a separate
//      `audio-hi/th/index.m3u8` rendition that a player only finds through the
//      master's #EXT-X-MEDIA AUDIO group. Pinning straight at the video
//      rendition, the way CH3 is pinned, would play silently - exactly the bug
//      Amarin had.
//   2. PPTV's real master lists 1080p first and declares nonsense BANDWIDTH
//      values (1080p tagged at 500kbps, 144p at 50kbps), so hls.js ABR has no
//      usable signal and `startLevel: 0` in index.html would pin every viewer
//      to 1080p. Emitting one 720p variant plus the Thai audio track keeps the
//      channel single-quality and consistent with CH3/Amarin/Thai PBS.
//
// The worker only ever fetches pptvhd36.com, never byteark - so byteark's block
// on Cloudflare egress IPs (the 451 that broke CH3) can't affect this path, and
// segment traffic still leaves from the player's own Thai IP.

const TOKEN_SOURCE_PAGE = "https://www-live.pptvhd36.com/api/live_player/program/1";
const KV_KEY = "pptv_signed_url";
// Observed token validity ~6h; refresh well before it lapses.
const REFRESH_MARGIN_SECONDS = 45 * 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Isolate-local cache: avoids a KV round-trip on every warm request.
let memCache = null;

async function getSigned(env) {
  const now = Date.now();
  if (memCache && memCache.expiresAt > now) return memCache.value;
  const cached = await env.PPTV_TOKEN_CACHE.get(KV_KEY, "json");
  if (cached && cached.expiresAt > now) {
    memCache = cached;
    return cached.value;
  }
  return refreshSigned(env);
}

async function refreshSigned(env) {
  const res = await fetch(TOKEN_SOURCE_PAGE, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; SteamHotelPPTVProxy/1.0)",
      Referer: "https://www.pptvhd36.com/live",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to load ${TOKEN_SOURCE_PAGE}: HTTP ${res.status}`);
  }
  const html = await res.text();
  // Capture the whole URL, not just the query, so a CDN hostname change on
  // PPTV's side doesn't silently break this.
  const match = html.match(/https:\/\/[^'"\s]+\/playlist\.m3u8\?[^'"\s]+/);
  if (!match) {
    throw new Error("Could not find a signed playlist.m3u8 URL in the PPTV player page");
  }
  const full = match[0].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  const [urlPart, query] = full.split("?");
  const base = urlPart.replace(/\/playlist\.m3u8$/, "");
  if (!query || !base) throw new Error("Signed PPTV URL did not parse");

  const expires = Number(new URLSearchParams(query).get("x_ark_expires")); // unix seconds
  const expiresAt = expires
    ? (expires - REFRESH_MARGIN_SECONDS) * 1000
    : Date.now() + 10 * 60 * 1000; // fallback: 10 min if unparseable

  const value = { base, query };
  memCache = { value, expiresAt };
  await env.PPTV_TOKEN_CACHE.put(
    KV_KEY,
    JSON.stringify({ value, expiresAt }),
    { expirationTtl: Math.max(60, Math.floor((expiresAt - Date.now()) / 1000)) }
  );
  return value;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "Steam Hotel PPTV HD 36 auto-refresh manifest. Use /live/playlist_720p.m3u8",
        { headers: CORS_HEADERS }
      );
    }

    if (url.pathname !== "/live/playlist_720p.m3u8") {
      return new Response("Not found", { status: 404, headers: CORS_HEADERS });
    }

    try {
      const { base, query } = await getSigned(env);
      const body = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-hi",NAME="Thai",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="THA",' +
          `URI="${base}/audio-hi/th/index.m3u8?${query}"`,
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="audio-hi"',
        `${base}/720p/index.m3u8?${query}`,
        "",
      ].join("\n");
      return new Response(body, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/vnd.apple.mpegurl",
          // The embedded token expires, so this must never be cached past it.
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }
  },
};
