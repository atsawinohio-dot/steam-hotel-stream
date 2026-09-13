// จูนภาพช่อง 21 อัตโนมัติ — วัดจากภาพที่ออกอากาศจริง ไม่ใช่เดาด้วยตา
//
//   node tune-image.mjs            วัดอย่างเดียว เสนอค่าที่ควรใช้ แล้วคืนค่าเดิมให้หมด
//   node tune-image.mjs --apply    วัดแล้วตั้งค่าให้เลย
//
// ต้องเปิด OBS ไว้ (ไม่ต้องออกอากาศ) เพราะตัวนี้ขอภาพจาก OBS ผ่าน obs-websocket
// ภาพที่วัดคือฉาก Event ทั้งฉาก = ผ่านฟิลเตอร์ครบเหมือนที่ผู้ชมเห็นจริง
//
// วิธีทำงาน: ไล่หาค่า gamma ด้วยการแบ่งครึ่ง จนความสว่างเฉลี่ย (YAVG) เข้าเป้า
// ถ้าส่วนสว่างล้น (YHIGH สูงเกิน) จะลด contrast แล้วไล่หาใหม่
//
// เป้าหมายมาจาก CLAUDE.md: YAVG 140-170, YHIGH ไม่เกิน ~225
//
// ทำไมถึงปรับ gamma ไม่ใช่ brightness — วัดกับกล้องตัวนี้มาแล้ว (2026-09-13):
//   gamma      0 -> 1.5   ความสว่าง 26 -> 71   ระดับดำยังอยู่ที่ 16 (สีดำยังดำ)
//   brightness 0 -> 0.3   ความสว่าง 26 -> 145  ระดับดำพุ่งเป็น 143 (ภาพกลายเป็นฝ้าเทา)
//   contrast   ทั้งช่วง   ความสว่าง 23 -> 34   ใช้คุมส่วนสว่างเท่านั้น
// brightness บวกค่าตรง ๆ ทั้งภาพ จึงทำลายสีดำ ตัวนี้เลยตรึง brightness ไว้ที่ 0

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const OBS_WS_CONFIG = path.join(process.env.APPDATA, "obs-studio", "plugin_config", "obs-websocket", "config.json");
const SCENE = "Event";
const CAMERA_INPUT = "กล้อง USB";
const COLOR_FILTER = "ปรับสี";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const num = (flag, dflt) => {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? Number(hit.split("=")[1]) : dflt;
};
const TARGET_YAVG = num("--target", 155);
const MAX_YHIGH = num("--max-high", 225);
// เพดาน noise ขั้นต่ำ (ความต่างเฉลี่ยระหว่างสองเฟรมติดกัน) ถ้าภาพเดิมเงียบมากก็ยังยอมให้ถึงค่านี้ได้
const MAX_NOISE = num("--max-noise", 2.0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(a.join(" "));

// ------------------------------------------------------------------ OBS ----
// เชื่อม obs-websocket v5 แบบเดียวกับ agent.mjs
class Obs {
  constructor() { this.ws = null; this.pending = new Map(); this.nextId = 1; }

  connect() {
    const cfg = JSON.parse(readFileSync(OBS_WS_CONFIG, "utf8").replace(/^﻿/, ""));
    if (!cfg.server_enabled) return Promise.reject(new Error("obs-websocket ถูกปิดอยู่ (รัน setup-control.ps1)"));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${cfg.server_port}`, "obswebsocket.json");
      const giveUp = setTimeout(() => { ws.close(); reject(new Error("OBS ไม่ตอบ — เปิด OBS ไว้หรือยัง")); }, 5000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.op === 0) {
          const d = { rpcVersion: 1, eventSubscriptions: 0 };
          const auth = msg.d.authentication;
          if (auth) {
            const secret = createHash("sha256").update(cfg.server_password + auth.salt).digest("base64");
            d.authentication = createHash("sha256").update(secret + auth.challenge).digest("base64");
          }
          ws.send(JSON.stringify({ op: 1, d }));
        } else if (msg.op === 2) {
          clearTimeout(giveUp); this.ws = ws; resolve();
        } else if (msg.op === 7) {
          const p = this.pending.get(msg.d.requestId);
          if (!p) return;
          this.pending.delete(msg.d.requestId);
          if (msg.d.requestStatus.result) p.resolve(msg.d.responseData || {});
          else p.reject(new Error(msg.d.requestStatus.comment || `${msg.d.requestType} ไม่สำเร็จ`));
        }
      };
      ws.onclose = () => {
        clearTimeout(giveUp); this.ws = null;
        for (const p of this.pending.values()) p.reject(new Error("OBS ตัดการเชื่อมต่อ"));
        this.pending.clear();
        reject(new Error("OBS ปิดการเชื่อมต่อ"));
      };
      ws.onerror = () => {};
    });
  }

  request(requestType, requestData = {}) {
    if (!this.ws) return Promise.reject(new Error("ยังไม่ได้เชื่อม OBS"));
    const requestId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${requestType} หมดเวลา`)); }, 15000);
      this.pending.set(requestId, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  close() { if (this.ws) this.ws.close(); }
}

