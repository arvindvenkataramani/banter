import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { ArrowUp, ChevronDown, Keyboard, Link2Off, Lock, LockOpen, Mic, MicOff, Square, Volume2, VolumeX, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModelPill } from './model-pill'
import { tailWords } from '@/lib/voice/human/transcript-view'
import { usePendingView } from '@/lib/voice/human/use-revealed-transcript'
import { useTranscriptStore, editTranscript, takeTranscript, useTurnManagerStore, reportComposerSend, reportComposerFocus } from '@/lib/voice'

interface ModelOption {
  id: string
  label: string
}

interface Props {
  onSend: (text: string) => void
  onStop: () => void
  isStreaming: boolean
  onVoiceToggle: (enabled: boolean) => void
  speechMuted: boolean
  toggleSpeechMuted: () => void
  /** True mic state — the big button shows this, never all-muted. */
  micMuted: boolean
  toggleMuteAll: () => void
  setMicAutoMuted: (active: boolean) => void
  models: ModelOption[]
  currentModel: string
  onModelChange: (id: string) => void
  /** Toggles whether the screen is held awake. Absent where that is not offered. */
  onPreventScreenLock?: () => void
  /** The screen is being held awake. */
  unattended?: boolean
  muteLinked?: boolean
  relinkMutes?: () => void
  /**
   * The live streaming transcript, shown above the buttons and inside this
   * block's own blur band. Rendering it here rather than floating it above
   * the block is what keeps one element owning the geometry: the band, the
   * readout and the controls move together, and the readout cannot drift
   * into the blur that exists to make text beneath the buttons illegible.
   *
   * Present for a whole session rather than only once there are words: the
   * region holds its height throughout, so the first word of a turn does not
   * push the conversation up by three lines. Absent for a caller that does
   * not stream, where the region collapses and the block is unchanged.
   */
  readout?: React.ReactNode
  /**
   * How many lines of transcript the readout shows. Whole lines of the
   * readout's own `leading-6`, so its top edge never clips a partial one.
   */
  readoutLines?: number
}

const round48 = "size-12 shrink-0 rounded-full border border-transparent bg-[var(--neutral-fill)] text-foreground transition-all duration-150 font-sans font-[480]"

/**
 * Mobile voice-on control block (design handoff option 1e — see
 * voice/design_handoff_voice_composer_mobile/README.md in the "Voice
 * buttons design tweaks" claude.ai/design project). That README is the
 * source of truth for behavior; the bundled reference HTML is a
 * visual/behavioral demo only.
 *
 * Unlike desktop, voice-on does not swap icons inside the composer box —
 * it replaces the whole box with this fixed two-row block: a centered
 * voice cluster (speech-mute, mute-everything, abort) above a utility row
 * (keyboard, model, ✕). Voice-off renders the ordinary ChatComposer
 * instead of this component — text mode is unchanged from desktop, per
 * the handoff.
 *
 * Every control is icon-only; state is carried by icon/color, and the
 * accessible name is the only place the words live — losing the visible
 * label is only acceptable because of that, so title/aria-label must
 * track state exactly (see the README's accessible-name table).
 */
