/*
 * Generic website hover button.
 *
 * Runs outside x.com/twitter.com only. X.com keeps using the original scripts.
 */
(() => {
  "use strict";

  const BUTTON_CLASS = "xvd-generic-button";
  const EVENT_NAME = "xvd-generic-media-url";
  const CACHE_ATTR = "xvdGenericMediaUrls";
  const MAX_REMEMBERED_URLS = 120;

  const seenVideos = new WeakSet();
  const mediaUrls = { mp4: [], hls: [] };
  let activeVideo = null;
  let hideTimer = null;
  let lastPointer = { x: 0, y: 0 };
  let requestSeq = 0;
  let activeRequestId = null;
  let paused = false;
  let lastProgress = null;

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

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "XVD_PROGRESS" || msg.requestId !== activeRequestId) return;
    if (!msg.total) return;
    lastProgress = Math.min(99, Math.floor((msg.done / msg.total) * 100));
    renderProgress();
  });

  function ensureButton() {
    if (!button.isConnected && document.body) {
      document.body.appendChild(button);
    }
  }

  function mediaKind(url) {
    if (!url || typeof url !== "string") return null;
    if (url.startsWith("blob:") || url.startsWith("data:")) return null;

    try {
      const parsed = new URL(url, window.location.href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      const path = parsed.pathname + parsed.search;
      if (/\.mp4(\?|$)/i.test(path)) return "mp4";
      if (/\.m3u8(\?|$)/i.test(path)) return "hls";
    } catch {
      return null;
    }

    return null;
  }

  function rememberMediaUrl(url, forcedKind) {
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
    const rawCache = document.documentElement?.dataset?.[CACHE_ATTR];
    if (!rawCache) return;

    try {
      const cached = JSON.parse(rawCache);
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
    collectSnifferCache();
    collectPerformanceMediaUrls();
    const elementUrls = getMediaUrlFromElement(video);

    return {
      direct: elementUrls.direct || mediaUrls.mp4[mediaUrls.mp4.length - 1] || null,
      hls: elementUrls.hls || mediaUrls.hls[mediaUrls.hls.length - 1] || null,
    };
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

  async function handleDownload(video) {
    const { direct, hls } = getLatestMediaUrls(video);
    if (!direct && !hls) {
      showTemporaryState("No media found", "error", 2400);
      return;
    }

    activeRequestId = `xvd-generic-${++requestSeq}-${Date.now()}`;
    paused = false;
    lastProgress = null;
    setButtonState("busy", "Fetching...");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "XVD_GENERIC_DOWNLOAD",
        requestId: activeRequestId,
        direct,
        hls,
        filename: getDownloadFilename(video),
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Download failed");
      }

      activeRequestId = null;
      showTemporaryState("Saved", "done", 2200);
    } catch (error) {
      console.warn("[X Video Downloader generic]", error);
      activeRequestId = null;
      showTemporaryState("Failed", "error", 3000);
    }
  }

  function togglePause() {
    if (!activeRequestId || lastProgress == null) return;
    paused = !paused;
    chrome.runtime.sendMessage({
      type: paused ? "XVD_PAUSE" : "XVD_RESUME",
      requestId: activeRequestId,
    });
    renderProgress();
  }

  function renderProgress() {
    if (lastProgress == null) return;
    button.textContent = paused ? `Resume ${lastProgress}%` : `${lastProgress}%`;
    button.title = paused ? "Resume download" : "Pause download";
  }

  function setButtonState(state, text) {
    button.dataset.state = state;
    button.textContent = text;
    button.disabled = false;
    button.classList.toggle("xvd-generic-busy", state === "busy");
    button.classList.toggle("xvd-generic-error", state === "error");
    button.classList.toggle("xvd-generic-done", state === "done");
    button.classList.add("xvd-generic-visible");
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
    button.classList.remove("xvd-generic-visible");
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
    const buttonWidth = button.offsetWidth || 120;
    const buttonHeight = button.offsetHeight || 36;
    const maxLeft = Math.max(inset, window.innerWidth - buttonWidth - inset);
    const maxTop = Math.max(inset, window.innerHeight - buttonHeight - inset);
    const top = Math.min(maxTop, Math.max(inset, rect.top + 12));
    const left = Math.min(maxLeft, Math.max(inset, rect.right - buttonWidth - 12));

    button.style.top = `${top}px`;
    button.style.left = `${left}px`;
  }

  function showButton(video) {
    if (!video) return;

    window.clearTimeout(hideTimer);
    activeVideo = video;
    positionButton(video);
    button.classList.add("xvd-generic-visible");
  }

  function scheduleHide() {
    hideTimer = window.setTimeout(() => {
      if (button.dataset.state === "busy" || button.dataset.state === "done") return;
      button.classList.remove("xvd-generic-visible");
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
      if (element === button || button.contains(element)) continue;

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
    return button.isConnected && isPointerInside(button, x, y);
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
