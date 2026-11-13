// deckcast-actions.js - site actions the agent network can call.
// The manifest (agent-manifest.json) lists this module under actions.module and
// names each action in actions.agentTools. The runtime offers each one to the
// model as a website_<name> tool. Arguments are validated against inputSchema
// before execute runs. Effects: "read" runs at once, "write" runs at once,
// "irreversible" waits for the visitor to confirm. DeckCast has no irreversible
// actions: building, checking and exporting never destroy anything.

import { app, getLectureState, setTranscript, buildOutline, renderSlides, verifyDeckAction, exportDeck } from "./deck.js";

// The generated runtime loads this module via agent-manifest.json.
export function registerActions(actions) {
  actions.register({
    name: "get_lecture_state",
    description: "Read the current lecture on this page: title, whether a transcript is loaded and how many words it has, a short excerpt of the transcript, whether an outline and deck exist, slide titles, and any uploaded audio file.",
    effect: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => getLectureState(),
  });
  actions.register({
    name: "set_transcript",
    description: "Store transcript text the visitor pasted in chat as the lecture transcript on this page. Replaces any transcript already on the page, and clears any outline and deck built from it. Returns the word count.",
    effect: "write",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["transcript"],
      properties: {
        transcript: { type: "string", minLength: 20, maxLength: 200000, description: "The full lecture transcript text." },
      },
    },
    execute: ({ transcript }) => setTranscript(transcript, "paste"),
  });
  actions.register({
    name: "build_outline",
    description: "Build the slide outline from the transcript already on the page: title slide, content slides with one idea each, and a summary slide. Every bullet comes from a transcript sentence, never invented. Returns the outline.",
    effect: "write",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => {
      const result = buildOutline();
      if (!result.ok) return result;
      return { ok: true, title: app.outline.title, slides: app.outline.slides };
    },
  });
  actions.register({
    name: "render_slides",
    description: "Render the current outline as slides in the deck view on the page. Builds the outline first if there is none. Returns the slide count and titles.",
    effect: "write",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => renderSlides(),
  });
  actions.register({
    name: "verify_deck",
    description: "Check every slide bullet against the transcript sentence it came from and report which claims are grounded and which are not. Returns a pass verdict or a list of failed claims with the slide and line for each.",
    effect: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => verifyDeckAction(),
  });
  actions.register({
    name: "export_deck",
    description: "Export the current deck as a .pptx file download. Needs a deck on the page first. Returns the file name and slide count.",
    effect: "write",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => exportDeck(),
  });
}
