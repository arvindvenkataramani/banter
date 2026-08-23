import { getPlaybackEngine } from './store/player-store'
import { isUserSpeaking } from './store/mic-store'
// mute-store imports this module for its command functions, so this is a
// cycle — a safe one. Both directions are read inside function bodies, never
// at module scope, so ESM's live bindings resolve either init order.
import { useMuteStore } from './store/mute-store'

/**
 * Single owner of audio disposition — pause / resume / hold / release / drop
 * / cancel. Every other actor (mute-store, mic-loop, turn-manager wiring,
 * the abort halter) reports what happened; only this module commands the
 * playback engine. Before this module existed, five call sites each decided
 * on their own local reading of the situation, with no shared model and no
 * arbitration between them.
 *
 * Callers pass facts (what state the player/mic were observed in), not case
 * names — the rules that turn a fact into a command live here, in one place,
 * so they can be read instead of inferred from five sites.
 *
 * The invariant this file enforces: playback is un-paused only while speech
 * is unmuted. It owns one piece of state to do that — a module-level latch
 * recording whether the current run began while speech was muted (see
 * `reportRunBeginning` / `shouldDiscardChunk`). That fact cannot be derived
 * later: by the time a chunk from the run arrives, the user may have
 * unmuted, and "was this run ever voiced" is not recoverable from current
 * mute state at that point. Every other decision here is a pure function of
 * currently-observable state.
 */

// ── Speech onset (mic-loop) ─────────────────────────────────────────────
// The user started talking. If the player was audibly playing, pause it so
// audio doesn't talk over them. Fact, not a live re-query: the caller reads
// `playing` at the same instant it reads the other onset facts
// (interruptionHadAudioLeft / hadPausedAudio), so the decision is made off
// one consistent snapshot rather than a second, possibly-stale read here.
export function reportSpeechOnset(playing: boolean): void {
  if (playing) getPlaybackEngine().pause()
}

// ── Shared: an utterance ended without producing a message ───────────────
// If we paused playback for this utterance (not because the user had already
// paused before speaking), resume it — unless speech is muted, in which case
// there is nothing to resume into (§3.6: hadPausedAudio can never be true
// while genuinely paused-for-mute, so this term is what actually keeps a
// muted resume from firing, not a defensive extra). Held chunks are always
// released — neither disposition below is an interrupt.
function resolveUnresolvedUtterance(facts: { hadPausedAudio: boolean; playerPaused: boolean }): void {
  const engine = getPlaybackEngine()
  if (!facts.hadPausedAudio && facts.playerPaused && !useMuteStore.getState().speechMuted) engine.resume()
  engine.releaseHeldChunks()
}

// ── Commit: false alarm / no-send cleanup (mic-loop) ────────────────────
// The utterance was rejected as noise, or the safety flush found nothing to
// send.
export function reportCommitFalseAlarm(facts: { hadPausedAudio: boolean; playerPaused: boolean }): void {
  resolveUnresolvedUtterance(facts)
}

// ── Commit: mic muted mid-utterance (mic-loop) ────────────────────────────
// The mic was muted while an utterance was in progress (hearing or awaiting
// its commit timer). Nothing downstream will ever resolve it — muteMic()
// cancels the commit timer and forces mic state back to idle — so this is
// the abandonment's only resolution. Same disposition as a false alarm: it
// is not an interrupt either.
export function reportUtteranceAbandoned(facts: { hadPausedAudio: boolean; playerPaused: boolean }): void {
  resolveUnresolvedUtterance(facts)
}

