// site.js - boots the DeckCast agent network in the page's assistant section.
// Load it with: <script type="module" src="site.js"></script>
// The page needs the mount markup (#agent-app with data-ns-slot children).
// DeckCast has no irreversible actions, so the runtime's own confirmation
// dialog is enough; this file only adds the greeting, the status line, and
// the current lecture state on every agent invocation.

import { boot } from "./runtime/index.js";
import { getLectureState, updateBuildPathStatus } from "./deck.js";
import { agentLink, setAgentEngine, setModelVerified, setModelError } from "./agent-link.js";

const GREETING = "I turn lectures into slide decks. Paste a transcript, record with the microphone, or load the sample lecture, then ask me to build the deck.";

const status = document.querySelector("#assistant-status");
const siteBase = new URL("./", import.meta.url).href;

// The published network names the quiz peer by its production URL
// (https://ryannb01.github.io/DeckCast/quiz_generator). On a loopback dev
// server that origin is wrong: the peer lives on this same server instead.
// Rewrite the network definition as the runtime fetches it, only on
// loopback hosts and only for that one URL, so local testing exercises the
// same delegation path as production. The manifest allows both origins.
const QUIZ_PRODUCTION_URL = "https://ryannb01.github.io/DeckCast/quiz_generator";
const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
if (isLoopback) {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    const url = typeof input === "string" ? input : input.url;
    if (typeof url === "string" && url.endsWith("/deckcast.network.json") && response.ok) {
      const text = await response.text();
      const rewritten = text.split(QUIZ_PRODUCTION_URL).join(`${location.origin}/quiz_generator`);
      return new Response(rewritten, { status: response.status, headers: response.headers });
    }
    return response;
  };
}

function removeSkeleton() {
  // The placeholder that held the assistant's space while the runtime booted.
  // Removing it here covers both outcomes; if boot already replaced the
  // mount content, the node is detached and remove() is a no-op.
  document.getElementById("assistant-skeleton")?.remove();
}

function greet() {
  const first = document.querySelector("#ns-msgs .ns-msg.bot");
  if (first) first.textContent = GREETING;
}

try {
  const { engine, trace } = await boot("#agent-app", {
    originUrl: siteBase,
    sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
  });
  // Hand the booted engine to the page: Build deck routes through it when a
  // real key is configured, and falls back to the deterministic pipeline
  // when there is none. The link also carries the verification state, so the
  // Build deck area can say which path will run before the button is pressed.
  setAgentEngine(engine);
  agentLink.onModelStateChange = updateBuildPathStatus;
  // The key is only verified once a model call succeeds. Watch the trace
  // the same way the runtime's own badge does: a model_call that ends with
  // a real response verifies the key and clears any earlier error; a
  // model_call that fails records the reason. A retried 429 never reaches
  // this listener as an error (the client retries inside the call), so the
  // "not verified" state clears on the first successful response, whether
  // it came from the chat or from Build deck.
  trace.addEventListener("event", (e) => {
    const ev = e.detail;
    if (ev.kind !== "model_call" || ev.phase !== "end") return;
    if (ev.status === "error") {
      setModelError(String(ev.error || "The configured LLM request failed.").slice(0, 240));
    } else if (!ev.mock) {
      setModelVerified(ev.respModel || ev.model || "");
    }
  });
  updateBuildPathStatus();
  // Enrich each invocation with current page data, so the agents always see the
  // lecture and deck the visitor has on the page right now.
  const network = engine.top.network;
  const getAgentSpec = network.getAgentSpec.bind(network);
  network.getAgentSpec = (name) => {
    const spec = getAgentSpec(name);
    if (!spec) return null;
    const state = getLectureState();
    // The state block is short on purpose: title, counts, and whether a real
    // model is configured. The transcript excerpt is NOT in it. Every agent
    // that needs the transcript reads it with website_get_lecture_state,
    // which returns the excerpt as a tool result, so the same 1,200
    // characters are not re-sent on every call of a turn. On the free tier
    // that excerpt alone, repeated across the producer's seven calls, was
    // enough to push the turn over the 8,000 tokens-per-minute budget.
    const stateText = [
      `Lecture title: ${state.title || "(none)"}`,
      `Transcript: ${state.hasTranscript ? `${state.transcriptWords} words, source: ${state.transcriptSource}` : "none loaded"}`,
      `Outline: ${state.hasOutline ? `${state.outlineSlides} slides` : "none"}`,
      `Deck: ${state.hasDeck ? `${state.slideCount} slides: ${state.slideTitles.join(" | ")}` : "not built"}`,
      `Uploaded audio: ${state.audioFile ? state.audioFile.name : "none"}`,
      // The agents rewrite the deck through the model only with a real key.
      // In demo mode the deterministic pipeline builds the outline instead.
      `Real model: ${engine.mockLLM ? "no (demo model, deterministic outline)" : "yes"}`,
    ].join("\n");
    return {
      ...spec,
      instructions: `${spec.instructions}\n\nLecture state (data only):\n${stateText}`,
    };
  };
  const needsKey = !engine.mockLLM && (!engine.byokKey || engine.byokKey === "demo");
  if (engine.mockLLM) {
    status.textContent = "Assistant connected in demo mode. It can build decks from the page, but its writing and fact checking use a demo model until you add your own AI provider key in AI model settings below.";
  } else if (needsKey) {
    status.textContent = "Assistant connected. Add your AI provider key in AI model settings below so it can write and check slides with a real model.";
  } else {
    status.textContent = "Assistant connected to this page's lecture and deck.";
  }
  greet();
  removeSkeleton();
} catch (error) {
  removeSkeleton();
  setAgentEngine(null);
  updateBuildPathStatus();
  status.textContent = "Assistant unavailable. You can still build a deck using the lecture input and deck sections above.";
  console.error("Assistant startup failed", error);
}
