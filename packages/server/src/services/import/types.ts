// The Markdown-tree import plan: what the zero-write classification/preflight
// pass decided, frozen before the first note is written and replayed verbatim by
// the executing pass (and by a durable retry).
// canon: docs/import.md#importing-a-markdown-tree-302

import type { ImportReservationEntryInput } from '../metaDb/types'
import type { ArchiveKind } from './consts'

/** How a planned destination relates to the identity that will own it.
 *  `existing-reference` — the path already carries an authoritative id, and the
 *  plan points the copy's links at it rather than re-identifying the note;
 *  `fresh-owned` — the plan minted the id for a path it proved free. Persisted
 *  with the claim, and dropped with it: closing an ended job's reservation removes
 *  every one of its claims, whichever kind they are. */
export const RESERVATION_OWNERSHIP = {
  existingReference: 'existing-reference',
  freshOwned: 'fresh-owned',
} as const

export type ReservationOwnership =
  (typeof RESERVATION_OWNERSHIP)[keyof typeof RESERVATION_OWNERSHIP]

/** One importable Markdown member, resolved. Carries no body bytes: the
 *  executing pass re-reads and re-parses the member, so a 10 000-file plan stays
 *  a few MB of addresses rather than the archive itself. */
export type MarkdownTreePlanEntry = {
  /** The member's name as the archive spells it — diagnostics only. */
  archivePath: string
  /** Archive-relative directory, canonicalised ('' = the archive root). */
  directory: string
  /** Deterministic storage basename (sans `.md`) the parser derived. */
  fileName: string
  /** Root-relative canonical destination — the exact key the write path lands on. */
  destinationPath: string
  /** Bytes this member actually expanded to during preflight. */
  expandedBytes: number
  /** Validated ZIP entry mtime, used as the creation date only when the file's
   *  own frontmatter names none. */
  sourceCreatedAt?: string
  /** The `notarium-id` the source file claimed, when it is a valid durable
   *  scalar. Never becomes the target identity — it is the key of the exact-link
   *  map and nothing else. */
  sourceId?: string
}

/** A planned entry after identity settlement — the only shape the write pass ever
 *  executes.
 *
 *  The three fields are REQUIRED here, and separating the type is the point. As
 *  optionals on one shared shape they were compensated at the write path
 *  (`targetId ?? ''`), which meant a sidecar from an older build — same
 *  `version: 1`, no settled fields — would be adopted, hand the reservation an
 *  empty target id, and let the store mint an identity of its own. That is
 *  exactly the divergence between a retry's links and its notes that versioning
 *  the plan exists to prevent, so an unsettled plan is refused instead of
 *  patched. canon: docs/import.md#importing-a-markdown-tree-302 */
export type SettledPlanEntry = MarkdownTreePlanEntry & {
  /** The settled identity this entry writes under. */
  targetId: string
  /** The identity the destination must already carry, or `null` when the plan
   *  expected a free path. */
  expectedDestinationId: string | null
  ownership: ReservationOwnership
}

/** Non-Markdown members: counted exactly, sampled boundedly, never decoded. */
export type IgnoredMembers = {
  count: number
  files: string[]
  filesOmitted?: number
}

/** The versioned plan. `version` is checked on every read: a sidecar written by
 *  an older build is refused rather than reinterpreted. */
export type MarkdownTreePlanV1 = {
  version: 1
  /** The staged upload this plan describes — a plan never migrates to another. */
  uploadRef: string
  /** The destination root, stored ONCE (repeating it per entry is how a long
   *  root turns 10 000 entries into megabytes of metadata). */
  root: string
  entriesTotal: number
  expandedBytes: number
  ignored: IgnoredMembers
  entries: MarkdownTreePlanEntry[]
}

/** The plan as it is published, adopted and executed: every entry settled. */
export type SettledMarkdownTreePlanV1 = Omit<MarkdownTreePlanV1, 'entries'> & {
  entries: SettledPlanEntry[]
}

/** What classification concluded over the whole central directory. A recognised
 *  foreign export wins outright — the presence of `.md` members never splits the
 *  run into two importers. */
export type ArchiveClassification =
  | { kind: Extract<ArchiveKind, 'foreign'> }
  | { kind: Extract<ArchiveKind, 'markdown-tree'>; plan: MarkdownTreePlanV1 }

/** The durable side of a Markdown-tree plan. Absent on the synchronous path,
 *  which has no staging and therefore no crash recovery: its plan lives for one
 *  request. canon: docs/import.md#importing-a-markdown-tree-302 */
export type ImportPlanStore = {
  /** The plan this upload already published, or null. Unvalidated: what comes
   *  back is bytes another build may have written, so the caller proves it is a
   *  settled V1 before executing it. */
  load(): Promise<MarkdownTreePlanV1 | null>
  /** Publish this run's plan; the return value is the CANONICAL one, which may
   *  be a peer's if two claims raced. Null = could not publish durably. */
  publish(plan: SettledMarkdownTreePlanV1): Promise<MarkdownTreePlanV1 | null>
  /** The job phase persisted BEFORE this run started. It is the only evidence
   *  that the write gate was never opened — and therefore the only thing that
   *  makes rebuilding a missing plan safe rather than a silent re-decision. */
  readonly persistedPhase: string | null
}

/** The durable arbitration of destinations, as the import service sees it (#302).
 *  Absent on the synchronous path, which owns no job and can be refused nothing:
 *  its plan and its writes live for one request.
 *
 *  Two methods because there are two moments. `claim` happens ONCE, after the plan
 *  is settled and before the first write — that is what makes a competing import a
 *  refusal instead of a half-written tree. `fenced` wraps every planned write in the
 *  exclusion that claim proved: the physical CAS happens INSIDE it, so a cancel, a
 *  reap or a rival cannot land between the proof and the bytes.
 *  canon: docs/import.md#importing-a-markdown-tree-302 */
export type ImportReservationPort = {
  claim(entries: readonly ImportReservationEntryInput[]): Promise<void>
  fenced<T>(destinationPath: string, write: () => Promise<T>): Promise<T>
}

/** Progress as the import service reports it internally. For a markdown TREE
 *  `done` is PROCESSED work — a skip and a failure advance it too — which is what
 *  lets its bar be determinate against a known total. The foreign path has no
 *  planned total and moves `done` only on a successful write, so there the two
 *  counters coincide. `imported` is the successful-write counter the synchronous
 *  NDJSON wire has always carried. */
export type ImportProgress = {
  phase: string
  done: number
  total: number | null
  imported: number
}
