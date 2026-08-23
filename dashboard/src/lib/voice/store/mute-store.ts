import { create } from 'zustand'
import { reportSpeechMuted } from '../playback-arbiter'
import type { MicLoop } from '../mic-loop'

export interface MuteStoreState {
  micMuted: boolean
  speechMuted: boolean
  muteLinked: boolean
}

// Mic mute, speech mute, and linkage all reset on mount and again at each
// voice-mode on.
export const useMuteStore = create<MuteStoreState>(() => ({
  micMuted: false,
  speechMuted: false,
  muteLinked: true,
}))

let micLoop: MicLoop | null = null
let autoMuted = false

/** Register (or clear) the live MicLoop the store dispatches mute commands to. */
export function setMuteMicLoop(loop: MicLoop | null): void {
  micLoop = loop
}

export function resetMutes(): void {
  useMuteStore.setState({ micMuted: false, speechMuted: false, muteLinked: true })
  autoMuted = false
}

/* ── Mute coupling ──────────────────────────────────────────────
   Two states — LINKED and UNLINKED — over two independent booleans.

     LINKED   + big     -> LINKED    both := !mic
     LINKED   + speech  -> UNLINKED  speech := !speech
     UNLINKED + big     -> UNLINKED  mic := !mic          (mic only)
     UNLINKED + speech  -> UNLINKED  speech := !speech
     UNLINKED + either, landing on both unmuted -> LINKED
     UNLINKED + chain   -> LINKED    speech := mic

   While unlinked the big button is the mic control and nothing else —
   driving both would silently undo the divergence the user just asked
   for. Each button therefore always reflects exactly the one thing it
   controls. */

// Apply-state primitives. These set audio state only; the transitions
// below decide what state to move to.
function applyMic(muted: boolean): void {
  useMuteStore.setState({ micMuted: muted })
  autoMuted = false
  if (muted) micLoop?.muteMic()
  else micLoop?.unmuteMic()
}

function applySpeech(muted: boolean): void {
  useMuteStore.setState({ speechMuted: muted })
  // Speech mute is a playback control: this call is the whole pause-or-
  // resume decision for this transition. See playback-arbiter.ts.
  reportSpeechMuted(muted)
}

export function toggleMuteAll(): void {
  const { micMuted, speechMuted, muteLinked } = useMuteStore.getState()
  const nextMic = !micMuted
  if (muteLinked) {
    // Speech before mic: the mic's abandonment report (muteMic() mid-
    // utterance) must see settled speech state, not speech that is about to
    // change underneath it. No user-visible difference — this ordering
    // just prevents a spurious resume/pause pair.
    applySpeech(nextMic)
    applyMic(nextMic)
  } else {
    applyMic(nextMic)
    if (!nextMic && !speechMuted) {
      useMuteStore.setState({ muteLinked: true })
    }
  }
}

export function setMicAutoMuted(active: boolean): void {
  const { micMuted } = useMuteStore.getState()
  if (active) {
    if (!micMuted) {
      useMuteStore.setState({ micMuted: true })
      micLoop?.muteMic()
      autoMuted = true
    }
  } else {
    if (autoMuted) {
      useMuteStore.setState({ micMuted: false })
      micLoop?.unmuteMic()
      autoMuted = false
    }
  }
}

export function toggleSpeechMuted(): void {
  const { micMuted, speechMuted } = useMuteStore.getState()
  const next = !speechMuted
  applySpeech(next)
  // Setting speech on its own holds the two apart, unless that lands on
  // both unmuted — the resting state the coupling returns to.
  useMuteStore.setState({ muteLinked: !next && !micMuted })
}

// Re-link by adopting the mic's state for both. Speech mute (and therefore
// resume) only changes if it wasn't already at the mic's value.
export function relinkMutes(): void {
  const { micMuted, speechMuted } = useMuteStore.getState()
  const target = micMuted
  useMuteStore.setState({ muteLinked: true })
  if (speechMuted !== target) applySpeech(target)
}
