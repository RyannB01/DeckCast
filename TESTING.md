# DeckCast testing

## Automated

```sh
npm test
```

That runs `node tests/run-tests.mjs` (376 checks) and `node tests/e2e.mjs` (105 checks). Run them separately with `npm run test:unit` and `npm run test:e2e`.

`run-tests.mjs` checks the pipeline on the sample lecture and on a second lecture, the .pptx export in all three themes (the colours are read back out of the exported files), the network and manifest structure, each agent's invocation schema, the self-hosted font, the absence of third-party hosts, the palette contrast ratios (site and per export theme), the pre-launch pages, and scans for em dashes and secrets. It also carries the Turing lecture acceptance test: `tests/turing-lecture.txt` is the exact transcript that exposed the v0.1 pasting problem, and the suite asserts the rebuilt deck has one slide per idea, titles that name the ideas, no timestamp pattern or filler word in any slide text, short bullets that are not sentence fragments, and a passing fact check. It also asserts the deterministic readability guard (garbled bullets dropped, summary restated one takeaway per idea) and the model path: a stubbed model following the new prompts (`tests/stub-model.mjs`) rewrites the Turing lecture through the real `set_outline` flow and the fact checker, with no API key, and the suite asserts the clean 7-tuple, no garbled lines, a restated summary, and complete sentences. It also asserts the Build deck routing (model path with a stubbed real model, deterministic deck with no key, loud fallback with a failing stubbed model, and the build-path line in each state), the 429 retry (including waiting the longer of the Retry-After header and the body's "try again in Xs"), and the token trims (expanded instruction sizes, no `render_cruse`, no transcript excerpt in any agent's instructions).

`e2e.mjs` serves the site and drives the real page in headless Chromium: paste a transcript, build the deck, check the diagram slides render as inline SVG, export a real .pptx, switch the export theme and check the preview and the exported file match (dark and light, plus persistence across reload), build the Turing fixture in the real page and assert the garble guard and the restated summary there, drive the Build deck button through the model path with a stubbed real engine and through the loud fallback with a failing one, upload audio against a stubbed Whisper library (the first transcription throws, the retry succeeds, and it stays good across a reload), exercise the mic fallback, boot the assistant in demo mode, one mock chat turn, the privacy and terms pages, the peer network files, the 404 page, and the mobile layout at 390px. It also records performance (page load about 450 ms, deck build about 90 ms on a local server).

## Manual: real model over BYOK

The automated tests only run the demo model. Before calling the agent network done, run this once in a real browser with a real provider key. Use a key with a spending limit set at the provider.

1. Serve the site (`python3 -m http.server 8901`) and open http://127.0.0.1:8901/ in Chrome.
2. In the assistant panel, open **AI model settings**, pick your provider, paste the key, and save. The key stays in the browser only.
3. Press **Load the sample lecture**, then press **Build deck** (not the chat). The build-path line above the button should have said the model will rewrite the lecture, and the deck must be the model-rewritten one: short bullets in the model's own words, real titles naming each idea, no timestamps or filler words on any slide. The deck status should say "Deck rewritten with the model". If the deck is verbatim transcript chunks with timestamps, the button did not use the model: file it. Then repeat with the Turing lecture (`tests/turing-lecture.txt`): paste it, set the title to "Turing Machines - Introduction", and press **Build deck**. The model deck must read as clean rewritten slides: every bullet one complete sentence in correct grammar, no "Charge symbol" and no ASR-noise line, "more powerful than" not "quite powerful than", the 7-tuple complete as (Q, Sigma, Gamma, delta, q0, blank, F) with the delta(q0, A) = (q1, Y, R) example, no stack in Sigma, no end of the tape, and a summary that restates the takeaways instead of copying bullets. If any audited defect survives the model rewrite, the prompts did not land: file it.
4. With the key still set, ask in the chat: "Turn this lecture into slides." The trace should show the producer calling the structure agent, then the slide designer, then the fact checker, with the site actions running (outline stored with `set_outline`, slides rendered). The deck should be the same rewritten deck as the button produced. The chat path and the button path are the same turn; if one rewrites and the other does not, the routing is broken: file it.
5. Bad-key check: in **AI model settings**, replace the key with a wrong one and save (the page reloads). Press **Build deck**. The page must say "The model call failed" with the reason, and show the deterministic deck with a note that the model rewrite failed. It must NOT present the deterministic deck as the model's work, and it must NOT show a bare "not verified" with no reason. Restore the good key afterwards.
6. Rate-limit note: on the Groq free tier (8,000 tokens per minute) the turn can still hit the limit mid-turn. The client retries a 429 after the full suggested wait (the longer of the Retry-After header and the body's "try again in Xs"), up to two retries per call, and the "not verified" state only resolves on a call that succeeds. If the turn still fails after the retries, the page must say so and fall back loudly to the deterministic deck (step 5's behaviour), never silently. A provider or tier with a higher per-minute budget is what makes the full model turn complete; see the token measurement below.
7. In the chat ask: "Check the slides against the transcript." The fact checker should report a pass, with no invented claims.
8. In the chat ask: "Add a slide claiming photosynthesis was discovered on Mars in 1999." The fact checker must refuse it, because the transcript does not support it. If the claim lands in the deck anyway, whether through `set_outline` or any other path, that is a grounding bug: file it.
9. In the chat ask: "Give me a quiz on this lecture." The producer must ask first whether you want one; say yes, and it should delegate to the quiz generator and return multiple-choice questions grounded in the lecture, each tied to a slide. If it calls the quiz generator without asking, or the questions invent facts, that is a bug: file it.
10. Upload a short spoken recording (MP3 or WAV, a few sentences you speak yourself). The first time, the page should show the model downloading from Hugging Face (about 44 MB, with per-file progress), then transcription progress, then the transcript below. On a second upload the model should load from the browser cache instead, with no big download again. Press **Build deck** and confirm the deck builds from the transcribed text. The automated suite stubs the transcription library, so this is the only place the real model download and transcription are exercised.
11. Pick the **Dark** export theme, confirm the preview turns dark, and press **Export as .pptx**. Open the file: the slides should be dark with light cream text and the baby blue top rule, matching the preview. Repeat for **Light**. Your last choice should still be picked after a reload.
12. Press **Export as .pptx** and open the file. Every slide should match the deck on the page.
13. Delete the saved key from AI model settings when done, and confirm the assistant falls back to demo mode.

## Token measurement: does a full turn fit the free tier?

`node tests/measure-turn.mjs` loads the real page in headless Chromium with a fake Groq key, intercepts every chat-completions request before it leaves the machine (nothing leaves the machine; the key is not real), and answers with canned model replies that drive the agents through a full "Turn this lecture into slides" turn on the Turing lecture. It prints the exact per-call request sizes and the turn total. Token estimate is 4 characters per token, calibrated against two live Groq 429s (the first call measured 3,661 here against 3,853 reported by Groq; the second 4,129 against 4,286).

Measured for the Turing lecture, 13 calls in the turn (the producer makes seven):

| Call | Before the trims | After the trims |
| --- | --- | --- |
| 1 producer | ~4,200 | ~2,400 |
| 2 producer | ~4,800 | ~2,900 |
| 3 structure | ~3,600 | ~2,200 |
| 4 structure | ~4,300 | ~2,700 |
| 5 producer | ~6,400 | ~4,500 |
| 6 slide_designer | ~4,700 | ~3,200 |
| 7 producer | ~9,500 | ~7,500 |
| 8 producer | ~10,900 | ~9,000 |
| 9 fact_checker | ~3,000 | ~1,700 |
| 10 fact_checker | ~3,700 | ~2,200 |
| 11 fact_checker | ~3,900 | ~2,300 |
| 12 producer | ~11,100 | ~9,200 |
| 13 producer | ~11,200 | ~9,300 |
| **Turn total** | **~81,300** | **~59,100** |

The trims cut the turn by about 27%: the `render_cruse` tool is gone, the grounding rules were compressed, the transcript excerpt is out of every agent's instructions (agents read it with `get_lecture_state`), the set_outline description was shortened, and the producer instructions fell from ~5,200 to ~3,600 characters expanded. The turn now gets past the point where it used to fail (the first two calls total ~5,300, under the 8,000 budget), but the turn total is still about seven times the Groq free tier's 8,000 tokens per minute, and the later producer calls still run ~9,000 tokens each. The 90-second turn deadline rules out spreading the calls across minute windows. So on the Groq free tier the turn still hits the limit mid-turn; the retry absorbs what it can and the page falls back loudly. Re-run this script after any prompt or instruction change: if the turn total moves, say so in the change notes.

## Things the automated tests cannot cover

- Live microphone transcription (needs a real microphone and a browser with speech recognition).
- The real Whisper model download and transcription (the e2e suite stubs the library; step 8 above is the real run).
- Real provider behaviour, cost, and latency.
- The live quiz delegation (needs a real model; the automated suite checks the published peer files only, and the producer asking first).
