# X Video Downloader

A Chrome (Manifest V3) extension that shows a **Download** button when your
cursor is over a video.

The original X.com / twitter.com downloader remains in place: it reads X's own
page data, handles sensitive / age-restricted videos, falls back to HLS when
needed, and can use the bundled ffmpeg.wasm path for encrypted or MPEG-TS HLS
streams.

Version 1.11.0 adds a separate generic website path for non-X pages. On other
websites, the extension sniffs direct `.mp4` and `.m3u8` URLs from video
elements, browser performance entries, and page `fetch` / XHR responses. It
then reuses the same offscreen HLS/FFmpeg pipeline to save the result.

No API keys or third-party developer servers are involved.

## Install (unpacked / developer mode)

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder.
4. Visit x.com or another website with a video.
5. Hover over a video and click **Download**.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (MV3) |
| `src/inject.js` | X.com page-context API sniffer |
| `src/content.js` | X.com hover button |
| `src/generic-sniffer.js` | Non-X website MP4/HLS URL sniffer |
| `src/generic-content.js` | Non-X website hover button |
| `src/hls.js` | Shared HLS/media pipeline (fetch, parse, concat, ffmpeg) |
| `src/offscreen.html` / `offscreen.js` | Runs the pipeline and builds download blobs |
| `vendor/ffmpeg/` | Bundled ffmpeg.wasm, lazy-loaded for encrypted / TS streams |
| `test/hls-test.html` | Manual test harness for the HLS pipeline |
| `src/background.js` | Resolves media and triggers downloads |
| `icons/` | Toolbar / store icons |

## Notes and limitations

- X.com behavior is handled by the original X-specific scripts.
- Other websites are best-effort: direct MP4 and HLS playlists can work when
  the page exposes their URLs to the browser.
- Blob-only videos can work only when the underlying `.mp4` or `.m3u8` URL is
  visible in page network activity.
- Real DRM (Widevine/PlayReady/FairPlay) is not supported.
- This extension is for downloading content you have the rights to. Respect
  copyright and each website's terms.

## Testing the HLS pipeline

To test encrypted/TS/fMP4 HLS handling without using a real website:

1. Load the extension, then open `chrome://extensions` and copy its ID.
2. Visit `chrome-extension://<id>/test/hls-test.html`.
3. Pick a preset, or paste any CORS-enabled `.m3u8`, and click **Start**.

It runs the same `src/hls.js` code used by real downloads.

## Privacy

The extension collects no data. See the [Privacy Policy](PRIVACY.md).
