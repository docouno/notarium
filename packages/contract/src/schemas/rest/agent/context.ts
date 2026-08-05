import { z } from 'zod'
import { CONTEXT_ENTRY_KIND, CONTEXT_KIND } from '../../../consts/context'
import { enumValues } from '../../../libs/enumValues'
import { MemoryCategorySchema } from './memory'

/** Where a context set is attached — the owner's `personal` session or a `project`'s
 *  sessions for all its members. */
export const ContextKindSchema = z.enum(enumValues(CONTEXT_KIND))

/** A scope's ordered sequence entry kind — a `pin` (a note) or a `set`. */
export const ContextEntryKindSchema = z.enum(enumValues(CONTEXT_ENTRY_KIND))

/** One pinned always-load note as the AGENT sees it: move-safe id + title. */
export const PinnedNoteSchema = z.object({ noteId: z.string(), title: z.string() })

/** One pinned note as the WEB preview sees it — every curated pin, including ones over
 *  the eager budget. `loaded=false`: still pinned, but `start_session` omits it until the
 *  set fits the budget. `tokens` weighs the whole BODY (a pin is always-load content, so
 *  a bloated pin stands out here). */
export const ContextPinSchema = PinnedNoteSchema.extend({
  loaded: z.boolean(),
  tokens: z.number(),
  /** Home space slug — present ONLY for a CROSS-SPACE pin, resolved per-reader
   *  with honest degradation if unreachable (like a set ref).
   *  Absent for a same-space pin (the location-bound `always-load` tag). Drives the
   *  home chip and routes unpin to the scope-pin registry instead of the tag. */
  space: z.string().optional(),
  /** POSITION among siblings: for a top-level pin, index in the scope's ONE pin+set
   *  sequence (pins and sets share the rank space — a set can sit above a pin); for a set
   *  ITEM, index within the set. Server-curated (order = load priority), so the client
   *  merges the pins+sets arrays and sorts by `order`, never re-deriving the sequence. */
  order: z.number().int(),
})

/** One memory category as the CONSTRUCTOR sees it: the {@link MemoryCategorySchema}
 *  audit shape plus a `loaded` flag — whether it fits the scope's eager token budget.
 *  Muted categories carry `loaded=false` (stay listed, drop from the eager profile).
 *  `loaded` reflects the joint pins+memory (+ embedded personal in a project) trim. */
export const ContextMemorySchema = MemoryCategorySchema.extend({ loaded: z.boolean() })

/** One note reference inside a set as its MANAGER sees it (home-space CRUD): move-safe
 *  global id, home space slug, resolved title. Inaccessible refs degrade (see
 *  `space` below), never dropped from the set definition. */
export const ContextSetRefSchema = z.object({
  noteId: z.string(),
  /** The item's home-space SLUG — or `null` when the READER can't reach the note
   *  (honest degradation): an inaccessible ref keeps its `noteId` (for the remove-item
   *  endpoint) but nulls BOTH `space` and `title`, so a home-space member never learns the
   *  slug of a space they aren't in. */
  space: z.string().nullable(),
  title: z.string().nullable(),
})

/** Where a set is attached (its scope binding). `personal` = the owner's personal
 *  session; `project` = a project's sessions for all its members. `label` is a
 *  display handle (the project handle, or "Personal"). */
export const ContextSetAttachmentSchema = z.object({
  kind: ContextKindSchema,
  id: z.string(),
  label: z.string(),
})

/** One context set as its MANAGER sees it (home-space CRUD + the attach picker): the
 *  stable id, name, home space (slug), whether the home is a PERSONAL domain (a
 *  personal set attaches only to its owner's personal — `ownership ≥ attachment`),
 *  its cross-space refs, and where it is currently attached. */
export const ContextSetSchema = z.object({
  id: z.string(),
  name: z.string(),
  homeSpace: z.string(),
  personal: z.boolean(),
  items: z.array(ContextSetRefSchema),
  attachments: z.array(ContextSetAttachmentSchema),
  createdAt: z.string(),
})

