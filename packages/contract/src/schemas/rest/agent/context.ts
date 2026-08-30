import { z } from 'zod'
import { CONTEXT_ENTRY_KIND, CONTEXT_KIND } from '../../../consts/context'
import { ROLE_SCOPE } from '../../../consts/primitives'
import { enumValues } from '../../../libs/enumValues'
import { OwnedRoleAbilityLocatorSchema } from './abilities'
import { MemoryCategorySchema } from './memory'
import { EffectiveOwnedRoleSummarySchema } from './roles'

/** Where a context facet is attached: base Personal/Project or one exact owned role. */
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
  /** Derived from the access-resolved storage path. `true` means this one note is a
   *  folder's `index.md` overview; it never means the folder contents are included. */
  folderOverview: z.literal(true).optional(),
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

/** One raw note reference inside a set as its MANAGER sees it (home-space CRUD).
 * Presentation and per-reader degradation belong to the paginated item door. */
export const ContextSetStoredRefSchema = z.object({ noteId: z.string() })

/** One requested audit-page row. Nullable presentation keeps the raw membership
 * removable without turning a missing or inaccessible note into an oracle. */
const ContextSetPageItemBaseSchema = z.object({
  sourceIndex: z.number().int().nonnegative(),
  noteId: z.string(),
})

export const ContextSetPageItemSchema = z.union([
  ContextSetPageItemBaseSchema.extend({ space: z.string(), title: z.string() }),
  ContextSetPageItemBaseSchema.extend({ space: z.null(), title: z.null() }),
])

/** Where a set is attached (its scope binding). `label` is a per-reader safe display
 * handle for Personal, Project, or an exact owned role placement. */
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
  items: z.array(ContextSetStoredRefSchema),
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
 *  home slug. With home coordinates visible, inherited `order` mirrors the raw source
 *  index for compatibility; otherwise it is dense presentation order and reveals no gap.
 *  `sourceIndex` is the explicit coordinate used to merge an overlapping audit page.
 *  The load-bearing group `order` is on the top-level set. */
export const ContextSetItemSchema = ContextPinSchema.extend({
  space: z.string(),
  /** Raw membership coordinate. Omitted with total/cursor when the home space is hidden. */
  sourceIndex: z.number().int().nonnegative().optional(),
})

export const ContextSetBaseViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The set's HOME space slug — lets a scope panel address its CRUD (delete / edit items)
   *  against the real home even when cross-space-homed, without a second round-trip. */
  homeSpace: z.string(),
  /** POSITION in the scope's ONE pin+set sequence — same rank space as
   *  {@link ContextPinSchema.order}, so the client interleaves pins and sets. Server-curated. */
  order: z.number().int(),
})

const ContextSetViewFields = {
  itemsLoaded: z.number().int().nonnegative(),
  /** Hard token/curation/resolve stop; access-only degradation remains neutral. */
  trimmed: z.boolean(),
}

const ContextSetCoordinateItemSchema = ContextSetItemSchema.extend({
  sourceIndex: z.number().int().nonnegative(),
})

const ContextSetHiddenItemSchema = ContextSetItemSchema.extend({
  sourceIndex: z.undefined().optional(),
})

/** Coordinate-bearing and no-home projections are separate executable variants:
 * a hidden home can never smuggle a denominator/cursor/item coordinate through parse. */
export const ContextSetViewSchema = z.union([
  ContextSetBaseViewSchema.extend({
    homeSpace: z.string().min(1),
    items: z.array(ContextSetCoordinateItemSchema),
    ...ContextSetViewFields,
    itemsTotal: z.number().int().nonnegative(),
    itemsCursor: z.number().int().nonnegative(),
  }),
  ContextSetBaseViewSchema.extend({
    homeSpace: z.literal(''),
    items: z.array(ContextSetHiddenItemSchema),
    ...ContextSetViewFields,
    itemsTotal: z.undefined().optional(),
    itemsCursor: z.undefined().optional(),
  }),
])

const RoleContextFieldsSchema = {
  pins: z.array(ContextPinSchema),
  sets: z.array(ContextSetViewSchema),
  loadedTokens: z.number().int(),
}

