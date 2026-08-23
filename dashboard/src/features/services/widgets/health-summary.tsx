import { useEffect, useState } from 'react'
import { getServices, type ServiceWithHealth, type HealthState } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { healthBadgeClass, healthLabel } from '@/lib/health-badge'

interface HealthSummaryProps {
  navigate: (path: string, filter?: string) => void
}

export function HealthSummary({ navigate }: HealthSummaryProps) {
  const [services, setServices] = useState<ServiceWithHealth[]>([])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const data = await getServices()
        if (!cancelled) setServices(data)
      } catch { /* ignore */ }
    }
    void load()
    const interval = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const counts = services.reduce<Partial<Record<HealthState, number>>>((acc, svc) => {
    acc[svc.health] = (acc[svc.health] ?? 0) + 1
    return acc
  }, {})

  const states = Object.entries(counts) as [HealthState, number][]

  return (
    <Card className="w-72">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Health Summary</CardTitle>
      </CardHeader>
      <CardContent>
        {states.length === 0 ? (
          <p className="text-xs text-muted-foreground">No services yet</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {states.map(([state, count]) => (
              <Badge
                key={state}
                className={`cursor-pointer ${healthBadgeClass[state]}`}
                onClick={() => navigate('/services', state)}
              >
                {count} {healthLabel[state]}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
