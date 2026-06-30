# Changelog

All notable changes to X Video Downloader are recorded here. The version here
matches the `version` field in `manifest.json`.

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
