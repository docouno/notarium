import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { readPackagesFromDirectory, type SkillPackage } from './library'

let cached: Promise<SkillPackage[]> | undefined

/** Source checkout and bundled runtime carry the same read-only ability inventory.
 * A missing directory is a broken artifact, not an empty inventory: reading it as
 * empty would take System and Catalog abilities away from every user and answer
 * "no such role" to every Add, with nothing in the log to say why. A failed read is
 * not memoised either — one bad boot must not disable the surface for the process. */
export const loadBundledAbilityInventory = (): Promise<SkillPackage[]> => {
  if (cached) {
    return cached
  }
  const directory = fileURLToPath(new URL('./catalog/', import.meta.url))

  if (!existsSync(directory)) {
    return Promise.reject(new Error('bundled ability inventory is missing from the artifact'))
  }
  const loading = readPackagesFromDirectory(directory).catch((error: unknown) => {
    cached = undefined
    throw error
  })

  cached = loading
  return loading
}
