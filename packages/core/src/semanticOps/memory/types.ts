// Domain types for the agent-memory semantic ops.

import type { AgentWriteAttribution, WriteResult } from '../../knowledgeStore'

/** The pure inputs shared by both memory intents (the gateway has already
 *  rejected a blank observation/category and resolved the target store). */
export type RememberInput = {
  /** The durable fact to record. */
  observation: string
  /** The memory category — selects/creates the note to append under. A label,
   *  not a path: matched (and filenamed) by its slug. */
  category: string
  /** One-line digest for the derived index. undefined = keep the category's
   *  existing summary; a string updates it. */
  summary?: string
  /** Optional CAS guard. When present it is ENFORCED on the append: a stale
   *  token conflicts rather than appending onto a moved note. Absent = the op
   *  reads the live token and retries a lost race internally. */
  versionToken?: string
  /** Journal attribution — the gateway stamps the agent's principal. */
  principal?: string
  agent?: AgentWriteAttribution
}

/** The memory write outcome, enriching WriteResult with the transparency
 *  echo the gateway surfaces: whether the category note was minted or appended to,
 *  the body's integrity (so an agent confirms its observation landed without a
 *  read-back — for a create that body is the observation, for an append the
 *  resulting category file), and whether THIS call set the `summary` (vs carrying
 *  the existing one forward). The op knows all three first-hand. */
export type RememberResult = WriteResult & {
  outcome: 'created' | 'appended'
  bodyBytes: number
  bodyHash: string
  summaryUpdated: boolean
}

export type RememberAboutUserInput = RememberInput

export type RememberAboutProjectInput = RememberInput & {
  /** The project this memory is about — its STABLE id, which is also the
   *  agent-mount subdirectory the memory lands in (`.notarium/memory/<id>/`). The
   *  gateway resolves the project HANDLE to the registry row and passes its id. */
  projectId: string
}

/** One memory category as the derived index reports it (fed into
 *  start_session and the human audit surfaces): the note-id (a move-safe handle),
 *  the category (the note's title), a one-line summary, and the human-set
 *  `muted` opt-out. `muted` categories stay in the index (the audit feed
 *  shows them) but the eager profile filters them out — observability ≠ loading. */
export type MemoryIndexEntry = {
  noteId: string
  category: string
  summary: string
  tokens: number
  muted: boolean
  /** Engine metadata for the category's first known creation. */
  createdAt: string | null
  /** Engine metadata fallback for hosts without a revision journal. */
  modifiedAt: string | null
}
