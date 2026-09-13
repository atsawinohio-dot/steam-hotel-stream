// ROYS Event control agent — runs on the hotel laptop during events.
//
// It lets the owner run channel 21 from the /control page on their phone:
// every few seconds it asks the steam-hotel-event worker for commands
// (start/stop, mic, standby screen), carries them out through OBS's built-in
// obs-websocket, and reports back what OBS, the RTMP receiver and Camo are
// doing, plus a small preview image. The laptop only makes outbound HTTPS
// calls, so nothing on the router or Windows Firewall needs opening.
//
// Start it with "ROYS Event Control.bat" (outside the repo). It replaces
// start-event.ps1 for remote-controlled events — don't run both, they would
// fight over the RTMP port.

import { spawn, execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const BASE = "https://steam-hotel-event.tiny-hall-8718.workers.dev";
const TOKEN_FILE = "E:\\Steam Hotel\\event-ingest-token.txt";
const OBS_DIR = "C:\\Program Files\\obs-studio\\bin\\64bit";
const OBS_PROFILE = "ROYS Event";
const OBS_COLLECTION = "ROYS Event";
const CAMERA_SCENE = "Event";
const STANDBY_SCENE = "พักรอ";
const MIC_INPUT = "ไมค์มือถือ (Camo)";
const RTMP_IN = "rtmp://127.0.0.1:1935/live/event";
const OBS_WS_CONFIG = path.join(process.env.APPDATA, "obs-studio", "plugin_config", "obs-websocket", "config.json");
const CAMO_LOG_DIR = path.join(
  process.env.LOCALAPPDATA,
  "Packages", "ReincubateLtd.CamoStudio_9bq3v28c93p4r", "LocalCache", "Roaming", "Reincubate", "Camo", "Logs"
);
const CAMO_APP = "shell:AppsFolder\\ReincubateLtd.CamoStudio_9bq3v28c93p4r!App";
const VERSION = 1;

const token = readFileSync(TOKEN_FILE, "utf8").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString("th-TH", { hour12: false });
const log = (...a) => console.log(`[${stamp()}]`, ...a);

function isRunning(image) {
  return new Promise((resolve) =>
    execFile("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH", "/FO", "CSV"], { windowsHide: true }, (err, out) =>
      resolve(!err && out.toLowerCase().includes(`"${image.toLowerCase()}"`))
    )
  );
}

// ---------------------------------------------------------------- OBS ----

class Obs {
  constructor() {
    this.ws = null;
    this.pending = new Map();
    this.nextId = 1;
    this.micPeak = 0; // loudest mic peak (linear) since the last status report
  }

  get connected() {
    return this.ws !== null;
  }

  connect() {
    const cfg = JSON.parse(readFileSync(OBS_WS_CONFIG, "utf8").replace(/^\uFEFF/, ""));
    if (!cfg.server_enabled) return Promise.reject(new Error("obs-websocket ถูกปิดอยู่ (รัน setup-control.ps1)"));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${cfg.server_port}`, "obswebsocket.json");
      const giveUp = setTimeout(() => { ws.close(); reject(new Error("OBS ไม่ตอบ")); }, 5000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.op === 0) {
          // Hello → Identify. Auth per the obs-websocket v5 spec:
          // base64(sha256(base64(sha256(password + salt)) + challenge)).
          const d = { rpcVersion: 1, eventSubscriptions: 1 << 16 }; // InputVolumeMeters only
          const auth = msg.d.authentication;
          if (auth) {
            const secret = createHash("sha256").update(cfg.server_password + auth.salt).digest("base64");
            d.authentication = createHash("sha256").update(secret + auth.challenge).digest("base64");
          }
          ws.send(JSON.stringify({ op: 1, d }));
        } else if (msg.op === 2) {
          clearTimeout(giveUp);
          this.ws = ws;
          resolve();
        } else if (msg.op === 7) {
          const p = this.pending.get(msg.d.requestId);
          if (!p) return;
          this.pending.delete(msg.d.requestId);
          if (msg.d.requestStatus.result) p.resolve(msg.d.responseData || {});
          else p.reject(new Error(msg.d.requestStatus.comment || `${msg.d.requestType} ไม่สำเร็จ`));
        } else if (msg.op === 5 && msg.d.eventType === "InputVolumeMeters") {
          for (const input of msg.d.eventData.inputs) {
            if (input.inputName !== MIC_INPUT) continue;
            for (const ch of input.inputLevelsMul || []) this.micPeak = Math.max(this.micPeak, ch[1] || 0);
          }
        }
      };
      ws.onclose = () => {
        clearTimeout(giveUp);
        this.ws = null;
        for (const p of this.pending.values()) p.reject(new Error("OBS ตัดการเชื่อมต่อ"));
        this.pending.clear();
        reject(new Error("OBS ปิดการเชื่อมต่อ"));
      };
      ws.onerror = () => {}; // onclose follows
    });
  }

  request(requestType, requestData = {}) {
    if (!this.ws) return Promise.reject(new Error("ยังไม่ได้เชื่อม OBS"));
    const requestId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${requestType} หมดเวลา`)); }, 10000);
      this.pending.set(requestId, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  takeMicDb() {
    const peak = this.micPeak;
    this.micPeak = 0;
    return peak > 0 ? Math.round(20 * Math.log10(peak) * 10) / 10 : -100;
  }
}

