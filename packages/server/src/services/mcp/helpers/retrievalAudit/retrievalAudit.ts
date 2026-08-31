// Retrieval-audit capture: builds the fire-and-forget audit row for a
// successful read-tool call.
// canon: docs/projects.md#activity-auditing-agent-work-243-321-mem-audita
import { AGENT_RETRIEVAL_TOOL } from '@notarium/contract'
import {
  type GetNoteInput,
  type RecallInput,
  type SearchHit,
  type SearchInput,
  type ToolName,
} from '@notarium/contract/tools'

import type { BoundAgentSession } from '../../../agentSessions'
import { agentOwnerOf, type Principal } from '../../../authz'
import { type RetrievalHit, type RetrievalLogInput } from '../../../metaDb'

const RETRIEVAL_TOOLS = new Set<ToolName>(['search', 'get_note', 'recall'])

const RETRIEVAL_HITS_KEPT = 5

const retrievalHitOf = (h: SearchHit): RetrievalHit => ({
  noteId: h.noteId,
  title: h.title,
  ...(typeof h.score === 'number' ? { score: h.score } : {}),
  ...(h.class ? { class: h.class } : {}),
})

/** Build the audit row for a successful read-tool call, or null when not auditable.
 *  Pure — the caller fires the append and swallows errors, so capture never affects
 *  latency or correctness. */
export const retrievalRowOf = (
  name: ToolName,
  principal: Principal,
  input: unknown,
  output: Record<string, unknown>,
  at: string,
  session?: BoundAgentSession,
  agentCallId?: string,
): RetrievalLogInput | null => {
  const owner = agentOwnerOf(principal)

  if (!RETRIEVAL_TOOLS.has(name) || !owner) {
    return null
  }
  const base = {
    owner,
    agentCallId: agentCallId ?? null,
    principal: principal.id,
    agent: principal.label ?? null,
    sessionId: session?.record.id ?? null,
    sessionName: session?.record.name ?? null,
    sessionAttach: session?.attach ?? null,
    createdAt: at,
  }

  if (name === 'search') {
    const a = input as SearchInput
    const results = (output.results as SearchHit[] | undefined) ?? []
    const scores = results.map((r) => r.score).filter((s): s is number => typeof s === 'number')
    return {
      ...base,
      tool: AGENT_RETRIEVAL_TOOL.search,
      query: a.query,
      project: a.project ?? null,
      classFilter: a.class ?? null,
      resultCount: results.length,
      // Scores of one search response, capped by the tool's result limit.
      // eslint-disable-next-line no-restricted-syntax
      topScore: scores.length ? Math.max(...scores) : null,
      hits: results.slice(0, RETRIEVAL_HITS_KEPT).map(retrievalHitOf),
    }
  }
  if (name === 'recall') {
    const a = input as RecallInput
    const sources =
      (output.sources as Array<{ noteId: string; title?: string; class?: string }> | undefined) ??
      []
    return {
      ...base,
      tool: AGENT_RETRIEVAL_TOOL.recall,
      query: a.query,
      project: a.project ?? null,
      classFilter: null,
      resultCount: sources.length,
      topScore: null,
      hits: sources.slice(0, RETRIEVAL_HITS_KEPT).map((s) => ({
        noteId: s.noteId,
        title: s.title,
        ...(s.class ? { class: s.class } : {}),
      })),
    }
  }
  const a = input as GetNoteInput
  const noteId = typeof output.noteId === 'string' ? output.noteId : ''
  const title = typeof output.title === 'string' ? output.title : undefined
  const cls = typeof output.class === 'string' ? output.class : undefined
  return {
    ...base,
    tool: AGENT_RETRIEVAL_TOOL.getNote,
    query: a.ref,
    project: null,
    classFilter: null,
    resultCount: noteId ? 1 : 0,
    topScore: null,
    hits: noteId ? [{ noteId, title, ...(cls ? { class: cls } : {}) }] : [],
  }
}
