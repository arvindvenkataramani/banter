import type { HealthState } from '@/lib/api'

export const healthBadgeClass: Record<HealthState, string> = {
  healthy:   'bg-status-healthy-bg text-status-healthy-fg border-transparent',
  degraded:  'bg-status-warn-bg text-status-warn-fg border-transparent',
  down:      'bg-status-down-bg text-status-down-fg border-transparent',
  timed_out: 'bg-status-warn-bg text-status-warn-fg border-transparent',
  disabled:  'bg-status-muted-bg text-status-muted-fg border-transparent',
  unknown:   'bg-status-muted-bg text-status-muted-fg border-transparent',
}

// Whether the process is up, which is a narrower question than whether the
// service is reachable: `degraded` means localhost answered and the Tailscale
// endpoint did not, so starting it again is a no-op. `timed_out` is the
// ambiguous case — a hung process and a dead one look alike — and counts as
// running because stop is the recoverable mistake and start is not.
export const serviceIsRunning: Record<HealthState, boolean> = {
  healthy:   true,
  degraded:  true,
  timed_out: true,
  down:      false,
  disabled:  false,
  unknown:   false,
}

export const healthLabel: Record<HealthState, string> = {
  healthy:   'online',
  degraded:  'degraded',
  down:      'offline',
  timed_out: 'timed out',
  disabled:  'disabled',
  unknown:   'unknown',
}
