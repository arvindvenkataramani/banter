import { Hono } from 'hono'
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { withFileLock, writeFileAtomic, writeFileAtomicUnlocked } from '../../shared/src/atomic-write'
import { reloadRegistry } from '../../shared/src/registry'
import { syncDocument } from '../../shared/src/live-config/sync'
import { moveRuntimeState } from '../../shared/src/live-config/rules'
import { configSpec, stateSpec, type PlatformConfig as ConfigDocument, type RuntimeState } from '../../shared/src/live-config/schemas'
import { deriveHealthMap, deriveHealth } from '../../shared/src/events'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { CHUNK_STRATEGIES } from '../../../shared/types'
import type { Service, ServiceWithHealth, Registry, Shard, PartResult, ReloadWarning, ControlPlaneReloadResponse, ShardReloadResponse } from '../../../shared/types'
import type { AssembledRoster } from './roster-assembly'
import { voiceModeProviders, type VoiceModeProvider } from './voice-roster'

export interface ModelChunkingPref {
  chunking?: { mode?: string; minWords?: number; maxWords?: number }
}

/** The configuration document; its shape is the schema in shared/src/live-config/schemas.ts. */
export type PlatformConfig = ConfigDocument

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
  takeover?: 'ask' | 'always'
  /** Merged field by field into `voice.stt.vad`. */
  vad?: Partial<Record<VadTuningField, number>>
  /** Merged field by field into `voice.stt.turnTaking`. */
  turnTaking?: Partial<Record<TurnTakingTuningField, number>>
}

/** The listening fields the voice settings dialog tunes, and the bound each
 * value must fall within. A probability stays within [0, 1]; a duration only
 * has to be non-negative. */
const VAD_TUNING = {
  minSpeechDurationS: 'duration',
  minSpeechProb: 'probability',
} as const
const TURN_TAKING_TUNING = {
  pauseThresholdMs: 'duration',
  commitMinDelayMs: 'duration',
  commitMaxDelayMs: 'duration',
  smartTurnThreshold: 'probability',
  smartTurnLowCutoff: 'probability',
} as const
type VadTuningField = keyof typeof VAD_TUNING
type TurnTakingTuningField = keyof typeof TURN_TAKING_TUNING

function validateTuning(
  section: string,
  patch: Record<string, unknown>,
  bounds: Record<string, 'duration' | 'probability'>,
): void {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new ValidationError(`${section} must be an object`)
  }
  for (const [field, value] of Object.entries(patch)) {
    const bound = bounds[field]
    if (!bound) throw new ValidationError(`unknown field "${field}" in ${section}`)
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new ValidationError(`${section}.${field} must be a non-negative number`)
    }
    if (bound === 'probability' && value > 1) {
      throw new ValidationError(`${section}.${field} must be between 0 and 1`)
    }
  }
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

const serialize = (doc: unknown) => JSON.stringify(doc, null, 2) + '\n'

/** The runtime-state file sits beside the configuration, in `state/`. */
export function statePathFor(configPath: string): string {
  return join(dirname(configPath), 'state', 'state.json')
}

