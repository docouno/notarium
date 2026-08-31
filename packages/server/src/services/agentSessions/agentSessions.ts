import { AGENT_SESSION_STATE, type AgentSessionState } from '@notarium/contract'
import { AGENT_SESSION_ATTACH, type AgentSessionAttach, freshNoteId } from '@notarium/core'

import { defineClientFailure } from '../../libs/clientFailure'
import type {
  AgentSessionRecord,
  AgentSessionRoleSelection,
  AgentSessionRoleSet,
  AgentSessionsPersistence,
} from '../metaDb'
import {
  AGENT_SESSION_IDLE_MS,
  AGENT_SESSION_RECENT_LIMIT,
  AGENT_SESSION_RETENTION_MS,
} from './consts'

export type BoundAgentSession = {
  record: AgentSessionRecord
  attach: AgentSessionAttach
}

export type StartAgentSessionRequest = { id: string } | { name: string }

export type AgentSessionStart = {
  session?: BoundAgentSession & { state: AgentSessionState }
  recentSessions?: AgentSessionRecord[]
}

export type AgentSessions = {
  /** Preview the episode start_session would bind or inherit from, without touching it.
   * Null means a fresh/ambiguous world with no single sticky context to preflight. */
  preview(
    owner: string,
    request: StartAgentSessionRequest | undefined,
    retentionMs?: number,
  ): Promise<AgentSessionRecord | null>
  /** Resolve an ordinary call's episode and sticky context without changing its
   * activity. Explicit ids remain fail-closed; omission stays outside sessions. */
  read(owner: string, id?: string, retentionMs?: number): Promise<BoundAgentSession | null>
  /** Resolve a normal tool call. An explicit id must exist for this owner; omission
   * stays outside sessions. */
  attach(owner: string, id?: string, retentionMs?: number): Promise<BoundAgentSession | null>
  /** Open/resume/fork from start_session. `defaultName` is already the canonical
   * project/personal label chosen by the caller. */
  start(
    owner: string,
    request: StartAgentSessionRequest | undefined,
    fresh: { autoName: string; taskName?: string },
    projectId?: string,
    retentionMs?: number,
  ): Promise<AgentSessionStart>
  /** Persist one selected role for the bound episode. */
  setRole(session: BoundAgentSession, role: AgentSessionRoleSelection): Promise<AgentSessionRoleSet>
}

export class NoSuchAgentSessionError extends Error {
  readonly isToolError = true

  constructor() {
    super('no such session — call start_session to open or resume one')
    defineClientFailure(this, { kind: 'actionable', message: this.message })
  }
}

export type CreateAgentSessionsOptions = {
  persistence: AgentSessionsPersistence
  now?: () => Date
  /** Deterministic collision-free mint seam for the contract/service tests. */
  mintId?: () => string
  /** Best-effort owner-global invalidation after a durable session mutation. */
  onChange?: (owner: string) => void
}

const before = (now: Date, elapsedMs: number): string =>
  new Date(now.getTime() - elapsedMs).toISOString()

export const createAgentSessions = ({
  persistence,
  now: getNow = () => new Date(),
  mintId = () => `ses_${freshNoteId()}`,
  onChange,
}: CreateAgentSessionsOptions): AgentSessions => {
  const changed = (owner: string): void => {
    try {
      onChange?.(owner)
    } catch {
      // UI invalidation must never turn a committed session mutation into a failure.
    }
  }

  return {
    preview: async (owner, request, retentionMs = AGENT_SESSION_RETENTION_MS) => {
      const now = getNow()
      const retainedSince = before(now, retentionMs)

      if (request && 'id' in request) {
        return persistence.getRetained(owner, request.id, retainedSince)
      }
      if (!request) {
        return null
      }
      const matches = await persistence.listNamed(owner, request.name, retainedSince, 2)

      return matches.length === 1 ? matches[0]! : null
    },

    read: async (owner, id, retentionMs = AGENT_SESSION_RETENTION_MS) => {
      const now = getNow()

      if (id !== undefined) {
        const record = await persistence.getRetained(owner, id, before(now, retentionMs))

        if (!record) {
          throw new NoSuchAgentSessionError()
        }

        return { record, attach: AGENT_SESSION_ATTACH.declared }
      }

      return null
    },

    attach: async (owner, id, retentionMs = AGENT_SESSION_RETENTION_MS) => {
      const now = getNow()
      const at = now.toISOString()

      if (id !== undefined) {
        const record = await persistence.touch(owner, id, at, before(now, retentionMs))

        if (!record) {
          throw new NoSuchAgentSessionError()
        }

        changed(owner)
        return { record, attach: AGENT_SESSION_ATTACH.declared }
      }

      return null
    },

    start: async (owner, request, fresh, projectId, retentionMs = AGENT_SESSION_RETENTION_MS) => {
      const now = getNow()
      const at = now.toISOString()
      const activeSince = before(now, AGENT_SESSION_IDLE_MS)
      const retainedSince = before(now, retentionMs)

      if (request && 'id' in request) {
        const record = await persistence.touch(owner, request.id, at, retainedSince, projectId)

        if (!record) {
          throw new NoSuchAgentSessionError()
        }

        changed(owner)
        return {
          session: {
            record,
            attach: AGENT_SESSION_ATTACH.declared,
            state: AGENT_SESSION_STATE.resumed,
          },
        }
      }

      if (request && 'name' in request) {
        const result = await persistence.startNamed(
          {
            id: mintId(),
            owner,
            name: request.name,
            named: true,
            parentId: null,
            createdAt: at,
            lastSeenAt: at,
            calls: 1,
            role: null,
            roleLocator: null,
            roleContextProjectId: null,
            projectId: projectId ?? null,
          },
          activeSince,
          retainedSince,
          AGENT_SESSION_RECENT_LIMIT,
          projectId,
        )

        if (result.kind === 'ambiguous') {
          return { recentSessions: result.matches }
        }

        changed(owner)
        return {
          session: {
            record: result.record,
            attach: AGENT_SESSION_ATTACH.declared,
            state: AGENT_SESSION_STATE[result.kind],
          },
        }
      }

      const record: AgentSessionRecord = {
        id: mintId(),
        owner,
        name: fresh.taskName ?? fresh.autoName,
        named: fresh.taskName !== undefined,
        parentId: null,
        createdAt: at,
        lastSeenAt: at,
        calls: 1,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
        projectId: projectId ?? null,
      }
      await persistence.insert(record)
      changed(owner)
      return {
        session: {
          record,
          attach: AGENT_SESSION_ATTACH.inferred,
          state: AGENT_SESSION_STATE.new,
        },
      }
    },

    setRole: async (session, role) => {
      const result = await persistence.setRole(session.record.owner, session.record.id, role)

      if (!result) {
        throw new NoSuchAgentSessionError()
      }
      session.record = result.record
      if (result.changed) {
        changed(session.record.owner)
      }

      return result
    },
  }
}
