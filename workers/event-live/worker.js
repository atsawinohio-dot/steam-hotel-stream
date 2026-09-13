// Channel 21 "Event": live broadcasts from the hotel, on the Workers Free plan.
//
// OBS on the hotel PC streams RTMP to a local ffmpeg (start-event.ps1), which
// cuts it into 6s HLS segments and PUTs each segment and the playlist here.
// Players read the same paths back with GET. Both sides go through a single
// Durable Object, which stores the last few segments in SQLite.
//
// The Free plan allows 100,000 Worker requests per day for the WHOLE account,
// shared with the 3HD / Amarin / Pluto proxies. Running out means every one of
// those channels fails until the daily reset (00:00 UTC = 07:00 in Bangkok).
// A viewer costs ~1,200 requests an hour (a playlist refresh and a segment
// every 6s), so a busy event could burn through the lot. DAILY_BUDGET caps this
// channel well short of that: once it is spent, the playlist is served with
// #EXT-X-ENDLIST, which makes HLS players stop polling — the event goes off
// air for the day, but the rest of the lineup keeps working.

import { Control } from "./control.js";
import controlPage from "./control.html";

const DAILY_BUDGET = 85_000;
// A playlist not refreshed for this long means the broadcast stopped without a
// clean ENDLIST (ffmpeg crashed, PC lost network); report it as not live.
const STALE_MS = 30_000;
// Segments kept after they scroll out of the playlist, for players still a
// few segments behind the live edge.
const KEEP_SEGMENTS = 12;
// SQLite rows are capped at 2 MB; a 6s segment at OBS's usual 2.5 Mbps is
// ~1.9 MB, so segments are split across rows.
const CHUNK_BYTES = 1024 * 1024;
const SEG_RE = /^[A-Za-z0-9_-]{1,64}\.ts$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};
const PLAYLIST_TYPE = "application/vnd.apple.mpegurl";

// Tell the player where to begin instead of letting it pick.
//
// Left alone, an HLS player buffers three segments before it shows anything,
// which at 6s segments is 18 seconds of staring at a blank channel after
// someone presses "start" — measured 2026-09-14, and it was the bulk of the
// ~25s startup (OBS launching and connecting accounts for only about 6s).
//
// EXT-X-START moves the starting point to one segment back from the live edge.
// It costs nothing: the playlist is already being fetched, so this adds no
// requests and none of the daily budget, unlike shortening the segments.
// One segment of margin rather than zero, so a player that is briefly slow
// still has something buffered instead of stalling on the first frame.
function startAtLiveEdge(playlist) {
  if (!playlist || playlist.includes("#EXT-X-START")) return playlist;
  return playlist.replace("#EXTM3U", "#EXTM3U\n#EXT-X-START:TIME-OFFSET=-6,PRECISE=YES");
}

function text(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8", ...extra },
  });
}

function authorized(request, env) {
  const got = request.headers.get("Authorization") || "";
  const want = `Bearer ${env.INGEST_TOKEN || ""}`;
  if (!env.INGEST_TOKEN || got.length !== want.length) return false;
  let diff = 0; // constant-time compare
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname === "/") {
      return text("Steam Hotel channel 21 (Event). Playback: /live/index.m3u8  Status: /status  Control: /control");
    }

    const path = url.pathname;
    if (path === "/control") {
      return new Response(controlPage, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    const stub = env.EVENT.get(env.EVENT.idFromName("channel-21"));
    // The control API does its own auth (session cookie for the phone, the
    // ingest token for the laptop agent) inside the Durable Object.
    if (path.startsWith("/control/")) return stub.fetch(request);

    const isWrite = ["PUT", "POST", "DELETE"].includes(request.method);
    if (isWrite && !authorized(request, env)) return text("Unauthorized", 401);

    const known =
      path === "/status" ||
      path === "/live/" ||
      path === "/live/index.m3u8" ||
      (path.startsWith("/live/") && SEG_RE.test(path.slice(6)));
    if (!known) return text("Not found", 404);

    return stub.fetch(request);
  },
};