/** One exact, currently enabled owned Role placement available to the Context
 * constructor. Names are presentation only; every read and mutation is addressed by
 * the durable locator so same-name Personal/Space/Project placements cannot alias. */
export const ContextRoleSummarySchema = EffectiveOwnedRoleSummarySchema.extend({
  locator: OwnedRoleAbilityLocatorSchema,
})

/** The exact owned role placement selected by the effective-role resolver, plus its
 * role-only context layer after joint session-budget curation. Personal placements do
 * not reveal the private personal-space slug; shared placements carry the location the
 * constructor needs for set ownership and pin labels. */
export const RoleContextViewSchema = z.discriminatedUnion('scope', [
  ContextRoleSummarySchema.extend({
    scope: z.literal(ROLE_SCOPE.personal),
    ...RoleContextFieldsSchema,
  }),
  ContextRoleSummarySchema.extend({
    scope: z.literal(ROLE_SCOPE.space),
    space: z.string(),
    ...RoleContextFieldsSchema,
  }),
  ContextRoleSummarySchema.extend({
    scope: z.literal(ROLE_SCOPE.project),
    space: z.string(),
    project: z.string(),
    ...RoleContextFieldsSchema,
  }),
])

/** WHY the addressed role is not the one the agent would load here. `disabled` is the
 *  viewer's own Enable/Disable bit — a private READING preference. `out-of-reach` is
 *  about WHERE the caller is standing, and covers both of its halves: a placement this
 *  scope does not reach at all (a Space or Project role asked about from Personal), and
 *  a Space role narrowed away from this project. `unhealthy` is a role whose attachments
 *  no longer resolve, which resume refuses. All three leave the role EDITABLE: whether
 *  its shared context may be changed is a question about the space, not about whether
 *  this reader happens to load it. */
export const RoleInactiveReasonSchema = z.enum(['disabled', 'out-of-reach', 'unhealthy'])

/** The role layer as the surface that CONFIGURES it sees the pins: no `loaded`.
 *  The omission is the point and it is enforced by the type rather than promised in
 *  prose — `loaded` is a statement about a BUDGET, and this door weighs none. Saying
 *  "shown" and "paid for" with one value is exactly what made a preview report a
 *  personal always-load pin as dropped while the agent went on loading it. `tokens`
 *  stays: how heavy a note is belongs to the note, not to anyone's budget. */
export const ContextLayerPinSchema = ContextPinSchema.omit({ loaded: true })

export const ContextLayerSetViewSchema = ContextSetBaseViewSchema.extend({
  items: z.array(ContextSetItemSchema.omit({ loaded: true, sourceIndex: true })),
})

const RoleContextLayerFieldsSchema = {
  pins: z.array(ContextLayerPinSchema),
  sets: z.array(ContextLayerSetViewSchema),
}

/** The role an address NAMES, with its own editable layer. Same identity fields as
 * {@link RoleContextViewSchema}, minus every budget word — no `loaded`, no
 * `loadedTokens`. */
export const RoleContextIdentitySchema = z.discriminatedUnion('scope', [
  ContextRoleSummarySchema.extend({
    scope: z.literal(ROLE_SCOPE.personal),
    ...RoleContextLayerFieldsSchema,
  }),
  ContextRoleSummarySchema.extend({
    scope: z.literal(ROLE_SCOPE.space),
    space: z.string(),
    ...RoleContextLayerFieldsSchema,
  }),
  ContextRoleSummarySchema.extend({
    scope: z.literal(ROLE_SCOPE.project),
    space: z.string(),
    project: z.string(),
    ...RoleContextLayerFieldsSchema,
  }),
])

/** `GET /api/me/agent-roles/:locator/context` — the IDENTITY door.
 *
 *  Two doors, because the two questions have different answers and different owners.
 *  "Which role does this address name, and may I configure it" is a question about the
 *  space: a member who switched a shared role off FOR THEMSELVES still configures its
 *  shared context, so this door answers whenever the caller may read the placement.
 *  "Does the agent load it here, and what does that cost" is a question about this
 *  reader, here, now — and it belongs to the preview door, which weighs a budget.
 *  One response answering both is what made the preview lie: the layer of a role the
 *  agent does not load was charged to the session budget and displaced a pin that IS
 *  loaded. */
