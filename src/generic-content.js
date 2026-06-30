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
  const MAX_REMEMBERED_URLS = 120;
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

  function getDownloadFilename(video) {
    const title =
      document.title || video.getAttribute("aria-label") || window.location.hostname || "video";
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

  function getYouTubeVideoId() {
    const host = window.location.hostname.toLowerCase();
    if (host === "youtu.be") {
      const id = window.location.pathname.split("/").filter(Boolean)[0] || "";
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    if (!/(^|\.)youtube\.com$/.test(host)) return null;

    const id = new URLSearchParams(window.location.search).get("v") || "";
    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  }

  // generic hides the real MP4s behind an authorized XHR; the page's bare
  // gvideo .mp4 link 403s. Replicate the player's hash transform (4x 8-hex
  // chunks -> base36, no padding) and call the API. The returned URL is signed
  // to the caller's IP, so this must run in the page, not the background.
  function genericApiHash(hash) {
    if (!/^[0-9a-f]{32}$/i.test(hash)) return null;
    let out = "";
    for (let i = 0; i < 32; i += 8) {
      out += parseInt(hash.substring(i, i + 8), 16).toString(36);
    }
    return out;
  }

  async function resolveGenericMediaUrl() {
    const host = window.location.hostname.toLowerCase();
    if (!/(^|\.)generic\.com$/.test(host)) return null;

    const vid = (window.location.pathname.match(/\/(?:video-|hd-porn\/|embed\/)(\w+)/) || [])[1];
    if (!vid) return null;

    const html = document.documentElement ? document.documentElement.innerHTML : "";
    const rawHash =
      (html.match(/EP\.video\.player\.hash\s*=\s*['"]([0-9a-f]{32})['"]/i) || [])[1] ||
      (html.match(/\bhash\s*[:=]\s*['"]([0-9a-f]{32})['"]/i) || [])[1];
    const apiHash = rawHash && genericApiHash(rawHash);
    if (!apiHash) return null;

    const params = new URLSearchParams({
      hash: apiHash,
      domain: host,
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

    // generic's authorized URL overrides anything sniffed (its bare page link 403s).
    try {
      const generic = await resolveGenericMediaUrl();
      if (generic) {
        direct = generic;
        hls = null;
      }
    } catch (e) {
      /* fall through to whatever was sniffed */
    }

    if (!direct && !hls && !youtubeVideoId) {
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
        filename: getDownloadFilename(video),
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
