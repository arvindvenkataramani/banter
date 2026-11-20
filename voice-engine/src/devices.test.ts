import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { acquire, resetDevicesForTest } from './devices'

// iOS Safari grants the audio element and the microphone only inside the tap
// that asks for them. A desktop browser does not enforce this, so the order is
// pinned here: both calls happen before acquire() returns, element first.

describe('acquire', () => {
  const log: string[] = []
  let originalPlay: typeof HTMLMediaElement.prototype.play
  let originalMediaDevices: PropertyDescriptor | undefined

  beforeEach(() => {
    log.length = 0
    resetDevicesForTest()
    originalPlay = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = vi.fn(() => {
      log.push('play')
      return Promise.resolve()
    })
    originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(() => {
          log.push('getUserMedia')
          return new Promise<MediaStream>(() => {})
        }),
      },
    })
  })

  afterEach(() => {
    resetDevicesForTest()
    HTMLMediaElement.prototype.play = originalPlay
    if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
    else delete (navigator as unknown as Record<string, unknown>).mediaDevices
  })

  it("plays the audio element and then calls getUserMedia, both before acquire returns", () => {
    void acquire()
    expect(log).toEqual(['play', 'getUserMedia'])
  })
})
