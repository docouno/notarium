// Copy identity for a Markdown-tree import: which identity each planned note
// writes under, and how the archive's internal exact links are repointed at it.
//
// Importing an archive — including one of our own exports — is a COPY, not a
// restore. A source file's `notarium-id` is read as a KEY and never as a claim:
// the copy gets a fresh identity, and every `[[notarium-id:…]]` link BETWEEN two
// notes of the same archive is rewritten to the identity its target actually
// received. A destination that already exists keeps the identity it already has;
// import refreshes a note, it does not re-identify one.
// canon: docs/import.md#importing-a-markdown-tree-302

import { freshNoteId, ImportError, type KnowledgeStore, READ_SCOPE } from '@notarium/core'

import { serializedImportPlanBytes } from '../../libs/importStaging'
import { safeRelAddress } from '../../libs/relPath'
import { MAX_MARKDOWN_TREE_METADATA_BYTES } from './consts'
import { underRoot } from './helpers'
import {
  type MarkdownTreePlanEntry,
  type MarkdownTreePlanV1,
  RESERVATION_OWNERSHIP,
  type SettledMarkdownTreePlanV1,
  type SettledPlanEntry,
} from './types'

/** The write port an identity plan needs beyond `write` itself. */
export type IdentityPlanStore = {
  list: KnowledgeStore['list']
  /** Force file truth to be reconciled and settled. NOT optional in production:
   *  a destination map built off an unforced snapshot can miss a note that was
   *  created externally (or whose watcher event was never delivered), and the
   *  import would then mint a NEW identity over an existing file. */
  checkpoint?: () => Promise<void>
}

/** source identity → the identity its copy received, read straight off a settled
 *  plan. Derived rather than carried separately: the plan is what a retry adopts,
 *  so anything the rewrite depends on has to live IN it — a map rebuilt from
 *  fresh ids would repoint the second run's links at notes the first run never
 *  wrote. Complete before the first body is rewritten, so forward, backward and
 *  cyclic links are all resolvable. */
export const identityMapOf = (plan: SettledMarkdownTreePlanV1): ReadonlyMap<string, string> => {
  const map = new Map<string, string>()

  for (const entry of plan.entries) {
    if (entry.sourceId) {
      map.set(entry.sourceId, entry.targetId)
    }
  }

  return map
}

/** A plan read back from disk, or null when this build must not execute it.
 *
 *  What is checked is deliberately narrow — the version, the exact artifact-size
 *  ceiling, the canonical root this build executes verbatim, and the three fields
 *  identity settlement adds to every entry — because those are exactly what a
 *  sidecar written by ANOTHER build gets wrong. The rest of the shape is not
 *  re-derived here: the sidecar is our own artifact, published atomically and read
 *  back only if its digest matches, so a plan that arrives at all is a plan we
 *  wrote whole. What differs across builds is what the fields MEAN, and that is
 *  what the version, root and settled trio stand for.
 *
 *  "Valid V1" is therefore not the version number alone. A sidecar whose entries
 *  carry no settled identity describes a plan this build cannot execute: every id
 *  it needs would have to be invented at the write path, and a retry inventing ids
 *  is the one thing the sidecar exists to stop. Refusing it here routes it through
 *  the same gate as a missing plan — rebuilt while the write gate is provably
 *  closed, terminal after that.
 *
 *  Which is why this predicate is also handed to the PUBLICATION, and not only
 *  read here. Publishing is no-clobber, so a refused sidecar that stays on disk
 *  makes the rebuilt plan unpublishable: the rewrite is refused, the read-back
 *  returns the refused plan again, and the run dies retryably on every attempt
 *  without anything ever changing. Told what this build can execute, the
 *  publication REPLACES what it cannot — atomically, and only where the gate
 *  above has already proved nothing was written under it.
 *  canon: docs/import.md#importing-a-markdown-tree-302 */
