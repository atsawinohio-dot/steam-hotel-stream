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
// Cap CH3 at 480p: the app's hls.js starts on whichever variant is listed
// first with no bandwidth probe (startLevel:0, testBandwidth:false) and
// only a 10s buffer, so 720p (3.5Mbps) left too little margin for the
// hotel's real-world network and caused audio stutter. Dropping 720p from
// the master entirely (not just reordering) also stops ABR from climbing
// back up to it mid-playback.
const MAX_BANDWIDTH = 1_500_000; // 480p
// How long a fetched segment stays warm in the edge cache. Segments are
// ~6-9s each; this just needs to outlive the gap between us prefetching it
// (as soon as it appears in a manifest) and the player actually asking.
const SEGMENT_CACHE_SECONDS = 30;

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
// highest to lowest BANDWIDTH (and drops anything above MAX_BANDWIDTH).
// The app's hls.js is configured with `startLevel: 0, testBandwidth: false`
// (see index.html) — it always starts on whichever variant is listed
// first, with no bandwidth probe. Upstream lists CH3's variants
// lowest-first (144p first), which made every viewer start on a blurry
// 144p stream.
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
        if (bandwidth <= MAX_BANDWIDTH) {
          variants.push({ infoLine: line, uri, bandwidth });
        }
        i++; // skip the URI line, already captured
      } else if (line.trim() !== "") {
        header.push(line);
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const out = [...header];
    for (const v of variants) out.push(v.infoLine, v.uri);
    return { rewritten: out.join("\n"), segmentPaths: [] };
  }

  const segmentPaths = [];
  const rewritten = lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const clean = trimmed.split("?")[0];
      if (clean.endsWith(".ts")) segmentPaths.push(clean);
      return clean;
    })
    .join("\n");

  return { rewritten, segmentPaths };
}

async function fetchFromOrigin(pathname, query) {
  const upstreamUrl = `${UPSTREAM_ORIGIN}${pathname}?${query}`;
  return fetch(upstreamUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SteamHotelCH3Proxy/1.0)" },
  });
}

function buildSegmentResponse(upstreamRes) {
  const headers = new Headers(upstreamRes.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  headers.set("Cache-Control", `public, max-age=${SEGMENT_CACHE_SECONDS}`);
  return new Response(upstreamRes.body, { status: upstreamRes.status, headers });
}

// Warms the edge cache for a segment that just appeared in a manifest, well
// before the player actually gets around to requesting it (it's still
// playing through earlier segments). Runs in the background via
// ctx.waitUntil and never throws.
async function prefetchSegment(basePathname, segmentFile, origin, query, cache, ctx) {
  try {
    const dir = basePathname.slice(0, basePathname.lastIndexOf("/") + 1);
    const reqUrl = `${origin}${dir}${segmentFile}`;
    const cacheKey = new Request(reqUrl);
    if (await cache.match(cacheKey)) return;
    const upstreamRes = await fetchFromOrigin(`${dir}${segmentFile}`, query);
    if (!upstreamRes.ok) return;
    const response = buildSegmentResponse(upstreamRes);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  } catch (_err) {
    // Best-effort only — the player will just fetch it directly if this fails.
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cache = caches.default;

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
      if (!isManifest(url.pathname)) {
        // Segment request: serve from edge cache if a prefetch already warmed it.
        const cached = await cache.match(request);
        if (cached) return cached;
      }

      const query = await getSignedQuery(env);
      const upstreamRes = await fetchFromOrigin(url.pathname, query);

      if (!upstreamRes.ok) {
        return new Response(
          `Upstream error ${upstreamRes.status} for ${url.pathname}`,
          { status: upstreamRes.status, headers: CORS_HEADERS }
        );
      }

      if (isManifest(url.pathname)) {
        const body = await upstreamRes.text();
        const { rewritten, segmentPaths } = rewriteManifest(body);

        for (const segFile of segmentPaths) {
          ctx.waitUntil(
            prefetchSegment(url.pathname, segFile, url.origin, query, cache, ctx)
          );
        }

        return new Response(rewritten, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-store",
          },
        });
      }

      // Segment (.ts) or anything else: stream through as-is, and warm the
      // cache for this exact request in case of a retry.
      const response = buildSegmentResponse(upstreamRes);
      ctx.waitUntil(cache.put(request, response.clone()));
      return response;
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }
  },
};
