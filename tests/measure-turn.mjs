// tests/measure-turn.mjs - ground-truth per-call token measurement.
// Loads the real DeckCast page in headless Chromium with a FAKE Groq key
// (gsk_measure_only_not_a_real_key - never a real credential), intercepts
// every chat-completions request before it leaves the machine, records the
// exact request body, and answers with canned model replies that drive the
// agents through a full "Turn this lecture into slides" turn on the Turing
// lecture. Nothing leaves the machine: the Groq route is fulfilled locally
// and any other groq.com request is aborted.
// Token estimate: 4 chars per token (Groq bills actual tokens; this is the
// standard rough English estimate. Calibrated against two live Groq 429s:
// the first call measured 3,661 here against 3,853 reported by Groq, and
// the second 4,129 against 4,286, so the estimate runs about 5-10% low.)
// Run: node tests/measure-turn.mjs
import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { stubModelOutline } from "./stub-model.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8902;
const turing = readFileSync(path.join(ROOT, "tests/turing-lecture.txt"), "utf8");
const outline = stubModelOutline(turing, "Turing Machines - Introduction");
const outlineJson = JSON.stringify(outline);
const tok = (chars) => Math.round(chars / 4);

function resolveChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = path.join(process.env.HOME || "", ".cache/ms-playwright");
  if (existsSync(cache)) {
    const dirs = readdirSync(cache)
      .filter((d) => d.startsWith("chromium-") || d.startsWith("chromium_headless_shell-"))
      .sort().reverse();
    for (const d of dirs) {
      for (const c of [
        path.join(cache, d, "chrome-linux64/chrome"),
        path.join(cache, d, "chrome-linux/chrome"),
        path.join(cache, d, "chrome-headless-shell-linux64/chrome-headless-shell"),
      ]) if (existsSync(c)) return c;
    }
  }
  return undefined;
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml",
  ".txt": "text/plain", ".woff2": "font/woff2", ".png": "image/png", ".xml": "application/xml",
  ".wasm": "application/wasm",
};
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(ROOT, url === "/" ? "index.html" : url);
  if (!existsSync(file) || !file.startsWith(ROOT)) {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end(readFileSync(path.join(ROOT, "404.html")));
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const calls = []; // {seq, agent, at, bodyChars, promptChars, model}
const agentCalls = {};
let callSeq = 0;

function agentOf(body) {
  const system = (body.messages || []).find((m) => m.role === "system")?.content || "";
  if (system.includes("You are the assistant on the DeckCast website")) return "deckcast_producer";
  if (system.includes("with the slide outline")) return "structure";
  if (system.includes("with slide design")) return "slide_designer";
  if (system.includes("with fact checking")) return "fact_checker";
  if (system.includes("with transcription")) return "transcriber";
  return "unknown";
}

function lastToolOf(body) {
  let last = null;
  for (const m of body.messages || []) {
    if (m.tool_calls?.length) last = m.tool_calls[m.tool_calls.length - 1].function?.name || null;
  }
  return last;
}

function sseText(model, text) {
  const chunk = { id: "chatcmpl-measure", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n`;
}
function sseTool(model, name, args) {
  const chunk = { id: "chatcmpl-measure", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${++callSeq}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n`;
}

function cannedReply(body) {
  const agent = agentOf(body);
  const lastTool = lastToolOf(body);
  const model = body.model || "openai/gpt-oss-120b";
  agentCalls[agent] = (agentCalls[agent] || 0) + 1;
  if (agent === "deckcast_producer") {
    if (!lastTool) return sseTool(model, "website_get_lecture_state", {});
    if (lastTool === "website_get_lecture_state") return sseTool(model, "structure", { request: "Build the slide outline from the lecture transcript. Read it with website_get_lecture_state." });
    if (lastTool === "structure") return sseTool(model, "slide_designer", { request: `Refine this outline into slide text and return the revised outline as JSON for website_set_outline: ${outlineJson}` });
    if (lastTool === "slide_designer") return sseTool(model, "website_set_outline", { title: outline.title, slides: outline.slides });
    if (lastTool === "website_set_outline") return sseTool(model, "fact_checker", { request: "Verify the deck on the page against the transcript. Read the deck with website_get_lecture_state and run website_verify_deck." });
    if (lastTool === "fact_checker") return sseTool(model, "website_render_slides", {});
    if (lastTool === "website_render_slides") return sseText(model, "Deck built: 7 slides. Check them below, then export.");
    return sseText(model, "Done.");
  }
  if (agent === "structure") {
    if (!lastTool) return sseTool(model, "website_get_lecture_state", {});
    return sseText(model, outlineJson);
  }
  if (agent === "slide_designer") {
    return sseText(model, outlineJson);
  }
  if (agent === "fact_checker") {
    if (!lastTool) return sseTool(model, "website_get_lecture_state", {});
    if (lastTool === "website_get_lecture_state") return sseTool(model, "website_verify_deck", {});
    return sseText(model, "Pass: every claim is grounded in the transcript.");
  }
  if (agent === "transcriber") return sseText(model, "Transcription is available on this page.");
  return sseText(model, "Done.");
}

let browser;
try {
  const executablePath = resolveChromium();
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox", "--disable-gpu"] });
  const context = await browser.newContext();
  // Fake BYOK profile: the key is not real, and every request it would send
  // is intercepted below, so nothing leaves this machine.
  await context.addInitScript(() => {
    localStorage.setItem("nsweb-byok-profiles-v1", JSON.stringify({
      version: 1,
      selectedId: "measure",
      updatedAt: new Date().toISOString(),
      profiles: [{ id: "measure", name: "Groq (measure)", key: "gsk_measure_only_not_a_real_key", router: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", updatedAt: new Date().toISOString() }],
    }));
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", String(e).slice(0, 300)));
  // Safety net: nothing to groq.com ever leaves this machine.
  await page.route("**/api.groq.com/**", async (route) => {
    const req = route.request();
    if (req.url().endsWith("/chat/completions") && req.method() === "POST") {
      const body = req.postDataJSON();
      const bodyChars = JSON.stringify(body).length;
      const systemChars = (body.messages || []).filter((m) => m.role === "system").reduce((a, m) => a + String(m.content || "").length, 0);
      const toolsChars = JSON.stringify(body.tools || []).length;
      const messagesChars = JSON.stringify(body.messages || []).length;
      // The messages array already contains the system message, so the
      // prompt is messages + tools (systemChars is reported separately as
      // a component, not added again).
      const promptChars = messagesChars + toolsChars;
      calls.push({ seq: calls.length + 1, agent: agentOf(body), at: Date.now(), bodyChars, promptChars, systemChars, toolsChars, messagesChars, model: body.model });
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: cannedReply(body) });
    } else {
      console.log("ABORTED non-chat groq request:", req.url());
      await route.abort();
    }
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__nsweb?.engine, null, { timeout: 20000 });
  const bootInfo = await page.evaluate(() => {
    const engine = window.__nsweb.engine;
    return { mockLLM: engine.mockLLM, byokKey: engine.byokKey ? `${engine.byokKey.slice(0, 4)}...(${engine.byokKey.length})` : "(none)", router: engine.top?.llm?.baseUrl || "" };
  });
  console.log("boot:", JSON.stringify(bootInfo));
  await page.evaluate(async (text) => {
    const { setTranscript } = await import("/deck.js");
    setTranscript(text, "paste");
  }, turing);
  await page.evaluate(() => {
    const input = document.querySelector("#lecture-title");
    if (input) input.value = "Turing Machines - Introduction";
  });
  const started = Date.now();
  await page.click("#build-deck");
  // Wait for the turn to finish: the deck status names the model path, or
  // the deterministic fallback note appears, or 90s pass.
  try {
    await page.waitForFunction(() => {
      const s = document.querySelector("#deck-status")?.textContent || "";
      return s.includes("rewritten with the model") || s.includes("deterministic deck is shown instead") || s.includes("Deck built");
    }, null, { timeout: 90000 });
  } catch {
    console.log("TIMEOUT waiting for the deck status. Status now:", await page.evaluate(() => document.querySelector("#deck-status")?.textContent || "(none)"));
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const status = await page.evaluate(() => document.querySelector("#deck-status")?.textContent || "(none)");
  const pathLine = await page.evaluate(() => document.querySelector("#build-path")?.textContent || "(none)");
  console.log(`\nturn took ${elapsed}s; deck-status: ${status}`);
  console.log(`build-path: ${pathLine}`);
  console.log(`\n=== Per-call request sizes (prompt = system + messages + tools) ===`);
  let totalPromptTok = 0;
  let totalBodyTok = 0;
  for (const c of calls) {
    const pTok = tok(c.promptChars);
    const bTok = tok(c.bodyChars);
    totalPromptTok += pTok;
    totalBodyTok += bTok;
    console.log(`#${c.seq} ${c.agent} (+${((c.at - started) / 1000).toFixed(1)}s): prompt ${c.promptChars} chars ~${pTok} tok (system ${c.systemChars}, messages ${c.messagesChars}, tools ${c.toolsChars}) | body ${c.bodyChars} chars ~${bTok} tok | model ${c.model}`);
  }
  console.log(`\nTURN TOTAL: ${calls.length} calls, prompt ~${totalPromptTok} tokens, body ~${totalBodyTok} tokens (budget 8000/min)`);
  const perAgent = {};
  for (const c of calls) {
    perAgent[c.agent] = perAgent[c.agent] || { calls: 0, tok: 0 };
    perAgent[c.agent].calls += 1;
    perAgent[c.agent].tok += tok(c.promptChars);
  }
  console.log("per agent:", JSON.stringify(perAgent));
  await browser.close();
} catch (err) {
  console.log("HARNESS ERROR:", err.message);
  try { await browser?.close(); } catch {}
} finally {
  server.close();
}
