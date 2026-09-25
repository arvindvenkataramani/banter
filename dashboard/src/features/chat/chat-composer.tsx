import { useEffect, useRef } from 'react'
import { useStore } from 'zustand'
import { AudioLines, Link2Off, Loader2, Mic, MicOff, Volume2, VolumeX, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ChatSendButton } from './chat-send-button'
import { useChatTextarea } from './use-chat-textarea'
import { useTranscriptStore } from '@/lib/voice'
import { usePendingView } from '@/lib/voice/human/use-revealed-transcript'

interface Props {
  onSend: (text: string) => void
  onStop: () => void
  isStreaming: boolean
  disabled: boolean
  voiceOn: boolean
  onVoiceToggle: (enabled: boolean) => void
  speechMuted: boolean
  toggleSpeechMuted: () => void
  /** True mic state — the mute control shows this, never all-muted. */
  micMuted: boolean
  toggleMuteAll: () => void
  setMicAutoMuted: (active: boolean) => void
  muteLinked?: boolean
  relinkMutes?: () => void
  /** Mobile only: renders a model-selector pill in the footer's left slot,
   * next to the voice controls. The desktop composer has no model picker of
   * its own — that lives in ControlBar — but the mobile design handoff puts
   * one directly in the composer footer (see voice/design_handoff_voice_
   * composer_mobile/README.md, the voiceOff reference block). */
  modelPicker?: React.ReactNode
  /** ComposerDock's own focus-collapse swap (README §3 "Focused form") needs
   * this field's focus state to pick an arrangement — the field itself
   * lives inside useChatTextarea, one level below where the dock renders. */
  onFocusedChange?: (focused: boolean) => void
  /** ComposerDock's collapsed player (README §3), rendered in the footer's
   * left slot in place of modelPicker while present — "the model pill
   * yields the footer's left slot while something plays." Mutually
   * exclusive with modelPicker in practice: a player and a model picker
   * never coexist (media loaded means voice off, H1, and the model picker
   * only ever appears in the mobile voice-off composer). */
  collapsedPlayer?: React.ReactNode
  /** ComposerDock's two-click gate (README §4), desktop only — "the commit
   * is a labeled control **in place** in the composer cluster," replacing
   * the ordinary voice-on button for as long as the gate is armed. Absent
   * (undefined) means nothing is armed; present means render the gate pair
   * here instead of the voice-on button. */
  gate?: { onCommit: () => void; onCancel: () => void }
  /** Voice startup is in flight — the tap has been made but the pipeline is
   * not live yet (services, TTS model, browser VAD/SmartTurn models, mic
   * loop, ready chime). Derived once in ChatPage and threaded down; never
   * recomputed here. The waiting control it renders is also the cancel:
   * pressing it turns voice off, which unwinds startup at whatever stage it
   * reached. */
  voiceStarting?: boolean
  /** ComposerDock's fused surface (states 4/6, README §3/§6) already draws
   * the one rounded rectangle U-H15 requires — this suppresses this
   * component's own corners/fill so a focus-triggered colour change here
   * doesn't read as a second rectangle nested inside it. */
  embedded?: boolean
}

// `shrink-0` because a round button squeezed by a crowded row stops being
// round and stops being a 44pt touch target — it should hold its size and let
// the labelled pills give up width instead.
const roundBtn = "size-11 shrink-0 rounded-full border border-transparent text-foreground transition-all duration-150 font-sans font-[480]"

/**
 * Single composer box: full-width input over one footer row. Voice mode is
 * entered/exited from that row rather than a separate toolbar switch — see
 * the design handoff (claude.ai/design project "Voice buttons design
 * tweaks", voice/design_handoff_voice_composer/README.md) for the full
 * interaction spec. That README is the source of truth for behavior; the
 * bundled voice-composer-reference.html is a visual/behavioral demo only.
 */
