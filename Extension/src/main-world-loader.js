/*
 * X Video Downloader — MAIN-world loader (Safari port).
 *
 * The page-context sniffers (inject.js on x.com, generic-sniffer.js elsewhere)
 * must run in the page's own JS world so they can wrap window.fetch /
 * XMLHttpRequest and read the page's API + media traffic.
 *
 * Chrome does this with `"world": "MAIN"` in the manifest. Safari does NOT honor
 * that key in a static content_scripts declaration (the converter warns, and the
 * script silently ends up in the isolated world where fetch/XHR patching is
 * useless). So we fall back to the version-independent technique: this isolated-
 * world content script runs at document_start and appends a <script src=…>
 * element pointing at the sniffer, which the page then executes in its MAIN
 * world.
 *
 * Both sniffers use only page APIs (fetch/XHR/postMessage/CustomEvent) and guard
 * against double-install, so this is behaviorally equivalent to world:MAIN.
 */
(() => {
  "use strict";

  const api = globalThis.chrome || globalThis.browser;
  const host = location.hostname;
  const isX =
    /(^|\.)x\.com$/.test(host) || /(^|\.)twitter\.com$/.test(host);
  const file = isX ? "src/inject.js" : "src/generic-sniffer.js";

  try {
    const s = document.createElement("script");
    s.src = api.runtime.getURL(file);
    // Not async: preserve execution order and run as early as the (local,
    // instantly-available) resource allows, before the page's own network
    // scripts where possible.
    s.async = false;
    s.dataset.xvdInjected = "1";
    (document.head || document.documentElement || document).appendChild(s);
    // The script has run by load; drop the tag to keep the DOM clean.
    s.addEventListener("load", () => s.remove());
  } catch (e) {
    /* never let injection break the page */
  }
})();
