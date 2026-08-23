import { describe, it, expect } from 'vitest'
import {
  CHUNKING,
  resolveChunkingFields,
  diffGlobalOptions,
} from './chunking-setting'
import type { ChunkingDraft, ChunkingSet } from './chunking-setting'
import {
  normalizeOverride,
  editField,
  deleteModelOverride,
  hasOverride,
  hasModelDefaults,
  buildModelPrefEntry,
  resolveFields,
} from './model-settings'
import type { SettingsScope, SettingDescriptor, SettingDraft } from './model-settings'

// ── Helpers ─────────────────────────────────────────────────────────────────

function draftWith(
  scope: SettingsScope,
  chunking: ChunkingSet,
  global: ChunkingSet,
  modelDefaults: ChunkingSet,
): ChunkingDraft {
  return { scope, global, pref: { chunking }, modelDefaults }
}

// The real config's global default, and the one model that actually diverges
// from it. Since the redundant declarations were stripped, a declared set is
// partial by design — neutts-air states only what it wants differently.
const REAL_GLOBAL: ChunkingSet = { mode: 'greedy', minWords: 15, maxWords: 60 }
const NEUTTS_MODEL: ChunkingSet = { mode: 'sentence', maxWords: 50 }

// ── Chain resolution ─────────────────────────────────────────────────────────

describe('resolveChunkingFields — chain per scope', () => {
  // Deliberately partial at every layer, so each field lands on a different
  // origin and the fallthrough is actually exercised.
  const global: ChunkingSet = { mode: 'greedy', maxWords: 60 }
  const override: ChunkingSet = { minWords: 20 }
  const model: ChunkingSet = { mode: 'sentence', minWords: 10, maxWords: 50 }

  it('global scope: global only — the override is never consulted', () => {
    const fields = resolveChunkingFields(draftWith('global', override, global, model))
    expect(fields.mode).toEqual({ value: 'greedy', from: 'global' })
    expect(fields.maxWords).toEqual({ value: 60, from: 'global' })
    expect(fields.minWords).toEqual({ value: undefined, from: 'none' })
  })

  it('per-model scope: override -> model -> global', () => {
    const fields = resolveChunkingFields(draftWith('per-model', override, global, model))
    expect(fields.minWords).toEqual({ value: 20, from: 'override' })
    expect(fields.mode).toEqual({ value: 'sentence', from: 'model' })
    expect(fields.maxWords).toEqual({ value: 50, from: 'model' })
  })

  it('per-model falls through to global when neither override nor model declares', () => {
    const fields = resolveChunkingFields(draftWith('per-model', {}, global, {}))
    expect(fields.mode).toEqual({ value: 'greedy', from: 'global' })
    expect(fields.maxWords).toEqual({ value: 60, from: 'global' })
  })
})

describe('resolveChunkingFields — absence', () => {
  it('from: none when no layer declares the field', () => {
    const fields = resolveChunkingFields(draftWith('per-model', {}, {}, {}))
    expect(fields.mode).toEqual({ value: undefined, from: 'none' })
  })

  it('null counts as undeclared, not as a value', () => {
    const fields = resolveChunkingFields(
      draftWith('per-model', {}, { mode: null, minWords: 15 }, {}),
    )
    expect(fields.mode).toEqual({ value: undefined, from: 'none' })
    expect(fields.minWords).toEqual({ value: 15, from: 'global' })
  })
})

// ── Overridden is derived, not stored ────────────────────────────────────────

describe('normalizeOverride', () => {
  it('drops an override field equal to the without-override resolution', () => {
    const draft = draftWith('per-model', { mode: 'greedy' }, REAL_GLOBAL, {})
    const next = normalizeOverride(CHUNKING, draft)
    expect(next.pref.chunking).toEqual({})
    expect(hasOverride(CHUNKING, next)).toBe(false)
  })

  it('keeps an override field that differs from it', () => {
    const draft = draftWith('per-model', { mode: 'sentence' }, REAL_GLOBAL, {})
    const next = normalizeOverride(CHUNKING, draft)
    expect(next.pref.chunking).toEqual({ mode: 'sentence' })
    expect(hasOverride(CHUNKING, next)).toBe(true)
  })

  it('compares against the model default first, then global', () => {
    // maxWords 50 matches what neutts-air declares, so it is not an override.
    // mode greedy differs from the model's sentence, so it is.
    const draft = draftWith(
      'per-model',
      { mode: 'greedy', maxWords: 50 },
      REAL_GLOBAL,
      NEUTTS_MODEL,
    )
    const next = normalizeOverride(CHUNKING, draft)
    expect(next.pref.chunking).toEqual({ mode: 'greedy' })
  })

  it('is a no-op under global scope — there is no override in play', () => {
    const draft = draftWith('global', { mode: 'greedy' }, REAL_GLOBAL, {})
    expect(normalizeOverride(CHUNKING, draft)).toBe(draft)
  })
})

// ── Edits land where the scope says ──────────────────────────────────────────

