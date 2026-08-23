import { AudioLines, Link2Off, Mic, MicOff, Volume2, VolumeX, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ChatSendButton } from './chat-send-button'
import { useChatTextarea } from './use-chat-textarea'

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
}

const roundBtn = "size-11 rounded-full border border-transparent text-foreground transition-all duration-150 font-sans font-[480]"

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
}: Props) {
  const { focused, hasContent, submit, textareaProps } = useChatTextarea({ onSend, setMicAutoMuted })

  // autoMuted / muted mirror the handoff's state table exactly: focusing the
  // field auto-mutes while voice is on; a manual mute (isMuteAll) is sticky
  // and independent of focus.
  // Shows mic state only — while unlinked, speech may differ and the speech
  // button reports that independently.
  const autoMuted = voiceOn && focused && !micMuted
  const muted = voiceOn && (micMuted || autoMuted)
  const pillLabel = muted ? (autoMuted ? 'Muted while typing' : 'Muted') : 'Listening'

  const sendDisabled = disabled || !hasContent

  return (
    <div
      className="rounded-[1.25rem] border border-transparent pt-3.5 pr-3 pb-2.5 pl-4 font-sans transition-colors duration-150"
      style={{ background: focused ? 'var(--dock-fill-focus)' : 'var(--dock-fill)' }}
    >
      <Textarea
        {...textareaProps}
        className="!min-h-0 !rounded-none !bg-transparent !border-0 !shadow-none !ring-0 !p-0 !pb-[18px] !text-base !leading-normal !font-sans resize-none field-sizing-content"
        placeholder="Type a message…"
        disabled={isStreaming || disabled}
        enterKeyHint="send"
        rows={1}
      />
      <div className="flex items-center gap-3">
        {modelPicker}
        <div className="ml-auto flex items-center gap-2.5">
          {voiceOn && (
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
          <div className="flex items-center gap-1">
            {!voiceOn && (
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
            {voiceOn && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={`${roundBtn} ${speechMuted ? '' : 'hover:bg-[color-mix(in_oklch,var(--foreground)_16%,transparent)]'}`}
                  onClick={toggleSpeechMuted}
                  title={speechMuted ? 'Unmute speech' : 'Mute speech only'}
                  style={speechMuted ? {
                    background: 'var(--sec-pressed-bg)',
                    color: 'var(--sec-pressed-fg)',
                  } : undefined}
                >
                  {speechMuted ? <VolumeX size={18} strokeWidth={1.8} /> : <Volume2 size={18} strokeWidth={1.8} />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 gap-2 rounded-full border border-transparent px-5 text-[15px] font-sans font-[480] transition-all duration-150"
                  onClick={toggleMuteAll}
                  title={`${micMuted ? 'Unmute' : 'Mute'} ${muteLinked ? 'everything' : 'the mic'} (spacebar)`}
                  style={{
                    background: muted ? 'var(--warning)' : 'var(--neutral-fill)',
                    color: muted ? 'var(--warning-fg)' : 'var(--foreground)',
                  }}
                >
                  {muted ? <MicOff size={18} strokeWidth={1.8} /> : <Mic size={18} strokeWidth={1.8} />}
                  <span>{pillLabel}</span>
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
  )
}
