// Status page for the ROYS Hotel IPTV lineup — a page the owner can open on
// a phone to see whether every channel is up. A cron trigger checks the live
// playlist every 30 minutes and keeps the result in KV; GET / renders it.
//
// This does NOT alert anyone. Alerts come from the GitHub Actions check
// (email) and the laptop bot (phone push). This is the "look it up" view.
//
// Same health rule as the other two checkers: final 200, body starts #EXTM3U,
// and for a master playlist its first variant must pass too.

const PLAYLIST = "https://atsawinohio-dot.github.io/steam-hotel-stream/iptv.m3u8";

// Worker-to-worker on the same workers.dev subdomain 404s; go via bindings.
const BINDINGS = {
  "steam-hotel-ch3-proxy.tiny-hall-8718.workers.dev": "CH3_PROXY",
  "steam-hotel-amarin-proxy.tiny-hall-8718.workers.dev": "AMARIN_PROXY",
  "steam-hotel-pluto-proxy.tiny-hall-8718.workers.dev": "PLUTO_PROXY",
  "steam-hotel-mcot-proxy.tiny-hall-8718.workers.dev": "MCOT_PROXY",
  "steam-hotel-thairath-proxy.tiny-hall-8718.workers.dev": "THAIRATH_PROXY",
};

// Channels this Worker's own network can't reach, for reasons that have
// nothing to do with whether the channel actually works on the hotel's TVs.
// CH7 (403), Thai PBS and Amarin TV HD (451, both on byteark) geo-block
// outside Thailand — where a cron run lands is up to Cloudflare, so it's a
// coin flip per run: Amarin failed the 20:01 and 20:31 crons on 2026-09-26
// and passed every manual check minutes later, served from Bangkok. ONE31 (added
// 2026-09-26) is different: its stream lives behind Brightcove/Fastly, which
// answers 403 to *every* Cloudflare Workers request regardless of region —
// verified straight against the CDN root, not just this one path — while a
// plain curl or a real TV on a normal ISP connection gets 200. No proxy can
// fix that (see AGENTS.md § ONE31 for why one wasn't built). Either way the
// failure is shown as "can't check from here", not as down; any other
// failure on these channels still counts.
const GEO_BLOCKED = new Set(["CH7 HD", "Thai PBS", "Amarin TV HD", "ONE31"]);
const GEO_STATUS = /\b(403|451)\b/;

// Free plan: 50 subrequests per invocation. Budget below that, leaving room
// for the playlist fetch and retries of failures.
const SUBREQUEST_BUDGET = 45;
const HISTORY = 48; // one day of half-hourly runs
const MANUAL_MIN_GAP_MS = 2 * 60 * 1000;

class Budget {
  constructor(n) { this.left = n; }
  take() { if (this.left <= 0) throw new Error("budget"); this.left--; }
}

async function get(env, budget, url, depth = 0) {
  budget.take();
  const u = new URL(url);
  const binding = BINDINGS[u.host];
  const init = {
    redirect: binding ? "manual" : "follow",
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0 (ROYS Hotel status page)" },
  };
  const res = binding ? await env[binding].fetch(url, init) : await fetch(url, init);
  // Our proxies answer 302 to a CDN; follow that hop with a normal fetch.
  if (binding && res.status >= 300 && res.status < 400 && depth < 3) {
    const loc = res.headers.get("Location");
    if (loc) return get(env, budget, new URL(loc, url).href, depth + 1);
  }
  return { status: res.status, url: res.url || url, body: await res.text() };
}

function problem(r) {
  if (r.status !== 200) return `HTTP ${r.status}`;
  if (!r.body.trimStart().startsWith("#EXTM3U")) return "ไม่ใช่เพลย์ลิสต์";
  return null;
}

