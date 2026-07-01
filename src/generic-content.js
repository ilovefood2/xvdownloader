/*
 * Generic website hover button.
 *
 * Runs outside x.com/twitter.com only. X.com keeps using the original scripts.
 */
(() => {
  "use strict";

  const BUTTON_CLASS = "xvd-generic-button";
  const WRAP_CLASS = "xvd-generic-wrap";
  const EVENT_NAME = "xvd-generic-media-url";
  const CACHE_ATTR = "xvdGenericMediaUrls";
  const MAX_REMEMBERED_URLS = 300; // DASH sites (Facebook) fire 100+ segment URLs
  const mediaUrlPatterns = {
    mp4: /https?:\/\/[^"'\s<>\\]+?\.mp4(?:\/)?(?:[?#][^"'\s<>\\]*)?(?=["'\s<>\\]|$)/gi,
    hls: /https?:\/\/[^"'\s<>\\]+?\.m3u8(?:\/)?(?:[?#][^"'\s<>\\]*)?(?=["'\s<>\\]|$)/gi,
  };

  const seenVideos = new WeakSet();
  const mediaUrls = { mp4: [], hls: [] };
  let staticMediaScanned = false;
  let mediaPageUrl = window.location.href;
  let activeVideo = null;
  let hideTimer = null;
  let lastPointer = { x: 0, y: 0 };
  let requestSeq = 0;
  let activeRequestId = null;
  let paused = false;
  let lastProgress = null;
  let downloadCanceled = false;

  const wrap = document.createElement("div");
  wrap.className = WRAP_CLASS;

  const button = document.createElement("button");
  button.type = "button";
  button.className = BUTTON_CLASS;
  button.textContent = "Download";
  button.title = "Download this video";
  button.addEventListener("mouseenter", () => showButton(activeVideo));
  button.addEventListener("mouseleave", scheduleHide);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (button.dataset.state === "busy") {
      togglePause();
    } else if (activeVideo) {
      handleDownload(activeVideo);
    }
  });

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "xvd-generic-cancel-button";
  cancelButton.textContent = "×";
  cancelButton.title = "Cancel download";
  cancelButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    cancelDownload();
  });

  wrap.appendChild(button);
  wrap.appendChild(cancelButton);

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "XVD_PROGRESS" || msg.requestId !== activeRequestId) return;
    if (!msg.total) return;
    lastProgress = Math.min(99, Math.floor((msg.done / msg.total) * 100));
    renderProgress();
  });

  function ensureButton() {
    if (!wrap.isConnected && document.body) {
      document.body.appendChild(wrap);
    }
  }

  function mediaKind(url) {
    if (!url || typeof url !== "string") return null;
    if (url.startsWith("blob:") || url.startsWith("data:")) return null;
    // A real media URL is a single clean token. Reject script/text blobs that
    // merely *contain* a URL (those are handled by regex extraction), so a
    // snippet like `var hlsUrl = '…m3u8';…` isn't resolved into a bogus path.
    if (url.length > 4096 || /[\s'"<>\\]/.test(url)) return null;

    try {
      const parsed = new URL(url, window.location.href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      const path = parsed.pathname + parsed.search;
      if (/\.mp4(?:[/?#]|$)/i.test(path)) return "mp4";
      if (isYouTubeProgressiveMp4(parsed)) return "mp4";
      if (/\.m3u8(?:[/?#]|$)/i.test(path)) return "hls";
      if (isLikelyHlsEndpoint(parsed)) return "hls";
    } catch {
      return null;
    }

    return null;
  }

  function isLikelyHlsEndpoint(parsed) {
    // YouTube media is resolved via the video id, not generic sniffing. Without
    // this guard a YouTube `/playlist?list=...` page URL is mistaken for HLS.
    if (/(^|\.)youtube\.com$/i.test(parsed.hostname) || parsed.hostname === "youtu.be") {
      return false;
    }
    const path = parsed.pathname.toLowerCase();
    return (
      /(?:^|\/)(?:master)?playlist(?:\/|$)/i.test(path) ||
      /(?:^|\/)hls(?:\/|$)/i.test(path) ||
      /(?:^|\/)m3u8(?:\/|$)/i.test(path)
    );
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

  function rememberMediaUrl(url, forcedKind) {
    resetMediaIfNavigated();

    const kind = forcedKind || mediaKind(url);
    if (!kind || !mediaUrls[kind]) return;

    const absoluteUrl = new URL(url, window.location.href).href;
    const list = mediaUrls[kind];
    const existingIndex = list.indexOf(absoluteUrl);
    if (existingIndex !== -1) list.splice(existingIndex, 1);
    list.push(absoluteUrl);

    if (list.length > MAX_REMEMBERED_URLS) {
      list.splice(0, list.length - MAX_REMEMBERED_URLS);
    }
  }

  function collectSnifferCache() {
    resetMediaIfNavigated();

    const rawCache = document.documentElement?.dataset?.[CACHE_ATTR];
    if (!rawCache) return;

    try {
      const cached = JSON.parse(rawCache);
      if (cached?.pageUrl && cached.pageUrl !== window.location.href) return;
      if (Array.isArray(cached?.mp4)) {
        cached.mp4.forEach((url) => rememberMediaUrl(url, "mp4"));
      }
      if (Array.isArray(cached?.hls)) {
        cached.hls.forEach((url) => rememberMediaUrl(url, "hls"));
      }
    } catch {
      // Ignore malformed page cache data.
    }
  }

  function collectPerformanceMediaUrls() {
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .forEach((url) => rememberMediaUrl(url));
  }

  function collectStaticPageMediaUrls() {
    resetMediaIfNavigated();

    if (staticMediaScanned) return;
    staticMediaScanned = true;

    const highPrioritySnippets = [];
    const lowPrioritySnippets = [];

    collectFromNodes(
      document.querySelectorAll('a[href], [data-src], [data-url], [data-video], [data-preview]'),
      lowPrioritySnippets
    );
    collectFromNodes(
      document.querySelectorAll('script:not([src]), meta[content], video[src], source[src]'),
      highPrioritySnippets
    );

    // Low-priority page links first, then player config/meta/video sources last
    // so the selected URL favors the main video over preview clips.
    for (const raw of [...lowPrioritySnippets, ...highPrioritySnippets]) {
      collectFromText(raw);
    }
  }

  function collectFromNodes(nodes, snippets) {
    for (const node of nodes) {
      if (node.tagName === "SCRIPT") {
        snippets.push(node.textContent || "");
        continue;
      }

      for (const attr of ["content", "src", "href", "data-src", "data-url", "data-video", "data-preview"]) {
        const value = node.getAttribute?.(attr);
        if (value) snippets.push(value);
      }
    }
  }

  function collectFromText(raw) {
    const text = String(raw)
      .replace(/\\u002F/g, "/")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");

    for (const match of text.matchAll(mediaUrlPatterns.mp4)) {
      rememberMediaUrl(match[0], "mp4");
    }
    for (const match of text.matchAll(mediaUrlPatterns.hls)) {
      rememberMediaUrl(match[0], "hls");
    }
    rememberMediaUrl(text);
    collectYouTubePlayerUrls(text);
  }

  function collectYouTubePlayerUrls(text) {
    if (!/youtube\.com|ytInitialPlayerResponse|googlevideo\.com/i.test(text)) return;

    let index = text.indexOf("ytInitialPlayerResponse");
    while (index !== -1) {
      const start = text.indexOf("{", index);
      if (start === -1) return;
      const parsed = parseJsonObjectAt(text, start);
      if (parsed) {
        rememberYouTubeFormats(parsed.value);
        index = parsed.end;
      } else {
        index = start + 1;
      }
      index = text.indexOf("ytInitialPlayerResponse", index);
    }

    try {
      rememberYouTubeFormats(JSON.parse(text));
    } catch {
      // Most snippets are not standalone JSON.
    }
  }

  function parseJsonObjectAt(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 };
          } catch {
            return null;
          }
        }
      }
    }

    return null;
  }

  function rememberYouTubeFormats(playerResponse) {
    const streamingData = playerResponse?.streamingData;
    if (!streamingData) return;

    const progressiveMp4s = (streamingData.formats || [])
      .filter((format) => format?.url && /video\/mp4/i.test(format.mimeType || ""))
      .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));

    for (const format of progressiveMp4s) {
      rememberMediaUrl(format.url, "mp4");
    }
  }

  function getMediaUrlFromElement(video) {
    const candidates = [
      video.currentSrc,
      video.src,
      ...Array.from(video.querySelectorAll("source")).map((source) => source.src),
    ];

    return {
      direct: candidates.find((url) => mediaKind(url) === "mp4") || null,
      hls: candidates.find((url) => mediaKind(url) === "hls") || null,
    };
  }

  function getLatestMediaUrls(video) {
    resetMediaIfNavigated();

    collectSnifferCache();
    collectPerformanceMediaUrls();
    collectStaticPageMediaUrls();
    const tiktok = getTikTokMediaUrl();
    if (tiktok) rememberMediaUrl(tiktok, "mp4");
    const elementUrls = getMediaUrlFromElement(video);
    const hls = elementUrls.hls || mediaUrls.hls[mediaUrls.hls.length - 1] || null;
    const direct = elementUrls.direct || mediaUrls.mp4[mediaUrls.mp4.length - 1] || null;

    return {
      direct: hls ? null : direct,
      hls,
    };
  }

  function resetMediaIfNavigated() {
    if (mediaPageUrl === window.location.href) return;

    mediaPageUrl = window.location.href;
    mediaUrls.mp4.length = 0;
    mediaUrls.hls.length = 0;
    staticMediaScanned = false;
  }

  function getDownloadFilename(video, overrideTitle) {
    const title =
      overrideTitle ||
      document.title ||
      video.getAttribute("aria-label") ||
      window.location.hostname ||
      "video";
    return `${sanitizeFilename(title)}.mp4`;
  }

  function sanitizeFilename(value) {
    const cleaned = String(value)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, 120);

    if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
      return `video-${Date.now()}`;
    }

    return cleaned;
  }

  // Facebook serves DASH: separate video + audio streams on *.fbcdn.net, keyed
  // by video_id inside the base64 `efg` URL param. The bare URL is rejected —
  // byte ranges must be in the URL (&bytestart=&byteend=), not a Range header.
  // Group the sniffed streams, pick the best video + its audio, and return a
  // mux pair with a full-range URL for each.
  function decodeFacebookEfg(url) {
    const match = url.match(/[?&]efg=([^&]+)/);
    if (!match) return null;
    try {
      const b64 = decodeURIComponent(match[1]).replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(b64));
    } catch {
      return null;
    }
  }

  function facebookFullRangeUrl(url) {
    try {
      const u = new URL(url);
      u.searchParams.delete("bytestart");
      u.searchParams.delete("byteend");
      u.searchParams.set("bytestart", "0");
      u.searchParams.set("byteend", "2000000000");
      return u.href;
    } catch {
      return null;
    }
  }

  function facebookPageVideoId() {
    const v = new URLSearchParams(window.location.search).get("v");
    if (v && /^\d+$/.test(v)) return v;
    const m = window.location.pathname.match(/\/(?:videos|reel|watch)\/(\d+)/);
    return m && m[1] ? m[1] : null;
  }

  function resolveFacebookMedia() {
    const host = window.location.hostname.toLowerCase();
    if (!/(^|\.)facebook\.com$/.test(host)) return null;

    collectSnifferCache();
    const groups = {};
    for (const url of mediaUrls.mp4) {
      if (!/(^|\.)fbcdn\.net$/i.test(safeHost(url))) continue;
      // Each stream URL must carry its own signature (oh/oe); an unsigned base
      // URL captured from a manifest 403s with "Bad URL hash".
      if (!/[?&]oh=/.test(url) || !/[?&]oe=/.test(url)) continue;
      const efg = decodeFacebookEfg(url);
      if (!efg || !efg.video_id) continue;
      const tag = String(efg.vencode_tag || "");
      const group = (groups[efg.video_id] = groups[efg.video_id] || { video: [], audio: [] });
      if (/audio/i.test(tag)) {
        group.audio.push({ url });
      } else {
        // Rank by resolution (e.g. _1080p) first, then encoder quality (_q90).
        const res = parseInt((tag.match(/(\d+)p/) || [])[1] || "0", 10);
        const q = parseInt((tag.match(/_q(\d+)/) || [])[1] || "0", 10);
        group.video.push({ url, quality: res * 1000 + q });
      }
    }

    const hasBoth = (g) => g && g.video.length && g.audio.length;

    // Prefer the video named in the page URL; else the most-buffered one with
    // both streams (right on a single-video page, a guess on a busy feed).
    let best = null;
    const targetId = facebookPageVideoId();
    if (targetId && hasBoth(groups[targetId])) {
      best = groups[targetId];
    } else {
      for (const id of Object.keys(groups)) {
        const g = groups[id];
        if (!hasBoth(g)) continue;
        const score = g.video.length + g.audio.length;
        if (!best || score > best.score) best = { ...g, score };
      }
    }
    if (!best) return null;

    const video = best.video.sort((a, b) => b.quality - a.quality)[0];
    const videoUrl = facebookFullRangeUrl(video.url);
    const audioUrl = facebookFullRangeUrl(best.audio[0].url);
    return videoUrl && audioUrl ? { videoUrl, audioUrl } : null;
  }

  function safeHost(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  // TikTok embeds the (no-watermark) MP4 URL in a page JSON blob rather than a
  // <video src>, and the URL has no .mp4 extension, so generic sniffing misses
  // it. Read it directly and pick the highest-bitrate variant.
  function getTikTokMediaUrl() {
    const host = window.location.hostname.toLowerCase();
    if (!/(^|\.)tiktok\.com$/.test(host)) return null;

    try {
      const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (!el || !el.textContent) return null;

      const data = JSON.parse(el.textContent);
      const video =
        data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct?.video;
      if (!video) return null;

      // The /aweme/v1/play fallback URL returns 403; only the CDN hosts work.
      const usable = (url) =>
        typeof url === "string" &&
        /^https?:\/\//.test(url) &&
        !/\/aweme\/v1\/play\b/i.test(url);

      // Highest-bitrate variant first; within each, the first usable CDN URL.
      const variants = (video.bitrateInfo || [])
        .slice()
        .sort((a, b) => (Number(b?.Bitrate) || 0) - (Number(a?.Bitrate) || 0));
      for (const variant of variants) {
        const url = (variant?.PlayAddr?.UrlList || []).find(usable);
        if (url) return url;
      }

      return usable(video.playAddr) ? video.playAddr : null;
    } catch {
      return null;
    }
  }

  // Some sites deliver adaptive media as a DASH manifest embedded in JSON: a
  // `dash` object with separate video-only and audio-only representations, each
  // carrying its own full `baseUrl` (typically `.m4s`). No .mp4/.m3u8 URL exists
  // for the generic sniffer to catch, so those pages report "No media found".
  // Detect the shape structurally — no hostname — pick the best video + audio,
  // and hand the pair to the shared mux (video+audio) pipeline.
  const DASH_ATTR = "xvdDashManifest";

  function readEmbeddedDash() {
    // Prefer a manifest the MAIN-world sniffer captured from live traffic — it
    // stays correct after an in-page navigation between videos, when a copy
    // inlined in the original HTML would be stale.
    try {
      const raw = document.documentElement?.dataset?.[DASH_ATTR];
      if (raw) {
        const dash = JSON.parse(raw);
        if (dash && Array.isArray(dash.video) && dash.video.length) return dash;
      }
    } catch {
      // Fall through to the inline scan.
    }

    for (const script of document.querySelectorAll("script")) {
      const text = script.textContent || "";
      let index = text.indexOf('"dash"');
      while (index !== -1) {
        const brace = text.indexOf("{", index);
        if (brace !== -1) {
          const parsed = parseJsonObjectAt(text, brace);
          if (parsed?.value && Array.isArray(parsed.value.video) && parsed.value.video.length) {
            return parsed.value;
          }
        }
        index = text.indexOf('"dash"', index + 6);
      }
    }

    return null;
  }

  function resolveEmbeddedDashMedia() {
    const dash = readEmbeddedDash();
    if (!dash) return null;

    const streamUrl = (stream) =>
      (stream &&
        (stream.baseUrl ||
          stream.base_url ||
          (Array.isArray(stream.backupUrl) && stream.backupUrl[0]) ||
          (Array.isArray(stream.backup_url) && stream.backup_url[0]))) ||
      null;

    // Best video: highest resolution, then highest bitrate. Best audio: highest
    // bitrate. Bandwidth is the one field every DASH representation carries.
    const video = dash.video
      .slice()
      .sort(
        (a, b) =>
          (Number(b.height) || 0) - (Number(a.height) || 0) ||
          (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0)
      )[0];
    const audio = (Array.isArray(dash.audio) ? dash.audio : [])
      .slice()
      .sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];

    const videoUrl = streamUrl(video);
    const audioUrl = streamUrl(audio);
    if (videoUrl && audioUrl) return { videoUrl, audioUrl };

    return null;
  }

  // Bilibili also serves DASH, but needs site-specific handling the structural
  // reader above can't do: (1) copyrighted titles gate high qualities behind VIP
  // and return a short *trial* video clip for them while the audio stays full —
  // so a naive "highest resolution" pick yields a video that stops after a few
  // minutes; (2) the useful filename is the current part's episode title, held in
  // the page's own state object, not the browser tab title.
  function readBilibiliPlayData() {
    // A playurl response captured live by the sniffer is freshest after an
    // in-page switch between parts; fall back to the inline __playinfo__.
    try {
      const raw = document.documentElement?.dataset?.xvdBilibiliData;
      if (raw) {
        const data = JSON.parse(raw);
        if (data && (data.dash || data.durl)) return data;
      }
    } catch {
      // Fall through to the inline copy.
    }

    return readBilibiliInlineJson("__playinfo__", (value) => {
      const data = value && (value.data || value.result || value);
      return data && (data.dash || data.durl) ? data : null;
    });
  }

  function readBilibiliInlineJson(marker, pick) {
    for (const script of document.querySelectorAll("script")) {
      const text = script.textContent || "";
      const at = text.indexOf(marker);
      if (at === -1) continue;

      const start = text.indexOf("{", at);
      if (start === -1) continue;

      const parsed = parseJsonObjectAt(text, start);
      const chosen = parsed?.value && pick(parsed.value);
      if (chosen) return chosen;
    }
    return null;
  }

  function bilibiliPartIndex() {
    const p = parseInt(new URLSearchParams(window.location.search).get("p") || "1", 10);
    return Number.isFinite(p) && p > 0 ? p : 1;
  }

  function bilibiliFilename() {
    const videoData = readBilibiliInlineJson("__INITIAL_STATE__", (state) =>
      state && state.videoData ? state.videoData : null
    );
    if (!videoData) return null;

    const pages = Array.isArray(videoData.pages) ? videoData.pages : [];
    if (pages.length > 1) {
      const page = pages[bilibiliPartIndex() - 1];
      const part = (page && (page.part || page.title) ? String(page.part || page.title) : "").trim();
      // A descriptive part name (e.g. "ep01 …") is the file name; a bare "P3" or
      // numeric label is prefixed with the collection title so it's meaningful.
      if (part && !/^\d+$/.test(part)) return part;
      if (part && videoData.title) return `${videoData.title} ${part}`;
    }
    return videoData.title || null;
  }

  function resolveBilibiliMedia() {
    if (!/(^|\.)bilibili\.com$/.test(window.location.hostname.toLowerCase())) return null;

    const data = readBilibiliPlayData();
    if (!data) return null;

    const filename = bilibiliFilename();
    // A stream lists a primary `baseUrl` plus `backupUrl` mirrors for the same
    // signed content; return them all (primary first) so a flaky mirror that
    // throws HTTP/2 errors can fall back to another host.
    const streamUrls = (stream) => {
      if (!stream) return [];
      const urls = [];
      const add = (u) => {
        if (typeof u === "string" && /^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u);
      };
      add(stream.baseUrl);
      add(stream.base_url);
      (stream.backupUrl || stream.backup_url || []).forEach(add);
      return urls;
    };

    const dash = data.dash;
    if (dash && Array.isArray(dash.video) && dash.video.length) {
      // `data.quality` is the best quality the viewer is actually entitled to
      // (what normal playback uses). Any representation above it is the VIP-only
      // trial clip, so cap the video pick there to keep it full-length.
      const entitled = Number(data.quality) || 0;
      let videos = dash.video.slice();
      if (entitled) {
        const full = videos.filter((v) => (Number(v.id) || 0) <= entitled);
        if (full.length) videos = full;
      }
      const video = videos.sort(
        (a, b) =>
          (Number(b.id) || 0) - (Number(a.id) || 0) ||
          (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0)
      )[0];

      const audio = (Array.isArray(dash.audio) ? dash.audio.slice() : []).sort(
        (a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0)
      )[0];

      const videoUrls = streamUrls(video);
      const audioUrls = streamUrls(audio);
      if (videoUrls.length && audioUrls.length) {
        return {
          mux: {
            videoUrl: videoUrls[0],
            audioUrl: audioUrls[0],
            videoUrls,
            audioUrls,
            // Fetch each stream with one sequential GET, like the player does.
            // Bilibili's mirror/PCDN nodes reject aggressive parallel Range
            // chunking with HTTP/2 resets or a 514 rate-limit response.
            singleGet: true,
          },
          filename,
        };
      }
    }

    // Older single-file (durl) videos — only usable when it's a real .mp4.
    if (Array.isArray(data.durl) && data.durl[0]?.url) {
      return { direct: data.durl[0].url, filename };
    }

    return null;
  }

  function getYouTubeVideoId() {
    const host = window.location.hostname.toLowerCase();
    const valid = (id) => (/^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null);

    if (host === "youtu.be") {
      return valid(window.location.pathname.split("/").filter(Boolean)[0] || "");
    }

    if (!/(^|\.)youtube(?:-nocookie)?\.com$/.test(host)) return null;

    const v = new URLSearchParams(window.location.search).get("v");
    if (v) return valid(v);

    // Embeds/shorts/live use a path id instead of ?v= (e.g. /embed/<id>). This
    // lets the resolver handle embedded players instead of falling back to the
    // sniffed, session-bound googlevideo URL (which 403s).
    const pathId = (window.location.pathname.match(/\/(?:embed|shorts|live|v)\/([a-zA-Z0-9_-]{11})/) || [])[1];
    return pathId ? valid(pathId) : null;
  }

  // Some sites hide the real MP4s behind an authorized XHR; the page's bare
  // .mp4 link 403s. Replicate the player's hash transform (4x 8-hex chunks ->
  // base36, no padding) and call the API. The returned URL is signed to the
  // caller's IP, so this must run in the page, not the background.
  function authorizedXhrHash(hash) {
    if (!/^[0-9a-f]{32}$/i.test(hash)) return null;
    let out = "";
    for (let i = 0; i < 32; i += 8) {
      out += parseInt(hash.substring(i, i + 8), 16).toString(36);
    }
    return out;
  }

  async function resolveAuthorizedXhrMediaUrl() {
    // Detect the scheme structurally (player-config hash + video id) rather than
    // by hostname, so no specific site is named. Sites that lack these markers
    // simply return null.
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    const rawHash = (html.match(/\.player\.hash\s*=\s*['"]([0-9a-f]{32})['"]/i) || [])[1];
    const apiHash = rawHash && authorizedXhrHash(rawHash);
    if (!apiHash) return null;

    const vid =
      (html.match(/\.player\.vid\s*=\s*['"](\w+)['"]/i) || [])[1] ||
      (window.location.pathname.match(/\/(?:video-|embed\/)(\w+)/) || [])[1];
    if (!vid) return null;

    const params = new URLSearchParams({
      hash: apiHash,
      domain: window.location.hostname,
      fallback: "false",
      embed: "false",
      supportedFormats: "dash,hls,mp4",
      _: String(Date.now()),
    });
    const response = await fetch(`${window.location.origin}/xhr/video/${vid}?${params}`, {
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    if (!response.ok) return null;

    const data = await response.json();
    const mp4 = (data && data.sources && data.sources.mp4) || {};
    let best = null;
    let bestResolution = -1;
    for (const [label, info] of Object.entries(mp4)) {
      if (label === "auto" || !info || typeof info.src !== "string") continue;
      const resolution = parseInt(label, 10) || 0; // "1080p HD" -> 1080
      if (resolution > bestResolution) {
        best = info.src;
        bestResolution = resolution;
      }
    }
    return best && /^https?:\/\//.test(best) ? best : null;
  }

  async function handleDownload(video) {
    let { direct, hls } = getLatestMediaUrls(video);
    const youtubeVideoId = getYouTubeVideoId();
    let mux = null;
    let mediaTitle = null;

    // The authorized-XHR URL overrides anything sniffed (the bare page link 403s).
    try {
      const authorized = await resolveAuthorizedXhrMediaUrl();
      if (authorized) {
        direct = authorized;
        hls = null;
      }
    } catch (e) {
      /* fall through to whatever was sniffed */
    }

    // Facebook is DASH: build a video+audio mux pair from the sniffed streams.
    try {
      const facebook = resolveFacebookMedia();
      if (facebook) {
        mux = facebook;
        direct = null;
        hls = null;
      } else if (/(^|\.)facebook\.com$/.test(window.location.hostname)) {
        // Don't fall through to a stray fbcdn segment (a single audio/video
        // stream from whatever last buffered) — that downloads the wrong,
        // audio-only file. Make the user play the target video instead.
        if (direct && /fbcdn\.net/i.test(direct)) direct = null;
      }
    } catch (e) {
      /* fall through */
    }

    // Bilibili is DASH with site-specific quirks (VIP trial clips, part titles).
    try {
      const bilibili = resolveBilibiliMedia();
      if (bilibili) {
        if (bilibili.mux) {
          mux = bilibili.mux;
          direct = null;
          hls = null;
        } else if (bilibili.direct) {
          direct = bilibili.direct;
          hls = null;
        }
        if (bilibili.filename) mediaTitle = bilibili.filename;
      }
    } catch (e) {
      /* fall through to the generic path */
    }

    // Sites that expose only an embedded DASH manifest (separate video+audio
    // streams) need those muxed; the generic sniffer finds no .mp4/.m3u8 URL.
    if (!mux) {
      try {
        const dashMux = resolveEmbeddedDashMedia();
        if (dashMux) {
          mux = dashMux;
          direct = null;
          hls = null;
        }
      } catch (e) {
        /* fall through to whatever was sniffed */
      }
    }

    if (!direct && !hls && !youtubeVideoId && !mux) {
      showTemporaryState("No media found", "error", 2400);
      return;
    }

    activeRequestId = `xvd-generic-${++requestSeq}-${Date.now()}`;
    const requestId = activeRequestId;
    paused = false;
    lastProgress = null;
    downloadCanceled = false;
    setButtonState("busy", "Fetching...");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "XVD_GENERIC_DOWNLOAD",
        requestId,
        direct,
        hls,
        youtubeVideoId,
        mux,
        filename: getDownloadFilename(video, mediaTitle),
      });

      if (downloadCanceled || activeRequestId !== requestId) return;

      if (!response?.ok) {
        throw new Error(response?.error || "Download failed");
      }

      activeRequestId = null;
      showTemporaryState("Saved", "done", 2200);
    } catch (error) {
      if (downloadCanceled || activeRequestId !== requestId) return;
      console.warn("[X Video Downloader generic]", error);
      activeRequestId = null;
      showTemporaryState("Failed", "error", 3000);
    }
  }

  function togglePause() {
    if (!activeRequestId) return;
    paused = !paused;
    chrome.runtime.sendMessage({
      type: paused ? "XVD_PAUSE" : "XVD_RESUME",
      requestId: activeRequestId,
    });
    renderProgress();
  }

  function renderProgress() {
    if (lastProgress == null) {
      button.textContent = paused ? "Resume" : "Fetching...";
      button.title = paused ? "Resume download" : "Pause download";
      return;
    }

    button.textContent = paused ? `Resume ${lastProgress}%` : `${lastProgress}%`;
    button.title = paused ? "Resume download" : "Pause download";
  }

  function cancelDownload() {
    if (!activeRequestId) return;

    downloadCanceled = true;
    chrome.runtime.sendMessage({
      type: "XVD_CANCEL",
      requestId: activeRequestId,
    });
    activeRequestId = null;
    paused = false;
    lastProgress = null;
    showTemporaryState("Canceled", "error", 1600);
  }

  function setButtonState(state, text) {
    button.dataset.state = state;
    button.textContent = text;
    button.disabled = false;
    button.classList.toggle("xvd-generic-busy", state === "busy");
    button.classList.toggle("xvd-generic-error", state === "error");
    button.classList.toggle("xvd-generic-done", state === "done");
    wrap.classList.toggle("xvd-generic-downloading", state === "busy");
    wrap.classList.add("xvd-generic-visible");
  }

  function showTemporaryState(text, state, timeout) {
    setButtonState(state, text);
    window.setTimeout(resetButton, timeout);
  }

  function resetButton() {
    button.dataset.state = "idle";
    button.textContent = "Download";
    button.title = "Download this video";
    button.disabled = false;
    button.classList.remove("xvd-generic-busy", "xvd-generic-error", "xvd-generic-done");
    wrap.classList.remove("xvd-generic-visible", "xvd-generic-downloading");
  }

  function wrapVideo(video) {
    if (seenVideos.has(video)) return;
    seenVideos.add(video);

    video.addEventListener("mouseenter", () => showButton(video));
    video.addEventListener("mousemove", () => positionButton(video));
    video.addEventListener("mouseleave", scheduleHide);
  }

  function scanVideos(root = document) {
    ensureButton();
    root.querySelectorAll("video").forEach(wrapVideo);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.("video")) wrapVideo(node);
        scanVideos(node);
      }
    }
  });

  scanVideos();
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  function positionButton(video) {
    if (!video) return;

    const rect = video.getBoundingClientRect();
    const inset = 8;
    const buttonWidth = wrap.offsetWidth || 120;
    const buttonHeight = wrap.offsetHeight || 36;
    const maxLeft = Math.max(inset, window.innerWidth - buttonWidth - inset);
    const maxTop = Math.max(inset, window.innerHeight - buttonHeight - inset);
    const top = Math.min(maxTop, Math.max(inset, rect.top + 12));
    const left = Math.min(maxLeft, Math.max(inset, rect.right - buttonWidth - 12));

    wrap.style.top = `${top}px`;
    wrap.style.left = `${left}px`;
  }

  function showButton(video) {
    if (!video) return;

    window.clearTimeout(hideTimer);
    activeVideo = video;
    positionButton(video);
    wrap.classList.add("xvd-generic-visible");
  }

  function scheduleHide() {
    hideTimer = window.setTimeout(() => {
      if (button.dataset.state === "busy" || button.dataset.state === "done") return;
      wrap.classList.remove("xvd-generic-visible");
      button.textContent = "Download";
    }, 250);
  }

  window.addEventListener("scroll", () => positionButton(activeVideo), { passive: true });
  window.addEventListener("resize", () => positionButton(activeVideo));

  document.addEventListener(
    "pointermove",
    (event) => {
      lastPointer = { x: event.clientX, y: event.clientY };
      const video = findVideoNearPointer(event.clientX, event.clientY);

      if (video) {
        showButton(video);
        return;
      }

      if (!isPointerOverButton(event.clientX, event.clientY)) {
        scheduleHide();
      }
    },
    true
  );

  function findVideoNearPointer(x, y) {
    const directVideo = document.elementFromPoint(x, y)?.closest?.("video");
    if (directVideo) return directVideo;

    const elements = document.elementsFromPoint(x, y);
    for (const element of elements) {
      if (element === wrap || wrap.contains(element)) continue;

      const direct = element.closest?.("video");
      if (direct) return direct;

      const container = element.closest?.(
        'article, [role="article"], [aria-label*="Video"], [aria-label*="video"]'
      );
      const video = container?.querySelector?.("video");
      if (video && isPointerInside(video, x, y)) return video;
    }

    for (const video of document.querySelectorAll("video")) {
      if (isPointerInside(video, x, y)) return video;
    }

    return null;
  }

  function isPointerInside(element, x, y) {
    const rect = element.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function isPointerOverButton(x, y) {
    return wrap.isConnected && isPointerInside(wrap, x, y);
  }

  window.setInterval(() => {
    collectSnifferCache();
    collectPerformanceMediaUrls();
    const video = findVideoNearPointer(lastPointer.x, lastPointer.y);
    if (video) showButton(video);
  }, 750);

  function handleMediaEvent(event) {
    try {
      const data = JSON.parse(event.detail);
      rememberMediaUrl(data.url, data.kind);
    } catch {
      // Ignore malformed media events.
    }
  }

  window.addEventListener(EVENT_NAME, handleMediaEvent);
  document.documentElement.addEventListener(EVENT_NAME, handleMediaEvent);
})();
