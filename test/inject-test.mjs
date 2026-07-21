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

console.log("inject card extraction and replay: ok");
