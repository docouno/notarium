import type {
  KnowledgeStore,
  NoteContent,
  StoreEvent,
  TagMutationInput,
  TagMutationResult,
} from '@notarium/core'

import type { MetaDb, SpaceRecord } from '../metaDb'
import type { SpaceMarkerFacet } from '../projects'

/** A space's live store: the KnowledgeStore port + optional read-model lifecycle/bus. */
export type SpaceStore = KnowledgeStore & {
  /** Host-internal metadata delta owned by CachedStore's note mutation fence. */
  mutateTags(input: TagMutationInput): Promise<TagMutationResult>
  /** Host compound operation under one stable exact note/path claim. */
  withExactNoteClaim<T>(noteId: string, task: (current: NoteContent) => Promise<T>): Promise<T>
  start?(): Promise<void>
  /** Await the note-id registry checkpoint after a lazy boot. Global id routing
   * uses this before handing the store to an ordinary read. */
  identityReady?(): Promise<void>
  stop?(): void
  settle?(): Promise<void>
  checkpoint?(): Promise<void>
  /** Re-read committed physical truth into this process-local projection. */
  reconcile?(): Promise<void>
  /** Re-fetch and install an identity row committed by a cross-system terminal transaction. */
  adoptCausalIdentity?(noteId: string): void | Promise<void>
  subscribe?(listener: (event: StoreEvent) => void): () => void
}

/** A space as the host config declares it — the input shape SpaceManager resolves
 *  to a full SpaceRecord at provision. */
export type SpaceDef = {
  slug: string
  displayName: string
}

/** A space folder found on disk by the discovery walk, ready to adopt into the registry.
 *  canon: docs/spaces.md#model */
export type DiscoveredSpace = {
  id: string
  slug: string
  aliases: string[]
  notesDir: string
  displayName: string
}

export type SpaceManagerOptions = {
  /** The spaces this host serves, in display order. MAY be empty (a fresh password
   *  host has no users, hence no spaces); no host-global "default" space exists. */
  spaces: SpaceDef[]
  /** Space to adopt legacy meta-DB rows (`space=''`) into on boot; idempotent.
   *  Absent ⇒ skip (modern deploys have no such rows). */
  adoptLegacyInto?: string
  /** Refuses removal of a user's personal space. Injected by the composition root
   *  (auth owns the answer). Absent ⇒ no personal-space protection (none-mode). */
  isPersonalSpace?: (id: string) => Promise<boolean>
  /** Build the live store for one space. Called at most once per space per process
   *  lifetime (eviction re-creates on next access). */
  createStore: (rec: SpaceRecord) => SpaceStore | Promise<SpaceStore>
  /** Mint a brand-new space at runtime; returns the ACTUAL physical folder name
   *  created (suffixed if a freed dir already occupied it — folder name ≠ slug).
   *  Absent = capability `spaceCreate: false`. */
  createSpace?: (rec: SpaceRecord) => Promise<string | void>
  /** Dynamic gate over createSpace. Default: createSpace's presence. */
  spaceCreateEnabled?: () => boolean
  /** The meta-DB (space registry rows + legacy-row adoption). Without it, spaces
   *  exist only as config. */
  metaDb?: MetaDb
  /** Evict an idle space's read-model after this many ms without requests; 0 = never.
   *  A space with live SSE subscribers is never evicted (events originate from its store). */
  idleEvictMs?: number
  /** Fired ONCE, when a space's meta-DB registry row is first inserted — NOT on
   *  re-registration / restart recovery, so a later human undo is respected.
   *  Best-effort: its failure never blocks provisioning. */
  onProvision?: (rec: SpaceRecord) => Promise<void>
  /** Destroy a space's on-disk artefacts (notes dir + derived engine index) at
   *  permanent purge; meta-DB rows are wiped separately by metaDb.purgeSpace.
   *  Best-effort: a filesystem blip must never wedge the purge (rows are already
   *  gone, orphaned files are harmless). */
  onPurge?: (rec: SpaceRecord) => Promise<void>
  /** Close fresh physical admission and wait for work accepted before the durable
   * lifecycle fence. Idempotent; the authority remains closed until reopen. */
  closeResourceAdmission?: (space: string, deadlineMs: number) => Promise<void>
  /** Reopen a previously archived space's process-local physical authority. */
  reopenResourceAdmission?: (space: string) => void
  /** Bound one archive drain attempt. Timeout leaves the durable `closing` phase
   * in place so startup or a later request can resume it. */
  lifecycleDrainMs?: number
  /** Read a config space's root `.notariummeta` `space` facet so init() can adopt
   *  its marker-borne id into an empty registry. Absent ⇒ no adoption: provision
   *  mints a fresh id. */
  readSpaceFacet?: (def: SpaceDef) => Promise<SpaceMarkerFacet | undefined>
  /** Enumerate runtime space folders on disk carrying a root `space` facet, so init()
   *  can adopt their marker-borne id into an empty registry. Config-space dirs are
   *  excluded (they adopt via readSpaceFacet). Absent ⇒ no disk discovery.
   */
  discoverDiskSpaces?: () => Promise<DiscoveredSpace[]>
  now?: () => Date
}
