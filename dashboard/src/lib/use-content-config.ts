import { useEffect, useState } from 'react'

export interface ContentConfig {
  presentation: {
    recencyFadeDays: number
  }
  links: {
    vaultName: string
    /** Projects directory, vault-relative, no trailing slash. */
    projectsDir: string
  }
  /** Server's configured IANA timezone, for computing the same date key the
   *  control plane uses (shared/pick.ts). Undefined until the fetch below
   *  resolves, or if the server has none configured — callers fall back to
   *  the browser's own local timezone. */
  timezone?: string
}

const DEFAULT: ContentConfig = {
  presentation: { recencyFadeDays: 21 },
  links: { vaultName: 'vault', projectsDir: 'projects' },
}

export function useContentConfig(): ContentConfig {
  const [config, setConfig] = useState<ContentConfig>(DEFAULT)

  useEffect(() => {
    fetch('/api/content')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((data: ContentConfig) => setConfig(data))
      .catch(() => {/* keep default */ })
  }, [])

  return config
}