export const asSettledPlan = (
  plan: MarkdownTreePlanV1 | null | undefined,
  maxBytes = MAX_MARKDOWN_TREE_METADATA_BYTES,
): SettledMarkdownTreePlanV1 | null => {
  if (
    !plan ||
    plan.version !== 1 ||
    typeof plan.root !== 'string' ||
    safeRelAddress(plan.root) !== plan.root ||
    !Array.isArray(plan.entries)
  ) {
    return null
  }

  return plan.entries.every(isSettledEntry) && serializedImportPlanBytes(plan) <= maxBytes
    ? (plan as SettledMarkdownTreePlanV1)
    : null
}

/** Refuse the ACTUAL settled artifact before publication or a note write. The
 *  preflight reserve is intentionally only a forecast: an existing destination
 *  may carry an arbitrarily long id, and settlement copies it twice into an entry. */
export const assertSettledPlanFits = (
  plan: SettledMarkdownTreePlanV1,
  maxBytes = MAX_MARKDOWN_TREE_METADATA_BYTES,
): void => {
  if (serializedImportPlanBytes(plan) > maxBytes) {
    throw new ImportError('archive metadata is too large to plan — refusing to import it')
  }
}

const OWNERSHIPS = new Set<string>(Object.values(RESERVATION_OWNERSHIP))

const isSettledEntry = (entry: MarkdownTreePlanEntry): boolean => {
  const candidate = entry as Partial<SettledPlanEntry>

  return (
    typeof candidate.targetId === 'string' &&
    candidate.targetId.length > 0 &&
    candidate.expectedDestinationId !== undefined &&
    typeof candidate.ownership === 'string' &&
    OWNERSHIPS.has(candidate.ownership)
  )
}

/**
 * Settle every planned entry's identity against current file truth.
 *
 * The fresh ids avoid a forbidden set rather than merely "an id nobody uses":
 * an id that equals ANY of the archive's own source ids would make a rewritten
 * link ambiguous — it could mean the copy or the note the archive came from —
 * even when that source id has no owner here at all.
 */
export const settleTreeIdentities = async (
  store: IdentityPlanStore,
  plan: MarkdownTreePlanV1,
  /** How a fresh identity is drawn. Production always mints one; the seam exists
   *  so a test can force the collision the retry loop below exists for — 72 bits
   *  of randomness will not produce one on demand. */
  mintId: () => string = freshNoteId,
): Promise<SettledMarkdownTreePlanV1> => {
  if (!store.checkpoint) {
    throw new Error('import cannot plan identities without a store that can checkpoint file truth')
  }
  // A forced checkpoint, not a settle: settling only awaits reconciliation that
  // has already started, which is precisely the case that misses a file the
  // watcher never reported.
  await store.checkpoint()
  const existing = new Map<string, string>()

  for (const note of await store.list({ scope: READ_SCOPE.user })) {
    if (note.id) {
      existing.set(note.filePath, note.id)
    }
  }
  const forbidden = new Set<string>([
    ...plan.entries.flatMap((entry) => (entry.sourceId ? [entry.sourceId] : [])),
    ...existing.values(),
  ])
  const entries = plan.entries.map((entry) => {
    const occupant = existing.get(underRoot(plan.root, entry.destinationPath))
    // An occupied destination is referenced, never re-identified: overwriting a
    // note's body is an import, overwriting its identity is data loss for every
    // link that already points at it.
    const targetId = occupant ?? mintOutside(forbidden, mintId)

    forbidden.add(targetId)

    return {
      ...entry,
      targetId,
      expectedDestinationId: occupant ?? null,
      ownership: occupant
        ? RESERVATION_OWNERSHIP.existingReference
        : RESERVATION_OWNERSHIP.freshOwned,
    }
  })

  return { ...plan, entries }
}

/** A fresh id outside the forbidden set. Ids are 72 bits of randomness, so the
 *  loop is a formality — but a formality that makes the invariant a fact rather
 *  than a probability, and one a test can force through `mintId`. */
const mintOutside = (forbidden: ReadonlySet<string>, mintId: () => string): string => {
  for (;;) {
    const candidate = mintId()

    if (!forbidden.has(candidate)) {
      return candidate
    }
  }
}
