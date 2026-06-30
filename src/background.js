/*
 * X Video Downloader — background service worker
 *
 * Resolves a tweet's video to a direct MP4 URL using X's public syndication
 * endpoint (cdn.syndication.twimg.com/tweet-result), then hands the URL to the
 * downloads API.
 */
"use strict";

// YouTube's InnerTube player endpoint (youtubei/v1/player) returns HTTP 403 to
// any request that carries an Origin header — and Chrome forces an
// `Origin: chrome-extension://<id>` header onto every fetch the service worker
// makes (it's a forbidden header, so it can't be removed from fetch() itself).
// Strip it via declarativeNetRequest, scoped to the player endpoint and excluded
// for youtube.com-initiated requests so the user's own YouTube playback is
// untouched. (googlevideo media fetches are fine with the Origin header.)
const YT_ORIGIN_RULE_ID = 4801;
async function ensureYouTubeOriginRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [YT_ORIGIN_RULE_ID],
      addRules: [
        {
          id: YT_ORIGIN_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "origin", operation: "remove" }],
          },
          condition: {
            urlFilter: "||youtube.com/youtubei/v1/player",
            excludedInitiatorDomains: ["youtube.com"],
          },
        },
      ],
    });
  } catch (e) {
    console.warn("[XVD] could not register YouTube origin rule:", e.message);
  }
}
ensureYouTubeOriginRule();

// Many generic video CDNs (e.g. Referer-gated HLS sites) reject requests that
// don't carry the page's Referer/Origin, so an extension fetch gets a 403. We
// spoof those headers for the duration of a download — scoped to the extension's
// own tab-less requests (tabIds:[-1]) so normal browsing is never affected, and
// to the media host so unrelated downloads are untouched.
const MEDIA_REFERER_RULE_BASE = 5000;
const MEDIA_REFERER_RULE_SPAN = 2000;

function mediaRefererRuleId(jobId) {
  return MEDIA_REFERER_RULE_BASE + (Math.abs(jobId) % MEDIA_REFERER_RULE_SPAN);
}

// Derive the host plus a coarse parent domain (so segments served from a sibling
// subdomain still match), for use as declarativeNetRequest `requestDomains`.
function mediaRuleDomains(urls) {
  const domains = new Set();
  for (const url of urls) {
    if (!url) continue;
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (!host) continue;
      domains.add(host);
      const parts = host.split(".");
      if (parts.length >= 3) domains.add(parts.slice(-2).join("."));
    } catch {
      /* ignore unparseable urls */
    }
  }
  return [...domains];
}

async function setMediaRefererRule(jobId, pageUrl, urls) {
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return false;
  }
  const requestDomains = mediaRuleDomains(urls);
  if (!requestDomains.length) return false;

  try {
    const id = mediaRefererRuleId(jobId);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "referer", operation: "set", value: pageUrl },
              { header: "origin", operation: "set", value: origin },
            ],
          },
          condition: {
            tabIds: [-1],
            requestDomains,
          },
        },
      ],
    });
    return true;
  } catch (e) {
    console.warn("[XVD] could not set media referer rule:", e.message);
    return false;
  }
}

async function clearMediaRefererRule(jobId) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [mediaRefererRuleId(jobId)],
    });
  } catch {
    /* ignore */
  }
}

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

