// whisper.js - on-device transcription of uploaded audio and microphone
// recordings, using Whisper (tiny, quantized) running in the browser via
// transformers.js. The library and the ONNX runtime wasm are vendored under
// vendor/, but the model itself comes from Hugging Face: the 30.7 MB decoder
// is over every GitHub upload limit, so no model file can live in the repo.
// No audio, transcript or key ever leaves the browser. The only request the
// model download makes is a download from huggingface.co (large files are
// served from its CDN): nothing is uploaded, and the transcription itself
// runs on the device.
//
// Loading is lazy: nothing is fetched until the first transcription. The
// model files total about 44 MB, so the first run downloads them from
// Hugging Face (and the browser cache keeps them for the next visit).
// Progress is reported in two phases: per-file model download progress, then
// transcription progress (elapsed time against an estimate measured on a
// real run: about 0.35x real time for whisper-tiny.en in headless Chromium,
// reported conservatively at 0.5x so the estimate rarely overshoots).
//
// The module is safe to import in Node (unit tests): browser-only work
// happens inside functions, and tests can inject a fake transcriber with
// setTranscriberOverride instead of loading the model.

export const WHISPER_MODEL = "Xenova/whisper-tiny.en";
export const WHISPER_SAMPLE_RATE = 16000;
export const WHISPER_CHUNK_SECONDS = 30;
export const WHISPER_STRIDE_SECONDS = 5;

// Conservative real-time factor for the transcription estimate: measured
// 0.34x on a 33.6 s fixture in headless Chromium (11.6 s to transcribe).
export const WHISPER_REALTIME_FACTOR = 0.5;

let pipelinePromise = null;
let transcriberOverride = null;

// Test seam only: replace the whole transcription step with a fake that
// returns { text, durationSeconds, model }. The E2E suite prefers route
// interception of the vendored library instead; this is for Node tests.
export function setTranscriberOverride(fn) {
  transcriberOverride = typeof fn === "function" ? fn : null;
}

export function clearTranscriberOverride() {
  transcriberOverride = null;
}

function baseUrl(relative) {
  // import.meta.url is the URL of this module, so the vendored files resolve
  // relative to the site root wherever the site is hosted.
  if (typeof import.meta !== "undefined" && import.meta.url) {
    return new URL(relative, import.meta.url).href;
  }
  return relative;
}

async function ensurePipeline(onProgress) {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    const { env, pipeline } = await import("./vendor/transformers.min.js");
    // The model comes from the Hugging Face hub (Xenova/whisper-tiny.en):
    // the 30.7 MB decoder cannot be pushed to the repo through any GitHub
    // route, so no model file is vendored. Local models are off, so the
    // library never reads a local model directory. The ONNX runtime wasm
    // stays vendored under vendor/onnx/.
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    env.backends.onnx.wasm.wasmPaths = baseUrl("vendor/onnx/");
    env.backends.onnx.wasm.numThreads = 1;
    return pipeline("automatic-speech-recognition", WHISPER_MODEL, {
      quantized: true,
      progress_callback: (p) => {
        if (!onProgress || !p || p.status !== "progress" || !p.file) return;
        onProgress({
          phase: "loading-model",
          file: p.file,
          loaded: p.loaded || 0,
          total: p.total || 0,
          percent: p.total ? Math.round((100 * (p.loaded || 0)) / p.total) : 0,
          message: `Downloading the transcription model from Hugging Face (${p.file}, ${p.total ? Math.round((100 * (p.loaded || 0)) / p.total) : 0}%)`,
        });
      },
    });
  })();
  return pipelinePromise;
}

// Estimate how long transcribing audio of this length should take, in ms.
// Used only for the progress display; the real run reports its own elapsed time.
export function estimateTranscribeMs(durationSeconds) {
  return Math.max(1000, Math.ceil(durationSeconds * WHISPER_REALTIME_FACTOR * 1000));
}

// Decode any audio the browser can play (MP3, WAV, M4A, OGG, WebM) and
// resample it to 16 kHz mono Float32 samples, the format Whisper expects.
// Returns a Float32Array. Throws a readable error if the file cannot be decoded.
export async function decodeTo16kMono(blob) {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") {
    throw new Error("Audio decoding needs a browser.");
  }
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext();
  let audio;
  try {
    audio = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    try { await ctx.close(); } catch (err) { /* already closed */ }
  }
  if (!audio || !audio.numberOfChannels) {
    throw new Error("That audio file could not be decoded.");
  }
  if (audio.sampleRate === WHISPER_SAMPLE_RATE && audio.numberOfChannels === 1) {
    return audio.getChannelData(0).slice();
  }
  const frames = Math.ceil(audio.duration * WHISPER_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, WHISPER_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = audio;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

// Transcribe an audio Blob end to end. onProgress receives progress events:
// { phase: "loading-model", file, loaded, total, percent, message } while the
// model files load, then { phase: "transcribing", elapsedMs, estimatedMs,
// percent, message } while the model runs. Returns
// { text, durationSeconds, model }. Text is "" when nothing was recognised.
export async function transcribeBlob(blob, { onProgress } = {}) {
  if (transcriberOverride) {
    return transcriberOverride(blob, { onProgress });
  }
  const samples = await decodeTo16kMono(blob);
  const durationSeconds = samples.length / WHISPER_SAMPLE_RATE;
  const pipe = await ensurePipeline(onProgress);
  const estimatedMs = estimateTranscribeMs(durationSeconds);
  const started = Date.now();
  let timer = null;
  const report = () => {
    if (!onProgress) return;
    const elapsedMs = Date.now() - started;
    const percent = Math.min(95, Math.round((100 * elapsedMs) / estimatedMs));
    onProgress({
      phase: "transcribing",
      elapsedMs,
      estimatedMs,
      percent,
      message: `Transcribing (${Math.max(1, Math.round((estimatedMs - elapsedMs) / 1000))} seconds left, estimated)`,
    });
  };
  report();
  if (onProgress) timer = setInterval(report, 250);
  try {
    const out = await pipe(samples, {
      chunk_length_s: WHISPER_CHUNK_SECONDS,
      stride_length_s: WHISPER_STRIDE_SECONDS,
    });
    const text = String((out && out.text) || "").trim();
    return { text, durationSeconds, model: WHISPER_MODEL };
  } finally {
    if (timer) clearInterval(timer);
    if (onProgress) {
      onProgress({
        phase: "transcribing",
        elapsedMs: Date.now() - started,
        estimatedMs,
        percent: 100,
        message: "Transcription done.",
      });
    }
  }
}
