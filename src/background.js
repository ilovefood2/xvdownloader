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

/** Collect every video variant list found anywhere in the tweet payload. */
function collectVideos(data) {
  const videos = [];

  const consider = (entity) => {
    if (!entity || typeof entity !== "object") return;
    const info = entity.video_info;
    if (info && Array.isArray(info.variants)) {
      videos.push(info.variants);
    }
  };

  // Primary tweet media.
  if (Array.isArray(data.mediaDetails)) data.mediaDetails.forEach(consider);
  if (data.video && Array.isArray(data.video.variants)) {
    videos.push(data.video.variants);
  }
  // Quoted tweet media.
  if (data.quoted_tweet && Array.isArray(data.quoted_tweet.mediaDetails)) {
    data.quoted_tweet.mediaDetails.forEach(consider);
  }

  return videos;
}

/** Pick the highest-bitrate MP4 url from a list of variants. */
function bestMp4(variants) {
  const mp4s = variants.filter(
    (v) => v && v.content_type === "video/mp4" && v.url
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

  const videos = collectVideos(data);
  if (!videos.length) throw new Error("No video found");

  const chosen = videos[Math.min(index || 0, videos.length - 1)];
  const mp4 = bestMp4(chosen) || bestMp4(videos[0]);
  if (!mp4) throw new Error("No MP4 variant");
  return mp4;
}

function buildFilename(tweetId, mp4Url) {
  // Keep the resolution suffix (e.g. 1280x720) when X provides it.
  const res = (mp4Url.match(/\/(\d+x\d+)\//) || [])[1];
  const base = res ? `x_${tweetId}_${res}` : `x_${tweetId}`;
  return `${base}.mp4`;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "XVD_DOWNLOAD") return false;

  (async () => {
    try {
      const mp4 = await resolveVideoUrl(msg.tweetId, msg.index);
      await chrome.downloads.download({
        url: mp4,
        filename: buildFilename(msg.tweetId, mp4),
        saveAs: false,
      });
      sendResponse({ ok: true, url: mp4 });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || "Error" });
    }
  })();

  // Keep the message channel open for the async response.
  return true;
});
