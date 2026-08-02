// The artifact storage seam — where durable jobs write derived output files (export ZIPs).
// canon: docs/jobs.md#artifacts · docs/architecture.md#p11

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { Readable, Writable } from 'node:stream'

export type ArtifactStat = { size: number; mtimeMs: number }

export type ArtifactStore = {
  createWriteStream(ref: string): Promise<Writable>
  /** `range` is INCLUSIVE of `end` (HTTP Range / Node fs semantics), not a byte length. */
  createReadStream(ref: string, range?: { start: number; end: number }): Readable
  stat(ref: string): Promise<ArtifactStat | null>
  remove(ref: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  removeSpace(prefix: string): Promise<void>
  sweepTempParts?(cutoffMs: number): Promise<void>
}

/** Filesystem artifact store rooted at `baseDir` (self-host default). */
export const createFsArtifactStore = (baseDir: string): ArtifactStore => {
  const root = resolve(baseDir)

  const pathOf = (ref: string): string => {
    const p = resolve(root, ref)

    if (p !== root && !p.startsWith(root + sep)) {
      throw new Error(`artifact ref escapes base dir: ${ref}`)
    }

    return p
  }

  return {
    createWriteStream: async (ref) => {
      const p = pathOf(ref)
      await mkdir(dirname(p), { recursive: true })
      return createWriteStream(p)
    },
    createReadStream: (ref, range) => {
      const p = pathOf(ref)
      return range
        ? createReadStream(p, { start: range.start, end: range.end })
        : createReadStream(p)
    },
    stat: async (ref) => {
      try {
        const s = await stat(pathOf(ref))
        return { size: s.size, mtimeMs: s.mtimeMs }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null
        }
        throw err
      }
    },
    remove: async (ref) => {
      await rm(pathOf(ref), { force: true })
    },
    rename: async (from, to) => {
      const dst = pathOf(to)
      await mkdir(dirname(dst), { recursive: true })
      await rename(pathOf(from), dst)
    },
    removeSpace: async (prefix) => {
      const p = pathOf(prefix)

      if (!prefix || p === root) {
        throw new Error(`refusing to remove artifact root: ${prefix}`)
      }
      await rm(p, { recursive: true, force: true })
    },
    sweepTempParts: async (cutoffMs) => {
      // Temp parts live one level down (`<root>/<space>/<jobId>.<lease>.part`).
      let spaceDirs: string[]

      try {
        spaceDirs = await readdir(root)
      } catch {
        return // no store dir yet — nothing to sweep
      }
      for (const space of spaceDirs) {
        const dir = join(root, space)
        let names: string[]

        try {
          names = await readdir(dir)
        } catch {
          continue // not a directory / vanished
        }
        for (const name of names) {
          if (!name.endsWith('.part')) {
            continue
          }
          const p = join(dir, name)

          try {
            const s = await stat(p)

            if (s.mtimeMs < cutoffMs) {
              await rm(p, { force: true })
            }
          } catch {
            // gone / raced — fine
          }
        }
      }
    },
  }
}
