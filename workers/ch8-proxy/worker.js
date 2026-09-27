// Auto-refreshing single-quality master for Channel 8 (thaich8.com).
//
// The /live page signs a byteark URL (`x_ark_*` query, ~3h validity) for its
// player, and exposes the same signer as JSON at /live/sign?var_link=720p.
// Same shape as pptv-proxy: fetch the signer, cache the token in KV, and hand
// the player a manifest with a fresh token attached. Only the manifest goes
// through this worker; chunklists and segments come straight from byteark
// to the TV's own Thai IP.
//
// Channel 8's 720p rendition is muxed (video+audio in one stream, verified
// with ffprobe) so no #EXT-X-MEDIA audio group is needed, unlike PPTV.
// A one-variant master pins the 720p rendition (their real master lists 240p
// first, which a player would pick).

const SIGN_URL = "https://www.thaich8.com/live/sign?var_link=720p";
const KV_KEY = "ch8_signed_url";
// Token validity is ~3h; refresh well before it lapses.
const REFRESH_MARGIN_SECONDS = 40 * 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

let memCache = null;

async function getSigned(env) {
  const now = Date.now();
  if (memCache && memCache.expiresAt > now) return memCache.value;
  const cached = await env.CH8_TOKEN_CACHE.get(KV_KEY, "json");
  if (cached && cached.expiresAt > now) {
    memCache = cached;
    return cached.value;
  }
  return refreshSigned(env);
}

async function refreshSigned(env) {
  const res = await fetch(SIGN_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; SteamHotelCh8Proxy/1.0)",
      Referer: "https://www.thaich8.com/live",
    },
  });
  if (!res.ok) throw new Error(`Failed to load ${SIGN_URL}: HTTP ${res.status}`);
  const j = await res.json();
  if (!j || !j.signedUrl) throw new Error("Channel 8 sign response had no signedUrl");

  const url = new URL(j.signedUrl);
  const query = url.search.replace(/^\?/, "");
  const expires = Number(j.expireTimestamp || url.searchParams.get("x_ark_expires"));
  if (!query || !expires) throw new Error("Signed Channel 8 URL did not parse");
  // Same host/prefix, always the 720p rendition (signature covers the path prefix).
  const base = `${url.origin}/fleetstream/live`;

  const expiresAt = (expires - REFRESH_MARGIN_SECONDS) * 1000;
  const value = { base, query };
  memCache = { value, expiresAt };
  await env.CH8_TOKEN_CACHE.put(KV_KEY, JSON.stringify({ value, expiresAt }), {
    expirationTtl: Math.max(60, Math.floor((expiresAt - Date.now()) / 1000)),
  });
  return value;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (url.pathname === "/" || url.pathname === "") {
      return new Response("Steam Hotel Channel 8 auto-refresh manifest. Use /live/playlist_720p.m3u8", { headers: CORS_HEADERS });
    }
    if (url.pathname !== "/live/playlist_720p.m3u8") {
      return new Response("Not found", { status: 404, headers: CORS_HEADERS });
    }
    try {
      const { base, query } = await getSigned(env);
      const body = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        '#EXT-X-STREAM-INF:BANDWIDTH=4400000,RESOLUTION=1280x720',
        `${base}/720p/index.m3u8?${query}`,
        "",
      ].join("\n");
      return new Response(body, {
        headers: { ...CORS_HEADERS, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" },
      });
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, { status: 502, headers: CORS_HEADERS });
    }
  },
};
