# Changelog

## [1.11.56] - 2026-10-20

### Fixed
- X downloads now strip invisible Unicode format controls that Chrome rejects
  in filenames and preserve the actual `chrome.downloads.download` error
  instead of masking it as `Download blocked`.

## [1.11.55] - 2026-10-20

### Fixed
- X/Twitter direct MP4 downloads no longer send cookies to `video.twimg.com`.
  Some `amplify_video` responses use `Access-Control-Allow-Origin: *`, which is
  incompatible with credentialed cross-origin requests and caused downloads to
  fail even though the public CDN URL was valid.

## [1.11.54] - 2026-10-09

### Fixed
- YouTube (incl. Shorts) downloads no longer hang on `Authorizing...` after the
  first download. The vendored challenge solver's environment shim assigns
  `globalThis.location = new URL(...)`, which inside the sandbox iframe
  navigated the frame away right after the first solve; its MessagePort died
  with it and every later solve waited on a dead channel until the browser was
  restarted. `youtube-solver-setup.js` now rewrites that write to an inert
  property before the solver core loads (solutions are unchanged).
- If the solver channel is ever lost anyway, the offscreen document reloads the
  sandbox and retries the solve once instead of failing every later download.

### Changed
- The download button now shows each YouTube authorization step
  (`Loading player...`, `Getting token...`, `Solving...`, `Starting...`), and
  failures show the actual reason (e.g. `Failed: YouTube token snapshot timed
  out`) instead of a bare `Failed`.
- Every YouTube authorization request now has a deadline: watch page, player
  script and player API fetches, and each proof-token step, fail with a named
  timeout instead of waiting indefinitely.
- The player script fetched for the signature timestamp is handed to the
  offscreen solver, so the multi-megabyte `base.js` is downloaded once per
  request instead of twice.

## [1.11.53] - 2026-10-01

### Fixed
- Generic sites whose `<video>` plays a plain MP4 (e.g. Plyr players with one
  `<source>` per quality) no longer fail with a non-media URL. A page link such
  as `/playlist?list=…` was mistaken for an extension-less HLS endpoint and,
  because HLS was preferred, replaced the real MP4. Static `<a href>` links now
  count only with an explicit `.mp4`/`.m3u8` extension, and an MP4 on the
  hovered `<video>` itself takes priority over HLS sniffed elsewhere on the page.
- When a `<video>` lists several MP4 `<source>` qualities, the highest labeled
  resolution (`size`/`res`/`label`, or `1080p` in the URL) is downloaded rather
  than the player's lower default.

## [1.11.52] - 2026-08-29

### Fixed
- YouTube Shorts now resolve the video id from the hovered Short's own
  `/shorts/<id>` link before falling back to the page URL. This keeps selection
  correct when the Shorts feed has multiple preloaded players.
- Bumped the offscreen protocol identifier and document URL with the extension
  version, preventing a newly refreshed Shorts content script from talking to
  an older background/offscreen worker still using the previous solver bridge.

## [1.11.51] - 2026-08-29

### Fixed
- When an unpacked-extension reload invalidates scripts in already-open X or
  generic-site tabs, the download button now says `Refresh page` instead of the
  misleading `Failed`. A refreshed X tab downloads normally with the new
  extension context.

## [1.11.50] - 2026-08-29

### Fixed
- Replaced the YouTube solver iframe's cross-origin `window.postMessage`
  request channel with a dedicated transferable `MessagePort`. This fixes the
  `YouTube player started acknowledgement timed out` failure seen before the
  first chunk was accepted.
- Versioned the sandbox document and bridge script so reloading the unpacked
  extension cannot reuse the previous message protocol from Chrome's cache.
- YouTube authorization errors now stop immediately instead of falling through
  to a sniffed unprotected googlevideo URL and producing a second `HTTP 403`.

## [1.11.49] - 2026-08-29

### Fixed
- Fixed YouTube downloads hanging on `Fetching...` and eventually failing with
  `YouTube player challenge solver timed out`. The 1.5-2 MB player script is now
  transferred to the isolated solver in bounded chunks instead of one large
  cross-origin `postMessage` that Chrome could silently drop.
- Reports the proof-token/player-challenge stage as `Authorizing...`, so it is
  distinguishable from the actual media transfer.

## [1.11.48] - 2026-08-28

### Fixed
- Restored YouTube downloads for videos protected by the new SABR/GVS proof-of-
  origin rollout. The extension now mints a fresh proof token locally, resolves
  authorized MWEB streams, and solves the signed player URL before downloading.