export const MeRoleContextResponseSchema = z
  .object({
    role: RoleContextIdentitySchema,
    /** Would the agent load this role where the caller asked? Editing does not depend
     *  on it; it is here so the surface can SAY why, instead of showing a role the
     *  agent ignores as though it were live. */
    active: z.boolean(),
    inactive: RoleInactiveReasonSchema.optional(),
  })
  .strict()

/** Where the caller is standing, for the identity door. Reach is a question about a
 * project, so without one `out-of-reach` is not an answer this surface can give. */
export const RoleContextQuerySchema = z
  .object({ project: z.string().min(1).max(256).optional() })
  .strict()

/** Optional selector on a context preview. An unavailable/stale exact locator degrades to the
 * base preview while `roles` still carries the current bounded choices. */
export const AgentContextQuerySchema = z
  .object({ role: z.string().min(1).max(4096).optional() })
  .strict()

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

/** Reorder the visible ITEMS inside a set. Omitted membership keeps its current slot,
 *  so a bounded preview/page can reorder what it knows without fetching the whole set.
 *  A set's item order is shared across every scope it attaches to, therefore this is a
 *  home-space write rather than a per-scope overlay. */
export const ContextSetOrderRequestSchema = z.object({ noteIds: z.array(z.string()).max(1000) })

export const ContextSetCreateRequestSchema = z.object({ name: z.string().min(1).max(200) })

export const ContextSetPatchRequestSchema = z.object({ name: z.string().min(1).max(200) })

/** Add a cross-space ref to a set: the item's space (slug) + its note id. */
export const ContextSetItemRequestSchema = z.object({ space: z.string(), noteId: z.string() })

export const ContextSetItemsQuerySchema = z
  .object({
    offset: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()

export const ContextSetItemsResponseSchema = z.object({
  items: z.array(ContextSetPageItemSchema),
  total: z.number().int().nonnegative(),
})

export const ContextSetItemsAddRequestSchema = z.object({
  items: z.array(ContextSetItemRequestSchema).min(1).max(1000),
})

export const ContextSetItemAddFailureSchema = z.discriminatedUnion('reason', [
  z.object({
    id: z.string(),
    reason: z.literal('not_found'),
    error: z.literal('Note is unavailable'),
  }),
  z.object({
    id: z.string(),
    reason: z.literal('conflict'),
    error: z.literal('Reference changed while the set was updated'),
  }),
])

export const ContextSetItemsAddResponseSchema = z.object({
  ok: z.literal(true),
  added: z.array(z.string()),
  failed: z.array(ContextSetItemAddFailureSchema),
  set: ContextSetSchema,
})

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
  /** Effective roles in personal mode. The catalog is never included. */
  roles: z.array(ContextRoleSummarySchema),
  rolesTruncated: z.boolean().optional(),
  /** Present ONLY when the requested role is the one the agent would load here. Its
   * layer is loaded before Personal under the same `P` budget, so this preview mirrors
   * the agent's real load and nothing else. WHICH role an address names — a question
   * whose answer does not depend on whether this reader loads it — belongs to
   * `GET /api/me/agent-roles/:locator/context`, which makes no budget claim at all. */
  role: RoleContextViewSchema.optional(),
  /** Curated pins, loaded-first under `P` (a bloated pin over the budget = loaded:false). */
  pins: z.array(ContextPinSchema),
  /** Eager memory categories, loaded after the pins under the same `P` budget. */
  memory: z.array(ContextMemorySchema),
  /** Attached context sets, resolved under this viewer + weighed against `P`.
   *  Their items load AFTER the local pins, BEFORE memory (specific > general); items
   *  the viewer can't reach are omitted (the preview mirrors the agent's real load). */
  sets: z.array(ContextSetViewSchema),
  /** The token scale, server-derived so the human sees the agent's EXACT cost:
   *  `loadedTokens` = pins+memory that fit `P`; `budgetTokens` (`P`) is echoed from
   *  server config so the UI draws its bar without baking in a number. */
  loadedTokens: z.number().int(),
  budgetTokens: z.number().int(),
})

