// The production wiring of the import contour's terminal cleanup (#302).
//
// Where that cleanup sits in a maintenance tick is pinned elsewhere, against a
// stand-in hook the test passes itself. What nothing observed is the half that
// makes the other pin mean anything: that the composition root passes the hook at
// all, and passes the import contour's own cleanup over the real meta-DB rather
// than something shaped like it. Deleting `onTerminalCleanup:` from `createServer`
// left every one of those tests green.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import type * as Consumers from '../../packages/server/src/apps/server/consumers'
import type { JobRunnerOptions } from '../../packages/server/src/apps/server/consumers/jobRunner'
import { createServer } from '../../packages/server/src/apps/server/server'
import type * as ImportService from '../../packages/server/src/services/import'

const captured = vi.hoisted(() => ({
  runner: null as JobRunnerOptions | null,
  cleanupCalls: [] as unknown[],
}))

vi.mock('../../packages/server/src/apps/server/consumers', async () => {
  const actual = await vi.importActual<typeof Consumers>(
    '../../packages/server/src/apps/server/consumers',
  )

  return {
    ...actual,
    createJobRunner: (opts: JobRunnerOptions) => {
      captured.runner = opts

      return actual.createJobRunner(opts)
    },
  }
})

vi.mock('../../packages/server/src/services/import', async () => {
  const actual = await vi.importActual<typeof ImportService>(
    '../../packages/server/src/services/import',
  )

  return {
    ...actual,
    closeTerminalImportReservations: async (
      deps: Parameters<typeof actual.closeTerminalImportReservations>[0],
    ) => {
      captured.cleanupCalls.push(deps)

      return await actual.closeTerminalImportReservations(deps)
    },
  }
})

const roots: string[] = []
const apps: Array<{ close: () => Promise<void> }> = []

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close().catch(() => {})))
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('createServer wires the import contour into the job runner (#302)', () => {
  it('passes the terminal cleanup, and it is the import contour’s own', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-import-wiring-'))

    roots.push(root)
    apps.push(
      await createServer({
        spaces: [{ slug: 'main', displayName: 'Main' }],
        authMode: 'none',
        // File-backed: the runner only exists WITH a meta-DB, so a host without one
        // would pass this test by having nothing to wire.
        metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
        engineDataDir: join(root, 'engine'),
        jobsDataDir: join(root, 'jobs'),
        importStagingDir: join(root, 'jobs', 'imports'),
        spacesRoot: root,
        pollIntervalMs: 0,
      }),
    )

    const opts = captured.runner

    expect(opts).toBeTruthy()
    // Both consumer hooks the maintenance order is a contract about: the claim
    // close, and the staging/plan sweep that must run after it.
    expect(opts?.onTerminalCleanup).toBeTypeOf('function')
    expect(opts?.onMaintenance).toBeTypeOf('function')

    await opts!.onTerminalCleanup!()

    // Not merely "a function": the one that closes import reservations, handed the
    // meta-DB the jobs layer itself runs on — the row it reads to know a job ended.
    expect(captured.cleanupCalls).toHaveLength(1)
    expect(captured.cleanupCalls[0]).toMatchObject({
      metaDb: expect.objectContaining({ importReservations: expect.anything() }),
    })

    // And the other hook the same way, because "a function" was all that was ever
    // asked of it: an orphaned upload past its grace, in the staging directory this
    // server was configured with, and a hook that is the row-aware sweep over it.
    const orphan = join(root, 'jobs', 'imports', 'main', 'no-such-job.import')

    await mkdir(dirname(orphan), { recursive: true })
    await writeFile(orphan, 'an upload whose job never existed')
    const aged = new Date(Date.now() - 2 * 60 * 60_000)

    await utimes(orphan, aged, aged)
    await opts!.onMaintenance!()
    expect(existsSync(orphan)).toBe(false)
  })
})
