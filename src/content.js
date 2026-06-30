/*
 * X Video Downloader — content script
 *
 * Watches for <video> elements inside tweets on x.com / twitter.com and shows
 * a "Download" button when the cursor is over a video. Clicking it resolves the
 * tweet's highest-quality MP4 (via the background service worker) and downloads
 * it.
 */
(() => {
  "use strict";

  const BTN_CLASS = "xvd-download-btn";
  const WRAP_CLASS = "xvd-btn-wrap";

  // Video variants sniffed from X's own API responses (filled by inject.js),
  // keyed by tweet id: id -> { lists: variants[][], text: string }.
  const mediaCache = new Map();

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.source !== "XVD_MEDIA" || !data.tweets) return;
    for (const id in data.tweets) {
      const incoming = data.tweets[id];
      const cur = mediaCache.get(id) || { lists: [], text: "" };
      const seen = new Set(cur.lists.map((l) => l[0] && l[0].url));
      for (const list of incoming.lists || []) {
        const key = list[0] && list[0].url;
        if (key && !seen.has(key)) {
          seen.add(key);
          cur.lists.push(list);
        }
      }
      if (incoming.text && !cur.text) cur.text = incoming.text;
      mediaCache.set(id, cur);
    }
  });

  /** Find the tweet status id (and author handle) a given video belongs to. */
  function findTweetRef(videoEl) {
    let el = videoEl;
    while (el && el !== document.body) {
      const links = el.querySelectorAll('a[href*="/status/"]');
      for (const a of links) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
        if (m) return { author: m[1], id: m[2] };
        const idOnly = href.match(/\/status\/(\d+)/);
        if (idOnly) return { author: "", id: idOnly[1] };
      }
      el = el.parentElement;
    }
    return null;
  }

  /** Index of this video among sibling videos within the same tweet article. */
  function videoIndex(videoEl) {
    const article = videoEl.closest("article") || document;
    const videos = Array.from(article.querySelectorAll("video"));
    const idx = videos.indexOf(videoEl);
    return idx < 0 ? 0 : idx;
  }

  /** The positioned container we attach the button to (the video's wrapper). */
  function getMountTarget(videoEl) {
    // Prefer X's video component wrapper; fall back to the video's parent.
    return (
      videoEl.closest('[data-testid="videoComponent"]') ||
      videoEl.closest('[data-testid="videoPlayer"]') ||
      videoEl.parentElement
    );
  }

  function setButtonState(btn, state, text) {
    btn.dataset.state = state;
    btn.querySelector(".xvd-label").textContent = text;
    btn.classList.toggle("xvd-busy", state === "busy");
    btn.classList.toggle("xvd-error", state === "error");
    btn.classList.toggle("xvd-done", state === "done");
  }

  function makeButton() {
    const wrap = document.createElement("div");
    wrap.className = WRAP_CLASS;

    const btn = document.createElement("button");
    btn.className = BTN_CLASS;
    btn.type = "button";
    btn.title = "Download this video";
    btn.innerHTML =
      '<svg class="xvd-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1Z"/>' +
      '<path fill="currentColor" d="M5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z"/>' +
      "</svg>" +
      '<span class="xvd-label">Download</span>';
    wrap.appendChild(btn);
    return { wrap, btn };
  }

  // Progress updates (sent from the background while merging HLS) are routed
  // back to the originating button via a per-click request id.
  let requestSeq = 0;
  const jobButtons = new Map(); // requestId -> button

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "XVD_PROGRESS") return;
    const btn = jobButtons.get(msg.requestId);
    if (!btn || btn.dataset.state !== "busy") return;
    if (!msg.total) return;
    const pct = Math.min(99, Math.floor((msg.done / msg.total) * 100));
    btn.xvdPct = pct; // remember for pause/resume labels
    renderProgress(btn);
  });

  // Render the busy-state label, reflecting pause and latest percentage.
  function renderProgress(btn) {
    const label = btn.querySelector(".xvd-label");
    if (!label) return;
    if (btn.xvdPct == null) return; // still "Fetching…" (no segments yet)
    label.textContent = btn.xvdPaused ? "▶ " + btn.xvdPct + "%" : btn.xvdPct + "%";
  }

  // Pause/resume an in-progress (HLS) download by clicking the busy button.
  function togglePause(btn) {
    if (btn.xvdPct == null || !btn.xvdRequestId) return; // nothing pausable yet
    btn.xvdPaused = !btn.xvdPaused;
    btn.classList.toggle("xvd-paused", btn.xvdPaused);
    btn.title = btn.xvdPaused ? "Resume download" : "Pause download";
    chrome.runtime.sendMessage({
      type: btn.xvdPaused ? "XVD_PAUSE" : "XVD_RESUME",
      requestId: btn.xvdRequestId,
    });
    renderProgress(btn);
  }

  async function handleClick(videoEl, btn) {
    if (btn.dataset.state === "busy") return;

    const ref = findTweetRef(videoEl);
    if (!ref) {
      setButtonState(btn, "error", "No tweet id");
      return;
    }

    const requestId = "xvd-" + ++requestSeq + "-" + Date.now();
    jobButtons.set(requestId, btn);
    btn.xvdRequestId = requestId;
    btn.xvdPct = null;
    btn.xvdPaused = false;
    btn.classList.remove("xvd-paused");
    setButtonState(btn, "busy", "Fetching…");
    try {
      const cached = mediaCache.get(ref.id);
      const res = await chrome.runtime.sendMessage({
        type: "XVD_DOWNLOAD",
        requestId,
        tweetId: ref.id,
        author: ref.author,
        index: videoIndex(videoEl),
        cached:
          cached && cached.lists.length
            ? { lists: cached.lists, text: cached.text }
            : null,
      });
      if (res && res.ok) {
        setButtonState(btn, "done", "Saved");
        setTimeout(() => setButtonState(btn, "idle", "Download"), 2500);
      } else {
        setButtonState(btn, "error", (res && res.error) || "Failed");
        setTimeout(() => setButtonState(btn, "idle", "Download"), 3500);
      }
    } catch (e) {
      setButtonState(btn, "error", "Failed");
      setTimeout(() => setButtonState(btn, "idle", "Download"), 3500);
    } finally {
      jobButtons.delete(requestId);
      btn.xvdRequestId = null;
      btn.xvdPaused = false;
      btn.classList.remove("xvd-paused");
      btn.title = "Download this video";
    }
  }

  function attach(videoEl) {
    if (videoEl.dataset.xvdAttached) return;
    videoEl.dataset.xvdAttached = "1";

    const mount = getMountTarget(videoEl);
    if (!mount) return;

    // Ensure the mount can host an absolutely-positioned child.
    if (getComputedStyle(mount).position === "static") {
      mount.style.position = "relative";
    }

    const { wrap, btn } = makeButton();
    setButtonState(btn, "idle", "Download");
    mount.appendChild(wrap);

    const show = () => wrap.classList.add("xvd-visible");
    const hide = () => {
      if (btn.dataset.state === "busy" || btn.dataset.state === "done") return;
      wrap.classList.remove("xvd-visible");
    };

    mount.addEventListener("mouseenter", show);
    mount.addEventListener("mouseleave", hide);

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // While a download is running, the button acts as pause/resume.
      if (btn.dataset.state === "busy") togglePause(btn);
      else handleClick(videoEl, btn);
    });
  }

  function scan(root) {
    const videos = (root.querySelectorAll
      ? root.querySelectorAll("video")
      : []) || [];
    videos.forEach(attach);
    if (root.tagName === "VIDEO") attach(root);
  }

  // Initial pass.
  scan(document);

  // X is a SPA; watch for newly-rendered tweets/videos.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) scan(node);
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
