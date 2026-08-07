import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { readPackagesFromDirectory, type SkillPackage } from './library'

let cached: Promise<SkillPackage[]> | undefined

/** Source checkout and bundled runtime carry the same read-only catalog. */
export const loadBuiltinRoleCatalog = (): Promise<SkillPackage[]> => {
  if (cached) {
    return cached
  }
  const candidates = [
    new URL('./catalog/', import.meta.url),
    new URL('./role-catalog/', import.meta.url),
  ]
  const directory = candidates.find((candidate) => existsSync(fileURLToPath(candidate)))

  if (!directory) {
    throw new Error('built-in role catalog is missing from the runtime artifact')
  }
  cached = readPackagesFromDirectory(fileURLToPath(directory))
  return cached
}