/** Pick the best MP4 and the HLS playlist (kept so HLS can serve as fallback). */
function pickSource(lists, index) {
  const chosen = lists[Math.min(index || 0, lists.length - 1)];
  let mp4 = bestMp4(chosen);
  for (let i = 0; !mp4 && i < lists.length; i++) mp4 = bestMp4(lists[i]);

  let hls = getHls(chosen);
  for (let i = 0; !hls && i < lists.length; i++) hls = getHls(lists[i]);

  return { url: mp4 || null, hls: hls || null };
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

// Fetch the media in the offscreen document (credentialed, so X's CDN serves
// restricted/4K videos that it refuses to a plain chrome.downloads request),
// and get back a blob URL to download. Handles both direct MP4 and HLS.
async function prepareViaOffscreen(meta, jobId, credentials, options = {}) {
  await ensureOffscreen();
  // No overall timeout here: a download can be paused indefinitely by the user.
  // Per-request timeouts in the offscreen doc still guard against dead requests.
  const res = await chrome.runtime.sendMessage({
    type: "XVD_PREPARE",
    target: "offscreen",
    jobId,
    direct: meta.url || null,
    hls: meta.hls || null,
    mux: meta.mux || null,
    credentials,
    allowTsFallback: options.allowTsFallback === true,
  });
  if (!res || !res.ok) throw new Error((res && res.error) || "Download failed");
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

async function startDownload(meta, tweetId, jobId) {
  if (!meta.url && !meta.hls) throw new Error("No downloadable video found");

  console.log("[XVD] preparing", {
    via: meta.url ? "direct" : "hls",
    src: meta.url || meta.hls,
  });

  // Always fetch the bytes from the extension context, then download the blob.
  const prepared = await prepareViaOffscreen(meta, jobId);
  const filename = buildFilename(meta, tweetId, prepared.ext);

  const id = await new Promise((resolve) =>
    chrome.downloads.download(
      { url: prepared.blobUrl, filename, saveAs: false },
      resolve
    )
  );
  if (id == null) {
    throw new Error(
      (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
        "Download blocked"
    );
  }
  pendingRevokes.set(id, prepared.blobUrl);
  return prepared.blobUrl;
}

async function startGenericDownload(meta, requestedFilename, jobId) {
  const source = { url: meta.url || null, hls: meta.hls || null, mux: null };
  // Most sites need cookies for restricted streams; YouTube's signed googlevideo
  // URLs are issued for an anonymous context and break if cookies are attached.
  let credentials = "include";

  if (meta.youtubeVideoId) {
    try {
      console.log("[XVD] resolving YouTube media", meta.youtubeVideoId);
      const resolved = await resolveYouTubeMedia(meta.youtubeVideoId);
      source.url = resolved.url || null;
      source.mux = resolved.mux || null;
      source.hls = null;
      credentials = "omit";
    } catch (e) {
      console.warn("[XVD] YouTube resolver failed:", e.message);
      if (!source.url && !source.hls && !source.mux) throw e;
    }
  }

  if (!source.url && !source.hls && !source.mux) {
    throw new Error("No downloadable video found");
  }

  console.log("[XVD] preparing generic media", {
    via: source.mux ? "mux" : source.hls ? "hls" : "direct",
    src: source.mux ? source.mux.videoUrl : source.hls || source.url,
  });

  // YouTube uses its own anonymous googlevideo URLs; everything else may be
  // Referer-gated, so spoof the page Referer/Origin for our fetches.
  const refererActive =
    !meta.youtubeVideoId && meta.pageUrl
      ? await setMediaRefererRule(jobId, meta.pageUrl, [source.hls, source.url])
      : false;

  try {
    let prepared;
    try {
      prepared = await prepareViaOffscreen(
        {
          url: source.hls || source.mux ? null : source.url,
          hls: source.hls || null,
          mux: source.mux || null,
        },
        jobId,
        credentials,
        { allowTsFallback: true }
      );
    } catch (e) {
      if (!source.hls || !source.url) throw e;
      console.log("[XVD] generic HLS failed, falling back to direct media:", e.message);
      prepared = await prepareViaOffscreen({ url: source.url, hls: null }, jobId, credentials);
    }

    const filename = buildGenericFilename(requestedFilename, prepared.ext);

    const id = await new Promise((resolve) =>
      chrome.downloads.download(
        { url: prepared.blobUrl, filename, saveAs: false },
        resolve
      )
    );
    if (id == null) {
      throw new Error(
        (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
          "Download blocked"
      );
    }
    pendingRevokes.set(id, prepared.blobUrl);
    return prepared.blobUrl;
  } finally {
    if (refererActive) await clearMediaRefererRule(jobId);
  }
}

function isHttpMediaUrl(url, extPattern) {
  if (!url || typeof url !== "string") return false;
  if (url.startsWith("blob:") || url.startsWith("data:")) return false;

  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      extPattern.test(parsed.pathname + parsed.search)
    );
  } catch {
    return false;
  }
}

function isHttpMp4Url(url) {
  if (!url || typeof url !== "string") return false;
  if (url.startsWith("blob:") || url.startsWith("data:")) return false;

  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      (/\.mp4(?:[/?#]|$)/i.test(parsed.pathname + parsed.search) ||
        isYouTubeProgressiveMp4(parsed))
    );
  } catch {
    return false;
  }
}

function isYouTubeProgressiveMp4(parsed) {
  const itag = parsed.searchParams.get("itag") || "";
  const mime = parsed.searchParams.get("mime") || "";
  return (
    /(^|\.)googlevideo\.com$/i.test(parsed.hostname) &&
    /\/videoplayback$/i.test(parsed.pathname) &&
    /video\/mp4/i.test(mime) &&
    /^(18|22)$/i.test(itag)
  );
}

function isHttpHlsUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (url.startsWith("blob:") || url.startsWith("data:")) return false;

  try {
    const parsed = new URL(url);
    if (/(^|\.)youtube\.com$/i.test(parsed.hostname) || parsed.hostname === "youtu.be") {
      return false; // YouTube media is resolved via the video id, not as HLS.
    }
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      (/\.m3u8(?:[/?#]|$)/i.test(parsed.pathname + parsed.search) ||
        /(?:^|\/)(?:master)?playlist(?:\/|$)/i.test(parsed.pathname) ||
        /(?:^|\/)hls(?:\/|$)/i.test(parsed.pathname) ||
        /(?:^|\/)m3u8(?:\/|$)/i.test(parsed.pathname))
    );
  } catch {
    return false;
  }
}

function sanitizeGenericName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 150);
}

