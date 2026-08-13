import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { CanonicalResourceRoot, ResourceRootInput } from './types'

const canonicalizeLateRoot = (root: string): string => {
  let cursor = resolve(root)
  const suffix: string[] = []

  for (;;) {
    try {
      lstatSync(cursor)
      return resolve(realpathSync(cursor), ...suffix.reverse())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
      const parent = dirname(cursor)

      if (parent === cursor) {
        throw err
      }
      suffix.push(basename(cursor))
      cursor = parent
    }
  }
}

const contains = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)

  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Resolve every existing symlink prefix before authority construction. Nested
 * mounts inside one space intentionally share one authority; any cross-space
 * physical overlap is a configuration error. */
export const preflightResourceRoots = (
  inputs: readonly ResourceRootInput[],
): CanonicalResourceRoot[] => {
  const roots = inputs.map((input) => ({
    ...input,
    root: resolve(input.root),
    canonicalRoot: canonicalizeLateRoot(input.root),
  }))

  for (let leftIndex = 0; leftIndex < roots.length; leftIndex++) {
    const left = roots[leftIndex]

    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex++) {
      const right = roots[rightIndex]

      if (left.spaceId === right.spaceId) {
        continue
      }
      if (
        contains(left.canonicalRoot, right.canonicalRoot) ||
        contains(right.canonicalRoot, left.canonicalRoot)
      ) {
        throw new Error(
          `resource roots overlap across spaces: ${left.spaceId}/${left.adapterId} and ${right.spaceId}/${right.adapterId}`,
        )
      }
    }
  }

  return roots
}

export const assertCanonicalResourceRoot = (root: CanonicalResourceRoot): void => {
  const current = canonicalizeLateRoot(root.root)

  if (current !== root.canonicalRoot) {
    throw new Error(`resource root changed after preflight: ${root.spaceId}/${root.adapterId}`)
  }
}
