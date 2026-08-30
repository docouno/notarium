// Resource → store resolution, transport-agnostic: REST and the MCP gateway
// resolve a note's store through ONE enforcement path here.
// canon: docs/spaces.md#server · docs/auth.md#model
//
// noteStore is the note-resource authz chokepoint: the identity registry — NEVER a
// caller-supplied value — decides the note's space, and can() runs against THAT.
// Unknown id, foreign space and tombstone collapse to one null → typed 404
// (anti-enumeration). id-addressed routes declare resource:'note' and defer their
// check here, since it can only be made once the store is resolved.

import { type NoteClass, type NoteMeta, READ_SCOPE } from '@notarium/core'

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
  type ScopeSetRefs,
  type SpaceManager,
  spaceNotFound,
  type SpaceStore,
  type WeighedSet,
  type WeighedSetItem,
} from '../spaces'

/** A note's resolved, access-checked store and its registry-assigned space id. */
export type NoteAccess = {
  store: SpaceStore
  space: string
  noteId?: string
  filePath?: string
  deletedAt?: string | null
}

/** A live note resolved through the registry and then re-read from its owning store.
 *  `noteId` is the authoritative identity returned by the read-model; during a cold
 *  identity sweep it may differ from the provisional id the caller supplied. */
export type LiveNoteAccess = NoteAccess & {
  noteId: string
  note: Awaited<ReturnType<SpaceStore['read']>>
}

export type LiveNoteMetaAccess = NoteAccess & { noteId: string; meta: NoteMeta }

export type StoreAccess = {
  /** Space id (already resolved from the URL slug) → live store; throws the typed
   *  not-found (→ 404) for an unknown id (anti-enumeration). */
  spaceStore(id: string): Promise<SpaceStore>
  /** id → (store, space), enforcing `action` on the registry's space. null =
   *  unknown id / foreign space / no store, all mapped to one typed 404. Tombstones
   *  resolve; the read path decides what a deleted note answers. */
  noteStore(principal: Principal, id: string, action: Action): Promise<NoteAccess | null>
  /** Exact multi-id lookup. Optional for narrow test/fake ports; production batches
   * identity rows and boots each owning store once. */
  noteStores?(
    principal: Principal,
    ids: readonly string[],
    action: Action,
  ): Promise<Map<string, NoteAccess>>
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

    let store: SpaceStore

    try {
      store = await spaces.store(resolved.space)
    } catch (error) {
      if ((error as { isNotFound?: boolean }).isNotFound) {
        return null
      }
      throw error
    }

    return {
      store,
      space: resolved.space,
      noteId: resolved.id,
      filePath: resolved.filePath,
      deletedAt: resolved.deletedAt,
    }
  },
  noteStores: async (principal, ids, action) => {
    const resolved = await spaces.resolveNotes(ids)
    const stores = new Map<string, Promise<SpaceStore | null>>()
    const result = new Map<string, NoteAccess>()

    for (const [requestedId, note] of resolved) {
      if (!can(principal, action, { space: note.space })) {
        continue
      }
      let store = stores.get(note.space)

      if (!store) {
        store = spaces.store(note.space).catch((error) => {
          if ((error as { isNotFound?: boolean }).isNotFound) {
            return null
          }
          throw error
        })
        stores.set(note.space, store)
      }
      const liveStore = await store

      if (liveStore) {
        result.set(requestedId, {
          store: liveStore,
          space: note.space,
          noteId: note.id,
          filePath: note.filePath,
          deletedAt: note.deletedAt,
        })
      }
    }

    return result
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
  let note: Awaited<ReturnType<typeof hit.store.read>>

  try {
    note = await hit.store.read(hit.noteId ?? id)
  } catch (error) {
    if ((error as { isNotFound?: boolean }).isNotFound) {
      return null
    }
    throw error
  }

  if (note.deleted) {
    return null
  }

  return { ...hit, noteId: note.id ?? id, note }
}

/** Resolve, authorise and find a live note in the read-model inventory without
 * opening its body. The optional map is request-scoped so many set items in one
 * space pay one snapshot list. A miss is honest degradation to readNoteAccess. */
export const metaNoteAccess = async (
  access: StoreAccess,
  principal: Principal,
  id: string,
  action: Action,
  inventories: Map<SpaceStore, Promise<Map<string, NoteMeta>>> = new Map(),
): Promise<LiveNoteMetaAccess | null> => {
  const hit = await access.noteStore(principal, id, action)

  if (!hit) {
    return null
  }
  if (typeof hit.store.list !== 'function') {
    return null
  }
  let inventory = inventories.get(hit.store)

  if (!inventory) {
    inventory = hit.store
      .list({ scope: READ_SCOPE.all })
      .then((metas) => new Map(metas.flatMap((meta) => (meta.id ? [[meta.id, meta]] : []))))
    inventories.set(hit.store, inventory)
  }
  const meta = (await inventory).get(id)

  return meta ? { ...hit, noteId: meta.id ?? id, meta } : null
}

/** Resolve authoritative identity and access through the exact registry row without
 * snapshotting the owning store or opening the note body. */
