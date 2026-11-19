import type {
  ServiceWithHealth,
  ServiceNetwork,
  ServiceLifecycle,
  Host,
  Capability,
  Event,
  HealthState,
  ControlPlaneReloadResponse,
} from '@platform/shared'
import type { VoiceSelectionPatch, VoiceUpdateResult } from '@platform/voice-engine/voice-config'

export type { ServiceWithHealth, Host, Capability, Event, HealthState, ControlPlaneReloadResponse }
export type { VoiceSelectionPatch, VoiceUpdateResult }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    let message = res.statusText
    try {
      const body = await res.json() as { error?: string }
      if (body.error) message = body.error
    } catch { /* ignore */ }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export function getServices(): Promise<ServiceWithHealth[]> {
  return request<ServiceWithHealth[]>('/api/services')
}

export function getService(id: string): Promise<ServiceWithHealth> {
  return request<ServiceWithHealth>(`/api/services/${id}`)
}

export function getHosts(): Promise<Host[]> {
  return request<Host[]>('/api/hosts')
}

export interface ShardStatus {
  hostId: string
  endpoint: string
  online: boolean
  lastPoll: number
}

export function getShards(): Promise<ShardStatus[]> {
  return request<ShardStatus[]>('/api/shards')
}

export function pollShard(hostId: string): Promise<ShardStatus> {
  return request<ShardStatus>(`/api/shards/${hostId}/poll`, { method: 'POST' })
}

export function getCapabilities(): Promise<Capability[]> {
  return request<Capability[]>('/api/capabilities')
}

export function getEvents(opts?: { limit?: number; subjectId?: string }): Promise<Event[]> {
  const params = new URLSearchParams()
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts?.subjectId) params.set('subjectId', opts.subjectId)
  const qs = params.toString()
  return request<Event[]>(`/api/events${qs ? `?${qs}` : ''}`)
}

export function checkService(id: string): Promise<ServiceWithHealth> {
  return request<ServiceWithHealth>(`/api/services/${id}/check`, { method: 'POST' })
}

// `null` clears a field. Only the optional ones accept it — the server rejects
// a null on anything the registry requires.
type Clearable<T> = { [K in keyof T]: T[K] | null }

type ServicePatch = {
  capabilityId?: string;
  hostId?: string;
  notes?: string | null;
  network?: Partial<Clearable<Pick<ServiceNetwork, "port" | "healthPath" | "listenAddress" | "tailscaleServe">>>;
  lifecycle?: Partial<Clearable<Pick<ServiceLifecycle, "loadStrategy" | "autoStart" | "idleUnload" | "idleTimeout" | "startupTime" | "restartOnCrash" | "maxRestarts" | "restartBackoff">>>;
}

export function updateService(id: string, patch: ServicePatch): Promise<ServiceWithHealth> {
  return request<ServiceWithHealth>(`/api/services/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** Keep a demand-loaded service alive while it is in use. Idle eviction is
 * timed from the last ping, so a caller holding a service open re-pings well
 * inside its idleTimeout. */
export function pingService(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/services/${id}/ping`, { method: 'POST' })
}

export function setEnabled(id: string, enabled: boolean): Promise<ServiceWithHealth> {
  return request<ServiceWithHealth>(`/api/services/${id}/enabled`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

export function startService(id: string): Promise<{ success: boolean; error?: string; stage?: 'process' | 'serve' }> {
  return request<{ success: boolean; error?: string; stage?: 'process' | 'serve' }>(`/api/services/${id}/start`, {
    method: 'POST',
  })
}

export function stopService(id: string): Promise<{ success: boolean; error?: string }> {
  return request<{ success: boolean; error?: string }>(`/api/services/${id}/stop`, {
    method: 'POST',
  })
}

export function restartService(id: string): Promise<{ success: boolean; error?: string; stage?: 'process' | 'serve' }> {
  return request<{ success: boolean; error?: string; stage?: 'process' | 'serve' }>(`/api/services/${id}/restart`, {
    method: 'POST',
  })
}

export function updateVoiceSelection(patch: VoiceSelectionPatch): Promise<VoiceUpdateResult> {
  return request('/api/voice/selection', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** This `ok: false` means the request itself failed — distinct from a
 *  reached server reporting its own failed parts inside a normal
 *  `ControlPlaneReloadResponse`. */
export type ConfigReloadResult =
  | { ok: true; response: ControlPlaneReloadResponse }
  | { ok: false; error: string }

/** Reads the body regardless of status — unlike `request<T>`, which throws
 *  on non-2xx — since a 500 here still carries the full per-part result. */
export async function postConfigReload(): Promise<ConfigReloadResult> {
  let res: Response
  try {
    res = await fetch('/api/config/reload', { method: 'POST' })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network request failed' }
  }
  try {
    const response = await res.json() as ControlPlaneReloadResponse
    return { ok: true, response }
  } catch {
    return { ok: false, error: `${res.status} ${res.statusText}` }
  }
}
