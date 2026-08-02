import { NOTE_CLASS } from '@notarium/contract/enums'
import { isFolderPageNote } from '@notarium/core'
import { folderPageHref, folderRoute } from '../../../../libs/routing/routePaths'
import type { NoteDetailView, Tree, TreeFolder } from '../../../../libs/wire'
import type { Crumb } from '../../../Breadcrumbs'

// A folder crumb → its page (#214). Prefer the durable `/folder/<id>` when the
// folder is identified (the tree carries the id), else its `/files/<path>` — the
// same id-preferred rule the children summary uses. Falls back to the path route
// when the tree hasn't loaded the folder yet, so the link never dead-ends.
export const folderHref = (path: string, tree: Tree | null, space: string): string => {
  const f = tree?.folders.find((x) => x.path === path)
  return f ? folderPageHref(space, f) : folderRoute(space, path)
}

type BuildTrailArgs = {
  note: NoteDetailView | null
  virtualFolder: TreeFolder | undefined
  feedActive: boolean
  tree: Tree | null
  space: string
}

// The active space leads every breadcrumb (Breadcrumbs adds it, linked to home).
// This layout supplies the tail: a note's folder path + title, or "Feed", or
// nothing (the space home). Every ANCESTOR folder segment links to its page; the
// LAST crumb is the current note/folder and stays plain. A memory note lives on
// the Agents surface (not Files), so its trail stays plain text.
export const buildTrail = ({
  note,
  virtualFolder,
  feedActive,
  tree,
  space,
}: BuildTrailArgs): Crumb[] => {
  // A folder PAGE note (#212) is a `<folder>/index.md` — its breadcrumb ends at the
  // FOLDER, not the reserved "index" leaf (the same hide-the-index principle that
  // keeps it out of the folder's children). The note's title is the folder's name,
  // so the trail still reads as the section.
  const isFolderPage = !!note?.filePath && isFolderPageNote(note.filePath)
  const breadcrumb = note?.filePath
    ? note.filePath
        .replace(/\.md$/, '')
        .split('/')
        .slice(0, isFolderPage ? -1 : undefined)
    : note
      ? [note.title]
      : []

  const isMemory = note?.class === NOTE_CLASS.agentMemory

  return note
    ? breadcrumb
        .filter((label): label is string => !!label)
        .map((label, i, arr) => {
          // The agent-memory mount (#13) is a dot-namespace dir; surface its root
          // segment as the friendly "Agents" section instead of the raw `.notarium`.
          const shown = label === '.notarium' ? 'Agents' : label

          if (isMemory || i === arr.length - 1) {
            return { label: shown }
          }

          return { label: shown, href: folderHref(arr.slice(0, i + 1).join('/'), tree, space) }
        })
    : virtualFolder
      ? virtualFolder.path
          .split('/')
          .filter(Boolean)
          .map((label, i, arr) =>
            i === arr.length - 1
              ? { label }
              : { label, href: folderHref(arr.slice(0, i + 1).join('/'), tree, space) },
          )
      : feedActive
        ? [{ label: 'Feed' }]
        : []
}
