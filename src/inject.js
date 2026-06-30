/*
 * X Video Downloader — page-context sniffer (runs in the MAIN world).
 *
 * X loads tweet/timeline data through its GraphQL API, and those responses
 * already contain the video variants (including direct MP4 URLs) for every
 * video the page shows — even age-restricted/sensitive ones, because the page
 * is authenticated. We hook fetch/XHR, scan GraphQL responses for video
 * variants keyed by tweet id, and hand them to the content script via
 * window.postMessage. No data leaves the browser.
 */
(() => {
  "use strict";

  const TAG = "XVD_MEDIA";

  /** Recursively pull { tweetId -> {lists, text} } out of an API response. */
  function harvest(node, out, depth) {
    if (!node || typeof node !== "object" || depth > 40) return;
    if (Array.isArray(node)) {
      for (const item of node) harvest(item, out, depth + 1);
      return;
    }

    const restId = node.rest_id || node.id_str;
    const legacy =
      node.legacy && typeof node.legacy === "object" ? node.legacy : null;
    const container = legacy || node;
    const media =
      (container.extended_entities && container.extended_entities.media) ||
      (container.entities && container.entities.media);

    if (restId && Array.isArray(media)) {
      for (const m of media) {
        if (m && m.video_info && Array.isArray(m.video_info.variants)) {
          const id = String(restId);
          const entry = out[id] || (out[id] = { lists: [], text: "" });
          entry.lists.push(m.video_info.variants);
          if (container.full_text && !entry.text) {
            entry.text = container.full_text;
          }
        }
      }
    }

    for (const key in node) {
      try {
        harvest(node[key], out, depth + 1);
      } catch (e) {
        /* ignore unreadable getters */
      }
    }
  }

  function scan(json) {
    try {
      const out = {};
      harvest(json, out, 0);
      if (Object.keys(out).length) {
        window.postMessage({ source: TAG, tweets: out }, "*");
      }
    } catch (e) {
      /* never let sniffing break the page */
    }
  }

  function isApiUrl(url) {
    return typeof url === "string" && /graphql|\/i\/api\//i.test(url);
  }

  // --- hook fetch -----------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === "function" && !origFetch.__xvd) {
    const wrapped = function (...args) {
      return origFetch.apply(this, args).then((resp) => {
        try {
          if (resp && isApiUrl(resp.url)) {
            resp
              .clone()
              .json()
              .then(scan)
              .catch(() => {});
          }
        } catch (e) {
          /* ignore */
        }
        return resp;
      });
    };
    wrapped.__xvd = true;
    window.fetch = wrapped;
  }

  // --- hook XMLHttpRequest ---------------------------------------------------
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && !XHR.prototype.__xvd) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__xvdUrl = url;
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      this.addEventListener("load", function () {
        try {
          if (isApiUrl(this.__xvdUrl) && this.responseType === "") {
            scan(JSON.parse(this.responseText));
          }
        } catch (e) {
          /* ignore non-JSON */
        }
      });
      return send.apply(this, arguments);
    };
    XHR.prototype.__xvd = true;
  }
})();
