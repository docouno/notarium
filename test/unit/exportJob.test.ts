// Unit tests for the `export` job handler (#105) — the failure/abort branches the e2e
// happy path can't reach: an abort mid-walk removes only this run's temp part and never
// publishes the final ref; a lost lease at the final report (right before the atomic
// rename) aborts without publishing; and an ARCHIVER-level error (which does not
// propagate through the pipe to the sink) must reject the handler, NOT hang it forever
// (the round-2 regression the sink-destroy-on-archive-error fix closes).

import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { createExportHandler } from '../../packages/server/src/apps/server/consumers/exportJob'
import {
  JobAbortedError,
  type JobContext,
} from '../../packages/server/src/apps/server/consumers/jobRunner'
import type { ArtifactStore } from '../../packages/server/src/libs/artifactStore'
import type { JobRecord } from '../../packages/server/src/services/metaDb/types'

const memArtifacts = () => {
  const files = new Map<string, Buffer>()
  const store: ArtifactStore = {
    createWriteStream: async (ref) => {
      const chunks: Buffer[] = []
      const w = new Writable({
        write: (c, _e, cb) => {
          chunks.push(Buffer.from(c))
          cb()
        },
      })
      w.on('finish', () => files.set(ref, Buffer.concat(chunks)))
      return w
    },
    createReadStream: () => {
      throw new Error('unused')
    },
    stat: async (ref) => {
      const f = files.get(ref)
      return f ? { size: f.length, mtimeMs: 0 } : null
    },
    remove: async (ref) => {
      files.delete(ref)
    },
    rename: async (from, to) => {
      const f = files.get(from)

      if (!f) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      files.set(to, f)
      files.delete(from)
    },
    removeSpace: async () => {},
  }
  return Object.assign(store, { files })
}

/** A store whose exportNotes yields the given entries; `onFirst` fires as the walk
 *  starts (used to abort the run mid-walk). */
const storeOf = (entries: Array<{ path: string; content: unknown }>, onFirst?: () => void) => ({
  async *exportNotes() {
    onFirst?.()
    for (const e of entries) {
      yield e as { path: string; content: string }
    }
  },
})

const jobRec = (over: Partial<JobRecord> = {}): JobRecord =>
  ({
    id: 'j1',
    space: 'S',
    kind: 'export',
    status: 'running',
    principal: 'user:a',
    params: {},
    progressDone: 0,
    progressTotal: null,
    phase: null,
    attempts: 1,
    maxAttempts: 3,
    runAt: '2026-01-01T00:00:00.000Z',
    lockedAt: '2026-01-01T00:00:00.000Z',
    lockedBy: 'lease-A',
    artifactRef: null,
    artifactBytes: null,
    artifactName: null,
    result: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    expiresAt: null,
    ...over,
  }) as JobRecord

const ctxOf = (
  store: ReturnType<typeof storeOf>,
  artifacts: ReturnType<typeof memArtifacts>,
  over: { report?: JobContext['report']; job?: Partial<JobRecord> } = {},
) => {
  const controller = new AbortController()
  const handler = createExportHandler({
    resolveStore: async () => store as never,
    slugOf: () => 'main',
    now: () => new Date('2026-06-20T00:00:00.000Z'),
  })
  const ctx: JobContext = {
    job: jobRec(over.job),
    signal: controller.signal,
    artifacts,
    report: over.report ?? (async () => {}),
  }
  return { handler, ctx, controller }
}

describe('createExportHandler (#105)', () => {
  it('archives entries, publishes via atomic rename, and reports the real count', async () => {
    const artifacts = memArtifacts()
    const store = storeOf([
      { path: 'docs/a.md', content: '# A\n\nbody' },
      { path: 'root.md', content: '# Root\n\nbody' },
    ])
    const reports: Array<{ done: number; total?: number | null; phase?: string | null }> = []
    const { handler, ctx } = ctxOf(store, artifacts, { report: async (p) => void reports.push(p) })
    const out = await handler(ctx)

    expect(out.artifactRef).toBe('S/j1.zip')
    expect(out.result).toEqual({ count: 2 })
    // Published under the final ref; the temp part is gone (renamed away).
    expect(artifacts.files.has('S/j1.zip')).toBe(true)
    expect([...artifacts.files.keys()].some((k) => k.endsWith('.part'))).toBe(false)
    // The final report carries the REAL count as the total (100% for a narrowed export).
    expect(reports.at(-1)).toMatchObject({ done: 2, total: 2, phase: 'done' })
  })

  it('an abort mid-walk removes only this run’s temp part and never publishes the ref', async () => {
    const artifacts = memArtifacts()
    const { handler, ctx, controller } = ctxOf(
      storeOf([{ path: 'a.md', content: 'x' }], () => controller.abort()),
      artifacts,
    )
    await expect(handler(ctx)).rejects.toBeInstanceOf(JobAbortedError)
    expect(artifacts.files.has('S/j1.zip')).toBe(false) // never published
    expect([...artifacts.files.keys()].some((k) => k.endsWith('.part'))).toBe(false) // temp cleaned
  })

  it('a lost lease at the final report aborts BEFORE the rename — no orphan ref', async () => {
    const artifacts = memArtifacts()

    // report throws only on the final phase:'done' (the lease re-check the rename gates on).
    const report: JobContext['report'] = async (p) => {
      if (p.phase === 'done') {
        throw new JobAbortedError()
      }
    }
    const { handler, ctx } = ctxOf(storeOf([{ path: 'a.md', content: 'x' }]), artifacts, { report })
    await expect(handler(ctx)).rejects.toBeInstanceOf(JobAbortedError)
    expect(artifacts.files.has('S/j1.zip')).toBe(false) // rename never ran
    expect([...artifacts.files.keys()].some((k) => k.endsWith('.part'))).toBe(false)
  })

  it('an archiver-level error REJECTS the handler (does not hang) and cleans the temp', async () => {
    const artifacts = memArtifacts()
    // A nullish content makes archiver.append emit an error on its Readable — which does
    // NOT propagate through the pipe to the sink. The handler must still reject (the fix
    // destroys the sink so the awaiters settle) rather than hang forever.
    const { handler, ctx } = ctxOf(storeOf([{ path: 'bad.md', content: undefined }]), artifacts)
    await expect(handler(ctx)).rejects.toBeTruthy()
    expect(artifacts.files.has('S/j1.zip')).toBe(false)
    expect([...artifacts.files.keys()].some((k) => k.endsWith('.part'))).toBe(false)
  }, 5000)
})
