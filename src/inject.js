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
  const REQUEST_TAG = "XVD_MEDIA_REQUEST";
  const harvestedTweets = {};

  function addVariants(out, id, variants, text) {
    if (!id || !Array.isArray(variants) || !variants.some((v) => v && v.url)) {
      return;
    }
    const entry = out[id] || (out[id] = { lists: [], text: "" });
    entry.lists.push(variants);
    if (text && !entry.text) entry.text = text;
  }

  // Unified cards serialize their media entities inside a JSON string instead
  // of exposing them as normal tweet `extended_entities`. Associate those
  // variants with the containing tweet id, not the card media id.
  function harvestUnifiedCard(node, out, tweetId, text) {
    const bindings =
      node &&
      node.card &&
      node.card.legacy &&
      node.card.legacy.binding_values;
    if (!tweetId || !Array.isArray(bindings)) return;

    for (const binding of bindings) {
      if (!binding || binding.key !== "unified_card") continue;
      const raw = binding.value && binding.value.string_value;
      if (typeof raw !== "string" || raw[0] !== "{") continue;
      try {
        const card = JSON.parse(raw);
        const entities = card && card.media_entities;
        if (!entities || typeof entities !== "object") continue;
        for (const media of Object.values(entities)) {
          addVariants(out, tweetId, media && media.video_info && media.video_info.variants, text);
        }
      } catch (e) {
        /* ignore malformed card payloads */
      }
    }
  }

  function mergeHarvested(incoming) {
    for (const id in incoming) {
      const source = incoming[id];
      const target =
        harvestedTweets[id] || (harvestedTweets[id] = { lists: [], text: "" });
      const seen = new Set(target.lists.map((list) => list[0] && list[0].url));
      for (const list of source.lists || []) {
        const key = list[0] && list[0].url;
        if (key && !seen.has(key)) {
          seen.add(key);
          target.lists.push(list);
        }
      }
      if (source.text && !target.text) target.text = source.text;
    }
  }

  function publish(tweets) {
    if (!Object.keys(tweets).length) return;
    mergeHarvested(tweets);
    window.postMessage({ source: TAG, tweets }, "*");
  }

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

    harvestUnifiedCard(node, out, restId && String(restId), container.full_text || "");

    if (restId && Array.isArray(media)) {
      for (const m of media) {
        if (m && m.video_info && Array.isArray(m.video_info.variants)) {
          addVariants(out, String(restId), m.video_info.variants, container.full_text || "");
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
      publish(out);
    } catch (e) {
      /* never let sniffing break the page */
    }
  }

  // The MAIN-world sniffer starts at document_start, while the isolated
  // content script starts at document_idle. Replay anything harvested before
  // its listener existed so initial TweetDetail responses are not lost.
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== REQUEST_TAG) {
      return;
    }
    if (Object.keys(harvestedTweets).length) {
      window.postMessage({ source: TAG, tweets: harvestedTweets }, "*");
    }
  });

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
