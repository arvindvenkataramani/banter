// Design: docs/components/voice-turn-taking.md

import type { Activity } from '../run-state'

export type Speaker = 'human' | 'agent'
export type Actor = 'human' | 'agent' | 'conversation' | 'controls' | 'composer' | 'mode'

// One shape for both speakers. Each proxy reports its speaker's current or
// most recent utterance; the phase lists and outcome sets differ by speaker.
export type UtterancePhase = {
  human: 'hearing' | 'paused' | 'transcribing' | 'ended'
  agent: 'audible' | 'paused' | 'ended'
}
export type UtteranceOutcome = {
  human: 'transcribed' | { rejected: 'empty' | 'failed' } | 'abandoned'
  agent: 'completed' | 'cut'
}
export type Utterance<S extends Speaker> = {
  speaker: S
  id: string
  phase: UtterancePhase[S]
  outcome?: UtteranceOutcome[S]
  transcript?: string
}

// How much audio the player has and expects.
export type AudioSupply = {
  run: string | null
  mounted: boolean
  pending: number
  remaining: number
}

export type ConversationReport = { known: boolean; runActive: boolean; runId: string | null; activity: Activity }
export type ControlsReport = { micMuted: boolean; speechMuted: boolean; autoMuted: boolean }
export type Mode = 'starting' | 'live' | 'muted' | 'ending' | 'off'

export type Report =
  | { actor: 'human'; utterance: Utterance<'human'> | null }
  | { actor: 'agent'; utterance: Utterance<'agent'> | null; supply: AudioSupply }
  | { actor: 'conversation'; conversation: ConversationReport }
  | { actor: 'controls'; controls: ControlsReport }
  | { actor: 'mode'; mode: Mode }
  | { actor: 'composer'; sends: number; focused: boolean }

// One shape for both speakers. A turn is the turn manager's construct; no actor reports one.
export type TurnOutcome = {
  human: 'sent' | 'rejected' | 'abandoned'
  agent: 'completed' | 'superseded' | 'preempted' | 'unvoiced' | 'cancelled'
}
export type Turn<S extends Speaker> = {
  speaker: S
  id: string
  phase: 'opening' | 'speaking' | 'closing' | 'ended'
  utterances: Utterance<S>[]
  outcome?: TurnOutcome[S]
  /**
   * Human turns only: the agent turn current when this turn entered closing,
   * or null if none was. The rules that end a closing human turn name the
   * agent turn *that opened after it*, and that relation is not otherwise
   * recoverable — a later agent turn is told apart from the one already
   * running by its id differing from this. Recorded by identity, not
   * liveness, so an agent turn already ended at the transition still counts
   * as the one closed over. Cleared on a reopen, which re-records it at the
   * next closing.
   */
  agentAtClosing?: string | null
  /**
   * Human turns only: the composer was focused with this turn open, and no
   * new utterance has been heard since. A held turn does not close by voice.
   */
  held?: boolean
  /**
   * Human turns only: the send button was pressed with this turn open. It
   * closes as sent once nothing in it is live, whatever it holds and
   * whether or not it is held or the mic is muted.
   */
  sendPending?: boolean
}

// What the turn manager remembers between the two turns.
export type Relations = {
  // `working` is runActive at the moment of interruption: the annotation
  // reads it because the interruption's own abort ends the run before the send.
  interruption: null | { phase: 'opening' | 'speaking' | 'closing'; remaining: number; working: boolean }
  pauseReason: null | 'speechMuted'
  agentVoiced: boolean
}

// The last turn each speaker ended, kept so an outcome outlives the turn that
// carried it. A turn replaced by a new one is still readable here.
export type Previous = {
  human: Turn<'human'> | null
  agent: Turn<'agent'> | null
}

export type TurnManagerState = {
  last: { [A in Actor]?: Report }
  human: Turn<'human'> | null
  agent: Turn<'agent'> | null
  previous: Previous
  relations: Relations
  config: TurnManagerConfig
}

