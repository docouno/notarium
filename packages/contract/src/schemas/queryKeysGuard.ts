// Compile-time guard: every value in the zod-free `QUERY_KEY` dict must be a real
// `/api/*` query-param key — a key of some query schema, or an export-only literal. This
// keeps consts/queryKeys single-sourced against the query schemas WITHOUT the const
// depending on them (the dependency lives here, on the schema side, where it is legal).
// A mismatch fails to compile via the `Assert` below.
// canon: docs/contract.md#wire-consts
import type { QueryKey } from '../consts/queryKeys'
import type { ActivityQuery } from './rest/activity'
import type { AgentAuditQuery } from './rest/agent/audit'
import type { BucketsQuery, NotesQuery } from './rest/notes'
import type { TrashQuery } from './rest/trash'

// `frontmatter`/`scope` are export-only keys with no query schema (the export endpoint
// validates its body, not the query), so they ride as explicit literal members.
type WireQueryKey =
  | keyof NotesQuery
  | keyof BucketsQuery
  | keyof ActivityQuery
  | keyof AgentAuditQuery
  | keyof TrashQuery
  | 'frontmatter'
  | 'scope'

type Assert<T extends true> = T

/** `true` when every QUERY_KEY value is a valid wire query key; a stray key makes this
 *  `Assert<false>` and reddens the build. */
export type _QueryKeysMatchWire = Assert<QueryKey extends WireQueryKey ? true : false>
