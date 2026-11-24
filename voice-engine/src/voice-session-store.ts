import { create } from 'zustand'
import type { VoiceSession } from './session'
import { candidates } from '@platform/shared/apis/select'
import type { Provision } from '@platform/shared/apis/types'
import type { Adapter } from '@platform/shared/apis'
import type { SttTransport } from './human/stt-transport'
import { BatchSttTransport } from './human/stt-transport-batch'
import { StreamingSttTransport, type StreamingCloseInfo } from './human/stt-transport-streaming'
import { toService, type ServiceEntry } from './service-calls'
import type { SttModelEntry, VoiceConfig, VoiceSelection } from './voice-config'

// The voice system's whole lifetime — including the service-level state Chat
// used to hold as local React state (config, selection, endpoints) — lives
// here, module-scope, so it survives ChatPage unmounting. ChatPage still
// reads this store for its own UI, but it no longer *is* the state.
//
// The gateway session itself is not created here: useSessionManager() (and
// the SessionManager it builds) stays exactly where it is, inside ChatPage,
// because moving it up would fork chat's session architecture. Instead
// ChatPage *publishes* its activeSession into this store whenever it
// changes, and the voice system reads it from here. Publishing never clears
// on ChatPage unmount — only voice-off or a genuine connection loss should
// end the session (H9); a mere navigation must not.

interface VoiceSessionState {
  /** ChatPage's current activeSession, republished on every change. Retained
   * across ChatPage unmounts — see header comment. */
  session: VoiceSession | null
  voiceConfig: VoiceConfig | null
  voiceSelection: VoiceSelection | null
  ttsEndpoint: string | null
  sttEndpoint: string | null
}

export const useVoiceSessionStore = create<VoiceSessionState>(() => ({
  session: null,
  voiceConfig: null,
  voiceSelection: null,
  ttsEndpoint: null,
  sttEndpoint: null,
}))

export function publishSession(session: VoiceSession | null): void {
  useVoiceSessionStore.setState({ session })
}

export function setVoiceConfig(config: VoiceConfig | null): void {
  useVoiceSessionStore.setState({ voiceConfig: config })
}

export function setVoiceSelection(selection: VoiceSelection | null): void {
  useVoiceSessionStore.setState({ voiceSelection: selection })
}

export function setSttEndpoint(endpoint: string | null): void {
  useVoiceSessionStore.setState({ sttEndpoint: endpoint })
}

/** The routes a service offers a speech-to-text model: batch, and streaming where the client decides where an utterance ends. */
function routes(option: ServiceEntry): { batch: boolean; streaming: boolean } {
  const service = toService(option)
  return {
    batch: candidates('transcribe', service, [], []).length > 0,
    streaming: candidates('transcribeStream', service, ['client-endpointing'], []).length > 0,
  }
}

/**
 * Which way to bring a model up, and therefore which transport will serve it.
 *
 * A model that does one thing decides this itself. A model that does both is
 * decided by the routes the selected service offers, and where it offers both,
 * by `voice.stt.preferStreaming`: stated once, as a standing preference, because
 * the two differ in latency and accuracy and a silent choice cannot be seen
 * having been made. Without it, batch, the more accurate of the two.
 */
export function resolveSttMode(
  option: ServiceEntry,
  model: Pick<SttModelEntry, 'kind'> | undefined,
  preferStreaming?: boolean,
): 'batch' | 'streaming' {
  if (model?.kind === 'streaming') return 'streaming'
  if (model?.kind === 'batch') return 'batch'
  if (model?.kind === 'both') {
    const { batch, streaming } = routes(option)
    if (streaming && !batch) return 'streaming'
    if (batch && !streaming) return 'batch'
    return preferStreaming ? 'streaming' : 'batch'
  }
  return 'batch'
}

/**
 * What settled `resolveSttMode`'s answer: the `preferStreaming` choice, for a
 * model that does both over a service that offers both routes; the model or the
 * service, where only one way was open; or nothing known, where the roster
 * declares no such model and batch is the fallback.
 */
export function sttModeSource(option: ServiceEntry, model: Pick<SttModelEntry, 'kind'> | undefined): 'choice' | 'model' | 'unknown' {
  if (!model) return 'unknown'
  if (model.kind !== 'both') return 'model'
  const { batch, streaming } = routes(option)
  return batch && streaming ? 'choice' : 'model'
}

