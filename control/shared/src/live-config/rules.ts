// Repair rules: each fires only on the old shape, so a second run changes nothing.

import type { RepairRule } from "./sync";

type Doc = Record<string, unknown>;
const isObject = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);

// Rewrites `main` of each process runner in the document's services.
function rewriteMains(doc: Doc, rewrite: (main: string) => string): boolean {
  if (!Array.isArray(doc.services)) return false;
  let changed = false;
  for (const svc of doc.services) {
    if (!isObject(svc) || !isObject(svc.runner)) continue;
    const runner = svc.runner;
    if (runner.type !== "process" || typeof runner.main !== "string") continue;
    const next = rewrite(runner.main);
    if (next !== runner.main) {
      runner.main = next;
      changed = true;
    }
  }
  return changed;
}

export const literalPortRule: RepairRule = {
  name: "literal-port",
  apply: doc => rewriteMains(doc, main => main.replace(/--port([= ])\d+/g, "--port$1{port}")),
};

export const registryPathRule: RepairRule = {
  name: "registry-path",
  // Only path-shaped values (a leading / or ~/); a URL after --registry belongs to some other tool.
  apply: doc => rewriteMains(doc, main => main.replace(/--registry (?:\/|~\/)\S*/g, "--registry {registry}")),
};

export function moveRuntimeState(config: Doc, state: Doc): boolean {
  const openclaw = isObject(config.integrations) ? config.integrations.openclaw : undefined;
  if (!isObject(openclaw)) return false;
  let changed = false;
  if ("defaultAgent" in openclaw) {
    if (!("lastAgent" in state)) state.lastAgent = openclaw.defaultAgent;
    delete openclaw.defaultAgent;
    changed = true;
  }
  if ("lastSessionByAgent" in openclaw) {
    // Per agent, so a state that already holds some sessions keeps them and gains the rest.
    state.lastSessionByAgent = { ...(isObject(openclaw.lastSessionByAgent) ? openclaw.lastSessionByAgent : {}), ...(isObject(state.lastSessionByAgent) ? state.lastSessionByAgent : {}) };
    delete openclaw.lastSessionByAgent;
    changed = true;
  }
  return changed;
}
