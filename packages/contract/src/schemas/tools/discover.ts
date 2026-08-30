import { z } from 'zod'
import {
  IsoTimestampSchema,
  RevisionKindSchema,
  RevisionUnavailableReasonSchema,
} from '../primitives'
import { fieldFilterQueryFields } from '../rest/notes'
import { locationFields, sessionField } from './_fields'
import { FolderEntrySchema, ProjectHandleSchema } from './primitives'

/** Tool `list_notes`: `ls` a folder — its direct notes + subfolders, paginated.
 *  canon: docs/mcp-gateway.md#tools */
export const ListNotesInputSchema = z
  .object({
    ...sessionField,
    project: ProjectHandleSchema.optional(),
    /** A SPACE-relative folder to list (copy a `folders` entry's `path` back); omit =
     *  the project/personal root. */
    path: z.string().optional(),
    /** Keep only notes carrying this tag (frontmatter `tags`). */
    tag: z.string().optional(),
    ...fieldFilterQueryFields,
    limit: z.number().int().min(1).max(100).default(50),
    /** Opaque pagination cursor from a prior response's `nextCursor`. */
    cursor: z.string().optional(),
  })
  .strict()

/** One note in a directory listing: `path` is SPACE-relative without `.md`; `tags`
 *  ride only when the engine could enrich the page cheaply. */
export const ListNotesItemSchema = z.object({
  noteId: z.string(),
  title: z.string(),
  path: z.string(),
  tags: z.array(z.string()).optional(),
  modifiedAt: IsoTimestampSchema,
})

/** list_notes' payload: `items` (direct notes, title-ordered) + `folders` (direct
 *  subfolders) + `total` (direct-note count before the page slice). */
export const ListNotesOutputSchema = z.object({
  items: z.array(ListNotesItemSchema),
  folders: z.array(FolderEntrySchema),
  total: z.number().int(),
  nextCursor: z.string().optional(),
})

/** Tool `recent_activity`: the most recently-changed notes (absolute freshness),
 * distinct from start_session's bound-session or unbound-owner delta.
 * canon: docs/mcp-gateway.md#tools */
export const RecentActivityInputSchema = z
  .object({
    ...sessionField,
    /** With it, narrows to that project (best-effort label filter — the journal isn't
     *  path-indexed, so `truncated` when the window under-fills). */
    project: ProjectHandleSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict()

/** One recently-changed note from the journal; `kind`/`principal` tell a human edit
 *  from an agent's. */
export const RecentActivityItemSchema = z.object({
  noteId: z.string(),
  title: z.string(),
  ...locationFields,
  kind: RevisionKindSchema,
  principal: z.string().nullable(),
  modifiedAt: IsoTimestampSchema,
  /** A journal GAP — see `RevisionUnavailableReasonSchema`. */
  unavailableReason: RevisionUnavailableReasonSchema.optional(),
})

/** `truncated` = there were more recent changes than `limit` returned. No `total`:
 *  the journal isn't path-indexed, so this answers "the latest N", not a paginated
 *  population. */
export const RecentActivityOutputSchema = z.object({
  items: z.array(RecentActivityItemSchema),
  truncated: z.boolean().optional(),
})

export type ListNotesInput = z.infer<typeof ListNotesInputSchema>

export type ListNotesItem = z.infer<typeof ListNotesItemSchema>

export type ListNotesOutput = z.infer<typeof ListNotesOutputSchema>

export type RecentActivityInput = z.infer<typeof RecentActivityInputSchema>

export type RecentActivityItem = z.infer<typeof RecentActivityItemSchema>

export type RecentActivityOutput = z.infer<typeof RecentActivityOutputSchema>
