// deck.js - DeckCast page logic: lecture input, deck building, rendering, export.
// State lives here. deckcast-actions.js and site.js import from this module.
// Rendering uses textContent only, never innerHTML with user or model text.

import { extractOutline, buildSlides, verifyDeck, createPptx, slugify, countWords, stripTimestamps, cleanTranscript, diagramSvg, resolveExportTheme } from "./deckcast-core.js";
import { transcribeBlob } from "./whisper.js";
import { agentLink, hasRealModel, setModelError } from "./agent-link.js";

export const MAX_AUDIO_MB = 50;
export const EXPORT_THEME_KEY = "deckcast-export-theme";

// localStorage, guarded: absent in Node (unit tests) and in private mode.
function storageGet(key) {
  try { return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null; } catch { return null; }
}
function storageSet(key, value) {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(key, value); } catch { /* private mode: the theme just does not stick */ }
}

export const app = {
  title: "",
  transcript: "",
  transcriptSource: null, // "paste" | "mic" | "mic-whisper" | "upload" | "sample" | null
  audioFile: null, // { name, size, url, file }
  outline: null,
  slides: [],
  deckBuilt: false,
  outlineSource: null, // "model" | "deterministic" | null: which path wrote the current outline
  recording: false,
  // The export theme: the visitor's last choice, remembered in localStorage.
  // Cream is the site palette and the default.
  exportTheme: resolveExportTheme(storageGet(EXPORT_THEME_KEY)),
};

// Choose the export theme for the .pptx and the on-screen preview. The
// choice is remembered in localStorage so it sticks across visits. An
// unknown name falls back to cream.
export function setExportTheme(name) {
  const theme = resolveExportTheme(name);
  app.exportTheme = theme;
  storageSet(EXPORT_THEME_KEY, theme);
  const picker = el("export-theme");
  if (picker) picker.value = theme;
  applyExportTheme();
  renderDeck();
  return { ok: true, theme };
}
export function getExportTheme() {
  return app.exportTheme;
}

// Put the theme on the preview container so the slide cards follow it. The
// site itself stays cream and blue; only the preview cards change.
function applyExportTheme() {
  const container = el("slides-container");
  if (container) container.setAttribute("data-export-theme", app.exportTheme);
}

function el(id) {
  // Guarded so the pure state functions can be unit-tested in Node, where
  // there is no document. Rendering helpers no-op on the nulls.
  return typeof document === "undefined" ? null : document.getElementById(id);
}

// Run on the next animation frame in the browser; run at once in Node.
function nextFrame(fn) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else fn();
}

function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function skeletonLine(width) {
  const line = document.createElement("div");
  line.className = "skeleton skeleton-line";
  if (width) line.style.width = width;
  return line;
}

// Placeholder shapes that hold the layout while content loads, so the page
// never shows a blank area or jumps when the real content arrives.
export function showTranscriptSkeleton() {
  const view = el("transcript-view");
  if (!view) return;
  clearNode(view);
  view.append(skeletonLine("90%"), skeletonLine("75%"), skeletonLine("85%"), skeletonLine("60%"));
}

export function showDeckSkeleton(count) {
  const container = el("slides-container");
  if (!container) return;
  clearNode(container);
  const n = Math.max(1, Math.min(count || 6, 10));
  for (let i = 0; i < n; i += 1) {
    const card = document.createElement("article");
    card.className = "slide-card slide-skeleton";
    const title = document.createElement("div");
    title.className = "skeleton skeleton-title";
    card.append(title, skeletonLine("90%"), skeletonLine("70%"), skeletonLine("80%"));
    container.appendChild(card);
  }
}

function setStatus(node, message, kind) {
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind || "info";
}

function esc(text) {
  return String(text ?? "");
}

