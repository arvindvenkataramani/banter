import { useState } from 'react'
import { CopyIcon } from '@phosphor-icons/react/dist/csr/Copy'
import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise'
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play'
import { StopIcon } from '@phosphor-icons/react/dist/csr/Stop'
import { LockIcon } from '@phosphor-icons/react/dist/csr/Lock'
import { GearSixIcon } from '@phosphor-icons/react/dist/csr/GearSix'
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ClockCounterClockwise'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { checkService, startService, stopService, type ServiceWithHealth } from '@/lib/api'
import { ServiceDetail, type ServiceDetailTab } from '@/features/services/service-detail'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { healthBadgeClass, healthLabel, serviceIsRunning } from '@/lib/health-badge'

function hostPort(endpoint: string): string {
  try {
    const u = new URL(endpoint)
    const host = u.hostname.split('.')[0]
    return `${host}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return endpoint
  }
}

interface Props {
  service: ServiceWithHealth
  capabilityName?: string
  onUpdate: (updated: ServiceWithHealth) => void
}

export function ServiceCard({ service, capabilityName, onUpdate }: Props) {
  const [toggleState, setToggleState] = useState<null | 'starting' | 'timed-out' | 'stopping' | 'cancelling'>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Which tab the detail dialog opens on, and null when it is closed.
  const [detailTab, setDetailTab] = useState<ServiceDetailTab | null>(null)

  function openDetail(tab: ServiceDetailTab) { setDetailTab(tab) }

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

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  async function handlePlayPause() {
    const isRunning = serviceIsRunning[service.health]

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
          if (!serviceIsRunning[updated.health]) { setToggleState(null); return }
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
        // A slow starter gets the whole window to reach `healthy` before the
        // state is judged, so a service still registering Tailscale Serve is
        // not called a failure. At the deadline a running-but-unreachable
        // service is still running, and only a service that never came up at
        // all is worth offering to cancel.
        const deadline = Date.now() + 30000
        let last = service
        while (Date.now() < deadline) {
          await sleep(1000)
          last = await checkService(service.id)
          onUpdate(last)
          if (last.health === 'healthy') { setToggleState(null); return }
        }
        setToggleState(serviceIsRunning[last.health] ? null : 'timed-out')
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
        {/* Row 1: Service name + capability · history + status badge */}
        <div className="flex items-center gap-2">
          {service.permissions.protected && <LockIcon weight="bold" className="size-4 shrink-0" />}
          <p className="text-lg font-semibold truncate">{service.name ?? service.id}</p>
          <span className="text-muted-foreground truncate">{capabilityName ?? service.capabilityId}</span>
          <div className="ml-auto shrink-0">
            {disabled ? (
              <Badge className={badgeClass}>{healthLabel[service.health]}</Badge>
            ) : (
              // The badge is the refresh control: it already reports the health
              // a re-check would update, so a separate button restated it.
              <Badge asChild className={cn(badgeClass, 'group/badge cursor-pointer')}>
                <button type="button" onClick={handleRefresh} disabled={refreshing} title="Refresh health">
                  {/* Label and icon occupy the same grid cell, so swapping them
                      on hover cannot change the badge's size or shift the row. */}
                  <span className="grid grid-cols-1 grid-rows-1 place-items-center">
                    <span
                      className={cn(
                        'col-start-1 row-start-1',
                        refreshing ? 'invisible' : 'group-hover/badge:invisible group-focus-visible/badge:invisible'
                      )}
                    >
                      {healthLabel[service.health]}
                    </span>
                    <ArrowClockwiseIcon weight="bold"
                      className={cn(
                        'col-start-1 row-start-1 size-3',
                        refreshing ? 'animate-spin' : 'invisible group-hover/badge:visible group-focus-visible/badge:visible'
                      )}
                    />
                  </span>
                </button>
              </Badge>
            )}
          </div>
        </div>

        {/* Row 2: start + history (left) · copy, url, settings (right) */}
        <div className="flex items-center gap-1 mt-2 -mx-2">
          {!service.permissions.protected && service.runner && service.runner.type !== 'external' && (
            toggleState === 'timed-out' ? (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-destructive"
                onClick={handleCancelStartup}
              >
                <StopIcon weight="bold" />
                Cancel startup
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={handlePlayPause}
                disabled={disabled || toggleState !== null}
              >
                {toggleState === 'stopping' || toggleState === 'cancelling' || serviceIsRunning[service.health] ? (
                  <>
                    <StopIcon weight="bold" />
                    {toggleState === 'stopping' ? 'Stopping…' : toggleState === 'cancelling' ? 'Cancelling…' : 'Stop'}
                  </>
                ) : (
                  <>
                    <PlayIcon weight="bold" />
                    {toggleState === 'starting' ? 'Starting…' : 'Start'}
                  </>
                )}
              </Button>
            )
          )}
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            title="History"
            onClick={() => openDetail('history')}
          >
            <ClockCounterClockwiseIcon weight="bold" />
          </Button>
          {/* The url and the button that copies it read as one unit. */}
          <div className="ml-auto flex items-center gap-1 min-w-0">
            <a
              href={disabled ? undefined : service.network.endpoint}
              target="_blank"
              rel="noopener noreferrer"
              className={cn('text-sm text-muted-foreground truncate', !disabled && 'hover:underline')}
              aria-disabled={disabled}
            >
              {hostPort(service.network.endpoint ?? '')}
            </a>
            <Button variant="ghost" size="icon" className="shrink-0" onClick={handleCopy} title="Copy URL" disabled={disabled}>
              <CopyIcon weight="bold" />
            </Button>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {/* Never disabled: settings holds the enable toggle, so it is the
                way back for a service that is switched off. */}
            <Button variant="ghost" size="icon" title="Settings" onClick={() => openDetail('network')}>
              <GearSixIcon weight="bold" />
            </Button>
            {/* One dialog, two ways in: the icon that opened it picks the tab. */}
            <Dialog open={detailTab !== null} onOpenChange={(open) => !open && setDetailTab(null)}>
              <DialogContent className="sm:max-w-[672px] max-h-[calc(100dvh-4rem)] grid-rows-[auto_minmax(0,1fr)]" aria-describedby={undefined}>
                <DialogHeader>
                  <DialogTitle className="text-xl">{service.name ?? service.id}</DialogTitle>
                </DialogHeader>
                {detailTab && (
                  <ServiceDetail service={service} onUpdate={onUpdate} initialTab={detailTab} />
                )}
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
