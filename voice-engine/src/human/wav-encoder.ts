export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numSamples = samples.length
  const byteRate = sampleRate * 2 // 16-bit mono
  const dataBytes = numSamples * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)          // fmt chunk size
  view.setUint16(20, 1, true)           // PCM format
  view.setUint16(22, 1, true)           // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, 2, true)           // block align
  view.setUint16(34, 16, true)          // bits per sample
  writeString(36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true)
  }

  return buffer
}
