// Durable import-staging seam: the uploaded export outlives its HTTP request so a
// re-claimed job can re-read its source after a dropped connection or restart.
// canon: docs/jobs.md#input-staging-191

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { link, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const FINAL_SUFFIX = '.import'
const PART_SUFFIX = '.import.part'
/** The import PLAN published beside its upload: what a Markdown-tree import
 *  froze before its first write, so a re-claimed job replays the same decisions
 *  instead of planning again. canon: docs/import.md#importing-a-markdown-tree-302 */
const PLAN_SUFFIX = '.import-plan'
const PLAN_PART_PREFIX = '.import-plan.part-'

// Grace over the stage→enqueue window: a freshly renamed FINAL may not have its enqueue
// row yet, so it isn't treated as orphaned until the row could have committed.
// Exported so a harness that needs a final judged by its ROW rather than its age can
// clear the SAME window this sweep applies — a copied literal would drift.
export const FINAL_GRACE_MS = 60_000
// Must exceed any upload's max lifetime (Node bounds a request, a proxy an idle socket):
// the PART sweep is age-only, so a shorter grace could delete a live-but-slow upload.
const PART_GRACE_MS = 60 * 60_000

export type ImportStagingStore = {
  /** Stream an upload to durable disk; returns its store-relative ref. */
  stage(space: string, jobId: string, stream: Readable): Promise<string>
  /** Absolute path of a staged ref; the importer opens a real file (yauzl / stream-json
   *  take a path, not a stream), so the store exposes one. */
  pathOf(ref: string): string
  /** Publish this run's plan beside its upload and return the CANONICAL one —
   *  which may be a peer's, if two claims of the same job raced. The publication
   *  is atomic and never clobbers a plan `accepts` says is usable, so the first
   *  executable plan to land is the one every later run adopts; a plan that is
   *  merely written but not linked never wins.
   *  `null` means the plan could not be published durably.
   *
   *  `accepts` is how the caller states which published plan it can actually
   *  EXECUTE — a question this store cannot answer, since the payload is opaque
   *  to it. A sidecar the caller refuses is REPLACED by this run's, atomically;
   *  the caller must hold its current external job fence across this method, since
   *  the filesystem cannot prove a worker still owns the queue lease. See the
   *  publication itself for why both halves are necessary. Absent, every plan that
   *  reads back intact is accepted. */
  publishPlan<T>(
    ref: string,
    lease: string,
    plan: T,
    accepts?: (published: unknown) => boolean,
  ): Promise<T | null>
  /** The published plan, or null when none was published (or it did not survive
   *  intact — a truncated sidecar is treated as absent, never as data). */
  readPlan<T>(ref: string): Promise<T | null>
  remove(ref: string): Promise<void>
  removeSpace(space: string): Promise<void>
  /** GC orphaned uploads: a FINAL is row-aware (swept only when its job is terminal/gone),
   *  a PART is swept by age alone. */
  sweepOrphans(isLive: (jobId: string) => Promise<boolean>, nowMs: number): Promise<void>
}

/** Persisted sidecar envelope. The digest is what makes a torn write detectable:
 *  the publication is atomic, but the bytes it links were fsynced by us, not by
 *  the medium's promise. */
type PlanEnvelope = { version: 1; digest: string; plan: unknown }

const digestOf = (payload: string): string => createHash('sha256').update(payload).digest('hex')

const planEnvelopeOf = (plan: unknown): PlanEnvelope => {
  const payload = JSON.stringify(plan)

  return { version: 1, digest: digestOf(payload), plan }
}

/** Exact bytes the durable sidecar writes, including its version/digest envelope.
 *  Kept beside the encoder so the import metadata ceiling cannot drift onto a
 *  payload that is smaller than the artifact it claims to bound. */
export const serializedImportPlanBytes = (plan: unknown): number =>
  Buffer.byteLength(JSON.stringify(planEnvelopeOf(plan)))

/** fsync a directory so a rename/link is durable, not merely visible. */
const syncDir = async (path: string): Promise<void> => {
  const handle = await open(path, 'r').catch(() => null)

  if (!handle) {
    return
  }
  try {
    await handle.sync()
  } catch {
    // Some filesystems refuse to fsync a directory handle; the publication is
    // still atomic, we simply cannot promise it survives a power cut.
  } finally {
    await handle.close()
  }
}

/** A lease is a worker-generated token; keep it to filename-safe bytes so it can
 *  address this run's temp without ever escaping the staging directory. */
const leaseSlug = (lease: string): string => lease.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)

