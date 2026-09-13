// Remote control for channel 21, served from the same Durable Object as the
// video so both share one request budget and one piece of state.
//
//   phone ──(cookie)──▶ /control/api/*  ──▶ command queue + last known status
//   laptop agent ──(Bearer INGEST_TOKEN)──▶ /control/agent  (polls, reports, picks up commands)
//
// The laptop never accepts inbound connections: the agent (agent/agent.mjs)
// polls out to Cloudflare, so there is no firewall or router setup. Commands
// are a short queue of one-shot actions rather than a "desired state", so the
// agent never fights someone operating OBS by hand on the laptop — it only acts
// when the owner presses a button, and a command left waiting while the laptop
// was offline expires instead of firing hours later.

const COMMAND_TTL_MS = 3 * 60_000;
const ACTIONS = new Set(["start", "stop", "mute", "unmute", "standby", "camera"]);
const SESSION_MS = 12 * 3600_000;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_MAX_FAILS = 10;
const PREVIEW_MAX_BYTES = 200_000;
// Poll fast only while someone is looking at the control page or a broadcast
// is running; otherwise the idle agent costs ~2,900 requests a day, not ~17,000.
const VIEWER_ACTIVE_MS = 60_000;
const FAST_POLL_S = 4;
const SLOW_POLL_S = 30;

const enc = new TextEncoder();

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sessionValid(request, env, now) {
  // ไม่ได้ตั้ง secret CONTROL_PASSWORD ไว้ = เปิดให้ใครก็ได้ที่มีลิงก์ใช้งานโดยไม่ต้องล็อกอิน
  // (เจ้าของเลือกเองเมื่อ 2026-09-14 เพราะพิมพ์รหัสบนมือถือทุก 12 ชม. แล้วรำคาญ)
  // ตั้ง secret กลับเข้าไปเมื่อไหร่ หน้าควบคุมก็กลับมาถามรหัสทันที ไม่ต้องแก้โค้ด:
  //   wrangler secret put CONTROL_PASSWORD
  if (!env.CONTROL_PASSWORD) return true;
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)ctl=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < now) return false;
  return safeEqual(sig, await hmac(env.CONTROL_PASSWORD, `session:${exp}`));
}

