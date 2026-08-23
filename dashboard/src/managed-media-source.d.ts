/** TypeScript declarations for Managed Media Source API (Safari 17+, iOS 17+) */

declare class ManagedMediaSource extends EventTarget {
  constructor()
  readonly handle: MediaSourceHandle
  readonly readyState: 'closed' | 'open' | 'ended'
  readonly activeSourceBuffers: SourceBufferList
  readonly sourceBuffers: SourceBufferList
  readonly streaming: boolean
  duration: number
  onstartstreaming: ((this: ManagedMediaSource, ev: Event) => void) | null
  onendstreaming: ((this: ManagedMediaSource, ev: Event) => void) | null
  onsourceopen: ((this: ManagedMediaSource, ev: Event) => void) | null
  onsourceclose: ((this: ManagedMediaSource, ev: Event) => void) | null
  addSourceBuffer(type: string): SourceBuffer
  removeSourceBuffer(sourceBuffer: SourceBuffer): void
  endOfStream(error?: 'network' | 'decode'): void
}

declare class MediaSourceHandle {
  // Opaque handle — transferred to HTMLMediaElement.srcObject
}