export const createFsImportStagingStore = (baseDir: string): ImportStagingStore => {
  const root = resolve(baseDir)

  const pathOf = (ref: string): string => {
    const p = resolve(root, ref)

    if (p !== root && !p.startsWith(root + sep)) {
      throw new Error(`import staging ref escapes base dir: ${ref}`)
    }

    return p
  }

  /** The plan's own path: the upload's name with its suffix swapped, so the two
   *  share a job id the sweep can read back off either name. */
  const planPathOf = (ref: string): string => {
    const path = pathOf(ref)

    return path.endsWith(FINAL_SUFFIX)
      ? `${path.slice(0, -FINAL_SUFFIX.length)}${PLAN_SUFFIX}`
      : `${path}${PLAN_SUFFIX}`
  }

  /** Parse and verify the published plan. A version we do not know and a digest
   *  that does not match are both "absent": reinterpreting a sidecar written by
   *  another build is exactly the silent divergence the plan exists to prevent. */
  const readPlan = async <T>(ref: string): Promise<T | null> => {
    const raw = await readFile(planPathOf(ref), 'utf8').catch(() => null)

    if (raw === null) {
      return null
    }
    try {
      const envelope = JSON.parse(raw) as PlanEnvelope

      if (envelope?.version !== 1 || typeof envelope.digest !== 'string') {
        return null
      }

      return digestOf(JSON.stringify(envelope.plan)) === envelope.digest
        ? (envelope.plan as T)
        : null
    } catch {
      return null
    }
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
    publishPlan: async (ref, lease, plan, accepts) => {
      const finalPath = planPathOf(ref)
      const tempPath = `${finalPath.slice(0, -PLAN_SUFFIX.length)}${PLAN_PART_PREFIX}${leaseSlug(lease)}`
      const envelope = planEnvelopeOf(plan)

      /** Is what stands at the final name a plan the CALLER could execute? Both
       *  halves matter: bytes this store cannot read back are absent, and bytes it
       *  can are still only a plan if the caller says so. */
      const standingPlanIsUsable = async (): Promise<boolean> => {
        const published = await readPlan(ref)

        return published !== null && (accepts?.(published) ?? true)
      }

      try {
        // Complete bytes, fsynced, THEN published: a plan that is visible must
        // already be whole. The first publication is a no-clobber hard link; the
        // guarded replacement of an unusable winner is handled below.
        const handle = await open(tempPath, 'w')

        try {
          await handle.writeFile(JSON.stringify(envelope), 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await syncDir(dirname(finalPath))
        let linked = true

        await link(tempPath, finalPath).catch((err: NodeJS.ErrnoException) => {
          // EEXIST = something already stands at the name; whose plan it is decides
          // what happens next. Any other failure is a real publication failure.
          if (err.code !== 'EEXIST') {
            throw err
          }
          linked = false
        })
        // A sidecar the caller cannot execute — torn bytes, or a plan an older
        // build wrote — is REPLACED rather than adopted. Leaving it made the
        // upload unpublishable forever: no-clobber refused every rewrite, the
        // re-read handed back the same refused plan, and the job died retryably on
        // a message about durable storage while the actual squatter sat on disk
        // through every attempt. The replacement is safe exactly where a caller
        // reaches it — a plan missing or unreadable AFTER writing began is
        // terminal upstream, so a run that gets here has proved the write gate is
        // still closed and no bytes on disk depend on the plan being dropped.
        // The caller additionally holds its CURRENT job lease fence across this
        // publication: atomic rename alone cannot stop a reaped worker from
        // replacing the newer worker's plan between this read and the rename.
        //
        // No-clobber still decides between plans that ARE executable: two workers
        // of one build accept each other's, so neither can ever replace the other.
        if (!linked && !(await standingPlanIsUsable())) {
          await rename(tempPath, finalPath)
        }
        await syncDir(dirname(finalPath))
      } finally {
        await rm(tempPath, { force: true }).catch(() => {})
      }

      // Read back rather than returning what we just wrote: the winner is
      // whatever is on disk, and only re-reading proves which run that was.
      return await readPlan(ref)
    },
    readPlan: <T>(ref: string) => readPlan<T>(ref),
    remove: async (ref) => {
      const planPath = planPathOf(ref)

      await rm(pathOf(ref), { force: true })
      await rm(planPath, { force: true })
      // Completeness of the contract, not garbage this call actually finds: every
      // caller today is the route, unwinding an upload before a plan could exist,
      // so there is nothing here to sweep. What it buys is that `remove(ref)` means
      // what it says — nothing of this upload survives it — for the caller a later
      // change adds. A `.import-plan.part-<lease>` left by a publisher that died
      // between writing its temp and linking it is reclaimed by the age sweep,
      // which is what owns that case.
      const dir = dirname(planPath)
      const tempPrefix = `${basename(planPath).slice(0, -PLAN_SUFFIX.length)}${PLAN_PART_PREFIX}`

      for (const name of await readdir(dir).catch(() => [])) {
        if (name.startsWith(tempPrefix)) {
          await rm(join(dir, name), { force: true })
        }
      }
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
            const planPart = name.indexOf(PLAN_PART_PREFIX)

            if (name.endsWith(PART_SUFFIX) || planPart !== -1) {
              const s = await stat(p)

              if (s.mtimeMs < nowMs - PART_GRACE_MS) {
                await rm(p, { force: true })
              }
            } else if (name.endsWith(FINAL_SUFFIX) || name.endsWith(PLAN_SUFFIX)) {
              const s = await stat(p)

              if (s.mtimeMs >= nowMs - FINAL_GRACE_MS) {
                continue
              }
              // The plan is the upload's sibling and shares its lifetime: both are
              // needed by a retry, and neither may outlive the row that owns them.
              const jobId = name.endsWith(PLAN_SUFFIX)
                ? name.slice(0, -PLAN_SUFFIX.length)
                : name.slice(0, -FINAL_SUFFIX.length)

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
