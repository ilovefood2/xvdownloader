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
const TS_FALLBACK_SEGMENT_LIMIT = 450;
const TS_FALLBACK_DURATION_LIMIT = 45 * 60;

function resolveUrl(base, ref) {
  return new URL(ref, base).href;
}

function parseAttributeList(value) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match;
  while ((match = re.exec(value))) {
    let v = (match[2] || "").trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    attrs[match[1].toUpperCase()] = v;
  }
  return attrs;
}

function parseIv(value) {
  let hex = String(value || "").replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "");
  if (!hex) return null;
  if (hex.length % 2) hex = "0" + hex;

  const raw = new Uint8Array(hex.match(/.{2}/g).map((x) => parseInt(x, 16)));
  const iv = new Uint8Array(16);
  iv.set(raw.slice(-16), Math.max(0, 16 - raw.length));
  return iv;
}

function sequenceIv(sequence) {
  const iv = new Uint8Array(16);
  let n = BigInt(Math.max(0, Number(sequence) || 0));
  for (let i = 15; i >= 0; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

function arrayBufferFromView(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
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

/** Parse a media playlist into { mapUrl, segments, encrypted, durationSeconds }. */
function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  let mapUrl = null;
  let encrypted = false;
  let durationSeconds = 0;
  const segments = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const value = parseFloat((line.match(/^#EXTINF:([\d.]+)/) || [])[1] || "0");
      if (Number.isFinite(value)) durationSeconds += value;
    } else if (line.startsWith("#EXT-X-MAP")) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) mapUrl = resolveUrl(baseUrl, m[1]);
    } else if (line.startsWith("#EXT-X-KEY") && !/METHOD=NONE/i.test(line)) {
      encrypted = true;
    } else if (!line.startsWith("#")) {
      segments.push(resolveUrl(baseUrl, line));
    }
  }
  return { mapUrl, segments, encrypted, durationSeconds };
}

function parseTsConcatPlan(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let mediaSequence = 0;
  let segmentIndex = 0;
  let currentKey = null;
  let hasMap = false;
  let hasByteRange = false;
  let unsupportedEncryption = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-MAP")) {
      hasMap = true;
      continue;
    }

    if (line.startsWith("#EXT-X-BYTERANGE")) {
      hasByteRange = true;
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
      const value = parseInt((line.split(":")[1] || "").trim(), 10);
      if (Number.isFinite(value)) mediaSequence = value;
      continue;
    }

    if (line.startsWith("#EXT-X-KEY")) {
      const attrs = parseAttributeList(line.slice(line.indexOf(":") + 1));
      const method = String(attrs.METHOD || "").toUpperCase();
      if (!method || method === "NONE") {
        currentKey = null;
      } else if (method === "AES-128" && attrs.URI) {
        currentKey = {
          url: resolveUrl(baseUrl, attrs.URI),
          iv: parseIv(attrs.IV),
        };
      } else {
        unsupportedEncryption = method || "unknown";
      }
      continue;
    }

    if (line.startsWith("#")) continue;

    const sequence = mediaSequence + segmentIndex;
    segments.push({
      url: resolveUrl(baseUrl, line),
      keyUrl: currentKey && currentKey.url,
      iv: currentKey && (currentKey.iv || sequenceIv(sequence)),
    });
    segmentIndex++;
  }

  return { segments, hasMap, hasByteRange, unsupportedEncryption };
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
      // Keep the tail of ffmpeg's log so a failed exec can report why.
      ff._xvdLog = [];
      ff.on("log", ({ message }) => {
        ff._xvdLog.push(message);
        if (ff._xvdLog.length > 40) ff._xvdLog.shift();
      });
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

/** Fetch and cache an AES-128 HLS key for the TS fallback path. */
async function getAesKey(fetchTimed, keyUrl, cache) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    throw new Error("Encrypted HLS requires browser crypto support");
  }

  if (!cache.has(keyUrl)) {
    cache.set(
      keyUrl,
      (async () => {
        const r = await fetchTimed(keyUrl, 20000);
        if (!r.ok) throw new Error("Key HTTP " + r.status);
        const keyBytes = new Uint8Array(await r.arrayBuffer());
        if (keyBytes.length !== 16) throw new Error("Invalid AES-128 key");
        return globalThis.crypto.subtle.importKey(
          "raw",
          keyBytes,
          { name: "AES-CBC" },
          false,
          ["decrypt"]
        );
      })()
    );
  }

  return cache.get(keyUrl);
}

