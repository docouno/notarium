import { z } from 'zod'
import { RESOLVED_VIA } from '../../consts/discovery'
import { enumValues } from '../../libs/enumValues'
import { NoteClassSchema } from '../primitives'

/** A real note node. `ghost: false` is the discriminant against the ghost variant.
 *  `community`/`x`/`y` are server-side graph enrichment: Louvain link-community
 *  (absent for singletons) and force-layout position from snapshot build. All optional —
 *  a store without the read-model serves a bare graph, client falls back to live layout.
 *  canon: docs/architecture.md#p5 */
export const GraphRealNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  filePath: z.string(),
  folder: z.string(),
  ghost: z.literal(false),
  degree: z.number(),
  community: z.number().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  /** The note's tags, as authored (original casing). Carried so the graph's
   *  tag facet reads from the index instead of a per-node preview sweep. Absent/[] = untagged. */
  tags: z.array(z.string()).optional(),
  /** The note's class — READ-ONLY label; only user-visible classes reach the
   *  graph surface, so in practice `user-doc`/`attachment`. Carried for a future
   *  class-keyed visibility toggle.
   *  canon: docs/note-model.md#note-classes */
  class: NoteClassSchema.optional(),
})

/** A ghost node: an unresolved [[wikilink]] whose target no note's normalised
 *  title/path matches yet. Carries the prefill payload the "create this note" flow
 *  reads: `target` = normalised resolution key a future title must match,
 *  `prefillTitle` = human title from the raw link text, `sources` = notes pointing at
 *  the ghost (new note back-links them via `title`, lands beside the first via `folder`).
 *  A source `id` is absent only on a bare engine's graph (no identity layer); the served
 *  wire always has it.
 *  canon: docs/contract.md#wire-v2 */
export const GraphGhostNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  ghost: z.literal(true),
  folder: z.literal(''),
  degree: z.number(),
  target: z.string(),
  prefillTitle: z.string(),
  sources: z
    .array(z.object({ id: z.string().optional(), title: z.string(), folder: z.string() }))
    .optional(),
  // Ghosts are laid out too (they hang off their source notes), so they carry
  // the same optional server positions as real nodes. No community: Louvain
  // runs over real notes only.
  x: z.number().optional(),
  y: z.number().optional(),
})

export const GraphNodeSchema = z.discriminatedUnion('ghost', [
  GraphRealNodeSchema,
  GraphGhostNodeSchema,
])

/** An edge. source/target are node ids; on the wire they are strings, though the
 *  force-graph runtime later hydrates them into node object references. */
export const GraphLinkSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.string(),
})

export const GraphResponseSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  links: z.array(GraphLinkSchema),
})

/** A non-current resolution axis. `current` never appears on the wire here — the
 *  edge list carries only the names worth grooming. */
export const ResolvedViaSchema = z.enum(enumValues(RESOLVED_VIA))
/** One edge resolving through a non-current name — `source`/`target` carry titles so
 *  the card renders "A → B (via a former name)" and a click navigates. */
export const GraphHealthEdgeSchema = z.object({
  source: z.object({ id: z.string(), title: z.string() }),
  target: z.object({ id: z.string(), title: z.string() }),
  via: ResolvedViaSchema,
})

/** A broken link: a ghost (unresolved [[Label]]) + the notes pointing at it. */
export const GraphHealthGhostSchema = z.object({
  id: z.string(),
  title: z.string(),
  target: z.string(),
  /** Unique source notes that point at this ghost; the row priority/count. */
  refCount: z.number(),
  sources: z.array(z.object({ id: z.string().optional(), title: z.string(), folder: z.string() })),
})

export const GraphHealthResponseSchema = z.object({
  /** Resolved (non-ghost) wikilink edges considered — the denominator. */
  totalLinks: z.number(),
  /** Edges resolving through a PRIOR name (note-alias + folder-alias) — the headline. */
  staleNamed: z.number(),
  /** Per-axis counts. `slug` = a live custom display slug (a current alternate, NOT a
   *  former name) — reported apart from `staleNamed`. */
  via: z.object({ slug: z.number(), noteAlias: z.number(), folderAlias: z.number() }),
  /** The non-current edges (server-capped for display). */
  edges: z.array(GraphHealthEdgeSchema),
  /** The broken links. */
  ghosts: z.array(GraphHealthGhostSchema),
})

export type GraphNode = z.infer<typeof GraphNodeSchema>

export type GraphRealNode = z.infer<typeof GraphRealNodeSchema>

export type GraphGhostNode = z.infer<typeof GraphGhostNodeSchema>

export type GraphLink = z.infer<typeof GraphLinkSchema>

export type GraphResponse = z.infer<typeof GraphResponseSchema>

export type GraphHealth = z.infer<typeof GraphHealthResponseSchema>

export type GraphHealthEdge = z.infer<typeof GraphHealthEdgeSchema>

export type GraphHealthGhost = z.infer<typeof GraphHealthGhostSchema>
