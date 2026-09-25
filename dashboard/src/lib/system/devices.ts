/**
 * The playback and capture devices: the audio element, the microphone
 * stream, its AudioContext, and the frame source built on top of them.
 * Owned here rather than by whatever plays or records through them, because
 * more than one thing borrows each device across a voice session's
 * lifetime — the mic loop attaches to the frame source only once the mode
 * reaches live, and the player reads the element that a much earlier tap
 * already unlocked.
 *
 * `acquire()` runs inside the tap that turns voice on. iOS Safari grants a
 * later programmatic audio.play() only on an element a user gesture already
 * played, and only prompts for microphone permission when getUserMedia runs
 * synchronously inside that same gesture — so acquire() starts the element's
 * gesture play and then the getUserMedia call before its own first await, in
 * that order. The microphone's AudioContext takes no gesture of its own and
 * is built later still, at the frame source's first attach. Nothing here may
 * import from lib/voice/: this module owns the devices for whatever uses
 * them, voice among them.
 */

/**
 * What every model and encoder downstream expects, asked of the capture
 * session and of the context built over it so the conversion happens once,
 * natively, in a path that is running anyway. Doing it ourselves would put
 * a resample on the main thread for every frame, ahead of two ONNX models.
 * Unpinning it means resampling somewhere, not getting it for free.
 */
export const MIC_SAMPLE_RATE = 16000

/** Mic constraints — shared with whatever calls acquire() so they can't drift. */
export const MIC_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  sampleRate: MIC_SAMPLE_RATE,
}

/**
 * The capture worklet's frame size, in samples. Not exported: a consumer
 * that named this again would have encoded a frame size nothing could check
 * against this one. The worklet is fetched at runtime and cannot import it,
 * so it arrives via `processorOptions` on the node built below; every
 * consumer downstream of the frame source counts time, not frames, and has
 * nothing to import it for.
 */
const FRAME_SAMPLES = 4096

/** One raw 16kHz mono frame, batched by the microphone's AudioWorklet. */
export type Frame = Float32Array

interface FrameSource {
  attach(onFrame: (frame: Frame) => void): void
  detach(): void
}

// Resolved by the bundler, which fingerprints the file and serves it as its
// own module — the worklet is fetched at runtime, never imported into the
// page's own graph.
const WORKLET_URL = new URL('./mic-frames-worklet.js', import.meta.url).href

let audio: HTMLAudioElement | null = null
let stream: MediaStream | null = null
let micContext: AudioContext | null = null
let micSource: MediaStreamAudioSourceNode | null = null
let micNode: AudioWorkletNode | null = null
let frameCallback: ((frame: Frame) => void) | null = null
/** Identifies the in-flight graph build, so a release() during it — or a
 * release followed by a fresh acquire before addModule resolves — can tell
 * whether the build that finishes is still the one wanted, the same pattern
 * `attempt` uses for acquire(). */
let building: object | null = null

// The in-flight acquisition, so a second acquire() call before the first has
// settled returns the same promise rather than opening a second stream.
let acquiring: Promise<boolean> | null = null
/** The in-flight acquire, so a resolving stream knows whether it is still wanted. */
let attempt: object | null = null

/**
 * Get (or create) the audio element. Page-lifetime, not session-lifetime:
 * iOS Safari's play-inside-a-gesture grant lives on the element instance
 * itself, so replacing it at voice-off would throw the grant away and leave
 * the next voice start silent.
 */
export function element(): HTMLAudioElement {
  if (audio) return audio
  audio = new Audio()
  return audio
}

/**
 * Play the element inside a user gesture, so a later programmatic play()
 * needs no gesture of its own. The element is empty at this point — the
 * play is for the permission, not for any audio — and it stays this
 * instance for the rest of the page's life.
 *
 * Exported on its own, distinct from acquire(): whatever arms the element's
 * listeners and attaches a media source (the playback engine's own
 * unlock()) needs this play without opening the microphone too, and
 * acquire() needs it inside its own gesture-ordered sequence.
 */
export function unlockElement(): void {
  const a = element()
  Promise.resolve(a.play()).catch(() => { /* a refused play leaves the element locked, nothing else */ })
}

/**
 * Acquire the devices for a voice session: the element's gesture play and
 * the microphone stream, started in that order and both before this
 * function's own first await. Called directly from the tap, never through a
 * store subscription or an effect — the ordering is what carries the iOS
 * gesture grant.
 *
 * The microphone's audio graph is *not* built here. Opening it switches the
 * device's audio route, which is audible in anything already playing, so it
 * waits for the frame source's first attach — see openMicGraph().
 *
 * Idempotent while a session holds the devices: a second call before
 * release() returns the same promise (or resolves at once) rather than
 * opening a second stream.
 *
 * Resolves true when the stream it opened is the one now installed, and
 * false when a release() or a later acquire() superseded it while
 * getUserMedia was pending — in which case its stream has been stopped and
 * nothing was installed. A caller that acted on a false would be acting for
 * a session that no longer exists.
 */