/** Reads the state file, synced with its schema; an absent file is an empty state. */
async function readStateFile(statePath: string): Promise<{ state: RuntimeState; write: boolean }> {
  let raw: unknown = {}
  let exists = true
  try {
    raw = JSON.parse(await readFile(statePath, 'utf-8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    exists = false
  }
  const result = syncDocument(raw, stateSpec)
  for (const w of result.warnings) console.warn(`state: ${w}`)
  return { state: result.doc, write: result.writable && (result.changed || !exists) }
}

async function writeStateFile(statePath: string, state: RuntimeState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  await writeFileAtomic(statePath, serialize(state))
}

/**
 * Loads the configuration: runtime state the file still holds moves to the
 * state file first, then the document is synced with its schema. Whichever
 * file changed is written back, the state file first; a configuration from
 * newer code is used as it stands and never written.
 */
export async function loadConfig(configPath: string): Promise<PlatformConfig> {
  const raw = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>
  const statePath = statePathFor(configPath)
  const { state, write: writeState } = await readStateFile(statePath)

  const fromNewerCode = typeof raw.version === 'number' && raw.version > configSpec.version
  const moved = fromNewerCode ? false : moveRuntimeState(raw, state as unknown as Record<string, unknown>)
  const result = syncDocument(raw, configSpec)
  for (const w of result.warnings) console.warn(`config: ${w}`)

  if (writeState || moved) await writeStateFile(statePath, syncDocument(state, stateSpec).doc)
  if ((result.changed || moved) && result.writable) {
    await writeFileAtomic(configPath, serialize(result.doc))
  }
  return result.doc
}

export async function readRuntimeState(configPath: string): Promise<RuntimeState> {
  return (await readStateFile(statePathFor(configPath))).state
}

/**
 * Applies `mutate` to the document as it stands on disk and writes it back, so
 * a hand edit or a field this code does not know survives the save. The result
 * is checked against the schema before anything is written, and the live
 * object is refreshed in place from what was written.
 */
async function saveConfigField(
  configPath: string,
  live: PlatformConfig,
  mutate: (doc: PlatformConfig) => void,
): Promise<void> {
  await withFileLock(configPath, async () => {
    const doc = JSON.parse(await readFile(configPath, 'utf-8')) as PlatformConfig
    mutate(doc)
    const synced = syncDocument(doc, configSpec).doc
    await writeFileAtomicUnlocked(configPath, serialize(doc))
    for (const key of Object.keys(live)) delete (live as Record<string, unknown>)[key]
    Object.assign(live, synced)
  })
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

export async function updateVoiceSelection(
  configPath: string,
  config: PlatformConfig,
  patch: VoiceSelectionPatch,
  getServices?: ServiceLookup,
  getProviders?: () => VoiceModeProvider[],
  /** A named service resolving to no provider is a 503 only while some
   *  shard here has never been polled; otherwise it's an ordinary 400. */
  neverPolledHosts?: () => string[],
): Promise<PlatformConfig['voice']> {
  if (!config.voice) {
    throw new Error('Voice not configured')
  }

  const providers = getProviders ? getProviders() : []

  // Validate serviceId/model/voice if provided
  if (patch.serviceId !== undefined || patch.model !== undefined || patch.voice !== undefined) {
    const serviceId = patch.serviceId ?? config.voice.tts?.selection?.serviceId
    const model = patch.model ?? config.voice.tts?.selection?.model
    const voice = patch.voice ?? config.voice.tts?.selection?.voice

    if (serviceId !== undefined) {
      const provider = providers.find(p => p.serviceId === serviceId)
      if (!provider) {
        if ((neverPolledHosts?.() ?? []).length > 0) {
          throw new RosterUnavailableError(`serviceId "${serviceId}" cannot be checked — a shard has never been polled`)
        }
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

  if (patch.vad !== undefined) validateTuning('vad', patch.vad, VAD_TUNING)
  if (patch.turnTaking !== undefined) {
    validateTuning('turnTaking', patch.turnTaking, TURN_TAKING_TUNING)
    const current = (config.voice.stt?.turnTaking ?? {}) as Record<string, unknown>
    const min = patch.turnTaking.commitMinDelayMs ?? current.commitMinDelayMs
    const max = patch.turnTaking.commitMaxDelayMs ?? current.commitMaxDelayMs
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
      throw new ValidationError('turnTaking.commitMinDelayMs must not exceed commitMaxDelayMs')
    }
  }

  if (patch.saveMicSamples !== undefined && typeof patch.saveMicSamples !== 'boolean') {
    throw new ValidationError('saveMicSamples must be a boolean')
  }
  if (patch.takeover !== undefined && patch.takeover !== 'ask' && patch.takeover !== 'always') {
    throw new ValidationError("takeover must be 'ask' or 'always'")
  }

  await saveConfigField(configPath, config, doc => applyVoicePatch(doc, patch))

  return config.voice
}

/** Applies a validated patch to a configuration document. */
function applyVoicePatch(config: PlatformConfig, patch: VoiceSelectionPatch): void {
  if (!config.voice) config.voice = {}
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

  if (patch.vad !== undefined) {
    if (!config.voice.stt) config.voice.stt = {}
    config.voice.stt.vad = { ...(config.voice.stt.vad as object | undefined), ...patch.vad }
  }

  if (patch.turnTaking !== undefined) {
    if (!config.voice.stt) config.voice.stt = {}
    config.voice.stt.turnTaking = { ...(config.voice.stt.turnTaking as object | undefined), ...patch.turnTaking }
  }

  if (patch.saveMicSamples !== undefined) {
    if (!config.voice.debug) config.voice.debug = {}
    config.voice.debug.saveMicSamples = patch.saveMicSamples
  }

  if (patch.takeover !== undefined) config.voice.takeover = patch.takeover
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export class RosterUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RosterUnavailableError'
  }
}

/** Reads the state file, applies `mutate`, and writes it back under the file's lock. */
async function saveState(configPath: string, mutate: (state: RuntimeState) => void): Promise<RuntimeState> {
  const statePath = statePathFor(configPath)
  return withFileLock(statePath, async () => {
    const { state } = await readStateFile(statePath)
    mutate(state)
    await mkdir(dirname(statePath), { recursive: true })
    await writeFileAtomicUnlocked(statePath, serialize(state))
    return state
  })
}

export async function updateLastAgent(configPath: string, agentId: string): Promise<string> {
  if (typeof agentId !== 'string' || !agentId.trim()) {
    throw new ValidationError('agentId must be a non-empty string')
  }
  await saveState(configPath, state => { state.lastAgent = agentId })
  return agentId
}

export async function updateLastSession(
  configPath: string,
  agentId: string,
  sessionName: string
): Promise<Record<string, string>> {
  if (typeof agentId !== 'string' || !agentId.trim()) {
    throw new ValidationError('agentId must be a non-empty string')
  }
  if (typeof sessionName !== 'string' || !sessionName.trim()) {
    throw new ValidationError('sessionName must be a non-empty string')
  }

  const state = await saveState(configPath, s => { s.lastSessionByAgent[agentId] = sessionName })
  return state.lastSessionByAgent
}

export function registerGatewayConfig(app: Hono<any>, config: PlatformConfig, configPath?: string) {
  app.get('/api/gateway', async (c) => {
    const gw = config.integrations?.openclaw?.gateway
    const token = resolveConfigValue(gw?.token)
    if (!gw?.url || !token) {
      return c.json({ error: 'Gateway not configured' }, 503)
    }
    const defaultSession = config.integrations?.openclaw?.defaultSession
    const state = configPath ? await readRuntimeState(configPath) : undefined
    const lastAgent = state?.lastAgent
    const lastSessionByAgent = state && Object.keys(state.lastSessionByAgent).length > 0 ? state.lastSessionByAgent : undefined
    return c.json({
      url: gw.url,
      token,
      ...(lastAgent && { lastAgent }),
      ...(defaultSession && { defaultSession }),
      ...(lastSessionByAgent && { lastSessionByAgent }),
    })
  })

  app.patch('/api/gateway/lastAgent', async (c) => {
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
      const agentId = await updateLastAgent(configPath, body.agentId)
      return c.json({ lastAgent: agentId })
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
      const lastSessionByAgent = await updateLastSession(configPath, body.agentId, body.sessionName)
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
  /** An assembly with no providers means it can't be read — the control
   *  plane always has at least its own (possibly empty) roster. */
  getAssembly?: () => AssembledRoster,
  neverPolledHosts?: () => string[],
) {
  const getProviders = (): VoiceModeProvider[] => voiceModeProviders(getAssembly ? getAssembly() : { providers: [], voices: [], collisions: [] })

  app.get('/api/voice', async (c) => {
    if (!config.voice) {
      return c.json({ error: 'Voice not configured' }, 503)
    }
    const assembledProviders = getAssembly ? getAssembly().providers : []
    const sttOptions = (getServices ? getServices() : [])
      .filter(s => s.capabilityId === 'stt')
      .map(s => ({
        serviceId: s.id,
        name: s.name ?? s.id,
        sessions: assembledProviders.find(p => p.serviceId === s.id)?.sessions ?? false,
      }))

    return c.json({
      ...config.voice,
      tts: { ...(config.voice.tts ?? {}), providers: getProviders() },
      stt: { ...(config.voice.stt ?? {}), options: sttOptions },
    })
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
      const updatedVoice = await updateVoiceSelection(configPath, config, patch, getServices, getProviders, neverPolledHosts)
      return c.json(updatedVoice)
    } catch (err) {
      if (err instanceof ValidationError) {
        return c.json({ error: err.message }, 400)
      }
      if (err instanceof RosterUnavailableError) {
        return c.json({ error: err.message }, 503)
      }
      throw err
    }
  })
}

/** A leading `~` in a configured path means the home directory. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

// Debug scratch: mic samples are throwaway captures for diagnosing the voice
// pipeline, so they default under the OS temp dir rather than a data
// directory. Set MIC_SAMPLE_DIR to keep them somewhere durable.
const MIC_SAMPLE_DIR = expandTilde(
  process.env.MIC_SAMPLE_DIR ?? join(tmpdir(), 'banter-voice-debug/mic-samples')
)
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

export interface ConfigReloadDeps {
  config: PlatformConfig
  configPath?: string
  registry: Registry
  registryPath: string
  eventsPath: string
  shards: Shard[]
  reloadShard: (endpoint: string) => Promise<ShardReloadResponse>
  pollShard: (hostId: string) => Promise<void>
}

/** Covers only the control plane's local services; a shard-hosted service's
 *  removal is reported in the shard's own part of the reload response. */
async function isLocalServiceRunning(eventsPath: string): Promise<(serviceId: string) => boolean> {
  const healthMap = await deriveHealthMap(eventsPath)
  return (serviceId: string) =>
    ["healthy", "degraded", "timed_out"].includes(deriveHealth(healthMap.get(serviceId) ?? null))
}

export function registerConfigReload(app: Hono<any>, deps: ConfigReloadDeps) {
  app.post('/api/config/reload', async (c) => {
    const { config, configPath, registry, registryPath, eventsPath, shards, reloadShard, pollShard } = deps

    let configResult: PartResult
    if (!configPath) {
      configResult = { ok: false, error: 'Config path not set' }
    } else {
      try {
        await reloadConfig(configPath, config)
        configResult = { ok: true }
      } catch (err) {
        configResult = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    const isRunning = await isLocalServiceRunning(eventsPath)
    const registryResult = await reloadRegistry(registryPath, registry, isRunning)
    const warnings: ReloadWarning[] = registryResult.ok ? registryResult.warnings : []

    const shardResults: Record<string, PartResult> = {}
    for (const shard of shards) {
      const result = await reloadShard(shard.endpoint)
      shardResults[shard.hostId] = result.registry
      warnings.push(...result.warnings)
      // Polled even if the reload failed, rather than waiting out the interval.
      await pollShard(shard.hostId)
    }

    const response: ControlPlaneReloadResponse = {
      config: configResult,
      registry: registryResult.ok ? { ok: true } : { ok: false, error: registryResult.error },
      shards: shardResults,
      warnings,
    }
    const allOk = configResult.ok && registryResult.ok && Object.values(shardResults).every(r => r.ok)
    return c.json(response, allOk ? 200 : 500)
  })
}
