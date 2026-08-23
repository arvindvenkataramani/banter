import { describe, expect, test, vi } from 'vitest'
import { SessionManager } from './session-manager'
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
