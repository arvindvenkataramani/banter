import { useRef, useState, useCallback } from 'react'

export interface UseChatTextareaOpts {
  onSend: (text: string) => void
  setMicAutoMuted: (active: boolean) => void
}

/**
 * Shared textarea wiring used by every chat input variant.
 *
 * Owns the textarea ref, content tracking, focus/blur handlers (with
 * auto-mute), Enter-to-submit, and Esc-to-blur. Returns a `props` object
 * to spread onto a Textarea, plus state and a manual `submit()` for the
 * adjacent send button.
 *
 * Mobile and desktop use this differently — mobile only mounts the
 * textarea after a "Type" tap, desktop always mounts it — but the
 * mechanics are identical once mounted.
 */
export function useChatTextarea({ onSend, setMicAutoMuted }: UseChatTextareaOpts) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [hasContent, setHasContent] = useState(false)
  const [focused, setFocused] = useState(false)

  const submit = useCallback(() => {
    const text = ref.current?.value.trim()
    if (!text) return
    onSend(text)
    if (ref.current) ref.current.value = ''
    setHasContent(false)
    setMicAutoMuted(false)
  }, [onSend, setMicAutoMuted])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      ref.current?.blur()
    }
  }, [submit])

  const handleFocus = useCallback(() => {
    setFocused(true)
    setMicAutoMuted(true)
  }, [setMicAutoMuted])

  const handleBlur = useCallback(() => {
    setFocused(false)
    setMicAutoMuted(false)
  }, [setMicAutoMuted])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setHasContent(e.target.value.length > 0)
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
      onKeyDown: handleKeyDown,
      onFocus: handleFocus,
      onBlur: handleBlur,
      onChange: handleChange,
    },
  }
}
