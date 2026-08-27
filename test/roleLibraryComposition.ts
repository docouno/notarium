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
  type RolePackageTarget,
  type SkillPackage,
} from '../packages/server/src/services/roles'

export type WritableRoleLibrary = RoleLibrary & {
  putIfAbsent(location: RoleLocation, pkg: SkillPackage): Promise<boolean>
  movePackage(
    from: RoleLocation,
    to: RoleLocation,
    directoryName: string,
    finalize?: (evidence: { manifestNoteId: string | null }) => Promise<void>,
    /** The third lifecycle hook, observable for the same reason the other two are.
     *  `rollback` is what a caller undoes its OWN durable state with — the reach row,
     *  the placement trail — so a fixture that swallows it proves the bytes moved back
     *  and nothing about the state that describes where they are. Every path that
     *  restores the source has to call it, and a default no-op cannot say which did. */
    rollback?: () => Promise<void>,
    /** The identity the move revalidates, when a case needs it observed EARLIER than
     *  the move. Production captures its target long before `moveFrom` — a reach row
     *  and a placement trail are written in between — so a driver that always
     *  recaptured here would hand the move two observations of one moment, and no
     *  case behind it could express a package that changed under its caller. */
    expected?: RolePackageTarget,
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
  movePackage: async (
    from,
    to,
    directoryName,
    finalize = async () => undefined,
    rollback = async () => undefined,
    expected,
  ) => {
    const handle = await handleFor(composition, to)
    const captured =
      expected ?? (await composition.library.captureExactPackage(from, directoryName))
    const target = captured ?? {
      kind: 'role' as const,
      registryNoteId: directoryName,
      manifestNoteId: directoryName,
    }
    const result = await handle.moveFrom(from, directoryName, target, {
      beforeMove: async () => undefined,
      finalize: (snapshot) => finalize({ manifestNoteId: snapshot.manifestNoteId }),
      rollback,
    })

    return result.status === 'moved'
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
      lifecycle: Parameters<RolePackagePublication['moveFrom']>[3],
      next: (
        lifecycle?: Parameters<RolePackagePublication['moveFrom']>[3],
      ) => ReturnType<RolePackagePublication['moveFrom']>,
    ) => ReturnType<RolePackagePublication['moveFrom']>
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
        moveFrom: (from, directoryName, expected, lifecycle) =>
          intercept.moveFrom
            ? intercept.moveFrom(
                location,
                from,
                directoryName,
                expected,
                lifecycle,
                (selected = lifecycle) => handle.moveFrom(from, directoryName, expected, selected),
              )
            : handle.moveFrom(from, directoryName, expected, lifecycle),
      }
    },
  },
})
