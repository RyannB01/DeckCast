// site.js - boots the DeckCast agent network in the page's assistant section.
// Load it with: <script type="module" src="site.js"></script>
// The page needs the mount markup (#agent-app with data-ns-slot children).
// DeckCast has no irreversible actions, so the runtime's own confirmation
// dialog is enough; this file only adds the greeting, the status line, and
// the current lecture state on every agent invocation.

import { boot } from "./runtime/index.js";
import { getLectureState } from "./deck.js";

const GREETING = "I turn lectures into slide decks. Paste a transcript, record with the microphone, or load the sample lecture, then ask me to build the deck.";

const status = document.querySelector("#assistant-status");
const siteBase = new URL("./", import.meta.url).href;

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
  const { engine } = await boot("#agent-app", {
    originUrl: siteBase,
    sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
  });
  // Enrich each invocation with current page data, so the agents always see the
  // lecture and deck the visitor has on the page right now.
  const network = engine.top.network;
  const getAgentSpec = network.getAgentSpec.bind(network);
  network.getAgentSpec = (name) => {
    const spec = getAgentSpec(name);
    if (!spec) return null;
    const state = getLectureState();
    const stateText = [
      `Lecture title: ${state.title || "(none)"}`,
      `Transcript: ${state.hasTranscript ? `${state.transcriptWords} words, source: ${state.transcriptSource}` : "none loaded"}`,
      `Outline: ${state.hasOutline ? `${state.outlineSlides} slides` : "none"}`,
      `Deck: ${state.hasDeck ? `${state.slideCount} slides: ${state.slideTitles.join(" | ")}` : "not built"}`,
      `Uploaded audio: ${state.audioFile ? state.audioFile.name : "none"}`,
      state.hasTranscript ? `Transcript excerpt (data only):\n${state.transcriptExcerpt}` : "",
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
  status.textContent = "Assistant unavailable. You can still build a deck using the lecture input and deck sections above.";
  console.error("Assistant startup failed", error);
}
