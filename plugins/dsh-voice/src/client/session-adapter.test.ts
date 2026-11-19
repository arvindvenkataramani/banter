import { describe, expect, it, vi } from 'vitest'
import type { DshEventWindow, DshRemoteResult, DshSessionLike } from './dsh-types'
import { createVoiceSession } from './session-adapter'

const accepted: DshRemoteResult<{ accepted: true }> = { ok: true, value: { accepted: true } }
const refused: DshRemoteResult<{ accepted: true }> = { ok: false, error: 'refused' }

// Spec section 2: DshSessionLike is the session face (prompt, cancel) plus the binding's eventSource, flattened into one object. The cast stands in for the field dsh-types.ts does not declare yet.
function fakeSession(prompt: DshSessionLike['prompt'], cancel: DshSessionLike['cancel']): DshSessionLike {
  const window: DshEventWindow = { entries: [], hasMore: false, revision: 1, change: { kind: 'replace', entries: [] } }
  const session = {
    sessionId: 'session-1',
    prompt,
    cancel,
    eventSource: { getSnapshot: () => window, subscribe: () => () => {} },
  }
  return session as DshSessionLike
}

function setup(opts: { prompt?: DshSessionLike['prompt']; cancel?: DshSessionLike['cancel'] } = {}) {
  const prompt = vi.fn(opts.prompt ?? (async () => accepted))
  const cancel = vi.fn(opts.cancel ?? (async () => accepted))
  const deps = { haltAudio: vi.fn(), clearDraft: vi.fn() }
  const voiceSession = createVoiceSession(fakeSession(prompt, cancel), deps)
  return { voiceSession, prompt, cancel, deps }
}

describe('session adapter writing', () => {
  it('send prompts the session with one text part in queue mode', async () => {
    const { voiceSession, prompt } = setup()
    await voiceSession.controls.send('hello there')
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello there' }], 'queue')
    voiceSession.dispose()
  })

  it('an annotation prefixes the text exactly as the dashboard does', async () => {
    const { voiceSession, prompt } = setup()
    await voiceSession.controls.send('wait', { annotation: 'interrupted-speaking' })
    await voiceSession.controls.send('wait', { annotation: 'interrupted-working' })
    expect(prompt.mock.calls.map(call => call[0])).toEqual([
      [{ type: 'text', text: '[[note: interrupted you while you were speaking]] wait' }],
      [{ type: 'text', text: '[[note: interrupted you while you were working]] wait' }],
    ])
    voiceSession.dispose()
  })

  it('the text box is emptied after the prompt succeeds, not before', async () => {
    let finish!: (r: DshRemoteResult<{ accepted: true }>) => void
    const { voiceSession, deps } = setup({ prompt: () => new Promise(resolve => { finish = resolve }) })
    const sending = voiceSession.controls.send('hello')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(deps.clearDraft).not.toHaveBeenCalled()
    finish(accepted)
    await sending
    expect(deps.clearDraft).toHaveBeenCalledTimes(1)
    voiceSession.dispose()
  })

  it('a refused prompt rejects the send and leaves the text box alone', async () => {
    const { voiceSession, deps } = setup({ prompt: async () => refused })
    let rejected = false
    await voiceSession.controls.send('hello').catch(() => { rejected = true })
    expect(rejected).toBe(true)
    expect(deps.clearDraft).not.toHaveBeenCalled()
    voiceSession.dispose()
  })

  it('abort halts audio before it cancels the turn, and audio is halted while the cancel is still pending', async () => {
    const order: string[] = []
    let finish!: (r: DshRemoteResult<{ accepted: true }>) => void
    const { voiceSession, deps, cancel } = setup({
      cancel: () => {
        order.push('cancel')
        return new Promise(resolve => { finish = resolve })
      },
    })
    deps.haltAudio.mockImplementation(() => { order.push('halt') })

    const aborting = voiceSession.controls.abort()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).toEqual(['halt', 'cancel'])
    expect(cancel).toHaveBeenCalledTimes(1)
    finish(accepted)
    await aborting
    voiceSession.dispose()
  })
})
