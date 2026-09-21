// steam-hotel-asiangames: channel 21 "Asian Games 2026".
//
// No single Thai channel airs every event. Coverage rotates across 7 free
// digital channels (NBT, T Sports 7, MCOT HD, ONE 31, MONOMAX SPORTS TV,
// ไทยรัฐทีวี 32, PPTV HD 36), assigned per match and sometimes changed at the
// last minute "to follow the Thai team's most interesting matchup" (PPTV's own
// schedule page says as much). No public API exposes that decision.
//
// So the split is: the picker task plans the day and POSTs the running order
// to /plan, and this Worker decides what to serve on every request by looking
// at the clock. Switching therefore lands on the block boundary rather than
// whenever the task next happens to run — an earlier design polled hourly and
// left the channel parked on a broadcaster's unrelated programming for the
// best part of an hour before kickoff.
//
// Anything not covered by a block — and any block whose broadcaster has no
// working feed — falls back to the standby card, which carries the emblem and
// the day's schedule. That is deliberate: a card that tells the guest which
// channel has the match beats an unrelated programme.
//
// Games run 2026-09-10 to 2026-10-04. This channel is temporary — remove its
// entry from iptv.m3u8 and this Worker after the games end.

const PLAN_KEY = "day_plan";
const OVERRIDE_KEY = "override";

const STANDBY =
  "https://atsawinohio-dot.github.io/steam-hotel-stream/asiangames-standby/standby.m3u8";

// The feeds a block may name. Kept here rather than in the plan so a stale or
// malformed plan can never point the channel at an arbitrary URL.
const SOURCES = {
  pptv: "https://steam-hotel-pptv-proxy.tiny-hall-8718.workers.dev/live/playlist_720p.m3u8",
  mcot: "https://mcothd-streaming-edge-cdn.mcot.net/tencentmcot/smil:tencentmcot.smil/playlist.m3u8",
  nbt: "https://cdn-edge.iiptvcdn.com/live_event/smil:f180-054a-38d7-ce66-f7cf.smil/playlist.m3u8",
  thairath:
    "https://steam-hotel-thairath-proxy.tiny-hall-8718.workers.dev/live/playlist_720p.m3u8",
  standby: STANDBY,
};

// Reached over the PPTV_PROXY service binding rather than a plain fetch — a
// subrequest to another Worker on this account's workers.dev subdomain routes
// back into this Worker and hits its catch-all 404. See wrangler.toml.
const BINDINGS = {
  "steam-hotel-pptv-proxy.tiny-hall-8718.workers.dev": "PPTV_PROXY",
  "steam-hotel-thairath-proxy.tiny-hall-8718.workers.dev": "THAIRATH_PROXY",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, POST",
  "Access-Control-Allow-Headers": "*",
};

