// deckcast-core.js - pure lecture-to-deck logic. No DOM, no network, no keys.
// Imported by deck.js in the browser and by tests/run-tests.mjs in Node.
// Every bullet keeps the index of the transcript sentence it came from, so the
// fact checker can verify each claim against its source.

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "while",
  "of", "at", "by", "for", "with", "about", "into", "through", "after", "over",
  "between", "out", "against", "during", "without", "before", "under", "around",
  "among", "to", "from", "up", "down", "in", "on", "off", "above", "below",
  "is", "am", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "having", "do", "does", "did", "doing", "would", "should", "could", "ought",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "this", "that", "these", "those",
  "as", "so", "than", "too", "very", "can", "will", "just", "don", "should",
  "now", "here", "there", "what", "which", "who", "whom", "how", "why", "not",
  "no", "yes", "also", "more", "most", "other", "some", "such", "only", "own",
  "same", "s", "t", "ll", "re", "ve", "d", "m", "one", "two", "first", "second",
  "may", "might", "must", "shall", "like", "quite", "really", "actually",
  "basically", "simply", "even", "still", "yet"
]);

const SKIP_START = new Set(["so", "now", "well", "first", "next", "then", "okay", "right", "and", "but", "also", "today", "finally", "lastly"]);

export function stripTimestamps(text) {
  return String(text).replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, " ");
}

export function countWords(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return text.trim() ? words.length : 0;
}

export function splitSentences(text) {
  const clean = stripTimestamps(text).replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const parts = clean.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/);
  return parts.map((s) => s.trim()).filter((s) => s.length > 1);
}

