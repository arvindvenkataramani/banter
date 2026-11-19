/**
 * The microphone's capture processor, running on the audio rendering thread.
 *
 * Loaded by `audioWorklet.addModule()` rather than imported, so it is plain
 * JavaScript with no build step behind it and no imports of its own: this
 * file is fetched at runtime and evaluated in the worklet's own global
 * scope, where the module graph of the page does not exist.
 *
 * It batches the render quantum up to the frame size given at construction
 * and posts each frame to the main thread. Nothing here reaches the output:
 * `process()` returns true to stay alive, leaves its output buffer silent,
 * and the node needs no connection to a destination to keep running — which
 * is the part a ScriptProcessorNode could not do.
 *
 * The frame size is read from `processorOptions` rather than declared here:
 * this file is fetched at runtime into its own global scope and cannot
 * import a shared constant, so the size is passed in by whoever constructs
 * the node.
 */

class MicFramesProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const frameSamples = options.processorOptions.frameSamples
    this.frameSamples = frameSamples
    this.buffer = new Float32Array(frameSamples)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    // No input connected yet, or a silent render quantum: stay alive.
    if (!channel) return true

    let read = 0
    while (read < channel.length) {
      const take = Math.min(channel.length - read, this.frameSamples - this.filled)
      this.buffer.set(channel.subarray(read, read + take), this.filled)
      this.filled += take
      read += take

      if (this.filled === this.frameSamples) {
        // A copy, transferred rather than shared: the buffer here is reused
        // for the next frame, so the consumer must own what it receives.
        const frame = this.buffer.slice()
        this.port.postMessage(frame, [frame.buffer])
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('mic-frames', MicFramesProcessor)
