import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const tweetId = "2078733576162472331";
const variants = [
  {
    content_type: "application/x-mpegURL",
    url: "https://video.twimg.com/amplify_video/example/video.m3u8",
  },
  {
    bitrate: 2176000,
    content_type: "video/mp4",
    url: "https://video.twimg.com/amplify_video/example/1280x720.mp4",
  },
];
const unifiedCard = JSON.stringify({
  media_entities: {
    media: { id_str: "2039605237347225600", video_info: { variants } },
  },
});
const payload = {
  data: {
    tweet: {
      __typename: "Tweet",
      rest_id: tweetId,
      legacy: { full_text: "Sensitive card video" },
      card: {
        legacy: {
          binding_values: [
            {
              key: "unified_card",
              value: { type: "STRING", string_value: unifiedCard },
            },
          ],
        },
      },
    },
  },
};

const listeners = new Map();
const messages = [];
const window = {
  addEventListener(type, listener) {
    const list = listeners.get(type) || [];
    list.push(listener);
    listeners.set(type, list);
  },
  postMessage(data) {
    messages.push(data);
    for (const listener of listeners.get("message") || []) {
      listener({ source: window, data });
    }
  },
  fetch: async (url) => ({
    url,
    clone: () => ({ json: async () => payload }),
  }),
  XMLHttpRequest: undefined,
};

const source = fs.readFileSync(new URL("../src/inject.js", import.meta.url), "utf8");
vm.runInNewContext(source, { window, console, Object, JSON, Array, String });

await window.fetch("https://x.com/i/api/graphql/example/TweetDetail");
await new Promise((resolve) => setTimeout(resolve, 0));

const first = messages.find((message) => message.source === "XVD_MEDIA");
assert.ok(first, "sniffer should publish card media");
assert.deepEqual(first.tweets[tweetId].lists[0], variants);
assert.equal(first.tweets[tweetId].text, "Sensitive card video");

messages.length = 0;
window.postMessage({ source: "XVD_MEDIA_REQUEST" }, "*");
const replay = messages.find((message) => message.source === "XVD_MEDIA");
assert.ok(replay, "sniffer should replay media captured before content startup");
assert.deepEqual(replay.tweets[tweetId].lists[0], variants);

const postId = "2061910725921309178";
const postVariants = [
  {
    bit_rate: 2176000,
    content_type: "video/mp4",
    url: "https://video.twimg.com/amplify_video/chat/1080x1920.mp4",
  },
  {
    content_type: "application/x-mpegURL",
    url: "https://video.twimg.com/amplify_video/chat/playlist.m3u8",
  },
];

payload.data = {
  tweet_result_by_rest_id: {
    rest_id: postId,
    result: {
      rest_id: postId,
      media_entities: [
        {
          media_results: {
            result: {
              media_info: {
                variants: postVariants,
              },
            },
          },
        },
      ],
    },
  },
};
messages.length = 0;
await window.fetch("https://api.x.com/graphql/example/GetPostById");
await new Promise((resolve) => setTimeout(resolve, 0));

const postMessage = messages.find((message) => message.source === "XVD_MEDIA");
assert.ok(postMessage, "sniffer should publish GetPostById media");
assert.deepEqual(postMessage.tweets[postId].lists[0], postVariants);

const wrappedPostId = "2078445675776475525";
payload.data = {
  tweet_result_by_rest_id: {
    rest_id: wrappedPostId,
    result: {
      limited_action_results: {},
      tweet: {
        rest_id: wrappedPostId,
        media_entities: [
          {
            media_results: {
              result: {
                media_info: {
                  variants: postVariants,
                },
              },
            },
          },
        ],
      },
    },
  },
};
messages.length = 0;
await window.fetch("https://api.x.com/graphql/example/GetPostById");
await new Promise((resolve) => setTimeout(resolve, 0));

const wrappedPostMessage = messages.find((message) => message.source === "XVD_MEDIA");
assert.ok(wrappedPostMessage, "sniffer should publish wrapped GetPostById media");
assert.deepEqual(wrappedPostMessage.tweets[wrappedPostId].lists[0], postVariants);

console.log("inject card/GetPostById extraction and replay: ok");
