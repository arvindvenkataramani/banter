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
