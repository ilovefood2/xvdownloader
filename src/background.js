/*
 * X Video Downloader — background service worker
 *
 * Resolves a tweet's video to a direct MP4 URL using X's public syndication
 * endpoint (cdn.syndication.twimg.com/tweet-result), then hands the URL to the
 * downloads API.
 */
"use strict";

/**
 * Token expected by the syndication endpoint. Derived purely from the tweet id
 * (same algorithm the X web widget uses).
 */
function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI)
    .toString(36)
    .replace(/(0+|\.)/g, "");
}

/** True when an array looks like a list of media variants. */
function isVariantList(arr) {
  return (
    Array.isArray(arr) &&
    arr.some((v) => v && (v.content_type || v.type) && v.url)
  );
}

/**
 * Collect every video variant list found anywhere in the tweet payload.
 *
 * The syndication payload nests media in different places depending on the
 * tweet (mediaDetails, extended_entities, quoted_tweet, sensitive-media
 * wrappers, cards, …), so we recursively walk the whole object and pick up any
 * `variants` / `video_info.variants` array we encounter, deduped by URL.
 */
function collectVideos(data) {
  const videos = [];
  const seen = new Set();

  const add = (variants) => {
    if (!isVariantList(variants)) return;
    const key = variants.map((v) => v && v.url).join("|");
    if (seen.has(key)) return;
    seen.add(key);
    videos.push(variants);
  };

  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.video_info) add(node.video_info.variants);
    add(node.variants);
    for (const key in node) visit(node[key]);
  };

  visit(data);
  return videos;
}

/** Pick the highest-bitrate MP4 url from a list of variants. */
function bestMp4(variants) {
  const mp4s = variants.filter(
    (v) => v && (v.content_type === "video/mp4" || v.type === "video/mp4") && v.url
  );
  if (!mp4s.length) return null;
  mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4s[0].url;
}

/** Find the HLS (m3u8) playlist url among a list of variants, if any. */
function getHls(variants) {
  const m = variants.find(
    (v) =>
      v &&
      v.url &&
      (/mpegurl/i.test(v.content_type || v.type || "") ||
        /\.m3u8(\?|$)/i.test(v.url))
  );
  return m ? m.url : null;
}

/** Pick the best MP4 across video lists, with an HLS playlist as fallback. */
function pickSource(lists, index) {
  const chosen = lists[Math.min(index || 0, lists.length - 1)];
  let mp4 = bestMp4(chosen);
  for (let i = 0; !mp4 && i < lists.length; i++) mp4 = bestMp4(lists[i]);
  if (mp4) return { url: mp4, hls: null };

  let hls = getHls(chosen);
  for (let i = 0; !hls && i < lists.length; i++) hls = getHls(lists[i]);
  return { url: null, hls: hls || null };
}

async function resolveVideoUrl(tweetId, index) {
  const token = syndicationToken(tweetId);
  const url =
    "https://cdn.syndication.twimg.com/tweet-result?id=" +
    encodeURIComponent(tweetId) +
    "&token=" +
    encodeURIComponent(token) +
    "&lang=en";

  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error("Syndication HTTP " + resp.status);
  }
  const data = await resp.json();

  // Sensitive / protected / deleted tweets come back as a tombstone with no
  // media; surface that instead of a generic "no video".
  if (data.__typename === "TweetTombstone" || data.tombstone) {
    throw new Error("Tweet unavailable (sensitive or protected)");
  }

  const videos = collectVideos(data);
  if (!videos.length) throw new Error("No video found");

  const src = pickSource(videos, index);
  return {
    url: src.url,
    hls: src.hls,
    text: typeof data.text === "string" ? data.text : "",
    author: (data.user && data.user.screen_name) || "",
  };
}

/** Resolve from variants sniffed off X's API by the content script. */
function resolveFromCached(cached, index) {
  const lists = (cached && cached.lists) || [];
  if (!lists.length) throw new Error("No video found");

  const src = pickSource(lists, index);
  return { url: src.url, hls: src.hls, text: cached.text || "", author: "" };
}

