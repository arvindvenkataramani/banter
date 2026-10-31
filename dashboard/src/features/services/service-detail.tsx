import { useState, useEffect } from 'react'
import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getCapabilities, getHosts, setEnabled, updateService, type ServiceWithHealth, type Capability, type Host } from '@/lib/api'
import { ServiceHistoryList } from '@/features/services/service-history'
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
        <InfoIcon weight="bold" className="size-3 text-muted-foreground cursor-help inline-block ml-1" />
      </TooltipTrigger>
      <TooltipContent className="max-w-56 text-xs">{children}</TooltipContent>
    </Tooltip>
  )
}

export type ServiceDetailTab = 'network' | 'lifecycle' | 'history'

interface Props {
  service: ServiceWithHealth
  onUpdate: (updated: ServiceWithHealth) => void
  /** Which tab opens first. The card's history icon opens straight to history. */
  initialTab?: ServiceDetailTab
}

export function ServiceDetail({ service, onUpdate, initialTab = 'network' }: Props) {
  const [tab, setTab] = useState<string>(initialTab)
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [hosts, setHosts] = useState<Host[]>([])

  const [notes, setNotes] = useState(service.notes ?? '')
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
    setNotes(service.notes ?? '')
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

  async function handleToggleEnabled(enabled: boolean) {
    onUpdate({ ...service, health: enabled ? 'unknown' : 'disabled', permissions: { ...service.permissions, enabled } })
    try {
      onUpdate(await setEnabled(service.id, enabled))
    } catch (err) {
      onUpdate(service)
      toast.error(err instanceof Error ? err.message : 'Toggle failed')
    }
  }

  async function handleSave() {
    const patch: Record<string, unknown> = {}
    const networkPatch: Record<string, unknown> = {}
    const lifecyclePatch: Record<string, unknown> = {}

    if (capabilityId !== service.capabilityId) patch.capabilityId = capabilityId
    if (hostId !== service.hostId) patch.hostId = hostId

    // An emptied field clears the value, and `null` is how that crosses the
    // wire: JSON.stringify drops an `undefined` member, so the server would
    // receive no key at all and leave the old value in place.
    const notesVal = notes !== '' ? notes : null
    if (notesVal !== (service.notes ?? null)) patch.notes = notesVal

    if (healthPath !== service.network.healthPath) networkPatch.healthPath = healthPath
    if (tailscaleServe !== (service.network.tailscaleServe ?? false)) networkPatch.tailscaleServe = tailscaleServe

    // Port is not clearable: validateRegistry requires it, and a service saved
    // without one makes the whole registry fail to load on the next restart.
    if (port === '') { toast.error('Port is required'); return }
    const portNum = parseInt(port, 10)
    if (isNaN(portNum)) { toast.error('Port must be a number'); return }
    if (portNum !== service.network.port) networkPatch.port = portNum

    const listenAddressVal = listenAddress !== '' ? listenAddress : null
    if (listenAddressVal !== (service.network.listenAddress ?? null)) networkPatch.listenAddress = listenAddressVal

    if (loadStrategy !== (service.lifecycle?.loadStrategy ?? 'startup')) lifecyclePatch.loadStrategy = loadStrategy
    if (autoStart !== (service.lifecycle?.autoStart ?? false)) lifecyclePatch.autoStart = autoStart
    if (idleUnload !== (service.lifecycle?.idleUnload ?? false)) lifecyclePatch.idleUnload = idleUnload

    const idleTimeoutMs = idleTimeout !== '' ? parseFloat(idleTimeout) * 60000 : null
    if (idleTimeoutMs !== (service.lifecycle?.idleTimeout ?? null)) {
      if (idleTimeoutMs !== null && isNaN(idleTimeoutMs)) { toast.error('Idle timeout must be a number'); return }
      lifecyclePatch.idleTimeout = idleTimeoutMs
    }

    const startupTimeMs = startupTime !== '' ? parseFloat(startupTime) * 1000 : null
    if (startupTimeMs !== (service.lifecycle?.startupTime ?? null)) {
      if (startupTimeMs !== null && isNaN(startupTimeMs)) { toast.error('Startup time must be a number'); return }
      lifecyclePatch.startupTime = startupTimeMs
    }

    if (restartOnCrash !== (service.lifecycle?.restartOnCrash ?? false)) lifecyclePatch.restartOnCrash = restartOnCrash

    const maxRestartsNum = maxRestarts !== '' ? parseInt(maxRestarts, 10) : null
    if (maxRestartsNum !== (service.lifecycle?.maxRestarts ?? null)) {
      if (maxRestartsNum !== null && isNaN(maxRestartsNum)) { toast.error('Max restarts must be a number'); return }
      lifecyclePatch.maxRestarts = maxRestartsNum
    }

    const restartBackoffMs = restartBackoff !== '' ? parseFloat(restartBackoff) * 1000 : null
    if (restartBackoffMs !== (service.lifecycle?.restartBackoff ?? null)) {
      if (restartBackoffMs !== null && isNaN(restartBackoffMs)) { toast.error('Restart backoff must be a number'); return }
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
    setNotes(service.notes ?? '')
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

  return (
    <div className="flex flex-col min-h-0 -mt-3">

      {/* ── Status header: state and the enable switch, above the tabs ──
          The switch applies immediately while the fields below wait for Save,
          so it stays out of the form and visible whichever tab is open. */}
      <Tabs value={tab} onValueChange={setTab} className="flex flex-col min-h-0">
        {/* Tabs, state and the enable switch share one row. The switch applies
            immediately while the fields below wait for Save, so it sits outside
            the form and stays visible whichever tab is open. */}
        <div className="flex items-center gap-3">
          <TabsList>
            <TabsTrigger value="network">Network</TabsTrigger>
            <TabsTrigger value="lifecycle">Lifecycle</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          {/* Health only says something while the service is enabled; when it is
              off, the switch already carries that state. */}
          {service.permissions.enabled && (
            <Badge className={healthBadgeClass[service.health]}>{healthLabel[service.health]}</Badge>
          )}
          {service.permissions.enabled && service.lastEvent && (
            <span className="text-xs text-muted-foreground">{relativeTime(service.lastEvent.timestamp)}</span>
          )}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {service.permissions.protected ? (
              <Badge variant="outline">protected</Badge>
            ) : (
              <>
                <Label htmlFor="service-enabled" className="cursor-pointer text-muted-foreground">
                  {service.permissions.enabled ? 'Enabled' : 'Disabled'}
                </Label>
                <Switch
                  id="service-enabled"
                  checked={service.permissions.enabled}
                  onCheckedChange={handleToggleEnabled}
                  aria-label="Enable service"
                />
              </>
            )}
          </div>
        </div>

        <TabsContent value="network" className="space-y-4 overflow-y-auto overscroll-contain pt-4">

      {/* ── About ── */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium">About</h3>
        <div className="space-y-2">
          <Label className="text-muted-foreground">
            Capability
            <InfoTip>What this service provides. Services implementing the same capability are interchangeable to the rest of the platform.</InfoTip>
          </Label>
          <Select value={capabilityId} onValueChange={(v) => { setCapabilityId(v); markDirty() }}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {capabilities.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-muted-foreground">
            Notes
            <InfoTip>What this service is, how to drive it (UI/API/CLI), and where it came from. Shows up here so it's discoverable without re-deriving it from source each time.</InfoTip>
          </Label>
          <Textarea
            value={notes}
            onChange={(e) => { setNotes(e.target.value); markDirty() }}
            placeholder="What is this, how do you use it, where did it come from?"
            rows={3}
            className="max-h-40 overflow-y-auto"
          />
        </div>
      </section>

      <Separator />

      {/* ── Network ── */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Network</h3>
        {/* Host + Port + Tailscale Serve */}
        <div className="flex items-center gap-6">
          <div className="space-y-2">
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
          <div className="space-y-2 w-20">
            <Label className="text-muted-foreground">Port</Label>
            <Input
              value={port}
              onChange={(e) => { setPort(e.target.value); markDirty() }}
              placeholder="8080"
            />
          </div>
          <div className="flex items-center gap-2 self-end pb-2">
            <Switch
              id="tailscale-serve"
              checked={tailscaleServe}
              onCheckedChange={(v) => { setTailscaleServe(v); markDirty() }}
            />
            <Label htmlFor="tailscale-serve" className="cursor-pointer">Tailscale Serve</Label>
            <InfoTip>When enabled, the shard registers this service with Tailscale Serve on load, making it reachable across the mesh network without a separate proxy.</InfoTip>
          </div>
        </div>

        {/* Health path + Listen address */}
        <div className="grid grid-cols-2 gap-4">
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

        {/* URL (read-only, derived from host + port) */}
        <div className="space-y-2">
          <Label className="text-muted-foreground">URL</Label>
          <p className="text-sm font-mono text-muted-foreground truncate">{service.network.endpoint}</p>
        </div>
      </section>

        </TabsContent>

        <TabsContent value="lifecycle" className="space-y-5 overflow-y-auto overscroll-contain pt-4">

        {/* Loading */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Loading</h3>
          <div className="flex items-center gap-6">
            <div className="space-y-2">
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
            <div className="flex items-center gap-2 self-end pb-2">
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
          <h3 className="text-sm font-medium">Idle eviction</h3>
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
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">min</span>
            </div>
          </div>
        </div>

        {/* Startup & Restart */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Startup &amp; restart</h3>
          <div className="flex items-center gap-2">
            <Label htmlFor="startup-time" className="text-muted-foreground">
              Startup grace period
              <InfoTip>How long (in seconds) to wait before starting health checks after the service starts. Default: 30s.</InfoTip>
            </Label>
            <Input
              id="startup-time"
              value={startupTime}
              onChange={(e) => { setStartupTime(e.target.value); markDirty() }}
              placeholder="30"
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">sec</span>
          </div>
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
          <div className="flex items-center gap-2">
            <Label htmlFor="max-restarts" className="text-muted-foreground">
              Max restarts
              <InfoTip>Maximum number of restart attempts before giving up. Default: 3.</InfoTip>
            </Label>
            <Input
              id="max-restarts"
              value={maxRestarts}
              onChange={(e) => { setMaxRestarts(e.target.value); markDirty() }}
              placeholder="3"
              disabled={!restartOnCrash}
              className="w-20"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="restart-backoff" className="text-muted-foreground">
              Restart backoff
              <InfoTip>Initial delay before each restart attempt in seconds. Default: 5s.</InfoTip>
            </Label>
            <Input
              id="restart-backoff"
              value={restartBackoff}
              onChange={(e) => { setRestartBackoff(e.target.value); markDirty() }}
              placeholder="5"
              disabled={!restartOnCrash}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">sec</span>
          </div>
        </div>
        </TabsContent>

        <TabsContent value="history" className="overflow-y-auto overscroll-contain pt-4">
          <ServiceHistoryList serviceId={service.id} />
        </TabsContent>
      </Tabs>

      {/* ── Save / Cancel ──
          One dirty flag covers every tab, so the bar sits outside the tab
          content: edits on a tab you have navigated away from still save. */}
      {dirty && (
        <>
          <Separator className="mt-4" />
          <div className="flex justify-end gap-2 pt-4">
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
