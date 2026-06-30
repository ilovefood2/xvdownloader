# Privacy Policy - X Video Downloader

_Last updated: June 30, 2026_

X Video Downloader ("the extension") is a browser extension that lets you
download videos from x.com / twitter.com and, starting in version 1.11.0, from
other websites when the page exposes a direct MP4 or HLS media URL. Your privacy
matters, and this policy explains exactly what the extension does and does not
do with data.

## Summary

**The extension does not collect, store, transmit, or sell any personal
information.** There are no analytics, no tracking, no accounts, and no
third-party servers operated by us.

## What the extension does

- On x.com and twitter.com, it detects videos in tweets and shows a
  **Download** button when you hover over a video.
- On other normal `http://` and `https://` websites, it detects video elements
  and looks locally for direct `.mp4` or `.m3u8` media URLs.
- To find media URLs, it inspects page information that your browser already
  loads, such as video element sources, browser performance entries, and page
  fetch / XHR responses. This inspection happens locally in your browser.
- When you click **Download**, it saves the selected media file to your computer
  using Chrome's standard download feature. HLS streams may be assembled locally
  in the extension's offscreen document.

All of this happens locally in your browser and only in response to your click.

## Data collection

The extension collects **no data**. Specifically:

- It does **not** collect personally identifiable information, browsing history,
  credentials, cookies, messages, or analytics.
- It does **not** send any data to servers operated by the developer. There are
  no developer-operated servers.
- It does **not** use persistent identifiers for tracking.

## Network requests

When you click **Download**, the extension may request the media file, HLS
playlist, HLS segments, or encryption key directly from the website or media host
that served the video. These requests happen between your browser and that
website or media host, and are subject to that website's own privacy policy.

The extension does not send user data to any developer-operated server.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `downloads` | To save the selected video file to your device after you click Download. |
| `offscreen` | To assemble HLS media and build downloadable blobs in Manifest V3. |
| Host access to `http://*/*` and `https://*/*` | To detect videos and media URLs on x.com, twitter.com, and other websites where the extension is used. |

The extension requests no other permissions.

## Data sharing and sale

We do not share, sell, rent, or trade any data, because we do not collect any.

## Children's privacy

The extension is not directed at children and collects no data from anyone.

## Changes to this policy

If this policy changes, the updated version will be published in this
repository with a new "Last updated" date.

## Contact

For questions about this privacy policy, contact: **ikelca@gmail.com**
