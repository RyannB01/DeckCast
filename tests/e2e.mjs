// tests/e2e.mjs - DeckCast end-to-end tests in headless Chromium via Playwright.
// Run: node tests/e2e.mjs  (or npm run test:e2e, or npm test for the full suite)
// Exit code 0 means every check passed.
//
// Paths covered: paste transcript -> build deck -> view slides (with inline
// diagram SVGs) -> export .pptx; load sample; upload audio with the stubbed
// Whisper library (first transcription throws, retry succeeds, and it stays
// good across a reload); microphone fallback; assistant boot + mock chat;
// privacy/terms/robots/sitemap/og-image; peer network files published;
// custom 404; mobile layout; the third-party network audit; page load and
// generation timings.
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { pptxSlideXml } from "./pptx-zip.mjs";

// "rgb(46, 36, 26)" -> "2E241A", for comparing a preview colour with the
// colour baked into the exported .pptx.
function rgbToHex(rgb) {
  const m = String(rgb || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return "";
  return [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, "0")).join("").toUpperCase();
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8901;
const DL_DIR = "/tmp/deckcast-dl";
mkdirSync(DL_DIR, { recursive: true });

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); }
  else { failed += 1; console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
}

// ---- Chromium: prefer the Playwright cache, else a system Chrome --------------
function resolveChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = path.join(process.env.HOME || "", ".cache/ms-playwright");
  if (existsSync(cache)) {
    const dirs = readdirSync(cache)
      .filter((d) => d.startsWith("chromium-") || d.startsWith("chromium_headless_shell-"))
      .sort().reverse();
    for (const d of dirs) {
      for (const c of [
        path.join(cache, d, "chrome-linux64/chrome"),
        path.join(cache, d, "chrome-linux/chrome"),
        path.join(cache, d, "chrome-headless-shell-linux64/chrome-headless-shell"),
      ]) if (existsSync(c)) return c;
    }
  }
  return undefined;
}

