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
  takeover?: 'ask' | 'always'
  vad?: Partial<Record<'minSpeechDurationS' | 'minSpeechProb', number>>
  turnTaking?: Partial<Record<'pauseThresholdMs' | 'commitMinDelayMs' | 'commitMaxDelayMs' | 'smartTurnThreshold' | 'smartTurnLowCutoff', number>>
}

/** What `PATCH /api/voice/selection` returns — `config.voice` verbatim, so
 * every part is optional and it lacks the enrichment `GET /api/voice` adds
 * (provider service names, the STT options list). Callers must merge this
 * onto their existing config rather than replace it wholesale. */
export type VoiceUpdateResult = {
  enabled?: boolean
  takeover?: VoiceConfig['takeover']
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
