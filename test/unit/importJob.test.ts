// Unit tests for the `import` job handler (#191) — the branches the e2e happy path
// doesn't isolate: it reuses runImport over a STAGED upload and returns the summary in
// `result` with NO artifact; a pre-aborted signal surfaces as a clean JobAbortedError
// (a cooperative cancel); a missing uploadRef fails loudly; and the ephemeral member
// temp dir is always cleaned. The durable upload is deliberately NOT removed by the
// handler (the staging sweep owns that) — asserted here so a refactor can't regress it.

import AdmZip from 'adm-zip'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { createImportHandler } from '../../packages/server/src/apps/server/consumers/importJob'
import {
  createJobRunner,
  JobAbortedError,
  type JobContext,
  type JobHandler,
} from '../../packages/server/src/apps/server/consumers/jobRunner'
import { TerminalJobError } from '../../packages/server/src/apps/server/consumers/terminalJobError'
import {
  createFsImportStagingStore,
  type ImportStagingStore,
} from '../../packages/server/src/libs/importStaging'
import { closeTerminalImportReservations } from '../../packages/server/src/services/import'
import { ImportFenceError } from '../../packages/server/src/services/metaDb/importFence'
import { SqliteMetaDb } from '../../packages/server/src/services/metaDb/sqliteMetaDb'
import type { JobRecord } from '../../packages/server/src/services/metaDb/types'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true })
  }
})

const CONVERSATIONS = JSON.stringify([
  {
    uuid: 'c-1',
    name: 'Hello',
    created_at: '2024-03-15T14:30:00Z',
    chat_messages: [{ sender: 'human', text: 'hi' }],
  },
])

/** Write an upload to disk and return a staging stub whose pathOf points at it; the
 *  `removed` flag records whether the handler tried to reclaim the upload (it must not). */
const stagingFor = (content: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'notarium-importjob-test-'))
  dirs.push(dir)
  const path = join(dir, 'upload.tmp')
  writeFileSync(path, content)
  const state = { removed: false }
  const staging: ImportStagingStore = {
    stage: async () => 'ref',
    pathOf: () => path,
    remove: async () => {
      state.removed = true
    },
    removeSpace: async () => {},
    sweepOrphans: async () => {},
    publishPlan: async (_ref, _lease, plan) => plan,
    readPlan: async () => null,
  }
  return { staging, state }
}

const fakeStore = () => {
  const writes: Array<{
    title?: string
    fileName?: string
    directory?: string
    id?: string
    originalId?: string
    expectedDestinationId?: string | null
    sourceLocator?: string
  }> = []
  /** Who owns each destination, as the identity layer would answer. Only read
   *  when the caller states an expectation — an import that never passes one gets
   *  the unguarded behaviour every other write path has. */
  const owners = new Map<string, string>()
  return {
    writes,
    owners,
    // A Markdown tree is planned against the destination inventory, and the plan
    // refuses to run at all without a store that can be checkpointed and listed —
    // an empty space is still an answer.
    list: async () =>
      writes.map((write, index) => ({
        id: write.id ?? `n${index + 1}`,
        title: write.title ?? '',
        filePath: `${write.directory ? `${write.directory}/` : ''}${write.fileName}.md`,
        sourceLocator: write.sourceLocator,
        modifiedAt: null,
        createdAt: null,
      })),
    checkpoint: async () => {},
    read: async (id: string) => {
      const index = writes.findIndex((write, at) => (write.id ?? `n${at + 1}`) === id)
      const write = writes[index]

      if (!write) {
        throw new Error(`missing note: ${id}`)
      }

      return {
        id,
        title: write.title,
        filePath: `${write.directory ? `${write.directory}/` : ''}${write.fileName}.md`,
        sourceLocator: write.sourceLocator,
        content: '',
        frontmatter: {},
        versionToken: `v${index + 1}`,
      }
    },
    write: async (input: {
      title?: string
      fileName?: string
      directory?: string
      id?: string
      originalId?: string
      expectedDestinationId?: string | null
      sourceLocator?: string
    }) => {
      // The identity layer's planned-destination guard, as the import sees it:
      // it can only refuse when the caller states what the plan proved.
      if (input.expectedDestinationId !== undefined) {
        const path = `${input.directory}/${input.fileName}.md`
        const owner = owners.get(path) ?? null

        if (owner !== input.expectedDestinationId && owner !== input.id) {
          throw Object.assign(
            new Error(`${path} is owned by ${owner}; the import planned to create it`),
            { reason: 'destination_owner_conflict' },
          )
        }
      }
      if (input.originalId) {
        const existing = writes.findIndex(
          (write, index) => (write.id ?? `n${index + 1}`) === input.originalId,
        )

        if (existing < 0) {
          throw new Error(`missing note: ${input.originalId}`)
        }
        writes[existing] = { ...writes[existing], ...input, id: input.originalId }
        const updated = writes[existing]
        return {
          id: input.originalId,
          title: updated.title,
          class: 'user-doc' as const,
          filePath: `${updated.directory ? `${updated.directory}/` : ''}${updated.fileName}.md`,
          sourceLocator: updated.sourceLocator,
          versionToken: `v${existing + 2}`,
        }
      }
      writes.push(input)
      // Mirrors the write path: a caller-supplied identity is the one the note
      // gets, and only an absent one is minted here.
      const id = input.id ?? `n${writes.length}`
      const filePath = `${input.directory ? `${input.directory}/` : ''}${input.fileName}.md`
      owners.set(filePath, id)
      return {
        id,
        title: input.title,
        class: 'user-doc' as const,
        filePath,
        sourceLocator: input.sourceLocator,
        versionToken: `v${writes.length}`,
      }
    },
  }
}

