// Module-level, not per-instance: there is one voice engine, not one per
// session. agent-voice.ts registers `() => engine.cancel()`; the host's stop
// control calls haltAudio(), so the import direction is host → engine only.
const audioHalters = new Set<() => void>()

export function registerAudioHalter(halt: () => void): () => void {
  audioHalters.add(halt)
  return () => {
    audioHalters.delete(halt)
  }
}

export function haltAudio(): void {
  for (const halt of audioHalters) halt()
}
