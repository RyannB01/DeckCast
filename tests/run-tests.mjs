// tests/run-tests.mjs - DeckCast v0.2 checks. Run: node tests/run-tests.mjs
// No files are written. Exit code 0 means every check passed.
import { readFileSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  extractOutline,
  buildSlides,
  verifyDeck,
  createPptx,
  slugify,
  slideTitleFrom,
  countWords,
  contentWords,
  cleanTranscript,
  segmentIdeas,
  compressBullet,
  isFragmentBullet,
  isGarbledText,
  buildSummaryBullets,
  splitSentences,
  stripTimestamps,
  extractDiagrams,
  diagramSvg,
  parseNumberWords,
  numberToWords,
  numberAppearsIn,
  PPTX_THEMES,
  resolveExportTheme,
} from "../deckcast-core.js";
import {
  estimateTranscribeMs,
  WHISPER_MODEL,
  WHISPER_SAMPLE_RATE,
  setTranscriberOverride,
  clearTranscriberOverride,
  transcribeBlob,
} from "../whisper.js";
import { pptxSlideXml } from "./pptx-zip.mjs";
import { stubModelOutline } from "./stub-model.mjs";
import { LlmClient, retryAfterMs, LLM_429_MAX_RETRIES } from "../runtime/llm.js";
import { agentLink, setAgentEngine, setModelVerified, setModelError, resetAgentLink, hasRealModel } from "../agent-link.js";
import { registerActions } from "../deckcast-actions.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

// ---- 1. Pipeline on the sample lecture --------------------------------------
const sample = readFileSync(path.join(ROOT, "sample-lecture.txt"), "utf8");
const sentences = splitSentences(sample);
check("sample lecture splits into sentences", sentences.length >= 15, `got ${sentences.length}`);
check("sample lecture has words", countWords(sample) > 400, `${countWords(sample)} words`);

const outline = extractOutline(sample, "How Photosynthesis Works");
check("outline has a title slide", outline.slides[0].type === "title");
check("outline has content slides", outline.slides.filter((s) => s.type === "content").length >= 3);
check("outline has a summary slide", outline.slides.some((s) => s.type === "summary"));
check("outline slide count in range 5-12", outline.slides.length >= 5 && outline.slides.length <= 12, `got ${outline.slides.length}`);
const bullets = outline.slides.flatMap((s) => s.bullets);
check("outline has bullets", bullets.length >= 9, `got ${bullets.length}`);
check("no bullet longer than 200 chars", bullets.every((b) => b.text.length <= 200));
check("every bullet has a source sentence", bullets.every((b) => Number.isInteger(b.source) && b.source >= 0 && b.source < sentences.length));
check("bullet text appears in its source sentence", bullets.every((b) => {
  // Bullets are compressed clauses, not verbatim chunks: at least half of a
  // bullet's content words must appear in its source sentence.
  const src = sentences[b.source] || "";
  const bulletWords = new Set(contentWords(b.text));
  const sourceWords = new Set(contentWords(src));
  if (bulletWords.size === 0) return true;
  let shared = 0;
  for (const w of bulletWords) if (sourceWords.has(w)) shared += 1;
  return shared / bulletWords.size >= 0.5;
}));

const slides = buildSlides(outline);
check("slides built with unique ids", new Set(slides.map((s) => s.id)).size === slides.length);
check("slide types valid", slides.every((s) => ["title", "content", "diagram", "summary"].includes(s.type)));
check("diagram slides carry their diagram data", slides.filter((s) => s.type === "diagram").every((s) => s.diagram && (s.diagram.kind === "flow" || s.diagram.kind === "bars")));

const verdict = verifyDeck(sample, slides);
check("deterministic fact check passes on own output", verdict.ok, JSON.stringify(verdict.failed.slice(0, 2)));
check("fact check examined bullets", verdict.checked >= 9, `checked ${verdict.checked}`);

// A tampered deck must fail the check.
const tampered = JSON.parse(JSON.stringify(slides));
tampered[1].bullets[0].text = "Photosynthesis was invented in 1999 by a team of robots on Mars.";
const tamperedVerdict = verifyDeck(sample, tampered);
check("fact check catches an invented claim", !tamperedVerdict.ok && tamperedVerdict.failed.length > 0);

// Empty transcript is handled, not crashed.
const empty = extractOutline("", "Empty");
check("empty transcript yields title + summary only", empty.slides.length === 2);

// ---- 1b. Numbers as words ------------------------------------------------------
// Lecturers say numbers out loud, so the diagram data and the fact checker
// both read number words.
check("parseNumberWords reads single words", parseNumberWords("six") === 6 && parseNumberWords("one") === 1);
check("parseNumberWords reads one hundred", parseNumberWords("one hundred") === 100);
check("parseNumberWords reads hyphenated tens", parseNumberWords("twenty-three") === 23);
check("parseNumberWords reads thousands", parseNumberWords("two thousand five hundred") === 2500);
check("parseNumberWords rejects non-numbers", parseNumberWords("carbon dioxide") === null && parseNumberWords("") === null);
check("numberToWords writes single words", numberToWords(6) === "six" && numberToWords(1) === "one");
check("numberToWords writes one hundred", numberToWords(100) === "one hundred");
check("numberToWords writes hyphenated tens", numberToWords(23) === "twenty-three");
check("numberToWords and parseNumberWords round-trip", [0, 3, 19, 40, 99, 101, 1000, 9999].every((n) => parseNumberWords(numberToWords(n)) === n));
check("numberAppearsIn matches digits", numberAppearsIn(6, "six molecules of oxygen and 6 of water") === true);
check("numberAppearsIn matches words", numberAppearsIn(6, "six molecules of carbon dioxide") === true);
check("numberAppearsIn rejects absent values", numberAppearsIn(7, "six molecules of carbon dioxide") === false);

// ---- 1c. Diagram extraction ------------------------------------------------------
const diagrams = extractDiagrams(sample);
check("sample yields a 3-step process flow", diagrams.flow !== null && diagrams.flow.steps.length === 3, JSON.stringify(diagrams.flow));
check("flow steps are the two stages plus G3P", diagrams.flow !== null && diagrams.flow.steps.map((s) => s.label).join(" | ") === "The light-dependent reactions | The Calvin cycle | The cycle produces G3P");
check("flow steps are in transcript order", diagrams.flow !== null && diagrams.flow.steps.every((s, i, arr) => i === 0 || s.source > arr[i - 1].source));
check("flow steps keep source sentences", diagrams.flow !== null && diagrams.flow.steps.every((s) => Number.isInteger(s.source) && s.source >= 0 && s.source < sentences.length));
check("sample yields a bar chart", diagrams.bars !== null && diagrams.bars.unit === "molecules");
check("bar chart has the four equation numbers", diagrams.bars !== null && diagrams.bars.bars.map((b) => `${b.label}:${b.value}`).join(",") === "Carbon dioxide:6,Water:6,Glucose:1,Oxygen:6");
check("no diagram from a thin transcript", extractDiagrams("Hello. This is a short talk.").flow === null && extractDiagrams("Hello. This is a short talk.").bars === null);
const rangeOnly = extractDiagrams("The yield is about three to six percent of the total. Nothing else is numbered.");
check("a range alone yields no bar chart", rangeOnly.bars === null);
const flowSlide = slides.find((s) => s.diagram && s.diagram.kind === "flow");
const barsSlide = slides.find((s) => s.diagram && s.diagram.kind === "bars");
check("outline includes a flow slide", !!flowSlide);
check("outline includes a bars slide", !!barsSlide);
const flowSvg = diagramSvg(flowSlide.diagram);
check("flow SVG names the steps", ["light-dependent", "Calvin cycle", "G3P"].every((t) => flowSvg.includes(t)));
check("flow SVG draws arrows between steps", flowSvg.includes("&#8594;"));
check("flow SVG has no em dash", !flowSvg.includes("\u2014"));
const barsSvg = diagramSvg(barsSlide.diagram);
check("bars SVG names the labels and values", ["Carbon dioxide", "Water", "Glucose", "Oxygen", ">6<", ">1<"].every((t) => barsSvg.includes(t)));
check("bars SVG states the unit", barsSvg.includes("molecules"));
check("bars SVG has no em dash", !barsSvg.includes("\u2014"));
check("diagramSvg escapes markup in labels", diagramSvg({ kind: "flow", steps: [{ label: "A <b> & C", source: 0 }] }).includes("A &lt;b&gt; &amp; C"));
check("diagramSvg returns empty for an unknown kind", diagramSvg({ kind: "pie", bars: [] }) === "");
// The fact checker covers diagram elements too.
const tamperedBar = JSON.parse(JSON.stringify(slides));
tamperedBar.find((s) => s.diagram && s.diagram.kind === "bars").diagram.bars[0].value = 99;
check("fact check catches a wrong bar value", verifyDeck(sample, tamperedBar).ok === false);
const tamperedStep = JSON.parse(JSON.stringify(slides));
tamperedStep.find((s) => s.diagram && s.diagram.kind === "flow").diagram.steps[0].label = "Quantum teleportation chamber";
check("fact check catches an invented flow step", verifyDeck(sample, tamperedStep).ok === false);

