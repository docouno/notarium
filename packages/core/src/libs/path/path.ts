import { FOLDER_PAGE_FILENAME } from './consts'

/** Directory part of a slash-separated path ('' for a root-level file). */
export const directoryOf = (filePath: string): string => {
  if (!filePath) {
    return ''
  }
  const i = filePath.lastIndexOf('/')
  return i === -1 ? '' : filePath.slice(0, i)
}

/** Filename part of a slash-separated path (the whole string for a root-level file). */
export const basenameOf = (filePath: string): string => {
  const i = filePath.lastIndexOf('/')
  return i === -1 ? filePath : filePath.slice(i + 1)
}

/** Is this note the PAGE of its folder? True for a `<folder>/index.md` (or a
 *  root-level `index.md`). The folder a page belongs to is just `directoryOf` it. */
export const isFolderPageNote = (filePath: string): boolean =>
  basenameOf(filePath) === FOLDER_PAGE_FILENAME

/** Space-relative file path of a folder's page note: `<folderPath>/index.md`
 *  (or `index.md` at the space root). */
export const folderPageFilePath = (folderPath: string): string =>
  folderPath ? `${folderPath}/${FOLDER_PAGE_FILENAME}` : FOLDER_PAGE_FILENAME

/** Is `filePath` inside the folder `folderPrefix` (the folder itself or a
 *  descendant)? A space-relative folder-prefix test (project-subtree
 *  narrowing). `folderPrefix === ''` = the whole space (a root project owns it),
 *  so it always matches. Otherwise the note's DIRECTORY must equal the prefix or
 *  sit under it — a segment-boundary match, never a raw `startsWith`, so 'bill'
 *  does NOT swallow 'billing/x.md'. */
export const isPathUnder = (filePath: string, folderPrefix: string): boolean => {
  if (folderPrefix === '') {
    return true
  }
  const dir = directoryOf(filePath)
  return dir === folderPrefix || dir.startsWith(`${folderPrefix}/`)
}
