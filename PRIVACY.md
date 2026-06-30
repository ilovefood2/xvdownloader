# Privacy Policy — X Video Downloader

_Last updated: June 30, 2026_

X Video Downloader ("the extension") is a browser extension that lets you
download videos from tweets on x.com / twitter.com. Your privacy matters, and
this policy explains exactly what the extension does and does not do with data.

## Summary

**The extension does not collect, store, transmit, or sell any personal
information.** There are no analytics, no tracking, no accounts, and no
third-party servers operated by us.

## What the extension does

- Runs a content script on `x.com` and `twitter.com` that detects videos in
  tweets and shows a **Download** button when you hover over a video.
- When you click **Download**, it reads the tweet's public status id from the
  page and requests the video's direct MP4 link from X's own public endpoint
  (`cdn.syndication.twimg.com`).
- Saves the resulting MP4 file to your computer using the browser's standard
  download feature.

All of this happens locally in your browser and only in response to your click.

## Data collection

The extension collects **no data**. Specifically:

- It does **not** collect personally identifiable information, browsing
  history, credentials, or analytics.
- It does **not** send any data to servers operated by the developer (there are
  none).
- It does **not** use cookies or persistent identifiers for tracking.

## Network requests

The only network request the extension initiates is to X's public syndication
endpoint (`https://cdn.syndication.twimg.com`) to resolve the direct video URL
for the tweet you chose, and the subsequent download of the video file itself
from X's media servers (`https://video.twimg.com`). These requests go directly
between your browser and X's servers and are subject to
[X's Privacy Policy](https://twitter.com/en/privacy).

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `downloads` | To save the selected video file to your device. |
| Host access to `x.com` / `twitter.com` | To show the download button on tweets. |
| Host access to `cdn.syndication.twimg.com` / `video.twimg.com` | To resolve and fetch the video file. |

The extension requests no other permissions and does not run on any other
websites.

## Data sharing and sale

We do not share, sell, rent, or trade any data, because we do not collect any.

## Children's privacy

The extension is not directed at children and collects no data from anyone.

## Changes to this policy

If this policy changes, the updated version will be published in this
repository with a new "Last updated" date.

## Contact

For questions about this privacy policy, contact: **ikelca@gmail.com**