// ---- 1d. Turing lecture: the v0.2 acceptance test -----------------------------
// This is the exact transcript Ryann ran through v0.1. v0.1 pasted it onto
// slides verbatim: sentence-fragment titles, timestamps (0:09, 2:23) and
// filler words (uh, okay?) still in the bullets. v0.2 must produce a real
// lecture deck: one slide per idea, a title that names the idea, short
// bullets in the lecturer's meaning but not their verbatim words, and the
// transcript detail in the speaker notes.
const turing = readFileSync(path.join(ROOT, "tests", "turing-lecture.txt"), "utf8");
const turingSegments = segmentIdeas(turing);
check("Turing lecture segments into six ideas", turingSegments.length === 6, turingSegments.map((s) => s.sentences.length).join(","));
const turingOutline = extractOutline(turing, "Turing Machines - Introduction");
const turingSlides = buildSlides(turingOutline);
const turingContent = turingSlides.filter((s) => s.type === "content");
// The gold-standard deck is title + five idea slides + summary. The opening
// segment is a greeting and topic preview, so it becomes the title slide's
// speaker notes, not a content slide.
check("Turing deck has five content slides", turingContent.length === 5, turingContent.map((s) => s.title).join(" | "));
check("Turing deck has seven slides in total", turingSlides.length === 7, turingSlides.map((s) => s.type).join(","));
const turingTitles = turingContent.map((s) => s.title);
check("Turing titles name the ideas", ["The hierarchy: FSM", "The tape and its alphabet", "Tape operations", "Control and halting", "Formal definition"].every((t) => turingTitles.some((title) => title.includes(t))), turingTitles.join(" | "));
const turingText = turingSlides.flatMap((s) => [s.title, ...(s.bullets || []).map((b) => b.text)]).join(" ");
check("Turing slide text has no timestamp pattern", !/\b\d{1,2}:\d{2}\b/.test(turingText));
check("Turing slide text has no filler words", !/\b(uh|um|uhm|hmm|okay\?|you know|like,? you know)\b/i.test(turingText));
check("Turing content bullets are short, not verbatim chunks", turingContent.flatMap((s) => s.bullets || []).every((b) => b.text.length <= 120), `longest: ${Math.max(...turingContent.flatMap((s) => s.bullets || []).map((b) => b.text.length))}`);
check("Turing summary bullets fit the outline limit", turingSlides.find((s) => s.type === "summary").bullets.every((b) => b.text.length <= 200));
check("Turing bullets are not sentence fragments", turingSlides.flatMap((s) => s.bullets || []).every((b) => !isFragmentBullet(b.text)));
check("Turing content slides have 2 to 4 bullets", turingContent.every((s) => s.bullets.length >= 2 && s.bullets.length <= 4), turingContent.map((s) => s.bullets.length).join(","));
const turingFull = turingSlides.flatMap((s) => [s.title, ...(s.bullets || []).map((b) => b.text), s.notes || ""]).join(" ").toLowerCase();
check("Turing deck covers all six ideas", ["hierarchy", "alphabet", "tape operations", "control", "halting", "formal definition"].every((idea) => turingFull.includes(idea)) && (turingFull.includes("7-tuple") || turingFull.includes("seven tuple")));
check("Turing deck mentions the tape operations", ["read", "write", "move"].every((w) => turingFull.includes(w)));
check("Turing deck mentions the halting outcomes", ["accept", "reject", "loop"].every((w) => turingFull.includes(w)));
const turingChecked = verifyDeck(turing, turingSlides);
check("Turing deck passes the fact checker", turingChecked.ok === true, JSON.stringify(turingChecked.failed.slice(0, 2)));
check("Turing slides carry speaker notes", turingContent.every((s) => s.notes && s.notes.length > 50));

// ---- 1e. Deterministic path: readability guard and restated summary --------
// The audit of the exported tm-intro deck found garbled lines the
// deterministic pipeline had copied onto slides. The guard drops them, and
// the summary restates one takeaway per idea instead of repeating the
// lecture's most central sentences verbatim (which copied the worst lines).
check("isGarbledText catches a repeated phrase", isGarbledText("Same symbol Next is rules of two operation two is so this is this is this control is quite equivalent") === true);
check("isGarbledText catches a word repeated with one word between", isGarbledText("Having a blank string special symbol so after your after the input string ends") === true);
check("isGarbledText catches a stuttered verb", isGarbledText("The operations here is read the read or scan the input symbol") === true);
check("isGarbledText leaves clean lines alone", isGarbledText("Move the tape one step, left or one step right") === false && isGarbledText("The blank symbol is used to fill the infinite tape") === false && isGarbledText("Turing machine is more powerful") === false);
const turingAllBullets = turingSlides.flatMap((s) => s.bullets || []);
check("Turing deterministic deck has no garbled bullet", turingAllBullets.every((b) => !isGarbledText(b.text)));
check("Turing deterministic deck dropped the ASR-noise bullet", !turingText.includes("Same symbol Next is rules"));
check("Turing deterministic deck dropped the repeated-after bullet", !turingText.includes("after your after"));
const turingSummary = turingSlides.find((s) => s.type === "summary");
const turingContentTexts = new Set(turingContent.flatMap((s) => s.bullets.map((b) => b.text)));
check("Turing summary has one takeaway per idea slide", turingSummary.bullets.length === turingContent.length, `${turingSummary.bullets.length} summary bullets for ${turingContent.length} content slides`);
check("Turing summary restates instead of copying bullets", turingSummary.bullets.every((b) => !turingContentTexts.has(b.text)));
check("Turing summary is labelled with each slide title", turingContent.every((s) => turingSummary.bullets.some((b) => b.text.startsWith(`${s.title}:`))));
check("Turing summary carries no garbled line", turingSummary.bullets.every((b) => !isGarbledText(b.text)));
check("buildSummaryBullets restates from titles and clean bullets", buildSummaryBullets(turingContent).length === turingContent.length && buildSummaryBullets(turingContent).every((b) => b.text.includes(":")));

// ---- 1f. Model path: stubbed model rewrites the Turing lecture -------------
// No API key exists in this repo and none is used: the stub stands in for a
// real LLM following the new structure / slide_designer prompts, and the
// test runs the real set_outline flow and the real fact checker on its
// output. (The deck.js state functions are imported in section 8 below;
// ES imports hoist, so they are available here.)
const turingModelOutline = stubModelOutline(turing, "Turing Machines - Introduction");
check("stub model outline has seven slides", turingModelOutline.slides.length === 7, turingModelOutline.slides.map((s) => s.title).join(" | "));
const turingModelLoaded = setTranscript(turing, "paste");
check("mock-model test loads the Turing transcript", turingModelLoaded.ok === true);
const turingModelSet = setOutline(turingModelOutline);
check("set_outline stores the model-written Turing deck", turingModelSet.ok === true && turingModelSet.slides === 7);
const modelSlides = deckApp.slides;
const modelText = modelSlides.flatMap((s) => [s.title, ...(s.bullets || []).map((b) => b.text)]).join(" ");
check("model deck has no Charge symbol", !/charge symbol/i.test(modelText));
check("model deck has no ASR-noise bullet", !modelText.includes("Same symbol Next is rules") && !/this is this is/i.test(modelText));
check("model deck fixes the comparative", modelText.includes("more powerful than") && !modelText.includes("quite powerful than"));
check("model deck defines the 7-tuple correctly", modelText.includes("is defined by a 7-tuple") && !/seven tuples/i.test(modelText));
check("model deck names all seven tuple parts", ["Q is the set of states", "Sigma is the input alphabet", "Gamma is the tape alphabet", "transition function", "final states", "blank symbol"].every((t) => modelText.includes(t)) && modelText.includes("delta(q0, A) = (q1, Y, R)"));
check("model deck has no stack in Sigma", !modelText.includes("stack symbols will be considered as sigma") && modelText.includes("does not belong to Sigma"));
check("model deck has no end of the tape", !modelText.includes("end of the tape") && modelText.includes("no end to reach"));
const modelContent = modelSlides.filter((s) => s.type === "content");
const modelSummary = modelSlides.find((s) => s.type === "summary");
const modelContentTexts = new Set(modelContent.flatMap((s) => s.bullets.map((b) => b.text)));
check("model summary has one restated takeaway per idea", modelSummary.bullets.length === modelContent.length, `${modelSummary.bullets.length} summary bullets for ${modelContent.length} content slides`);
check("model summary copies no bullet", modelSummary.bullets.every((b) => !modelContentTexts.has(b.text)));
const MODEL_VERB = /\b(is|are|can|has|have|read|reads|write|writes|move|moves|define|defined|map|maps|hold|holds|fill|fills|halt|accept|reject|loop|replace|replaces|store|stores|takes|use|uses|passes)\b/i;
const modelBullets = modelSlides.flatMap((s) => s.bullets || []);
check("model bullets are complete sentences", modelBullets.every((b) => /^[A-Z]/.test(b.text) && /[.!?]$/.test(b.text) && MODEL_VERB.test(b.text) && !isFragmentBullet(b.text) && !isGarbledText(b.text)), modelBullets.filter((b) => !(/^[A-Z]/.test(b.text) && /[.!?]$/.test(b.text) && MODEL_VERB.test(b.text))).map((b) => b.text).join(" | "));
const modelVerdict = verifyDeckAction();
check("model deck passes the fact checker", modelVerdict.ok === true, JSON.stringify(modelVerdict.failed.slice(0, 2)));
check("model deck fact check examined its bullets", modelVerdict.checked >= 20, `checked ${modelVerdict.checked}`);
clearTranscript();

