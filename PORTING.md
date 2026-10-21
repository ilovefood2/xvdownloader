# Porting notes: Chrome (XDownload) → Safari

This documents exactly what changed relative to the Chrome MV3 extension, file by
file, so the two codebases can be kept in sync.

## Summary of blockers

| Chrome API / feature | Safari status | Resolution |
| --- | --- | --- |
| `chrome.offscreen` (offscreen document) | Not supported | Run the pipeline in a non-persistent **background page** |
| MV3 service-worker background | No blob URLs / WASM worker in a worker context | Background **page** instead of `service_worker` |
| `chrome.downloads.download` | **Not supported at all** | Stream bytes to a content script → `<a download>` |
| `chrome.downloads.onChanged` | n/a | Removed; the content bridge revokes its own blob URL |
| `declarativeNetRequest` `modifyHeaders` | **Does not apply to extension-initiated fetches** in Safari (Apple-confirmed) | Rules kept but ineffective; replaced by a page-context fetch fallback (`net.js` → `download-bridge.js`) that re-issues 403'd media fetches from the originating tab |
| `world: "MAIN"` content scripts | **Not honored in the static manifest** (converter warns; script silently runs in the isolated world) | Inject the sniffers as page `<script>` tags via a document_start loader + `web_accessible_resources` |
| `chrome.*` namespace | `browser.*`; `chrome` aliased 15.4+ | `const chrome = globalThis.chrome \|\| globalThis.browser` in entry points |

## Files copied **verbatim** (no changes)

These use only cross-engine APIs and needed no edits:

- `src/hls.js` — the HLS/mux/ffmpeg pipeline. Uses `chrome.runtime.getURL`, which
  Safari supports. Runs in the background page (has DOM/WASM/Workers).
- `src/inject.js` — X.com MAIN-world API sniffer (`window.postMessage` only).
- `src/generic-sniffer.js` — generic MAIN-world MP4/HLS sniffer.
- `src/content.js` — X.com hover button. Still sends `XVD_DOWNLOAD` and awaits
  `{ ok }`; the save now happens via the bridge, transparently to this file.
- `src/generic-content.js` — generic hover button. Same as above with
  `XVD_GENERIC_DOWNLOAD`.
- `src/styles.css`, `src/generic-styles.css`
- `vendor/ffmpeg/**`, `icons/**`

## Files changed

### `manifest.json`
- `background`: `{ "service_worker": "src/background.js" }` →
  `{ "page": "src/background.html", "persistent": false }`.
- `permissions`: removed `"downloads"` and `"offscreen"`; kept
  `"declarativeNetRequestWithHostAccess"`.
- CSP: added `worker-src 'self' blob:` so the ffmpeg.wasm Worker loads.
- Content-script groups: prepended `src/download-bridge.js` to both the X.com and
  generic content-script arrays (loads before the button script; self-registers a
  message listener).
- **`world: "MAIN"` groups replaced.** Safari does not honor `world: "MAIN"` in a
  static `content_scripts` declaration (confirmed by the converter for Safari 26).
  The two MAIN-world groups (`inject.js`, `generic-sniffer.js`) are now isolated-
  world **loader** groups running `src/main-world-loader.js` at `document_start`;
  the loader injects the real sniffer as a page `<script>` so it executes in the
  page's MAIN world. Both sniffers are added to `web_accessible_resources`.
- `"background".persistent: false` is kept. The converter prints a cosmetic
  "unsupported key: persistent" note, but it is the correct way to request a
  non-persistent page — with it removed, the converter instead errors that iOS
  does not allow *persistent* background pages.

### `src/background.js`
- Now an **ES module** (`background.html` loads it with `type="module"`) so it can
  `import` the pipeline.
- Added `const chrome = globalThis.chrome || globalThis.browser;`.
- **Removed** `ensureOffscreen()`, `creatingOffscreen`, all `chrome.offscreen.*`.
- `prepareViaOffscreen()` → **`prepareViaPipeline()`**: calls the imported
  `prepareDownload(...)` directly and returns `{ blob, ext }` (a real Blob, not a
  blob URL). Progress is delivered via an `onProgress` callback → `forwardProgress`.
- **Removed** `chrome.downloads.download` in both `startDownload()` and
  `startGenericDownload()`; both now call **`deliverBlobToTab()`**.
- **Added** `deliverBlobToTab()` — reads the Blob, base64-chunks it (512 KB), and
  streams `XVD_SAVE_BEGIN` / `XVD_SAVE_CHUNK…` / `XVD_SAVE_END` to the origin tab,
  awaiting each message for backpressure. Plus helpers `forwardProgress()`,
  `mimeForExt()`, `bytesToBase64()`.
