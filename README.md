# DeckCast

Turn a lecture into a slide deck. Paste or record a lecture, let the agents pull out the key points, build the slides, and check every claim against what was actually said. Then export the deck as a .pptx file.

Built for the [Open Agentic Web Challenge](https://cognizant-agenticweb.devpost.com/) (Cognizant, Devpost). Submissions close 11 January 2027.

## How it works

Give it a lecture in one of three ways: paste a transcript, record with your microphone, or upload an audio file for playback. Four specialist agents turn it into a deck:

- **transcriber** turns the lecture into a transcript and stores text you paste in chat.
- **structure** reads the transcript and drafts the slide outline: title, one idea per slide, bullets and speaker notes.
- **slide_designer** turns the outline into slide content: layout, concise slide text and simple visuals.
- **fact_checker** verifies every slide claim against the transcript and flags anything not grounded in it. No invented content, ever.

The front agent, **deckcast_producer**, orchestrates the four specialists and talks to you. The agents act on the page through six site actions: `get_lecture_state`, `set_transcript`, `build_outline`, `render_slides`, `verify_deck`, `export_deck`.

DeckCast is an open agentic website: the agent network is published as data (`agent-manifest.json`, `deckcast.network.json`), runs in your browser, and follows the [Open Agentic Web MVP spec](https://github.com/cognizant-ai-labs/agentic-web) (Profile 0.2).

## Run it locally

```sh
python3 -m http.server 8901
```

Then open http://127.0.0.1:8901/ in Chrome or Edge. No build step, no server code, no install.

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
- **No analytics, no trackers, no external scripts, styles or images.** Everything the page loads comes from the same origin: PptxGenJS is vendored in `vendor/`, the nsdeploy runtime lives in `runtime/`.
- **The only outbound request the site ever makes is your own LLM call**, and only after you enter a key and send a chat message, and only to the provider you chose. The demo model makes no network calls at all.
- **The deployed site sets no cookies.**

## What's in v0.1

- Paste a transcript, load the sample lecture, or record with the microphone (Chrome or Edge) with live transcription and an audio recording kept for playback.
- Deterministic outline and deck building: every bullet comes from a transcript sentence and keeps a link to its source sentence.
- Deterministic fact check: each bullet is checked against its source sentence, and failures are reported with slide and line.
- Slide rendering in the browser and real .pptx export (PptxGenJS, vendored locally in `vendor/`).
- The agent network boots in the browser from `agent-manifest.json` and `deckcast.network.json`, with the chat panel, the AI model settings panel, and the six site actions wired in.
- Mobile layout, mobile menu, favicon, custom 404 page, and a Content Security Policy.
- Privacy and terms pages, sitemap and robots.txt, a social preview image, and Open Graph tags.
- A GitHub Actions workflow that runs the full test suite on every push.

## Not yet in v0.1

- **Uploaded audio is not transcribed.** Audio files are stored for playback only. Transcription of uploaded files (Whisper in the browser) is a later version.
- **No diagram slides yet.** The slide designer can suggest simple diagrams in chat, but the renderer only draws title, bullet and summary slides.
- **No peer networks.** The manifest declares a closed peer policy. Cross-site agent calls are a later version.
- **No real-model test has run in a browser yet.** A live run with a real provider key still needs to be done by hand; see `TESTING.md`.
- **The microphone needs Chrome or Edge.** Other browsers get a clear message and the paste path instead.

## Tests

```sh
npm test
```

That runs the Node suite (`node tests/run-tests.mjs`) and the Playwright end-to-end suite (`node tests/e2e.mjs`). Run them separately with `npm run test:unit` and `npm run test:e2e`. Run `npm install` first, once, for the Playwright driver (`playwright-core`).

## Hosting

The site is static and assumes GitHub Pages project hosting at `https://ryannb01.github.io/DeckCast/`. That assumption is baked into the Open Graph URLs, the sitemap locations and the robots.txt Sitemap line. If hosting lands elsewhere, those URLs must change.

## License

MIT.
