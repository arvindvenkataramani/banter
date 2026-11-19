// A value with subscribers, in the shape React's useSyncExternalStore reads.

export interface Value<T> {
  get(): T
  set(next: T): void
  subscribe(listener: () => void): () => void
}

export function createValue<T>(initial: T): Value<T> {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set(next) {
      if (Object.is(next, current)) return
      current = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
