// How the engine calls a service: which of its declared APIs performs an operation, and the
// loads and unloads the declarations call for (dev/specs/service-apis.md, sections 6, 7 and 11).
// Every request goes through an adapter in shared/apis; nothing here knows a path.

import { adapterFor } from '@platform/shared/apis'
import { candidates } from '@platform/shared/apis/select'
import * as declaredCall from '@platform/shared/apis/adapters/declared-call'
import type { CallDecision } from '@platform/shared/apis/loading'
import type { Capability, ModelLoading, Provision, SelectableService } from '@platform/shared/apis/types'

/** What the served config says of a service: its id and how it is called. */
export interface ServiceEntry {
  serviceId: string
  provides?: Provision[]
  models?: ModelLoading
}

export const toService = (entry: ServiceEntry): SelectableService => ({ id: entry.serviceId, provides: entry.provides, models: entry.models })

/** Whether `voice.stt.encodings` puts Opus ahead of 16-bit PCM, or lists it alone. Absent means Opus first. */
export function opusFirst(encodings?: ('opus' | 'pcm16')[]): boolean {
  const list = encodings ?? ['opus', 'pcm16']
  const opus = list.indexOf('opus')
  const pcm = list.indexOf('pcm16')
  return opus >= 0 && (pcm < 0 || opus < pcm)
}

/** The ranking preferences for streaming transcription: Opus when preferred, then take-over. */
export function streamPreferences(encodings?: ('opus' | 'pcm16')[]): Capability[] {
  return opusFirst(encodings) ? ['opus', 'takeover'] : ['takeover']
}

/** What a model load is asked for: the name on the wire, and the mode and variant a streaming model takes. */
export interface LoadTarget {
  endpoint: string
  service: SelectableService
  /** The model's name on the wire. */
  model: string
  mode?: string
  variant?: string
}

/** Performs a load or unload the declarations decided on. A refusal rejects with the server's own text. */
export async function perform(decision: CallDecision, kind: 'load' | 'unload', target: LoadTarget): Promise<void> {
  if (decision === 'none') return
  if (decision.call === 'declared') {
    const call = kind === 'load' ? target.service.models?.load : target.service.models?.unload
    if (!call) return
    await (kind === 'load' ? declaredCall.loadModel : declaredCall.unloadModel)({ endpoint: target.endpoint, call, model: target.model })
    return
  }
  const adapter = adapterFor(decision.provision.api)
  const base = { endpoint: target.endpoint, provision: decision.provision, model: target.model }
  if (kind === 'load') await adapter?.loadModel?.({ ...base, mode: target.mode, variant: target.variant })
  else await adapter?.unloadModel?.(base)
}

/** The WebSocket paths, below the endpoint, of the streaming provisions a service can be used through. */
export function streamPaths(entry: ServiceEntry): string[] {
  const paths = candidates('transcribeStream', toService(entry), ['client-endpointing'], [])
    .map((c) => c.adapter.streamPath?.(c.provision))
    .filter((p): p is string => p !== undefined)
  return [...new Set(paths)]
}
