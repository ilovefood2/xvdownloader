# Changelog

## [1.11.19] - 2026-06-30

### Added
- Facebook: prefer the full progressive MP4 (`browser_native_hd_url` /
  `playable_url`) extracted from Facebook's GraphQL responses, instead of the
  audio-only / session-bound DASH segment URLs the generic matcher was grabbing
  (which 403 on re-fetch). Best-effort — videos Facebook serves as DASH only may
  still need separate audio+video muxing.

## [1.11.18] - 2026-06-30

### Changed
- Bumped the parallel download concurrency from 5 to 6 chunks (matches the HLS
  segment concurrency; ~5-6 already saturates a typical link).

### Fixed
- Chunked downloading is now strictly best-effort: if the Range probe fails (some
  CDNs reject a `bytes=0-1` probe) or a chunk errors mid-stream, it falls back to
  a plain single GET, so it's never worse than a non-chunked download.
- Recognise embedded/shorts/live YouTube URLs (`/embed/<id>`, `/shorts/<id>`,
  `/live/<id>`, and `youtube-nocookie.com`) so the resolver handles them, instead
  of falling back to the sniffed, session-bound `WEB_EMBEDDED_PLAYER` googlevideo
  URL that returns 403.

## [1.11.17] - 2026-06-30

### Changed
- All direct downloads (X, TikTok, generic, generic MP4, and the YouTube
  progressive fallback) now use the same concurrent Range-chunk downloader as
  the YouTube mux path — 10 MB chunks, 5 in parallel — which is much faster and
  bypasses per-connection rate throttling. Servers that don't support Range fall
  back automatically to a single streamed GET, and HTML error pages served in
  place of media are rejected up front.

## [1.11.16] - 2026-06-30

### Added
- Added generic support. The page's bare `gvideo` MP4 link 403s; the real
  per-quality MP4s come from an authorized XHR (`/xhr/video/<id>`) whose hash is
  derived from the page (four 8-hex-digit chunks → base36). The extension now
  replicates that, calls the API from the page (the returned URL is signed to
  the viewer's IP, so it must run there), and downloads the highest quality.

## [1.11.15] - 2026-06-30

### Fixed
- YouTube downloads are now dramatically faster. googlevideo throttles a single
  sequential GET to roughly playback speed (~0.7 MB/s, so a long 4K video took
  20+ minutes). The video/audio streams are now fetched in concurrent 10 MB
  Range chunks, which gets each request a fresh full-speed burst — measured
  ~25-35 MB/s, a 30-40x speedup. Falls back to a plain GET if a server doesn't
  support range requests.

## [1.11.14] - 2026-06-30

### Changed
- Large 4K / long YouTube videos now remux in-browser. The muxer mounts the
  downloaded video + audio via FFmpeg's WORKERFS, so FFmpeg reads them lazily
  from the Blobs instead of copying them into its 2 GB heap. Only the muxed
  output occupies the heap now, which roughly doubles the size that can be
  merged (video ceiling raised from ~650 MB to ~1.25 GB) — enough for true 4K
  at typical lengths. Streams beyond that (extreme 8K / hours-long 4K) still
  step down to the highest resolution that fits, with the progressive MP4 as a
  final fallback.
- Dropped `+faststart` from the merge (it rewrites the whole file, doubling heap
  use); a fully-downloaded local MP4 plays fine with the moov atom at the end.

## [1.11.13] - 2026-06-30

### Changed
- Removed the YouTube resolution cap — downloads now take the genuinely highest
  available quality (true 4K where present), not a 1080p ceiling. The only limit
  is physical: ffmpeg.wasm has a 2 GB heap and a stream-copy mux holds the input
  plus output in it, so a video stream beyond ~650 MB (extreme 8K / very long
  4K) steps down to the best resolution that can actually be remuxed in-browser.
- Reduced the muxer's peak memory (each stream is written into ffmpeg and freed
  before the next is fetched), so large 4K videos remux without exhausting the
  heap. The progressive MP4 fallback still covers any remux that runs out of
  memory.

