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

  const chosen = videos[Math.min(index || 0, videos.length - 1)];
  // Try the matched video first, then any other video in the tweet, so an
  // HLS-only entry doesn't block a sibling that has an MP4.
  let mp4 = bestMp4(chosen);
  for (let i = 0; !mp4 && i < videos.length; i++) mp4 = bestMp4(videos[i]);
  if (!mp4) throw new Error("Only streaming (HLS) format available");

  return {
    url: mp4,
    text: typeof data.text === "string" ? data.text : "",
    author: (data.user && data.user.screen_name) || "",
  };
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

function buildFilename(meta, tweetId) {
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
  return `${base}.mp4`;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "XVD_DOWNLOAD") return false;

  (async () => {
    try {
      const meta = await resolveVideoUrl(msg.tweetId, msg.index);
      await chrome.downloads.download({
        url: meta.url,
        filename: buildFilename(meta, msg.tweetId),
        saveAs: false,
      });
      sendResponse({ ok: true, url: meta.url });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || "Error" });
    }
  })();

  // Keep the message channel open for the async response.
  return true;
});
