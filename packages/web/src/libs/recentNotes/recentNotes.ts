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
  id: string
  title: string
  /** The display slug (#100 phase 1), so Spotlight opens the canonical /n/<id>/<slug>
   *  without a resolve. Absent when the note has no custom slug. */
  slug?: string
  filePath?: string
  /** Decorative note type label. Old localStorage rows omit it; loadRecentNotes
   *  keeps those as type-less. */
  noteType?: string
  /** The note's real modification signal (mtime/journal, #186). Old localStorage
   *  rows omit it; loadRecentNotes normalises those to null. */
  modifiedAt?: string | null
  /** The note's authored creation instant (#186). Old localStorage rows omit it;
   *  loadRecentNotes normalises those to null. */
  createdAt?: string | null
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
    const parsed = JSON.parse(raw) as unknown

    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter(isRecentNote).slice(0, CAP).map(normalizeRecentNote)
  } catch {
    return [] // malformed or storage blocked — no recents, not a crash
  }
}

/** Promote a note to the front of its space's MRU (dedup by id), capped. */
export const pushRecentNote = (space: string, note: RecentNote): void => {
  if (!space || !note?.id) {
    return
  }
  try {
    const rest = loadRecentNotes(space).filter((n) => n.id !== note.id)
    const next: RecentNote[] = [normalizeRecentNote(note), ...rest].slice(0, CAP)
    localStorage.setItem(KEY + space, JSON.stringify(next))
  } catch {
    /* storage blocked — recents are best-effort */
  }
}

const isRecentNote = (x: unknown): x is RecentNote =>
  !!x &&
  typeof x === 'object' &&
  typeof (x as RecentNote).id === 'string' &&
  typeof (x as RecentNote).title === 'string'

const normalizeRecentNote = (note: RecentNote): RecentNote => ({
  id: note.id,
  title: note.title,
  ...(typeof note.slug === 'string' ? { slug: note.slug } : {}),
  ...(typeof note.filePath === 'string' ? { filePath: note.filePath } : {}),
  ...(typeof note.noteType === 'string' && note.noteType ? { noteType: note.noteType } : {}),
  modifiedAt:
    typeof note.modifiedAt === 'string' || note.modifiedAt === null ? note.modifiedAt : null,
  createdAt: typeof note.createdAt === 'string' || note.createdAt === null ? note.createdAt : null,
})
