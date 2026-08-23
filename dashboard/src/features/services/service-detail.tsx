import { useState, useEffect } from 'react'
import { Info } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { getCapabilities, getHosts, updateService, type ServiceWithHealth, type Capability, type Host } from '@/lib/api'
import { ServiceHistory } from '@/features/services/service-history'
import { Badge } from '@/components/ui/badge'
import { healthBadgeClass, healthLabel } from '@/lib/health-badge'

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const secs = Math.floor(diffMs / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

function InfoTip({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="size-3 text-muted-foreground cursor-help inline-block ml-1" />
      </TooltipTrigger>
      <TooltipContent className="max-w-56 text-xs">{children}</TooltipContent>
    </Tooltip>
  )
}

interface Props {
  service: ServiceWithHealth
  onUpdate: (updated: ServiceWithHealth) => void
}

export function ServiceDetail({ service, onUpdate }: Props) {
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [hosts, setHosts] = useState<Host[]>([])

  const [healthPath, setHealthPath] = useState(service.network.healthPath)
  const [capabilityId, setCapabilityId] = useState(service.capabilityId)
  const [hostId, setHostId] = useState(service.hostId)
  const [port, setPort] = useState(service.network.port !== undefined ? String(service.network.port) : '')
  const [listenAddress, setListenAddress] = useState(service.network.listenAddress ?? '')
  const [tailscaleServe, setTailscaleServe] = useState(service.network.tailscaleServe ?? false)
  const [loadStrategy, setLoadStrategy] = useState<'startup' | 'demand'>(service.lifecycle?.loadStrategy ?? 'startup')
  const [autoStart, setAutoStart] = useState(service.lifecycle?.autoStart ?? false)
  const [idleUnload, setIdleUnload] = useState(service.lifecycle?.idleUnload ?? false)
  const [idleTimeout, setIdleTimeout] = useState(service.lifecycle?.idleTimeout !== undefined ? String(service.lifecycle.idleTimeout / 60000) : '')
  const [startupTime, setStartupTime] = useState(service.lifecycle?.startupTime !== undefined ? String(service.lifecycle.startupTime / 1000) : '')
  const [restartOnCrash, setRestartOnCrash] = useState(service.lifecycle?.restartOnCrash ?? false)
  const [maxRestarts, setMaxRestarts] = useState(service.lifecycle?.maxRestarts !== undefined ? String(service.lifecycle.maxRestarts) : '')
  const [restartBackoff, setRestartBackoff] = useState(service.lifecycle?.restartBackoff !== undefined ? String(service.lifecycle.restartBackoff / 1000) : '')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setHealthPath(service.network.healthPath)
    setCapabilityId(service.capabilityId)
    setHostId(service.hostId)
    setPort(service.network.port !== undefined ? String(service.network.port) : '')
    setListenAddress(service.network.listenAddress ?? '')
    setTailscaleServe(service.network.tailscaleServe ?? false)
    setLoadStrategy(service.lifecycle?.loadStrategy ?? 'startup')
    setAutoStart(service.lifecycle?.autoStart ?? false)
    setIdleUnload(service.lifecycle?.idleUnload ?? false)
    setIdleTimeout(service.lifecycle?.idleTimeout !== undefined ? String(service.lifecycle.idleTimeout / 60000) : '')
    setStartupTime(service.lifecycle?.startupTime !== undefined ? String(service.lifecycle.startupTime / 1000) : '')
    setRestartOnCrash(service.lifecycle?.restartOnCrash ?? false)
    setMaxRestarts(service.lifecycle?.maxRestarts !== undefined ? String(service.lifecycle.maxRestarts) : '')
    setRestartBackoff(service.lifecycle?.restartBackoff !== undefined ? String(service.lifecycle.restartBackoff / 1000) : '')
    setDirty(false)
  }, [service])

  useEffect(() => {
    void getCapabilities().then(setCapabilities).catch(() => { })
    void getHosts().then(setHosts).catch(() => { })
  }, [service.id])

  function markDirty() { setDirty(true) }

  async function handleSave() {
    const patch: Record<string, unknown> = {}
    const networkPatch: Record<string, unknown> = {}
    const lifecyclePatch: Record<string, unknown> = {}

    if (capabilityId !== service.capabilityId) patch.capabilityId = capabilityId
    if (hostId !== service.hostId) patch.hostId = hostId

    if (healthPath !== service.network.healthPath) networkPatch.healthPath = healthPath
    if (tailscaleServe !== (service.network.tailscaleServe ?? false)) networkPatch.tailscaleServe = tailscaleServe

    const portNum = port !== '' ? parseInt(port, 10) : undefined
    if (portNum !== service.network.port) {
      if (port !== '' && isNaN(portNum!)) { toast.error('Port must be a number'); return }
      networkPatch.port = portNum
    }

    const listenAddressVal = listenAddress !== '' ? listenAddress : undefined
    if (listenAddressVal !== service.network.listenAddress) networkPatch.listenAddress = listenAddressVal

    if (loadStrategy !== (service.lifecycle?.loadStrategy ?? 'startup')) lifecyclePatch.loadStrategy = loadStrategy
    if (autoStart !== (service.lifecycle?.autoStart ?? false)) lifecyclePatch.autoStart = autoStart
    if (idleUnload !== (service.lifecycle?.idleUnload ?? false)) lifecyclePatch.idleUnload = idleUnload

    const idleTimeoutMs = idleTimeout !== '' ? parseFloat(idleTimeout) * 60000 : undefined
    if (idleTimeoutMs !== service.lifecycle?.idleTimeout) {
      if (idleTimeout !== '' && isNaN(idleTimeoutMs!)) { toast.error('Idle timeout must be a number'); return }
      lifecyclePatch.idleTimeout = idleTimeoutMs
    }

    const startupTimeMs = startupTime !== '' ? parseFloat(startupTime) * 1000 : undefined
    if (startupTimeMs !== service.lifecycle?.startupTime) {
      if (startupTime !== '' && isNaN(startupTimeMs!)) { toast.error('Startup time must be a number'); return }
      lifecyclePatch.startupTime = startupTimeMs
    }

    if (restartOnCrash !== (service.lifecycle?.restartOnCrash ?? false)) lifecyclePatch.restartOnCrash = restartOnCrash

    const maxRestartsNum = maxRestarts !== '' ? parseInt(maxRestarts, 10) : undefined
    if (maxRestartsNum !== service.lifecycle?.maxRestarts) {
      if (maxRestarts !== '' && isNaN(maxRestartsNum!)) { toast.error('Max restarts must be a number'); return }
      lifecyclePatch.maxRestarts = maxRestartsNum
    }

    const restartBackoffMs = restartBackoff !== '' ? parseFloat(restartBackoff) * 1000 : undefined
    if (restartBackoffMs !== service.lifecycle?.restartBackoff) {
      if (restartBackoff !== '' && isNaN(restartBackoffMs!)) { toast.error('Restart backoff must be a number'); return }
      lifecyclePatch.restartBackoff = restartBackoffMs
    }

    if (Object.keys(networkPatch).length) patch.network = networkPatch
    if (Object.keys(lifecyclePatch).length) patch.lifecycle = lifecyclePatch

    if (Object.keys(patch).length === 0) { setDirty(false); return }

    setSaving(true)
    try {
      const updated = await updateService(service.id, patch)
      onUpdate(updated)
      setDirty(false)
      toast.success('Saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setHealthPath(service.network.healthPath)
    setCapabilityId(service.capabilityId)
    setHostId(service.hostId)
    setPort(service.network.port !== undefined ? String(service.network.port) : '')
    setListenAddress(service.network.listenAddress ?? '')
    setTailscaleServe(service.network.tailscaleServe ?? false)
    setLoadStrategy(service.lifecycle?.loadStrategy ?? 'startup')
    setAutoStart(service.lifecycle?.autoStart ?? false)
    setIdleUnload(service.lifecycle?.idleUnload ?? false)
    setIdleTimeout(service.lifecycle?.idleTimeout !== undefined ? String(service.lifecycle.idleTimeout / 60000) : '')
    setStartupTime(service.lifecycle?.startupTime !== undefined ? String(service.lifecycle.startupTime / 1000) : '')
    setRestartOnCrash(service.lifecycle?.restartOnCrash ?? false)
    setMaxRestarts(service.lifecycle?.maxRestarts !== undefined ? String(service.lifecycle.maxRestarts) : '')
    setRestartBackoff(service.lifecycle?.restartBackoff !== undefined ? String(service.lifecycle.restartBackoff / 1000) : '')
    setDirty(false)
  }

  const capabilityName = capabilities.find((c) => c.id === capabilityId)?.name ?? capabilityId

  return (
    <div className="space-y-4 -mt-3">

      {/* ── Status header ── */}
      <div className="">
        {/* Row 1: capability + protected/enabled */}
        <div className="flex items-center text-base">
          <span className="text-muted-foreground">{capabilityName}</span>
          {service.permissions.protected && <Badge variant="outline">protected</Badge>}
          <span className="text-muted-foreground">, is currently {service.permissions.enabled ? 'enabled' : 'disabled'}</span>
        </div>

        {/* Row 2: badge + timestamp + History */}
        <div className="flex items-center gap-3 mt-5">
          <Badge className={healthBadgeClass[service.health]}>{healthLabel[service.health]}</Badge>
          {service.lastEvent && (
            <span className="text-muted-foreground">{relativeTime(service.lastEvent.timestamp)}</span>
          )}
          <div className="">
            <ServiceHistory serviceId={service.id} serviceName={service.id} />
          </div>
        </div>
      </div>

      <Separator />

      {/* ── Network ── */}
      <div className="space-y-3">
        <p className="text-base font-medium">Network</p>

        {/* Host + Port + Tailscale Serve */}
        <div className="flex items-center gap-6">
          <div className="space-y-3">
            <Label className="text-muted-foreground">Host</Label>
            <Select value={hostId} onValueChange={(v) => { setHostId(v); markDirty() }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {hosts.map((h) => (
                  <SelectItem key={h.id} value={h.id}>{h.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-3 w-20">
            <Label className="text-muted-foreground">Port</Label>
            <Input
              value={port}
              onChange={(e) => { setPort(e.target.value); markDirty() }}
              placeholder="8080"
            />
          </div>
          <div className="flex items-center gap-2 pt-6">
            <Switch
              id="tailscale-serve"
              checked={tailscaleServe}
              onCheckedChange={(v) => { setTailscaleServe(v); markDirty() }}
            />
            <Label htmlFor="tailscale-serve" className="cursor-pointer">Tailscale Serve</Label>
            <InfoTip>When enabled, the shard registers this service with Tailscale Serve on load, making it reachable across the mesh network without a separate proxy.</InfoTip>
          </div>
        </div>

        {/* URL (read-only, derived from host + port) */}
        <div className="space-y-3">
          <Label className="text-muted-foreground">URL</Label>
          <p className="text-sm font-mono text-muted-foreground truncate">{service.network.endpoint}</p>
        </div>

        {/* Health path + Listen address */}
        <div className="grid grid-cols-2 gap-4 mt-5">
          <div className="space-y-2">
            <Label className="text-muted-foreground">Health path</Label>
            <Input
              value={healthPath}
              onChange={(e) => { setHealthPath(e.target.value); markDirty() }}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-muted-foreground">
              Listen address
              <InfoTip>Override the address this service binds to (e.g. 127.0.0.1 for localhost-only). Leave blank to use the host's default.</InfoTip>
            </Label>
            <Input
              value={listenAddress}
              onChange={(e) => { setListenAddress(e.target.value); markDirty() }}
              placeholder="0.0.0.0"
            />
          </div>
        </div>
      </div>

      <Separator />

      {/* ── Lifecycle ── */}
      <div className="space-y-5">
        <p className="text-base font-medium">Lifecycle</p>

        {/* Loading */}
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Loading</p>
          <div className="flex items-center gap-6">
            <div className="space-y-1">
              <Label className="text-muted-foreground">
                Load strategy
                <InfoTip>Startup: service is always running. Demand: service is started on first request and stopped when idle.</InfoTip>
              </Label>
              <Select value={loadStrategy} onValueChange={(v) => { setLoadStrategy(v as 'startup' | 'demand'); markDirty() }}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="startup">Startup</SelectItem>
                  <SelectItem value="demand">Demand</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 pt-5">
              <Switch
                id="auto-start"
                checked={autoStart}
                onCheckedChange={(v) => { setAutoStart(v); markDirty() }}
              />
              <Label htmlFor="auto-start" className="cursor-pointer">Auto-start</Label>
              <InfoTip>When enabled, the shard will load this service automatically when the shard process starts up.</InfoTip>
            </div>
          </div>
        </div>

        {/* Idle eviction */}
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Idle eviction</p>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch
                id="idle-unload"
                checked={idleUnload}
                onCheckedChange={(v) => { setIdleUnload(v); markDirty() }}
              />
              <Label htmlFor="idle-unload" className="cursor-pointer">
                Unload when idle
                <InfoTip>When enabled, the shard will stop this service after the timeout period with no activity, freeing memory for other services.</InfoTip>
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={idleTimeout}
                onChange={(e) => { setIdleTimeout(e.target.value); markDirty() }}
                placeholder="5"
                disabled={!idleUnload}
                className="w-16"
              />
              <span className="text-sm text-muted-foreground">min</span>
            </div>
          </div>
        </div>

        {/* Startup & Restart */}
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Startup &amp; restart</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                Startup grace period
                <InfoTip>How long (in seconds) to wait before starting health checks after the service starts. Default: 30s.</InfoTip>
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  value={startupTime}
                  onChange={(e) => { setStartupTime(e.target.value); markDirty() }}
                  placeholder="30"
                  className="w-20"
                />
                <span className="text-sm text-muted-foreground">sec</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Switch
                id="restart-on-crash"
                checked={restartOnCrash}
                onCheckedChange={(v) => { setRestartOnCrash(v); markDirty() }}
              />
              <Label htmlFor="restart-on-crash" className="cursor-pointer">
                Restart on crash
                <InfoTip>Auto-restart the service when it exits unexpectedly. Process runner only.</InfoTip>
              </Label>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                Max restarts
                <InfoTip>Maximum number of restart attempts before giving up. Default: 3.</InfoTip>
              </Label>
              <Input
                value={maxRestarts}
                onChange={(e) => { setMaxRestarts(e.target.value); markDirty() }}
                placeholder="3"
                disabled={!restartOnCrash}
                className="w-20"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                Restart backoff
                <InfoTip>Initial delay before each restart attempt in seconds. Default: 5s.</InfoTip>
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  value={restartBackoff}
                  onChange={(e) => { setRestartBackoff(e.target.value); markDirty() }}
                  placeholder="5"
                  disabled={!restartOnCrash}
                  className="w-20"
                />
                <span className="text-sm text-muted-foreground">sec</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Save / Cancel ── */}
      {dirty && (
        <>
          <Separator />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={handleCancel}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
