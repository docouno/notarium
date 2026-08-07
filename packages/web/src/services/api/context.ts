import type {
  AgentAudit,
  AgentRetrievalTool,
  AgentSessionEvents,
  AgentSessions,
  ContextOrderEntry,
  ContextSetResponse,
  ContextSetsResponse,
  MeAgentContext,
  MuteNoteResponse,
  PinNoteResponse,
} from '@notarium/contract'
import { QUERY_KEY } from '@notarium/contract/query'
import { req, sp } from './client'

export const contextApi = {
  // ── context constructor (#165): preview + pin/mute curation ────────────────
  /** The PERSONAL agent-context preview: capped alwaysLoad for the agent and
   *  full pins[] for the UI (memory is meMemoryGet). */
  meAgentContextGet: (role?: string) =>
    req<MeAgentContext>(`/api/me/agent-context${role ? `?role=${encodeURIComponent(role)}` : ''}`),
  /** The agent-retrieval audit (#243): the viewer's own agent search/recall/get_note
   *  history (newest-first, windowed) + whole-history aggregates. `tool` narrows to one
   *  tool; `filter='misses'` keeps only the zero-result calls. */
  agentAuditGet: (
    params: {
      offset?: number
      limit?: number
      tool?: AgentRetrievalTool
      filter?: 'misses'
      beforeAt?: string
      beforeId?: string
      /** Skip the whole-history aggregate scan when the client already holds them (a tool-filter
       *  switch — they're tool-independent). The response's `aggregates` comes back null. */
      skipAggregates?: boolean
    } = {},
  ) => {
    const q = new URLSearchParams()

    if (params.offset) {
      q.set(QUERY_KEY.offset, String(params.offset))
    }
    if (params.limit !== undefined) {
      q.set(QUERY_KEY.limit, String(params.limit))
    }
    if (params.tool) {
      q.set(QUERY_KEY.tool, params.tool)
    }
    if (params.filter) {
      q.set(QUERY_KEY.filter, params.filter)
    }
    if (params.beforeAt) {
      q.set(QUERY_KEY.beforeAt, params.beforeAt)
    }
    if (params.beforeId) {
      q.set(QUERY_KEY.beforeId, params.beforeId)
    }
    if (params.skipAggregates) {
      q.set(QUERY_KEY.aggregates, '0')
    }
    const s = q.toString()
    return req<AgentAudit>(`/api/me/agent-audit${s ? `?${s}` : ''}`)
  },
  /** Session-first audit overview: retained + archived episodes, outside-session
   *  gaps and the global retrieval insights kept from the former Audit page. */
  agentSessionsGet: (params: { limit?: number; cursor?: string; aggregates?: '0' } = {}) => {
    const q = new URLSearchParams()

    if (params.limit !== undefined) {
      q.set(QUERY_KEY.limit, String(params.limit))
    }
    if (params.cursor) {
      q.set(QUERY_KEY.cursor, params.cursor)
    }
    if (params.aggregates) {
      q.set(QUERY_KEY.aggregates, params.aggregates)
    }
    const s = q.toString()
    return req<AgentSessions>(`/api/me/agent-sessions${s ? `?${s}` : ''}`)
  },
  agentSessionEventsGet: (
    id: string,
    params: { limit?: number; cursor?: string; filter?: 'reads' | 'writes' } = {},
  ) => {
    const q = new URLSearchParams()

    if (params.limit !== undefined) {
      q.set(QUERY_KEY.limit, String(params.limit))
    }
    if (params.cursor) {
      q.set(QUERY_KEY.cursor, params.cursor)
    }
    if (params.filter) {
      q.set(QUERY_KEY.filter, params.filter)
    }
    const s = q.toString()
    return req<AgentSessionEvents>(
      `/api/me/agent-sessions/${encodeURIComponent(id)}${s ? `?${s}` : ''}`,
    )
  },
  /** Toggle a note's `always-load` membership (id-addressed). Pin/unpin = the
   *  «Pin to agent context» action and the Context constructor. */
  notePin: (id: string, pinned: boolean) =>
    req<PinNoteResponse>('/api/note/pin', { method: 'PUT', body: JSON.stringify({ id, pinned }) }),
  /** Toggle a memory category's `muted` opt-out (id-addressed): muted stays in the
   *  audit but drops from the agent's eager profile. The Memory pult's toggle. */
  noteMute: (id: string, muted: boolean) =>
    req<MuteNoteResponse>('/api/note/mute', {
      method: 'PUT',
      body: JSON.stringify({ id, muted }),
    }),

  // ── context sets (#209): named cross-space collections + scope attachments ───
  /** Every set across the caller's readable spaces — the management overview + the
   *  attach picker (the client filters shared-only for a project target). */
  contextSetsGet: () => req<ContextSetsResponse>('/api/context-sets').then((d) => d.sets),
  /** Create a set homed in `space` (a shared space, or the personal space for a
   *  private set). */
  contextSetCreate: (space: string, name: string) =>
    req<ContextSetResponse>(`${sp(space)}/context-sets`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }).then((d) => d.set),
  contextSetRename: (space: string, id: string, name: string) =>
    req<ContextSetResponse>(`${sp(space)}/context-sets/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }).then((d) => d.set),
  contextSetDelete: (space: string, id: string) =>
    req<{ ok: true }>(`${sp(space)}/context-sets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Add a CROSS-SPACE note ref to a set (its space = where the note lives). */
  contextSetItemAdd: (space: string, id: string, itemSpace: string, noteId: string) =>
    req<ContextSetResponse>(`${sp(space)}/context-sets/${encodeURIComponent(id)}/items`, {
      method: 'POST',
      body: JSON.stringify({ space: itemSpace, noteId }),
    }).then((d) => d.set),
  contextSetItemRemove: (space: string, id: string, noteId: string) =>
    req<ContextSetResponse>(
      `${sp(space)}/context-sets/${encodeURIComponent(id)}/items/${encodeURIComponent(noteId)}`,
      {
        method: 'DELETE',
      },
    ).then((d) => d.set),
  /** Attach/detach a set to a PROJECT scope (a shared set only). */
  contextSetAttachProject: (space: string, projectId: string, id: string) =>
    req<{ ok: true }>(
      `${sp(space)}/projects/${encodeURIComponent(projectId)}/context-sets/${encodeURIComponent(id)}`,
      { method: 'PUT' },
    ),
  contextSetDetachProject: (space: string, projectId: string, id: string) =>
    req<{ ok: true }>(
      `${sp(space)}/projects/${encodeURIComponent(projectId)}/context-sets/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  /** Attach/detach a set to MY personal scope. */
  contextSetAttachPersonal: (id: string) =>
    req<{ ok: true }>(`/api/me/context-sets/${encodeURIComponent(id)}`, { method: 'PUT' }),
  contextSetDetachPersonal: (id: string) =>
    req<{ ok: true }>(`/api/me/context-sets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Attach/detach against the exact effective owned role in personal or project mode. */
  contextSetAttachRole: (role: string, id: string, projectId?: string) =>
    req<{ ok: true }>(
      `/api/me/agent-roles/${encodeURIComponent(role)}/context-sets/${encodeURIComponent(id)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      { method: 'PUT' },
    ),
  contextSetDetachRole: (role: string, id: string, projectId?: string) =>
    req<{ ok: true }>(
      `/api/me/agent-roles/${encodeURIComponent(role)}/context-sets/${encodeURIComponent(id)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      { method: 'DELETE' },
    ),

  // ── cross-space pins (#209): a note pinned into a scope from ANOTHER space (the
  // loose sibling of a set). Same-space pins use notePin (the always-load tag). ──
  /** Pin a cross-space note into MY personal scope (noteSpace = where the note lives). */
  contextPinAttachPersonal: (noteSpace: string, noteId: string) =>
    req<{ ok: true }>('/api/me/context-pins', {
      method: 'PUT',
      body: JSON.stringify({ space: noteSpace, noteId }),
    }),
  contextPinDetachPersonal: (noteId: string) =>
    req<{ ok: true }>(`/api/me/context-pins/${encodeURIComponent(noteId)}`, { method: 'DELETE' }),
  /** Pin a cross-space note into a PROJECT scope. `space` = the project's space. */
  contextPinAttachProject: (space: string, projectId: string, noteSpace: string, noteId: string) =>
    req<{ ok: true }>(`${sp(space)}/projects/${encodeURIComponent(projectId)}/context-pins`, {
      method: 'PUT',
      body: JSON.stringify({ space: noteSpace, noteId }),
    }),
  contextPinDetachProject: (space: string, projectId: string, noteId: string) =>
    req<{ ok: true }>(
      `${sp(space)}/projects/${encodeURIComponent(projectId)}/context-pins/${encodeURIComponent(noteId)}`,
      { method: 'DELETE' },
    ),
  /** Role pins always use the role registry, including notes in the role's own space. */
  contextPinAttachRole: (role: string, noteSpace: string, noteId: string, projectId?: string) =>
    req<{ ok: true }>(
      `/api/me/agent-roles/${encodeURIComponent(role)}/context-pins${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      { method: 'PUT', body: JSON.stringify({ space: noteSpace, noteId }) },
    ),
  contextPinDetachRole: (role: string, noteId: string, projectId?: string) =>
    req<{ ok: true }>(
      `/api/me/agent-roles/${encodeURIComponent(role)}/context-pins/${encodeURIComponent(noteId)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      { method: 'DELETE' },
    ),

  // ── context order (#210): the user's pin+set order per scope (order = load priority),
  // plus a set's own item order (a property of the set, shared across attach points). ──
  /** Replace MY personal scope's pin+set order with `entries` (kind+ref in the new order). */
  contextOrderPersonal: (entries: ContextOrderEntry[]) =>
    req<{ ok: true }>('/api/me/context-order', {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    }),
  /** Replace a PROJECT scope's pin+set order. `space` = the project's space. */
  contextOrderProject: (space: string, projectId: string, entries: ContextOrderEntry[]) =>
    req<{ ok: true }>(`${sp(space)}/projects/${encodeURIComponent(projectId)}/context-order`, {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    }),
  contextOrderRole: (role: string, entries: ContextOrderEntry[], projectId?: string) =>
    req<{ ok: true }>(
      `/api/me/agent-roles/${encodeURIComponent(role)}/context-order${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      { method: 'PUT', body: JSON.stringify({ entries }) },
    ),
  /** Reorder a set's items to `noteIds` (a home-space write; `space` = the set's home). */
  contextSetItemsOrder: (space: string, id: string, noteIds: string[]) =>
    req<ContextSetResponse>(`${sp(space)}/context-sets/${encodeURIComponent(id)}/order`, {
      method: 'PUT',
      body: JSON.stringify({ noteIds }),
    }).then((d) => d.set),
}
