import type { HealthState } from '@/lib/api'

export const healthBadgeClass: Record<HealthState, string> = {
  healthy:   'bg-status-healthy-bg text-status-healthy-fg border-transparent',
  degraded:  'bg-status-warn-bg text-status-warn-fg border-transparent',
  down:      'bg-status-down-bg text-status-down-fg border-transparent',
  timed_out: 'bg-status-warn-bg text-status-warn-fg border-transparent',
  disabled:  'bg-status-muted-bg text-status-muted-fg border-transparent',
  unknown:   'bg-status-muted-bg text-status-muted-fg border-transparent',
}

export const healthLabel: Record<HealthState, string> = {
  healthy:   'online',
  degraded:  'degraded',
  down:      'offline',
  timed_out: 'timed out',
  disabled:  'disabled',
  unknown:   'unknown',
}