export function getLectureState() {
  return {
    ok: true,
    title: app.title,
    hasTranscript: app.transcript.trim().length > 0,
    transcriptWords: countWords(app.transcript),
    transcriptSource: app.transcriptSource,
    transcriptExcerpt: app.transcript ? stripTimestamps(app.transcript).slice(0, 1200) : "",
    hasOutline: !!app.outline,
    outlineSlides: app.outline ? app.outline.slides.length : 0,
    hasDeck: app.deckBuilt,
    slideCount: app.slides.length,
    slideTitles: app.slides.map((s) => s.title),
    audioFile: app.audioFile ? { name: app.audioFile.name, size: app.audioFile.size } : null,
  };
}

export function setTranscript(text, source) {
  // The stored transcript is the cleaned one: timestamps and filler words
  // never reach the deck builder, the view, or the fact checker.
  const clean = cleanTranscript(String(text || "").trim());
  if (!clean) return { ok: false, reason: "The transcript is empty." };
  app.transcript = clean;
  app.transcriptSource = source || "paste";
  app.outline = null;
  app.outlineSource = null;
  app.slides = [];
  app.deckBuilt = false;
  renderTranscript();
  renderDeck();
  return { ok: true, words: countWords(clean), source: app.transcriptSource };
}

// Store a model-written outline on the page: the structure or slide_designer
// agent's rewritten deck, after the deterministic pipeline has already
// produced its own. The outline is validated (2-12 slides, titles at most
// 80 characters, 0-5 bullets of at most 200 characters each, notes at most
// 1000 characters) and cleaned defensively: timestamps and filler words are
// stripped from titles, bullets and notes, and every bullet gets source null,
// because a model-written bullet has no transcript sentence to point at. The
// fact checker verifies source-less bullets against the whole transcript.
export function setOutline(outline) {
  if (!outline || typeof outline !== "object" || !Array.isArray(outline.slides)) {
    return { ok: false, reason: "The outline needs a slides list." };
  }
  const title = String(outline.title || "").trim();
  if (!title) return { ok: false, reason: "The outline needs a title." };
  if (title.length > 80) return { ok: false, reason: "The outline title is longer than 80 characters." };
  if (outline.slides.length < 2 || outline.slides.length > 12) {
    return { ok: false, reason: "The outline needs between 2 and 12 slides." };
  }
  const types = new Set(["title", "content", "summary", "diagram"]);
  const slides = [];
  for (const slide of outline.slides) {
    if (!slide || typeof slide !== "object") return { ok: false, reason: "Every slide needs a title and a type." };
    const slideTitle = cleanTranscript(String(slide.title || "").trim());
    if (!slideTitle) return { ok: false, reason: "Every slide needs a title." };
    if (slideTitle.length > 80) return { ok: false, reason: `The slide "${slideTitle.slice(0, 40)}" has a title longer than 80 characters.` };
    const type = types.has(slide.type) ? slide.type : "content";
    const bullets = Array.isArray(slide.bullets) ? slide.bullets : [];
    if (bullets.length > 5) return { ok: false, reason: `The slide "${slideTitle.slice(0, 40)}" has more than 5 bullets.` };
    const cleanBullets = [];
    for (const b of bullets) {
      const text = cleanTranscript(String((b && b.text) || "").trim());
      if (!text) continue;
      if (text.length > 200) return { ok: false, reason: `A bullet on "${slideTitle.slice(0, 40)}" is longer than 200 characters.` };
      cleanBullets.push({ text, source: null });
    }
    const notes = cleanTranscript(String(slide.notes || "").trim()).slice(0, 1000);
    slides.push({ type, title: slideTitle, bullets: cleanBullets, notes, diagram: slide.diagram || null });
  }
  app.outline = { title: cleanTranscript(title), slides };
  app.outlineSource = "model";
  app.slides = buildSlides(app.outline);
  app.deckBuilt = false;
  renderDeck();
  return { ok: true, slides: app.slides.length, title: app.outline.title };
}