async function decryptAes128(bytes, cryptoKey, iv) {
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: "AES-CBC", iv },
    cryptoKey,
    arrayBufferFromView(bytes)
  );
  return new Uint8Array(plain);
}

/** Large generic MPEG-TS HLS fallback: decrypt if needed, then join TS parts. */
async function assembleTsConcat(media, ctx, reason) {
  const { fetchTimed, control, onProgress } = ctx;
  const plan = parseTsConcatPlan(media.text, media.url);
  if (plan.hasMap) throw new Error("TS fallback cannot handle fragmented MP4 HLS");
  if (plan.hasByteRange) throw new Error("TS fallback cannot handle byte-range HLS");
  if (plan.unsupportedEncryption) {
    throw new Error("Unsupported HLS encryption: " + plan.unsupportedEncryption);
  }
  if (!plan.segments.length) throw new Error("No segments in stream");

  const total = plan.segments.length;
  const parts = new Array(total);
  const keyCache = new Map();
  let done = 0;

  if (onProgress) onProgress(0, total);
  console.log("[XVD] HLS: using TS concat fallback", { total, reason });

  await runWorkers(total, control, async (i) => {
    const segment = plan.segments[i];
    const r = await fetchTimed(segment.url, 30000);
    if (!r.ok) throw new Error("Segment HTTP " + r.status);

    if (segment.keyUrl) {
      const cryptoKey = await getAesKey(fetchTimed, segment.keyUrl, keyCache);
      const bytes = new Uint8Array(await r.arrayBuffer());
      parts[i] = await decryptAes128(bytes, cryptoKey, segment.iv);
    } else {
      parts[i] = await r.blob();
    }

    done++;
    if (onProgress && (done % 10 === 0 || done === total)) {
      onProgress(done, total);
    }
  });

  console.log("[XVD] HLS: merge complete -> ts");
  return { blob: new Blob(parts, { type: "video/mp2t" }), ext: "ts" };
}

function isFfmpegMemoryError(error) {
  const message = String((error && (error.stack || error.message)) || error || "");
  return /out of memory|memory access out of bounds|cannot enlarge memory|abort/i.test(
    message
  );
}

function isTsFallbackUnsupportedError(error) {
  const message = String((error && error.message) || error || "");
  return (
    message.startsWith("TS fallback cannot handle") ||
    message.startsWith("Unsupported HLS encryption")
  );
}

/** Encrypted (AES-128) or MPEG-TS: download into ffmpeg, decrypt/remux to MP4. */
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

function getResponseSize(response) {
  const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
  if (contentLength > 0) return contentLength;

  const contentRange = response.headers.get("content-range") || "";
  const total = parseInt((contentRange.match(/\/(\d+)$/) || [])[1] || "0", 10);
  return total > 0 ? total : 0;
}

async function readBlobWithProgress(response, { control, onProgress } = {}) {
  const total = getResponseSize(response);
  const reader = response.body && response.body.getReader && response.body.getReader();

  if (!reader) {
    const blob = await response.blob();
    if (onProgress && blob.size) onProgress(blob.size, blob.size);
    return blob;
  }

  const parts = [];
  let done = 0;
  if (onProgress && total) onProgress(0, total);

  try {
    while (true) {
      if (control) await control.gate();
      const chunk = await reader.read();
      if (chunk.done) break;
      parts.push(chunk.value);
      done += chunk.value.byteLength || chunk.value.length || 0;
      if (onProgress && total) onProgress(Math.min(done, total), total);
    }
  } catch (e) {
    try {
      await reader.cancel();
    } catch (cancelError) {
      /* ignore */
    }
    throw e;
  }

  if (control) await control.gate();
  if (onProgress && total) onProgress(total, total);
  return new Blob(parts, { type: response.headers.get("content-type") || "video/mp4" });
}

