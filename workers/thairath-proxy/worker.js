// Thairath TV 32 (ไทยรัฐทีวี 32) — hotlink shim.
//
// Thairath streams its own free-to-air channel publicly from
// ssai-streaming.thairath.co.th, but the origin checks `Referer` and answers
// 403 to anything that didn't come from thairath.co.th. The hotel's TV doesn't
// send a Referer, so the channel is unplayable without a shim — same class of
// problem as ../ch3-proxy (signed token) and ../pptv-proxy (signed URL).
//
// Unlike every other proxy in this repo, this one has to carry the *segments*
// too: the Referer check applies to the .ts files as well, not just the
// manifest (verified 2026-09-21 — a segment without the header is 403, with it
// is 200). So the video bandwidth does pass through this Worker, which the
// owner agreed to after seeing the numbers: roughly 600 requests per viewer-
// hour against the 100k/day free ceiling, and this channel is only on air for
// the Asian Games blocks that name Thairath.
//
// Segments stream straight through (`res.body`) rather than being buffered, so
// a 700KB chunk costs almost no Worker CPU.

const ORIGIN = "https://ssai-streaming.thairath.co.th/bamm-csai";
const REFERER = "https://www.thairath.co.th/";

// 720p to match the other Thai channels in this playlist, which are all pinned
// to a single quality rather than left to ABR.
const QUALITY = "720p";

// Only these paths are ever fetched upstream — this must not become an open
// relay just because someone found the Worker's URL.
const SEGMENT_PATH = /^\/s\/(360p|480p|720p)\/([A-Za-z0-9._-]+\.ts)$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function upstream(path) {
  return fetch(`${ORIGIN}/${path}`, {
    headers: {
      Referer: REFERER,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    redirect: "follow",
  });
}

// How many of the newest segments to publish (2 s each, so ~60 s).
// Since 2026-11 the origin is an SSAI feed that lists 600 segments (~20 min,
// ~92 KB) and marks ad breaks with SCTE-35 `#EXT-X-DATERANGE` tags. The
// hotel's Samsung TV stopped playing the channel (owner report 2026-11-18)
// while ffmpeg still played it, so the playlist is reduced to what every
// other channel looks like: a short live window with no ad-marker tags.
const KEEP_SEGMENTS = 30;

// Tags that only carry ad-break metadata; dropping them changes nothing a
// player needs to decode the stream.
const AD_TAG = /^#EXT-X-(DATERANGE|CUE-OUT|CUE-OUT-CONT|CUE-IN|SCTE35|SPLICEPOINT|ASSET)\b|^#EXT-OATCLS-SCTE35/;

// Header tags that describe the whole playlist rather than one segment.
const HEADER_TAG = /^#(EXTM3U|EXT-X-VERSION|EXT-X-TARGETDURATION|EXT-X-MEDIA-SEQUENCE|EXT-X-DISCONTINUITY-SEQUENCE|EXT-X-PLAYLIST-TYPE|EXT-X-INDEPENDENT-SEGMENTS|EXT-X-ALLOW-CACHE)\b/;

function tidyPlaylist(body, segmentUrl) {
  const header = [];
  const groups = []; // each: { tags: [], uri }
  let pending = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      if (AD_TAG.test(line)) continue;
      if (HEADER_TAG.test(line)) header.push(line);
      else pending.push(line);
      continue;
    }
    // Segment references are bare filenames; point them back at this
    // Worker so they carry the Referer too.
    groups.push({ tags: pending, uri: segmentUrl(line.split("/").pop()) });
    pending = [];
  }

  const drop = Math.max(0, groups.length - KEEP_SEGMENTS);
  const dropped = groups.slice(0, drop);
  const kept = groups.slice(drop);
  const droppedDisc = dropped.filter((g) =>
    g.tags.includes("#EXT-X-DISCONTINUITY")
  ).length;

  const out = header.map((h) => {
    let m = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(h);
    if (m) return `#EXT-X-MEDIA-SEQUENCE:${Number(m[1]) + drop}`;
    m = /^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(h);
    if (m) return `#EXT-X-DISCONTINUITY-SEQUENCE:${Number(m[1]) + droppedDisc}`;
    return h;
  });
  for (const g of kept) out.push(...g.tags, g.uri);
  out.push(...pending); // e.g. #EXT-X-ENDLIST, if it ever appears
  return out.join("\n") + "\n";
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        `Steam Hotel Thairath TV 32 shim. Use /live/playlist_${QUALITY}.m3u8`,
        { headers: CORS_HEADERS }
      );
    }

    if (url.pathname === `/live/playlist_${QUALITY}.m3u8`) {
      try {
        const res = await upstream(`${QUALITY}/index.m3u8`);
        if (!res.ok) {
          return new Response(`Upstream ${res.status}`, {
            status: 502,
            headers: CORS_HEADERS,
          });
        }
        const body = await res.text();
        const rewritten = tidyPlaylist(body, (name) =>
          `${url.origin}/s/${QUALITY}/${name}`
        );
        return new Response(rewritten, {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/vnd.apple.mpegurl",
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

    const seg = SEGMENT_PATH.exec(url.pathname);
    if (seg) {
      try {
        const res = await upstream(`${seg[1]}/${seg[2]}`);
        if (!res.ok) {
          return new Response(`Upstream ${res.status}`, {
            status: 502,
            headers: CORS_HEADERS,
          });
        }
        return new Response(res.body, {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "video/mp2t",
            // Segments are immutable once published; letting Cloudflare hold
            // them briefly means several TVs on the same channel don't each
            // pull the same chunk from Thairath.
            "Cache-Control": "public, max-age=60",
          },
        });
      } catch (err) {
        return new Response(`Proxy error: ${err.message}`, {
          status: 502,
          headers: CORS_HEADERS,
        });
      }
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
