/*
 * YouTube proof-token + player challenge helper.
 *
 * This script runs only on youtube.com in the page's MAIN world. Token minting
 * happens in a temporary same-origin frame so BotGuard sees the genuine YouTube
 * origin without touching the live player global. The frame is always removed.
 */
(() => {
  "use strict";

  if (window.__xvdYouTubeHelperInstalled) return;
  window.__xvdYouTubeHelperInstalled = true;

  const CHANNEL = "XVD_YOUTUBE_PAGE_HELPER";
  const INTEGRITY_KEY = "O43z0dpjhgX20SCx4KAo";
  const GENERATE_IT_URL = "/api/jnn/v1/GenerateIT";
  const STEP_TIMEOUT_MS = 15000;
  let bootstrapCache = null;

  // Name the step that stalls, so a hang surfaces as a specific error instead
  // of the content script's generic overall timeout.
  function withTimeout(promise, step) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("YouTube token " + step + " timed out")),
          STEP_TIMEOUT_MS
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function decodeBase64(value, frameWindow) {
    const normalized = String(value)
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .replace(/\./g, "=");
    const decoded = atob(normalized);
    const bytes = new frameWindow.Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return bytes;
  }

  function encodeBase64Url(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
  }

  function extractObjectAt(text, markerIndex) {
    const start = text.indexOf("{", markerIndex);
    if (start < 0) return "";

    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) return text.slice(start, i + 1);
    }
    return "";
  }

  function parseLooseJson(raw) {
    const decoded = raw.replace(/\\x([0-9a-f]{2})/gi, (_match, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
    let json = decoded.replace(/,\s*([}\]])/g, "$1");
    json = json.replace(/'((?:[^'\\]|\\[\s\S])*)'/g, (_match, value) =>
      JSON.stringify(value.replace(/\\'/g, "'"))
    );
    json = json.replace(/([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g, '$1"$2":');

    const value = JSON.parse(json);
    for (const key of Object.keys(value)) {
      const nested = value[key];
      if (
        typeof nested === "string" &&
        (nested.trim().startsWith("{") || nested.trim().startsWith("["))
      ) {
        try {
          value[key] = JSON.parse(nested);
        } catch {
          /* keep the original string */
        }
      }
    }
    return value;
  }

  async function loadBootstrap() {
    if (bootstrapCache?.expiresAt > Date.now()) return bootstrapCache.value;

    const html = await withTimeout(
      fetch("/?themeRefresh=1", {
        credentials: "omit",
        cache: "no-store",
        headers: { "Accept-Language": "en-US,en;q=0.9" },
      }).then((response) => {
        if (!response.ok) throw new Error("YouTube token page HTTP " + response.status);
        return response.text();
      }),
      "page"
    );

    const eventIndex = html.indexOf('"EVENT_ID"');
    const configIndex = html.lastIndexOf("ytcfg.set(", eventIndex);
    const attestationIndex = html.indexOf("window.ytAtN({");
    const configRaw = extractObjectAt(html, configIndex);
    const attestationRaw = extractObjectAt(html, attestationIndex);
    if (!configRaw || !attestationRaw) {
      throw new Error("YouTube token challenge was not present");
    }

    const ytcfg = parseLooseJson(configRaw);
    const challenge = parseLooseJson(attestationRaw)?.R?.bgChallenge;
    const interpreterPath =
      challenge?.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
    if (!challenge?.program || !challenge?.globalName || !interpreterPath) {
      throw new Error("YouTube token challenge was incomplete");
    }

    const interpreterUrl = interpreterPath.startsWith("//")
      ? "https:" + interpreterPath
      : interpreterPath;
    const value = { challenge, interpreterUrl, ytcfg };
    bootstrapCache = { value, expiresAt: Date.now() + 10 * 60 * 1000 };
    return value;
  }

  function loadFrame(frame) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("YouTube token frame timed out")), 10000);
      frame.addEventListener(
        "load",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      frame.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("YouTube token frame failed"));
        },
        { once: true }
      );
    });
  }

  function loadScript(frameWindow, src) {
    return new Promise((resolve, reject) => {
      const script = frameWindow.document.createElement("script");
      const timer = setTimeout(
        () => reject(new Error("YouTube token interpreter timed out")),
        10000
      );
      script.src = src;
      script.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      script.onerror = () => {
        clearTimeout(timer);
        reject(new Error("YouTube token interpreter failed"));
      };
      frameWindow.document.documentElement.appendChild(script);
    });
  }

  async function mintPoToken(contentBinding) {
    const { BotGuardClient } = window.XVDYouTubeBg || {};
    if (!BotGuardClient) {
      throw new Error("YouTube proof-token library did not load");
    }
    const bootstrap = await loadBootstrap();
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    frame.src = "/robots.txt?xvd=" + Date.now();
    document.documentElement.appendChild(frame);

    let client;
    try {
      await loadFrame(frame);
      const frameWindow = frame.contentWindow;
      if (!frameWindow) throw new Error("YouTube token frame was unavailable");

      frameWindow.yt = { config_: bootstrap.ytcfg };
      await loadScript(frameWindow, bootstrap.interpreterUrl);
      client = await withTimeout(
        BotGuardClient.create({
          program: bootstrap.challenge.program,
          globalName: bootstrap.challenge.globalName,
          globalObject: frameWindow,
        }),
        "challenge"
      );

      const webPoSignalOutput = [];
      const botguardResponse = await withTimeout(
        client.snapshot({ webPoSignalOutput }),
        "snapshot"
      );
      if (typeof webPoSignalOutput[0] !== "function") {
        throw new Error("YouTube token minter was not initialized");
      }

      const integrity = await withTimeout(
        fetch(GENERATE_IT_URL, {
          method: "POST",
          credentials: "omit",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json+protobuf",
            "X-Goog-Api-Key": "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw",
            "X-User-Agent": "grpc-web-javascript/0.1",
          },
          body: JSON.stringify([INTEGRITY_KEY, botguardResponse]),
        }).then((response) => {
          if (!response.ok) throw new Error("YouTube integrity HTTP " + response.status);
          return response.json();
        }),
        "integrity"
      );
      const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
        integrity;
      if (!integrityToken) throw new Error("YouTube returned an empty integrity token");
      void estimatedTtlSecs;
      void mintRefreshThreshold;
      void websafeFallbackToken;

      // The minter function belongs to the iframe's JavaScript realm, where
      // `instanceof Function` in the parent is false despite it being callable.
      // Keep all token primitives in that realm and encode the result here.
      const getMinter = webPoSignalOutput[0];
      const mint = await withTimeout(
        getMinter(decodeBase64(integrityToken, frameWindow)),
        "minter"
      );
      if (typeof mint !== "function") throw new Error("YouTube token minter failed");
      const tokenBytes = await withTimeout(
        mint(new frameWindow.TextEncoder().encode(contentBinding)),
        "mint"
      );
      if (!tokenBytes) throw new Error("YouTube returned an empty proof token");
      return encodeBase64Url(tokenBytes);
    } finally {
      client?.shutdown().catch(() => {});
      frame.remove();
    }
  }

  async function handleRequest(data) {
    const poToken = await mintPoToken(data.contentBinding);
    return { poToken };
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.data?.channel !== CHANNEL ||
      event.data?.type !== "request"
    ) {
      return;
    }

    const requestId = event.data.requestId;
    handleRequest(event.data)
      .then((result) => {
        window.postMessage({ channel: CHANNEL, type: "result", requestId, ...result }, "*");
      })
      .catch((error) => {
        window.postMessage(
          {
            channel: CHANNEL,
            type: "error",
            requestId,
            error: (error && error.message) || "YouTube helper failed",
          },
          "*"
        );
      });
  });
})();
