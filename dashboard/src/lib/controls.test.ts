import { describe, expect, test, vi } from 'vitest'
import { Session } from './session'
import { SessionControls, ANNOTATIONS, registerAudioHalter } from './controls'
import { normalizeAgentEvent, type RunEvent } from './run-state'
import type { GatewayConnection } from './gateway-connection'

const SESSION_KEY = 'agent:example:probe'
const RUN_ID = 'run-1'
const lifecycleStart = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'lifecycle', data: { phase: 'start', startedAt: 1 } }
const lifecycleEnd = { runId: RUN_ID, sessionKey: SESSION_KEY, stream: 'lifecycle', data: { phase: 'end', stopReason: 'abort', aborted: true } }

function createFakeConnection(opts?: { sendResult?: 'resolve' | 'reject'; onAbort?: () => void }) {
  return {
    call: vi.fn((method: string) => {
      if (method === 'chat.abort') {
        opts?.onAbort?.()
        return Promise.resolve({})
      }
      if (method === 'chat.send') {
        return opts?.sendResult === 'reject' ? Promise.reject(new Error('send failed')) : Promise.resolve({})
      }
      return Promise.resolve({})
    }),
  } as unknown as GatewayConnection
}

describe('SessionControls: idle send', () => {
  test('sends immediately when no run is active, no abort involved', async () => {
    const connection = createFakeConnection()
    const session = new Session(SESSION_KEY, connection)
    const controls = new SessionControls(session)

    await controls.send('hello')

    expect(connection.call).not.toHaveBeenCalledWith('chat.abort', expect.anything())
    expect(connection.call).toHaveBeenCalledWith('chat.send', expect.objectContaining({ message: 'hello' }))
  })
})

describe('SessionControls: abort-then-send', () => {
  test('mid-run send aborts first, waits for the run to actually end, then sends', async () => {
    const session = new Session(SESSION_KEY, createFakeConnection())
    // Swap in a connection whose chat.abort triggers the run-ending event, as
    // the real gateway would shortly after an abort request.
    const connection = createFakeConnection({
      onAbort: () => { session.conversation.ingest(normalizeAgentEvent(lifecycleEnd, 2) as RunEvent) },
    })
    ;(session as unknown as { connection: GatewayConnection }).connection = connection
    session.conversation.ingest(normalizeAgentEvent(lifecycleStart, 1) as RunEvent)
    expect(session.conversation.getSnapshot().runActive).toBe(true)

    const controls = new SessionControls(session)
    await controls.send('stop and do this instead')

    const calls = vi.mocked(connection.call).mock.calls.map((c) => c[0])
    expect(calls.indexOf('chat.abort')).toBeLessThan(calls.indexOf('chat.send'))
    expect(session.conversation.getSnapshot().runActive).toBe(false)
  })

  test('sends anyway after the 5s wait bound if the run never confirms ending', async () => {
    vi.useFakeTimers()
    try {
      const connection = createFakeConnection() // chat.abort never actually ends the run
      const session = new Session(SESSION_KEY, connection)
      session.conversation.ingest(normalizeAgentEvent(lifecycleStart, 1) as RunEvent)

      const controls = new SessionControls(session)
      const sendPromise = controls.send('send me anyway')
      await vi.advanceTimersByTimeAsync(5000)
      await sendPromise

      expect(connection.call).toHaveBeenCalledWith('chat.send', expect.objectContaining({ message: 'send me anyway' }))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SessionControls: annotation prefixing', () => {
  test('prepends the annotation text to both the conversation item and the sent message', async () => {
    const connection = createFakeConnection()
    const session = new Session(SESSION_KEY, connection)
    const controls = new SessionControls(session)

    await controls.send('carry on', { annotation: 'interrupted-speaking' })

    const expected = `${ANNOTATIONS['interrupted-speaking']} carry on`
    expect(connection.call).toHaveBeenCalledWith('chat.send', expect.objectContaining({ message: expected }))
    const item = session.conversation.getSnapshot().items.find((i) => i.kind === 'user-message')
    expect(item && (item as { text: string }).text).toBe(expected)
  })
})

describe('SessionControls: delivery transitions', () => {
  test('a successful send settles delivery to confirmed', async () => {
    const connection = createFakeConnection()
    const session = new Session(SESSION_KEY, connection)
    const controls = new SessionControls(session)

    await controls.send('will succeed')
    const item = session.conversation.getSnapshot().items.find((i) => i.kind === 'user-message')
    expect(item && (item as { delivery?: string }).delivery).toBe('confirmed')
  })

  test('a failed send settles delivery to failed and sets the conversation error, item stays in place', async () => {
    const connection = createFakeConnection({ sendResult: 'reject' })
    const session = new Session(SESSION_KEY, connection)
    const controls = new SessionControls(session)

    await expect(controls.send('will fail')).rejects.toThrow()
    const items = session.conversation.getSnapshot().items.filter((i) => i.kind === 'user-message')
    expect(items.length).toBe(1) // no content movement — same item, not duplicated or removed
    expect((items[0] as { delivery?: string }).delivery).toBe('failed')
    expect(session.conversation.getSnapshot().error).toBeTruthy()
  })
})

describe('SessionControls: resend', () => {
  test('resend flips the same item back to pending and re-runs the send policy', async () => {
    const connection = createFakeConnection({ sendResult: 'reject' })
    const session = new Session(SESSION_KEY, connection)
    const controls = new SessionControls(session)
    await expect(controls.send('retry me')).rejects.toThrow()
    const id = session.conversation.getSnapshot().items.find((i) => i.kind === 'user-message')!.id

    // Fix the connection so the resend succeeds this time.
    ;(session as unknown as { connection: GatewayConnection }).connection = createFakeConnection()
    await controls.resend(id)

    const items = session.conversation.getSnapshot().items.filter((i) => i.kind === 'user-message')
    expect(items.length).toBe(1)
    expect((items[0] as { delivery?: string }).delivery).toBe('confirmed')
    expect((items[0] as { text: string }).text).toBe('retry me')
  })

  test('resend of an unknown item id is a no-op, never throws', async () => {
    const session = new Session(SESSION_KEY, createFakeConnection())
    const controls = new SessionControls(session)
    await expect(controls.resend('nonexistent')).resolves.toBeUndefined()
  })
})

describe('SessionControls: stop', () => {
  test('fires registered audio halters synchronously before the abort RPC resolves', async () => {
    const order: string[] = []
    const connection = {
      call: vi.fn((method: string) => {
        // Records on RESOLUTION (a microtask later), not dispatch — dispatch
        // itself is synchronous (like a real ws.send()), so it can't be
        // distinguished from the halter call without modeling resolution as
        // a separate later event.
        return Promise.resolve({}).then(() => { order.push(`rpc:${method}`); return {} })
      }),
    } as unknown as GatewayConnection
    const session = new Session(SESSION_KEY, connection)
    const controls = new SessionControls(session)

    const unregister = registerAudioHalter(() => order.push('halt'))
    const stopPromise = controls.stop()
    // The halter must have fired before the abort RPC resolves (a stop
    // control that keeps talking for half a second feels broken).
    expect(order).toEqual(['halt'])
    await stopPromise
    expect(order).toEqual(['halt', 'rpc:chat.abort'])
    unregister()
  })

  test('unregistering a halter stops it from firing on future stops', async () => {
    const session = new Session(SESSION_KEY, createFakeConnection())
    const controls = new SessionControls(session)
    const fired: boolean[] = []
    const unregister = registerAudioHalter(() => fired.push(true))
    unregister()
    await controls.stop()
    expect(fired).toEqual([])
  })
})