// -------------------------------------------------------------- วัดภาพ ----
const work = mkdtempSync(path.join(tmpdir(), "roys-tune-"));
let shotNo = 0;

function ffprobeStats(file) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-v", "info", "-i", file, "-vf", "signalstats,metadata=print", "-f", "null", "-"],
      { windowsHide: true, maxBuffer: 1 << 24 },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`;
        const grab = (k) => {
          const m = out.match(new RegExp(`lavfi\\.signalstats\\.${k}=([\\d.]+)`));
          return m ? Number(m[1]) : null;
        };
        const y = grab("YAVG");
        if (y === null) return reject(new Error("อ่านค่าจากภาพไม่ได้: " + out.slice(-300)));
        resolve({ YAVG: y, YHIGH: grab("YHIGH"), YLOW: grab("YLOW"), YMIN: grab("YMIN"), YMAX: grab("YMAX"), SATAVG: grab("SATAVG"), SATMAX: grab("SATMAX") });
      }
    );
  });
}

async function grabShot(obs) {
  const { imageData } = await obs.request("GetSourceScreenshot", {
    sourceName: SCENE, imageFormat: "png", imageWidth: 1280, imageHeight: 720,
  });
  const file = path.join(work, `shot-${shotNo++}.png`);
  writeFileSync(file, Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ""), "base64"));
  return file;
}

// ความต่างระหว่างสองเฟรมติดกัน = noise ของภาพ
// จำเป็นเพราะการดัน gamma ในห้องมืดทำให้ noise กลายเป็นจุดสีทั้งจอ
// ทั้งที่ตัวเลขความสว่างยังดูดี — วัดความสว่างอย่างเดียวจึงตัดสินไม่ได้
function frameDiff(a, b) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-v", "info", "-i", a, "-i", b,
       "-filter_complex", "blend=all_mode=difference,signalstats,metadata=print", "-f", "null", "-"],
      { windowsHide: true, maxBuffer: 1 << 24 },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`;
        const m = out.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
        if (!m) return reject(new Error("วัด noise ไม่ได้"));
        resolve(Number(m[1]));
      }
    );
  });
}

async function measure(obs, withNoise = true) {
  const file = await grabShot(obs);
  const stats = await ffprobeStats(file);
  let noise = null;
  if (withNoise) {
    await sleep(250);
    const second = await grabShot(obs);
    noise = await frameDiff(file, second);
  }
  return { file, noise, ...stats };
}

// -------------------------------------------------------------- ไล่หาค่า ----
async function setColor(obs, settings) {
  await obs.request("SetSourceFilterSettings", {
    sourceName: CAMERA_INPUT, filterName: COLOR_FILTER, filterSettings: settings, overlay: true,
  });
  await sleep(350); // ให้ OBS เรนเดอร์เฟรมใหม่ก่อนถ่ายภาพ
}

