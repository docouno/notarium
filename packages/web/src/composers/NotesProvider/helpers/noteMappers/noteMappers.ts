import type { RecentNote } from '../../../../libs/recentNotes'
import type { NoteDetailView, NoteView } from '../../../../libs/wire'

/** Reduce a detail to the list shape without turning its metadata into a local
 *  human-name index; only known stable ids resolve from this inventory. */
export const asNote = (d: NoteDetailView, seed?: NoteView | null): NoteView | null =>
  !d.deleted && d.id && d.filePath
    ? {
        id: d.id,
        title: d.title || '',
        filePath: d.filePath,
        class: d.class,
        slug: d.slug,
        aliases: d.aliases,
        modifiedAt: seed?.modifiedAt ?? null,
        createdAt: d.createdAt ?? seed?.createdAt ?? null,
      }
    : null

export const asRecent = (d: NoteDetailView, seed?: NoteView | null): RecentNote | null =>
  !d.deleted && d.id && d.filePath
    ? {
        kind: 'note',
        id: d.id,
        title: d.title || '',
        slug: d.slug,
        filePath: d.filePath,
        noteType: typeof d.frontmatter?.type === 'string' ? d.frontmatter.type : undefined,
        modifiedAt: d.modifiedAt ?? seed?.modifiedAt ?? null,
        createdAt: d.createdAt ?? seed?.createdAt ?? null,
      }
    : null