// ── Commit: real send (mic-loop) ─────────────────────────────────────────
// The three "audio should be cleared" cases at commit — the gateway run
// still active, a genuine interruption of live TTS, or speaking after a
// manual pause — all take the identical audio action (cancel if the player
// is active, then drop held chunks). They differ only in which message
// annotation mic-loop sends, which is not a playback-arbiter concern and
// stays there. The remaining case (player was idle at onset) releases held
// chunks instead of dropping them, same as a false alarm.
export function reportCommitSend(facts: { playerPlaying: boolean; playerPaused: boolean; clearAudio: boolean }): void {
  const engine = getPlaybackEngine()
  if (facts.clearAudio) {
    if (facts.playerPlaying || facts.playerPaused) engine.cancel()
    engine.dropHeldChunks()
  } else {
    engine.releaseHeldChunks()
  }
}

// ── Mute (mute-store) ─────────────────────────────────────────────────────
// Speech mute is a playback control, full stop: muting pauses, unmuting
// resumes. The mic never touches playback in either direction — see
// `reportRunBeginning` below for the one case this doesn't cover (a run
// that began while speech was muted stays silent regardless of mute state
// mid-run).
//
// Buffered audio stays resumable (B2/B3): an in-flight turn keeps
// synthesising and buffers behind the pause rather than being discarded, so
// unmute plays the whole thing. Held chunks are a different resource — a
// held chunk is a pending fetch, not decoded audio, and cannot be paused —
// so muting speech no longer drops them either; dropping stays only on the
// commit paths that were already interrupts (reportCommitSend's clearAudio
// branch).
//
// resume() is self-guarded on the engine's own `userPaused` flag (see its
// doc comment in playback-engine.ts) — calling it with nothing paused is a
// no-op there, so this function does not need to re-check player state
// before calling it.
export function reportSpeechMuted(muted: boolean): void {
  const engine = getPlaybackEngine()
  if (muted) {
    engine.pause()
  } else {
    engine.resume()
  }
}

// ── Safety flush, nothing to send (mic-loop) ─────────────────────────────
// The periodic safety flush found no utterance in progress. Any held chunks
// are stale — release them. Distinct from a false alarm: no speech-onset
// ever fired this cycle, so there is no pause/resume decision to make here,
// only a release.
export function reportNothingToFlush(): void {
  getPlaybackEngine().releaseHeldChunks()
}

// ── Turn lifecycle (turn-manager wiring) ─────────────────────────────────

// Whether the in-progress run began while speech was muted. A run begun
// unvoiced stays unvoiced for its whole duration, even if the user unmutes
// mid-run — reading mute live instead would start audio mid-sentence, the
// incoherent case this latch exists to prevent. Module-level rather than
// derived: by the time a chunk from this run arrives, current mute state no
// longer tells you what it was when the run began.
let runBeganUnvoiced = false

// beginRun cancels any prior playback before the new turn's audio starts —
// that cancel is a disposition decision, so it routes through here rather
// than TurnManager's wiring calling the engine directly. The latch is set
// from mute state before the cancel, so a run that begins muted is marked
// unvoiced from its very first chunk.
export function reportRunBeginning(): void {
  runBeganUnvoiced = useMuteStore.getState().speechMuted
  getPlaybackEngine().beginRun()
}

export function reportRunEnding(): void {
  getPlaybackEngine().endRun()
  runBeganUnvoiced = false
}

// ── Hard halt (abort RPC round-trip) ─────────────────────────────────────
// Local "silence now" — stops audio synchronously, ahead of the abort RPC
// resolving.
export function haltAll(): void {
  getPlaybackEngine().cancel()
}

// ── Enqueue-time predicates (playback-engine) ────────────────────────────
// The two questions asked of every arriving TTS chunk. They live here with
// the commands because they are the same kind of decision — what happens to
// this audio, given what is going on — and splitting them would leave the
// rules readable in one file only for chunks already accepted.

/** Hold rather than dispatch: the user is speaking, so park it. */
export function shouldHoldChunk(): boolean {
  return isUserSpeaking()
}

/** Discard outright: this run began while speech was muted, so it is not voiced at all. */
export function shouldDiscardChunk(): boolean {
  return runBeganUnvoiced
}