// หา gamma สูงสุดที่ยังไม่ทำให้ภาพเต็มไปด้วย noise
// ต้องทำก่อนไล่หาความสว่าง เพราะในห้องมืดการดัน gamma จะได้ตัวเลขความสว่างที่ดู
// เข้าเป้า แต่ภาพจริงเป็นจุดสีรบกวนทั้งจอ
async function findGammaCeiling(obs, base, noiseLimit, satLimit) {
  let ceiling = 0;
  for (const g of [0.4, 0.8, 1.2, 1.6, 2.0, 2.5, 3.0]) {
    await setColor(obs, { ...base, gamma: g });
    const m = await measure(obs);
    const noisy = m.noise > noiseLimit;
    const blotchy = m.SATMAX > satLimit;
    const why = noisy ? "  << noise เกิน" : blotchy ? "  << สีเพี้ยนเกิน" : "";
    say(`   ตรวจที่ gamma ${g.toFixed(1)}  ->  noise ${m.noise.toFixed(2)}/${noiseLimit.toFixed(2)}  สีจัดสุด ${m.SATMAX.toFixed(0)}/${satLimit.toFixed(0)}  YAVG ${m.YAVG.toFixed(1)}${why}`);
    if (noisy || blotchy) break;
    ceiling = g;
  }
  return ceiling;
}

// gamma มากขึ้น = สว่างขึ้น (วัดยืนยันแล้ว) จึงไล่หาแบบปกติ
async function searchGamma(obs, base, lo, hi) {
  let best = null;
  for (let i = 0; i < 8; i++) {
    const gamma = (lo + hi) / 2;
    await setColor(obs, { ...base, gamma });
    const m = await measure(obs, false);
    say(`   ลอง gamma ${gamma.toFixed(3)}  ->  YAVG ${m.YAVG.toFixed(1)}  ระดับดำ ${m.YMIN}  YHIGH ${m.YHIGH?.toFixed(0)}`);
    if (!best || Math.abs(m.YAVG - TARGET_YAVG) < Math.abs(best.m.YAVG - TARGET_YAVG)) best = { gamma, m };
    if (Math.abs(m.YAVG - TARGET_YAVG) < 2) break;
    if (m.YAVG < TARGET_YAVG) lo = gamma; else hi = gamma;
  }
  return best;
}

// ---------------------------------------------------------------- main ----
const obs = new Obs();
let original = null;

