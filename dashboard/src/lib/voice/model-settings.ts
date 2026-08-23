// Per-model settings: one app-wide scope deciding whether per-model
// overrides are consulted at all, per-model override bags layered under a
// model's own shipped defaults and the global preferences, and the
// staged-draft reducers the settings dialog uses to edit them before Save.
// See plans/voice-chat.md's settings phase for the model this implements.
//
// A layer "declares" a field iff its value is neither `undefined` nor `null`
// — this holds uniformly for global options, model defaults, and per-model
// overrides. `null` is a stored value meaning "not declared", never key
// deletion (matching the server's pre-existing `maxChunkWords` semantics).
//
// A ModelPref is one values bag per setting, keyed by that setting's
// descriptor `key`. The bags are only ever reached through the
// descriptor-aware helpers here.

import type { VoiceConfig } from './voice-config'

export type SettingsScope = 'global' | 'per-model'
export type FieldOrigin = 'override' | 'model' | 'global' | 'none'

/** A partial set of values for one setting. `null` means "declared as nothing". */
export type SettingSet<F extends string, V> = { [K in F]?: V | null }

/** A model's stored preference: one values bag per setting, keyed by that
 *  setting's descriptor `key`. Bags are read/written via the helpers below,
 *  never by property name. */
export interface ModelPref {
  [setting: string]: SettingSet<string, unknown> | undefined
}

export type ModelPrefs = Record<string, Record<string, ModelPref>>

export interface SettingDraft<F extends string, V> {
  scope: SettingsScope
  global: SettingSet<F, V>        // editable
  pref: ModelPref                 // editable — the dialog's selected model
  modelDefaults: SettingSet<F, V> // read-only
}

export interface ResolvedField<T> {
  value: T | undefined
  from: FieldOrigin
}

export type ResolvedFields<F extends string, V> = Record<F, ResolvedField<V>>

export interface SettingDescriptor<F extends string, V> {
  /** Key this setting's bag occupies inside a stored ModelPref. */
  key: string
  fields: readonly F[]
  /** Config → the global set. */
  globalSet(config: VoiceConfig | null): SettingSet<F, V>
  /** Config → what this model declares. */
  modelDefaults(config: VoiceConfig | null, serviceId: string, modelId: string): SettingSet<F, V>
  /** Field → the key it occupies in a global-options patch. */
  patchKeys: Record<F, string>
}

// ── Declared-ness ────────────────────────────────────────────────────────

function declared<T>(v: T | null | undefined): v is T {
  return v !== undefined && v !== null
}

function hasAnyDeclared<F extends string, V>(
  d: SettingDescriptor<F, V>,
  set: SettingSet<F, V> | undefined,
): boolean {
  return d.fields.some(f => declared(set?.[f]))
}

// ── Bag access ───────────────────────────────────────────────────────────
//
// Bag read/write goes through explicit Record<string, unknown> intermediates,
// not computed-key object literals — both for TS predictability and,
// critically, for key order: voice-settings.tsx decides "this model was
// touched" with JSON.stringify(draft.pref) !== JSON.stringify(next.pref).
// Spreading first and assigning second preserves an existing key's position
// and appends a missing one at the end, which keeps that comparison stable
// across an edit that doesn't add a new setting's bag.

function overrideSet<F extends string, V>(
  d: SettingDescriptor<F, V>,
  pref: ModelPref,
): SettingSet<F, V> | undefined {
  return (pref as Record<string, unknown>)[d.key] as SettingSet<F, V> | undefined
}

function withOverrideSet<F extends string, V>(
  d: SettingDescriptor<F, V>,
  pref: ModelPref,
  set: SettingSet<F, V>,
): ModelPref {
  const next: Record<string, unknown> = { ...pref }
  next[d.key] = set
  return next as ModelPref
}

// ── Reading config ───────────────────────────────────────────────────────

export function settingsScopeFrom(config: VoiceConfig | null): SettingsScope {
  return config?.tts.settingsScope === 'global' ? 'global' : 'per-model'
}

