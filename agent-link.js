// agent-link.js - the bridge between the DeckCast page (deck.js) and the
// booted agent engine (site.js). The engine is only available after the
// async boot in site.js, and deck.js cannot import site.js (site.js imports
// deck.js), so the link lives in this small module both sides import.
// In Node (unit tests) the link stays empty unless a test injects a stub
// engine. No DOM access here, so it is safe to import in Node.
export const agentLink = {
  engine: null,
  modelVerified: false,
  verifiedModel: "",
  modelError: "",
  onModelStateChange: null, // site.js sets this to refresh the build status line
};

export function setAgentEngine(engine) {
  agentLink.engine = engine || null;
}

// A real model is configured when the runtime is not in demo mode and a
// real provider key is present. "demo" is the placeholder the runtime uses
// when no key was saved. Verification is separate: the key is only verified
// once a model call succeeds, which the trace listener in site.js records.
export function hasRealModel() {
  const engine = agentLink.engine;
  return !!engine && !engine.mockLLM && !!engine.byokKey && engine.byokKey !== "demo";
}

export function setModelVerified(model) {
  agentLink.modelVerified = true;
  agentLink.verifiedModel = model || "";
  agentLink.modelError = "";
  if (typeof agentLink.onModelStateChange === "function") agentLink.onModelStateChange();
}

export function setModelError(reason) {
  agentLink.modelVerified = false;
  agentLink.modelError = reason || "";
  if (typeof agentLink.onModelStateChange === "function") agentLink.onModelStateChange();
}

export function resetAgentLink() {
  agentLink.engine = null;
  agentLink.modelVerified = false;
  agentLink.verifiedModel = "";
  agentLink.modelError = "";
}
