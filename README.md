# DeckCast

Turn a lecture into a slide deck. Paste or record a lecture, let the agents pull out the key points, build the slides, and check every claim against what was actually said. Then export the deck as a .pptx file.

Built for the [Open Agentic Web Challenge](https://cognizant-agenticweb.devpost.com/) (Cognizant, Devpost). Submissions close 11 January 2027.

## How it works

Give it a lecture in one of three ways: paste a transcript, record with your microphone, or upload an audio file, which is transcribed on the device with Whisper. Four specialist agents turn it into a deck:

- **transcriber** turns the lecture into a transcript and stores text you paste in chat.
- **structure** reads the transcript and drafts the slide outline: title, one idea per slide, bullets and speaker notes. With a real model key it rewrites each idea into short bullets in its own words; without one, the deterministic pipeline does the same job from key sentences.
- **slide_designer** turns the outline into slide content: layout, concise slide text and simple visuals. With a real model key it refines the wording through the model; without one, the deterministic outline stands.
- **fact_checker** verifies every slide claim against the transcript and flags anything not grounded in it. No invented content, ever.

The front agent, **deckcast_producer**, orchestrates the four specialists and talks to you. The agents act on the page through seven site actions: `get_lecture_state`, `set_transcript`, `build_outline`, `set_outline`, `render_slides`, `verify_deck`, `export_deck`.

DeckCast is an open agentic website: the agent network is published as data (`agent-manifest.json`, `deckcast.network.json`), runs in your browser, and follows the [Open Agentic Web MVP spec](https://github.com/cognizant-ai-labs/agentic-web) (Profile 0.2).

## Run it locally

```sh
python3 -m http.server 8901
```

Then open http://127.0.0.1:8901/ in any modern browser. No build step, no server code, no install.

The fastest demo: press **Load the sample lecture**, then **Build deck**, then **Export as .pptx**. The sample is a short lecture on photosynthesis in `sample-lecture.txt`.

## Bring your own key

By default the assistant runs in demo mode: it can build decks from the page, but its writing and fact checking use a demo model. For real model calls, add your own AI provider key in **AI model settings** in the assistant panel. Pick a provider, get a key from that provider's site, and paste it in. The key is stored in your browser's localStorage only. It is sent only to the provider you choose, never to DeckCast, never to any peer site, and never into a URL or a file. Set a spending limit on the key with your provider before you use it.

- **Google AI Studio (free tier).** Go to https://aistudio.google.com/apikey and sign in with a Google account. Press **Get API key**, then **Create API key**, and copy the key (it starts with `AIza`). Back in DeckCast, pick **Google AI Studio** in AI model settings and paste it in. Model used: `gemini-3.8-flash`.
- **Groq (free tier).** Go to https://console.groq.com/keys and sign in. Press **Create API Key**, give it a name, and copy the key (it starts with `gsk_`). **Groq shows the key only once** — if you close the page without copying it, create a new one. Back in DeckCast, pick **Groq** in AI model settings and paste it in. Model used: `openai/gpt-oss-120b`.
- **OpenAI (billing may be required).** Go to https://platform.openai.com/api-keys and sign in. Press **Create new secret key**, and copy the key (it starts with `sk-proj-`). Back in DeckCast, pick **OpenAI** in AI model settings and paste it in. Model used: `gpt-5.5`.
- **Anthropic (billing may be required).** Go to https://console.anthropic.com/settings/keys and sign in. Press **Create Key**, and copy the key (it starts with `sk-ant-`). Back in DeckCast, pick **Anthropic** in AI model settings and paste it in. Model used: `claude-sonnet-4-6`.

You can also point DeckCast at any other OpenAI-compatible provider by entering its router URL and key in the same settings panel.

How to tell it worked: after you paste a key, the assistant panel shows an **LLM configured** badge, and the next deck you build is written and fact checked by the real model. You can confirm on the provider's side too — its usage page should show calls going out (for example, a fresh Groq key shows 0 API calls until the first real run).

## Privacy

- **Fonts are self-hosted.** The only webfont is IBM Plex Sans, served from `fonts/` on the same origin. No Google Fonts, no font CDN.
- **No analytics, no trackers, no external scripts, styles or images.** Everything the page loads comes from the same origin, except the transcription model: PptxGenJS is vendored in `vendor/` and the nsdeploy runtime lives in `runtime/`, while the Whisper model downloads from Hugging Face the first time you transcribe (see below).
- **Transcription stays on the device.** Uploaded audio and microphone recordings are transcribed in the browser with Whisper (tiny, quantized). The model downloads from Hugging Face on first use (about 44 MB, cached by the browser afterwards); that request is a download only, and no audio ever leaves the browser.
- **Outbound requests.** The site makes two kinds of request outside itself, and only when you ask: your own LLM call, after you enter a key and send a chat message, to the provider you chose; and the Whisper model download from Hugging Face, the first time you transcribe. The demo model makes no network calls at all.
- **The deployed site sets no cookies.**

## Deck quality: rewriting, not pasting

A spoken lecture is full of timestamps, filler words and false starts, and a deck built from raw chunks reads like a transcript pasted onto slides. DeckCast cleans first, then rewrites:

- **Cleaning.** Timestamps (0:09, 2:23) and filler words and phrases (uh, um, okay?, so, you know) are stripped from the transcript before anything is built from it. No timestamp or filler word can ever appear on a slide.
- **Ideas, not chunks.** The transcript is segmented into the lecture's real ideas. One idea is one slide: a real title naming the idea, 2 to 4 short bullets in the lecturer's meaning but never their verbatim words, and the transcript detail in the speaker notes.
- **Two ways to rewrite.** With a real model key, the structure and slide_designer agents rewrite the deck through the model and store it with the `set_outline` action; the producer tells the agents whether a real model is available. Without a key, the deterministic pipeline does the same job from key sentences: compressed clauses, no verbatim chunks. Either way the fact checker verifies every bullet against the transcript, including model-written bullets, which carry no source sentence and are checked against the whole transcript. The **Build deck** button takes the same two paths: with a real key it sends the lecture through the agent network exactly as the chat does, and without one it builds deterministically. The area above the button says which path will run before you press it, and the key is verified by the first model answer, not by the settings form.
- **Model rewriting rules.** A model bullet is one complete sentence in correct grammar, in the model's own words. Spoken slips are fixed ("quite powerful than" becomes "more powerful than", "can have a seven tuples" becomes "is defined by a 7-tuple"), ASR garbles are repaired from the lecture context ("charge symbol" is the tape alphabet, never a charge) or dropped when they are pure noise, and facts the lecture states are corrected (a Turing machine has no stack, Sigma is the input alphabet, Gamma is the tape alphabet, the blank symbol does not belong to Sigma, the tape is infinite with no end, and the 7-tuple lists all seven parts). Repairing a mishearing is not inventing content, but nothing the lecture never says may be added.
- **Deterministic guard and summary.** The deterministic pipeline drops bullets with obvious garble markers (repeated-word runs such as "this is this is" or "after your after"), so a garbled line can never reach a slide. The summary restates one takeaway per idea slide, labelled with that slide's title, instead of repeating the lecture's most central sentences, which used to copy the worst bullets verbatim.
- **Acceptance test.** `tests/turing-lecture.txt` is the exact Turing machine lecture that exposed the v0.1 pasting problem. The rebuilt deck has a title slide, five idea slides (hierarchy, tape and alphabet, tape operations, control and halting, formal definition) and a summary, with no timestamps or fillers anywhere and every claim passing the fact checker. The Node suite asserts all of it on both paths: the deterministic deck (garble guard, restated summary) and a stubbed-model deck through the real `set_outline` flow (clean 7-tuple, no garbled lines, restated summary, complete sentences), with no API key used anywhere. The Playwright suite builds the Turing deck in the real page and asserts the same guard and summary.

## Build deck, rate limits, and the token budget

**A failed model call is never silent.** If the key is set but the model call fails (bad key, provider error, rate limit), the page says the model call failed and why, and shows the deterministic deck with a plain note that it is the deterministic deck, never as the model's work. The same loud fallback applies when a model turn finishes without writing an outline. The outline records which path wrote it, so the page can tell the two apart.

**429s are retried after the full suggested wait.** When a provider answers 429, the client waits the longest delay the provider suggests (the Retry-After header and the body's "try again in Xs" phrase can disagree; the shorter one used to win and earn another 429) and retries, up to two retries per call. A retried 429 never flashes a "not verified" error: the trace span stays open across retries, and the key is verified only by a call that actually succeeds. This is a local change to the vendored runtime (`runtime/llm.js`): re-copy the runtime from upstream with care, or the retry goes with it.

**The turn is trimmed to fit the free tier, and it still does not fit on Groq's.** A full Turing turn makes 13 model calls (the producer makes seven, re-sending its history each time), and the Groq free tier allows 8,000 tokens per minute. Measured live in headless Chromium with a stubbed provider (`tests/measure-turn.mjs`, no key, no network): the turn was ~81,300 tokens before the trims and ~59,100 after. What was cut: the `render_cruse` tool is gone (DeckCast never used it), the grounding rules were compressed, the transcript excerpt is no longer appended to any agent's instructions (agents that need it read it with `get_lecture_state`), the set_outline description was shortened, and the producer instructions fell from ~5,200 to ~3,600 characters expanded. The first two calls fell from ~4,200 + ~4,800 to ~2,400 + ~2,900 tokens, so the turn now gets past the point where it used to fail, but the later producer calls still run ~9,000 tokens each and the turn total is still about seven times the budget. The 90-second turn deadline rules out spreading the calls across minute windows. So on the Groq free tier the turn still hits the limit mid-turn, the retry absorbs what it can, and the page falls back loudly to the deterministic deck. A provider or tier with a higher per-minute budget is what makes the full model turn complete; the deterministic deck is the working fallback until then.

## Whisper transcription

Uploaded audio and microphone recordings in browsers without live speech recognition are transcribed on the device with Whisper (tiny, quantized, English-only) via transformers.js. The model is not vendored in the repo: the 30.7 MB decoder file is over GitHub's 25 MB web-upload limit, so it cannot be pushed through any GitHub route, and the model instead downloads from Hugging Face (huggingface.co, large files served from its CDN) the first time you transcribe. The download is about 44 MB in total, and the browser caches it for the next visit. The request is a download only: no audio, transcript, or key is sent anywhere, and the transcription itself runs on your device. The transformers.js library and the ONNX runtime wasm stay vendored in `vendor/`. Progress shows model download first, then transcription. Measured in headless Chromium: a 33.6 second recording transcribed in 11.6 seconds, about 0.34x real time. The automated tests stub the transcription library (see `TESTING.md`); a real run is a manual step.

## Quiz peer

DeckCast delegates to one sibling network in the same repo, a quiz generator (`quiz_generator.hocon`, `quiz_generator.network.json`): given the lecture topic, slide titles and a short transcript excerpt, it writes multiple-choice quiz questions. The producer calls it by its public URL only after the visitor agrees in chat; the same-origin call gets no runtime consent card, so the producer must ask first. The quiz generator receives only the request text, never the chat history and never private context, and `sly_data` is deny-by-default across the boundary. The manifest peer policy stays closed: no other peer networks are called.

## Export themes

The exported .pptx has its own theme, picked in the **Export theme** menu next to the Export button. The site stays cream and blue; the export is independent:

- **Cream** (default): the site palette, cream background, dark brown ink, baby blue accent.
- **Light**: white background, dark ink, a restrained steel-blue accent.
- **Dark**: deep brown-charcoal background, light cream text, baby blue accent.

The on-screen preview shows the chosen theme, so what you see is what the .pptx will look like, including the diagram slides. Your last choice is remembered in localStorage. Every text pair in every theme passes WCAG AA (4.5:1); the tests assert the ratios and read the colours back out of the exported .pptx files.

## Design

Brown and cream plus baby blue. Paper `#F3E9D7`, card `#FAF6EF`, ink `#2B1D12`, muted brown `#6B5847`, baby blue `#8EC8EE` (ink text on it), soft tint `#E8F1F8`, borders `#E3D9CB`. Colours are defined in OKLCH with hex fallbacks. The baby-blue call to action is the only saturated colour on the site; cream stays the dominant field, blue is the accent. Fonts are self-hosted IBM Plex Sans, no Google Fonts. No em dashes in user-visible text (the Bring your own key section above is the one exception, kept verbatim), no emojis in the UI, no gradients, no Inter, no Lucide.

## What's in v0.2

- Paste a transcript, load the sample lecture, record with the microphone, or upload an audio file: uploaded audio is transcribed on the device with Whisper, with model download and transcription progress, a retry button, and playback.
- Microphone beyond Chrome and Edge: browsers without live speech recognition record with MediaRecorder and transcribe with Whisper after stopping.
- Deck quality: cleaned transcripts, idea segmentation, rewritten titles and short bullets, speaker notes carrying the detail, model rewriting rules for grammar, ASR garbles and domain facts, a readability guard and a restated summary on the deterministic path, and the Turing lecture acceptance test on both paths. The Build deck button routes through the model when a key is set and falls back loudly when the model call fails.
- Diagram slides: a process flow when the transcript states steps in order, and a bar chart when it states numbers for the same unit, drawn as inline SVG in the browser and as shapes in the .pptx, and fact checked like any other slide.
- A real peer network: the quiz generator sibling network, delegated to with the visitor's agreement in chat.
- Export themes: Cream, Light and Dark for the .pptx, with a themed preview and the choice remembered.
- Deterministic outline and deck building: every bullet comes from a transcript sentence and keeps a link to its source sentence.
- Deterministic fact check: each bullet is checked against its source sentence, and failures are reported with slide and line. Model-written bullets are checked against the whole transcript.
- Slide rendering in the browser and real .pptx export (PptxGenJS, vendored locally in `vendor/`).
- The agent network boots in the browser from `agent-manifest.json` and `deckcast.network.json`, with the chat panel, the AI model settings panel, and the seven site actions wired in.
- Mobile layout, mobile menu, favicon, custom 404 page, and a Content Security Policy.
- Privacy and terms pages, sitemap and robots.txt, a social preview image, and Open Graph tags.
- A GitHub Actions workflow that runs the full test suite on every push.

## Not yet in v0.2

- **No real-model turn has completed in a browser yet.** A live run with a real provider key still needs to be done by hand; see `TESTING.md`. The Groq free tier (8,000 tokens per minute) still stops the turn mid-way on the Turing lecture: the button routes to the model and the retry waits out the provider's suggested delay, but the measured turn is ~59,000 tokens, so the page falls back loudly to the deterministic deck. A higher-budget provider or tier is the remaining step for a full model turn.

## Tests

```sh
npm test
```

That runs the Node suite (`node tests/run-tests.mjs`) and the Playwright end-to-end suite (`node tests/e2e.mjs`). Run them separately with `npm run test:unit` and `npm run test:e2e`. Run `npm install` first, once, for the Playwright driver (`playwright-core`).

## Commits

Commit messages read like a person wrote them: natural, varied, specific about what changed and why. No AI-sign-off wording, no emojis.

## Hosting

The site is static and assumes GitHub Pages project hosting at `https://ryannb01.github.io/DeckCast/`. That assumption is baked into the Open Graph URLs, the sitemap locations and the robots.txt Sitemap line. If hosting lands elsewhere, those URLs must change.

## License

MIT.
