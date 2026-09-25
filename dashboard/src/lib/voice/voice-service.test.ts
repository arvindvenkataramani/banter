import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServiceWithHealth } from '@platform/shared'

const getService = vi.fn()
const startService = vi.fn()

vi.mock('@/lib/api', () => ({
  getService: (id: string) => getService(id),
  startService: (id: string) => startService(id),
}))

const { ensureServiceReady } = await import('./voice-service')

function service(overrides: Partial<ServiceWithHealth> = {}): ServiceWithHealth {
  return {
    id: 'stt',
    capabilityId: 'stt',
    hostId: 'host1',
    permissions: { enabled: true },
    runner: { type: 'process', main: 'server' },
    network: { port: 8767, healthPath: '/healthz', endpoint: 'https://host1:8767' },
    health: 'healthy',
    lastEvent: null,
    ...overrides,
  } as ServiceWithHealth
}

beforeEach(() => {
  getService.mockReset()
  startService.mockReset()
})

describe('ensureServiceReady', () => {
  it('returns the endpoint of a healthy service without starting it', async () => {
    getService.mockResolvedValue(service())

    expect(await ensureServiceReady('stt')).toBe('https://host1:8767')
    expect(startService).not.toHaveBeenCalled()
  })

  it('starts a service that is not healthy, then re-reads it', async () => {
    getService
      .mockResolvedValueOnce(service({ health: 'down', network: { port: 8767, healthPath: '/healthz' } }))
      .mockResolvedValueOnce(service())
    startService.mockResolvedValue({ success: true })

    expect(await ensureServiceReady('stt')).toBe('https://host1:8767')
    expect(startService).toHaveBeenCalledWith('stt')
  })

  it('does not try to start an external service, whose lifecycle the platform does not own', async () => {
    getService.mockResolvedValue(service({ health: 'unknown', runner: { type: 'external' } }))

    expect(await ensureServiceReady('stt')).toBe('https://host1:8767')
    expect(startService).not.toHaveBeenCalled()
  })

  it('surfaces the reason a start failed rather than discarding it', async () => {
    getService.mockResolvedValue(service({ health: 'down' }))
    startService.mockResolvedValue({ success: false, error: 'unit is masked' })

    await expect(ensureServiceReady('stt')).rejects.toThrow('unit is masked')
  })

  it('reports a failed start that gives no reason', async () => {
    getService.mockResolvedValue(service({ health: 'down' }))
    startService.mockResolvedValue({ success: false })

    await expect(ensureServiceReady('stt')).rejects.toThrow('could not be started')
  })

  it('throws when a healthy service has no endpoint to talk to', async () => {
    getService.mockResolvedValue(service({ network: { port: 8767, healthPath: '/healthz' } }))

    await expect(ensureServiceReady('stt')).rejects.toThrow('has no endpoint')
  })
})