- Removed the native-download fallback that Chrome accepted and then silently
  interrupted with `SERVER_FORBIDDEN`; the button now reports success only after
  Chrome confirms that the completed file was written.

## [1.11.47] - 2026-08-28

### Fixed
- Added a native Chrome-download fallback for YouTube videos whose googlevideo
  URLs reject extension fetches or nonzero range chunks.
- Applies the scoped media Referer/Origin header rule to YouTube media downloads
  and keeps it active until the browser download completes or is interrupted.

## [1.11.46] - 2026-08-28

### Fixed
- Made YouTube downloads more reliable for long videos by retrying failed range
  chunks and preferring browser-mux-friendly H.264 MP4 streams before AV1.

## [1.11.45] - 2026-08-14

### Fixed
- Moved X and generic website/YouTube download overlays to the top-left of
  the video, lowered below the menu bar so they do not cover close or player
  controls.
- Raised the X overlay slightly within the top-left position to better clear
  video content.

## [1.11.44] - 2026-07-23

### Fixed
- X chat embedded-post videos now use media variants sniffed from authenticated
  `GetPostById` responses, including the newer
  `media_results.result.media_info.variants` shape. This avoids the public
  syndication tombstone path that showed "Tweet unavailable (sensitive or
  protected)" inside DMs.
- X video buttons can recover the post id from a cached media URL when the chat
  DOM around the video does not expose a `/status/` link, avoiding the "No tweet
  id" error for more DM layouts.

## [1.11.43] - 2026-07-21

### Fixed
- Sensitive/protected X posts that store video variants inside a serialized
  `unified_card` payload are now downloaded from the authenticated page cache
  instead of failing through the public syndication endpoint.
- The X page sniffer now replays media it captured at `document_start` once the
  content script listener is ready, so early `TweetDetail` responses are not
  missed.

## [1.11.42] - 2026-07-10

### Changed
- HLS segment fetches now retry a dropped connection with exponential backoff +
  jitter (up to 5 attempts) instead of failing the whole download on the first
  hiccup, so a transient `net::ERR_CONNECTION_RESET` or network blip no longer
  aborts an otherwise healthy download. A genuine HTTP error (403/404) still
  fails fast.

  Note: this does NOT make sites whose third-party CDN gates its `.ts` segments
  behind a play-time session token downloadable — those reset every request
  (including the very first, fetched alone), which no amount of retrying or
  pacing can bypass without emulating the site's own player.

## [1.11.41] - 2026-07-03

### Fixed
- YouTube downloads could stall at 99% and never finish. The audio track was
  fetched as one long single GET, which dies on a lossy link with
  `ERR_QUIC_PROTOCOL_ERROR` (`QUIC_TOO_MANY_RTOS` / `QUIC_PUBLIC_RESET`) partway
  through a large read. That failed the whole video+audio mux and silently
  dropped the download to the progressive MP4 — a single throttled stream that
  crawls for a long video while the bar sits frozen at 99%. Audio now downloads
  with the same parallel Range chunks as the video (short requests survive a
  QUIC reset, and any failed chunk is retried), so the mux succeeds and the slow
  fallback is no longer triggered. Sources whose audio host misreports the Range
  total (Bilibili) opt back into the single GET via a new `audioSingleGet` flag.

### Changed
- The ffmpeg mux now reports real progress and the button shows "Muxing…"
  instead of a frozen 99%, so a long stream-copy reads as working. A 15-minute
  watchdog on the mux surfaces a wedged ffmpeg core as a retryable error rather
  than hanging the job (and the UI) indefinitely.

## [1.11.40] - 2026-07-01

### Changed
- Bilibili video now fetches with 4 concurrent Range chunks (was 3).

## [1.11.39] - 2026-07-01

### Fixed
- Bilibili downloads failed when its assigned CDN node was a PCDN/peer node
  (e.g. `os=cosovbv` on `*.bilivideo.com`) that only works through the player's
  P2P path and rejects a plain fetch with `ERR_HTTP2_PROTOCOL_ERROR` on every
  request — for both video and audio, regardless of thread count. Bilibili's
  `upsig` signature covers the query params, not the hostname, so the resolver
  now appends host-swapped fallbacks that retarget the signed URL to reliable
  UPOS mirrors (Alibaba, Tencent, Akamai). The downloader tries the original
  hosts first, then these, so a hostile node is bypassed cleanly.

## [1.11.38] - 2026-07-01

### Changed
- Bilibili video is now fetched with 3 concurrent Range chunks instead of a
  single sequential GET — the default 6 threads trip its mirror/PCDN rate limit
  (HTTP 514 / HTTP/2 reset), but 3 is accepted and restores parallel-download
  speed. Audio stays on a single GET. The per-stream thread cap is plumbed
  through as `chunkConcurrency` (clamped 1..6) so it can be tuned per source.

