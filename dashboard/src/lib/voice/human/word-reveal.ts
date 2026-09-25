/**
 * Paces the transcript onto the screen one word at a time.
 *
 * The model emits a partial roughly once a second, each carrying several new
 * words, so text arrives in bursts however promptly it is rendered. A burst
 * appearing at once reads as a delayed result; the same words arriving
 * singly read as the system keeping up with the speaker.
 *
 * Revealing on a fixed interval only moves the burst rather than removing it:
 * the queue drains at that rate, empties, and the display sits still until
 * the next partial lands. So the rate is derived from how fast words are
 * *arriving* — the queue is spread across the interval the next partial is
 * expected in, which keeps words emerging continuously between arrivals.
 *
 * The readout therefore trails what the server has sent, by roughly one
 * partial's worth. It never runs ahead of it, and the trailing distance stays
 * bounded rather than growing across a turn.
 */

/** Before any cadence has been observed, assume the model's nominal rate. */
const ASSUMED_ARRIVAL_MS = 1000
/**
 * How much of the expected arrival interval to spread the queue across. Under
 * one, so the queue is normally empty just before the next partial lands: at
 * exactly one a late partial leaves the display stalled, and well under one
 * reintroduces the burst this exists to remove.
 */
const SPREAD_FRACTION = 0.85

export interface RevealState {
  /** Every word the server has sent for this turn. */
  target: string[]
  /** How many of them are on screen. */
  shown: number
  /** When the last partial arrived, for measuring cadence. */
  lastArrivalAt: number | null
  /** Smoothed interval between partials. */
  arrivalIntervalMs: number
}

export function emptyReveal(): RevealState {
  return {
    target: [],
    shown: 0,
    lastArrivalAt: null,
    arrivalIntervalMs: ASSUMED_ARRIVAL_MS,
  }
}

function words(text: string): string[] {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/) : []
}

/**
 * Take a new partial, noting when it arrived so the reveal can pace against
 * the model's cadence. The revealed count is preserved, so words already on
 * screen stay there.
 *
 * A revision that shortens the transcript pulls the count back with it — the
 * model withdrew words, and continuing to show them would assert recognition
 * it has retracted.
 */
export function receive(state: RevealState, text: string, now = Date.now()): RevealState {
  const target = words(text)
  // Smoothed rather than taken raw: one late partial should bend the rate,
  // not reset it to that partial's own gap.
  const gap = state.lastArrivalAt === null ? null : now - state.lastArrivalAt
  const arrivalIntervalMs = gap === null || gap <= 0
    ? state.arrivalIntervalMs
    : Math.round(state.arrivalIntervalMs * 0.7 + gap * 0.3)

  return {
    target,
    shown: Math.min(state.shown, target.length),
    lastArrivalAt: now,
    arrivalIntervalMs,
  }
}

/** Reveal one more word, if any are waiting. */
export function advance(state: RevealState): RevealState {
  if (state.shown >= state.target.length) return state
  return { ...state, shown: state.shown + 1 }
}

/** Everything still queued behind the reveal. */
export function backlog(state: RevealState): number {
  return state.target.length - state.shown
}

/** What the readout renders. */
export function revealed(state: RevealState): string {
  return state.target.slice(0, state.shown).join(' ')
}

/**
 * How long to wait before the next word: the queue spread across the time the
 * next partial is expected in, so words keep emerging between arrivals rather
 * than draining in a burst and stopping.
 *
 * A queue longer than one partial's worth — the speaker outpacing the reveal —
 * shortens the interval on its own, since the same window is divided among
 * more words.
 *
 * Bounds come from the caller — `voiceConfig.stt.reveal` — rather than a
 * module constant, since the same curve serves whatever bounds the platform
 * is configured with.
 */
export function intervalFor(state: RevealState, minIntervalMs: number, maxIntervalMs: number): number {
  const waiting = backlog(state)
  if (waiting <= 0) return maxIntervalMs
  const window = state.arrivalIntervalMs * SPREAD_FRACTION
  return Math.round(Math.min(maxIntervalMs, Math.max(minIntervalMs, window / waiting)))
}

/**
 * A turn ended: the settled transcript is what the bubble holds, so the
 * reveal starts empty for the next turn rather than draining a queue whose
 * words are already on the page.
 */
export function reset(): RevealState {
  return emptyReveal()
}
