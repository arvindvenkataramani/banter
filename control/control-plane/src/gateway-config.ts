import { Hono } from 'hono'
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { CHUNK_STRATEGIES } from '../../../shared/types'
import type { Service, ServiceWithHealth } from '../../../shared/types'

export interface ModelChunkingPref {
  chunking?: { mode?: string; minWords?: number; maxWords?: number }
}

export interface PlatformConfig {
  version: number
  /**
   * Process-level settings: where this deployment listens, logs, and how often
   * its periodic loops run. Each has an environment override, but a normal run
   * needs none. The listening port is deliberately absent — it comes from the
   * registry's own `control` service entry, so it is declared in one place
   * rather than two that could disagree. See runtime-settings.ts.
   */
  runtime?: {
    host?: string
    eventsPath?: string
    healthIntervalMs?: number
    shardPollIntervalMs?: number
  }
  integrations?: {
    openclaw?: {
      gateway?: {
        url?: string
        token?: string
      }
      defaultAgent?: string
      defaultSession?: string
      // Last session name the dashboard was viewing, per agent — distinct
      // from defaultSession (that agent's structural home/default
      // conversation, e.g. 'main'). Restores the actual last-viewed
      // conversation on reload instead of always resetting to the default.
      lastSessionByAgent?: Record<string, string>
    }
  }
  voice?: {
    enabled?: boolean
    tts?: {
      providers?: Array<{
        serviceId: string
        name?: string
        models: Array<{
          id: string
          voices: Array<{ id: string; name: string }>
        }>
      }>
      selection?: { serviceId: string; model: string; voice: string; speed?: number }
      options?: { chunkStrategy?: string | null; minChunkWords?: number | null; maxChunkWords?: number | null }
      modelPrefs?: Record<string, Record<string, ModelChunkingPref>>
      settingsScope?: 'global' | 'per-model'
    }
    stt?: {
      serviceId?: string
      options?: Array<{ serviceId: string; name: string }>
      [key: string]: unknown
    }
    debug?: {
      saveMicSamples?: boolean
    }
  }
}

export type VoiceSelectionPatch = {
  serviceId?: string
  model?: string
  voice?: string
  speed?: number
  chunkStrategy?: string | null
  minChunkWords?: number | null
  maxChunkWords?: number | null
  modelPrefs?: Record<string, Record<string, ModelChunkingPref | null>>
  settingsScope?: 'global' | 'per-model'
  sttServiceId?: string
  saveMicSamples?: boolean
}

/** Source of service metadata for voice-config enrichment. Returns services from all known nodes. */
export type ServiceLookup = () => Array<Service | ServiceWithHealth>


/**
 * Resolve a config value that may be an environment placeholder.
 *
 * Secrets are written in config.json as `${VAR}` and kept that way in the
 * loaded object, because the dashboard's settings writes serialize that object
 * back over config.json — resolving at load time would bake the secret into a
 * tracked, deployed file on the next settings change. Callers resolve at the
 * point of use instead.
 *
 * An unset variable yields undefined so callers hit their existing "missing
 * token" path rather than sending a literal `${VAR}` as a credential.
 */
export function resolveConfigValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(value)
  if (!match) return value
  return process.env[match[1]] ?? undefined
}

export async function loadConfig(configPath: string): Promise<PlatformConfig> {
  const raw = await readFile(configPath, 'utf-8')
  const config = JSON.parse(raw) as PlatformConfig
  mergeDuplicateProviders(config)
  return config
}

/**
 * Re-read config from disk and replace the contents of the live config
 * object in place. Existing route handlers close over `config` by reference
 * and read fields at request time, so mutating in place propagates new
 * values without re-registering routes.
 */
export async function reloadConfig(configPath: string, target: PlatformConfig): Promise<void> {
  const fresh = await loadConfig(configPath)
  // Drop removed keys, then copy fresh keys over.
  for (const key of Object.keys(target)) {
    delete (target as Record<string, unknown>)[key]
  }
  Object.assign(target, fresh)
}

