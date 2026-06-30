# Changelog

All notable changes to X Video Downloader are recorded here. The version here
matches the `version` field in `manifest.json`.

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