/** GET /api/context-sets (host-level, cross-space) — every set across the caller's
 *  readable spaces, for the management overview + the attach picker. */
export const ContextSetsResponseSchema = z.object({ sets: z.array(ContextSetSchema) })

export const ContextSetResponseSchema = z.object({ set: ContextSetSchema })

/** One set item as a SCOPE preview sees it: resolved items riding the scope's
 *  budget. Only items THIS viewer can reach (degraded ones omitted — the preview mirrors
 *  the agent's real load), each weighed by body with the server's `loaded`; `space` is the
 *  home slug. NOTE: the inherited `order` on an item just mirrors its ARRAY INDEX
 *  and is NOT read by the client (item order IS array order); it is kept only for
 *  shape-symmetry with a pin row. The load-bearing `order` is on a top-level pin/set. */
export const ContextSetItemSchema = ContextPinSchema.extend({ space: z.string() })

export const ContextSetViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The set's HOME space slug — lets a scope panel address its CRUD (delete / edit items)
   *  against the real home even when cross-space-homed, without a second round-trip. */
  homeSpace: z.string(),
  items: z.array(ContextSetItemSchema),
  /** POSITION in the scope's ONE pin+set sequence — same rank space as
   *  {@link ContextPinSchema.order}, so the client interleaves pins and sets. Server-curated. */
  order: z.number().int(),
})

/** One entry of a scope's ordered pin+set sequence: kind + stable ref (a pin's note
 *  id / a set's id). A reorder PUT carries the WHOLE new sequence — the server replaces the
 *  order overlay atomically (rank = array index), so a partial write can't leave a torn
 *  order. Entries the scope no longer holds are ignored. */
export const ContextOrderEntrySchema = z.object({
  kind: ContextEntryKindSchema,
  ref: z.string(),
})

// Bounded like every sibling bulk array (a scope's pin+set list is dozens; the cap is an
// anti-pathological backstop so a self:manage caller can't drive a giant replace-all write).
export const ContextOrderRequestSchema = z.object({
  entries: z.array(ContextOrderEntrySchema).max(1000),
})

/** Reorder the ITEMS inside a set: the full new sequence of the set's note ids.
 *  A set's item order is a property of the set (shared across every scope it attaches to),
 *  so this is a home-space write, not a per-scope overlay. */
export const ContextSetOrderRequestSchema = z.object({ noteIds: z.array(z.string()).max(1000) })

export const ContextSetCreateRequestSchema = z.object({ name: z.string().min(1).max(200) })

export const ContextSetPatchRequestSchema = z.object({ name: z.string().min(1).max(200) })

/** Add a cross-space ref to a set: the item's space (slug) + its note id. */
export const ContextSetItemRequestSchema = z.object({ space: z.string(), noteId: z.string() })

/** Pin a note into a scope from ANY readable space: the note's space slug + id.
 *  A note in the scope's own space prefers the location-bound `always-load` tag;
 *  a foreign space becomes a scope-pin ref. Must be reachable by the caller; its
 *  authoritative space is re-derived server-side, never trusted from here. */
export const ContextPinRequestSchema = z.object({ space: z.string(), noteId: z.string() })

/** GET /api/me/agent-context — the PERSONAL scope: the eager personal context under
 *  ONE token budget `P` — curated pins + eager memory, each with a server-derived `loaded`
 *  (pins load first, then memory; the strict prefix that fits `P` is eager, rest trimmed).
 *  ONE budget, not a per-channel split. Memory AUDIT stays at /api/me/memory. Read-only;
 *  `self:read`. */
