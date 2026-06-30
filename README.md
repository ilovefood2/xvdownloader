# X Video Downloader

A Chrome (Manifest V3) extension that shows a **Download** button when your
cursor is over a video in a tweet on [x.com](https://x.com) (or twitter.com).
Click it to save the video as an MP4.

## How it works

- A content script watches the page for `<video>` elements inside tweets and
  overlays a download button that appears on hover.
- When clicked, it reads the tweet's status id from the DOM and asks the
  background service worker to resolve the video.
- The background worker calls X's public syndication endpoint
  (`cdn.syndication.twimg.com/tweet-result`), picks the **highest-bitrate MP4**
  variant, and downloads it with the `chrome.downloads` API.

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
| `src/content.js` | Detects videos, renders the hover button |
| `src/background.js` | Resolves the MP4 URL and triggers the download |
| `src/styles.css` | Button styling |
| `icons/` | Toolbar / store icons |

## Notes & limitations

- Works on public videos and GIFs. Videos in protected/private accounts that
  aren't accessible to the syndication endpoint may not resolve.
- For tweets containing multiple videos, the button maps to the hovered video
  by its position within the tweet.
- The downloaded file is named `x_<tweetId>_<resolution>.mp4`.
- This extension is for downloading content you have the rights to. Respect
  copyright and X's Terms of Service.

## Privacy

The extension collects no data. See the [Privacy Policy](PRIVACY.md).