/** A staged upload holding a two-note Markdown tree — the shape whose writes the
 *  reservation is supposed to fence. */
const stagingForTree = (
  over: {
    readPlan?: () => Promise<unknown>
    publishPlan?: (ref: string, lease: string, plan: unknown) => Promise<unknown>
  } = {},
) => {
  const zip = new AdmZip()
  const note = (title: string) => `---\ntitle: ${title}\n---\n\n# ${title}\n\nBody.\n`

  zip.addFile('vault/a.md', Buffer.from(note('A'), 'utf8'))
  zip.addFile('vault/b.md', Buffer.from(note('B'), 'utf8'))
  const dir = mkdtempSync(join(tmpdir(), 'import-job-tree-'))

  dirs.push(dir)
  const path = join(dir, 'upload.zip')

  writeFileSync(path, zip.toBuffer())
  const staging = {
    pathOf: () => path,
    readPlan: over.readPlan ?? (async () => null),
    publishPlan: over.publishPlan ?? (async (_ref: string, _lease: string, plan: unknown) => plan),
  } as unknown as ImportStagingStore

  return staging
}

/** Run the import handler over the two-note tree above, with a job row whose
 *  persisted PHASE is the thing under test. */
const runTree = async (
  opts: {
    phase?: string | null
    staging?: ImportStagingStore
    store?: ReturnType<typeof fakeStore>
  } = {},
) => {
  const staging = opts.staging ?? stagingForTree()
  const store = opts.store ?? fakeStore()
  const handler = createImportHandler({ resolveStore: async () => store as never, staging })
  const ctx = ctxOf(
    store,
    staging,
    { uploadRef: 'ref', filename: 'vault.zip', root: 'imported' },
    new AbortController().signal,
  )
  const outcome = await handler({
    ...ctx,
    job: { ...ctx.job, phase: opts.phase ?? null },
  }).catch((err: unknown) => err)

  return { store, outcome }
}

/** A meta-DB stub that records the ORDER of what the handler did, which is the only
 *  way to see that a write happened inside a fence rather than beside one. */
const recordingReservations = (opts: { refuse?: boolean; refuseWriteAt?: string } = {}) => {
  const calls: string[] = []
  const claimed: string[] = []
  const reservation = {
    id: 'res-1',
    space: 'S',
    jobId: 'j1',
    uploadRef: 'ref',
    fence: 'fence-1',
    status: 'active' as const,
    entries: [] as never[],
  }

  return {
    calls,
    claimed,
    metaDb: {
      importReservations: {
        adopt: async () => {
          calls.push('adopt')

          return { ok: false as const, reason: 'stale_fence' as const, detail: 'none' }
        },
        reserve: async (input: { entries: ReadonlyArray<{ destinationPath: string }> }) => {
          calls.push('reserve')
          claimed.push(...input.entries.map((planned) => planned.destinationPath))

          return opts.refuse
            ? { ok: false as const, reason: 'path_conflict' as const, detail: 'taken' }
            : { ok: true as const, reservation }
        },
        withFencedWrite: async <T>(
          input: { destinationPath: string },
          write: () => Promise<T>,
        ): Promise<T> => {
          calls.push(`fence:${input.destinationPath}`)
          if (opts.refuseWriteAt === input.destinationPath) {
            throw new ImportFenceError('job_not_current', `job j1 is no longer running`)
          }
          const result = await write()

          calls.push(`fenced-end:${input.destinationPath}`)

          return result
        },
      },
    },
  }
}

const jobRec = (params: unknown): JobRecord =>
  ({
    id: 'j1',
    space: 'S',
    kind: 'import',
    status: 'running',
    principal: 'user:a',
    params,
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
  }) as JobRecord

const ctxOf = (
  store: ReturnType<typeof fakeStore>,
  staging: ImportStagingStore,
  params: unknown,
  signal: AbortSignal,
  jobOverrides: Partial<JobRecord> = {},
): JobContext => ({
  job: { ...jobRec(params), ...jobOverrides },
  lease: 'lease-1',
  signal,
  artifacts: {} as never, // an import handler produces no artifact
  report: async () => {},
})

