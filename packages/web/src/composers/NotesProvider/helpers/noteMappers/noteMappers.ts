import type { RecentNote } from '../../../../libs/recentNotes'
import type { NoteDetailView, NoteView } from '../../../../libs/wire'

/** A NoteDetailView reduced to the list shape, for the resolution cache. Carries
 *  `aliases` (#100) so a detail-opened note resolves inbound [[Old Name]] from
 *  this cache without a server round-trip — same alias channel the list serves. */
export const asNote = (d: NoteDetailView, seed?: NoteView | null): NoteView | null =>
  d.id && d.filePath
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
  d.id && d.filePath
    ? {
        id: d.id,
        title: d.title || '',
        slug: d.slug,
        filePath: d.filePath,
        noteType: typeof d.frontmatter?.type === 'string' ? d.frontmatter.type : undefined,
        modifiedAt: d.modifiedAt ?? seed?.modifiedAt ?? null,
        createdAt: d.createdAt ?? seed?.createdAt ?? null,
      }
    : null
