import { z } from 'zod'
import { RESPONSE_FORMAT, WRITE_OUTCOME } from '../../consts/tools'
import { enumValues } from '../../libs/enumValues'
import {
  DurableNonEmptyScalarSchema,
  IsoTimestampSchema,
  ProjectStatusSchema,
  RevisionKindSchema,
  SpaceSlugSchema,
} from '../primitives'

/** A project's address: `"<space-slug>/<project-slug>"` or a bare `"<project-slug>"`
 *  when unambiguous. Copy `get_my_projects`' `handle` verbatim, never construct one.
 *  @see docs/contract.md#routing */
export const ProjectHandleSchema = z.string().min(1)

/** A project's stable, opaque registry id. A loose wire validator (any non-empty
 *  string) — the 12-char `[A-Za-z0-9_-]` shape is enforced at MINT time, not here. */
export const ProjectIdSchema = z.string().min(1)

/** A note reference: the internal note-id or a wiki-ref resolved WITHIN one space.
 *  Resolution failure is a 404 (unreachable ≡ nonexistent). */
export const RefSchema = DurableNonEmptyScalarSchema
/** Response verbosity on read tools. Default differs per tool: `concise`
 *  everywhere, `detailed` on get_note (you asked for a whole note — give the
 *  whole note). */
export const ResponseFormatSchema = z.enum(enumValues(RESPONSE_FORMAT))

/** A project the principal can reach (out of get_my_projects / whoami /
 *  start_session): `handle` passes verbatim into any project-addressing tool.
 *  @see docs/note-model.md#note-ontology */
export const ProjectSummarySchema = z.object({
  id: ProjectIdSchema,
  handle: ProjectHandleSchema,
  displayName: z.string().min(1),
  space: SpaceSlugSchema,
  status: ProjectStatusSchema,
})

/** Who/what last wrote a note, projected from the journal: `principal` (the
 *  attribution string, e.g. `pat:<user>:<id>`; null for an unattributable external
 *  edit), `kind`, `modifiedAt`. */
export const ProvenanceSchema = z.object({
  principal: z.string().nullable(),
  kind: RevisionKindSchema,
  modifiedAt: IsoTimestampSchema,
})

/** The shared write-tool result: the saved note's id + fresh versionToken (chain a
 *  follow-up edit with no interim read), plus an OPTIONAL, additive write echo.
 *  canon: docs/mcp-gateway.md#tools */
export const WriteResultSchema = z.object({
  noteId: z.string(),
  versionToken: z.string(),
  /** The resolved title, echoed by create_note/create_notes so a body-first call
   *  (no `title`, titled by the leading `# H1`) learns the chosen title. */
  title: z.string().optional(),
  /** `created` | `appended` (to a memory category) | `skipped` (an idempotency
   *  replay, NO new write); absent on a plain edit. */
  outcome: z.enum(enumValues(WRITE_OUTCOME)).optional(),
  /** Where the note landed: space-relative storage path WITHOUT the `.md`. */
  path: z.string().optional(),
  /** The work space the note landed in; absent = your personal domain (the same
   *  three-state suppression the read tools use). */
  space: SpaceSlugSchema.optional(),
  /** Integrity echo of the body this write recorded. create_note hashes the `body`
   *  you SENT (transport-integrity, NOT a read-back — the engine may strip a leading
   *  inline frontmatter block or `# title` on store); a remember_* append hashes the
   *  resulting category file, which matches storage. */
  bodyBytes: z.number().int().optional(),
  bodyHash: z.string().optional(),
  /** remember_* only: true when this call SET or OVERWROTE the category `summary`. */
  summaryUpdated: z.boolean().optional(),
  /** Non-binding advisories (currently only `'possible-secret'`) — NEVER blocks the
   *  write, just a nudge to confirm you meant to store a secret in shared knowledge. */
  warnings: z.array(z.string()).optional(),
})

/** What this host's engine can do (`whoami.capabilities`) — declared so an
 *  agent tailors its plan without probing: `vector` (semantic search, vs FTS
 *  only), `trash` (delete is recoverable here), `revisions` (history /
 *  provenance / cursor-based delta are available). */
export const CapabilitiesSchema = z.object({
  vector: z.boolean(),
  trash: z.boolean(),
  revisions: z.boolean(),
})

/** One folder in a directory listing (shared by `list_notes` and `start_session`'s
 *  compact index). `path` is SPACE-relative — feed it back verbatim (never
 *  hand-built) into list_notes / move / create; `count` is the whole-subtree note
 *  count. */
export const FolderEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  count: z.number().int(),
})
export type ProjectHandle = z.infer<typeof ProjectHandleSchema>

export type ProjectId = z.infer<typeof ProjectIdSchema>
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>

export type Provenance = z.infer<typeof ProvenanceSchema>

export type WriteResult = z.infer<typeof WriteResultSchema>

export type Capabilities = z.infer<typeof CapabilitiesSchema>

export type FolderEntry = z.infer<typeof FolderEntrySchema>

export type { ProjectStatus } from '../../consts/primitives'
export { RESPONSE_FORMAT }
export type { ResponseFormat } from '../../consts/tools'
