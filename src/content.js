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

  /** Find the tweet status id that a given video belongs to. */
  function findTweetId(videoEl) {
    let el = videoEl;
    while (el && el !== document.body) {
      const links = el.querySelectorAll('a[href*="/status/"]');
      for (const a of links) {
        const m = (a.getAttribute("href") || "").match(/\/status\/(\d+)/);
        if (m) return m[1];
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

  async function handleClick(videoEl, btn) {
    if (btn.dataset.state === "busy") return;

    const tweetId = findTweetId(videoEl);
    if (!tweetId) {
      setButtonState(btn, "error", "No tweet id");
      return;
    }

    setButtonState(btn, "busy", "Fetching…");
    try {
      const res = await chrome.runtime.sendMessage({
        type: "XVD_DOWNLOAD",
        tweetId,
        index: videoIndex(videoEl),
      });
      if (res && res.ok) {
        setButtonState(btn, "done", "Downloading");
        setTimeout(() => setButtonState(btn, "idle", "Download"), 2500);
      } else {
        setButtonState(btn, "error", (res && res.error) || "Failed");
        setTimeout(() => setButtonState(btn, "idle", "Download"), 3500);
      }
    } catch (e) {
      setButtonState(btn, "error", "Failed");
      setTimeout(() => setButtonState(btn, "idle", "Download"), 3500);
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
      handleClick(videoEl, btn);
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
