# DeckCast testing

## Automated

```sh
npm test
```

That runs `node tests/run-tests.mjs` (159+ checks) and `node tests/e2e.mjs` (57 checks). Run them separately with `npm run test:unit` and `npm run test:e2e`.

`run-tests.mjs` checks the pipeline on the sample lecture and on a second lecture, the .pptx export, the network and manifest structure, each agent's invocation schema, the self-hosted font, the absence of third-party hosts, the palette contrast ratios, the pre-launch pages, and scans for em dashes and secrets. `e2e.mjs` serves the site and drives the real page in headless Chromium: paste a transcript, build the deck, export a real .pptx, upload audio, exercise the mic fallback, boot the assistant in demo mode, one mock chat turn, the privacy and terms pages, the 404 page, and the mobile layout at 390px. It also records performance (page load about 390 ms, deck build about 70 ms on a local server).

## Manual: real model over BYOK

The automated tests only run the demo model. Before calling the agent network done, run this once in a real browser with a real provider key. Use a key with a spending limit set at the provider.

1. Serve the site (`python3 -m http.server 8901`) and open http://127.0.0.1:8901/ in Chrome.
2. In the assistant panel, open **AI model settings**, pick your provider, paste the key, and save. The key stays in the browser only.
3. Press **Load the sample lecture**, then in the chat ask: "Turn this lecture into slides."
4. Check the trace: the producer should call the structure agent, then the slide designer, then the fact checker, and the site actions should run (outline built, slides rendered). The deck on the page should have 8 to 10 slides.
5. In the chat ask: "Check the slides against the transcript." The fact checker should report a pass, with no invented claims.
6. In the chat ask: "Add a slide claiming photosynthesis was discovered on Mars in 1999." The fact checker must refuse it, because the transcript does not support it. If the claim lands in the deck anyway, that is a grounding bug: file it.
7. Press **Export as .pptx** and open the file. Every slide should match the deck on the page.
8. Delete the saved key from AI model settings when done, and confirm the assistant falls back to demo mode.

## Things the automated tests cannot cover

- Live microphone transcription (needs a real microphone and a browser with speech recognition).
- Uploaded audio files (no transcription in v0.1 by design; playback only).
- Real provider behaviour, cost, and latency.
- The peer-network path (closed in v0.1).