// Written by an earlier client (066546c); read-inert now, dropped on read so
// it disappears from config.json the first time each entry is rewritten.
const LEGACY_PREF_KEYS = ['source'] as const

/** Strips legacy keys (see LEGACY_PREF_KEYS) and shallow-copies every bag,
 * so the result is safe for the dialog to mutate without touching config. */
export function readPref(pref: ModelPref | undefined): ModelPref {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(pref ?? {})) {
    if ((LEGACY_PREF_KEYS as readonly string[]).includes(key)) continue
    next[key] = { ...(value as SettingSet<string, unknown>) }
  }
  return next as ModelPref
}

export function readPrefs(prefs: ModelPrefs | undefined): ModelPrefs {
  const next: ModelPrefs = {}
  for (const [serviceId, models] of Object.entries(prefs ?? {})) {
    const bucket: Record<string, ModelPref> = {}
    for (const [modelId, pref] of Object.entries(models)) {
      bucket[modelId] = readPref(pref)
    }
    next[serviceId] = bucket
  }
  return next
}

// ── Chains ───────────────────────────────────────────────────────────────
//
// chainFor is the resolution order for the active scope. WITHOUT_OVERRIDE is
// the comparison chain used to decide what counts as "overridden" — it drives
// both normalization and the derived "is this field overridden" comparison.
// Getting this wrong is the single most likely implementation error in this
// file.

function chainFor(scope: SettingsScope): FieldOrigin[] {
  return scope === 'global' ? ['global'] : ['override', 'model', 'global']
}

const WITHOUT_OVERRIDE: FieldOrigin[] = ['model', 'global']

export function declaredAt<F extends string, V>(
  d: SettingDescriptor<F, V>,
  draft: SettingDraft<F, V>,
  origin: FieldOrigin,
  field: F,
): V | undefined {
  let v: V | null | undefined
  switch (origin) {
    case 'override': v = overrideSet(d, draft.pref)?.[field]; break
    case 'model': v = draft.modelDefaults[field]; break
    case 'global': v = draft.global[field]; break
    case 'none': v = undefined; break
  }
  return declared(v) ? v : undefined
}

function resolveFieldAlong<F extends string, V>(
  d: SettingDescriptor<F, V>,
  draft: SettingDraft<F, V>,
  field: F,
  chain: FieldOrigin[],
): ResolvedField<V> {
  for (const origin of chain) {
    const v = declaredAt(d, draft, origin, field)
    if (v !== undefined) return { value: v, from: origin }
  }
  return { value: undefined, from: 'none' }
}

// ── Resolution ───────────────────────────────────────────────────────────

export function resolveFields<F extends string, V>(
  d: SettingDescriptor<F, V>,
  draft: SettingDraft<F, V>,
): ResolvedFields<F, V> {
  const chain = chainFor(draft.scope)
  const out = {} as ResolvedFields<F, V>
  for (const field of d.fields) {
    out[field] = resolveFieldAlong(d, draft, field, chain)
  }
  return out
}

export function draftFor<F extends string, V>(
  d: SettingDescriptor<F, V>,
  config: VoiceConfig | null,
  serviceId: string,
  modelId: string,
): SettingDraft<F, V> {
  const stored = config?.tts.modelPrefs?.[serviceId]?.[modelId]
  return {
    scope: settingsScopeFrom(config),
    global: d.globalSet(config),
    pref: stored ? readPref(stored) : emptyPref(d),
    modelDefaults: d.modelDefaults(config, serviceId, modelId),
  }
}

// ── Reducers over the draft ─────────────────────────────────────────────
// All return a new SettingDraft; none mutate.

function withField<F extends string, V>(
  set: SettingSet<F, V>,
  field: F,
  value: V | undefined,
): SettingSet<F, V> {
  const next: SettingSet<F, V> = { ...set }
  if (value === undefined) delete next[field]
  else (next as Record<F, unknown>)[field] = value
  return next
}

export function emptyPref<F extends string, V>(d: SettingDescriptor<F, V>): ModelPref {
  const pref: Record<string, unknown> = {}
  pref[d.key] = {}
  return pref as ModelPref
}

