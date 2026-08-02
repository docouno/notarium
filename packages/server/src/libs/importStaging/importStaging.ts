// Durable import-staging seam: the uploaded export outlives its HTTP request so a
// re-claimed job can re-read its source after a dropped connection or restart.
// canon: docs/jobs.md#input-staging-191

import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const FINAL_SUFFIX = '.import'
const PART_SUFFIX = '.import.part'

// Grace over the stage→enqueue window: a freshly renamed FINAL may not have its enqueue
// row yet, so it isn't treated as orphaned until the row could have committed.
const FINAL_GRACE_MS = 60_000
// Must exceed any upload's max lifetime (Node bounds a request, a proxy an idle socket):
// the PART sweep is age-only, so a shorter grace could delete a live-but-slow upload.
const PART_GRACE_MS = 60 * 60_000

export type ImportStagingStore = {
  /** Stream an upload to durable disk; returns its store-relative ref. */
  stage(space: string, jobId: string, stream: Readable): Promise<string>
  /** Absolute path of a staged ref; the importer opens a real file (yauzl / stream-json
   *  take a path, not a stream), so the store exposes one. */
  pathOf(ref: string): string
  remove(ref: string): Promise<void>
  removeSpace(space: string): Promise<void>
  /** GC orphaned uploads: a FINAL is row-aware (swept only when its job is terminal/gone),
   *  a PART is swept by age alone. */
  sweepOrphans(isLive: (jobId: string) => Promise<boolean>, nowMs: number): Promise<void>
}

export const createFsImportStagingStore = (baseDir: string): ImportStagingStore => {
  const root = resolve(baseDir)

  const pathOf = (ref: string): string => {
    const p = resolve(root, ref)

    if (p !== root && !p.startsWith(root + sep)) {
      throw new Error(`import staging ref escapes base dir: ${ref}`)
    }

    return p
  }

  return {
    stage: async (space, jobId, stream) => {
      const ref = `${space}/${jobId}${FINAL_SUFFIX}`
      const partRef = `${space}/${jobId}${PART_SUFFIX}`
      const partPath = pathOf(partRef)
      await mkdir(dirname(partPath), { recursive: true })
      try {
        await pipeline(stream, createWriteStream(partPath))
        // Atomic rename: the final name never exists half-written.
        await rename(partPath, pathOf(ref))
      } catch (err) {
        await rm(partPath, { force: true }).catch(() => {})
        throw err
      }

      return ref
    },
    pathOf,
    remove: async (ref) => {
      await rm(pathOf(ref), { force: true })
    },
    removeSpace: async (space) => {
      const p = pathOf(space)

      if (!space || p === root) {
        throw new Error(`refusing to remove import staging root: ${space}`)
      }
      await rm(p, { recursive: true, force: true })
    },
    sweepOrphans: async (isLive, nowMs) => {
      let spaceDirs: string[]

      try {
        spaceDirs = await readdir(root)
      } catch {
        return // no staging dir yet — nothing to sweep
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
          const p = join(dir, name)

          try {
            if (name.endsWith(PART_SUFFIX)) {
              const s = await stat(p)

              if (s.mtimeMs < nowMs - PART_GRACE_MS) {
                await rm(p, { force: true })
              }
            } else if (name.endsWith(FINAL_SUFFIX)) {
              const s = await stat(p)

              if (s.mtimeMs >= nowMs - FINAL_GRACE_MS) {
                continue
              }
              const jobId = name.slice(0, -FINAL_SUFFIX.length)

              if (!(await isLive(jobId))) {
                await rm(p, { force: true })
              }
            }
          } catch {
            // gone / raced — fine
          }
        }
      }
    },
  }
}
