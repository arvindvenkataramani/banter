import { useCallback, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { cancelArm } from '@/lib/media-voice-mode'
import { useTranscriptStore, editTranscript, takeTranscript } from '@/lib/voice'
import { useTurnManagerStore, reportComposerSend, reportComposerFocus } from '@/lib/voice'
import { usePendingView } from '@/lib/voice/human/use-revealed-transcript'

export interface UseChatTextareaOpts {
  onSend: (text: string) => void
  setMicAutoMuted: (active: boolean) => void
}

/**
 * Shared textarea wiring used by every chat input variant.
 *
 * The field is a controlled input over the transcript store's `settled`:
 * focusing copies nothing in and blurring writes nothing back, because there
 * is nothing to copy — the field's value *is* the store's value, always.
 * Owns the ref, focus/blur handlers (with auto-mute and the composer's own
 * focus report), Enter-to-submit, and Esc-to-blur. Returns a `props` object
 * to spread onto a Textarea, plus state and a manual `submit()` for the
 * adjacent send button.
 *
 * Mobile and desktop use this differently — mobile only mounts the
 * textarea after a "Type" tap, desktop always mounts it — but the
 * mechanics are identical once mounted.
 */
export function useChatTextarea({ onSend, setMicAutoMuted }: UseChatTextareaOpts) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [focused, setFocused] = useState(false)
  const settled = useStore(useTranscriptStore, (s) => s.settled)
  const pendingView = usePendingView()
  // Whether the send button is enabled reads the whole view — settled text
  // plus whatever is still pending — so words not yet settled are as
  // sendable-looking as words that are.
  const hasContent = settled.length > 0 || pendingView.length > 0

  /**
   * With a human turn open (`speaking`), the send button reports a composer
   * send and lets delivery send the whole turn once it closes — the turn
   * may still have a live utterance, in which case the turn stays open and
   * closes once that utterance settles. With no turn open, this sends
   * `takeTranscript()` directly, as a typed message always has.
   *
   * A submit leaves the field's auto-mute in force while the field keeps
   * focus — Enter-to-submit does not blur the field, so nothing here
   * should turn the mic back on underneath a still-focused field; only
   * `handleBlur` clears it.
   */
  const submit = useCallback(() => {
    if (!hasContent) return
    const turn = useTurnManagerStore.getState().snapshot.human
    if (turn !== null && turn.phase === 'speaking') {
      reportComposerSend()
      return
    }
    const text = takeTranscript().trim()
    if (!text) return
    onSend(text)
  }, [hasContent, onSend])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      ref.current?.blur()
    }
  }, [submit])

  // H7: the field taking focus re-locks the gate — the collapse this same
  // event triggers on mobile (README §3) already means an armed row can't
  // stay visible through it, and this is what keeps the *state* from
  // surviving invisibly alongside that.
  const handleFocus = useCallback(() => {
    setFocused(true)
    setMicAutoMuted(true)
    reportComposerFocus(true)
    cancelArm()
  }, [setMicAutoMuted])

  const handleBlur = useCallback(() => {
    setFocused(false)
    setMicAutoMuted(false)
    reportComposerFocus(false)
  }, [setMicAutoMuted])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    editTranscript(e.target.value)
  }, [])

  return {
    ref,
    hasContent,
    focused,
    /** True when the user wants to type — focused OR has text content. */
    wantsInput: focused || hasContent,
    submit,
    /** Spread onto the Textarea component. */
    textareaProps: {
      ref,
      value: settled,
      onKeyDown: handleKeyDown,
      onFocus: handleFocus,
      onBlur: handleBlur,
      onChange: handleChange,
    },
  }
}
