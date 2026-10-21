/*
 * X Video Downloader — offscreen document (ES module).
 *
 * Thin adapter between the service worker and the shared HLS/media pipeline.
 * Runs at the extension origin, so it can fetch cross-origin media (host
 * permissions) and build blob URLs (which the MV3 service worker cannot).
 */
import { downloadDirect, downloadHls, downloadMux, DownloadControl } from "./hls.js";

const controls = new Map(); // jobId -> DownloadControl
const OFFSCREEN_VERSION = "1.11.54";
const YOUTUBE_SOLVER_CHANNEL = "XVD_YOUTUBE_SOLVER";
const youtubeSolverFrame = document.getElementById("xvd-youtube-solver");
const youtubeSolverRequests = new Map();
let youtubeSolverReady = false;
let youtubeSolverReadyPromise = null;
let youtubeSolverPort = null;
let youtubeSolverConnectPromise = null;
const YOUTUBE_SOLVER_CHUNK_SIZE = 64 * 1024;

function postToYouTubeSolverWindow(message, transfer = []) {
  if (!youtubeSolverFrame?.contentWindow) {
    throw new Error("YouTube player challenge solver is unavailable");
  }
  youtubeSolverFrame.contentWindow.postMessage(
    { channel: YOUTUBE_SOLVER_CHANNEL, ...message },
    "*",
    transfer
  );
}

function postToYouTubeSolver(message) {
  if (!youtubeSolverPort) {
    throw new Error("YouTube player challenge channel is unavailable");
  }
  youtubeSolverPort.postMessage({ channel: YOUTUBE_SOLVER_CHANNEL, ...message });
}

function ensureYouTubeSolverReady() {
  if (youtubeSolverReady) return Promise.resolve();
  if (youtubeSolverReadyPromise) return youtubeSolverReadyPromise;

  youtubeSolverReadyPromise = new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const ping = () => {
      if (youtubeSolverReady) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > 10000) {
        clearInterval(timer);
        youtubeSolverReadyPromise = null;
        reject(new Error("YouTube player challenge solver did not start"));
      } else {
        postToYouTubeSolverWindow({ type: "ping", requestId });
      }
    };
    const timer = setInterval(ping, 100);
    ping();
  });
  return youtubeSolverReadyPromise;
}

function handleYouTubeSolverMessage(data) {
  if (data?.channel !== YOUTUBE_SOLVER_CHANNEL) return;
  const pending = youtubeSolverRequests.get(data.requestId);
  if (!pending) return;
  if (data.type === "error") {
    youtubeSolverRequests.delete(data.requestId);
    clearTimeout(pending.timer);
    if (pending.ack) {
      clearTimeout(pending.ack.timer);
      pending.ack = null;
    }
    pending.reject(new Error(data.error || "YouTube player challenge solver failed"));
  } else if (data.type === "result") {
    youtubeSolverRequests.delete(data.requestId);
    clearTimeout(pending.timer);
    pending.resolve(data);
  } else if (
    pending.ack &&
    data.type === pending.ack.type &&
    (pending.ack.index == null || data.index === pending.ack.index)
  ) {
    const ack = pending.ack;
    pending.ack = null;
    clearTimeout(ack.timer);
    ack.resolve();
  }
}

window.addEventListener("message", (event) => {
  if (
    event.source === youtubeSolverFrame?.contentWindow &&
    event.data?.channel === YOUTUBE_SOLVER_CHANNEL &&
    event.data.type === "ready"
  ) {
    youtubeSolverReady = true;
  }
});

async function connectYouTubeSolver() {
  await ensureYouTubeSolverReady();
  if (youtubeSolverPort) return;
  if (youtubeSolverConnectPromise) return youtubeSolverConnectPromise;

  youtubeSolverConnectPromise = new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("YouTube player channel connection timed out"));
    }, 10000);

    channel.port1.onmessage = (event) => {
      if (
        event.data?.channel !== YOUTUBE_SOLVER_CHANNEL ||
        event.data.type !== "connected" ||
        event.data.requestId !== requestId
      ) {
        return;
      }
      clearTimeout(timer);
      youtubeSolverPort = channel.port1;
      youtubeSolverPort.onmessage = (message) =>
        handleYouTubeSolverMessage(message.data);
      youtubeSolverPort.onmessageerror = () => {
        youtubeSolverPort?.close();
        youtubeSolverPort = null;
        youtubeSolverConnectPromise = null;
      };
      resolve();
    };
    channel.port1.onmessageerror = () => {
      clearTimeout(timer);
      channel.port1.close();
      reject(new Error("YouTube player channel connection failed"));
    };
    channel.port1.start();
    postToYouTubeSolverWindow(
      { type: "connect", requestId },
      [channel.port2]
    );
  }).catch((error) => {
    youtubeSolverConnectPromise = null;
    throw error;
  });

  return youtubeSolverConnectPromise;
}

