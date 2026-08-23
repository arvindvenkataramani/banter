import { useState } from 'react'
import { Copy, RefreshCw, Play, Square, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { checkService, setEnabled, startService, stopService, type ServiceWithHealth } from '@/lib/api'
import { ServiceDetail } from '@/features/services/service-detail'
import { ServiceHistory } from '@/features/services/service-history'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { healthBadgeClass, healthLabel } from '@/lib/health-badge'

function hostPort(endpoint: string): string {
  try {
    const u = new URL(endpoint)
    const host = u.hostname.split('.')[0]
    return `${host}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return endpoint
  }
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const secs = Math.floor(diffMs / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

interface Props {
  service: ServiceWithHealth
  capabilityName?: string
  onUpdate: (updated: ServiceWithHealth) => void
}

export function ServiceCard({ service, capabilityName, onUpdate }: Props) {
  const [toggleState, setToggleState] = useState<null | 'starting' | 'timed-out' | 'stopping' | 'cancelling'>(null)
  const [refreshing, setRefreshing] = useState(false)

  async function handleRefresh() {
    setRefreshing(true)
    try {
      const updated = await checkService(service.id)
      onUpdate(updated)
    } catch { /* ignore */ } finally {
      setRefreshing(false)
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(service.network.endpoint ?? '')
      toast.success('Copied to clipboard')
    } catch {
      toast.error('Failed to copy')
    }
  }

  async function handleToggle(enabled: boolean) {
    onUpdate({ ...service, health: enabled ? 'unknown' : 'disabled', permissions: { ...service.permissions, enabled } })
    try {
      const updated = await setEnabled(service.id, enabled)
      onUpdate(updated)
    } catch (err) {
      onUpdate(service)
      toast.error(err instanceof Error ? err.message : 'Toggle failed')
    }
  }

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  async function handlePlayPause() {
    const isRunning = service.health === 'healthy'

    if (isRunning) {
      setToggleState('stopping')
      try {
        const result = await stopService(service.id)
        if (!result.success) {
          toast.error(result.error ?? 'Stop failed')
          setToggleState(null)
          return
        }
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          await sleep(1000)
          const updated = await checkService(service.id)
          onUpdate(updated)
          if (updated.health !== 'healthy') { setToggleState(null); return }
        }
        toast.error('Service did not stop in time')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Stop failed')
      } finally {
        setToggleState(null)
      }
    } else {
      setToggleState('starting')
      try {
        const result = await startService(service.id)
        if (!result.success) {
          toast.error(result.error ?? 'Start failed')
          setToggleState(null)
          return
        }
        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
          await sleep(1000)
          const updated = await checkService(service.id)
          onUpdate(updated)
          if (updated.health === 'healthy') { setToggleState(null); return }
        }
        setToggleState('timed-out')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Start failed')
        setToggleState(null)
      }
    }
  }

  async function handleCancelStartup() {
    setToggleState('cancelling')
    try {
      await stopService(service.id)
      const updated = await checkService(service.id)
      onUpdate(updated)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Cancel failed')
    } finally {
      setToggleState(null)
    }
  }

  const badgeClass = refreshing
    ? 'bg-status-muted-bg text-status-muted-fg border-status-muted-border animate-pulse'
    : healthBadgeClass[service.health]

  const disabled = !service.permissions.enabled

  return (
    <Card className={cn('w-96', service.permissions.protected && 'bg-card-muted')}>
      <CardContent>
        {/* Row 1: Service name + capability + enabled toggle */}
        <div className="flex items-center gap-2">
          {service.permissions.protected && <Lock className="size-4 shrink-0" />}
          <p className="text-lg font-semibold truncate">{service.name ?? service.id}</p>
          <span className="text-muted-foreground truncate">{capabilityName ?? service.capabilityId}</span>
          {!service.permissions.protected && (
            <Switch
              checked={service.permissions.enabled}
              onCheckedChange={handleToggle}
              aria-label="Toggle service"
              className="ml-auto shrink-0"
            />
          )}
        </div>

        {/* Row 2: host:port + copy + open (left) · time ago + badge (right) */}
        <div className="flex items-center gap-1 mt-2">
          <a
            href={disabled ? undefined : service.network.endpoint}
            target="_blank"
            rel="noopener noreferrer"
            className={cn('text-sm text-muted-foreground', !disabled && 'hover:underline')}
            aria-disabled={disabled}
          >
            {hostPort(service.network.endpoint ?? '')}
          </a>
          <Button variant="ghost" size="icon" className="shrink-0" onClick={handleCopy} title="Copy URL" disabled={disabled}>
            <Copy />
          </Button>
          <Button variant="ghost" size="sm" className="shrink-0" disabled={disabled} asChild={!disabled}>
            {disabled ? <span>Open</span> : <a href={service.network.endpoint} target="_blank" rel="noopener noreferrer">Open</a>}
          </Button>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {service.lastEvent && (
              <span className="text-muted-foreground">{relativeTime(service.lastEvent.timestamp)}</span>
            )}
            <Badge className={badgeClass}>{healthLabel[service.health]}</Badge>
          </div>
        </div>

        {/* Row 4: Controls */}
        <div className="flex items-center gap-2 mt-4 -mx-2">
          {!service.permissions.protected && service.runner && service.runner.type !== 'external' && (
            toggleState === 'timed-out' ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={handleCancelStartup}
              >
                <Square />
                Cancel startup
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={handlePlayPause}
                disabled={disabled || toggleState !== null}
              >
                {toggleState === 'stopping' || toggleState === 'cancelling' || service.health === 'healthy' ? (
                  <>
                    <Square />
                    {toggleState === 'stopping' ? 'Stopping…' : toggleState === 'cancelling' ? 'Cancelling…' : 'Stop'}
                  </>
                ) : (
                  <>
                    <Play />
                    {toggleState === 'starting' ? 'Starting…' : 'Start'}
                  </>
                )}
              </Button>
            )
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={disabled || refreshing} title="Refresh">
              <RefreshCw className={cn(refreshing && 'animate-spin')} />
            </Button>
            <ServiceHistory serviceId={service.id} serviceName={service.name ?? service.id} disabled={disabled} />
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="ghost" size="sm">
                  Details
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[672px]">
                <DialogHeader>
                  <DialogTitle className="text-xl">{service.name ?? service.id}</DialogTitle>
                </DialogHeader>
                <ServiceDetail service={service} onUpdate={onUpdate} />
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
