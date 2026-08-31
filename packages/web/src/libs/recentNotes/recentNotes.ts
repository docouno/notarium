// Recently-opened notes — a per-space MRU in localStorage, the Spotlight's
// empty-state list (#31). A true quick-switcher's headline move is jumping back
// to the note you were just in, which "recently modified" (the server's window)
// can't express — that's "what changed in the base", not "where I've been". So
// every note that lands in the reader is pushed here (NotesProvider.fetchNote,
// the single open chokepoint — tree click, deep link and Spotlight all funnel
// through it). Stored minimal-but-complete so Spotlight renders recents with NO
// round-trip: the id (identity), the title (label), the slug (canonical URL tail)
// and the path (the muted breadcrumb subtitle). Keyed by space — recents never
// leak across the space boundary (#16). Best-effort: a blocked/again-malformed
// store just yields no recents, never throws.

import { STORAGE_KEYS } from '../storageKeys'

export type RecentNote = {
  kind: 'note' | 'owned-ability'
  id: string
  title: string
  /** The display slug (#100 phase 1), so Spotlight opens the canonical /n/<id>/<slug>
   *  without a resolve. Absent when the note has no custom slug. */
  slug?: string
  filePath?: string
  /** Decorative note type label. Old localStorage rows omit it; loadRecentNotes
   *  keeps those as type-less. */
  noteType?: string
  /** Dedicated view discovery marker. Old localStorage rows omit it. */
  viewType?: string
  /** The note's real modification signal (mtime/journal, #186). Old localStorage
   *  rows omit it; loadRecentNotes normalises those to null. */
  modifiedAt?: string | null
  /** The note's authored creation instant (#186). Old localStorage rows omit it;
   *  loadRecentNotes normalises those to null. */
  createdAt?: string | null
  /** Exact canonical route for an Owned Ability. Generic notes derive `/n` from id. */
  href?: string
}

const KEY = STORAGE_KEYS.recentNotesPrefix
// Deep enough to survive a backfill merge and a session of jumping around, small
// enough to stay a cheap localStorage string.
const CAP = 30

export const loadRecentNotes = (space: string): RecentNote[] => {
  if (!space) {
    return []
  }
  try {
    const raw = localStorage.getItem(KEY + space)

    if (!raw) {
      return []
    }

    return storedRows(JSON.parse(raw) as unknown)
      .filter(isRecentNote)
      .slice(0, CAP)
      .map(normalizeRecentNote)
  } catch {
    return [] // malformed or storage blocked — no recents, not a crash
  }
}

// The rows as this generation reads them. A v1 store is a BARE ARRAY whose rows
// carry no `kind` — written before Abilities joined the ring. Those rows are all
// generic notes and `/n/<id>` still addresses them, so they are adopted rather
// than dropped: throwing the store away would cost every user their whole MRU.
const storedRows = (parsed: unknown): unknown[] => {
  if (Array.isArray(parsed)) {
    return parsed.map((row) =>
      row && typeof row === 'object' ? { ...(row as object), kind: 'note' } : row,
    )
  }
  const items = (parsed as { items?: unknown } | null)?.items

  return (parsed as { version?: unknown } | null)?.version === 2 && Array.isArray(items)
    ? items
    : []
}

/** Which space bucket a document belongs in, by the space it actually LIVES in. The
 *  MRU is keyed by slug, so an id-addressed home is resolved through the space table;
 *  a home the table does not know falls back to the chrome's active space rather than
 *  minting a bucket nothing will ever read. Space-free surfaces need this: keyed by
 *  the chrome instead, a document recorded while browsing one Space is invisible from
 *  the Space it belongs to, and shows up under a Space it never lived in. */
export const recentNotesBucket = (
  spaceId: string | null | undefined,
  spaces: readonly { id: string; slug: string }[],
  fallback: string,
): string => (spaceId ? (spaces.find((space) => space.id === spaceId)?.slug ?? fallback) : fallback)

/** Promote a note to the front of its space's MRU (dedup by id), capped. */
export const pushRecentNote = (space: string, note: RecentNote): void => {
  if (!space || !note?.id) {
    return
  }
  try {
    const stored = loadRecentNotes(space)
    const held = stored.find((n) => n.id === note.id)
    const rest = stored.filter((n) => n.id !== note.id)
    const next: RecentNote[] = [normalizeRecentNote(keepExactRoute(note, held)), ...rest].slice(
      0,
      CAP,
    )
    localStorage.setItem(KEY + space, JSON.stringify({ version: 2, items: next }))
  } catch {
    /* storage blocked — recents are best-effort */
  }
}

/** One slot, two writers. An Owned Ability's document is an ordinary note as well, so
 *  the reader's open chokepoint records it a SECOND time — as a plain `note` row, with
 *  no route beyond `/n/<id>`, because it holds no locator and cannot mint one. Dedupe
 *  by id lands that write on the very slot the ability page wrote, and nothing left in
 *  the row could rebuild the exact route afterwards. So the more specific address
 *  outlives the less specific write: same document, same slot, and the later visit
 *  still wins on everything it genuinely knows better (title, path, timestamps). A
 *  writer that carries its OWN exact route always wins — that one has just read it. */
const keepExactRoute = (note: RecentNote, held: RecentNote | undefined): RecentNote =>
  note.href || !held?.href ? note : { ...note, kind: held.kind, href: held.href }

const isRecentNote = (x: unknown): x is RecentNote =>
  !!x &&
  typeof x === 'object' &&
  ((x as RecentNote).kind === 'note' || (x as RecentNote).kind === 'owned-ability') &&
  typeof (x as RecentNote).id === 'string' &&
  typeof (x as RecentNote).title === 'string'

const normalizeRecentNote = (note: RecentNote): RecentNote => ({
  kind: note.kind,
  id: note.id,
  title: note.title,
  ...(typeof note.slug === 'string' ? { slug: note.slug } : {}),
  ...(typeof note.filePath === 'string' ? { filePath: note.filePath } : {}),
  ...(typeof note.noteType === 'string' && note.noteType ? { noteType: note.noteType } : {}),
  ...(typeof note.viewType === 'string' && note.viewType ? { viewType: note.viewType } : {}),
  ...(typeof note.href === 'string' && note.kind === 'owned-ability' ? { href: note.href } : {}),
  modifiedAt:
    typeof note.modifiedAt === 'string' || note.modifiedAt === null ? note.modifiedAt : null,
  createdAt: typeof note.createdAt === 'string' || note.createdAt === null ? note.createdAt : null,
})