export const MeAgentContextResponseSchema = z.object({
  /** Curated pins, loaded-first under `P` (a bloated pin over the budget = loaded:false). */
  pins: z.array(ContextPinSchema),
  /** Eager memory categories, loaded after the pins under the same `P` budget. */
  memory: z.array(ContextMemorySchema),
  /** Attached context sets, resolved under this viewer + weighed against `P`.
   *  Their items load AFTER the local pins, BEFORE memory (specific > general); items
   *  the viewer can't reach are omitted (the preview mirrors the agent's real load). */
  sets: z.array(ContextSetViewSchema),
  /** The token scale, server-derived so the human sees the agent's EXACT cost:
   *  `loadedTokens` = pins+memory that fit `P`; `totalTokens` = every active (non-muted)
   *  pin+memory weight; `budgetTokens` (`P`) echoed from server config (one source of
   *  truth) so the UI draws its bar without baking in a number. */
  loadedTokens: z.number().int(),
  totalTokens: z.number().int(),
  budgetTokens: z.number().int(),
})

/** GET /api/s/<slug>/projects/<id>/agent-context — the PROJECT scope under ONE
 *  project budget `Q`. Project pins load FIRST (specific outranks general), then the
 *  PERSONAL background embeds into the `Q` remainder — same notes as /api/me/agent-context
 *  but `loaded` recomputed against the smaller budget. About-project memory stays
 *  recall-on-demand, OFF this budget. Plus the read-only AUTO index. `space:read`;
 *  anti-enumeration 404 like its memory twin. Preview does not call MCP delta persistence. */
export const ProjectAgentContextResponseSchema = z.object({
  /** The project's curated pins, loaded-first under `Q`. */
  pins: z.array(ContextPinSchema),
  /** The project's attached context sets, loaded after the project pins,
   *  before the embedded personal background — resolved under this viewer. */
  sets: z.array(ContextSetViewSchema),
  /** The tokens the project's own loaded pins + sets take of `Q` (the rest is left for personal). */
  projectLoadedTokens: z.number().int(),
  /** The personal background embedded into `Q`'s remainder — the same pins+sets+memory
   *  as the personal scope, re-curated against `Q − projectLoaded` (project-first). */
  personal: z.object({
    pins: z.array(ContextPinSchema),
    sets: z.array(ContextSetViewSchema),
    memory: z.array(ContextMemorySchema),
    loadedTokens: z.number().int(),
  }),
  /** The joint token scale: `loadedTokens` = project + personal that fit `Q`,
   *  `totalTokens` = every eager weight in play (project pins + personal pins+memory),
   *  `budgetTokens` = `Q` (echoed from config, per-project override later). */
  loadedTokens: z.number().int(),
  totalTokens: z.number().int(),
  budgetTokens: z.number().int(),
  index: z.object({
    noteCount: z.number().int(),
    folderCount: z.number().int(),
  }),
})
export type PinnedNote = z.infer<typeof PinnedNoteSchema>

export type ContextPin = z.infer<typeof ContextPinSchema>

export type ContextMemory = z.infer<typeof ContextMemorySchema>

export type ContextSetRef = z.infer<typeof ContextSetRefSchema>

export type ContextSetAttachment = z.infer<typeof ContextSetAttachmentSchema>

export type ContextSet = z.infer<typeof ContextSetSchema>

export type ContextSetsResponse = z.infer<typeof ContextSetsResponseSchema>

export type ContextSetResponse = z.infer<typeof ContextSetResponseSchema>

export type ContextSetItem = z.infer<typeof ContextSetItemSchema>

export type ContextSetView = z.infer<typeof ContextSetViewSchema>

export type ContextSetCreateRequest = z.infer<typeof ContextSetCreateRequestSchema>

export type ContextSetPatchRequest = z.infer<typeof ContextSetPatchRequestSchema>

export type ContextSetItemRequest = z.infer<typeof ContextSetItemRequestSchema>

export type ContextPinRequest = z.infer<typeof ContextPinRequestSchema>

export type ContextOrderEntry = z.infer<typeof ContextOrderEntrySchema>

export type ContextOrderRequest = z.infer<typeof ContextOrderRequestSchema>

export type ContextSetOrderRequest = z.infer<typeof ContextSetOrderRequestSchema>

export type MeAgentContext = z.infer<typeof MeAgentContextResponseSchema>

export type ProjectAgentContext = z.infer<typeof ProjectAgentContextResponseSchema>
