import type {
  ServiceWithHealth,
  ServiceNetwork,
  ServiceLifecycle,
  Host,
  Capability,
  Event,
  HealthState,
} from '@platform/shared'
import type { VoiceConfig } from '@/lib/voice/voice-config'
import type { ModelPref, SettingsScope } from '@/lib/voice/model-settings'

export type { ServiceWithHealth, Host, Capability, Event, HealthState }

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

type ServicePatch = {
  capabilityId?: string;
  hostId?: string;
  network?: Partial<Pick<ServiceNetwork, "port" | "healthPath" | "listenAddress" | "tailscaleServe">>;
  lifecycle?: Partial<Pick<ServiceLifecycle, "loadStrategy" | "autoStart" | "idleUnload" | "idleTimeout" | "startupTime" | "restartOnCrash" | "maxRestarts" | "restartBackoff">>;
}

export function updateService(id: string, patch: ServicePatch): Promise<ServiceWithHealth> {
  return request<ServiceWithHealth>(`/api/services/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export function setEnabled(id: string, enabled: boolean): Promise<ServiceWithHealth> {
  return request<ServiceWithHealth>(`/api/services/${id}/enabled`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

export function startService(id: string): Promise<{ success: boolean; error?: string }> {
  return request<{ success: boolean; error?: string }>(`/api/services/${id}/start`, {
    method: 'POST',
  })
}

export function stopService(id: string): Promise<{ success: boolean; error?: string }> {
  return request<{ success: boolean; error?: string }>(`/api/services/${id}/stop`, {
    method: 'POST',
  })
}

export function restartService(id: string): Promise<{ success: boolean; error?: string }> {
  return request<{ success: boolean; error?: string }>(`/api/services/${id}/restart`, {
    method: 'POST',
  })
}

export type VoiceSelectionPatch = {
  serviceId?: string
  model?: string
  voice?: string
  speed?: number
  chunkStrategy?: string | null
  minChunkWords?: number | null
  maxChunkWords?: number | null
  modelPrefs?: Record<string, Record<string, ModelPref | null>>
  settingsScope?: SettingsScope
  sttServiceId?: string
  saveMicSamples?: boolean
}

/** What `PATCH /api/voice/selection` returns — `config.voice` verbatim, so
 * every part is optional and it lacks the enrichment `GET /api/voice` adds
 * (provider service names, the STT options list). Callers must merge this
 * onto their existing config rather than replace it wholesale. */
export type VoiceUpdateResult = {
  enabled?: boolean
  tts?: Partial<VoiceConfig['tts']>
  stt?: VoiceConfig['stt']
  debug?: VoiceConfig['debug']
}

export function updateVoiceSelection(patch: VoiceSelectionPatch): Promise<VoiceUpdateResult> {
  return request('/api/voice/selection', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}
