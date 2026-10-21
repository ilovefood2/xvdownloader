/*
 * X Video Downloader — media pipeline (Safari port).
 *
 * This is the former `offscreen.js`, refactored from a message-driven offscreen
 * document into a plain ES module that the background *page* imports and calls
 * directly.
 *
 * Why the change: Chrome ran this code in an offscreen document and talked to it
 * with chrome.runtime.sendMessage({ target: "offscreen" }). Safari has no
 * offscreen API, and a page can't runtime.sendMessage to a listener living in
 * the same page. So the background page now calls prepareDownload() / pauseJob()
 * / resumeJob() / cancelJob() as ordinary functions, and progress is delivered
 * through an onProgress callback instead of a runtime message.
 *
 * Runs at the extension origin (background page), so it can fetch cross-origin
 * media with host permissions and build blobs — same capabilities the offscreen
 * document had under Chrome.
 */
import { downloadDirect, downloadHls, downloadMux, DownloadControl } from "./hls.js";

// jobId -> DownloadControl, so the background page can pause/resume/cancel a job.
const controls = new Map();

export function pauseJob(jobId) {
  const c = controls.get(jobId);
  if (c) c.pause();
}

export function resumeJob(jobId) {
  const c = controls.get(jobId);
  if (c) c.resume();
}

export function cancelJob(jobId) {
  const c = controls.get(jobId);
  if (c) c.cancel();
}

/**
 * Fetch + assemble the requested media and return the finished bytes.
 *
 * @param {object} msg   { jobId, direct, hls, mux, credentials, allowTsFallback }
 * @param {object} opts  { onProgress?: (done, total, phase) => void }
 * @returns {Promise<{ blob: Blob, ext: string }>}
 */
export async function prepareDownload(msg, { onProgress } = {}) {
  const jobId = msg.jobId;
  const control = new DownloadControl();
  if (jobId != null) controls.set(jobId, control);

  const reportProgress = (done, total, phase) => {
    if (typeof onProgress === "function") {
      try {
        onProgress(done, total, phase);
      } catch {
        /* ignore listener errors */
      }
    }
  };

  const credentials = msg.credentials || "include";
  const allowTsFallback = msg.allowTsFallback === true;

  try {
    let result;
    if (msg.mux) {
      console.log("[XVD] preparing muxed video+audio");
      result = await downloadMux(
        msg.mux.videoUrls || msg.mux.videoUrl,
        msg.mux.audioUrls || msg.mux.audioUrl,
        {
          control,
          onProgress: reportProgress,
          credentials,
          chunkConcurrency: msg.mux.chunkConcurrency || 0,
          audioSingleGet: msg.mux.audioSingleGet === true,
        }
      );
    } else if (msg.direct) {
      console.log("[XVD] preparing direct MP4");
      try {
        result = await downloadDirect(msg.direct, {
          control,
          onProgress: reportProgress,
          credentials,
        });
      } catch (e) {
        if (!msg.hls) throw e;
        console.log("[XVD] direct MP4 failed, falling back to HLS:", e.message);
        result = await downloadHls(msg.hls, {
          control,
          onProgress: reportProgress,
          credentials,
          allowTsFallback,
        });
      }
    } else if (msg.hls) {
      console.log("[XVD] preparing HLS");
      result = await downloadHls(msg.hls, {
        control,
        onProgress: reportProgress,
        credentials,
        allowTsFallback,
      });
    } else {
      throw new Error("No downloadable video found");
    }

    // Return the raw Blob (not a blob URL). Blob URLs are origin-scoped, and the
    // content script that ultimately triggers the save lives on the page's
    // origin, so the background page streams the bytes over — see
    // deliverBlobToTab() in background.js.
    return { blob: result.blob, ext: result.ext };
  } finally {
    if (jobId != null) controls.delete(jobId);
  }
}
