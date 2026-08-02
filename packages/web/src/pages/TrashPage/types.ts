import type { Author } from '@notarium/contract'

// The Trash holds ONE kind of thing: a deleted ITEM. A note and a whole space are
// both items — same row, same checkbox, same Restore, same bulk delete. The only
// per-kind bits are the leading icon (so the mixed `All` view reads at a glance), the
// clickable title (a note opens read-only; a deleted space has no live view) and the
// note-only memory/external chips. Everything else is shared.
export type TrashEntry = {
  kind: 'note' | 'space'
  id: string
  title: string
  href?: string // a note opens its read-only view; a space has none
  pathText: string | null // a note's folder path; a space's /s/<slug> handle
  who: Author | null // resolved, privacy-filtered (#13) — who deleted it
  date: string | null
  memory?: boolean
  external?: boolean
  restorable: boolean
  restoreTitle: string
}

export type BatchFailure = {
  id: string
  error: string
  reason?: string
}
