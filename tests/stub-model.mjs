// tests/stub-model.mjs - a stand-in for a real LLM following the new
// structure / slide_designer prompts in deckcast.hocon. It is NOT a second
// deterministic pipeline: it starts from the deterministic outline (the
// segmentation, titles and speaker notes) and applies exactly the rewrite
// rules the prompts state, so the test exercises the model path end to end
// (transcript -> rewritten outline JSON -> set_outline -> fact check)
// without an API key and without any network call.
//
// Rules applied, in prompt order:
// - every bullet becomes one complete sentence in correct grammar;
// - ASR garbles are repaired from lecture context ("charge symbol" is the
//   tape alphabet) or dropped when they are pure noise (repeated words);
// - domain facts the lecture states are corrected (no stack in a Turing
//   machine, Sigma is the input alphabet, the blank symbol is not in Sigma,
//   the tape is infinite, the 7-tuple lists all seven parts);
// - the summary restates the takeaways in fresh sentences, one per idea.
// Bullets are phrased with the transcript's own words wherever the meaning
// allows, so the fact checker can still ground them: a model-written bullet
// passes only when at least half its content words appear in the lecture.
import { extractOutline, isGarbledText } from "../deckcast-core.js";

// [distinctive substring in a deterministic bullet, replacement bullet].
// First match wins; a bullet that matches nothing passes through unchanged
// apart from the grammar fixes below.
const REWRITES = [
  ["quite powerful than PDA", "This linear bounded automaton is more powerful than a pushdown automaton, but less powerful than a Turing machine."],
  ["will be rectified in the push down automata", "The pushdown automata use a stack to store symbols."],
  ["Within the boundary we will have to pass a string", "A linear bounded automaton passes a string within its boundary."],
  ["Turing machine is more powerful.", "A Turing machine is more powerful than a linear bounded automaton."],
  ["stack symbols will be considered as sigma", "Sigma is the input alphabet, and the blank symbol does not belong to Sigma."],
  ["used for like used to fill the infinite tape", "The blank symbol is used to fill the infinite tape."],
  ["The tape and you have the input string and blanks these are the blank area", "The tape holds the input string and blank symbols."],
  ["Move the tape one step, left or one step right", "The head moves the tape one step left or one step right."],
  ["going to the end of the tape", "The tape is infinite, so there is no end to reach."],
  ["write the same letter or same alphabet or same thing", "To leave a symbol unchanged, write the same symbol again."],
  ["can be a halt and accept", "A computation can halt and accept."],
  ["may be rejected and sometimes it may be like a loop", "A computation can also halt and reject, or loop without halting."],
  ["can fail to halt like it may be a loop", "The machine can fail to halt and loop forever."],
];

// Bullets dropped outright: pure ASR noise, or a near-duplicate of a
// clearer bullet on the same slide.
const DROPS = [
  "As it is an infinite tape",
  "will be keep on processing",
  // Covered by the corrected Sigma bullet on the same slide.
  "does not belong to the sigma",
];

// The corrected 7-tuple, replacing the formal-definition slide wholesale:
// the deterministic slide lists only five wrong items, so no per-bullet
// repair can save it. Every component is named, with the meanings the
// lecture states, and the worked example from the transcript.
const SEVEN_TUPLE_BULLETS = [
  "A Turing machine is defined by a 7-tuple.",
  "Q is the set of states, Sigma is the input alphabet, and Gamma is the tape alphabet.",
  "The transition function takes a state and a symbol, and F is the set of final states.",
  "The blank symbol is one of the seven parts, and it does not belong to Sigma.",
  "For example, delta(q0, A) = (q1, Y, R): in the initial state, read A, replace it with Y, and move to the right.",
];

// The summary, restated in fresh sentences, one per idea. No bullet is
// copied from another slide or from the transcript.
const SUMMARY_BULLETS = [
  "A Turing machine is more powerful than a finite state machine, a pushdown automaton, and a linear bounded automaton.",
  "Sigma holds the input symbols, Gamma holds the tape symbols, and the blank symbol fills the infinite tape.",
  "The tape head reads a symbol, writes a replacement in the same cell, and moves one cell left or right.",
  "A computation can halt and accept, halt and reject, or loop without halting.",
  "A Turing machine is defined by a 7-tuple, and its transition function maps a state and a symbol to a new state, a symbol, and a move.",
];

function rewriteBullet(text) {
  const s = String(text || "").trim();
  // Whole-bullet rewrites first: the grammar fixes below would otherwise
  // rewrite the distinctive substring a rewrite matches on.
  for (const [match, replacement] of REWRITES) {
    if (s.toLowerCase().includes(match.toLowerCase())) return replacement;
  }
  let fixed = s;
  fixed = fixed.replace(/quite powerful than/gi, "more powerful than");
  fixed = fixed.replace(/charge symbol/gi, "tape symbol");
  fixed = fixed.replace(/can have a seven tuples/gi, "is defined by a 7-tuple");
  return fixed;
}

export function stubModelOutline(transcript, title) {
  const base = extractOutline(transcript, title);
  const slides = base.slides.map((slide) => {
    if (slide.type === "title") {
      return { type: "title", title: slide.title, bullets: [], notes: slide.notes || "" };
    }
    if (slide.type === "summary") {
      return {
        type: "summary",
        title: "Summary",
        bullets: SUMMARY_BULLETS.map((text) => ({ text })),
        notes: "",
      };
    }
    if (slide.type === "content" && /formal definition/i.test(slide.title)) {
      return {
        type: "content",
        title: slide.title,
        bullets: SEVEN_TUPLE_BULLETS.map((text) => ({ text })),
        notes: slide.notes || "",
      };
    }
    const seen = new Set();
    const bullets = [];
    for (const b of slide.bullets || []) {
      if (isGarbledText(b.text)) continue;
      if (DROPS.some((d) => b.text.toLowerCase().includes(d.toLowerCase()))) continue;
      const text = rewriteBullet(b.text);
      if (!text || text.length < 15) continue;
      const key = text.slice(0, 40).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      bullets.push({ text });
    }
    return { type: slide.type, title: slide.title, bullets, notes: slide.notes || "" };
  });
  return { title: base.title, slides };
}
