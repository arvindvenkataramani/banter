import { describe, expect, test, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ConnectionState } from './gateway-types'

// Connection state leaving 'connected' means ground truth is stale until the
// next reconnect projection — surfaces should show "unknown" (Conversation.
// markUnknown), not silently keep the last state. No gateway-connection.ts
// change was needed: onStateChange is a single private callback already
// claimed by gateway-context.tsx, so this observes connectionState (which
// the hook already receives from useGateway()) directly instead.

const historyRows = [{ role: 'user', content: 'hi', __openclaw: { id: 'h1' } }]

function createFakeConnection() {
  return {
    onReconnected: null as (() => void) | null,
    onSessionsChanged: null as (() => void) | null,
    call: vi.fn((method: string) => {
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
}

let mockConnection = createFakeConnection()
let mockState: ConnectionState = 'connected'

vi.mock('./gateway-context', () => ({
  useGateway: () => ({
    connection: mockConnection,
    state: mockState,
    config: { url: 'ws://fake', token: 'fake' },
    reconnect: () => {},
  }),
}))

// Imported after the mock so the mocked module is what useSessionManager sees.
const { useSessionManager } = await import('./use-session-manager')

describe('useSessionManager: connection state leaving connected', () => {
  test('marks the active session\'s conversation unknown when state transitions away from connected', async () => {
    mockConnection = createFakeConnection()
    mockState = 'connected'
    const { result, rerender } = renderHook(() => useSessionManager())

    await waitFor(() => expect(result.current.activeSession).not.toBeNull())
    const session = result.current.activeSession!
    expect(session.conversation.getSnapshot().known).toBe(true)

    mockState = 'reconnecting'
    rerender()

    await waitFor(() => expect(session.conversation.getSnapshot().known).toBe(false))
  })

  test('does not mark unknown while state stays connected', async () => {
    mockConnection = createFakeConnection()
    mockState = 'connected'
    const { result, rerender } = renderHook(() => useSessionManager())

    await waitFor(() => expect(result.current.activeSession).not.toBeNull())
    const session = result.current.activeSession!

    rerender()
    expect(session.conversation.getSnapshot().known).toBe(true)
  })
})
