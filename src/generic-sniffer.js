/*
 * Generic website media sniffer.
 *
 * Runs outside x.com/twitter.com only. It records direct MP4 and HLS playlist
 * URLs seen in fetch/XHR traffic so the generic content script can hand them to
 * the existing offscreen/HLS pipeline.
 */
(() => {
  "use strict";

  if (window.__xvdGenericSnifferInstalled) return;
  window.__xvdGenericSnifferInstalled = true;

  const EVENT_NAME = "xvd-generic-media-url";
  const CACHE_ATTR = "xvdGenericMediaUrls";
  const MAX_CACHED_URLS = 80;
  const patterns = {
    mp4: /https?:\/\/[^"'\s<>\\]+?\.mp4(?:\/)?(?:[?#][^"'\s<>\\]*)?(?=["'\s<>\\]|$)/gi,
    hls: /https?:\/\/[^"'\s<>\\]+?\.m3u8(?:\/)?(?:[?#][^"'\s<>\\]*)?(?=["'\s<>\\]|$)/gi,
  };
  const cached = { mp4: [], hls: [] };

  function mediaKind(url, forcedKind) {
    if (forcedKind === "hls") return "hls";
    if (!url || typeof url !== "string") return null;
    if (url.startsWith("blob:") || url.startsWith("data:")) return null;

    try {
      const parsed = new URL(url, window.location.href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      const path = parsed.pathname + parsed.search;
      if (/\.mp4(?:[/?#]|$)/i.test(path)) return "mp4";
      if (/\.m3u8(?:[/?#]|$)/i.test(path)) return "hls";
      if (isLikelyHlsEndpoint(parsed)) return "hls";
    } catch {
      return null;
    }

    return null;
  }

  function isLikelyHlsEndpoint(parsed) {
    const path = parsed.pathname.toLowerCase();
    return (
      /(?:^|\/)(?:master)?playlist(?:\/|$)/i.test(path) ||
      /(?:^|\/)hls(?:\/|$)/i.test(path) ||
      /(?:^|\/)m3u8(?:\/|$)/i.test(path)
    );
  }

  function rememberUrl(url, forcedKind) {
    const kind = mediaKind(url, forcedKind);
    if (!kind) return;

    const absoluteUrl = new URL(url, window.location.href).href;
    const list = cached[kind];
    const existingIndex = list.indexOf(absoluteUrl);
    if (existingIndex !== -1) list.splice(existingIndex, 1);
    list.push(absoluteUrl);

    if (list.length > MAX_CACHED_URLS) {
      list.splice(0, list.length - MAX_CACHED_URLS);
    }

    const detail = JSON.stringify({ kind, url: absoluteUrl });
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));

    try {
      const root = document.documentElement;
      if (root) {
        root.dataset[CACHE_ATTR] = JSON.stringify(cached);
        root.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
      }
    } catch {
      // Some pages restrict DOM writes; the window event path can still work.
    }
  }

  function normalize(text) {
    return String(text)
      .replace(/\\u002F/g, "/")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");
  }

  function publish(text, sourceUrl) {
    if (typeof text !== "string") return;

    const normalized = normalize(text);

    if (sourceUrl && /^#EXTM3U\b/i.test(normalized.trim())) {
      rememberUrl(sourceUrl, "hls");
    }

    rememberUrl(normalized);

    for (const match of normalized.matchAll(patterns.mp4)) {
      rememberUrl(match[0]);
    }
    for (const match of normalized.matchAll(patterns.hls)) {
      rememberUrl(match[0]);
    }
  }

  function canReadAsText(response) {
    const type = response.headers?.get?.("content-type") || "";
    return /json|text|xml|mpegurl|vnd\.apple\.mpegurl|x-mpegurl|x-www-form-urlencoded/i.test(type);
  }

  function responseMediaKind(response) {
    const type = response.headers?.get?.("content-type") || "";
    if (/mpegurl|vnd\.apple\.mpegurl|x-mpegurl/i.test(type)) return "hls";
    return null;
  }

  if (typeof window.fetch === "function") {
    const originalFetch = window.fetch;
    window.fetch = async function xvdGenericFetch(...args) {
      const response = await originalFetch.apply(this, args);

      try {
        rememberUrl(response.url, responseMediaKind(response));
        if (canReadAsText(response)) {
          response.clone().text().then((text) => publish(text, response.url)).catch(() => {});
        }
      } catch {
        // Detection must never affect page networking.
      }

      return response;
    };
  }

  if (!window.XMLHttpRequest?.prototype) return;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function xvdGenericOpen(method, url, ...rest) {
    this.__xvdGenericUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function xvdGenericSend(...args) {
    this.addEventListener("load", () => {
      try {
        const responseUrl = this.responseURL || this.__xvdGenericUrl;
        const type = this.getResponseHeader?.("content-type") || "";
        rememberUrl(
          responseUrl,
          /mpegurl|vnd\.apple\.mpegurl|x-mpegurl/i.test(type) ? "hls" : null
        );

        if (!this.responseType || this.responseType === "text") {
          publish(this.responseText, responseUrl);
        }
      } catch {
        // Some response types throw when responseText is accessed.
      }
    });

    return originalSend.apply(this, args);
  };
})();