function waitForYouTubeSolverAck(requestId, type, index = null) {
  const pending = youtubeSolverRequests.get(requestId);
  if (!pending) return Promise.reject(new Error("YouTube player transfer ended"));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.ack?.timer === timer) pending.ack = null;
      reject(new Error(`YouTube player ${type} acknowledgement timed out`));
    }, 10000);
    pending.ack = { type, index, resolve, reject, timer };
  });
}

async function fetchPlayerScript(playerUrl) {
  try {
    const response = await fetch(playerUrl, {
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error("YouTube player script HTTP " + response.status);
    return await response.text();
  } catch (e) {
    if (e?.name === "TimeoutError") throw new Error("YouTube player script timed out");
    throw e;
  }
}

// Drop a dead solver channel and load a fresh sandbox document, so one bad
// state (e.g. the sandbox frame navigating away) can't fail every later solve.
function resetYouTubeSolver() {
  youtubeSolverPort?.close();
  youtubeSolverPort = null;
  youtubeSolverConnectPromise = null;
  youtubeSolverReady = false;
  youtubeSolverReadyPromise = null;
  youtubeSolverFrame.src = youtubeSolverFrame.getAttribute("src");
}

function isYouTubeSolverChannelError(error) {
  return /acknowledgement timed out|channel connection|channel is unavailable|did not start/i.test(
    (error && error.message) || ""
  );
}

async function solveYouTubePlayer(msg) {
  const playerJs =
    typeof msg.playerJs === "string" && msg.playerJs
      ? msg.playerJs
      : await fetchPlayerScript(msg.playerUrl);
  try {
    return await runYouTubeSolver(msg, playerJs);
  } catch (error) {
    if (!isYouTubeSolverChannelError(error)) throw error;
    console.warn("[XVD] YouTube solver channel lost, reloading sandbox:", error.message);
    resetYouTubeSolver();
    return await runYouTubeSolver(msg, playerJs);
  }
}

async function runYouTubeSolver(msg, playerJs) {
  await connectYouTubeSolver();
  const requestId = crypto.randomUUID();
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      youtubeSolverRequests.delete(requestId);
      reject(new Error("YouTube player challenge solver timed out"));
    }, 90000);
    youtubeSolverRequests.set(requestId, { resolve, reject, timer, ack: null });
  });

  try {
    const chunkCount = Math.ceil(playerJs.length / YOUTUBE_SOLVER_CHUNK_SIZE);
    let ack = waitForYouTubeSolverAck(requestId, "started");
    postToYouTubeSolver({
      type: "start",
      requestId,
      chunkCount,
      nChallenges: Array.isArray(msg.nChallenges) ? msg.nChallenges : [],
      sigChallenges: Array.isArray(msg.sigChallenges) ? msg.sigChallenges : [],
    });
    await ack;

    for (let index = 0; index < chunkCount; index++) {
      ack = waitForYouTubeSolverAck(requestId, "chunk", index);
      postToYouTubeSolver({
        type: "chunk",
        requestId,
        index,
        chunk: playerJs.slice(
          index * YOUTUBE_SOLVER_CHUNK_SIZE,
          (index + 1) * YOUTUBE_SOLVER_CHUNK_SIZE
        ),
      });
      await ack;
    }

    postToYouTubeSolver({ type: "run", requestId });
    return await result;
  } catch (error) {
    const pending = youtubeSolverRequests.get(requestId);
    if (pending) {
      youtubeSolverRequests.delete(requestId);
      clearTimeout(pending.timer);
      if (pending.ack) clearTimeout(pending.ack.timer);
    }
    throw error;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;

  if (msg.type === "XVD_OFFSCREEN_VERSION") {
    sendResponse({ ok: true, version: OFFSCREEN_VERSION });
    return false;
  }

  if (msg.type === "XVD_YOUTUBE_SOLVE") {
    solveYouTubePlayer(msg)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: (error && error.message) || "YouTube player challenge solver failed",
        })
      );
    return true;
  }

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

function reportProgress(jobId, done, total, phase) {
  if (jobId == null) return;
  chrome.runtime
    .sendMessage({ type: "XVD_PROGRESS", jobId, done, total, phase })
    .catch(() => {});
}

async function prepare(msg) {
  const jobId = msg.jobId;
  const control = new DownloadControl();
  if (jobId != null) controls.set(jobId, control);
  const onProgress = (done, total, phase) => reportProgress(jobId, done, total, phase);
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
          onProgress,
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
          onProgress,
          credentials,
          preferSingleGet: msg.directSingleGet === true,
        });
      } catch (e) {
        if (!msg.hls) throw e;
        console.log("[XVD] direct MP4 failed, falling back to HLS:", e.message);
        result = await downloadHls(msg.hls, {
          control,
          onProgress,
          credentials,
          allowTsFallback,
        });
      }
    } else if (msg.hls) {
      console.log("[XVD] preparing HLS");
      result = await downloadHls(msg.hls, {
        control,
        onProgress,
        credentials,
        allowTsFallback,
      });
    } else {
      throw new Error("No downloadable video found");
    }

    return { ok: true, blobUrl: URL.createObjectURL(result.blob), ext: result.ext };
  } finally {
    if (jobId != null) controls.delete(jobId);
  }
}