export type Snapshot = {
  floor: Speaker | 'nobody'
  human: Turn<'human'> | null
  agent: Turn<'agent'> | null
  previous: Previous
  relations: Relations
  activity: Activity
  newAudio: 'play' | 'park' | 'discard'
  mayBeAudible: boolean
  annotation: 'interrupted-speaking' | 'interrupted-working' | null
  mode: Mode
  controls: ControlsReport
  composer: { focused: boolean }
}

export type TurnManagerConfig = { interruptionMinRemainingS: number }

const DEFAULT_TURN_MANAGER_CONFIG: TurnManagerConfig = { interruptionMinRemainingS: 0.5 }

const INITIAL_RELATIONS: Relations = {
  interruption: null,
  pauseReason: null,
  agentVoiced: false,
}

const INITIAL_CONTROLS: ControlsReport = { micMuted: false, speechMuted: false, autoMuted: false }

export function initialTurnManagerState(config: TurnManagerConfig = DEFAULT_TURN_MANAGER_CONFIG): TurnManagerState {
  return {
    last: {},
    human: null,
    agent: null,
    previous: { human: null, agent: null },
    relations: INITIAL_RELATIONS,
    config,
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

// Structural equality over the plain JSON-like shapes reports carry: objects,
// arrays, and primitives. Key order does not matter.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

function isLive(phase: string): boolean {
  return phase !== 'ended'
}

function lastMode(state: TurnManagerState): Mode {
  const r = state.last.mode
  return r && r.actor === 'mode' ? r.mode : 'off'
}

function lastControls(state: TurnManagerState): ControlsReport {
  const r = state.last.controls
  return r && r.actor === 'controls' ? r.controls : INITIAL_CONTROLS
}

function lastConversation(state: TurnManagerState): ConversationReport {
  const r = state.last.conversation
  return r && r.actor === 'conversation' ? r.conversation : { known: false, runActive: false, runId: null, activity: 'idle' }
}

function lastPlayer(state: TurnManagerState): { utterance: Utterance<'agent'> | null; supply: AudioSupply } {
  const r = state.last.agent
  if (r && r.actor === 'agent') return { utterance: r.utterance, supply: r.supply }
  return { utterance: null, supply: { run: null, mounted: false, pending: 0, remaining: 0 } }
}

function lastComposer(state: TurnManagerState): { sends: number; focused: boolean } {
  const r = state.last.composer
  return r && r.actor === 'composer' ? { sends: r.sends, focused: r.focused } : { sends: 0, focused: false }
}

function withLast(state: TurnManagerState, report: Report): TurnManagerState {
  return { ...state, last: { ...state.last, [report.actor]: report } }
}

// --- Human side -------------------------------------------------------

/**
 * Merges an incoming report onto the turn's utterance list. An utterance
 * already `ended` cannot be revived by a later report, whatever that report
 * claims: only its `transcript` is taken (row: "a transcript arriving on an
 * utterance already ended... is stored on it and changes no turn"), and
 * `phase`/`outcome` are left exactly as recorded. This holds regardless of
 * why the later report exists — a genuinely late transcript, or a reordered
 * or malformed one — because the turn manager's picture must stay coherent
 * under a report it did not expect, not only under the ones its own actors
 * are designed to send.
 */
function upsertHumanUtterance(turn: Turn<'human'>, utterance: Utterance<'human'>): Turn<'human'> {
  const idx = turn.utterances.findIndex((u) => u.id === utterance.id)
  if (idx === -1) return { ...turn, utterances: [...turn.utterances, utterance] }

  const existing = turn.utterances[idx]
  const merged: Utterance<'human'> =
    existing.phase === 'ended'
      ? (utterance.transcript !== undefined ? { ...existing, transcript: utterance.transcript } : existing)
      : { ...existing, ...utterance }
  const utterances = turn.utterances.map((u, i) => (i === idx ? merged : u))
  return { ...turn, utterances }
}

/**
 * A turn with a send pending closes as sent once nothing in it is live,
 * whatever its utterances hold and whether or not it is held or the mic is
 * muted — `sendPending` overrides both `held` and `micMuted` below. Absent
 * a pending send, a turn does not close by voice while held, and does not
 * close by voice while the mic is muted (a controls report unmuting the mic
 * re-applies this rule — the reducer's own unmute branch calls this
 * function again). Neither `held` nor `micMuted` stops a turn ending as
 * abandoned or rejected on its own — `held`/`micMuted` gate only the
 * `anyTranscribed` branch below, matching "a held human turn does not close
 * by voice and does not end as rejected."
 */
function humanTurnOutcomeAfter(
  turn: Turn<'human'>,
  held: boolean,
  micMuted: boolean,
  sendPending: boolean,
): { phase: Turn<'human'>['phase']; outcome?: TurnOutcome['human'] } {
  const anyAbandoned = turn.utterances.some((u) => u.outcome === 'abandoned')
  if (anyAbandoned) return { phase: 'ended', outcome: 'abandoned' }

  const anyLive = turn.utterances.some((u) => isLive(u.phase))
  if (anyLive) return { phase: 'speaking' }

  // "closes as sent once nothing in it is live, whatever its utterances
  // hold" — unconditional on anyTranscribed, unlike the ordinary path below.
  if (sendPending) return { phase: 'closing', outcome: 'sent' }

  // The hold and the mute keep a speaking turn from closing; a turn already
  // closing has sent, and nothing reopens it but new speech.
  if ((held || micMuted) && turn.phase === 'speaking') return { phase: 'speaking' }

  const anyTranscribed = turn.utterances.some((u) => u.outcome === 'transcribed')
  if (anyTranscribed) return { phase: 'closing', outcome: 'sent' }

  return { phase: 'ended', outcome: 'rejected' }
}

function recordInterruption(state: TurnManagerState): Relations['interruption'] {
  const agent = state.agent
  if (!agent || agent.phase === 'ended') return null
  const { supply } = lastPlayer(state)
  const phase = agent.phase as 'opening' | 'speaking' | 'closing'
  return { phase, remaining: supply.remaining, working: lastConversation(state).runActive }
}

function endAgentTurn(agent: Turn<'agent'>, outcome: TurnOutcome['agent']): Turn<'agent'> {
  return { ...agent, phase: 'ended', outcome }
}

/** A confirmed human utterance ends an open agent turn: superseded once it
 * has spoken, preempted before. The transcript plays no part. */
function interruptAgent(state: TurnManagerState): TurnManagerState {
  const agent = state.agent
  if (agent === null || agent.phase === 'ended') return state
  const ended = endAgentTurn(agent, agent.phase === 'opening' ? 'preempted' : 'superseded')
  return { ...state, agent: ended, previous: { ...state.previous, agent: ended } }
}

/**
 * Whether an ended agent turn is the one whose ending closes a human turn
 * waiting in closing: the turn that opened after that human turn closed,
 * which is any turn whose id differs from the one recorded there. A human
 * turn that closed with no agent turn open recorded null, so the first agent
 * turn to open and end answers it.
 */
function endsClosingHuman(agent: Turn<'agent'> | null, human: Turn<'human'> | null): boolean {
  if (agent === null || agent.phase !== 'ended') return false
  if (human === null || human.phase !== 'closing') return false
  return agent.id !== (human.agentAtClosing ?? null)
}

function reduceHumanReport(state: TurnManagerState, utterance: Utterance<'human'> | null): TurnManagerState {
  if (utterance === null) return state

  let human = state.human
  let previous = state.previous
  let relations = state.relations
  let agent = state.agent

  // A candidate is an onset: only a report whose phase is `hearing` and
  // whose id is unseen opens or joins a turn. Any other report is checked
  // against the two places an utterance can still be found and, failing
  // both, changes nothing — it is a late report (a transcript, or a stale
  // phase) trailing an utterance the turn machinery has already moved past.
  if (human !== null && human.utterances.some((u) => u.id === utterance.id)) {
    if (human.phase === 'ended') {
      // A late report on an already-ended turn (a transcript arriving after
      // abandonment) is stored on its utterance and opens no new turn. An
      // ended turn is also `previous.human`, and both copies take it, so the
      // transcript survives the next turn displacing this one.
      const ended = human
      human = upsertHumanUtterance(human, utterance)
      previous = previous.human?.id === ended.id ? { ...previous, human } : previous
      return { ...state, human, previous }
    }
    // Falls through to the open-turn path below — a `transcribing` report
    // on a known id is this same utterance settling, not a fresh
    // candidate. `hearing` never re-arrives on a known id in ordinary
    // operation (a hand-off is terminal, so every fresh `hearing` carries a
    // new id), but the branch stays general rather than assuming that.
  } else if (state.previous.human !== null && state.previous.human.utterances.some((u) => u.id === utterance.id)) {
    const prevHuman = upsertHumanUtterance(state.previous.human, utterance)
    return { ...state, previous: { ...state.previous, human: prevHuman } }
  } else if (utterance.phase !== 'hearing') {
    return state
  }

  // Every candidate interrupts whatever agent turn is open, whether it opens
  // a human turn, joins one or reopens one.
  const isCandidate = utterance.phase === 'hearing' && !(human?.utterances.some((u) => u.id === utterance.id) ?? false)

  if (human === null || human.phase === 'ended') {
    const opened: Turn<'human'> = { speaker: 'human', id: utterance.id, phase: 'speaking', utterances: [utterance] }
    relations = { ...relations, interruption: recordInterruption(state) }
    return interruptAgent({ ...state, human: opened, relations })
  }

  const before = human.phase
  human = upsertHumanUtterance(human, utterance)

  // A new utterance heard releases the hold — "a paused one resuming does
  // not," so only a genuine candidate (a fresh id, `isCandidate`) clears it.
  // sendPending is untouched here: a pending send survives until the turn
  // it belongs to actually closes, whatever utterances arrive meanwhile.
  const heldNow = isCandidate ? false : (human.held ?? false)
  const sendPendingNow = human.sendPending ?? false
  const result = humanTurnOutcomeAfter(human, heldNow, lastControls(state).micMuted, sendPendingNow)
  human = {
    ...human,
    phase: result.phase,
    outcome: result.outcome,
    held: heldNow,
    sendPending: result.phase === 'closing' || result.phase === 'ended' ? false : sendPendingNow,
  }

  if (before === 'closing' && human.phase === 'speaking') {
    // Reopened: a candidate arrived while nothing was live. The words sent
    // before it already carried their annotation, so the interruption is
    // what this candidate interrupts now. What the turn closed over belonged
    // to the closing it has left, and is recorded again if it closes a
    // second time.
    human = { ...human, agentAtClosing: undefined }
    relations = { ...relations, interruption: recordInterruption(state) }
  } else if (before === 'speaking' && human.phase === 'closing') {
    // Which agent turn this closing is measured against: the rules that
    // close this turn name the agent turn that opens *after* here, and an id
    // is what tells the two apart. Any agent turn current now was already
    // ended when the human's speech interrupted it.
    human = { ...human, agentAtClosing: agent?.id ?? null }
  } else if (before !== human.phase && human.phase === 'ended') {
    previous = { ...previous, human }
  }

  const next = { ...state, human, agent, previous, relations }
  return isCandidate ? interruptAgent(next) : next
}

// --- Agent side --------------------------------------------------------

function agentUtteranceFor(state: TurnManagerState, runId: string): Utterance<'agent'> | null {
  const { utterance } = lastPlayer(state)
  if (utterance !== null && utterance.id === runId) return utterance
  return null
}

function settleAgentTurn(state: TurnManagerState): TurnManagerState {
  const agent = state.agent
  if (agent === null || agent.phase === 'ended') return state

  const conversation = lastConversation(state)
  const { utterance, supply } = lastPlayer(state)
  const turnUtterance = agent.utterances.find((u) => u.id === agent.id) ?? null
  // An utterance already recorded `ended` on this turn cannot be revived by
  // a later report, whatever that report claims — mirrors
  // upsertHumanUtterance's own guard on the human side. Without this, a
  // late or reordered player report (`audible` arriving after `ended` was
  // already recorded for the same run id) would flow straight through and
  // be substituted in as the current utterance.
  const currentUtterance =
    turnUtterance?.phase === 'ended'
      ? turnUtterance
      : utterance !== null && utterance.id === agent.id ? utterance : turnUtterance

  let phase: Turn<'agent'>['phase'] = agent.phase
  let outcome = agent.outcome
  let utterances = agent.utterances

  if (currentUtterance !== null) {
    const idx = utterances.findIndex((u) => u.id === currentUtterance.id)
    utterances = idx === -1 ? [...utterances, currentUtterance] : utterances.map((u, i) => (i === idx ? currentUtterance : u))
  }

  const utteranceLive = currentUtterance !== null && isLive(currentUtterance.phase)
  const playerRunSet = supply.run === agent.id
  const pendingAboveZero = supply.pending > 0

  if (!conversation.runActive) {
    if (!state.relations.agentVoiced) {
      phase = 'ended'
      outcome = 'unvoiced'
    } else if (utteranceLive || playerRunSet || pendingAboveZero) {
      phase = 'closing'
    } else {
      phase = 'ended'
      outcome = 'completed'
    }
  } else if (currentUtterance !== null && isLive(currentUtterance.phase)) {
    phase = 'speaking'
  }

  const settled: Turn<'agent'> = { ...agent, phase, outcome, utterances }
  // A turn that ends here — completed, or unvoiced — is retained as the
  // previous agent turn, as every ending is. The outcomes reached by
  // replacement rather than by settling write `previous` where they end the
  // turn; this is the seam for the rest, and it is the only one that can see
  // a turn go from live to ended on its own.
  if (settled.phase === 'ended') {
    return { ...state, agent: settled, previous: { ...state.previous, agent: settled } }
  }
  return { ...state, agent: settled }
}

function reduceConversationReport(state: TurnManagerState, conversation: ConversationReport): TurnManagerState {
  if (!conversation.known) return state

  let agent = state.agent
  let previous = state.previous
  let human = state.human
  let relations = state.relations

  if (conversation.runActive && conversation.runId !== null) {
    const isNewRun = agent === null || agent.id !== conversation.runId

    if (isNewRun) {
      if (agent !== null && agent.phase !== 'ended') {
        const ended = endAgentTurn(agent, 'cancelled')
        previous = { ...previous, agent: ended }
      }

      const seeded = agentUtteranceFor(state, conversation.runId)
      const opened: Turn<'agent'> = {
        speaker: 'agent',
        id: conversation.runId,
        phase: seeded !== null && isLive(seeded.phase) ? 'speaking' : 'opening',
        utterances: seeded !== null ? [seeded] : [],
      }
      agent = opened
      relations = { ...relations, agentVoiced: !lastControls(state).speechMuted, pauseReason: null }

      // A run that opens while the human is speaking came from an earlier
      // send arriving late; the human is interrupting it from its first
      // moment. The annotation must still say the agent was working.
      if (human !== null && human.phase === 'speaking') {
        const ended = endAgentTurn(opened, 'preempted')
        agent = ended
        previous = { ...previous, agent: ended }
        const interruption = relations.interruption ?? { phase: 'opening' as const, remaining: 0, working: true }
        relations = { ...relations, interruption: { ...interruption, working: true } }
      }
    }
  }

  let next: TurnManagerState = { ...state, agent, human, previous, relations }
  next = settleAgentTurn(next)

  const openedAudible = next.agent !== null && next.agent.phase === 'speaking' && next.agent.utterances.some((u) => u.id === next.agent!.id && u.phase === 'audible')
  // Only the agent turn that opened after this human turn entered closing
  // ends it by ending. The run active when it closed is one the human turn
  // interrupted — controls.send aborts it before sending, so its own
  // runActive:false arrives a round-trip later and would otherwise close the
  // human turn before the answer it is waiting for has spoken.
  const agentEnded = endsClosingHuman(next.agent, human)
  if ((openedAudible || agentEnded) && human !== null && human.phase === 'closing') {
    const endedHuman = { ...human, phase: 'ended' as const }
    next = { ...next, human: endedHuman, previous: { ...next.previous, human: endedHuman } }
  }

  return next
}

/**
 * Writes an incoming agent utterance onto the ended turn that names it —
 * `state.agent` if that is the turn ended and matching, else
 * `state.previous.agent` — as a late human transcript updates a human
 * utterance. Mirrors `upsertHumanUtterance`'s own guard exactly: an entry
 * not yet found is appended; a *live* entry (`audible`/`paused`) is
 * replaced with the incoming one, since this is precisely how a turn the
 * turn manager ended while its utterance was still audible learns the
 * player's own later word that it was cut; an entry already `ended` is
 * left as recorded — the turn's own `phase`/`outcome` never move once
 * ended, and neither does an utterance already at its own final phase.
 * This function never touches `state.agent`'s or `state.previous.agent`'s
 * `phase`/`outcome` — only `utterances` — and is step 1 of two;
 * `reducePlayerReport` always runs step 2 afterward, regardless of what
 * this step found.
 */
function writeUtteranceOntoEndedTurn(state: TurnManagerState, utterance: Utterance<'agent'>): TurnManagerState {
  const agent = state.agent
  if (agent !== null && agent.phase === 'ended' && agent.id === utterance.id) {
    const updated = upsertAgentUtterance(agent, utterance)
    const previous = state.previous.agent?.id === agent.id
      ? { ...state.previous, agent: updated }
      : state.previous
    return { ...state, agent: updated, previous }
  }
  const previousAgent = state.previous.agent
  if (previousAgent !== null && previousAgent.id === utterance.id && agent?.id !== utterance.id) {
    const updated = upsertAgentUtterance(previousAgent, utterance)
    return { ...state, previous: { ...state.previous, agent: updated } }
  }
  return state
}

/** Same merge rule as `upsertHumanUtterance`, for the agent side: not
 * found → append; found and live → replace with the incoming report;
 * found and already ended → keep what is recorded. `Utterance<'agent'>`
 * has no field that trails a late value in once ended (no `transcript`
 * counterpart), so the ended case is a pure keep rather than a partial
 * merge. */
function upsertAgentUtterance(turn: Turn<'agent'>, utterance: Utterance<'agent'>): Turn<'agent'> {
  const idx = turn.utterances.findIndex((u) => u.id === utterance.id)
  if (idx === -1) return { ...turn, utterances: [...turn.utterances, utterance] }
  const existing = turn.utterances[idx]
  if (existing.phase === 'ended') return turn
  const utterances = turn.utterances.map((u, i) => (i === idx ? utterance : u))
  return { ...turn, utterances }
}

function reducePlayerReport(
  state: TurnManagerState,
  priorSupply: AudioSupply,
  utterance: Utterance<'agent'> | null,
  supply: AudioSupply,
): TurnManagerState {
  // The gesture play on an empty element is not an utterance, so a report
  // carrying neither is a no-op — but only when its run agrees with the
  // last report's: a report that clears or changes the run settles the
  // agent turn like any other, even with nothing newly mounted (endRun()
  // draining to empty with nothing ever having mounted for it).
  if (utterance === null && !supply.mounted && supply.run === priorSupply.run) return state

  // Step 1: write the incoming utterance onto whichever ended turn names
  // it, if any — state.agent (already ended) or state.previous.agent (the
  // turn this utterance belonged to has since been displaced by a newer
  // run). A no-op when the utterance names no ended turn at all (it names
  // state.agent while that turn is still live, or names neither).
  const written = utterance !== null ? writeUtteranceOntoEndedTurn(state, utterance) : state

  // Step 2: settle state.agent by this report's own supply, unconditionally
  // — regardless of which turn (if any) step 1 wrote to. The two can name
  // different turns: a report's utterance may belong to an already-ended
  // turn while its supply (run cleared or changed) is exactly what a
  // different, still-live state.agent needs to hear to settle itself.
  const agent = written.agent
  if (agent === null || agent.phase === 'ended') return written

  let next = settleAgentTurn(written)

  // The same positional rule as the conversation reducer's: an agent turn
  // ends a closing human turn only if it opened after that turn closed.
  const endedNow = endsClosingHuman(next.agent, written.human)
  // Read off next.agent's own recorded utterance, not the incoming
  // `utterance` parameter directly: settleAgentTurn already applied its
  // own revival guard (an utterance recorded `ended` cannot be revived by
  // a later report), and firstAudible must see the same, already-guarded
  // picture — otherwise a reordered or replayed `audible` report for a run
  // already recorded `ended` would correctly leave the agent's own
  // utterance alone while still closing a human turn sitting in `closing`,
  // on a report describing audio that already finished.
  const recorded = next.agent?.utterances.find((u) => u.id === agent.id) ?? null
  const firstAudible = recorded !== null && recorded.phase === 'audible'
  if ((endedNow || firstAudible) && written.human !== null && written.human.phase === 'closing') {
    const human = { ...written.human, phase: 'ended' as const }
    next = { ...next, human, previous: { ...next.previous, human } }
  }

  return next
}

function reduceModeReport(state: TurnManagerState, mode: Mode): TurnManagerState {
  if (mode === 'off') {
    return { ...initialTurnManagerState(state.config), last: { ...state.last, mode: { actor: 'mode', mode } } }
  }
  return state
}

// Speech muting and unmuting change `pauseReason` only on the transition
// (row: "whatever it held" on mute, "if nothing else holds it" on unmute),
// so this reads the prior controls report, not the one just recorded.
function reduceControlsReport(state: TurnManagerState, priorControls: ControlsReport, controls: ControlsReport): TurnManagerState {
  let next = state

  if (controls.speechMuted !== priorControls.speechMuted) {
    const agent = state.agent
    const agentOpen = agent !== null && agent.phase !== 'ended'
    if (controls.speechMuted) {
      if (agentOpen) next = { ...next, relations: { ...next.relations, pauseReason: 'speechMuted' } }
    } else {
      next = { ...next, relations: { ...next.relations, pauseReason: null } }
    }
  }

  // "a controls report unmuting the mic re-applies this [close] rule" — the
  // mic gated the human turn's close while muted; an unmute may now let it
  // close, so the outcome is re-derived exactly as any other settle would.
  if (controls.micMuted !== priorControls.micMuted && !controls.micMuted) {
    const human = next.human
    if (human !== null && human.phase !== 'ended') {
      const held = human.held ?? false
      const sendPending = human.sendPending ?? false
      const result = humanTurnOutcomeAfter(human, held, false, sendPending)
      const before = human.phase
      const nextHuman: Turn<'human'> = {
        ...human,
        phase: result.phase,
        outcome: result.outcome,
        sendPending: result.phase === 'closing' || result.phase === 'ended' ? false : sendPending,
      }
      let previous = next.previous
      if (before === 'speaking' && nextHuman.phase === 'closing') {
        nextHuman.agentAtClosing = next.agent?.id ?? null
      } else if (before !== nextHuman.phase && nextHuman.phase === 'ended') {
        previous = { ...previous, human: nextHuman }
      }
      next = { ...next, human: nextHuman, previous }
    }
  }

  return next
}

/**
 * A composer send releases an open human turn's hold and closes it as sent
 * once nothing in it is live, whatever its utterances hold. With no human
 * turn open, changes nothing. Neither `sends` nor `focused` carries a
 * turn-level consequence beyond this: `reduce`'s own top-level dedup is what
 * makes a repeat report (an unchanged `sends`/`focused` pair) a no-op, and
 * HumanVoice reads `focused` off the snapshot directly to decide whether to
 * settle a paused utterance — the reducer's only job for that field is to
 * hold the report so that read is possible.
 */
/**
 * A composer report saying focused holds an open, not-ended human turn. A
 * composer report whose sends differs from the last one's marks a send
 * pending on an open, not-ended human turn; a turn with a send pending
 * closes as sent once nothing in it is live. Changes nothing about an
 * ended turn or when no human turn is open.
 */
function reduceComposerReport(
  state: TurnManagerState,
  priorSends: number,
  composer: { sends: number; focused: boolean },
): TurnManagerState {
  const human = state.human
  if (human === null || human.phase === 'ended') return state

  const speaking = human.phase === 'speaking'
  const heldNow = composer.focused && speaking ? true : (human.held ?? false)
  const sendPendingNow = composer.sends !== priorSends && speaking ? true : (human.sendPending ?? false)

  const result = humanTurnOutcomeAfter(human, heldNow, lastControls(state).micMuted, sendPendingNow)
  const nextHuman: Turn<'human'> = {
    ...human,
    phase: result.phase,
    outcome: result.outcome,
    held: heldNow,
    sendPending: result.phase === 'closing' || result.phase === 'ended' ? false : sendPendingNow,
  }

  const before = human.phase
  let previous = state.previous
  if (before === 'speaking' && nextHuman.phase === 'closing') {
    nextHuman.agentAtClosing = state.agent?.id ?? null
  } else if (before !== nextHuman.phase && nextHuman.phase === 'ended') {
    previous = { ...previous, human: nextHuman }
  }

  return { ...state, human: nextHuman, previous }
}

export function reduce(state: TurnManagerState, report: Report): TurnManagerState {
  const priorLast = state.last[report.actor]
  if (priorLast !== undefined && deepEqual(priorLast, report)) return state

  const withReport = withLast(state, report)

  switch (report.actor) {
    case 'human':
      return reduceHumanReport(withReport, report.utterance)
    case 'agent':
      return reducePlayerReport(withReport, lastPlayer(state).supply, report.utterance, report.supply)
    case 'conversation':
      return reduceConversationReport(withReport, report.conversation)
    case 'controls':
      return reduceControlsReport(withReport, lastControls(state), report.controls)
    case 'composer':
      return reduceComposerReport(withReport, lastComposer(state).sends, { sends: report.sends, focused: report.focused })
    case 'mode':
      return reduceModeReport(withReport, report.mode)
  }
}

function floorFor(state: TurnManagerState): Speaker | 'nobody' {
  const mode = lastMode(state)
  if (mode === 'starting' || mode === 'ending' || mode === 'off') return 'nobody'

  if (state.human !== null && state.human.phase === 'speaking') return 'human'
  if (state.agent !== null && (state.agent.phase === 'opening' || state.agent.phase === 'speaking' || state.agent.phase === 'closing')) {
    return 'agent'
  }
  return 'nobody'
}

function annotationFor(state: TurnManagerState): Snapshot['annotation'] {
  const conversation = lastConversation(state)
  if (!conversation.known) return null

  const interruption = state.relations.interruption
  if (interruption === null) return null
  if (interruption.working) return 'interrupted-working'
  const wasSpeakingOrClosing = interruption.phase === 'speaking' || interruption.phase === 'closing'
  if (wasSpeakingOrClosing && interruption.remaining > state.config.interruptionMinRemainingS) {
    return 'interrupted-speaking'
  }
  return null
}

function mayBeAudibleFor(state: TurnManagerState): boolean {
  const floor = floorFor(state)
  if (floor !== 'agent') return false
  if (state.relations.pauseReason !== null) return false
  const agent = state.agent
  if (agent === null) return false
  if (!state.relations.agentVoiced) return false
  if (agent.outcome === 'superseded' || agent.outcome === 'preempted') return false
  return true
}

function newAudioFor(state: TurnManagerState): Snapshot['newAudio'] {
  // Discard is checked first and unconditionally on the agent turn's own
  // state, whoever holds the floor — an unvoiced, superseded or preempted
  // turn is never played, whatever else is true. Only once that is ruled
  // out does the floor decide between park and play.
  const agent = state.agent
  const discard =
    agent !== null && (
      (agent.phase !== 'ended' && !state.relations.agentVoiced)
      || agent.outcome === 'unvoiced'
      || agent.outcome === 'superseded'
      || agent.outcome === 'preempted'
    )
  if (discard) return 'discard'

  const floor = floorFor(state)
  if (floor === 'human') return 'park'
  if (floor === 'agent') return 'play'
  return 'park'
}

export function snapshot(state: TurnManagerState): Snapshot {
  const conversation = lastConversation(state)
  return {
    floor: floorFor(state),
    human: state.human,
    agent: state.agent,
    previous: state.previous,
    relations: state.relations,
    activity: conversation.activity,
    newAudio: newAudioFor(state),
    mayBeAudible: mayBeAudibleFor(state),
    annotation: annotationFor(state),
    mode: lastMode(state),
    controls: lastControls(state),
    composer: { focused: lastComposer(state).focused },
  }
}