const obs = new Obs();

async function ensureObs({ launch }) {
  if (obs.connected) return true;
  let running = await isRunning("obs64.exe");
  if (!running && launch) {
    log("เปิด OBS (โปรไฟล์ ROYS Event)…");
    spawn(path.join(OBS_DIR, "obs64.exe"), ["--profile", OBS_PROFILE, "--collection", OBS_COLLECTION, "--disable-shutdown-check"], {
      cwd: OBS_DIR, detached: true, stdio: "ignore",
    }).unref();
    running = true;
  }
  if (!running) return false;
  for (let i = 0; i < (launch ? 15 : 1); i++) {
    try {
      await obs.connect();
      log("เชื่อม OBS แล้ว");
      await ensureStandbyScene();
      return true;
    } catch {
      if (launch) await sleep(2000);
    }
  }
  return obs.connected;
}

// The standby card is built through the API rather than by editing the scene
// file, so it can't collide with whatever someone last saved in OBS.
async function ensureStandbyScene() {
  const { scenes } = await obs.request("GetSceneList");
  if (scenes.some((s) => s.sceneName === STANDBY_SCENE)) return;
  log("สร้างฉาก “พักรอ” ใน OBS");
  await obs.request("CreateScene", { sceneName: STANDBY_SCENE });
  await obs.request("CreateInput", {
    sceneName: STANDBY_SCENE, inputName: "พื้นหลังพักรอ", inputKind: "color_source_v3",
    inputSettings: { color: 0xff33200b, width: 1920, height: 1080 }, // ABGR: deep navy
  });
  const { sceneItemId } = await obs.request("CreateInput", {
    sceneName: STANDBY_SCENE, inputName: "ข้อความพักรอ", inputKind: "text_gdiplus_v3",
    inputSettings: {
      text: "ROYS Hotel\nพักสักครู่ เดี๋ยวกลับมา\nBe right back", align: "center",
      font: { face: "Tahoma", size: 96, style: "Bold", flags: 1 }, color: 0xffffffff,
    },
  });
  await obs.request("SetSceneItemTransform", {
    sceneName: STANDBY_SCENE, sceneItemId,
    sceneItemTransform: { alignment: 0, positionX: 960, positionY: 540 },
  });
}

// ------------------------------------------------------- RTMP receiver ----

let listener = null;
let wantLive = false;

