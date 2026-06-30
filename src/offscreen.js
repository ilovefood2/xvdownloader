/*
 * X Video Downloader — offscreen document (ES module).
 *
 * Thin adapter between the service worker and the shared HLS/media pipeline.
 * Runs at the extension origin, so it can fetch cross-origin media (host
 * permissions) and build blob URLs (which the MV3 service worker cannot).
 */
import { downloadDirect, downloadHls, DownloadControl } from "./hls.js";

const controls = new Map(); // jobId -> DownloadControl

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;

  if (msg.type === "XVD_PREPARE") {
    prepare(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || "Download failed" }));
    return true; // async response
  }

  const control = controls.get(msg.jobId);
  if (msg.type === "XVD_PAUSE") {
    if (control) control.pause();
    sendResponse({ ok: true });
  } else if (msg.type === "XVD_RESUME") {
    if (control) control.resume();
    sendResponse({ ok: true });
  } else if (msg.type === "XVD_CANCEL") {
    if (control) control.cancel();
    sendResponse({ ok: true });
  } else if (msg.type === "XVD_REVOKE") {
    try {
      URL.revokeObjectURL(msg.blobUrl);
    } catch (e) {
      /* ignore */
    }
    sendResponse({ ok: true });
  }
  return false;
});

function reportProgress(jobId, done, total) {
  if (jobId == null) return;
  chrome.runtime
    .sendMessage({ type: "XVD_PROGRESS", jobId, done, total })
    .catch(() => {});
}

async function prepare(msg) {
  const jobId = msg.jobId;
  const control = new DownloadControl();
  if (jobId != null) controls.set(jobId, control);
  const onProgress = (done, total) => reportProgress(jobId, done, total);
  const credentials = msg.credentials || "include";

  try {
    let result;
    if (msg.direct) {
      console.log("[XVD] preparing direct MP4");
      try {
        result = await downloadDirect(msg.direct, {
          control,
          onProgress,
          credentials,
        });
      } catch (e) {
        if (!msg.hls) throw e;
        console.log("[XVD] direct MP4 failed, falling back to HLS:", e.message);
        result = await downloadHls(msg.hls, {
          control,
          onProgress,
          credentials,
        });
      }
    } else if (msg.hls) {
      console.log("[XVD] preparing HLS");
      result = await downloadHls(msg.hls, {
        control,
        onProgress,
        credentials,
      });
    } else {
      throw new Error("No downloadable video found");
    }

    return { ok: true, blobUrl: URL.createObjectURL(result.blob), ext: result.ext };
  } finally {
    if (jobId != null) controls.delete(jobId);
  }
}
