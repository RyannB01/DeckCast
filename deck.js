// deck.js - DeckCast page logic: lecture input, deck building, rendering, export.
// State lives here. deckcast-actions.js and site.js import from this module.
// Rendering uses textContent only, never innerHTML with user or model text.

import { extractOutline, buildSlides, verifyDeck, createPptx, slugify, countWords, stripTimestamps } from "./deckcast-core.js";

export const MAX_AUDIO_MB = 50;

export const app = {
  title: "",
  transcript: "",
  transcriptSource: null, // "paste" | "mic" | "sample" | null
  audioFile: null, // { name, size, url }
  outline: null,
  slides: [],
  deckBuilt: false,
  recording: false,
};

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
    transcriptExcerpt: app.transcript ? stripTimestamps(app.transcript).slice(0, 2000) : "",
    hasOutline: !!app.outline,
    outlineSlides: app.outline ? app.outline.slides.length : 0,
    hasDeck: app.deckBuilt,
    slideCount: app.slides.length,
    slideTitles: app.slides.map((s) => s.title),
    audioFile: app.audioFile ? { name: app.audioFile.name, size: app.audioFile.size } : null,
  };
}

export function setTranscript(text, source) {
  const clean = String(text || "").trim();
  if (!clean) return { ok: false, reason: "The transcript is empty." };
  app.transcript = clean;
  app.transcriptSource = source || "paste";
  app.outline = null;
  app.slides = [];
  app.deckBuilt = false;
  renderTranscript();
  renderDeck();
  return { ok: true, words: countWords(clean), source: app.transcriptSource };
}

export function buildOutline() {
  if (!app.transcript.trim()) {
    return { ok: false, reason: "There is no transcript yet. Paste one, record with the microphone, or load the sample lecture first." };
  }
  app.outline = extractOutline(app.transcript, app.title || "Untitled lecture");
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
  const pptx = createPptx(PptxGenJSClass, app.slides, app.title || "DeckCast deck");
  await pptx.writeFile({ fileName });
  return { ok: true, fileName, slideCount: app.slides.length };
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

function micSupported() {
  return !!SpeechRecognition && !!navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia;
}

async function startMic() {
  if (!micSupported()) {
    setStatus(el("mic-status"), "Live transcription is not supported in this browser. Use Chrome or Edge, or paste a transcript instead.", "error");
    return;
  }
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
  const text = micBuffer.trim();
  if (audioChunks.length) {
    const blob = new Blob(audioChunks, { type: mediaRecorder ? mediaRecorder.mimeType || "audio/webm" : "audio/webm" });
    const url = URL.createObjectURL(blob);
    app.audioFile = { name: "microphone-recording.webm", size: blob.size, url };
    showAudioFile();
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

// ---- Audio file upload -------------------------------------------------------
function handleAudioFile(file) {
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
  app.audioFile = { name: file.name, size: file.size, url: URL.createObjectURL(file) };
  showAudioFile();
  setStatus(info, `Loaded ${file.name}. Audio files are stored for playback only in this version; they are not transcribed yet. Paste a transcript or use the microphone to build a deck from this lecture.`, "info");
}

function showAudioFile() {
  const player = el("audio-player");
  const info = el("audio-info");
  if (!app.audioFile) return;
  if (player) {
    player.src = app.audioFile.url;
    player.hidden = false;
  }
  if (info && !info.textContent) {
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
  el("mic-start").addEventListener("click", startMic);
  el("mic-stop").addEventListener("click", stopMic);
  if (!micSupported()) {
    el("mic-start").disabled = true;
    setStatus(el("mic-status"), "Live transcription needs a browser with speech recognition, such as Chrome or Edge. Paste a transcript instead.", "info");
  }
  el("clear-view").addEventListener("click", () => {
    clearTranscript();
    setStatus(el("transcript-status"), "Transcript cleared.", "info");
  });
  el("build-deck").addEventListener("click", () => {
    app.title = titleInput ? titleInput.value.trim() : "";
    const built = buildOutline();
    if (!built.ok) {
      setStatus(el("deck-status"), built.reason, "error");
      return;
    }
    const rendered = renderSlides();
    if (rendered.ok) {
      setStatus(el("deck-status"), `Deck built: ${rendered.slideCount} slides. Check them below, then export.`, "success");
    } else {
      setStatus(el("deck-status"), rendered.reason, "error");
    }
  });
  el("export-deck").addEventListener("click", async () => {
    const btn = el("export-deck");
    btn.disabled = true;
    try {
      const result = await exportDeck();
      setStatus(el("export-status"), result.ok ? `Exported ${result.fileName} (${result.slideCount} slides).` : result.reason, result.ok ? "success" : "error");
    } catch (err) {
      setStatus(el("export-status"), "Export failed. Try again.", "error");
    } finally {
      btn.disabled = false;
    }
  });
  renderTranscript();
  renderDeck();
}

// Only wire the page when there is one. In Node (unit tests) the module
// loads for its state functions and skips the DOM wiring.
if (typeof document !== "undefined") wire();
