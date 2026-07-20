// Auto-refreshing redirect for CH3 Plus's official free live stream (ch3plus.com).
//
// ch3plus.com/live server-renders a fresh time-limited signed URL
// (x_ark_access_id / x_ark_expires / x_ark_signature, ~12h validity) into the
// page HTML on every request (field `streamUrlWebAVOD`). There is no public
// token-issuing API to call directly, so this worker re-fetches that HTML
// page periodically, extracts the signed query string, caches it in KV, and
// 302-redirects the player straight to the real byteark URL with a fresh
// token attached.
//
// This used to proxy the manifest/segments through the worker itself, but
// byteark's CDN started returning 451 (geo-blocked) to Cloudflare Workers'
// egress IPs (they don't originate from Thailand, no matter which Cloudflare
// colo runs the Worker — Cloudflare has no compute PoP inside Thailand).
// ch3plus.com/live itself is NOT geo-blocked from Cloudflare, only the
// byteark video CDN is, so token refresh still works fine from here.
// Redirecting means the actual video traffic leaves from the player's own
// (Thailand-based, hotel network) IP instead of ours, which passes the
// geo-check. The manifest byteark returns already embeds a valid signed
// query on every segment URI, so no manifest rewriting is needed either.

const UPSTREAM_ORIGIN = "https://ch3-33-web.cdn.byteark.com";
const TOKEN_SOURCE_PAGE = "https://ch3plus.com/live";
const KV_KEY = "ch3_signed_query";
// Real token lives ~43200s (12h); refresh well before that to stay safe.
const REFRESH_MARGIN_SECONDS = 30 * 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Isolate-local cache: avoids a KV round-trip on every request for warm
// invocations (KV reads are fast but not free).
let memCache = null;

async function getSignedQuery(env) {
  const now = Date.now();
  if (memCache && memCache.expiresAt > now) {
    return memCache.query;
  }
  const cached = await env.CH3_TOKEN_CACHE.get(KV_KEY, "json");
  if (cached && cached.expiresAt > now) {
    memCache = cached;
    return cached.query;
  }
  return refreshSignedQuery(env);
}

async function refreshSignedQuery(env) {
  const res = await fetch(TOKEN_SOURCE_PAGE, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SteamHotelCH3Proxy/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`Failed to load ${TOKEN_SOURCE_PAGE}: HTTP ${res.status}`);
  }
  const html = await res.text();
  const match = html.match(/streamUrlWebAVOD":"([^"]+)"/);
  if (!match) {
    throw new Error("Could not find streamUrlWebAVOD in ch3plus.com/live HTML");
  }
  const fullUrl = match[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  const query = fullUrl.split("?")[1];
  if (!query) {
    throw new Error("Signed URL had no query string");
  }
  const params = new URLSearchParams(query);
  const expires = Number(params.get("x_ark_expires")); // unix seconds
  const expiresAt = expires
    ? (expires - REFRESH_MARGIN_SECONDS) * 1000
    : Date.now() + 10 * 60 * 1000; // fallback: 10 min if we can't parse

  memCache = { query, expiresAt };
  await env.CH3_TOKEN_CACHE.put(
    KV_KEY,
    JSON.stringify({ query, expiresAt }),
    { expirationTtl: Math.max(60, Math.floor((expiresAt - Date.now()) / 1000)) }
  );

  return query;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "Steam Hotel CH3 auto-refresh redirect. Use /live/playlist_720p/index.m3u8",
        { headers: CORS_HEADERS }
      );
    }

    try {
      const query = await getSignedQuery(env);
      const upstreamUrl = `${UPSTREAM_ORIGIN}${url.pathname}?${query}`;
      return new Response(null, {
        status: 302,
        headers: {
          ...CORS_HEADERS,
          Location: upstreamUrl,
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