/** Download a direct progressive media file (e.g. an MP4). */
export async function downloadDirect(url, { credentials, control, onProgress } = {}) {
  // Concurrent Range chunks when supported (fast, throttle-resistant), with an
  // automatic single-GET fallback for servers that don't honour Range.
  return { blob: await downloadStream(url, { credentials, control, onProgress }), ext: "mp4" };
}

const STREAM_CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB, matches yt-dlp's default
const STREAM_CHUNK_CONCURRENCY = 6; // enough to saturate a link; matches SEGMENT_CONCURRENCY

// Probe a stream's total size with a tiny range request, and confirm the server
// honours Range (206) so we can chunk it.
async function probeStreamSize(url, credentials) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let response;
  try {
    response = await fetch(url, {
      credentials: credentials || "omit",
      cache: "no-store",
      headers: { Range: "bytes=0-1" },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error("Stream HTTP " + response.status);
  const contentRange = response.headers.get("content-range") || "";
  const total = parseInt((contentRange.match(/\/(\d+)$/) || [])[1] || "0", 10);
  const contentType = response.headers.get("content-type") || "";
  try {
    await response.arrayBuffer();
  } catch (e) {
    /* ignore */
  }
  return { total, contentType, chunkable: response.status === 206 && total > 0 };
}

// Download a single Range chunk into a Uint8Array, with a per-chunk timeout.
async function fetchRangeChunk(url, credentials, start, end) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const response = await fetch(url, {
      credentials: credentials || "omit",
      cache: "no-store",
      headers: { Range: `bytes=${start}-${end}` },
      signal: ctrl.signal,
    });
    if (!response.ok) throw new Error("Chunk HTTP " + response.status);
    return new Uint8Array(await response.arrayBuffer());
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("Chunk timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download a media stream as a Blob using concurrent Range requests. YouTube's
 * googlevideo CDN throttles a single sequential GET to roughly playback speed;
 * fetching in parallel chunks gets each request a fresh full-speed burst, which
 * is ~30-40x faster for long videos.
 */
async function downloadStreamChunked(url, total, { credentials, control, onProgress } = {}) {
  const ranges = [];
  for (let start = 0; start < total; start += STREAM_CHUNK_SIZE) {
    ranges.push([start, Math.min(start + STREAM_CHUNK_SIZE - 1, total - 1)]);
  }
  const parts = new Array(ranges.length);
  let done = 0;
  if (onProgress) onProgress(0, total);

  let next = 0;
  async function worker() {
    while (next < ranges.length) {
      if (control) await control.gate();
      const i = next++;
      const [start, end] = ranges[i];
      const bytes = await fetchRangeChunk(url, credentials, start, end);
      parts[i] = bytes;
      done += bytes.length;
      if (onProgress) onProgress(Math.min(done, total), total);
    }
  }

  const results = await Promise.allSettled(
    Array.from({ length: Math.min(STREAM_CHUNK_CONCURRENCY, ranges.length) }, worker)
  );
  if (control && control.canceled) throw new CanceledError();
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  // A chunk that came back short (server ignored part of the Range) would leave a
  // gap in the stream. Reject a truncated assembly so the caller retries with a
  // plain GET rather than silently producing a clipped file.
  if (done < total) throw new Error(`Chunked download short: ${done}/${total}`);
  return new Blob(parts, { type: "video/mp4" });
}

// Download a stream, trying each candidate URL in turn. Adaptive CDNs (e.g.
// Bilibili) hand out a primary host plus backup mirror hosts for the same signed
// stream; a flaky mirror can throw ERR_HTTP2_PROTOCOL_ERROR (surfaced as a fetch
// "network error") on every request, so fall back to the next mirror instead of
// failing the whole download. Each URL is also retried once, since these HTTP/2
// resets are frequently transient.
async function downloadStream(urlOrUrls, opts = {}) {
  const urls = (Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls]).filter(
    (u) => typeof u === "string" && u
  );
  if (!urls.length) throw new Error("No stream URL");

  let lastError;
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Retry attempt drops credentials: signed CDN URLs (Bilibili, YouTube)
        // don't need cookies, and sending them can trip an HTTP/2 reset — so if
        // the credentialed request fails, try again anonymously before moving on.
        const attemptOpts =
          attempt === 0 ? opts : { ...opts, credentials: "omit" };
        return await downloadStreamFrom(url, attemptOpts);
      } catch (e) {
        if (opts.control && opts.control.canceled) throw e;
        lastError = e;
      }
    }
  }
  throw lastError || new Error("Stream download failed");
}

