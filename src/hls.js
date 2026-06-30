/*
 * X Video Downloader — shared HLS / media pipeline (ES module).
 *
 * Used by both the offscreen document (real downloads) and the test harness
 * (test/hls-test.html). Pure of chrome messaging: pause/cancel is driven by a
 * DownloadControl, progress by an onProgress(done, total) callback. Returns
 * Blobs; the caller turns them into object URLs / downloads.
 */

export class CanceledError extends Error {
  constructor() {
    super("Canceled");
    this.name = "CanceledError";
  }
}

/** Pause / resume / cancel handle for an in-progress download. */
export class DownloadControl {
  constructor() {
    this.paused = false;
    this.canceled = false;
    this._waiters = [];
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    this._waiters.splice(0).forEach((r) => r());
  }
  cancel() {
    this.canceled = true;
    this.paused = false;
    this._waiters.splice(0).forEach((r) => r());
  }
  /** Block while paused; throw if canceled. */
  async gate() {
    if (this.canceled) throw new CanceledError();
    if (this.paused) await new Promise((r) => this._waiters.push(r));
    if (this.canceled) throw new CanceledError();
  }
}

const SEGMENT_CONCURRENCY = 6;

function resolveUrl(base, ref) {
  return new URL(ref, base).href;
}

// A fetch that aborts if no response arrives within `ms` (cleared once headers
// arrive, so large bodies aren't cut off). `credentials` is "include" for X
// (host-permission CORS bypass + cookies) or "omit" for public CORS streams.
function makeFetchTimed(credentials) {
  const base = { credentials: credentials || "omit", cache: "no-store" };
  return async function fetchTimed(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...base, signal: ctrl.signal });
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("Request timed out");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Resolve a master playlist to the highest-bandwidth media playlist. */
async function getMediaPlaylist(fetchTimed, masterUrl) {
  const r = await fetchTimed(masterUrl, 20000);
  if (!r.ok) throw new Error("Playlist HTTP " + r.status);
  const text = await r.text();
  if (/#EXTINF/.test(text)) return { url: masterUrl, text }; // already media

  const lines = text.split(/\r?\n/);
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const bw = parseInt((line.match(/BANDWIDTH=(\d+)/) || [])[1] || "0", 10);
      const uri = (lines[i + 1] || "").trim();
      if (uri && !uri.startsWith("#") && (!best || bw > best.bw)) {
        best = { bw, uri };
      }
    }
  }
  if (!best) throw new Error("No stream found in playlist");
  const mediaUrl = resolveUrl(masterUrl, best.uri);
  const mr = await fetchTimed(mediaUrl, 20000);
  if (!mr.ok) throw new Error("Playlist HTTP " + mr.status);
  return { url: mediaUrl, text: await mr.text() };
}

/** Parse a media playlist into { mapUrl, segments, encrypted }. */
function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  let mapUrl = null;
  let encrypted = false;
  const segments = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MAP")) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) mapUrl = resolveUrl(baseUrl, m[1]);
    } else if (line.startsWith("#EXT-X-KEY") && !/METHOD=NONE/.test(line)) {
      encrypted = true;
    } else if (!line.startsWith("#")) {
      segments.push(resolveUrl(baseUrl, line));
    }
  }
  return { mapUrl, segments, encrypted };
}

/** Rewrite a playlist so every URI is a local filename, for ffmpeg's MEMFS. */
function buildLocalPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const downloads = []; // { url, name }
  let segIdx = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      out.push(raw);
    } else if (line.startsWith("#EXT-X-MAP")) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) {
        downloads.push({ url: resolveUrl(baseUrl, m[1]), name: "init.mp4" });
        out.push(line.replace(/URI="[^"]+"/, 'URI="init.mp4"'));
      } else out.push(line);
    } else if (line.startsWith("#EXT-X-KEY")) {
      const m = line.match(/URI="([^"]+)"/);
      if (m && !/METHOD=NONE/i.test(line)) {
        downloads.push({ url: resolveUrl(baseUrl, m[1]), name: "enc.key" });
        out.push(line.replace(/URI="[^"]+"/, 'URI="enc.key"'));
      } else out.push(line);
    } else if (line.startsWith("#")) {
      out.push(line);
    } else {
      const url = resolveUrl(baseUrl, line);
      const ext = (url.split("?")[0].match(/\.([a-z0-9]+)$/i) || [, "ts"])[1];
      const name = "seg" + segIdx++ + "." + ext;
      downloads.push({ url, name });
      out.push(name);
    }
  }
  return { playlist: out.join("\n"), downloads };
}

// --- ffmpeg.wasm (lazy) ---------------------------------------------------
let ffmpegPromise = null;

function getFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      console.log("[XVD] ffmpeg: loading core (~31 MB)…");
      const mod = await import(chrome.runtime.getURL("vendor/ffmpeg/index.js"));
      const ff = new mod.FFmpeg();
      await ff.load({
        coreURL: chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.js"),
        wasmURL: chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.wasm"),
      });
      console.log("[XVD] ffmpeg: core ready");
      return ff;
    })().catch((e) => {
      ffmpegPromise = null; // allow a retry next time
      throw e;
    });
  }
  return ffmpegPromise;
}

/** Run N workers over `count` items with bounded concurrency + cancel support. */
async function runWorkers(count, control, task) {
  let next = 0;
  async function worker() {
    while (next < count) {
      await control.gate();
      const i = next++;
      await task(i);
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(SEGMENT_CONCURRENCY, count) }, worker)
  );
  if (control.canceled) throw new CanceledError();
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
}

/** Unencrypted fragmented-MP4: byte-concatenate init + segments → MP4. */
async function assembleConcat(mapUrl, segments, ctx) {
  const { fetchTimed, control, onProgress } = ctx;
  const urls = [mapUrl, ...segments];
  const parts = new Array(urls.length);
  let done = 0;
  if (onProgress) onProgress(0, urls.length);
  console.log("[XVD] HLS: downloading", urls.length, "segments");
  await runWorkers(urls.length, control, async (i) => {
    const r = await fetchTimed(urls[i], 30000);
    if (!r.ok) throw new Error("Segment HTTP " + r.status);
    parts[i] = await r.blob();
    done++;
    if (onProgress && (done % 10 === 0 || done === urls.length)) {
      onProgress(done, urls.length);
    }
  });
  console.log("[XVD] HLS: merge complete → mp4");
  return { blob: new Blob(parts, { type: "video/mp4" }), ext: "mp4" };
}

/** Encrypted (AES-128) or MPEG-TS: download into ffmpeg, decrypt/remux → MP4. */
async function assembleWithFfmpeg(media, ctx) {
  const { fetchTimed, control, onProgress } = ctx;
  const { playlist, downloads } = buildLocalPlaylist(media.text, media.url);
  if (!downloads.length) throw new Error("No segments in stream");

  const ff = await getFfmpeg();
  const total = downloads.length;
  let done = 0;
  if (onProgress) onProgress(0, total);
  console.log("[XVD] ffmpeg: downloading", total, "files");
  await runWorkers(total, control, async (i) => {
    const r = await fetchTimed(downloads[i].url, 30000);
    if (!r.ok) throw new Error("Segment HTTP " + r.status);
    await ff.writeFile(downloads[i].name, new Uint8Array(await r.arrayBuffer()));
    done++;
    if (onProgress && (done % 10 === 0 || done === total)) onProgress(done, total);
  });

  await ff.writeFile("playlist.m3u8", new TextEncoder().encode(playlist));
  console.log("[XVD] ffmpeg: remuxing…");
  await ff.exec([
    "-allowed_extensions", "ALL",
    "-protocol_whitelist", "file,crypto,data",
    "-i", "playlist.m3u8",
    "-c", "copy",
    "-movflags", "+faststart",
    "out.mp4",
  ]);
  const out = await ff.readFile("out.mp4");
  try {
    for (const d of downloads) await ff.deleteFile(d.name);
    await ff.deleteFile("playlist.m3u8");
    await ff.deleteFile("out.mp4");
  } catch (e) {
    /* ignore cleanup errors */
  }
  if (!out || !out.length) throw new Error("ffmpeg produced no output");
  console.log("[XVD] ffmpeg: done → mp4");
  return { blob: new Blob([out], { type: "video/mp4" }), ext: "mp4" };
}

/** Download a direct progressive media file (e.g. an MP4). */
export async function downloadDirect(url, { credentials } = {}) {
  const fetchTimed = makeFetchTimed(credentials);
  const r = await fetchTimed(url, 20000);
  if (!r.ok) throw new Error("Video blocked by X (HTTP " + r.status + ")");
  const type = r.headers.get("content-type") || "";
  if (/text\/html/i.test(type)) {
    throw new Error("Video blocked by X (got a web page, not a video)");
  }
  return { blob: await r.blob(), ext: "mp4" };
}

/** Download + assemble an HLS stream into a single MP4 Blob. */
export async function downloadHls(masterUrl, opts = {}) {
  const control = opts.control || new DownloadControl();
  const onProgress = opts.onProgress;
  const fetchTimed = makeFetchTimed(opts.credentials);

  const media = await getMediaPlaylist(fetchTimed, masterUrl);
  const { mapUrl, segments, encrypted } = parseMediaPlaylist(
    media.text,
    media.url
  );
  if (!segments.length) throw new Error("No segments in stream");

  const ctx = { fetchTimed, control, onProgress };
  // Encrypted or MPEG-TS → ffmpeg; plain fragmented-MP4 → fast concat.
  if (encrypted || !mapUrl) return assembleWithFfmpeg(media, ctx);
  return assembleConcat(mapUrl, segments, ctx);
}