export function VoiceControlsMobile({
  onSend, onStop, isStreaming,
  onVoiceToggle,
  speechMuted, toggleSpeechMuted,
  micMuted, toggleMuteAll,
  setMicAutoMuted,
  models, currentModel, onModelChange,
  onPreventScreenLock, unattended = false,
  muteLinked = true, relinkMutes,
  readout, readoutLines = 3,
}: Props) {
  const [fieldOpen, setFieldOpen] = useState(false)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  // Controlled over the same store ChatComposer's field is — "nothing
  // outside transcript-store.ts holds the words."
  const settled = useStore(useTranscriptStore, (s) => s.settled)
  // Words still waiting to settle, shown read-only above the open field so
  // the words paused at the tap never leave the screen.
  const pendingView = usePendingView()
  const canSend = settled.trim().length > 0 || pendingView.length > 0

  // Each button shows exactly the one thing it controls: the big button the
  // mic, the speech button speech. While unlinked those differ, and deriving
  // either from isMuteAll would misreport the other's state.
  const autoMuted = fieldOpen && !micMuted
  const muted = micMuted || autoMuted
  const speechShowsMuted = speechMuted

  const muteTitle = muted
    ? (autoMuted ? 'Mic muted while typing' : 'Mic muted')
    : (muteLinked ? 'Mute everything' : 'Mute the mic')
  const speechTitle = speechMuted ? 'Speech muted' : 'Mute speech only'
  const abortTitle = isStreaming ? 'Stop the run' : 'Nothing to stop'

  function openField() {
    setFieldOpen(true)
    setMicAutoMuted(true)
    reportComposerFocus(true)
    setTimeout(() => fieldRef.current?.focus(), 0)
  }

  function dismissField() {
    // Dismissing the field must not discard what was typed — the words stay
    // in `settled` and are visible again the next time the field opens, or
    // in the collapsed readout.
    setFieldOpen(false)
    setMicAutoMuted(false)
    reportComposerFocus(false)
  }

  function submitField() {
    if (!canSend) return
    const turn = useTurnManagerStore.getState().snapshot.human
    setFieldOpen(false)
    setMicAutoMuted(false)
    reportComposerFocus(false)
    if (turn !== null && turn.phase === 'speaking') {
      reportComposerSend()
      return
    }
    const text = takeTranscript().trim()
    if (!text) return
    onSend(text)
  }

  return (
    <div className="relative">
      {/* Backdrop blur only, no fill color — the transcript scrolls up behind
          this block (it has no background of its own), and without
          something here the last message line visually collides with the
          buttons instead of dissolving away underneath them. The div
          overhangs 6rem above the block itself, and the blur/fallback-fade
          (see index.css) eases in across that overhang — full strength by
          the block's own top edge — so the feather sits in the empty
          transcript space above the buttons, not inside the button row
          itself (a mask feathered within the block's own bounds left the
          top row under-blurred and text stayed legible through it). An
          eased multi-stop ramp, not a two-stop linear one, since a linear
          ramp's constant rate still reads as a seam where it meets the
          full-strength region. Falls back to a soft fade where
          backdrop-filter isn't supported. */}
      <div className="voice-controls-mobile-backdrop absolute inset-x-0 -top-24 bottom-0 pointer-events-none" aria-hidden="true" />
      <div className="relative flex flex-col gap-3.5 px-5 pt-3.5 pb-[max(1.375rem,env(safe-area-inset-bottom))] font-sans">
      {readout && !fieldOpen && (
        /* Inside the block, so the backdrop above covers it and the two
           cannot fall out of step. A definite height rather than a max: the
           column pins its content to the bottom, so the newest words sit
           against the buttons and older ones scroll away above. Suppressed
           while the inline field is open — the field already shows
           `settled`, and the readout also renders `settled` plus the live
           partial, so both on screen at once would show the same words
           twice. */
        <div
          className="voice-readout-region flex flex-col justify-end overflow-hidden"
          style={{ '--readout-lines': readoutLines } as React.CSSProperties}
        >
          {readout}
        </div>
      )}
      <div className="relative flex items-center justify-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={speechShowsMuted ? `${round48} border-transparent` : `${round48} hover:bg-[color-mix(in_oklch,var(--foreground)_16%,transparent)]`}
          onClick={toggleSpeechMuted}
          title={speechTitle}
          style={speechShowsMuted ? {
            background: 'var(--sec-pressed-bg)',
            color: 'var(--sec-pressed-fg)',
          } : undefined}
        >
          {speechShowsMuted ? <VolumeX className="size-[18px]" strokeWidth={1.8} /> : <Volume2 className="size-[18px]" strokeWidth={1.8} />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-[68px] shrink-0 rounded-full border border-transparent transition-all duration-150 font-sans font-[480]"
          onClick={toggleMuteAll}
          title={muteTitle}
          style={{
            background: muted ? 'var(--warning)' : 'var(--mic-fill)',
            color: muted ? 'var(--warning-fg)' : 'var(--foreground)',
          }}
        >
          {muted ? <MicOff className="size-[27px]" strokeWidth={1.45} /> : <Mic className="size-[27px]" strokeWidth={1.45} />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={isStreaming
            ? `${round48} border-transparent bg-[color-mix(in_oklch,var(--warning)_20%,transparent)] text-[var(--warning-strong)] hover:bg-[color-mix(in_oklch,var(--warning)_30%,transparent)]`
            : `${round48} disabled:opacity-100 text-muted-foreground/60`}
          onClick={onStop}
          disabled={!isStreaming}
          title={abortTitle}
        >
          <Square className="size-[15px]" strokeWidth={2} fill="currentColor" />
        </Button>
        {!muteLinked && relinkMutes && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`${round48} absolute left-0 bg-transparent text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)] hover:text-foreground`}
            onClick={relinkMutes}
            title="Mic and speech are set separately — link them"
          >
            <Link2Off className="size-[17px]" strokeWidth={1.8} />
          </Button>
        )}
        {onPreventScreenLock && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={
              unattended
                ? `${round48} absolute right-0 text-foreground`
                : `${round48} absolute right-0 bg-transparent text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)] hover:text-foreground`
            }
            onClick={onPreventScreenLock}
            title={unattended ? 'Screen stays awake — tap to release' : 'Keep the screen awake'}
            aria-pressed={unattended}
          >
            {/* Two silhouettes that differ at a glance, rather than two
                states of one icon. Locked is the screen being held awake. */}
            {unattended
              ? <Lock className="size-[17px]" strokeWidth={1.8} />
              : <LockOpen className="size-[17px]" strokeWidth={1.8} />}
          </Button>
        )}
      </div>

      {fieldOpen && pendingView && (
        <p className="px-1 font-sans text-base text-muted-foreground">{pendingView}</p>
      )}
      {fieldOpen ? (
        <div className="flex items-end gap-2.5">
          {/* One line tall when it holds one line, the height of the utility
              row it replaces; it grows with the words, up to a cap, and
              scrolls beyond it. */}
          <div className="flex min-h-12 flex-1 items-end gap-2.5 rounded-3xl bg-[var(--card-muted)] py-1 pr-2 pl-[18px]">
            <textarea
              ref={fieldRef}
              value={settled}
              onChange={(e) => editTranscript(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitField() } }}
              rows={1}
              placeholder="Type a message…"
              className="field-sizing-content max-h-40 min-w-0 flex-1 resize-none self-center border-0 bg-transparent py-2 font-sans text-base text-foreground outline-none placeholder:text-muted-foreground"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-10 shrink-0 rounded-full border border-transparent disabled:opacity-45"
              style={canSend ? { background: 'var(--primary)', color: 'var(--primary-foreground)' } : { background: 'color-mix(in oklch, var(--foreground) 8%, transparent)', color: 'var(--muted-foreground)' }}
              onClick={submitField}
              disabled={!canSend}
              title={canSend ? 'Send' : 'Nothing to send'}
            >
              <ArrowUp className="size-[14px]" strokeWidth={2} />
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`${round48} hover:bg-[color-mix(in_oklch,var(--foreground)_16%,transparent)]`}
            onClick={dismissField}
            title="Dismiss the field"
          >
            <ChevronDown className="size-[18px]" strokeWidth={1.8} />
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`${round48} hover:bg-[color-mix(in_oklch,var(--foreground)_16%,transparent)]`}
            onClick={openField}
            title="Type instead"
          >
            <Keyboard className="size-[18px]" strokeWidth={1.7} />
          </Button>
          <ModelPill models={models} currentModel={currentModel} onModelChange={onModelChange} />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`${round48} hover:bg-[color-mix(in_oklch,var(--foreground)_16%,transparent)]`}
            onClick={() => onVoiceToggle(false)}
            title="Turn voice off"
          >
            <X className="size-[18px]" strokeWidth={1.8} />
          </Button>
        </div>
      )}
      </div>
    </div>
  )
}

/**
 * The spoken transcript above the mobile controls, while voice is filling it.
 *
 * Newest text at the bottom, because that is what the eye is on while
 * speaking. Muted rather than normal colour: dim is the state readout — the
 * system is filling this — and the composer's own colour means the user has
 * it instead.
 */

export function SpokenReadout() {
  const settled = useStore(useTranscriptStore, (s) => s.settled)
  const pendingView = usePendingView()
  const text = settled + (settled && pendingView ? ' ' : '') + pendingView
  const ref = useRef<HTMLParagraphElement>(null)

  // Newest words against the bottom, because that is where the eye is while
  // speaking. A long turn scrolls its own beginning away rather than growing
  // the block and pushing the conversation up.
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <p
      ref={ref}
      className="scrollbar-none max-h-full overflow-y-auto text-base leading-6 text-muted-foreground"
    >
      {/* Only the tail is legible in a region this size, and the words above
          it are not coming back — trimming keeps the element from growing
          behind its own overflow through a long turn. */}
      {tailWords(text, 60)}
    </p>
  )
}
