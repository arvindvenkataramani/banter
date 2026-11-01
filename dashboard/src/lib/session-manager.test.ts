import { describe, expect, test, vi } from 'vitest'
import { SessionManager, displayedModel } from './session-manager'
import type { GatewayConnection } from './gateway-connection'

// A fake connection exercising SessionManager's reconnect-projection contract
// without a real WebSocket. Reconnect is a new projection over durable
// history, not a resumption of in-memory state — these tests exist because
// the old onReconnected silently never re-issued sessions.messages.subscribe.
function createFakeConnection() {
  const calls: Array<{ method: string; params: unknown }> = []
  const historyRows = [{ role: 'user', content: 'seeded from history', __openclaw: { id: 'h1' } }]

  const fake = {
    calls,
    onReconnected: null as (() => void) | null,
    onSessionsChanged: null as (() => void) | null,
    call: vi.fn((method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'agents.list') return Promise.resolve({ agents: [{ id: 'main' }], defaultId: 'main' })
      if (method === 'models.list') return Promise.resolve({ models: [] })
      if (method === 'sessions.list') return Promise.resolve({ sessions: [] })
      if (method === 'chat.history') return Promise.resolve({ messages: historyRows, hasMore: false })
      return Promise.resolve({})
    }),
    addEventListener: vi.fn(() => () => {}),
    addAgentEventListener: vi.fn(() => () => {}),
    addSessionToolListener: vi.fn(() => () => {}),
  }
  return fake as unknown as GatewayConnection & typeof fake
}

describe('SessionManager: reconnect projection', () => {
  test('onReconnected re-issues sessions.messages.subscribe for the active session (the previously-missing re-subscribe)', async () => {
    const connection = createFakeConnection()
    const manager = new SessionManager(connection, 'main', 'main')
    await manager.initialize()

    connection.calls.length = 0 // clear init-time calls, isolate what reconnect specifically does
    connection.onReconnected?.()
    await Promise.resolve()
    await Promise.resolve()

    const resub = connection.calls.find((c) => c.method === 'sessions.messages.subscribe')
    expect(resub).toBeDefined()
    expect((resub?.params as { key?: string })?.key).toBe('agent:main:main')
  })

  test('onReconnected resets the conversation before reloading history (no stale live-run residue survives a reconnect)', async () => {
    const connection = createFakeConnection()
    const manager = new SessionManager(connection, 'main', 'main')
    await manager.initialize()

    const session = manager.getSnapshot().activeSession!
    // Pollute the conversation as if a run was mid-flight when the connection dropped.
    session.conversation.addUserMessage('will not survive reconnect')
    expect(session.conversation.getSnapshot().items.length).toBeGreaterThan(0)

    connection.onReconnected?.()
    await Promise.resolve()
    await Promise.resolve()

    const items = session.conversation.getSnapshot().items
    // reset() wipes it, then loadHistory()'s seed() replaces it with the fake's history rows —
    // the polluted pending message must not be among them.
    expect(items.some((i) => i.kind === 'user-message' && i.text === 'will not survive reconnect')).toBe(false)
  })

  test('onReconnected still re-subscribes sessions.changed and refreshes session keys (unchanged prior behavior)', async () => {
    const connection = createFakeConnection()
    const manager = new SessionManager(connection, 'main', 'main')
    await manager.initialize()

    connection.calls.length = 0
    connection.onReconnected?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(connection.calls.some((c) => c.method === 'sessions.subscribe')).toBe(true)
    expect(connection.calls.some((c) => c.method === 'sessions.list')).toBe(true)
  })
})

describe('displayedModel', () => {
  const base = { key: 'agent:main:main', kind: 'direct' as const, updatedAt: 0, modelProvider: 'lmstudio', model: 'qwen' }
  const fellBack = { ...base, activeModelProvider: 'lmstudio', activeModel: 'gemma', endedAt: 200 }

  test.each([
    ['no fallback, no switch', base, null, 'lmstudio/qwen'],
    ['fallback, no switch since opening', fellBack, null, 'lmstudio/gemma'],
    ['fallback ran after the switch', fellBack, 100, 'lmstudio/gemma'],
    ['fallback ran before the switch', fellBack, 300, 'lmstudio/qwen'],
    ['fallback ended at the switch instant', fellBack, 200, 'lmstudio/qwen'],
    ['activeModel null', { ...base, activeModel: null, endedAt: 200 }, null, 'lmstudio/qwen'],
    ['no provider', { ...base, modelProvider: undefined }, null, 'qwen'],
    ['no model at all', { ...base, model: undefined }, null, null],
  ])('%s', (_name, row, selectedAt, expected) => {
    expect(displayedModel(row, selectedAt)).toBe(expected)
  })
})

describe('SessionManager: context usage after a run', () => {
  test('a row still showing the run as active is read again until the run has closed', async () => {
    vi.useFakeTimers()
    try {
      const connection = createFakeConnection()
      const manager = new SessionManager(connection, 'main', 'main')
      await manager.initialize()

      const rows = [
        { key: 'agent:main:main', kind: 'direct', updatedAt: 0, hasActiveRun: true, totalTokens: 100, contextTokens: 1000 },
        { key: 'agent:main:main', kind: 'direct', updatedAt: 0, hasActiveRun: false, totalTokens: 250, contextTokens: 1000 },
      ]
      connection.call.mockImplementation((method: string) => {
        if (method === 'sessions.list') return Promise.resolve({ sessions: [rows.length > 1 ? rows.shift() : rows[0]] })
        return Promise.resolve({})
      })

      manager.getSnapshot().activeSession?.onRunComplete?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.getSnapshot().contextTokens).toBe(100)

      await vi.advanceTimersByTimeAsync(1000)
      expect(manager.getSnapshot().contextTokens).toBe(250)

      const listCalls = connection.call.mock.calls.filter(([m]) => m === 'sessions.list').length
      await vi.advanceTimersByTimeAsync(10_000)
      expect(connection.call.mock.calls.filter(([m]) => m === 'sessions.list').length).toBe(listCalls)
    } finally {
      vi.useRealTimers()
    }
  })
})
