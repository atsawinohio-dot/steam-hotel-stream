// Auto-refreshing redirect for Amarin TV's official free live stream (amarintv.com).
//
// amarintv.com/live server-renders a fresh time-limited signed byteark URL
// (x_ark_access_id / x_ark_expires / x_ark_signature, ~24h validity) into a
// Next.js data payload embedded in the page HTML on every request. There is
// no separate public token-issuing API, so this worker re-fetches that HTML
// page periodically, extracts the signed query string, caches it in KV, and
// 302-redirects the player straight to the real byteark URL with a fresh
// token attached.
//
// Modeled directly on workers/ch3-proxy/worker.js (same byteark signed-URL
// pattern, same reasoning for redirecting instead of proxying: Cloudflare
// Workers' egress IPs aren't in Thailand, and Thai broadcasters' byteark
// buckets have been observed geo-blocking non-Thai IPs at the video-CDN
// layer even when the token-source page itself is not geo-blocked). If
// Amarin's byteark bucket turns out not to be geo-blocked, a redirect still
// works fine — it's strictly the more robust choice either way.

const UPSTREAM_ORIGIN = "https://amarin-ks7jcc.cdn.byteark.com";
const TOKEN_SOURCE_PAGE = "https://www.amarintv.com/live";
const KV_KEY = "amarin_signed_query";
// Observed token validity ~24h; refresh well before that to stay safe.
const REFRESH_MARGIN_SECONDS = 60 * 60;

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
  const cached = await env.AMARIN_TOKEN_CACHE.get(KV_KEY, "json");
  if (cached && cached.expiresAt > now) {
    memCache = cached;
    return cached.query;
  }
  return refreshSignedQuery(env);
}

async function refreshSignedQuery(env) {
  const res = await fetch(TOKEN_SOURCE_PAGE, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SteamHotelAmarinProxy/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`Failed to load ${TOKEN_SOURCE_PAGE}: HTTP ${res.status}`);
  }
  const html = await res.text();
  const match = html.match(/playlist\.m3u8\?([^"]+)"/);
  if (!match) {
    throw new Error("Could not find signed playlist.m3u8 query in amarintv.com/live HTML");
  }
  const query = match[1].replace(/\\u0026/g, "&").replace(/\\$/, "");
  const params = new URLSearchParams(query);
  const expires = Number(params.get("x_ark_expires")); // unix seconds
  const expiresAt = expires
    ? (expires - REFRESH_MARGIN_SECONDS) * 1000
    : Date.now() + 10 * 60 * 1000; // fallback: 10 min if we can't parse

  memCache = { query, expiresAt };
  await env.AMARIN_TOKEN_CACHE.put(
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
        "Steam Hotel Amarin TV auto-refresh redirect. Use /live/playlist_720p.m3u8",
        { headers: CORS_HEADERS }
      );
    }

    // Single-quality master playlist, synthesised here with a fresh token.
    //
    // Amarin's audio is DEMUXED: `1080p_index.m3u8` carries video only (verified
    // with ffprobe - h264 1920x1080, no audio), and the soundtrack lives in a
    // separate rendition that a player only discovers through the master
    // playlist's #EXT-X-MEDIA AUDIO group. Pointing the channel straight at
    // 1080p_index.m3u8 therefore played silently. (Route path stays
    // `/live/playlist_720p.m3u8` for URL stability even though it now serves
    // 1080p — 2026-07-29, owner asked for 1080p on every channel.)
    //
    // We can't just hand over Amarin's real master: it lists 1080p/6Mbps first,
    // and `startLevel: 0` in index.html would pin every viewer to it (see
    // HANDOFF - high bitrates against the app's 10s buffer caused stutter on
    // CH3, and multi-variant masters upset the owner's "M3U IPTV" Windows app).
    // So we emit a master with exactly one video variant plus the Thai audio
    // rendition: audio restored, still effectively single-quality.
    //
    // Both URIs point straight at byteark rather than back through this worker,
    // so the video traffic still leaves from the player's own Thailand IP -
    // the whole reason this worker redirects instead of proxying. The worker
    // never fetches byteark itself, so byteark's block on Cloudflare egress
    // IPs (the 451 that broke CH3) can't affect this path either.
    if (url.pathname === "/live/playlist_720p.m3u8") {
      try {
        const query = await getSignedQuery(env);
        const body = [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud_high",NAME="Thai",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="THA",' +
            `URI="${UPSTREAM_ORIGIN}/live/Thai_HD_index.m3u8?${query}"`,
          '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x1080,AUDIO="group_aud_high"',
          `${UPSTREAM_ORIGIN}/live/1080p_index.m3u8?${query}`,
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