describe('editField', () => {
  it('global scope: writes the global set, never the override', () => {
    const draft = draftWith('global', {}, REAL_GLOBAL, NEUTTS_MODEL)
    const next = editField(CHUNKING, draft, 'minWords', 25)
    expect(next.global.minWords).toBe(25)
    expect(next.pref.chunking).toEqual({})
  })

  it('per-model scope: writes the override, never global', () => {
    const draft = draftWith('per-model', {}, REAL_GLOBAL, NEUTTS_MODEL)
    const next = editField(CHUNKING, draft, 'minWords', 25)
    expect(next.pref.chunking).toEqual({ minWords: 25 })
    expect(next.global).toEqual(REAL_GLOBAL)
  })

  it('writes into the override even for a field the override does not yet cover', () => {
    // The displayed value came from global; the destination is still the
    // override, because the scope decides it — not the value's provenance.
    const draft = draftWith('per-model', { minWords: 25 }, REAL_GLOBAL, {})
    const next = editField(CHUNKING, draft, 'mode', 'sentence')
    expect(next.pref.chunking).toEqual({ minWords: 25, mode: 'sentence' })
    expect(next.global).toEqual(REAL_GLOBAL)
  })

  it('editing a field back to its inherited value removes it from the override', () => {
    const draft = draftWith('per-model', { minWords: 25 }, REAL_GLOBAL, {})
    const next = editField(CHUNKING, draft, 'minWords', 15)
    expect(next.pref.chunking).toEqual({})
    expect(hasOverride(CHUNKING, next)).toBe(false)
  })
})

// ── Deleting ────────────────────────────────────────────────────────────────

describe('deleteModelOverride', () => {
  it('clears the set, leaving the model on its defaults', () => {
    const draft = draftWith('per-model', { mode: 'sentence' }, REAL_GLOBAL, NEUTTS_MODEL)
    const next = deleteModelOverride(CHUNKING, draft)
    expect(hasOverride(CHUNKING, next)).toBe(false)
    const fields = resolveChunkingFields(next)
    expect(fields.mode).toEqual({ value: 'sentence', from: 'model' })
    expect(fields.minWords).toEqual({ value: 15, from: 'global' })
  })
})

describe('hasModelDefaults', () => {
  it('is true for a partial declared set', () => {
    expect(hasModelDefaults(CHUNKING, draftWith('per-model', {}, REAL_GLOBAL, NEUTTS_MODEL))).toBe(true)
  })

  it('is false when the model declares nothing', () => {
    expect(hasModelDefaults(CHUNKING, draftWith('per-model', {}, REAL_GLOBAL, {}))).toBe(false)
  })
})

// ── Persistence ─────────────────────────────────────────────────────────────

describe('buildModelPrefEntry', () => {
  it('returns null for an empty override — nothing worth storing', () => {
    expect(buildModelPrefEntry(CHUNKING, { chunking: {} })).toBeNull()
    expect(buildModelPrefEntry(CHUNKING, {})).toBeNull()
  })

  it('stores a non-empty override', () => {
    expect(buildModelPrefEntry(CHUNKING, { chunking: { mode: 'sentence' } }))
      .toEqual({ chunking: { mode: 'sentence' } })
  })
})

describe('diffGlobalOptions', () => {
  it('emits only the fields that changed, under their config key names', () => {
    expect(diffGlobalOptions(REAL_GLOBAL, { ...REAL_GLOBAL, minWords: 25 }))
      .toEqual({ minChunkWords: 25 })
  })

  it('emits nothing when nothing changed', () => {
    expect(diffGlobalOptions(REAL_GLOBAL, { ...REAL_GLOBAL })).toEqual({})
  })
})

// ── The core is generic ─────────────────────────────────────────────────────

describe('core genericity — a descriptor over non-chunking fields', () => {
  type PairField = 'alpha' | 'beta'
  const PAIR: SettingDescriptor<PairField, string> = {
    key: 'pair',
    fields: ['alpha', 'beta'],
    globalSet: () => ({}),
    modelDefaults: () => ({}),
    patchKeys: { alpha: 'alphaKey', beta: 'betaKey' },
  }

  function pairDraft(
    scope: SettingsScope,
    override: { alpha?: string; beta?: string },
    global: { alpha?: string; beta?: string },
    modelDefaults: { alpha?: string; beta?: string },
  ): SettingDraft<PairField, string> {
    return { scope, global, pref: { pair: override }, modelDefaults }
  }

  it('resolves override -> model -> global over a foreign field list', () => {
    const draft = pairDraft('per-model', { alpha: 'o' }, { alpha: 'g' }, { beta: 'm' })
    const fields = resolveFields(PAIR, draft)
    expect(fields.alpha).toEqual({ value: 'o', from: 'override' })
    expect(fields.beta).toEqual({ value: 'm', from: 'model' })
  })

  it('consults global only under global scope', () => {
    const draft = pairDraft('global', { alpha: 'o' }, { alpha: 'g' }, { beta: 'm' })
    const fields = resolveFields(PAIR, draft)
    expect(fields.alpha).toEqual({ value: 'g', from: 'global' })
    expect(fields.beta).toEqual({ value: undefined, from: 'none' })
  })

  it('editField writes into the bag named by the descriptor, not "chunking"', () => {
    const draft = pairDraft('per-model', {}, { alpha: 'g' }, {})
    const next = editField(PAIR, draft, 'alpha', 'x')
    expect(next.pref.pair).toEqual({ alpha: 'x' })
    expect(next.global).toEqual({ alpha: 'g' })
  })
})
