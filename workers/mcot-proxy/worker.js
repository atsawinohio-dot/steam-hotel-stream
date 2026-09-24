// MCOT HD shim.
//
// Two things break a plain link to this origin:
//  1. The chunklist filenames carry a Wowza session id (chunklist_w<id>_b<rate>)
//     that the origin rotates every few days. The playlist used to pin one, and
//     it started answering 404 (2026-09-25).
//  2. The master lists a 3000000 rendition that is currently dead — every
//     chunklist_w*_b3000000 answers 404 while 2000000/1000000/500000 serve fine.
//     A player that takes the first variant (Samsung does) gets nothing.
//
// So: fetch the origin master, probe its variants from the highest bitrate
// down, and hand back a master that lists only one that actually answers,
// with an absolute URL. The TV then pulls chunklists and segments straight
// from the CDN — only this one small manifest goes through the Worker, so the
// request budget stays tiny. Samsung TVs cannot follow a 302, hence a body.
//
// The probe result is cached for CACHE_SECONDS so a burst of TVs turning on
// does not re-probe for each one.

const ORIGIN = "https://mcothd-streaming-edge-cdn.mcot.net/tencentmcot/smil:tencentmcot.smil";
const CACHE_SECONDS = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
  "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
};

async function resolveMaster() {
  const res = await fetch(`${ORIGIN}/playlist.m3u8`, {
    cf: { cacheTtl: 0 },
    headers: { "User-Agent": "Mozilla/5.0 (ROYS Hotel MCOT shim)" },
  });
  if (!res.ok) throw new Error(`origin master ${res.status}`);
  const body = await res.text();

  // [{ bandwidth, name }] ordered as the origin lists them, best first.
  const lines = body.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const ref = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
    if (!ref) continue;
    const bw = Number(/BANDWIDTH=(\d+)/.exec(lines[i])?.[1] || 0);
    variants.push({ bandwidth: bw, name: ref.trim(), attrs: lines[i] });
  }
  variants.sort((a, b) => b.bandwidth - a.bandwidth);

  for (const v of variants) {
    const url = `${ORIGIN}/${v.name}`;
    const probe = await fetch(url, {
      cf: { cacheTtl: 0 },
      headers: { "User-Agent": "Mozilla/5.0 (ROYS Hotel MCOT shim)" },
    });
    if (!probe.ok) continue;
    const text = await probe.text();
    if (!text.trimStart().startsWith("#EXTM3U")) continue;
    if (!/\.ts(\?|$)/m.test(text.replace(/^#.*$/gm, ""))) continue;
    return `#EXTM3U\n#EXT-X-VERSION:3\n${v.attrs}\n${url}\n`;
  }
  throw new Error("no working variant");
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "") {
      return new Response("Steam Hotel MCOT HD shim. Use /live/playlist.m3u8", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname !== "/live/playlist.m3u8") {
      return new Response("Not found", { status: 404 });
    }

    const cache = caches.default;
    const key = new Request(`${url.origin}/live/playlist.m3u8`, { method: "GET" });
    const hit = await cache.match(key);
    if (hit) return new Response(await hit.text(), { headers: CORS });

    let manifest;
    try {
      manifest = await resolveMaster();
    } catch (e) {
      return new Response(`Upstream: ${e.message}`, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    await cache.put(
      key,
      new Response(manifest, {
        headers: { "Content-Type": CORS["Content-Type"], "Cache-Control": `max-age=${CACHE_SECONDS}` },
      })
    );
    return new Response(manifest, { headers: CORS });
  },
};