## [1.11.12] - 2026-06-30

### Changed
- YouTube now downloads high quality by default. Previously it preferred
  YouTube's lone progressive MP4 (typically 360p); it now merges the best
  adaptive video + audio streams with the bundled FFmpeg, picking the highest
  resolution that fits the in-browser memory budget (commonly 1080p, up to
  1440p/4K for shorter clips). If the remux fails (e.g. FFmpeg runs out of
  memory) it falls back to the progressive MP4 so the download still succeeds.

## [1.11.11] - 2026-06-30

### Added
- Added TikTok support. TikTok serves the (no-watermark) MP4 from signed CDN
  URLs embedded in the page's `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON, with no
  `.mp4` extension, so generic sniffing missed it. The extension now reads that
  JSON, picks the highest-bitrate CDN URL (skipping the `/aweme/v1/play`
  fallback that 403s), and downloads it with the page cookies + Referer.

### Fixed
- The Referer-spoof rule now *removes* the `Origin` header instead of setting
  it. Several CDNs (TikTok, YouTube) return 403 to any request carrying an
  Origin, and Chrome forces a `chrome-extension://` Origin onto extension
  fetches; native players send none for media. This also covers the previous
  YouTube/a gated site cases.

## [1.11.10] - 2026-06-30

### Fixed
- Fixed generic HLS detection picking up a bogus URL on sites that declare the
  stream inside an inline script (e.g. a gated site's `var hlsUrl = '…m3u8';…`). The
  whole script snippet was being resolved as a relative URL and mistaken for the
  playlist, so the download hit a non-existent path and 403'd. Media detection
  now rejects candidates that aren't a single clean URL token; the real playlist
  URL is still recovered via regex extraction. Combined with the v1.11.9 Referer
  fix, Referer-gated sites like a gated site now download correctly.

## [1.11.9] - 2026-06-30

### Fixed
- Fixed generic HLS/MP4 downloads that failed with a 403 on Referer-gated CDNs
  (e.g. a gated site). The extension now spoofs the page's `Referer`/`Origin`
  headers for its own download requests via a `declarativeNetRequest` rule,
  scoped to tab-less extension requests (`tabIds: [-1]`) and the media host so
  normal browsing and unrelated downloads are unaffected. The rule is added at
  the start of a download and removed when it finishes.

## [1.11.8] - 2026-06-30

### Fixed
- Fixed YouTube downloads still failing with "YouTube player HTTP 403". Chrome
  forces an `Origin: chrome-extension://…` header onto every request the service
  worker makes, and YouTube's player API rejects it. The extension now strips
  that header for the player endpoint via a `declarativeNetRequest` rule (scoped
  so the user's own YouTube playback is unaffected).
- Stopped treating YouTube `/playlist?list=…` page URLs as HLS streams, which
  produced a misleading "preparing HLS" fallback that could never succeed.

### Notes
- Adds the `declarativeNetRequestWithHostAccess` permission, used only to remove
  the Origin header from YouTube player API requests.

## [1.11.7] - 2026-06-30

### Fixed
- Fixed YouTube downloads that failed (button showed "Failed") for signed-in
  users: the resolver now calls the watch page, player API and `googlevideo`
  CDN anonymously (no cookies). Signed-in web cookies made the Android VR
  player endpoint reject the request, so no MP4 URL was ever returned.
- Fixed a bad signature-timestamp match (`"sts":1`) that sent an invalid
  `signatureTimestamp` to the player API; the real value is now read from the
  player `base.js`.

### Added
- Added an adaptive fallback for videos with no progressive MP4: the extension
  downloads the best video-only + audio-only MP4 streams (up to 1080p) and
  merges them into a single MP4 with the bundled FFmpeg.

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
