import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./settings.css?inline', () => ({ default: '.dsh-voice-settings {}' }))
// dsh hands the page its React; the stylesheet only needs createContext to load.
vi.mock('react', () => ({ createContext: () => ({}) }))
const { ensureStyles, removeStyles } = await import('./settings-style')

/** A document holding elements by id, enough for the stylesheet's add and remove. */
function fakeDocument() {
  const byId = new Map<string, { id: string; textContent: string; remove(): void }>()
  return {
    byId,
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: () => {
      const element = { id: '', textContent: '', remove: () => { byId.delete(element.id) } }
      return element
    },
    head: { appendChild: (element: { id: string; textContent: string; remove(): void }) => { byId.set(element.id, element) } },
  }
}

let doc: ReturnType<typeof fakeDocument>
beforeEach(() => {
  doc = fakeDocument()
  vi.stubGlobal('document', doc)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('settings stylesheet', () => {
  it('is added once however often the card mounts', () => {
    ensureStyles()
    ensureStyles()
    expect(doc.byId.size).toBe(1)
  })

  it('leaves the page when the plugin unloads, so a reloaded plugin adds its own', () => {
    ensureStyles()
    removeStyles()
    expect(doc.byId.size).toBe(0)
  })

  it('removing with none on the page does nothing', () => {
    expect(() => { removeStyles() }).not.toThrow()
  })
})
