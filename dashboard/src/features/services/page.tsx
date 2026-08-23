import { useEffect, useState, useCallback } from 'react'
import { getServices, getCapabilities, getHosts, getShards, pollShard, type ServiceWithHealth, type HealthState, type Capability, type Host, type ShardStatus } from '@/lib/api'
import { ServiceCard } from '@/features/services/service-card'
import { Button } from '@/components/ui/button'
import { RefreshCw } from 'lucide-react'

interface Props {
  filter: string
  navigate: (tab: string, filter?: string) => void
}

export function ServicesPage({ filter, navigate }: Props) {
  const [services, setServices] = useState<ServiceWithHealth[]>([])
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [hosts, setHosts] = useState<Host[]>([])
  const [shards, setShards] = useState<ShardStatus[]>([])
  const [pollingHostId, setPollingHostId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await getServices()
      setServices(data)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void getCapabilities().then(setCapabilities).catch(() => { })
  }, [])

  useEffect(() => {
    void getHosts().then(setHosts).catch(() => { })
  }, [])

  useEffect(() => {
    void getShards().then(async (data) => {
      setShards(data)
      // Trigger a fresh connection check for every shard on page mount
      await Promise.all(data.map(s => pollShard(s.hostId).then(updated =>
        setShards(prev => prev.map(x => x.hostId === updated.hostId ? updated : x))
      ).catch(() => {})))
      // Reload services now that shards have been re-polled
      void load()
    }).catch(() => { })
  }, [load])

  async function handlePollShard(hostId: string) {
    setPollingHostId(hostId)
    try {
      const updated = await pollShard(hostId)
      setShards((prev) => prev.map((s) => s.hostId === updated.hostId ? updated : s))
      if (updated.online) {
        await load()
      }
    } catch { /* ignore */ }
    finally {
      setPollingHostId(null)
    }
  }

  const filtered = filter
    ? services.filter((s) => s.health === (filter as HealthState))
    : services

  // Group services by hostId
  const byHost = filtered.reduce<Record<string, ServiceWithHealth[]>>((acc, svc) => {
    ; (acc[svc.hostId] ??= []).push(svc)
    return acc
  }, {})
  for (const svcs of Object.values(byHost)) {
    svcs.sort((a, b) => {
      const ap = a.permissions.protected ? 1 : 0
      const bp = b.permissions.protected ? 1 : 0
      if (ap !== bp) return bp - ap
      const ae = a.permissions.enabled ? 1 : 0
      const be = b.permissions.enabled ? 1 : 0
      if (ae !== be) return be - ae
      return (a.capabilityId ?? '').localeCompare(b.capabilityId ?? '')
    })
  }

  // All known host IDs: from loaded services + registered hosts
  const allHostIds = Array.from(new Set([
    ...hosts.map(h => h.id),
    ...Object.keys(byHost),
  ]))

  // Set of host IDs that are shards
  const shardHostIds = new Set(shards.map(s => s.hostId))

  function onServiceUpdate(updated: ServiceWithHealth) {
    setServices((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
  }

  return (
    <div className="space-y-12">
      {filter && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            Showing: <span className="font-medium text-foreground">{filter}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={() => navigate('/services', '')}>
            Clear filter
          </Button>
        </div>
      )}

      {allHostIds.map((hostId) => {
        const hostServices = byHost[hostId] ?? []
        const shard = shards.find(s => s.hostId === hostId)
        const isOfflineShard = shardHostIds.has(hostId) && shard && !shard.online

        return (
          <div key={hostId}>
            <div className="flex items-center gap-3 mb-2">
              <p className="text-xl font-medium text-muted-foreground">host: {hostId}</p>
              {isOfflineShard && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  disabled={pollingHostId === hostId}
                  onClick={() => handlePollShard(hostId)}
                >
                  <RefreshCw className={`h-3 w-3 mr-1 ${pollingHostId === hostId ? 'animate-spin' : ''}`} />
                  {pollingHostId === hostId ? 'Checking' : 'Recheck'}
                </Button>
              )}
            </div>
            {hostServices.length > 0 ? (
              <div className="flex flex-wrap gap-8">
                {hostServices.map((svc) => {
                  const cap = capabilities.find((c) => c.id === svc.capabilityId)
                  return (
                    <ServiceCard key={svc.id} service={svc} capabilityName={cap?.name} onUpdate={onServiceUpdate} />
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {isOfflineShard ? 'Shard offline — no services loaded.' : 'No services.'}
              </p>
            )}
          </div>
        )
      })}

      {allHostIds.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {filter ? 'No services match this filter.' : 'No services registered.'}
        </p>
      )}
    </div>
  )
}
