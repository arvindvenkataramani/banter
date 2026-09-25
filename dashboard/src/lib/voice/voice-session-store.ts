import { create } from 'zustand'
import type { Session } from '../session'
import type { SttTransport } from './human/stt-transport'
import type { SttModelKind } from './voice-service'
import { BatchSttTransport } from './human/stt-transport-batch'
import { StreamingSttTransport, type StreamingCloseInfo } from './human/stt-transport-streaming'
import type { VoiceConfig, VoiceSelection } from './voice-config'

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
  session: Session | null
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

export function publishSession(session: Session | null): void {
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

/** What a model's server says about it. Absent fields mean it said nothing. */
export interface SttModelFacts {
  kind?: SttModelKind
  /**
   * The routes this model is reached over. A set rather than one value: a
   * model that does both is genuinely served over the transcription endpoint
   * and the socket.
   */
  transport?: Array<'http' | 'websocket'>
  /** Whether every component the model needs is on disk. */
  present?: boolean
  /**
   * The values of the model's declared `chunkMs` parameter, where it offers a
   * choice. Where the roster maps each value to a variant, a load giving none
   * leaves the variant unresolved and is refused: the server will not pick a
   * latency for the caller.
   */
  chunkSizesMs?: number[]
}

/**
 * Ask the STT service what a model is and how it is reached.
 *
 * Kind and transport are read separately because they are separate facts: one
 * describes the model, the other the route to it. Nothing is inferred from the
 * other's absence — a server that says nothing has not said "batch", and
 * collapsing those two would make a silent default impossible to distinguish
 * from an answer.
 */
export async function fetchSttModelFacts(endpoint: string, model: string): Promise<SttModelFacts> {
  try {
    const res = await fetch(`${endpoint}/v1/models`)
    if (!res.ok) return {}
    const body = await res.json() as {
      data?: Array<{
        id?: string
        kind?: string
        transport?: unknown
        present?: unknown
        params?: unknown
      }>
    }
    const entry = body.data?.find((m) => m.id === model)
    if (!entry) return {}

    const transport = Array.isArray(entry.transport)
      ? entry.transport.filter((t): t is 'http' | 'websocket' => t === 'http' || t === 'websocket')
      : undefined
    const chunkParam = Array.isArray(entry.params)
      ? (entry.params as Array<{ name?: unknown; values?: unknown }>).find((p) => p?.name === 'chunkMs')
      : undefined
    const chunkSizesMs = Array.isArray(chunkParam?.values)
      ? chunkParam.values.filter((n): n is number => typeof n === 'number')
      : undefined

    return {
      kind: entry.kind === 'batch' || entry.kind === 'streaming' || entry.kind === 'both'
        ? entry.kind
        : undefined,
      transport: transport?.length ? transport : undefined,
      present: typeof entry.present === 'boolean' ? entry.present : undefined,
      chunkSizesMs: chunkSizesMs?.length ? chunkSizesMs : undefined,
    }
  } catch {
    return {}
  }
}

/**
 * Which way to bring a model up, and therefore which transport will serve it.
 *
 * A model that does one thing decides this itself. A model capable of both
 * does not pick for itself — the two differ in latency and accuracy, and a
 * silent choice is one nobody can see having been made. `voice.stt.preferStreaming`
 * is where that choice is stated: once, as a standing preference, rather than
 * per model where it would have to be repeated and kept in step.
 *
 * Without it, batch — what this loop did before streaming existed, and the
 * more accurate of the two.
 */
export function resolveSttMode(
  facts: SttModelFacts,
  preferStreaming?: boolean,
): 'batch' | 'streaming' {
  if (facts.kind === 'streaming') return 'streaming'
  if (facts.kind === 'batch') return 'batch'
  if (facts.kind === 'both') return preferStreaming ? 'streaming' : 'batch'
  // The server said nothing about kind. Its transports answer if it gave any:
  // a model offering only the socket streams, and one offering both routes
  // without saying what it is falls to the preference, as a `both` kind would.
  const routes = facts.transport
  if (routes?.length) {
    const socket = routes.includes('websocket')
    const http = routes.includes('http')
    if (socket && !http) return 'streaming'
    if (http && !socket) return 'batch'
    return preferStreaming ? 'streaming' : 'batch'
  }
  // Nothing known: a server that answered neither, or one that could not be
  // reached. Batch is what this loop did before streaming existed.
  return 'batch'
}

/**
 * Which latency tier to load, for a model that offers a choice.
 *
 * A model declaring tiers refuses a load naming none, so this always answers
 * where there is something to answer. A configured tier the model does not
 * offer is not silently corrected into a neighbour — it is ignored in favour
 * of the model's own smallest, and said aloud, because a tier quietly
 * different from the one asked for is a latency nobody can account for.
 */
export function resolveChunkMs(
  facts: SttModelFacts,
  configured?: number,
): number | undefined {
  const offered = facts.chunkSizesMs
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
 * `mode` is what the load decided, where there was a load — asking the server
 * again would be a second decision, and two decisions can differ. `null` (no
 * model configured) falls back to the batch transport.
 */
export async function createSttTransport(opts: {
  endpoint: string
  serviceId?: string
  model?: string
  mode: 'batch' | 'streaming' | null
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
    // server starts holding nothing and never loads implicitly. Say so, since
    // the symptom otherwise is voice that works but never streams.
    if (!opts.model) console.warn('[voice] no voice.stt.model configured — using the batch transport')
    return new BatchSttTransport({
      endpoint: opts.endpoint,
      serviceId: opts.serviceId,
      onEndpointChange: setSttEndpoint,
    })
  }

  if (opts.mode === 'streaming') {
    return new StreamingSttTransport({
      endpoint: opts.endpoint,
      model: opts.model,
      session: opts.sessionId,
      takeover: opts.takeover,
      onPartial: (text) => opts.onPartial?.(text),
      onReady: opts.onReady,
      onClosed: opts.onClosed,
    })
  }

  return new BatchSttTransport({
    endpoint: opts.endpoint,
    serviceId: opts.serviceId,
    onEndpointChange: setSttEndpoint,
  })
}
