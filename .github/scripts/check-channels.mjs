// Channel health check for the ROYS Hotel IPTV playlist — runs on GitHub
// Actions so it keeps going when the hotel laptop is off. Same rules as the
// laptop bot (iptv-channel-health-check): a channel is healthy when the final
// response is 200, starts with #EXTM3U, and is either a master playlist whose
// first variant is also healthy, or a media playlist with segments.
//
// Exits 1 when any channel is down after retries, which fails the workflow run
// and makes GitHub email the repo owner. No AI here, so no diagnosis — just
// which channel, what status.

const PLAYLIST =
  process.env.PLAYLIST_URL ||
  "https://atsawinohio-dot.github.io/steam-hotel-stream/iptv.m3u8";
const TIMEOUT_MS = 20_000;
const RETRIES = 2;
const RETRY_DELAY_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": "Mozilla/5.0 (ROYS Hotel channel check)" },
  });
  // fetch decompresses gzip itself — the nhk origin that sends gzip
  // unconditionally is handled without a --compressed equivalent.
  return { status: res.status, url: res.url, body: await res.text() };
}

function problem(r) {
  if (r.status !== 200) return `HTTP ${r.status}`;
  if (!r.body.trimStart().startsWith("#EXTM3U")) return "not a playlist";
  return null;
}

async function checkOnce(url) {
  const r = await get(url);
  const p = problem(r);
  if (p) return p;
  if (r.body.includes("#EXT-X-STREAM-INF")) {
    // A master that lists dead variants is still a broken channel — that is
    // exactly how the 3HD outage looked. Resolve against the FINAL url and
    // keep the master's query string when the variant has none (signed URLs).
    const lines = r.body.split(/\r?\n/);
    const i = lines.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
    const ref = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
    if (!ref) return "master with no variants";
    const v = new URL(ref.trim(), r.url);
    if (!v.search) v.search = new URL(r.url).search;
    const vr = await get(v.href);
    const vp = problem(vr);
    if (vp) return `variant ${vp}`;
    if (!/\.(ts|m4s|mp4|aac)(\?|$)|^https?:\/\//m.test(vr.body.replace(/^#.*$/gm, "")))
      return "variant has no segments";
    return null;
  }
  const media = r.body.replace(/^#.*$/gm, "").trim();
  return media ? null : "no segments";
}

async function check(ch) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      last = await checkOnce(ch.url);
    } catch (e) {
      last = e.name === "TimeoutError" ? "timeout" : e.message;
    }
    if (!last) return null;
    if (attempt < RETRIES) await sleep(RETRY_DELAY_MS);
  }
  return last;
}

const text = (await get(PLAYLIST)).body;
const lines = text.split(/\r?\n/);
const channels = [];
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith("#EXTINF")) continue;
  const name = lines[i].slice(lines[i].lastIndexOf(",") + 1).trim();
  const url = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
  if (url) channels.push({ name, url: url.trim() });
}
if (channels.length === 0) {
  console.log("DOWN — playlist empty or unreachable");
  process.exit(1);
}

const results = await Promise.all(
  channels.map(async (ch) => ({ ...ch, err: await check(ch) }))
);
const down = results.filter((r) => r.err);
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).slice(0, 16);

for (const r of results) console.log(`${r.err ? "DOWN" : "ok  "}  ${r.name}${r.err ? ` — ${r.err}` : ""}`);
const summary = down.length
  ? `${stamp} DOWN ${down.length}/${channels.length} — ${down.map((r) => `${r.name} (${r.err})`).join(", ")}`
  : `${stamp} OK ${channels.length}/${channels.length}`;
console.log(`\n${summary}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### ${down.length ? "⚠️ มีช่องล่ม" : "✅ ทุกช่องปกติ"}\n\n\`${summary}\`\n\n` +
      results.map((r) => `- ${r.err ? "❌" : "✅"} ${r.name}${r.err ? ` — ${r.err}` : ""}`).join("\n") +
      "\n"
  );
}
process.exit(down.length ? 1 : 0);