// Download a single stream URL as a Blob: concurrent Range chunks when the server
// supports them (much faster, and bypasses per-connection rate throttling), else
// a single streamed GET. Chunking is strictly best-effort — a probe that fails or
// a chunk download that errors falls back to a plain GET, so this is never worse
// than a single request. Rejects HTML error pages served in place of media.
async function downloadStreamFrom(url, { credentials, control, onProgress, preferSingleGet } = {}) {
  // Facebook-style URLs carry the byte range in the query (&bytestart=&byteend=);
  // adding a Range header conflicts and the CDN 403s — fetch them plainly.
  const urlHasByteRange = /[?&]byteend=/.test(url);

  let probe = null;
  if (!preferSingleGet && !urlHasByteRange) {
    try {
      probe = await probeStreamSize(url, credentials);
    } catch (e) {
      probe = null; // some CDNs reject a range probe but serve a plain GET fine
    }
  }

  if (probe && /text\/html/i.test(probe.contentType)) {
    throw new Error("Server returned a web page, not a video");
  }
  if (probe && probe.chunkable) {
    try {
      return await downloadStreamChunked(url, probe.total, { credentials, control, onProgress });
    } catch (e) {
      if (control && control.canceled) throw e;
      // Chunked download failed mid-stream — fall through to a single GET.
    }
  }

  const fetchTimed = makeFetchTimed(credentials);
  const response = await fetchTimed(url, 20000);
  if (!response.ok) throw new Error("Stream HTTP " + response.status);
  if (/text\/html/i.test(response.headers.get("content-type") || "")) {
    throw new Error("Server returned a web page, not a video");
  }
  return readBlobWithProgress(response, { control, onProgress });
}

/**
 * Download separate video-only + audio-only MP4 streams (e.g. YouTube adaptive
 * formats) and mux them into a single MP4 with ffmpeg (stream copy, no re-encode).
 */
