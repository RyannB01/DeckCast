// tests/run-tests.mjs - DeckCast v0.1 checks. Run: node tests/run-tests.mjs
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
  splitSentences,
  stripTimestamps,
} from "../deckcast-core.js";

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
check("outline slide count in range 5-10", outline.slides.length >= 5 && outline.slides.length <= 10, `got ${outline.slides.length}`);
const bullets = outline.slides.flatMap((s) => s.bullets);
check("outline has bullets", bullets.length >= 9, `got ${bullets.length}`);
check("no bullet longer than 200 chars", bullets.every((b) => b.text.length <= 200));
check("every bullet has a source sentence", bullets.every((b) => Number.isInteger(b.source) && b.source >= 0 && b.source < sentences.length));
check("bullet text appears in its source sentence", bullets.every((b) => {
  const src = sentences[b.source] || "";
  const firstWord = b.text.split(/\s+/)[0].replace(/[^A-Za-z]/g, "");
  return firstWord.length < 3 || src.includes(b.text.slice(0, 40)) || src.toLowerCase().includes(b.text.slice(0, 20).toLowerCase());
}));

const slides = buildSlides(outline);
check("slides built with unique ids", new Set(slides.map((s) => s.id)).size === slides.length);
check("slide types valid", slides.every((s) => ["title", "content", "summary"].includes(s.type)));

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
for (const t of network.tools) for (const d of t.tools || []) if (!agentNames.includes(d)) dangling.push(`${t.name} -> ${d}`);
check("no dangling agent references", dangling.length === 0, dangling.join("; "));
check("every agent has instructions", network.tools.every((t) => t.instructions && t.instructions.length > 100));
check("every agent has an invocation schema", network.tools.every((t) => t.function && t.function.parameters && t.function.parameters.properties.request));
check("fact checker forbids invented content", network.tools.find((t) => t.name === "fact_checker").instructions.includes("No invented content, ever."));
check("manifest names the network", manifest.networks[0].name === "deckcast");
check("manifest front agent matches network", manifest.networks[0].front_man === "deckcast_producer");
check("manifest hocon points at the network file", manifest.networks[0].hocon === "./deckcast.network.json" && existsSync(path.join(ROOT, "deckcast.network.json")));
check("manifest router is mock by default", manifest.llm_router.mock === true && manifest.llm_router.base_url === "browser://mock");
check("manifest byok router is OpenAI-compatible", manifest.llm_router.byok_router === "https://api.openai.com/v1");
const actionNames = ["get_lecture_state", "set_transcript", "build_outline", "render_slides", "verify_deck", "export_deck"];
check("manifest lists all six site actions", actionNames.every((a) => manifest.actions.agentTools.includes(a)));
const actionsSrc = readFileSync(path.join(ROOT, "deckcast-actions.js"), "utf8");
check("actions module registers all six actions", actionNames.every((a) => actionsSrc.includes(`name: "${a}"`)));
check("links.json names the network", JSON.parse(readFileSync(path.join(ROOT, "links.json"), "utf8")).networks.deckcast !== undefined);
check("agent-mcp.json names the network", JSON.parse(readFileSync(path.join(ROOT, "agent-mcp.json"), "utf8")).network === "deckcast");

// ---- 4. No em dashes in user-visible copy ------------------------------------
const EM_DASH = "\u2014";
const visibleFiles = ["index.html", "deck.js", "site.js", "deckcast-actions.js", "404.html", "README.md"];
for (const f of visibleFiles) {
  if (!existsSync(path.join(ROOT, f))) { check(`${f} exists`, false); continue; }
  const text = readFileSync(path.join(ROOT, f), "utf8");
  check(`no em dash in ${f}`, !text.includes(EM_DASH));
}

// ---- 5. No secrets ------------------------------------------------------------
const secretPatterns = [/sk-[A-Za-z0-9]{10,}/, /api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
const codeFiles = ["index.html", "deck.js", "deckcast-core.js", "deckcast-actions.js", "site.js", "deckcast.network.json", "deckcast.hocon", "agent-manifest.json", "styles.css", "sample-lecture.txt"];
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
const noSource = JSON.parse(JSON.stringify(slides));
noSource[1].bullets[0].source = null;
check("verifyDeck fails a bullet with no source sentence", verifyDeck(sample, noSource).ok === false);
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
  buildOutline as pageBuildOutline,
  renderSlides as pageRenderSlides,
  verifyDeckAction,
  clearTranscript,
  exportDeck,
  getLectureState,
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
check("integration: outline built from the second lecture", wBuilt.ok === true && wBuilt.slides >= 4);
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
const PALETTE = { paper: "#FAF6EF", ink: "#2B1D12", muted: "#6B5847", blue: "#8EC8EE", tint: "#E8F1F8", borderStrong: "#8A7B68", blueDark: "#4A7BA6" };
for (const [name, fg, bg, need] of [
  ["ink on paper", PALETTE.ink, PALETTE.paper, 4.5],
  ["muted on paper", PALETTE.muted, PALETTE.paper, 4.5],
  ["ink on baby blue", PALETTE.ink, PALETTE.blue, 4.5],
  ["ink on soft tint", PALETTE.ink, PALETTE.tint, 4.5],
  ["muted on soft tint", PALETTE.muted, PALETTE.tint, 4.5],
  ["ink on white", PALETTE.ink, "#FFFFFF", 4.5],
  ["muted on white", PALETTE.muted, "#FFFFFF", 4.5],
  ["strong border on white", PALETTE.borderStrong, "#FFFFFF", 3],
  ["dark blue border on paper", PALETTE.blueDark, PALETTE.paper, 3],
]) {
  const r = contrastRatio(fg, bg);
  check(`contrast: ${name} (${r.toFixed(2)}:1, needs ${need}:1)`, r >= need);
}
check("palette is defined in OKLCH in the stylesheet", ["97.4%", "24.5%", "47.5%", "80.7%", "95.3%", "88.9%"].every((v) => css.includes(`oklch(${v}`)));
check("old green accent is gone from the stylesheet", !css.includes("#1F6B3A") && !css.includes("#1f6b3a"));
check("old red and amber are gone from the stylesheet", !css.includes("#C81E1E") && !css.includes("#B54708"));
check("manifest theme primary is the baby blue", manifest.theme.primary === "#8EC8EE");
const favicon = readFileSync(path.join(ROOT, "favicon.svg"), "utf8");
check("favicon uses the baby blue", favicon.includes("#8EC8EE") && !favicon.includes("#1F6B3A"));
const coreSrc = readFileSync(path.join(ROOT, "deckcast-core.js"), "utf8");
check("pptx export uses the new palette", coreSrc.includes('"2B1D12"') && coreSrc.includes('"8EC8EE"') && !coreSrc.includes('"1F6B3A"'));

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

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
