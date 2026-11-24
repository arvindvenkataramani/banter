// When Banter makes an explicit load or unload call (dev/specs/service-apis.md, section 7).

import { adapterFor } from "./index";
import { capabilityHolds, type Selection } from "./select";
import type { Operation, Provision, SelectableService } from "./types";

export type CallDecision = "none" | { call: "adapter"; provision: Provision } | { call: "declared" };

/** The roster fields of a model that the decision reads. */
export interface LoadableModel {
  variants?: unknown[];
}

const SESSION_OPERATIONS: Operation[] = ["transcribeStream"];

/** The call that performs `operation` for the service: a provision's adapter first, else the declared call. */
function callFor(service: SelectableService, operation: "loadModel" | "unloadModel"): CallDecision {
  const provision = service.provides?.find(p => adapterFor(p.api)?.operations.includes(operation));
  if (provision) return { call: "adapter", provision };
  const declared = operation === "loadModel" ? service.models?.load : service.models?.unload;
  return declared ? { call: "declared" } : "none";
}

/** Whether to load `model` explicitly before the call `selected` describes, and through which call. */
export function decideLoad(
  service: SelectableService,
  model: LoadableModel,
  selected: Selection,
  preload: boolean,
): CallDecision {
  const models = service.models;
  if (!models || models.loading === "none") return "none";

  const explicit = (): CallDecision => callFor(service, "loadModel");
  if (models.autoLoad === "never") return explicit();
  if (model.variants?.length && !capabilityHolds(selected.provision, selected.adapter, "carries-variant")) return explicit();
  if (SESSION_OPERATIONS.includes(selected.operation) && !capabilityHolds(selected.provision, selected.adapter, "session-loads")) return explicit();
  return models.autoLoad === "always" && preload ? explicit() : "none";
}

/** The unload of the model being left, for a service that holds many and has an unload call. */
export function decideUnload(service: SelectableService, _leaving: LoadableModel): CallDecision {
  if (service.models?.resident !== "many") return "none";
  return callFor(service, "unloadModel");
}
