import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ConnectionState } from './gateway-types'
import type { GatewayConfig } from './use-session-manager'
import { GatewayConnection } from './gateway-connection'

interface GatewayContextValue {
  connection: GatewayConnection | null
  state: ConnectionState
  config: GatewayConfig | null
  reconnect: () => void
}

const GatewayContext = createContext<GatewayContextValue>({
  connection: null,
  state: 'disconnected',
  config: null,
  reconnect: () => {},
})

// Provider and its consumer hook belong in one file; splitting them to satisfy
// fast refresh would buy nothing but an extra module.
// eslint-disable-next-line react-refresh/only-export-components
export function useGateway(): GatewayContextValue {
  return useContext(GatewayContext)
}

export function GatewayProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<GatewayConfig | null>(null)
  const [state, setState] = useState<ConnectionState>('disconnected')

  useEffect(() => {
    fetch('/api/gateway')
      .then((res) => {
        if (!res.ok) throw new Error('Gateway not configured')
        return res.json() as Promise<GatewayConfig>
      })
      .then(setConfig)
      .catch(() => {})
  }, [])

  // The connection is derived from the gateway config rather than held in
  // state: creating it during render keeps consumers from waiting an extra
  // commit for it to appear, and the effect below owns only its lifecycle.
  const url = config?.url
  const token = config?.token
  const connection = useMemo(() => {
    if (!url || !token) return null
    return new GatewayConnection({ url, token, onStateChange: setState })
  }, [url, token])

  useEffect(() => {
    if (!connection) return
    connection.connect()
    return () => connection.disconnect()
  }, [connection])

  function reconnect() {
    connection?.reconnect()
  }

  return (
    <GatewayContext.Provider value={{ connection, state, config, reconnect }}>
      {children}
    </GatewayContext.Provider>
  )
}
