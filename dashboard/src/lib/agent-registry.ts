import type { AgentEntry } from './gateway-types'

export class AgentRegistry {
  private agents: AgentEntry[] = []
  private defaultId: string | null = null

  populate(agents: AgentEntry[], defaultId?: string) {
    this.agents = agents
    this.defaultId = defaultId ?? null
  }

  list(): AgentEntry[] {
    return this.agents
  }

  getDefault(): AgentEntry | undefined {
    if (this.defaultId) {
      const found = this.agents.find((a) => a.id === this.defaultId)
      if (found) return found
    }
    return this.agents.find((a) => a.default) ?? this.agents[0]
  }
}
