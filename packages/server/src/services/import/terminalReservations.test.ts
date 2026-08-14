// What closes an import's destination claims, and when (#302). The observer runs
// on the durable row rather than in the handler, so these cases are about the
// window the handler cannot cover: the run has ended, and something must notice.

import { describe, expect, it, vi } from 'vitest'

import { closeTerminalImportReservations } from './terminalReservations'

const harness = (
  opts: { status?: string | null; close?: (input: { jobId: string }) => Promise<void> } = {},
) => {
  const closeForJob = vi.fn(opts.close ?? (async () => {}))
  const log = vi.fn()

  return {
    closeForJob,
    log,
    deps: {
      metaDb: {
        importReservations: {
          activeJobIds: async () => ['job-1', 'job-2'],
          closeForJob,
        },
        jobs: {
          get: async () => (opts.status === null ? null : { status: opts.status ?? 'succeeded' }),
        },
      },
      log,
    } as unknown as Parameters<typeof closeTerminalImportReservations>[0],
  }
}

describe('terminal import reservations (#302)', () => {
  it('closes the claims of a job that has ended', async () => {
    const { deps, closeForJob } = harness({ status: 'succeeded' })

    await closeTerminalImportReservations(deps)

    expect(closeForJob).toHaveBeenCalledTimes(2)
    expect(closeForJob.mock.calls[0][0]).toMatchObject({ jobId: 'job-1' })
  })

  it.each(['failed', 'canceled'])('closes them for a %s job too', async (status) => {
    const { deps, closeForJob } = harness({ status })

    await closeTerminalImportReservations(deps)

    expect(closeForJob).toHaveBeenCalledTimes(2)
  })

  it('treats a vanished row as terminal — its claims must not outlive it', async () => {
    const { deps, closeForJob } = harness({ status: null })

    await closeTerminalImportReservations(deps)

    expect(closeForJob).toHaveBeenCalledTimes(2)
  })

  it.each(['pending', 'running'])('leaves a %s import alone', async (status) => {
    const { deps, closeForJob } = harness({ status })

    await closeTerminalImportReservations(deps)

    // Holding the destinations of a LIVE import is the feature, not a leak.
    expect(closeForJob).not.toHaveBeenCalled()
  })

  it('needs nothing but the job id: no store is resolved, so no space can block it', async () => {
    const { deps, closeForJob } = harness({ status: 'succeeded' })

    await closeTerminalImportReservations(deps)

    // The regression this pins: cleanup used to resolve the space's store first, so
    // an archived or purged space threw before the close and the claim was held
    // forever — a destination nothing would ever free again.
    expect(closeForJob).toHaveBeenCalledWith({ jobId: 'job-1', now: expect.any(String) })
  })

  it('reports a stuck job and still closes the others', async () => {
    const failing = vi.fn(async ({ jobId }: { jobId: string }) => {
      if (jobId === 'job-1') {
        throw new Error('the database went away')
      }
    })
    const { deps, closeForJob, log } = harness({ status: 'succeeded', close: failing })

    await expect(closeTerminalImportReservations(deps)).resolves.toBeUndefined()

    expect(closeForJob).toHaveBeenCalledTimes(2)
    // Swallowed so one stuck job cannot stop the pass — but never silently: until
    // the next tick succeeds, this line is the only evidence a claim is stuck.
    expect(log).toHaveBeenCalledWith(
      'import reservation cleanup failed for job-1',
      expect.any(Error),
    )
  })
})