// Thailand is UTC+7 year-round, no DST — the hotel and every broadcaster in
// the plan are on that clock, and Workers run in UTC.
function bangkokNowMinutes() {
  const utc = new Date();
  return ((utc.getUTCHours() + 7) % 24) * 60 + utc.getUTCMinutes();
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// The block on air right now, if any. Blocks are wall-clock times on a single
// day; one ending past midnight is treated as ending at midnight rather than
// wrapping, which would otherwise make it match all morning.
function currentBlock(plan, nowMinutes) {
  if (!plan || !Array.isArray(plan.blocks)) return null;
  for (const block of plan.blocks) {
    const start = toMinutes(block.start);
    const end = toMinutes(block.end);
    if (start === null || end === null || end <= start) continue;
    if (nowMinutes >= start && nowMinutes < end) return block;
  }
  return null;
}

function resolve(plan, nowMinutes) {
  const block = currentBlock(plan, nowMinutes);
  if (!block) return { url: STANDBY, label: "STANDBY - no block on air" };
  const url = SOURCES[block.source];
  if (!url || block.source === "standby") {
    return {
      url: STANDBY,
      label: `STANDBY - ${block.event || "on air"} is on ${block.channel || "another channel"}`,
      block,
    };
  }
  return {
    url,
    label: `${block.channel || block.source} - ${block.event || ""}`.trim(),
    block,
  };
}

async function readPlan(env) {
  try {
    return await env.ASIANGAMES_STATE.get(PLAN_KEY, "json");
  } catch (e) {
    return null;
  }
}

// A manual pin, for testing a feed on the real TV without fighting the plan.
// It carries its own expiry so a forgotten override can't strand the channel.
async function readOverride(env) {
  try {
    const o = await env.ASIANGAMES_STATE.get(OVERRIDE_KEY, "json");
    if (!o || !o.url) return null;
    if (o.expiresAt && Date.now() > o.expiresAt) return null;
    return o;
  } catch (e) {
    return null;
  }
}

async function fetchUpstream(target, env) {
  const binding = BINDINGS[new URL(target).hostname];
  return binding && env[binding]
    ? env[binding].fetch(target, { redirect: "follow" })
    : fetch(target, { redirect: "follow" });
}

// Serves the manifest body rather than 302-ing to it: the hotel's Samsung TV
// fails with PLAYER_ERROR_CONNECTION_FAILED on a redirect, and every channel
// that does play on it is a plain manifest URL. Relative URIs resolve against
// the upstream's final URL (after its own redirects) — resolving against the
// requested URL instead is the exact bug documented in ../pluto-proxy.
function rewriteManifest(body, baseUrl) {
  return body
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
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "Steam Hotel Asian Games 2026 channel. GET /live.m3u8, GET /status, POST /plan, POST /set",
        { headers: CORS_HEADERS }
      );
    }

    if (url.pathname === "/status") {
      const [plan, override] = await Promise.all([readPlan(env), readOverride(env)]);
      const nowMinutes = bangkokNowMinutes();
      const picked = override
        ? { url: override.url, label: override.label || "manual override" }
        : resolve(plan, nowMinutes);
      return Response.json(
        {
          nowBangkok: `${String(Math.floor(nowMinutes / 60)).padStart(2, "0")}:${String(
            nowMinutes % 60
          ).padStart(2, "0")}`,
          onAir: picked.url,
          label: picked.label,
          override: override
            ? { url: override.url, expiresAt: override.expiresAt }
            : null,
          planDate: plan ? plan.date : null,
          blocks: plan && Array.isArray(plan.blocks) ? plan.blocks : [],
        },
        { headers: CORS_HEADERS }
      );
    }

    // The picker posts the day's running order here.
    if (url.pathname === "/plan" && request.method === "POST") {
      if ((request.headers.get("Authorization") || "") !== `Bearer ${env.SET_TOKEN}`) {
        return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response("Bad JSON body", { status: 400, headers: CORS_HEADERS });
      }
      if (!body || !Array.isArray(body.blocks)) {
        return new Response("Body must be { date, blocks: [...] }", {
          status: 400,
          headers: CORS_HEADERS,
        });
      }
      const bad = body.blocks.find(
        (b) => toMinutes(b.start) === null || toMinutes(b.end) === null
      );
      if (bad) {
        return new Response(
          `Every block needs HH:MM start and end — bad block: ${JSON.stringify(bad)}`,
          { status: 400, headers: CORS_HEADERS }
        );
      }
      await env.ASIANGAMES_STATE.put(PLAN_KEY, JSON.stringify(body));
      return Response.json(
        { ok: true, date: body.date || null, blocks: body.blocks.length },
        { headers: CORS_HEADERS }
      );
    }

    // Manual pin. `hours` controls how long it holds (default 3); posting
    // {"clear": true} drops it and hands the channel back to the plan.
    if (url.pathname === "/set" && request.method === "POST") {
      if ((request.headers.get("Authorization") || "") !== `Bearer ${env.SET_TOKEN}`) {
        return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response("Bad JSON body", { status: 400, headers: CORS_HEADERS });
      }
      if (body && body.clear) {
        await env.ASIANGAMES_STATE.delete(OVERRIDE_KEY);
        return Response.json({ ok: true, cleared: true }, { headers: CORS_HEADERS });
      }
      if (!body || typeof body.url !== "string" || !/^https:\/\//.test(body.url)) {
        return new Response("Body must include an https `url`, or {clear:true}", {
          status: 400,
          headers: CORS_HEADERS,
        });
      }
      const hours = Number(body.hours) > 0 ? Number(body.hours) : 3;
      const override = {
        url: body.url,
        label: body.label || "manual override",
        expiresAt: Date.now() + hours * 3600 * 1000,
      };
      await env.ASIANGAMES_STATE.put(OVERRIDE_KEY, JSON.stringify(override), {
        expirationTtl: Math.max(60, Math.floor(hours * 3600)),
      });
      return Response.json({ ok: true, ...override }, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/live.m3u8") {
      const [plan, override] = await Promise.all([readPlan(env), readOverride(env)]);
      const picked = override
        ? { url: override.url }
        : resolve(plan, bangkokNowMinutes());
      try {
        const res = await fetchUpstream(picked.url, env);
        if (!res.ok) throw new Error(`upstream ${res.status}`);
        const body = await res.text();
        return new Response(rewriteManifest(body, res.url || picked.url), {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/vnd.apple.mpegurl",
            // Upstreams carry expiring tokens and a live segment window, and
            // the pick itself changes on block boundaries.
            "Cache-Control": "no-store",
          },
        });
      } catch (err) {
        // Never leave the channel dead: if the planned feed is unreachable,
        // fall through to the standby card.
        if (picked.url !== STANDBY) {
          try {
            const res = await fetch(STANDBY, { redirect: "follow" });
            const body = await res.text();
            return new Response(rewriteManifest(body, res.url || STANDBY), {
              headers: {
                ...CORS_HEADERS,
                "Content-Type": "application/vnd.apple.mpegurl",
                "Cache-Control": "no-store",
              },
            });
          } catch (e) {
            /* fall through to the error below */
          }
        }
        return new Response(`Proxy error: ${err.message}`, {
          status: 502,
          headers: CORS_HEADERS,
        });
      }
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
