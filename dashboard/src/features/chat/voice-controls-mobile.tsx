import { useRef, useState } from 'react'
import { ArrowUp, ChevronDown, Eye, Keyboard, Link2Off, Mic, MicOff, Square, Volume2, VolumeX, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModelPill } from './model-pill'

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
  onPreventScreenLock?: () => void
  muteLinked?: boolean
  relinkMutes?: () => void
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
  onPreventScreenLock,
  muteLinked = true, relinkMutes,
}: Props) {
  const [fieldOpen, setFieldOpen] = useState(false)
  const [text, setText] = useState('')
  const fieldRef = useRef<HTMLInputElement>(null)

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
    setTimeout(() => fieldRef.current?.focus(), 0)
  }

  function dismissField() {
    setFieldOpen(false)
    setText('')
    setMicAutoMuted(false)
  }

  function submitField() {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
    setFieldOpen(false)
    setMicAutoMuted(false)
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
            className={`${round48} absolute right-0 bg-transparent text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)] hover:text-foreground`}
            onClick={onPreventScreenLock}
            title="Prevent screen lock"
          >
            <Eye className="size-[17px]" strokeWidth={1.8} />
          </Button>
        )}
      </div>

      {fieldOpen ? (
        <div className="flex items-center gap-2.5">
          <div className="flex h-14 flex-1 items-center gap-2.5 rounded-full bg-[var(--card-muted)] pr-2 pl-[18px]">
            <input
              ref={fieldRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitField() } }}
              type="text"
              placeholder="Type a message…"
              className="min-w-0 flex-1 border-0 bg-transparent font-sans text-base text-foreground outline-none placeholder:text-muted-foreground"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 rounded-full border border-transparent disabled:opacity-45"
              style={text.trim() ? { background: 'var(--primary)', color: 'var(--primary-foreground)' } : { background: 'color-mix(in oklch, var(--foreground) 8%, transparent)', color: 'var(--muted-foreground)' }}
              onClick={submitField}
              disabled={!text.trim()}
              title={text.trim() ? 'Send' : 'Nothing to send'}
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
