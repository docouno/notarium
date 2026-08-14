// Unit tests for the import staging store (#191) — the durable home an uploaded
// export lives in so a durable import job can read it after the request / a restart.
// Pins: a staged file is readable at its path; traversal refs are refused; removeSpace
// drops a space subtree (and refuses the root); and sweepOrphans is BOTH row-aware
// (keeps a live job's upload, drops a terminal/gone one) AND age-gated (never sweeps a
// just-staged file whose enqueue row hasn't landed yet).

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { createFsImportStagingStore } from '../../packages/server/src/libs/importStaging'

const dirs: string[] = []

const freshRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'notarium-staging-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true })
  }
})

const stream = (s: string) => Readable.from([Buffer.from(s)])

describe('createFsImportStagingStore (#191)', () => {
  it('stages an upload via a temp part + atomic rename, leaving only the final name', async () => {
    const root = freshRoot()
    const store = createFsImportStagingStore(root)
    const ref = await store.stage('space-1', 'job-1', stream('hello export'))
    expect(ref).toBe('space-1/job-1.import')
    expect(readFileSync(store.pathOf(ref), 'utf8')).toBe('hello export')
    // The in-progress `.import.part` was renamed away — the final name is all that remains.
    expect((await readdir(join(root, 'space-1'))).sort()).toEqual(['job-1.import'])
    await store.remove(ref)
    expect(store.pathOf(ref)).toBeTruthy() // path still resolvable
    await expect(store.remove(ref)).resolves.toBeUndefined() // idempotent (force)
  })

  it('refuses a ref that escapes the root', () => {
    const store = createFsImportStagingStore(freshRoot())
    expect(() => store.pathOf('../escape')).toThrow(/escapes base dir/)
    expect(() => store.pathOf('space/../../escape')).toThrow(/escapes base dir/)
  })

  it('removeSpace drops a space subtree but refuses an empty/root prefix', async () => {
    const root = freshRoot()
    const store = createFsImportStagingStore(root)
    await store.stage('space-1', 'a', stream('x'))
    await store.stage('space-2', 'b', stream('y'))
    await store.removeSpace('space-1')
    expect(await readdir(root)).toEqual(['space-2'])
    await expect(store.removeSpace('')).rejects.toThrow(/refusing to remove/)
  })

  it('sweepOrphans is row-aware on FINAL uploads — keeps a live job, drops a terminal/gone one', async () => {
    const store = createFsImportStagingStore(freshRoot())
    await store.stage('S', 'live', stream('a'))
    await store.stage('S', 'dead', stream('b'))
    await store.stage('S', 'gone', stream('c'))
    // nowMs in the far future ⇒ every final is past its grace; liveness decides.
    await store.sweepOrphans(async (id) => id === 'live', Number.MAX_SAFE_INTEGER)
    expect(readFileSync(store.pathOf('S/live.import'), 'utf8')).toBe('a')
    // dead + gone were swept (their jobs not live)
    const names = await readdir(store.pathOf('S'))
    expect(names.sort()).toEqual(['live.import'])
  })

  it('sweepOrphans never sweeps a too-fresh FINAL upload (the pre-enqueue window)', async () => {
    const store = createFsImportStagingStore(freshRoot())
    await store.stage('S', 'pending', stream('a'))
    // nowMs = 0 ⇒ no file is older than its grace, so even a not-live job's fresh
    // upload survives — the guard for a file staged but not yet enqueued.
    await store.sweepOrphans(async () => false, 0)
    expect(readFileSync(store.pathOf('S/pending.import'), 'utf8')).toBe('a')
  })

  it('an in-progress `.import.part` is swept only by AGE, never row-aware — it survives past a final would', async () => {
    const root = freshRoot()
    const store = createFsImportStagingStore(root)
    await store.stage('S', 'live', stream('a')) // a live job's final
    await store.stage('S', 'dead', stream('b')) // a terminal job's final
    const partPath = store.pathOf('S/inflight.import.part') // an in-progress/crashed upload
    writeFileSync(partPath, 'streaming…')
    const mtime = statSync(partPath).mtimeMs
    // 5 minutes on: past the 60s FINAL grace, well within the 1h PART grace.
    await store.sweepOrphans(async (id) => id === 'live', mtime + 5 * 60_000)
    expect(readFileSync(store.pathOf('S/live.import'), 'utf8')).toBe('a') // live final kept (row-aware)
    expect(readFileSync(partPath, 'utf8')).toBe('streaming…') // part survived (young < 1h part grace)
    // The not-live `dead` final WAS swept at this same age — proving the part outlives it.
    const after = await readdir(join(root, 'S'))
    expect(after).not.toContain('dead.import')
    expect(after).toContain('inflight.import.part')
    // Far in the future ⇒ past the 1h part grace ⇒ the orphaned part is finally reclaimed.
    await store.sweepOrphans(async (id) => id === 'live', mtime + 2 * 60 * 60_000)
    expect((await readdir(join(root, 'S'))).some((n) => n.endsWith('.part'))).toBe(false)
  })
})

