// The localfs body reader behind CachedStore's `readBody` capability.
// Optional infra (P5): unwired when NOTES_DIR is absent or the engine is
// remote, and cold previews fall back to the engine path. Every error collapses
// to null on purpose — a missing/locked/mid-rename file must degrade to a slower
// read, never a failed request.
// canon: docs/architecture.md#p5

import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export type BodyReader = (filePath: string) => Promise<string | null>

export const notesDirReader = (dir: string): BodyReader => {
  const root = resolve(dir)

  return async (filePath: string) => {
    // file_path comes from the engine but is treated as untrusted: the resolved
    // target must stay inside the mount.
    const target = resolve(root, filePath)

    if (target !== root && !target.startsWith(root + sep)) {
      return null
    }
    try {
      return await readFile(target, 'utf8')
    } catch {
      return null
    }
  }
}
