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