## [1.11.37] - 2026-07-01

### Fixed
- Bilibili downloads could fail with an HTTP `514` (or HTTP/2 reset) from its
  mirror/PCDN nodes. Those nodes reject the aggressive parallel Range chunking
  the downloader uses — the player streams sequentially instead. Bilibili muxed
  streams are now fetched with a single sequential GET per stream (video and
  audio), which the CDN accepts. Combined with the mirror fallback and
  credential-less retry from 1.11.36, a bad node now falls back cleanly.

## [1.11.36] - 2026-07-01

### Fixed
- Muxed downloads failed outright when a CDN mirror threw
  `ERR_HTTP2_PROTOCOL_ERROR` (seen on some Bilibili `*.bilivideo.com` mirrors) —
  the whole download errored with "network error". Streams are now resilient to a
  flaky mirror:
  - Each stream can carry a list of mirror URLs (primary + the CDN's own backup
    hosts). The Bilibili resolver now forwards `backupUrl`/`backup_url`, and the
    downloader tries them in order.
  - Every URL is retried once, and the retry drops credentials — signed CDN URLs
    don't need cookies, and a large Cookie header can itself trip an HTTP/2 reset.
  - The Referer spoofing rule now covers every mirror host, not just the primary.

## [1.11.35] - 2026-07-01

### Fixed
- Muxed downloads could lose audio near the end (video full-length, tail silent).
  The audio track is small, so it's now fetched with a single streamed GET
  instead of Range chunks — some CDNs (e.g. Bilibili serves audio from a
  different host than video) misreport the Range total on the audio endpoint,
  which silently truncated the chunked download and left the file's tail without
  sound. Also added a guard so any chunked download that comes back short falls
  back to a plain GET instead of producing a clipped file.

## [1.11.34] - 2026-07-01

### Fixed
- Bilibili downloads: the muxed file played video for only a few minutes and
  then continued as audio-only, and it was named after the browser tab title
  instead of the episode. Added a Bilibili-specific resolver:
  - It caps the video pick at `data.quality` — the quality the viewer is
    actually entitled to. Copyrighted titles gate higher qualities behind VIP
    and return a short *trial* clip for them while the audio track stays full
    length, so the previous "highest resolution" pick grabbed the trial video.
  - It names the file after the current part's episode title (from the page's
    `__INITIAL_STATE__.videoData.pages`), falling back to the collection title,
    instead of the `…_哔哩哔哩_bilibili` tab title.
  - The sniffer now stashes the whole playurl `data` block (not just `dash`) on
    Bilibili so switching parts in-page keeps both selections correct.

## [1.11.33] - 2026-07-01

### Added
- Support for adaptive media delivered as a DASH manifest embedded in JSON — a
  `dash` object holding separate video-only and audio-only representations, each
  with its own full `baseUrl` (typically `.m4s`) and no `.mp4`/`.m3u8` URL for
  the generic sniffer to catch, so such pages reported "No media found". The
  manifest is now detected structurally (no hostname): the sniffer stashes the
  freshest one seen in traffic and the content script also scans the page's
  inline scripts, then picks the best video + audio and muxes them to MP4 via
  the existing offscreen FFmpeg pipeline.

## [1.11.32] - 2026-06-30

### Changed
- The authorized-XHR resolver now detects its scheme structurally (player-config
  hash + video id markers) instead of by hostname, so it carries no specific
  site name. Behavior on supported pages is unchanged.

## [1.11.31] - 2026-06-30

### Changed
- Genericized internal comments, identifiers, and changelog wording (no
  behavior change).

## [1.11.30] - 2026-06-30

### Changed
- Facebook downloads now work end to end (video + audio captured via the worker
  interception, muxed to MP4). Removed the temporary resolver diagnostic logging.

## [1.11.29] - 2026-06-30

### Fixed
- Fixed a `grandTotal is not defined` ReferenceError that crashed every mux
  (YouTube 4K and Facebook) right after ffmpeg finished, so the muxed file was
  produced but the download then failed. The mux itself was working all along.

## [1.11.28] - 2026-06-30

### Fixed
- Mux: if the MP4 muxer rejects the codec combination (some Facebook AV1/VP9
  fragmented streams cause the mux to fail at ~99%), automatically retry into a
  Matroska (.mkv) container, which accepts AV1/VP9 + AAC — so the download still
  produces a playable file. Capture ffmpeg's log tail and report it on failure.

## [1.11.27] - 2026-06-30

