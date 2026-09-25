export type StreamingBackend = 'mms' | 'mse' | 'blob'

const STORAGE_KEY = 'tts-streaming-backend'

function detectBackend(): StreamingBackend {
  if (typeof ManagedMediaSource !== 'undefined') return 'mms'
  if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported?.('audio/mpeg')) return 'mse'
  return 'blob'
}

export function loadStreamingBackend(): StreamingBackend {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  if (stored === 'mms' || stored === 'mse' || stored === 'blob') return stored
  return detectBackend()
}

export function saveStreamingBackend(backend: StreamingBackend | 'auto'): void {
  if (typeof localStorage === 'undefined') return
  if (backend === 'auto') {
    localStorage.removeItem(STORAGE_KEY)
  } else {
    localStorage.setItem(STORAGE_KEY, backend)
  }
}

export function getDetectedBackend(): StreamingBackend {
  return detectBackend()
}

/** The active backend for this session — captured once at module load. */
export const STREAMING_BACKEND: StreamingBackend = loadStreamingBackend()
