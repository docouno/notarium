import { MutationCoordinator } from '@notarium/core'

// One process-local coordinator for every folder-identity lifecycle mutation.
// Exact mark-family writes may run concurrently for siblings, while a subtree
// delete reserves a prefix and therefore waits for every mark below it (and blocks
// newcomers) until physical storage + the derived registries have settled.
// canon: docs/projects.md#lifecycle
const lifecycleMutations = new MutationCoordinator()

export const withMarkLock = <T>(key: string, fn: () => Promise<T>): Promise<T> =>
  lifecycleMutations.run({ paths: [key] }, fn)

/** Reserve a whole folder subtree across callbacks owned by another mutation
 * fence. The caller MUST release in a finally block. The held task form lets us
 * reuse MutationCoordinator's fair exact-vs-prefix ordering without exposing a
 * raw coordinator lease outside core. */
export const acquireMarkPrefixLock = async (key: string): Promise<() => Promise<void>> => {
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const held = lifecycleMutations.run({ prefixes: [key] }, async () => {
    enter()
    await gate
  })

  await entered
  let released = false

  return async () => {
    if (released) {
      return
    }
    released = true
    open()
    await held
  }
}
