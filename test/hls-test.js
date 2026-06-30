/*
 * Test harness controller — drives src/hls.js against public test streams so
 * the encrypted / TS / fMP4 code paths can be verified without the extension
 * touching any real website.
 */
import { downloadHls, DownloadControl, CanceledError } from "../src/hls.js";

// Public, license-free test streams. They must send permissive CORS headers
// (these are published for browser players, so they generally do). If one fails
// with a CORS/404 error, try another or paste your own URL.
const PRESETS = [
  {
    label: "MPEG-TS (Mux)",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
  },
  {
    label: "AES-128 (JWPlayer)",
    url: "https://playertest.longtailvideo.com/adaptive/oceans_aes/oceans_aes.m3u8",
  },
  {
    label: "fMP4 (Mux)",
    url: "https://test-streams.mux.dev/pts_shift/master.m3u8",
  },
];

const $ = (id) => document.getElementById(id);
const urlInput = $("url");
const startBtn = $("start");
const pauseBtn = $("pause");
const cancelBtn = $("cancel");
const statusEl = $("status");
const barFill = $("barFill");
const resultEl = $("result");
const logEl = $("log");

let control = null;
let lastObjectUrl = null;

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  logEl.textContent += `[${t}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

// Mirror the pipeline's console.log lines into the on-page log too.
const origLog = console.log.bind(console);
console.log = (...args) => {
  origLog(...args);
  try {
    log(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  } catch (e) {
    /* ignore */
  }
};

function setProgress(done, total) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  barFill.style.width = pct + "%";
  statusEl.textContent = `Downloading… ${done}/${total} (${pct}%)`;
}

function setRunning(running) {
  startBtn.disabled = running;
  pauseBtn.disabled = !running;
  cancelBtn.disabled = !running;
  pauseBtn.textContent = "Pause";
}

// Build preset buttons.
for (const p of PRESETS) {
  const b = document.createElement("button");
  b.className = "preset";
  b.textContent = p.label;
  b.addEventListener("click", () => (urlInput.value = p.url));
  $("presets").appendChild(b);
}
urlInput.value = PRESETS[0].url;

startBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  if (lastObjectUrl) {
    URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = null;
  }
  resultEl.textContent = "";
  barFill.style.width = "0";
  control = new DownloadControl();
  setRunning(true);
  statusEl.textContent = "Starting…";
  log("=== START " + url + " ===");

  const t0 = performance.now();
  try {
    const { blob, ext } = await downloadHls(url, {
      control,
      onProgress: setProgress,
      // No credentials: public test streams use CORS (ACAO:*), which forbids
      // credentialed requests. The extension itself uses "include" for X.
      credentials: "omit",
    });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    lastObjectUrl = URL.createObjectURL(blob);
    const mb = (blob.size / 1048576).toFixed(2);
    statusEl.textContent = `Done ✓ (${mb} MB, ${secs}s)`;
    barFill.style.width = "100%";
    const a = document.createElement("a");
    a.href = lastObjectUrl;
    a.download = "test." + ext;
    a.textContent = `Download result (${mb} MB .${ext})`;
    resultEl.textContent = "";
    resultEl.appendChild(a);
    log(`=== DONE ${mb} MB in ${secs}s ===`);
  } catch (e) {
    if (e instanceof CanceledError) {
      statusEl.textContent = "Canceled";
      log("=== CANCELED ===");
    } else {
      statusEl.textContent = "Error: " + (e && e.message);
      log("=== ERROR: " + (e && e.message) + " ===");
      console.error(e);
    }
  } finally {
    setRunning(false);
  }
});

pauseBtn.addEventListener("click", () => {
  if (!control) return;
  if (control.paused) {
    control.resume();
    pauseBtn.textContent = "Pause";
    log("resumed");
  } else {
    control.pause();
    pauseBtn.textContent = "Resume";
    log("paused");
  }
});

cancelBtn.addEventListener("click", () => {
  if (control) control.cancel();
});
