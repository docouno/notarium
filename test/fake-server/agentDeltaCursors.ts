import type { AgentDeltaCursorScope, AgentDeltaCursorsPersistence } from '@notarium/server'

const key = (left: string, project: string): string => `${left}\0${project}`

/** In-memory executable twin of the owner/session cursor facet. Map.has is
 * load-bearing: a stored null freezes "from the beginning" independently from
 * a fallback that advances later. */
export class InMemoryAgentDeltaCursors implements AgentDeltaCursorsPersistence {
  private readonly owners = new Map<string, string>()
  private readonly sessions = new Map<string, string | null>()
  private readonly projects = new Set<string>()
  private readonly agentSessions = new Set<string>()

  clear(): void {
    this.owners.clear()
    this.sessions.clear()
  }

  replaceProjects(projects: readonly string[]): void {
    this.projects.clear()
    projects.forEach((project) => this.projects.add(project))
  }

  upsertProject(project: string): void {
    this.projects.add(project)
  }

  /** Mirror the SQL foreign-key cascade when a project registry row disappears. */
  deleteProject(project: string): void {
    this.projects.delete(project)
    const suffix = `\0${project}`

    for (const cursorKey of this.owners.keys()) {
      if (cursorKey.endsWith(suffix)) {
        this.owners.delete(cursorKey)
      }
    }
    for (const cursorKey of this.sessions.keys()) {
      if (cursorKey.endsWith(suffix)) {
        this.sessions.delete(cursorKey)
      }
    }
  }

  replaceSessions(sessions: readonly string[]): void {
    this.agentSessions.clear()
    sessions.forEach((session) => this.agentSessions.add(session))
  }

  upsertSession(session: string): void {
    this.agentSessions.add(session)
  }

  deleteSessions(sessions: ReadonlySet<string>): void {
    for (const session of sessions) {
      this.agentSessions.delete(session)
      const prefix = `${session}\0`

      for (const cursorKey of this.sessions.keys()) {
        if (cursorKey.startsWith(prefix)) {
          this.sessions.delete(cursorKey)
        }
      }
    }
  }

  private assertProject(project: string): void {
    if (!this.projects.has(project)) {
      throw new Error(`delta cursor project is not live: ${project}`)
    }
  }

  private assertSession(session: string): void {
    if (!this.agentSessions.has(session)) {
      throw new Error(`delta cursor session is not live: ${session}`)
    }
  }

  async getOrInit(
    scope: AgentDeltaCursorScope,
    project: string,
    initializedAt: string,
  ): Promise<string | null> {
    void initializedAt

    if (!scope.session) {
      return this.owners.get(key(scope.owner, project)) ?? null
    }
    this.assertProject(project)
    this.assertSession(scope.session.id)
    const sessionKey = key(scope.session.id, project)

    if (!this.sessions.has(sessionKey)) {
      const parentKey = scope.session.parentId ? key(scope.session.parentId, project) : null
      const initial =
        parentKey && this.sessions.has(parentKey)
          ? (this.sessions.get(parentKey) ?? null)
          : (this.owners.get(key(scope.owner, project)) ?? null)
      this.sessions.set(sessionKey, initial)
    }

    return this.sessions.get(sessionKey) ?? null
  }

  async advance(
    scope: AgentDeltaCursorScope,
    project: string,
    lastRev: string,
    updatedAt: string,
  ): Promise<void> {
    void updatedAt

    this.assertProject(project)
    if (scope.session) {
      this.assertSession(scope.session.id)
    }

    const ownerKey = key(scope.owner, project)
    const ownerCurrent = this.owners.get(ownerKey)

    if (ownerCurrent == null || BigInt(lastRev) > BigInt(ownerCurrent)) {
      this.owners.set(ownerKey, lastRev)
    }

    if (scope.session) {
      const sessionKey = key(scope.session.id, project)
      const sessionCurrent = this.sessions.get(sessionKey)

      if (sessionCurrent == null || BigInt(lastRev) > BigInt(sessionCurrent)) {
        this.sessions.set(sessionKey, lastRev)
      }
    }
  }
}
