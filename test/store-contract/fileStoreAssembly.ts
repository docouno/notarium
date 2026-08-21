// Test-only adapter shaping. Production has ONE FileStore backend; these helpers
// let a suite compose the deployment it needs to talk about — a medium that
// normalizes case, one that cannot move a directory atomically, one that answers
// no faster than a full walk — without pretending any of them is a real adapter.
//
// The point of building them by NAME rather than by cast: an absent capability
// has to be absent from the object. A cast would let a fixture claim a facet it
// never implements, which is the exact confusion this split exists to remove.

import type {
  FileStore,
  FileStoreAccelerators,
  FileStoreAssembly,
  FileStoreCapabilities,
} from '@notarium/engine'

export type AssemblyOverrides = {
  /** Replaces the named base operations; every other one is kept. */
  base?: Partial<FileStore>
  /** Replaces the named facets. An explicit `undefined` REMOVES one — that is
   *  how a fixture says "this deployment cannot", and it is a different fact
   *  from a method that throws. */
  capabilities?: FileStoreCapabilities
  accelerators?: FileStoreAccelerators
}

const merged = <T extends object>(current: T, overrides: T | undefined): T => {
  if (!overrides) {
    return current
  }
  const next = { ...current, ...overrides }

  for (const key of Object.keys(overrides) as Array<keyof T>) {
    if (overrides[key] === undefined) {
      delete next[key]
    }
  }

  return next
}

/** One assembly with named parts replaced. */
export const withFacets = (
  assembly: FileStoreAssembly,
  overrides: AssemblyOverrides,
): FileStoreAssembly => ({
  base: { ...assembly.base, ...overrides.base },
  capabilities: merged(assembly.capabilities, overrides.capabilities),
  accelerators: merged(assembly.accelerators, overrides.accelerators),
})

/** A base port whose every operation answers for an empty medium. Suites extend
 *  it to build the SMALLEST honest adapter their case needs, instead of casting
 *  a partial object into the port. */
export const emptyBase = (): FileStore => ({
  scan: async () => [],
  listDirs: async () => [],
  stat: async () => null,
  read: async () => null,
  write: async () => {},
  rename: async () => {},
  renameDir: async () => {},
  remove: async () => {},
  makeDir: async () => false,
  removeDir: async () => {},
  exists: async () => false,
  dirExists: async () => false,
})

/** The adapter a deployment with no declared semantics beyond the base hands its
 *  composition root: capability and accelerator namespaces exist and are empty. */
export const baseOnlyAssembly = (base: FileStore = emptyBase()): FileStoreAssembly => ({
  base,
  capabilities: {},
  accelerators: {},
})
