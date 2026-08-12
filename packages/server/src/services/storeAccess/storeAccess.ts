// Resource → store resolution, transport-agnostic: REST and the MCP gateway
// resolve a note's store through ONE enforcement path here.
// canon: docs/spaces.md#server · docs/auth.md#model
//
// noteStore is the note-resource authz chokepoint: the identity registry — NEVER a
// caller-supplied value — decides the note's space, and can() runs against THAT.
// Unknown id, foreign space and tombstone collapse to one null → typed 404
// (anti-enumeration). id-addressed routes declare resource:'note' and defer their
// check here, since it can only be made once the store is resolved.

import { type Action, can, type Principal } from '../authz'
import type {
  ContextOrderPersistence,
  ContextSetsPersistence,
  ContextSetTargetKind,
  ScopePinsPersistence,
} from '../metaDb'
import {
  resolveContextSets,
  resolveScopePins,
  type ScopeOrder,
  type SpaceManager,
  spaceNotFound,
  type SpaceStore,
  type WeighedSet,
  type WeighedSetItem,
} from '../spaces'

/** A note's resolved, access-checked store and its registry-assigned space id. */
export type NoteAccess = { store: SpaceStore; space: string }

/** A live note resolved through the registry and then re-read from its owning store.
 *  `noteId` is the authoritative identity returned by the read-model; during a cold
 *  identity sweep it may differ from the provisional id the caller supplied. */
export type LiveNoteAccess = NoteAccess & {
  noteId: string
  note: Awaited<ReturnType<SpaceStore['read']>>
}

export type StoreAccess = {
  /** Space id (already resolved from the URL slug) → live store; throws the typed
   *  not-found (→ 404) for an unknown id (anti-enumeration). */
  spaceStore(id: string): Promise<SpaceStore>
  /** id → (store, space), enforcing `action` on the registry's space. null =
   *  unknown id / foreign space / no store, all mapped to one typed 404. Tombstones
   *  resolve; the read path decides what a deleted note answers. */
  noteStore(principal: Principal, id: string, action: Action): Promise<NoteAccess | null>
}

/** Bind the resolvers to a space layer once per app. */
export const createStoreAccess = (spaces: SpaceManager): StoreAccess => ({
  spaceStore: async (id) => {
    // In AUTH_MODE=none this is the sole gate (can() rejects nothing); shared
    // spaceNotFound keeps the not-found envelope identical to SpaceManager's.
    if (!id || !spaces.has(id)) {
      throw spaceNotFound(id)
    }

    return spaces.store(id)
  },

  noteStore: async (principal, id, action) => {
    const resolved = await spaces.resolveNote(id)

    if (!resolved) {
      return null
    }
    if (!can(principal, action, { space: resolved.space })) {
      return null
    }

    return { store: await spaces.store(resolved.space), space: resolved.space }
  },
})

/** Resolve, authorise and read a live note in one shared identity chokepoint.
 *  Persistence producers must store `noteId`, never the caller's possibly
 *  provisional address. Unknown, inaccessible, vanished and tombstoned notes all
 *  collapse to null (the same anti-enumeration contract as noteStore). */
export const readNoteAccess = async (
  access: StoreAccess,
  principal: Principal,
  id: string,
  action: Action,
): Promise<LiveNoteAccess | null> => {
  const hit = await access.noteStore(principal, id, action)

  if (!hit) {
    return null
  }
  const note = await hit.store.read(id).catch(() => null)

  if (!note || note.deleted) {
    return null
  }

  return { ...hit, noteId: note.id ?? id, note }
}

/** Deps for a scope-curation resolve; the cross-space registries are absent on a
 *  meta-DB-less host. */
type ScopeResolveDeps = {
  store: StoreAccess
  spaces: SpaceManager
  contextSets?: ContextSetsPersistence
  scopePins?: ScopePinsPersistence
  contextOrder?: ContextOrderPersistence
}

/** Per-reader note reader for cross-space resolution: unreachable refs (unknown id /
 *  foreign space / tombstone) degrade to null — the shared path so the human preview
 *  and the agent bundle drop the exact same refs (P5).
 *  canon: docs/architecture.md#p5 */
const scopeNoteReader =
  (deps: ScopeResolveDeps, principal: Principal) => async (noteId: string) => {
    const hit = await readNoteAccess(deps.store, principal, noteId, 'note:read')

    if (!hit) {
      return null
    }

    return {
      noteId: hit.noteId,
      content: hit.note.content ?? '',
      title: hit.note.title ?? '',
      spaceSlug: deps.spaces.slugOf(hit.space) ?? hit.space,
      filePath: hit.note.filePath ?? '',
    }
  }

/** Resolve + weigh a scope's context sets under one reader (survivors weighed by
 *  body); no registry → no sets.
 *  canon: docs/projects.md#context-sets-209-reusable-cross-space-bundles */
export const weighScopeContextSets = async (
  deps: ScopeResolveDeps,
  principal: Principal,
  target: { kind: ContextSetTargetKind; id: string },
): Promise<WeighedSet[]> => {
  if (!deps.contextSets) {
    return []
  }
  const sets = await deps.contextSets.setsForTarget(target.kind, target.id)

  if (sets.length === 0) {
    return []
  }
  const resolved = await resolveContextSets(sets, scopeNoteReader(deps, principal))
  // homeSpace is emitted as the SLUG (web CRUD addresses the set through /api/s/:space,
  // which resolves slugs only; the record stores the opaque id — id!=slug on a meta-DB host).
  // SECURITY: blank it for a reader who can't space:read the home space rather than disclose
  // a space they aren't in (the set row still shows its name + reachable items).
  return resolved.map((s) => ({
    ...s,
    homeSpace: can(principal, 'space:read', { space: s.homeSpace })
      ? (deps.spaces.slugOf(s.homeSpace) ?? s.homeSpace)
      : '',
  }))
}

/** Resolve + weigh a scope's LOOSE cross-space pins under one reader (same honest
 *  degradation as sets); no registry → no loose pins (the same-space `always-load`
 *  tag still works).
 */
export const weighScopePins = async (
  deps: ScopeResolveDeps,
  principal: Principal,
  target: { kind: ContextSetTargetKind; id: string },
): Promise<WeighedSetItem[]> => {
  if (!deps.scopePins) {
    return []
  }
  const pins = await deps.scopePins.pinsForTarget(target.kind, target.id)

  if (pins.length === 0) {
    return []
  }

  return resolveScopePins(
    pins.map((p) => p.noteId),
    scopeNoteReader(deps, principal),
  )
}

/** A scope's user-defined order overlay (pin+set entries in rank order). No registry
 *  → empty, and curation falls back to the default sequence (pins then sets). */
export const weighScopeOrder = async (
  deps: ScopeResolveDeps,
  target: { kind: ContextSetTargetKind; id: string },
): Promise<ScopeOrder> => {
  if (!deps.contextOrder) {
    return []
  }
  const rows = await deps.contextOrder.orderForTarget(target.kind, target.id)
  return rows.map((r) => ({ kind: r.entryKind, ref: r.entryRef }))
}
