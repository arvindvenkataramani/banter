// The selection check (docs/reference/design/service-apis.md, "Selections"): a voice
// selection passes when the service it names has the capability the selection
// is for and declares a candidate provision for the operation.

import { candidates, select } from "../../../shared/apis/select";
import type { Capability, Operation, SelectableService } from "../../../shared/apis/types";
import type { Service, SttModel } from "../../../shared/types";

/** Selection's refusal for the operation, or undefined when the service has a candidate. */
function refusal(operation: Operation, service: SelectableService, needs: Capability[]): string | undefined {
  if (candidates(operation, service, needs, []).length > 0) return undefined;
  try {
    select(operation, service, needs, []);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return undefined;
}

/** Why the service cannot be the TTS selection, or undefined when it can. */
export function ttsSelectionError(service: SelectableService): string | undefined {
  return refusal("synthesize", service, []);
}

/** Why the service cannot be the STT selection for a model of this kind, or
 *  undefined when it can. No kind (no model stored) takes either operation. */
export function sttSelectionError(service: SelectableService, kind: SttModel["kind"] | undefined): string | undefined {
  const stream = () => refusal("transcribeStream", service, ["client-endpointing"]);
  const batch = () => refusal("transcribe", service, []);
  if (kind === "streaming") return stream();
  if (kind === "batch") return batch();
  if (stream() === undefined || batch() === undefined) return undefined;
  const declared = (service.provides ?? []).map(p => p.api).join(", ") || "no API";
  return `${service.id} cannot transcribe or transcribeStream: it provides ${declared}`;
}

export interface StoredSelectionErrors {
  tts?: string;
  stt?: string;
}

export interface StoredSelections {
  ttsServiceId?: string;
  sttServiceId?: string;
  sttModel?: string;
}

/** The check over the stored voice selections. A service not yet known while
 *  some shard has never been polled, or one on a never-polled host, fails nothing. */
export function storedSelectionErrors(
  stored: StoredSelections,
  services: Service[],
  sttModels: SttModel[],
  neverPolledHosts: string[],
): StoredSelectionErrors {
  const check = (serviceId: string | undefined, capabilityId: "tts" | "stt", ifCapable: (service: Service) => string | undefined): string | undefined => {
    if (!serviceId) return undefined;
    const service = services.find(s => s.id === serviceId);
    if (!service) return neverPolledHosts.length > 0 ? undefined : `${serviceId} is not a registered service`;
    if (neverPolledHosts.includes(service.hostId)) return undefined;
    if (service.capabilityId !== capabilityId) return `${serviceId} is not a ${capabilityId.toUpperCase()} service`;
    return ifCapable(service);
  };
  const kind = sttModels.find(m => m.id === stored.sttModel)?.kind;
  const errors: StoredSelectionErrors = {};
  const tts = check(stored.ttsServiceId, "tts", ttsSelectionError);
  const stt = check(stored.sttServiceId, "stt", service => sttSelectionError(service, kind));
  if (tts) errors.tts = tts;
  if (stt) errors.stt = stt;
  return errors;
}

/** Logs each stored selection's failure with console.warn, once each time it
 *  starts failing or its message changes. */
export function createSelectionLog(): (errors: StoredSelectionErrors) => void {
  const last: StoredSelectionErrors = {};
  return errors => {
    for (const key of ["tts", "stt"] as const) {
      const error = errors[key];
      if (error && error !== last[key]) console.warn(`selection: the stored ${key.toUpperCase()} selection fails: ${error}`);
      last[key] = error;
    }
  };
}
