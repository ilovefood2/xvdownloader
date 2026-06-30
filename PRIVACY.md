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
- To find the video's direct MP4 link, it inspects the responses from X's own
  API that your browser already loads while you use the site. This inspection
  happens locally in your browser; nothing is sent anywhere. (As a fallback it
  may request public tweet data from X's syndication endpoint,
  `cdn.syndication.twimg.com`.)
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

The extension downloads the video file from X's media servers
(`https://video.twimg.com`) when you click Download. As a fallback it may also
request public tweet data from X's syndication endpoint
(`https://cdn.syndication.twimg.com`). It makes no other network requests, and
reading X's already-loaded API responses to locate the video happens locally in
your browser. All such requests go directly between your browser and X's servers
and are subject to [X's Privacy Policy](https://twitter.com/en/privacy).

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
