# X Video Downloader

A Chrome (Manifest V3) extension that shows a **Download** button when your
cursor is over a video in a tweet on [x.com](https://x.com) (or twitter.com).
Click it to save the video as an MP4.

## How it works

- A content script watches the page for `<video>` elements inside tweets and
  overlays a download button that appears on hover.
- A page-context script (`src/inject.js`) reads X's own API responses that the
  page already loads and caches each tweet's video variants — including direct
  MP4 URLs. This works for all videos, **including sensitive / age-restricted
  ones**, because the logged-in page already has the data.
- When clicked, it picks the **highest-bitrate MP4** from the cached variants
  and downloads it with the `chrome.downloads` API. If nothing was captured, it
  falls back to X's public syndication endpoint
  (`cdn.syndication.twimg.com/tweet-result`).
- If a video has **no direct MP4** (HLS-only, or when X refuses the MP4 — e.g.
  4K), it fetches the `.m3u8` playlist, downloads every segment, and merges them
  into a playable file locally (in an offscreen document). X's fragmented-MP4
  streams become a real `.mp4` with no re-encoding. The button shows a live
  **download percentage** while this happens; **click it to pause/resume**, or
  use the **✕** to cancel.
- For **encrypted (AES-128) or MPEG-TS** streams, a bundled **ffmpeg.wasm**
  (lazy-loaded, ~31 MB) decrypts/remuxes into a clean MP4. Real DRM
  (Widevine/PlayReady/FairPlay) is not supported — those keys are never
  exposed to any downloader.

No login, API keys, or third-party servers are involved.

## Install (unpacked / developer mode)

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder.
4. Visit x.com, hover over a video in any tweet, and click **Download**.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (MV3) |
| `src/inject.js` | Reads X's API responses to capture video URLs (page context) |
| `src/content.js` | Detects videos, renders the hover button |
| `src/hls.js` | Shared HLS/media pipeline (fetch, parse, concat, ffmpeg) |
| `src/offscreen.html` / `offscreen.js` | Runs the pipeline + builds the download blob |
| `vendor/ffmpeg/` | Bundled ffmpeg.wasm (lazy-loaded for encrypted / TS streams) |
| `test/hls-test.html` | Manual test harness for the HLS pipeline |
| `src/background.js` | Resolves the MP4 URL and triggers the download |
| `src/styles.css` | Button styling |
| `icons/` | Toolbar / store icons |

## Notes & limitations

- Works on public videos and GIFs. Videos in protected/private accounts that
  aren't accessible to the syndication endpoint may not resolve.
- For tweets containing multiple videos, the button maps to the hovered video
  by its position within the tweet.
- The downloaded file is named after the tweet:
  `<author> - <tweet text> (<tweetId>).mp4` (text is sanitized and truncated;
  it falls back to `x_<tweetId>.mp4` for videos with no caption).
- This extension is for downloading content you have the rights to. Respect
  copyright and X's Terms of Service.

## Testing the HLS pipeline

The extension only runs on X, and X serves unencrypted fragmented-MP4 — so the
encrypted/TS (ffmpeg) paths can't be exercised there. To test them, open the
harness directly:

1. Load the extension, then open `chrome://extensions` and copy its ID.
2. Visit `chrome-extension://<id>/test/hls-test.html`.
3. Pick a preset (or paste any CORS-enabled `.m3u8`) and click **Start**. You
   can pause/resume/cancel and download the result.

It runs the exact `src/hls.js` code the extension uses.

## Privacy

The extension collects no data. See the [Privacy Policy](PRIVACY.md).