describe('createImportHandler + reservations (#302)', () => {
  it('claims the destinations once, then writes every note inside the fence', async () => {
    const staging = stagingForTree()
    const store = fakeStore()
    const recorder = recordingReservations()
    const handler = createImportHandler({
      resolveStore: async () => store as never,
      staging,
      metaDb: recorder.metaDb as never,
    })
    const out = await handler(
      ctxOf(
        store,
        staging,
        { uploadRef: 'ref', filename: 'vault.zip', root: 'imported' },
        new AbortController().signal,
      ),
    )

    expect((out.result as { imported: number }).imported).toBe(2)
    // Adopt FIRST — a retry must re-fence rather than inherit the previous run's —
    // then one reserve, a fence around plan publication, and one around each write.
    expect(recorder.calls.slice(0, 2)).toEqual(['adopt', 'reserve'])
    expect(recorder.calls.filter((call) => call.startsWith('fence:'))).toHaveLength(3)
    expect(store.writes).toHaveLength(2)
    // Every write is bracketed: no `fence:` is followed by another `fence:` before
    // its own end, which is what "inside" means here.
    const brackets = recorder.calls.filter((call) => call !== 'adopt' && call !== 'reserve')

    // The CLAIM carries the same joined addresses the fence then names — they are
    // looked up against each other, and a claim keyed one way with a fence keyed the
    // other would find no entry at all.
    expect(recorder.claimed).toEqual(['imported/vault/a.md', 'imported/vault/b.md'])
    // Joined with the ROOT, not the plan's root-relative address: the plan keeps the
    // root once, but a claim is about the real destination in the space, and two
    // imports into different roots share every relative path.
    expect(brackets).toEqual([
      // Publication uses the first claimed destination as its lease-guarded
      // critical section; no note is written by this first pair.
      'fence:imported/vault/a.md',
      'fenced-end:imported/vault/a.md',
      'fence:imported/vault/a.md',
      'fenced-end:imported/vault/a.md',
      'fence:imported/vault/b.md',
      'fenced-end:imported/vault/b.md',
    ])
  })

  it('fails terminally when the destinations are refused, without writing anything', async () => {
    const staging = stagingForTree()
    const store = fakeStore()
    const recorder = recordingReservations({ refuse: true })
    const handler = createImportHandler({
      resolveStore: async () => store as never,
      staging,
      metaDb: recorder.metaDb as never,
    })

    await expect(
      handler(
        ctxOf(
          store,
          staging,
          { uploadRef: 'ref', filename: 'vault.zip', root: 'imported' },
          new AbortController().signal,
        ),
      ),
    ).rejects.toBeInstanceOf(TerminalJobError)
    // Refused BEFORE the first write: a rival owning one path must not leave half a
    // tree behind. Deterministic, so it does not burn the retry budget either.
    expect(store.writes).toHaveLength(0)
  })

  // A fence that refuses says the PLAN is gone, not that one note failed. Recorded
  // as a note failure it produced a green import that wrote nothing at all, and a
  // cancel mid-archive spent the rest of the tree re-asking a database that had
  // already said no.
  it('stops the run when the fence refuses, instead of logging it per note', async () => {
    const staging = stagingForTree()
    const store = fakeStore()
    const recorder = recordingReservations({ refuseWriteAt: 'imported/vault/b.md' })
    const handler = createImportHandler({
      resolveStore: async () => store as never,
      staging,
      metaDb: recorder.metaDb as never,
    })
    const failure = await handler(
      ctxOf(
        store,
        staging,
        { uploadRef: 'ref', filename: 'vault.zip', root: 'imported' },
        new AbortController().signal,
      ),
    ).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(TerminalJobError)
    expect((failure as TerminalJobError).message).toMatch(/fence refused/)
    // The note that DID land is still reported: a terminal stop reports the work,
    // it does not erase it.
    expect((failure as { result?: { imported: number; failed: number } }).result).toMatchObject({
      imported: 1,
      failed: 0,
    })
    expect(store.writes).toHaveLength(1)
  })
})

