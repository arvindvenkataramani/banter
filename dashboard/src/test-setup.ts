// Node 26 exposes a built-in `localStorage` that stays undefined unless the
// process was started with --localstorage-file, and it takes precedence over
// the one jsdom would otherwise install. Tests that touch storage therefore see
// `localStorage === undefined` even under environment: 'jsdom'.
//
// Install a minimal in-memory Storage on the globals when none is usable, so
// each test file gets its own isolated store. Only fills a gap; if a real
// implementation is present, it is left alone.
function makeStorage(): Storage {
  let store = new Map<string, string>()
  return {
    get length() { return store.size },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(String(k)) ?? null,
    setItem: (k: string, v: string) => { store.set(String(k), String(v)) },
    removeItem: (k: string) => { store.delete(String(k)) },
    clear: () => { store = new Map() },
  } as Storage
}

function ensure(name: 'localStorage' | 'sessionStorage') {
  let usable = false
  try {
    const existing = (globalThis as Record<string, unknown>)[name] as Storage | undefined
    usable = !!existing && typeof existing.clear === 'function'
  } catch {
    usable = false
  }
  if (usable) return
  const storage = makeStorage()
  for (const target of [globalThis, typeof window !== 'undefined' ? window : undefined]) {
    if (!target) continue
    Object.defineProperty(target, name, { value: storage, configurable: true, writable: true })
  }
}

ensure('localStorage')
ensure('sessionStorage')