/** Turn arbitrary tweet text into a safe, readable filename fragment. */
function sanitizeName(s) {
  return (s || "")
    .replace(/https?:\/\/\S+/g, " ") // drop t.co / other links
    .replace(/[@#]/g, "") // drop handle/hashtag sigils
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\\/:*?"<>|]/g, "") // characters illegal in filenames
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "")
    .replace(/&gt;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFilename(meta, tweetId, ext) {
  const author = sanitizeName(meta.author);
  let title = sanitizeName(meta.text);
  if (title.length > 80) title = title.slice(0, 80).trim();

  // Prefer "author - tweet text"; fall back gracefully when text is empty.
  let base = [author, title].filter(Boolean).join(" - ");
  if (!base) base = `x_${tweetId}`;

  // Append the tweet id so names stay unique across similar tweets.
  base = `${base} (${tweetId})`;

  // Guard against an over-long path component.
  if (base.length > 150) base = base.slice(0, 150).trim();
  return `${base}.${ext || "mp4"}`;
}

// --- HLS assembly via an offscreen document -------------------------------
// Service workers can't create blob URLs, so segment merging happens in an
// offscreen document (which also gets host-permission CORS for fetches).
let creatingOffscreen = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "src/offscreen.html",
      reasons: ["BLOBS"],
      justification: "Merge HLS video segments into a downloadable file.",
    });
  }
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function assembleHls(masterUrl) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    type: "XVD_HLS",
    target: "offscreen",
    url: masterUrl,
  });
  if (!res || !res.ok) throw new Error((res && res.error) || "HLS merge failed");
  return res; // { ok, blobUrl, ext }
}

// Revoke blob URLs once their download settles so memory is reclaimed.
const pendingRevokes = new Map(); // downloadId -> blobUrl
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || !delta.state) return;
  const state = delta.state.current;
  if (state !== "complete" && state !== "interrupted") return;
  const blobUrl = pendingRevokes.get(delta.id);
  if (!blobUrl) return;
  pendingRevokes.delete(delta.id);
  chrome.runtime
    .sendMessage({ type: "XVD_REVOKE", target: "offscreen", blobUrl })
    .catch(() => {});
});

async function startDownload(meta, tweetId) {
  let url = meta.url;
  let ext = "mp4";
  let isBlob = false;

  if (!url) {
    if (!meta.hls) throw new Error("No downloadable video found");
    console.log("[XVD] HLS-only, merging playlist:", meta.hls);
    const merged = await assembleHls(meta.hls);
    url = merged.blobUrl;
    ext = merged.ext || "mp4";
    isBlob = true;
  }

  console.log("[XVD] downloading", {
    via: isBlob ? "hls-blob" : "direct",
    ext,
    url,
  });
  const filename = buildFilename(meta, tweetId, ext);
  const id = await new Promise((resolve) =>
    chrome.downloads.download({ url, filename, saveAs: false }, resolve)
  );
  if (id == null) {
    throw new Error(
      (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
        "Download blocked"
    );
  }
  if (isBlob) pendingRevokes.set(id, url);
  return url;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "XVD_DOWNLOAD") return false;

  (async () => {
    try {
      // Prefer variants sniffed from X's own API (works for sensitive tweets);
      // fall back to the public syndication endpoint when nothing was cached.
      let meta;
      if (msg.cached && msg.cached.lists && msg.cached.lists.length) {
        meta = resolveFromCached(msg.cached, msg.index);
      } else {
        meta = await resolveVideoUrl(msg.tweetId, msg.index);
      }
      if (!meta.author && msg.author) meta.author = msg.author;

      const url = await startDownload(meta, msg.tweetId);
      sendResponse({ ok: true, url });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || "Error" });
    }
  })();

  // Keep the message channel open for the async response.
  return true;
});