// A durable retry is the reason the plan is written to disk at all: the second
// run must land on the SAME notes as the first, and must refuse to guess when it
// cannot prove that. `job.phase` is the only evidence it has about whether the
// first run had already opened the write gate.
describe('createImportHandler + the durable plan (#302)', () => {
  const publishedPlan = async () => {
    const published: unknown[] = []
    const first = await runTree({
      staging: stagingForTree({
        publishPlan: async (_ref, _lease, plan) => {
          published.push(plan)

          return plan
        },
      }),
    })

    return { plan: published[0], ids: first.store.writes.map((w) => w.id) }
  }

  it('replays a published plan under the identities the first run settled', async () => {
    const { plan, ids } = await publishedPlan()
    let publishes = 0
    const retry = await runTree({
      phase: 'writing',
      staging: stagingForTree({
        readPlan: async () => plan,
        publishPlan: async (_ref, _lease, next) => {
          publishes++

          return next
        },
      }),
    })

    // Same ids, so every `[[notarium-id:…]]` the first run wrote into a note that
    // DID land still points at the note the retry creates.
    expect(retry.store.writes.map((w) => w.id)).toEqual(ids)
    expect(ids.every(Boolean)).toBe(true)
    // Adopted, never re-derived: re-planning is how a retry quietly decides
    // something different from the run it is resuming.
    expect(publishes).toBe(0)
  })

  // The one case that is genuinely "a stranger appeared between the plan and the
  // write", reachable without racing a clock: the plan was published by an
  // earlier run, and by the time it is ADOPTED a note the plan never saw stands
  // at one of its destinations. Nothing else in the contour can catch this — the
  // adopted plan is deliberately not re-derived — so the guard the import carries
  // into `store.write` is the only thing between it and a stolen identity.
  it('refuses a destination a stranger took while the plan was already frozen', async () => {
    const { plan } = await publishedPlan()
    const store = fakeStore()

    store.owners.set('imported/vault/a.md', 'stranger-1')
    const { outcome } = await runTree({
      phase: 'writing',
      store,
      staging: stagingForTree({ readPlan: async () => plan }),
    })

    expect(outcome).toBeInstanceOf(TerminalJobError)
    expect((outcome as Error).message).toMatch(/owned by stranger-1/)
    // Terminal at the first refused member: the plan no longer describes the
    // space, so the rest of the tree is not written either.
    expect(store.writes).toHaveLength(0)
  })

  it('fails terminally when the plan is gone after writing began, without re-planning', async () => {
    const { outcome, store } = await runTree({ phase: 'writing' })

    expect(outcome).toBeInstanceOf(TerminalJobError)
    expect((outcome as Error).message).toMatch(/plan is missing or unreadable/)
    expect(store.writes).toHaveLength(0)
  })

  it('fails terminally on a plan written before identities were part of one', async () => {
    const { plan } = await publishedPlan()
    const settled = plan as { entries: Array<Record<string, unknown>> }
    const unsettled = {
      ...settled,
      entries: settled.entries.map((entry) => {
        const older = { ...entry }

        delete older.targetId
        delete older.expectedDestinationId
        delete older.ownership

        return older
      }),
    }
    const { outcome, store } = await runTree({
      phase: 'writing',
      staging: stagingForTree({ readPlan: async () => unsettled }),
    })

    // Same `version: 1`, no settled identity: executing it would mean minting ids
    // at the write path, which is exactly what adopting a plan exists to prevent.
    expect(outcome).toBeInstanceOf(TerminalJobError)
    expect(store.writes).toHaveLength(0)
  })

  // `IMPORT_PHASE.done` is persisted by the handler BEFORE the runner records the
  // job as succeeded. A crash in that window reopens the row at `phase='done'` —
  // a denylist of `writing` read that as "never wrote" and let a fully written
  // import plan itself again.
  it.each([['done'], ['a-phase-from-a-newer-build']])(
    'refuses to rebuild a missing plan at phase %s',
    async (phase) => {
      const { outcome, store } = await runTree({ phase })

      expect(outcome).toBeInstanceOf(TerminalJobError)
      expect(store.writes).toHaveLength(0)
    },
  )

  it.each([[null], ['planning']])('rebuilds a missing plan at phase %s', async (phase) => {
    const { outcome, store } = await runTree({ phase })

    expect((outcome as { result?: { imported: number } }).result).toMatchObject({ imported: 2 })
    expect(store.writes).toHaveLength(2)
  })

  // "Rebuilt while the write gate is closed" is only half a story while the
  // REBUILT plan cannot be published: the sidecar this build refuses still holds
  // the name, publication is no-clobber, and the read-back hands the refused plan
  // back again. Driven over the real staging store, because the dead end lives in
  // the publication itself — with a stub that returns whatever it is given, every
  // one of these paths is green and the job on disk still cannot run.
  it('republishes over a sidecar it refuses, instead of dying on it every attempt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-job-staging-'))

    dirs.push(dir)
    const zip = new AdmZip()
    const note = (title: string) => `---\ntitle: ${title}\n---\n\n# ${title}\n\nBody.\n`

    zip.addFile('vault/a.md', Buffer.from(note('A'), 'utf8'))
    zip.addFile('vault/b.md', Buffer.from(note('B'), 'utf8'))
    const staging = createFsImportStagingStore(dir)
    const ref = await staging.stage('S', 'j1', Readable.from([zip.toBuffer()]))
    // A version-1 sidecar whose entries carry no settled identity: exactly what an
    // older build published, whole and digest-clean, and unexecutable here.
    const older = {
      version: 1,
      uploadRef: ref,
      root: 'imported',
      entriesTotal: 2,
      expandedBytes: 0,
      ignored: { count: 0, files: [] },
      entries: [
        { archivePath: 'vault/a.md', destinationPath: 'vault/a.md', title: 'A' },
        { archivePath: 'vault/b.md', destinationPath: 'vault/b.md', title: 'B' },
      ],
    }

    expect(await staging.publishPlan(ref, 'lease-old', older)).toEqual(older)
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    const ctx = ctxOf(
      store,
      staging,
      { uploadRef: ref, filename: 'vault.zip', root: 'imported' },
      new AbortController().signal,
    )
    const out = await handler({ ...ctx, job: { ...ctx.job, phase: null } })

    expect((out.result as { imported: number }).imported).toBe(2)
    // The refused sidecar is GONE, replaced by the plan this run executed — so the
    // next claim of this job adopts the same identities rather than meeting the
    // same squatter.
    const republished = (await staging.readPlan(ref)) as {
      entries: Array<{ targetId?: string }>
    } | null

    expect(republished?.entries.map((entry) => entry.targetId)).toEqual(
      store.writes.map((write) => write.id),
    )
    expect(store.writes.map((write) => write.id).every(Boolean)).toBe(true)
  })
})

