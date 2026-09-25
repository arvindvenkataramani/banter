export type { TtsVoice, TtsModel, TtsModelChunking, TtsProvider, SttOption, VoiceSelection, StoredVoiceSelection, AudioFormat, VoiceConfig, ChunkStrategy } from './voice-config'
export { fetchVoiceConfig, loadVoiceSelection, resolveVoiceSelection } from './voice-config'
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
} from './agent/chunking-setting'
export {
  CHUNKING, DEFAULT_CHUNK_STRATEGY, resolveChunkingFields, resolveChunkingFor,
  chunkingLayersFor, diffGlobalOptions,
} from './agent/chunking-setting'
export { ensureTtsReady, ensureServiceReady, loadTtsModel, unloadTtsModel } from './voice-service'
export { cleanForSpeech } from './agent/text-cleaner'
export { TextChunker } from './agent/text-chunker'
export type { TextChunkerOpts, ChunkMode } from './agent/text-chunker'
export { UtteranceBuffer } from './human/utterance-buffer'
export type { UtteranceBufferCallbacks } from './human/utterance-buffer'
export { MIC_AUDIO_CONSTRAINTS, acquire as acquireDevices, release as releaseDevices } from '../system/devices'
export { SileroVad } from './human/silero-vad'
export type { VadResult } from './human/silero-vad'
export { SmartTurn } from './human/smart-turn'
export { computeRmsEnergy } from './human/energy-analyzer'
export { encodeWav } from './human/wav-encoder'
export { transcribeAudio, setSaveMicSamples } from './human/stt-client'
export type { LoopState, PlaybackState } from './floor-selectors'
export { loopStateFromSnapshot, micReadyFromSnapshot, playbackStateFromSnapshot } from './floor-selectors'
// Streaming-backend selection (used by voice-settings UI)
export type { StreamingBackend } from './system/streaming-backend'
export {
  STREAMING_BACKEND, loadStreamingBackend, saveStreamingBackend, getDetectedBackend,
} from './system/streaming-backend'
export type { MicState, MicLoopCallbacks } from './human/mic-loop'
export { HumanVoice } from './human/human-voice'
export type { HumanVoiceCallbacks } from './human/human-voice'
export { AgentVoice } from './agent/agent-voice'
// The floor: the reducer that decides who may speak.
export { initialTurnManagerState, reduce, snapshot } from './turn-manager'
export type {
  Speaker, Actor, UtterancePhase, UtteranceOutcome, Utterance,
  AudioSupply, ConversationReport, ControlsReport, Mode, Report,
  TurnOutcome, Turn, Relations, Previous, TurnManagerState, Snapshot, TurnManagerConfig,
} from './turn-manager'
export {
  useTurnManagerStore, report, resetTurnManager, configureTurnManager,
  attachSession, detachSession, reportComposerSend, reportComposerFocus,
} from './store/turn-manager-store'
export type { TurnManagerStoreState, SendableSession } from './store/turn-manager-store'
export {
  useTranscriptStore, setPartial, settle, settleVisible, drop,
  editTranscript, takeTranscript, configureReveal,
} from './store/transcript-store'
export type { TranscriptStoreState, PendingUtterance } from './store/transcript-store'