export function buildOutline() {
  if (!app.transcript.trim()) {
    return { ok: false, reason: "There is no transcript yet. Paste one, record with the microphone, or load the sample lecture first." };
  }
  app.outline = extractOutline(app.transcript, app.title || "Untitled lecture");
  app.outlineSource = "deterministic";
  app.slides = buildSlides(app.outline);
  app.deckBuilt = false;
  return { ok: true, slides: app.outline.slides.length, title: app.outline.title };
}

export function renderSlides() {
  if (!app.outline) {
    const built = buildOutline();
    if (!built.ok) return built;
  }
  // Hold the layout with skeleton cards, then paint the real deck on the
  // next frame. For the fast deterministic build the skeleton is visible for
  // about a frame; for an agent-driven build it holds the space while the
  // turn finishes.
  showDeckSkeleton(app.slides.length);
  nextFrame(() => {
    app.deckBuilt = true;
    renderDeck();
  });
  return { ok: true, slideCount: app.slides.length, titles: app.slides.map((s) => s.title) };
}

// The Build deck area states which path will run, before the visitor
// presses the button. Pure function of the agent link state, so the unit
// tests can assert every state without a DOM.
export function buildPathText() {
  const engine = agentLink.engine;
  if (!engine) {
    return "The assistant is still connecting. For now, Build deck builds the deck deterministically from the transcript.";
  }
  if (agentLink.modelError) {
    return `The last model call failed (${agentLink.modelError}). Build deck will try the model again, and fall back to the deterministic deck if it fails.`;
  }
  if (!hasRealModel()) {
    return "No AI provider key is set, so Build deck builds the deck deterministically from the transcript. Add a key in AI model settings to have the model rewrite the lecture into slides.";
  }
  if (agentLink.modelVerified) {
    const model = agentLink.verifiedModel ? ` (${agentLink.verifiedModel})` : "";
    return `Model verified${model}. Build deck will ask the model to rewrite the lecture into slides.`;
  }
  return "A real model is configured, so Build deck will ask the model to rewrite the lecture into slides. The key is not verified yet; the first model answer verifies it.";
}

export function updateBuildPathStatus() {
  const node = el("build-path");
  if (!node) return;
  node.textContent = buildPathText();
}

