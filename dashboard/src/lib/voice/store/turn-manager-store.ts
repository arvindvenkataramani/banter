// Design: docs/components/voice-turn-taking.md

import { create } from 'zustand'
import { initialTurnManagerState, reduce, snapshot } from '../turn-manager'
import type { TurnManagerState, TurnManagerConfig, Report, Snapshot } from '../turn-manager'
import type { SessionControls } from '../../controls'
import { takeTranscript } from './transcript-store'

export interface TurnManagerStoreState {
  state: TurnManagerState
  snapshot: Snapshot
}

export const useTurnManagerStore = create<TurnManagerStoreState>(() => ({
  state: initialTurnManagerState(),
  snapshot: snapshot(initialTurnManagerState()),
}))

/** The single writer: reduce, snapshot, setState. */
export function report(r: Report): void {
  const current = useTurnManagerStore.getState().state
  const next = reduce(current, r)
  if (next === current) return
  useTurnManagerStore.setState({ state: next, snapshot: snapshot(next) })
}

/** Back to initialTurnManagerState(), keeping the configured threshold; teardown and tests.
 * The composer's send count restarts with it, since the reducer compares the
 * next composer report against a baseline of zero. */
export function resetTurnManager(): void {
  composerSends = 0
  const state = initialTurnManagerState(useTurnManagerStore.getState().state.config)
  useTurnManagerStore.setState({ state, snapshot: snapshot(state) })
}

/** Writes the interruption threshold into state.config. */
export function configureTurnManager(c: TurnManagerConfig): void {
  const current = useTurnManagerStore.getState().state
  const next = { ...current, config: c }
  useTurnManagerStore.setState({ state: next, snapshot: snapshot(next) })
}

// --- The conversation ----------------------------------------------------
//
// The turn manager's two writes to the conversation, made on the human's
// behalf: delivering a finished human turn, and aborting a run the human
// interrupted. Both read the snapshot a reduction produced and report
// nothing back, so the reduction stays pure. The memory here — which
// utterances have been delivered, which runs aborted — is what lets them
// reconcile to levels: every later snapshot still says the turn is sent or
// the agent superseded, and each must act once.

/** What the turn manager needs of a session: somewhere to send a finished
 * turn, and a way to stop the run a human interrupted. */
export interface SendableSession {
  controls: Pick<SessionControls, 'send' | 'abort'>
}

let session: SendableSession | null = null
let unsubscribe: (() => void) | null = null
const aborted = new Set<string>()
/** The composer's own send-count memory, reported as a level per the spec's
 * shape. Incremented and reported together by `reportComposerSend`. */
let composerSends = 0

/** Starts acting on the conversation for `session`. Attaching delivers
 * nothing: only a transition to `sent` observed *after* this call counts,
 * so a remount (a new Session for an already-running pipeline) never sends
 * a turn's words as a draft merely because it was already sitting `sent`
 * at the moment of attach — the current snapshot is the subscriber's
 * baseline `prev` for its very first notification, not a fabricated empty
 * one. The abort reconciliation runs once immediately regardless, since an
 * agent turn already superseded/preempted with its run still active is a
 * standing fact this attach should act on right away, not wait for the
 * next unrelated snapshot to notice. Re-attaching to a new session (the
 * pipeline's own session-identity change, without a stop/start of the
 * pipeline itself) keeps the memory, so a turn already sent to the old
 * session is not resent to the new one. */
export function attachSession(s: SendableSession): void {
  session = s
  if (unsubscribe === null) {
    unsubscribe = useTurnManagerStore.subscribe((state, prev) => reconcileConversation(state.snapshot, prev.snapshot))
  }
  abortInterrupted(useTurnManagerStore.getState().snapshot)
}

export function detachSession(): void {
  unsubscribe?.()
  unsubscribe = null
  session = null
  aborted.clear()
}

/** The composer reports a send: increments and reports the level. */
export function reportComposerSend(): void {
  composerSends += 1
  report({ actor: 'composer', sends: composerSends, focused: lastComposerFocused() })
}

/** The composer reports its own focus state, on focus and blur. */
export function reportComposerFocus(focused: boolean): void {
  report({ actor: 'composer', sends: composerSends, focused })
}

function lastComposerFocused(): boolean {
  const r = useTurnManagerStore.getState().state.last.composer
  return r && r.actor === 'composer' ? r.focused : false
}

function reconcileConversation(snap: Snapshot, prev: Snapshot): void {
  abortInterrupted(snap)
  deliverHumanTurn(snap, prev)
}

/** An agent turn a confirmed human utterance ended, while its run is still
 * going: stop the run, once per turn. */
function abortInterrupted(snap: Snapshot): void {
  const agent = snap.agent
  if (!session || agent === null) return
  if (agent.outcome !== 'superseded' && agent.outcome !== 'preempted') return
  if (snap.activity === 'idle' || aborted.has(agent.id)) return
  aborted.add(agent.id)
  session.controls.abort().catch(() => {})
}

/**
 * Delivers a human turn the instant it newly closes `sent` — not on every
 * snapshot that continues to report that outcome. The transcript store's
 * `settled` is also the composer's own live field, so a level subscription
 * would resend whatever the person typed into it on any later, unrelated
 * snapshot (the player's own ~4Hz reports during agent playback chief among
 * them) for as long as the turn sits closing. Comparing against the
 * previous snapshot is what limits the take to the edge.
 *
 * A turn ending `rejected` or `abandoned` delivers nothing and touches the
 * transcript not at all — `HumanVoice` has already settled or discarded
 * whatever words survive, at the transcription's own return.
 */
function deliverHumanTurn(snap: Snapshot, prev: Snapshot): void {
  const turn = snap.human
  if (turn === null || turn.outcome !== 'sent') return
  const prevTurn = prev.human
  const alreadyDelivered = prevTurn !== null && prevTurn.id === turn.id && prevTurn.outcome === 'sent'
  if (alreadyDelivered) return
  if (!session) return
  const text = takeTranscript()
  if (!text) return
  session.controls.send(text, { annotation: snap.annotation ?? undefined }).catch(() => {})
}
