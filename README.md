# X Video Downloader — Safari port

A Safari Web Extension port of the Chrome extension **XDownload / X Video
Downloader**. It shows a **Download** button when your cursor is over a video on
x.com (and other sites) and saves it as MP4, reusing the same HLS/ffmpeg.wasm
pipeline as the Chrome original.

This repo is the **web-extension source plus an Xcode-project generator**. Safari
extensions must ship inside a macOS/iOS app built with Xcode.

> **Status:** verified on Xcode 26.6 / Safari 26 — the generator produces the
> four-target project, both the macOS and iOS app schemes **build**, and the
> built macOS app registers the embedded Safari Web Extension with the system.
> Enabling and exercising it in Safari (hover → download) is the interactive step
> left to you; see [`PORTING.md`](PORTING.md) for what that still needs to confirm.

```
xvdownloader-safar/
├── Extension/               ← the Safari Web Extension (converter input)
│   ├── manifest.json        ← MV3, adapted for Safari
│   ├── src/                 ← background page, content scripts, pipeline, save bridge
│   ├── vendor/ffmpeg/       ← bundled ffmpeg.wasm (unchanged)
│   └── icons/
├── AppScaffold/             ← branded container-app UI + native handler (overlay)
├── make-xcode-project.sh    ← runs safari-web-extension-converter → Xcode project
├── PORTING.md               ← exactly what changed from the Chrome version and why
└── README.md                ← this file
```

## Requirements

- A **Mac with the full Xcode.app** (not just Command Line Tools). The converter
  ships inside Xcode. Point the toolchain at it:
  ```
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  ```
- **macOS 13+ / iOS 16+** to run; **macOS 14 / iOS 17 recommended**. The
  extension relies on MV3 features that landed across Safari 16–17:
  `world: "MAIN"` content scripts, `declarativeNetRequest` dynamic rules, and a
  non-persistent background page. Older Safari will not run it correctly.
- An **Apple Developer account** only if you want to run on a physical iPhone/iPad
  or distribute. A free personal team is enough for local macOS testing.

## Build & run

```bash
# 1. Generate the Xcode project (macOS + iOS targets):
APP_NAME="X Video Downloader" BUNDLE_ID="com.YOURNAME.xvideodownloader" \
  ./make-xcode-project.sh

# 2. Open it:
open XcodeProject/*/*.xcodeproj      # or the .xcodeproj it prints

# 3. In Xcode: pick your Team under Signing & Capabilities on every target,
#    select the macOS app scheme, and Run (⌘R).
```

Then enable it in Safari:

1. Safari ▸ **Settings** ▸ **Extensions** ▸ turn on **X Video Downloader**.
   - If it's hidden, enable **Settings ▸ Advanced ▸ Show features for web
     developers**, then **Develop ▸ Allow Unsigned Extensions** (per Safari
     launch, for locally-built/unsigned dev builds).
2. Give it access to **All Websites** (it needs to reach video CDNs).
3. Visit x.com or another site, hover a video, click **Download**.

For iOS/iPadOS: select the iOS app scheme, run on a simulator or device, then
enable the extension in **Settings ▸ Apps ▸ Safari ▸ Extensions**.

Want the app window branded instead of the stock placeholder? See
[`AppScaffold/README.md`](AppScaffold/README.md).

## What works, and the Safari-specific caveats

The X.com path, the generic-site MP4/HLS sniffers, the pause/resume/cancel
controls, progress reporting, and the encrypted/TS HLS ffmpeg pipeline are all
ported. Because Safari's extension APIs differ from Chrome's, three things behave
differently — full detail in [`PORTING.md`](PORTING.md):

- **No offscreen document.** The media pipeline runs in a non-persistent
  **background page** instead. (Functionally equivalent.)
- **No manifest `world: "MAIN"`.** Safari ignores it, so the page-context
  sniffers (`inject.js`, `generic-sniffer.js`) are injected as page `<script>`
  tags by `src/main-world-loader.js` at document_start instead — same effect.
- **No `chrome.downloads` API.** Finished bytes are streamed to the page and
  saved via a synthetic `<a download>` click (see `src/download-bridge.js`).
  Very large 4K files are buffered in memory during the hand-off. If a browser
  ever declines the programmatic save because the user gesture has expired,
  re-click Download.
- **`declarativeNetRequest` header rules** (Referer/Origin spoofing for
  Referer-gated CDNs) are kept but wrapped in try/catch; Safari's DNR limits and
  request-header modification differ from Chrome's, so a few Referer-gated sites
  that work in Chrome may not in Safari. Direct MP4 and standard HLS are
  unaffected.
- **Touch UX (iOS).** The button is hover-driven, which suits a trackpad/mouse.
  On touch, reveal-on-hover is unreliable; a touch-first UI is a follow-up.

## Not supported (same as the Chrome version)

- Real DRM (Widevine/PlayReady/FairPlay).
- Blob-only videos whose underlying `.mp4`/`.m3u8` URL never appears in network
  activity.

## Privacy

No data is collected; no third-party servers are involved. All fetching and
media assembly happen locally in the extension.
