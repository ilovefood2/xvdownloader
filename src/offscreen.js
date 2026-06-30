/*
 * X Video Downloader — offscreen document.
 *
 * Runs in a full DOM context at the extension origin, so it can both fetch
 * cross-origin media (host permissions grant CORS) and build blob URLs (which
 * the MV3 service worker cannot). It downloads an HLS stream's segments and
 * concatenates them into a single blob, returning a blob URL the service worker
 * hands to chrome.downloads.
 *
 * X's HLS is fragmented MP4 (CMAF): an init segment (#EXT-X-MAP) plus media
 * fragments. Concatenating init + fragments yields a directly-playable .mp4 with
 * no transcoding. Plain MPEG-TS streams (no init segment) are saved as .ts.
 */
"use strict";

const SEGMENT_CONCURRENCY = 6;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;

  if (msg.type === "XVD_PREPARE") {
    prepare(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: hlsError(e) }));
    return true; // async response
  }

  if (msg.type === "XVD_REVOKE") {
    try {
      URL.revokeObjectURL(msg.blobUrl);
    } catch (e) {
      /* ignore */
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "XVD_PAUSE") {
    getControl(msg.jobId).paused = true;
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "XVD_RESUME") {
    const c = getControl(msg.jobId);
    c.paused = false;
    c.waiters.splice(0).forEach((resolve) => resolve());
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "XVD_CANCEL") {
    const c = getControl(msg.jobId);
    c.canceled = true;
    c.paused = false; // unblock any parked workers so they can bail out
    c.waiters.splice(0).forEach((resolve) => resolve());
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

function hlsError(e) {
  return (e && e.message) || "HLS merge failed";
}

// Raised in the worker loop when a job is canceled.
class CanceledError extends Error {
  constructor() {
    super("Canceled");
    this.name = "CanceledError";
  }
}

// Per-job control for in-progress HLS downloads.
const controls = new Map(); // jobId -> { paused, canceled, waiters: [] }

function freshControl() {
  return { paused: false, canceled: false, waiters: [] };
}

function getControl(jobId) {
  let c = controls.get(jobId);
  if (!c) {
    c = freshControl();
    controls.set(jobId, c);
  }
  return c;
}

function resolveUrl(base, ref) {
  return new URL(ref, base).href;
}

// --- ffmpeg.wasm (lazy) ---------------------------------------------------
// Loaded only for streams the lightweight concat path can't handle: encrypted
// (AES-128) or MPEG-TS that needs remuxing to a clean MP4. ~31 MB, so we never
// load it for X's normal unencrypted fragmented-MP4 videos.
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
      ffmpegPromise = null; // allow a retry on a later download
      throw e;
    });
  }
  return ffmpegPromise;
}

// Rewrite a media playlist so every segment/key/map URI points at a local file
// (for ffmpeg's MEMFS), and collect the remote URLs to download.
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

// Credentialed so X's CDN serves restricted/4K media that it refuses to a
// plain chrome.downloads request. Host permissions grant the cross-origin read.
const FETCH_OPTS = { credentials: "include", cache: "no-store" };