/** GET /api/s/<slug>/projects/<id>/agent-context — the PROJECT scope under ONE
 *  project budget `Q`. Project pins load FIRST (specific outranks general), then the
 *  PERSONAL background embeds into the `Q` remainder — same notes as /api/me/agent-context
 *  but `loaded` recomputed against the smaller budget. About-project memory stays
 *  recall-on-demand, OFF this budget. Plus the read-only AUTO index. `space:read`;
 *  anti-enumeration 404 like its memory twin. Preview does not call MCP delta persistence. */
export const ProjectAgentContextResponseSchema = z.object({
  /** Effective roles for this project (`Project > Space > Personal`). */
  roles: z.array(ContextRoleSummarySchema),
  rolesTruncated: z.boolean().optional(),
  /** Present ONLY when the requested role is the one the agent would load in this
   * project. Loaded before Project and Personal under the same `Q` budget. Identity —
   * which role the address names — is the other door's question. */
  role: RoleContextViewSchema.optional(),
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
   *  `budgetTokens` = `Q` (echoed from config, per-project override later). */
  loadedTokens: z.number().int(),
  budgetTokens: z.number().int(),
  index: z.object({
    noteCount: z.number().int(),
    folderCount: z.number().int(),
  }),
})
export type PinnedNote = z.infer<typeof PinnedNoteSchema>

export type ContextPin = z.infer<typeof ContextPinSchema>

export type ContextMemory = z.infer<typeof ContextMemorySchema>

export type ContextSetStoredRef = z.infer<typeof ContextSetStoredRefSchema>

export type ContextSetPageItem = z.infer<typeof ContextSetPageItemSchema>

export type ContextSetAttachment = z.infer<typeof ContextSetAttachmentSchema>

export type ContextSet = z.infer<typeof ContextSetSchema>

export type ContextSetsResponse = z.infer<typeof ContextSetsResponseSchema>

export type ContextSetResponse = z.infer<typeof ContextSetResponseSchema>

export type ContextSetItem = z.infer<typeof ContextSetItemSchema>

export type ContextSetView = z.infer<typeof ContextSetViewSchema>

export type RoleContextView = z.infer<typeof RoleContextViewSchema>

export type ContextLayerPin = z.infer<typeof ContextLayerPinSchema>

export type ContextLayerSetView = z.infer<typeof ContextLayerSetViewSchema>

export type RoleContextIdentity = z.infer<typeof RoleContextIdentitySchema>

export type MeRoleContext = z.infer<typeof MeRoleContextResponseSchema>

export type RoleContextQuery = z.infer<typeof RoleContextQuerySchema>

export type RoleInactiveReason = z.infer<typeof RoleInactiveReasonSchema>

export type ContextRoleSummary = z.infer<typeof ContextRoleSummarySchema>

export type AgentContextQuery = z.infer<typeof AgentContextQuerySchema>

export type ContextSetCreateRequest = z.infer<typeof ContextSetCreateRequestSchema>

export type ContextSetPatchRequest = z.infer<typeof ContextSetPatchRequestSchema>

export type ContextSetItemRequest = z.infer<typeof ContextSetItemRequestSchema>

export type ContextSetItemsQuery = z.infer<typeof ContextSetItemsQuerySchema>

export type ContextSetItemsResponse = z.infer<typeof ContextSetItemsResponseSchema>

export type ContextSetItemsAddRequest = z.infer<typeof ContextSetItemsAddRequestSchema>

export type ContextSetItemsAddResponse = z.infer<typeof ContextSetItemsAddResponseSchema>

export type ContextPinRequest = z.infer<typeof ContextPinRequestSchema>

export type ContextOrderEntry = z.infer<typeof ContextOrderEntrySchema>

export type ContextOrderRequest = z.infer<typeof ContextOrderRequestSchema>

export type ContextSetOrderRequest = z.infer<typeof ContextSetOrderRequestSchema>

export type MeAgentContext = z.infer<typeof MeAgentContextResponseSchema>

export type ProjectAgentContext = z.infer<typeof ProjectAgentContextResponseSchema>
