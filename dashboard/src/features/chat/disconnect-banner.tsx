import { Button } from '@/components/ui/button'

interface Props {
  connectionState: 'connecting' | 'reconnecting' | 'connected' | 'disconnected'
  onRetry?: () => void
}

export function DisconnectBanner({ connectionState, onRetry }: Props) {
  if (connectionState === 'connected') return null

  const isGivenUp = connectionState === 'disconnected'
  const message = isGivenUp ? 'Disconnected' : 'Disconnected — reconnecting...'

  return (
    <div role="alert" className="flex items-center gap-2 justify-center bg-destructive/10 text-destructive py-2 text-sm">
      <span>{message}</span>
      {isGivenUp && onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  )
}
