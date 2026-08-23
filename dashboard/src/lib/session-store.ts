import type { GatewayConnection } from './gateway-connection'
import { Session } from './session'

export class SessionStore {
  private sessions = new Map<string, Session>()

  getOrCreate(sessionKey: string, connection: GatewayConnection): Session {
    let session = this.sessions.get(sessionKey)
    if (!session) {
      session = new Session(sessionKey, connection)
      this.sessions.set(sessionKey, session)
    }
    return session
  }

  get(sessionKey: string): Session | undefined {
    return this.sessions.get(sessionKey)
  }
}
