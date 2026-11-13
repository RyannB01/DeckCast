# DeckCast

Turn a lecture into a slide deck. Paste or record a lecture, let the agents pull out the key points, build the slides, and check every claim against what was actually said. Then export the deck as a .pptx file.

Built for the [Open Agentic Web Challenge](https://cognizant-agenticweb.devpost.com/) (Cognizant, Devpost). Submissions close 11 January 2027.

## What it is

DeckCast is an open agentic website: a public site that publishes an agent network as data, runs that network in the visitor's browser, and lets the visitor bring their own AI provider key. It follows the [Open Agentic Web MVP spec](https://github.com/cognizant-ai-labs/agentic-web) (Profile 0.2).

A lecture goes in one of three ways: pasted transcript text, live microphone recording with in-browser speech recognition, or an uploaded audio file for playback. The agent network turns it into a deck:

1. **transcriber** explains how a lecture becomes a transcript here, and stores text the visitor pastes in chat.
2. **structure** reads the transcript and drafts the slide outline: title, one idea per slide, bullets and speaker notes.
3. **slide_designer** turns the outline into slide content: layout, concise slide text, simple visuals the page can draw.
4. **fact_checker** verifies every slide claim against the transcript and flags anything not grounded in it. No invented content, ever.

The front agent, **deckcast_producer**, orchestrates the four specialists and talks to the visitor. The agents act on the page through six site actions: `get_lecture_state`, `set_transcript`, `build_outline`, `render_slides`, `verify_deck`, `export_deck`.

## Run it locally

```sh
python3 -m http.server 8901
```

Then open http://127.0.0.1:8901/ in Chrome or Edge. No build step, no server code, no install.

The fastest demo: press **Load the sample lecture**, then **Build deck**, then **Export as .pptx**. The sample is a short lecture on photosynthesis in `sample-lecture.txt`.

## Bring your own key

By default the assistant runs in demo mode: it can build decks from the page, but its writing and fact checking use a demo model. For real model calls, add your own AI provider key in **AI model settings** in the assistant panel. The key is stored in your browser's localStorage only. It is sent only to the provider you choose, never to DeckCast, never to any peer site, and never into a URL or a file. Set a spending limit on the key with your provider before you use it.

## Privacy: no visitor data goes to a third party

- **Fonts are self-hosted.** The only webfont is IBM Plex Sans, served from `fonts/` on the same origin. No Google Fonts, no font CDN, nothing fetched from anywhere else. The font is under the SIL Open Font License 1.1. The CSP locks fonts to same origin (`font-src 'self'`).
- **No analytics, no trackers, no external scripts, styles or images.** Everything the page loads comes from the same origin: PptxGenJS is vendored in `vendor/`, the nsdeploy runtime lives in `runtime/`. The footer links (Devpost, spec repo, GitHub) are plain links; nothing loads from them until a visitor clicks.
- **The only outbound request the site ever makes is the visitor's own LLM call**, and only after they enter a key and send a chat message, and only to the provider they chose (one of four presets, or any OpenAI-compatible router they type in). The demo model makes no network calls at all.
- **Audited dead code in the vendored runtime.** The LangChain bundle in `runtime/generated/` contains a LangSmith telemetry client and a Mermaid.ink diagram renderer. Neither is reachable from DeckCast: no LangSmith key is configured and tracing is off by default, and no code path renders Mermaid diagrams. If either ever fired it would be a bug, and the end-to-end test would catch it: it logs every request the page makes and fails if any host other than the site itself is contacted.
- **Peer networks are closed and MCP is unavailable**, so the runtime's peer-fetch and MCP paths are never exercised by this network, and the network defines no REST tools.
- **Why the CSP allows any HTTPS host for connections.** `connect-src 'self' https:` is deliberately broad: BYOK lets the visitor type any OpenAI-compatible provider URL, so a fixed provider list would break custom routers. The enforcement is the network audit in `tests/e2e.mjs`, not the CSP allowlist.
- **The deployed site sets no cookies.** The runtime mirrors the BYOK profile to a same-site host cookie only on loopback hosts (localhost, 127.0.0.1), so settings follow across local ports while developing. That mirror never runs on the deployed site. See `privacy.html`.

## What works in v0.1

- Paste a transcript, load the sample lecture, or record with the microphone (Chrome or Edge) with live transcription and an audio recording kept for playback.
- Deterministic outline and deck building: every bullet comes from a transcript sentence and keeps a link to its source sentence.
- Deterministic fact check: each bullet is checked against its source sentence for word overlap, and failures are reported with slide and line.
- Slide rendering in the browser and real .pptx export (PptxGenJS, vendored locally in `vendor/`).
- The agent network boots in the browser from `agent-manifest.json` and `deckcast.network.json`, with the chat panel, the AI model settings panel, and the six site actions wired in.
- Mobile layout, mobile menu, favicon, custom 404 page, and a Content Security Policy.
- Skeleton loading states and designed empty states, so the page never shows a blank screen or a jumping layout.
- Privacy and terms pages, sitemap and robots.txt, a social preview image, and Open Graph tags.
- A GitHub Actions workflow that runs the full test suite on every push; a red build blocks the release.

## What is stubbed or missing in v0.1

- **Uploaded audio is not transcribed.** Audio files are stored for playback only. Transcription of uploaded files (Whisper in the browser) is a later version. The page says this plainly where the file input is.
- **No diagram slides yet.** The slide designer can suggest simple diagrams in chat, but the renderer only draws title, bullet and summary slides.
- **No peer networks.** The manifest declares a closed peer policy. Cross-site agent calls are a later version.
- **No real-model test has run in a browser yet.** The network was validated by the build script and by Node tests, and the site was tested end to end in headless Chromium in demo mode. A live run with a real provider key still needs to be done by hand; see `TESTING.md`.
- **The microphone needs Chrome or Edge.** Other browsers get a clear message and the paste path instead.

## Project layout

- `index.html`, `styles.css`, `deck.js` - the page, its styling, and its logic.
- `fonts/` - IBM Plex Sans (variable weight, latin subset), self-hosted. See the Privacy section.
- `deckcast-core.js` - the pure pipeline: transcript to outline to slides to .pptx. No DOM, so Node tests can import it.
- `deckcast.hocon` - the network authoring source. The published file is built from it.
- `deckcast.network.json` - the resolved network definition, built by the skill's `build_network.mjs` script. Do not edit by hand; edit `deckcast.hocon` and rebuild.
- `agent-manifest.json`, `links.json`, `agent-mcp.json` - the public agent artifacts. The `.well-known/` and `bridge/` files are generated by the same build script.
- `deckcast-actions.js` - the six site actions the agents call.
- `site.js` - boots the runtime and feeds the agents the current lecture state.
- `runtime/` - the nsdeploy browser runtime (Apache 2.0, see `runtime/LICENSE.txt`), copied from the agentic-web repo with one local deviation: 30 user-visible strings in `runtime/ui.js`, `runtime/llm.js`, `runtime/model.js` and `runtime/action-transport.js` were edited to remove emoji and em dashes from text the visitor sees. Comments were left alone. If the runtime is re-copied from upstream, re-apply the patch and re-run the tests. The patch is verified by `node --check` on all four files and by the end-to-end test (57 checks, green).
- `vendor/pptxgen.bundle.js` - PptxGenJS 3.12.0 for .pptx export.
- `sample-lecture.txt` - a short lecture on photosynthesis for testing and demo.
- `tests/` - Node tests (`tests/run-tests.mjs`, 159 checks) and the Playwright end-to-end test (`tests/e2e.mjs`, 57 checks). One command runs both: `npm test`.
- `privacy.html`, `terms.html`, `robots.txt`, `sitemap.xml`, `og-image.png`, `favicon.svg`, `404.html`, `_headers` - the pre-launch pages and files. See the checklist below.
- `.github/workflows/ci.yml` - GitHub Actions: on every push and pull request, install, run the tests, ship only if green.

## Rebuilding the network

```sh
node /tmp/build/skill/scripts/build_network.mjs deckcast.hocon --manifest agent-manifest.json --runtime ./runtime --out deckcast.network.json
```

The script checks the network and writes the discovery files. It must exit with no errors and no warnings. The build script lives in the agentic-web skill, not in this repo.

## Tests

```sh
npm test
```

That runs the Node suite (`node tests/run-tests.mjs`, 159 checks) and the Playwright end-to-end suite (`node tests/e2e.mjs`, 57 checks). Run them separately with `npm run test:unit` and `npm run test:e2e`. `npm install` first, once, for the Playwright driver (`playwright-core`).

The Node tests cover the pipeline on the sample lecture and on a second lecture (water cycle), the .pptx export, the network and manifest structure, each agent's invocation schema, the self-hosted font, the absence of third-party hosts, the palette contrast ratios, the pre-launch pages, and scans for em dashes and secrets. The end-to-end test drives the real page in headless Chromium: paste a transcript, build the deck, export a real .pptx, upload audio, exercise the mic fallback, boot the assistant in demo mode, check the mobile layout at 390px, and audit the network (every request must stay on the site's own origin, the font must load locally, and the only failed request may be the intentional 404 page). It also records performance: page load about 410 ms, deck build about 75 ms, roughly 884 KB transferred on a local server. See `TESTING.md` for the manual real-model test.