export const canonicalMetaNoteAccess = async (
  access: StoreAccess,
  principal: Principal,
  id: string,
  action: Action,
): Promise<(NoteAccess & { noteId: string }) | null> => {
  const hit = await access.noteStore(principal, id, action)

  if (!hit) {
    return null
  }
  if (hit.deletedAt) {
    const live = await readNoteAccess(access, principal, id, action)

    return live ? { store: live.store, space: live.space, noteId: live.noteId } : null
  }

  return { ...hit, noteId: hit.noteId ?? id }
}

/** Batch twin for bulk doors. Exact live rows stay body-free; only tombstones pay
 * their bounded successor read fallback. The result keys are caller-requested ids. */
export const canonicalMetaNoteAccessMany = async (
  access: StoreAccess,
  principal: Principal,
  ids: readonly string[],
  action: Action,
): Promise<Map<string, NoteAccess & { noteId: string }>> => {
  let hits: Map<string, NoteAccess>

  if (access.noteStores) {
    hits = await access.noteStores(principal, ids, action)
  } else {
    hits = new Map()
    for (const id of new Set(ids)) {
      const hit = await access.noteStore(principal, id, action)

      if (hit) {
        hits.set(id, hit)
      }
    }
  }
  const result = new Map<string, NoteAccess & { noteId: string }>()

  for (const [requestedId, hit] of hits) {
    if (hit.deletedAt) {
      const live = await readNoteAccess(access, principal, requestedId, action)

      if (live) {
        result.set(requestedId, { store: live.store, space: live.space, noteId: live.noteId })
      }
    } else {
      result.set(requestedId, { ...hit, noteId: hit.noteId ?? requestedId })
    }
  }

  return result
}

/** Deps for a scope-curation resolve; the cross-space registries are absent on a
 *  meta-DB-less host. */
type ScopeResolveDeps = {
  store: StoreAccess
  spaces: SpaceManager
  contextSets?: ContextSetsPersistence
  scopePins?: ScopePinsPersistence
  contextOrder?: ContextOrderPersistence
  /** Optional consumer policy after access resolution. Human REST omits it; the
   * MCP assembly uses it to keep transport-specific classes out of its bundle. */
  noteClassAllowed?: (noteClass: NoteClass | undefined) => boolean
}

/** Per-reader note reader for cross-space resolution: unreachable refs (unknown id /
 *  foreign space / tombstone) degrade to null — the shared path so the human preview
 *  and the agent bundle drop the exact same refs (P5).
 *  canon: docs/architecture.md#p5 */
const scopeNoteReader = (deps: ScopeResolveDeps, principal: Principal) => {
  return async (noteId: string) => {
    const access = await deps.store.noteStore(principal, noteId, 'note:read')

    if (access && access.deletedAt == null) {
      const canonicalId = access.noteId ?? noteId
      const fact = access.store.noteFacts
        ? (await access.store.noteFacts([canonicalId]))[canonicalId]
        : undefined

      if (
        fact &&
        access.filePath !== undefined &&
        (!deps.noteClassAllowed ||
          (fact.noteClass !== undefined && deps.noteClassAllowed(fact.noteClass)))
      ) {
        return {
          noteId: canonicalId,
          tokens: fact.bodyTokens,
          title: fact.title,
          spaceSlug: deps.spaces.slugOf(access.space) ?? access.space,
          filePath: access.filePath,
        }
      }
    }
    const hit = await readNoteAccess(deps.store, principal, noteId, 'note:read')

    if (!hit || (deps.noteClassAllowed && !deps.noteClassAllowed(hit.note.class))) {
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
}

/** Resolve + weigh a scope's context sets under one reader (survivors weighed by
 *  body); no registry → no sets.
 *  canon: docs/projects.md#context-sets-209-reusable-cross-space-bundles */
export const weighScopeContextSets = async (
  deps: ScopeResolveDeps,
  principal: Principal,
  target: { kind: ContextSetTargetKind; id: string },
): Promise<ScopeSetRefs[]> => {
  if (!deps.contextSets) {
    return []
  }
  const sets = await deps.contextSets.setsForTarget(target.kind, target.id)

  if (sets.length === 0) {
    return []
  }
  const read = scopeNoteReader(deps, principal)
  return sets.map((set) => {
    const coordinatesVisible = can(principal, 'space:read', { space: set.homeSpace })

    return {
      id: set.id,
      name: set.name,
      homeSpace: coordinatesVisible ? (deps.spaces.slugOf(set.homeSpace) ?? set.homeSpace) : '',
      items: set.items,
      read,
      coordinatesVisible,
    }
  })
}

/** The unbudgeted role-identity editor keeps the historical full projection. It is
 * deliberately separate from the lazy budget producer above so pagination/counters do
 * not leak into the identity wire. */
export const resolveScopeContextSets = async (
  deps: ScopeResolveDeps,
  principal: Principal,
  target: { kind: ContextSetTargetKind; id: string },
): Promise<WeighedSet[]> => {
  if (!deps.contextSets) {
    return []
  }
  const sets = await deps.contextSets.setsForTarget(target.kind, target.id)
  const resolved = await resolveContextSets(sets, scopeNoteReader(deps, principal))

  return resolved.map((set) => ({
    ...set,
    homeSpace: can(principal, 'space:read', { space: set.homeSpace })
      ? (deps.spaces.slugOf(set.homeSpace) ?? set.homeSpace)
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