// Abort a request if no *response* arrives within `ms`, so a stalled fetch can
// never hang the download forever. The timer is cleared once headers arrive, so
// reading a large body is not cut off.
async function fetchTimed(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...FETCH_OPTS, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("Request timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const r = await fetchTimed(url, 20000);
  if (!r.ok) throw new Error("Playlist HTTP " + r.status);
  return r.text();
}

async function fetchSegmentBlob(url) {
  const r = await fetchTimed(url, 30000);
  if (!r.ok) throw new Error("Segment HTTP " + r.status);
  return r.blob();
}

/** Decide what to fetch (direct MP4 or HLS) and return a downloadable blob. */
async function prepare(msg) {
  if (msg.direct) {
    try {
      return await prepareDirect(msg.direct);
    } catch (e) {
      // X sometimes 503s / 403s the progressive MP4 even though the HLS
      // stream of the same video serves fine. Fall back to it.
      if (msg.hls) {
        console.log("[XVD] direct MP4 failed, falling back to HLS:", hlsError(e));
        return assemble(msg.hls, msg.jobId);
      }
      throw e;
    }
  }
  if (msg.hls) return assemble(msg.hls, msg.jobId);
  throw new Error("No downloadable video found");
}

/** Report HLS download progress back to the originating button. */
function reportProgress(jobId, done, total) {
  if (jobId == null) return;
  chrome.runtime
    .sendMessage({ type: "XVD_PROGRESS", jobId, done, total })
    .catch(() => {});
}

/** Fetch a direct MP4 ourselves so credentials/headers reach X's CDN. */
async function prepareDirect(url) {
  const r = await fetchTimed(url, 20000);
  if (!r.ok) throw new Error("Video blocked by X (HTTP " + r.status + ")");
  const type = r.headers.get("content-type") || "";
  if (/text\/html/i.test(type)) {
    throw new Error("Video blocked by X (got a web page, not a video)");
  }
  console.log("[XVD] downloading direct MP4 body…");
  const blob = await r.blob();
  return { ok: true, blobUrl: URL.createObjectURL(blob), ext: "mp4" };
}

/** Resolve a master playlist to the highest-bandwidth media playlist. */
async function getMediaPlaylist(masterUrl) {
  const text = await fetchText(masterUrl);
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
  return { url: mediaUrl, text: await fetchText(mediaUrl) };
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

async function assemble(masterUrl, jobId) {
  console.log("[XVD] HLS: fetching playlist", masterUrl);
  const media = await getMediaPlaylist(masterUrl);
  const { mapUrl, segments, encrypted } = parseMediaPlaylist(
    media.text,
    media.url
  );

  if (!segments.length) throw new Error("No segments in stream");

  // Encrypted (AES-128) or MPEG-TS streams go through ffmpeg for decryption /
  // remuxing. Unencrypted fragmented-MP4 (the X case) uses the fast concat path.
  if (encrypted || !mapUrl) {
    return assembleWithFfmpeg(media, jobId);
  }

  const urls = [mapUrl, ...segments];
  // Hold each segment as a Blob (browser may back it on disk) rather than
  // keeping every ArrayBuffer in the JS heap — important for long/4K streams.
  const parts = new Array(urls.length);
  console.log("[XVD] HLS: downloading", urls.length, "segments");

  // Capture the control ONCE by reference. Every worker checks this same
  // object, so a cancel/pause is seen by all of them (and we don't recreate it).
  const control = jobId != null ? getControl(jobId) : freshControl();

  // Block while paused; throw if canceled. Uses the captured control.
  async function gate() {
    if (control.canceled) throw new CanceledError();
    if (control.paused) await new Promise((r) => control.waiters.push(r));
    if (control.canceled) throw new CanceledError();
  }

  let next = 0;
  let done = 0;
  reportProgress(jobId, 0, urls.length);
  async function worker() {
    while (next < urls.length) {
      await gate();
      const i = next++;
      parts[i] = await fetchSegmentBlob(urls[i]);
      done++;
      if (done % 10 === 0 || done === urls.length) {
        reportProgress(jobId, done, urls.length);
      }
      if (done % 25 === 0 || done === urls.length) {
        console.log("[XVD] HLS:", done + "/" + urls.length, "segments");
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(SEGMENT_CONCURRENCY, urls.length) },
    worker
  );

  // allSettled (not all): wait for EVERY worker to stop before tearing down,
  // so the cancel flag stays live until they've all seen it.
  const results = await Promise.allSettled(workers);
  if (jobId != null) controls.delete(jobId);

  if (control.canceled) {
    console.log("[XVD] HLS: canceled");
    throw new CanceledError();
  }
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;

  const type = "video/mp4";
  const blobUrl = URL.createObjectURL(new Blob(parts, { type }));
  console.log("[XVD] HLS: merge complete → mp4");
  return { ok: true, blobUrl, ext: "mp4" };
}

// Download every segment/key into ffmpeg's in-memory FS, then let ffmpeg
// decrypt (AES-128) and remux into a clean MP4. Supports pause/cancel.
async function assembleWithFfmpeg(media, jobId) {
  const { playlist, downloads } = buildLocalPlaylist(media.text, media.url);
  if (!downloads.length) throw new Error("No segments in stream");

  const control = jobId != null ? getControl(jobId) : freshControl();
  async function gate() {
    if (control.canceled) throw new CanceledError();
    if (control.paused) await new Promise((r) => control.waiters.push(r));
    if (control.canceled) throw new CanceledError();
  }

  const ff = await getFfmpeg();
  const total = downloads.length;
  console.log("[XVD] ffmpeg: downloading", total, "files");

  let next = 0;
  let done = 0;
  reportProgress(jobId, 0, total);
  async function worker() {
    while (next < downloads.length) {
      await gate();
      const i = next++;
      const r = await fetchTimed(downloads[i].url, 30000);
      if (!r.ok) throw new Error("Segment HTTP " + r.status);
      await ff.writeFile(downloads[i].name, new Uint8Array(await r.arrayBuffer()));
      done++;
      if (done % 10 === 0 || done === total) reportProgress(jobId, done, total);
      if (done % 25 === 0 || done === total) {
        console.log("[XVD] ffmpeg:", done + "/" + total, "files");
      }
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(SEGMENT_CONCURRENCY, downloads.length) }, worker)
  );
  if (jobId != null) controls.delete(jobId);
  if (control.canceled) {
    console.log("[XVD] ffmpeg: canceled");
    throw new CanceledError();
  }
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;

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

  const out = await ff.readFile("out.mp4"); // Uint8Array
  // Free the MEMFS so memory isn't held for the next download.
  try {
    for (const d of downloads) await ff.deleteFile(d.name);
    await ff.deleteFile("playlist.m3u8");
    await ff.deleteFile("out.mp4");
  } catch (e) {
    /* ignore cleanup errors */
  }
  if (!out || !out.length) throw new Error("ffmpeg produced no output");

  const blobUrl = URL.createObjectURL(new Blob([out], { type: "video/mp4" }));
  console.log("[XVD] ffmpeg: done → mp4");
  return { ok: true, blobUrl, ext: "mp4" };
}
