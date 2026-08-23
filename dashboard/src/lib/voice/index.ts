export type { TtsVoice, TtsModel, TtsModelChunking, TtsProvider, SttOption, VoiceSelection, VoiceConfig, ChunkStrategy } from './voice-config'
export { fetchVoiceConfig, loadVoiceSelection, loadSpeechEnabled, saveSpeechEnabled } from './voice-config'
export type {
  SettingsScope, FieldOrigin, ModelPref, ModelPrefs, SettingDraft, ResolvedField,
} from './model-settings'
export {
  editField, deleteModelOverride, normalizeOverride,
  hasModelDefaults, hasOverride, buildModelPrefEntry,
  settingsScopeFrom, readPrefs,
} from './model-settings'
export type {
  ChunkingField, ChunkingSet, ChunkingDraft, ResolvedChunkingFields, ResolvedChunking,
} from './chunking-setting'
export {
  CHUNKING, DEFAULT_CHUNK_STRATEGY, resolveChunkingFields, resolveChunkingFor,
  chunkingLayersFor, diffGlobalOptions,
} from './chunking-setting'
export { ensureTtsReady, ensureServiceReady, loadTtsModel, unloadTtsModel } from './voice-service'
export { cleanForSpeech } from './text-cleaner'
export type { PlayerState as PlaybackState } from './playback-engine'
export { TextChunker } from './text-chunker'
export type { TextChunkerOpts, ChunkMode } from './text-chunker'
export { MicCapture, MIC_AUDIO_CONSTRAINTS } from './mic-capture'
export type { MicCaptureCallbacks, MicCaptureStartOpts } from './mic-capture'
export { SileroVad } from './silero-vad'
export type { VadResult } from './silero-vad'
export { SmartTurn } from './smart-turn'
export { computeRmsEnergy } from './energy-analyzer'
export { encodeWav } from './wav-encoder'
export { transcribeAudio, setSaveMicSamples } from './stt-client'
export type { LoopState, UseVoiceLoopOpts, UseVoiceLoopResult } from './use-voice-loop'
export { useVoiceLoop } from './use-voice-loop'
// Streaming-backend selection (used by voice-settings UI)
export type { StreamingBackend } from './streaming-backend'
export {
  STREAMING_BACKEND, loadStreamingBackend, saveStreamingBackend, getDetectedBackend,
} from './streaming-backend'
// Stores (exposed for advanced consumers / future audio-brief feature)
export { useMicStore } from './store/mic-store'
export type { MicState } from './store/mic-store'
export { usePlayerStore } from './store/player-store'
export { useLLMStore } from './store/llm-store'
export type { LLMState } from './store/llm-store'