describe('waiting for a start to finish', () => {
  it('waits while the operation is pending, then returns the service it left healthy', async () => {
    getService
      .mockResolvedValueOnce(service({ health: 'down' }))
      .mockResolvedValueOnce(service({ health: 'down', pending: true }))
      .mockResolvedValueOnce(service({ health: 'down', pending: true }))
      .mockResolvedValueOnce(service({ health: 'healthy', pending: false }))
    startService.mockResolvedValue({ success: true })

    expect(await ensureServiceReady('stt')).toBe('https://host1:8767')
    expect(getService).toHaveBeenCalledTimes(4)
  })

  // Health reached healthy before the operation settled — the platform is still
  // working on the service, so the endpoint is not handed back until it stops.
  it('keeps waiting on a service that reads healthy while the operation is outstanding', async () => {
    getService
      .mockResolvedValueOnce(service({ health: 'down' }))
      .mockResolvedValueOnce(service({ health: 'healthy', pending: true }))
      .mockResolvedValueOnce(service({ health: 'healthy', pending: false }))
    startService.mockResolvedValue({ success: true })

    expect(await ensureServiceReady('stt')).toBe('https://host1:8767')
    expect(getService).toHaveBeenCalledTimes(3)
  })

  it('reports the service unavailable when the operation finishes without it coming up', async () => {
    getService
      .mockResolvedValueOnce(service({ health: 'down' }))
      .mockResolvedValueOnce(service({ health: 'down', pending: true }))
      .mockResolvedValueOnce(service({
        health: 'down',
        pending: false,
        lastEvent: { data: { error: 'port already in use' } } as never,
      }))
    startService.mockResolvedValue({ success: true })

    await expect(ensureServiceReady('stt')).rejects.toThrow('port already in use')
  })

  // Nothing bounds the wait on the client side, so an absent field must end it.
  it('stops waiting when the server sends no pending field at all', async () => {
    getService
      .mockResolvedValueOnce(service({ health: 'down' }))
      .mockResolvedValueOnce(service({ health: 'down' }))
    startService.mockResolvedValue({ success: true })

    await expect(ensureServiceReady('stt')).rejects.toThrow('is not available')
    expect(getService).toHaveBeenCalledTimes(2)
  })

  // A start can succeed and be undone before the next read — idle eviction, another
  // client, a health sweep. The service is unusable either way, so the caller fails;
  // the message says the service is unavailable rather than naming a failed start.
  it('reports an unusable service without claiming the start itself failed', async () => {
    getService
      .mockResolvedValueOnce(service({ health: 'down' }))
      .mockResolvedValueOnce(service({
        health: 'down',
        pending: false,
        lastEvent: { data: { error: 'evicted while idle' } } as never,
      }))
    startService.mockResolvedValue({ success: true })

    await expect(ensureServiceReady('stt')).rejects.toThrow(
      'Service "stt" is not available: evicted while idle'
    )
  })
})

// A read that fails says nothing about the start it was asking after. The
// control plane answers 503 while it cannot reach the shard, and a spawn is
// exactly when that happens, so a wait that gave up on the first one would
// blame the service for its own inability to ask.
describe('waiting through a control plane that cannot answer', () => {
  it('keeps polling across a failed read and returns the service once it answers', async () => {
    getService
      .mockResolvedValueOnce(service({ health: 'down' }))
      .mockRejectedValueOnce(new Error('shard unreachable: timeout'))
      .mockRejectedValueOnce(new Error('shard unreachable: timeout'))
      .mockResolvedValueOnce(service({ health: 'down', pending: true }))
      .mockResolvedValueOnce(service({ health: 'healthy', pending: false }))
    startService.mockResolvedValue({ success: true })

    expect(await ensureServiceReady('stt')).toBe('https://host1:8767')
    expect(getService).toHaveBeenCalledTimes(5)
  })

  it('blames the transport, not the service, when contact is never regained', async () => {
    vi.useFakeTimers()
    try {
      getService
        .mockResolvedValueOnce(service({ health: 'down' }))
        .mockRejectedValue(new Error('shard unreachable: timeout'))
      startService.mockResolvedValue({ success: true })

      const pending = ensureServiceReady('stt')
      const assertion = expect(pending).rejects.toThrow('Lost contact while starting "stt"')
      await vi.advanceTimersByTimeAsync(60_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  // The grace period covers a gap in contact, not a service that answers and
  // says it is done — an answered read still ends the wait immediately.
  it('does not let the grace period delay a service that answers', async () => {
    getService
      .mockResolvedValueOnce(service({ health: 'down' }))
      .mockRejectedValueOnce(new Error('shard unreachable: timeout'))
      .mockResolvedValueOnce(service({ health: 'healthy', pending: false }))
    startService.mockResolvedValue({ success: true })

    expect(await ensureServiceReady('stt')).toBe('https://host1:8767')
    expect(getService).toHaveBeenCalledTimes(3)
  })
})
