# DeckCast testing

## Automated

```sh
npm test
```

That runs `node tests/run-tests.mjs` (326 checks) and `node tests/e2e.mjs` (97 checks). Run them separately with `npm run test:unit` and `npm run test:e2e`.

`run-tests.mjs` checks the pipeline on the sample lecture and on a second lecture, the .pptx export in all three themes (the colours are read back out of the exported files), the network and manifest structure, each agent's invocation schema, the self-hosted font, the absence of third-party hosts, the palette contrast ratios (site and per export theme), the pre-launch pages, and scans for em dashes and secrets. It also carries the Turing lecture acceptance test: `tests/turing-lecture.txt` is the exact transcript that exposed the v0.1 pasting problem, and the suite asserts the rebuilt deck has one slide per idea, titles that name the ideas, no timestamp pattern or filler word in any slide text, short bullets that are not sentence fragments, and a passing fact check. It also asserts the deterministic readability guard (garbled bullets dropped, summary restated one takeaway per idea) and the model path: a stubbed model following the new prompts (`tests/stub-model.mjs`) rewrites the Turing lecture through the real `set_outline` flow and the fact checker, with no API key, and the suite asserts the clean 7-tuple, no garbled lines, a restated summary, and complete sentences.

`e2e.mjs` serves the site and drives the real page in headless Chromium: paste a transcript, build the deck, check the diagram slides render as inline SVG, export a real .pptx, switch the export theme and check the preview and the exported file match (dark and light, plus persistence across reload), build the Turing fixture in the real page and assert the garble guard and the restated summary there, upload audio against a stubbed Whisper library (the first transcription throws, the retry succeeds, and it stays good across a reload), exercise the mic fallback, boot the assistant in demo mode, one mock chat turn, the privacy and terms pages, the peer network files, the 404 page, and the mobile layout at 390px. It also records performance (page load about 450 ms, deck build about 90 ms on a local server).

## Manual: real model over BYOK

The automated tests only run the demo model. Before calling the agent network done, run this once in a real browser with a real provider key. Use a key with a spending limit set at the provider.

1. Serve the site (`python3 -m http.server 8901`) and open http://127.0.0.1:8901/ in Chrome.
2. In the assistant panel, open **AI model settings**, pick your provider, paste the key, and save. The key stays in the browser only.
3. Press **Load the sample lecture**, then in the chat ask: "Turn this lecture into slides."
4. Check the trace: the producer should call the structure agent, then the slide designer, then the fact checker, and the site actions should run (outline stored with `set_outline`, slides rendered). The deck on the page should have 7 slides. The structure and slide_designer agents should have rewritten the deck through the model: short bullets in their own words, real titles naming each idea, no timestamps or filler words on any slide. If the deck is verbatim transcript chunks with timestamps, the rewriting did not happen: file it. Then repeat with the Turing lecture (`tests/turing-lecture.txt`): paste it, set the title to "Turing Machines - Introduction", and ask for slides. The model deck must read as clean rewritten slides: every bullet one complete sentence in correct grammar, no "Charge symbol" and no ASR-noise line, "more powerful than" not "quite powerful than", the 7-tuple complete as (Q, Sigma, Gamma, delta, q0, blank, F) with the delta(q0, A) = (q1, Y, R) example, no stack in Sigma, no end of the tape, and a summary that restates the takeaways instead of copying bullets. If any audited defect survives the model rewrite, the prompts did not land: file it.
5. In the chat ask: "Check the slides against the transcript." The fact checker should report a pass, with no invented claims.
6. In the chat ask: "Add a slide claiming photosynthesis was discovered on Mars in 1999." The fact checker must refuse it, because the transcript does not support it. If the claim lands in the deck anyway, whether through `set_outline` or any other path, that is a grounding bug: file it.
7. In the chat ask: "Give me a quiz on this lecture." The producer must ask first whether you want one; say yes, and it should delegate to the quiz generator and return multiple-choice questions grounded in the lecture, each tied to a slide. If it calls the quiz generator without asking, or the questions invent facts, that is a bug: file it.
8. Upload a short spoken recording (MP3 or WAV, a few sentences you speak yourself). The first time, the page should show the model downloading from Hugging Face (about 44 MB, with per-file progress), then transcription progress, then the transcript below. On a second upload the model should load from the browser cache instead, with no big download again. Press **Build deck** and confirm the deck builds from the transcribed text. The automated suite stubs the transcription library, so this is the only place the real model download and transcription are exercised.
9. Pick the **Dark** export theme, confirm the preview turns dark, and press **Export as .pptx**. Open the file: the slides should be dark with light cream text and the baby blue top rule, matching the preview. Repeat for **Light**. Your last choice should still be picked after a reload.
10. Press **Export as .pptx** and open the file. Every slide should match the deck on the page.
11. Delete the saved key from AI model settings when done, and confirm the assistant falls back to demo mode.

## Things the automated tests cannot cover

- Live microphone transcription (needs a real microphone and a browser with speech recognition).
- The real Whisper model download and transcription (the e2e suite stubs the library; step 8 above is the real run).
- Real provider behaviour, cost, and latency.
- The live quiz delegation (needs a real model; the automated suite checks the published peer files only, and the producer asking first).
