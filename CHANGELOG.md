# Changelog

## [1.11.6] - 2026-06-30

### Fixed
- Fixed YouTube downloads that failed because raw `ytInitialPlayerResponse`
  MP4 URLs were rejected by YouTube.
- Added a YouTube-specific resolver that uses the page visitor context and
  Android VR player client to get a downloadable progressive MP4 URL without
  executing remote player JavaScript.

## [1.11.5] - 2026-06-30

### Fixed
- Generic HLS downloads now avoid the browser FFmpeg remux path for long
  MPEG-TS playlists, preventing the common 99% `ffmpeg-core.js` out-of-memory
  failure.
- Added a generic-site TS fallback that can decrypt AES-128 HLS segments in the
  browser and save the full stream as `.ts` when MP4 remuxing would exceed
  Chrome's memory limit.
- Kept the X.com HLS/FFmpeg path unchanged; the TS fallback is only enabled for
  generic website downloads.

## [1.11.4] - 2026-06-30

### Added
- Added YouTube progressive MP4 support by reading `ytInitialPlayerResponse`
  and accepting signed `googlevideo.com/videoplayback` MP4 URLs.

### Notes
- YouTube 720p/1080p+ adaptive formats are usually separate video-only and
  audio-only tracks and are not merged yet. This version downloads progressive
  MP4 formats when YouTube exposes them, typically 360p/720p depending on the
  video.

## [1.11.3] - 2026-06-30

### Fixed
- Direct MP4 downloads now report byte-level percentage progress when the media
  server provides a file size.
- Pause, resume, and cancel now also work while a direct MP4 is being fetched,
  not only during HLS segment downloads.

## [1.11.2] - 2026-06-30

### Fixed
- Generic website downloads now show pause/resume/cancel controls while a
  download is running.
- Generic HLS detection now recognizes playlist responses and playlist-style
  endpoints that do not end in `.m3u8`, such as `/api/video/MasterPlayList`.
- Generic downloads now prefer detected HLS playlists over tiny direct loading
  or ad media files when both are present.
- The generic sniffer no longer scans downloaded JavaScript bundles for media
  URLs, avoiding false positives from test URLs embedded in site code.

## [1.11.1] - 2026-06-30

### Fixed
- Generic website detection now accepts media URLs with a trailing slash after
  the extension, such as `.mp4/?token=...`.
- Generic website detection now scans inline player configuration, which covers
  sites that place MP4/HLS URLs in page scripts before the player starts a
  network request.

## [1.11.0] - 2026-06-30

### Added
- Added a separate generic website downloader path for non-X pages. It detects
  direct `.mp4` and `.m3u8` URLs from video elements, browser performance
  entries, and page fetch / XHR responses.
- Generic website downloads reuse the existing offscreen HLS pipeline, including
  ffmpeg.wasm support for encrypted AES-128 or MPEG-TS HLS streams.

### Changed
- Broadened host permissions to normal `http://` and `https://` pages so the
  generic downloader can run outside x.com / twitter.com.
- Kept the original X.com / twitter.com scripts and message flow in place for
  the X-specific downloader.

## [1.10.0] - 2026-06-30

### Added
- Test harness at `test/hls-test.html` to verify the HLS pipeline (including the
  ffmpeg encrypted/TS paths) against public test streams, without the extension
  running on any real website. Open it at
  `chrome-extension://<id>/test/hls-test.html`.

### Changed
- Extracted the HLS/media pipeline (fetch, parse, concat, ffmpeg decrypt/remux,
  pause/cancel) into a shared ES module `src/hls.js`, used by both the offscreen
  document and the test harness. `src/offscreen.js` is now a thin adapter.

## [1.9.0] - 2026-06-30

### Added
- Bundled `ffmpeg.wasm` (~31 MB) for full HLS parity. Encrypted (AES-128
  clear-key) streams and MPEG-TS streams are now downloaded and handed to ffmpeg
  for decryption / remuxing into a clean MP4. ffmpeg is **lazy-loaded only when
  needed** — X's normal unencrypted fragmented-MP4 videos still use the
  lightweight concat path and never load it. Pause/resume/cancel work on the
  ffmpeg path too. Does not (and cannot) handle real DRM (Widevine/PlayReady/
  FairPlay).