/** Drops override fields that are redundant with what resolution would give
 * without the override layer, and strips undeclared (null) entries. No-op
 * under `'global'` scope — the override layer isn't consulted there, so
 * normalizing it would prune stored fields that happen to match the global
 * set, breaking "switching to global and back restores what you had". */
export function normalizeOverride<F extends string, V>(
  d: SettingDescriptor<F, V>,
  draft: SettingDraft<F, V>,
): SettingDraft<F, V> {
  if (draft.scope === 'global') return draft
  let nextSet: SettingSet<F, V> = {}
  for (const field of d.fields) {
    const v = overrideSet(d, draft.pref)?.[field]
    if (!declared(v)) continue
    let w: V | undefined
    for (const origin of WITHOUT_OVERRIDE) {
      const cv = declaredAt(d, draft, origin, field)
      if (cv !== undefined) { w = cv; break }
    }
    if (v !== w) nextSet = withField(nextSet, field, v)
  }
  return { ...draft, pref: withOverrideSet(d, draft.pref, nextSet) }
}

export function editField<F extends string, V>(
  d: SettingDescriptor<F, V>,
  draft: SettingDraft<F, V>,
  field: F,
  value: V | undefined,
): SettingDraft<F, V> {
  if (draft.scope === 'global') {
    return { ...draft, global: withField(draft.global, field, value) }
  }
  const pref = withOverrideSet(d, draft.pref, withField(overrideSet(d, draft.pref) ?? {}, field, value))
  return normalizeOverride(d, { ...draft, pref })
}

/** Unconditional — the button that calls this ("Reset to model defaults") has
 * no partial form; it always clears the whole bag. */
export function deleteModelOverride<F extends string, V>(
  d: SettingDescriptor<F, V>,
  draft: SettingDraft<F, V>,
): SettingDraft<F, V> {
  return { ...draft, pref: withOverrideSet(d, draft.pref, {}) }
}

// ── Derived predicates ──────────────────────────────────────────────────

export function hasModelDefaults<F extends string, V>(
  d: SettingDescriptor<F, V>,
  draft: SettingDraft<F, V>,
): boolean {
  return hasAnyDeclared(d, draft.modelDefaults)
}

export function hasOverride<F extends string, V>(
  d: SettingDescriptor<F, V>,
  draft: SettingDraft<F, V>,
): boolean {
  return hasAnyDeclared(d, overrideSet(d, draft.pref))
}

// ── Patch builders ───────────────────────────────────────────────────────

/** With a second setting this rule would have to consider every bag before
 * returning `null`; today there is one. Rebuilding from the descriptor's bag
 * alone (rather than passing the stored ModelPref through) is what drops a
 * legacy `source` key on rewrite. */
export function buildModelPrefEntry<F extends string, V>(
  d: SettingDescriptor<F, V>,
  pref: ModelPref,
): ModelPref | null {
  const set = overrideSet(d, pref)
  if (!hasAnyDeclared(d, set)) return null
  const entry: Record<string, unknown> = {}
  entry[d.key] = set
  return entry as ModelPref
}

/** Diff-based rather than always-send, so opening and saving the dialog on an
 * old config doesn't stamp new keys into it, and a field displayed only
 * because of a fallback default (from: 'none') can never persist as if it
 * were an edit. Declared-ness is compared first: loaded `null` is equivalent
 * to staged `undefined` (both "not declared"). */
export function diffGlobalSet<F extends string, V>(
  d: SettingDescriptor<F, V>,
  loaded: SettingSet<F, V>,
  staged: SettingSet<F, V>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of d.fields) {
    const key = d.patchKeys[field]
    const loadedDeclared = declared(loaded[field])
    const stagedDeclared = declared(staged[field])
    if (!loadedDeclared && !stagedDeclared) continue
    if (loadedDeclared && stagedDeclared && loaded[field] === staged[field]) continue
    if (stagedDeclared) {
      result[key] = staged[field]
    } else {
      result[key] = null
    }
  }
  return result
}
