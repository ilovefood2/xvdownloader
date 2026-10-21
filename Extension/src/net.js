/*
 * X Video Downloader — network layer with a page-context fallback (Safari port).
 *
 * The problem: media CDNs like YouTube's googlevideo reject requests that carry
 * the extension's Origin/Referer with HTTP 403. On Chrome the extension strips
 * those headers with declarativeNetRequest. On Safari that does NOT work —
 * Safari's declarativeNetRequest cannot modify headers on requests the extension
 * itself makes (confirmed by Apple). So an extension-origin fetch to a gated CDN
 * is unfixable from the background page.
 *
 * The fix: when a background-page fetch is refused (403) — or for a host we've
 * already learned is gated — re-issue the request from the *page* context. The
 * content script (download-bridge.js) runs on the originating tab (e.g.
 * youtube.com), so its fetch carries the page's real origin, which the CDN
 * accepts. It returns the bytes, and we rebuild a normal Response here so the
 * rest of the pipeline (hls.js) is unchanged.
 *
 * Everything that already works (x.com, direct MP4, permissive CDNs) keeps using
 * the fast native background fetch — the proxy only kicks in on a 403.
 */

let proxyTabId = null; // tab to route page-context fetches through
let proxyFrameId = null; // frame within that tab (the one that started the job)
let sendToTab = null; // (tabId, frameId, message) => Promise<response>
const gatedHosts = new Set(); // hosts we've learned must be proxied

// Wire up how to reach a tab (background.js passes chrome.tabs.sendMessage).
export function configureProxy(fn) {
  sendToTab = fn;
}

// Set/clear the tab+frame a job's fetches should fall back through.
export function setProxyTab(tabId, frameId) {
  proxyTabId = tabId == null ? null : tabId;
  proxyFrameId = frameId == null ? null : frameId;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function headersToObject(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const o = {};
    headers.forEach((v, k) => (o[k] = v));
    return o;
  }
  return { ...headers };
}

function base64ToBytes(b64) {
  const bin = atob(b64 || "");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Re-issue a request from the page/tab context and rebuild a Response.
async function fetchViaTab(url, options) {
  if (proxyTabId == null || !sendToTab) {
    throw new Error("No page context available to fetch " + url);
  }
  const method = (options && options.method) || "GET";
  const req = {
    url,
    method,
    headers: headersToObject(options && options.headers),
    credentials: (options && options.credentials) || "omit",
    // Forward a string body (e.g. YouTube's youtubei/v1/player JSON POST) so the
    // page-context request matches the extension's. GET/HEAD carry none.
    body:
      method !== "GET" && method !== "HEAD" && options && typeof options.body === "string"
        ? options.body
        : undefined,
    timeout: 60000,
  };
  const r = await sendToTab(proxyTabId, proxyFrameId, { type: "XVD_FETCH", req });
  if (!r || r.ok !== true) {
    throw new Error((r && r.error) || "Page-context fetch failed");
  }
  const bytes = base64ToBytes(r.bodyB64);
  // 204/205/304 must not carry a body; everything the pipeline fetches is 200/206.
  return new Response(bytes, {
    status: r.status,
    statusText: r.statusText || "",
    headers: r.headers || {},
  });
}

/**
 * Drop-in replacement for fetch() used by the pipeline. Tries the fast native
 * background fetch first; on a 403 (or for an already-known gated host) it falls
 * back to a page-context fetch through the originating tab.
 */
export async function smartFetch(url, options = {}) {
  const host = hostOf(url);

  // Known-gated host: skip the doomed background attempt entirely.
  if (host && gatedHosts.has(host) && proxyTabId != null && sendToTab) {
    return fetchViaTab(url, options);
  }

  let res;
  try {
    res = await fetch(url, options);
  } catch (e) {
    // Network-level failure (incl. some CORS rejections): try the page context.
    if (proxyTabId != null && sendToTab) {
      const viaTab = await fetchViaTab(url, options);
      if (host) gatedHosts.add(host);
      return viaTab;
    }
    throw e;
  }

  if (res.status === 403 && proxyTabId != null && sendToTab) {
    try {
      const viaTab = await fetchViaTab(url, options);
      if (host) gatedHosts.add(host); // remember, so siblings skip the 403 attempt
      return viaTab;
    } catch (e) {
      // Page context also failed — return the original 403 for normal handling.
      return res;
    }
  }

  return res;
}
