// CORS shim for Pluto TV channels.
//
// Why this exists: Pluto's stitcher answers with
//   access-control-allow-origin: http://pluto.tv
// i.e. a specific foreign origin rather than `*`, so a browser refuses every
// response and hls.js can never even read the master playlist. Native players
// (the owner's "M3U IPTV" app, VLC) don't enforce CORS, which is why these
// channels look fine there and fail only in the web app.
//
// The repo's generic `steam-hotel-iptv-proxy` can't do this job: the playlist
// entries point at jmp2.uk, which 302s to the stitcher, and that proxy resolves
// the manifest's relative URIs against the URL it was *given* rather than the
// URL it *ended up at* — so it rewrites `1539795/playlist.m3u8` to
// `jmp2.uk/1539795/playlist.m3u8`, which 404s. This worker resolves against the
// post-redirect URL instead.
//
// Only the manifests go through here. Pluto serves the actual video segments
// from *.plutotv.net with `access-control-allow-origin: *` already, and the
// media playlists reference them as absolute URLs, so segments are fetched by
// the player directly and none of the video bandwidth touches this worker.

const RESOLVER = "https://jmp2.uk/plu-"; // hands back a stitcher URL with a fresh authToken
// Only ever proxy Pluto's own hosts — this must not become an open relay.
const ALLOWED_HOST = /(^|\.)(pluto\.tv|plutotv\.net)$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const M3U8_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "application/vnd.apple.mpegurl",
  // Manifests carry a time-limited authToken and a live segment window.
  "Cache-Control": "no-store",
};

function isAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.protocol === "https:" && ALLOWED_HOST.test(u.hostname);
  } catch (e) {
    return false;
  }
}

function selfUrl(request, absolute) {
  const base = new URL(request.url);
  return `${base.origin}/m?u=${encodeURIComponent(absolute)}`;
}

// Rewrites every playlist reference so sub-playlists come back through here,
// resolving relative paths against `baseUrl` (the URL the body actually came
// from, after redirects). Segment URLs are left alone: they're absolute
// *.plutotv.net links that already allow cross-origin reads.
function rewriteManifest(body, baseUrl, request) {
  const mapRef = (ref) => {
    let abs;
    try {
      abs = new URL(ref, baseUrl).toString();
    } catch (e) {
      return ref;
    }
    // Only playlists need the CORS shim; .ts/.mp4 segments are already fine.
    if (!/\.m3u8(\?|$)/.test(abs)) return ref;
    if (!isAllowed(abs)) return ref;
    return selfUrl(request, abs);
  };

  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      // Tag attributes such as #EXT-X-MEDIA:...,URI="..."
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (m, ref) => `URI="${mapRef(ref)}"`);
      }
      // Bare variant / segment reference on its own line
      return mapRef(trimmed);
    })
    .join("\n");
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "Steam Hotel Pluto TV CORS shim. Use /<channelId>.m3u8",
        { headers: CORS_HEADERS }
      );
    }

    try {
      // /m?u=<absolute pluto playlist>  — a sub-playlist we rewrote earlier.
      if (url.pathname === "/m") {
        const target = url.searchParams.get("u");
        if (!target || !isAllowed(target)) {
          return new Response("Refusing to proxy a non-Pluto URL", {
            status: 400,
            headers: CORS_HEADERS,
          });
        }
        const res = await fetch(target, { redirect: "follow" });
        if (!res.ok) {
          return new Response(`Upstream ${res.status}`, {
            status: 502,
            headers: CORS_HEADERS,
          });
        }
        const body = await res.text();
        return new Response(rewriteManifest(body, res.url || target, request), {
          headers: M3U8_HEADERS,
        });
      }

      // /<channelId>.m3u8 — the channel entry point.
      const match = url.pathname.match(/^\/([A-Za-z0-9]+)\.m3u8$/);
      if (!match) {
        return new Response("Not found", { status: 404, headers: CORS_HEADERS });
      }

      // Resolve through jmp2.uk so we get a stitcher URL with a fresh authToken
      // rather than hardcoding one that expires.
      const res = await fetch(`${RESOLVER}${match[1]}.m3u8`, { redirect: "follow" });
      if (!res.ok) {
        return new Response(`Upstream ${res.status}`, {
          status: 502,
          headers: CORS_HEADERS,
        });
      }
      const body = await res.text();
      // res.url is the post-redirect stitcher URL — resolving against the
      // original jmp2.uk address is exactly the bug this worker exists to avoid.
      return new Response(rewriteManifest(body, res.url, request), {
        headers: M3U8_HEADERS,
      });
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }
  },
};