// A per-note write failure is not the PLAN's failure, and the difference is the
// job's outcome, not merely its wording: the partial-import model the brief keeps
// in force says the rest of the tree still imports and the job still succeeds,
// carrying a summary that names what did not.
describe('one note failing to write (#302)', () => {
  it('still succeeds, and says which note did not land', async () => {
    const staging = stagingForTree()
    const store = fakeStore()
    const failing = {
      ...store,
      write: async (input: Parameters<typeof store.write>[0]) => {
        if (input.fileName === 'b') {
          // No `reason`: not an occupied destination, not a changed owner — just a
          // write that did not work, which says nothing about the plan.
          throw new Error('disk went away')
        }

        return await store.write(input)
      },
    }
    const handler = createImportHandler({ resolveStore: async () => failing as never, staging })
    const out = await handler(
      ctxOf(
        store,
        staging,
        { uploadRef: 'ref', filename: 'vault.zip', root: 'imported' },
        new AbortController().signal,
      ),
    )

    expect(out.result).toMatchObject({
      imported: 1,
      failed: 1,
      errors: [{ title: 'B', error: 'disk went away' }],
    })
  })
})

// A destination claim outlives the run that took it until something OBSERVES the
// run ended. When the only observer was the maintenance tick, "something" meant
// "within a minute": starting the same import again right after cancelling it —
// the most ordinary thing a user does — was refused its own destinations, and
// refused TERMINALLY, because a claim conflict is deterministic by construction.
//
// Driven over the real SQLite reservation tables and the real runner, with the
// maintenance interval set to an hour: whatever frees the claim here, it is not
// the tick.
describe('an import that ended releases its destinations at once (#302)', () => {
  const IMPORT_KIND = 'import'
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
    const start = Date.now()

    for (;;) {
      if (await cond()) {
        return
      }
      if (Date.now() - start > ms) {
        throw new Error('waitFor timed out')
      }
      await sleep(5)
    }
  }

  const importContour = (
    store: ReturnType<typeof fakeStore>,
    /** Wrap the real handler — the seam a run that fails AFTER its claim needs.
     *  Nothing inside the import throws retryably once the destinations are taken:
     *  a per-note write failure is reported, and every plan-level refusal is
     *  terminal by construction. So the transient fault is injected where one
     *  really lands — around the handler, after it returned. */
    wrap: (handler: JobHandler) => JobHandler = (handler) => handler,
  ) => {
    const db = new SqliteMetaDb(':memory:')
    const staging = stagingForTree()
    const runner = createJobRunner({
      jobs: db.jobs,
      artifacts: {} as never, // an import produces no artifact
      handlers: {
        [IMPORT_KIND]: wrap(
          createImportHandler({
            resolveStore: async () => store as never,
            staging,
            metaDb: db,
          }),
        ),
      },
      pollIntervalMs: 5,
      staleAfterMs: 3_000,
      maintenanceIntervalMs: 60 * 60_000,
      onTerminalCleanup: () => closeTerminalImportReservations({ metaDb: db }),
    })
    const enqueue = (id: string, uploadRef: string, maxAttempts?: number) =>
      db.jobs.enqueue({
        id,
        space: 'S',
        kind: IMPORT_KIND,
        principal: 'user:a',
        params: { uploadRef, filename: 'vault.zip', root: 'imported' },
        maxAttempts,
        createdAt: new Date().toISOString(),
      })
    const statusOf = async (id: string) => (await db.jobs.get(id))?.status ?? null

    const settled = async (id: string) => {
      const status = await statusOf(id)

      return status === 'succeeded' || status === 'failed'
    }

    return { db, runner, enqueue, statusOf, settled }
  }

  it('lets the next import claim the paths a SUCCEEDED one held', async () => {
    const { db, runner, enqueue, statusOf } = importContour(fakeStore())

    try {
      runner.start()
      await enqueue('j1', 'ref-1')
      await waitFor(async () => (await statusOf('j1')) === 'succeeded')
      // No tick between the two: the second import is enqueued the instant the
      // first is recorded as done, which is exactly what a user does.
      await enqueue('j2', 'ref-2')
      runner.wake()
      await waitFor(async () => {
        const status = await statusOf('j2')

        return status === 'succeeded' || status === 'failed'
      })
      const second = await db.jobs.get('j2')

      expect(second?.error).toBeNull()
      expect(second?.status).toBe('succeeded')
    } finally {
      await runner.stop()
      await db.close()
    }
  })

  it('lets the next import claim the paths a CANCELED one held', async () => {
    const store = fakeStore()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let announce!: () => void
    const reached = new Promise<void>((resolve) => {
      announce = resolve
    })
    let inFirstWrite = true
    const blocking = {
      ...store,
      write: async (input: Parameters<typeof store.write>[0]) => {
        if (inFirstWrite) {
          inFirstWrite = false
          announce()
          await blocked
        }

        return await store.write(input)
      },
    }
    const { db, runner, enqueue, statusOf } = importContour(
      blocking as unknown as ReturnType<typeof fakeStore>,
    )

    try {
      runner.start()
      await enqueue('j1', 'ref-1')
      // Cancel while the claim is held and a write is in flight — the window the
      // whole reservation exists for. The cancel is QUEUED before the blocked write
      // is released, not awaited before it: both take the same per-job guard, so
      // awaiting first would wait on the write this test is holding open, and
      // releasing first would race the run to completion.
      await reached
      const canceling = db.jobs.cancel('j1', new Date().toISOString())

      release()
      await canceling
      await waitFor(async () => (await statusOf('j1')) === 'canceled')
      await enqueue('j2', 'ref-2')
      runner.wake()
      await waitFor(async () => {
        const status = await statusOf('j2')

        return status === 'succeeded' || status === 'failed'
      })
      const second = await db.jobs.get('j2')

      // The regression this pins is not "eventually": it is that the retry a user
      // makes immediately is refused, and refused without a retry of its own.
      expect(second?.error).toBeNull()
      expect(second?.status).toBe('succeeded')
    } finally {
      await runner.stop()
      await db.close()
    }
  })

  // The most ordinary terminal FAILURE of this contour, and the one nothing held:
  // a plan conflict. The run claims its destinations, meets a stranger on one of
  // them, and stops terminally — and the claim it took has to go with it. Deleting
  // the runner's cleanup call on the TerminalJobError branch left the whole suite
  // green while the user's next import was refused its own paths.
  it('lets the next import claim the paths a TERMINALLY FAILED one held', async () => {
    const store = fakeStore()

    // A note the plan never saw, standing where it planned to create one: the
    // second member, so the run has already written — and claimed — before it stops.
    store.owners.set('imported/vault/b.md', 'stranger-1')
    const { db, runner, enqueue, statusOf, settled } = importContour(store)

    try {
      runner.start()
      await enqueue('j1', 'ref-1')
      await waitFor(async () => (await statusOf('j1')) === 'failed')
      const first = await db.jobs.get('j1')

      expect(first?.error).toMatch(/owned by stranger-1/)
      // Terminal, not exhausted: one claim, no backoff, no burnt budget.
      expect(first?.attempts).toBe(1)
      // The stranger is gone by the time the user retries; the only thing that
      // could still refuse the retry is the claim the failed run left behind.
      store.owners.delete('imported/vault/b.md')
      await enqueue('j2', 'ref-2')
      runner.wake()
      await waitFor(() => settled('j2'))
      const second = await db.jobs.get('j2')

      expect(second?.error).toBeNull()
      expect(second?.status).toBe('succeeded')
    } finally {
      await runner.stop()
      await db.close()
    }
    // Two full job lifecycles over a real runner and a real meta-DB; the vitest
    // default (5 s) is not a budget a loaded host can be polled against.
  }, 15_000)

  // The last terminal transition of the runner, and the last one nothing held: a
  // retryable fault that runs out of attempts. `maxAttempts: 1` makes the very
  // first failure the exhausted one, so the row goes terminal without a backoff
  // this test would otherwise have to sit through.
  it('lets the next import claim the paths a run that EXHAUSTED its retries held', async () => {
    const store = fakeStore()
    const { db, runner, enqueue, statusOf, settled } = importContour(
      store,
      (handler) => async (ctx) => {
        const out = await handler(ctx)

        if (ctx.job.id !== 'j1') {
          return out
        }
        // The import itself is done and its claim is still held — the state a
        // transient fault in the last stretch of a run leaves behind.
        throw new Error('the meta-DB blinked')
      },
    )

    try {
      runner.start()
      await enqueue('j1', 'ref-1', 1)
      await waitFor(async () => (await statusOf('j1')) === 'failed')
      const first = await db.jobs.get('j1')

      expect(first?.error).toMatch(/the meta-DB blinked/)
      // Exhausted, not terminal-by-kind: the row is failed because there was no
      // attempt left, which is the OTHER branch that persists a terminal state.
      expect(first?.attempts).toBe(first?.maxAttempts)
      await enqueue('j2', 'ref-2')
      runner.wake()
      await waitFor(() => settled('j2'))
      const second = await db.jobs.get('j2')

      expect(second?.error).toBeNull()
      expect(second?.status).toBe('succeeded')
    } finally {
      await runner.stop()
      await db.close()
    }
  }, 15_000)
})

