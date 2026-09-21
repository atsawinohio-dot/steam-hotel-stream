// Builds channel 21's standby stream: the Asian Games emblem plus the day's
// Thai-team broadcast schedule, as a looping HLS stream on GitHub Pages.
//
// Channel 21 follows whichever broadcaster has the Thai team, but for most of
// the day nobody is carrying the games, and parking the channel on some
// broadcaster's unrelated regular programming is confusing. This is what it
// shows instead.
//
// The schedule changes daily, so the picker task regenerates this each morning
// and commits the result. Usage:
//   node make-standby.mjs schedule.json
// where schedule.json is { "date": "21 ก.ย. 69", "rows": [["14:00","วอลเลย์บอลหญิง ไทย-จีน","PPTV HD 36"], ...] }
// Omit the argument to rebuild from the committed schedule.json.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "..", "..", "asiangames-standby");
const LOGO = join(here, "asiangames-logo.png");
// Leelawadee — shapes Thai correctly. The drive-letter colon has to be escaped
// or the filtergraph parser reads it as an option separator and bails.
const FONT = "C\\:/Windows/Fonts/leelawad.ttf";
const SEG_SECONDS = 6;
// Enough repeats to cover a long idle stretch; the picker refreshes the pick
// every couple of hours anyway, so this only has to outlast a quiet evening.
const LOOP_HOURS = 6;

const scheduleFile = process.argv[2] || join(OUT_DIR, "schedule.json");
const schedule = JSON.parse(readFileSync(scheduleFile, "utf8"));

// ffmpeg's drawtext treats these as syntax, so they can't appear raw in text.
function esc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/%/g, "\\%");
}

function drawtext({ text, x, y, size, color = "white", font = FONT }) {
  return [
    `drawtext=fontfile='${font}'`,
    `text='${esc(text)}'`,
    `x=${x}`,
    `y=${y}`,
    `fontsize=${size}`,
    `fontcolor=${color}`,
  ].join(":");
}

const filters = [];
// Emblem, centred near the top, on a light panel — the emblem's own
// "Aichi-Nagoya 2026" wordmark is dark and disappears against the navy.
filters.push("[0:v]drawbox=x=812:y=40:w=296:h=360:color=white@0.94:t=fill[panel]");
filters.push("[1:v]scale=-1:300[logo]");
filters.push("[panel][logo]overlay=(W-w)/2:70[bg]");

let chain = [];
chain.push(drawtext({ text: "ASIAN GAMES 2026", x: "(w-text_w)/2", y: 400, size: 76 }));
chain.push(
  drawtext({
    text: "ไม่มีการถ่ายทอดสดขณะนี้",
    x: "(w-text_w)/2",
    y: 500,
    size: 46,
    color: "0xFFD166",
  })
);
chain.push(
  drawtext({
    text: `ตารางถ่ายทอดสดทีมชาติไทย · ${schedule.date}`,
    x: "(w-text_w)/2",
    y: 585,
    size: 38,
    color: "0xBBC7D9",
  })
);

let y = 665;
for (const [time, event, channel] of schedule.rows) {
  chain.push(drawtext({ text: time, x: 420, y, size: 40, color: "0x7FD1FF" }));
  chain.push(drawtext({ text: event, x: 560, y, size: 40 }));
  chain.push(drawtext({ text: channel, x: 1360, y, size: 36, color: "0xBBC7D9" }));
  y += 62;
}

chain.push(
  drawtext({
    text: "ช่องจะสลับไปยังผู้ถ่ายทอดโดยอัตโนมัติเมื่อถึงเวลาแข่ง",
    x: "(w-text_w)/2",
    y: 1000,
    size: 32,
    color: "0x8FA3BF",
  })
);

filters.push(`[bg]${chain.join(",")}[out]`);

mkdirSync(OUT_DIR, { recursive: true });
const cardPath = join(OUT_DIR, "card.png");

// The filtergraph goes through a UTF-8 file, not the command line: Node hands
// argv to Windows in the system codepage, which mangles every Thai string into
// a filter ffmpeg can't parse.
const graphPath = join(OUT_DIR, ".filtergraph.txt");
writeFileSync(graphPath, filters.join(";"), "utf8");

execFileSync(
  "ffmpeg",
  [
    "-y",
    "-f", "lavfi", "-i", "color=c=0x0B1A2E:s=1920x1080",
    "-i", LOGO,
    "-filter_complex_script", graphPath,
    "-map", "[out]",
    "-frames:v", "1",
    cardPath,
  ],
  { stdio: "inherit" }
);

// One segment of the still card, with a silent audio track — players that
// expect audio can stall on a video-only stream.
const segPath = join(OUT_DIR, "standby0.ts");
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-loop", "1", "-i", cardPath,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-t", String(SEG_SECONDS),
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
    "-pix_fmt", "yuv420p", "-r", "25", "-g", "50",
    "-c:a", "aac", "-b:a", "64k",
    "-f", "mpegts",
    segPath,
  ],
  { stdio: "inherit" }
);

const repeats = Math.round((LOOP_HOURS * 3600) / SEG_SECONDS);
const lines = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  `#EXT-X-TARGETDURATION:${SEG_SECONDS}`,
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-PLAYLIST-TYPE:VOD",
];
for (let i = 0; i < repeats; i++) {
  lines.push(`#EXTINF:${SEG_SECONDS}.000000,`);
  lines.push("standby0.ts");
}
lines.push("#EXT-X-ENDLIST", "");
writeFileSync(join(OUT_DIR, "standby.m3u8"), lines.join("\n"));

console.log(`card:     ${cardPath}`);
console.log(`segment:  ${segPath}`);
console.log(`playlist: ${join(OUT_DIR, "standby.m3u8")} (${repeats} entries, ~${LOOP_HOURS}h)`);
