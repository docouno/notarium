import { isImportNoteSourceLocator } from '../../../importer'
import type { NoteContent } from '../../../knowledgeStore'
import {
  analyzeDocumentState,
  type DocumentState,
  documentStateVersionToken,
  type LogicalNoteState,
  logicalNoteStateFromProjection,
} from '../../../libs/markdown'
import { IMPORT_SOURCE_FRONTMATTER_KEY } from '../../../sourceIdentity'

type ExactNoteProjection = Pick<
  NoteContent,
  'title' | 'content' | 'frontmatter' | 'sourceLocator' | 'logicalState' | 'documentState'
>

const fallbackFrontmatter = (note: ExactNoteProjection): Record<string, unknown> => {
  const frontmatter = { ...note.frontmatter }

  // The authored projection cannot assert reserved provenance. A valid typed
  // projection is the only compatibility input allowed to reconstruct it.
  delete frontmatter[IMPORT_SOURCE_FRONTMATTER_KEY]
  if (isImportNoteSourceLocator(note.sourceLocator)) {
    frontmatter[IMPORT_SOURCE_FRONTMATTER_KEY] = note.sourceLocator
  }

  return frontmatter
}

export const exactLogicalState = (note: ExactNoteProjection): LogicalNoteState =>
  note.logicalState ??
  logicalNoteStateFromProjection({
    title: note.title,
    body: note.content,
    frontmatter: fallbackFrontmatter(note),
  })

export const exactDocumentState = (note: ExactNoteProjection): DocumentState =>
  note.documentState ??
  analyzeDocumentState({
    source: new TextEncoder().encode(exactLogicalState(note).markdown),
    pathFallbackTitle: note.title ?? null,
  })

export const exactVersionToken = (note: ExactNoteProjection): string =>
  documentStateVersionToken(exactDocumentState(note))