// Where the import contour's cleanup sits in a maintenance tick is a contract,
// not an implementation detail: a reservation may only be closed once its job is
// observably terminal, and the proof is the row that retention prune deletes.
// Nothing but the ORDER of statements enforced it, and nothing observed it.
describe('maintenance ordering around import cleanup (#302)', () => {
  it('reaps, then closes terminal reservations, then sweeps staging, then prunes', async () => {
    const calls: string[] = []
    let finished!: () => void
    const swept = new Promise<void>((resolve) => {
      finished = resolve
    })
    const jobs = {
      claimNext: async () => null,
      get: async () => null,
      reapStale: async () => {
        calls.push('reapStale')

        return []
      },
      findExpired: async () => {
        calls.push('findExpired')

        return []
      },
      clearArtifact: async () => {},
      prune: async () => {
        calls.push('prune')
        finished()
      },
    }
    const runner = createJobRunner({
      jobs: jobs as never,
      artifacts: {
        sweepTempParts: async () => {
          calls.push('sweepTempParts')
        },
      } as never,
      handlers: {},
      // The reservation close (#302) — it must read a terminal row that prune has
      // not deleted yet, and precede the sweep that reclaims what it read.
      onTerminalCleanup: async () => {
        calls.push('terminalCleanup')
      },
      // Where the staging/plan sidecar sweep is wired in production.
      onMaintenance: async () => {
        calls.push('stagingSweep')
      },
      maintenanceIntervalMs: 60_000,
    })

    runner.start()
    await swept
    await runner.stop()

    expect(calls).toEqual([
      'reapStale',
      'terminalCleanup',
      'findExpired',
      'sweepTempParts',
      'stagingSweep',
      'prune',
    ])
  })
})