// ---- Static server -----------------------------------------------------------
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml",
  ".txt": "text/plain", ".woff2": "font/woff2", ".png": "image/png", ".xml": "application/xml",
  ".wasm": "application/wasm",
};
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(ROOT, url === "/" ? "index.html" : url);
  if (!existsSync(file) || !file.startsWith(ROOT)) {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end(readFileSync(path.join(ROOT, "404.html")));
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// ---- A 1-second 440 Hz tone, for the audio-upload path -------------------------
function writeToneWav(file) {
  const sampleRate = 8000;
  const n = sampleRate;
  const data = Buffer.alloc(44 + n);
  data.write("RIFF", 0); data.writeUInt32LE(36 + n, 4); data.write("WAVE", 8);
  data.write("fmt ", 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate, 28); data.writeUInt16LE(1, 32); data.writeUInt16LE(8, 34);
  data.write("data", 36); data.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i += 1) data[44 + i] = 128 + Math.round(100 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
  writeFileSync(file, data);
}
const TONE = "/tmp/deckcast-tone.wav";
writeToneWav(TONE);

const requests = [];
const failedRequests = [];
const fontRequests = [];
const pageErrors = [];
let totalBytes = 0;

let browser;
try {
  const executablePath = resolveChromium();
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-gpu", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.on("request", (req) => requests.push(req.url()));
  page.on("response", (res) => {
    if (res.status() >= 400) failedRequests.push({ url: res.url(), status: res.status() });
    if (res.url().includes("/fonts/")) fontRequests.push({ url: res.url(), status: res.status() });
  });
  page.on("pageerror", (err) => pageErrors.push(`pageerror: ${String(err).slice(0, 200)}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(`console.error: ${msg.text().slice(0, 200)}`);
  });

  // ---- Whisper stub: the real library is 900 KB and the model is a 44 MB
  // download from Hugging Face, so the upload test intercepts it with a small
  // stand-in that speaks the same API (env plus pipeline returning a
  // transcriber). The stand-in throws on its first transcription call and
  // returns a fixture transcript after that; the call count lives in
  // localStorage, so it stays good across a page reload. This covers the
  // upload error path, the retry button, and the success path without
  // downloading the model in CI.
  const WHISPER_FIXTURE = "Photosynthesis is how plants make food from sunlight. The light reactions split water and release oxygen. The Calvin cycle fixes carbon dioxide into sugar.";
  const WHISPER_STUB = `
export const env = { allowRemoteModels: true, allowLocalModels: false, localModelPath: "", backends: { onnx: { wasm: { wasmPaths: "", numThreads: 1 } } } };
export async function pipeline(task, model, options) {
  const cb = options && options.progress_callback;
  if (cb) {
    cb({ status: "progress", file: "onnx/encoder_model_quantized.onnx", loaded: 50, total: 100 });
    cb({ status: "progress", file: "onnx/encoder_model_quantized.onnx", loaded: 100, total: 100 });
  }
  return async (samples, opts) => {
    const key = "deckcast-whisper-stub-calls";
    const n = Number(window.localStorage.getItem(key) || "0") + 1;
    window.localStorage.setItem(key, String(n));
    if (n === 1) throw new Error("stubbed transcription failure");
    return { text: ${JSON.stringify(WHISPER_FIXTURE)} };
  };
}
`;
  await page.route("**/vendor/transformers.min.js", (route) => route.fulfill({ contentType: "text/javascript", body: WHISPER_STUB }));

  // ---- 1. Page loads ---------------------------------------------------------
  const loadStart = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
  const loadMs = Date.now() - loadStart;
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return n ? { domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) } : null;
  });
  check("page title is DeckCast", (await page.title()).includes("DeckCast"));
  check("PptxGenJS loaded from vendor bundle", await page.evaluate(() => typeof window.PptxGenJS === "function"));
  check("page load event under 5s (local)", loadMs < 5000, `${loadMs}ms, nav load=${nav?.load}ms, domContentLoaded=${nav?.domContentLoaded}ms`);

  // ---- 2. Empty states look intentional on first load --------------------------
  check("transcript empty state shows a heading", await page.locator("#transcript-view .empty-state h3").innerText().then((t) => t.includes("No transcript yet")).catch(() => false));
  check("deck empty state shows a heading", await page.locator("#slides-container .empty-state h3").innerText().then((t) => t.includes("No deck yet")).catch(() => false));
  // The skeleton is removed by boot within milliseconds of load, so its
  // presence is checked in the served HTML, not the live DOM.
  const rawHtml = await (await page.request.get(`http://127.0.0.1:${PORT}/`)).text();
  check("assistant skeleton ships in the page markup", rawHtml.includes('id="assistant-skeleton"'));

  // ---- 3. Paste a transcript ---------------------------------------------------
  const sample = readFileSync(path.join(ROOT, "sample-lecture.txt"), "utf8");
  await page.fill("#transcript-input", sample);
  await page.click("#use-transcript");
  await page.waitForFunction(() => document.getElementById("transcript-view").textContent.includes("photosynthesis"), null, { timeout: 5000 });
  check("pasted transcript appears in the view", await page.locator("#transcript-view").innerText().then((t) => t.toLowerCase().includes("photosynthesis")));
  check("word count shown", await page.locator("#transcript-words").innerText().then((t) => t.includes("words")));

  // ---- 4. Skeleton cards hold the layout while the deck builds -----------------
  await page.evaluate(async () => { (await import("/deck.js")).showDeckSkeleton(6); });
  check("skeleton cards render (6 placeholders)", (await page.locator(".slide-skeleton").count()) === 6);
  check("skeleton cards match the deck grid", await page.evaluate(() => {
    const skel = document.querySelector(".slide-skeleton");
    const grid = document.querySelector("#slides-container");
    return !!skel && getComputedStyle(grid).display === "grid";
  }));

  // ---- 5. Build the deck ---------------------------------------------------------
  const buildStart = Date.now();
  await page.click("#build-deck");
  await page.waitForSelector(".slide-card:not(.slide-skeleton)", { timeout: 10000 });
  const buildMs = Date.now() - buildStart;
  const slideCount = await page.locator(".slide-card:not(.slide-skeleton)").count();
  check("deck builds with 5 or more slides", slideCount >= 5, `${slideCount} slides`);
  check("deck builds in under 2s", buildMs < 2000, `${buildMs}ms`);
  check("deck status reports success", await page.locator("#deck-status").innerText().then((t) => t.includes("Deck built")));
  check("slide titles mention photosynthesis", await page.locator("#slides-container").innerText().then((t) => t.toLowerCase().includes("photosynthesis")));
  check("slide cards stagger in (animation delay steps)", await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".slide-card:not(.slide-skeleton)")];
    const delays = cards.map((c) => c.style.animationDelay);
    return delays[0] === "0ms" && delays[1] === "40ms";
  }));
  check("skeleton is gone once the deck renders", (await page.locator(".slide-skeleton").count()) === 0);
  check("diagram slides render as inline SVG", (await page.locator(".diagram-wrap svg").count()) >= 2, `${await page.locator(".diagram-wrap svg").count()} SVGs`);
  check("flow diagram names its steps", await page.evaluate(() => {
    const text = [...document.querySelectorAll(".diagram-wrap svg")].map((s) => s.textContent).join(" ");
    return text.toLowerCase().includes("light-dependent") && text.includes("Calvin cycle") && text.includes("G3P");
  }));
  check("bar chart names its labels", await page.evaluate(() => {
    const text = [...document.querySelectorAll(".diagram-wrap svg")].map((s) => s.textContent).join(" ");
    return text.includes("Carbon dioxide") && text.includes("Water") && text.includes("Glucose") && text.includes("Oxygen");
  }));

  // ---- 6. Export the .pptx ---------------------------------------------------------
  const exportStart = Date.now();
  const downloadPromise = page.waitForEvent("download", { timeout: 15000 });
  await page.click("#export-deck");
  const download = await downloadPromise;
  const exportMs = Date.now() - exportStart;
  const outPath = path.join(DL_DIR, download.suggestedFilename());
  await download.saveAs(outPath);
  const bytes = readFileSync(outPath);
  check("export downloads a .pptx file", outPath.endsWith(".pptx") && bytes.length > 10000, `${download.suggestedFilename()}, ${bytes.length} bytes`);
  check("downloaded .pptx starts with ZIP magic", bytes[0] === 0x50 && bytes[1] === 0x4b);
  check("export finishes in under 10s", exportMs < 10000, `${exportMs}ms`);
  check("export status reports the file", await page.locator("#export-status").innerText().then((t) => t.includes(".pptx")));

  // ---- 6b. Export themes: picker, themed preview, themed export, persistence ----
  check("export theme picker is present with three options", (await page.locator("#export-theme option").count()) === 3);
  check("export theme defaults to cream", (await page.locator("#export-theme").inputValue()) === "cream");
  await page.selectOption("#export-theme", "dark");
  await page.waitForFunction(() => document.querySelector("#slides-container").getAttribute("data-export-theme") === "dark", null, { timeout: 5000 });
  const darkCardBg = await page.locator(".slide-card:not(.slide-title)").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const darkTitleBg = await page.locator(".slide-card.slide-title").evaluate((el) => getComputedStyle(el).backgroundColor);
  check("dark preview shows the dark card colour", darkCardBg === "rgb(46, 36, 26)", darkCardBg);
  check("dark preview shows the darker title colour", darkTitleBg === "rgb(34, 26, 18)", darkTitleBg);
  check("dark choice is remembered", (await page.evaluate(() => window.localStorage.getItem("deckcast-export-theme"))) === "dark");
  const darkDownloadPromise = page.waitForEvent("download", { timeout: 15000 });
  await page.click("#export-deck");
  const darkDownload = await darkDownloadPromise;
  const darkPath = path.join(DL_DIR, `dark-${darkDownload.suggestedFilename()}`);
  await darkDownload.saveAs(darkPath);
  const darkBytes = readFileSync(darkPath);
  const darkXml = pptxSlideXml(darkBytes.toString("base64"));
  check("dark export is a real .pptx", darkBytes[0] === 0x50 && darkBytes[1] === 0x4b);
  check("dark export carries the dark colours", darkXml.includes("221A12") && darkXml.includes("2E241A") && darkXml.includes("C9BBA6"));
  check("dark export carries no cream colours", !darkXml.includes("F3E9D7") && !darkXml.includes("6B9CC4"));
  check("preview matches the export (dark)", darkXml.includes(rgbToHex(darkCardBg)) && rgbToHex(darkCardBg) === "2E241A", `${darkCardBg} -> ${rgbToHex(darkCardBg)}`);
  await page.selectOption("#export-theme", "light");
  await page.waitForFunction(() => document.querySelector("#slides-container").getAttribute("data-export-theme") === "light", null, { timeout: 5000 });
  const lightCardBg = await page.locator(".slide-card:not(.slide-title)").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  check("light preview shows white cards", lightCardBg === "rgb(255, 255, 255)", lightCardBg);
  const lightDownloadPromise = page.waitForEvent("download", { timeout: 15000 });
  await page.click("#export-deck");
  const lightDownload = await lightDownloadPromise;
  const lightPath = path.join(DL_DIR, `light-${lightDownload.suggestedFilename()}`);
  await lightDownload.saveAs(lightPath);
  const lightBytes = readFileSync(lightPath);
  const lightXml = pptxSlideXml(lightBytes.toString("base64"));
  check("light export is a real .pptx", lightBytes[0] === 0x50 && lightBytes[1] === 0x4b);
  check("light export carries the light colours", lightXml.includes("FFFFFF") && lightXml.includes("6B9CC4"));
  check("light export carries no cream or dark colours", !lightXml.includes("F3E9D7") && !lightXml.includes("221A12"));
  check("preview matches the export (light)", lightXml.includes(rgbToHex(lightCardBg)) && rgbToHex(lightCardBg) === "FFFFFF", `${lightCardBg} -> ${rgbToHex(lightCardBg)}`);
  // The choice sticks across a reload: the picker, localStorage, and the
  // preview after a rebuild all keep the light theme.
  await page.reload({ waitUntil: "load" });
  check("theme picker keeps the choice across reload", (await page.locator("#export-theme").inputValue()) === "light");
  check("theme stays in localStorage across reload", (await page.evaluate(() => window.localStorage.getItem("deckcast-export-theme"))) === "light");
  await page.click("#load-sample");
  await page.waitForFunction(() => document.getElementById("transcript-view").textContent.includes("photosynthesis"), null, { timeout: 5000 });
  await page.click("#build-deck");
  await page.waitForSelector(".slide-card:not(.slide-skeleton)", { timeout: 10000 });
  const reloadedBg = await page.locator(".slide-card:not(.slide-title)").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  check("preview keeps the theme after reload and rebuild", reloadedBg === "rgb(255, 255, 255)", reloadedBg);
  await page.selectOption("#export-theme", "cream");
  check("theme returns to cream", (await page.evaluate(() => window.localStorage.getItem("deckcast-export-theme"))) === "cream");

  // ---- 7. Load the sample lecture ----------------------------------------------------
  await page.reload({ waitUntil: "load" });
  await page.click("#load-sample");
  await page.waitForFunction(() => document.getElementById("transcript-view").textContent.includes("photosynthesis"), null, { timeout: 5000 });
  check("sample lecture loads into the view", await page.locator("#transcript-words").innerText().then((t) => t.includes("words")));

  // ---- 8. Upload audio: stubbed Whisper, throw then good, across reload --------
  // The Whisper library is intercepted by the stub installed above:
  // the first transcription throws, the retry succeeds, and after a reload
  // the stub is already good. The tone file has no speech, but the stub
  // returns its fixture transcript either way.
  await page.evaluate(() => window.localStorage.removeItem("deckcast-whisper-stub-calls"));
  await page.click(".alt-input > summary");
  await page.setInputFiles("#audio-file", TONE);
  await page.waitForFunction(() => document.getElementById("audio-info").textContent.includes("deckcast-tone.wav"), null, { timeout: 5000 });
  check("uploaded audio is accepted and named", await page.locator("#audio-info").innerText().then((t) => t.includes("deckcast-tone.wav")));
  check("audio player appears for playback", await page.locator("#audio-player").isVisible());
  check("upload hint says transcribed on this device", await page.locator(".alt-input .hint").innerText().then((t) => t.includes("transcribed on this device")));
  await page.waitForFunction(() => document.getElementById("audio-info").textContent.includes("Transcription failed"), null, { timeout: 10000 });
  check("first transcription failure is explained", await page.locator("#audio-info").innerText().then((t) => t.includes("Transcription failed")));
  check("retry button appears after a failure", await page.locator("#audio-retry").isVisible());
  await page.click("#audio-retry");
  await page.waitForFunction(() => document.getElementById("transcript-view").textContent.includes("Photosynthesis is how plants make food"), null, { timeout: 10000 });
  check("retry transcribes and saves the transcript", await page.locator("#transcript-view").innerText().then((t) => t.includes("Calvin cycle")));
  check("transcribed words are counted", await page.locator("#transcript-words").innerText().then((t) => t.includes("words")));
  check("transcription success is reported", await page.locator("#audio-info").innerText().then((t) => t.includes("Transcribed on this device")));
  // Across a reload the stub stays good: a fresh upload succeeds at once.
  await page.reload({ waitUntil: "load" });
  await page.click(".alt-input > summary");
  await page.setInputFiles("#audio-file", TONE);
  await page.waitForFunction(() => document.getElementById("transcript-view").textContent.includes("Photosynthesis is how plants make food"), null, { timeout: 10000 });
  check("upload after reload transcribes without failing", await page.locator("#audio-info").innerText().then((t) => t.includes("Transcribed on this device")));

  // ---- 9. Microphone: live path if the browser offers it, graceful fallback if not ----
  // Headless Chromium exposes SpeechRecognition but its audio service is
  // unreachable, so starting the mic ends in an explained error. A browser
  // without the API disables the button instead. Both are graceful.
  if (await page.locator("#mic-start").isDisabled()) {
    check("mic button disabled without speech recognition", true);
    check("mic status explains the fallback", await page.locator("#mic-status").innerText().then((t) => t.includes("Chrome or Edge") || t.includes("Paste a transcript")));
  } else {
    await page.click("#mic-start");
    await page.waitForFunction(() => document.getElementById("mic-status").textContent.length > 0, null, { timeout: 10000 });
    const micStatus = await page.locator("#mic-status").innerText();
    // Live path (Chrome/Edge): "problem" or "Listening". Whisper path (other
    // browsers): "Transcribing", "Transcription failed", "Recording
    // transcribed", or "no speech". Any of them is a graceful outcome.
    check("mic start degrades gracefully in headless (explained, no crash)", micStatus.includes("problem") || micStatus.includes("Listening") || micStatus.includes("Transcrib") || micStatus.includes("no speech"), micStatus);
    if (await page.locator("#mic-stop").isEnabled()) await page.click("#mic-stop");
    await page.waitForTimeout(500);
    const micFinal = await page.locator("#mic-status").innerText();
    check("mic stop leaves a clear final status", micFinal.length > 10, micFinal);
  }

  // ---- 10. Assistant boots in demo mode ----------------------------------------------------
  await page.waitForFunction(() => !document.getElementById("assistant-status").textContent.includes("Connecting"), null, { timeout: 30000 });
  const assistantStatus = await page.locator("#assistant-status").innerText();
  check("assistant reports demo mode without a key", assistantStatus.includes("demo mode"), assistantStatus.slice(0, 120));
  check("assistant skeleton removed after boot", (await page.locator("#assistant-skeleton").count()) === 0);
  check("assistant chat panel mounted", (await page.locator("#agent-app .ns-chat").count()) >= 1);
  check("AI model settings panel present", await page.locator("#agent-app").innerText().then((t) => t.includes("AI model settings")));
  check("assistant greeting shown", await page.locator("#ns-msgs .ns-msg.bot").first().innerText().then((t) => t.includes("slide decks")));
  check("mock badge reads plain, no warning emoji", await page.evaluate(() => {
    const badge = document.querySelector(".ns-llmbadge");
    return !!badge && badge.textContent.includes("MOCK LLM") && !badge.textContent.includes("\u26a0");
  }));
  check("assistant panel has no emoji or em dash", await page.evaluate(() => {
    const text = document.getElementById("agent-app").innerText;
    return !text.includes("\u2014") && !/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(text);
  }));
  const nsPrimary = await page.evaluate(() => getComputedStyle(document.querySelector("#agent-app")).getPropertyValue("--ns-primary").trim());
  // The runtime sets --ns-primary inline from the manifest theme (hex), which
  // overrides the stylesheet's OKLCH value; either form must be the baby blue.
  check("assistant theme is the baby blue", nsPrimary.toLowerCase() === "#8ec8ee" || (nsPrimary.includes("80.7%") && nsPrimary.includes("238")), nsPrimary);
  const sendButton = page.locator(".ns-inputbar button").first();
  const sendBg = await sendButton.evaluate((el) => getComputedStyle(el).backgroundColor);
  const sendColor = await sendButton.evaluate((el) => getComputedStyle(el).color);
  // Computed text colour comes back as rgb() or as the stylesheet's oklch().
  check("assistant send button is baby blue with dark text", sendBg === "rgb(142, 200, 238)" && (sendColor === "rgb(43, 29, 18)" || sendColor.startsWith("oklch(0.245")), `bg ${sendBg}, text ${sendColor}`);

  // ---- 11. Mock chat turn ---------------------------------------------------------------------
  check("chat input present", (await page.locator("#ns-input").count()) === 1);
  await page.fill("#ns-input", "Turn this lecture into slides.");
  await page.locator("#ns-input").press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#ns-msgs .ns-msg.bot").length >= 2, null, { timeout: 60000 });
  check("assistant replies in mock mode", true);

  // ---- 12. Legal pages, robots, sitemap, social image ----------------------------------------------
  await page.goto(`http://127.0.0.1:${PORT}/privacy.html`, { waitUntil: "load" });
  check("privacy page loads with its heading", await page.locator("h1").innerText().then((t) => t.includes("Privacy")));
  check("privacy page states no cookies on the deployed site", await page.locator("main").innerText().then((t) => t.includes("sets no cookies")));
  check("privacy page states keys stay in the browser", await page.locator("main").innerText().then((t) => t.includes("local storage only")));
  await page.goto(`http://127.0.0.1:${PORT}/terms.html`, { waitUntil: "load" });
  check("terms page loads with its heading", await page.locator("h1").innerText().then((t) => t.includes("Terms")));
  const robots = await page.request.get(`http://127.0.0.1:${PORT}/robots.txt`);
  check("robots.txt serves with a sitemap line", robots.status() === 200 && (await robots.text()).includes("Sitemap:"));
  const sitemap = await page.request.get(`http://127.0.0.1:${PORT}/sitemap.xml`);
  const sitemapText = await sitemap.text();
  check("sitemap lists the three pages", sitemap.status() === 200 && sitemapText.includes("/privacy.html") && sitemapText.includes("/terms.html"));
  const og = await page.request.get(`http://127.0.0.1:${PORT}/og-image.png`);
  check("social preview image serves as PNG", og.status() === 200 && (og.headers()["content-type"] || "").includes("image/png"));

  // ---- 12b. Peer network files are published -----------------------------------------
  const quizNet = await page.request.get(`http://127.0.0.1:${PORT}/quiz_generator.network.json`);
  check("quiz network file serves as JSON", quizNet.status() === 200 && (await quizNet.json()).tools[0].name === "quiz_generator_front");
  const quizHocon = await page.request.get(`http://127.0.0.1:${PORT}/quiz_generator.hocon`);
  check("quiz hocon file serves", quizHocon.status() === 200 && (await quizHocon.text()).includes("quiz_generator"));
  const deckNet = await page.request.get(`http://127.0.0.1:${PORT}/deckcast.network.json`);
  check("deck network file serves and names the quiz peer", deckNet.status() === 200 && (await deckNet.text()).includes("https://ryannb01.github.io/DeckCast/quiz_generator"));
  const manifestRes = await page.request.get(`http://127.0.0.1:${PORT}/agent-manifest.json`);
  const manifestDoc = await manifestRes.json();
  check("manifest serves and lists both networks", manifestRes.status() === 200 && manifestDoc.networks.map((n) => n.name).join(",") === "deckcast,quiz_generator");
  check("manifest lists the set_outline action", manifestDoc.actions.agentTools.includes("set_outline"));
  const wasmRes = await page.request.get(`http://127.0.0.1:${PORT}/vendor/onnx/ort-wasm-simd.wasm`);
  check("ONNX wasm serves with the wasm MIME type", wasmRes.status() === 200 && (wasmRes.headers()["content-type"] || "").includes("application/wasm"));

  // ---- 13. Custom 404 -------------------------------------------------------------------------------
  await page.goto(`http://127.0.0.1:${PORT}/nope.html`, { waitUntil: "load" });
  check("custom 404 page renders", await page.locator("body").innerText().then((t) => t.includes("does not exist")));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });

  // ---- 14. Mobile: layout, menu, touch targets, line length, safe area ----------------------------------
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mob = await mobile.newPage();
  await mob.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
  check("no horizontal overflow at 390px", await mob.evaluate(() => document.documentElement.scrollWidth <= 391), `scrollWidth=${await mob.evaluate(() => document.documentElement.scrollWidth)}`);
  check("mobile menu button visible at 390px", await mob.locator("#menu-button").isVisible());
  await mob.click("#menu-button");
  check("mobile menu opens", await mob.locator("#site-nav").evaluate((el) => el.classList.contains("open")));
  const buildBox = await mob.locator("#build-deck").boundingBox();
  check("primary button is at least 44px tall on mobile", buildBox && buildBox.height >= 44, `${buildBox?.height}px`);
  const navBox = await mob.locator(".site-nav a").first().boundingBox();
  check("nav links are at least 44px tall on mobile", navBox && navBox.height >= 44, `${navBox?.height}px`);
  check("reading text is capped near 65 characters", await mob.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".transcript-view"));
    const px = parseFloat(cs.maxWidth);
    const fontPx = parseFloat(cs.fontSize);
    return px > 400 && px < 700 && px / fontPx < 75;
  }));
  check("viewport declares safe-area support", await mob.evaluate(() => document.querySelector('meta[name="viewport"]').content.includes("viewport-fit=cover")));
  await mobile.close();

  // ---- 15. Third-party + font audit ------------------------------------------------------------------------
  const thirdParty = requests.filter((url) => {
    if (!url || !/^https?:/.test(url)) return false;
    try {
      const host = new URL(url).hostname;
      return host !== "127.0.0.1" && host !== "localhost";
    } catch { return false; }
  });
  check("no request to any third-party host", thirdParty.length === 0, thirdParty.slice(0, 3).join(", "));
  check("self-hosted font requested and served 200",
    fontRequests.some((r) => r.url.endsWith("ibm-plex-sans-latin-wght-normal.woff2") && r.status === 200),
    JSON.stringify(fontRequests));
  check("IBM Plex Sans is the loaded document font",
    await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('600 16px "IBM Plex Sans"'); }));
  check("the only failed request is the intentional /nope.html",
    failedRequests.length === 1 && failedRequests[0].url.endsWith("/nope.html") && failedRequests[0].status === 404,
    JSON.stringify(failedRequests));

  // ---- 16. No page errors --------------------------------------------------------------------------------------
  // The /nope.html navigation logs one generic 404 console line. That is the
  // intentional 404 test, proven by the network audit directly above.
  const realErrors = pageErrors.filter((e) => !e.includes("404"));
  check("no page errors during the whole run", realErrors.length === 0, realErrors.slice(0, 3).join(" || "));

  // Resource-timing total (content-length headers are unreliable for local files).
  totalBytes = await page.evaluate(() => {
    const entries = performance.getEntriesByType("resource");
    const nav = performance.getEntriesByType("navigation");
    return entries.reduce((sum, e) => sum + (e.transferSize || 0), 0) + nav.reduce((sum, e) => sum + (e.transferSize || 0), 0);
  });

  console.log(`\nPerformance (local server, headless Chromium): page load ${loadMs}ms, deck build ${buildMs}ms, total bytes transferred ~${Math.round(totalBytes / 1024)} KB.`);
} catch (err) {
  failed += 1;
  console.log(`FAIL  e2e crashed: ${err.message}`);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