export class Control {
  constructor(sql, env) {
    this.sql = sql;
    this.env = env;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ctl (id INTEGER PRIMARY KEY CHECK (id = 1), commands TEXT, agent TEXT, agent_seen INTEGER, preview BLOB, preview_at INTEGER)`
    );
    const row = sql.exec(`SELECT commands, agent, agent_seen, preview_at FROM ctl WHERE id = 1`).toArray()[0];
    this.commands = row?.commands ? JSON.parse(row.commands) : [];
    this.agent = row?.agent ? JSON.parse(row.agent) : null;
    this.agentSeen = row?.agent_seen ?? 0;
    this.previewAt = row?.preview_at ?? 0;
    this.viewerSeen = 0; // memory only: not worth a row write per page poll
    this.nextId = this.commands.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    this.fails = [];
  }

  save(preview) {
    const args = [JSON.stringify(this.commands), JSON.stringify(this.agent), this.agentSeen, this.previewAt];
    if (preview) {
      this.sql.exec(
        `INSERT INTO ctl (id, commands, agent, agent_seen, preview_at, preview) VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET commands = excluded.commands, agent = excluded.agent,
           agent_seen = excluded.agent_seen, preview_at = excluded.preview_at, preview = excluded.preview`,
        ...args,
        preview
      );
    } else {
      this.sql.exec(
        `INSERT INTO ctl (id, commands, agent, agent_seen, preview_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET commands = excluded.commands, agent = excluded.agent,
           agent_seen = excluded.agent_seen, preview_at = excluded.preview_at`,
        ...args
      );
    }
  }

  pruneCommands(now) {
    this.commands = this.commands.filter((c) => now - c.at < COMMAND_TTL_MS);
  }

  // `channel` is what the video side knows: whether segments are arriving and
  // how much of today's request budget is gone.
  async handle(request, now, channel) {
    const path = new URL(request.url).pathname;
    const method = request.method;

    if (path === "/control/agent" && method === "POST") return this.agentPoll(request, now, channel);

    if (path === "/control/api/login" && method === "POST") {
      // ไม่มีรหัสตั้งไว้ = ผ่านเลย เผื่อหน้าเว็บเก่าที่ยังค้างอยู่ในมือถือส่งฟอร์มมา
      if (!this.env.CONTROL_PASSWORD) return json({ ok: true });
      this.fails = this.fails.filter((t) => now - t < LOGIN_WINDOW_MS);
      if (this.fails.length >= LOGIN_MAX_FAILS) return json({ error: "ลองผิดหลายครั้งเกินไป รอ 10 นาทีแล้วลองใหม่" }, 429);
      const body = await request.json().catch(() => ({}));
      const pw = String(body.password || "");
      if (!this.env.CONTROL_PASSWORD || !safeEqual(pw, this.env.CONTROL_PASSWORD)) {
        this.fails.push(now);
        return json({ error: "รหัสผ่านไม่ถูกต้อง" }, 401);
      }
      const exp = now + SESSION_MS;
      const token = `${exp}.${await hmac(this.env.CONTROL_PASSWORD, `session:${exp}`)}`;
      return json({ ok: true }, 200, {
        "Set-Cookie": `ctl=${token}; Path=/control; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`,
      });
    }

    if (!(await sessionValid(request, this.env, now))) return json({ error: "login" }, 401);
    this.viewerSeen = now;

    if (path === "/control/api/state" && method === "GET") {
      this.pruneCommands(now);
      return json({
        now,
        channel,
        agent: this.agent,
        agentSecondsAgo: this.agentSeen ? Math.round((now - this.agentSeen) / 1000) : null,
        pending: this.commands.map((c) => ({ id: c.id, action: c.action, secondsAgo: Math.round((now - c.at) / 1000) })),
        previewAt: this.previewAt,
      });
    }

    if (path === "/control/api/command" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!ACTIONS.has(body.action)) return json({ error: "unknown action" }, 400);
      this.pruneCommands(now);
      // A newer press of the same kind of button replaces an unsent older one.
      const opposite = { start: "stop", stop: "start", mute: "unmute", unmute: "mute", standby: "camera", camera: "standby" };
      this.commands = this.commands.filter((c) => c.action !== body.action && c.action !== opposite[body.action]);
      this.commands.push({ id: this.nextId++, action: body.action, at: now });
      this.save();
      return json({ ok: true });
    }

    if (path === "/control/api/preview.jpg" && method === "GET") {
      const row = this.sql.exec(`SELECT preview FROM ctl WHERE id = 1`).toArray()[0];
      if (!row?.preview) return new Response("No preview yet", { status: 404 });
      return new Response(row.preview, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } });
    }

    return json({ error: "not found" }, 404);
  }

  async agentPoll(request, now, channel) {
    const got = request.headers.get("Authorization") || "";
    if (!this.env.INGEST_TOKEN || !safeEqual(got, `Bearer ${this.env.INGEST_TOKEN}`)) {
      return json({ error: "unauthorized" }, 401);
    }
    const body = await request.json().catch(() => ({}));
    const acked = new Set(Array.isArray(body.acked) ? body.acked : []);
    this.commands = this.commands.filter((c) => !acked.has(c.id));
    this.pruneCommands(now);
    this.agent = body.status || null;
    this.agentSeen = now;

    let preview = null;
    if (typeof body.preview === "string" && body.preview.length < PREVIEW_MAX_BYTES * 1.4) {
      const bin = atob(body.preview);
      preview = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) preview[i] = bin.charCodeAt(i);
      this.previewAt = now;
    }
    this.save(preview);

    const viewerActive = now - this.viewerSeen < VIEWER_ACTIVE_MS;
    const busy = viewerActive || this.commands.length > 0 || body.status?.streaming;
    return json({
      commands: this.commands.map((c) => ({ id: c.id, action: c.action })),
      pollSeconds: busy ? FAST_POLL_S : SLOW_POLL_S,
      wantPreview: viewerActive,
      // Sent back so the desktop program on the laptop can show whether the
      // channel is actually on air, and how much of today's budget is left,
      // without spending a request of its own on /status.
      channel,
    });
  }
}
