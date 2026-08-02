import { z } from 'zod'
import { NoteListItemSchema } from './notes'

/** One folder of the tree skeleton. `count` is the note population of the whole
 *  subtree (matches the Feed facet's prefix filter); `direct` only the notes
 *  immediately inside (what a lazy tree expand will fetch). Flat list sorted by
 *  path — nesting is one cheap client-side pass. */
export const TreeFolderSchema = z.object({
  path: z.string(),
  name: z.string(),
  count: z.number(),
  direct: z.number(),
  /** Stable folder-id, present once the folder gains an identity — it has MOVED
   *  (aliases below), has a PAGE, is a project marker, OR was favorited
   *  (favorites lazy-mint). Lets the client link to its durable `/folder/<id>`;
   *  absent on a plain never-identified folder (addressed by `/files/<path>`). */
  id: z.string().optional(),
  /** Past paths — present only on a MOVED folder, so the client redirects
   *  `/files/<oldpath>` to the current path and resolves `[[oldpath/note]]`. */
  aliases: z.array(z.string()).optional(),
  /** This folder's PAGE note id: a visible `index.md` is its body, hidden
   *  from the folder's children. Present ⇒ materialised page (render as the folder's
   *  body, show a page glyph); absent ⇒ virtual folder page, materialised only on
   *  the first authored save. */
  pageNoteId: z.string().optional(),
})

/** The structure endpoint: every folder with counts plus base-wide stats, all
 *  derived from the read-model snapshot. This is what the sidebar tree and the
 *  Feed aside boot from — the full note list never crosses the wire again. */
export const TreeResponseSchema = z.object({
  folders: z.array(TreeFolderSchema),
  stats: z.object({
    total: z.number(),
    /** Notes at the space root (no folder). */
    root: z.number(),
    /** Notes created in the last 7 days (createdAt-based; notes the engine
     *  can't date simply don't count — same honesty as the Feed's Created sort). */
    week: z.number(),
  }),
})

/** The step-load query: `path` ('' = space root) names the folder whose
 *  direct contents the tree wants. offset/limit window the NOTES (a folder with
 *  thousands of direct notes shouldn't cross the wire whole); subfolders are
 *  never windowed — they're structure, bounded by the skeleton. */
export const TreeChildrenQuerySchema = z.object({
  path: z.string().default(''),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).optional(),
})

/** One expand step of the sidebar tree: the folder's direct subfolders (with
 *  the same counts the skeleton carries) and its direct notes, title-ordered —
 *  the ordering is THIS endpoint's contract, not a parameter, so every tree
 *  consumer renders the same listing. `total` is the direct-note population
 *  before the slice. */
export const TreeChildrenResponseSchema = z.object({
  folders: z.array(TreeFolderSchema),
  notes: z.array(NoteListItemSchema),
  total: z.number(),
})

export type TreeFolder = z.infer<typeof TreeFolderSchema>

export type Tree = z.infer<typeof TreeResponseSchema>

export type TreeChildrenQuery = z.infer<typeof TreeChildrenQuerySchema>

export type TreeChildren = z.infer<typeof TreeChildrenResponseSchema>
