import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  isStreaming: boolean
  disabled: boolean
  onSend: () => void
  onStop: () => void
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

const sizeMap = {
  sm: { btn: 'size-7', icon: 'size-3.5' },
  md: { btn: 'size-9', icon: 'size-4' },
  lg: { btn: 'size-10', icon: 'size-[18px]' },
  xl: { btn: 'size-11', icon: 'size-[18px]' },
} as const

/**
 * Circular send/stop button used inside chat textareas.
 * Streaming → destructive Square; otherwise → muted-primary ArrowUp.
 * Caller positions it absolutely within the textarea wrap.
 */
export function ChatSendButton({ isStreaming, disabled, onSend, onStop, size = 'md' }: Props) {
  const s = sizeMap[size]
  if (isStreaming) {
    return (
      <Button variant="destructive" size="icon" className={`${s.btn} rounded-full`} onClick={onStop} aria-label="Stop">
        <Square className={s.icon} />
      </Button>
    )
  }
  return (
    <Button
      variant="default"
      size="icon"
      className={`${s.btn} rounded-full disabled:opacity-45 ${disabled ? '' : 'dashboard-chrome'}`}
      style={disabled ? { background: 'color-mix(in oklch, var(--foreground) 8%, transparent)', color: 'var(--muted-foreground)' } : undefined}
      onClick={onSend}
      disabled={disabled}
      aria-label="Send"
    >
      <ArrowUp className={s.icon} />
    </Button>
  )
}