async function clearChannel() {
  try {
    await fetch(`${BASE}/live/`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    log("ล้างช่องไม่สำเร็จ:", e.message);
  }
}

function startListener() {
  if (listener) return;
  const args = [
    "-hide_banner", "-loglevel", "error", "-listen", "1", "-i", RTMP_IN, "-c", "copy",
    "-f", "hls", "-hls_time", "6", "-hls_list_size", "6", "-method", "PUT", "-http_persistent", "1",
    "-headers", `Authorization: Bearer ${token}\r\n`,
    "-hls_segment_filename", `${BASE}/live/seg_%06d.ts`, `${BASE}/live/index.m3u8`,
  ];
  listener = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  listener.stderr.on("data", (d) => {
    const line = d.toString().trim();
    if (line) log("ffmpeg:", line.split("\n")[0].slice(0, 160));
  });
  listener.on("exit", async () => {
    listener = null;
    if (wantLive) {
      // OBS lost the connection (Wi-Fi blip, OBS restart). OBS reconnects on
      // its own, so just be listening again when it does.
      await sleep(1000);
      if (wantLive) startListener();
    } else {
      await clearChannel();
      log("ช่อง 21 หยุดออกอากาศแล้ว");
    }
  });
}

// ------------------------------------------------------------- Camo ----

// Camo Studio has no API; its log is the only place that says whether the
// phone is connected. Best effort: find the latest connect/disconnect line.
function camoStatus() {
  try {
    const files = readdirSync(CAMO_LOG_DIR).filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, t: statSync(path.join(CAMO_LOG_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    if (!files.length) return { connected: false };
    const file = path.join(CAMO_LOG_DIR, files[0].f);
    const size = statSync(file).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    let connected = false, device = null;
    for (const line of buf.toString("utf8").split("\n")) {
      if (/WirelessConnection\] Using protocol version|Activating newly added device '(?!USB)/.test(line)) connected = true;
      if (/Disconnected, app closed or device unplugged|Device disconnected '(?!USB)/.test(line)) connected = false;
      const m = line.match(/WirelessConnection\] \([^:]+: ([^)]+)\)/) || line.match(/newly added device '([^']+)'/);
      if (m && !m[1].startsWith("USB")) device = m[1];
    }
    return { connected, device };
  } catch {
    return { connected: false };
  }
}

// ----------------------------------------------------------- commands ----

const ACTION_TH = { start: "เริ่มถ่ายทอดสด", stop: "หยุดถ่ายทอดสด", mute: "ปิดไมค์", unmute: "เปิดไมค์", standby: "ภาพพักรอ", camera: "กลับไปที่กล้อง" };

async function run(action) {
  log("คำสั่งจากมือถือ:", ACTION_TH[action] || action);
  if (action === "start") {
    if (!(await isRunning("CamoStudio.exe"))) {
      spawn("explorer.exe", [CAMO_APP], { detached: true, stdio: "ignore" }).unref();
    }
    if (!(await ensureObs({ launch: true }))) throw new Error("เปิด OBS ไม่ได้");
    const { outputActive } = await obs.request("GetStreamStatus");
    wantLive = true;
    if (!outputActive) {
      await clearChannel();
      startListener();
      await sleep(1500);
      await obs.request("StartStream");
    } else if (!listener) {
      startListener();
    }
  } else if (action === "stop") {
    wantLive = false;
    if (obs.connected) {
      const { outputActive } = await obs.request("GetStreamStatus");
      if (outputActive) await obs.request("StopStream");
    }
    setTimeout(() => { if (!wantLive && listener) listener.kill(); }, 10000);
    if (!listener) await clearChannel();
  } else if (action === "mute" || action === "unmute") {
    if (!(await ensureObs({ launch: false }))) throw new Error("OBS ยังไม่เปิด");
    await obs.request("SetInputMute", { inputName: MIC_INPUT, inputMuted: action === "mute" });
  } else if (action === "standby" || action === "camera") {
    if (!(await ensureObs({ launch: false }))) throw new Error("OBS ยังไม่เปิด");
    await obs.request("SetCurrentProgramScene", { sceneName: action === "standby" ? STANDBY_SCENE : CAMERA_SCENE });
  }
}

// -------------------------------------------------------------- status ----

let lastError = null;

async function collectStatus() {
  const obsRunning = await isRunning("obs64.exe");
  if (obsRunning && !obs.connected) await ensureObs({ launch: false });
  const status = {
    v: VERSION,
    obs: { running: obsRunning, connected: obs.connected },
    streaming: false,
    listener: !!listener,
    wantLive,
    camo: { running: await isRunning("CamoStudio.exe"), ...camoStatus() },
    lastError,
  };
  if (obs.connected) {
    try {
      const st = await obs.request("GetStreamStatus");
      status.streaming = st.outputActive;
      status.reconnecting = st.outputReconnecting;
      status.streamSeconds = Math.round((st.outputDuration || 0) / 1000);
      status.scene = (await obs.request("GetCurrentProgramScene")).currentProgramSceneName;
      status.micMuted = (await obs.request("GetInputMute", { inputName: MIC_INPUT })).inputMuted;
      status.micDb = obs.takeMicDb();
    } catch (e) {
      status.obsError = e.message;
    }
  }
  return status;
}

async function screenshot(scene) {
  const { imageData } = await obs.request("GetSourceScreenshot", {
    sourceName: scene, imageFormat: "jpg", imageWidth: 480, imageCompressionQuality: 55,
  });
  return imageData.slice(imageData.indexOf(",") + 1);
}

// ---------------------------------------------------------------- loop ----

async function main() {
  console.log("ROYS Hotel · ตัวควบคุมช่อง 21 Event (เปิดหน้าต่างนี้ทิ้งไว้ระหว่างงาน)");
  console.log(`หน้าควบคุมบนมือถือ: ${BASE}/control\n`);
  let acked = [];
  let wantPreview = false;
  let online = null;
  for (;;) {
    let next = 30;
    try {
      const status = await collectStatus();
      const body = { status, acked };
      if (wantPreview && obs.connected && status.scene) {
        body.preview = await screenshot(status.scene).catch(() => undefined);
      }
      const res = await fetch(`${BASE}/control/agent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`เซิร์ฟเวอร์ตอบ ${res.status}`);
      const reply = await res.json();
      if (online !== true) log("เชื่อมกับหน้าควบคุมแล้ว");
      online = true;
      acked = [];
      wantPreview = reply.wantPreview;
      next = reply.pollSeconds || 30;
      for (const cmd of reply.commands || []) {
        try {
          await run(cmd.action);
          lastError = null;
        } catch (e) {
          lastError = `${ACTION_TH[cmd.action] || cmd.action} ไม่สำเร็จ: ${e.message}`;
          log(lastError);
        }
        acked.push(cmd.id);
        next = 1; // report the result right away
      }
    } catch (e) {
      if (online !== false) log("ติดต่อหน้าควบคุมไม่ได้:", e.message);
      online = false;
      next = 10;
    }
    await sleep(next * 1000);
  }
}

main();