## Palette

Brown and cream with one baby blue. The baby blue call to action is the only saturated colour on the page: squint at it and the button is the one thing still visible.

| Role | Hex | OKLCH |
| --- | --- | --- |
| Paper / cream background | #FAF6EF | oklch(97.4% 0.010 82) |
| Ink, primary text | #2B1D12 | oklch(24.5% 0.029 59) |
| Muted brown text | #6B5847 | oklch(47.5% 0.036 64) |
| Baby blue, primary action | #8EC8EE | oklch(80.7% 0.081 238) |
| Soft blue tint, secondary surfaces | #E8F1F8 | oklch(95.3% 0.013 241) |
| Borders, warm grey-brown | #E3D9CB | oklch(88.9% 0.022 77) |

The stylesheet defines colours in OKLCH with the hex values as fallbacks. Contrast ratios, all passing WCAG AA: ink on paper 15.14:1, muted on paper 6.26:1, ink on baby blue 9.05:1, ink on soft tint 14.27:1, muted on soft tint 5.90:1, ink on white 16.31:1, muted on white 6.75:1. Non-text boundaries needed stronger colours: the primary button carries a darker blue border #4A7BA6 (4.17:1 against paper) and form controls use a stronger warm brown border #8A7B68 (4.11:1 against white). The ratios are asserted in `tests/run-tests.mjs`.