// Shorten a provider error for a status line: one line, at most 240
// characters, so a long provider body does not flood the page.
function modelErrorText(err) {
  const text = String((err && err.message) || err || "unknown error").replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

// Build the deck through the deterministic pipeline and report it. `note`
// is a plain-language prefix shown when the model path was tried first and
// did not produce a rewritten deck: the visitor must never be left thinking
// the model wrote a deterministic deck.
function buildDeterministicDeck(note) {
  const built = buildOutline();
  if (!built.ok) return { ok: false, path: "deterministic", reason: built.reason };
  const rendered = renderSlides();
  if (!rendered.ok) return { ok: false, path: "deterministic", reason: rendered.reason };
  const message = note
    ? `${note} Deck built: ${rendered.slideCount} slides. Check them below, then export.`
    : `Deck built: ${rendered.slideCount} slides. Check them below, then export.`;
  return { ok: true, path: "deterministic", slideCount: rendered.slideCount, message };
}

// Build the deck. With a real provider key configured, the request goes
// through the agent network exactly the way the chat sends it ("Turn this
// lecture into slides"): the producer has structure and slide_designer
// rewrite the lecture through the model, and the deck arrives with
// set_outline. Without a key, or while the assistant is still connecting,
// the deterministic pipeline builds it. If the model call fails, or the
// turn finishes without a rewritten deck, the deterministic deck is shown
// instead, with a plain note saying what happened and why.
export async function buildDeck() {
  if (!app.transcript.trim()) {
    return { ok: false, path: "none", reason: "There is no transcript yet. Paste one, record with the microphone, or load the sample lecture first." };
  }
  if (!hasRealModel()) {
    return buildDeterministicDeck(null);
  }
  // The chat input bar marks an active chat turn; two turns on one engine
  // would share its history, so while the assistant is busy in chat the
  // button builds deterministically and says so.
  if (typeof document !== "undefined") {
    const inputBar = document.querySelector(".ns-inputbar");
    if (inputBar && inputBar.dataset && inputBar.dataset.turnActive === "true") {
      return buildDeterministicDeck("The assistant is busy in chat, so the deterministic deck is shown instead.");
    }
  }
  try {
    await agentLink.engine.runTurn("Turn this lecture into slides.");
  } catch (err) {
    const reason = modelErrorText(err);
    setModelError(reason);
    return buildDeterministicDeck(`The model call failed (${reason}), so the deterministic deck is shown instead.`);
  }
  if (app.outlineSource === "model" && app.slides.length) {
    const rendered = renderSlides();
    if (!rendered.ok) {
      return buildDeterministicDeck("The model wrote an outline, but rendering it failed, so the deterministic deck is shown instead.");
    }
    return { ok: true, path: "model", slideCount: rendered.slideCount, message: `Deck rewritten with the model: ${rendered.slideCount} slides. Check them below, then export.` };
  }
  return buildDeterministicDeck("The model turn finished but did not rewrite the deck, so the deterministic deck is shown instead.");
}

export function verifyDeckAction() {
  if (!app.transcript.trim()) {
    return { ok: false, reason: "There is no transcript to check the slides against." };
  }
  if (!app.slides.length) {
    return { ok: false, reason: "There is no deck yet. Build the deck first." };
  }
  const result = verifyDeck(app.transcript, app.slides);
  return { ok: result.ok, checked: result.checked, failed: result.failed };
}

export async function exportDeck() {
  if (!app.slides.length) {
    return { ok: false, reason: "There is no deck yet. Build the deck first." };
  }
  const fileName = `${slugify(app.title || "deckcast-deck")}.pptx`;
  const PptxGenJSClass = (typeof window !== "undefined" && typeof window.PptxGenJS === "function") ? window.PptxGenJS : null;
  if (!PptxGenJSClass) {
    downloadSlidesJson();
    return { ok: false, reason: "The slide exporter did not load, so the deck was downloaded as slide data (JSON) instead. Reload the page and try again for the .pptx file." };
  }
  const pptx = createPptx(PptxGenJSClass, app.slides, app.title || "DeckCast deck", app.exportTheme);
  await pptx.writeFile({ fileName });
  return { ok: true, fileName, slideCount: app.slides.length, theme: app.exportTheme };
}

function downloadSlidesJson() {
  // No document in Node (unit tests): there is nothing to download from.
  if (typeof document === "undefined" || typeof URL === "undefined") return false;
  const data = JSON.stringify({ title: app.title, slides: app.slides }, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slugify(app.title || "deckcast-deck")}-slides.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

export function clearTranscript() {
  app.transcript = "";
  app.transcriptSource = null;
  app.outline = null;
  app.outlineSource = null;
  app.slides = [];
  app.deckBuilt = false;
  const input = el("transcript-input");
  if (input) input.value = "";
  renderTranscript();
  renderDeck();
  return { ok: true };
}

export async function loadSample() {
  showTranscriptSkeleton();
  const res = await fetch("sample-lecture.txt");
  if (!res.ok) throw new Error("The sample lecture could not be loaded.");
  const text = await res.text();
  const titleInput = el("lecture-title");
  if (titleInput && !titleInput.value.trim()) titleInput.value = "How Photosynthesis Works";
  app.title = titleInput ? titleInput.value.trim() : "How Photosynthesis Works";
  return setTranscript(text, "sample");
}

function renderTranscript() {
  const view = el("transcript-view");
  const words = el("transcript-words");
  if (view) {
    clearNode(view);
    if (app.transcript) {
      view.textContent = app.transcript;
    } else {
      const state = document.createElement("div");
      state.className = "empty-state";
      const heading = document.createElement("h3");
      heading.textContent = "No transcript yet";
      const guidance = document.createElement("p");
      guidance.textContent = "Paste a transcript, record with the microphone, or load the sample lecture to see it here.";
      state.append(heading, guidance);
      view.appendChild(state);
    }
  }
  if (words) words.textContent = app.transcript ? `${countWords(app.transcript)} words` : "";
}

function renderDeck() {
  const container = el("slides-container");
  const count = el("slide-count");
  if (!container) return;
  applyExportTheme();
  clearNode(container);
  if (!app.slides.length) {
    const state = document.createElement("div");
    state.className = "empty-state";
    const heading = document.createElement("h3");
    heading.textContent = "No deck yet";
    const guidance = document.createElement("p");
    guidance.textContent = app.outline
      ? "Outline ready. Press Build deck to render the slides."
      : "Add a transcript, then press Build deck.";
    state.append(heading, guidance);
    container.appendChild(state);
    if (count) count.textContent = "";
    return;
  }
  if (count) count.textContent = `${app.slides.length} slides`;
  app.slides.forEach((slide, i) => {
    const card = document.createElement("article");
    card.className = `slide-card slide-${slide.type}`;
    // Staggered ease-out entrance, one card after another, capped so a long
    // deck does not keep animating. Rebuilding replaces the cards, which
    // interrupts any entrance still running.
    card.style.animationDelay = `${Math.min(i * 40, 320)}ms`;
    const head = document.createElement("div");
    head.className = "slide-head";
    const num = document.createElement("span");
    num.className = "slide-number";
    num.textContent = String(i + 1);
    const title = document.createElement("h3");
    title.textContent = slide.title;
    head.append(num, title);
    card.appendChild(head);
    if (slide.diagram) {
      // Diagram slides render as inline SVG in the chosen export theme, so
      // the preview shows what the .pptx will look like. The SVG string is
      // built from escaped text only, and parsed with DOMParser so no markup
      // from a transcript or a model can become live HTML.
      const parsed = new DOMParser().parseFromString(diagramSvg(slide.diagram, app.exportTheme), "image/svg+xml");
      const svg = parsed.documentElement;
      if (svg && svg.tagName.toLowerCase() === "svg") {
        const wrap = document.createElement("div");
        wrap.className = "diagram-wrap";
        wrap.appendChild(document.importNode(svg, true));
        card.appendChild(wrap);
      }
    }
    if (slide.bullets && slide.bullets.length) {
      const list = document.createElement("ul");
      slide.bullets.forEach((b) => {
        const li = document.createElement("li");
        li.textContent = b.text;
        list.appendChild(li);
      });
      card.appendChild(list);
    }
    if (slide.notes) {
      const notes = document.createElement("p");
      notes.className = "slide-notes";
      notes.textContent = `Notes: ${slide.notes}`;
      card.appendChild(notes);
    }
    container.appendChild(card);
  });
}

// ---- Microphone: live transcription plus an audio recording -----------------
const SpeechRecognition = (typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition)) || null;
let recognition = null;
let mediaRecorder = null;
let mediaStream = null;
let micBuffer = "";
let audioChunks = [];

let micMode = null; // "live" | "whisper" | null

function micLiveSupported() {
  return !!SpeechRecognition && typeof navigator !== "undefined" && !!navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia;
}

function micWhisperSupported() {
  return typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia;
}

async function startMic() {
  if (app.recording) return;
  if (micLiveSupported()) return startMicLive();
  if (micWhisperSupported()) return startMicWhisper();
  setStatus(el("mic-status"), "Recording is not supported in this browser. Paste a transcript instead.", "error");
}

async function startMicLive() {
  micMode = "live";
  if (app.recording) return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus(el("mic-status"), "Microphone access was denied. Allow microphone access, or paste a transcript instead.", "error");
    return;
  }
  micBuffer = "";
  audioChunks = [];
  try {
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) audioChunks.push(e.data); };
    mediaRecorder.start();
  } catch (err) {
    mediaRecorder = null;
  }
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) micBuffer += result[0].transcript + " ";
      else interim += result[0].transcript;
    }
    const live = el("mic-live");
    if (live) live.textContent = (micBuffer + interim).trim() || "Listening...";
  };
  recognition.onerror = (event) => {
    setStatus(el("mic-status"), `Microphone transcription hit a problem (${esc(event.error || "unknown error")}). Your recording so far is kept.`, "error");
  };
  recognition.onend = () => {
    if (app.recording && recognition) {
      try { recognition.start(); } catch (err) { /* browser stopped it; stop flow handles it */ }
    }
  };
  try {
    recognition.start();
  } catch (err) {
    setStatus(el("mic-status"), "The microphone could not start. Try again, or paste a transcript instead.", "error");
    return;
  }
  app.recording = true;
  el("mic-start").disabled = true;
  el("mic-stop").disabled = false;
  const live = el("mic-live");
  if (live) {
    clearNode(live);
    live.append(skeletonLine("85%"), skeletonLine("65%"), skeletonLine("75%"));
  }
  setStatus(el("mic-status"), "Listening. Speak clearly; the transcript appears below as you talk.", "info");
}

