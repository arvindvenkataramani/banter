import { memo } from 'react'
import type { Components } from 'react-markdown'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DeliveryStatus } from '@/lib/conversation-store'

interface Props {
  role: 'user' | 'assistant'
  text: string
  isStreaming?: boolean
  senderAgentId?: string
  delivery?: DeliveryStatus
  onResend?: () => void
}

const mdComponents: Components = {
  code({ children, className }) {
    const isBlock = className?.startsWith('language-')
    if (isBlock) {
      return <code className={`${className} text-[0.9em] font-normal`}>{children}</code>
    }
    return (
      <code className="rounded-md bg-foreground/10 dark:bg-foreground/15 px-1.5 py-0.5 text-[0.9em] font-normal before:content-none after:content-none">
        {children}
      </code>
    )
  },
  pre({ children }) {
    return (
      <pre className="rounded-xl bg-foreground/10 dark:bg-foreground/15 text-foreground p-4 overflow-x-auto">
        {children}
      </pre>
    )
  },
}

const remarkPlugins = [remarkGfm]

// Parsing builds a full syntax tree per message, and the list re-renders on
// every streamed token and voice state change. Memoized on text, so only the
// message whose text changed is parsed again.
const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return <Markdown remarkPlugins={remarkPlugins} components={mdComponents}>{text}</Markdown>
})

export function MessageBubble({ role, text, isStreaming, senderAgentId, delivery, onResend }: Props) {
  if (role === 'user') {
    // delivery is absent for history rows (long confirmed) — only style the
    // two states that need visibility: pending (unconfirmed) and failed
    // (stays in place, resend affordance, no content movement).
    const bubbleClassName = delivery === 'pending' ? 'msg-user opacity-60' : 'msg-user'
    const bubble = (
      <div className="self-end flex flex-col items-end gap-1">
        <div className={bubbleClassName}>
          <MarkdownText text={text} />
        </div>
        {delivery === 'failed' && (
          <div className="flex items-center gap-1.5 text-xs text-destructive">
            <span>Failed to send</span>
            {onResend && (
              <Button variant="ghost" size="sm" className="h-5 px-1.5 text-xs text-destructive hover:text-destructive" onClick={onResend}>
                <RotateCcw className="size-3" />
                Resend
              </Button>
            )}
          </div>
        )}
      </div>
    )
    if (senderAgentId) {
      return (
        <div className="self-end max-w-[32rem] flex flex-col items-end">
          <p className="text-xs text-muted-foreground mb-1 font-mono">{senderAgentId}</p>
          {bubble}
        </div>
      )
    }
    return bubble
  }

  return (
    <div className="msg-assistant">
      <MarkdownText text={text} />
      {isStreaming && <span className="opacity-60">▊</span>}
    </div>
  )
}
