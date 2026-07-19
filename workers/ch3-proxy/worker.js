// Auto-refreshing proxy for CH3 Plus's official free live stream (ch3plus.com).
//
// ch3plus.com/live server-renders a fresh time-limited signed URL
// (x_ark_access_id / x_ark_expires / x_ark_signature, ~12h validity) into the
// page HTML on every request (field `streamUrlWebAVOD`). There is no public
// token-issuing API to call directly, so this worker re-fetches that HTML
// page periodically, extracts the signed query string, caches it in KV, and
// uses it to proxy the actual HLS manifest/segments — rewriting manifest
// URIs to keep routing back through this worker so the cached token never
// needs to be exposed to the player.

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

// Isolate-local cache: avoids a KV round-trip on every segment request for
// warm invocations (KV reads are fast but not free, and every ~8s segment
// hitting KV adds up when the player is fetching several ahead at once).
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

function isManifest(pathname) {
  return pathname.endsWith(".m3u8");
}

// Rewrite relative URIs inside an m3u8 body so segment/variant requests
// keep routing through this worker (stripping any embedded signed query —
// we re-attach a fresh one server-side on each proxied fetch).
//
// For the master playlist specifically, also reorders variants from
// highest to lowest BANDWIDTH. The app's hls.js is configured with
// `startLevel: 0, testBandwidth: false` (see index.html) — it always
// starts on whichever variant is listed first, with no bandwidth probe.
// Upstream lists CH3's variants lowest-first (144p first), which made
// every viewer start on a blurry 144p stream. Other channels' playlists
// already happen to list highest-first, so this keeps CH3 consistent
// with how the app expects `startLevel: 0` to behave.
function rewriteManifest(body) {
  const lines = body.split("\n");
  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));

  if (isMaster) {
    const header = [];
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const uri = (lines[i + 1] || "").trim().split("?")[0];
        const bwMatch = line.match(/BANDWIDTH=(\d+)/);
        const bandwidth = bwMatch ? Number(bwMatch[1]) : 0;
        variants.push({ infoLine: line, uri, bandwidth });
        i++; // skip the URI line, already captured
      } else if (line.trim() !== "") {
        header.push(line);
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const out = [...header];
    for (const v of variants) out.push(v.infoLine, v.uri);
    return out.join("\n");
  }

  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      return trimmed.split("?")[0];
    })
    .join("\n");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "Steam Hotel CH3 auto-refresh proxy. Use /live/playlist.m3u8",
        { headers: CORS_HEADERS }
      );
    }

    try {
      const query = await getSignedQuery(env);
      const upstreamUrl = `${UPSTREAM_ORIGIN}${url.pathname}?${query}`;
      const upstreamRes = await fetch(upstreamUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SteamHotelCH3Proxy/1.0)" },
      });

      if (!upstreamRes.ok) {
        return new Response(
          `Upstream error ${upstreamRes.status} for ${url.pathname}`,
          { status: upstreamRes.status, headers: CORS_HEADERS }
        );
      }

      if (isManifest(url.pathname)) {
        const body = await upstreamRes.text();
        return new Response(rewriteManifest(body), {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-store",
          },
        });
      }

      // Segment (.ts) or anything else: stream through as-is.
      const headers = new Headers(upstreamRes.headers);
      for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers,
      });
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }
  },
};