// Browsers without live speech recognition (Firefox, Safari) record with
// MediaRecorder and transcribe the recording on this device with Whisper
// when the user stops. Same pipeline as uploaded audio, same privacy: the
// audio never leaves the browser.
async function startMicWhisper() {
  micMode = "whisper";
  if (app.recording) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus(el("mic-status"), "Microphone access was denied. Allow microphone access, or paste a transcript instead.", "error");
    micMode = null;
    return;
  }
  mediaStream = stream;
  micBuffer = "";
  audioChunks = [];
  try {
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) audioChunks.push(e.data); };
    mediaRecorder.start();
  } catch (err) {
    setStatus(el("mic-status"), "The microphone could not start in this browser. Paste a transcript instead.", "error");
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    micMode = null;
    return;
  }
  app.recording = true;
  el("mic-start").disabled = true;
  el("mic-stop").disabled = false;
  const live = el("mic-live");
  if (live) live.textContent = "Recording. Your words will be transcribed on this device after you stop.";
  setStatus(el("mic-status"), "Recording. This browser has no live speech recognition, so Whisper transcribes the recording on this device after you stop. Nothing leaves the browser.", "info");
}

function stopMic() {
  if (!app.recording) return;
  app.recording = false;
  try { if (recognition) recognition.stop(); } catch (err) { /* already stopped */ }
  recognition = null;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.onstop = () => finishRecording();
    try { mediaRecorder.stop(); } catch (err) { finishRecording(); }
  } else {
    finishRecording();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  el("mic-start").disabled = false;
  el("mic-stop").disabled = true;
}

