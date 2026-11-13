// llm.js — the LlmClient intrinsic: an OpenAI-compatible chat-completions client.

import { assertModelForRouter, normalizeModelName } from "./model.js";
import { ProviderError } from "./provider-error.js";

function hostOf(url) {
  try { return new URL(url).host; } catch { return url || "?"; }
}

export function isMockResponse(configuredMock, routeKind, model) {
  return !!configuredMock || routeKind === "mock" || /neuro-san-mock/.test(model || "");
}

// A 429 (rate limit) is transient: the provider is telling us to wait, not
// that the key is bad. Retry the call after the delay the provider suggests,
// instead of failing the turn on the first 429. The delay is the LONGEST
// suggestion the provider gives: the Retry-After header and the body's
// "try again in Xs" phrase (Groq's wording) can disagree, and waiting only
// the shorter one earns another 429, because the tokens that tripped the
// limit are still inside the provider's rolling window. When neither is
// given, wait a short default. Each wait is capped so a turn is never
// stalled for minutes; the turn's own 90-second deadline is the outer
// bound. Only 429s are retried: any other HTTP error fails at once.
export const LLM_429_MAX_RETRIES = 2; // up to 3 attempts per call
export const LLM_429_MAX_WAIT_MS = 60_000;
export const LLM_429_DEFAULT_WAIT_MS = 5_000;

function parseRetryAfter(value) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

export function retryAfterMs(resp, bodyText) {
  const candidates = [];
  const fromHeader = parseRetryAfter(resp?.headers?.get?.("Retry-After"));
  if (fromHeader !== null) candidates.push(fromHeader);
  const body = String(bodyText || "");
  const inBody = /try again in\s+([\d.]+)\s*s/i.exec(body)
    || /retry(?:-after)?[:\s]+([\d.]+)/i.exec(body);
  if (inBody) candidates.push(Math.round(parseFloat(inBody[1]) * 1000));
  if (!candidates.length) return LLM_429_DEFAULT_WAIT_MS;
  return Math.min(Math.max(...candidates), LLM_429_MAX_WAIT_MS);
}