export function ChatComposer({
  onSend, onStop, isStreaming, disabled,
  voiceOn, onVoiceToggle,
  speechMuted, toggleSpeechMuted,
  micMuted, toggleMuteAll,
  setMicAutoMuted,
  modelPicker,
  muteLinked = true, relinkMutes,
  onFocusedChange,
  collapsedPlayer,
  gate,
  voiceStarting = false,
  embedded = false,
}: Props) {
  // The transcript lives in its own store, which outlives this component:
  // navigating away mid-utterance and back must not lose words the user has
  // not sent yet. The field is a controlled input over it.
  const { focused, hasContent, submit, textareaProps } = useChatTextarea({
    onSend,
    setMicAutoMuted,
  })

  useEffect(() => {
    onFocusedChange?.(focused)
  }, [focused, onFocusedChange])

  // autoMuted / muted mirror the handoff's state table exactly: focusing the
  // field auto-mutes while voice is on; a manual mute (isMuteAll) is sticky
  // and independent of focus.
  // Shows mic state only — while unlinked, speech may differ and the speech
  // button reports that independently.
  const autoMuted = voiceOn && focused && !micMuted
  const muted = voiceOn && (micMuted || autoMuted)
  const pillLabel = muted ? (autoMuted ? 'Muted while typing' : 'Muted') : 'Listening'

  const sendDisabled = disabled || !hasContent

  // Unfocused, this div is the whole view: `settled`, then the pending
  // entries (only the entry being heard paced) — the controlled textarea
  // underneath it is `sr-only`'d out. Focused, the field itself carries
  // `settled` (editable), and this div renders only the pending entries —
  // "still waiting to settle show after the field as read-only text until
  // they settle into it," so words paused at the focus never leave the
  // screen, but `settled` is not duplicated between the field and this div.
  const settled = useStore(useTranscriptStore, (s) => s.settled)
  const pendingView = usePendingView()
  const showPending = voiceOn && pendingView.length > 0
  const unfocusedText = settled + (settled && pendingView ? ' ' : '') + pendingView
  const transcriptText = focused ? pendingView : unfocusedText
  const showTranscript = focused ? showPending : (voiceOn && unfocusedText.length > 0)

  // Newest words against the bottom: a long turn scrolls its own beginning
  // away rather than growing the composer.
  const transcriptRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [transcriptText])

  return (
    <div
      className={`pt-3.5 pr-3 pb-2.5 pl-4 font-sans transition-colors duration-150 ${
        embedded
          ? ''
          : `rounded-[1.25rem] border border-transparent ${focused ? 'bg-[var(--dock-fill-focus)]' : 'bg-[var(--dock-fill)]'}`
      }`}
    >
      {/* Unfocused: the composer is the display, in the field's own place
          rather than above it. Capped and scrolling rather than growing,
          and never shorter than the one line the field held, so speaking
          does not change the composer's size. Muted, because the system is
          filling it; the field's own colour means the user has it. */}
      {showTranscript && !focused && (
        <div
          ref={transcriptRef}
          // Clicking the words focuses the field, which is where they go to
          // be edited — the field itself is off-screen while this stands in
          // for it, so it cannot be reached any other way.
          onMouseDown={(e) => { e.preventDefault(); textareaProps.ref.current?.focus() }}
          className="voice-composer-transcript scrollbar-none mb-[18px] min-h-[1lh] cursor-text overflow-y-auto text-base leading-normal text-muted-foreground"
        >
          {transcriptText}
        </div>
      )}
      <Textarea
        {...textareaProps}
        className={`!rounded-none !bg-transparent !border-0 !shadow-none !ring-0 !p-0 !pb-[18px] !text-base !leading-normal !font-sans resize-none field-sizing-content ${
          showTranscript && !focused ? 'sr-only' : ''
        } ${
          // README §3 "Focused form": "Field: min-height: 104px" — the space
          // the collapsing transport row gives up, so the words being typed
          // stay the tallest thing on screen. Only applies while the
          // collapsed player is actually present (ComposerDock's mobile
          // focus-collapse); everywhere else the field keeps its ordinary
          // no-minimum sizing.
          collapsedPlayer ? '!min-h-[104px]' : '!min-h-0'
        }`}
        placeholder="Type a message…"
        disabled={isStreaming || disabled}
        enterKeyHint="send"
        rows={1}
      />
      {/* Focused: pending entries the field does not own, read-only, after
          the field — so words paused at the moment of focus never leave the
          screen while they wait to settle into it. */}
      {showTranscript && focused && (
        <div
          ref={transcriptRef}
          className="voice-composer-transcript scrollbar-none mb-[18px] min-h-[1lh] overflow-y-auto text-base leading-normal text-muted-foreground"
        >
          {transcriptText}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-3">
        {/* Yields first: a model name is information, the send button is the
            action. */}
        <div className="flex min-w-0 shrink-[3] items-center overflow-hidden">
          {collapsedPlayer ?? modelPicker}
        </div>
        {/* Right-anchored as one group, so a control appearing inside it
            grows leftward from the send button's fixed edge. */}
        <div className="ml-auto flex min-w-0 items-center gap-2.5">
          {!voiceStarting && voiceOn && (
            <>
              <span className="hidden sm:inline text-xs text-muted-foreground/70 select-none">
                / to type · space to mute/unmute{!muteLinked && ' · set separately'}
              </span>
              {!muteLinked && relinkMutes && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={`${roundBtn} bg-transparent text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)] hover:text-foreground`}
                  onClick={relinkMutes}
                  title="Mic and speech are set separately — link them"
                >
                  <Link2Off className="size-[17px]" strokeWidth={1.8} />
                </Button>
              )}
            </>
          )}
          <div className="flex min-w-0 items-center gap-1">
            {voiceStarting && (
              // The button carries the wait: the spinner sits where the tap
              // landed rather than in the control bar, and the same control
              // is the way out — pressing it turns voice off, unwinding
              // startup at whatever stage it reached.
              <Button
                type="button"
                variant="ghost"
                aria-busy="true"
                // `shrink` overrides the button variant's own shrink-0. It is
                // the only control here that gives up width, and the label
                // goes before the spinner does.
                className="h-11 min-w-0 shrink gap-2 rounded-full border border-transparent bg-[var(--neutral-fill)] px-4 text-[15px] font-sans font-[480] text-foreground transition-all duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_16%,transparent)]"
                onClick={() => onVoiceToggle(false)}
                title="Starting voice — press to cancel"
              >
                <Loader2 size={18} strokeWidth={1.8} className="shrink-0 animate-spin" />
                <span className="truncate">Starting</span>
              </Button>
            )}
            {!voiceStarting && !voiceOn && gate && (
              // README §4: the commit is a labeled control in place in the
              // composer cluster, replacing the plain voice button for as
              // long as the gate is armed.
              <>
                <button
                  type="button"
                  onClick={gate.onCommit}
                  className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-[color-mix(in_oklch,var(--warning)_50%,transparent)] bg-[var(--warning-subtle)] px-3.5 text-[13.5px] font-medium text-[var(--warning-subtle-fg)]"
                >
                  <AudioLines className="size-4" />
                  Close player, start voice
                </button>
                <button
                  type="button"
                  onClick={gate.onCancel}
                  className="h-11 shrink-0 px-1.5 text-[13px] text-muted-foreground"
                >
                  Keep listening
                </button>
              </>
            )}
            {!voiceStarting && !voiceOn && !gate && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={`${roundBtn} bg-[var(--neutral-fill)] hover:bg-[color-mix(in_oklch,var(--foreground)_16%,transparent)]`}
                onClick={() => onVoiceToggle(true)}
                title="Turn voice on"
              >
                <AudioLines size={18} strokeWidth={1.8} />
              </Button>
            )}
            {!voiceStarting && voiceOn && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={`${roundBtn} ${speechMuted ? 'bg-[var(--sec-pressed-bg)] text-[var(--sec-pressed-fg)]' : 'hover:bg-[color-mix(in_oklch,var(--foreground)_16%,transparent)]'}`}
                  onClick={toggleSpeechMuted}
                  title={speechMuted ? 'Unmute speech' : 'Mute speech only'}
                >
                  {speechMuted ? <VolumeX size={18} strokeWidth={1.8} /> : <Volume2 size={18} strokeWidth={1.8} />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className={`h-11 min-w-0 gap-2 rounded-full border border-transparent px-5 text-[15px] font-sans font-[480] transition-all duration-150 ${
                    muted ? 'bg-[var(--warning)] text-[var(--warning-fg)]' : 'bg-[var(--neutral-fill)] text-foreground'
                  }`}
                  onClick={toggleMuteAll}
                  title={`${micMuted ? 'Unmute' : 'Mute'} ${muteLinked ? 'everything' : 'the mic'} (spacebar)`}
                >
                  {muted ? <MicOff size={18} strokeWidth={1.8} className="shrink-0" /> : <Mic size={18} strokeWidth={1.8} className="shrink-0" />}
                  <span className="truncate">{pillLabel}</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={`${roundBtn} bg-[var(--neutral-fill)] hover:bg-[color-mix(in_oklch,var(--foreground)_16%,transparent)]`}
                  onClick={() => onVoiceToggle(false)}
                  title="Turn voice off"
                >
                  <X size={17} strokeWidth={1.8} />
                </Button>
              </>
            )}
          </div>
          {/* Never shrinks: the action stays reachable. */}
          <div className="shrink-0">
            <ChatSendButton
              isStreaming={isStreaming}
              disabled={sendDisabled}
              onSend={submit}
              onStop={onStop}
              size="xl"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