### Added
- Facebook (experimental): intercept the media Web Worker to capture the signed
  audio/video segment URLs the main-thread hooks can't see. On facebook.com
  only, Worker is wrapped to inject the same capture into the worker scope and
  relay URLs back; any failure falls back to a normal Worker so playback is
  never broken. Re-added a temporary resolver diagnostic to confirm capture.

## [1.11.26] - 2026-06-30

### Changed
- Removed the temporary Facebook resolver diagnostics. Facebook support stays
  best-effort: it only works when both the video and audio signed streams happen
  to be fetched on the main thread. In practice Facebook fetches the audio stream
  in a media Web Worker that a content script cannot intercept, so the signed
  audio URL is usually unavailable and the download falls back to "no media
  found" instead of producing a wrong/partial file.

## [1.11.24] - 2026-06-30

### Changed
- Added a diagnostic log to the Facebook resolver (counts of sniffed fbcdn URLs,
  how many are signed, the per-video stream groups, and the target video id) to
  pinpoint why a pair can't be formed.

## [1.11.23] - 2026-06-30

### Fixed
- Mux: explicitly map video from the first input and audio from the second
  (`-map 0:v:0 -map 1:a:0`) so ffmpeg can never silently produce an audio-only
  file if it mis-detects a stream (e.g. Facebook's AV1/VP9 video).

## [1.11.22] - 2026-06-30

### Fixed
- Facebook: fixed downloading audio-only from the wrong video. Three causes: the
  sniffer URL cache (80) was smaller than Facebook's segment count (120+), so the
  target video's streams were evicted; the resolver guessed the "most-buffered"
  video instead of the one in the page URL; and when it couldn't form a
  video+audio pair it fell through to a stray fbcdn audio segment. Now it targets
  the page's video_id (watch?v= / /videos/<id>), keeps up to 300 sniffed URLs,
  and refuses to download a lone fbcdn segment.

## [1.11.21] - 2026-06-30

### Fixed
- Facebook: the video stream downloaded but the audio 403'd with "Bad URL hash"
  because the sniffer had picked an unsigned audio URL (missing the `oh`/`oe`
  signature). Only consider fbcdn stream URLs that carry the signature, so both
  video and audio use properly-signed URLs.

## [1.11.20] - 2026-06-30

### Added
- Facebook DASH support. Facebook serves separate video + audio streams whose
  bare URLs 403; byte ranges must be in the URL (`&bytestart=&byteend=`), not a
  Range header. The content script now groups the sniffed `*.fbcdn.net` streams
  by `video_id` (decoded from the `efg` param), picks the best video + its
  audio, requests each as a full-range URL via a plain GET (no Range header,
  with the page Referer and no Origin), and muxes them with FFmpeg.
- The muxer (`downloadMux`) and direct downloader now detect byte-range URLs and
  fetch them plainly instead of adding a conflicting Range header.

### Notes
- Picks the most-buffered video on the page, which is the right one on a single
  video page; on a multi-video feed it may pick the wrong one — open the video
  on its own page and let it play briefly before downloading.

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
- All direct downloads (X, TikTok, generic MP4, and the YouTube progressive
  fallback) now use the same concurrent Range-chunk downloader as
  the YouTube mux path — 10 MB chunks, 5 in parallel — which is much faster and
  bypasses per-connection rate throttling. Servers that don't support Range fall
  back automatically to a single streamed GET, and HTML error pages served in
  place of media are rejected up front.

## [1.11.16] - 2026-06-30

### Added
- Added support for sites that expose video only through an authorized XHR. The
  page's bare MP4 link 403s; the real per-quality MP4s come from an XHR endpoint
  whose hash is derived from the page (four 8-hex-digit chunks → base36). The
  extension replicates that and calls the API from the page (the returned URL is
  signed to the viewer's IP, so it must run there), downloading the best quality.

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
  YouTube and Referer-gated HLS cases.

## [1.11.10] - 2026-06-30

### Fixed
- Fixed generic HLS detection picking up a bogus URL on sites that declare the
  stream inside an inline script (e.g. `var hlsUrl = '…m3u8';…`). The whole
  script snippet was being resolved as a relative URL and mistaken for the
  playlist, so the download hit a non-existent path and 403'd. Media detection
  now rejects candidates that aren't a single clean URL token; the real playlist
  URL is still recovered via regex extraction. Combined with the v1.11.9 Referer
  fix, Referer-gated sites now download correctly.

## [1.11.9] - 2026-06-30

### Fixed
- Fixed generic HLS/MP4 downloads that failed with a 403 on Referer-gated CDNs.
  The extension now spoofs the page's `Referer`/`Origin`
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
