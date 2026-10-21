/*
 * X Video Downloader — download bridge (Safari port).
 *
 * Safari Web Extensions have no chrome.downloads API, so the finished file can't
 * be saved from the background page. Instead, the background page streams the
 * bytes to this content script (which lives on the page's own origin), where we
 * rebuild the Blob and trigger a normal `<a download>` save.
 *
 * This runs on every page alongside content.js / generic-content.js. It only
 * touches XVD_SAVE_* messages; progress/pause/cancel are handled by the buttons.
 *
 * Wire protocol (background -> this script), one save at a time per saveId:
 *   { type: "XVD_SAVE_BEGIN", saveId, filename, mime }
 *   { type: "XVD_SAVE_CHUNK", saveId, seq, b64 }   // many, in order
 *   { type: "XVD_SAVE_END",   saveId }
 *   { type: "XVD_SAVE_ABORT", saveId }
 * Each message is answered with { ok } so the background applies backpressure.
 */
(() => {
  "use strict";

  // A bridge is injected for both content.js and generic-content.js; make sure
  // only one instance installs the listener on a given page/frame.
  if (window.__xvdBridgeInstalled) return;
  window.__xvdBridgeInstalled = true;

  const api = globalThis.chrome || globalThis.browser;

  // saveId -> { filename, mime, chunks: Uint8Array[] }
  const saves = new Map();

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let bin = "";
    const SUB = 0x8000; // 32 KB per fromCharCode call
    for (let i = 0; i < bytes.length; i += SUB) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + SUB));
    }
    return btoa(bin);
  }

  // --- page-context fetch proxy --------------------------------------------
  // net.js (background) falls back to this when a gated CDN 403s the extension's
  // own fetch. Running here means the request carries the page's real origin,
  // which the CDN accepts. Returns the bytes + status + headers to rebuild a
  // Response on the background side.
  async function pageFetch(req) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeout || 60000);
    try {
      const hasHeaders = req.headers && Object.keys(req.headers).length > 0;
      const method = req.method || "GET";
      const res = await fetch(req.url, {
        method,
        headers: hasHeaders ? req.headers : undefined,
        credentials: req.credentials || "omit",
        cache: "no-store",
        body: method !== "GET" && method !== "HEAD" ? req.body : undefined,
        signal: controller.signal,
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      const headers = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return {
        ok: true,
        status: res.status,
        statusText: res.statusText,
        headers,
        bodyB64: bytesToB64(buf),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "XVD_FETCH") return; // not ours
    pageFetch(msg.req)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({ ok: false, error: (e && e.message) || "page fetch failed" })
      );
    return true; // async response
  });

  function triggerSave(filename, mime, chunks) {
    const blob = new Blob(chunks, { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "video.mp4";
    a.rel = "noopener";
    a.style.display = "none";
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    // Keep the object URL alive long enough for Safari to commit the download,
    // then reclaim the memory.
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }, 90_000);
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("XVD_SAVE_")) {
      return; // not ours — let other listeners handle it
    }

    if (msg.type === "XVD_SAVE_BEGIN") {
      saves.set(msg.saveId, {
        filename: msg.filename,
        mime: msg.mime,
        chunks: [],
      });
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "XVD_SAVE_CHUNK") {
      const rec = saves.get(msg.saveId);
      if (!rec) {
        sendResponse({ ok: false, error: "no such save" });
        return false;
      }
      try {
        rec.chunks.push(b64ToBytes(msg.b64));
        sendResponse({ ok: true });
      } catch (e) {
        saves.delete(msg.saveId);
        sendResponse({ ok: false, error: (e && e.message) || "decode failed" });
      }
      return false;
    }

    if (msg.type === "XVD_SAVE_END") {
      const rec = saves.get(msg.saveId);
      saves.delete(msg.saveId);
      if (!rec) {
        sendResponse({ ok: false, error: "no such save" });
        return false;
      }
      try {
        triggerSave(rec.filename, rec.mime, rec.chunks);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || "save failed" });
      }
      return false;
    }

    if (msg.type === "XVD_SAVE_ABORT") {
      saves.delete(msg.saveId);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
})();