- **Removed** `pendingRevokes` + `chrome.downloads.onChanged` listener.
- Message handler: removed the old `XVD_PROGRESS` relay (progress is now a direct
  callback). `XVD_PAUSE` / `XVD_RESUME` / `XVD_CANCEL` now call the pipeline's
  `pauseJob/resumeJob/cancelJob(jobId)` directly instead of messaging an offscreen
  document.

### `src/pipeline.js` (new — was `src/offscreen.js`)
- The offscreen document's logic, refactored from a `chrome.runtime.onMessage`
  handler into an ES module exporting `prepareDownload()`, `pauseJob()`,
  `resumeJob()`, `cancelJob()`. Same `controls` map, same call into `hls.js`.
- Progress is a callback argument instead of a `runtime.sendMessage`.
- Returns the raw `Blob` instead of a blob URL (the URL would be useless to the
  page — see the download bridge).
- `src/offscreen.html` and `src/offscreen.js` are **not** carried over.

### `src/download-bridge.js` (new)
- A content script on every page. Receives the streamed `XVD_SAVE_*` messages,
  reassembles the `Uint8Array` chunks, builds a `Blob`, and triggers a hidden
  `<a download>` click — the Safari stand-in for `chrome.downloads`.
- Guards against double-install per frame; keys concurrent saves by `saveId`.

### `src/background.html` (new)
- Hosts the background module. Exists purely because Safari has no offscreen API
  and its MV3 service workers can't create blobs or run the ffmpeg Worker.

### `src/main-world-loader.js` (new)
- Isolated-world content script (document_start) that appends a page `<script>`
  pointing at `inject.js` (on x.com) or `generic-sniffer.js` (elsewhere), so the
  sniffer runs in the page's MAIN world. Replaces the manifest `world: "MAIN"`
  key, which Safari ignores. Uses `runtime.getURL` + `async = false` for earliest
  execution. Both sniffers already use only page APIs and guard double-install,
  so this is behaviorally equivalent to `world: "MAIN"`.

## Data-flow diff (a generic-site download)

**Chrome:** content.js → `XVD_GENERIC_DOWNLOAD` → SW → offscreen doc
(fetch+merge, makes blob URL) → SW → `chrome.downloads.download(blobURL)`.

**Safari:** content.js → `XVD_GENERIC_DOWNLOAD` → background page →
`prepareDownload()` in-page (fetch+merge, returns Blob) → `deliverBlobToTab()`
streams bytes → `download-bridge.js` rebuilds Blob → `<a download>`.

## Keeping the two ports in sync

Only `manifest.json`, `background.js`, and the offscreen/download layer diverge.
When the Chrome original changes `hls.js`, the sniffers, the content buttons, or
the ffmpeg vendor, copy those files across unchanged. When it changes the
download/offscreen plumbing, re-apply the equivalents in `background.js` /
`pipeline.js` / `download-bridge.js`.

## Build status (verified on this machine — Xcode 26.6 / Safari 26)

- `make-xcode-project.sh` generates the four-target project with no functional
  warnings (only the cosmetic `persistent` key note).
- `xcodebuild` **BUILD SUCCEEDED** for both the macOS and iOS (simulator) app
  schemes, with the extension `.appex` embedded and the 32 MB ffmpeg wasm bundled.
- Launching the built macOS app registers the extension with the system as a
  Safari Web Extension (`pluginkit` shows `com.…​.Extension`, extension point
  `com.apple.Safari.web-extension`).

What is **not** yet verified (needs interactive Safari with the extension enabled
+ "Allow Unsigned Extensions" + site access granted):

1. **MAIN-world injection timing** — the sniffer is injected as a page `<script>`
   at `document_start` with `async = false`. It's a local resource so it loads
   almost immediately, but a page that fires its very first GraphQL/media request
   in the same microtask could be missed. In practice this is how pre-`world:MAIN`
   Safari sniffers worked. Verify X.com variant sniffing and generic fetch/XHR
   sniffing catch traffic.
2. **ffmpeg Worker under Safari CSP** — the worker loads from an extension URL
   (`worker.js`), satisfying `worker-src 'self'` (`blob:` added as a fallback).
   Confirm an encrypted/TS HLS download completes on macOS.
3. **Programmatic `<a download>` after async work** — Safari may require a live
   user gesture. If saves are silently dropped, re-click Download; a longer-term
   fix is a click-time gesture handoff or opening the blob in a new tab.
4. **DNR request-header modification** — verify Referer-gated CDNs; direct MP4 and
   standard HLS don't depend on it.
5. **iOS specifically** — the background page is non-persistent and memory-limited
   on iOS/iPadOS. Direct MP4 and plain (blob-concat) HLS should work; the
   **ffmpeg path (encrypted/TS HLS, 4K mux) may fail on iOS** due to memory and
   nested-Worker constraints. Large-file byte hand-off is also base64-buffered in
   memory. Treat macOS as the primary target; iOS as best-effort.
