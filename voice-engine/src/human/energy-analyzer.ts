export function computeRmsEnergy(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i]
  }
  return Math.min(1, Math.sqrt(sum / samples.length))
}