function finishRecording() {
  const mode = micMode;
  micMode = null;
  const text = micBuffer.trim();
  let blob = null;
  if (audioChunks.length) {
    blob = new Blob(audioChunks, { type: mediaRecorder ? mediaRecorder.mimeType || "audio/webm" : "audio/webm" });
    const url = URL.createObjectURL(blob);
    app.audioFile = { name: "microphone-recording.webm", size: blob.size, url, file: blob };
    showAudioFile();
  }
  if (mode === "whisper") {
    finishRecordingWhisper(blob);
    return;
  }
  if (text) {
    setTranscript(text, "mic");
    setStatus(el("mic-status"), `Recording stopped. Transcript saved (${countWords(text)} words).`, "success");
  } else {
    setStatus(el("mic-status"), "Recording stopped, but no speech was recognised. Try again, or paste a transcript instead.", "error");
  }
  const live = el("mic-live");
  if (live) live.textContent = "Your live transcription will appear here while you speak.";
}

async function finishRecordingWhisper(blob) {
  const live = el("mic-live");
  if (!blob) {
    setStatus(el("mic-status"), "Recording stopped, but no audio was captured. Try again, or paste a transcript instead.", "error");
    if (live) live.textContent = "Your transcription will appear here after you stop recording.";
    return;
  }
  if (live) live.textContent = "Transcribing your recording on this device. This takes a moment.";
  setStatus(el("mic-status"), "Recording stopped. Transcribing on this device (this takes a moment)...", "info");
  try {
    const result = await transcribeBlob(blob, {
      onProgress: (p) => setStatus(el("mic-status"), p.message, "info"),
    });
    if (!result.text) {
      setStatus(el("mic-status"), "Transcription finished, but no speech was recognised. Try again, or paste a transcript instead.", "error");
      return;
    }
    setTranscript(result.text, "mic-whisper");
    setStatus(el("mic-status"), `Recording transcribed on this device (${countWords(result.text)} words).`, "success");
  } catch (err) {
    setStatus(el("mic-status"), "Transcription failed on this device. Paste a transcript instead, or try again.", "error");
  }
}

