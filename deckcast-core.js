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
  "same", "s", "t", "ll", "re", "ve", "d", "m", "one", "two", "first", "second"
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

function contentWords(sentence) {
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

// Build an outline from a transcript. Returns { title, slides } where each slide is
// { type: "title" | "content" | "summary", title, bullets: [{ text, source }], notes }.
// Bullets are transcript sentences (shortened at most), never invented text.
export function extractOutline(transcript, title) {
  const sentences = splitSentences(transcript);
  const cleanTitle = String(title || "").trim() || "Untitled lecture";
  if (sentences.length === 0) {
    return {
      title: cleanTitle,
      slides: [
        { type: "title", title: cleanTitle, bullets: [], notes: "" },
        { type: "summary", title: "Summary", bullets: [], notes: "No transcript text was found, so no summary could be built." },
      ],
    };
  }
  const scored = scoreSentences(sentences)
    .filter((s) => countWords(s.sentence) >= 4)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const keyCount = Math.min(24, scored.length);
  const key = scored.slice(0, keyCount).sort((a, b) => a.index - b.index);

  const notesFor = (keyItem) => {
    const next = sentences[keyItem.index + 1];
    if (!next) return "";
    return truncateAtWord(next, 220);
  };

  const slides = [{ type: "title", title: cleanTitle, bullets: [], notes: sentences[0] ? truncateAtWord(sentences[0], 220) : "" }];
  const perSlide = 3;
  const maxContentSlides = 8;
  for (let i = 0; i < key.length && slides.length <= maxContentSlides; i += perSlide) {
    const group = key.slice(i, i + perSlide);
    slides.push({
      type: "content",
      title: slideTitleFrom(group[0].sentence),
      bullets: group.map((k) => ({ text: truncateAtWord(k.sentence, 200), source: k.index })),
      notes: group.map(notesFor).filter(Boolean).join(" "),
    });
  }
  const topThree = scored.slice(0, 3).sort((a, b) => a.index - b.index);
  slides.push({
    type: "summary",
    title: "Summary",
    bullets: topThree.map((k) => ({ text: truncateAtWord(k.sentence, 200), source: k.index })),
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
    layout: slide.type === "title" ? "title" : slide.type === "summary" ? "summary" : "bullets",
  }));
}

// Deterministic grounding check: each bullet must share most of its content words
// with the transcript sentence it came from. Returns { ok, checked, failed }.
export function verifyDeck(transcript, slides) {
  const sentences = splitSentences(transcript);
  const failed = [];
  let checked = 0;
  for (const slide of slides) {
    for (const bullet of slide.bullets || []) {
      if (bullet.source === null || bullet.source === undefined) {
        failed.push({ slide: slide.title, bullet: bullet.text, reason: "no source sentence recorded" });
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
export function createPptx(PptxGenJSClass, slides, title) {
  const pptx = new PptxGenJSClass();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";
  pptx.author = "DeckCast";
  pptx.title = title || "DeckCast deck";
  const INK = "2B1D12";
  const MUTED = "6B5847";
  const BLUE = "8EC8EE";
  const CREAM = "FAF6EF";
  for (const slide of slides) {
    const s = pptx.addSlide();
    s.background = { color: slide.type === "title" ? CREAM : "FFFFFF" };
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
