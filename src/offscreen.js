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

  return false;
});

function hlsError(e) {
  return (e && e.message) || "HLS merge failed";
}

function resolveUrl(base, ref) {
  return new URL(ref, base).href;
}

// Credentialed so X's CDN serves restricted/4K media that it refuses to a
// plain chrome.downloads request. Host permissions grant the cross-origin read.
const FETCH_OPTS = { credentials: "include", cache: "no-store" };

async function fetchText(url) {
  const r = await fetch(url, FETCH_OPTS);
  if (!r.ok) throw new Error("Playlist HTTP " + r.status);
  return r.text();
}

async function fetchBuffer(url) {
  const r = await fetch(url, FETCH_OPTS);
  if (!r.ok) throw new Error("Segment HTTP " + r.status);
  return r.arrayBuffer();
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
        return assemble(msg.hls);
      }
      throw e;
    }
  }
  if (msg.hls) return assemble(msg.hls);
  throw new Error("No downloadable video found");
}

/** Fetch a direct MP4 ourselves so credentials/headers reach X's CDN. */
async function prepareDirect(url) {
  const r = await fetch(url, FETCH_OPTS);
  if (!r.ok) throw new Error("Video blocked by X (HTTP " + r.status + ")");
  const type = r.headers.get("content-type") || "";
  if (/text\/html/i.test(type)) {
    throw new Error("Video blocked by X (got a web page, not a video)");
  }
  const buf = await r.arrayBuffer();
  const blobUrl = URL.createObjectURL(
    new Blob([buf], { type: "video/mp4" })
  );
  return { ok: true, blobUrl, ext: "mp4" };
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

async function assemble(masterUrl) {
  const media = await getMediaPlaylist(masterUrl);
  const { mapUrl, segments, encrypted } = parseMediaPlaylist(
    media.text,
    media.url
  );

  if (encrypted) throw new Error("Encrypted HLS not supported");
  if (!segments.length) throw new Error("No segments in stream");

  const urls = mapUrl ? [mapUrl, ...segments] : segments;
  const buffers = new Array(urls.length);

  // Fetch segments with bounded concurrency, preserving order.
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      buffers[i] = await fetchBuffer(urls[i]);
    }
  }
  const workers = Array.from(
    { length: Math.min(SEGMENT_CONCURRENCY, urls.length) },
    worker
  );
  await Promise.all(workers);

  const ext = mapUrl ? "mp4" : "ts";
  const type = ext === "mp4" ? "video/mp4" : "video/mp2t";
  const blobUrl = URL.createObjectURL(new Blob(buffers, { type }));
  return { ok: true, blobUrl, ext };
}
