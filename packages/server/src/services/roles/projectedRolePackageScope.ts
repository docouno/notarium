import { NOTE_CLASS } from '@notarium/contract'
import { READ_SCOPE } from '@notarium/core'
import type { WithProjectedRolePackage } from './library'

/** The note read-model, narrowed to the two questions this scope asks it. Narrow on
 *  purpose: the composition root owns the NoteStore claim order, and a seam handed a
 *  whole store would be one edit away from reading anything else under it. */
export type ProjectedRolePackageStore = {
  list(query: {
    scope: typeof READ_SCOPE.all
    classes: [typeof NOTE_CLASS.skill]
  }): Promise<readonly { id?: string | undefined; filePath?: string | undefined }[]>
  withExactNoteClaim<Result>(
    noteId: string,
    task: (current: {
      id?: string | undefined
      filePath?: string | undefined
      versionToken?: string | undefined
    }) => Promise<Result>,
  ): Promise<Result>
}

/** The production composition seam of design 02: the host owns the exact-note scope,
 *  and RoleLibrary receives bounded registry facts inside it and owns its own resource
 *  admissions. Lives here, as one named unit, rather than inline in the composition
 *  root, because the identity check below is the ONLY thing in the whole exact-package
 *  path that binds a registry note to a package ADDRESS — see the comment on it — and
 *  a check nothing can reach cannot be a check nobody can test either.
 *
 *  `null` is the fail-closed answer for every way the address and the identity fail to
 *  agree; it reads downstream as "no such package here", the same answer an address
 *  with nothing at it gives. */
export const createProjectedRolePackageScope = (
  storeForSpace: (space: string) => Promise<ProjectedRolePackageStore>,
): WithProjectedRolePackage => {
  return async (space, pkg, expectedRegistryNoteId, task) => {
    const store = await storeForSpace(space)
    const candidateId =
      expectedRegistryNoteId ??
      (
        await store.list({
          scope: READ_SCOPE.all,
          classes: [NOTE_CLASS.skill],
        })
      ).find((note) => note.filePath === pkg.filePath)?.id

    if (!candidateId) {
      return null
    }
    try {
      return await store.withExactNoteClaim(candidateId, async (current) => {
        // The one binding between a registry identity and a package address. A caller
        // that names an expected registry id resolves its note BY id and never looks
        // at the path again, so if the package moved between that caller's read and
        // this claim, this is the only thing left to refuse handing the note's
        // registry facts to whatever now occupies the address it named.
        if (current.filePath !== pkg.filePath || !current.versionToken) {
          return null
        }

        return task({
          registryNoteId: candidateId,
          filePath: current.filePath,
          versionToken: current.versionToken,
        })
      })
    } catch (error) {
      if ((error as { isNotFound?: unknown }).isNotFound === true) {
        return null
      }
      throw error
    }
  }
}