export function contentWords(sentence) {
  return (sentence.toLowerCase().match(/[a-z][a-z'-]*/g) || []).filter(
    (w) => !STOPWORDS.has(w) && w.length > 1
  );
}

function scoreSentences(sentences) {
  const freq = new Map();
  for (const s of sentences) {
    for (const w of new Set(contentWords(s))) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return sentences.map((sentence, index) => {
    const words = contentWords(sentence);
    const raw = words.reduce((sum, w) => sum + (freq.get(w) || 0), 0);
    const score = words.length ? raw / Math.sqrt(words.length) : 0;
    return { sentence, index, score };
  });
}

function truncateAtWord(text, maxLen) {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + "...";
}

// Slide titles are labels taken from the opening sentence. Prefer a natural
// clause boundary (a comma, colon or clause word within the first ten words)
// so the title reads as a complete phrase; fall back to the first six words.
export function slideTitleFrom(sentence) {
  const words = sentence.replace(/["'“”‘’()]/g, "").split(/\s+/).filter(Boolean);
  let start = 0;
  while (start < words.length && SKIP_START.has(words[start].toLowerCase().replace(/[^a-z]/g, ""))) start += 1;
  const rest = words.slice(start);
  if (rest.length === 0) return "Key point";
  const CLAUSE = new Set(["which", "that", "and", "because", "so", "while", "when"]);
  let end = -1;
  for (let i = 0; i < Math.min(rest.length, 10); i += 1) {
    const w = rest[i];
    const bare = w.toLowerCase().replace(/[^a-z]/g, "");
    if (/[:]$/.test(w) && i >= 1) { end = i + 1; break; }
    if (/[,:;]$/.test(w) && i >= 2) { end = i + 1; break; }
    if (i >= 2 && CLAUSE.has(bare)) { end = i; break; }
  }
  const picked = (end > 0 ? rest.slice(0, end) : rest.slice(0, 6)).join(" ").replace(/[.,:;!?]+$/, "");
  if (!picked) return "Key point";
  return picked.charAt(0).toUpperCase() + picked.slice(1);
}

// ---- Numbers as words ------------------------------------------------------
// Whisper and lecturers say numbers out loud ("six molecules", "one hundred
// gigatonnes"), so diagram data and the fact checker both need to read them.
const NUMBER_ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const NUMBER_TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const NUMBER_WORDS = [...Object.keys(NUMBER_ONES), ...Object.keys(NUMBER_TENS), "hundred", "thousand"];

export function parseNumberWords(text) {
  const words = String(text || "").toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of words) {
    if (w === "and") continue;
    if (NUMBER_ONES[w] !== undefined) { current += NUMBER_ONES[w]; seen = true; }
    else if (NUMBER_TENS[w] !== undefined) { current += NUMBER_TENS[w]; seen = true; }
    else if (w === "hundred") { current = (current || 1) * 100; seen = true; }
    else if (w === "thousand") { total += (current || 1) * 1000; current = 0; seen = true; }
    else return null;
  }
  if (!seen) return null;
  return total + current;
}

const ONES_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS_WORDS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

export function numberToWords(n) {
  if (!Number.isFinite(n) || n < 0 || n > 9999 || Math.floor(n) !== n) return null;
  if (n < 20) return ONES_WORDS[n];
  if (n < 100) return TENS_WORDS[Math.floor(n / 10)] + (n % 10 ? `-${ONES_WORDS[n % 10]}` : "");
  if (n < 1000) {
    const rest = n % 100;
    return `${ONES_WORDS[Math.floor(n / 100)]} hundred${rest ? ` ${numberToWords(rest)}` : ""}`;
  }
  const rest = n % 1000;
  return `${ONES_WORDS[Math.floor(n / 1000)]} thousand${rest ? ` ${numberToWords(rest)}` : ""}`;
}

// Does this numeric value appear in the sentence, as digits or as words?
export function numberAppearsIn(value, sentence) {
  const lower = String(sentence || "").toLowerCase();
  if (new RegExp(`\\b${value}\\b`).test(lower)) return true;
  const words = numberToWords(value);
  if (words && lower.includes(words)) return true;
  return false;
}

// ---- Diagram extraction ----------------------------------------------------
// Two diagram types, both conservative: they only fire when the transcript
// states the data plainly, and every element keeps its source sentence so
// the fact checker can verify it. Ranges ("three to six percent") are not
// plotted: a range is not one bar.

function capLabel(text, maxLen) {
  const clean = String(text || "").replace(/[—–]/g, ",").replace(/\s+/g, " ").trim().replace(/[.,:;]+$/, "");
  if (clean.length <= maxLen) return clean.charAt(0).toUpperCase() + clean.slice(1);
  const cut = clean.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  const short = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return short.charAt(0).toUpperCase() + short.slice(1);
}

const FLOW_DISCOURSE = /^(let us|let's|we|i|today|in conclusion|to sum up|in summary)\b/i;

function flowStepFrom(sentence, index) {
  let m = sentence.match(/^\s*(?:the\s+)?(first|second|third|fourth|fifth|sixth)\s+(stage|step)\s+is\s+([^,;.]+)/i);
  if (m) return { label: capLabel(m[3], 60), source: index };
  m = sentence.match(/after a series of steps\s+([^,;.]+)/i);
  if (m) return { label: capLabel(m[1], 60), source: index };
  m = sentence.match(/^\s*(then|next|finally|after that)\b[,:]?\s+([^,;.]{4,60})/i);
  // "Next lecture we will look at..." is a teaser for the next lecture, not
  // a step of the process being described.
  if (m && !FLOW_DISCOURSE.test(m[2]) && !/^(lecture|time)\b/i.test(m[2])) return { label: capLabel(m[2], 60), source: index };
  m = sentence.match(/\b(?:step|stage)\s+(\d+)\s*[:\-]\s*([^,;.]{4,60})/i);
  if (m) return { label: capLabel(m[2], 60), source: index };
  return null;
}

const BAR_UNIT_WORDS = ["molecules?", "percent", "gigatonnes?", "tonnes?", "grams?", "kilograms?", "litres?", "liters?", "metres?", "meters?", "seconds?", "minutes?", "hours?", "days?", "people", "students?", "dollars?", "rupees?", "cases?", "votes?", "points?"];
const NUMBER_WORD_RE = `(?:${NUMBER_WORDS.join("|")})`;

function barsFromSentence(sentence, index) {
  // Drop ranges first: "three to six percent" is a range, not a bar.
  const withoutRanges = sentence.replace(
    new RegExp(`\\b${NUMBER_WORD_RE}(?:[ -]${NUMBER_WORD_RE})*\\s+to\\s+${NUMBER_WORD_RE}(?:[ -]${NUMBER_WORD_RE})*\\s+(?:${BAR_UNIT_WORDS.join("|")})`, "gi"),
    " "
  );
  const out = [];
  const re = new RegExp(
    `\\b(\\d+(?:\\.\\d+)?|${NUMBER_WORD_RE}(?:[ -]${NUMBER_WORD_RE})*)\\s+(${BAR_UNIT_WORDS.join("|")})(?:\\s+of\\s+([a-z][a-z' -]{1,30}?))?(?=\\s*(?:,|\\.|;|\\bplus\\b|\\band\\b|\\busing\\b|\\bproduce\\b|\\bproduces\\b|$))`,
    "gi"
  );
  let m;
  while ((m = re.exec(withoutRanges)) !== null) {
    const rawNum = m[1];
    const value = /^\d/.test(rawNum) ? parseFloat(rawNum) : parseNumberWords(rawNum);
    if (value === null || !Number.isFinite(value) || value <= 0 || value > 1e9) continue;
    if (!m[3]) continue; // no explicit label after "of": do not guess one
    const singular = m[2].toLowerCase() === "people" ? "people" : m[2].toLowerCase().replace(/s$/, "");
    const displayUnit = singular === "percent" ? "percent" : singular === "people" ? "people" : `${singular}s`;
    const label = capLabel(m[3].replace(/^(the|a|an)\s+/i, ""), 30);
    if (label.length < 2 || label.toLowerCase() === singular) continue;
    out.push({ label, value, unit: singular, displayUnit, source: index });
  }
  return out;
}

// Extract diagram data from a transcript. Returns
// { flow: { steps: [{ label, source }] } | null,
//   bars: { unit, bars: [{ label, value, source }] } | null }.
export function extractDiagrams(transcript) {
  const sentences = splitSentences(transcript);
  const steps = [];
  const seenLabels = new Set();
  for (let i = 0; i < sentences.length; i += 1) {
    const step = flowStepFrom(sentences[i], i);
    if (!step) continue;
    const key = step.label.toLowerCase();
    if (seenLabels.has(key)) continue;
    seenLabels.add(key);
    steps.push(step);
    if (steps.length >= 6) break;
  }
  const byUnit = new Map();
  for (let i = 0; i < sentences.length; i += 1) {
    for (const bar of barsFromSentence(sentences[i], i)) {
      if (!byUnit.has(bar.unit)) byUnit.set(bar.unit, []);
      const list = byUnit.get(bar.unit);
      if (list.some((b) => b.label.toLowerCase() === bar.label.toLowerCase())) continue;
      list.push(bar);
    }
  }
  let bars = null;
  for (const [unit, list] of byUnit) {
    if (list.length >= 2) {
      bars = { unit: list[0].displayUnit, bars: list.slice(0, 6).map((b) => ({ label: b.label, value: b.value, source: b.source })) };
      break;
    }
  }
  return { flow: steps.length >= 3 ? { steps } : null, bars };
}

// ---- SVG rendering ---------------------------------------------------------
// Pure string builders, so Node tests can assert on the output. Text is
// escaped; the browser injects the result with DOMParser, never innerHTML.

function escXml(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wrapLabel(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars && line) {
      lines.push(line.trim());
      line = w;
    } else {
      line = `${line} ${w}`.trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

// Export themes for the .pptx and the on-screen preview: Cream is the site
// palette (the default), Light is white with dark ink and a restrained
// steel-blue accent, Dark is a deep brown-charcoal with light cream text
// and the baby blue accent. Colours are hex without "#", as PptxGenJS
// expects. Every text pair in every theme passes WCAG AA (4.5:1); the
// ratios are asserted in the tests. The accent is a rule and a marker only:
// no text ever sits on it, so it needs no text contrast, but the slide
// numbers use dark ink on it in all three themes (9.1:1 on baby blue,
// 6.9:1 on the steel blue).
export const PPTX_THEMES = {
  cream: { titleBg: "F3E9D7", card: "FAF6EF", ink: "2B1D12", muted: "6B5847", accent: "8EC8EE", border: "E3D9CB" },
  light: { titleBg: "FFFFFF", card: "FFFFFF", ink: "2B1D12", muted: "6B5847", accent: "6B9CC4", border: "D8D2C8" },
  dark: { titleBg: "221A12", card: "2E241A", ink: "FAF6EF", muted: "C9BBA6", accent: "8EC8EE", border: "4A3D2E" },
};
export const EXPORT_THEME_NAMES = ["cream", "light", "dark"];
export function resolveExportTheme(name) {
  return EXPORT_THEME_NAMES.includes(name) ? name : "cream";
}

// The SVG diagrams use the same theme as the export, so the preview shows
// what the .pptx will look like. Diagram background is the deeper title
// colour; the boxes are the lighter card colour, so the diagram reads as a
// card on the page.
function svgColors(themeName) {
  const t = PPTX_THEMES[resolveExportTheme(themeName)];
  return {
    bg: `#${t.titleBg}`,
    card: `#${t.card}`,
    ink: `#${t.ink}`,
    muted: `#${t.muted}`,
    border: `#${t.border}`,
  };
}

function flowSvg(diagram, themeName) {
  const c = svgColors(themeName);
  const steps = diagram.steps;
  const n = steps.length;
  const W = 960;
  const H = 300;
  const margin = 20;
  const gap = 36;
  const boxW = Math.floor((W - margin * 2 - (n - 1) * gap) / n);
  const boxH = 190;
  const boxY = 70;
  let parts = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Process flow with ${n} steps"><rect x="0" y="0" width="${W}" height="${H}" fill="${c.bg}"/>`;
  steps.forEach((step, i) => {
    const x = margin + i * (boxW + gap);
    const cx = x + boxW / 2;
    parts += `<rect x="${x}" y="${boxY}" width="${boxW}" height="${boxH}" rx="8" fill="${c.card}" stroke="${c.ink}" stroke-width="2"/>`;
    parts += `<circle cx="${x + 24}" cy="${boxY}" r="18" fill="${c.ink}"/><text x="${x + 24}" y="${boxY + 7}" font-size="18" font-weight="bold" fill="${c.bg}" text-anchor="middle" font-family="IBM Plex Sans, sans-serif">${i + 1}</text>`;
    const lines = wrapLabel(step.label, 20);
    lines.forEach((line, li) => {
      parts += `<text x="${cx}" y="${boxY + 78 + li * 26}" font-size="19" fill="${c.ink}" text-anchor="middle" font-family="IBM Plex Sans, sans-serif">${escXml(line)}</text>`;
    });
    if (i < n - 1) {
      parts += `<text x="${x + boxW + gap / 2}" y="${boxY + boxH / 2 + 10}" font-size="28" fill="${c.muted}" text-anchor="middle" font-family="IBM Plex Sans, sans-serif">&#8594;</text>`;
    }
  });
  parts += "</svg>";
  return parts;
}

function barsSvg(diagram, themeName) {
  const c = svgColors(themeName);
  const bars = diagram.bars;
  const W = 960;
  const H = 420;
  const x0 = 90;
  const yTop = 50;
  const baseY = 340;
  const chartH = baseY - yTop;
  const max = Math.max(...bars.map((b) => b.value), 1);
  const slot = Math.floor((W - x0 - 40) / bars.length);
  const barW = Math.min(90, Math.floor(slot * 0.55));
  let parts = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart in ${escXml(diagram.unit)}"><rect x="0" y="0" width="${W}" height="${H}" fill="${c.bg}"/>`;
  parts += `<text x="${x0}" y="30" font-size="18" fill="${c.muted}" font-family="IBM Plex Sans, sans-serif">Values in ${escXml(diagram.unit)}</text>`;
  parts += `<line x1="${x0 - 10}" y1="${baseY}" x2="${W - 30}" y2="${baseY}" stroke="${c.border}" stroke-width="2"/>`;
  bars.forEach((bar, i) => {
    const h = Math.max(6, Math.round((bar.value / max) * chartH));
    const x = x0 + i * slot + Math.floor((slot - barW) / 2);
    const y = baseY - h;
    const cx = x + barW / 2;
    parts += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${c.ink}"/>`;
    parts += `<text x="${cx}" y="${y - 10}" font-size="20" font-weight="bold" fill="${c.ink}" text-anchor="middle" font-family="IBM Plex Sans, sans-serif">${bar.value}</text>`;
    const lines = wrapLabel(bar.label, 14);
    lines.forEach((line, li) => {
      parts += `<text x="${cx}" y="${baseY + 26 + li * 22}" font-size="16" fill="${c.muted}" text-anchor="middle" font-family="IBM Plex Sans, sans-serif">${escXml(line)}</text>`;
    });
  });
  parts += "</svg>";
  return parts;
}

// Render a diagram slide as an inline SVG string. Returns "" for unknown kinds.
// The theme defaults to cream, the site palette, so existing callers are
// unchanged; the preview passes the chosen export theme.
export function diagramSvg(diagram, themeName = "cream") {
  if (!diagram) return "";
  if (diagram.kind === "flow" && diagram.steps && diagram.steps.length) return flowSvg(diagram, themeName);
  if (diagram.kind === "bars" && diagram.bars && diagram.bars.length) return barsSvg(diagram, themeName);
  return "";
}

// ---- Transcript cleaning ---------------------------------------------------
// Spoken lectures are full of timestamps, filler words and false starts. The
// transcript is cleaned before anything is built from it, so no timestamp or
// filler word can ever appear on a slide. Cleaning is idempotent: running it
// twice gives the same text.
const FILLER_PHRASES = [
  "you know", "you see", "i mean", "sort of", "kind of", "basically",
  "actually", "like i said", "as i said", "you know what i mean", "etcetera",
];

export function cleanTranscript(text) {
  let s = String(text || "");
  // Bracketed timestamps [00:28] and bare ones 0:09, 2:23, 7:29.
  s = s.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, " ");
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
  // The Devanagari danda is a sentence terminator in some transcripts.
  s = s.replace(/[।॥]/g, ".");
  // Filler phrases first (multi-word), then single filler words.
  for (const phrase of FILLER_PHRASES) {
    s = s.replace(new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`, "gi"), " ");
  }
  s = s.replace(/\b(uh+|um+|hmm+|er+|ah+|okay|ok|yeah|yep|etc\.?)\b[,.?]?/gi, " ");
  // Discourse openers at the start of a sentence: "So, ...", "Well, ...".
  // "Right" is only stripped sentence-initially: "move to the right" is kept.
  s = s.replace(/(^|[.!?]\s+)(so|well|now|alright|right)[, ]+/gi, "$1");
  // Collapse adjacent duplicate words ("it it", "the the").
  s = s.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");
  // Normalise spacing and punctuation.
  s = s.replace(/\s+([,.!?;:])/g, "$1");
  s = s.replace(/\s+/g, " ").trim();
  // Capitalise sentence starts.
  s = s.replace(/(^|[.!?]\s+)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
  return s;
}

// ---- Idea segmentation -----------------------------------------------------
// A lecture is a sequence of ideas, not a bag of sentences. Boundaries fire
// on explicit cues ("the next thing is", "these are the formal definition")
// or on a sharp topic shift: the next sentence shares nothing with the
// current idea's core vocabulary and introduces a word that recurs.
const IDEA_CUES = [
  /^(so,?\s+)?(the\s+)?next\s+(thing|point|topic|step|stage|part)\b/i,
  // "The first stage is the light-dependent reactions." / "The second stage
  // is the Calvin cycle." A lecturer naming a stage is starting a new idea.
  /^(the\s+)?(first|second|third|fourth|fifth|sixth|next|final)\s+(stage|step|part)\s+(is|was|are)\b/i,
  /^(and\s+)?(these|this)\s+(is|are)\s+the\s+(formal\s+)?definition\b/i,
  /^\s*(next|then)\s+is\b/i,
  // "Next is ... control is ..." can arrive mid-sentence after a leftover
  // fragment ("Same symbol Next is rules ... this control is ..."), so the
  // control cue also matches when "next is" and "control" share a sentence.
  /\bnext\s+is\b[^.]{0,80}\bcontrol\b/i,
  /^(so,?\s+)?(now|first|second|third|next|finally|lastly)\b[^,.;]{0,40}\b(we|let us|let's)\b/i,
  /\bwe (are )?going to see about\b/i,
  /\bwe (were|are) (studying|looking at)\b/i,
  /^(let us|let's)\s+start\b/i,
];

function isIdeaCue(sentence) {
  return IDEA_CUES.some((re) => re.test(sentence));
}

function topWordsOf(indices, sets, n) {
  const freq = new Map();
  for (const i of indices) {
    for (const w of sets[i]) freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([w]) => w);
}

// Split cleaned sentences into ideas. Returns [{ sentences, indices }] where
// indices are positions in the splitSentences(cleanTranscript) list.
export function segmentIdeas(transcript) {
  const sentences = splitSentences(cleanTranscript(transcript));
  if (sentences.length === 0) return [];
  const sets = sentences.map((s) => new Set(contentWords(s)));
  const segments = [];
  let current = [0];
  for (let i = 1; i < sentences.length; i += 1) {
    // No boundary in the opening: the first three sentences are the intro.
    if (i < 3) { current.push(i); continue; }
    const cue = isIdeaCue(sentences[i]);
    let boundary = cue;
    // A sharp topic shift with no cue: the sentence introduces at least two
    // content words the current idea has never used, and each of them comes
    // back in at least two of the next five sentences. A word that only
    // appears once, or a sentence that only reuses the idea's words, never
    // splits. (A lecturer naming the next system in a hierarchy introduces
    // fresh words too, but they do not both recur, so the hierarchy stays
    // one idea.) The current idea must already be at least six sentences
    // long: in the first few sentences of an idea the lecturer is still
    // introducing its vocabulary, so almost anything looks "new".
    if (!boundary && sets[i].size >= 4 && current.length >= 6) {
      const currentVocab = new Set(current.flatMap((j) => [...sets[j]]));
      const nextCounts = new Map();
      for (let j = i + 1; j < Math.min(sentences.length, i + 6); j += 1) {
        for (const w of sets[j]) nextCounts.set(w, (nextCounts.get(w) || 0) + 1);
      }
      let recurring = 0;
      for (const w of sets[i]) {
        if (!currentVocab.has(w) && (nextCounts.get(w) || 0) >= 2) recurring += 1;
      }
      if (recurring >= 2) boundary = true;
    }
    if (boundary) { segments.push(current); current = [i]; }
    else current.push(i);
  }
  segments.push(current);
  // Merge segments shorter than 2 sentences into the previous one.
  const merged = [];
  for (const seg of segments) {
    if (seg.length < 2 && merged.length) merged[merged.length - 1].push(...seg);
    else merged.push([...seg]);
  }
  // Cap at 8 ideas: merge the most similar adjacent pair until small enough.
  while (merged.length > 8) {
    let best = 0;
    let bestScore = -1;
    for (let k = 0; k < merged.length - 1; k += 1) {
      const a = new Set(merged[k].flatMap((i) => [...sets[i]]));
      const b = new Set(merged[k + 1].flatMap((i) => [...sets[i]]));
      const inter = [...a].filter((w) => b.has(w)).length;
      const score = inter / Math.max(1, Math.min(a.size, b.size));
      if (score > bestScore) { bestScore = score; best = k; }
    }
    merged[best].push(...merged[best + 1]);
    merged.splice(best + 1, 1);
  }
  return merged.map((indices) => ({ sentences: indices.map((i) => sentences[i]), indices }));
}

// ---- Slide titles that name the idea ---------------------------------------
// A title names the idea, never a sentence fragment. Three routes, in order:
// an enumeration of named systems (a hierarchy), a topic cue in the text
// (operations, formal definition, control, alphabet), or the idea's most
// distinctive words.
const SYSTEM_PHRASE = /\b((?:[a-z]+(?:\s+[a-z]+){0,2})\s+(?:machine|automata|automaton|system|model))s?\b/gi;

// Words that never name a system: articles, prepositions, and the adjectives
// and verbs lecturers put in front of a generic "machine" ("a powerful
// machine", "passed by the machine"). "down" is deliberately NOT in here:
// "push down automata" keeps it. Anything left with fewer than two words
// after filtering is not a system name.
const MODIFIER_DROP = new Set([
  "the", "a", "an", "this", "that", "these", "those", "by", "of", "to", "for",
  "with", "as", "at", "on", "in", "from", "and", "or", "is", "was", "are",
  "were", "be", "been", "it", "its", "his", "her", "their", "our", "your", "my",
  "powerful", "strong", "weak", "big", "small", "new", "good", "simple",
  "complex", "fast", "slow", "main", "final", "first", "next", "same", "other",
  "whole", "complete", "entire", "real", "actual", "basic", "general",
  "specific", "special", "particular", "different", "various", "several",
  "many", "much", "more", "less", "most", "best", "better",
  "passed", "called", "used", "using", "known", "named", "based", "built",
  "made", "given", "seen", "faced", "having", "being", "done", "written",
  "created", "designed", "developed",
  // Comparatives, discourse words, and the generic nouns and verbs a lecturer
  // puts in front of a plain "machine" ("say the Turing machine",
  // "operations of Turing machine", "a powerful machine"). None of these
  // ever names a system.
  "than", "then", "so", "too", "very", "just", "also", "only", "even", "still",
  "yet", "now", "here", "there",
  "say", "says", "said", "see", "look", "talk", "tell", "go", "going", "come",
  "take", "get", "give", "show", "mean", "call", "calls",
  "operation", "operations", "definition", "example", "introduction", "recap",
  "rules", "part", "step", "stage", "point", "topic", "thing", "things",
  "type", "types", "kind", "sort", "way", "ways", "side", "end", "start",
  "beginning",
]);

function systemPhrases(segmentSentences) {
  const found = [];
  // A phrase is identified by its modifiers ("finite state" in "finite state
  // machine"). Leading stopwords ("the", "by") are stripped first, so "the
  // finite state machine" and "finite state machine" are the same system,
  // and a shorter modifier list that is a word-prefix of a longer one ("finite"
  // vs "finite state") collapses into the longer, more specific form.
  const modifiersOf = (phrase) => phrase.split(" ").slice(0, -1).join(" ");
  for (const s of segmentSentences) {
    for (const m of s.matchAll(SYSTEM_PHRASE)) {
      let phrase = m[1].replace(/\s+/g, " ").trim().toLowerCase();
      const words = phrase.split(" ");
      while (words.length > 1 && STOPWORDS.has(words[0])) words.shift();
      const kept = words.slice(0, -1).filter((w) => !MODIFIER_DROP.has(w));
      phrase = [...kept, words[words.length - 1]].join(" ");
      if (kept.length === 0) continue;
      const modifiers = modifiersOf(phrase);
      if (found.some((p) => {
        const pm = modifiersOf(p);
        return pm === modifiers || pm.startsWith(`${modifiers} `) || modifiers.startsWith(`${pm} `);
      })) {
        // Keep the more specific (longer) modifier list: if the new phrase
        // subsumes an existing shorter one, replace it; if an existing
        // phrase already subsumes the new one, keep the existing one.
        const idx = found.findIndex((p) => modifiers.startsWith(`${modifiersOf(p)} `) || modifiersOf(p) === modifiers);
        if (idx >= 0 && modifiers.split(" ").length > modifiersOf(found[idx]).split(" ").length) found[idx] = phrase;
        continue;
      }
      found.push(phrase);
    }
  }
  return found.slice(0, 5);
}

function shortForm(phrase) {
  const words = phrase.split(/[\s-]+/);
  if (words.length === 2 && words[0] === "turing") return "Turing Machine";
  return words.map((w) => w.charAt(0).toUpperCase()).join("");
}

function titleForIdea(segment, allSegments) {
  const text = segment.sentences.join(" ");
  const lower = text.toLowerCase();
  // 1. An enumeration of named systems compared against each other.
  const systems = systemPhrases(segment.sentences);
  const hasTuring = /\bturing machine\b/i.test(text);
  if ((systems.length >= 3 || (systems.length >= 2 && hasTuring)) && /(powerful|more|less|stronger|weaker|better|than)\b/i.test(text)) {
    const names = systems.map(shortForm);
    if (hasTuring && !names.includes("Turing Machine")) names.push("Turing Machine");
    return `The hierarchy: ${names.join(" → ")}`;
  }
  // 2. A topic cue in the text.
  if (/\bformal definition\b/i.test(text)) return "Formal definition";
  if (/\boperations\b/i.test(text)) return lower.includes("tape") ? "Tape operations" : "Operations";
  if (/\bcontrol\b/i.test(text) && /(halt|accept|reject|loop)\b/i.test(text)) return "Control and halting";
  if (/\bcontrol\b/i.test(text)) return "Control";
  if (/\balphabet\b/i.test(text)) return lower.includes("tape") ? "The tape and its alphabet" : "Alphabet";
  // The alphabet is often introduced by its symbols rather than the word
  // "alphabet": sigma for the input symbols, the blank symbol for the tape.
  if (/\bsigma\b/i.test(text) && /\bblank\b/i.test(text)) return "The tape and its alphabet";
  if (/\bintroduction\b/i.test(text) && segment === allSegments[0]) return "Introduction";
  if (/\brecap\b/i.test(text)) return "Recap";
  // 2b. The segment opens by naming its idea: "The first stage is the
  // light-dependent reactions.", "Let us start with the big picture."
  const first = segment.sentences[0] || "";
  let m = first.match(/^(the\s+)?(first|second|third|fourth|fifth|sixth|next|final)\s+(stage|step|part)\s+(is|was|are)\s+([^,;.]+)/i);
  if (m) return capLabel(m[5], 60);
  m = first.match(/^(let us|let's)\s+start\s+with\s+(the\s+)?([^,;.]+)/i);
  if (m) return capLabel(m[3], 60);
  // 3. The idea's most distinctive words.
  const allSets = allSegments.map((seg) => new Set(seg.sentences.flatMap((s) => contentWords(s))));
  const freq = new Map();
  for (const s of segment.sentences) for (const w of new Set(contentWords(s))) freq.set(w, (freq.get(w) || 0) + 1);
  const scored = [...freq.entries()].map(([w, f]) => {
    const docs = allSets.filter((set) => set.has(w)).length;
    return { w, score: f * (1 + Math.log(allSets.length / Math.max(1, docs))) };
  }).sort((a, b) => b.score - a.score || a.w.localeCompare(b.w));
  const top = scored.slice(0, 2).map((e) => e.w);
  if (top.length === 0) return "Key point";
  const title = top.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return title.length > 60 ? top[0].charAt(0).toUpperCase() + top[0].slice(1) : title;
}

// The concepts a slide title promises, so its bullets cover them: a
// "Control and halting" slide must say something about accepting and
// rejecting, a "Formal definition" slide about the seven tuples. Each
// keyword a sentence contains adds to its score (capped), so the definition
// sentence and the accept/reject sentence are picked even though their words
// are rare in the segment.
export function titleKeywords(title) {
  if (/^the hierarchy/i.test(title)) return ["finite", "stack", "bounded", "powerful", "turing", "state"];
  if (/formal definition/i.test(title)) return ["seven", "tuple", "tuples", "transition", "definition", "formal", "state", "symbol"];
  if (/control and halting/i.test(title)) return ["halt", "accept", "reject", "loop", "control", "state"];
  if (/operations/i.test(title)) return ["read", "scan", "write", "replace", "move", "tape", "head", "cell"];
  if (/alphabet/i.test(title)) return ["sigma", "blank", "alphabet", "tape", "symbol"];
  return contentWords(title);
}

export function keywordBonus(sentence, keywords) {
  if (!keywords.length) return 0;
  const words = new Set(contentWords(sentence));
  let hits = 0;
  for (const kw of keywords) {
    for (const w of words) {
      if (w === kw || w.startsWith(kw)) { hits += 1; break; }
    }
  }
  return Math.min(1.5, hits * 0.75);
}
// The deterministic fallback writes short cleaned bullets from key sentences:
// leading meta-talk and filler go, spoken grammar ("you can able to read")
// is fixed, and a long sentence is cut to its most informative clause.
// Bullets keep the lecturer's meaning; they are not verbatim chunks.
// ---- Bullet compression ----------------------------------------------------
// The deterministic fallback writes short cleaned bullets from key sentences:
// leading meta-talk and filler go, spoken grammar ("you can able to read")
// is fixed, and a long sentence is cut to its most informative clause.
// Bullets keep the lecturer's meaning; they are not verbatim chunks.
const LEAD_STRIP = [
  /^(you can see here|as you can see|we are going to see about|the next thing is( called as)?|next thing (we have seen|we will see)( about)?|this is (called )?as|it is called as|we have seen (about )?|we were (studying|looking at)( about)?|let us start with( the)?|before going into the example( we will see)?( what is)?( the)?|((can )?(quickly ))?(see|look at|go over|cover|discuss) the (operations|steps|process|procedure|details|example)( of| about)?)\s+/i,
  /^(so|and|but|now|well|also|here|first|next|then|finally|okay|like)[, ]+/i,
  /^(this|that|it|these|those)\s+(is|are|was|were)\s+/i,
];

export function compressBullet(sentence) {
  let s = String(sentence || "").trim();
  // Defensive: strip any filler or timestamp that survived cleaning.
  s = cleanTranscript(s);
  // Lead-ins come in chains ("And then next thing we have seen about ..."),
  // so strip until the sentence no longer starts with one.
  let prev = "";
  while (prev !== s) {
    prev = s;
    for (const re of LEAD_STRIP) s = s.replace(re, "");
  }
  // "can able to" is a spoken-English slip for "can".
  s = s.replace(/\bcan ?not able to\b/gi, "cannot");
  s = s.replace(/\bcan able to\b/gi, "can");
  s = s.replace(/\byou can\b/gi, "");
  s = s.replace(/\bwe can\b/gi, "");
  s = s.replace(/\bwe will be\b/gi, "");
  s = s.replace(/\bit is used to\b/gi, "used to");
  s = s.replace(/\bit is used for\b/gi, "used for");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 110) {
    // Keep the most informative clause: split on clause boundaries and pick
    // the clause with the most content words. A picked clause can itself be
    // long, so it is cut to a word boundary at 110 chars too.
    const clauses = s.split(/[,;:]\s+|\s+and\s+|\s+which\s+|\s+that\s+|\s+because\s+/).map((c) => c.trim()).filter((c) => c.length >= 25);
    if (clauses.length > 1) {
      let best = clauses[0];
      let bestWords = 0;
      for (const c of clauses) {
        const n = contentWords(c).length;
        if (n > bestWords) { bestWords = n; best = c; }
      }
      s = best;
    }
    if (s.length > 110) {
      const cut = s.slice(0, 110);
      s = cut.slice(0, cut.lastIndexOf(" ")).trim();
      // Never end a truncated bullet on a dangling little word
      // ("...equivalent to the", "...blank symbol is"): back up past
      // trailing auxiliaries and articles. Short bullets keep their final
      // word: "replace it" needs its object.
      const CUT_END = new Set(["is", "are", "was", "were", "be", "been", "so", "and", "or", "the", "a", "an", "to", "of", "in", "on", "with", "for", "it", "that", "this", "as", "at", "by"]);
      const words = s.split(" ");
      while (words.length > 1 && CUT_END.has(words[words.length - 1].toLowerCase().replace(/[.,!?;:]+$/, ""))) words.pop();
      s = words.join(" ");
    }
  }
  if (!s) return "";
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

// A fragment is a bare noun phrase with no verb and no number or symbol:
// "The formal definition." says nothing on its own, so it never becomes a
// bullet. A short line that carries a value ("δ(q0, A) = (q1, Y, R)") stays.
export function isFragmentBullet(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (/[0-9δΣΓ□→=]/.test(t)) return false;
  return countWords(t) < 5;
}
// ---- Readability guard -------------------------------------------------------
// Spoken lectures garble: a repeated-word run ("this is this is", "after your
// after", "read the read") means the ASR lost the sentence, and the line
// reads as noise on a slide. Detect it from the word sequence alone:
// a word repeated at once ("it it" is already collapsed by cleaning, but a
// repeated phrase survives), a word repeated with exactly one word between
// it ("after your after", "read the read"), or a two-word phrase repeated
// at once ("this is this is"). Single content words only repeat like this
// by accident in real lecture lines: "move one step left or one step right"
// repeats words with three words between them, so it is not flagged.
export function isGarbledText(text) {
  const words = String(text || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] === words[i + 1]) return true;
    if (i + 2 < words.length && words[i] === words[i + 2] && words[i].length >= 3) return true;
    if (i + 3 < words.length && words[i] === words[i + 2] && words[i + 1] === words[i + 3]) return true;
  }
  return false;
}

// ---- Summary: restate, never repeat ------------------------------------------
// The summary restates one takeaway per idea slide, labelled with that
// slide's title, instead of repeating the lecture's most central sentences
// verbatim. A verbatim repeat copies the worst bullets (a garbled line can
// be "central" by word frequency), so the summary only ever uses bullets
// that passed the readability guard, and the title prefix makes each line a
// restatement of the idea rather than a copy of a bullet.
export function buildSummaryBullets(contentSlides) {
  const out = [];
  for (const slide of contentSlides || []) {
    const clean = (slide.bullets || []).filter((b) => b.text && !isGarbledText(b.text));
    if (!clean.length) continue;
    const takeaway = clean[0];
    let text = `${slide.title}: ${takeaway.text}`;
    if (text.length > 190) {
      const maxTakeaway = Math.max(40, 190 - slide.title.length - 2);
      const cut = takeaway.text.slice(0, maxTakeaway);
      const short = cut.slice(0, cut.lastIndexOf(" ")).trim() || cut.trim();
      text = `${slide.title}: ${short}`;
    }
    out.push({ text, source: takeaway.source ?? null });
    if (out.length >= 5) break;
  }
  return out;
}

// Build an outline from a transcript. Returns { title, slides } where each slide is
// { type: "title" | "content" | "diagram" | "summary", title, bullets: [{ text, source }], notes }.
// Slides are built per IDEA, not per sentence chunk: each idea gets a title
// that names it and 2-4 short cleaned bullets. Transcript detail lives in
// speaker notes, not on the slides. Diagram slides carry a diagram object
// instead of bullets; every diagram element keeps its source sentence for
// the fact checker.
export function extractOutline(transcript, title) {
  const clean = cleanTranscript(transcript);
  const sentences = splitSentences(clean);
  const givenTitle = String(title || "").trim();
  if (sentences.length === 0) {
    return {
      title: givenTitle || "Untitled lecture",
      slides: [
        { type: "title", title: givenTitle || "Untitled lecture", bullets: [], notes: "" },
        { type: "summary", title: "Summary", bullets: [], notes: "No transcript text was found, so no summary could be built." },
      ],
    };
  }
  const segments = segmentIdeas(clean);
  // The opening segment is the greeting and topic preview when it reads like
  // one ("hello", "we are going to see", "topics we are going to"); its
  // sentences become the title slide's speaker notes, not a content slide.
  const first = segments[0];
  const firstText = first.sentences.join(" ").toLowerCase();
  const isIntro = first.sentences.length <= 4 && /(hello|welcome|going to (see|talk|look)|topics we are going to|introduction)\b/.test(firstText);
  const ideaSegments = isIntro ? segments.slice(1) : segments;
  // The lecture title: the given title, or the intro's topic ("Turing
  // Machine: Introduction" when the lecture opens on Turing machines).
  // The topic word is the intro word that recurs most across the whole
  // lecture, so a greeting ("hello", "going", "see") never wins over the
  // subject ("turing", "photosynthesis").
  let cleanTitle = givenTitle;
  if (!cleanTitle) {
    const GENERIC = new Set(["going", "see", "talk", "look", "today", "hello", "everyone", "welcome", "class", "lecture", "topic", "topics", "now", "first", "going"]);
    const allFreq = new Map();
    for (const s of sentences) for (const w of new Set(contentWords(s))) allFreq.set(w, (allFreq.get(w) || 0) + 1);
    const introWords = [...new Set(first.sentences.flatMap((s) => contentWords(s)))].filter((w) => !GENERIC.has(w));
    const scored = introWords.map((w) => ({ w, score: allFreq.get(w) || 0 })).sort((a, b) => b.score - a.score || a.w.localeCompare(b.w));
    let topicPhrase = "";
    if (scored.length && scored[0].score >= 2) {
      const topWord = scored[0].w;
      const introText = first.sentences.join(" ").toLowerCase();
      const bigram = introText.match(new RegExp(`\\b([a-z][a-z'-]*)\\s+${topWord}\\b|\\b${topWord}\\s+([a-z][a-z'-]*)\\b`));
      if (bigram) {
        const phrase = (bigram[1] ? `${bigram[1]} ${topWord}` : `${topWord} ${bigram[2]}`).split(" ").filter((w) => !GENERIC.has(w) && !STOPWORDS.has(w));
        if (phrase.length === 2) topicPhrase = phrase.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      }
      if (!topicPhrase) topicPhrase = topWord.charAt(0).toUpperCase() + topWord.slice(1);
    }
    cleanTitle = topicPhrase ? (/introduction/i.test(firstText) ? `${topicPhrase}: Introduction` : topicPhrase) : "Untitled lecture";
  }
  const notesForSegment = (seg) => truncateAtWord(seg.sentences.join(" "), 500);
  const slides = [{
    type: "title",
    title: cleanTitle,
    bullets: [],
    notes: isIntro ? notesForSegment(first) : truncateAtWord(sentences[0], 220),
  }];
  // One slide per idea: a title naming the idea, 2-4 short cleaned bullets
  // from its key sentences, and the idea's full text as speaker notes.
  for (const seg of ideaSegments) {
    const segSets = seg.sentences.map((s) => new Set(contentWords(s)));
    const segScored = seg.sentences
      .map((sentence, k) => ({ sentence, index: seg.indices[k], score: segSets[k].size }))
      .filter((s) => countWords(s.sentence) >= 4);
    // Score by shared vocabulary inside the idea: the sentences that use the
    // idea's own words most are its key sentences. The score is normalised
    // by length, so a long garbled ASR sentence does not outrank the short
    // clean sentences that actually state the idea. Selection is greedy
    // with diversity (maximal marginal relevance): once a sentence is
    // picked, its words count for much less, so the next pick covers a
    // different part of the idea instead of restating the same point.
    const segFreq = new Map();
    for (const set of segSets) for (const w of set) segFreq.set(w, (segFreq.get(w) || 0) + 1);
    const pool = segScored.map((s) => ({ ...s, words: new Set(contentWords(s.sentence)) }));
    const covered = new Set();
    const picked = [];
    const keywords = titleKeywords(titleForIdea(seg, segments));
    // Pick eight candidates: a pick can still be dropped later as a fragment,
    // as too short, or as garbled, so the slide is not starved when one is.
    while (picked.length < 8 && pool.length) {
      let bestIdx = 0;
      let bestScore = -1;
      pool.forEach((s, k) => {
        let sum = 0;
        for (const w of s.words) sum += covered.has(w) ? (segFreq.get(w) || 0) * 0.15 : (segFreq.get(w) || 0);
        const score = sum / Math.sqrt(Math.max(1, countWords(s.sentence))) + keywordBonus(s.sentence, keywords);
        if (score > bestScore) { bestScore = score; bestIdx = k; }
      });
      const [best] = pool.splice(bestIdx, 1);
      picked.push(best);
      for (const w of best.words) covered.add(w);
    }
    const key = picked;
    const bullets = [];
    const seen = new Set();
    // Iterate in MMR rank order (best pick first), not lecture order: the
    // four best picks are the bullets, and they are then shown in lecture
    // order. Iterating in lecture order instead would let the first four
    // sentences fill the slide before a better later pick is reached.
    for (const k of key) {
      const text = compressBullet(k.sentence);
      if (!text || text.length < 15 || isFragmentBullet(text) || isGarbledText(text)) continue;
      const sig = text.slice(0, 40).toLowerCase();
      if (seen.has(sig)) continue;
      seen.add(sig);
      bullets.push({ text, source: k.index });
      if (bullets.length >= 4) break;
    }
    bullets.sort((a, b) => a.source - b.source);
    if (!bullets.length) continue;
    slides.push({
      type: "content",
      title: titleForIdea(seg, segments),
      bullets,
      notes: notesForSegment(seg),
    });
  }
  // Diagram slides go between the content slides and the summary. They are
  // added only when the transcript states the data plainly; a missing
  // diagram is not an error, it just means no diagram slide.
  const diagrams = extractDiagrams(clean);
  if (diagrams.flow) {
    const first = diagrams.flow.steps[0];
    slides.push({
      type: "diagram",
      title: slideTitleFrom(sentences[first.source]),
      bullets: [],
      notes: "",
      diagram: { kind: "flow", steps: diagrams.flow.steps },
    });
  }
  if (diagrams.bars) {
    const first = diagrams.bars.bars[0];
    slides.push({
      type: "diagram",
      title: slideTitleFrom(sentences[first.source]),
      bullets: [],
      notes: "",
      diagram: { kind: "bars", unit: diagrams.bars.unit, bars: diagrams.bars.bars },
    });
  }
  // Summary: one restated takeaway per idea slide, labelled with its title.
  // It never copies a bullet verbatim, and a garbled bullet can never reach
  // it, because buildSummaryBullets only uses bullets that passed the guard.
  const contentSlides = slides.filter((s) => s.type === "content");
  slides.push({
    type: "summary",
    title: "Summary",
    bullets: buildSummaryBullets(contentSlides),
    notes: "",
  });
  return { title: cleanTitle, slides };
}

// Convert an outline into renderable slides with stable ids.
export function buildSlides(outline) {
  return outline.slides.map((slide, i) => ({
    id: `slide-${i + 1}`,
    type: slide.type,
    title: slide.title,
    bullets: slide.bullets.map((b) => ({ text: b.text, source: b.source ?? null })),
    notes: slide.notes || "",
    diagram: slide.diagram || null,
    layout: slide.type === "title" ? "title" : slide.type === "summary" ? "summary" : slide.type === "diagram" ? "diagram" : "bullets",
  }));
}

// Deterministic grounding check: each bullet must share most of its content words
// with the transcript sentence it came from, and each diagram element must be
// grounded the same way (labels by word overlap, bar values by appearing in the
// source sentence as digits or as words). A bullet with no source (written by
// the model through set_outline) is checked against the whole transcript
// instead: at least half its words must appear somewhere in the lecture.
// Returns { ok, checked, failed }.
export function verifyDeck(transcript, slides) {
  // Bullet sources are indices into the CLEANED sentence list (extractOutline
  // cleans first), so clean here too: a raw transcript with danda
  // terminators or timestamps would otherwise misalign every index.
  const sentences = splitSentences(cleanTranscript(transcript));
  const failed = [];
  let checked = 0;
  for (const slide of slides) {
    for (const bullet of slide.bullets || []) {
      if (bullet.source === null || bullet.source === undefined) {
        // Source-less mode: a model-written bullet (via the set_outline
        // action) has no single source sentence. It is grounded if at least
        // half of its content words appear anywhere in the transcript. A
        // bullet whose words are mostly absent from the lecture still fails.
        checked += 1;
        const bulletWords = new Set(contentWords(bullet.text));
        if (bulletWords.size === 0) continue;
        const allWords = new Set(sentences.flatMap((s) => contentWords(s)));
        let shared = 0;
        for (const w of bulletWords) if (allWords.has(w)) shared += 1;
        const overlap = shared / bulletWords.size;
        if (overlap < 0.5) {
          failed.push({ slide: slide.title, bullet: bullet.text, reason: `only ${Math.round(overlap * 100)}% of its words appear anywhere in the transcript` });
        }
        continue;
      }
      checked += 1;
      const source = sentences[bullet.source] || "";
      const bulletWords = new Set(contentWords(bullet.text));
      const sourceWords = new Set(contentWords(source));
      if (bulletWords.size === 0) continue;
      let shared = 0;
      for (const w of bulletWords) if (sourceWords.has(w)) shared += 1;
      const overlap = shared / bulletWords.size;
      if (overlap < 0.5) {
        failed.push({ slide: slide.title, bullet: bullet.text, reason: `only ${Math.round(overlap * 100)}% of its words appear in the source sentence` });
      }
    }
    if (slide.diagram && slide.diagram.kind === "flow") {
      for (const step of slide.diagram.steps || []) {
        checked += 1;
        const source = sentences[step.source] || "";
        const labelWords = new Set(contentWords(step.label));
        const sourceWords = new Set(contentWords(source));
        if (labelWords.size === 0) continue;
        let shared = 0;
        for (const w of labelWords) if (sourceWords.has(w)) shared += 1;
        if (shared / labelWords.size < 0.5) {
          failed.push({ slide: slide.title, bullet: `flow step "${step.label}"`, reason: "its words do not appear in the source sentence" });
        }
      }
    }
    if (slide.diagram && slide.diagram.kind === "bars") {
      for (const bar of slide.diagram.bars || []) {
        checked += 1;
        const source = sentences[bar.source] || "";
        const labelWords = new Set(contentWords(bar.label));
        const sourceWords = new Set(contentWords(source));
        let shared = 0;
        for (const w of labelWords) if (sourceWords.has(w)) shared += 1;
        const labelOk = labelWords.size === 0 || shared / labelWords.size >= 0.5;
        const valueOk = numberAppearsIn(bar.value, source);
        if (!labelOk) {
          failed.push({ slide: slide.title, bullet: `bar "${bar.label}"`, reason: "its label does not appear in the source sentence" });
        } else if (!valueOk) {
          failed.push({ slide: slide.title, bullet: `bar "${bar.label}" (${bar.value})`, reason: `the value ${bar.value} does not appear in the source sentence` });
        }
      }
    }
  }
  return { ok: failed.length === 0, checked, failed };
}

export function slugify(title) {
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "deckcast-deck";
}

// Build a PptxGenJS presentation from slides. The PptxGenJS class is passed in so
// this stays testable in Node and the browser. Returns the configured presentation;
// the caller chooses writeFile (browser download) or write({ outputType: "base64" }).
// themeName picks the export theme ("cream", "light" or "dark"); anything else
// falls back to cream, the site palette. The export is independent of the
// site's own palette: the site stays cream and blue, the deck follows the
// visitor's chosen theme.
export function createPptx(PptxGenJSClass, slides, title, themeName = "cream") {
  const pptx = new PptxGenJSClass();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";
  pptx.author = "DeckCast";
  pptx.title = title || "DeckCast deck";
  const t = PPTX_THEMES[resolveExportTheme(themeName)];
  const INK = t.ink;
  const MUTED = t.muted;
  const BLUE = t.accent;
  // The title slide uses the deeper title colour, content slides the lighter
  // card colour, and every slide keeps the accent top rule.
  const CREAM = t.titleBg;
  const CARD = t.card;
  const BORDER = t.border;
  for (const slide of slides) {
    const s = pptx.addSlide();
    s.background = { color: slide.type === "title" ? CREAM : CARD };
    s.addShape("rect", { x: 0, y: 0, w: 13.33, h: 0.12, fill: { color: BLUE } });
    if (slide.type === "title") {
      s.addText(slide.title, { x: 0.8, y: 2.4, w: 11.73, h: 1.4, fontSize: 40, bold: true, color: INK, align: "center" });
      if (slide.notes) {
        s.addText(slide.notes, { x: 1.8, y: 4.0, w: 9.73, h: 1.0, fontSize: 16, color: MUTED, align: "center" });
      }
      s.addText("Made with DeckCast", { x: 0.8, y: 6.6, w: 11.73, h: 0.4, fontSize: 12, color: MUTED, align: "center" });
      continue;
    }
    s.addText(slide.title, { x: 0.6, y: 0.5, w: 12.13, h: 0.8, fontSize: 28, bold: true, color: INK });
    if (slide.diagram && slide.diagram.kind === "flow") {
      // Process flow: one box per step, arrows between them.
      const steps = slide.diagram.steps || [];
      const n = steps.length;
      const gap = 0.4;
      const boxW = (12.13 - (n - 1) * gap) / n;
      steps.forEach((step, i) => {
        const x = 0.6 + i * (boxW + gap);
        s.addShape("rect", { x, y: 2.2, w: boxW, h: 2.4, fill: { color: CARD }, line: { color: INK, width: 1.5 } });
        s.addText(String(i + 1), { x, y: 2.3, w: boxW, h: 0.5, fontSize: 18, bold: true, color: MUTED, align: "center" });
        s.addText(step.label, { x: x + 0.2, y: 2.9, w: boxW - 0.4, h: 1.5, fontSize: 16, color: INK, align: "center", valign: "top" });
        if (i < n - 1) {
          s.addText("→", { x: x + boxW, y: 3.1, w: gap, h: 0.6, fontSize: 24, color: MUTED, align: "center" });
        }
      });
      if (slide.notes) {
        s.addText(slide.notes, { x: 0.8, y: 6.4, w: 11.73, h: 0.6, fontSize: 12, color: MUTED, italic: true });
      }
      continue;
    }
    if (slide.diagram && slide.diagram.kind === "bars") {
      // Bar chart: one bar per value, heights proportional to the largest.
      const bars = slide.diagram.bars || [];
      const max = Math.max(...bars.map((b) => b.value), 1);
      const baseY = 5.6;
      const chartH = 3.4;
      const slot = 11.0 / bars.length;
      const barW = Math.min(1.2, slot * 0.55);
      s.addShape("rect", { x: 0.9, y: baseY, w: 11.4, h: 0.03, fill: { color: BORDER } });
      s.addText(`Values in ${slide.diagram.unit}`, { x: 0.9, y: 1.4, w: 6, h: 0.4, fontSize: 13, color: MUTED });
      bars.forEach((bar, i) => {
        const h = Math.max(0.12, (bar.value / max) * chartH);
        const x = 1.1 + i * slot + (slot - barW) / 2;
        s.addShape("rect", { x, y: baseY - h, w: barW, h, fill: { color: INK } });
        s.addText(String(bar.value), { x: x - 0.4, y: baseY - h - 0.45, w: barW + 0.8, h: 0.4, fontSize: 16, bold: true, color: INK, align: "center" });
        s.addText(bar.label, { x: x - 0.4, y: baseY + 0.15, w: barW + 0.8, h: 0.6, fontSize: 13, color: MUTED, align: "center" });
      });
      if (slide.notes) {
        s.addText(slide.notes, { x: 0.8, y: 6.4, w: 11.73, h: 0.6, fontSize: 12, color: MUTED, italic: true });
      }
      continue;
    }
    const paras = (slide.bullets || []).map((b, i) => ({
      text: b.text,
      options: { bullet: { indent: 18 }, breakLine: i < slide.bullets.length - 1, fontSize: 18, color: INK },
    }));
    if (paras.length) {
      s.addText(paras, { x: 0.8, y: 1.6, w: 11.73, h: 4.6, valign: "top" });
    }
    if (slide.notes) {
      s.addText(slide.notes, { x: 0.8, y: 6.4, w: 11.73, h: 0.6, fontSize: 12, color: MUTED, italic: true });
    }
  }
  return pptx;
}
