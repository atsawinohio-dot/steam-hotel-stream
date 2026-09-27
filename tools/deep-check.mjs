// Playback-level check of every channel in the ROYS Hotel playlist.
//
// The GitHub / Cloudflare checkers prove a manifest and one segment can be
// fetched. This one actually decodes ~10 s of each channel with ffmpeg and
// measures what a viewer would see and hear, so it can stand in for a person
// flipping through channels:
//   video  - frames decode, picture is not black/white, and it moves
//   audio  - a track exists and is not silent
//   size   - resolution reported (warns below 480 lines)
//
// Run it from the hotel laptop (inside Thailand, ffmpeg on PATH):
//   node tools/deep-check.mjs                 all channels
//   node tools/deep-check.mjs "Channel 8" GMM25   only channels whose name contains an argument
//   PLAYLIST_URL=... to check another playlist.
//
// Exit code: 0 all pass (warnings allowed), 1 at least one FAIL, 2 could not run.
// It cannot reproduce a Samsung TV's own player quirks (redirect handling,
// variant choice, HDCP); a person on a real TV is still the last word there.

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const PLAYLIST = process.env.PLAYLIST_URL || "https://atsawinohio-dot.github.io/steam-hotel-stream/iptv.m3u8";
const SECONDS = 10;
const HARD_TIMEOUT_MS = 75_000;
const CONCURRENCY = 6;
const SILENT_MEAN_DB = -55;   // volumedetect mean below this = silence
const MIN_MOTION = 0.05;      // max YDIF between sampled frames; below = frozen/still
// ffmpeg itself refuses these even though they play fine (verified by downloading
// a segment by hand): Toon Goggles' Amagi ad-insertion segment URLs do not end in
// .ts, which ffmpeg's HLS demuxer rejects ("Empty segment"). The GitHub segment
// check covers them instead.
const FFMPEG_CANNOT_READ = new Set(["Toon Goggles"]);
const args = process.argv.slice(2);

async function loadChannels() {
  const text = await (await fetch(PLAYLIST)).text();
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXTINF")) continue;
    const name = lines[i].slice(lines[i].lastIndexOf(",") + 1).trim();
    const url = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
    if (url) out.push({ name, url: url.trim() });
  }
  return out;
}

function probe(url) {
  return new Promise((resolve) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-nostdin", "-t", String(SECONDS), "-i", url,
      "-vf", "fps=1,signalstats,metadata=print:file=-",
      "-af", "volumedetect", "-f", "null", "-",
    ]);
    let out = "", err = "";
    const t = setTimeout(() => ff.kill("SIGKILL"), HARD_TIMEOUT_MS);
    ff.stdout.on("data", (d) => (out += d));
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", (e) => { clearTimeout(t); resolve({ spawnError: e.message }); });
    ff.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

function judge(r) {
  if (r.spawnError) return { level: "ERROR", notes: [`ffmpeg: ${r.spawnError}`] };
  const notes = [];
  const yavg = [...r.out.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => +m[1]);
  const ydif = [...r.out.matchAll(/lavfi\.signalstats\.YDIF=([\d.]+)/g)].map((m) => +m[1]);
  const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.err);
  const hasAudio = /Stream #\d+:\d+.*Audio:/.test(r.err);
  const size = /Stream #\d+:\d+.*Video:.*?(\d{3,4})x(\d{3,4})/.exec(r.err);
  const height = size ? +size[2] : 0;
  let fail = false, warn = false;

  if (yavg.length < 3) { fail = true; notes.push(`มีภาพน้อยเกินไป (${yavg.length} เฟรม)`); }
  else {
    const dark = yavg.filter((y) => y < 10).length, white = yavg.filter((y) => y > 245).length;
    if (dark > yavg.length * 0.8) { fail = true; notes.push("ภาพดำ"); }
    else if (white > yavg.length * 0.8) { fail = true; notes.push("ภาพขาวโพลน"); }
    if (ydif.length > 1 && Math.max(...ydif.slice(1)) < MIN_MOTION) { warn = true; notes.push("ภาพนิ่งตลอด 10 วิ (อาจค้างหรือเป็นภาพนิ่งจริง)"); }
  }
  if (!hasAudio) { fail = true; notes.push("ไม่มีแทร็กเสียง"); }
  else if (!mean || mean[1] === "-inf" || +mean[1] < SILENT_MEAN_DB) { fail = true; notes.push(`เสียงเงียบ (${mean ? mean[1] : "?"} dB)`); }
  if (height && height < 480) { warn = true; notes.push(`ความละเอียดต่ำ (${height}p)`); }
  const errs = (r.err.match(/\b(error while decoding|Invalid data found|corrupt|non monotonically)/gi) || []).length;
  if (errs > 20) { warn = true; notes.push(`มีข้อผิดพลาดตอนถอดรหัส ${errs} ครั้ง`); }
  if (r.code !== 0 && !fail) { fail = true; notes.push(`ffmpeg จบผิดปกติ (code ${r.code})`); }

  const info = `${height ? height + "p" : "?"} · เสียง ${mean ? mean[1] : "-"} dB · เคลื่อนไหวสูงสุด ${ydif.length > 1 ? Math.max(...ydif.slice(1)).toFixed(2) : "-"}`;
  return { level: fail ? "FAIL" : warn ? "WARN" : "PASS", notes, info };
}

let channels;
try { channels = await loadChannels(); } catch (e) { console.error("โหลดเพลย์ลิสต์ไม่ได้:", e.message); process.exit(2); }
if (args.length) channels = channels.filter((c) => args.some((a) => c.name.toLowerCase().includes(a.toLowerCase())));
if (!channels.length) { console.error("ไม่มีช่องที่ตรงเงื่อนไข"); process.exit(2); }

const results = [];
let next = 0;
async function worker() {
  while (next < channels.length) {
    const ch = channels[next++];
    if (FFMPEG_CANNOT_READ.has(ch.name)) {
      results.push({ ...ch, level: "SKIP", notes: ["ffmpeg อ่านช่องนี้ไม่ได้ (ข้อจำกัดของ ffmpeg) ใช้ตัวตรวจ segment แทน"], info: "" });
      continue;
    }
    const j = judge(await probe(ch.url));
    results.push({ ...ch, ...j });
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, channels.length) }, worker));
results.sort((a, b) => channels.findIndex((c) => c.name === a.name) - channels.findIndex((c) => c.name === b.name));

const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).slice(0, 16);
for (const r of results) {
  const tag = { PASS: "ok  ", WARN: "WARN", FAIL: "FAIL", ERROR: "ERR ", SKIP: "skip" }[r.level];
  console.log(`${tag}  ${r.name}  —  ${r.info || ""}${r.notes.length ? "  ⚠ " + r.notes.join("; ") : ""}`);
}
const fails = results.filter((r) => r.level === "FAIL" || r.level === "ERROR");
const warns = results.filter((r) => r.level === "WARN");
const summary = `${stamp} PLAYBACK ${results.filter((r) => r.level === "PASS" || r.level === "WARN").length}/${results.length - results.filter((r) => r.level === "SKIP").length} pass` +
  (fails.length ? ` — FAIL: ${fails.map((r) => `${r.name} (${r.notes.join(", ")})`).join("; ")}` : "") +
  (warns.length ? ` — WARN: ${warns.map((r) => r.name).join(", ")}` : "");
console.log("\n" + summary);
try { appendFileSync(new URL("../../deep-check.log", import.meta.url), summary + "\n"); } catch {}
process.exit(fails.length ? 1 : 0);