export function acquire(): Promise<boolean> {
  if (stream) return Promise.resolve(true)
  if (acquiring) return acquiring

  unlockElement()
  const streamPromise = navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO_CONSTRAINTS })

  // Identifies this attempt across the await: a release() and a fresh
  // acquire() may both run while gUM is pending, and each attempt must only
  // ever tear down or install its own devices.
  const token = {}
  attempt = token

  acquiring = streamPromise.then((s) => {
    // A release() ran while gUM was pending. Stop the stream release()
    // never saw and leave the current attempt's state alone.
    if (attempt !== token) {
      s.getTracks().forEach((t) => t.stop())
      return false
    }
    stream = s
    acquiring = null
    return true
  }).catch((err) => {
    if (attempt === token) {
      attempt = null
      acquiring = null
    }
    throw err
  })

  return acquiring
}

/** The microphone stream, once acquire() has resolved. Null before that, and
 * null again after release(). */
export function micStream(): MediaStream | null {
  return stream
}

/**
 * Build the microphone's audio graph over the acquired stream. Separate
 * from acquire() and deliberately later than it: opening a capture session
 * makes iOS switch its audio session to a play-and-record route, and a
 * sound already on the element crackles through the switch. The tones
 * bracket a session, so the switch has to happen after they have settled —
 * which is where the pipeline had it before the devices moved, by accident
 * of MicCapture.start() building the context itself.
 *
 * Takes no gesture of its own: the element played in acquire() carries the
 * grant. Safe to call twice; the second call is a no-op, including while
 * the first is still loading the worklet.
 *
 * Capture runs in an AudioWorklet on the audio rendering thread, and the
 * node declares no outputs: nothing the microphone produces reaches the
 * output graph, and the node is pumped without needing a connection to a
 * destination — which a ScriptProcessorNode could not do.
 */
function openMicGraph(): void {
  if (micContext || building || !stream) return
  const ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE })
  const s = stream

  // addModule fetches and compiles the processor, so the graph is finished
  // asynchronously. A release() arriving in that window, or a release
  // followed by a fresh acquire and attach before this resolves, must not be
  // overtaken by the graph it was tearing down: the token identifies this
  // build, and only the build still named by `building` publishes itself.
  const token = {}
  building = token
  ctx.audioWorklet.addModule(WORKLET_URL).then(() => {
    if (building !== token) {
      void ctx.close()
      return
    }
    micSource = ctx.createMediaStreamSource(s)
    micNode = new AudioWorkletNode(ctx, 'mic-frames', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { frameSamples: FRAME_SAMPLES },
    })
    micNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      frameCallback?.(event.data)
    }
    micSource.connect(micNode)
    micContext = ctx
    building = null
  }).catch((err) => {
    console.error('[devices] microphone worklet failed to load:', err)
    void ctx.close()
    if (building === token) building = null
  })
}

/**
 * The frame source MicCapture is constructed over. Reading frames requires
 * no gesture and no getUserMedia of its own, and the first attach is what
 * opens the microphone's audio graph — so nothing is captured, and no audio
 * route changes, until something is actually listening.
 */
export const frameSource: FrameSource = {
  attach(onFrame: (frame: Frame) => void): void {
    frameCallback = onFrame
    openMicGraph()
  },
  detach(): void {
    frameCallback = null
  },
}

/**
 * Release the devices at the end of the ending mode: the microphone stream,
 * its AudioContext and processor are torn down; the audio element is not —
 * it carries the gesture grant, and stays for the next acquire().
 *
 * Safe to call on a partial acquire (getUserMedia refused, or release()
 * arriving before acquire()'s promise settles) and safe to call twice.
 */
export function release(): void {
  acquiring = null
  attempt = null
  frameCallback = null
  // Cleared before the teardown below, so a graph still being built sees its
  // token no longer matches and closes its own context rather than
  // installing one behind this.
  building = null
  micNode?.port.close()
  micNode?.disconnect()
  micSource?.disconnect()
  stream?.getTracks().forEach((t) => t.stop())
  micContext?.close()
  micNode = null
  micSource = null
  stream = null
  micContext = null
}

/** Test seam: forget every device, including the element. A page never
 * needs this — the element's gesture grant is meant to survive — but a
 * test file with one `it()` per element needs a clean singleton between
 * cases. */
export function resetDevicesForTest(): void {
  release()
  audio = null
}