/**
 * Which latency tier to load, for a model that offers a choice: a value of its
 * declared `chunkMs` parameter.
 *
 * A model declaring tiers refuses a load naming none, so this always answers
 * where there is something to answer. A configured tier the model does not
 * offer is not silently corrected into a neighbour: it is ignored in favour
 * of the model's own smallest, and said aloud, because a tier quietly
 * different from the one asked for is a latency nobody can account for.
 */
export function resolveChunkMs(
  model: Pick<SttModelEntry, 'params'> | undefined,
  configured?: number,
): number | undefined {
  const offered = model?.params?.find((p) => p.name === 'chunkMs')?.values
  if (!offered?.length) return undefined
  if (configured !== undefined && offered.includes(configured)) return configured
  const fallback = Math.min(...offered)
  if (configured !== undefined) {
    console.warn(
      `[voice] chunkMs ${configured} is not offered (${offered.join(', ')}) — loading ${fallback}`,
    )
  }
  // The smallest tier: most frequent interim text, which is what streaming is
  // for. A larger one is an explicit choice.
  return fallback
}

/**
 * Build the transport for this session. Built here rather than in the loop
 * because a streaming socket outlives every utterance on it, and everything in
 * the loop is per-session and dies with it.
 *
 * `mode` is what the load decided, where there was a load: deciding again would
 * be a second decision, and two decisions can differ. `null` (no model
 * configured) falls back to the batch transport. `model` is the serving's key,
 * and `provision` the one of the selected service that performs the call.
 */
export async function createSttTransport(opts: {
  endpoint: string
  serviceId?: string
  model?: string
  mode: 'batch' | 'streaming' | null
  /** The provision selection chose for this call, and for a stream its adapter. */
  provision: Provision
  adapter?: Adapter
  /** The formats the browser may send, most preferred first. */
  encodings?: ('opus' | 'pcm16')[]
  /** Starts the STT service and returns its endpoint, for the batch transport's retry. */
  ensureServiceReady: (serviceId: string) => Promise<string>
  /** The model's latency tier, for a streaming model that takes one. */
  chunkMs?: number
  /** This connection's session id. Only meaningful for a streaming
   *  transport; batch never sends one. */
  sessionId?: string
  /** Take the slot from whoever holds it. Only meaningful alongside `sessionId`. */
  takeover?: boolean
  /** The transcript as it currently stands, raw — the caller (`HumanVoice`)
   * writes it to the transcript store; this module never reaches that store
   * directly. Batch has no partial and never calls it. */
  onPartial?: (text: string) => void
  /** A streaming transport's socket was accepted. Batch has no socket and never calls it. */
  onReady?: () => void
  /** A streaming transport's socket ended. Batch has no socket and never calls it. */
  onClosed: (reason: string, info: StreamingCloseInfo) => void
}): Promise<SttTransport> {
  if (!opts.model || opts.mode === null) {
    // Without a model named, nothing was loaded and nothing can stream: the
    // server loads only its roster default on demand. Say so, since the
    // symptom otherwise is voice that works but never streams.
    if (!opts.model) console.warn('[voice] no voice.stt.model configured — using the batch transport')
    return new BatchSttTransport({
      endpoint: opts.endpoint,
      provision: opts.provision,
      serviceId: opts.serviceId,
      ensureServiceReady: opts.ensureServiceReady,
      onEndpointChange: setSttEndpoint,
    })
  }

  if (opts.mode === 'streaming') {
    if (!opts.adapter) throw new Error('No streaming adapter was selected for the transcription service.')
    return new StreamingSttTransport({
      endpoint: opts.endpoint,
      model: opts.model,
      chunkMs: opts.chunkMs,
      provision: opts.provision,
      adapter: opts.adapter,
      encodings: opts.encodings,
      session: opts.sessionId,
      takeover: opts.takeover,
      onPartial: (text) => opts.onPartial?.(text),
      onReady: opts.onReady,
      onClosed: opts.onClosed,
    })
  }

  return new BatchSttTransport({
    endpoint: opts.endpoint,
    provision: opts.provision,
    model: opts.model,
    serviceId: opts.serviceId,
    ensureServiceReady: opts.ensureServiceReady,
    onEndpointChange: setSttEndpoint,
  })
}
