// steam-hotel-asiangames: channel 21 "Asian Games 2026" — points at whichever
// Thai broadcaster is currently airing Thai national-team coverage.
//
// There is no single channel that airs every event. Thailand's coverage
// rotates across 7 free digital channels (NBT, T Sports 7, MCOT HD, ONE 31,
// MONOMAX SPORTS TV, ไทยรัฐทีวี 32, PPTV HD 36), assigned per match and
// sometimes changed at the last minute "to follow the Thai team's most
// interesting matchup" (PPTV's own schedule page says as much). No public API
// exposes that decision, so a scheduled task (same pattern as this repo's
// other bots — see channel-health.log / ch3-guard.log) checks the day's
// schedule periodically and calls POST /set to point this worker at whichever
// real stream is currently the right one. Outside Asian Games hours this
// just keeps replaying whatever that broadcaster's regular channel shows —
// there's no dedicated 24/7 feed to fall back to.
//
// Games run 2026-09-10 to 2026-10-04. This channel is temporary — remove its
// entry from iptv.m3u8 and this worker after the games end.
//
// KV holds the current pick as a plain HTTPS URL plus a label for /status.
// The only way to change it is POST /set with the SET_TOKEN secret, so the
// pick can't be hijacked by anyone who finds this worker's URL.

const KV_KEY = "current_target";
const LABEL_KEY = "current_label";
const UPDATED_KEY = "updated_at";

// Same "official broadcaster" PPTV proxy this repo already runs — see
// ../pptv-proxy/worker.js. Used until the first /set call ever lands, and
// again if KV comes back empty for any reason.
const DEFAULT_TARGET =
  "https://steam-hotel-pptv-proxy.tiny-hall-8718.workers.dev/live/playlist_720p.m3u8";
const DEFAULT_LABEL = "PPTV HD 36 (default - official Asian Games broadcaster)";

// Reached over the PPTV_PROXY service binding rather than a plain fetch —
// see the note in wrangler.toml.
const PPTV_PROXY_HOST = "steam-hotel-pptv-proxy.tiny-hall-8718.workers.dev";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, POST",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "Steam Hotel Asian Games 2026 channel picker. Use /live.m3u8, /status, or POST /set",
        { headers: CORS_HEADERS }
      );
    }

    if (url.pathname === "/status") {
      const [target, label, updatedAt] = await Promise.all([
        env.ASIANGAMES_STATE.get(KV_KEY),
        env.ASIANGAMES_STATE.get(LABEL_KEY),
        env.ASIANGAMES_STATE.get(UPDATED_KEY),
      ]);
      return Response.json(
        {
          target: target || DEFAULT_TARGET,
          label: label || DEFAULT_LABEL,
          updatedAt: updatedAt ? Number(updatedAt) : null,
          ageSeconds: updatedAt
            ? Math.round((Date.now() - Number(updatedAt)) / 1000)
            : null,
        },
        { headers: CORS_HEADERS }
      );
    }

    if (url.pathname === "/set" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${env.SET_TOKEN}`) {
        return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response("Bad JSON body", { status: 400, headers: CORS_HEADERS });
      }
      if (!body.url || typeof body.url !== "string" || !/^https:\/\//.test(body.url)) {
        return new Response("Body must include an https `url`", {
          status: 400,
          headers: CORS_HEADERS,
        });
      }
      await env.ASIANGAMES_STATE.put(KV_KEY, body.url);
      await env.ASIANGAMES_STATE.put(LABEL_KEY, body.label || "");
      await env.ASIANGAMES_STATE.put(UPDATED_KEY, String(Date.now()));
      return Response.json(
        { ok: true, target: body.url, label: body.label || "" },
        { headers: CORS_HEADERS }
      );
    }

    // Serves the manifest body rather than 302-ing to it. The hotel's Samsung
    // TV failed with PLAYER_ERROR_CONNECTION_FAILED on the redirect form
    // (2026-09-21), and the channels that do work on that TV are all plain
    // manifest URLs, so the redirect is the one thing this channel had that
    // they don't. Relative URIs are resolved against the upstream's final URL
    // (after its own redirects) — resolving against the requested URL instead
    // is the exact bug documented in ../pluto-proxy/worker.js.
    if (url.pathname === "/live.m3u8") {
      const target = (await env.ASIANGAMES_STATE.get(KV_KEY)) || DEFAULT_TARGET;
      try {
        const viaBinding =
          new URL(target).hostname === PPTV_PROXY_HOST && env.PPTV_PROXY;
        const res = viaBinding
          ? await env.PPTV_PROXY.fetch(target, { redirect: "follow" })
          : await fetch(target, { redirect: "follow" });
        if (!res.ok) {
          return new Response(`Upstream ${res.status}`, {
            status: 502,
            headers: CORS_HEADERS,
          });
        }
        const body = await res.text();
        const baseUrl = res.url || target;
        const rewritten = body
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith("#")) {
              return line.replace(/URI="([^"]+)"/g, (m, ref) => {
                try {
                  return `URI="${new URL(ref, baseUrl).toString()}"`;
                } catch (e) {
                  return m;
                }
              });
            }
            try {
              return new URL(trimmed, baseUrl).toString();
            } catch (e) {
              return line;
            }
          })
          .join("\n");
        return new Response(rewritten, {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/vnd.apple.mpegurl",
            // Upstream manifests carry expiring tokens and a live segment window.
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

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
