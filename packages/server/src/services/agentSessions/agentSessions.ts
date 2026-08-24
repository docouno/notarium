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
  AGENT_SESSION_RECENT_MS,
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
  ): Promise<AgentSessionRecord | null>
  /** Resolve an ordinary call's episode and sticky context without changing its
   * activity. Explicit ids remain fail-closed; omission reads exactly one active row. */
  read(owner: string, id?: string): Promise<BoundAgentSession | null>
  /** Resolve a normal tool call. An explicit id must exist for this owner; omission
   * attaches only when the exact-one-active decision can be made atomically. */
  attach(owner: string, id?: string): Promise<BoundAgentSession | null>
  /** Open/resume/fork from start_session. `defaultName` is already the canonical
   * project/personal label chosen by the caller. */
  start(
    owner: string,
    request: StartAgentSessionRequest | undefined,
    defaultName: string,
    projectId?: string,
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
    preview: async (owner, request) => {
      const now = getNow()
      const activeSince = before(now, AGENT_SESSION_IDLE_MS)
      const retainedSince = before(now, AGENT_SESSION_RETENTION_MS)

      if (request && 'id' in request) {
        return persistence.getRetained(owner, request.id, retainedSince)
      }
      const matches = request
        ? await persistence.listNamed(owner, request.name, retainedSince, 2)
        : await persistence.listRecent(owner, activeSince, 2)

      return matches.length === 1 ? matches[0]! : null
    },

    read: async (owner, id) => {
      const now = getNow()

      if (id !== undefined) {
        const record = await persistence.getRetained(
          owner,
          id,
          before(now, AGENT_SESSION_RETENTION_MS),
        )

        if (!record) {
          throw new NoSuchAgentSessionError()
        }

        return { record, attach: AGENT_SESSION_ATTACH.declared }
      }

      const matches = await persistence.listRecent(owner, before(now, AGENT_SESSION_IDLE_MS), 2)

      return matches.length === 1
        ? { record: matches[0]!, attach: AGENT_SESSION_ATTACH.inferred }
        : null
    },

    attach: async (owner, id) => {
      const now = getNow()
      const at = now.toISOString()

      if (id !== undefined) {
        const record = await persistence.touch(
          owner,
          id,
          at,
          before(now, AGENT_SESSION_RETENTION_MS),
        )

        if (!record) {
          throw new NoSuchAgentSessionError()
        }

        changed(owner)
        return { record, attach: AGENT_SESSION_ATTACH.declared }
      }

      const record = await persistence.inferActiveAndTouch(
        owner,
        before(now, AGENT_SESSION_IDLE_MS),
        at,
      )

      if (record) {
        changed(owner)
      }

      return record ? { record, attach: AGENT_SESSION_ATTACH.inferred } : null
    },

    start: async (owner, request, defaultName, projectId) => {
      const now = getNow()
      const at = now.toISOString()
      const activeSince = before(now, AGENT_SESSION_IDLE_MS)
      const retainedSince = before(now, AGENT_SESSION_RETENTION_MS)
      const prunedOwners = await persistence.prune(retainedSince)

      for (const prunedOwner of prunedOwners) {
        changed(prunedOwner)
      }

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

      const result = await persistence.startInferred(
        {
          id: mintId(),
          owner,
          name: defaultName,
          named: false,
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
        before(now, AGENT_SESSION_RECENT_MS),
        AGENT_SESSION_RECENT_LIMIT,
        projectId,
      )
      changed(owner)
      return {
        session: {
          record: result.record,
          attach: AGENT_SESSION_ATTACH.inferred,
          state: AGENT_SESSION_STATE[result.kind],
        },
        ...(result.recentSessions ? { recentSessions: result.recentSessions } : {}),
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
