// Auto-refreshing single-quality masters for True4U (ch 24) and TNN16 (ch 16).
//
// Both stations run the same setup: a byteark-hosted live stream plus a signer
// endpoint on their own site that hands the player a URL with an `x_ark_*`
// query (~6h validity). That is the Channel 8 shape, so this worker is
// ch8-proxy generalised over two channels - one Worker, one KV namespace and
// one status-page binding instead of two of each.
//
// Only the master goes through this Worker. It points at byteark directly, so
// chunklists and segments are fetched by the TV from its own Thai IP and cost
// no Worker quota.
//
// Why a synthesised master rather than passing theirs through:
//   1. Their master lists 240p first, and a player that takes the first
//      variant would pin every guest to 240p.
//   2. Their master writes RESOLUTION="1280x720" - quoted, which the HLS spec
//      does not allow - and a strict TV parser may reject the whole manifest.
//   3. Pinning 720p keeps these consistent with CH3/Amarin/Channel 8.
//
// Both 720p renditions are muxed (h264 + aac in one stream, verified with
// ffprobe) and unencrypted, which is what the hotel's Samsung TVs can play:
// PPTV was dropped on 2026-09-28 precisely because it combined AES-128 with a
// demuxed audio rendition, and GMM25 because it was fMP4. Keep any future
// channel on this worker to plain, muxed, unencrypted TS.

const CHANNELS = {
  true4u: {
    mode: "signer",
    signUrl: "https://www.true4u.com/live-api/signer-url?prefix=/live/",
    referer: "https://www.true4u.com/live/",
    bandwidth: 3500000,
    kvKey: "true4u_signed_url",
  },
  tnn16: {
    mode: "signer",
    signUrl: "https://www.tnnthailand.com/content-api/signer-url?prefix=/live",
    referer: "https://www.tnnthailand.com/live",
    bandwidth: 3500000,
    kvKey: "tnn16_signed_url",
  },
  // NBT World has no token - its master is public - but it is a Wowza origin
  // that mints a new session id per request (chunklist_w<digits>_b<rate>.m3u8,
  // the shape that broke MCOT on 2026-09-25) and advertises five renditions
  // from 1080p down to 240p. Served raw it stuttered on the hotel TVs on
  // 2026-09-28, most likely from the player hopping between those renditions.
  // So: resolve a fresh session on every master request (never cache it) and
  // hand back one pinned rendition, exactly what mcot-proxy does.
  nbtworld: {
    mode: "master",
    masterUrl: "https://cdn-edge.iiptvcdn.com/live_event/smil:d36f-93c1-9c58-fdcc-427f.smil/playlist.m3u8",
    pinBandwidth: 2128000, // the 1280x720 rung
    bandwidth: 2128000,
  },
};

// Tokens last ~6h; refresh well before they lapse.
const REFRESH_MARGIN_SECONDS = 45 * 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Isolate-local cache, keyed by channel: avoids a KV read on every warm request.
const memCache = new Map();

async function getSigned(env, id) {
  const now = Date.now();
  const mem = memCache.get(id);
  if (mem && mem.expiresAt > now) return mem.value;
  const cached = await env.THAI_TOKEN_CACHE.get(CHANNELS[id].kvKey, "json");
  if (cached && cached.expiresAt > now) {
    memCache.set(id, cached);
    return cached.value;
  }
  return refreshSigned(env, id);
}

async function refreshSigned(env, id) {
  const cfg = CHANNELS[id];
  const res = await fetch(cfg.signUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; SteamHotelThaiLiveProxy/1.0)",
      Referer: cfg.referer,
    },
  });
  if (!res.ok) throw new Error(`Failed to load signer for ${id}: HTTP ${res.status}`);
  const signed = (await res.text()).trim();
  if (!signed.startsWith("https://") || !signed.includes("/playlist.m3u8?")) {
    throw new Error(`Signer for ${id} did not return a playlist URL`);
  }

  const url = new URL(signed);
  const query = url.search.replace(/^\?/, "");
  const base = signed.slice(0, signed.indexOf("/playlist.m3u8"));
  const expires = Number(url.searchParams.get("x_ark_expires"));
  if (!query || !base || !expires) throw new Error(`Signed ${id} URL did not parse`);

  const expiresAt = (expires - REFRESH_MARGIN_SECONDS) * 1000;
  const value = { base, query };
  memCache.set(id, { value, expiresAt });
  await env.THAI_TOKEN_CACHE.put(cfg.kvKey, JSON.stringify({ value, expiresAt }), {
    expirationTtl: Math.max(60, Math.floor((expiresAt - Date.now()) / 1000)),
  });
  return value;
}

async function pinnedMaster(id) {
  const cfg = CHANNELS[id];
  const res = await fetch(cfg.masterUrl, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SteamHotelThaiLiveProxy/1.0)" },
  });
  if (!res.ok) throw new Error(`Failed to load master for ${id}: HTTP ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/);

  let variant = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const bw = Number((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1]);
    if (bw === cfg.pinBandwidth) {
      variant = lines[i + 1].trim();
      break;
    }
  }
  if (!variant) throw new Error(`Master for ${id} no longer offers BANDWIDTH=${cfg.pinBandwidth}`);

  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-STREAM-INF:BANDWIDTH=${cfg.bandwidth},RESOLUTION=1280x720`,
    new URL(variant, res.url).toString(),
    "",
  ].join("\n");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    if (url.pathname === "/" || url.pathname === "") {
      const routes = Object.keys(CHANNELS).map((id) => `/${id}/playlist_720p.m3u8`);
      return new Response(`Steam Hotel Thai live auto-refresh manifests. Use ${routes.join(" or ")}`, {
        headers: CORS_HEADERS,
      });
    }

    const match = url.pathname.match(/^\/([a-z0-9]+)\/playlist_720p\.m3u8$/);
    const id = match && CHANNELS[match[1]] ? match[1] : null;
    if (!id) return new Response("Not found", { status: 404, headers: CORS_HEADERS });

    try {
      if (CHANNELS[id].mode === "master") {
        return new Response(await pinnedMaster(id), {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/vnd.apple.mpegurl",
            // The session id is minted per request; never hand back a stale one.
            "Cache-Control": "no-store",
          },
        });
      }
      const { base, query } = await getSigned(env, id);
      const body = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        `#EXT-X-STREAM-INF:BANDWIDTH=${CHANNELS[id].bandwidth},RESOLUTION=1280x720`,
        `${base}/pl_720p/index.m3u8?${query}`,
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
      return new Response(`Proxy error: ${err.message}`, { status: 502, headers: CORS_HEADERS });
    }
  },
};