export async function downloadMux(videoUrl, audioUrl, { credentials, control, onProgress, singleGet } = {}) {
  // videoUrl/audioUrl may each be a single URL or a list of mirror URLs for the
  // same stream (primary + backups); downloadStream tries them in order.
  // Each stream goes through downloadStream, which chunks via Range when the
  // server supports it (YouTube) and falls back to a plain GET for byte-range
  // URLs (Facebook). The video dominates the size, so drive the progress bar
  // off it and let the small audio stream finish quietly.
  // `singleGet` forces a sequential GET (no parallel Range chunks) for CDNs that
  // reject aggressive chunking (Bilibili returns HTTP/2 resets or a 514).
  const videoBlob = await downloadStream(videoUrl, {
    credentials,
    control,
    onProgress,
    preferSingleGet: singleGet,
  });
  // Fetch audio with a single plain GET rather than Range chunks. Audio is small,
  // so chunking buys little, and some CDNs (e.g. Bilibili serves audio from a
  // different host than video) misreport the Range total on the audio endpoint,
  // which would silently truncate a chunked download and leave the muxed file's
  // tail without sound. A streamed GET reads until the connection ends, so it
  // always gets the whole track.
  const audioBlob = await downloadStream(audioUrl, { credentials, control, preferSingleGet: true });

  await control?.gate();
  const ff = await getFfmpeg();

  // Mount the streams via WORKERFS so ffmpeg reads them lazily from the Blobs
  // instead of copying them into its 2 GB heap. Only the muxed output then
  // occupies the heap (not input + output), which roughly doubles the size of
  // video that can be remuxed in-browser — enough for large 4K files.
  const MOUNT = "/mux";
  try {
    await ff.createDir(MOUNT);
  } catch (e) {
    /* directory may already exist from a previous run */
  }
  await ff.mount(
    "WORKERFS",
    {
      blobs: [
        { name: "v.mp4", data: videoBlob },
        { name: "a.m4a", data: audioBlob },
      ],
    },
    MOUNT
  );

  console.log("[XVD] ffmpeg: muxing video + audio…");
  try {
    // Map video from input 0 and audio from input 1 so ffmpeg can never silently
    // emit an audio-only file. Try MP4 first; if its muxer rejects the codec
    // combination (some Facebook AV1/VP9 fragmented streams), fall back to
    // Matroska, which accepts anything — yielding a playable .mkv.
    const run = async (outName) => {
      try {
        await ff.deleteFile(outName);
      } catch (e) {
        /* not there yet */
      }
      await ff.exec([
        "-i", `${MOUNT}/v.mp4`,
        "-i", `${MOUNT}/a.m4a`,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c", "copy",
        outName,
      ]);
      const data = await ff.readFile(outName);
      return data && data.length ? data : null;
    };

    let out = null;
    let ext = "mp4";
    try {
      out = await run("mux_out.mp4");
    } catch (e) {
      console.warn("[XVD] ffmpeg mp4 mux failed:", e && e.message, "|", (ff._xvdLog || []).slice(-12).join(" | "));
    }
    if (!out) {
      console.log("[XVD] ffmpeg: retrying mux into mkv…");
      out = await run("mux_out.mkv");
      ext = "mkv";
    }
    if (!out) {
      throw new Error("ffmpeg mux failed: " + (ff._xvdLog || []).slice(-12).join(" | "));
    }

    if (onProgress) onProgress(1, 1); // mux complete
    console.log("[XVD] ffmpeg: mux done →", ext);
    const type = ext === "mkv" ? "video/x-matroska" : "video/mp4";
    return { blob: new Blob([out], { type }), ext };
  } finally {
    try {
      await ff.unmount(MOUNT);
    } catch (e) {
      /* ignore */
    }
    try {
      await ff.deleteDir(MOUNT);
    } catch (e) {
      /* ignore */
    }
    try {
      await ff.deleteFile("mux_out.mp4");
    } catch (e) {
      /* ignore */
    }
    try {
      await ff.deleteFile("mux_out.mkv");
    } catch (e) {
      /* ignore */
    }
  }
}

/** Download + assemble an HLS stream into a single MP4 Blob. */
export async function downloadHls(masterUrl, opts = {}) {
  const control = opts.control || new DownloadControl();
  const onProgress = opts.onProgress;
  const fetchTimed = makeFetchTimed(opts.credentials);
  const allowTsFallback = opts.allowTsFallback === true;

  const media = await getMediaPlaylist(fetchTimed, masterUrl);
  const { mapUrl, segments, encrypted, durationSeconds } = parseMediaPlaylist(
    media.text,
    media.url
  );
  if (!segments.length) throw new Error("No segments in stream");

  const ctx = { fetchTimed, control, onProgress };
  // Encrypted or MPEG-TS → ffmpeg; plain fragmented-MP4 → fast concat.
  if (encrypted || !mapUrl) {
    if (
      allowTsFallback &&
      !mapUrl &&
      (segments.length >= TS_FALLBACK_SEGMENT_LIMIT ||
        durationSeconds >= TS_FALLBACK_DURATION_LIMIT)
    ) {
      try {
        return await assembleTsConcat(media, ctx, "large-ts-playlist");
      } catch (e) {
        if (!isTsFallbackUnsupportedError(e)) throw e;
        console.warn("[XVD] TS fallback unavailable, trying ffmpeg:", e.message);
      }
    }

    try {
      return await assembleWithFfmpeg(media, ctx);
    } catch (e) {
      if (allowTsFallback && !mapUrl && isFfmpegMemoryError(e)) {
        return assembleTsConcat(media, ctx, "ffmpeg-memory");
      }
      throw e;
    }
  }
  return assembleConcat(mapUrl, segments, ctx);
}
