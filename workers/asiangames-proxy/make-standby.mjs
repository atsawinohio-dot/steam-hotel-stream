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

// Backdrop built from the emblem's own palette — the purple and gold of the
// Aichi-Nagoya mark over deep navy — rather than an official key visual,
// which is someone else's artwork. Diagonal gradient, the emblem again as a
// large faint watermark, and a gold rule under the header.
// `gradients` is a source filter — it generates its own frame and must not be
// given an input pad.
filters.push(
  "gradients=s=1920x1080:c0=0x241357:c1=0x08131F:x0=0:y0=0:x1=1920:y1=1080:nb_colors=2,format=rgba[grad]"
);
// Oversized, barely-there emblem bleeding off the right edge.
// Positioned so the twin swooshes fall in the right third and the red sun and
// wordmark sit off-canvas — a partial sun reads as a screen defect on a TV.
filters.push("[1:v]scale=-1:1650,format=rgba,colorchannelmixer=aa=0.09[ghost]");
filters.push("[grad][ghost]overlay=1120:-330[washed]");
// Gold rule, echoing the emblem's gold stroke.
filters.push(
  "[washed]drawbox=x=660:y=598:w=600:h=3:color=0xC9A227@0.85:t=fill[ruled]"
);

// Emblem, centred near the top, on a light panel — the emblem's own
// "Aichi-Nagoya 2026" wordmark is dark and disappears against the navy.
filters.push("[ruled]drawbox=x=826:y=30:w=268:h=286:color=white@0.94:t=fill[panel]");
filters.push("[0:v]scale=-1:250[logo]");
filters.push("[panel][logo]overlay=(W-w)/2:48[bg]");

// Panel ends at y=316; everything below is laid out from there so the title
// never rides up under the emblem.
let chain = [];
chain.push(drawtext({ text: "ASIAN GAMES 2026", x: "(w-text_w)/2", y: 356, size: 72 }));
chain.push(
  drawtext({
    text: "ไม่มีการถ่ายทอดสดขณะนี้",
    x: "(w-text_w)/2",
    y: 458,
    size: 46,
    color: "0xFFD166",
  })
);
chain.push(
  drawtext({
    text: `ตารางถ่ายทอดสดทีมชาติไทย · ${schedule.date}`,
    x: "(w-text_w)/2",
    y: 540,
    size: 38,
    color: "0xBBC7D9",
  })
);

let y = 624;
for (const [time, event, channel] of schedule.rows) {
  chain.push(drawtext({ text: time, x: 420, y, size: 40, color: "0x7FD1FF" }));
  chain.push(drawtext({ text: event, x: 560, y, size: 40 }));
  chain.push(drawtext({ text: channel, x: 1360, y, size: 36, color: "0xBBC7D9" }));
  y += 60;
}

chain.push(
  drawtext({
    text: "ช่องจะสลับไปยังผู้ถ่ายทอดโดยอัตโนมัติเมื่อถึงเวลาแข่ง",
    x: "(w-text_w)/2",
    y: 1006,
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
    "-i", LOGO,
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
// Every repeat is the same file, so its timestamps restart each time. Without
// a discontinuity marker the player sees time jump backwards and stalls on a
// spinner after the first loop — the ROYS HOTEL channel's playlist marks its
// repeats the same way.
for (let i = 0; i < repeats; i++) {
  if (i > 0) lines.push("#EXT-X-DISCONTINUITY");
  lines.push(`#EXTINF:${SEG_SECONDS}.000000,`);
  lines.push("standby0.ts");
}
lines.push("#EXT-X-ENDLIST", "");
writeFileSync(join(OUT_DIR, "standby.m3u8"), lines.join("\n"));

console.log(`card:     ${cardPath}`);
console.log(`segment:  ${segPath}`);
console.log(`playlist: ${join(OUT_DIR, "standby.m3u8")} (${repeats} entries, ~${LOOP_HOURS}h)`);