// The plan sidecar (#302): a Markdown-tree import freezes its decisions beside
// its upload, so a re-claimed job replays the SAME plan instead of deciding
// again. Publication is atomic and no-clobber — that is what makes "the first
// plan wins" true for two workers racing one job rather than a hope.
describe('the import plan sidecar (#302)', () => {
  const PLAN = { version: 1 as const, uploadRef: 'S/job.import', entries: ['a.md'] }

  it('publishes a plan beside its upload and reads it back', async () => {
    const store = createFsImportStagingStore(freshRoot())
    const ref = await store.stage('S', 'job', stream('zip'))

    expect(await store.readPlan(ref)).toBeNull()
    expect(await store.publishPlan(ref, 'lease-1', PLAN)).toEqual(PLAN)
    expect(await store.readPlan(ref)).toEqual(PLAN)
  })

  it('leaves no temp behind, and the loser of a race adopts the winner’s plan', async () => {
    const root = freshRoot()
    const store = createFsImportStagingStore(root)
    const ref = await store.stage('S', 'job', stream('zip'))
    const first = await store.publishPlan(ref, 'lease-1', PLAN)
    const second = await store.publishPlan(ref, 'lease-2', { ...PLAN, entries: ['b.md'] })

    // The second publisher does NOT replace the canonical plan; it receives it.
    expect(first).toEqual(PLAN)
    expect(second).toEqual(PLAN)
    expect((await readdir(join(root, 'S'))).sort()).toEqual(['job.import', 'job.import-plan'])
  })

  it('treats a truncated or foreign sidecar as absent rather than as data', async () => {
    const store = createFsImportStagingStore(freshRoot())
    const ref = await store.stage('S', 'job', stream('zip'))

    await store.publishPlan(ref, 'lease-1', PLAN)
    const planPath = store.pathOf(ref).replace(/\.import$/, '.import-plan')

    // Half a file: the envelope's digest is exactly what makes this detectable.
    writeFileSync(planPath, readFileSync(planPath, 'utf8').slice(0, 40))
    expect(await store.readPlan(ref)).toBeNull()

    writeFileSync(planPath, JSON.stringify({ version: 2, digest: 'x', plan: PLAN }))
    expect(await store.readPlan(ref)).toBeNull()
  })

  // The envelope's whole purpose. A sidecar can be well-formed JSON of the right
  // version and still not be the bytes we fsynced — that is what a torn or
  // tampered file looks like — and reinterpreting it is the silent divergence the
  // plan exists to prevent. Only the digest can tell the two apart.
  it('treats a well-formed envelope whose digest does not match as absent', async () => {
    const store = createFsImportStagingStore(freshRoot())
    const ref = await store.stage('S', 'job', stream('zip'))

    await store.publishPlan(ref, 'lease-1', PLAN)
    const planPath = store.pathOf(ref).replace(/\.import$/, '.import-plan')
    const envelope = JSON.parse(readFileSync(planPath, 'utf8')) as {
      version: number
      digest: string
      plan: typeof PLAN
    }

    // Same digest, a different plan under it: a swapped payload reads as valid
    // JSON of a version we know, and nothing but the hash notices.
    writeFileSync(
      planPath,
      JSON.stringify({ ...envelope, plan: { ...PLAN, entries: ['tampered.md'] } }),
    )
    expect(await store.readPlan(ref)).toBeNull()
  })

  // No-clobber decides between plans the caller can EXECUTE. A sidecar it cannot
  // is a different question, and answering it the same way made the upload
  // unpublishable for good: the rewrite was refused, the read-back handed the
  // refused plan straight back, and every retry repeated that forever.
  it('replaces a published plan the caller refuses, and adopts one it accepts', async () => {
    const root = freshRoot()
    const store = createFsImportStagingStore(root)
    const ref = await store.stage('S', 'job', stream('zip'))
    const older = { ...PLAN, entries: ['from-an-older-build.md'] }
    const accepts = (published: unknown): boolean =>
      (published as typeof PLAN).entries[0] !== 'from-an-older-build.md'

    expect(await store.publishPlan(ref, 'lease-1', older)).toEqual(older)
    // Refused ⇒ replaced: what the rebuilt run publishes is what stands on disk.
    const rebuilt = { ...PLAN, entries: ['rebuilt.md'] }

    expect(await store.publishPlan(ref, 'lease-2', rebuilt, accepts)).toEqual(rebuilt)
    expect(await store.readPlan(ref)).toEqual(rebuilt)
    // Accepted ⇒ canonical, exactly as before: a peer of the same build never
    // replaces a plan it could have executed itself.
    const third = { ...PLAN, entries: ['third.md'] }

    expect(await store.publishPlan(ref, 'lease-3', third, accepts)).toEqual(rebuilt)
    expect(await store.readPlan(ref)).toEqual(rebuilt)
    // And the replacement leaves no temp behind either.
    expect((await readdir(join(root, 'S'))).sort()).toEqual(['job.import', 'job.import-plan'])
  })

  // The same dead end without a caller predicate at all: bytes this store cannot
  // read back are not a plan, and holding the name against every rewrite is how a
  // torn sidecar outlived the job it belonged to.
  it('replaces a sidecar whose bytes no longer read back as a plan', async () => {
    const store = createFsImportStagingStore(freshRoot())
    const ref = await store.stage('S', 'job', stream('zip'))

    await store.publishPlan(ref, 'lease-1', PLAN)
    const planPath = store.pathOf(ref).replace(/\.import$/, '.import-plan')

    writeFileSync(planPath, readFileSync(planPath, 'utf8').slice(0, 40))
    expect(await store.readPlan(ref)).toBeNull()
    expect(await store.publishPlan(ref, 'lease-2', PLAN)).toEqual(PLAN)
    expect(await store.readPlan(ref)).toEqual(PLAN)
  })

  it('sweeps the plan with its upload, and a plan temp by age alone', async () => {
    const root = freshRoot()
    const store = createFsImportStagingStore(root)
    const liveRef = await store.stage('S', 'live', stream('zip'))
    const deadRef = await store.stage('S', 'dead', stream('zip'))

    await store.publishPlan(liveRef, 'lease-1', PLAN)
    await store.publishPlan(deadRef, 'lease-1', PLAN)
    const orphanTemp = store.pathOf('S/crashed.import-plan.part-lease-9')

    writeFileSync(orphanTemp, '{"half":')
    const mtime = statSync(orphanTemp).mtimeMs

    await store.sweepOrphans(async (id) => id === 'live', mtime + 5 * 60_000)
    // The live job keeps BOTH: a retry needs the upload and the plan together.
    expect((await readdir(join(root, 'S'))).sort()).toEqual([
      'crashed.import-plan.part-lease-9',
      'live.import',
      'live.import-plan',
    ])
    await store.sweepOrphans(async (id) => id === 'live', mtime + 2 * 60 * 60_000)
    expect((await readdir(join(root, 'S'))).sort()).toEqual(['live.import', 'live.import-plan'])
  })

  // Upload, plan AND plan temps: a publisher that crashed between writing its
  // temp and linking it leaves one behind, and it belongs to this upload as much
  // as the plan does. Removing only the two named files handed it to the age
  // sweep — an hour of a file whose owner is already gone.
  it('removes the plan and any crashed plan temp when its upload is removed', async () => {
    const root = freshRoot()
    const store = createFsImportStagingStore(root)
    const ref = await store.stage('S', 'job', stream('zip'))
    const otherRef = await store.stage('S', 'other', stream('zip'))

    await store.publishPlan(ref, 'lease-1', PLAN)
    writeFileSync(store.pathOf('S/job.import-plan.part-lease-9'), '{"half":')
    writeFileSync(store.pathOf('S/other.import-plan.part-lease-9'), '{"half":')
    await store.remove(ref)

    // Another job's temp is not ours to reclaim — the two share a directory, not
    // a lifetime.
    expect(await readdir(join(root, 'S'))).toEqual([
      'other.import',
      'other.import-plan.part-lease-9',
    ])
    await store.remove(otherRef)
    expect(await readdir(join(root, 'S'))).toEqual([])
  })
})