All notable changes to X Video Downloader are recorded here. The version here
matches the `version` field in `manifest.json`.

## [1.8.1] - 2026-06-30

### Fixed
- Cancel only stopped the UI while the HLS download kept running in the
  background. The control object was deleted as soon as the first worker
  stopped, so the remaining concurrent workers recreated a fresh (non-canceled)
  control and continued. Workers now share a single captured control object and
  teardown waits for all of them to stop (allSettled), so cancel actually halts
  the download.

## [1.8.0] - 2026-06-30

### Added
- Cancel for in-progress HLS downloads. A ✕ button appears next to the
  percentage while downloading; clicking it aborts the job, discards the
  fetched segments, and resets the button.

## [1.7.0] - 2026-06-30

### Added
- Pause / resume for in-progress HLS downloads. While a download shows a
  percentage, click the button to pause (it shows "▶ NN%"); click again to
  resume. The removed overall timeout means a download can stay paused
  indefinitely.

## [1.6.0] - 2026-06-30

### Added
- Download progress on the button. For HLS downloads (which can be hundreds or
  thousands of segments for long/4K videos), the button now shows a live
  percentage instead of a static "Fetching…", then "Saved" when finished.

## [1.5.1] - 2026-06-30

### Fixed
- Download could hang on "Fetching…" forever if an HLS playlist or segment
  request stalled. All fetches now time out, segment download progress is
  logged to the console, and there is an overall safety-net timeout so the
  button always resolves to success or a clear error.

### Changed
- HLS segments are now held as Blobs (browser-managed, possibly disk-backed)
  instead of in-memory ArrayBuffers, so long / 4K streams don't exhaust memory.

## [1.5.0] - 2026-06-30

### Fixed
- Automatic HLS fallback when the direct MP4 fails. Some videos (e.g. certain
  4K tweets) return HTTP 503/403 on their progressive MP4 even though the HLS
  stream of the same video serves fine. The extension now keeps the HLS
  playlist alongside the MP4 and, if the MP4 download fails, transparently
  downloads and merges the HLS stream instead.

## [1.4.0] - 2026-06-30

### Fixed
- Downloads that failed with a `.htm` file and "Site wasn't available" (e.g.
  some 4K or restricted videos). X's CDN refuses these when the browser's
  download manager requests them directly. The extension now fetches the media
  bytes from its own (credentialed) context — like the HLS path already did —
  and saves the resulting blob, so restricted/high-res MP4s download correctly.
- An HTML/error response from X is now detected and reported as a clear error
  instead of being silently saved as a `.htm` file.

## [1.3.0] - 2026-06-30

### Added
- HLS fallback: videos that have no direct MP4 variant (HLS-only, e.g. some
  long/live videos) are now downloaded by fetching the `.m3u8` playlist,
  downloading all segments, and merging them locally. X's fragmented-MP4 (CMAF)
  streams are saved as a playable `.mp4` with no re-encoding; plain MPEG-TS
  streams are saved as `.ts`. Merging runs in an offscreen document since the
  service worker cannot create blob URLs.

## [1.2.0] - 2026-06-30

### Fixed
- Sensitive / age-restricted videos that the public syndication endpoint
  refuses (error "Tweet unavailable") now download. The extension reads the
  video URLs directly from X's own API responses that the logged-in page
  already loads, entirely within the browser.

### Changed
- Primary resolution now uses the in-page API responses (works for all videos,
  including sensitive ones); the syndication endpoint is kept only as a
  fallback when nothing was captured.

## [1.1.0] - 2026-06-30

### Added
- Downloads are named after the tweet: `<author> - <tweet text> (<tweetId>).mp4`
  (sanitized and truncated; falls back to `x_<tweetId>.mp4` when there is no
  caption).

### Fixed
- "No video found" on some tweets (including age-restricted / sensitive
  content). The resolver now deep-scans the whole syndication payload for video
  variants instead of only a few fixed locations.
- Clearer errors: distinguishes unavailable/sensitive tweets (tombstones) and
  HLS-only videos from the generic failure.

## [1.0.0] - 2026-06-30

### Added
- Initial release: hover a video in a tweet on x.com / twitter.com to reveal a
  Download button that saves the highest-bitrate MP4.
- Privacy policy (Markdown + GitHub Pages HTML).
