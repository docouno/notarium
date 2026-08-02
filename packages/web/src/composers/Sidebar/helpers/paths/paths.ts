import type { NoteView } from '../../../../libs/wire'

export const baseName = (p: string | null | undefined): string => (p || '').split('/').pop() ?? ''

export const dirOfPath = (p: string | null | undefined): string => {
  const i = (p || '').lastIndexOf('/')
  return i === -1 ? '' : (p as string).slice(0, i)
}

export const noteSort = (a: NoteView, b: NoteView) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
  a.filePath.localeCompare(b.filePath, undefined, { sensitivity: 'base' })

export const pathInside = (path: string, root: string): boolean =>
  root === '' || path === root || path.startsWith(root + '/')