// ---- 1g. Build deck routing: model path, deterministic fallback, loud failure ----
// The Build deck button used to call the deterministic pipeline directly, so
// a configured key did nothing and a failed model call was invisible: the
// page showed the deterministic deck with nothing saying the model failed.
// buildDeck() routes through the agent network when a real key is configured,
// and falls back to the deterministic deck with a plain note when the model
// call fails or writes nothing. The link is stubbed here: no API key, no
// network, no browser. (deck.js state functions are imported in section 8;
// ES imports hoist, so they are available here.)
check("hasRealModel is false with no engine", resetAgentLink() === undefined && hasRealModel() === false);
setAgentEngine({ mockLLM: true, byokKey: "gsk_stub_key" });
check("hasRealModel is false for the demo model", hasRealModel() === false);
setAgentEngine({ mockLLM: false, byokKey: "" });
check("hasRealModel is false with no key", hasRealModel() === false);
setAgentEngine({ mockLLM: false, byokKey: "demo" });
check("hasRealModel is false for the demo placeholder key", hasRealModel() === false);
setAgentEngine({ mockLLM: false, byokKey: "gsk_stub_key" });
check("hasRealModel is true for a real key on a real router", hasRealModel() === true);
resetAgentLink();
check("build path says the assistant is still connecting with no engine", buildPathText().includes("still connecting"));
setAgentEngine({ mockLLM: true, byokKey: "demo" });
check("build path says deterministic with no key", buildPathText().includes("No AI provider key is set") && buildPathText().includes("deterministically"));
setAgentEngine({ mockLLM: false, byokKey: "gsk_stub_key" });
check("build path says the key is not verified yet", buildPathText().includes("not verified yet"));
setModelVerified("openai/gpt-oss-120b");
check("build path says the model is verified after a success", buildPathText().includes("Model verified (openai/gpt-oss-120b)"));
setModelError("LLM HTTP 429: Rate limit reached");
check("build path reports the last model failure", buildPathText().includes("last model call failed") && buildPathText().includes("429"));
resetAgentLink();
// The outline records which path wrote it, so the button can tell a model
// deck from a deterministic one instead of guessing.
setTranscript(turing, "paste");
check("a new transcript has no outline source yet", deckApp.outlineSource === null);
pageBuildOutline();
check("the deterministic pipeline marks its outline", deckApp.outlineSource === "deterministic");
setOutline(stubModelOutline(turing, "Turing Machines - Introduction"));
check("set_outline marks the outline as model-written", deckApp.outlineSource === "model");
setTranscript(turing, "paste");
check("a new transcript clears the outline source", deckApp.outlineSource === null);
clearTranscript();
check("clearing the transcript clears the outline source", deckApp.outlineSource === null);
// With no engine, Build deck builds deterministically and says so.
setTranscript(turing, "paste");
resetAgentLink();
const noEngineDeck = await buildDeck();
check("buildDeck with no engine builds the deterministic deck", noEngineDeck.ok === true && noEngineDeck.path === "deterministic" && noEngineDeck.slideCount === 7, JSON.stringify(noEngineDeck));
const noEngineText = deckApp.slides.flatMap((s) => [s.title, ...(s.bullets || []).map((b) => b.text)]).join(" ");
check("the no-engine deck is the deterministic one", noEngineText.includes("quite powerful than"));
// With a stubbed real model, the button produces the model-rewritten deck
// through set_outline.
setAgentEngine({ mockLLM: false, byokKey: "gsk_stub_key", runTurn: async () => { setOutline(stubModelOutline(turing, "Turing Machines - Introduction")); } });
const modelDeck = await buildDeck();
check("buildDeck with a real model rewrites through the model", modelDeck.ok === true && modelDeck.path === "model" && modelDeck.message.includes("rewritten with the model"), JSON.stringify(modelDeck));
check("the model deck is marked model-written", deckApp.outlineSource === "model");
const modelDeckText = deckApp.slides.flatMap((s) => [s.title, ...(s.bullets || []).map((b) => b.text)]).join(" ");
check("the button model deck has the rewritten bullets", modelDeckText.includes("is defined by a 7-tuple") && !/charge symbol/i.test(modelDeckText));
// With a failing stubbed model, the button falls back loudly: the failure
// and the reason are on the page, and the deterministic deck is never
// presented as the model's work.
setAgentEngine({ mockLLM: false, byokKey: "gsk_stub_key", runTurn: async () => { throw new Error("LLM HTTP 429: Rate limit reached for model openai/gpt-oss-120b. Please try again in 30.105s."); } });
const failedDeck = await buildDeck();
check("buildDeck with a failing model falls back to the deterministic deck", failedDeck.ok === true && failedDeck.path === "deterministic", JSON.stringify(failedDeck));
check("the fallback names the failure and the reason", failedDeck.message.includes("The model call failed") && failedDeck.message.includes("429") && failedDeck.message.includes("deterministic deck is shown instead"), failedDeck.message);
check("the failure is recorded on the link", agentLink.modelError.includes("429"));
check("the build path reports the failure afterwards", buildPathText().includes("last model call failed"));
const failedDeckText = deckApp.slides.flatMap((s) => [s.title, ...(s.bullets || []).map((b) => b.text)]).join(" ");
check("the fallback deck is the deterministic one", failedDeckText.includes("quite powerful than"));
// A model turn that finishes without writing an outline also falls back
// with a plain note, instead of silently serving the deterministic deck.
setAgentEngine({ mockLLM: false, byokKey: "gsk_stub_key", runTurn: async () => {} });
const emptyDeck = await buildDeck();
check("buildDeck with an empty model turn falls back with a note", emptyDeck.ok === true && emptyDeck.path === "deterministic" && emptyDeck.message.includes("did not rewrite"), emptyDeck.message);
// No transcript, no deck, whichever path would run.
clearTranscript();
resetAgentLink();
const noTranscriptDeck = await buildDeck();
check("buildDeck with no transcript refuses", noTranscriptDeck.ok === false && noTranscriptDeck.reason.includes("no transcript"), JSON.stringify(noTranscriptDeck));
// The status-line updater is a no-op without a DOM (Node has none).
updateBuildPathStatus();
check("updateBuildPathStatus does not throw without a DOM", true);
resetAgentLink();
clearTranscript();

// ---- 2. .pptx export ---------------------------------------------------------
// The vendored bundle is a browser classic script: it declares a top-level
// `var PptxGenJS`, so require() does not expose the class. Load it in a vm
// context with browser-like globals, the way a <script> tag sees it.
import vm from "node:vm";
const pptxCode = readFileSync(path.join(ROOT, "vendor/pptxgen.bundle.js"), "utf8");
const pptxSandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  Blob, URL,
};
pptxSandbox.window = pptxSandbox;
pptxSandbox.self = pptxSandbox;
pptxSandbox.global = pptxSandbox;
vm.createContext(pptxSandbox);
vm.runInContext(pptxCode, pptxSandbox, { filename: "pptxgen.bundle.js" });
check("PptxGenJS class loads from the vendored bundle", typeof pptxSandbox.PptxGenJS === "function");
const pptx = createPptx(pptxSandbox.PptxGenJS, slides, "How Photosynthesis Works");
const base64 = await pptx.write({ outputType: "base64" });
check("pptx export produces base64", typeof base64 === "string" && base64.length > 10000, `${base64.length} chars`);
const head = Buffer.from(base64.slice(0, 8), "base64").toString("latin1");
check("pptx bytes start with ZIP magic (PK)", head.startsWith("PK"));
check("slugify works", slugify("How Photosynthesis Works!") === "how-photosynthesis-works");

