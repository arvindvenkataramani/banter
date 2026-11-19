import { describe, expect, it, vi } from 'vitest'
import { followShownSession } from './presence'

// INVENTED: `shown` is the observable shape dsh's client stores share (DshObservable in dsh-types.ts: getSnapshot, subscribe) holding `{ sessionId, panelOpen }`, and `isLive` is a function returning a boolean, as `keepOnOutside` is in the spec's table. Transitions follow the spike: leaving a conversation keeps the sessionId and sets panelOpen, a session switch changes the sessionId with panelOpen false.
function setup(opts: { live: boolean; keepOnOutside: boolean }) {
  let snapshot = { sessionId: 'session-1', panelOpen: false }
  const listeners = new Set<() => void>()
  const shown = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const state = { ...opts }
  const attach = vi.fn()
  const voiceOff = vi.fn()
  const dispose = followShownSession({ shown, keepOnOutside: () => state.keepOnOutside, isLive: () => state.live, attach, voiceOff })
  return {
    state,
    attach,
    voiceOff,
    dispose,
    show(next: { sessionId: string; panelOpen: boolean }) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('session follow', () => {
  it('a live system re-attaches to the session the person opens, and a system that is not live is left alone', () => {
    const h = setup({ live: false, keepOnOutside: false })
    h.show({ sessionId: 'session-2', panelOpen: false })
    expect(h.attach).not.toHaveBeenCalled()

    h.state.live = true
    h.show({ sessionId: 'session-3', panelOpen: false })
    expect(h.attach).toHaveBeenLastCalledWith('session-3')
    h.show({ sessionId: 'session-1', panelOpen: false })
    expect(h.attach).toHaveBeenLastCalledWith('session-1')

    h.dispose()
    h.attach.mockClear()
    h.show({ sessionId: 'session-2', panelOpen: false })
    expect(h.attach).not.toHaveBeenCalled()
  })
})

describe('leaving the conversation', () => {
  it('with the setting off, a view with no composer turns voice off', () => {
    const h = setup({ live: true, keepOnOutside: false })
    h.show({ sessionId: 'session-1', panelOpen: true })
    expect(h.voiceOff).toHaveBeenCalledTimes(1)
  })

  it('with the setting on, voice keeps running outside a conversation', () => {
    const h = setup({ live: true, keepOnOutside: true })
    h.show({ sessionId: 'session-1', panelOpen: true })
    expect(h.voiceOff).not.toHaveBeenCalled()
  })

  it('the setting is read when the person leaves, not when following starts', () => {
    const h = setup({ live: true, keepOnOutside: true })
    h.state.keepOnOutside = false
    h.show({ sessionId: 'session-1', panelOpen: true })
    expect(h.voiceOff).toHaveBeenCalledTimes(1)
  })

  it('a session switch never turns voice off, with the setting off', () => {
    const h = setup({ live: true, keepOnOutside: false })
    h.show({ sessionId: 'session-2', panelOpen: false })
    h.show({ sessionId: 'session-3', panelOpen: false })
    expect(h.voiceOff).not.toHaveBeenCalled()
    expect(h.attach).toHaveBeenLastCalledWith('session-3')
  })
})
