import { failure, trimEndpoint } from "./http";
import type { AdapterDeclaration, Provision } from "../types";

export const declaration: AdapterDeclaration = {
  api: "triton.model-repository",
  operations: ["loadModel", "unloadModel"],
  requires: { loadModel: ["route:load"], unloadModel: ["route:unload"] },
  uses: { loadModel: ["resident-slot"], unloadModel: ["resident-slot"] },
  capabilities: {},
};

export interface LoadCall {
  endpoint: string;
  provision: Provision;
  /** The model's name on the wire. */
  model: string;
  mode?: string;
  variant?: string;
}

export interface UnloadCall {
  endpoint: string;
  provision: Provision;
  model: string;
}

async function post(call: UnloadCall, action: "load" | "unload", body?: unknown): Promise<void> {
  const url = `${trimEndpoint(call.endpoint)}${call.provision.basePath ?? ""}/v2/repository/models/${encodeURIComponent(call.model)}/${action}`;
  const res = await fetch(url, {
    method: "POST",
    ...(body !== undefined && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw await failure(res);
}

/** Mode and variant travel as load parameters, and only where the provision declares resident-slot. */
export function loadModel(call: LoadCall): Promise<void> {
  const parameters: Record<string, string> = {};
  if (call.provision.extends?.includes("resident-slot")) {
    if (call.mode !== undefined) parameters.mode = call.mode;
    if (call.variant !== undefined) parameters.variant = call.variant;
  }
  return post(call, "load", { parameters });
}

export function unloadModel(call: UnloadCall): Promise<void> {
  return post(call, "unload");
}