/**
 * Coalesce TTS providers that share a serviceId. Multiple entries pointing
 * at the same backend service usually mean the author wanted to group models
 * by display name; the UI sees them as duplicate dropdown items keyed by
 * the same value, which is confusing. Merge in place: keep the first entry's
 * name, concatenate models[] from subsequent duplicates. Logs a warning so
 * the source config gets cleaned up.
 */
function mergeDuplicateProviders(config: PlatformConfig): void {
  const providers = config.voice?.tts?.providers
  if (!providers || providers.length < 2) return
  const merged: typeof providers = []
  const bySid = new Map<string, typeof providers[number]>()
  for (const p of providers) {
    const existing = bySid.get(p.serviceId)
    if (existing) {
      console.warn(
        `[config] merging duplicate TTS provider serviceId="${p.serviceId}" ` +
        `(name="${p.name ?? ''}") into first entry (name="${existing.name ?? ''}"). ` +
        `Combine these in config.json — every provider entry must have a unique serviceId.`
      )
      existing.models.push(...p.models)
    } else {
      bySid.set(p.serviceId, p)
      merged.push(p)
    }
  }
  config.voice!.tts!.providers = merged
}

export async function updateVoiceSelection(
  configPath: string,
  config: PlatformConfig,
  patch: VoiceSelectionPatch,
  getServices?: ServiceLookup
): Promise<PlatformConfig['voice']> {
  if (!config.voice) {
    throw new Error('Voice not configured')
  }

  const providers = config.voice.tts?.providers ?? []

  // Validate serviceId/model/voice if provided
  if (patch.serviceId !== undefined || patch.model !== undefined || patch.voice !== undefined) {
    const serviceId = patch.serviceId ?? config.voice.tts?.selection?.serviceId
    const model = patch.model ?? config.voice.tts?.selection?.model
    const voice = patch.voice ?? config.voice.tts?.selection?.voice

    if (serviceId !== undefined) {
      const provider = providers.find(p => p.serviceId === serviceId)
      if (!provider) {
        throw new ValidationError(`unknown serviceId "${serviceId}"`)
      }
      if (model !== undefined) {
        const modelEntry = provider.models.find(m => m.id === model)
        if (!modelEntry) {
          throw new ValidationError(`unknown model "${model}" for serviceId "${serviceId}"`)
        }
        if (voice !== undefined) {
          const voiceEntry = modelEntry.voices.find(v => v.id === voice)
          if (!voiceEntry) {
            throw new ValidationError(`unknown voice "${voice}" for model "${model}"`)
          }
        }
      }
    }
  }

  // Validate speed
  if (patch.speed !== undefined) {
    if (typeof patch.speed !== 'number' || patch.speed < 0.5 || patch.speed > 2.0) {
      throw new ValidationError('speed must be a number between 0.5 and 2.0')
    }
  }

  // Validate chunkStrategy
  if (patch.chunkStrategy !== undefined && patch.chunkStrategy !== null) {
    if (!(CHUNK_STRATEGIES as readonly string[]).includes(patch.chunkStrategy)) {
      throw new ValidationError(`chunkStrategy must be one of: ${CHUNK_STRATEGIES.join(', ')}`)
    }
  }

  // Validate minChunkWords
  if (patch.minChunkWords !== undefined && patch.minChunkWords !== null) {
    if (!Number.isInteger(patch.minChunkWords) || patch.minChunkWords <= 0) {
      throw new ValidationError('minChunkWords must be a positive integer')
    }
  }

  // Validate maxChunkWords
  if (patch.maxChunkWords !== undefined && patch.maxChunkWords !== null) {
    if (!Number.isInteger(patch.maxChunkWords) || patch.maxChunkWords <= 0) {
      throw new ValidationError('maxChunkWords must be a positive integer or null')
    }
  }

  // Validate modelPrefs: per-model override sets, keyed serviceId -> modelId
  // (not a composite key: model ids contain '/'). An entry holds only the
  // fields the user changed, so partial sets are normal. Whether the overrides
  // apply is the app-wide settingsScope, not anything stored here — the server
  // never normalizes, and a null entry means delete.
  if (patch.modelPrefs !== undefined) {
    for (const [svcId, models] of Object.entries(patch.modelPrefs)) {
      const provider = providers.find(p => p.serviceId === svcId)
      if (!provider) {
        throw new ValidationError(`unknown serviceId "${svcId}" in modelPrefs`)
      }
      for (const [modelId, entry] of Object.entries(models)) {
        const modelEntry = provider.models.find(m => m.id === modelId)
        if (!modelEntry) {
          throw new ValidationError(`unknown model "${modelId}" for serviceId "${svcId}" in modelPrefs`)
        }
        if (entry === null) continue
        if (entry.chunking) {
          const { mode, minWords, maxWords } = entry.chunking
          if (mode !== undefined && !(CHUNK_STRATEGIES as readonly string[]).includes(mode)) {
            throw new ValidationError(`modelPrefs chunking.mode must be one of: ${CHUNK_STRATEGIES.join(', ')}`)
          }
          if (minWords !== undefined && (!Number.isInteger(minWords) || minWords <= 0)) {
            throw new ValidationError('modelPrefs chunking.minWords must be a positive integer')
          }
          if (maxWords !== undefined && (!Number.isInteger(maxWords) || maxWords <= 0)) {
            throw new ValidationError('modelPrefs chunking.maxWords must be a positive integer')
          }
        }
      }
    }
  }

  // Validate settingsScope: whether per-model overrides are consulted at all.
  if (patch.settingsScope !== undefined) {
    if (patch.settingsScope !== 'global' && patch.settingsScope !== 'per-model') {
      throw new ValidationError("settingsScope must be 'global' or 'per-model'")
    }
  }

  // Validate sttServiceId: must reference a registered service with capabilityId === 'stt'
  if (patch.sttServiceId !== undefined) {
    if (typeof patch.sttServiceId !== 'string' || !patch.sttServiceId) {
      throw new ValidationError('sttServiceId must be a non-empty string')
    }
    const services = getServices ? getServices() : []
    const match = services.find(s => s.id === patch.sttServiceId)
    if (!match) {
      throw new ValidationError(`unknown sttServiceId "${patch.sttServiceId}"`)
    }
    if (match.capabilityId !== 'stt') {
      throw new ValidationError(`service "${patch.sttServiceId}" is not an STT service`)
    }
  }

  // Apply patch
  const currentSelection = config.voice.tts?.selection ?? { serviceId: '', model: '', voice: '' }
  const currentOptions = config.voice.tts?.options ?? {}

  const newSelection = {
    ...currentSelection,
    ...(patch.serviceId !== undefined && { serviceId: patch.serviceId }),
    ...(patch.model !== undefined && { model: patch.model }),
    ...(patch.voice !== undefined && { voice: patch.voice }),
    ...(patch.speed !== undefined && { speed: patch.speed }),
  }

  const newOptions = {
    ...currentOptions,
    ...(patch.chunkStrategy !== undefined && { chunkStrategy: patch.chunkStrategy }),
    ...(patch.minChunkWords !== undefined && { minChunkWords: patch.minChunkWords }),
    ...('maxChunkWords' in patch && { maxChunkWords: patch.maxChunkWords }),
  }

  // Mutate config in memory
  if (!config.voice.tts) {
    config.voice.tts = {}
  }
  config.voice.tts.selection = newSelection
  config.voice.tts.options = newOptions

  if (patch.settingsScope !== undefined) {
    config.voice.tts.settingsScope = patch.settingsScope
  }

  if (patch.modelPrefs) {
    const current = { ...(config.voice.tts.modelPrefs ?? {}) }
    for (const [svcId, models] of Object.entries(patch.modelPrefs)) {
      const bucket = { ...(current[svcId] ?? {}) }
      for (const [modelId, entry] of Object.entries(models)) {
        if (entry === null) delete bucket[modelId]
        else bucket[modelId] = entry            // full replace, never a merge
      }
      if (Object.keys(bucket).length === 0) delete current[svcId]
      else current[svcId] = bucket
    }
    config.voice.tts.modelPrefs = current       // assigned even when {} — the client relies on it
  }

  if (patch.sttServiceId !== undefined) {
    if (!config.voice.stt) config.voice.stt = {}
    config.voice.stt.serviceId = patch.sttServiceId
  }

  if (patch.saveMicSamples !== undefined) {
    if (typeof patch.saveMicSamples !== 'boolean') {
      throw new ValidationError('saveMicSamples must be a boolean')
    }
    if (!config.voice.debug) config.voice.debug = {}
    config.voice.debug.saveMicSamples = patch.saveMicSamples
  }

  // Atomic write
  const tmpPath = join(dirname(configPath), `.config.tmp.${Date.now()}`)
  await writeFile(tmpPath, JSON.stringify(config, null, 2))
  await rename(tmpPath, configPath)

  return config.voice
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export async function updateDefaultAgent(
  configPath: string,
  config: PlatformConfig,
  agentId: string
): Promise<string> {
  if (typeof agentId !== 'string' || !agentId.trim()) {
    throw new ValidationError('agentId must be a non-empty string')
  }

  if (!config.integrations) config.integrations = {}
  if (!config.integrations.openclaw) config.integrations.openclaw = {}
  config.integrations.openclaw.defaultAgent = agentId

  const tmpPath = join(dirname(configPath), `.config.tmp.${Date.now()}`)
  await writeFile(tmpPath, JSON.stringify(config, null, 2))
  await rename(tmpPath, configPath)

  return agentId
}

export async function updateLastSession(
  configPath: string,
  config: PlatformConfig,
  agentId: string,
  sessionName: string
): Promise<Record<string, string>> {
  if (typeof agentId !== 'string' || !agentId.trim()) {
    throw new ValidationError('agentId must be a non-empty string')
  }
  if (typeof sessionName !== 'string' || !sessionName.trim()) {
    throw new ValidationError('sessionName must be a non-empty string')
  }

  if (!config.integrations) config.integrations = {}
  if (!config.integrations.openclaw) config.integrations.openclaw = {}
  if (!config.integrations.openclaw.lastSessionByAgent) config.integrations.openclaw.lastSessionByAgent = {}
  config.integrations.openclaw.lastSessionByAgent[agentId] = sessionName

  const tmpPath = join(dirname(configPath), `.config.tmp.${Date.now()}`)
  await writeFile(tmpPath, JSON.stringify(config, null, 2))
  await rename(tmpPath, configPath)

  return config.integrations.openclaw.lastSessionByAgent
}

export function registerGatewayConfig(app: Hono<any>, config: PlatformConfig, configPath?: string) {
  app.get('/api/gateway', (c) => {
    const gw = config.integrations?.openclaw?.gateway
    const token = resolveConfigValue(gw?.token)
    if (!gw?.url || !token) {
      return c.json({ error: 'Gateway not configured' }, 503)
    }
    const defaultAgent = config.integrations?.openclaw?.defaultAgent
    const defaultSession = config.integrations?.openclaw?.defaultSession
    const lastSessionByAgent = config.integrations?.openclaw?.lastSessionByAgent
    return c.json({
      url: gw.url,
      token,
      ...(defaultAgent && { defaultAgent }),
      ...(defaultSession && { defaultSession }),
      ...(lastSessionByAgent && { lastSessionByAgent }),
    })
  })

  app.patch('/api/gateway/defaultAgent', async (c) => {
    if (!configPath) {
      return c.json({ error: 'Config path not set' }, 500)
    }
    let body: { agentId?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    if (body.agentId === undefined) {
      return c.json({ error: 'agentId required' }, 400)
    }
    try {
      const agentId = await updateDefaultAgent(configPath, config, body.agentId)
      return c.json({ defaultAgent: agentId })
    } catch (err) {
      if (err instanceof ValidationError) {
        return c.json({ error: err.message }, 400)
      }
      throw err
    }
  })

  app.patch('/api/gateway/lastSession', async (c) => {
    if (!configPath) {
      return c.json({ error: 'Config path not set' }, 500)
    }
    let body: { agentId?: string; sessionName?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    if (body.agentId === undefined || body.sessionName === undefined) {
      return c.json({ error: 'agentId and sessionName required' }, 400)
    }
    try {
      const lastSessionByAgent = await updateLastSession(configPath, config, body.agentId, body.sessionName)
      return c.json({ lastSessionByAgent })
    } catch (err) {
      if (err instanceof ValidationError) {
        return c.json({ error: err.message }, 400)
      }
      throw err
    }
  })
}

export function registerVoiceConfig(
  app: Hono<any>,
  config: PlatformConfig,
  configPath?: string,
  getServices?: ServiceLookup,
) {
  app.get('/api/voice', (c) => {
    if (!config.voice) {
      return c.json({ error: 'Voice not configured' }, 503)
    }
    const services = getServices ? getServices() : []
    const nameFor = (id: string): string | undefined => {
      const svc = services.find(s => s.id === id)
      return svc?.name ?? undefined
    }

    const enrichedProviders = (config.voice.tts?.providers ?? []).map(p => ({
      ...p,
      name: nameFor(p.serviceId) ?? p.serviceId,
    }))

    const sttOptions = services
      .filter(s => s.capabilityId === 'stt')
      .map(s => ({ serviceId: s.id, name: s.name ?? s.id }))

    const enriched: NonNullable<PlatformConfig['voice']> = {
      ...config.voice,
      tts: config.voice.tts
        ? { ...config.voice.tts, providers: enrichedProviders }
        : config.voice.tts,
      stt: {
        ...(config.voice.stt ?? {}),
        options: sttOptions,
      },
    }
    return c.json(enriched)
  })

  app.patch('/api/voice/selection', async (c) => {
    if (!config.voice) {
      return c.json({ error: 'Voice not configured' }, 503)
    }
    if (!configPath) {
      return c.json({ error: 'Config path not set' }, 500)
    }

    let patch: VoiceSelectionPatch
    try {
      patch = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    try {
      const updatedVoice = await updateVoiceSelection(configPath, config, patch, getServices)
      return c.json(updatedVoice)
    } catch (err) {
      if (err instanceof ValidationError) {
        return c.json({ error: err.message }, 400)
      }
      throw err
    }
  })
}

// Debug captures live under this platform's own data dir, not the OpenClaw
// workspace — nothing here should need to know where OpenClaw is installed.
// The gateway URL in config.json is the only coupling to it.
const MIC_SAMPLE_DIR = process.env.MIC_SAMPLE_DIR
  ?? join(homedir(), 'services/banter/debug/mic-samples')
const MIC_SAMPLE_RETENTION = 50

export function registerVoiceDebug(app: Hono<any>, config: PlatformConfig) {
  if (!process.env.DEBUG) return
  app.post('/api/debug/mic-sample', async (c) => {
    if (!config.voice?.debug?.saveMicSamples) {
      return c.json({ error: 'mic sample saving is disabled' }, 403)
    }

    const buf = await c.req.arrayBuffer()
    if (buf.byteLength === 0) {
      return c.json({ error: 'empty body' }, 400)
    }

    await mkdir(MIC_SAMPLE_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `${stamp}.wav`
    await writeFile(join(MIC_SAMPLE_DIR, filename), new Uint8Array(buf))

    // Prune to most recent N (filenames are ISO timestamps, so lexical sort = chronological)
    try {
      const entries = (await readdir(MIC_SAMPLE_DIR))
        .filter(f => f.endsWith('.wav'))
        .sort()
      const excess = entries.length - MIC_SAMPLE_RETENTION
      if (excess > 0) {
        await Promise.all(
          entries.slice(0, excess).map(f => unlink(join(MIC_SAMPLE_DIR, f)).catch(() => {}))
        )
      }
    } catch {
      // pruning failure shouldn't fail the request
    }

    return c.json({ filename, dir: MIC_SAMPLE_DIR })
  })
}

export function registerConfigReload(app: Hono<any>, config: PlatformConfig, configPath?: string) {
  app.post('/api/config/reload', async (c) => {
    if (!configPath) {
      return c.json({ error: 'Config path not set' }, 500)
    }
    try {
      await reloadConfig(configPath, config)
      return c.json({ ok: true, version: config.version })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: `failed to reload config: ${message}` }, 500)
    }
  })
}