describe('createImportHandler (#191)', () => {
  it('imports the staged upload, returns the summary in result, produces no artifact', async () => {
    const { staging, state } = stagingFor(CONVERSATIONS)
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    const out = await handler(
      ctxOf(
        store,
        staging,
        { uploadRef: 'ref', filename: 'conversations.json' },
        new AbortController().signal,
      ),
    )

    expect(out.artifactRef).toBeUndefined()
    const summary = out.result as {
      imported: number
      failed: number
      files: Array<{ format: string }>
    }
    expect(summary.imported).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.files[0].format).toBe('claude-conversations')
    expect(store.writes).toHaveLength(1)
    // The durable upload is left for the staging sweep — the handler never removes it.
    expect(state.removed).toBe(false)
  })

  it('replays a durable foreign upload through a fresh handler without duplicating its source', async () => {
    const { staging } = stagingFor(CONVERSATIONS)
    const store = fakeStore()
    const deps = { resolveStore: async () => store as never, staging }
    const params = { uploadRef: 'ref', filename: 'conversations.json' }

    const first = await createImportHandler(deps)(
      ctxOf(store, staging, params, new AbortController().signal),
    )
    const retried = await createImportHandler(deps)(
      ctxOf(store, staging, params, new AbortController().signal),
    )

    expect(first.result).toMatchObject({ imported: 1, failed: 0 })
    expect(retried.result).toMatchObject({ imported: 1, failed: 0 })
    expect(await store.list()).toEqual([
      expect.objectContaining({ id: 'n1', sourceLocator: expect.stringMatching(/^v1:claude:/u) }),
    ])
    expect(store.writes).toHaveLength(1)
  })

  it('maps a pre-aborted signal to a clean JobAbortedError (cooperative cancel)', async () => {
    const { staging } = stagingFor(CONVERSATIONS)
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    const controller = new AbortController()
    controller.abort()
    await expect(
      handler(
        ctxOf(
          store,
          staging,
          { uploadRef: 'ref', filename: 'conversations.json' },
          controller.signal,
        ),
      ),
    ).rejects.toBeInstanceOf(JobAbortedError)
    expect(store.writes).toHaveLength(0) // aborted before the first write
  })

  it('observes cancellation while processing a series of idless record failures', async () => {
    const idless = JSON.stringify(
      Array.from({ length: 50 }, (_, index) => ({
        name: `Missing id ${index}`,
        chat_messages: [{ sender: 'human', text: `body ${index}` }],
      })),
    )
    const { staging } = stagingFor(idless)
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    let abortChecks = 0
    const signal = {
      get aborted() {
        abortChecks++
        return abortChecks >= 4
      },
    } as AbortSignal

    await expect(
      handler(ctxOf(store, staging, { uploadRef: 'ref', filename: 'conversations.json' }, signal)),
    ).rejects.toBeInstanceOf(JobAbortedError)
    expect(abortChecks).toBeGreaterThanOrEqual(4)
    expect(store.writes).toHaveLength(0)
  })

  it.each([
    [
      'Claude projects array',
      'projects.json',
      'claude-projects',
      JSON.stringify([{ uuid: 'empty-project', docs: [] }]),
    ],
    [
      'single Claude project',
      'projects/empty.json',
      'claude-projects',
      JSON.stringify({ uuid: 'empty-project', docs: [] }),
    ],
    [
      'Claude memory',
      'memories.json',
      'claude-memory',
      JSON.stringify([{ account_uuid: 'empty-account' }]),
    ],
    [
      'MCP memory graph',
      'memory.json',
      'memory-json',
      JSON.stringify({ entities: [], relations: [] }),
    ],
  ] as const)(
    'observes cancellation on a zero-output %s record',
    async (_label, filename, format, raw) => {
      const { staging } = stagingFor(raw)
      const store = fakeStore()
      const handler = createImportHandler({ resolveStore: async () => store as never, staging })
      const signal = { aborted: true } as AbortSignal

      await expect(
        handler(ctxOf(store, staging, { uploadRef: 'ref', filename, format }, signal)),
      ).rejects.toBeInstanceOf(JobAbortedError)
      expect(store.writes).toHaveLength(0)
    },
  )

  it('observes cancellation while scanning zero-output MCP memory records', async () => {
    const { staging } = stagingFor(Array.from({ length: 20 }, () => '{}').join('\n'))
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    let abortChecks = 0
    const signal = {
      get aborted() {
        abortChecks++
        return abortChecks >= 4
      },
    } as AbortSignal

    await expect(
      handler(
        ctxOf(
          store,
          staging,
          { uploadRef: 'ref', filename: 'memory.jsonl', format: 'memory-json' },
          signal,
        ),
      ),
    ).rejects.toBeInstanceOf(JobAbortedError)
    expect(abortChecks).toBeGreaterThanOrEqual(4)
    expect(store.writes).toHaveLength(0)
  })

  it('keeps terminal progress at the processed high-water for skip-only records', async () => {
    const empty = JSON.stringify(
      Array.from({ length: 200 }, (_, index) => ({
        uuid: `empty-${index}`,
        chat_messages: [{ sender: 'human', text: '' }],
      })),
    )
    const { staging } = stagingFor(empty)
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    const reports: Array<{ done: number; total: number | null; phase: string | null }> = []
    const context = {
      ...ctxOf(
        store,
        staging,
        { uploadRef: 'ref', filename: 'conversations.json' },
        new AbortController().signal,
      ),
      report: async (progress: (typeof reports)[number]) => {
        reports.push({ ...progress })
      },
    }
    const out = await handler(context)

    expect(out.result).toMatchObject({ imported: 0, skipped: 0, failed: 0 })
    expect(reports.at(-1)).toEqual({ done: 200, total: 200, phase: 'done' })
    expect(
      reports.every((report, index) => index === 0 || report.done >= reports[index - 1].done),
    ).toBe(true)
  })

  it('never reports below the persisted high-water after a durable reclaim', async () => {
    const empty = JSON.stringify(
      Array.from({ length: 300 }, (_, index) => ({
        uuid: `empty-${index}`,
        chat_messages: [{ sender: 'human', text: '' }],
      })),
    )
    const { staging } = stagingFor(empty)
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    const reports: Array<{ done: number; total: number | null; phase: string | null }> = []
    let reportsAtCheckpoint = -1

    store.checkpoint = async () => {
      reportsAtCheckpoint = reports.length
    }
    const context = {
      ...ctxOf(
        store,
        staging,
        { uploadRef: 'ref', filename: 'conversations.json' },
        new AbortController().signal,
        { progressDone: 250 },
      ),
      report: async (progress: (typeof reports)[number]) => {
        reports.push({ ...progress })
      },
    }

    await handler(context)

    expect(reportsAtCheckpoint).toBe(1)
    expect(reports[0]).toEqual({ done: 250, total: null, phase: 'writing' })
    expect(reports.length).toBeGreaterThan(1)
    expect(reports.every((report) => report.done >= 250)).toBe(true)
    expect(reports.at(-1)).toEqual({ done: 300, total: 300, phase: 'done' })
  })

  it('fails loudly when the job carries no uploadRef', async () => {
    const { staging } = stagingFor(CONVERSATIONS)
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    await expect(
      handler(ctxOf(store, staging, { filename: 'x.json' }, new AbortController().signal)),
    ).rejects.toThrow(/uploadRef/)
  })

  it('maps a deterministic bad-upload (ImportError) to a TerminalJobError (no retry)', async () => {
    // An unrecognised single-object upload → streamImportFile throws ImportError.
    const { staging } = stagingFor('{"hello":"world"}')
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    const err = await handler(
      ctxOf(
        store,
        staging,
        { uploadRef: 'ref', filename: 'random.json' },
        new AbortController().signal,
      ),
    ).catch((e) => e)
    expect(err).toBeInstanceOf(TerminalJobError)
    expect((err as Error).message).toMatch(/recognised/i)
    expect(store.writes).toHaveLength(0)
  })

  it('rethrows a non-ImportError as-is — a transient fault stays RETRYABLE, not terminal', async () => {
    // A missing staged file → runImport hits ENOENT opening it, a non-ImportError.
    const dir = mkdtempSync(join(tmpdir(), 'notarium-importjob-test-'))
    dirs.push(dir)
    const staging: ImportStagingStore = {
      stage: async () => 'ref',
      pathOf: () => join(dir, 'does-not-exist.tmp'),
      remove: async () => {},
      removeSpace: async () => {},
      sweepOrphans: async () => {},
      publishPlan: async (_ref, _lease, plan) => plan,
      readPlan: async () => null,
    }
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    const err = await handler(
      ctxOf(store, staging, { uploadRef: 'ref', filename: 'x.json' }, new AbortController().signal),
    ).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(TerminalJobError) // NOT converted to terminal → runner retries
    expect(err).not.toBeInstanceOf(JobAbortedError)
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
  })
})
