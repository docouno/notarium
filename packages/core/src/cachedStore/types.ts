import type {
  IdentityPersistence,
  KnowledgeStore,
  RevisionPersistence,
  StoreEvent,
} from '../knowledgeStore'
import type { BackgroundSchedulerPort } from '../libs/backgroundScheduler'
import type { FolderAlias } from '../referenceResolver'

export type CachedStoreOptions = {
  /** The engine being decorated. */
  inner: KnowledgeStore
  /** Where the identity registry (P7: note-id ↔ file_path, first-seen dates)
   *  persists — the meta-DB layer. Optional CAPABILITY: without it the
   *  registry is ephemeral (auto-ids regenerate per process; materialized
   *  frontmatter ids still re-adopt on every boot sweep) — honest degradation,
   *  not an error. */
  identityPersistence?: IdentityPersistence
  /** Where the revision journal persists — the meta-DB's second tenant.
   *  Optional CAPABILITY with the same degradation contract as identity:
   *  without it the journal runs in memory and the history lives for the
   *  process lifetime — never an error, never a dead store. */
  revisionPersistence?: RevisionPersistence
  /** The space the decorated engine serves — stamped
   *  on every registry row so id → (space, path) keeps resolving globally once
   *  there is more than one space. Defaults to 'main'. */
  space?: string
  /** External-change poll period in ms; 0 disables the periodic poll (one-shot
   *  reconciles after directory moves still run). */
  pollIntervalMs?: number
  /** Debounce before the background graph re-enrichment (communities+layout)
   *  starts chasing a changed snapshot (SWR). Defaults to 2s; tests pass
   *  something tiny. */
  graphDebounceMs?: number
  /** Edge type for body-derived links — match what the engine's boot graph
   *  uses so patched and swept edges dedupe against each other. */
  relationType?: string
  /** LRU cap of the preview cache — derived previews are ~2-3KB each, so
   *  the default bounds the cache at tens of MB on a huge base. */
  previewCacheSize?: number
  /** Read a note's RAW markdown straight from storage (the storage-adapter
   *  seam, P5): given the engine's file_path, the file's bytes — or null when
   *  the file isn't there. Optional CAPABILITY, not a requirement: a host
   *  whose files are local (desktop, server with the notes dir mounted) wires
   *  it and cold previews cost a file read (~ms) instead of a serialized
   *  engine round-trip (~180ms on the prior engine); a host fronting a remote engine leaves
   *  it unset and the engine path serves, just slower. Any error/null falls
   *  back to the engine — this can make things faster, never wronger. */
  readBody?: (filePath: string) => Promise<string | null>
  /** Whether raw reads are also evidence for the CachedStore identity arbiter.
   * Defaults true. A host whose inner engine already owns and materializes identity may
   * set false while still using raw reads for facts/previews; this avoids two owners. */
  readBodyIdentityClaims?: boolean
  /** The space's folder path-history: identified folders' current→past
   *  path pairs, injected from the server's folder registry (the engine doesn't
   *  read the `.notariummeta` markers folder identity lives in, so the read-model
   *  is where `[[oldpath/note]]` heals — buildLinkIndex gets these as alias keys).
   *  Refetched at boot and each poll; absent (the bare engine / fake) ⇒ none. */
  folderAliases?: () => Promise<FolderAlias[]>
  /** The process-global background scheduler. A streaming import contributes an
   *  interactive signal, while graph enrichment consumes background turns alongside
   *  engine backfill in every space. Absent (bare/fake) ⇒ local event-loop yields only. */
  scheduler?: BackgroundSchedulerPort
  /** Clock, injectable for deterministic tests. */
  now?: () => Date
}

export type StoreEventListener = (event: StoreEvent) => void

export type Unsubscribe = () => void