// ---- Audio file upload -------------------------------------------------------
async function handleAudioFile(file) {
  const info = el("audio-info");
  if (!file) return;
  const isAudio = file.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|webm|aac|flac)$/i.test(file.name);
  if (!isAudio) {
    setStatus(info, "That file does not look like audio. Choose an audio file (MP3, WAV, M4A, OGG or WebM).", "error");
    return;
  }
  if (file.size > MAX_AUDIO_MB * 1024 * 1024) {
    setStatus(info, `That file is larger than ${MAX_AUDIO_MB} MB. Choose a shorter recording.`, "error");
    return;
  }
  if (app.audioFile && app.audioFile.url) URL.revokeObjectURL(app.audioFile.url);
  app.audioFile = { name: file.name, size: file.size, url: URL.createObjectURL(file), file };
  showAudioFile();
  await transcribeUploadedAudio();
}

// Transcribe the uploaded file on this device with Whisper. The progress
// bar covers both phases: model files loading (0-50) and transcription
// (50-100). A failed run leaves the file in place for playback and shows
// the retry button; the paste path is always there as a fallback.
async function transcribeUploadedAudio() {
  const info = el("audio-info");
  const progress = el("audio-progress");
  const retry = el("audio-retry");
  const file = app.audioFile && app.audioFile.file;
  if (!file) return;
  if (retry) retry.hidden = true;
  if (progress) { progress.hidden = false; progress.value = 0; }
  // The file name stays visible through the whole run: every status line
  // carries it, so the visitor always knows which file is being transcribed.
  const prefix = `${file.name}: `;
  setStatus(info, `${prefix}Starting transcription on this device...`, "info");
  try {
    const result = await transcribeBlob(file, {
      onProgress: (p) => {
        setStatus(info, `${prefix}${p.message}`, "info");
        if (progress) progress.value = p.phase === "loading-model" ? Math.round(p.percent / 2) : 50 + Math.round(p.percent / 2);
      },
    });
    if (progress) progress.hidden = true;
    if (!result.text) {
      setStatus(info, `${prefix}Transcription finished, but no speech was recognised in this file. Paste a transcript instead.`, "error");
      if (retry) retry.hidden = false;
      return;
    }
    setTranscript(result.text, "upload");
    setStatus(info, `${prefix}Transcribed on this device (${countWords(result.text)} words). The transcript is below; press Build deck.`, "success");
  } catch (err) {
    if (progress) progress.hidden = true;
    setStatus(info, `${prefix}Transcription failed on this device. Paste a transcript instead, or try again.`, "error");
    if (retry) retry.hidden = false;
  }
}

function showAudioFile() {
  const player = el("audio-player");
  const info = el("audio-info");
  if (!app.audioFile) return;
  if (player) {
    player.src = app.audioFile.url;
    player.hidden = false;
  }
  if (info) {
    info.textContent = `${app.audioFile.name} (${Math.round(app.audioFile.size / 1024)} KB)`;
  }
}

// ---- Mobile menu -------------------------------------------------------------
function wireMenu() {
  const button = el("menu-button");
  const nav = el("site-nav");
  if (!button || !nav) return;
  button.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    button.setAttribute("aria-expanded", open ? "true" : "false");
  });
  nav.addEventListener("click", (e) => {
    if (e.target.tagName === "A") {
      nav.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
    }
  });
}

