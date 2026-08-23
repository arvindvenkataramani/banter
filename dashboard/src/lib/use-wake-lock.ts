import { useEffect, useRef, useState, useCallback } from 'react'

interface WakeLockSentinel {
  released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}

interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinel>
}

/**
 * Holds a screen wake lock while `active` is true. Re-acquires the lock when
 * the page becomes visible again (iOS releases wake locks on tab/screen blur).
 */
export function useWakeLock(active: boolean): { supported: boolean; held: boolean } {
  const sentinelRef = useRef<WakeLockSentinel | null>(null)
  const [held, setHeld] = useState(false)

  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator

  const acquire = useCallback(async () => {
    if (!supported) return
    try {
      const wl = (navigator as unknown as { wakeLock: WakeLockApi }).wakeLock
      const sentinel = await wl.request('screen')
      sentinelRef.current = sentinel
      setHeld(true)
      sentinel.addEventListener('release', () => {
        if (sentinelRef.current === sentinel) {
          sentinelRef.current = null
          setHeld(false)
        }
      })
    } catch (err) {
      console.warn('[wake-lock] acquire failed:', err)
      setHeld(false)
    }
  }, [supported])

  const release = useCallback(async () => {
    const sentinel = sentinelRef.current
    sentinelRef.current = null
    setHeld(false)
    if (sentinel && !sentinel.released) {
      try { await sentinel.release() } catch { /* noop */ }
    }
  }, [])

  useEffect(() => {
    if (active) {
      // acquire() is async: every setHeld inside it runs after the wakeLock
      // request resolves, so nothing here updates state during the effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      acquire()
      const onVisibility = () => {
        if (document.visibilityState === 'visible' && active && !sentinelRef.current) {
          acquire()
        }
      }
      document.addEventListener('visibilitychange', onVisibility)
      return () => {
        document.removeEventListener('visibilitychange', onVisibility)
        release()
      }
    } else {
      release()
    }
  }, [active, acquire, release])

  return { supported, held }
}