function sleepWithAbort(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("Aborted"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export function browserMockCompletion(messages = [], tools = []) {
  const called = new Set(messages.filter((m) => m?.role === "tool" && m.name).map((m) => m.name));
  const available = (tools || []).map((tool) => tool?.function).filter((fn) => fn?.name);
  const next = available.find((fn) => !called.has(fn.name));
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const request = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content || "");
  if (next) {
    const args = {};
    const schema = next.parameters || {};
    for (const name of schema.required || []) args[name] = request;
    for (const name of ["request", "inquiry", "search_terms", "query", "input"]) {
      if (schema.properties?.[name] || (schema.required || []).includes(name)) args[name] ??= request;
    }
    return {
      content: "",
      toolCalls: [{
        id: `call_${next.name}`,
        type: "function",
        function: { name: next.name, arguments: JSON.stringify(args) },
      }],
      finishReason: "tool_calls",
      usage: null,
      model: "neuro-san-mock-browser",
    };
  }
  const results = messages.filter((m) => m?.role === "tool").map((m) => String(m.content || ""));
  const content = results.length
    ? `(mock summary) Based on the tools I consulted: ${results.join(" ").slice(0, 1200)}`
    : "(mock) I have no grounded tool output to summarize for this request.";
  return { content, toolCalls: [], finishReason: "stop", usage: null, model: "neuro-san-mock-browser" };
}

//
// In production this is @langchain/openai's ChatOpenAI pointed at a router base
// URL. Here it is a direct fetch to any OpenAI-compatible endpoint (LiteLLM,
// OpenRouter, vLLM, Ollama, Docker Model Runner, or the demo mock router). The
// BYOK key is never put in the URL and is sent only to the chosen router as
// Authorization.

export class LlmClient {
  constructor({ baseUrl, apiKey, trace, mock }) {
    this.baseUrl = (baseUrl || "").replace(/\/$/, "");
    this.apiKey = apiKey || "";
    this.trace = trace;
    this.mock = !!mock;
  }

  // messages: [{role, content, tool_calls?, tool_call_id?, name?}]
  // tools: [{type:'function', function:{name, description, parameters}}]
  // onContentDelta: (text) => void  — streamed natural-language tokens
  async chat({ model, messages, tools, origin, parentSpan, onContentDelta, signal }) {
    model = normalizeModelName(model);
    // A real (non-mock) router with no API key: refuse rather than forward the
    // placeholder "demo" to a live provider (which returns a confusing 401). This
    // happens e.g. when a shared/reloaded URL keeps the proxy router but no saved
    // BYOK profile/key is available in this browser.
    if (!this.mock && (!this.apiKey || this.apiKey === "demo")) {
      throw new Error(`An AI provider key is required for ${hostOf(this.baseUrl) || "the configured provider"}. Open AI model settings, paste your key, then select Save and start. Your key stays in this browser and is sent only to the configured provider.`);
    }
    assertModelForRouter(model, this.mock, hostOf(this.baseUrl));
    const span = this.trace?.start("model_call", {
      parent: parentSpan,
      origin,
      model,
      mock: this.mock,
      routerHost: hostOf(this.baseUrl),
      endpoint: `${this.baseUrl}/chat/completions`,
      keySource: this.apiKey ? "local BYOK (not shown)" : "none",
      toolNames: (tools || []).map((t) => t.function.name),
    });

    const body = {
      model,
      messages,
      stream: true,
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    try {
      if (this.baseUrl === "browser://mock") {
        signal?.throwIfAborted?.();
        const result = browserMockCompletion(messages, tools);
        if (result.content) {
          onContentDelta?.(result.content);
          this.trace?.update(span, { streamChunk: result.content });
        }
        this.trace?.end(span, {
          finishReason: result.finishReason,
          contentChars: result.content.length,
          toolCalls: result.toolCalls.map((t) => t.function.name),
          usage: null,
          mock: true,
          verifiedReal: false,
          respModel: result.model,
          routeKind: "browser-mock",
        });
        return result;
      }
      const headers = {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      };
      if (hostOf(this.baseUrl) === "api.anthropic.com") {
        headers["anthropic-dangerous-direct-browser-access"] = "true";
      }
      // A 429 waits and retries (see retryAfterMs above). Any other HTTP
      // error fails at once. The trace span stays open across retries, so
      // the "not verified" state only resolves when a call finally succeeds
      // or fails for good: a retried 429 never flashes an error.
      let resp;
      let lastBody = "";
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted?.();
        resp = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (resp.ok) break;
        lastBody = await resp.text().catch(() => "");
        if (resp.status !== 429 || attempt >= LLM_429_MAX_RETRIES) {
          throw new Error(`LLM HTTP ${resp.status}: ${lastBody.slice(0, 300)}`);
        }
        const waitMs = retryAfterMs(resp, lastBody);
        this.trace?.update(span, { retry: `429, retry ${attempt + 1} of ${LLM_429_MAX_RETRIES} after ${Math.round(waitMs / 1000)}s` });
        await sleepWithAbort(waitMs, signal);
      }

      const routeKind = resp.headers.get("X-Nsdeploy-LLM-Route") || "";
      const result = await this._readSse(resp, onContentDelta, span, signal);
      const respMock = isMockResponse(this.mock, routeKind, result.model);
      this.trace?.end(span, {
        finishReason: result.finishReason,
        contentChars: result.content.length,
        toolCalls: result.toolCalls.map((t) => t.function.name),
        usage: result.usage,
        mock: respMock,
        verifiedReal: !respMock && !!result.model,
        respModel: result.model,
        routeKind,
      });
      return result;
    } catch (err) {
      const friendlyError = ProviderError.friendly(err, this.baseUrl);
      if (err?.name === "AbortError" && signal?.aborted) {
        this.trace?.end(span, { status: "steered", interrupted: true });
      } else {
        this.trace?.fail(span, friendlyError);
      }
      throw friendlyError;
    }
  }

  async _readSse(resp, onContentDelta, span, signal) {
    const reader = resp.body.getReader();
    const cancel = () => reader.cancel(signal?.reason).catch(() => {});
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      await cancel();
      signal.throwIfAborted();
    }
    const dec = new TextDecoder();
    let buf = "";
    let content = "";
    const toolCalls = []; // assembled by index
    let finishReason = null;
    let usage = null;
    let model = null;

    const handleChunk = (json) => {
      if (json.model) model = json.model;
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (delta.content) {
        content += delta.content;
        if (!signal?.aborted) {
          onContentDelta?.(delta.content);
          this.trace?.update(span, { streamChunk: delta.content });
        }
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, type: "function", function: { name: "", arguments: "" } };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line || !line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            handleChunk(JSON.parse(payload));
          } catch {
            /* ignore malformed keep-alive lines */
          }
        }
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
    }

    return { content, toolCalls: toolCalls.filter(Boolean), finishReason, usage, model };
  }
}
