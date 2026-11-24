// The generic adapter for a service that declares its load and unload calls under `models`.

import { failure, trimEndpoint } from "./http";
import type { DeclaredCall } from "../types";

export interface DeclaredCallArgs {
  endpoint: string;
  call: DeclaredCall;
  /** The model's name on the wire, which `{model}` stands for. */
  model: string;
}

const fill = (template: string, model: string): string => template.split("{model}").join(model);

async function run({ endpoint, call, model }: DeclaredCallArgs): Promise<void> {
  let url = `${trimEndpoint(endpoint)}${fill(call.path, encodeURIComponent(model))}`;
  if (call.query) {
    const query = new URLSearchParams(Object.entries(call.query).map(([k, v]) => [k, fill(v, model)]));
    url += `?${query}`;
  }
  const body = call.body && Object.fromEntries(Object.entries(call.body).map(([k, v]) => [k, fill(v, model)]));
  const res = await fetch(url, {
    method: call.method,
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw await failure(res);
}

export const loadModel = run;
export const unloadModel = run;
