// Test-side access to the write half of a role library composition.
//
// Production resolves a target-bound handle once, before it mutates anything, and
// then calls exactly that handle — which is the point of the split. A suite that
// writes many packages across many placements would otherwise repeat those four
// lines at every call site, so they live here ONCE and still go through the real
// handle: a fixture cannot reach a placement composition refuses, and a suite
// that wants to prove the refusal asks `publicationFor` directly.

import {
  type RoleLibrary,
  type RoleLibraryComposition,
  type RoleLocation,
  type RolePackagePublication,
  type SkillPackage,
} from '../packages/server/src/services/roles'

export type WritableRoleLibrary = RoleLibrary & {
  putIfAbsent(location: RoleLocation, pkg: SkillPackage): Promise<boolean>
  movePackage(
    from: RoleLocation,
    to: RoleLocation,
    directoryName: string,
    finalize?: (evidence: { manifestNoteId: string | null }) => Promise<void>,
  ): Promise<boolean>
  /** The two dependencies `createRolesService` takes, carried alongside so a suite
   *  that writes through this wrapper cannot hand the service a DIFFERENT
   *  composition than the one it is seeding. */
  readonly deps: RoleLibraryComposition
}

const handleFor = async (composition: RoleLibraryComposition, location: RoleLocation) => {
  const handle = await composition.publication.publicationFor(location)

  if (!handle) {
    throw new Error(`no role package publication for ${location.scope} in ${location.space}`)
  }

  return handle
}

export const writableLibrary = (composition: RoleLibraryComposition): WritableRoleLibrary => ({
  ...composition.library,
  deps: composition,
  putIfAbsent: async (location, pkg) => (await handleFor(composition, location)).putIfAbsent(pkg),
  // The destination owns the move, and the source rides along as a parameter —
  // the same asymmetry the handle itself carries.
  movePackage: async (from, to, directoryName, finalize = async () => undefined) => {
    return (await handleFor(composition, to)).moveFrom(from, directoryName, null, finalize)
  },
})

/** One composition whose WRITER misbehaves for chosen placements.
 *
 *  The injection goes through `publicationFor`, because that is where a service
 *  gets its handle: patched onto the library object instead, it would sit on a
 *  surface nothing calls any more and the case would pass against a service that
 *  never failed at all. */
export const interceptPublication = (
  composition: RoleLibraryComposition,
  intercept: {
    putIfAbsent?: (
      location: RoleLocation,
      pkg: SkillPackage,
      next: () => Promise<boolean>,
    ) => Promise<boolean>
    moveFrom?: (
      into: RoleLocation,
      from: RoleLocation,
      directoryName: string,
      expected: Parameters<RolePackagePublication['moveFrom']>[2],
      finalize: (evidence: { manifestNoteId: string | null }) => Promise<void>,
      next: (
        finalize?: (evidence: { manifestNoteId: string | null }) => Promise<void>,
      ) => Promise<boolean>,
    ) => Promise<boolean>
  },
): RoleLibraryComposition => ({
  library: composition.library,
  publication: {
    availableFor: (target) => composition.publication.availableFor(target),
    publicationFor: async (location) => {
      const handle = await composition.publication.publicationFor(location)

      if (!handle) {
        return null
      }

      return {
        putIfAbsent: (pkg) =>
          intercept.putIfAbsent
            ? intercept.putIfAbsent(location, pkg, () => handle.putIfAbsent(pkg))
            : handle.putIfAbsent(pkg),
        moveFrom: (from, directoryName, expected, finalize) =>
          intercept.moveFrom
            ? intercept.moveFrom(
                location,
                from,
                directoryName,
                expected,
                finalize,
                (selected = finalize) => handle.moveFrom(from, directoryName, expected, selected),
              )
            : handle.moveFrom(from, directoryName, expected, finalize),
      }
    },
  },
})
