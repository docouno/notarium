/** The reserved filename of a folder's PAGE note: a visible `index.md`
 *  living IN the folder is that folder's body, the Obsidian folder-note pattern.
 *  It is an ordinary `user-doc` (graph/search/index-visible for free), only given
 *  special-cased meaning by this name. `BASENAME` (sans `.md`) is what a write
 *  passes as `WriteInput.fileName` to land the note on exactly this path. */
export const FOLDER_PAGE_FILENAME = 'index.md'
export const FOLDER_PAGE_BASENAME = 'index'