No red or amber is used anywhere. Errors are conveyed by wording and bold weight, never by colour alone, so the blue button stays the only saturated element. The .pptx export uses the same palette (cream title slides, white content slides, baby blue top bar, ink text).

Two palettes were considered and rejected: sage with off-white and tomato red (red reads as error or danger on a tool's primary action, and it is too close to SafeSignal's signal red), and grey with silver and yellow (grey is boring by the reel's own verdict, and yellow is the weakest for contrast).

## Design craft

Applied from the design-terms reel, as rules in the stylesheet and markup:

- **Tinted neutrals.** Warm-tinted neutrals for surfaces and borders, never flat default grey. The runtime's cool-grey fallbacks are overridden on the assistant panel.
- **OKLCH.** The palette is defined in OKLCH (see above) so equal lightness looks equal.
- **Skeleton screens.** Static placeholder shapes hold the layout while content loads: transcript skeleton during sample fetch, skeleton lines in the mic box while listening, skeleton slide cards during deck build, an assistant skeleton inside the chat panel until the runtime boots.
- **Empty states.** The transcript view ("No transcript yet") and the deck ("No deck yet") show a heading and guidance in a dashed box before there is any content. The mic box shows a hint when idle.
- **Touch targets.** Buttons are at least 44px tall; nav links and the brand are at least 44px with padding; the runtime's chat buttons are overridden to the same.
- **Safe area.** The viewport declares `viewport-fit=cover` and padding uses `env(safe-area-inset-*)` so content clears the notch and home bar.
- **Layout shift.** Skeletons and minimum heights hold the layout while things load. The font uses `font-display: swap` without size-adjust tuning, which is a known gap.
- **Line length.** Reading areas are capped near 65 characters.
- **Ease-out.** Slide cards enter with a 240ms ease-out keyframe, staggered 40ms apart and capped at 320ms. Rebuilding replaces the cards, interrupting any entrance still running. All animation is disabled under `prefers-reduced-motion`. Nothing animates on scroll.
- **Progressive disclosure.** The mic and upload controls sit in a collapsed details block; the runtime's model settings are a collapsed details block too.
- **Affordance.** Verb-first button labels, bordered buttons with hover states, labelled inputs, focus-visible outlines.
- **Typography.** IBM Plex Sans, chosen partly for its large x-height. Letter spacing and line height are set deliberately; headings are balanced, paragraphs use pretty wrapping with orphans and widows set to 3; timers and counters use tabular numbers; text is optically centred where it is centred (only the slide-number circles are centred, flex-centred single glyphs).

The reel's remaining terms are vocabulary, not rules applied here.

## Pre-launch checklist

1. Privacy policy page: done (`privacy.html`).
2. Terms and conditions page: done (`terms.html`).
3. Secrets off the frontend: done. A secret scan runs in the Node tests; nothing has been pushed from here yet.
4. Force HTTPS: done as far as static files allow. HSTS in `_headers` plus `upgrade-insecure-requests` in the CSP meta and in `_headers`. Hosting assumption: GitHub Pages, which serves HTTPS by default (see Hosting below).
5. Cookie consent banner: not applicable. The deployed site sets no cookies; the privacy page states that instead of a banner.
6. Meta titles and descriptions on every page: done for index, 404, privacy and terms. The generated `bridge/action-bridge.html` is a machine-facing hidden iframe page marked `noindex`; left as is.
7. Social preview image: done (`og-image.png`, 41 KB, plus Open Graph and Twitter card tags).
8. Favicon: done (`favicon.svg`, baby blue).
9. Sitemap and robots.txt: done.
10. Alt text on all images: not applicable. There are no content `<img>` tags on the site (the favicon is a link, the preview image is meta). The runtime renders a logo image only if a theme logo is set; none is.
11. Compress images: done. The favicon is 399 bytes; the preview image is 41 KB of flat design.
12. Page load speed: measured in the end-to-end test. Page load about 410 ms, deck build about 75 ms, roughly 884 KB transferred on a local server.
13. Colour contrast: done. Ratios are listed under Palette and asserted in the tests.
14. Mobile friendly: done. Responsive layout, tested at 390px with no horizontal overflow.
15. Custom 404 page: done (`404.html`).
16. Broken links: verified by curl on 13 November 2026. The OpenAI API keys page returns 403 to bots but is the standard page, not a broken link.
17. Form validation: done. Every input validates with a clear error message: empty transcript, bad or oversized audio file, mic denied or unsupported, missing key or router, exporting with no deck, building with no transcript. The title has a 120-character limit; the file input accepts audio only.
18. Spam protection: not applicable. There is no public form, no comments, no submission to a server.
19. Analytics: decided, ship without. No analytics code exists. A static site has no server to self-host analytics on, and any third-party analytics would send visitor data out without consent, which the privacy rules for this project forbid. Stated in the privacy page.
20. One clear call to action: done. Exactly one primary button on the page: **Build deck**.

## Hosting

The site is static and assumes GitHub Pages project hosting at `https://ryannbinoy.github.io/DeckCast/`. That assumption is baked into the Open Graph URLs, the sitemap locations and the robots.txt Sitemap line. If hosting lands elsewhere, those URLs must change. The deployment itself has not happened yet; nothing in this repo has been pushed to GitHub.

## Commit messages

Write them the way a real developer would: natural, varied, specific about what changed and why. No robotic templates, no AI sign-off wording, no emojis. For example: "wire up slide export, finally", "fix the transcript view breaking on long lectures", "first pass at the fact checker".

## Security notes

- No API keys anywhere in the repo or its history. Keys live in the visitor's browser localStorage only.
- All user text and model output is rendered with `textContent`, never `innerHTML`, so a transcript cannot inject markup.
- Audio uploads are checked for type and size (audio only, 50 MB max) and are never sent anywhere; they stay on the page for playback.
- A Content Security Policy is set both as a meta tag and in `_headers` for hosts that read it. It allows scripts and styles from this site only, LLM calls to the visitor's chosen provider over HTTPS, and blob workers for the runtime sandbox.
- Production hosting must be HTTPS. GitHub Pages serves HTTPS by default.