// ---- 3. Network and manifest -------------------------------------------------
const network = JSON.parse(readFileSync(path.join(ROOT, "deckcast.network.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(ROOT, "agent-manifest.json"), "utf8"));
const agentNames = network.tools.map((t) => t.name);
check("network has 5 agents", agentNames.length === 5, agentNames.join(", "));
check("agent names unique", new Set(agentNames).size === agentNames.length);
check("front agent is deckcast_producer", agentNames[0] === "deckcast_producer");
check("front agent delegates to all four specialists", ["transcriber", "structure", "slide_designer", "fact_checker"].every((n) => network.tools[0].tools.includes(n)));
const dangling = [];
// A tools entry that is an http(s) URL is a peer network, not a local agent:
// the producer delegates to the quiz generator by its public URL.
for (const t of network.tools) for (const d of t.tools || []) if (!agentNames.includes(d) && !/^https?:\/\//.test(d)) dangling.push(`${t.name} -> ${d}`);
check("no dangling agent references", dangling.length === 0, dangling.join("; "));
check("producer delegates to the quiz peer by URL", network.tools[0].tools.includes("https://ryannb01.github.io/DeckCast/quiz_generator"));
check("every agent has instructions", network.tools.every((t) => t.instructions && t.instructions.length > 100));
check("every agent has an invocation schema", network.tools.every((t) => t.function && t.function.parameters && t.function.parameters.properties.request));
check("fact checker forbids invented content", network.tools.find((t) => t.name === "fact_checker").instructions.includes("No invented content, ever."));
check("manifest names the network", manifest.networks[0].name === "deckcast");
check("manifest front agent matches network", manifest.networks[0].front_man === "deckcast_producer");
check("manifest hocon points at the network file", manifest.networks[0].hocon === "./deckcast.network.json" && existsSync(path.join(ROOT, "deckcast.network.json")));
check("manifest router is mock by default", manifest.llm_router.mock === true && manifest.llm_router.base_url === "browser://mock");
check("manifest byok router is OpenAI-compatible", manifest.llm_router.byok_router === "https://api.openai.com/v1");
const actionNames = ["get_lecture_state", "set_transcript", "build_outline", "set_outline", "render_slides", "verify_deck", "export_deck"];
check("manifest lists all seven site actions", actionNames.every((a) => manifest.actions.agentTools.includes(a)));
const actionsSrc = readFileSync(path.join(ROOT, "deckcast-actions.js"), "utf8");
check("actions module registers all seven actions", actionNames.every((a) => actionsSrc.includes(`name: "${a}"`)));
check("links.json names the network", JSON.parse(readFileSync(path.join(ROOT, "links.json"), "utf8")).networks.deckcast !== undefined);
check("agent-mcp.json names the network", JSON.parse(readFileSync(path.join(ROOT, "agent-mcp.json"), "utf8")).network === "deckcast");

// ---- 4. No em dashes in user-visible copy ------------------------------------
// The README's "Bring your own key" section is preserved verbatim from the
// version Ryann's parent agent pushed (commit 7575fc06): it contains two em
// dashes (Groq line, "How to tell it worked" line) that stay as written.
const EM_DASH = "\u2014";
const BYOK_MARKERS = [
  "## Bring your own key",
  "**Google AI Studio (free tier).**",
  "**Groq (free tier).**",
  "**OpenAI (billing may be required).**",
  "**Anthropic (billing may be required).**",
  "How to tell it worked:",
  "Model used: `gemini-3.8-flash`",
  "Model used: `openai/gpt-oss-120b`",
  "Model used: `gpt-5.5`",
  "Model used: `claude-sonnet-4-6`",
];
const readmeText = readFileSync(path.join(ROOT, "README.md"), "utf8");
check("README keeps the BYOK section verbatim", BYOK_MARKERS.every((m) => readmeText.includes(m)));
check("README has exactly two em dashes, both in the BYOK section", (readmeText.match(/\u2014/g) || []).length === 2);
const readmeWithoutByok = readmeText.replace(/## Bring your own key[\s\S]*?(?=\n## Privacy)/, "");
const visibleFiles = ["index.html", "deck.js", "site.js", "deckcast-actions.js", "agent-link.js", "404.html", "README.md"];
for (const f of visibleFiles) {
  if (!existsSync(path.join(ROOT, f))) { check(`${f} exists`, false); continue; }
  const text = f === "README.md" ? readmeWithoutByok : readFileSync(path.join(ROOT, f), "utf8");
  check(`no em dash in ${f}`, !text.includes(EM_DASH));
}

// ---- 5. No secrets ------------------------------------------------------------
const secretPatterns = [/sk-[A-Za-z0-9]{10,}/, /api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
const codeFiles = ["index.html", "deck.js", "deckcast-core.js", "deckcast-actions.js", "agent-link.js", "site.js", "deckcast.network.json", "deckcast.hocon", "quiz_generator.network.json", "quiz_generator.hocon", "whisper.js", "agent-manifest.json", "styles.css", "sample-lecture.txt"];
for (const f of codeFiles) {
  const text = readFileSync(path.join(ROOT, f), "utf8");
  check(`no secret material in ${f}`, !secretPatterns.some((re) => re.test(text)));
}

// ---- 6. Self-hosted fonts, no third-party loads -------------------------------
// No visitor data may go to a third party: no Google Fonts, no font CDN, no
// external scripts or styles. The one font is a woff2 file served from /fonts/.
const fontPath = path.join(ROOT, "fonts/ibm-plex-sans-latin-wght-normal.woff2");
check("self-hosted font file exists", existsSync(fontPath));
if (existsSync(fontPath)) {
  const head = readFileSync(fontPath).subarray(0, 4).toString("latin1");
  check("font file is a real woff2 (wOF2 magic)", head === "wOF2");
  check("font file is small (under 100 KB)", statSync(fontPath).size < 100 * 1024, `${statSync(fontPath).size} bytes`);
}
const css = readFileSync(path.join(ROOT, "styles.css"), "utf8");
check("styles.css declares the self-hosted @font-face", css.includes('@font-face') && css.includes('fonts/ibm-plex-sans-latin-wght-normal.woff2'));
check("styles.css uses the self-hosted face first", css.includes('"IBM Plex Sans", system-ui'));
const thirdPartyHosts = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "fonts.bunny.net"];
const ownHtmlCss = readFileSync(path.join(ROOT, "index.html"), "utf8") + css + readFileSync(path.join(ROOT, "404.html"), "utf8");
check("no third-party font or CDN host in own pages", !thirdPartyHosts.some((h) => ownHtmlCss.includes(h)));
check("no @import of a remote stylesheet", !/@import\s+url\(['"]?https?:/i.test(css));
const indexHtml = readFileSync(path.join(ROOT, "index.html"), "utf8");
check("CSP restricts fonts to same origin", indexHtml.includes("font-src 'self'"));
check("no external script in index.html", !/<script[^>]+src="https?:/i.test(indexHtml));
check("no external stylesheet in index.html", !/<link[^>]+href="https?:[^>]+stylesheet/i.test(indexHtml));

// ---- 7. Unit tests: one small piece at a time --------------------------------
// (a) stripTimestamps
check("stripTimestamps removes [MM:SS] markers", !stripTimestamps("[00:12] Hello").includes("[00:12]") && stripTimestamps("[00:12] Hello").includes("Hello"));
check("stripTimestamps leaves plain text alone", stripTimestamps("No markers here.") === "No markers here.");
check("stripTimestamps handles several markers", stripTimestamps("[00:01] a [00:02] b [00:03] c").split(/\s+/).filter(Boolean).join(" ") === "a b c");
// (b) splitSentences
check("splitSentences splits three sentences", splitSentences("One. Two. Three.").length === 3);
check("splitSentences returns [] for empty text", splitSentences("").length === 0);
check("splitSentences keeps questions and exclamations", splitSentences("Really? Yes! Done.").length === 3);
// (c) countWords
check("countWords is 0 for empty text", countWords("") === 0);
check("countWords ignores extra whitespace", countWords("  one   two\tthree\n") === 3);
check("countWords counts a normal sentence", countWords("The quick brown fox.") === 4);
// (d) slugify
check("slugify lowercases and hyphenates", slugify("Hello, World!") === "hello-world");
check("slugify trims edge hyphens", slugify("  Spaces  ") === "spaces");
check("slugify falls back for empty input", slugify("") === "deckcast-deck");
check("slugify drops punctuation", slugify("A & B: the sequel") === "a-b-the-sequel");

// (e) slide titles prefer a complete clause
check("slide title stops at a comma clause", slideTitleFrom("The energy splits water molecules, releasing oxygen as a byproduct.") === "The energy splits water molecules");
check("slide title stops at a colon", slideTitleFrom("The overall equation is simple to write: six molecules of carbon dioxide.") === "The overall equation is simple to write");
check("slide title stops before a which clause", slideTitleFrom("Photosynthesis takes place in the chloroplast, which is an organelle found in plant cells.") === "Photosynthesis takes place in the chloroplast");
check("slide title falls back to six words without a clause", slideTitleFrom("That is also why grow lights for indoor plants are often tuned toward blue.") === "That is also why grow lights");
check("slide title skips filler starts", slideTitleFrom("So, the Calvin cycle uses the ATP and NADPH from the first stage.") === "The Calvin cycle uses the ATP");
// (e) extractOutline edges
const oneSentence = extractOutline("Photosynthesis makes food from light.", "Short");
check("one-sentence transcript yields title, one content slide, summary", oneSentence.slides.length === 3 && oneSentence.slides[1].type === "content");
check("outline title comes from the given title", oneSentence.slides[0].title === "Short");
const stamped = extractOutline("[00:01] Plants use light. [00:05] They make sugar.", "Stamped");
check("outline bullets carry no timestamp markers", stamped.slides.flatMap((s) => s.bullets).every((b) => !b.text.includes("[00:")));
// (f) buildSlides
check("built slides carry speaker notes", slides.some((s) => s.notes && s.notes.length > 0));
check("built slide count matches the outline", slides.length === outline.slides.length);
// (g) verifyDeck edges
check("verifyDeck passes an empty deck (nothing to check)", verifyDeck(sample, []).ok === true && verifyDeck(sample, []).checked === 0);
// A source-less bullet is checked against the whole transcript. A grounded
// one passes; an invented one (the Mars-1999 grounding trap) must fail.
const noSourceGrounded = JSON.parse(JSON.stringify(slides));
noSourceGrounded[1].bullets[0].source = null;
check("verifyDeck passes a grounded bullet with no source sentence", verifyDeck(sample, noSourceGrounded).ok === true);
const noSourceInvented = JSON.parse(JSON.stringify(slides));
noSourceInvented[1].bullets[0] = { text: "The first Mars colony opened in 1999", source: null };
check("verifyDeck fails an invented bullet with no source sentence", verifyDeck(sample, noSourceInvented).ok === false);
const withSourceInvented = JSON.parse(JSON.stringify(slides));
withSourceInvented[1].bullets[0] = { text: "The first Mars colony opened in 1999", source: 0 };
check("verifyDeck fails an invented bullet even with a source sentence", verifyDeck(sample, withSourceInvented).ok === false);
// (h) createPptx with no slides
const emptyPptx = createPptx(pptxSandbox.PptxGenJS, [], "Empty deck");
const emptyB64 = await emptyPptx.write({ outputType: "base64" });
check("pptx export handles an empty deck", typeof emptyB64 === "string" && Buffer.from(emptyB64.slice(0, 8), "base64").toString("latin1").startsWith("PK"));
// (i) each agent's invocation schema: one required string, the request
for (const t of network.tools) {
  const params = t.function.parameters;
  check(`agent ${t.name} requires a string request`, params.required?.includes("request") && params.properties.request.type === "string");
  check(`agent ${t.name} describes its job`, typeof t.function.description === "string" && t.function.description.length > 20);
}

// ---- 8. Unit tests: the page state functions (Node-safe) ----------------------
import {
  app as deckApp,
  setTranscript,
  setOutline,
  setExportTheme,
  getExportTheme,
  buildOutline as pageBuildOutline,
  renderSlides as pageRenderSlides,
  verifyDeckAction,
  clearTranscript,
  exportDeck,
  getLectureState,
  buildDeck,
  buildPathText,
  updateBuildPathStatus,
} from "../deck.js";
check("setTranscript rejects empty text", setTranscript("   ", "paste").ok === false);
const set = setTranscript(sample, "paste");
check("setTranscript accepts the sample lecture", set.ok === true && set.words > 400);
check("lecture state reports the transcript", getLectureState().hasTranscript === true && getLectureState().transcriptWords > 400);
const built = pageBuildOutline();
check("page buildOutline builds from the transcript", built.ok === true && built.slides >= 5);
const rendered = pageRenderSlides();
check("page renderSlides reports the deck", rendered.ok === true && rendered.slideCount >= 5 && deckApp.deckBuilt === true);
const checked = verifyDeckAction();
check("page verifyDeckAction passes its own deck", checked.ok === true && checked.checked >= 9);
const noPptx = await exportDeck();
check("page exportDeck falls back without a browser exporter", noPptx.ok === false && noPptx.reason.includes("JSON"));
// setTranscript stores the cleaned transcript, never the raw paste.
const stampedSet = setTranscript("[00:01] Uh, plants use light. So, they make sugar.", "paste");
check("setTranscript cleans timestamps and fillers", stampedSet.ok === true && !deckApp.transcript.includes("[00:01]") && !/\buh\b/i.test(deckApp.transcript) && deckApp.transcript.includes("Plants use light"), deckApp.transcript);
check("setTranscript rejects a transcript that cleans to nothing", setTranscript("[00:01] Uh, um.", "paste").ok === false);
// setOutline stores a model-written outline, cleaned defensively.
const modelOutline = {
  title: "Photosynthesis",
  slides: [
    { type: "title", title: "Photosynthesis", bullets: [], notes: "Intro." },
    { type: "content", title: "The light reactions", bullets: [{ text: "Light splits water and releases oxygen" }, { text: "Energy is stored as ATP and NADPH" }], notes: "Detail from the lecture." },
    { type: "summary", title: "Summary", bullets: [{ text: "Plants turn light into chemical energy" }], notes: "" },
  ],
};
const setOut = setOutline(modelOutline);
check("setOutline stores a model-written outline", setOut.ok === true && setOut.slides === 3 && deckApp.slides.length === 3);
check("setOutline gives model bullets no source sentence", deckApp.slides[1].bullets.every((b) => b.source === null));
const stampedBullet = JSON.parse(JSON.stringify(modelOutline));
stampedBullet.slides[1].bullets[0] = { text: "Uh, light splits water 0:09" };
check("setOutline cleans timestamps and fillers from model bullets", setOutline(stampedBullet).ok === true && !deckApp.slides[1].bullets[0].text.includes("0:09") && deckApp.slides[1].bullets[0].text.toLowerCase().includes("light splits water"), deckApp.slides[1].bullets[0].text);
check("setOutline rejects a one-slide outline", setOutline({ title: "X", slides: [{ type: "title", title: "X", bullets: [], notes: "" }] }).ok === false);
check("setOutline rejects a title over 80 characters", setOutline({ title: "X".repeat(81), slides: modelOutline.slides }).ok === false);
check("setOutline rejects a slide with more than 5 bullets", setOutline({ title: "X", slides: [{ type: "title", title: "X", bullets: [], notes: "" }, { type: "content", title: "Y", bullets: [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }, { text: "e" }, { text: "f" }], notes: "" }] }).ok === false);
clearTranscript();
check("clearTranscript resets the state", getLectureState().hasTranscript === false && getLectureState().hasDeck === false);
check("page buildOutline fails with no transcript", pageBuildOutline().ok === false);
check("page renderSlides fails with no transcript", pageRenderSlides().ok === false);
check("page verifyDeckAction fails with no transcript", verifyDeckAction().ok === false);

// ---- 9. Integration: transcript -> outline -> slides -> export, second topic ----
const waterCycle = "The water cycle moves water between the earth and the sky. [00:05] Heat from the sun evaporates water from oceans, lakes, and soil. The vapour rises and cools, and then it condenses into tiny droplets that form clouds. When the droplets grow heavy, they fall back as rain or snow, which we call precipitation. Some rain soaks into the ground and becomes groundwater, while the rest runs off into rivers and back to the sea. Plants also release water vapour from their leaves, a step called transpiration. Together, evaporation, condensation, precipitation, and collection keep water moving in a loop.";
const wSet = setTranscript(waterCycle, "paste");
check("integration: second lecture accepted", wSet.ok === true);
check("integration: new transcript clears the old deck", deckApp.deckBuilt === false && deckApp.slides.length === 0);
const wBuilt = pageBuildOutline();
check("integration: outline built from the second lecture", wBuilt.ok === true && wBuilt.slides >= 3);
const wRendered = pageRenderSlides();
check("integration: slides rendered from the second lecture", wRendered.ok === true && wRendered.slideCount === wBuilt.slides);
const wChecked = verifyDeckAction();
check("integration: fact check passes on the second lecture", wChecked.ok === true, JSON.stringify(wChecked.failed.slice(0, 2)));
const wPptx = createPptx(pptxSandbox.PptxGenJS, deckApp.slides, "The Water Cycle");
const wB64 = await wPptx.write({ outputType: "base64" });
check("integration: second lecture exports to a real .pptx", typeof wB64 === "string" && wB64.length > 10000 && Buffer.from(wB64.slice(0, 8), "base64").toString("latin1").startsWith("PK"));
clearTranscript();

// ---- 10. Palette and contrast ---------------------------------------------------
function luminance(hex) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}
const PALETTE = { paper: "#F3E9D7", card: "#FAF6EF", ink: "#2B1D12", muted: "#6B5847", blue: "#8EC8EE", tint: "#E8F1F8", borderStrong: "#8A7B68", blueDark: "#4A7BA6" };
for (const [name, fg, bg, need] of [
  ["ink on paper", PALETTE.ink, PALETTE.paper, 4.5],
  ["muted on paper", PALETTE.muted, PALETTE.paper, 4.5],
  ["ink on card", PALETTE.ink, PALETTE.card, 4.5],
  ["muted on card", PALETTE.muted, PALETTE.card, 4.5],
  ["ink on baby blue", PALETTE.ink, PALETTE.blue, 4.5],
  ["ink on soft tint", PALETTE.ink, PALETTE.tint, 4.5],
  ["muted on soft tint", PALETTE.muted, PALETTE.tint, 4.5],
  ["strong border on card", PALETTE.borderStrong, PALETTE.card, 3],
  ["dark blue border on paper", PALETTE.blueDark, PALETTE.paper, 3],
]) {
  const r = contrastRatio(fg, bg);
  check(`contrast: ${name} (${r.toFixed(2)}:1, needs ${need}:1)`, r >= need);
}
check("muted on baby blue is below AA, so no muted text sits on blue", contrastRatio(PALETTE.muted, PALETTE.blue) < 4.5);
check("palette is defined in OKLCH in the stylesheet", ["93.7%", "97.4%", "24.5%", "47.5%", "80.7%", "95.3%", "88.9%"].every((v) => css.includes(`oklch(${v}`)));
check("paper is the deeper cream, cards the lighter cream", css.includes("--paper: #f3e9d7") && css.includes("--card: #faf6ef"));
check("slide cards are cream with a baby blue top rule", css.includes(".slide-card") && css.includes("background: var(--slide-bg)") && css.includes("border-top: 4px solid var(--slide-accent)") && css.includes("--slide-bg: #faf6ef") && css.includes("--slide-accent: #8ec8ee"));
check("header carries a baby blue rule", css.includes("border-bottom: 3px solid var(--accent)"));
check("no white card or input surfaces remain", !css.includes("background: #fff") && !css.includes("background: #ffffff"));
check("old green accent is gone from the stylesheet", !css.includes("#1F6B3A") && !css.includes("#1f6b3a"));
check("old red and amber are gone from the stylesheet", !css.includes("#C81E1E") && !css.includes("#B54708"));
check("manifest theme primary is the baby blue", manifest.theme.primary === "#8EC8EE");
const favicon = readFileSync(path.join(ROOT, "favicon.svg"), "utf8");
check("favicon uses the baby blue", favicon.includes("#8EC8EE") && !favicon.includes("#1F6B3A"));
const coreSrc = readFileSync(path.join(ROOT, "deckcast-core.js"), "utf8");
check("pptx export uses the new palette", coreSrc.includes('"2B1D12"') && coreSrc.includes('"8EC8EE"') && coreSrc.includes('"F3E9D7"') && coreSrc.includes('"FAF6EF"') && !coreSrc.includes('"1F6B3A"'));

// ---- 11. Pre-launch pages and files --------------------------------------------
for (const f of ["privacy.html", "terms.html"]) {
  const html = readFileSync(path.join(ROOT, f), "utf8");
  check(`${f} has a title`, /<title>[^<]+<\/title>/.test(html));
  check(`${f} has a meta description`, html.includes('name="description"'));
  check(`${f} links the favicon`, html.includes('href="favicon.svg"'));
  check(`${f} links the stylesheet`, html.includes('href="styles.css"'));
  check(`${f} carries the CSP meta`, html.includes("Content-Security-Policy"));
  check(`${f} has no em dash`, !html.includes(EM_DASH));
}
const page404 = readFileSync(path.join(ROOT, "404.html"), "utf8");
check("404 page has a title and description", /<title>[^<]+<\/title>/.test(page404) && page404.includes('name="description"'));
const robots = readFileSync(path.join(ROOT, "robots.txt"), "utf8");
check("robots.txt allows all and names the sitemap", robots.includes("User-agent: *") && robots.includes("Sitemap: https://ryannb01.github.io/DeckCast/sitemap.xml"));
const sitemap = readFileSync(path.join(ROOT, "sitemap.xml"), "utf8");
check("sitemap lists home, privacy, and terms", ["https://ryannb01.github.io/DeckCast/", "/privacy.html", "/terms.html"].every((u) => sitemap.includes(u)));
const ogPath = path.join(ROOT, "og-image.png");
check("social preview image exists", existsSync(ogPath));
if (existsSync(ogPath)) {
  const png = readFileSync(ogPath);
  check("social preview image is a real PNG", png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47);
  check("social preview image is under 300 KB", statSync(ogPath).size < 300 * 1024, `${statSync(ogPath).size} bytes`);
}
check("index.html has Open Graph tags", indexHtml.includes('property="og:image"') && indexHtml.includes('property="og:title"'));
check("index.html has a large-image Twitter card", indexHtml.includes('name="twitter:card" content="summary_large_image"'));
const primaryButtons = (indexHtml.match(/class="[^"]*button-primary[^"]*"/g) || []).length;
check("exactly one primary call to action on the page", primaryButtons === 1, `found ${primaryButtons}`);
check("no cookies set by the site's own scripts", !["deck.js", "site.js", "deckcast-actions.js", "deckcast-core.js"].some((f) => readFileSync(path.join(ROOT, f), "utf8").includes("document.cookie")));
const headers = readFileSync(path.join(ROOT, "_headers"), "utf8");
check("_headers forces HTTPS upgrades", headers.includes("upgrade-insecure-requests"));
check("_headers sets HSTS", headers.includes("Strict-Transport-Security"));
check("index.html viewport declares safe-area support", indexHtml.includes("viewport-fit=cover"));
check("stylesheet caps reading lines near 65 characters", css.includes("max-width: 65ch"));
check("stylesheet sets deliberate letter spacing", css.includes("letter-spacing: -0.015em") && css.includes("letter-spacing: 0.01em"));
check("stylesheet uses tabular numbers for counters", css.includes("font-variant-numeric: tabular-nums"));
check("stylesheet avoids widows and orphans", css.includes("text-wrap: pretty") && css.includes("orphans: 3"));
check("stylesheet uses safe-area insets", css.includes("env(safe-area-inset-"));
check("stylesheet has skeleton and empty-state styles", css.includes(".skeleton") && css.includes(".empty-state"));
check("stylesheet animates entrances ease-out", css.includes("@keyframes slide-in") && css.includes("ease-out"));
check("stylesheet respects reduced motion", css.includes("prefers-reduced-motion"));

// ---- 12. Whisper from Hugging Face and the quiz peer ---------------------------
// Whisper runs on the device, but the model itself is not vendored: the
// 30.7 MB decoder is over every GitHub upload limit, so the library
// downloads it from the Hugging Face hub on first use (about 44 MB total,
// cached by the browser afterwards). The library and the ONNX runtime wasm
// stay vendored. No audio or transcript ever leaves the browser: the
// Hugging Face request is a download only.
check("Whisper model is tiny, quantized, English-only", WHISPER_MODEL === "Xenova/whisper-tiny.en");
check("Whisper expects 16 kHz mono audio", WHISPER_SAMPLE_RATE === 16000);
check("transcription estimate is about half real time", estimateTranscribeMs(30) === 15000 && estimateTranscribeMs(0) === 1000);
const whisperSource = readFileSync(path.join(ROOT, "whisper.js"), "utf8");
check("whisper.js loads the model from Hugging Face", whisperSource.includes("allowRemoteModels = true"));
check("whisper.js does not read a local model directory", whisperSource.includes("allowLocalModels = false") && !whisperSource.includes("localModelPath") && !whisperSource.includes("vendor/models"));
const whisperVendor = [
  "vendor/transformers.min.js",
  "vendor/onnx/ort-wasm-simd.wasm",
  "vendor/onnx/ort-wasm.wasm",
];
for (const f of whisperVendor) {
  check(`Whisper runtime file exists: ${f}`, existsSync(path.join(ROOT, f)) && statSync(path.join(ROOT, f)).size > 1000);
}
// The model download goes to huggingface.co (large files redirect to its
// *.cdn.hf.co CDN). The CSP permits it through connect-src 'self' https:,
// which stays broad on purpose: the BYOK panel lets a visitor point at any
// OpenAI-compatible provider router, so the policy cannot be narrowed to a
// fixed host list without breaking the LLM calls.
check("page CSP permits the Hugging Face model download", indexHtml.includes("connect-src 'self' https:"));
check("server headers CSP permits the Hugging Face model download", readFileSync(path.join(ROOT, "_headers"), "utf8").includes("connect-src 'self' https:"));
check("page CSP allows wasm eval for the ONNX runtime", indexHtml.includes("'wasm-unsafe-eval'"));
check("server headers CSP allows wasm eval for the ONNX runtime", readFileSync(path.join(ROOT, "_headers"), "utf8").includes("'wasm-unsafe-eval'"));
// transcribeBlob with an override: the Node-safe path, no model download.
setTranscriberOverride(async () => ({ text: "Photosynthesis makes food from light.", durationSeconds: 2, model: WHISPER_MODEL }));
const stubbed = await transcribeBlob(new Blob(["x"], { type: "audio/wav" }));
check("transcribeBlob honours the test override", stubbed.text.includes("Photosynthesis"));
clearTranscriberOverride();
setTranscriberOverride(async () => { throw new Error("stubbed failure"); });
let threw = false;
try { await transcribeBlob(new Blob(["x"], { type: "audio/wav" })); } catch { threw = true; }
check("transcribeBlob propagates a transcription failure", threw === true);
clearTranscriberOverride();
// The quiz generator is a real sibling network in this repo, not a stub.
const quizNetwork = JSON.parse(readFileSync(path.join(ROOT, "quiz_generator.network.json"), "utf8"));
check("quiz network front is quiz_generator_front", quizNetwork.tools[0].name === "quiz_generator_front");
check("manifest lists both networks", manifest.networks.map((n) => n.name).join(",") === "deckcast,quiz_generator");
const linksDoc = JSON.parse(readFileSync(path.join(ROOT, "links.json"), "utf8"));
check("links.json names both networks", linksDoc.networks.deckcast !== undefined && linksDoc.networks.quiz_generator !== undefined);
check("quiz hocon exists and names the quiz network", readFileSync(path.join(ROOT, "quiz_generator.hocon"), "utf8").includes("quiz_generator"));
check("manifest peer policy stays closed", manifest.peer_policy.mode === "closed");
check("site.js tells agents whether the model is real", readFileSync(path.join(ROOT, "site.js"), "utf8").includes("Real model:"));
check("structure instructions require rewriting, not verbatim", network.tools.find((t) => t.name === "structure").instructions.includes("never their verbatim words"));
check("structure instructions demand complete sentences", network.tools.find((t) => t.name === "structure").instructions.includes("one complete sentence with a subject and a verb"));
check("structure instructions repair ASR garbles from context", network.tools.find((t) => t.name === "structure").instructions.includes("charge symbol") && network.tools.find((t) => t.name === "structure").instructions.includes("pure ASR noise"));
check("structure instructions state the correct 7-tuple", network.tools.find((t) => t.name === "structure").instructions.includes("7-tuple is (Q, Sigma, Gamma, delta, q0, blank, F)") && network.tools.find((t) => t.name === "structure").instructions.includes("delta(q0, A) = (q1, Y, R)"));
check("structure instructions keep the stack out of Sigma", network.tools.find((t) => t.name === "structure").instructions.includes("has no stack") && network.tools.find((t) => t.name === "structure").instructions.includes("does not belong to Sigma"));
check("structure instructions restate the summary, never copy", network.tools.find((t) => t.name === "structure").instructions.includes("never copies a bullet or a transcript sentence"));
check("slide_designer instructions return outline JSON", network.tools.find((t) => t.name === "slide_designer").instructions.includes("website_set_outline"));
check("slide_designer instructions polish bullets and check the facts", network.tools.find((t) => t.name === "slide_designer").instructions.includes("one complete sentence with a subject and a verb") && network.tools.find((t) => t.name === "slide_designer").instructions.includes("pure ASR noise") && network.tools.find((t) => t.name === "slide_designer").instructions.includes("Keep the facts structure established"));
check("grounding rules never touch an API key", network.commondefs.replacement_strings.grounding_rules.includes("Never ask for, log, or store an API key"));
check("set_outline description demands complete sentences", actionsSrc.includes("one complete sentence in correct grammar"));
check("hocon and network agree on the rewrite rules", readFileSync(path.join(ROOT, "deckcast.hocon"), "utf8").includes("7-tuple is (Q, Sigma, Gamma, delta, q0, blank, F)") && readFileSync(path.join(ROOT, "deckcast.hocon"), "utf8").includes("never copies a bullet or a transcript sentence"));

// ---- 12b. Provider 429 retry: wait out the full suggested window ----------
// Groq answers 429 with a Retry-After header AND a "try again in Xs" phrase
// in the body, and the two can disagree. The retry must wait the LONGEST
// suggestion: waiting only a short header while the body asks for 30s earns
// another 429, because the tokens that tripped the limit are still inside
// the provider's rolling window. Stubbed fetch only: no API key, no network.
function fakeHeaders(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { get: (name) => map.get(name) ?? null };
}
check("retry waits the longer of header and body", retryAfterMs({ headers: fakeHeaders({ "Retry-After": "1" }) }, "Rate limit reached. Please try again in 30.105s.") === 30105);
check("retry waits the header when it is longer", retryAfterMs({ headers: fakeHeaders({ "Retry-After": "45" }) }, "Please try again in 2s.") === 45000);
check("retry reads the body phrase alone", retryAfterMs({ headers: fakeHeaders({}) }, "Rate limit reached for model openai/gpt-oss-120b. Please try again in 30.105s.") === 30105);
check("retry defaults to 5s with no suggestion", retryAfterMs({ headers: fakeHeaders({}) }, "Rate limit reached.") === 5000);
check("retry caps a huge suggestion at 60s", retryAfterMs({ headers: fakeHeaders({}) }, "Please try again in 600s.") === 60000);
check("retry honours an HTTP-date Retry-After", retryAfterMs({ headers: fakeHeaders({ "Retry-After": new Date(Date.now() + 10000).toUTCString() }) }, "") >= 9000 && retryAfterMs({ headers: fakeHeaders({ "Retry-After": new Date(Date.now() + 10000).toUTCString() }) }, "") <= 11000);
check("at most two retries per call", LLM_429_MAX_RETRIES === 2);
const sseOk = (model, text) => `data: ${JSON.stringify({ model, choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n`;
const traceStub = { start: () => "span", update: () => {}, end: () => {}, fail: () => {} };
const realFetch = globalThis.fetch;
try {
  // 429, then success: the call succeeds and fetch ran twice.
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) return new Response("Rate limit reached. Please try again in 0.05s.", { status: 429 });
    return new Response(sseOk("openai/gpt-oss-120b", "Hello from the model"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const retryClient = new LlmClient({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk_stub_key", trace: traceStub, mock: false });
  const retried = await retryClient.chat({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }], tools: [] });
  check("a 429 is retried and then succeeds", retried.content === "Hello from the model" && retried.model === "openai/gpt-oss-120b" && fetchCalls === 2, `fetch ran ${fetchCalls} times`);
  // A short header must not cut a longer body delay short: the elapsed time
  // is the body's 0.2s, not the header's 0s.
  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) return new Response("Please try again in 0.2s.", { status: 429, headers: { "Retry-After": "0" } });
    return new Response(sseOk("openai/gpt-oss-120b", "second try"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const waitedFrom = Date.now();
  const retriedSlow = await retryClient.chat({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }], tools: [] });
  const waitedMs = Date.now() - waitedFrom;
  check("the retry waits the body's longer delay, not the short header", retriedSlow.content === "second try" && waitedMs >= 150, `waited ${waitedMs}ms`);
  // 429s exhausted: three attempts, then the 429 error surfaces.
  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("Rate limit reached. Please try again in 0.01s.", { status: 429 });
  };
  let exhausted = null;
  try { await retryClient.chat({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }], tools: [] }); } catch (err) { exhausted = err; }
  check("a 429 that never clears fails after three attempts", exhausted !== null && /LLM HTTP 429/.test(exhausted.message) && fetchCalls === 3, `fetch ran ${fetchCalls} times`);
  // A 500 is not a rate limit: it fails at once, with no retry.
  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("Internal error.", { status: 500 });
  };
  let failed500 = null;
  try { await retryClient.chat({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }], tools: [] }); } catch (err) { failed500 = err; }
  check("a 500 fails at once without retrying", failed500 !== null && /LLM HTTP 500/.test(failed500.message) && fetchCalls === 1, `fetch ran ${fetchCalls} times`);
} finally {
  globalThis.fetch = realFetch;
}

// ---- 12c. Token trims: the turn must fit the free tier's budget ----------
// Measured live in headless Chromium with a stubbed provider (see the
// harness notes in TESTING.md): the full Turing turn was 13 calls totalling
// ~81,300 tokens before the trims and ~59,100 after, with the first two
// calls falling from ~4,200 + ~4,800 to ~2,400 + ~2,900. The trims below
// are what did it: no render_cruse tool, a compressed grounding block, the
// transcript excerpt out of every agent's instructions, and a shorter
// set_outline description. The turn still exceeds the 8,000 TPM free-tier
// budget on its own (the producer re-sends its history on all seven of its
// calls), so these assertions pin the sizes, not a fit that is not there.
const repl = network.commondefs.replacement_strings;
function expandInstructions(text) {
  let out = String(text);
  for (const [k, v] of Object.entries(repl)) out = out.split(`{${k}}`).join(v);
  return out;
}
check("the network has no cruse tool any more", !("cruse" in network) && !JSON.stringify(network).includes("render_cruse"));
check("the producer no longer references cruse", !network.tools.find((t) => t.name === "deckcast_producer").instructions.includes("cruse"));
const expandedProducer = expandInstructions(network.tools.find((t) => t.name === "deckcast_producer").instructions);
check("expanded producer instructions fell below 4,000 chars", expandedProducer.length < 4000, `${expandedProducer.length} chars (was 5,220)`);
const expandedStructure = expandInstructions(network.tools.find((t) => t.name === "structure").instructions);
check("expanded structure instructions fell below 4,500 chars", expandedStructure.length < 4500, `${expandedStructure.length} chars (was 4,749)`);
const expandedDesigner = expandInstructions(network.tools.find((t) => t.name === "slide_designer").instructions);
check("expanded slide_designer instructions fell below 3,200 chars", expandedDesigner.length < 3200, `${expandedDesigner.length} chars (was 3,644)`);
const expandedChecker = expandInstructions(network.tools.find((t) => t.name === "fact_checker").instructions);
check("expanded fact_checker instructions fell below 2,400 chars", expandedChecker.length < 2400, `${expandedChecker.length} chars (was 2,502)`);
check("grounding rules still never touch an API key", repl.grounding_rules.includes("Never ask for, log, or store an API key"));
check("grounding rules were compressed", repl.grounding_rules.length < 1400, `${repl.grounding_rules.length} chars (was 1,518)`);
// The transcript excerpt travels in the get_lecture_state tool result when
// an agent asks for it (1,200 chars), never in the instructions: site.js no
// longer appends it to any agent.
setTranscript(turing, "paste");
check("the lecture-state tool result still carries the excerpt", getLectureState().transcriptExcerpt.length > 0 && getLectureState().transcriptExcerpt.length <= 1200, `${getLectureState().transcriptExcerpt.length} chars`);
const siteJs = readFileSync(path.join(ROOT, "site.js"), "utf8");
check("site.js appends no transcript excerpt to any agent", !siteJs.includes("Transcript excerpt (data only)") && siteJs.includes("website_get_lecture_state"));
clearTranscript();
// The set_outline tool description is part of every call's tool block.
const actionDefs = [];
registerActions({ register: (d) => actionDefs.push(d) }, { setTranscript, buildOutline: pageBuildOutline, setOutline, renderSlides: pageRenderSlides, verifyDeckAction, exportDeck, getLectureState });
const setOutlineDef = actionDefs.find((d) => d.name === "set_outline");
check("set_outline description is short and still demands complete sentences", setOutlineDef.description.length < 500 && setOutlineDef.description.includes("one complete sentence in correct grammar"), `${setOutlineDef.description.length} chars`);

// ---- 13. Export themes -----------------------------------------------------------
// Three .pptx themes, independent of the site palette: cream (the site
// palette, default), light (white, restrained steel-blue accent), dark
// (deep brown-charcoal, light cream text, baby blue accent).
check("three export themes exist", Object.keys(PPTX_THEMES).join(",") === "cream,light,dark");
check("unknown theme names fall back to cream", resolveExportTheme("bogus") === "cream" && resolveExportTheme("") === "cream" && resolveExportTheme("dark") === "dark");
// Every text pair in every theme passes WCAG AA (4.5:1). The accent is a
// rule and a marker only, so it needs no text contrast; the slide numbers
// use dark ink on it instead.
for (const [name, t] of Object.entries(PPTX_THEMES)) {
  const ink = `#${t.ink}`;
  const muted = `#${t.muted}`;
  check(`${name} theme: ink on card passes AA`, contrastRatio(ink, `#${t.card}`) >= 4.5, contrastRatio(ink, `#${t.card}`).toFixed(2));
  check(`${name} theme: muted on card passes AA`, contrastRatio(muted, `#${t.card}`) >= 4.5, contrastRatio(muted, `#${t.card}`).toFixed(2));
  check(`${name} theme: ink on title background passes AA`, contrastRatio(ink, `#${t.titleBg}`) >= 4.5, contrastRatio(ink, `#${t.titleBg}`).toFixed(2));
  check(`${name} theme: muted on title background passes AA`, contrastRatio(muted, `#${t.titleBg}`) >= 4.5, contrastRatio(muted, `#${t.titleBg}`).toFixed(2));
}
check("dark ink on the baby blue accent passes AA", contrastRatio("#2B1D12", "#8EC8EE") >= 4.5, contrastRatio("#2B1D12", "#8EC8EE").toFixed(2));
check("dark ink on the steel blue accent passes AA", contrastRatio("#2B1D12", "#6B9CC4") >= 4.5, contrastRatio("#2B1D12", "#6B9CC4").toFixed(2));
// The exported .pptx file itself carries each theme's colours, and only
// that theme's colours: the slide XML is read back out of the ZIP.
const themeSlides = [
  { type: "title", title: "Theme check", bullets: [], notes: "Title notes.", diagram: null },
  { type: "content", title: "Content", bullets: [{ text: "A bullet", source: 0 }], notes: "Content notes.", diagram: null },
];
const themeMarkers = {
  cream: { present: ["F3E9D7", "FAF6EF", "8EC8EE"], absent: ["221A12", "2E241A", "6B9CC4", "FFFFFF", "C9BBA6"] },
  light: { present: ["FFFFFF", "6B9CC4", "2B1D12"], absent: ["F3E9D7", "FAF6EF", "221A12", "2E241A", "8EC8EE", "C9BBA6"] },
  dark: { present: ["221A12", "2E241A", "C9BBA6", "8EC8EE"], absent: ["F3E9D7", "FFFFFF", "6B9CC4", "2B1D12", "6B5847"] },
};
for (const theme of ["cream", "light", "dark"]) {
  const themed = createPptx(pptxSandbox.PptxGenJS, themeSlides, "Theme check", theme);
  const themedB64 = await themed.write({ outputType: "base64" });
  const themedXml = pptxSlideXml(themedB64);
  check(`${theme} export is a real .pptx`, Buffer.from(themedB64.slice(0, 8), "base64").toString("latin1").startsWith("PK"));
  check(`${theme} export carries its own colours`, themeMarkers[theme].present.every((hex) => themedXml.includes(hex)), themeMarkers[theme].present.filter((hex) => !themedXml.includes(hex)).join(","));
  check(`${theme} export carries no other theme's colours`, themeMarkers[theme].absent.every((hex) => !themedXml.includes(hex)), themeMarkers[theme].absent.filter((hex) => themedXml.includes(hex)).join(","));
}
const defaultThemed = createPptx(pptxSandbox.PptxGenJS, themeSlides, "Theme check");
const defaultXml = pptxSlideXml(await defaultThemed.write({ outputType: "base64" }));
check("export without a theme defaults to cream", defaultXml.includes("F3E9D7") && !defaultXml.includes("221A12"));
// The diagram SVGs follow the theme too, so the preview matches the export.
const flowForTheme = { kind: "flow", steps: [{ label: "Step one", source: 0 }, { label: "Step two", source: 1 }, { label: "Step three", source: 2 }] };
check("diagram SVG defaults to cream", diagramSvg(flowForTheme).includes("#F3E9D7") && diagramSvg(flowForTheme).includes("#FAF6EF"));
check("diagram SVG in dark uses the dark colours", diagramSvg(flowForTheme, "dark").includes("#221A12") && diagramSvg(flowForTheme, "dark").includes("#2E241A") && diagramSvg(flowForTheme, "dark").includes("#FAF6EF"));
check("diagram SVG in light uses the light colours", diagramSvg(flowForTheme, "light").includes("#FFFFFF") && !diagramSvg(flowForTheme, "light").includes("#F3E9D7"));
// Theme choice is remembered: setExportTheme writes it to localStorage.
const fakeStore = new Map();
globalThis.localStorage = { getItem: (k) => (fakeStore.has(k) ? fakeStore.get(k) : null), setItem: (k, v) => fakeStore.set(k, String(v)) };
check("setExportTheme switches the theme", setExportTheme("dark").theme === "dark" && getExportTheme() === "dark" && deckApp.exportTheme === "dark");
check("setExportTheme remembers the choice", fakeStore.get("deckcast-export-theme") === "dark");
check("setExportTheme falls back to cream for an unknown name", setExportTheme("bogus").theme === "cream" && fakeStore.get("deckcast-export-theme") === "cream");
check("export theme picker is in the page", readFileSync(path.join(ROOT, "index.html"), "utf8").includes('id="export-theme"'));
check("export theme picker offers all three themes", ["cream", "light", "dark"].every((t) => readFileSync(path.join(ROOT, "index.html"), "utf8").includes(`value="${t}"`)));
check("stylesheet themes the preview cards per export theme", css.includes('[data-export-theme="dark"]') && css.includes('[data-export-theme="light"]') && css.includes("--slide-bg"));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