async function checkOnce(env, budget, url) {
  const r = await get(env, budget, url);
  const p = problem(r);
  if (p) return p;
  if (r.body.includes("#EXT-X-STREAM-INF")) {
    const lines = r.body.split(/\r?\n/);
    const i = lines.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
    const ref = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
    if (!ref) return "master ไม่มี variant";
    const v = new URL(ref.trim(), r.url);
    if (!v.search) v.search = new URL(r.url).search;
    const vp = problem(await get(env, budget, v.href));
    return vp ? `variant ${vp}` : null;
  }
  return r.body.replace(/^#.*$/gm, "").trim() ? null : "ไม่มี segment";
}

async function runCheck(env, source) {
  const budget = new Budget(SUBREQUEST_BUDGET);
  const text = (await get(env, budget, PLAYLIST)).body;
  const lines = text.split(/\r?\n/);
  const channels = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXTINF")) continue;
    const name = lines[i].slice(lines[i].lastIndexOf(",") + 1).trim();
    const url = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
    if (url) channels.push({ name, url: url.trim() });
  }

  const attempt = async (ch) => {
    try { return await checkOnce(env, budget, ch.url); }
    catch (e) {
      if (e.message === "budget") return "__budget";
      return e.name === "TimeoutError" ? "timeout" : "ต่อไม่ติด";
    }
  };

  const results = await Promise.all(channels.map(async (ch) => ({ ...ch, err: await attempt(ch) })));
  // One retry for failures, while budget lasts — live CDNs blip.
  for (const r of results) {
    if (r.err && r.err !== "__budget" && budget.left > 2) r.err = await attempt(r);
  }

  const out = results.map((r) => {
    if (r.err === "__budget") return { name: r.name, state: "skip" };
    if (r.err && GEO_BLOCKED.has(r.name) && GEO_STATUS.test(r.err)) return { name: r.name, state: "geo" };
    return r.err ? { name: r.name, state: "down", err: r.err } : { name: r.name, state: "ok" };
  });

  const snapshot = {
    at: Date.now(),
    source,
    channels: out,
    ok: out.filter((c) => c.state === "ok" || c.state === "geo").length,
    total: out.length,
  };
  const history = JSON.parse((await env.STATUS.get("history")) || "[]");
  history.unshift({ at: snapshot.at, ok: snapshot.ok, total: snapshot.total,
    down: out.filter((c) => c.state === "down").map((c) => c.name) });
  await env.STATUS.put("latest", JSON.stringify(snapshot));
  await env.STATUS.put("history", JSON.stringify(history.slice(0, HISTORY)));
  return snapshot;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const bkk = (ms) => new Date(ms).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function page(latest, history) {
  const down = latest ? latest.channels.filter((c) => c.state === "down") : [];
  const verdict = !latest
    ? `<div class="verdict wait">ยังไม่มีผลตรวจ — กด "ตรวจตอนนี้"</div>`
    : down.length
      ? `<div class="verdict bad">⚠️ มีช่องล่ม ${down.length} ช่อง</div>`
      : `<div class="verdict good">✅ ทุกช่องปกติ ${latest.ok}/${latest.total}</div>`;
  const icon = { ok: "✅", down: "❌", geo: "🌏", skip: "⏸️" };
  const label = { ok: "ปกติ", geo: "ตรวจจากต่างประเทศไม่ได้ (บล็อกนอกไทย)", skip: "รอบนี้ไม่ได้ตรวจ" };
  const rows = latest ? latest.channels.map((c) =>
    `<li class="${c.state}"><span>${icon[c.state]}</span><b>${esc(c.name)}</b><small>${esc(c.state === "down" ? c.err : label[c.state])}</small></li>`).join("") : "";
  const hist = history.slice(0, 12).map((h) =>
    `<li><span>${bkk(h.at)}</span><span class="${h.down.length ? "bad" : "good"}">${h.down.length ? "ล่ม: " + esc(h.down.join(", ")) : `ปกติ ${h.ok}/${h.total}`}</span></li>`).join("");
  return `<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>สถานะช่อง ROYS</title>
<meta http-equiv="refresh" content="300">
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c1f24;--muted:#6b7280;--line:#e5e7eb;--good:#15803d;--goodbg:#dcfce7;--bad:#b91c1c;--badbg:#fee2e2;--wait:#92400e;--waitbg:#fef3c7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--fg:#e8eaed;--muted:#9aa0a6;--line:#2a2e36;--good:#4ade80;--goodbg:#12301f;--bad:#f87171;--badbg:#3a1616;--wait:#fbbf24;--waitbg:#352a0c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,"Leelawadee UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);font-size:14px;margin-bottom:14px}
.verdict{padding:14px 16px;border-radius:12px;font-weight:600;font-size:18px;margin-bottom:14px}
.good{color:var(--good)}.bad{color:var(--bad)}.verdict.good{background:var(--goodbg)}.verdict.bad{background:var(--badbg)}.verdict.wait{background:var(--waitbg);color:var(--wait)}
ul{list-style:none;margin:0;padding:0;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
li{display:grid;grid-template-columns:28px 1fr;gap:0 6px;padding:10px 14px;border-top:1px solid var(--line)}li:first-child{border-top:0}
li small{grid-column:2;color:var(--muted);font-size:13px}li.down{background:var(--badbg)}li.down small{color:var(--bad)}
h2{font-size:15px;color:var(--muted);margin:22px 0 8px}
.hist li{grid-template-columns:auto 1fr;gap:12px;font-size:14px}.hist li span:first-child{color:var(--muted);white-space:nowrap}
form{margin:0 0 14px}button{font:inherit;padding:10px 16px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);width:100%}
.note{color:var(--muted);font-size:13px;margin-top:18px}
</style></head><body><main>
<h1>สถานะช่องทีวี ROYS Hotel</h1>
<div class="sub">${latest ? `ตรวจล่าสุด ${bkk(latest.at)} · ตรวจเองทุก 30 นาที` : "ตรวจเองทุก 30 นาที"}</div>
${verdict}
<form method="post" action="/check"><button>ตรวจตอนนี้</button></form>
<ul>${rows}</ul>
<h2>ย้อนหลัง</h2><ul class="hist">${hist || "<li><span>ยังไม่มี</span></li>"}</ul>
<p class="note">หน้านี้ไม่ส่งแจ้งเตือน — การแจ้งเตือนมาทางอีเมลจาก GitHub และมือถือจากบอทบนโน้ตบุ๊ก · 🌏 = ช่องที่บล็อกคนดูนอกไทย เซิร์ฟเวอร์ตรวจอาจอยู่ต่างประเทศจึงเช็กไม่ได้ ไม่ได้แปลว่าล่ม</p>
</main></body></html>`;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env, "cron"));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/check" && request.method === "POST") {
      const latest = JSON.parse((await env.STATUS.get("latest")) || "null");
      if (!latest || Date.now() - latest.at > MANUAL_MIN_GAP_MS) await runCheck(env, "manual");
      return Response.redirect(url.origin + "/", 303);
    }
    if (url.pathname === "/api/status") {
      return new Response((await env.STATUS.get("latest")) || "null", {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (url.pathname !== "/") return new Response("Not found", { status: 404 });
    const latest = JSON.parse((await env.STATUS.get("latest")) || "null");
    const history = JSON.parse((await env.STATUS.get("history")) || "[]");
    return new Response(page(latest, history), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  },
};