export class EventChannel {
  constructor(ctx, env) {
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS seg (id INTEGER PRIMARY KEY, name TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL)`
    );
    // One row keyed by INTEGER PRIMARY KEY, so every update is a single row
    // written (the Free plan allows 100,000 rows written per day).
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), playlist TEXT, last_ingest INTEGER, day TEXT, used INTEGER)`
    );
    const row = this.sql.exec(`SELECT playlist, last_ingest, day, used FROM state WHERE id = 1`).toArray()[0];
    this.playlist = row?.playlist ?? null;
    this.lastIngest = row?.last_ingest ?? 0;
    this.day = row?.day ?? "";
    this.used = row?.used ?? 0;
    this.flushedUsed = this.used;
    this.control = new Control(this.sql, env);
  }

  // Counted in memory and flushed every 200 requests (or on the next playlist
  // upload), because persisting on every request would spend a row write per
  // request. If the object is evicted between flushes, up to 200 requests go
  // uncounted — DAILY_BUDGET leaves 15,000 of slack for that and for the other
  // workers on the account.
  countRequest(now) {
    const today = new Date(now).toISOString().slice(0, 10); // UTC day, same as Cloudflare's reset
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
      this.flushedUsed = -1;
    }
    this.used++;
    if (this.used - this.flushedUsed >= 200) this.saveState();
  }

  saveState() {
    this.sql.exec(
      `INSERT INTO state (id, playlist, last_ingest, day, used) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET playlist = excluded.playlist, last_ingest = excluded.last_ingest,
         day = excluded.day, used = excluded.used`,
      this.playlist,
      this.lastIngest,
      this.day,
      this.used
    );
    this.flushedUsed = this.used;
  }

  overBudget() {
    return this.used >= DAILY_BUDGET;
  }

  live(now) {
    return this.playlist !== null && now - this.lastIngest < STALE_MS;
  }

  async fetch(request) {
    const now = Date.now();
    this.countRequest(now);
    const path = new URL(request.url).pathname;
    const method = request.method;

    const status = () => ({
      live: this.live(now),
      lastIngestSecondsAgo: this.lastIngest ? Math.round((now - this.lastIngest) / 1000) : null,
      requestsToday: this.used,
      dailyBudget: DAILY_BUDGET,
      offAirForBudget: this.overBudget(),
    });

    if (path.startsWith("/control/")) return this.control.handle(request, now, status());

    if (path === "/status") {
      return new Response(JSON.stringify(status()), {
        headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // DELETE /live/ wipes the channel; start-event.ps1 calls it before each
    // broadcast so a new event never opens on the tail of the last one.
    if (method === "DELETE" && path === "/live/") {
      this.sql.exec(`DELETE FROM seg`);
      this.playlist = null;
      this.lastIngest = 0;
      this.saveState();
      return text("Cleared");
    }

    const name = path.slice(6);

    if (method === "PUT" || method === "POST") {
      // ffmpeg sends chunked bodies with no Content-Length; buffer it.
      const body = await request.arrayBuffer();
      if (name === "index.m3u8") {
        this.playlist = new TextDecoder().decode(body);
        this.lastIngest = now;
        this.sql.exec(
          `DELETE FROM seg WHERE name NOT IN (SELECT name FROM seg GROUP BY name ORDER BY MAX(id) DESC LIMIT ?)`,
          KEEP_SEGMENTS
        );
        this.saveState();
        return new Response(null, { status: 201 });
      }
      // Re-uploading a name (ffmpeg retrying a failed PUT) replaces it.
      this.sql.exec(`DELETE FROM seg WHERE name = ?`, name);
      for (let off = 0, part = 0; off < body.byteLength; off += CHUNK_BYTES, part++) {
        this.sql.exec(
          `INSERT INTO seg (name, part, data) VALUES (?, ?, ?)`,
          name,
          part,
          body.slice(off, off + CHUNK_BYTES)
        );
      }
      return new Response(null, { status: 201 });
    }

    if (method === "DELETE") {
      this.sql.exec(`DELETE FROM seg WHERE name = ?`, name);
      return new Response(null, { status: 204 });
    }

    if (method !== "GET" && method !== "HEAD") return text("Method not allowed", 405);

    if (name === "index.m3u8") {
      if (this.overBudget()) {
        // An ended playlist makes HLS players stop polling, which is the only
        // way to actually stop the requests (a rejected request still counts).
        return new Response("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-ENDLIST\n", {
          headers: { ...CORS, "Content-Type": PLAYLIST_TYPE, "Cache-Control": "no-store" },
        });
      }
      if (!this.live(now)) return text("Not live", 404, { "Cache-Control": "no-store" });
      return new Response(method === "HEAD" ? null : startAtLiveEdge(this.playlist), {
        headers: { ...CORS, "Content-Type": PLAYLIST_TYPE, "Cache-Control": "no-cache, no-store, max-age=0" },
      });
    }

    const rows = this.sql.exec(`SELECT data FROM seg WHERE name = ? ORDER BY part`, name).toArray();
    if (!rows.length) return text("Not found", 404);
    const total = rows.reduce((n, r) => n + r.data.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const r of rows) {
      out.set(new Uint8Array(r.data), off);
      off += r.data.byteLength;
    }
    return new Response(method === "HEAD" ? null : out, {
      headers: {
        ...CORS,
        "Content-Type": "video/mp2t",
        "Content-Length": String(total),
        "Cache-Control": "public, max-age=3600",
      },
    });
  }
}
