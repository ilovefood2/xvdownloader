"use strict";

(() => {
  const CHANNEL = "XVD_YOUTUBE_SOLVER";
  const transfers = new Map();
  let port = null;

  function reply(requestId, type, payload = {}) {
    const message = { channel: CHANNEL, requestId, type, ...payload };
    if (port) port.postMessage(message);
    else parent.postMessage(message, "*");
  }

  function runSolver(requestId) {
    const transfer = transfers.get(requestId);
    if (!transfer) throw new Error("YouTube player transfer was not initialized");
    if (transfer.chunks.some((chunk) => typeof chunk !== "string")) {
      throw new Error("YouTube player transfer was incomplete");
    }
    if (typeof globalThis.jsc !== "function") {
      throw new Error("YouTube player challenge solver did not load");
    }

    const result = globalThis.jsc({
      type: "player",
      player: transfer.chunks.join(""),
      requests: [
        { type: "n", challenges: transfer.nChallenges },
        { type: "sig", challenges: transfer.sigChallenges },
      ],
      output_preprocessed: false,
    });
    if (!result || result.type === "error") {
      throw new Error(result?.error || "YouTube player challenge solver failed");
    }

    const [nResult, sigResult] = result.responses || [];
    if (nResult?.type === "error") throw new Error(nResult.error);
    if (sigResult?.type === "error") throw new Error(sigResult.error);
    reply(requestId, "result", {
      nSolutions: nResult?.data || {},
      sigSolutions: sigResult?.data || {},
    });
  }

  function handlePortMessage(event) {
    if (event.data?.channel !== CHANNEL) return;
    const { requestId, type } = event.data;

    try {
      if (type === "start") {
        const chunkCount = Number(event.data.chunkCount) || 0;
        if (chunkCount < 1 || chunkCount > 100) {
          throw new Error("Invalid YouTube player transfer size");
        }
        transfers.set(requestId, {
          chunks: new Array(chunkCount),
          nChallenges: event.data.nChallenges || [],
          sigChallenges: event.data.sigChallenges || [],
        });
        reply(requestId, "started");
      } else if (type === "chunk") {
        const transfer = transfers.get(requestId);
        const index = Number(event.data.index);
        if (
          !transfer ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= transfer.chunks.length
        ) {
          throw new Error("Invalid YouTube player chunk");
        }
        transfer.chunks[index] = String(event.data.chunk || "");
        reply(requestId, "chunk", { index });
      } else if (type === "run") {
        runSolver(requestId);
        transfers.delete(requestId);
      }
    } catch (error) {
      transfers.delete(requestId);
      reply(requestId, "error", {
        error: (error && error.message) || "YouTube player challenge solver failed",
      });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.channel !== CHANNEL) return;
    const { requestId, type } = event.data;
    if (type === "ping") {
      reply(requestId, "ready");
    } else if (type === "connect" && event.ports?.[0]) {
      if (port) port.close();
      port = event.ports[0];
      port.onmessage = handlePortMessage;
      port.start();
      reply(requestId, "connected");
    }
  });

  reply(null, "ready");
})();