try {
  await obs.connect();
  say("เชื่อม OBS ได้แล้ว");

  // กล้องส่งภาพอยู่จริงไหม — ดูขนาด source ไม่ใช่ GetSourceActive
  const { sceneItems } = await obs.request("GetSceneItemList", { sceneName: SCENE });
  const cam = sceneItems.find((i) => i.sourceName === CAMERA_INPUT);
  if (!cam) throw new Error(`ไม่พบ source '${CAMERA_INPUT}' ในฉาก ${SCENE}`);
  if (!cam.sceneItemEnabled) say("เตือน: source กล้องถูกซ่อนอยู่ในฉาก");

  const { sceneItemTransform: tf } = await obs.request("GetSceneItemTransform", {
    sceneName: SCENE, sceneItemId: cam.sceneItemId,
  });
  say(`กล้องส่งภาพขนาด ${tf.sourceWidth}x${tf.sourceHeight}`);
  if (!tf.sourceWidth) throw new Error("กล้องไม่ส่งภาพ (0x0) — ปิด Camo Studio แล้วเปิด OBS ใหม่");

  const cur = await obs.request("GetSourceFilter", { sourceName: CAMERA_INPUT, filterName: COLOR_FILTER });
  original = { ...cur.filterSettings };
  say(`ฟิลเตอร์ตอนนี้: ${JSON.stringify(original)}`);

  const before = await measure(obs);
  say("");
  say(`ก่อนจูน: YAVG ${before.YAVG.toFixed(1)}  ระดับดำ ${before.YMIN}  YHIGH ${before.YHIGH?.toFixed(0)}  YMAX ${before.YMAX?.toFixed(0)}  SATAVG ${before.SATAVG?.toFixed(1)}`);
  say(`ภาพตัวอย่าง: ${before.file}`);
  // ระดับดำควรอยู่แถว 16 (ขอบล่างของช่วงสัญญาณ) ถ้าสูงกว่านี้มากแปลว่าภาพมีฝ้าเทา
  if (before.YMIN > 30) {
    say(`เตือน: ระดับดำอยู่ที่ ${before.YMIN} (ควรใกล้ 16) — ภาพมีฝ้าเทา ไม่มีสีดำจริง`);
    say(`       สาเหตุเกือบทุกครั้งคือ brightness ในฟิลเตอร์ถูกตั้งเป็นบวก`);
  }
  say("");

  // ภาพมืดสนิทแปลว่าไฟไม่พอ/กล้องเล็งผิดที่ ไม่ใช่เรื่องที่ฟิลเตอร์แก้ได้
  if (before.YAVG < 25) {
    say("*** ภาพมืดเกินกว่าจะจูนด้วยฟิลเตอร์ ***");
    say(`ความสว่างเฉลี่ยแค่ ${before.YAVG.toFixed(1)}/255 — ดันด้วยฟิลเตอร์จะได้แต่ภาพเกรนหยาบ`);
    say("ต้องเปิดไฟส่องบริเวณที่กล้องจับ หรือหันกล้องไปทางที่มีแสงก่อน แล้วรันใหม่");
    process.exitCode = 2;
  } else {
    // brightness ตรึงไว้ที่ 0 เสมอ — มันบวกค่าทั้งภาพจนสีดำหาย ให้ gamma ทำหน้าที่เพิ่มความสว่างแทน
    if ((original.brightness ?? 0) !== 0) {
      say(`ตั้ง brightness จาก ${original.brightness} เป็น 0 (เป็นตัวที่ทำให้ภาพเป็นฝ้าเทา)`);
    }
    let base = {
      ...original,
      brightness: 0,
      contrast: original.contrast ?? 0,
      saturation: original.saturation ?? 0,
    };
    // วัด noise อ้างอิงที่ค่ากลาง (gamma 0, brightness 0) ไม่ใช่จากภาพเดิม
    // เพราะภาพเดิมถูก brightness อัดให้แบนจนบัง noise ไว้ ตัวเลขจะหลอก
    await setColor(obs, { ...base, gamma: 0 });
    const neutral = await measure(obs);
    const noiseLimit = Math.max(neutral.noise * 1.5, MAX_NOISE);
    // การดัน gamma ในที่มืดทำให้ noise สีในเงากลายเป็นปื้นม่วง ซึ่งเป็นคนละอาการกับ
    // noise ที่กระพริบระหว่างเฟรม — ปื้นสีนิ่งอยู่กับที่ ตัววัดความต่างระหว่างเฟรมจึงจับไม่ได้
    //
    // ต้องใช้ SATMAX (สีที่จัดที่สุดในภาพ) ไม่ใช่ SATAVG: วัดกับฉากผ้าม่านซีดแล้ว
    // SATAVG กลับ *ลดลง* ตอน gamma สูง (11.3 -> 10.3) เพราะผ้าม่านซีดกินพื้นที่
    // ส่วนใหญ่จนกลบปื้นม่วงที่อยู่ในเงา ขณะที่ SATMAX ไต่ตรง ๆ 32 -> 44 -> 60 -> 75
    const satLimit = Math.max(neutral.SATMAX * 1.25, 36);
    say(`noise ที่ค่ากลาง ${neutral.noise.toFixed(2)} (ภาพเดิมวัดได้ ${before.noise?.toFixed(2)} เพราะถูก brightness อัดจนแบน)`);
    say(`สีจัดสุดที่ค่ากลาง ${neutral.SATMAX.toFixed(0)}`);
    say(`เพดาน: noise ${noiseLimit.toFixed(2)} · สีจัดสุด ${satLimit.toFixed(0)}`);
    say("");
    say("หาเพดาน gamma ที่ภาพยังไม่เละ");
    const ceiling = await findGammaCeiling(obs, base, noiseLimit, satLimit);
    say(`เพดาน gamma = ${ceiling.toFixed(1)}`);
    say("");

    let best = null;
    if (ceiling === 0) {
      say("ดัน gamma ไม่ได้เลยโดยไม่ทำให้ภาพเละ — ห้องมืดเกินไป");
      await setColor(obs, { ...base, gamma: 0 });
      best = { gamma: 0, m: await measure(obs) };
    } else {
      for (let round = 0; round < 3; round++) {
        say(`ไล่หา gamma (รอบ ${round + 1}, contrast ${base.contrast.toFixed(2)})`);
        best = await searchGamma(obs, base, 0, ceiling);
        if (!best.m.YHIGH || best.m.YHIGH <= MAX_YHIGH) break;
        say(`   ส่วนสว่างล้น (YHIGH ${best.m.YHIGH.toFixed(1)} > ${MAX_YHIGH}) — ลด contrast แล้วไล่ใหม่`);
        base = { ...base, contrast: Math.round((base.contrast - 0.08) * 100) / 100 };
      }
    }

    const final = { ...base, gamma: Math.round(best.gamma * 100) / 100 };
    // วัดภาพสุดท้ายพร้อม noise อีกรอบ เพื่อรายงานของจริง ไม่ใช่ค่าที่ค้างจากตอนไล่หา
    await setColor(obs, final);
    const after = await measure(obs);
    say("");
    say("=================== ผลลัพธ์ ===================");
    say(`ค่าที่ควรใช้: gamma ${final.gamma}  contrast ${final.contrast}  saturation ${final.saturation}  brightness ${final.brightness}`);
    say(`ได้ภาพที่ YAVG ${after.YAVG.toFixed(1)} (เป้า ${TARGET_YAVG})  ระดับดำ ${after.YMIN}  YHIGH ${after.YHIGH?.toFixed(0)} (ไม่เกิน ${MAX_YHIGH})  noise ${after.noise?.toFixed(2)}  สีจัดสุด ${after.SATMAX?.toFixed(0)}`);
    if (after.YAVG < TARGET_YAVG - 15) {
      say("");
      say(`*** ยังสว่างไม่ถึงเป้า (${after.YAVG.toFixed(0)} จาก ${TARGET_YAVG}) ***`);
      say("ดันด้วยฟิลเตอร์มากกว่านี้ไม่ได้แล้ว เพราะภาพจะเต็มไปด้วยจุดสีรบกวน");
      say("ทางแก้จริงคือเพิ่มไฟส่องบริเวณที่กล้องจับ (To-do ข้อ 4 ใน CLAUDE.md)");
    }
    say(`ภาพตัวอย่างหลังจูน: ${after.file}`);
    best.m = after;

    if (APPLY) {
      await setColor(obs, final);
      original = null; // ตั้งใจให้ค่าใหม่อยู่ต่อ
      say("");
      say("ตั้งค่าให้เรียบร้อยแล้ว — อย่าลืมอัปเดตตาราง 'ค่าภาพฝั่ง OBS' ใน CLAUDE.md");
    } else {
      say("");
      say("ยังไม่ได้ตั้งค่าให้ (รันด้วย --apply ถ้าจะเอาค่านี้จริง)");
    }
  }
} catch (e) {
  say("ล้มเหลว: " + e.message);
  process.exitCode = 1;
} finally {
  // ไม่ว่าจะพังตรงไหน ต้องคืนฟิลเตอร์เป็นค่าเดิมเสมอ
  if (original && obs.ws) {
    try {
      await obs.request("SetSourceFilterSettings", {
        sourceName: CAMERA_INPUT, filterName: COLOR_FILTER, filterSettings: original, overlay: false,
      });
      say("คืนค่าฟิลเตอร์เดิมแล้ว");
    } catch (e) { say("คืนค่าฟิลเตอร์เดิมไม่สำเร็จ: " + e.message); }
  }
  obs.close();
  if (!process.env.ROYS_KEEP_SHOTS) rmSync(work, { recursive: true, force: true });
}