// ---- Wiring ------------------------------------------------------------------
function wire() {
  wireMenu();
  const titleInput = el("lecture-title");
  if (titleInput) {
    titleInput.addEventListener("input", () => { app.title = titleInput.value.trim(); });
  }
  // The export theme picker: the visitor's saved choice is already in
  // app.exportTheme; the picker shows it, and a change re-themes the
  // preview at once.
  const themePicker = el("export-theme");
  if (themePicker) {
    themePicker.value = app.exportTheme;
    themePicker.addEventListener("change", () => setExportTheme(themePicker.value));
  }
  el("use-transcript").addEventListener("click", () => {
    const text = el("transcript-input").value;
    app.title = titleInput ? titleInput.value.trim() : "";
    const result = setTranscript(text, "paste");
    setStatus(
      el("transcript-status"),
      result.ok ? `Transcript saved (${result.words} words). Now press Build deck.` : result.reason,
      result.ok ? "success" : "error"
    );
  });
  el("load-sample").addEventListener("click", async () => {
    try {
      const result = await loadSample();
      setStatus(el("transcript-status"), `Sample lecture loaded (${result.words} words). Now press Build deck.`, "success");
    } catch (err) {
      setStatus(el("transcript-status"), "The sample lecture could not be loaded. Check the connection and try again.", "error");
    }
  });
  el("clear-transcript").addEventListener("click", () => {
    clearTranscript();
    setStatus(el("transcript-status"), "Transcript cleared.", "info");
  });
  el("audio-file").addEventListener("change", (e) => handleAudioFile(e.target.files && e.target.files[0]));
  const audioRetry = el("audio-retry");
  if (audioRetry) audioRetry.addEventListener("click", () => transcribeUploadedAudio());
  el("mic-start").addEventListener("click", startMic);
  el("mic-stop").addEventListener("click", stopMic);
  if (!micLiveSupported() && micWhisperSupported()) {
    setStatus(el("mic-status"), "This browser has no live speech recognition, so your recording is transcribed on this device with Whisper after you stop. It takes a moment, and nothing leaves the browser.", "info");
  } else if (!micLiveSupported()) {
    el("mic-start").disabled = true;
    setStatus(el("mic-status"), "Recording needs a browser with microphone support. Paste a transcript instead.", "info");
  }
  el("clear-view").addEventListener("click", () => {
    clearTranscript();
    setStatus(el("transcript-status"), "Transcript cleared.", "info");
  });
  el("build-deck").addEventListener("click", async () => {
    app.title = titleInput ? titleInput.value.trim() : "";
    const btn = el("build-deck");
    btn.disabled = true;
    setStatus(el("deck-status"), hasRealModel() ? "Asking the model to rewrite the lecture into slides..." : "Building the deck...", "info");
    try {
      const result = await buildDeck();
      setStatus(el("deck-status"), result.ok ? result.message : result.reason, result.ok ? "success" : "error");
    } catch (err) {
      setStatus(el("deck-status"), "Building the deck failed. Try again.", "error");
    } finally {
      btn.disabled = false;
    }
  });
  el("export-deck").addEventListener("click", async () => {
    const btn = el("export-deck");
    btn.disabled = true;
    try {
      const result = await exportDeck();
      setStatus(el("export-status"), result.ok ? `Exported ${result.fileName} (${result.slideCount} slides, ${result.theme} theme).` : result.reason, result.ok ? "success" : "error");
    } catch (err) {
      setStatus(el("export-status"), "Export failed. Try again.", "error");
    } finally {
      btn.disabled = false;
    }
  });
  renderTranscript();
  renderDeck();
  updateBuildPathStatus();
}

// Only wire the page when there is one. In Node (unit tests) the module
// loads for its state functions and skips the DOM wiring.
if (typeof document !== "undefined") wire();