function buildGenericFilename(requestedFilename, ext) {
  const extension = (ext || "mp4").replace(/[^a-z0-9]/gi, "") || "mp4";
  let base = sanitizeGenericName(requestedFilename).replace(/\.[a-z0-9]{2,5}$/i, "");

  if (!base || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) {
    base = "video";
  }

  return `${base}.${extension}`;
}

const YT_ANDROID_VR_CLIENT = {
  clientName: "ANDROID_VR",
  clientVersion: "1.65.10",
  deviceMake: "Oculus",
  deviceModel: "Quest 3",
  androidSdkVersion: 32,
  userAgent:
    "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
  osName: "Android",
  osVersion: "12L",
  hl: "en",
  timeZone: "UTC",
  utcOffsetMinutes: 0,
};

function sanitizeYouTubeVideoId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
}

function decodeYouTubeString(value) {
  try {
    return JSON.parse(`"${String(value).replace(/"/g, '\\"')}"`);
  } catch {
    return String(value || "").replace(/\\\//g, "/");
  }
}

function extractYouTubeConfigValue(text, key) {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  return match ? decodeYouTubeString(match[1]) : "";
}

function extractYouTubePlayerPath(text) {
  const jsUrl = extractYouTubeConfigValue(text, "jsUrl");
  if (jsUrl) return jsUrl;

  const playerUrl = extractYouTubeConfigValue(text, "PLAYER_JS_URL");
  if (playerUrl) return playerUrl;

  const match = text.match(/\/s\/player\/[^"']+\/base\.js/);
  return match ? decodeYouTubeString(match[0]) : "";
}

function extractSignatureTimestamp(text) {
  const match =
    text.match(/signatureTimestamp["']?\s*[:=]\s*(\d+)/) ||
    text.match(/\bsts["']?\s*[:=]\s*(\d+)/);
  const value = parseInt((match && match[1]) || "0", 10);
  // Real signature timestamps are ~5-digit day counts (e.g. 19800+). Reject
  // tiny incidental matches like `"sts":1` so we fall back to the player
  // base.js, which always carries the genuine value.
  return Number.isFinite(value) && value >= 10000 ? value : 0;
}

async function fetchYouTubeSignatureTimestamp(watchHtml) {
  const inlineValue = extractSignatureTimestamp(watchHtml);
  if (inlineValue) return inlineValue;

  const playerPath = extractYouTubePlayerPath(watchHtml);
  if (!playerPath) return 0;

  const playerUrl = new URL(playerPath, "https://www.youtube.com").href;
  const response = await fetch(playerUrl, {
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) return 0;

  return extractSignatureTimestamp(await response.text());
}

function pickYouTubeProgressiveMp4(playerResponse) {
  const formats = playerResponse?.streamingData?.formats || [];
  const mp4s = formats
    .filter(
      (format) =>
        format?.url &&
        /video\/mp4/i.test(format.mimeType || "") &&
        format.audioQuality
    )
    .sort(
      (a, b) =>
        (Number(b.height) || 0) - (Number(a.height) || 0) ||
        (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0)
    );

  return mp4s[0] || null;
}

// The video-only stream is muxed with ffmpeg.wasm entirely in memory, so cap it
// well clear of the wasm heap limit. A high-bitrate 1080p60 stream of a long
// video can exceed 250 MB, which reliably triggers an out-of-memory abort.
const YT_MAX_MUX_HEIGHT = 1080;
const YT_MAX_MUX_VIDEO_BYTES = 220 * 1024 * 1024;

// When no progressive MP4 exists, fall back to the best directly-fetchable
// video-only + audio-only MP4 streams so the offscreen ffmpeg step can merge
// them. Prefer the highest resolution that fits the memory budget, but never
// fail outright over a missing/oversized stream — fall back to the smallest.
function pickYouTubeAdaptiveMux(playerResponse) {
  const formats = playerResponse?.streamingData?.adaptiveFormats || [];
  const direct = (format) =>
    format && format.url && !format.signatureCipher && !format.cipher;
  const bytesOf = (format) => Number(format.contentLength) || 0;

  const videos = formats
    .filter(
      (format) =>
        direct(format) &&
        /video\/mp4/i.test(format.mimeType || "") &&
        (Number(format.height) || 0) <= YT_MAX_MUX_HEIGHT
    )
    .sort(
      (a, b) =>
        (Number(b.height) || 0) - (Number(a.height) || 0) ||
        (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0)
    );

  // Best quality within budget; if every stream is over/unknown, take the
  // smallest known size, else just the lowest resolution.
  const video =
    videos.find((f) => bytesOf(f) > 0 && bytesOf(f) <= YT_MAX_MUX_VIDEO_BYTES) ||
    videos
      .filter((f) => bytesOf(f) > 0)
      .sort((a, b) => bytesOf(a) - bytesOf(b))[0] ||
    videos[videos.length - 1];

  const audio = formats
    .filter(
      (format) => direct(format) && /audio\/mp4/i.test(format.mimeType || "")
    )
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];

  if (!video || !audio) return null;
  return { videoUrl: video.url, audioUrl: audio.url };
}

async function resolveYouTubeMedia(videoId) {
  const id = sanitizeYouTubeVideoId(videoId);
  if (!id) throw new Error("Invalid YouTube video id");

  const watchUrl =
    "https://www.youtube.com/watch?v=" +
    encodeURIComponent(id) +
    "&bpctr=9999999999&has_verified=1";
  // Anonymous (no cookies): the ANDROID_VR client expects a fresh visitor
  // context, and signed-in web cookies make the player endpoint reject it.
  const watchResponse = await fetch(watchUrl, {
    credentials: "omit",
    cache: "no-store",
    headers: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!watchResponse.ok) throw new Error("YouTube watch HTTP " + watchResponse.status);

  const watchHtml = await watchResponse.text();
  const visitorData =
    extractYouTubeConfigValue(watchHtml, "VISITOR_DATA") ||
    extractYouTubeConfigValue(watchHtml, "visitorData");
  const signatureTimestamp = await fetchYouTubeSignatureTimestamp(watchHtml);

  const headers = {
    "Content-Type": "application/json",
    "X-Youtube-Client-Name": "28",
    "X-Youtube-Client-Version": YT_ANDROID_VR_CLIENT.clientVersion,
  };
  if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;

  const playerResponse = await fetch(
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers,
      body: JSON.stringify({
        context: { client: YT_ANDROID_VR_CLIENT },
        videoId: id,
        playbackContext: {
          contentPlaybackContext: {
            html5Preference: "HTML5_PREF_WANTS",
            ...(signatureTimestamp
              ? { signatureTimestamp }
              : {}),
          },
        },
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    }
  );
  if (!playerResponse.ok) {
    throw new Error("YouTube player HTTP " + playerResponse.status);
  }

  const data = await playerResponse.json();
  if (data?.playabilityStatus?.status && data.playabilityStatus.status !== "OK") {
    throw new Error(
      data.playabilityStatus.reason ||
        "YouTube player status " + data.playabilityStatus.status
    );
  }

  // Prefer a single progressive MP4 (no remux, no ffmpeg memory pressure).
  const progressive = pickYouTubeProgressiveMp4(data);
  if (progressive) return { url: progressive.url };

  // Otherwise merge the best video-only + audio-only MP4 streams via ffmpeg.
  const mux = pickYouTubeAdaptiveMux(data);
  if (mux) return { mux };

  throw new Error("No downloadable YouTube MP4 found");
}

// Active jobs, so segment-progress from the offscreen doc can be forwarded to
// the tab/button that started the download.
let jobSeq = 0;
const jobs = new Map(); // jobId -> { tabId, requestId }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Progress relayed from the offscreen document → forward to the origin tab.
  if (msg && msg.type === "XVD_PROGRESS") {
    const job = jobs.get(msg.jobId);
    if (job && job.tabId != null) {
      chrome.tabs
        .sendMessage(job.tabId, {
          type: "XVD_PROGRESS",
          requestId: job.requestId,
          done: msg.done,
          total: msg.total,
        })
        .catch(() => {});
    }
    return false;
  }

  // Pause/resume/cancel from a button → look up the job and relay to offscreen.
  if (
    msg &&
    (msg.type === "XVD_PAUSE" ||
      msg.type === "XVD_RESUME" ||
      msg.type === "XVD_CANCEL")
  ) {
    for (const [jobId, job] of jobs) {
      if (job.requestId === msg.requestId) {
        chrome.runtime
          .sendMessage({ type: msg.type, target: "offscreen", jobId })
          .catch(() => {});
        break;
      }
    }
    return false;
  }

  if (msg && msg.type === "XVD_GENERIC_DOWNLOAD") {
    (async () => {
      const direct = isHttpMp4Url(msg.direct) ? msg.direct : null;
      const hls = isHttpHlsUrl(msg.hls) ? msg.hls : null;

      const jobId = ++jobSeq;
      jobs.set(jobId, {
        tabId: sender && sender.tab && sender.tab.id,
        requestId: msg.requestId,
      });

      try {
        const url = await startGenericDownload(
          {
            url: direct,
            hls,
            youtubeVideoId: sanitizeYouTubeVideoId(msg.youtubeVideoId),
            pageUrl: (sender && sender.url) || msg.pageUrl || null,
          },
          msg.filename,
          jobId
        );
        sendResponse({ ok: true, url });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || "Error" });
      } finally {
        jobs.delete(jobId);
      }
    })();

    return true;
  }

  if (msg.type !== "XVD_DOWNLOAD") return false;

  (async () => {
    const jobId = ++jobSeq;
    jobs.set(jobId, {
      tabId: sender && sender.tab && sender.tab.id,
      requestId: msg.requestId,
    });
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

      const url = await startDownload(meta, msg.tweetId, jobId);
      sendResponse({ ok: true, url });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || "Error" });
    } finally {
      jobs.delete(jobId);
    }
  })();

  // Keep the message channel open for the async response.
  return true;
});
